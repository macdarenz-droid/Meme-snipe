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

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import h8 as H8  # noqa: E402
import migseat as MS  # noqa: E402
import payer as PM  # noqa: E402
import rebuy as RB  # noqa: E402
import rows as R  # noqa: E402
import slicer as SL  # noqa: E402
from tapeio import DEFAULT_PLAN, PlanError, Tape, check_plan, unit_info  # noqa: E402


def read_sol_usd(paths):
    """SOL/USD per tape day, with each file's sha256 (COUNT_ROWS_AMENDMENT_1: the Binance public archive's
    SOLUSDT 1-minute closes, committed with their sha256).
    Also returns the minute closes (Series: open time in epoch s -> close) for H8's hourly SOL/USD, or None.
    Accepts Binance kline CSVs (no header: open_time, open, high, low, close, ...; open_time in ms or us,
    UTC day from open_time) -> {day: (median, min, max) of the closes}; or a CSV with header day,sol_usd."""
    import hashlib

    if not paths:
        return None, [], None
    out, shas, minutes = {}, [], []
    for p in paths:
        with open(p, "rb") as fh:
            shas.append({"path": p, "sha256": hashlib.sha256(fh.read()).hexdigest()})
        head = pd.read_csv(p, nrows=0).columns
        if "day" in head and "sol_usd" in head:
            df = pd.read_csv(p, dtype={"day": str})
            out.update(dict(zip(df["day"], df["sol_usd"].astype(float))))
            continue
        k = pd.read_csv(p, header=None)
        k = k[pd.to_numeric(k[0], errors="coerce").notna()]
        t = pd.to_numeric(k[0]).astype("int64")
        unit = np.where(t > 10**14, "us", "ms")
        ts = pd.to_datetime(np.where(unit == "us", t // 1000, t), unit="ms", utc=True)
        close = pd.to_numeric(k[4]).astype(float)
        for d, c in close.groupby(ts.strftime("%Y-%m-%d").values):
            out[d] = (float(c.median()), float(c.min()), float(c.max()))
        secs = np.where(unit == "us", t // 10**6, t // 1000)
        minutes.append(pd.Series(close.values, index=secs))
    m = pd.concat(minutes).sort_index() if minutes else None
    return out, shas, m


DEFAULT_SOL_USD_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sol-usd"))


# sha256 of the committed sol-usd/SHA256SUMS, pinned so that a zip and its SHA256SUMS line cannot be edited together
SOL_USD_SUMS_SHA256 = "02083908d386a53c07acd1663bdd74f102053f12bcd92856cf09670fcf3da964"


class SolUsdError(Exception):
    pass


def load_sol_usd_dir(days, folder=DEFAULT_SOL_USD_DIR, sums_sha256=SOL_USD_SUMS_SHA256):
    """The committed Binance SOLUSDT 1-minute klines for each tape day (`SOLUSDT-1m-<day>.zip`), each checked
    against the folder's SHA256SUMS (itself pinned by sha256), plus the previous day's file when SHA256SUMS lists it (for the 00:00 hour's
    close). Refuses (SolUsdError) on a missing day, a file not listed, or a mismatch."""
    import hashlib

    sums_path = os.path.join(folder, "SHA256SUMS")
    if not os.path.exists(sums_path):
        raise SolUsdError(f"no SHA256SUMS in {folder}")
    with open(sums_path, "rb") as fh:
        sums_got = hashlib.sha256(fh.read()).hexdigest()
    if sums_got != sums_sha256:
        raise SolUsdError(f"SHA256SUMS sha256 {sums_got} is not the pinned {sums_sha256}")
    sums = {}
    for line in open(sums_path):
        f = line.split()
        if len(f) == 2:
            sums[f[1].lstrip("*")] = f[0].lower()
    import datetime as _dt

    need = [(d, True) for d in sorted(days)]
    # a day's 00:00 hour needs the previous day's 23:59 bar: load that day too when SHA256SUMS lists it
    for d in sorted(days):
        prev = (_dt.date.fromisoformat(d) - _dt.timedelta(days=1)).isoformat()
        if prev not in days and f"SOLUSDT-1m-{prev}.zip" in sums:
            need.append((prev, False))
    paths = []
    for d, required in need:
        name = f"SOLUSDT-1m-{d}.zip"
        p = os.path.join(folder, name)
        if name not in sums or not os.path.exists(p):
            raise SolUsdError(f"SOL/USD missing for {d} ({name})")
        with open(p, "rb") as fh:
            got = hashlib.sha256(fh.read()).hexdigest()
        if got != sums[name]:
            raise SolUsdError(f"{name}: sha256 {got} does not match SHA256SUMS {sums[name]}")
        paths.append(p)
    px, shas, minutes = read_sol_usd(paths)
    missing = [d for d in days if d not in px]
    if missing:
        raise SolUsdError(f"no closes for {missing} in the SOL/USD files")
    return px, shas, minutes


# PAYER_MASS.md, defined per event by COUNT_ROWS_AMENDMENT_7 (payer.py). SEAT-DRIFT's bar is computed; DEV-ZERO's
# and REBUY-ANCHOR's wait on the questions in CODE_REDTEAM.md (R1-17), and stay "not computed", which never earns.
NOT_COMPUTED = {
    "1_dev_zero": {"passed": None, "status": "not computed"},
    "2_rebuy_anchor": {"passed": None, "status": "not computed"},
    "3_seat_drift": {"passed": None, "status": "not computed"},
}
# AMENDMENT_8 leaves open over which set DEV-ZERO's Q terciles are cut (CODE_REDTEAM.md Q-R1-i). Until it is ruled, the
# DEV-ZERO bar is computed and reported but no arm earns.
DEV_ZERO_Q_TERCILE_RULED = False


def _strip(v):
    if isinstance(v, dict):
        return {k: _strip(x) for k, x in v.items() if k != "events"}
    return v


def decision(dz_s, sd_s, rb_s, payer=None):
    """A row earns a PREREG only when its own thresholds pass and its payer-mass bar passed (None = not computed,
    which never earns). `payer` maps "1_dev_zero" ({"by_arm": {arm: bar}}), "2_rebuy_anchor" and "3_seat_drift" to a
    bar result. DEV-ZERO's arms earn in the fixed order (AMENDMENT_7): an arm earns only if every earlier arm earned."""
    payer = {**NOT_COMPUTED, **(payer or {})}
    own = {"1_dev_zero_by_arm": R.dev_zero_decide(dz_s), "2_rebuy_anchor": RB.rebuy_decide(rb_s),
           "3_seat_drift": R.seat_drift_decide(sd_s)}
    ok = {k: payer[k].get("passed") is True for k in ("2_rebuy_anchor", "3_seat_drift")}
    by_arm = payer["1_dev_zero"].get("by_arm") or {}
    dev, open_ = {}, True
    for arm, v in own["1_dev_zero_by_arm"].items():
        bar_ok = (by_arm.get(arm) or {}).get("passed") is True
        dev[arm] = bool(open_ and v and bar_ok and DEV_ZERO_Q_TERCILE_RULED)
        open_ = bool(open_ and v and bar_ok)
    return {"own_thresholds": own, "payer_mass_bar": _strip(payer),
            "1_dev_zero_prereg_by_arm": dev,
            "2_rebuy_anchor_prereg": bool(own["2_rebuy_anchor"] and ok["2_rebuy_anchor"]),
            "3_seat_drift_prereg": bool(own["3_seat_drift"] and ok["3_seat_drift"])}


REGISTERED_BOOT = 10_000   # COUNT_ROWS_AMENDMENT_1 Q1; run() overwrites R.BOOT_N, so this stays apart


def run(units, out, sol_usd=None, n_boot=R.BOOT_N, decide=False, plan=None, sol_usd_files=None, minutes=None):
    R.BOOT_N = n_boot
    tape = Tape(units)
    adj = R.adjacency(tape.links)
    labels, two = R.two_sided_clusters(tape)
    s = R.prepare(tape, labels)
    fast = R.w1_fast_class(tape, s)
    dz, dz_s = R.dev_zero(tape, s, adj)
    rb, rb_pts, rb_pairs, rb_s = RB.rebuy_anchor(tape, s)
    sd, sd_s = R.seat_drift(tape, s, adj)
    seat_bar = PM.seat_drift_bar(sd, sorted({d for d, _, _ in tape.ranges}))   # COUNT_ROWS_AMENDMENT_7, 8
    rb_bar = PM.rebuy_bar(rb_pts, sorted({d for d, _, _ in tape.ranges}))   # AMENDMENT_8
    dev_bar = {"passed": None, "status": "per arm (by_arm)",
               "by_arm": PM.dev_zero_bar(dz, sorted({d for d, _, _ in tape.ranges}))}   # AMENDMENT_8
    ag, ag_s = R.age_gate(tape, s, fast)
    ru, ru_s = R.round_usd(tape, s, sol_usd, adj, n_boot=min(n_boot, 1000))
    # H8_AMENDMENT: rows 1-3 on the H8-eligible stratum at $5, $20, $50, and the H8 capacity count row
    hourly = H8.hourly_px(minutes)
    days = sorted({d for d, _, _ in tape.ranges})
    if hourly:
        ctx = H8.GateCtx(tape, s, hourly)
        h8_strata = {"1_dev_zero": H8.dev_zero_stratum(dz, days, hourly, ctx),
                     "2_rebuy_anchor": H8.rebuy_stratum(tape, rb, rb_pts, rb_pairs, hourly, ctx),
                     "3_seat_drift": H8.seat_drift_stratum(sd, hourly, ctx)}
        h8_ph, h8_gr, h8_cap = H8.h8_capacity(tape, s, hourly, ctx)
    else:
        need = "needs SOL/USD 1-minute closes (--sol-usd Binance kline CSVs)"
        h8_strata, h8_cap = {"status": need}, {"status": need}
        h8_ph = h8_gr = pd.DataFrame()
    # COUNT_ROWS_AMENDMENT_4 (slicer ride), _5 (MIG-SEAT, MAYHEM-SNAP) and _6
    gctx = ctx if hourly else H8.GateCtx(tape, s, hourly)
    cmaps, _ = R.cluster_maps(tape)
    sl_ev, sl_plc, sl_ctl, sl_s = SL.slicer_rows(tape, s, adj, fast, gctx, cmaps["hub_cap_50"])
    ms_df, ms_s = MS.mig_seat(tape, s, gctx)
    mh_df, mh_s = MS.mayhem_snap(tape, s, hourly)
    summary = {
        "units": [f"{d} {a}-{b}" for d, a, b in tape.ranges],
        "swaps": int(len(s)), "boost_rows_excluded": int(s["boost"].sum()),
        "first_time_buys": int(s["ftb"].sum()), "fake_demand_rows": int(s["fake"].sum()),
        "w1_fast_owner_days": int(fast.sum()), "w1_owner_days": int(len(fast)),
        "1_dev_zero": dz_s, "2_rebuy_anchor": rb_s, "3_seat_drift": sd_s, "4_age_gate": ag_s,
        "5_two_sided_clusters": two, "6_round_usd": ru_s, "sol_usd_files": sol_usd_files or [],
        "h8_stratum_rows_1_3": h8_strata, "7_h8_capacity": h8_cap,
        "8_slicer_ride": sl_s, "9_mig_seat": ms_s, "10_mayhem_snap": mh_s,
    }
    summary["payer_mass_3_seat_drift"] = _strip(seat_bar)
    summary["payer_mass_1_dev_zero"] = _strip(dev_bar)
    summary["payer_mass_2_rebuy_anchor"] = _strip(rb_bar)
    if decide:
        summary["plan"] = plan
        summary["decision"] = decision(dz_s, sd_s, rb_s, {"3_seat_drift": seat_bar, "1_dev_zero": dev_bar,
                                                          "2_rebuy_anchor": rb_bar})
        summary["decision"].update({
            "8_slicer_ride_counts_to_owner": sl_s["all_rows_pass"],          # never a PREREG before the ethics ruling
            "9_mig_seat_prereg_gradual": ms_s["prereg_gradual"],
            "10_mayhem_snap_prereg_may_be_written": mh_s["prereg_may_be_written"]})
    os.makedirs(out, exist_ok=True)
    for name, df in (("dev_zero", dz), ("rebuy_exits", rb), ("rebuy_points", rb_pts), ("rebuy_pairs", rb_pairs), ("seat_drift", sd), ("age_gate", ag),
                     ("two_sided_labels", labels), ("round_usd", ru), ("h8_pool_hours", h8_ph), ("h8_graduates", h8_gr),
                     ("slicer_events", sl_ev), ("slicer_low_b_placebo", sl_plc), ("slicer_controls", sl_ctl),
                     ("mig_seat", ms_df), ("mayhem_snap_down_steps", mh_df)):
        df.to_csv(os.path.join(out, f"stepa_{name}.csv"), index=False)
    with open(os.path.join(out, "stepa_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, default=str)
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--unit", action="append", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sol-usd", default=DEFAULT_SOL_USD_DIR,
                    help="folder of Binance SOLUSDT-1m-<day>.zip files with SHA256SUMS (default: the committed one)")
    ap.add_argument("--boot", type=int, default=REGISTERED_BOOT)
    ap.add_argument("--decide", action="store_true")
    ap.add_argument("--plan", default=DEFAULT_PLAN, help="committed Step A plan (checked with --decide)")
    a = ap.parse_args(argv)
    plan_sha = None
    if a.decide:
        if a.boot != REGISTERED_BOOT:   # COUNT_ROWS_AMENDMENT_1 Q1: 10,000 resamples (red team R1-4)
            ap.error(f"--decide uses the registered {REGISTERED_BOOT} resamples; --boot {a.boot} is refused")
        try:
            plan_sha = check_plan([unit_info(u)[1:] for u in a.unit], a.plan)
        except PlanError as e:
            ap.error(f"--decide refused: {e}")
    try:
        px, px_sha, minutes = load_sol_usd_dir(sorted({unit_info(u)[1] for u in a.unit}), a.sol_usd)
    except SolUsdError as e:
        ap.error(f"SOL/USD refused: {e}")
    s = run(a.unit, a.out, px, a.boot, a.decide, sol_usd_files=px_sha, minutes=minutes,
            plan={"path": a.plan, "sha256": plan_sha} if a.decide else None)
    json.dump(s, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
