"""Small synthetic tape units in the shared tape's file format (CSV + zstd, JSON lines + zstd)."""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # the tape/ directory (w1)

import pandas as pd
import zstandard

from w1.addr import SYSTEM_PROGRAM, WSOL, on_curve
from w1.load import CURVE_COLS, AMM_COLS

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + s


def address(seed, curve=True):
    """A deterministic address that is on the ed25519 curve (a wallet) or off it (a PDA)."""
    rng = random.Random(f"{seed}-{curve}")
    while True:
        a = b58encode(bytes(rng.getrandbits(8) for _ in range(32)))
        if on_curve(a) == curve:
            return a


class Unit:
    def __init__(self, root, day, lo, hi):
        self.dir = os.path.join(root, day, f"{lo}-{hi}", "research")
        self.day, self.lo, self.hi = day, lo, hi
        self.c, self.a, self.t, self.w, self.e, self.cov = [], [], [], [], [], []
        self.bt0 = 1789000000

    def bt(self, slot):
        return self.bt0 + (slot - self.lo) * 2 // 5

    def curve(self, slot, tx, ev, owner, mint, is_buy, sol, tokens, vsr, vtr, rsr, rtr, pre, post, signer=None,
              tx_fee=5000, jito=0, fee=0, creator_fee=0, cashback=0, bps=(95, 30, 0), quote=SYSTEM_PROGRAM,
              spre=0, spost=0, protocol=0):
        self.c.append({"slot": slot, "block_time": self.bt(slot), "tx_idx": tx, "ev_idx": ev,
                       "signer": signer or owner, "tx_fee": tx_fee, "jito_tip": jito, "mint": mint,
                       "is_buy": int(is_buy), "sol_amount": sol, "token_amount": tokens, "user": signer or owner,
                       "virtual_sol_reserves": vsr, "virtual_token_reserves": vtr, "real_sol_reserves": rsr,
                       "real_token_reserves": rtr, "fee_basis_points": bps[0], "fee": fee,
                       "creator_fee_basis_points": bps[1], "creator_fee": creator_fee,
                       "cashback_fee_basis_points": bps[2], "cashback": cashback, "quote_mint": quote,
                       "ix_name": "buy" if is_buy else "sell", "user_token_owner": owner, "owner_token_pre": pre,
                       "owner_token_post": post, "signer_sol_pre": spre, "signer_sol_post": spost,
                       "protocol": protocol})

    def amm(self, slot, tx, ev, owner, mint, pool, side, base, user_quote, pre_base, pre_quote, virtual, pre, post,
            signer=None, tx_fee=5000, jito=0, canonical=1, lp_adj=None, bps=(20, 5, 5, 0), quote=WSOL):
        lp_adj = user_quote if lp_adj is None else lp_adj
        self.a.append({"slot": slot, "block_time": self.bt(slot), "tx_idx": tx, "ev_idx": ev, "signer": signer or owner,
                       "tx_fee": tx_fee, "jito_tip": jito, "pool": pool, "base_mint": mint, "quote_mint": quote,
                       "side": side, "base_amount": base, "quote_amount": user_quote, "user": signer or owner,
                       "pool_base_token_reserves": pre_base, "pool_quote_token_reserves": pre_quote,
                       "lp_fee_basis_points": bps[0], "protocol_fee_basis_points": bps[1],
                       "coin_creator_fee_basis_points": bps[2], "cashback_fee_basis_points": bps[3],
                       "quote_amount_lp_adjusted": lp_adj, "user_quote_amount": user_quote,
                       "virtual_quote_reserves": virtual, "ix_name": "buy" if side == "buy" else "",
                       "user_token_owner": owner, "owner_token_pre": pre, "owner_token_post": post,
                       "signer_sol_pre": 0, "signer_sol_post": 0, "canonical": canonical, "protocol": 0})

    def transfer(self, slot, tx, mint, frm, to, amount, kind="transfer"):
        self.t.append({"slot": slot, "block_time": self.bt(slot), "tx_idx": tx, "outer_ix": 0, "inner_ix": "",
                       "mint": mint, "kind": kind, "from_owner": frm, "to_owner": to, "amount": amount,
                       "from_account": "", "to_account": ""})

    def sol(self, slot, frm, to, lamports=10**8):
        self.w.append({"slot": slot, "block_time": self.bt(slot), "tx_idx": 0, "outer_ix": 0, "inner_ix": "",
                       "from": frm, "to": to, "lamports": lamports, "signer": frm, "signature": "x"})

    def event(self, name, slot, tx, fields, ev=0):
        self.e.append({"slot": slot, "block_time": self.bt(slot), "tx_idx": tx, "ev_idx": ev, "event": name,
                       "fields": {k: str(v) for k, v in fields.items()}, "signer": "", "program": "pump"})

    def unresolved(self, mint, slot, reason="owner_change"):
        self.cov.append({"mint": mint, "scope": "unresolved", "slot": slot, "reason": reason, "count": 1,
                         "tx_idx": 0})

    def write(self):
        os.makedirs(self.dir, exist_ok=True)
        tabs = {"S_curve": (self.c, CURVE_COLS), "S_amm": (self.a, AMM_COLS),
                "T": (self.t, ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner",
                               "to_owner", "amount", "from_account", "to_account"]),
                "W": (self.w, ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "from", "to", "lamports",
                               "signer", "signature"]),
                "T_coverage": (self.cov, ["mint", "scope", "slot", "reason", "count", "tx_idx"])}
        for name, (rows, cols) in tabs.items():
            pd.DataFrame(rows, columns=cols).to_csv(os.path.join(self.dir, name + ".csv.zst"), index=False,
                                                    compression="zstd")
        buf = "".join(json.dumps(e) + "\n" for e in self.e).encode()
        with open(os.path.join(self.dir, "E.jsonl.zst"), "wb") as f:
            f.write(zstandard.ZstdCompressor().compress(buf))
        return self.dir
