"""W1 entry point.

  python3 -m w1.run ledger  --work DIR (--units U [U ...] | --cache C --days D [D ...])
  python3 -m w1.run counts  --work DIR [--days D ...]                       development: counts and shapes only
  python3 -m w1.run gate    --work DIR --days 2026-09-10 2026-09-11 --score  §6 gate W1-0 (reads P&L)
  python3 -m w1.run discovery  --work DIR --rank 2026-09-10 --test 2026-09-11 --score
  python3 -m w1.run validation --work DIR --rank 2026-09-07 --test 2026-09-08 2026-09-09 --score
  python3 -m w1.run extract   --work DIR --rank 2026-09-07 --test 2026-09-08 2026-09-09 --days 2026-09-07 ... --score
  python3 -m w1.run ruletest  --work DIR --rule RULE.json --days <untouched days> --score

`ledger` reads the tape and writes one ledger file per day (WORK/ledger-DAY.pkl) plus WORK/manifest.json (input and
code sha256, seeds). Every stage that reads traders' P&L or a test statistic refuses to run without --score; the
primary is scored only after Step A is complete and a reviewer has passed this code. Summaries name no address."""
import argparse
import glob
import hashlib
import json
import os
import pickle
import sys

import numpy as np

from . import classes, clusters, load, persist, positions, replay, rules
from .ledger import Ledger

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


def cmd_ledger(a):
    units = load.parse_units(a.units) if a.units else load.find_units(a.cache, a.days)
    if not units:
        sys.exit("no units")
    os.makedirs(a.work, exist_ok=True)
    vocab = load.Vocab()
    led = Ledger(vocab)
    manifest = {"units": [f"{u.day}/{u.lo}-{u.hi}" for u in units], "inputs": load.input_hashes(units),
                "code": code_hashes(), "seed": persist.SEED, "bootstrap": persist.B, "days": {}}
    cur = None
    for u in units:
        if cur is not None and u.day != cur:
            d = led.finish_day()
            _save(os.path.join(a.work, f"ledger-{d['day']}.pkl"), d)
            manifest["days"][d["day"]] = _day_counts(d)
        cur = u.day
        led.process_unit(u)
        print(f"unit {u.day} {u.lo}-{u.hi} done", file=sys.stderr)
    d = led.finish_day()
    _save(os.path.join(a.work, f"ledger-{d['day']}.pkl"), d)
    manifest["days"][d["day"]] = _day_counts(d)
    manifest["stats"] = {k: (v if k != "gaps" else [list(g) for g in v]) for k, v in led.stats.items()}
    manifest["excluded_by_type"] = {k: int(len(v)) for k, v in d["excluded"].items()}
    _save(os.path.join(a.work, "vocab.pkl"), vocab)
    with open(os.path.join(a.work, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, default=str)
    print(json.dumps(manifest["days"], indent=1, default=str))


def _day_counts(d):
    r = d["rows"]
    return {"lo": int(d["lo"]), "hi": int(d["hi"]), "gaps": int(d["gaps"]), "owner_mint_rows": int(len(r)),
            "dirty_rows": int(r["dirty"].sum()), "unresolved_rows": int(r["unresolved"].sum()),
            "partial_rows": int(r["partial"].sum()), "no_state_marks": int(r["no_state"].sum()),
            "owners": int(len(d["owners"])), "buys": int(len(d["buys"])), "big_buys": int(len(d["big"])),
            "transfers_between_tracked": int(len(d["xfers"])), "w_links": int(len(d["wedges"])),
            "t_links": int(len(d["tedges"])), "cg_events": int(len(d["cg"])),
            "excluded_by_type": {k: int(len(v)) for k, v in d["excluded"].items()}}


def cmd_counts(a):
    """Development check: shapes and counts per day. Reads no P&L value and no test statistic."""
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


def _need_score(a):
    if not a.score:
        sys.exit("this stage reads traders' P&L or a test statistic: pass --score (only after Step A is complete "
                 "and a reviewer has passed the code)")


def cmd_gate(a):
    _need_score(a)
    days = _load_days(a.work)
    res = []
    for d in [x for x in days if x["day"] in a.days]:
        trader, info = clusters.build(days, d["day"])
        g = persist.gate(d, trader, counts_only=False)
        g["clusters"] = info
        g["hub_effect"] = clusters.hub_effect(days, d["day"])
        res.append(g)
    print(json.dumps({"days": res, "verdict": persist.gate_verdict(res)}, indent=1, default=str))


def _persistence(a, with_replay):
    days = _load_days(a.work)
    by = {d["day"]: d for d in days}
    trader, info = clusters.build(days, a.rank)          # identity as of the ranking day only
    ranked, rinfo = persist.rank(by[a.rank], trader)     # reads the ranking day only
    tests, reports = [], {}
    for t in a.test:                                      # outcome stage
        p, rep = persist.test_day_returns(by[t], trader, ranked)
        tests.append(p)
        reports[t] = rep
    import pandas as pd
    tp = pd.concat(tests, ignore_index=True)
    gr = persist.groups(tp)
    boot = persist.bootstrap(gr)
    out = {"rank_day": a.rank, "test_days": a.test, "clusters": info, "ranking": rinfo, "decile_report": reports}
    if not with_replay:
        out["discovery"] = persist.discovery_verdict(gr, boot)
        return out, tp, ranked
    top = tp[tp["decile"] == 10]
    units = load.find_units(a.cache, a.test) if a.cache else load.parse_units(a.units)
    rp = replay.replay_trades(top[["mint", "entry_slot", "exit_slot", "open_at_end", "day_hi"]], units, _vocab(a.work))
    rm = replay.replay_mean(rp)
    out["replay"] = {"trades": int(len(rp)), "replayed": int(np.isfinite(rp["ret_replay"]).sum()),
                     "not_replayed": {k: int(v) for k, v in rp["replay_reason"].value_counts().items() if k}}
    out["validation"] = persist.validation_verdict(gr, boot, rm)
    return out, tp, ranked


def cmd_discovery(a):
    _need_score(a)
    out, _, _ = _persistence(a, with_replay=False)
    print(json.dumps(out, indent=1, default=str))


def cmd_validation(a):
    _need_score(a)
    out, tp, ranked = _persistence(a, with_replay=True)
    _save(os.path.join(a.work, "validation.pkl"), {"out": out, "test_positions": tp, "ranked": ranked})
    print(json.dumps(out, indent=1, default=str))


def cmd_extract(a):
    """§8 extraction. Runs only after a validation pass recorded by `validation`."""
    _need_score(a)
    import pandas as pd
    with open(os.path.join(a.work, "validation.pkl"), "rb") as f:
        val = pickle.load(f)
    if not val["out"]["validation"]["pass"]:
        sys.exit("§8 runs only after a validation pass")
    days = _load_days(a.work)
    vocab = _vocab(a.work)
    trader, _ = clusters.build(days, a.rank)
    tp, ranked = val["test_positions"], val["ranked"]
    mid = tp[tp["decile"].isin([5, 6])]["ret"].mean()
    top = tp[tp["decile"] == 10].groupby("trader")["ret"].mean()
    winners = set(top[top > mid].index)                  # OPEN_QUESTIONS Q17
    ent, holds = [], []
    for d in [x for x in days if x["day"] in a.days]:
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
    units = load.find_units(a.cache, a.days)
    led_info = _ledger_info(units, vocab)
    excl = _excluder(days)
    tapes = rules.tapes_for(units, vocab, allm, led_info, excl)
    wX = rules.entry_features(w.reset_index(drop=True), tapes, led_info)
    cX = rules.entry_features(ctl, tapes, led_info)
    rule = rules.extract(wX.to_numpy(), w["hold"].to_numpy(), cX.to_numpy())
    rule["winners"] = len(winners)
    rule["winner_entries"] = int(len(w))
    rule["matched_entries"] = int(len(ctl))
    with open(os.path.join(a.work, "rule.json"), "w") as f:
        json.dump(rule, f, indent=1, default=str)
    print(json.dumps({k: v for k, v in rule.items() if k != "tree"}, indent=1, default=str))


def _ledger_info(units, vocab):
    """Create, migration and BOOST facts for the units (the ledger's own event pass, without the P&L)."""
    led = Ledger(vocab)
    for u in units:
        led._events(load.events(u))
    return {"create": led.create, "migr": led.migr, "boost_done": led.boost_done}


def _excluder(days):
    ex = set()
    for d in days:
        ex |= set(d["hub_excluded_nodes"].tolist())
    return lambda o: o in ex


def cmd_ruletest(a):
    _need_score(a)
    import pandas as pd
    with open(a.rule) as f:
        rule = json.load(f)
    path = [tuple(p) for p in rule["path_idx"]]
    vocab = _vocab(a.work)
    units = load.find_units(a.cache, a.days)
    led = Ledger(vocab)
    cands = []
    for u in units:
        sw = load.swaps(u, vocab)
        led._events(load.events(u))
        s = sw[sw["sol"].astype(bool) & sw["is_buy"].astype(bool) & (sw["pre"] == 0) & (sw["owner"] >= 0)]
        cands.append(pd.DataFrame({"mint": s["mint"], "slot": s["slot"], "bt": s["bt"], "key": s["key"],
                                   "paid": -s["cash"], "day": u.day}))
    cands = pd.concat(cands, ignore_index=True)
    info = {"create": led.create, "migr": led.migr, "boost_done": led.boost_done}
    tapes = rules.tapes_for(units, vocab, set(cands["mint"].astype(int)), info, _excluder(_load_days(a.work)))
    X = rules.entry_features(cands, tapes, info).to_numpy()
    fires = rules.rule_fires(cands, X, path, rule["hold_slots"])
    ctl = rules.control_entries(fires, cands)
    rows = replay.state_rows(units, vocab, set(fires["mint"]) | set(ctl["mint"]))
    trades = rules.rule_test_trades(fires, ctl, rows, rule["hold_slots"])
    print(json.dumps(rules.rule_test_verdict(trades), indent=1, default=str))


def main(argv=None):
    p = argparse.ArgumentParser(prog="w1")
    p.add_argument("stage", choices=["ledger", "counts", "gate", "discovery", "validation", "extract", "ruletest"])
    p.add_argument("--work", required=True)
    p.add_argument("--units", nargs="*")
    p.add_argument("--cache", default="/home/user/tape-cache")
    p.add_argument("--days", nargs="*")
    p.add_argument("--rank")
    p.add_argument("--test", nargs="*")
    p.add_argument("--rule")
    p.add_argument("--score", action="store_true")
    a = p.parse_args(argv)
    {"ledger": cmd_ledger, "counts": cmd_counts, "gate": cmd_gate, "discovery": cmd_discovery,
     "validation": cmd_validation, "extract": cmd_extract, "ruletest": cmd_ruletest}[a.stage](a)


if __name__ == "__main__":
    main()
