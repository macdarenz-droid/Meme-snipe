"""AMENDMENT_3: the D60 arm (habits, D60 as of the decision, gate rows, arm) and H8 at trade size (H8_AMENDMENT)."""
import os
import tempfile
import unittest

import numpy as np
import pandas as pd

from h1cgo import h8 as H8
from h1cgo import habits as HB
from h1cgo import outcomes as O
from h1cgo import stats as S
from h1cgo.constants import VALIDATION_DAYS
from h1cgo.features import Clock, build_streams, compute_features, decision_points, schedule_windows
from tests.synth import AMM_COLS, CURVE_COLS, DAY0, T_COLS, amm_row, blocks, curve_row, frame, t_of, tcov, universe
from tests.test_features import PoolChain

VDAYS = list(VALIDATION_DAYS)


def crow(slot, owner, buy, tok, pre, post, mint="M"):
    r = curve_row(slot, 1, owner, buy, tok, 10**9, mint=mint, post=post)
    r["owner_token_pre"] = str(pre)
    return r


class Habits(unittest.TestCase):
    def test_round_trips_pair_open_with_close(self):
        c = frame([crow(10, "A", True, 5, 0, 5, "X"), crow(30, "A", True, 5, 5, 10, "X"),  # a second buy is no open
                   crow(50, "A", False, 10, 10, 0, "X"),  # close: hold = t(50) - t(10)
                   crow(60, "A", False, 3, 3, 0, "Y"),  # a close with no open (tokens by transfer): no round trip
                   crow(70, "B", True, 4, 0, 4, "X"), crow(90, "B", False, 2, 4, 2, "X")], CURVE_COLS)  # still open
        rt = HB.round_trips(HB.events_from(c, "curve"))
        self.assertEqual(rt.values.tolist(), [["A", 50, t_of(50) - t_of(10)]])

    def test_median_is_as_of(self):
        h = HB.Habits(pd.DataFrame(dict(owner=["A"] * 3, close_slot=[100, 200, 300], hold_s=[10, 1000, 30])))
        self.assertIsNone(h.median_before("A", 99))
        self.assertEqual(h.median_before("A", 100), 10)
        self.assertEqual(h.median_before("A", 250), 505)
        self.assertEqual(h.median_before("A", 300), 30)
        self.assertIsNone(h.median_before("Z", 10**9))

    def test_d60_due_and_traceable(self):
        h = HB.Habits(pd.DataFrame(dict(owner=["A", "B", "C"], close_slot=[1, 1, 1], hold_s=[600, 100_000, 60])))
        # A: age 0, median 600 <= 3,600: due. B: median far beyond: not due. C: habit but no known open. D: no habit.
        r = HB.d60([("A", 10), ("B", 20), ("C", 30), ("D", 40)], {"A": 1000, "B": 1000}, h, 5, 1000)
        self.assertAlmostEqual(r["d60"], 10 / 100)
        self.assertAlmostEqual(r["d60_traceable"], 30 / 100)
        self.assertEqual((r["d60_holders"], r["d60_habit_holders"]), (4, 3))
        overdue = HB.d60([("A", 10)], {"A": 0}, h, 5, 10_000)  # age 10,000 s, median 600: overdue counts as due
        self.assertEqual(overdue["d60"], 1.0)


def d60_world(extra_curve=()):
    """Coin M plus round trips on another coin X that set the habits of A (fast) and B (slow)."""
    curve = [crow(2, "A", True, 10, 0, 10, "X"), crow(40, "A", False, 10, 10, 0, "X"),  # A: hold 19 s
             crow(3, "B", True, 10, 0, 10, "X"), crow(30_000, "B", False, 10, 10, 0, "X"),  # B: hold ~4 h, closes later
             crow(20, "A", True, 50 * 10**12, 0, 50 * 10**12), crow(25, "B", True, 30 * 10**12, 0, 30 * 10**12),
             *extra_curve]
    ch = PoolChain()
    ch.trade(1100, "C", "buy", 10 * 10**12)
    ch.trade(16000, "D", "buy", 5 * 10**12)
    c = frame(curve, CURVE_COLS)
    rt = HB.round_trips(HB.events_from(c, "curve"))
    return universe(mig_slot=1000), c, frame(ch.rows, AMM_COLS), rt


def feats_of(u, c, amm, rt, last=60_000):
    clock = Clock.from_blocks(blocks(last))
    dp = schedule_windows(decision_points(u, clock, [(0, last)]), clock)
    return compute_features(dp, build_streams(u, c[c.mint == "M"], amm, frame([], T_COLS), tcov(), habits=HB.Habits(rt)))


class D60Features(unittest.TestCase):
    def test_d60_in_features_and_as_of(self):
        u, c, amm, rt = d60_world()
        f = feats_of(u, c, amm, rt)
        self.assertIn("d60", f.columns)
        first, late = f.iloc[0], f[f.decision_slot >= 30_000].iloc[0]
        # before slot 30,000 only A has a habit (19 s): A's tokens are due; B is untraceable
        self.assertAlmostEqual(first.d60, 50 / (50 + 30 + 10), places=6)  # C bought 10e12 on the pool (no habit)
        self.assertEqual(first.d60_habit_holders, 1)
        self.assertEqual(late.d60_habit_holders, 2)  # B's round trip closed at 30,000: now visible
        # the same round trip planted only in the future of the first decision changes nothing there
        rt_cut = rt[rt.close_slot <= first.decision_slot]
        g = feats_of(u, c, amm, rt_cut)
        self.assertEqual(g.iloc[0].d60, first.d60)
        self.assertEqual(g.iloc[0].d60_habit_holders, first.d60_habit_holders)

    def test_position_emptied_by_transfer_loses_its_open(self):
        from tests.synth import t_row
        u, c, amm, rt = d60_world()
        # A (has a habit) sends every token away, then gets them back: the new position has no recorded open
        out_back = [t_row(5000, 1, "transfer", "A", "Z", 50 * 10**12), t_row(6000, 1, "transfer", "Z", "A", 50 * 10**12)]
        f = compute_features(*self._dp(u), build_streams(u, c[c.mint == "M"], amm, frame(out_back, T_COLS), tcov(),
                                                          habits=HB.Habits(rt)))
        r = f.iloc[0]
        self.assertEqual(r.d60_habit_holders, 1)  # A still has a habit
        self.assertEqual(r.d60_traceable, 0.0)  # but A's tokens are no longer traceable
        self.assertEqual(r.d60, 0.0)
        # a burn of everything clears the open too
        burn = [t_row(5000, 1, "burn", "A", "", 50 * 10**12), t_row(6000, 1, "transfer", "Z2", "A", 1)]
        st = build_streams(u, c[c.mint == "M"], amm, frame(burn, T_COLS), tcov(), habits=HB.Habits(rt))["M"]
        st.advance(7000)
        self.assertNotIn("A", st.open_time)

    @staticmethod
    def _dp(u, last=60_000):
        clock = Clock.from_blocks(blocks(last))
        return (schedule_windows(decision_points(u, clock, [(0, last)]), clock),)

    def test_controls(self):
        u, c, amm, rt = d60_world()
        f = feats_of(u, c, amm, rt)
        self.assertTrue((f.volume_1h >= 0).all() and (f.vol_1h >= 0).all())
        r = f[f.decision_slot > 16000].iloc[0]  # the 16,000 trade is in this decision's past hour (t = 8,000 s)
        self.assertGreater(r.volume_1h, 0)


class Flows(unittest.TestCase):
    def test_next_hour_window_and_exclusions(self):
        rows = [amm_row(110, 1, "S", "sell", 7, 10**12, 80 * 10**9), amm_row(150, 1, "B", "buy", 5, 10**12, 80 * 10**9),
                amm_row(160, 1, "P", "buy", 9, 10**12, 80 * 10**9, protocol="1"),
                amm_row(170, 1, "Q", "buy", 9, 10**12, 80 * 10**9), amm_row(300, 1, "S", "sell", 100, 10**12, 80 * 10**9),
                amm_row(100, 1, "S", "sell", 100, 10**12, 80 * 10**9)]  # at the decision slot: before the window
        rows[3]["signature"], rows[3]["outer_ix"] = "BOOSTSIG", "4"
        d = pd.DataFrame([dict(mint="M", pool="P", decision_slot=100, decision_day="2026-09-11", eligible=True,
                               in_time_flow=True, flow_end_slot=200)])
        f = O.flows(d, frame(rows, AMM_COLS), {("BOOSTSIG", "4", "P")}).iloc[0]
        self.assertEqual(f.sell_tokens, 7)
        self.assertEqual(f.buy_sol, int(rows[1]["user_quote_amount"]))
        self.assertEqual(f.net_flow_sol, int(rows[1]["user_quote_amount"]) - int(rows[0]["user_quote_amount"]))


def gate_table(n=200, seed=3, rho=True, flow_sign=1.0):
    rng = np.random.default_rng(seed)
    rows, fl = [], []
    for i in range(n):
        d = float(rng.uniform(0, 1))
        sells = d * 1000 + rng.normal(0, 100) if rho else rng.uniform(0, 1000)
        rows.append(dict(mint=f"m{i}", pool=f"p{i % 40}", decision_slot=i, decision_day="2026-09-1" + str(i % 2),
                         eligible=True, in_time_3600=True, d60=d, d60_traceable=0.95, d60_holders=10,
                         d60_habit_holders=7, known_tokens=1000, unknown_tokens=0, cgo=float(rng.normal()),
                         r_1h=float(rng.normal()), r_6h=float(rng.normal()), r_mig=float(rng.normal()),
                         vol_1h=float(rng.uniform()), volume_1h=float(rng.uniform(0, 10**10))))
        fl.append(dict(mint=f"m{i}", decision_slot=i, sell_tokens=max(int(sells), 0),
                       net_flow_sol=flow_sign * 1e8 * (1.5 - d)))
    return pd.DataFrame(rows), pd.DataFrame(fl)


class D60Gate(unittest.TestCase):
    def test_pass_and_each_row_failing(self):
        f, fl = gate_table()
        g = S.d60_gate(f, fl, n_boot=200)
        self.assertTrue(g["passed"], g)
        self.assertAlmostEqual(g["habit_share"], 0.7)
        self.assertAlmostEqual(g["d60_p20"], float(np.percentile(f.d60, 20)))
        self.assertFalse(S.d60_gate(f.assign(d60_habit_holders=5), fl, n_boot=200)["rows"]["habit"])
        self.assertFalse(S.d60_gate(f.assign(d60_traceable=0.85), fl, n_boot=200)["rows"]["traceable"])
        self.assertFalse(S.d60_gate(*gate_table(rho=False), n_boot=200)["rows"]["rho"])
        self.assertFalse(S.d60_gate(*gate_table(flow_sign=-1.0), n_boot=200)["rows"]["bottom_net_flow"])
        f2 = f.assign(cgo=f.d60 * 5)  # D60 is CGO in disguise
        self.assertFalse(S.d60_gate(f2, fl, n_boot=200)["rows"]["independence"])

    def test_refuses_validation_days(self):
        f, fl = gate_table()
        with self.assertRaises(ValueError):
            S.d60_gate(f.assign(decision_day="2026-09-08"), fl)

    def test_partial_spearman(self):
        rng = np.random.default_rng(0)
        c = rng.normal(size=500)
        x, y = c + rng.normal(0, .1, 500), c + rng.normal(0, .1, 500)
        self.assertGreater(S.spearman(x, y), 0.8)
        self.assertLess(abs(S.partial_spearman(x, y, [c])), 0.2)  # only the control links them


def val_feats(n_per_day=240):
    fs = []
    for i, d in enumerate(VDAYS):
        rng = np.random.default_rng(i)
        f = pd.DataFrame(dict(mint=[f"m{k}{d}" for k in range(n_per_day)], pool=[f"p{k}{d}" for k in range(n_per_day)],
                              decision_slot=np.arange(n_per_day), decision_day=d, eligible=True, in_time_3600=True,
                              hour=DAY0, cgo=np.where(np.arange(n_per_day) % 2 == 0, 2.0, 0.0),
                              d60=rng.uniform(0, 1, n_per_day),
                              eff_quote=np.where(np.arange(n_per_day) % 4 == 0, 500 * 10**9, 100 * 10**9),
                              quote_at_migration=85 * 10**9, mig_time=DAY0 - 2 * 3600, h6_lp_outstanding=0,
                              h11_spike=False, h11_chase_reject=False, creator_fee_zero=False))
        fs.append(f)
    return pd.concat(fs, ignore_index=True)


def outs(f, usd_list=(5.0, 20.0, 50.0), net=lambda f: np.where(f.cgo > 1, 2e7, -1e7)):
    o = []
    for usd in usd_list:
        x = f[["mint", "pool", "decision_slot", "decision_day"]].copy()
        x["hold"], x["usd"], x["status"] = 3600, usd, "ok"
        x["net_lamports"] = net(f)
        x["net_ret"] = x.net_lamports / 4e8
        o.append(x)
    return pd.concat(o, ignore_index=True)


FROZEN = dict(sign="high", breakpoints=dict(p20=-1.0, p80=1.0), d60=dict(passed=True, d60_p20=0.2))


class H8Stratum(unittest.TestCase):
    def test_floor_and_price(self):
        s = H8.SolUsd({DAY0: 119_260_000}, [])
        # $50 floor: $50,000 -> 419.25 SOL at $119.26
        self.assertTrue(H8.eligible(420 * 10**9, DAY0, 50, s))
        self.assertFalse(H8.eligible(419 * 10**9, DAY0, 50, s))
        self.assertTrue(H8.eligible(126 * 10**9, DAY0, 5, s))  # $15,000 floor: about 125.8 SOL
        self.assertFalse(H8.eligible(125 * 10**9, DAY0, 5, s))
        self.assertFalse(H8.eligible(10**15, DAY0 - 1, 5, s))  # no point at or before: H16 refusal
        self.assertFalse(H8.eligible(10**15, DAY0 + 2 * 3600 + 1, 5, s))  # stale point
        self.assertFalse(H8.eligible(float("nan"), DAY0, 5, s))

    def test_klines_hour_points(self):
        with tempfile.TemporaryDirectory() as t:
            p1 = os.path.join(t, "1m.csv")  # ms: the 23:59 bar closes the hour ending at DAY0
            pd.DataFrame([[(DAY0 - 60) * 1000, "1", "1", "1", "150.5", "0", DAY0 * 1000 - 1],
                          [(DAY0 - 120) * 1000, "1", "1", "1", "149", "0", (DAY0 - 60) * 1000 - 1]]).to_csv(p1, header=False, index=False)
            p2 = os.path.join(t, "1h.csv")  # us, 1-hour bars
            pd.DataFrame([[DAY0 * 10**6, "1", "1", "1", "151.25", "0", (DAY0 + 3600) * 10**6 - 1]]).to_csv(p2, header=False, index=False)
            s = H8.SolUsd.from_klines([p1, p2])
            self.assertEqual(s.at(DAY0), 150_500_000)
            self.assertEqual(s.at(DAY0 + 3599), 150_500_000)
            self.assertEqual(s.at(DAY0 + 3600), 151_250_000)
            self.assertEqual(len(s.files), 2)
            self.assertEqual(len(s.files[0]["sha256"]), 64)

    def test_stratum_tradable_or_not(self):
        f = val_feats()
        s = H8.SolUsd({DAY0: 100_000_000}, [])  # $100 a SOL: $50 floor = 500 SOL; $5 floor = 150 SOL
        r = S.h8_stratum(f, outs(f), FROZEN, VDAYS, s)
        self.assertEqual(r["$50"]["n_trades"], 180)  # 1 in 4 pools hold 500 SOL, all of them in the high extreme
        self.assertIs(r["tradable_as_bot_stands"], False)  # 180 < 300 at $5
        f2 = val_feats(800)
        r2 = S.h8_stratum(f2, outs(f2), FROZEN, VDAYS, s)
        self.assertEqual(r2["$5"]["n_trades"], 600)
        self.assertIs(r2["tradable_as_bot_stands"], True)  # U2 pools at 2 h, 600 positive trades at $5

    def test_tradable_claim_waits_for_h8_amendment_2_R2_10(self):
        """R2-10, now implemented: "tradable as the bot stands" is judged only at $5, on the floor of the universe the
        bot would tag (U2 60-240 min with H11; U1 $50k; 4-24 h not tradable), with H6 (tests/test_h8_amendment2.py).
        $20 and $50 never make the claim, and nothing at 4-24 h counts."""
        f2 = val_feats(800)
        s = H8.SolUsd({DAY0: 100_000_000}, [])
        five_negative = outs(f2, usd_list=(5.0,), net=lambda f: np.where(f.cgo > 1, -1e6, -1e7))
        r2 = S.h8_stratum(f2, pd.concat([five_negative, outs(f2, usd_list=(20.0, 50.0))]), FROZEN, VDAYS, s)
        self.assertGreater(r2["$50"]["mean_net_sol"], 0)
        self.assertIs(r2["tradable_as_bot_stands"], False)
        r3 = S.h8_stratum(f2.assign(mig_time=DAY0 - 6 * 3600), outs(f2), FROZEN, VDAYS, s)
        self.assertIs(r3["tradable_as_bot_stands"], False)

    def test_count_rows(self):
        f = val_feats(8).assign(decision_day="2026-09-11", has_state=True)
        c = H8.count_rows(f, H8.SolUsd({DAY0: 100_000_000}, []))
        self.assertEqual(c["with_state_$50"]["2026-09-11"], dict(pool_hours=6, graduates=6))
        self.assertEqual(c["h1cgo_eligible_$5"]["2026-09-11"]["pool_hours"], 6)


def write_sol_dir(folder, days, price="100.0", tamper=None, minute_price=None):
    """Synthetic committed SOL/USD folder: 1h and 1m zips per day (us timestamps) and SHA256SUMS."""
    import hashlib
    import zipfile
    os.makedirs(folder, exist_ok=True)
    lines = []
    for d in days:
        t0 = int(pd.Timestamp(d, tz="UTC").timestamp())
        for iv, step in (("1h", 3600), ("1m", 60)):
            px = minute_price if (iv == "1m" and minute_price) else price
            rows = "".join(f"{(t0 + k) * 10**6},1,1,1,{px},0,{(t0 + k + step) * 10**6 - 1},0,0,0,0,0\n"
                           for k in range(0, 86400, step))
            name = f"SOLUSDT-{iv}-{d}.zip"
            with zipfile.ZipFile(os.path.join(folder, name), "w") as z:
                z.writestr(name.replace(".zip", ".csv"), rows)
            with open(os.path.join(folder, name), "rb") as f:
                lines.append(f"{hashlib.sha256(f.read()).hexdigest()}  {name}\n")
    open(os.path.join(folder, "SHA256SUMS"), "w").write("".join(lines))
    if tamper:
        with open(os.path.join(folder, tamper), "ab") as f:
            f.write(b"\0")


def _pin(folder):
    import hashlib
    with open(os.path.join(folder, "SHA256SUMS"), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class Amendment4(unittest.TestCase):
    def test_sums_file_is_pinned(self):
        self.assertEqual(H8.check_pin(), H8.SOL_USD_SUMS_SHA256)
        with tempfile.TemporaryDirectory() as t:
            write_sol_dir(t, ["2026-09-06", "2026-09-07"])  # consistent zips and lines, but not the pinned file
            with self.assertRaisesRegex(ValueError, "not the pinned"):
                H8.load_committed(["2026-09-07"], t)
            with self.assertRaisesRegex(ValueError, "not the pinned"):
                H8.check_pin(t)

    def test_dust_at_migration(self):
        s = H8.SolUsd({DAY0: 119_260_000}, [])
        self.assertTrue(H8.eligible(10**12, DAY0, 5, s, 5 * 10**9))
        self.assertFalse(H8.eligible(10**12, DAY0, 5, s, 5 * 10**9 - 1))  # dust at migration
        self.assertFalse(H8.eligible(10**12, DAY0, 5, s, float("nan")))  # no migration pool quote seen
        f = val_feats(8).assign(quote_at_migration=[4 * 10**9] * 12 + [85 * 10**9] * 12)
        g = H8.flags(f, H8.SolUsd({DAY0: 100_000_000}, []))
        self.assertFalse(g.h8_5.iloc[:12].any())
        self.assertEqual(int(g.h8_5.iloc[12:].sum()), 3)  # only points are removed

    def test_universe_reads_the_migration_pool_quote(self):
        from h1cgo.features import build_universe
        c = [dict(event="CreateEvent", program="pump", slot="1", block_time=str(DAY0),
                  fields=dict(mint="a", bonding_curve="bc", quote_mint="11111111111111111111111111111111"))]
        g = [dict(event="CompletePumpAmmMigrationEvent", slot="5", block_time=str(DAY0 + 1), fields=dict(mint="a", pool="pa"))]
        p = [dict(event="CreatePoolEvent", fields=dict(pool="pa", quote_mint="So11111111111111111111111111111111111111112",
                                                       pool_quote_amount="84990000000"))]
        u, _ = build_universe(c, g, {"2026-09-11"}, p)
        self.assertEqual(u.quote_at_migration.iloc[0], 84_990_000_000)
        u2, _ = build_universe(c, g, {"2026-09-11"}, [])
        self.assertTrue(np.isnan(u2.quote_at_migration.iloc[0]))

    def test_committed_sol_usd_checks(self):
        with tempfile.TemporaryDirectory() as t:
            ok = os.path.join(t, "ok")
            write_sol_dir(ok, ["2026-09-06", "2026-09-07"])
            s = H8.load_committed(["2026-09-07"], ok, pin=_pin(ok))
            self.assertEqual(s.at(int(pd.Timestamp("2026-09-07T05:30", tz="UTC").timestamp())), 100_000_000)
            self.assertEqual(len(s.files), 4)
            with self.assertRaisesRegex(ValueError, "missing for 2026-09-08"):
                H8.load_committed(["2026-09-08"], ok, pin=_pin(ok))  # 09-08 absent (its day before is present)
            with self.assertRaisesRegex(ValueError, "missing for 2026-09-05"):
                H8.load_committed(["2026-09-06"], ok, pin=_pin(ok))  # the day before is needed for the 00:00 decision
            bad = os.path.join(t, "bad")
            write_sol_dir(bad, ["2026-09-06", "2026-09-07"], tamper="SOLUSDT-1m-2026-09-06.zip")
            with self.assertRaisesRegex(ValueError, "does not match SHA256SUMS"):
                H8.load_committed(["2026-09-07"], bad, pin=_pin(bad))
            gone = os.path.join(t, "gone")
            write_sol_dir(gone, ["2026-09-06", "2026-09-07"])
            os.remove(os.path.join(gone, "SOLUSDT-1h-2026-09-07.zip"))
            with self.assertRaisesRegex(ValueError, "listed in SHA256SUMS is missing"):
                H8.load_committed(["2026-09-07"], gone, pin=_pin(gone))
            odd = os.path.join(t, "odd")
            write_sol_dir(odd, ["2026-09-06", "2026-09-07"], minute_price="101.0")
            with self.assertRaisesRegex(ValueError, "differ"):
                H8.load_committed(["2026-09-07"], odd, pin=_pin(odd))

    def test_the_committed_folder_covers_both_stages(self):
        self.assertGreater(len(H8.load_committed(list(VALIDATION_DAYS)).t), 0)
        self.assertGreater(len(H8.load_committed(["2026-09-10", "2026-09-11"]).t), 0)


class D60Arm(unittest.TestCase):
    def test_judged_only_after_gate_and_primary(self):
        f = val_feats(800)
        o = outs(f)
        p = S.primary(f, o, FROZEN, VDAYS)
        self.assertEqual(p["verdict"], "pass")
        a = S.d60_arm(f, o, FROZEN, VDAYS, p)
        self.assertIn("lift_over_h1cgo_above_0", a["conditions"])
        self.assertFalse(a["conditions"]["lift_over_h1cgo_above_0"])  # same returns: no lift over H1-CGO
        better = outs(f, net=lambda f: np.where(f.cgo > 1, np.where(f.d60 <= 0.2, 4e7, 2e7), -1e7))
        a2 = S.d60_arm(f, better, FROZEN, VDAYS, S.primary(f, better, FROZEN, VDAYS))
        self.assertTrue(a2["conditions"]["lift_over_h1cgo_above_0"])
        self.assertEqual(a2["n_trades"], int(((f.cgo > 1) & (f.d60 <= 0.2)).sum()))
        no_gate = dict(FROZEN, d60=dict(passed=False, d60_p20=0.2))
        self.assertTrue(S.d60_arm(f, o, no_gate, VDAYS, p)["verdict"].startswith("not judged"))
        self.assertTrue(S.d60_arm(f, o, FROZEN, VDAYS, dict(verdict="unresolved"))["verdict"].startswith("not judged"))


class Amendment6(unittest.TestCase):
    """AMENDMENT_6 (CODE_REDTEAM.md R1-19): the H8-tradable stratum applies H8 first, then keeps the first eligible
    entry per coin per day; the unfiltered primary still takes the first entry."""

    def feats(self, eff_first, eff_later):
        f = val_feats(8).assign(eff_quote=100 * 10**9)                 # $100 a SOL: 100 SOL fails the $5 floor (150)
        x = f.iloc[:2].copy()
        x["mint"], x["pool"], x["decision_day"] = "X", "pX", VDAYS[0]
        x["decision_slot"], x["cgo"], x["eff_quote"] = [100, 101], 2.0, [eff_first, eff_later]
        return pd.concat([f, x], ignore_index=True)

    def outs(self, f):
        return outs(f, net=lambda g: np.where(g.decision_slot == 101, 3e7, np.where(g.cgo > 1, 2e7, -1e7)))

    def test_later_h8_eligible_entry_enters_the_stratum(self):
        s = H8.SolUsd({DAY0: 100_000_000}, [])
        f = self.feats(100 * 10**9, 500 * 10**9)                       # first entry fails H8, the later one passes
        r = S.h8_stratum(f, self.outs(f), FROZEN, VDAYS, s)["$5"]
        self.assertEqual(r["n_trades"], 1)
        self.assertAlmostEqual(r["mean_net_sol"], 0.03)                 # the slot-101 entry
        e = S.entries(f, "high", FROZEN["breakpoints"])
        self.assertEqual(int(e.loc[e.mint == "X", "decision_slot"].iloc[0]), 100)   # the primary: first entry

    def test_eligibility_is_as_of_each_entry(self):
        s = H8.SolUsd({DAY0: 100_000_000}, [])
        a = H8.flags(self.feats(500 * 10**9, 100 * 10**9), s)
        b = H8.flags(self.feats(500 * 10**9, 10**20), s)               # only the later row changes
        self.assertEqual(bool(a.loc[a.decision_slot == 100, "h8_5"].iloc[0]),
                         bool(b.loc[b.decision_slot == 100, "h8_5"].iloc[0]))
        f = self.feats(500 * 10**9, 500 * 10**9)                       # both pass: the first one is the entry
        r = S.h8_stratum(f, self.outs(f), FROZEN, VDAYS, s)["$5"]
        self.assertEqual(r["n_trades"], 1)
        self.assertAlmostEqual(r["mean_net_sol"], 0.02)


if __name__ == "__main__":
    unittest.main()
