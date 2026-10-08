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

from .costs import Pool


class PoolBook:
    def __init__(self, amm: pd.DataFrame):
        self.rows: Dict[int, Dict[str, np.ndarray]] = {}
        if len(amm) == 0:
            return
        amm = amm.sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="mergesort")
        cols = ["slot", "block_time", "side", "base_amount", "quote_amount", "user_quote", "base_before", "vault_before",
                "base_after", "vault_after", "virt", "lp_bps", "protocol_bps", "creator_bps", "supply", "owner",
                "coin_creator", "app_routed", "tx_idx", "ev_idx", "mint", "outer_ix", "inner_ix", "owner_pre",
                "owner_post"]
        arrs = {c: amm[c].to_numpy() for c in cols}
        pools = amm.pool.to_numpy()
        starts = np.flatnonzero(np.r_[True, pools[1:] != pools[:-1]])
        ends = np.r_[starts[1:], len(pools)]
        for s, e in zip(starts, ends):
            self.rows[int(pools[s])] = {c: arrs[c][s:e] for c in cols}

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
                    int(r["lp_bps"][i]), int(r["protocol_bps"][i]), int(r["creator_bps"][i]))

    def eff_after(self, pool: int) -> np.ndarray:
        r = self.rows[pool]
        return r["vault_after"] + r["virt"]

    def mid_after(self, pool: int) -> np.ndarray:
        r = self.rows[pool]
        return (r["vault_after"] + r["virt"]).astype(float) / np.maximum(r["base_after"], 1).astype(float)

    def mid_before_first(self, pool: int) -> float:
        r = self.rows[pool]
        return float(r["vault_before"][0] + r["virt"][0]) / float(max(r["base_before"][0], 1))
