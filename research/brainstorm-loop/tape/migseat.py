"""MIG-SEAT and MAYHEM-SNAP count rows (research/brainstorm-loop/COUNT_ROWS_AMENDMENT_5.md, frozen; amendment 6
moves MAYHEM-SNAP's owner ruling to "before any bot use").

Counts, flows, timing and auction (re-price) steps only; no price path after an entry slot and no wallet P&L.
Slot times are read from the B table per slot, never assumed.
"""
from __future__ import annotations

from collections import Counter, defaultdict, deque

import numpy as np
import pandas as pd

import h8 as H8
import rows as R
from tapeio import SOL_QUOTES, WSOL, Tape

MAYHEM_PROGRAM = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"          # packages/core/src/gates/holders.ts
MAYHEM_VAULT_OWNER = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s"
BUYBACK_AUTHORITY_PREFIX = "GmFrDZT2"                                     # tape README: the buyback authority
GRADUAL_S = 5
SEAT_SLOTS = 2
TOLL_MAX = 5_000_000              # 0.005 SOL
RACER_SLOTS, RACER_MAX = 3, 10
RACER_CLASSES = ("slippage", "state")
SELL_SHARE, SELL_MAX = 0.05, 0.5
PAYER_WINDOW_S = 60
COST_C = 0.035
BOOST_WINDOW_S, BOOST_MIN = 300, 0.8
COUNT_MIN = 100
KILL_SHARE = 2 / 3


def x_star(q, c=COST_C):
    return q * (np.sqrt(1 + c) - 1)


def slot_time(tape: Tape, slot):
    b = tape.blocks
    i = np.searchsorted(b["slot"].values, slot, side="left")
    return int(b["block_time"].values[i]) if i < len(b) and b["slot"].values[i] == slot else None


def w_group(tape: Tape, seeds, as_of_slot, hops=2):
    """AMENDMENT_5 creator group: the LAUNCHER-ID set (create `creator` and `user`, pool `coin_creator`) plus every
    address within 2 W (SOL) links, on or before the slot. No hub cap is named, so none is applied (Q29)."""
    adj = defaultdict(set)
    w = tape.w_links[tape.w_links["slot"] <= as_of_slot]
    for a, b in zip(w["from_owner"].values, w["to_owner"].values):
        adj[a].add(b)
        adj[b].add(a)
    seen = {x for x in seeds if isinstance(x, str) and x}
    q = deque((x, 0) for x in seen)
    while q:
        x, d = q.popleft()
        if d == hops:
            continue
        for y in adj.get(x, ()):
            if y not in seen:
                seen.add(y)
                q.append((y, d + 1))
    return seen


def graduations(tape: Tape):
    """Standard SOL graduations: a CreatePoolEvent whose pool a pump migration created, WSOL quote, mayhem known 0.
    s0 = the CreatePoolEvent's slot. Gradual = CreateEvent to CompleteEvent more than 5 s; without both on the tape
    the launch speed is unknown and the graduation is reported apart (Q30)."""
    mig = tape.migrations.set_index("pool")
    out = []
    for r in tape.pool_creates.itertuples(index=False):
        if r.pool not in mig.index or r.quote_mint not in SOL_QUOTES:
            continue
        mint = mig.at[r.pool, "mint"]
        if tape.mayhem_of_mint(mint) != 0:
            continue
        c = tape.creates[tape.creates["mint"] == mint]
        k = tape.completes[tape.completes["mint"] == mint]
        speed = "unknown"
        if len(c) and len(k):
            speed = "gradual" if int(k["block_time"].iloc[0]) - int(c["block_time"].iloc[0]) > GRADUAL_S else "instant"
        out.append({"day": r.day, "pool": r.pool, "mint": mint, "s0": int(r.slot), "t0": int(r.block_time),
                    "speed": speed, "signature": r.signature, "coin_creator": r.coin_creator,
                    "creator": c["creator"].iloc[0] if len(c) else None, "user": c["user"].iloc[0] if len(c) else None})
    return pd.DataFrame(out, columns=["day", "pool", "mint", "s0", "t0", "speed", "signature", "coin_creator", "creator", "user"])


def _is_other(row_top, owner, signer):
    """BOOST, buyback or mayhem rows are never 'non-linked buys'."""
    return (row_top == MAYHEM_PROGRAM or owner == MAYHEM_VAULT_OWNER
            or (isinstance(signer, str) and signer.startswith(BUYBACK_AUTHORITY_PREFIX))
            or (isinstance(owner, str) and owner.startswith(BUYBACK_AUTHORITY_PREFIX)))


def mig_seat(tape: Tape, s: pd.DataFrame, ctx):
    gr = graduations(tape)
    pp = R.by_pool(s)
    rows = []
    for g in gr.itertuples(index=False):
        rec = {"day": g.day, "pool": g.pool, "speed": g.speed, "s0": g.s0}
        t2 = slot_time(tape, g.s0 + SEAT_SLOTS)
        if t2 is None or not tape.covered(g.s0, t2 + max(PAYER_WINDOW_S, BOOST_WINDOW_S)):
            rec["dropped"] = "window_not_on_tape"
            rows.append(rec)
            continue
        rec["dropped"] = ""
        grp = w_group(tape, {g.coin_creator, g.creator, g.user}, g.s0)
        p = pp.get(g.pool, s.iloc[:0])
        p = p[p["slot"] >= g.s0]
        other = np.array([_is_other(a, b, c) for a, b, c in zip(p["top_program"], p["owner"], p["signer"])], bool)
        nl = p[p["is_buy"] & ~p["boost"] & ~p["excluded"] & ~other & ~p["owner"].isin(grp) & ~p["signer"].isin(grp)
               & p["owner"].notna()]
        seat = nl[nl["slot"] <= g.s0 + SEAT_SLOTS]
        rec["seat_buys"] = int(len(seat))
        rec["seat_buyers"] = int(seat["owner"].nunique())
        v2 = seat[seat["schema_v2"].astype(bool)]
        rec["seat_toll_values"] = list((v2["jito_tip"].fillna(0) + v2["tx_fee"].fillna(0)).astype(float))
        rec["seat_buys_v1"] = int(len(seat) - len(v2))
        f = tape.fails
        rec["racers"] = int(f[(f["venue"] == "pumpswap") & (f["pool_or_curve"] == g.pool) & f["err_class"].isin(RACER_CLASSES)
                              & (f["slot"] >= g.s0) & (f["slot"] <= g.s0 + RACER_SLOTS)]["signature"].nunique())
        sells = p[~p["is_buy"] & (p["owner"].isin(grp) | p["signer"].isin(grp)) & (p["block_time"] < t2 + PAYER_WINDOW_S)]
        sup = p["supply"].dropna()
        rec["group_sold_share"] = float(sells["base"].sum() / sup.iloc[0]) if len(sup) and sup.iloc[0] > 0 else np.nan
        b = tape.boosts[tape.boosts["pool"] == g.pool]
        bw = b[(b["slot"] > g.s0 + SEAT_SLOTS) & (b["block_time"] <= t2 + PAYER_WINDOW_S)]
        nw = nl[(nl["slot"] > g.s0 + SEAT_SLOTS) & (nl["block_time"] <= t2 + PAYER_WINDOW_S)]
        rec["payer_sol"] = float(bw["quote_used"].fillna(0).sum() + nw["sol"].sum())
        st = int(g.s0 + SEAT_SLOTS)
        i, _, eq = R_state(ctx, g.pool, t2, st)
        rec["Q"] = eq
        rec["payer_over_xstar"] = rec["payer_sol"] / x_star(eq) if eq and np.isfinite(eq) and eq > 0 else np.nan
        b300 = b[b["block_time"] <= g.t0 + BOOST_WINDOW_S]
        req = b300["quote_requested"].fillna(0).sum()
        rec["boost_realisation"] = float(b300["quote_used"].fillna(0).sum() / req) if req > 0 else np.nan
        first_min = nl[nl["block_time"] <= g.t0 + 60]
        rec["first_min_sol"] = float(first_min["sol"].sum())
        rec["first_min_s0_1_sol"] = float(first_min.loc[first_min["slot"] <= g.s0 + 1, "sol"].sum())
        mig_tx = p[p["signature"] == g.signature]
        rec["bundled_non_creator_buy"] = bool((mig_tx["is_buy"] & ~mig_tx["owner"].isin(grp)).any())
        tips = seat.sort_values("order")["jito_tip"].fillna(0).to_numpy(float)
        rec["seat_rank_tip_spearman"] = (float(pd.Series(np.arange(len(tips))).corr(pd.Series(tips), method="spearman"))
                                         if len(tips) > 2 and np.std(tips) > 0 else np.nan)
        rows.append(rec)
    df = pd.DataFrame(rows)
    days = sorted({d for d, _, _ in tape.ranges})
    out = {"graduations": int(len(gr)), "by_speed": dict(Counter(gr["speed"])) if len(gr) else {},
           "G8_regime": {"status": "not checkable: the decoder needs the v3 IDL items (PostCompleteBuyEvent)",
                         "post_complete_buy_rows_seen": tape.post_complete_buys, "passed": None}}
    for arm in ("gradual", "instant"):
        a = df[(df["speed"] == arm) & (df["dropped"] == "")] if len(df) else df
        out[arm] = arm_rows(a, days)
    out["prereg_gradual"] = bool(all(out["gradual"][k]["passed"] is True for k in
                                     ("G1", "G2", "G3", "G4", "G5", "G6", "G7")) and out["G8_regime"]["passed"] is True
                                 and not out["gradual"]["kill"]["closes"])
    return df, out


def R_state(ctx, pool, t, st):
    import rebuy as RB
    g = ctx.pp.get(pool)
    if g is None:
        return -1, None, np.nan
    i, mid, eq = RB.state_at(RB.pool_state(g), t, st)
    return i, mid, (eq if i >= 0 and np.isfinite(eq) else np.nan)


def arm_rows(a: pd.DataFrame, days):
    n = len(a)
    if not n:
        empty = {"passed": False, "n": 0}
        return {k: dict(empty) for k in ("G1", "G2", "G3", "G4", "G5", "G6")} | {
            "G7": {"per_day": {d: 0 for d in days}, "passed": False}, "kill": {"share": None, "closes": False}}
    open_share = float((a["seat_buys"] >= 1).mean())
    med_buyers = float(a["seat_buyers"].median())
    tolls = [v for vs in a["seat_toll_values"] for v in vs]
    toll = float(np.median(tolls)) if tolls else None
    racers = float(a["racers"].median())
    sold = a["group_sold_share"].dropna()
    sell_share = float((sold >= SELL_SHARE).mean()) if len(sold) else None
    pay = a.dropna(subset=["payer_over_xstar"])
    pay_med = float(pay["payer_over_xstar"].median()) if len(pay) else None
    # day-clustered: days are the clusters (one stratum), graduations come along with their day (Q31)
    lb = (R.boot_lb_clustered(lambda d: float(np.median(d["v"])),
                              [pay.assign(pool=pay["day"], day="all", v=pay["payer_over_xstar"])], ["v"])
          if len(pay) else None)
    br = a["boost_realisation"].dropna()
    br_med = float(br.median()) if len(br) else None
    per_day = {d: int((a["day"] == d).sum()) for d in days}
    fm = float(a["first_min_sol"].sum())
    kill_share = float(a["first_min_s0_1_sol"].sum() / fm) if fm > 0 else None
    return {
        "G1": {"share_with_seat_buy": open_share, "median_distinct_buyers": med_buyers, "n": n,
               "passed": bool(open_share >= 0.5 and med_buyers >= 2)},
        "G2": {"median_toll_lamports": toll, "buys_on_v2_units": len(tolls),
               "buys_on_v1_units_not_used": int(a["seat_buys_v1"].sum()),
               "passed": bool(toll is not None and toll <= TOLL_MAX)},
        "G3": {"median_racers": racers, "passed": bool(racers <= RACER_MAX)},
        "G4": {"share_group_sold_5pct": sell_share, "passed": bool(sell_share is not None and sell_share <= SELL_MAX)},
        "G5": {"median_payer_over_xstar": pay_med, "lb95_day_clustered": lb, "cost_c": COST_C,
               "passed": bool(pay_med is not None and pay_med >= 2 and lb is not None and lb >= 1)},
        "G6": {"median_boost_used_over_requested": br_med, "passed": bool(br_med is not None and br_med >= BOOST_MIN)},
        "G7": {"per_day": per_day, "passed": bool(per_day and min(per_day.values()) >= COUNT_MIN)},
        "kill": {"share_first_minute_in_s0_s0p1": kill_share, "closes": bool(kill_share is not None and kill_share >= KILL_SHARE)},
        "descriptive": {"median_seat_rank_tip_spearman": float(a["seat_rank_tip_spearman"].median())
                        if a["seat_rank_tip_spearman"].notna().any() else None,
                        "share_migrate_tx_bundled_with_non_creator_buy": float(a["bundled_non_creator_buy"].mean())},
    }


# ====================================================================== MAYHEM-SNAP
DOWN_STEP = -0.062
UP_WITHIN_S = 120
MECH_MIN, MECH_LB = 0.60, 0.50
ATTR_MIN = 0.95
DEPTH_X, DEPTH_SHARE = 2.0, 0.90
POSITION_USD = 100.0
MIN_REAL_SOL = 5 * 10**9


def reprice_steps(tape: Tape, s: pd.DataFrame):
    r = tape.reprices.copy()
    if not len(r):
        return r.assign(j=[], attributed=[], has_s_row=[])
    old = r["virtual_sol_reserves"].astype(float) / r["virtual_token_reserves"].astype(float)
    new = r["new_virtual_sol_reserves"].astype(float) / r["new_virtual_token_reserves"].astype(float)
    r["j"] = new / old - 1
    tops = s["top_program"].astype(object).groupby(s["signature"]).agg(lambda x: set(x.dropna()))
    r["has_s_row"] = r["signature"].isin(tops.index)
    r["attributed"] = [MAYHEM_PROGRAM in tops.get(sig, set()) for sig in r["signature"]]
    return r.sort_values(["slot", "tx_idx"], kind="mergesort").reset_index(drop=True)


def _followed(times, js, i, need):
    """True when a later re-price on the same mint within 120 s has j >= need."""
    t = times[i]
    k = np.nonzero((times > t) & (times <= t + UP_WITHIN_S))[0]
    hit = k[js[k] >= need]
    return (True, int(times[hit[0]] - t)) if len(hit) else (False, None)


def mayhem_snap(tape: Tape, s: pd.DataFrame, hourly):
    r = reprice_steps(tape, s)
    days = sorted({d for d, _, _ in tape.ranges})
    out = {"reprice_rows": int(len(r))}
    if not len(r):
        out.update({k: {"passed": False, "n": 0} for k in ("a", "b", "d", "e")})
        out["c"] = {"n": 0}
        out["e"]["per_day"] = {d: 0 for d in days}
        out["rule"] = {}
        out["prereg_may_be_written"] = False
        return r, out
    # the re-price rule, written down from the events (AMENDMENT_5 "first, write down the re-price rule")
    k_old = r["virtual_sol_reserves"].astype(float) * r["virtual_token_reserves"].astype(float)
    k_new = r["new_virtual_sol_reserves"].astype(float) * r["new_virtual_token_reserves"].astype(float)
    out["rule"] = {"share_k_unchanged": float((k_old == k_new).mean()),
                   "share_vsol_unchanged": float((r["virtual_sol_reserves"] == r["new_virtual_sol_reserves"]).mean()),
                   "share_vtoken_unchanged": float((r["virtual_token_reserves"] == r["new_virtual_token_reserves"]).mean())}
    out["a"] = {"share_attributed": float(r["attributed"].mean()), "share_with_an_s_row": float(r["has_s_row"].mean()),
                "passed": bool(r["attributed"].mean() >= ATTR_MIN)}
    rows, plc_up = [], []
    for mint, g in r.groupby("mint", sort=False):
        t, j = g["block_time"].to_numpy(), g["j"].to_numpy(float)
        for i, e in enumerate(g.itertuples(index=False)):
            if e.j <= DOWN_STEP:
                ok, dt = _followed(t, j, i, abs(e.j) / 2)
                rows.append({"mint": mint, "day": e.day, "slot": e.slot, "t": int(e.block_time), "j": e.j, "up": ok,
                             "dt": dt, "real_sol": e.real_sol_reserves})
            elif e.j >= -DOWN_STEP:
                ok, _ = _followed(t, -j, i, e.j / 2)
                plc_up.append(ok)
    dn = pd.DataFrame(rows, columns=["mint", "day", "slot", "t", "j", "up", "dt", "real_sol"])
    share = float(dn["up"].mean()) if len(dn) else None
    lb = (R.boot_lb_clustered(lambda d: float(np.mean(d["u"])), [dn.assign(pool=dn["mint"], u=dn["up"].astype(float))], ["u"])
          if len(dn) else None)
    out["b"] = {"down_steps": int(len(dn)), "share_followed_by_up": share, "lb95_mint_clustered": lb,
                "placebo_up_steps_share_followed_by_down": float(np.mean(plc_up)) if plc_up else None,
                "placebo_non_agent_sells": non_agent_sell_placebo(s),
                "passed": bool(share is not None and share >= MECH_MIN and lb is not None and lb > MECH_LB)}
    up = dn[dn["up"]]
    agent = s["top_program"].eq(MAYHEM_PROGRAM) | s["owner"].eq(MAYHEM_VAULT_OWNER)
    nab = s[s["is_buy"] & ~agent & (s["venue"] == "curve")]
    same = [((nab["mint"] == x.mint) & (nab["slot"] == x.slot)).any() for x in dn.itertuples(index=False)]
    out["c"] = {"median_seconds_to_up_step": float(up["dt"].median()) if len(up) else None,
                "share_with_non_agent_buy_in_down_step_slot": float(np.mean(same)) if same else None}
    # (d) exit depth at the up step: real SOL >= 2 x a $100 position's proceeds (at that hour's SOL/USD)
    depth = []
    for x in up.itertuples(index=False):
        g = r[(r["mint"] == x.mint) & (r["block_time"] == x.t + x.dt)]
        px = H8.px_asof(hourly, x.t + x.dt)
        if len(g) and np.isfinite(px):
            depth.append(float(g["real_sol_reserves"].iloc[0]) >= DEPTH_X * POSITION_USD / px * R.LAMPORTS)
    ds = float(np.mean(depth)) if depth else None
    out["d"] = {"share": ds, "n": len(depth), "passed": bool(ds is not None and ds >= DEPTH_SHARE)}
    # (e) qualifying down steps a day on SOL mayhem curves with at least 5 real SOL
    sol_curve = {m for m, q in zip(tape.creates["mint"], tape.creates["quote_mint"]) if q in SOL_QUOTES}
    sol_curve |= set(s.loc[(s["venue"] == "curve") & s["sol_quoted"], "mint"])
    qual = dn[dn["mint"].isin(sol_curve) & (dn["real_sol"].astype(float) >= MIN_REAL_SOL)]
    per_day = {d: int((qual["day"] == d).sum()) for d in days}
    out["e"] = {"per_day": per_day, "passed": bool(per_day and min(per_day.values()) >= COUNT_MIN)}
    out["prereg_may_be_written"] = bool(all(out[k]["passed"] for k in ("a", "b", "d", "e")))
    out["before_any_bot_use"] = "the owner's approval; a legal check before any real use (AMENDMENT_6)"
    return dn, out


def non_agent_sell_placebo(s: pd.DataFrame):
    """Second placebo: curve sells by non-agent owners on mayhem curves that move the curve price by -6.2% or more;
    share followed within 120 s by a price at least |j|/2 above the post-sell price (curve trades only)."""
    agent = s["top_program"].eq(MAYHEM_PROGRAM) | s["owner"].eq(MAYHEM_VAULT_OWNER)
    c = s[(s["venue"] == "curve") & (s["mayhem"] == 1) & s["curve_vsol"].notna() & s["curve_vtok"].notna()]
    hits = []
    for mint, g in c.groupby("mint", sort=False):
        g = g.sort_values("order")
        px = (g["curve_vsol"] / g["curve_vtok"]).to_numpy(float)
        bt = g["block_time"].to_numpy()
        ag = agent.loc[g.index].to_numpy()
        sell = (~g["is_buy"]).to_numpy()
        for i in range(1, len(g)):
            if not sell[i] or ag[i]:
                continue
            j = px[i] / px[i - 1] - 1
            if j > DOWN_STEP:
                continue
            k = (bt > bt[i]) & (bt <= bt[i] + UP_WITHIN_S)
            hits.append(bool(k.any() and px[k].max() >= px[i] * (1 + abs(j) / 2)))
    return {"n": len(hits), "share_followed_by_up": float(np.mean(hits)) if hits else None}
