"""The compact reader (load.load, reader="compact", the default) against the original one (reader="reference"):
the same Tape (tables, columns, dtypes, values, row order, address codes) and byte-identical outputs of every command,
outcome and score included, on the fixed synthetic fixture and on random synthetic multi-unit, two-day tapes.
Also: `decide` (the only stage run on real data before the reviews allow more) imports no outcome, market, gate or
statistics module."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
TAPE = os.path.dirname(HERE)
sys.path.insert(0, TAPE)
sys.path.insert(0, HERE)

import g1 as G  # noqa: E402
from g1lib import guard  # noqa: E402
from g1lib.load import find_units, load  # noqa: E402
from synth_random import DAYS, random_tape  # noqa: E402
from test_pipeline import DAY, U1, U2, scenario  # noqa: E402

quiet = lambda *a, **k: None
TABLES = ("blocks", "curve", "pool_rows", "buys", "T", "W", "F_boost")


def assert_same_tape(tc, a, b, pool=True):
    tc.assertEqual(a.names.names, b.names.names)
    tc.assertEqual(a.names.idx, b.names.idx)
    for k in TABLES:
        if k == "pool_rows" and not pool:
            tc.assertEqual(len(b.pool_rows), 0)
            continue
        pd.testing.assert_frame_equal(getattr(a, k), getattr(b, k), check_exact=True, obj=k)
    tc.assertEqual(list(a.events), list(b.events))
    for k in a.events:
        pd.testing.assert_frame_equal(a.events[k], b.events[k], check_exact=True, obj=k)
    tc.assertEqual(a.segs, b.segs)
    tc.assertEqual(a._curve_off, b._curve_off)
    if pool:
        tc.assertEqual(a._pool_off, b._pool_off)


def run_commands(root, plan, out, reference, days):
    """Every command of g1.py, in the order of work, into `out`. Returns {command: GuardError message} for refusals."""
    flags = ["--reference-reader"] if reference else []
    refused = {}
    os.makedirs(out, exist_ok=True)
    with mock.patch.object(guard, "load_plan", lambda *a, **k: plan), mock.patch.object(G, "log", quiet):
        G.main(["checks", "--units", root, "--out", out] + flags)
        G.main(["decide", "--units", root, "--out", out] + flags)
        G.main(["gate", "--units", root, "--out", out, "--days", *days] + flags)
        if tuple(days) == guard.DISCOVERY_DAYS:
            G.main(["freeze", "--out", out])
        G.main(["outcome", "--units", root, "--out", out, "--allow-returns", "--counts-only"] + flags)
        G.main(["outcome", "--units", root, "--out", out, "--allow-returns"] + flags)
        if tuple(days) == guard.DISCOVERY_DAYS:
            try:
                G.main(["score", "--out", out, "--role", "discovery", "--frozen", os.path.join(out, "frozen.json"),
                        "--allow-scoring"])
            except guard.GuardError as e:
                refused["score"] = str(e)
            # the statistics themselves, whatever the gate said (score reads only these files)
            from g1lib.score import judge
            with open(os.path.join(out, "frozen.json")) as f:
                fr = json.load(f)
            res = judge(pd.read_csv(os.path.join(out, "trades.csv")), G._decisions(argparse_ns(out)), fr, "discovery")
            G._json(os.path.join(out, "judge_discovery.json"), res)
    return refused


def argparse_ns(out):
    import argparse
    return argparse.Namespace(out=out)


class ReaderEquality(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="g1r_")
        self.addCleanup(shutil.rmtree, self.root)

    def compare_outputs(self, tape_root, plan, days):
        ref, new = os.path.join(self.root, "out_ref"), os.path.join(self.root, "out_new")
        r1 = run_commands(tape_root, plan, ref, True, days)
        r2 = run_commands(tape_root, plan, new, False, days)
        self.assertEqual(r1, r2)
        files = sorted(os.listdir(ref))
        self.assertEqual(files, sorted(os.listdir(new)))
        for want in ("decisions.csv", "decisions_summary.json", "gate.json", "graduates.csv", "triggers.csv", "flows.csv",
                     "boost_slices.csv", "checks.json", "trades.csv", "trades_counts.csv", "outcome_counts.json",
                     "manifest.json"):
            self.assertIn(want, files)
        if tuple(days) == guard.DISCOVERY_DAYS:
            self.assertIn("frozen.json", files)
            self.assertIn("judge_discovery.json", files)
        for f in files:
            with open(os.path.join(ref, f), "rb") as a, open(os.path.join(new, f), "rb") as b:
                self.assertEqual(a.read(), b.read(), f)
        return files

    def check_tape(self, tape_root, plan):
        units = find_units([tape_root], plan=plan)
        a = load(units, log=quiet, reader="reference")
        assert_same_tape(self, a, load(units, log=quiet))
        assert_same_tape(self, a, load(units, log=quiet, pool=False), pool=False)
        assert_same_tape(self, load(units, links=False, log=quiet, reader="reference"), load(units, links=False, log=quiet))
        return a

    def test_fixture(self):
        tape_root = os.path.join(self.root, "tape")
        s = scenario(zcase=True)
        s.write(tape_root, DAY, *U1)
        s.write(tape_root, DAY, *U2, schema_v2=False)
        plan = {DAY: [U1, U2]}
        self.check_tape(tape_root, plan)
        self.compare_outputs(tape_root, plan, [DAY])

    def test_random_seed_1(self):
        self.random(1, (2, 2))

    def test_random_seed_2(self):
        self.random(2, (3, 2))

    def random(self, seed, per_day):
        tape_root = os.path.join(self.root, "tape")
        plan = random_tape(tape_root, seed, units_per_day=per_day)
        tape = self.check_tape(tape_root, plan)
        self.assertGreater(len(tape.pool_rows), 50)
        self.assertGreater(len(tape.F_boost), 0)
        self.assertTrue(any(u.schema == "v1" for u in tape.units))
        self.compare_outputs(tape_root, plan, list(DAYS))
        with open(os.path.join(self.root, "out_new", "decisions_summary.json")) as f:
            self.assertGreater(json.load(f)["G1"]["in_universe"], 0)        # the random tape reaches every stage
        trades = pd.read_csv(os.path.join(self.root, "out_new", "trades.csv"))
        self.assertGreater(int(trades["filled"].sum()), 0)


class DecideImportsNoOutcome(unittest.TestCase):
    """`decide` (the preparation stage run on real tape) never imports a module that computes fills, returns, gate
    verdicts or statistics."""

    def test_decide_module_set(self):
        root = tempfile.mkdtemp(prefix="g1m_")
        self.addCleanup(shutil.rmtree, root)
        s = scenario()
        s.write(os.path.join(root, "tape"), DAY, *U1)
        s.write(os.path.join(root, "tape"), DAY, *U2, schema_v2=False)
        code = f"""
import sys, json
sys.path.insert(0, {TAPE!r})
from unittest import mock
import g1 as G
from g1lib import guard
with mock.patch.object(guard, "load_plan", lambda *a, **k: {{{DAY!r}: [{U1!r}, {U2!r}]}}):
    G.main(["decide", "--units", {os.path.join(root, "tape")!r}, "--out", {os.path.join(root, "out")!r}])
print(json.dumps(sorted(m for m in sys.modules if m.startswith("g1lib") or m.startswith("scipy.stats"))))
"""
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout
        mods = json.loads(out.strip().splitlines()[-1])
        self.assertIn("g1lib.decide", mods)
        self.assertIn("g1lib.features", mods)
        for m in ("g1lib.outcome", "g1lib.score", "g1lib.stats", "g1lib.market", "g1lib.quotes", "g1lib.costs",
                  "g1lib.gate", "g1lib.flows", "g1lib.checks", "scipy.stats"):
            self.assertNotIn(m, mods)


if __name__ == "__main__":
    unittest.main()
