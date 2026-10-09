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

    CHUNK = 500_000

    def owners(self, day: str, lean: Optional[bool] = None) -> np.ndarray:
        if day in self._by_day:
            return self._by_day[day]
        if lean is None:
            from .load import REFERENCE
            lean = not REFERENCE
        if lean:
            self._by_day[day] = self._owners_lean(day)
            return self._by_day[day]
        return self._owners_reference(day)

    def _owners_lean(self, day: str) -> np.ndarray:
        """`_owners_reference` without a copy of the day's buys: the day's rows are read in chunks of the buys table,
        the >= 1 SOL buys (few) are held whole, the "previous big buy of the mint" join is a search in their
        (mint, key) order instead of merge_asof, and the per-trader counts are bincounts. The same traders and owners."""
        tape, ctx = self.ctx.tape, self.ctx
        rng = [(a, b) for a, b, d in tape.day_of_unit if d == day]
        lo, hi = min(a for a, _ in rng), max(b for _, b in rng)
        labels = ctx.graph.components(hi) if ctx.graph is not None else None
        if labels is not None and not len(labels):
            labels = None                                   # the reference then uses the owner itself
        bs = tape.buys
        B_slot, B_tx, B_own = bs["slot"].to_numpy(), bs["tx_idx"].to_numpy(), bs["owner"].to_numpy()
        B_mint, B_sol = bs["mint"].to_numpy(), bs["sol"].to_numpy()
        n_names = len(tape.names.names)
        mint_top = max(n_names, int(B_mint.max()) + 1 if len(B_mint) else 0)

        def lookup(d):
            arr = np.full(mint_top, -10 ** 12, dtype=np.int64)
            if d:
                k = np.fromiter(d.keys(), dtype=np.int64, count=len(d))
                v = np.fromiter(d.values(), dtype=np.int64, count=len(d))
                m = (k >= 0) & (k < mint_top)
                arr[k[m]] = v[m]
            return arr

        cs_of, ms_of = lookup(ctx.create_slot), lookup(ctx.mig_slot)

        def rows(c0, c1):
            """The day's rows (owner >= 0) of buys[c0:c1]: slot, key, owner, mint, sol, trader."""
            sl = B_slot[c0:c1]
            m = np.flatnonzero((sl >= lo) & (sl <= hi) & (B_own[c0:c1] >= 0))
            s = sl[m]
            key = s * 100_000 + B_tx[c0:c1][m]
            ow = B_own[c0:c1][m]
            mi = B_mint[c0:c1][m]
            tr = labels[ow] if labels is not None else ow
            return m + c0, s, key, ow, mi, B_sol[c0:c1][m], tr

        chunks = [(c, min(c + self.CHUNK, len(B_slot))) for c in range(0, len(B_slot), self.CHUNK)]
        # the >= 1 SOL buys, in the reference's order: by mint, then key, then position in the table
        bi, bm, bk, bt, bsl = [], [], [], [], []
        for c0, c1 in chunks:
            idx, s, key, ow, mi, sol, tr = rows(c0, c1)
            g = sol >= P.LAMPORTS
            bi.append(idx[g]); bm.append(mi[g]); bk.append(key[g]); bt.append(tr[g]); bsl.append(s[g])
        cat = (lambda x: np.concatenate(x) if x else np.empty(0, dtype=np.int64))
        bi, bm, bk, bt, bsl = cat(bi), cat(bm), cat(bk), cat(bt), cat(bsl)
        o = np.lexsort((bi, bk, bm))
        bm, bk, bt, bsl = bm[o], bk[o], bt[o], bsl[o]
        del bi, o
        nb = len(bm)
        prev_other = np.empty(0, dtype=np.int64)
        comp = np.empty(0, dtype=np.int64)
        um = np.empty(0, dtype=bm.dtype)
        kmin, span = 0, 1
        if nb:
            newrun = np.ones(nb, dtype=bool)
            newrun[1:] = (bm[1:] != bm[:-1]) | (bt[1:] != bt[:-1])
            rs = np.maximum.accumulate(np.where(newrun, np.arange(nb), 0))
            prev = rs - 1
            ok = prev >= 0
            ok[ok] = bm[prev[ok]] == bm[ok]
            prev_other = np.where(ok, bsl[np.clip(prev, 0, None)], -10 ** 12)
            um = np.unique(bm)
            kmin = int(lo) * 100_000 + min(int(B_tx.min()), 0)       # every key of the day lies in [kmin, kmax]
            kmax = int(hi) * 100_000 + max(int(B_tx.max()), 0)
            span = kmax - kmin + 2
            if (len(um) + 1) * span >= 2 ** 62:
                return self._owners_reference(day)       # composite key would overflow: the reference path
            comp = np.searchsorted(um, bm).astype(np.int64) * span + (bk - kmin)
        top = int(labels.max()) + 1 if labels is not None and len(labels) else n_names
        top = max(top, int(B_own.max()) + 1 if len(B_own) else 0)
        n_t = np.zeros(top, dtype=np.int64)
        near_t = np.zeros(top, dtype=np.float64)
        ab_t = np.zeros(top, dtype=np.float64)
        for c0, c1 in chunks:
            _, s, key, ow, mi, sol, tr = rows(c0, c1)
            mok = mi >= 0
            cs = np.where(mok, cs_of[np.clip(mi, 0, None)], -10 ** 12)
            ms = np.where(mok, ms_of[np.clip(mi, 0, None)], -10 ** 12)
            near = ((s - cs >= 0) & (s - cs <= 2)) | ((s - ms >= 0) & (s - ms <= 2))
            del cs, ms
            after_big = np.zeros(len(s), dtype=bool)
            if nb:
                r = np.searchsorted(um, mi)
                has = (r < len(um))
                has[has] = um[r[has]] == mi[has]
                q = r.astype(np.int64) * span + (key - kmin)
                pos = np.searchsorted(comp, q, "left") - 1
                hit = has & (pos >= 0)
                hit[hit] = bm[pos[hit]] == mi[hit]
                p_ = pos[hit]
                cand = np.where(bt[p_] != tr[hit], bsl[p_], prev_other[p_])
                after_big[hit] = (s[hit] - cand) <= 2
            n_t += np.bincount(tr, minlength=top)[:top]
            near_t += np.bincount(tr, weights=near, minlength=top)[:top]
            ab_t += np.bincount(tr, weights=after_big, minlength=top)[:top]
        fast = (n_t > 0) & ((near_t >= 0.10 * n_t) | (ab_t >= 0.30 * n_t))
        del n_t, near_t, ab_t
        out = [np.unique(ow[fast[tr]]) for _, _, _, ow, _, _, tr in (rows(c0, c1) for c0, c1 in chunks)]
        res = np.unique(np.concatenate(out)) if out else np.empty(0, dtype=B_own.dtype)
        return res.astype(B_own.dtype, copy=False)

    def _owners_reference(self, day: str) -> np.ndarray:
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
    w = w[~w["is_protocol"]] if len(w) else w
    cr = ctx.tape.curve_of(mint)
    cw = cr[(cr["slot"] == m) & ~cr["is_buyback"]]
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
