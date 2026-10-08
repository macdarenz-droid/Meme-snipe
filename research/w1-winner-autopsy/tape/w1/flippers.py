"""AMENDMENT_4: the flipper label (report rows only; it changes no ranking and no trade is built on it).

Flipper: at least 5 round trips on the tape with a median hold between 30 seconds and 10 minutes; a token transfer
(or a balance mismatch) inside a trip breaks it (ledger `_trips`). Rows: the class per day and over the tape, its
persistence from one day to the next, a census of buy SOL by class, and the flows around flippers' trips
(OPEN_QUESTIONS Q34 for the flow definitions)."""
import numpy as np
import pandas as pd

from . import classes, clusters, load
from .costs import REPLAY_DELAY_SLOTS

MIN_TRIPS = 5
HOLD_LO_S, HOLD_HI_S = 30, 600


def flipper_class(trips, trader):
    """Per trader: unbroken trips, median hold (s), flipper flag."""
    t = trips[~trips["broken"].astype(bool)]
    if len(t) == 0:
        return pd.DataFrame(columns=["trips", "median_hold_s", "flipper"])
    tr = clusters.assign(t["owner"].to_numpy(), trader)
    hold = t["close_bt"].to_numpy(np.float64) - t["open_bt"].to_numpy(np.float64)
    g = pd.DataFrame({"trader": tr, "hold": hold}).groupby("trader")["hold"]
    out = pd.DataFrame({"trips": g.size(), "median_hold_s": g.median()})
    out["flipper"] = (out["trips"] >= MIN_TRIPS) & out["median_hold_s"].between(HOLD_LO_S, HOLD_HI_S)
    return out


def persistence(day1, day2, trader1):
    a, b = flipper_class(day1["trips"], trader1), flipper_class(day2["trips"], trader1)
    f1 = set(a.index[a["flipper"]]) if len(a) else set()
    f2 = set(b.index[b["flipper"]]) if len(b) else set()
    return {"flippers_day1": len(f1), "flippers_day2": len(f2),
            "day1_flippers_flipper_again": (len(f1 & f2) / len(f1)) if f1 else None}


def census(day, trader, flip):
    """Buy SOL (paid, lamports -> SOL) by latency class and flipper flag."""
    b = day["buys"]
    if len(b) == 0:
        return {}
    cls = classes.classify(day, trader)
    tr = clusters.assign(b["owner"].to_numpy(), trader)
    lat = classes.class_of(tr, cls)
    fl = np.isin(tr, np.array(sorted(flip), np.int64)) if flip else np.zeros(len(tr), bool)
    lab = np.where(fl, "flipper", lat)
    s = pd.Series(b["paid"].to_numpy(np.float64), index=lab).groupby(level=0).sum() / 1e9
    return {k: float(v) for k, v in s.items()}


def flows(trips, flip, trader, units, vocab):
    """Around each unbroken trip of a flipper: others' net buy SOL inside the trip (what it sold into), the share of
    it after the first 23 slots, and others' net sell SOL in the same length of time after the exit (reversal)."""
    t = trips[~trips["broken"].astype(bool)].copy()
    t["trader"] = clusters.assign(t["owner"].to_numpy(), trader)
    t = t[t["trader"].isin(flip)]
    if len(t) == 0:
        return {"trips": 0}
    names = {vocab.strs[m] for m in t["mint"].astype(int).unique()}
    sws = [load.swaps(u, vocab, mints=names) for u in units]
    sw = pd.concat([x for x in sws if len(x)], ignore_index=True)
    sw = sw[sw["sol"].astype(bool) & ~sw["overflow"].astype(bool)].sort_values("key", kind="stable")
    sw["tr"] = clusters.assign(sw["owner"].to_numpy(), trader)
    sw["flow"] = -sw["cash"].to_numpy(np.float64)   # + SOL in on buys, - SOL out on sells (venue amounts)
    by = {m: g for m, g in sw.groupby("mint")}
    tin = t23 = rev = 0.0
    for m, ok, ck, tr in zip(t["mint"], t["open_key"], t["close_key"], t["trader"]):
        g = by.get(int(m))
        if g is None:
            continue
        k, sl = g["key"].to_numpy(), g["slot"].to_numpy()
        f = np.where(g["tr"].to_numpy() != tr, g["flow"].to_numpy(), 0.0)
        i0, i1 = np.searchsorted(k, ok, "right"), np.searchsorted(k, ck, "right")
        tin += f[i0:i1].sum()
        s0 = int(load.key_slot(int(ok)))
        t23 += f[i0:i1][sl[i0:i1] > s0 + REPLAY_DELAY_SLOTS].sum()
        span = int(load.key_slot(int(ck))) - s0
        j1 = np.searchsorted(sl, int(load.key_slot(int(ck))) + span, "right")
        rev += -f[i1:j1].sum()
    return {"trips": int(len(t)), "others_net_buy_sol_inside": tin / 1e9,
            "share_after_23_slots": (t23 / tin) if tin else None, "others_net_sell_sol_after_exit": rev / 1e9}
