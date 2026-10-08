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
           "InitBoostEvent", "BoostBuyAndBurnEvent")

CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "mint", "is_buy", "sol_amount",
              "token_amount", "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves",
              "real_token_reserves", "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee",
              "mayhem_mode", "cashback_fee_basis_points", "quote_mint", "quote_amount", "virtual_quote_reserves",
              "real_quote_reserves", "user", "user_token_owner", "owner_token_post", "creator"]
CURVE_STR = {"mint", "user", "user_token_owner", "creator"}

AMM_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "pool", "base_mint", "quote_mint",
            "side", "base_amount", "quote_amount", "quote_amount_lp_adjusted", "pool_base_token_reserves",
            "pool_quote_token_reserves", "virtual_quote_reserves", "lp_fee_basis_points",
            "protocol_fee_basis_points", "coin_creator_fee_basis_points", "lp_fee", "protocol_fee",
            "coin_creator_fee", "min_base_amount_out", "ix_name", "base_supply", "chain_pool_base",
            "chain_pool_quote", "user", "user_token_owner", "canonical", "protocol", "signer"]
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


def find_units(roots: List[str], days: Optional[List[str]] = None) -> List[Unit]:
    """Unit directories from explicit unit paths or cache roots (CACHE, CACHE/<day>, CACHE/<day>/<unit>)."""
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


def _read_csv(path: str, cols: List[str], str_cols) -> pd.DataFrame:
    hdr = _header(path)
    use = [c for c in cols if c in hdr]
    dtypes = {c: str for c in use if c in str_cols or c in ("quote_mint", "side", "ix_name", "kind", "err_class",
                                                               "pool_or_curve", "from", "to", "from_owner", "to_owner")}
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


def load(units: List[Unit], links: bool = True, log=print) -> Tape:
    """Loads every table the G1 stages read. `links=False` skips W (amendment features then cannot be computed)."""
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
        c = c.drop(columns=["user", "user_token_owner"])
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
                 "base_supply", "chain_pool_base", "chain_pool_quote", "canonical", "protocol"])
        owner = a["user_token_owner"].where(a["user_token_owner"].notna() & (a["user_token_owner"] != ""), a["user"])
        a["owner"] = names.codes(owner.to_numpy())
        a["pool"] = names.codes(a["pool"].to_numpy())
        a["base_mint"] = names.codes(a["base_mint"].to_numpy())
        a["signer"] = names.codes(a["signer"].to_numpy())
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
    T = pd.concat(Tl, ignore_index=True).sort_values(["slot", "tx_idx", "outer_ix", "inner_ix"], kind="stable").reset_index(drop=True)
    W = (pd.concat(Wl, ignore_index=True) if Wl else pd.DataFrame({"slot": [], "src": [], "dst": []}).astype(np.int64))
    F_boost = pd.concat(Fl, ignore_index=True) if Fl else pd.DataFrame(columns=F_COLS)
    # codes for event address fields
    for k, df in events.items():
        for col in ("mint", "pool", "bonding_curve", "creator", "user", "base_mint", "quote_mint", "coin_creator"):
            if col in df.columns:
                df[col + "_c"] = names.codes(df[col].to_numpy())
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
