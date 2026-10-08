"""§6 trade pricing (worse of start and end of slot), §5 gate, §6–7 entries, sign and futility, §8 primary."""
import unittest

import numpy as np
import pandas as pd

from h1cgo import outcomes as O
from h1cgo import pumpswap as ps
from h1cgo import stats as S
from h1cgo.constants import VALIDATION_DAYS, spend_of

VDAYS = list(VALIDATION_DAYS)
from tests.synth import AMM_COLS, amm_row, frame


def book(rows):
    return O.books_from_rows(frame(rows, AMM_COLS), 0, 10**6)["P"]


class Pricing(unittest.TestCase):
    def setUp(self):
        self.tiers = ps.load_tiers()
        self.fixed = ps.expected_fixed()

    def test_worse_of_start_and_end(self):
        # slot 100: a buy moves the price up inside the slot -> the entry uses the end state (fewer tokens)
        r1 = amm_row(100, 1, "X", "buy", 10**12, 200 * 10**12, 80 * 10**9)
        _, post = ps.amm_post_state(r1)
        r2 = amm_row(300, 1, "Y", "sell", 5 * 10**12, post.base, post.vault, post.virtual)
        b = book([r1, r2])
        t = O.price_trade(b, 100, 300, spend_of(50), self.tiers, self.fixed)
        self.assertEqual(t["status"], "ok")
        start, end = ps.Pool(200 * 10**12, 80 * 10**9, 0), post
        exp_buy = ps.buy_exact_quote_in(end, spend_of(50), self.tiers, 10**15)
        self.assertEqual(t["tokens"], exp_buy.base)
        self.assertLess(exp_buy.base, ps.buy_exact_quote_in(start, spend_of(50), self.tiers, 10**15).base)
        _, post2 = ps.amm_post_state(r2)
        exp_sell = ps.sell(post2, exp_buy.base, self.tiers, 10**15)  # a sell lowers the price inside slot 300
        self.assertEqual(t["received"], exp_sell.user_quote)
        self.assertAlmostEqual(t["net_lamports"], exp_sell.user_quote - exp_buy.user_quote - self.fixed)
        self.assertAlmostEqual(t["gross"], post2.mid() / end.mid() - 1)
        costs = t["entry_fees"] + t["exit_fees"] + t["entry_impact"] + t["exit_impact"] + self.fixed
        self.assertAlmostEqual(t["cost_ret"], costs / t["paid"])

    def test_quiet_slot_uses_last_state(self):
        r1 = amm_row(100, 1, "X", "buy", 10**12, 200 * 10**12, 80 * 10**9)
        _, post = ps.amm_post_state(r1)
        t = O.price_trade(book([r1]), 150, 900, spend_of(50), self.tiers, self.fixed)
        self.assertEqual(t["tokens"], ps.buy_exact_quote_in(post, spend_of(50), self.tiers, 10**15).base)
        self.assertAlmostEqual(t["gross"], 0.0)
        self.assertLess(t["net_ret"], 0)

    def test_book_refuses_slots_outside_its_loaded_range(self):
        r1 = amm_row(100, 1, "X", "buy", 10**12, 200 * 10**12, 80 * 10**9)
        b = O.books_from_rows(frame([r1], AMM_COLS), 50, 500)["P"]
        self.assertIsNotNone(b.end(500))
        for slot in (501, 49):
            with self.assertRaises(ValueError):
                b.start(slot)
            with self.assertRaises(ValueError):
                b.end(slot)

    def test_run_charges_the_mints_rent(self):
        r1 = amm_row(100, 1, "X", "buy", 10**12, 200 * 10**12, 80 * 10**9)
        books = O.books_from_rows(frame([r1], AMM_COLS), 0, 10**6)
        d = pd.DataFrame([dict(mint="M", pool="P", hour=0, decision_slot=150, decision_day="2026-09-11", eligible=True,
                               token_program=tp, exit_slot_3600=900, in_time_3600=True, exit_slot_900=0,
                               in_time_900=False, exit_slot_14400=0, in_time_14400=False)
                          for tp in (ps.TOKEN_2022, ps.SPL_TOKEN)])
        out = O.run(d, books)
        reg = out[(out.hold == 3600) & (out.usd == 50.0)]
        # entry slot 173 is in epoch 0: 6,960 lamports a byte; 170 and 165 bytes
        self.assertEqual(list(reg.fixed), [ps.expected_fixed(2_074_080), ps.expected_fixed(2_039_280)])
        self.assertTrue((out.fixed != ps.expected_fixed()).all())

    def test_run_takes_the_rate_at_the_entry_slot(self):
        e = 1033 * 432_000
        r1 = amm_row(e - 100, 1, "X", "buy", 10**12, 200 * 10**12, 80 * 10**9)
        books = O.books_from_rows(frame([r1], AMM_COLS), e - 1000, e + 10_000)
        d = pd.DataFrame([dict(mint="M", pool="P", hour=0, decision_slot=ds, decision_day="2026-09-11", eligible=True,
                               token_program=ps.TOKEN_2022, exit_slot_3600=e + 5000, in_time_3600=True, exit_slot_900=0,
                               in_time_900=False, exit_slot_14400=0, in_time_14400=False)
                          for ds in (e - 24, e - 23)])  # entry slots e - 1 (epoch 1032) and e (epoch 1033)
        reg = O.run(d, books)
        reg = reg[reg.usd == 50.0]
        self.assertEqual(list(reg.fixed), [ps.expected_fixed(1_887_234), ps.expected_fixed(1_513_840)])

    def test_refusals(self):
        r1 = amm_row(100, 1, "X", "buy", 10**12, 200 * 10**12, 80 * 10**9)
        self.assertEqual(O.price_trade(book([r1]), 50, 900, spend_of(50), self.tiers, self.fixed)["status"], "no_entry_state")
        # the vault is emptied by an outside withdrawal recorded as the next pre-state: the exit pays nothing
        r2 = amm_row(500, 1, "Y", "buy", 10, 199 * 10**12, 1, virtual=0)
        t = O.price_trade(book([r1, r2]), 200, 500, spend_of(50), self.tiers, self.fixed)
        self.assertEqual(t["status"], "exit_refused")
        self.assertAlmostEqual(t["net_lamports"], -t["paid"] - self.fixed)


def feats_table(n_mints=10, hours=6, day="2026-09-11", seed=1):
    rng = np.random.default_rng(seed)
    rows = []
    for m in range(n_mints):
        for h in range(hours):
            rows.append(dict(mint=f"m{m}", pool=f"p{m}", hour=h * 3600, decision_slot=1000 * m + h, decision_day=day,
                             eligible=True, in_time_3600=True, cgo=float(rng.normal()), cgo_post=float(rng.normal()),
                             r_1h=float(rng.normal(0, .1)), r_6h=float(rng.normal(0, .1)), r_mig=float(rng.normal(0, .1))))
    return pd.DataFrame(rows)


def outs_for(f, net, gross=0.0, cost=0.03):
    o = f[["mint", "pool", "decision_slot", "decision_day"]].copy()
    o["hold"], o["usd"], o["status"] = 3600, 50.0, "ok"
    o["net_lamports"] = net if np.ndim(net) else [net] * len(o)
    o["paid"] = spend_of(50)
    o["net_ret"] = o.net_lamports / o.paid
    o["gross"] = gross if np.ndim(gross) else [gross] * len(o)
    o["cost_ret"] = cost
    o["fixed"], o["entry_fees"], o["exit_fees"], o["entry_impact"], o["exit_impact"] = 414009.0, 1, 1, 1, 1
    return o


class Gate0(unittest.TestCase):
    def test_counts_r2_spread(self):
        f = feats_table(n_mints=40, hours=10)
        g = S.gate0(f, ["2026-09-11"])
        self.assertEqual(g["eligible_points"], 400)
        self.assertEqual(g["eligible_first_per_mint_day"], 40)
        self.assertFalse(g["a_pass"])  # 40 a day < 150
        self.assertTrue(g["b_pass"] and g["c_pass"])
        f2 = f.assign(cgo=f.r_1h * 3 + f.r_mig)  # CGO is a price path: R² = 1
        self.assertFalse(S.gate0(f2, ["2026-09-11"])["b_pass"])
        f3 = f.assign(cgo=f.cgo * 0.01)
        self.assertFalse(S.gate0(f3, ["2026-09-11"])["c_pass"])

    def test_one_discovery_day_gives_no_pass_R2_4(self):
        """R2-4: gate (a) is an average over both Step A days. A run on one day (chosen after a look) can never pass."""
        f = feats_table(n_mints=200, hours=3)
        one = S.gate0(f, ["2026-09-11"])
        self.assertTrue(one["a_pass"] and one["b_pass"] and one["c_pass"])
        self.assertFalse(one["passed"])
        both = pd.concat([f, feats_table(n_mints=200, hours=3, day="2026-09-10", seed=2)], ignore_index=True)
        self.assertTrue(S.gate0(both, ["2026-09-10", "2026-09-11"])["passed"])

    def test_not_eligible_or_out_of_time_do_not_count(self):
        f = feats_table(n_mints=4, hours=3)
        f.loc[0, "eligible"] = False
        f.loc[1, "in_time_3600"] = False
        self.assertEqual(S.gate0(f, ["2026-09-11"])["eligible_points"], 10)

    def test_refuses_validation_days(self):
        with self.assertRaises(ValueError):
            S.gate0(feats_table(day="2026-09-08"), ["2026-09-08"])


class Entries(unittest.TestCase):
    def test_first_qualifying_per_mint_day(self):
        f = feats_table(n_mints=3, hours=4)
        f["cgo"] = [0.0, 5.0, 6.0, 0.0] * 3
        bp = dict(p20=-1.0, p80=1.0)
        e = S.entries(f, "high", bp)
        self.assertEqual(sorted(e.decision_slot % 1000), [1, 1, 1])  # the first point above P80 for each mint
        self.assertEqual(len(S.entries(f, "low", bp)), 0)


class SignFutility(unittest.TestCase):
    def test_sign_and_futility(self):
        f = feats_table(n_mints=50, hours=1)
        f["cgo"] = np.linspace(-1, 1, 50)
        gross = np.where(f.cgo > 0.5, 0.10, 0.0)
        r = S.sign_and_futility(f, outs_for(f, 0.0, gross=gross, cost=0.03))
        self.assertEqual(r["sign"], "high")
        self.assertAlmostEqual(r["lift_high"], 0.10 - gross.mean())
        self.assertFalse(r["futile"])
        r2 = S.sign_and_futility(f, outs_for(f, 0.0, gross=gross, cost=0.5))
        self.assertTrue(r2["futile"])


class Primary(unittest.TestCase):
    frozen = dict(sign="high", breakpoints=dict(p20=-0.8, p40=-0.2, p60=0.2, p80=0.8, post_p20=-0.8, post_p80=0.8))

    def _f(self, n_per_day):
        fs = []
        for i, d in enumerate(["2026-09-07", "2026-09-08", "2026-09-09"]):
            f = feats_table(n_mints=n_per_day, hours=1, day=d, seed=i)
            f["mint"] = f.mint + d
            f["pool"] = f.pool + d
            f["cgo"] = np.where(np.arange(len(f)) % 2 == 0, 2.0, 0.0)
            fs.append(f)
        return pd.concat(fs, ignore_index=True)

    def test_pass(self):
        f = self._f(240)
        net = np.where(f.cgo > 1, 2e7 + 1e6 * np.sin(np.arange(len(f))), -1e7)
        p = S.primary(f, outs_for(f, net), self.frozen, VDAYS)
        self.assertEqual(p["n_trades"], 360)
        self.assertEqual(p["verdict"], "pass")
        self.assertLess(p["ci995"][0], p["ci95"][0])
        self.assertTrue(all(p["conditions"].values()))

    def test_unresolved_and_not_supported(self):
        f = self._f(100)
        net = np.where(f.cgo > 1, 2e7, -1e7)
        self.assertEqual(S.primary(f, outs_for(f, net), self.frozen, VDAYS)["verdict"], "unresolved")
        f = self._f(240)
        net = np.where(f.cgo > 1, np.where(f.decision_day == "2026-09-08", -1e6, 2e7), -1e7)
        p = S.primary(f, outs_for(f, net), self.frozen, VDAYS)
        self.assertFalse(p["conditions"]["every_day_above_0"])
        self.assertEqual(p["verdict"], "not supported")

    def test_a_validation_day_with_no_trades_fails(self):
        f = self._f(320)
        f = f[f.decision_day != "2026-09-08"]  # every trade on the other two days is positive
        net = np.where(f.cgo > 1, 2e7, -1e7)
        p = S.primary(f, outs_for(f, net), self.frozen, VDAYS)
        self.assertFalse(p["conditions"]["every_day_above_0"])
        self.assertEqual(p["verdict"], "not supported")
        with self.assertRaises(ValueError):  # the stage must have read exactly the validation days
            S.primary(f, outs_for(f, net), self.frozen, ["2026-09-07", "2026-09-09"])

    def test_guards(self):
        with self.assertRaises(ValueError):
            S.primary(feats_table(), outs_for(feats_table(), 1.0), self.frozen, VDAYS)  # discovery day
        f = self._f(10)
        with self.assertRaises(ValueError):
            S.primary(f, outs_for(f, 1.0), dict(sign=None, breakpoints={}), VDAYS)


class Bootstrap(unittest.TestCase):
    def test_stratified_cluster_and_seeded(self):
        day = np.array(["a", "b"])
        pool = np.array(["p", "q"])
        x = np.array([1.0, 3.0])
        b = S.cluster_bootstrap(day, pool, x, n=200)
        self.assertTrue(np.allclose(b, 2.0))  # one pool a day: every resample keeps both days
        day = np.array(["a"] * 6)
        pool = np.array(["p", "p", "p", "q", "q", "r"])
        x = np.array([1.0, 1.0, 1.0, 5.0, 5.0, 9.0])
        b1 = S.cluster_bootstrap(day, pool, x, n=500)
        b2 = S.cluster_bootstrap(day, pool, x, n=500)
        self.assertTrue(np.array_equal(b1, b2))
        self.assertTrue(set(np.round(b1, 6)) <= {round(v, 6) for v in _cluster_means()})


def _cluster_means():
    import itertools
    sums, cnts = {"p": 3.0, "q": 10.0, "r": 9.0}, {"p": 3, "q": 2, "r": 1}
    return [sum(sums[k] for k in c) / sum(cnts[k] for k in c) for c in itertools.product("pqr", repeat=3)]


if __name__ == "__main__":
    unittest.main()
