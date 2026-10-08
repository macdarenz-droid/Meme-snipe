"""Slicer-ride count rows (research/brainstorm-loop/COUNT_ROWS_AMENDMENT_4.md, frozen; event details from SWEEP_4.md
survivor 1, which the amendment summarises).

Counts and flows only. No PREREG may be written before the owner rules whether riding a wallet's unfinished slices
is "front-running other users"; when every row passes, the counts go to the owner, nothing else.
As-of rule (Q14): the event and its exclusions read only rows at or before the event slot; after it, only flows.
"""
from __future__ import annotations

from collections import Counter

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


def find_events(tape: Tape, s: pd.DataFrame, adj, fast, ctx, low_b=False):
    """Slicer events on canonical WSOL pools. One event per (mint, owner): the first buy k at which the owner has
    at least 3 buys of the mint in (t_k - 30 min, t_k], spanning at least 3 slots and 60 s (Q27). Returns
    (events, drops)."""
    sw = s[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL) & ~s["excluded"] & s["owner"].notna()]
    allx = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
    sells_by = {k: g["block_time"].to_numpy() for k, g in allx[~allx["is_buy"]].groupby(["mint", "owner"], sort=False)}
    ps_cache = {}
    out, drops = [], Counter()
    for (mint, x), g in sw[sw["is_buy"]].groupby(["mint", "owner"], sort=False):
        if len(g) < 3:
            continue
        g = g.sort_values("order")
        bt, sl = g["block_time"].to_numpy(), g["slot"].to_numpy()
        hit = None
        for k in range(2, len(g)):
            w = np.nonzero((bt > bt[k] - WINDOW_S) & (np.arange(len(g)) <= k))[0]
            if len(w) >= 3 and sl[k] - sl[w[0]] >= MIN_SPAN_SLOTS and bt[k] - bt[w[0]] >= MIN_SPAN_S:
                hit = (k, w)
                break
        if hit is None:
            continue
        k, w = hit
        sl_rows = g.iloc[w]
        last = g.iloc[k]
        pool, t, st = last["pool"], int(last["block_time"]), int(last["slot"])
        why = None
        if (sl_rows["signer"] != sl_rows["owner"]).any():
            why = "signer_not_owner"           # also rules out a PDA owner: a PDA cannot sign
        elif bool(last["schema_v2"]) and not sl_rows["top_program"].isin(DIRECT_PROGRAMS).all():
            why = "routed_or_app"
        elif sl_rows["fake"].any():
            why = "two_sided_cluster"
        elif bool(fast.get((last["day"], x), False)):
            why = "w1_fast_class"
        else:
            seeds = {last["creator"]}
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
            i, _, eq = RB.state_asof(ps_cache[pool], t, st)
            q = float(eq[i]) if i >= 0 and np.isfinite(eq[i]) else np.nan
            b = float(last["signer_sol_post"]) if pd.notna(last["signer_sol_post"]) else np.nan
            if not np.isfinite(q) or q <= 0 or not np.isfinite(b):
                why = "no_q_or_b"
            elif float(sl_rows["sol"].sum()) < MIN_BUYS_Q * q:
                why = "buys_under_1pct_q"
            elif (b >= LOW_B_Q * q) if low_b else (b < MIN_B_Q * q):    # placebo keeps B < 0.5% of Q
                why = "b_out_of_range"
            elif not tape.covered(st, t + CONT_S):
                why = "window_not_on_tape"
        if why:
            drops[why] += 1
            continue
        out.append({"day": last["day"], "pool": pool, "mint": mint, "owner": x, "t": t, "slot": st, "Q": q, "B": b,
                    "n_slices": len(w), "slice_sol": float(sl_rows["sol"].sum()), "first_t": int(bt[w[0]])})
    cols = ["day", "pool", "mint", "owner", "t", "slot", "Q", "B", "n_slices", "slice_sol", "first_t"]
    return pd.DataFrame(out, columns=cols), dict(drops)


def measure(tape: Tape, s: pd.DataFrame, ev: pd.DataFrame, fast, ctx):
    """Flows after each event (X's continuation, fast-class buying, bait) and as-of features before it."""
    if not len(ev):
        return ev.assign(cont=[], a_hit=[], fast_ratio=[], bait=[], ret5=[], ret15=[], ret60=[], vol15=[], volume15=[],
                         buys15=[], universe=[], ok5=[])
    x = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
    by_mint = {m: g for m, g in x.groupby("mint", sort=False)}
    res = []
    for e in ev.itertuples(index=False):
        g = by_mint[e.mint]
        mine = g[g["owner"] == e.owner]
        win = mine[(mine["slot"] > e.slot + R.LANDING) & (mine["block_time"] <= e.t + CONT_S)]
        cont = float(win.loc[win["is_buy"], "sol"].sum() - win.loc[~win["is_buy"], "sol"].sum())
        early = g[(g["slot"] >= e.slot) & (g["slot"] <= e.slot + R.LANDING) & g["is_buy"] & (g["owner"] != e.owner)]
        fast_sol = float(early.loc[[bool(fast.get((d, o), False)) for d, o in zip(early["day"], early["owner"])], "sol"].sum())
        # bait: X sells at least half of the tokens it bought (through the end of its buying in the hour) within 4 h
        buys = mine[mine["is_buy"] & (mine["block_time"] <= e.t + CONT_S)]
        t_end = int(buys["block_time"].max())
        bait = np.nan
        if tape.covered(e.slot, t_end + BAIT_S):
            sold = mine[~mine["is_buy"] & (mine["block_time"] > e.t) & (mine["block_time"] <= t_end + BAIT_S)]["base"].sum()
            bait = bool(sold >= 0.5 * buys["base"].sum())
        # as-of features from the pool's trades at or before the event
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
        res.append({"cont": cont, "a_hit": bool(cont >= 0.5 * e.B), "fast_ratio": fast_sol / e.B if e.B > 0 else np.nan,
                    "bait": bait, "ret5": back(300), "ret15": back(900), "ret60": back(3600), "vol15": vol15,
                    "volume15": float(pg["sol"].sum()), "buys15": int(pg["is_buy"].sum()), "universe": uni,
                    "ok5": ctx.check(e.pool, e.t, e.slot, e.Q, H8.TRIAL_SIZE_USD) == "ok" and uni == "U1"})
    return pd.concat([ev.reset_index(drop=True), pd.DataFrame(res)], axis=1)


def dispersed_controls(tape: Tape, s: pd.DataFrame, ctx, cmap):
    """SWEEP_4 (c) control: at least 3 wallets, each with exactly 1 buy in (t' - 30 min, t'], in different hub-cap-50
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
            i, _, eq = RB.state_asof(ps, int(r.block_time), int(r.slot))
            q = float(eq[i]) if i >= 0 and np.isfinite(eq[i]) else np.nan
            if not np.isfinite(q) or single["sol"].sum() < MIN_BUYS_Q * q or not tape.covered(int(r.slot), int(r.block_time) + CONT_S):
                continue
            later = g[(g["slot"] > r.slot + R.LANDING) & (g["block_time"] <= r.block_time + CONT_S)
                      & g["owner"].isin(set(single["owner"]))]
            cont = float(later.loc[later["is_buy"], "sol"].sum() - later.loc[~later["is_buy"], "sol"].sum())
            m = ctx.mig.get(pool)
            out.append({"day": r.day, "pool": pool, "t": int(r.block_time), "Q": q, "cont": cont,
                        "age_s": (int(r.block_time) - m[0]) if m else np.nan})
            done.add(blk)
    return pd.DataFrame(out, columns=["day", "pool", "t", "Q", "cont", "age_s"])


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
    days = sorted({d for d, _, _ in tape.ranges})
    ev, drops = find_events(tape, s, adj, fast, ctx)
    ev = measure(tape, s, ev, fast, ctx)
    plc, plc_drops = find_events(tape, s, adj, fast, ctx, low_b=True)
    plc = measure(tape, s, plc, fast, ctx)
    ctl = dispersed_controls(tape, s, ctx, cmap)
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
    summ["f_fast_class"] = {"median_fast_buy_over_b": fr, "passed": bool(fr is not None and fr <= FAST_MAX)}
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
