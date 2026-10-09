"""The streaming reader (stream.py) against the in-memory one, and the prep-only mode.

Run: python3 -m unittest -v test_stream (from this folder).
"""
import filecmp
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_rows as TR  # noqa: E402
from test_rows import SUPPLY, T0, Unit  # noqa: E402

DAY0, DAY1 = "2026-09-10", "2026-09-11"
MAYHEM_PROGRAM = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"
UNIT_SLOTS = 20000


def random_units(seed, n_mints=10):
    """Four units over two days (two contiguous units a day), with curve and PumpSwap trades, dev sells across the
    DEV-ZERO cutoffs, T moves, W links (with a hub), fails, BOOST and protocol rows, a mayhem curve with re-prices,
    LP moves and creator-fee collections. Returns [(unit, day)] in a shuffled order."""
    rng = np.random.default_rng(seed)
    spans = [(DAY0, 0), (DAY0, 1), (DAY1, 2), (DAY1, 3)]
    units = {k: Unit(k * UNIT_SLOTS, (k + 1) * UNIT_SLOTS - 1) for _, k in spans}

    def unit_of(slot):
        return units[min(int(slot) // UNIT_SLOTS, 3)]

    owners = [f"w{i}" for i in range(70)]
    for i in range(n_mints):
        mint, pool, dev = f"M{i}", f"P{i}", f"D{i}"
        day_k = int(rng.integers(0, 2)) * 2                        # the mint lives on one day
        c_slot = day_k * UNIT_SLOTS + int(rng.integers(5, 3000))
        mayhem = i == n_mints - 1
        if i != 1:                                                 # M1's create is not on the tape
            u = unit_of(c_slot)
            u.event("CreateEvent", c_slot, {"mint": mint, "creator": dev, "user": dev, "is_mayhem_mode": str(int(mayhem)),
                                            "quote_mint": "11111111111111111111111111111111",
                                            "name": f"coin{i % 7}", "symbol": f"C{i}"})
        m_slot = c_slot + int(rng.integers(200, 1500))
        for k in range(int(rng.integers(10, 40))):                 # curve trades before the migration
            sl = int(rng.integers(c_slot, m_slot))
            r = unit_of(sl).cbuy(sl, owners[int(rng.integers(0, 70))], mint, sol=float(rng.integers(1, 30)) * 1e8,
                                 buy=bool(rng.random() < 0.8), creator=dev, tokens=int(rng.integers(1, 1000)))
            r["mayhem_mode"] = int(mayhem)
            r["virtual_sol_reserves"] = int(30e9 + k * 1e9)
            r["virtual_token_reserves"] = int(1e15 - k * 1e12)
            r["real_sol_reserves"] = int(6e9 + k * 1e8)
            if mayhem and k % 3 == 0:
                r["top_program"] = MAYHEM_PROGRAM
                ev_sig = f"mh{i}_{k}"
                r["signature"] = ev_sig
                j = float(rng.choice([-0.1, -0.07, 0.08, 0.12, 0.01]))
                unit_of(sl).event("UpdateMayhemVirtualParamsEvent", sl, {
                    "mint": mint, "virtual_sol_reserves": "1000000", "virtual_token_reserves": "1000",
                    "new_virtual_sol_reserves": str(int(1000000 * (1 + j))), "new_virtual_token_reserves": "1000",
                    "real_sol_reserves": str(int(rng.integers(1, 20)) * 10**9), "real_token_reserves": "5"}, sig=ev_sig)
        if mayhem or i == 2:                                       # M2 never migrates
            continue
        u = unit_of(m_slot)
        u.event("CompleteEvent", m_slot - 1, {"mint": mint})
        u.migrate(m_slot, mint, pool, creator=dev, pool_quote=float(rng.choice([85e9, 3e9])))
        if i == 3:
            u.event("DepositEvent", m_slot + 50, {"pool": pool, "lp_token_amount_out": "10"})
            unit_of(m_slot + 900).event("WithdrawEvent", m_slot + 900, {"pool": pool, "lp_token_amount_in": "10"})
        quote, base = 80e9, 1e14
        end = min((day_k + 2) * UNIT_SLOTS - 1, m_slot + 36000)
        n = int(rng.integers(150, 400))
        dev_share = float(rng.choice([0.07, 0.048, 0.035, 0.06])) * SUPPLY
        sl_list = np.sort(rng.integers(m_slot + 1, end, n))
        for k, sl in enumerate(sl_list):
            sl = int(sl)
            buy = bool(rng.random() < 0.6)
            sol = float(rng.integers(1, 40)) * 5e7
            quote = max(1e9, quote + (sol if buy else -sol))
            base = max(1e12, base * (0.999 if buy else 1.001))
            o = owners[int(rng.integers(0, 70))]
            kw = dict(sol=sol, buy=buy, creator=dev, quote=quote, base=base, tokens=int(rng.integers(1, 10**6)),
                      chain=bool(rng.random() < 0.92), fee_bps=int(rng.choice([0, 5, 5, 5])))
            if sl - m_slot > 3700 and k % 9 == 0 and dev_share > 0:   # dev sells crossing the cutoffs
                step = float(rng.choice([0.004, 0.008, 0.01, 0.02, 0.07, -1.0]))
                post = 0.06 * dev_share if step < 0 else max(0.0, dev_share - step * SUPPLY)
                kw.update(buy=False, pre=dev_share, post=post)
                dev_share = post
                o = dev
            if rng.random() < 0.15:                                # owner token balances
                kw.setdefault("pre", float(rng.integers(0, 5)) * 1e5)
                kw.setdefault("post", 0.0 if rng.random() < 0.5 else float(rng.integers(1, 5)) * 1e5)
            r = unit_of(sl).aswap(sl, o, mint, pool, **kw)
            x = rng.random()
            if x < 0.05:
                r["signer"] = "relay"
            elif x < 0.07:
                r["protocol"] = 1
            elif x < 0.10:
                r["signature"] = f"boost{i}_{k}"
                unit_of(sl).event("BoostBuyAndBurnEvent", sl, {"mint": mint, "pool": pool,
                                                                "quote_amount_in_used": str(int(sol)),
                                                                "quote_amount_in_requested": str(int(sol * 1.1))},
                                  sig=r["signature"])
            elif x < 0.12:
                r["user_token_owner"] = None
            elif x < 0.14:
                r["top_program"] = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
            elif x < 0.30 and k > 2:                               # slices: the same owner again within minutes
                for dk in (40, 130):
                    s2 = sl + dk
                    if s2 < end and unit_of(s2) is unit_of(sl):
                        r2 = unit_of(s2).aswap(s2, o, mint, pool, sol=sol * float(rng.uniform(0.5, 1.5)), creator=dev,
                                               quote=quote, base=base, tokens=int(rng.integers(1, 10**6)))
                        r2["signer_sol_pre"], r2["signer_sol_post"] = float(rng.integers(1, 9)) * 1e10, \
                            float(rng.choice([1e8, 3e8, 2e9, 5e9, 9e9]))
            if rng.random() < 0.05:
                unit_of(sl).t.append({"slot": sl, "tx_idx": r["tx_idx"], "outer_ix": 0, "inner_ix": 1, "mint": mint,
                                      "kind": str(rng.choice(["transfer", "transfer", "mint", "burn"])),
                                      "from_owner": o, "to_owner": owners[int(rng.integers(0, 70))],
                                      "amount": int(rng.integers(1, 10**5))})
            if rng.random() < 0.03:
                unit_of(sl).f.append({"slot": sl, "block_time": T0 + sl, "signature": f"f{i}_{k}", "venue": "pumpswap",
                                      "pool_or_curve": pool, "err_class": str(rng.choice(["slippage", "state", "other"]))})
        for k in range(3):                                         # failed racers at the migration slot
            u.f.append({"slot": m_slot + k, "block_time": T0 + m_slot + k, "signature": f"r{i}_{k}", "venue": "pumpswap",
                        "pool_or_curve": pool, "err_class": "slippage"})
        u.aswap(m_slot, f"seat{i}", mint, pool, sol=2e9, creator=dev, quote=quote, base=base)
    for k in units:                                                # W links, with a hub of more than 50 owners
        u = units[k]
        for j in range(8):                                         # small clusters among w0..w23
            a = int(rng.integers(0, 12)) * 2
            u.w.append({"slot": u.lo + int(rng.integers(0, UNIT_SLOTS)), "from": owners[a],
                        "to": owners[a + int(rng.integers(1, 3))]})
        u.w.append({"slot": u.lo + 3, "from": f"D{k}", "to": owners[k * 3]})
    for j in range(55):
        units[0].w.append({"slot": 7, "from": "HUB", "to": f"h{j}" if j < 53 else owners[j - 50]})
    out = [(units[k], d) for d, k in spans]
    order = rng.permutation(len(out))
    return [out[i] for i in order]


def write_units(units, d, cf_seed=0):
    paths = []
    rng = np.random.default_rng(cf_seed)
    for u, day in units:
        p = u.write(d, day)
        cf = pd.DataFrame({"slot": [u.lo + 5, u.lo + 9], "creator": [f"D{int(rng.integers(0, 5))}", "zz"],
                           "amount": [100, 200], "event": ["CollectCoinCreatorFeeEvent"] * 2})
        cf.to_csv(os.path.join(p, "research", "CF.csv.zst"), index=False, compression="zstd")
        paths.append(p)
    return paths


def minutes_for(t0=T0 - 7200, t1=T0 + 4 * UNIT_SLOTS + 7200):
    idx = np.arange(t0 // 60 * 60, t1, 60)
    return pd.Series(200.0 + (idx % 7), index=idx)


PX = {DAY0: (200.0, 195.0, 206.0), DAY1: (199.0, 190.0, 210.0)}


def _summary(o):
    with open(os.path.join(o, "stepa_summary.json")) as fh:
        return json.load(fh)


class StreamEquality(unittest.TestCase):
    """The streaming reader writes byte-identical files (every CSV and the summary, outcome rows included) to the
    in-memory reader, on the fixtures and on random multi-unit, two-day inputs, for several shard counts."""

    def _same(self, paths, minutes, shards=(3,), sol_usd=PX, n_boot=60):
        import run_step_a as RS
        ref = tempfile.mkdtemp()
        RS.run(paths, ref, sol_usd=sol_usd, n_boot=n_boot, minutes=minutes, engine="memory")
        files = sorted(f for f in os.listdir(ref) if f.endswith(".csv") or f.endswith(".json"))
        self.assertGreater(len(files), 14)
        for k in shards:
            o = tempfile.mkdtemp()
            RS.run(paths, o, sol_usd=sol_usd, n_boot=n_boot, minutes=minutes, engine="stream", shards=k)
            self.assertEqual(sorted(f for f in os.listdir(o) if f.endswith(".csv") or f.endswith(".json")), files)
            for f in files:
                self.assertTrue(filecmp.cmp(os.path.join(ref, f), os.path.join(o, f), shallow=False), (k, f))
        return ref

    def test_fixtures(self):
        for u in (TR.dev_unit(), TR.rebuy_unit(), TR.slicer_unit(), TR.migseat_unit(), TR.mayhem_unit(),
                  TR.SeatDrift()._unit()):
            d = tempfile.mkdtemp()
            self._same([u.write(d)], TR.CompactReader()._minutes(), shards=(2,), sol_usd={TR.DAY: 200.0})

    def test_random_two_days_four_units(self):
        for seed, shards in ((1, (3, 1)), (2, (5,))):
            d = tempfile.mkdtemp()
            ref = self._same(write_units(random_units(seed), d, seed), minutes_for(), shards=shards)
            s = _summary(ref)                                     # the input reaches every row
            self.assertGreater(s["1_dev_zero"]["le5"]["events_used"], 0)
            self.assertGreater(s["2_rebuy_anchor"]["decision_points"], 0)
            self.assertGreater(s["8_slicer_ride"]["events"], 0)
            self.assertGreater(s["8_slicer_ride"]["dispersed_controls"], 0)
            self.assertGreater(s["fake_demand_rows"], 0)
            self.assertGreater(s["10_mayhem_snap"]["reprice_rows"], 0)

    def test_edges_midnight_empty_unit_and_v1(self):
        e = TR.CompactReaderEdges()
        d = tempfile.mkdtemp()
        late = e._edge_unit(5000, 9999, shift=5000)
        early = e._edge_unit(0, 4999)
        early.aswap(4990, "x9", "EM", "EP", sol=5e8)
        late.aswap(5003, "x9", "EM", "EP", sol=5e8, buy=False)
        empty = Unit(10000, 10999)
        paths = [late.write(d, TR.DAY), empty.write(d, TR.DAY), early.write(d, DAY0)]
        self._same(paths, TR.CompactReader()._minutes(), shards=(2, 4))
        d2 = tempfile.mkdtemp()
        self._same([e._write_v1(e._edge_unit(), d2)], TR.CompactReader()._minutes(), shards=(3,))

    def test_heavy_mints_streamed_apart(self):
        """A mint with many swaps and no SOL quote (pools with WSOL as the base) is streamed row by row, not held in a
        shard; a busy mint with one SOL-quoted swap stays in its shard. Outputs stay identical."""
        import stream
        from unittest import mock
        units = random_units(5)
        rng = np.random.default_rng(55)
        for u, day in units:
            for i in range(60):
                sl = u.lo + int(rng.integers(0, UNIT_SLOTS))
                r = u.aswap(sl, f"w{int(rng.integers(0, 70))}", "BIGM", f"PB{i % 4}", buy=bool(rng.random() < 0.6),
                            creator=f"D{i % 3}")
                r["quote_mint"], r["canonical"] = "USDCxx", 0
                if i == 0 and u.lo == 0:
                    r["signature"], r["top_program"] = "mh9_0", MAYHEM_PROGRAM   # shares a re-price signature
                r2 = u.aswap(sl, f"w{int(rng.integers(0, 70))}", "BUSY", f"PC{i % 2}", buy=bool(rng.random() < 0.5))
                if i:
                    r2["quote_mint"] = "USDCxx"                       # one SOL-quoted swap: not heavy
        d = tempfile.mkdtemp()
        paths = write_units(units, d, 5)
        with mock.patch.object(stream, "HEAVY_ROWS", 50):
            t = stream.StreamTape(paths, shards=3)
            self.assertEqual(t.heavy_mints, {"BIGM"})
            t.cleanup()
            self._same(paths, minutes_for(), shards=(3, 1))

    def test_without_sol_usd(self):
        d = tempfile.mkdtemp()
        self._same(write_units(random_units(3), d, 3), None, shards=(2,), sol_usd=None)

    def test_a_pool_with_two_base_mints_is_refused(self):
        import stream
        u = Unit(0, 999)
        u.aswap(10, "a", "M1", "P")
        u.aswap(11, "b", "M2", "P")
        d = tempfile.mkdtemp()
        with self.assertRaises(stream.StreamError):
            stream.StreamTape([u.write(d)], shards=2)

    def test_frozen_ctx_refuses_a_point_not_checked_on_its_shard(self):
        import stream
        d = tempfile.mkdtemp()
        t = stream.StreamTape([TR.rebuy_unit().write(d)], shards=1)
        ctx = stream.FrozenCtx(t, TR.flat_hourly(200.0), {})
        with self.assertRaises(stream.StreamError):
            ctx.check("P", T0 + 3600, 3600, 1e11, 5)
        t.cleanup()

    def test_connected_labels_equal_rows_components(self):
        import rows as R
        import stream
        rng = np.random.default_rng(0)
        for _ in range(30):
            n = 150
            e = rng.integers(0, n, (int(rng.integers(0, 260)), 2))
            lab = stream.connected_labels(e[:, 0], e[:, 1], n)
            ref = R.components(e[:, 0].tolist(), e[:, 1].tolist())
            for x in ref:
                for y in ref:
                    self.assertEqual(ref[x] == ref[y], lab[x] == lab[y])

    def test_graph_and_fast_index_equal_the_tape_ones(self):
        """creator groups, degrees, as-of links, W groups and the fast-class index against the Tape's own."""
        import migseat as MS
        import rows as R
        import slicer as SL
        import stream
        d = tempfile.mkdtemp()
        paths = write_units(random_units(4), d, 4)
        tape = TR.Tape(paths)
        st = stream.StreamTape(paths, shards=2)
        adj = R.adjacency(tape.links)
        ts = R.TwoSidedAsOf(tape, tape.swaps)
        owners = sorted(set(tape.links["from_owner"].astype(object)) | {"nobody"})
        for o in owners:
            for sl in (0, 7, 20000, 45000, 90000):
                self.assertEqual(R.degree_as_of(adj, o, sl), st.graph.degree_as_of(o, sl))
                self.assertEqual(R.creator_group(adj, {o}, sl), R.creator_group(st.graph, {o}, sl))
                self.assertEqual(ts._links(o, sl), st.graph.before(o, sl))
                self.assertEqual(MS.w_group(tape, {o}, sl), st.w_graph.within({o}, sl))
        labels, _ = R.two_sided_clusters(tape)
        s = R.prepare(tape, labels)
        sts = stream.StreamTwoSided(st.graph, tape.swaps)
        x = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
        for mint, owner in sorted(set(zip(x["mint"].astype(object), x["owner"].astype(object))))[:400]:
            for sl in (20000, 45000, 90000):
                self.assertEqual(ts.labelled(mint, owner, sl), sts.labelled(mint, owner, sl), (mint, owner, sl))
        fb = R.w1_fast_buys(tape, s)
        ref = SL.FastAsOf(fb)
        idx = stream._pass_a(st, lambda *a: None)
        fast = R.w1_fast_class(tape, s)
        fm = stream.FastMap(idx)
        self.assertEqual((int(fast.sum()), len(fast)), (fm.sum(), len(fm)))
        for day, owner in set(zip(fb["day"].astype(object), fb["owner"].astype(object))):
            self.assertEqual(bool(fast.get((day, owner), False)), fm.get((day, owner), False))
            for slot in (0, 100, 20000, 40001, 60000, 90000):
                self.assertEqual(ref(day, owner, slot), idx(day, owner, slot))
                self.assertEqual(ref.before(day, owner, slot), idx.before(day, owner, slot))
        st.cleanup()


FLOW_COLUMNS = {"net", "ftb_sol_all", "ftb_sol_late", "holder_sell_late", "net_rebuy_flow", "rebuy_2h", "w1_ftb_sol",
                "w2_ftb_sol", "w1_share", "w2_share", "step_sol", "cont", "a_hit", "fast_ratio", "unclassed_ratio",
                "bait", "up", "dt", "seat_buys", "payer_sol", "first_min_sol", "group_sold_share", "racers"}


class PrepOnly(unittest.TestCase):
    """--prep-only runs the preparation stages only: it never calls an outcome, flow, bootstrap, summary-statistic,
    payer or gate function, never imports payer.py or run_step_a.py, and writes no flow column."""

    OUTCOME = [("rows", ["boot_lb_clustered", "dev_summary", "seat_summary", "age_gate_finish", "round_usd",
                         "mcap_segments", "gate3_split", "gate3_summary", "dev_zero_decide", "seat_drift_decide",
                         "slot_at_time", "band_time", "log_ratio"]),
               ("rebuy", ["summarise", "odds_ratio", "materiality_sets", "stratum_diff", "rebuy_decide"]),
               ("slicer", ["slicer_finish", "slicer_rows", "measure", "_cells"]),
               ("migseat", ["arm_rows", "mig_seat_finish", "_followed", "_non_agent_sell_hits", "non_agent_sell_placebo",
                            "x_star"]),
               ("h8", ["dev_zero_stratum", "rebuy_stratum", "seat_drift_stratum"])]

    def test_prep_never_calls_outcome_code(self):
        from unittest import mock
        import importlib
        import stream
        patches = []

        def boom(name):
            def f(*a, **k):
                raise AssertionError(f"prep called {name}")
            return f
        for mod, names in self.OUTCOME:
            m = importlib.import_module(mod)
            for n in names:
                patches.append(mock.patch.object(m, n, boom(f"{mod}.{n}")))
        d = tempfile.mkdtemp()
        paths = write_units(random_units(1), d, 1)
        o = tempfile.mkdtemp()
        for p in patches:
            p.start()
        try:
            summ = stream.run_prep(paths, o, minutes=minutes_for(), shards=3)
        finally:
            for p in patches:
                p.stop()
        self.assertGreater(summ["table_rows"]["dev_zero_candidates"], 0)
        self.assertGreater(summ["table_rows"]["slicer_events_asof"], 0)
        self.assertGreater(summ["table_rows"]["rebuy_points_asof"], 0)
        for f in os.listdir(o):
            if f.endswith(".csv"):
                cols = set(pd.read_csv(os.path.join(o, f), nrows=0).columns)
                self.assertFalse(cols & FLOW_COLUMNS, (f, cols & FLOW_COLUMNS))
        text = open(os.path.join(o, "prep_summary.json")).read()
        for word in ("lb95", "median_net_excess", "passed", "odds_ratio", "share_followed_by_up", "decision"):
            self.assertNotIn(word, text)

    def test_prep_does_not_import_the_scoring_modules(self):
        d = tempfile.mkdtemp()
        paths = write_units(random_units(2), d, 2)
        o = tempfile.mkdtemp()
        here = os.path.dirname(os.path.abspath(__file__))
        code = ("import sys, json; sys.path.insert(0, %r); import stream, pandas as pd, numpy as np; "
                "idx = np.arange(%d, %d, 60); stream.run_prep(%r, %r, minutes=pd.Series(200.0, index=idx), shards=2); "
                "print(json.dumps(sorted(m for m in ('payer', 'run_step_a') if m in sys.modules)))"
                % (here, (T0 - 7200) // 60 * 60, T0 + 4 * UNIT_SLOTS + 7200, paths, o))
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout.strip().splitlines()[-1]), [])

    def test_prep_tables_equal_the_full_run_before_the_outcome(self):
        """The prep tables hold the same events, points and features as the full run (their pre-outcome columns)."""
        import run_step_a as RS
        import stream
        d = tempfile.mkdtemp()
        paths = write_units(random_units(1), d, 1)
        full, prep = tempfile.mkdtemp(), tempfile.mkdtemp()
        RS.run(paths, full, sol_usd=PX, n_boot=20, minutes=minutes_for(), engine="memory")
        stream.run_prep(paths, prep, minutes=minutes_for(), shards=2)
        pairs = (("rebuy_points", "rebuy_points_asof"), ("rebuy_pairs", "rebuy_pairs_asof"),
                 ("rebuy_exits", "rebuy_exits"), ("age_gate", "age_gate_anchor_ages"),
                 ("two_sided_labels", "two_sided_labels"), ("h8_pool_hours", "h8_pool_hours"),
                 ("h8_graduates", "h8_graduates"), ("slicer_events", "slicer_events_asof"),
                 ("slicer_low_b_placebo", "slicer_low_b_placebo_asof"), ("slicer_controls", "slicer_controls_asof"))
        for a, b in pairs:
            x = pd.read_csv(os.path.join(full, f"stepa_{a}.csv"))
            y = pd.read_csv(os.path.join(prep, f"prep_{b}.csv"))
            self.assertTrue(set(y.columns) <= set(x.columns), (a, set(y.columns) - set(x.columns)))
            pd.testing.assert_frame_equal(x[list(y.columns)], y, obj=a)
        x = pd.read_csv(os.path.join(full, "stepa_seat_drift.csv"))
        y = pd.read_csv(os.path.join(prep, "prep_seat_drift_graduates.csv"))
        pd.testing.assert_frame_equal(x[list(y.columns)], y)
        x = pd.read_csv(os.path.join(full, "stepa_dev_zero.csv"))
        y = pd.read_csv(os.path.join(prep, "prep_dev_zero_candidates.csv"))
        cols = ["arm", "kind", "pool", "mint", "day", "slot", "block_time", "dev", "share_pre", "share_post"]
        pd.testing.assert_frame_equal(x[cols], y[cols])
        # the full run's extra drop reads after the event; prep leaves it to the scoring run
        same = x["dropped"] != "dev_sold_again_in_window"
        self.assertTrue((x.loc[same, "dropped"].fillna("") == y.loc[same, "dropped"].fillna("")).all())


if __name__ == "__main__":
    unittest.main()
