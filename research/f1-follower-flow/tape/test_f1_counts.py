"""Unit tests for f1_counts.py on small synthetic tables.  Run: python3 -m unittest -v (from this folder)."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import f1_counts as F  # noqa: E402

SOLN = F.SOL_NATIVE


def curve_row(slot, owner, mint, buy=True, sol=1_000_000, tx=0, ev=0, sig=None, quote=SOLN, protocol="0"):
    return {"slot": slot, "tx_idx": tx, "ev_idx": ev, "signature": sig or f"s{slot}-{tx}-{ev}-{owner}",
            "user_token_owner": owner, "mint": mint, "is_buy": 1 if buy else 0, "sol_amount": sol,
            "quote_mint": quote, "protocol": protocol}


def write_unit(root, day, lo, hi, curve, amm=None, t=None, w=None, boost_sigs=()):
    p = os.path.join(root, day, f"{lo}-{hi}", "research")
    os.makedirs(p, exist_ok=True)
    pd.DataFrame(curve, columns=["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "mint", "is_buy",
                                 "sol_amount", "quote_mint", "protocol"]).to_csv(
        os.path.join(p, "S_curve.csv.zst"), index=False, compression="zstd")
    pd.DataFrame(amm or [], columns=["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "base_mint", "side",
                                     "quote_amount", "quote_mint", "protocol"]).to_csv(
        os.path.join(p, "S_amm.csv.zst"), index=False, compression="zstd")
    pd.DataFrame(t or [], columns=["mint", "kind", "from_owner", "to_owner"]).to_csv(
        os.path.join(p, "T.csv.zst"), index=False, compression="zstd")
    pd.DataFrame(w or [], columns=["from", "to"]).to_csv(os.path.join(p, "W.csv.zst"), index=False, compression="zstd")
    lines = "".join(json.dumps({"event": "BoostBuyAndBurnEvent", "signature": s, "fields": {}}) + "\n" for s in boost_sigs)
    with open(os.path.join(p, "E.jsonl.zst"), "wb") as fh:
        fh.write(zstandard.ZstdCompressor().compress(lines.encode()))
    return os.path.dirname(p)


class Definitions(unittest.TestCase):
    def test_leader_candidate_needs_10_distinct_mints_on_day1(self):
        rows = [curve_row(100 + i, "L", f"m{i}") for i in range(10)]
        rows += [curve_row(200 + i, "N", f"m{i}") for i in range(9)]
        rows += [curve_row(300 + i, "R", "m0", tx=i) for i in range(12)]          # 12 buys, one mint
        rows += [curve_row(400 + i, "S", f"m{i}", buy=False) for i in range(12)]  # sells do not count
        s = F.normalise_swaps(pd.DataFrame(rows), pd.DataFrame(columns=["slot", "tx_idx", "ev_idx", "signature",
                              "user_token_owner", "base_mint", "side", "quote_amount", "quote_mint", "protocol"]),
                              set(), F.DAY1)
        self.assertEqual(F.leader_candidates(s), {"L"})

    def test_boost_protocol_nonsol_and_ownerless_rows_dropped(self):
        rows = [curve_row(1, "A", "m", sig="boost"), curve_row(2, "B", "m", protocol="boost_buy_and_burn"),
                curve_row(3, "C", "m", quote="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
                curve_row(4, None, "m"), curve_row(5, "E", "m")]
        s = F.normalise_swaps(pd.DataFrame(rows), pd.DataFrame(columns=["slot", "tx_idx", "ev_idx", "signature",
                              "user_token_owner", "base_mint", "side", "quote_amount", "quote_mint", "protocol"]),
                              {"boost"}, F.DAY1)
        self.assertEqual(list(s["owner"]), ["E"])

    def test_coverage(self):
        r = [("d", 0, 99), ("d", 100, 199), ("d", 300, 399)]
        self.assertTrue(F.covered(r, "d", 10, 190))
        self.assertFalse(F.covered(r, "d", 150, 310))
        self.assertFalse(F.covered(r, "x", 10, 20))


def by_mint(rows):
    df = pd.DataFrame(rows).rename(columns={"user_token_owner": "owner", "sol_amount": "sol"})
    df = df.sort_values(["slot", "tx_idx", "ev_idx"])
    return {m: {c: g[c].to_numpy() for c in ("slot", "tx_idx", "ev_idx", "owner", "sol")} for m, g in df.groupby("mint")}


class Followers(unittest.TestCase):
    def setUp(self):
        self.rows = [
            curve_row(1000, "B0", "m", tx=1),                  # same slot, earlier tx: not after
            curve_row(1000, "L", "m", tx=5),                   # the leader buy
            curve_row(1000, "F1", "m", tx=9, sol=10),          # same slot, later tx: follower, not late
            curve_row(1023, "F2", "m", sol=20),                # 23 slots: not late
            curve_row(1024, "F3", "m", sol=40),                # 24 slots: late
            curve_row(1300, "F3", "m", sol=80),                # second buy by F3: one owner, volume adds
            curve_row(1600, "F4", "m", sol=160),               # 600 slots: in window
            curve_row(1601, "F5", "m", sol=320),               # 601: out
            curve_row(1100, "L", "m", sol=640),                # the leader itself
            curve_row(1200, "LW", "m", sol=1280),              # linked by SOL (W)
            curve_row(1201, "LT", "m", sol=2560),              # linked by a transfer of this mint (T)
            curve_row(1202, "OT", "m", sol=5120),              # transfer of another mint only: not linked
        ]
        sol_pairs, mint_pairs = F.build_links(
            pd.DataFrame({"mint": ["m", "other"], "from_owner": ["LT", "L"], "to_owner": ["L", "OT"]}),
            pd.DataFrame({"from_owner": ["L"], "to_owner": ["LW"]}))
        self.links = (sol_pairs, mint_pairs)

    def test_follow_count_window_links_and_timing(self):
        ev = {"mint": "m", "owner": "L", "slot": 1000, "tx_idx": 5, "ev_idx": 0}
        n, vol, late = F.follow_stats(by_mint(self.rows), ev, *self.links)
        self.assertEqual(n, 5)  # F1, F2, F3, F4, OT
        self.assertEqual(vol, 10 + 20 + 40 + 80 + 160 + 5120)
        self.assertEqual(late, 40 + 80 + 160 + 5120)

    def test_wsol_token_transfer_links(self):
        sol_pairs, _ = F.build_links(pd.DataFrame({"mint": [F.WSOL], "from_owner": ["a"], "to_owner": ["b"]}),
                                     pd.DataFrame(columns=["from_owner", "to_owner"]))
        self.assertIn(("a", "b"), sol_pairs)


class Placebo(unittest.TestCase):
    def _swaps(self, rows, day=F.DAY1):
        amm = pd.DataFrame(columns=["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "base_mint", "side",
                                    "quote_amount", "quote_mint", "protocol"])
        return F.normalise_swaps(pd.DataFrame(rows), amm, set(), day)

    def test_placebo_is_noncandidate_in_reach_and_seeded(self):
        rows = [curve_row(5000, "L", "m"), curve_row(5000 + 1801, "P_far", "m"), curve_row(5000 - 1800, "P1", "m"),
                curve_row(5100, "P2", "m"), curve_row(5200, "C2", "m")]
        s = self._swaps(rows)
        ranges = [(F.DAY1, 0, 20000)]
        e1 = F.event_table(s, {"L", "C2"}, F.DAY1, ranges, set(), {}, seed=1)
        e2 = F.event_table(s, {"L", "C2"}, F.DAY1, ranges, set(), {}, seed=1)
        pd.testing.assert_frame_equal(e1, e2)
        picks = set(e1.loc[e1["leader"] == "L", "placebo_owner"])
        self.assertTrue(picks <= {"P1", "P2"})
        many = {F.event_table(s, {"L", "C2"}, F.DAY1, ranges, set(), {}, seed=k).iloc[0]["placebo_owner"] for k in range(30)}
        self.assertEqual(many, {"P1", "P2"})

    def test_no_placebo_or_no_tape_drops(self):
        s = self._swaps([curve_row(5000, "L", "m"), curve_row(5100, "C2", "m")])
        e = F.event_table(s, {"L", "C2"}, F.DAY1, [(F.DAY1, 0, 20000)], set(), {})
        self.assertEqual(set(e["dropped"]), {"no_placebo_in_reach"})
        e = F.event_table(s, {"L"}, F.DAY1, [(F.DAY1, 4000, 20000)], set(), {})
        self.assertEqual(set(e["dropped"]), {"window_not_on_tape"})

    def test_day2_placebo_excludes_all_day1_candidates(self):
        s = self._swaps([curve_row(5000, "L", "m"), curve_row(5100, "C2", "m"), curve_row(5200, "P", "m")], F.DAY2)
        e = F.event_table(s, {"L"}, F.DAY2, [(F.DAY2, 0, 20000)], set(), {}, candidates={"L", "C2"})
        self.assertEqual(e.iloc[0]["placebo_owner"], "P")


class LeaderTest(unittest.TestCase):
    def test_followed_needs_positive_lower_bound(self):
        ev = pd.DataFrame({"leader": ["A"] * 8 + ["B"] * 8 + ["C"] * 8, "dropped": [""] * 24,
                           "follow": [3, 4, 3, 5, 3, 4, 3, 4] + [1] * 8 + [9, 0, 0, 0, 0, 0, 0, 0],
                           "placebo_follow": [1] * 8 + [1] * 8 + [0] * 8})
        t = F.leader_test(ev, n_boot=2000).set_index("leader")
        self.assertTrue(t.at["A", "followed"])
        self.assertFalse(t.at["B", "followed"])    # no difference
        self.assertFalse(t.at["C", "followed"])    # one lucky buy: 0.5% bound is 0
        self.assertAlmostEqual(t.at["C", "diff"], 9 / 8)

    def test_fewer_than_8_valid_pairs_is_untestable(self):
        ev = pd.DataFrame({"leader": ["A"], "dropped": [""], "follow": [5], "placebo_follow": [0]})
        r = F.leader_test(ev, n_boot=500).iloc[0]
        self.assertFalse(r["followed"])
        self.assertFalse(r["testable"])
        f = [3, 4, 3, 5, 3, 4, 3, 4]
        ev = pd.DataFrame({"leader": ["A"] * 9, "dropped": [""] * 8 + ["no_placebo_in_reach"],
                           "follow": f + [9], "placebo_follow": [1] * 8 + [0]})
        self.assertTrue(F.leader_test(ev, n_boot=500).iloc[0]["followed"])            # 8 valid pairs
        ev7 = ev.iloc[1:]                                                              # 7 valid pairs
        r = F.leader_test(ev7, n_boot=500).iloc[0]
        self.assertFalse(r["testable"])
        self.assertFalse(r["followed"])

    def test_constant_positive_diff_with_8_pairs_follows_per_amendment(self):
        ev = pd.DataFrame({"leader": ["Z"] * 8, "dropped": [""] * 8, "follow": [3] * 8, "placebo_follow": [1] * 8})
        r = F.leader_test(ev, n_boot=500).iloc[0]
        self.assertTrue(r["zero_variance"])
        self.assertTrue(r["followed"])

    def test_untestable_on_day2_does_not_persist(self):
        with tempfile.TemporaryDirectory() as root:
            def rows(base, n):
                out = []
                for i in range(max(n, 10)):
                    s0 = base + 3000 + i * 100
                    if i < n:
                        out.append(curve_row(s0, "L", f"m{i}"))
                    else:
                        out.append(curve_row(s0, "other", f"m{i}"))
                    out.append(curve_row(s0 + 700, f"pl{i}", f"m{i}"))
                    for k in range(3 + i % 2):
                        out.append(curve_row(s0 + 30 + k, f"f{i}_{k}", f"m{i}", sol=1000))
                return out
            u1 = write_unit(root, F.DAY1, 1000, 9999, rows(1000, 10))
            u2 = write_unit(root, F.DAY2, 20000, 29999, rows(20000, 7))
            summ, _ = F.run([u1, u2], n_boot=300)
            self.assertEqual(summ["followed_day1"], 1)
            self.assertEqual(summ["untestable_day2"], 1)
            self.assertEqual(summ["persistent_day2"], 0)
            self.assertEqual(summ["persistent_share"], 0.0)

    def test_protocol_1_rows_dropped(self):
        rows = [curve_row(1, "A", "m", protocol="1"), curve_row(2, "B", "m")]
        s = F.normalise_swaps(pd.DataFrame(rows), pd.DataFrame(columns=["slot", "tx_idx", "ev_idx", "signature",
                              "user_token_owner", "base_mint", "side", "quote_amount", "quote_mint", "protocol"]),
                              set(), F.DAY1)
        self.assertEqual(list(s["owner"]), ["B"])

    def test_decide(self):
        base = {"followed_day1": 20, "persistent_share": 0.5, "late_share": 0.5, "day2_persistent_leader_buys": 15}
        self.assertFalse(F.decide(base)["f1_closes"])
        for k, v in (("followed_day1", 19), ("persistent_share", 0.49), ("late_share", 0.49),
                     ("day2_persistent_leader_buys", 14)):
            self.assertTrue(F.decide({**base, k: v})["f1_closes"], k)


class EndToEnd(unittest.TestCase):
    def test_run_on_synthetic_units(self):
        with tempfile.TemporaryDirectory() as root:
            def day_rows(base, leader_follows):
                rows = []
                for i in range(10):
                    s0 = base + 3000 + i * 100
                    rows.append(curve_row(s0, "L", f"m{i}"))
                    rows.append(curve_row(s0 + 700, f"pl{i}", f"m{i}"))       # placebo buy, no followers after it
                    for k in range(leader_follows + i % 2):
                        rows.append(curve_row(s0 + 30 + k, f"f{i}_{k}", f"m{i}", sol=1000))
                return rows
            u1 = write_unit(root, F.DAY1, 1000, 9999, day_rows(1000, 3))
            u2 = write_unit(root, F.DAY2, 20000, 29999, day_rows(20000, 3))
            summ, tabs = F.run([u1, u2], n_boot=500)
            self.assertEqual(summ["leader_candidates_day1"], 1)
            self.assertEqual(summ["followed_day1"], 1)
            self.assertEqual(summ["persistent_day2"], 1)
            self.assertEqual(summ["day2_persistent_leader_buys"], 10)
            self.assertEqual(summ["late_share"], 1.0)
            self.assertFalse(tabs["events_day1"]["placebo_owner"].eq("L").any())
            e = tabs["events_day1"]; self.assertTrue((e["placebo_follow"] < e["follow"]).all())
            self.assertTrue(tabs["events_day1"]["follow"].isin([3, 4]).all())


class Plan(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.plan = os.path.join(self.d, "plan.txt")
        with open(self.plan, "w") as fh:
            fh.write("2026-09-11 1 1000 1999\n2026-09-11 1 2000 2999\n2026-09-11 1 3000 3999\n"
                     "2026-09-10 1 9000 9999\n")
        self.full = [(F.DAY1, 1000, 1999), (F.DAY1, 2000, 2999), (F.DAY1, 3000, 3999), (F.DAY2, 9000, 9999)]

    def test_exact_plan_passes_with_sha(self):
        import hashlib
        self.assertEqual(F.check_plan(self.full, self.plan), hashlib.sha256(open(self.plan, "rb").read()).hexdigest())

    def test_missing_middle_and_subset_refused(self):
        with self.assertRaises(F.PlanError):
            F.check_plan([r for r in self.full if r[1] != 2000], self.plan)
        with self.assertRaises(F.PlanError):
            F.check_plan(self.full[:3], self.plan)            # a correct subset is not enough
        with self.assertRaises(F.PlanError):
            F.check_plan(self.full[2:], self.plan)

    def test_cli_decide_needs_full_plan(self):
        u = [write_unit(self.d, d, a, b, [curve_row(a + 1, "x", "m")]) for d, a, b in self.full]
        out = os.path.join(self.d, "o")
        with self.assertRaises(SystemExit):                    # missing middle unit
            F.main(sum([["--unit", x] for x in u[:1] + u[2:]], []) + ["--out", out, "--decide", "--plan", self.plan])
        self.assertFalse(os.path.exists(out))
        F.main(sum([["--unit", x] for x in u], []) + ["--out", out, "--decide", "--plan", self.plan])
        s = json.load(open(os.path.join(out, "f1_summary.json")))
        self.assertEqual(s["min_valid_pairs"], 8)
        self.assertEqual(len(s["plan"]["sha256"]), 64)



class RedTeamR1(unittest.TestCase):
    """research/brainstorm-loop/CODE_REDTEAM.md, R1 findings on F1."""

    def test_decide_uses_the_registered_resample_count(self):
        # R1-8: AMENDMENT_1 item 7 fixes 10,000 resamples; --decide with another --boot re-draws every bound
        d = tempfile.mkdtemp()
        plan = os.path.join(d, "plan.txt")
        with open(plan, "w") as fh:
            fh.write("2026-09-11 1 1000 1999\n2026-09-10 1 9000 9999\n")
        u = [write_unit(d, F.DAY1, 1000, 1999, [curve_row(1001, "x", "m")]),
             write_unit(d, F.DAY2, 9000, 9999, [curve_row(9001, "x", "m")])]
        out = os.path.join(d, "o")
        with self.assertRaises(SystemExit):
            F.main(sum([["--unit", x] for x in u], []) + ["--out", out, "--decide", "--plan", plan, "--boot", "50"])
        self.assertFalse(os.path.exists(out))

    def test_gate_never_passes_without_the_payer_mass_bar(self):
        # R1-9: PAYER_MASS.md names F1; until the bar is computed the gate is not reported as passed
        base = {"followed_day1": 20, "persistent_share": 0.5, "late_share": 0.5, "day2_persistent_leader_buys": 15}
        dec = F.decide(base)
        self.assertFalse(dec["f1_closes"])
        self.assertIsNone(dec["payer_mass_bar"]["passed"])
        self.assertFalse(dec["gate_passes"])
        self.assertTrue(F.decide(base, payer={"passed": True})["gate_passes"])


class PayerMassF1(unittest.TestCase):
    """COUNT_ROWS_AMENDMENT_8 Q-R1-g: F1's payer-mass bar (CODE_REDTEAM.md R1-23)."""

    def test_q_and_fee_from_the_trade_row(self):
        curve = pd.DataFrame([dict(curve_row(10, "L", "m"), virtual_sol_reserves="30000000000",
                                   fee_basis_points="95", creator_fee_basis_points="30")])
        amm = pd.DataFrame([{"slot": 11, "tx_idx": 0, "ev_idx": 0, "signature": "a1", "user_token_owner": "L",
                             "base_mint": "m2", "side": "buy", "quote_amount": "5", "quote_mint": F.WSOL,
                             "protocol": "0", "chain_pool_quote": "80000000000", "virtual_quote_reserves": "20000000000",
                             "lp_fee_basis_points": "20", "protocol_fee_basis_points": "5",
                             "coin_creator_fee_basis_points": "95"}])
        s = F.normalise_swaps(curve, amm, set(), F.DAY2).set_index("mint")
        self.assertEqual((s.at["m", "q"], s.at["m", "fee_bps"]), (30e9, 125))        # curve: virtual SOL, own fields
        self.assertEqual((s.at["m2", "q"], s.at["m2", "fee_bps"]), (100e9, 120))     # pool: effective quote after

    def test_bar_excess_in_shares_and_ties(self):
        x = F.SPEND_5USD
        Q = 2.0 ** 35                                   # a power of 2: shares round-trip exactly
        c = 2 * 0.0125 + (x * x / (Q + x) + x * x / Q) / x + 414_009 / x
        ss = np.sqrt(1 + c) - 1
        self.assertAlmostEqual(F.round_trip_share(Q, 125), ss)
        n = 21                                          # 11 at exactly 2 s*, 10 at exactly s*: median ratio 2, 11 a day
        ev = pd.DataFrame({"day": F.DAY2, "follower_sol_late": [2 * ss * Q] * 11 + [ss * Q] * 10,
                           "q": Q, "fee_bps": 125, "placebo_late": 0, "placebo_q": 50e9})
        r = F.f1_payer_bar(ev)
        self.assertEqual(r["events"], n)
        self.assertAlmostEqual(r["events_at_2x_per_day"], 11.0)
        self.assertTrue(r["passed"])
        ev2 = ev.assign(placebo_late=[1e-3 * 50e9] + [0] * (n - 1))   # placebo excess in its own Q's share
        self.assertFalse(F.f1_payer_bar(ev2)["passed"])                # one 2 s* event drops below: 10 a day
        self.assertIsNone(F.f1_payer_bar(ev.iloc[:0])["passed"])

    def test_run_and_decide_carry_the_bar(self):
        with tempfile.TemporaryDirectory() as root:
            rows1, rows2 = [], []
            for rows, base in ((rows1, 1000), (rows2, 20000)):
                for i in range(10):
                    s0 = base + 3000 + i * 100
                    rows.append(curve_row(s0, "L", f"m{i}"))
                    rows.append(curve_row(s0 + 700, f"pl{i}", f"m{i}"))
                    for k in range(3 + i % 2):
                        rows.append(curve_row(s0 + 30 + k, f"f{i}_{k}", f"m{i}", sol=1000))
            u1 = write_unit(root, F.DAY1, 1000, 9999, rows1)
            u2 = write_unit(root, F.DAY2, 20000, 29999, rows2)
            summ, tabs = F.run([u1, u2], n_boot=500)
            self.assertIn("placebo_late", tabs["events_day2"].columns)
            self.assertIn("passed", summ["payer_mass_bar"])
            d = F.decide(summ, payer=summ["payer_mass_bar"])
            self.assertEqual(d["gate_passes"], bool(not d["f1_closes"] and summ["payer_mass_bar"]["passed"] is True))


# ---------------------------------------------------------------- low-memory reader (2026-10-09)
CURVE_COLS = ["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "mint", "is_buy", "sol_amount", "quote_mint",
              "protocol", "virtual_sol_reserves", "fee_basis_points", "creator_fee_basis_points"]
AMM_COLS = ["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "base_mint", "side", "quote_amount",
            "quote_mint", "protocol", "chain_pool_quote", "virtual_quote_reserves", "lp_fee_basis_points",
            "protocol_fee_basis_points", "coin_creator_fee_basis_points"]


def random_units(root, seed, units_per_day=3, span=4000, rows_per_unit=900):
    """Random multi-unit tape for both days: curve and pool swaps (some sells, non-SOL quotes, protocol rows, BOOST
    signatures, missing owners), T transfers (mint, WSOL, mint/burn kinds, self transfers, missing owners) and W rows.
    A few heavy buyers spread over many mints so that leaders pass the 10-mint and 8-pair rules."""
    r = np.random.default_rng(seed)
    owners = [f"o{i:03d}" for i in range(120)]
    heavy = [f"h{i}" for i in range(6)]
    mints = [f"m{i:02d}" for i in range(25)]
    paths, plan = [], []
    for day, base in ((F.DAY1, 1_000_000), (F.DAY2, 2_000_000)):
        for u in range(units_per_day):
            lo, hi = base + u * span, base + (u + 1) * span - 1
            curve, amm, boost = [], [], []
            for k in range(rows_per_unit):
                slot = int(r.integers(lo, hi + 1))
                who = heavy[int(r.integers(len(heavy)))] if r.random() < 0.25 else owners[int(r.integers(len(owners)))]
                if r.random() < 0.02:
                    who = None
                mint = mints[int(r.integers(len(mints)))]
                sig = f"{day}-{u}-{k}"
                if r.random() < 0.02:
                    boost.append(sig)
                proto = "1" if r.random() < 0.02 else "0"
                if r.random() < 0.6:
                    curve.append({"slot": slot, "tx_idx": int(r.integers(0, 4)), "ev_idx": int(r.integers(0, 3)),
                                  "signature": sig, "user_token_owner": who, "mint": mint,
                                  "is_buy": int(r.random() < 0.8), "sol_amount": int(r.integers(1, 10**9)),
                                  "quote_mint": F.SOL_NATIVE if r.random() < 0.97 else "USDC", "protocol": proto,
                                  "virtual_sol_reserves": int(r.integers(10**9, 10**11)) if r.random() < 0.95 else None,
                                  "fee_basis_points": 95, "creator_fee_basis_points": int(r.integers(0, 60))})
                else:
                    amm.append({"slot": slot, "tx_idx": int(r.integers(0, 4)), "ev_idx": int(r.integers(0, 3)),
                                "signature": sig, "user_token_owner": who, "base_mint": mint,
                                "side": "buy" if r.random() < 0.8 else "sell", "quote_amount": int(r.integers(1, 10**9)),
                                "quote_mint": F.WSOL if r.random() < 0.97 else "USDC", "protocol": proto,
                                "chain_pool_quote": int(r.integers(10**10, 10**12)),
                                "virtual_quote_reserves": int(r.integers(0, 10**9)), "lp_fee_basis_points": 20,
                                "protocol_fee_basis_points": 5, "coin_creator_fee_basis_points": int(r.integers(0, 96))})
            pool = owners + heavy + [None]
            t = [{"mint": [*mints, F.WSOL][int(r.integers(len(mints) + 1))],
                  "kind": ["transfer", "transfer", "transfer", "mint", "burn"][int(r.integers(5))],
                  "from_owner": pool[int(r.integers(len(pool)))], "to_owner": pool[int(r.integers(len(pool)))]}
                 for _ in range(40)]
            w = [{"from": pool[int(r.integers(len(pool)))], "to": pool[int(r.integers(len(pool)))]} for _ in range(40)]
            p = os.path.join(root, day, f"{lo}-{hi}", "research")
            os.makedirs(p, exist_ok=True)
            pd.DataFrame(curve, columns=CURVE_COLS).to_csv(os.path.join(p, "S_curve.csv.zst"), index=False,
                                                           compression="zstd")
            pd.DataFrame(amm, columns=AMM_COLS).to_csv(os.path.join(p, "S_amm.csv.zst"), index=False, compression="zstd")
            pd.DataFrame(t, columns=["mint", "kind", "from_owner", "to_owner"]).to_csv(
                os.path.join(p, "T.csv.zst"), index=False, compression="zstd")
            pd.DataFrame(w, columns=["from", "to"]).to_csv(os.path.join(p, "W.csv.zst"), index=False, compression="zstd")
            lines = "".join(json.dumps({"event": "BoostBuyAndBurnEvent", "signature": x}) + "\n" for x in boost)
            with open(os.path.join(p, "E.jsonl.zst"), "wb") as fh:
                fh.write(zstandard.ZstdCompressor().compress(lines.encode()))
            paths.append(os.path.dirname(p))
            plan.append(f"{day} 1 {lo} {hi}")
    planf = os.path.join(root, "plan.txt")
    with open(planf, "w") as fh:
        fh.write("\n".join(plan) + "\n")
    return paths, planf


def outputs(d):
    res = {}
    for f in sorted(os.listdir(d)):
        with open(os.path.join(d, f), "rb") as fh:
            res[f] = fh.read()
    return res


class Compact(unittest.TestCase):
    """The low-memory reader (default) writes byte-identical files to the original reader (--original-reader)."""

    def _both(self, args, root):
        a, b = os.path.join(root, "orig"), os.path.join(root, "compact")
        with contextlib.redirect_stdout(io.StringIO()):
            F.main(args + ["--out", a, "--original-reader"])
            F.main(args + ["--out", b])
        oa, ob = outputs(a), outputs(b)
        self.assertEqual(sorted(oa), sorted(ob))
        self.assertTrue(oa)
        for f in oa:
            self.assertEqual(oa[f], ob[f], f)
        return oa

    def test_identical_outputs_on_the_end_to_end_fixture(self):
        with tempfile.TemporaryDirectory() as root:
            rows = lambda base: [r for i in range(10) for r in
                                 [curve_row(base + 3000 + i * 100, "L", f"m{i}"),
                                  curve_row(base + 3700 + i * 100, f"pl{i}", f"m{i}")]
                                 + [curve_row(base + 3030 + i * 100 + k, f"f{i}_{k}", f"m{i}", sol=1000)
                                    for k in range(3 + i % 2)]]
            u = [write_unit(root, F.DAY1, 1000, 9999, rows(1000)), write_unit(root, F.DAY2, 20000, 29999, rows(20000))]
            plan = os.path.join(root, "plan.txt")
            with open(plan, "w") as fh:
                fh.write(f"{F.DAY1} 1 1000 9999\n{F.DAY2} 1 20000 29999\n")
            args = sum([["--unit", x] for x in u], [])
            out = self._both(args + ["--decide", "--plan", plan], os.path.join(root, "full"))
            self.assertIn("f1_events_day2.csv", out)
            self._both(args + ["--prep-only"], os.path.join(root, "prep"))

    def test_identical_outputs_on_random_multi_unit_tapes(self):
        old = (F.BOOT_CHUNK_ELEMS, F.EV_BLOCK)
        F.BOOT_CHUNK_ELEMS, F.EV_BLOCK = 37, 7          # many bootstrap and record blocks, odd sizes
        try:
            for seed in (11, 12, 13):
                with tempfile.TemporaryDirectory() as root:
                    u, plan = random_units(root, seed)
                    args = sum([["--unit", x] for x in u], [])
                    out = self._both(args + ["--decide", "--plan", plan], os.path.join(root, "full"))
                    s = json.loads(out["f1_summary.json"])
                    self.assertGreater(s["leader_candidates_day1"], 0, seed)   # the leader stages really ran
                    self.assertGreater(s["day1_buys_used"], 8, seed)
                    lt = pd.read_csv(io.BytesIO(out["f1_leaders_day1.csv"]))
                    self.assertTrue(lt["testable"].any(), seed)                  # the bootstrap really ran
                    self._both(args + ["--prep-only"], os.path.join(root, "prep"))
        finally:
            F.BOOT_CHUNK_ELEMS, F.EV_BLOCK = old

    def test_blocked_bootstrap_draws_identical_means_and_rng_state(self):
        for n in (1, 2, 7, 8, 9, 1001, 40_000):
            d = np.random.default_rng(n).integers(-3, 4, n).astype(float)
            for chunk in (1, 5, 64, 1 << 16):
                r1, r2 = np.random.default_rng(3), np.random.default_rng(3)
                m1, m2 = F._boot_means(d, 300, r1, None), F._boot_means(d, 300, r2, chunk)
                self.assertTrue(np.array_equal(m1, m2), (n, chunk))
                self.assertTrue(np.array_equal(r1.integers(0, 2**40, 4), r2.integers(0, 2**40, 4)), (n, chunk))


class PrepOnly(unittest.TestCase):
    """--prep-only (real tape before the gate) computes no follow count, statistic, payer bar or decision."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.units, self.plan = random_units(self.root, 21, units_per_day=2)

    def test_guarded_stages_raise_in_prep_only(self):
        F._PREP_ONLY = True
        try:
            for call in (lambda: F.follow_stats({}, {}, set(), {}), lambda: F.leader_test(pd.DataFrame()),
                         lambda: F.round_trip_share(1.0, 1.0), lambda: F.f1_payer_bar(pd.DataFrame()),
                         lambda: F.decide({}), lambda: F._boot_means(np.ones(3), 2, np.random.default_rng(0), None)):
                with self.assertRaises(F.PrepOnlyError):
                    call()
        finally:
            F._PREP_ONLY = False

    def test_prep_run_never_reaches_an_outcome_stage(self):
        seen = []
        names = ("follow_stats", "leader_test", "round_trip_share", "f1_payer_bar", "decide", "_boot_means", "run")
        saved = {n: getattr(F, n) for n in names}
        for n in names:
            setattr(F, n, lambda *a, _n=n, **k: seen.append(_n))
        out = os.path.join(self.root, "o")
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                F.main(sum([["--unit", x] for x in self.units], []) + ["--out", out, "--prep-only"])
        finally:
            for n, fn in saved.items():
                setattr(F, n, fn)
        self.assertEqual(seen, [])
        self.assertFalse(F._PREP_ONLY)                          # the guard is reset after the run
        self.assertEqual(sorted(os.listdir(out)), ["f1_prep_events_day1.csv", "f1_prep_summary.json"])
        ev = pd.read_csv(os.path.join(out, "f1_prep_events_day1.csv"))
        self.assertEqual(tuple(ev.columns), F.PREP_EVENT_COLS)
        self.assertGreater(len(ev), 0)
        with open(os.path.join(out, "f1_prep_summary.json")) as fh:
            s = json.load(fh)
        banned = ("follow", "persist", "late", "payer", "decision", "untestable", "passes", "kills")
        self.assertEqual([k for k in s if any(b in k for b in banned)], [])

    def test_prep_rows_and_placebos_match_the_full_event_table(self):
        swaps, t, w, ranges = F.load_units(self.units)
        sp, mp = F.build_links(t, w)
        c = F.leader_candidates(swaps)
        full = F.event_table(swaps, c, F.DAY1, ranges, sp, mp)
        prep = F.event_table(swaps, c, F.DAY1, ranges, sp, mp, with_follow=False)
        pd.testing.assert_frame_equal(prep, full[list(F.PREP_EVENT_COLS)])

    def test_prep_only_refuses_decide(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            F.main(["--unit", self.units[0], "--out", os.path.join(self.root, "x"), "--prep-only", "--decide"])


if __name__ == "__main__":
    unittest.main()
