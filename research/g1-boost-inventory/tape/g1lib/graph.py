"""Owner links from W (SOL transfers) and T (token transfers), as of a slot (amendment 1 group 1; amendment 2's
creator cluster; W1 §3 traders for amendment 2 gate c2).

Each undirected pair keeps the slot of its first link. A node's degree as of slot s counts its distinct neighbours
linked at or before s, so a later link never changes an earlier answer."""
from typing import Iterable, Set

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from . import params as P


def _narrow(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x)
    if len(x) == 0 or (x.min() >= np.iinfo(np.int32).min and x.max() <= np.iinfo(np.int32).max):
        return x.astype(np.int32)
    return x


class LinkGraph:
    def __init__(self, src: np.ndarray, dst: np.ndarray, slot: np.ndarray, n_nodes: int):
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
        self.indptr = np.zeros(n + 1, dtype=np.int64)
        if len(u):
            np.add.at(self.indptr, u + 1, 1)
        self.indptr = np.cumsum(self.indptr)
        # held as int32 when every node code and slot fits (memory only: the same values, compared and indexed alike)
        self.col, self.slot, self.u = _narrow(v), _narrow(s), _narrow(u)

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

    def components(self, cutoff: int, hub: int = P.HC_HUB_DEGREE) -> np.ndarray:
        """W1 §3 traders as of `cutoff`: connected components over links at or before it, hubs never joined.
        Returns a label per node (a hub is its own component)."""
        if self.n == 0:
            return np.zeros(0, dtype=np.int64)
        keep = self.slot <= cutoff
        deg = np.zeros(self.n, dtype=np.int64)
        np.add.at(deg, self.u[keep], 1)
        ok = keep & (deg[self.u] <= hub) & (deg[self.col] <= hub)
        g = csr_matrix((np.ones(int(ok.sum()), dtype=np.int8), (self.u[ok], self.col[ok])), shape=(self.n, self.n))
        _, labels = connected_components(g, directed=False)
        return labels
