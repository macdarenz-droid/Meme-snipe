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
    if feats.empty or "eligible" not in feats.columns:
        return dict(days=list(days), eligible_points=0, eligible_first_per_mint_day=0, per_day_first=0.0,
                    per_day_all=0.0, a_pass=False, b_pass=False, c_pass=False, passed=False,
                    reason="no decision points")
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
    # R2-4: the gate is judged on both Step A days only; a run on part of them reports its rows but never passes
    whole = sorted(days) == sorted(DISCOVERY_DAYS)
    return dict(days=list(days), eligible_points=n_all, eligible_first_per_mint_day=n_dedup,
                per_day_first=n_dedup / n_days if n_days else 0.0, per_day_all=n_all / n_days if n_days else 0.0,
                a_pass=bool(a_ok), r2_simple=r2_simple, r2_log=r2_log, n_regression=int(len(z)), b_pass=b_ok,
                p20=float(p20), p80=float(p80), spread=float(p80 - p20), c_pass=c_ok, whole_discovery=whole,
                passed=bool(a_ok and b_ok and c_ok and whole))


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


def _judge(t: pd.DataFrame, base: pd.DataFrame, extra: dict = None) -> dict:
    """The §8 statistic and the four pass conditions for trades `t` against the baseline `base`; `extra` adds
    conditions (name -> bool) that a pass also needs."""
    sol = t.net_lamports.to_numpy(float) / 1e9
    n = len(t)
    res = dict(n_trades=int(n), n_baseline=int(len(base)))
    if n == 0:
        res.update(verdict="unresolved")
        return res
    boot = cluster_bootstrap(t.decision_day.to_numpy(), t.pool.to_numpy(), sol)
    lo, hi = interval(boot, CI_PRIMARY)
    lo95, hi95 = interval(boot, CI_SECONDARY)
    per_day = t.groupby("decision_day").net_lamports.mean() / 1e9
    days_ok = all(per_day.get(d, float("nan")) > 0 for d in VALIDATION_DAYS)
    lift = float(sol.mean() - base.net_lamports.mean() / 1e9)
    res.update(mean_net_sol=float(sol.mean()), mean_net_ret=float(t.net_ret.mean()), ci995=(lo, hi), ci95=(lo95, hi95),
               per_day_mean_sol={k: float(v) for k, v in per_day.items()}, lift_net_sol=lift,
               conditions=dict(lower995_above_0=lo > 0, at_least_300=n >= MIN_TRADES, every_day_above_0=days_ok,
                               lift_above_0=lift > 0, **(extra or {})))
    if all(res["conditions"].values()):
        res["verdict"] = "pass"
    elif n < MIN_TRADES:
        res["verdict"] = "unresolved"
    else:
        res["verdict"] = "not supported"
    return res


def _frozen_rule(feats, frozen, decision_days):
    _check_days(feats, VALIDATION_DAYS, "primary")
    if list(decision_days) != list(VALIDATION_DAYS):
        raise ValueError(f"primary needs exactly the validation days {VALIDATION_DAYS}; got {list(decision_days)}")
    if frozen.get("sign") not in ("high", "low") or "p20" not in frozen.get("breakpoints", {}):
        raise ValueError("primary needs the frozen sign and breakpoints from discovery")
    return frozen["breakpoints"], frozen["sign"]


def primary(feats: pd.DataFrame, out: pd.DataFrame, frozen: dict, decision_days) -> dict:
    """§8 on validation days: mean net return per trade in SOL for entries in the frozen extreme, pooled; pool-clustered
    bootstrap stratified by day (10,000, fixed seed), 99.5% and 95% two-sided; pass needs all four conditions."""
    bp, side = _frozen_rule(feats, frozen, decision_days)
    res = dict(sign=side)
    res.update(_judge(_join(entries(feats, side, bp), out), _join(eligible(feats), out)))
    return res


def h8_stratum(feats: pd.DataFrame, out: pd.DataFrame, frozen: dict, decision_days, sol) -> dict:
    """H8_AMENDMENT items 1-3 as corrected by H8_AMENDMENT_2: H1-CGO's primary on the stratum the bot could trade at $5,
    $20 and $50 (entries of the frozen rule whose decision point passes, at that size, the floor of the universe the bot
    would tag, with H6, H11 and the dust check; priced at that size). Tradable as the bot stands only with at least 300
    validation trades and a positive mean at $5, the trial maximum; $20 and $50 are research lines."""
    from . import h8 as H8
    bp, side = _frozen_rule(feats, frozen, decision_days)
    f = H8.flags(feats, sol)
    ok = out[out.status.isin(["ok", "exit_refused"]) & (out.hold == HOLD_S)]
    res = {}
    for s in H8.SIZES_USD:
        # AMENDMENT_6: H8 first (each decision point's own as-of flag), then the first eligible entry per coin per day
        e = entries(f[f[f"h8_{s}"]], side, bp)
        t = e[["mint", "decision_slot"]].merge(ok[ok.usd == float(s)], on=["mint", "decision_slot"])
        base = f[f.eligible & f[f"in_time_{HOLD_S}"] & f[f"h8_{s}"]][["mint", "decision_slot"]].merge(
            ok[ok.usd == float(s)], on=["mint", "decision_slot"])
        r = _judge(t, base)
        if s != H8.TRADABLE_SIZE_USD:
            r["line"] = "research: needs the owner to raise maxNotional"
        res[f"${s}"] = r
    r5 = res[f"${H8.TRADABLE_SIZE_USD}"]
    tradable = bool(r5["n_trades"] >= MIN_TRADES and r5.get("mean_net_sol", 0) > 0)
    res["tradable_as_bot_stands"] = tradable
    res["note"] = None if tradable else "this works only in pools below H8's floor"
    res["sol_usd_files"] = sol.files
    return res


def _rank(x):
    from scipy.stats import rankdata
    return rankdata(x)


def spearman(x, y) -> float:
    rx, ry = _rank(x), _rank(y)
    if rx.std() == 0 or ry.std() == 0:
        return float("nan")
    return float(np.corrcoef(rx, ry)[0, 1])


def partial_spearman(x, y, controls) -> float:
    """Spearman partial correlation: ranks of x and y, each regressed on the ranks of the controls (with an intercept);
    the correlation of the residuals."""
    C = np.column_stack([np.ones(len(x))] + [_rank(c) for c in controls])
    def resid(v):
        b, *_ = np.linalg.lstsq(C, v, rcond=None)
        return v - C @ b
    a, b = resid(_rank(x)), resid(_rank(y))
    return float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else float("nan")


def cluster_bootstrap_stat(day, pool, stat, n=BOOT_RESAMPLES, seed=BOOT_SEED) -> np.ndarray:
    """stat(index array) over resamples that draw pools with replacement within each day."""
    rng = np.random.default_rng(seed)
    groups = []
    for d in sorted(set(day)):
        m = np.flatnonzero(day == d)
        pools = {}
        for i in m:
            pools.setdefault(pool[i], []).append(i)
        groups.append([np.array(v) for v in pools.values()])
    out = np.empty(n)
    for k in range(n):
        idx = np.concatenate([g[j] for g in groups for j in rng.integers(0, len(g), size=len(g))])
        out[k] = stat(idx)
    return out


D60_GATE = dict(habit_share=0.60, rho=0.3, r2_max=0.3, partial_rho=0.2, traceable=0.90)


def d60_sample(feats: pd.DataFrame, flows: pd.DataFrame) -> pd.DataFrame:
    e = eligible(feats)
    e = e[e.d60.notna()].merge(flows[["mint", "decision_slot", "sell_tokens", "net_flow_sol"]], on=["mint", "decision_slot"])
    flt = (e.known_tokens + e.unknown_tokens).astype(float)
    return e.assign(float_tokens=flt, sells_frac=e.sell_tokens / flt)


def d60_gate(feats: pd.DataFrame, flows: pd.DataFrame, n_boot=BOOT_RESAMPLES) -> dict:
    """AMENDMENT_3 gate rows on the Step A days (flows and holdings only): habit share >= 60%; Spearman(D60, next-hour
    sells) >= 0.3 with a pool-clustered 95% lower bound > 0; R² of D60 on returns, volatility, volume and CGO <= 0.3
    and partial rho (over CGO and 60-minute volume) >= 0.2; traceable float >= 90%; the bottom D60 quintile's mean
    net flow > 0. Also freezes D60's P20 (the arm's bottom quintile)."""
    _check_days(feats, DISCOVERY_DAYS, "d60_gate")
    z = d60_sample(feats, flows)
    res = dict(n=int(len(z)))
    if len(z) < 5:
        res.update(passed=False, reason="too few points")
        return res
    d, y = z.d60.to_numpy(float), z.sells_frac.to_numpy(float)
    res["habit_share"] = float(z.d60_habit_holders.sum() / z.d60_holders.sum())
    res["traceable_float"] = float((z.d60_traceable * z.float_tokens).sum() / z.float_tokens.sum())
    res["rho"] = spearman(d, y)
    boot = cluster_bootstrap_stat(z.decision_day.to_numpy(), z.pool.to_numpy(), lambda i: spearman(d[i], y[i]), n=n_boot)
    res["rho_lower95"] = float(np.nanpercentile(boot, 2.5))
    X = z[["r_1h", "r_6h", "r_mig", "vol_1h", "volume_1h", "cgo"]].to_numpy(float)
    ok = np.isfinite(X).all(axis=1)
    res["r2_controls"] = r2(d[ok], X[ok]) if ok.sum() > 7 else float("nan")
    res["partial_rho"] = partial_spearman(d, y, [z.cgo.to_numpy(float), z.volume_1h.to_numpy(float)])
    p20 = float(np.percentile(d, 20))
    res["d60_p20"] = p20
    res["bottom_quintile_mean_net_flow_sol"] = float(z[z.d60 <= p20].net_flow_sol.mean() / 1e9)
    G = D60_GATE
    res["rows"] = dict(habit=res["habit_share"] >= G["habit_share"],
                       rho=res["rho"] >= G["rho"] and res["rho_lower95"] > 0,
                       independence=res["r2_controls"] <= G["r2_max"] and res["partial_rho"] >= G["partial_rho"],
                       traceable=res["traceable_float"] >= G["traceable"],
                       bottom_net_flow=res["bottom_quintile_mean_net_flow_sol"] > 0)
    res["passed"] = bool(all(res["rows"].values()))
    return res


def d60_arm(feats: pd.DataFrame, out: pd.DataFrame, frozen: dict, decision_days, primary_res: dict) -> dict:
    """AMENDMENT_3 arm: H1-CGO's frozen rule restricted to D60's bottom quintile (D60 <= the frozen P20). Judged only if
    the D60 gate passed on Step A and H1-CGO's primary passes; then as one more loop-family test with the §8
    conditions plus a lift over H1-CGO's own entries above 0."""
    bp, side = _frozen_rule(feats, frozen, decision_days)
    g = frozen.get("d60") or {}
    if not g.get("passed"):
        return dict(verdict="not judged: the D60 gate did not pass on Step A")
    if primary_res.get("verdict") != "pass":
        return dict(verdict="not judged: H1-CGO's primary did not pass")
    e = eligible(feats)
    sel = first_per_mint_day(e[in_extreme(e.cgo, side, bp) & (e.d60 <= g["d60_p20"])])
    t = _join(sel, out)
    h1 = _join(entries(feats, side, bp), out)
    lift_h1 = float(t.net_lamports.mean() / 1e9 - h1.net_lamports.mean() / 1e9) if len(t) else float("nan")
    res = _judge(t, _join(e, out), extra=dict(lift_over_h1cgo_above_0=bool(lift_h1 > 0)))
    res["lift_over_h1cgo_sol"] = lift_h1
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
