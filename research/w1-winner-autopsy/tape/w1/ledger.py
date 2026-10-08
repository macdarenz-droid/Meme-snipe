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
from .costs import FIXED_PER_LEG, amendment_tx_cost
from .venue import sell_vec

BIG_BUY = 1_000_000_000  # PREREG §5: a buy of at least 1 SOL
PAIR_SHIFT = 32


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
        allrows = pd.concat([self.last.assign(key=-1), unit_rows], ignore_index=True)
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
        tail = unit_rows.sort_values("key", kind="stable").groupby(["mint", "cls"], as_index=False).tail(1)
        self.last = pd.concat([self.last, tail], ignore_index=True).sort_values("key", kind="stable") \
            .groupby(["mint", "cls"], as_index=False).tail(1).reset_index(drop=True)

    def at_end(self, mint):
        return self.asof(self.last.iloc[:0], mint, np.full(len(mint), np.iinfo(np.int64).max))


class Ledger:
    def __init__(self, vocab):
        self.v = vocab
        self.states = States()
        # carry: open positions (bal > 0) by pair: bal, ok (start known, consistent), ver (verified by a swap), mark
        self.carry = pd.DataFrame({"bal": pd.Series(dtype=np.int64), "ok": pd.Series(dtype=bool),
                                   "ver": pd.Series(dtype=bool), "mark": pd.Series(dtype=np.float64)})
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
        self.stats = {"cost_source": {"tx_fee": 0, "amendment": 0, "fixed_leg": 0}, "gaps": [], "no_state_marks": 0,
                      "overflow_rows": 0, "excluded_rows": 0}
        self._day_reset()

    # ---------------------------------------------------------------- day bookkeeping
    def _day_reset(self):
        self.acc = []
        self.buys, self.big, self.xfers, self.wedges, self.tedges = [], [], [], [], []
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
            self.stats["gaps"].append((int(self.prev_hi) + 1, int(lo) - 1))
            self.day_gaps += 1
            self.carry["ok"] = False

    # ---------------------------------------------------------------- unit
    def process_unit(self, unit, sw=None, mv=None, ev=None, cov=None, w=None):
        v = self.v
        if self.prev_day is not None and unit.day != self.prev_day:
            raise RuntimeError("finish_day() must run before a unit of the next day")
        if self.day_lo is None:
            self.day_lo = unit.lo
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
            sw = pd.DataFrame(columns=["key", "txk", "slot", "bt", "owner", "signer", "mint", "venue", "pool",
                                       "canonical", "sol", "is_buy", "tokens", "cash", "tx_fee", "tx_fee_na", "jito",
                                       "pre", "post", "spre", "spost", "protocol", "boost", "s1", "s2", "s3", "s4",
                                       "bps", "n_tx", "overflow", "pre_na"])
        self.pools |= set(sw.loc[sw["venue"] == 1, "pool"].tolist())
        self.sol_mints |= set(sw.loc[sw["sol"].astype(bool), "mint"].tolist())
        self.pump_mints |= set(sw.loc[(sw["venue"] == 0) | (sw["canonical"] == 1), "mint"].tolist())

        # transaction costs (PREREG §4, AMENDMENT_1)
        sw = sw.copy()
        cost = (sw["tx_fee"] + sw["jito"]).to_numpy(np.float64) / np.maximum(sw["n_tx"].to_numpy(), 1)
        na = sw["tx_fee_na"].to_numpy(bool)
        if na.any():
            g = sw[na].groupby("txk")
            own_all = g.apply(lambda d: bool((d["owner"] == d["signer"]).all()), include_groups=False)
            net = g["cash"].sum()
            first = g[["spre", "spost", "n_tx"]].first()
            amend = pd.Series([amendment_tx_cost(int(a), int(b), int(c)) for a, b, c in
                               zip(first["spre"], first["spost"], net)], index=first.index) / first["n_tx"]
            per = np.where(own_all.reindex(sw.loc[na, "txk"]).to_numpy(bool),
                           amend.reindex(sw.loc[na, "txk"]).to_numpy(), FIXED_PER_LEG)
            cost[na] = per
            n_am = int(own_all.reindex(sw.loc[na, "txk"]).to_numpy(bool).sum())
            self.stats["cost_source"]["amendment"] += n_am
            self.stats["cost_source"]["fixed_leg"] += int(na.sum()) - n_am
        self.stats["cost_source"]["tx_fee"] += int((~na).sum())
        sw["cost"] = cost
        sw["net"] = sw["cash"].to_numpy() - cost

        ex = self._excluded(sw["owner"].to_numpy())
        ex = np.where((sw["protocol"].to_numpy() != 0) | sw["boost"].to_numpy(bool), "protocol flow", ex) \
            if len(sw) else ex
        for o, t in zip(sw["owner"].to_numpy(), ex):
            if t:
                self.ex_seen.setdefault(t, set()).add(int(o))
        tracked = sw["sol"].to_numpy(bool) & ~sw["overflow"].to_numpy(bool) & (ex == "")
        self.stats["overflow_rows"] += int(sw["overflow"].sum())
        self.stats["excluded_rows"] += int((sw["sol"].to_numpy(bool) & (ex != "")).sum())

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
            tb = tracked[solsw.index] & solsw["is_buy"].to_numpy(bool)
            b = solsw[tb]
            self.buys.append(pd.DataFrame({"owner": b["owner"].to_numpy(np.int32), "mint": b["mint"].to_numpy(np.int32),
                                           "slot": b["slot"].to_numpy(), "key": b["key"].to_numpy(),
                                           "bt": b["bt"].to_numpy(), "paid": -b["net"].to_numpy(),
                                           "jito": b["jito"].to_numpy() > 0, "lag": lag[tb].to_numpy(),
                                           "opening": b["pre"].to_numpy() == 0,
                                           "venue": b["venue"].to_numpy(np.int8)}))
            bb = solsw[solsw["is_buy"].to_numpy(bool) & (solsw["owner"].to_numpy() >= 0)
                       & (-solsw["cash"].to_numpy() >= BIG_BUY)]
            self.big.append(pd.DataFrame({"owner": bb["owner"].to_numpy(np.int32), "mint": bb["mint"].to_numpy(np.int32),
                                          "slot": bb["slot"].to_numpy(), "key": bb["key"].to_numpy()}))

        # swap events of tracked owners
        t = sw[tracked]
        isb = t["is_buy"].to_numpy(bool)
        sev = pd.DataFrame({"pair": pair_of(t["owner"], t["mint"]), "key": t["key"].to_numpy(),
                            "txk": t["txk"].to_numpy(), "slot": t["slot"].to_numpy(),
                            "delta": np.where(isb, t["tokens"], -t["tokens"]).astype(np.int64),
                            "cash": t["net"].to_numpy(), "paid": np.where(isb, -t["net"].to_numpy(), 0.0),
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
        cols = ["pair", "key", "txk", "slot", "delta", "cash", "paid", "xin", "swap", "nbuy", "nsell", "pre", "post",
                "bad", "buykey"]
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
        val, has = mark(st, mv["amount"].to_numpy())
        kind = mv["kind"].to_numpy()
        val = np.where(kind == 0, val, 0.0)
        ex_f = (self._excluded(mv["frm"].to_numpy()) != "") | (mv["frm"].to_numpy() < 0)
        ex_t = (self._excluded(mv["to"].to_numpy()) != "") | (mv["to"].to_numpy() < 0)
        legs = []
        f_ok = (kind <= 1) & ~ex_f
        legs.append(pd.DataFrame({"pair": pair_of(mv["frm"][f_ok], mv["mint"][f_ok]), "key": mv["key"][f_ok],
                                  "txk": mv["txk"][f_ok], "slot": mv["slot"][f_ok],
                                  "delta": -mv["amount"][f_ok].to_numpy(), "cash": val[f_ok], "paid": 0.0, "xin": 0.0,
                                  "bad": (kind[f_ok] == 0) & ~has[f_ok]}))
        t_ok = ((kind == 0) | (kind == 2)) & ~ex_t
        legs.append(pd.DataFrame({"pair": pair_of(mv["to"][t_ok], mv["mint"][t_ok]), "key": mv["key"][t_ok],
                                  "txk": mv["txk"][t_ok], "slot": mv["slot"][t_ok],
                                  "delta": mv["amount"][t_ok].to_numpy(), "cash": -val[t_ok], "paid": val[t_ok],
                                  "xin": val[t_ok], "bad": (kind[t_ok] == 2) | ~has[t_ok]}))
        both = (kind == 0) & ~ex_f & ~ex_t
        self.xfers.append(pd.DataFrame({"frm": mv["frm"][both].to_numpy(np.int32), "to": mv["to"][both].to_numpy(np.int32),
                                        "mint": mv["mint"][both].to_numpy(np.int32), "value": val[both],
                                        "key": mv["key"][both].to_numpy()}))
        out = pd.concat(legs, ignore_index=True)
        out["swap"] = False
        out["nbuy"] = 0
        out["nsell"] = 0
        out["pre"] = 0
        out["post"] = 0
        out["buykey"] = np.iinfo(np.int64).max
        return out[cols]

    def _apply(self, evs):
        """Balance checks and the per-pair unit aggregate (see the module docstring)."""
        if len(evs) == 0:
            return
        evs = evs.sort_values(["pair", "key"], kind="stable")
        g = evs.groupby(["pair", "txk"], sort=False)
        tx = g.agg(delta=("delta", "sum"), cash=("cash", "sum"), paid=("paid", "sum"), xin=("xin", "sum"),
                   swap=("swap", "any"), nbuy=("nbuy", "sum"), nsell=("nsell", "sum"), bad=("bad", "any"),
                   key=("key", "max"), slot=("slot", "max"), buykey=("buykey", "min")).reset_index()
        sw_only = evs[evs["swap"].astype(bool)]
        pp = sw_only.groupby(["pair", "txk"], sort=False).agg(pre=("pre", "first"), post=("post", "first"))
        tx = tx.merge(pp, left_on=["pair", "txk"], right_index=True, how="left")
        tx = tx.sort_values(["pair", "txk"], kind="stable").reset_index(drop=True)
        c = self.carry.reindex(tx["pair"].unique())
        seen = c["bal"].notna()
        start = c["bal"].fillna(0).astype(np.int64)
        ok0 = c["ok"].where(seen, True).astype(bool)
        ver0 = c["ver"].where(seen, False).astype(bool)
        tx["start"] = tx["pair"].map(start).to_numpy()
        tx["after"] = tx["start"] + tx.groupby("pair")["delta"].cumsum()
        tx["before"] = tx["after"] - tx["delta"]
        sw_ = tx["swap"].to_numpy(bool)
        mism = sw_ & ((tx["pre"].to_numpy() != tx["before"].to_numpy()) | (tx["post"].to_numpy() != tx["after"].to_numpy()))
        mism |= tx["after"].to_numpy() < 0
        tx["mism"] = mism
        # anchored balance: the last swap's reported post plus later movements
        anchor = np.where(sw_, tx["post"].to_numpy() - tx["after"].to_numpy(), np.nan)
        tx["anchor"] = anchor
        tx["anchor"] = tx.groupby("pair")["anchor"].ffill().fillna(0)
        tx["bal"] = (tx["after"] + tx["anchor"]).astype(np.int64)
        zero_by_swap = sw_ & (tx["post"].to_numpy() == 0)
        tx["closekey"] = np.where(tx["bal"].to_numpy() == 0, tx["key"].to_numpy(), -1)
        tx["zsw"] = zero_by_swap
        agg = tx.groupby("pair", sort=False).agg(
            cash=("cash", "sum"), paid=("paid", "sum"), xin=("xin", "sum"), nbuy=("nbuy", "sum"),
            nsell=("nsell", "sum"), bad=("bad", "any"), mism=("mism", "any"), anyswap=("swap", "any"),
            end=("bal", "last"), lastzsw=("zsw", "last"), lastkey=("key", "max"), lastslot=("slot", "max"),
            buykey=("buykey", "min"), closekey=("closekey", "max"), n=("key", "size"))
        agg["ok0"] = ok0.reindex(agg.index).to_numpy()
        agg["ver0"] = ver0.reindex(agg.index).to_numpy()
        agg["start"] = start.reindex(agg.index).to_numpy()
        clean = agg["ok0"] & ~agg["mism"] & ~agg["bad"]
        agg["dirty"] = ~clean
        self.stats.setdefault("dirty_reasons", {"carried_unknown": 0, "balance_mismatch_or_unseen_start": 0, "unvalued_or_mint": 0})
        dr = self.stats["dirty_reasons"]
        dr["carried_unknown"] += int((~agg["ok0"]).sum())
        dr["balance_mismatch_or_unseen_start"] += int((agg["ok0"] & agg["mism"]).sum())
        dr["unvalued_or_mint"] += int((agg["ok0"] & ~agg["mism"] & agg["bad"]).sum())
        closed = (agg["end"] == 0)
        agg["end_ok"] = clean | (closed & agg["lastzsw"])
        agg["end_ver"] = (agg["ver0"] | (agg["anyswap"] & clean)) | closed
        self.acc.append(agg[["cash", "paid", "xin", "nbuy", "nsell", "dirty", "buykey", "closekey", "lastkey",
                             "lastslot", "n", "end_ver"]])
        if len(self.acc) >= 8:
            self._collapse_acc()
        # carry update
        keep = self.carry[~self.carry.index.isin(agg.index)]
        new = pd.DataFrame({"bal": agg["end"].astype(np.int64), "ok": agg["end_ok"].astype(bool),
                            "ver": agg["end_ver"].astype(bool),
                            "mark": self.carry["mark"].reindex(agg.index).fillna(0.0).to_numpy()}, index=agg.index)
        new = new[new["bal"] > 0]
        self.carry = pd.concat([keep, new])

    def _collapse_acc(self):
        """Merges the per-unit aggregates of the day into one frame (keeps memory flat over a day)."""
        a = pd.concat(self.acc)
        g = a.groupby(level=0, sort=False)
        self.acc = [g.agg(cash=("cash", "sum"), paid=("paid", "sum"), xin=("xin", "sum"), nbuy=("nbuy", "sum"),
                          nsell=("nsell", "sum"), dirty=("dirty", "any"), buykey=("buykey", "min"),
                          closekey=("closekey", "max"), lastkey=("lastkey", "max"), lastslot=("lastslot", "max"),
                          n=("n", "sum"), end_ver=("end_ver", "last"))]

    # ---------------------------------------------------------------- day end
    def finish_day(self):
        """Closes the day: end marks, the owner-mint-day rows and the §3/§5 raw tables. Returns a dict."""
        day = self.prev_day
        if self.acc:
            self._collapse_acc()
            acc = self.acc[0]
        else:
            acc = pd.DataFrame(columns=["cash", "paid", "xin", "nbuy", "nsell", "dirty", "buykey", "closekey",
                                        "lastkey", "lastslot", "n", "end_ver"])
        ds = self.day_start
        idx = acc.index.union(ds.index)
        rows = pd.DataFrame(index=idx)
        rows["start_bal"] = ds["bal"].reindex(idx).fillna(0).astype(np.int64)
        rows["start_mark"] = ds["mark"].reindex(idx).fillna(0.0)
        start_ok = ds["ok"].reindex(idx).fillna(True).astype(bool)
        for c_ in ("cash", "paid", "xin"):
            rows[c_] = acc[c_].reindex(idx).fillna(0.0).astype(np.float64)
        for c_ in ("nbuy", "nsell", "n"):
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
            "buys": pd.concat(self.buys, ignore_index=True) if self.buys else pd.DataFrame(),
            "big": pd.concat(self.big, ignore_index=True) if self.big else pd.DataFrame(),
            "xfers": pd.concat(self.xfers, ignore_index=True) if self.xfers else pd.DataFrame(
                columns=["frm", "to", "mint", "value", "key"]),
            "cg": cg,
            "wedges": _uniq_edges(self.wedges, 2),
            "tedges": _tedges(self.tedges, self.pump_mints | self._pump_suffix()),
            "w_present": self.w_present,
            "owners": np.fromiter(self.owners_day, np.int64, len(self.owners_day)),
            "excluded": {k: np.fromiter(s, np.int64, len(s)) for k, s in self.ex_seen.items()},
            "hub_excluded_nodes": self._all_excluded_ids(),
        }
        self.prev_day = None
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
