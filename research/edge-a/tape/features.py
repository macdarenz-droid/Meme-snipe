"""Design A features: pool eligibility, market-cap timeline, band occupancy, creator flows, count rule,
and (causal) cross events for the later return test.

Nothing here reads outcomes or returns, and this module never imports outcomes.py.
Spec: research/EDGE_DIALOGUE.md "### Design A" and research/brainstorm-loop/A_AMENDMENTS_ROUND7.md.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from load import SOL_QUOTES, SYSTEM, WSOL

STEP = 420.0  # SOL, the creator fee step
LADDER_NEXT = 1470.0  # next creator-fee step; placebos stay > 10% away from it too
BAND = 0.05  # ±5%
HORIZON_S = 72 * 3600  # hours 0-72 after migration
NO_BOOST_WINDOW_S = 300  # amendment (b): first 5 minutes when no BOOST event exists
LAMPORTS = 1e9


def placebo_grid(n_placebo: int = 20, lo: float = 340.0, hi: float = 1300.0, min_gap: float = 0.10) -> np.ndarray:
    """20 placebo cutoffs on a log grid from 340 to 1,300 SOL, each > 10% away from 420 and 1,470.

    Reading (OPEN_QUESTIONS Q1): the smallest evenly log-spaced grid with both ends included that leaves exactly
    20 points after the exclusion. N = 24; the same 20 points under a ratio or a log distance reading.
    """
    for n in range(n_placebo, 10 * n_placebo):
        g = np.exp(np.linspace(np.log(lo), np.log(hi), n))
        keep = (np.abs(g / STEP - 1) > min_gap) & (np.abs(g / LADDER_NEXT - 1) > min_gap)
        if keep.sum() == n_placebo:
            return g[keep]
    raise ValueError("no grid gives exactly %d placebos" % n_placebo)


def cutoffs() -> np.ndarray:
    """Index 0 is the 420 SOL step; 1..20 are the placebos."""
    return np.concatenate([[STEP], placebo_grid()])


def band_edges(c: np.ndarray):
    """Lower band [0.95c, c), upper band [c, 1.05c). For c = 420: [399, 420) and [420, 441)."""
    c = np.asarray(c, dtype=float)
    return c * (1 - BAND), c, c * (1 + BAND)


# ---------------------------------------------------------------- market cap (amendment a)

def market_cap_sol(quote_vault, virtual_quote, base_reserve, supply):
    """Effective quote (vault + signed virtual_quote_reserves) x supply / base reserve, in SOL.

    Supply is the swap event's live `base_supply` (after BOOST burns): pump-amm `Pool::market_cap` uses the live
    mint supply (packages/core/src/amm/pump-swap.ts), confirmed on the tape by supply_rule_check().
    """
    base = np.asarray(base_reserve, dtype=float)
    eff = np.asarray(quote_vault, dtype=float) + np.asarray(virtual_quote, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        mc = eff * np.asarray(supply, dtype=float) / base / LAMPORTS
    return np.where((base > 0) & (eff > 0), mc, np.nan)


def load_fee_tiers(path: str):
    with open(path) as f:
        tiers = json.load(f)["amm"]["fee_tiers"]
    th = np.array([float(t["market_cap_lamports_threshold"]) for t in tiers]) / LAMPORTS
    cr = np.array([int(t["fees"]["creator_fee_bps"]) for t in tiers])
    return th, cr


def supply_rule_tally(sw: pd.DataFrame, tiers) -> dict:
    """Amendment (a) check on one chunk: on canonical SOL swaps that charged a creator fee, and only where the live
    and the fixed 1B supply pick different FeeConfig tiers, how often each one reproduces the charged creator rate."""
    th, cr = tiers
    m = (sw.canonical == 1) & (sw.quote_mint == WSOL) & (sw.coin_creator_fee_basis_points > 0)
    s = sw[m]
    preds = {}
    oks = []
    for name, supply in (("base_supply", s.base_supply.to_numpy()), ("fixed_1e15", np.full(len(s), 1e15))):
        mc = market_cap_sol(s.pool_quote_token_reserves, s.virtual_quote_reserves, s.pool_base_token_reserves, supply)
        oks.append(~np.isnan(mc))
        preds[name] = cr[np.clip(np.searchsorted(th, np.nan_to_num(mc), side="right") - 1, 0, None)]
    diff = oks[0] & oks[1] & (preds["base_supply"] != preds["fixed_1e15"])
    obs = s.coin_creator_fee_basis_points.to_numpy()
    out = {"n": int(len(s)), "n_diff": int(diff.sum())}
    for name, p in preds.items():
        out[name] = int((p[diff] == obs[diff]).sum())
    return out


# ---------------------------------------------------------------- pools (eligibility, BOOST window)

def pool_table(events: pd.DataFrame, segs: pd.DataFrame) -> pd.DataFrame:
    """One row per migrated pool seen in the tape, with the gate window [lo, hi] and an exclusion reason.

    Pools: canonical PumpSwap SOL pools of pump.fun graduates, not mayhem (canonical and SOL quote are checked again
    on the swaps). lo = end of the last BoostBuyAndBurnEvent (amendment b), or migration + 5 min when none exists;
    hi = migration + 72 h.
    """
    ev = events.sort_values(["slot", "tx_idx", "ev_idx"])
    mig = ev[ev.event == "CompletePumpAmmMigrationEvent"].drop_duplicates("pool", keep="first")
    cp = ev[ev.event == "CreatePoolEvent"].drop_duplicates("signature", keep="first").set_index("signature")
    boosts = ev[ev.event == "BoostBuyAndBurnEvent"]
    init_boost = set(ev.loc[ev.event == "InitBoostEvent", "pool"])
    seg_t = segs.t_end.to_numpy()
    rows = []
    for m in mig.itertuples(index=False):
        r = {"pool": m.pool, "mint": m.mint, "mig_slot": m.slot, "mig_time": m.block_time, "reason": ""}
        mayhem = cp.is_mayhem_mode.get(m.signature) if m.signature in cp.index else None
        b = boosts[(boosts.pool == m.pool) & (boosts.block_time >= m.block_time)]
        si = np.searchsorted(segs.from_slot.to_numpy(), m.slot, side="right") - 1
        mig_seg_end = seg_t[si] if si >= 0 else -1
        if m.quote_mint not in SOL_QUOTES:
            r["reason"] = "quote_not_sol"
        elif mayhem is None:
            r["reason"] = "mayhem_unknown"  # no CreatePoolEvent in the migration transaction
        elif str(mayhem) != "0":
            r["reason"] = "mayhem"
        r["n_boost"] = len(b)
        if len(b):
            final = b[b.boost_vault_remaining.astype(str) == "0"]
            if len(final):
                r["lo"], r["boost_rule"] = int(b.block_time.max()), "last_boost_event"
            else:  # tape coverage ended before the BOOST finished: its end is not known
                r["lo"], r["boost_rule"] = np.nan, "boost_end_unknown"
                r["reason"] = r["reason"] or "boost_end_unknown"
        elif mig_seg_end >= m.block_time + NO_BOOST_WINDOW_S or m.pool not in init_boost:
            r["lo"], r["boost_rule"] = m.block_time + NO_BOOST_WINDOW_S, "no_boost_5min"
        else:  # a BOOST was set up but coverage ends inside the first 5 minutes: events may be missing
            r["lo"], r["boost_rule"] = np.nan, "boost_unobserved"
            r["reason"] = r["reason"] or "boost_end_unknown"
        r["hi"] = m.block_time + HORIZON_S
        rows.append(r)
    cols = ["pool", "mint", "mig_slot", "mig_time", "reason", "n_boost", "lo", "boost_rule", "hi"]
    return pd.DataFrame(rows, columns=cols)


# ---------------------------------------------------------------- swaps (compact) and timeline

def compact_swaps(ch: pd.DataFrame, pool_codes: dict, boost_sigs: set) -> pd.DataFrame:
    """Keep only what the features need, for swaps of candidate pools."""
    s = ch[ch.pool.isin(pool_codes.keys())]
    buy = (s.side == "buy").to_numpy()
    pre_base = s.pool_base_token_reserves.to_numpy()
    pre_eff = s.pool_quote_token_reserves.to_numpy() + s.virtual_quote_reserves.to_numpy()
    qa, ba, lp = s.quote_amount.to_numpy(), s.base_amount.to_numpy(), s.lp_fee.fillna(0).to_numpy()
    # Post-trade state from the row alone (causal). Base and supply are exact; effective quote is exact except for
    # fee-retention accounting on v2 instructions (used only where no later swap gives the exact state).
    post_base = np.where(buy, pre_base - ba, pre_base + ba)
    post_eff = np.where(buy, pre_eff + qa + lp, pre_eff - qa + lp)
    cc = s.coin_creator.fillna("").to_numpy()
    is_creator = (cc != "") & (cc != SYSTEM) & ((s.signer.to_numpy() == cc) | (s.user_token_owner.fillna("").to_numpy() == cc))
    return pd.DataFrame({
        "pool": s.pool.map(pool_codes).to_numpy(np.int32),
        "slot": s.slot.to_numpy(np.int64), "tx_idx": s.tx_idx.to_numpy(np.int32), "ev_idx": s.ev_idx.to_numpy(np.int32),
        "t": s.block_time.to_numpy(np.int64),
        "pre_mc": market_cap_sol(s.pool_quote_token_reserves, s.virtual_quote_reserves, pre_base, s.base_supply),
        "post_mc": market_cap_sol(post_eff, 0.0, post_base, s.base_supply),
        "creator_net_sol": np.where(is_creator, np.where(buy, qa, -qa), 0.0) / LAMPORTS,
        "is_creator": is_creator,
        "is_boost": s.signature.isin(boost_sigs).to_numpy(),
        "canon_sol": ((s.canonical == 1) & (s.quote_mint == WSOL)).to_numpy(),
        # the swap's own post-swap chain reading (states for the outcome stage; never a later row's reserves)
        "base_post": s.chain_pool_base.to_numpy(float), "vault_post": s.chain_pool_quote.to_numpy(float),
        "virt": s.virtual_quote_reserves.to_numpy(float), "supply": s.base_supply.to_numpy(float),
    })


def timeline(sw: pd.DataFrame, segs: pd.DataFrame, seg_id: np.ndarray) -> pd.DataFrame:
    """Piecewise-constant market cap per pool inside covered time.

    After swap i the cap holds until the next swap of the pool in the same covered segment; its value there is that
    next swap's pre-trade state (the exact on-chain state over the interval). After the segment's last swap, the
    row's own post-trade state holds to the segment end. Before the segment's first swap, that swap's pre-trade
    state holds from the segment start. Time outside covered segments is never counted.
    """
    sw = sw.assign(seg=seg_id)
    sw = sw[sw.seg >= 0].sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="mergesort")
    p, g, t = sw.pool.to_numpy(), sw.seg.to_numpy(), sw.t.to_numpy()
    same_next = np.zeros(len(sw), bool)
    same_next[:-1] = (p[1:] == p[:-1]) & (g[1:] == g[:-1])
    nxt_t = np.r_[t[1:], 0]
    nxt_mc = np.r_[sw.pre_mc.to_numpy()[1:], np.nan]
    seg_end, seg_start = segs.t_end.to_numpy(), segs.t_start.to_numpy()
    body = pd.DataFrame({
        "pool": p, "start": t,
        "end": np.where(same_next, nxt_t, seg_end[g]),
        "mc": np.where(same_next, nxt_mc, sw.post_mc.to_numpy()),
    })
    first = np.ones(len(sw), bool)
    first[1:] = (p[1:] != p[:-1]) | (g[1:] != g[:-1])
    head = pd.DataFrame({"pool": p[first], "start": seg_start[g[first]], "end": t[first],
                         "mc": sw.pre_mc.to_numpy()[first]})
    return pd.concat([head, body], ignore_index=True)


def clip_to_window(iv: pd.DataFrame, pools: pd.DataFrame) -> pd.DataFrame:
    """Keep the part of each interval inside (lo, hi]: after the BOOST window, within hours 0-72."""
    lo = pools.lo.to_numpy()[iv.pool.to_numpy()]
    hi = pools.hi.to_numpy()[iv.pool.to_numpy()]
    s = np.maximum(iv.start.to_numpy(), lo)
    e = np.minimum(iv.end.to_numpy(), hi)
    dur = np.where(np.isnan(lo), 0.0, np.clip(e - s, 0, None))
    return pd.DataFrame({"pool": iv.pool.to_numpy(), "mc": iv.mc.to_numpy(), "dur": dur})


def in_window(sw: pd.DataFrame, pools: pd.DataFrame) -> np.ndarray:
    """Swaps strictly after the BOOST window end and before hour 72; BOOST swaps themselves never count."""
    lo = pools.lo.to_numpy()[sw.pool.to_numpy()]
    hi = pools.hi.to_numpy()[sw.pool.to_numpy()]
    t = sw.t.to_numpy()
    return (~np.isnan(lo)) & (t > lo) & (t < hi) & (~sw.is_boost.to_numpy())


def band_seconds(iv: pd.DataFrame, n_pools: int, cuts: np.ndarray):
    """Seconds per pool in the upper band [c, 1.05c) and the lower band [0.95c, c), for each cutoff."""
    lo_e, c, hi_e = band_edges(cuts)
    mc, dur, p = iv.mc.to_numpy(), iv.dur.to_numpy(), iv.pool.to_numpy()
    up = np.zeros((n_pools, len(cuts)))
    dn = np.zeros((n_pools, len(cuts)))
    for k in range(len(cuts)):
        mu = (mc >= c[k]) & (mc < hi_e[k])
        md = (mc >= lo_e[k]) & (mc < c[k])
        up[:, k] = np.bincount(p[mu], weights=dur[mu], minlength=n_pools)
        dn[:, k] = np.bincount(p[md], weights=dur[md], minlength=n_pools)
    return up, dn


def creator_net(sw: pd.DataFrame, win: np.ndarray, n_pools: int, cuts: np.ndarray) -> np.ndarray:
    """Gate 3 numerator: the pool's coin_creator (signer or token owner) net SOL bought, per pool, for swaps whose
    pre-trade market cap is inside [0.95c, 1.05c). SOL is quote_amount (into or out of the pool before fees)."""
    lo_e, _, hi_e = band_edges(cuts)
    mc, v, p = sw.pre_mc.to_numpy(), sw.creator_net_sol.to_numpy(), sw.pool.to_numpy()
    out = np.zeros((n_pools, len(cuts)))
    for k in range(len(cuts)):
        m = win & (mc >= lo_e[k]) & (mc < hi_e[k])
        out[:, k] = np.bincount(p[m], weights=v[m], minlength=n_pools)
    return out


def count_rule_pools(sw: pd.DataFrame, win: np.ndarray, n_pools: int) -> np.ndarray:
    """Pools that trade within ±5% of 420: a non-BOOST swap after the BOOST window and before hour 72 whose
    pre-trade market cap is in [399, 441)."""
    lo_e, _, hi_e = band_edges(np.array([STEP]))
    m = win & (sw.pre_mc.to_numpy() >= lo_e[0]) & (sw.pre_mc.to_numpy() < hi_e[0])
    return np.bincount(sw.pool.to_numpy()[m], minlength=n_pools) > 0


def cross_events(sw: pd.DataFrame, pools: pd.DataFrame, cuts: np.ndarray) -> pd.DataFrame:
    """Return-test entries (causal): the first swap per pool and cutoff, after the BOOST window and before hour 72,
    whose pre-trade cap is below the cutoff and whose own post-trade cap is at or above it. Uses only that row.
    stop_ref is the band floor (399 for 420); the stop sits under it."""
    win = in_window(sw, pools)
    s = sw[win].sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="mergesort")
    out = []
    for k, c in enumerate(cuts):
        m = (s.pre_mc.to_numpy() < c) & (s.post_mc.to_numpy() >= c)
        e = s[m].drop_duplicates("pool", keep="first")
        out.append(pd.DataFrame({"pool": e.pool.to_numpy(), "cutoff_idx": k, "cutoff": c, "t": e.t.to_numpy(),
                                 "slot": e.slot.to_numpy(), "tx_idx": e.tx_idx.to_numpy(), "ev_idx": e.ev_idx.to_numpy(),
                                 "pre_mc": e.pre_mc.to_numpy(), "post_mc": e.post_mc.to_numpy(),
                                 "stop_ref": c * (1 - BAND)}))
    return pd.concat(out, ignore_index=True)
