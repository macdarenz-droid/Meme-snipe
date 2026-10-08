"""Builds small synthetic tape units (the shared-tape research tables, research/shared-tape/README.md) for tests."""
import json
import os

import pandas as pd

SOL = "11111111111111111111111111111111"
WSOL = "So11111111111111111111111111111111111111112"
T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
V0, T0, R0 = 30_000_000_000, 1_073_000_000_000_000, 793_100_000_000_000
T0_TIME = 1_789_000_000


def bt(slot):
    """Block time: 0.4 s a slot from slot 0 of the fixture."""
    return T0_TIME + (slot * 2) // 5


class Synth:
    def __init__(self):
        self.curve, self.amm, self.T, self.W, self.F, self.E = [], [], [], [], [], []
        self.state = {}

    # ---- curve -------------------------------------------------------------------------------------------
    def create(self, slot, tx, mint, creator, name="Coin", symbol="CN", mayhem=0, cashback=0, quote=SOL, curve=None):
        self.state[mint] = [V0, T0, 0, R0]
        self.E.append({"event": "CreateEvent", "slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": 0,
                       "fields": {"mint": mint, "creator": creator, "user": creator, "name": name, "symbol": symbol,
                                  "bonding_curve": curve or ("curve_" + mint), "is_mayhem_mode": str(mayhem),
                                  "is_cashback_enabled": str(cashback), "quote_mint": quote, "token_program": T22,
                                  "virtual_quote_reserves": str(V0)}})

    def trade(self, slot, tx, mint, owner, sol=None, tokens=None, buy=True, post=None, mayhem=0, cashback=0,
              quote=SOL, fee_bps=95, creator_bps=30, ev=0):
        vs, vt, rs, rt = self.state[mint]
        if buy:
            tokens = min(sol * vt // (vs + sol), rt)
            sol = tokens * vs // (vt - tokens) + 1
            vs, vt, rs, rt = vs + sol, vt - tokens, rs + sol, rt - tokens
        else:
            sol = tokens * vs // (vt + tokens)
            vs, vt, rs, rt = vs - sol, vt + tokens, rs - sol, rt + tokens
        self.state[mint] = [vs, vt, rs, rt]
        self.curve.append({"slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": ev, "outer_ix": 0, "inner_ix": 0,
                           "mint": mint, "is_buy": int(buy), "sol_amount": sol, "token_amount": tokens,
                           "virtual_sol_reserves": vs, "virtual_token_reserves": vt, "real_sol_reserves": rs,
                           "real_token_reserves": rt, "fee_basis_points": fee_bps, "fee": -(-sol * fee_bps // 10_000),
                           "creator_fee_basis_points": creator_bps, "creator_fee": -(-sol * creator_bps // 10_000),
                           "mayhem_mode": mayhem, "cashback_fee_basis_points": 30 if cashback else 0, "quote_mint": quote,
                           "quote_amount": sol, "virtual_quote_reserves": vs, "real_quote_reserves": rs, "user": owner,
                           "user_token_owner": owner, "owner_token_post": -1 if post is None else post, "creator": "creator"})
        return tokens

    def buy_to(self, slot, tx, mint, owner, real_target):
        """One buy that takes real SOL to at least `real_target`."""
        vs, vt, rs, rt = self.state[mint]
        return self.trade(slot, tx, mint, owner, sol=max(real_target - rs + 2, 2))

    def complete(self, slot, tx, mint, pool, curve=None, init_boost=17_584_505_288):
        self.trade(slot, tx, mint, "completer", sol=10 ** 12)          # buys the rest
        f = {"mint": mint, "pool": pool, "bonding_curve": curve or ("curve_" + mint), "quote_mint": SOL,
             "pool_migration_fee": "15000001", "sol_amount": "84990359056", "mint_amount": "206900000000000"}
        self.E.append({"event": "CompleteEvent", "slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": 1,
                       "fields": {"mint": mint, "quote_mint": SOL}})
        self.E.append({"event": "CreatePoolEvent", "slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": 2,
                       "fields": {"pool": pool, "base_mint": mint, "pool_base_amount": "206900000000000",
                                  "pool_quote_amount": "84990359056"}})
        self.E.append({"event": "InitBoostEvent", "slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": 3,
                       "fields": {"pool": pool, "mint": mint, "real_quote_reserves_after": str(84_990_359_056 - init_boost),
                                  "virtual_quote_reserves": str(init_boost)}})
        self.E.append({"event": "CompletePumpAmmMigrationEvent", "slot": slot, "block_time": bt(slot), "tx_idx": tx,
                       "ev_idx": 4, "fields": f})
        self.pool = getattr(self, "pool", {})
        self.pool[pool] = [206_900_000_000_000, 84_990_359_056 - init_boost, init_boost]

    def pool_trade(self, slot, tx, pool, mint, owner, side, base=None, quote=None, bps=(2, 93, 30), boost=False, ev=0):
        b, q, v = self.pool[pool]
        eff = q + v
        if side == "buy":
            base = base if base is not None else (quote * b) // (eff + quote)
            quote = (eff * base + (b - base) - 1) // (b - base)
            lp = -(-quote * bps[0] // 10_000)
            nb, nq = b - base, q + quote + lp
        else:
            quote = eff * base // (b + base)
            lp = -(-quote * bps[0] // 10_000)
            nb, nq = b + base, q - quote + lp
        self.amm.append({"slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": ev, "outer_ix": 0, "inner_ix": 0,
                         "pool": pool, "base_mint": mint, "quote_mint": WSOL, "side": side, "base_amount": base,
                         "quote_amount": quote, "quote_amount_lp_adjusted": abs(nq - q), "pool_base_token_reserves": b,
                         "pool_quote_token_reserves": q, "virtual_quote_reserves": v, "lp_fee_basis_points": bps[0],
                         "protocol_fee_basis_points": bps[1], "coin_creator_fee_basis_points": bps[2], "lp_fee": lp,
                         "protocol_fee": -(-quote * bps[1] // 10_000), "coin_creator_fee": -(-quote * bps[2] // 10_000),
                         "min_base_amount_out": base if boost else 0, "ix_name": side, "base_supply": 10 ** 15,
                         "chain_pool_base": nb, "chain_pool_quote": nq, "user": owner, "user_token_owner": owner,
                         "canonical": 1, "protocol": 0, "signer": owner})
        self.pool[pool] = [nb, nq, v]
        if boost:
            self.E.append({"event": "BoostBuyAndBurnEvent", "slot": slot, "block_time": bt(slot), "tx_idx": tx, "ev_idx": 1,
                           "fields": {"pool": pool, "mint": mint, "quote_amount_in_used": str(quote), "quote_amount_in_requested": str(quote),
                                      "boost_vault_remaining": "1000", "base_amount_burned": str(base)}})
        return base

    def transfer(self, slot, tx, mint, a, b, amount, kind="transfer"):
        self.T.append({"slot": slot, "block_time": bt(slot), "tx_idx": tx, "outer_ix": 9, "inner_ix": 0, "mint": mint,
                       "kind": kind, "from_owner": a, "to_owner": b, "amount": amount})

    def sol_link(self, slot, a, b):
        self.W.append({"slot": slot, "block_time": bt(slot), "tx_idx": 0, "outer_ix": 0, "inner_ix": "", "from": a,
                       "to": b, "lamports": 10 ** 8, "signer": a, "signature": "s"})

    # ---- write -------------------------------------------------------------------------------------------
    def write(self, root, day, first, last, schema_v2=True):
        d = os.path.join(root, day, f"{first}-{last}", "research")
        os.makedirs(d, exist_ok=True)
        inr = lambda r: first <= r["slot"] <= last
        cols = {
            "S_curve": ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "mint", "is_buy", "sol_amount",
                        "token_amount", "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves",
                        "real_token_reserves", "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee",
                        "mayhem_mode", "cashback_fee_basis_points", "quote_mint", "quote_amount",
                        "virtual_quote_reserves", "real_quote_reserves", "user", "user_token_owner", "owner_token_post",
                        "creator"] + (["top_program"] if schema_v2 else []),
            "S_amm": list(self.amm[0].keys()) if self.amm else ["slot", "pool"],
            "T": ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner", "to_owner", "amount"],
            "W": ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "from", "to", "lamports", "signer", "signature"],
            "F": ["slot", "tx_idx", "pool_or_curve", "mint", "ix_name", "err_class", "amount_arg", "limit_arg"],
        }
        for name, rows in (("S_curve", self.curve), ("S_amm", self.amm), ("T", self.T), ("W", self.W), ("F", self.F)):
            df = pd.DataFrame([r for r in rows if inr(r)], columns=cols[name])
            df.to_csv(os.path.join(d, f"{name}.csv.zst"), index=False, compression="zstd")
        pd.DataFrame({"slot": range(first, last + 1), "block_time": [bt(s) for s in range(first, last + 1)]}) \
            .to_csv(os.path.join(d, "B.csv.zst"), index=False, compression="zstd")
        import zstandard
        with open(os.path.join(d, "E.jsonl.zst"), "wb") as fh:
            fh.write(zstandard.ZstdCompressor().compress("".join(json.dumps(e) + "\n" for e in self.E if inr(e)).encode()))
        with open(os.path.join(d, "stats.json"), "w") as f:
            json.dump({"day": day, "from_slot": first, "to_slot": last}, f)
        return d
