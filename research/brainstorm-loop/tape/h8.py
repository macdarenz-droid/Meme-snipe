"""H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md, frozen): the H8-eligible stratum for count
rows 1-3, and the H8 capacity count row.

H8 (packages/core/src/gates/hard.ts:286-315, policy.ts:205) rejects a pool unless its effective quote
(vault + virtual reserves), valued in USD at the hourly SOL/USD, is at least max($15,000, 1,000 x trade size).
Everything here reads as-of states only (Q14): the effective quote at the row's own decision or event point.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import rebuy as RB
import rows as R
from tapeio import WSOL, Tape

SIZES_USD = (5, 20, 50)
FLOOR_MIN_USD = 15_000.0
FLOOR_PER_USD_TRADED = 1_000.0


def hourly_px(minutes: pd.Series | None) -> dict:
    """{hour start (epoch s): SOL/USD}. The hour's value is the close of the 1-minute bar that ends at the hour
    start (opens at hour start - 60 s), i.e. the last close known when the hour begins (Q23)."""
    if minutes is None or not len(minutes):
        return {}
    out = {}
    for ot, c in minutes.items():
        if (int(ot) + 60) % 3600 == 0:
            out[int(ot) + 60] = float(c)
    return out


def px_asof(hourly: dict, t) -> float:
    return hourly.get(int(t) // 3600 * 3600, np.nan)


def floor_usd(size):
    return max(FLOOR_MIN_USD, FLOOR_PER_USD_TRADED * size)


def eligible(eq_lamports, t, size, hourly) -> bool:
    """True when the effective quote at time t, in USD at that hour's SOL/USD, meets H8's floor at `size`.
    A missing price or effective quote is not eligible (missing evidence means no trade)."""
    px = px_asof(hourly, t)
    if not (np.isfinite(px) and eq_lamports is not None and np.isfinite(eq_lamports)):
        return False
    return eq_lamports / R.LAMPORTS * px >= floor_usd(size)


# ------------------------------------------------------------------ stratum reports for rows 1-3
def no_price(times, hourly):
    return int(sum(1 for t in times if not np.isfinite(px_asof(hourly, t))))


def dev_zero_stratum(dz: pd.DataFrame, days, hourly):
    used = dz[dz["dropped"] == ""] if len(dz) else dz
    out = {"rows_without_sol_usd": no_price(used["block_time"], hourly) if len(used) else 0}
    for size in SIZES_USD:
        if not len(dz) or "eff_quote" not in dz:
            out[f"${size}"] = R.dev_summary(dz.iloc[:0] if len(dz) else dz, days)
            continue
        ok = (dz["dropped"] == "").to_numpy() & np.array(
            [eligible(q, t, size, hourly) for q, t in zip(dz["eff_quote"], dz["block_time"])], bool)
        out[f"${size}"] = R.dev_summary(dz[ok], days)
    return out


def seat_drift_stratum(sd: pd.DataFrame, hourly):
    """Graduates whose effective quote at the entry point (m + 60 min) meets the floor. Lone/busy keep the
    terciles of the full row (Q24)."""
    used = sd[sd["dropped"] == ""] if len(sd) else sd
    out = {"rows_without_sol_usd": no_price(used["m_time"] + 3600, hourly) if len(used) else 0}
    for size in SIZES_USD:
        if not len(sd) or "w1_eff_quote" not in sd:
            out[f"${size}"] = R.seat_summary(sd.iloc[:0] if len(sd) else sd, sd.iloc[:0] if len(sd) else sd)
            continue
        el = pd.Series([eligible(q, m + 3600, size, hourly) for q, m in zip(sd["w1_eff_quote"], sd["m_time"])],
                       index=sd.index)
        sub = sd[el]
        ok = sub[sub["dropped"] == ""]
        out[f"${size}"] = R.seat_summary(sub, ok)
    return out


def rebuy_stratum(tape: Tape, exits, pts, prs, hourly):
    out = {"rows_without_sol_usd": no_price(pts["t"], hourly) if len(pts) else 0}
    for size in SIZES_USD:
        el = [eligible(q, t, size, hourly) for q, t in zip(pts["eff_quote"], pts["t"])] if len(pts) else []
        p = pts[np.asarray(el, bool)] if len(pts) else pts
        keys = set(zip(p["pool"], p["t"]))
        q = prs[[k in keys for k in zip(prs["pool"], prs["t"])]] if len(prs) else prs
        out[f"${size}"] = RB.summarise(tape, exits, p, q)
    return out


# ------------------------------------------------------------------ count row: H8 capacity
def h8_capacity(tape: Tape, s: pd.DataFrame, hourly):
    """H8_AMENDMENT item 4: per day, H8-eligible pool-hours and graduates at $5, $20 and $50.
    Pool-hours: canonical, non-mayhem PumpSwap WSOL pools (pools whose mayhem flag is not on the tape are counted
    apart, as `*_mayhem_unknown`), at each whole UTC hour inside the loaded tape, with an
    as-of state at the hour start. Graduates: eligible graduates (migration on the tape) whose effective quote at
    m + 60 min (H10's earliest entry) meets the floor (Q25)."""
    days = sorted({d for d, _, _ in tape.ranges})
    amm = s[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL)]
    hours = []
    for (d, a, b), (t0, t1) in tape.interval_times.items():
        if t0 is None:
            continue
        h = -(-t0 // 3600) * 3600
        while h <= t1:
            hours.append((d, h))
            h += 3600
    rows = []
    stale = {}
    mayhem_cache = {}
    for pool, g in amm.groupby("pool", sort=False):
        mint = g["mint"].iloc[0]
        if mint not in mayhem_cache:
            mayhem_cache[mint] = tape.mayhem_of_mint(mint)
        mh = mayhem_cache[mint]
        if mh == 1:
            continue
        known = mh == 0         # Q25: pools with unknown mayhem are counted apart, never in the main count
        g = g.sort_values("order")
        ps = RB.pool_state(g)
        for d, h in hours:
            st = RB.last_block_slot(tape, h)
            if st is None:
                continue
            i, mid, eq = RB.state_asof(ps, h, st)
            if i < 0 or not np.isfinite(eq[i]):
                continue
            if not tape.covered(int(ps["slot"][i]), h):
                stale[d] = stale.get(d, 0) + 1     # last state lies before a tape gap: not as-of the hour
                continue
            rows.append({"day": d, "hour": h, "pool": pool, "mayhem_known": known, "eff_quote": float(eq[i]),
                         **{f"ok_{z}": eligible(eq[i], h, z, hourly) for z in SIZES_USD}})
    ph = pd.DataFrame(rows, columns=["day", "hour", "pool", "mayhem_known", "eff_quote"] + [f"ok_{z}" for z in SIZES_USD])
    pp = R.by_pool(s)
    grads = []
    for r in R.eligible_pools(tape).itertuples(index=False):
        t = int(r.m_time) + 3600
        g = pp.get(r.pool)
        rec = {"day": r.day, "pool": r.pool, "assessable": False}
        if g is not None and tape.covered(int(r.m_slot), t):
            st = RB.last_block_slot(tape, t)
            i, _, eq = RB.state_asof(RB.pool_state(g), t, st)
            if i >= 0 and np.isfinite(eq[i]):
                rec["assessable"] = True
                rec.update({f"ok_{z}": eligible(eq[i], t, z, hourly) for z in SIZES_USD})
        grads.append(rec)
    gr = pd.DataFrame(grads, columns=["day", "pool", "assessable"] + [f"ok_{z}" for z in SIZES_USD])
    summ = {}
    for d in days:
        xa, y = ph[ph["day"] == d], gr[gr["day"] == d]
        x = xa[xa["mayhem_known"].astype(bool)] if len(xa) else xa
        xu = xa[~xa["mayhem_known"].astype(bool)] if len(xa) else xa
        summ[d] = {"pool_hours": int(len(x)), "pool_hours_mayhem_unknown": int(len(xu)),
                   "pool_hours_state_not_on_tape": int(stale.get(d, 0)), "graduates": int(len(y)),
                   "graduates_assessable_at_m_plus_60": int(y["assessable"].sum()) if len(y) else 0,
                   "hours_without_sol_usd": int(sum(1 for dd, h in hours if dd == d and not np.isfinite(px_asof(hourly, h))))}
        for z in SIZES_USD:
            summ[d][f"${z}"] = {"h8_pool_hours": int(x[f"ok_{z}"].sum()) if len(x) else 0,
                                "h8_pool_hours_mayhem_unknown": int(xu[f"ok_{z}"].sum()) if len(xu) else 0,
                                "h8_graduates": int(y[f"ok_{z}"].fillna(False).astype(bool).sum()) if len(y) else 0}
    return ph, gr, summ
