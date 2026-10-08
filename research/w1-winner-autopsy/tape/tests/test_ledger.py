"""PREREG §9.2 P&L accounting fixtures: router trades, transfers between cluster members, closing sells, curve
positions carried through migration; plus tx-cost splitting, unknown starts, unresolved mints and exclusions."""
import os
import tempfile
import unittest

import numpy as np

from fixtures import Unit, address
from w1 import clusters, load, positions, venue
from w1.addr import MAYHEM_VAULT
from w1.ledger import Ledger

D1, D2 = "2026-09-07", "2026-09-08"
L1, H1, L2, H2 = 446_000_000, 446_004_499, 446_004_500, 446_008_999
A, B, C, D, E, F, G, H, R = (address(x) for x in "ABCDEFGHR")
PDA = address("pda", curve=False)
M, N, POOL = address("mintM"), address("mintN"), address("poolP", curve=False)
CURVE_M = address("curveM", curve=False)
Q = 30_000_000_000_000


def curve_state(sol_in):
    """A plausible curve state after `sol_in` lamports net have gone in (constant product from pump's start)."""
    vsr0, vtr0 = 30_000_000_000, 1_073_000_000_000_000
    k = vsr0 * vtr0
    vsr = vsr0 + sol_in
    vtr = k // vsr
    return vsr, vtr, sol_in, 793_100_000_000_000 - (vtr0 - vtr)


def build(root):
    u1 = Unit(root, D1, L1, H1)
    s = L1
    u1.sol(s + 1, C, D)                                   # funding link C - D
    u1.event("CreateEvent", s + 2, 0, {"mint": M, "bonding_curve": CURVE_M, "creator": F,
                                         "token_total_supply": 10**15})
    # A buys through a router signer R, then sells everything (closing sell)
    st = curve_state(1_000_000_000)
    u1.curve(s + 100, 1, 0, A, M, True, 1_000_000_000, Q, *st, pre=0, post=Q, signer=R, tx_fee=10_000, jito=2_000,
             fee=9_500_000, creator_fee=3_000_000)
    st = curve_state(20_000_000)
    u1.curve(s + 200, 1, 0, A, M, False, 980_000_000, Q, *st, pre=Q, post=0, tx_fee=5_000, fee=9_310_000,
             creator_fee=2_940_000)
    # B: two swaps in one transaction share its tx_fee + tip
    st = curve_state(500_000_000)
    u1.curve(s + 300, 2, 0, B, M, True, 240_000_000, Q // 4, *st, pre=0, post=Q // 2, tx_fee=8_000, jito=0)
    u1.curve(s + 300, 2, 1, B, M, True, 260_000_000, Q // 4, *st, pre=0, post=Q // 2, tx_fee=8_000, jito=0)
    # C buys, gives half to D (same trader via the W link), D sells its half; C holds the rest at day end
    st = curve_state(1_500_000_000)
    u1.curve(s + 400, 3, 0, C, M, True, 1_000_000_000, Q, *st, pre=0, post=Q, tx_fee=5_000)
    u1.transfer(s + 450, 4, M, C, D, Q // 2)
    st = curve_state(1_000_000_000)
    u1.curve(s + 500, 5, 0, D, M, False, 490_000_000, Q // 2, *st, pre=Q // 2, post=0, tx_fee=5_000)
    # H's first swap sells a balance the tape never built: start unknown
    u1.curve(s + 550, 6, 0, H, M, False, 10_000_000, 10**12, *curve_state(990_000_000), pre=10**12, post=0)
    # E buys N on its curve; the curve completes and migrates; G trades the canonical pool
    u1.event("CreateEvent", s + 590, 0, {"mint": N, "bonding_curve": address("curveN", False), "creator": G,
                                           "token_total_supply": 10**15})
    u1.curve(s + 600, 7, 0, E, N, True, 1_000_000_000, Q, 31_000_000_000, 1_038_000_000_000_000, 1_000_000_000,
             758_100_000_000_000, pre=0, post=Q)
    u1.curve(s + 700, 8, 0, F, N, True, 84_000_000_000, 758_100_000_000_000, 115_000_000_000, 279_900_000_000_000,
             85_000_000_000, 0, pre=0, post=758_100_000_000_000)
    u1.event("CompleteEvent", s + 700, 8, {"mint": N, "bonding_curve": address("curveN", False)}, ev=1)
    u1.event("CreatePoolEvent", s + 701, 0, {"base_mint": N, "quote_mint": WSOL_, "pool": POOL})
    u1.amm(s + 800, 1, 0, G, N, POOL, "buy", 10**12, 300_000_000, 206_900_000_000_000, 67_400_000_000,
           17_600_000_000, pre=0, post=10**12, lp_adj=299_000_000)
    # a mayhem-vault owner and an off-curve owner are excluded
    u1.curve(s + 900, 9, 0, MAYHEM_VAULT, M, True, 10**8, 10**12, *curve_state(1_100_000_000), pre=0, post=10**12)
    u1.curve(s + 901, 9, 0, PDA, M, True, 10**8, 10**12, *curve_state(1_200_000_000), pre=0, post=10**12)
    u1.write()
    u2 = Unit(root, D2, L2, H2)
    # E sells N on the pool on day 2
    u2.amm(L2 + 10, 1, 0, E, N, POOL, "sell", Q, 9_000_000_000, 206_899_000_000_000, 67_699_000_000, 17_600_000_000,
           pre=Q, post=0, tx_fee=5_000)
    u2.write()
    return [u1.dir, u2.dir]


WSOL_ = "So11111111111111111111111111111111111111112"


class LedgerFixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        dirs = build(cls.tmp.name)
        cls.units = load.parse_units(dirs)
        cls.v = load.Vocab()
        led = Ledger(cls.v)
        led.process_unit(cls.units[0])
        cls.led_after_d1_states = led.states
        cls.d1 = led.finish_day()
        led.process_unit(cls.units[1])
        cls.d2 = led.finish_day()
        cls.days = [cls.d1, cls.d2]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def row(self, day, owner, mint):
        r = day["rows"]
        x = r[(r["owner"] == self.v.get(owner)) & (r["mint"] == self.v.get(mint))]
        self.assertEqual(len(x), 1, f"row for {owner[:4]}")
        return x.iloc[0]

    def test_router_trade_credits_owner_not_signer(self):
        a = self.row(self.d1, A, M)
        paid = 1_000_000_000 + 9_500_000 + 3_000_000 + 12_000
        recv = 980_000_000 - 9_310_000 - 2_940_000 - 5_000
        self.assertFalse(a["dirty"])
        self.assertAlmostEqual(a["cash"], recv - paid)
        self.assertAlmostEqual(a["paid"], paid)
        self.assertEqual(a["end_bal"], 0)
        r = self.d1["rows"]
        self.assertFalse((r["owner"] == self.v.get(R)).any(), "the router signer has no position")

    def test_closing_sell_sets_exit(self):
        trader, _ = clusters.build(self.days, D1)
        p = positions.trader_positions(self.d1, trader)
        a = p[(p["trader"] == trader[self.v.get(A)]) & (p["mint"] == self.v.get(M))].iloc[0]
        self.assertEqual(a["exit_slot"], L1 + 200)
        self.assertEqual(a["entry_slot"], L1 + 100)
        self.assertFalse(a["open_at_end"])
        self.assertAlmostEqual(a["ret"], a["pnl"] / a["paid"])

    def test_tx_cost_split_evenly(self):
        b = self.row(self.d1, B, M)
        self.assertAlmostEqual(b["cash"], -(240_000_000 + 260_000_000 + 8_000))
        self.assertFalse(b["dirty"])

    def test_transfer_between_cluster_members(self):
        trader, info = clusters.build(self.days, D1)
        self.assertEqual(trader[self.v.get(C)], trader[self.v.get(D)])
        c, d = self.row(self.d1, C, M), self.row(self.d1, D, M)
        self.assertAlmostEqual(c["cash"] + d["cash"], -(1_000_000_000 + 5_000) + (490_000_000 - 5_000))
        p = positions.trader_positions(self.d1, trader)
        t = p[(p["trader"] == trader[self.v.get(C)]) & (p["mint"] == self.v.get(M))].iloc[0]
        self.assertAlmostEqual(t["paid"], 1_000_000_000 + 5_000)   # the internal transfer is not new capital
        mark = venue.sell(("c", *curve_state(1_200_000_000), 125), Q // 2)   # the day's last curve state
        self.assertAlmostEqual(t["end_mark"], mark, delta=2)
        self.assertAlmostEqual(t["pnl"], t["cash"] + t["end_mark"])
        self.assertFalse(t["dirty"])
        # without the link they are two traders and D's receipt counts as paid in at the mark
        self.assertNotEqual(clusters.assign([self.v.get(D)], {}), clusters.assign([self.v.get(C)], {}))

    def test_curve_position_carried_through_migration(self):
        e1 = self.row(self.d1, E, N)
        self.assertFalse(e1["dirty"])
        pool_after = ("a", 206_900_000_000_000 - 10**12, 67_400_000_000 + 299_000_000, 17_600_000_000, 30)
        self.assertAlmostEqual(e1["end_mark"], venue.sell(pool_after, Q), delta=2)
        e2 = self.row(self.d2, E, N)
        self.assertFalse(e2["dirty"])
        self.assertAlmostEqual(e2["start_mark"], e1["end_mark"])
        self.assertAlmostEqual(e2["cash"], 9_000_000_000 - 5_000)
        trader, _ = clusters.build(self.days, D1)
        p = positions.trader_positions(self.d2, trader)
        t = p[(p["mint"] == self.v.get(N)) & (p["trader"] == trader[self.v.get(E)])].iloc[0]
        self.assertAlmostEqual(t["pnl"], 9_000_000_000 - 5_000 - e1["end_mark"])
        self.assertAlmostEqual(t["basis"], e1["end_mark"])

    def test_unknown_start_is_left_out(self):
        self.assertTrue(self.row(self.d1, H, M)["dirty"])

    def test_excluded_owners(self):
        ex = self.d1["excluded"]
        self.assertIn(self.v.get(MAYHEM_VAULT), ex["mayhem vault"])
        self.assertIn(self.v.get(PDA), ex["program-derived (off-curve)"])
        r = self.d1["rows"]
        self.assertFalse((r["owner"] == self.v.get(PDA)).any())

    def test_days_outside_windows_refused(self):
        with self.assertRaises(ValueError):
            load.parse_units(["/x/2026-09-12/1-2/research"])
        with self.assertRaises(ValueError):
            load.parse_units(["/x/2026-09-01/1-2/research"])


class UnresolvedMint(unittest.TestCase):
    def test_unresolved_from_slot_taints_later_activity(self):
        with tempfile.TemporaryDirectory() as root:
            u = Unit(root, D1, L1, H1)
            st = curve_state(10**9)
            u.curve(L1 + 10, 1, 0, A, M, True, 10**9, Q, *st, pre=0, post=Q)
            u.curve(L1 + 20, 1, 0, B, M, True, 10**9, Q, *st, pre=0, post=Q)
            u.curve(L1 + 30, 2, 0, B, M, False, 10**9, Q, *st, pre=Q, post=0)
            u.curve(L1 + 40, 3, 0, A, M, False, 10**9, Q, *st, pre=Q, post=0)
            u.unresolved(M, L1 + 35)
            u.write()
            v = load.Vocab()
            led = Ledger(v)
            led.process_unit(load.parse_units([u.dir])[0])
            r = led.finish_day()["rows"]
            dirty = dict(zip(r["owner"], r["dirty"]))
            self.assertFalse(dirty[v.get(B)])     # closed before the unresolved slot
            self.assertTrue(dirty[v.get(A)])      # active after it


if __name__ == "__main__":
    unittest.main()
