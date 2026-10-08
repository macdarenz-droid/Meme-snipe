"""H8 at trade size: the H8-eligible stratum for count rows 1-3, and the H8 capacity count row.

Frozen texts: research/brainstorm-loop/H8_AMENDMENT.md and H8_AMENDMENT_2.md (the floor depends on the universe tag).
Checked against packages/core/src/gates/hard.ts (H6, H8 with dust-at-migration, H11) and config/policy.ts (trial
values) and config/research.ts (U2 window).
- U2 (60-240 min after migration): max($15k, 1,000 x size), plus H11 (candle spike and the +5 min chase check).
- U1 (1-14 days after migration): max($50k, 1,000 x size), plus H11's candle-spike check (Q26).
- 4-24 h, under 60 min (H10) or over 14 days: not tradable without a new universe tag.
- Always: H6 (no outstanding LP) and dust at migration (at least 5 SOL in the pool at migration).
Everything reads as-of states only (Q14): trades and events at or before the point, and the hour-start SOL/USD close.
"""
from __future__ import annotations

from collections import Counter

import numpy as np
import pandas as pd

import rebuy as RB
import rows as R
from tapeio import WSOL, Tape

SIZES_USD = (5, 20, 50, 100, 200, 500, 1000, 10000)     # H8_AMENDMENT_2 item 4 adds $100 ... $10,000
TRIAL_SIZE_USD = 5                                       # item 3: "tradable as the bot stands" is judged at $5 only
FLOOR_MIN_USD = 15_000.0
U1_FLOOR_USD = 50_000.0
FLOOR_PER_USD_TRADED = 1_000.0
U2_FROM_S, U2_TO_S = 60 * 60, 240 * 60
U1_FROM_S, U1_TO_S = 24 * 3600, 14 * 24 * 3600
DUST_AT_MIGRATION = 5 * 10**9                            # policy.gates.dustPoolMinAtMigration = 5 SOL
CANDLE_SPIKE = 0.25                                      # candleSpikeBps 2500
CANDLE_WINDOW_S = 3 * 60                                 # candleWindowMs
CHASE_AFTER_S = 5 * 60                                   # chaseCheckAfterMs; chaseMaxAboveMigrationBps = 0
SIZE_NOTES = {f"${z}": ("trial maximum: the bot as it stands" if z == TRIAL_SIZE_USD
                        else "research line: needs the owner to raise maxNotional") for z in SIZES_USD}


def hourly_px(minutes: pd.Series | None) -> dict:
    """{hour start (epoch s): SOL/USD}. The hour's value is the close of the 1-minute bar that ends at the hour
    start (opens at hour start - 60 s), i.e. the last close known when the hour begins (Q23, confirmed by
    COUNT_ROWS_AMENDMENT_3)."""
    if minutes is None or not len(minutes):
        return {}
    out = {}
    for ot, c in minutes.items():
        if (int(ot) + 60) % 3600 == 0:
            out[int(ot) + 60] = float(c)
    return out


def px_asof(hourly: dict, t) -> float:
    return hourly.get(int(t) // 3600 * 3600, np.nan)


def universe(age_s):
    if age_s is None or not np.isfinite(age_s):
        return "age_unknown"
    if U2_FROM_S <= age_s <= U2_TO_S:
        return "U2"
    if U1_FROM_S <= age_s <= U1_TO_S:
        return "U1"
    if age_s < U2_FROM_S:
        return "under_60min"
    if age_s < U1_FROM_S:
        return "4_24h"
    return "over_14d"


def floor_usd(size, uni="U2"):
    """liquidityFloor (hard.ts:285): max($15k, 1,000 x size), raised to $50k for U1. None outside U1/U2."""
    if uni not in ("U1", "U2"):
        return None
    f = max(FLOOR_MIN_USD, FLOOR_PER_USD_TRADED * size)
    return max(f, U1_FLOOR_USD) if uni == "U1" else f


def eligible(eq_lamports, t, size, hourly, uni="U2") -> bool:
    """The H8 floor alone: effective quote x the hour's SOL/USD >= the universe floor at `size`. A missing price,
    effective quote or universe is not eligible (missing evidence means no trade)."""
    px = px_asof(hourly, t)
    fl = floor_usd(size, uni)
    if fl is None or not (np.isfinite(px) and eq_lamports is not None and np.isfinite(eq_lamports)):
        return False
    return eq_lamports / R.LAMPORTS * px >= fl


class GateCtx:
    """As-of H6, dust-at-migration, H11 and H8 checks for canonical pools on the tape."""

    def __init__(self, tape: Tape, s: pd.DataFrame, hourly: dict):
        self.tape, self.hourly = tape, hourly
        self.pp = R.by_pool(s)
        mig = tape.migrations.drop_duplicates("pool")
        self.mig = {r.pool: (int(r.block_time), int(r.slot)) for r in mig.itertuples(index=False)}
        pc = tape.pool_creates
        self.mig_price, self.mig_quote = {}, {}
        for r in pc.itertuples(index=False):
            q, b = r.pool_quote_amount, r.pool_base_amount
            self.mig_quote[r.pool] = q
            self.mig_price[r.pool] = (q / b) if (q is not None and b) else None
        self.lp = {p: (g["slot"].to_numpy(np.int64), g["lp_delta"].to_numpy(float).cumsum())
                   for p, g in tape.lp_moves.sort_values("slot").groupby("pool")}
        self._trades = {}

    def trades(self, pool):
        """Per pool swap (all rows, BOOST included, as the core candle book): time, slot, pre and post price on
        effective reserves; post from the event (base +/- base amount, quote +/- lp-adjusted quote)."""
        if pool not in self._trades:
            g = self.pp.get(pool)
            if g is None:
                self._trades[pool] = None
            else:
                v = g["virtual_quote"].fillna(0)
                qpre, bpre = g["pool_quote_pre"], g["pool_base_pre"]
                sign = np.where(g["is_buy"], 1.0, -1.0)
                qpost = qpre + sign * g["lp_adj"]
                bpost = bpre - sign * g["base"]
                pre = ((qpre + v) / bpre).where(bpre > 0)
                post = ((qpost + v) / bpost).where(bpost > 0)
                self._trades[pool] = {"bt": g["block_time"].to_numpy(), "slot": g["slot"].to_numpy(),
                                      "pre": pre.to_numpy(float), "post": post.to_numpy(float)}
        return self._trades[pool]

    def h11(self, pool, t, st, uni):
        """hard.ts h11: 1-minute candles (open = first trade's pre, high = max of pre/post, close = last post) from
        trades at or before t; reject a candle in the last 3 min whose high is more than 25% above its open; for U2,
        reject when the close of the last candle ending by m + 5 min is above the migration price, or no such candle."""
        tr = self.trades(pool)
        if tr is None:
            return "h11_no_candles"
        k = int(np.searchsorted(tr["bt"], t, side="right"))
        k = min(k, int(np.searchsorted(tr["slot"], st, side="right")))
        if k == 0:
            return "h11_no_candles"
        pre, post, bt = tr["pre"][:k], tr["post"][:k], tr["bt"][:k]
        if not (np.isfinite(pre).all() and np.isfinite(post).all()):
            return "h11_partial"
        minute = bt // 60 * 60
        recent = minute + 60 > t - CANDLE_WINDOW_S
        for m0 in np.unique(minute[recent]):
            idx = np.nonzero(minute == m0)[0]
            op = pre[idx[0]]
            hi = max(np.max(pre[idx]), np.max(post[idx]))
            if hi > op * (1 + CANDLE_SPIKE):
                return "h11_spike"
        if uni != "U2":
            return None
        m = self.mig.get(pool)
        pm = self.mig_price.get(pool)
        if m is None or pm is None:
            return "h11_no_migration_price"
        at = m[0] + CHASE_AFTER_S
        ok = (minute + 60 <= at)
        if not ok.any():
            return "h11_not_covered"
        last = minute[ok].max()
        if last + 60 <= m[0]:
            return "h11_not_covered"
        close = post[np.nonzero(minute == last)[0][-1]]
        return "h11_chase" if close > pm else None

    def check(self, pool, t, st, eq, size):
        """'ok' or the first failing check, in the order: universe, dust, H6, H11, SOL/USD, H8 floor."""
        m = self.mig.get(pool)
        uni = universe(t - m[0]) if m is not None else "age_unknown"
        if uni not in ("U1", "U2"):
            return uni
        q = self.mig_quote.get(pool)
        if q is None:
            return "dust_unknown"
        if q < DUST_AT_MIGRATION:
            return "dust_at_migration"
        lp = self.lp.get(pool)
        if lp is not None:
            i = int(np.searchsorted(lp[0], st, side="right")) - 1
            if i >= 0 and lp[1][i] > 0:
                return "h6_lp_outstanding"
        r = self.h11(pool, t, st, uni)
        if r:
            return r
        if not np.isfinite(px_asof(self.hourly, t)):
            return "no_sol_usd"
        if eq is None or not np.isfinite(eq):
            return "no_effective_quote"
        return "ok" if eligible(eq, t, size, self.hourly, uni) else f"below_{uni}_floor"


# ------------------------------------------------------------------ stratum reports for rows 1-3
def no_price(times, hourly):
    return int(sum(1 for t in times if not np.isfinite(px_asof(hourly, t))))


def _reasons(ctx, rows, size):
    """rows: iterable of (pool, t, st, eq). Returns (mask, Counter of reasons)."""
    res = [ctx.check(p, t, st, q, size) for p, t, st, q in rows]
    return np.array([r == "ok" for r in res], bool), Counter(res)


def dev_zero_stratum(dz: pd.DataFrame, days, hourly, ctx=None):
    used = dz[dz["dropped"] == ""] if len(dz) else dz
    out = {"rows_without_sol_usd": no_price(used["block_time"], hourly) if len(used) else 0, "size_notes": SIZE_NOTES}
    for size in SIZES_USD:
        if not len(used) or "eff_quote" not in used or ctx is None:
            out[f"${size}"] = R.dev_summary(dz.iloc[:0] if len(dz) else dz, days)
            continue
        ok, why = _reasons(ctx, zip(used["pool"], used["block_time"], used["slot"], used["eff_quote"]), size)
        out[f"${size}"] = {**R.dev_summary(used[ok], days), "h8_checks": dict(why)}
    return out


def seat_drift_stratum(sd: pd.DataFrame, hourly, ctx=None):
    """Graduates whose pool passes the checks at the entry point (m + 60 min, U2). Lone/busy keep the terciles
    of the full row (Q24)."""
    used = sd[sd["dropped"] == ""] if len(sd) else sd
    out = {"rows_without_sol_usd": no_price(used["m_time"] + 3600, hourly) if len(used) else 0, "size_notes": SIZE_NOTES}
    for size in SIZES_USD:
        if not len(used) or "w1_eff_quote" not in used or ctx is None:
            out[f"${size}"] = R.seat_summary(sd.iloc[:0] if len(sd) else sd, sd.iloc[:0] if len(sd) else sd)
            continue
        pts = [(p, m + 3600, RB.last_block_slot(ctx.tape, m + 3600), q)
               for p, m, q in zip(used["pool"], used["m_time"], used["w1_eff_quote"])]
        ok, why = _reasons(ctx, pts, size)
        sub = used[ok]
        out[f"${size}"] = {**R.seat_summary(sub, sub), "h8_checks": dict(why)}
    return out


def rebuy_stratum(tape: Tape, exits, pts, prs, hourly, ctx=None):
    out = {"rows_without_sol_usd": no_price(pts["t"], hourly) if len(pts) else 0, "size_notes": SIZE_NOTES}
    for size in SIZES_USD:
        if not len(pts) or ctx is None:
            out[f"${size}"] = RB.summarise(tape, exits, pts.iloc[:0], prs.iloc[:0])
            continue
        ok, why = _reasons(ctx, zip(pts["pool"], pts["t"], pts["decision_slot"], pts["eff_quote"]), size)
        p = pts[ok]
        keys = set(zip(p["pool"], p["t"]))
        q = prs[[k in keys for k in zip(prs["pool"], prs["t"])]] if len(prs) else prs
        out[f"${size}"] = {**RB.summarise(tape, exits, p, q), "h8_checks": dict(why)}
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
