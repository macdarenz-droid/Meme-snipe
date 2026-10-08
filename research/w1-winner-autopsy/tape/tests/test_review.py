"""AMENDMENT_2 and the blocking review: each test fails on the code before the fix and passes after."""
import contextlib
import io
import json
import os
import pickle
import tempfile
import unittest

import numpy as np
import pandas as pd

from fixtures import Unit, address
from w1 import costs, guard, load, persist, replay, rules, run
from w1.addr import MAYHEM_VAULT
from w1.ledger import Ledger

A10, A11 = "2026-09-10", "2026-09-11"
L1, H1, L2, H2 = 446_000_000, 446_004_499, 446_004_500, 446_008_999
Q = 30_000_000_000_000
M = address("mintR")
ST = (31_000_000_000, 1_038_000_000_000_000, 1_000_000_000, 758_100_000_000_000)


def one_day(units_spec):
    """Runs the ledger over (day, lo, hi, builder) and returns (vocab, [day dicts])."""
    with tempfile.TemporaryDirectory() as root:
        dirs = []
        for day, lo, hi, build in units_spec:
            u = Unit(root, day, lo, hi)
            build(u)
            dirs.append(u.write())
        v = load.Vocab()
        led = Ledger(v)
        out, cur = [], None
        for u in load.parse_units(dirs):
            if cur is not None and u.day != cur:
                out.append(led.finish_day())
            cur = u.day
            led.process_unit(u)
        out.append(led.finish_day())
        return v, out, led


def row(v, d, owner, mint=M):
    r = d["rows"]
    x = r[(r["owner"] == v.get(owner)) & (r["mint"] == v.get(mint))]
    assert len(x) == 1
    return x.iloc[0]


class SignerMethodQ2(unittest.TestCase):
    def test_signer_change_counts_app_fees_and_identified_rent(self):
        S = address("signerS")
        venue_in, fees, app, rent = 1_000_000_000, 12_500_000, 10_125_000, 1_513_840
        sell_out, app2 = 900_000_000, 9_000_000

        def b(u):
            d1 = -(venue_in + fees + 25_000 + 10_000 + app + rent)
            u.curve(L1 + 10, 1, 0, S, M, True, venue_in, Q, *ST, pre=0, post=Q, tx_fee=25_000, jito=10_000,
                    fee=9_500_000, creator_fee=3_000_000, spre=5 * 10**9, spost=5 * 10**9 + d1)
            # the sell closes the position; a refund hidden under the app fee is assumed at the largest rent
            d2 = sell_out - 5_000 - app2 + rent
            u.curve(L1 + 20, 2, 0, S, M, False, sell_out, Q, *ST, pre=Q, post=0, tx_fee=5_000, bps=(0, 0, 0),
                    spre=10**9, spost=10**9 + d2)
        v, (d,), led = one_day([(A10, L1, H1, b)])
        r = row(v, d, S)
        buy_cash = -(venue_in + fees + 35_000 + app)
        sell_cash = sell_out - 5_000 - app2 + rent - max(costs.RENT_CANDIDATES)
        self.assertAlmostEqual(r["cash"], buy_cash + sell_cash)
        self.assertAlmostEqual(r["cash_alt"], -(venue_in + fees + 35_000) + sell_out - 5_000)
        self.assertEqual(r["nsig"], 2)
        self.assertEqual(led.stats["signer_method"]["accepted"], 2)

    def test_router_and_implausible_changes_keep_the_venue_method(self):
        S, R = address("signerS2"), address("routerR2")

        def b(u):
            u.curve(L1 + 10, 1, 0, S, M, True, 10**9, Q, *ST, pre=0, post=Q, signer=R, spre=10**9, spost=0)
            # signer = owner but its SOL change does not show the trade (e.g. a persistent WSOL account)
            u.curve(L1 + 20, 2, 0, S, M, False, 10**9, Q, *ST, pre=Q, post=0, bps=(0, 0, 0), spre=10**9,
                    spost=10**9 - 5_000)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        r = row(v, d, S)
        self.assertEqual(r["nsig"], 0)
        self.assertAlmostEqual(r["cash"], r["cash_alt"])

    def test_function_rejects_negative_app_fee(self):
        cash, cr, rt, ok = costs.signer_cash([1_000_000], [0], [5_000], [0], [0], [0], [0])
        self.assertFalse(ok[0])


class AccountsQ22(unittest.TestCase):
    def test_owner_with_two_token_accounts_is_not_a_mismatch(self):
        P, a1, a2 = address("ownerP"), address("acct1", False), address("acct2", False)

        def b(u):
            u.curve(L1 + 10, 1, 0, P, M, True, 10**9, Q, *ST, pre=0, post=Q, acct=a1)
            u.curve(L1 + 20, 2, 0, P, M, True, 10**9, Q, *ST, pre=0, post=Q, acct=a2)   # only acct2 in the tx
            u.curve(L1 + 30, 3, 0, P, M, False, 10**9, Q, *ST, pre=Q, post=0, acct=a1)
            u.curve(L1 + 40, 4, 0, P, M, False, 10**9, Q, *ST, pre=Q, post=0, acct=a2)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        r = row(v, d, P)
        self.assertFalse(r["dirty"])
        self.assertEqual(r["end_bal"], 0)

    def test_real_mismatch_still_dirty(self):
        P, a1 = address("ownerP2"), address("acct3", False)

        def b(u):
            u.curve(L1 + 10, 1, 0, P, M, True, 10**9, Q, *ST, pre=0, post=Q, acct=a1)
            u.curve(L1 + 30, 3, 0, P, M, False, 10**9, Q, *ST, pre=2 * Q, post=Q, acct=a1)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        self.assertTrue(row(v, d, P)["dirty"])


class GateQ14(unittest.TestCase):
    def test_first_day_shortfall_from_unseen_starts_is_untestable(self):
        r = [{"day": A10, "first_day": True, "slow_traders_20plus": 150, "slow_traders_20plus_if_starts_seen": 260},
             {"day": A11, "first_day": False, "slow_traders_20plus": 230, "slow_traders_20plus_if_starts_seen": 240}]
        v = persist.gate_verdict(r, [A10, A11])
        self.assertEqual(v["verdict"], "untestable on the tape's first day")
        self.assertFalse(v["kill"])
        r[1]["slow_traders_20plus"] = 100
        self.assertEqual(persist.gate_verdict(r, [A10, A11])["verdict"], "kill")
        with self.assertRaises(ValueError):
            persist.gate_verdict(r[1:], [A10, A11])           # a missing 09-10 is never skipped

    def test_ledger_flags_starts_not_seen(self):
        H = address("holderH")

        def b(u):
            u.curve(L1 + 10, 1, 0, H, M, False, 10**8, 10**12, *ST, pre=10**12, post=0)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        r = row(v, d, H)
        self.assertTrue(r["dirty"] and r["dirty_start_only"])
        self.assertTrue(d["first_day"])


class RuleTestQ20(unittest.TestCase):
    def trades(self):
        rows = [{"arm": "rule", "day": "2026-09-02", "mint": 1, "ret": 0.5} for _ in range(50)]
        rows += [{"arm": "rule", "day": "2026-09-02", "mint": 10 + i, "ret": -0.1} for i in range(10)]
        rows += [{"arm": "control", "day": "2026-09-02", "mint": 99, "ret": 0.0}]
        return pd.DataFrame(rows)

    def test_pool_clustered_bound(self):
        v = rules.rule_test_verdict(self.trades(), ["2026-09-02"], b=2000)
        self.assertLess(v["lower99_5"], 0)                    # one pool carries the mean: not robust

    def test_each_day_required(self):
        v = rules.rule_test_verdict(self.trades(), ["2026-09-02", "2026-09-03"], b=200)
        self.assertFalse(v["pass"])
        self.assertEqual(v["days_without_trades"], ["2026-09-03"])


class Boost(unittest.TestCase):
    def test_pre_v3_boost_flagged_by_transaction(self):
        X, pool = address("boostX"), address("poolB", False)

        def b(u):
            u.amm(L1 + 50, 3, 0, X, M, pool, "buy", 10**12, 10**9, 2 * 10**14, 8 * 10**10, 0, pre=0, post=10**12)
            u.event("BoostBuyAndBurnEvent", L1 + 50, 3, {"mint": M, "pool": pool, "authority": address("auth", False),
                                                          "boost_vault_remaining": 5}, ev=1)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        self.assertFalse((d["rows"]["owner"] == v.get(X)).any())
        self.assertIn(v.get(X), d["excluded"]["protocol flow"])


class ReplayUnquotable(unittest.TestCase):
    def test_unquotable_counts_as_minus_100(self):
        with tempfile.TemporaryDirectory() as root:
            u = Unit(root, A10, L1, H1)
            u.amm(L1 + 1, 1, 0, address("q"), M, address("pq", False), "buy", 10**12, 10**9, 2 * 10**14, 0,
                  -10**9, pre=0, post=10**12, lp_adj=0)
            u.write()
            units = load.parse_units([u.dir])
            v = load.Vocab()
            led = Ledger(v)
            led.process_unit(units[0])
            t = pd.DataFrame({"mint": [v.get(M)], "entry_slot": [L1 + 1], "exit_slot": [L1 + 9],
                              "open_at_end": [False], "day_hi": [H1]})
            out = replay.replay_trades(t, units, v)
            self.assertEqual(out["ret_replay"].iat[0], -1.0)
            self.assertEqual(replay.unquotable_share(out), 1.0)
            self.assertEqual(replay.replay_mean(out), -1.0)


class Guards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.dirs = []
        for day, lo, hi in ((A10, L1, H1), (A11, L2, H2)):
            u = Unit(root, day, lo, hi)
            u.curve(lo + 10, 1, 0, address("g"), M, True, 10**9, Q, *ST, pre=0, post=Q)
            if day == A10:
                u.curve(lo + 20, 2, 0, MAYHEM_VAULT, M, True, 10**8, 10**12, *ST, pre=0, post=10**12)
            self.dirs.append(u.write())
        self.plan = os.path.join(root, "plan.txt")
        with open(self.plan, "w") as f:
            f.write(f"{A11} 1032 {L2} {H2}\n{A10} 1032 {L1} {H1}\n")
        self.saved = dict(guard.PLANS)
        sha = load.file_sha256(self.plan)
        guard.PLANS.clear()
        guard.PLANS.update({A10: (self.plan, sha), A11: (self.plan, sha)})
        self.work = os.path.join(root, "w")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            run.main(["ledger", "--work", self.work, "--units"] + self.dirs)
        self.m = run._manifest(self.work)

    def tearDown(self):
        guard.PLANS.clear()
        guard.PLANS.update(self.saved)
        self.tmp.cleanup()

    def verify(self, m=None, role="gate"):
        return guard.verify(self.work, role, m or self.m, run.code_hashes())

    def test_passes_when_everything_matches(self):
        self.verify()
        self.assertEqual(self.m["excluded_by_type"].get("mayhem vault"), 1)   # over all days, not the last

    def test_registered_plan_hash(self):
        self.assertEqual(self.saved[A10], (guard.STEP_A_PLAN, guard.STEP_A_SHA))
        with open(self.plan, "a") as f:
            f.write("# edited\n")
        with self.assertRaises(guard.Refused):
            self.verify()

    def test_units_must_equal_plan(self):
        with open(self.plan, "w") as f:
            f.write(f"{A11} 1032 {L2} {H2}\n{A10} 1032 {L1} {H1}\n{A11} 1032 {H2 + 1} {H2 + 4500}\n")
        guard.PLANS.update({d: (self.plan, load.file_sha256(self.plan)) for d in (A10, A11)})
        with self.assertRaises(guard.Refused):
            self.verify()

    def test_code_and_ledger_hashes(self):
        m = json.loads(json.dumps(self.m))
        m["code"]["ledger.py"] = "0" * 64
        with self.assertRaises(guard.Refused):
            self.verify(m)
        f = os.path.join(self.work, f"ledger-{A11}.pkl")
        with open(f, "ab") as fh:
            fh.write(b"x")
        with self.assertRaises(guard.Refused):
            self.verify()

    def test_missing_day_and_dev_gaps(self):
        os.remove(os.path.join(self.work, f"ledger-{A10}.pkl"))
        with self.assertRaises(guard.Refused):
            self.verify()
        m = dict(self.m, allow_gaps=True)
        with self.assertRaises(guard.Refused):
            self.verify(m)

    def test_extract_needs_hashed_validation(self):
        saved = guard.ROLES["extract"]
        guard.ROLES["extract"] = {"days": [A10, A11]}
        try:
            with self.assertRaises(guard.Refused) as e:
                guard.verify(self.work, "extract", self.m, run.code_hashes())
            self.assertIn("validation.pkl", str(e.exception))
            vp = os.path.join(self.work, "validation.pkl")
            with open(vp, "wb") as f:
                pickle.dump({"x": 1}, f)
            m = dict(self.m, validation_sha=load.file_sha256(vp))
            guard.verify(self.work, "extract", m, run.code_hashes())
            with open(vp, "ab") as f:
                f.write(b"tampered")
            with self.assertRaises(guard.Refused):
                guard.verify(self.work, "extract", m, run.code_hashes())
        finally:
            guard.ROLES["extract"] = saved

    def test_registered_choices(self):
        with self.assertRaises(guard.Refused):
            guard.check_args("discovery", rank="2026-09-07")
        with self.assertRaises(guard.Refused):
            guard.check_args("ruletest", days=[A10, A11])
        with self.assertRaises(guard.Refused):
            guard.check_args("validation", test=["2026-09-08"])
        guard.check_args("discovery")

    def test_scored_gate_runs_on_fixture(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            run.main(["gate", "--work", self.work, "--score"])
        self.assertIn("verdict", json.loads(out.getvalue()))

    def test_replay_units_come_from_the_ledger(self):
        us = guard.ledger_units(self.m, [A11])
        self.assertEqual([os.path.abspath(u.path) for u in us], [os.path.abspath(self.dirs[1])])
        with self.assertRaises(guard.Refused):
            guard.ledger_units(self.m, ["2026-09-09"])


class MissingDayAndGaps(unittest.TestCase):
    def test_find_units_never_skips_a_day(self):
        with tempfile.TemporaryDirectory() as root:
            Unit(root, A10, L1, H1).write()
            with self.assertRaises(ValueError):
                load.find_units(root, [A10, A11])

    def test_ledger_refuses_gaps(self):
        with self.assertRaises(RuntimeError):
            one_day([(A10, L1, H1, lambda u: None), (A10, H1 + 100, H1 + 4599, lambda u: None)])


class HolderExclusion(unittest.TestCase):
    def test_rule_days_pools_are_excluded(self):
        with tempfile.TemporaryDirectory() as root:
            u = Unit(root, "2026-09-02", L1, H1)
            pool = address("onCurvePool")
            u.amm(L1 + 1, 1, 0, address("h"), M, pool, "buy", 10**12, 10**9, 2 * 10**14, 8 * 10**10, 0, pre=0,
                  post=10**12)
            u.write()
            v = load.Vocab()
            led = run._event_ledger(load.parse_units([u.dir]), v)
            ex = run._excluder(led)
            self.assertTrue(ex(v.get(pool)))
            self.assertFalse(ex(v.get(address("h"))))


if __name__ == "__main__":
    unittest.main()
