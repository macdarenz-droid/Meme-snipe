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

    def test_hc_c_and_cap_d_use_every_day(self):
        from g1lib.gate import cap_gate, hc_gate
        t = self.trig([340, 80])             # filtered (half): 170 and 40 a day, average 105
        hc = hc_gate(t, {}, self.days)
        self.assertEqual(hc["c_min_day"], 40)
        self.assertFalse(hc["c_pass"])
        cap = cap_gate(t, {}, True, self.days)
        self.assertEqual(cap["d_min_day"], 40)
        self.assertFalse(cap["d_pass"])
        ok = self.trig([220, 220])
        self.assertTrue(hc_gate(ok, {}, self.days)["c_pass"])


if __name__ == "__main__":
    unittest.main()
