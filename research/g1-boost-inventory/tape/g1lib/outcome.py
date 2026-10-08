"""Stage 2: fills and returns (PREREG §4, §5, §10). Runs only on decisions from stage 1 that were not dropped by
time; reads the market after the decision. It is the only module that computes a strategy return, and it is
separate from the feature code (decide.py, features.py), which never imports it."""
import math
from typing import Optional

import numpy as np
import pandas as pd

from . import params as P
from .costs import expected_fixed, rent_log
from .market import Market
from .quotes import (Fill, curve_buy_exact_quote_in, curve_sell, curve_spot_value, pool_sell, pool_spot_value,
                     worse_buy, worse_sell)


def entry_fill(mkt: Market, mint: int, slot: int, spend: int):
    """Buy on the curve in `slot`, the worse of the start and end state of the slot, with our own impact on the
    constant-product virtual reserves (PREREG §4)."""
    s0 = mkt.curve_state(mint, slot, end=False)
    s1 = mkt.curve_state(mint, slot, end=True)
    f = mkt.curve_fees(mint, slot)
    if s0 is None or s1 is None:
        return Fill(False, "no-curve-state"), f
    return worse_buy([curve_buy_exact_quote_in(s0, spend, f), curve_buy_exact_quote_in(s1, spend, f)]), f


def curve_exit(mkt: Market, mint: int, slot: int, tokens: int) -> Fill:
    s0 = mkt.curve_state(mint, slot, end=False)
    s1 = mkt.curve_state(mint, slot, end=True)
    f = mkt.curve_fees(mint, slot)
    if s0 is None or s1 is None:
        return Fill(False, "no-curve-state")
    return worse_sell([curve_sell(s0, tokens, f), curve_sell(s1, tokens, f)])


def pool_exit(mkt: Market, pool: int, slot: int, tokens: int):
    s0 = mkt.pool_state(pool, slot, end=False)
    s1 = mkt.pool_state(pool, slot, end=True)
    f, src = mkt.pool_fees(pool, slot)
    if s0 is None or s1 is None:
        return Fill(False, "no-pool-state"), src
    return worse_sell([pool_sell(s0, tokens, f), pool_sell(s1, tokens, f)]), src


def simulate(mkt: Market, d: dict, spend: int, exit_offset: int = P.D) -> dict:
    """One trade. Misses (curve complete before or in the entry slot, size infeasible) are counted, not scored."""
    tape = mkt.tape
    mint = int(d["mint_c"])
    entry_slot = int(d["entry_slot"])
    out = {"filled": False, "miss": "", "exit": "", "paid": np.nan, "proceeds": np.nan, "fixed": np.nan, "net": np.nan,
           "ret": np.nan}
    c = mkt.completion_slot(mint)
    if c is not None and c < entry_slot:
        out["miss"] = "complete-before-entry"
        return out
    if c is not None and c == entry_slot:
        out["miss"] = "complete-in-entry-slot"     # OQ-4
        return out
    buy, _ = entry_fill(mkt, mint, entry_slot, spend)
    if not buy.ok:
        out["miss"] = "entry-" + buy.reason
        return out
    tokens = buy.tokens
    entry_time = int(d["entry_time"])
    mig = mkt.mig.get(mint)
    exit_fill: Optional[Fill] = None
    src = ""
    if mig is not None and int(mig["block_time"]) <= entry_time + P.EXIT_B_SECONDS and int(mig["slot"]) > entry_slot:
        m, pool = int(mig["slot"]), int(mig["pool_c"])
        xs = m + exit_offset
        seg = tape.segment_of(int(d["t0"]))
        if seg is None or xs > seg[1]:
            out["miss"] = "exit-beyond-data"         # only possible for secondary exit offsets
            return out
        exit_fill, src = pool_exit(mkt, pool, xs, tokens)
        out["exit"] = "A"
        out["exit_slot"] = xs
        out["m"] = m
    else:
        xs = int(d["exitB_slot"])
        exit_fill = curve_exit(mkt, mint, xs, tokens)
        out["exit"] = "B"
        out["exit_slot"] = xs
    rl = rent_log(d.get("token_program") or "", entry_slot)
    fixed = expected_fixed(rl["rent_lamports"])
    paid = buy.user_quote
    proceeds = exit_fill.user_quote if exit_fill.ok else 0
    out.update({
        "filled": True, "tokens": tokens, "paid": paid, "proceeds": proceeds, "fixed": fixed,
        "net": proceeds - paid - fixed, "ret": (proceeds - paid - fixed) / paid,
        "entry_fees": buy.fees, "entry_impact": buy.impact,
        "exit_fees": exit_fill.fees if exit_fill.ok else 0, "exit_impact": exit_fill.impact if exit_fill.ok else 0,
        "exit_ok": exit_fill.ok, "exit_fail_reason": exit_fill.reason, "unsold_tokens": exit_fill.unsold_tokens,
        "pool_fee_source": src, **rl,
    })
    out["gross_ret"] = (out["net"] + out["entry_fees"] + out["entry_impact"] + out["exit_fees"] + out["exit_impact"] + fixed) / paid
    out["fees_pct"] = (out["entry_fees"] + out["exit_fees"]) / paid
    out["impact_pct"] = (out["entry_impact"] + out["exit_impact"]) / paid
    out["fixed_pct"] = fixed / paid
    if out["exit"] == "A":
        out.update(decompose(mkt, mint, int(mig["pool_c"]), int(mig["slot"]), tokens, paid, proceeds))
    return out


def decompose(mkt: Market, mint: int, pool: int, m: int, tokens: int, paid: int, proceeds: int) -> dict:
    """PREREG §10: curve leg (entry to the last curve price), migration step (last curve price to the pool's opening
    price) and the window m to m + D (opening price to the executable exit), in lamports (OQ-13)."""
    last = mkt.curve_state(mint, m, end=True)
    v_curve = curve_spot_value(last, tokens) if last is not None else np.nan
    open_state = mkt.pool_state(pool, m, end=False)
    if open_state is None:
        open_state = mkt.pool_init.get(pool)
    v_open = pool_spot_value(open_state, tokens) if open_state is not None else np.nan
    return {"dec_curve_leg": v_curve - paid, "dec_migration_step": v_open - v_curve, "dec_window": proceeds - v_open}


def run(mkt: Market, d: pd.DataFrame, with_secondary: bool = True, log=print) -> pd.DataFrame:
    """Primary and S0 trades at $50 with exit at m + D, plus the §10 variants. Decisions dropped by time, out of the
    universe or left-censored are not traded."""
    rows = []
    live = d[(d["reason"] == "") & (~d["censored"]) & (~d["dropped_by_time"]) & (d["stratum"] == "sol")]
    spend = P.spend_lamports(P.SIZE_USD_PRIMARY)
    for rec in live.to_dict("records"):
        base = {"kind": rec["kind"], "mint": rec["mint"], "day": rec["day"], "t0": rec["t0"], "variant": "primary"}
        if rec["kind"] in ("G1", "S0") or rec["kind"].startswith("G1@"):
            rows.append({**base, **simulate(mkt, rec, spend)})
        if not with_secondary or rec["kind"] != "G1":
            continue
        for name, off in P.SECONDARY_EXITS.items():
            rows.append({**base, "variant": f"exit {name}", **simulate(mkt, rec, spend, off)})
        for usd in P.SECONDARY_SIZES_USD:
            rows.append({**base, "variant": f"size ${usd}", **simulate(mkt, rec, P.spend_lamports(usd))})
    log(f"  outcomes: {len(rows)} rows")
    return pd.DataFrame(rows)
