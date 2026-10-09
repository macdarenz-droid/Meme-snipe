"""§6 outcome stage: prices each scheduled trade on the canonical pool. Separate from the features: it reads the
decision table (keys and slots only) and the pool's trade rows, and the feature code never imports it.

Entry: buy_exact_quote_in of the size at slot E = decision slot + D, on the worse (fewer tokens) of the pool state at
the start and at the end of slot E. Exit: sell all tokens at the scheduled exit slot, on the worse (less SOL) of the
two states. Costs in lamports: venue fees and impact on both legs (from the quotes) plus the fixed costs of
edge-costs.ts (pumpswap.expected_fixed)."""
import bisect

import numpy as np

import pandas as pd

from . import tapeio
from .constants import D_SLOTS, DEFAULT_KEY, HOLD_S, SECONDARY_HOLDS_S, SECONDARY_SIZES_USD, TRADE_USD, spend_of
from .pumpswap import Pool, amm_post_state, buy_exact_quote_in, expected_fixed, load_tiers, sell, token_account_rent

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


def _book_key(r):
    return (int(r["slot"]), int(r["tx_idx"]), int(r["outer_ix"] or 0), int(r["inner_ix"] or -1), int(r["ev_idx"] or -1))


def books_from_rows(amm: pd.DataFrame, lo: int, hi: int) -> dict:
    k = _book_key
    by = {}
    for r in sorted(amm.to_dict("records"), key=k):
        pre, post = amm_post_state(r)
        supply = int(r["base_supply"]) if r["base_supply"] else None
        charged = r["coin_creator"] != DEFAULT_KEY  # empty: charged (the dearer reading)
        by.setdefault(r["pool"], []).append((int(r["slot"]), pre, post, supply, charged))
    return {p: Book(v, lo, hi) for p, v in by.items()}


def load_books(units, pools, lowmem: bool = False) -> dict:
    pools = set(pools)
    iv = tapeio.coverage_intervals(units)
    if lowmem:
        if len(iv) != 1:
            raise ValueError(f"outcome units are not one contiguous range: {iv}")
        return _books_lowmem(units, pools, iv[0][0], iv[0][1])
    fs = []
    for u in sorted(units, key=lambda x: x.from_slot):
        a = tapeio.read_table(u, "S_amm", BOOK_COLS)
        fs.append(a[a.pool.isin(pools)])
    if len(iv) != 1:
        raise ValueError(f"outcome units are not one contiguous range: {iv}")
    return books_from_rows(pd.concat(fs, ignore_index=True) if fs else pd.DataFrame(columns=BOOK_COLS), iv[0][0], iv[0][1])


# ---------------------------------------------------------------- low-memory books (same states as books_from_rows)

class _Rows:
    """Book rows held as int64 columns; row k is the tuple books_from_rows builds: (slot, pre, post, supply,
    creator_charged)."""

    def __init__(self, a):
        self.a = a

    def __len__(self):
        return len(self.a["slot"])

    def __getitem__(self, k):
        a = self.a
        sup = None if a["no_supply"][k] else int(a["supply"][k])
        return (int(a["slot"][k]), Pool(int(a["pb"][k]), int(a["pv"][k]), int(a["pq"][k])),
                Pool(int(a["qb"][k]), int(a["qv"][k]), int(a["qq"][k])), sup, bool(a["charged"][k]))


class CompactBook(Book):
    def __init__(self, a: dict, lo: int, hi: int):
        self.rows = _Rows(a)
        self.slots = a["slot"]  # int64, ascending: bisect reads it as Book does
        self.lo, self.hi = lo, hi


_BOOK_FIELDS = ("slot", "tx", "outer", "inner", "ev", "pb", "pv", "pq", "qb", "qv", "qq", "supply")


def _book_chunk(df: pd.DataFrame) -> dict:
    cols = {f: [] for f in _BOOK_FIELDS}
    nosup, charged, pool = [], [], []
    for r in df.to_dict("records"):
        key = _book_key(r)
        pre, post = amm_post_state(r)
        for f, v in zip(_BOOK_FIELDS, key + (pre.base, pre.vault, pre.virtual, post.base, post.vault, post.virtual)):
            cols[f].append(v)
        cols["supply"].append(int(r["base_supply"]) if r["base_supply"] else 0)
        nosup.append(not r["base_supply"])
        charged.append(r["coin_creator"] != DEFAULT_KEY)  # empty: charged (the dearer reading)
        pool.append(r["pool"])
    out = {f: np.array(v, dtype=np.int64) for f, v in cols.items()}  # an int64 overflow raises, never wraps
    out.update(no_supply=np.array(nosup, dtype=bool), charged=np.array(charged, dtype=bool),
               pool=np.array(pool, dtype=object))
    return out


def _books_lowmem(units, pools, lo, hi) -> dict:
    parts = []
    for u in sorted(units, key=lambda x: x.from_slot):
        for a in tapeio.read_table_chunks(u, "S_amm", BOOK_COLS):
            a = a[a.pool.isin(pools)]
            if len(a):
                parts.append(_book_chunk(a))
    if not parts:
        return {}
    allc = {f: np.concatenate([p[f] for p in parts]) for f in parts[0]}
    del parts
    codes, uniq = pd.factorize(allc.pop("pool"), sort=False)
    out = {}
    order = np.lexsort((np.arange(len(codes)), codes))  # rows of each pool, in read order
    bounds = np.searchsorted(codes[order], np.arange(len(uniq) + 1))
    for c, p in enumerate(uniq):
        ix = order[bounds[c]:bounds[c + 1]]
        o = ix[np.lexsort((np.arange(len(ix)), allc["ev"][ix], allc["inner"][ix], allc["outer"][ix], allc["tx"][ix],
                           allc["slot"][ix]))]  # sorted() by key, stable
        a = {f: allc[f][o] for f in ("slot", "pb", "pv", "pq", "qb", "qv", "qq", "supply", "no_supply", "charged")}
        out[p] = CompactBook(a, lo, hi)
    return out


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
        tp = getattr(r, "token_program", "")
        tp = tp if isinstance(tp, str) else ""
        fixed = expected_fixed(token_account_rent(tp, r.decision_slot + D_SLOTS))  # AMENDMENT_2: rate at the entry slot
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


# ---------------------------------------------------------------- AMENDMENT_3 gate flows (forward; Step A only)

FLOW_COLS = ["slot", "pool", "side", "base_amount", "quote_amount_lp_adjusted", "protocol_fee", "coin_creator_fee",
             "user_quote_amount", "protocol", "signature", "outer_ix"]


def flows(decisions: pd.DataFrame, amm: pd.DataFrame, boosts=frozenset()) -> pd.DataFrame:
    """Per eligible decision point whose flow window is in time: the pool's swaps in (decision slot, flow_end_slot]
    (the hour after the decision): tokens sold, SOL paid by buyers (fees included) and SOL received by sellers.
    Protocol and BOOST swaps are left out."""
    return _flow_windows(decisions, _flow_prep(amm, boosts))


def _flow_prep(amm: pd.DataFrame, boosts=frozenset()) -> pd.DataFrame:
    a = amm[amm.protocol.isin(["", "0"])]
    a = a[[k not in boosts for k in zip(a.signature, a.outer_ix, a.pool)]]
    a = a.assign(slot=a.slot.astype("int64"), sell_tok=(a.side == "sell") * a.base_amount.astype("int64"),
                 buy_sol=(a.side == "buy") * (a.quote_amount_lp_adjusted.astype("int64") + a.protocol_fee.astype("int64")
                                              + a.coin_creator_fee.astype("int64")),
                 sell_sol=(a.side == "sell") * a.user_quote_amount.astype("int64"))
    return a


def _flow_windows(decisions: pd.DataFrame, a: pd.DataFrame) -> pd.DataFrame:
    by = {p: g.sort_values("slot") for p, g in a.groupby("pool")}
    out = []
    d = decisions[decisions.eligible & decisions.in_time_flow]
    for r in d.itertuples(index=False):
        g = by.get(r.pool)
        row = dict(mint=r.mint, pool=r.pool, decision_slot=r.decision_slot, decision_day=r.decision_day,
                   sell_tokens=0, buy_sol=0, sell_sol=0)
        if g is not None:
            s = g.slot.to_numpy()
            i, j = np.searchsorted(s, r.decision_slot, "right"), np.searchsorted(s, r.flow_end_slot, "right")
            w = g.iloc[i:j]
            row.update(sell_tokens=int(w.sell_tok.sum()), buy_sol=int(w.buy_sol.sum()), sell_sol=int(w.sell_sol.sum()))
        out.append(row)
    f = pd.DataFrame(out, columns=["mint", "pool", "decision_slot", "decision_day", "sell_tokens", "buy_sol", "sell_sol"])
    f["net_flow_sol"] = f.buy_sol - f.sell_sol
    return f


def load_flows(units, decisions, lowmem: bool = False) -> pd.DataFrame:
    pools = set(decisions[decisions.eligible].pool)
    if lowmem:  # the same rows, reduced chunk by chunk to the columns the windows read
        boosts, parts = tapeio.read_boost_keys(units), []
        keep = ["pool", "slot", "sell_tok", "buy_sol", "sell_sol"]
        for u in sorted(units, key=lambda x: x.from_slot):
            for x in tapeio.read_table_chunks(u, "S_amm", FLOW_COLS):
                x = x[x.pool.isin(pools)]
                x = x[x.protocol.isin(["", "0"])]
                if len(x):  # (_flow_prep on a frame with no rows left loses its columns, as flows() does)
                    parts.append(_flow_prep(x, boosts)[keep])
        if not parts:  # no non-protocol row at all: exactly what flows() does with such a frame
            return flows(decisions, pd.DataFrame(columns=FLOW_COLS), boosts)
        return _flow_windows(decisions, pd.concat(parts, ignore_index=True))
    fs = []
    for u in sorted(units, key=lambda x: x.from_slot):
        x = tapeio.read_table(u, "S_amm", FLOW_COLS)
        fs.append(x[x.pool.isin(pools)])
    amm = pd.concat(fs, ignore_index=True) if fs else pd.DataFrame(columns=FLOW_COLS)
    return flows(decisions, amm, tapeio.read_boost_keys(units))
