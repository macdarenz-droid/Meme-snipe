"""Random synthetic tape in the shared-tape file layout (zstd CSV and JSONL units plus a unit plan), for the reader
equality tests (tests/test_lowmem.py) and for memory checks sized like real units. All values are strings, with the
awkward cases the readers must keep exact: empty cells, empty owners, protocol and BOOST rows, non-canonical pools,
LP events, unresolved marks, transfers, coins outside the universe and rows in pools outside it."""
import json
import os

import numpy as np
import pandas as pd
import zstandard

from h1cgo.constants import DEFAULT_KEY, WSOL
from h1cgo.pumpswap import amm_post_state
from tests.synth import AMM_COLS, CURVE_COLS, T_COLS, TCOV_COLS, amm_row, curve_row, t_row

SOL = "11111111111111111111111111111111"
DAY_T = {d: int(pd.Timestamp(d, tz="UTC").timestamp()) for d in
         ("2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11")}


def _zst(path, text: str):
    with open(path, "wb") as f:
        f.write(zstandard.ZstdCompressor(level=1).compress(text.encode()))


def _csv(path, rows, cols):
    _zst(path, pd.DataFrame(rows, columns=cols).to_csv(index=False))


class _Chain:
    def __init__(self, rng, base, vault, virtual=0):
        self.rng, self.base, self.vault, self.virtual = rng, base, vault, virtual

    def trade(self, slot, time, tx, owner, pool, mint, bal):
        """One consistent PumpSwap trade; `bal` tracks owner balances so pre/post read like the tape."""
        rng = self.rng
        side = "buy" if (rng.random() < 0.55 or bal.get(owner, 0) == 0) else "sell"
        if side == "buy":
            amt = max(1, int(self.base * rng.uniform(0.0005, 0.01)))
        else:
            amt = max(1, int(bal[owner] * (1.0 if rng.random() < 0.4 else rng.uniform(0.1, 0.9))))
        r = amm_row(slot, tx, owner, side, amt, self.base, self.vault, self.virtual, pool=pool, mint=mint,
                    outer=int(rng.integers(0, 4)), inner=("" if rng.random() < 0.7 else str(int(rng.integers(0, 3)))))
        pre_b = bal.get(owner, 0)
        post_b = pre_b + amt if side == "buy" else max(pre_b - amt, 0)
        bal[owner] = post_b
        r.update(block_time=str(time), owner_token_pre=str(pre_b), owner_token_post=str(post_b),
                 ev_idx=("" if rng.random() < 0.05 else str(int(rng.integers(0, 3)))),
                 signature=f"sig{int(rng.integers(0, 10**12))}")
        u = rng.random()
        if u < 0.03:
            r["user_token_owner"], r["owner_token_pre"], r["owner_token_post"] = "", "", ""
        elif u < 0.06:
            r["owner_token_pre"] = ""
        if rng.random() < 0.03:
            r["protocol"] = "1"
        if rng.random() < 0.02:
            r["coin_creator"] = DEFAULT_KEY
        if rng.random() < 0.02:
            r["coin_creator_fee_basis_points"] = "0"
        if rng.random() < 0.02:
            r["base_supply"] = ""
        if rng.random() < 0.01:
            r["virtual_quote_reserves"] = ""
        pre, post = amm_post_state(r)
        if rng.random() < 0.3:
            r["last_in_tx"], r["chain_pool_quote"] = "1", str(post.vault + int(rng.integers(0, 3)))
            _, post = amm_post_state(r)
        self.base, self.vault, self.virtual = post.base, post.vault, post.virtual
        return r


def make_tape(root, days, units_per_day=3, slots_per_unit=3000, coins_per_day=6, amm_per_unit=600,
              noise_frac=0.3, curve_per_coin=20, t_per_unit=60, seed=0, n_owners=40, mig_prob=1.0, noise_pools=3,
              t_amount_max=10**11, noncanon_p=0.01,
              log=None):
    """Writes units <root>/<day>/<from>-<to>/research and <root>/plan.txt. Returns (unit dirs, plan path).
    PumpSwap rows are generated and written one unit at a time, so large tapes fit in memory."""
    rng = np.random.default_rng(seed)
    s_day = units_per_day * slots_per_unit
    owners = [f"W{k:03d}" for k in range(n_owners)] + ["007", " 7", "1_0", "-0", "NA", "nan"]
    units, plan = [], []
    first = 0
    for di, day in enumerate(sorted(days)):
        t0 = DAY_T[day]
        lo = first
        tm = lambda s, lo=lo, t0=t0: t0 + ((s - lo) * 86400) // s_day
        hi = lo + s_day - 1
        ev, curve, tt, tcov = [], [], [], []
        coins = []
        for c in range(coins_per_day):
            mint, pool, bc = f"M{seed}_{di}_{c}", f"P{seed}_{di}_{c}", f"BC{seed}_{di}_{c}"
            cs = int(lo + rng.integers(0, s_day // 3))
            kind = rng.choice(["ok", "ok", "ok", "ok", "mayhem", "cashback", "usdc", "nomig"])
            f = dict(mint=mint, bonding_curve=bc, quote_mint=SOL if kind != "usdc" else "USDC",
                     is_mayhem_mode="1" if kind == "mayhem" else "0",
                     is_cashback_enabled="1" if kind == "cashback" else "0",
                     token_program=rng.choice(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                               "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", ""]))
            ev.append(dict(event="CreateEvent", program="pump", slot=cs, block_time=tm(cs), signature="c", outer_ix=0,
                           fields=f))
            ms = cs + int(rng.integers(50, 400))
            bal = {}
            for k in range(curve_per_coin):
                s = int(rng.integers(cs, ms))
                o = owners[int(rng.integers(0, len(owners)))]
                buy = rng.random() < 0.7 or bal.get(o, 0) == 0
                amt = int(rng.integers(10**9, 10**12))
                if not buy:
                    amt = min(amt, bal[o])
                pre = bal.get(o, 0)
                bal[o] = pre + amt if buy else pre - amt
                r = curve_row(s, int(rng.integers(0, 50)), o, buy, amt, int(rng.integers(10**6, 10**9)), mint=mint,
                              fee=int(rng.integers(0, 10**6)), creator_fee=int(rng.integers(0, 10**5)), post=bal[o],
                              protocol="1" if rng.random() < 0.03 else "0")
                r.update(block_time=str(tm(s)), owner_token_pre=str(pre), ev_idx=str(int(rng.integers(0, 3))))
                curve.append(r)
            if kind != "nomig" and ms < hi and rng.random() < mig_prob:
                b0, v0 = int(rng.integers(150, 250)) * 10**12, int(rng.integers(70, 120)) * 10**9
                ev.append(dict(event="CompletePumpAmmMigrationEvent", program="pump", slot=ms, block_time=tm(ms),
                               signature="m", outer_ix=0, fields=dict(mint=mint, pool=pool)))
                ev.append(dict(event="CreatePoolEvent", program="pump_amm", slot=ms, block_time=tm(ms), signature="p",
                               outer_ix=0, fields=dict(pool=pool, quote_mint=WSOL, pool_quote_amount=str(v0),
                                                       pool_base_amount=str(b0))))
                coins.append((mint, pool, ms, _Chain(rng, b0, v0), bal))
        uni = sorted(coins, key=lambda c: c[2])
        noise = [(f"X{seed}_{di}_{n}", f"PX{seed}_{di}_{n}", lo, _Chain(rng, 200 * 10**12, 90 * 10**9), {})
                 for n in range(noise_pools)]  # pools outside the universe (coins of other days): habits only
        # trades also land exactly on decision slots (the last slot before each whole hour)
        last_before_hour = [s for s in range(lo, hi) if tm(s) // 3600 != tm(s + 1) // 3600]
        slots = np.sort(np.concatenate([rng.integers(lo, hi + 1, size=amm_per_unit * units_per_day),
                                        np.array(last_before_hour, dtype=np.int64)]))
        dirs = []
        for ui in range(units_per_day):
            a, b = lo + ui * slots_per_unit, lo + (ui + 1) * slots_per_unit - 1
            d = os.path.join(root, day, f"{a}-{b}", "research")
            os.makedirs(d)
            dirs.append((a, b, d))
        k, ui, amm = 0, 0, []
        for s in list(slots) + [hi + 1]:
            s = int(s)
            while s > dirs[ui][1]:  # unit finished: write its PumpSwap rows
                _csv(os.path.join(dirs[ui][2], "S_amm.csv.zst"), amm, AMM_COLS)
                amm = []
                if log:
                    log(f"S_amm {day} unit {ui}")
                ui += 1
                if ui == len(dirs):
                    break
            if ui == len(dirs):
                break
            while k < len(uni) and uni[k][2] < s:
                k += 1
            pick = noise if (noise and (k == 0 or rng.random() < noise_frac)) else uni[:k]
            if not pick:
                continue
            mint, pool, _, ch, bal = pick[int(rng.integers(0, len(pick)))]
            o = owners[int(rng.integers(0, len(owners)))]
            r = ch.trade(s, tm(s), int(rng.integers(0, 50)), o, pool, mint, bal)
            if rng.random() < noncanon_p:
                r["canonical"] = "0"
            if rng.random() < 0.02:  # a BOOST buy-and-burn matched by its event
                ev.append(dict(event="BoostBuyAndBurnEvent", program="pump_amm", slot=s, block_time=tm(s),
                               signature=r["signature"], outer_ix=int(r["outer_ix"]), fields=dict(pool=pool)))
            amm.append(r)
        for _ in range(t_per_unit * units_per_day):
            if not uni:
                break
            mint = uni[int(rng.integers(0, len(uni)))][0]
            s = int(rng.integers(lo, hi + 1))
            kind = rng.choice(["transfer", "transfer", "transfer", "mint", "burn"])
            a, b = owners[int(rng.integers(0, len(owners)))], owners[int(rng.integers(0, len(owners)))]
            if rng.random() < 0.05:
                a = ""
            tt.append(t_row(s, int(rng.integers(0, 50)), kind, a if kind != "mint" else "", b if kind != "burn" else "",
                            int(rng.integers(1, t_amount_max)), mint=mint, outer=int(rng.integers(0, 3)),
                            inner=("" if rng.random() < 0.5 else "1")))
        for mint, pool, ms, _, _ in uni:
            if rng.random() < 0.3:
                s = int(rng.integers(ms, hi + 1))
                ev.append(dict(event="DepositEvent", program="pump_amm", slot=s, block_time=tm(s), signature="d",
                               outer_ix=0, fields=dict(pool=pool, lp_token_amount_out=str(int(rng.integers(1, 10**6))))))
            if rng.random() < 0.15:
                tcov.append(dict(zip(TCOV_COLS, (mint, "unresolved", str(int(rng.integers(lo, hi + 1))), "x", "1", "0"))))
            if rng.random() < 0.2:
                tcov.append(dict(zip(TCOV_COLS, (mint, "other", "", "y", "2", ""))))
        for ui, (a, b, d) in enumerate(dirs):
            inu = lambda rows: [r for r in rows if a <= int(r["slot"]) <= b]
            _csv(os.path.join(d, "S_curve.csv.zst"), inu(curve), CURVE_COLS)
            _csv(os.path.join(d, "T.csv.zst"), inu(tt), T_COLS)
            _csv(os.path.join(d, "T_coverage.csv.zst"), tcov if ui == 0 else [], TCOV_COLS)
            _csv(os.path.join(d, "B.csv.zst"), [dict(slot=str(s), block_time=str(tm(s))) for s in range(a, b + 1)],
                 ["slot", "block_time"])
            _zst(os.path.join(d, "E.jsonl.zst"), "".join(json.dumps(e) + "\n" for e in ev if a <= e["slot"] <= b))
            units.append(os.path.dirname(d))
            plan.append(f"{day} 1 {a} {b}\n")
        first = hi + 1
    path = os.path.join(root, "plan.txt")
    with open(path, "w") as f:
        f.write("".join(plan))
    return units, path
