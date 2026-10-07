"""Read-only Helius fetching for the launch probe (rules in PREREG.md).

  LP_SCRATCH=<dir outside repo> python3 -I fetch.py measure <n>          # signature counts only, no returns
  LP_SCRATCH=... python3 -I fetch.py sample    # draws both windows, writes derived/sample_<window>.json
  LP_SCRATCH=... python3 -I fetch.py list      # bonding-curve signature lists; counts and budget check
  LP_SCRATCH=... python3 -I fetch.py fetch     # every successful transaction, decoded to scratch/events/
  LP_SCRATCH=... python3 -I fetch.py slots     # slot length per UTC day

Key hygiene and the credit cap are those of research/execution-audit/heli.py (key only inside its _url(),
errors scrubbed, ledger in the scratch directory, 10 credits counted per call, hard stop at CAP). Raw responses
are cached in LP_SCRATCH, never in the repo.
"""
import json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SCR = os.environ.get('LP_SCRATCH')
if not SCR:
    raise SystemExit('LP_SCRATCH not set (a directory outside the repo)')
if os.path.realpath(SCR).startswith(os.path.realpath(os.path.join(HERE, '..', '..'))):
    raise SystemExit('LP_SCRATCH must be outside the repository')
os.environ['EA_SCRATCH'] = SCR
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'execution-audit'))
import heli, pumpdec
heli.CAP = 1_500_000
heli.MIN_GAP = 0.105                          # at most ~9.5 requests per second
from concurrent.futures import ThreadPoolExecutor
POOL = ThreadPoolExecutor(8)

MINT_AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'
WINDOWS = {                                   # [start, end) unix seconds, UTC
    'measure': (1783641600, 1784505600),      # 2026-07-10 .. 07-20 (outside both windows, sizing only)
    'discovery': (1784678400, 1787270400),    # 2026-07-22 00:00 .. 08-21 00:00
    'validation': (1787270400, 1788739200),   # 2026-08-21 00:00 .. 09-07 00:00
}
WALL = 1790085600                             # 2026-09-21T14:00Z: nothing at or after
DRAW_W = 20                                   # seconds of creates taken before each random anchor
HORIZON = 3900                                # seconds after creation fetched (480-slot entry + 60 min + margin)
DERIVED = os.path.join(HERE, 'derived')

def tx(sig):
    return heli.rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0,
                                             'commitment': 'finalized'}], cache_name='tx_' + sig)

def draw(window, n, seed):
    """Uniform-by-time draw: n random instants in the window; at each, every successful create transaction of
    the mint authority with block time in [bt - DRAW_W, bt), bt = the anchor block's time (within 20 s before
    the instant). Fixed-length windows give every launch the same inclusion probability."""
    t0, t1 = WINDOWS[window]
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        T = rng.randrange(t0 + 60, t1)
        a, slot, bt = heli.anchor_sig(T)
        page = heli.rpc('getSignaturesForAddress', [MINT_AUTH, {'before': a, 'limit': 200, 'commitment': 'finalized'}])
        got = [x for x in page if x['err'] is None and x.get('blockTime') is not None and bt - DRAW_W <= x['blockTime'] < bt]
        if page and page[-1].get('blockTime', 0) >= bt - DRAW_W:
            raise RuntimeError('draw window larger than one page')
        out.append({'T': T, 'anchor_slot': slot, 'bt': bt, 'sigs': [x['signature'] for x in got]})
    return out

def launch(sig):
    """Create transaction -> launch record (None if it holds no pump.fun CreateEvent)."""
    t = tx(sig)
    ev = pumpdec.events(t)
    cr = [e for k, i, e in ev if k == 'create']
    if not cr:
        return None
    c = cr[0]
    assert t.get('transactionIndex') is not None
    return {'sig': sig, 'slot': t['slot'], 'idx': t['transactionIndex'], 'time': t['blockTime'],
            'mint': c['mint'], 'bc': c['bonding_curve'], 'creator': c['creator']}

def bc_sigs(L, before=None):
    """Signatures on the bonding curve from creation to creation + HORIZON, oldest first. Paging starts at a
    `before` anchor just after the horizon (never at today), so nothing after the cut-off is listed."""
    if before is None:
        before = heli.anchor_sig(L['time'] + HORIZON + 30)[0]
    out = []
    while True:
        params = {'until': L['sig'], 'limit': 1000, 'commitment': 'finalized', 'before': before}
        page = heli.rpc('getSignaturesForAddress', [L['bc'], params])
        out += page
        if len(page) < 1000:
            break
        before = page[-1]['signature']
    rows = [x for x in out if x.get('blockTime') is not None and x['blockTime'] <= L['time'] + HORIZON]
    return rows[::-1]

def measure(n):
    """Sizing only: for launches drawn outside both windows, count bonding-curve signatures in the first 60 min."""
    d = draw('measure', n, seed=777)
    res = []
    for w in d:
        for s in w['sigs']:
            L = launch(s)
            if not L:
                continue
            rows = bc_sigs(L)
            n60 = sum(1 for x in rows if x['blockTime'] <= L['time'] + 3600)
            ok = sum(1 for x in rows if x['blockTime'] <= L['time'] + HORIZON and x['err'] is None)
            res.append((n60, ok))
    res.sort()
    print('launches', len(res), 'per draw', len(res) / n)
    print('sigs in 60 min (sorted):', [r[0] for r in res])
    print('successful sigs to horizon: total', sum(r[1] for r in res), 'mean', sum(r[1] for r in res) / max(1, len(res)))
    print(heli.credits())


AMM = heli.AMM
CREATE_POOL = bytes([233, 146, 209, 142, 207, 104, 64, 188])
DRAWS = {'discovery': (300, 20261071), 'validation': (250, 20261072)}
RESERVE = 150_000
EV = os.path.join(SCR, 'events')

def _save(name, obj):
    os.makedirs(DERIVED, exist_ok=True)
    json.dump(obj, open(os.path.join(DERIVED, name), 'w'), indent=0)

def _load(name):
    return json.load(open(os.path.join(DERIVED, name)))

def sample():
    """Draw both windows; read each create transaction; write derived/sample_<window>.json."""
    for w, (n, seed) in DRAWS.items():
        d = draw(w, n, seed)
        sigs = [s for x in d for s in x['sigs']]
        recs = list(POOL.map(launch, sigs))
        by = dict(zip(sigs, recs))
        for x in d:
            x['launches'] = [by[s] for s in x['sigs'] if by[s]]
            x['not_create'] = [s for s in x['sigs'] if not by[s]]
        assert all(L['time'] < WALL - HORIZON for x in d for L in x['launches'])
        _save('sample_%s.json' % w, d)
        print(w, 'draws', len(d), 'launches', sum(len(x['launches']) for x in d), heli.credits())

def _sigfile(L):
    return os.path.join(SCR, 'sigs', L['sig'] + '.json')

def listing():
    """Bonding-curve signatures of every sampled launch (cached in the scratch directory); counts only."""
    os.makedirs(os.path.join(SCR, 'sigs'), exist_ok=True)
    def one(arg):
        L, before = arg
        p = _sigfile(L)
        if not os.path.exists(p):
            json.dump(bc_sigs(L, before), open(p, 'w'))
        rows = json.load(open(p))
        return sum(1 for x in rows if x['err'] is None and x['signature'] != L['sig'])
    def anchor(x):
        return heli.anchor_sig(max(L['time'] for L in x['launches']) + HORIZON + 30)[0] if x['launches'] else None
    out = {}
    for w in DRAWS:
        d = _load('sample_%s.json' % w)
        anchors = list(POOL.map(anchor, d))
        args = [(L, a) for x, a in zip(d, anchors) for L in x['launches']]
        cnt = list(POOL.map(one, args))
        out[w] = {'launches': len(args), 'tx_to_fetch': sum(cnt), 'max': max(cnt)}
    led = heli.credits()
    need = sum(v['tx_to_fetch'] for v in out.values()) * heli.CREDITS_PER_CALL
    out['credits_used'] = led['credits']; out['tx_credits_needed'] = need
    out['fits'] = led['credits'] + need + RESERVE <= heli.CAP
    _save('listing.json', out)
    print(json.dumps(out))

def _pool_of(t, mint):
    keys = pumpdec.tx_keys(t)
    for grp in t['meta'].get('innerInstructions') or []:
        for ix in grp['instructions']:
            if keys[ix['programIdIndex']] == AMM and heli.b58decode(ix['data'])[:8] == CREATE_POOL:
                acc = [keys[a] for a in ix['accounts']]
                if acc[3] == mint:
                    return acc[0]
    return None

def coin(L):
    """Fetch and decode one launch; writes <scratch>/events/<create sig>.json (derived event streams)."""
    out_p = os.path.join(EV, L['sig'] + '.json')
    if os.path.exists(out_p):
        return json.load(open(out_p))
    rows = [x for x in json.load(open(_sigfile(L))) if x['err'] is None]
    if not rows or rows[0]['signature'] != L['sig']:
        rows = [{'signature': L['sig'], 'err': None}] + [x for x in rows if x['signature'] != L['sig']]
    txs = list(POOL.map(lambda x: tx(x['signature']), rows))
    trades, completes, pool, mig = [], [], None, None
    for t in txs:
        if not t or t['meta'].get('err') is not None:
            continue
        for kind, k, e in pumpdec.events(t):
            key = [t['slot'], t['transactionIndex'], k, t['blockTime']]
            if kind == 'trade' and e['mint'] == L['mint']:
                trades.append(key + [int(e['is_buy']), e['sol_amount'], e['token_amount'], e['vsol'], e['vtok'],
                                     e['rsol'], e['rtok'], e['fee_bps'], e['creator_fee_bps'], e['user'],
                                     e['mayhem']])
            elif kind == 'complete' and e['mint'] == L['mint']:
                completes.append(key)
            elif kind == 'undecodable':
                trades.append(key + ['undecodable'])
        p = _pool_of(t, L['mint'])
        if p and mig is None:
            pool, mig = p, [t['slot'], t['transactionIndex'], 0, t['blockTime']]
    trades.sort(key=lambda r: r[:3]); completes.sort()
    swaps = []
    if pool:
        sys.path.insert(0, os.path.join(HERE, '..', 'execution-audit'))
        import audit
        prow = heli.pool_sigs(pool, mig[3] - 5, L['time'] + HORIZON)
        prow = [x for x in prow if x['err'] is None and x['slot'] >= mig[0]]
        got = list(POOL.map(lambda x: audit.swaps_of(x, pool), prow))
        for g in got:
            for s in g:
                swaps.append([s.slot, s.idx, s.k, s.t, s.B0, s.Q0, s.V, s.B1, s.Q1, s.f, s.kind])
        swaps.sort(key=lambda r: r[:3])
    rec = {'launch': L, 'trades': trades, 'completes': completes, 'pool': pool, 'migrate': mig, 'swaps': swaps,
           'n_sig_ok': len(rows)}
    os.makedirs(EV, exist_ok=True)
    json.dump(rec, open(out_p + '.tmp', 'w')); os.replace(out_p + '.tmp', out_p)
    return rec

def plan():
    """Budget check from signature counts only: keep every draw if the fetch fits the cap with RESERVE kept back,
    else drop whole draws at random (seed 20261073) from both windows in proportion until it fits."""
    def cost(x):
        n = 0
        for L in x['launches']:
            rows = json.load(open(_sigfile(L)))
            n += sum(1 for r in rows if r['err'] is None and r['signature'] != L['sig'])
        return n
    d = {w: _load('sample_%s.json' % w) for w in DRAWS}
    c = {w: [cost(x) for x in d[w]] for w in DRAWS}
    left = (heli.CAP - RESERVE - heli.credits()['credits']) // heli.CREDITS_PER_CALL
    keep = {w: list(range(len(d[w]))) for w in DRAWS}
    rng = random.Random(20261073)
    order = {w: rng.sample(range(len(d[w])), len(d[w])) for w in DRAWS}
    while sum(c[w][i] for w in DRAWS for i in keep[w]) > left:
        w = max(DRAWS, key=lambda w: len(keep[w]) / DRAWS[w][0])
        keep[w].remove(order[w].pop())
    out = {'kept_draws': keep, 'tx_calls_planned': sum(c[w][i] for w in DRAWS for i in keep[w]),
           'calls_available': left, 'dropped': {w: len(d[w]) - len(keep[w]) for w in DRAWS}}
    _save('plan.json', out)
    print({k: v for k, v in out.items() if k != 'kept_draws'})

def fetch_all():
    keep = _load('plan.json')['kept_draws']
    Ls = [L for w in DRAWS for i, x in enumerate(_load('sample_%s.json' % w)) if i in keep[w] for L in x['launches']]
    random.Random(5).shuffle(Ls)
    done = 0
    for L in Ls:
        coin(L); done += 1
        if done % 100 == 0:
            print('coins', done, '/', len(Ls), heli.credits(), flush=True)
    missing = [L['sig'] for L in Ls if not os.path.exists(os.path.join(EV, L['sig'] + '.json'))]
    _save('fetch_report.json', {'coins': len(Ls), 'missing_events': missing, 'credits': heli.credits()})
    print('all coins', done, 'missing', len(missing), heli.credits())

def slot_len():
    """Mean slot length per UTC day from block times at both ends of the day (derived/slot_len.json)."""
    out = {}
    t0 = WINDOWS['discovery'][0]
    pts = []
    for d in range(0, (WINDOWS['validation'][1] - t0) // 86400 + 1):
        s, t = heli.slot_for_time(t0 + d * 86400, tol=5)
        pts.append((s, t))
    for d, ((s0, a), (s1, b)) in enumerate(zip(pts, pts[1:])):
        out[str(t0 + d * 86400)] = (b - a) / (s1 - s0)        # keyed by the intended UTC day, not the block's
    _save('slot_len.json', {'points': pts, 'sec_per_slot_by_day_start': out})
    print(min(out.values()), max(out.values()))

if __name__ == '__main__':
    cmd = sys.argv[1]
    try:
        {'measure': lambda: measure(int(sys.argv[2])), 'sample': sample, 'list': listing,
         'plan': plan, 'fetch': fetch_all, 'slots': slot_len}[cmd]()
        print(heli.credits())
    except Exception as e:
        print('error:', heli.scrub(type(e).__name__), heli.scrub(e)[:300], file=sys.stderr); raise SystemExit(1)
