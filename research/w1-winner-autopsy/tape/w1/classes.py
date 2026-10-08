"""PREREG §5: latency class per trader and day, from buys only (decided before any P&L is read).

Fast if, on that day, either
  - at least 10% of its buys land within 2 slots of the mint's create (C) or migration (G), or
  - at least 30% of its buys land within 2 slots after another trader's buy of at least 1 SOL on the same mint.
Slow otherwise (a trader with no buy that day is slow; OPEN_QUESTIONS Q11).
Reported only: the Jito-tip share of its buys and the median lag (slots) from the previous swap on the mint."""
import numpy as np
import pandas as pd

from . import clusters

NEAR_SLOTS = 2
FAST_NEAR_SHARE = 0.10
FAST_FOLLOW_SHARE = 0.30


def near_create_or_migration(buys, cg):
    """Per buy: a C or G event of its mint within 2 slots, either side (OPEN_QUESTIONS Q12)."""
    if len(buys) == 0:
        return np.zeros(0, bool)
    q = pd.DataFrame({"mint": buys["mint"].to_numpy(np.int64), "slot": buys["slot"].to_numpy(np.int64),
                      "_i": np.arange(len(buys))}).sort_values("slot", kind="stable")
    e = pd.DataFrame({"mint": cg["mint"].to_numpy(np.int64), "eslot": cg["slot"].to_numpy(np.int64)})
    if len(e) == 0:
        return np.zeros(len(buys), bool)
    e = e.drop_duplicates().sort_values("eslot", kind="stable")
    e["slot"] = e["eslot"]
    hit = np.zeros(len(buys), bool)
    for d in ("backward", "forward"):
        m = pd.merge_asof(q, e, on="slot", by="mint", direction=d).sort_values("_i")
        dist = (m["slot"] - m["eslot"]).abs().to_numpy()
        hit |= np.nan_to_num(dist, nan=1e18) <= NEAR_SLOTS
    return hit


def follows_big_buy(buys, big, trader):
    """Per buy: the latest earlier buy of at least 1 SOL on the mint by another trader is at most 2 slots before."""
    if len(buys) == 0:
        return np.zeros(0, bool)
    if len(big) == 0:
        return np.zeros(len(buys), bool)
    b = pd.DataFrame({"mint": big["mint"].to_numpy(np.int64), "key": big["key"].to_numpy(np.int64),
                      "bslot": big["slot"].to_numpy(np.int64),
                      "btr": clusters.assign(big["owner"].to_numpy(), trader)})
    b = b.sort_values(["mint", "key"], kind="stable").reset_index(drop=True)
    # previous big buy of the same mint by a different trader than this big buy's (end of the previous run)
    run = ((b["mint"] != b["mint"].shift()) | (b["btr"] != b["btr"].shift())).cumsum()
    last_in_run = b.groupby(run).tail(1)
    prev_run_slot = pd.Series(last_in_run["bslot"].to_numpy(), index=run[last_in_run.index].to_numpy())
    prev_run_tr = pd.Series(last_in_run["btr"].to_numpy(), index=run[last_in_run.index].to_numpy())
    prev_run_mint = pd.Series(last_in_run["mint"].to_numpy(), index=run[last_in_run.index].to_numpy())
    r = run.to_numpy()
    same_mint_prev = prev_run_mint.reindex(r - 1).to_numpy() == b["mint"].to_numpy()
    b["pd_slot"] = np.where(same_mint_prev, prev_run_slot.reindex(r - 1).to_numpy(), np.nan)
    b["pd_tr"] = np.where(same_mint_prev, prev_run_tr.reindex(r - 1).to_numpy(), np.nan)
    q = pd.DataFrame({"mint": buys["mint"].to_numpy(np.int64), "key": buys["key"].to_numpy(np.int64),
                      "slot": buys["slot"].to_numpy(np.int64),
                      "tr": clusters.assign(buys["owner"].to_numpy(), trader), "_i": np.arange(len(buys))})
    q = q.sort_values("key", kind="stable")
    m = pd.merge_asof(q, b.sort_values("key", kind="stable"), on="key", by="mint", direction="backward",
                      allow_exact_matches=False).sort_values("_i")
    cand_slot = np.where(m["btr"].to_numpy() != m["tr"].to_numpy(), m["bslot"].to_numpy(), m["pd_slot"].to_numpy())
    cand_slot = np.where(m["btr"].isna().to_numpy(), np.nan, cand_slot)
    gap = m["slot"].to_numpy() - cand_slot
    return np.nan_to_num(gap, nan=1e18) <= NEAR_SLOTS


def classify(day, trader):
    """Latency class per trader for one ledger day. Returns a frame indexed by trader."""
    buys = day["buys"]
    if len(buys) == 0:
        return pd.DataFrame(columns=["buys", "near", "follow", "near_share", "follow_share", "fast", "jito_share",
                                     "median_lag"])
    near = near_create_or_migration(buys, day["cg"])
    fol = follows_big_buy(buys, day["big"], trader)
    df = pd.DataFrame({"trader": clusters.assign(buys["owner"].to_numpy(), trader), "near": near, "follow": fol,
                       "jito": buys["jito"].to_numpy(bool), "lag": buys["lag"].to_numpy(np.float64)})
    g = df.groupby("trader")
    out = pd.DataFrame({"buys": g.size(), "near": g["near"].sum(), "follow": g["follow"].sum(),
                        "jito_share": g["jito"].mean(), "median_lag": g["lag"].median()})
    out["near_share"] = out["near"] / out["buys"]
    out["follow_share"] = out["follow"] / out["buys"]
    out["fast"] = (out["near_share"] >= FAST_NEAR_SHARE) | (out["follow_share"] >= FAST_FOLLOW_SHARE)
    return out


def class_of(traders, cls):
    """'fast' / 'slow' for each trader id; no buy that day -> slow."""
    f = cls["fast"].reindex(np.asarray(traders)).fillna(False).astype(bool).to_numpy() if len(cls) else \
        np.zeros(len(traders), bool)
    return np.where(f, "fast", "slow")


def stability(day1, day2, trader1):
    """Share of traders keeping their class from day1 to day2 (both classified with day1's clusters)."""
    c1, c2 = classify(day1, trader1), classify(day2, trader1)
    common = c1.index.intersection(c2.index)
    if len(common) == 0:
        return {"common": 0}
    a, b = c1.loc[common, "fast"], c2.loc[common, "fast"]
    return {"common": int(len(common)), "same": float((a == b).mean()),
            "slow_stays_slow": float((~b[~a]).mean()) if (~a).any() else None,
            "fast_stays_fast": float(b[a].mean()) if a.any() else None}


def seat_tag(day, trader):
    """AMENDMENT_7 (descriptive): per trader, the median (jito_tip + tx_fee) per trade, in SOL (the transaction's whole
    fee and tip; trades with no tx_fee left out), and the median within-slot rank of its buys (1 = the first
    transaction swapping that mint in the slot). A tag only: it never changes the latency class or the ranking."""
    f = day.get("fees")
    out = pd.DataFrame(columns=["trades", "median_seat_cost_sol"])
    if f is not None and len(f):
        f = f[~f["fee_na"].astype(bool)]
        g = pd.DataFrame({"trader": clusters.assign(f["owner"].to_numpy(), trader),
                          "seat": f["seat"].to_numpy(np.float64)}).groupby("trader")["seat"]
        out = pd.DataFrame({"trades": g.size(), "median_seat_cost_sol": g.median() / 1e9})
    b = day.get("buys")
    if b is not None and len(b) and "slot_rank" in b:
        g = pd.DataFrame({"trader": clusters.assign(b["owner"].to_numpy(), trader),
                          "r": b["slot_rank"].to_numpy(np.float64)}).groupby("trader")["r"]
        r = pd.DataFrame({"buys": g.size(), "median_buy_slot_rank": g.median()})
        out = out.join(r, how="outer")
    for c in ("buys", "median_buy_slot_rank"):
        if c not in out:
            out[c] = np.nan
    return out


def seat_summary(tag, cls):
    """Per latency class: quartiles of the two seat medians (no address)."""
    if len(tag) == 0:
        return {}
    lab = class_of(tag.index.to_numpy(), cls)
    out = {}
    for c in ("fast", "slow"):
        t = tag[lab == c]
        out[c] = {k: [float(x) for x in t[k].dropna().quantile([0.25, 0.5, 0.75])] if t[k].notna().any() else None
                  for k in ("median_seat_cost_sol", "median_buy_slot_rank")}
        out[c]["traders"] = int(len(t))
    return out
