"""H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md, H1-CGO AMENDMENT_3 item 1).

H8 (packages/core/src/gates/hard.ts h8, policy.ts liquidity) passes a pool when its effective quote (vault + virtual
reserves), valued in micro-USD at the hourly SOL/USD and rounded down, is at least max($15,000, 1,000 x trade size).
The hourly point is the bot's: the close of the hour bar that ended at or before the decision time (producer.ts
stamps a bar at start + 1 h; series.ts solUsdAt), refused when older than 2 hours (HOURLY_MAX_AGE_MS)."""
import bisect
import hashlib
import io
import os
import zipfile
from decimal import Decimal

import pandas as pd

FLOOR_USD = 15_000
FLOOR_NOTIONAL_MULTIPLE = 1_000
MAX_AGE_S = 2 * 3600
# The committed SHA256SUMS itself is pinned, so a zip and its line cannot be edited together.
SOL_USD_SUMS_SHA256 = "02083908d386a53c07acd1663bdd74f102053f12bcd92856cf09670fcf3da964"
DUST_AT_MIGRATION_LAMPORTS = 5 * 10**9  # policy.ts gates.dustPoolMinAtMigration (AMENDMENT_4)
SOL_USD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "brainstorm-loop", "sol-usd")
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
            if path.endswith(".zip"):
                with zipfile.ZipFile(path) as z:
                    names = [n for n in z.namelist() if n.endswith(".csv")]
                    k = pd.concat([pd.read_csv(io.BytesIO(z.read(n)), header=None, dtype=str) for n in names])
            else:
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


U1_FLOOR_USD = 50_000  # policy.ts liquidity.u1FloorUsd
U2_WINDOW_S = (60 * 60, 240 * 60)  # research.ts s0.u2WindowFromMs / u2WindowToMs; the end is excluded (OPEN_QUESTIONS)
U1_WINDOW_S = (24 * 3600, 14 * 86_400)  # ARCHITECTURE §3.2: pools aged 24 h to 14 days
COUNT_SIZES_USD = (5, 20, 50, 100, 200, 500, 1_000, 10_000)  # H8_AMENDMENT_2 item 4
TRADABLE_SIZE_USD = 5  # H8_AMENDMENT_2 item 3: the trial maximum (policy.ts capital.maxNotional)
STRATUM_UNIVERSES = ("U2",)  # AMENDMENT_5 H5: decision points run to + 24 h, so the tradable stratum is U2 only
LP_LIMITATION = ("H6 reads LP outstanding as deposits - withdrawals since migration (AMENDMENT_5 H7); LP burns outside "
                 "a withdrawal are not seen on the tape")


def universe_tag(age_s) -> str:
    """H8_AMENDMENT_2 item 1: the universe the bot would tag a pool of this age with; None between them (4-24 h)."""
    if U2_WINDOW_S[0] <= age_s < U2_WINDOW_S[1]:
        return "U2"
    if U1_WINDOW_S[0] <= age_s <= U1_WINDOW_S[1]:
        return "U1"
    return None


def floor_micro_usd(size_usd: float, tag: str = None) -> int:
    """hard.ts liquidityFloor: max($15k, 1,000 x size), raised to the U1 floor for U1."""
    f = max(FLOOR_USD, FLOOR_NOTIONAL_MULTIPLE * size_usd)
    if tag == "U1":
        f = max(f, U1_FLOOR_USD)
    return int(f * 1_000_000)


def eligible(eff_quote_lamports, hour: int, size_usd: float, sol: SolUsd, quote_at_migration=None, tag=None) -> bool:
    """H8 at `size_usd` for an effective quote as of the decision hour, as hard.ts h8 runs it: first the
    dust-at-migration check (no migration pool quote, or less than 5 SOL: not eligible; AMENDMENT_4), then the floor.
    No SOL/USD point (or a stale one): not eligible (the bot's H16 refusal)."""
    if quote_at_migration is not None:
        if not quote_at_migration == quote_at_migration or int(quote_at_migration) < DUST_AT_MIGRATION_LAMPORTS:
            return False
    px = sol.at(int(hour))
    if px is None or not eff_quote_lamports == eff_quote_lamports:  # NaN: no pool state
        return False
    eff = int(eff_quote_lamports)
    usd = eff * px // 1_000_000_000 if eff > 0 else 0
    return usd >= floor_micro_usd(size_usd, tag)


def tradable(r, size_usd: float, sol: SolUsd, universes=("U1", "U2")) -> bool:
    """H8_AMENDMENT_2 items 1-2 for one decision point: the universe tag by age (4-24 h: not tradable without a new
    tag), H6 (no LP outstanding), H11 (no candle spike; for U2 also the chase check), then H8 with the dust check on
    that universe's floor."""
    tag = universe_tag(r["hour"] - r["mig_time"])
    if tag not in universes or r["h6_lp_outstanding"] != 0 or r["h11_spike"] or (tag == "U2" and r["h11_chase_reject"]):
        return False
    return eligible(r["eff_quote"], r["hour"], size_usd, sol, r["quote_at_migration"], tag)


def flags(feats: pd.DataFrame, sol: SolUsd, sizes=SIZES_USD, universes=("U1", "U2")) -> pd.DataFrame:
    """h8_<size> columns: tradable under H8_AMENDMENT_2 at each size, in the given universes."""
    out = feats.copy()
    for s in sizes:
        out[f"h8_{s}"] = [tradable(r, s, sol, universes) for _, r in out.iterrows()] if len(out) else []
    return out


def count_rows(feats: pd.DataFrame, sol: SolUsd) -> dict:
    """H8_AMENDMENT item 4 with H8_AMENDMENT_2 item 4: pool-hours and graduates per day passing H8 on their universe's
    floor (with H6 and H11) at $5 ... $10,000, over the decision points with a pool state and over H1-CGO's eligible
    ones; and per day the canonical pools whose creator fee is 0."""
    f = flags(feats, sol, COUNT_SIZES_USD)
    days = sorted(set(f.decision_day))
    res = {}
    for base, sub in (("with_state", f[f.has_state]), ("h1cgo_eligible", f[f.eligible])):
        for s in COUNT_SIZES_USD:
            g = sub[sub[f"h8_{s}"]]
            res[f"{base}_${s}"] = {d: dict(pool_hours=int((g.decision_day == d).sum()),
                                            graduates=int(g[g.decision_day == d].mint.nunique())) for d in days}
    z = f[f.has_state & f.creator_fee_zero.astype(bool)]
    res["creator_fee_zero_pools"] = {d: int(z[z.decision_day == d].pool.nunique()) for d in days}
    res["sol_usd_files"] = sol.files
    res["limitations"] = LP_LIMITATION
    return res


def _day_before(d: str) -> str:
    return (pd.Timestamp(d) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")


def check_pin(folder: str = SOL_USD_DIR, pin: str = SOL_USD_SUMS_SHA256) -> str:
    """sha256 of the folder's SHA256SUMS; ValueError unless it equals the pinned value."""
    with open(os.path.join(folder, "SHA256SUMS"), "rb") as f:
        h = hashlib.sha256(f.read()).hexdigest()
    if h != pin:
        raise ValueError(f"SHA256SUMS sha256 {h} is not the pinned {pin}")
    return h


def load_committed(days, folder: str = SOL_USD_DIR, pin: str = SOL_USD_SUMS_SHA256) -> SolUsd:
    """The committed SOL/USD input (AMENDMENT_4): every file in SHA256SUMS must match its sha256; every decision day
    and the day before it (the bar that closes at 00:00 belongs to the day before) must have its 1h and 1m files;
    each 1h close must equal the close of that hour's last 1-minute bar. Raises ValueError otherwise. Points come
    from the 1h bars."""
    check_pin(folder, pin)
    sums = {}
    with open(os.path.join(folder, "SHA256SUMS")) as f:
        for line in f:
            if line.strip():
                h, name = line.split()
                sums[name.lstrip("*")] = h
    for name, h in sums.items():
        p = os.path.join(folder, name)
        if not os.path.exists(p):
            raise ValueError(f"SOL/USD file listed in SHA256SUMS is missing: {name}")
        with open(p, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != h:
                raise ValueError(f"SOL/USD file does not match SHA256SUMS: {name}")
    need = sorted(set(days) | {_day_before(d) for d in days})
    for d in need:
        for iv in ("1h", "1m"):
            if f"SOLUSDT-{iv}-{d}.zip" not in sums:
                raise ValueError(f"SOL/USD missing for {d} ({iv})")
    hourly = SolUsd.from_klines([os.path.join(folder, f"SOLUSDT-1h-{d}.zip") for d in need])
    minute = SolUsd.from_klines([os.path.join(folder, f"SOLUSDT-1m-{d}.zip") for d in need])
    if hourly.t != minute.t or hourly.p != minute.p:
        raise ValueError("SOL/USD 1h closes differ from the 1m closes")
    hourly.files = hourly.files + minute.files
    return hourly
