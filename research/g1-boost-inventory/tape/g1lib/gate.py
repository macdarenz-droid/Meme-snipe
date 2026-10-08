"""Gate G1-0 (PREREG §6) with the descriptive rows of amendments 1 and 2, and the amendment arms' gates.
Reads timing, BOOST events, holdings and flows; never computes a fill or a strategy return."""
import math
from typing import Dict, Optional

import numpy as np
import pandas as pd

from . import params as P
from .decide import flags_asof, create_index
from .features import FeatureContext
from .flows import FastClass, migration_flows
from .market import Market
from scipy.stats import spearmanr

from .stats import spearman_boot


def boost_rows(mkt: Market, tape, mint: int, mig: dict) -> dict:
    """PREREG §6(c) and the amendments' descriptive BOOST rows for one graduate."""
    m, pool = int(mig["slot"]), int(mig["pool_c"])
    bb = mkt.boosts(pool)
    seg = tape.segment_of(m)
    out = {"mint": tape.names.name(mint), "m": m, "pool": tape.names.name(pool), "any_boost": len(bb) > 0,
           "init_boost": pool in mkt.boost_budget}
    budget = mkt.boost_budget.get(pool)
    if budget is None and len(bb):
        budget = int(bb["used"].iloc[0] + bb["remaining"].iloc[0])
    out["budget"] = budget if budget is not None else 0
    finished = len(bb) > 0 and int(bb["remaining"].iloc[-1]) == 0
    covered = seg is not None and seg[1] >= m + P.BOOST_COMPLETE_HORIZON_SLOTS
    out["boost_complete"] = bool(finished or covered)
    if not len(bb):
        out.update({"first_boost_slots": np.nan, "last_boost_slots": np.nan, "share_after_mD": 0.0 if out["boost_complete"] else np.nan})
        return out
    s = bb["slot"].to_numpy()
    used = bb["used"].to_numpy()
    out["first_boost_slots"] = int(s[0] - m)
    out["last_boost_slots"] = int(s[-1] - m)
    # spent after m + D: slices in slots strictly after m + D (a slice in slot m + D may land before our sell; OQ-8)
    out["share_after_mD"] = float(used[s > m + P.D].sum() / budget) if (budget and out["boost_complete"]) else np.nan
    for off in P.BOOST_DESCRIPTIVE_OFFSETS:
        out[f"unspent_at_m+{off}"] = float(budget - used[s <= m + off].sum()) if budget else np.nan
    # min_base_amount_burned: the inner buy's min_base_amount_out on the slice's S_amm row (UNVERIFIED mapping, OQ-14)
    pr = tape.pool_of(pool)
    br = pr[pr["is_boost"]] if len(pr) else pr
    cap = br["min_base_amount_out"].to_numpy() if len(br) else np.empty(0)
    out["slices"] = len(bb)
    out["slices_on_s_amm"] = len(br)
    out["share_slices_capped"] = float((cap > 0).mean()) if len(cap) else np.nan
    out["capped"] = bool((cap > 1).any()) if len(cap) else False
    hr = cap_headroom(tape, pool, m)
    out["cap_headroom_median"] = float(hr["headroom"].median()) if len(hr) else np.nan
    out["slice_quote_per_base_median"] = float(np.median(bb["used"].to_numpy() / np.maximum(bb["base_amount_burned"].astype(np.int64).to_numpy(), 1))) if "base_amount_burned" in bb else np.nan
    # slices with a non-BOOST trade between them
    if len(pr) and len(bb) > 1:
        keys = pr["slot"].to_numpy() * 100_000 + pr["tx_idx"].to_numpy()
        nb = ~pr["is_boost"].to_numpy()
        bk = s * 100_000 + bb["tx_idx"].to_numpy()
        between = [bool(nb[(keys > a) & (keys < b)].any()) for a, b in zip(bk[:-1], bk[1:])]
        out["share_slices_with_trade_between"] = float(np.mean(between))
    else:
        out["share_slices_with_trade_between"] = np.nan
    fb = tape.F_boost
    if len(fb):
        f = fb[(fb["pool_or_curve"] == pool) & (fb["slot"] >= m)]
        out["boost_slippage_failures"] = int((f["err_class"] == "slippage").sum())
    else:
        out["boost_slippage_failures"] = 0
    return out


def cap_headroom(tape, pool: int, m: int) -> pd.DataFrame:
    """Amendment 3 (OQ-14) descriptive row: per BOOST slice, (cap price ÷ pool price just before the slice) − 1, with
    the slice's order and its slot after m. Cap price = quote_amount_in ÷ min_base_amount_burned, where
    min_base_amount_burned is read as the inner buy's min_base_amount_out (UNVERIFIED mapping)."""
    pr = tape.pool_of(pool)
    br = pr[pr["is_boost"]] if len(pr) else pr
    bb = tape.events["BoostBuyAndBurnEvent"]
    if not len(br) or not len(bb):
        return pd.DataFrame(columns=["pool", "slice", "slots_after_m", "headroom"])
    ev = bb[bb["pool_c"] == pool][["slot", "tx_idx", "quote_amount_in_requested"]].astype(np.int64)
    j = br.merge(ev, on=["slot", "tx_idx"], how="inner").sort_values(["slot", "tx_idx", "ev_idx"])
    j = j.drop_duplicates(["slot", "tx_idx"])
    cap_base = j["min_base_amount_out"].to_numpy().astype(float)
    eff = (j["pool_quote_token_reserves"] + j["virtual_quote_reserves"]).to_numpy().astype(float)
    price = eff / j["pool_base_token_reserves"].to_numpy().astype(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        cap_price = j["quote_amount_in_requested"].to_numpy() / cap_base
        head = np.where(cap_base > 0, cap_price / price - 1, np.nan)
    return pd.DataFrame({"pool": tape.names.name(pool), "slice": np.arange(1, len(j) + 1),
                         "slots_after_m": j["slot"].to_numpy() - m, "headroom": head})


def headroom_summary(slices: pd.DataFrame) -> dict:
    """Median cap headroom by slice order and by slot after m (amendment 3; descriptive, never judged)."""
    h = slices.dropna(subset=["headroom"]) if len(slices) else slices
    if not len(h):
        return {"n": 0}
    band = pd.cut(h["slots_after_m"], [-1, P.D, 150, 300, 750, 10 ** 9],
                  labels=["0..D", "D+1..150", "151..300", "301..750", ">750"])
    return {"n": int(len(h)), "median": float(h["headroom"].median()),
            "share_negative": float((h["headroom"] < 0).mean()),
            "median_by_slice": {str(k): float(v) for k, v in h.groupby("slice")["headroom"].median().items()},
            "median_by_slots_after_m": {str(k): float(v) for k, v in h.groupby(band, observed=True)["headroom"].median().items()}}


def graduates(tape, mkt: Market) -> pd.DataFrame:
    """Every migration on the tape, with its stratum and universe reason as of the migration."""
    creates = create_index(tape)
    rows = []
    for mint, mig in mkt.mig.items():
        cr = tape.curve_of(mint)
        upto = cr[cr["slot"] <= int(mig["slot"])]
        c = creates.get(mint)
        st, reason = flags_asof(upto, c if (c is not None and int(c["slot"]) <= int(mig["slot"])) else None)
        r = boost_rows(mkt, tape, mint, mig)
        r.update({"mint_c": mint, "stratum": st, "reason": reason, "day": tape.day_of(int(mig["slot"]))})
        rows.append(r)
    return pd.DataFrame(rows)


def g1_0(d: pd.DataFrame, grads: pd.DataFrame, mkt: Market, days) -> dict:
    """PREREG §6, discovery days only."""
    prim = d[(d["kind"] == "G1") & (d["stratum"] == "sol")]
    trig = prim[(prim["reason"] == "") & (~prim["censored"])].copy()
    comp = [mkt.completion_slot(int(m)) for m in trig["mint_c"]]
    trig["completion"] = [c if c is not None else -1 for c in comp]
    trig["m"] = [int(mkt.mig[m]["slot"]) if m in mkt.mig else -1 for m in trig["mint_c"]]
    # catchable: the curve is still open after the entry slot, and the decision is not dropped by time (finding 5)
    trig["catchable"] = [((c < 0) or (c > t + P.D)) and not bool(dr)
                         for c, t, dr in zip(trig["completion"], trig["t0"], trig["dropped_by_time"])]
    mig = trig[trig["m"] >= 0]
    slots_to_m = (mig["m"] - mig["t0"]).to_numpy()
    out = {"days": list(days)}
    out["a_triggers_per_day"] = {str(k): int(v) for k, v in trig.groupby("day").size().items()}
    out["a_excluded_by_reason"] = {str(k): int(v) for k, v in prim[prim["reason"] != ""].groupby("reason").size().items()}
    out["a_left_censored"] = int(prim["censored"].sum())
    out["b_n_migrating"] = int(len(slots_to_m))
    out["b_median_slots_t0_to_m"] = float(np.median(slots_to_m)) if len(slots_to_m) else math.nan
    out["b_share_more_than_D"] = float((slots_to_m > P.D).mean()) if len(slots_to_m) else math.nan
    catch = trig.groupby("day")["catchable"].sum()
    out["catchable_per_day"] = {str(k): int(v) for k, v in catch.items()}
    g = grads[(grads["stratum"] == "sol") & (grads["reason"] == "")]
    gc = g[g["boost_complete"]]
    trig_mints = set(trig["mint_c"])
    gt = gc[gc["mint_c"].isin(trig_mints)]
    out["c_graduates"] = int(len(g))
    out["c_graduates_boost_window_complete"] = int(len(gc))
    out["c_share_any_boost"] = float(g["any_boost"].mean()) if len(g) else math.nan
    out["c_share_init_boost"] = float(g["init_boost"].mean()) if len(g) else math.nan
    out["c_first_boost_slots_median"] = float(g["first_boost_slots"].median()) if len(g) else math.nan
    out["c_last_boost_slots_median"] = float(g["last_boost_slots"].median()) if len(g) else math.nan
    # graduates without BOOST count as 0% spent after m + D (OQ-7)
    share_all = gc["share_after_mD"].fillna(0.0)
    share_trig = gt["share_after_mD"].fillna(0.0)
    out["c_median_share_after_mD_all"] = float(share_all.median()) if len(gc) else math.nan
    out["c_fraction_below_25pct_all"] = float((share_all < P.GATE_BOOST_SHARE_AFTER).mean()) if len(gc) else math.nan
    out["c_fraction_below_25pct_triggered"] = float((share_trig < P.GATE_BOOST_SHARE_AFTER).mean()) if len(gt) else math.nan
    for off in P.BOOST_DESCRIPTIVE_OFFSETS:
        col = f"unspent_at_m+{off}"
        if col in g:
            out[f"desc_median_{col}"] = float(g[col].median())
            out[f"desc_median_{col}_capped"] = float(g.loc[g["capped"] == True, col].median()) if "capped" in g else math.nan
            out[f"desc_median_{col}_uncapped"] = float(g.loc[g["capped"] != True, col].median()) if "capped" in g else math.nan
    for col in ("share_slices_with_trade_between", "share_slices_capped", "slice_quote_per_base_median", "cap_headroom_median"):
        if col in g:
            out["desc_median_" + col] = float(g[col].median())
    out["desc_boost_slippage_failures"] = int(g["boost_slippage_failures"].sum()) if "boost_slippage_failures" in g else 0
    # kill rules
    n_days = max(len(days), 1)
    avg_catch = sum(out["catchable_per_day"].get(str(x), 0) for x in days) / n_days
    out["avg_catchable_per_day"] = avg_catch
    kills = []
    if not math.isnan(out["b_median_slots_t0_to_m"]) and out["b_median_slots_t0_to_m"] <= P.D:
        kills.append("median slots t0 to m <= D")
    worst = max([x for x in (out["c_fraction_below_25pct_all"], out["c_fraction_below_25pct_triggered"]) if not math.isnan(x)] or [math.nan])
    if not math.isnan(worst) and worst > 0.5:
        kills.append("BOOST quote after m + D under 25% on most graduates")
    if avg_catch < P.GATE_MIN_CATCHABLE_PER_DAY:
        kills.append("fewer than 100 catchable triggers a day")
    out["kills"] = kills
    out["passes"] = not kills
    return out, trig


def strata_rows(d: pd.DataFrame, grads: pd.DataFrame, flows: Dict[int, dict]) -> dict:
    """Amendment 2 §3: USDC- and token-quoted curves counted separately from SOL (descriptive)."""
    out = {}
    for st in ("sol", "usdc", "token"):
        t = d[(d["kind"] == "G1") & (d["stratum"] == st) & (~d["censored"]) & (d["reason"].isin(["", "non-sol-quote"]))]
        g = grads[(grads["stratum"] == st) & (grads["reason"].isin(["", "non-sol-quote"]))]
        col = f"unspent_at_m+{P.D}"
        un = g[col].dropna() if col in g.columns else pd.Series(dtype=float)
        out[st] = {
            "triggers": int(len(t)), "graduates": int(len(g)),
            "share_init_boost": float(g["init_boost"].mean()) if len(g) else math.nan,
            "median_boost_unspent_after_mD": float(un.median()) if len(un) else math.nan,
            "median_distinct_buyers_m_to_mD": float(np.median([flows[m]["distinct_buyers"] for m in g["mint_c"] if m in flows and "distinct_buyers" in flows[m]])) if len(g) else math.nan,
        }
    return out


def count_gate(per_day: dict, days, threshold: int) -> dict:
    """Amendment 4 (OQ-27): a count gate passes only if the pooled Step A count reaches the threshold (per day, so
    pooled >= threshold × number of days, i.e. the pooled daily average reaches it) and each day's own count reaches
    at least 40% of the threshold."""
    counts = {str(x): int(per_day.get(str(x), 0)) for x in days}
    pooled = sum(counts.values())
    need_pooled = threshold * len(counts)
    floor = P.COUNT_GATE_DAY_FLOOR * threshold
    days_ok = {d: c >= floor for d, c in counts.items()}
    return {"per_day": counts, "pooled": pooled, "pooled_needed": need_pooled, "day_floor": floor,
            "days_ok": days_ok, "passes": bool(counts) and pooled >= need_pooled and all(days_ok.values())}


def _rho(x, y) -> float:
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = ~(np.isnan(x) | np.isnan(y))
    if ok.sum() < 3 or np.ptp(x[ok]) == 0 or np.ptp(y[ok]) == 0:
        return math.nan
    return float(spearmanr(x[ok], y[ok]).statistic)


def hc_gate(trig: pd.DataFrame, flows: Dict[int, dict], days) -> dict:
    """Amendment 1 gates (a)–(d) on the discovery days."""
    t = trig.copy()
    t["share_pre_sold"] = [flows.get(m, {}).get("share_pre_sold", np.nan) for m in t["mint_c"]]
    has_r = t[t["R"].notna()]
    a = spearman_boot(has_r["R"].to_numpy(), has_r["share_pre_sold"].to_numpy(), has_r["mint"].to_numpy(), has_r["day"].to_numpy())
    cov = has_r["hc_coverage"]
    pooled = float(cov.mean()) if len(cov) else math.nan
    med_r = float(has_r["R"].median()) if len(has_r) else math.nan
    filt = has_r[(has_r["R"] < med_r) & has_r["catchable"]]
    per_day = {str(k): int(v) for k, v in filt.groupby("day").size().items()}
    # "at least 100 ... a day": every day must reach it (per-day minimum, review finding 4; OQ-27)
    cg = count_gate(per_day, days, P.HC_GATE_MIN_PER_DAY)
    terc = None
    if len(has_r):
        q1, q2 = has_r["R"].quantile(1 / 3), has_r["R"].quantile(2 / 3)
        terc = pd.Series(np.where(has_r["R"] <= q1, "low", np.where(has_r["R"] <= q2, "mid", "high")))
    age = (has_r["t0"] - has_r["create_slot"]).to_numpy()
    out = {
        "a_spearman_R_vs_share_sold": a,
        "a_pass": bool(a["rho"] >= P.HC_GATE_RHO and a["lower_95"] > 0) if not math.isnan(a["rho"]) else False,
        "b_mean_coverage": pooled, "b_median_coverage": float(cov.median()) if len(cov) else math.nan,
        "b_min_coverage": float(cov.min()) if len(cov) else math.nan,
        "b_pass": bool(pooled >= P.HC_GATE_COVERAGE and float(cov.median()) >= P.HC_GATE_COVERAGE) if len(cov) else False,
        "b_dropped_created_before_tape": int((t["hc_reason"] == "created-before-tape").sum()),
        "c_filtered_catchable_per_day": per_day, "c_count_gate": cg, "c_pass": cg["passes"],
        "d_spearman_R_vs_create_to_trigger_slots": _rho(has_r["R"].to_numpy(), age),
        "d_counts_by_R_tercile": {str(k): int(v) for k, v in terc.value_counts().items()} if terc is not None else {},
        "median_R": med_r,
    }
    out["passes"] = out["a_pass"] and out["b_pass"] and out["c_pass"]
    return out


def cap_gate(trig: pd.DataFrame, flows: Dict[int, dict], g10_pass: bool, days) -> dict:
    """Amendment 2 gates (a)–(d) on the discovery days."""
    t = trig[trig["Z"].notna() & (trig["cap_reason"] == "")].copy()
    t["net_flow"] = [flows.get(m, {}).get("net_opening_flow_sol", np.nan) for m in t["mint_c"]]
    t["fast_buy"] = [flows.get(m, {}).get("fast_buy_sol", np.nan) for m in t["mint_c"]]
    zl = {"rho": _rho(t["Z"].to_numpy(), t["lam"].to_numpy())}
    iqr = float(t["Z"].quantile(0.75) - t["Z"].quantile(0.25)) if len(t) else math.nan
    c = spearman_boot(t["Z"].to_numpy(), t["net_flow"].to_numpy(), t["mint"].to_numpy(), t["day"].to_numpy())
    c2 = spearman_boot(t["Z"].to_numpy(), t["fast_buy"].to_numpy(), t["mint"].to_numpy(), t["day"].to_numpy())
    med_z = float(t["Z"].median()) if len(t) else math.nan
    low = t[(t["Z"] <= med_z) & t["catchable"]]
    per_day = {str(k): int(v) for k, v in low.groupby("day").size().items()}
    cg = count_gate(per_day, days, P.CAP_GATE_MIN_PER_DAY)
    out = {
        "a_g1_0_passes": g10_pass,
        "b_rho_Z_lambda": zl["rho"], "b_iqr_Z": iqr,
        "b_pass": bool(abs(zl["rho"]) <= P.CAP_GATE_RHO_Z_LAMBDA and iqr >= P.CAP_GATE_IQR_Z) if not math.isnan(zl["rho"]) else False,
        "c_spearman_Z_vs_net_flow": c,
        "c_pass": bool(c["rho"] <= P.CAP_GATE_RHO_FLOW and c["upper_95"] < 0) if not math.isnan(c["rho"]) else False,
        "c2_spearman_Z_vs_fast_buys": c2,
        "c2_pass": bool(c2["rho"] <= P.CAP_GATE_RHO_FLOW and c2["upper_95"] < 0) if not math.isnan(c2["rho"]) else False,
        "d_low_Z_catchable_per_day": per_day, "d_count_gate": cg, "d_pass": cg["passes"],
        "excluded_by_reason": {str(k): int(v) for k, v in trig[trig["cap_reason"] != ""].groupby("cap_reason").size().items()} if "cap_reason" in trig else {},
        "median_Z": med_z,
    }
    out["passes"] = all(out[k] for k in ("a_g1_0_passes", "b_pass", "c_pass", "c2_pass", "d_pass"))
    return out


def run(tape, d: pd.DataFrame, ctx: FeatureContext, mkt: Market, days, log=print) -> dict:
    grads = graduates(tape, mkt)
    g10, trig = g1_0(d, grads, mkt, days)
    fast = FastClass(ctx) if ctx.graph is not None else None
    flows = {}
    want = set(trig["mint_c"]) | set(grads.loc[grads["stratum"].isin(["usdc", "token"]), "mint_c"])
    for mint in want:
        if mint in mkt.mig:
            day = tape.day_of(int(mkt.mig[mint]["slot"]))
            fo = fast.owners(day) if fast is not None else None
            flows[mint] = migration_flows(ctx, mkt, mint, fo)
    log(f"  gate: {len(trig)} triggers, {len(grads)} graduates, {len(flows)} flow rows")
    out = {"G1_0": g10, "strata": strata_rows(d, grads, flows)}
    sol = grads[(grads["stratum"] == "sol") & (grads["reason"] == "")]
    tabs = [cap_headroom(tape, tape.names.get(p), int(m)) for p, m in zip(sol["pool"], sol["m"])] if len(sol) else []
    slices = pd.concat(tabs, ignore_index=True) if tabs else pd.DataFrame(columns=["pool", "slice", "slots_after_m", "headroom"])
    out["G1_0"]["desc_cap_headroom"] = headroom_summary(slices)
    out["boost_slices"] = slices
    if "R" in trig:
        out["G1_HC"] = hc_gate(trig, flows, days)
    if "Z" in trig:
        out["G1_CAP"] = cap_gate(trig, flows, g10["passes"], days)
    return out, grads, trig, flows
