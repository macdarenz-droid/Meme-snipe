"""Flows in [m, m + D] after a migration (amendment 1 gate a; amendment 2 gates c and c2; PREREG §10 flow rows),
and W1 §5's fast class. These read the market after the decision and belong to the gate and outcome stages only.
They read timing, holdings and flows, never a strategy return."""
from typing import Dict, Optional

import numpy as np
import pandas as pd

from . import params as P
from .features import FeatureContext
from .holdings import mint_events, replay
from .market import Market


class FastClass:
    """W1 §5: a trader (W1 §3 cluster as of the day's end) is fast on a day if at least 10% of its buys land within 2
    slots of the mint's create or migration, or at least 30% land within 2 slots after another trader's buy of at
    least 1 SOL on the same mint."""

    def __init__(self, ctx: FeatureContext):
        self.ctx = ctx
        self._by_day: Dict[str, np.ndarray] = {}

    def owners(self, day: str) -> np.ndarray:
        if day in self._by_day:
            return self._by_day[day]
        tape = self.ctx.tape
        rng = [(a, b) for a, b, d in tape.day_of_unit if d == day]
        lo, hi = min(a for a, _ in rng), max(b for _, b in rng)
        labels = self.ctx.graph.components(hi) if self.ctx.graph is not None else np.arange(len(tape.names.names))
        b = tape.buys
        b = b[(b["slot"] >= lo) & (b["slot"] <= hi) & (b["owner"] >= 0)].copy()
        b["trader"] = labels[b["owner"].to_numpy()] if len(labels) else b["owner"]
        cs = b["mint"].map(pd.Series(self.ctx.create_slot)).fillna(-10 ** 12).to_numpy()
        ms = b["mint"].map(pd.Series(self.ctx.mig_slot)).fillna(-10 ** 12).to_numpy()
        s = b["slot"].to_numpy()
        b["near"] = ((s - cs >= 0) & (s - cs <= 2)) | ((s - ms >= 0) & (s - ms <= 2))
        b["key"] = b["slot"] * 100_000 + b["tx_idx"]
        b = b.sort_values("key", kind="stable")
        big = b[b["sol"] >= P.LAMPORTS].sort_values(["mint", "key"], kind="stable").reset_index(drop=True)
        if len(big):
            newrun = np.ones(len(big), dtype=bool)
            newrun[1:] = (big["mint"].to_numpy()[1:] != big["mint"].to_numpy()[:-1]) | (big["trader"].to_numpy()[1:] != big["trader"].to_numpy()[:-1])
            rs = np.maximum.accumulate(np.where(newrun, np.arange(len(big)), 0))
            prev = rs - 1
            ok = (prev >= 0)
            ok[ok] = big["mint"].to_numpy()[prev[ok]] == big["mint"].to_numpy()[ok]
            big["prev_other_slot"] = np.where(ok, big["slot"].to_numpy()[np.clip(prev, 0, None)], -10 ** 12)
            right = big[["key", "mint", "trader", "slot", "prev_other_slot"]].rename(columns={"trader": "bt", "slot": "bs"})
            j = pd.merge_asof(b[["key", "mint", "trader", "slot"]], right.sort_values("key", kind="stable"),
                              on="key", by="mint", allow_exact_matches=False)
            cand = np.where(j["bt"].to_numpy() != j["trader"].to_numpy(), j["bs"].to_numpy(), j["prev_other_slot"].to_numpy())
            cand = np.nan_to_num(cand.astype(float), nan=-1e15)
            b["after_big"] = (b["slot"].to_numpy() - cand) <= 2
        else:
            b["after_big"] = False
        g = b.groupby("trader").agg(n=("near", "size"), near=("near", "sum"), ab=("after_big", "sum"))
        fast_tr = g.index[(g["near"] >= 0.10 * g["n"]) | (g["ab"] >= 0.30 * g["n"])].to_numpy()
        fast_owner = b.loc[b["trader"].isin(fast_tr), "owner"].unique()
        self._by_day[day] = np.sort(fast_owner)
        return self._by_day[day]


def migration_flows(ctx: FeatureContext, mkt: Market, mint: int, fast: Optional[np.ndarray]) -> dict:
    """Flows in [m, m + D] on the canonical pool (and curve trades in slot m), BOOST and protocol rows left out."""
    mig = mkt.mig.get(mint)
    out = {"m": -1}
    if mig is None:
        return out
    m, pool = int(mig["slot"]), int(mig["pool_c"])
    out["m"] = m
    bc = ctx.tape.names.get(mig.get("bonding_curve") or "")
    book, _ = ctx.holdings(mint, m - 1, bc)
    pre = book.holders()
    hold = {o: lt.tokens for o, lt in pre.items()}
    pr = ctx.tape.pool_of(pool)
    w = pr[(pr["slot"] >= m) & (pr["slot"] <= m + P.D)]
    boost = w[w["is_boost"]] if len(w) else w
    w = w[~w["is_boost"] & (w["protocol"] != 1)] if len(w) else w
    cr = ctx.tape.curve_of(mint)
    cw = cr[cr["slot"] == m]
    sells = pd.concat([
        pd.DataFrame({"owner": w.loc[w["side"] == "sell", "owner"], "tokens": w.loc[w["side"] == "sell", "base_amount"],
                      "sol": w.loc[w["side"] == "sell", "quote_amount_lp_adjusted"]}),
        pd.DataFrame({"owner": cw.loc[cw["is_buy"] == 0, "owner"], "tokens": cw.loc[cw["is_buy"] == 0, "token_amount"],
                      "sol": cw.loc[cw["is_buy"] == 0, "sol_amount"]})])
    buys = pd.concat([
        pd.DataFrame({"owner": w.loc[w["side"] == "buy", "owner"], "sol": w.loc[w["side"] == "buy", "quote_amount_lp_adjusted"]}),
        pd.DataFrame({"owner": cw.loc[cw["is_buy"] == 1, "owner"], "sol": cw.loc[cw["is_buy"] == 1, "sol_amount"]})])
    ps = sells[sells["owner"].isin(list(hold))]
    sold = ps.groupby("owner")["tokens"].sum()
    held = sum(hold.values())
    out["pre_holders"] = len(hold)
    out["pre_holder_tokens"] = held
    out["share_pre_sold"] = (sum(min(v, hold[o]) for o, v in sold.items()) / held) if held > 0 else np.nan
    first = ~buys["owner"].isin(list(book.first_buy)) & ~buys["owner"].isin(list(hold))
    out["first_time_buy_sol"] = float(buys.loc[first, "sol"].sum())
    out["pre_holder_sell_sol"] = float(ps["sol"].sum())
    out["net_opening_flow_sol"] = out["first_time_buy_sol"] - out["pre_holder_sell_sol"]
    out["fast_buy_sol"] = float(buys.loc[buys["owner"].isin(fast), "sol"].sum()) if fast is not None else np.nan
    out["boost_sol_in_window"] = float(boost["quote_amount_lp_adjusted"].sum()) if len(boost) else 0.0
    out["distinct_buyers"] = int(buys["owner"].nunique())
    out["non_boost_buy_sol"] = float(buys["sol"].sum())
    return out
