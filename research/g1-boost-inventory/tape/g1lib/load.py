"""Reads shared-tape units (research/shared-tape/README.md) into compact tables.

A unit is a directory CACHE/<day>/<from>-<to>/research/ holding the research tables and stats.json. Addresses are
interned to integer codes (one `Interner` per run) so a day of W and S_amm fits in memory. Nothing here computes a
feature or an outcome; it only loads and orders rows.

Order inside a slot follows the tape: (slot, tx_idx, outer_ix, inner_ix, ev_idx).
"""
import glob
import io
import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from . import params as P

E_KINDS = ("CreateEvent", "CompleteEvent", "CompletePumpAmmMigrationEvent", "CreatePoolEvent",
           "InitBoostEvent", "BoostBuyAndBurnEvent", "PostCompleteBuyEvent")

CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "mint", "is_buy", "sol_amount",
              "token_amount", "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves",
              "real_token_reserves", "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee",
              "mayhem_mode", "cashback_fee_basis_points", "quote_mint", "quote_amount", "virtual_quote_reserves",
              "real_quote_reserves", "user", "user_token_owner", "owner_token_post", "creator", "signer"]
CURVE_STR = {"mint", "user", "user_token_owner", "creator", "signer"}

AMM_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "pool", "base_mint", "quote_mint",
            "side", "base_amount", "quote_amount", "quote_amount_lp_adjusted", "pool_base_token_reserves",
            "pool_quote_token_reserves", "virtual_quote_reserves", "lp_fee_basis_points",
            "protocol_fee_basis_points", "coin_creator_fee_basis_points", "lp_fee", "protocol_fee",
            "coin_creator_fee", "min_base_amount_out", "ix_name", "base_supply", "chain_pool_base",
            "chain_pool_quote", "user", "user_token_owner", "canonical", "signer"]
AMM_STR = {"pool", "base_mint", "user", "user_token_owner", "signer"}

T_COLS = ["slot", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner", "to_owner", "amount"]
W_COLS = ["slot", "from", "to"]
F_COLS = ["slot", "tx_idx", "pool_or_curve", "mint", "ix_name", "err_class", "amount_arg", "limit_arg"]
INT_SENTINEL = -1


class Interner:
    """Maps address strings to stable integer codes for one run (-1 for empty)."""

    def __init__(self):
        self.idx: Dict[str, int] = {}
        self.names: List[str] = []

    def code(self, s) -> int:
        if s is None or (isinstance(s, float) and np.isnan(s)) or s == "":
            return INT_SENTINEL
        c = self.idx.get(s)
        if c is None:
            c = len(self.names)
            self.idx[s] = c
            self.names.append(s)
        return c

    def codes(self, values) -> np.ndarray:
        local, uniques = pd.factorize(pd.Series(values, dtype=object), use_na_sentinel=True)
        g = np.fromiter((self.code(u) for u in uniques), dtype=np.int64, count=len(uniques))
        out = np.full(len(local), INT_SENTINEL, dtype=np.int64)
        m = local >= 0
        out[m] = g[local[m]]
        return out

    def codes_cat(self, values) -> np.ndarray:
        """`codes` for a categorical column: the same codes in the same order of first appearance, without building a
        Python string per row. A non-categorical column goes through `codes`."""
        cat = values.array if isinstance(values, pd.Series) else values
        if not isinstance(cat, pd.Categorical):
            return self.codes(np.asarray(values, dtype=object))
        k = np.asarray(cat.codes).astype(np.int64)
        cats = cat.categories
        ok = k >= 0
        first = pd.unique(k[ok])                      # category positions in order of first appearance
        m = np.full(len(cats), INT_SENTINEL, dtype=np.int64)
        if len(first):
            m[first] = np.fromiter((self.code(cats[i]) for i in first), dtype=np.int64, count=len(first))
        out = np.full(len(k), INT_SENTINEL, dtype=np.int64)
        out[ok] = m[k[ok]]
        return out

    def get(self, s) -> int:
        return self.idx.get(s, INT_SENTINEL)

    def name(self, c: int) -> Optional[str]:
        return self.names[c] if c >= 0 else None


@dataclass
class Unit:
    path: str
    day: str
    from_slot: int
    to_slot: int
    schema: str

    @staticmethod
    def open(path: str) -> "Unit":
        path = path.rstrip("/")
        if os.path.basename(path) != "research" and os.path.isdir(os.path.join(path, "research")):
            path = os.path.join(path, "research")
        with open(os.path.join(path, "stats.json")) as f:
            st = json.load(f)
        hdr = _header(os.path.join(path, "S_curve.csv.zst"))
        return Unit(path, st["day"], int(st["from_slot"]), int(st["to_slot"]), "v2" if "top_program" in hdr else "v1")

    def table(self, name: str) -> str:
        return os.path.join(self.path, name)


def _header(path: str) -> List[str]:
    import zstandard
    with open(path, "rb") as fh:
        r = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh))
        return r.readline().strip().split(",")


def find_units(roots: List[str], days: Optional[List[str]] = None, plan="default", allow_subset: bool = False) -> List[Unit]:
    """Unit directories from explicit unit paths or cache roots (CACHE, CACHE/<day>, CACHE/<day>/<unit>).
    By default the units must equal the frozen Step A plan's rows for each day read (guard.check_units); a subset
    is accepted only with allow_subset (development). `plan=None` skips the plan (synthetic tests only)."""
    out = []
    for r in roots:
        cands = [r] if os.path.exists(os.path.join(r, "stats.json")) or os.path.exists(os.path.join(r, "research", "stats.json")) \
            else sorted(glob.glob(os.path.join(r, "*", "research"))) + sorted(glob.glob(os.path.join(r, "*", "*", "research")))
        for c in cands:
            u = Unit.open(c)
            if days is None or u.day in days:
                out.append(u)
    uniq = {(u.from_slot, u.to_slot): u for u in out}
    units = sorted(uniq.values(), key=lambda u: u.from_slot)
    for a, b in zip(units, units[1:]):
        if b.from_slot <= a.to_slot:
            raise ValueError(f"overlapping units {a.path} and {b.path}")
    if plan is not None:
        from . import guard
        guard.check_units(units, guard.load_plan() if plan == "default" else plan, allow_subset=allow_subset)
    return units


def segments(units: List[Unit]) -> List[tuple]:
    """Maximal runs of contiguous slots covered by the units: [(first, last), ...]."""
    segs = []
    for u in units:
        if segs and u.from_slot == segs[-1][1] + 1:
            segs[-1] = (segs[-1][0], u.to_slot)
        else:
            segs.append((u.from_slot, u.to_slot))
    return segs


def _read_csv(path: str, cols: List[str], str_cols, cat_cols=()) -> pd.DataFrame:
    """`cat_cols` (compact reader only): address columns read as categoricals; each is turned into interner codes by
    `Interner.codes_cat`, never held as one Python string per row."""
    hdr = _header(path)
    use = [c for c in cols if c in hdr]
    dtypes = {c: str for c in use if c in str_cols or c in ("quote_mint", "side", "ix_name", "kind", "err_class",
                                                               "pool_or_curve", "from", "to", "from_owner", "to_owner")}
    for c in cat_cols:
        if c in use:
            dtypes[c] = "category"
    df = pd.read_csv(path, compression="zstd", usecols=use, dtype=dtypes, keep_default_na=True)
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    return df[cols]


def _num(df: pd.DataFrame, cols, fill=INT_SENTINEL):
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(fill).astype(np.int64)


def read_events(unit: Unit) -> pd.DataFrame:
    import zstandard
    rows = []
    with open(unit.table("E.jsonl.zst"), "rb") as fh:
        r = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh))
        for line in r:
            d = json.loads(line)
            if d.get("event") not in E_KINDS:
                continue
            row = {"event": d["event"], "slot": int(d["slot"]), "block_time": int(d["block_time"]),
                   "tx_idx": int(d["tx_idx"]), "ev_idx": int(d.get("ev_idx", 0)), "outer_ix": int(d.get("outer_ix", -1)),
                   "signer": d.get("signer")}
            row.update(d.get("fields", {}))
            rows.append(row)
    return pd.DataFrame(rows)


@dataclass
class Tape:
    units: List[Unit]
    segs: List[tuple]
    names: Interner
    blocks: pd.DataFrame                 # slot, block_time (produced slots only)
    events: Dict[str, pd.DataFrame]      # by kind
    curve: pd.DataFrame                  # S_curve, sorted by (mint, slot, tx_idx, ev_idx)
    pool_rows: pd.DataFrame              # S_amm rows on canonical migration pools, sorted by (pool, order)
    buys: pd.DataFrame                   # compact buys on every venue: slot, tx_idx, owner, mint, sol
    T: pd.DataFrame                      # token movements (codes)
    W: pd.DataFrame                      # SOL transfers (codes)
    F_boost: pd.DataFrame                # failed boost_buy_and_burn transactions
    day_of_unit: List[tuple] = field(default_factory=list)
    _curve_off: Dict[int, tuple] = field(default_factory=dict)
    _pool_off: Dict[int, tuple] = field(default_factory=dict)

    # ---- indexes
    def build_indexes(self):
        self._curve_off = _offsets(self.curve["mint"].to_numpy())
        self._pool_off = _offsets(self.pool_rows["pool"].to_numpy())
        self._bslots = self.blocks["slot"].to_numpy()
        self._btimes = self.blocks["block_time"].to_numpy()
        self.day_of_unit = [(u.from_slot, u.to_slot, u.day) for u in self.units]

    def curve_of(self, mint: int) -> pd.DataFrame:
        a, b = self._curve_off.get(mint, (0, 0))
        return self.curve.iloc[a:b]

    def pool_of(self, pool: int) -> pd.DataFrame:
        a, b = self._pool_off.get(pool, (0, 0))
        return self.pool_rows.iloc[a:b]

    def day_of(self, slot: int) -> Optional[str]:
        for a, b, d in self.day_of_unit:
            if a <= slot <= b:
                return d
        return None

    def segment_of(self, slot: int) -> Optional[tuple]:
        for s in self.segs:
            if s[0] <= slot <= s[1]:
                return s
        return None

    def first_produced_at_or_after(self, slot: int) -> Optional[int]:
        i = np.searchsorted(self._bslots, slot, "left")
        return int(self._bslots[i]) if i < len(self._bslots) else None

    def last_produced_at_or_before(self, slot: int) -> Optional[int]:
        i = np.searchsorted(self._bslots, slot, "right") - 1
        return int(self._bslots[i]) if i >= 0 else None

    def time_of(self, slot: int) -> Optional[int]:
        i = np.searchsorted(self._bslots, slot, "left")
        if i < len(self._bslots) and self._bslots[i] == slot:
            return int(self._btimes[i])
        return None

    def first_slot_at_time(self, t: int) -> Optional[int]:
        """First produced slot whose block time is at least t (block times are non-decreasing)."""
        i = np.searchsorted(self._btimes, t, "left")
        return int(self._bslots[i]) if i < len(self._bslots) else None


def _offsets(keys: np.ndarray) -> Dict[int, tuple]:
    if len(keys) == 0:
        return {}
    change = np.flatnonzero(np.diff(keys)) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [len(keys)]])
    return {int(keys[s]): (int(s), int(e)) for s, e in zip(starts, ends)}


def load(units: List[Unit], links: bool = True, log=print, reader: str = "compact", pool: bool = True) -> Tape:
    """Loads every table the G1 stages read. `links=False` skips W (amendment features then cannot be computed).
    reader="compact" (default) holds less memory and gives a Tape equal to reader="reference" (the original reader,
    kept for the equality tests in tests/test_reader.py): same tables, columns, dtypes, values, row order and codes.
    `pool=False` (compact reader, for `decide`, which never reads a PumpSwap pool row) leaves `pool_rows` empty; every
    other table and every code are unchanged, because S_amm is still read for the buys and the interner."""
    if reader == "compact":
        return _load_compact(units, links=links, log=log, pool=pool)
    if reader != "reference":
        raise ValueError(f"unknown reader {reader!r}")
    return _load_reference(units, links=links, log=log)


def _load_reference(units: List[Unit], links: bool = True, log=print) -> Tape:
    """The original reader (every string column as Python strings, whole tables concatenated and sorted at the end)."""
    names = Interner()
    B, E, C, Tl, Wl, Fl = [], [], [], [], [], []
    for u in units:
        b = pd.read_csv(u.table("B.csv.zst"), compression="zstd", usecols=["slot", "block_time"])
        B.append(b)
        E.append(read_events(u))
    blocks = pd.concat(B).drop_duplicates("slot").sort_values("slot").reset_index(drop=True)
    ev = pd.concat(E, ignore_index=True) if E else pd.DataFrame(columns=["event"])
    events = {k: ev[ev["event"] == k].dropna(axis=1, how="all").reset_index(drop=True) for k in E_KINDS}
    for k in events:
        if "slot" not in events[k].columns:
            events[k] = pd.DataFrame(columns=["event", "slot", "block_time", "tx_idx", "ev_idx", "mint", "pool"])
    mig = events["CompletePumpAmmMigrationEvent"]
    pools = {}
    for p, s in zip(mig.get("pool", []), mig.get("slot", [])):
        pools[p] = min(pools.get(p, s), s)
    pool_codes = {names.code(p): s for p, s in pools.items()}

    P_rows, Buys = [], []
    for u in units:
        log(f"  reading {u.day} {u.from_slot}-{u.to_slot} ({u.schema})")
        c = _read_csv(u.table("S_curve.csv.zst"), CURVE_COLS, CURVE_STR)
        _num(c, ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "is_buy", "sol_amount", "token_amount",
                 "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves", "real_token_reserves",
                 "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee", "quote_amount",
                 "virtual_quote_reserves", "real_quote_reserves", "owner_token_post"])
        for col in ("mayhem_mode", "cashback_fee_basis_points"):   # keep NaN: an unreadable flag stays unreadable
            c[col] = pd.to_numeric(c[col], errors="coerce")
        owner = c["user_token_owner"].where(c["user_token_owner"].notna() & (c["user_token_owner"] != ""), c["user"])
        c["owner"] = names.codes(owner.to_numpy())
        c["mint"] = names.codes(c["mint"].to_numpy())
        c["creator"] = names.codes(c["creator"].to_numpy())
        auth = names.code(P.BUYBACK_AUTHORITY)
        c["is_buyback"] = (names.codes(c["signer"].to_numpy()) == auth) | (names.codes(c["user"].to_numpy()) == auth)
        c = c.drop(columns=["user", "user_token_owner", "signer"])
        C.append(c)
        cb = c[c["is_buy"] == 1]
        Buys.append(pd.DataFrame({"slot": cb["slot"].to_numpy(), "tx_idx": cb["tx_idx"].to_numpy(),
                                  "owner": cb["owner"].to_numpy(), "mint": cb["mint"].to_numpy(),
                                  "sol": cb["sol_amount"].to_numpy(), "venue": np.zeros(len(cb), np.int8)}))

        a = _read_csv(u.table("S_amm.csv.zst"), AMM_COLS, AMM_STR)
        _num(a, ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "base_amount", "quote_amount",
                 "quote_amount_lp_adjusted", "pool_base_token_reserves", "pool_quote_token_reserves",
                 "virtual_quote_reserves", "lp_fee_basis_points", "protocol_fee_basis_points",
                 "coin_creator_fee_basis_points", "lp_fee", "protocol_fee", "coin_creator_fee", "min_base_amount_out",
                 "base_supply", "chain_pool_base", "chain_pool_quote", "canonical"])
        owner = a["user_token_owner"].where(a["user_token_owner"].notna() & (a["user_token_owner"] != ""), a["user"])
        a["owner"] = names.codes(owner.to_numpy())
        a["pool"] = names.codes(a["pool"].to_numpy())
        a["base_mint"] = names.codes(a["base_mint"].to_numpy())
        a["signer"] = names.codes(a["signer"].to_numpy())
        a["user_c"] = names.codes(a["user"].to_numpy())
        a = a.drop(columns=["user", "user_token_owner"])
        # compact buys of the coin (base side unless the pool's base is WSOL)
        wsol = names.code(P.WSOL)
        coin_is_base = a["base_mint"] != wsol
        is_buy = np.where(coin_is_base, a["side"] == "buy", a["side"] == "sell")
        ab = a[is_buy & coin_is_base]
        Buys.append(pd.DataFrame({"slot": ab["slot"].to_numpy(), "tx_idx": ab["tx_idx"].to_numpy(),
                                  "owner": ab["owner"].to_numpy(), "mint": ab["base_mint"].to_numpy(),
                                  "sol": ab["quote_amount_lp_adjusted"].to_numpy(), "venue": np.ones(len(ab), np.int8)}))
        if pool_codes:
            mslot = a["pool"].map(pool_codes)
            keep = mslot.notna() & (a["slot"] <= mslot.fillna(0) + P.BOOST_COMPLETE_HORIZON_SLOTS + 1_000)
            P_rows.append(a[keep])

        t = _read_csv(u.table("T.csv.zst"), T_COLS, set())
        _num(t, ["slot", "tx_idx", "outer_ix", "inner_ix", "amount"])
        for col in ("mint", "from_owner", "to_owner"):
            t[col] = names.codes(t[col].to_numpy())
        Tl.append(t)
        if links:
            w = _read_csv(u.table("W.csv.zst"), W_COLS, set())
            Wl.append(pd.DataFrame({"slot": w["slot"].astype(np.int64).to_numpy(), "src": names.codes(w["from"].to_numpy()),
                                    "dst": names.codes(w["to"].to_numpy())}))
        f = _read_csv(u.table("F.csv.zst"), F_COLS, set())
        f = f[f["ix_name"] == "boost_buy_and_burn"].copy()
        _num(f, ["slot", "tx_idx", "amount_arg", "limit_arg"])
        f["pool_or_curve"] = names.codes(f["pool_or_curve"].to_numpy())
        Fl.append(f)

    curve = pd.concat(C, ignore_index=True).sort_values(["mint", "slot", "tx_idx", "ev_idx"], kind="stable").reset_index(drop=True)
    pool_rows = (pd.concat(P_rows, ignore_index=True) if P_rows else pd.DataFrame(columns=AMM_COLS + ["owner"]))
    pool_rows = pool_rows.sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="stable").reset_index(drop=True)
    pool_rows = _pool_after_state(pool_rows)
    buys = pd.concat(Buys, ignore_index=True).sort_values(["slot", "tx_idx"], kind="stable").reset_index(drop=True)
    buys = buys.astype({"owner": np.int32, "mint": np.int32, "tx_idx": np.int32})
    T = pd.concat(Tl, ignore_index=True).sort_values(["slot", "tx_idx", "outer_ix", "inner_ix"], kind="stable").reset_index(drop=True)
    T = T.astype({"mint": np.int32, "from_owner": np.int32, "to_owner": np.int32})
    W = (pd.concat(Wl, ignore_index=True) if Wl else pd.DataFrame({"slot": [], "src": [], "dst": []}).astype(np.int64))
    W = W.astype({"src": np.int32, "dst": np.int32})
    F_boost = pd.concat(Fl, ignore_index=True) if Fl else pd.DataFrame(columns=F_COLS)
    # codes for event address fields
    for k, df in events.items():
        for col in ("mint", "pool", "bonding_curve", "creator", "user", "base_mint", "quote_mint", "coin_creator"):
            if col in df.columns:
                df[col + "_c"] = names.codes(df[col].to_numpy())
    tape = Tape(units, segments(units), names, blocks, events, curve, pool_rows, buys, T, W, F_boost)
    tape.build_indexes()
    return tape


# ---------------------------------------------------------------------------------------------- compact reader
def _libc():
    try:
        import ctypes
        return ctypes.CDLL("libc.so.6")
    except (OSError, AttributeError):
        return None


def fixed_mmap_threshold():
    """glibc raises its mmap threshold each time a large block is freed, after which large numpy arrays land on the
    heap and their freed pages stay in the process. A fixed threshold (128 KiB) keeps every large array mmapped, so
    freeing it returns its memory. Memory only; no value changes."""
    lc = _libc()
    if lc is not None:
        try:
            lc.mallopt(-3, 128 * 1024)      # M_MMAP_THRESHOLD
        except AttributeError:
            pass


def _trim():
    """Hands freed heap back to the system between units (glibc), so reading peaks do not pile up."""
    import gc
    gc.collect()
    lc = _libc()
    if lc is not None:
        try:
            lc.malloc_trim(0)
        except AttributeError:
            pass


def _coalesce_cat(a: pd.Series, b: pd.Series):
    """`a.where(a.notna() & (a != ""), b)` for two categorical columns, as a categorical over their joint categories
    (the reference reader's owner = user_token_owner, else user). None if either column is not categorical."""
    ac, bc = a.array, b.array
    if not (isinstance(ac, pd.Categorical) and isinstance(bc, pd.Categorical)):
        return None
    ka, kb = np.asarray(ac.codes).astype(np.int64), np.asarray(bc.codes).astype(np.int64)
    union = ac.categories.append(bc.categories).unique()
    ia = np.asarray(union.get_indexer(ac.categories), dtype=np.int64)
    ib = np.asarray(union.get_indexer(bc.categories), dtype=np.int64)
    va = ka >= 0
    if len(ac.categories):
        empty = np.asarray(ac.categories == "", dtype=bool)
        va[va] = ~empty[ka[va]]
    out = np.full(len(ka), -1, dtype=np.int64)
    out[va] = ia[ka[va]]
    vb = ~va & (kb >= 0)
    out[vb] = ib[kb[vb]]
    return pd.Categorical.from_codes(out, categories=union)


def _owner_codes(names: Interner, df: pd.DataFrame) -> np.ndarray:
    cat = _coalesce_cat(df["user_token_owner"], df["user"])
    if cat is not None:
        return names.codes_cat(cat)
    uto = df["user_token_owner"].astype(object)
    owner = uto.where(uto.notna() & (uto != ""), df["user"].astype(object))
    return names.codes(owner.to_numpy())


def _columns(df: pd.DataFrame) -> dict:
    """The frame as independent column arrays (so the unit's frame and its blocks can be freed)."""
    return {k: df[k]._values.copy() for k in df.columns}


def _assemble(parts: List[dict], sort_by=None, astype=None) -> pd.DataFrame:
    """pd.concat(frames, ignore_index=True)[.sort_values(sort_by, kind="stable").reset_index(drop=True)][.astype(...)]
    of the reference reader, built one column at a time from `parts` (consumed), so at most about one table and two
    columns are held at once. Each column's dtype is resolved by pd.concat exactly as for the whole frames."""
    cols = list(parts[0].keys())
    order = None
    if sort_by:
        keys = pd.DataFrame({k: pd.concat([pd.Series(p[k], copy=False) for p in parts], ignore_index=True)
                             for k in sort_by}, copy=False)
        order = keys.sort_values(sort_by, kind="stable").index.to_numpy()
        del keys
    out = {}
    for k in cols:
        s = pd.concat([pd.Series(p.pop(k), copy=False) for p in parts], ignore_index=True)
        if order is not None:
            s = s.take(order)
        v = s._values
        del s
        if astype and k in astype:
            v = v.astype(astype[k])
        elif order is None:
            v = v.copy()
        out[k] = v
    return pd.DataFrame(out, copy=False)


def _load_compact(units: List[Unit], links: bool = True, log=print, pool: bool = True) -> Tape:
    """The reference reader with address columns read as categoricals and interned per category, each unit's frames
    freed as soon as they are cut down, and the final tables assembled column by column. Every interner call happens in
    the reference reader's order, so codes are identical."""
    fixed_mmap_threshold()
    names = Interner()
    B, E, C, Tl, Wl, Fl = [], [], [], [], [], []
    for u in units:
        b = pd.read_csv(u.table("B.csv.zst"), compression="zstd", usecols=["slot", "block_time"])
        B.append(b)
        E.append(read_events(u))
    blocks = pd.concat(B).drop_duplicates("slot").sort_values("slot").reset_index(drop=True)
    ev = pd.concat(E, ignore_index=True) if E else pd.DataFrame(columns=["event"])
    del B, E
    events = {k: ev[ev["event"] == k].dropna(axis=1, how="all").reset_index(drop=True) for k in E_KINDS}
    del ev
    for k in events:
        if "slot" not in events[k].columns:
            events[k] = pd.DataFrame(columns=["event", "slot", "block_time", "tx_idx", "ev_idx", "mint", "pool"])
    mig = events["CompletePumpAmmMigrationEvent"]
    pools = {}
    for p, s in zip(mig.get("pool", []), mig.get("slot", [])):
        pools[p] = min(pools.get(p, s), s)
    pool_codes = {names.code(p): s for p, s in pools.items()}

    P_rows, Buys = [], []
    for u in units:
        log(f"  reading {u.day} {u.from_slot}-{u.to_slot} ({u.schema})")
        c = _read_csv(u.table("S_curve.csv.zst"), CURVE_COLS, CURVE_STR, cat_cols=CURVE_STR)
        _num(c, ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "is_buy", "sol_amount", "token_amount",
                 "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves", "real_token_reserves",
                 "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee", "quote_amount",
                 "virtual_quote_reserves", "real_quote_reserves", "owner_token_post"])
        for col in ("mayhem_mode", "cashback_fee_basis_points"):   # keep NaN: an unreadable flag stays unreadable
            c[col] = pd.to_numeric(c[col], errors="coerce")
        c["owner"] = _owner_codes(names, c)
        c["mint"] = names.codes_cat(c["mint"])
        c["creator"] = names.codes_cat(c["creator"])
        auth = names.code(P.BUYBACK_AUTHORITY)
        c["is_buyback"] = (names.codes_cat(c["signer"]) == auth) | (names.codes_cat(c["user"]) == auth)
        c = c.drop(columns=["user", "user_token_owner", "signer"])
        cb = c[c["is_buy"] == 1]
        Buys.append({"slot": cb["slot"].to_numpy().copy(), "tx_idx": cb["tx_idx"].to_numpy().copy(),
                     "owner": cb["owner"].to_numpy().copy(), "mint": cb["mint"].to_numpy().copy(),
                     "sol": cb["sol_amount"].to_numpy().copy(), "venue": np.zeros(len(cb), np.int8)})
        del cb
        C.append(_columns(c))
        del c

        a = _read_csv(u.table("S_amm.csv.zst"), AMM_COLS, AMM_STR, cat_cols=AMM_STR)
        _num(a, ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "base_amount", "quote_amount",
                 "quote_amount_lp_adjusted", "pool_base_token_reserves", "pool_quote_token_reserves",
                 "virtual_quote_reserves", "lp_fee_basis_points", "protocol_fee_basis_points",
                 "coin_creator_fee_basis_points", "lp_fee", "protocol_fee", "coin_creator_fee", "min_base_amount_out",
                 "base_supply", "chain_pool_base", "chain_pool_quote", "canonical"])
        a["owner"] = _owner_codes(names, a)
        a["pool"] = names.codes_cat(a["pool"])
        a["base_mint"] = names.codes_cat(a["base_mint"])
        a["signer"] = names.codes_cat(a["signer"])
        a["user_c"] = names.codes_cat(a["user"])
        a = a.drop(columns=["user", "user_token_owner"])
        wsol = names.code(P.WSOL)
        coin_is_base = a["base_mint"] != wsol
        is_buy = np.where(coin_is_base, a["side"] == "buy", a["side"] == "sell")
        ab = a[is_buy & coin_is_base]
        Buys.append({"slot": ab["slot"].to_numpy().copy(), "tx_idx": ab["tx_idx"].to_numpy().copy(),
                     "owner": ab["owner"].to_numpy().copy(), "mint": ab["base_mint"].to_numpy().copy(),
                     "sol": ab["quote_amount_lp_adjusted"].to_numpy().copy(), "venue": np.ones(len(ab), np.int8)})
        del ab, is_buy, coin_is_base
        if pool_codes and pool:
            mslot = a["pool"].map(pool_codes)
            keep = mslot.notna() & (a["slot"] <= mslot.fillna(0) + P.BOOST_COMPLETE_HORIZON_SLOTS + 1_000)
            P_rows.append(_columns(a[keep]))
            del mslot, keep
        del a
        _trim()

        t = _read_csv(u.table("T.csv.zst"), T_COLS, set(), cat_cols=("mint", "from_owner", "to_owner"))
        _num(t, ["slot", "tx_idx", "outer_ix", "inner_ix", "amount"])
        for col in ("mint", "from_owner", "to_owner"):
            t[col] = names.codes_cat(t[col])
        Tl.append(_columns(t))
        del t
        if links:
            w = _read_csv(u.table("W.csv.zst"), W_COLS, set(), cat_cols=("from", "to"))
            Wl.append({"slot": w["slot"].astype(np.int64).to_numpy().copy(), "src": names.codes_cat(w["from"]),
                       "dst": names.codes_cat(w["to"])})
            del w
        f = _read_csv(u.table("F.csv.zst"), F_COLS, set())
        f = f[f["ix_name"] == "boost_buy_and_burn"].copy()
        _num(f, ["slot", "tx_idx", "amount_arg", "limit_arg"])
        f["pool_or_curve"] = names.codes(f["pool_or_curve"].to_numpy())
        Fl.append(f)
        del f
        _trim()

    curve = _assemble(C, sort_by=["mint", "slot", "tx_idx", "ev_idx"])
    del C
    if P_rows:
        pool_rows = _assemble(P_rows, sort_by=["pool", "slot", "tx_idx", "ev_idx"])
    else:
        pool_rows = pd.DataFrame(columns=AMM_COLS + ["owner"])
        pool_rows = pool_rows.sort_values(["pool", "slot", "tx_idx", "ev_idx"], kind="stable").reset_index(drop=True)
    del P_rows
    pool_rows = _pool_after_state(pool_rows)
    buys = _assemble(Buys, sort_by=["slot", "tx_idx"], astype={"owner": np.int32, "mint": np.int32, "tx_idx": np.int32})
    del Buys
    T = _assemble(Tl, sort_by=["slot", "tx_idx", "outer_ix", "inner_ix"],
                  astype={"mint": np.int32, "from_owner": np.int32, "to_owner": np.int32})
    del Tl
    W = (_assemble(Wl, astype={"src": np.int32, "dst": np.int32}) if Wl
         else pd.DataFrame({"slot": [], "src": [], "dst": []}).astype(np.int64).astype({"src": np.int32, "dst": np.int32}))
    del Wl
    F_boost = pd.concat(Fl, ignore_index=True) if Fl else pd.DataFrame(columns=F_COLS)
    for k, df in events.items():
        for col in ("mint", "pool", "bonding_curve", "creator", "user", "base_mint", "quote_mint", "coin_creator"):
            if col in df.columns:
                df[col + "_c"] = names.codes(df[col].to_numpy())
    _trim()
    tape = Tape(units, segments(units), names, blocks, events, curve, pool_rows, buys, T, W, F_boost)
    tape.build_indexes()
    return tape


def _pool_after_state(a: pd.DataFrame) -> pd.DataFrame:
    """After-state of each PumpSwap row. Pool reserves on the tape are before the trade (PREREG §7 check 2);
    `chain_pool_*` are the vault balances after the row's transaction, present on the pool's last row of each
    transaction. A row followed by another row of the same pool in the same transaction takes that row's before-state."""
    if len(a) == 0:
        for c in ("after_base", "after_quote", "after_virtual"):
            a[c] = pd.Series(dtype=np.int64)
        return a
    g = a.groupby(["pool", "slot", "tx_idx"], sort=False)
    last_in_tx = g.cumcount(ascending=False).to_numpy() == 0
    nxt_b = a["pool_base_token_reserves"].shift(-1).fillna(-1).astype(np.int64).to_numpy()
    nxt_q = a["pool_quote_token_reserves"].shift(-1).fillna(-1).astype(np.int64).to_numpy()
    nxt_v = a["virtual_quote_reserves"].shift(-1).fillna(0).astype(np.int64).to_numpy()
    a["after_base"] = np.where(last_in_tx, a["chain_pool_base"].to_numpy(), nxt_b)
    a["after_quote"] = np.where(last_in_tx, a["chain_pool_quote"].to_numpy(), nxt_q)
    a["after_virtual"] = np.where(last_in_tx, a["virtual_quote_reserves"].to_numpy(), nxt_v)
    return a
