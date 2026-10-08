"""Tape loading for Design A (research/EDGE_DIALOGUE.md "Design A", amendments round 7).

Reads only the columns Design A needs from the shared tape units
(<cache>/<day>/<from>-<to>/research/*.zst; tables per research/shared-tape/README.md).
No outcome or return is read here.
"""
from __future__ import annotations

import io
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import zstandard

WSOL = "So11111111111111111111111111111111111111112"
SYSTEM = "11111111111111111111111111111111"  # pump's "SOL" quote mint in migration events; also the default key
SOL_QUOTES = {WSOL, SYSTEM}
# Hard wall: no tape row is from 2026-09-12 or later (U1-B holdout).
WALL_TS = int(datetime(2026, 9, 12, tzinfo=timezone.utc).timestamp())
E_NAMES = ("CompletePumpAmmMigrationEvent", "CreatePoolEvent", "BoostBuyAndBurnEvent", "InitBoostEvent")

S_AMM_COLS = [
    "slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "pool", "quote_mint", "side",
    "base_amount", "quote_amount", "lp_fee", "pool_base_token_reserves", "pool_quote_token_reserves",
    "virtual_quote_reserves", "base_supply", "coin_creator", "coin_creator_fee_basis_points",
    "user_token_owner", "canonical", "can_boost",
    "chain_pool_base", "chain_pool_quote",   # post-swap reserves, for the return test's as-of states (AMENDMENT_2 Q9)
]


class WallError(ValueError):
    """A row or unit at or after 2026-09-12T00:00Z, or a day outside the requested days."""


@dataclass(frozen=True)
class Unit:
    path: str  # the unit's research/ directory
    day: str
    from_slot: int
    to_slot: int
    schema: str  # "v1" (no CF table) or "v2"


def _research_dir(p: str) -> str:
    p = os.path.abspath(p)
    if os.path.basename(p) != "research" and os.path.isdir(os.path.join(p, "research")):
        p = os.path.join(p, "research")
    return p


def check_day(day: str) -> None:
    d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if d.timestamp() >= WALL_TS:
        raise WallError(f"day {day} is on or after 2026-09-12; no such tape rows may be read")


def describe_unit(path: str) -> Unit:
    r = _research_dir(path)
    st_path = os.path.join(r, "stats.json")
    if os.path.exists(st_path):
        with open(st_path) as f:
            st = json.load(f)
        day, a, b = st["day"], int(st["from_slot"]), int(st["to_slot"])
    else:  # .../<day>/<from>-<to>/research
        unit_dir = os.path.dirname(r)
        a, b = (int(x) for x in os.path.basename(unit_dir).split("-"))
        day = os.path.basename(os.path.dirname(unit_dir))
    schema = "v2" if os.path.exists(os.path.join(r, "CF.csv.zst")) else "v1"
    return Unit(r, day, a, b, schema)


def find_units(cache: str, days: list[str]) -> list[Unit]:
    out = []
    for day in days:
        check_day(day)
        dd = os.path.join(cache, day)
        if not os.path.isdir(dd):
            continue
        for name in sorted(os.listdir(dd)):
            r = os.path.join(dd, name, "research")
            if os.path.isdir(r):
                out.append(describe_unit(r))
    return out


def select_units(paths: list[str], days: list[str]) -> list[Unit]:
    for d in days:
        check_day(d)
    units = [describe_unit(p) for p in paths]
    for u in units:
        if u.day not in days:
            raise WallError(f"unit {u.path} is from {u.day}, not in the requested days {days}")
    units.sort(key=lambda u: u.from_slot)
    for a, b in zip(units, units[1:]):
        if b.from_slot <= a.to_slot:
            raise ValueError(f"units overlap: {a.path} and {b.path}")
    return units


def _guard_times(t: pd.Series, what: str) -> None:
    if len(t) and int(t.max()) >= WALL_TS:
        raise WallError(f"{what}: a row has block_time >= 2026-09-12T00:00Z")


def load_blocks(u: Unit) -> pd.DataFrame:
    b = pd.read_csv(os.path.join(u.path, "B.csv.zst"), compression="zstd", usecols=["slot", "block_time"])
    _guard_times(b.block_time, u.path + " B")
    return b


def load_events(u: Unit) -> pd.DataFrame:
    """The E events Design A needs, flattened. Lines are filtered by name before parsing."""
    rows = []
    with open(os.path.join(u.path, "E.jsonl.zst"), "rb") as fh:
        for line in io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8"):
            if not any(n in line for n in E_NAMES):
                continue
            j = json.loads(line)
            if j.get("event") not in E_NAMES:
                continue
            f = j.get("fields", {})
            rows.append({
                "event": j["event"], "slot": int(j["slot"]), "block_time": int(j["block_time"]),
                "tx_idx": int(j.get("tx_idx", 0)), "ev_idx": int(j.get("ev_idx", 0)), "signature": j["signature"],
                "pool": f.get("pool"), "mint": f.get("mint") or f.get("base_mint"),
                "quote_mint": f.get("quote_mint"), "is_mayhem_mode": f.get("is_mayhem_mode"),
                "boost_vault_remaining": f.get("boost_vault_remaining"),
            })
    cols = ["event", "slot", "block_time", "tx_idx", "ev_idx", "signature", "pool", "mint", "quote_mint",
            "is_mayhem_mode", "boost_vault_remaining"]
    df = pd.DataFrame(rows, columns=cols)
    _guard_times(df.block_time, u.path + " E")
    return df


def iter_swaps(u: Unit, chunksize: int = 500_000):
    """S_amm rows with Design A's columns; numbers that can exceed int64 are read as float64."""
    dtypes = {c: "float64" for c in ("base_amount", "quote_amount", "lp_fee", "pool_base_token_reserves",
                                     "pool_quote_token_reserves", "virtual_quote_reserves", "base_supply",
                                     "chain_pool_base", "chain_pool_quote")}
    dtypes.update({c: "object" for c in ("signature", "signer", "pool", "quote_mint", "side", "coin_creator",
                                         "user_token_owner")})
    for ch in pd.read_csv(os.path.join(u.path, "S_amm.csv.zst"), compression="zstd", usecols=S_AMM_COLS,
                          dtype=dtypes, chunksize=chunksize):
        _guard_times(ch.block_time, u.path + " S_amm")
        yield ch


def coverage_segments(units: list[Unit], blocks: list[pd.DataFrame]) -> pd.DataFrame:
    """Contiguous slot runs of the given units, with their first and last block times."""
    segs = []
    for u, b in zip(units, blocks):
        t0, t1 = int(b.block_time.min()), int(b.block_time.max())
        if segs and u.from_slot == segs[-1]["to_slot"] + 1:
            segs[-1].update(to_slot=u.to_slot, t_end=max(segs[-1]["t_end"], t1))
        else:
            segs.append({"from_slot": u.from_slot, "to_slot": u.to_slot, "t_start": t0, "t_end": t1})
    return pd.DataFrame(segs, columns=["from_slot", "to_slot", "t_start", "t_end"])


def segment_of(slots: np.ndarray, segs: pd.DataFrame) -> np.ndarray:
    i = np.searchsorted(segs.from_slot.to_numpy(), slots, side="right") - 1
    ok = (i >= 0) & (slots <= segs.to_slot.to_numpy()[np.clip(i, 0, None)])
    return np.where(ok, i, -1)


# ---------------------------------------------------------------- tape steps (research/SHARED_TAPE_PLAN.md)

STEP_DAYS = {
    "A": ("2026-09-10", "2026-09-11"),
    "B": ("2026-09-07", "2026-09-08", "2026-09-09"),
    "C": ("2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"),
}
STEP_ORDER = ("A", "B", "C")
PLAN = "/home/user/tape-work/plan.txt"


class IncompleteError(ValueError):
    """The days do not form complete tape steps, or a step day is not fully covered."""


def steps_from_days(days) -> tuple[str, ...]:
    """The steps whose days are all among `days`, in order."""
    ds = set(days)
    return tuple(s for s in STEP_ORDER if set(STEP_DAYS[s]) <= ds)


def scoring_steps(days) -> tuple[str, ...]:
    """For scoring, the days must be exactly Step A, A+B or A+B+C (the count rule's order)."""
    ds = set(days)
    for k in range(1, len(STEP_ORDER) + 1):
        steps = STEP_ORDER[:k]
        if ds == {d for s in steps for d in STEP_DAYS[s]}:
            return steps
    raise IncompleteError(f"days {sorted(ds)} are not exactly Step A, A+B or A+B+C")


def read_plan(path: str = PLAN) -> dict[str, list[tuple[int, int]]]:
    """Planned units per day, from lines "DAY EPOCH FROM TO", sorted by slot."""
    plan: dict[str, list[tuple[int, int]]] = {}
    with open(path) as f:
        for line in f:
            p = line.split()
            if len(p) == 4:
                plan.setdefault(p[0], []).append((int(p[2]), int(p[3])))
    return {d: sorted(set(v)) for d, v in plan.items()}


def check_days_complete(units: list[Unit], days, plan: dict) -> None:
    """Each day must be fully covered: its units are exactly the planned ones, and their slot ranges run
    contiguously from the day's first unit to its last."""
    for d in days:
        planned = plan.get(d)
        if not planned:
            raise IncompleteError(f"{d}: no planned units")
        for (a0, b0), (a1, _) in zip(planned, planned[1:]):
            if a1 != b0 + 1:
                raise IncompleteError(f"{d}: slot gap between planned units ending {b0} and starting {a1}")
        have = sorted((u.from_slot, u.to_slot) for u in units if u.day == d)
        missing = sorted(set(planned) - set(have))
        extra = sorted(set(have) - set(planned))
        if missing or extra or len(have) != len(set(have)):
            raise IncompleteError(f"{d}: missing units {missing[:5]}, units not in the plan {extra[:5]}")
