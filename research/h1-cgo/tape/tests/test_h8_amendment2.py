"""research/brainstorm-loop/H8_AMENDMENT_2.md, H1-CGO parts: the H8 stratum under the universe the bot would tag
(U2 60-240 min with H11, U1 $50k from 24 h, 4-24 h not tradable), H6 and the dust check, "tradable" at $5 only, and the
count row with sizes up to $10,000 and the creator-fee-0 pool count."""
import unittest

import numpy as np
import pandas as pd

from h1cgo import h8 as H8
from h1cgo import stats as S
from h1cgo.constants import VALIDATION_DAYS
from h1cgo.features import Clock, build_streams, compute_features, decision_points, schedule_windows
from tests.synth import AMM_COLS, CURVE_COLS, DAY0, T_COLS, amm_row, blocks, frame, t_of, tcov, universe
from tests.test_amendment3 import FROZEN, outs
from tests.test_features import PoolChain

VDAYS = list(VALIDATION_DAYS)
SOL100 = H8.SolUsd({DAY0 + k * 3600: 100_000_000 for k in range(-2, 30)}, [])


class Tags(unittest.TestCase):
    def test_universe_by_age(self):
        self.assertEqual(H8.universe_tag(3600), "U2")
        self.assertEqual(H8.universe_tag(14_399), "U2")
        self.assertIsNone(H8.universe_tag(14_400))  # 4 h: neither universe
        self.assertIsNone(H8.universe_tag(86_399))
        self.assertEqual(H8.universe_tag(86_400), "U1")
        self.assertEqual(H8.universe_tag(14 * 86_400), "U1")
        self.assertIsNone(H8.universe_tag(14 * 86_400 + 1))
        self.assertIsNone(H8.universe_tag(3599))

    def test_floors(self):
        self.assertEqual(H8.floor_micro_usd(5, "U2"), 15_000 * 10**6)
        self.assertEqual(H8.floor_micro_usd(50, "U2"), 50_000 * 10**6)
        self.assertEqual(H8.floor_micro_usd(5, "U1"), 50_000 * 10**6)
        self.assertEqual(H8.floor_micro_usd(50, "U1"), 50_000 * 10**6)
        self.assertEqual(H8.floor_micro_usd(100, "U1"), 100_000 * 10**6)


def row(age_s, eff_sol, **kw):
    r = dict(hour=DAY0 + 7200, mig_time=DAY0 + 7200 - age_s, eff_quote=eff_sol * 10**9, quote_at_migration=85 * 10**9,
             h6_lp_outstanding=0, h11_spike=False, h11_chase_reject=False)
    r.update(kw)
    return pd.Series(r)


class Tradable(unittest.TestCase):
    def test_u2_floor_h6_h11_dust(self):
        self.assertTrue(H8.tradable(row(5400, 151), 5, SOL100))  # $15,100 >= $15,000
        self.assertFalse(H8.tradable(row(5400, 149), 5, SOL100))
        self.assertFalse(H8.tradable(row(5400, 500, h11_chase_reject=True), 5, SOL100))  # U2 chase check
        self.assertFalse(H8.tradable(row(5400, 500, h11_spike=True), 5, SOL100))
        self.assertFalse(H8.tradable(row(5400, 500, h6_lp_outstanding=1), 5, SOL100))  # H6: LP someone can pull
        self.assertFalse(H8.tradable(row(5400, 500, quote_at_migration=4 * 10**9), 5, SOL100))  # dust at migration

    def test_four_to_24_hours_never_tradable(self):
        self.assertFalse(H8.tradable(row(5 * 3600, 10**6), 5, SOL100))
        self.assertFalse(H8.tradable(row(23 * 3600, 10**6), 50, SOL100))

    def test_u1_floor_and_no_chase_check(self):
        self.assertFalse(H8.tradable(row(86_400, 499), 5, SOL100))  # $49,900 < $50,000 even at $5
        self.assertTrue(H8.tradable(row(86_400, 500, h11_chase_reject=True), 5, SOL100))  # the chase check is U2's
        self.assertFalse(H8.tradable(row(86_400, 999), 100, SOL100))  # $100 on U1: $100,000
        self.assertTrue(H8.tradable(row(86_400, 1000), 100, SOL100))


def world(trades, lp=(), last=40_000, mig_slot=1000):
    """One coin: migration at slot 1000 (DAY0 + 500 s), pool created with 80 SOL against 200e12 base."""
    ch = PoolChain()
    for t in trades:
        ch.trade(*t)
    u = universe(mig_slot=mig_slot).assign(quote_at_migration=80 * 10**9, base_at_migration=200 * 10**12)
    clock = Clock.from_blocks(blocks(last))
    dp = schedule_windows(decision_points(u, clock, [(0, last)]), clock)
    st = build_streams(u, frame([], CURVE_COLS), frame(ch.rows, AMM_COLS), frame([], T_COLS), tcov(),
                       lp_events={"P": list(lp)})
    return compute_features(dp, st), ch


class StreamGates(unittest.TestCase):
    def test_chase_check_at_migration_plus_5_min(self):
        f, _ = world([(1100, "C", "sell", 10**12)])  # +50 s: price below migration's -> pass
        self.assertFalse(f.iloc[0].h11_chase_reject)
        g, _ = world([(1100, "C", "buy", 10**12)])  # +50 s: price above migration's -> reject
        self.assertTrue(g.iloc[0].h11_chase_reject)
        h, _ = world([(1700, "C", "sell", 10**12)])  # first trade at +350 s: no candle by +5 min -> not covered
        self.assertTrue(h.iloc[0].h11_chase_reject)

    def test_candle_spike_in_the_last_3_minutes(self):
        hour_slot = 2 * (7200)  # slot of DAY0 + 7200 s (the first decision hour)
        calm, _ = world([(1100, "C", "sell", 10**12), (hour_slot - 100, "D", "buy", 10**12)])
        self.assertFalse(calm.iloc[0].h11_spike)
        spike, _ = world([(1100, "C", "sell", 10**12), (hour_slot - 100, "D", "buy", 60 * 10**12)])  # +40% in a candle
        self.assertTrue(spike.iloc[0].h11_spike)
        self.assertFalse(spike.iloc[1].h11_spike)  # an hour later the spike is out of the 3-minute window
        old, _ = world([(1100, "C", "sell", 10**12), (hour_slot - 600, "D", "buy", 60 * 10**12)])  # 5 min before
        self.assertFalse(old.iloc[0].h11_spike)

    def test_h6_lp_outstanding_as_of(self):
        f, _ = world([(1100, "C", "sell", 10**12)], lp=[(5000, 7), (20_000, -7)])
        self.assertEqual(list(f.h6_lp_outstanding[:3]), [7, 0, 0])  # decisions at slots 14,399, 21,599, 28,799
        g, _ = world([(1100, "C", "sell", 10**12)], lp=[(14_400, 7)])  # a deposit after the decision slot
        self.assertEqual(g.iloc[0].h6_lp_outstanding, 0)

    def test_creator_fee_zero_and_age(self):
        f, ch = world([(1100, "C", "sell", 10**12)])
        self.assertFalse(f.iloc[0].creator_fee_zero)
        self.assertEqual(f.iloc[0].age_s, f.iloc[0].hour - t_of(1000))
        ch.rows[0]["coin_creator"] = "11111111111111111111111111111111"
        ch.rows[0]["coin_creator_fee"] = "0"
        u = universe(mig_slot=1000).assign(quote_at_migration=80 * 10**9, base_at_migration=200 * 10**12)
        clock = Clock.from_blocks(blocks(40_000))
        dp = schedule_windows(decision_points(u, clock, [(0, 40_000)]), clock)
        g = compute_features(dp, build_streams(u, frame([], CURVE_COLS), frame(ch.rows, AMM_COLS), frame([], T_COLS), tcov()))
        self.assertTrue(g.iloc[0].creator_fee_zero)


def val_feats2(n_per_day, age_s):
    fs = []
    for d in VDAYS:
        k = np.arange(n_per_day)
        fs.append(pd.DataFrame(dict(mint=[f"m{i}{d}" for i in k], pool=[f"p{i}{d}" for i in k], decision_slot=k,
                                    decision_day=d, eligible=True, in_time_3600=True, has_state=True, hour=DAY0,
                                    mig_time=DAY0 - age_s, cgo=np.where(k % 2 == 0, 2.0, 0.0), d60=0.5,
                                    eff_quote=500 * 10**9, quote_at_migration=85 * 10**9, h6_lp_outstanding=0,
                                    h11_spike=False, h11_chase_reject=False, creator_fee_zero=k % 3 == 0)))
    return pd.concat(fs, ignore_index=True)


class Stratum(unittest.TestCase):
    def test_tradable_only_at_5_dollars(self):
        f = val_feats2(240, 2 * 3600)  # U2 at 2 h; 500 SOL at $100 = $50,000: passes up to $50
        r = S.h8_stratum(f, outs(f), FROZEN, VDAYS, SOL100)
        self.assertEqual(r["$5"]["n_trades"], 360)
        self.assertTrue(r["tradable_as_bot_stands"])
        self.assertEqual(r["$20"]["line"], "research: needs the owner to raise maxNotional")
        bad5 = outs(f, net=lambda f: np.where(f.cgo > 1, -1e6, -1e7))  # $5 negative ...
        good_big = outs(f, usd_list=(20.0, 50.0))  # ... while $20 and $50 are positive
        r2 = S.h8_stratum(f, pd.concat([bad5[bad5.usd == 5.0], good_big]), FROZEN, VDAYS, SOL100)
        self.assertGreater(r2["$50"]["mean_net_sol"], 0)
        self.assertFalse(r2["tradable_as_bot_stands"])
        self.assertEqual(r2["note"], "this works only in pools below H8's floor")

    def test_4_to_24_hours_left_out(self):
        f = val_feats2(240, 6 * 3600)
        r = S.h8_stratum(f, outs(f), FROZEN, VDAYS, SOL100)
        self.assertEqual(r["$5"]["n_trades"], 0)
        self.assertFalse(r["tradable_as_bot_stands"])


class CountRow(unittest.TestCase):
    def test_sizes_and_creator_fee_zero(self):
        f = val_feats2(6, 2 * 3600).assign(decision_day="2026-09-11")
        c = H8.count_rows(f, SOL100)
        for s in (5, 20, 50, 100, 200, 500, 1000, 10000):
            self.assertIn(f"with_state_${s}", c)
        self.assertEqual(c["with_state_$50"]["2026-09-11"]["pool_hours"], 18)
        self.assertEqual(c["with_state_$100"]["2026-09-11"]["pool_hours"], 0)  # U2 at $100: $100,000 > $50,000
        self.assertEqual(c["creator_fee_zero_pools"]["2026-09-11"], 6)
        g = val_feats2(6, 2 * 86_400).assign(decision_day="2026-09-11", eff_quote=1000 * 10**9)  # U1 pools
        c2 = H8.count_rows(g, SOL100)
        self.assertEqual(c2["with_state_$100"]["2026-09-11"]["pool_hours"], 18)  # $100,000 floor met
        self.assertEqual(c2["with_state_$200"]["2026-09-11"]["pool_hours"], 0)


if __name__ == "__main__":
    unittest.main()


class Amendment5(unittest.TestCase):
    """AMENDMENT_5: H1-CGO's tradable stratum is the U2 window only, and the LP-burn limitation is reported.
    (AMENDMENT_6 is covered by tests/test_amendment3.py Amendment6, the red team's R1-19.)"""

    def test_u1_aged_point_is_not_in_the_stratum(self):
        f = val_feats2(240, 86_400).assign(eff_quote=10**6 * 10**9)  # exactly 24 h: U1, and far above every floor
        r = S.h8_stratum(f, outs(f), FROZEN, VDAYS, SOL100)
        self.assertEqual(r["$5"]["n_trades"], 0)
        self.assertEqual(r["universes"], ["U2"])

    def test_lp_burn_limitation_reported(self):
        f = val_feats2(10, 2 * 3600)
        r = S.h8_stratum(f, outs(f), FROZEN, VDAYS, SOL100)
        self.assertIn("burns outside a withdrawal", r["limitations"])
        c = H8.count_rows(f.assign(decision_day="2026-09-11"), SOL100)
        self.assertIn("burns outside a withdrawal", c["limitations"])
