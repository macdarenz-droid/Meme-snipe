"""Tiny synthetic tapes for the unit tests. Addresses are int codes; the codec only needs its length."""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from d1 import config as C  # noqa: E402
from d1.costs import fee_of  # noqa: E402
from d1.load import Codec, Tape, Unit  # noqa: E402

DAY = "2026-09-10"
T0 = C.epoch(DAY) + 3 * 3600          # 03:00 UTC
S0 = 400_000_000
SLOTS_PER_S = 2                       # block_time = T0 + (slot - S0) // 2


def bt_of(slot):
    return T0 + (np.asarray(slot) - S0) // SLOTS_PER_S


def slot_at(t):
    return S0 + (t - T0) * SLOTS_PER_S


class AmmSim:
    """Generates canonical PumpSwap rows with exact reserve bookkeeping (reserves before the trade)."""

    def __init__(self, pool, mint, base, vault, virt=0, fees=(20, 5, 95), supply=10**15, creator=90):
        self.pool, self.mint = pool, mint
        self.base, self.vault, self.virt = base, vault, virt
        self.fees, self.supply, self.creator = fees, supply, creator
        self.rows = []
        self.tx = 0

    def trade(self, slot, side, amount, owner=-1, app=0, pre=-1, post=-1, boost=0, protocol=0):
        lp, pr, cr = self.fees
        base_b, vault_b = self.base, self.vault
        eff = self.vault + self.virt
        if side == "buy":
            q = amount
            b = self.base * q // (eff + q)
            lpf, prf, crf = fee_of(q, lp), fee_of(q, pr), fee_of(q, cr)
            adj, user = q + lpf, q + lpf + prf + crf
            self.base -= b
            self.vault += adj
            sgn = 1
        else:
            b = amount
            q = eff * b // (self.base + b)
            lpf, prf, crf = fee_of(q, lp), fee_of(q, pr), fee_of(q, cr)
            adj, user = q - lpf, q - lpf - prf - crf
            self.base += b
            self.vault -= adj
            sgn = -1
        self.tx += 1
        self.rows.append(dict(slot=slot, block_time=int(bt_of(slot)), tx_idx=self.tx, ev_idx=0, outer_ix=0, inner_ix=-1,
                              pool=self.pool, mint=self.mint, side=sgn, base_amount=b, quote_amount=q, quote_lp_adj=adj,
                              user_quote=user, base_before=base_b, vault_before=vault_b, virt=self.virt, lp_bps=lp,
                              protocol_bps=pr, creator_bps=cr, coin_creator=self.creator, supply=self.supply,
                              owner=owner, owner_pre=pre, owner_post=post, app_routed=app,
                              signature=f"s{self.pool}-{self.tx}", boost=boost, protocol=protocol))
        return b

    def df(self):
        d = pd.DataFrame(self.rows)
        d["base_after"] = d.base_before - d.side * d.base_amount
        d["vault_after"] = d.vault_before + d.side * d.quote_lp_adj
        return d


def empty(cols):
    return pd.DataFrame({c: pd.Series(dtype=np.int64) for c in cols})


def make_tape(amm: pd.DataFrame, slot_lo: int, slot_hi: int, migs=(), creates=(), buys=None, curve=None, t=None, w=None,
              f=None, cf=None, boost=None, segs=None, n_codes=1000, v1=(), extra_ev=None):
    slots = np.arange(slot_lo, slot_hi + 1)
    b = pd.DataFrame({"slot": slots, "block_time": bt_of(slots)})
    codec = Codec()
    codec.names = [f"a{i}" for i in range(n_codes)]
    ev = {
        "CompletePumpAmmMigrationEvent": pd.DataFrame(list(migs), columns=["slot", "signature", "mint", "pool", "bonding_curve", "quote_mint"]),
        "CreatePoolEvent": pd.DataFrame([(m[0], m[1], m[3], m[2], C.WSOL, 0, 85 * 10**9, 206_900_000_000_000) for m in migs],
                                        columns=["slot", "signature", "pool", "base_mint", "quote_mint", "is_mayhem_mode",
                                                 "pool_quote_amount", "pool_base_amount"]),
        "CreateEvent": pd.DataFrame([tuple(c) + (C.TOKEN_2022_PROGRAM, 0)[len(c) - 8:] for c in creates],
                                    columns=["slot", "signature", "mint", "creator", "user", "bonding_curve", "is_mayhem_mode",
                                             "quote_mint", "token_program", "is_cashback_enabled"]),
        "CompleteEvent": empty(["slot", "signature", "mint"]),
        "DepositEvent": empty(["slot", "signature", "pool", "lp_token_amount_out"]),
        "WithdrawEvent": empty(["slot", "signature", "pool", "lp_token_amount_in"]),
        "ExtendAccountEvent": empty(["slot", "signature", "account", "new_size"]),
        "InitBoostEvent": empty(["slot", "signature", "pool", "mint"]),
        "BoostBuyAndBurnEvent": boost if boost is not None else empty(["slot", "signature", "pool", "mint", "boost_vault_remaining"]),
    }
    if buys is None:
        a = amm[amm.side == 1]
        buys = pd.DataFrame({"slot": a.slot, "tx_idx": a.tx_idx, "ev_idx": a.ev_idx, "venue": 1, "mint": a.mint,
                             "owner": a.owner, "sol": a.quote_amount.astype(float)})
    unit = Unit(path="synthetic", day=DAY, from_slot=slot_lo, to_slot=slot_hi)
    return Tape(units=[unit], days=(DAY,), segs=segs or [(slot_lo, slot_hi)], codec=codec, b=b,
                amm=amm.sort_values(["slot", "tx_idx", "ev_idx"]).reset_index(drop=True),
                buys=buys.sort_values(["slot", "tx_idx", "ev_idx"]).reset_index(drop=True),
                curve=curve if curve is not None else empty(["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "mint", "is_buy", "sol_amount", "token_amount", "fee", "creator_fee", "sol_quote", "mayhem", "owner", "owner_pre", "owner_post"]),
                t=t if t is not None else empty(["slot", "tx_idx", "outer_ix", "inner_ix", "mint", "pump_mint", "kind", "src", "dst", "amount"]),
                w=w if w is not None else empty(["slot", "src", "dst"]),
                f=f if f is not None else empty(["slot", "block_time", "pool"]),
                cf=cf if cf is not None else empty(["slot", "block_time", "creator"]),
                ev={**ev, **(extra_ev or {})}, schema_v1_slots=list(v1))


POOL, MINT, CURVE = 1, 2, 3


def standard(minutes=150, every_s=20, seed=0, mig_offset_s=60):
    """One pool migrated at T0 + mig_offset_s, trading every `every_s` seconds for `minutes`; buyers 100.., sellers 300.."""
    rng = np.random.default_rng(seed)
    sim = AmmSim(POOL, MINT, base=206_900_000_000_000, vault=67_400_000_000, virt=17_600_000_000)
    mig_slot = int(slot_at(T0 + mig_offset_s))
    held = {}
    for k, t in enumerate(range(T0 + mig_offset_s + 5, T0 + minutes * 60, every_s)):
        s = int(slot_at(t))
        if rng.random() < 0.6 or not held:
            o = 100 + int(rng.integers(0, 40))
            b = sim.trade(s, "buy", int(rng.integers(1, 30)) * 10**8, owner=o, app=int(rng.random() < 0.5))
            held[o] = held.get(o, 0) + b
        else:
            o = list(held)[int(rng.integers(0, len(held)))]
            amt = held.pop(o)
            sim.trade(s, "sell", amt, owner=o, app=int(rng.random() < 0.5))
    amm = sim.df()
    migs = [(mig_slot, "sigm", MINT, POOL, CURVE, C.SYSTEM_PROGRAM)]
    lo = int(slot_at(T0))
    hi = int(slot_at(T0 + minutes * 60 + 600))
    return sim, amm, migs, mig_slot, lo, hi
