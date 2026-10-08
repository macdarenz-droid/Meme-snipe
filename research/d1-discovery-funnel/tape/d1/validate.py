"""PREREG §6: validation of each advanced rule (one loop-family test at 0.005). Written now, run only after Step A is
complete, the search has frozen its rules in a commit, and a reviewer has passed this code.

Pass, all required: the 99.5% two-sided lower bound of mean net return per trade above 0 (pool-clustered bootstrap
stratified by day, 10,000 resamples, fixed seed; 95% shown beside it); at least 300 trades; mean above 0 on each
validation day (a day with no trade is not above 0, CONSERVATIVE); point lift above 0 over random eligible decision
points with the same hold and costs (their mean over all eligible valid points, the expectation of a random draw,
CONSERVATIVE: no sampling noise). Short of a pass: fewer than 300 trades is "unresolved"; anything else "not supported".
"""
from typing import Dict, Sequence

import numpy as np
import pandas as pd

from . import config as C
from .search import side_mask, throttle, usable


def rule_trades(df: pd.DataFrame, frozen: Dict) -> pd.DataFrame:
    hm = frozen["hold_min"]
    d = usable(df, hm)
    m = np.ones(len(d), dtype=bool)
    for t in frozen["terms"]:
        m &= side_mask(d[t["feature"]].to_numpy(dtype=float), tuple(t["edges_q20_q80"]), t["side"],
                       bool(t.get("binary", t["feature"] in C.BINARY_FEATURES)))
    k = throttle(d.pool.to_numpy(), d.tau.to_numpy(), m)
    out = d[k].copy()
    out["ret"] = out[f"net_ret_{hm}"].astype(float)
    return out


def cluster_bootstrap(ret: np.ndarray, pool: np.ndarray, day: np.ndarray, n_boot: int = C.N_BOOT,
                      seed: int = C.BOOT_SEED) -> np.ndarray:
    """Resampled means: within each day, pools are drawn with replacement; the mean is total return / total trades."""
    rng = np.random.default_rng(seed)
    tot_s = np.zeros(n_boot)
    tot_n = np.zeros(n_boot)
    df = pd.DataFrame({"r": ret, "p": pool, "d": day})
    for _, g in df.groupby("d", sort=True):
        cl = g.groupby("p", sort=True).r.agg(["sum", "count"])
        s, n = cl["sum"].to_numpy(), cl["count"].to_numpy(dtype=float)
        draw = rng.integers(0, len(s), size=(n_boot, len(s)))
        tot_s += s[draw].sum(axis=1)
        tot_n += n[draw].sum(axis=1)
    return tot_s / tot_n


def judge(df: pd.DataFrame, frozen: Dict, days: Sequence[str]) -> Dict:
    tr = rule_trades(df, frozen)
    hm = frozen["hold_min"]
    base = usable(df, hm)
    n = len(tr)
    res = {"rule": frozen["rule"], "hold_min": hm, "n_trades": n}
    if n == 0:
        res["verdict"] = "unresolved"
        return res
    mean = float(tr.ret.mean())
    boots = cluster_bootstrap(tr.ret.to_numpy(), tr.pool.to_numpy(), tr.day.to_numpy())
    lo995, hi995 = np.quantile(boots, [C.ALPHA / 2, 1 - C.ALPHA / 2])
    lo95, hi95 = np.quantile(boots, [0.025, 0.975])
    per_day = {dy: float(tr.loc[tr.day == dy, "ret"].mean()) if (tr.day == dy).any() else float("nan") for dy in days}
    lift = mean - float(base[f"net_ret_{hm}"].astype(float).mean())
    res.update({"mean": mean, "ci995": [float(lo995), float(hi995)], "ci95": [float(lo95), float(hi95)],
                "per_day_mean": per_day, "lift_vs_all_eligible": lift})
    passed = (lo995 > 0) and n >= C.MIN_TRADES_VALIDATION and all(
        not np.isnan(v) and v > 0 for v in per_day.values()) and lift > 0
    res["verdict"] = "pass" if passed else ("unresolved" if n < C.MIN_TRADES_VALIDATION else "not supported")
    res.update(h8_report(df, frozen))
    if res["verdict"] == "pass" and not res["tradable_as_bot_stands"]:
        # H8_AMENDMENT item 3; the unknown share says how much of it is missing evidence rather than the floor
        res["owner_note"] = "this works only in pools below H8's floor"
    return res


def h8_report(df: pd.DataFrame, frozen: Dict) -> Dict:
    """H8_AMENDMENT_2 item 3 (AMENDMENT_3 last item): the rule on the H8-tradable subset (universe floor and the bot's
    gates, h8.add_h8) at $5, $20 and $50, each at its own fills. Tradable as the bot stands only at $5, the trial
    maximum: >= 300 subset trades and a positive point mean. $20 and $50 are research lines that need the owner to
    raise maxNotional. `unknown_share`: of the rule's trades, the share whose gates the tape could not judge."""
    hm = frozen["hold_min"]
    if not all(f"h8_s{s}" in df.columns for s in C.H8_SIZES_USD):
        return {"h8": None, "tradable_as_bot_stands": False}
    d = usable(df, hm)
    m = np.ones(len(d), dtype=bool)
    for t in frozen["terms"]:
        m &= side_mask(d[t["feature"]].to_numpy(dtype=float), tuple(t["edges_q20_q80"]), t["side"],
                       bool(t.get("binary", t["feature"] in C.BINARY_FEATURES)))
    rule_k = throttle(d.pool.to_numpy(), d.tau.to_numpy(), m)
    unk = d["h8_gate_unknown"].to_numpy(dtype=bool) if "h8_gate_unknown" in d else np.ones(len(d), dtype=bool)
    out, tradable = {}, False
    for s in C.H8_SIZES_USD:
        col = f"net_ret_{hm}_s{s}"
        rs = d[col].to_numpy(dtype=float) if col in d.columns else np.full(len(d), np.nan)
        k = throttle(d.pool.to_numpy(), d.tau.to_numpy(), m & d[f"h8_s{s}"].to_numpy(dtype=bool) & ~np.isnan(rs))
        n = int(k.sum())
        mean = float(rs[k].mean()) if n else float("nan")
        out[f"${s}"] = {"n_trades": n, "mean": mean,
                        "role": "bot as it stands" if s == C.H8_TRADABLE_SIZE_USD else "research line (owner: maxNotional)"}
        if s == C.H8_TRADABLE_SIZE_USD:
            tradable = n >= C.MIN_TRADES_VALIDATION and mean > 0
    return {"h8": out, "tradable_as_bot_stands": bool(tradable),
            "unknown_share": float(unk[rule_k].mean()) if rule_k.any() else float("nan")}
