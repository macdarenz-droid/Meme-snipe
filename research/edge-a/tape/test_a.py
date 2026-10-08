"""Unit tests for Design A tape code, on small synthetic tables. Run: python3 -m unittest (from this directory)."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd
import zstandard

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import features as F  # noqa: E402
import gates as G  # noqa: E402
import load as L  # noqa: E402
import run_a  # noqa: E402

T0 = 1_789_000_000  # 2026-09-10T00:26:40Z
DAY = "2026-09-10"
SUP = 1e15  # supply = base reserve, so market cap in SOL = effective quote / 1e9


def swap(slot, pool, pre_mc, side="buy", q=0.0, b=0.0, sig=None, signer="U", owner="U", creator="C",
         canonical=1, quote=L.WSOL, vq=17.6e9, cfee=30):
    return {"slot": slot, "block_time": T0 + slot - 1000, "tx_idx": 0, "ev_idx": 0,
            "signature": sig or f"s{pool}{slot}", "signer": signer, "pool": pool, "quote_mint": quote, "side": side,
            "base_amount": b, "quote_amount": q, "lp_fee": 0.0, "pool_base_token_reserves": 1e15,
            "pool_quote_token_reserves": pre_mc * 1e9 - vq, "virtual_quote_reserves": vq, "base_supply": SUP,
            "coin_creator": creator, "coin_creator_fee_basis_points": cfee, "user_token_owner": owner,
            "canonical": canonical, "can_boost": 1}


def ev(event, slot, sig, **fields):
    return {"event": event, "slot": slot, "block_time": T0 + slot - 1000, "tx_idx": 0, "ev_idx": 0,
            "signature": sig, "fields": fields}


def migrate(pool, slot, mayhem="0", quote=L.SYSTEM):
    sig = "mig" + pool
    return [ev("CompletePumpAmmMigrationEvent", slot, sig, pool=pool, mint="M" + pool, quote_mint=quote),
            ev("CreatePoolEvent", slot, sig, pool=pool, base_mint="M" + pool, is_mayhem_mode=mayhem)]


def p1_rows():
    """Pool P1: migrated at slot 1000, BOOST ends at slot 1100. Expected at 420: upper 799 s, lower 100 s,
    creator net +3 SOL, counted, one cross at slot 1200."""
    return [
        swap(1050, "P1", 420, q=100e9, signer="C"),  # creator buy inside the BOOST window: excluded
        swap(1100, "P1", 300, q=1e9, sig="boost1"),  # the last BOOST swap
        dict(swap(1100, "P1", 430, q=50e9, b=1e12, signer="C"), tx_idx=1),  # same second as the BOOST end: excluded
        swap(1200, "P1", 410, q=10e9, b=1e15 * (1 - 420 / 430)),  # crosses 420 (post 430); counted
        swap(1300, "P1", 430, q=5e9, b=1e12, signer="C"),  # creator buys 5 SOL at 430
        swap(1400, "P1", 430, side="sell", q=2e9, b=1e12, owner="C"),  # creator (owner) sells 2 SOL at 430
        swap(1600, "P1", 430),  # zero-size: post = pre = 430 to the segment end (slot 1999)
    ]


def write_unit(root, frm, to, swaps, events, day=DAY, t_shift=0):
    d = os.path.join(root, day, f"{frm}-{to}", "research")
    os.makedirs(d)
    slots = np.arange(frm, to + 1)
    pd.DataFrame({"slot": slots, "block_time": T0 + slots - 1000 + t_shift}).to_csv(
        os.path.join(d, "B.csv.zst"), index=False, compression="zstd")
    s = pd.DataFrame(swaps, columns=L.S_AMM_COLS)
    s.to_csv(os.path.join(d, "S_amm.csv.zst"), index=False, compression="zstd")
    raw = "".join(json.dumps(e) + "\n" for e in events).encode()
    with open(os.path.join(d, "E.jsonl.zst"), "wb") as f:
        f.write(zstandard.ZstdCompressor().compress(raw))
    with open(os.path.join(d, "stats.json"), "w") as f:
        json.dump({"day": day, "from_slot": frm, "to_slot": to}, f)
    open(os.path.join(d, "CF.csv.zst"), "wb").close()
    return d


def fee_config(root):
    p = os.path.join(root, "fee.json")
    tiers = [{"market_cap_lamports_threshold": "0", "fees": {"creator_fee_bps": "30", "protocol_fee_bps": "93", "lp_fee_bps": "2"}},
             {"market_cap_lamports_threshold": "420000000000", "fees": {"creator_fee_bps": "95", "protocol_fee_bps": "5", "lp_fee_bps": "20"}}]
    with open(p, "w") as f:
        json.dump({"amm": {"fee_tiers": tiers}}, f)
    return p


def standard_tape(root):
    events = migrate("P1", 1000) + [
        ev("BoostBuyAndBurnEvent", 1050, "b0", pool="P1", boost_vault_remaining="5"),
        ev("BoostBuyAndBurnEvent", 1100, "boost1", pool="P1", boost_vault_remaining="0"),
    ] + migrate("P2", 1000, mayhem="1") + migrate("P3", 1000) + [
        ev("BoostBuyAndBurnEvent", 1050, "b3", pool="P3", boost_vault_remaining="7"),
    ] + migrate("P4", 1000) + migrate("P5", 1000) + migrate("P6", 1000, quote="QTOKEN")
    swaps = p1_rows() + [
        swap(1500, "P2", 410), swap(1500, "P3", 410),
        swap(1250, "P4", 410), swap(1350, "P4", 410),  # P4: no BOOST, lo = slot 1300; only the 1350 swap counts
        swap(1500, "P5", 410, canonical=0), swap(1500, "P6", 410),
    ]
    return write_unit(root, 1000, 1999, swaps, events)


class TestGrid(unittest.TestCase):
    def test_placebo_grid(self):
        g = F.placebo_grid()
        self.assertEqual(len(g), 20)
        self.assertAlmostEqual(g[0], 340.0)
        self.assertAlmostEqual(g[-1], 1300.0)
        self.assertTrue(np.all(np.abs(g / 420 - 1) > 0.10))
        self.assertTrue(np.all(np.abs(g / 1470 - 1) > 0.10))
        steps = np.diff(np.log(g))
        self.assertAlmostEqual(steps.min(), np.log(1300 / 340) / 23)  # 24-point log grid, 4 points dropped
        lo, c, hi = F.band_edges(np.array([420.0]))
        self.assertEqual((lo[0], c[0], hi[0]), (399.0, 420.0, 441.0))


class TestMarketCap(unittest.TestCase):
    def test_effective_quote_and_supply(self):
        mc = F.market_cap_sol(67.4e9, 17.6e9, 1e15 * 0.2, 1e15 * 0.99)
        self.assertAlmostEqual(float(mc), 85.0 * 0.99 / 0.2)
        self.assertTrue(np.isnan(F.market_cap_sol(1e9, -2e9, 1e15, 1e15)))  # effective quote <= 0
        self.assertTrue(np.isnan(F.market_cap_sol(1e9, 0, 0, 1e15)))

    def test_supply_rule_tally(self):
        with tempfile.TemporaryDirectory() as d:
            tiers = F.load_fee_tiers(fee_config(d))
        s = pd.DataFrame([swap(1, "X", 430, cfee=95), swap(2, "X", 410, cfee=30), swap(3, "X", 410, cfee=0),
                          swap(4, "X", 430, cfee=95, canonical=0)])
        s.loc[1, "base_supply"] = 0.9e15  # live supply after burns: 369 SOL with it, 410 with 1e15 (both tier 30)
        s.loc[0, "base_supply"] = 0.97e15  # 417 with live supply (tier 30), 430 with 1e15 (tier 95)
        t = F.supply_rule_tally(s, tiers)
        # Agreement is measured only where live and fixed supply pick different tiers (row 0 only).
        self.assertEqual(t, {"n": 2, "n_diff": 1, "base_supply": 0, "fixed_1e15": 1})
        self.assertFalse(run_a.supply_verified(t))
        s2 = pd.DataFrame([swap(1, "X", 430, cfee=30), swap(2, "X", 410, cfee=30)])
        s2.loc[0, "base_supply"] = 0.97e15  # live 417 (tier 30) is right; fixed 430 (tier 95) is wrong
        t2 = F.supply_rule_tally(s2, tiers)
        self.assertEqual(t2, {"n": 2, "n_diff": 1, "base_supply": 1, "fixed_1e15": 0})
        self.assertTrue(run_a.supply_verified(t2))
        self.assertFalse(run_a.supply_verified({"n": 5, "n_diff": 0, "base_supply": 0, "fixed_1e15": 0}))


class TestPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.unit = standard_tape(cls.tmp.name)
        cls.b = run_a.build(L.select_units([cls.unit], [DAY]), fee_config(cls.tmp.name))
        cls.p = cls.b["pools"].set_index("pool")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_exclusions(self):
        r = self.p.reason.to_dict()
        self.assertEqual(r["P1"], "")
        self.assertEqual(r["P2"], "mayhem")
        self.assertEqual(r["P3"], "boost_end_unknown")
        self.assertEqual(r["P4"], "")
        self.assertEqual(r["P5"], "not_canonical_sol")
        self.assertEqual(r["P6"], "quote_not_sol")

    def test_boost_window(self):
        self.assertEqual(self.p.lo["P1"], T0 + 100)  # last BoostBuyAndBurnEvent
        self.assertEqual(self.p.lo["P4"], T0 + 300)  # no BOOST event: 5 minutes
        self.assertEqual(self.p.hi["P1"], T0 + 72 * 3600)

    def test_band_seconds_and_creator(self):
        el = self.b["pools"].pool[self.b["pools"].eligible].tolist()
        i1 = el.index("P1")
        self.assertEqual(self.b["up"][i1, 0], 799.0)
        self.assertEqual(self.b["dn"][i1, 0], 100.0)
        self.assertAlmostEqual(self.b["net"][i1, 0], 3.0)
        self.assertEqual(self.b["up"][i1, 1:].sum() + self.b["dn"][i1, 1:].sum(), 0.0)
        i4 = el.index("P4")  # 410 from lo (1300) to the end (1999): 699 s in [399, 420)
        self.assertEqual(self.b["dn"][i4, 0], 699.0)
        self.assertEqual(self.b["up"][i4, 0], 0.0)

    def test_count_rule(self):
        self.assertTrue(self.p.count_rule["P1"])
        self.assertTrue(self.p.count_rule["P4"])
        self.assertFalse(self.p.count_rule["P2"])
        self.assertEqual(int(self.p.count_rule.sum()), 2)

    def test_cross_events(self):
        e = self.b["entries"]
        self.assertEqual(len(e[e.cutoff_idx == 0]), 1)
        r = e[e.cutoff_idx == 0].iloc[0]
        self.assertEqual(r.slot, 1200)
        self.assertEqual(r.stop_ref, 399.0)
        self.assertEqual(len(e), 1)

    def test_cli_check_mode_writes_no_statistic(self):
        out = os.path.join(self.tmp.name, "out")
        rc = subprocess.run([sys.executable, os.path.join(HERE, "run_a.py"), "--days", DAY, "--units", self.unit,
                             "--out", out, "--fee-config", fee_config(self.tmp.name)], capture_output=True, text=True)
        self.assertEqual(rc.returncode, 0, rc.stderr)
        self.assertEqual(sorted(os.listdir(out)), ["entries.csv", "pools.csv", "summary.json"])
        with open(os.path.join(out, "summary.json")) as f:
            s = json.load(f)
        self.assertEqual(s["count_rule"], {"n": 2, "status": "short: add Step A days"})  # 09-10 alone completes no step
        rc = subprocess.run([sys.executable, os.path.join(HERE, "run_a.py"), "--days", DAY, "--units", self.unit,
                             "--out", out, "--score-primary"], capture_output=True, text=True)
        self.assertNotEqual(rc.returncode, 0)  # scoring needs the confirmation


class TestCoverageAndTimeline(unittest.TestCase):
    def test_gap_is_not_counted(self):
        segs = pd.DataFrame({"from_slot": [0, 100], "to_slot": [49, 149], "t_start": [0, 100], "t_end": [49, 149]})
        sw = pd.DataFrame({"pool": [0, 0, 0], "slot": [10, 40, 120], "tx_idx": 0, "ev_idx": 0, "t": [10, 40, 120],
                           "pre_mc": [400.0, 430.0, 500.0], "post_mc": [401.0, 431.0, 501.0]})
        iv = F.timeline(sw, segs, L.segment_of(sw.slot.to_numpy(), segs))
        iv = iv.sort_values(["start"]).reset_index(drop=True)
        self.assertEqual(iv[["start", "end"]].values.tolist(), [[0, 10], [10, 40], [40, 49], [100, 120], [120, 149]])
        self.assertEqual(iv.mc.tolist(), [400.0, 430.0, 431.0, 500.0, 501.0])
        self.assertEqual(int((iv.end - iv.start).sum()), 49 + 49)

    def test_segments_merge_contiguous_units(self):
        us = [L.Unit("a", DAY, 0, 9, "v2"), L.Unit("b", DAY, 10, 19, "v2"), L.Unit("c", DAY, 30, 39, "v2")]
        bl = [pd.DataFrame({"slot": [0, 9], "block_time": [0, 4]}), pd.DataFrame({"slot": [10, 19], "block_time": [5, 9]}),
              pd.DataFrame({"slot": [30, 39], "block_time": [15, 19]})]
        s = L.coverage_segments(us, bl)
        self.assertEqual(s.values.tolist(), [[0, 19, 0, 9], [30, 39, 15, 19]])
        self.assertEqual(L.segment_of(np.array([5, 25, 35]), s).tolist(), [0, -1, 1])

    def test_window_clip_72h(self):
        pools = pd.DataFrame({"lo": [100.0], "hi": [100.0 + 72 * 3600]})
        iv = pd.DataFrame({"pool": [0, 0], "start": [0, 72 * 3600], "end": [200, 80 * 3600], "mc": [1.0, 2.0]})
        c = F.clip_to_window(iv, pools)
        self.assertEqual(c.dur.tolist(), [100.0, 100.0])


class TestWall(unittest.TestCase):
    def test_days_and_rows_after_wall(self):
        with self.assertRaises(L.WallError):
            L.check_day("2026-09-12")
        with tempfile.TemporaryDirectory() as d:
            late = swap(1001, "P1", 410)
            late["block_time"] += L.WALL_TS - T0
            u = write_unit(d, 1000, 1009, [late], [], t_shift=L.WALL_TS - T0)
            unit = L.select_units([u], [DAY])[0]
            with self.assertRaises(L.WallError):
                L.load_blocks(unit)
            with self.assertRaises(L.WallError):
                list(L.iter_swaps(unit))
            with self.assertRaises(L.WallError):
                L.select_units([u], ["2026-09-11"])


class TestLookAhead(unittest.TestCase):
    def test_cross_events_ignore_the_future(self):
        rng = np.random.default_rng(1)
        n = 400
        pre = 400 + np.cumsum(rng.normal(0, 4, n))
        sw = pd.DataFrame({"pool": rng.integers(0, 3, n), "slot": np.arange(n), "tx_idx": 0, "ev_idx": 0,
                           "t": np.arange(n), "pre_mc": pre, "post_mc": pre + rng.normal(0, 6, n),
                           "is_boost": False})
        pools = pd.DataFrame({"lo": [5.0, 5.0, 5.0], "hi": [1e9, 1e9, 1e9]})
        cuts = F.cutoffs()
        full = F.cross_events(sw, pools, cuts)
        cut_t = 200
        planted = sw.copy()
        future = planted.t > cut_t
        planted.loc[future, "pre_mc"] = 1.0  # future-only marker: every later row would cross every cutoff
        planted.loc[future, "post_mc"] = 1e6
        got = F.cross_events(planted, pools, cuts)
        a = full[full.t <= cut_t].sort_values(["pool", "cutoff_idx"]).reset_index(drop=True)
        b = got[got.t <= cut_t].sort_values(["pool", "cutoff_idx"]).reset_index(drop=True)
        pd.testing.assert_frame_equal(a, b)
        self.assertTrue((got.t > cut_t).any())  # the marker is visible only after its time

    def test_features_never_import_outcomes(self):
        src = ""
        for name in ("features.py", "gates.py"):
            with open(os.path.join(HERE, name)) as f:
                src += f.read()
        self.assertNotIn("import outcomes", src)
        self.assertNotIn("from outcomes", src)
        import outcomes
        with self.assertRaises(NotImplementedError):
            outcomes.score_return_test()


class TestGates(unittest.TestCase):
    def test_gate2_known_value(self):
        dn = np.ones((1, 21))
        up = np.ones((1, 21))
        up[0, 0] = np.e
        self.assertAlmostEqual(G.gate2_stat(up, dn)[0], 1.0)
        up[0, 0] = 0.0  # no time above 420: -inf, fails
        self.assertEqual(G.gate2_stat(up, dn)[0], -np.inf)
        up[0, 0], dn[0, 0] = 1.0, 0.0  # no time below 420: +inf is not allowed to pass
        self.assertEqual(G.gate2_stat(up, dn)[0], -np.inf)

    def test_gate2_placebo_median(self):
        dn = np.ones((1, 21))
        up = np.ones((1, 21))
        up[0, 1:] = np.exp(np.arange(20) - 9.5)  # placebo log ratios -9.5..9.5, median 0
        up[0, 0] = np.exp(2.0)
        self.assertAlmostEqual(G.gate2_stat(up, dn)[0], 2.0)
        up[0, 1:3], dn[0, 1:3] = 0.0, 0.0  # the two lowest placebos become undefined = +inf: median 0 -> 2
        self.assertAlmostEqual(G.gate2_stat(up, dn)[0], 0.0)

    def test_gate3_known_value(self):
        secs = np.full((1, 21), 3600.0)
        net = np.zeros((1, 21))
        net[0, 0] = 2.0
        net[0, 1:] = np.arange(20) - 9.5  # median 0
        self.assertAlmostEqual(G.gate3_stat(net, secs)[0], 2.0)
        secs[0, 0] = 7200.0
        self.assertAlmostEqual(G.gate3_stat(net, secs)[0], 1.0)

    def test_bootstrap_clusters_by_pool(self):
        rng = np.random.default_rng(0)
        P = 300
        dn = rng.uniform(50, 150, (P, 21))
        up = dn * np.exp(rng.normal(0, 0.2, (P, 21)))
        up[:, 0] *= 1.5
        r = G.pool_bootstrap(G.gate2_stat, [up, dn], n_boot=2000, seed=3)
        self.assertLess(r["lo"], r["point"])
        self.assertLess(r["point"], r["hi"])
        self.assertAlmostEqual(r["point"], float(G.gate2_stat(up.sum(0), dn.sum(0))[0]))
        same = G.pool_bootstrap(G.gate2_stat, [np.tile(up[:1], (5, 1)), np.tile(dn[:1], (5, 1))], n_boot=200)
        self.assertAlmostEqual(same["lo"], same["hi"])  # identical pools: no spread
        r2 = G.pool_bootstrap(G.gate2_stat, [up, dn], n_boot=2000, seed=3)
        self.assertEqual(r, r2)  # fixed seed: reproducible

    def test_count_rule_and_scoring_guard(self):
        self.assertEqual(G.count_rule(200, ("A",))["status"], "met")
        self.assertEqual(G.count_rule(199, ("A",))["status"], "short: add Step B days")
        self.assertEqual(G.count_rule(199, ("A", "B"))["status"], "short: add Step C days")
        self.assertEqual(G.count_rule(199, ("A", "B", "C"))["status"], "unresolved: A closes")
        z = np.ones((3, 21))
        self.assertEqual(G.score_gates(z, z, z, 150, ("A",), usd_not_separable=False)["decision"], "not scored: count rule not met")

    def test_both_gates_needed(self):
        P = 250
        dn = np.full((P, 21), 100.0)
        up = dn.copy()
        up[:, 0] = 300.0  # strong bunching
        net = np.zeros((P, 21))  # no creator buying: Gate 3 fails
        r = G.score_gates(up, dn, net, 250, ("A",), n_boot=200, usd_not_separable=False)
        self.assertTrue(r["gate2_bunching"]["pass"])
        self.assertFalse(r["gate3_creator"]["pass"])
        self.assertEqual(r["decision"], "A closes: no return is read")


class TestPlaceboInfinities(unittest.TestCase):
    def test_minus_inf_placebo_cannot_inflate_gate2(self):
        dn = np.ones((1, 21))
        up = np.ones((1, 21))
        up[0, 0] = np.exp(0.2)
        up[0, 1:19] = np.exp(np.arange(18) - 8.5)  # finite placebo log ratios -8.5..8.5
        up[0, 19:21] = 0.0  # time below the cutoff, none above: log ratio -inf, counted as +inf
        self.assertAlmostEqual(G.gate2_stat(up, dn)[0], 0.2 - 1.0)


def plan_file(root, rows):
    p = os.path.join(root, "plan.txt")
    with open(p, "w") as f:
        f.write("".join(f"{d} 1033 {a} {b}\n" for d, a, b in rows))
    return p


class TestStepCompleteness(unittest.TestCase):
    A = ["2026-09-10", "2026-09-11"]
    B = ["2026-09-07", "2026-09-08", "2026-09-09"]
    C = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]

    def test_step_map(self):
        self.assertEqual(L.STEP_DAYS, {"A": tuple(self.A), "B": tuple(self.B), "C": tuple(self.C)})
        self.assertEqual(L.steps_from_days(self.A), ("A",))
        self.assertEqual(L.steps_from_days(["2026-09-11"]), ())
        self.assertEqual(L.scoring_steps(self.A + self.B), ("A", "B"))
        self.assertEqual(L.scoring_steps(self.A + self.B + self.C), ("A", "B", "C"))
        for bad in (["2026-09-11"], self.A + self.C, self.A + ["2026-09-07"], self.B):
            with self.assertRaises(L.IncompleteError):
                L.scoring_steps(bad)

    def test_days_fully_covered(self):
        d = "2026-09-10"
        u = [L.Unit("x", d, 0, 9, "v2"), L.Unit("y", d, 10, 19, "v2"), L.Unit("z", d, 20, 29, "v2")]
        with tempfile.TemporaryDirectory() as r:
            plan = L.read_plan(plan_file(r, [(d, 20, 29), (d, 0, 9), (d, 10, 19)]))
            L.check_days_complete(u, [d], plan)
            with self.assertRaises(L.IncompleteError):  # a planned unit is missing
                L.check_days_complete(u[:2], [d], plan)
            with self.assertRaises(L.IncompleteError):  # a unit not in the plan
                L.check_days_complete(u + [L.Unit("w", d, 30, 39, "v2")], [d], plan)
            with self.assertRaises(L.IncompleteError):  # the day is not in the plan
                L.check_days_complete(u, [d, "2026-09-11"], plan)
            gap = L.read_plan(plan_file(r, [(d, 0, 9), (d, 20, 29)]))
            with self.assertRaises(L.IncompleteError):  # the planned units leave a slot gap
                L.check_days_complete([u[0], u[2]], [d], gap)

    def test_cli_refuses_partial_scoring(self):
        with tempfile.TemporaryDirectory() as r:
            unit = standard_tape(r)
            plan = plan_file(r, [(DAY, 1000, 1999)])
            base = [sys.executable, os.path.join(HERE, "run_a.py"), "--out", os.path.join(r, "o"),
                    "--fee-config", fee_config(r), "--plan", plan, "--score-primary", "--confirm", run_a.CONFIRM]
            runs = {
                "units": ["--days", DAY, "--units", unit],
                "max_units": ["--days", DAY, "--cache", r, "--max-units", "1"],
                "step_incomplete": ["--days", DAY, "--cache", r],  # 09-10 alone is not Step A
            }
            for name, extra in runs.items():
                rc = subprocess.run(base + extra, capture_output=True, text=True)
                self.assertNotEqual(rc.returncode, 0, name)
                self.assertFalse(os.path.exists(os.path.join(r, "o", "gates.json")), name)
            ok = subprocess.run(base[:-3] + ["--days", DAY, "--units", unit], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)  # check mode still accepts --units



class TestRedTeamR1(unittest.TestCase):
    """CODE_REDTEAM.md R1-1 and R1-2: the gates are scored once, at the first step that meets the count rule,
    with the registered 10,000 resamples."""
    A = ["2026-09-10", "2026-09-11"]
    B = ["2026-09-07", "2026-09-08", "2026-09-09"]

    def _tape(self, r):
        # Step B days: empty units at low slots; Step A: 09-10 holds P1 (counted at 420) and one row where live
        # and fixed supply pick different tiers (so the supply rule is verified); 09-11 is empty.
        rows = [(d, 10 * i + 10, 10 * i + 19) for i, d in enumerate(self.B)]
        for d, a, b in rows:
            write_unit(r, a, b, [], [], day=d)
        events = migrate("P1", 1000) + [ev("BoostBuyAndBurnEvent", 1100, "boost1", pool="P1", boost_vault_remaining="0")]
        px = dict(swap(1700, "PX", 410, cfee=95), base_supply=1.05e15)  # live cap 430.5 -> 95 bps; fixed 410 -> 30
        write_unit(r, 1000, 1999, p1_rows() + [px], events, day="2026-09-10")
        write_unit(r, 2000, 2999, [], [], day="2026-09-11")
        rows += [("2026-09-10", 1000, 1999), ("2026-09-11", 2000, 2999)]
        return plan_file(r, rows)

    def _args(self, r, plan, days, extra=()):
        return ["--days", *days, "--cache", r, "--out", os.path.join(r, "o"), "--fee-config", fee_config(r),
                "--plan", plan, "--score-primary", "--confirm", run_a.CONFIRM, *extra]

    def test_no_second_look_after_the_count_rule_is_met(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as r, mock.patch.object(G, "COUNT_BAR", 1):
            plan = self._tape(r)
            with self.assertRaises(SystemExit):  # Step A already met the count rule: A+B is a second look
                run_a.main(self._args(r, plan, self.A + self.B))
            self.assertFalse(os.path.exists(os.path.join(r, "o", "gates.json")))
            self.assertEqual(run_a.main(self._args(r, plan, self.A, ["--n-boot", "10000"])), 0)  # the one look
            self.assertTrue(os.path.exists(os.path.join(r, "o", "gates.json")))
        with tempfile.TemporaryDirectory() as r, mock.patch.object(G, "COUNT_BAR", 2):
            plan = self._tape(r)  # Step A short (1 pool < 2): adding Step B is the registered next step
            self.assertEqual(run_a.main(self._args(r, plan, self.A + self.B)), 0)

    def test_scoring_refuses_a_changed_resample_count(self):
        with tempfile.TemporaryDirectory() as r:
            plan = self._tape(r)
            with self.assertRaises(SystemExit):
                run_a.main(self._args(r, plan, self.A, ["--n-boot", "200"]))
            self.assertFalse(os.path.exists(os.path.join(r, "o", "gates.json")))


class TestAmendment2(unittest.TestCase):
    """research/edge-a/AMENDMENT_2.md rulings (CODE_REDTEAM.md R1-14 onward)."""

    def test_q5_registered_resamples_and_seed_for_both_gates(self):
        # R1-14: Q5 registers 10,000 pool resamples with seed 20261009; Gate 3 used seed + 1
        self.assertEqual((G.DEFAULT_B, G.DEFAULT_SEED), (10_000, 20261009))
        rng = np.random.default_rng(0)
        P = 40
        up, dn = rng.uniform(50, 150, (P, 21)), rng.uniform(50, 150, (P, 21))
        net = rng.normal(0, 1, (P, 21))
        r = G.score_gates(up, dn, net, 250, ("A",), n_boot=300, usd_not_separable=False)
        g2 = G.pool_bootstrap(G.gate2_stat, [up, dn], 300, 20261009)
        g3 = G.pool_bootstrap(G.gate3_stat, [net, up + dn], 300, 20261009)
        self.assertEqual(r["gate2_bunching"]["lo"], g2["lo"])
        self.assertEqual(r["gate3_creator"]["lo"], g3["lo"])

    def test_q11_verdict_reads_count_row_6(self):
        # R1-15: a gate pass is recorded "not separable from a USD level" when count row 6 flags 420 SOL within 5% of
        # $50k or $100k on every tape day, and then no return test runs
        flags = run_a.usd_separability({"2026-09-10": 119.26, "2026-09-11": (119.0, 118.0, 120.0)})
        self.assertTrue(flags["not_separable"])
        self.assertFalse(run_a.usd_separability({"2026-09-10": 119.26, "2026-09-11": 150.0})["not_separable"])
        P = 250
        dn = np.full((P, 21), 100.0)
        up = dn.copy()
        up[:, 0] = 300.0
        net = np.zeros((P, 21))
        net[:, 0] = 50.0
        ok = G.score_gates(up, dn, net, 250, ("A",), n_boot=200, usd_not_separable=False)
        self.assertTrue(ok["gate2_bunching"]["pass"] and ok["gate3_creator"]["pass"])
        self.assertTrue(ok["return_test_may_run"])
        ns = G.score_gates(up, dn, net, 250, ("A",), n_boot=200, usd_not_separable=True)
        self.assertFalse(ns["return_test_may_run"])
        self.assertIn("not separable from a USD level", ns["decision"])
        for missing in ({}, {"usd_not_separable": None}):   # row 6 not read: the verdict is never given
            with self.assertRaises((TypeError, ValueError)):
                G.score_gates(up, dn, net, 250, ("A",), n_boot=200, **missing)


if __name__ == "__main__":
    unittest.main()
