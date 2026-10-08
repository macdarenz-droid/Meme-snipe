"""Universe, decision points and trade timing (PREREG §2-§3). Reads timing and as-of pool state only, never an outcome.

- Pools: canonical PumpSwap pools with a WSOL quote whose migration (CompletePumpAmmMigrationEvent) is on the tape,
  not mayhem (CreatePoolEvent `is_mayhem_mode`, else CreateEvent, else the curve rows' `mayhem_mode`; unknown ->
  excluded, as G1 §3).
- Decision points: UTC-aligned 5-minute marks tau in [migration + 60 min, migration + 24 h]. The decision slot d is the
  last produced slot with block_time < tau. d must lie in the same gap-free coverage segment as the migration.
- Eligible at d: effective quote >= 50 SOL and real vault >= 30 SOL (pool state at the end of slot d).
- Timing per hold h: entry slot E = d + 23; exit trigger = first slot with block_time >= block_time(E) + h; exit slot
  X = trigger + 23. A hold arm is dropped by time when E or X is past the end of d's coverage segment.
"""
from typing import Optional

import numpy as np
import pandas as pd

from . import config as C
from .load import Tape
from .pool_state import PoolBook


class Clock:
    def __init__(self, tape: Tape):
        self.slot = tape.b.slot.to_numpy()
        bt = tape.b.block_time.to_numpy()
        self.nonmonotone = int((np.diff(bt) < 0).sum()) if len(bt) else 0
        self.bt = np.maximum.accumulate(bt) if len(bt) else bt   # fail-safe: never lets a slot look earlier
        self.segs = tape.segs

    def decision_slot(self, tau):
        i = np.searchsorted(self.bt, tau, side="left") - 1
        return np.where(i >= 0, self.slot[np.maximum(i, 0)], -1)

    def slot_time(self, s):
        i = np.searchsorted(self.slot, s, side="right") - 1
        return np.where(i >= 0, self.bt[np.maximum(i, 0)], -1)

    def first_slot_at(self, t):
        i = np.searchsorted(self.bt, t, side="left")
        ok = i < len(self.slot)
        return np.where(ok, self.slot[np.minimum(i, len(self.slot) - 1)], -1)

    def seg_end(self, s):
        s = np.asarray(s)
        out = np.full(s.shape, -1, dtype=np.int64)
        for a, b in self.segs:
            out[(s >= a) & (s <= b)] = b
        return out

    def seg_start(self, s):
        s = np.asarray(s)
        out = np.full(s.shape, -1, dtype=np.int64)
        for a, b in self.segs:
            out[(s >= a) & (s <= b)] = a
        return out


def migrations(tape: Tape, book: PoolBook, dev_unknown_migration: bool = False) -> pd.DataFrame:
    """One row per candidate pool: pool, mint, mig_slot, mayhem flag and its source, exclusion reason."""
    mig = tape.ev["CompletePumpAmmMigrationEvent"]
    cp = tape.ev["CreatePoolEvent"]
    ce = tape.ev["CreateEvent"]
    rows = []
    seen = set()
    for r in mig.itertuples(index=False):
        if r.pool in seen:
            continue
        seen.add(r.pool)
        reason = ""
        if r.pool not in book.rows:
            reason = "not a canonical WSOL pool with trades on the tape"
        may, src = -1, "unknown"
        x = cp[(cp.pool == r.pool) & (cp.signature == r.signature)]
        if len(x) == 0:
            x = cp[cp.pool == r.pool]
        if len(x) and x.is_mayhem_mode.iloc[0] in (0, 1):
            may, src = int(x.is_mayhem_mode.iloc[0]), "CreatePoolEvent"
        else:
            y = ce[ce.mint == r.mint]
            if len(y) and y.is_mayhem_mode.iloc[0] in (0, 1):
                may, src = int(y.is_mayhem_mode.iloc[0]), "CreateEvent"
            else:
                z = tape.curve[(tape.curve.mint == r.mint) & (tape.curve.slot <= r.slot) & (tape.curve.mayhem >= 0)]
                if len(z):
                    may, src = int(z.mayhem.iloc[-1]), "curve mayhem_mode"
        if not reason and may == -1:
            reason = "mayhem flag unknown"
        elif not reason and may == 1:
            reason = "mayhem"
        rows.append(dict(pool=int(r.pool), mint=int(r.mint), mig_slot=int(r.slot), mayhem=may, mayhem_src=src,
                         excluded=reason, dev=False))
    if dev_unknown_migration:
        # DEV ONLY (shape checks on <= 2 units): pools whose migration predates the tape get a pseudo migration one hour
        # before their first trade on the tape. Never valid for search or validation (outputs are marked dev).
        for p, r in book.rows.items():
            if p in seen:
                continue
            rows.append(dict(pool=int(p), mint=int(r["mint"][0]), mig_slot=-1, mayhem=-1, mayhem_src="dev",
                             excluded="", dev=True, dev_first_slot=int(r["slot"][0]),
                             dev_first_time=int(r["block_time"][0])))
    return pd.DataFrame(rows)


def decision_points(tape: Tape, book: PoolBook, migs: pd.DataFrame, clock: Optional[Clock] = None) -> pd.DataFrame:
    clock = clock or Clock(tape)
    if len(clock.bt) == 0 or len(migs) == 0:
        return pd.DataFrame()
    t_lo, t_hi = int(clock.bt[0]), int(clock.bt[-1]) + 1
    out = []
    for m in migs[migs.excluded == ""].itertuples(index=False):
        if m.dev:
            mig_time = int(m.dev_first_time) - C.H10_MIN_AGE_S
            seg_ok_from = int(m.dev_first_slot)
        else:
            mig_time = int(clock.slot_time(m.mig_slot))
            seg_ok_from = m.mig_slot
        tau0 = -(-(mig_time + C.H10_MIN_AGE_S) // C.GRID_S) * C.GRID_S
        tau1 = mig_time + C.MAX_AGE_S
        lo = max(tau0, -(-t_lo // C.GRID_S) * C.GRID_S)
        hi = min(tau1, t_hi)
        if hi < lo:
            continue
        taus = np.arange(lo, hi + 1, C.GRID_S, dtype=np.int64)
        d = clock.decision_slot(taus)
        ok = (d >= seg_ok_from) & (clock.seg_start(d) >= 0) & (clock.seg_start(d) <= seg_ok_from)
        if not ok.any():
            continue
        taus, d = taus[ok], d[ok]
        i = book.idx_le(m.pool, d)
        r = book.rows[m.pool]
        has = i >= 0
        ii = np.maximum(i, 0)
        eff = np.where(has, r["vault_after"][ii] + r["virt"][ii], 0)
        vault = np.where(has, r["vault_after"][ii], 0)
        elig = has & (eff >= C.MIN_EFFECTIVE_QUOTE) & (vault >= C.MIN_REAL_VAULT)
        df = pd.DataFrame({"pool": m.pool, "mint": m.mint, "tau": taus, "d": d, "mig_slot": m.mig_slot,
                           "mig_time": mig_time, "eligible": elig, "dev": bool(m.dev)})
        out.append(df)
    if not out:
        return pd.DataFrame()
    pts = pd.concat(out, ignore_index=True)
    pts["day"] = pd.to_datetime(pts.tau, unit="s", utc=True).dt.strftime("%Y-%m-%d")
    pts["block"] = (pts.tau % 86400) // C.BLOCK_S
    pts["entry_slot"] = pts.d + C.DELAY_SLOTS
    seg_end = clock.seg_end(pts.d.to_numpy())
    entry_ok = pts.entry_slot.to_numpy() <= seg_end
    te = clock.slot_time(pts.entry_slot.to_numpy())
    pts["entry_time"] = te
    for h in C.HOLDS_S:
        trig = clock.first_slot_at(te + h)
        x = np.where(trig >= 0, trig + C.DELAY_SLOTS, -1)
        valid = entry_ok & (trig >= 0) & (x <= seg_end) & (x >= 0)
        pts[f"exit_slot_{h // 60}"] = x
        pts[f"exit_time_{h // 60}"] = np.where(valid, clock.slot_time(np.maximum(x, 0)), -1)
        pts[f"valid_{h // 60}"] = valid
    return pts.sort_values(["tau", "pool"], kind="mergesort").reset_index(drop=True)
