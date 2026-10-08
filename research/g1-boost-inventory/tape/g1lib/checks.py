"""PREREG §7 checks 2–5 on the tape (check 1, the planted future marker, is a unit test: tests/test_asof.py).
Each check returns counts and shares only."""
import hashlib
import json
import os
from collections import Counter

import numpy as np
import pandas as pd

from . import params as P
from .market import Market


def check2_reserves(tape) -> dict:
    """Curve reserves are after the trade; PumpSwap reserves are before it."""
    c = tape.curve
    same = (c["mint"].shift(1) == c["mint"]).to_numpy()
    sign = np.where(c["is_buy"].to_numpy() == 1, 1, -1)
    prev_real = c["real_sol_reserves"].shift(1).to_numpy()
    prev_tok = c["real_token_reserves"].shift(1).to_numpy()
    after_sol = prev_real + sign * c["sol_amount"].to_numpy() == c["real_sol_reserves"].to_numpy()
    after_tok = prev_tok - sign * c["token_amount"].to_numpy() == c["real_token_reserves"].to_numpy()
    out = {"curve_pairs": int(same.sum()),
           "curve_after_identity_share": float(after_sol[same].mean()) if same.any() else None,
           "curve_after_token_identity_share": float(after_tok[same].mean()) if same.any() else None}
    p = tape.pool_rows
    if len(p):
        buy = (p["side"] == "buy").to_numpy()
        exp_base = np.where(buy, p["pool_base_token_reserves"] - p["base_amount"], p["pool_base_token_reserves"] + p["base_amount"])
        ok = p["after_base"].to_numpy() >= 0
        out["pool_rows"] = int(ok.sum())
        out["pool_before_identity_share"] = float((exp_base[ok] == p["after_base"].to_numpy()[ok]).mean()) if ok.any() else None
        nxt_same = (p["pool"].shift(-1) == p["pool"]).to_numpy()
        out["pool_virtual_unchanged_share"] = float((p["virtual_quote_reserves"].shift(-1).to_numpy()[nxt_same] == p["virtual_quote_reserves"].to_numpy()[nxt_same]).mean()) if nxt_same.any() else None
    return out


def check3_tier(tape, mkt: Market) -> dict:
    """Which market cap the PumpSwap tier uses: the observed fee rates on canonical SOL pools against the snapshot's
    tiers under three readings (effective quote × 1B / base; effective quote × base_supply / base; real vault × 1B /
    base). The snapshot is from 2026-10-03, so a mismatch may also be a schedule change (OQ-16)."""
    with open(os.path.join(P.HERE, "..", "..", "edge", "snapshot", "fee-configs.json")) as f:
        tiers = json.load(f)["amm"]["fee_tiers"]
    th = np.array([int(t["market_cap_lamports_threshold"]) for t in tiers], dtype=float)
    fees = [(int(t["fees"]["lp_fee_bps"]), int(t["fees"]["protocol_fee_bps"]), int(t["fees"]["creator_fee_bps"])) for t in tiers]
    p = tape.pool_rows
    if not len(p):
        return {}
    wsol = tape.names.get(P.WSOL)
    p = p[(~p["is_boost"]) & (p["base_mint"] != wsol) & (p["canonical"] == 1)]
    obs = list(zip(p["lp_fee_basis_points"], p["protocol_fee_basis_points"], p["coin_creator_fee_basis_points"]))
    base = p["pool_base_token_reserves"].to_numpy().astype(float)
    eff = (p["pool_quote_token_reserves"] + p["virtual_quote_reserves"]).to_numpy().astype(float)
    sup = p["base_supply"].to_numpy().astype(float)
    readings = {"eff_x_1B": eff * P.TOKEN_TOTAL_SUPPLY / base, "eff_x_supply": eff * sup / base,
                "vault_x_1B": p["pool_quote_token_reserves"].to_numpy() * P.TOKEN_TOTAL_SUPPLY / base}
    out = {"rows": int(len(p)), "observed_rates": {str(k): v for k, v in Counter(obs).most_common(8)}}
    for k, mc in readings.items():
        idx = np.clip(np.searchsorted(th, mc, "right") - 1, 0, len(th) - 1)
        pred = [fees[i] for i in idx]
        out["match_" + k] = float(np.mean([a == b for a, b in zip(pred, obs)])) if obs else None
        out["match_lp_protocol_" + k] = float(np.mean([a[:2] == b[:2] for a, b in zip(pred, obs)])) if obs else None
    return out


def check4_target(tape, mkt: Market) -> dict:
    """The 85.005 SOL target and the 0.015 SOL migration fee against the tape's completions."""
    c = tape.curve
    done = c[(c["real_token_reserves"] <= 0) & (c["quote_mint"] == P.SOL_QUOTE_CURVE)]
    real = (done["virtual_sol_reserves"] - P.INITIAL_VIRTUAL_SOL).to_numpy()
    mig = tape.events["CompletePumpAmmMigrationEvent"]
    fee = mig.loc[mig.get("quote_mint", pd.Series(dtype=str)) == P.SOL_QUOTE_CURVE, "pool_migration_fee"].astype(np.int64) if len(mig) else pd.Series(dtype=np.int64)
    return {"sol_completions": int(len(real)),
            "real_sol_at_completion": {str(k): v for k, v in Counter(real.tolist()).most_common(5)},
            "share_equal_registered_target": float((np.abs(real - P.TARGET_LAMPORTS) < 1_000_000).mean()) if len(real) else None,
            "migration_fee_values": {str(k): int(v) for k, v in Counter(fee.tolist()).most_common(5)},
            "share_fee_equal_registered": float((fee == P.MIGRATION_FEE_LAMPORTS).mean()) if len(fee) else None}


def token_programs(tape) -> dict:
    ce = tape.events["CreateEvent"]
    return {str(k): int(v) for k, v in ce.get("token_program", pd.Series(dtype=str)).fillna("").value_counts().items()}


def input_hashes(units) -> dict:
    """PREREG §7 check 5: sha256 of every input table read."""
    out = {}
    for u in units:
        for f in sorted(os.listdir(u.path)):
            h = hashlib.sha256()
            with open(os.path.join(u.path, f), "rb") as fh:
                for b in iter(lambda: fh.read(1 << 20), b""):
                    h.update(b)
            out[f"{u.day}/{u.from_slot}-{u.to_slot}/{f}"] = h.hexdigest()
    return out


def code_hashes() -> dict:
    out = {}
    root = P.HERE
    for dp, _, fs in os.walk(root):
        if "__pycache__" in dp or os.sep + "out" in dp:
            continue
        for f in sorted(fs):
            if f.endswith((".py", ".ts", ".json", ".md")):
                p = os.path.join(dp, f)
                out[os.path.relpath(p, root)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out
