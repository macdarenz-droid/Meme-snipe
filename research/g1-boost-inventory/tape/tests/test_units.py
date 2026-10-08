"""Costs, holdings (H1-CGO §9 check 2 fixtures, used by amendment 1 group 3), links and statistics."""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g1lib import params as P  # noqa: E402
from g1lib.costs import expected_fixed, lamports_per_byte, token_account_rent  # noqa: E402
from g1lib.graph import LinkGraph  # noqa: E402
from g1lib.holdings import Book, mint_events, replay  # noqa: E402
from g1lib.stats import cluster_bootstrap_means, futility, primary  # noqa: E402


class Costs(unittest.TestCase):
    def test_fixed_equals_edge_costs(self):
        self.assertAlmostEqual(expected_fixed(1_513_840), P.FIXED["expectedFixedLamports"], places=6)

    def test_rent_by_epoch_and_size(self):
        self.assertEqual(lamports_per_byte(1033 * 432_000), 5_080)
        self.assertEqual(lamports_per_byte(1033 * 432_000 - 1), 6_333)
        self.assertEqual(token_account_rent(P.TOKEN_2022_PROGRAM, 1033 * 432_000), 1_513_840)
        self.assertEqual(token_account_rent(P.SPL_TOKEN_PROGRAM, 1033 * 432_000), 1_488_440)
        self.assertEqual(token_account_rent(P.TOKEN_2022_PROGRAM, 1030 * 432_000), 298 * 6_333)
        self.assertEqual(token_account_rent("", 1033 * 432_000), 1_513_840)   # unknown: the larger account
        # amendment 3: 6,960 before 2026-09-03 (epoch 1028), 6,333 from it, 5,080 from epoch 1033
        self.assertEqual(token_account_rent(P.TOKEN_2022_PROGRAM, 1028 * 432_000 - 1), 2_074_080)
        self.assertEqual(token_account_rent(P.TOKEN_2022_PROGRAM, 1028 * 432_000), 1_887_234)
        # R2-13 (RENT_BOUNDARY.md): the boundary is slot 444,096,000 (2026-09-03 23:24:41 UTC)
        self.assertEqual(lamports_per_byte(443_990_000), 6_960)          # 09-03 12:00
        self.assertEqual(lamports_per_byte(444_095_999), 6_960)
        self.assertEqual(lamports_per_byte(444_096_000), 6_333)

    def test_fallback_tier_uses_base_supply(self):
        from g1lib.market import fallback_tier
        from g1lib.quotes import PoolState
        st = PoolState(200_000_000_000_000, 67_000_000_000, 17_600_000_000)   # ~423 SOL cap at 1B supply
        self.assertEqual(fallback_tier(st, 10 ** 15).total, 120)             # 420 SOL tier
        self.assertEqual(fallback_tier(st, 990_000_000_000_000).total, 125)  # burned supply: below 420 SOL

    def test_spend(self):
        self.assertEqual(P.spend_lamports(50), 419_252_054)
        self.assertEqual(P.trigger_lamports(0.90), 76_504_500_000)


def ev(rows):
    df = pd.DataFrame(rows, columns=["slot", "tx_idx", "outer_ix", "inner_ix", "ev_idx", "kind", "a", "b", "tokens", "cost", "post"])
    return df


class Holdings(unittest.TestCase):
    def test_buy_sell_transfer_router_close(self):
        e = ev([
            (1, 0, 0, 0, 0, "buy", 10, -1, 100.0, 50.0, 100),       # owner 10 buys 100 for 50
            (2, 0, 0, 0, 0, "buy", 11, -1, 100.0, 100.0, 100),      # router trade: owner 11 (signer differs) buys
            (3, 0, 0, 0, 0, "sell", 10, -1, 50.0, 0.0, 50),         # sells half: cost 25 left
            (4, 0, 9, 0, 0, "transfer", 10, 12, 25.0, 0.0, -1),     # transfer half of the rest: 12.5 cost moves
            (5, 0, 0, 0, 0, "sell", 11, -1, 100.0, 0.0, 0),         # sell that closes the account
            (6, 0, 9, 0, 0, "transfer", 99, 12, 10.0, 0.0, -1),     # from an owner with unknown cost
        ])
        b, _ = replay(e, 10)
        self.assertAlmostEqual(b.lots[10].tokens, 25)
        self.assertAlmostEqual(b.lots[10].cost, 12.5)
        self.assertAlmostEqual(b.lots[12].tokens, 35)
        self.assertAlmostEqual(b.lots[12].known, 25)
        self.assertAlmostEqual(b.lots[12].cost, 12.5)
        self.assertNotIn(11, b.holders())
        self.assertEqual(b.first_buy[11], 2)

    def test_snapshot_reconciles_missing_movement(self):
        e = ev([(1, 0, 0, 0, 0, "buy", 10, -1, 100.0, 50.0, 100),
                (2, 0, 0, 0, 0, "buy", 10, -1, 100.0, 50.0, 150)])     # 50 left the owner unseen
        b, _ = replay(e, 10)
        self.assertAlmostEqual(b.lots[10].tokens, 150)
        self.assertAlmostEqual(b.lots[10].cost, 75)

    def test_replay_stops_at_cutoff(self):
        e = ev([(1, 0, 0, 0, 0, "buy", 10, -1, 100.0, 50.0, 100), (5, 0, 0, 0, 0, "buy", 11, -1, 1.0, 1.0, 1)])
        b, _ = replay(e, 4)
        self.assertNotIn(11, b.lots)

    def test_excluded_curve(self):
        b = Book(exclude=(7,))
        b.mint(7, 1000)
        b.buy(10, 5, 1, 1)
        self.assertEqual(set(b.holders()), {10})


class Links(unittest.TestCase):
    def test_cluster_as_of_and_hubs(self):
        # 0-1 at slot 5, 1-2 at slot 20; hub 3 links to 60 owners and to 0
        src = [0, 1] + [3] * 61
        dst = [1, 2] + list(range(100, 160)) + [0]
        sl = [5, 20] + [1] * 61
        g = LinkGraph(np.array(src), np.array(dst), np.array(sl), 200)
        self.assertEqual(g.cluster([0], 10), {0, 1})
        self.assertEqual(g.cluster([0], 25), {0, 1, 2})
        self.assertNotIn(3, g.cluster([0], 25))           # never joins through a hub
        self.assertEqual(g.degree(3, 0), 0)
        self.assertEqual(g.degree(3, 1), 61)
        lab = g.components(25)
        self.assertEqual(lab[0], lab[2])
        self.assertNotEqual(lab[0], lab[100])


class Stats(unittest.TestCase):
    def trades(self, mean, n_per_day=200, days=3, seed=1):
        rng = np.random.default_rng(seed)
        rows = []
        for d in range(days):
            for i in range(n_per_day):
                rows.append({"day": f"d{d}", "mint": f"m{d}_{i}", "ret": rng.normal(mean, 0.05), "filled": True})
        return pd.DataFrame(rows)

    def test_bootstrap_deterministic(self):
        t = self.trades(0.0)
        a = cluster_bootstrap_means(t["ret"].to_numpy(), t["mint"].to_numpy(), t["day"].to_numpy(), n=200)
        b = cluster_bootstrap_means(t["ret"].to_numpy(), t["mint"].to_numpy(), t["day"].to_numpy(), n=200)
        self.assertTrue(np.array_equal(a, b))
        self.assertLess(abs(a.mean() - t["ret"].mean()), 0.01)

    def test_verdicts(self):
        good, s0 = self.trades(0.05), self.trades(0.0, seed=2)
        self.assertEqual(primary(good, control=s0)["verdict"], "pass")
        self.assertEqual(primary(good.iloc[:250], control=s0)["verdict"], "unresolved")
        self.assertEqual(primary(self.trades(-0.05), control=s0)["verdict"], "not supported")
        self.assertEqual(primary(good, control=self.trades(0.10, seed=3))["verdict"], "not supported")  # lift < 0
        self.assertTrue(futility(self.trades(-0.05))["closes"])
        self.assertFalse(futility(good)["closes"])


class Arms(unittest.TestCase):
    def test_frozen_medians_select_arms(self):
        from g1lib.score import arms, judge
        t = pd.DataFrame({"kind": ["G1"] * 4 + ["S0"], "variant": "primary", "mint": list("abcda"), "day": "d",
                          "filled": True, "miss": "", "ret": [0.1, 0.2, 0.3, 0.4, 0.0], "exit": "A"})
        d = pd.DataFrame({"kind": "G1", "mint": list("abcd"), "R": [0.1, 0.5, 0.9, float("nan")],
                          "Z": [-1.0, 0.0, 2.0, -3.0], "cap_reason": ["", "", "", "theme-wave"]})
        g1, s0, hc, cap = arms(t, d, {"median_R": 0.5, "median_Z": 0.0})
        self.assertEqual(list(hc["mint"]), ["a"])            # R strictly below the frozen median
        self.assertEqual(list(cap["mint"]), ["a", "b"])      # Z at or below; theme-wave excluded
        self.assertEqual(len(s0), 1)
        open_arms = {"G1": "", "G1_HC": "", "G1_CAP": ""}     # R2-6: validation needs each arm's closure state
        self.assertIn("secondary", judge(t, d, {"median_R": 0.5, "median_Z": 0.0}, "validation", closed=open_arms))


if __name__ == "__main__":
    unittest.main()
