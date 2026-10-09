"""Scale work (2026-10-09): the chunked reader gives the same bytes as the original reader, and `ledger --prep-only`
computes no cash, cost or valuation and imports no scoring module, while its other columns equal the full ledger's."""
import contextlib
import glob
import io
import json
import os
import pickle
import subprocess
import sys
import tempfile
import unittest

import pandas as pd

import synth
from test_ledger import build as build_fixture
from w1 import guard, load, replay, rules, run
from w1.ledger import PREP_DROP

TAPE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A10, A11 = "2026-09-10", "2026-09-11"


def random_input(root, seed, scale=0.02, per_day=2):
    """Two Step A days of random units (slots continue across the days, balances carry). Few owners, many mints and
    few cluster links, so the ranking, the deciles, discovery and the replay all have traders and trades."""
    tp = synth.Tape(root, A10, seed=seed, scale=scale, owners=300, creates=150, w_link=0.001)
    dirs = [tp.unit() for _ in range(per_day)]
    tp.day = A11
    dirs += [tp.unit() for _ in range(per_day)]
    return dirs


def quiet(fn, *a):
    with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
        fn(*a)
    return out.getvalue()


def files(work):
    out = {}
    for p in sorted(glob.glob(os.path.join(work, "*"))):
        with open(p, "rb") as f:
            out[os.path.basename(p)] = f.read()
    return out


class PlanPatch:
    """Registers a plan file holding exactly the given units for both Step A days (as tests/test_review Guards)."""

    def __init__(self, root, dirs):
        us = load.parse_units(dirs)
        self.plan = os.path.join(root, "plan.txt")
        with open(self.plan, "w") as f:
            f.write("".join(f"{u.day} 1033 {u.lo} {u.hi}\n" for u in us))

    def __enter__(self):
        self.saved = dict(guard.PLANS)
        sha = load.file_sha256(self.plan)
        guard.PLANS.clear()
        guard.PLANS.update({A10: (self.plan, sha), A11: (self.plan, sha)})

    def __exit__(self, *e):
        guard.PLANS.clear()
        guard.PLANS.update(self.saved)


class ReaderEquality(unittest.TestCase):
    """The chunked reader (default) and the original whole-table reader (--legacy-reader) give byte-identical
    ledger files, vocabularies, manifests and scored-stage outputs. CHUNK is set small so every table spans several
    chunks."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_chunk, self.saved_reader = load.CHUNK, load.READER
        load.CHUNK = 97

    def tearDown(self):
        load.CHUNK, load.READER = self.saved_chunk, self.saved_reader
        self.tmp.cleanup()

    def ledgers(self, dirs, extra=()):
        works = []
        for name, flag in (("legacy", ["--legacy-reader"]), ("chunked", [])):
            w = os.path.join(self.tmp.name, name)
            quiet(run.main, ["ledger", "--work", w, "--units"] + dirs + flag + list(extra))
            works.append(w)
        a, b = files(works[0]), files(works[1])
        self.assertEqual(sorted(a), sorted(b))
        self.assertTrue(any(k.startswith("ledger-") for k in a))
        for k in a:
            self.assertEqual(a[k], b[k], k)
        return works

    def test_fixture_ledger(self):
        dirs = build_fixture(os.path.join(self.tmp.name, "fx"))
        self.ledgers(dirs, ["--dev-allow-gaps"])          # 09-07/09-08 fixture units are not the frozen plan

    def scored(self, works, stage, extra=()):
        outs = []
        for w in works:
            try:
                outs.append(quiet(run.main, [stage, "--work", w, "--score"] + list(extra)))
            except SystemExit as e:                       # a stage that stops (e.g. extract without a pass)
                outs.append(f"exit {e.code}")
        self.assertEqual(outs[0], outs[1], stage)
        return outs[0]

    def check_random(self, seed):
        root = os.path.join(self.tmp.name, f"r{seed}")
        dirs = random_input(root, seed)
        saved_roles = dict(guard.ROLES)
        try:
            with PlanPatch(root, dirs):
                works = self.ledgers(dirs)
                for stage in ("gate", "flippers", "discovery"):
                    out = self.scored(works, stage)
                    self.assertTrue(out.startswith("{"), out[:200])
                self.assertGreater(json.loads(out)["ranking"]["ranked"], 10)      # the input exercises the ranking
                # validation (with the replay) and extract on the same two days, for the test only
                guard.STEP_B_RELEASED = True
                guard.ROLES["validation"] = {"days": [A10, A11], "rank": A10, "test": [A11]}
                guard.ROLES["extract"] = {"days": [A10, A11], "rank": A10, "test": [A11]}
                val = json.loads(self.scored(works, "validation"))
                self.assertGreater(val["replay"]["replayed"], 0)                  # and the replay
                a, b = files(works[0]), files(works[1])
                self.assertEqual(a["validation.pkl"], b["validation.pkl"])
                self.scored(works, "extract")
        finally:
            guard.STEP_B_RELEASED = False
            guard.ROLES.clear()
            guard.ROLES.update(saved_roles)
        # every reader-built table the scoring stages read from units (replay, §8 tapes, flows)
        units = load.parse_units(dirs)
        got = {}
        for reader in ("legacy", "chunked"):
            load.READER = reader
            v = load.Vocab()
            tabs = []
            for u in units:
                tabs += [load.swaps(u, v), load.movements(u, v), load.sol_transfers(u, v), load.coverage(u, v)]
            names = set(v.strs[:200:3])
            for u in units:
                tabs += [load.swaps(u, v, mints=names), load.movements(u, v, mints=names)]
            ids = {v.get(n) for n in names}
            tabs.append(replay.state_rows(units, v, ids))
            led = run._event_ledger(units, v)
            info = run._info(led)
            tapes = rules.tapes_for(units, v, ids, info, run._excluder(led))
            sw = tabs[0]
            cand = sw[sw["mint"].isin(ids) & sw["is_buy"]].head(50)
            ent = pd.DataFrame({"mint": cand["mint"], "key": cand["key"], "bt": cand["bt"], "paid": -cand["cash"]})
            tabs.append(rules.entry_features(ent.reset_index(drop=True), tapes, info))
            got[reader] = (tabs, list(v.strs))
        self.assertEqual(got["legacy"][1], got["chunked"][1])
        for x, y in zip(got["legacy"][0], got["chunked"][0]):
            if isinstance(x, pd.DataFrame):
                pd.testing.assert_frame_equal(x, y, check_exact=True)
                self.assertEqual(list(x.dtypes), list(y.dtypes))
            else:
                self.assertEqual(pickle.dumps(x), pickle.dumps(y))

    def test_random_input_seed_3(self):
        self.check_random(3)

    def test_random_input_seed_11(self):
        self.check_random(11)

    def test_reader_values_on_edge_cells(self):
        """Missing ints, int64 overflow, the wall and text cells, across chunk boundaries."""
        p = os.path.join(self.tmp.name, "x.csv.zst")
        n = 1000
        pd.DataFrame({"slot": range(n), "block_time": [load.WALL_TS if i % 250 == 7 else 10 for i in range(n)],
                      "a": ["18446744073709551615" if i % 333 == 5 else ("" if i % 7 == 0 else str(i)) for i in range(n)],
                      "s": ["" if i % 5 == 0 else f"t{i % 13}" for i in range(n)]}).to_csv(p, index=False,
                                                                                    compression="zstd")
        out = {}
        for reader in ("legacy", "chunked"):
            load.READER = reader
            out[reader] = load.read_table(p, ["slot", "block_time", "a", "s", "absent"], ["slot", "block_time", "a",
                                                                                          "absent_int"])
        pd.testing.assert_frame_equal(out["legacy"], out["chunked"], check_exact=True)
        self.assertEqual(list(out["legacy"].columns), list(out["chunked"].columns))


POISON = """
import json, sys
sys.path.insert(0, {tape!r})
from w1 import costs, ledger, run, venue
def boom(*a, **k):
    raise AssertionError("valuation or cash called in prep-only")
for mod, names in ((ledger, ("sell_vec", "mark", "signer_cash", "amendment_tx_cost")),
                   (costs, ("signer_cash", "amendment_tx_cost")), (venue, ("sell_vec", "sell", "sell_detail"))):
    for n in names:
        setattr(mod, n, boom)
ledger.Ledger._costs = boom
ledger.Ledger._signer_method = boom
run.main({argv!r})
print(json.dumps(sorted(m for m in sys.modules if m.startswith("w1."))))
"""


class PrepOnly(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dirs = random_input(os.path.join(cls.tmp.name, "in"), seed=5)
        cls.full = os.path.join(cls.tmp.name, "full")
        cls.prep = os.path.join(cls.tmp.name, "prep")
        quiet(run.main, ["ledger", "--dev-allow-gaps", "--work", cls.full, "--units"] + cls.dirs)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def poisoned(self, work, prep):
        argv = ["ledger", "--dev-allow-gaps", "--work", work, "--units"] + self.dirs + (["--prep-only"] if prep else [])
        return subprocess.run([sys.executable, "-c", POISON.format(tape=TAPE, argv=argv)], capture_output=True,
                              text=True, cwd=TAPE)

    def test_prep_only_never_values_and_imports_no_scoring_module(self):
        r = self.poisoned(self.prep, True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        mods = json.loads(r.stdout.strip().splitlines()[-1])
        for m in run._SCORING:
            self.assertNotIn("w1." + m, mods)
        # the poison is live: the full ledger trips it
        r = self.poisoned(os.path.join(self.tmp.name, "full2"), False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("valuation or cash called in prep-only", r.stderr)

    def test_prep_tables_equal_the_full_ledger_without_cash_and_marks(self):
        if not os.path.exists(os.path.join(self.prep, "manifest.json")):
            quiet(run.main, ["ledger", "--dev-allow-gaps", "--prep-only", "--work", self.prep, "--units"] + self.dirs)
        mf, mp = run._manifest(self.full), run._manifest(self.prep)
        self.assertTrue(mp["prep_only"])
        self.assertNotIn("seed", mp)
        for day in (A10, A11):
            with open(os.path.join(self.full, f"ledger-{day}.pkl"), "rb") as f:
                full = pickle.load(f)
            with open(os.path.join(self.prep, f"ledger-{day}.pkl"), "rb") as f:
                prep = pickle.load(f)
            self.assertTrue(prep["prep_only"])
            self.assertGreater(len(prep["rows"]), 0)
            for key, drop in PREP_DROP.items():
                for c in drop:
                    self.assertNotIn(c, prep[key].columns)
                pd.testing.assert_frame_equal(full[key].drop(columns=list(drop)), prep[key], check_exact=True)
            for key in full:
                if key in PREP_DROP:
                    continue
                self.assertEqual(pickle.dumps(full[key]), pickle.dumps(prep[key]), key)
            cf = dict(mf["days"][day])
            cf.pop("rows_with_signer_method")
            self.assertEqual(cf, mp["days"][day])
            self.assertEqual(mf["excluded_by_type"], mp["excluded_by_type"])

    def test_scored_stages_and_counts_refuse_a_prep_ledger(self):
        if not os.path.exists(os.path.join(self.prep, "manifest.json")):
            quiet(run.main, ["ledger", "--dev-allow-gaps", "--prep-only", "--work", self.prep, "--units"] + self.dirs)
        for stage in ("gate", "flippers", "discovery"):
            with self.assertRaises(guard.Refused):
                quiet(run.main, [stage, "--work", self.prep, "--score"])
        with self.assertRaises(guard.Refused):
            quiet(run.main, ["counts", "--work", self.prep])


if __name__ == "__main__":
    unittest.main()
