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
        small, large = costs.rent_candidates(A10, L1 + 10)                # AMENDMENT_5 Q35: rents by date
        self.assertEqual((small, large), (1_855_569, 1_887_234))
        venue_in, fees, app, rent = 1_000_000_000, 12_500_000, 10_125_000, small
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
        sell_cash = sell_out - 5_000 - app2 + rent - large
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


class ReplayAmendment3(unittest.TestCase):
    def run_replay(self, pre_quote, virtual, lp_adj, entry, exit_, base=2 * 10**14):
        with tempfile.TemporaryDirectory() as root:
            u = Unit(root, A10, L1, H1)
            u.amm(L1 + 1, 1, 0, address("q"), M, address("pq", False), "buy", 10**12, 10**9, base, pre_quote,
                  virtual, pre=0, post=10**12, lp_adj=lp_adj)
            u.write()
            units = load.parse_units([u.dir])
            v = load.Vocab()
            Ledger(v).process_unit(units[0])
            t = pd.DataFrame({"mint": [v.get(M)], "day": [A10], "entry_slot": [entry], "exit_slot": [exit_],
                              "open_at_end": [False], "day_hi": [H1]})
            return replay.replay_trades(t, units, v)

    def test_refused_entry_is_no_trade(self):
        out = self.run_replay(0, -10**9, 0, L1 + 1, L1 + 9)
        self.assertTrue(np.isnan(out["ret_replay"].iat[0]))             # AMENDMENT_5 Q33: not -100%
        sh = replay.shares(out)
        self.assertEqual(sh["refused_entry_share"], 1.0)
        self.assertEqual(sh["flag"], replay.FLAG)                         # above 10%
        self.assertIsNone(replay.replay_mean(out))

    def test_exit_the_vault_cannot_pay_scores_what_it_pays(self):
        # effective quote is mostly virtual: the real vault (1 SOL) cannot pay the gross proceeds
        out = self.run_replay(0, 40 * 10**9, 10**8, L1 + 1, L1 + 9)
        self.assertEqual(out["replay_reason"].iat[0], replay.UNPAID)
        self.assertGreater(out["ret_replay"].iat[0], -1.0)
        self.assertLess(out["ret_replay"].iat[0], -0.5)
        self.assertEqual(replay.shares(out)["unpaid_exit_share"], 1.0)

    def test_slot_not_read_is_dropped(self):
        out = self.run_replay(80 * 10**9, 0, 10**9, L1 + 1, H1 - 5)      # exit + 23 is past the last slot read
        self.assertTrue(np.isnan(out["ret_replay"].iat[0]))
        self.assertEqual(replay.shares(out)["dropped_no_state_share"], 1.0)
        self.assertIsNone(replay.replay_mean(out))


class CostQ29(unittest.TestCase):
    def test_tx_cost_only_on_included_rows(self):
        T, PDA = address("traderT"), address("pdaT", False)

        def b(u):
            u.curve(L1 + 10, 1, 0, T, M, True, 10**9, Q, *ST, pre=0, post=Q, tx_fee=40_000, jito=20_000)
            u.curve(L1 + 10, 1, 1, PDA, M, True, 10**9, Q, *ST, pre=0, post=Q, tx_fee=40_000, jito=20_000)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        self.assertAlmostEqual(row(v, d, T)["cash"], -(10**9 + 60_000))


class WinnersQ17(unittest.TestCase):
    def test_winner_definition(self):
        tp = pd.DataFrame([
            # trader 1 qualifies only on 09-08, where deciles 5-6 average 0.01: winner (0.05 > 0.01 and > 0)
            *[{"trader": 1, "decile": 10, "day": "2026-09-08", "ret": 0.05}] * 5,
            # trader 2 beats deciles 5-6 but loses money: not a winner
            *[{"trader": 2, "decile": 10, "day": "2026-09-09", "ret": -0.01}] * 5,
            *[{"trader": 3, "decile": 5, "day": "2026-09-08", "ret": 0.01}] * 5,
            *[{"trader": 4, "decile": 6, "day": "2026-09-09", "ret": -0.20}] * 5,
            *[{"trader": 5, "decile": 5, "day": "2026-09-09", "ret": 0.20}] * 1])
        # pooled over both days deciles 5-6 average -0.075: trader 1 would win either way; trader 2 only by the
        # missing > 0 condition; over 09-09 alone deciles 5-6 average -0.133
        self.assertEqual(persist.winners(tp), {1})


class FlipperA4(unittest.TestCase):
    def test_trips_flipper_class_and_flows(self):
        F, G, O = address("flipF"), address("flipG"), address("otherO")

        def b(u):
            for i in range(5):
                s0 = L1 + 100 + i * 400
                u.curve(s0, 1, 0, F, M, True, 10**8, 10**12, *ST, pre=0, post=10**12, bps=(0, 0, 0))
                u.curve(s0 + 150, 1, 0, F, M, False, 10**8, 10**12, *ST, pre=10**12, post=0, bps=(0, 0, 0))
                u.curve(s0 + 5, 2, 0, G, M, True, 10**8, 10**12, *ST, pre=0, post=10**12, bps=(0, 0, 0))
                u.transfer(s0 + 6, 3, M, G, O, 1)                           # breaks G's trip
                u.curve(s0 + 150, 4, 0, G, M, False, 10**8, 10**12 - 1, *ST, pre=10**12 - 1, post=0, bps=(0, 0, 0))
            s0 = L1 + 100
            u.curve(s0 + 10, 9, 0, O, M, True, 10**9, 10**12, *ST, pre=1, post=10**12 + 1, bps=(0, 0, 0))
            u.curve(s0 + 50, 9, 0, O, M, True, 10**9, 10**12, *ST, pre=10**12 + 1, post=2 * 10**12 + 1,
                    bps=(0, 0, 0))
            u.curve(s0 + 200, 9, 0, O, M, False, 5 * 10**8, 10**12, *ST, pre=2 * 10**12 + 1, post=10**12 + 1,
                    bps=(0, 0, 0))
        with tempfile.TemporaryDirectory() as root:
            uu = Unit(root, A10, L1, H1)
            b(uu)
            units = load.parse_units([uu.write()])
            v = load.Vocab()
            led = Ledger(v)
            led.process_unit(units[0])
            d = led.finish_day()
            from w1 import clusters, flippers
            tr, _ = clusters.build([d], A10)
            trips = d["trips"]
            self.assertEqual(int((trips["owner"] == v.get(F)).sum()), 5)
            self.assertTrue(trips.loc[trips["owner"] == v.get(G), "broken"].all())
            fc = flippers.flipper_class(trips, tr)
            self.assertTrue(fc.loc[tr[v.get(F)], "flipper"])
            self.assertNotIn(tr[v.get(G)], fc.index)
            flip = {int(tr[v.get(F)])}
            f = flippers.flows(trips, flip, tr, units, v)
            # O's +2 SOL inside F's first trip (G's buys of 0.1 SOL each are inside too: 0.1 SOL), 1 of them after
            # 23 slots; after each exit, within the trip's length: G's 0.1 SOL sell (5 trips) and O's 0.5 SOL sell
            self.assertAlmostEqual(f["others_net_buy_sol_inside"], 2.5, places=6)
            self.assertAlmostEqual(f["share_after_23_slots"], 1.0 / 2.5, places=6)
            self.assertAlmostEqual(f["others_net_sell_sol_after_exit"], 0.5 + 5 * 0.1, places=6)
            c = flippers.census(d, tr, flip)
            self.assertAlmostEqual(c["flipper"], 0.5 + 5 * 5_000 / 1e9)   # buys with their tx_fee


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
        guard.STEP_B_RELEASED = True
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
            guard.STEP_B_RELEASED = False

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


class Amendment5(unittest.TestCase):
    def test_rents_follow_the_date(self):
        self.assertEqual(costs.rent_candidates("2026-09-02", 443_000_000), (2_039_280, 2_074_080))   # epoch 1025 (R2-13)
        self.assertEqual(costs.rent_candidates("2026-09-03", 445_000_000), (1_855_569, 1_887_234))
        self.assertEqual(costs.rent_candidates("2026-09-11", 1033 * 432_000), (1_488_440, 1_513_840))

    def test_step_b_plan_from_registered_sha_file_and_release_gate(self):
        with tempfile.TemporaryDirectory() as d:
            plan, shaf = os.path.join(d, "stepb-plan.txt"), os.path.join(d, "stepb-plan.sha256")
            with open(plan, "w") as f:
                f.write("2026-09-07 1029 444000000 444004499\n")
            saved = dict(guard.PLANS)
            try:
                guard.PLANS["2026-09-07"] = (plan, shaf)
                with self.assertRaises(guard.Refused):            # no sha256 file yet
                    guard.plan_units("2026-09-07")
                with open(shaf, "w") as f:
                    f.write(load.file_sha256(plan) + "  stepb-plan.txt\n")
                self.assertEqual(guard.plan_units("2026-09-07"), ["2026-09-07/444000000-444004499"])
                with open(plan, "a") as f:
                    f.write("2026-09-07 1029 444004500 444008999\n")
                with self.assertRaises(guard.Refused):            # plan changed after its hash was committed
                    guard.plan_units("2026-09-07")
            finally:
                guard.PLANS.clear()
                guard.PLANS.update(saved)
        self.assertFalse(guard.STEP_B_RELEASED)
        for role in ("validation", "extract", "ruletest"):
            with self.assertRaises(guard.Refused) as e:
                guard.verify("/nonexistent", role, {}, {})
            self.assertIn("discovery only", str(e.exception))

    def test_cap_is_reported_not_hidden(self):
        S = address("signerCap")

        def b(u):
            u.curve(L1 + 20, 2, 0, S, M, True, 10**9, Q, *ST, pre=0, post=Q, bps=(0, 0, 0), spre=10**10,
                    spost=10**10 - 10**9 - 5_000 - 200_000_000)         # a 20% "app fee": above the cap
        v, (d,), led = one_day([(A10, L1, H1, b)])
        r = row(v, d, S)
        self.assertEqual(r["ncap"], 1)
        self.assertAlmostEqual(r["cash"], -(10**9 + 5_000))
        # without the cap: the SOL change, with the opening's identifiable rent added back
        self.assertAlmostEqual(r["cash_nc"], -(10**9 + 5_000 + 200_000_000) + costs.rent_candidates(A10, L1 + 20)[0])
        self.assertEqual(led.stats["signer_method"]["capped"], 1)

    def test_ruletest_verifies_the_extract_work(self):
        calls = []

        def fake_verify(work, role, m, code):
            calls.append((work, role))
            if role == "extract":
                raise guard.Refused("refused: extract work")
        saved_v, saved_s, saved_m = guard.verify, run._scored, run._manifest
        guard.verify = fake_verify
        run._scored = lambda a, role: ({}, guard.ROLES[role], [])
        run._manifest = lambda w: {}
        try:
            with self.assertRaises(guard.Refused):
                run.main(["ruletest", "--work", "/c", "--rule-work", "/ab", "--score"])
        finally:
            guard.verify, run._scored, run._manifest = saved_v, saved_s, saved_m
        self.assertIn(("/ab", "extract"), calls)


class Amendment6(unittest.TestCase):
    def test_top_mean_must_hold_with_and_without_the_cap(self):
        g = {"top": (np.array([1.0, 1.0]), np.array([10.0, 10.0])), "mid": (np.array([0.0]), np.array([10.0]))}
        boot = np.full(1000, 0.1)
        v = persist.validation_verdict(g, boot, 0.02, top_mean_uncapped=-0.01)
        self.assertFalse(v["pass"])
        self.assertEqual(v["verdict"], "persistence depends on cost attribution")
        v = persist.validation_verdict(g, boot, 0.02, top_mean_uncapped=0.03)
        self.assertTrue(v["pass"])
        g_neg = {"top": (np.array([-1.0]), np.array([10.0])), "mid": g["mid"]}
        v = persist.validation_verdict(g_neg, boot, 0.02, top_mean_uncapped=0.03)
        self.assertEqual(v["verdict"], "persistence depends on cost attribution")


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


class SeatTagA7(unittest.TestCase):
    """AMENDMENT_7: per trader, the median (jito_tip + tx_fee) per trade and the median within-slot rank of its buys;
    a tag only, never a change to the class or the ranking."""

    def test_seat_cost_and_slot_rank(self):
        from w1 import classes, clusters
        A_, B_ = address("seatA"), address("seatB")

        def b(u):
            # same mint, same slot: B's buy comes first (rank 1), A's second (rank 2)
            u.curve(L1 + 10, 3, 0, B_, M, True, 10**8, 10**12, *ST, pre=0, post=10**12, tx_fee=5_000, jito=0)
            u.curve(L1 + 10, 7, 0, A_, M, True, 10**8, 10**12, *ST, pre=0, post=10**12, tx_fee=105_000, jito=1_000_000)
            # A's sell is a trade too: its fee + tip counts in the per-trade median
            u.curve(L1 + 20, 1, 0, A_, M, False, 10**8, 10**12, *ST, pre=10**12, post=0, tx_fee=25_000, jito=0)
            u.curve(L1 + 30, 1, 0, A_, M, True, 10**8, 10**12, *ST, pre=0, post=10**12, tx_fee=45_000, jito=0)
        v, (d,), _ = one_day([(A10, L1, H1, b)])
        tr, _ = clusters.build([d], A10)
        before = classes.classify(d, tr)
        tag = classes.seat_tag(d, tr)
        a, b_ = tag.loc[tr[v.get(A_)]], tag.loc[tr[v.get(B_)]]
        self.assertAlmostEqual(a["median_seat_cost_sol"], 0.000045)          # median of 1,105,000 / 25,000 / 45,000
        self.assertEqual(a["trades"], 3)
        self.assertEqual(a["median_buy_slot_rank"], 1.5)                    # ranks 2 and 1
        self.assertEqual(b_["median_buy_slot_rank"], 1.0)
        self.assertAlmostEqual(b_["median_seat_cost_sol"], 0.000005)
        # a tag only: the class table is unchanged and carries no tag column
        pd.testing.assert_frame_equal(before, classes.classify(d, tr))
        self.assertNotIn("median_seat_cost_sol", before.columns)

    def test_rule_carries_the_seat_reference(self):
        X = np.random.default_rng(0).uniform(0, 1, (40, len(rules.FEATURES)))
        r = rules.extract(X[:20], np.full(20, 10.0), X[20:])
        self.assertIn("COUNT_ROWS_AMENDMENT_5.md", r["seat"]["reference"])
