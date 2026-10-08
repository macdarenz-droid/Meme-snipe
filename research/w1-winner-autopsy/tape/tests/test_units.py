"""Addresses, costs (incl. AMENDMENT_1's fixture), venue math, clusters, classes, persistence statistics, the tree
and the replay, on small synthetic inputs."""
import json
import os
import unittest

import numpy as np
import pandas as pd

from fixtures import address
from w1 import addr, classes, clusters, costs, persist, rules, venue

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


class Addresses(unittest.TestCase):
    def test_on_curve(self):
        self.assertTrue(addr.on_curve(address("w1")))
        self.assertFalse(addr.on_curve(address("p1", curve=False)))
        self.assertFalse(addr.on_curve("not-base58!"))
        self.assertFalse(addr.on_curve("1111"))                  # not 32 bytes
        self.assertEqual(len(addr.short_hash("abc")), 12)


class Costs(unittest.TestCase):
    def test_fixed_round_trip_matches_edge_costs(self):
        with open(os.path.join(REPO, "research", "edge", "costs.json")) as f:
            want = json.load(f)["rows"][0]["fixedLamports"]
        self.assertEqual(round(costs.FIXED_ROUND_TRIP), want)
        self.assertEqual(costs.REPLAY_SPEND, round(50 / 119.26 * 1e9))
        self.assertAlmostEqual(costs.REPLAY_SPEND / 1e9, 0.4193, places=4)

    def test_amendment_fallback_on_known_fee_priority_and_tip(self):
        # signer pays a 0.5 SOL buy (fees included), base fee 5,000, priority 20,000, tip 10,000, ATA rent 2,039,280
        base, prio, tip, rent, buy = 5_000, 20_000, 10_000, 2_039_280, 500_000_000
        pre = 3_000_000_000
        post = pre - buy - base - prio - tip - rent
        self.assertEqual(costs.amendment_tx_cost(pre, post, -buy, rent_change=-rent), base + prio + tip)
        # rent the worker cannot identify stays in the cost
        self.assertEqual(costs.amendment_tx_cost(pre, post, -buy), base + prio + tip + rent)


class Venue(unittest.TestCase):
    def test_vector_mark_matches_integer_quote(self):
        rng = np.random.default_rng(1)
        for _ in range(200):
            vsr, vtr = int(rng.integers(30e9, 85e9)), int(rng.integers(2e14, 1.07e15))
            rsr, rtr = vsr - 30_000_000_000, int(rng.integers(1, 7.9e14))
            q = int(rng.integers(1, 5e13))
            c = ("c", vsr, vtr, rsr, rtr, 125)
            a = ("a", int(rng.integers(1e13, 2e14)), int(rng.integers(1e9, 1e11)), int(rng.integers(-1e9, 2e10)), 30)
            for s, kind, s4 in ((c, 0, c[4]), (a, 1, 0)):
                v, ok = venue.sell_vec([kind], [s[1]], [s[2]], [s[3]], [s4], [s[-1]], [q])
                self.assertTrue(ok[0])
                self.assertLessEqual(abs(v[0] - venue.sell(s, q)), 2)

    def test_sell_capped_by_real_reserves_and_complete_curve(self):
        self.assertEqual(venue.curve_sell(("c", 10**11, 10**14, 5, 10**12, 0), 10**14), 5)
        self.assertEqual(venue.curve_sell(("c", 10**11, 10**14, 10**10, 0, 0), 10**12), 0)
        self.assertEqual(venue.pool_sell(("a", 10**12, 7, 10**11, 0), 10**12), 7)

    def test_round_trip_loses_fees_and_impact(self):
        for s in (("c", 40 * 10**9, 8 * 10**14, 10 * 10**9, 5 * 10**14, 125), ("a", 2 * 10**14, 80 * 10**9, 0, 30)):
            tok, after = venue.buy_exact_in(s, 10**9)
            self.assertGreater(tok, 0)
            self.assertLess(venue.sell(after, tok), 10**9)


class Clusters(unittest.TestCase):
    def day(self, owners, wedges, tedges=(), excluded=(), name="2026-09-10"):
        return {"day": name, "owners": np.array(owners, np.int64), "wedges": np.array(wedges, np.int64).reshape(-1, 2),
                "tedges": np.array(tedges, np.int64).reshape(-1, 2), "w_present": True,
                "hub_excluded_nodes": np.array(excluded, np.int64)}

    def test_direct_links_join_and_hubs_do_not(self):
        owners = list(range(1, 60)) + [100]
        # 1-2 direct; 100 links to 55 owners (a hub); 70 is a non-owner funder of 3 and 4
        w = [(1, 2)] + [(100, i) for i in range(3, 58)] + [(70, 3), (70, 4)]
        t, info = clusters.build([self.day(owners, w)], "2026-09-10")
        self.assertEqual(t[1], t[2])
        self.assertNotEqual(t[3], t[4])            # literal reading: no joining through a non-owner
        self.assertNotEqual(t[3], t[5])            # not through the hub
        self.assertEqual(info["hubs"], 1)
        t2, _ = clusters.build([self.day(owners, w)], "2026-09-10", via_non_owners=True)
        self.assertEqual(t2[3], t2[4])

    def test_only_links_on_or_before_the_day(self):
        d1 = self.day([1, 2], [], name="2026-09-10")
        d2 = self.day([1, 2], [(1, 2)], name="2026-09-11")
        t, _ = clusters.build([d1, d2], "2026-09-10")
        self.assertNotEqual(t[1], t[2])
        t, _ = clusters.build([d1, d2], "2026-09-11")
        self.assertEqual(t[1], t[2])

    def test_excluded_address_never_joins(self):
        t, _ = clusters.build([self.day([1, 2, 3], [(1, 3), (3, 2)], excluded=[3])], "2026-09-10")
        self.assertNotEqual(t[1], t[2])


class Classes(unittest.TestCase):
    def test_fast_and_slow(self):
        trader = pd.Series([1, 2, 3, 4], index=[1, 2, 3, 4])
        # owner 1: 1 of 5 buys within 2 slots of a create -> 20% -> fast
        # owner 2: 2 of 5 buys follow owner 4's 1 SOL buys within 2 slots -> 40% -> fast
        # owner 3: follows only its own big buys -> slow
        buys = pd.DataFrame({
            "owner": [1] * 5 + [2] * 5 + [3] * 3,
            "mint": [9, 8, 8, 8, 8] + [7] * 5 + [6] * 3,
            "slot": [102, 300, 400, 500, 600] + [1001, 1002, 1500, 1600, 1700] + [2001, 2002, 2003],
            "key": [0] * 13, "jito": [False] * 13, "lag": [1.0] * 13})
        buys["key"] = buys["slot"] * 1000 + 5
        big = pd.DataFrame({"owner": [4, 3, 3], "mint": [7, 6, 6], "slot": [1000, 2000, 2001]})
        big["key"] = big["slot"] * 1000
        cg = pd.DataFrame({"mint": [9], "slot": [100], "kind": [0]})
        out = classes.classify({"buys": buys, "big": big, "cg": cg}, trader)
        self.assertTrue(out.loc[1, "fast"])
        self.assertTrue(out.loc[2, "fast"])
        self.assertFalse(out.loc[3, "fast"])
        self.assertEqual(out.loc[2, "follow"], 2)

    def test_other_trader_found_behind_own_big_buys(self):
        trader = pd.Series([1, 2], index=[1, 2])
        buys = pd.DataFrame({"owner": [1], "mint": [5], "slot": [12], "key": [12_500], "jito": [True], "lag": [0.0]})
        big = pd.DataFrame({"owner": [2, 1], "mint": [5, 5], "slot": [10, 11], "key": [10_000, 11_000]})
        self.assertTrue(classes.follows_big_buy(buys, big, trader)[0])
        big2 = pd.DataFrame({"owner": [2, 1], "mint": [5, 5], "slot": [9, 11], "key": [9_000, 11_000]})
        self.assertFalse(classes.follows_big_buy(buys, big2, trader)[0])


class Persistence(unittest.TestCase):
    def groups(self, top_mean, mid_mean, n=40, k=10, seed=0):
        rng = np.random.default_rng(seed)
        mk = lambda m: (np.array([rng.normal(m, 0.1, k).sum() for _ in range(n)]), np.full(n, float(k)))
        return {"top": mk(top_mean), "mid": mk(mid_mean)}

    def test_bootstrap_is_seeded_and_bounds_follow_the_effect(self):
        g = self.groups(0.2, 0.0)
        b1, b2 = persist.bootstrap(g, b=2000), persist.bootstrap(g, b=2000)
        np.testing.assert_array_equal(b1, b2)
        v = persist.validation_verdict(g, b1, replay_mean=0.01)
        self.assertTrue(v["lower_above_0"] and v["pass"])
        v = persist.validation_verdict(g, b1, replay_mean=-0.01)
        self.assertEqual(v["verdict"], "persistent, but not at our speed or cost")
        d = persist.discovery_verdict(self.groups(-0.2, 0.0), persist.bootstrap(self.groups(-0.2, 0.0), b=2000))
        self.assertTrue(d["futility_stop"])

    def test_lift_is_pooled_trade_mean(self):
        g = {"top": (np.array([3.0, 1.0]), np.array([3.0, 1.0])), "mid": (np.array([0.0]), np.array([2.0]))}
        self.assertAlmostEqual(persist.lift(g), 1.0)

    def test_gate_verdict(self):
        self.assertTrue(persist.gate_verdict([{"day": "a", "slow_traders_20plus": 250},
                                              {"day": "b", "slow_traders_20plus": 150}])["kill"])


class Tree(unittest.TestCase):
    def test_tree_finds_the_rule_and_respects_limits(self):
        rng = np.random.default_rng(3)
        n = 600
        X = rng.uniform(0, 1, (n, len(rules.FEATURES)))
        y = ((X[:, 0] > 0.7) & (X[:, 1] < 0.5)).astype(float)
        X[:, 2] = rules.MISSING
        tree = rules.fit_tree(X, y)
        depth = lambda nd: 0 if "f" not in nd else 1 + max(depth(nd["left"]), depth(nd["right"]))
        self.assertLessEqual(depth(tree), 3)
        for _, leaf in rules.leaves(tree):
            self.assertGreaterEqual(leaf["n"], int(np.ceil(0.05 * n)))
        path, leaf = rules.best_leaf(tree)
        self.assertGreater(leaf["share"], 0.9)
        self.assertEqual({p[0] for p in path} & {0, 1}, {0, 1})
        r = rules.extract(X[y == 1], np.full(int(y.sum()), 40.0), X[y == 0])
        self.assertEqual(r["hold_slots"], 40.0)
        self.assertEqual(rules.fit_tree(X, y), tree)          # deterministic


class Replay(unittest.TestCase):
    def test_entry_and_exit_use_states_23_slots_later(self):
        from w1 import replay
        from w1.load import make_key
        rows = pd.DataFrame({"mint": [1, 1, 1], "cls": [1, 1, 1],
                             "key": make_key([100, 123, 200], [0, 0, 0], [0, 0, 0]),
                             "kind": [1, 1, 1], "s1": [10**14, 5 * 10**13, 10**14],
                             "s2": [10**10, 2 * 10**10, 4 * 10**10], "s3": [0, 0, 0], "s4": [0, 0, 0],
                             "bps": [30, 30, 30]})
        from w1.ledger import States
        st = States().asof(rows, [1, 1], make_key([123, 122], [replay.END_OF_SLOT] * 2, [255] * 2))
        self.assertEqual(int(st["s2"][0]), 2 * 10**10)       # the trade in slot 123 is seen at the end of slot 123
        self.assertEqual(int(st["s2"][1]), 10**10)

    def test_fee_free_rows_never_set_the_fee_R2_8(self):
        """R2-8: BOOST slices and protocol swaps carry fee fields of 0. A state after one keeps its reserves but the
        fee rate of the venue's last fee-paying row (or, before the first one, the next one), so replays and marks
        never trade fee-free; carried states from earlier units count as fee-paying rows."""
        from w1 import replay
        from w1.ledger import States
        from w1.load import make_key
        rows = pd.DataFrame({"mint": [1, 1, 1, 2, 2], "cls": [1, 1, 1, 1, 1],
                             "key": make_key([100, 110, 120, 100, 110], [0] * 5, [0] * 5),
                             "kind": [1] * 5, "s1": [10**14] * 5, "s2": [10**10, 2 * 10**10, 3 * 10**10, 10**10, 10**10],
                             "s3": [0] * 5, "s4": [0] * 5, "bps": [125, 0, 0, 0, 125]})
        q = make_key([110, 120], [replay.END_OF_SLOT] * 2, [255] * 2)
        st = States().asof(rows, [1, 1], q)
        self.assertEqual([int(x) for x in st["bps"]], [125, 125])
        self.assertEqual([int(x) for x in st["s2"]], [2 * 10**10, 3 * 10**10])   # reserves still move
        h = States()
        h.advance(rows.iloc[:1])                                 # an earlier unit's last fee-paying state
        st = h.asof(rows.iloc[1:3].reset_index(drop=True), [1], make_key([120], [replay.END_OF_SLOT], [255]))
        self.assertEqual(int(st["bps"][0]), 125)
        tok_free, _ = venue.buy_exact_in(("a", 10**14, 10**10, 0, 0), 4 * 10**8)
        tok, _ = venue.buy_exact_in(("a", 10**14, 10**10, 0, int(st["bps"][0])), 4 * 10**8)
        self.assertLess(tok, tok_free)

    def test_replay_rent_by_date_R2_12(self):
        """R2-12 (parent's ruling on Q-R2-c): the §7 replay and §8 rule test charge rent by date, as D1, G1 and H1:
        (128 + 170) x lamports per byte at the entry (6,960 / 6,333 / 5,080), with RENT-1's refund model."""
        from w1 import replay
        from w1.load import make_key
        e1033 = 1033 * costs.EPOCH_SLOTS
        rows = pd.DataFrame({"mint": [1, 1], "cls": [1, 1], "key": make_key([e1033 - 1000, e1033 - 900], [0, 0], [0, 0]),
                             "kind": [1, 1], "s1": [10**14] * 2, "s2": [10**11] * 2, "s3": [0, 0], "s4": [0, 0],
                             "bps": [125, 125]})
        fires = pd.DataFrame({"mint": [1], "slot": [e1033 - 990], "day": ["2026-09-08"]})
        t = rules.rule_test_trades(fires, fires.iloc[:0], rows, 50)
        st = ("a", 10**14, 10**11, 0, 125)
        tok, _ = venue.buy_exact_in(st, costs.REPLAY_SPEND)
        fixed = costs.expected_fixed(298 * 6_333)
        self.assertAlmostEqual(t["ret"].iloc[0], (venue.sell(st, tok) - costs.REPLAY_SPEND - fixed) / costs.REPLAY_SPEND)
        self.assertEqual(costs.fixed_round_trip("2026-09-02", 0), costs.expected_fixed(298 * 6_960))
        self.assertEqual(costs.fixed_round_trip("2026-09-11", e1033), costs.expected_fixed(298 * 5_080))
        self.assertEqual(costs.expected_fixed(), costs.FIXED_ROUND_TRIP)   # the repo figure, kept for the parity check

    def test_rent_boundary_is_the_first_slot_of_epoch_1028_R2_13(self):
        """R2-13 (RENT_BOUNDARY.md): 6,333 starts at slot 444,096,000 (2026-09-03 23:24:41 UTC), not at 00:00 UTC."""
        self.assertEqual(costs.lamports_per_byte("2026-09-03", 443_990_000), 6_960)   # 09-03 12:00, epoch 1027
        self.assertEqual(costs.lamports_per_byte("2026-09-03", 444_095_999), 6_960)
        self.assertEqual(costs.lamports_per_byte("2026-09-03", 444_096_000), 6_333)
        self.assertEqual(costs.fixed_round_trip("2026-09-03", 443_990_000), costs.expected_fixed(298 * 6_960))
        self.assertEqual(costs.rent_candidates("2026-09-03", 444_095_999), (293 * 6_960, 298 * 6_960))

    def test_no_fee_paying_row_yet_uses_the_dearest_rate_R2_11(self):
        """R2-11: before the venue's first fee-paying row, a later row's rate is never used (look-ahead, and cheaper);
        the quote pays the dearest rate (ledger.FALLBACK_BPS: PumpSwap's dearest tier; the curve's 95 + 30)."""
        import json
        from w1 import ledger, replay
        from w1.ledger import States
        from w1.load import make_key
        rows = pd.DataFrame({"mint": [2, 2], "cls": [1, 1], "key": make_key([100, 110], [0, 0], [0, 0]),
                             "kind": [1, 1], "s1": [10**14] * 2, "s2": [10**10] * 2, "s3": [0, 0], "s4": [0, 0],
                             "bps": [0, 30]})
        st = States().asof(rows, [2, 2], make_key([100, 110], [replay.END_OF_SLOT] * 2, [255] * 2))
        self.assertEqual([int(x) for x in st["bps"]], [ledger.FALLBACK_BPS[1], 30])
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "..", "..", "edge", "snapshot", "fee-configs.json")) as fh:
            tiers = json.load(fh)["amm"]["fee_tiers"]
        self.assertEqual(ledger.FALLBACK_BPS[1], max(sum(int(v) for v in t["fees"].values()) for t in tiers))


if __name__ == "__main__":
    unittest.main()


class Pipeline(unittest.TestCase):
    def test_rank_test_bootstrap_on_synthetic_days(self):
        from test_leak import synth_day
        d1, d2 = synth_day("2026-09-07", seed=1), synth_day("2026-09-08", seed=2)
        trader, _ = clusters.build([d1, d2], "2026-09-07")
        ranked, info = persist.rank(d1, trader)
        self.assertEqual(info["ranked"], 40)
        self.assertEqual(sorted(ranked["decile"].unique().tolist()), list(range(1, 11)))
        self.assertTrue((ranked.groupby("decile")["t"].min().diff().dropna() > 0).all())
        tp, rep = persist.test_day_returns(d2, trader, ranked)
        self.assertEqual(rep[10]["eligible_5plus"], 4)
        g = persist.groups(tp)
        self.assertEqual(len(g["top"][0]), 4)
        self.assertEqual(len(g["mid"][0]), 8)
        self.assertTrue(np.isfinite(persist.bootstrap(g, b=500)).all())

    def test_scoring_stages_refuse_without_flag(self):
        from w1 import run
        for stage in (["gate", "--days", "2026-09-10"], ["discovery", "--rank", "2026-09-10", "--test", "2026-09-11"],
                      ["validation", "--rank", "2026-09-07", "--test", "2026-09-08"]):
            with self.assertRaises(SystemExit) as e:
                run.main([stage[0], "--work", "/nonexistent"] + stage[1:])
            self.assertIn("--score", str(e.exception.code))


class ReplayAndFeaturesOnTape(unittest.TestCase):
    def test_replay_and_features_read_fixture_units(self):
        import tempfile
        from fixtures import Unit
        from w1 import load, replay
        from w1.ledger import Ledger
        with tempfile.TemporaryDirectory() as root:
            u = Unit(root, "2026-09-08", 446_004_500, 446_008_999)
            mint, pool, a, b = address("m"), address("p", False), address("a"), address("b")
            base, vault = 2 * 10**14, 80 * 10**9
            for i, slot in enumerate([446_004_510, 446_004_540, 446_004_600]):
                u.amm(slot, 1, 0, a if i == 0 else b, mint, pool, "buy", 10**12, 10**9, base - i * 10**12,
                      vault + i * 10**9, 0, pre=0, post=10**12)
            u.write()
            units = load.parse_units([u.dir])
            v = load.Vocab()
            led = Ledger(v)
            led.process_unit(units[0])
            m = v.get(mint)
            trades = pd.DataFrame({"mint": [m], "day": ["2026-09-08"], "entry_slot": [446_004_510], "exit_slot": [446_004_580],
                                   "open_at_end": [False], "day_hi": [446_008_999]})
            out = replay.replay_trades(trades, units, v)
            # entry at the end of slot 533 sees only the first trade; exit at the end of 603 sees all three
            st_in = ("a", base - 10**12, vault + 10**9, 0, 30)
            tok, _ = venue.buy_exact_in(st_in, costs.REPLAY_SPEND)
            st_out = ("a", base - 3 * 10**12, vault + 3 * 10**9, 0, 30)
            fixed = costs.fixed_round_trip("2026-09-08", 446_004_533)          # R2-12: rent by date (6,333)
            self.assertEqual(fixed, costs.expected_fixed(298 * 6_333))
            want = (venue.sell(st_out, tok) - costs.REPLAY_SPEND - fixed) / costs.REPLAY_SPEND
            self.assertAlmostEqual(out["ret_replay"].iat[0], want)
            info = {"create": led.create, "migr": led.migr, "boost_done": led.boost_done}
            tapes = rules.tapes_for(units, v, {m}, info, lambda o: False)
            ent = pd.DataFrame({"mint": [m], "key": [int(load.make_key(446_004_600, 1, 0))],
                                "bt": [u.bt(446_004_600)], "paid": [10**9]})
            f = rules.entry_features(ent, tapes, info)
            self.assertEqual(list(f.columns), rules.FEATURES)
            self.assertEqual(f["buys_5m"].iat[0], 2)
            self.assertEqual(f["uniq_buyers_5m"].iat[0], 2)
            self.assertEqual(f["venue"].iat[0], 1)
            self.assertAlmostEqual(f["top10_share"].iat[0], 2 * 10**12 / 10**15)


class Reading(unittest.TestCase):
    def test_exact_ints_missing_values_and_overflow(self):
        import tempfile
        from w1 import load
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.csv.zst")
            pd.DataFrame({"slot": [1, 2, 3], "block_time": [10, 11, 12], "a": ["9007199254740993", "", "5"],
                          "s": ["x", "", "z"]}).to_csv(p, index=False, compression="zstd")
            t = load.read_table(p, ["slot", "block_time", "a", "s"], ["slot", "block_time", "a"])
            self.assertEqual(int(t["a"][0]), 9007199254740993)
            self.assertTrue(bool(t["a_na"][1]) and int(t["a"][1]) == 0)
            self.assertFalse(t["_overflow"].any())
            pd.DataFrame({"slot": [1, 2], "block_time": [10, 11], "a": ["18446744073709551615", "7"],
                          "s": ["x", "y"]}).to_csv(p, index=False, compression="zstd")
            t = load.read_table(p, ["slot", "block_time", "a", "s"], ["slot", "block_time", "a"])
            self.assertEqual(t["_overflow"].tolist(), [True, False])
            self.assertEqual(int(t["a"][1]), 7)
            pd.DataFrame({"slot": [1], "block_time": [load.WALL_TS], "a": [1], "s": ["x"]}).to_csv(
                p, index=False, compression="zstd")
            self.assertEqual(len(load.read_table(p, ["slot", "block_time", "a", "s"], ["slot", "block_time", "a"])), 0)
