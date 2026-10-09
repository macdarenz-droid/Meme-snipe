"""Slicer-ride count rows (research/brainstorm-loop/COUNT_ROWS_AMENDMENT_4.md, frozen; event details from SWEEP_4.md
survivor 1, which the amendment summarises).

Counts and flows only. No PREREG may be written before the owner rules whether riding a wallet's unfinished slices
is "front-running other users"; when every row passes, the counts go to the owner, nothing else.
As-of rule (Q14, COUNT_ROWS_AMENDMENT_10): the event and its exclusions read only rows at or before the event slot (the
two-sided-cluster label from data strictly before it, rows.TwoSidedAsOf); after it, only flows, and the buyers after the
event carry their fast class as of the event (their buys strictly before its slot; none: "unclassed", reported).
"""
from __future__ import annotations

from collections import Counter, defaultdict, deque

import numpy as np
import pandas as pd

import h8 as H8
import rebuy as RB
import rows as R
from tapeio import WSOL, Tape

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
DIRECT_PROGRAMS = {PUMP_PROGRAM, PUMPSWAP_PROGRAM}
WINDOW_S = 30 * 60
MIN_SPAN_SLOTS, MIN_SPAN_S = 3, 60
MIN_BUYS_Q = 0.01
MIN_B_Q = 0.022
LOW_B_Q = 0.005             # SWEEP_4 (d): exhausted-buyer placebo
NO_SELL_S = 24 * 3600
CV_INTERVAL, CV_SIZE = 0.2, 0.1
CONT_S = 60 * 60
BAIT_S = 4 * 3600
FAST_MAX = 0.25
BAIT_MAX = 0.5
STABILITY_PTS = 0.15
COUNT_MIN = 11
R2_MAX = 0.3


def _cv(x):
    x = np.asarray(x, float)
    m = x.mean() if len(x) else np.nan
    return float(x.std() / m) if m and np.isfinite(m) and m > 0 else 0.0     # a zero mean counts as regular


class FastAsOf:
    """`rows.w1_fast_asof` answered from an index: per (day, owner), the buy slots in order and running counts of
    the two W1 flags, so a query is one binary search instead of a scan of every buy. Same result (tested)."""

    def __init__(self, fb: pd.DataFrame):
        self.idx = {}
        fb = fb.sort_values("slot", kind="mergesort")
        for k, g in fb.groupby(["day", "owner"], sort=False):
            self.idx[k] = (g["slot"].to_numpy(), np.cumsum(g["near_anchor"].to_numpy(float)),
                           np.cumsum(g["after_big"].to_numpy(float)))

    def __call__(self, day, owner, slot) -> bool:
        x = self.idx.get((day, owner))
        if x is None:
            return False
        n = int(np.searchsorted(x[0], slot, side="right"))
        if n == 0:
            return False
        return bool(x[1][n - 1] / n >= 0.10 or x[2][n - 1] / n >= 0.30)

    def before(self, day, owner, slot):
        """COUNT_ROWS_AMENDMENT_10 (red team R2-20): the class from the owner's buys of `day` strictly before `slot`;
        None ("unclassed") when it has none, never filled in from later buys."""
        x = self.idx.get((day, owner))
        n = int(np.searchsorted(x[0], slot, side="left")) if x is not None else 0
        if n == 0:
            return None
        return bool(x[1][n - 1] / n >= 0.10 or x[2][n - 1] / n >= 0.30)


EV_COLS = ["day", "pool", "mint", "owner", "t", "slot", "Q", "B", "n_slices", "slice_sol", "first_t"]


def find_events(tape: Tape, s: pd.DataFrame, adj, fast, ctx, low_b=False, fast_idx=None, two_sided=None, trace=None,
                memo=None):
    """Slicer events on canonical WSOL pools. One event per (mint, owner): the first buy k at which the owner has
    at least 3 buys of the mint in (t_k - 30 min, t_k], spanning at least 3 slots and 60 s (Q27). Returns
    (events, drops). The streaming reader passes the whole-tape `fast_idx` and `two_sided` indexes, a `trace`
    list, which gets (the pair's first buy order, drop reason or None, event record) for each pair checked, and a
    `memo` dict shared by the event and placebo calls: every check before the B range does not depend on low_b, so
    the second call reuses the first call's checks (same pairs, same order, same results)."""
    def checked():
        if memo is not None and memo.get("complete"):
            yield from memo["pairs"]
            return
        sw = s[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL) & ~s["excluded"] & s["owner"].notna()]
        allx = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
        buys = sw[sw["is_buy"]]
        n = buys.groupby(["mint", "owner"], sort=False)["order"].transform("size")
        buys = buys[n >= 3]                               # a pair with fewer than 3 buys can never fire
        pairs = pd.MultiIndex.from_frame(buys[["mint", "owner"]]).unique()
        sells = allx[~allx["is_buy"]]
        sells = sells[pd.MultiIndex.from_frame(sells[["mint", "owner"]]).isin(pairs)]
        sells_by = {k: g["block_time"].to_numpy() for k, g in sells.groupby(["mint", "owner"], sort=False)}
        ps_cache = {}
        fidx = fast_idx or FastAsOf(R.w1_fast_buys(tape, s))
        ts = two_sided or R.TwoSidedAsOf(tape, s)
        acc = []
        for (mint, x), g in buys.groupby(["mint", "owner"], sort=False):
            m = _pair_checks(tape, adj, ctx, fidx, ts, sells_by, ps_cache, mint, x, g)
            if m is not None:
                acc.append(m)
                yield m
        if memo is not None:
            memo["pairs"], memo["complete"] = acc, True

    out, drops = [], Counter()
    for key, why, info in checked():
        if why is None:
            q, b = info["Q"], info["B"]
            if (b >= LOW_B_Q * q) if low_b else (b < MIN_B_Q * q):    # placebo keeps B < 0.5% of Q
                why = "b_out_of_range"
            elif not tape.covered(info["slot"], info["t"] + CONT_S):
                why = "window_not_on_tape"
        if why:
            drops[why] += 1
            if trace is not None:
                trace.append((key, why, None))
            continue
        out.append(dict(info))
        if trace is not None:
            trace.append((key, None, out[-1]))
    return pd.DataFrame(out, columns=EV_COLS), dict(drops)


def _pair_checks(tape, adj, ctx, fast_idx, two_sided, sells_by, ps_cache, mint, x, g):
    """find_events' checks of one (mint, owner) pair up to the B range: None when no event buy is found, else
    (the pair's first buy order, the first failing reason or None, the event record)."""
    if len(g) < 3:
        return None
    g = g.sort_values("order")
    bt, sl = g["block_time"].to_numpy(), g["slot"].to_numpy()
    hit = None
    for k in range(2, len(g)):
        w = np.nonzero((bt > bt[k] - WINDOW_S) & (np.arange(len(g)) <= k))[0]
        if len(w) >= 3 and sl[k] - sl[w[0]] >= MIN_SPAN_SLOTS and bt[k] - bt[w[0]] >= MIN_SPAN_S:
            hit = (k, w)
            break
    if hit is None:
        return None
    k, w = hit
    sl_rows = g.iloc[w]
    last = g.iloc[k]
    pool, t, st = last["pool"], int(last["block_time"]), int(last["slot"])
    why = None
    q = b = np.nan
    if (sl_rows["signer"] != sl_rows["owner"]).any():
        why = "signer_not_owner"           # also rules out a PDA owner: a PDA cannot sign
    elif bool(last["schema_v2"]) and not sl_rows["top_program"].isin(DIRECT_PROGRAMS).all():
        why = "routed_or_app"
    elif two_sided.labelled(mint, x, st):   # as of the event slot (COUNT_ROWS_AMENDMENT_10, red team R2-19)
        why = "two_sided_cluster"
    elif fast_idx(last["day"], x, st):     # as of the event slot (red team R2-17); = R.w1_fast_asof
        why = "w1_fast_class"
    else:
        seeds = {last["creator"]}
        cs = getattr(tape, "create_seeds", None)     # the streaming reader's {mint: (creator, user)} of tape.creates
        if cs is not None:
            if mint in cs:
                seeds |= set(cs[mint])
        else:
            cr = tape.creates[tape.creates["mint"] == mint]
            if len(cr):
                seeds |= {cr["creator"].iloc[0], cr["user"].iloc[0]}
        if x in R.creator_group(adj, seeds, st):
            why = "creator_group"
    if why is None:
        sb = sells_by.get((mint, x))
        if sb is not None and ((sb >= t - NO_SELL_S) & (sb < t)).any():
            why = "sold_in_prior_24h"
    if why is None:
        gaps = np.diff(sl_rows["block_time"].to_numpy(float))
        if _cv(gaps) <= CV_INTERVAL or _cv(sl_rows["sol"]) <= CV_SIZE:
            why = "regular_cadence"
        elif (sl_rows["signer_sol_pre"].to_numpy()[1:] == sl_rows["signer_sol_post"].to_numpy()[:-1]).any():
            why = "sol_pure_next_slice"
    if why is None:
        if pool not in ps_cache:
            ps_cache[pool] = RB.pool_state(ctx.pp[pool])
        i, _, eq_i = RB.state_at(ps_cache[pool], t, st)
        q = eq_i if i >= 0 and np.isfinite(eq_i) else np.nan
        b = float(last["signer_sol_post"]) if pd.notna(last["signer_sol_post"]) else np.nan
        if not np.isfinite(q) or q <= 0 or not np.isfinite(b):
            why = "no_q_or_b"
        elif float(sl_rows["sol"].sum()) < MIN_BUYS_Q * q:
            why = "buys_under_1pct_q"
    rec = {"day": last["day"], "pool": pool, "mint": mint, "owner": x, "t": t, "slot": st, "Q": q, "B": b,
           "n_slices": len(w), "slice_sol": float(sl_rows["sol"].sum()), "first_t": int(bt[w[0]])}
    return int(g["order"].iloc[0]), why, rec


FLOW_COLS = ["cont", "a_hit", "fast_ratio", "unclassed_ratio", "bait"]
ASOF_COLS = ["ret5", "ret15", "ret60", "vol15", "volume15", "buys15", "universe", "ok5"]


def measure(tape: Tape, s: pd.DataFrame, ev: pd.DataFrame, fast, ctx, fast_idx=None):
    """Flows after each event (X's continuation, fast-class buying, bait) and as-of features before it."""
    return measure_frame(ev, measure_rows(tape, s, ev, ctx, fast_idx) if len(ev) else [])


def measure_frame(ev: pd.DataFrame, res, flows=True):
    if not len(ev):
        return ev.assign(**{c: [] for c in (FLOW_COLS if flows else []) + ASOF_COLS})
    return pd.concat([ev.reset_index(drop=True), pd.DataFrame(res)], axis=1)


def measure_rows(tape: Tape, s: pd.DataFrame, ev: pd.DataFrame, ctx, fast_idx=None, flows=True):
    """One record per event: the flows after it (flows=True) and its as-of features. flows=False (prep only) reads
    nothing after the event."""
    if not len(ev):
        return []
    x = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
    by_mint = {m: g for m, g in x.groupby("mint", sort=False)}
    if flows:
        fast_idx = fast_idx or FastAsOf(R.w1_fast_buys(tape, s))
    res = []
    for e in ev.itertuples(index=False):
        g = by_mint[e.mint]
        if not flows:
            res.append(_asof_features(tape, e, ctx))
            continue
        mine = g[g["owner"] == e.owner]
        win = mine[(mine["slot"] > e.slot + R.LANDING) & (mine["block_time"] <= e.t + CONT_S)]
        cont = float(win.loc[win["is_buy"], "sol"].sum() - win.loc[~win["is_buy"], "sol"].sum())
        early = g[(g["slot"] >= e.slot) & (g["slot"] <= e.slot + R.LANDING) & g["is_buy"] & (g["owner"] != e.owner)]
        # COUNT_ROWS_AMENDMENT_10 (R2-20): each buyer's class as of the event, from its buys strictly before the
        # event's slot; a buyer with none is unclassed and reported, never classed from later buys
        cls = [fast_idx.before(d, o, e.slot) for d, o in zip(early["day"], early["owner"])]
        fast_sol = float(early.loc[[c is True for c in cls], "sol"].sum())
        unclassed_sol = float(early.loc[[c is None for c in cls], "sol"].sum())
        # bait: X sells at least half of the tokens it bought (through the end of its buying in the hour) within 4 h
        buys = mine[mine["is_buy"] & (mine["block_time"] <= e.t + CONT_S)]
        t_end = int(buys["block_time"].max())
        bait = np.nan
        if tape.covered(e.slot, t_end + BAIT_S):
            sold = mine[~mine["is_buy"] & (mine["block_time"] > e.t) & (mine["block_time"] <= t_end + BAIT_S)]["base"].sum()
            bait = bool(sold >= 0.5 * buys["base"].sum())
        res.append({"cont": cont, "a_hit": bool(cont >= 0.5 * e.B), "fast_ratio": fast_sol / e.B if e.B > 0 else np.nan,
                    "unclassed_ratio": unclassed_sol / e.B if e.B > 0 else np.nan,
                    "bait": bait, **_asof_features(tape, e, ctx)})
    return res


def _asof_features(tape: Tape, e, ctx):
    """As-of features from the pool's trades at or before the event."""
    tr = ctx.trades(e.pool)
    k = int(np.searchsorted(tr["slot"], e.slot, side="right"))
    bt, post = tr["bt"][:k], tr["post"][:k]

    def back(dt):
        j = int(np.searchsorted(bt, e.t - dt, side="right")) - 1
        return float(post[k - 1] / post[j] - 1) if j >= 0 and post[j] > 0 and k > 0 else np.nan

    recent = (bt > e.t - 900)
    pg = ctx.pp[e.pool]
    pg = pg[(pg["slot"] <= e.slot) & (pg["block_time"] > e.t - 900) & pg["sol_quoted"]]
    closes = pd.Series(post[recent], index=bt[recent] // 60).groupby(level=0).last()
    vol15 = float(np.diff(np.log(closes.to_numpy())).std()) if len(closes) > 2 else np.nan
    m = ctx.mig.get(e.pool)
    uni = H8.universe(e.t - m[0]) if m else "age_unknown"
    return {"ret5": back(300), "ret15": back(900), "ret60": back(3600), "vol15": vol15,
            "volume15": float(pg["sol"].sum()), "buys15": int(pg["is_buy"].sum()), "universe": uni,
            "ok5": ctx.check(e.pool, e.t, e.slot, e.Q, H8.TRIAL_SIZE_USD) == "ok" and uni == "U1"}


def dispersed_controls_reference(tape: Tape, s: pd.DataFrame, ctx, cmap, flows=True):
    """Row-by-row version of `dispersed_controls`, kept as the reference the tests compare it with.
    SWEEP_4 (c) control: at least 3 wallets, each with exactly 1 buy in (t' - 30 min, t'], in different hub-cap-50
    clusters, whose buys sum to at least 1% of Q; the first such t' per pool and 2-h block (Q28). Its continuation
    is those wallets' net buy in (t' + 23 slots, t' + 60 min]."""
    sw = s[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL) & ~s["excluded"] & s["owner"].notna()]
    out = []
    for pool, g in sw.groupby("pool", sort=False):
        g = g.sort_values("order")
        b = g[g["is_buy"]]
        ps = RB.pool_state(ctx.pp[pool])
        done = set()
        for r in b.itertuples(index=False):
            blk = (r.day, int(r.block_time) // 7200)
            if blk in done:
                continue
            w = b[(b["block_time"] > r.block_time - WINDOW_S) & (b["order"] <= r.order)]
            n = w.groupby("owner").size()
            single = w[w["owner"].isin(n[n == 1].index)]
            single = single.assign(cl=[cmap.get(o, o) for o in single["owner"]]).drop_duplicates("cl")
            if len(single) < 3:
                continue
            i, _, eq_i = RB.state_at(ps, int(r.block_time), int(r.slot))
            q = eq_i if i >= 0 and np.isfinite(eq_i) else np.nan
            if not np.isfinite(q) or single["sol"].sum() < MIN_BUYS_Q * q or not tape.covered(int(r.slot), int(r.block_time) + CONT_S):
                continue
            rec = {"day": r.day, "pool": pool, "t": int(r.block_time), "Q": q}
            if flows:
                later = g[(g["slot"] > r.slot + R.LANDING) & (g["block_time"] <= r.block_time + CONT_S)
                          & g["owner"].isin(set(single["owner"]))]
                rec["cont"] = float(later.loc[later["is_buy"], "sol"].sum() - later.loc[~later["is_buy"], "sol"].sum())
            m = ctx.mig.get(pool)
            rec["age_s"] = (int(r.block_time) - m[0]) if m else np.nan
            out.append(rec)
            done.add(blk)
    return pd.DataFrame(out, columns=ctl_cols(flows))


def ctl_cols(flows=True):
    return ["day", "pool", "t", "Q"] + (["cont"] if flows else []) + ["age_s"]


def dispersed_controls(tape: Tape, s: pd.DataFrame, ctx, cmap, flows=True, records=False):
    """SWEEP_4 (c) control (Q28), same result as `dispersed_controls_reference`, in one pass per pool: a sliding
    30-min window over the pool's buys keeps each owner's buy count, the sum of single-buy SOL and the clusters that
    hold a single buyer; the exact cluster-deduplicated sum is formed only when the cheap bounds allow a hit.
    Pools whose block times step back are left to the reference scan."""
    sw = s[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL) & ~s["excluded"] & s["owner"].notna()]
    out = []
    for pool, g in sw.groupby("pool", sort=False):
        g = g.sort_values("order")
        b = g[g["is_buy"]]
        if not len(b):
            continue
        bt = b["block_time"].to_numpy(np.int64)
        if (np.diff(bt) < 0).any():
            ref = dispersed_controls_reference(tape, g, ctx, cmap, flows)
            out += ref.to_dict("records")
            continue
        sl, sol = b["slot"].to_numpy(np.int64), b["sol"].to_numpy(float)
        owners = b["owner"].to_numpy(object)
        clus = (cmap.many(owners) if hasattr(cmap, "many")      # the streaming reader's cluster map
                else np.array([cmap.get(o, o) for o in owners], dtype=object))
        days = b["day"].to_numpy(object)
        ps = RB.pool_state(ctx.pp[pool])
        g_slot, g_bt = g["slot"].to_numpy(np.int64), g["block_time"].to_numpy(np.int64)
        g_owner, g_buy, g_sol = g["owner"].to_numpy(object), g["is_buy"].to_numpy(bool), g["sol"].to_numpy(float)
        m = ctx.mig.get(pool)
        win = defaultdict(deque)              # owner -> indices of its buys in the window
        csingle = Counter()                   # cluster -> number of single-buy owners in it
        single_sum = 0.0
        done = set()
        lo = 0

        def drop_single(o):
            nonlocal single_sum
            j = win[o][0]
            single_sum -= sol[j]
            csingle[clus[j]] -= 1
            if csingle[clus[j]] == 0:
                del csingle[clus[j]]

        def add_single(o):
            nonlocal single_sum
            j = win[o][0]
            single_sum += sol[j]
            csingle[clus[j]] += 1

        for k in range(len(b)):
            o = owners[k]
            if len(win[o]) == 1:
                drop_single(o)
            win[o].append(k)
            if len(win[o]) == 1:
                add_single(o)
            while bt[lo] <= bt[k] - WINDOW_S:
                ol = owners[lo]
                if len(win[ol]) == 1:
                    drop_single(ol)
                win[ol].popleft()
                if len(win[ol]) == 1:
                    add_single(ol)
                lo += 1
            blk = (days[k], int(bt[k]) // 7200)
            if blk in done or len(csingle) < 3:
                continue
            i, _, q = RB.state_at(ps, int(bt[k]), int(sl[k]))
            if i < 0 or not np.isfinite(q) or single_sum < MIN_BUYS_Q * q:
                continue
            if not tape.covered(int(sl[k]), int(bt[k]) + CONT_S):
                continue
            kept, seen = [], set()
            for j in range(lo, k + 1):
                oj = owners[j]
                if len(win[oj]) == 1 and clus[j] not in seen:
                    seen.add(clus[j])
                    kept.append(j)
            if len(kept) < 3 or sol[kept].sum() < MIN_BUYS_Q * q:
                continue
            rec = {"day": days[k], "pool": pool, "t": int(bt[k]), "Q": q}
            if flows:
                ks = {owners[j] for j in kept}
                lm = (g_slot > sl[k] + R.LANDING) & (g_bt <= bt[k] + CONT_S) & np.array([x in ks for x in g_owner], bool)
                rec["cont"] = float(g_sol[lm & g_buy].sum() - g_sol[lm & ~g_buy].sum())
            rec["age_s"] = (int(bt[k]) - m[0]) if m else np.nan
            out.append(rec)
            done.add(blk)
    if records:
        return out
    return pd.DataFrame(out, columns=ctl_cols(flows))


def _cells(df, ref):
    """(day, 2-h block, age tercile, Q tercile); terciles are cut on the events' values per day (Q28)."""
    keys = []
    for r in df.itertuples(index=False):
        er = ref[ref["day"] == r.day]
        qc = np.quantile(er["Q"], [1 / 3, 2 / 3]) if len(er) else [np.inf, np.inf]
        ages = er["age_s"].dropna()
        ac = np.quantile(ages, [1 / 3, 2 / 3]) if len(ages) else [np.inf, np.inf]
        qt = int(np.searchsorted(qc, r.Q, side="left"))
        at = int(np.searchsorted(ac, r.age_s, side="left")) if np.isfinite(r.age_s) else -1
        keys.append((r.day, int(r.t) // 7200, at, qt))
    return keys


def slicer_rows(tape: Tape, s: pd.DataFrame, adj, fast, ctx, cmap):
    ev, drops = find_events(tape, s, adj, fast, ctx)
    ev = measure(tape, s, ev, fast, ctx)
    plc, plc_drops = find_events(tape, s, adj, fast, ctx, low_b=True)
    plc = measure(tape, s, plc, fast, ctx)
    ctl = dispersed_controls(tape, s, ctx, cmap)
    return slicer_finish(tape, ev, drops, plc, ctl, ctx)


def slicer_finish(tape: Tape, ev, drops, plc, ctl, ctx):
    days = sorted({d for d, _, _ in tape.ranges})
    summ = {"events": int(len(ev)), "drops": drops, "events_by_universe": dict(Counter(ev["universe"])) if len(ev) else {},
            "placebo_low_b_events": int(len(plc)), "dispersed_controls": int(len(ctl))}
    # (a) budget realisation
    share = float(ev["a_hit"].mean()) if len(ev) else None
    lb = (R.boot_lb_clustered(lambda d: float(np.mean(d["a"])), [ev.assign(a=ev["a_hit"].astype(float))], ["a"], q=0.05)
          if len(ev) else None)
    summ["a_budget_realisation"] = {"share": share, "lb95_one_sided": lb,
                                    "passed": bool(share is not None and share >= 0.5 and lb is not None and lb > 0.40)}
    # (b) payer mass: PAYER_MASS.md's bar is not computed yet (CODE_REDTEAM Q-R1-a)
    summ["b_payer_mass"] = {"median_continuation_sol": float(ev["cont"].median() / R.LAMPORTS) if len(ev) else None,
                            "median_continuation_share_of_q": float((ev["cont"] / ev["Q"]).median()) if len(ev) else None,
                            "passed": None, "status": "not computed: PAYER_MASS.md bar awaits Q-R1-a"}
    # (c) specificity against the dispersed-flow control, matched cells
    ratio = None
    if len(ev) and len(ctl):
        ref = ev.assign(age_s=[(e.t - ctx.mig[e.pool][0]) if e.pool in ctx.mig else np.nan for e in ev.itertuples()])
        ek, ck = _cells(ref, ref), _cells(ctl, ref)
        keep = [k in set(ek) for k in ck]
        c = ctl[keep]
        if len(c):
            me, mc = float((ev["cont"] / ev["Q"]).median()), float((c["cont"] / c["Q"]).median())
            ratio = me / mc if mc > 0 else None
        summ["c_matched_controls"] = int(sum(keep))
    summ["c_specificity"] = {"ratio_of_medians": ratio, "passed": bool(ratio is not None and ratio >= 2)}
    # (d) exhausted-buyer placebo
    me = float((ev["cont"] / ev["Q"]).median()) if len(ev) else None
    mp = float((plc["cont"] / plc["Q"]).median()) if len(plc) else None
    summ["d_low_b_placebo"] = {"median_event": me, "median_placebo": mp,
                               "passed": bool(me is not None and mp is not None and mp <= 0.5 * me)}
    # (e) not momentum
    r2 = None
    feats = ["ret5", "ret15", "ret60", "vol15", "volume15", "buys15"]
    reg = ev.dropna(subset=feats + ["cont"]) if len(ev) else ev
    if len(reg) > len(feats) + 1:
        X = np.column_stack([np.ones(len(reg)), reg[feats].to_numpy(float)])
        y = (reg["cont"] / reg["Q"]).to_numpy(float)
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        ss = float(((y - y.mean()) ** 2).sum())
        r2 = float(1 - ((y - X @ beta) ** 2).sum() / ss) if ss > 0 else None
    summ["e_r2"] = {"r2": r2, "passed": bool(r2 is not None and r2 <= R2_MAX)}
    # (f) competition
    fr = float(ev["fast_ratio"].median()) if len(ev) else None
    ur = float(ev["unclassed_ratio"].median()) if len(ev) else None
    summ["f_fast_class"] = {"median_fast_buy_over_b": fr, "median_unclassed_buy_over_b": ur,   # AMENDMENT_10
                            "passed": bool(fr is not None and fr <= FAST_MAX)}
    # (g) bait
    bt = ev["bait"].dropna() if len(ev) else pd.Series(dtype=float)
    bs = float(bt.astype(float).mean()) if len(bt) else None
    summ["g_bait"] = {"share": bs, "n": int(len(bt)), "passed": bool(bs is not None and bs <= BAIT_MAX)}
    # (h) stability of (a)'s share across the two Step A days
    by = {d: float(ev.loc[ev["day"] == d, "a_hit"].mean()) if (ev["day"] == d).any() else None for d in days} if len(ev) else {}
    sh = [by.get("2026-09-10"), by.get("2026-09-11")]
    summ["h_stability"] = {"by_day": by, "passed": bool(None not in sh and abs(sh[0] - sh[1]) <= STABILITY_PTS)}
    # (i) count at $5 in U1
    cnt = {d: int(((ev["day"] == d) & ev["ok5"].astype(bool)).sum()) if len(ev) else 0 for d in days}
    summ["i_count_u1_5usd"] = {"per_day": cnt, "passed": bool(cnt and min(cnt.values()) >= COUNT_MIN)}
    rows_ok = [summ[k]["passed"] for k in ("a_budget_realisation", "b_payer_mass", "c_specificity", "d_low_b_placebo",
                                           "e_r2", "f_fast_class", "g_bait", "h_stability", "i_count_u1_5usd")]
    summ["all_rows_pass"] = bool(all(v is True for v in rows_ok))
    summ["next_step"] = ("counts go to the owner for the ethics ruling (no PREREG before it)" if summ["all_rows_pass"]
                         else "closed or waiting: not every row passes")
    return ev, plc, ctl, summ
