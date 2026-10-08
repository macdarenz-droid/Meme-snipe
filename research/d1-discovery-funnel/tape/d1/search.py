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
  least 30 trades and its out-of-fold mean NET return is above 0 in every fold (so the sign is the same in all four;
  AMENDMENT_1 item 24: net already pays costs, so costs are not charged twice). The median round-trip cost is
  reported only.
- Binary features (config.BINARY_FEATURES): top = 1, bottom = 0. A feature whose training q20 equals its q80 gives no
  rule in that fold (AMENDMENT_1 item 23).
- H8 stratum (H8_AMENDMENT, H8_AMENDMENT_2): each rule's out-of-fold trades and mean on the H8-tradable subset (the
  point's universe floor plus the bot's gates as of d, h8.add_h8) at $5, $20 and $50, at that size's own fills,
  throttled inside the subset (`h8_s<usd>_n`, `h8_s<usd>_mean`; per fold for $5).
- AMENDMENT_3: among rules that qualify, those whose $5 H8-tradable subset has >= 30 trades and a positive mean in
  every fold (`h8_first`) are ranked first; the budget of 5 is unchanged and the subset never makes a rule qualify.
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


def side_mask(x: np.ndarray, edges: Tuple[float, float], side: str, binary: bool = False) -> np.ndarray:
    """AMENDMENT_1 item 23: a binary feature's top is 1 and bottom is 0; a feature whose 20th and 80th percentiles are
    equal (in the fold's training points) gives no rule; NaN is in neither extreme."""
    if binary:
        return (x == 1) if side == "top" else (x == 0)
    lo, hi = edges
    if np.isnan(lo) or np.isnan(hi) or lo == hi:
        return np.zeros(len(x), dtype=bool)
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
    median_cost = median_rt_cost(df)  # reported only (AMENDMENT_1 item 24: costs are not charged twice)
    rules = all_rules()
    table = []
    for h in C.HOLDS_S:
        hm = h // 60
        d = usable(df, hm)
        pool, tau, ret = d.pool.to_numpy(), d.tau.to_numpy(), d[f"net_ret_{hm}"].to_numpy(dtype=float)
        X = {f: d[f].to_numpy(dtype=float) for f in C.FEATURES}
        stats = {rule_id(r): [] for r in rules}
        h8 = all(f"h8_s{sz}" in d.columns for sz in C.H8_SIZES_USD)
        h8_arr, h8_stats = {}, {}
        if h8:
            for sz in C.H8_SIZES_USD:
                rs = d.get(f"net_ret_{hm}_s{sz}", pd.Series(np.nan, index=d.index)).to_numpy(dtype=float)
                h8_arr[sz] = (d[f"h8_s{sz}"].to_numpy(dtype=bool) & ~np.isnan(rs), rs)
                for r in rules:
                    h8_stats[(rule_id(r), sz)] = [[0, 0.0] for _ in range(C.N_BLOCKS)]   # per fold: n, sum
        for j in range(C.N_BLOCKS):
            train, test = fold_masks(d, j, hm)
            masks = {}
            for f in C.FEATURES:
                e = edges_of(X[f][train])
                for s in ("top", "bottom"):
                    masks[(f, s)] = side_mask(X[f], e, s, f in C.BINARY_FEATURES) & test
            for r in rules:
                m = masks[(r[0][0], r[1][0])]
                if len(r[0]) == 2:
                    m = m & masks[(r[0][1], r[1][1])]
                k = throttle(pool, tau, m)
                stats[rule_id(r)].append((int(k.sum()), float(ret[k].sum())))
                if h8:
                    for sz, (hm8, rs) in h8_arr.items():   # the bot enters only H8-eligible pools: throttle inside
                        k8 = throttle(pool, tau, m & hm8)
                        h8_stats[(rule_id(r), sz)][j][0] += int(k8.sum())
                        h8_stats[(rule_id(r), sz)][j][1] += float(rs[k8].sum())
        for r in rules:
            st = stats[rule_id(r)]
            n = np.array([s[0] for s in st])
            sm = np.array([s[1] for s in st])
            means = np.where(n > 0, sm / np.maximum(n, 1), np.nan)
            score = sm.sum() / n.sum() if n.sum() else np.nan
            signs = np.sign(means)
            same = bool(np.all(n > 0) and np.all(signs == signs[0]) and signs[0] != 0)
            # AMENDMENT_1 item 24: out-of-fold mean NET return above 0 in every fold, same sign in all four folds
            ok = bool(np.all(n >= C.MIN_TRADES_PER_FOLD) and same and np.all(means > 0))
            row = {"rule": rule_id(r), "hold_min": hm, "n_total": int(n.sum()),
                   **{f"n_f{j}": int(n[j]) for j in range(C.N_BLOCKS)},
                   **{f"mean_f{j}": float(means[j]) for j in range(C.N_BLOCKS)},
                   "score": float(score), "same_sign": same, "qualifies": ok, "h8_first": False,
                   "h8_basis": C.H13_PROXY_LABEL}
            if h8:
                for sz in C.H8_SIZES_USD:
                    fs = h8_stats[(rule_id(r), sz)]
                    n8 = np.array([x[0] for x in fs])
                    s8 = np.array([x[1] for x in fs])
                    row[f"h8_s{sz}_n"] = int(n8.sum())
                    row[f"h8_s{sz}_mean"] = float(s8.sum() / n8.sum()) if n8.sum() else float("nan")
                    if sz == C.H8_TRADABLE_SIZE_USD:
                        m8 = np.where(n8 > 0, s8 / np.maximum(n8, 1), np.nan)
                        row.update({f"h8_s{sz}_n_f{j}": int(n8[j]) for j in range(C.N_BLOCKS)})
                        row.update({f"h8_s{sz}_mean_f{j}": float(m8[j]) for j in range(C.N_BLOCKS)})
                        # AMENDMENT_3: the H8-tradable subset ($5, H8_AMENDMENT_2) has >= 30 trades and a positive
                        # out-of-fold mean in every fold
                        row["h8_first"] = bool(np.all(n8 >= C.MIN_TRADES_PER_FOLD) and np.all(m8 > 0))
            table.append(row)
    tab = pd.DataFrame(table)
    # AMENDMENT_3: among rules that pass the screen, those whose H8-tradable subset passes it too are ranked first;
    # the budget of 5 is unchanged
    q = tab[tab.qualifies].sort_values(["h8_first", "score", "rule", "hold_min"], ascending=[False, False, True, True],
                                       kind="mergesort")
    adv = q.head(C.N_ADVANCE)
    frozen = []
    for row in adv.itertuples(index=False):
        hm = row.hold_min
        d = usable(df, hm)
        parts = [p.split(":") for p in row.rule.split(" & ")]
        frozen.append({"rule": row.rule, "hold_min": int(hm),
                       "terms": [{"feature": f, "side": s, "binary": f in C.BINARY_FEATURES,
                                  "edges_q20_q80": list(edges_of(d[f].to_numpy(dtype=float)))}
                                 for f, s in parts],
                       "discovery_score": float(row.score), "h8_first": bool(row.h8_first),
                       "h8_basis": C.H13_PROXY_LABEL})
    return {"median_rt_cost": median_cost, "table": tab, "advanced": frozen, "h8_basis": C.H13_PROXY_LABEL,
            "outcome": "advance" if frozen else "nothing found"}
