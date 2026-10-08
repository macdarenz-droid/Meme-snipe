"""The Python quote port against the repo's mainnet golden vectors, and the fixed costs against edge-costs.ts."""
import json
import os
import unittest

from h1cgo import pumpswap as ps
from h1cgo.constants import spend_of

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
GOLDEN = os.path.join(REPO, "packages", "core", "test", "amm", "fixtures", "golden.json")
COSTS = os.path.join(REPO, "research", "edge", "costs.json")
DEFAULT = "11111111111111111111111111111111"


class Quotes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tiers = ps.load_tiers()
        g = json.load(open(GOLDEN))["pumpswap"]
        cls.vec = [v for v in g if v["pool"]["canonical"] and v["pool"]["quote"] == "sol"
                   and int(v["pool"]["creator_fee_bps"]) == 0]

    def _pre(self, e):
        return ps.Pool(int(e["pool_base_token_reserves"]), int(e["pool_quote_token_reserves"]), int(e["virtual_quote_reserves"] or 0))

    def test_sells_match_mainnet(self):
        n = 0
        for v in self.vec:
            if v["kind"] != "sell":
                continue
            e = v["event"]
            t = ps.sell(self._pre(e), int(v["args"][0]), self.tiers, int(e["base_supply"]), e["coin_creator"] != DEFAULT)
            self.assertTrue(t.ok)
            self.assertEqual(t.fee_bps, (int(e["lp_fee_basis_points"]), int(e["protocol_fee_basis_points"]), int(e["coin_creator_fee_basis_points"])))
            self.assertEqual(t.quote, int(e["quote_amount_out"]))
            self.assertEqual(t.user_quote, int(e["user_quote_amount_out"]))
            n += 1
        self.assertGreaterEqual(n, 3)

    def test_buy_exact_quote_in_matches_mainnet(self):
        n = 0
        for v in self.vec:
            if v["kind"] == "sell" or v["ixName"] == "buy":
                continue
            e = v["event"]
            t = ps.buy_exact_quote_in(self._pre(e), int(v["args"][0]), self.tiers, int(e["base_supply"]), e["coin_creator"] != DEFAULT)
            self.assertTrue(t.ok)
            self.assertEqual(t.base, int(e["base_amount_out"]))
            self.assertEqual(t.quote, int(e["user_quote_amount_in"]))
            self.assertLessEqual(t.user_quote, int(v["args"][0]))
            n += 1
        self.assertGreaterEqual(n, 1)

    def test_tier_selection(self):
        self.assertEqual(ps.select_tier(self.tiers, 0), self.tiers[0][1])
        self.assertEqual(ps.select_tier(self.tiers, self.tiers[1][0]), self.tiers[1][1])
        self.assertEqual(ps.select_tier(self.tiers, self.tiers[1][0] - 1), self.tiers[0][1])

    def test_impact_and_refusals(self):
        p = ps.Pool(10**15, 80 * 10**9, 0)
        b = ps.buy_exact_quote_in(p, spend_of(50), self.tiers, 10**15)
        self.assertTrue(b.ok and b.impact > 0 and b.user_quote <= spend_of(50))
        s = ps.sell(p, b.base, self.tiers, 10**15)
        self.assertTrue(s.ok and s.user_quote < b.user_quote)
        self.assertEqual(ps.sell(ps.Pool(10**15, 0, 10**9), 10, self.tiers, 10**15).reason, "no-liquidity")
        self.assertEqual(ps.sell(ps.Pool(10**6, 10, 10**12), 10**9, self.tiers, 10**15).reason, "exceeds-reserves")

    def test_post_state_effective_reserve(self):
        r = dict(pool_base_token_reserves="1000000", pool_quote_token_reserves="5000", virtual_quote_reserves="-100",
                 side="buy", base_amount="10", quote_amount_lp_adjusted="60", quote_amount="99", lp_fee="1",
                 last_in_tx="1", chain_pool_quote="5070")
        pre, post = ps.amm_post_state(r)
        self.assertEqual((pre.eff, post.eff, post.base, post.vault), (4900, 4960, 999990, 5070))


class FixedCosts(unittest.TestCase):
    def test_equals_edge_costs(self):
        rows = json.load(open(COSTS))["rows"]
        self.assertEqual(round(ps.expected_fixed()), rows[0]["fixedLamports"])
        self.assertEqual(round(ps.expected_fixed()), 414009)

    def test_spend_matches_edge_costs(self):
        rows = {(r["setup"], r["usd"]): r for r in json.load(open(COSTS))["rows"]}
        self.assertEqual(spend_of(50), 419252054)  # floor(50 / 119.26 * 1e9), about 0.4193 SOL
        self.assertIn(("young", 20), rows)
