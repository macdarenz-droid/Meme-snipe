"""End to end through run.py on synthetic units written in the tape's file layout (zstd CSV and JSONL), with a
synthetic unit plan: the completeness guard, unit and hash matching between stages, and the frozen-code check."""
import json
import os
import pathlib
import tempfile
import unittest

import pandas as pd
import zstandard

import run as R
from tests.synth import blocks, t_of
from tests.test_features import world

DAY = "2026-09-11"


def _write_csv(path, df):
    with open(path, "wb") as f:
        f.write(zstandard.ZstdCompressor().compress(df.to_csv(index=False).encode()))


def _events():
    return [dict(event="CreateEvent", program="pump", slot=10, block_time=t_of(10),
                 fields=dict(mint="M", bonding_curve="BC", quote_mint="11111111111111111111111111111111",
                             is_mayhem_mode="0", is_cashback_enabled="0")),
            dict(event="CompletePumpAmmMigrationEvent", program="pump", slot=1000, block_time=t_of(1000),
                 fields=dict(mint="M", pool="P"))]


def write_unit(root, day, a, b, last_block=None):
    """The synthetic world's rows with slot in [a, b], as one unit directory."""
    d = os.path.join(root, day, f"{a}-{b}", "research")
    os.makedirs(d)
    w = world()
    cut = lambda df: df[(df.slot.astype(int) >= a) & (df.slot.astype(int) <= b)]
    for name in ("curve", "amm", "t"):
        _write_csv(os.path.join(d, {"curve": "S_curve", "amm": "S_amm", "t": "T"}[name] + ".csv.zst"), cut(w[name]))
    _write_csv(os.path.join(d, "T_coverage.csv.zst"), w["tcov"])
    bl = blocks(min(b, last_block if last_block is not None else b), a)
    _write_csv(os.path.join(d, "B.csv.zst"), bl)
    ev = [e for e in _events() if a <= e["slot"] <= b]
    with open(os.path.join(d, "E.jsonl.zst"), "wb") as f:
        f.write(zstandard.ZstdCompressor().compress("".join(json.dumps(e) + "\n" for e in ev).encode()))
    return os.path.dirname(d)


def read_json(p):
    return json.loads(pathlib.Path(p).read_text())


class CLI(unittest.TestCase):
    RANGES = [(0, 39_999), (40_000, 79_999), (80_000, 120_000)]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "cache")
        self.units = [write_unit(self.root, DAY, a, b) for a, b in self.RANGES]
        self.plan = os.path.join(self.tmp.name, "plan.txt")
        pathlib.Path(self.plan).write_text("".join(f"{DAY} 1 {a} {b}\n" for a, b in reversed(self.RANGES)))
        self.out = os.path.join(self.tmp.name, "out")

    def tearDown(self):
        self.tmp.cleanup()

    def features(self, units, days=(DAY,), extra=()):
        R.main(["features", "--units", *units, "--decision-days", *days, "--out", self.out, "--plan", self.plan, *extra])

    def refused(self, fn, text):
        with self.assertRaises(SystemExit) as c:
            fn()
        self.assertIn(text, str(c.exception.code))

    def test_stages(self):
        self.features(self.units)
        f = pd.read_csv(os.path.join(self.out, "features.csv"))
        self.assertGreater(len(f), 5)
        self.assertTrue(f.eligible.any())
        meta = read_json(os.path.join(self.out, "features_meta.json"))
        self.assertEqual(len(meta["inputs"]), 18)
        self.assertIn("h1cgo/features.py", meta["code"])
        R.main(["gate0", "--out", self.out])
        self.assertFalse(read_json(os.path.join(self.out, "gate0.json"))["a_pass"])  # one coin, far below 150 a day
        R.main(["outcomes", "--units", *self.units, "--out", self.out])
        self.assertEqual(set(pd.read_csv(os.path.join(self.out, "outcomes.csv")).status), {"ok"})
        self.refused(lambda: R.main(["freeze", "--out", self.out]), "gate H1-CGO-0 passed")
        self.refused(lambda: R.main(["score", "--out", self.out]), "--frozen")

    def test_features_read_boost_events(self):
        e = os.path.join(self.units[0], "research", "E.jsonl.zst")
        ev = _events() + [dict(event="BoostBuyAndBurnEvent", signature="", outer_ix=0, slot=1100, fields=dict(pool="P"))]
        with open(e, "wb") as f:
            f.write(zstandard.ZstdCompressor().compress("".join(json.dumps(x) + "\n" for x in ev).encode()))
        self.features(self.units)
        meta = read_json(os.path.join(self.out, "features_meta.json"))
        self.assertEqual(meta["boost_events"], 1)
        self.assertGreater(meta["protocol_rows"], 0)  # the synthetic rows share the event's (signature, outer_ix, pool)

    # 1. Step A completeness
    def test_missing_middle_unit(self):
        self.refused(lambda: self.features([self.units[0], self.units[2]]), "missing units [(40000, 79999)]")

    def test_day_missing_its_last_unit(self):
        self.refused(lambda: self.features(self.units[:2]), "missing units [(80000, 120000)]")

    def test_unit_absent_on_disk(self):
        os.remove(os.path.join(self.units[1], "research", "S_amm.csv.zst"))
        self.refused(lambda: self.features(self.units), "lacks ['S_amm.csv.zst']")

    def test_unit_from_another_day(self):
        other = write_unit(self.root, "2026-09-10", 200_000, 200_010)
        self.refused(lambda: self.features(self.units + [other]), "outside this stage's days")

    def test_day_without_a_plan(self):
        self.refused(lambda: self.features(self.units, days=(DAY, "2026-09-10")), "2026-09-10 has no planned units")

    def test_later_stages_recheck_completeness(self):
        self.features(self.units)
        meta_p = os.path.join(self.out, "features_meta.json")
        meta = read_json(meta_p)
        meta["unit_records"] = meta["unit_records"][:2]
        pathlib.Path(meta_p).write_text(json.dumps(meta))
        self.refused(lambda: R.main(["gate0", "--out", self.out]), "incomplete input")
        pathlib.Path(self.plan).write_text(f"{DAY} 1 0 120000\n")
        self.refused(lambda: R.main(["gate0", "--out", self.out]), "plan changed")

    def test_gate0_refuses_empty_features(self):
        tmp2 = os.path.join(self.tmp.name, "short")
        u = write_unit(tmp2, DAY, 0, 120_000, last_block=5_000)  # no hour closes after migration + 60 min
        pathlib.Path(self.plan).write_text(f"{DAY} 1 0 120000\n")
        self.features([u])
        self.refused(lambda: R.main(["gate0", "--out", self.out]), "no decision points")

    # 2. outcomes read the same units, with the same hashes
    def test_outcomes_require_the_feature_units(self):
        self.features(self.units)
        self.refused(lambda: R.main(["outcomes", "--units", *self.units[:2], "--out", self.out]), "differ from the units")
        with open(os.path.join(self.units[2], "research", "S_amm.csv.zst"), "ab") as f:
            f.write(b"\0")
        self.refused(lambda: R.main(["outcomes", "--units", *self.units, "--out", self.out]), "changed since")

    # 4. score refuses code that differs from the frozen code
    def test_score_refuses_other_code(self):
        self.features(self.units)
        fz = os.path.join(self.tmp.name, "frozen.json")
        pathlib.Path(fz).write_text(json.dumps(dict(verdict="continue", sign="high", code={"run.py": "0" * 64},
                                                    breakpoints=dict(p20=0, p80=1))))
        self.refused(lambda: R.main(["score", "--out", self.out, "--frozen", fz]), "code differs")

    def test_refuses_wall_and_mixed_days(self):
        with self.assertRaises(ValueError):
            self.features([os.path.join(self.root, "2026-09-12", "1-2")])
        self.refused(lambda: self.features(self.units, days=(DAY, "2026-09-08")), "all discovery or all validation")


if __name__ == "__main__":
    unittest.main()
