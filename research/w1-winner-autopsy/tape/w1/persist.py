"""PREREG §6 (gate W1-0) and §7 (persistence test). Ranking reads only the ranking day; the test-day outcomes are
computed by `test_day_returns`, which the ranking functions never call."""
import numpy as np
import pandas as pd

from . import classes, positions

SEED = 20261008
B = 10_000
RANK_MIN_POS = 20      # §6, §7
TEST_MIN_POS = 5       # §7
GATE_MIN_SLOW = 200    # §6
SIZE_BANDS = [0, 0.1e9, 0.5e9, 2e9, 10e9, np.inf]   # SOL paid in per position (OPEN_QUESTIONS Q13)
SIZE_LABELS = ["<0.1", "0.1-0.5", "0.5-2", "2-10", ">=10"]


# ---------------------------------------------------------------- §6
def gate(day, trader, counts_only=True):
    """Gate W1-0 for one Step A day. counts_only=True reads no P&L (development mode)."""
    pos = positions.trader_positions(day, trader)
    cls = classes.classify(day, trader)
    pos["cls"] = classes.class_of(pos["trader"].to_numpy(), cls)
    c = pos[pos["counted"]]
    n_by_tr = c.groupby("trader").size()
    tr_cls = pd.Series(classes.class_of(n_by_tr.index.to_numpy(), cls), index=n_by_tr.index)
    slow20 = int(((n_by_tr >= RANK_MIN_POS) & (tr_cls == "slow")).sum())
    # AMENDMENT_2 Q14: the same count had positions left out only for an unseen start been counted
    cs = pos[pos["counted"] | pos["start_only"]]
    n_cs = cs.groupby("trader").size()
    cs_cls = pd.Series(classes.class_of(n_cs.index.to_numpy(), cls), index=n_cs.index)
    slow20_seen = int(((n_cs >= RANK_MIN_POS) & (cs_cls == "slow")).sum())
    out = {"day": day["day"], "first_day": bool(day.get("first_day", False)), "positions": int(len(pos)),
           "counted": int(len(c)), "dirty": int(pos["dirty"].sum()), "start_only": int(pos["start_only"].sum()),
           "traders_with_positions": int(len(n_by_tr)),
           "traders_by_class": {k: int(v) for k, v in tr_cls.value_counts().items()},
           "slow_traders_20plus": slow20, "slow_traders_20plus_if_starts_seen": slow20_seen,
           "kill_threshold": GATE_MIN_SLOW,
           "positions_signer_method": int(c["signer_method"].sum())}
    if counts_only:
        return out
    out["method_shares"] = method_shares(c)
    tot = c["pnl"].sum()
    out["pnl_sol_by_class"] = {k: float(v) / 1e9 for k, v in c.groupby("cls")["pnl"].sum().items()}
    out["pnl_share_by_class"] = {k: (float(v) / tot if tot else None) for k, v in c.groupby("cls")["pnl"].sum().items()}
    band = pd.cut(c["basis"], SIZE_BANDS, labels=SIZE_LABELS, right=False)
    t = c.groupby([c["cls"], band], observed=True)["pnl"].agg(["sum", "size"])
    out["pnl_sol_by_size_band"] = {f"{a}|{b}": {"sol": float(r["sum"]) / 1e9, "positions": int(r["size"])}
                                   for (a, b), r in t.iterrows()}
    return out


def gate_verdict(day_results, required_days=None):
    """§6 kill: fewer than 200 slow traders with 20+ positions on either Step A day (AMENDMENT_2 Q14). A day below
    only because positions carried in from before the tape have no seen start, on the tape's first day, is reported
    as "untestable on the tape's first day", not as evidence about traders. Every required day must be present."""
    got = [r["day"] for r in day_results]
    if required_days is not None and sorted(got) != sorted(required_days):
        raise ValueError(f"gate needs exactly the days {required_days}, got {got}")
    low = [r["day"] for r in day_results if r["slow_traders_20plus"] < GATE_MIN_SLOW]
    untestable = [r["day"] for r in day_results if r["slow_traders_20plus"] < GATE_MIN_SLOW and r.get("first_day")
                  and r.get("slow_traders_20plus_if_starts_seen", 0) >= GATE_MIN_SLOW]
    evidence = [d for d in low if d not in untestable]
    verdict = "kill" if evidence else ("untestable on the tape's first day" if untestable else "pass")
    return {"kill": bool(evidence), "verdict": verdict, "days_below": low, "untestable_first_day": untestable}


def method_shares(counted):
    """AMENDMENT_2 Q2: share of counted positions and of P&L (absolute) under each cash method."""
    sig = counted["signer_method"].to_numpy(bool)
    tot = counted["pnl"].abs().sum()
    return {"positions_signer_method": float(sig.mean()) if len(sig) else None,
            "positions_signer_refused_by_cap": float(counted["capped"].mean()) if len(sig) else None,
            "positions_venue_method": float((~sig).mean()) if len(sig) else None,
            "abs_pnl_signer_method": float(counted.loc[sig, "pnl"].abs().sum() / tot) if tot else None,
            "abs_pnl_venue_method": float(counted.loc[~sig, "pnl"].abs().sum() / tot) if tot else None}


def top_decile_means(test_pos):
    """AMENDMENT_2 Q2: the top decile's mean return under both cash methods."""
    t = test_pos[test_pos["decile"] == 10]
    return {"signer_where_owned": float(t["ret"].mean()) if len(t) else None,
            "signer_where_owned_without_cap": float(t["ret_nc"].mean()) if len(t) else None,
            "venue_method": float(t["ret_alt"].mean()) if len(t) else None,
            "positions_capped_share": float(t["capped"].mean()) if len(t) else None,
            "method_shares": method_shares(t)}


# ---------------------------------------------------------------- §7 ranking (ranking day only)
def rank(rank_day, trader):
    """Slow traders with at least 20 positions on the ranking day, ranked by the t-statistic of their per-trade
    returns, with deciles 1..10 (10 = top). Ties in t break by trader id. A trader whose t is undefined (all
    returns equal) is left out and counted."""
    pos = positions.trader_positions(rank_day, trader)
    cls = classes.classify(rank_day, trader)
    s = positions.per_trader(pos)
    s = s[s["n"] >= RANK_MIN_POS]
    s = s[classes.class_of(s.index.to_numpy(), cls) == "slow"]
    undefined = int((~np.isfinite(s["t"])).sum())
    s = s[np.isfinite(s["t"])].copy()
    s["tid"] = s.index.to_numpy()
    s = s.sort_values(["t", "tid"], kind="stable")
    n = len(s)
    s["decile"] = (np.arange(n) * 10 // max(n, 1)) + 1
    return s.drop(columns="tid"), {"ranked": n, "t_undefined": undefined}


# ---------------------------------------------------------------- §7 outcomes (test day; separate stage)
def test_day_returns(test_day, trader_asof_rank, ranked):
    """Counted per-trade returns on a test day for ranked traders (identity as of the ranking day), plus how many
    traders of each decile still trade (any counted position) and are eligible (5+)."""
    pos = positions.trader_positions(test_day, trader_asof_rank)
    pos = pos[pos["counted"] & pos["trader"].isin(ranked.index)]
    n = pos.groupby("trader").size()
    dec = ranked["decile"]
    still = n.reindex(dec.index).fillna(0)
    report = {int(d): {"ranked": int((dec == d).sum()), "still_trade": int(((dec == d) & (still >= 1)).sum()),
                       "eligible_5plus": int(((dec == d) & (still >= TEST_MIN_POS)).sum())} for d in range(1, 11)}
    elig = n[n >= TEST_MIN_POS].index
    pos = pos[pos["trader"].isin(elig)].copy()
    pos["decile"] = pos["trader"].map(dec).to_numpy()
    return pos, report


def groups(test_pos):
    """Per-trader (sum, count) of returns for the top decile and deciles 5-6, pooled over the given test days."""
    out = {}
    for name, ds in (("top", [10]), ("mid", [5, 6])):
        g = test_pos[test_pos["decile"].isin(ds)].groupby("trader")["ret"]
        out[name] = (g.sum().to_numpy(np.float64), g.size().to_numpy(np.float64))
    return out


def lift(gr):
    (st, nt), (sm, nm) = gr["top"], gr["mid"]
    if nt.sum() == 0 or nm.sum() == 0:
        return float("nan")
    return st.sum() / nt.sum() - sm.sum() / nm.sum()


def bootstrap(gr, b=B, seed=SEED):
    """Lift under resampling traders with replacement within each group (fixed seed)."""
    rng = np.random.default_rng(seed)
    (st, nt), (sm, nm) = gr["top"], gr["mid"]
    if len(st) == 0 or len(sm) == 0:
        return np.full(b, np.nan)
    out = np.empty(b)
    chunk = 1000
    for i in range(0, b, chunk):
        k = min(chunk, b - i)
        it = rng.integers(0, len(st), size=(k, len(st)))
        im = rng.integers(0, len(sm), size=(k, len(sm)))
        out[i:i + k] = st[it].sum(1) / nt[it].sum(1) - sm[im].sum(1) / nm[im].sum(1)
    return out


def discovery_verdict(gr, boot):
    """§7 discovery: report; futility stop if the one-sided 95% upper bound of the lift is below 0."""
    ub = float(np.nanpercentile(boot, 95))
    return {"lift": lift(gr), "upper95_one_sided": ub, "futility_stop": bool(ub < 0),
            "top_traders": int(len(gr["top"][0])), "mid_traders": int(len(gr["mid"][0])),
            "top_trades": int(gr["top"][1].sum()), "mid_trades": int(gr["mid"][1].sum())}


def validation_verdict(gr, boot, replay_mean, top_mean_uncapped=None):
    """§7 validation (pooled test days): all of 99.5% two-sided lower bound > 0, top-decile mean > 0, replay > 0.
    AMENDMENT_6: the top-decile mean (capped signer method, the primary) must also be above 0 under the uncapped
    signer method; if it holds under only one, the verdict is "persistence depends on cost attribution", not a pass.
    `top_mean_uncapped` None means the caller has no uncapped figure: treated as equal to the capped one."""
    lo, hi = (float(x) for x in np.nanpercentile(boot, [0.25, 99.75]))
    st, nt = gr["top"]
    top_mean = float(st.sum() / nt.sum()) if nt.sum() else float("nan")
    top_nc = top_mean if top_mean_uncapped is None else float(top_mean_uncapped)
    lb_ok, rp_ok = lo > 0, (replay_mean is not None and replay_mean > 0)
    cap_ok, nc_ok = top_mean > 0, top_nc > 0
    top_ok = cap_ok and nc_ok
    passed = bool(lb_ok and top_ok and rp_ok)
    if passed:
        verdict = "pass"
    elif cap_ok != nc_ok:
        verdict = "persistence depends on cost attribution"
    elif lb_ok and top_ok and not rp_ok:
        verdict = "persistent, but not at our speed or cost"
    else:
        verdict = "fail"
    return {"lift": lift(gr), "ci99_5": [lo, hi], "lower_above_0": lb_ok, "top_mean": top_mean,
            "top_mean_uncapped": top_nc, "top_mean_above_0": top_ok, "replay_mean": replay_mean,
            "replay_above_0": rp_ok, "pass": passed, "verdict": verdict}


def winners(test_pos):
    """AMENDMENT_3 Q17: top decile on the ranking day; at least 5 positions on at least one test day (test_pos holds
    only qualifying days); own mean per-trade return pooled over the test days it qualifies on above the pooled mean of
    deciles 5-6 over the same days; and that own mean above 0 after its own costs."""
    top = test_pos[test_pos["decile"] == 10]
    mid = test_pos[test_pos["decile"].isin([5, 6])]
    out = set()
    for tr, g in top.groupby("trader"):
        own = g["ret"].mean()
        m = mid.loc[mid["day"].isin(set(g["day"])), "ret"].mean()
        if np.isfinite(own) and own > 0 and np.isfinite(m) and own > m:
            out.add(tr)
    return out
