"""Synthetic shared-tape units ON DISK (research/*.csv.zst + E.jsonl.zst), for the reader equality test and for memory
checks of the outcome stage on data sized like real units. Every table the loader reads is written with the real
column names; rows are random but self-consistent where the design reads them (pool reserves before each trade,
owner balances before/after, migration and create events). Synthetic data only: nothing here reads the real tape.

Real 2026-09-11 unit (446233500-446237999) for scale: S_amm 673,634 rows, S_curve 63,265, T 72,049, W 224,995,
F 97,961, CF 293, B 4,493, E 2,208.
"""
import json
import os

import numpy as np
import pandas as pd

from d1 import config as C
from d1.load import AMM_COLS, CURVE_COLS, T_COLS
from tests import synth as S

B58 = np.array(list("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"))


def _addrs(rng, n, suffix=""):
    """n distinct base58-like addresses (44 characters, as real ones)."""
    raw = rng.choice(B58, size=(n, 44 - len(suffix)))
    out = ["".join(r) + suffix for r in raw]
    return np.array(out, dtype=object)


def _csv(df, path):
    df.to_csv(path, index=False, compression="zstd")


def write_units(root, n_units=3, slots_per_unit=4500, n_pools=4, every_s=10, noise_amm=200, n_curve=150, n_t=150,
                n_w=300, n_f=60, n_cf=5, n_wallets=400, seed=0, day=S.DAY, v1_units=(), gap_units=(),
                with_overlap=False):
    """Writes units <root>/<day>/<from>-<to>/research and returns their directories (skipped `gap_units` are not
    written, leaving a coverage gap). Per-unit row counts: `noise_amm` extra S_amm rows (other pools, other quotes,
    non-canonical), `n_curve` curve rows, `n_t`, `n_w`, `n_f`, `n_cf`; the migrated pools trade every `every_s`
    seconds. `v1_units`: unit indexes written as schema v1 (no top_program, no CF)."""
    rng = np.random.default_rng(seed)
    lo0 = S.S0
    hi0 = lo0 + n_units * slots_per_unit - 1
    wallets = _addrs(rng, n_wallets)
    pump_mints = _addrs(rng, n_pools + 20, "pump")
    other_mints = _addrs(rng, 10)
    pools = _addrs(rng, n_pools + 10)
    curves = _addrs(rng, n_pools + 20)
    apps = _addrs(rng, 3)
    sig_n = [0]

    def sig():
        sig_n[0] += 1
        return f"sig{sig_n[0]:08d}" + "x" * 76

    ev = []      # (slot, event, signature, fields)
    amm = []     # dict rows with string addresses
    # --- migrated pools: AmmSim trades from the migration slot on, owner balances tracked
    for j in range(n_pools):
        mint, pool, curve = pump_mints[j], pools[j], curves[j]
        creator, user = wallets[rng.integers(0, n_wallets)], wallets[rng.integers(0, n_wallets)]
        mig_slot = int(lo0 + rng.integers(10, max(11, slots_per_unit // 2)))
        create_on_tape = j % 3 != 2
        if create_on_tape:
            cs = int(lo0 + rng.integers(0, max(1, mig_slot - lo0 - 5)))
            ev.append((cs, "CreateEvent", sig(), {"mint": mint, "creator": creator, "user": user, "bonding_curve": curve,
                                                  "is_mayhem_mode": int(j % 5 == 4), "quote_mint": C.SYSTEM_PROGRAM,
                                                  "token_program": C.TOKEN_2022_PROGRAM if j % 2 else C.SPL_TOKEN_PROGRAM,
                                                  "is_cashback_enabled": int(j % 7 == 6)}))
            ev.append((mig_slot - 1, "CompleteEvent", sig(), {"mint": mint}))
        msig = sig()
        ev.append((mig_slot, "CompletePumpAmmMigrationEvent", msig, {"mint": mint, "pool": pool, "bonding_curve": curve,
                                                                      "quote_mint": C.SYSTEM_PROGRAM}))
        ev.append((mig_slot, "CreatePoolEvent", msig, {"pool": pool, "base_mint": mint, "quote_mint": C.WSOL,
                                                        "is_mayhem_mode": int(j % 5 == 4), "pool_quote_amount": 85 * 10**9,
                                                        "pool_base_amount": 206_900_000_000_000}))
        ev.append((mig_slot, "ExtendAccountEvent", msig, {"account": pool, "new_size": 301}))
        if j % 2 == 0:
            ev.append((mig_slot + 5, "InitBoostEvent", sig(), {"pool": pool, "mint": mint}))
        if j % 4 == 1:
            ev.append((mig_slot + 50, "DepositEvent", sig(), {"pool": pool, "lp_token_amount_out": 1000}))
            ev.append((mig_slot + 900, "WithdrawEvent", sig(), {"pool": pool, "lp_token_amount_in": 1000}))
        sim = S.AmmSim(j, j, base=206_900_000_000_000, vault=85 * 10**9, virt=int(rng.integers(0, 20)) * 10**9,
                       fees=(20, 5, int(rng.choice([0, 30, 95]))), supply=10**15)
        bal = {}
        cc = creator if j % 4 != 3 else ""
        n_owner = max(8, n_wallets // 4)
        for t in range(int(S.bt_of(mig_slot)) + 2, int(S.bt_of(hi0)), every_s):
            s = int(S.slot_at(t)) + int(rng.integers(0, 2))
            if s > hi0:
                break
            o = wallets[rng.integers(0, n_owner)]
            app = int(rng.random() < 0.3)
            r = rng.random()
            if r < 0.04:   # BOOST slice: no owner, flagged by signature through E
                sg = sig()
                sim.trade(s, "buy", int(rng.integers(1, 5)) * 10**8)
                ev.append((s, "BoostBuyAndBurnEvent", sg, {"pool": pool, "mint": mint,
                                                          "boost_vault_remaining": int(rng.integers(0, 3)) * 10**9}))
                amm.append(_row(sim, pool, mint, "", 0, 0, sg, 0, app, apps, cc))
                continue
            held = bal.get(o, 0)
            if held > 0 and rng.random() < 0.45:
                amt = held if rng.random() < 0.5 else held // 2
                sim.trade(s, "sell", amt)
                bal[o] = held - amt
                side = "sell"
            else:
                b = sim.trade(s, "buy", int(rng.integers(1, 40)) * 10**8)
                bal[o] = held + b
                side = "buy"
            prot = int(rng.random() < 0.02)
            amm.append(_row(sim, pool, mint, o, held, bal[o], sig(), prot, app, apps, cc))
            assert amm[-1]["side"] == side
    # --- noise S_amm rows per unit: other pools, non-WSOL quote, non-canonical (filtered out by the loader)
    noise = []
    for u in range(n_units):
        lo = lo0 + u * slots_per_unit
        k = noise_amm
        sl = np.sort(rng.integers(lo, lo + slots_per_unit, k))
        noise.append(pd.DataFrame({
            "slot": sl, "block_time": S.bt_of(sl), "tx_idx": rng.integers(0, 900, k), "ev_idx": rng.integers(0, 4, k),
            "outer_ix": rng.integers(0, 5, k), "inner_ix": rng.integers(-1, 6, k),
            "pool": pools[rng.integers(n_pools, len(pools), k)],
            "base_mint": np.where(rng.random(k) < 0.7, pump_mints[rng.integers(0, len(pump_mints), k)],
                                  other_mints[rng.integers(0, len(other_mints), k)]),
            "quote_mint": np.where(rng.random(k) < 0.85, C.WSOL, other_mints[0]),
            "side": np.where(rng.random(k) < 0.55, "buy", "sell"),
            "base_amount": rng.integers(1, 10**12, k), "quote_amount": rng.integers(1, 10**10, k),
            "quote_amount_lp_adjusted": rng.integers(1, 10**10, k), "user_quote_amount": rng.integers(1, 10**10, k),
            "pool_base_token_reserves": rng.integers(10**13, 10**15, k),
            "pool_quote_token_reserves": rng.integers(10**10, 10**12, k), "virtual_quote_reserves": 0,
            "lp_fee_basis_points": 20, "protocol_fee_basis_points": 5, "coin_creator_fee_basis_points": 95,
            "coin_creator": wallets[rng.integers(0, n_wallets, k)], "base_supply": 10**15,
            "user_token_owner": wallets[rng.integers(0, n_wallets, k)], "owner_token_pre": rng.integers(0, 10**9, k),
            "owner_token_post": rng.integers(0, 10**9, k), "canonical": (rng.random(k) < 0.8).astype(int),
            "top_program": np.where(rng.random(k) < 0.6, C.PUMPSWAP_PROGRAM, apps[0]),
            "signature": [sig() for _ in range(k)], "protocol": (rng.random(k) < 0.02).astype(int)}))
    a_all = pd.concat([pd.DataFrame(amm, columns=AMM_COLS)] + noise, ignore_index=True)
    # --- curve rows: migrated mints before migration and other pump mints
    cv = []
    for u in range(n_units):
        lo = lo0 + u * slots_per_unit
        k = n_curve
        sl = np.sort(rng.integers(lo, lo + slots_per_unit, k))
        mi = rng.integers(0, len(pump_mints), k)
        cv.append(pd.DataFrame({
            "slot": sl, "block_time": S.bt_of(sl), "tx_idx": rng.integers(0, 900, k), "ev_idx": rng.integers(0, 3, k),
            "outer_ix": rng.integers(0, 5, k), "inner_ix": rng.integers(-1, 4, k), "mint": pump_mints[mi],
            "is_buy": (rng.random(k) < 0.6).astype(int), "sol_amount": rng.integers(10**6, 5 * 10**9, k),
            "token_amount": rng.integers(10**9, 10**13, k), "fee": rng.integers(0, 10**7, k),
            "creator_fee": rng.integers(0, 10**6, k), "quote_mint": np.where(rng.random(k) < 0.9, "", other_mints[1]),
            "quote_amount": rng.integers(0, 10**9, k), "mayhem_mode": np.where(rng.random(k) < 0.1, "", (mi % 5 == 4).astype(int).astype(str)),
            "user": np.where(rng.random(k) < 0.9, wallets[rng.integers(0, n_wallets, k)], ""),
            "user_token_owner": wallets[rng.integers(0, n_wallets, k)], "owner_token_pre": rng.integers(0, 10**12, k),
            "owner_token_post": rng.integers(0, 10**12, k), "signature": [sig() for _ in range(k)],
            "protocol": (rng.random(k) < 0.01).astype(int)}))
    c_all = pd.concat(cv, ignore_index=True)[CURVE_COLS]
    # --- T: transfers of migrated mints between wallets (holders), of pump and other mints (clusters, H13 links)
    tt = []
    for u in range(n_units):
        lo = lo0 + u * slots_per_unit
        k = n_t
        sl = np.sort(rng.integers(lo, lo + slots_per_unit, k))
        mints = np.where(rng.random(k) < 0.6, pump_mints[rng.integers(0, n_pools, k)],
                         np.where(rng.random(k) < 0.5, pump_mints[rng.integers(0, len(pump_mints), k)],
                                  other_mints[rng.integers(0, len(other_mints), k)]))
        tt.append(pd.DataFrame({
            "slot": sl, "block_time": S.bt_of(sl), "tx_idx": rng.integers(0, 900, k), "outer_ix": rng.integers(0, 5, k),
            "inner_ix": rng.integers(-1, 4, k), "mint": mints,
            "kind": rng.choice(np.array(["transfer", "transfer", "transfer", "burn", "mint", "other"]), k),
            "from_owner": np.where(rng.random(k) < 0.95, wallets[rng.integers(0, n_wallets, k)], ""),
            "to_owner": np.where(rng.random(k) < 0.95, wallets[rng.integers(0, n_wallets, k)], ""),
            "amount": rng.integers(1, 10**11, k)}))
    t_all = pd.concat(tt, ignore_index=True)[T_COLS]
    # --- W, F, CF, B per unit
    hub = wallets[0]
    for u in range(n_units):
        if u in gap_units:
            continue
        lo = lo0 + u * slots_per_unit
        hi = lo + slots_per_unit - 1
        if with_overlap and u > 0:
            lo -= 3   # overlapping unit ranges: the loader's global sort must still order rows
        d = os.path.join(root, day, f"{lo}-{hi}", "research")
        os.makedirs(d, exist_ok=True)
        slots = np.arange(lo, hi + 1)
        slots = slots[(slots % 97) != 5]   # a few skipped slots
        _csv(pd.DataFrame({"slot": slots, "block_time": S.bt_of(slots), "n_pump_failed": 0}), os.path.join(d, "B.csv.zst"))
        inu = lambda df: df[(df.slot >= lo) & (df.slot <= hi)]
        a = inu(a_all)
        if u in v1_units:
            a = a.drop(columns=["top_program"])
        _csv(a, os.path.join(d, "S_amm.csv.zst"))
        _csv(inu(c_all), os.path.join(d, "S_curve.csv.zst"))
        _csv(inu(t_all), os.path.join(d, "T.csv.zst"))
        k = n_w
        sl = np.sort(rng.integers(lo, hi + 1, k))
        src = wallets[rng.integers(0, n_wallets, k)]
        src[rng.random(k) < 0.05] = hub    # a hub (more than 50 links)
        _csv(pd.DataFrame({"slot": sl, "block_time": S.bt_of(sl), "from": src,
                           "to": wallets[rng.integers(0, n_wallets, k)], "amount": rng.integers(5 * 10**7, 10**11, k)}),
             os.path.join(d, "W.csv.zst"))
        k = n_f
        sl = np.sort(rng.integers(lo, hi + 1, k))
        _csv(pd.DataFrame({"slot": sl, "block_time": S.bt_of(sl), "venue": rng.choice(np.array(["pumpswap", "pump"]), k),
                           "side": rng.choice(np.array(["buy", "sell"]), k),
                           "err_class": rng.choice(np.array(["slippage", "compute", "state"]), k),
                           "pool_or_curve": pools[rng.integers(0, len(pools), k)]}), os.path.join(d, "F.csv.zst"))
        if u not in v1_units:
            k = n_cf
            sl = np.sort(rng.integers(lo, hi + 1, k))
            _csv(pd.DataFrame({"slot": sl, "block_time": S.bt_of(sl), "creator": wallets[rng.integers(0, n_wallets, k)],
                               "amount": 1}), os.path.join(d, "CF.csv.zst"))
        e = [x for x in ev if lo <= x[0] <= hi] + [(lo, "TradeEvent", sig(), {"mint": pump_mints[0]})]
        e.sort(key=lambda x: x[0])
        with open(os.path.join(d, "E.jsonl"), "w") as fh:
            for s_, name, sg, fl in e:
                fh.write(json.dumps({"slot": s_, "event": name, "signature": sg, "fields": fl}) + "\n")
        pd.read_json(os.path.join(d, "E.jsonl"), lines=True, dtype=False).to_json(
            os.path.join(d, "E.jsonl.zst"), orient="records", lines=True, compression="zstd")
        os.remove(os.path.join(d, "E.jsonl"))
    return sorted(os.path.join(root, day, x) for x in os.listdir(os.path.join(root, day)))


def _row(sim, pool, mint, owner, pre, post, signature, protocol, app, apps, cc):
    r = sim.rows[-1]
    return {"slot": r["slot"], "block_time": r["block_time"], "tx_idx": r["tx_idx"], "ev_idx": 0, "outer_ix": 0,
            "inner_ix": -1, "pool": pool, "base_mint": mint, "quote_mint": C.WSOL,
            "side": "buy" if r["side"] == 1 else "sell", "base_amount": r["base_amount"],
            "quote_amount": r["quote_amount"], "quote_amount_lp_adjusted": r["quote_lp_adj"],
            "user_quote_amount": r["user_quote"], "pool_base_token_reserves": r["base_before"],
            "pool_quote_token_reserves": r["vault_before"], "virtual_quote_reserves": r["virt"],
            "lp_fee_basis_points": r["lp_bps"], "protocol_fee_basis_points": r["protocol_bps"],
            "coin_creator_fee_basis_points": r["creator_bps"], "coin_creator": cc, "base_supply": r["supply"],
            "user_token_owner": owner, "owner_token_pre": pre if owner else "", "owner_token_post": post if owner else "",
            "canonical": 1, "top_program": apps[1] if app else C.PUMPSWAP_PROGRAM, "signature": signature,
            "protocol": protocol}
