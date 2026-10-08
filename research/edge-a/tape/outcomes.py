"""Design A return test: the outcome stage, frozen by research/edge-a/AMENDMENT_2.md Q9. It runs only when both gates
pass and count row 6 does not mark the result "not separable from a USD level" (Q11).

Entry: the causal cross events of features.cross_events (only the crossing row is read); buy at the crossing slot +
23 slots, at the worse of that slot's start and end state; one entry per pool and level. Exit, whichever comes first:
the stop (the first later swap whose pre-trade cap is below 0.95 L, sold at its slot + 23) or the time exit (the first
block at or after entry + 60 min, + 23 slots), at the worse of the exit slot's start and end state. Costs in SOL: the
fee tier the program applies at our own trade's cap (fee-configs.json), impact on effective reserves, a sell the real
vault cannot pay is a total loss, and the edge-costs fixed cost with rent by date (RENT_BOUNDARY.md, 128 + 170 bytes).
Statistics: mean net return of the 420 trades and its lift over the pooled placebo-level trades, pool-clustered
bootstrap stratified by day, 10,000 resamples, seed 20261009, 99.58% two-sided. Pass: both lower bounds above 0, at
least 300 trades, and every day read positive. This module reads states after the entry; features.py and gates.py never
import it.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

DELAY_SLOTS = 23
HOLD_S = 3600
STOP_FRAC = 0.95
SPEND_50USD = 419_252_054        # $50 at $119.26 (primary)
SPEND_5USD = 41_925_205          # $5 (the trial size, reported)
B_RESAMPLES = 10_000
SEED = 20261009
LEVEL = 1 - 0.05 / 12            # 99.58% two-sided
MIN_TRADES = 300
BPS = 10_000
ACCOUNT_BYTES = 128 + 170        # Token-2022 account (the larger); the mint's token program is not read
RENT_6333_FROM_SLOT = 444_096_000   # RENT_BOUNDARY.md: first slot of epoch 1028
RENT_5080_FROM_SLOT = 446_256_000   # epoch 1033

# edge-costs.ts expectedFixed terms (the same as research/w1-winner-autopsy/tape/w1/costs.py)
_BASE, _ENTRY_PRIORITY, _TIP, _LADDER = 5_000, 20_000, 5_000, [20_000, 60_000, 150_000, 500_000]
_MAX_ATTEMPTS, _LAND, _CLOSE, _DUST = 5, 0.56, 0.9, 0.05


def rent_rate(slot: int) -> int:
    if slot >= RENT_5080_FROM_SLOT:
        return 5_080
    return 6_333 if slot >= RENT_6333_FROM_SLOT else 6_960


def expected_fixed(rent: float) -> float:
    entry = _BASE + _ENTRY_PRIORITY + _TIP
    exit_ = _BASE + _LADDER[0] + _TIP
    failed_exit = _BASE + _LADDER[2]
    failed = sum((1 - _LAND) ** k for k in range(1, _MAX_ATTEMPTS + 1))
    return entry + exit_ + failed * failed_exit + (1 - _CLOSE * (1 - _DUST)) * rent \
        + (1 - _CLOSE) * (1 - _DUST) * failed_exit


def fixed_for(entry_slot: int) -> float:
    return expected_fixed(ACCOUNT_BYTES * rent_rate(entry_slot))


def load_tiers(path: str):
    with open(path) as f:
        t = json.load(f)["amm"]["fee_tiers"]
    th = np.array([int(x["market_cap_lamports_threshold"]) for x in t], dtype=float)
    fees = [(int(x["fees"]["lp_fee_bps"]), int(x["fees"]["protocol_fee_bps"]), int(x["fees"]["creator_fee_bps"]))
            for x in t]
    return th, fees


def tier_fees(tiers, eff: int, base: int, supply: int):
    """The tier the program applies at this state's cap (last threshold <= cap, fees.ts selectFeeTier)."""
    th, fees = tiers
    cap = eff * supply // base
    return fees[max(int(np.searchsorted(th, cap, side="right")) - 1, 0)]


def _fee(amount: int, bps: int) -> int:
    return (amount * bps + BPS - 1) // BPS


def _usable(st) -> bool:
    return st is not None and st[0] > 0 and st[1] > 0 and st[1] + st[2] > 0 and st[3] > 0


def buy(st, spend: int, tiers):
    """pump-swap.ts poolBuyExactQuoteIn (v1), as research/d1-discovery-funnel/tape/d1/costs.py. st = (base, vault,
    virt, supply). Returns tokens, or None."""
    if not _usable(st) or spend <= 1:
        return None
    base, vault, virt, supply = st
    eff = vault + virt
    lp_b, pr_b, cr_b = tier_fees(tiers, eff, base, supply)
    untrimmed = spend * BPS // (BPS + lp_b + pr_b + cr_b)
    over = untrimmed + _fee(untrimmed, lp_b) + _fee(untrimmed, pr_b) + _fee(untrimmed, cr_b) - spend
    quote = untrimmed - over if over > 0 else untrimmed
    inp = quote - 1
    out = base * inp // (eff + inp)
    return out if out > 0 else None


def sell(st, tokens: int, tiers):
    """pump-swap.ts poolSell: SOL received. A sell the real vault cannot pay is refused: None (total loss)."""
    if not _usable(st) or tokens <= 0:
        return None
    base, vault, virt, supply = st
    eff = vault + virt
    lp_b, pr_b, cr_b = tier_fees(tiers, eff, base, supply)
    quote = eff * tokens // (base + tokens)
    lp = _fee(quote, lp_b)
    if vault < quote - lp:
        return None
    return max(0, quote - lp - _fee(quote, pr_b) - _fee(quote, cr_b))


class Book:
    """Per-pool post-swap states from each swap's own chain reading (never a later row's pre-trade reserves)."""

    def __init__(self, sw: pd.DataFrame):
        s = sw.sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="mergesort")
        self.p = {}
        for pool, g in s.groupby("pool", sort=False):
            st = np.column_stack([g[c].to_numpy(float) for c in ("base_post", "vault_post", "virt", "supply")])
            self.p[pool] = (g.slot.to_numpy(np.int64), g.pre_mc.to_numpy(float), st)

    def state(self, pool, slot, before: bool):
        """The state after the last swap with slot < `slot` (before=True, the slot's start) or <= `slot` (its end)."""
        sl, _, st = self.p[pool]
        i = int(np.searchsorted(sl, slot, side="left" if before else "right")) - 1
        if i < 0 or not np.all(np.isfinite(st[i])):
            return None
        return tuple(int(x) for x in st[i])

    def stop_slot(self, pool, after_slot, level):
        """First swap after `after_slot` whose pre-trade cap is below 0.95 L (known at that swap)."""
        sl, pre, _ = self.p[pool]
        j = np.flatnonzero((sl > after_slot) & (pre < STOP_FRAC * level))
        return int(sl[j[0]]) if len(j) else None


def _worse_buy(book, pool, slot, spend, tiers):
    got = [buy(book.state(pool, slot, b), spend, tiers) for b in (True, False)]
    got = [g for g in got if g is not None]
    return min(got) if got else None


def _worse_sell(book, pool, slot, tokens, tiers):
    """Worse of start and end; a state missing or a vault that cannot pay is a total loss (0 SOL)."""
    got = [sell(book.state(pool, slot, b), tokens, tiers) for b in (True, False)]
    return 0 if any(g is None for g in got) else min(got)


def trades(sw, entries, blocks, segs, tiers, spend=SPEND_50USD, seg_of=None) -> pd.DataFrame:
    """One row per entry event: entry and exit slots, exit kind, proceeds and net return, or a drop reason."""
    book = Book(sw)
    bs = blocks.sort_values("slot")
    bslot, btime = bs.slot.to_numpy(np.int64), bs.block_time.to_numpy(np.int64)

    def first_block(slot=None, t=None):
        i = np.searchsorted(bslot, slot) if t is None else np.searchsorted(btime, t)
        return (int(bslot[i]), int(btime[i])) if i < len(bslot) else (None, None)

    def segment(slot):
        f, to = segs.from_slot.to_numpy(), segs.to_slot.to_numpy()
        i = int(np.searchsorted(f, slot, side="right")) - 1
        return i if i >= 0 and slot <= to[i] else -1

    rows = []
    for e in entries.itertuples(index=False):
        r = {"pool": e.pool, "cutoff_idx": int(e.cutoff_idx), "cutoff": float(e.cutoff), "cross_slot": int(e.slot),
             "entry_slot": int(e.slot) + DELAY_SLOTS, "dropped": ""}
        es = r["entry_slot"]
        seg = segment(int(e.slot))
        eb, et = first_block(slot=es)
        if seg < 0 or segment(es) != seg or eb is None:
            rows.append({**r, "dropped": "entry_not_on_tape"})
            continue
        tok = _worse_buy(book, e.pool, es, spend, tiers)
        if tok is None:
            rows.append({**r, "dropped": "entry_unquotable"})
            continue
        ts, _ = first_block(t=et + HOLD_S)
        stop = book.stop_slot(e.pool, es, e.cutoff)
        if stop is not None and (ts is None or stop <= ts):
            kind, xs = "stop", stop + DELAY_SLOTS
        elif ts is not None:
            kind, xs = "time", ts + DELAY_SLOTS
        else:
            rows.append({**r, "dropped": "exit_not_on_tape"})
            continue
        if segment(xs) != seg:
            rows.append({**r, "dropped": "exit_not_on_tape"})
            continue
        proceeds = _worse_sell(book, e.pool, xs, tok, tiers)
        fixed = fixed_for(es)
        day = datetime.fromtimestamp(et, tz=timezone.utc).strftime("%Y-%m-%d")
        rows.append({**r, "day": day, "exit_kind": kind, "exit_slot": xs, "tokens": tok, "proceeds": proceeds,
                     "fixed": fixed, "ret": (proceeds - spend - fixed) / spend})
    cols = ["pool", "cutoff_idx", "cutoff", "cross_slot", "entry_slot", "dropped", "day", "exit_kind", "exit_slot",
            "tokens", "proceeds", "fixed", "ret"]
    return pd.DataFrame(rows, columns=cols)


def _stats(main_ret, ctrl_ret):
    m = float(np.mean(main_ret)) if len(main_ret) else -np.inf
    c = float(np.mean(ctrl_ret)) if len(ctrl_ret) else np.nan
    return m, (m - c) if np.isfinite(c) else -np.inf


def bootstrap(tr: pd.DataFrame, n_boot=B_RESAMPLES, seed=SEED, level=LEVEL) -> dict:
    """Pool-clustered bootstrap stratified by day: within each day, its pools are drawn with replacement and every trade
    (420 and placebo) of a drawn pool that day comes along. Undefined draws count as minus infinity."""
    t = tr[tr["dropped"] == ""].reset_index(drop=True)
    is_main = (t["cutoff_idx"] == 0).to_numpy()
    ret = t["ret"].to_numpy(float)
    point = _stats(ret[is_main], ret[~is_main])
    strata = [[np.asarray(ix) for ix in g.groupby("pool", sort=True).groups.values()]
              for _, g in t.groupby("day", sort=True)]
    rng = np.random.default_rng(seed)
    reps = np.empty((n_boot, 2))
    for b in range(n_boot):
        idx = np.concatenate([np.concatenate([pools[k] for k in rng.integers(0, len(pools), len(pools))])
                              for pools in strata]) if strata else np.zeros(0, int)
        reps[b] = _stats(ret[idx][is_main[idx]], ret[idx][~is_main[idx]])
    reps[~np.isfinite(reps)] = -np.inf
    a = (1 - level) / 2
    lo = np.quantile(reps, a, axis=0, method="linear") if n_boot else np.array([-np.inf, -np.inf])
    hi = np.quantile(reps, 1 - a, axis=0, method="linear") if n_boot else np.array([-np.inf, -np.inf])
    lo = np.where(np.isfinite(lo), lo, -np.inf)
    return {"mean": point[0], "lift": point[1], "mean_lo": float(lo[0]), "lift_lo": float(lo[1]),
            "mean_hi": float(hi[0]), "lift_hi": float(hi[1]), "level": level, "n_boot": n_boot, "seed": seed}


def judge(tr: pd.DataFrame, days, n_boot=B_RESAMPLES, seed=SEED) -> dict:
    t = tr[tr["dropped"] == ""]
    main = t[t["cutoff_idx"] == 0]
    st = bootstrap(tr, n_boot, seed)
    per_day = {d: (float(main.loc[main["day"] == d, "ret"].mean()) if (main["day"] == d).any() else None)
               for d in sorted(days)}
    each_day = all(v is not None and v > 0 for v in per_day.values()) and bool(per_day)
    n = int(len(main))
    passed = bool(st["mean_lo"] > 0 and st["lift_lo"] > 0 and n >= MIN_TRADES and each_day)
    verdict = "pass" if passed else ("unresolved: fewer than 300 trades" if n < MIN_TRADES else "not supported")
    return {**st, "n_trades": n, "n_control_trades": int(len(t) - n), "mean_by_day": per_day,
            "dropped": tr.loc[tr["dropped"] != "", "dropped"].value_counts().to_dict(), "verdict": verdict,
            "passed": passed,
            "tradability": "works only below H8's floor; use needs the owner" if passed else None}


def score_return_test(sw, entries, blocks, segs, tiers, days, n_boot=B_RESAMPLES, seed=SEED) -> dict:
    """AMENDMENT_2 Q9: $50 primary, $5 reported as the trial size."""
    out = {}
    for name, spend in (("$50", SPEND_50USD), ("$5", SPEND_5USD)):
        tr = trades(sw, entries, blocks, segs, tiers, spend)
        out[name] = judge(tr, days, n_boot, seed)
    out["primary"] = "$50"
    return out
