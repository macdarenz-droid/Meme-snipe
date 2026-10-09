"""As-of state of each canonical WSOL PumpSwap pool, from its own trade rows.

PumpSwap rows carry reserves BEFORE the trade (docs/research/historical-data.md). After the trade: base -/+ base_amount,
vault +/- quote_amount_lp_adjusted, virtual unchanged (checked exactly against the next row's before-state on a
discovery unit: 100% match). The state "at the end of slot s" is the after-state of the last row with slot <= s;
"at the start of slot s" is the after-state of the last row with slot < s. Changes outside trades (deposit,
withdraw, InitBoost moving vault into virtual) are seen only at the next trade; see OPEN_QUESTIONS.md.
"""
from typing import Dict, Optional

import numpy as np
import pandas as pd

from . import config as C
from .costs import Pool


BOOK_COLS = ["slot", "block_time", "side", "base_amount", "quote_amount", "user_quote", "base_before", "vault_before",
             "base_after", "vault_after", "virt", "lp_bps", "protocol_bps", "creator_bps", "supply", "owner",
             "coin_creator", "app_routed", "tx_idx", "ev_idx", "mint", "outer_ix", "inner_ix", "owner_pre",
             "owner_post", "boost", "protocol"]


class PoolBook:
    def __init__(self, amm: pd.DataFrame):
        self.rows: Dict[int, Dict[str, np.ndarray]] = {}
        if len(amm) == 0:
            return
        amm = amm.sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="mergesort")
        cols = BOOK_COLS
        arrs = {c: amm[c].to_numpy() for c in cols}
        self._split(arrs, amm.pool.to_numpy())

    @classmethod
    def consume(cls, tape, pools=None) -> "PoolBook":
        """Low-memory twin of PoolBook(tape.amm): the same rows in the same order (the same stable sort by pool,
        slot, tx_idx, ev_idx), but each column of tape.amm is reordered into the book and freed in turn, so the peak
        is the table plus one column instead of two copies. tape.amm is left empty. `pools`: hold only these pools
        (their rows and order are unchanged; for a caller that reads no other pool)."""
        amm = tape.amm
        tape.amm = amm.iloc[:0].copy()
        self = cls.__new__(cls)
        self.rows = {}
        if len(amm) == 0:
            return self
        sel = None
        if pools is not None:
            sel = np.flatnonzero(np.isin(amm.pool.to_numpy(), np.fromiter((int(p) for p in pools), dtype=np.int64)))
        take = (lambda a: a) if sel is None else (lambda a: a[sel])
        order = np.lexsort((take(amm.ev_idx.to_numpy()), take(amm.tx_idx.to_numpy()), take(amm.slot.to_numpy()),
                            take(amm.pool.to_numpy())))
        pool_col = take(amm.pool.to_numpy())[order]
        arrs = {}
        for c in BOOK_COLS:
            arrs[c] = take(amm[c].to_numpy())[order]
            del amm[c]
        del amm, order, sel
        if len(pool_col):
            self._split(arrs, pool_col)
            if pools is not None:
                for r in self.rows.values():
                    _widen(r)
        return self

    def prune(self, pools) -> None:
        """Drop every pool not in `pools` (for a caller that reads no other pool). The kept pools' rows are copied
        out of the shared column arrays one column at a time, so those arrays are freed; their values are unchanged,
        and columns the low-memory reader held as int32 are widened back to int64."""
        keep = {int(p) for p in pools}
        for p in [p for p in self.rows if p not in keep]:
            del self.rows[p]
        for c in BOOK_COLS:
            for r in self.rows.values():
                r[c] = r[c].astype(np.int64) if r[c].dtype != np.int64 else r[c].copy()
        for r in self.rows.values():
            _widen(r)

    def _split(self, arrs: Dict[str, np.ndarray], pools: np.ndarray):
        cols = BOOK_COLS
        starts = np.flatnonzero(np.r_[True, pools[1:] != pools[:-1]])
        ends = np.r_[starts[1:], len(pools)]
        for s, e in zip(starts, ends):
            r = {c: arrs[c][s:e] for c in cols}
            r["fee_lp"], r["fee_protocol"], r["fee_creator"] = _paid_fee_rates(r)
            self.rows[int(pools[s])] = r

    def pools(self):
        return self.rows.keys()

    def idx_le(self, pool: int, slots) -> np.ndarray:
        """Index of the last row with slot <= s (or -1)."""
        r = self.rows.get(pool)
        if r is None:
            return np.full(np.shape(slots), -1)
        return np.searchsorted(r["slot"], slots, side="right") - 1

    def idx_lt(self, pool: int, slots) -> np.ndarray:
        r = self.rows.get(pool)
        if r is None:
            return np.full(np.shape(slots), -1)
        return np.searchsorted(r["slot"], slots, side="left") - 1

    def state(self, pool: int, i: int) -> Optional[Pool]:
        if i < 0:
            return None
        r = self.rows[pool]
        return Pool(int(r["base_after"][i]), int(r["vault_after"][i]), int(r["virt"][i]),
                    int(r["fee_lp"][i]), int(r["fee_protocol"][i]), int(r["fee_creator"][i]))

    def eff_after(self, pool: int) -> np.ndarray:
        r = self.rows[pool]
        return r["vault_after"] + r["virt"]

    def mid_after(self, pool: int) -> np.ndarray:
        r = self.rows[pool]
        return (r["vault_after"] + r["virt"]).astype(float) / np.maximum(r["base_after"], 1).astype(float)

    def mid_before_first(self, pool: int) -> float:
        r = self.rows[pool]
        return float(r["vault_before"][0] + r["virt"][0]) / float(max(r["base_before"][0], 1))


def _widen(r):
    """Integer arrays the low-memory reader narrowed go back to int64, the dtype every reader of the book had."""
    for c, a in r.items():
        if a.dtype.kind == "i" and a.dtype != np.int64:
            r[c] = a.astype(np.int64)


def _paid_fee_rates(r):
    """Fee rates our fill pays on the state after row i (red team R2-2, R2-11). BOOST slices and protocol swaps carry
    fee fields of 0 (they pay no venue fee), so they never set the rate: row i uses the rates of the last fee-paying
    row at or before it (a non-BOOST, non-protocol row with a non-zero total rate). Before the pool's first such row,
    nothing is known yet, so the dearest tier (config.FALLBACK_FEE_BPS) applies; a later row is never read."""
    lp, pr, cr = r["lp_bps"], r["protocol_bps"], r["creator_bps"]
    paid = ((lp + pr + cr) > 0) & (r["boost"] == 0) & (r["protocol"] == 0)
    n = len(paid)
    last = np.maximum.accumulate(np.where(paid, np.arange(n), -1)) if n else np.zeros(0, dtype=np.int64)
    idx = np.maximum(last, 0)
    fl, fp, fc = C.FALLBACK_FEE_BPS
    known = last >= 0
    return (np.where(known, lp[idx], fl), np.where(known, pr[idx], fp), np.where(known, cr[idx], fc))


def flow_rows(r) -> np.ndarray:
    """Rows that count as market flow. BOOST swaps (signature in BoostBuyAndBurnEvent) and protocol swaps are left out
    when config.EXCLUDE_PROTOCOL_SWAPS (CONSERVATIVE, OPEN_QUESTIONS #21). Pool state and prices use every row."""
    if not C.EXCLUDE_PROTOCOL_SWAPS:
        return np.ones(len(r["slot"]), dtype=bool)
    return (r["boost"] == 0) & (r["protocol"] == 0)
