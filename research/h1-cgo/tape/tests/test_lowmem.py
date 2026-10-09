"""The low-memory reader (`--reader lowmem`, the default) against the original reader (`--reader direct`): every file
the stages write must be byte-identical, on the existing synthetic fixtures and on random multi-unit tapes read in
small chunks. Also: the compact string store round-trips exactly, and the preparation stage never loads the outcome
or statistics code."""
import filecmp
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

import run as R
from h1cgo import lowmem as LM
from h1cgo import tapeio
from tests.synth_tape import make_tape
from tests.test_cli import DAY, write_unit

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DISC = ["2026-09-10", "2026-09-11"]
VAL = ["2026-09-07", "2026-09-08", "2026-09-09"]


class Chunked:
    """Reads every table in chunks of `n` rows (exercises chunk boundaries)."""

    def __init__(self, n):
        self.n = n

    def __enter__(self):
        self.old = tapeio.read_table_chunks.__defaults__
        tapeio.read_table_chunks.__defaults__ = (self.n,)

    def __exit__(self, *a):
        tapeio.read_table_chunks.__defaults__ = self.old


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._registered = dict(R.tapeio.REGISTERED_PLANS)

    def tearDown(self):
        R.tapeio.REGISTERED_PLANS.clear()
        R.tapeio.REGISTERED_PLANS.update(self._registered)
        self.tmp.cleanup()

    def register(self, plan, days):
        R.tapeio.REGISTERED_PLANS[R.tapeio.sha256_file(plan)] = tuple(days)

    def stages(self, units, plan, days, reader, out, gate=True, freeze=False, frozen=None):
        R.main(["features", "--units", *units, "--decision-days", *days, "--out", out, "--plan", plan,
                "--reader", reader])
        if gate:
            R.main(["gate0", "--out", out])
        R.main(["outcomes", "--units", *units, "--out", out, "--reader", reader])
        if freeze:
            pathlib.Path(os.path.join(out, "gate0.json")).write_text(json.dumps({"passed": True}))
            R.main(["freeze", "--out", out])
        if frozen:
            R.main(["score", "--out", out, "--frozen", frozen])

    def same_dirs(self, a, b, expect):
        names = sorted(os.listdir(a))
        self.assertEqual(names, sorted(os.listdir(b)))
        for x in expect:
            self.assertIn(x, names)
        for n in names:
            self.assertTrue(filecmp.cmp(os.path.join(a, n), os.path.join(b, n), shallow=False), n)
        return names


class Fixtures(Base):
    """The CLI fixture world (tests/test_cli.py), with and without a BOOST event."""

    def run_world(self, boost):
        root = os.path.join(self.tmp.name, f"cache{boost}")
        ranges = [(0, 39_999), (40_000, 79_999), (80_000, 120_000)]
        units = [write_unit(root, DAY, a, b) for a, b in ranges]
        if boost:
            import zstandard
            from tests.test_cli import _events
            ev = _events() + [dict(event="BoostBuyAndBurnEvent", signature="", outer_ix=0, slot=1100,
                                   fields=dict(pool="P"))]
            with open(os.path.join(units[0], "research", "E.jsonl.zst"), "wb") as f:
                f.write(zstandard.ZstdCompressor().compress("".join(json.dumps(x) + "\n" for x in ev).encode()))
        plan = os.path.join(root, "plan.txt")
        pathlib.Path(plan).write_text("".join(f"{DAY} 1 {a} {b}\n" for a, b in ranges))
        self.register(plan, (DAY,))
        outs = []
        for reader in ("direct", "lowmem"):
            out = os.path.join(self.tmp.name, f"out{boost}{reader}")
            with Chunked(3):
                self.stages(units, plan, [DAY], reader, out)
            outs.append(out)
        self.same_dirs(*outs, ["features.csv", "universe.csv", "features_meta.json", "gate0.json", "outcomes.csv",
                               "flows.csv"])

    def test_fixture_world_identical(self):
        self.run_world(False)

    def test_fixture_world_with_boost_identical(self):
        self.run_world(True)


class RandomTapes(Base):
    """Two random discovery tapes (both days, several units each) through features, gate0, outcomes and freeze, and a
    random validation tape through score, with each reader; chunks of 37 rows."""

    def discovery(self, seed):
        root = os.path.join(self.tmp.name, f"disc{seed}")
        units, plan = make_tape(root, DISC, units_per_day=3, coins_per_day=8, seed=seed)
        self.register(plan, DISC)
        outs = []
        for reader in ("direct", "lowmem"):
            out = os.path.join(self.tmp.name, f"d{seed}{reader}")
            with Chunked(37):
                self.stages(units, plan, DISC, reader, out, freeze=True)
            outs.append(out)
        names = self.same_dirs(*outs, ["features.csv", "universe.csv", "features_meta.json", "gate0.json",
                                       "outcomes.csv", "flows.csv", "frozen.json"])
        f = pd.read_csv(os.path.join(outs[1], "features.csv"))
        self.assertGreater(len(f), 50)
        self.assertGreater(int(f.eligible.sum()), 5)
        self.assertGreater(len(pd.read_csv(os.path.join(outs[1], "outcomes.csv"))), 20)
        meta = json.loads(pathlib.Path(os.path.join(outs[1], "features_meta.json")).read_text())
        self.assertGreater(meta["round_trips"], 50)
        self.assertGreater(meta["protocol_rows"], 0)
        self.assertGreater(meta["boost_events"], 0)
        return outs, names

    def test_random_tape_seed_1(self):
        self.discovery(1)

    def test_random_tape_seed_2_and_score(self):
        outs, _ = self.discovery(2)
        frozen = json.loads(pathlib.Path(os.path.join(outs[1], "frozen.json")).read_text())
        frozen["verdict"] = "continue"  # test only: lets score run on the synthetic validation tape
        fz = os.path.join(self.tmp.name, "frozen.json")
        pathlib.Path(fz).write_text(json.dumps(frozen))
        root = os.path.join(self.tmp.name, "val")
        units, plan = make_tape(root, VAL, units_per_day=2, seed=3)
        self.register(plan, VAL)
        vouts = []
        for reader in ("direct", "lowmem"):
            out = os.path.join(self.tmp.name, f"v{reader}")
            with Chunked(37):
                self.stages(units, plan, VAL, reader, out, gate=False, frozen=fz)
            vouts.append(out)
        self.same_dirs(*vouts, ["features.csv", "outcomes.csv", "flows.csv", "primary.json", "secondary.json"])


class Store(unittest.TestCase):
    def test_round_trip_exact(self):
        vals = ["", "0", "-0", "007", " 7", "1_0", "12", "-5", "99999999999999999999", "9223372036854775807", "NA",
                "nan", "abc", "1.5", "+3", ""]
        st = LM.Store()
        cols = {"a": vals, "b": [str(i) for i in range(len(vals))], "c": [""] * len(vals),
                "d": ["x" if i % 2 else "" for i in range(len(vals))]}
        df = pd.DataFrame(cols, dtype=object)
        st.put("t", "k", df.iloc[:7])
        st.put("t", "k", df.iloc[7:])
        back = pd.concat(list(st.frames("t", "k")), ignore_index=True)
        self.assertEqual(back.to_dict("list"), df.to_dict("list"))
        self.assertTrue(all(isinstance(x, str) for c in back for x in back[c]))
        self.assertEqual(list(st.frames("t", "k")), [])  # freed once read

    def test_round_trips_codes_match_habits(self):
        from h1cgo import habits as HB
        rng = np.random.default_rng(5)
        n = 400
        ev = pd.DataFrame(dict(owner=rng.choice(["a", "b", "c", "d"], n), mint=rng.choice(["m", "n"], n),
                               slot=rng.integers(0, 40, n).astype("int64"), tx=rng.integers(0, 3, n).astype("int64"),
                               ev=rng.integers(-1, 2, n).astype("int64"), time=rng.integers(0, 10**6, n).astype("int64"),
                               kind=rng.choice(["o", "c"], n)))
        rt = HB.round_trips(ev)
        s = LM.Strings()
        o, cs, hs = LM.round_trips_codes(s.codes(ev.owner.to_numpy(object)), s.codes(ev.mint.to_numpy(object)),
                                         ev.slot.to_numpy(), ev.tx.to_numpy(), ev.ev.to_numpy(), ev.time.to_numpy(),
                                         (ev.kind == "o").to_numpy())
        got = sorted(zip(s.lookup(o), cs.tolist(), hs.tolist()))
        self.assertEqual(got, sorted(zip(rt.owner, rt.close_slot.tolist(), rt.hold_s.tolist())))
        old, new = HB.Habits(rt), LM.CompactHabits(o, cs, hs, s.code_of)
        for w in ["a", "b", "c", "d", "zz"]:
            for slot in range(-1, 42):
                self.assertEqual(old.median_before(w, slot), new.median_before(w, slot))


class PrepOnly(unittest.TestCase):
    def test_features_stage_never_loads_outcomes_or_stats(self):
        """A features run (the preparation stage, the only stage run on real tape before scoring) leaves
        h1cgo.outcomes and h1cgo.stats out of sys.modules."""
        code = ("import sys, json; sys.path.insert(0, %r)\n"
                "import run as R\n"
                "try:\n    R.main(['features', '--units', '--decision-days', '2026-09-11', '--out', %r])\n"
                "except SystemExit:\n    pass\n"
                "from h1cgo import features\n"
                "print(json.dumps(sorted(m for m in sys.modules if m.startswith('h1cgo'))))\n")
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, "-c", code % (HERE, d)], capture_output=True, text=True, cwd=HERE)
        mods = json.loads(p.stdout.strip().splitlines()[-1])
        self.assertIn("h1cgo.features", mods)
        self.assertNotIn("h1cgo.outcomes", mods)
        self.assertNotIn("h1cgo.stats", mods)

    def test_features_stage_end_to_end_without_outcome_code(self):
        with tempfile.TemporaryDirectory() as d:
            units, plan = make_tape(os.path.join(d, "c"), DISC, units_per_day=2, seed=7)
            code = ("import sys, json; sys.path.insert(0, %r)\n"
                    "import run as R\n"
                    "R.tapeio.REGISTERED_PLANS[R.tapeio.sha256_file(%r)] = %r\n"
                    "R.main(['features', '--units', *%r, '--decision-days', *%r, '--out', %r, '--plan', %r])\n"
                    "print(json.dumps(sorted(m for m in sys.modules if m.startswith('h1cgo'))))\n")
            p = subprocess.run([sys.executable, "-c", code % (HERE, plan, tuple(DISC), units, DISC,
                                                              os.path.join(d, "o"), plan)],
                               capture_output=True, text=True, cwd=HERE)
            self.assertEqual(p.returncode, 0, p.stderr)
            mods = json.loads(p.stdout.strip().splitlines()[-1])
            self.assertTrue(os.path.exists(os.path.join(d, "o", "features.csv")))
        self.assertNotIn("h1cgo.outcomes", mods)
        self.assertNotIn("h1cgo.stats", mods)


if __name__ == "__main__":
    unittest.main()
