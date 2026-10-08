"""§3 decision points and schedule, §4 features as of the decision slot, §9.1 planted future-marker test."""
import ast
import math
import os
import pathlib
import unittest

import pandas as pd

from h1cgo import features as F
from h1cgo.features import Clock, build_streams, compute_features, decision_points, schedule_windows
from tests.synth import AMM_COLS, CURVE_COLS, DAY0, T_COLS, amm_row, blocks, curve_row, frame, t_of, t_row, tcov, universe

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAST = 120_000  # slots read: 0 .. 120,000 (about 16.7 h)


class PoolChain:
    """Builds consistent PumpSwap rows: each row's pre-state is the previous row's post-state."""

    def __init__(self, base=200 * 10**12, vault=80 * 10**9, virtual=0):
        self.base, self.vault, self.virtual = base, vault, virtual
        self.rows = []

    def trade(self, slot, owner, side, base_amt, post=""):
        r = amm_row(slot, 1, owner, side, base_amt, self.base, self.vault, self.virtual, post=post)
        from h1cgo.pumpswap import amm_post_state
        _, p = amm_post_state(r)
        self.base, self.vault, self.virtual = p.base, p.vault, p.virtual
        self.rows.append(r)
        return r


def world(extra_amm=(), extra_t=(), unresolved=()):
    curve = [curve_row(20, 1, "A", True, 50 * 10**12, 10 * 10**9), curve_row(25, 1, "B", True, 30 * 10**12, 9 * 10**9),
             curve_row(500, 1, "B", False, 10 * 10**12, 2 * 10**9)]
    ch = PoolChain()
    ch.trade(1100, "C", "buy", 10 * 10**12)
    ch.trade(9000, "A", "sell", 20 * 10**12)
    ch.trade(16000, "D", "buy", 5 * 10**12)
    ch.trade(40000, "C", "sell", 4 * 10**12)
    ch.trade(70000, "E", "buy", 8 * 10**12)
    t = [t_row(12000, 1, "transfer", "B", "G", 5 * 10**12), t_row(30000, 1, "mint", "", "H", 10**12)]
    return dict(u=universe(mig_slot=1000), curve=frame(curve, CURVE_COLS), amm=frame(ch.rows + list(extra_amm), AMM_COLS),
                t=frame(t + list(extra_t), T_COLS), tcov=tcov(unresolved))


def run_world(w, last=LAST):
    clock = Clock.from_blocks(blocks(last))
    dp = schedule_windows(decision_points(w["u"], clock, [(0, last)]), clock)
    return compute_features(dp, build_streams(w["u"], w["curve"], w["amm"], w["t"], w["tcov"]))


def truncate(w, slot):
    keep = lambda df: df[df.slot.astype(int) <= slot]
    return dict(u=w["u"], curve=keep(w["curve"]), amm=keep(w["amm"]), t=keep(w["t"]), tcov=w["tcov"])


FEATURE_COLS = ["coverage", "rp", "rp_post", "cgo", "cgo_post", "p", "eff_quote", "vault", "r_1h", "r_6h", "r_mig",
                "known_tokens", "unknown_tokens", "n_holders", "eligible", "unresolved"]


def same(a, b):
    return all((isinstance(x, float) and math.isnan(x) and isinstance(y, float) and math.isnan(y)) or x == y
               for x, y in zip(a, b))


class Schedule(unittest.TestCase):
    def test_hours_and_decision_slots(self):
        clock = Clock.from_blocks(blocks(LAST))
        dp = decision_points(universe(mig_slot=1000), clock, [(0, LAST)])
        # migration at DAY0 + 500 s: first whole hour >= +60 min is DAY0 + 2 h; last hour readable ends the tape
        self.assertEqual(dp.hour.iloc[0], DAY0 + 7200)
        self.assertEqual(dp.decision_slot.iloc[0], 14399)  # last slot before the hour
        self.assertTrue((dp.hour.diff().dropna() == 3600).all())
        self.assertTrue(all(t_of(s) < h for s, h in zip(dp.decision_slot, dp.hour)))
        self.assertLessEqual(dp.hour.max(), t_of(1000) + 24 * 3600)
        self.assertEqual(set(dp.decision_day), {"2026-09-11"})

    def test_24h_cap_and_creation_interval(self):
        clock = Clock.from_blocks(blocks(200_000))
        dp = decision_points(universe(mig_slot=1000), clock, [(0, 200_000)])
        self.assertEqual(dp.hour.max(), DAY0 + 24 * 3600)  # mig + 24 h = DAY0 + 24h + 500 s -> last whole hour
        self.assertEqual(len(decision_points(universe(mig_slot=1000), clock, [(0, 5), (6 + 10**6, 2 * 10**6)])), 0)
        # a gap in the tape after slot 20,000: only the hour closed before the gap is a decision point
        self.assertEqual(len(decision_points(universe(mig_slot=1000), clock, [(0, 20_000), (20_002, 200_000)])), 1)

    def test_drop_by_time(self):
        clock = Clock.from_blocks(blocks(LAST))
        dp = schedule_windows(decision_points(universe(mig_slot=1000), clock, [(0, LAST)]), clock)
        r = dp.iloc[0]
        self.assertEqual(r.entry_slot, 14399 + 23)
        self.assertEqual(r.exit_slot_3600, (t_of(14422) + 3600 - DAY0) * 2 - 1 + 23)
        self.assertTrue(r.in_time_3600)
        late = dp[dp.exit_slot_3600 > LAST]
        self.assertTrue((~dp.in_time_3600[dp.exit_slot_3600 > LAST]).all())
        self.assertTrue((~dp.in_time_3600[dp.exit_slot_3600 < 0]).all())
        self.assertGreater(len(dp) - dp.in_time_3600.sum(), 0)
        del late


class AsOf(unittest.TestCase):
    def test_features_equal_on_tape_truncated_at_each_decision(self):
        w = world()
        full = run_world(w)
        self.assertGreater(len(full), 5)
        for _, r in full.iterrows():
            cut = run_world(truncate(w, int(r.decision_slot)))
            c = cut[cut.decision_slot == r.decision_slot].iloc[0]
            self.assertTrue(same(r[FEATURE_COLS].tolist(), c[FEATURE_COLS].tolist()), r.decision_slot)

    def test_planted_future_marker_is_invisible(self):
        base = run_world(world())
        d = int(base.decision_slot.iloc[1])
        # one slot after decision 2: a huge buy by MARKER and a movement to MARKER, plus an unresolved mark
        ch = PoolChain()
        ch.base, ch.vault, ch.virtual = (lambda p: (p.base, p.vault, p.virtual))(
            __import__("h1cgo.pumpswap", fromlist=["amm_post_state"]).amm_post_state(world()["amm"].iloc[2].to_dict())[1])
        marker = amm_row(d + 1, 9, "MARKER", "buy", 90 * 10**12, ch.base, ch.vault, ch.virtual)
        w = world(extra_amm=[marker], extra_t=[t_row(d + 1, 9, "transfer", "A", "MARKER", 10**12)],
                  unresolved=[("M", "unresolved", str(d + 1), "owner_change", "1", "9")])
        planted = run_world(w)
        for i in range(len(base)):
            before = base.iloc[i]
            after = planted.iloc[i]
            if before.decision_slot <= d:
                self.assertTrue(same(before[FEATURE_COLS].tolist(), after[FEATURE_COLS].tolist()))
        nxt = planted[planted.decision_slot > d].iloc[0]
        self.assertTrue(nxt.unresolved)  # the marker is seen once its slot has passed
        self.assertNotEqual(nxt.p, base[base.decision_slot > d].iloc[0].p)

    def test_feature_module_never_imports_outcomes_or_stats(self):
        tree = ast.parse(pathlib.Path(HERE, "h1cgo", "features.py").read_text())
        names = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom):
                names.add(n.module or "")
                names.update(a.name for a in n.names)
            elif isinstance(n, ast.Import):
                names.update(a.name for a in n.names)
        self.assertFalse({"outcomes", "stats", "h1cgo.outcomes", "h1cgo.stats"} & names)


class Eligibility(unittest.TestCase):
    def test_liquidity_coverage_and_unresolved(self):
        f = run_world(world())
        self.assertTrue(f.has_state.all())
        r = f.iloc[0]
        self.assertGreaterEqual(r.eff_quote, 50 * 10**9)
        self.assertTrue(r.eligible)
        self.assertAlmostEqual(r.p, r.eff_quote / (200 * 10**12 - 10 * 10**12 + 20 * 10**12), places=12)
        self.assertAlmostEqual(r.cgo, (r.p - r.rp) / r.p)
        # H's minted tokens have no known cost: coverage falls below 1 after slot 30,000
        later = f[f.decision_slot > 30000].iloc[0]
        self.assertLess(later.coverage, 1.0)
        w = world(unresolved=[("M", "unresolved", "20000", "owner_change", "1", "3")])
        g = run_world(w)
        self.assertTrue((g[g.decision_slot >= 20000].eligible == False).all())  # noqa: E712
        self.assertTrue(g[g.decision_slot < 20000].eligible.all())

    def test_small_pool_is_not_eligible(self):
        w = world()
        w["amm"] = w["amm"].assign(pool_quote_token_reserves=lambda d: (d.pool_quote_token_reserves.astype(int) // 4).astype(str))
        f = run_world(w)
        self.assertFalse(f.eligible.any())

    def test_returns_since_migration(self):
        f = run_world(world())
        r = f.iloc[0]
        init = 80 * 10**9 / (200 * 10**12)
        self.assertAlmostEqual(r.r_mig, r.p / init - 1)


class Universe(unittest.TestCase):
    def test_filters(self):
        mk = lambda m, day_t, **kw: dict(event="CreateEvent", program="pump", slot="1", block_time=str(day_t),
                                         fields=dict(mint=m, bonding_curve="bc" + m, quote_mint="11111111111111111111111111111111",
                                                     is_mayhem_mode=kw.get("mayhem", "0"), is_cashback_enabled=kw.get("cash", "0")))
        mig = lambda m: dict(event="CompletePumpAmmMigrationEvent", slot="5", block_time=str(DAY0 + 10), fields=dict(mint=m, pool="p" + m))
        creates = [mk("a", DAY0), mk("b", DAY0, mayhem="1"), mk("c", DAY0, cash="1"), mk("d", DAY0 - 86400), mk("e", DAY0)]
        u, why = F.build_universe(creates, [mig("a"), mig("b"), mig("c"), mig("d")], {"2026-09-11"})
        self.assertEqual(list(u.mint), ["a"])
        self.assertEqual((why["mayhem"], why["cashback"], why["not_creation_day"], why["not_migrated"]), (1, 1, 1, 1))


if __name__ == "__main__":
    unittest.main()
