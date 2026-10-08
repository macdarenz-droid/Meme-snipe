"""§6 outcome stage: prices each scheduled trade on the canonical pool. Separate from the features: it reads the
decision table (keys and slots only) and the pool's trade rows, and the feature code never imports it.

Entry: buy_exact_quote_in of the size at slot E = decision slot + D, on the worse (fewer tokens) of the pool state at
the start and at the end of slot E. Exit: sell all tokens at the scheduled exit slot, on the worse (less SOL) of the
two states. Costs in lamports: venue fees and impact on both legs (from the quotes) plus the fixed costs of
edge-costs.ts (pumpswap.expected_fixed)."""
import bisect

import pandas as pd

from . import tapeio
from .constants import D_SLOTS, DEFAULT_KEY, HOLD_S, SECONDARY_HOLDS_S, SECONDARY_SIZES_USD, TRADE_USD, spend_of
from .pumpswap import amm_post_state, buy_exact_quote_in, expected_fixed, load_tiers, sell, token_account_rent

BOOK_COLS = ["slot", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "pool", "side", "base_amount", "quote_amount",
             "quote_amount_lp_adjusted", "lp_fee", "pool_base_token_reserves", "pool_quote_token_reserves",
             "virtual_quote_reserves", "base_supply", "coin_creator", "last_in_tx", "chain_pool_quote"]


class Book:
    """One pool's trades in order: per row (slot, pre, post, base_supply, creator_charged). `lo`..`hi` is the slot range
    the rows were loaded from; a state outside it is refused, never extrapolated."""

    def __init__(self, rows, lo: int, hi: int):
        self.rows = rows
        self.slots = [r[0] for r in rows]
        self.lo, self.hi = lo, hi

    def _guard(self, slot):
        if not (self.lo <= slot <= self.hi):
            raise ValueError(f"slot {slot} is outside the loaded range {self.lo}..{self.hi}")

    def start(self, slot):
        """Pool state at the start of `slot`: post-state of the last trade before it (= the pre-state of the slot's
        first trade)."""
        self._guard(slot)
        k = bisect.bisect_left(self.slots, slot)
        if k < len(self.rows) and self.slots[k] == slot:
            r = self.rows[k]
            return r[1], r[3], r[4]
        if k == 0:
            return None
        r = self.rows[k - 1]
        return r[2], r[3], r[4]

    def end(self, slot):
        """Pool state at the end of `slot`: post-state of the last trade at or before it."""
        self._guard(slot)
        k = bisect.bisect_right(self.slots, slot)
        if k == 0:
            return None
        r = self.rows[k - 1]
        return r[2], r[3], r[4]


def books_from_rows(amm: pd.DataFrame, lo: int, hi: int) -> dict:
    def k(r):
        return (int(r["slot"]), int(r["tx_idx"]), int(r["outer_ix"] or 0), int(r["inner_ix"] or -1), int(r["ev_idx"] or -1))
    by = {}
    for r in sorted(amm.to_dict("records"), key=k):
        pre, post = amm_post_state(r)
        supply = int(r["base_supply"]) if r["base_supply"] else None
        charged = r["coin_creator"] != DEFAULT_KEY  # empty: charged (the dearer reading)
        by.setdefault(r["pool"], []).append((int(r["slot"]), pre, post, supply, charged))
    return {p: Book(v, lo, hi) for p, v in by.items()}


def load_books(units, pools) -> dict:
    pools = set(pools)
    fs = []
    for u in sorted(units, key=lambda x: x.from_slot):
        a = tapeio.read_table(u, "S_amm", BOOK_COLS)
        fs.append(a[a.pool.isin(pools)])
    iv = tapeio.coverage_intervals(units)
    if len(iv) != 1:
        raise ValueError(f"outcome units are not one contiguous range: {iv}")
    return books_from_rows(pd.concat(fs, ignore_index=True) if fs else pd.DataFrame(columns=BOOK_COLS), iv[0][0], iv[0][1])


def price_trade(book: Book, entry_slot: int, exit_slot: int, spend: int, tiers, fixed: float) -> dict:
    out = dict(status="ok", paid=0, tokens=0, received=0, entry_fees=0, exit_fees=0, entry_impact=0, exit_impact=0,
               fixed=fixed, gross=float("nan"), net_lamports=float("nan"), net_ret=float("nan"), cost_ret=float("nan"))
    a, b = book.start(entry_slot), book.end(entry_slot)
    if a is None or b is None:
        out["status"] = "no_entry_state"
        return out
    buys = [(buy_exact_quote_in(s, spend, tiers, sup, ch), s) for s, sup, ch in (a, b) if sup]
    if len(buys) < 2 or not all(t.ok for t, _ in buys):
        out["status"] = "entry_refused"  # the worse state refuses: no trade
        return out
    bt, bs = min(buys, key=lambda x: x[0].base)
    c, d = book.start(exit_slot), book.end(exit_slot)
    sells = [(sell(s, bt.base, tiers, sup, ch), s) for s, sup, ch in (c, d) if sup]
    out.update(paid=bt.user_quote, tokens=bt.base, entry_fees=bt.fees, entry_impact=bt.impact)
    if len(sells) < 2 or not all(t.ok for t, _ in sells):
        out["status"] = "exit_refused"  # the worse state cannot pay: counted as receiving nothing
        st, ss = None, (c or d)[0]
    else:
        st, ss = min(sells, key=lambda x: x[0].user_quote)
        out.update(received=st.user_quote, exit_fees=st.fees, exit_impact=st.impact)
    out["gross"] = ss.mid() / bs.mid() - 1
    out["net_lamports"] = out["received"] - out["paid"] - fixed
    out["net_ret"] = out["net_lamports"] / out["paid"]
    out["cost_ret"] = (out["entry_fees"] + out["exit_fees"] + out["entry_impact"] + out["exit_impact"] + fixed) / out["paid"]
    return out


def run(decisions: pd.DataFrame, books: dict, tiers=None) -> pd.DataFrame:
    """Prices every eligible decision point that is in time for the hold: the registered $50 / 60 min trade, the
    secondary holds at $50 and the secondary sizes at 60 min (§10)."""
    tiers = tiers or load_tiers()
    plan = [(HOLD_S, TRADE_USD)] + [(h, TRADE_USD) for h in SECONDARY_HOLDS_S] + [(HOLD_S, s) for s in SECONDARY_SIZES_USD]
    out = []
    dec = decisions[decisions.eligible]
    for r in dec.itertuples(index=False):
        book = books.get(r.pool)
        fixed = expected_fixed(token_account_rent(getattr(r, "token_program", "") or ""))  # AMENDMENT_1 rent
        for hold, usd in plan:
            if not getattr(r, f"in_time_{hold}"):
                continue
            row = dict(mint=r.mint, pool=r.pool, hour=r.hour, decision_slot=r.decision_slot, decision_day=r.decision_day,
                       hold=hold, usd=usd, entry_slot=r.decision_slot + D_SLOTS, exit_slot=getattr(r, f"exit_slot_{hold}"))
            if book is None:
                row.update(status="no_book")
            else:
                row.update(price_trade(book, row["entry_slot"], row["exit_slot"], spend_of(usd), tiers, fixed))
            out.append(row)
    return pd.DataFrame(out)
