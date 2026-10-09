"""Reading shared-tape units (research/shared-tape/README.md). Read only; every value stays a string until a caller
converts it, so lamports and raw token amounts keep full integer precision."""
import hashlib
import io
import json
import os
import re
from dataclasses import dataclass

import pandas as pd

from .constants import WALL_DAY

_UNIT = re.compile(r"(\d{4}-\d{2}-\d{2})/(\d+)-(\d+)(?:/research)?/?$")


@dataclass(frozen=True)
class Unit:
    day: str
    from_slot: int
    to_slot: int
    dir: str  # the directory holding the research tables


def parse_unit(path: str) -> Unit:
    """A unit directory: .../<day>/<from>-<to>[/research]. Refuses any day on or after the wall."""
    p = os.path.abspath(path)
    m = _UNIT.search(p)
    if not m:
        raise ValueError(f"not a unit directory (<day>/<from>-<to>[/research]): {path}")
    day, a, b = m.group(1), int(m.group(2)), int(m.group(3))
    if day >= WALL_DAY:
        raise ValueError(f"day {day} is on or after {WALL_DAY}: never read")
    d = p if p.endswith("/research") else os.path.join(p, "research")
    if not os.path.isdir(d):
        d = p
    return Unit(day, a, b, d)


def coverage_intervals(units):
    """Contiguous slot intervals covered by the units, merged: [(from, to)]."""
    iv = sorted((u.from_slot, u.to_slot) for u in units)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def interval_of(intervals, slot):
    for a, b in intervals:
        if a <= slot <= b:
            return (a, b)
    return None


def read_table(unit: Unit, name: str, usecols=None) -> pd.DataFrame:
    """One CSV table of a unit as strings (empty cells stay ''). A missing file gives an empty frame."""
    path = os.path.join(unit.dir, f"{name}.csv.zst")
    if not os.path.exists(path):
        return pd.DataFrame(columns=list(usecols or []), dtype=str)
    cols = None if usecols is None else (lambda c: c in set(usecols))
    df = pd.read_csv(path, compression="zstd", dtype=str, keep_default_na=False, usecols=cols)
    for c in usecols or []:
        if c not in df.columns:  # schema v1 lacks some columns
            df[c] = ""
    return df


def read_table_chunks(unit: Unit, name: str, usecols, chunksize: int = 200_000):
    """`read_table` in row chunks, in file order (the low-memory reader). Each chunk has exactly `usecols`, as
    strings; concatenated, the chunks equal `read_table(unit, name, usecols)[usecols]`."""
    path = os.path.join(unit.dir, f"{name}.csv.zst")
    if not os.path.exists(path):
        yield pd.DataFrame(columns=list(usecols), dtype=str)
        return
    want = set(usecols)
    with pd.read_csv(path, compression="zstd", dtype=str, keep_default_na=False, usecols=lambda c: c in want,
                     chunksize=chunksize) as rd:
        for df in rd:
            for c in usecols:
                if c not in df.columns:  # schema v1 lacks some columns
                    df[c] = ""
            yield df[list(usecols)]


def read_events(unit: Unit, names) -> list:
    """E.jsonl.zst rows whose event is in `names`."""
    import zstandard
    path = os.path.join(unit.dir, "E.jsonl.zst")
    if not os.path.exists(path):
        return []
    names = set(names)
    out = []
    with open(path, "rb") as f:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(f), encoding="utf-8")
        for line in text:
            if not line.strip():
                continue
            if not any(n in line for n in names):
                continue
            d = json.loads(line)
            if d.get("event") in names:
                out.append(d)
    return out


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def input_hashes(units) -> dict:
    """sha256 of every input file (§9.4)."""
    out = {}
    for u in units:
        for fn in sorted(os.listdir(u.dir)):
            out[f"{u.day}/{u.from_slot}-{u.to_slot}/{fn}"] = sha256_file(os.path.join(u.dir, fn))
    return out


def code_hash() -> dict:
    """sha256 of every source file of this package and of run.py (§9.4)."""
    here = os.path.dirname(os.path.abspath(__file__))
    files = [os.path.join(here, f) for f in sorted(os.listdir(here)) if f.endswith(".py")]
    files.append(os.path.join(os.path.dirname(here), "run.py"))
    return {os.path.relpath(f, os.path.dirname(here)): sha256_file(f) for f in files if os.path.exists(f)}


# ---------------------------------------------------------------- Step A completeness

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PLAN_PATH = os.path.join(REPO, "research", "shared-tape", "stepa-plan.txt")
# R2-5: the only unit plans a stage may be checked against, by sha256, with the days each is registered for
# (research/shared-tape/stepa-plan.txt and stepb-plan.txt with its stepb-plan.sha256; the same shas W1 and D1 fix).
REGISTERED_PLANS = {
    "fa99c8788f845a7d9f4a5c967d7cce18c0a7f476082c1969fc35cf4f57f38fc7": ("2026-09-10", "2026-09-11"),
    "44f133a5b825876b8ca29bb9b807e3d75e2d2fb375780e26f3570fdab03058d5": ("2026-09-07", "2026-09-08", "2026-09-09"),
}
REQUIRED_TABLES = ("E.jsonl.zst", "B.csv.zst", "S_curve.csv.zst", "S_amm.csv.zst", "T.csv.zst", "T_coverage.csv.zst")


def load_plan(path: str = PLAN_PATH) -> dict:
    """The committed unit plan: one 'DAY EPOCH FROM TO' line per unit. Returns {day: sorted [(from, to)]}."""
    plan = {}
    with open(path) as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            parts = line.split()
            if len(parts) != 4:
                raise ValueError(f"{path}:{n}: expected 'DAY EPOCH FROM TO'")
            plan.setdefault(parts[0], []).append((int(parts[2]), int(parts[3])))
    return {d: sorted(v) for d, v in plan.items()}


def check_plan_registered(path: str, days) -> str:
    """R2-5: the plan must be a registered one (sha256 in REGISTERED_PLANS) and registered for every day used.
    Returns its sha256; raises ValueError otherwise."""
    sha = sha256_file(path)
    reg = REGISTERED_PLANS.get(sha)
    if reg is None:
        raise ValueError(f"{path} (sha256 {sha}) is not a registered unit plan")
    bad = sorted(set(days) - set(reg))
    if bad:
        raise ValueError(f"the plan {path} is not registered for {bad}")
    return sha


def check_complete(units, days, plan: dict) -> None:
    """Every day used must be read whole: exactly that day's planned units, contiguous from its first FROM to its last
    TO, each present on disk with the tables the code reads. Units of any other day are refused. Raises ValueError."""
    days = sorted(set(days))
    if not days:
        raise ValueError("no day given")
    extra = sorted({u.day for u in units} - set(days))
    if extra:
        raise ValueError(f"units from days outside this stage's days {days}: {extra}")
    for d in days:
        want = plan.get(d)
        if not want:
            raise ValueError(f"day {d} has no planned units")
        for (a0, b0), (a1, _) in zip(want, want[1:]):
            if a1 != b0 + 1:
                raise ValueError(f"day {d}: the plan is not contiguous at {b0}..{a1}")
        have = sorted((u.from_slot, u.to_slot) for u in units if u.day == d)
        if len(have) != len(set(have)):
            raise ValueError(f"day {d}: a unit is listed twice")
        missing = sorted(set(want) - set(have))
        unplanned = sorted(set(have) - set(want))
        if missing or unplanned:
            raise ValueError(f"day {d} incomplete: missing units {missing[:5]}{'…' if len(missing) > 5 else ''} "
                             f"({len(missing)}), unplanned units {unplanned[:5]}")
        for u in units:
            if u.day == d:
                absent = [t for t in REQUIRED_TABLES if not os.path.exists(os.path.join(u.dir, t))]
                if absent:
                    raise ValueError(f"unit {d} {u.from_slot}-{u.to_slot} lacks {absent} on disk")


def unit_record(u: Unit) -> dict:
    return dict(day=u.day, from_slot=u.from_slot, to_slot=u.to_slot, dir=u.dir)


def boost_keys(events: list) -> set:
    """(signature, outer_ix, pool) of every BoostBuyAndBurnEvent. Decoder v3 flags these swaps protocol=1; older units
    leave the flag 0 (and the owner empty), so the S row is matched to its event instead."""
    return {(e["signature"], str(e["outer_ix"]), e["fields"].get("pool", "")) for e in events
            if e.get("event") == "BoostBuyAndBurnEvent"}


def read_boost_keys(units) -> set:
    out = set()
    for u in units:
        out |= boost_keys(read_events(u, {"BoostBuyAndBurnEvent"}))
    return out
