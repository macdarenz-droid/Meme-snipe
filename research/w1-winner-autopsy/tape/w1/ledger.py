"""PREREG §4: P&L per owner, mint and day, mark-to-market in SOL (lamports), plus the raw inputs of §3 (transfer
edges) and §5 (buys). Units are read in slot order; per-unit work is vectorised, and only open positions are carried
from unit to unit.

Accounting (OPEN_QUESTIONS lists every reading this file makes where the design is silent):
- A swap credits or debits `user_token_owner` (historical-data.md), never the signer or `user`.
- cash: SOL received from sells minus SOL paid for buys, venue fees included (curve: sol_amount + fee + creator_fee +
  cashback; PumpSwap: user_quote_amount), minus the transaction's tx_fee + jito_tip split evenly over its swaps.
- A token transfer between owners is valued at the executable sell of the moved amount at that transaction's state:
  the sender books +value, the receiver -value and the value as SOL paid in, so a transfer adds no P&L. A burn
  loses the tokens at no value. A mint-to movement taints the position.
- Day P&L = cash + end mark - start mark. The end mark is the executable sell of the whole position at the day's last
  state (curve while it is live, else the canonical pool, else any SOL pool).
- A position whose start is not seen (a balance the tape did not build, i.e. one opened before the first day read or
  across a gap) is left out until it is seen at zero; so is any day on which its balance disagrees with the
  owner_token_pre/post the swaps report, or a movement had no venue state to value it."""
import numpy as np
import pandas as pd

from . import load
from .addr import BUYBACK_AUTHORITY, MAYHEM_VAULT, on_curve
from .costs import FIXED_PER_LEG, amendment_tx_cost, rent_candidates, signer_cash
from .venue import sell_vec

BIG_BUY = 1_000_000_000  # PREREG §5: a buy of at least 1 SOL
PAIR_SHIFT = 32


ACC_AGG = {"cash": "sum", "paid": "sum", "cash_alt": "sum", "paid_alt": "sum", "nsig": "sum", "cash_nc": "sum",
           "paid_nc": "sum", "ncap": "sum", "xin": "sum",
           "nbuy": "sum", "nsell": "sum", "dirty": "any", "dstart": "any", "dother": "any", "buykey": "min",
           "closekey": "max", "lastkey": "max", "lastslot": "max", "n": "sum", "end_ver": "last"}
ACC_COLS = list(ACC_AGG)
# columns a prep-only day leaves out: every cash, cost and valuation column (they are not computed in that mode)
PREP_DROP = {"rows": ("cash", "paid", "cash_alt", "paid_alt", "cash_nc", "paid_nc", "xin", "nsig", "ncap",
                      "start_mark", "end_mark"),
             "buys": ("paid",), "xfers": ("value",)}


def _acct(acct, pair):
    """Token account ids; a missing account becomes a pseudo-account private to its (owner, mint) pair."""
    acct = np.asarray(acct, np.int64)
    return np.where(acct >= 0, acct, -1 - np.asarray(pair, np.int64))


def pair_of(owner, mint):
    return (np.asarray(owner, np.int64) << PAIR_SHIFT) | np.asarray(mint, np.int64)


def split_pair(pair):
    pair = np.asarray(pair, np.int64)
    return (pair >> PAIR_SHIFT).astype(np.int32), (pair & ((1 << PAIR_SHIFT) - 1)).astype(np.int32)


STATE_COLS = ["kind", "s1", "s2", "s3", "s4", "bps"]


def choose_state(cur, can, oth):
    """Per row: the curve while live (s4 = real tokens > 0), else the canonical pool, else any SOL pool.
    Inputs are frames with STATE_COLS (kind -1 where missing). Returns arrays for sell_vec."""
    use_c = (cur["kind"].to_numpy() == 0) & (cur["s4"].to_numpy() > 0)
    use_a = ~use_c & (can["kind"].to_numpy() == 1)
    use_o = ~use_c & ~use_a & (oth["kind"].to_numpy() == 1)
    out = {}
    for col in STATE_COLS:
        out[col] = np.where(use_c, cur[col].to_numpy(), np.where(use_a, can[col].to_numpy(),
                            np.where(use_o, oth[col].to_numpy(), -1 if col == "kind" else 0)))
    return out


def mark(st, tokens):
    v, ok = sell_vec(st["kind"], st["s1"], st["s2"], st["s3"], st["s4"], st["bps"], tokens)
    return v, ok


# Red team R2-11: before a venue's first fee-paying row, quotes pay the dearest rate: PumpSwap's dearest tier in
# research/edge/snapshot/fee-configs.json (2 + 93 + 30 = 125 bps), also above the curve's 95 + 30 and the flat 30.
# The snapshot is from October; whether it is the dearest rate valid on each tape date is an open question.
FALLBACK_BPS = {0: 125, 1: 125, 2: 125}


def _paid_bps(rows):
    """Red team R2-8: BOOST slices and protocol swaps carry fee fields of 0 (they pay no venue fee), so they never set
    the fee rate a quote on that venue pays. Per (mint, class), a row with bps 0 takes the bps of the last earlier row
    with bps > 0; before the first such row nothing is known yet, so FALLBACK_BPS (the dearest rate) applies, and no
    later row is read (R2-11). Reserves are untouched. No curve or PumpSwap trade
    that pays fees has a total rate of 0, so bps 0 marks a fee-free row."""
    if len(rows) == 0:
        return rows
    r = rows.sort_values(["mint", "cls", "key"], kind="stable")
    b = r["bps"].where(r["bps"] > 0)
    g = b.groupby([r["mint"], r["cls"]])
    filled = g.ffill()          # as of the row: never a later row's rate (red team R2-11)
    filled = filled.fillna(r["cls"].map(FALLBACK_BPS)).fillna(max(FALLBACK_BPS.values()))
    out = rows.copy()
    out.loc[r.index, "bps"] = filled.astype(np.int64).to_numpy()
    return out


class States:
    """Venue states per mint, as of any key: the last carried state per class plus the unit's own rows."""
    CLS = (0, 1, 2)  # 0 curve, 1 canonical SOL pool, 2 other SOL pool

    def __init__(self):
        self.last = pd.DataFrame(columns=["mint", "cls", "key"] + STATE_COLS).astype(np.int64)

    @staticmethod
    def rows(sw):
        """SOL-quoted swaps -> state rows."""
        s = sw[sw["sol"] & ~sw["overflow"]]
        cls = np.where(s["venue"].to_numpy() == 0, 0, np.where(s["canonical"].to_numpy() == 1, 1, 2))
        return pd.DataFrame({"mint": s["mint"].to_numpy().astype(np.int64), "cls": cls, "key": s["key"].to_numpy(),
                             "kind": s["venue"].to_numpy().astype(np.int64), "s1": s["s1"].to_numpy(),
                             "s2": s["s2"].to_numpy(), "s3": s["s3"].to_numpy(), "s4": s["s4"].to_numpy(),
                             "bps": s["bps"].to_numpy()})

    def asof(self, unit_rows, mint, key):
        """State chosen per (mint, key) query, using carried states and unit rows with key <= query key."""
        q = pd.DataFrame({"mint": np.asarray(mint, np.int64), "key": np.asarray(key, np.int64),
                          "_i": np.arange(len(mint))})
        if len(q) == 0:
            return {c: np.zeros(0, np.int64) for c in STATE_COLS}
        allrows = _paid_bps(pd.concat([self.last.assign(key=-1), unit_rows], ignore_index=True))
        got = []
        qs = q.sort_values("key", kind="stable")
        for c in self.CLS:
            r = allrows[allrows["cls"] == c].sort_values("key", kind="stable")
            if len(r) == 0:
                m = pd.DataFrame({col: np.full(len(q), -1 if col == "kind" else 0) for col in STATE_COLS})
            else:
                m = pd.merge_asof(qs, r[["mint", "key"] + STATE_COLS], on="key", by="mint", direction="backward")
                m = m.sort_values("_i")
                m["kind"] = m["kind"].fillna(-1)
                m = m[STATE_COLS].fillna(0).astype(np.int64).reset_index(drop=True)
            got.append(m)
        return choose_state(*got)

    def advance(self, unit_rows):
        if len(unit_rows) == 0:
            return
        rows = _paid_bps(pd.concat([self.last, unit_rows], ignore_index=True))
        self.last = rows.sort_values("key", kind="stable").groupby(["mint", "cls"], as_index=False).tail(1) \
            .reset_index(drop=True)

    def at_end(self, mint):
        return self.asof(self.last.iloc[:0], mint, np.full(len(mint), np.iinfo(np.int64).max))


class Ledger:
    def __init__(self, vocab, prep_only=False):
        self.v = vocab
        # prep_only: the preparation stage on real tape (no outcome before the scoring is released). It computes no
        # cash, no cost split, no signer method and no valuation (no mark, no transfer value): those columns are left
        # out of the day output, and costs.signer_cash / costs.amendment_tx_cost / venue.sell_vec are never called.
        self.prep_only = bool(prep_only)
        self.states = States()
        # carry: open positions (bal > 0) by pair: bal, ok (start known, consistent), ver (verified by a swap), mark
        # ep_*: the open round trip (AMENDMENT_4): its opening time and key, and whether a transfer broke it
        self.carry = pd.DataFrame({"bal": pd.Series(dtype=np.int64), "ok": pd.Series(dtype=bool),
                                   "ver": pd.Series(dtype=bool), "mark": pd.Series(dtype=np.float64),
                                   "ep_bt": pd.Series(dtype=np.float64), "ep_key": pd.Series(dtype=np.float64),
                                   "ep_brk": pd.Series(dtype=bool)})
        self.prev_hi = None
        self.prev_day = None
        self.offcurve = {}
        self.pools, self.curves, self.boost_auth = set(), set(), set()
        self.fixed_ex = {self.v.id(BUYBACK_AUTHORITY): "buyback authority", self.v.id(MAYHEM_VAULT): "mayhem vault"}
        self.cg = []                      # (mint, slot, kind) C and G events
        self.create = {}                  # mint -> dict(slot, bt, creator, supply)
        self.migr = {}                    # mint -> first G (slot, bt)
        self.boost_done = {}              # mint -> key at which the BOOST vault reached 0
        self.unresolved = {}              # mint -> first unresolved slot
        self.partial = set()              # mints with movements seen only in pump transactions
        self.pump_mints = set()           # §3 'pump mints' as of now (OPEN_QUESTIONS Q6)
        self.sol_mints = set()            # mints with a SOL-quoted venue or a create, as of now
        self.last_swap_slot = pd.Series(dtype=np.int64)
        self.boost_txk = set()            # transactions with a BoostBuyAndBurnEvent (AMENDMENT 2 review item 4)
        # per token account (AMENDMENT_2 Q22): tracked balance and its (owner, mint) pair
        self.cacct = pd.DataFrame({"bal": pd.Series(dtype=np.int64), "pair": pd.Series(dtype=np.int64)})
        self.allow_gaps = False
        self.days_done = 0
        self.stats = {"cost_source": {"tx_fee": 0, "amendment": 0, "fixed_leg": 0},
                      "signer_method": {"txs": 0, "accepted": 0, "rows": 0, "rent_created": 0, "rent_returned": 0},
                      "gaps": [], "no_state_marks": 0,
                      "overflow_rows": 0, "excluded_rows": 0}
        self._day_reset()

    # ---------------------------------------------------------------- day bookkeeping
    def _day_reset(self):
        self.acc = []
        self.buys, self.big, self.xfers, self.wedges, self.tedges = [], [], [], [], []
        self.trips = []
        self.fees = []
        self.owners_day = set()
        self.ex_seen = {}
        self.day_start = self.carry.copy()
        self.day_lo = None
        self.day_hi = None
        self.day_gaps = 0
        self.w_present = True

    def _excluded(self, owner_ids):
        """Owner ids -> exclusion type or '' per id (PREREG §3), computed once per distinct id."""
        ids = np.asarray(owner_ids, np.int64)
        if len(ids) == 0:
            return np.array([], object)
        u, inv = np.unique(ids, return_inverse=True)
        out = []
        for o in u.tolist():
            if o < 0:
                out.append("empty owner")
                continue
            t = self.fixed_ex.get(o)
            if t is None:
                if o in self.pools:
                    t = "pool"
                elif o in self.curves:
                    t = "curve"
                elif o in self.boost_auth:
                    t = "boost authority"
                else:
                    oc = self.offcurve.get(o)
                    if oc is None:
                        oc = not on_curve(self.v.strs[o])
                        self.offcurve[o] = oc
                    t = "program-derived (off-curve)" if oc else ""
            out.append(t)
        return np.array(out, object)[inv]

    def _note_gap(self, lo):
        """A slot range the run did not read: every carried position loses its known start."""
        if self.prev_hi is not None and lo != self.prev_hi + 1:
            if not self.allow_gaps:
                raise RuntimeError(f"gap in the slots read: {self.prev_hi + 1}..{lo - 1} (allow_gaps is for "
                                   "development only; a scored run refuses gaps)")
            self.stats["gaps"].append((int(self.prev_hi) + 1, int(lo) - 1))
            self.day_gaps += 1
            self.carry["ok"] = False
            self.carry["ep_brk"] = True

    # ---------------------------------------------------------------- unit
    def process_unit(self, unit, sw=None, mv=None, ev=None, cov=None, w=None):
        v = self.v
        if self.prev_day is not None and unit.day != self.prev_day:
            raise RuntimeError("finish_day() must run before a unit of the next day")
        if self.day_lo is None:
            self.day_lo = unit.lo
            # the run's first day, or a day after a gap: positions carried in have no known start
            self.day_first = self.days_done == 0 or (self.prev_hi is not None and unit.lo != self.prev_hi + 1)
        self._note_gap(unit.lo)
        self.prev_hi, self.prev_day, self.day_hi = unit.hi, unit.day, unit.hi
        sw = load.swaps(unit, v) if sw is None else sw
        mv = load.movements(unit, v) if mv is None else mv
        ev = load.events(unit) if ev is None else ev
        unres, partial = load.coverage(unit, v) if cov is None else cov
        w = load.sol_transfers(unit, v) if w is None else w
        for m, s in unres.items():
            self.unresolved[m] = min(self.unresolved.get(m, s), s)
        self.partial |= partial
        self._events(ev)
        if len(sw) == 0:
            sw = pd.DataFrame(columns=["key", "txk", "slot", "bt", "owner", "acct", "signer", "mint", "venue", "pool",
                                       "canonical", "sol", "is_buy", "tokens", "cash", "tx_fee", "tx_fee_na", "jito",
                                       "pre", "post", "spre", "spost", "protocol", "boost", "s1", "s2", "s3", "s4",
                                       "bps", "n_tx", "overflow", "pre_na"])
        self.pools |= set(sw.loc[sw["venue"] == 1, "pool"].tolist())
        self.sol_mints |= set(sw.loc[sw["sol"].astype(bool), "mint"].tolist())
        self.pump_mints |= set(sw.loc[(sw["venue"] == 0) | (sw["canonical"] == 1), "mint"].tolist())

        ex = self._excluded(sw["owner"].to_numpy())
        # protocol flow: the protocol column, boost_buy_and_burn, and (every schema version alike) any swap in a
        # transaction that emitted a BoostBuyAndBurnEvent in E
        boost_tx = np.isin(sw["txk"].to_numpy(np.int64), np.fromiter(self.boost_txk, np.int64, len(self.boost_txk)))
        ex = np.where((sw["protocol"].to_numpy() != 0) | sw["boost"].to_numpy(bool) | boost_tx, "protocol flow", ex) \
            if len(sw) else ex
        for o, t in zip(sw["owner"].to_numpy(), ex):
            if t:
                self.ex_seen.setdefault(t, set()).add(int(o))
        tracked = sw["sol"].to_numpy(bool) & ~sw["overflow"].to_numpy(bool) & (ex == "")
        sw = sw.copy()
        if self.prep_only:
            z = np.zeros(len(sw))
            sw["cost"], sw["net_alt"], sw["net"], sw["net_nc"] = z, z, z, z
            sw["sig"], sw["sig_nc"] = np.zeros(len(sw), bool), np.zeros(len(sw), bool)
        else:
            self._costs(sw, tracked)
        self.stats["overflow_rows"] += int(sw["overflow"].sum())
        self.stats["excluded_rows"] += int((sw["sol"].to_numpy(bool) & (ex != "")).sum())
        self._unit_rest(sw, mv, w, tracked)

    def _costs(self, sw, tracked):
        """Cash per swap row (in place on sw): cost, net_alt, net, sig, net_nc, sig_nc."""
        # transaction costs (PREREG §4, AMENDMENT_1, AMENDMENT_3 Q29): tx_fee + jito_tip is charged only to the
        # transaction's included rows, split evenly over them (one owner of every included row pays all of it)
        n_inc = pd.Series(tracked, index=sw.index).groupby(sw["txk"]).transform("sum").to_numpy()
        n_inc = np.maximum(n_inc, 1)
        cost = np.where(tracked, (sw["tx_fee"] + sw["jito"]).to_numpy(np.float64) / n_inc, 0.0)
        na = sw["tx_fee_na"].to_numpy(bool) & tracked
        if na.any():
            g = sw[na].groupby("txk")
            own_all = g.apply(lambda d: bool((d["owner"] == d["signer"]).all()), include_groups=False)
            net = g["cash"].sum()
            first = g[["spre", "spost"]].first()
            ninc_tx = pd.Series(n_inc, index=sw.index)[na].groupby(sw.loc[na, "txk"]).first()
            amend = pd.Series([amendment_tx_cost(int(a), int(b), int(c)) for a, b, c in
                               zip(first["spre"], first["spost"], net)], index=first.index) / ninc_tx
            per = np.where(own_all.reindex(sw.loc[na, "txk"]).to_numpy(bool),
                           amend.reindex(sw.loc[na, "txk"]).to_numpy(), FIXED_PER_LEG)
            cost[na] = per
            n_am = int(own_all.reindex(sw.loc[na, "txk"]).to_numpy(bool).sum())
            self.stats["cost_source"]["amendment"] += n_am
            self.stats["cost_source"]["fixed_leg"] += int(na.sum()) - n_am
        self.stats["cost_source"]["tx_fee"] += int((tracked & ~na).sum())
        sw["cost"] = cost
        sw["net_alt"] = sw["cash"].to_numpy() - cost          # venue method (AMENDMENT_2 Q2 "otherwise")
        # signer's SOL change where it owns every swap; *_nc: the same without the plausibility cap (OPEN_QUESTIONS Q37)
        sw["net"], sw["sig"], sw["net_nc"], sw["sig_nc"] = self._signer_method(sw)

    def _unit_rest(self, sw, mv, w, tracked):
        unit_states = States.rows(sw)

        # §5 raw inputs: every tracked buy (lag to the previous swap on the mint) and every big buy
        solsw = sw[sw["sol"].to_numpy(bool) & ~sw["overflow"].to_numpy(bool)]
        if len(solsw):
            o = solsw.sort_values(["mint", "key"], kind="stable")
            prev = o.groupby("mint")["slot"].shift(1)
            carried = o["mint"].map(self.last_swap_slot)
            prev = prev.fillna(carried)
            lag = (o["slot"] - prev).reindex(solsw.index)
            last = o.groupby("mint")["slot"].last()
            self.last_swap_slot = pd.concat([self.last_swap_slot[~self.last_swap_slot.index.isin(last.index)], last])
            # AMENDMENT_7 seat tag: dense rank of the buy's transaction among the slot's SOL swaps of that mint
            srank = solsw.groupby(["slot", "mint"])["txk"].rank(method="dense").to_numpy()
            tb = tracked[solsw.index] & solsw["is_buy"].to_numpy(bool)
            b = solsw[tb]
            self.buys.append(pd.DataFrame({"owner": b["owner"].to_numpy(np.int32), "mint": b["mint"].to_numpy(np.int32),
                                           "slot": b["slot"].to_numpy(), "key": b["key"].to_numpy(),
                                           "bt": b["bt"].to_numpy(), "paid": -b["net"].to_numpy(),
                                           "jito": b["jito"].to_numpy() > 0, "lag": lag[tb].to_numpy(),
                                           "opening": b["pre"].to_numpy() == 0,
                                           "venue": b["venue"].to_numpy(np.int8),
                                           "slot_rank": srank[tb].astype(np.int32)}))
            bb = solsw[solsw["is_buy"].to_numpy(bool) & (solsw["owner"].to_numpy() >= 0)
                       & (-solsw["cash"].to_numpy() >= BIG_BUY)]
            self.big.append(pd.DataFrame({"owner": bb["owner"].to_numpy(np.int32), "mint": bb["mint"].to_numpy(np.int32),
                                          "slot": bb["slot"].to_numpy(), "key": bb["key"].to_numpy()}))

        # swap events of tracked owners
        t = sw[tracked]
        # AMENDMENT_7: the transaction's whole tx_fee + jito_tip, per trade (as MIG-SEAT's G2 toll)
        self.fees.append(pd.DataFrame({"owner": t["owner"].to_numpy(np.int32),
                                       "seat": (t["tx_fee"] + t["jito"]).to_numpy(np.int64),
                                       "fee_na": t["tx_fee_na"].to_numpy(bool)}))
        isb = t["is_buy"].to_numpy(bool)
        pr = pair_of(t["owner"], t["mint"])
        sev = pd.DataFrame({"pair": pr, "acct": _acct(t["acct"].to_numpy(), pr), "key": t["key"].to_numpy(),
                            "bt": t["bt"].to_numpy(),
                            "txk": t["txk"].to_numpy(), "slot": t["slot"].to_numpy(),
                            "delta": np.where(isb, t["tokens"], -t["tokens"]).astype(np.int64),
                            "cash": t["net"].to_numpy(), "paid": np.where(isb, -t["net"].to_numpy(), 0.0),
                            "cash_alt": t["net_alt"].to_numpy(),
                            "paid_alt": np.where(isb, -t["net_alt"].to_numpy(), 0.0),
                            "nsig": t["sig"].to_numpy().astype(np.int32),
                            "cash_nc": t["net_nc"].to_numpy(),
                            "paid_nc": np.where(isb, -t["net_nc"].to_numpy(), 0.0),
                            "ncap": (t["sig_nc"].to_numpy() & ~t["sig"].to_numpy()).astype(np.int32),
                            "xin": 0.0, "swap": True, "nbuy": isb.astype(np.int32), "nsell": (~isb).astype(np.int32),
                            "pre": t["pre"].to_numpy(), "post": t["post"].to_numpy(), "bad": False,
                            "buykey": np.where(isb, t["key"].to_numpy(), np.iinfo(np.int64).max)})
        for o_ in t["owner"].unique():
            self.owners_day.add(int(o_))

        # movements: valued at the transaction's state; legs of tracked owners only
        mev = self._movements(mv, unit_states)
        evs = pd.concat([sev, mev], ignore_index=True) if len(mev) else sev
        self._apply(evs)
        self.states.advance(unit_states)

        # §3 raw edges
        if w is None:
            self.w_present = False
        elif len(w):
            self.wedges.append(np.stack([w["frm"].to_numpy(np.int64), w["to"].to_numpy(np.int64)], 1))
        if len(mv):
            tm = mv[(mv["kind"] == 0) & (mv["frm"] >= 0) & (mv["to"] >= 0)]
            self.tedges.append(np.stack([tm["frm"].to_numpy(np.int64), tm["to"].to_numpy(np.int64),
                                         tm["mint"].to_numpy(np.int64)], 1))

    def _events(self, ev):
        v = self.v
        for d in ev:
            f = d.get("fields", {})
            name, slot, bt = d["event"], int(d["slot"]), int(d["block_time"])
            key = int(load.make_key(slot, int(d["tx_idx"]), int(d.get("ev_idx", 0))))
            if name == "CreateEvent":
                m = v.id(f.get("mint", ""))
                self.cg.append((m, slot, 0))
                self.create.setdefault(m, {"slot": slot, "bt": bt, "creator": v.id(f.get("creator", "")),
                                           "supply": int(f.get("token_total_supply") or 0)})
                self.pump_mints.add(m)
                self.sol_mints.add(m)
                if f.get("bonding_curve"):
                    self.curves.add(v.id(f["bonding_curve"]))
            elif name in load.G_EVENTS:
                if name == "CreatePoolEvent":
                    bm, qm = f.get("base_mint", ""), f.get("quote_mint", "")
                    m = v.id(qm if bm == "So11111111111111111111111111111111111111112" else bm)
                else:
                    m = v.id(f.get("mint", ""))
                self.cg.append((m, slot, 1))
                self.migr.setdefault(m, (slot, bt))
                for k in ("bonding_curve",):
                    if f.get(k):
                        self.curves.add(v.id(f[k]))
                if f.get("pool"):
                    self.pools.add(v.id(f["pool"]))
            elif name == "BoostBuyAndBurnEvent":
                self.boost_txk.add(int(load.make_key(slot, int(d["tx_idx"]), 0)) >> load.KEY_TX_SHIFT)
                if f.get("authority"):
                    self.boost_auth.add(v.id(f["authority"]))
                if f.get("pool"):
                    self.pools.add(v.id(f["pool"]))
                if str(f.get("boost_vault_remaining", "")) == "0":
                    m = v.id(f.get("mint", ""))
                    self.boost_done.setdefault(m, key)
            elif name == "InitBoostEvent":
                if f.get("pool"):
                    self.pools.add(v.id(f["pool"]))

    def _movements(self, mv, unit_states):
        cols = ["pair", "acct", "key", "bt", "txk", "slot", "delta", "cash", "paid", "cash_alt", "paid_alt", "nsig", "cash_nc", "paid_nc", "ncap", "xin",
                "swap", "nbuy", "nsell", "pre", "post", "bad", "buykey"]
        if mv is None or len(mv) == 0:
            return pd.DataFrame(columns=cols)
        mv = mv[mv["mint"].isin(self.sol_mints) & (mv["kind"] <= 2)]
        # a transfer with an empty owner is left out (its transaction is marked unresolved in T_coverage)
        mv = mv[~((mv["kind"] == 0) & ((mv["frm"] < 0) | (mv["to"] < 0)))]
        # a leg through the owner's own temp account (from == to) nets to zero (historical-data.md)
        mv = mv[~((mv["kind"] == 0) & (mv["frm"] == mv["to"]))].reset_index(drop=True)
        if len(mv) == 0:
            return pd.DataFrame(columns=cols)
        st = self.states.asof(unit_states, mv["mint"].to_numpy(), mv["key"].to_numpy())
        if self.prep_only:      # no valuation: only whether a venue state exists (sell_vec's own test)
            val, has = np.zeros(len(mv)), np.asarray(st["kind"]) >= 0
        else:
            val, has = mark(st, mv["amount"].to_numpy())
        kind = mv["kind"].to_numpy()
        val = np.where(kind == 0, val, 0.0)
        ex_f = (self._excluded(mv["frm"].to_numpy()) != "") | (mv["frm"].to_numpy() < 0)
        ex_t = (self._excluded(mv["to"].to_numpy()) != "") | (mv["to"].to_numpy() < 0)
        legs = []
        f_ok = (kind <= 1) & ~ex_f
        fp = pair_of(mv["frm"][f_ok], mv["mint"][f_ok])
        legs.append(pd.DataFrame({"pair": fp, "acct": _acct(mv["facct"][f_ok].to_numpy(), fp), "key": mv["key"][f_ok], "bt": mv["bt"][f_ok],
                                  "txk": mv["txk"][f_ok], "slot": mv["slot"][f_ok],
                                  "delta": -mv["amount"][f_ok].to_numpy(), "cash": val[f_ok], "paid": 0.0, "xin": 0.0,
                                  "bad": (kind[f_ok] == 0) & ~has[f_ok]}))
        t_ok = ((kind == 0) | (kind == 2)) & ~ex_t
        tp_ = pair_of(mv["to"][t_ok], mv["mint"][t_ok])
        legs.append(pd.DataFrame({"pair": tp_, "acct": _acct(mv["tacct"][t_ok].to_numpy(), tp_), "key": mv["key"][t_ok], "bt": mv["bt"][t_ok],
                                  "txk": mv["txk"][t_ok], "slot": mv["slot"][t_ok],
                                  "delta": mv["amount"][t_ok].to_numpy(), "cash": -val[t_ok], "paid": val[t_ok],
                                  "xin": val[t_ok], "bad": (kind[t_ok] == 2) | ~has[t_ok]}))
        both = (kind == 0) & ~ex_f & ~ex_t
        self.xfers.append(pd.DataFrame({"frm": mv["frm"][both].to_numpy(np.int32), "to": mv["to"][both].to_numpy(np.int32),
                                        "mint": mv["mint"][both].to_numpy(np.int32), "value": val[both],
                                        "key": mv["key"][both].to_numpy()}))
        out = pd.concat(legs, ignore_index=True)
        out["cash_alt"] = out["cash"]
        out["paid_alt"] = out["paid"]
        out["nsig"] = 0
        out["cash_nc"] = out["cash"]
        out["paid_nc"] = out["paid"]
        out["ncap"] = 0
        out["swap"] = False
        out["nbuy"] = 0
        out["nsell"] = 0
        out["pre"] = 0
        out["post"] = 0
        out["buykey"] = np.iinfo(np.int64).max
        return out[cols]

    def _signer_method(self, sw):
        """AMENDMENT_2 Q2: per-row cash under the signer's SOL change where the signer owns every swap of the
        transaction (all SOL-quoted, tx_fee present, change plausible); else the venue method. Returns (net, used)."""
        net = sw["net_alt"].to_numpy(np.float64).copy()
        used = np.zeros(len(sw), bool)
        if len(sw) == 0:
            return net, used, net.copy(), used.copy()
        own = (sw["owner"].to_numpy() == sw["signer"].to_numpy()) & (sw["owner"].to_numpy() >= 0) \
            & sw["sol"].to_numpy(bool) & ~sw["overflow"].to_numpy(bool) & ~sw["tx_fee_na"].to_numpy(bool)
        f = pd.DataFrame({"txk": sw["txk"].to_numpy(), "own": own, "cash": sw["cash"].to_numpy(np.float64),
                          "mint": sw["mint"].to_numpy(), "is_buy": sw["is_buy"].to_numpy(bool),
                          "pre": sw["pre"].to_numpy(), "post": sw["post"].to_numpy()})
        g = f.groupby("txk", sort=False)
        allown = g["own"].all()
        elig = allown[allown].index
        if len(elig) == 0:
            return net, used, net.copy(), used.copy()
        fe = f[f["txk"].isin(elig)]
        ge = fe.groupby("txk", sort=False)
        first = sw.loc[fe.index].groupby("txk", sort=False)[["spre", "spost", "tx_fee", "jito"]].first()
        m = fe.groupby(["txk", "mint"], sort=False).agg(buy=("is_buy", "any"), sell=("is_buy", lambda x: (~x).any()),
                                                         pre=("pre", "first"), post=("post", "first"))
        m["open"] = m["buy"] & (m["pre"] == 0)
        m["close"] = m["sell"] & (m["post"] == 0)
        ko = m.groupby(level=0)["open"].sum().reindex(first.index)
        kc = m.groupby(level=0)["close"].sum().reindex(first.index)
        vsum = ge["cash"].sum().reindex(first.index)
        gross = ge["cash"].apply(lambda x: x.abs().sum()).reindex(first.index)
        slots = (first.index.to_numpy(np.int64) >> (load.KEY_SLOT_SHIFT - load.KEY_TX_SHIFT))
        rents = np.array([rent_candidates(self.prev_day, int(x)) for x in slots], np.float64).reshape(-1, 2)
        cash, created, returned, ok = signer_cash(first["spost"] - first["spre"], vsum, first["tx_fee"], first["jito"],
                                                   ko, kc, gross, rents[:, 0], rents[:, 1])
        st = self.stats["signer_method"]
        st["txs"] += int(len(first))
        st["accepted"] += int(ok.sum())
        st["rent_created"] += int((created[ok] > 0).sum())
        st["rent_returned"] += int((returned[ok] > 0).sum())
        n = ge.size().reindex(first.index).to_numpy()
        st["capped"] = st.get("capped", 0) + int((~ok).sum())
        rows = fe.index.to_numpy()
        cash_rows = sw["cash"].to_numpy(np.float64)[rows]
        net_nc, used_nc = net.copy(), used.copy()
        all_tx = pd.Series((vsum.to_numpy() - cash) / n, index=first.index).reindex(fe["txk"]).to_numpy()
        net_nc[rows] = cash_rows - all_tx
        used_nc[rows] = True
        per = pd.Series(np.where(ok, (vsum.to_numpy() - cash) / n, np.nan), index=first.index)
        extra = per.reindex(fe["txk"]).to_numpy()
        hit = ~np.isnan(extra)
        net[rows[hit]] = cash_rows[hit] - extra[hit]
        used[rows[hit]] = True
        st["rows"] += int(hit.sum())
        st["rows_capped"] = st.get("rows_capped", 0) + int((~hit).sum())
        return net, used, net_nc, used_nc

    def _apply(self, evs):
        """Balance checks per token account, summed per owner (AMENDMENT_2 Q22), and the per-pair unit aggregate."""
        if len(evs) == 0:
            return
        evs = evs.sort_values(["pair", "key"], kind="stable")
        for c_ in ("swap", "bad"):
            evs[c_] = evs[c_].astype(bool)
        g = evs.groupby(["pair", "txk"], sort=False)
        tx = g.agg(delta=("delta", "sum"), cash=("cash", "sum"), paid=("paid", "sum"), cash_alt=("cash_alt", "sum"),
                   paid_alt=("paid_alt", "sum"), nsig=("nsig", "sum"), cash_nc=("cash_nc", "sum"),
                   paid_nc=("paid_nc", "sum"), ncap=("ncap", "sum"), xin=("xin", "sum"),
                   swap=("swap", "any"), nbuy=("nbuy", "sum"), nsell=("nsell", "sum"), bad=("bad", "any"),
                   key=("key", "max"), slot=("slot", "max"), bt=("bt", "max"), buykey=("buykey", "min"),
                   mv=("swap", lambda x: bool((~x).any()))).reset_index()
        pp = evs[evs["swap"]].groupby(["pair", "txk"], sort=False).agg(pre=("pre", "first"), post=("post", "first"))
        tx = tx.merge(pp, left_on=["pair", "txk"], right_index=True, how="left")
        # accounts: tracked balance per (account, transaction)
        A = evs.groupby(["acct", "txk"], sort=False).agg(pair=("pair", "first"), delta=("delta", "sum")).reset_index()
        A = A.sort_values(["acct", "txk"], kind="stable").reset_index(drop=True)
        start_a = self.cacct["bal"].reindex(A["acct"].unique()).fillna(0).astype(np.int64)
        A["start"] = A["acct"].map(start_a).to_numpy()
        A["raw"] = A["start"] + A.groupby("acct")["delta"].cumsum()
        nacc = A.groupby(["pair", "txk"], sort=False).size().rename("nacc")
        tx = tx.merge(nacc, left_on=["pair", "txk"], right_index=True, how="left")
        A = A.merge(tx[["pair", "txk", "swap", "post", "nacc"]], on=["pair", "txk"], how="left")
        A = A.sort_values(["acct", "txk"], kind="stable").reset_index(drop=True)
        # one account touched by a swap: owner_token_post is that account's balance, so it anchors the account
        A["anc"] = np.where(A["swap"].to_numpy(bool) & (A["nacc"].to_numpy() == 1),
                            A["post"].to_numpy(np.float64) - A["raw"].to_numpy(np.float64), np.nan)
        A["anc"] = A.groupby("acct")["anc"].ffill().fillna(0)
        A["after"] = (A["raw"] + A["anc"]).astype(np.int64)
        A["before"] = A.groupby("acct")["after"].shift(1)
        A["before"] = A["before"].fillna(A["start"]).astype(np.int64)
        A["chg"] = A["after"] - A["before"]
        pa = A.groupby(["pair", "txk"], sort=False).agg(before_sum=("before", "sum"), chg=("chg", "sum"),
                                                         neg=("after", "min"))
        tx = tx.merge(pa, left_on=["pair", "txk"], right_index=True, how="left")
        tx = tx.sort_values(["pair", "txk"], kind="stable").reset_index(drop=True)
        cp = self.carry.reindex(tx["pair"].unique())
        seen = cp["bal"].notna()
        ok0 = cp["ok"].where(seen, True).astype(bool)
        ver0 = cp["ver"].where(seen, False).astype(bool)
        pstart = self.cacct.groupby("pair")["bal"].sum().reindex(tx["pair"].unique()).fillna(0).astype(np.int64)
        sw_ = tx["swap"].to_numpy(bool)
        bsum = tx["before_sum"].to_numpy()
        mism = sw_ & ((tx["pre"].to_numpy() != bsum) | (tx["post"].to_numpy() != bsum + tx["delta"].to_numpy()))
        mism |= tx["neg"].to_numpy() < 0
        tx["mism"] = mism
        # a pair not carried whose first swap disagrees: its start was never seen (Q22, Q14)
        first_swap = sw_ & (tx.groupby("pair")["swap"].cumsum().to_numpy() == 1)
        unseen = ~tx["pair"].map(seen).to_numpy(bool)
        tx["mstart"] = mism & first_swap & unseen
        tx["mother"] = mism & ~tx["mstart"].to_numpy()
        tx["bal"] = (tx["pair"].map(pstart).to_numpy() + tx.groupby("pair")["chg"].cumsum()).astype(np.int64)
        self._trips(tx, pstart)
        tx["closekey"] = np.where(tx["bal"].to_numpy() == 0, tx["key"].to_numpy(), -1)
        tx["zsw"] = sw_ & (tx["post"].to_numpy() == 0)
        agg = tx.groupby("pair", sort=False).agg(
            cash=("cash", "sum"), paid=("paid", "sum"), cash_alt=("cash_alt", "sum"), paid_alt=("paid_alt", "sum"),
            nsig=("nsig", "sum"), cash_nc=("cash_nc", "sum"), paid_nc=("paid_nc", "sum"), ncap=("ncap", "sum"),
            xin=("xin", "sum"), nbuy=("nbuy", "sum"),
            nsell=("nsell", "sum"), bad=("bad", "any"), mism=("mism", "any"), mstart=("mstart", "any"),
            mother=("mother", "any"), anyswap=("swap", "any"),
            end=("bal", "last"), lastzsw=("zsw", "last"), lastkey=("key", "max"), lastslot=("slot", "max"),
            buykey=("buykey", "min"), closekey=("closekey", "max"), n=("key", "size"))
        agg["ok0"] = ok0.reindex(agg.index).to_numpy()
        agg["ver0"] = ver0.reindex(agg.index).to_numpy()
        clean = agg["ok0"] & ~agg["mism"] & ~agg["bad"]
        agg["dirty"] = ~clean
        agg["dstart"] = ~agg["ok0"] | agg["mstart"]
        agg["dother"] = agg["mother"] | agg["bad"]
        self.stats.setdefault("dirty_reasons", {"carried_unknown": 0, "start_not_seen": 0, "balance_mismatch": 0,
                                                "unvalued_or_mint": 0})
        dr = self.stats["dirty_reasons"]
        dr["carried_unknown"] += int((~agg["ok0"]).sum())
        dr["start_not_seen"] += int((agg["ok0"] & agg["mstart"]).sum())
        dr["balance_mismatch"] += int((agg["ok0"] & agg["mother"]).sum())
        dr["unvalued_or_mint"] += int((agg["ok0"] & ~agg["mism"] & agg["bad"]).sum())
        closed = (agg["end"] == 0)
        agg["end_ok"] = clean | (closed & agg["lastzsw"])
        agg["end_ver"] = (agg["ver0"] | (agg["anyswap"] & clean)) | closed
        self.acc.append(agg[ACC_COLS])
        if len(self.acc) >= 8:
            self._collapse_acc()
        # carry: accounts, then pairs
        last_a = A.groupby("acct", sort=False).agg(bal=("after", "last"), pair=("pair", "first"))
        ca = pd.concat([self.cacct[~self.cacct.index.isin(last_a.index)], last_a])
        closed_pairs = agg.index[closed.to_numpy()]
        self.cacct = ca[(ca["bal"] != 0) & ~ca["pair"].isin(closed_pairs)]
        keep = self.carry[~self.carry.index.isin(agg.index)]
        new = pd.DataFrame({"bal": agg["end"].astype(np.int64), "ok": agg["end_ok"].astype(bool),
                            "ver": agg["end_ver"].astype(bool),
                            "mark": self.carry["mark"].reindex(agg.index).fillna(0.0).to_numpy(),
                            "ep_bt": self._ep_open["ep_bt"].reindex(agg.index).to_numpy(np.float64),
                            "ep_key": self._ep_open["ep_key"].reindex(agg.index).to_numpy(np.float64),
                            "ep_brk": self._ep_open["ep_brk"].reindex(agg.index).fillna(True).astype(bool).to_numpy()},
                           index=agg.index)
        new = new[new["bal"] > 0]
        self.carry = pd.concat([keep, new])

    def _trips(self, tx, pstart):
        """AMENDMENT_4 round trips: from the balance leaving zero to its return to zero. A token movement (or a
        balance mismatch) inside the trip breaks it. Sets self._ep_open for the trips still open at unit end."""
        prev = tx.groupby("pair")["bal"].shift(1)
        prev = prev.fillna(tx["pair"].map(pstart)).to_numpy()
        bal = tx["bal"].to_numpy()
        opn = (prev == 0) & (bal > 0)
        cls_ = (prev > 0) & (bal == 0)
        tx["ep"] = pd.Series(opn.astype(np.int64)).groupby(tx["pair"].to_numpy()).cumsum().to_numpy()
        brk_row = tx["mv"].to_numpy(bool) | tx["mism"].to_numpy(bool)
        tx["brk"] = pd.Series(brk_row).groupby([tx["pair"].to_numpy(), tx["ep"].to_numpy()]).cummax().to_numpy()
        o = tx[opn].set_index(["pair", "ep"])[["bt", "key"]]
        c = self.carry.reindex(tx["pair"].unique())
        carried = pd.DataFrame({"bt": c["ep_bt"], "key": c["ep_key"], "brk": c["ep_brk"].fillna(True).astype(bool)})
        def start_of(rows):
            k = list(zip(rows["pair"], rows["ep"]))
            ob = o["bt"].reindex(k).to_numpy(np.float64)
            ok_ = o["key"].reindex(k).to_numpy(np.float64)
            cb = rows["pair"].map(carried["bt"]).to_numpy(np.float64)
            ck = rows["pair"].map(carried["key"]).to_numpy(np.float64)
            cbrk = rows["pair"].map(carried["brk"]).fillna(True).astype(bool).to_numpy()
            ep0 = rows["ep"].to_numpy() == 0
            return (np.where(ep0, cb, ob), np.where(ep0, ck, ok_),
                    rows["brk"].to_numpy(bool) | (ep0 & cbrk))
        cl = tx[cls_]
        if len(cl):
            ob, ok_, brk = start_of(cl)
            ow, mi = split_pair(cl["pair"].to_numpy())
            keep = ~np.isnan(ob)
            self.trips.append(pd.DataFrame({"owner": ow[keep], "mint": mi[keep], "open_bt": ob[keep],
                                            "close_bt": cl["bt"].to_numpy()[keep], "open_key": ok_[keep],
                                            "close_key": cl["key"].to_numpy()[keep], "broken": brk[keep]}))
        last = tx.groupby("pair", sort=False).tail(1)
        last = last[last["bal"] > 0]
        ob, ok_, brk = start_of(last) if len(last) else (np.zeros(0), np.zeros(0), np.zeros(0, bool))
        self._ep_open = pd.DataFrame({"ep_bt": ob, "ep_key": ok_, "ep_brk": brk}, index=last["pair"].to_numpy())

    def _collapse_acc(self):
        """Merges the per-unit aggregates of the day into one frame (keeps memory flat over a day)."""
        a = pd.concat(self.acc)
        g = a.groupby(level=0, sort=False)
        self.acc = [g.agg(**{c: (c, ACC_AGG[c]) for c in ACC_COLS})]

    # ---------------------------------------------------------------- day end
    def finish_day(self):
        """Closes the day: end marks, the owner-mint-day rows and the §3/§5 raw tables. Returns a dict."""
        day = self.prev_day
        if self.acc:
            self._collapse_acc()
            acc = self.acc[0]
        else:
            acc = pd.DataFrame(columns=ACC_COLS)
        ds = self.day_start
        idx = acc.index.union(ds.index)
        rows = pd.DataFrame(index=idx)
        rows["start_bal"] = ds["bal"].reindex(idx).fillna(0).astype(np.int64)
        rows["start_mark"] = ds["mark"].reindex(idx).fillna(0.0)
        start_ok = ds["ok"].reindex(idx).fillna(True).astype(bool)
        for c_ in ("cash", "paid", "cash_alt", "paid_alt", "cash_nc", "paid_nc", "xin"):
            rows[c_] = acc[c_].reindex(idx).fillna(0.0).astype(np.float64)
        for c_ in ("nbuy", "nsell", "n", "nsig", "ncap"):
            rows[c_] = acc[c_].reindex(idx).fillna(0).astype(np.int64)
        rows["buykey"] = acc["buykey"].reindex(idx).fillna(np.iinfo(np.int64).max).astype(np.int64)
        rows["closekey"] = acc["closekey"].reindex(idx).fillna(-1).astype(np.int64)
        rows["lastslot"] = acc["lastslot"].reindex(idx).fillna(-1).astype(np.int64)
        dirty = acc["dirty"].reindex(idx).fillna(False).astype(bool) | ((rows["start_bal"] > 0) & ~start_ok)
        rows["end_bal"] = self.carry["bal"].reindex(idx).fillna(0).astype(np.int64)
        end_ver = self.carry["ver"].reindex(idx)
        end_ver = end_ver.where(end_ver.notna(), acc["end_ver"].reindex(idx)).fillna(True).astype(bool)
        dirty |= ~end_ver
        end_ok = self.carry["ok"].reindex(idx).fillna(True).astype(bool)
        dirty |= (rows["end_bal"] > 0) & ~end_ok
        owner, mint = split_pair(idx.to_numpy())
        rows["owner"], rows["mint"] = owner, mint
        # end marks at the day's last state
        held = rows["end_bal"].to_numpy() > 0
        st = self.states.at_end(mint[held])
        if self.prep_only:
            mv_, has = np.zeros(int(held.sum())), np.asarray(st["kind"]) >= 0
        else:
            mv_, has = mark(st, rows["end_bal"].to_numpy()[held])
        em = np.zeros(len(rows))
        em[held] = mv_
        rows["end_mark"] = em
        rows["no_state"] = False
        rows.loc[rows.index[held], "no_state"] = ~has
        self.stats["no_state_marks"] += int((~has).sum())
        # unresolved ownership (T_coverage) and partial movement coverage (OPEN_QUESTIONS Q9, Q10)
        uf = pd.Series(self.unresolved, dtype=np.int64).reindex(mint).to_numpy(dtype=np.float64)
        last_rel = np.where(held, float(self.day_hi), rows["lastslot"].to_numpy(np.float64))
        unres_hit = ~np.isnan(uf) & (uf <= last_rel)
        part = np.isin(mint, np.fromiter(self.partial, np.int64, len(self.partial))) & held
        dirty = dirty.to_numpy() | unres_hit | part
        rows["dirty"] = dirty
        # Q14: dirty only because the start was not seen (first day read, or carried in unknown)
        start_rel = acc["dstart"].reindex(idx).fillna(False).astype(bool).to_numpy() | \
            ((rows["start_bal"].to_numpy() > 0) & ~start_ok.to_numpy())
        other = acc["dother"].reindex(idx).fillna(False).astype(bool).to_numpy() | unres_hit | part | \
            ~end_ver.to_numpy()
        rows["dirty_start_only"] = dirty & start_rel & ~other
        rows["unresolved"] = unres_hit
        rows["partial"] = part
        # carry: day-end mark becomes tomorrow's start mark; a held dirty position stays unknown until closed
        cm = pd.Series(em, index=idx)
        self.carry["mark"] = cm.reindex(self.carry.index).fillna(0.0).to_numpy()
        bad_hold = pd.Series(dirty & held, index=idx)
        bh = bad_hold.reindex(self.carry.index).fillna(False).to_numpy(bool)
        self.carry.loc[bh, "ok"] = False
        rows = rows.reset_index(drop=True)
        rows["day"] = day

        cg = pd.DataFrame(self.cg, columns=["mint", "slot", "kind"])
        out = {
            "day": day, "lo": self.day_lo, "hi": self.day_hi, "gaps": self.day_gaps, "rows": rows,
            "first_day": bool(self.day_first),
            "buys": pd.concat(self.buys, ignore_index=True) if self.buys else pd.DataFrame(),
            "big": pd.concat(self.big, ignore_index=True) if self.big else pd.DataFrame(),
            "xfers": pd.concat(self.xfers, ignore_index=True) if self.xfers else pd.DataFrame(
                columns=["frm", "to", "mint", "value", "key"]),
            "cg": cg,
            "fees": pd.concat(self.fees, ignore_index=True) if self.fees else pd.DataFrame(
                columns=["owner", "seat", "fee_na"]),
            "trips": pd.concat(self.trips, ignore_index=True) if self.trips else pd.DataFrame(
                columns=["owner", "mint", "open_bt", "close_bt", "open_key", "close_key", "broken"]),
            "wedges": _uniq_edges(self.wedges, 2),
            "tedges": _tedges(self.tedges, self.pump_mints | self._pump_suffix()),
            "w_present": self.w_present,
            "owners": np.fromiter(self.owners_day, np.int64, len(self.owners_day)),
            "excluded": {k: np.fromiter(s, np.int64, len(s)) for k, s in self.ex_seen.items()},
            "hub_excluded_nodes": self._all_excluded_ids(),
        }
        if self.prep_only:
            out["prep_only"] = True
            out["rows"] = rows.drop(columns=list(PREP_DROP["rows"]))
            out["buys"] = out["buys"].drop(columns=list(PREP_DROP["buys"]), errors="ignore")
            out["xfers"] = out["xfers"].drop(columns=list(PREP_DROP["xfers"]))
        self.prev_day = None
        self.days_done += 1
        self._day_reset()
        return out

    def _pump_suffix(self):
        """Mints whose address ends in 'pump' among the day's movements (pump.fun's vanity suffix)."""
        if not self.tedges:
            return set()
        ms = np.unique(np.concatenate([e[:, 2] for e in self.tedges]))
        return {int(m) for m in ms if m >= 0 and self.v.strs[m].endswith("pump")}

    def _all_excluded_ids(self):
        ids = set(self.pools) | set(self.curves) | set(self.boost_auth) | set(self.fixed_ex)
        ids |= {o for o, oc in self.offcurve.items() if oc}
        return np.fromiter(ids, np.int64, len(ids))


def _uniq_edges(parts, k):
    if not parts:
        return np.zeros((0, k), np.int64)
    e = np.concatenate(parts)
    e = e[(e[:, 0] >= 0) & (e[:, 1] >= 0) & (e[:, 0] != e[:, 1])]
    return np.unique(e, axis=0)


def _tedges(parts, pump_mints):
    """T transfers of a pump mint (PREREG §3), as (from, to) owner pairs."""
    if not parts:
        return np.zeros((0, 2), np.int64)
    e = np.concatenate(parts)
    pm = np.fromiter(pump_mints, np.int64, len(pump_mints))
    e = e[np.isin(e[:, 2], pm)][:, :2]
    return _uniq_edges([e], 2)
