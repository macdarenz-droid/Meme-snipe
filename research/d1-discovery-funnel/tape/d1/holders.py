"""Holder features as of the decision slot: top-10 share, creator share, H1-CGO's CGO and its coverage.

Holder rebuild (docs/research/historical-data.md "Holder rebuild"): swaps move tokens of `user_token_owner` (curve and
canonical-pool rows); token movements (T) move them between `from_owner` and `to_owner` (a burn only removes, a mint
only adds). Rows with an empty owner are left out.

Cost basis (H1-CGO §4, average cost): a buy adds tokens and the SOL paid, fees included (curve: sol_amount + fee +
creator_fee; PumpSwap: user_quote_amount); a sell or burn removes tokens and a proportional share of cost; a transfer
moves tokens and a proportional share of the sender's known cost and unknown tokens. Tokens of unknown cost:
balances the owner held before the tape, detected by reconciling the tracked balance with the row's
`owner_token_pre` at the start of each transaction and `owner_token_post` at its end (a shortfall becomes unknown-cost
tokens; an excess is removed proportionally).

Excluded from holders: the pool, the bonding curve and empty owners. Burn and protocol accounts other than these are
not listed on the tape (OPEN_QUESTIONS.md).

Coverage = known-cost tokens / all tokens of included owners. RP = known cost / known-cost tokens. P = effective
quote / base reserve of the pool at d. CGO = (P - RP) / P. top10_share and creator_share are of the mint supply at d
(`base_supply` of the pool row). The creator is the create row's creator, else the pool's `coin_creator`.
"""
from collections import defaultdict
from typing import Dict, List

import numpy as np
import pandas as pd

from .load import Tape
from .pool_state import PoolBook


class Holders:
    def __init__(self, excluded):
        self.h: Dict[int, List[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])  # known tokens, known cost, unknown
        self.ex = set(excluded)
        self.K = self.Ck = self.U = 0.0

    def _delta(self, o, dk, dc, du):
        rec = self.h[o]
        rec[0] += dk
        rec[1] += dc
        rec[2] += du
        if o not in self.ex:
            self.K += dk
            self.Ck += dc
            self.U += du

    def total(self, o) -> float:
        rec = self.h.get(o)
        return rec[0] + rec[2] if rec else 0.0

    def add_known(self, o, tok, cost):
        if o >= 0 and tok > 0:
            self._delta(o, tok, cost, 0.0)

    def add_unknown(self, o, tok):
        if o >= 0 and tok > 0:
            self._delta(o, 0.0, 0.0, tok)

    def remove(self, o, tok):
        """Remove `tok` proportionally; returns (known tokens, known cost, unknown tokens) removed."""
        if o < 0 or tok <= 0:
            return 0.0, 0.0, 0.0
        rec = self.h[o]
        tot = rec[0] + rec[2]
        if tot <= 0:
            return 0.0, 0.0, 0.0
        f = min(1.0, tok / tot)
        dk, dc, du = rec[0] * f, rec[1] * f, rec[2] * f
        self._delta(o, -dk, -dc, -du)
        return dk, dc, du

    def reconcile(self, o, target):
        if o < 0 or target < 0:
            return
        diff = target - self.total(o)
        if diff > 0.5:
            self.add_unknown(o, diff)
        elif diff < -0.5:
            self.remove(o, -diff)

    def transfer(self, src, dst, tok):
        dk, dc, du = self.remove(src, tok)
        moved = dk + du
        if dst >= 0:
            if src < 0:
                self.add_unknown(dst, tok)
            else:
                if moved < tok:  # sender held less than it sent: the rest has unknown cost
                    du += tok - moved
                self._delta(dst, dk, dc, du)

    def top10(self) -> float:
        v = np.fromiter((r[0] + r[2] for o, r in self.h.items() if o not in self.ex), dtype=float)
        if len(v) == 0:
            return 0.0
        if len(v) > 10:
            v = np.partition(v, len(v) - 10)[-10:]
        return float(np.clip(v, 0, None).sum())


def _events(tape: Tape, book: PoolBook, mint: int, pool: int) -> pd.DataFrame:
    c = tape.curve[(tape.curve.mint == mint) & (tape.curve.sol_quote == 1)]
    r = book.rows[pool]
    a = pd.DataFrame({"slot": r["slot"], "tx_idx": r["tx_idx"], "outer_ix": r["outer_ix"], "inner_ix": r["inner_ix"],
                      "side": r["side"], "owner": r["owner"], "base_amount": r["base_amount"],
                      "user_quote": r["user_quote"], "owner_pre": r["owner_pre"], "owner_post": r["owner_post"]})
    t = tape.t[tape.t.mint == mint]
    parts = []
    if len(c):
        parts.append(pd.DataFrame({
            "slot": c.slot, "tx_idx": c.tx_idx, "outer_ix": c.outer_ix, "inner_ix": c.inner_ix, "src": 0,
            "typ": np.where(c.is_buy == 1, 0, 1), "owner": c.owner, "other": -1, "tok": c.token_amount,
            "cost": c.sol_amount.astype(np.int64) + c.fee.astype(np.int64) + c.creator_fee.astype(np.int64), "pre": c.owner_pre, "post": c.owner_post}))
    if len(a):
        parts.append(pd.DataFrame({
            "slot": a.slot, "tx_idx": a.tx_idx, "outer_ix": a.outer_ix, "inner_ix": a.inner_ix, "src": 0,
            "typ": np.where(a.side == 1, 0, 1), "owner": a.owner, "other": -1, "tok": a.base_amount,
            "cost": a.user_quote, "pre": a.owner_pre, "post": a.owner_post}))
    if len(t):
        parts.append(pd.DataFrame({
            "slot": t.slot, "tx_idx": t.tx_idx, "outer_ix": t.outer_ix, "inner_ix": t.inner_ix, "src": 1,
            "typ": np.where(t.kind >= 0, t.kind + 2, 9), "owner": t.src, "other": t.dst, "tok": t.amount, "cost": 0, "pre": -1, "post": -1}))
    if not parts:
        return pd.DataFrame(columns=["slot", "tx_idx", "outer_ix", "inner_ix", "src", "typ", "owner", "other", "tok",
                                     "cost", "pre", "post"])
    ev = pd.concat(parts, ignore_index=True)
    return ev.sort_values(["slot", "tx_idx", "outer_ix", "inner_ix", "src"], kind="mergesort").reset_index(drop=True)


def holder_features(tape: Tape, book: PoolBook, el: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(np.nan, index=el.index, columns=["top10_share", "creator_share", "cgo", "cgo_coverage"])
    ce = tape.ev["CreateEvent"].drop_duplicates("mint").set_index("mint")
    mg = tape.ev["CompletePumpAmmMigrationEvent"]
    for (pool, mint), g in el.groupby(["pool", "mint"], sort=False):
        curves = set(mg[mg.mint == mint].bonding_curve.tolist())
        if mint in ce.index:
            curves.add(int(ce.at[mint, "bonding_curve"]))
        H = Holders({pool, -1} | curves)
        ev = _events(tape, book, int(mint), int(pool))
        cols = [ev[c].to_numpy() for c in ("slot", "tx_idx", "typ", "owner", "other", "tok", "cost", "pre", "post", "src")]
        sl, tx, typ, own, oth, tok, cost, pre, post, src = cols
        n = len(sl)
        g = g.sort_values("d")
        r = book.rows[pool]
        i = 0
        for ix, d in zip(g.index, g.d.to_numpy()):
            while i < n and sl[i] <= d:
                j = i
                while j < n and sl[j] == sl[i] and tx[j] == tx[i]:
                    j += 1
                seen = set()
                for k in range(i, j):
                    if src[k] == 0 and own[k] >= 0 and own[k] not in seen and own[k] not in H.ex:
                        seen.add(own[k])
                        H.reconcile(int(own[k]), float(pre[k]))
                last_post = {}
                for k in range(i, j):
                    o, q = int(own[k]), float(tok[k])
                    if typ[k] == 0:
                        H.add_known(o, q, float(cost[k]))
                    elif typ[k] == 1:
                        H.remove(o, q)
                    elif typ[k] == 2:
                        H.transfer(o, int(oth[k]), q)
                    elif typ[k] == 3:
                        H.remove(o, q)
                    elif typ[k] == 4:
                        H.add_unknown(int(oth[k]), q)
                    if src[k] == 0 and o >= 0 and o not in H.ex:
                        last_post[o] = float(post[k])
                for o, p in last_post.items():
                    H.reconcile(o, p)
                i = j
            iD = int(np.searchsorted(r["slot"], d, side="right") - 1)
            supply = float(r["supply"][iD])
            if supply <= 0:
                continue
            out.at[ix, "top10_share"] = H.top10() / supply
            sd = ce.loc[mint] if mint in ce.index and int(ce.at[mint, "slot"]) <= d else None
            creator = int(sd["creator"]) if sd is not None else int(r["coin_creator"][iD])
            out.at[ix, "creator_share"] = max(H.total(creator), 0.0) / supply if creator >= 0 else np.nan
            held = H.K + H.U
            if held > 0:
                out.at[ix, "cgo_coverage"] = H.K / held
            if H.K > 0:
                P = float(r["vault_after"][iD] + r["virt"][iD]) / float(r["base_after"][iD])
                RP = H.Ck / H.K
                out.at[ix, "cgo"] = (P - RP) / P
    return out
