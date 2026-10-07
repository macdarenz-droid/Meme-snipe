"""PumpSwap swap stream of one pool from getTransactionsForAddress pages, ordered by
(slot, transactionIndex, inner-instruction order). Event layout and reserve rules as in
../execution-audit (pre-swap reserves logged in each event; effective quote = real + virtual)."""
import struct, sys
import hel
from hel import heli

class Swap:
    __slots__ = ('slot', 'idx', 'k', 't', 'sig', 'user', 'kind', 'B0', 'Q0', 'V', 'B1', 'Q1', 'f', 'base', 'qpool', 'quser')
    def key(self):
        return (self.slot, self.idx, self.k)
    def p0(self):
        return price(self.B0, self.Q0, self.V)
    def p1(self):
        return price(self.B1, self.Q1, self.V)

def price(B, Q, V):
    """Marginal price in SOL per whole token (6 decimals)."""
    return ((Q + V) / 1e9) / (B / 1e6) if B > 0 else float('inf')

def _user(data):
    body = data[16:]
    p = 14 * 8 + 32
    return heli.b58encode(body[p:p + 32])

def swaps_of_tx(t, pool):
    out = []
    if not t or not t.get('meta') or t['meta'].get('err') is not None:
        return out
    keys = t['transaction']['message']['accountKeys']
    lw = t['meta'].get('loadedAddresses') or {}
    keys = keys + lw.get('writable', []) + lw.get('readonly', [])
    k = 0
    for grp in t['meta'].get('innerInstructions') or []:
        for ix in grp['instructions']:
            if keys[ix['programIdIndex']] != heli.AMM:
                continue
            raw = heli.b58decode(ix['data'])
            ev = heli.decode_swap(raw)
            if not ev or ev['pool'] != pool:
                continue
            s = Swap()
            s.slot, s.idx, s.k, s.t = t['slot'], t.get('transactionIndex', 0), k, t.get('blockTime')
            k += 1
            s.sig = t['transaction']['signatures'][0]
            s.user = _user(raw)
            s.kind = ev['kind']
            s.B0, s.Q0 = ev['pool_base_token_reserves'], ev['pool_quote_token_reserves']
            s.V = ev.get('virtual_quote_reserves') or 0
            s.f = (ev['lp_fee_bps'] + ev['protocol_fee_bps'] + ev.get('coin_creator_fee_bps', 0)) / 1e4
            s.base = ev['amount_base']
            s.qpool = ev['quote_amount_fee_adj']          # pool quote moves by this (audit fix)
            s.quser = ev['user_quote_amount']             # SOL the user paid (buy) or received (sell)
            if s.kind == 'buy':
                s.B1, s.Q1 = s.B0 - s.base, s.Q0 + s.qpool
            else:
                s.B1, s.Q1 = s.B0 + s.base, s.Q0 - s.qpool
            out.append(s)
    return out

MAX_PAGES = 400

def window(pool, t0, t1):
    """All swaps of `pool` with block time in [t0, t1), ordered; plus the mismatch count of carried reserves.
    Raises hel.WindowTooLarge past MAX_PAGES pages (40,000 transactions)."""
    txs = hel.txs_for_address(pool, t0, t1, max_pages=MAX_PAGES)
    sw = []
    for t in txs:
        try:
            sw += swaps_of_tx(t, pool)
        except (KeyError, IndexError, TypeError) as e:     # unknown layout: counted through reserve mismatches
            print('undecodable tx', t.get('version'), type(e).__name__, file=sys.stderr)
    sw.sort(key=Swap.key)
    mism = sum(1 for a, b in zip(sw, sw[1:]) if a.B1 != b.B0 or abs(a.Q1 - b.Q0) > 2)
    return sw, mism, len(txs)

def buy_tokens(q_sol, s):
    """Tokens (raw units) a buy of q SOL (total paid, fees included) gets against the state after swap s."""
    x = q_sol / (1 + s.f) * 1e9
    return s.B1 * x / (s.Q1 + s.V + x)

def sell_sol(tokens_raw, B, Q, V, f):
    gross = (Q + V) * tokens_raw / (B + tokens_raw)
    return gross * (1 - f) / 1e9

def round_trip_cost(q_sol, s, fixed):
    """Cost share of an immediate buy and sell of q SOL against the state after swap s (fees from s)."""
    x = q_sol / (1 + s.f) * 1e9
    tok = s.B1 * x / (s.Q1 + s.V + x)
    B2, Q2 = s.B1 - tok, s.Q1 + x
    back = sell_sol(tok, B2, Q2, s.V, s.f)
    return 1 - back / q_sol + fixed / q_sol

def last_before(pool, t, back=7 * 86400):
    """The last swap of `pool` with block time < t (looks back up to `back` seconds, newest first)."""
    t1 = int(t)
    lo = t1 - back
    token = None
    for _ in range(20):
        opt = {'transactionDetails': 'full', 'sortOrder': 'desc', 'limit': 20, 'encoding': 'json',
               'maxSupportedTransactionVersion': 0, 'commitment': 'finalized',
               'filters': {'blockTime': {'gte': lo, 'lt': t1}, 'status': 'succeeded'}}
        if token:
            opt['paginationToken'] = token
        res = hel.rpc_v(opt, pool)
        sw = []
        for tx in res.get('data') or []:
            sw += swaps_of_tx(tx, pool)
        if sw:
            return max(sw, key=Swap.key)
        token = res.get('paginationToken')
        if not token or not res.get('data'):
            return None
    return None
