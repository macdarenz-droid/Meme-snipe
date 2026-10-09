"""Funding clusters, W1's fast class and the creator cluster, as of each decision slot.

- Links (W1 §3, G1 amendment 1): a W SOL transfer or a T transfer of a pump mint (mint ending in "pump") between two
  addresses, on or before the decision slot. An address linked to more than 50 distinct addresses as of the decision
  slot (a hub) is never used for joining. Clusters = connected components of the remaining links, rebuilt exactly at
  every decision time (tau grid), so no later link or later hub status is used.
- Fast class (W1 §5), per cluster: >= 10% of its buys within 2 slots of the mint's create (C) or migration (G), or
  >= 30% of its buys within 2 slots after another cluster's buy of >= 1 SOL on the same mint. "On that day" is read
  as-of: the cluster's buys from the start of the decision's UTC day up to the decision slot (CONSERVATIVE).
- Creator cluster: the clusters of the create row's creator and user; when the create predates the tape, of the pool's
  `coin_creator` (CONSERVATIVE fallback).
- Shares are of buy SOL (PumpSwap `quote_amount`) in the pool over [tau - 15 min, tau).
"""
from typing import Dict, Tuple

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from . import config as C
from . import holders
from .load import Tape
from .pool_state import PoolBook, flow_rows


def link_pairs(tape: Tape) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    t = tape.t[(tape.t.kind == 0) & (tape.t.pump_mint == 1)]
    src = np.r_[tape.w.src.to_numpy(), t.src.to_numpy()].astype(np.int64)
    dst = np.r_[tape.w.dst.to_numpy(), t.dst.to_numpy()].astype(np.int64)
    slot = np.r_[tape.w.slot.to_numpy(), t.slot.to_numpy()].astype(np.int64)
    ok = (src >= 0) & (dst >= 0) & (src != dst)
    u, v = np.minimum(src[ok], dst[ok]), np.maximum(src[ok], dst[ok])
    u, v, s = holders.FIRST_LINKS(u, v, slot[ok])   # each pair once, first slot, in first-appearance order
    o = np.argsort(s, kind="stable")                 # = the earlier sort_values("slot", kind="mergesort")
    return u[o], v[o], s[o]


def near_event_flags(tape: Tape) -> np.ndarray:
    b = tape.buys
    flag = np.zeros(len(b), dtype=bool)
    for ev in ("CreateEvent", "CompletePumpAmmMigrationEvent"):
        e = tape.ev[ev].drop_duplicates("mint")
        m = dict(zip(e.mint.to_numpy(), e.slot.to_numpy()))
        es = b.mint.map(m).to_numpy(dtype=float)
        dlt = b.slot.to_numpy() - es
        flag |= (dlt >= 0) & (dlt <= C.FAST_NEAR_EVENT_SLOTS)
    return flag


def follow_pairs(tape: Tape) -> Tuple[np.ndarray, np.ndarray]:
    """(follower buy index, leader owner): buys of the same mint within 2 slots after a buy of >= 1 SOL."""
    b = tape.buys
    if len(b) == 0:
        return np.empty(0, np.int64), np.empty(0, np.int64)
    order = np.lexsort((b.ev_idx.to_numpy(), b.tx_idx.to_numpy(), b.slot.to_numpy(), b.mint.to_numpy()))
    mint = b.mint.to_numpy()[order]
    slot = b.slot.to_numpy()[order]
    owner = b.owner.to_numpy()[order]
    sol = b.sol.to_numpy()[order]
    assert slot.max() < 2**31 and mint.max() < 2**31
    key = (mint.astype(np.int64) << 31) + slot.astype(np.int64)  # exact, ordered by (mint, slot)
    leaders = np.flatnonzero((sol >= C.FAST_LEADER_MIN_LAMPORTS) & (owner >= 0))
    end = np.searchsorted(key, key[leaders] + C.FAST_FOLLOW_SLOTS, side="right")
    cnt = end - leaders - 1
    cnt = np.maximum(cnt, 0)
    if cnt.sum() == 0:
        return np.empty(0, np.int64), np.empty(0, np.int64)
    lead_rep = np.repeat(leaders, cnt)
    offs = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
    foll = lead_rep + 1 + offs
    return order[foll], owner[lead_rep]


class ClusterState:
    """Snapshots in increasing decision-slot order."""

    def __init__(self, tape: Tape):
        self.n = max(len(tape.codec), 1)
        self.pu, self.pv, self.ps = link_pairs(tape)
        self.k = 0
        self.deg = np.zeros(self.n, dtype=np.int64)
        b = tape.buys
        self.b_slot = b.slot.to_numpy()
        self.b_owner = b.owner.to_numpy()
        self.b_cm = near_event_flags(tape).astype(float)
        self.fp_buy, self.fp_lead = follow_pairs(tape)
        o = np.argsort(self.fp_buy, kind="mergesort")
        self.fp_buy, self.fp_lead = self.fp_buy[o], self.fp_lead[o]
        self.clock_slot = tape.b.slot.to_numpy()
        self.clock_bt = np.maximum.accumulate(tape.b.block_time.to_numpy()) if len(tape.b) else np.empty(0)

    def snapshot(self, d: int, tau: int):
        k = int(np.searchsorted(self.ps, d, side="right"))
        if k < self.k:
            raise ValueError("snapshots must be taken in increasing decision slot")
        if k > self.k:
            self.deg += np.bincount(self.pu[self.k:k], minlength=self.n) + np.bincount(self.pv[self.k:k], minlength=self.n)
            self.k = k
        hub = self.deg > C.HUB_MAX_LINKS
        u, v = self.pu[:k], self.pv[:k]
        keep = ~hub[u] & ~hub[v]
        g = coo_matrix((np.ones(keep.sum(), dtype=np.int8), (u[keep], v[keep])), shape=(self.n, self.n))
        ncomp, labels = connected_components(g, directed=False)
        # fast class from the buys of tau's UTC day up to d
        day0 = tau - tau % 86400
        j = np.searchsorted(self.clock_bt, day0, side="left")
        s0 = self.clock_slot[j] if j < len(self.clock_slot) else d + 1
        i0 = np.searchsorted(self.b_slot, s0, side="left")
        i1 = np.searchsorted(self.b_slot, d, side="right")
        ow = self.b_owner[i0:i1]
        ok = ow >= 0
        lab = labels[ow[ok]]
        n = np.bincount(lab, minlength=ncomp).astype(float)
        ncm = np.bincount(lab, weights=self.b_cm[i0:i1][ok], minlength=ncomp)
        a, z = np.searchsorted(self.fp_buy, i0, "left"), np.searchsorted(self.fp_buy, i1, "left")
        fb, fl = self.fp_buy[a:z], self.fp_lead[a:z]
        fo = self.b_owner[fb]
        good = (fo >= 0) & (labels[np.maximum(fo, 0)] != labels[fl])
        fflag = np.zeros(i1 - i0)
        fflag[fb[good] - i0] = 1.0
        nf = np.bincount(lab, weights=fflag[ok], minlength=ncomp)
        with np.errstate(invalid="ignore", divide="ignore"):
            fast = (n > 0) & ((ncm >= C.FAST_NEAR_EVENT_SHARE * n) | (nf >= C.FAST_FOLLOW_SHARE * n))
        return labels, fast


def creator_seeds(tape: Tape) -> Dict[int, Tuple[int, int, int]]:
    """mint -> (create slot, creator, user) from the create row on the tape."""
    ce = tape.ev["CreateEvent"].drop_duplicates("mint")
    return {int(m): (int(s), int(c), int(u)) for m, s, c, u in zip(ce.mint, ce.slot, ce.creator, ce.user)}


def who_shares(tape: Tape, book: PoolBook, el: pd.DataFrame, idx: pd.DataFrame) -> pd.DataFrame:
    st = ClusterState(tape)
    seeds = creator_seeds(tape)
    fast_share = pd.Series(np.nan, index=el.index)
    cre_share = pd.Series(np.nan, index=el.index)
    for (d, tau), g in el.groupby(["d", "tau"], sort=True):
        d, tau = int(d), int(tau)
        labels, fast = st.snapshot(d, tau)
        for ix, pool, mint in zip(g.index, g.pool, g.mint):
            r = book.rows[pool]
            s, e = int(idx.at[ix, "_l15"]), int(idx.at[ix, "_iD"]) + 1
            if e <= s:
                continue
            bm = (r["side"][s:e] == 1) & flow_rows(r)[s:e]
            q = r["quote_amount"][s:e][bm].astype(float)
            ow = r["owner"][s:e][bm]
            tot = q.sum()
            if tot <= 0:
                continue
            okw = ow >= 0
            lab = np.full(len(ow), -1)
            lab[okw] = labels[ow[okw]]
            fast_share[ix] = q[okw & fast[np.maximum(lab, 0)]].sum() / tot
            sd = seeds.get(int(mint))
            if sd is not None and sd[0] <= d:
                sl = [x for x in (sd[1], sd[2]) if x >= 0]
            else:
                cc = int(r["coin_creator"][e - 1])
                sl = [cc] if cc >= 0 else []
            if not sl:
                continue
            seed_labels = np.unique(labels[np.array(sl)])
            cre_share[ix] = q[okw & np.isin(lab, seed_labels)].sum() / tot
    return pd.DataFrame({"fast_buy_share": fast_share, "creator_cluster_buy_share": cre_share})
