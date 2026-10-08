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
