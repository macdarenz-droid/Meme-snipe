"""§5 gate H1-CGO-0, §6 breakpoints and entries, §7 sign and futility, §8 primary, §10 secondary.

`gate0` and `breakpoints` take the feature table only: they read no forward return. `sign_and_futility` reads
discovery outcomes only. `primary` reads validation outcomes and refuses to run without a frozen sign and breakpoints.
"""
import numpy as np
import pandas as pd

from .constants import (BOOT_RESAMPLES, BOOT_SEED, BP_HIGH_PCT, BP_LOW_PCT, CI_PRIMARY, CI_SECONDARY, DISCOVERY_DAYS,
                        GATE_A_MIN_PER_DAY, GATE_B_MAX_R2, GATE_C_MIN_SPREAD, HOLD_S, MIN_TRADES, TRADE_USD,
                        VALIDATION_DAYS)


def _check_days(df, allowed, what):
    bad = sorted(set(df.decision_day) - set(allowed))
    if bad:
        raise ValueError(f"{what} only runs on {allowed}; got decision days {bad}")


def eligible(feats: pd.DataFrame) -> pd.DataFrame:
    """Eligible decision points (§3 liquidity, §4 coverage >= 90%) whose registered 60-minute window is in time (§2)."""
    return feats[feats.eligible & feats[f"in_time_{HOLD_S}"]]


def first_per_mint_day(df: pd.DataFrame) -> pd.DataFrame:
    """At most one per mint per UTC day: the first qualifying decision point."""
    return df.sort_values(["decision_slot"]).drop_duplicates(["mint", "decision_day"], keep="first")


def r2(y, X) -> float:
    """OLS R² with an intercept."""
    X = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    ss = ((y - y.mean()) ** 2).sum()
    return float(1 - (resid ** 2).sum() / ss) if ss > 0 else float("nan")


def gate0(feats: pd.DataFrame, days) -> dict:
    """§5. (a) eligible decision points with coverage >= 90% per day; (b) R² of CGO on past 1 h, 6 h and since-migration
    returns < 0.8; (c) P80 - P20 of CGO >= 0.2. Conservative readings (OPEN_QUESTIONS Q4, Q5): (a) counts the first
    eligible decision point per mint per UTC day; (b) closes if simple or log returns give R² >= 0.8."""
    _check_days(feats, DISCOVERY_DAYS, "gate0")
    e = eligible(feats)
    n_days = len(days)
    n_all = len(e)
    n_dedup = len(first_per_mint_day(e))
    a_ok = n_days > 0 and n_dedup / n_days >= GATE_A_MIN_PER_DAY
    cols = ["r_1h", "r_6h", "r_mig"]
    z = e.dropna(subset=["cgo", *cols])
    y = z.cgo.to_numpy(float)
    X = z[cols].to_numpy(float)
    r2_simple = r2(y, X) if len(z) > 4 else float("nan")
    with np.errstate(invalid="ignore", divide="ignore"):
        XL = np.log1p(X)
    okl = np.isfinite(XL).all(axis=1)
    r2_log = r2(y[okl], XL[okl]) if okl.sum() > 4 else float("nan")
    b_ok = bool(np.isfinite(r2_simple) and r2_simple < GATE_B_MAX_R2 and (not np.isfinite(r2_log) or r2_log < GATE_B_MAX_R2))
    p20, p80 = (np.percentile(e.cgo, [BP_LOW_PCT, BP_HIGH_PCT]) if len(e) else (float("nan"),) * 2)
    c_ok = bool(len(e) and (p80 - p20) >= GATE_C_MIN_SPREAD)
    return dict(days=list(days), eligible_points=n_all, eligible_first_per_mint_day=n_dedup,
                per_day_first=n_dedup / n_days if n_days else 0.0, per_day_all=n_all / n_days if n_days else 0.0,
                a_pass=bool(a_ok), r2_simple=r2_simple, r2_log=r2_log, n_regression=int(len(z)), b_pass=b_ok,
                p20=float(p20), p80=float(p80), spread=float(p80 - p20), c_pass=c_ok,
                passed=bool(a_ok and b_ok and c_ok))


def breakpoints(feats: pd.DataFrame) -> dict:
    """§6: 20th and 80th percentiles of CGO over all eligible discovery decision points (and 40/60 for the §10 quintiles)."""
    _check_days(feats, DISCOVERY_DAYS, "breakpoints")
    e = eligible(feats)
    c = e.cgo.to_numpy(float)
    q = np.percentile(c, [20, 40, 60, 80])
    cp = e.cgo_post.dropna().to_numpy(float)
    qp = np.percentile(cp, [20, 80]) if len(cp) else (float("nan"), float("nan"))
    return dict(p20=float(q[0]), p40=float(q[1]), p60=float(q[2]), p80=float(q[3]), n=int(len(c)),
                post_p20=float(qp[0]), post_p80=float(qp[1]), post_n=int(len(cp)))


def in_extreme(cgo: pd.Series, side: str, bp: dict) -> pd.Series:
    return cgo > bp["p80"] if side == "high" else cgo < bp["p20"]


def entries(feats: pd.DataFrame, side: str, bp: dict) -> pd.DataFrame:
    """Entries: the first decision point per mint per UTC day that is eligible, in time, and in the extreme."""
    e = eligible(feats)
    return first_per_mint_day(e[in_extreme(e.cgo, side, bp)])


def _registered(out: pd.DataFrame) -> pd.DataFrame:
    """Registered trades only ($50, 60 min) that were priced: a refused entry is no trade; a refused exit stays
    (it received nothing)."""
    o = out[(out.hold == HOLD_S) & (out.usd == TRADE_USD)]
    return o[o.status.isin(["ok", "exit_refused"])]


def _join(sel: pd.DataFrame, out: pd.DataFrame) -> pd.DataFrame:
    return sel[["mint", "decision_slot"]].merge(_registered(out), on=["mint", "decision_slot"], how="inner")


def sign_and_futility(feats: pd.DataFrame, out: pd.DataFrame) -> dict:
    """§7 on discovery days: lift = mean gross 60-minute return of entries minus that of all eligible decision points,
    for each extreme; the sign is the extreme with the larger lift; futility if that lift < the median round-trip cost
    (fees + impact both legs + fixed, as a share of the SOL paid) of the discovery trades at $50 in that extreme."""
    _check_days(feats, DISCOVERY_DAYS, "sign_and_futility")
    bp = breakpoints(feats)
    base = _join(eligible(feats), out)
    res = dict(breakpoints=bp, baseline_n=int(len(base)), baseline_gross=float(base.gross.mean()))
    lifts = {}
    for side in ("high", "low"):
        t = _join(entries(feats, side, bp), out)
        lifts[side] = float(t.gross.mean() - base.gross.mean()) if len(t) else float("nan")
        res[f"{side}_n"] = int(len(t))
        res[f"{side}_gross"] = float(t.gross.mean()) if len(t) else float("nan")
        res[f"{side}_median_cost"] = float(t.cost_ret.median()) if len(t) else float("nan")
    finite = {k: v for k, v in lifts.items() if np.isfinite(v)}
    side = max(finite, key=finite.get) if finite else None
    res.update(lift_high=lifts["high"], lift_low=lifts["low"], sign=side)
    if side is None:
        res.update(futile=True, verdict="closed: no discovery trades")
    else:
        futile = not (lifts[side] >= res[f"{side}_median_cost"])
        res.update(futile=futile, verdict="closed: not supported (futility)" if futile else "continue")
    return res


def cluster_bootstrap(day: np.ndarray, pool: np.ndarray, x: np.ndarray, n=BOOT_RESAMPLES, seed=BOOT_SEED) -> np.ndarray:
    """Means of x over `n` resamples: within each day, pools are drawn with replacement (all of a drawn pool's trades
    come along), and the resampled trades of all days are pooled."""
    rng = np.random.default_rng(seed)
    sums = np.zeros(n)
    cnts = np.zeros(n)
    for d in sorted(set(day)):
        m = day == d
        pools, inv = np.unique(pool[m], return_inverse=True)
        s = np.bincount(inv, weights=x[m], minlength=len(pools))
        c = np.bincount(inv, minlength=len(pools)).astype(float)
        idx = rng.integers(0, len(pools), size=(n, len(pools)))
        sums += s[idx].sum(axis=1)
        cnts += c[idx].sum(axis=1)
    return sums / cnts


def interval(boot: np.ndarray, level: float) -> tuple:
    a = (1 - level) / 2
    lo, hi = np.percentile(boot, [100 * a, 100 * (1 - a)])
    return float(lo), float(hi)


def primary(feats: pd.DataFrame, out: pd.DataFrame, frozen: dict) -> dict:
    """§8 on validation days: mean net return per trade in SOL for entries in the frozen extreme, pooled; pool-clustered
    bootstrap stratified by day (10,000, fixed seed), 99.5% and 95% two-sided; pass needs all four conditions."""
    _check_days(feats, VALIDATION_DAYS, "primary")
    if frozen.get("sign") not in ("high", "low") or "p20" not in frozen.get("breakpoints", {}):
        raise ValueError("primary needs the frozen sign and breakpoints from discovery")
    bp, side = frozen["breakpoints"], frozen["sign"]
    t = _join(entries(feats, side, bp), out)
    base = _join(eligible(feats), out)
    sol = t.net_lamports.to_numpy(float) / 1e9
    n = len(t)
    res = dict(sign=side, n_trades=int(n), n_baseline=int(len(base)))
    if n == 0:
        res.update(verdict="unresolved" if n < MIN_TRADES else "not supported")
        return res
    boot = cluster_bootstrap(t.decision_day.to_numpy(), t.pool.to_numpy(), sol)
    lo, hi = interval(boot, CI_PRIMARY)
    lo95, hi95 = interval(boot, CI_SECONDARY)
    per_day = t.groupby("decision_day").net_lamports.mean() / 1e9
    days_ok = all(per_day.get(d, float("nan")) > 0 for d in sorted(set(feats.decision_day)))
    lift = float(sol.mean() - base.net_lamports.mean() / 1e9)
    res.update(mean_net_sol=float(sol.mean()), mean_net_ret=float(t.net_ret.mean()), ci995=(lo, hi), ci95=(lo95, hi95),
               per_day_mean_sol={k: float(v) for k, v in per_day.items()}, lift_net_sol=lift,
               conditions=dict(lower995_above_0=lo > 0, at_least_300=n >= MIN_TRADES, every_day_above_0=days_ok,
                               lift_above_0=lift > 0))
    if all(res["conditions"].values()):
        res["verdict"] = "pass"
    elif n < MIN_TRADES:
        res["verdict"] = "unresolved"
    else:
        res["verdict"] = "not supported"
    return res


def secondary(feats: pd.DataFrame, out: pd.DataFrame, frozen: dict) -> dict:
    """§10, reported, never judged: other holds, the five CGO quintiles, other sizes (gross, fixed, % fees and impact
    shown apart), and CGO on holders who bought only after migration."""
    bp, side = frozen["breakpoints"], frozen["sign"]
    e = eligible(feats)
    sel = entries(feats, side, bp)
    ok = out[out.status.isin(["ok", "exit_refused"])]
    res = {}
    for hold in sorted(set(ok.hold)):
        t = sel[["mint", "decision_slot"]].merge(ok[(ok.hold == hold) & (ok.usd == TRADE_USD)], on=["mint", "decision_slot"])
        res[f"hold_{hold}"] = dict(n=int(len(t)), mean_net_sol=float(t.net_lamports.mean() / 1e9) if len(t) else None,
                                   mean_gross=float(t.gross.mean()) if len(t) else None)
    q = pd.cut(e.cgo, [-np.inf, bp["p20"], bp["p40"], bp["p60"], bp["p80"], np.inf], labels=[1, 2, 3, 4, 5])
    reg = _registered(out)
    for k in range(1, 6):
        t = first_per_mint_day(e[q == k])[["mint", "decision_slot"]].merge(reg, on=["mint", "decision_slot"])
        res[f"quintile_{k}"] = dict(n=int(len(t)), mean_net_sol=float(t.net_lamports.mean() / 1e9) if len(t) else None,
                                    mean_gross=float(t.gross.mean()) if len(t) else None)
    for usd in sorted(set(ok.usd)):
        t = sel[["mint", "decision_slot"]].merge(ok[(ok.hold == HOLD_S) & (ok.usd == usd)], on=["mint", "decision_slot"])
        if len(t):
            res[f"size_{usd:g}"] = dict(n=int(len(t)), gross=float(t.gross.mean()),
                                        fixed_pct=float((t.fixed / t.paid).mean()),
                                        fees_pct=float(((t.entry_fees + t.exit_fees) / t.paid).mean()),
                                        impact_pct=float(((t.entry_impact + t.exit_impact) / t.paid).mean()),
                                        mean_net_sol=float(t.net_lamports.mean() / 1e9))
    post = e.dropna(subset=["cgo_post"])
    pbp = dict(p20=bp.get("post_p20", float("nan")), p80=bp.get("post_p80", float("nan")))
    t = first_per_mint_day(post[in_extreme(post.cgo_post, side, pbp)])[["mint", "decision_slot"]].merge(
        reg, on=["mint", "decision_slot"])
    res["cgo_post"] = dict(n_points=int(len(post)), corr_with_cgo=float(post.cgo.corr(post.cgo_post)) if len(post) > 2 else None,
                           n_trades=int(len(t)), mean_net_sol=float(t.net_lamports.mean() / 1e9) if len(t) else None)
    return res
