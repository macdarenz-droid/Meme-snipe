"""Market state at slot boundaries, for the outcome and gate stages (they may read past the decision).

Curve trade reserves are after the trade; PumpSwap reserves are before the trade (PREREG §7 check 2; see
checks.py). The state at the start of slot s is the state after the last row before s; at the end of s, after
the last row in s. BOOST slices are the S_amm rows in a transaction that emitted a BoostBuyAndBurnEvent on that
pool, in every schema version; the S_amm `protocol` column is never read (it is unset on BOOST rows before decoder
v3). Protocol rows = BOOST slices plus rows whose signer or user is the buyback authority (the decoder's rule)."""
from typing import Dict, Optional

import numpy as np
import pandas as pd

from . import params as P
from .load import Tape
from .quotes import CurveState, Fees, PoolState



def _load_tiers():
    import json
    import os
    with open(os.path.join(P.HERE, "..", "..", "edge", "snapshot", "fee-configs.json")) as f:
        tiers = json.load(f)["amm"]["fee_tiers"]
    return [(int(t["market_cap_lamports_threshold"]),
             Fees(int(t["fees"]["lp_fee_bps"]), int(t["fees"]["protocol_fee_bps"]), int(t["fees"]["creator_fee_bps"])))
            for t in tiers]


AMM_TIERS = _load_tiers()


def fallback_tier(state: Optional[PoolState], base_supply: int) -> Fees:
    """Amendment 3 (OQ-16): when no trade shows the rate, the snapshot tier at market cap
    effective quote × base_supply ÷ base (pump-fees calculate_fee_tier: below the first threshold the first tier,
    otherwise the last tier whose threshold is <= the market cap)."""
    if state is None or state.base <= 0:
        return AMM_TIERS[0][1]
    mc = state.effective_quote * base_supply // state.base
    chosen = AMM_TIERS[0][1]
    for th, f in AMM_TIERS:
        if mc >= th:
            chosen = f
    return chosen


class Market:
    def __init__(self, tape: Tape):
        self.tape = tape
        ev = tape.events
        bb = ev["BoostBuyAndBurnEvent"]
        keys = set(zip(bb.get("slot", []), bb.get("tx_idx", []), bb.get("pool_c", []))) if len(bb) else set()
        pr = tape.pool_rows
        auth = tape.names.get(P.BUYBACK_AUTHORITY)
        if len(pr):
            pr["is_boost"] = [(s, t, p) in keys for s, t, p in zip(pr["slot"], pr["tx_idx"], pr["pool"])]
            # the decoder's buyback-authority rule (tapedec decode.go: signer or user is the authority)
            pr["is_buyback"] = ((pr["signer"] == auth) | (pr["user_c"] == auth)).to_numpy() if auth >= 0 else False
            pr["is_protocol"] = pr["is_boost"] | pr["is_buyback"]
        else:
            for c in ("is_boost", "is_buyback", "is_protocol"):
                pr[c] = pd.Series(dtype=bool)
        self.mig: Dict[int, dict] = {}
        mg = ev["CompletePumpAmmMigrationEvent"]
        for r in mg.sort_values("slot").to_dict("records"):
            self.mig.setdefault(r["mint_c"], r)
        self.complete: Dict[int, int] = {}
        ce = ev["CompleteEvent"]
        for r in ce.sort_values("slot").itertuples(index=False):
            self.complete.setdefault(r.mint_c, int(r.slot))
        self.pool_init: Dict[int, PoolState] = {}
        cp = ev["CreatePoolEvent"]
        for r in cp.sort_values("slot").to_dict("records"):
            if r["pool_c"] not in self.pool_init:
                self.pool_init[r["pool_c"]] = PoolState(int(r["pool_base_amount"]), int(r["pool_quote_amount"]), 0)
        ib = ev["InitBoostEvent"]
        self.boost_budget: Dict[int, int] = {}
        for r in ib.sort_values("slot").to_dict("records"):
            p = r["pool_c"]
            base = self.pool_init[p].base if p in self.pool_init else 0
            self.pool_init[p] = PoolState(base, int(r["real_quote_reserves_after"]), int(r["virtual_quote_reserves"]))
            self.boost_budget.setdefault(p, int(r["virtual_quote_reserves"]))

    # ---- curve ------------------------------------------------------------------------------------------
    def completion_slot(self, mint: int) -> Optional[int]:
        c = self.complete.get(mint)
        rows = self.tape.curve_of(mint)
        done = rows[rows["real_token_reserves"] <= 0]
        s = int(done["slot"].iloc[0]) if len(done) else None
        cands = [x for x in (c, s) if x is not None]
        return min(cands) if cands else None

    @staticmethod
    def _curve_state(r) -> CurveState:
        return CurveState(int(r["virtual_token_reserves"]), int(r["virtual_sol_reserves"]),
                          int(r["real_token_reserves"]), int(r["real_sol_reserves"]))

    def curve_rows_before(self, mint: int, slot: int, inclusive: bool) -> pd.DataFrame:
        rows = self.tape.curve_of(mint)
        k = np.searchsorted(rows["slot"].to_numpy(), slot, "right" if inclusive else "left")
        return rows.iloc[:k]

    def curve_state(self, mint: int, slot: int, end: bool) -> Optional[CurveState]:
        rows = self.curve_rows_before(mint, slot, inclusive=end)
        return self._curve_state(rows.iloc[-1]) if len(rows) else None

    def curve_fees(self, mint: int, slot: int) -> Fees:
        """The curve fee from the neighbouring trades' fee fields (PREREG §4): the last trade before the slot and the
        trades in it; the highest total rate (OQ-3)."""
        rows = self.tape.curve_of(mint)
        sl = rows["slot"].to_numpy()
        a = np.searchsorted(sl, slot, "left")
        b = np.searchsorted(sl, slot, "right")
        cand = rows.iloc[max(a - 1, 0):b]
        if not len(cand):
            return Fees(0, 95, 30)
        tot = cand["fee_basis_points"].clip(lower=0) + cand["creator_fee_basis_points"].clip(lower=0)
        r = cand.iloc[int(np.argmax(tot.to_numpy()))]
        return Fees(0, max(int(r["fee_basis_points"]), 0), max(int(r["creator_fee_basis_points"]), 0))

    # ---- pool -------------------------------------------------------------------------------------------
    def pool_rows_before(self, pool: int, slot: int, inclusive: bool) -> pd.DataFrame:
        rows = self.tape.pool_of(pool)
        k = np.searchsorted(rows["slot"].to_numpy(), slot, "right" if inclusive else "left")
        return rows.iloc[:k]

    def pool_state(self, pool: int, slot: int, end: bool) -> Optional[PoolState]:
        rows = self.pool_rows_before(pool, slot, inclusive=end)
        if len(rows):
            r = rows.iloc[-1]
            if int(r["after_base"]) < 0 or int(r["after_quote"]) < 0:
                return None
            return PoolState(int(r["after_base"]), int(r["after_quote"]), int(r["after_virtual"]))
        return self.pool_init.get(pool)

    def pool_fees(self, pool: int, slot: int):
        """The fee tier the program applied, from the neighbouring non-BOOST trades' fee fields on the pool (PREREG §2,
        §4 exit A): the last trade before the slot and the trades in it; the highest total rate. Returns (fees, source)."""
        rows = self.tape.pool_of(pool)
        if len(rows):
            rows = rows[~rows["is_boost"].to_numpy()]
        sl = rows["slot"].to_numpy() if len(rows) else np.empty(0)
        a = np.searchsorted(sl, slot, "left")
        b = np.searchsorted(sl, slot, "right")
        cand = rows.iloc[max(a - 1, 0):b] if len(rows) else rows
        if not len(cand):
            allr = self.tape.pool_of(pool)
            sup = allr[allr["slot"] <= slot]["base_supply"] if len(allr) else []
            supply = int(sup.iloc[-1]) if len(sup) and int(sup.iloc[-1]) > 0 else P.TOKEN_TOTAL_SUPPLY
            return fallback_tier(self.pool_state(pool, slot, end=False), supply), "fallback"
        tot = (cand["lp_fee_basis_points"].clip(lower=0) + cand["protocol_fee_basis_points"].clip(lower=0)
               + cand["coin_creator_fee_basis_points"].clip(lower=0))
        r = cand.iloc[int(np.argmax(tot.to_numpy()))]
        return Fees(int(r["lp_fee_basis_points"]), int(r["protocol_fee_basis_points"]), int(r["coin_creator_fee_basis_points"])), "trades"

    def boosts(self, pool: int) -> pd.DataFrame:
        bb = self.tape.events["BoostBuyAndBurnEvent"]
        if not len(bb):
            return bb
        x = bb[bb["pool_c"] == pool].sort_values(["slot", "tx_idx"])
        return x.assign(used=x["quote_amount_in_used"].astype(np.int64),
                        remaining=x["boost_vault_remaining"].astype(np.int64))
