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
MIN_VALID_PAIRS = 8  # AMENDMENT_1 item 7: fewer valid (buy, placebo) pairs on a day = untestable
# Not fixed by GATE.md (see OPEN_QUESTIONS.md): committed here.
PLACEBO_SEED = 20261008
BOOT_SEED = 20261009
BOOT_N = 10_000
REGISTERED_BOOT = 10_000  # what --decide requires (AMENDMENT_1 item 7)


# ---------------------------------------------------------------- prep-only guard
# A --prep-only run (real tape before the gate is evaluated) must never compute a follow count, follower SOL, a
# leader test, the payer bar or the decision. Those functions are marked @_outcome and raise while the guard is on.
_PREP_ONLY = False


class PrepOnlyError(RuntimeError):
    pass


def _outcome(fn):
    import functools

    @functools.wraps(fn)
    def guarded(*a, **k):
        if _PREP_ONLY:
            raise PrepOnlyError(f"{fn.__name__} is an outcome/statistic stage and is refused in --prep-only")
        return fn(*a, **k)
    return guarded


# ---------------------------------------------------------------- Step A plan check (for --decide)
DEFAULT_PLAN = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                             "shared-tape", "stepa-plan.txt"))
PLAN_DAYS = ("2026-09-11", "2026-09-10")


class PlanError(Exception):
    pass


def check_plan(ranges, plan_path=DEFAULT_PLAN, days=PLAN_DAYS):
    """Refuse unless the loaded (day, from, to) units equal the committed plan rows for `days` exactly and
    each day's slot ranges are contiguous. Returns the plan's sha256."""
    import hashlib

    with open(plan_path, "rb") as fh:
        raw = fh.read()
    sha = hashlib.sha256(raw).hexdigest()
    plan = set()
    for line in raw.decode().splitlines():
        f = line.split()
        if len(f) >= 4 and f[0] in days:
            plan.add((f[0], int(f[-2]), int(f[-1])))
    loaded = {(d, int(a), int(b)) for d, a, b in ranges}
    if not plan:
        raise PlanError(f"plan {plan_path} has no rows for {days}")
    if loaded != plan:
        raise PlanError(f"loaded units differ from the plan: missing {len(plan - loaded)}, extra {len(loaded - plan)}")
    for d in days:
        iv = sorted((a, b) for dd, a, b in loaded if dd == d)
        for (a0, b0), (a1, b1) in zip(iv, iv[1:]):
            if a1 != b0 + 1:
                raise PlanError(f"{d}: slots not contiguous between {b0} and {a1}")
    return sha


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
        # AMENDMENT_8: Q on the curve is its virtual SOL reserve at the buy; the fee is the row's own fee fields
        "q": _col(curve, "virtual_sol_reserves"),
        "fee_bps": _col(curve, "fee_basis_points") + _col(curve, "creator_fee_basis_points"),
    })
    a = pd.DataFrame({
        "slot": amm["slot"], "tx_idx": amm["tx_idx"], "ev_idx": amm["ev_idx"],
        "signature": amm["signature"], "owner": amm["user_token_owner"], "mint": amm["base_mint"],
        "is_buy": amm["side"].astype(str) == "buy", "sol": amm["quote_amount"],
        "quote_mint": amm["quote_mint"],
        "protocol": amm.get("protocol", pd.Series("0", index=amm.index)),
        # on a pool, Q is the effective quote (vault + signed virtual reserves) after the buy (its own chain reading)
        "q": _col(amm, "chain_pool_quote") + _col(amm, "virtual_quote_reserves"),
        "fee_bps": _col(amm, "lp_fee_basis_points") + _col(amm, "protocol_fee_basis_points")
        + _col(amm, "coin_creator_fee_basis_points"),
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
    return s[["day", "slot", "tx_idx", "ev_idx", "owner", "mint", "is_buy", "sol", "q", "fee_bps"]]


def _col(df, name):
    """A numeric column, NaN where missing (an unknown Q or fee never helps the payer bar)."""
    if name not in df.columns:
        return pd.Series(np.nan, index=df.index, dtype=float)
    return pd.to_numeric(df[name], errors="coerce").astype(float)


def _read_unit(path):
    """One unit: (normalised swaps, T transfer rows, W rows as from_owner/to_owner, (day, lo, hi))."""
    p, day, lo, hi = unit_info(path)
    boost = boost_signatures(p)
    curve = _read(p, "S_curve", ["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "mint", "is_buy",
                                 "sol_amount", "quote_mint", "protocol", "virtual_sol_reserves",
                                 "fee_basis_points", "creator_fee_basis_points"])
    amm = _read(p, "S_amm", ["slot", "tx_idx", "ev_idx", "signature", "user_token_owner", "base_mint", "side",
                             "quote_amount", "quote_mint", "protocol", "chain_pool_quote", "virtual_quote_reserves",
                             "lp_fee_basis_points", "protocol_fee_basis_points",
                             "coin_creator_fee_basis_points"])
    sw = normalise_swaps(curve, amm, boost, day)
    del curve, amm
    t = _read(p, "T", ["mint", "kind", "from_owner", "to_owner"])
    t = t[t["kind"] == "transfer"][["mint", "from_owner", "to_owner"]]
    w = _read(p, "W", ["from", "to"]).rename(columns={"from": "from_owner", "to": "to_owner"})
    return sw, t, w, (day, lo, hi)


def load_units(paths):
    """Original reader (kept for the equality test): all swaps, T and W rows of every unit in memory."""
    swaps, tlinks, wlinks, ranges = [], [], [], []
    for path in paths:
        sw, t, w, r = _read_unit(path)
        swaps.append(sw)
        tlinks.append(t)
        wlinks.append(w)
        ranges.append(r)
    return (pd.concat(swaps, ignore_index=True), pd.concat(tlinks, ignore_index=True),
            pd.concat(wlinks, ignore_index=True), ranges)


def _intern(col: pd.Series, table: dict) -> pd.Series:
    """Same values and dtype, but equal strings share one object across rows and units (memory only)."""
    vals = [table.setdefault(x, x) if isinstance(x, str) else x for x in col.tolist()]
    return pd.Series(vals, index=col.index, dtype=col.dtype, name=col.name)


def load_units_compact(paths):
    """Low-memory reader, same results as load_units + build_links: owner and mint strings are shared (interned)
    and the T/W links are built unit by unit and merged (the link sets are unions of row-wise pairs), so no unit's
    T or W rows are kept. Returns (swaps, sol_pairs, mint_pairs, ranges, n_t_rows, n_w_rows)."""
    table: dict = {}
    swaps, ranges = [], []
    sol_pairs: set = set()
    mint_pairs: dict[str, set] = {}
    n_t = n_w = 0
    for path in paths:
        sw, t, w, r = _read_unit(path)
        for c in ("owner", "mint"):
            sw[c] = _intern(sw[c], table)
        swaps.append(sw)
        n_t, n_w = n_t + len(t), n_w + len(w)
        for c in ("mint", "from_owner", "to_owner"):
            t[c] = _intern(t[c], table)
        for c in ("from_owner", "to_owner"):
            w[c] = _intern(w[c], table)
        sp, mp = build_links(t, w)
        del t, w
        sol_pairs |= sp
        for m, pairs in mp.items():
            mint_pairs.setdefault(m, set()).update(pairs)
        del sp, mp
        ranges.append(r)
    out = pd.concat(swaps, ignore_index=True)
    del swaps
    return out, sol_pairs, mint_pairs, ranges, n_t, n_w


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


@_outcome
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


def event_table(swaps, leaders, day, ranges, sol_pairs, mint_pairs, candidates=None, seed=PLACEBO_SEED,
                with_follow=True, compact=True):
    """One row per buy by an owner in `leaders` on `day`, with its follow count and its placebo's.
    The placebo buyer is never in `candidates` (default: `leaders`), the day-1 candidate set.
    Leader buys with no placebo buy in reach, or whose windows are not on loaded tape, are dropped
    (kept as rows with a reason).
    with_follow=False (--prep-only) keeps the same rows, drops and placebo draws but computes no follow count or
    follower SOL: those columns are left out.
    compact=True (memory only, same rows): the day's sorted buy table is freed once indexed by mint, and the leader
    buys are turned into records in blocks of EV_BLOCK rows instead of all at once, and the placebo is drawn from
    per-mint counts of non-candidate buys instead of a list of them (same index, same rng call); compact=False is the
    original."""
    candidates = leaders if candidates is None else candidates
    buys = swaps[(swaps["day"] == day) & swaps["is_buy"]].sort_values(["slot", "tx_idx", "ev_idx"], kind="mergesort")
    buys_by_mint = {m: {c: g[c].to_numpy() for c in ("slot", "tx_idx", "ev_idx", "owner", "sol", "q", "fee_bps")}
                    for m, g in buys.groupby("mint", sort=False)}
    lead = buys[buys["owner"].isin(leaders)]
    if compact:
        del buys
        records = (ev for b0 in range(0, len(lead), EV_BLOCK) for ev in lead.iloc[b0:b0 + EV_BLOCK].to_dict("records"))
    else:
        records = lead.to_dict("records")
    cols = ["day", "leader", "mint", "slot", "tx_idx", "ev_idx", "dropped", "follow", "follower_sol",
            "follower_sol_late", "placebo_owner", "placebo_slot", "placebo_follow", "q", "fee_bps", "placebo_late",
            "placebo_q"]
    if not with_follow:
        cols = [c for c in cols if c in PREP_EVENT_COLS]
    # compact: each row is kept as a tuple in column order with NaN for a missing field, which is what the
    # DataFrame constructor makes of a list of dicts (memory only; test_f1_counts.Compact checks the bytes)
    keep = (lambda o: tuple(o.get(c, np.nan) for c in cols)) if compact else (lambda o: o)
    rng = np.random.default_rng(seed)
    noncand_cs = {}
    rows = []
    for ev in records:
        out = {"day": day, "leader": ev["owner"], "mint": ev["mint"], "slot": ev["slot"],
               "tx_idx": ev["tx_idx"], "ev_idx": ev["ev_idx"]}
        lo, hi = ev["slot"] - PLACEBO_REACH, ev["slot"] + PLACEBO_REACH + FOLLOW_SLOTS
        if not covered(ranges, day, lo, hi):
            out["dropped"] = "window_not_on_tape"
            rows.append(keep(out))
            continue
        mb = buys_by_mint[ev["mint"]]
        i0 = np.searchsorted(mb["slot"], ev["slot"] - PLACEBO_REACH, side="left")
        i1 = np.searchsorted(mb["slot"], ev["slot"] + PLACEBO_REACH, side="right")
        if compact:
            # same draw without building the reach list: cs[t] = non-candidate buys of this mint before index t;
            # the k-th (0-based) non-candidate buy in [i0, i1) is reach[k] of the original
            cs = noncand_cs.get(ev["mint"])
            if cs is None:
                cs = noncand_cs[ev["mint"]] = np.concatenate(
                    ([0], np.cumsum(np.fromiter((o not in candidates for o in mb["owner"]), bool, len(mb["owner"])))))
            n_reach = int(cs[i1] - cs[i0])
            if not n_reach:
                out["dropped"] = "no_placebo_in_reach"
                rows.append(keep(out))
                continue
            k = int(rng.integers(n_reach))
            j = int(np.searchsorted(cs, cs[i0] + k + 1, side="left")) - 1
        else:
            reach = [i for i in range(i0, i1) if mb["owner"][i] not in candidates]
            if not reach:
                out["dropped"] = "no_placebo_in_reach"
                rows.append(keep(out))
                continue
            j = reach[int(rng.integers(len(reach)))]
        pick = {"mint": ev["mint"], "owner": mb["owner"][j], "slot": int(mb["slot"][j]),
                "tx_idx": int(mb["tx_idx"][j]), "ev_idx": int(mb["ev_idx"][j])}
        if not with_follow:
            out.update({"dropped": "", "placebo_owner": pick["owner"], "placebo_slot": pick["slot"],
                        "q": float(ev["q"]), "fee_bps": float(ev["fee_bps"]), "placebo_q": float(mb["q"][j])})
            rows.append(keep(out))
            continue
        f, v, late = follow_stats(buys_by_mint, ev, sol_pairs, mint_pairs)
        pf, _, plate = follow_stats(buys_by_mint, pick, sol_pairs, mint_pairs)
        out.update({"dropped": "", "follow": f, "follower_sol": v, "follower_sol_late": late,
                    "placebo_owner": pick["owner"], "placebo_slot": pick["slot"], "placebo_follow": pf,
                    # AMENDMENT_8: each buy's own Q and fee fields, and the placebo's late follower SOL
                    "q": float(ev["q"]), "fee_bps": float(ev["fee_bps"]), "placebo_late": plate,
                    "placebo_q": float(mb["q"][j])})
        rows.append(keep(out))
    return pd.DataFrame(rows, columns=cols)


EV_BLOCK = 50_000

PREP_EVENT_COLS = ("day", "leader", "mint", "slot", "tx_idx", "ev_idx", "dropped", "placebo_owner", "placebo_slot",
                   "q", "fee_bps", "placebo_q")


def run_prep(paths, day1=DAY1, compact=True):
    """--prep-only: loading, links, day-1 leader candidates and the day-1 candidate-buy table (drops and placebo
    draws) with their row counts. No follow count, follower SOL, leader test, day 2 (needs the followed set),
    payer bar or decision."""
    swaps, sol_pairs, mint_pairs, ranges, n_t, n_w = _load(paths, compact)
    cands = leader_candidates(swaps, day1)
    ev1 = event_table(swaps, cands, day1, ranges, sol_pairs, mint_pairs, with_follow=False, compact=compact)
    slots = {day1: sum(b - a + 1 for dd, a, b in ranges if dd == day1)}
    summary = {
        "mode": "prep-only",
        "units": [f"{d} {a}-{b}" for d, a, b in ranges],
        "slots_loaded": slots,
        "swaps_kept": int(len(swaps)),
        "swaps_kept_buys": int(swaps["is_buy"].sum()),
        "t_transfer_rows": int(n_t), "w_rows": int(n_w),
        "sol_link_pairs": len(sol_pairs), "mint_link_pairs": int(sum(len(v) for v in mint_pairs.values())),
        "leader_candidates_day1": len(cands),
        "day1_candidate_buys": int(len(ev1)), "day1_buys_with_placebo": int((ev1["dropped"] == "").sum()),
        "day1_dropped": ev1["dropped"].value_counts().to_dict(),
    }
    return summary, {"prep_events_day1": ev1}


BOOT_CHUNK_ELEMS = 1 << 23  # resample indices drawn per block (memory only: the draws and means are identical)


@_outcome
def _boot_means(d, n_boot, rng, chunk_elems):
    """Bootstrap means of d. chunk_elems=None draws the (n_boot, n) index matrix at once (original); otherwise in
    row blocks of about chunk_elems indices. Generator.integers draws each block from the same stream in the same
    order and each row mean is computed on its own row, so both give identical floats and leave rng in the same
    state (test_f1_counts.Compact)."""
    n = len(d)
    if chunk_elems is None:
        idx = rng.integers(0, n, size=(n_boot, n))
        return d[idx].mean(axis=1)
    rows = max(1, chunk_elems // n)
    parts = []
    for s0 in range(0, n_boot, rows):
        idx = rng.integers(0, n, size=(min(rows, n_boot - s0), n))
        parts.append(d[idx].mean(axis=1))
        del idx
    return np.concatenate(parts)


@_outcome
def leader_test(ev: pd.DataFrame, n_boot=BOOT_N, seed=BOOT_SEED, min_pairs=MIN_VALID_PAIRS,
                boot_chunk=BOOT_CHUNK_ELEMS) -> pd.DataFrame:
    """Per leader: mean follow - mean placebo follow, and the one-sided 99.5% lower bound (0.5% percentile)
    from a bootstrap over that leader's valid (buy, placebo) pairs that day.
    AMENDMENT_1 item 7: with fewer than `min_pairs` valid pairs the leader is untestable, which counts as not
    followed (day 1) or not persisting (day 2). Followed = testable, mean diff > 0 and lower bound > 0.
    `zero_variance` is reported only; the amendment keeps the percentile bound as the rule."""
    ok = ev[ev["dropped"] == ""]
    rng = np.random.default_rng(seed)
    out = []
    for leader, g in sorted(ok.groupby("leader"), key=lambda x: x[0]):
        d = (g["follow"].astype(float) - g["placebo_follow"].astype(float)).values
        n = len(d)
        testable = n >= min_pairs
        lb = None
        if testable:
            lb = float(np.quantile(_boot_means(d, n_boot, rng, boot_chunk), LOWER_Q))
        out.append({"leader": leader, "n_buys": n, "testable": testable, "mean_follow": float(g["follow"].mean()),
                    "mean_placebo": float(g["placebo_follow"].mean()), "diff": float(d.mean()),
                    "lb995": lb, "zero_variance": bool(np.all(d == d[0])),
                    "followed": bool(testable and d.mean() > 0 and lb > 0)})
    return pd.DataFrame(out, columns=["leader", "n_buys", "testable", "mean_follow", "mean_placebo", "diff", "lb995",
                                      "zero_variance", "followed"])


def _load(paths, compact):
    """(swaps, sol_pairs, mint_pairs, ranges, n_t, n_w) from the compact reader, or from the original one."""
    if compact:
        return load_units_compact(paths)
    swaps, t, w, ranges = load_units(paths)
    sol_pairs, mint_pairs = build_links(t, w)
    return swaps, sol_pairs, mint_pairs, ranges, len(t), len(w)


def run(paths, n_boot=BOOT_N, day1=DAY1, day2=DAY2, compact=True):
    """compact=False runs the original reader and one-shot bootstrap (kept for the equality test)."""
    swaps, sol_pairs, mint_pairs, ranges, _, _ = _load(paths, compact)
    boot_chunk = BOOT_CHUNK_ELEMS if compact else None
    cands = leader_candidates(swaps, day1)
    ev1 = event_table(swaps, cands, day1, ranges, sol_pairs, mint_pairs, compact=compact)
    lt1 = leader_test(ev1, n_boot, boot_chunk=boot_chunk)
    followed = set(lt1.loc[lt1["followed"], "leader"])
    ev2 = event_table(swaps, followed, day2, ranges, sol_pairs, mint_pairs, candidates=cands, compact=compact)
    lt2 = leader_test(ev2, n_boot, boot_chunk=boot_chunk)
    persistent = set(lt2.loc[lt2["followed"], "leader"])
    e2p = ev2[(ev2["dropped"] == "") & ev2["leader"].isin(persistent)]
    vol = int(e2p["follower_sol"].sum()) if len(e2p) else 0
    late = int(e2p["follower_sol_late"].sum()) if len(e2p) else 0
    slots = {d: sum(b - a + 1 for dd, a, b in ranges if dd == d) for d in (day1, day2)}
    summary = {
        "units": [f"{d} {a}-{b}" for d, a, b in ranges],
        "min_valid_pairs": MIN_VALID_PAIRS,
        "slots_loaded": slots,
        "swaps_kept": int(len(swaps)),
        "leader_candidates_day1": len(cands),
        "day1_candidate_buys": int(len(ev1)), "day1_buys_used": int((ev1["dropped"] == "").sum()),
        "day1_dropped": ev1["dropped"].value_counts().to_dict(),
        "untestable_day1": int((~lt1["testable"]).sum()) if len(lt1) else 0,
        "followed_day1": len(followed),
        "day2_buys_of_followed": int(len(ev2)), "day2_buys_used": int((ev2["dropped"] == "").sum()),
        "untestable_day2": int((~lt2["testable"]).sum()) if len(lt2) else 0,
        "persistent_day2": len(persistent),
        "persistent_share": (len(persistent) / len(followed)) if followed else None,
        "day2_persistent_leader_buys": int(len(e2p)),
        "day2_follower_sol": vol, "day2_follower_sol_late": late,
        "late_share": (late / vol) if vol else None,
        "payer_mass_bar": f1_payer_bar(e2p),   # COUNT_ROWS_AMENDMENT_8
    }
    return summary, {"events_day1": ev1, "leaders_day1": lt1, "events_day2": ev2, "leaders_day2": lt2}


SPEND_5USD = 41_925_205   # $5 at $119.26 (COUNT_ROWS_AMENDMENT_7)
FIXED_LAMPORTS = 414_009
PAYER_MEDIAN_MIN = 1.0
PAYER_EVENTS_AT_2X_PER_DAY = 11


@_outcome
def round_trip_share(q, fee_bps, x=SPEND_5USD) -> float:
    """s* = sqrt(1 + c) - 1, with c = 2 x the trade's own fee + the constant-product impact of a $5 buy and its sell
    on Q (x^2 / (Q + x) + x^2 / Q, against spot) + 414,009 / x (COUNT_ROWS_AMENDMENT_7 and 8)."""
    if not (np.isfinite(q) and np.isfinite(fee_bps)) or q <= 0:
        return float("nan")
    c = 2 * fee_bps / 1e4 + (x * x / (q + x) + x * x / q) / x + FIXED_LAMPORTS / x
    return float(np.sqrt(1 + c) - 1)


@_outcome
def f1_payer_bar(ev: pd.DataFrame) -> dict:
    """AMENDMENT_8 Q-R1-g on the day-2 buys of persistent leaders with a valid placebo: excess share = late follower SOL
    / Q - the placebo's late follower SOL / the placebo's Q; passes if median(excess / s*) >= 1 and on average at least
    11 events a day reach 2 s* (both ties pass; an undefined value never helps)."""
    n = len(ev)
    days = sorted(set(ev["day"])) if n else []
    if not n:
        return {"passed": None, "status": "not computed: no events", "events": 0}
    with np.errstate(divide="ignore", invalid="ignore"):
        exc = ev["follower_sol_late"].astype(float) / ev["q"].astype(float) \
            - ev["placebo_late"].astype(float) / ev["placebo_q"].astype(float)
    ss = np.array([round_trip_share(q, f) for q, f in zip(ev["q"].astype(float), ev["fee_bps"].astype(float))])
    exc = exc.to_numpy(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = exc / ss
    ok = np.isfinite(ratio) & (ss > 0)
    med = float(np.median(np.where(ok, ratio, -np.inf)))
    at2 = int((ok & (exc >= 2 * ss)).sum())
    per_day = at2 / len(days)
    return {"passed": bool(med >= PAYER_MEDIAN_MIN and per_day >= PAYER_EVENTS_AT_2X_PER_DAY), "events": int(n),
            "events_undefined": int((~ok).sum()), "median_ratio": med, "events_at_2x": at2,
            "events_at_2x_per_day": per_day, "days": days}


# PAYER_MASS.md (frozen) names F1: a necessary bar before any return. F1 has no hold window and no payer attribution
# yet, so the bar is not computed (open question, research/brainstorm-loop/CODE_REDTEAM.md R1-9).
PAYER_MASS_BAR = {"passed": None, "status": "not computed (run() computes it per COUNT_ROWS_AMENDMENT_8)"}


@_outcome
def decide(s, payer=PAYER_MASS_BAR):
    """GATE.md "Kill". Valid only on complete Step A days. `gate_passes` also needs the payer-mass bar
    (PAYER_MASS.md); a bar not computed (None) never passes, and never closes F1 either."""
    kills = {
        "fewer_than_20_followed_day1": s["followed_day1"] < KILL_MIN_FOLLOWED,
        "under_half_persist_day2": (s["persistent_share"] is None) or s["persistent_share"] < KILL_MIN_PERSIST_SHARE,
        "under_50pct_volume_after_23_slots": (s["late_share"] is None) or s["late_share"] < KILL_MIN_LATE_SHARE,
        "fewer_than_15_persistent_buys_a_day": s["day2_persistent_leader_buys"] < KILL_MIN_BUYS_PER_DAY,
    }
    closes = any(kills.values())
    return {"kills": kills, "f1_closes": closes, "payer_mass_bar": payer,
            "gate_passes": bool(not closes and payer["passed"] is True)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--unit", action="append", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--boot", type=int, default=BOOT_N)
    ap.add_argument("--decide", action="store_true", help="also apply the kill rules (only on complete Step A days)")
    ap.add_argument("--plan", default=DEFAULT_PLAN, help="committed Step A plan (checked with --decide)")
    ap.add_argument("--prep-only", action="store_true",
                    help="preparation stages only (no follow counts, statistics or decision); for real tape before the gate")
    ap.add_argument("--original-reader", action="store_true",
                    help="the original all-in-memory reader and one-shot bootstrap (equality tests only)")
    a = ap.parse_args(argv)
    compact = not a.original_reader
    if a.prep_only:
        if a.decide:
            ap.error("--prep-only and --decide exclude each other")
        global _PREP_ONLY
        _PREP_ONLY = True
        try:
            summary, tables = run_prep(a.unit, compact=compact)
        finally:
            _PREP_ONLY = False
        os.makedirs(a.out, exist_ok=True)
        for k, df in tables.items():
            df.to_csv(os.path.join(a.out, f"f1_{k}.csv"), index=False)
        with open(os.path.join(a.out, "f1_prep_summary.json"), "w") as fh:
            json.dump(summary, fh, indent=1, default=str)
        json.dump(summary, sys.stdout, indent=1, default=str)
        print()
        return
    plan_sha = None
    if a.decide:
        if a.boot != REGISTERED_BOOT:   # AMENDMENT_1 item 7: 10,000 resamples (red team R1-8)
            ap.error(f"--decide uses the registered {REGISTERED_BOOT} resamples; --boot {a.boot} is refused")
        try:
            plan_sha = check_plan([unit_info(u)[1:] for u in a.unit], a.plan)
        except PlanError as e:
            ap.error(f"--decide refused: {e}")
    summary, tables = run(a.unit, a.boot, compact=compact)
    if a.decide:
        summary["plan"] = {"path": a.plan, "sha256": plan_sha}
        summary["decision"] = decide(summary, payer=summary["payer_mass_bar"])
    os.makedirs(a.out, exist_ok=True)
    for k, df in tables.items():
        df.to_csv(os.path.join(a.out, f"f1_{k}.csv"), index=False)
    with open(os.path.join(a.out, "f1_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, default=str)
    json.dump(summary, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
