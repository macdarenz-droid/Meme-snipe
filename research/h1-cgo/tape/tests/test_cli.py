"""End to end through run.py on a synthetic unit written in the tape's file layout (zstd CSV and JSONL)."""
import json
import pathlib
import os
import tempfile
import unittest

import pandas as pd
import zstandard

import run as R
from tests.synth import blocks, t_of
from tests.test_features import world


def _write_csv(path, df):
    with open(path, "wb") as f:
        f.write(zstandard.ZstdCompressor().compress(df.to_csv(index=False).encode()))


class CLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = os.path.join(self.tmp.name, "2026-09-11", "0-120000", "research")
        os.makedirs(root)
        w = world()
        _write_csv(os.path.join(root, "S_curve.csv.zst"), w["curve"])
        _write_csv(os.path.join(root, "S_amm.csv.zst"), w["amm"])
        _write_csv(os.path.join(root, "T.csv.zst"), w["t"])
        _write_csv(os.path.join(root, "T_coverage.csv.zst"), w["tcov"])
        _write_csv(os.path.join(root, "B.csv.zst"), blocks(120_000))
        ev = [dict(event="CreateEvent", program="pump", slot=10, block_time=t_of(10),
                   fields=dict(mint="M", bonding_curve="BC", quote_mint="11111111111111111111111111111111",
                               is_mayhem_mode="0", is_cashback_enabled="0")),
              dict(event="CompletePumpAmmMigrationEvent", program="pump", slot=1000, block_time=t_of(1000),
                   fields=dict(mint="M", pool="P"))]
        with open(os.path.join(root, "E.jsonl.zst"), "wb") as f:
            f.write(zstandard.ZstdCompressor().compress("".join(json.dumps(e) + "\n" for e in ev).encode()))
        self.unit = os.path.dirname(root)
        self.out = os.path.join(self.tmp.name, "out")

    def tearDown(self):
        self.tmp.cleanup()

    def test_stages(self):
        R.main(["features", "--units", self.unit, "--decision-days", "2026-09-11", "--out", self.out])
        f = pd.read_csv(os.path.join(self.out, "features.csv"))
        self.assertGreater(len(f), 5)
        self.assertTrue(f.eligible.any())
        meta = json.loads(pathlib.Path(os.path.join(self.out, "features_meta.json")).read_text())
        self.assertEqual(len(meta["inputs"]), 6)
        self.assertIn("h1cgo/features.py", meta["code"])
        R.main(["gate0", "--out", self.out])
        g = json.loads(pathlib.Path(os.path.join(self.out, "gate0.json")).read_text())
        self.assertFalse(g["a_pass"])  # one coin is far below 150 a day
        R.main(["outcomes", "--units", self.unit, "--out", self.out])
        o = pd.read_csv(os.path.join(self.out, "outcomes.csv"))
        self.assertEqual(set(o.status), {"ok"})
        with self.assertRaises(SystemExit):  # the gate closed: no freeze
            R.main(["freeze", "--out", self.out])
        with self.assertRaises(SystemExit):
            R.main(["score", "--out", self.out])

    def test_refuses_wall_and_mixed_days(self):
        with self.assertRaises(ValueError):
            R.main(["features", "--units", os.path.join(self.tmp.name, "2026-09-12", "1-2"), "--decision-days",
                    "2026-09-11", "--out", self.out])
        with self.assertRaises(SystemExit):
            R.main(["features", "--units", self.unit, "--decision-days", "2026-09-11", "2026-09-08", "--out", self.out])


if __name__ == "__main__":
    unittest.main()
