"""Owner links from W (SOL transfers) and T (token transfers), as of a slot (amendment 1 group 1; amendment 2's
creator cluster; W1 §3 traders for amendment 2 gate c2).

Each undirected pair keeps the slot of its first link. A node's degree as of slot s counts its distinct neighbours
linked at or before s, so a later link never changes an earlier answer."""
from typing import Iterable, Optional, Set

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from . import params as P


_BAND_HALF_EDGES = 1_000_000
_CHUNK = 4_000_000


def _reference() -> bool:
    from . import load
    return load.REFERENCE


class LinkGraph:
    def __init__(self, src: np.ndarray, dst: np.ndarray, slot: np.ndarray, n_nodes: int, lean: Optional[bool] = None):
        """`lean` (default: on unless the reference path is chosen, load.REFERENCE) builds the same arrays one band of
        node codes at a time, so the build holds a band's half-edges instead of all of them at once, and keeps them as
        int32 when every code and slot fits."""
        if lean is None:
            lean = not _reference()
        if not lean:
            self._build_reference(src, dst, slot, n_nodes)
            return
        src, dst, slot = np.asarray(src), np.asarray(dst), np.asarray(slot)
        m = (src >= 0) & (dst >= 0) & (src != dst)
        if not m.all():
            src, dst, slot = src[m], dst[m], slot[m]
        del m
        n = max(int(n_nodes), (int(max(src.max(), dst.max())) + 1) if len(src) else 0)
        self.n = n
        i32 = np.iinfo(np.int32)
        small = n <= i32.max and (not len(slot) or (int(slot.min()) >= i32.min and int(slot.max()) <= i32.max))
        dt = np.int32 if small else np.int64
        parts_u, parts_v, parts_s = [], [], []
        nb = max(1, -(-2 * len(src) // _BAND_HALF_EDGES))
        bounds = np.linspace(0, n, nb + 1).astype(np.int64) if n else np.zeros(2, dtype=np.int64)
        for lo, hi in zip(bounds[:-1], bounds[1:]):
            fs = np.flatnonzero((src >= lo) & (src < hi))
            rd = np.flatnonzero((dst >= lo) & (dst < hi))
            if not len(fs) and not len(rd):
                continue
            u = np.concatenate([src[fs], dst[rd]]).astype(np.int64)
            v = np.concatenate([dst[fs], src[rd]]).astype(np.int64)
            s = np.concatenate([slot[fs], slot[rd]]).astype(np.int64)
            del fs, rd
            key = u * n + v
            del u, v
            order = np.lexsort((s, key))
            key, s = key[order], s[order]
            first = np.concatenate([[True], key[1:] != key[:-1]])
            key, s = key[first], s[first]
            u, v = key // n, key % n
            del key
            order = np.lexsort((s, u))          # by node, then by first-link slot
            parts_u.append(u[order].astype(dt))
            parts_v.append(v[order].astype(dt))
            parts_s.append(s[order].astype(dt))
            del u, v, s, order, first
        self.u = np.concatenate(parts_u) if parts_u else np.empty(0, dtype=dt)
        del parts_u
        self.col = np.concatenate(parts_v) if parts_v else np.empty(0, dtype=dt)
        del parts_v
        self.slot = np.concatenate(parts_s) if parts_s else np.empty(0, dtype=dt)
        del parts_s
        self.indptr = np.zeros(n + 1, dtype=np.int64)
        if len(self.u):
            self.indptr[1:] = np.bincount(self.u, minlength=n)[:n]
        self.indptr = np.cumsum(self.indptr)

    def _build_reference(self, src, dst, slot, n_nodes):
        """The original build (all half-edges sorted at once, int64 arrays)."""
        m = (src >= 0) & (dst >= 0) & (src != dst)
        src, dst, slot = src[m], dst[m], slot[m]
        u = np.concatenate([src, dst]).astype(np.int64)
        v = np.concatenate([dst, src]).astype(np.int64)
        s = np.concatenate([slot, slot]).astype(np.int64)
        n = max(int(n_nodes), int(u.max()) + 1 if len(u) else 0)
        self.n = n
        if len(u):
            key = u * n + v
            order = np.lexsort((s, key))
            key, s = key[order], s[order]
            first = np.concatenate([[True], key[1:] != key[:-1]])
            key, s = key[first], s[first]
            u, v = key // n, key % n
            order = np.lexsort((s, u))          # by node, then by first-link slot
            u, v, s = u[order], v[order], s[order]
        self.col, self.slot = v, s
        self.indptr = np.zeros(n + 1, dtype=np.int64)
        if len(u):
            np.add.at(self.indptr, u + 1, 1)
        self.indptr = np.cumsum(self.indptr)
        self.u = u

    def neighbours(self, x: int, cutoff: int) -> np.ndarray:
        if x < 0 or x >= self.n:
            return np.empty(0, dtype=np.int64)
        a, b = self.indptr[x], self.indptr[x + 1]
        k = np.searchsorted(self.slot[a:b], cutoff, "right")
        return self.col[a:a + k]

    def degree(self, x: int, cutoff: int) -> int:
        if x < 0 or x >= self.n:
            return 0
        a, b = self.indptr[x], self.indptr[x + 1]
        return int(np.searchsorted(self.slot[a:b], cutoff, "right"))

    def cluster(self, seeds: Iterable[int], cutoff: int, hub: int = P.HC_HUB_DEGREE) -> Set[int]:
        """Union-find closure of the seeds over links at or before `cutoff`, never joining through an address linked
        to more than `hub` owners (amendment 1 group 1). A hub seed stays a member but joins nothing; a hub reached
        from the seeds is not a member (OQ-11)."""
        seeds = [s for s in set(seeds) if s is not None and s >= 0]
        members = set(seeds)
        stack = [s for s in seeds if self.degree(s, cutoff) <= hub]
        while stack:
            x = stack.pop()
            for y in self.neighbours(x, cutoff):
                y = int(y)
                if y in members:
                    continue
                if self.degree(y, cutoff) > hub:
                    continue
                members.add(y)
                stack.append(y)
        return members

    def components(self, cutoff: int, hub: int = P.HC_HUB_DEGREE, lean: Optional[bool] = None) -> np.ndarray:
        """W1 §3 traders as of `cutoff`: connected components over links at or before it, hubs never joined.
        Returns a label per node (a hub is its own component). Labels only name components: callers compare them for
        equality and group by them. Lean (default unless load.REFERENCE): the same components by union-find with
        pointer jumping over one half-edge per pair, labelled by their smallest node; the reference labels them
        0, 1, ... through scipy (which holds float64 and transposed copies of the whole graph)."""
        if lean is None:
            lean = not _reference()
        if not lean:
            return self._components_reference(cutoff, hub)
        if self.n == 0:
            return np.zeros(0, dtype=np.int64)
        L = len(self.u)
        deg = np.zeros(self.n, dtype=np.int64)
        for c0 in range(0, L, _CHUNK):
            c1 = min(c0 + _CHUNK, L)
            deg += np.bincount(self.u[c0:c1][self.slot[c0:c1] <= cutoff], minlength=self.n)[:self.n]
        deg = deg.astype(np.int32) if self.n and deg.max() <= np.iinfo(np.int32).max else deg
        parent = np.arange(self.n, dtype=np.int32 if self.n <= np.iinfo(np.int32).max else np.int64)
        # union-find one chunk of edges at a time: a chunk is done when each of its edges joins one tree; trees only
        # merge later, so every edge stays inside one tree. Each root hooks under the smaller root, so a component's
        # root is its smallest node.
        for c0 in range(0, L, _CHUNK):
            c1 = min(c0 + _CHUNK, L)
            u, v = self.u[c0:c1], self.col[c0:c1]
            # each pair has both half-edges with the same first-link slot: one (u < v) is enough
            ok = (self.slot[c0:c1] <= cutoff) & (u < v) & (deg[u] <= hub) & (deg[v] <= hub)
            a, b = u[ok], v[ok]
            del ok
            while len(a):
                pa, pb = parent[a], parent[b]
                m = pa != pb
                if not m.any():
                    break
                a, b, pa, pb = a[m], b[m], pa[m], pb[m]
                np.minimum.at(parent, np.maximum(pa, pb), np.minimum(pa, pb))
                del pa, pb, m
                while True:
                    pp = parent[parent]
                    if np.array_equal(pp, parent):
                        break
                    parent = pp
        return parent

    def _components_reference(self, cutoff: int, hub: int) -> np.ndarray:
        if self.n == 0:
            return np.zeros(0, dtype=np.int64)
        keep = self.slot <= cutoff
        deg = np.zeros(self.n, dtype=np.int64)
        np.add.at(deg, self.u[keep], 1)
        ok = keep & (deg[self.u] <= hub) & (deg[self.col] <= hub)
        g = csr_matrix((np.ones(int(ok.sum()), dtype=np.int8), (self.u[ok], self.col[ok])), shape=(self.n, self.n))
        _, labels = connected_components(g, directed=False)
        return labels
