"""Low-memory holding of tape rows (how data is held, never what is computed).

`Store` keeps string tables compact: a column whose every value is an integer written canonically (str(int(x)) == x)
or empty is held as int64 plus an empty mask, and any other column as int32 codes into one shared string table.
Chunks are zstd-compressed and decoded back to exactly the original strings, so the code that reads them sees the
same values as when it read the tape directly. `CompactHabits` and `round_trips_codes` hold the D60 habits by owner
code. Tests: tests/test_lowmem.py (old reader vs new reader, byte for byte).
"""
import pickle

import numpy as np
import pandas as pd
import zstandard

_C = zstandard.ZstdCompressor(level=3)
_D = zstandard.ZstdDecompressor()


class Strings:
    """One table of distinct strings: code(x) and back."""

    def __init__(self):
        self.code_of = {}
        self.values = []
        self._arr = None

    def codes(self, vals: np.ndarray) -> np.ndarray:
        local, uniq = pd.factorize(vals, sort=False)
        co, vs = self.code_of, self.values
        g = np.empty(len(uniq), dtype=np.int32)
        for i, x in enumerate(uniq):
            c = co.get(x)
            if c is None:
                c = co[x] = len(vs)
                vs.append(x)
            g[i] = c
        if len(vs) >= 2**31 - 1:
            raise OverflowError("too many distinct strings")
        self._arr = None
        return g[local] if len(local) else np.empty(0, dtype=np.int32)

    def lookup(self, codes: np.ndarray) -> np.ndarray:
        if self._arr is None or len(self._arr) != len(self.values):
            self._arr = np.array(self.values, dtype=object)
        return self._arr[codes]


def _encode_col(vals: np.ndarray, strings: Strings):
    empty = vals == ""
    nz = vals[~empty]
    try:
        iv = nz.astype(np.int64)
        if not (iv.astype(str).astype(object) == nz).all():
            raise ValueError("not canonical")
    except (ValueError, OverflowError, TypeError):
        return ("c", strings.codes(vals))
    full = np.zeros(len(vals), dtype=np.int64)
    full[~empty] = iv
    return ("i", full, np.packbits(empty), len(vals))


def _decode_col(enc, strings: Strings) -> np.ndarray:
    if enc[0] == "c":
        return strings.lookup(enc[1])
    _, full, packed, n = enc
    empty = np.unpackbits(packed, count=n).astype(bool)
    out = full.astype(str).astype(object)
    out[empty] = ""
    return out


class Store:
    """Compressed string rows per (table, key), in the order they were put."""

    def __init__(self, strings: Strings = None):
        self.strings = strings or Strings()
        self.chunks = {}
        self.rows = {}

    def put(self, table: str, key, df: pd.DataFrame):
        if not len(df):
            return
        cols = list(df.columns)
        enc = [_encode_col(df[c].to_numpy(dtype=object), self.strings) for c in cols]
        blob = _C.compress(pickle.dumps((cols, enc), protocol=pickle.HIGHEST_PROTOCOL))
        self.chunks.setdefault((table, key), []).append(blob)
        self.rows[(table, key)] = self.rows.get((table, key), 0) + len(df)

    def frames(self, table: str, key, drop: bool = True):
        """The chunks of (table, key) as string frames, in put order; `drop` frees each chunk once read."""
        blobs = self.chunks.pop((table, key), []) if drop else list(self.chunks.get((table, key), []))
        while blobs:
            cols, enc = pickle.loads(_D.decompress(blobs.pop(0)))
            yield pd.DataFrame({c: _decode_col(e, self.strings) for c, e in zip(cols, enc)}, columns=cols)

    def nbytes(self) -> int:
        return sum(len(b) for v in self.chunks.values() for b in v)


# ---------------------------------------------------------------- D60 habits by code (habits.round_trips / Habits)

def round_trips_codes(owner, mint, slot, tx, ev, time, is_open):
    """habits.round_trips on codes: pairs each close with the open just before it in the same (owner, mint), rows
    ordered by (owner, mint, slot, tx, ev) with ties in input order. Returns (owner code, close_slot, hold_s)."""
    n = len(owner)
    if n == 0:
        z = np.empty(0, dtype=np.int64)
        return z.astype(np.int32), z, z
    o = np.lexsort((np.arange(n), ev, tx, slot, mint, owner))
    ow, mi, k, sl, tm = owner[o], mint[o], is_open[o], slot[o], time[o]
    same = np.zeros(n, dtype=bool)
    same[1:] = (ow[1:] == ow[:-1]) & (mi[1:] == mi[:-1])
    prev_open = np.zeros(n, dtype=bool)
    prev_open[1:] = k[:-1]
    m = ~k & same & prev_open
    prev_t = np.zeros(n, dtype=np.int64)
    prev_t[1:] = tm[:-1]
    return ow[m], sl[m], (tm[m] - prev_t[m]).astype(np.int64)


class CompactHabits:
    """habits.Habits with the round trips held by owner code: per owner, the hold times in close-slot order."""

    def __init__(self, owner_codes, close_slot, hold_s, code_of: dict):
        o = np.lexsort((np.arange(len(owner_codes)), close_slot, owner_codes))
        self.oc, self.cs, self.hs = owner_codes[o], close_slot[o].astype(np.int64), hold_s[o].astype(float)
        u, first, cnt = np.unique(self.oc, return_index=True, return_counts=True)
        self.span = {int(c): (int(a), int(a + b)) for c, a, b in zip(u, first, cnt)}
        self.code_of = code_of
        self._cache = {}

    def median_before(self, owner: str, slot: int):
        c = self.code_of.get(owner)
        sp = self.span.get(c) if c is not None else None
        if sp is None:
            return None
        a, b = sp
        k = int(np.searchsorted(self.cs[a:b], slot, "right"))
        if k == 0:
            return None
        key = (owner, k)
        v = self._cache.get(key)
        if v is None:
            v = self._cache[key] = float(np.median(self.hs[a:a + k]))
        return v


