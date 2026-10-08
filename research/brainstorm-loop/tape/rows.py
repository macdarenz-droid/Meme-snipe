"""Step A count rows (research/brainstorm-loop/STEP_A_COUNT_ROWS.md, frozen).

Flows, counts and timing only. No strategy return, outcome or price change is computed.
Market-cap levels (row 6) are price levels read at each swap, never a change.
Every choice the frozen text leaves open is marked "Q<n>" and listed in OPEN_QUESTIONS.md.
"""
from __future__ import annotations

import re
import warnings
from collections import defaultdict, deque

import numpy as np
import pandas as pd

from tapeio import SOL_NATIVE, SOL_QUOTES, WSOL, Tape

LANDING = 23            # slots
HUB_CAP = 50            # SWEEP_1 creator-group rule
EFFECT = 0.034          # 3.4% of effective quote
BOOT_N = 10_000
SEED = 20261008
LAMPORTS = 1e9
warnings.filterwarnings("ignore", message="All-NaN slice", category=RuntimeWarning)


# ===================================================================== helpers
def boot_lb(stat, groups, n=BOOT_N, q=0.025, seed=SEED):
    """Percentile bootstrap lower bound of stat(*resampled groups); each group resampled on its own."""
    groups = [np.asarray(g, dtype=float) for g in groups]
    if any(len(g) == 0 for g in groups):
        return None
    rng = np.random.default_rng(seed)
    vals = np.empty(n)
    for i in range(n):
        vals[i] = stat(*[g[rng.integers(0, len(g), len(g))] for g in groups])
    return float(np.nanquantile(vals, q))


def adjacency(links: pd.DataFrame):
    adj = defaultdict(list)
    for a, b, s in zip(links["from_owner"].values, links["to_owner"].values, links["slot"].values):
        adj[a].append((b, int(s)))
        adj[b].append((a, int(s)))
    return adj


def degree_as_of(adj, node, slot):
    return len({n for n, s in adj.get(node, ()) if s <= slot})


def creator_group(adj, seeds, as_of_slot, hub_cap=HUB_CAP):
    """SWEEP_1 §4 / G1 AMENDMENT_1 Feature R(1): union-find on T and W links on or before the slot,
    seeded with the creator (and create `user`), never joining through an address linked to more than
    `hub_cap` owners. A hub is neither added nor crossed (Q7); a seed is always in its group."""
    seeds = {s for s in seeds if isinstance(s, str) and s}
    group, q = set(seeds), deque(seeds)
    while q:
        x = q.popleft()
        if x not in seeds and degree_as_of(adj, x, as_of_slot) > hub_cap:
            continue
        for y, s in adj.get(x, ()):
            if s > as_of_slot or y in group:
                continue
            if degree_as_of(adj, y, as_of_slot) > hub_cap:
                continue
            group.add(y)
            q.append(y)
    return group


def components(pairs_a, pairs_b):
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in zip(pairs_a, pairs_b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    return {x: find(x) for x in parent}


def first_time_flags(swaps: pd.DataFrame) -> pd.Series:
    """True on a buy that is the owner's first buy of the mint on the loaded tape (tape order).
    BOOST/protocol rows and rows with no owner are never first-time buys."""
    ok = swaps["is_buy"] & ~swaps["excluded"] & swaps["owner"].notna()
    b = swaps[ok]
    first = b.groupby(["mint", "owner"], sort=False)["order"].transform("min") == b["order"]
    out = pd.Series(False, index=swaps.index)
    out.loc[first[first].index] = True
    return out


def history_on_tape(tape: Tape, mint, slot):
    """Q2: a first-time buy is only known as first-time when the coin's CreateEvent is on the tape in the
    same contiguous run of units as `slot`."""
    r = tape.creates.loc[tape.creates["mint"] == mint, ["slot", "day"]]
    if not len(r):
        return False
    cs = int(r["slot"].iloc[0])
    return any(a <= cs <= b and a <= slot <= b for d, lst in tape.intervals.items() for a, b in lst)


def eff_quote(row):
    """Effective quote (vault + signed virtual_quote_reserves), after the swap (A amendment (a))."""
    q = row["pool_quote_post"] if pd.notna(row["pool_quote_post"]) else row["pool_quote_pre"]
    v = row["virtual_quote"] if pd.notna(row["virtual_quote"]) else 0.0
    return q + v


def eligible_pools(tape: Tape):
    """Canonical PumpSwap WSOL pools of pump graduates whose migration is on the tape, not mayhem
    (mayhem unknown is dropped, Q4). Returns DataFrame of pool, mint, m_slot, m_time."""
    s = tape.swaps
    canon = set(s.loc[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL), "pool"].dropna())
    rows = []
    for r in tape.migrations.itertuples(index=False):
        if r.pool not in canon or r.quote_mint not in SOL_QUOTES:
            continue
        if tape.mayhem_of_mint(r.mint) != 0:
            continue
        rows.append({"pool": r.pool, "mint": r.mint, "m_slot": r.slot, "m_time": r.block_time, "day": r.day})
    return pd.DataFrame(rows, columns=["pool", "mint", "m_slot", "m_time", "day"])


def slot_at_time(tape: Tape, t):
    b = tape.blocks
    i = np.searchsorted(b["block_time"].values, t, side="left")
    return int(b["slot"].values[i]) if i < len(b) else None


# ============================================== row 5: two-sided cluster label (MM-FLOOR, WASH-ECHO)
TWO_SIDED_SLOTS = 600   # Q12: "short window" is not fixed; F1's 600-slot window is used


def cluster_maps(tape: Tape, hub_cap=HUB_CAP):
    """Two cluster rules over all T/W links on the loaded tape (Q11: not as-of; label only).
    hub-cap-50: components after removing every edge that touches an address linked to > hub_cap owners.
    hub-keyed: each owner linked to a hub (an address linked to > hub_cap owners) is keyed by the hub of
    its earliest hub link; owners with the same key form one cluster (Q11)."""
    L = tape.links
    deg = pd.concat([L[["from_owner", "to_owner"]].rename(columns={"from_owner": "a", "to_owner": "b"}),
                     L[["to_owner", "from_owner"]].rename(columns={"to_owner": "a", "from_owner": "b"})])
    deg = deg.drop_duplicates().groupby("a").size()
    hubs = set(deg[deg > hub_cap].index)
    keep = ~L["from_owner"].isin(hubs) & ~L["to_owner"].isin(hubs)
    capped = components(L.loc[keep, "from_owner"].values, L.loc[keep, "to_owner"].values)
    hl = L[L["from_owner"].isin(hubs) ^ L["to_owner"].isin(hubs)]
    hub = np.where(hl["from_owner"].isin(hubs), hl["from_owner"], hl["to_owner"])
    other = np.where(hl["from_owner"].isin(hubs), hl["to_owner"], hl["from_owner"])
    # each owner is keyed by the hub of its earliest hub link (no chaining across hubs)
    hk = pd.DataFrame({"owner": other, "hub": hub, "slot": hl["slot"].values}).sort_values("slot", kind="mergesort")
    hk = hk.drop_duplicates("owner")
    keyed = dict(zip(hk["owner"], "hub:" + hk["hub"]))
    return {"hub_cap_50": capped, "hub_keyed": keyed}, hubs


def two_sided_clusters(tape: Tape, window=TWO_SIDED_SLOTS):
    """Clusters (>= 2 owners) whose members both buy and sell the same mint within `window` slots.
    Returns (labels, summary). labels: DataFrame (rule, mint, owner) of owners in such clusters."""
    maps, hubs = cluster_maps(tape)
    s = tape.swaps[~tape.swaps["excluded"] & tape.swaps["owner"].notna() & tape.swaps["sol_quoted"]]
    total_vol = float(s["sol"].sum())
    labels, summary = [], {}
    for rule, cmap in maps.items():
        sizes = pd.Series(cmap).value_counts()
        multi = set(sizes[sizes >= 2].index)
        x = s.assign(cluster=s["owner"].map(cmap))
        x = x[x["cluster"].isin(multi)]
        flagged = []
        for (cl, mint), g in x.groupby(["cluster", "mint"], sort=False):
            if g["is_buy"].all() or (~g["is_buy"]).all():
                continue
            bs = np.sort(g.loc[g["is_buy"], "slot"].values)
            ss = g.loc[~g["is_buy"], "slot"].values
            i = np.searchsorted(bs, ss - window, side="left")
            hit = (i < len(bs)) & (bs[np.minimum(i, len(bs) - 1)] <= ss + window)
            if hit.any():
                flagged.append((cl, mint, float(g["sol"].sum()), g["owner"].nunique()))
                for o in g["owner"].unique():
                    labels.append((rule, mint, o))
        f = pd.DataFrame(flagged, columns=["cluster", "mint", "sol", "n_owners"])
        csize = sizes.reindex(f["cluster"].unique()) if len(f) else pd.Series(dtype=float)
        summary[rule] = {
            "hubs": len(hubs), "clusters_ge2": len(multi),
            "two_sided_cluster_mints": int(len(f)), "two_sided_clusters": int(f["cluster"].nunique()) if len(f) else 0,
            "volume_share": (float(f["sol"].sum()) / total_vol) if total_vol else None,
            "cluster_size_quantiles": {str(q): float(csize.quantile(q)) for q in (0.5, 0.9, 0.99, 1.0)} if len(csize) else {},
            "cluster_size_counts": {str(k): int(v) for k, v in csize.value_counts().sort_index().items()} if len(csize) else {},
        }
    return pd.DataFrame(labels, columns=["rule", "mint", "owner"]), summary


def fake_demand_set(labels: pd.DataFrame):
    """Q13: an owner is excluded from first-time-buyer counts on a mint if either rule labels it."""
    return set(zip(labels["mint"], labels["owner"]))


# ============================================================ prepared swaps
def prepare(tape: Tape, labels: pd.DataFrame):
    s = tape.swaps
    s["ftb"] = first_time_flags(s)
    fake = fake_demand_set(labels)
    s["fake"] = [(m, o) in fake for m, o in zip(s["mint"].values, s["owner"].values)] if len(fake) else False
    first_buy = s[s["is_buy"] & ~s["excluded"] & s["owner"].notna()].groupby(["mint", "owner"])["order"].min()
    s["first_buy_order"] = pd.MultiIndex.from_arrays([s["mint"], s["owner"]]).map(first_buy.to_dict()).astype(float)
    return s


def by_pool(s):
    return {p: g.sort_values("order") for p, g in s[s["venue"] == "amm"].groupby("pool", sort=False)}


# ============================================================ row 1: DEV-ZERO
DEV_ARMS = [  # frozen order
    ("le5", 0.05, 0.042),
    ("zero", None, None),
    ("le3", 0.03, 0.024),
]
DEV_WINDOW_S = 15 * 60
DEV_MIN_AGE_S = 60 * 60
NEAR_FULL_LEFT = 0.10   # Q5: "leave 0-10%" read as 0 < post <= 10% of the dev's pre-sale holding


def dev_zero(tape: Tape, s: pd.DataFrame, adj, require_history=True):
    pools = eligible_pools(tape).set_index("pool")
    pp = by_pool(s)
    cand = []
    for pool, g in pp.items():
        if pool not in pools.index:
            continue
        m_time = pools.at[pool, "m_time"]
        sells = g[~g["is_buy"] & ~g["excluded"] & (g["owner"] == g["creator"]) & g["supply"].gt(0)
                  & (g["block_time"] - m_time >= DEV_MIN_AGE_S)]
        if not len(sells):
            continue
        pre = sells["owner_token_pre"] / sells["supply"]
        post = sells["owner_token_post"] / sells["supply"]
        for arm, cut, plc in DEV_ARMS:
            if arm == "zero":
                ev = (pre > 0) & (post == 0)
                ct = (post > 0) & (sells["owner_token_post"] <= NEAR_FULL_LEFT * sells["owner_token_pre"])
            else:
                ev = (pre >= cut) & (post < cut)
                ct = (pre >= plc) & (post < plc) & ~(pre >= cut)   # Q6: placebo crossings that also cross the cutoff are events only
            for kind, mask in (("event", ev), ("control", ct)):
                if mask.any():   # Q8: first crossing per pool, arm and kind
                    r = sells[mask].iloc[0]
                    cand.append((arm, kind, pool, r))
    rows = []
    for arm, kind, pool, r in cand:
        g = pp[pool]
        e_slot, e_time, e_order = int(r["slot"]), int(r["block_time"]), int(r["order"])
        out = {"arm": arm, "kind": kind, "pool": pool, "mint": r["mint"], "day": r["day"], "slot": e_slot,
               "block_time": e_time, "dev": r["owner"], "share_pre": r["owner_token_pre"] / r["supply"],
               "share_post": r["owner_token_post"] / r["supply"], "dropped": ""}
        if not tape.covered(e_slot, e_time + DEV_WINDOW_S):
            out["dropped"] = "window_not_on_tape"
        elif require_history and not history_on_tape(tape, r["mint"], e_slot):
            out["dropped"] = "history_not_on_tape"
        win = g[(g["order"] > e_order) & (g["block_time"] <= e_time + DEV_WINDOW_S)]
        if kind == "control" and arm == "zero" and not out["dropped"]:
            if ((win["owner"] == r["owner"]) & ~win["is_buy"]).any():
                out["dropped"] = "dev_sold_again_in_window"
        if out["dropped"]:
            rows.append(out)
            continue
        seeds = {r["owner"], r["creator"]}
        cr = tape.creates[tape.creates["mint"] == r["mint"]]
        if len(cr):
            seeds |= {cr["creator"].iloc[0], cr["user"].iloc[0]}
        grp = creator_group(adj, seeds, e_slot)
        w = win[~win["excluded"] & win["sol_quoted"] & ~win["owner"].isin(grp) & win["owner"].notna()]
        late = w["slot"] > e_slot + LANDING
        ftb = w["is_buy"] & w["ftb"] & ~w["fake"]
        holder = ~w["is_buy"] & ~(w["first_buy_order"] > e_order)
        eq = eff_quote(r)
        out.update({"eff_quote": eq, "ftb_sol_all": float(w.loc[ftb, "sol"].sum()),
                    "ftb_sol_late": float(w.loc[ftb & late, "sol"].sum()),
                    "holder_sell_late": float(w.loc[holder & late, "sol"].sum()), "group_size": len(grp)})
        out["net"] = (out["ftb_sol_late"] - out["holder_sell_late"]) / eq if eq > 0 else np.nan
        rows.append(out)
    df = pd.DataFrame(rows)
    summ = {}
    for arm, _, _ in DEV_ARMS:
        a = df[(df.get("arm") == arm)] if len(df) else df
        e = a[(a["kind"] == "event") & (a["dropped"] == "")] if len(a) else a
        c = a[(a["kind"] == "control") & (a["dropped"] == "")] if len(a) else a
        en = e["net"].dropna().values if len(e) else np.array([])
        cn = c["net"].dropna().values if len(c) else np.array([])
        med = float(np.median(en) - np.median(cn)) if len(en) and len(cn) else None
        lb = boot_lb(lambda x, y: np.median(x) - np.median(y), [en, cn]) if med is not None else None
        fa = float(e["ftb_sol_all"].sum()) if len(e) else 0.0
        days = sorted(set(e["day"])) if len(e) else []
        summ[arm] = {
            "events_found": int((a["kind"] == "event").sum()) if len(a) else 0,
            "controls_found": int((a["kind"] == "control").sum()) if len(a) else 0,
            "events_used": int(len(en)), "controls_used": int(len(cn)),
            "dropped": a["dropped"].value_counts().to_dict() if len(a) else {},
            "median_net_excess": med, "lb95": lb,
            "late_share_of_ftb": (float(e["ftb_sol_late"].sum()) / fa) if fa else None,
            "events_per_day": {d: int((e["day"] == d).sum()) for d in days},
        }
    return df, summ


def dev_zero_decide(summ):
    out = {}
    for arm, _, _ in DEV_ARMS:
        x = summ[arm]
        out[arm] = bool(x["median_net_excess"] is not None and x["median_net_excess"] >= EFFECT
                        and x["lb95"] is not None and x["lb95"] > 0
                        and x["late_share_of_ftb"] is not None and x["late_share_of_ftb"] >= 0.5
                        and x["events_per_day"] and min(x["events_per_day"].values()) >= 11)
    return out


# ============================================================ row 2: REBUY-ANCHOR (price-free parts only)
REBUY_S = 2 * 3600
REBUY_BLOCKED = [
    "odds of a rebuy below vs above the sale price (needs a price comparison; Q14)",
    "odds for gain-sellers vs loss-sellers (needs realised gain, a return; Q14)",
    "share of GAIN ex-holders who rebuy once BELOW the sale price (Q14)",
    "predicted net rebuy SOL, P90 vs median of the rebuy-pressure measure (measure not defined; Q15)",
    "decisions a day in the top quintile (same measure; Q15)",
    "R^2 on past returns, drawdown, age and depth (needs returns; Q14)",
]


def rebuy_anchor(tape: Tape, s: pd.DataFrame):
    """Ex-holder exits (a sell leaving the owner with 0 of the mint) and whether the same owner buys the
    mint again within 2 h; proceeds readability. No price, gain or return is read."""
    x = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
    sells = x[~x["is_buy"] & (x["owner_token_pre"] > 0) & (x["owner_token_post"] == 0)]
    buys = x[x["is_buy"]]
    bt = {k: g["block_time"].values for k, g in buys.groupby(["mint", "owner"], sort=False)}
    rows = []
    for r in sells.itertuples(index=False):
        covered = tape.covered(int(r.slot), int(r.block_time) + REBUY_S)
        t = bt.get((r.mint, r.owner))
        reb = bool(t is not None and ((t > r.block_time) & (t <= r.block_time + REBUY_S)).any())
        rows.append({"day": r.day, "mint": r.mint, "owner": r.owner, "slot": r.slot, "block_time": r.block_time,
                     "exit_sol": r.sol, "signer_is_owner": r.signer == r.owner,
                     "proceeds_readable": bool(r.signer == r.owner and pd.notna(r.signer_sol_post)),
                     "window_on_tape": covered, "rebuy_2h": reb if covered else None})
    df = pd.DataFrame(rows, columns=["day", "mint", "owner", "slot", "block_time", "exit_sol", "signer_is_owner",
                                     "proceeds_readable", "window_on_tape", "rebuy_2h"])
    tot = float(df["exit_sol"].sum()) if len(df) else 0.0
    u = df[df["window_on_tape"]].copy() if len(df) else df
    by_size = {}
    if len(u) >= 3:
        u["size_tercile"] = pd.qcut(u["exit_sol"].rank(method="first"), 3, labels=["low", "mid", "high"])
        by_size = {str(k): {"exits": int(len(g)), "rebuy_2h_share": float(g["rebuy_2h"].mean())}
                   for k, g in u.groupby("size_tercile", observed=True)}
    summ = {
        "exits": int(len(df)), "exits_with_2h_on_tape": int(len(u)),
        "rebuy_2h_share_unconditional": float(u["rebuy_2h"].mean()) if len(u) else None,
        "by_exit_size_tercile_descriptive": by_size,
        "proceeds_readable_share": (float(df.loc[df["proceeds_readable"], "exit_sol"].sum()) / tot) if tot else None,
        "not_computed_pending_ruling": REBUY_BLOCKED,
    }
    return df, summ


# ============================================================ row 3: SEAT-DRIFT
N_HALF_S = 90


def _norm_name(x):
    return re.sub(r"[^a-z0-9]", "", str(x).lower()) if isinstance(x, str) else ""


def seat_drift(tape: Tape, s: pd.DataFrame, adj, require_history=True):
    pools = eligible_pools(tape)
    pp = by_pool(s)
    names = {}
    for j in tape.events:
        if j["event"] == "CreateEvent":
            f = j["fields"]
            names[f.get("mint")] = (_norm_name(f.get("name")), _norm_name(f.get("symbol")))
    cre = tape.creates.set_index("mint")
    pc = tape.pool_creates.set_index("pool")

    def seeds(mint, pool):
        out = set()
        if mint in cre.index:
            out |= {cre.at[mint, "creator"], cre.at[mint, "user"]}
        if pool in pc.index:
            out.add(pc.at[pool, "coin_creator"])
        return {x for x in out if isinstance(x, str) and x and x != SOL_NATIVE}

    rows = []
    for r in pools.itertuples(index=False):
        m, ms = int(r.m_time), int(r.m_slot)
        out = {"pool": r.pool, "mint": r.mint, "day": r.day, "m_slot": ms, "m_time": m, "dropped": ""}
        if not (tape.covered_back(ms, m - N_HALF_S) and tape.covered(ms, m + 7200)):
            out["dropped"] = "window_not_on_tape"
            rows.append(out)
            continue
        if require_history and not history_on_tape(tape, r.mint, ms):
            out["dropped"] = "history_not_on_tape"
            rows.append(out)
            continue
        others = pools[(pools["pool"] != r.pool) & (pools["m_time"] >= m - N_HALF_S) & (pools["m_time"] <= m + N_HALF_S)]
        nm = names.get(r.mint)
        if nm and any(nm[0] and (names.get(o, ("", ""))[0] == nm[0] or names.get(o, ("", ""))[1] == nm[1])
                      for o in others["mint"]):
            out["dropped"] = "theme_wave_name_match"   # G1-CAP exclusion (Q10)
            rows.append(out)
            continue
        grp = creator_group(adj, seeds(r.mint, r.pool), ms)
        n_m = sum(1 for o in others.itertuples(index=False) if not (seeds(o.mint, o.pool) & grp))
        g = pp.get(r.pool, pd.DataFrame(columns=s.columns))
        res = {"N_m": n_m}
        for name, t0, t1, plus23 in (("w1", m + 3600, m + 7200, True), ("w2", m + 2400, m + 3600, False)):
            s0 = slot_at_time(tape, t0)
            w = g[(g["block_time"] <= t1) & ((g["slot"] > s0 + LANDING) if plus23 else (g["block_time"] >= t0))]
            w = w[w["is_buy"] & w["ftb"] & ~w["fake"] & ~w["excluded"]]
            before = g[g["block_time"] <= t0]
            eq = eff_quote(before.iloc[-1]) if len(before) else np.nan
            res[f"{name}_ftb_sol"] = float(w["sol"].sum())
            res[f"{name}_eff_quote"] = eq
            res[f"{name}_share"] = res[f"{name}_ftb_sol"] / eq if eq and eq > 0 else np.nan
        out.update(res)
        rows.append(out)
    df = pd.DataFrame(rows)
    ok = df[df["dropped"] == ""] if len(df) else df
    busy = ok[ok["N_m"] >= 1] if len(ok) else ok      # Q9: busy = N_m >= 1, lone = N_m == 0
    lone = ok[ok["N_m"] == 0] if len(ok) else ok

    def diff(col):
        b, l_ = busy[col].dropna().values if len(busy) else [], lone[col].dropna().values if len(lone) else []
        if not len(b) or not len(l_):
            return None, None
        return float(np.median(b) - np.median(l_)), boot_lb(lambda x, y: np.median(x) - np.median(y), [b, l_])

    d1, lb1 = diff("w1_share")
    d2, _ = diff("w2_share")
    summ = {"graduates": int(len(df)), "used": int(len(ok)), "busy": int(len(busy)), "lone": int(len(lone)),
            "dropped": df["dropped"].value_counts().to_dict() if len(df) else {},
            "w1_busy_minus_lone_median": d1, "w1_lb95": lb1, "w2_busy_minus_lone_median": d2,
            "drift_all_w1_median_share": float(ok["w1_share"].median()) if len(ok) else None}
    return df, summ


def seat_drift_decide(summ):
    return bool(summ["w1_busy_minus_lone_median"] is not None and summ["w1_busy_minus_lone_median"] >= EFFECT
                and summ["w1_lb95"] is not None and summ["w1_lb95"] > 0
                and summ["w2_busy_minus_lone_median"] is not None and summ["w2_busy_minus_lone_median"] >= 0)


# ============================================================ W1 latency class
def w1_fast_class(tape: Tape, s: pd.DataFrame):
    """W1 PREREG §5: fast on a day if >= 10% of its buys land within 2 slots of the mint's create or
    migration, or >= 30% land within 2 slots after another trader's buy of >= 1 SOL on the same mint."""
    b = s[s["is_buy"] & ~s["excluded"] & s["owner"].notna()][["day", "mint", "owner", "slot", "order", "sol"]].copy()
    anchors = pd.concat([tape.creates[["mint", "slot"]], tape.migrations[["mint", "slot"]]]).rename(columns={"slot": "a"})
    near = b.merge(anchors, on="mint", how="left")
    near = near[(near["slot"] - near["a"]).between(0, 2)]
    b["near_anchor"] = b["order"].isin(set(near["order"]))
    big = b[b["sol"] >= LAMPORTS][["mint", "owner", "slot", "order"]].rename(
        columns={"owner": "bo", "slot": "bs", "order": "bord"})
    hits = []
    for k in (0, 1, 2):
        x = b.assign(bs=b["slot"] - k).merge(big, on=["mint", "bs"])
        hits.append(x.loc[(x["bo"] != x["owner"]) & (x["bord"] < x["order"]), "order"])
    b["after_big"] = b["order"].isin(set(pd.concat(hits))) if hits else False
    g = b.groupby(["day", "owner"]).agg(n=("order", "size"), na=("near_anchor", "mean"), nb=("after_big", "mean"))
    g["fast"] = (g["na"] >= 0.10) | (g["nb"] >= 0.30)
    return g["fast"]


# ============================================================ row 4: AGE-GATE
ROUND_MIN = [5, 10, 15, 30, 60]
PLACEBO_OFF = [3, 4, 5, 7, 11]
AGE_W_S = 60   # Q16: the "around" window is not fixed; +/-60 s


def age_gate(tape: Tape, s: pd.DataFrame, fast):
    """Step in first-time buyer SOL at round coin ages (from create and from migration) vs local placebo ages,
    by W1 class. Step(x) = FTB SOL in [x, x+w) - FTB SOL in [x-w, x)."""
    fb = s[s["is_buy"] & s["ftb"] & ~s["fake"] & ~s["excluded"] & s["sol_quoted"]].copy()
    fb["cls"] = ["fast" if fast.get((d, o), False) else "slow" for d, o in zip(fb["day"], fb["owner"])]
    by_mint = {m: g for m, g in fb.groupby("mint", sort=False)}
    anchors = [("create", r.mint, int(r.slot), int(r.block_time)) for r in tape.creates.itertuples(index=False)]
    anchors += [("migration", r.mint, int(r.m_slot), int(r.m_time)) for r in eligible_pools(tape).itertuples(index=False)]
    rows = []
    for kind, mint, aslot, at in anchors:
        g = by_mint.get(mint)
        for a in ROUND_MIN:
            ages = [("round", a)] + [("placebo", a + sgn * o) for o in PLACEBO_OFF for sgn in (-1, 1)
                                     if a + sgn * o > 0 and a + sgn * o not in ROUND_MIN]   # Q17
            for typ, age in ages:
                x = at + age * 60
                if not (tape.covered_back(aslot, x - AGE_W_S) and tape.covered(aslot, x + AGE_W_S)):
                    continue
                for cls in ("fast", "slow"):
                    if g is None:
                        step = 0.0
                    else:
                        h = g[g["cls"] == cls]
                        step = float(h.loc[(h["block_time"] >= x) & (h["block_time"] < x + AGE_W_S), "sol"].sum()
                                     - h.loc[(h["block_time"] >= x - AGE_W_S) & (h["block_time"] < x), "sol"].sum())
                    rows.append({"anchor": kind, "mint": mint, "round_min": a, "type": typ, "age_min": age,
                                 "cls": cls, "step_sol": step / LAMPORTS})
    df = pd.DataFrame(rows, columns=["anchor", "mint", "round_min", "type", "age_min", "cls", "step_sol"])
    summ = []
    for (k, a, c), g in df.groupby(["anchor", "round_min", "cls"]):
        r = g[g["type"] == "round"]["step_sol"]
        p = g[g["type"] == "placebo"].groupby("age_min")["step_sol"].mean()
        summ.append({"anchor": k, "round_min": int(a), "cls": c, "coins": int(r.size),
                     "mean_step_round": float(r.mean()) if r.size else None,
                     "median_placebo_mean_step": float(p.median()) if p.size else None,
                     "round_minus_placebo": float(r.mean() - p.median()) if r.size and p.size else None})
    return df, summ


# ============================================================ row 6: round-USD check (Design A)
A_LEVEL = 420.0
A_LADDER = 1470.0
USD_LEVELS = (50_000.0, 100_000.0)


def placebo_grid(day_levels=()):
    """Design A gate 2: 20 cutoffs on a log grid 340-1,300 SOL, each > 10% from 420 and 1,470 (Q18: the
    grid is 20 points and the exclusions then thin it). Amendment: drop cutoffs within 10% of the day's
    USD levels."""
    g = np.geomspace(340.0, 1300.0, 20)
    keep = [c for c in g if all(abs(c / x - 1) > 0.10 for x in (A_LEVEL, A_LADDER))]
    return [float(c) for c in keep if all(abs(c / x - 1) > 0.10 for x in day_levels)]


def mcap_segments(tape: Tape, s: pd.DataFrame):
    """Per eligible pool: time segments [t, t_next) holding the market cap in SOL after each swap, for
    hours 0-72 after migration, outside the BOOST window (A amendment (b)). Market cap = effective quote
    / pool base * supply (Q19)."""
    pools = eligible_pools(tape)
    pp = by_pool(s)
    segs = []
    for r in pools.itertuples(index=False):
        g = pp.get(r.pool)
        if g is None or not len(g):
            continue
        bst = tape.boosts[tape.boosts["pool"] == r.pool]["block_time"]
        start = int(bst.max()) if len(bst) else int(r.m_time) + 300
        end_cap = int(r.m_time) + 72 * 3600
        end_tape = max((t1 for (d, a, b), (t0, t1) in tape.interval_times.items() if a <= r.m_slot <= b and t1), default=None)
        if end_tape is None:
            continue
        end = min(end_cap, end_tape)
        q = g["pool_quote_post"].fillna(g["pool_quote_pre"].shift(-1)) + g["virtual_quote"].fillna(0)
        bse = g["pool_base_post"].fillna(g["pool_base_pre"].shift(-1))
        mc = q / bse * g["supply"] / LAMPORTS
        t = g["block_time"].values
        tn = np.append(t[1:], end)
        for ti, tj, mci, sig, own, buy, sol in zip(t, tn, mc.values, g["signer"].values, g["owner"].values,
                                                    g["is_buy"].values, g["sol"].values):
            a_, b_ = max(ti, start), min(tj, end)
            segs.append({"pool": r.pool, "mint": r.mint, "day": r.day, "t0": a_, "t1": max(a_, b_), "mcap": mci})
    return pd.DataFrame(segs, columns=["pool", "mint", "day", "t0", "t1", "mcap"])


def band_time(seg, lo, hi):
    d = (seg["t1"] - seg["t0"]).clip(lower=0)
    return float(d[(seg["mcap"] >= lo) & (seg["mcap"] < hi)].sum()), float(d.sum())


def log_ratio(seg, L):
    up, tot = band_time(seg, L, 1.05 * L)
    dn, _ = band_time(seg, 0.95 * L, L)
    return float(np.log(up / dn)) if up > 0 and dn > 0 else np.nan


def round_usd(tape: Tape, s: pd.DataFrame, sol_usd: dict | None, adj, n_boot=BOOT_N):
    """Bunching at the SOL levels equal to $50k and $100k each tape day, with the day's placebo grid;
    flags 420 within 5% of a round USD level; Gate 3 focused-vs-spread creator split (descriptive)."""
    days = sorted({d for d, _, _ in tape.ranges})
    if not sol_usd:
        return pd.DataFrame(), {"status": "needs SOL/USD per day (--sol-usd CSV from the Binance public archive)",
                                "days": days}
    seg = mcap_segments(tape, s)
    out, flags = [], {}
    for d in days:
        px = sol_usd.get(d)
        if px is None:
            flags[d] = None
            continue
        lv = [u / px for u in USD_LEVELS]
        flags[d] = any(abs(A_LEVEL / L - 1) <= 0.05 for L in lv)
        grid = placebo_grid(lv)
        sd = seg[seg["day"] == d]
        plist = list(sd["pool"].unique())
        for usd, L in zip(USD_LEVELS, lv):
            def stat(pools_sample):
                x = pd.concat([sd[sd["pool"] == p] for p in pools_sample]) if len(pools_sample) else sd.iloc[:0]
                lr = log_ratio(x, L)
                pl = np.nanmedian([log_ratio(x, c) for c in grid]) if grid else np.nan
                return lr - pl
            point = stat(plist)
            lb = None
            if plist and n_boot:
                rng = np.random.default_rng(SEED)
                vals = [stat([plist[i] for i in rng.integers(0, len(plist), len(plist))]) for _ in range(n_boot)]
                lb = float(np.nanquantile(vals, 0.025)) if np.isfinite(vals).any() else None
            out.append({"day": d, "sol_usd": px, "usd_level": usd, "sol_level": L, "pools": len(plist),
                        "placebos": len(grid), "bunching_logratio_minus_placebo": point, "lb95": lb})
    gate3 = gate3_split(tape, s, seg, adj)
    summ = {"days": days, "a_within_5pct_of_round_usd": flags,
            "a_not_separable_from_usd_level": bool(flags and all(v is True for v in flags.values())),
            "gate3_focused_vs_spread": gate3}
    return pd.DataFrame(out), summ


def gate3_split(tape: Tape, s: pd.DataFrame, seg: pd.DataFrame, adj):
    """Design A gate 3 measure (coin_creator's net SOL buying per hour while the pool sits in [399, 441),
    minus the median of the same in +/-5% bands around the placebo cutoffs), split by creators focused on
    one coin vs spread over several (same creator-group definition; Q20). CF collections are reported."""
    grid = placebo_grid()
    roles = defaultdict(set)
    for r in tape.creates.itertuples(index=False):
        roles[r.creator].add(r.mint)
    for r in s[s["creator"].notna()][["creator", "mint"]].drop_duplicates().itertuples(index=False):
        roles[r.creator].add(r.mint)
    cf_by = tape.cf.groupby("creator").size().to_dict() if len(tape.cf) else {}
    pp = by_pool(s)
    end_slot = max(b for _, _, b in tape.ranges)
    rows = []
    for pool, sg in seg.groupby("pool"):
        g = pp[pool]
        cc = g["creator"].dropna()
        if not len(cc):
            continue
        cc = cc.iloc[-1]
        prev_mc = sg["mcap"].shift(1).values   # market cap in force when each swap lands

        def measure(lo, hi):
            secs, _ = band_time(sg, lo, hi)
            if secs <= 0:
                return np.nan
            mine = ((g["signer"] == cc) | (g["owner"] == cc)).values & ~g["excluded"].values
            inb = (prev_mc >= lo) & (prev_mc < hi)
            n = len(prev_mc)
            m_, b_, sol = mine[:n], inb, np.nan_to_num(g["sol"].values[:n])
            buy = g["is_buy"].values[:n]
            net = float(sol[m_ & b_ & buy].sum() - sol[m_ & b_ & ~buy].sum())
            return net / LAMPORTS / (secs / 3600)

        main = measure(399.0, 441.0)
        plc = np.nanmedian([measure(0.95 * c, 1.05 * c) for c in grid]) if grid else np.nan
        grp = creator_group(adj, {cc}, end_slot)
        coins = set().union(*(roles.get(x, set()) for x in grp))
        rows.append({"pool": pool, "coin_creator": cc, "group_size": len(grp), "group_coins": len(coins),
                     "class": "spread" if len(coins) >= 2 else "focused",
                     "group_cf_collections": int(sum(cf_by.get(x, 0) for x in grp)),
                     "measure_minus_placebo": main - plc if np.isfinite(main) and np.isfinite(plc) else np.nan})
    df = pd.DataFrame(rows)
    if not len(df):
        return {}
    return {c: {"pools": int(len(g)), "pools_with_measure": int(g["measure_minus_placebo"].notna().sum()),
                "median": float(g["measure_minus_placebo"].median()) if g["measure_minus_placebo"].notna().any() else None,
                "cf_collections": int(g["group_cf_collections"].sum())}
            for c, g in df.groupby("class")}
