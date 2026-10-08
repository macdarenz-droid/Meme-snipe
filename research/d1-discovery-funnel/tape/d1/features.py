"""The 28 registered features (PREREG §4), all as of the decision slot d.

As-of rule: every row read here has slot <= d (pool rows via `idx_le`, others via explicit slot filters); time windows
are [tau - W, tau) by block time, which with slot <= d is exactly W seconds before the decision. This module never
imports the outcome stage (tested), and a planted future-marker test checks that rows after d change nothing.
Readings marked CONSERVATIVE are listed in ../OPEN_QUESTIONS.md.
"""
from typing import Dict

import numpy as np
import pandas as pd

from . import config as C
from .clusters import who_shares
from .gates import GATES, gate_frame
from .holders import holder_features
from .load import Tape
from .pool_state import PoolBook, flow_rows
from .universe import Clock


def _first_buy_flags(tape: Tape, book: PoolBook) -> Dict[int, np.ndarray]:
    """Per pool: 1 where the row is its owner's first buy of the mint on the tape (curve or PumpSwap, any pool)."""
    out = {}
    if len(tape.buys) == 0:
        return out
    mints = {int(r["mint"][0]): p for p, r in book.rows.items()}
    b = tape.buys[tape.buys.mint.isin(list(mints)) & (tape.buys.owner >= 0)]
    first = b.drop_duplicates(["mint", "owner"], keep="first")  # buys are sorted by (slot, tx_idx, ev_idx)
    key = {(int(m), int(o)): (int(s), int(t), int(e)) for m, o, s, t, e in
           zip(first.mint, first.owner, first.slot, first.tx_idx, first.ev_idx)}
    for p, r in book.rows.items():
        m = int(r["mint"][0])
        f = np.zeros(len(r["slot"]), dtype=np.int64)
        for k in np.flatnonzero((r["side"] == 1) & flow_rows(r)):
            o = int(r["owner"][k])
            if o >= 0 and key.get((m, o)) == (int(r["slot"][k]), int(r["tx_idx"][k]), int(r["ev_idx"][k])):
                f[k] = 1
        out[p] = f
    return out


def _v1_overlap(tape: Tape, lo_slot: np.ndarray, hi_slot: np.ndarray) -> np.ndarray:
    bad = np.zeros(len(lo_slot), dtype=bool)
    for a, b in tape.schema_v1_slots:
        bad |= (lo_slot <= b) & (hi_slot >= a)
    return bad


def price_flow_pool_protocol(tape: Tape, book: PoolBook, pts: pd.DataFrame, clock: Clock) -> pd.DataFrame:
    firsts = _first_buy_flags(tape, book)
    boost = tape.ev["BoostBuyAndBurnEvent"]
    f_by_pool = {k: v for k, v in tape.f.groupby("pool")}
    cf_by_creator = {int(k): (v.slot.to_numpy(), v.block_time.to_numpy()) for k, v in tape.cf.groupby("creator")}
    empty_f = tape.f.iloc[:0]
    frames = []
    for pool, g in pts.groupby("pool", sort=False):
        r = book.rows[pool]
        tau = g.tau.to_numpy()
        d = g.d.to_numpy()
        n = len(g)
        iD = book.idx_le(pool, d)
        assert (iD >= 0).all(), "eligible points have a pool state"
        rbt = np.maximum.accumulate(r["block_time"])
        mid = book.mid_after(pool)
        lm = np.log(np.maximum(mid, 1e-300))
        p_d = mid[iD]
        res = {"pool": np.full(n, pool), "tau": tau}

        def back(w):
            i = book.idx_le(pool, clock.decision_slot(tau - w))
            return np.where(i >= 0, mid[np.maximum(i, 0)], np.nan)

        res["ret_5m"] = p_d / back(C.W5) - 1
        res["ret_15m"] = p_d / back(C.W15) - 1
        res["ret_60m"] = p_d / back(C.W60) - 1
        p0 = book.mid_before_first(pool)
        on_tape_mig = (g.mig_slot.to_numpy() >= 0) & (int(r["slot"][0]) >= g.mig_slot.to_numpy())
        res["ret_since_mig"] = np.where(on_tape_mig, p_d / p0 - 1, np.nan)

        def lo(w):  # first row index inside [tau - w, tau)
            return np.searchsorted(rbt, tau - w, side="left")

        dl2 = np.r_[0.0, np.diff(lm) ** 2]
        cs = np.cumsum(dl2)
        l15 = lo(C.W15)
        a = np.maximum(l15, 1)
        rv = np.where(iD >= a, cs[iD] - cs[np.maximum(a - 1, 0)], 0.0)
        res["rv_15m"] = np.sqrt(np.maximum(rv, 0.0))

        fl = flow_rows(r)
        isbuy = ((r["side"] == 1) & fl).astype(np.int64)
        issell = ((r["side"] == -1) & fl).astype(np.int64)
        cb, csl = np.cumsum(isbuy), np.cumsum(issell)
        cnet = np.cumsum(np.where(fl, r["side"] * r["quote_amount"], 0)).astype(float)

        def rng(c, l):
            prev = np.where(l > 0, c[np.maximum(l - 1, 0)], 0)
            return np.where(iD >= l, c[iD] - prev, 0)

        for w, tag in ((C.W5, "5m"), (C.W15, "15m")):
            l = lo(w)
            res[f"buys_{tag}"] = rng(cb, l)
            res[f"sells_{tag}"] = rng(csl, l)
            res[f"net_sol_{tag}"] = rng(cnet, l) / 1e9
        eff = (r["vault_after"] + r["virt"])[iD].astype(float)
        fb = firsts.get(pool, np.zeros(len(r["slot"]), dtype=np.int64))
        res["first_buyers_15m"] = rng(np.cumsum(fb), l15)
        uniq = np.zeros(n)
        maxsell = np.zeros(n)
        app = np.full(n, np.nan)
        for k in range(n):
            s, e = l15[k], iD[k] + 1
            if e <= s:
                app[k] = np.nan
                continue
            sl = slice(s, e)
            bm = (r["side"][sl] == 1) & fl[sl]
            ow = r["owner"][sl][bm]
            uniq[k] = len(np.unique(ow[ow >= 0]))
            sm = (r["side"][sl] == -1) & fl[sl]
            if sm.any():
                maxsell[k] = r["quote_amount"][sl][sm].max() / eff[k]
            q = r["quote_amount"][sl][bm].astype(float)
            ar = r["app_routed"][sl][bm]
            if q.sum() > 0 and (ar >= 0).all():
                app[k] = q[ar == 1].sum() / q.sum()
        res["uniq_buyers_15m"] = uniq
        res["max_sell_share_15m"] = maxsell
        res["app_routed_buy_share"] = app

        # failed buys (F, slippage class) in the last 15 minutes, share of all buy attempts
        f = f_by_pool.get(pool, empty_f)
        fs, fbt = f.slot.to_numpy(), f.block_time.to_numpy()
        nf = np.array([np.count_nonzero((fs <= d[k]) & (fbt >= tau[k] - C.W15)) for k in range(n)])
        nb = res["buys_15m"]
        with np.errstate(invalid="ignore", divide="ignore"):
            res["failed_buy_share_15m"] = np.where(nf + nb > 0, nf / np.maximum(nf + nb, 1), np.nan)

        # protocol
        bz = boost[boost.pool == pool]
        bzs, bzr = bz.slot.to_numpy(), bz.boost_vault_remaining.to_numpy()
        fin = np.zeros(n)
        for k in range(n):
            m = bzs <= d[k]
            fin[k] = 1.0 if m.any() and bzr[m][-1] == 0 else 0.0
        res["boost_finished"] = fin
        base = r["base_after"][iD].astype(float)
        supply = r["supply"][iD].astype(float)
        res["mcap_rel_420"] = np.where(supply > 0, eff * supply / np.maximum(base, 1) / C.MCAP_REF_LAMPORTS, np.nan)
        cc = r["coin_creator"][iD]
        cfn = np.zeros(n)
        for k in range(n):
            if cc[k] < 0:
                cfn[k] = np.nan
                continue
            cs_, cb_ = cf_by_creator.get(int(cc[k]), (np.empty(0), np.empty(0)))
            cfn[k] = np.count_nonzero((cs_ <= d[k]) & (cb_ >= tau[k] - C.CF_WINDOW_S))
        lo_cf = clock.decision_slot(tau - C.CF_WINDOW_S)
        cfn[_v1_overlap(tape, lo_cf, d)] = np.nan
        res["cf_collections_1h"] = cfn

        res["effective_quote_sol"] = eff / 1e9
        res["real_vault_sol"] = r["vault_after"][iD] / 1e9
        res["age_since_mig_min"] = (tau - g.mig_time.to_numpy()) / 60.0
        res["_iD"] = iD
        res["_l15"] = l15
        frames.append(pd.DataFrame(res, index=g.index))
    return pd.concat(frames) if frames else pd.DataFrame()


def compute_features(tape: Tape, book: PoolBook, pts: pd.DataFrame, clock: Clock = None,
                     funders: dict = None) -> pd.DataFrame:
    """Features for the eligible decision points of `pts` (index preserved)."""
    clock = clock or Clock(tape)
    el = pts[pts.eligible]
    if len(el) == 0:
        return pd.DataFrame(columns=["pool", "tau"] + list(C.FEATURES) + list(GATES))
    base = price_flow_pool_protocol(tape, book, el, clock)
    who = who_shares(tape, book, el, base[["_iD", "_l15"]])
    hold = holder_features(tape, book, el, funders)
    gates = gate_frame(tape, book, el, clock)
    out = base.join(who).join(hold).join(gates)
    # H8_AMENDMENT_2 / AMENDMENT_3: the bot's gates as of d, kept beside the 28 features (never a search feature)
    for g in GATES:
        out[g] = out[g].fillna(-1).astype(np.int64)
    return out[["pool", "tau"] + list(C.FEATURES) + list(GATES)]
