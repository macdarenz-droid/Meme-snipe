"""Liquidation probe (H3), stage 1: find and classify large sales. No return is computed (PREREG.md).

  H3_SCRATCH=<dir> python3 -I stage1.py run          # candidate bars in seeded order, early check, gate
  H3_SCRATCH=<dir> python3 -I stage1.py summary      # counts from the saved table

Inputs (all under H3_SCRATCH): eligible_full.json, bars/<pool>.json. Output: H3_SCRATCH/stage1/*.json and
research/liquidation-probe/stage1_table.json(.sha256).
"""
import bisect, hashlib, json, math, os, struct, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'research', 'execution-audit'))
import hel                                    # noqa: E402
import heli                                   # noqa: E402  (decoding helpers only; heli.rpc is never called)

S = hel.SCRATCH
OUT = os.path.join(S, 'stage1')
WALL = 1789999200                             # 2026-09-21T14:00:00Z
DEC_START = 1784678400                        # 2026-07-22T00:00:00Z
CUTOFF = 1789997340                           # 2026-09-21T13:29:00Z
BAR, DAY = 300, 86400
DROP = 0.03                                   # step 4: the sale's own reserve-implied drop
SCREEN = 0.01                                 # step 1 bar screen on trade prints (PREREG F23)
FULL = 0.10
WIN = 600
BOT_N = 50
AGE = 7 * DAY
HOLD = 3600
EARLY_BARS = 2000
TARGET_EVENTS = 150
WSOL = 'So11111111111111111111111111111111111111112'
USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
EXCL_MINTS = {WSOL, USDC, USDT, 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
              'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
              'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm'}
PUMPSWAP = heli.AMM
RAY_VENUES = ('Raydium AMM v4', 'Raydium CPMM')

# ---------- universe and bars ----------
def universe():
    pools = {}
    for u in json.load(open(os.path.join(S, 'eligible_full.json'))):
        if u['best'] in 'AB':
            days = sorted(int(d) for d in u['days'])
            pools[u['pool']] = {'pool': u['pool'], 'mint': u['mint'], 'symbol': u.get('symbol'), 'venue': 'PS',
                                'days': set(days), 'range': (max(1784419200, days[0] - 3600), min(WALL, days[-1] + DAY))}
    for u in json.load(open(os.path.join(ROOT, 'research/cheap-venue-probe/universe.json')))['pools']:
        if u['venue'] in RAY_VENUES:
            pools[u['pool']] = {'pool': u['pool'], 'mint': u['quote'] if u['base'] == WSOL else u['base'],
                                'symbol': u.get('symbol'), 'venue': 'RAY', 'ray_type': u['venue'],
                                'days': None, 'range': (DEC_START - 3600, WALL)}
    return pools

def raw_bars(pool):
    p = os.path.join(S, 'bars', pool + '.json')
    if not os.path.exists(p):
        return []
    return sorted(([int(r[0])] + [float(x) for x in r[1:6]]) for r in json.load(open(p)) if int(r[0]) + BAR <= WALL)

def seed_key(pool, start):
    return hashlib.sha256(f'H3-v1|{pool}|{start}'.encode()).hexdigest()

def candidate_bars(pools, bars):
    out = []
    for p, u in pools.items():
        rb = bars[p]
        for i, (ts, o, h, l, c, v) in enumerate(rb):
            if ts < DEC_START or ts + BAR > WALL:
                continue
            if u['days'] is not None and (ts - ts % DAY) not in u['days']:
                continue
            M = max(h, rb[i - 1][4]) if i > 0 else h
            if M > 0 and (M - l) / M >= SCREEN:
                out.append({'pool': p, 'start': ts, 'M': M, 'low': l, 'key': seed_key(p, ts)})
    out.sort(key=lambda b: b['key'])
    return out

# ---------- transaction helpers ----------
def keys_of(tx):
    k = list(tx['transaction']['message']['accountKeys'])
    la = tx['meta'].get('loadedAddresses') or {}
    return k + la.get('writable', []) + la.get('readonly', [])

def sig_of(tx):
    return tx['transaction']['signatures'][0]

def owner_bal(tx, mint):
    """{owner: (pre, post)} raw balance of `mint` summed over each owner's token accounts present in the tx."""
    pre, post = {}, {}
    for side, d in (('preTokenBalances', pre), ('postTokenBalances', post)):
        for b in tx['meta'].get(side) or []:
            if b['mint'] == mint and b.get('owner'):
                d[b['owner']] = d.get(b['owner'], 0) + int(b['uiTokenAmount']['amount'])
    return {o: (pre.get(o, 0), post.get(o, 0)) for o in set(pre) | set(post)}

def mints_of_owner(tx, owner):
    m = set()
    for side in ('preTokenBalances', 'postTokenBalances'):
        for b in tx['meta'].get(side) or []:
            if b.get('owner') == owner:
                m.add(b['mint'])
    return m

def proceeds(tx, owner):
    """Owner's SOL (native + WSOL, lamports) and USDC+USDT (raw) change in the tx; F12."""
    keys = keys_of(tx)
    sol = 0
    if owner in keys:
        i = keys.index(owner)
        sol += tx['meta']['postBalances'][i] - tx['meta']['preBalances'][i]
    w = owner_bal(tx, WSOL).get(owner, (0, 0))
    sol += w[1] - w[0]
    st = 0
    for m in (USDC, USDT):
        a = owner_bal(tx, m).get(owner, (0, 0))
        st += a[1] - a[0]
    return sol, st

def has_proceeds(tx, owner):
    sol, st = proceeds(tx, owner)
    return sol > 0 or st > 0

def order(tx):
    return (tx['slot'], tx['transactionIndex'])

# ---------- PumpSwap ----------
def ps_events(tx, pool):
    """Decoded Buy/Sell events of `pool` in the tx, with coin_creator; pre/post effective reserves."""
    out = []
    keys = keys_of(tx)
    for grp in tx['meta'].get('innerInstructions') or []:
        for ix in grp['instructions']:
            if keys[ix['programIdIndex']] != PUMPSWAP:
                continue
            data = heli.b58decode(ix['data'])
            ev = heli.decode_swap(data)
            if not ev or ev['pool'] != pool:
                continue
            body = data[16:]
            p = 14 * 8 + 32 + 32 * 5
            ev['coin_creator'] = heli.b58encode(body[p:p + 32]) if len(body) >= p + 32 else None
            B0, Q0, V = ev['pool_base_token_reserves'], ev['pool_quote_token_reserves'], ev.get('virtual_quote_reserves') or 0
            if ev['kind'] == 'buy':
                B1, Q1 = B0 - ev['amount_base'], Q0 + ev['quote_amount_fee_adj']
            else:
                B1, Q1 = B0 + ev['amount_base'], Q0 - ev['quote_amount_fee_adj']
            ev.update(B0=B0, Q0=Q0, B1=B1, Q1=Q1, V=V)
            out.append(ev)
    return out

def ps_sale(tx, pool):
    evs = ps_events(tx, pool)
    if not evs:
        return None
    a, b = evs[0], evs[-1]
    p0 = (a['Q0'] + a['V']) / a['B0'] if a['B0'] > 0 else None
    p1 = (b['Q1'] + b['V']) / b['B1'] if b['B1'] > 0 else None
    net_in = sum(e['amount_base'] * (1 if e['kind'] == 'sell' else -1) for e in evs)
    return {'p0': p0, 'p1': p1, 'net_in': net_in, 'sol_res0': a['Q0'], 'virt': a['V'],
            'coin_creator': a.get('coin_creator'), 'n_ev': len(evs)}

# ---------- Raydium ----------
_vaults = {}
_vlock = __import__('threading').Lock()

def ray_vaults(pool, mint, txs):
    """F10: the meme and WSOL vaults: token accounts whose addresses are in the pool account's data and appear in a
    pool transaction's token balances with the meme mint or WSOL."""
    with _vlock:
        return _ray_vaults(pool, mint, txs)

def _ray_vaults(pool, mint, txs):
    if pool in _vaults:
        return _vaults[pool]
    path = os.path.join(OUT, 'vaults.json')
    saved = json.load(open(path)) if os.path.exists(path) else {}
    if pool in saved:
        _vaults[pool] = saved[pool]
        return saved[pool]
    acc = hel.rpc('getAccountInfo', [pool, {'encoding': 'base64'}])
    import base64
    if not acc or not acc.get('value'):
        return {'meme': None, 'sol': None, 'program': None}
    data = base64.b64decode(acc['value']['data'][0])
    found = {}
    for tx in txs:
        keys = keys_of(tx)
        for b in (tx['meta'].get('preTokenBalances') or []) + (tx['meta'].get('postTokenBalances') or []):
            addr = keys[b['accountIndex']]
            if b['mint'] in (mint, WSOL) and heli.b58decode(addr).rjust(32, b'\0') in data:
                found[b['mint']] = {'addr': addr, 'owner': b.get('owner')}
        if mint in found and WSOL in found:
            break
    v = {'meme': found.get(mint), 'sol': found.get(WSOL), 'program': acc['value'].get('owner')}
    if v['meme'] and v['sol']:                 # only a complete result is kept; a later bar retries
        _vaults[pool] = v
        saved[pool] = v
        hel._write_json(path, saved)
    return v

def vault_bal(tx, addr):
    keys = keys_of(tx)
    pre = post = None
    for side in ('preTokenBalances', 'postTokenBalances'):
        for b in tx['meta'].get(side) or []:
            if keys[b['accountIndex']] == addr:
                if side == 'preTokenBalances':
                    pre = int(b['uiTokenAmount']['amount'])
                else:
                    post = int(b['uiTokenAmount']['amount'])
    return pre, post

def ray_sale(tx, v):
    if not v['meme'] or not v['sol']:
        return None
    m0, m1 = vault_bal(tx, v['meme']['addr'])
    s0, s1 = vault_bal(tx, v['sol']['addr'])
    if None in (m0, m1, s0, s1):
        return None
    return {'p0': s0 / m0 if m0 else None, 'p1': s1 / m1 if m1 else None, 'net_in': m1 - m0,
            'sol_res0': s0, 'virt': 0, 'coin_creator': None, 'n_ev': None}

# ---------- seller window ----------
def window_txs(owner, t, sale):
    """Owner's successful transactions with block time in [t - 600, t] (tokenAccounts balanceChanged), ascending.
    Returns (txs strictly before the sale in (slot, index) order, n_before, complete)."""
    rows, complete = hel.gtfa(owner, {'blockTime': {'gte': t - WIN, 'lte': t}, 'status': 'succeeded',
                                      'tokenAccounts': 'balanceChanged'}, limit=100, max_pages=3)
    before = [r for r in rows if order(r) < order(sale)]
    return sorted(before, key=order), len(before), complete

def exits_in(txs, owner):
    """Per mint: (holdings before its first sale in the sequence, min balance after a sale with proceeds).
    A 'sale' is a tx where the owner's balance of the mint falls and F12 holds."""
    st = {}
    for tx in txs:
        pr = has_proceeds(tx, owner)
        for m in mints_of_owner(tx, owner):
            if m in EXCL_MINTS:
                continue
            pre, post = owner_bal(tx, m).get(owner, (0, 0))
            if post < pre and pr:
                s = st.setdefault(m, {'hold': pre, 'full': False, 'last_post': post})
                s['last_post'] = post
                if post <= FULL * s['hold']:
                    s['full'] = True
    return st

# ---------- per bar ----------
def process_bar(b, pools, cap):
    u = pools[b['pool']]
    s0 = b['start']
    txs, _ = hel.gtfa(u['pool'], {'blockTime': {'gte': s0, 'lt': s0 + BAR}, 'status': 'succeeded'}, limit=100, cap=cap)
    txs.sort(key=order)
    rec = {'pool': u['pool'], 'start': s0, 'key': b['key'], 'n_tx': len(txs), 'sales': []}
    v = None
    if u['venue'] == 'RAY':
        v = ray_vaults(u['pool'], u['mint'], txs) if txs else None
        if v and (not v['meme'] or not v['sol']):
            rec['note'] = 'vaults not found'
    for tx in txs:
        sl = ps_sale(tx, u['pool']) if u['venue'] == 'PS' else (ray_sale(tx, v) if v else None)
        if not sl or sl['net_in'] <= 0 or not sl['p0'] or sl['p1'] is None:
            continue
        drop = 1 - sl['p1'] / sl['p0']
        if drop < DROP:
            continue
        t = tx['blockTime']
        sale = {'sig': sig_of(tx), 'slot': tx['slot'], 'idx': tx['transactionIndex'], 't': t,
                'drop': drop, 'sol_res0': sl['sol_res0'], 'virt': sl['virt'], 'coin_creator': sl['coin_creator'],
                'n_ev': sl['n_ev'], 'venue': u['venue'], 'mint': u['mint'], 'pool': u['pool']}
        excl_owner = {u['pool'], PUMPSWAP, (v or {}).get('program')} | (
            {v['meme']['owner'], v['sol']['owner']} if v and v['meme'] and v['sol'] else set())
        deltas = {o: post - pre for o, (pre, post) in owner_bal(tx, u['mint']).items() if o not in excl_owner}
        seller = min(deltas, key=lambda o: (deltas[o], o)) if deltas else None
        if seller is None or deltas[seller] >= 0:
            sale['class'] = 'no seller found'
            rec['sales'].append(sale)
            continue
        pre, post = owner_bal(tx, u['mint'])[seller]
        sol, st = proceeds(tx, seller)
        sale.update(seller=seller, pre=pre, post=post, sol_delta=sol, stable_delta=st, fee_payer=keys_of(tx)[0])
        if t > CUTOFF:
            sale['class'] = 'after cutoff'
            rec['sales'].append(sale)
            continue
        if not (sol > 0 or st > 0):
            sale['class'] = 'partial'
            sale['why'] = 'no SOL or stable proceeds'
            rec['sales'].append(sale)
            continue
        before, n_before, complete = window_txs(seller, t, tx)
        sale['n_window'] = n_before
        if n_before > BOT_N:
            sale['class'] = 'excluded'
            sale['why'] = 'bot (>50 tx in window)'
            rec['sales'].append(sale)
            continue
        ex = exits_in(before + [tx], seller)
        cur = ex.get(u['mint'])
        hold = cur['hold'] if cur else pre
        sale['hold_before'] = hold
        if not (post <= FULL * hold):
            sale['class'] = 'partial'
            sale['why'] = 'not a full exit'
            rec['sales'].append(sale)
            continue
        others = sorted(m for m, s in exits_in(before, seller).items() if s['full'] and m != u['mint'])
        sale['k'] = len(others)
        sale['other_mints'] = others
        sale['class'] = 'full exit'
        rec['sales'].append(sale)
    return rec

# ---------- exclusions on full exits ----------
_creator = {}

def mint_creator(mint):
    if mint in _creator:
        return _creator[mint]
    rows, _ = hel.gtfa(mint, {}, details='full', order='asc', limit=1, max_pages=1)
    c = keys_of(rows[0])[0] if rows else None
    _creator[mint] = c
    return c

def wallet_old(owner, t):
    rows, _ = hel.gtfa(owner, {'blockTime': {'lte': t - AGE}}, details='signatures', order='desc', limit=1, max_pages=1)
    return bool(rows)

def held_1h(owner, mint, t):
    rows, _ = hel.gtfa(owner, {'blockTime': {'lte': t - HOLD}, 'tokenTransfer': {'mint': mint, 'direction': 'in'}},
                       details='signatures', order='desc', limit=1, max_pages=1)
    return bool(rows)

def hold_validate(owner, mint, t):
    """F19: the latest incoming transfer of the mint at or before t must raise the owner's balance of the mint."""
    try:
        rows, _ = hel.gtfa(owner, {'blockTime': {'lte': t}, 'tokenTransfer': {'mint': mint, 'direction': 'in'}},
                           details='full', order='desc', limit=1, max_pages=1)
    except RuntimeError as e:
        return {'ok': False, 'why': hel.scrub(e)[:120]}
    if not rows:
        return {'ok': False, 'why': 'no transfer returned'}
    pre, post = owner_bal(rows[0], mint).get(owner, (0, 0))
    return {'ok': post > pre, 'sig': sig_of(rows[0]), 'pre': pre, 'post': post}

def exclusions(sale, state):
    if 'excl' in sale:
        return
    e = {}
    e['creator'] = sale['seller'] in {sale.get('coin_creator'), mint_creator(sale['mint'])}
    e['young'] = not wallet_old(sale['seller'], sale['t'])
    if len(state['hold_checks']) < 20 and state['hold_rule'] is None:
        r = hold_validate(sale['seller'], sale['mint'], sale['t'])
        r['sig_sale'] = sale['sig']
        state['hold_checks'].append(r)
        if len(state['hold_checks']) == 20:
            state['hold_rule'] = all(x['ok'] for x in state['hold_checks'])
    sale['excl'] = e

def apply_hold(sale, state):
    if state['hold_rule'] and 'held_1h' not in sale['excl']:
        sale['excl']['held_1h'] = held_1h(sale['seller'], sale['mint'], sale['t'])

def group(sale, state):
    if sale.get('class') != 'full exit':
        return sale.get('class')
    if 'excl' not in sale:
        return 'unchecked: credit cap'
    e = sale['excl']
    if e.get('creator'):
        return 'excluded: creator'
    if e.get('young'):
        return 'excluded: wallet < 7 days'
    if state['hold_rule'] and e.get('held_1h') is False:
        return 'excluded: held < 1 h'
    return 'H3 event' if sale['k'] >= 2 else ('two-coin' if sale['k'] == 1 else 'single-coin')

# ---------- market state ----------
def m60_fn(pools, bars):
    ser = {}
    for p, u in pools.items():
        rb = bars[p]
        if rb:
            ser[p] = ([r[0] for r in rb], [r[4] for r in rb], u['range'])

    def close_at(p, T):                    # close of the last raw bar ending at or before T
        ts, cs, _ = ser[p]
        i = bisect.bisect_right(ts, T - BAR) - 1
        return cs[i] if i >= 0 else None

    def m60(t):
        T1 = t - t % BAR
        T0 = T1 - 3600
        rs = []
        for p, (ts, cs, rng) in ser.items():
            if rng[0] > T0 - BAR or rng[1] < T1:
                continue
            a, b = close_at(p, T0), close_at(p, T1)
            if a and b and a > 0 and b > 0:
                rs.append(math.log(b / a))
        return (sum(rs) / len(rs), len(rs)) if rs else (None, 0)
    return m60

# ---------- matching (for the gate) ----------
def drop_bin(d):
    return 0 if d < 0.05 else (1 if d < 0.10 else 2)

def terciles(vals):
    s = sorted(vals)
    return (s[len(s) // 3], s[2 * len(s) // 3]) if s else (0, 0)

def tbin(x, cuts):
    return 0 if x < cuts[0] else (1 if x < cuts[1] else 2)

def match(sales):
    """Up to 5 single-coin controls per H3 event (PREREG Controls): exact drop bin, venue, depth tercile, m60
    tercile; same pool first, then nearest time within 7 days; one control per seller; seeded ties."""
    large = [s for s in sales if s.get('m60') is not None]
    dcut = terciles([s['sol_res0'] for s in large])
    mcut = terciles([s['m60'] for s in large])
    cell = lambda s: (drop_bin(s['drop']), s['venue'], tbin(s['sol_res0'], dcut), tbin(s['m60'], mcut))
    ctrl = [s for s in large if s['group'] == 'single-coin']
    out = {}
    for ev in [s for s in large if s['group'] == 'H3 event']:
        c = [x for x in ctrl if cell(x) == cell(ev) and abs(x['t'] - ev['t']) <= 7 * DAY]
        c.sort(key=lambda x: (x['pool'] != ev['pool'], abs(x['t'] - ev['t']),
                              hashlib.sha256(f"H3-v1|{ev['sig']}|{x['sig']}".encode()).hexdigest()))
        pick, sellers = [], set()
        for x in c:
            if x['seller'] in sellers:
                continue
            pick.append(x['sig'])
            sellers.add(x['seller'])
            if len(pick) == 5:
                break
        out[ev['sig']] = pick
    return out, {'depth_cuts': dcut, 'm60_cuts': mcut}

# ---------- driver ----------
def load_state():
    p = os.path.join(OUT, 'state.json')
    if os.path.exists(p):
        return json.load(open(p))
    return {'done': {}, 'hold_checks': [], 'hold_rule': None, 'early': None, 'stop': None}

def save_state(st):
    p = os.path.join(OUT, 'state.json')
    hel._write_json(p, st)

def all_sales(st):
    return [s for k in sorted(st['done']) for s in st['done'][k]['sales']]

def counts(st):
    from collections import Counter
    return Counter(s.get('group') for s in all_sales(st))

def run():
    os.makedirs(OUT, exist_ok=True)
    pools = universe()
    bars = {p: raw_bars(p) for p in pools}
    missing = [p for p in pools if not bars[p]]
    cands = candidate_bars(pools, bars)
    m60 = m60_fn(pools, bars)
    json.dump({'pools': len(pools), 'ps': sum(u['venue'] == 'PS' for u in pools.values()),
               'ray': sum(u['venue'] == 'RAY' for u in pools.values()), 'no_bars': missing,
               'candidate_bars': len(cands)}, open(os.path.join(OUT, 'universe_summary.json'), 'w'), indent=1)
    print('pools', len(pools), 'no bars', len(missing), 'candidate bars', len(cands), flush=True)
    st = load_state()
    ordk = [b['key'] for b in cands]
    pos = {k: i for i, k in enumerate(ordk)}

    def finish_sales(upto):
        for k in ordk[:upto]:
            for s in st['done'][k]['sales']:
                if s.get('class') == 'full exit':
                    exclusions(s, st)
        for k in ordk[:upto]:
            for s in st['done'][k]['sales']:
                if s.get('class') == 'full exit':
                    apply_hold(s, st)
                if 'm60' not in s:
                    s['m60'], s['m60_n'] = m60(s['t'])
                s['group'] = group(s, st)

    def process(upto, cap):
        todo = [b for b in cands[:upto] if b['key'] not in st['done']]
        with ThreadPoolExecutor(4) as ex:
            for i in range(0, len(todo), 40):
                for rec in ex.map(lambda b: process_bar(b, pools, cap), todo[i:i + 40]):
                    st['done'][rec['key']] = rec
                save_state(st)
                print('bars', len(st['done']), 'credits', hel.ledger()['credits'], flush=True)

    def n_events(upto):
        return sum(1 for k in ordk[:upto] for s in st['done'][k]['sales'] if s.get('group') == 'H3 event')

    try:
        first = min(EARLY_BARS, len(cands))
        process(first, hel.STAGE1_CAP)
        finish_sales(first)
        if len(st['hold_checks']) < 20 and st['hold_rule'] is None:
            st['hold_rule'] = False
            st['hold_rule_note'] = f"only {len(st['hold_checks'])} full-exit sales by the early check; rule dropped"
            finish_sales(first)
        save_state(st)
        if st['early'] is None and len(cands) > EARLY_BARS:
            spent = hel.ledger()['credits']
            cbar = spent / EARLY_BARS
            B = EARLY_BARS + math.floor((hel.STAGE1_CAP - spent) / cbar)
            E = n_events(first)
            P = E * min(len(cands), B) / EARLY_BARS
            st['early'] = {'bars': EARLY_BARS, 'credits': spent, 'c_bar': cbar, 'B': B, 'events': E,
                           'candidate_bars': len(cands), 'P': P, 'stop': P < 100}
            save_state(st)
            print('early check', st['early'], flush=True)
        if st['early'] and st['early']['stop']:
            st['stop'] = 'early check: P < 100'
        else:
            n = first
            while n < len(cands):
                if n_events(n) >= TARGET_EVENTS:
                    st['stop'] = '150 events'
                    break
                n2 = min(len(cands), n + 200)
                process(n2, hel.STAGE1_CAP)
                finish_sales(n2)
                n = n2
            st['stop'] = st['stop'] or 'end of list'
    except hel.CapReached as e:
        st['stop'] = 'stage-1 credit cap: ' + str(e)
    done_n = 0
    for k in ordk:
        if k not in st['done']:
            break
        done_n += 1
    try:
        finish_sales(done_n)
    except hel.CapReached as e:                # sales left without checks are grouped 'unchecked: credit cap'
        st['stop'] = (st['stop'] or '') + '; final checks hit the cap: ' + str(e)
        for k in ordk[:done_n]:
            for s in st['done'][k]['sales']:
                if 'm60' not in s:
                    s['m60'], s['m60_n'] = m60(s['t'])
                s['group'] = group(s, st)
    # "until 150 events": the gate prefix ends at the bar that holds the 150th event in seeded order
    n_ev = 0
    for i, k in enumerate(ordk[:done_n]):
        n_ev += sum(1 for s in st['done'][k]['sales'] if s.get('group') == 'H3 event')
        if n_ev >= TARGET_EVENTS:
            done_n = i + 1
            break
    st['processed_prefix'] = done_n
    save_state(st)
    gate(st, ordk[:done_n])

def gate(st, keys):
    sales = [s for k in keys for s in st['done'][k]['sales']]
    ctl, cuts = match(sales)
    evs = [s for s in sales if s.get('group') == 'H3 event']
    ok = [s for s in evs if len(ctl.get(s['sig'], [])) >= 2]
    days = {s['t'] - s['t'] % DAY for s in ok}
    from collections import Counter
    per_coin = Counter(s['mint'] for s in ok)
    top = max(per_coin.values()) / len(ok) if ok else None
    g = {'events': len(evs), 'events_with_2_controls': len(ok), 'dropped_for_controls': len(evs) - len(ok),
         'days': len(days), 'top_coin_share': top, 'per_coin': dict(per_coin), 'cuts': cuts,
         'pass': len(ok) >= 100 and len(days) >= 30 and (top or 1) <= 0.30, 'controls': ctl}
    st['gate'] = g
    save_state(st)
    table = {'bars': [{k2: st['done'][k][k2] for k2 in ('pool', 'start', 'key', 'n_tx') if k2 in st['done'][k]}
                      | ({'note': st['done'][k]['note']} if 'note' in st['done'][k] else {}) for k in keys],
             'sales': sales, 'hold_checks': st['hold_checks'], 'hold_rule': st['hold_rule'],
             'hold_rule_note': st.get('hold_rule_note'), 'early': st['early'], 'stop': st['stop'], 'gate': g,
             'credits': hel.ledger()}
    p = os.path.join(HERE, 'stage1_table.json')
    json.dump(table, open(p, 'w'), sort_keys=True, separators=(',', ':'))
    h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    open(p + '.sha256', 'w').write(h + '  stage1_table.json\n')
    print('gate', {k: v for k, v in g.items() if k not in ('controls', 'per_coin')}, flush=True)
    print('groups', counts(st), flush=True)

if __name__ == '__main__':
    {'run': run, 'summary': lambda: print(counts(load_state()))}[sys.argv[1]]()
