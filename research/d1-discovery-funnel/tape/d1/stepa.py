"""Step A completeness: the units read must equal the Step A plan's rows exactly, day by day, with no gaps.

The plan is research/shared-tape/stepa-plan.txt ("DAY EPOCH FROM TO" per unit); its sha256 is fixed in
config.STEPA_PLAN_SHA256, so a changed plan is refused rather than silently followed.
"""
import hashlib
import os
from typing import Dict, List, Sequence, Tuple

from . import config as C
from .load import Unit, segments

PLAN_DEFAULT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
                                             "shared-tape", "stepa-plan.txt"))


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_plan(path: str) -> List[Tuple[str, int, int]]:
    rows = []
    with open(path) as fh:
        for line in fh:
            p = line.split()
            if len(p) == 4:
                rows.append((p[0], int(p[2]), int(p[3])))
    return rows


def plan_sha_ok(path: str = PLAN_DEFAULT, expected: str = C.STEPA_PLAN_SHA256) -> Tuple[bool, str]:
    if not os.path.exists(path):
        return False, "missing"
    sha = sha256_file(path)
    return sha == expected, sha


def plan_check(units: Sequence[Unit], days: Sequence[str], path: str = PLAN_DEFAULT,
               expected: str = C.STEPA_PLAN_SHA256) -> Dict:
    ok, sha = plan_sha_ok(path, expected)
    res = {"plan_path": path, "plan_sha256": sha, "plan_sha_ok": ok, "per_day": {}, "gap_free": False,
           "complete": False}
    if not ok:
        return res
    plan = read_plan(path)
    all_ok = True
    for day in sorted(days):
        planned = {(f, t) for d, f, t in plan if d == day}
        present = {(u.from_slot, u.to_slot) for u in units if u.day == day}
        missing, extra = sorted(planned - present), sorted(present - planned)
        day_ok = bool(planned) and not missing and not extra
        res["per_day"][day] = {"planned": len(planned), "present": len(present), "missing": missing[:20],
                               "n_missing": len(missing), "extra": extra[:20], "n_extra": len(extra), "ok": day_ok}
        all_ok &= day_ok
    res["gap_free"] = len(segments(units)) == 1
    res["complete"] = bool(all_ok and res["gap_free"] and len(units) > 0)
    return res
