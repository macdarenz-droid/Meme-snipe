"""Unit tests on small synthetic tables. Run from tape/: python3 -m unittest -v"""
import ast
import json
import os
import unittest

import numpy as np
import pandas as pd

from tests import synth as S
from d1 import config as C
from d1.clusters import ClusterState, follow_pairs, near_event_flags
from d1.costs import FIXED, Pool, buy_exact_quote_in, expected_fixed, fee_of, sell
from d1.features import compute_features
from d1.holders import holder_features
from d1.outcomes import compute_outcomes
from d1.pool_state import PoolBook
from d1.search import all_rules, edges_of, fold_masks, run_search, side_mask, throttle
from d1.universe import Clock, decision_points, migrations
from d1.validate import cluster_bootstrap, judge

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def build(minutes=150, **kw):
    sim, amm, migs, mig_slot, lo, hi = S.standard(minutes=minutes)
    tape = S.make_tape(amm, lo, hi, migs=migs, **kw)
    book = PoolBook(tape.amm)
    clock = Clock(tape)
    pts = decision_points(tape, book, migrations(tape, book), clock)
    return tape, book, clock, pts, mig_slot


class Costs(unittest.TestCase):
    def test_fixed_matches_edge_costs(self):
        self.assertEqual(round(expected_fixed()), C.EXPECTED_FIXED_LAMPORTS_REPO)
        p = os.path.join(REPO, "research", "edge", "costs.json")
        if os.path.exists(p):
            with open(p) as fh:
                self.assertEqual(round(FIXED), json.load(fh)["rows"][0]["fixedLamports"])

    def test_spend(self):
        self.assertEqual(C.SPEND_LAMPORTS, 419_252_054)

    def test_sell_golden_tape_row(self):
        # A PumpSwap SellEvent from discovery unit 2026-09-11/446274000-446278499 (slot 446274000, tx 541).
        p = Pool(base=154415972922223, vault=97791895703, virt=17584505811, lp_bps=20, protocol_bps=5, creator_bps=95)
        f = sell(p, 295553832395)
        self.assertEqual(f.quote, 220409806)
        self.assertEqual(fee_of(220409806, 20), 440820)
        self.assertEqual(f.quote - fee_of(f.quote, 20), 219968986)       # quote_amount_lp_adjusted
        self.assertEqual(f.user, 217764887)                                # user_quote_amount

    def test_buy_exact_quote_in_invariants(self):
        p = Pool(206_900_000_000_000, 67_400_000_000, 17_600_000_000, 20, 5, 100)
        f = buy_exact_quote_in(p, C.SPEND_LAMPORTS)
        self.assertLessEqual(f.user, C.SPEND_LAMPORTS)
        self.assertGreater(f.user, C.SPEND_LAMPORTS - 10)
        self.assertEqual(f.after.base, p.base - f.base)
        self.assertGreater(f.impact, 0)
        rt = sell(f.after, f.base)
        self.assertLess(rt.user, f.user)

    def test_sell_capped_by_vault(self):
        p = Pool(10**12, 10**9, 10**12, 20, 5, 95)   # tiny real vault, large virtual
        f = sell(p, 10**12)
        self.assertTrue(f.capped)
        self.assertLessEqual(f.quote, p.vault)


class PoolState(unittest.TestCase):
    def test_after_state_and_slot_edges(self):
        sim = S.AmmSim(1, 2, base=10**14, vault=10**11, virt=10**10)
        sim.trade(100, "buy", 10**9)
        sim.trade(100, "sell", 10**10)
        sim.trade(105, "buy", 10**9)
        book = PoolBook(sim.df())
        r = book.rows[1]
        # after-state of each row equals the next row's before-state
        self.assertTrue((r["base_after"][:-1] == r["base_before"][1:]).all())
        self.assertTrue((r["vault_after"][:-1] == r["vault_before"][1:]).all())
        self.assertEqual(int(book.idx_lt(1, 100)), -1)          # start of slot 100: no state yet
        self.assertEqual(int(book.idx_le(1, 100)), 1)           # end of slot 100: after the 2nd row
        self.assertEqual(int(book.idx_lt(1, 105)), 1)
        self.assertEqual(int(book.idx_le(1, 104)), 1)


class Universe(unittest.TestCase):
    def test_grid_and_eligibility(self):
        tape, book, clock, pts, mig_slot = build()
        self.assertGreater(len(pts), 0)
        mig_t = int(clock.slot_time(mig_slot))
        self.assertTrue((pts.tau % C.GRID_S == 0).all())
        self.assertTrue((pts.tau - mig_t >= C.H10_MIN_AGE_S).all())
        self.assertTrue((pts.tau - mig_t <= C.MAX_AGE_S).all())
        self.assertTrue((clock.slot_time(pts.d.to_numpy()) < pts.tau).all())
        self.assertTrue((S.bt_of(pts.d + 1) >= pts.tau).all())   # d is the LAST slot before tau
        r = book.rows[S.POOL]
        i = book.idx_le(S.POOL, pts.d.to_numpy())
        eff = r["vault_after"][i] + r["virt"][i]
        self.assertTrue(((eff >= C.MIN_EFFECTIVE_QUOTE) & (r["vault_after"][i] >= C.MIN_REAL_VAULT) == pts.eligible).all())
        self.assertTrue((pts.entry_slot == pts.d + C.DELAY_SLOTS).all())

    def test_drop_by_time(self):
        tape, book, clock, pts, _ = build()
        hi = tape.segs[0][1]
        v = pts[pts.valid_60]
        self.assertTrue((v.exit_slot_60 <= hi).all())
        late = pts[~pts.valid_60]
        self.assertTrue(len(late) > 0)
        # exit = first slot with time >= entry time + hold, plus 23 slots
        x = v.iloc[0]
        trig = x.exit_slot_60 - C.DELAY_SLOTS
        self.assertGreaterEqual(S.bt_of(trig), S.bt_of(x.entry_slot) + 3600)
        self.assertLess(S.bt_of(trig - 1), S.bt_of(x.entry_slot) + 3600)

    def test_coverage_gap_drops_points(self):
        sim, amm, migs, mig_slot, lo, hi = S.standard()
        gap = int(S.slot_at(S.T0 + 100 * 60))
        tape = S.make_tape(amm, lo, hi, migs=migs, segs=[(lo, gap), (gap + 10, hi)])
        book = PoolBook(tape.amm)
        pts = decision_points(tape, book, migrations(tape, book))
        self.assertTrue((pts.d <= gap).all())          # decisions after the gap cannot see a gap-free history
        self.assertTrue((pts[pts.valid_15].exit_slot_15 <= gap).all())

    def test_mayhem_and_unknown_excluded(self):
        sim, amm, migs, mig_slot, lo, hi = S.standard()
        tape = S.make_tape(amm, lo, hi, migs=migs)
        tape.ev["CreatePoolEvent"]["is_mayhem_mode"] = 1
        book = PoolBook(tape.amm)
        self.assertEqual(migrations(tape, book).excluded.iloc[0], "mayhem")
        tape.ev["CreatePoolEvent"] = tape.ev["CreatePoolEvent"].iloc[:0]
        self.assertEqual(migrations(tape, book).excluded.iloc[0], "mayhem flag unknown")


class Features(unittest.TestCase):
    def test_hand_computed(self):
        tape, book, clock, pts, _ = build()
        feats = compute_features(tape, book, pts, clock)
        self.assertEqual(list(feats.columns[2:]), list(C.FEATURES))
        el = pts[pts.eligible]
        p = el.iloc[3]
        fr = feats.loc[el.index[3]]
        r = book.rows[S.POOL]
        a = tape.amm
        win = a[(a.slot <= p.d) & (a.block_time >= p.tau - 900)]
        self.assertEqual(fr.buys_15m, (win.side == 1).sum())
        self.assertEqual(fr.sells_15m, (win.side == -1).sum())
        self.assertAlmostEqual(fr.net_sol_15m, (win.side * win.quote_amount).sum() / 1e9)
        self.assertEqual(fr.uniq_buyers_15m, win[win.side == 1].owner.nunique())
        i = int(book.idx_le(S.POOL, p.d))
        mid = lambda k: (r["vault_after"][k] + r["virt"][k]) / r["base_after"][k]
        j = int(book.idx_le(S.POOL, clock.decision_slot(p.tau - 300)))
        self.assertAlmostEqual(fr.ret_5m, mid(i) / mid(j) - 1)
        self.assertAlmostEqual(fr.effective_quote_sol, (r["vault_after"][i] + r["virt"][i]) / 1e9)
        self.assertAlmostEqual(fr.age_since_mig_min, (p.tau - p.mig_time) / 60)
        wb = win[win.side == 1]
        self.assertAlmostEqual(fr.app_routed_buy_share, wb[wb.app_routed == 1].quote_amount.sum() / wb.quote_amount.sum())
        first = tape.buys.drop_duplicates("owner")
        nfirst = ((first.slot <= p.d) & (S.bt_of(first.slot) >= p.tau - 900)).sum()
        self.assertEqual(fr.first_buyers_15m, nfirst)
        ws = win[win.side == -1]
        exp = ws.quote_amount.max() / (r["vault_after"][i] + r["virt"][i]) if len(ws) else 0.0
        self.assertAlmostEqual(fr.max_sell_share_15m, exp)

    def test_failed_cf_boost_v1(self):
        tape, book, clock, pts, _ = build()
        p = pts[pts.eligible].iloc[0]
        d, tau = int(p.d), int(p.tau)
        tape.f = pd.DataFrame({"slot": [d - 10, d - 20, d + 1], "block_time": S.bt_of([d - 10, d - 20, d + 1]),
                               "pool": [S.POOL] * 3})
        tape.cf = pd.DataFrame({"slot": [d - 5, d + 5], "block_time": S.bt_of([d - 5, d + 5]), "creator": [90, 90]})
        tape.ev["BoostBuyAndBurnEvent"] = pd.DataFrame({"slot": [d - 100, d - 50], "signature": ["x", "y"],
                                                        "pool": [S.POOL] * 2, "mint": [S.MINT] * 2,
                                                        "boost_vault_remaining": [5, 0]})
        feats = compute_features(tape, book, pts, clock)
        fr = feats.loc[p.name]
        a = tape.amm
        nb = ((a.slot <= d) & (a.block_time >= tau - 900) & (a.side == 1)).sum()
        self.assertAlmostEqual(fr.failed_buy_share_15m, 2 / (2 + nb))
        self.assertEqual(fr.cf_collections_1h, 1)
        self.assertEqual(fr.boost_finished, 1.0)
        tape.schema_v1_slots = [(d - 3, d - 2)]
        self.assertTrue(np.isnan(compute_features(tape, book, pts, clock).loc[p.name].cf_collections_1h))

    def test_planted_future_marker(self):
        """Rows after a decision slot (planted with extreme values) must not change that decision's features."""
        tape, book, clock, pts, _ = build()
        base = compute_features(tape, book, pts, clock)
        el = pts[pts.eligible]
        cut = int(el.d.iloc[len(el) // 2])
        m = cut + 1
        # plant: a giant buy and sell, a W hub burst and links to every buyer, T transfers, F fails, CF, boost, create
        sim = S.AmmSim(S.POOL, S.MINT, 1, 1)
        amm = tape.amm.copy()
        last = amm[amm.slot <= cut].iloc[-1]
        big = last.copy()
        big.update({"slot": m, "block_time": int(S.bt_of(m)), "tx_idx": 10**6, "side": 1, "base_amount": 10**14,
                    "quote_amount": 10**13, "quote_lp_adj": 10**13, "user_quote": 10**13, "owner": 777,
                    "base_after": 1, "vault_after": 10**14, "owner_pre": 0, "owner_post": 10**14})
        amm2 = pd.concat([amm, pd.DataFrame([big]).astype(amm.dtypes.to_dict())], ignore_index=True).sort_values(["slot", "tx_idx"]).reset_index(drop=True)
        t2 = S.make_tape(amm2, tape.segs[0][0], tape.segs[0][1], migs=[tuple(x) for x in tape.ev["CompletePumpAmmMigrationEvent"].itertuples(index=False)],
                         w=pd.DataFrame({"slot": [m] * 120, "src": [500] * 120, "dst": list(range(100, 220))}),
                         t=pd.DataFrame({"slot": [m, m], "tx_idx": [1, 2], "outer_ix": [0, 0], "inner_ix": [-1, -1],
                                         "mint": [S.MINT] * 2, "pump_mint": [1, 1], "kind": [0, 2],
                                         "src": [100, -1], "dst": [90, 101], "amount": [10**13, 10**13]}),
                         f=pd.DataFrame({"slot": [m] * 50, "block_time": S.bt_of([m] * 50), "pool": [S.POOL] * 50}),
                         cf=pd.DataFrame({"slot": [m] * 9, "block_time": S.bt_of([m] * 9), "creator": [90] * 9}),
                         boost=pd.DataFrame({"slot": [m], "signature": ["z"], "pool": [S.POOL], "mint": [S.MINT],
                                             "boost_vault_remaining": [0]}),
                         creates=[(m, "c", S.MINT, 777, 777, S.CURVE, 0, C.SYSTEM_PROGRAM)])
        b2 = PoolBook(t2.amm)
        c2 = Clock(t2)
        pts2 = decision_points(t2, b2, migrations(t2, b2), c2)
        keep = pts.d <= cut
        pd.testing.assert_frame_equal(pts[keep].reset_index(drop=True), pts2[pts2.d <= cut].reset_index(drop=True))
        f2 = compute_features(t2, b2, pts2, c2)
        a = base.loc[pts[keep & pts.eligible].index].reset_index(drop=True)
        b = f2.loc[pts2[(pts2.d <= cut) & pts2.eligible].index].reset_index(drop=True)
        self.assertGreater(len(a), 3)
        pd.testing.assert_frame_equal(a, b)
        # and the plant is visible later (the test can fail)
        later = f2.loc[pts2[(pts2.d > cut) & pts2.eligible].index]
        old = base.loc[pts[(pts.d > cut) & pts.eligible].index]
        self.assertFalse(np.allclose(later.cf_collections_1h.to_numpy(), old.cf_collections_1h.to_numpy()))

    def test_feature_code_never_imports_outcomes(self):
        for name in ("features.py", "universe.py", "clusters.py", "holders.py", "pool_state.py", "load.py"):
            with open(os.path.join(HERE, "d1", name)) as fh:
                tree = ast.parse(fh.read())
            mods = set()
            for n in ast.walk(tree):
                if isinstance(n, ast.ImportFrom):
                    mods.add(n.module or "")
                elif isinstance(n, ast.Import):
                    mods.update(a.name for a in n.names)
            self.assertFalse(any("outcomes" in m or "search" in m or "validate" in m for m in mods), name)

    def test_wall_refused(self):
        import tempfile
        from d1.load import load
        d = tempfile.mkdtemp()
        u = os.path.join(d, "2026-09-11", "1-2", "research")
        os.makedirs(u)
        pd.DataFrame({"slot": [1], "block_time": [C.WALL_EPOCH]}).to_csv(os.path.join(u, "B.csv.zst"), index=False, compression="zstd")
        with self.assertRaises(RuntimeError):
            load([os.path.dirname(u)], ["2026-09-11"])
        with self.assertRaises(ValueError):
            load([os.path.dirname(u)], ["2026-09-10"])


class Clusters(unittest.TestCase):
    def _tape(self, w, buys, creates=(), migs=()):
        sim = S.AmmSim(1, 2, 10**14, 10**11)
        sim.trade(S.S0 + 1, "buy", 10**9, owner=100)
        return S.make_tape(sim.df(), S.S0, S.S0 + 200, w=w, buys=buys, creates=creates, migs=migs)

    def test_links_as_of_and_hubs(self):
        w = pd.DataFrame({"slot": [S.S0 + 10, S.S0 + 50] + [S.S0 + 20] * 51,
                          "src": [100, 101] + [900] * 51, "dst": [101, 102] + list(range(200, 251))})
        buys = pd.DataFrame({"slot": [S.S0 + 5], "tx_idx": [1], "ev_idx": [0], "venue": [1], "mint": [2], "owner": [100], "sol": [1e9]})
        st = ClusterState(self._tape(w, buys))
        lab, _ = st.snapshot(S.S0 + 30, int(S.bt_of(S.S0 + 31)))
        self.assertEqual(lab[100], lab[101])
        self.assertNotEqual(lab[101], lab[102])          # that link is later than the decision
        self.assertNotEqual(lab[200], lab[201])          # joined only through a hub (51 links > 50)
        lab, _ = st.snapshot(S.S0 + 60, int(S.bt_of(S.S0 + 61)))
        self.assertEqual(lab[100], lab[102])

    def test_hub_at_50_still_joins(self):
        w = pd.DataFrame({"slot": [S.S0 + 20] * 50, "src": [900] * 50, "dst": list(range(200, 250))})
        buys = pd.DataFrame({"slot": [S.S0 + 5], "tx_idx": [1], "ev_idx": [0], "venue": [1], "mint": [2], "owner": [100], "sol": [1e9]})
        st = ClusterState(self._tape(w, buys))
        lab, _ = st.snapshot(S.S0 + 30, int(S.bt_of(S.S0 + 31)))
        self.assertEqual(lab[200], lab[249])

    def test_fast_class(self):
        # mint 7 created at S0+10. Owner 100: 1 of 5 buys within 2 slots of the create (20% >= 10%) -> fast.
        # Owner 101: 2 of 5 buys within 2 slots after owner 102's 1-SOL buys (40% >= 30%) -> fast. Owner 103: slow.
        rows = [(S.S0 + 12, 100, 1e8)] + [(S.S0 + 40 + i, 100, 1e8) for i in range(4)]
        rows += [(S.S0 + 60, 102, 2e9), (S.S0 + 61, 101, 1e8), (S.S0 + 80, 102, 2e9), (S.S0 + 82, 101, 1e8)]
        rows += [(S.S0 + 100 + i, 101, 1e8) for i in range(3)] + [(S.S0 + 120 + i, 103, 1e8) for i in range(5)]
        buys = pd.DataFrame({"slot": [r[0] for r in rows], "tx_idx": range(len(rows)), "ev_idx": 0, "venue": 1,
                             "mint": 7, "owner": [r[1] for r in rows], "sol": [r[2] for r in rows]})
        buys = buys.sort_values(["slot", "tx_idx"]).reset_index(drop=True)
        tape = self._tape(S.empty(["slot", "src", "dst"]), buys,
                          creates=[(S.S0 + 10, "c", 7, 55, 55, 56, 0, C.SYSTEM_PROGRAM)])
        flags = near_event_flags(tape)
        self.assertEqual(int(flags.sum()), 1)
        fb, fl = follow_pairs(tape)
        self.assertTrue(len(fb) >= 2)
        st = ClusterState(tape)
        lab, fast = st.snapshot(S.S0 + 200, int(S.bt_of(S.S0 + 200)) + 1)
        self.assertTrue(fast[lab[100]])
        self.assertTrue(fast[lab[101]])
        self.assertFalse(fast[lab[103]])
        # as-of: before owner 101's second follow it has 1 of 1 -> fast; before any buy of 103 it has no class
        lab, fast = st.snapshot(S.S0 + 61, int(S.bt_of(S.S0 + 61)) + 1)
        self.assertTrue(fast[lab[101]])


class HoldersTest(unittest.TestCase):
    def test_cost_basis(self):
        sim = S.AmmSim(S.POOL, S.MINT, base=10**14, vault=100 * 10**9, virt=0, fees=(0, 0, 0))
        s = S.S0 + 10
        b1 = sim.trade(s, "buy", 10**9, owner=100, pre=0)                    # A buys
        sim.trade(s + 10, "buy", 2 * 10**9, owner=101, pre=0)                # B buys
        sim.trade(s + 30, "sell", b1 // 2, owner=100)                         # A sells half
        amm = sim.df()
        amm.loc[0, "owner_post"] = b1
        # T: A sends a quarter of its original tokens to C at s+20 (cost moves proportionally)
        t = pd.DataFrame({"slot": [s + 20], "tx_idx": [99], "outer_ix": [0], "inner_ix": [-1], "mint": [S.MINT],
                          "pump_mint": [1], "kind": [0], "src": [100], "dst": [102], "amount": [b1 // 4]})
        tape = S.make_tape(amm, S.S0, S.S0 + 400, t=t,
                           migs=[(S.S0, "m", S.MINT, S.POOL, S.CURVE, C.SYSTEM_PROGRAM)])
        book = PoolBook(tape.amm)
        el = pd.DataFrame({"pool": [S.POOL, S.POOL], "mint": [S.MINT, S.MINT], "d": [s + 25, s + 35],
                           "tau": [0, 1]}, index=[0, 1])
        out = holder_features(tape, book, el)
        r = book.rows[S.POOL]
        b2 = int(r["base_amount"][1])
        cost_a, cost_b = int(r["user_quote"][0]), int(r["user_quote"][1])
        # at s+25: A holds 3/4 b1 (cost 3/4 cost_a), C holds 1/4 b1 (cost 1/4 cost_a), B holds b2: all known
        self.assertAlmostEqual(out.loc[0, "cgo_coverage"], 1.0)
        i = int(np.searchsorted(r["slot"], s + 25, side="right") - 1)
        P = (r["vault_after"][i] + r["virt"][i]) / r["base_after"][i]
        RP = (cost_a + cost_b) / (b1 + b2)
        self.assertAlmostEqual(out.loc[0, "cgo"], (P - RP) / P, places=9)
        self.assertAlmostEqual(out.loc[0, "top10_share"], (b1 + b2) / 10**15, places=12)
        # at s+35: A sold half of its ORIGINAL (b1/2) from 3/4 b1 -> A keeps b1/4 with cost/4
        i = int(np.searchsorted(r["slot"], s + 35, side="right") - 1)
        P = (r["vault_after"][i] + r["virt"][i]) / r["base_after"][i]
        known_tok = b1 / 4 + b1 / 4 + b2
        known_cost = cost_a / 4 + cost_a / 4 + cost_b
        self.assertAlmostEqual(out.loc[1, "cgo"], (P - known_cost / known_tok) / P, places=9)

    def test_unknown_preholdings_lower_coverage(self):
        sim = S.AmmSim(S.POOL, S.MINT, base=10**14, vault=100 * 10**9, fees=(0, 0, 0))
        s = S.S0 + 10
        b1 = sim.trade(s, "buy", 10**9, owner=100, pre=3 * 10**12)          # held 3e12 before the tape
        tape = S.make_tape(sim.df(), S.S0, S.S0 + 100, migs=[(S.S0, "m", S.MINT, S.POOL, S.CURVE, C.SYSTEM_PROGRAM)])
        book = PoolBook(tape.amm)
        el = pd.DataFrame({"pool": [S.POOL], "mint": [S.MINT], "d": [s], "tau": [0]})
        out = holder_features(tape, book, el)
        self.assertAlmostEqual(out.loc[0, "cgo_coverage"], b1 / (b1 + 3 * 10**12))
        self.assertAlmostEqual(out.loc[0, "creator_share"], 0.0)


class Outcomes(unittest.TestCase):
    def test_fills(self):
        tape, book, clock, pts, _ = build()
        out = compute_outcomes(book, pts)
        el = pts[pts.eligible]
        self.assertEqual(len(out), len(el))
        self.assertTrue(out.entry_ok.all())
        self.assertTrue(out.loc[el.index[~el.valid_60.to_numpy()], "net_ret_60"].isna().all())
        o = out.loc[el.index[0]]
        p = el.iloc[0]
        # entry = the worse of the start- and end-of-slot states
        cands = [buy_exact_quote_in(book.state(S.POOL, int(i)), C.SPEND_LAMPORTS)
                 for i in {int(book.idx_lt(S.POOL, p.entry_slot)), int(book.idx_le(S.POOL, p.entry_slot))}]
        self.assertEqual(o.tokens, min(c.base for c in cands))
        if p.valid_15:
            xs = [sell(book.state(S.POOL, int(i)), int(o.tokens)).user
                  for i in {int(book.idx_lt(S.POOL, p.exit_slot_15)), int(book.idx_le(S.POOL, p.exit_slot_15))}]
            self.assertEqual(o.recv_15, min(xs))
            self.assertAlmostEqual(o.net_ret_15, (min(xs) - o.paid - FIXED) / o.paid)
        self.assertGreater(o.rt_cost, FIXED / o.paid)


def synthetic_search_frame(seed=1, planted=True, n_pools=60):
    rng = np.random.default_rng(seed)
    rows = []
    for day in C.DISCOVERY_DAYS:
        d0 = C.epoch(day)
        for p in range(n_pools):
            for tau in range(d0, d0 + 86400, 300):
                rows.append((p, tau, day))
    df = pd.DataFrame(rows, columns=["pool", "tau", "day"])
    n = len(df)
    df["block"] = (df.tau % 86400) // C.BLOCK_S
    for f in C.FEATURES:
        df[f] = rng.normal(size=n)
    for h in C.HOLDS_S:
        hm = h // 60
        df[f"valid_{hm}"] = True
        df[f"exit_time_{hm}"] = df.tau + h + 20
        df[f"net_ret_{hm}"] = rng.normal(-0.05, 0.05, size=n)
    if planted:
        m = df.rv_15m > np.quantile(df.rv_15m, 0.8)
        df.loc[m, "net_ret_60"] += 0.3
    df["entry_ok"] = True
    df["rt_cost"] = 0.03
    df["eligible"] = True
    return df


class Search(unittest.TestCase):
    def test_rule_count(self):
        self.assertEqual(len(all_rules()), 1568)

    def test_throttle(self):
        pool = np.array([1, 1, 1, 1, 2, 2])
        tau = np.array([0, 300, 3600, 3900, 0, 3000])
        k = throttle(pool, tau, np.array([True, True, True, True, True, True]))
        self.assertEqual(k.tolist(), [True, False, True, False, True, False])
        k = throttle(pool, tau, np.array([False, True, True, True, False, True]))
        self.assertEqual(k.tolist(), [False, True, False, True, False, True])

    def test_fold_gap(self):
        df = synthetic_search_frame(planted=False, n_pools=1)
        train, test = fold_masks(df, 1, 60)
        d0 = C.epoch(C.DISCOVERY_DAYS[0])
        t = df.tau.to_numpy()
        self.assertTrue(test[(t >= d0 + 6 * 3600) & (t < d0 + 12 * 3600)].all())
        self.assertFalse(train[(t >= d0 + 5 * 3600 - 3600 - 60 - 20) & (t < d0 + 13 * 3600)].any())
        self.assertTrue(train[t == d0 + 13 * 3600].all())
        self.assertTrue(train[t == d0 + 3 * 3600].all())

    def test_edges_from_training_only(self):
        df = synthetic_search_frame(planted=False, n_pools=2)
        train, test = fold_masks(df, 0, 15)
        x = df.rv_15m.to_numpy().copy()
        e1 = edges_of(x[train])
        x[test] = 1e9
        self.assertEqual(e1, edges_of(x[train]))
        m = side_mask(np.array([np.nan, 5.0, -5.0]), (-1.0, 1.0), "top")
        self.assertEqual(m.tolist(), [False, True, False])

    def test_planted_rule_found_and_nothing_found(self):
        res = run_search(synthetic_search_frame(planted=True))
        self.assertEqual(res["outcome"], "advance")
        self.assertLessEqual(len(res["advanced"]), C.N_ADVANCE)
        self.assertIn("rv_15m:top", res["advanced"][0]["rule"])
        self.assertEqual(res["advanced"][0]["hold_min"], 60)
        q = res["table"][res["table"].qualifies]
        self.assertTrue((q[[f"n_f{j}" for j in range(4)]] >= 30).all().all())
        self.assertTrue((q.score >= res["median_rt_cost"]).all())
        res = run_search(synthetic_search_frame(planted=False))
        self.assertEqual(res["outcome"], "nothing found")


class Validation(unittest.TestCase):
    def _df(self, mu, n_pools=200, days=C.VALIDATION_DAYS_STEP_B, seed=3):
        rng = np.random.default_rng(seed)
        rows = []
        for day in days:
            for p in range(n_pools):
                for k in range(3):
                    rows.append((p, C.epoch(day) + k * 7200, day, 1.0, rng.normal(mu, 0.05)))
        df = pd.DataFrame(rows, columns=["pool", "tau", "day", "rv_15m", "net_ret_60"])
        df["valid_60"] = True
        df["entry_ok"] = True
        return df

    def _frozen(self):
        return {"rule": "rv_15m:top", "hold_min": 60, "terms": [{"feature": "rv_15m", "side": "top", "edges_q20_q80": [0.0, 0.5]}]}

    def test_bootstrap_deterministic(self):
        ret = np.r_[np.ones(10), -np.ones(10)]
        pool = np.repeat(np.arange(4), 5)
        day = np.repeat(["a", "b"], 10)
        b1 = cluster_bootstrap(ret, pool, day, n_boot=500)
        b2 = cluster_bootstrap(ret, pool, day, n_boot=500)
        self.assertTrue(np.array_equal(b1, b2))

    def _with_control(self, df):
        df.loc[df.index[::2], "rv_15m"] = 0.1   # half the points are outside the rule and worse -> lift > 0
        df.loc[df.rv_15m < 0.5, "net_ret_60"] -= 0.1
        return df

    def test_verdicts(self):
        df = self._with_control(self._df(0.05))
        r = judge(df, self._frozen(), C.VALIDATION_DAYS_STEP_B)
        self.assertEqual(r["verdict"], "pass")
        self.assertGreater(r["ci995"][0], 0)
        r = judge(self._df(0.05, n_pools=20), self._frozen(), C.VALIDATION_DAYS_STEP_B)
        self.assertEqual(r["verdict"], "unresolved")
        df = self._with_control(self._df(0.05))
        df.loc[df.day == C.VALIDATION_DAYS_STEP_B[1], "net_ret_60"] = -0.2
        r = judge(df, self._frozen(), C.VALIDATION_DAYS_STEP_B)
        self.assertEqual(r["verdict"], "not supported")
        self.assertLess(r["per_day_mean"][C.VALIDATION_DAYS_STEP_B[1]], 0)
        df = self._with_control(self._df(0.05))
        r = judge(df, self._frozen(), C.VALIDATION_DAYS_STEP_B + ("2026-09-06",))
        self.assertEqual(r["verdict"], "not supported")   # a validation day with no trade is not positive


if __name__ == "__main__":
    unittest.main()
