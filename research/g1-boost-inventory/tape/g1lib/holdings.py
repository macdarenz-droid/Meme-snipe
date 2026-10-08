"""Per-(mint, owner) token holdings with average cost (H1-CGO §4 method), replayed in tape order up to a slot.

Events of one mint, in (slot, tx_idx, outer_ix, inner_ix, ev_idx) order:
- a curve or pool buy adds its tokens and the SOL the owner paid, fees included;
- a sell removes tokens and a proportional share of cost;
- a T transfer moves tokens and a proportional share of the sender's cost (tokens the sender is not known to hold
  arrive as unknown cost); a T mint adds unknown-cost tokens; a T burn removes tokens;
- after each transaction, a trade owner's balance is set to the tape's `owner_token_post` (all their accounts),
  so a movement the tape does not list cannot drift the book; any excess is unknown cost.
"""
from dataclasses import dataclass
from typing import Dict, Optional

import numpy as np
import pandas as pd


@dataclass
class Lot:
    tokens: float = 0.0
    known: float = 0.0      # tokens with known cost
    cost: float = 0.0       # SOL (lamports) paid for the known tokens

    def take(self, x: float):
        """Removes x tokens proportionally; returns (known, cost) removed."""
        if self.tokens <= 0 or x <= 0:
            return 0.0, 0.0
        f = min(1.0, x / self.tokens)
        k, c = self.known * f, self.cost * f
        self.tokens -= self.tokens * f
        self.known -= k
        self.cost -= c
        return k, c


class Book:
    def __init__(self, exclude=()):
        self.lots: Dict[int, Lot] = {}
        self.exclude = set(x for x in exclude if x is not None and x >= 0)
        self.first_buy: Dict[int, int] = {}

    def lot(self, o: int) -> Lot:
        lt = self.lots.get(o)
        if lt is None:
            lt = self.lots[o] = Lot()
        return lt

    def buy(self, o, tokens, cost, slot):
        if o < 0:
            return
        lt = self.lot(o)
        lt.tokens += tokens
        lt.known += tokens
        lt.cost += cost
        self.first_buy.setdefault(o, slot)

    def sell(self, o, tokens):
        if o >= 0:
            self.lot(o).take(tokens)

    def transfer(self, a, b, tokens):
        # The sender gives up a proportional share of its known tokens and cost; any shortfall (tokens the sender
        # was not known to hold) arrives at the receiver as unknown cost.
        k, c = self.lot(a).take(tokens) if a >= 0 else (0.0, 0.0)
        if b >= 0:
            lt = self.lot(b)
            lt.tokens += tokens
            lt.known += k
            lt.cost += c

    def mint(self, b, tokens):
        if b >= 0:
            self.lot(b).tokens += tokens

    def set_balance(self, o, bal):
        if o < 0 or bal < 0:
            return
        lt = self.lot(o)
        if bal > lt.tokens:
            lt.tokens = float(bal)
        elif bal < lt.tokens:
            lt.take(lt.tokens - bal)

    def holders(self, min_tokens: float = 0.5) -> Dict[int, Lot]:
        return {o: lt for o, lt in self.lots.items() if o not in self.exclude and lt.tokens >= min_tokens}


def mint_events(curve_rows: pd.DataFrame, t_rows: pd.DataFrame, pool_rows: Optional[pd.DataFrame] = None) -> pd.DataFrame:
    """One ordered event table for a mint."""
    parts = []
    if len(curve_rows):
        c = curve_rows
        parts.append(pd.DataFrame({
            "slot": c["slot"].to_numpy(), "tx_idx": c["tx_idx"].to_numpy(), "outer_ix": c["outer_ix"].to_numpy(),
            "inner_ix": c["inner_ix"].to_numpy(), "ev_idx": c["ev_idx"].to_numpy(),
            "kind": np.where(c["is_buy"].to_numpy() == 1, "buy", "sell"), "a": c["owner"].to_numpy(),
            "b": np.full(len(c), -1), "tokens": c["token_amount"].to_numpy().astype(float),
            "cost": (c["sol_amount"] + c["fee"].clip(lower=0) + c["creator_fee"].clip(lower=0)).to_numpy().astype(float),
            "post": c["owner_token_post"].to_numpy()}))
    if pool_rows is not None and len(pool_rows):
        p = pool_rows
        buy = (p["side"] == "buy").to_numpy()
        paid = (p["quote_amount_lp_adjusted"] + p["protocol_fee"].clip(lower=0) + p["coin_creator_fee"].clip(lower=0)).to_numpy()
        parts.append(pd.DataFrame({
            "slot": p["slot"].to_numpy(), "tx_idx": p["tx_idx"].to_numpy(), "outer_ix": p["outer_ix"].to_numpy(),
            "inner_ix": p["inner_ix"].to_numpy(), "ev_idx": p["ev_idx"].to_numpy(),
            "kind": np.where(buy, "buy", "sell"), "a": p["owner"].to_numpy(), "b": np.full(len(p), -1),
            "tokens": p["base_amount"].to_numpy().astype(float), "cost": paid.astype(float),
            "post": np.full(len(p), -1)}))
    if len(t_rows):
        t = t_rows
        kind = t["kind"].fillna("").to_numpy()
        parts.append(pd.DataFrame({
            "slot": t["slot"].to_numpy(), "tx_idx": t["tx_idx"].to_numpy(), "outer_ix": t["outer_ix"].to_numpy(),
            "inner_ix": t["inner_ix"].to_numpy(), "ev_idx": np.zeros(len(t), dtype=np.int64),
            "kind": np.where(kind == "transfer", "transfer", np.where(kind == "mint", "mint", np.where(kind == "burn", "burn", "other"))),
            "a": t["from_owner"].to_numpy(), "b": t["to_owner"].to_numpy(), "tokens": t["amount"].to_numpy().astype(float),
            "cost": np.zeros(len(t)), "post": np.full(len(t), -1)}))
    if not parts:
        return pd.DataFrame(columns=["slot", "tx_idx", "outer_ix", "inner_ix", "ev_idx", "kind", "a", "b", "tokens", "cost", "post"])
    ev = pd.concat(parts, ignore_index=True)
    return ev.sort_values(["slot", "tx_idx", "outer_ix", "inner_ix", "ev_idx"], kind="stable").reset_index(drop=True)


def replay(events: pd.DataFrame, upto_slot: int, exclude=(), book: Optional[Book] = None, start: int = 0):
    """Applies events with slot <= upto_slot (from position `start`). Returns (book, next position)."""
    book = book or Book(exclude)
    n = len(events)
    i = start
    slots = events["slot"].to_numpy()
    txs = events["tx_idx"].to_numpy()
    kinds = events["kind"].to_numpy()
    a_, b_ = events["a"].to_numpy(), events["b"].to_numpy()
    tok, cost, post = events["tokens"].to_numpy(), events["cost"].to_numpy(), events["post"].to_numpy()
    while i < n and slots[i] <= upto_slot:
        j = i
        snap = {}
        while j < n and slots[j] == slots[i] and txs[j] == txs[i]:
            k = kinds[j]
            if k == "buy":
                book.buy(int(a_[j]), tok[j], cost[j], int(slots[j]))
                if post[j] >= 0:
                    snap[int(a_[j])] = int(post[j])
            elif k == "sell":
                book.sell(int(a_[j]), tok[j])
                if post[j] >= 0:
                    snap[int(a_[j])] = int(post[j])
            elif k == "transfer":
                book.transfer(int(a_[j]), int(b_[j]), tok[j])
            elif k == "mint":
                book.mint(int(b_[j]), tok[j])
            elif k == "burn":
                book.sell(int(a_[j]), tok[j])
            j += 1
        for o, bal in snap.items():
            book.set_balance(o, bal)
        i = j
    return book, i
