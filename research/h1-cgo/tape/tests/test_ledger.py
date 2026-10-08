"""§9.2 cost-basis fixtures: buy, sell, router trade (owner differs from signer), transfer in and out, sell that closes
an account; plus unknown-cost tokens, mixed holdings and excluded accounts (§9.3)."""
import math
import unittest

from h1cgo.features import build_streams
from h1cgo.ledger import Ledger
from tests.synth import AMM_COLS, CURVE_COLS, T_COLS, amm_row, curve_row, frame, t_row, tcov, universe


class LedgerUnit(unittest.TestCase):
    def test_buy_sell_average_cost(self):
        L = Ledger()
        L.buy("A", 1000, 500, False)
        L.sell("A", 400)
        x = L.h["A"]
        self.assertEqual((x.known, x.unknown), (600, 0))
        self.assertAlmostEqual(x.cost, 300.0)
        L.buy("A", 400, 1000, True)  # average cost: (300 + 1000) / 1000
        self.assertAlmostEqual(L.h["A"].cost / L.h["A"].known, 1.3)

    def test_transfer_moves_proportional_cost(self):
        L = Ledger()
        L.buy("A", 1000, 500, False)
        L.transfer("A", "B", 300)
        self.assertEqual(L.h["A"].known, 700)
        self.assertAlmostEqual(L.h["A"].cost, 350.0)
        self.assertEqual(L.h["B"].known, 300)
        self.assertAlmostEqual(L.h["B"].cost, 150.0)
        L.transfer("B", "A", 300)  # transfer back in
        self.assertEqual((L.h["A"].known, L.h["B"].known), (1000, 0))
        self.assertAlmostEqual(L.h["A"].cost, 500.0)
        self.assertEqual(L.h["B"].cost, 0.0)

    def test_sell_that_closes_the_account(self):
        L = Ledger()
        L.buy("A", 777, 333, True)
        L.sell("A", 777)
        x = L.h["A"]
        self.assertEqual((x.known, x.cost, x.unknown, x.post_known, x.post_cost), (0, 0.0, 0, 0, 0.0))

    def test_unknown_and_mixed(self):
        L = Ledger()
        L.mint("E", 100)  # no known cost
        L.transfer("E", "F", 50)
        self.assertEqual((L.h["F"].known, L.h["F"].unknown), (0, 50))
        L.buy("F", 50, 10, True)
        L.transfer("F", "G", 50)  # half known, half unknown
        g = L.h["G"]
        self.assertEqual((g.known, g.unknown), (25, 25))
        self.assertAlmostEqual(g.cost, 5.0)
        self.assertEqual(L.h["F"].total, 50)

    def test_overdraw_is_unknown_at_the_receiver_and_counted(self):
        L = Ledger()
        L.buy("A", 10, 10, False)
        L.transfer("A", "B", 15)
        self.assertEqual((L.h["B"].known, L.h["B"].unknown), (10, 5))
        self.assertEqual((L.overdraw_events, L.overdraw_tokens), (1, 5))
        L.sell("Z", 3)
        self.assertEqual(L.overdraw_events, 2)

    def test_proportional_take_never_exceeds_parts(self):
        L = Ledger()
        L.buy("A", 7, 7, False)
        L.mint("A", 3)
        for _ in range(9):
            L.transfer("A", "B", 1)
            a = L.h["A"]
            self.assertGreaterEqual(a.known, 0)
            self.assertGreaterEqual(a.unknown, 0)
            self.assertEqual(a.total + L.h["B"].total, 10)


class StreamFixtures(unittest.TestCase):
    """The same rules through the tape rows: S rows credit user_token_owner (never the signer), T rows move holdings."""

    def setUp(self):
        u = universe(mig_slot=1000)
        curve = [
            curve_row(20, 1, "A", True, 1_000, 480, fee=10, creator_fee=10, post=1_000),  # cost 500, fees included
            # router trade: the router's account owner R is credited, then a movement hands the tokens to B
            curve_row(30, 1, "R", True, 200, 100, fee=10, creator_fee=10, post=0, outer=2, inner=3),
            curve_row(40, 1, "A", False, 400, 190, post=600),
            curve_row(50, 1, "D", True, 300, 300, post=300),
        ]
        t = [
            t_row(30, 1, "transfer", "R", "B", 200, outer=2, inner=4),
            t_row(60, 1, "transfer", "A", "C", 300),  # transfer out of A, into C
            t_row(70, 1, "mint", "", "E", 100),  # unknown cost
            t_row(80, 1, "transfer", "C", "P", 50),  # into the pool's vault: excluded
            t_row(90, 1, "transfer", "D", "1nc1nerator11111111111111111111111111111111", 10),
            t_row(95, 1, "transfer", "", "Q", 10),  # empty owner: left out
        ]
        amm = [amm_row(1100, 1, "D", "sell", 290, 10**12, 80 * 10**9, post=0)]  # sell that closes D's account
        self.streams = build_streams(u, frame(curve, CURVE_COLS), frame(amm, AMM_COLS), frame(t, T_COLS), tcov())
        self.s = self.streams["M"]
        self.s.advance(2000)

    def test_holdings(self):
        h = self.s.ledger.h
        self.assertEqual((h["A"].known, h["B"].known, h["C"].known, h["R"].total), (300, 200, 250, 0))
        self.assertAlmostEqual(h["A"].cost, 150.0)  # 1,000 for 500, sold 400, sent 300
        self.assertAlmostEqual(h["B"].cost, 120.0)  # the router's buy, fees included
        self.assertAlmostEqual(h["C"].cost, 125.0)  # 300 at 0.5, 50 moved to the pool
        self.assertEqual(h["D"].total, 0)
        self.assertEqual(h["E"].unknown, 100)
        self.assertNotIn("Q", h)

    def test_snapshot_coverage_and_excluded(self):
        f = self.s.snapshot(10**10)
        # included: A 300, B 200, C 250 known; E 100 unknown
        self.assertEqual(f["known_tokens"], 750)
        self.assertEqual(f["unknown_tokens"], 100)
        self.assertAlmostEqual(f["coverage"], 750 / 850)
        self.assertAlmostEqual(f["rp"], (150 + 120 + 125) / 750)
        self.assertEqual(f["excl_pool"], 50)
        self.assertEqual(f["excl_burn"], 10)
        self.assertTrue(math.isfinite(f["cgo"]))

    def test_owner_balance_checks(self):
        # every S row carries owner_token_post; the ledger matches it at the end of each transaction
        self.assertEqual(self.s.owner_checks, 5)
        self.assertEqual(self.s.owner_mismatch, 0)  # R's post-transaction balance is 0: the same tx moves it to B
