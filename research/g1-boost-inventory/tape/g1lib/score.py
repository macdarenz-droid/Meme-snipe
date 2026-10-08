"""Judgement (PREREG §8–§9; amendment 1 and 2 "Arm", "Judgement", "Futility"). Reads the outcome stage's trades
and the frozen discovery medians. Run only when scoring is allowed (README "Order of work")."""
import json
import math

import pandas as pd

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


def judge(trades: pd.DataFrame, decisions: pd.DataFrame, frozen: dict, role: str) -> dict:
    g1, s0, hc, cap = arms(trades, decisions, frozen)
    if role == "discovery":
        out = {"G1": futility(g1), "G1_HC": futility(hc), "G1_CAP": futility(cap)}
        g1_closes = out["G1"]["closes"]
        for k in ("G1_HC", "G1_CAP"):
            # amendments: closes with G1 unless its own one-sided 95% upper bound on discovery is above 0
            out[k]["closes"] = out[k]["closes"] or (g1_closes and not (out[k]["upper_95_one_sided"] > 0))
        return out
    return {"G1": primary(g1, control=s0),
            "G1_HC": primary(hc, control=s0, lift_over={"G1": g1}),
            "G1_CAP": primary(cap, control=s0, lift_over={"G1": g1})}


def freeze(decisions: pd.DataFrame) -> dict:
    """Discovery medians committed before any validation day is read (amendment 1 "Arm"; amendment 2 "Arm")."""
    g = decisions[(decisions["kind"] == "G1") & (decisions["reason"] == "") & (~decisions["censored"])]
    r = g["R"].dropna() if "R" in g else pd.Series(dtype=float)
    z = g.loc[g["cap_reason"].fillna("") == "", "Z"].dropna() if "Z" in g else pd.Series(dtype=float)
    return {"median_R": float(r.median()) if len(r) else None, "n_R": int(len(r)),
            "median_Z": float(z.median()) if len(z) else None, "n_Z": int(len(z)),
            "days": sorted(g["day"].dropna().unique().tolist())}
