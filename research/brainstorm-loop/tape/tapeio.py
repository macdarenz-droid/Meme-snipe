"""Shared-tape loader for the Step A count rows. Reads only; computes no price change or return."""
from __future__ import annotations

import io
import json
import os
import re

import numpy as np
import pandas as pd

WSOL = "So11111111111111111111111111111111111111112"
SOL_NATIVE = "11111111111111111111111111111111"
SOL_QUOTES = (WSOL, SOL_NATIVE)


def unit_info(path: str):
    p = os.path.abspath(path)
    if os.path.basename(p) != "research":
        p = os.path.join(p, "research")
    m = re.search(r"(\d{4}-\d{2}-\d{2})/(\d+)-(\d+)/research$", p)
    if not m:
        raise ValueError(f"cannot read day and slot range from {path}")
    return p, m.group(1), int(m.group(2)), int(m.group(3))


def read_csv(p, name, cols=None):
    f = os.path.join(p, name + ".csv.zst")
    if not os.path.exists(f):
        return pd.DataFrame(columns=cols or [])
    head = pd.read_csv(f, compression="zstd", nrows=0).columns
    use = [c for c in (cols or head) if c in head]
    df = pd.read_csv(f, compression="zstd", usecols=use, dtype=str)
    for c in cols or []:
        if c not in df.columns:
            df[c] = pd.NA
    return df


def read_events(p, names):
    import zstandard

    f = os.path.join(p, "E.jsonl.zst")
    out = []
    if not os.path.exists(f):
        return out
    needles = tuple(f'"{n}"' for n in names)
    with open(f, "rb") as fh:
        for line in io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8"):
            if any(n in line for n in needles):
                j = json.loads(line)
                if j.get("event") in names:
                    out.append(j)
    return out


# ---------------------------------------------------------------- Step A plan check (for --decide)
DEFAULT_PLAN = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                             "shared-tape", "stepa-plan.txt"))
PLAN_DAYS = ("2026-09-11", "2026-09-10")


class PlanError(Exception):
    pass


def check_plan(ranges, plan_path=DEFAULT_PLAN, days=PLAN_DAYS):
    """Refuse unless the loaded (day, from, to) units equal the committed plan rows for `days` exactly and
    each day's slot ranges are contiguous. Returns the plan's sha256."""
    import hashlib

    with open(plan_path, "rb") as fh:
        raw = fh.read()
    sha = hashlib.sha256(raw).hexdigest()
    plan = set()
    for line in raw.decode().splitlines():
        f = line.split()
        if len(f) >= 4 and f[0] in days:
            plan.add((f[0], int(f[-2]), int(f[-1])))
    loaded = {(d, int(a), int(b)) for d, a, b in ranges}
    if not plan:
        raise PlanError(f"plan {plan_path} has no rows for {days}")
    if loaded != plan:
        raise PlanError(f"loaded units differ from the plan: missing {len(plan - loaded)}, extra {len(loaded - plan)}")
    for d in days:
        iv = sorted((a, b) for dd, a, b in loaded if dd == d)
        for (a0, b0), (a1, b1) in zip(iv, iv[1:]):
            if a1 != b0 + 1:
                raise PlanError(f"{d}: slots not contiguous between {b0} and {a1}")
    return sha


def _num(s):
    return pd.to_numeric(s, errors="coerce")


CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "user_token_owner", "mint", "is_buy",
              "sol_amount", "token_amount", "quote_mint", "protocol", "mayhem_mode", "creator",
              "owner_token_pre", "owner_token_post", "signer_sol_pre", "signer_sol_post",
              "fee", "creator_fee", "outer_ix", "inner_ix",
              "top_program", "jito_tip", "tx_fee", "cu", "virtual_sol_reserves", "virtual_token_reserves",
              "real_sol_reserves"]
AMM_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "user_token_owner", "base_mint", "pool",
            "side", "quote_amount", "base_amount", "quote_mint", "protocol", "canonical", "coin_creator",
            "pool_base_token_reserves", "pool_quote_token_reserves", "chain_pool_base", "chain_pool_quote",
            "virtual_quote_reserves", "base_supply", "owner_token_pre", "owner_token_post",
            "signer_sol_pre", "signer_sol_post",
            "quote_amount_lp_adjusted", "protocol_fee", "coin_creator_fee", "user_quote_amount", "outer_ix", "inner_ix",
            "top_program", "jito_tip", "tx_fee", "cu", "coin_creator_fee_basis_points"]


def swaps_from(curve: pd.DataFrame, amm: pd.DataFrame, boost_sigs: set, day: str, schema_v2: bool = True) -> pd.DataFrame:
    """One row per swap (curve and PumpSwap). `sol` is the quote amount in lamports where the quote is SOL.
    `excluded` marks BOOST (by BoostBuyAndBurnEvent signature) and protocol rows."""
    c = pd.DataFrame({
        "venue": "curve", "slot": curve["slot"], "block_time": curve["block_time"], "tx_idx": curve["tx_idx"],
        "ev_idx": curve["ev_idx"], "signature": curve["signature"], "signer": curve["signer"],
        "owner": curve["user_token_owner"], "mint": curve["mint"], "pool": pd.NA,
        "is_buy": curve["is_buy"].astype(str) == "1", "quote": curve["sol_amount"], "base": curve["token_amount"],
        "quote_mint": curve["quote_mint"].fillna(SOL_NATIVE), "protocol": curve["protocol"],
        "canonical": pd.NA, "mayhem": curve["mayhem_mode"], "creator": curve["creator"],
        "owner_token_pre": curve["owner_token_pre"], "owner_token_post": curve["owner_token_post"],
        "signer_sol_pre": curve["signer_sol_pre"], "signer_sol_post": curve["signer_sol_post"],
        "pool_base_pre": pd.NA, "pool_quote_pre": pd.NA, "pool_base_post": pd.NA, "pool_quote_post": pd.NA,
        "virtual_quote": pd.NA, "supply": pd.NA, "outer_ix": curve["outer_ix"], "inner_ix": curve["inner_ix"],
        # SOL paid with fees (buy) and SOL received after fees (sell), as H1-CGO's ledger counts them
        "cost": _num(curve["sol_amount"]) + _num(curve["fee"]).fillna(0) + _num(curve["creator_fee"]).fillna(0),
        "proceeds": _num(curve["sol_amount"]) - _num(curve["fee"]).fillna(0) - _num(curve["creator_fee"]).fillna(0),
        "top_program": curve["top_program"], "jito_tip": curve["jito_tip"], "tx_fee": curve["tx_fee"], "cu": curve["cu"],
        "lp_adj": pd.NA, "creator_fee_bps": pd.NA, "curve_vsol": curve["virtual_sol_reserves"],
        "curve_vtok": curve["virtual_token_reserves"], "curve_real_sol": curve["real_sol_reserves"],
    })
    a = pd.DataFrame({
        "venue": "amm", "slot": amm["slot"], "block_time": amm["block_time"], "tx_idx": amm["tx_idx"],
        "ev_idx": amm["ev_idx"], "signature": amm["signature"], "signer": amm["signer"],
        "owner": amm["user_token_owner"], "mint": amm["base_mint"], "pool": amm["pool"],
        "is_buy": amm["side"].astype(str) == "buy", "quote": amm["quote_amount"], "base": amm["base_amount"],
        "quote_mint": amm["quote_mint"], "protocol": amm["protocol"], "canonical": amm["canonical"],
        "mayhem": pd.NA, "creator": amm["coin_creator"],
        "owner_token_pre": amm["owner_token_pre"], "owner_token_post": amm["owner_token_post"],
        "signer_sol_pre": amm["signer_sol_pre"], "signer_sol_post": amm["signer_sol_post"],
        "pool_base_pre": amm["pool_base_token_reserves"], "pool_quote_pre": amm["pool_quote_token_reserves"],
        "pool_base_post": amm["chain_pool_base"], "pool_quote_post": amm["chain_pool_quote"],
        "virtual_quote": amm["virtual_quote_reserves"], "supply": amm["base_supply"],
        "outer_ix": amm["outer_ix"], "inner_ix": amm["inner_ix"],
        "cost": _num(amm["quote_amount_lp_adjusted"]).fillna(_num(amm["quote_amount"]))
        + _num(amm["protocol_fee"]).fillna(0) + _num(amm["coin_creator_fee"]).fillna(0),
        "proceeds": _num(amm["user_quote_amount"]).fillna(_num(amm["quote_amount"])),
        "top_program": amm["top_program"], "jito_tip": amm["jito_tip"], "tx_fee": amm["tx_fee"], "cu": amm["cu"],
        "lp_adj": amm["quote_amount_lp_adjusted"], "creator_fee_bps": amm["coin_creator_fee_basis_points"],
        "curve_vsol": pd.NA, "curve_vtok": pd.NA, "curve_real_sol": pd.NA,
    })
    s = pd.concat([c, a], ignore_index=True)
    for col in ("slot", "block_time", "tx_idx", "ev_idx"):
        s[col] = _num(s[col]).astype(np.int64)
    for col in ("quote", "base", "owner_token_pre", "owner_token_post", "signer_sol_pre", "signer_sol_post",
                "pool_base_pre", "pool_quote_pre", "pool_base_post", "pool_quote_post", "virtual_quote", "supply",
                "jito_tip", "tx_fee", "cu", "lp_adj", "creator_fee_bps", "curve_vsol", "curve_vtok", "curve_real_sol"):
        s[col] = _num(s[col]).astype("float64")
    for col in ("outer_ix", "inner_ix"):
        s[col] = _num(s[col]).fillna(-1).astype(np.int64)
    s["sol_quoted"] = s["quote_mint"].isin(SOL_QUOTES)
    s.loc[~s["sol_quoted"], ["cost", "proceeds"]] = np.nan
    s["sol"] = np.where(s["sol_quoted"], s["quote"], np.nan)
    s["canonical"] = _num(s["canonical"]).fillna(0).astype(int) == 1
    s["mayhem"] = _num(s["mayhem"])
    s["boost"] = s["signature"].isin(boost_sigs)
    s["excluded"] = s["boost"] | ~s["protocol"].fillna("0").astype(str).isin(["0", ""])
    s["day"] = day
    s["schema_v2"] = schema_v2      # the unit's S tables carry top_program (README: v1 units do not)
    return s


EVENT_NAMES = {"CreateEvent", "CompletePumpAmmMigrationEvent", "CreatePoolEvent", "BoostBuyAndBurnEvent",
               "CompleteEvent", "DepositEvent", "WithdrawEvent", "UpdateMayhemVirtualParamsEvent",
               "PostCompleteBuyEvent"}


# ---------------------------------------------------------------------------- compact reader
STR_COLS = {  # string columns kept as codes into one shared, sorted vocabulary (pandas categorical)
    "swaps": ["signer", "owner", "mint", "pool", "creator", "top_program", "quote_mint", "day", "venue"],
    "moves": ["mint", "kind", "from_owner", "to_owner"],
    "links": ["from_owner", "to_owner"],
    "w_links": ["from_owner", "to_owner"],
    "fails": ["venue", "pool_or_curve", "err_class", "day"],
}
DROP_SWAP_COLS = ["protocol", "quote"]       # used only while a unit is read (excluded, sol)
SMALL_INTS = {"tx_idx": np.int32, "ev_idx": np.int32, "outer_ix": np.int16, "inner_ix": np.int16}


def _trim():
    """Hand freed heap back to the system between units (glibc), so the reading peaks do not pile up."""
    import ctypes
    import gc
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass


def sig_hash(values) -> np.ndarray:
    """64-bit hash of transaction signatures (pandas' siphash), as int64. The compact reader keeps this instead of the
    88-character signature; signatures are only ever compared for equality (Q32)."""
    v = np.asarray(pd.Series(values, dtype=object).fillna(""), dtype=object)
    return pd.util.hash_array(v).view(np.int64)


class Interner:
    """Shared vocabulary for string columns across units: codes while reading, one sorted categorical at the end."""

    def __init__(self):
        self.code, self.words = {}, []

    def encode(self, series: pd.Series) -> np.ndarray:
        local, uniq = pd.factorize(series, use_na_sentinel=True)
        g = np.empty(len(uniq), dtype=np.int32)
        for i, w in enumerate(uniq):
            c = self.code.get(w)
            if c is None:
                c = self.code[w] = len(self.words)
                self.words.append(w)
            g[i] = c
        return np.where(local < 0, -1, g[local] if len(g) else -1).astype(np.int32)

    def finish(self):
        """Categorical dtype with the words in sorted order (so sorting a column sorts as strings), and the map
        from reading codes to final codes."""
        words = np.array(self.words, dtype=object)
        order = np.argsort(words, kind="stable") if len(words) else np.array([], dtype=np.int64)
        rank = np.empty(len(words), dtype=np.int32)
        rank[order] = np.arange(len(words), dtype=np.int32)
        return pd.CategoricalDtype(categories=pd.Index(list(words[order]), dtype=object)), rank


def compact_frame(df: pd.DataFrame, cols, it: Interner):
    for c in cols:
        if c in df.columns:
            df[c] = it.encode(df[c])
    return df


def finish_frame(df: pd.DataFrame, cols, dtype, rank):
    for c in cols:
        if c in df.columns:
            codes = df[c].to_numpy(np.int32)
            df[c] = pd.Categorical.from_codes(np.where(codes < 0, -1, rank[np.maximum(codes, 0)]), dtype=dtype)
    return df


class Tape:
    """Everything loaded from a list of unit directories. With compact=True (the default) string columns are held
    as codes into one shared vocabulary, signatures as 64-bit hashes, small integers narrowed and unused columns
    dropped, unit by unit, so a whole day fits in memory; results equal compact=False (tested)."""

    def __init__(self, paths, compact=True):
        swaps, t, w, cf, blocks, ev, fails = [], [], [], [], [], [], []
        self.ranges = []
        self.compact = compact
        it = Interner()
        unit_lo = []
        for path in paths:
            p, day, lo, hi = unit_info(path)
            e = read_events(p, EVENT_NAMES)
            for j in e:
                j["day"] = day
            ev += e
            boost = {j["signature"] for j in e if j["event"] == "BoostBuyAndBurnEvent"}
            f_amm = os.path.join(p, "S_amm.csv.zst")
            v2 = os.path.exists(f_amm) and "top_program" in pd.read_csv(f_amm, compression="zstd", nrows=0).columns
            swaps.append(swaps_from(read_csv(p, "S_curve", CURVE_COLS), read_csv(p, "S_amm", AMM_COLS), boost, day, v2))
            ff = read_csv(p, "F", ["slot", "block_time", "signature", "venue", "pool_or_curve", "err_class"])
            ff["day"] = day
            if compact:
                sw = swaps[-1].drop(columns=DROP_SWAP_COLS)
                sw["signature"] = sig_hash(sw["signature"])
                for c, d in SMALL_INTS.items():
                    sw[c] = sw[c].astype(d)
                # each unit sorted on its own: units hold disjoint slot ranges, so ordering the units by their first
                # slot and concatenating gives the same rows in the same order as one stable sort of everything
                sw = sw.sort_values(["slot", "tx_idx", "ev_idx"], kind="mergesort").reset_index(drop=True)
                swaps[-1] = compact_frame(sw, STR_COLS["swaps"], it)
                unit_lo.append(lo)
                ff["signature"] = sig_hash(ff["signature"])
                for c in ("slot", "block_time"):
                    ff[c] = _num(ff[c]).astype("Int64")
                ff = compact_frame(ff, STR_COLS["fails"], it)
            fails.append(ff)
            if compact:
                _trim()
            tt = read_csv(p, "T", ["slot", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner", "to_owner",
                                   "amount"])
            if compact:
                for col in ("slot", "tx_idx", "outer_ix", "inner_ix", "amount"):
                    tt[col] = _num(tt[col]).fillna(-1).astype(np.int64)
                tt = compact_frame(tt, STR_COLS["moves"], it)
            t.append(tt)
            ww = read_csv(p, "W", ["slot", "from", "to"]).rename(columns={"from": "from_owner", "to": "to_owner"})
            if compact:
                ww = ww.dropna(subset=["from_owner", "to_owner"])
                ww = ww[ww["from_owner"] != ww["to_owner"]]
                ww["slot"] = _num(ww["slot"]).astype(np.int64)
                ww = compact_frame(ww, STR_COLS["w_links"], it)
            w.append(ww)
            cff = read_csv(p, "CF", ["slot", "creator", "amount", "event"])
            cf.append(cff)
            b = read_csv(p, "B", ["slot", "block_time"])
            b["day"] = day
            blocks.append(b)
            self.ranges.append((day, lo, hi))
        if compact:
            dtype, rank = it.finish()
            self.vocab = dtype
            del it
            by_lo = [swaps[i] for i in np.argsort(np.array(unit_lo), kind="stable")]
            swaps.clear()
            one = pd.concat(by_lo, ignore_index=True)
            del by_lo
            finish_frame(one, STR_COLS["swaps"], dtype, rank)
            swaps = [one]
            del one
            _trim()
            t = [finish_frame(pd.concat(t, ignore_index=True), STR_COLS["moves"], dtype, rank)]
            w = [finish_frame(pd.concat(w, ignore_index=True), STR_COLS["w_links"], dtype, rank)]
            fails = [finish_frame(pd.concat(fails, ignore_index=True), STR_COLS["fails"], dtype, rank)]
        if compact:
            self.swaps = swaps[0]
        else:
            self.swaps = pd.concat(swaps, ignore_index=True).sort_values(["slot", "tx_idx", "ev_idx"], kind="mergesort")
            self.swaps = self.swaps.reset_index(drop=True)
        del swaps
        self.swaps["order"] = np.arange(len(self.swaps))
        tall = pd.concat(t, ignore_index=True)
        for col in ("slot", "tx_idx", "outer_ix", "inner_ix", "amount"):
            tall[col] = _num(tall[col]).fillna(-1).astype(np.int64)
        self.moves = tall          # T rows (transfer, mint, burn) for the cost ledger
        tall = tall[tall["kind"] == "transfer"]
        links = pd.concat([tall[["slot", "from_owner", "to_owner"]],
                           pd.concat(w, ignore_index=True)], ignore_index=True)
        links = links.dropna(subset=["from_owner", "to_owner"])
        links = links[links["from_owner"] != links["to_owner"]]
        links["slot"] = _num(links["slot"]).astype(np.int64)
        self.links = links.sort_values("slot", kind="mergesort").reset_index(drop=True)
        wl = pd.concat(w, ignore_index=True).dropna(subset=["from_owner", "to_owner"])
        wl = wl[wl["from_owner"] != wl["to_owner"]]
        wl["slot"] = _num(wl["slot"]).astype(np.int64)
        self.w_links = wl.reset_index(drop=True)      # W (SOL) links only, for MIG-SEAT's creator group
        self.fails = pd.concat(fails, ignore_index=True)
        for col in ("slot", "block_time"):
            self.fails[col] = _num(self.fails[col]).astype("Int64")
        self.cf = pd.concat(cf, ignore_index=True)
        self.blocks = pd.concat(blocks, ignore_index=True)
        self.blocks["slot"] = _num(self.blocks["slot"]).astype(np.int64)
        self.blocks["block_time"] = _num(self.blocks["block_time"]).astype(np.int64)
        self.blocks = self.blocks.sort_values("slot").reset_index(drop=True)
        self.events = ev
        self._index_events()
        if compact:   # event signatures hashed the same way as the swaps' and fails'
            for df in (self.pool_creates, self.boosts, self.reprices):
                df["signature"] = sig_hash(df["signature"]) if len(df) else df["signature"]
        self._intervals()

    # ------------------------------------------------------------------ events
    def _index_events(self):
        cr, mig, pools, boost, comp, lp, rep = [], [], [], [], [], [], []
        self.post_complete_buys = 0
        for j in self.events:
            f = j["fields"]
            base = {"slot": int(j["slot"]), "block_time": int(j["block_time"]), "day": j["day"]}
            if j["event"] == "CreateEvent":
                cr.append({**base, "mint": f.get("mint"), "creator": f.get("creator"), "user": f.get("user"),
                           "mayhem": _int(f.get("is_mayhem_mode")), "quote_mint": f.get("quote_mint")})
            elif j["event"] == "CompletePumpAmmMigrationEvent":
                mig.append({**base, "mint": f.get("mint"), "pool": f.get("pool"), "quote_mint": f.get("quote_mint")})
            elif j["event"] == "CreatePoolEvent":
                pools.append({**base, "pool": f.get("pool"), "base_mint": f.get("base_mint"),
                              "quote_mint": f.get("quote_mint"), "mayhem": _int(f.get("is_mayhem_mode")),
                              "coin_creator": f.get("coin_creator"), "creator": f.get("creator"),
                              "pool_quote_amount": _int(f.get("pool_quote_amount")),
                              "pool_base_amount": _int(f.get("pool_base_amount")), "signature": j.get("signature")})
            elif j["event"] == "BoostBuyAndBurnEvent":
                boost.append({**base, "mint": f.get("mint"), "pool": f.get("pool"),
                              "quote_used": _int(f.get("quote_amount_in_used")),
                              "quote_requested": _int(f.get("quote_amount_in_requested")), "signature": j.get("signature")})
            elif j["event"] == "CompleteEvent":
                comp.append({**base, "mint": f.get("mint")})
            elif j["event"] in ("DepositEvent", "WithdrawEvent"):
                sign = 1 if j["event"] == "DepositEvent" else -1
                amt = _int(f.get("lp_token_amount_out" if sign > 0 else "lp_token_amount_in")) or 0
                lp.append({**base, "pool": f.get("pool"), "lp_delta": sign * amt})
            elif j["event"] == "UpdateMayhemVirtualParamsEvent":
                rep.append({**base, "tx_idx": _int(j.get("tx_idx")), "signature": j.get("signature"), "mint": f.get("mint"),
                            **{k: _int(f.get(k)) for k in ("virtual_sol_reserves", "virtual_token_reserves",
                                                           "new_virtual_sol_reserves", "new_virtual_token_reserves",
                                                           "real_sol_reserves", "real_token_reserves")}})
            elif j["event"] == "PostCompleteBuyEvent":
                self.post_complete_buys += 1
        self.creates = pd.DataFrame(cr, columns=["slot", "block_time", "day", "mint", "creator", "user", "mayhem",
                                                 "quote_mint"]).drop_duplicates("mint")
        self.migrations = pd.DataFrame(mig, columns=["slot", "block_time", "day", "mint", "pool",
                                                     "quote_mint"]).drop_duplicates("pool")
        self.pool_creates = pd.DataFrame(pools, columns=["slot", "block_time", "day", "pool", "base_mint", "quote_mint",
                                                         "mayhem", "coin_creator", "creator", "pool_quote_amount",
                                                         "pool_base_amount", "signature"]).drop_duplicates("pool")
        self.boosts = pd.DataFrame(boost, columns=["slot", "block_time", "day", "mint", "pool", "quote_used",
                                                   "quote_requested", "signature"])
        self.completes = pd.DataFrame(comp, columns=["slot", "block_time", "day", "mint"]).drop_duplicates("mint")
        self.lp_moves = pd.DataFrame(lp, columns=["slot", "block_time", "day", "pool", "lp_delta"])
        self.reprices = pd.DataFrame(rep, columns=["slot", "block_time", "day", "tx_idx", "signature", "mint",
                                                   "virtual_sol_reserves", "virtual_token_reserves",
                                                   "new_virtual_sol_reserves", "new_virtual_token_reserves",
                                                   "real_sol_reserves", "real_token_reserves"])

    def mayhem_of_mint(self, mint):
        """COUNT_ROWS_AMENDMENT_3: mayhem is the mint's flag, taken in order from its CreateEvent, then any curve
        trade of the mint (`mayhem_mode`), then the CreatePoolEvent of a pool with that base mint. None when
        none is on the tape. A 2B `base_supply` is never used to infer it. (Maps built once, then looked up.)"""
        if not hasattr(self, "_mayhem_maps"):
            cr = self.creates[self.creates["mayhem"].notna()].drop_duplicates("mint")
            cu = self.swaps[(self.swaps["venue"] == "curve") & self.swaps["mayhem"].notna()].drop_duplicates("mint")
            pc = self.pool_creates[self.pool_creates["mayhem"].notna()].drop_duplicates("base_mint")
            self._mayhem_maps = (dict(zip(cr["mint"], cr["mayhem"])), dict(zip(cu["mint"], cu["mayhem"])),
                                 dict(zip(pc["base_mint"], pc["mayhem"])))
        for mp in self._mayhem_maps:
            if mint in mp:
                return int(mp[mint])
        return None

    # ---------------------------------------------------------------- coverage
    def _intervals(self):
        iv = {}
        for d, a, b in sorted(self.ranges, key=lambda x: (x[0], x[1])):
            lst = iv.setdefault(d, [])
            if lst and a <= lst[-1][1] + 1:
                lst[-1][1] = max(lst[-1][1], b)
            else:
                lst.append([a, b])
        self.intervals = iv
        # block_time span of each contiguous interval, from B
        self.interval_times = {}
        for d, lst in iv.items():
            bd = self.blocks[self.blocks["day"] == d]
            for a, b in lst:
                x = bd[(bd["slot"] >= a) & (bd["slot"] <= b)]["block_time"]
                self.interval_times[(d, a, b)] = (int(x.min()), int(x.max())) if len(x) else (None, None)

    def covered(self, start_slot, end_time, end_slot=None):
        """True if one contiguous run of loaded units holds slot `start_slot` and reaches block_time
        `end_time` (and `end_slot` if given). Windows spanning days are never covered (Q3)."""
        for (d, a, b), (t0, t1) in self.interval_times.items():
            if a <= start_slot <= b and t1 is not None and t1 >= end_time and (end_slot is None or end_slot <= b):
                return True
        return False

    def covered_back(self, slot, start_time):
        for (d, a, b), (t0, t1) in self.interval_times.items():
            if a <= slot <= b and t0 is not None and t0 <= start_time:
                return True
        return False


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return None
