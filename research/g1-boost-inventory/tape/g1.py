#!/usr/bin/env python3
"""G1 scoring entry point. See README.md for the order of work. Run every data command with `nice -n 19`.

  g1.py decide   --units U... --out DIR [--no-links]    stage 1: universe, triggers, timing, as-of features
  g1.py gate     --units U... --out DIR --days D...     G1-0 and the amendment gates (timing, no returns)
  g1.py checks   --units U... --out DIR                 PREREG §7 checks 2–5 on the tape
  g1.py freeze   --out DIR                              discovery medians of R and Z -> DIR/frozen.json
  g1.py outcome  --units U... --out DIR --allow-returns [--counts-only]   stage 2: fills and returns
  g1.py score    --out DIR --role discovery|validation --frozen FILE --allow-scoring

U is a unit directory (CACHE/<day>/<from>-<to>[/research]) or a cache root; --days limits the units to those days.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from g1lib import guard  # noqa: E402
from g1lib import params as P  # noqa: E402
from g1lib.load import find_units, load  # noqa: E402


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def _json(path, obj):
    def conv(o):
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return None if np.isnan(o) else float(o)
        if isinstance(o, (np.bool_,)):
            return bool(o)
        if isinstance(o, set):
            return sorted(o)
        return str(o)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, default=conv, allow_nan=True)


def _tape(a, links=True, pool=True):
    units = find_units(a.units, a.days, allow_subset=getattr(a, "dev_subset", False))
    if not units:
        sys.exit("no units found")
    log(f"{len(units)} units, days {sorted(set(u.day for u in units))}")
    reader = "reference" if getattr(a, "reference_reader", False) else "compact"
    tape = load(units, links=links, log=log, reader=reader, pool=pool or reader == "reference")
    log("rows: " + ", ".join(f"{k} {len(getattr(tape, k)):,}" for k in ("blocks", "curve", "pool_rows", "buys", "T", "W", "F_boost"))
        + ", " + ", ".join(f"{k} {len(v):,}" for k, v in tape.events.items()) + f", names {len(tape.names.names):,}")
    return units, tape


def cmd_decide(a):
    from g1lib.decide import decisions, timing
    from g1lib.features import FeatureContext, compute_features
    units, tape = _tape(a, links=not a.no_links, pool=False)   # decide reads no PumpSwap pool row
    d = timing(tape, decisions(tape, log=log))
    ctx = FeatureContext(tape, with_links=not a.no_links)
    d = compute_features(tape, d, ctx, log=log)
    os.makedirs(a.out, exist_ok=True)
    d.to_csv(os.path.join(a.out, "decisions.csv"), index=False)
    man = guard.make_manifest(units, guard.PLAN_SHA, dev=bool(a.dev_subset))
    man["decisions_sha"] = guard.sha_file(os.path.join(a.out, "decisions.csv"))
    guard.write_manifest(a.out, man)
    _json(os.path.join(a.out, "decisions_summary.json"), summarize_decisions(d, units))
    log(f"wrote {a.out}/decisions.csv")


def summarize_decisions(d, units):
    out = {"units": [f"{u.day} {u.from_slot}-{u.to_slot} {u.schema}" for u in units]}
    if not len(d):
        return out
    for k, g in d.groupby("kind"):
        out[k] = {"rows": int(len(g)), "in_universe": int(((g["reason"] == "") & ~g["censored"]).sum()),
                  "censored": int(g["censored"].sum()), "dropped_by_time": int(g["dropped_by_time"].sum()),
                  "by_reason": {str(r): int(n) for r, n in g.groupby("reason").size().items()},
                  "by_stratum": {str(r): int(n) for r, n in g.groupby("stratum").size().items()}}
    g = d[(d["kind"] == "G1") & (d["reason"] == "") & ~d["censored"]]
    for c in ("R", "hc_coverage", "Z", "N", "lam"):
        if c in g:
            v = g[c].dropna()
            out[f"G1_{c}"] = {"n": int(len(v)), "quantiles": [float(x) for x in v.quantile([0, .25, .5, .75, 1])] if len(v) else []}
    for c in ("hc_reason", "cap_reason"):
        if c in g:
            out[f"G1_{c}"] = {str(r): int(n) for r, n in g[c].fillna("").value_counts().items()}
    return out


def _decisions(a):
    d = pd.read_csv(os.path.join(a.out, "decisions.csv"), keep_default_na=True)
    for c in ("reason", "hc_reason", "cap_reason", "token_program", "creator", "create_user", "name", "symbol", "bonding_curve"):
        if c in d:
            d[c] = d[c].fillna("")
    return d


def _remap(d, tape):
    d = d.copy()
    d["mint_c"] = [tape.names.get(m) for m in d["mint"]]
    return d


def strip_verdict(res: dict) -> dict:
    """A gate run on partial days gives no verdict: every pass field becomes None."""
    def strip(x):
        if not isinstance(x, dict):
            return x
        return {k: (None if (k == "passes" or k.endswith("_pass") or k.endswith("_passes") or k in ("kills", "days_ok", "kills_by_day"))
                    else strip(v)) for k, v in x.items()}
    out = strip(res)
    out["verdict"] = "none: partial days (dev subset)"
    return out


def cmd_gate(a):
    from g1lib import gate
    from g1lib.features import FeatureContext
    from g1lib.market import Market
    units, tape = _tape(a)
    man = guard.read_manifest(a.out)
    guard.verify(man, units, allow_dev=True, files={"decisions_sha": os.path.join(a.out, "decisions.csv")})
    d = _remap(_decisions(a), tape)
    ctx = FeatureContext(tape)
    mkt = Market(tape)
    days = a.days or sorted(set(u.day for u in units))
    res, grads, trig, flows = gate.run(tape, d, ctx, mkt, days, log=log)
    grads.to_csv(os.path.join(a.out, "graduates.csv"), index=False)
    trig.to_csv(os.path.join(a.out, "triggers.csv"), index=False)
    pd.DataFrame([{"mint": tape.names.name(k), **v} for k, v in flows.items()]).to_csv(os.path.join(a.out, "flows.csv"), index=False)
    res.pop("boost_slices").to_csv(os.path.join(a.out, "boost_slices.csv"), index=False)
    res["dev_subset"] = man["dev_subset"]
    res["complete_days"] = not man["dev_subset"]
    if man["dev_subset"]:
        res = strip_verdict(res)  # G1-0 is judged on complete days only (AMENDMENT_3, OQ-22)
    _json(os.path.join(a.out, "gate.json"), res)
    man["gate_sha"] = guard.sha_file(os.path.join(a.out, "gate.json"))   # R2-6: freeze reads this exact gate
    guard.write_manifest(a.out, man)
    log(f"wrote {a.out}/gate.json")


def cmd_checks(a):
    from g1lib import checks
    from g1lib.market import Market
    units, tape = _tape(a, links=False)
    mkt = Market(tape)
    res = {"check2_reserves": checks.check2_reserves(tape), "check3_tier": checks.check3_tier(tape, mkt),
           "check4_target": checks.check4_target(tape, mkt), "token_programs": checks.token_programs(tape),
           "check5_inputs": guard.input_hashes(units), "check5_code_hash": guard.code_hash(),
           "check5_plan_sha": guard.PLAN_SHA,
           "seeds": {"S0": P.S0_SEED, "bootstrap": P.BOOTSTRAP_SEED}}
    os.makedirs(a.out, exist_ok=True)
    _json(os.path.join(a.out, "checks.json"), res)
    log(f"wrote {a.out}/checks.json")


def cmd_freeze(a):
    from g1lib.score import freeze
    man = guard.read_manifest(a.out)
    guard.verify(man, files={"decisions_sha": os.path.join(a.out, "decisions.csv")})
    if tuple(man["days"]) != guard.DISCOVERY_DAYS:
        raise guard.GuardError(f"freeze needs exactly the discovery days {guard.DISCOVERY_DAYS}, got {man['days']}")
    fr = freeze(_decisions(a))
    fr.update({k: man[k] for k in ("plan_sha", "inputs_digest", "code_hash", "decisions_sha", "units")})
    # R2-6: the gate verdicts travel with the freeze, from the gate.json `gate` wrote on these whole days
    gp = os.path.join(a.out, "gate.json")
    if not os.path.exists(gp) or guard.sha_file(gp) != man.get("gate_sha"):
        raise guard.GuardError("freeze needs the gate.json that `gate` recorded for these decisions")
    with open(gp) as f:
        g = json.load(f)
    if g.get("dev_subset") or not g.get("complete_days"):
        raise guard.GuardError("freeze needs a gate run on whole days")
    fr["gate_passes"] = {k: (g.get(k) or {}).get("passes") is True for k in ("G1_0", "G1_HC", "G1_CAP")}
    fr["gate_sha"] = man["gate_sha"]
    _json(os.path.join(a.out, "frozen.json"), fr)
    log(f"wrote {a.out}/frozen.json: {fr}")


def cmd_outcome(a):
    if not a.allow_returns:
        sys.exit("outcome computes strategy returns; pass --allow-returns only when the order of work allows it")
    from g1lib import outcome
    from g1lib.market import Market
    units, tape = _tape(a, links=False)
    man = guard.read_manifest(a.out)
    guard.verify(man, units, allow_dev=a.counts_only, files={"decisions_sha": os.path.join(a.out, "decisions.csv")})
    d = _remap(_decisions(a), tape)
    t = outcome.run(Market(tape), d, with_secondary=not a.counts_only, log=log)
    if a.counts_only:
        keep = ["kind", "mint", "day", "t0", "variant", "filled", "miss", "exit", "exit_ok", "exit_fail_reason",
                "pool_fee_source", "rent_lamports", "rent_mismatch_vs_repo"]
        t = t[[c for c in keep if c in t.columns]]
        summ = {"by_kind": {}}
        for k, g in t.groupby("kind"):
            summ["by_kind"][k] = {"rows": int(len(g)), "filled": int(g["filled"].sum()),
                                  "miss": {str(r): int(n) for r, n in g.loc[~g["filled"], "miss"].value_counts().items()},
                                  "exit": {str(r): int(n) for r, n in g.loc[g["filled"], "exit"].value_counts().items()},
                                  "exit_failed": int((g["filled"] & (g.get("exit_ok") == False)).sum()),
                                  "pool_fee_source": {str(r): int(n) for r, n in g["pool_fee_source"].fillna("").value_counts().items()} if "pool_fee_source" in g else {},
                                  "rent_lamports": {str(r): int(n) for r, n in g["rent_lamports"].dropna().value_counts().items()} if "rent_lamports" in g else {}}
        _json(os.path.join(a.out, "outcome_counts.json"), summ)
        t.to_csv(os.path.join(a.out, "trades_counts.csv"), index=False)
        log(f"wrote {a.out}/outcome_counts.json (no return columns)")
        return
    t.to_csv(os.path.join(a.out, "trades.csv"), index=False)
    man["trades_sha"] = guard.sha_file(os.path.join(a.out, "trades.csv"))
    guard.write_manifest(a.out, man)
    log(f"wrote {a.out}/trades.csv")


def cmd_score(a):
    if not a.allow_scoring:
        sys.exit("score computes the registered statistics; pass --allow-scoring only when the order of work allows it")
    from g1lib.score import judge
    man = guard.read_manifest(a.out)
    guard.verify(man, files={"decisions_sha": os.path.join(a.out, "decisions.csv"),
                             "trades_sha": os.path.join(a.out, "trades.csv")})
    t = pd.read_csv(os.path.join(a.out, "trades.csv"))
    d = _decisions(a)
    with open(a.frozen) as f:
        fr = json.load(f)
    guard.check_score(man, fr, a.role, t["day"].dropna().unique())
    # R2-6: no return is read unless G1-0 passed; validation follows the discovery score made from the same freeze
    if not isinstance(fr.get("gate_passes"), dict) or fr["gate_passes"].get("G1_0") is not True:
        raise guard.GuardError("G1-0 did not pass (or frozen.json has no gate record): G1 closes with no return read")
    closed = None
    if a.role == "validation":
        disc = os.path.dirname(os.path.abspath(a.frozen))
        dm = guard.read_manifest(disc)
        sp = os.path.join(disc, "score_discovery.json")
        if not os.path.exists(sp) or guard.sha_file(sp) != dm.get("score_discovery_sha"):
            raise guard.GuardError("validation needs score_discovery.json recorded beside the freeze (futility)")
        with open(sp) as f:
            from g1lib.score import closures
            closed = closures(fr, json.load(f))
    res = judge(t, d, fr, a.role, closed=closed)
    out = os.path.join(a.out, f"score_{a.role}.json")
    _json(out, res)
    if a.role == "discovery":
        man["score_discovery_sha"] = guard.sha_file(out)
        guard.write_manifest(a.out, man)
    log(f"wrote {out}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, units=True):
        p.add_argument("--out", required=True)
        if units:
            p.add_argument("--units", nargs="+", required=True)
            p.add_argument("--days", nargs="*")
            p.add_argument("--dev-subset", action="store_true",
                           help="development only: accept part of a day; freeze, score and outcome with returns refuse it")
            p.add_argument("--reference-reader", action="store_true",
                           help="the original, memory-heavy reader (equality tests); outputs are identical")

    p = sub.add_parser("decide"); common(p); p.add_argument("--no-links", action="store_true"); p.set_defaults(f=cmd_decide)
    p = sub.add_parser("gate"); common(p); p.set_defaults(f=cmd_gate)
    p = sub.add_parser("checks"); common(p); p.set_defaults(f=cmd_checks)
    p = sub.add_parser("freeze"); common(p, units=False); p.set_defaults(f=cmd_freeze)
    p = sub.add_parser("outcome"); common(p); p.add_argument("--allow-returns", action="store_true")
    p.add_argument("--counts-only", action="store_true"); p.set_defaults(f=cmd_outcome)
    p = sub.add_parser("score"); common(p, units=False); p.add_argument("--role", choices=["discovery", "validation"], required=True)
    p.add_argument("--frozen", required=True); p.add_argument("--allow-scoring", action="store_true"); p.set_defaults(f=cmd_score)
    a = ap.parse_args(argv)
    if not hasattr(a, "days"):
        a.days = None
    a.f(a)


if __name__ == "__main__":
    main()
