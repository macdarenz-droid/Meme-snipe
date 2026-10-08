"""Judgement (PREREG §8–§9; amendment 1 and 2 "Arm", "Judgement", "Futility"). Reads the outcome stage's trades
and the frozen discovery medians. Run only when scoring is allowed (README "Order of work")."""
import json
import math

import pandas as pd

from . import guard
from . import params as P
from .stats import futility, primary


def arms(trades: pd.DataFrame, decisions: pd.DataFrame, frozen: dict):
    prim = trades[trades["variant"] == "primary"]
    g1 = prim[prim["kind"] == "G1"]
    s0 = prim[prim["kind"] == "S0"]
    f = decisions[decisions["kind"] == "G1"][["mint", "R", "Z", "cap_reason"]]
    g = g1.merge(f, on="mint", how="left")
    hc = g[g["R"].notna() & (g["R"] < frozen["median_R"])] if frozen.get("median_R") is not None else g.iloc[0:0]
    cap = g[g["Z"].notna() & (g["cap_reason"].fillna("") == "") & (g["Z"] <= frozen["median_Z"])] if frozen.get("median_Z") is not None else g.iloc[0:0]
    return g1, s0, hc, cap


def secondary(trades: pd.DataFrame) -> dict:
    """PREREG §10, reported and never judged: every variant with gross return, fixed costs, percentage fees and
    price impact shown separately; infeasible sizes; exit-B share and mean; the decomposition."""
    out = {}
    for (kind, variant), g in trades.groupby(["kind", "variant"]):
        f = g[g["filled"]]
        row = {"rows": int(len(g)), "filled": int(len(f)),
               "misses": {str(k): int(v) for k, v in g.loc[~g["filled"], "miss"].value_counts().items()}}
        if len(f):
            row.update({c: float(f[c].mean()) for c in ("ret", "gross_ret", "fees_pct", "impact_pct", "fixed_pct") if c in f})
            b = f[f["exit"] == "B"]
            row["share_exit_B"] = float(len(b) / len(f))
            row["mean_ret_exit_B"] = float(b["ret"].mean()) if len(b) else math.nan
            a = f[f["exit"] == "A"]
            for c in ("dec_curve_leg", "dec_migration_step", "dec_window"):
                if c in a and len(a):
                    row[c + "_pct_of_paid"] = float((a[c] / a["paid"]).mean())
        out[f"{kind} | {variant}"] = row
    return out


def judge(trades: pd.DataFrame, decisions: pd.DataFrame, frozen: dict, role: str) -> dict:
    g1, s0, hc, cap = arms(trades, decisions, frozen)
    if role == "discovery":
        # PREREG §8: the primary on discovery days is for information only; futility may only close
        out = {"G1": futility(g1), "G1_HC": futility(hc), "G1_CAP": futility(cap),
               "G1_information_only": primary(g1, control=s0)}
        g1_closes = out["G1"]["closes"]
        for k in ("G1_HC", "G1_CAP"):
            # amendments: closes with G1 unless its own one-sided 95% upper bound on discovery is above 0
            out[k]["closes"] = out[k]["closes"] or (g1_closes and not (out[k]["upper_95_one_sided"] > 0))
        return out
    vd = guard.VALIDATION_DAYS
    return {"G1": primary(g1, control=s0, required_days=vd),
            "G1_HC": primary(hc, control=s0, lift_over={"G1": g1}, required_days=vd),
            "G1_CAP": primary(cap, control=s0, lift_over={"G1": g1}, required_days=vd),
            "secondary": secondary(trades)}


def freeze(decisions: pd.DataFrame) -> dict:
    """Discovery medians committed before any validation day is read (amendment 1 "Arm"; amendment 2 "Arm")."""
    g = decisions[(decisions["kind"] == "G1") & (decisions["reason"] == "") & (~decisions["censored"])]
    r = g["R"].dropna() if "R" in g else pd.Series(dtype=float)
    z = g.loc[g["cap_reason"].fillna("") == "", "Z"].dropna() if "Z" in g else pd.Series(dtype=float)
    return {"median_R": float(r.median()) if len(r) else None, "n_R": int(len(r)),
            "median_Z": float(z.median()) if len(z) else None, "n_Z": int(len(z)),
            "days": sorted(g["day"].dropna().unique().tolist())}
