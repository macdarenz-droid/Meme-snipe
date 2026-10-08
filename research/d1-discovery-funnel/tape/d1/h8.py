"""H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md). Reporting only: the frozen primary is unchanged.

H8 (packages/core/src/gates/hard.ts:286-315, policy.ts:205) rejects a pool unless its effective quote (vault + virtual),
valued in USD with the hourly SOL/USD, is at least max($15,000, 1,000 x trade size).

- Price: the close of the last COMPLETE hour before the decision time tau, from the committed Binance public archive
  (research/brainstorm-loop/sol-usd), pinned by config.SOLUSD_SUMS_SHA256 and checked file by file. CONSERVATIVE as-of reading of "that hour's SOL/USD" (OPEN_QUESTIONS #32). A decision
  with no price is not H8-eligible.
- Effective quote: the as-of feature `effective_quote_sol` at the decision slot.
"""
import hashlib
import io
import os
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, Tuple

import numpy as np
import pandas as pd

from . import config as C


def floor_usd(size_usd: float) -> float:
    return max(C.H8_MIN_QUOTE_USD, C.H8_SIZE_MULTIPLE * size_usd)


SOLUSD_DIR_DEFAULT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
                                                   "brainstorm-loop", "sol-usd"))


def days_needed(days: Iterable[str]) -> list:
    """The decision days plus the day before the first one (00:xx decisions use the previous day's 23:00 close)."""
    days = sorted(set(days))
    if not days:
        return []
    first = datetime.strptime(days[0], "%Y-%m-%d").replace(tzinfo=timezone.utc) - timedelta(days=1)
    return sorted(set(days) | {first.strftime("%Y-%m-%d")})


def sums_sha(path: str) -> str:
    with open(os.path.join(path, "SHA256SUMS"), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def load_solusd_dir(path: str, days: Iterable[str],
                    expected_sums: str = C.SOLUSD_SUMS_SHA256) -> Tuple[np.ndarray, np.ndarray, str]:
    """research/brainstorm-loop/sol-usd: SOLUSDT-1h-<day>.zip per day, each checked against SHA256SUMS.
    Raises ValueError on a missing day, a file not listed, or a sha256 mismatch. Returns (hours, close, sha256 of
    SHA256SUMS)."""
    sums_p = os.path.join(path, "SHA256SUMS")
    if not os.path.exists(sums_p):
        raise ValueError(f"SOL/USD: {sums_p} missing")
    with open(sums_p, "rb") as fh:
        raw = fh.read()
    if hashlib.sha256(raw).hexdigest() != expected_sums:
        raise ValueError(f"SOL/USD: SHA256SUMS sha256 differs from the pinned {expected_sums}")
    sums = {}
    for line in raw.decode().splitlines():
        p = line.split()
        if len(p) == 2:
            sums[p[1].lstrip("*")] = p[0]
    frames = []
    for day in days_needed(days):
        name = f"SOLUSDT-1h-{day}.zip"
        fp = os.path.join(path, name)
        if name not in sums or not os.path.exists(fp):
            raise ValueError(f"SOL/USD: missing day {day} ({name})")
        with open(fp, "rb") as fh:
            data = fh.read()
        if hashlib.sha256(data).hexdigest() != sums[name]:
            raise ValueError(f"SOL/USD: sha256 mismatch for {name}")
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for n in z.namelist():
                frames.append(pd.read_csv(io.BytesIO(z.read(n)), header=None, dtype=str))
    df = pd.concat(frames, ignore_index=True)
    t = df.iloc[:, 0].astype(np.int64).to_numpy()
    t = np.where(t > 10**15, t // 10**6, np.where(t > 10**12, t // 1000, t))
    px = df.iloc[:, 4].astype(float).to_numpy()
    o = np.argsort(t)
    return t[o], px[o], hashlib.sha256(raw).hexdigest()


def price_asof(hours: np.ndarray, close: np.ndarray, tau) -> np.ndarray:
    """Close of the last hour that ended at or before tau (hour open + 3600 <= tau); NaN if none, or if that hour is
    not the one just before tau's hour (a gap in the price file)."""
    tau = np.asarray(tau)
    i = np.searchsorted(hours + 3600, tau, side="right") - 1
    ok = i >= 0
    ii = np.maximum(i, 0)
    want = (tau // 3600) * 3600 - 3600
    ok &= hours[ii] == want
    return np.where(ok, close[ii], np.nan)


def add_h8(df: pd.DataFrame, hours: np.ndarray, close: np.ndarray) -> pd.DataFrame:
    """H8_AMENDMENT_2 items 1-2 (AMENDMENT_3's H8-tradable subset), from as-of data only. Adds:
    - sol_usd, u_tag (U2 / U1 / none, from age since migration and market cap);
    - h8floor_s<usd>: the effective quote meets the floor of the point's universe at that size (none: never);
    - h8_s<usd>: tradable as the bot stands at that size: the floor plus every gate passing (dust, H6, H9, H11 spike,
      H11 chase for U2, H12, H13, H17). A missing gate column or an unknown gate (-1) is not a pass;
    - h8_gate_unknown: some gate needed for the point is unknown (evidence missing on the tape)."""
    from .gates import GATES, floor_for, universe_tag
    out = df.copy()
    n = len(out)
    px = price_asof(hours, close, out.tau.to_numpy())
    out["sol_usd"] = px
    eff_usd = out.effective_quote_sol.to_numpy(dtype=float) * px
    age = out["age_since_mig_min"].to_numpy(dtype=float) * 60 if "age_since_mig_min" in out else np.full(n, np.nan)
    mcap = out["mcap_rel_420"].to_numpy(dtype=float) * 420 if "mcap_rel_420" in out else np.full(n, np.nan)
    tag = np.array([universe_tag(a, m) for a, m in zip(age, mcap)], dtype=object)
    out["u_tag"] = tag
    g = {k: (out[k].to_numpy() if k in out else np.full(n, -1)) for k in GATES}
    need = [k for k in GATES if k != "gate_h11_chase"]
    gates_ok = np.all([g[k] == 1 for k in need], axis=0) & ((tag != "U2") | (g["gate_h11_chase"] == 1))
    unknown = np.any([g[k] == -1 for k in need], axis=0) | ((tag == "U2") & (g["gate_h11_chase"] == -1))
    out["h8_gate_unknown"] = unknown
    for s in C.H8_COUNT_SIZES_USD:
        fl = np.array([floor_for(t, s) for t in tag], dtype=float)
        with np.errstate(invalid="ignore"):
            floor_ok = ~np.isnan(eff_usd) & (eff_usd >= fl)
        out[f"h8floor_s{s}"] = floor_ok
        out[f"h8_s{s}"] = floor_ok & gates_ok
    return out


def h8_counts(df: pd.DataFrame, pool_days: pd.DataFrame = None) -> Dict:
    """Count row (H8_AMENDMENT item 4 as extended by H8_AMENDMENT_2 item 4): per day and size ($5..$10,000), on each
    point's universe floor, the pool-hours and graduates that are tradable (floor and gates) and that meet the floor
    only; plus the canonical pools whose creator fee is 0 (from `pool_days`)."""
    res = {}
    for day, g in df[df.eligible.astype(bool)].groupby("day", sort=True):
        res[day] = {"points_by_universe": {k: int(v) for k, v in g.u_tag.value_counts().items()}}
        for s in C.H8_COUNT_SIZES_USD:
            row = {}
            for key, col in (("tradable", f"h8_s{s}"), ("floor_only", f"h8floor_s{s}")):
                e = g[g[col].astype(bool)]
                row[key] = {"pool_hours": int(e.assign(h=e.tau // 3600)[["pool", "h"]].drop_duplicates().shape[0]),
                            "graduates": int(e.pool.nunique())}
            res[day][f"${s}"] = row
        if pool_days is not None and len(pool_days):
            pdd = pool_days[pool_days.day == day]
            res[day]["canonical_pools_creator_fee_0"] = int(pdd.loc[pdd.creator_fee_zero, "pool"].nunique())
            res[day]["canonical_pools"] = int(pdd.pool.nunique())
    return res


def pool_days(book) -> pd.DataFrame:
    """Per canonical pool on the tape and UTC day: whether the pool's last row of the day charged a 0 creator fee."""
    rows = []
    for p, r in book.rows.items():
        day = r["block_time"] // 86400
        last = np.r_[day[1:] != day[:-1], True]
        for k in np.flatnonzero(last):
            rows.append((p, pd.Timestamp(int(day[k]) * 86400, unit="s").strftime("%Y-%m-%d"), bool(r["creator_bps"][k] == 0)))
    return pd.DataFrame(rows, columns=["pool", "day", "creator_fee_zero"])
