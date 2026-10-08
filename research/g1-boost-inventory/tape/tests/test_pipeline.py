"""End to end on a synthetic two-unit tape: universe, triggers, timing, features, the planted future marker
(PREREG §7 check 1), outcomes and the gate."""
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
from g1lib import params as P  # noqa: E402
from g1lib.decide import decisions, s0_progress, timing  # noqa: E402
from g1lib.features import FeatureContext, compute_features  # noqa: E402
from g1lib.load import find_units, load  # noqa: E402

DAY = "2026-09-11"
U1, U2 = (446_257_000, 446_260_999), (446_261_000, 446_266_999)
S = U1[0]
quiet = lambda *a, **k: None


def same_time_cutoff(first):
    """A t0 at or after `first` whose cutoff slot t0 + D − 1 shares its block time with the next slot."""
    from synth import bt
    t0 = first
    while bt(t0 + P.D - 1) != bt(t0 + P.D):
        t0 += 1
    return t0


Y_T0 = same_time_cutoff(S + 9100)


def scenario(marker=None, zcase=False):
    """A: catchable, migrates; B: never completes (exit B); C: completes before entry; M: mayhem; K: cashback;
    L: left-censored; Z: crosses too late (dropped by time)."""
    s = Synth()
    for m in "ABCMKZ":
        s.create(S, 1, m, "creator" + m, name="name" + m, symbol="SYM" + m, mayhem=int(m == "M"), cashback=int(m == "K"))
    # A
    s.trade(S + 1, 1, "A", "o1", sol=2 * 10 ** 9, post=None)
    s.buy_to(S + 100, 1, "A", "o2", 70 * 10 ** 9)
    s.buy_to(S + 200, 1, "A", "o3", 80 * 10 ** 9)                  # t0(A) = S + 200
    s.sol_link(S + 210, "creatorA", "o3")                           # before the cutoff S + 222
    s.complete(S + 300, 5, "A", "poolA")
    s.pool_trade(S + 300, 6, "poolA", "A", "o2", "sell", base=10 ** 12)
    s.pool_trade(S + 305, 1, "poolA", "A", "boost", "buy", quote=5 * 10 ** 8, bps=(0, 0, 0), boost=True)
    s.pool_trade(S + 310, 1, "poolA", "A", "n1", "buy", quote=10 ** 9)
    s.pool_trade(S + 323, 1, "poolA", "A", "n2", "buy", quote=10 ** 9)
    s.pool_trade(S + 330, 1, "poolA", "A", "boost", "buy", quote=5 * 10 ** 8, bps=(0, 0, 0), boost=True)
    # B
    s.buy_to(S + 1000, 1, "B", "p1", 60 * 10 ** 9)
    s.buy_to(S + 1100, 1, "B", "p2", 77 * 10 ** 9)                 # t0(B) = S + 1100
    s.trade(S + 3000, 1, "B", "p3", sol=10 ** 8)
    # C
    s.buy_to(S + 2000, 1, "C", "q1", 50 * 10 ** 9)
    s.buy_to(S + 2100, 1, "C", "q2", 80 * 10 ** 9)
    s.complete(S + 2110, 5, "C", "poolC")
    # M, K
    for m in "MK":
        s.trade(S + 400, 1, m, "x", sol=50 * 10 ** 9, mayhem=int(m == "M"), cashback=int(m == "K"))
        s.trade(S + 500, 1, m, "y", sol=40 * 10 ** 9, mayhem=int(m == "M"), cashback=int(m == "K"))
    # L: no create on the tape, first row already above the trigger
    s.state["L"] = [30 * 10 ** 9, 1_073_000_000_000_000, 0, 793_100_000_000_000]
    s.trade(S + 50, 1, "L", "z", sol=80 * 10 ** 9)
    s.trade(S + 60, 1, "L", "z2", sol=10 ** 9)
    # Z: crosses close to the end of the data
    s.buy_to(U2[1] - 3000, 1, "Z", "r1", 60 * 10 ** 9)
    s.buy_to(U2[1] - 2900, 1, "Z", "r2", 80 * 10 ** 9)
    # a buyback-authority buy inside [m, m + D] on A's pool: a protocol row, never counted as opening flow
    s.pool_trade(S + 315, 1, "poolA", "A", P.BUYBACK_AUTHORITY, "buy", quote=3 * 10 ** 9)
    if zcase:
        # Y: decision late enough for a covered trailing hour; R: a rival curve below 68 SOL
        s.create(S + 8000, 1, "Y", "creatorY", name="nameY", symbol="SYMY")
        s.buy_to(S + 8500, 1, "Y", "y1", 50 * 10 ** 9)
        s.buy_to(Y_T0, 1, "Y", "y2", 80 * 10 ** 9)
        s.create(S + 100, 2, "R", "creatorR", name="nameR", symbol="SYMR")
        s.buy_to(S + 200, 2, "R", "rr", 60 * 10 ** 9)
    if marker:
        marker(s)
    return s


class Pipeline(unittest.TestCase):
    def build(self, marker=None, links=True, zcase=False):
        root = tempfile.mkdtemp(prefix="g1t_")
        self.addCleanup(shutil.rmtree, root)
        s = scenario(marker, zcase)
        s.write(root, DAY, *U1)
        s.write(root, DAY, *U2, schema_v2=False)
        units = find_units([root], plan={DAY: [U1, U2]})
        tape = load(units, links=links, log=quiet)
        d = timing(tape, decisions(tape, log=quiet))
        ctx = FeatureContext(tape, with_links=links)
        d = compute_features(tape, d, ctx, log=quiet)
        return tape, d, ctx

    def g1(self, d, m, kind="G1"):
        r = d[(d["kind"] == kind) & (d["mint"] == m)]
        return r.iloc[0] if len(r) else None

    def test_universe_and_triggers(self):
        tape, d, _ = self.build()
        self.assertEqual(len(tape.units), 2)
        self.assertEqual(tape.segs, [(U1[0], U2[1])])
        a = self.g1(d, "A")
        self.assertEqual(int(a["t0"]), S + 200)
        self.assertGreaterEqual(int(a["real_at_t0"]), P.trigger_lamports(0.9))
        self.assertEqual(a["reason"], "")
        self.assertFalse(a["censored"])
        self.assertFalse(a["dropped_by_time"])
        self.assertEqual(int(a["entry_slot"]), S + 200 + P.D)
        self.assertEqual(self.g1(d, "M")["reason"], "mayhem")
        self.assertEqual(self.g1(d, "K")["reason"], "cashback")
        self.assertTrue(self.g1(d, "L")["censored"])
        self.assertTrue(self.g1(d, "Z")["dropped_by_time"])
        s0 = self.g1(d, "A", "S0")
        p = s0_progress("A", DAY)
        self.assertTrue(0.5 <= p <= 0.8)
        self.assertGreaterEqual(int(s0["real_at_t0"]), p * P.TARGET_LAMPORTS)
        self.assertLess(int(s0["t0"]), int(a["t0"]))
        self.assertIsNotNone(self.g1(d, "A", "G1@80"))

    def test_features(self):
        tape, d, _ = self.build()
        a = self.g1(d, "A")
        self.assertTrue(0 < a["R"] <= 1)
        self.assertGreater(a["R_cluster"], 0)          # o3 joined the creator's cluster by the W link at S + 210
        self.assertAlmostEqual(a["hc_coverage"], 1.0, places=6)
        self.assertEqual(a["cap_reason"], "trailing-hour-not-covered")

    def test_planted_future_marker(self):
        """PREREG §7 check 1: rows after the decision slot must not change any decision or feature, and the same rows
        at the decision slot must (so the test can fail)."""
        cols = ["kind", "mint", "t0", "reason", "censored", "R", "R_cluster", "R_early", "R_lowcost", "R_serial",
                "hc_coverage", "cluster_size", "N", "lam", "Z", "cap_reason"]
        _, base, _ = self.build()
        cutoff = S + 200 + P.D - 1

        def at(slot):
            def mark(s):
                s.sol_link(slot, "creatorA", "o2")                                  # joins o2 to the creator
                s.trade(slot, 2, "A", "whale", sol=10 ** 8, mayhem=1)               # mayhem flag, new holder
                s.transfer(slot, 3, "A", "o1", "creatorA", 10 ** 9)
            return mark
        _, future, _ = self.build(marker=at(cutoff + 1))
        _, now, _ = self.build(marker=at(cutoff))
        key = ["kind", "mint"]
        b = base[base["kind"] == "G1"][cols].sort_values(key).reset_index(drop=True)
        f = future[future["kind"] == "G1"][cols].sort_values(key).reset_index(drop=True)
        n = now[now["kind"] == "G1"][cols].sort_values(key).reset_index(drop=True)
        pd.testing.assert_frame_equal(b, f)
        self.assertFalse(b.equals(n))

    def test_outcomes(self):
        from g1lib.market import Market
        from g1lib import outcome
        tape, d, _ = self.build(links=False)
        mkt = Market(tape)
        t = outcome.run(mkt, d, with_secondary=True, log=quiet)
        prim = t[t["variant"] == "primary"]
        a = prim[(prim["kind"] == "G1") & (prim["mint"] == "A")].iloc[0]
        self.assertTrue(a["filled"])
        self.assertEqual(a["exit"], "A")
        self.assertEqual(int(a["exit_slot"]), S + 300 + P.D)
        self.assertLessEqual(a["paid"], P.spend_lamports(50))
        self.assertGreater(a["proceeds"], 0)
        self.assertAlmostEqual(a["net"], a["proceeds"] - a["paid"] - a["fixed"])
        b = prim[(prim["kind"] == "G1") & (prim["mint"] == "B")].iloc[0]
        self.assertEqual(b["exit"], "B")
        self.assertGreaterEqual(tape.time_of(int(b["exit_slot"])), int(d[(d.kind == "G1") & (d.mint == "B")]["entry_time"].iloc[0]) + 1800)
        c = prim[(prim["kind"] == "G1") & (prim["mint"] == "C")].iloc[0]
        self.assertFalse(c["filled"])
        self.assertEqual(c["miss"], "complete-before-entry")
        self.assertNotIn("Z", set(prim["mint"]))                     # dropped by time
        self.assertNotIn("M", set(prim["mint"]))
        big = t[(t["variant"] == "size $10000") & (t["mint"] == "A")].iloc[0]
        self.assertEqual(big["miss"], "entry-exceeds-reserves")      # the curve cannot fill $10,000
        # exit at the start/end worse state: the sell in slot S + 323 sees the buy in that slot only as the end state
        from g1lib.outcome import pool_exit
        f, _ = pool_exit(mkt, tape.names.get("poolA"), S + 323, int(a["tokens"]))
        self.assertEqual(f.user_quote, int(a["proceeds"]))

    def test_gate(self):
        from g1lib.market import Market
        from g1lib import gate
        tape, d, ctx = self.build()
        res, grads, trig, flows = gate.run(tape, d, ctx, Market(tape), [DAY], log=quiet)
        g = res["G1_0"]
        self.assertEqual(g["a_triggers_per_day"][DAY], 4)               # A, B, C, Z (L censored; M, K excluded)
        self.assertEqual(g["catchable_per_day"][DAY], 2)                # C completes before entry; Z dropped by time
        self.assertEqual(g["b_n_migrating"], 2)
        ga = grads[grads["mint"] == "A"].iloc[0]
        self.assertEqual(int(ga["first_boost_slots"]), 5)
        self.assertTrue(ga["any_boost"])
        h = res["boost_slices"]
        ha = h[h["pool"] == "poolA"]
        self.assertEqual(list(ha["slice"]), [1, 2])
        self.assertEqual(list(ha["slots_after_m"]), [5, 30])
        self.assertTrue((ha["headroom"] > 0).all())        # cap at the slice's own average price sits above spot
        r1 = tape.pool_rows[tape.pool_rows["is_boost"]].iloc[0]                  # slice 1, before-state on the row
        spot = (r1["pool_quote_token_reserves"] + r1["virtual_quote_reserves"]) / r1["pool_base_token_reserves"]
        cap = r1["quote_amount"] / r1["min_base_amount_out"]                     # synth: quote requested ÷ base cap
        self.assertAlmostEqual(ha["headroom"].iloc[0], cap / spot - 1, places=12)
        self.assertAlmostEqual(ha["headroom"].iloc[0], 0.00591, places=5)   # ≈ the impact of 0.5 SOL on ~84.6 SOL
        self.assertEqual(g["desc_cap_headroom"]["n"], 2)
        fa = flows[tape.names.get("A")]
        self.assertGreater(fa["share_pre_sold"], 0)                      # o2 sold in slot m
        pr = tape.pool_rows
        own = [tape.names.get(x) for x in ("n1", "n2")]
        want = pr[pr["owner"].isin(own) & (pr["slot"] <= S + 300 + P.D)]["quote_amount_lp_adjusted"].sum()
        cr = tape.curve_of(tape.names.get("A"))
        want += cr[(cr["slot"] == S + 300) & (cr["is_buy"] == 1)]["sol_amount"].sum()   # the completing buy in slot m
        self.assertEqual(fa["first_time_buy_sol"], float(want))         # not the buyback authority's 3 SOL

    def test_z_counts_rows_by_slot(self):
        """Review finding 2: a rival crossing 68 SOL in slot cutoff + 1, with the cutoff's block time, must not count."""
        cutoff = Y_T0 + P.D - 1
        cols = ["N", "lam", "Z", "cap_reason"]
        _, base, _ = self.build(zcase=True)
        _, future, _ = self.build(zcase=True, marker=lambda s: s.buy_to(cutoff + 1, 1, "R", "rx", 70 * 10 ** 9))
        _, now, _ = self.build(zcase=True, marker=lambda s: s.buy_to(cutoff, 1, "R", "rx", 70 * 10 ** 9))
        b, f, n = (x[(x["kind"] == "G1") & (x["mint"] == "Y")][cols].iloc[0] for x in (base, future, now))
        self.assertEqual(b["cap_reason"], "")
        self.assertFalse(math.isnan(b["Z"]))
        pd.testing.assert_series_equal(b, f, check_names=False)
        self.assertEqual(n["N"], b["N"] + 1)


if __name__ == "__main__":
    unittest.main()


class ProtocolRowFeesR2_7(unittest.TestCase):
    def test_buyback_row_never_sets_the_exit_fee(self):
        """R2-7: a buyback-authority swap (a protocol row) may carry fee fields of 0. As for BOOST slices, it must not
        be the row our exit's fee rate comes from: the fee-paying neighbour's rates apply."""
        from g1lib.market import Market
        root = tempfile.mkdtemp(prefix="g1f_")
        self.addCleanup(shutil.rmtree, root)
        s = Synth()
        s.create(S, 1, "A", "creatorA")
        s.buy_to(S + 100, 1, "A", "o1", 80 * 10 ** 9)
        s.complete(S + 300, 5, "A", "poolA")
        s.pool_trade(S + 305, 1, "poolA", "A", "n1", "buy", quote=10 ** 9, bps=(2, 93, 30))
        s.pool_trade(S + 310, 1, "poolA", "A", P.BUYBACK_AUTHORITY, "buy", quote=10 ** 9, bps=(0, 0, 0))
        s.write(root, DAY, *U1)
        units = find_units([root], plan={DAY: [U1]})
        mkt = Market(load(units, links=False, log=quiet))
        f, src = mkt.pool_fees(mkt.tape.names.get("poolA"), S + 320)
        self.assertEqual((f.lp, f.protocol, f.creator), (2, 93, 30))
        self.assertEqual(src, "trades")
