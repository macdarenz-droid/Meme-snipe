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
    tc.assertEqual(list(a.names.names), list(b.names.names))
    tc.assertEqual(len(a.names.names), len(b.names.names))
    for s, c in a.names.idx.items():
        if b.names.get(s) != c:
            tc.fail(f"code of {s!r}: {b.names.get(s)} != {c}")
    for s in ("", "not-on-the-tape", "x" * 50):
        tc.assertEqual(a.names.get(s), b.names.get(s))
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
        import g1lib.load as L
        self.root = tempfile.mkdtemp(prefix="g1r_")
        self.addCleanup(shutil.rmtree, self.root)
        self.addCleanup(setattr, L, "REFERENCE", False)

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


class LeanBuildersSameResults(unittest.TestCase):
    """The lean index builders against the reference ones on random inputs with ties, duplicates, self-links, missing
    codes and several bands: LinkGraph arrays, the components (as a partition), the serial-buyer index and the fast
    class owners."""

    def setUp(self):
        import g1lib.load as L
        self.addCleanup(setattr, L, "REFERENCE", False)

    @staticmethod
    def partition(labels):
        import numpy as np
        _, first = np.unique(labels, return_index=True)
        canon = {int(labels[i]): k for k, i in enumerate(sorted(first))}
        return [canon[int(x)] for x in labels]

    def random_graph(self, rng, n=400, e=3000):
        import numpy as np
        src = rng.integers(-1, n, e)
        dst = rng.integers(-1, n, e)
        dst[:50] = src[:50]                                   # self-links
        src[100:200], dst[100:200] = dst[200:300], src[200:300]   # reversed duplicates
        hub = rng.integers(0, n)
        src[300:420] = hub                                    # a hub
        slot = rng.integers(1000, 1100, e)
        return src, dst, slot, n

    def test_link_graph_and_components(self):
        import numpy as np
        from g1lib import graph as Gr
        for seed in range(4):
            rng = np.random.default_rng(seed)
            src, dst, slot, n = self.random_graph(rng)
            with mock.patch.object(Gr, "_BAND_HALF_EDGES", 500):
                lean = Gr.LinkGraph(src.astype(np.int32), dst.astype(np.int32), slot, n + 3, lean=True)
            ref = Gr.LinkGraph(src, dst, slot, n + 3, lean=False)
            self.assertEqual(lean.n, ref.n)
            for k in ("u", "col", "slot", "indptr"):
                self.assertTrue(np.array_equal(getattr(lean, k), getattr(ref, k)), k)
            self.assertEqual(lean.u.dtype, np.int32)
            for cutoff in (999, 1020, 1050, 1100):
                for hub in (3, 10, 50):
                    self.assertEqual(self.partition(lean.components(cutoff, hub, lean=True)),
                                     self.partition(ref.components(cutoff, hub, lean=False)))
                    for x in rng.integers(0, n, 5):
                        self.assertEqual(lean.cluster([int(x)], cutoff, hub), ref.cluster([int(x)], cutoff, hub))

    def fake(self, rng, n_names=300, n_buys=6000, slots=(1000, 1400)):
        """A FeatureContext-like object over random buys (ties on slot and tx, big buys, missing mints and owners)."""
        import types
        import numpy as np
        from g1lib import graph as Gr
        from g1lib.features import FeatureContext
        sl = np.sort(rng.integers(slots[0], slots[1], n_buys))
        buys = pd.DataFrame({"slot": sl.astype(np.int64), "tx_idx": rng.integers(0, 4, n_buys).astype(np.int32),
                             "owner": rng.integers(-1, n_names // 2, n_buys).astype(np.int32),
                             "mint": rng.integers(-1, 25, n_buys).astype(np.int32),
                             "sol": np.where(rng.random(n_buys) < 0.3, 2 * 10 ** 9, 10 ** 7).astype(np.int64),
                             "venue": np.zeros(n_buys, np.int8)})
        names = types.SimpleNamespace(names=[None] * n_names)
        mid = (slots[0] + slots[1]) // 2
        tape = types.SimpleNamespace(buys=buys, names=names,
                                     day_of_unit=[(slots[0], mid - 1, "d1"), (mid, slots[1], "d2")])
        ctx = FeatureContext.__new__(FeatureContext)
        ctx.tape = tape
        ctx.create_slot = {int(m): int(rng.integers(slots[0], slots[1])) for m in range(0, 25, 2)}
        ctx.mig_slot = {int(m): int(rng.integers(slots[0], slots[1])) for m in range(1, 25, 3)}
        src, dst, slot, _ = self.random_graph(rng, n=n_names // 2, e=400)
        ctx.graph = Gr.LinkGraph(src, dst, slot + (slots[0] - 1000), n_names, lean=False)
        return ctx

    def test_serial_buyer_index(self):
        import numpy as np
        for seed in range(4):
            ctx = self.fake(np.random.default_rng(seed))
            ctx._buys_index(lean=False)
            ref = (ctx.b_owner.copy(), ctx.b_slot.copy(), ctx.b_cumnear.copy())
            ctx._buys_index(lean=True)
            self.assertTrue(np.array_equal(ref[0], ctx.b_owner))
            self.assertTrue(np.array_equal(ref[1], ctx.b_slot))
            # b_cumnear equals the reference at the end of every (owner, slot) run, the only places serial reads
            o_, s_ = ctx.b_owner, ctx.b_slot
            ends = np.flatnonzero(np.append((o_[1:] != o_[:-1]) | (s_[1:] != s_[:-1]), True))
            self.assertTrue(np.array_equal(ref[2][ends], ctx.b_cumnear[ends]))
            pairs = [(o, c) for o in range(-1, 160) for c in list(range(995, 1405, 3)) + [10 ** 6]]
            got = [ctx.serial(o, c) for o, c in pairs]
            self.assertTrue(any(got) and not all(got))
            ctx._buys_index(lean=False)
            self.assertEqual([ctx.serial(o, c) for o, c in pairs], got)

    def test_fast_class(self):
        import numpy as np
        from g1lib import flows
        nonempty = 0
        for seed in range(10):
            # seeds 6..9: dense ties (many big buys of one mint in the same slot and transaction by different traders)
            ctx = self.fake(np.random.default_rng(seed), **({} if seed < 6 else {"slots": (1000, 1040)}))
            for graph in (True, False):
                if not graph:
                    ctx.graph = None
                lean, ref = flows.FastClass(ctx), flows.FastClass(ctx)
                lean.CHUNK = 777                                   # several chunks
                for day in ("d1", "d2"):
                    a, b = lean.owners(day, lean=True), ref.owners(day, lean=False)
                    self.assertTrue(np.array_equal(a, b), (seed, graph, day))
                    self.assertEqual(a.dtype, b.dtype)
                    nonempty += int(0 < len(a) < len(np.unique(ctx.tape.buys["owner"])))
        self.assertGreater(nonempty, 3)             # some owners are fast and some are not


class CompactInternerSameCodes(unittest.TestCase):
    """CompactInterner against Interner on random call sequences, with forced hash collisions, long strings, a trailing
    NUL, non-ASCII text, empty and missing values."""

    def run_seq(self, seed, hash_mod=None):
        import numpy as np
        from g1lib.load import CompactInterner, Interner
        rng = np.random.default_rng(seed)
        pool = [f"addr{i}" for i in range(300)] + ["", "é漢字", "x" * 60, "tail\0", "So1111", "a" * 44, "b" * 45]
        a, b = Interner(), CompactInterner()
        if hash_mod:
            base = CompactInterner._hash
            b._hash = staticmethod(lambda v: base(v) % np.uint64(hash_mod))
        for step in range(400):
            op = rng.integers(0, 5)
            vals = [pool[i] for i in rng.integers(0, len(pool), int(rng.integers(1, 30)))]
            if op == 0:
                self.assertEqual([a.code(v) for v in vals], [b.code(v) for v in vals])
            elif op == 1:
                arr = np.array(vals + [None, float("nan")], dtype=object)
                self.assertEqual(a.codes(arr).tolist(), b.codes(arr).tolist())
            elif op == 2:
                cat = pd.Categorical([v if v else None for v in vals])
                self.assertEqual(a.codes_cat(pd.Series(cat)).tolist(), b.codes_cat(pd.Series(cat)).tolist())
            elif op == 3:
                b.merge()
            self.assertEqual([a.get(v) for v in pool + ["never"]], [b.get(v) for v in pool + ["never"]])
        b.merge()
        self.assertEqual(list(a.names), list(b.names))
        self.assertEqual([a.name(c) for c in range(-1, len(a.names))], [b.name(c) for c in range(-1, len(b.names))])

    def test_plain(self):
        self.run_seq(1)

    def test_forced_collisions(self):
        self.run_seq(2, hash_mod=5)
        self.run_seq(3, hash_mod=1)


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
