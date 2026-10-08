"""H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md). Reporting only: the frozen primary is unchanged.

H8 (packages/core/src/gates/hard.ts:286-315, policy.ts:205) rejects a pool unless its effective quote (vault + virtual),
valued in USD with the hourly SOL/USD, is at least max($15,000, 1,000 x trade size).

- Price: the close of the last COMPLETE hour before the decision time tau, from the Binance public archive file passed
  in (its sha256 is recorded). CONSERVATIVE as-of reading of "that hour's SOL/USD" (OPEN_QUESTIONS #32). A decision
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


def load_solusd(path: str) -> Tuple[np.ndarray, np.ndarray, str]:
    """Hourly klines: Binance archive CSV (open_time, open, high, low, close, ...; ms or us) or a CSV with header
    `hour,close` (hour = open time in seconds). Returns (hour open seconds, close, sha256 of the file)."""
    with open(path, "rb") as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()
    raw = pd.read_csv(path, header=None, dtype=str)
    if not raw.iloc[0, 0].strip().isdigit():
        hdr = [c.strip() for c in raw.iloc[0]]
        raw = raw.iloc[1:]
        t = raw.iloc[:, hdr.index("hour")].astype(np.int64).to_numpy()
        px = raw.iloc[:, hdr.index("close")].astype(float).to_numpy()
    else:
        t = raw.iloc[:, 0].astype(np.int64).to_numpy()
        px = raw.iloc[:, 4].astype(float).to_numpy()
    t = np.where(t > 10**15, t // 10**6, np.where(t > 10**12, t // 1000, t))
    o = np.argsort(t)
    return t[o], px[o], sha


SOLUSD_DIR_DEFAULT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
                                                   "brainstorm-loop", "sol-usd"))


def days_needed(days: Iterable[str]) -> list:
    """The decision days plus the day before the first one (00:xx decisions use the previous day's 23:00 close)."""
    days = sorted(set(days))
    if not days:
        return []
    first = datetime.strptime(days[0], "%Y-%m-%d").replace(tzinfo=timezone.utc) - timedelta(days=1)
    return sorted(set(days) | {first.strftime("%Y-%m-%d")})


def load_solusd_dir(path: str, days: Iterable[str]) -> Tuple[np.ndarray, np.ndarray, str]:
    """research/brainstorm-loop/sol-usd: SOLUSDT-1h-<day>.zip per day, each checked against SHA256SUMS.
    Raises ValueError on a missing day, a file not listed, or a sha256 mismatch. Returns (hours, close, sha256 of
    SHA256SUMS)."""
    sums_p = os.path.join(path, "SHA256SUMS")
    if not os.path.exists(sums_p):
        raise ValueError(f"SOL/USD: {sums_p} missing")
    with open(sums_p, "rb") as fh:
        raw = fh.read()
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
    """Adds sol_usd and h8_s{5,20,50} (bool) from as-of data only."""
    out = df.copy()
    px = price_asof(hours, close, out.tau.to_numpy())
    out["sol_usd"] = px
    eff_usd = out.effective_quote_sol.to_numpy(dtype=float) * px
    for s in C.H8_SIZES_USD:
        with np.errstate(invalid="ignore"):
            out[f"h8_s{s}"] = ~np.isnan(eff_usd) & (eff_usd >= floor_usd(s))
    return out


def h8_counts(df: pd.DataFrame) -> Dict:
    """Step A count row 4: per day and size, H8-eligible pool-hours and graduates (eligible decision points only)."""
    res = {}
    for day, g in df[df.eligible.astype(bool)].groupby("day", sort=True):
        res[day] = {}
        for s in C.H8_SIZES_USD:
            e = g[g[f"h8_s{s}"]]
            res[day][f"${s}"] = {"pool_hours": int(e.assign(h=e.tau // 3600)[["pool", "h"]].drop_duplicates().shape[0]),
                                 "graduates": int(e.pool.nunique())}
    return res
