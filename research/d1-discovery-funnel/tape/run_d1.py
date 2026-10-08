#!/usr/bin/env python3
"""D1 entry point. Run every data command with `nice -n 19`.

  stage1   tape units -> decision points, timing and the 28 as-of features   (points.pkl, features.pkl, manifest)
  stage2   tape units + points -> outcomes (fills, net returns, round-trip cost) in a separate process (outcomes.pkl)
  summary  counts and shapes of a run (no return statistics)
  search   PREREG §5 on a discovery run -> search_table.csv, frozen_rules.json
  validate PREREG §6 on a validation run with frozen rules (refuses without --confirm-validation-read)

See README.md.
"""
import argparse
import glob
import hashlib
import json
import os
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from d1 import config as C  # noqa: E402

# Frozen rulings this code implements; written into frozen_rules.json, and validate refuses rules without H8_AMENDMENT.
FROZEN_AMENDMENTS = ("AMENDMENT_1", "AMENDMENT_2", "H8_AMENDMENT", "AMENDMENT_3", "H8_AMENDMENT_2", "AMENDMENT_4",
                     "AMENDMENT_5")
# Every frozen ruling that governs D1 (red team R2-9). search and validate refuse while any is missing from
# FROZEN_AMENDMENTS. AMENDMENT_3 (d1/search.py h8_first ranking) and research/brainstorm-loop/H8_AMENDMENT_2.md
# (d1/gates.py, holders.gate_h12/gate_h13, h8.add_h8 universe floors, validate.h8_report at $5) are implemented;
# AMENDMENT_4 (H13 tape proxy, holders.h13_proxy_sets, labelled config.H13_PROXY_LABEL; universe-exit secondary
# dropped) and AMENDMENT_5 (creation-slot buyers: create slot .. +2, keyed on the curve user) too.
REQUIRED_RULINGS = ("AMENDMENT_1", "AMENDMENT_2", "H8_AMENDMENT", "AMENDMENT_3", "H8_AMENDMENT_2", "AMENDMENT_4",
                    "AMENDMENT_5")


def code_hash() -> str:
    h = hashlib.sha256()
    for f in sorted(glob.glob(os.path.join(HERE, "d1", "*.py"))) + [os.path.abspath(__file__)]:
        h.update(os.path.basename(f).encode())
        with open(f, "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()


def _units(args):
    units = list(args.units or [])
    if args.units_file:
        with open(args.units_file) as fh:
            units += [l.strip() for l in fh if l.strip()]
    if not units:
        sys.exit("no units given")
    return units


def stage1(args):
    from d1.features import compute_features
    from d1.load import dump_json, file_hashes, load, manifest
    from d1.pool_state import PoolBook
    from d1.stepa import PLAN_DEFAULT, plan_check, plan_sha_ok
    from d1.universe import Clock, decision_points, migrations
    dev = bool(args.dev_unknown_migration)
    if args.no_hash and not dev:
        sys.exit("refusing: --no-hash is for dev runs only")
    plan_path = args.plan or PLAN_DEFAULT
    ok, sha = plan_sha_ok(plan_path)
    if not ok:
        sys.exit(f"refusing: Step A plan sha256 {sha} != {C.STEPA_PLAN_SHA256}")
    units = [os.path.abspath(u) for u in _units(args)]
    os.makedirs(args.out, exist_ok=True)
    tape = load(units, args.days, all_pools=dev)
    plan = plan_check(tape.units, args.days, plan_path)
    book = PoolBook(tape.amm)
    tape.amm = tape.amm.iloc[:0]   # the pool book holds the rows from here on
    clock = Clock(tape)
    migs = migrations(tape, book, dev_unknown_migration=dev)
    pts = decision_points(tape, book, migs, clock)
    feats = compute_features(tape, book, pts, clock) if len(pts) else pd.DataFrame()
    pts.to_pickle(os.path.join(args.out, "points.pkl"))
    feats.to_pickle(os.path.join(args.out, "features.pkl"))
    migs.to_pickle(os.path.join(args.out, "migrations.pkl"))
    from d1.h8 import pool_days
    pool_days(book).to_pickle(os.path.join(args.out, "pool_days.pkl"))
    m = manifest(tape)
    m.update({"stage": "stage1", "dev": dev, "code_sha256": code_hash(), "unit_dirs": units,
              "stepa_plan": plan, "clock_nonmonotone_blocks": clock.nonmonotone,
              "input_sha256": file_hashes(tape.units) if not args.no_hash else "skipped"})
    dump_json(m, os.path.join(args.out, "manifest_stage1.json"))
    print(json.dumps({"migrations": len(migs), "excluded": migs.excluded.value_counts().to_dict() if len(migs) else {},
                      "decision_points": len(pts), "eligible": int(pts.eligible.sum()) if len(pts) else 0,
                      "features_rows": len(feats), "stepa_complete": plan["complete"]}, indent=1))


def stage2(args):
    """Loads exactly stage 1's units (from its manifest) and, for non-dev runs, checks their sha256 again."""
    from d1.load import dump_json, file_hashes, load, manifest, parse_unit
    from d1.outcomes import compute_outcomes
    from d1.pool_state import PoolBook
    with open(os.path.join(args.out, "manifest_stage1.json")) as fh:
        m1 = json.load(fh)
    dev = bool(m1.get("dev"))
    units = m1["unit_dirs"]
    if not dev:
        if m1.get("input_sha256") in (None, "skipped"):
            sys.exit("refusing: stage 1 has no input hashes")
        now = file_hashes([parse_unit(u) for u in units])
        if now != m1["input_sha256"]:
            sys.exit("refusing: the unit files differ from the ones stage 1 read")
    tape = load(units, m1["days"], all_pools=dev)
    book = PoolBook(tape.amm)
    ce = tape.ev["CreateEvent"].drop_duplicates("mint")
    token_programs = dict(zip(ce.mint.astype(int), ce.token_program))
    pts = pd.read_pickle(os.path.join(args.out, "points.pkl"))
    out = compute_outcomes(book, pts, token_programs) if len(pts) else pd.DataFrame()
    out.to_pickle(os.path.join(args.out, "outcomes.pkl"))
    m = manifest(tape)
    m.update({"stage": "stage2", "dev": dev, "code_sha256": code_hash(), "unit_dirs": units,
              "input_sha256": m1["input_sha256"] if dev else now})
    dump_json(m, os.path.join(args.out, "manifest_stage2.json"))
    print(json.dumps({"outcome_rows": len(out), "entry_ok": int(out.entry_ok.sum()) if len(out) else 0}, indent=1))


def with_h8(df: pd.DataFrame, solusd: str = None):
    """H8_AMENDMENT: H8-eligible flags at $5, $20, $50 from the committed hourly SOL/USD (as-of). Only the pinned
    directory form is accepted (default research/brainstorm-loop/sol-usd): its SHA256SUMS must have the sha256 in
    config.SOLUSD_SUMS_SHA256 and every needed day's file must match it."""
    from d1.h8 import SOLUSD_DIR_DEFAULT, add_h8, load_solusd_dir
    solusd = solusd or SOLUSD_DIR_DEFAULT
    if not os.path.isdir(solusd):
        sys.exit("refusing: --solusd must be the pinned SOL/USD directory (single files are not accepted)")
    try:
        hours, close, sha = load_solusd_dir(solusd, df.day.unique() if len(df) else [])
    except (ValueError, OSError) as e:
        sys.exit(f"refusing: {e}")
    return add_h8(df, hours, close), sha


def joined(run: str) -> pd.DataFrame:
    pts = pd.read_pickle(os.path.join(run, "points.pkl"))
    feats = pd.read_pickle(os.path.join(run, "features.pkl"))
    outs = pd.read_pickle(os.path.join(run, "outcomes.pkl"))
    el = pts[pts.eligible]
    df = el.merge(feats, on=["pool", "tau"], how="inner").merge(outs, on=["pool", "tau"], how="left")
    return df


def summary(args):
    pts = pd.read_pickle(os.path.join(args.run, "points.pkl"))
    feats = pd.read_pickle(os.path.join(args.run, "features.pkl"))
    rep = {"points": len(pts), "eligible": int(pts.eligible.sum()) if len(pts) else 0,
           "pools": int(pts.pool.nunique()) if len(pts) else 0,
           "valid_15": int(pts.valid_15.sum()) if len(pts) else 0, "valid_60": int(pts.valid_60.sum()) if len(pts) else 0,
           "feature_non_null": {f: int(feats[f].notna().sum()) for f in C.FEATURES} if len(feats) else {},
           "feature_quantiles_5_50_95": {f: [round(float(x), 6) for x in feats[f].quantile([.05, .5, .95])]
                                         for f in C.FEATURES} if len(feats) else {}}
    if len(feats):
        from d1.h8 import h8_counts
        el = pts[pts.eligible].merge(feats.drop(columns=[c for c in feats if c in pts and c not in ("pool", "tau")]),
                                     on=["pool", "tau"])
        df, px_sha = with_h8(el, args.solusd)
        pdp = os.path.join(args.run, "pool_days.pkl")
        rep["h8_counts"] = {"solusd_sha256": px_sha,
                            "per_day": h8_counts(df, pd.read_pickle(pdp) if os.path.exists(pdp) else None)}
    p = os.path.join(args.run, "outcomes.pkl")
    if os.path.exists(p):
        o = pd.read_pickle(p)
        rep["outcomes"] = {"rows": len(o), "entry_ok": int(o.entry_ok.sum()) if len(o) else 0,
                           **{f"filled_{h // 60}": int(o[f"net_ret_{h // 60}"].notna().sum()) for h in C.HOLDS_S}}
    print(json.dumps(rep, indent=1))


def _manifests(run):
    out = {}
    for st in ("stage1", "stage2"):
        p = os.path.join(run, f"manifest_{st}.json")
        if not os.path.exists(p):
            sys.exit(f"refusing: {st} manifest missing")
        with open(p) as fh:
            out[st] = json.load(fh)
    return out


def _common_guard(ms, plan_path):
    from d1.stepa import plan_sha_ok
    missing = [r for r in REQUIRED_RULINGS if r not in FROZEN_AMENDMENTS]
    if missing:
        sys.exit(f"refusing: frozen rulings not implemented in this code: {missing} (red team R2-9)")
    ok, sha = plan_sha_ok(plan_path)
    if not ok:
        sys.exit(f"refusing: Step A plan sha256 {sha} != {C.STEPA_PLAN_SHA256}")
    for st, m in ms.items():
        if m.get("dev"):
            sys.exit("refusing: a dev run (pseudo migrations) can never be searched or validated")
        if m.get("input_sha256") in (None, "skipped"):
            sys.exit(f"refusing: {st} has no input hashes")
        if m.get("code_sha256") != code_hash():
            sys.exit(f"refusing: {st} ran on different code")
    if ms["stage1"]["input_sha256"] != ms["stage2"]["input_sha256"] or \
            ms["stage1"].get("unit_dirs") != ms["stage2"].get("unit_dirs"):
        sys.exit("refusing: stage 2 read different units or files than stage 1")
    if not ms["stage1"].get("stepa_plan", {}).get("plan_sha_ok"):
        sys.exit("refusing: stage 1 ran against a different Step A plan")


def search_guard(run, plan_path=None):
    from d1.stepa import PLAN_DEFAULT
    ms = _manifests(run)
    _common_guard(ms, plan_path or PLAN_DEFAULT)
    m = ms["stage1"]
    if sorted(m["days"]) != sorted(C.DISCOVERY_DAYS):
        sys.exit(f"refusing: run days {m['days']} are not the discovery days {C.DISCOVERY_DAYS}")
    if not m["stepa_plan"].get("complete"):
        sys.exit("refusing: Step A is not complete (units differ from the plan, or a gap)")
    return ms


def validate_guard(run, frozen, confirm, plan_path=None, solusd=None):
    from d1.h8 import SOLUSD_DIR_DEFAULT, sums_sha
    from d1.stepa import PLAN_DEFAULT
    if not confirm:
        sys.exit("refusing: validation is scored only after Step A, a frozen-rules commit and a reviewer pass "
                 "(--confirm-validation-read)")
    ms = _manifests(run)
    _common_guard(ms, plan_path or PLAN_DEFAULT)
    if frozen.get("code_sha256") != code_hash():
        sys.exit("refusing: the frozen rules came from different code")
    if "H8_AMENDMENT" not in frozen.get("amendments", []):
        sys.exit("refusing: the frozen rules predate the H8 amendment")
    if [r for r in REQUIRED_RULINGS if r not in frozen.get("amendments", [])]:
        sys.exit("refusing: the frozen rules predate a frozen ruling (R2-9)")
    px_dir = solusd or SOLUSD_DIR_DEFAULT
    px_sha = sums_sha(px_dir) if os.path.isdir(px_dir) else "missing"
    if px_sha != frozen.get("solusd_sha256") or px_sha != C.SOLUSD_SUMS_SHA256:
        sys.exit("refusing: the SOL/USD input differs from the one the frozen rules were made with")
    days = ms["stage1"]["days"]
    if set(days) & set(frozen["discovery_days"]) or set(days) & set(C.DISCOVERY_DAYS):
        sys.exit("refusing: validation days overlap the discovery days")
    # R2-1: PREREG §6 judges the rules on Step B as a whole. A subset of its days or units (chosen after a look) is
    # refused: the run must read every unit of the registered Step B plan for each of 09-07, 09-08 and 09-09, no gap.
    if sorted(days) != sorted(C.VALIDATION_DAYS_STEP_B):
        sys.exit(f"refusing: validation reads exactly the Step B days {C.VALIDATION_DAYS_STEP_B}, got {days}")
    from d1.load import parse_unit
    from d1.stepa import STEPB_PLAN_DEFAULT, plan_check
    try:
        units = [parse_unit(u) for u in ms["stage1"].get("unit_dirs", [])]
    except ValueError as e:
        sys.exit(f"refusing: {e}")
    chk = plan_check(units, days, STEPB_PLAN_DEFAULT, C.STEPB_PLAN_SHA256)
    if not chk["complete"]:
        sys.exit("refusing: the validation run is not the whole Step B plan (sha "
                 f"{chk['plan_sha256']}, ok {chk['plan_sha_ok']}, per day {chk['per_day']})")
    return ms


def search(args):
    from d1.search import run_search
    search_guard(args.run, args.plan)
    df, px_sha = with_h8(joined(args.run), args.solusd)
    res = run_search(df)
    res["table"].to_csv(os.path.join(args.run, "search_table.csv"), index=False)
    m1 = json.load(open(os.path.join(args.run, "manifest_stage1.json")))
    frozen = {"design": "D1", "amendments": list(FROZEN_AMENDMENTS), "solusd_sha256": px_sha, "median_rt_cost": res["median_rt_cost"],
              "outcome": res["outcome"], "advanced": res["advanced"], "h8_basis": res["h8_basis"], "discovery_days": list(C.DISCOVERY_DAYS),
              "code_sha256": code_hash(), "input_sha256": m1["input_sha256"], "bootstrap_seed": C.BOOT_SEED}
    with open(args.out, "w") as fh:
        json.dump(frozen, fh, indent=1)
    print(json.dumps({"outcome": res["outcome"], "qualifying": int(res["table"].qualifies.sum()),
                      "advanced": [a["rule"] + f" / {a['hold_min']} min" for a in res["advanced"]]}, indent=1))


def validate(args):
    from d1.validate import judge
    with open(args.frozen) as fh:
        frozen = json.load(fh)
    ms = validate_guard(args.run, frozen, args.confirm_validation_read, args.plan, args.solusd)
    df, px_sha = with_h8(joined(args.run), args.solusd)
    res = [dict(judge(df, r, ms["stage1"]["days"]), solusd_sha256=px_sha) for r in frozen["advanced"]]
    with open(os.path.join(args.run, "validation_result.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("stage1")
    p.add_argument("--units", nargs="*", help="unit directories <cache>/<day>/<from>-<to>")
    p.add_argument("--units-file", help="file with one unit directory per line")
    p.add_argument("--days", nargs="+", required=True)
    p.add_argument("--out", required=True, help="run directory")
    p.add_argument("--plan", default=None, help="Step A plan (default research/shared-tape/stepa-plan.txt)")
    p.add_argument("--dev-unknown-migration", action="store_true",
                   help="DEV ONLY: pseudo migrations for pools migrated before the tape (shape checks)")
    p.add_argument("--no-hash", action="store_true", help="skip input sha256 (dev runs only)")
    p = sub.add_parser("stage2", help="reads the units and days from the stage 1 manifest")
    p.add_argument("--out", required=True, help="run directory of stage 1")
    p = sub.add_parser("summary")
    p.add_argument("--run", required=True)
    p.add_argument("--solusd", help="pinned SOL/USD directory for the H8 count row (default research/brainstorm-loop/sol-usd)")
    p = sub.add_parser("search")
    p.add_argument("--run", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--plan", default=None)
    p.add_argument("--solusd", help="pinned SOL/USD directory (default research/brainstorm-loop/sol-usd, checked against SHA256SUMS)")
    p = sub.add_parser("validate")
    p.add_argument("--run", required=True)
    p.add_argument("--plan", default=None)
    p.add_argument("--solusd", help="pinned SOL/USD directory (default research/brainstorm-loop/sol-usd, checked against SHA256SUMS)")
    p.add_argument("--frozen", required=True)
    p.add_argument("--confirm-validation-read", action="store_true")
    a = ap.parse_args(argv)
    {"stage1": stage1, "stage2": stage2, "summary": summary, "search": search, "validate": validate}[a.cmd](a)


if __name__ == "__main__":
    main()
