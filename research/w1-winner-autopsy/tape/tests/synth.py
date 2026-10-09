"""Random synthetic tape units in the shared tape's file format, at any size (columnar, so a unit of real size,
about 250,000 PumpSwap rows, is quick to write). Used by the reader equality test (small units) and by the memory
check of the scoring stages (units sized like real ones). Balances carry from unit to unit, so positions stay open.

  python3 tests/synth.py OUT_ROOT DAY N_UNITS [--scale 1.0] [--seed 1]    (writes OUT_ROOT/DAY/<lo>-<hi>/research)
"""
import argparse
import hashlib
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # the tape/ directory (w1)

import numpy as np
import pandas as pd
import zstandard

from w1.addr import SYSTEM_PROGRAM, WSOL, on_curve
from w1.load import AMM_COLS, CURVE_COLS

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
T_COLS = ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "mint", "kind", "from_owner", "to_owner", "amount",
          "from_account", "to_account"]
W_COLS = ["slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "from", "to", "lamports", "signer", "signature"]
COV_COLS = ["mint", "scope", "slot", "reason", "count", "tx_idx"]
# rows per unit on 2026-09-11 (unit 446013000-446017499)
REAL = {"amm": 247_815, "curve": 25_185, "t": 52_067, "w": 105_672, "creates": 300, "cov": 40}


def _b58(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + s


def _addr(tag, curve=True):
    i = 0
    while True:
        a = _b58(hashlib.sha256(f"{tag}/{i}".encode()).digest())
        if on_curve(a) == curve:
            return a
        i += 1


class Tape:
    """One synthetic day: units written in slot order; owners, mints and balances carry over."""

    def __init__(self, root, day, seed=1, scale=1.0, lo=446_013_000, span=4500, owners=None, creates=None, w_link=0.02):
        self.root, self.day, self.scale, self.lo, self.span = root, day, scale, lo, span
        self.rng = np.random.default_rng(seed)
        self.r = random.Random(seed)
        self.seed = seed
        n = REAL
        self.n = {k: max(1, int(v * scale)) for k, v in n.items()}
        if creates:
            self.n["creates"] = creates
        self.owners = [_addr(f"{seed}-o{i}") for i in range(owners or max(20, int(60_000 * scale)))]
        self.mints = []          # (mint, pool, curve, migrated)
        self.bal = {}            # (owner index, mint index) -> tokens
        self.units = 0
        self.bt0 = 1789084800
        self.new_w = 0
        self.w_link = w_link     # share of W rows between two known owners (cluster links)

    def _new_mint(self):
        k = len(self.mints)
        m = _addr(f"{self.seed}-m{k}") [:-4] + "pump" if self.r.random() < 0.8 else _addr(f"{self.seed}-m{k}")
        self.mints.append([m, _addr(f"{self.seed}-p{k}", False), _addr(f"{self.seed}-c{k}", False), False])
        return k

    def unit(self):
        lo = self.lo + self.units * self.span
        hi = lo + self.span - 1
        self.units += 1
        d = os.path.join(self.root, self.day, f"{lo}-{hi}", "research")
        os.makedirs(d, exist_ok=True)
        rng, r, n = self.rng, self.r, self.n
        bt = lambda s: self.bt0 + (s - self.lo) * 2 // 5
        ev = []
        for _ in range(n["creates"]):
            k = self._new_mint()
            s = int(rng.integers(lo, hi + 1))
            m = self.mints[k]
            ev.append({"slot": s, "block_time": bt(s), "tx_idx": 0, "ev_idx": 0, "event": "CreateEvent",
                       "fields": {"mint": m[0], "bonding_curve": m[2], "creator": self.owners[r.randrange(len(self.owners))],
                                  "token_total_supply": str(10**15)}, "signer": "", "program": "pump"})
            if r.random() < 0.05:
                m[3] = True
                ev.append({"slot": s + 1, "block_time": bt(s + 1), "tx_idx": 0, "ev_idx": 0,
                           "event": "CompletePumpAmmMigrationEvent",
                           "fields": {"mint": m[0], "pool": m[1], "bonding_curve": m[2]}, "signer": "", "program": "pump"})
        nm, no = len(self.mints), len(self.owners)
        # swaps: (slot, tx) per row; owners Zipf-like so some trade a lot
        ns = n["amm"] + n["curve"]
        slot = np.sort(rng.integers(lo, hi + 1, ns))
        first = np.searchsorted(slot, slot, side="left")
        tx = 2 * (np.arange(ns) - first) + 1          # one swap per transaction, key order = row order
        own = np.minimum((rng.pareto(1.2, ns) * no / 50).astype(np.int64), no - 1)
        mint = np.minimum((rng.pareto(1.0, ns) * nm / 30).astype(np.int64), nm - 1)
        venue = np.r_[np.ones(n["amm"], int), np.zeros(n["curve"], int)]
        rng.shuffle(venue)
        isbuy = rng.random(ns) < 0.5
        sol = rng.integers(10**6, 3 * 10**9, ns)
        pre, post, tok = np.zeros(ns, np.int64), np.zeros(ns, np.int64), np.zeros(ns, np.int64)
        p_t = n["t"] / ns
        tr = []                                       # (slot, tx, mint, kind, from, to, amount)
        for i in range(ns):
            k = (int(own[i]), int(mint[i]))
            b = self.bal.get(k, 0)
            if not isbuy[i] and b == 0:
                isbuy[i] = True
            t = int(sol[i]) * 1000 if isbuy[i] else (b if r.random() < 0.7 else max(b // 2, 1))
            pre[i], tok[i] = b, t
            post[i] = b + t if isbuy[i] else b - t
            if post[i]:
                self.bal[k] = int(post[i])
            else:
                self.bal.pop(k, None)
            if post[i] and r.random() < p_t:          # the trader moves a third of the balance (or burns it)
                amt = max(int(post[i]) // 3, 1)
                kind = "burn" if r.random() < 0.05 else "transfer"
                to = (k[0] ^ 1) % no                   # the trader's second wallet
                self.bal[k] -= amt
                if not self.bal[k]:
                    self.bal.pop(k)
                if kind == "transfer":
                    self.bal[(to, k[1])] = self.bal.get((to, k[1]), 0) + amt
                tr.append((int(slot[i]), int(tx[i]) + 1, k[1], kind, k[0], to, amt))
        oa = np.array(self.owners, object)
        ma = np.array([m[0] for m in self.mints], object)
        pa = np.array([m[1] for m in self.mints], object)
        acct = np.array([_b58(hashlib.sha256(f"{oa[a]}|{b}".encode()).digest()) for a, b in zip(own, mint)], object)
        fee = rng.integers(5000, 200_000, ns)
        jito = np.where(rng.random(ns) < 0.3, rng.integers(1000, 10**6, ns), 0)
        spre = rng.integers(10**9, 10**11, ns)
        a_ = venue == 1
        c_ = ~a_
        vq = rng.integers(10**10, 10**12, ns)
        base_r = rng.integers(10**14, 10**15, ns)
        amm = pd.DataFrame({c: "" for c in AMM_COLS}, index=range(int(a_.sum())))
        amm["slot"], amm["block_time"], amm["tx_idx"], amm["ev_idx"] = slot[a_], [bt(s) for s in slot[a_]], tx[a_], 0
        amm["signer"], amm["user"], amm["user_token_owner"] = oa[own[a_]], oa[own[a_]], oa[own[a_]]
        amm["tx_fee"], amm["jito_tip"], amm["pool"], amm["base_mint"] = fee[a_], jito[a_], pa[mint[a_]], ma[mint[a_]]
        amm["quote_mint"], amm["side"] = WSOL, np.where(isbuy[a_], "buy", "sell")
        amm["base_amount"], amm["quote_amount"] = tok[a_], sol[a_]
        amm["pool_base_token_reserves"], amm["pool_quote_token_reserves"] = base_r[a_], vq[a_]
        amm["lp_fee_basis_points"], amm["protocol_fee_basis_points"] = 20, 5
        amm["coin_creator_fee_basis_points"], amm["cashback_fee_basis_points"] = 5, 0
        amm["quote_amount_lp_adjusted"], amm["user_quote_amount"] = sol[a_], sol[a_]
        amm["virtual_quote_reserves"] = 0
        amm["ix_name"] = np.where(isbuy[a_], "buy", "")
        amm["user_token_account"], amm["owner_token_pre"], amm["owner_token_post"] = acct[a_], pre[a_], post[a_]
        amm["signer_sol_pre"] = spre[a_]
        amm["signer_sol_post"] = spre[a_] + np.where(isbuy[a_], -sol[a_], sol[a_]) - fee[a_]
        amm["canonical"], amm["protocol"] = 1, 0
        cur = pd.DataFrame({c: "" for c in CURVE_COLS}, index=range(int(c_.sum())))
        cur["slot"], cur["block_time"], cur["tx_idx"], cur["ev_idx"] = slot[c_], [bt(s) for s in slot[c_]], tx[c_], 1
        cur["signer"], cur["user"], cur["user_token_owner"] = oa[own[c_]], oa[own[c_]], oa[own[c_]]
        cur["tx_fee"], cur["jito_tip"], cur["mint"] = fee[c_], jito[c_], ma[mint[c_]]
        cur["is_buy"], cur["sol_amount"], cur["token_amount"] = isbuy[c_].astype(int), sol[c_], tok[c_]
        cur["virtual_sol_reserves"], cur["virtual_token_reserves"] = vq[c_] // 10, base_r[c_]
        cur["real_sol_reserves"], cur["real_token_reserves"] = vq[c_] // 20, base_r[c_] // 2
        cur["fee_basis_points"], cur["fee"] = 95, sol[c_] * 95 // 10000
        cur["creator_fee_basis_points"], cur["creator_fee"] = 30, sol[c_] * 30 // 10000
        cur["cashback_fee_basis_points"], cur["cashback"] = 0, 0
        cur["quote_mint"], cur["ix_name"] = SYSTEM_PROGRAM, np.where(isbuy[c_], "buy", "sell")
        cur["user_token_account"], cur["owner_token_pre"], cur["owner_token_post"] = acct[c_], pre[c_], post[c_]
        cur["signer_sol_pre"] = spre[c_]
        cur["signer_sol_post"] = spre[c_] + np.where(isbuy[c_], -sol[c_], sol[c_]) - fee[c_]
        cur["protocol"] = 0
        ac = lambda o, m: _b58(hashlib.sha256(f"{oa[o]}|{m}".encode()).digest())
        t = pd.DataFrame([(sl, bt(sl), txi, 0, "", ma[m], kind, oa[o], "" if kind == "burn" else oa[to], amt,
                           ac(o, m), "" if kind == "burn" else ac(to, m)) for sl, txi, m, kind, o, to, amt in tr],
                         columns=T_COLS)
        # W: SOL transfers; many counterparties are new addresses (the address vocabulary grows as on the tape)
        nw = n["w"]
        ws = np.sort(rng.integers(lo, hi + 1, nw))
        frm = [oa[x] for x in np.minimum((rng.pareto(1.2, nw) * no / 50).astype(np.int64), no - 1)]
        to = []
        for _ in range(nw):
            if r.random() >= self.w_link:
                self.new_w += 1
                to.append(_b58(hashlib.sha256(f"{self.seed}-w{self.new_w}".encode()).digest()))
            else:
                to.append(oa[r.randrange(no)])
        w = pd.DataFrame({"slot": ws, "block_time": [bt(s) for s in ws], "tx_idx": 0, "outer_ix": 0, "inner_ix": "",
                          "from": frm, "to": to, "lamports": 10**8, "signer": frm, "signature": "x"})
        # unresolved mints drawn uniformly: mostly rarely traded ones
        cov = pd.DataFrame([(ma[r.randrange(nm)], "unresolved", r.randint(lo, hi), "owner_change", 1, 0)
                            for _ in range(n["cov"])], columns=COV_COLS)
        for name, df in (("S_amm", amm), ("S_curve", cur), ("T", t), ("W", w), ("T_coverage", cov)):
            df.to_csv(os.path.join(d, name + ".csv.zst"), index=False, compression="zstd")
        buf = "".join(json.dumps(e) + "\n" for e in sorted(ev, key=lambda e: e["slot"])).encode()
        with open(os.path.join(d, "E.jsonl.zst"), "wb") as f:
            f.write(zstandard.ZstdCompressor().compress(buf))
        return d


def write(root, day, units, scale=1.0, seed=1):
    tp = Tape(root, day, seed=seed, scale=scale)
    return [tp.unit() for _ in range(units)]


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("root")
    p.add_argument("day")
    p.add_argument("units", type=int)
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=1)
    a = p.parse_args()
    for d in write(a.root, a.day, a.units, a.scale, a.seed):
        print(d)
