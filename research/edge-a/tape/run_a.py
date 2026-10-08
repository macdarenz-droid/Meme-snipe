"""Design A on the shared tape: entry point.

Default (check) mode writes counts and shapes only: units, coverage, pool exclusions, the count rule, the supply-rule
check and cross-event counts. It never computes or prints a gate statistic or interval.
Scoring (--score-primary) also needs --confirm REVIEW-PASSED-AND-STEP-A-COMPLETE.

  nice -n 19 python3 run_a.py --days 2026-09-10 2026-09-11 --steps A --cache /home/user/tape-cache --out OUT
  nice -n 19 python3 run_a.py --days 2026-09-11 --units DIR [DIR ...] --out OUT
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import features as F  # noqa: E402
import gates as G  # noqa: E402
import load as L  # noqa: E402

CONFIRM = "REVIEW-PASSED-AND-STEP-A-COMPLETE"
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
FEE_CONFIG = os.path.join(REPO, "research", "edge", "snapshot", "fee-configs.json")
SUPPLY_RULE_MIN_AGREEMENT = 0.99


def build(units: list[L.Unit], fee_config: str = FEE_CONFIG) -> dict:
    """All features for Design A from the given units. Returns pools, per-pool arrays and diagnostics."""
    blocks = [L.load_blocks(u) for u in units]
    segs = L.coverage_segments(units, blocks)
    events = pd.concat([L.load_events(u) for u in units], ignore_index=True)
    pools = F.pool_table(events, segs)
    pools = pools.reset_index(drop=True)
    codes = {p: i for i, p in enumerate(pools.pool)}
    boost_sigs = set(events.loc[events.event == "BoostBuyAndBurnEvent", "signature"])
    tiers = F.load_fee_tiers(fee_config)
    tally = {"n": 0, "base_supply": 0, "fixed_1e15": 0}
    parts = []
    for u in units:
        for ch in L.iter_swaps(u):
            t = F.supply_rule_tally(ch, tiers)
            for k in tally:
                tally[k] += t[k]
            parts.append(F.compact_swaps(ch, codes, boost_sigs))
    sw = pd.concat(parts, ignore_index=True) if parts else F.compact_swaps(pd.DataFrame(columns=L.S_AMM_COLS), codes, boost_sigs)

    # Swap-level exclusions: every swap of the pool must be canonical and WSOL-quoted; a pool needs swaps.
    n_sw = np.bincount(sw.pool.to_numpy(), minlength=len(pools))
    bad = np.bincount(sw.pool.to_numpy()[~sw.canon_sol.to_numpy()], minlength=len(pools)) > 0
    reason = pools.reason.to_numpy(object)
    reason = np.where((reason == "") & bad, "not_canonical_sol", reason)
    reason = np.where((reason == "") & (n_sw == 0), "no_swaps", reason)
    pools["reason"] = reason
    pools["eligible"] = pools.reason == ""
    pools.loc[~pools.eligible, "lo"] = np.nan  # excluded pools contribute nothing

    cuts = F.cutoffs()
    seg_id = L.segment_of(sw.slot.to_numpy(), segs)
    iv = F.clip_to_window(F.timeline(sw, segs, seg_id), pools)
    up, dn = F.band_seconds(iv, len(pools), cuts)
    win = F.in_window(sw, pools)
    net = F.creator_net(sw, win, len(pools), cuts)
    counted = F.count_rule_pools(sw, win, len(pools))
    pools["window_seconds"] = np.bincount(iv.pool.to_numpy(), weights=iv.dur.to_numpy(), minlength=len(pools))
    pools["n_swaps"] = n_sw
    pools["count_rule"] = counted & pools.eligible.to_numpy()
    entries = F.cross_events(sw, pools, cuts)
    el = pools.eligible.to_numpy()
    return {"units": units, "segs": segs, "pools": pools, "cuts": cuts, "up": up[el], "dn": dn[el],
            "net": net[el], "entries": entries, "supply_tally": tally, "n_swaps": len(sw),
            "n_creator_swaps_in_window": int((win & sw.is_creator.to_numpy()).sum())}


def summary(b: dict, steps: tuple[str, ...]) -> dict:
    p = b["pools"]
    t = b["supply_tally"]
    agree = {k: (t[k] / t["n"] if t["n"] else None) for k in ("base_supply", "fixed_1e15")}
    return {
        "units": [{"day": u.day, "from": u.from_slot, "to": u.to_slot, "schema": u.schema} for u in b["units"]],
        "steps_read": list(steps),
        "segments": b["segs"].to_dict("records"),
        "pools_migrated": int(len(p)),
        "pools_eligible": int(p.eligible.sum()),
        "exclusions": {k: int(v) for k, v in p.reason[p.reason != ""].value_counts().items()},
        "boost_rule": {k: int(v) for k, v in p.boost_rule.value_counts().items()},
        "eligible_window_hours_total": float(p.window_seconds[p.eligible].sum() / 3600),
        "swaps_kept": int(b["n_swaps"]),
        "creator_swaps_in_window": b["n_creator_swaps_in_window"],
        "count_rule": G.count_rule(int(p.count_rule.sum()), steps),
        "supply_rule_check": {"rows": t["n"], "agreement": agree,
                              "used": "base_supply", "verified": bool(agree["base_supply"] is not None and
                                                                       agree["base_supply"] >= SUPPLY_RULE_MIN_AGREEMENT)},
        "cutoffs_sol": [round(float(c), 3) for c in b["cuts"]],
        "cross_events_per_cutoff": b["entries"].groupby("cutoff_idx").size().reindex(range(len(b["cuts"])), fill_value=0).tolist(),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", nargs="+", required=True, help="tape days (YYYY-MM-DD), all before 2026-09-12")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--units", nargs="+", help="unit directories (<day>/<from>-<to> or its research/)")
    src.add_argument("--cache", help="tape cache root; every unit of --days under it is used")
    ap.add_argument("--steps", nargs="+", default=["A"], choices=list(G.STEPS), help="tape steps these days complete")
    ap.add_argument("--max-units", type=int, default=0, help="development cap on the number of units")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fee-config", default=FEE_CONFIG)
    ap.add_argument("--score-primary", action="store_true")
    ap.add_argument("--confirm", default="")
    ap.add_argument("--n-boot", type=int, default=G.DEFAULT_B)
    a = ap.parse_args(argv)
    if a.score_primary and a.confirm != CONFIRM:
        ap.error(f"--score-primary needs --confirm {CONFIRM}")
    units = L.select_units(a.units, a.days) if a.units else L.find_units(a.cache, a.days)
    units.sort(key=lambda u: u.from_slot)
    if a.max_units:
        units = units[:a.max_units]
    if not units:
        ap.error("no units found")
    b = build(units, a.fee_config)
    steps = tuple(a.steps)
    os.makedirs(a.out, exist_ok=True)
    s = summary(b, steps)
    with open(os.path.join(a.out, "summary.json"), "w") as f:
        json.dump(s, f, indent=1, default=str)
    keep = ["pool", "mint", "mig_slot", "mig_time", "reason", "eligible", "boost_rule", "n_boost", "lo", "hi",
            "n_swaps", "window_seconds", "count_rule"]
    b["pools"][keep].to_csv(os.path.join(a.out, "pools.csv"), index=False)
    b["entries"].to_csv(os.path.join(a.out, "entries.csv"), index=False)
    if a.score_primary:
        if not s["supply_rule_check"]["verified"]:
            raise SystemExit("supply rule not verified on this data; not scoring")
        res = G.score_gates(b["up"], b["dn"], b["net"], s["count_rule"]["n"], steps, a.n_boot)
        np.savez(os.path.join(a.out, "features.npz"), up=b["up"], dn=b["dn"], net=b["net"], cuts=b["cuts"],
                 pools=b["pools"].pool[b["pools"].eligible].to_numpy())
        with open(os.path.join(a.out, "gates.json"), "w") as f:
            json.dump(res, f, indent=1, default=float)
    print(json.dumps({k: s[k] for k in ("pools_migrated", "pools_eligible", "exclusions", "count_rule",
                                        "supply_rule_check", "cross_events_per_cutoff")}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
