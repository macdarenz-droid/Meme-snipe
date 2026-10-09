"""Random synthetic multi-unit, multi-day tapes (seeded) for the reader equality tests and the memory checks.

`random_tape(root, seed, ...)` writes contiguous units over the two discovery days. Each unit holds coins with a whole
life on the curve (create, buys and sells, some graduate to a PumpSwap pool with BOOST slices, buyback-authority swaps
and failed boost transactions; mayhem, cashback, USDC-quote and pre-tape coins), token transfers, mints and burns,
SOL links (with a hub), and vectorised filler: swaps on other pools (WSOL-base pools, rows without a token owner),
low-progress curve trades, links and failed transactions. `filler` and `life` scale a unit; `real_size()` gives about
the row counts of a real 2026-09-11 unit (S_amm 0.7M rows, of them ~0.13M on migration pools; S_curve 61k; W 258k;
T 73k; F 66k)."""
import json
import os

import numpy as np
import pandas as pd

from synth import SOL, WSOL, Synth, bt

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
BUYBACK = "GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG"
ALPH = np.frombuffer(b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", dtype="S1")
LAMPORTS = 10 ** 9
FIRST_SLOT = 446_100_000
DAYS = ("2026-09-10", "2026-09-11")


def addrs(rng, n, length=44):
    """n random base58-looking addresses."""
    idx = rng.integers(0, len(ALPH), size=(n, length))
    return ALPH[idx].view(f"S{length}").ravel().astype(f"U{length}").tolist()


def small(life=6, pool_trades=40, filler_amm=400, filler_curve=60, filler_w=150, filler_t=40, filler_f=60, regulars=300,
          new_per_unit=120, f_boost=0.05):
    return dict(life=life, pool_trades=pool_trades, filler_amm=filler_amm, filler_curve=filler_curve, filler_w=filler_w,
                filler_t=filler_t, filler_f=filler_f, regulars=regulars, new_per_unit=new_per_unit, f_boost=f_boost)


def real_size():
    return dict(life=31, pool_trades=4_200, filler_amm=583_000, filler_curve=52_000, filler_w=258_000, filler_t=66_000,
                filler_f=66_000, regulars=160_000, new_per_unit=87_000, f_boost=0.0004)


class RandomTape:
    def __init__(self, seed, units_per_day=(2, 2), unit_len=4_500, v1_units=(1,), **size):
        self.rng = np.random.default_rng(seed)
        self.size = size or small()
        self.units = []
        s = FIRST_SLOT
        k = 0
        for day, n in zip(DAYS, units_per_day):
            for _ in range(n):
                self.units.append((day, s, s + unit_len - 1, k not in v1_units))
                s += unit_len
                k += 1
        self.regulars = addrs(self.rng, self.size["regulars"])
        self.s = Synth()
        self.F = []
        self.n = 0

    def name(self, p):
        self.n += 1
        return f"{p}{self.n}"

    def owner(self, fresh):
        r = self.rng
        return fresh[int(r.integers(len(fresh)))] if r.random() < 0.3 else self.regulars[int(r.integers(len(self.regulars)))]

    # ---- coins with a whole life -----------------------------------------------------------------------------------
    def life(self, first, last, fresh):
        r, s = self.rng, self.s
        span = last - first
        for _ in range(self.size["life"]):
            mint = self.name("mint")
            creator = self.owner(fresh)
            c = first + int(r.integers(0, span // 2))
            kind = r.choice(["grad", "grad", "grad", "stall", "mayhem", "cashback", "usdc", "pretape", "late"])
            quote = USDC if kind == "usdc" else SOL
            if kind == "pretape":
                s.state[mint] = [30 * LAMPORTS + 40 * LAMPORTS, 1_073_000_000_000_000 - 400_000_000_000_000, 40 * LAMPORTS,
                                 793_100_000_000_000 - 400_000_000_000_000]
            else:
                s.create(c, int(r.integers(0, 5)), mint, creator, name=f"n{int(r.integers(0, 4))}",
                         symbol=f"S{int(r.integers(0, 50))}", mayhem=int(kind == "mayhem"), cashback=int(kind == "cashback"),
                         quote=quote)
            holders = []
            slot = c + 1 if kind != "late" else last - 300
            steps = sorted(r.uniform(0.05, 1.0, size=int(r.integers(4, 14))))
            if kind == "stall":
                steps = [x * 0.93 for x in steps]
            for f in steps:
                slot += int(r.integers(1, 40))
                o = self.owner(fresh)
                holders.append(o)
                target = int(f * 85 * LAMPORTS)
                vs, vt, rs, rt = s.state[mint]
                if target > rs and rt > 0:
                    s.trade(slot, int(r.integers(0, 50)), mint, o, sol=max(target - rs + 2, 2), quote=quote,
                            mayhem=int(kind == "mayhem"), cashback=int(kind == "cashback"),
                            post=None if r.random() < 0.5 else int(r.integers(0, 10 ** 12)))
                if r.random() < 0.3 and len(holders) > 1:
                    s.trade(slot, int(r.integers(50, 60)), mint, holders[0], tokens=10 ** 9, buy=False, quote=quote)
                if r.random() < 0.3:
                    s.transfer(slot, int(r.integers(60, 70)), mint, holders[-1], self.owner(fresh), 10 ** 8,
                               kind=r.choice(["transfer", "transfer", "mint", "burn"]))
                if r.random() < 0.4:
                    s.sol_link(slot, creator, o)
            if kind == "grad" and s.state[mint][3] > 0 and slot + 50 < last + 4_500:
                m = slot + int(r.integers(5, 60))
                pool = self.name("pool")
                s.complete(m, 70, mint, pool)
                for ps in np.sort(m + r.integers(0, 5_400, self.size["pool_trades"])).tolist():
                    if r.random() < 0.03:
                        s.pool_trade(ps, int(r.integers(0, 50)), pool, mint, "boost", "buy", quote=int(r.integers(10 ** 7, 10 ** 9)),
                                     bps=(0, 0, 0), boost=True)
                        if r.random() < 0.3:
                            self.F.append({"slot": ps, "tx_idx": int(r.integers(50, 99)), "pool_or_curve": pool, "mint": mint,
                                           "ix_name": "boost_buy_and_burn", "err_class": r.choice(["slippage", "state"]),
                                           "amount_arg": 10 ** 8, "limit_arg": 10 ** 6})
                    elif r.random() < 0.02:
                        s.pool_trade(ps, int(r.integers(0, 50)), pool, mint, BUYBACK, "buy", quote=10 ** 8)
                    elif r.random() < 0.6:
                        s.pool_trade(ps, int(r.integers(0, 50)), pool, mint, self.owner(fresh), "buy",
                                     quote=int(r.integers(10 ** 6, 3 * 10 ** 9)))
                    else:
                        s.pool_trade(ps, int(r.integers(0, 50)), pool, mint, self.owner(fresh), "sell",
                                     base=int(r.integers(10 ** 6, 10 ** 12)))

    # ---- vectorised filler (pools never migrated on the tape; low-progress curves) -----------------------------------
    def filler(self, first, last, fresh):
        r, z = self.rng, self.size
        out = {}
        pick = np.array(self.regulars + fresh, dtype=object)

        def who(n):
            return pick[r.integers(0, len(pick), n)]

        n = z["filler_amm"]
        if n:
            pools = np.array(addrs(r, max(n // 2_000, 2)), dtype=object)
            mints = np.array(addrs(r, len(pools)), dtype=object)
            pi = r.integers(0, len(pools), n)
            base = np.where(pi % 7 == 0, WSOL, mints[pi]).astype(object)
            users = who(n)
            uto = users.copy()
            uto[r.random(n) < 0.05] = None
            signer = users.copy()
            signer[r.random(n) < 0.001] = BUYBACK
            q = r.integers(10 ** 5, 10 ** 10, n)
            out["S_amm"] = pd.DataFrame({
                "slot": r.integers(first, last + 1, n), "block_time": 0, "tx_idx": r.integers(100, 2_000, n), "ev_idx": 0,
                "outer_ix": r.integers(0, 5, n), "inner_ix": r.integers(0, 5, n), "pool": pools[pi], "base_mint": base,
                "quote_mint": WSOL, "side": np.where(r.random(n) < 0.55, "buy", "sell"),
                "base_amount": r.integers(10 ** 6, 10 ** 13, n), "quote_amount": q, "quote_amount_lp_adjusted": q,
                "pool_base_token_reserves": r.integers(10 ** 14, 10 ** 15, n),
                "pool_quote_token_reserves": r.integers(10 ** 10, 10 ** 12, n), "virtual_quote_reserves": 0,
                "lp_fee_basis_points": 20, "protocol_fee_basis_points": 5, "coin_creator_fee_basis_points": 5,
                "lp_fee": q // 500, "protocol_fee": q // 2_000, "coin_creator_fee": q // 2_000, "min_base_amount_out": 0,
                "ix_name": "buy", "base_supply": 10 ** 15, "chain_pool_base": r.integers(10 ** 14, 10 ** 15, n),
                "chain_pool_quote": r.integers(10 ** 10, 10 ** 12, n), "user": users, "user_token_owner": uto,
                "canonical": r.integers(0, 2, n), "protocol": 0, "signer": signer})
            out["S_amm"]["block_time"] = bt(out["S_amm"]["slot"].to_numpy())
        n = z["filler_curve"]
        if n:
            mints = np.array(addrs(r, max(n // 90, 2)), dtype=object)
            mi = r.integers(0, len(mints), n)
            sol = r.integers(10 ** 6, 10 ** 9, n)
            vs = 30 * LAMPORTS + r.integers(0, 20 * LAMPORTS, n)          # below 25% progress: never a trigger
            users = who(n)
            uto = users.copy()
            uto[r.random(n) < 0.05] = None
            sl = r.integers(first, last + 1, n)
            out["S_curve"] = pd.DataFrame({
                "slot": sl, "block_time": bt(sl), "tx_idx": r.integers(100, 2_000, n), "ev_idx": 0, "outer_ix": 0,
                "inner_ix": 0, "mint": mints[mi], "is_buy": r.integers(0, 2, n), "sol_amount": sol,
                "token_amount": sol * 30_000, "virtual_sol_reserves": vs, "virtual_token_reserves": 1_000_000_000_000_000,
                "real_sol_reserves": vs - 30 * LAMPORTS, "real_token_reserves": 700_000_000_000_000,
                "fee_basis_points": 95, "fee": sol // 100, "creator_fee_basis_points": 30, "creator_fee": sol // 300,
                "mayhem_mode": np.where(r.random(n) < 0.01, np.nan, 0), "cashback_fee_basis_points": 0,
                "quote_mint": SOL, "quote_amount": sol, "virtual_quote_reserves": vs, "real_quote_reserves": vs - 30 * LAMPORTS,
                "user": users, "user_token_owner": uto, "owner_token_post": r.integers(-1, 10 ** 12, n),
                "creator": who(n)})
        n = z["filler_w"]
        if n:
            sl = r.integers(first, last + 1, n)
            out["W"] = pd.DataFrame({"slot": sl, "block_time": bt(sl), "tx_idx": 0, "outer_ix": 0, "inner_ix": "",
                                     "from": who(n), "to": who(n), "lamports": 10 ** 8, "signer": "x", "signature": "s"})
            hub = self.regulars[0]
            out["W"].loc[out["W"].index[: min(80, n)], "from"] = hub                     # a hub (> 50 links)
        n = z["filler_t"]
        if n:
            sl = r.integers(first, last + 1, n)
            out["T"] = pd.DataFrame({"slot": sl, "block_time": bt(sl), "tx_idx": r.integers(100, 2_000, n),
                                     "outer_ix": 9, "inner_ix": 0, "mint": np.array(addrs(r, n // 50 + 1), dtype=object)[r.integers(0, n // 50 + 1, n)],
                                     "kind": r.choice(["transfer", "transfer", "mint", "burn"], n), "from_owner": who(n),
                                     "to_owner": who(n), "amount": r.integers(1, 10 ** 12, n)})
        n = z["filler_f"]
        if n:
            sl = r.integers(first, last + 1, n)
            out["F"] = pd.DataFrame({"slot": sl, "tx_idx": r.integers(0, 2_000, n), "pool_or_curve": who(n), "mint": who(n),
                                     "ix_name": r.choice(["buy", "sell", "boost_buy_and_burn"], n,
                                                         p=[0.6, 0.4 - z["f_boost"], z["f_boost"]]),
                                     "err_class": r.choice(["slippage", "compute", "state"], n),
                                     "amount_arg": r.integers(0, 10 ** 9, n), "limit_arg": r.integers(0, 10 ** 9, n)})
        return out

    # ---- write -------------------------------------------------------------------------------------------------------
    def build(self, root):
        fresh = []
        for day, first, last, v2 in self.units:
            fresh.append(addrs(self.rng, self.size["new_per_unit"]))
            self.life(first, last, fresh[-1])
        dirs = []
        for (day, first, last, v2), fr in zip(self.units, fresh):
            extra = self.filler(first, last, fr)        # one unit's filler at a time
            d = self.s.write(root, day, first, last, schema_v2=v2)
            for name, df in extra.items():
                p = os.path.join(d, f"{name}.csv.zst")
                base = pd.read_csv(p, dtype=str, keep_default_na=False)
                if name == "F" and self.F:
                    base = pd.concat([base, pd.DataFrame([x for x in self.F if first <= x["slot"] <= last]).astype(str)])
                df = df.reindex(columns=base.columns)
                pd.concat([base, df.astype(object).where(df.notna(), "")], ignore_index=True) \
                    .to_csv(p, index=False, compression="zstd")
            dirs.append(d)
        return {day: [(f, l) for d2, f, l, _ in self.units if d2 == day] for day in DAYS}


def random_tape(root, seed, **kw):
    """Writes the tape under root and returns its plan {day: [(from, to), ...]}."""
    return RandomTape(seed, **kw).build(root)
