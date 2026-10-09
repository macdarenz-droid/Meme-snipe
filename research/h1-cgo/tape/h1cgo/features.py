"""§3–§5 universe, decision points and as-of features (CGO, coverage, eligibility, past returns).

Look-ahead: features at a decision slot d are computed by a stream that has applied exactly the rows with slot <= d
(`MintStream.advance`), and every lookup (pool state, past prices, unresolved marks, excluded owners) reads only what
the stream has applied. Forward returns live in outcomes.py, which this module never imports (a test checks it).
The decision schedule (whole UTC hours after migration) needs only the migration time and block times up to d.
"""
import bisect
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import tapeio
from .constants import (DEFAULT_KEY, H11_CANDLE_WINDOW_S, H11_CHASE_AFTER_S, H11_CHASE_MAX_ABOVE_BPS, H11_SPIKE_BPS,
                        BURN_OWNERS, D_SLOTS, FIRST_DECISION_AFTER_MIGRATION_S, HOLD_S, LAST_DECISION_AFTER_MIGRATION_S,
                        MIN_COVERAGE, MIN_EFFECTIVE_QUOTE_LAMPORTS, MIN_REAL_VAULT_LAMPORTS, PAST_RETURN_WINDOWS_S,
                        PROTOCOL_OWNERS, SECONDARY_HOLDS_S, SOL_CURVE_QUOTE, WSOL)
from . import habits as HB
from .ledger import Ledger
from .pumpswap import Pool, amm_post_state

CURVE_COLS = ["slot", "block_time", "tx_idx", "ev_idx", "outer_ix", "inner_ix", "mint", "is_buy", "sol_amount",
              "token_amount", "fee", "creator_fee", "user_token_owner", "owner_token_pre", "owner_token_post", "protocol", "quote_mint"]
AMM_COLS = ["slot", "block_time", "tx_idx", "signature", "ev_idx", "outer_ix", "inner_ix", "pool", "base_mint", "quote_mint", "side",
            "base_amount", "quote_amount", "quote_amount_lp_adjusted", "lp_fee", "protocol_fee", "coin_creator_fee",
            "user_quote_amount", "pool_base_token_reserves", "pool_quote_token_reserves", "virtual_quote_reserves",
            "base_supply", "coin_creator", "user_token_owner", "owner_token_pre", "owner_token_post", "canonical", "protocol",
            "last_in_tx", "chain_pool_quote", "lp_fee_basis_points", "protocol_fee_basis_points",
            "coin_creator_fee_basis_points"]
T_COLS = ["slot", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner", "to_owner", "amount"]
TCOV_COLS = ["mint", "scope", "slot", "reason", "count", "tx_idx"]


def _i(s, default=0):
    return int(s) if s not in ("", None) else default


def utc_day(t: int) -> str:
    return pd.Timestamp(int(t), unit="s", tz="UTC").strftime("%Y-%m-%d")


# ---------------------------------------------------------------- universe (§3)

def build_universe(creates: list, migrations: list, creation_days, pools_created: list = ()) -> tuple:
    """Pump coins created on a listed tape day (C row), SOL quote, not mayhem, not cashback, migrated to PumpSwap
    (G row). Returns (DataFrame, exclusion counts). Canonical/WSOL is checked later on the pool's own rows."""
    mig = {}
    for e in migrations:
        f = e["fields"]
        if f.get("mint") and f.get("pool") and f["mint"] not in mig:
            mig[f["mint"]] = (int(e["slot"]), int(e["block_time"]), f["pool"])
    # AMENDMENT_4 (H8 dust check): the bot's quoteAtMigration is the migration pool's CreatePoolEvent pool_quote_amount
    qmig, bmig = {}, {}
    for e in pools_created:
        f = e["fields"]
        if f.get("pool") and f.get("quote_mint") == WSOL and f["pool"] not in qmig:
            qmig[f["pool"]] = int(f["pool_quote_amount"])
            if f.get("pool_base_amount"):
                bmig[f["pool"]] = int(f["pool_base_amount"])  # H8_AMENDMENT_2 (H11 chase): the bot's migration price
    rows, why = [], {"created": 0, "not_creation_day": 0, "not_sol_quote": 0, "mayhem": 0, "cashback": 0,
                     "not_migrated": 0, "kept": 0}
    seen = set()
    for e in creates:
        if e.get("program") != "pump":
            continue
        f = e["fields"]
        m = f.get("mint")
        if not m or m in seen:
            continue
        seen.add(m)
        why["created"] += 1
        if utc_day(int(e["block_time"])) not in creation_days:
            why["not_creation_day"] += 1
        elif f.get("quote_mint", SOL_CURVE_QUOTE) not in (SOL_CURVE_QUOTE, WSOL):
            why["not_sol_quote"] += 1
        elif f.get("is_mayhem_mode", "0") not in ("0", "false", ""):
            why["mayhem"] += 1
        elif f.get("is_cashback_enabled", "0") not in ("0", "false", ""):
            why["cashback"] += 1
        elif m not in mig:
            why["not_migrated"] += 1
        else:
            why["kept"] += 1
            ms, mt, pool = mig[m]
            rows.append(dict(mint=m, create_slot=int(e["slot"]), create_time=int(e["block_time"]),
                             bonding_curve=f.get("bonding_curve", ""), mig_slot=ms, mig_time=mt, pool=pool,
                             token_program=f.get("token_program", ""), quote_at_migration=qmig.get(pool, float("nan")),
                             base_at_migration=bmig.get(pool, float("nan"))))
    cols = ["mint", "create_slot", "create_time", "bonding_curve", "mig_slot", "mig_time", "pool", "token_program",
            "quote_at_migration", "base_at_migration"]
    return pd.DataFrame(rows, columns=cols), why


# ---------------------------------------------------------------- clock and schedule (§2, §3, §6)

@dataclass
class Clock:
    """Block times by slot (B). `last_before(t)` = the last slot whose block_time < t."""
    slots: list
    times: list  # block_time per slot, non-decreasing

    @classmethod
    def from_blocks(cls, b: pd.DataFrame):
        b = b.assign(slot=b.slot.astype("int64"), block_time=b.block_time.astype("int64")).sort_values("slot")
        b = b.drop_duplicates("slot")
        t = b.block_time.tolist()
        for i in range(1, len(t)):  # block times are not strictly monotone on chain; keep a running max
            if t[i] < t[i - 1]:
                t[i] = t[i - 1]
        return cls(b.slot.tolist(), t)

    def last_before(self, t: int, lo_slot: int, hi_slot: int):
        """Last slot in [lo, hi] with block_time < t, if a block with block_time >= t also exists in [lo, hi]."""
        k = bisect.bisect_left(self.times, t)  # first index with time >= t
        if k >= len(self.slots) or self.slots[k] > hi_slot or k == 0:
            return None
        s = self.slots[k - 1]
        return s if s >= lo_slot else None

    def time_at(self, slot: int):
        """block_time of the last block at or before `slot`."""
        k = bisect.bisect_right(self.slots, slot)
        return self.times[k - 1] if k else None


def decision_points(u: pd.DataFrame, clock: Clock, intervals) -> pd.DataFrame:
    """Each whole UTC hour from migration + 60 min to migration + 24 h, with its decision slot (the last slot before
    the hour) inside the contiguous tape interval that holds the coin's creation (so its whole holder history is read).
    Hours whose decision slot cannot be placed in that interval are not decision points (counted by the caller)."""
    rows = []
    for r in u.itertuples(index=False):
        iv = tapeio.interval_of(intervals, r.create_slot)
        if iv is None:
            continue
        h0 = math.ceil((r.mig_time + FIRST_DECISION_AFTER_MIGRATION_S) / 3600) * 3600
        for h in range(h0, r.mig_time + LAST_DECISION_AFTER_MIGRATION_S + 1, 3600):
            d = clock.last_before(h, max(iv[0], r.mig_slot), iv[1])
            if d is None:
                continue
            rows.append(dict(mint=r.mint, pool=r.pool, hour=h, decision_slot=d, decision_day=utc_day(h),
                             interval_end=iv[1], token_program=getattr(r, "token_program", ""),
                             quote_at_migration=getattr(r, "quote_at_migration", float("nan")), mig_time=r.mig_time))
    cols = ["mint", "pool", "hour", "decision_slot", "decision_day", "interval_end", "token_program", "quote_at_migration",
            "mig_time"]
    return pd.DataFrame(rows, columns=cols)


def schedule_windows(dp: pd.DataFrame, clock: Clock) -> pd.DataFrame:
    """Entry slot = decision slot + D; exit slot for each hold = (last slot before entry time + hold) + D.
    `in_time_<hold>` is False when that exit slot is after the last slot read (§2: dropped by time, before any
    outcome is read). Reads block times only, never prices."""
    out = dp.copy()
    out["entry_slot"] = out.decision_slot + D_SLOTS
    holds = sorted({HOLD_S, *SECONDARY_HOLDS_S})
    for h in holds:
        ex, ok = [], []
        for r in out.itertuples(index=False):
            te = clock.time_at(r.entry_slot) if r.entry_slot <= r.interval_end else None
            s = clock.last_before(te + h, r.entry_slot, r.interval_end) if te is not None else None
            e = s + D_SLOTS if s is not None else -1
            ex.append(e)
            ok.append(s is not None and e <= r.interval_end)
        out[f"exit_slot_{h}"] = ex
        out[f"in_time_{h}"] = ok
    # AMENDMENT_3 gate rows: flows in the hour after the decision, slots (decision slot, last slot before hour + 60 min]
    fe = [clock.last_before(r.hour + HOLD_S, r.decision_slot, r.interval_end) for r in out.itertuples(index=False)]
    out["flow_end_slot"] = [x if x is not None else -1 for x in fe]
    out["in_time_flow"] = [x is not None for x in fe]
    return out


# ---------------------------------------------------------------- per-mint as-of stream (§4)

def _key(slot, tx, outer, inner, ev):
    return (int(slot), _i(tx), _i(outer), _i(inner, -1), _i(ev, -1))


@dataclass
class MintStream:
    mint: str
    pool: str
    mig_slot: int
    excluded: dict  # owner -> type (bonding_curve, pool, burn, protocol)
    events: list  # sorted [(key, kind, payload)]
    pool_rows: list  # sorted [(key, block_time, pre, post)] for the coin's canonical pool
    unresolved: list  # sorted slots of T_coverage 'unresolved' marks for this mint
    habits: object = None  # habits.Habits (AMENDMENT_3 D60); None gives NaN D60
    ledger: Ledger = field(default_factory=Ledger)
    open_time: dict = field(default_factory=dict)  # owner -> block time their current position opened
    vol_t: list = field(default_factory=list)  # every applied pool trade: block time
    vol_cum: list = field(default_factory=list)  # and the cumulative SOL volume through it
    i: int = 0
    j: int = 0
    applied_slot: int = -1
    hist_t: list = field(default_factory=list)
    hist_mid: list = field(default_factory=list)
    init_mid: float = None
    state: Pool = None
    owner_checks: int = 0
    owner_mismatch: int = 0
    protocol_rows: int = 0
    bad_pool: bool = False
    # H8_AMENDMENT_2 gates, as of the applied slot
    mig_time: int = 0
    mig_price: tuple = None  # (quote, base) of the migration pool at creation (CreatePoolEvent); None: not seen
    lp_events: list = field(default_factory=list)  # sorted [(slot, LP delta)]: deposits +, withdrawals -
    candles: list = field(default_factory=list)  # 1-minute candles [start, open, high, close], prices (quote, base)
    candles_partial: bool = False
    creator_fee_zero: bool = False
    _pending: dict = field(default_factory=dict)
    _tx: tuple = None

    def _flush(self):
        for o, post in self._pending.items():
            self.owner_checks += 1
            self.owner_mismatch += int(self.ledger.balance(o) != post)
        self._pending = {}

    def _apply(self, key, kind, p):
        tx = key[:2]
        if tx != self._tx:
            self._flush()
            self._tx = tx
        L = self.ledger
        if kind in ("curve", "amm"):
            owner, buy, tokens, cost, protocol, post, pre, bt = p
            if protocol:
                self.protocol_rows += 1
                if owner:
                    self.excluded.setdefault(owner, "protocol")
                return
            if not owner:  # boost buy-and-burn (tokens burned); other empty owners mark the mint unresolved in T_coverage
                return
            if buy:
                L.buy(owner, tokens, cost, post_migration=(kind == "amm"))
            else:
                L.sell(owner, tokens)
            if pre != "" and post != "":  # positions as habits.events_from defines them
                if buy and pre == "0" and post != "0":
                    self.open_time[owner] = bt
                elif not buy and post == "0":
                    self.open_time.pop(owner, None)
            if post != "":
                self._pending[owner] = int(post)
        else:
            k, frm, to, amt = p
            if k == "transfer":
                if frm and to:  # rows with an empty owner are left out (historical-data.md, holder rebuild)
                    L.transfer(frm, to, amt)
                    if L.balance(frm) == 0:  # a position emptied by transfer has ended: its open no longer applies
                        self.open_time.pop(frm, None)
            elif k == "burn":
                if frm:
                    L.burn(frm, amt)
                    if L.balance(frm) == 0:
                        self.open_time.pop(frm, None)
            elif k == "mint":
                if to:
                    L.mint(to, amt)

    def advance(self, slot: int):
        """Apply every row with slot <= `slot`, and nothing later."""
        if slot < self.applied_slot:
            raise ValueError("the stream only moves forward")
        ev = self.events
        while self.i < len(ev) and ev[self.i][0][0] <= slot:
            self._apply(*ev[self.i])
            self.i += 1
        self._flush()
        pr = self.pool_rows
        while self.j < len(pr) and pr[self.j][0][0] <= slot:
            _, bt, pre, post, good, vol, cfz = pr[self.j]
            self.creator_fee_zero = cfz
            self._candle(bt, pre, post)
            self.vol_t.append(bt)
            self.vol_cum.append((self.vol_cum[-1] if self.vol_cum else 0) + vol)
            self.bad_pool = self.bad_pool or not good  # canonical SOL pool of this coin, from applied rows
            if self.init_mid is None and pre.base > 0:
                self.init_mid = pre.mid()
            if post.base > 0:
                self.hist_t.append(bt)
                self.hist_mid.append(post.mid())
            self.state = post
            self.j += 1
        self.applied_slot = slot

    def _candle(self, t: int, pre, post):
        """producer.ts #addTrade: 1-minute candles of pre- and post-trade prices on effective reserves."""
        if pre.base <= 0 or post.base <= 0 or pre.eff <= 0 or post.eff <= 0:
            self.candles_partial = True
            return
        a, b = (pre.eff, pre.base), (post.eff, post.base)
        start = t - t % 60
        cs = self.candles
        if cs and start < cs[-1][0]:  # out of order: the candles can no longer be proven complete
            self.candles_partial = True
            return
        hi = lambda x, y: x if x[0] * y[1] >= y[0] * x[1] else y
        if cs and cs[-1][0] == start:
            cs[-1] = [start, cs[-1][1], hi(hi(cs[-1][2], a), b), b]
        else:
            cs.append([start, a, hi(a, b), b])

    def h11(self, now: int) -> tuple:
        """hard.ts h11 as of `now`: (spike reject, U2 chase reject). Partial candles refuse both (fail closed)."""
        if self.candles_partial or not self.candles:
            return True, True
        above = lambda x, y, bps: x[0] * y[1] * 10_000 > y[0] * x[1] * (10_000 + bps)
        known = [k for k in self.candles if k[0] <= now]
        spike = any(k[0] + 60 > now - H11_CANDLE_WINDOW_S and above(k[2], k[1], H11_SPIKE_BPS) for k in known)
        at = self.mig_time + H11_CHASE_AFTER_S
        last = None
        for k in known:
            if k[0] + 60 <= at and (last is None or k[0] > last[0]):
                last = k
        if self.mig_price is None or last is None or last[0] + 60 <= self.mig_time:
            chase = True  # no migration price, or no candle between migration and +5 min (H16 not-covered)
        else:
            chase = above(last[3], self.mig_price, H11_CHASE_MAX_ABOVE_BPS)
        return spike, chase

    def mid_before(self, t: int):
        """Mid as of the last applied trade with block_time < t; before the first trade, the initial pool mid."""
        k = bisect.bisect_left(self.hist_t, t)
        return self.hist_mid[k - 1] if k else self.init_mid

    def snapshot(self, hour: int) -> dict:
        """Features as of the applied slot (§4, §5b)."""
        kt = kc = ut = 0
        pk = pc = 0
        excl = {"bonding_curve": 0, "pool": 0, "burn": 0, "protocol": 0}
        n_hold = 0
        holders = []
        for o, x in self.ledger.h.items():
            if x.total == 0:
                continue
            typ = self.excluded.get(o)
            if typ:
                excl[typ] += x.total
                continue
            n_hold += 1
            holders.append((o, x.total))
            kt += x.known
            kc += x.cost
            ut += x.unknown
            if x.bought_post and not x.bought_pre:
                pk += x.post_known
                pc += x.post_cost
        tot = kt + ut
        s = self.state
        out = dict(bad_pool=self.bad_pool, n_holders=n_hold, known_tokens=kt, known_cost=kc, unknown_tokens=ut,
                   coverage=(kt / tot) if tot else float("nan"),
                   rp=(kc / kt) if kt else float("nan"), rp_post=(pc / pk) if pk else float("nan"),
                   excl_curve=excl["bonding_curve"], excl_pool=excl["pool"], excl_burn=excl["burn"],
                   excl_protocol=excl["protocol"], protocol_rows=self.protocol_rows,
                   overdraw_events=self.ledger.overdraw_events, owner_checks=self.owner_checks,
                   owner_mismatch=self.owner_mismatch,
                   unresolved=bool(self.unresolved) and self.unresolved[0] <= self.applied_slot)
        if s is None or s.base <= 0:
            out.update(has_state=False, eff_quote=float("nan"), vault=float("nan"), p=float("nan"))
        else:
            out.update(has_state=True, eff_quote=s.eff, vault=s.vault, p=s.mid())
        p = out["p"]
        out["cgo"] = (p - out["rp"]) / p if out["has_state"] and kt else float("nan")
        out["cgo_post"] = (p - out["rp_post"]) / p if out["has_state"] and pk else float("nan")
        for w in PAST_RETURN_WINDOWS_S:
            m = self.mid_before(hour - w) if out["has_state"] else None
            out[f"r_{w // 3600}h"] = (p / m - 1) if m else float("nan")
        out["r_mig"] = (p / self.init_mid - 1) if out["has_state"] and self.init_mid else float("nan")
        # AMENDMENT_3 controls: past-hour volatility of trade mids (std of log changes) and SOL volume
        lo = bisect.bisect_left(self.hist_t, hour - 3600)
        mids = self.hist_mid[max(lo - 1, 0):]
        out["vol_1h"] = float(np.std(np.diff(np.log(mids)))) if len(mids) > 2 else 0.0
        k = bisect.bisect_left(self.vol_t, hour - 3600)
        out["volume_1h"] = (self.vol_cum[-1] - (self.vol_cum[k - 1] if k else 0)) if self.vol_cum else 0
        spike, chase = self.h11(hour)
        k = bisect.bisect_right([x[0] for x in self.lp_events], self.applied_slot)
        out.update(age_s=hour - self.mig_time, h11_spike=spike, h11_chase_reject=chase,
                   h6_lp_outstanding=sum(x[1] for x in self.lp_events[:k]), creator_fee_zero=self.creator_fee_zero)
        if self.habits is None:
            out.update(d60=float("nan"), d60_traceable=float("nan"), d60_holders=n_hold, d60_habit_holders=0)
        else:
            out.update(HB.d60(holders, self.open_time, self.habits, self.applied_slot, hour))
        return out


boost_keys = tapeio.boost_keys


def build_streams(u: pd.DataFrame, curve: pd.DataFrame, amm: pd.DataFrame, t: pd.DataFrame, tcov: pd.DataFrame,
                  boosts: set = frozenset(), habits=None, lp_events: dict = None):
    """One MintStream per universe coin, from the coin's rows only. A PumpSwap row is protocol flow when the tape flags
    it (`protocol`) or when it matches a BoostBuyAndBurnEvent (`boosts`); protocol rows never enter the holders."""
    ev = {m: [] for m in u.mint}
    add_curve(ev, curve)
    pool_of = dict(zip(u.pool, u.mint))
    prow = {m: [] for m in u.mint}
    add_amm(ev, prow, pool_of, amm, boosts)
    add_t(ev, t)
    return make_streams(u, ev, prow, unresolved_of(u, tcov), habits, lp_events)


def add_curve(ev: dict, curve: pd.DataFrame):
    for r in curve.itertuples(index=False):
        if r.mint not in ev:
            continue
        cost = int(r.sol_amount) + int(r.fee) + int(r.creator_fee)  # SOL paid, fees included
        ev[r.mint].append((_key(r.slot, r.tx_idx, r.outer_ix, r.inner_ix, r.ev_idx), "curve",
                           (r.user_token_owner, r.is_buy == "1", int(r.token_amount), cost,
                            r.protocol not in ("", "0"), r.owner_token_post, r.owner_token_pre, int(r.block_time))))


def add_amm(ev: dict, prow: dict, pool_of: dict, amm: pd.DataFrame, boosts=frozenset()):
    for r in amm.to_dict("records"):
        m = pool_of.get(r["pool"])
        if m is None:
            continue
        good = r["canonical"] == "1" and r["quote_mint"] == WSOL and r["base_mint"] == m
        key = _key(r["slot"], r["tx_idx"], r["outer_ix"], r["inner_ix"], r["ev_idx"])
        pre, post = amm_post_state(r)
        buy = r["side"] == "buy"
        vol = int(r["quote_amount_lp_adjusted"]) if buy else int(r["quote_amount"])
        cfz = r["coin_creator"] == DEFAULT_KEY or r["coin_creator_fee_basis_points"] == "0"
        prow[m].append((key, int(r["block_time"]), pre, post, good, vol, cfz))
        cost = int(r["quote_amount_lp_adjusted"]) + int(r["protocol_fee"]) + int(r["coin_creator_fee"]) if buy else 0
        ev[m].append((key, "amm", (r["user_token_owner"], buy, int(r["base_amount"]), cost,
                                   r["protocol"] not in ("", "0")
                                   or (r["signature"], r["outer_ix"], r["pool"]) in boosts, r["owner_token_post"],
                                   r["owner_token_pre"], int(r["block_time"]))))


def add_t(ev: dict, t: pd.DataFrame):
    for r in t.itertuples(index=False):
        if r.mint in ev:
            ev[r.mint].append((_key(r.slot, r.tx_idx, r.outer_ix, r.inner_ix, -1), "t",
                               (r.kind, r.from_owner, r.to_owner, int(r.amount))))


def unresolved_of(u: pd.DataFrame, tcov: pd.DataFrame) -> dict:
    unres = {m: [] for m in u.mint}
    for r in tcov.itertuples(index=False):
        if r.mint in unres and r.scope == "unresolved" and r.slot != "":
            unres[r.mint].append(int(r.slot))
    return unres


def make_streams(u: pd.DataFrame, ev: dict, prow: dict, unres: dict, habits=None, lp_events: dict = None) -> dict:
    streams = {}
    for r in u.itertuples(index=False):
        excl = {o: "burn" for o in BURN_OWNERS}
        excl.update({o: "protocol" for o in PROTOCOL_OWNERS})
        if r.bonding_curve:
            excl[r.bonding_curve] = "bonding_curve"
        excl[r.pool] = "pool"
        streams[r.mint] = MintStream(r.mint, r.pool, r.mig_slot, excl, sorted(ev[r.mint], key=lambda x: x[0]),
                                     sorted(prow[r.mint], key=lambda x: x[0]), sorted(unres[r.mint]), habits,
                                     mig_time=int(r.mig_time), mig_price=_mig_price(r),
                                     lp_events=sorted((lp_events or {}).get(r.pool, [])))
    return streams


def _mig_price(r):
    q, b = getattr(r, "quote_at_migration", float("nan")), getattr(r, "base_at_migration", float("nan"))
    return (int(q), int(b)) if q == q and b == b and q > 0 and b > 0 else None


def lp_events_of(events: list) -> dict:
    """H6: LP minted by deposits (+lp_token_amount_out) and burned by withdrawals (-lp_token_amount_in), per pool.
    Migration LP is burned, so a canonical pool starts at 0 outstanding."""
    out = {}
    for e in events:
        f = e["fields"]
        if e["event"] == "DepositEvent":
            out.setdefault(f["pool"], []).append((int(e["slot"]), int(f["lp_token_amount_out"])))
        elif e["event"] == "WithdrawEvent":
            out.setdefault(f["pool"], []).append((int(e["slot"]), -int(f["lp_token_amount_in"])))
    return out


def compute_features(dp: pd.DataFrame, streams: dict) -> pd.DataFrame:
    """Features for every decision point, each from its coin's stream advanced to the decision slot only."""
    out = []
    for m, g in dp.sort_values(["mint", "decision_slot"]).groupby("mint", sort=False):
        st = streams[m]
        for r in g.itertuples(index=False):
            st.advance(r.decision_slot)
            f = st.snapshot(r.hour)
            f.update(r._asdict())
            out.append(f)
    df = pd.DataFrame(out)
    if df.empty:
        return df
    df["ok_liquidity"] = df.has_state & (df.eff_quote >= MIN_EFFECTIVE_QUOTE_LAMPORTS) & (df.vault >= MIN_REAL_VAULT_LAMPORTS)
    df["ok_coverage"] = df.coverage >= MIN_COVERAGE
    df["eligible"] = df.ok_liquidity & df.ok_coverage & ~df.unresolved & ~df.bad_pool & df.cgo.notna()
    return df


# ---------------------------------------------------------------- loading

_E_NAMES = {"CreateEvent", "CompletePumpAmmMigrationEvent", "BoostBuyAndBurnEvent", "CreatePoolEvent", "DepositEvent",
            "WithdrawEvent"}


def _read_small(units):
    """E events, B and T_coverage of every unit (small tables), in unit order."""
    creates, migs, blocks, tcov, boosts, pcreated, lpev = [], [], [], [], set(), [], []
    for un in units:
        e = tapeio.read_events(un, _E_NAMES)
        pcreated += [x for x in e if x["event"] == "CreatePoolEvent"]
        lpev += [x for x in e if x["event"] in ("DepositEvent", "WithdrawEvent")]
        boosts |= boost_keys(e)
        creates += [x for x in e if x["event"] == "CreateEvent"]
        migs += [x for x in e if x["event"] == "CompletePumpAmmMigrationEvent"]
        blocks.append(tapeio.read_table(un, "B", ["slot", "block_time"]))
        tcov.append(tapeio.read_table(un, "T_coverage", TCOV_COLS))
    return creates, migs, blocks, tcov, boosts, pcreated, lpev


def _cat(fs, cols):
    return pd.concat(fs, ignore_index=True) if fs else pd.DataFrame(columns=cols)


def _with_boosts(a: pd.DataFrame, boosts) -> pd.DataFrame:
    """S_amm rows matching a BoostBuyAndBurnEvent are protocol flow (`protocol` = "1")."""
    return a.assign(protocol=a.protocol.where(~pd.Series([k in boosts for k in zip(a.signature, a.outer_ix, a.pool)],
                                                         index=a.index, dtype=bool), "1"))


def load(units, creation_days, log=print):
    """Read the tables the features need, filtered to the universe. Returns a dict of frames and diagnostics.
    (The direct reader: every universe row as strings. `run(..., lowmem=True)` holds the same rows compactly.)"""
    units = sorted(units, key=lambda x: x.from_slot)
    creates, migs, blocks, tcov, boosts, pcreated, lpev = _read_small(units)
    u, why = build_universe(creates, migs, set(creation_days), pcreated)
    mints, pools = set(u.mint), set(u.pool)
    curve, amm, tt, rte = [], [], [], []
    for un in units:
        c = tapeio.read_table(un, "S_curve", CURVE_COLS)
        rte.append(HB.events_from(c, "curve"))  # every coin's positions, for the D60 habits
        curve.append(c[c.mint.isin(mints)])
        a = _with_boosts(tapeio.read_table(un, "S_amm", AMM_COLS), boosts)
        rte.append(HB.events_from(a, "amm"))
        amm.append(a[a.pool.isin(pools)])
        x = tapeio.read_table(un, "T", T_COLS)
        tt.append(x[x.mint.isin(mints)])
        del c, a, x
        log(f"read {un.day} {un.from_slot}-{un.to_slot}")
    cat = _cat
    rt = HB.round_trips(pd.concat(rte, ignore_index=True)) if rte else HB.round_trips(pd.DataFrame())
    return dict(universe=u, universe_counts=why, boosts=boosts, round_trips=rt, lp_events=lp_events_of(lpev), blocks=cat(blocks, ["slot", "block_time"]),
                tcov=cat(tcov, TCOV_COLS), curve=cat(curve, CURVE_COLS), amm=cat(amm, AMM_COLS), t=cat(tt, T_COLS))


def run(units, decision_days, creation_days=None, log=print, lowmem=False) -> tuple:
    """Decision table with features and the time schedule, and diagnostics. `lowmem` reads the tape in chunks and
    holds the rows compactly (same outputs, byte for byte; tests/test_lowmem.py)."""
    creation_days = creation_days or decision_days
    if lowmem:
        return _run_lowmem(units, decision_days, creation_days, log)
    data = load(units, creation_days, log)
    clock = Clock.from_blocks(data["blocks"])
    iv = tapeio.coverage_intervals(units)
    dp = decision_points(data["universe"], clock, iv)
    n_all = len(dp)
    dp = dp[dp.decision_day.isin(set(decision_days))]
    dp = schedule_windows(dp, clock)
    streams = build_streams(data["universe"], data["curve"], data["amm"], data["t"], data["tcov"], data["boosts"],
                            HB.Habits(data["round_trips"]), data["lp_events"])
    feats = compute_features(dp, streams)
    diag = dict(units=[f"{x.day} {x.from_slot}-{x.to_slot}" for x in units], intervals=iv,
                universe=data["universe_counts"], decision_points_any_day=n_all, decision_points=len(dp),
                rows=dict(curve=len(data["curve"]), amm=len(data["amm"]), t=len(data["t"])),
                boost_events=len(data["boosts"]), round_trips=len(data["round_trips"]),
                protocol_rows=int(sum(st.protocol_rows for st in streams.values())))
    return feats, data["universe"], diag


# ---------------------------------------------------------------- low-memory reader (same outputs)

class _LazyStreams:
    """streams[m] for compute_features, built from the compact store when asked and retired when the next coin is
    asked (compute_features visits each coin once). Each stream gets exactly the rows the direct reader gives it,
    in the same order; rows after the coin's last decision slot are not held (advance never applies them)."""

    def __init__(self, u, store, pool_of, unres, habits, lp_events):
        self.u, self.store, self.pool_of, self.unres = u, store, pool_of, unres
        self.habits, self.lp_events = habits, lp_events
        self.cur, self.protocol_rows = None, 0

    def retire(self):
        st, self.cur = self.cur, None
        if st is not None:
            self.protocol_rows += st.protocol_rows
            st.events, st.pool_rows, st.ledger, st.hist_t, st.hist_mid = [], [], Ledger(), [], []
            st.vol_t, st.vol_cum, st.candles, st.open_time = [], [], [], {}

    def __getitem__(self, m):
        self.retire()
        ev, prow = {m: []}, {m: []}
        for f in self.store.frames("curve", m):
            add_curve(ev, f)
        for f in self.store.frames("amm", m):
            f["signature"] = ""  # boost matches are already folded into `protocol` (_with_boosts)
            add_amm(ev, prow, self.pool_of, f)
        for f in self.store.frames("t", m):
            add_t(ev, f)
        u1 = self.u[self.u.mint == m]
        self.cur = make_streams(u1, ev, prow, {m: self.unres[m]}, self.habits, self.lp_events)[m]
        return self.cur


def _put_by_mint(store, table, df, mint, cut, cols):
    keep = df.slot.astype("int64").to_numpy() <= mint.map(cut).to_numpy(dtype=float, na_value=-1.0)
    if not keep.any():
        return
    d = df.loc[keep, cols]
    for m, g in d.groupby(mint[keep].to_numpy(), sort=False):
        store.put(table, m, g)


def _run_lowmem(units, decision_days, creation_days, log):
    from . import lowmem as LM
    given = list(units)
    units = sorted(units, key=lambda x: x.from_slot)
    creates, migs, blocks, tcov, boosts, pcreated, lpev = _read_small(units)
    u, why = build_universe(creates, migs, set(creation_days), pcreated)
    del creates, migs, pcreated
    blocks, tcov = _cat(blocks, ["slot", "block_time"]), _cat(tcov, TCOV_COLS)
    clock = Clock.from_blocks(blocks)
    del blocks
    iv = tapeio.coverage_intervals(units)
    dp = decision_points(u, clock, iv)
    n_all = len(dp)
    dp = dp[dp.decision_day.isin(set(decision_days))]
    dp = schedule_windows(dp, clock)
    cut = dp.groupby("mint").decision_slot.max().to_dict() if len(dp) else {}
    mints, pools, pool_of = set(u.mint), set(u.pool), dict(zip(u.pool, u.mint))
    strings = LM.Strings()
    store = LM.Store(strings)
    n = dict(curve=0, amm=0, t=0)
    rte = {k: [] for k in ("owner", "mint", "slot", "tx", "ev", "time", "open")}

    def add_events(parts):
        for e in parts:
            if not len(e):
                continue
            rte["owner"].append(strings.codes(e.owner.to_numpy(dtype=object)))
            rte["mint"].append(strings.codes(e.mint.to_numpy(dtype=object)))
            for k in ("slot", "tx", "ev", "time"):
                rte[k].append(e[k].to_numpy(dtype=np.int64))
            rte["open"].append((e.kind == "o").to_numpy())

    amm_keep = [c for c in AMM_COLS if c != "signature"]
    for un in units:
        for name, cols in (("S_curve", CURVE_COLS), ("S_amm", AMM_COLS)):
            opens, closes = [], []
            for c in tapeio.read_table_chunks(un, name, cols):
                venue = "curve" if name == "S_curve" else "amm"
                if venue == "amm":
                    c = _with_boosts(c, boosts)
                e = HB.events_from(c, venue)
                opens.append(e[e.kind == "o"])
                closes.append(e[e.kind == "c"])
                if venue == "curve":
                    c = c[c.mint.isin(mints)]
                    n["curve"] += len(c)
                    _put_by_mint(store, "curve", c, c.mint, cut, CURVE_COLS)
                else:
                    c = c[c.pool.isin(pools)]
                    n["amm"] += len(c)
                    _put_by_mint(store, "amm", c, c.pool.map(pool_of), cut, amm_keep)
                del c, e
            add_events(opens + closes)  # one events_from per unit and venue: opens, then closes (as the direct reader)
            del opens, closes
        for x in tapeio.read_table_chunks(un, "T", T_COLS):
            x = x[x.mint.isin(mints)]
            n["t"] += len(x)
            _put_by_mint(store, "t", x, x.mint, cut, T_COLS)
        log(f"read {un.day} {un.from_slot}-{un.to_slot} (store {store.nbytes() >> 20} MB, {len(strings.values)} strings)")
    cc = {k: (np.concatenate(v) if v else np.empty(0, dtype=bool if k == "open" else np.int64)) for k, v in rte.items()}
    del rte
    ro, rs, rh = LM.round_trips_codes(cc["owner"], cc["mint"], cc["slot"], cc["tx"], cc["ev"], cc["time"], cc["open"])
    del cc
    habits = LM.CompactHabits(ro, rs, rh, strings.code_of)
    streams = _LazyStreams(u, store, pool_of, unresolved_of(u, tcov), habits, lp_events_of(lpev))
    feats = compute_features(dp, streams)
    streams.retire()
    diag = dict(units=[f"{x.day} {x.from_slot}-{x.to_slot}" for x in given], intervals=iv,
                universe=why, decision_points_any_day=n_all, decision_points=len(dp),
                rows=dict(curve=n["curve"], amm=n["amm"], t=n["t"]),
                boost_events=len(boosts), round_trips=len(ro), protocol_rows=int(streams.protocol_rows))
    return feats, u, diag
