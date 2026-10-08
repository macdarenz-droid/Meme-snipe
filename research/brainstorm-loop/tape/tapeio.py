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


def _num(s):
    return pd.to_numeric(s, errors="coerce")


CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "user_token_owner", "mint", "is_buy",
              "sol_amount", "token_amount", "quote_mint", "protocol", "mayhem_mode", "creator",
              "owner_token_pre", "owner_token_post", "signer_sol_pre", "signer_sol_post"]
AMM_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "user_token_owner", "base_mint", "pool",
            "side", "quote_amount", "base_amount", "quote_mint", "protocol", "canonical", "coin_creator",
            "pool_base_token_reserves", "pool_quote_token_reserves", "chain_pool_base", "chain_pool_quote",
            "virtual_quote_reserves", "base_supply", "owner_token_pre", "owner_token_post",
            "signer_sol_pre", "signer_sol_post"]


def swaps_from(curve: pd.DataFrame, amm: pd.DataFrame, boost_sigs: set, day: str) -> pd.DataFrame:
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
        "virtual_quote": pd.NA, "supply": pd.NA,
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
    })
    s = pd.concat([c, a], ignore_index=True)
    for col in ("slot", "block_time", "tx_idx", "ev_idx"):
        s[col] = _num(s[col]).astype(np.int64)
    for col in ("quote", "base", "owner_token_pre", "owner_token_post", "signer_sol_pre", "signer_sol_post",
                "pool_base_pre", "pool_quote_pre", "pool_base_post", "pool_quote_post", "virtual_quote", "supply"):
        s[col] = _num(s[col]).astype("float64")
    s["sol_quoted"] = s["quote_mint"].isin(SOL_QUOTES)
    s["sol"] = np.where(s["sol_quoted"], s["quote"], np.nan)
    s["canonical"] = _num(s["canonical"]).fillna(0).astype(int) == 1
    s["mayhem"] = _num(s["mayhem"])
    s["boost"] = s["signature"].isin(boost_sigs)
    s["excluded"] = s["boost"] | ~s["protocol"].fillna("0").astype(str).isin(["0", ""])
    s["day"] = day
    return s


class Tape:
    """Everything loaded from a list of unit directories."""

    def __init__(self, paths):
        swaps, t, w, cf, blocks, ev = [], [], [], [], [], []
        self.ranges = []
        for path in paths:
            p, day, lo, hi = unit_info(path)
            e = read_events(p, {"CreateEvent", "CompletePumpAmmMigrationEvent", "CreatePoolEvent",
                                "BoostBuyAndBurnEvent"})
            for j in e:
                j["day"] = day
            ev += e
            boost = {j["signature"] for j in e if j["event"] == "BoostBuyAndBurnEvent"}
            swaps.append(swaps_from(read_csv(p, "S_curve", CURVE_COLS), read_csv(p, "S_amm", AMM_COLS), boost, day))
            tt = read_csv(p, "T", ["slot", "mint", "kind", "from_owner", "to_owner"])
            t.append(tt[tt["kind"] == "transfer"])
            ww = read_csv(p, "W", ["slot", "from", "to"]).rename(columns={"from": "from_owner", "to": "to_owner"})
            w.append(ww)
            cff = read_csv(p, "CF", ["slot", "creator", "amount", "event"])
            cf.append(cff)
            b = read_csv(p, "B", ["slot", "block_time"])
            b["day"] = day
            blocks.append(b)
            self.ranges.append((day, lo, hi))
        self.swaps = pd.concat(swaps, ignore_index=True).sort_values(["slot", "tx_idx", "ev_idx"], kind="mergesort")
        self.swaps = self.swaps.reset_index(drop=True)
        self.swaps["order"] = np.arange(len(self.swaps))
        links = pd.concat([pd.concat(t, ignore_index=True)[["slot", "from_owner", "to_owner"]],
                           pd.concat(w, ignore_index=True)], ignore_index=True)
        links = links.dropna(subset=["from_owner", "to_owner"])
        links = links[links["from_owner"] != links["to_owner"]]
        links["slot"] = _num(links["slot"]).astype(np.int64)
        self.links = links.sort_values("slot", kind="mergesort").reset_index(drop=True)
        self.cf = pd.concat(cf, ignore_index=True)
        self.blocks = pd.concat(blocks, ignore_index=True)
        self.blocks["slot"] = _num(self.blocks["slot"]).astype(np.int64)
        self.blocks["block_time"] = _num(self.blocks["block_time"]).astype(np.int64)
        self.blocks = self.blocks.sort_values("slot").reset_index(drop=True)
        self.events = ev
        self._index_events()
        self._intervals()

    # ------------------------------------------------------------------ events
    def _index_events(self):
        cr, mig, pools, boost = [], [], [], []
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
                              "coin_creator": f.get("coin_creator"), "creator": f.get("creator")})
            elif j["event"] == "BoostBuyAndBurnEvent":
                boost.append({**base, "mint": f.get("mint"), "pool": f.get("pool")})
        self.creates = pd.DataFrame(cr, columns=["slot", "block_time", "day", "mint", "creator", "user", "mayhem",
                                                 "quote_mint"]).drop_duplicates("mint")
        self.migrations = pd.DataFrame(mig, columns=["slot", "block_time", "day", "mint", "pool",
                                                     "quote_mint"]).drop_duplicates("pool")
        self.pool_creates = pd.DataFrame(pools, columns=["slot", "block_time", "day", "pool", "base_mint", "quote_mint",
                                                         "mayhem", "coin_creator", "creator"]).drop_duplicates("pool")
        self.boosts = pd.DataFrame(boost, columns=["slot", "block_time", "day", "mint", "pool"])

    def mayhem_of_mint(self, mint):
        """1/0 if known from CreateEvent, the pool's CreatePoolEvent or curve rows; None if unknown."""
        r = self.creates.loc[self.creates["mint"] == mint, "mayhem"]
        if len(r) and pd.notna(r.iloc[0]):
            return int(r.iloc[0])
        r = self.pool_creates.loc[self.pool_creates["base_mint"] == mint, "mayhem"]
        if len(r) and pd.notna(r.iloc[0]):
            return int(r.iloc[0])
        r = self.swaps.loc[(self.swaps["mint"] == mint) & self.swaps["mayhem"].notna(), "mayhem"]
        if len(r):
            return int(r.iloc[0])
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
        `end_time` (and `end_slot` if given). Windows spanning days are never covered (Q-COV)."""
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
