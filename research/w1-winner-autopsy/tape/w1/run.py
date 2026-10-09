"""W1 entry point.

  python3 -m w1.run ledger  --work DIR (--units U [U ...] | --cache C --days D [D ...]) [--dev-allow-gaps]
  python3 -m w1.run counts  --work DIR [--days D ...]          development: counts and shapes only
  python3 -m w1.run gate       --work A_WORK --score            §6 gate W1-0 on 09-10 and 09-11
  python3 -m w1.run flippers   --work A_WORK --score            AMENDMENT_4 rows on 09-10 and 09-11
  python3 -m w1.run discovery  --work A_WORK --score            §7 rank 09-10, test 09-11
  python3 -m w1.run validation --work B_WORK --score            §7 rank 09-07, test 09-08 and 09-09
  python3 -m w1.run extract    --work AB_WORK --score           §8 (ledger 09-07..09-11, after validation passed there)
  python3 -m w1.run ruletest   --work C_WORK --rule-work AB_WORK --score   §8 rule test on Step C

Days and rank/test choices are registered in guard.ROLES; --rank/--test/--days may be omitted, never changed.
Every scored stage calls guard.verify first (plan, units, code and input hashes, every day present).

`ledger` reads the tape and writes one ledger file per day (WORK/ledger-DAY.pkl) plus WORK/manifest.json (input and
code sha256, seeds). Every stage that reads traders' P&L or a test statistic refuses to run without --score; the
primary is scored only after Step A is complete and a reviewer has passed this code. Summaries name no address."""
import argparse
import glob
import json
import os
import pickle
import sys

import numpy as np

from . import guard, load
from .ledger import Ledger

# The scoring modules are imported by the stages that use them, never by `ledger --prep-only` (the preparation run
# on real tape imports no outcome, scoring or statistics module; tests/test_scale.py checks it).
_SCORING = ("classes", "clusters", "flippers", "persist", "positions", "replay", "rules")


def _mods():
    import importlib
    return [importlib.import_module("." + m, __package__) for m in _SCORING]

HERE = os.path.dirname(os.path.abspath(__file__))


def code_hashes():
    return {os.path.basename(p): load.file_sha256(p) for p in sorted(glob.glob(os.path.join(HERE, "*.py")))}


def _save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        pickle.dump(obj, f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, path)


def _load_days(work, days=None):
    out = []
    for p in sorted(glob.glob(os.path.join(work, "ledger-*.pkl"))):
        with open(p, "rb") as f:
            d = pickle.load(f)
        if days is None or d["day"] in days:
            out.append(d)
    return out


def _vocab(work):
    with open(os.path.join(work, "vocab.pkl"), "rb") as f:
        return pickle.load(f)


def _manifest(work):
    p = os.path.join(work, "manifest.json")
    if not os.path.exists(p):
        guard.refuse(f"no manifest in {work}")
    with open(p) as f:
        return json.load(f)


def _write_manifest(work, m):
    with open(os.path.join(work, "manifest.json"), "w") as f:
        json.dump(m, f, indent=1, default=str)


def cmd_ledger(a):
    load.READER = "legacy" if a.legacy_reader else "chunked"
    units = load.parse_units(a.units) if a.units else load.find_units(a.cache, a.days)
    if not units:
        sys.exit("no units")
    if not a.dev_allow_gaps:
        # a day with a frozen plan must be read exactly as planned
        for day in sorted({u.day for u in units}):
            if day in guard.PLANS:
                want = guard.plan_units(day)
                got = [f"{u.day}/{u.lo}-{u.hi}" for u in units if u.day == day]
                if sorted(got) != sorted(want):
                    guard.refuse(f"{day}: units differ from the frozen plan ({len(got)} given, {len(want)} planned)")
    os.makedirs(a.work, exist_ok=True)
    vocab = load.Vocab()
    led = Ledger(vocab, prep_only=a.prep_only)
    led.allow_gaps = bool(a.dev_allow_gaps)
    manifest = {"units": [f"{u.day}/{u.lo}-{u.hi}" for u in units],
                "unit_paths": {f"{u.day}/{u.lo}-{u.hi}": os.path.abspath(u.path) for u in units},
                "input_paths": load.input_paths(units), "inputs": load.input_hashes(units),
                "code": code_hashes()}
    if a.prep_only:
        manifest["prep_only"] = True
    else:
        from . import persist
        manifest.update({"seed": persist.SEED, "bootstrap": persist.B})
    manifest.update({"days": {}, "ledger_sha": {}, "allow_gaps": bool(a.dev_allow_gaps)})
    excluded = {}

    def close_day():
        d = led.finish_day()
        f = os.path.join(a.work, f"ledger-{d['day']}.pkl")
        _save(f, d)
        manifest["ledger_sha"][d["day"]] = load.file_sha256(f)
        manifest["days"][d["day"]] = _day_counts(d)
        for k, v in d["excluded"].items():
            excluded.setdefault(k, set()).update(v.tolist())

    cur = None
    for u in units:
        if cur is not None and u.day != cur:
            close_day()
        cur = u.day
        led.process_unit(u)
        print(f"unit {u.day} {u.lo}-{u.hi} done", file=sys.stderr)
    close_day()
    manifest["stats"] = {k: (v if k != "gaps" else [list(g) for g in v]) for k, v in led.stats.items()}
    manifest["excluded_by_type"] = {k: len(v) for k, v in excluded.items()}   # over all days
    _save(os.path.join(a.work, "vocab.pkl"), vocab)
    _write_manifest(a.work, manifest)
    print(json.dumps(manifest["days"], indent=1, default=str))


def _day_counts(d):
    r = d["rows"]
    return {"lo": int(d["lo"]), "hi": int(d["hi"]), "gaps": int(d["gaps"]), "first_day": bool(d.get("first_day")),
            "owner_mint_rows": int(len(r)), "dirty_rows": int(r["dirty"].sum()),
            "dirty_start_only_rows": int(r["dirty_start_only"].sum()), "unresolved_rows": int(r["unresolved"].sum()),
            "partial_rows": int(r["partial"].sum()), "no_state_marks": int(r["no_state"].sum()),
            **({} if d.get("prep_only") else {"rows_with_signer_method": int((r["nsig"] > 0).sum())}),
            "owners": int(len(d["owners"])), "buys": int(len(d["buys"])), "big_buys": int(len(d["big"])),
            "transfers_between_tracked": int(len(d["xfers"])), "w_links": int(len(d["wedges"])),
            "t_links": int(len(d["tedges"])), "cg_events": int(len(d["cg"])),
            "excluded_by_type": {k: int(len(v)) for k, v in d["excluded"].items()}}


def cmd_counts(a):
    """Development check: shapes and counts per day. Reads no P&L value and no test statistic."""
    classes, clusters, _, persist, _, _, _ = _mods()
    if _manifest(a.work).get("prep_only"):
        guard.refuse("a prep-only ledger has no cash or marks; `counts` needs a full ledger")
    days = _load_days(a.work, a.days)
    out = []
    for d in days:
        trader, info = clusters.build(days, d["day"])
        g = persist.gate(d, trader, counts_only=True)
        cls = classes.classify(d, trader)
        out.append({"day": d["day"], "clusters": info, "gate_counts": g,
                    "fast_traders": int(cls["fast"].sum()) if len(cls) else 0,
                    "classified_traders": int(len(cls))})
    for d1, d2 in zip(days, days[1:]):
        t1, _ = clusters.build(days, d1["day"])
        out.append({"stability": f"{d1['day']}->{d2['day']}", **classes.stability(d1, d2, t1)})
    print(json.dumps(out, indent=1, default=str))


def _scored(a, role):
    """--score, registered choices, then guard.verify. Returns (manifest, role spec, ledger days of the role)."""
    if not a.score:
        sys.exit("this stage reads traders' P&L or a test statistic: pass --score (only after Step A is complete "
                 "and a reviewer has passed the code)")
    spec = guard.check_args(role, a.rank, a.test, a.days)
    m = _manifest(a.work)
    if m.get("prep_only"):
        guard.refuse("a prep-only ledger cannot be scored")
    guard.verify(a.work, role, m, code_hashes())
    days = _load_days(a.work, spec["days"])
    got = sorted(d["day"] for d in days)
    if got != sorted(spec["days"]):
        guard.refuse(f"{role} needs every day of {spec['days']}, found {got}")
    return m, spec, days


def cmd_gate(a):
    classes, clusters, flippers, persist, positions, replay, rules = _mods()
    m, spec, days = _scored(a, "gate")
    res = []
    for d in days:
        trader, info = clusters.build(days, d["day"])
        g = persist.gate(d, trader, counts_only=False)
        g["seat_tag_by_class"] = classes.seat_summary(classes.seat_tag(d, trader), classes.classify(d, trader))
        g["clusters"] = info
        g["hub_effect"] = clusters.hub_effect(days, d["day"])
        res.append(g)
    print(json.dumps({"days": res, "verdict": persist.gate_verdict(res, spec["days"])}, indent=1, default=str))


def cmd_flippers(a):
    """AMENDMENT_4 rows on Step A: flipper class per day and over the tape, its persistence, a census of buy SOL by
    class, and the flows around flippers' trips. No P&L and no ranking."""
    classes, clusters, flippers, persist, positions, replay, rules = _mods()
    m, spec, days = _scored(a, "gate")
    import pandas as pd
    t_last, _ = clusters.build(days, days[-1]["day"])
    tape = flippers.flipper_class(pd.concat([d["trips"] for d in days], ignore_index=True), t_last)
    flip_tape = set(tape.index[tape["flipper"]]) if len(tape) else set()
    out = {"flippers_on_tape": len(flip_tape), "days": {}}
    for d in days:
        tr, _ = clusters.build(days, d["day"])
        fc = flippers.flipper_class(d["trips"], tr)
        out["days"][d["day"]] = {"trips": int(len(d["trips"])),
                                 "flippers_that_day": int(fc["flipper"].sum()) if len(fc) else 0,
                                 "buy_sol_census": flippers.census(d, tr, flip_tape),
                                 "flows": flippers.flows(d["trips"], flip_tape, t_last,
                                                         guard.ledger_units(m, [d["day"]]), _vocab(a.work))}
    for d1, d2 in zip(days, days[1:]):
        t1, _ = clusters.build(days, d1["day"])
        out[f"persistence {d1['day']}->{d2['day']}"] = flippers.persistence(d1, d2, t1)
    print(json.dumps(out, indent=1, default=str))


def _persistence(a, role, with_replay):
    classes, clusters, flippers, persist, positions, replay, rules = _mods()
    m, spec, days = _scored(a, role)
    by = {d["day"]: d for d in days}
    rank_day, test_days = spec["rank"], spec["test"]
    trader, info = clusters.build(days, rank_day)         # identity as of the ranking day only
    ranked, rinfo = persist.rank(by[rank_day], trader)    # reads the ranking day only
    tests, reports = [], {}
    for t in test_days:                                    # outcome stage
        p, rep = persist.test_day_returns(by[t], trader, ranked)
        tests.append(p)
        reports[t] = rep
    import pandas as pd
    tp = pd.concat(tests, ignore_index=True)
    gr = persist.groups(tp)
    boot = persist.bootstrap(gr)
    out = {"rank_day": rank_day, "test_days": test_days, "clusters": info, "ranking": rinfo,
           "decile_report": reports, "top_decile_by_cash_method": persist.top_decile_means(tp)}
    if not with_replay:
        out["discovery"] = persist.discovery_verdict(gr, boot)
        return out, tp, ranked, m
    top = tp[tp["decile"] == 10]
    units = guard.ledger_units(m, test_days)               # the ledger's own units, never the cache
    rp = replay.replay_trades(top[["mint", "day", "entry_slot", "exit_slot", "open_at_end", "day_hi"]], units, _vocab(a.work))
    rm = replay.replay_mean(rp)
    out["replay"] = {"trades": int(len(rp)), "replayed": int(np.isfinite(rp["ret_replay"]).sum()),
                     **replay.shares(rp),
                     "reasons": {k: int(v) for k, v in rp["replay_reason"].value_counts().items() if k}}
    top_nc = float(tp.loc[tp["decile"] == 10, "ret_nc"].mean()) if (tp["decile"] == 10).any() else float("nan")
    out["validation"] = persist.validation_verdict(gr, boot, rm, top_mean_uncapped=top_nc)   # AMENDMENT_6
    return out, tp, ranked, m


def cmd_discovery(a):
    out, _, _, _ = _persistence(a, "discovery", with_replay=False)
    print(json.dumps(out, indent=1, default=str))


def cmd_validation(a):
    out, tp, ranked, m = _persistence(a, "validation", with_replay=True)
    f = os.path.join(a.work, "validation.pkl")
    _save(f, {"out": out, "test_positions": tp, "ranked": ranked, "ledger_sha": m["ledger_sha"]})
    m["validation_sha"] = load.file_sha256(f)
    _write_manifest(a.work, m)
    print(json.dumps(out, indent=1, default=str))


def cmd_extract(a):
    """§8 extraction. Runs only after a validation pass recorded (and hashed) by `validation` in the same work."""
    classes, clusters, flippers, persist, positions, replay, rules = _mods()
    m, spec, days = _scored(a, "extract")
    import pandas as pd
    with open(os.path.join(a.work, "validation.pkl"), "rb") as f:
        val = pickle.load(f)
    if not val["out"]["validation"]["pass"]:
        sys.exit("§8 runs only after a validation pass")
    vocab = _vocab(a.work)
    trader, _ = clusters.build(days, spec["rank"])
    tp, ranked = val["test_positions"], val["ranked"]
    winners = persist.winners(tp)                        # AMENDMENT_3 Q17
    ent = []
    for d in days:
        b = d["buys"]
        b = b[b["opening"]].copy()
        b["trader"] = clusters.assign(b["owner"].to_numpy(), trader)
        b["day"] = d["day"]
        pos = positions.trader_positions(d, trader)
        ex = pos.set_index(["trader", "mint"])["exit_slot"]
        b["hold"] = ex.reindex(list(zip(b["trader"], b["mint"]))).to_numpy() - b["slot"].to_numpy()
        ent.append(b)
    ent = pd.concat(ent, ignore_index=True)
    w = ent[ent["trader"].isin(winners)]
    ctl = rules.matched_sample(w, ent[~ent["trader"].isin(winners)])
    allm = set(w["mint"].astype(int)) | set(ctl["mint"].astype(int))
    units = guard.ledger_units(m, spec["days"])
    led = _event_ledger(units, vocab)
    info = _info(led)
    tapes = rules.tapes_for(units, vocab, allm, info, _excluder(led))
    wX = rules.entry_features(w.reset_index(drop=True), tapes, info)
    cX = rules.entry_features(ctl, tapes, info)
    rule = rules.extract(wX.to_numpy(), w["hold"].to_numpy(), cX.to_numpy())
    tags = pd.concat([classes.seat_tag(d, trader) for d in days])
    wt = tags[tags.index.isin(winners)]
    rule["seat"]["winners_median_seat_cost_sol"] = float(wt["median_seat_cost_sol"].median()) if len(wt) else None
    rule["seat"]["winners_median_buy_slot_rank"] = float(wt["median_buy_slot_rank"].median()) if len(wt) else None
    rule["winners"] = len(winners)
    rule["winner_entries"] = int(len(w))
    rule["matched_entries"] = int(len(ctl))
    rf = os.path.join(a.work, "rule.json")
    with open(rf, "w") as f:
        json.dump(rule, f, indent=1, default=str)
    m["rule_sha"] = load.file_sha256(rf)
    _write_manifest(a.work, m)
    print(json.dumps({k: v for k, v in rule.items() if k != "tree"}, indent=1, default=str))


def _event_ledger(units, vocab, swaps_too=True):
    """Create, migration, BOOST facts and pools of the units (the ledger's own event pass, without the P&L)."""
    led = Ledger(vocab)
    for u in units:
        led._events(load.events(u))
        if swaps_too:
            sw = load.swaps(u, vocab)
            led.pools |= set(sw.loc[sw["venue"] == 1, "pool"].tolist())
    return led


def _info(led):
    return {"create": led.create, "migr": led.migr, "boost_done": led.boost_done}


def _excluder(led):
    """§8 holder exclusion from the days being read: their pools, curves, BOOST authorities, fixed addresses and
    off-curve addresses."""
    cache = {}

    def ex(o):
        if o not in cache:
            cache[o] = led._excluded([o])[0] != ""
        return cache[o]
    return ex


def cmd_ruletest(a):
    classes, clusters, flippers, persist, positions, replay, rules = _mods()
    m, spec, days = _scored(a, "ruletest")
    import pandas as pd
    if not a.rule_work:
        guard.refuse("ruletest needs --rule-work (the extract work directory)")
    rm = _manifest(a.rule_work)
    guard.verify(a.rule_work, "extract", rm, code_hashes())    # the extract work passes its own guards too
    rf = os.path.join(a.rule_work, "rule.json")
    if not os.path.exists(rf) or load.file_sha256(rf) != rm.get("rule_sha"):
        guard.refuse("rule.json is missing or does not match the hash `extract` recorded")
    with open(rf) as f:
        rule = json.load(f)
    path = [tuple(p) for p in rule["path_idx"]]
    vocab = _vocab(a.work)
    units = guard.ledger_units(m, spec["days"])
    led = Ledger(vocab)
    cands = []
    for u in units:
        sw = load.swaps(u, vocab)
        led._events(load.events(u))
        led.pools |= set(sw.loc[sw["venue"] == 1, "pool"].tolist())
        s = sw[sw["sol"].astype(bool) & sw["is_buy"].astype(bool) & (sw["pre"] == 0) & (sw["owner"] >= 0)]
        cands.append(pd.DataFrame({"mint": s["mint"], "slot": s["slot"], "bt": s["bt"], "key": s["key"],
                                   "paid": -s["cash"], "day": u.day}))
    cands = pd.concat(cands, ignore_index=True)
    if len(cands) == 0:
        print(json.dumps({"pass": False, "trades": 0, "reason": "no candidate entries"}))
        return
    info = _info(led)
    tapes = rules.tapes_for(units, vocab, set(cands["mint"].astype(int)), info, _excluder(led))
    X = rules.entry_features(cands, tapes, info).to_numpy()
    fires = rules.rule_fires(cands, X, path, rule["hold_slots"])
    ctl = rules.control_entries(fires, cands)
    rows = replay.state_rows(units, vocab, set(fires["mint"]) | set(ctl["mint"]))
    trades = rules.rule_test_trades(fires, ctl, rows, rule["hold_slots"], min(u.lo for u in units),
                                    max(u.hi for u in units))
    print(json.dumps(rules.rule_test_verdict(trades, spec["days"]), indent=1, default=str))


def main(argv=None):
    p = argparse.ArgumentParser(prog="w1")
    p.add_argument("stage", choices=["ledger", "counts", "gate", "flippers", "discovery", "validation", "extract",
                                     "ruletest"])
    p.add_argument("--work", required=True)
    p.add_argument("--units", nargs="*")
    p.add_argument("--cache", default="/home/user/tape-cache")
    p.add_argument("--days", nargs="*")
    p.add_argument("--rank")
    p.add_argument("--test", nargs="*")
    p.add_argument("--rule-work")
    p.add_argument("--dev-allow-gaps", action="store_true", help="development only; scored stages refuse it")
    p.add_argument("--score", action="store_true")
    p.add_argument("--prep-only", action="store_true",
                   help="ledger only: no cash, cost or valuation is computed; no scoring module is imported")
    p.add_argument("--legacy-reader", action="store_true", help="ledger only: the original whole-table reader")
    a = p.parse_args(argv)
    {"ledger": cmd_ledger, "counts": cmd_counts, "gate": cmd_gate, "flippers": cmd_flippers, "discovery": cmd_discovery,
     "validation": cmd_validation, "extract": cmd_extract, "ruletest": cmd_ruletest}[a.stage](a)


if __name__ == "__main__":
    main()
