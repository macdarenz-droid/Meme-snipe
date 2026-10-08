"""AMENDMENT_3 D60: supply expected over the next hour from current holders' own hold-time habits.

Round trip (OPEN_QUESTIONS D1): an owner's position in a mint opens on a swap that takes the owner's balance from 0
(`owner_token_pre` = 0, `owner_token_post` > 0, a buy) and closes on a sell that leaves 0 (`owner_token_post` = 0).
Its hold time is close time - open time. Every coin on the tape counts, not only the universe.

Habit: an owner's median hold time over round trips that closed at or before the decision slot (as of). D60 at a
decision point = the tokens of included holders whose habit says they sell within the next hour (median hold <= the
age of their current position + 60 min) / all tokens held by included holders. A holder whose position has no
recorded open (tokens came by transfer) or who has no earlier round trip is untraceable and adds nothing to D60.
"""
import bisect

import numpy as np
import pandas as pd

D60_WINDOW_S = 3600


def events_from(df: pd.DataFrame, venue: str) -> pd.DataFrame:
    """Open and close events from S rows of one venue (all coins). Rows with an empty owner or unknown balances
    (schema gaps) give no event."""
    if df.empty:
        return pd.DataFrame(columns=["owner", "mint", "slot", "tx", "ev", "time", "kind"])
    mint = df["mint"] if venue == "curve" else df["base_mint"]
    buy = (df["is_buy"] == "1") if venue == "curve" else (df["side"] == "buy")
    pre, post = df["owner_token_pre"], df["owner_token_post"]
    known = (df["user_token_owner"] != "") & (pre != "") & (post != "")
    prot = df["protocol"].isin(["", "0"]) if "protocol" in df else True
    o = known & prot & buy & (pre == "0") & (post != "0")
    c = known & prot & ~buy & (post == "0") & (pre != "0")
    out = []
    for mask, kind in ((o, "o"), (c, "c")):
        x = df[mask]
        out.append(pd.DataFrame(dict(owner=x["user_token_owner"].values, mint=mint[mask].values,
                                     slot=x["slot"].astype("int64").values, tx=x["tx_idx"].astype("int64").values,
                                     ev=pd.to_numeric(x["ev_idx"], errors="coerce").fillna(-1).astype("int64").values,
                                     time=x["block_time"].astype("int64").values, kind=kind)))
    return pd.concat(out, ignore_index=True)


def round_trips(ev: pd.DataFrame) -> pd.DataFrame:
    """Pairs each close with the open just before it in the same (owner, mint). Returns owner, close_slot, hold_s."""
    if ev.empty:
        return pd.DataFrame(columns=["owner", "close_slot", "hold_s"])
    e = ev.sort_values(["owner", "mint", "slot", "tx", "ev"], kind="mergesort").reset_index(drop=True)
    same = (e.owner.shift() == e.owner) & (e.mint.shift() == e.mint)
    prev_open = same & (e.kind.shift() == "o")
    m = (e.kind == "c") & prev_open
    rt = pd.DataFrame(dict(owner=e.owner[m].values, close_slot=e.slot[m].values,
                           hold_s=(e.time[m].values - e.time.shift()[m].values).astype("int64")))
    return rt


class Habits:
    """Per owner, the hold times of round trips in close-slot order; medians of a prefix are cached."""

    def __init__(self, rt: pd.DataFrame):
        self.by = {}
        if len(rt):
            rt = rt.sort_values(["owner", "close_slot"], kind="mergesort")
            for o, g in rt.groupby("owner", sort=False):
                self.by[o] = (g.close_slot.to_numpy(), g.hold_s.to_numpy(float))
        self._cache = {}

    def median_before(self, owner: str, slot: int):
        """Median hold time over round trips closed at or before `slot`; None without one."""
        x = self.by.get(owner)
        if x is None:
            return None
        k = bisect.bisect_right(x[0], slot)
        if k == 0:
            return None
        key = (owner, k)
        v = self._cache.get(key)
        if v is None:
            v = self._cache[key] = float(np.median(x[1][:k]))
        return v


def d60(holders, open_time: dict, habits: Habits, slot: int, hour: int) -> dict:
    """`holders`: [(owner, tokens)] of included holders with tokens > 0."""
    tot = due = traced = 0
    n = n_habit = 0
    for o, tok in holders:
        n += 1
        tot += tok
        m = habits.median_before(o, slot)
        if m is None:
            continue
        n_habit += 1
        t0 = open_time.get(o)
        if t0 is None:
            continue
        traced += tok
        if m <= (hour - t0) + D60_WINDOW_S:
            due += tok
    nan = float("nan")
    return dict(d60=due / tot if tot else nan, d60_traceable=traced / tot if tot else nan,
                d60_holders=n, d60_habit_holders=n_habit)
