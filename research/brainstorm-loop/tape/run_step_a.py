"""Step A count rows: entry point.

    python3 run_step_a.py --unit DIR [--unit DIR ...] --out OUTDIR [--sol-usd FILE] [--boot N] [--decide]

Counts and flows only. Gate thresholds are applied only with --decide (after Step A is complete and
this code has passed review).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import rows as R  # noqa: E402
from tapeio import DEFAULT_PLAN, PlanError, Tape, check_plan, unit_info  # noqa: E402


def read_sol_usd(path):
    """CSV with columns day,sol_usd (one SOL/USD reading per tape day, from the Binance public archive)."""
    if not path:
        return None
    df = pd.read_csv(path, dtype={"day": str})
    return dict(zip(df["day"], df["sol_usd"].astype(float)))


def run(units, out, sol_usd=None, n_boot=R.BOOT_N, decide=False, plan=None):
    R.BOOT_N = n_boot
    tape = Tape(units)
    adj = R.adjacency(tape.links)
    labels, two = R.two_sided_clusters(tape)
    s = R.prepare(tape, labels)
    fast = R.w1_fast_class(tape, s)
    dz, dz_s = R.dev_zero(tape, s, adj)
    rb, rb_s = R.rebuy_anchor(tape, s)
    sd, sd_s = R.seat_drift(tape, s, adj)
    ag, ag_s = R.age_gate(tape, s, fast)
    ru, ru_s = R.round_usd(tape, s, sol_usd, adj, n_boot=min(n_boot, 1000))
    summary = {
        "units": [f"{d} {a}-{b}" for d, a, b in tape.ranges],
        "swaps": int(len(s)), "boost_rows_excluded": int(s["boost"].sum()),
        "first_time_buys": int(s["ftb"].sum()), "fake_demand_rows": int(s["fake"].sum()),
        "w1_fast_owner_days": int(fast.sum()), "w1_owner_days": int(len(fast)),
        "1_dev_zero": dz_s, "2_rebuy_anchor": rb_s, "3_seat_drift": sd_s, "4_age_gate": ag_s,
        "5_two_sided_clusters": two, "6_round_usd": ru_s,
    }
    if decide:
        summary["plan"] = plan
        summary["decision"] = {"1_dev_zero_prereg_by_arm": R.dev_zero_decide(dz_s),
                               "3_seat_drift_prereg": R.seat_drift_decide(sd_s),
                               "2_rebuy_anchor": "not decidable: see not_computed_pending_ruling"}
    os.makedirs(out, exist_ok=True)
    for name, df in (("dev_zero", dz), ("rebuy_exits", rb), ("seat_drift", sd), ("age_gate", ag),
                     ("two_sided_labels", labels), ("round_usd", ru)):
        df.to_csv(os.path.join(out, f"stepa_{name}.csv"), index=False)
    with open(os.path.join(out, "stepa_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, default=str)
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--unit", action="append", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sol-usd")
    ap.add_argument("--boot", type=int, default=R.BOOT_N)
    ap.add_argument("--decide", action="store_true")
    ap.add_argument("--plan", default=DEFAULT_PLAN, help="committed Step A plan (checked with --decide)")
    a = ap.parse_args(argv)
    plan_sha = None
    if a.decide:
        try:
            plan_sha = check_plan([unit_info(u)[1:] for u in a.unit], a.plan)
        except PlanError as e:
            ap.error(f"--decide refused: {e}")
    s = run(a.unit, a.out, read_sol_usd(a.sol_usd), a.boot, a.decide,
            plan={"path": a.plan, "sha256": plan_sha} if a.decide else None)
    json.dump(s, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
