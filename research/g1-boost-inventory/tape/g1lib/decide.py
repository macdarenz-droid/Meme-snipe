"""Stage 1: universe, triggers and decision timing (PREREG §3, §4, §5; amendment 2 §3 strata).

Every function here reads only rows at or before the decision slot, except `timing`, which reads block times
(the clock) and the covered slot ranges to apply the drop-by-time rule (PREREG §2), and never reads a trade,
event or outcome after the decision.
"""
import hashlib
import math
from typing import List, Optional

import numpy as np
import pandas as pd

from . import params as P
from .load import Tape

STRATA = ("sol", "usdc", "token")


def stratum(quote_mint) -> Optional[str]:
    if not isinstance(quote_mint, str) or quote_mint == "":
        return None
    if quote_mint == P.SOL_QUOTE_CURVE:
        return "sol"
    if quote_mint == P.USDC:
        return "usdc"
    return "token"


def create_index(tape: Tape) -> dict:
    """mint code -> first CreateEvent row (as a dict)."""
    ce = tape.events["CreateEvent"]
    out = {}
    if len(ce):
        for r in ce.sort_values(["slot", "tx_idx"]).itertuples(index=False):
            out.setdefault(r.mint_c, r._asdict())
    return out


def flags_asof(rows: pd.DataFrame, create: Optional[dict]):
    """PREREG §3: (stratum, reason). reason is '' when the curve is in the universe, else why not.
    Sources: the create row (when it is at or before the decision) and the curve's trade rows up to the decision.
    Mayhem or cashback in any source excludes. A flag no source can read excludes ('flags-unreadable')."""
    quotes = set(q for q in rows["quote_mint"].dropna().unique() if q != "")
    mayhem = rows["mayhem_mode"].dropna()
    cash = rows["cashback_fee_basis_points"].dropna()
    may_known, cash_known = len(mayhem) > 0, len(cash) > 0
    is_mayhem = bool((mayhem == 1).any())
    is_cash = bool((cash != 0).any())
    if create is not None:
        q = create.get("quote_mint")
        if isinstance(q, str) and q:
            quotes.add(q)
        m = create.get("is_mayhem_mode")
        if m is not None and not (isinstance(m, float) and math.isnan(m)):
            may_known = True
            is_mayhem = is_mayhem or str(m) == "1"
        cb = create.get("is_cashback_enabled")
        if cb is not None and not (isinstance(cb, float) and math.isnan(cb)):
            cash_known = True
            is_cash = is_cash or str(cb) == "1"
    if len(quotes) != 1:
        return (None, "flags-unreadable" if not quotes else "quote-mint-conflict")
    st = stratum(next(iter(quotes)))
    if not (may_known and cash_known):
        return (st, "flags-unreadable")
    if is_mayhem:
        return (st, "mayhem")
    if is_cash:
        return (st, "cashback")
    if st != "sol":
        return (st, "non-sol-quote")
    return (st, "")


def real_progress(rows: pd.DataFrame, st: str) -> np.ndarray:
    """Real quote in the curve after each trade (curve reserves are after the trade, PREREG §7 check 2).
    SOL: virtual_sol_reserves − 30 SOL (PREREG §4). Other quotes (amendment 2 §3, descriptive): real_quote_reserves."""
    if st == "sol":
        return rows["virtual_sol_reserves"].to_numpy() - P.INITIAL_VIRTUAL_SOL
    return rows["real_quote_reserves"].to_numpy()


def quote_target(rows: pd.DataFrame) -> int:
    """Completion real quote for a non-SOL curve (OQ-10): vq0·vt0/(vt0 − rt0) − vq0, with vq0 = virtual − real quote.
    For SOL (vq0 = 30 SOL) this gives the registered 85.005 SOL."""
    vq0 = int((rows["virtual_quote_reserves"] - rows["real_quote_reserves"]).iloc[0])
    vt0, rt0 = P.INITIAL_VIRTUAL_TOKENS, P.INITIAL_REAL_TOKENS
    return vq0 * vt0 // (vt0 - rt0) - vq0


def find_trigger(tape: Tape, rows: pd.DataFrame, threshold, create: Optional[dict], st: str):
    """First curve trade whose real quote reaches the threshold (PREREG §4). Returns (row position, censored).
    The first crossing is only known when an earlier state below the threshold is on the tape in the same covered
    run of slots: an earlier trade, or the create (OQ-2). Otherwise the trigger is left-censored."""
    real = real_progress(rows, st)
    th = threshold if st == "sol" else threshold(rows)
    hit = np.flatnonzero(real >= th)
    if len(hit) == 0:
        return None, False
    i = int(hit[0])
    slot = int(rows["slot"].iloc[i])
    seg = tape.segment_of(slot)
    if i > 0 and tape.segment_of(int(rows["slot"].iloc[i - 1])) == seg:
        return i, False
    if create is not None and int(create["slot"]) <= slot and tape.segment_of(int(create["slot"])) == seg:
        return i, False
    return i, True


def s0_progress(mint: str, day: str) -> float:
    """PREREG §5: uniform progress in [50%, 80%] from a fixed seed, one draw per (day, mint), order-free."""
    h = hashlib.sha256(f"{P.S0_SEED}|{day}|{mint}".encode()).digest()
    u = int.from_bytes(h[:8], "big") / 2 ** 64
    lo, hi = P.S0_PROGRESS_RANGE
    return lo + (hi - lo) * u


def decisions(tape: Tape, log=print) -> pd.DataFrame:
    """All decisions: G1 at 90% (primary) and the secondary 80% and 95% triggers, S0 controls, and the
    amendment 2 §3 non-SOL strata triggers (descriptive only, never traded)."""
    creates = create_index(tape)
    out = []
    mints = list(tape._curve_off.keys())
    for k, mint in enumerate(mints):
        rows = tape.curve_of(mint)
        cr = creates.get(mint)
        qm = rows["quote_mint"].dropna()
        st0 = stratum(qm.iloc[0]) if len(qm) else (stratum(cr.get("quote_mint")) if cr else None)
        if st0 is None:
            continue
        specs = [("G1", P.TRIGGER_FRACTION)] + [(f"G1@{int(f * 100)}", f) for f in P.SECONDARY_TRIGGERS]
        for kind, frac in specs:
            if st0 == "sol":
                th = P.trigger_lamports(frac)
            else:
                if kind != "G1":
                    continue
                th = (lambda r, f=frac: math.ceil(f * quote_target(r)))
            rec = _decision(tape, rows, cr, mint, kind, frac, th, st0)
            if rec is None:
                continue
            out.append(rec)
            if kind == "G1" and rec["stratum"] == "sol" and rec["reason"] == "" and not rec["censored"]:
                p = s0_progress(rec["mint"], rec["day"])
                s0 = _decision(tape, rows, cr, mint, "S0", p, P.trigger_lamports(p), "sol")
                if s0 is not None:
                    s0["s0_progress"] = p
                    out.append(s0)
    df = pd.DataFrame(out)
    if len(df):
        df = df.sort_values(["t0", "t0_tx", "kind"]).reset_index(drop=True)
    log(f"  decisions: {len(df)} rows")
    return df


def _decision(tape: Tape, rows, cr, mint, kind, frac, th, st0):
    i, censored = find_trigger(tape, rows, th, cr, st0)
    if i is None:
        return None
    r = rows.iloc[i]
    t0 = int(r["slot"])
    upto = rows.iloc[: i + 1]
    create = cr if (cr is not None and int(cr["slot"]) <= t0) else None
    st, reason = flags_asof(upto, create)
    return {
        "kind": kind, "fraction": frac, "mint": tape.names.name(mint), "mint_c": mint, "stratum": st or st0,
        "reason": reason, "censored": censored, "t0": t0, "t0_tx": int(r["tx_idx"]), "t0_time": int(r["block_time"]),
        "real_at_t0": int(real_progress(upto.iloc[[-1]], st0)[0]),
        "price_t0": float(r["virtual_quote_reserves"] if st0 != "sol" else r["virtual_sol_reserves"]) / max(int(r["virtual_token_reserves"]), 1),
        "day": tape.day_of(t0), "create_slot": int(create["slot"]) if create else -1,
        "token_program": (create or {}).get("token_program", ""), "creator": (create or {}).get("creator", ""),
        "create_user": (create or {}).get("user", ""), "name": (create or {}).get("name", ""),
        "symbol": (create or {}).get("symbol", ""), "bonding_curve": (create or {}).get("bonding_curve", ""),
    }


def timing(tape: Tape, d: pd.DataFrame) -> pd.DataFrame:
    """Entry slot and time, the exit-B slot and the drop-by-time rule (PREREG §2): a decision whose window
    (entry + 30 min + exit delay D) ends after the last slot of its covered run of slots is dropped before any
    outcome is read. Reads only block times and coverage."""
    d = d.copy()
    ent, ent_t, xb, wend, drop = [], [], [], [], []
    for t0 in d["t0"].to_numpy():
        e = int(t0) + P.D
        seg = tape.segment_of(int(t0))
        es = tape.first_produced_at_or_after(e)
        et = tape.time_of(es) if es is not None else None
        b = tape.first_slot_at_time(et + P.EXIT_B_SECONDS) if et is not None else None
        end = (b + P.D) if b is not None else None
        ent.append(e)
        ent_t.append(et if et is not None else -1)
        xb.append(b if b is not None else -1)
        wend.append(end if end is not None else -1)
        drop.append(end is None or seg is None or end > seg[1])
    d["entry_slot"], d["entry_time"], d["exitB_slot"], d["window_end"], d["dropped_by_time"] = ent, ent_t, xb, wend, drop
    return d
