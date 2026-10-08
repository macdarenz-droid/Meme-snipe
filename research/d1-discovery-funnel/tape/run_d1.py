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
    from d1.universe import Clock, decision_points, migrations
    os.makedirs(args.out, exist_ok=True)
    tape = load(_units(args), args.days, all_pools=args.dev_unknown_migration)
    book = PoolBook(tape.amm)
    tape.amm = tape.amm.iloc[:0]   # the pool book holds the rows from here on
    clock = Clock(tape)
    migs = migrations(tape, book, dev_unknown_migration=args.dev_unknown_migration)
    pts = decision_points(tape, book, migs, clock)
    feats = compute_features(tape, book, pts, clock) if len(pts) else pd.DataFrame()
    pts.to_pickle(os.path.join(args.out, "points.pkl"))
    feats.to_pickle(os.path.join(args.out, "features.pkl"))
    migs.to_pickle(os.path.join(args.out, "migrations.pkl"))
    m = manifest(tape)
    m.update({"stage": "stage1", "dev": bool(args.dev_unknown_migration), "code_sha256": code_hash(),
              "clock_nonmonotone_blocks": clock.nonmonotone,
              "input_sha256": file_hashes(tape.units) if not args.no_hash else "skipped"})
    dump_json(m, os.path.join(args.out, "manifest_stage1.json"))
    print(json.dumps({"migrations": len(migs), "excluded": migs.excluded.value_counts().to_dict() if len(migs) else {},
                      "decision_points": len(pts), "eligible": int(pts.eligible.sum()) if len(pts) else 0,
                      "features_rows": len(feats)}, indent=1))


def stage2(args):
    from d1.load import dump_json, load, manifest
    from d1.outcomes import compute_outcomes
    from d1.pool_state import PoolBook
    m1 = json.load(open(os.path.join(args.out, "manifest_stage1.json")))
    tape = load(_units(args), args.days, all_pools=bool(m1.get("dev")))
    book = PoolBook(tape.amm)
    pts = pd.read_pickle(os.path.join(args.out, "points.pkl"))
    out = compute_outcomes(book, pts) if len(pts) else pd.DataFrame()
    out.to_pickle(os.path.join(args.out, "outcomes.pkl"))
    m = manifest(tape)
    m.update({"stage": "stage2", "code_sha256": code_hash()})
    dump_json(m, os.path.join(args.out, "manifest_stage2.json"))
    print(json.dumps({"outcome_rows": len(out), "entry_ok": int(out.entry_ok.sum()) if len(out) else 0}, indent=1))


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
    p = os.path.join(args.run, "outcomes.pkl")
    if os.path.exists(p):
        o = pd.read_pickle(p)
        rep["outcomes"] = {"rows": len(o), "entry_ok": int(o.entry_ok.sum()) if len(o) else 0,
                           **{f"filled_{h // 60}": int(o[f"net_ret_{h // 60}"].notna().sum()) for h in C.HOLDS_S}}
    print(json.dumps(rep, indent=1))


def search(args):
    from d1.search import run_search
    for st in ("stage1", "stage2"):
        m = json.load(open(os.path.join(args.run, f"manifest_{st}.json")))
        if m.get("dev"):
            sys.exit("refusing: a dev run (pseudo migrations) can never be searched")
        if sorted(m["days"]) != sorted(C.DISCOVERY_DAYS) and not args.allow_partial_discovery:
            sys.exit(f"refusing: run days {m['days']} are not the discovery days {C.DISCOVERY_DAYS}")
        if any(dy not in C.DISCOVERY_DAYS for dy in m["days"]):
            sys.exit("refusing: a non-discovery day in the run")
    res = run_search(joined(args.run))
    res["table"].to_csv(os.path.join(args.run, "search_table.csv"), index=False)
    frozen = {"design": "D1", "median_rt_cost": res["median_rt_cost"], "outcome": res["outcome"],
              "advanced": res["advanced"], "discovery_days": list(C.DISCOVERY_DAYS), "code_sha256": code_hash(),
              "stage1_manifest": os.path.join(args.run, "manifest_stage1.json"), "bootstrap_seed": C.BOOT_SEED}
    with open(args.out, "w") as fh:
        json.dump(frozen, fh, indent=1)
    print(json.dumps({"outcome": res["outcome"], "qualifying": int(res["table"].qualifies.sum()),
                      "advanced": [a["rule"] + f" / {a['hold_min']} min" for a in res["advanced"]]}, indent=1))


def validate(args):
    from d1.validate import judge
    if not args.confirm_validation_read:
        sys.exit("refusing: validation is scored only after Step A, a frozen-rules commit and a reviewer pass "
                 "(--confirm-validation-read)")
    frozen = json.load(open(args.frozen))
    m = json.load(open(os.path.join(args.run, "manifest_stage1.json")))
    if m.get("dev"):
        sys.exit("refusing: dev run")
    if set(m["days"]) & set(frozen["discovery_days"]):
        sys.exit("refusing: validation days overlap the discovery days")
    df = joined(args.run)
    res = [judge(df, r, m["days"]) for r in frozen["advanced"]]
    with open(os.path.join(args.run, "validation_result.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("stage1", "stage2"):
        p = sub.add_parser(name)
        p.add_argument("--units", nargs="*", help="unit directories <cache>/<day>/<from>-<to>")
        p.add_argument("--units-file", help="file with one unit directory per line")
        p.add_argument("--days", nargs="+", required=True)
        p.add_argument("--out", required=True, help="run directory")
        if name == "stage1":
            p.add_argument("--dev-unknown-migration", action="store_true",
                           help="DEV ONLY: pseudo migrations for pools migrated before the tape (shape checks)")
            p.add_argument("--no-hash", action="store_true", help="skip input sha256 (dev only)")
    p = sub.add_parser("summary")
    p.add_argument("--run", required=True)
    p = sub.add_parser("search")
    p.add_argument("--run", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--allow-partial-discovery", action="store_true")
    p = sub.add_parser("validate")
    p.add_argument("--run", required=True)
    p.add_argument("--frozen", required=True)
    p.add_argument("--confirm-validation-read", action="store_true")
    a = ap.parse_args(argv)
    {"stage1": stage1, "stage2": stage2, "summary": summary, "search": search, "validate": validate}[a.cmd](a)


if __name__ == "__main__":
    main()
