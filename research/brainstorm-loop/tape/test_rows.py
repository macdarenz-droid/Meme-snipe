"""Unit tests for the Step A count rows on small synthetic tables.  Run: python3 -m unittest -v (from this folder)."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import h8 as H8  # noqa: E402
import rebuy as RB  # noqa: E402
import slicer as SL  # noqa: E402
import migseat as MS  # noqa: E402
import rows as R  # noqa: E402
from tapeio import AMM_COLS, CURVE_COLS, SOL_NATIVE, WSOL, Tape  # noqa: E402

DAY = "2026-09-11"
T0 = 1_000_000          # block_time = T0 + slot (one second a slot)
SUPPLY = 1e15


class Unit:
    def __init__(self, lo=0, hi=9999):
        self.lo, self.hi = lo, hi
        self.curve, self.amm, self.t, self.w, self.ev, self.f = [], [], [], [], [], []
        self.n = 0

    def _base(self, slot, owner, signer=None):
        self.n += 1
        return {"slot": slot, "block_time": T0 + slot, "tx_idx": self.n, "ev_idx": 0, "signature": f"sig{self.n}",
                "signer": signer or owner, "user_token_owner": owner, "owner_token_pre": 0, "owner_token_post": 0,
                "signer_sol_pre": 1, "signer_sol_post": 1}

    def cbuy(self, slot, owner, mint, sol=1e9, buy=True, pre=0, post=0, creator="DEV", tokens=1, protocol=0):
        r = self._base(slot, owner)
        r.update({"mint": mint, "is_buy": int(buy), "sol_amount": sol, "token_amount": tokens,
                  "quote_mint": SOL_NATIVE, "protocol": protocol, "top_program": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "mayhem_mode": 0, "creator": creator, "owner_token_pre": pre, "owner_token_post": post})
        self.curve.append(r)
        return r

    def aswap(self, slot, owner, mint, pool, sol=1e9, buy=True, pre=0, post=0, creator="DEV", signer=None,
              sig=None, quote=80e9, virtual=20e9, base=1e14, tokens=1, chain=True, fee_bps=5):
        r = self._base(slot, owner, signer)
        r.update({"base_mint": mint, "pool": pool, "side": "buy" if buy else "sell", "quote_amount": sol,
                  "base_amount": tokens, "quote_mint": WSOL, "protocol": 0, "canonical": 1, "coin_creator": creator,
                  "pool_base_token_reserves": base, "pool_quote_token_reserves": quote, "chain_pool_base": base,
                  "chain_pool_quote": quote, "virtual_quote_reserves": virtual, "base_supply": SUPPLY,
                  "owner_token_pre": pre, "owner_token_post": post, "quote_amount_lp_adjusted": sol,
                  "coin_creator_fee_basis_points": fee_bps,
                  "top_program": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"})
        if sig:
            r["signature"] = sig
        if not chain:
            r["chain_pool_base"] = r["chain_pool_quote"] = None
        self.amm.append(r)
        return r

    def event(self, name, slot, fields, sig=None):
        self.n += 1
        self.ev.append({"event": name, "slot": slot, "block_time": T0 + slot, "signature": sig or f"e{self.n}",
                        "fields": fields})

    def create(self, slot, mint, creator="DEV", name=None):
        self.event("CreateEvent", slot, {"mint": mint, "creator": creator, "user": creator, "is_mayhem_mode": "0",
                                         "quote_mint": SOL_NATIVE, "name": name or mint, "symbol": name or mint})

    def migrate(self, slot, mint, pool, creator="DEV", pool_quote=85e9, pool_base=2e13):
        self.event("CompletePumpAmmMigrationEvent", slot, {"mint": mint, "pool": pool, "quote_mint": SOL_NATIVE})
        self.event("CreatePoolEvent", slot, {"pool": pool, "base_mint": mint, "quote_mint": WSOL,
                                             "is_mayhem_mode": "0", "coin_creator": creator, "creator": "x",
                                             "pool_quote_amount": str(int(pool_quote)),
                                             "pool_base_amount": str(int(pool_base))})

    def write(self, root, day=DAY):
        p = os.path.join(root, day, f"{self.lo}-{self.hi}", "research")
        os.makedirs(p, exist_ok=True)
        z = dict(index=False, compression="zstd")
        pd.DataFrame(self.curve, columns=CURVE_COLS).to_csv(os.path.join(p, "S_curve.csv.zst"), **z)
        pd.DataFrame(self.amm, columns=AMM_COLS).to_csv(os.path.join(p, "S_amm.csv.zst"), **z)
        pd.DataFrame(self.t, columns=["slot", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner",
                                      "to_owner", "amount"]).to_csv(
            os.path.join(p, "T.csv.zst"), **z)
        pd.DataFrame(self.w, columns=["slot", "from", "to"]).to_csv(os.path.join(p, "W.csv.zst"), **z)
        pd.DataFrame(self.f, columns=["slot", "block_time", "signature", "venue", "pool_or_curve", "err_class"]).to_csv(
            os.path.join(p, "F.csv.zst"), **z)
        pd.DataFrame({"slot": range(self.lo, self.hi + 1), "block_time": [T0 + s for s in range(self.lo, self.hi + 1)]}
                     ).to_csv(os.path.join(p, "B.csv.zst"), **z)
        pd.DataFrame(columns=["slot", "creator", "amount", "event"]).to_csv(os.path.join(p, "CF.csv.zst"), **z)
        with open(os.path.join(p, "E.jsonl.zst"), "wb") as fh:
            fh.write(zstandard.ZstdCompressor().compress("".join(json.dumps(e) + "\n" for e in self.ev).encode()))
        return os.path.dirname(p)


def load(u):
    d = tempfile.mkdtemp()
    tape = Tape([u.write(d)])
    adj = R.adjacency(tape.links)
    labels, _ = R.two_sided_clusters(tape)
    s = R.prepare(tape, labels)
    return tape, s, adj


class Helpers(unittest.TestCase):
    def test_creator_group_hub_cap_and_as_of(self):
        L = [("DEV", "a", 1), ("a", "b", 2), ("b", "late", 50), ("DEV", "HUB", 3)]
        L += [("HUB", f"x{i}", 4) for i in range(51)]          # HUB linked to 52 owners
        links = pd.DataFrame(L, columns=["from_owner", "to_owner", "slot"])
        g = R.creator_group(R.adjacency(links), {"DEV"}, 10)
        self.assertEqual(g, {"DEV", "a", "b"})
        self.assertIn("late", R.creator_group(R.adjacency(links), {"DEV"}, 60))

    def test_first_time_flags(self):
        s = pd.DataFrame({"mint": ["m"] * 4 + ["n"], "owner": ["a", "a", "b", None, "a"],
                          "is_buy": [True, True, True, True, True], "excluded": [False, False, True, False, False],
                          "order": range(5)})
        self.assertEqual(list(R.first_time_flags(s)), [True, False, False, False, True])

    def test_placebo_grid(self):
        g = R.placebo_grid()
        self.assertTrue(g and all(abs(c / 420 - 1) > 0.1 and abs(c / 1470 - 1) > 0.1 for c in g))
        self.assertTrue(all(340 <= c <= 1300 for c in g))
        lv = 100_000 / 119.26                                   # about 838.5 SOL
        g2 = R.placebo_grid([lv])
        self.assertTrue(all(abs(c / lv - 1) > 0.1 for c in g2))
        self.assertLess(len(g2), len(g))


class Loader(unittest.TestCase):
    def test_boost_rows_excluded_by_signature(self):
        u = Unit()
        u.aswap(10, "A0", "M", "P", sig="boostsig")          # has an owner and protocol=0
        u.event("BoostBuyAndBurnEvent", 10, {"mint": "M", "pool": "P"}, sig="boostsig")
        u.aswap(11, "A", "M", "P")
        tape, s, _ = load(u)
        self.assertEqual(int(s["boost"].sum()), 1)
        self.assertEqual(list(s.loc[s["ftb"], "owner"]), ["A"])


def dev_unit():
    u = Unit()
    # pool P: dev crosses 5% (6% -> 4%) at slot 4000, 3,900 s after migration
    u.create(10, "M")
    u.migrate(100, "M", "P")
    u.w.append({"slot": 50, "from": "DEV", "to": "G"})               # creator-group member
    u.aswap(200, "H1", "M", "P", pre=0, post=5e12)                     # existing holder
    u.aswap(4000, "DEV", "M", "P", buy=False, pre=6e13, post=4e13)
    u.aswap(4010, "X1", "M", "P", sol=1e9)                             # first-time, inside 23 slots
    u.aswap(4030, "X2", "M", "P", sol=5e9)                             # first-time, late
    u.aswap(4040, "H1", "M", "P", sol=2e9, buy=False)                  # holder sells, late
    u.aswap(4050, "G", "M", "P", sol=7e9)                              # creator group: excluded
    u.aswap(4060, "H1", "M", "P", sol=9e9)                             # repeat buyer: not first-time
    u.aswap(5000, "X3", "M", "P", sol=4e9)                             # after 15 min: out
    # pool Q: placebo crossing at 4.2% only (4.5% -> 4.0%)
    u.create(20, "N")
    u.migrate(110, "N", "Q")
    u.aswap(4100, "DEV", "N", "Q", buy=False, pre=4.5e13, post=4.0e13)
    return u


class DevZero(unittest.TestCase):
    def test_event_net_and_control(self):
        tape, s, adj = load(dev_unit())
        df, summ = R.dev_zero(tape, s, adj)
        e = df[(df["arm"] == "le5") & (df["kind"] == "event")].iloc[0]
        self.assertEqual(e["pool"], "P")
        self.assertEqual(e["ftb_sol_all"], 6e9)
        self.assertEqual(e["ftb_sol_late"], 5e9)
        self.assertEqual(e["holder_sell_late"], 2e9)
        self.assertAlmostEqual(e["net"], 3e9 / 100e9)
        c = df[(df["arm"] == "le5") & (df["kind"] == "control")].iloc[0]
        self.assertEqual(c["pool"], "Q")
        self.assertEqual(c["net"], 0)
        x = summ["le5"]
        self.assertAlmostEqual(x["median_net_excess"], 0.03)
        self.assertAlmostEqual(x["late_share_of_ftb"], 5 / 6)
        self.assertEqual(x["events_per_day"], {DAY: 1})
        self.assertFalse(R.dev_zero_decide(summ)["le5"])           # 3% < 3.4% and 1 event a day

    def test_young_pool_and_missing_history_dropped(self):
        u = dev_unit()
        u.ev = [e for e in u.ev if not (e["event"] == "CreateEvent" and e["fields"]["mint"] == "M")]
        tape, s, adj = load(u)
        df, _ = R.dev_zero(tape, s, adj)
        self.assertEqual(df[(df["pool"] == "P")]["dropped"].iloc[0], "history_not_on_tape")
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(3000, "DEV", "M", "P", buy=False, pre=6e13, post=4e13)   # 2,900 s after migration
        tape, s, adj = load(u)
        df, _ = R.dev_zero(tape, s, adj)
        self.assertEqual(len(df), 0)

    def test_zero_arm_control_dropped_when_dev_sells_again(self):
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(4000, "DEV", "M", "P", buy=False, pre=6e13, post=3e12)     # leaves 5% of holding: near-full
        u.aswap(4100, "DEV", "M", "P", buy=False, pre=3e12, post=1e12)
        tape, s, adj = load(u)
        df, _ = R.dev_zero(tape, s, adj)
        c = df[(df["arm"] == "zero") & (df["kind"] == "control")].iloc[0]
        self.assertEqual(c["dropped"], "dev_sold_again_in_window")


class TwoSidedAndW1(unittest.TestCase):
    def test_two_sided_label_and_ftb_exclusion(self):
        u = Unit()
        u.w.append({"slot": 1, "from": "A", "to": "B"})
        u.cbuy(500, "A", "Z")
        u.cbuy(700, "B", "Z", buy=False)
        u.cbuy(510, "C", "Z")
        u.cbuy(520, "D", "Z", buy=False)
        tape, s, _ = load(u)
        labels, summ = R.two_sided_clusters(tape)
        self.assertEqual(set(labels.loc[labels["rule"] == "hub_cap_50", "owner"]), {"A", "B"})
        self.assertEqual(summ["hub_cap_50"]["two_sided_clusters"], 1)
        self.assertEqual(set(s.loc[s["ftb"] & ~s["fake"], "owner"]), {"C"})

    def test_two_sided_window(self):
        u = Unit()
        u.w.append({"slot": 1, "from": "A", "to": "B"})
        u.cbuy(500, "A", "Z")
        u.cbuy(500 + R.TWO_SIDED_SLOTS + 1, "B", "Z", buy=False)
        tape, _, _ = load(u)
        labels, _ = R.two_sided_clusters(tape)
        self.assertEqual(len(labels[labels["rule"] == "hub_cap_50"]), 0)

    def test_w1_fast_class(self):
        u = Unit()
        u.create(100, "M")
        u.cbuy(102, "F", "M")                       # within 2 slots of create
        u.cbuy(300, "F", "M2")
        u.cbuy(400, "BIG", "M3", sol=2e9)
        u.cbuy(402, "Q", "M3", sol=1e8)             # 2 slots after another's >= 1 SOL buy
        u.cbuy(403, "S", "M3", sol=1e8)             # 3 slots after BIG: not
        u.cbuy(900, "S", "M4")
        tape, s, _ = load(u)
        f = R.w1_fast_class(tape, s)
        self.assertTrue(f[(DAY, "F")])
        self.assertTrue(f[(DAY, "Q")])
        self.assertFalse(f[(DAY, "S")])
        self.assertFalse(f[(DAY, "BIG")])


class SeatDrift(unittest.TestCase):
    def _unit(self, link=False):
        u = Unit()
        for mint, pool, m, c in (("A", "PA", 200, "CA"), ("B", "PB", 250, "CB"), ("C", "PC", 1000, "CC")):
            u.create(m - 100, mint, creator=c)
            u.migrate(m, mint, pool, creator=c)
            u.aswap(m + 1, "seed" + mint, mint, pool, creator=c)
        if link:
            u.w.append({"slot": 5, "from": "CA", "to": "CB"})
        # pool PA: first-time buy in w1 and in w2
        u.aswap(200 + 3600 + 30, "N1", "A", "PA", sol=10e9, creator="CA")
        u.aswap(200 + 3000, "N2", "A", "PA", sol=1e9, creator="CA")
        return u

    def test_n_m_busy_lone_and_cluster(self):
        tape, s, adj = load(self._unit())
        df, summ = R.seat_drift(tape, s, adj)
        d = df.set_index("pool")
        self.assertEqual((d.at["PA", "N_m"], d.at["PB", "N_m"], d.at["PC", "N_m"]), (1, 1, 0))
        self.assertAlmostEqual(d.at["PA", "w1_share"], 10e9 / 100e9)
        self.assertAlmostEqual(d.at["PA", "w2_share"], 1e9 / 100e9)
        # Q9 (AMENDMENT_2): N_m = [0, 1, 1]; cuts c1 = 2/3, c2 = 1; a value equal to a cut goes to the lower bin
        self.assertEqual((summ["busy"], summ["lone"]), (0, 1))
        self.assertEqual((d.at["PC", "tercile"], d.at["PA", "tercile"], d.at["PB", "tercile"]), (0, 1, 1))
        ties = summ["tercile_cuts_and_ties"][DAY]
        self.assertEqual((ties["tied_at_c1"], ties["tied_at_c2"]), (0, 2))
        self.assertAlmostEqual(ties["c2"], 1.0)

    def test_q9_cut_ties_go_to_lower_bin(self):
        ok = pd.DataFrame({"day": [DAY] * 6, "N_m": [0, 1, 2, 3, 4, 5]})       # c1 = 5/3, c2 = 10/3: no tie
        out, ties = R.assign_terciles(ok)
        self.assertEqual(list(out["tercile"]), [0, 0, 1, 1, 2, 2])
        ok = pd.DataFrame({"day": [DAY] * 6, "N_m": [0, 1, 1, 2, 3, 4]})       # c1 = 1.0 exactly, c2 = 7/3
        out, ties = R.assign_terciles(ok)
        self.assertEqual(ties[DAY]["c1"], 1.0)
        self.assertEqual(ties[DAY]["tied_at_c1"], 2)
        self.assertEqual(list(out["tercile"]), [0, 0, 0, 1, 2, 2])             # values on c1 go to the lower bin
        ok2 = pd.DataFrame({"day": [DAY] * 3, "N_m": [1, 1, 1]})
        out2, ties2 = R.assign_terciles(ok2)
        self.assertEqual(list(out2["tercile"]), [0, 0, 0])
        self.assertEqual(ties2[DAY]["tied_at_c1"], 3)

    def test_seat_drift_creator_cluster_not_counted(self):
        tape, s, adj = load(self._unit(link=True))
        df, _ = R.seat_drift(tape, s, adj)
        self.assertEqual(df.set_index("pool").at["PA", "N_m"], 0)   # same creator cluster: not counted


class Amendment1(unittest.TestCase):
    def test_q1_bootstrap_is_pool_clustered_and_stratified_by_day(self):
        g = pd.DataFrame({"day": ["d1"] * 4 + ["d2"] * 4, "pool": ["a", "a", "b", "b", "c", "c", "e", "e"],
                          "v": [0, 0, 0, 0, 10, 10, 10, 10]})
        lb = R.boot_lb_clustered(lambda x: np.mean(x["v"]), [g], ["v"], n=200)
        self.assertEqual(lb, 5.0)          # unstratified draws would move the mean
        g2 = pd.DataFrame({"day": ["d1"] * 4, "pool": ["a", "a", "b", "b"], "v": [0, 4, 0, 0]})
        draws = []
        lb = R.boot_lb_clustered(lambda x: (draws.append(len(x["v"])), 0.0)[1], [g2], ["v"], n=50)
        self.assertEqual(set(draws), {4})  # whole pools come along

    def test_q13_only_clusters_of_2_to_50_are_labelled(self):
        u = Unit()
        chain = [f"c{i}" for i in range(51)]                     # 51 owners linked in a chain, no hub
        for a, b in zip(chain, chain[1:]):
            u.w.append({"slot": 1, "from": a, "to": b})
        u.cbuy(500, "c0", "Z")
        u.cbuy(600, "c50", "Z", buy=False)
        u.w.append({"slot": 1, "from": "A", "to": "B"})
        u.cbuy(500, "A", "Y")
        u.cbuy(700, "B", "Y", buy=False)
        tape, s, _ = load(u)
        labels, summ = R.two_sided_clusters(tape)
        self.assertEqual(set(labels["owner"]), {"A", "B"})
        x = summ["either_rule"]
        self.assertAlmostEqual(x["rows_labelled_share_uncapped"], 1.0)
        self.assertAlmostEqual(x["rows_labelled_share_capped"], 0.5)
        self.assertFalse(s.loc[s["owner"] == "c0", "fake"].any())

    def test_protocol_1_rows_excluded(self):
        u = Unit()
        u.cbuy(10, "A", "M", protocol=1)
        u.cbuy(11, "B", "M")
        tape, s, _ = load(u)
        self.assertEqual(list(s.loc[s["ftb"], "owner"]), ["B"])

    def test_odds_ratio_and_stratum_diff(self):
        x = [1, 1, 1, 0, 0, 0, 1, 0]
        y = [1, 1, 0, 0, 0, 1, 0, 0]
        self.assertAlmostEqual(RB.odds_ratio(x, y), (2 * 3) / (2 * 1))
        self.assertTrue(np.isnan(RB.odds_ratio([1, 1], [1, 1])))
        top = pd.DataFrame({"stratum": ["a", "a", "b"], "net_rebuy_flow": [0.1, 0.3, 0.5]})
        mid = pd.DataFrame({"stratum": ["a", "c"], "net_rebuy_flow": [0.0, 9.0]})
        self.assertAlmostEqual(RB.stratum_diff(top, mid), 0.2)   # stratum b has no mid, c no top


def rebuy_unit(leak=False):
    u = Unit(0, 15000)
    u.create(10, "M")
    u.migrate(100, "M", "P")
    u.cbuy(50, "X", "M", sol=0.5e9, tokens=1e12, post=1e12)                       # cost 0.5 SOL
    u.cbuy(60, "Y", "M", sol=3e9, tokens=1e12, post=1e12)                         # cost 3 SOL
    u.aswap(150, "o", "M", "P")                                                  # mid 1e-3 lamports/token
    u.aswap(2000, "X", "M", "P", sol=2e9, buy=False, tokens=1e12, pre=1e12, post=0)   # gain exit, vwap 2e-3
    r = u.aswap(2100, "Y", "M", "P", sol=2e9, buy=False, tokens=1e12, pre=1e12, post=0)  # loss exit
    u.aswap(3000, "o", "M", "P")
    if leak:
        u.aswap(3750, "z", "M", "P", quote=1e15, sol=1)                           # a price after t1: never read
    u.aswap(3800, "X", "M", "P", sol=1e9)                                        # X rebuys after t1 + 23 slots
    return u


class Rebuy(unittest.TestCase):
    def test_ledger_exits(self):
        L = RB.load_ledger_class()
        u = Unit()
        u.cbuy(10, "A", "M", sol=1e9, tokens=100, post=100)
        u.cbuy(20, "A", "M", sol=3e9, tokens=100, buy=False, pre=100, post=0)
        u.cbuy(30, "B", "M", sol=1e9, tokens=100, post=100)
        r = u.cbuy(40, "B", "M", sol=1e9, tokens=100, buy=False, pre=100, post=0)
        r["signer"] = "router"
        u.t.append({"slot": 45, "tx_idx": 0, "outer_ix": 0, "inner_ix": 0, "mint": "M", "kind": "transfer",
                    "from_owner": "Q", "to_owner": "C", "amount": 100})
        u.cbuy(50, "C", "M", sol=1e9, tokens=100, buy=False, pre=100, post=0)    # unknown cost
        tape, s, _ = load(u)
        ex = RB.ledger_exits(s[s["mint"] == "M"], tape.moves[tape.moves["mint"] == "M"], L).set_index("owner")
        self.assertEqual(ex.at["A", "gain"], 2e9)
        self.assertEqual(ex.at["A", "exit_vwap"], 3e9 / 100)
        self.assertTrue(ex.at["A", "readable"])
        self.assertFalse(ex.at["B", "readable"])
        self.assertTrue(np.isnan(ex.at["C", "gain"]))

    def test_points_pairs_and_flows(self):
        tape, s, _ = load(rebuy_unit())
        ex, pts, prs, summ = RB.rebuy_anchor(tape, s)
        self.assertEqual(len(ex), 2)
        p1 = pts[pts["hour"] == 1].iloc[0]
        self.assertAlmostEqual(p1["mid"], 1e-3)
        self.assertAlmostEqual(p1["RB"], 2e9 / 100e9)          # only the readable gain ex-holder above the mid
        self.assertAlmostEqual(p1["net_rebuy_flow"], 1e9 / 100e9)
        q = prs[prs["hour"] == 1].set_index("owner")
        self.assertTrue(q.at["X", "below"] and q.at["X", "rebuy_2h"])
        self.assertTrue(q.at["Y", "below"] and not q.at["Y", "rebuy_2h"])
        self.assertNotIn("X", set(prs.loc[prs["hour"] == 2, "owner"]))   # X rebought: no longer an ex-holder
        self.assertEqual(summ["proceeds_readable_share"], 1.0)
        self.assertEqual(summ["top_quintile_points_per_day"], {DAY: 0})   # 2 points: no drawdown terciles

    def test_no_price_after_the_decision_point_is_read(self):
        tape, s, _ = load(rebuy_unit())
        _, a, pa, _ = RB.rebuy_anchor(tape, s)
        tape, s, _ = load(rebuy_unit(leak=True))
        _, b, pb, _ = RB.rebuy_anchor(tape, s)
        cols = ["mid", "eff_quote", "RB", "drawdown", "past_return_1h"]
        pd.testing.assert_frame_equal(a[a["hour"] == 1][cols].reset_index(drop=True),
                                      b[b["hour"] == 1][cols].reset_index(drop=True))
        pd.testing.assert_frame_equal(pa[pa["hour"] == 1].reset_index(drop=True),
                                      pb[pb["hour"] == 1].reset_index(drop=True))


class SolUsd(unittest.TestCase):
    def test_kline_minutes_sha_and_range_flag(self):
        import hashlib
        import run_step_a
        d = tempfile.mkdtemp()
        p = os.path.join(d, "SOLUSDT-1m-2026-09-11.csv")
        t0 = 1789084800000                                    # 2026-09-11 00:00 UTC in ms
        with open(p, "w") as fh:
            for i, c in enumerate([150.0, 151.0, 152.0]):
                fh.write(f"{t0 + i * 60000},0,0,0,{c},0,0,0,0,0,0,0\n")
        px, sha, minutes = run_step_a.read_sol_usd([p])
        self.assertEqual(list(minutes.index), [t0 // 1000 + 60 * i for i in range(3)])
        self.assertEqual(px, {"2026-09-11": (151.0, 150.0, 152.0)})
        self.assertEqual(sha[0]["sha256"], hashlib.sha256(open(p, "rb").read()).hexdigest())
        # a day whose minute range reaches $50k / 420 SOL (about 119) is flagged, though the median is far
        self.assertTrue(R._overlap(420 / 1.05, 420 / 0.95, 50_000 / 125.0, 50_000 / 115.0))
        g = R.placebo_grid(day_ranges=[(50_000 / 152.0, 50_000 / 150.0)])
        self.assertTrue(all(not R._overlap(c / 1.1, c / 0.9, 50_000 / 152.0, 50_000 / 150.0) for c in g))


class LookAhead(unittest.TestCase):
    def _unit(self):
        u = Unit(0, 15000)
        u.create(10, "M")
        u.migrate(100, "M", "P")
        u.aswap(150, "o", "M", "P")
        u.aswap(3000, "o2", "M", "P", chain=False)          # no post reading; a deposit follows (not a swap)
        u.aswap(3750, "o3", "M", "P", quote=500e9)         # after t1 = m + 1 h: pre reserves include the deposit
        return u

    def test_rebuy_point_never_uses_next_swap_after_t(self):
        tape, s, _ = load(self._unit())
        _, pts, _, _ = RB.rebuy_anchor(tape, s)
        self.assertNotIn(1, set(pts["hour"]))              # state at t1 unknown: no point, never the later state
        self.assertIn(2, set(pts["hour"]))

    def test_state_asof_uses_next_pre_only_on_or_before_t(self):
        tape, s, _ = load(self._unit())
        g = R.by_pool(s)["P"]
        ps = RB.pool_state(g)
        t3 = T0 + 3750
        i, mid, _ = RB.state_asof(ps, t3, 3750)
        self.assertEqual(i, 2)
        self.assertAlmostEqual(mid[1], (500e9 + 20e9) / 1e14)   # next swap is at t3: allowed
        i, mid, _ = RB.state_asof(ps, t3 - 1, 3749)
        self.assertTrue(np.isnan(mid[1]))

    def test_mcap_segment_without_reading_is_nan(self):
        tape, s, _ = load(self._unit())
        seg = R.mcap_segments(tape, s).reset_index(drop=True)
        self.assertTrue(np.isnan(seg.loc[1, "mcap"]))
        self.assertAlmostEqual(seg.loc[2, "mcap"], (500e9 + 20e9) / 1e14 * SUPPLY / 1e9)

    def test_top_quintile_count_ignores_zero_rb(self):
        class T:
            ranges = [(DAY, 0, 1)]
        n = 15
        pts = pd.DataFrame({"pool": [f"p{i}" for i in range(n)], "day": DAY, "RB": [0.0] * (n - 1) + [0.5],
                            "net_rebuy_flow": 0.0, "drawdown": np.linspace(0, 0.5, n), "past_return_1h": 0.0,
                            "age_h": 1, "depth_sol": 100.0})
        empty = pd.DataFrame(columns=["proceeds", "readable"])
        prs = pd.DataFrame(columns=["pool", "day", "owner", "exit_slot", "t", "proceeds", "gain", "below", "rebuy_2h"])
        summ = RB.summarise(T(), empty, pts, prs)
        self.assertEqual(summ["top_quintile_points_per_day"], {DAY: 1})


def flat_hourly(px, t0=T0 - 7200, t1=T0 + 20000):
    """Minute closes at `px` for every minute in [t0, t1], as read_sol_usd returns them."""
    idx = np.arange(t0 // 60 * 60, t1, 60)
    return H8.hourly_px(pd.Series(px, index=idx))


class H8Stratum(unittest.TestCase):
    def test_hourly_price_is_the_close_known_at_the_hour_start(self):
        h = H8.hourly_px(pd.Series([100.0, 110.0, 120.0], index=[3600 - 120, 3600 - 60, 3600]))
        self.assertEqual(h, {3600: 110.0})
        self.assertEqual(H8.px_asof(h, 3600 + 3599), 110.0)
        self.assertTrue(np.isnan(H8.px_asof(h, 7200)))

    def test_floor_at_each_size(self):
        h = {0: 119.26}
        self.assertTrue(H8.eligible(420e9, 10, 50, h))        # 420 SOL >= $50,000 / 119.26 = 419.25 SOL
        self.assertFalse(H8.eligible(418e9, 10, 50, h))
        self.assertTrue(H8.eligible(126e9, 10, 5, h))         # $15,000 floor = 125.8 SOL at $5 and $5..$15
        self.assertFalse(H8.eligible(125e9, 10, 5, h))
        self.assertFalse(H8.eligible(1e15, 4000, 5, h))       # no price for that hour: not eligible

    def test_dev_zero_stratum(self):
        tape, s, adj = load(dev_unit())
        dz, _ = R.dev_zero(tape, s, adj)
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        out = H8.dev_zero_stratum(dz, [DAY], flat_hourly(200.0), ctx)   # 100 SOL x $200 = $20,000, U2 (65 min)
        self.assertEqual(out["$5"]["le5"]["events_used"], 1)
        self.assertEqual(out["$20"]["le5"]["events_used"], 1)
        self.assertEqual(out["$50"]["le5"]["events_used"], 0)
        self.assertEqual(out["$50"]["le5"]["events_per_day"], {DAY: 0})
        self.assertEqual(out["$5"]["h8_checks"].get("h11_not_covered"), 1)   # pool Q has no candle by m + 5 min

    def test_rebuy_and_seat_drift_strata(self):
        tape, s, _ = load(rebuy_unit())
        ex, pts, prs, _ = RB.rebuy_anchor(tape, s)
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        out = H8.rebuy_stratum(tape, ex, pts, prs, flat_hourly(200.0), ctx)
        self.assertEqual(out["$5"]["decision_points"], len(pts))           # hours 1-2: U2
        self.assertEqual(out["$50"]["decision_points"], 0)
        self.assertEqual(out["$50"]["ex_holder_point_pairs"], 0)
        tape, s, adj = load(SeatDrift()._unit())
        sd, _ = R.seat_drift(tape, s, adj)
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        o = H8.seat_drift_stratum(sd, flat_hourly(200.0), ctx)
        self.assertEqual(o["$5"]["used"], 3)
        self.assertEqual(o["$50"]["used"], 0)

    def test_capacity_row(self):
        tape, s, _ = load(rebuy_unit())
        ph, gr, summ = H8.h8_capacity(tape, s, flat_hourly(200.0))
        x = summ[DAY]
        self.assertEqual(x["pool_hours"], 4)                  # hour starts T0+800 ... T0+11600
        self.assertEqual(x["pool_hours_mayhem_unknown"], 0)
        # H8_AMENDMENT_2: T0+800 is 12 min after migration (H10: not tradable); the other three are U2
        self.assertEqual((x["$5"]["h8_pool_hours"], x["$50"]["h8_pool_hours"]), (3, 0))
        self.assertEqual(x["$5"]["pool_hour_checks"], {"under_60min": 1, "ok": 3})
        self.assertEqual((x["graduates"], x["$20"]["h8_graduates"], x["$50"]["h8_graduates"]), (1, 1, 0))
        u = rebuy_unit()
        u.ev = [e for e in u.ev if e["event"] not in ("CreateEvent", "CreatePoolEvent")]
        u.curve = []                                          # no mayhem flag anywhere on the tape
        tape2, s2, _ = load(u)
        _, _, sm = H8.h8_capacity(tape2, s2, flat_hourly(200.0))
        self.assertEqual((sm[DAY]["pool_hours"], sm[DAY]["pool_hours_mayhem_unknown"]), (0, 4))
        self.assertEqual(sm[DAY]["$5"]["h8_pool_hours_mayhem_unknown"], 0)   # no CreatePoolEvent: dust unknown
        _, _, summ = H8.h8_capacity(tape, s, {})
        self.assertEqual(summ[DAY]["$5"]["h8_pool_hours"], 0)   # no price: nothing is eligible


class H8Amendment2(unittest.TestCase):
    def test_universe_tags_and_floors(self):
        self.assertEqual([H8.universe(a) for a in (3599, 3600, 14400, 14401, 86399, 86400, 14 * 86400, 14 * 86400 + 1)],
                         ["under_60min", "U2", "U2", "4_24h", "4_24h", "U1", "U1", "over_14d"])
        self.assertEqual(H8.floor_usd(5, "U2"), 15_000)
        self.assertEqual(H8.floor_usd(5, "U1"), 50_000)
        self.assertEqual(H8.floor_usd(50, "U1"), 50_000)
        self.assertEqual(H8.floor_usd(100, "U1"), 100_000)
        self.assertIsNone(H8.floor_usd(5, "4_24h"))
        self.assertEqual(H8.SIZES_USD, (5, 20, 50, 100, 200, 500, 1000, 10000))
        self.assertTrue(H8.SIZE_NOTES["$5"].startswith("trial maximum"))
        self.assertTrue(H8.SIZE_NOTES["$20"].startswith("research line"))

    def _ctx(self, u, px=200.0):
        tape, s, _ = load(u)
        return H8.GateCtx(tape, s, flat_hourly(px, T0 - 7200, T0 + 4 * 86400)), tape

    def test_checks_at_a_point(self):
        m = 100
        u = Unit(0, 15000)
        u.create(10, "M"); u.migrate(m, "M", "P")
        u.aswap(150, "o", "M", "P")
        ctx, tape = self._ctx(u)
        t = T0 + m + 3700
        self.assertEqual(ctx.check("P", t, m + 3700, 100e9, 5), "ok")
        self.assertEqual(ctx.check("P", t, m + 3700, 100e9, 50), "below_U2_floor")
        self.assertEqual(ctx.check("P", T0 + m + 5 * 3600, m + 3700, 100e9, 5), "4_24h")
        self.assertEqual(ctx.check("P", T0 + m + 2 * 86400, m + 3700, 249e9, 5), "below_U1_floor")   # $49,800 < $50k
        self.assertEqual(ctx.check("P", T0 + m + 2 * 86400, m + 3700, 251e9, 5), "ok")    # 251 SOL x $200 >= $50k
        self.assertEqual(ctx.check("Q", t, m + 3700, 100e9, 5), "age_unknown")

    def test_dust_h6_spike_and_chase(self):
        m = 100
        def unit():
            u = Unit(0, 15000)
            u.create(10, "M")
            return u
        u = unit(); u.migrate(m, "M", "P", pool_quote=4e9); u.aswap(150, "o", "M", "P")
        ctx, _ = self._ctx(u)
        self.assertEqual(ctx.check("P", T0 + m + 3700, m + 3700, 100e9, 5), "dust_at_migration")
        u = unit(); u.migrate(m, "M", "P"); u.aswap(150, "o", "M", "P")
        u.event("DepositEvent", 300, {"pool": "P", "lp_token_amount_out": "10"})
        ctx, _ = self._ctx(u)
        self.assertEqual(ctx.check("P", T0 + m + 3700, m + 3700, 100e9, 5), "h6_lp_outstanding")
        u.event("WithdrawEvent", 400, {"pool": "P", "lp_token_amount_in": "10"})
        ctx, _ = self._ctx(u)
        self.assertEqual(ctx.check("P", T0 + m + 3700, m + 3700, 100e9, 5), "ok")
        u = unit(); u.migrate(m, "M", "P"); u.aswap(150, "o", "M", "P")
        u.aswap(m + 3650, "big", "M", "P", sol=50e9)            # +50% within one candle, 50 s before the point
        ctx, _ = self._ctx(u)
        self.assertEqual(ctx.check("P", T0 + m + 3700, m + 3700, 100e9, 5), "h11_spike")
        self.assertEqual(ctx.check("P", T0 + m + 3700 + 400, m + 4100, 100e9, 5), "ok")   # out of the 3-min window
        u = unit(); u.migrate(m, "M", "P", pool_base=1e15); u.aswap(150, "o", "M", "P")   # migration price 8.5e-5
        ctx, _ = self._ctx(u)
        self.assertEqual(ctx.check("P", T0 + m + 3700, m + 3700, 100e9, 5), "h11_chase")
        self.assertEqual(ctx.check("P", T0 + m + 2 * 86400, m + 3700, 300e9, 5), "ok")      # U1: no chase check

    def test_creator_fee_zero_pools_counted(self):
        u = rebuy_unit()
        u.aswap(160, "o", "N2", "P2", fee_bps=0)
        tape, s, _ = load(u)
        _, _, summ = H8.h8_capacity(tape, s, flat_hourly(200.0))
        self.assertEqual(summ[DAY]["canonical_pools_creator_fee_0"], 1)


def slicer_unit():
    u = Unit(0, 20000)
    u.create(10, "M"); u.migrate(100, "M", "P")
    u.aswap(150, "o", "M", "P")

    def slices(owner, slots, sols, b_last, **kw):
        rows = []
        for i, (sl, so) in enumerate(zip(slots, sols)):
            r = u.aswap(sl, owner, "M", "P", sol=so, **kw)
            r["signer_sol_pre"] = 100e9 + i * 7e9          # never equal to the previous slice's post balance
            r["signer_sol_post"] = 50e9 + i * 3e9
            rows.append(r)
        rows[-1]["signer_sol_post"] = b_last
        return rows
    slices("X", [1000, 1100, 1300], [0.5e9, 0.4e9, 0.7e9], 5e9)            # the event: B = 5 SOL >= 2.2% of Q
    u.aswap(1400, "X", "M", "P", sol=3e9)                                    # continuation after t + 23 slots
    u.aswap(5000, "X", "M", "P", sol=1e9, buy=False, tokens=5)              # sells all its tokens after the hour: bait
    slices("Y", [1000, 1150, 1450], [0.5e9, 0.4e9, 0.7e9], 0.3e9)           # B under 0.5% of Q: placebo
    rz = slices("Z", [1000, 1120, 1330], [0.5e9, 0.4e9, 0.7e9], 5e9)
    for r in rz:
        r["top_program"] = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"     # routed
    slices("R", [1000, 1100, 1200], [0.5e9, 0.5e9, 0.5e9], 5e9)              # regular cadence
    rv = slices("V", [1000, 1110, 1290], [0.5e9, 0.4e9, 0.7e9], 5e9)
    rv[1]["signer"] = "relay"                                                # signer is not the owner
    u.aswap(500, "S", "M", "P", sol=0.1e9, buy=False)                        # S sold within the prior 24 h
    slices("S", [1000, 1130, 1310], [0.5e9, 0.4e9, 0.7e9], 5e9)
    u.cbuy(11, "F", "M", sol=0.1e9)                                          # F: fast class (2 slots after create)
    u.aswap(1310, "F", "M", "P", sol=1e9)                                    # fast buy in [t, t + 23 slots]
    return u


class Slicer(unittest.TestCase):
    def _run(self, u):
        tape, s, adj = load(u)
        fast = R.w1_fast_class(tape, s)
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        maps, _ = R.cluster_maps(tape)
        return SL.slicer_rows(tape, s, adj, fast, ctx, maps["hub_cap_50"])

    def test_event_definition_and_exclusions(self):
        ev, plc, ctl, summ = self._run(slicer_unit())
        self.assertEqual(list(ev["owner"]), ["X"])
        self.assertEqual(list(plc["owner"]), ["Y"])
        d = summ["drops"]
        for k in ("routed_or_app", "regular_cadence", "signer_not_owner", "sold_in_prior_24h"):
            self.assertEqual(d.get(k), 1, k)
        e = ev.iloc[0]
        self.assertEqual((e["t"], e["slot"], e["B"]), (T0 + 1300, 1300, 5e9))
        self.assertAlmostEqual(e["Q"], 100e9)

    def test_rows(self):
        ev, plc, ctl, summ = self._run(slicer_unit())
        e = ev.iloc[0]
        self.assertEqual(e["cont"], 3e9)                       # X's net buy in (t + 23 slots, t + 60 min]
        self.assertTrue(e["a_hit"])                            # >= 50% of B
        self.assertAlmostEqual(e["fast_ratio"], 0.2)           # F's 1 SOL / B
        self.assertTrue(e["bait"])
        self.assertEqual(summ["a_budget_realisation"]["share"], 1.0)
        self.assertIsNone(summ["b_payer_mass"]["passed"])      # PAYER_MASS bar not computed: never passes
        self.assertTrue(summ["d_low_b_placebo"]["passed"])     # Y's continuation 0 <= half of X's
        self.assertTrue(summ["f_fast_class"]["passed"])
        self.assertFalse(summ["g_bait"]["passed"])
        self.assertEqual(summ["i_count_u1_5usd"]["per_day"], {DAY: 0})   # 20 min after migration: not U1
        self.assertFalse(summ["all_rows_pass"])
        self.assertIn("not every row", summ["next_step"])

    def test_creator_group_and_fast_wallets_are_not_slicers(self):
        u = slicer_unit()
        u.w.append({"slot": 5, "from": "DEV", "to": "X"})      # X is in the creator group
        ev, _, _, summ = self._run(u)
        self.assertEqual(len(ev), 0)
        self.assertEqual(summ["drops"].get("creator_group"), 1)


class SlicerAsOfR2_17(unittest.TestCase):
    def test_fast_class_exclusion_reads_only_buys_up_to_the_event(self):
        """R2-17: the slicer's exclusions read rows at or before the event slot (slicer.py Q14, SWEEP_4 "as of the
        decision slot t"). W1's fast class built from X's whole day used X's own later buys, the very flow row (a)
        measures; X must be classified from its buys of the day up to t."""
        u = slicer_unit()
        for k, sl in enumerate((6000, 6100, 6200, 6300, 6400)):            # after t + 60 min, same day
            u.aswap(sl, f"W{k}", "M", "P", sol=1.5e9)                        # another trader's >= 1 SOL buy
            u.aswap(sl + 1, "X", "M", "P", sol=0.2e9)                        # X buys 1 slot later: "follows"
        tape, s, adj = load(u)
        fast = R.w1_fast_class(tape, s)
        self.assertTrue(bool(fast.get((DAY, "X"), False)))                   # whole-day label: fast
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        maps, _ = R.cluster_maps(tape)
        ev, _, _, summ = SL.slicer_rows(tape, s, adj, fast, ctx, maps["hub_cap_50"])
        self.assertEqual(list(ev["owner"]), ["X"])                            # as of t: slow, still an event
        self.assertIsNone(summ["drops"].get("w1_fast_class"))


class SlicerControl(unittest.TestCase):
    def _ctl(self, link):
        u = Unit(0, 20000)
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(150, "o", "M", "P", sol=0.1e9)
        for sl, w in ((1000, "A"), (1100, "B"), (1200, "C")):
            u.aswap(sl, w, "M", "P", sol=0.5e9)
        u.aswap(1300, "A", "M", "P", sol=0.5e9)
        if link:
            u.w.append({"slot": 1, "from": "A", "to": "B"})
        tape, s, _ = load(u)
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        maps, _ = R.cluster_maps(tape)
        return SL.dispersed_controls(tape, s, ctx, maps["hub_cap_50"])

    def test_three_unlinked_single_buyers(self):
        c = self._ctl(False)
        self.assertEqual(list(c["t"]), [T0 + 1100])              # o, A, B: 1.1 SOL >= 1% of Q
        self.assertEqual(c.iloc[0]["cont"], 0.5e9)               # A's later buy, after t' + 23 slots
        c = self._ctl(True)
        self.assertEqual(list(c["t"]), [T0 + 1200])              # A and B linked: C completes three


def migseat_unit():
    u = Unit(0, 5000)
    u.create(10, "M")
    u.event("CompleteEvent", 50, {"mint": "M"})                       # 40 s after create: gradual
    u.w.append({"slot": 5, "from": "DEV", "to": "L"})
    u.migrate(100, "M", "P")
    for sl, o in ((100, "A"), (101, "B"), (101, "L")):
        r = u.aswap(sl, o, "M", "P", sol=1e9)
        r["jito_tip"], r["tx_fee"] = 1_000_000, 5_000
    u.aswap(102, "DEV", "M", "P", buy=False, tokens=6e13)             # creator sells 6% of supply
    u.aswap(120, "C", "M", "P", sol=3e9)
    u.event("BoostBuyAndBurnEvent", 130, {"mint": "M", "pool": "P", "quote_amount_in_used": "2000000000",
                                          "quote_amount_in_requested": "2000000000"})
    for i in range(3):
        u.f.append({"slot": 100 + i, "block_time": T0 + 100 + i, "signature": f"f{i}", "venue": "pumpswap",
                    "pool_or_curve": "P", "err_class": "slippage"})
    return u


class MigSeat(unittest.TestCase):
    def test_w_group_two_hops(self):
        u = Unit()
        u.w += [{"slot": 1, "from": "DEV", "to": "a"}, {"slot": 2, "from": "a", "to": "b"},
                {"slot": 3, "from": "b", "to": "c"}, {"slot": 50, "from": "DEV", "to": "late"}]
        tape, _, _ = load(u)
        self.assertEqual(MS.w_group(tape, {"DEV"}, 10), {"DEV", "a", "b"})

    def test_rows(self):
        tape, s, _ = load(migseat_unit())
        ctx = H8.GateCtx(tape, s, flat_hourly(200.0))
        df, out = MS.mig_seat(tape, s, ctx)
        self.assertEqual(out["by_speed"], {"gradual": 1})
        g = out["gradual"]
        self.assertEqual((g["G1"]["share_with_seat_buy"], g["G1"]["median_distinct_buyers"]), (1.0, 2.0))  # L linked
        self.assertTrue(g["G1"]["passed"])
        self.assertEqual(g["G2"]["median_toll_lamports"], 1_005_000)
        self.assertEqual(g["G3"]["median_racers"], 3)
        self.assertFalse(g["G4"]["passed"])                           # 6% of supply sold before s0 + 2 + 60 s
        r = df.iloc[0]
        self.assertEqual(r["payer_sol"], 5e9)                         # C's 3 SOL + BOOST's 2 SOL
        self.assertAlmostEqual(r["payer_over_xstar"], 5e9 / (100e9 * (np.sqrt(1.035) - 1)))
        self.assertTrue(g["G5"]["passed"])
        self.assertEqual(g["G6"]["median_boost_used_over_requested"], 1.0)
        self.assertFalse(g["G7"]["passed"])
        self.assertAlmostEqual(g["kill"]["share_first_minute_in_s0_s0p1"], 2 / 5)
        self.assertFalse(g["kill"]["closes"])
        self.assertIsNone(out["G8_regime"]["passed"])                 # not checkable: no PREREG
        self.assertFalse(out["prereg_gradual"])


def mayhem_unit():
    u = Unit(0, 5000)
    u.create(10, "MM")
    def rep(slot, old, new, real=10e9, sig=None):
        u.event("UpdateMayhemVirtualParamsEvent", slot, {
            "mint": "MM", "virtual_sol_reserves": str(int(old[0])), "virtual_token_reserves": str(int(old[1])),
            "new_virtual_sol_reserves": str(int(new[0])), "new_virtual_token_reserves": str(int(new[1])),
            "real_sol_reserves": str(int(real)), "real_token_reserves": "1"}, sig=sig)
    rep(1000, (100e9, 1e15), (90e9, 1e15), sig="rp1")                # j = -10%
    rep(1050, (90e9, 1e15), (97.2e9, 1e15))                          # +8% >= 5%: the bounce
    rep(2000, (100e9, 1e15), (90e9, 1e15))                           # -10%, no bounce
    r = u.cbuy(1000, "agent", "MM")
    r["signature"], r["top_program"] = "rp1", MS.MAYHEM_PROGRAM       # this re-price sits in a mayhem-program tx
    return u


class MayhemSnap(unittest.TestCase):
    def test_rows(self):
        tape, s, _ = load(mayhem_unit())
        dn, out = MS.mayhem_snap(tape, s, flat_hourly(200.0))
        self.assertEqual(out["reprice_rows"], 3)
        self.assertAlmostEqual(out["a"]["share_attributed"], 1 / 3)
        self.assertFalse(out["a"]["passed"])
        self.assertEqual(out["b"]["down_steps"], 2)
        self.assertEqual(out["b"]["share_followed_by_up"], 0.5)
        self.assertFalse(out["b"]["passed"])
        self.assertEqual(out["c"]["median_seconds_to_up_step"], 50)
        self.assertEqual((out["d"]["share"], out["d"]["passed"]), (1.0, True))   # 10 SOL >= 2 x $100 / $200
        self.assertEqual(out["e"]["per_day"], {DAY: 2})
        self.assertEqual(out["rule"]["share_vtoken_unchanged"], 1.0)
        self.assertFalse(out["prereg_may_be_written"])

    def test_prereg_may_be_written_when_a_to_e_pass(self):
        # COUNT_ROWS_AMENDMENT_6: the PREREG may be written once rows (a)-(e) pass; the owner rules before bot use
        u = Unit(0, 30000)
        u.create(10, "MM")
        for i in range(100):
            for k, (old, new) in enumerate((((100e9, 1e15), (90e9, 1e15)), ((90e9, 1e15), (97.2e9, 1e15)))):
                slot = 100 + 200 * i + 30 * k
                u.event("UpdateMayhemVirtualParamsEvent", slot, {
                    "mint": "MM", "virtual_sol_reserves": str(int(old[0])), "virtual_token_reserves": str(int(old[1])),
                    "new_virtual_sol_reserves": str(int(new[0])), "new_virtual_token_reserves": str(int(new[1])),
                    "real_sol_reserves": "10000000000", "real_token_reserves": "1"}, sig=f"r{i}_{k}")
                r = u.cbuy(slot, "agent", "MM")
                r["signature"], r["top_program"] = f"r{i}_{k}", MS.MAYHEM_PROGRAM
        tape, s, _ = load(u)
        _, out = MS.mayhem_snap(tape, s, flat_hourly(200.0, T0 - 7200, T0 + 40000))
        self.assertEqual(out["e"]["per_day"], {DAY: 100})
        self.assertTrue(out["prereg_may_be_written"])
        self.assertIn("owner", out["before_any_bot_use"])


class RunnerNewRows(unittest.TestCase):
    def test_run_reports_amendments_4_to_6(self):
        import run_step_a as RS
        d = tempfile.mkdtemp()
        out = os.path.join(d, "o")
        summ = RS.run([migseat_unit().write(d)], out, n_boot=50)
        for k in ("8_slicer_ride", "9_mig_seat", "10_mayhem_snap"):
            self.assertIn(k, summ)
        self.assertIn("G8_regime", summ["9_mig_seat"])
        for f in ("slicer_events", "mig_seat", "mayhem_snap_down_steps"):
            self.assertTrue(os.path.exists(os.path.join(out, f"stepa_{f}.csv")))


class SolUsdDir(unittest.TestCase):
    def _folder(self):
        import hashlib
        import zipfile
        d = tempfile.mkdtemp()
        name = f"SOLUSDT-1m-{DAY}.zip"
        t0 = 1789084800000000                                 # microseconds, as the archive writes them
        with zipfile.ZipFile(os.path.join(d, name), "w") as z:
            z.writestr(f"SOLUSDT-1m-{DAY}.csv", "".join(f"{t0 + i * 60_000_000},0,0,0,{150 + i},0,0,0,0,0,0,0\n"
                                                         for i in range(3)))
        sha = hashlib.sha256(open(os.path.join(d, name), "rb").read()).hexdigest()
        with open(os.path.join(d, "SHA256SUMS"), "w") as fh:
            fh.write(f"{sha}  {name}\n")
        return d, name

    @staticmethod
    def sums_sha(d):
        import hashlib
        return hashlib.sha256(open(os.path.join(d, "SHA256SUMS"), "rb").read()).hexdigest()

    def test_checked_load_and_refusals(self):
        import run_step_a as RS
        d, name = self._folder()
        pin = self.sums_sha(d)
        px, sha, minutes = RS.load_sol_usd_dir([DAY], d, pin)
        self.assertEqual(px[DAY], (151.0, 150.0, 152.0))
        self.assertEqual(len(minutes), 3)
        with self.assertRaises(RS.SolUsdError):
            RS.load_sol_usd_dir([DAY, "2026-09-12"], d, pin)  # missing day
        with open(os.path.join(d, name), "ab") as fh:
            fh.write(b"x")                                     # tampered file
        with self.assertRaises(RS.SolUsdError):
            RS.load_sol_usd_dir([DAY], d, pin)

    def test_sums_file_is_pinned(self):
        import hashlib
        import run_step_a as RS
        d, name = self._folder()
        with self.assertRaises(RS.SolUsdError):                 # default pin: this SHA256SUMS is not the committed one
            RS.load_sol_usd_dir([DAY], d)
        # edit a zip and its SHA256SUMS line together: the pinned hash of SHA256SUMS no longer matches
        pin = self.sums_sha(d)
        with open(os.path.join(d, name), "ab") as fh:
            fh.write(b"x")
        new = hashlib.sha256(open(os.path.join(d, name), "rb").read()).hexdigest()
        with open(os.path.join(d, "SHA256SUMS"), "w") as fh:
            fh.write(f"{new}  {name}\n")
        with self.assertRaises(RS.SolUsdError):
            RS.load_sol_usd_dir([DAY], d, pin)

    def test_cli_defaults_to_committed_folder_and_refuses_missing_day(self):
        import run_step_a as RS
        self.assertTrue(RS.DEFAULT_SOL_USD_DIR.endswith(os.path.join("brainstorm-loop", "sol-usd")))
        d = tempfile.mkdtemp()
        u = Unit().write(d, "2026-09-12")
        with self.assertRaises(SystemExit):
            RS.main(["--unit", u, "--out", os.path.join(d, "o")])
        self.assertFalse(os.path.exists(os.path.join(d, "o")))

    def test_committed_files_pass_for_step_a_days(self):
        import run_step_a as RS
        if not os.path.isdir(RS.DEFAULT_SOL_USD_DIR):
            self.skipTest("committed SOL/USD folder not present")
        px, sha, _ = RS.load_sol_usd_dir(["2026-09-10", "2026-09-11"])
        self.assertEqual(len(sha), 3)                              # 09-09 too, for 09-10's 00:00 hour


class Mayhem(unittest.TestCase):
    def test_order_create_then_curve_then_pool_create(self):
        u = Unit()
        u.event("CreatePoolEvent", 5, {"pool": "P", "base_mint": "M", "quote_mint": WSOL, "is_mayhem_mode": "0",
                                       "coin_creator": "DEV", "creator": "x"})
        r = u.cbuy(10, "A", "M")
        r["mayhem_mode"] = 1                                   # the mint's curve trade says mayhem
        u.aswap(20, "B", "M", "P")
        tape, s, _ = load(u)
        self.assertEqual(tape.mayhem_of_mint("M"), 1)          # curve trade wins over CreatePoolEvent
        u.event("CreateEvent", 1, {"mint": "M", "creator": "DEV", "user": "DEV", "is_mayhem_mode": "0",
                                   "quote_mint": SOL_NATIVE, "name": "M", "symbol": "M"})
        tape, _, _ = load(u)
        self.assertEqual(tape.mayhem_of_mint("M"), 0)          # CreateEvent first

    def test_pool_hours_take_the_mint_flag(self):
        u = rebuy_unit()
        u.ev = [e for e in u.ev if e["event"] != "CreateEvent"]
        for r in u.curve:
            r["mayhem_mode"] = 1                               # curve says mayhem; CreatePoolEvent says 0
        tape, s, _ = load(u)
        _, _, sm = H8.h8_capacity(tape, s, flat_hourly(200.0))
        self.assertEqual((sm[DAY]["pool_hours"], sm[DAY]["pool_hours_mayhem_unknown"]), (0, 0))

    def test_2b_supply_does_not_infer_mayhem(self):
        u = Unit()
        u.aswap(20, "B", "M", "P")
        u.amm[-1]["base_supply"] = 2e15                        # 2B tokens: not evidence of mayhem
        tape, _, _ = load(u)
        self.assertIsNone(tape.mayhem_of_mint("M"))


class ReReview(unittest.TestCase):
    def test_pool_hour_state_before_a_tape_gap_is_skipped(self):
        d = tempfile.mkdtemp()
        a = Unit(0, 999)
        a.create(10, "M"); a.migrate(100, "M", "P")
        a.aswap(500, "o", "M", "P")
        b = Unit(5000, 9999)
        tape = Tape([a.write(d), b.write(d)])
        labels, _ = R.two_sided_clusters(tape)
        s = R.prepare(tape, labels)
        _, _, sm = H8.h8_capacity(tape, s, flat_hourly(200.0))
        x = sm[DAY]
        self.assertEqual(x["pool_hours"], 1)                    # T0+800 only; T0+8000's last state is before the gap
        self.assertEqual(x["pool_hours_state_not_on_tape"], 1)

    def test_previous_day_file_loaded_for_midnight(self):
        import hashlib
        import zipfile
        import run_step_a as RS
        d = tempfile.mkdtemp()
        sums = []
        for day, t0 in (("2026-09-10", 1788998400), (DAY, 1789084800)):
            name = f"SOLUSDT-1m-{day}.zip"
            with zipfile.ZipFile(os.path.join(d, name), "w") as z:
                z.writestr(name.replace(".zip", ".csv"), "".join(
                    f"{(t0 + 60 * i) * 1000},0,0,0,{100 + i},0,0,0,0,0,0,0\n" for i in range(1440)))
            sums.append(f"{hashlib.sha256(open(os.path.join(d, name), 'rb').read()).hexdigest()}  {name}")
        with open(os.path.join(d, "SHA256SUMS"), "w") as fh:
            fh.write("\n".join(sums) + "\n")
        pin = hashlib.sha256(open(os.path.join(d, "SHA256SUMS"), "rb").read()).hexdigest()
        _, sha, minutes = RS.load_sol_usd_dir([DAY], d, pin)
        self.assertEqual(len(sha), 2)
        self.assertEqual(H8.px_asof(H8.hourly_px(minutes), 1789084800 + 5), 100 + 1439)   # 09-10 23:59 close
        with open(os.path.join(d, "SOLUSDT-1m-2026-09-10.zip"), "ab") as fh:
            fh.write(b"x")
        with self.assertRaises(RS.SolUsdError):                  # a listed previous day is checked too
            RS.load_sol_usd_dir([DAY], d, pin)

    def test_rows_without_price_are_reported(self):
        tape, s, adj = load(dev_unit())
        dz, _ = R.dev_zero(tape, s, adj)
        out = H8.dev_zero_stratum(dz, [DAY], {})
        self.assertEqual(out["rows_without_sol_usd"], 2)       # event and control, no price for their hour
        tape, s, _ = load(rebuy_unit())
        ex, pts, prs, _ = RB.rebuy_anchor(tape, s)
        self.assertEqual(H8.rebuy_stratum(tape, ex, pts, prs, {})["rows_without_sol_usd"], len(pts))


class ReviewFixes(unittest.TestCase):
    def test_dev_zero_counts_zero_for_loaded_day_without_events(self):
        d = tempfile.mkdtemp()
        tape = Tape([dev_unit().write(d), Unit(20000, 20999).write(d, "2026-09-10")])
        adj = R.adjacency(tape.links)
        labels, _ = R.two_sided_clusters(tape)
        s = R.prepare(tape, labels)
        _, summ = R.dev_zero(tape, s, adj)
        self.assertEqual(summ["le5"]["events_per_day"], {DAY: 1, "2026-09-10": 0})
        self.assertEqual(summ["zero"]["events_per_day"], {DAY: 0, "2026-09-10": 0})

    def test_missing_price_gives_none(self):
        d = tempfile.mkdtemp()
        tape = Tape([Unit().write(d), Unit(20000, 20999).write(d, "2026-09-10")])
        _, summ = R.round_usd(tape, tape.swaps, {DAY: 119.26}, {}, n_boot=0)
        self.assertIsNone(summ["a_not_separable_from_usd_level"])

    def test_gate3_ignores_creator_swaps_before_window(self):
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        u.aswap(150, "o0", "M", "P", quote=22e9)                        # market cap 420 SOL
        u.aswap(200, "DEV", "M", "P", sol=5e9, quote=22e9)               # creator buy before m + 5 min
        u.aswap(1000, "o1", "M", "P", quote=22e9)
        tape, s, adj = load(u)
        seg = R.mcap_segments(tape, s)
        df = R.gate3_split(tape, s, seg, adj, return_rows=True)
        self.assertEqual(df.iloc[0]["measure_main"], 0.0)


class Plan(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.plan = os.path.join(self.d, "plan.txt")
        with open(self.plan, "w") as fh:
            fh.write("2026-09-11 1 0 99\n2026-09-11 1 100 199\n2026-09-11 1 200 299\n"
                     "2026-09-10 1 1000 1099\n2026-09-08 1 5 6\n")
        self.full = [("2026-09-11", 0, 99), ("2026-09-11", 100, 199), ("2026-09-11", 200, 299),
                     ("2026-09-10", 1000, 1099)]

    def test_exact_plan_passes_and_returns_sha(self):
        import hashlib
        from tapeio import check_plan
        self.assertEqual(check_plan(self.full, self.plan), hashlib.sha256(open(self.plan, "rb").read()).hexdigest())

    def test_missing_middle_and_subset_refused(self):
        from tapeio import PlanError, check_plan
        with self.assertRaises(PlanError):
            check_plan([r for r in self.full if r[1] != 100], self.plan)
        with self.assertRaises(PlanError):
            check_plan(self.full[:3], self.plan)                         # a correct subset is not enough
        with self.assertRaises(PlanError):
            check_plan(self.full + [("2026-09-12", 1, 2)], self.plan)

    def test_noncontiguous_plan_refused(self):
        from tapeio import PlanError, check_plan
        with open(self.plan, "w") as fh:
            fh.write("2026-09-11 1 0 99\n2026-09-11 1 150 199\n2026-09-10 1 1000 1099\n")
        with self.assertRaises(PlanError):
            check_plan([("2026-09-11", 0, 99), ("2026-09-11", 150, 199), ("2026-09-10", 1000, 1099)], self.plan)

    def test_cli_decide_refused_on_incomplete_units(self):
        import run_step_a
        u = Unit().write(self.d)
        with self.assertRaises(SystemExit):
            run_step_a.main(["--unit", u, "--out", os.path.join(self.d, "o"), "--decide", "--plan", self.plan])
        self.assertFalse(os.path.exists(os.path.join(self.d, "o")))


class RoundUsd(unittest.TestCase):
    def test_flag_and_bunching_runs(self):
        u = Unit()
        u.create(10, "M"); u.migrate(100, "M", "P")
        # market cap = (quote+virtual)/base * supply / 1e9: 100e9/1e14*1e15/1e9 = 1,000 SOL
        for k in range(20):
            u.aswap(500 + 300 * k, f"o{k}", "M", "P", quote=80e9 + k * 1e9)
        tape, s, adj = load(u)
        seg = R.mcap_segments(tape, s)
        self.assertAlmostEqual(seg["mcap"].iloc[0], 1000.0)
        self.assertGreaterEqual(seg["t0"].min(), T0 + 100 + 300)       # BOOST-less: first 5 min excluded
        df, summ = R.round_usd(tape, s, {DAY: 119.26}, adj, n_boot=20)
        self.assertTrue(summ["a_within_5pct_of_round_usd"][DAY])       # 420 SOL is about $50,089
        self.assertTrue(summ["a_not_separable_from_usd_level"])
        self.assertEqual(set(df["usd_level"]), {50_000.0, 100_000.0})
        _, summ = R.round_usd(tape, s, {DAY: 150.0}, adj, n_boot=0)
        self.assertFalse(summ["a_within_5pct_of_round_usd"][DAY])
        _, summ = R.round_usd(tape, s, None, adj)
        self.assertIn("needs SOL/USD", summ["status"])



class RedTeamR1(unittest.TestCase):
    """research/brainstorm-loop/CODE_REDTEAM.md, R1 findings on the count rows."""

    def test_theme_wave_needs_a_real_name_or_symbol_match(self):
        # R1-3: symbols that normalise to "" (emoji) matched each other, and matched any coin with no CreateEvent
        u = Unit()
        for mint, pool, m, nm, sym in (("A", "PA", 200, "Frog", "\U0001F438"), ("B", "PB", 250, "Dog", "\U0001F436")):
            u.event("CreateEvent", m - 100, {"mint": mint, "creator": "C" + mint, "user": "C" + mint,
                                             "is_mayhem_mode": "0", "quote_mint": SOL_NATIVE, "name": nm, "symbol": sym})
            u.migrate(m, mint, pool, creator="C" + mint)
            u.aswap(m + 1, "seed" + mint, mint, pool, creator="C" + mint)
        u.migrate(260, "Z", "PZ", creator="CZ")              # graduate whose CreateEvent is not on the tape
        u.aswap(261, "seedZ", "Z", "PZ", creator="CZ")
        u.aswap(262, "x", "Z", "PZ", creator="CZ", buy=False)  # a curve-less mint: mayhem from CreatePoolEvent
        tape, s, adj = load(u)
        df, _ = R.seat_drift(tape, s, adj)
        d = df.set_index("pool")
        self.assertEqual(d.at["PA", "dropped"], "")
        self.assertEqual(d.at["PB", "dropped"], "")
        u2 = Unit()                                          # a real symbol match still drops
        for mint, pool, m in (("A", "PA", 200), ("B", "PB", 250)):
            u2.event("CreateEvent", m - 100, {"mint": mint, "creator": "C" + mint, "user": "C" + mint,
                                              "is_mayhem_mode": "0", "quote_mint": SOL_NATIVE, "name": "n" + mint,
                                              "symbol": "PEPE"})
            u2.migrate(m, mint, pool, creator="C" + mint)
            u2.aswap(m + 1, "seed" + mint, mint, pool, creator="C" + mint)
        tape, s, adj = load(u2)
        df, _ = R.seat_drift(tape, s, adj)
        self.assertEqual(set(df["dropped"]), {"theme_wave_name_match"})

    def test_dev_zero_arms_are_tested_in_the_frozen_order(self):
        # R1-6: "then, in a fixed order": an arm earns only if every earlier arm earned (fixed-sequence)
        good = {"median_net_excess": 0.05, "lb95": 0.01, "late_share_of_ftb": 0.6, "events_per_day": {DAY: 12}}
        bad = {**good, "lb95": -0.01}
        out = R.dev_zero_decide({"le5": bad, "zero": good, "le3": good})
        self.assertEqual(out, {"le5": False, "zero": False, "le3": False})
        out = R.dev_zero_decide({"le5": good, "zero": bad, "le3": good})
        self.assertEqual(out, {"le5": True, "zero": False, "le3": False})

    def test_events_a_day_count_only_events_with_a_net_value(self):
        # R1-7: an event whose net is undefined (no effective quote) is not an eligible event
        df = pd.DataFrame({"arm": ["le5"] * 3, "kind": ["event", "event", "control"], "pool": ["P1", "P2", "P3"],
                           "day": [DAY] * 3, "dropped": [""] * 3, "net": [0.05, np.nan, 0.0],
                           "ftb_sol_all": [1.0, 1.0, 0.0], "ftb_sol_late": [1.0, 1.0, 0.0]})
        x = R.dev_summary(df, [DAY])["le5"]
        self.assertEqual(x["events_used"], 1)
        self.assertEqual(x["events_per_day"], {DAY: 1})

    def _decide_plan(self):
        d = tempfile.mkdtemp()
        u = Unit().write(d)
        plan = os.path.join(d, "plan.txt")
        with open(plan, "w") as fh:
            fh.write(f"{DAY} 1 0 9999\n")
        return d, u, plan

    def test_decide_uses_the_registered_resample_count(self):
        # R1-4: --decide with another --boot re-draws the bounds (A1 Q1 fixes 10,000 resamples)
        import run_step_a
        d, u, plan = self._decide_plan()
        with self.assertRaises(SystemExit):
            run_step_a.main(["--unit", u, "--out", os.path.join(d, "o"), "--decide", "--plan", plan, "--boot", "50"])
        self.assertFalse(os.path.exists(os.path.join(d, "o")))

    def test_no_prereg_is_earned_without_the_payer_mass_bar(self):
        # R1-5: PAYER_MASS.md adds a necessary bar to DEV-ZERO, REBUY-ANCHOR and SEAT-DRIFT; until it is computed
        # no row may report a PREREG earned, even when its own thresholds pass
        import run_step_a
        from unittest import mock
        d, u, plan = self._decide_plan()
        with mock.patch.object(R, "dev_zero_decide", lambda s: {"le5": True, "zero": True, "le3": True}), \
                mock.patch.object(R, "seat_drift_decide", lambda s: True), \
                mock.patch.object(RB, "rebuy_decide", lambda s: True):
            summ = run_step_a.run([u], os.path.join(d, "o"), None, n_boot=20, decide=True, plan={"path": plan})
        dec = summ["decision"]
        self.assertFalse(any(dec["1_dev_zero_prereg_by_arm"].values()))
        self.assertFalse(dec["2_rebuy_anchor_prereg"])
        self.assertFalse(dec["3_seat_drift_prereg"])
        self.assertTrue(all(dec["own_thresholds"]["1_dev_zero_by_arm"].values()))
        self.assertTrue(all(v["passed"] is not True for v in dec["payer_mass_bar"].values()))   # R1-16: per row


    def test_round_usd_bound_counts_undefined_draws_against_it(self):
        # R1-10: Q1 counts an undefined bootstrap draw as minus infinity; row 6 dropped such draws (nanquantile)
        from types import SimpleNamespace
        from unittest import mock
        grid = R.placebo_grid(day_ranges=[(u / 125.0, u / 125.0) for u in R.USD_LEVELS])
        rows = [("P1", 410.0), ("P1", 390.0), ("P2", 410.0)]
        rows += [("P1", c * f) for c in grid for f in (1.01, 0.99)]
        seg = pd.DataFrame([{"pool": p, "mint": p, "day": DAY, "t0": 100 * i, "t1": 100 * i + 100, "mcap": m,
                             "w_start": 0, "w_end": 10 ** 6} for i, (p, m) in enumerate(rows)])
        tape = SimpleNamespace(ranges=[(DAY, 0, 1)])
        with mock.patch.object(R, "mcap_segments", lambda t, s: seg), \
                mock.patch.object(R, "gate3_split", lambda *a: {}):
            df, _ = R.round_usd(tape, None, {DAY: 125.0}, None, n_boot=400)
        r = df.set_index("usd_level").loc[50_000.0]
        self.assertAlmostEqual(r["bunching_logratio_minus_placebo"], np.log(2))
        self.assertIsNone(r["lb95"])            # a quarter of the draws hold only P2: undefined


class PayerMass(unittest.TestCase):
    """COUNT_ROWS_AMENDMENT_7 Q-R1-a: the payer-mass bar (CODE_REDTEAM.md R1-16, R1-17)."""

    def test_round_trip_cost_tier_and_x_star(self):
        import payer as PM
        x = 41_925_205                                  # $5 at $119.26: floor(5 / 119.26 * 1e9)
        self.assertEqual(PM.SPEND_5USD, x)
        Q = 85e9                                        # 85 SOL of effective quote; supply = base: cap = Q
        c = PM.round_trip_cost(Q, Q, 1e15, 1e15)        # 85 SOL cap: the 125 bps tier
        want = 2 * 0.0125 + (x * x / (Q + x) + x * x / Q) / x + 414_009 / x
        self.assertAlmostEqual(c, want, places=12)
        self.assertAlmostEqual(PM.x_star(Q, c), Q * (np.sqrt(1 + c) - 1))
        # the tier the program applies: cap >= 420 SOL is the 120 bps tier, just under it the 125 bps one
        at, under = PM.round_trip_cost(Q, 420e9, 1e15, 1e15), PM.round_trip_cost(Q, 419.999e9, 1e15, 1e15)
        self.assertAlmostEqual(under - at, 2 * 0.0005, places=12)
        self.assertTrue(np.isnan(PM.round_trip_cost(np.nan, Q, 1e15, 1e15)))

    def test_bar_ties_pass_at_exactly_1_and_exactly_11_a_day(self):
        import payer as PM
        days = ["d1", "d2"]
        ev_days = ["d1"] * 23 + ["d2"] * 22
        xs = np.ones(45)
        flows = np.r_[np.full(23, 1.0), np.full(22, 2.0)]   # median ratio exactly 1; 22 events at exactly 2 X*
        r = PM.bar(flows, xs, ev_days, days)
        self.assertEqual((r["median_ratio"], r["events_at_2x_per_day"]), (1.0, 11.0))
        self.assertTrue(r["passed"])
        r = PM.bar(np.r_[flows[:-1], 1.999], xs, ev_days, days)   # 21 at 2 X*: 10.5 a day
        self.assertEqual(r["events_at_2x_per_day"], 10.5)
        self.assertFalse(r["passed"])
        low = np.r_[np.full(23, 0.999), np.full(22, 2.0)]          # median just under 1
        self.assertFalse(PM.bar(low, xs, ev_days, days)["passed"])
        # a day with no events counts in the average; an undefined flow or X* never helps
        self.assertTrue(PM.bar(np.full(22, 3.0), np.ones(22), ["d1"] * 22, days)["passed"])
        r = PM.bar(np.r_[np.full(21, 3.0), np.nan], np.ones(22), ["d1"] * 22, days)
        self.assertFalse(r["passed"])
        r = PM.bar(np.full(22, 3.0), np.r_[np.ones(21), np.nan], ["d1"] * 22, days)
        self.assertFalse(r["passed"])
        self.assertIsNone(PM.bar([], [], [], ["d1"])["passed"])

    def _seat_unit(self, late_swap=False):
        u = Unit()
        # N_m: A 1, B 2, C 1 (A and C are 130 s apart), D, E, F 0 -> cuts 0 and 1: B busy, D, E, F lone
        mints = [("A", "PA", 200, "CA"), ("B", "PB", 250, "CB"), ("C", "PC", 330, "CC"), ("D", "PD", 1000, "CD"),
                 ("E", "PE", 2000, "CE"), ("F", "PF", 2500, "CF")]
        for mint, pool, m, c in mints:
            u.create(m - 100, mint, creator=c, name="n" + mint)
            u.migrate(m, mint, pool, creator=c)
            # lone pools are twice as deep (Q = 200 SOL): AMENDMENT_8 compares shares of each event's own Q
            u.aswap(m + 1, "seed" + mint, mint, pool, creator=c, quote=180e9 if mint in "DEF" else 80e9)
        # PB is busy: a 10 SOL first-time buy in its w1 window; the lone ones buy 1 SOL
        u.aswap(250 + 3600 + 30, "N1", "B", "PB", sol=10e9, creator="CB")
        for mint, pool, m, c in mints[3:]:
            u.aswap(m + 3600 + 30, "L" + mint, mint, pool, sol=1e9, creator=c)
        if late_swap:                                   # after m + 60 min: must not change Q or the tier
            u.aswap(250 + 3600 + 5, "late", "B", "PB", sol=1, creator="CB", quote=400e9, virtual=0)
        return u

    def test_seat_drift_bar_uses_the_busy_excess_and_the_as_of_quote(self):
        import payer as PM
        tape, s, adj = load(self._seat_unit())
        df, _ = R.seat_drift(tape, s, adj)
        r = PM.seat_drift_bar(df, sorted({d for d, _, _ in tape.ranges}))
        ev = r["events"]
        self.assertEqual(list(ev["pool"]), ["PB"])
        a = ev.set_index("pool").loc["PB"]
        # AMENDMENT_8 (R1-20): excess in shares of each graduate's own Q: 10/100 - median lone 1/200
        self.assertAlmostEqual(a["excess_share"], 10e9 / 100e9 - 1e9 / 200e9)
        self.assertEqual(a["Q"], 100e9)                 # eff quote of the last swap at or before m + 60 min
        self.assertAlmostEqual(a["s_star"], np.sqrt(1 + a["c"]) - 1)
        self.assertAlmostEqual(r["median_ratio"], a["excess_share"] / a["s_star"])
        tape2, s2, adj2 = load(self._seat_unit(late_swap=True))
        df2, _ = R.seat_drift(tape2, s2, adj2)
        a2 = PM.seat_drift_bar(df2, sorted({d for d, _, _ in tape2.ranges}))["events"].set_index("pool").loc["PB"]
        self.assertEqual((a2["Q"], a2["s_star"]), (a["Q"], a["s_star"]))

    def test_decision_earns_only_with_the_bar(self):
        import run_step_a
        from unittest import mock
        own = {"le5": True, "zero": True, "le3": True}
        with mock.patch.object(R, "dev_zero_decide", lambda s: own), \
                mock.patch.object(R, "seat_drift_decide", lambda s: True), \
                mock.patch.object(RB, "rebuy_decide", lambda s: True):
            yes = run_step_a.decision({}, {}, {}, {"3_seat_drift": {"passed": True}})
            no = run_step_a.decision({}, {}, {}, {"3_seat_drift": {"passed": False}})
        self.assertTrue(yes["3_seat_drift_prereg"])
        self.assertFalse(no["3_seat_drift_prereg"])
        for d in (yes, no):                              # not computed for these rows: never earned
            self.assertFalse(d["2_rebuy_anchor_prereg"])
            self.assertFalse(any(d["1_dev_zero_prereg_by_arm"].values()))


class PayerMassAmendment8(unittest.TestCase):
    """COUNT_ROWS_AMENDMENT_8: the bar for DEV-ZERO, REBUY-ANCHOR (CODE_REDTEAM.md R1-21, R1-22)."""

    def test_dev_zero_bar_matched_controls_same_day_and_q_tercile(self):
        import payer as PM
        D2 = "2026-09-10"
        rows = []
        # one arm, day DAY: Q values 100, 200, 300 SOL for both events and controls -> terciles split them apart
        for k, q in enumerate((100e9, 200e9, 300e9)):
            rows.append({"arm": "le5", "kind": "event", "pool": f"E{k}", "day": DAY, "dropped": "", "net": 0.20,
                         "eff_quote": q, "base": 1e15, "supply": 1e15})
            rows.append({"arm": "le5", "kind": "control", "pool": f"C{k}", "day": DAY, "dropped": "",
                         "net": 0.01 * (k + 1), "eff_quote": q, "base": 1e15, "supply": 1e15})
        # an event on another day with no control that day: left out of the bar and counted
        rows.append({"arm": "le5", "kind": "event", "pool": "E9", "day": D2, "dropped": "", "net": 0.5,
                     "eff_quote": 100e9, "base": 1e15, "supply": 1e15})
        r = PM.dev_zero_bar(pd.DataFrame(rows), [DAY, D2])["le5"]
        ev = r["events"].set_index("pool")
        for k in range(3):
            self.assertAlmostEqual(ev.at[f"E{k}", "excess_share"], 0.20 - 0.01 * (k + 1))   # its own tercile's control
        self.assertNotIn("E9", ev.index)
        self.assertEqual(r["events_without_matched_control"], 1)
        c = PM.round_trip_cost(100e9, 100e9, 1e15, 1e15)
        self.assertAlmostEqual(ev.at["E0", "s_star"], np.sqrt(1 + c) - 1)
        self.assertEqual(r["days"], 2)

    def test_dev_zero_rows_carry_the_as_of_state(self):
        tape, s, adj = load(dev_unit())
        df, _ = R.dev_zero(tape, s, adj)
        e = df[(df["arm"] == "le5") & (df["kind"] == "event")].iloc[0]
        self.assertTrue(np.isfinite(e["base"]) and np.isfinite(e["supply"]))
        row = s[(s["slot"] == e["slot"]) & (s["owner"] == e["dev"])].iloc[0]
        self.assertEqual(e["base"], row["pool_base_post"])                # the state just after the dev's sale

    def test_decision_needs_the_bar_and_the_tercile_ruling(self):
        import run_step_a
        from unittest import mock
        own = {"le5": True, "zero": True, "le3": True}
        with mock.patch.object(R, "dev_zero_decide", lambda s: own), \
                mock.patch.object(R, "seat_drift_decide", lambda s: True), \
                mock.patch.object(RB, "rebuy_decide", lambda s: True):
            d = run_step_a.decision({}, {}, {}, {"1_dev_zero": {"by_arm": {"le5": {"passed": True},
                                                                            "zero": {"passed": False},
                                                                            "le3": {"passed": True}}},
                                                  "2_rebuy_anchor": {"passed": True}})
        self.assertTrue(d["2_rebuy_anchor_prereg"])
        # fixed sequence: zero fails its bar, so le3 cannot earn either; le5 waits for the tercile ruling (Q-R1-i)
        self.assertEqual(d["1_dev_zero_prereg_by_arm"], {"le5": run_step_a.DEV_ZERO_Q_TERCILE_RULED, "zero": False,
                                                         "le3": False})


class PayerMassRebuy(unittest.TestCase):
    """COUNT_ROWS_AMENDMENT_8 Q-R1-f: REBUY-ANCHOR's bar (CODE_REDTEAM.md R1-22)."""

    def test_rebuy_bar_top_quintile_against_the_median_band(self):
        import payer as PM
        n = 30
        k = np.arange(n)
        pts = pd.DataFrame({"pool": [f"p{i}" for i in k], "mint": "m", "day": DAY, "t": k, "hour": 1,
                            "RB": (k % 10).astype(float), "net_rebuy_flow": (k % 10) * 0.01, "drawdown": k / 100,
                            "eff_quote": 100e9, "mid": 100e9 / 1e15, "supply": 1e15})
        r = PM.rebuy_bar(pts, [DAY])
        ev = r["events"]
        self.assertEqual(len(ev), 6)                                  # RB 8 and 9 in each of 3 drawdown terciles
        top9 = ev[np.isclose(ev["net_rebuy_share"], 0.09)]
        self.assertTrue(np.allclose(top9["excess_share"], 0.09 - 0.04))   # minus the median of RB 3, 4, 5
        c = PM.round_trip_cost(100e9, 100e9, 1e15, 1e15)
        self.assertTrue(np.allclose(ev["s_star"], np.sqrt(1 + c) - 1))

    def test_rebuy_points_carry_supply_as_of_t(self):
        tape, s, _ = load(rebuy_unit())
        _, pts, _, _ = RB.rebuy_anchor(tape, s)
        self.assertEqual(float(pts[pts["hour"] == 1].iloc[0]["supply"]), SUPPLY)   # the state at or before t


class DevZeroRuledR1_25(unittest.TestCase):
    """COUNT_ROWS_AMENDMENT_9 confirms the Q-tercile cut: an arm meeting its own thresholds and its bar can earn, in the
    fixed order (CODE_REDTEAM.md R1-25)."""

    def _decide(self, bars):
        import run_step_a
        from unittest import mock
        with mock.patch.object(R, "dev_zero_decide", lambda s: {"le5": True, "zero": True, "le3": True}), \
                mock.patch.object(R, "seat_drift_decide", lambda s: False), \
                mock.patch.object(RB, "rebuy_decide", lambda s: False):
            return run_step_a.decision({}, {}, {}, {"1_dev_zero": {"by_arm": {a: {"passed": p} for a, p in bars.items()}}})

    def test_an_arm_meeting_its_bar_earns_in_the_fixed_order(self):
        self.assertEqual(self._decide({"le5": True, "zero": True, "le3": True})["1_dev_zero_prereg_by_arm"],
                         {"le5": True, "zero": True, "le3": True})
        self.assertEqual(self._decide({"le5": True, "zero": False, "le3": True})["1_dev_zero_prereg_by_arm"],
                         {"le5": True, "zero": False, "le3": False})
        self.assertEqual(self._decide({"le5": None, "zero": True, "le3": True})["1_dev_zero_prereg_by_arm"],
                         {"le5": False, "zero": False, "le3": False})   # a bar not computed never earns


if __name__ == "__main__":
    unittest.main()
