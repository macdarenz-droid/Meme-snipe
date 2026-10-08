"""Input and code guards (review finding 1).

- The Step A plan (`research/shared-tape/stepa-plan.txt`, "DAY EPOCH FROM TO" per unit) must have the frozen sha256.
- The units read for a day must equal that day's plan rows exactly, and the plan rows must leave no gap.
- `decide` writes a manifest (plan sha, units, input and code hashes); every later stage refuses unless its own
  inputs and code match it. `freeze` copies the hashes into frozen.json; `score` refuses if the code changed since
  the freeze or if a role's days are wrong.
"""
import hashlib
import json
import os
from typing import Dict, List, Optional

from . import params as P

REPO = os.path.abspath(os.path.join(P.HERE, "..", "..", ".."))
PLAN_PATH = os.path.join(REPO, "research", "shared-tape", "stepa-plan.txt")
PLAN_SHA = "fa99c8788f845a7d9f4a5c967d7cce18c0a7f476082c1969fc35cf4f57f38fc7"
DISCOVERY_DAYS = ("2026-09-10", "2026-09-11")
VALIDATION_DAYS = ("2026-09-07", "2026-09-08", "2026-09-09")
CODE_FILES = ("g1.py", "fixed_costs.ts", "fixed_costs.json")


class GuardError(SystemExit):
    pass


def sha_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_plan(path: str = PLAN_PATH, sha: str = PLAN_SHA) -> Dict[str, List[tuple]]:
    got = sha_file(path)
    if got != sha:
        raise GuardError(f"plan {path} has sha256 {got}, expected {sha}")
    plan: Dict[str, List[tuple]] = {}
    with open(path) as fh:
        lines = fh.read().splitlines()
    for line in lines:
        f = line.split()
        if len(f) != 4:
            continue
        plan.setdefault(f[0], []).append((int(f[2]), int(f[3])))
    for day, rows in plan.items():
        rows.sort()
        for (a, b), (c, _) in zip(rows, rows[1:]):
            if c != b + 1:
                raise GuardError(f"plan for {day} has a gap between {b} and {c}")
    return plan


def check_units(units, plan: Dict[str, List[tuple]], allow_subset: bool = False):
    """Each day's units must equal the day's plan rows exactly (a subset only with allow_subset, for development)."""
    days = sorted(set(u.day for u in units))
    for day in days:
        if day not in plan:
            raise GuardError(f"no plan rows for {day}")
        have = sorted((u.from_slot, u.to_slot) for u in units if u.day == day)
        want = plan[day]
        extra = set(have) - set(want)
        if extra:
            raise GuardError(f"{day}: units not in the plan: {sorted(extra)}")
        if not allow_subset and have != want:
            missing = sorted(set(want) - set(have))
            raise GuardError(f"{day}: {len(missing)} plan units missing, first {missing[:3]}")


def code_hash() -> str:
    h = hashlib.sha256()
    files = [os.path.join(P.HERE, f) for f in CODE_FILES]
    lib = os.path.join(P.HERE, "g1lib")
    files += sorted(os.path.join(lib, f) for f in os.listdir(lib) if f.endswith(".py"))
    for f in files:
        h.update(os.path.relpath(f, P.HERE).encode())
        h.update(sha_file(f).encode())
    return h.hexdigest()


def input_hashes(units) -> Dict[str, str]:
    out = {}
    for u in units:
        for f in sorted(os.listdir(u.path)):
            out[f"{u.day}/{u.from_slot}-{u.to_slot}/{f}"] = sha_file(os.path.join(u.path, f))
    return out


def digest(d: Dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()


def make_manifest(units, plan_sha: str, dev: bool) -> dict:
    ih = input_hashes(units)
    return {"plan_sha": plan_sha, "dev_subset": dev, "days": sorted(set(u.day for u in units)),
            "units": [f"{u.day} {u.from_slot}-{u.to_slot}" for u in units], "input_hashes": ih,
            "inputs_digest": digest(ih), "code_hash": code_hash()}


def write_manifest(out_dir: str, man: dict):
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)


def read_manifest(out_dir: str) -> dict:
    p = os.path.join(out_dir, "manifest.json")
    if not os.path.exists(p):
        raise GuardError(f"{p} missing: run decide first")
    with open(p) as f:
        return json.load(f)


def verify(man: dict, units=None, allow_dev: bool = False, files: Optional[Dict[str, str]] = None):
    """Refuses unless the code, the units and their hashes (and any listed output files) match the manifest."""
    if man.get("dev_subset") and not allow_dev:
        raise GuardError("manifest was made from a development subset of units; this stage needs whole days")
    if man["code_hash"] != code_hash():
        raise GuardError("code changed since decide wrote the manifest")
    if units is not None:
        names = [f"{u.day} {u.from_slot}-{u.to_slot}" for u in units]
        if names != man["units"]:
            raise GuardError("units differ from the manifest")
        if digest(input_hashes(units)) != man["inputs_digest"]:
            raise GuardError("input file hashes differ from the manifest")
    for key, path in (files or {}).items():
        if man.get(key) != sha_file(path):
            raise GuardError(f"{os.path.basename(path)} differs from the manifest ({key})")


def check_score(man: dict, frozen: dict, role: str, trade_days):
    """score: the code must be the code frozen with the discovery medians, and each role must read its own days."""
    if frozen.get("code_hash") != code_hash() or man["code_hash"] != frozen.get("code_hash"):
        raise GuardError("code hash differs from the one recorded in frozen.json")
    if tuple(frozen.get("days", ())) != DISCOVERY_DAYS:
        raise GuardError(f"frozen.json must be made on {DISCOVERY_DAYS}, got {frozen.get('days')}")
    want = VALIDATION_DAYS if role == "validation" else DISCOVERY_DAYS
    if tuple(man["days"]) != want:
        raise GuardError(f"{role} decisions must cover exactly {want}, got {man['days']}")
    if tuple(sorted(set(trade_days))) != want:
        raise GuardError(f"{role} trades must cover exactly {want}, got {sorted(set(trade_days))}")
