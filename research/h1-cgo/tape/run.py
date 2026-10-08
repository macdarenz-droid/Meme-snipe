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
    f = pd.read_csv(os.path.join(out, "features.csv"), dtype={"decision_day": str})
    for c in [c for c in f.columns if c.startswith("in_time_")] + ["eligible", "unresolved", "has_state", "bad_pool"]:
        f[c] = f[c].astype(bool)
    return f


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("stage", choices=["features", "gate0", "outcomes", "freeze", "score"])
    a.add_argument("--units", nargs="*", default=[])
    a.add_argument("--decision-days", nargs="*", default=[])
    a.add_argument("--creation-days", nargs="*", default=None)
    a.add_argument("--out", required=True)
    a.add_argument("--frozen")
    a.add_argument("--counts-only", action="store_true", help="outcomes: print status counts, write no returns")
    a.add_argument("--no-hash", action="store_true", help="skip input hashing (development only)")
    o = a.parse_args(argv)
    os.makedirs(o.out, exist_ok=True)

    if o.stage == "features":
        us = _units(o.units)
        for d in o.decision_days:
            if d not in DISCOVERY_DAYS + VALIDATION_DAYS:
                sys.exit(f"{d} is neither a discovery nor a validation day")
        kinds = {d in DISCOVERY_DAYS for d in o.decision_days}
        if len(kinds) != 1:
            sys.exit("decision days must be all discovery or all validation days")
        feats, uni, diag = features.run(us, o.decision_days, o.creation_days, log=lambda m: print(m, file=sys.stderr))
        feats.to_csv(os.path.join(o.out, "features.csv"), index=False)
        uni.to_csv(os.path.join(o.out, "universe.csv"), index=False)
        diag.update(decision_days=o.decision_days, creation_days=o.creation_days or o.decision_days,
                    code=tapeio.code_hash(), inputs=None if o.no_hash else tapeio.input_hashes(us))
        _dump(os.path.join(o.out, "features_meta.json"), diag)
        n_el = int(feats.eligible.sum()) if len(feats) else 0
        print(json.dumps(dict(universe=diag["universe"], decision_points=len(feats), eligible=n_el, rows=diag["rows"])))

    elif o.stage == "gate0":
        f = _read_feats(o.out)
        days = _load_json(os.path.join(o.out, "features_meta.json"))["decision_days"]
        g = stats.gate0(f, days)
        _dump(os.path.join(o.out, "gate0.json"), g)
        print("gate H1-CGO-0:", "pass" if g["passed"] else "closed", f"(a {g['a_pass']}, b {g['b_pass']}, c {g['c_pass']})")

    elif o.stage == "outcomes":
        f = _read_feats(o.out)
        us = _units(o.units)
        books = outcomes.load_books(us, set(f[f.eligible].pool))
        out = outcomes.run(f, books)
        if o.counts_only:
            print(json.dumps(dict(priced=len(out), status=out.status.value_counts().to_dict() if len(out) else {})))
        else:
            out.to_csv(os.path.join(o.out, "outcomes.csv"), index=False)
            print(f"outcomes: {len(out)} rows")

    elif o.stage == "freeze":
        gp = os.path.join(o.out, "gate0.json")
        if not os.path.exists(gp) or not _load_json(gp)["passed"]:
            sys.exit("freeze runs only after gate H1-CGO-0 passed (run gate0 first)")
        f = _read_feats(o.out)
        out = pd.read_csv(os.path.join(o.out, "outcomes.csv"), dtype={"decision_day": str})
        res = stats.sign_and_futility(f, out)
        meta = _load_json(os.path.join(o.out, "features_meta.json"))
        res.update(code=tapeio.code_hash(), feature_inputs=meta.get("inputs"), discovery_days=meta["decision_days"])
        _dump(os.path.join(o.out, "frozen.json"), res)
        print("frozen:", res["verdict"], "sign", res["sign"])

    elif o.stage == "score":
        if not o.frozen:
            sys.exit("score needs --frozen (the committed discovery freeze)")
        frozen = _load_json(o.frozen)
        if frozen.get("verdict") != "continue":
            sys.exit(f"discovery closed H1-CGO ({frozen.get('verdict')}); nothing to score")
        f = _read_feats(o.out)
        out = pd.read_csv(os.path.join(o.out, "outcomes.csv"), dtype={"decision_day": str})
        p = stats.primary(f, out, frozen)
        s = stats.secondary(f, out, frozen)
        p.update(code=tapeio.code_hash())
        _dump(os.path.join(o.out, "primary.json"), p)
        _dump(os.path.join(o.out, "secondary.json"), s)
        print("H1-CGO:", p["verdict"])


if __name__ == "__main__":
    main()
