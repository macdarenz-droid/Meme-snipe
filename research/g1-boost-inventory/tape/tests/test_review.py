"""Review findings 1, 3 and 4: guards, required validation days, per-day minimum counts."""
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from synth import Synth  # noqa: E402
from g1lib import guard  # noqa: E402
from g1lib.load import find_units  # noqa: E402
from g1lib.stats import primary  # noqa: E402

DAY = "2026-09-11"


class Guards(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="g1g_")
        self.addCleanup(shutil.rmtree, self.root)
        s = Synth()
        s.create(100, 1, "A", "c")
        for a, b in ((100, 199), (200, 299), (300, 399)):
            s.write(self.root, DAY, a, b)
        self.plan_rows = [(100, 199), (200, 299), (300, 399)]

    def plan_file(self, rows, day=DAY):
        p = os.path.join(self.root, "plan.txt")
        with open(p, "w") as f:
            for a, b in rows:
                f.write(f"{day} 1033 {a} {b}\n")
        return p, guard.sha_file(p)

    def test_real_plan_sha(self):
        self.assertEqual(guard.sha_file(guard.PLAN_PATH), guard.PLAN_SHA)
        plan = guard.load_plan()
        self.assertEqual(set(plan), set(guard.DISCOVERY_DAYS))

    def test_plan_sha_and_gaps(self):
        p, sha = self.plan_file(self.plan_rows)
        self.assertEqual(guard.load_plan(p, sha)[DAY], self.plan_rows)
        with self.assertRaises(guard.GuardError):
            guard.load_plan(p, "0" * 64)
        p, sha = self.plan_file([(100, 199), (300, 399)])
        with self.assertRaises(guard.GuardError):
            guard.load_plan(p, sha)

    def test_units_must_equal_the_plan(self):
        p, sha = self.plan_file(self.plan_rows)
        plan = guard.load_plan(p, sha)
        self.assertEqual(len(find_units([self.root], plan=plan)), 3)
        one = os.path.join(self.root, DAY, "100-199")
        with self.assertRaises(guard.GuardError):
            find_units([one], plan=plan)                              # a subset
        self.assertEqual(len(find_units([one], plan=plan, allow_subset=True)), 1)
        with self.assertRaises(guard.GuardError):
            find_units([self.root])                                   # default: the frozen Step A plan
        with self.assertRaises(guard.GuardError):
            find_units([self.root], plan={DAY: [(100, 199), (200, 299)]})   # a unit outside the plan
        with self.assertRaises(guard.GuardError):
            find_units([self.root], plan={"2026-09-10": [(1, 2)]})          # a day without plan rows

    def test_manifest(self):
        p, sha = self.plan_file(self.plan_rows)
        units = find_units([self.root], plan=guard.load_plan(p, sha))
        man = guard.make_manifest(units, sha, dev=False)
        out = os.path.join(self.root, "out")
        os.makedirs(out)
        dec = os.path.join(out, "decisions.csv")
        open(dec, "w").write("x\n")
        man["decisions_sha"] = guard.sha_file(dec)
        guard.verify(man, units, files={"decisions_sha": dec})
        with self.assertRaises(guard.GuardError):
            guard.verify({**man, "code_hash": "0"}, units)
        with self.assertRaises(guard.GuardError):
            guard.verify(man, units[:2])
        with self.assertRaises(guard.GuardError):
            guard.verify({**man, "dev_subset": True}, units)
        guard.verify({**man, "dev_subset": True}, units, allow_dev=True)
        open(dec, "w").write("y\n")
        with self.assertRaises(guard.GuardError):
            guard.verify(man, units, files={"decisions_sha": dec})
        with open(os.path.join(units[0].path, "B.csv.zst"), "ab") as f:
            f.write(b"\0")
        with self.assertRaises(guard.GuardError):
            guard.verify(man, units)

    def test_score_guard(self):
        code = guard.code_hash()
        fr = {"code_hash": code, "days": list(guard.DISCOVERY_DAYS)}
        man = {"code_hash": code, "days": list(guard.VALIDATION_DAYS)}
        guard.check_score(man, fr, "validation", guard.VALIDATION_DAYS)
        with self.assertRaises(guard.GuardError):
            guard.check_score(man, {**fr, "code_hash": "0"}, "validation", guard.VALIDATION_DAYS)
        with self.assertRaises(guard.GuardError):
            guard.check_score(man, {**fr, "days": [DAY]}, "validation", guard.VALIDATION_DAYS)
        with self.assertRaises(guard.GuardError):
            guard.check_score(man, fr, "validation", guard.VALIDATION_DAYS[:2])
        with self.assertRaises(guard.GuardError):
            guard.check_score({**man, "days": list(guard.DISCOVERY_DAYS)}, fr, "validation", guard.VALIDATION_DAYS)


class RequiredDays(unittest.TestCase):
    def test_all_validation_days_present(self):
        rng = np.random.default_rng(4)
        rows = [{"day": d, "mint": f"{d}{i}", "ret": rng.normal(0.05, 0.05), "filled": True}
                for d in guard.VALIDATION_DAYS[:2] for i in range(200)]
        t = pd.DataFrame(rows)
        s0 = t.assign(ret=0.0)
        self.assertEqual(primary(t, control=s0)["verdict"], "pass")       # without the requirement
        r = primary(t, control=s0, required_days=guard.VALIDATION_DAYS)
        self.assertEqual(r["missing_days"], ["2026-09-09"])
        self.assertNotEqual(r["verdict"], "pass")


class PerDayMinimum(unittest.TestCase):
    days = ["2026-09-10", "2026-09-11"]

    def trig(self, counts):
        rows = []
        for day, n in zip(self.days, counts):
            for i in range(n):
                rows.append({"mint": f"{day}{i}", "mint_c": len(rows), "day": day, "catchable": True, "t0": 1000,
                             "create_slot": 900, "R": 0.1 if i % 2 == 0 else 0.9, "hc_coverage": 1.0, "hc_reason": "",
                             "Z": -1.0 if i % 2 == 0 else 1.0, "lam": float(i % 7), "cap_reason": ""})
        return pd.DataFrame(rows)

    def test_amendment_4_pooled_and_40_percent_floor(self):
        from g1lib.gate import cap_gate, hc_gate
        # filtered = half: 170 and 40 a day. Pooled 210 >= 200 and 40 >= 40% of 100: passes (a per-day minimum failed it)
        t = self.trig([340, 80])
        hc = hc_gate(t, {}, self.days)
        self.assertEqual(hc["c_count_gate"]["pooled"], 210)
        self.assertTrue(hc["c_pass"])
        self.assertTrue(cap_gate(t, {}, True, self.days)["d_pass"])
        # one day carries the pooled count (200 + 30 = 230 >= 200; average 115) but 30 < 40: fails
        t = self.trig([400, 60])
        hc = hc_gate(t, {}, self.days)
        self.assertFalse(hc["c_pass"])
        self.assertEqual(hc["c_count_gate"]["days_ok"], {"2026-09-10": True, "2026-09-11": False})
        t = self.trig([400, 30])             # cap (d): 200 + 15, floor 20
        self.assertFalse(cap_gate(t, {}, True, self.days)["d_pass"])
        # every day above the floor but the pooled count short: fails
        self.assertFalse(hc_gate(self.trig([180, 180]), {}, self.days)["c_pass"])
        # a missing day counts as 0
        self.assertFalse(hc_gate(self.trig([440, 0]), {}, self.days)["c_pass"])


class PartialDays(unittest.TestCase):
    def test_no_verdict_anywhere(self):
        import g1
        res = {"G1_0": {"passes": False, "kills": ["x"], "kills_by_day": {"2026-09-10": ["x"]}},
               "G1_HC": {"c_pass": True, "c_count_gate": {"passes": True, "days_ok": {"2026-09-10": True}}},
               "G1_CAP": {"d_pass": True, "passes": True}}
        out = g1.strip_verdict(res)
        self.assertIsNone(out["G1_0"]["passes"])
        self.assertIsNone(out["G1_0"]["kills"])
        self.assertIsNone(out["G1_0"]["kills_by_day"])
        self.assertIsNone(out["G1_HC"]["c_count_gate"]["passes"])
        self.assertIsNone(out["G1_HC"]["c_count_gate"]["days_ok"])
        self.assertIsNone(out["G1_CAP"]["passes"])
        self.assertTrue(out["verdict"].startswith("none"))



class BoostShareRule(unittest.TestCase):
    def test_exactly_half_below_25pct_kills(self):
        from g1lib.gate import boost_share_kills
        self.assertTrue(boost_share_kills(0.5, 0.2))
        self.assertTrue(boost_share_kills(0.1, 0.5))
        self.assertFalse(boost_share_kills(0.49, 0.2))
        self.assertFalse(boost_share_kills(float("nan"), float("nan")))

    def test_spent_after_m_plus_d_is_strict(self):
        from types import SimpleNamespace
        from g1lib import params as P
        from g1lib.gate import boost_rows
        m, pool = 1000, 7
        bb = pd.DataFrame({"slot": [m + P.D, m + P.D + 1], "tx_idx": [1, 1], "used": [400, 100], "remaining": [600, 0],
                           "base_amount_burned": [10, 10]})
        mkt = SimpleNamespace(boosts=lambda p: bb, boost_budget={pool: 1000})
        tape = SimpleNamespace(segment_of=lambda s: (0, 10 ** 9), names=SimpleNamespace(name=lambda c: str(c)),
                               pool_of=lambda p: pd.DataFrame(columns=["slot", "tx_idx", "is_boost", "min_base_amount_out"]),
                               F_boost=pd.DataFrame(), events={"BoostBuyAndBurnEvent": pd.DataFrame()})
        r = boost_rows(mkt, tape, 1, {"slot": m, "pool_c": pool})
        self.assertAlmostEqual(r["share_after_mD"], 0.1)          # the slice in slot m + D does not count
        self.assertEqual(r[f"unspent_at_m+{P.D}"], 600)



class G10PooledAndDays(unittest.TestCase):
    """Amendment 5: pooled statistics, and no single day may trigger a kill alone."""
    days = ["2026-09-10", "2026-09-11"]

    def events(self, catch=(150, 150), slots=((100, 150), (100, 50)), shares=((1.0, 30), (1.0, 30))):
        rows = []
        for day, n, (sl, nm) in zip(self.days, catch, slots):
            for i in range(max(n, nm)):
                rows.append({"day": day, "t0": 1000, "catchable": i < n, "m": 1000 + sl if i < nm else -1})
        trig = pd.DataFrame(rows)
        g = pd.DataFrame([{"day": day, "share_after_mD": sh} for day, (sh, k) in zip(self.days, shares) for _ in range(k)])
        return trig, g, g

    def test_pooled_pass(self):
        from g1lib.gate import g1_0_kills
        kills, by_day = g1_0_kills(*self.events(), self.days)
        self.assertEqual(kills, [])

    def test_one_day_alone_triggers_the_time_kill(self):
        from g1lib.gate import g1_0_kills
        # pooled median slots t0 -> m is 100 (200 of 250 migrating triggers), but 09-11 alone has median 5 <= D
        kills, by_day = g1_0_kills(*self.events(slots=((100, 200), (5, 50))), self.days)
        self.assertEqual(by_day["2026-09-11"], ["median slots t0 to m <= D"])
        self.assertEqual(kills, ["2026-09-11: median slots t0 to m <= D"])

    def test_one_day_alone_triggers_the_count_kill(self):
        from g1lib.gate import g1_0_kills
        kills, _ = g1_0_kills(*self.events(catch=(190, 30)), self.days)       # pooled 220 >= 200; 30 < 40
        self.assertEqual(kills, ["2026-09-11: catchable triggers below 40% of 100 on this day"])
        kills, _ = g1_0_kills(*self.events(catch=(150, 40)), self.days)       # pooled 190 < 200
        self.assertEqual(kills, ["fewer than 100 catchable triggers a day (pooled)"])

    def test_one_day_alone_triggers_the_share_kill(self):
        from g1lib.gate import g1_0_kills
        # pooled: 10 of 40 graduates below 25%; 09-11 alone: all 10 below
        kills, _ = g1_0_kills(*self.events(shares=((1.0, 30), (0.0, 10))), self.days)
        self.assertEqual(kills, ["2026-09-11: BOOST quote after m + D under 25% on most graduates"])


if __name__ == "__main__":
    unittest.main()
