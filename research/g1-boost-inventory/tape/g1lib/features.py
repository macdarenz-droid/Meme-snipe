"""Decision-time features for the amendment arms, all as of slot t0 + D − 1 (amendment 1 "Feature R";
amendment 2 "State"). Every input is cut at the decision slot: holdings are replayed only to the cutoff, links and
buys are counted only at or before it, and rival curves are counted only from rows at or before each grid time.
"""
import math
import re
import unicodedata
from typing import Dict, Optional

import numpy as np
import pandas as pd

from . import params as P
from .graph import LinkGraph
from .holdings import mint_events, replay
from .load import Tape


def norm_name(s) -> str:
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKC", s).casefold()
    return re.sub(r"[\W_]+", "", s)


class FeatureContext:
    """Indexes built once per run. They hold full-tape rows, but every accessor below filters by the cutoff."""

    def __init__(self, tape: Tape, with_links: bool = True):
        self.tape = tape
        names = tape.names
        self.create_slot: Dict[int, int] = {}
        self.create_time: Dict[int, int] = {}
        self.creator_of: Dict[int, int] = {}
        self.name_of: Dict[int, tuple] = {}
        self.create_mayhem: Dict[int, bool] = {}
        ce = tape.events["CreateEvent"]
        for r in ce.sort_values("slot").itertuples(index=False):
            m = r.mint_c
            if m in self.create_slot:
                continue
            self.create_slot[m] = int(r.slot)
            self.create_time[m] = int(r.block_time)
            self.creator_of[m] = names.code(getattr(r, "creator", None))
            self.name_of[m] = (norm_name(getattr(r, "name", "")), norm_name(getattr(r, "symbol", "")))
            self.create_mayhem[m] = str(getattr(r, "is_mayhem_mode", "0")) == "1"
        mig = tape.events["CompletePumpAmmMigrationEvent"]
        self.mig_slot: Dict[int, int] = {}
        self.mig_time: Dict[int, int] = {}
        for r in mig.sort_values("slot").itertuples(index=False):
            self.mig_slot.setdefault(r.mint_c, int(r.slot))
            self.mig_time.setdefault(r.mint_c, int(r.block_time))
        # T rows by mint
        t = tape.T
        self.t_by_mint = {}
        if len(t):
            order = np.argsort(t["mint"].to_numpy(), kind="stable")
            keys = t["mint"].to_numpy()[order]
            change = np.flatnonzero(np.diff(keys)) + 1
            for s, e in zip(np.concatenate([[0], change]), np.concatenate([change, [len(keys)]])):
                self.t_by_mint[int(keys[s])] = order[s:e]
        self.graph: Optional[LinkGraph] = None
        if with_links:
            tt = t[t["kind"] == "transfer"] if len(t) else t
            src = np.concatenate([tape.W["src"].to_numpy(), tt["from_owner"].to_numpy()]).astype(np.int64)
            dst = np.concatenate([tape.W["dst"].to_numpy(), tt["to_owner"].to_numpy()]).astype(np.int64)
            sl = np.concatenate([tape.W["slot"].to_numpy(), tt["slot"].to_numpy()]).astype(np.int64)
            self.graph = LinkGraph(src, dst, sl, len(names.names))
        self._buys_index()
        self._rivals()

    # ---- amendment 1 group 4: serial early buyers --------------------------------------------------
    def _buys_index(self):
        b = self.tape.buys
        cs = pd.Series(self.create_slot)
        ms = pd.Series(self.mig_slot)
        mint = pd.Series(b["mint"].to_numpy())
        dc = b["slot"].to_numpy() - mint.map(cs).fillna(-10 ** 12).to_numpy()
        dm = b["slot"].to_numpy() - mint.map(ms).fillna(-10 ** 12).to_numpy()
        near = ((dc >= 0) & (dc <= P.HC_SERIAL_NEAR_SLOTS)) | ((dm >= 0) & (dm <= P.HC_SERIAL_NEAR_SLOTS))
        order = np.lexsort((b["slot"].to_numpy(), b["owner"].to_numpy()))
        self.b_owner = b["owner"].to_numpy()[order]
        self.b_slot = b["slot"].to_numpy()[order]
        self.b_cumnear = np.cumsum(near[order])
        # memory only: the same values held as int32 when they fit (slots < 2^31; a count of buys)
        if len(self.b_slot) and self.b_slot.max() <= np.iinfo(np.int32).max and self.b_slot.min() >= 0:
            self.b_slot = self.b_slot.astype(np.int32)
        if len(self.b_cumnear) and self.b_cumnear[-1] <= np.iinfo(np.int32).max:
            self.b_cumnear = self.b_cumnear.astype(np.int32)

    def serial(self, owner: int, cutoff: int) -> bool:
        """At least 5 buys on the tape before the slot, at least 10% of them within 2 slots after a create or
        migration of the bought mint."""
        a = np.searchsorted(self.b_owner, owner, "left")
        z = np.searchsorted(self.b_owner, owner, "right")
        if z <= a:
            return False
        k = a + np.searchsorted(self.b_slot[a:z], cutoff, "left")
        n = k - a
        if n < P.HC_SERIAL_MIN_BUYS:
            return False
        near = self.b_cumnear[k - 1] - (self.b_cumnear[a - 1] if a > 0 else 0)
        return near >= P.HC_SERIAL_NEAR_SHARE * n

    # ---- amendment 1: feature R ---------------------------------------------------------------------
    def holdings(self, mint: int, cutoff: int, bonding_curve: int, with_pool: bool = False):
        rows = self.tape.curve_of(mint)
        rows = rows[rows["slot"] <= cutoff]
        idx = self.t_by_mint.get(mint, np.empty(0, dtype=np.int64))
        t = self.tape.T.iloc[idx]
        t = t[t["slot"] <= cutoff]
        pool_rows = None
        if with_pool:
            pr = self._pool_rows_of_mint(mint)
            pool_rows = pr[pr["slot"] <= cutoff] if pr is not None else None
        ev = mint_events(rows, t, pool_rows)
        book, _ = replay(ev, cutoff, exclude=(bonding_curve,))
        return book, rows

    def _pool_rows_of_mint(self, mint: int):
        mig = self.tape.events["CompletePumpAmmMigrationEvent"]
        r = mig[mig["mint_c"] == mint]
        if not len(r):
            return None
        return self.tape.pool_of(int(r["pool_c"].iloc[0]))

    def feature_r(self, d: dict) -> dict:
        """R as of t0 + D − 1 (amendment 1). Needs the create row on a tape day read so far."""
        cutoff = int(d["t0"]) + P.D - 1
        mint = int(d["mint_c"])
        cslot = self.create_slot.get(mint)
        out = {"R": math.nan, "R_cluster": math.nan, "R_early": math.nan, "R_lowcost": math.nan, "R_serial": math.nan,
               "hc_coverage": math.nan, "hc_balance_coverage": math.nan, "hc_reason": ""}
        if cslot is None or cslot > cutoff:
            out["hc_reason"] = "created-before-tape"
            return out
        names = self.tape.names
        bc = names.get(d.get("bonding_curve") or "")
        book, rows = self.holdings(mint, cutoff, bc)
        holders = book.holders()
        base = sum(lt.tokens for lt in holders.values())
        sold_by_curve = P.INITIAL_REAL_TOKENS - int(rows["real_token_reserves"].iloc[-1])
        out["hc_coverage"] = (sum(lt.known for lt in holders.values()) / sold_by_curve) if sold_by_curve > 0 else math.nan
        out["hc_balance_coverage"] = (base / sold_by_curve) if sold_by_curve > 0 else math.nan
        if base <= 0:
            out["hc_reason"] = "no-holders"
            return out
        seeds = [names.get(d.get("creator") or ""), names.get(d.get("create_user") or "")]
        cluster = self.graph.cluster(seeds, cutoff) if self.graph is not None else set(s for s in seeds if s >= 0)
        price = float(d["price_t0"])
        g = {"cluster": set(), "early": set(), "lowcost": set(), "serial": set()}
        for o, lt in holders.items():
            if o in cluster:
                g["cluster"].add(o)
            fb = book.first_buy.get(o)
            if fb is not None and fb - cslot <= P.HC_EARLY_BUY_SLOTS:
                g["early"].add(o)
            if lt.known > 0 and (lt.cost / lt.known) <= P.HC_COST_FRACTION * price:
                g["lowcost"].add(o)
            if self.serial(o, cutoff):
                g["serial"].add(o)
        union = set().union(*g.values())
        out["R"] = sum(holders[o].tokens for o in union) / base
        for k, s in g.items():
            out["R_" + k] = sum(holders[o].tokens for o in s) / base
        return out

    # ---- amendment 2: N, lambda, Z --------------------------------------------------------------------
    def _rivals(self):
        tape = self.tape
        st, en, mm, cr, ss, es = [], [], [], [], [], []
        for mint, (a, b) in tape._curve_off.items():
            rows = tape.curve.iloc[a:b]
            q = rows["quote_mint"].to_numpy()
            if not (q == P.SOL_QUOTE_CURVE).any():
                continue
            real = rows["virtual_sol_reserves"].to_numpy() - P.INITIAL_VIRTUAL_SOL
            done = rows["real_token_reserves"].to_numpy() <= 0
            # mayhem as known at each row (create flag or any earlier row): a rival is counted only while known clean
            may = np.maximum.accumulate(np.nan_to_num(rows["mayhem_mode"].to_numpy(), nan=0.0)) > 0
            if self.create_mayhem.get(mint):
                may = may | (rows["slot"].to_numpy() >= self.create_slot[mint])
            on = (real >= P.CAP_RIVAL_REAL_SOL) & ~done & (q == P.SOL_QUOTE_CURVE) & ~may
            t = rows["block_time"].to_numpy()
            sl = rows["slot"].to_numpy()
            creator = self.creator_of.get(mint, int(rows["creator"].iloc[0]))
            edges = np.diff(np.concatenate([[0], on.astype(np.int8)]))
            for i in np.flatnonzero(edges != 0):
                if edges[i] > 0:
                    st.append(t[i]); en.append(np.inf); mm.append(mint); cr.append(creator)
                    ss.append(sl[i]); es.append(np.iinfo(np.int64).max)
                else:
                    en[-1] = t[i]
                    es[-1] = sl[i]
        self.iv_start = np.array(st, dtype=float)
        self.iv_end = np.array(en, dtype=float)
        self.iv_mint = np.array(mm, dtype=np.int64)
        self.iv_creator = np.array(cr, dtype=np.int64)
        self.iv_start_slot = np.array(ss, dtype=np.int64)
        self.iv_end_slot = np.array(es, dtype=np.int64)
        mig = tape.events["CompletePumpAmmMigrationEvent"]
        ms, mt, mc, msl = [], [], [], []
        for r in mig.itertuples(index=False):
            q = getattr(r, "quote_mint", None)
            if q != P.SOL_QUOTE_CURVE:
                continue
            m = r.mint_c
            rows = tape.curve_of(m)
            rows = rows[rows["slot"] <= int(r.slot)]
            if (rows["mayhem_mode"] == 1).any():
                continue
            ms.append(m); mt.append(int(r.block_time)); msl.append(int(r.slot)); mc.append(self.creator_of.get(m, int(rows["creator"].iloc[0]) if len(rows) else -1))
        self.mg_mint = np.array(ms, dtype=np.int64)
        self.mg_time = np.array(mt, dtype=float)
        self.mg_creator = np.array(mc, dtype=np.int64)
        self.mg_slot = np.array(msl, dtype=np.int64)

    def feature_z(self, d: dict, cluster=None) -> dict:
        tape = self.tape
        cutoff = int(d["t0"]) + P.D - 1
        mint = int(d["mint_c"])
        out = {"N": math.nan, "lam": math.nan, "Z": math.nan, "cap_reason": ""}
        s = tape.last_produced_at_or_before(cutoff)
        seg = tape.segment_of(int(d["t0"]))
        if s is None or seg is None:
            out["cap_reason"] = "no-time"
            return out
        t = float(tape.time_of(s))
        seg_start = tape.first_produced_at_or_after(seg[0])
        if seg_start is None or tape.time_of(seg_start) > t - P.CAP_LAMBDA_WINDOW_S:
            out["cap_reason"] = "trailing-hour-not-covered"
            return out
        if cluster is None:
            names = tape.names
            seeds = [names.get(d.get("creator") or ""), names.get(d.get("create_user") or "")]
            cluster = self.graph.cluster(seeds, cutoff) if self.graph is not None else set(x for x in seeds if x >= 0)
        cl = np.array(sorted(cluster), dtype=np.int64)
        grid = t - P.CAP_GRID_S * np.arange(P.CAP_LAMBDA_WINDOW_S // P.CAP_GRID_S)
        lo = grid[-1]
        # Rows count by slot (at or before the cutoff) as well as by block time: a later slot can share the cutoff's
        # block time (review finding 2). An interval is on at grid time g if its opening row is at or before the
        # cutoff and at or before g, and its closing row is not.
        iv = (self.iv_start_slot <= cutoff) & (self.iv_start <= t) & (self.iv_end > lo) & (self.iv_mint != mint) & ~np.isin(self.iv_creator, cl)
        started = self.iv_start[iv][None, :] <= grid[:, None]
        ended = (self.iv_end[iv][None, :] <= grid[:, None]) & (self.iv_end_slot[iv][None, :] <= cutoff)
        n_iv = (started & ~ended).sum(axis=1)
        mg = (self.mg_slot <= cutoff) & (self.mg_time <= t) & (self.mg_time >= lo - P.CAP_RECENT_MIGRATION_S) & (self.mg_mint != mint) & ~np.isin(self.mg_creator, cl)
        mt = self.mg_time[mg]
        n_mg = ((mt[None, :] <= grid[:, None]) & (mt[None, :] >= grid[:, None] - P.CAP_RECENT_MIGRATION_S)).sum(axis=1)
        N = (n_iv + n_mg).astype(float)
        out["N"], out["lam"] = N[0], N.mean()
        out["Z"] = N[0] - N.mean()
        # theme waves: the coin's normalised name or symbol matches another coin in the trailing hour (OQ-12)
        own = self.name_of.get(mint)
        if own is None or not (own[0] or own[1]):
            out["cap_reason"] = "name-unknown"
            return out
        others = set(self.iv_mint[iv].tolist()) | set(self.mg_mint[mg].tolist())
        others |= {m for m, ct in self.create_time.items() if lo <= ct <= t and self.create_slot[m] <= cutoff}
        others.discard(mint)
        for m in others:
            nm = self.name_of.get(m)
            if nm and ((own[0] and own[0] == nm[0]) or (own[1] and own[1] == nm[1])):
                out["cap_reason"] = "theme-wave"
                break
        return out


def compute_features(tape: Tape, d: pd.DataFrame, ctx: FeatureContext, log=print) -> pd.DataFrame:
    """R, N, lambda and Z for the primary G1 decisions in the universe (amendment arms only use those)."""
    rows = []
    sel = d[(d["kind"] == "G1") & (d["reason"] == "") & (~d["censored"])]
    for k, rec in enumerate(sel.to_dict("records")):
        cutoff = int(rec["t0"]) + P.D - 1
        names = tape.names
        seeds = [names.get(rec.get("creator") or ""), names.get(rec.get("create_user") or "")]
        cluster = ctx.graph.cluster(seeds, cutoff) if ctx.graph is not None else set(x for x in seeds if x >= 0)
        r = {"mint": rec["mint"], "kind": "G1", "cluster_size": len(cluster)}
        r.update(ctx.feature_r(rec))
        r.update(ctx.feature_z(rec, cluster))
        rows.append(r)
    log(f"  features: {len(rows)} primary decisions")
    f = pd.DataFrame(rows)
    if not len(f):
        return d.assign(**{c: np.nan for c in ("R", "Z", "N", "lam")})
    return d.merge(f, on=["mint", "kind"], how="left")
