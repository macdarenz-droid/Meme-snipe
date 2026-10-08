"""§4 cost basis per (mint, owner), average-cost method.

Each owner holds three parts: known-cost tokens with their total cost in lamports, and unknown-cost tokens.
- buy: adds tokens and the SOL paid, fees included, to the known part;
- sell, burn: remove tokens and a proportional share of each part (known tokens with their share of cost);
- transfer: moves tokens and the sender's proportional share of each part to the receiver;
- mint, or tokens an owner sends beyond what the ledger shows it holding: unknown cost.
Known-cost tokens are also split by origin: `post` = bought at or after migration (secondary §10 only).
"""
from dataclasses import dataclass, field


@dataclass
class Holding:
    known: int = 0  # known-cost tokens (raw units)
    cost: float = 0.0  # lamports, cost of the known tokens
    unknown: int = 0  # unknown-cost tokens
    post_known: int = 0  # known tokens bought at or after migration (subset of known)
    post_cost: float = 0.0
    bought_pre: bool = False  # any buy before migration (curve)
    bought_post: bool = False  # any buy at or after migration

    @property
    def total(self) -> int:
        return self.known + self.unknown


@dataclass
class Ledger:
    h: dict = field(default_factory=dict)
    overdraw_events: int = 0  # outflows larger than the holding the ledger shows
    overdraw_tokens: int = 0

    def get(self, owner: str) -> Holding:
        x = self.h.get(owner)
        if x is None:
            x = self.h[owner] = Holding()
        return x

    def buy(self, owner: str, tokens: int, cost: int, post_migration: bool):
        if tokens <= 0:
            return
        x = self.get(owner)
        x.known += tokens
        x.cost += cost
        if post_migration:
            x.post_known += tokens
            x.post_cost += cost
            x.bought_post = True
        else:
            x.bought_pre = True

    def _take(self, owner: str, tokens: int):
        """Remove `tokens` proportionally; returns (known, cost, unknown, post_known, post_cost, excess)."""
        x = self.get(owner)
        tot = x.total
        excess = 0
        if tokens > tot:
            excess = tokens - tot
            self.overdraw_events += 1
            self.overdraw_tokens += excess
            tokens = tot
        if tokens == 0:
            return 0, 0.0, 0, 0, 0.0, excess
        if tokens == tot:
            out = (x.known, x.cost, x.unknown, x.post_known, x.post_cost, excess)
            x.known, x.cost, x.unknown, x.post_known, x.post_cost = 0, 0.0, 0, 0, 0.0
            return out
        k = tokens * x.known // tot
        u = tokens - k  # <= unknown, since ceil(tokens*unknown/tot) <= unknown
        c = x.cost * k / x.known if x.known else 0.0
        pk = k * x.post_known // x.known if x.known else 0
        pc = x.post_cost * pk / x.post_known if x.post_known else 0.0
        x.known -= k
        x.cost -= c
        x.unknown -= u
        x.post_known -= pk
        x.post_cost -= pc
        if x.known == 0:
            x.cost = 0.0
        if x.post_known == 0:
            x.post_cost = 0.0
        return k, c, u, pk, pc, excess

    def sell(self, owner: str, tokens: int):
        self._take(owner, tokens)

    def burn(self, owner: str, tokens: int):
        self._take(owner, tokens)

    def mint(self, owner: str, tokens: int):
        if tokens > 0:
            self.get(owner).unknown += tokens

    def transfer(self, frm: str, to: str, tokens: int):
        if tokens <= 0 or frm == to:
            return
        k, c, u, pk, pc, excess = self._take(frm, tokens)
        y = self.get(to)
        y.known += k
        y.cost += c
        y.unknown += u + excess
        y.post_known += pk
        y.post_cost += pc

    def balance(self, owner: str) -> int:
        x = self.h.get(owner)
        return x.total if x else 0
