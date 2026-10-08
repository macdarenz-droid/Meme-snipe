"""PREREG §8: rule extraction (runs only after a validation pass) and the rule test on untouched days.

Features are computed by `MintTape.features`, which sees only the mint's events with a key strictly below the
entry's key (as of the entry slot, before the entry itself). Outcomes (holds, replayed returns) are computed by
separate functions that the feature code never calls."""
import heapq
import math

import numpy as np
import pandas as pd

from . import load, venue
from .costs import FIXED_ROUND_TRIP, REPLAY_DELAY_SLOTS, REPLAY_SPEND
from .ledger import States
from .persist import SEED

WINDOW_S = 600           # same 10-minute window
MATCH_PER_ENTRY = 5
MAX_DEPTH = 3
MIN_LEAF_SHARE = 0.05
FEATURES = ["age_s", "curve_progress", "since_migration_s", "venue", "eff_quote_sol", "ret_5m", "ret_60m",
            "buys_5m", "sells_5m", "uniq_buyers_5m", "size_sol", "boost_done", "creator_share", "top10_share"]
MISSING = -1e18          # a missing feature (e.g. curve progress on a pool) sorts below every value
DEFAULT_SUPPLY = 1_000_000_000_000_000


class MintTape:
    """One mint's SOL swaps and token movements, sorted by key."""

    def __init__(self, sw, mv, create=None, migr=None, boost_key=None, excluded=lambda o: False):
        sw = sw.sort_values("key", kind="stable")
        self.key = sw["key"].to_numpy(np.int64)
        self.bt = sw["bt"].to_numpy(np.int64)
        self.is_buy = sw["is_buy"].to_numpy(bool)
        self.owner = sw["owner"].to_numpy(np.int64)
        self.post = sw["post"].to_numpy(np.int64)
        st = States.rows(sw)
        self.cls = st["cls"].to_numpy()
        self.st = st[["kind", "s1", "s2", "s3", "s4", "bps"]].to_numpy(np.int64)
        n = len(self.key)
        # last[c][i]: index of the last row of class c among rows 0..i (-1 if none)
        self.last = {c: np.maximum.accumulate(np.where(self.cls == c, np.arange(n), -1)) if n else np.zeros(0, int)
                     for c in (0, 1, 2)}
        mv = mv.sort_values("key", kind="stable") if mv is not None and len(mv) else None
        self.mv = mv
        self.create, self.migr, self.boost_key, self.excluded = create, migr, boost_key, excluded

    def _state_before(self, i):
        """Chosen venue state from the swaps before index i (curve while live, else canonical, else other pool)."""
        if i <= 0:
            return None
        rows = [self.last[c][i - 1] for c in (0, 1, 2)]
        c, a, o = rows
        if c >= 0 and self.st[c][4] > 0:
            r = self.st[c]
            return ("c", int(r[1]), int(r[2]), int(r[3]), int(r[4]), int(r[5]))
        for j in (a, o):
            if j >= 0:
                r = self.st[j]
                return ("a", int(r[1]), int(r[2]), int(r[3]), int(r[5]))
        return None

    def features(self, key, bt, size_lamports, holders=None):
        """§8 features as of `key` (strictly earlier events only)."""
        i = int(np.searchsorted(self.key, key, side="left"))
        s = self._state_before(i)
        f = {}
        f["age_s"] = bt - self.create["bt"] if self.create else MISSING
        live_curve = s is not None and s[0] == "c"
        f["curve_progress"] = (venue.CURVE_INITIAL_REAL_TOKENS - s[4]) / venue.CURVE_INITIAL_REAL_TOKENS \
            if live_curve else MISSING
        f["since_migration_s"] = bt - self.migr[1] if (self.migr and not live_curve and self.migr[1] <= bt) else MISSING
        f["venue"] = MISSING if s is None else (0 if live_curve else 1)
        f["eff_quote_sol"] = venue.effective_quote(s) / 1e9 if s is not None else MISSING
        p_now = venue.spot_price(s)
        for name, back in (("ret_5m", 300), ("ret_60m", 3600)):
            j = int(np.searchsorted(self.bt[:i], bt - back, side="right"))
            p0 = venue.spot_price(self._state_before(j)) if j > 0 else float("nan")
            f[name] = p_now / p0 - 1 if (p0 and math.isfinite(p0) and math.isfinite(p_now)) else MISSING
        j5 = int(np.searchsorted(self.bt[:i], bt - 300, side="right"))
        f["buys_5m"] = int(self.is_buy[j5:i].sum())
        f["sells_5m"] = int((~self.is_buy[j5:i]).sum())
        f["uniq_buyers_5m"] = int(len(np.unique(self.owner[j5:i][self.is_buy[j5:i]])))
        f["size_sol"] = size_lamports / 1e9
        f["boost_done"] = 1 if (self.boost_key is not None and self.boost_key < key) else 0
        if holders is not None:
            bal, supply = holders
            cr = self.create["creator"] if self.create else None
            f["creator_share"] = bal.get(cr, 0) / supply if cr is not None else MISSING
            top = heapq.nlargest(10, (b for o, b in bal.items() if b > 0 and not self.excluded(o)))
            f["top10_share"] = sum(top) / supply
        else:
            f["creator_share"] = f["top10_share"] = MISSING
        return f

    def sweep_holders(self, queries):
        """Holder balances as of each query key (strictly before it), in one pass. Yields (query index, balances)."""
        ev = [(int(k), 0, int(o), int(p)) for k, o, p in zip(self.key, self.owner, self.post) if o >= 0]
        if self.mv is not None:
            for k, kd, a, b, amt in zip(self.mv["key"], self.mv["kind"], self.mv["frm"], self.mv["to"],
                                        self.mv["amount"]):
                ev.append((int(k), 1, int(kd), (int(a), int(b), int(amt))))
        ev.sort(key=lambda e: e[0])
        bal, j = {}, 0
        for qi, qk in sorted(enumerate(queries), key=lambda x: x[1]):
            while j < len(ev) and ev[j][0] < qk:
                e = ev[j]
                if e[1] == 0:
                    bal[e[2]] = e[3]
                else:
                    a, b, amt = e[3]
                    if e[2] in (0, 1) and a >= 0:
                        bal[a] = bal.get(a, 0) - amt
                    if e[2] in (0, 2) and b >= 0:
                        bal[b] = bal.get(b, 0) + amt
                j += 1
            yield qi, bal


def tapes_for(units, vocab, mint_ids, ledger_info, excluded):
    """MintTape per mint id from the given units (all days the step reads)."""
    names = {vocab.strs[m] for m in mint_ids}
    sws = [load.swaps(u, vocab, mints=names) for u in units]
    mvs = [load.movements(u, vocab, mints=names) for u in units]
    sw = pd.concat([s for s in sws if len(s)], ignore_index=True)
    sw = sw[sw["sol"].astype(bool) & ~sw["overflow"].astype(bool)]
    mv = pd.concat(mvs, ignore_index=True)
    out = {}
    for m in mint_ids:
        out[m] = MintTape(sw[sw["mint"] == m], mv[mv["mint"] == m], ledger_info["create"].get(m),
                          ledger_info["migr"].get(m), ledger_info["boost_done"].get(m), excluded)
    return out


def entry_features(entries, tapes, ledger_info):
    """entries: frame with mint, key, bt, paid. Returns a features frame aligned to entries."""
    rows = [None] * len(entries)
    for m, idx in entries.groupby("mint").indices.items():
        tape = tapes[m]
        e = entries.iloc[idx]
        cr = ledger_info["create"].get(m)
        supply = (cr or {}).get("supply") or DEFAULT_SUPPLY
        for qi, bal in tape.sweep_holders(e["key"].tolist()):
            r = e.iloc[qi]
            rows[idx[qi]] = tape.features(int(r["key"]), int(r["bt"]), float(r["paid"]), holders=(bal, supply))
    return pd.DataFrame(rows, columns=FEATURES)


def matched_sample(winner_entries, candidates, seed=SEED):
    """Per winner entry, 5 random entries (without replacement) by non-winners in the same 10-minute window."""
    rng = np.random.default_rng(seed)
    cand = candidates.assign(win=candidates["bt"] // WINDOW_S)
    by_w = cand.groupby("win").indices
    picks = []
    for w in (winner_entries["bt"] // WINDOW_S).tolist():
        pool = by_w.get(w)
        if pool is None or len(pool) == 0:
            continue
        k = min(MATCH_PER_ENTRY, len(pool))
        picks.extend(rng.choice(pool, size=k, replace=False).tolist())
    return cand.iloc[picks].drop(columns="win").reset_index(drop=True)


# ---------------------------------------------------------------- the tree
def _gini(y):
    n = len(y)
    if n == 0:
        return 0.0
    p = y.mean()
    return 2 * p * (1 - p)


def fit_tree(X, y, max_depth=MAX_DEPTH, min_leaf_share=MIN_LEAF_SHARE):
    """One CART tree (gini), depth <= 3, every leaf >= 5% of entries. Deterministic: features in FEATURES order,
    thresholds ascending, first best split kept. Missing values are MISSING (below every value)."""
    X = np.asarray(X, np.float64)
    y = np.asarray(y, np.float64)
    min_leaf = int(math.ceil(min_leaf_share * len(y)))

    def grow(idx, depth):
        node = {"n": int(len(idx)), "share": float(y[idx].mean()) if len(idx) else 0.0}
        if depth >= max_depth or len(idx) < 2 * min_leaf:
            return node
        best, base = None, _gini(y[idx]) * len(idx)
        for f in range(X.shape[1]):
            xs = X[idx, f]
            order = np.argsort(xs, kind="stable")
            xs_s, ys_s = xs[order], y[idx][order]
            csum = np.cumsum(ys_s)
            n = len(xs_s)
            k = np.arange(min_leaf, n - min_leaf + 1)
            if len(k) == 0:
                continue
            k = k[xs_s[k - 1] != xs_s[np.minimum(k, n - 1)]]
            if len(k) == 0:
                continue
            nl, nr = k.astype(np.float64), (n - k).astype(np.float64)
            pl, pr = csum[k - 1] / nl, (csum[-1] - csum[k - 1]) / nr
            imp = 2 * pl * (1 - pl) * nl + 2 * pr * (1 - pr) * nr
            j = int(np.argmin(imp))
            if imp[j] < base - 1e-12 and (best is None or imp[j] < best[0] - 1e-12):
                best = (float(imp[j]), f, (xs_s[k[j] - 1] + xs_s[k[j]]) / 2)
        if best is None:
            return node
        _, f, thr = best
        left, right = idx[X[idx, f] <= thr], idx[X[idx, f] > thr]
        node.update({"feature": FEATURES[f] if X.shape[1] == len(FEATURES) else f, "f": f, "thr": float(thr),
                     "left": grow(left, depth + 1), "right": grow(right, depth + 1)})
        return node

    return grow(np.arange(len(y)), 0)


def leaves(node, path=()):
    if "f" not in node:
        yield path, node
        return
    yield from leaves(node["left"], path + ((node["f"], "<=", node["thr"]),))
    yield from leaves(node["right"], path + ((node["f"], ">", node["thr"]),))


def best_leaf(tree):
    """The leaf with the highest share of winners (ties: the larger leaf, then the first)."""
    best = None
    for path, leaf in leaves(tree):
        k = (leaf["share"], leaf["n"])
        if best is None or k > best[0]:
            best = (k, path, leaf)
    return best[1], best[2]


def in_leaf(X, path):
    X = np.asarray(X, np.float64)
    ok = np.ones(len(X), bool)
    for f, op, thr in path:
        ok &= X[:, f] <= thr if op == "<=" else X[:, f] > thr
    return ok


def extract(win_X, win_hold, ctl_X):
    """The frozen rule: tree on winners (1) vs matched (0); rule = best leaf; hold = winners' median hold in it."""
    X = np.vstack([win_X, ctl_X])
    y = np.r_[np.ones(len(win_X)), np.zeros(len(ctl_X))]
    tree = fit_tree(X, y)
    path, leaf = best_leaf(tree)
    mask = in_leaf(win_X, path)
    hold = float(np.median(np.asarray(win_hold)[mask])) if mask.any() else float("nan")
    return {"tree": tree, "path": [(FEATURES[f], op, thr) for f, op, thr in path], "path_idx": path,
            "leaf": leaf, "hold_slots": hold}


# ---------------------------------------------------------------- rule test (untouched days; outcome stage)
def replay_entry(rows_states, mint, entry_slot, exit_slot):
    """$50 in at the end of entry_slot, all out at the end of exit_slot; return net of fixed costs."""
    from .replay import END_OF_SLOT, _tuple
    h = States()
    se = h.asof(rows_states, [mint], load.make_key([entry_slot], END_OF_SLOT, 255))
    sx = h.asof(rows_states, [mint], load.make_key([exit_slot], END_OF_SLOT, 255))
    tok, _ = venue.buy_exact_in(_tuple(se, 0), REPLAY_SPEND)
    if tok <= 0:
        return float("nan")
    return (venue.sell(_tuple(sx, 0), tok) - REPLAY_SPEND - FIXED_ROUND_TRIP) / REPLAY_SPEND


def rule_test_trades(fires, controls, rows_states, hold_slots):
    """fires/controls: frames with mint, slot, day. Entry D = slot + 23; exit = entry + hold."""
    out = []
    for name, df in (("rule", fires), ("control", controls)):
        for m, s, d in zip(df["mint"], df["slot"], df["day"]):
            e = int(s) + REPLAY_DELAY_SLOTS
            out.append({"arm": name, "day": d, "mint": int(m), "entry_slot": e,
                        "ret": replay_entry(rows_states, int(m), e, e + int(round(hold_slots)))})
    return pd.DataFrame(out)


def rule_test_verdict(trades, b=10_000, seed=SEED):
    """§8 pass: 99.5% lower bound > 0 (bootstrap over trades, OPEN_QUESTIONS Q20), >= 300 trades, positive on each
    day, and the lift over the control > 0."""
    r = trades[(trades["arm"] == "rule") & np.isfinite(trades["ret"])]
    c = trades[(trades["arm"] == "control") & np.isfinite(trades["ret"])]
    x = r["ret"].to_numpy()
    if len(x) == 0:
        return {"pass": False, "trades": 0}
    rng = np.random.default_rng(seed)
    boots = np.array([x[rng.integers(0, len(x), len(x))].mean() for _ in range(b)])
    lo = float(np.percentile(boots, 0.25))
    per_day = r.groupby("day")["ret"].mean()
    liftc = float(x.mean() - c["ret"].mean()) if len(c) else float("nan")
    ok = lo > 0 and len(x) >= 300 and bool((per_day > 0).all()) and liftc > 0
    return {"pass": bool(ok), "trades": int(len(x)), "mean": float(x.mean()), "lower99_5": lo,
            "per_day": {k: float(v) for k, v in per_day.items()}, "lift_over_control": liftc}


def rule_fires(cands, X, path_idx, hold_slots):
    """Rule firings on untouched days: candidate entries (opening buys; mint, slot, bt, key, day) whose as-of
    features fall in the rule's leaf; at most one open rule position per mint (OPEN_QUESTIONS Q19)."""
    hit = in_leaf(X, path_idx)
    c = cands[hit].sort_values("key", kind="stable")
    busy_until, keep = {}, []
    span = REPLAY_DELAY_SLOTS + int(round(hold_slots))
    for i, m, s in zip(c.index, c["mint"], c["slot"]):
        if s <= busy_until.get(m, -1):
            continue
        busy_until[m] = s + span
        keep.append(i)
    return c.loc[keep, ["mint", "slot", "bt", "day"]].reset_index(drop=True)


def control_entries(fires, candidates, seed=SEED):
    """Per fire, one random eligible coin (another mint with a SOL swap in the same 10-minute window)."""
    rng = np.random.default_rng(seed + 1)
    cand = candidates.assign(win=candidates["bt"] // WINDOW_S)
    by_w = {w: g["mint"].unique() for w, g in cand.groupby("win")}
    out = []
    for m, s, bt, d in zip(fires["mint"], fires["slot"], fires["bt"], fires["day"]):
        ms = by_w.get(bt // WINDOW_S)
        if ms is None:
            continue
        ms = ms[ms != m]
        if len(ms):
            out.append({"mint": int(rng.choice(ms)), "slot": int(s), "bt": int(bt), "day": d})
    return pd.DataFrame(out, columns=["mint", "slot", "bt", "day"])
