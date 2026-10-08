"""The payer-mass bar (research/brainstorm-loop/PAYER_MASS.md, defined per event by COUNT_ROWS_AMENDMENT_7 Q-R1-a).

Per event i (COUNT_ROWS_AMENDMENT_8: every comparison in shares of the event's own Q, s*_i = sqrt(1 + c_i) - 1 = X*_i / Q_i):
X*_i = Q_i x (sqrt(1 + c_i) - 1), with Q_i the event's own effective quote (vault + signed virtual reserves)
at its decision slot and c_i the round trip at $5 in that pool:
  2 x the tier fee the program applies at that market cap
  + the constant-product impact of a $5 buy and its sell at Q (x^2 / (Q + x) on the buy, x^2 / Q on the sell, vs spot)
  + 414,009 lamports / x,
with x = $5 = 41,925,205 lamports. The bar passes only if the median of payer flow_i / X*_i is at least 1 and on average
at least 11 events a day have payer flow_i >= 2 X*_i. An undefined flow or X* never helps (it counts as minus infinity
in the median and is never at 2 X*).
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

SPEND_5USD = 41_925_205          # floor(5 / 119.26 * 1e9)
FIXED_LAMPORTS = 414_009
MEDIAN_MIN = 1.0
EVENTS_AT_2X_PER_DAY = 11
FEE_CONFIG = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "edge", "snapshot",
                                           "fee-configs.json"))


def _tiers(path=FEE_CONFIG):
    with open(path) as f:
        t = json.load(f)["amm"]["fee_tiers"]
    th = np.array([int(x["market_cap_lamports_threshold"]) for x in t], dtype=float)
    tot = np.array([sum(int(v) for v in x["fees"].values()) for x in t], dtype=float)
    return th, tot


TIERS = _tiers()


def tier_bps(mcap_lamports: float) -> float:
    """Total fee (lp + protocol + creator) of the last tier whose threshold is <= the cap (fees.ts selectFeeTier)."""
    th, tot = TIERS
    return float(tot[max(int(np.searchsorted(th, mcap_lamports, side="right")) - 1, 0)])


def round_trip_cost(q, eff_for_cap, base, supply, x=SPEND_5USD) -> float:
    """c at $5 for an event with effective quote q (lamports); the tier uses the cap eff_for_cap x supply / base."""
    vals = np.array([q, eff_for_cap, base, supply], dtype=float)
    if not np.all(np.isfinite(vals)) or q <= 0 or base <= 0 or supply <= 0:
        return float("nan")
    fee = tier_bps(eff_for_cap * supply / base) / 1e4
    impact = x * x / (q + x) + x * x / q
    return 2 * fee + impact / x + FIXED_LAMPORTS / x


def x_star(q, c) -> float:
    return float(q * (np.sqrt(1 + c) - 1)) if np.isfinite(q) and np.isfinite(c) else float("nan")


def bar(flows, xstars, event_days, days) -> dict:
    """The bar over events (flows and X* in lamports), with the loaded days for the per-day average."""
    f = np.asarray(flows, float)
    xs = np.asarray(xstars, float)
    n_days = len(set(days))
    if not len(f) or not n_days:
        return {"passed": None, "status": "not computed: no events", "events": int(len(f))}
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = f / xs
    ok = np.isfinite(ratio) & (xs > 0)
    ratio = np.where(ok, ratio, -np.inf)
    med = float(np.median(ratio))
    at2 = int((ok & (f >= 2 * xs)).sum())
    per_day = at2 / n_days
    return {"passed": bool(med >= MEDIAN_MIN and per_day >= EVENTS_AT_2X_PER_DAY), "events": int(len(f)),
            "events_undefined": int((~ok).sum()), "median_ratio": med, "events_at_2x": at2,
            "events_at_2x_per_day": per_day, "days": n_days,
            "by_day": {d: int(((np.asarray(event_days) == d) & ok & (f >= 2 * xs)).sum()) for d in sorted(set(days))}}


def s_star(c) -> float:
    """COUNT_ROWS_AMENDMENT_8: the bar in shares of the event's own Q, s* = X* / Q = sqrt(1 + c) - 1."""
    return float(np.sqrt(1 + c) - 1) if np.isfinite(c) else float("nan")


def share_bar(excess, sstar, event_days, days) -> dict:
    """AMENDMENT_8: amendment 7's two conditions on excess shares against s*: median(excess / s*) >= 1, and on average
    at least 11 events a day with excess >= 2 s*."""
    return bar(excess, sstar, event_days, days)


def seat_drift_bar(sd: pd.DataFrame, days) -> dict:
    """SEAT-DRIFT (AMENDMENT_7, in shares per AMENDMENT_8): excess share = the busy graduate's first-time buyer SOL in
    (m + 60 min + 23 slots, m + 120 min] / its Q, minus the median of the same share over the lone graduates of that
    day; Q, base and supply from the pool's as-of state at m + 60 min. A day without lone graduates leaves the excess
    undefined, which never helps."""
    cols = ["pool", "day", "excess_share", "Q", "c", "s_star"]
    if not len(sd) or "tercile" not in sd:
        return {**share_bar([], [], [], days), "events": pd.DataFrame(columns=cols)}
    ok = sd[sd["dropped"] == ""]
    busy, lone = ok[ok["tercile"] == 2], ok[ok["tercile"] == 0]
    lone_med = lone.groupby("day")["w1_share"].median()
    rows = []
    for r in busy.itertuples(index=False):
        c = round_trip_cost(r.w1_eff_quote, r.w1_eff_quote, r.w1_base, r.w1_supply)
        rows.append({"pool": r.pool, "day": r.day, "excess_share": float(r.w1_share - lone_med.get(r.day, np.nan)),
                     "Q": float(r.w1_eff_quote), "c": c, "s_star": s_star(c)})
    ev = pd.DataFrame(rows, columns=cols)
    out = share_bar(ev["excess_share"], ev["s_star"], ev["day"], days)
    out["events"] = ev
    return out


def q_terciles(q: np.ndarray) -> np.ndarray:
    """Tercile of each Q in its own set: cuts at the 1/3 and 2/3 quantiles (numpy linear); a value on a cut goes to the
    lower bin (the count rows' rule, COUNT_ROWS_AMENDMENT_2)."""
    q = np.asarray(q, float)
    if len(q) < 3:
        return np.zeros(len(q), int)
    c1, c2 = np.quantile(q, [1 / 3, 2 / 3])
    return np.where(q <= c1, 0, np.where(q <= c2, 1, 2))


def dev_zero_bar(dz: pd.DataFrame, days) -> dict:
    """DEV-ZERO (AMENDMENT_8 Q-R1-e), per arm. Matched controls: the arm's primary controls on the same UTC day and in the
    same effective-quote tercile as of the event. The terciles are cut over the arm's used events and controls of that
    day together (a reading the amendment leaves open: CODE_REDTEAM.md Q-R1-i). Excess share = net / Q (the row's
    `net` is already a share of the effective quote just after the dev's sale) minus the matched controls' median.
    An event with no matched control is left out of the bar and counted."""
    cols = ["pool", "day", "excess_share", "Q", "c", "s_star"]
    out = {}
    for arm in ("le5", "zero", "le3"):
        a = dz[(dz.get("arm") == arm) & (dz["dropped"] == "")] if len(dz) else dz
        a = a[a["net"].notna() & a["eff_quote"].notna()] if len(a) else a
        rows, missing = [], 0
        for d, g in (a.groupby("day") if len(a) else []):
            g = g.assign(qt=q_terciles(g["eff_quote"].to_numpy(float)))
            for e in g[g["kind"] == "event"].itertuples(index=False):
                ctl = g[(g["kind"] == "control") & (g["qt"] == e.qt)]
                if not len(ctl):
                    missing += 1
                    continue
                c = round_trip_cost(e.eff_quote, e.eff_quote, e.base, e.supply)
                rows.append({"pool": e.pool, "day": d, "excess_share": float(e.net - ctl["net"].median()),
                             "Q": float(e.eff_quote), "c": c, "s_star": s_star(c)})
        ev = pd.DataFrame(rows, columns=cols)
        r = share_bar(ev["excess_share"], ev["s_star"], ev["day"], days)
        r.update(events=ev, events_without_matched_control=missing, reading_pending="Q-R1-i (Q tercile population)")
        out[arm] = r
    return out
