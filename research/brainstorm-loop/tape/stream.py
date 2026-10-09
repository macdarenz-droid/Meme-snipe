"""Streaming reader for the Step A count rows: both Step A days in bounded memory, with the same outputs as the
in-memory Tape (run_step_a.compute_memory). Reads only; computes nothing new.

Why: the in-memory Tape keeps every swap of every unit (about 0.37 GB a unit compact, ~23 GB a day). Almost every
row reads one mint or one pool at a time, so here the swaps live on disk, split by mint into shards, and each shard is
loaded alone. What crosses mints is built once over every unit and kept small:
- E's events (creates, migrations, pool creates, BOOST, LP moves, re-prices), B's blocks and the coverage;
- the canonical-pool set and the curve mayhem flags (eligible pools), the creator roles and CF counts (Gate 3);
- the T/W links as an indexed graph (creator groups, both cluster rules, the as-of two-sided label, MIG-SEAT's W group);
- W1's fast class per owner-day and its as-of index over every buy;
- the failed transactions of graduation pools (G3), the only F rows a row reads.

Pass 0 reads E of every unit. Pass 1 reads each unit once: compacts it as the Tape does (tapeio.compact_*), writes
its swaps and T moves to shard files, and keeps the links, blocks and per-unit aggregates. Pass A reads each shard for
W1's buys and the creator roles. Pass B runs every row on each shard and keeps the row records with the position the
in-memory run gives them; the merge sorts them back into that order and runs the same summaries.

The prep-only mode (run_prep) runs the preparation stages only: loading, labels, as-of features, the event, control,
decision and graduation tables and their counts, and never a flow after an event, an outcome, a bootstrap, a payer bar
or a gate (test_stream.PrepOnly).
"""
from __future__ import annotations

import gc
import json
import os
import pickle
import shutil
import tempfile
import time
import zlib
from collections import Counter

import numpy as np
import pandas as pd
import zstandard

import h8 as H8
import migseat as MS
import rebuy as RB
import rows as R
import slicer as SL
from tapeio import (AMM_COLS, CURVE_COLS, EVENT_NAMES, STR_COLS, WSOL, Interner, Tape, _trim, compact_fails,
                    compact_moves, compact_swaps, compact_w, read_csv, read_events, sig_hash, swaps_from, unit_info)

ROWS_PER_SHARD = 1_500_000          # target swaps a shard (the shard count only changes memory, never a result)
BYTES_PER_ROW = 190                 # zstd S_amm + S_curve bytes a swap row, measured on 09-11 units
EVENT_FIELDS = {"mint", "creator", "user", "is_mayhem_mode", "quote_mint", "name", "symbol", "pool", "base_mint",
                "coin_creator", "pool_quote_amount", "pool_base_amount", "quote_amount_in_used",
                "quote_amount_in_requested", "lp_token_amount_out", "lp_token_amount_in", "virtual_sol_reserves",
                "virtual_token_reserves", "new_virtual_sol_reserves", "new_virtual_token_reserves",
                "real_sol_reserves", "real_token_reserves"}


class StreamError(Exception):
    """Raised when the tape breaks an assumption the sharding needs (it would change a result)."""


# ============================================================================ vocabulary and graphs
class Vocab:
    """The shared vocabulary in sorted order (as tapeio.Interner.finish sorts it), held as bytes. rank[reading code]
    is the word's position in the sorted order."""

    def __init__(self, words):
        arr = np.array(words, dtype=object)
        order = np.argsort(arr, kind="stable") if len(arr) else np.array([], dtype=np.int64)
        self.rank = np.empty(len(arr), dtype=np.int32)
        self.rank[order] = np.arange(len(arr), dtype=np.int32)
        try:
            self.words = np.array(list(arr[order]), dtype="S") if len(arr) else np.array([], dtype="S1")
        except UnicodeEncodeError:
            self.words = np.array([w.encode() for w in arr[order]], dtype="S")
        self.utf8 = True
        del arr, order

    def __len__(self):
        return len(self.words)

    def lookup(self, w) -> int:
        if not isinstance(w, str) or not len(self.words):
            return -1
        b = w.encode()
        i = int(np.searchsorted(self.words, b))
        return i if i < len(self.words) and self.words[i] == b else -1

    def lookup_many(self, ws) -> np.ndarray:
        out = np.full(len(ws), -1, dtype=np.int64)
        ok = np.array([isinstance(w, str) for w in ws], bool)
        if not ok.any() or not len(self.words):
            return out
        b = np.array([w.encode() for w in np.asarray(ws, dtype=object)[ok]], dtype="S")
        i = np.searchsorted(self.words, b)
        i2 = np.minimum(i, len(self.words) - 1)
        hit = self.words[i2] == b
        out[np.nonzero(ok)[0][hit]] = i2[hit]
        return out

    def word(self, r) -> str:
        return self.words[r].decode()

    def words_of(self, ranks) -> list:
        return [w.decode() for w in self.words[np.asarray(ranks, dtype=np.int64)]]


def _csr(node, nbr, slot, first, n_nodes):
    """Distinct (node, neighbour) pairs with their first (minimum) slot, sorted by (node, slot, first appearance)."""
    key = node.astype(np.int64) * n_nodes + nbr
    o = np.argsort(key, kind="stable")
    ks = key[o]
    starts = np.r_[0, np.nonzero(np.diff(ks))[0] + 1] if len(ks) else np.array([], dtype=np.int64)
    uk = ks[starts]
    mins = np.minimum.reduceat(slot[o], starts) if len(ks) else np.array([], dtype=np.int64)
    fst = first[o][starts] if len(ks) else np.array([], dtype=np.int64)    # o is stable: the first appearance
    del o, ks
    na, nb = uk // n_nodes, uk % n_nodes
    o = np.lexsort((fst, mins, na))
    na, nb, mins = na[o], nb[o].astype(np.int32), mins[o]
    indptr = np.searchsorted(na, np.arange(n_nodes + 1))
    return indptr, nb, mins


def connected_labels(a, b, n):
    """Connected components of the undirected edges (a, b) over n nodes: each node's label is the smallest node of its
    component (min-label propagation with pointer jumping; numpy only)."""
    lab = np.arange(n, dtype=np.int64)
    if not len(a):
        return lab
    while True:
        m = np.minimum(lab[a], lab[b])
        new = lab.copy()
        np.minimum.at(new, a, m)
        np.minimum.at(new, b, m)
        while True:                       # pointer jumping: every node to its label's label
            nx = new[new]
            if np.array_equal(nx, new):
                break
            new = nx
        if np.array_equal(new, lab):
            return lab
        lab = new


class LinkGraph:
    """T/W links (tape.links) indexed by node: each node's distinct neighbours with the first slot they were linked,
    in the order rows.TwoSidedAsOf gives them (slot, then first appearance). Serves rows.creator_group (as `adj`:
    .get and .degree_as_of give what rows.adjacency's lists give: a neighbour counts as of a slot when any of its
    links is on or before it), TwoSidedAsOf's as-of reads, and the two cluster rules."""

    def __init__(self, a, b, slot, vocab: Vocab, hub_cap=R.HUB_CAP):
        self.vocab, n = vocab, max(len(vocab), 1)
        A = np.r_[a, b].astype(np.int64)
        B = np.r_[b, a].astype(np.int64)
        S = np.r_[slot, slot].astype(np.int64)
        first = np.arange(len(A), dtype=np.int64)
        self.indptr, self.nbr, self.slot = _csr(A, B, S, first, n)
        del A, B, S, first
        deg = np.diff(self.indptr)
        self.hub = deg > hub_cap
        self.hub_cap = hub_cap
        # hub-cap-50 rule: components of the links that touch no hub (rows.cluster_maps)
        self.capped, self.capped_size = self._components(a, b)
        # hub-keyed rule: each owner linked to a hub, keyed by the hub of its earliest hub link (L is in slot order)
        ha, hb = self.hub[a], self.hub[b]
        x = ha ^ hb
        hub_of = np.where(ha[x], a[x], b[x])
        other = np.where(ha[x], b[x], a[x])
        u, fi = np.unique(other, return_index=True)
        self.keyed = np.full(n, -1, dtype=np.int64)
        self.keyed[u] = hub_of[fi]
        self.keyed_size = np.bincount(self.keyed[self.keyed >= 0], minlength=n)

    def _components(self, a, b):
        n = max(len(self.vocab), 1)
        keep = ~self.hub[a] & ~self.hub[b]
        ka, kb = a[keep], b[keep]
        involved = np.zeros(n, bool)
        involved[ka] = True
        involved[kb] = True
        lab = connected_labels(ka, kb, n)
        lab = np.where(involved, lab, -1).astype(np.int64)
        size = np.bincount(lab[lab >= 0], minlength=n) if involved.any() else np.zeros(n, np.int64)
        return lab, size

    # -------------------------------------------------- rows.creator_group's adjacency
    def _rank(self, x):
        return self.vocab.lookup(x)

    def get(self, x, default=()):
        r = self._rank(x)
        if r < 0:
            return default
        lo, hi = self.indptr[r], self.indptr[r + 1]
        return list(zip(self.vocab.words_of(self.nbr[lo:hi]), self.slot[lo:hi].tolist()))

    def degree_as_of(self, x, slot) -> int:
        r = self._rank(x)
        if r < 0:
            return 0
        lo, hi = self.indptr[r], self.indptr[r + 1]
        return int(np.searchsorted(self.slot[lo:hi], slot, side="right"))

    def before(self, x, st):
        """TwoSidedAsOf._links: [(slot, neighbour)] with slot < st, in order."""
        r = self._rank(x)
        if r < 0:
            return []
        lo, hi = self.indptr[r], self.indptr[r + 1]
        k = int(np.searchsorted(self.slot[lo:hi], st, side="left"))
        return list(zip(self.slot[lo:lo + k].tolist(), self.vocab.words_of(self.nbr[lo:lo + k])))

    def count_before(self, x, st) -> int:
        r = self._rank(x)
        if r < 0:
            return 0
        lo, hi = self.indptr[r], self.indptr[r + 1]
        return int(np.searchsorted(self.slot[lo:hi], st, side="left"))

    def nbytes(self):
        return sum(v.nbytes for v in (self.indptr, self.nbr, self.slot, self.hub, self.capped, self.capped_size,
                                      self.keyed, self.keyed_size))


class WGraph:
    """W (SOL) links indexed by node, for migseat.w_group: every address within `hops` links on or before a slot."""

    def __init__(self, a, b, slot, vocab: Vocab):
        self.vocab, n = vocab, max(len(vocab), 1)
        A = np.r_[a, b].astype(np.int64)
        B = np.r_[b, a].astype(np.int64)
        S = np.r_[slot, slot].astype(np.int64)
        self.indptr, self.nbr, self.slot = _csr(A, B, S, np.arange(len(A), dtype=np.int64), n)

    def within(self, seeds, as_of_slot, hops=2):
        seen = {x for x in seeds if isinstance(x, str) and x}
        frontier = [(x, self.vocab.lookup(x)) for x in seen]
        for _ in range(hops):
            nxt = []
            for _, r in frontier:
                if r < 0:
                    continue
                lo, hi = self.indptr[r], self.indptr[r + 1]
                k = int(np.searchsorted(self.slot[lo:hi], as_of_slot, side="right"))
                for y in self.nbr[lo:lo + k].tolist():
                    w = self.vocab.word(y)
                    if w not in seen:
                        seen.add(w)
                        nxt.append((w, y))
            frontier = nxt
        return seen


class ClusterGet:
    """rows.cluster_maps' hub-cap-50 map as slicer.dispersed_controls reads it: cmap.get(owner, owner)."""

    def __init__(self, graph: LinkGraph):
        self.g = graph

    def get(self, o, default=None):
        r = self.g.vocab.lookup(o)
        c = self.g.capped[r] if r >= 0 else -1
        return int(c) if c >= 0 else default

    def many(self, owners):
        r = self.g.vocab.lookup_many(owners)
        c = np.where(r >= 0, self.g.capped[np.maximum(r, 0)], -1)
        out = np.empty(len(owners), dtype=object)
        for i, (ci, o) in enumerate(zip(c.tolist(), owners)):
            out[i] = ci if ci >= 0 else o
        return out


class StreamTwoSided(R.TwoSidedAsOf):
    """rows.TwoSidedAsOf over the whole-tape link graph and one shard's swaps (its mints' trades are all there)."""

    def __init__(self, graph: LinkGraph, s: pd.DataFrame, window=R.TWO_SIDED_SLOTS, hub_cap=R.HUB_CAP):
        self.window, self.hub_cap, self.g = window, hub_cap, graph
        x = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
        self.tr = {m: g for m, g in x.groupby("mint", sort=False)}
        self._deg = {}

    def _links(self, n, st):
        return self.g.before(n, st)

    def _hub(self, n, st) -> bool:
        key = (n, st)
        if key not in self._deg:
            self._deg[key] = self.g.count_before(n, st)
        return self._deg[key] > self.hub_cap


# ============================================================================ W1 fast class over every buy
class FastIndex:
    """slicer.FastAsOf over every buy of every shard (W1 §5 flags as of a slot), keyed by (day, owner)."""

    def __init__(self, days, vocab: Vocab, key, slot, order, na, nb):
        self.days = {d: i for i, d in enumerate(days)}
        self.vocab, self.n = vocab, np.int64(max(len(vocab), 1))
        o = np.lexsort((order, slot, key))
        key, self.slot = key[o], slot[o]
        na, nb = na[o].astype(np.int64), nb[o].astype(np.int64)
        del o
        starts = np.r_[0, np.nonzero(np.diff(key))[0] + 1] if len(key) else np.array([], dtype=np.int64)
        self.keys = key[starts]
        self.starts = np.r_[starts, len(key)].astype(np.int64)
        self.cna, self.cnb = np.cumsum(na), np.cumsum(nb)
        cnt = np.diff(self.starts)
        sna = np.add.reduceat(na, starts) if len(key) else np.array([], np.int64)
        snb = np.add.reduceat(nb, starts) if len(key) else np.array([], np.int64)
        # rows.w1_fast_class: per (day, owner), the means of the two flags (sum / count, as pandas' group mean)
        fast = (sna / cnt >= 0.10) | (snb / cnt >= 0.30) if len(key) else np.array([], bool)
        self.fast_keys = self.keys[fast]
        self.n_groups = int(len(self.keys))
        self.n_fast = int(fast.sum())

    def _group(self, day, owner):
        d = self.days.get(day)
        r = self.vocab.lookup(owner)
        if d is None or r < 0:
            return None
        k = np.int64(d) * self.n + r
        i = int(np.searchsorted(self.keys, k))
        if i >= len(self.keys) or self.keys[i] != k:
            return None
        return int(self.starts[i]), int(self.starts[i + 1])

    def _flags(self, g, n):
        lo = g[0]
        base_a = self.cna[lo - 1] if lo > 0 else 0
        base_b = self.cnb[lo - 1] if lo > 0 else 0
        a, b = float(self.cna[lo + n - 1] - base_a), float(self.cnb[lo + n - 1] - base_b)
        return bool(a / n >= 0.10 or b / n >= 0.30)

    def __call__(self, day, owner, slot) -> bool:
        g = self._group(day, owner)
        if g is None:
            return False
        n = int(np.searchsorted(self.slot[g[0]:g[1]], slot, side="right"))
        return self._flags(g, n) if n else False

    def before(self, day, owner, slot):
        g = self._group(day, owner)
        n = int(np.searchsorted(self.slot[g[0]:g[1]], slot, side="left")) if g is not None else 0
        return self._flags(g, n) if n else None

    def nbytes(self):
        return sum(v.nbytes for v in (self.slot, self.keys, self.starts, self.cna, self.cnb, self.fast_keys))


class FastMap:
    """rows.w1_fast_class's Series as the rows read it: .get((day, owner), False), .sum() and len()."""

    def __init__(self, idx: FastIndex):
        self.idx = idx

    def get(self, k, default=False):
        d, o = k
        di = self.idx.days.get(d)
        r = self.idx.vocab.lookup(o)
        if di is None or r < 0:
            return default
        key = np.int64(di) * self.idx.n + r
        i = int(np.searchsorted(self.idx.fast_keys, key))
        if i < len(self.idx.fast_keys) and self.idx.fast_keys[i] == key:
            return True
        j = int(np.searchsorted(self.idx.keys, key))
        return False if (j < len(self.idx.keys) and self.idx.keys[j] == key) else default

    def sum(self):
        return self.idx.n_fast

    def __len__(self):
        return self.idx.n_groups


class FrozenCtx(H8.GateCtx):
    """GateCtx for the H8 strata after the shards: the size-free checks were computed on each point's shard (where
    the pool's trades are), so a point outside that cache is a bug, never a silent "no candles"."""

    def __init__(self, tape, hourly, base):
        super().__init__(tape, pd.DataFrame(columns=["venue", "pool", "order"]), hourly)
        self._base = dict(base)

    def _base_check(self, pool, t, st):
        raise StreamError(f"H8 check for {(pool, t, st)} was not computed on its shard")


# ============================================================================ the streaming tape
def _maxrss_mb():
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss >> 10


def _dump(obj, path):
    with open(path, "wb") as fh:
        fh.write(zstandard.ZstdCompressor(level=3).compress(pickle.dumps(obj, protocol=5)))


def _load(path):
    with open(path, "rb") as fh:
        return pickle.loads(zstandard.ZstdDecompressor().decompress(fh.read()))


class ShardTape(Tape):
    """A Tape for one shard: its swaps and T moves, and every whole-tape part of the StreamTape."""

    def __init__(self, base: "StreamTape", swaps, moves):     # noqa: super().__init__ reads units; not used here
        self.__dict__.update({k: v for k, v in base.__dict__.items() if k not in ("swaps", "moves")})
        self.swaps, self.moves = swaps, moves


class StreamTape(Tape):
    def __init__(self, paths, workdir=None, shards=None, log=None):
        self.log = log or (lambda *a: None)
        self.own_dir = workdir is None
        self.dir = workdir or tempfile.mkdtemp(prefix="stepa-stream-")
        os.makedirs(self.dir, exist_ok=True)
        self.compact = True
        self.paths = list(paths)
        infos = [unit_info(p) for p in self.paths]
        self.ranges = [(d, lo, hi) for _, d, lo, hi in infos]
        if shards is None:
            size = sum(os.path.getsize(os.path.join(p, n)) for p, *_ in infos for n in ("S_amm.csv.zst", "S_curve.csv.zst")
                       if os.path.exists(os.path.join(p, n)))
            shards = max(1, int(np.ceil(size / BYTES_PER_ROW / ROWS_PER_SHARD)))
        self.K = int(shards)
        self._pass0(infos)
        self._pass1(infos)

    # ------------------------------------------------------------------ pass 0: E of every unit
    def _pass0(self, infos):
        ev, self.unit_boosts = [], []
        for p, day, lo, hi in infos:
            e = read_events(p, EVENT_NAMES)
            keep = []
            for j in e:
                j = {k: v for k, v in j.items() if k in ("event", "slot", "block_time", "signature", "tx_idx")}
                keep.append(j)
            for j, raw in zip(keep, e):
                j["fields"] = {k: v for k, v in raw.get("fields", {}).items() if k in EVENT_FIELDS}
                j["day"] = day
            ev += keep
            self.unit_boosts.append({j["signature"] for j in e if j["event"] == "BoostBuyAndBurnEvent"})
            del e
        self.events = ev
        self._index_events()
        self.grad_pools = set(self.pool_creates["pool"].dropna())
        for df in (self.pool_creates, self.boosts, self.reprices):   # hashed as the compact Tape does
            df["signature"] = sig_hash(df["signature"]) if len(df) else df["signature"]

    # ------------------------------------------------------------------ pass 1: every unit once
    def _pass1(self, infos):
        it = Interner()
        code_shard = []
        self.n_rows, unit_lo = [], []
        canon, curve_mh, pool_mint = [], [], {}
        t_links, w_links, fails, blocks = [], [], [], []
        cf_by = Counter()
        self.template = None
        for ui, (p, day, lo, hi) in enumerate(infos):
            f_amm = os.path.join(p, "S_amm.csv.zst")
            v2 = os.path.exists(f_amm) and "top_program" in pd.read_csv(f_amm, compression="zstd", nrows=0).columns
            sw = compact_swaps(swaps_from(read_csv(p, "S_curve", CURVE_COLS), read_csv(p, "S_amm", AMM_COLS),
                                          self.unit_boosts[ui], day, v2), it)
            tt = compact_moves(read_csv(p, "T", ["slot", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner",
                                                 "to_owner", "amount"]), it)
            ww = compact_w(read_csv(p, "W", ["slot", "from", "to"]).rename(columns={"from": "from_owner",
                                                                                   "to": "to_owner"}), it)
            ff = read_csv(p, "F", ["slot", "block_time", "signature", "venue", "pool_or_curve", "err_class"])
            ff["day"] = day
            # MIG-SEAT's racers read only these F rows (migseat.mig_seat: pumpswap, the racer classes, its pool)
            ff = ff[(ff["venue"] == "pumpswap") & ff["err_class"].isin(MS.RACER_CLASSES)
                    & ff["pool_or_curve"].isin(self.grad_pools)].reset_index(drop=True)
            fails.append(compact_fails(ff, it))
            cff = read_csv(p, "CF", ["slot", "creator", "amount", "event"])
            cf_by.update(cff["creator"].dropna().tolist())
            b = read_csv(p, "B", ["slot", "block_time"])
            b["day"] = day
            blocks.append(b)
            # shard of each word (by crc32 of the mint's text; the shard count changes memory only)
            for w in it.words[len(code_shard):]:
                code_shard.append(zlib.crc32(w.encode()) % self.K if isinstance(w, str) else 0)
            cs = np.asarray(code_shard, dtype=np.int32)
            # per-unit parts of the whole-tape sets
            c = {w: it.code.get(w, -2) for w in ("amm", "curve", WSOL, "transfer")}
            is_amm = sw["venue"].to_numpy() == c["amm"]
            canon.append(np.unique(sw.loc[is_amm & sw["canonical"].to_numpy() & (sw["quote_mint"].to_numpy() == c[WSOL]),
                                          "pool"].to_numpy()))
            cm = sw[(sw["venue"].to_numpy() == c["curve"]) & sw["mayhem"].notna().to_numpy()].drop_duplicates("mint")
            curve_mh.append((lo, dict(zip(cm["mint"].tolist(), cm["mayhem"].tolist()))))
            pm = sw.loc[is_amm, ["pool", "mint"]].drop_duplicates()
            for pc, mc in zip(pm["pool"].tolist(), pm["mint"].tolist()):
                if pc < 0:
                    continue
                if pool_mint.setdefault(pc, mc) != mc or mc < 0:
                    raise StreamError(f"pool {it.words[pc]} trades more than one base mint (or none): sharding by "
                                      "mint would split it")
            tr = tt[tt["kind"].to_numpy() == c["transfer"]]
            t_links.append((tr["from_owner"].to_numpy(np.int32), tr["to_owner"].to_numpy(np.int32),
                            tr["slot"].to_numpy(np.int64)))
            w_links.append((ww["from_owner"].to_numpy(np.int32), ww["to_owner"].to_numpy(np.int32),
                            ww["slot"].to_numpy(np.int64)))
            # swaps and moves to their shards
            if self.template is None:
                self.template = (sw.iloc[:0].copy(), tt.iloc[:0].copy())
            sw["ri"] = np.arange(len(sw), dtype=np.int32)
            ks = cs[np.maximum(sw["mint"].to_numpy(), 0)]
            ks[sw["mint"].to_numpy() < 0] = 0
            for k in np.unique(ks):
                _dump(sw[ks == k], self._piece("s", ui, k))
            km = cs[np.maximum(tt["mint"].to_numpy(), 0)]
            km[tt["mint"].to_numpy() < 0] = 0
            for k in np.unique(km):
                _dump(tt[km == k], self._piece("m", ui, k))
            self.n_rows.append(len(sw))
            unit_lo.append(lo)
            self.log(f"unit {ui + 1}/{len(infos)} {day} {lo}-{hi}: {len(sw)} swaps, vocabulary {len(it.words)}")
            del sw, tt, ww, ff, cff, b
            _trim()
        # ---- whole tape
        self.lo_order = [int(i) for i in np.argsort(np.array(unit_lo), kind="stable")]
        self.offset = {}
        acc = 0
        for i in self.lo_order:
            self.offset[i] = acc
            acc += self.n_rows[i]
        self.n_swaps = acc
        if acc >= 2**31:
            raise StreamError("more than 2^31 swaps: the int32 order column of the compact Tape would overflow")
        self.vocab = Vocab(it.words)
        rank = self.vocab.rank
        self.code_shard = np.asarray(code_shard, dtype=np.int32)
        del it, code_shard
        _trim()
        V = self.vocab
        cp = np.unique(np.concatenate(canon)) if canon else np.array([], np.int32)
        self.canon_pools = set(V.words_of(rank[cp[cp >= 0]]))
        cu = {}
        for _, d in sorted(curve_mh, key=lambda x: x[0]):            # tape order: the first unit's flag wins
            for m, v in d.items():
                cu.setdefault(V.word(rank[m]) if m >= 0 else np.nan, v)
        cr = self.creates[self.creates["mayhem"].notna()].drop_duplicates("mint")
        pc = self.pool_creates[self.pool_creates["mayhem"].notna()].drop_duplicates("base_mint")
        self._mayhem_maps = (dict(zip(cr["mint"], cr["mayhem"])), cu, dict(zip(pc["base_mint"], pc["mayhem"])))
        # links in the Tape's order: T transfers (units in the given order), then W, stable-sorted by slot
        a = np.concatenate([x[0] for x in t_links] + [x[0] for x in w_links]) if t_links else np.array([], np.int32)
        b_ = np.concatenate([x[1] for x in t_links] + [x[1] for x in w_links]) if t_links else np.array([], np.int32)
        sl = np.concatenate([x[2] for x in t_links] + [x[2] for x in w_links]) if t_links else np.array([], np.int64)
        ok = (a >= 0) & (b_ >= 0) & (a != b_)
        a, b_, sl = a[ok], b_[ok], sl[ok]
        o = np.argsort(sl, kind="stable")
        a, b_, sl = rank[a[o]].astype(np.int64), rank[b_[o]].astype(np.int64), sl[o]
        del o, ok, t_links
        self.graph = LinkGraph(a, b_, sl, V)
        del a, b_, sl
        wa = np.concatenate([x[0] for x in w_links]) if w_links else np.array([], np.int32)
        wb = np.concatenate([x[1] for x in w_links]) if w_links else np.array([], np.int32)
        ws = np.concatenate([x[2] for x in w_links]) if w_links else np.array([], np.int64)
        self.w_graph = WGraph(rank[wa].astype(np.int64), rank[wb].astype(np.int64), ws, V)
        del wa, wb, ws, w_links
        f = pd.concat(fails, ignore_index=True)
        self.fails = self._decode(f, STR_COLS["fails"])[0]
        for col in ("slot", "block_time"):
            self.fails[col] = pd.to_numeric(self.fails[col], errors="coerce").astype("Int64")
        self.cf_by = dict(cf_by)
        self.cf = pd.DataFrame({"creator": list(cf_by.elements())})   # its length only (gate3_split reads cf_by)
        self.blocks = pd.concat(blocks, ignore_index=True)
        self.blocks["slot"] = pd.to_numeric(self.blocks["slot"], errors="coerce").astype(np.int64)
        self.blocks["block_time"] = pd.to_numeric(self.blocks["block_time"], errors="coerce").astype(np.int64)
        self.blocks = self.blocks.sort_values("slot").reset_index(drop=True)
        self._intervals()
        self.swaps = None
        self.moves = None
        _trim()
        self.log(f"whole tape: {self.n_swaps} swaps, vocabulary {len(V)} ({V.words.nbytes >> 20} MB), links graph "
                 f"{self.graph.nbytes() >> 20} MB, W graph {(self.w_graph.nbr.nbytes + self.w_graph.slot.nbytes) >> 20} MB, "
                 f"{self.K} shards, peak RSS so far {_maxrss_mb()} MB")

    def _piece(self, kind, ui, k):
        return os.path.join(self.dir, f"{kind}{ui:04d}_{int(k):03d}.pkl.zst")

    def _decode(self, df, cols, ranks_used=None):
        """Reading codes -> one categorical dtype (sorted words) over the given columns, as tapeio.finish_frame."""
        rank = self.vocab.rank
        used = []
        for c in cols:
            if c in df.columns:
                v = df[c].to_numpy(np.int64)
                used.append(rank[v[v >= 0]])
        if ranks_used is not None:
            used.append(ranks_used)
        u = np.unique(np.concatenate(used)) if used else np.array([], np.int64)
        dtype = pd.CategoricalDtype(categories=pd.Index(self.vocab.words_of(u), dtype=object))
        for c in cols:
            if c in df.columns:
                v = df[c].to_numpy(np.int64)
                codes = np.where(v >= 0, np.searchsorted(u, rank[np.maximum(v, 0)]), -1)
                df[c] = pd.Categorical.from_codes(codes, dtype=dtype)
        return df, u

    def load_shard(self, k, moves=True):
        parts = []
        for ui in self.lo_order:
            f = self._piece("s", ui, k)
            if os.path.exists(f):
                df = _load(f)
                df["order"] = (self.offset[ui] + df.pop("ri").to_numpy(np.int64)).astype(np.int32)
                parts.append(df)
        if parts:
            s = pd.concat(parts, ignore_index=True) if len(parts) > 1 else parts[0].reset_index(drop=True)
        else:
            s = self.template[0].copy()
            s["order"] = np.array([], dtype=np.int32)
        del parts
        mv = None
        if moves:
            mparts = [_load(self._piece("m", ui, k)) for ui in range(len(self.paths))
                      if os.path.exists(self._piece("m", ui, k))]
            mv = pd.concat(mparts, ignore_index=True) if mparts else self.template[1].copy()
            del mparts
        # one dtype over the shard's swaps and moves (the Tape's columns share one vocabulary)
        rank = self.vocab.rank
        extra = []
        if mv is not None:
            for c in STR_COLS["moves"]:
                v = mv[c].to_numpy(np.int64)
                extra.append(rank[v[v >= 0]])
        _, u = self._decode(s, STR_COLS["swaps"], np.concatenate(extra) if extra else None)
        if mv is not None:
            dtype = s["mint"].dtype
            for c in STR_COLS["moves"]:
                v = mv[c].to_numpy(np.int64)
                codes = np.where(v >= 0, np.searchsorted(u, rank[np.maximum(v, 0)]), -1)
                mv[c] = pd.Categorical.from_codes(codes, dtype=dtype)
            for col in ("slot", "tx_idx", "outer_ix", "inner_ix", "amount"):
                mv[col] = pd.to_numeric(mv[col], errors="coerce").fillna(-1).astype(np.int64)
        return ShardTape(self, s, mv), s

    def _cat_ranks(self, dtype):
        return self.vocab.lookup_many(list(dtype.categories))

    def shard_of(self, mint):
        r = self.vocab.lookup(mint) if isinstance(mint, str) else -1
        if r < 0:
            # a mint with no swap and no move has no shard of its own: shard 0 (as a missing mint)
            return zlib.crc32(mint.encode()) % self.K if isinstance(mint, str) else 0
        return zlib.crc32(mint.encode()) % self.K

    def cleanup(self):
        if self.own_dir:
            shutil.rmtree(self.dir, ignore_errors=True)
        else:
            for f in os.listdir(self.dir):
                if f.endswith(".pkl.zst"):
                    os.remove(os.path.join(self.dir, f))


# ============================================================================ the run
def _key_of_first(df, col="pool"):
    """{value: order of its first row} for the rows of df (in tape order)."""
    if not len(df):
        return {}
    f = df.drop_duplicates(col)
    return dict(zip(f[col].tolist(), f["order"].tolist()))


def _cat_frames(frames, cols, key="_k"):
    """Concatenate the shards' frames, back in the in-memory run's order (stable sort on the key)."""
    frames = [f for f in frames if len(f)]
    if not frames:
        return pd.DataFrame([], columns=cols)
    df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]
    df = df.sort_values(key, kind="mergesort").drop(columns=[key]).reset_index(drop=True)
    return df


def _sorted_records(recs):
    out = [r for _, r in sorted(recs, key=lambda x: x[0])]
    return out


class TwoSidedParts:
    """rows.two_sided_clusters over shards: per shard the flagged (cluster, mint) groups and the labels, with the
    key the in-memory run orders them by; merged by merge()."""

    RULES = ("hub_cap_50", "hub_keyed")

    def __init__(self, graph: LinkGraph):
        self.g = graph
        self.flagged = {r: [] for r in self.RULES}
        self.labels = []
        self.n_rows = 0
        self.sol_int = 0
        self.sol_exact = True
        self.sol_parts = []
        self.counts = Counter()

    def cluster_arrays(self, rule):
        return (self.g.capped, self.g.capped_size) if rule == "hub_cap_50" else (self.g.keyed, self.g.keyed_size)

    def shard(self, s, ranks_of):
        x = s[~s["excluded"] & s["owner"].notna() & s["sol_quoted"]]
        self.n_rows += len(x)
        sol = x["sol"].to_numpy(float)
        fin = sol[np.isfinite(sol)]
        if self.sol_exact and len(fin) and (np.any(fin < 0) or np.any(fin != np.floor(fin))):
            self.sol_exact = False
        if self.sol_exact:
            self.sol_int += int(fin.astype(np.int64).sum()) if len(fin) else 0
        self.sol_parts.append((x["order"].to_numpy(np.int64), sol))
        xr = ranks_of(x["owner"])
        shard_labels = []
        for ri, rule in enumerate(self.RULES):
            cl_arr, size = self.cluster_arrays(rule)
            cl = np.where(xr >= 0, cl_arr[np.maximum(xr, 0)], -1)
            multi = (cl >= 0) & (size[np.maximum(cl, 0)] >= 2)
            xx = x[multi].assign(cluster=cl[multi])
            for (c, mint), g in xx.groupby(["cluster", "mint"], sort=False, observed=True):
                if g["is_buy"].all() or (~g["is_buy"]).all():
                    continue
                bs = np.sort(g.loc[g["is_buy"], "slot"].values)
                ss = g.loc[~g["is_buy"], "slot"].values
                i = np.searchsorted(bs, ss - R.TWO_SIDED_SLOTS, side="left")
                hit = (i < len(bs)) & (bs[np.minimum(i, len(bs) - 1)] <= ss + R.TWO_SIDED_SLOTS)
                if hit.any():
                    key = int(g["order"].iloc[0])
                    self.flagged[rule].append((key, int(c), mint, float(g["sol"].sum()), g["owner"].nunique()))
                    for o in g["owner"].unique():
                        rec = (rule, mint, o, int(size[c]))
                        shard_labels.append(rec)
                        self.labels.append(((ri, key), rec))
        # row shares: rows whose (mint, owner) a label covers (labels of a mint are all on its shard)
        lab = pd.DataFrame(shard_labels, columns=["rule", "mint", "owner", "cluster_size"])
        capped = lab[lab["cluster_size"].between(R.LABEL_MIN, R.LABEL_MAX)]
        key = pd.MultiIndex.from_arrays([x["mint"], x["owner"]])

        def hits(lb):
            if not len(lb) or not len(x):
                return 0
            return int(key.isin(pd.MultiIndex.from_arrays([lb["mint"], lb["owner"]])).sum())

        for rule in self.RULES:
            self.counts[(rule, "u")] += hits(lab[lab["rule"] == rule])
            self.counts[(rule, "c")] += hits(capped[capped["rule"] == rule])
        self.counts[("either", "u")] += hits(lab)
        self.counts[("either", "c")] += hits(capped)
        return capped.reset_index(drop=True)

    def total_vol(self):
        if self.sol_exact and self.sol_int < 2**53:
            return float(self.sol_int)       # every partial sum is an exact integer: any order gives this value
        o = np.concatenate([p[0] for p in self.sol_parts]) if self.sol_parts else np.array([], np.int64)
        v = np.concatenate([p[1] for p in self.sol_parts]) if self.sol_parts else np.array([], float)
        return float(pd.Series(v[np.argsort(o, kind="stable")]).sum())

    def merge(self):
        """(capped labels, summary) as rows.two_sided_clusters returns them."""
        total_vol = self.total_vol()
        self.sol_parts = []
        summary = {}
        n_lab = Counter()
        for _, rec in self.labels:
            n_lab[(rec[0], "u")] += 1
            if R.LABEL_MIN <= rec[3] <= R.LABEL_MAX:
                n_lab[(rec[0], "c")] += 1
        for rule in self.RULES:
            _, size = self.cluster_arrays(rule)
            fl = [r[1:] for r in sorted(self.flagged[rule], key=lambda x: x[0])]
            f = pd.DataFrame(fl, columns=["cluster", "mint", "sol", "n_owners"])
            csize = pd.Series(size[f["cluster"].unique().astype(np.int64)]) if len(f) else pd.Series(dtype=float)
            summary[rule] = {
                "hubs": int(self.g.hub.sum()), "clusters_ge2": int((size >= 2).sum()),
                "two_sided_cluster_mints": int(len(f)), "two_sided_clusters": int(f["cluster"].nunique()) if len(f) else 0,
                "volume_share": (float(f["sol"].sum()) / total_vol) if total_vol else None,
                "cluster_size_quantiles": {str(q): float(csize.quantile(q)) for q in (0.5, 0.9, 0.99, 1.0)} if len(csize) else {},
                "cluster_size_counts": {str(k): int(v) for k, v in csize.value_counts().sort_index().items()} if len(csize) else {},
            }
        n = self.n_rows

        def share(rule, kind, n_labels):
            if not n:
                return None
            return float(self.counts[(rule, kind)]) / n if n_labels else 0.0

        for rule in self.RULES:
            summary[rule]["rows_labelled_share_uncapped"] = share(rule, "u", n_lab[(rule, "u")])
            summary[rule]["rows_labelled_share_capped"] = share(rule, "c", n_lab[(rule, "c")])
        summary["either_rule"] = {
            "rows_labelled_share_uncapped": share("either", "u", sum(n_lab[(r, "u")] for r in self.RULES)),
            "rows_labelled_share_capped": share("either", "c", sum(n_lab[(r, "c")] for r in self.RULES)),
            "label_cluster_size": [R.LABEL_MIN, R.LABEL_MAX]}
        all_labels = pd.DataFrame(_sorted_records(self.labels), columns=["rule", "mint", "owner", "cluster_size"])
        capped = all_labels[all_labels["cluster_size"].between(R.LABEL_MIN, R.LABEL_MAX)].reset_index(drop=True)
        return capped, summary


def _ranks_of(tape: StreamTape):
    cache = {}

    def f(series):
        dt = series.dtype
        k = id(dt)
        if k not in cache:
            cache.clear()
            cache[k] = (dt, tape._cat_ranks(dt))
        u = cache[k][1]
        codes = series.cat.codes.to_numpy()
        return np.where(codes >= 0, u[np.maximum(codes, 0)] if len(u) else -1, -1)
    return f


def _pass_a(tape: StreamTape, log):
    """W1's buys over every shard (fast class and its as-of index) and the creator roles (Gate 3)."""
    days = sorted({d for d, _, _ in tape.ranges})
    dix = {d: i for i, d in enumerate(days)}
    n = np.int64(max(len(tape.vocab), 1))
    parts, roles_pairs = [], set()
    for k in range(tape.K):
        st, s = tape.load_shard(k, moves=False)
        ranks_of = _ranks_of(tape)
        fb = R.w1_fast_buys(st, s)
        di = np.array([dix[d] for d in fb["day"].astype(object)], dtype=np.int64) if len(fb) else np.array([], np.int64)
        key = di * n + ranks_of(fb["owner"]).astype(np.int64)
        parts.append((key, fb["slot"].to_numpy(np.int64), fb["order"].to_numpy(np.int64),
                      fb["near_anchor"].to_numpy(np.int8), fb["after_big"].to_numpy(np.int8)))
        cm = s[s["creator"].notna()][["creator", "mint"]].drop_duplicates()
        roles_pairs |= set(zip(cm["creator"].astype(object), cm["mint"].astype(object)))
        log(f"pass A shard {k + 1}/{tape.K}: {len(s)} swaps")
        del st, s, fb
        _trim()
    cat = [np.concatenate([p[i] for p in parts]) for i in range(5)]
    del parts
    idx = FastIndex(days, tape.vocab, *cat)
    del cat
    log(f"pass A: fast index {idx.nbytes() >> 20} MB over {len(idx.slot)} buys, peak RSS so far {_maxrss_mb()} MB")
    roles = {}
    for r in tape.creates.itertuples(index=False):
        roles.setdefault(r.creator, set()).add(r.mint)
    for c, m in roles_pairs:
        roles.setdefault(c, set()).add(m)
    tape.roles = roles
    return idx


def compute(units, sol_usd, n_boot, minutes, shards=None, workdir=None, log=None, prep=False):
    """The in-memory run's results (run_step_a.compute_memory), shard by shard. prep=True: the preparation stages
    only (run_prep)."""
    log = log or (lambda *a: None)
    tape = StreamTape(units, workdir, shards, log)
    try:
        return _compute(tape, sol_usd, n_boot, minutes, log, prep)
    finally:
        tape.cleanup()


def _compute(tape: StreamTape, sol_usd, n_boot, minutes, log, prep):
    flows = not prep
    fast_idx = _pass_a(tape, log)
    fast = FastMap(fast_idx)
    adj = tape.graph
    cmap = ClusterGet(tape.graph)
    hourly = H8.hourly_px(minutes)
    days = sorted({d for d, _, _ in tape.ranges})
    elig = R.eligible_pools(tape)
    el_ix = {p: i for i, p in enumerate(elig["pool"])}
    gr_all = MS.graduations(tape)
    two = TwoSidedParts(tape.graph)
    counts = Counter()
    dz_recs, rb_exits, rb_pts, rb_prs, sd_recs, ag_frames, seg_frames, g3_frames = [], [], [], [], [], [], [], []
    ph_frames, grads, stale, fee0, base = [], [], Counter(), Counter(), {}
    ev_tr, plc_tr, ev_res, plc_res, ctl_recs, ms_recs, mh_parts = [], [], {}, {}, [], [], []
    for k in range(tape.K):
        tm = [("start", time.time())]
        st, s = tape.load_shard(k)
        ranks_of = _ranks_of(tape)

        def keep(m, k=k):
            return tape.shard_of(m) == k

        tm.append(('load', time.time()))
        labels = two.shard(s, ranks_of)
        s = R.prepare(st, labels)
        st.swaps = s
        counts.update({"swaps": int(len(s)), "boost_rows_excluded": int(s["boost"].sum()),
                       "first_time_buys": int(s["ftb"].sum()), "fake_demand_rows": int(s["fake"].sum())})
        amm = s[s["venue"] == "amm"]
        pool_key = _key_of_first(amm)
        # DEV-ZERO (pools of this shard: by_pool only holds them)
        tm.append(('two_sided_prepare', time.time()))
        dz_k = R.dev_zero_rows(st, s, adj, flows=flows)
        for r in dz_k:
            dz_recs.append((pool_key[r["pool"]], r))
        tm.append(('dev', time.time()))
        # REBUY-ANCHOR
        ex, pts, prs = RB.rebuy_rows(st, s, keep=keep, flows=flows, tag=lambda i: i)
        rb_exits += ex
        drop = [] if flows else ["net_rebuy_flow", "rebuy_2h"]
        rb_pts.append(pd.DataFrame(pts, columns=[c for c in RB.POINT_COLS if c not in drop] + ["_k"]))
        rb_prs.append(pd.DataFrame(prs, columns=[c for c in RB.PAIR_COLS if c not in drop] + ["_k"]))
        tm.append(('rebuy', time.time()))
        # SEAT-DRIFT
        sd_k = R.seat_drift_rows(st, s, adj, keep=keep, flows=flows)
        for r in sd_k:
            sd_recs.append((el_ix[r["pool"]], r))
        tm.append(('seat', time.time()))
        # AGE-GATE
        cols = R.AGE_COLS if flows else R.AGE_COLS[:-1]
        ag_frames.append(pd.DataFrame(R.age_gate_rows(st, s, fast, keep=keep, flows=flows, with_index=True),
                                      columns=cols + ["ai"]).rename(columns={"ai": "_k"}))
        tm.append(('age', time.time()))
        # row 6 (segments and Gate 3's pool rows; not in prep: they read the price path)
        if flows and sol_usd:
            seg = R.mcap_segments(st, s, keep=keep)
            g3 = R.gate3_split(st, s, seg, adj, return_rows=True)
            if len(g3):
                g3_frames.append(g3)
            seg_frames.append(seg.assign(_k=[el_ix[p] for p in seg["pool"]]))
        tm.append(('row6', time.time()))
        # H8
        ctx = H8.GateCtx(st, s, hourly)
        if hourly:
            rows, gk, stl, f0 = H8.h8_capacity_rows(st, s, hourly, ctx, keep=keep, tag=lambda i: i)
            cpool = _key_of_first(amm[amm["canonical"] & (amm["quote_mint"] == WSOL)])
            ph = pd.DataFrame(rows, columns=H8.PH_COLS)
            ph_frames.append(ph.assign(_k=[cpool[p] for p in ph["pool"]]))
            grads += gk
            stale.update(stl)
            fee0.update(f0)
            if flows:   # the size-free checks the strata read, on the shard that holds each pool's trades
                pts_ = [(r["pool"], r["block_time"], r["slot"]) for r in dz_k if r["dropped"] == ""]
                for r in sd_k:
                    if r["dropped"] == "":
                        t = int(r["m_time"]) + 3600
                        pts_.append((r["pool"], t, RB.last_block_slot(st, t)))
                pts_ += [(p["pool"], p["t"], p["decision_slot"]) for p in pts]
                for p_, t, ds in pts_:
                    key = (p_, int(t), int(ds))
                    if key not in ctx._base:
                        ctx._base[key] = ctx._base_check(p_, t, ds)
                    base[key] = ctx._base[key]
        tm.append(('h8', time.time()))
        # slicer
        two_sided = StreamTwoSided(tape.graph, s)
        for low_b, tr, res in ((False, ev_tr, ev_res), (True, plc_tr, plc_res)):
            t_k = []
            SL.find_events(st, s, adj, fast, ctx, low_b=low_b, fast_idx=fast_idx, two_sided=two_sided, trace=t_k)
            tr += t_k
            evk = pd.DataFrame([r for _, w, r in t_k if w is None], columns=SL.EV_COLS)
            rs = SL.measure_rows(st, s, evk, ctx, fast_idx, flows=flows) if len(evk) else []
            for (key, w, r), x in zip([t for t in t_k if t[1] is None], rs):
                res[key] = x
        tm.append(('slicer_events', time.time()))
        sw = s[(s["venue"] == "amm") & s["canonical"] & (s["quote_mint"] == WSOL) & ~s["excluded"] & s["owner"].notna()]
        swk = _key_of_first(sw)
        for r in SL.dispersed_controls(st, s, ctx, cmap, flows=flows, records=True):
            ctl_recs.append((swk[r["pool"]], r))
        tm.append(('controls', time.time()))
        # MIG-SEAT and MAYHEM-SNAP
        ms_recs += MS.mig_seat_rows(st, s, ctx, gr_all, keep=keep, flows=flows, tag=lambda i: i)
        mh_parts.append(MS.mayhem_reads(st, s, placebo=flows))
        tm.append(('mig_mayhem', time.time()))
        log(f"pass B shard {k + 1}/{tape.K}: {len(s)} swaps, peak RSS so far {_maxrss_mb()} MB; seconds "
            + " ".join(f"{b[0]}={b[1] - a[1]:.0f}" for a, b in zip(tm, tm[1:])))
        del st, s, amm, ctx, two_sided, sw, labels, dz_k, sd_k, pts, prs, ex
        gc.collect()
        _trim()
    # ------------------------------------------------------------------ merge
    labels, two_s = two.merge()
    res = {"ranges": tape.ranges, "two": two_s, "labels": labels,
           "counts": {**{k: int(counts[k]) for k in ("swaps", "boost_rows_excluded", "first_time_buys",
                                                       "fake_demand_rows")},
                      "w1_fast_owner_days": int(fast.sum()), "w1_owner_days": int(len(fast))}}
    dz = pd.DataFrame(_sorted_records(dz_recs))
    rb_exits.sort(key=lambda f: int(f["_k"].iloc[0]) if len(f) else -1)
    ex = [f.drop(columns=["_k"]) for f in rb_exits]
    exits = pd.concat(ex, ignore_index=True) if ex else pd.DataFrame(columns=RB.EXIT_COLS)
    drop = [] if flows else ["net_rebuy_flow", "rebuy_2h"]
    pts = _cat_frames(rb_pts, [c for c in RB.POINT_COLS if c not in drop])
    prs = _cat_frames(rb_prs, [c for c in RB.PAIR_COLS if c not in drop])
    sd, sd_s = R.seat_drift_finish(_sorted_records(sd_recs), flows=flows)
    ag = _cat_frames(ag_frames, R.AGE_COLS if flows else R.AGE_COLS[:-1])
    gr_recs = [r for r in sorted(grads, key=lambda r: r["_k"])]
    for r in gr_recs:
        r.pop("_k")
    ms_rows = sorted(ms_recs, key=lambda r: r["_k"])
    for r in ms_rows:
        r.pop("_k")
    reads = MS.merge_mayhem_reads(mh_parts)
    ev, drops = _events_from_trace(ev_tr)
    plc, plc_drops = _events_from_trace(plc_tr)
    ev_rows = [ev_res[k] for k, w, _ in sorted(ev_tr, key=lambda x: x[0]) if w is None]
    plc_rows = [plc_res[k] for k, w, _ in sorted(plc_tr, key=lambda x: x[0]) if w is None]
    ctl = pd.DataFrame(_sorted_records(ctl_recs), columns=SL.ctl_cols(flows))
    ph = _cat_frames(ph_frames, H8.PH_COLS) if hourly else None
    if prep:
        res.update({"dz": dz, "rb": exits, "rb_pts": pts, "rb_pairs": prs, "sd": sd, "sd_s": sd_s, "ag": ag,
                    "sl_ev": SL.measure_frame(ev, ev_rows, flows=False), "sl_drops": drops,
                    "sl_plc": SL.measure_frame(plc, plc_rows, flows=False), "sl_plc_drops": plc_drops, "sl_ctl": ctl,
                    "ms_df": pd.DataFrame(ms_rows), "graduations": gr_all})
        res["mh_df"], res["mh_s"] = MS.mayhem_snap(tape, None, hourly, reads=reads, flows=False)
        if hourly:
            res["h8_ph"], res["h8_gr"], res["h8_cap"] = H8.h8_capacity_finish(tape, hourly, ph, gr_recs, dict(stale),
                                                                             dict(fee0))
        else:
            res["h8_ph"] = res["h8_gr"] = pd.DataFrame()
            res["h8_cap"] = {"status": "needs SOL/USD 1-minute closes"}
        return res
    res["dz"], res["dz_s"] = dz, R.dev_summary(dz, days)
    res["rb"], res["rb_pts"], res["rb_pairs"] = exits, pts, prs
    res["rb_s"] = RB.summarise(tape, exits, pts, prs)
    res["sd"], res["sd_s"] = sd, sd_s
    res["ag"], res["ag_s"] = R.age_gate_finish(ag)
    if sol_usd:
        seg = _cat_frames(seg_frames, R.SEG_COLS)
        g3 = pd.concat(g3_frames, ignore_index=True) if g3_frames else pd.DataFrame()
        res["ru"], res["ru_s"] = R.round_usd(tape, None, sol_usd, adj, n_boot=min(n_boot, 1000), seg=seg, gate3_rows=g3)
    else:
        res["ru"], res["ru_s"] = R.round_usd(tape, None, sol_usd, adj, n_boot=min(n_boot, 1000))
    if hourly:
        fctx = FrozenCtx(tape, hourly, base)
        res["h8_strata"] = {"1_dev_zero": H8.dev_zero_stratum(dz, days, hourly, fctx),
                            "2_rebuy_anchor": H8.rebuy_stratum(tape, exits, pts, prs, hourly, fctx),
                            "3_seat_drift": H8.seat_drift_stratum(sd, hourly, fctx)}
        res["h8_ph"], res["h8_gr"], res["h8_cap"] = H8.h8_capacity_finish(tape, hourly, ph, gr_recs, dict(stale),
                                                                         dict(fee0))
    else:
        need = "needs SOL/USD 1-minute closes (--sol-usd Binance kline CSVs)"
        res["h8_strata"], res["h8_cap"] = {"status": need}, {"status": need}
        res["h8_ph"] = res["h8_gr"] = pd.DataFrame()
        fctx = FrozenCtx(tape, hourly, {})
    ev_f = SL.measure_frame(ev, ev_rows)
    plc_f = SL.measure_frame(plc, plc_rows)
    res["sl_ev"], res["sl_plc"], res["sl_ctl"], res["sl_s"] = SL.slicer_finish(tape, ev_f, drops, plc_f, ctl, fctx)
    res["ms_df"], res["ms_s"] = MS.mig_seat_finish(tape, gr_all, ms_rows)
    res["mh_df"], res["mh_s"] = MS.mayhem_snap(tape, None, hourly, reads=reads)
    return res


def _events_from_trace(trace):
    out, drops = [], Counter()
    for _, why, rec in sorted(trace, key=lambda x: x[0]):
        if why:
            drops[why] += 1
        else:
            out.append(rec)
    return pd.DataFrame(out, columns=SL.EV_COLS), dict(drops)


# ============================================================================ prep-only run
PREP_TABLES = (("dev_zero_candidates", "dz"), ("rebuy_exits", "rb"), ("rebuy_points_asof", "rb_pts"),
               ("rebuy_pairs_asof", "rb_pairs"), ("seat_drift_graduates", "sd"), ("age_gate_anchor_ages", "ag"),
               ("two_sided_labels", "labels"), ("h8_pool_hours", "h8_ph"), ("h8_graduates", "h8_gr"),
               ("slicer_events_asof", "sl_ev"), ("slicer_low_b_placebo_asof", "sl_plc"),
               ("slicer_controls_asof", "sl_ctl"), ("mig_seat_graduations", "ms_df"),
               ("mayhem_snap_down_steps_asof", "mh_df"))


def run_prep(units, out, minutes=None, shards=None, workdir=None, log=None):
    """The preparation stages only, over the streaming reader: loading, the two-sided labels, first-time buyers, W1
    classes, and the event, control, decision-point and graduation tables with their as-of features, plus the H8
    capacity count row (as-of checks). No flow after an event or decision point, no outcome, no bootstrap, no payer
    bar, no summary statistic and no gate. Writes prep_<table>.csv and prep_summary.json (row counts) into `out`."""
    res = compute(units, None, 0, minutes, shards=shards, workdir=workdir, log=log, prep=True)
    os.makedirs(out, exist_ok=True)
    rows = {}
    for name, key in PREP_TABLES:
        df = res[key]
        df.to_csv(os.path.join(out, f"prep_{name}.csv"), index=False)
        rows[name] = int(len(df))
    dz, sd = res["dz"], res["sd"]
    summ = {
        "units": [f"{d} {a}-{b}" for d, a, b in res["ranges"]], **res["counts"],
        "table_rows": rows,
        "two_sided_labels": res["two"],
        "dev_zero": {f"{arm}_{kind}": int(((dz["arm"] == arm) & (dz["kind"] == kind)).sum()) if len(dz) else 0
                     for arm, _, _ in R.DEV_ARMS for kind in ("event", "control")}
        | {"dropped": dz["dropped"].value_counts().to_dict() if len(dz) else {}},
        "seat_drift": res["sd_s"],
        "slicer": {"events": int(len(res["sl_ev"])), "drops": res["sl_drops"],
                   "placebo_low_b_events": int(len(res["sl_plc"])), "placebo_drops": res["sl_plc_drops"],
                   "dispersed_controls": int(len(res["sl_ctl"]))},
        "mig_seat": {"graduations": int(len(res["graduations"])),
                     "by_speed": dict(Counter(res["graduations"]["speed"])) if len(res["graduations"]) else {},
                     "dropped": res["ms_df"]["dropped"].value_counts().to_dict() if len(res["ms_df"]) else {}},
        "mayhem_snap": res["mh_s"],
        "h8_capacity": res["h8_cap"],
    }
    with open(os.path.join(out, "prep_summary.json"), "w") as fh:
        json.dump(summ, fh, indent=1, default=str)
    return summ
