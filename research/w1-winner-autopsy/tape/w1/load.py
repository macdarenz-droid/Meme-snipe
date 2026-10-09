"""Units, tables and the address vocabulary.

A unit directory is CACHE/<day>/<from>-<to>/research (research/shared-tape/fetch.py). Only the columns W1 needs
are read; addresses become int32 ids at once so a day of tape fits in memory."""
import calendar
import hashlib
import io
import json
import os
import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .addr import SOL_CURVE_QUOTES, WSOL

# PREREG §2: W1 reads only days before the wall and outside U1-B's holdout (from 2026-09-12) and the sealed
# window; the latest registered day is Step A's 2026-09-11, the earliest Step C's 2026-09-02.
FIRST_DAY, LAST_DAY = "2026-09-02", "2026-09-11"
WALL_TS = calendar.timegm((2026, 9, 12, 0, 0, 0))  # no row at or after this block time is ever read

_UNIT_RE = re.compile(r"(\d{4}-\d{2}-\d{2})[/\\](\d+)-(\d+)(?:[/\\]research)?[/\\]?$")


@dataclass(frozen=True)
class Unit:
    day: str
    lo: int
    hi: int
    path: str


def parse_units(paths):
    """Unit directories -> Units sorted by first slot. Refuses days outside the registered windows."""
    out = []
    for p in paths:
        p = os.path.normpath(p)
        m = _UNIT_RE.search(p)
        if not m:
            raise ValueError(f"not a unit directory (want <day>/<from>-<to>/research): {p}")
        day, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
        if not (FIRST_DAY <= day <= LAST_DAY):
            raise ValueError(f"{p}: day {day} is outside W1's windows ({FIRST_DAY}..{LAST_DAY})")
        if not p.endswith("research"):
            p = os.path.join(p, "research")
        out.append(Unit(day, lo, hi, p))
    out.sort(key=lambda u: u.lo)
    for a, b in zip(out, out[1:]):
        if b.lo <= a.hi:
            raise ValueError(f"overlapping units {a.lo}-{a.hi} and {b.lo}-{b.hi}")
    return out


def find_units(cache, days):
    """Every cached unit of the given days. A requested day with no unit is an error, never skipped."""
    us = []
    for d in days:
        root = os.path.join(cache, d)
        found = []
        if os.path.isdir(root):
            for name in os.listdir(root):
                if re.fullmatch(r"\d+-\d+", name) and os.path.isdir(os.path.join(root, name, "research")):
                    found.append(os.path.join(root, name, "research"))
        if not found:
            raise ValueError(f"no cached unit for {d} under {cache}")
        us += found
    return parse_units(us)


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


TABLES = ("S_curve", "S_amm", "T", "T_coverage", "W", "E")


def input_paths(units, tables=TABLES):
    out = {}
    for u in units:
        for t in tables:
            ext = ".jsonl.zst" if t == "E" else ".csv.zst"
            p = os.path.join(u.path, t + ext)
            if os.path.exists(p):
                out[f"{u.day}/{u.lo}-{u.hi}/{t}{ext}"] = os.path.abspath(p)
    return out


def input_hashes(units, tables=TABLES):
    """PREREG §9.4: the sha256 of every input file read."""
    return {k: file_sha256(p) for k, p in input_paths(units, tables).items()}


class Vocab:
    """Address string <-> int32 id. Empty or missing is -1."""

    def __init__(self):
        self.idx = {}
        self.strs = []

    def ids(self, s: pd.Series) -> np.ndarray:
        s = s.astype(object)
        s = s.where(s.notna() & (s != ""), None)
        for v in pd.unique(s.dropna()):
            if v not in self.idx:
                self.idx[v] = len(self.strs)
                self.strs.append(v)
        return s.map(self.idx).fillna(-1).astype(np.int64).to_numpy().astype(np.int32)

    def id(self, s):
        if not s:
            return -1
        if s not in self.idx:
            self.idx[s] = len(self.strs)
            self.strs.append(s)
        return self.idx[s]

    def get(self, s, default=-1):
        return self.idx.get(s, default)

    def __len__(self):
        return len(self.strs)


# "chunked" (default): the table is read CHUNK rows at a time; each chunk's integer columns become int64 at once and
# its text cells are shared with equal cells already read, so a unit's text never sits in memory once per cell.
# "legacy": the whole table as text first (the original reader; kept for the equality test). Same values either way.
READER = "chunked"
CHUNK = 50_000


def read_table(path, cols, int_cols=(), nrows=None):
    """Reads the wanted columns as text, then integer columns exactly as int64 (missing -> 0 with a `<col>_na`
    flag; a value outside int64 -> 0 with its row flagged in `_overflow`). pandas' nullable Int64 reader wraps
    out-of-range values silently, so it is not used."""
    head = pd.read_csv(path, compression="zstd", nrows=0).columns
    use = [c for c in cols if c in head]
    if READER == "legacy" or nrows is not None:
        df = pd.read_csv(path, compression="zstd", usecols=use, dtype=str, nrows=nrows, keep_default_na=False)
        return _convert(df, cols, int_cols)
    shared = {}
    parts = []
    for ch in pd.read_csv(path, compression="zstd", usecols=use, dtype=str, keep_default_na=False,
                          chunksize=CHUNK):
        for c in ch.columns:
            if c not in int_cols:
                ch[c] = _share(ch[c].to_numpy(dtype=object), shared.setdefault(c, {}))
        parts.append(_convert(ch, cols, int_cols))
    if not parts:
        df = pd.read_csv(path, compression="zstd", usecols=use, dtype=str, keep_default_na=False)
        return _convert(df, cols, int_cols)
    return pd.concat(parts, ignore_index=True) if len(parts) > 1 else parts[0]


def _share(vals, seen):
    """The same text values, with equal cells pointing at one string object."""
    out = np.empty(len(vals), object)
    for i, x in enumerate(vals):
        out[i] = seen.setdefault(x, x)
    return out


def _convert(df, cols, int_cols):
    bad = np.zeros(len(df), bool)
    for c in int_cols:
        if c not in df.columns:
            df[c] = 0
            df[c + "_na"] = True
            continue
        sv = df[c].to_numpy(dtype=object)
        na = sv == ""
        sv = np.where(na, "0", sv)
        try:
            vals = sv.astype(np.int64)
        except (OverflowError, ValueError):
            vals = np.zeros(len(sv), np.int64)
            for i, x in enumerate(sv):
                try:
                    vals[i] = int(x)
                except (OverflowError, ValueError):
                    bad[i] = True
        df[c] = vals
        df[c + "_na"] = na
    df["_overflow"] = bad
    for c in cols:
        if c not in df.columns:
            df[c] = ""
    if len(df) and "block_time" in df.columns:
        df = df[df["block_time"] < WALL_TS]
    return df.reset_index(drop=True)


CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "signer", "tx_fee", "jito_tip", "mint", "is_buy", "sol_amount",
              "token_amount", "user", "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves",
              "real_token_reserves", "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee",
              "cashback_fee_basis_points", "cashback", "quote_mint", "ix_name", "user_token_account", "user_token_owner", "owner_token_pre",
              "owner_token_post", "signer_sol_pre", "signer_sol_post", "protocol"]
CURVE_INTS = ["slot", "block_time", "tx_idx", "ev_idx", "tx_fee", "jito_tip", "is_buy", "sol_amount", "token_amount",
              "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves", "real_token_reserves",
              "fee_basis_points", "fee", "creator_fee_basis_points", "creator_fee", "cashback_fee_basis_points",
              "cashback", "owner_token_pre", "owner_token_post", "signer_sol_pre", "signer_sol_post", "protocol"]
AMM_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "signer", "tx_fee", "jito_tip", "pool", "base_mint", "quote_mint",
            "side", "base_amount", "quote_amount", "user", "pool_base_token_reserves", "pool_quote_token_reserves",
            "lp_fee_basis_points", "protocol_fee_basis_points", "coin_creator_fee_basis_points",
            "cashback_fee_basis_points", "quote_amount_lp_adjusted", "user_quote_amount", "virtual_quote_reserves",
            "ix_name", "user_token_account", "user_token_owner", "owner_token_pre", "owner_token_post",
            "signer_sol_pre", "signer_sol_post",
            "canonical", "protocol"]
AMM_INTS = ["slot", "block_time", "tx_idx", "ev_idx", "tx_fee", "jito_tip", "base_amount", "quote_amount",
            "pool_base_token_reserves", "pool_quote_token_reserves", "lp_fee_basis_points",
            "protocol_fee_basis_points", "coin_creator_fee_basis_points", "cashback_fee_basis_points",
            "quote_amount_lp_adjusted", "user_quote_amount", "virtual_quote_reserves", "owner_token_pre",
            "owner_token_post", "signer_sol_pre", "signer_sol_post", "canonical", "protocol"]

KEY_TX_SHIFT = 8
KEY_SLOT_SHIFT = 24


def make_key(slot, tx_idx, sub):
    """Total order (slot, tx_idx, ev_idx); sub 255 = after every event of the transaction."""
    return (np.asarray(slot, np.int64) << KEY_SLOT_SHIFT) | (np.asarray(tx_idx, np.int64) << KEY_TX_SHIFT) | \
        np.minimum(np.asarray(sub, np.int64), 255)


def key_slot(key):
    return np.asarray(key, np.int64) >> KEY_SLOT_SHIFT


def swaps(unit: Unit, vocab: Vocab, mints=None):
    """The unit's curve and PumpSwap trades as one table, in key order.

    Columns: key, txk (key of the transaction), slot, bt, owner, acct (user_token_account), signer, user, mint, venue (0 curve, 1 pool),
    pool, canonical, sol (SOL-quoted), is_buy, tokens, cash (signed lamports, venue fees included, tx costs not),
    tx_fee, jito, tx_fee_na, pre, post, spre, spost, protocol, boost, s1..s4, bps (venue state after the trade,
    see venue.py), n_tx (swaps in the transaction, any venue or quote)."""
    parts = []
    cp = os.path.join(unit.path, "S_curve.csv.zst")
    if os.path.exists(cp):
        c = read_table(cp, CURVE_COLS, CURVE_INTS)
        if mints is not None:
            c = c[c["mint"].isin(mints)].reset_index(drop=True)
        isb = c["is_buy"].to_numpy() == 1
        fees = (c["fee"] + c["creator_fee"] + c["cashback"]).to_numpy()
        sol = c["sol_amount"].to_numpy()
        parts.append(pd.DataFrame({
            "slot": c["slot"], "bt": c["block_time"], "tx_idx": c["tx_idx"], "ev_idx": c["ev_idx"],
            "owner_s": c["user_token_owner"], "acct_s": c["user_token_account"], "signer_s": c["signer"].where(c["signer"] != "", c["user"]),
            "user_s": c["user"], "mint_s": c["mint"], "pool_s": "", "venue": 0, "canonical": 0,
            "sol": c["quote_mint"].isin(SOL_CURVE_QUOTES).to_numpy(), "is_buy": isb,
            "tokens": c["token_amount"], "cash": np.where(isb, -(sol + fees), sol - fees).astype(np.float64),
            "tx_fee": c["tx_fee"], "tx_fee_na": c["tx_fee_na"], "jito": c["jito_tip"], "pre": c["owner_token_pre"],
            "post": c["owner_token_post"], "pre_na": c["owner_token_pre_na"], "spre": c["signer_sol_pre"],
            "spost": c["signer_sol_post"], "protocol": c["protocol"], "boost": c["ix_name"] == "boost_buy_and_burn",
            "s1": c["virtual_sol_reserves"], "s2": c["virtual_token_reserves"], "s3": c["real_sol_reserves"],
            "s4": c["real_token_reserves"],
            "bps": c["fee_basis_points"] + c["creator_fee_basis_points"] + c["cashback_fee_basis_points"],
            "overflow": c["_overflow"]}))
    ap = os.path.join(unit.path, "S_amm.csv.zst")
    if os.path.exists(ap):
        a = read_table(ap, AMM_COLS, AMM_INTS)
        if mints is not None:
            a = a[a["base_mint"].isin(mints)].reset_index(drop=True)
        isb = (a["side"] == "buy").to_numpy()
        sgn = np.where(isb, 1, -1)
        uq = a["user_quote_amount"].to_numpy()
        parts.append(pd.DataFrame({
            "slot": a["slot"], "bt": a["block_time"], "tx_idx": a["tx_idx"], "ev_idx": a["ev_idx"],
            "owner_s": a["user_token_owner"], "acct_s": a["user_token_account"], "signer_s": a["signer"].where(a["signer"] != "", a["user"]),
            "user_s": a["user"], "mint_s": a["base_mint"], "pool_s": a["pool"], "venue": 1,
            "canonical": a["canonical"],
            "sol": ((a["quote_mint"] == WSOL) & (a["base_mint"] != WSOL)).to_numpy(), "is_buy": isb,
            "tokens": a["base_amount"], "cash": np.where(isb, -uq, uq).astype(np.float64),
            "tx_fee": a["tx_fee"], "tx_fee_na": a["tx_fee_na"], "jito": a["jito_tip"], "pre": a["owner_token_pre"],
            "post": a["owner_token_post"], "pre_na": a["owner_token_pre_na"], "spre": a["signer_sol_pre"],
            "spost": a["signer_sol_post"], "protocol": a["protocol"], "boost": a["ix_name"] == "boost_buy_and_burn",
            # state AFTER the trade: event reserves are before it (historical-data.md)
            "s1": a["pool_base_token_reserves"] - sgn * a["base_amount"],
            "s2": a["pool_quote_token_reserves"] + sgn * a["quote_amount_lp_adjusted"],
            "s3": a["virtual_quote_reserves"], "s4": 0,
            "bps": a["lp_fee_basis_points"] + a["protocol_fee_basis_points"] + a["coin_creator_fee_basis_points"]
            + a["cashback_fee_basis_points"],
            "overflow": a["_overflow"]}))
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts, ignore_index=True)
    df["key"] = make_key(df["slot"], df["tx_idx"], df["ev_idx"])
    df["txk"] = make_key(df["slot"], df["tx_idx"], 0) >> KEY_TX_SHIFT
    df = df.sort_values("key", kind="stable").reset_index(drop=True)
    df["n_tx"] = df.groupby("txk")["key"].transform("size").astype(np.int32)
    for col in ("owner", "acct", "signer", "user", "mint", "pool"):
        df[col] = vocab.ids(df.pop(col + "_s"))
    for col in ("tokens", "tx_fee", "jito", "pre", "post", "spre", "spost", "s1", "s2", "s3", "s4", "bps", "slot",
                "bt", "protocol", "canonical"):
        df[col] = df[col].astype(np.int64)
    return df


def movements(unit: Unit, vocab: Vocab, mints=None):
    """T rows: key (after the transaction's swaps), slot, bt, mint, kind (0 transfer, 1 burn, 2 mint), frm, to,
    facct, tacct (token accounts), amount."""
    p = os.path.join(unit.path, "T.csv.zst")
    if not os.path.exists(p):
        return pd.DataFrame(columns=["key", "slot", "bt", "mint", "kind", "frm", "to", "facct", "tacct", "amount",
                                     "txk"])
    t = read_table(p, ["slot", "block_time", "tx_idx", "mint", "kind", "from_owner", "to_owner", "amount",
                       "from_account", "to_account"],
                   ["slot", "block_time", "tx_idx", "amount"])
    if mints is not None:
        t = t[t["mint"].isin(mints)].reset_index(drop=True)
    kind = t["kind"].map({"transfer": 0, "burn": 1, "mint": 2}).fillna(3).astype(np.int8)
    out = pd.DataFrame({"key": make_key(t["slot"], t["tx_idx"], 255), "slot": t["slot"].astype(np.int64),
                        "bt": t["block_time"].astype(np.int64), "mint": vocab.ids(t["mint"]), "kind": kind,
                        "frm": vocab.ids(t["from_owner"]), "to": vocab.ids(t["to_owner"]),
                        "facct": vocab.ids(t["from_account"]), "tacct": vocab.ids(t["to_account"]),
                        "amount": t["amount"].astype(np.int64)})
    out["txk"] = out["key"].to_numpy(np.int64) >> KEY_TX_SHIFT
    return out.sort_values("key", kind="stable").reset_index(drop=True)


def sol_transfers(unit: Unit, vocab: Vocab):
    """W rows as (slot, from, to) ids; None when the unit has no W table."""
    p = os.path.join(unit.path, "W.csv.zst")
    if not os.path.exists(p):
        return None
    w = read_table(p, ["slot", "block_time", "from", "to"], ["slot", "block_time"])
    return pd.DataFrame({"slot": w["slot"].astype(np.int64), "frm": vocab.ids(w["from"]), "to": vocab.ids(w["to"])})


def coverage(unit: Unit, vocab: Vocab):
    """T_coverage: (mint id, first unresolved slot) and the set of mint ids with partial movement coverage."""
    p = os.path.join(unit.path, "T_coverage.csv.zst")
    if not os.path.exists(p):
        return {}, set()
    c = pd.read_csv(p, compression="zstd", dtype=str, keep_default_na=False)
    unres = {}
    u = c[c["scope"] == "unresolved"]
    for m, s in zip(u["mint"], u["slot"]):
        if not m or m == "*":
            continue
        s = int(s) if s else unit.lo
        i = vocab.id(m)
        unres[i] = min(unres.get(i, s), s)
    partial = {vocab.id(m) for m in c.loc[c["scope"] == "pump_transactions", "mint"] if m and m != "*"}
    return unres, partial


G_EVENTS = ("CompleteEvent", "CompletePumpAmmMigrationEvent", "CreatePoolEvent")


def events(unit: Unit):
    """E rows W1 uses, as dicts: CreateEvent (C), migrations (G), BoostBuyAndBurnEvent, InitBoostEvent."""
    p = os.path.join(unit.path, "E.jsonl.zst")
    out = []
    if not os.path.exists(p):
        return out
    import zstandard
    want = ("CreateEvent", "BoostBuyAndBurnEvent", "InitBoostEvent") + G_EVENTS
    with open(p, "rb") as fh:
        r = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8")
        for line in r:
            if not any(w in line for w in want):
                continue
            d = json.loads(line)
            if d.get("event") in want and int(d.get("block_time") or 0) < WALL_TS:
                out.append(d)
    return out
