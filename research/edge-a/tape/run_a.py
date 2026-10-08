"""Design A on the shared tape: entry point.

Default (check) mode writes counts and shapes only: units, coverage, pool exclusions, the count rule, the supply-rule
check and cross-event counts. It never computes or prints a gate statistic or interval.
Scoring (--score-primary) also needs --confirm REVIEW-PASSED-AND-STEP-A-COMPLETE.

  nice -n 19 python3 run_a.py --days 2026-09-10 2026-09-11 --cache /home/user/tape-cache --out OUT
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

# Count row 6 (research/brainstorm-loop/tape, frozen) is read for Design A's verdict (AMENDMENT_2 Q11).
BL_TAPE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "brainstorm-loop",
                                       "tape"))
if BL_TAPE not in sys.path:
    sys.path.append(BL_TAPE)

CONFIRM = "REVIEW-PASSED-AND-STEP-A-COMPLETE"
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
FEE_CONFIG = os.path.join(REPO, "research", "edge", "snapshot", "fee-configs.json")
SUPPLY_RULE_MIN_AGREEMENT = 0.999  # on rows where live and fixed supply pick different tiers


def supply_verified(t: dict) -> bool:
    return bool(t["n_diff"] > 0 and t["base_supply"] / t["n_diff"] >= SUPPLY_RULE_MIN_AGREEMENT)


def usd_separability(sol_usd: dict) -> dict:
    """AMENDMENT_2 Q11: count row 6's round-USD flag per tape day, and whether 420 SOL is within 5% of a round USD
    level on every day (then a gate pass is "not separable from a USD level")."""
    import rows as R6
    flags, ns = R6.usd_level_flags(sol_usd, sorted(sol_usd))
    return {"flags": flags, "not_separable": ns}


def load_usd_separability(days) -> dict:
    """Row 6 on the scored days, from the committed sha-pinned Binance SOL/USD files (refuses a missing day)."""
    import run_step_a as RS
    px, shas, _ = RS.load_sol_usd_dir(sorted(days))
    out = usd_separability({d: px[d] for d in days})
    out["sol_usd_files"] = shas
    return out


def earlier_step_met(units: list[L.Unit], steps: tuple[str, ...], fee_config: str = FEE_CONFIG):
    """The count rule is read step by step (A, then A+B, then A+B+C), and the gates are scored once, at the first
    step that meets it. Returns the earlier steps that already met it (a later scoring would be a second look)."""
    for k in range(1, len(steps)):
        prev = steps[:k]
        days = {d for s in prev for d in L.STEP_DAYS[s]}
        n = int(build([u for u in units if u.day in days], fee_config)["pools"].count_rule.sum())
        if G.count_rule(n, prev)["status"] == "met":
            return prev, n
    return None


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
    tally = {"n": 0, "n_diff": 0, "base_supply": 0, "fixed_1e15": 0}
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
    return {"units": units, "segs": segs, "pools": pools, "cuts": cuts, "up": up[el], "dn": dn[el], "sw": sw,
            "blocks": pd.concat(blocks, ignore_index=True),
            "net": net[el], "entries": entries, "supply_tally": tally, "n_swaps": len(sw),
            "n_creator_swaps_in_window": int((win & sw.is_creator.to_numpy()).sum())}


def summary(b: dict, steps: tuple[str, ...]) -> dict:
    p = b["pools"]
    t = b["supply_tally"]
    agree = {k: (t[k] / t["n_diff"] if t["n_diff"] else None) for k in ("base_supply", "fixed_1e15")}
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
        "supply_rule_check": {"rows": t["n"], "rows_where_tiers_differ": t["n_diff"],
                              "agreement_where_tiers_differ": agree, "used": "base_supply",
                              "verified": supply_verified(t)},
        "cutoffs_sol": [round(float(c), 3) for c in b["cuts"]],
        "cross_events_per_cutoff": b["entries"].groupby("cutoff_idx").size().reindex(range(len(b["cuts"])), fill_value=0).tolist(),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", nargs="+", required=True, help="tape days (YYYY-MM-DD), all before 2026-09-12")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--units", nargs="+", help="unit directories (<day>/<from>-<to> or its research/)")
    src.add_argument("--cache", help="tape cache root; every unit of --days under it is used")
    ap.add_argument("--plan", default=L.PLAN, help='planned units, lines "DAY EPOCH FROM TO"')
    ap.add_argument("--max-units", type=int, default=0, help="development cap on the number of units")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fee-config", default=FEE_CONFIG)
    ap.add_argument("--score-primary", action="store_true")
    ap.add_argument("--confirm", default="")
    ap.add_argument("--n-boot", type=int, default=G.DEFAULT_B)
    a = ap.parse_args(argv)
    if a.score_primary:
        if a.confirm != CONFIRM:
            ap.error(f"--score-primary needs --confirm {CONFIRM}")
        if a.n_boot != G.DEFAULT_B:
            ap.error(f"--score-primary uses the registered {G.DEFAULT_B} resamples; --n-boot {a.n_boot} is refused")
        if a.units or a.max_units:
            ap.error("--score-primary reads whole steps from --cache: --units and --max-units are refused")
        try:
            steps = L.scoring_steps(a.days)
        except L.IncompleteError as e:
            ap.error(str(e))
    else:
        steps = L.steps_from_days(a.days)
    units = L.select_units(a.units, a.days) if a.units else L.find_units(a.cache, a.days)
    units.sort(key=lambda u: u.from_slot)
    if a.max_units:
        units = units[:a.max_units]
    if not units:
        ap.error("no units found")
    if a.score_primary:
        try:
            L.check_days_complete(units, a.days, L.read_plan(a.plan))
        except L.IncompleteError as e:
            ap.error(str(e))
        met = earlier_step_met(units, steps, a.fee_config)
        if met:
            ap.error(f"the count rule was met at Step {'+'.join(met[0])} ({met[1]} pools); the gates are scored "
                     f"there, once: scoring {'+'.join(steps)} would be a second look")
    b = build(units, a.fee_config)
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
        try:
            usd = load_usd_separability(sorted({u.day for u in units}))
        except Exception as e:  # noqa: BLE001 - any failure to read row 6 refuses the verdict
            raise SystemExit(f"count row 6 (round USD) could not be read: {e}; not scoring")
        if usd["not_separable"] is None:
            raise SystemExit("count row 6 has a day without SOL/USD; not scoring")
        res = G.score_gates(b["up"], b["dn"], b["net"], s["count_rule"]["n"], steps, a.n_boot,
                            usd_not_separable=usd["not_separable"])
        res["count_row_6"] = usd
        if res.get("return_test_may_run"):   # AMENDMENT_2 Q9, on the same scored days and units
            import outcomes as O
            el = b["pools"].eligible.to_numpy()
            ent = b["entries"][el[b["entries"].pool.to_numpy()]] if len(b["entries"]) else b["entries"]
            res["return_test"] = O.score_return_test(b["sw"], ent, b["blocks"], b["segs"], O.load_tiers(a.fee_config),
                                                     sorted({u.day for u in units}))
        np.savez(os.path.join(a.out, "features.npz"), up=b["up"], dn=b["dn"], net=b["net"], cuts=b["cuts"],
                 pools=b["pools"].pool[b["pools"].eligible].to_numpy())
        with open(os.path.join(a.out, "gates.json"), "w") as f:
            json.dump(res, f, indent=1, default=float)
    print(json.dumps({k: s[k] for k in ("pools_migrated", "pools_eligible", "exclusions", "count_rule",
                                        "supply_rule_check", "cross_events_per_cutoff")}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
