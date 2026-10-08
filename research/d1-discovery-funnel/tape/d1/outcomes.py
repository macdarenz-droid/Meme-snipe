"""Outcome stage (separate from features; the feature code never imports this module).

For each eligible decision point and hold arm whose window is inside the tape (universe.py timing):
- Entry: a buy of $50 (SPEND_LAMPORTS) with buy_exact_quote_in at slot E = d + 23. Price: the worse (fewer tokens) of
  the pool state at the start and at the end of slot E (CONSERVATIVE, as H1-CGO §6 and G1 §4; the PREREG is silent).
- Exit: sell all tokens at the exit slot X, the worse (less SOL) of the start and end states of X.
- Fees from the fee fields of the pool row whose state is used; impact on effective reserves; the sell capped by the
  real vault.
- net_ret = (SOL received - SOL paid - fixed costs) / SOL paid; fixed costs as edge-costs.ts with the rent of the
  account the mint needs at the rate in force at the entry slot (AMENDMENT_1 item 11, AMENDMENT_2: (128 + 170 or 165
  bytes) x 6,960 / 6,333 / 5,080 lamports per byte; a mint without a create row on the tape counts as 170 bytes).
- rt_cost = the zero-move round trip at entry (buy, then sell the same tokens into the post-buy pool, plus fixed
  costs) / SOL paid, as edge-costs.ts `costRow`. Its median over the discovery trades is PREREG §5's cost hurdle.
"""
import numpy as np
import pandas as pd

from . import config as C
from .costs import buy_exact_quote_in, fixed_for, sell
from .pool_state import PoolBook


def _worse_buy(book, pool, slot, spend):
    i_end = int(book.idx_le(pool, slot))
    i_start = int(book.idx_lt(pool, slot))
    fills = [f for f in (buy_exact_quote_in(book.state(pool, i), spend) for i in {i_start, i_end} if i >= 0) if f]
    if not fills:
        return None
    return min(fills, key=lambda f: (f.base, -f.user))


def _worse_sell(book, pool, slot, base):
    i_end = int(book.idx_le(pool, slot))
    i_start = int(book.idx_lt(pool, slot))
    fills = [f for f in (sell(book.state(pool, i), base) for i in {i_start, i_end} if i >= 0) if f]
    if not fills:
        return None
    return min(fills, key=lambda f: f.user)


def _sized(book, p, size_usd, fixed, rec):
    """H8_AMENDMENT: the same entry and exits at another trade size (net_ret_<h>_s<usd>); reporting only."""
    spend = int((size_usd / C.SOL_USD) * 1e9)
    buy = _worse_buy(book, p.pool, int(p.entry_slot), spend)
    if buy is None:
        return
    for h in C.HOLDS_S:
        tag = h // 60
        if not getattr(p, f"valid_{tag}"):
            continue
        s = _worse_sell(book, p.pool, int(getattr(p, f"exit_slot_{tag}")), buy.base)
        if s is not None:
            rec[f"net_ret_{tag}_s{size_usd}"] = (s.user - buy.user - fixed) / buy.user


def compute_outcomes(book: PoolBook, pts: pd.DataFrame, token_programs: dict = None,
                     spend: int = C.SPEND_LAMPORTS) -> pd.DataFrame:
    """token_programs: mint code -> token program id (from CreateEvent); a mint not in it pays the larger rent."""
    token_programs = token_programs or {}
    el = pts[pts.eligible]
    rows = []
    for ix, p in zip(el.index, el.itertuples(index=False)):
        rec = {"pool": p.pool, "tau": p.tau}
        fixed = fixed_for(token_programs.get(int(p.mint)), int(p.entry_slot), int(p.entry_time))
        rec["fixed"] = fixed
        buy = _worse_buy(book, p.pool, int(p.entry_slot), spend)
        if buy is None:
            rec["entry_ok"] = False
            rows.append((ix, rec))
            continue
        rec["entry_ok"] = True
        rec["paid"] = buy.user
        rec["tokens"] = buy.base
        rt = sell(buy.after, buy.base)
        rec["rt_cost"] = (buy.user - (rt.user if rt else 0) + fixed) / buy.user
        for h in C.HOLDS_S:
            tag = h // 60
            if not getattr(p, f"valid_{tag}"):
                continue
            s = _worse_sell(book, p.pool, int(getattr(p, f"exit_slot_{tag}")), buy.base)
            if s is None:
                continue
            rec[f"recv_{tag}"] = s.user
            rec[f"capped_{tag}"] = s.capped
            rec[f"net_ret_{tag}"] = (s.user - buy.user - fixed) / buy.user
            rec[f"net_ret_{tag}_s{C.SIZE_USD}"] = rec[f"net_ret_{tag}"]
        for size in C.H8_SIZES_USD:
            if size != C.SIZE_USD:
                _sized(book, p, size, fixed, rec)
        rows.append((ix, rec))
    cols = ["pool", "tau", "entry_ok", "fixed", "paid", "tokens", "rt_cost"] + [
        f"{k}_{h // 60}" for h in C.HOLDS_S for k in ("recv", "capped", "net_ret")] + [
        f"net_ret_{h // 60}_s{s}" for h in C.HOLDS_S for s in C.H8_SIZES_USD]
    if not rows:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame([r for _, r in rows], index=[i for i, _ in rows])
    for c in cols:
        if c not in out.columns:
            out[c] = np.nan
    return out[cols]
