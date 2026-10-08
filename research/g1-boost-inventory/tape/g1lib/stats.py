"""Statistics registered in PREREG §8–§9 and the amendments' gates."""
import math
import warnings
from typing import Dict, Optional

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from . import params as P


def cluster_bootstrap_means(values: np.ndarray, clusters: np.ndarray, strata: np.ndarray,
                            n: int = P.BOOTSTRAP_RESAMPLES, seed: int = P.BOOTSTRAP_SEED) -> np.ndarray:
    """PREREG §9: pool-clustered bootstrap stratified by day. Within each day, pools are drawn with replacement
    (as many as the day has); the statistic is the mean per trade over all drawn trades."""
    rng = np.random.default_rng(seed)
    values = np.asarray(values, dtype=float)
    sums = np.zeros(n)
    counts = np.zeros(n)
    for s in pd.unique(strata):
        m = strata == s
        cl = pd.Series(values[m]).groupby(clusters[m])
        csum = cl.sum().to_numpy()
        ccnt = cl.size().to_numpy().astype(float)
        k = len(csum)
        idx = rng.integers(0, k, size=(n, k))
        sums += csum[idx].sum(axis=1)
        counts += ccnt[idx].sum(axis=1)
    return sums / counts


def interval(boot: np.ndarray, alpha: float):
    return float(np.quantile(boot, alpha / 2)), float(np.quantile(boot, 1 - alpha / 2))


def primary(trades: pd.DataFrame, control: Optional[pd.DataFrame] = None, lift_over: Optional[Dict[str, pd.DataFrame]] = None,
            required_days=None) -> dict:
    """PREREG §9 on filled trades (columns ret, day, mint). Returns the statistic, both intervals and the verdict.
    `control` is S0 (point lift above 0 required); `lift_over` adds further required point lifts (amendments)."""
    t = trades[trades["filled"]].copy()
    n = len(t)
    out = {"n_filled": n}
    if n == 0:
        out.update({"mean": math.nan, "verdict": "unresolved"})
        return out
    boot = cluster_bootstrap_means(t["ret"].to_numpy(), t["mint"].to_numpy(), t["day"].to_numpy())
    out["mean"] = float(t["ret"].mean())
    out["ci_99_5"] = interval(boot, P.ALPHA_FAMILY)
    out["ci_95"] = interval(boot, P.ALPHA_SHOWN)
    out["per_day_mean"] = {str(k): float(v) for k, v in t.groupby("day")["ret"].mean().items()}
    lifts = {}
    if control is not None:
        c = control[control["filled"]]
        lifts["S0"] = out["mean"] - float(c["ret"].mean()) if len(c) else math.nan
    for k, v in (lift_over or {}).items():
        v = v[v["filled"]]
        lifts[k] = out["mean"] - float(v["ret"].mean()) if len(v) else math.nan
    out["lifts"] = lifts
    # every required (validation) day must be present with a mean above 0 (review finding 3)
    days = list(required_days) if required_days is not None else list(out["per_day_mean"])
    out["missing_days"] = [x for x in days if x not in out["per_day_mean"]]
    per_day_ok = not out["missing_days"] and all(out["per_day_mean"][x] > 0 for x in days) \
        and all(x > 0 for x in out["per_day_mean"].values())
    passed = (out["ci_99_5"][0] > 0 and n >= P.MIN_FILLED_TRADES and per_day_ok
              and all((x > 0) for x in lifts.values()) and len(lifts) > 0)
    out["verdict"] = "pass" if passed else ("unresolved" if n < P.MIN_FILLED_TRADES else "not supported")
    return out


def futility(trades: pd.DataFrame) -> dict:
    """PREREG §8: on discovery days, G1 closes if the one-sided 95% upper bound of the primary is below 0."""
    t = trades[trades["filled"]]
    if not len(t):
        return {"n_filled": 0, "upper_95_one_sided": math.nan, "closes": False}
    boot = cluster_bootstrap_means(t["ret"].to_numpy(), t["mint"].to_numpy(), t["day"].to_numpy())
    ub = float(np.quantile(boot, 0.95))
    return {"n_filled": len(t), "upper_95_one_sided": ub, "closes": ub < 0}


def spearman_boot(x: np.ndarray, y: np.ndarray, clusters: np.ndarray, strata: np.ndarray,
                  n: int = P.BOOTSTRAP_RESAMPLES, seed: int = P.BOOTSTRAP_SEED) -> dict:
    """Spearman rho with one-sided 95% bounds from a pool-clustered bootstrap stratified by day (OQ-15)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = ~(np.isnan(x) | np.isnan(y))
    x, y, clusters, strata = x[ok], y[ok], np.asarray(clusters)[ok], np.asarray(strata)[ok]
    if len(x) < 3:
        return {"n": int(len(x)), "rho": math.nan, "lower_95": math.nan, "upper_95": math.nan}
    rho = float(spearmanr(x, y).statistic)
    rng = np.random.default_rng(seed)
    groups = []
    for s in pd.unique(strata):
        m = np.flatnonzero(strata == s)
        cl = pd.Series(m).groupby(clusters[m]).apply(lambda v: v.to_numpy())
        groups.append(list(cl.values))
    reps = np.empty(n)
    warnings.simplefilter("ignore")
    for b in range(n):
        idx = np.concatenate([np.concatenate([g[i] for i in rng.integers(0, len(g), len(g))]) for g in groups])
        r = spearmanr(x[idx], y[idx]).statistic
        reps[b] = r if not np.isnan(r) else 0.0
    return {"n": int(len(x)), "rho": rho, "lower_95": float(np.quantile(reps, 0.05)), "upper_95": float(np.quantile(reps, 0.95))}
