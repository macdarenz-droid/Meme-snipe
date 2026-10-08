"""F1 follower-flow counts gate (research/f1-follower-flow/GATE.md, frozen).

Counts and timing only. Nothing here reads a price, a return or an outcome.
The gate decision is computed only when --decide is passed.

Entry point:
    python3 f1_counts.py --unit DIR [--unit DIR ...] --out OUTDIR [--decide]

A unit directory is <cache>/<day>/<from>-<to> or its research/ subfolder. The day
is read from the path (the decoder drops every block outside that day).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

import numpy as np
import pandas as pd

WSOL = "So11111111111111111111111111111111111111112"
SOL_NATIVE = "11111111111111111111111111111111"  # pump curve quote_mint for SOL

# Frozen parameters (GATE.md "Definitions" and "Kill").
DAY1 = "2026-09-11"
DAY2 = "2026-09-10"
MIN_DISTINCT_MINTS = 10
FOLLOW_SLOTS = 600
PLACEBO_REACH = 1800
LANDING_DELAY = 23
LOWER_Q = 0.005  # one-sided 99.5% lower bound
KILL_MIN_FOLLOWED = 20
KILL_MIN_PERSIST_SHARE = 0.5
KILL_MIN_LATE_SHARE = 0.5
KILL_MIN_BUYS_PER_DAY = 15
# Not fixed by GATE.md (see OPEN_QUESTIONS.md): committed here.
PLACEBO_SEED = 20261008
BOOT_SEED = 20261009
BOOT_N = 10_000


# ---------------------------------------------------------------- loading
def unit_info(path: str):
    p = os.path.abspath(path)
    if os.path.basename(p) != "research":
        p = os.path.join(p, "research")
    m = re.search(r"(\d{4}-\d{2}-\d{2})/(\d+)-(\d+)/research$", p)
    if not m:
        raise ValueError(f"cannot read day and slot range from {path}")
    return p, m.group(1), int(m.group(2)), int(m.group(3))


def _read(p, name, cols):
    f = os.path.join(p, name + ".csv.zst")
    if not os.path.exists(f):
        return pd.DataFrame(columns=cols)
    head = pd.read_csv(f, compression="zstd", nrows=0).columns
    use = [c for c in cols if c in head]
    return pd.read_csv(f, compression="zstd", usecols=use, dtype=str, keep_default_na=True)


def boost_signatures(p):
    """Signatures of BOOST buy-and-burn transactions (E table)."""
    import io
    import zstandard

    f = os.path.join(p, "E.jsonl.zst")
    sigs = set()
    if not os.path.exists(f):
        return sigs
    with open(f, "rb") as fh:
        for line in io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8"):
            if '"BoostBuyAndBurnEvent"' in line:
                sigs.add(json.loads(line)["signature"])
    return sigs


def normalise_swaps(curve: pd.DataFrame, amm: pd.DataFrame, boost: set, day: str) -> pd.DataFrame:
    """One row per swap: day, slot, order key, owner, mint, is_buy, sol (lamports).

    Kept: SOL-quoted swaps with a known owner, not BOOST or protocol rows.
    """
    c = pd.DataFrame({
        "slot": curve["slot"], "tx_idx": curve["tx_idx"], "ev_idx": curve["ev_idx"],
        "signature": curve["signature"], "owner": curve["user_token_owner"], "mint": curve["mint"],
        "is_buy": curve["is_buy"].astype(str) == "1", "sol": curve["sol_amount"],
        "quote_mint": curve.get("quote_mint", pd.Series(SOL_NATIVE, index=curve.index)).fillna(SOL_NATIVE),
        "protocol": curve.get("protocol", pd.Series("0", index=curve.index)),
    })
    a = pd.DataFrame({
        "slot": amm["slot"], "tx_idx": amm["tx_idx"], "ev_idx": amm["ev_idx"],
        "signature": amm["signature"], "owner": amm["user_token_owner"], "mint": amm["base_mint"],
        "is_buy": amm["side"].astype(str) == "buy", "sol": amm["quote_amount"],
        "quote_mint": amm["quote_mint"],
        "protocol": amm.get("protocol", pd.Series("0", index=amm.index)),
    })
    s = pd.concat([c, a], ignore_index=True)
    s = s[s["quote_mint"].isin([SOL_NATIVE, WSOL])]
    s = s[s["protocol"].fillna("0").astype(str).isin(["0", ""])]
    s = s[~s["signature"].isin(boost)]
    s = s[s["owner"].notna() & (s["owner"] != "")]
    for col in ("slot", "tx_idx", "ev_idx"):
        s[col] = s[col].astype(np.int64)
    s["sol"] = pd.to_numeric(s["sol"], errors="coerce").fillna(0).astype(np.int64)
    s["day"] = day
    return s[["day", "slot", "tx_idx", "ev_idx", "owner", "mint", "is_buy", "sol"]]


def load_units(paths):
    swaps, tlinks, wlinks, ranges = [], [], [], []
    for path in paths:
        p, day, lo, hi = unit_info(path)
        boost = boost_signatures(p)
        curve = _read(p, "S_curve", ["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "mint", "is_buy",
                                     "sol_amount", "quote_mint", "protocol"])
        amm = _read(p, "S_amm", ["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "base_mint", "side",
                                 "quote_amount", "quote_mint", "protocol"])
        swaps.append(normalise_swaps(curve, amm, boost, day))
        t = _read(p, "T", ["mint", "kind", "from_owner", "to_owner"])
        tlinks.append(t[t["kind"] == "transfer"][["mint", "from_owner", "to_owner"]])
        w = _read(p, "W", ["from", "to"])
        wlinks.append(w.rename(columns={"from": "from_owner", "to": "to_owner"}))
        ranges.append((day, lo, hi))
    return (pd.concat(swaps, ignore_index=True), pd.concat(tlinks, ignore_index=True),
            pd.concat(wlinks, ignore_index=True), ranges)


# ---------------------------------------------------------------- links
def build_links(t: pd.DataFrame, w: pd.DataFrame):
    """Returns (sol_pairs, mint_pairs): pairs of owners linked by a SOL transfer (W, or T of WSOL)
    and, per mint, by a transfer of that mint (T). Any time on the loaded tape (OPEN_QUESTIONS Q3)."""
    def clean(df):
        df = df.dropna(subset=["from_owner", "to_owner"])
        df = df[df["from_owner"] != df["to_owner"]]
        a = np.where(df["from_owner"] < df["to_owner"], df["from_owner"], df["to_owner"])
        b = np.where(df["from_owner"] < df["to_owner"], df["to_owner"], df["from_owner"])
        return df, a, b

    _, a, b = clean(w)
    sol = set(zip(a, b))
    _, a, b = clean(t[t["mint"] == WSOL])
    sol |= set(zip(a, b))
    mint_pairs: dict[str, set] = {}
    tm, a, b = clean(t[(t["mint"] != WSOL) & t["mint"].notna()])
    for m, x, y in zip(tm["mint"].values, a, b):
        mint_pairs.setdefault(m, set()).add((x, y))
    return sol, mint_pairs


def linked(x, y, mint, sol_pairs, mint_pairs):
    k = (x, y) if x < y else (y, x)
    return k in sol_pairs or k in mint_pairs.get(mint, ())


# ---------------------------------------------------------------- coverage
def covered(ranges, day, lo, hi):
    """True if slots [lo, hi] lie inside contiguous loaded units of that day."""
    iv = sorted((a, b) for d, a, b in ranges if d == day)
    merged = []
    for a, b in iv:
        if merged and a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return any(a <= lo and hi <= b for a, b in merged)


# ---------------------------------------------------------------- definitions
def leader_candidates(swaps: pd.DataFrame, day1=DAY1, k=MIN_DISTINCT_MINTS) -> set:
    b = swaps[(swaps["day"] == day1) & swaps["is_buy"]]
    n = b.groupby("owner")["mint"].nunique()
    return set(n[n >= k].index)


def follow_stats(buys_by_mint, ev, sol_pairs, mint_pairs, window=FOLLOW_SLOTS, delay=LANDING_DELAY):
    """Followers of buy `ev`: buys of the same mint after it in tape order, slot <= ev.slot + window,
    by an owner that is not ev.owner and not linked to it. Returns (follow_count, vol_total, vol_late)."""
    mb = buys_by_mint[ev["mint"]]
    sl = mb["slot"]
    lo = np.searchsorted(sl, ev["slot"], side="left")
    hi = np.searchsorted(sl, ev["slot"] + window, side="right")
    key = (ev["slot"], ev["tx_idx"], ev["ev_idx"])
    owners, vol, late = set(), 0, 0
    for i in range(lo, hi):
        if (sl[i], mb["tx_idx"][i], mb["ev_idx"][i]) <= key:
            continue
        o = mb["owner"][i]
        if o == ev["owner"] or linked(o, ev["owner"], ev["mint"], sol_pairs, mint_pairs):
            continue
        owners.add(o)
        vol += int(mb["sol"][i])
        if sl[i] - ev["slot"] > delay:
            late += int(mb["sol"][i])
    return len(owners), vol, late


def event_table(swaps, leaders, day, ranges, sol_pairs, mint_pairs, candidates=None, seed=PLACEBO_SEED):
    """One row per buy by an owner in `leaders` on `day`, with its follow count and its placebo's.
    The placebo buyer is never in `candidates` (default: `leaders`), the day-1 candidate set.
    Leader buys with no placebo buy in reach, or whose windows are not on loaded tape, are dropped
    (kept as rows with a reason)."""
    candidates = leaders if candidates is None else candidates
    buys = swaps[(swaps["day"] == day) & swaps["is_buy"]].sort_values(["slot", "tx_idx", "ev_idx"], kind="mergesort")
    buys_by_mint = {m: {c: g[c].to_numpy() for c in ("slot", "tx_idx", "ev_idx", "owner", "sol")}
                    for m, g in buys.groupby("mint", sort=False)}
    rng = np.random.default_rng(seed)
    rows = []
    for ev in buys[buys["owner"].isin(leaders)].to_dict("records"):
        out = {"day": day, "leader": ev["owner"], "mint": ev["mint"], "slot": ev["slot"],
               "tx_idx": ev["tx_idx"], "ev_idx": ev["ev_idx"]}
        lo, hi = ev["slot"] - PLACEBO_REACH, ev["slot"] + PLACEBO_REACH + FOLLOW_SLOTS
        if not covered(ranges, day, lo, hi):
            out["dropped"] = "window_not_on_tape"
            rows.append(out)
            continue
        mb = buys_by_mint[ev["mint"]]
        i0 = np.searchsorted(mb["slot"], ev["slot"] - PLACEBO_REACH, side="left")
        i1 = np.searchsorted(mb["slot"], ev["slot"] + PLACEBO_REACH, side="right")
        reach = [i for i in range(i0, i1) if mb["owner"][i] not in candidates]
        if not reach:
            out["dropped"] = "no_placebo_in_reach"
            rows.append(out)
            continue
        j = reach[int(rng.integers(len(reach)))]
        pick = {"mint": ev["mint"], "owner": mb["owner"][j], "slot": int(mb["slot"][j]),
                "tx_idx": int(mb["tx_idx"][j]), "ev_idx": int(mb["ev_idx"][j])}
        f, v, late = follow_stats(buys_by_mint, ev, sol_pairs, mint_pairs)
        pf, _, _ = follow_stats(buys_by_mint, pick, sol_pairs, mint_pairs)
        out.update({"dropped": "", "follow": f, "follower_sol": v, "follower_sol_late": late,
                    "placebo_owner": pick["owner"], "placebo_slot": pick["slot"], "placebo_follow": pf})
        rows.append(out)
    cols = ["day", "leader", "mint", "slot", "tx_idx", "ev_idx", "dropped", "follow", "follower_sol",
            "follower_sol_late", "placebo_owner", "placebo_slot", "placebo_follow"]
    return pd.DataFrame(rows, columns=cols)


def leader_test(ev: pd.DataFrame, n_boot=BOOT_N, seed=BOOT_SEED) -> pd.DataFrame:
    """Per leader: mean follow - mean placebo follow, and the one-sided 99.5% lower bound from a
    bootstrap over that leader's (buy, placebo) pairs. Followed = mean diff > 0 and lower bound > 0."""
    ok = ev[ev["dropped"] == ""]
    rng = np.random.default_rng(seed)
    out = []
    for leader, g in sorted(ok.groupby("leader"), key=lambda x: x[0]):
        d = (g["follow"].astype(float) - g["placebo_follow"].astype(float)).values
        n = len(d)
        idx = rng.integers(0, n, size=(n_boot, n))
        means = d[idx].mean(axis=1)
        lb = float(np.quantile(means, LOWER_Q))
        out.append({"leader": leader, "n_buys": n, "mean_follow": float(g["follow"].mean()),
                    "mean_placebo": float(g["placebo_follow"].mean()), "diff": float(d.mean()),
                    "lb995": lb, "followed": bool(d.mean() > 0 and lb > 0)})
    return pd.DataFrame(out, columns=["leader", "n_buys", "mean_follow", "mean_placebo", "diff", "lb995", "followed"])


def run(paths, n_boot=BOOT_N, day1=DAY1, day2=DAY2):
    swaps, t, w, ranges = load_units(paths)
    sol_pairs, mint_pairs = build_links(t, w)
    cands = leader_candidates(swaps, day1)
    ev1 = event_table(swaps, cands, day1, ranges, sol_pairs, mint_pairs)
    lt1 = leader_test(ev1, n_boot)
    followed = set(lt1.loc[lt1["followed"], "leader"])
    ev2 = event_table(swaps, followed, day2, ranges, sol_pairs, mint_pairs, candidates=cands)
    lt2 = leader_test(ev2, n_boot)
    persistent = set(lt2.loc[lt2["followed"], "leader"])
    e2p = ev2[(ev2["dropped"] == "") & ev2["leader"].isin(persistent)]
    vol = int(e2p["follower_sol"].sum()) if len(e2p) else 0
    late = int(e2p["follower_sol_late"].sum()) if len(e2p) else 0
    slots = {d: sum(b - a + 1 for dd, a, b in ranges if dd == d) for d in (day1, day2)}
    summary = {
        "units": [f"{d} {a}-{b}" for d, a, b in ranges],
        "slots_loaded": slots,
        "swaps_kept": int(len(swaps)),
        "leader_candidates_day1": len(cands),
        "day1_candidate_buys": int(len(ev1)), "day1_buys_used": int((ev1["dropped"] == "").sum()),
        "day1_dropped": ev1["dropped"].value_counts().to_dict(),
        "followed_day1": len(followed),
        "day2_buys_of_followed": int(len(ev2)), "day2_buys_used": int((ev2["dropped"] == "").sum()),
        "persistent_day2": len(persistent),
        "persistent_share": (len(persistent) / len(followed)) if followed else None,
        "day2_persistent_leader_buys": int(len(e2p)),
        "day2_follower_sol": vol, "day2_follower_sol_late": late,
        "late_share": (late / vol) if vol else None,
    }
    return summary, {"events_day1": ev1, "leaders_day1": lt1, "events_day2": ev2, "leaders_day2": lt2}


def decide(s):
    """GATE.md "Kill". Valid only on complete Step A days."""
    kills = {
        "fewer_than_20_followed_day1": s["followed_day1"] < KILL_MIN_FOLLOWED,
        "under_half_persist_day2": (s["persistent_share"] is None) or s["persistent_share"] < KILL_MIN_PERSIST_SHARE,
        "under_50pct_volume_after_23_slots": (s["late_share"] is None) or s["late_share"] < KILL_MIN_LATE_SHARE,
        "fewer_than_15_persistent_buys_a_day": s["day2_persistent_leader_buys"] < KILL_MIN_BUYS_PER_DAY,
    }
    return {"kills": kills, "f1_closes": any(kills.values())}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--unit", action="append", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--boot", type=int, default=BOOT_N)
    ap.add_argument("--decide", action="store_true", help="also apply the kill rules (only on complete Step A days)")
    a = ap.parse_args(argv)
    summary, tables = run(a.unit, a.boot)
    if a.decide:
        summary["decision"] = decide(summary)
    os.makedirs(a.out, exist_ok=True)
    for k, df in tables.items():
        df.to_csv(os.path.join(a.out, f"f1_{k}.csv"), index=False)
    with open(os.path.join(a.out, "f1_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, default=str)
    json.dump(summary, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
