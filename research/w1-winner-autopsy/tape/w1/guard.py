"""Guards every scored stage calls (review item 2) and the registered days per stage (item 3).

verify(work, role) refuses unless:
- the frozen unit plan of every day the role reads exists and has its registered sha256;
- the ledger's units for each of those days equal the plan's rows exactly, with no gap and no development flag;
- the manifest's code hashes equal the current code, and every ledger day file matches its recorded sha256;
- every input file the ledger read still has its recorded sha256;
- every day of the role is present;
- for `extract`, validation.pkl matches the hash `validation` recorded."""
import glob
import os

from . import load

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
STEP_A_PLAN = os.path.join(REPO, "research", "shared-tape", "stepa-plan.txt")
STEP_A_SHA = "fa99c8788f845a7d9f4a5c967d7cce18c0a7f476082c1969fc35cf4f57f38fc7"
# day -> (plan file, sha256). Step B (09-07..09-09) and Step C (09-02..09-06) have no frozen plan yet: a scored
# stage that needs them refuses until their plan and hash are registered here.
PLANS = {"2026-09-10": (STEP_A_PLAN, STEP_A_SHA), "2026-09-11": (STEP_A_PLAN, STEP_A_SHA)}

STEP_A = ["2026-09-10", "2026-09-11"]
STEP_B = ["2026-09-07", "2026-09-08", "2026-09-09"]
STEP_C = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]
ROLES = {
    "gate": {"days": STEP_A},
    "discovery": {"days": STEP_A, "rank": "2026-09-10", "test": ["2026-09-11"]},
    "validation": {"days": STEP_B, "rank": "2026-09-07", "test": ["2026-09-08", "2026-09-09"]},
    "extract": {"days": STEP_B + STEP_A, "rank": "2026-09-07", "test": ["2026-09-08", "2026-09-09"]},
    "ruletest": {"days": STEP_C},
}


class Refused(SystemExit):
    pass


def refuse(msg):
    raise Refused(f"refused: {msg}")


def check_args(role, rank=None, test=None, days=None):
    """Registered choices only: options may be omitted, never changed."""
    r = ROLES[role]
    if rank is not None and rank != r.get("rank"):
        refuse(f"{role} ranks on {r.get('rank')} only")
    if test and list(test) != r.get("test"):
        refuse(f"{role} tests on {r.get('test')} only")
    if days and sorted(days) != sorted(r["days"]):
        refuse(f"{role} reads exactly {r['days']}")
    return r


def plan_units(day):
    if day not in PLANS:
        refuse(f"no frozen unit plan is registered for {day}")
    path, sha = PLANS[day]
    if not os.path.exists(path) or load.file_sha256(path) != sha:
        refuse(f"plan {path} is missing or its sha256 is not {sha}")
    rows = []
    with open(path) as f:
        for line in f:
            p = line.split()
            if len(p) >= 4 and p[0] == day:
                rows.append(f"{p[0]}/{int(p[2])}-{int(p[3])}")
    return sorted(rows, key=lambda x: int(x.split("/")[1].split("-")[0]))


def check_contiguous(unit_names):
    los = [tuple(int(v) for v in u.split("/")[1].split("-")) for u in unit_names]
    los.sort()
    for (a_lo, a_hi), (b_lo, b_hi) in zip(los, los[1:]):
        if b_lo != a_hi + 1:
            refuse(f"gap between {a_hi} and {b_lo}")


def verify(work, role, manifest, code_hashes, check_inputs=True):
    r = ROLES[role]
    if manifest.get("allow_gaps"):
        refuse("the ledger was built with --dev-allow-gaps")
    if manifest.get("stats", {}).get("gaps"):
        refuse(f"the ledger read gaps: {manifest['stats']['gaps']}")
    if manifest.get("code") != code_hashes:
        refuse("the ledger was built by other code than the current code")
    units = manifest.get("units", [])
    for day in r["days"]:
        want = plan_units(day)
        got = sorted([u for u in units if u.startswith(day + "/")],
                     key=lambda x: int(x.split("/")[1].split("-")[0]))
        if got != want:
            refuse(f"{day}: the ledger's units differ from the plan ({len(got)} read, {len(want)} planned)")
        check_contiguous(want)
        f = os.path.join(work, f"ledger-{day}.pkl")
        if not os.path.exists(f):
            refuse(f"{day}: no ledger day file")
        if load.file_sha256(f) != manifest.get("ledger_sha", {}).get(day):
            refuse(f"{day}: ledger day file does not match its recorded sha256")
    if check_inputs:
        for name, path in manifest.get("input_paths", {}).items():
            if not any(name.startswith(d + "/") for d in r["days"]):
                continue
            if not os.path.exists(path) or load.file_sha256(path) != manifest["inputs"].get(name):
                refuse(f"input {name} changed since the ledger read it")
    if role == "extract":
        vp = os.path.join(work, "validation.pkl")
        vs = manifest.get("validation_sha")
        if not vs or not os.path.exists(vp) or load.file_sha256(vp) != vs:
            refuse("validation.pkl is missing or does not match the hash recorded by `validation`")
    return r


def ledger_units(manifest, days):
    """The units the ledger read for the given days (never the cache)."""
    paths = manifest.get("unit_paths", {})
    us = load.parse_units([paths[u] for u in manifest["units"] if u.split("/")[0] in days])
    have = {u.day for u in us}
    missing = [d for d in days if d not in have]
    if missing:
        refuse(f"no units for {missing}")
    return us


def ledger_files(work):
    return sorted(glob.glob(os.path.join(work, "ledger-*.pkl")))
