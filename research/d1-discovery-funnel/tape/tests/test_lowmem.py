"""The low-memory reader (load(lowmem=True), PoolBook.consume, the numpy LinkIndex) against the earlier reader
(`run_d1.py --old-reader`): the same tables, the same pool book, the same link answers, and byte-identical outputs
(every file stage 1, stage 2 and summary write, plus the search table and result) on synthetic multi-unit inputs.
Also: a stage 1 (preparation) run never imports the outcome, search or validation code."""
import filecmp
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

from tests import synth as S
from tests.synth_units import write_units
from d1.holders import LinkIndex, LinkIndexDict
from d1.load import TABLES, load
from d1.pool_state import PoolBook

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Inputs: (seed, kwargs). Two random multi-unit inputs, one with a schema v1 unit and a coverage gap, one with
# overlapping unit ranges (the global sort is needed); plus the existing single-unit BOOST fixture (test_d1).
INPUTS = [(11, dict(n_units=4, n_pools=5, v1_units=(0,))),
          (12, dict(n_units=4, n_pools=4, gap_units=(2,), every_s=8)),
          (13, dict(n_units=3, n_pools=3, with_overlap=True))]


def _inputs(root):
    out = []
    for seed, kw in INPUTS:
        out.append(write_units(os.path.join(root, f"s{seed}"), seed=seed, **kw))
    from tests.test_d1 import BoostItem3  # noqa: F401  (fixture writer lives there)
    from tests.test_d1 import _write_unit
    from d1 import config as C
    base = dict(block_time=int(S.bt_of(S.S0)), tx_idx=1, ev_idx=0, outer_ix=0, inner_ix="", pool="P", base_mint="M",
                quote_mint=C.WSOL, side="buy", base_amount=10, quote_amount=10**9, quote_amount_lp_adjusted=10**9,
                user_quote_amount=10**9, pool_base_token_reserves=10**12, pool_quote_token_reserves=10**11,
                virtual_quote_reserves=0, lp_fee_basis_points=20, protocol_fee_basis_points=5,
                coin_creator_fee_basis_points=95, coin_creator="CC", base_supply=10**15, owner_token_pre=0,
                owner_token_post=10, canonical=1, top_program=C.PUMPSWAP_PROGRAM)
    rows = [dict(base, slot=S.S0, signature="sigBOOST", protocol=0, user_token_owner=""),
            dict(base, slot=S.S0 + 1, signature="sigPROT", protocol=1, user_token_owner="X"),
            dict(base, slot=S.S0 + 2, signature="sigUSER", protocol=0, user_token_owner="Y")]
    mig = {"slot": S.S0, "event": "CompletePumpAmmMigrationEvent", "signature": "m",
           "fields": {"pool": "P", "mint": "M", "bonding_curve": "BC", "quote_mint": C.SYSTEM_PROGRAM}}
    out.append([_write_unit(os.path.join(root, "fixture"), S.DAY, S.S0, S.S0 + 10, rows, boost_sigs=["sigBOOST"],
                            extra_e=[mig])])
    return out


class LowMemReader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp()
        cls.inputs = _inputs(cls.root)

    def test_tables_equal(self):
        for units in self.inputs:
            for all_pools in (False, True):
                old = load(units, [S.DAY], all_pools=all_pools)
                new = load(units, [S.DAY], all_pools=all_pools, lowmem=True)
                self.assertGreater(len(old.amm) + len(old.b), 0)
                self.assertEqual(old.codec.names, new.codec.names)
                self.assertEqual(old.counts, new.counts)
                self.assertEqual(old.schema_v1_slots, new.schema_v1_slots)
                self.assertEqual(old.segs, new.segs)
                for k in TABLES:
                    o, n = getattr(old, k), getattr(new, k)
                    if k == "amm":
                        o = o.drop(columns="signature")   # read by nothing after the load; not kept by lowmem
                    pd.testing.assert_frame_equal(o, n, check_exact=True)
                self.assertEqual(list(old.ev), list(new.ev))
                for k in old.ev:
                    pd.testing.assert_frame_equal(old.ev[k], new.ev[k], check_exact=True)
                # stage 2's reader: only the pool rows held, the same counts and codes
                s2 = load(units, [S.DAY], all_pools=all_pools, lowmem=True, keep=("amm",))
                self.assertEqual(old.counts, s2.counts)
                self.assertEqual(old.codec.names, s2.codec.names)
                pd.testing.assert_frame_equal(old.amm.drop(columns="signature"), s2.amm, check_exact=True)
                self.assertEqual(len(s2.t) + len(s2.w) + len(s2.buys) + len(s2.curve), 0)

    def test_keep_needs_lowmem(self):
        with self.assertRaises(ValueError):
            load(self.inputs[0], [S.DAY], keep=("amm",))

    def test_pool_book_equal(self):
        for units in self.inputs:
            t = load(units, [S.DAY], lowmem=True)
            old = PoolBook(t.amm)
            new = PoolBook.consume(t)
            self.assertEqual(len(t.amm), 0)
            self.assertEqual(list(old.rows), list(new.rows))
            for p in old.rows:
                self.assertEqual(list(old.rows[p]), list(new.rows[p]))
                for c in old.rows[p]:
                    a, b = old.rows[p][c], new.rows[p][c]
                    self.assertEqual(a.dtype, b.dtype, c)
                    np.testing.assert_array_equal(a, b, c)

    def test_link_index_equal(self):
        rng = np.random.default_rng(5)
        for n in (0, 1, 40, 3000):
            u = rng.integers(0, 60, n)
            v = rng.integers(0, 60, n)
            s = rng.integers(100, 140, n)
            old, new = LinkIndexDict(u, v, s), LinkIndex(u, v, s)
            for a in range(-1, 62):
                for d in (99, 100, 117, 139, 200):
                    self.assertEqual(old.neighbours(a, d), new.neighbours(a, d))
                    self.assertEqual(old.degree(a, d), new.degree(a, d))


def _run(args, cwd=HERE):
    r = subprocess.run([sys.executable] + args, cwd=cwd, capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(r.stderr[-3000:])
    return r.stdout


SEARCH = """
import json, sys
import run_d1
from d1.search import run_search
df, sha = run_d1.with_h8(run_d1.joined(sys.argv[1]), None)
res = run_search(df)
res["table"].to_csv(sys.argv[1] + "/search_table.csv", index=False)
json.dump({k: res[k] for k in ("outcome", "advanced", "h8_basis", "median_rt_cost")}, open(sys.argv[1] + "/search.json", "w"),
          indent=1, default=str)
"""


class LowMemOutputs(unittest.TestCase):
    """Old reader vs new reader, end to end in separate processes: every output file byte-identical."""

    def test_outputs_byte_identical(self):
        root = tempfile.mkdtemp()
        inputs = _inputs(root)
        n_points = 0
        for i, units in enumerate(inputs):
            outs = {}
            for mode in ("old", "new"):
                run = os.path.join(root, f"run{i}-{mode}")
                flag = ["--old-reader"] if mode == "old" else []
                logs = [_run(["run_d1.py", "stage1", "--units", *units, "--days", S.DAY, "--out", run] + flag),
                        _run(["run_d1.py", "stage2", "--out", run] + flag)]
                if len(pd.read_pickle(os.path.join(run, "points.pkl"))):   # summary needs outcome columns
                    logs.append(_run(["run_d1.py", "summary", "--run", run]))
                    _run(["-c", SEARCH, run])
                with open(os.path.join(run, "stdout.txt"), "w") as fh:
                    fh.write("".join(logs))
                outs[mode] = run
            files = sorted(os.listdir(outs["old"]))
            self.assertEqual(files, sorted(os.listdir(outs["new"])))
            for f in ("points.pkl", "features.pkl", "outcomes.pkl", "manifest_stage1.json", "manifest_stage2.json"):
                self.assertIn(f, files)
            for f in files:
                self.assertTrue(filecmp.cmp(os.path.join(outs["old"], f), os.path.join(outs["new"], f), shallow=False),
                                f"input {i}: {f} differs")
            n_points += int(pd.read_pickle(os.path.join(outs["new"], "features.pkl")).shape[0])
        self.assertGreater(n_points, 50)   # the comparison covers real feature and outcome rows


class PrepOnly(unittest.TestCase):
    def test_stage1_never_imports_outcome_code(self):
        """A preparation run (stage 1) on real data computes no outcome: the outcome, search and validation modules
        are never even imported."""
        root = tempfile.mkdtemp()
        units = write_units(os.path.join(root, "u"), seed=3, n_units=3, n_pools=3)
        code = ("import sys, json, run_d1\n"
                f"run_d1.main(['stage1', '--units', *{units!r}, '--days', {S.DAY!r}, '--out', {os.path.join(root, 'r')!r}])\n"
                "print(json.dumps(sorted(m for m in sys.modules if m.startswith('d1.') or m.startswith('scipy.stats'))))\n")
        out = _run(["-c", code])
        mods = json.loads(out.strip().splitlines()[-1])
        self.assertIn("d1.features", mods)
        for m in ("d1.outcomes", "d1.search", "d1.validate"):
            self.assertNotIn(m, mods)
        self.assertGreater(len(pd.read_pickle(os.path.join(root, "r", "features.pkl"))), 0)
        self.assertFalse(os.path.exists(os.path.join(root, "r", "outcomes.pkl")))


if __name__ == "__main__":
    unittest.main()
