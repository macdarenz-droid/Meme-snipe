"""H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md, H1-CGO AMENDMENT_3 item 1).

H8 (packages/core/src/gates/hard.ts h8, policy.ts liquidity) passes a pool when its effective quote (vault + virtual
reserves), valued in micro-USD at the hourly SOL/USD and rounded down, is at least max($15,000, 1,000 x trade size).
The hourly point is the bot's: the close of the hour bar that ended at or before the decision time (producer.ts
stamps a bar at start + 1 h; series.ts solUsdAt), refused when older than 2 hours (HOURLY_MAX_AGE_MS)."""
import bisect
import hashlib
from decimal import Decimal

import pandas as pd

FLOOR_USD = 15_000
FLOOR_NOTIONAL_MULTIPLE = 1_000
MAX_AGE_S = 2 * 3600
SIZES_USD = (5, 20, 50)


class SolUsd:
    """Hourly SOL/USD points (bar end time in s -> micro-USD close) from Binance public-archive SOLUSDT klines."""

    def __init__(self, points: dict, files: list):
        self.t = sorted(points)
        self.p = [points[k] for k in self.t]
        self.files = files

    @classmethod
    def from_klines(cls, paths):
        """Kline CSVs (no header: open_time, open, high, low, close, volume, close_time, ...; open_time in ms or us).
        Each bar's interval is its close_time + 1 ms - open_time; only bars ending on a whole hour make a point, which
        is that bar's close for 1 h bars and the hour's last minute close for 1 m bars."""
        pts, files = {}, []
        for path in paths:
            with open(path, "rb") as f:
                files.append(dict(path=path, sha256=hashlib.sha256(f.read()).hexdigest()))
            k = pd.read_csv(path, header=None, dtype=str)
            k = k[pd.to_numeric(k[0], errors="coerce").notna()]
            for r in k.itertuples(index=False):
                o, c = int(r[0]), int(r[6])
                div = 1000 if o < 10**14 else 1_000_000  # ms or us
                end = (c + 1) // div  # close_time is the bar's last ms (or us)
                if end % 3600 == 0:
                    pts[end] = int(Decimal(r[4]) * 1_000_000)
        return cls(pts, files)

    def at(self, t: int):
        """The point at or before t, if it is at most 2 hours old."""
        k = bisect.bisect_right(self.t, t)
        if k == 0 or t - self.t[k - 1] > MAX_AGE_S:
            return None
        return self.p[k - 1]


def floor_micro_usd(size_usd: float) -> int:
    return max(FLOOR_USD, FLOOR_NOTIONAL_MULTIPLE * size_usd) * 1_000_000


def eligible(eff_quote_lamports, hour: int, size_usd: float, sol: SolUsd) -> bool:
    """H8 at `size_usd` for an effective quote as of the decision hour. No SOL/USD point (or a stale one): not eligible
    (the bot's H16 refusal)."""
    px = sol.at(int(hour))
    if px is None or not eff_quote_lamports == eff_quote_lamports:  # NaN: no pool state
        return False
    eff = int(eff_quote_lamports)
    usd = eff * px // 1_000_000_000 if eff > 0 else 0
    return usd >= floor_micro_usd(size_usd)


def flags(feats: pd.DataFrame, sol: SolUsd) -> pd.DataFrame:
    """h8_<size> columns for $5, $20 and $50."""
    out = feats.copy()
    for s in SIZES_USD:
        out[f"h8_{s}"] = [eligible(e, h, s, sol) for e, h in zip(out.eff_quote, out.hour)]
    return out


def count_rows(feats: pd.DataFrame, sol: SolUsd) -> dict:
    """H8_AMENDMENT item 4: H8-eligible pool-hours and graduates per day at each size, over the decision points with a
    pool state and over H1-CGO's eligible ones."""
    f = flags(feats, sol)
    res = {}
    for base, sub in (("with_state", f[f.has_state]), ("h1cgo_eligible", f[f.eligible])):
        for s in SIZES_USD:
            g = sub[sub[f"h8_{s}"]]
            res[f"{base}_${s}"] = {d: dict(pool_hours=int((g.decision_day == d).sum()),
                                            graduates=int(g[g.decision_day == d].mint.nunique()))
                                   for d in sorted(set(f.decision_day))}
    res["sol_usd_files"] = sol.files
    return res
