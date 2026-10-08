"""The bot's gates as of each decision, for the H8-tradable subset (research/brainstorm-loop/H8_AMENDMENT_2.md items 1-2,
AMENDMENT_3). Each gate is 1 (pass), 0 (reject) or -1 (unknown: the tape lacks the evidence; missing evidence is
never a pass, as in the bot, where it is an H16 reject).

Sources (packages/core/src):
- universe tag: U2 = 60-240 min after migration (config/research.ts s0.u2Window*), U1 = 24 h-14 days with market cap
  >= 1,470 SOL (docs/ARCHITECTURE.md §3.2); 4-24 h has no tag, so it is never tradable (H8_AMENDMENT_2 item 1).
- H8 floor (gates/hard.ts liquidityFloor): max($15k, 1,000 x size); U1 at least $50k. Applied in h8.add_h8.
- dust (hard.ts h8): the quote put in the pool at migration (CreatePoolEvent pool_quote_amount) >= 5 SOL.
- H6 (hard.ts h6): no LP outstanding. Migration LP is burned, so outstanding = LP minted by DepositEvents minus LP
  burned by WithdrawEvents on the pool up to d.
- H9 (hard.ts h9): graduation (CompleteEvent) at least 5 min after creation (CreateEvent); unknown without both rows.
- H11 (hard.ts h11): no 1-minute candle starting in the last 3 minutes with high > open x 1.25 (all universes, as
  the bot); for U2 also the close of the last candle ending by migration + 5 min not above the migration price.
  Candles as facts/producer.ts #addTrade: by trade minute, open = pre-trade price of the first trade, high = max of
  pre and post prices, close = last post price (prices on effective reserves).
- H17 (hard.ts h17, tx/shape.ts checkShape): mint program SPL Token or Token-2022 (from the create row), not a
  cashback coin (create row), pool account >= 300 bytes (the pool's last ExtendAccountEvent up to d), coin creator
  read. Mint extensions: pump creates carry only MetadataPointer and TokenMetadata (shape.ts), so a create row on the
  tape counts as supported (OPEN_QUESTIONS #36).
- H12 and H13 are computed with the holder book in holders.py.
"""
from typing import Dict

import numpy as np
import pandas as pd

from . import config as C
from .load import Tape
from .pool_state import PoolBook
from .universe import Clock

PASS, REJECT, UNKNOWN = 1, 0, -1
GATES = ("gate_dust", "gate_h6", "gate_h9", "gate_h11_spike", "gate_h11_chase", "gate_h12", "gate_h13", "gate_h17")


def universe_tag(age_s: float, mcap_sol: float) -> str:
    if C.U2_FROM_S <= age_s <= C.U2_TO_S:
        return "U2"
    if C.U1_FROM_S <= age_s <= C.U1_TO_S and mcap_sol >= C.U1_MIN_MCAP_SOL:
        return "U1"
    return "none"


def floor_for(tag: str, size_usd: float) -> float:
    if tag == "U2":
        return max(C.H8_MIN_QUOTE_USD, C.H8_SIZE_MULTIPLE * size_usd)
    if tag == "U1":
        return max(C.H8_U1_FLOOR_USD, C.H8_SIZE_MULTIPLE * size_usd)
    return float("inf")


def _candles(r, lo: int, hi: int):
    """1-minute candles from pool rows lo..hi-1 (start, open, high, close)."""
    out = []
    base_b = np.maximum(r["base_before"][lo:hi], 1).astype(float)
    pre = (r["vault_before"][lo:hi] + r["virt"][lo:hi]).astype(float) / base_b
    post = (r["vault_after"][lo:hi] + r["virt"][lo:hi]).astype(float) / np.maximum(r["base_after"][lo:hi], 1)
    start = (r["block_time"][lo:hi] // 60) * 60
    for k in range(hi - lo):
        if out and out[-1][0] == start[k]:
            s, o, h, _ = out[-1]
            out[-1] = (s, o, max(h, pre[k], post[k]), post[k])
        else:
            out.append((start[k], pre[k], max(pre[k], post[k]), post[k]))
    return out


def spike(r, i_d: int, tau: int) -> int:
    """H11 spike: a candle with start <= tau and start + 60 > tau - 180 whose high > open x 1.25."""
    lo = int(np.searchsorted(np.maximum.accumulate(r["block_time"]), tau - C.H11_SPIKE_WINDOW_S - 60, side="left"))
    for s, o, h, _ in _candles(r, lo, i_d + 1):
        if s <= tau and s + 60 > tau - C.H11_SPIKE_WINDOW_S and h * 10_000 > o * (10_000 + C.H11_SPIKE_BPS):
            return REJECT
    return PASS


def chase(r, i_d: int, mig_time: int, mig_price: float) -> int:
    """H11 chase (U2): the close of the last candle ending by migration + 5 min must not be above the migration price."""
    if not np.isfinite(mig_price) or mig_price <= 0:
        return UNKNOWN
    at = mig_time + C.H11_CHASE_AFTER_S
    hi = int(np.searchsorted(np.maximum.accumulate(r["block_time"]), at, side="left"))
    last = None
    for c in _candles(r, 0, min(hi, i_d + 1)):
        if c[0] + 60 <= at:
            last = c
    if last is None or last[0] + 60 <= mig_time:
        return UNKNOWN
    return REJECT if last[3] > mig_price else PASS


def pool_facts(tape: Tape) -> Dict[str, dict]:
    ce = tape.ev["CreateEvent"].drop_duplicates("mint").set_index("mint")
    co = tape.ev["CompleteEvent"].drop_duplicates("mint").set_index("mint")
    mg = tape.ev["CompletePumpAmmMigrationEvent"]
    cp = tape.ev["CreatePoolEvent"]
    return {"create": ce, "complete": co, "migration": mg, "create_pool": cp,
            "deposit": tape.ev["DepositEvent"], "withdraw": tape.ev["WithdrawEvent"],
            "extend": tape.ev["ExtendAccountEvent"]}


def gate_frame(tape: Tape, book: PoolBook, el: pd.DataFrame, clock: Clock) -> pd.DataFrame:
    """Pool and price gates (dust, H6, H9, H11, H17) for the eligible points of `el` (index kept)."""
    pf = pool_facts(tape)
    ce, co, mg, cp = pf["create"], pf["complete"], pf["migration"], pf["create_pool"]
    out = pd.DataFrame(UNKNOWN, index=el.index, columns=["gate_dust", "gate_h6", "gate_h9", "gate_h11_spike",
                                                         "gate_h11_chase", "gate_h17"], dtype=np.int64)
    for (pool, mint), g in el.groupby(["pool", "mint"], sort=False):
        r = book.rows[pool]
        m = mg[mg.pool == pool]
        sig = m.signature.iloc[0] if len(m) else None
        c = cp[(cp.pool == pool) & (cp.signature == sig)] if sig is not None else cp.iloc[:0]
        q_mig = float(c.pool_quote_amount.iloc[0]) if len(c) else np.nan
        b_mig = float(c.pool_base_amount.iloc[0]) if len(c) else np.nan
        dust = UNKNOWN if not np.isfinite(q_mig) or q_mig < 0 else (PASS if q_mig >= C.DUST_MIN_AT_MIGRATION else REJECT)
        mig_price = q_mig / b_mig if np.isfinite(q_mig) and np.isfinite(b_mig) and b_mig > 0 else np.nan
        dep = pf["deposit"][pf["deposit"].pool == pool]
        wd = pf["withdraw"][pf["withdraw"].pool == pool]
        ext = pf["extend"][pf["extend"].account == pool]
        h9 = UNKNOWN
        if mint in ce.index and mint in co.index:
            took = int(clock.slot_time(int(co.at[mint, "slot"]))) - int(clock.slot_time(int(ce.at[mint, "slot"])))
            h9 = PASS if took >= C.H9_MIN_GRADUATION_S else REJECT
        tp = ce.at[mint, "token_program"] if mint in ce.index else None
        cb = int(ce.at[mint, "is_cashback_enabled"]) if mint in ce.index else -1
        for ix, d, tau, mt in zip(g.index, g.d.to_numpy(), g.tau.to_numpy(), g.mig_time.to_numpy()):
            i_d = int(book.idx_le(pool, d))
            outstanding = int(dep.loc[dep.slot <= d, "lp_token_amount_out"].clip(lower=0).sum()) - int(
                wd.loc[wd.slot <= d, "lp_token_amount_in"].clip(lower=0).sum())
            e = ext[ext.slot <= d]
            size = int(e.new_size.iloc[-1]) if len(e) else -1
            if tp is None or cb < 0 or size < 0 or int(r["coin_creator"][i_d]) < 0:
                h17 = UNKNOWN
            elif tp not in (C.SPL_TOKEN_PROGRAM, C.TOKEN_2022_PROGRAM) or cb == 1 or size < C.POOL_ACCOUNT_MIN_BYTES:
                h17 = REJECT
            else:
                h17 = PASS
            out.loc[ix] = [dust, PASS if outstanding <= 0 else REJECT, h9, spike(r, i_d, int(tau)),
                           chase(r, i_d, int(mt), mig_price), h17]
    return out
