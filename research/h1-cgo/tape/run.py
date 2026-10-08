#!/usr/bin/env python3
"""H1-CGO scoring on the shared tape. Stages (each reads the previous stage's files in --out):

  features  --units U... --decision-days D... [--creation-days D...] --out DIR   features.csv, universe.csv, features_meta.json
  gate0     --out DIR                                                            gate0.json      (discovery; no forward return)
  outcomes  --units U... --out DIR [--counts-only]                               outcomes.csv    (prices; separate stage)
  freeze    --out DIR                                                            frozen.json     (discovery: breakpoints, sign, futility)
  score     --out DIR --frozen FROZEN                                            primary.json, secondary.json (validation only)

Run every data command with `nice -n 19`. Unit directories are <cache>/<day>/<from>-<to>[/research].
"""
import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from h1cgo import features, outcomes, stats, tapeio  # noqa: E402
from h1cgo import h8 as H8  # noqa: E402
from h1cgo.constants import DISCOVERY_DAYS, VALIDATION_DAYS  # noqa: E402


def _load_json(path):
    with open(path) as f:
        return json.load(f)


def _units(paths):
    us = [tapeio.parse_unit(p) for p in paths]
    if len({(u.from_slot, u.to_slot) for u in us}) != len(us):
        sys.exit("a unit is listed twice")
    return us


def _dump(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, default=str, sort_keys=True)
        f.write("\n")


def _read_feats(out):
    try:
        f = pd.read_csv(os.path.join(out, "features.csv"), dtype={"decision_day": str})
    except pd.errors.EmptyDataError:
        return pd.DataFrame()
    for c in [c for c in f.columns if c.startswith("in_time_")] + ["eligible", "unresolved", "has_state", "bad_pool"]:
        f[c] = f[c].astype(bool)
    return f


def _verify_meta(out):
    """Re-checks, from features_meta.json, that the features read every planned unit of every day they used."""
    meta = _load_json(os.path.join(out, "features_meta.json"))
    for k in ("plan", "plan_sha256", "unit_records", "days_used", "inputs"):
        if meta.get(k) is None:
            sys.exit(f"features_meta.json lacks {k}: rerun the features stage")
    if tapeio.sha256_file(meta["plan"]) != meta["plan_sha256"]:
        sys.exit("the unit plan changed since the features stage")
    us = [tapeio.Unit(r["day"], r["from_slot"], r["to_slot"], r["dir"]) for r in meta["unit_records"]]
    try:
        tapeio.check_complete(us, meta["days_used"], tapeio.load_plan(meta["plan"]))
    except ValueError as e:
        sys.exit(f"incomplete input: {e}")
    return meta


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("stage", choices=["features", "gate0", "outcomes", "freeze", "score"])
    a.add_argument("--units", nargs="*", default=[])
    a.add_argument("--decision-days", nargs="*", default=[])
    a.add_argument("--creation-days", nargs="*", default=None)
    a.add_argument("--out", required=True)
    a.add_argument("--frozen")
    a.add_argument("--counts-only", action="store_true", help="outcomes: print status counts, write no returns")
    a.add_argument("--sol-usd", default=H8.SOL_USD_DIR, help="committed SOL/USD folder with SHA256SUMS (AMENDMENT_4)")
    a.add_argument("--plan", default=tapeio.PLAN_PATH, help="committed unit plan (DAY EPOCH FROM TO per unit)")
    o = a.parse_args(argv)
    os.makedirs(o.out, exist_ok=True)

    if o.stage == "features":
        us = _units(o.units)
        for d in o.decision_days:
            if d not in DISCOVERY_DAYS + VALIDATION_DAYS:
                sys.exit(f"{d} is neither a discovery nor a validation day")
        kinds = {d in DISCOVERY_DAYS for d in o.decision_days + (o.creation_days or [])}
        if len(kinds) != 1:
            sys.exit("decision and creation days must be all discovery or all validation days")
        days = sorted(set(o.decision_days) | set(o.creation_days or []))
        try:
            tapeio.check_complete(us, days, tapeio.load_plan(o.plan))
        except ValueError as e:
            sys.exit(f"features: {e}")
        feats, uni, diag = features.run(us, o.decision_days, o.creation_days, log=lambda m: print(m, file=sys.stderr))
        feats.to_csv(os.path.join(o.out, "features.csv"), index=False)
        uni.to_csv(os.path.join(o.out, "universe.csv"), index=False)
        diag.update(decision_days=o.decision_days, creation_days=o.creation_days or o.decision_days, days_used=days,
                    plan=o.plan, plan_sha256=tapeio.sha256_file(o.plan),
                    unit_records=[tapeio.unit_record(u) for u in sorted(us, key=lambda x: x.from_slot)],
                    code=tapeio.code_hash(), inputs=tapeio.input_hashes(us))
        _dump(os.path.join(o.out, "features_meta.json"), diag)
        n_el = int(feats.eligible.sum()) if len(feats) else 0
        print(json.dumps(dict(universe=diag["universe"], decision_points=len(feats), eligible=n_el, rows=diag["rows"])))

    elif o.stage == "gate0":
        meta = _verify_meta(o.out)
        f = _read_feats(o.out)
        if f.empty:
            sys.exit("gate0: features.csv holds no decision points; nothing to judge")
        g = stats.gate0(f, meta["decision_days"])
        # H8_AMENDMENT item 4: count row (reads no forward return)
        try:
            g["h8_count_rows"] = H8.count_rows(f, H8.load_committed(meta["decision_days"], o.sol_usd))
        except (ValueError, OSError) as e:
            sys.exit(f"gate0: SOL/USD input refused: {e}")
        _dump(os.path.join(o.out, "gate0.json"), g)
        print("gate H1-CGO-0:", "pass" if g["passed"] else "closed", f"(a {g['a_pass']}, b {g['b_pass']}, c {g['c_pass']})")

    elif o.stage == "outcomes":
        meta = _verify_meta(o.out)
        f = _read_feats(o.out)
        us = _units(o.units)
        recs = [tapeio.unit_record(u) for u in sorted(us, key=lambda x: x.from_slot)]
        if recs != meta["unit_records"]:
            sys.exit("outcomes: --units differ from the units the features read")
        if tapeio.input_hashes(us) != meta["inputs"]:
            sys.exit("outcomes: an input file changed since the features stage (sha256)")
        if f.empty:
            sys.exit("outcomes: no decision points")
        books = outcomes.load_books(us, set(f[f.eligible].pool))
        out = outcomes.run(f, books)
        if o.counts_only:
            print(json.dumps(dict(priced=len(out), status=out.status.value_counts().to_dict() if len(out) else {})))
        else:
            out.to_csv(os.path.join(o.out, "outcomes.csv"), index=False)
            fl = outcomes.load_flows(us, f)  # AMENDMENT_3 gate flows
            fl.to_csv(os.path.join(o.out, "flows.csv"), index=False)
            print(f"outcomes: {len(out)} rows; flows: {len(fl)} rows")

    elif o.stage == "freeze":
        gp = os.path.join(o.out, "gate0.json")
        if not os.path.exists(gp) or not _load_json(gp)["passed"]:
            sys.exit("freeze runs only after gate H1-CGO-0 passed (run gate0 first)")
        meta = _verify_meta(o.out)
        f = _read_feats(o.out)
        out = pd.read_csv(os.path.join(o.out, "outcomes.csv"), dtype={"decision_day": str})
        res = stats.sign_and_futility(f, out)
        fl = pd.read_csv(os.path.join(o.out, "flows.csv"), dtype={"decision_day": str})
        res["d60"] = stats.d60_gate(f, fl)  # AMENDMENT_3 gate rows; freezes D60's P20
        res.update(code=tapeio.code_hash(), feature_inputs=meta.get("inputs"), discovery_days=meta["decision_days"])
        _dump(os.path.join(o.out, "frozen.json"), res)
        print("frozen:", res["verdict"], "sign", res["sign"])

    elif o.stage == "score":
        if not o.frozen:
            sys.exit("score needs --frozen (the committed discovery freeze)")
        frozen = _load_json(o.frozen)
        if frozen.get("verdict") != "continue":
            sys.exit(f"discovery closed H1-CGO ({frozen.get('verdict')}); nothing to score")
        if frozen.get("code") != tapeio.code_hash():
            sys.exit("score: the code differs from the code that froze the discovery result")
        meta = _verify_meta(o.out)
        if list(meta["decision_days"]) != list(VALIDATION_DAYS):
            sys.exit(f"score needs decision days exactly {VALIDATION_DAYS}; got {meta['decision_days']}")
        f = _read_feats(o.out)
        out = pd.read_csv(os.path.join(o.out, "outcomes.csv"), dtype={"decision_day": str})
        try:
            sol = H8.load_committed(meta["decision_days"], o.sol_usd)
        except (ValueError, OSError) as e:
            sys.exit(f"score: SOL/USD input refused: {e}")
        p = stats.primary(f, out, frozen, meta["decision_days"])
        p["h8_stratum"] = stats.h8_stratum(f, out, frozen, meta["decision_days"], sol)
        p["d60_arm"] = stats.d60_arm(f, out, frozen, meta["decision_days"], p)
        s = stats.secondary(f, out, frozen)
        p.update(code=tapeio.code_hash())
        _dump(os.path.join(o.out, "primary.json"), p)
        _dump(os.path.join(o.out, "secondary.json"), s)
        print("H1-CGO:", p["verdict"])


if __name__ == "__main__":
    main()
