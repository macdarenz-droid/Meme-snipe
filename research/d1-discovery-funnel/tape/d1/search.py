"""PREREG §5: the fixed search on the discovery days.

- Folds: each discovery day is split into four 6-hour UTC blocks (00-06, 06-12, 12-18, 18-24). Fold j holds out block
  j of every discovery day (four folds, as "the same in all four folds" requires). Training points are those of the
  other blocks whose whole window [tau, exit] stays more than 60 minutes away from every held-out block instance
  (CONSERVATIVE: the gap also covers the training trade's hold, so no training outcome overlaps the held-out block).
- Only decision points whose hold arm is inside the tape (`valid_<h>`) and whose entry filled are used.
- Candidates per hold: 56 single-feature rules (feature in its top or bottom quintile) and 1,512 two-feature rules
  (378 pairs x 4 extreme combinations). Quintile edges (numpy linear 20th and 80th percentiles of the feature over the
  fold's training points, NaN left out); top = x >= q80, bottom = x <= q20; NaN is in neither.
- Entries: at most one per pool per rolling hour (greedy, chronological), applied to each fold's held-out points.
- Score: mean out-of-fold net return per trade (pooled over the four folds). A rule qualifies when every fold has at
  least 30 trades, its fold means have the same sign in all four folds, and its score is not below the median
  round-trip cost of the discovery trades.
- Advance at most 5 rules (over both holds) by score; freeze their definitions and full-discovery quintile edges.
"""
import itertools
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

from . import config as C

Rule = Tuple[Tuple[str, ...], Tuple[str, ...]]  # (features, sides) with side in {"top", "bottom"}


def all_rules() -> List[Rule]:
    rules: List[Rule] = [((f,), (s,)) for f in C.FEATURES for s in ("top", "bottom")]
    for f1, f2 in itertools.combinations(C.FEATURES, 2):
        for s1 in ("top", "bottom"):
            for s2 in ("top", "bottom"):
                rules.append(((f1, f2), (s1, s2)))
    assert len(rules) == 56 + 1512
    return rules


def rule_id(rule: Rule) -> str:
    return " & ".join(f"{f}:{s}" for f, s in zip(*rule))


def edges_of(x: np.ndarray) -> Tuple[float, float]:
    x = x[~np.isnan(x)]
    if len(x) == 0:
        return (np.nan, np.nan)
    lo, hi = np.quantile(x, [C.Q_LOW, C.Q_HIGH])
    return (float(lo), float(hi))


def side_mask(x: np.ndarray, edges: Tuple[float, float], side: str) -> np.ndarray:
    lo, hi = edges
    with np.errstate(invalid="ignore"):
        if side == "top":
            return (x >= hi) & ~np.isnan(x)
        return (x <= lo) & ~np.isnan(x)


def throttle(pool: np.ndarray, tau: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Greedy chronological selection, at most one entry per pool per rolling THROTTLE_S. Input sorted by (pool, tau)."""
    idx = np.flatnonzero(mask)
    keep = np.zeros(len(mask), dtype=bool)
    last_pool, last_tau = None, None
    for i in idx:
        p, t = pool[i], tau[i]
        if p != last_pool or t - last_tau >= C.THROTTLE_S:
            keep[i] = True
            last_pool, last_tau = p, t
    return keep


def usable(df: pd.DataFrame, hold_min: int) -> pd.DataFrame:
    d = df[df[f"valid_{hold_min}"].astype(bool) & df.entry_ok.fillna(False).astype(bool)
           & df[f"net_ret_{hold_min}"].notna()]
    return d.sort_values(["pool", "tau"], kind="mergesort").reset_index(drop=True)


def fold_masks(d: pd.DataFrame, j: int, hold_min: int) -> Tuple[np.ndarray, np.ndarray]:
    test = (d.block.to_numpy() == j)
    tau = d.tau.to_numpy()
    ex = d[f"exit_time_{hold_min}"].to_numpy()
    train = ~test
    for day in sorted(d.day.unique()):
        d0 = C.epoch(day) + j * C.BLOCK_S
        lo, hi = d0 - C.FOLD_GAP_S, d0 + C.BLOCK_S + C.FOLD_GAP_S
        train &= (ex < lo) | (tau >= hi)
    return train, test


def median_rt_cost(df: pd.DataFrame) -> float:
    x = df.loc[df.entry_ok.fillna(False).astype(bool), "rt_cost"].to_numpy(dtype=float)
    return float(np.median(x)) if len(x) else float("nan")


def run_search(df: pd.DataFrame) -> Dict:
    """df: eligible discovery points with features, timing and outcomes. Returns the full table and the advanced rules."""
    hurdle = median_rt_cost(df)
    rules = all_rules()
    table = []
    for h in C.HOLDS_S:
        hm = h // 60
        d = usable(df, hm)
        pool, tau, ret = d.pool.to_numpy(), d.tau.to_numpy(), d[f"net_ret_{hm}"].to_numpy(dtype=float)
        X = {f: d[f].to_numpy(dtype=float) for f in C.FEATURES}
        stats = {rule_id(r): [] for r in rules}
        for j in range(C.N_BLOCKS):
            train, test = fold_masks(d, j, hm)
            masks = {}
            for f in C.FEATURES:
                e = edges_of(X[f][train])
                for s in ("top", "bottom"):
                    masks[(f, s)] = side_mask(X[f], e, s) & test
            for r in rules:
                m = masks[(r[0][0], r[1][0])]
                if len(r[0]) == 2:
                    m = m & masks[(r[0][1], r[1][1])]
                k = throttle(pool, tau, m)
                stats[rule_id(r)].append((int(k.sum()), float(ret[k].sum())))
        for r in rules:
            st = stats[rule_id(r)]
            n = np.array([s[0] for s in st])
            sm = np.array([s[1] for s in st])
            means = np.where(n > 0, sm / np.maximum(n, 1), np.nan)
            score = sm.sum() / n.sum() if n.sum() else np.nan
            signs = np.sign(means)
            same = bool(np.all(n > 0) and np.all(signs == signs[0]) and signs[0] != 0)
            ok = bool(np.all(n >= C.MIN_TRADES_PER_FOLD) and same and not np.isnan(score) and score >= hurdle)
            table.append({"rule": rule_id(r), "hold_min": hm, "n_total": int(n.sum()),
                          **{f"n_f{j}": int(n[j]) for j in range(C.N_BLOCKS)},
                          **{f"mean_f{j}": float(means[j]) for j in range(C.N_BLOCKS)},
                          "score": float(score), "same_sign": same, "qualifies": ok})
    tab = pd.DataFrame(table)
    q = tab[tab.qualifies].sort_values(["score", "rule", "hold_min"], ascending=[False, True, True], kind="mergesort")
    adv = q.head(C.N_ADVANCE)
    frozen = []
    for row in adv.itertuples(index=False):
        hm = row.hold_min
        d = usable(df, hm)
        parts = [p.split(":") for p in row.rule.split(" & ")]
        frozen.append({"rule": row.rule, "hold_min": int(hm),
                       "terms": [{"feature": f, "side": s, "edges_q20_q80": list(edges_of(d[f].to_numpy(dtype=float)))}
                                 for f, s in parts],
                       "discovery_score": float(row.score)})
    return {"median_rt_cost": hurdle, "table": tab, "advanced": frozen,
            "outcome": "advance" if frozen else "nothing found"}
