"""Quotes, and PREREG §7 check 2 on fixtures copied from the tape (2026-09-11, unit 446274000-446278499)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g1lib.quotes import (CurveState, Fees, PoolState, curve_buy_exact_quote_in, curve_sell, fee_of, pool_sell,  # noqa: E402
                          worse_buy, worse_sell)


class TapeFixtures(unittest.TestCase):
    def test_curve_reserves_are_after_the_trade(self):
        # S_curve slot 446274000 tx 413: buy of 1,495,500,847,798 tokens for 244,444,444 lamports; reserves printed
        # on the row: virtual_sol 72,658,933,055, virtual_token 443,028,801,712,797.
        tokens, sol = 1_495_500_847_798, 244_444_444
        vs_after, vt_after = 72_658_933_055, 443_028_801_712_797
        # read as "after": the pre-trade state reproduces the trade with the program's exact-tokens formula
        vs, vt = vs_after - sol, vt_after + tokens
        self.assertEqual(tokens * vs // (vt - tokens) + 1, sol)
        # read as "before" it does not
        self.assertNotEqual(tokens * vs_after // (vt_after - tokens) + 1, sol)
        # fee fields: 95 bps protocol, 30 bps creator, ceil
        self.assertEqual(fee_of(sol, 95), 2_322_223)
        self.assertEqual(fee_of(sol, 30), 733_334)

    def test_pool_reserves_are_before_the_trade(self):
        # S_amm slot 446274000 tx 541: sell of 295,553,832,395 base for quote 220,409,806 (lp 440,820 at 20 bps);
        # reserves on the row: base 154,415,972,922,223, vault 97,791,895,703, virtual 17,584,505,811.
        base, quote = 295_553_832_395, 220_409_806
        p = PoolState(154_415_972_922_223, 97_791_895_703, 17_584_505_811)
        self.assertEqual(p.effective_quote * base // (p.base + base), quote)
        f = pool_sell(p, base, Fees(20, 5, 95))
        self.assertTrue(f.ok)
        self.assertEqual(f.quote, quote)
        self.assertEqual(fee_of(quote, 20), 440_820)
        # read as "after" (undo the sell) the identity fails
        after = PoolState(p.base + base, p.quote_vault - quote + 440_820, p.virtual_quote)
        self.assertNotEqual(after.effective_quote * base // (after.base + base), quote)


class Quotes(unittest.TestCase):
    s = CurveState(400_000_000_000_000, 80_000_000_000, 120_000_000_000_000, 50_000_000_000)

    def test_round_trip_loses_fees_and_impact(self):
        f = Fees(0, 95, 30)
        b = curve_buy_exact_quote_in(self.s, 419_252_054, f)
        self.assertTrue(b.ok)
        self.assertLessEqual(b.user_quote, 419_252_054)
        after = CurveState(self.s.virtual_token - b.tokens, self.s.virtual_quote + b.quote, self.s.real_token - b.tokens,
                           self.s.real_quote + b.quote)
        s = curve_sell(after, b.tokens, f)
        self.assertTrue(s.ok)
        self.assertLess(s.user_quote, b.user_quote)

    def test_buy_past_the_curve_is_infeasible(self):
        small = CurveState(self.s.virtual_token, self.s.virtual_quote, 1_000_000, self.s.real_quote)
        self.assertEqual(curve_buy_exact_quote_in(small, 10 ** 9, Fees(0, 95, 30)).reason, "exceeds-reserves")

    def test_complete_curve_refuses(self):
        done = CurveState(self.s.virtual_token, self.s.virtual_quote, 0, self.s.real_quote)
        self.assertFalse(curve_sell(done, 10, Fees()).ok)

    def test_pool_sell_capped_by_real_vault(self):
        p = PoolState(200_000_000_000_000, 1_000_000_000, 17_000_000_000)   # tiny real vault, large virtual
        f = pool_sell(p, 100_000_000_000_000, Fees(20, 5, 95))
        self.assertTrue(f.ok)
        self.assertGreater(f.unsold_tokens, 0)
        self.assertLessEqual(f.quote - fee_of(f.quote, 20), p.quote_vault)

    def test_worse_of_two_states(self):
        f = Fees(0, 95, 30)
        hi = CurveState(400_000_000_000_000, 90_000_000_000, 120_000_000_000_000, 60_000_000_000)
        a, b = curve_buy_exact_quote_in(self.s, 10 ** 9, f), curve_buy_exact_quote_in(hi, 10 ** 9, f)
        self.assertEqual(worse_buy([a, b]).tokens, min(a.tokens, b.tokens))
        sa, sb = curve_sell(self.s, 10 ** 12, f), curve_sell(hi, 10 ** 12, f)
        self.assertEqual(worse_sell([sa, sb]).user_quote, min(sa.user_quote, sb.user_quote))


if __name__ == "__main__":
    unittest.main()
