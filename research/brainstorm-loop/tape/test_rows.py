"""Unit tests for the Step A count rows on small synthetic tables.  Run: python3 -m unittest -v (from this folder)."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rows as R  # noqa: E402
from tapeio import AMM_COLS, CURVE_COLS, SOL_NATIVE, WSOL, Tape  # noqa: E402

DAY = "2026-09-11"
T0 = 1_000_000          # block_time = T0 + slot (one second a slot)
SUPPLY = 1e15


class Unit:
    def __init__(self, lo=0, hi=9999):
        self.lo, self.hi = lo, hi
        self.curve, self.amm, self.t, self.w, self.ev = [], [], [], [], []
        self.n = 0

    def _base(self, slot, owner, signer=None):
        self.n += 1
        return {"slot": slot, "block_time": T0 + slot, "tx_idx": self.n, "ev_idx": 0, "signature": f"sig{self.n}",
                "signer": signer or owner, "user_token_owner": owner, "owner_token_pre": 0, "owner_token_post": 0,
                "signer_sol_pre": 1, "signer_sol_post": 1}

    def cbuy(self, slot, owner, mint, sol=1e9, buy=True, pre=0, post=0, creator="DEV"):
        r = self._base(slot, owner)
        r.update({"mint": mint, "is_buy": int(buy), "sol_amount": sol, "token_amount": 1, "quote_mint": SOL_NATIVE,
                  "protocol": 0, "mayhem_mode": 0, "creator": creator, "owner_token_pre": pre, "owner_token_post": post})
        self.curve.append(r)
        return r

    def aswap(self, slot, owner, mint, pool, sol=1e9, buy=True, pre=0, post=0, creator="DEV", signer=None,
              sig=None, quote=80e9, virtual=20e9, base=1e14):
        r = self._base(slot, owner, signer)
        r.update({"base_mint": mint, "pool": pool, "side": "buy" if buy else "sell", "quote_amount": sol,
                  "base_amount": 1, "quote_mint": WSOL, "protocol": 0, "canonical": 1, "coin_creator": creator,
                  "pool_base_token_reserves": base, "pool_quote_token_reserves": quote, "chain_pool_base": base,
                  "chain_pool_quote": quote, "virtual_quote_reserves": virtual, "base_supply": SUPPLY,
                  "owner_token_pre": pre, "owner_token_post": post})
        if sig:
            r["signature"] = sig
        self.amm.append(r)
        return r

    def event(self, name, slot, fields, sig=None):
        self.n += 1
        self.ev.append({"event": name, "slot": slot, "block_time": T0 + slot, "signature": sig or f"e{self.n}",
                        "fields": fields})

    def create(self, slot, mint, creator="DEV", name=None):
        self.event("CreateEvent", slot, {"mint": mint, "creator": creator, "user": creator, "is_mayhem_mode": "0",
                                         "quote_mint": SOL_NATIVE, "name": name or mint, "symbol": name or mint})

    def migrate(self, slot, mint, pool, creator="DEV"):
        self.event("CompletePumpAmmMigrationEvent", slot, {"mint": mint, "pool": pool, "quote_mint": SOL_NATIVE})
        self.event("CreatePoolEvent", slot, {"pool": pool, "base_mint": mint, "quote_mint": WSOL,
                                             "is_mayhem_mode": "0", "coin_creator": creator, "creator": "x"})

    def write(self, root, day=DAY):
        p = os.path.join(root, day, f"{self.lo}-{self.hi}", "research")
        os.makedirs(p, exist_ok=True)
        z = dict(index=False, compression="zstd")
        pd.DataFrame(self.curve, columns=CURVE_COLS).to_csv(os.path.join(p, "S_curve.csv.zst"), **z)
        pd.DataFrame(self.amm, columns=AMM_COLS).to_csv(os.path.join(p, "S_amm.csv.zst"), **z)
        pd.DataFrame(self.t, columns=["slot", "mint", "kind", "from_owner", "to_owner"]).to_csv(
            os.path.join(p, "T.csv.zst"), **z)
        pd.DataFrame(self.w, columns=["slot", "from", "to"]).to_csv(os.path.join(p, "W.csv.zst"), **z)
        pd.DataFrame({"slot": range(self.lo, self.hi + 1), "block_time": [T0 + s for s in range(self.lo, self.hi + 1)]}
                     ).to_csv(os.path.join(p, "B.csv.zst"), **z)
        pd.DataFrame(columns=["slot", "creator", "amount", "event"]).to_csv(os.path.join(p, "CF.csv.zst"), **z)
        with open(os.path.join(p, "E.jsonl.zst"), "wb") as fh:
            fh.write(zstandard.ZstdCompressor().compress("".join(json.dumps(e) + "\n" for e in self.ev).encode()))
        return os.path.dirname(p)


def load(u):
    d = tempfile.mkdtemp()
    tape = Tape([u.write(d)])
    adj = R.adjacency(tape.links)
    labels, _ = R.two_sided_clusters(tape)
    s = R.prepare(tape, labels)
    return tape, s, adj


class Helpers(unittest.TestCase):
    def test_creator_group_hub_cap_and_as_of(self):
        L = [("DEV", "a", 1), ("a", "b", 2), ("b", "late", 50), ("DEV", "HUB", 3)]
        L += [("HUB", f"x{i}", 4) for i in range(51)]          # HUB linked to 52 owners
        links = pd.DataFrame(L, columns=["from_owner", "to_owner", "slot"])
        g = R.creator_group(R.adjacency(links), {"DEV"}, 10)
        self.assertEqual(g, {"DEV", "a", "b"})
        self.assertIn("late", R.creator_group(R.adjacency(links), {"DEV"}, 60))

    def test_first_time_flags(self):
        s = pd.DataFrame({"mint": ["m"] * 4 + ["n"], "owner": ["a", "a", "b", None, "a"],
                          "is_buy": [True, True, True, True, True], "excluded": [False, False, True, False, False],
                          "order": range(5)})
        self.assertEqual(list(R.first_time_flags(s)), [True, False, False, False, True])

    def test_placebo_grid(self):
        g = R.placebo_grid()
        self.assertTrue(g and all(abs(c / 420 - 1) > 0.1 and abs(c / 1470 - 1) > 0.1 for c in g))
        self.assertTrue(all(340 <= c <= 1300 for c in g))
        lv = 100_000 / 119.26                                   # about 838.5 SOL
        g2 = R.placebo_grid([lv])
        self.assertTrue(all(abs(c / lv - 1) > 0.1 for c in g2))
        self.assertLess(len(g2), len(g))


class Loader(unittest.TestCase):
    def test_boost_rows_excluded_by_signature(self):
        u = Unit()
        u.aswap(10, "A0", "M", "P", sig="boostsig")          # has an owner and protocol=0
        u.event("BoostBuyAndBurnEvent", 10, {"mint": "M", "pool": "P"}, sig="boostsig")
        u.aswap(11, "A", "M", "P")
        tape, s, _ = load(u)
        self.assertEqual(int(s["boost"].sum()), 1)
        self.assertEqual(list(s.loc[s["ftb"], "owner"]), ["A"])


def dev_unit():
    u = Unit()
    # pool P: dev crosses 5% (6% -> 4%) at slot 4000, 3,900 s after migration
    u.create(10, "M")
    u.migrate(100, "M", "P")
    u.w.append({"slot": 50, "from": "DEV", "to": "G"})               # creator-group member
    u.aswap(200, "H1", "M", "P", pre=0, post=5e12)                     # existing holder
    u.aswap(4000, "DEV", "M", "P", buy=False, pre=6e13, post=4e13)
    u.aswap(4010, "X1", "M", "P", sol=1e9)                             # first-time, inside 23 slots
    u.aswap(4030, "X2", "M", "P", sol=5e9)                             # first-time, late
    u.aswap(4040, "H1", "M", "P", sol=2e9, buy=False)                  # holder sells, late
    u.aswap(4050, "G", "M", "P", sol=7e9)                              # creator group: excluded
    u.aswap(4060, "H1", "M", "P", sol=9e9)                             # repeat buyer: not first-time
    u.aswap(5000, "X3", "M", "P", sol=4e9)                             # after 15 min: out
    # pool Q: placebo crossing at 4.2% only (4.5% -> 4.0%)
    u.create(20, "N")
    u.migrate(110, "N", "Q")
    u.aswap(4100, "DEV", "N", "Q", buy=False, pre=4.5e13, post=4.0e13)
    return u


class DevZero(unittest.TestCase):
    def test_event_net_and_control(self):
        tape, s, adj = load(dev_unit())
        df, summ = R.dev_zero(tape, s, adj)
        e = df[(df["arm"] == "le5") & (df["kind"] == "event")].iloc[0]
        self.assertEqual(e["pool"], "P")
        self.assertEqual(e["ftb_sol_all"], 6e9)
        self.assertEqual(e["ftb_sol_late"], 5e9)
        self.assertEqual(e["holder_sell_late"], 2e9)
        self.assertAlmostEqual(e["net"], 3e9 / 100e9)
        c = df[(df["arm"] == "le5") & (df["kind"] == "control")].iloc[0]
        self.assertEqual(c["pool"], "Q")
        self.assertEqual(c["net"], 0)
        x = summ["le5"]
        self.assertAlmostEqual(x["median_net_excess"], 0.03)
        self.assertAlmostEqual(x["late_share_of_ftb"], 5 / 6)
        self.assertEqual(x["events_per_day"], {DAY: 1})
        self.assertFalse(R.dev_zero_decide(summ)["le5"])           # 3% < 3.4% and 1 event a day

    def test_young_pool_and_missing_history_dropped(self):
        u = dev_unit()
        u.ev = [e for e in u.ev if not (e["event"] == "CreateEvent" and e["fields"]["mint"] == "M")]
        tape, s, adj = load(u)
        df, _ = R.dev_zero(tape, s, adj)
        self.assertEqual(df[(df["pool"] == "P")]["dropped"].iloc[0], "history_not_on_tape")
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(3000, "DEV", "M", "P", buy=False, pre=6e13, post=4e13)   # 2,900 s after migration
        tape, s, adj = load(u)
        df, _ = R.dev_zero(tape, s, adj)
        self.assertEqual(len(df), 0)

    def test_zero_arm_control_dropped_when_dev_sells_again(self):
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(4000, "DEV", "M", "P", buy=False, pre=6e13, post=3e12)     # leaves 5% of holding: near-full
        u.aswap(4100, "DEV", "M", "P", buy=False, pre=3e12, post=1e12)
        tape, s, adj = load(u)
        df, _ = R.dev_zero(tape, s, adj)
        c = df[(df["arm"] == "zero") & (df["kind"] == "control")].iloc[0]
        self.assertEqual(c["dropped"], "dev_sold_again_in_window")


class TwoSidedAndW1(unittest.TestCase):
    def test_two_sided_label_and_ftb_exclusion(self):
        u = Unit()
        u.w.append({"slot": 1, "from": "A", "to": "B"})
        u.cbuy(500, "A", "Z")
        u.cbuy(700, "B", "Z", buy=False)
        u.cbuy(510, "C", "Z")
        u.cbuy(520, "D", "Z", buy=False)
        tape, s, _ = load(u)
        labels, summ = R.two_sided_clusters(tape)
        self.assertEqual(set(labels.loc[labels["rule"] == "hub_cap_50", "owner"]), {"A", "B"})
        self.assertEqual(summ["hub_cap_50"]["two_sided_clusters"], 1)
        self.assertEqual(set(s.loc[s["ftb"] & ~s["fake"], "owner"]), {"C"})

    def test_two_sided_window(self):
        u = Unit()
        u.w.append({"slot": 1, "from": "A", "to": "B"})
        u.cbuy(500, "A", "Z")
        u.cbuy(500 + R.TWO_SIDED_SLOTS + 1, "B", "Z", buy=False)
        tape, _, _ = load(u)
        labels, _ = R.two_sided_clusters(tape)
        self.assertEqual(len(labels[labels["rule"] == "hub_cap_50"]), 0)

    def test_w1_fast_class(self):
        u = Unit()
        u.create(100, "M")
        u.cbuy(102, "F", "M")                       # within 2 slots of create
        u.cbuy(300, "F", "M2")
        u.cbuy(400, "BIG", "M3", sol=2e9)
        u.cbuy(402, "Q", "M3", sol=1e8)             # 2 slots after another's >= 1 SOL buy
        u.cbuy(403, "S", "M3", sol=1e8)             # 3 slots after BIG: not
        u.cbuy(900, "S", "M4")
        tape, s, _ = load(u)
        f = R.w1_fast_class(tape, s)
        self.assertTrue(f[(DAY, "F")])
        self.assertTrue(f[(DAY, "Q")])
        self.assertFalse(f[(DAY, "S")])
        self.assertFalse(f[(DAY, "BIG")])


class SeatDrift(unittest.TestCase):
    def _unit(self, link=False):
        u = Unit()
        for mint, pool, m, c in (("A", "PA", 200, "CA"), ("B", "PB", 250, "CB"), ("C", "PC", 1000, "CC")):
            u.create(m - 100, mint, creator=c)
            u.migrate(m, mint, pool, creator=c)
            u.aswap(m + 1, "seed" + mint, mint, pool, creator=c)
        if link:
            u.w.append({"slot": 5, "from": "CA", "to": "CB"})
        # pool PA: first-time buy in w1 and in w2
        u.aswap(200 + 3600 + 30, "N1", "A", "PA", sol=10e9, creator="CA")
        u.aswap(200 + 3000, "N2", "A", "PA", sol=1e9, creator="CA")
        return u

    def test_n_m_busy_lone_and_cluster(self):
        tape, s, adj = load(self._unit())
        df, summ = R.seat_drift(tape, s, adj)
        d = df.set_index("pool")
        self.assertEqual((d.at["PA", "N_m"], d.at["PB", "N_m"], d.at["PC", "N_m"]), (1, 1, 0))
        self.assertAlmostEqual(d.at["PA", "w1_share"], 10e9 / 100e9)
        self.assertAlmostEqual(d.at["PA", "w2_share"], 1e9 / 100e9)
        self.assertEqual((summ["busy"], summ["lone"]), (1, 1))             # Q9: terciles of N_m per day
        self.assertEqual((d.at["PC", "tercile"], d.at["PA", "tercile"], d.at["PB", "tercile"]), (0, 1, 2))
        tape, s, adj = load(self._unit(link=True))
        df, _ = R.seat_drift(tape, s, adj)
        self.assertEqual(df.set_index("pool").at["PA", "N_m"], 0)   # same creator cluster: not counted


class Rebuy(unittest.TestCase):
    def test_exit_rebuy_and_readability(self):
        u = Unit()
        u.cbuy(10, "A", "M")
        u.cbuy(100, "A", "M", buy=False, sol=3e9, pre=5, post=0)       # exit
        u.cbuy(100 + 7200, "A", "M")                                   # rebuy at exactly 2 h
        u.cbuy(20, "B", "M")
        r = u.cbuy(30, "B", "M", buy=False, sol=1e9, pre=5, post=0)    # exit by a router: signer != owner
        r["signer"] = "router"
        tape, s, _ = load(u)
        df, summ = R.rebuy_anchor(tape, s)
        self.assertEqual(summ["exits"], 2)
        self.assertEqual(df.set_index("owner").at["A", "rebuy_2h"], True)
        self.assertEqual(df.set_index("owner").at["B", "rebuy_2h"], False)
        self.assertAlmostEqual(summ["proceeds_readable_share"], 0.75)
        self.assertTrue(summ["not_computed_pending_ruling"])


class ReviewFixes(unittest.TestCase):
    def test_dev_zero_counts_zero_for_loaded_day_without_events(self):
        d = tempfile.mkdtemp()
        tape = Tape([dev_unit().write(d), Unit(20000, 20999).write(d, "2026-09-10")])
        adj = R.adjacency(tape.links)
        labels, _ = R.two_sided_clusters(tape)
        s = R.prepare(tape, labels)
        _, summ = R.dev_zero(tape, s, adj)
        self.assertEqual(summ["le5"]["events_per_day"], {DAY: 1, "2026-09-10": 0})
        self.assertEqual(summ["zero"]["events_per_day"], {DAY: 0, "2026-09-10": 0})

    def test_missing_price_gives_none(self):
        d = tempfile.mkdtemp()
        tape = Tape([Unit().write(d), Unit(20000, 20999).write(d, "2026-09-10")])
        _, summ = R.round_usd(tape, tape.swaps, {DAY: 119.26}, {}, n_boot=0)
        self.assertIsNone(summ["a_not_separable_from_usd_level"])

    def test_gate3_ignores_creator_swaps_before_window(self):
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(150, "o0", "M", "P", quote=22e9)                        # market cap 420 SOL
        u.aswap(200, "DEV", "M", "P", sol=5e9, quote=22e9)               # creator buy before m + 5 min
        u.aswap(1000, "o1", "M", "P", quote=22e9)
        tape, s, adj = load(u)
        seg = R.mcap_segments(tape, s)
        df = R.gate3_split(tape, s, seg, adj, return_rows=True)
        self.assertEqual(df.iloc[0]["measure_main"], 0.0)


class Plan(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.plan = os.path.join(self.d, "plan.txt")
        with open(self.plan, "w") as fh:
            fh.write("2026-09-11 1 0 99\n2026-09-11 1 100 199\n2026-09-11 1 200 299\n"
                     "2026-09-10 1 1000 1099\n2026-09-08 1 5 6\n")
        self.full = [("2026-09-11", 0, 99), ("2026-09-11", 100, 199), ("2026-09-11", 200, 299),
                     ("2026-09-10", 1000, 1099)]

    def test_exact_plan_passes_and_returns_sha(self):
        import hashlib
        from tapeio import check_plan
        self.assertEqual(check_plan(self.full, self.plan), hashlib.sha256(open(self.plan, "rb").read()).hexdigest())

    def test_missing_middle_and_subset_refused(self):
        from tapeio import PlanError, check_plan
        with self.assertRaises(PlanError):
            check_plan([r for r in self.full if r[1] != 100], self.plan)
        with self.assertRaises(PlanError):
            check_plan(self.full[:3], self.plan)                         # a correct subset is not enough
        with self.assertRaises(PlanError):
            check_plan(self.full + [("2026-09-12", 1, 2)], self.plan)

    def test_noncontiguous_plan_refused(self):
        from tapeio import PlanError, check_plan
        with open(self.plan, "w") as fh:
            fh.write("2026-09-11 1 0 99\n2026-09-11 1 150 199\n2026-09-10 1 1000 1099\n")
        with self.assertRaises(PlanError):
            check_plan([("2026-09-11", 0, 99), ("2026-09-11", 150, 199), ("2026-09-10", 1000, 1099)], self.plan)

    def test_cli_decide_refused_on_incomplete_units(self):
        import run_step_a
        u = Unit().write(self.d)
        with self.assertRaises(SystemExit):
            run_step_a.main(["--unit", u, "--out", os.path.join(self.d, "o"), "--decide", "--plan", self.plan])
        self.assertFalse(os.path.exists(os.path.join(self.d, "o")))


class RoundUsd(unittest.TestCase):
    def test_flag_and_bunching_runs(self):
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        # market cap = (quote+virtual)/base * supply / 1e9: 100e9/1e14*1e15/1e9 = 1,000 SOL
        for k in range(20):
            u.aswap(500 + 300 * k, f"o{k}", "M", "P", quote=80e9 + k * 1e9)
        tape, s, adj = load(u)
        seg = R.mcap_segments(tape, s)
        self.assertAlmostEqual(seg["mcap"].iloc[0], 1000.0)
        self.assertGreaterEqual(seg["t0"].min(), T0 + 100 + 300)       # BOOST-less: first 5 min excluded
        df, summ = R.round_usd(tape, s, {DAY: 119.26}, adj, n_boot=20)
        self.assertTrue(summ["a_within_5pct_of_round_usd"][DAY])       # 420 SOL is about $50,089
        self.assertTrue(summ["a_not_separable_from_usd_level"])
        self.assertEqual(set(df["usd_level"]), {50_000.0, 100_000.0})
        _, summ = R.round_usd(tape, s, {DAY: 150.0}, adj, n_boot=0)
        self.assertFalse(summ["a_within_5pct_of_round_usd"][DAY])
        _, summ = R.round_usd(tape, s, None, adj)
        self.assertIn("needs SOL/USD", summ["status"])


if __name__ == "__main__":
    unittest.main()
