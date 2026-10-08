"""Design A gates (count rule, Gate 2 bunching, Gate 3 creator) on per-pool feature arrays.

Column 0 of every array is the 420 SOL step; columns 1..20 are the placebo cutoffs. Rows are eligible pools.
Gates read no returns. They sit outside the k = 12 family, so they use 95% intervals.
"""
from __future__ import annotations

import numpy as np

COUNT_BAR = 200  # never lowered
STEPS = ("A", "B", "C")
LEVEL = 0.95
DEFAULT_B = 10_000
DEFAULT_SEED = 20261009  # AMENDMENT_2 Q5: registered seed, the same for both gates


def count_rule(n_pools: int, steps_read: tuple[str, ...]) -> dict:
    """At least 200 pools must trade within ±5% of 420. Short: add Step B's days, then Step C's; still short after
    all tape days: A closes as unresolved."""
    if n_pools >= COUNT_BAR:
        return {"n": n_pools, "status": "met"}
    nxt = next((s for s in STEPS if s not in steps_read), None)
    return {"n": n_pools, "status": f"short: add Step {nxt} days" if nxt else "unresolved: A closes"}


def gate2_stat(up: np.ndarray, dn: np.ndarray) -> np.ndarray:
    """log(time in [c, 1.05c) / time in [0.95c, c)) at 420 minus the median of the same at the 20 placebos.

    Pooled over pools (ratio of summed seconds; the shares' common denominator cancels). Works on (P, K) or on
    bootstrap sums (B, K). Non-finite placebo ratios (no time in one or both bands) count as +inf (lowers the statistic);
    a non-finite result is -inf (fails), see OPEN_QUESTIONS Q4.
    """
    U, D = np.atleast_2d(up), np.atleast_2d(dn)
    with np.errstate(divide="ignore", invalid="ignore"):
        lr = np.log(U) - np.log(D)
    main = lr[:, 0]
    plac = np.where(np.isfinite(lr[:, 1:]), lr[:, 1:], np.inf)
    stat = main - np.median(plac, axis=1)
    return np.where(np.isfinite(stat), stat, -np.inf)


def gate3_stat(net: np.ndarray, secs: np.ndarray) -> np.ndarray:
    """Creator net SOL bought per hour inside [399, 441) minus the median of the same in the ±5% bands around each
    placebo. Pooled: summed net SOL / summed hours. Undefined placebo rates count as +inf; a non-finite result is
    -inf (fails)."""
    N, S = np.atleast_2d(net), np.atleast_2d(secs)
    with np.errstate(divide="ignore", invalid="ignore"):
        rate = N / (S / 3600.0)
    main = rate[:, 0]
    plac = np.where(np.isfinite(rate[:, 1:]), rate[:, 1:], np.inf)
    stat = main - np.median(plac, axis=1)
    return np.where(np.isfinite(stat), stat, -np.inf)


def pool_bootstrap(stat_fn, arrays: list[np.ndarray], n_boot: int = DEFAULT_B, seed: int = DEFAULT_SEED,
                   level: float = LEVEL) -> dict:
    """Pool-clustered percentile bootstrap: pools are drawn with replacement; statistics use summed pool rows."""
    P = arrays[0].shape[0]
    point = float(stat_fn(*[a.sum(axis=0, keepdims=True) for a in arrays])[0])
    if P == 0:
        return {"point": -np.inf, "lo": -np.inf, "hi": -np.inf, "n_pools": 0, "n_boot": n_boot, "level": level}
    rng = np.random.default_rng(seed)
    reps = np.empty(n_boot)
    step = max(1, 2_000_000 // max(P, 1))
    for i in range(0, n_boot, step):
        w = rng.multinomial(P, np.full(P, 1.0 / P), size=min(step, n_boot - i)).astype(float)
        reps[i:i + len(w)] = stat_fn(*[w @ a for a in arrays])
    a = (1 - level) / 2
    lo, hi = np.quantile(reps, [a, 1 - a], method="linear")
    return {"point": point, "lo": float(lo), "hi": float(hi), "n_pools": int(P), "n_boot": n_boot, "level": level}


def score_gates(up, dn, net, n_count: int, steps_read: tuple[str, ...], n_boot: int = DEFAULT_B,
                seed: int = DEFAULT_SEED, *, usd_not_separable: bool) -> dict:
    """The registered rule: both gates need a 95% lower bound above 0, else A closes and no return is read.
    Scored only when the count rule is met. AMENDMENT_2 Q11: the verdict reads count row 6; when 420 SOL lies within
    5% of a round USD level on every tape day (`usd_not_separable`), a pass is recorded as not separable from a USD
    level and no return test runs. Row 6 must have been read (True or False); None is refused."""
    if usd_not_separable not in (True, False):
        raise ValueError("Design A's verdict needs count row 6's round-USD result (True or False)")
    cr = count_rule(n_count, steps_read)
    if cr["status"] != "met":
        return {"count_rule": cr, "decision": "not scored: count rule not met", "return_test_may_run": False,
                "usd_not_separable": usd_not_separable}
    secs = up + dn
    g2 = pool_bootstrap(gate2_stat, [up, dn], n_boot, seed)
    g3 = pool_bootstrap(gate3_stat, [net, secs], n_boot, seed)
    g2["pass"] = bool(np.isfinite(g2["point"]) and g2["lo"] > 0)
    g3["pass"] = bool(np.isfinite(g3["point"]) and g3["lo"] > 0)
    ok = g2["pass"] and g3["pass"]
    if ok and usd_not_separable:
        decision = "gates pass, but not separable from a USD level (count row 6): no return test runs"
    elif ok:
        decision = "gates pass: the frozen return test (AMENDMENT_2 Q9) may run"
    else:
        decision = "A closes: no return is read"
    return {"count_rule": cr, "gate2_bunching": g2, "gate3_creator": g3, "usd_not_separable": usd_not_separable,
            "return_test_may_run": bool(ok and not usd_not_separable), "decision": decision}
