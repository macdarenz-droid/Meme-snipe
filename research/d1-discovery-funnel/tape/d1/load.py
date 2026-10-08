"""Read shared-tape units (research/shared-tape/README.md) into one in-memory `Tape`.

Input: a list of unit directories `<cache>/<day>/<from>-<to>` (each holding `research/*.csv.zst`) and the day(s).
Every address is coded to an int (`Tape.codec`), -1 for empty. Rows at or after 2026-09-12T00:00Z fail the load
(they never exist in the tape; fail closed). Units of schema v1 have no `top_program` (S) and no CF table: the
dependent feature is NaN there.
"""
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from . import config as C


class Codec:
    """Address string -> dense int code. Empty / NaN -> -1."""

    def __init__(self):
        self.index: Dict[str, int] = {}
        self.names: List[str] = []

    def encode(self, s: pd.Series) -> np.ndarray:
        codes, uniq = pd.factorize(s, use_na_sentinel=True)
        m = np.empty(len(uniq) + 1, dtype=np.int64)
        m[-1] = -1
        for i, u in enumerate(uniq):
            if not isinstance(u, str) or u == "":
                m[i] = -1
                continue
            c = self.index.get(u)
            if c is None:
                c = len(self.names)
                self.index[u] = c
                self.names.append(u)
            m[i] = c
        return m[codes]

    def code(self, addr: str) -> int:
        return self.index.get(addr, -1)

    def __len__(self):
        return len(self.names)


@dataclass
class Unit:
    path: str          # the unit directory (holding research/)
    day: str
    from_slot: int
    to_slot: int
    schema: int = 2

    @property
    def research(self) -> str:
        r = os.path.join(self.path, "research")
        return r if os.path.isdir(r) else self.path


def parse_unit(path: str) -> Unit:
    p = os.path.normpath(path)
    if os.path.basename(p) == "research":
        p = os.path.dirname(p)
    m = re.fullmatch(r"(\d+)-(\d+)", os.path.basename(p))
    day = os.path.basename(os.path.dirname(p))
    if not m or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError(f"not a unit directory <day>/<from>-<to>: {path}")
    return Unit(p, day, int(m.group(1)), int(m.group(2)))


def segments(units: Sequence[Unit]) -> List[Tuple[int, int]]:
    """Gap-free slot coverage: unit ranges merged where one starts right after the previous ends."""
    segs: List[List[int]] = []
    for u in sorted(units, key=lambda u: u.from_slot):
        if segs and u.from_slot <= segs[-1][1] + 1:
            segs[-1][1] = max(segs[-1][1], u.to_slot)
        else:
            segs.append([u.from_slot, u.to_slot])
    return [tuple(s) for s in segs]


def file_hashes(units: Sequence[Unit]) -> Dict[str, str]:
    out = {}
    for u in units:
        for f in sorted(os.listdir(u.research)):
            fp = os.path.join(u.research, f)
            h = hashlib.sha256()
            with open(fp, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            out[f"{u.day}/{u.from_slot}-{u.to_slot}/{f}"] = h.hexdigest()
    return out


def _read(u: Unit, name: str, cols: Sequence[str]) -> Optional[pd.DataFrame]:
    fp = os.path.join(u.research, name)
    if not os.path.exists(fp):
        return None
    head = pd.read_csv(fp, compression="zstd", nrows=0)
    have = [c for c in cols if c in head.columns]
    df = pd.read_csv(fp, compression="zstd", usecols=have, dtype=str, keep_default_na=False, na_values=[""])
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    return df[list(cols)]


def _int(s: pd.Series, fill: int = -1) -> np.ndarray:
    return pd.to_numeric(s, errors="coerce").fillna(fill).astype(np.int64).to_numpy()


def _num(s: pd.Series) -> np.ndarray:
    return pd.to_numeric(s, errors="coerce").astype(float).to_numpy()


AMM_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "pool", "base_mint", "quote_mint", "side",
            "base_amount", "quote_amount", "quote_amount_lp_adjusted", "user_quote_amount",
            "pool_base_token_reserves", "pool_quote_token_reserves", "virtual_quote_reserves",
            "lp_fee_basis_points", "protocol_fee_basis_points", "coin_creator_fee_basis_points", "coin_creator",
            "base_supply", "user_token_owner", "owner_token_pre", "owner_token_post", "canonical", "top_program", "signature", "protocol"]
CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "mint", "is_buy", "sol_amount",
              "token_amount", "fee", "creator_fee", "quote_mint", "quote_amount", "mayhem_mode", "user_token_owner",
              "owner_token_pre", "owner_token_post", "signature", "protocol"]
T_COLS = ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner", "to_owner", "amount"]
W_COLS = ["slot", "block_time", "from", "to"]
F_COLS = ["slot", "block_time", "venue", "side", "err_class", "pool_or_curve"]
CF_COLS = ["slot", "block_time", "creator"]
E_EVENTS = ("CreateEvent", "CompletePumpAmmMigrationEvent", "CreatePoolEvent", "InitBoostEvent", "BoostBuyAndBurnEvent",
            # H8_AMENDMENT_2 gates: H9 (graduation time), H6 (LP outstanding), H17 (pool account size)
            "CompleteEvent", "DepositEvent", "WithdrawEvent", "ExtendAccountEvent")
_NUMERIC_EVENT_FIELDS = ("is_mayhem_mode", "boost_vault_remaining", "is_cashback_enabled", "pool_quote_amount",
                         "pool_base_amount", "lp_token_amount_out", "lp_token_amount_in", "new_size")
SOL_QUOTES = {C.WSOL, C.SYSTEM_PROGRAM}


@dataclass
class Tape:
    units: List[Unit]
    days: Tuple[str, ...]
    segs: List[Tuple[int, int]]
    codec: Codec
    b: pd.DataFrame          # slot, block_time
    amm: pd.DataFrame        # canonical WSOL PumpSwap trade rows (coded), sorted
    buys: pd.DataFrame       # every curve and PumpSwap buy: slot, tx_idx, ev_idx, mint, owner, sol (NaN if not SOL)
    curve: pd.DataFrame      # SOL bonding-curve rows (holder accounting)
    t: pd.DataFrame          # token movements
    w: pd.DataFrame          # SOL transfers: slot, src, dst
    f: pd.DataFrame          # failed PumpSwap buys, slippage class: slot, block_time, pool
    cf: pd.DataFrame         # creator-fee collections: slot, block_time, creator
    ev: Dict[str, pd.DataFrame]
    schema_v1_slots: List[Tuple[int, int]] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=dict)

    def covered_segment(self, slot: int) -> Optional[Tuple[int, int]]:
        for a, b in self.segs:
            if a <= slot <= b:
                return (a, b)
        return None


def _wall(df: pd.DataFrame, name: str, u: Unit):
    if len(df) and (pd.to_numeric(df["block_time"], errors="coerce") >= C.WALL_EPOCH).any():
        raise RuntimeError(f"{u.path} {name}: a row at or after 2026-09-12T00:00Z (holdout); refusing to load")


def migrated_pools(units: Sequence[Unit]) -> set:
    """First pass: pools of every CompletePumpAmmMigrationEvent on the tape (only these can enter the universe)."""
    pools = set()
    for u in units:
        ep = os.path.join(u.research, "E.jsonl.zst")
        if os.path.exists(ep):
            e = pd.read_json(ep, compression="zstd", lines=True, dtype=False)
            for f in e.loc[e.event == "CompletePumpAmmMigrationEvent", "fields"]:
                pools.add(f.get("pool"))
    return pools


def _down(df: pd.DataFrame) -> pd.DataFrame:
    """Downcast integer columns that fit in int32 (slots < 2^31, codes, indexes, bps) to save memory."""
    for c in df.columns:
        if df[c].dtype == np.int64 and len(df) and df[c].min() >= -2**31 and df[c].max() < 2**31:
            df[c] = df[c].astype(np.int32)
    return df


def load(unit_dirs: Sequence[str], days: Sequence[str], all_pools: bool = False) -> Tape:
    """all_pools=False keeps pool rows only for pools migrated on the tape (the universe); True keeps every canonical
    WSOL pool (dev shape checks)."""
    units = sorted((parse_unit(p) for p in unit_dirs), key=lambda u: u.from_slot)
    days = tuple(sorted(days))
    for u in units:
        if u.day not in days:
            raise ValueError(f"unit {u.path} is on {u.day}, not one of {days}")
        if C.epoch(u.day) >= C.WALL_EPOCH:
            raise ValueError(f"day {u.day} is at or after the holdout start 2026-09-12")
    codec = Codec()
    mig_pools = None if all_pools else migrated_pools(units)
    parts: Dict[str, list] = {k: [] for k in ("b", "amm", "buys", "curve", "t", "w", "f", "cf")}
    evp: Dict[str, list] = {k: [] for k in E_EVENTS}
    v1 = []
    for u in units:
        r = u.research
        boost_sigs = set()
        ep = os.path.join(r, "E.jsonl.zst")
        if os.path.exists(ep):
            e = pd.read_json(ep, compression="zstd", lines=True, dtype=False)
            e = e[e.event.isin(E_EVENTS)]
            for name, g in e.groupby("event"):
                flds = pd.DataFrame(list(g.fields))
                flds["slot"] = g.slot.astype(np.int64).to_numpy()
                flds["signature"] = g.signature.to_numpy()
                evp[name].append(flds)
            boost_sigs = set(e.loc[e.event == "BoostBuyAndBurnEvent", "signature"])
        b = _read(u, "B.csv.zst", ["slot", "block_time"])
        _wall(b, "B", u)
        parts["b"].append(pd.DataFrame({"slot": _int(b.slot), "block_time": _int(b.block_time)}))

        a = _read(u, "S_amm.csv.zst", AMM_COLS)
        _wall(a, "S_amm", u)
        head = pd.read_csv(os.path.join(r, "S_amm.csv.zst"), compression="zstd", nrows=0)
        if "top_program" not in head.columns:
            u.schema = 1
            v1.append((u.from_slot, u.to_slot))
        # all PumpSwap buys (fast class)
        # BOOST swaps (protocol = 0, no owner) are found by signature through E's BoostBuyAndBurnEvent
        a_boost = a.signature.isin(boost_sigs).to_numpy().astype(int)
        a_prot = _int(a.protocol, 0)
        if C.EXCLUDE_PROTOCOL_SWAPS:
            isb = ((a.side == "buy").to_numpy()) & (a_boost == 0) & (a_prot == 0)
        else:
            isb = (a.side == "buy").to_numpy()
        ab = a[isb]
        parts["buys"].append(pd.DataFrame({
            "slot": _int(ab.slot), "tx_idx": _int(ab.tx_idx), "ev_idx": _int(ab.ev_idx), "venue": 1,
            "mint": codec.encode(ab.base_mint), "owner": codec.encode(ab.user_token_owner),
            "sol": np.where(ab.quote_mint.isin(SOL_QUOTES).to_numpy(), _num(ab.quote_amount), np.nan)}))
        # canonical WSOL pool rows (universe, pool state, flow, holders)
        keep = ((a.canonical == "1") & (a.quote_mint == C.WSOL)).to_numpy().copy()
        if mig_pools is not None:
            keep &= a.pool.isin(mig_pools).to_numpy()
        k = a[keep]
        k_boost, k_prot = a_boost[keep], a_prot[keep]
        side = np.where((k.side == "buy").to_numpy(), 1, -1)
        tp = k.top_program
        parts["amm"].append(pd.DataFrame({
            "slot": _int(k.slot), "block_time": _int(k.block_time), "tx_idx": _int(k.tx_idx), "ev_idx": _int(k.ev_idx),
            "outer_ix": _int(k.outer_ix), "inner_ix": _int(k.inner_ix),
            "pool": codec.encode(k.pool), "mint": codec.encode(k.base_mint), "side": side,
            "base_amount": _int(k.base_amount, 0), "quote_amount": _int(k.quote_amount, 0),
            "quote_lp_adj": _int(k.quote_amount_lp_adjusted, 0), "user_quote": _int(k.user_quote_amount, 0),
            "base_before": _int(k.pool_base_token_reserves), "vault_before": _int(k.pool_quote_token_reserves),
            "virt": _int(k.virtual_quote_reserves, 0),
            "lp_bps": _int(k.lp_fee_basis_points, 0), "protocol_bps": _int(k.protocol_fee_basis_points, 0),
            "creator_bps": _int(k.coin_creator_fee_basis_points, 0), "coin_creator": codec.encode(k.coin_creator),
            "supply": _int(k.base_supply), "owner": codec.encode(k.user_token_owner),
            "signature": k.signature.to_numpy(), "boost": k_boost, "protocol": k_prot,
            "owner_pre": _int(k.owner_token_pre), "owner_post": _int(k.owner_token_post),
            # 1 = top-level instruction is neither PumpSwap nor pump (app-routed); -1 = unknown (schema v1)
            "app_routed": np.where(tp.isna().to_numpy(), -1,
                                   (~tp.isin([C.PUMPSWAP_PROGRAM, C.PUMP_PROGRAM])).to_numpy().astype(int)),
        }))
        del a, ab, k

        c = _read(u, "S_curve.csv.zst", CURVE_COLS)
        _wall(c, "S_curve", u)
        sol_curve = (c.quote_mint.isna() | c.quote_mint.isin(SOL_QUOTES)).to_numpy()
        mint_c = codec.encode(c.mint)
        owner_c = codec.encode(c.user_token_owner)
        is_buy = (c.is_buy == "1").to_numpy()
        c_proto = (_int(c.protocol, 0) != 0) | c.signature.isin(boost_sigs).to_numpy()
        b_keep = is_buy & ~c_proto if C.EXCLUDE_PROTOCOL_SWAPS else is_buy
        parts["buys"].append(pd.DataFrame({
            "slot": _int(c.slot)[b_keep], "tx_idx": _int(c.tx_idx)[b_keep], "ev_idx": _int(c.ev_idx)[b_keep],
            "venue": 0, "mint": mint_c[b_keep], "owner": owner_c[b_keep],
            "sol": np.where(sol_curve, _num(c.sol_amount), np.nan)[b_keep]}))
        parts["curve"].append(pd.DataFrame({
            "slot": _int(c.slot), "block_time": _int(c.block_time), "tx_idx": _int(c.tx_idx), "ev_idx": _int(c.ev_idx),
            "outer_ix": _int(c.outer_ix), "inner_ix": _int(c.inner_ix), "mint": mint_c, "is_buy": is_buy.astype(int),
            "sol_amount": _int(c.sol_amount, 0), "token_amount": _int(c.token_amount, 0), "fee": _int(c.fee, 0),
            "creator_fee": _int(c.creator_fee, 0), "sol_quote": sol_curve.astype(int),
            "mayhem": _int(c.mayhem_mode), "owner": owner_c,
            "owner_pre": _int(c.owner_token_pre), "owner_post": _int(c.owner_token_post)}))
        del c

        t = _read(u, "T.csv.zst", T_COLS)
        _wall(t, "T", u)
        parts["t"].append(pd.DataFrame({
            "slot": _int(t.slot), "tx_idx": _int(t.tx_idx), "outer_ix": _int(t.outer_ix), "inner_ix": _int(t.inner_ix),
            "mint": codec.encode(t.mint), "pump_mint": t.mint.fillna("").str.endswith("pump").to_numpy().astype(int),
            "kind": t.kind.map({"transfer": 0, "burn": 1, "mint": 2}).fillna(-1).astype(int).to_numpy(),
            "src": codec.encode(t.from_owner), "dst": codec.encode(t.to_owner), "amount": _int(t.amount, 0)}))
        del t

        w = _read(u, "W.csv.zst", W_COLS)
        if w is not None:
            _wall(w, "W", u)
            parts["w"].append(pd.DataFrame({"slot": _int(w.slot), "src": codec.encode(w["from"]), "dst": codec.encode(w["to"])}))
            del w

        f = _read(u, "F.csv.zst", F_COLS)
        if f is not None:
            _wall(f, "F", u)
            f = f[(f.venue == "pumpswap") & (f.side == "buy") & (f.err_class == "slippage")]
            parts["f"].append(pd.DataFrame({"slot": _int(f.slot), "block_time": _int(f.block_time),
                                            "pool": codec.encode(f.pool_or_curve)}))
        cf = _read(u, "CF.csv.zst", CF_COLS)
        if cf is not None:
            _wall(cf, "CF", u)
            parts["cf"].append(pd.DataFrame({"slot": _int(cf.slot), "block_time": _int(cf.block_time),
                                             "creator": codec.encode(cf.creator)}))


    def cat(name, cols=None, sort=("slot",)):
        if not parts[name]:
            return pd.DataFrame({c: pd.Series(dtype=np.int64) for c in (cols or ["slot"])})
        df = pd.concat(parts[name], ignore_index=True)
        parts[name] = []
        if name not in ("amm",):
            df = _down(df)
        return df.sort_values(list(sort), kind="mergesort").reset_index(drop=True)

    b = cat("b").drop_duplicates("slot")
    amm = cat("amm", sort=("slot", "tx_idx", "ev_idx"))
    if len(amm):
        amm["base_after"] = amm.base_before - amm.side * amm.base_amount
        amm["vault_after"] = amm.vault_before + amm.side * amm.quote_lp_adj
    ev = {}
    for name in E_EVENTS:
        ev[name] = _code_events(name, evp[name], codec)
    tape = Tape(units=units, days=days, segs=segments(units), codec=codec, b=b, amm=amm,
                buys=cat("buys", sort=("slot", "tx_idx", "ev_idx")),
                curve=cat("curve", sort=("slot", "tx_idx", "ev_idx")),
                t=cat("t", sort=("slot", "tx_idx", "outer_ix", "inner_ix")),
                w=cat("w", ["slot", "src", "dst"]), f=cat("f", ["slot", "block_time", "pool"]),
                cf=cat("cf", ["slot", "block_time", "creator"]), ev=ev, schema_v1_slots=v1)
    tape.counts = {k: len(getattr(tape, k)) for k in ("b", "amm", "buys", "curve", "t", "w", "f", "cf")}
    tape.counts.update({f"E:{k}": len(v) for k, v in ev.items()})
    return tape


def _code_events(name: str, frames: list, codec: Codec) -> pd.DataFrame:
    spec = {
        "CreateEvent": ["mint", "creator", "user", "bonding_curve", "is_mayhem_mode", "quote_mint", "token_program",
                        "is_cashback_enabled"],
        "CompletePumpAmmMigrationEvent": ["mint", "pool", "bonding_curve", "quote_mint"],
        "CreatePoolEvent": ["pool", "base_mint", "quote_mint", "is_mayhem_mode", "pool_quote_amount", "pool_base_amount"],
        "InitBoostEvent": ["pool", "mint"],
        "BoostBuyAndBurnEvent": ["pool", "mint", "boost_vault_remaining"],
        "CompleteEvent": ["mint"],
        "DepositEvent": ["pool", "lp_token_amount_out"],
        "WithdrawEvent": ["pool", "lp_token_amount_in"],
        "ExtendAccountEvent": ["account", "new_size"],
    }[name]
    if not frames:
        return pd.DataFrame({c: pd.Series(dtype=np.int64) for c in ["slot", "signature"] + spec})
    df = pd.concat(frames, ignore_index=True)
    for c in spec:
        if c not in df.columns:
            df[c] = np.nan
    out = pd.DataFrame({"slot": df.slot.astype(np.int64).to_numpy(), "signature": df.signature.to_numpy()})
    for c in spec:
        if c in _NUMERIC_EVENT_FIELDS:
            out[c] = _int(df[c])
        elif c in ("quote_mint", "token_program"):
            out[c] = df[c].to_numpy()
        else:
            out[c] = codec.encode(df[c])
    return out.sort_values("slot", kind="mergesort").reset_index(drop=True)


def manifest(tape: Tape) -> dict:
    return {"units": [f"{u.day}/{u.from_slot}-{u.to_slot} v{u.schema}" for u in tape.units], "days": list(tape.days),
            "segments": tape.segs, "counts": tape.counts, "schema_v1_slots": tape.schema_v1_slots}


def dump_json(obj, path):
    with open(path, "w") as fh:
        json.dump(obj, fh, indent=1, default=str)
