"""Row 2 REBUY-ANCHOR (STEP_A_COUNT_ROWS.md §2, with COUNT_ROWS_AMENDMENT_1 Q14 and Q15).

Reads as-of price levels and as-of past returns only (Q14): the pool's mid at or before each decision point,
ex-holders' exit prices and realised gains, and past return, drawdown, age and depth. After a decision point it
reads flows only (SOL bought and sold), never a price.
The cost ledger is H1-CGO's (research/h1-cgo/tape/h1cgo/ledger.py), loaded read-only.
"""
from __future__ import annotations

import importlib.util
import os
import sys

import numpy as np
import pandas as pd

import rows as R
from tapeio import Tape

H1_LEDGER = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "h1-cgo", "tape",
                                          "h1cgo", "ledger.py"))
EXIT_LOOKBACK_S = 12 * 3600      # RB counts exits in the last 12 h
REBUY_S = 2 * 3600               # rebuy and flow horizon
DECISION_HOURS = range(1, 13)    # Q15: hourly points from m + 60 min to m + 12 h
OR_MIN = 1.5
READABLE_MIN = 0.8
TOP_MIN_PER_DAY = 30
R2_MAX = 0.3


def load_ledger_class(path=H1_LEDGER):
    spec = importlib.util.spec_from_file_location("h1cgo_ledger_readonly", path)
    mod = importlib.util.module_from_spec(spec)
    old = sys.dont_write_bytecode
    sys.dont_write_bytecode = True          # never write into the H1-CGO folder
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod.Ledger


# ------------------------------------------------------------------ ledger and exits
def ledger_exits(s_mint: pd.DataFrame, moves_mint: pd.DataFrame, Ledger) -> pd.DataFrame:
    """Replay one mint's swaps and T moves through H1-CGO's average-cost ledger, in tape order
    (slot, tx_idx, outer_ix, inner_ix, ev_idx; T rows before swaps of the same instruction).
    An exit is a SOL-quoted sale that leaves the owner with 0 (tape `owner_token_post`, or the ledger when
    that is empty). Per exit: proceeds and tokens sold since the owner's last exit (the holding episode),
    exit VWAP (lamports per raw token), realised gain (proceeds - known cost of the tokens sold; NaN when any
    sold token had unknown cost), and readable (every sale of the episode signed by the owner, with a
    signer SOL reading)."""
    L = Ledger()
    ev = []
    for r in s_mint.itertuples(index=False):
        if r.excluded or not isinstance(r.owner, str):
            continue
        ev.append(((r.slot, r.tx_idx, r.outer_ix, r.inner_ix, r.ev_idx), "swap", r))
    for r in moves_mint.itertuples(index=False):
        ev.append(((r.slot, r.tx_idx, r.outer_ix, r.inner_ix, -1), "t", r))
    ev.sort(key=lambda x: x[0])
    ep, out = {}, []
    for key, kind, r in ev:
        if kind == "t":
            frm = r.from_owner if isinstance(r.from_owner, str) else None
            to = r.to_owner if isinstance(r.to_owner, str) else None
            if r.kind == "transfer" and frm and to:
                L.transfer(frm, to, int(r.amount))
                if L.balance(frm) == 0:
                    ep.pop(frm, None)        # left by transfer: not an exit by sale
            elif r.kind == "burn" and frm:
                L.burn(frm, int(r.amount))
            elif r.kind == "mint" and to:
                L.mint(to, int(r.amount))
            continue
        tokens = int(r.base) if pd.notna(r.base) else 0
        if r.is_buy:
            if r.sol_quoted and pd.notna(r.cost):
                L.buy(r.owner, tokens, int(r.cost), post_migration=(r.venue == "amm"))
            else:
                L.mint(r.owner, tokens)      # cost not in SOL: unknown cost
            continue
        k, c, u, _, _, excess = L._take(r.owner, tokens)
        e = ep.setdefault(r.owner, {"proceeds": 0.0, "tokens": 0, "cost": 0.0, "unknown": 0, "readable": True,
                                    "sol_ok": True})
        e["tokens"] += tokens
        e["cost"] += c
        e["unknown"] += u + excess
        if r.sol_quoted and pd.notna(r.proceeds):
            e["proceeds"] += float(r.proceeds)
        else:
            e["sol_ok"] = False
        e["readable"] &= bool(r.signer == r.owner and pd.notna(r.signer_sol_post))
        zero = (r.owner_token_post == 0) if pd.notna(r.owner_token_post) else (L.balance(r.owner) == 0)
        if zero:
            ep.pop(r.owner)
            if not e["sol_ok"] or e["tokens"] <= 0:
                continue
            out.append({"owner": r.owner, "slot": int(r.slot), "block_time": int(r.block_time), "day": r.day,
                        "proceeds": e["proceeds"], "tokens_sold": e["tokens"],
                        "exit_vwap": e["proceeds"] / e["tokens"],
                        "gain": (e["proceeds"] - e["cost"]) if e["unknown"] == 0 else np.nan,
                        "readable": e["readable"]})
    return pd.DataFrame(out, columns=["owner", "slot", "block_time", "day", "proceeds", "tokens_sold", "exit_vwap",
                                      "gain", "readable"])


# ------------------------------------------------------------------ as-of pool state
def pool_state(g: pd.DataFrame):
    """Per pool swap: post-swap mid (lamports per raw token, effective reserves) and effective quote from the
    swap's own `chain_pool_*` reading, and the same from the NEXT swap's pre-trade reserves (`*_next`), which
    may only be used when that next swap is itself on or before the decision point (see state_asof)."""
    v = g["virtual_quote"].fillna(0)
    q = g["pool_quote_post"] + v
    b = g["pool_base_post"]
    qn = g["pool_quote_pre"].shift(-1) + v
    bn = g["pool_base_pre"].shift(-1)
    return {"mid": (q / b).to_numpy(float), "eq": q.to_numpy(float), "mid_next": (qn / bn).to_numpy(float),
            "eq_next": qn.to_numpy(float), "bt": g["block_time"].to_numpy(), "slot": g["slot"].to_numpy(),
            "supply": g["supply"].to_numpy(float)}


def state_asof(ps, t, st):
    """Mid and effective quote after each swap at or before t, as known at t: the swap's own post reading, or
    the next swap's pre-trade reserves only when that next swap has block_time <= t and slot <= st;
    otherwise NaN (reviewer L1: no look-ahead). Returns (i, mid[:i+1], eq[:i+1]) with i the last swap <= t."""
    bt, sl = ps["bt"], ps["slot"]
    i = int(np.searchsorted(bt, t, side="right") - 1)
    if i < 0:
        return i, np.array([]), np.array([])
    mid, eq = ps["mid"][: i + 1].copy(), ps["eq"][: i + 1].copy()
    nxt = np.arange(1, i + 2)
    ok_next = (nxt < len(bt)) & (bt[np.minimum(nxt, len(bt) - 1)] <= t) & (sl[np.minimum(nxt, len(bt) - 1)] <= st)
    fill = ~np.isfinite(mid) & ok_next
    mid[fill] = ps["mid_next"][: i + 1][fill]
    fill_q = ~np.isfinite(eq) & ok_next
    eq[fill_q] = ps["eq_next"][: i + 1][fill_q]
    return i, mid, eq


def state_at(ps, t, st):
    """state_asof's value at its last index only, in O(log n): (i, mid_i, eq_i). Same rule: the swap's own post
    reading, or the next swap's pre-trade reserves only when that swap has block_time <= t and slot <= st."""
    bt, sl = ps["bt"], ps["slot"]
    i = int(np.searchsorted(bt, t, side="right") - 1)
    if i < 0:
        return i, np.nan, np.nan
    mid, eq = ps["mid"][i], ps["eq"][i]
    ok_next = i + 1 < len(bt) and bt[i + 1] <= t and sl[i + 1] <= st
    if not np.isfinite(mid) and ok_next:
        mid = ps["mid_next"][i]
    if not np.isfinite(eq) and ok_next:
        eq = ps["eq_next"][i]
    return i, float(mid), float(eq)


def last_block_slot(tape: Tape, t):
    b = tape.blocks
    i = np.searchsorted(b["block_time"].values, t, side="right") - 1
    return int(b["slot"].values[i]) if i >= 0 else None


# ------------------------------------------------------------------ the rows
EXIT_COLS = ["owner", "slot", "block_time", "day", "proceeds", "tokens_sold", "exit_vwap", "gain", "readable",
             "pool", "mint", "next_buy_slot"]
POINT_COLS = ["pool", "mint", "day", "t", "hour", "decision_slot", "mid", "eff_quote", "RB", "net_rebuy_flow",
              "past_return_1h", "drawdown", "age_h", "depth_sol", "supply"]
PAIR_COLS = ["pool", "mint", "day", "t", "hour", "owner", "exit_slot", "proceeds", "gain", "readable", "below", "rebuy_2h"]


def rebuy_anchor(tape: Tape, s: pd.DataFrame, require_history=True, Ledger=None):
    exits_all, points, pairs = rebuy_rows(tape, s, require_history, Ledger)
    exits, pts, prs = rebuy_frames(exits_all, points, pairs)
    return exits, pts, prs, summarise(tape, exits, pts, prs)


def rebuy_frames(exits_all, points, pairs, flows=True):
    drop = [] if flows else ["net_rebuy_flow", "rebuy_2h"]
    exits = pd.concat(exits_all, ignore_index=True) if exits_all else pd.DataFrame(columns=EXIT_COLS)
    pts = pd.DataFrame(points, columns=[c for c in POINT_COLS if c not in drop])
    prs = pd.DataFrame(pairs, columns=[c for c in PAIR_COLS if c not in drop])
    return exits, pts, prs


def rebuy_rows(tape: Tape, s: pd.DataFrame, require_history=True, Ledger=None, keep=None, flows=True, tag=None):
    """REBUY-ANCHOR's per-pool exits (a list of frames), decision points and (ex-holder, point) pairs, in eligible-pool
    order. `keep(mint)` limits them to some pools (a shard); `tag(pool_position)` returns a value added to each
    exits frame, point and pair as "_k" (the streaming reader's merge key). flows=False (prep only): no flow after a
    decision point (no net rebuy flow, no rebuy within 2 h)."""
    Ledger = Ledger or load_ledger_class()
    pools = R.eligible_pools(tape)
    pp = R.by_pool(s)
    by_mint = {m: g for m, g in s.groupby("mint", sort=False)}
    mv = {m: g for m, g in tape.moves[tape.moves["kind"].isin(["transfer", "mint", "burn"])].groupby("mint", sort=False)}
    flow_rows = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
    fl_by_mint = {m: g for m, g in flow_rows.groupby("mint", sort=False)}
    exits_all, points, pairs = [], [], []
    for pi, r in enumerate(pools.itertuples(index=False)):
        if keep is not None and not keep(r.mint):
            continue
        kt = {} if tag is None else {"_k": tag(pi)}
        if require_history and not R.history_on_tape(tape, r.mint, int(r.m_slot)):
            continue
        ex = ledger_exits(by_mint[r.mint], mv.get(r.mint, tape.moves.iloc[:0]), Ledger)
        ex["pool"] = r.pool
        ex["mint"] = r.mint
        f = fl_by_mint.get(r.mint, flow_rows.iloc[:0])
        buys = f[f["is_buy"]]
        # next buy of the mint by the same owner after each exit (ends ex-holder status)
        nb = []
        for e in ex.itertuples(index=False):
            later = buys[(buys["owner"] == e.owner) & (buys["slot"] > e.slot)]["slot"]
            nb.append(int(later.min()) if len(later) else np.iinfo(np.int64).max)
        ex["next_buy_slot"] = nb
        exits_all.append(ex.assign(**kt) if kt else ex)
        g = pp.get(r.pool)
        if g is None or not len(g):
            continue
        ps = pool_state(g)
        bt = ps["bt"]
        m = int(r.m_time)
        for k in DECISION_HOURS:
            t = m + 3600 * k
            if not tape.covered(int(r.m_slot), t + REBUY_S):
                continue
            st = last_block_slot(tape, t)
            i, mid, eq = state_asof(ps, t, st)
            if i < 0 or not np.isfinite(mid[i]) or not eq[i] > 0:
                continue
            mid_t, eq_t = float(mid[i]), float(eq[i])
            peak = np.nanmax(mid[: i + 1])
            j = np.searchsorted(bt, t - 3600, side="right") - 1
            past = float(mid_t / mid[j] - 1) if j >= 0 and mid[j] > 0 else np.nan
            exh = ex[(ex["slot"] <= st) & (ex["next_buy_slot"] > st)]
            recent = exh[exh["block_time"] > t - EXIT_LOOKBACK_S]
            if flows:
                win = f[(f["slot"] > st) & (f["block_time"] <= t + REBUY_S)]
                win_rebuy = set(win.loc[win["is_buy"], "owner"])
            for e in recent.itertuples(index=False):
                pr = {"pool": r.pool, "mint": r.mint, "day": r.day, "t": t, "hour": k, "owner": e.owner,
                      "exit_slot": e.slot, "proceeds": e.proceeds, "gain": e.gain, "readable": e.readable,
                      "below": bool(mid_t < e.exit_vwap)}
                if flows:
                    pr["rebuy_2h"] = e.owner in win_rebuy
                pairs.append({**pr, **kt})
            rb_set = recent[(recent["gain"] > 0) & (recent["exit_vwap"] > mid_t) & recent["readable"]]
            pt = {"pool": r.pool, "mint": r.mint, "day": r.day, "t": t, "hour": k, "decision_slot": st,
                  "mid": mid_t, "eff_quote": eq_t, "RB": float(rb_set["proceeds"].sum()) / eq_t}
            if flows:
                late = win[win["slot"] > st + R.LANDING]
                exset = set(exh["owner"])
                ex_buy = float(late.loc[late["is_buy"] & late["owner"].isin(exset), "sol"].sum())
                other_sell = float(late.loc[~late["is_buy"] & ~late["owner"].isin(exset), "sol"].sum())
                pt["net_rebuy_flow"] = (ex_buy - other_sell) / eq_t
            pt.update({"past_return_1h": past, "drawdown": float(1 - mid_t / peak) if peak > 0 else np.nan,
                       "age_h": k, "depth_sol": eq_t / R.LAMPORTS,
                       "supply": float(ps["supply"][i])})   # the swap at or before t (payer bar's tier, AMENDMENT_8)
            points.append({**pt, **kt})
    return exits_all, points, pairs


# ------------------------------------------------------------------ statistics
def odds_ratio(x, y):
    """Odds of y when x versus when not x. NaN when any cell is empty."""
    x, y = np.asarray(x, bool), np.asarray(y, bool)
    a, b = np.sum(x & y), np.sum(x & ~y)
    c, d = np.sum(~x & y), np.sum(~x & ~y)
    return float(a * d / (b * c)) if min(a, b, c, d) > 0 else np.nan


def _or_row(df, xcol):
    if not len(df):
        return {"n": 0, "odds_ratio": None, "lb95": None}
    df = df.assign(_x=df[xcol].astype(bool), _y=df["rebuy_2h"].astype(bool))
    o = odds_ratio(df["_x"], df["_y"])
    lb = R.boot_lb_clustered(lambda d: odds_ratio(d["_x"], d["_y"]), [df], ["_x", "_y"])
    return {"n": int(len(df)), "odds_ratio": None if np.isnan(o) else o, "lb95": lb}


def materiality_sets(pts: pd.DataFrame):
    """Q15: within each (day, drawdown tercile), top-quintile RB points vs points within +/-10 percentile
    points of the median RB."""
    p = pts.dropna(subset=["RB", "net_rebuy_flow", "drawdown"]).copy()
    if not len(p):
        return p.iloc[:0], p.iloc[:0]
    p["dd_tercile"] = -1
    for d, g in p.groupby("day"):
        if len(g) >= 3:
            p.loc[g.index, "dd_tercile"] = pd.qcut(g["drawdown"].rank(method="first"), 3, labels=False).astype(int)
    p = p[p["dd_tercile"] >= 0]
    p["stratum"] = p["day"] + "|" + p["dd_tercile"].astype(str)
    p["rb_pct"] = p.groupby("stratum")["RB"].rank(pct=True)
    top = p[p["rb_pct"] > 0.8]
    mid = p[(p["rb_pct"] - 0.5).abs() <= 0.10]
    return top, mid


def stratum_diff(top, mid):
    """Mean net flow of top minus mid within each stratum, averaged with the top counts as weights."""
    ts, tv = np.asarray(top["stratum"]), np.asarray(top["net_rebuy_flow"], float)
    ms, mv = np.asarray(mid["stratum"]), np.asarray(mid["net_rebuy_flow"], float)
    num = den = 0.0
    for k in np.unique(ts):
        a, b = tv[ts == k], mv[ms == k]
        if len(a) and len(b):
            num += len(a) * (a.mean() - b.mean())
            den += len(a)
    return num / den if den else np.nan


def summarise(tape: Tape, exits, pts, prs):
    days = sorted({d for d, _, _ in tape.ranges})
    tot = float(exits["proceeds"].sum()) if len(exits) else 0.0
    gain_known = prs[prs["gain"].notna() & (prs["gain"] != 0)].assign(gain_seller=lambda d: d["gain"] > 0)
    # (a2) gain ex-holders at their first point below the sale price, by exit size
    first_below = prs[(prs["gain"] > 0) & prs["below"]].sort_values("t").drop_duplicates(["pool", "owner", "exit_slot"])
    by_size = {}
    if len(first_below) >= 3:
        fb = first_below.assign(size=pd.qcut(first_below["proceeds"].rank(method="first"), 3,
                                             labels=["low", "mid", "high"]))
        by_size = {str(k): {"ex_holders": int(len(g)), "rebuy_2h_share": float(g["rebuy_2h"].mean())}
                   for k, g in fb.groupby("size", observed=True)}
    top, mid = materiality_sets(pts)
    diff = stratum_diff(top, mid) if len(top) and len(mid) else np.nan
    lb = (R.boot_lb_clustered(lambda a, b: stratum_diff(a, b), [top, mid], ["stratum", "net_rebuy_flow"])
          if np.isfinite(diff) else None)
    # decisions a day in the top quintile: the ranking materiality_sets uses (rb_pct > 0.8 within day x
    # drawdown tercile), and RB > 0 (reviewer L2: ties at 0 never count)
    per_day = {d: int(((top["day"] == d) & (top["RB"] > 0)).sum()) if len(top) else 0 for d in days}
    reg = pts.dropna(subset=["RB", "past_return_1h", "drawdown", "age_h", "depth_sol"])
    r2 = None
    if len(reg) > 5:
        X = np.column_stack([np.ones(len(reg)), reg[["past_return_1h", "drawdown", "age_h", "depth_sol"]].to_numpy(float)])
        y = reg["RB"].to_numpy(float)
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        ss = float(((y - y.mean()) ** 2).sum())
        r2 = float(1 - ((y - X @ beta) ** 2).sum() / ss) if ss > 0 else None
    return {
        "exits": int(len(exits)), "decision_points": int(len(pts)), "ex_holder_point_pairs": int(len(prs)),
        "a_odds_rebuy_below_vs_above_sale_price": _or_row(prs, "below"),
        "b_odds_rebuy_gain_vs_loss_sellers": _or_row(gain_known, "gain_seller"),
        "a2_gain_ex_holders_rebuy_2h_once_below_by_exit_size": by_size,
        "materiality_top_minus_mid_net_flow": None if not np.isfinite(diff) else float(diff),
        "materiality_lb95": lb, "materiality_points": {"top": int(len(top)), "mid": int(len(mid))},
        "proceeds_readable_share": (float(exits.loc[exits["readable"].astype(bool), "proceeds"].sum()) / tot) if tot else None,
        "top_quintile_points_per_day": per_day,
        "r2_rb_on_past_return_drawdown_age_depth": r2,
    }


def rebuy_decide(x):
    a, b = x["a_odds_rebuy_below_vs_above_sale_price"], x["b_odds_rebuy_gain_vs_loss_sellers"]

    def ok_or(o):
        return o["odds_ratio"] is not None and o["odds_ratio"] >= OR_MIN and o["lb95"] is not None and o["lb95"] > 1

    return bool(ok_or(a) and ok_or(b)
                and x["materiality_top_minus_mid_net_flow"] is not None and x["materiality_top_minus_mid_net_flow"] >= R.EFFECT
                and x["materiality_lb95"] is not None and x["materiality_lb95"] > 0
                and x["proceeds_readable_share"] is not None and x["proceeds_readable_share"] >= READABLE_MIN
                and x["top_quintile_points_per_day"] and min(x["top_quintile_points_per_day"].values()) >= TOP_MIN_PER_DAY
                and x["r2_rb_on_past_return_drawdown_age_depth"] is not None
                and x["r2_rb_on_past_return_drawdown_age_depth"] < R2_MAX)
