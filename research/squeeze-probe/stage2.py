"""Stage 2 of the squeeze probe (H1): data checks, pricing on the Solana pool, statistics, verdict.

  python3 -I stage2.py check <stage1.json> <expected_sha256> <out_dir>   # data checks 2-3 (no outcome read)
  python3 -I stage2.py price <stage1.json> <expected_sha256> <out_dir>   # price primary, then arms (credit cap)
  python3 -I stage2.py stats <stage1.json> <expected_sha256> <out_dir>                     # tables, intervals, verdict

Reads only the frozen stage-1 table (its SHA-256 must match the committed value), pool_map.json and pool
transactions from Helius (hel.py; cap 400,000 credits; never a block time after the wall).
Order of reading for controls: the entry state decides executability; an exit state is read only for a trade
already accepted. No exit price decides whether a trade is used.
"""
import concurrent.futures as cf, hashlib, json, math, os, random, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WALL = 1789999200
HOLD = 6 * 3600
Q = 419_300_000                         # 0.4193 SOL in lamports ($50 at 119.26 $/SOL)
FIXED = 414_009                         # lamports per round trip (research/lottery-probe/lottery.py)
MAXCOST = 0.015
N_C1, N_ARM, N_C2 = 10, 3, 5
TAG = 'H1-v1'
T2 = os.environ.get('SQ_TRIAL') == 'T2'          # H1-T2 (PREREG item 21): amended data check 3 only
PMAP = json.load(open(os.path.join(HERE, 'pool_map.json')))


def sha(*p):
    return hashlib.sha256('|'.join(str(x) for x in p).encode()).hexdigest()


def load(path, expect=None):
    blob = open(path, 'rb').read()
    h = hashlib.sha256(blob).hexdigest()
    if expect and h != expect:
        sys.exit(f'stage-1 table hash {h} does not match the committed {expect}')
    return json.loads(blob)


# ------------------------------------------------------------------ pool state
def _keys(tx):
    k = list(tx['transaction']['message']['accountKeys'])
    k = [x if isinstance(x, str) else x['pubkey'] for x in k]
    la = tx['meta'].get('loadedAddresses') or {}
    return k + la.get('writable', []) + la.get('readonly', [])


def vaults(tx, coin, when='post'):
    """(x lamports in the SOL vault, y raw tokens in the token vault) after (or before) tx, by vault address."""
    pm = PMAP[coin]
    keys = _keys(tx)
    bal = {keys[b['accountIndex']]: int(b['uiTokenAmount']['amount'])
           for b in tx['meta'].get(when + 'TokenBalances') or []}
    if pm['sol_vault'] in bal and pm['token_vault'] in bal:
        return bal[pm['sol_vault']], bal[pm['token_vault']]
    return None


def state(coin, t):
    """Pool state after the last successful pool transaction with blockTime <= t that carries both vaults."""
    import hel
    t = int(t)
    if t > WALL:
        raise ValueError('after wall')
    pool = PMAP[coin]['pool']
    tok, lim = None, 1
    for page in range(10):
        r = hel.gtfa_last(pool, t, tok, lim)
        for tx in r.get('data') or []:
            v = vaults(tx, coin)
            if v and tx['blockTime'] <= t:
                return {'x': v[0], 'y': v[1], 'bt': tx['blockTime'], 'slot': tx['slot']}
        tok = r.get('paginationToken')
        if not tok or not r.get('data'):
            return None
        lim = 10
    return None


def first_tx(coin):
    import hel
    r = hel.gtfa_first(PMAP[coin]['pool'])
    d = r.get('data') or []
    return d[0]['blockTime'] if d else None


def entry_ok(coin, s):
    f = PMAP[coin]['fee']
    if not s:
        return False, 'no pool state at entry'
    if s['x'] <= 0 or s['y'] <= 0:
        return False, 'empty pool'
    rt = 2 * f + 2 * Q / s['x'] + FIXED / Q
    if rt > MAXCOST:
        return False, f'round trip {rt:.4f} > 1.5%'
    return True, ''


def fill(coin, s0, s1):
    f = PMAP[coin]['fee']
    qi = Q * (1 - f)
    k = s0['y'] * qi / (s0['x'] + qi)
    ki = k * (1 - f)
    out = s1['x'] * ki / (s1['y'] + ki)
    return {'net': (out - Q - FIXED) / Q, 'gross': (s1['x'] / s1['y']) / (s0['x'] / s0['y']) - 1,
            'entry_bt': s0['bt'], 'exit_bt': s1['bt'], 'x0': s0['x']}


# ------------------------------------------------------------------ data checks
def check(st, out, t2=False):
    import hel
    first = {}
    coins = sorted({e['coin'] for t in st['tables'].values() for e in t['events']})
    for c in coins:
        first[c] = first_tx(c)
    json.dump(first, open(os.path.join(out, 'pool_first_tx.json'), 'w'), indent=1)
    prim = st['tables']['primary']['events']
    progs = {PMAP[e['coin']]['program'] for e in prim}
    res = {'pool_first_tx': first, 'programs_in_primary': sorted(progs), 'reserve_check': {}}
    for prog in sorted(progs):
        pools = sorted({e['coin'] for e in prim if PMAP[e['coin']]['program'] == prog})
        lo, hi = min(e['T'] for e in prim), max(e['T'] for e in prim)
        rng = random.Random(7)
        rows = []
        for k in range(200):
            c = pools[rng.randrange(len(pools))]
            a = max(lo, first[c] or lo)
            if a >= hi:
                rows.append(None); continue                           # pool younger than the range: skipped
            t = a + rng.randrange(hi - a)
            rows.append(swap_check(c, t, t2))
        ok = [r for r in rows if r and r.get('ok') is not None]
        fail = [r for r in ok if not r['ok']]
        res['reserve_check'][prog] = {'sampled': 200, 'swaps_found': len(ok), 'fail': len(fail),
                                      'fail_share': len(fail) / max(1, len(ok)),
                                      'dropped': len(fail) / max(1, len(ok)) > 0.05,
                                      'worst': sorted(ok, key=lambda r: -r['dev'])[:5]}
    res['credits'] = hel.ledger()
    json.dump(res, open(os.path.join(out, 'datachecks_t2.json' if t2 else 'datachecks.json'), 'w'), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != 'reserve_check'}, indent=1))
    for p, v in res['reserve_check'].items():
        print(p, {k: v[k] for k in ('sampled', 'swaps_found', 'fail', 'fail_share', 'dropped')})


def swap_check(c, t, t2=False):
    """Registered check: the latest of 5 pool transactions that is a swap. H1-T2 (PREREG item 21): the latest
    of up to 30 that is a single-ray_log swap with |dSOL| >= 1,000,000 lamports."""
    import hel
    pool = PMAP[c]['pool']; f = PMAP[c]['fee']
    txs = list((hel.gtfa_last(pool, t, None, 5) if not t2 else hel.gtfa_last(pool, t, None, 30)).get('data') or [])
    for tx in txs:
        if t2:
            a, b = vaults(tx, c, 'pre'), vaults(tx, c, 'post')
            logs = tx['meta'].get('logMessages') or []
            if not a or not b or abs(b[0] - a[0]) < 1_000_000 or sum('ray_log' in l for l in logs) != 1:
                continue
        a, b = vaults(tx, c, 'pre'), vaults(tx, c, 'post')
        if not a or not b:
            continue
        dx, dy = b[0] - a[0], b[1] - a[1]
        if dx == 0 or dy == 0 or (dx > 0) == (dy > 0):
            continue
        p_eff = dx * (1 - f) / -dy if dx > 0 else -dx / (dy * (1 - f))
        p0, p1 = a[0] / a[1], b[0] / b[1]
        lo, hi = min(p0, p1), max(p0, p1)
        dev = max(0.0, lo / p_eff - 1, p_eff / hi - 1)
        return {'coin': c, 't': t, 'sig': tx['transaction']['signatures'][0], 'dir': 'buy' if dx > 0 else 'sell',
                'p_eff': p_eff, 'p_pre': p0, 'p_post': p1, 'dev': dev, 'ok': dev <= 0.001,
                'size_share': abs(dx) / a[0]}
    return None


def dump_atomic(obj, path):
    json.dump(obj, open(path + '.tmp', 'w')); os.replace(path + '.tmp', path)


# ------------------------------------------------------------------ pricing
class Pricer:
    def __init__(self, out, first):
        self.out = out; self.first = first
        self.path = os.path.join(out, 'prices.json')
        self.cache = json.load(open(self.path)) if os.path.exists(self.path) else {}

    def get(self, coin, t):
        k = f'{coin}|{int(t)}'
        if k not in self.cache:
            self.cache[k] = state(coin, t)
        return self.cache[k]

    def save(self):
        json.dump(self.cache, open(self.path + '.tmp', 'w')); os.replace(self.path + '.tmp', self.path)

    def entry(self, coin, T, delay):
        te = int(T + delay)
        if self.first.get(coin) is None or te < self.first[coin]:
            return None, 'before the pool\'s first transaction'
        s = self.get(coin, te)
        ok, why = entry_ok(coin, s)
        return (s if ok else None), why

    def trade(self, coin, T, delay):
        s0, why = self.entry(coin, T, delay)
        if not s0:
            return {'exec': False, 'why': why}
        te = int(T + delay)
        if te + HOLD > WALL:
            return {'exec': False, 'why': 'exit after wall'}
        s1 = self.get(coin, te + HOLD)
        if not s1:
            return {'exec': False, 'why': 'no pool state at exit'}
        r = fill(coin, s0, s1); r['exec'] = True
        return r


def run_controls(P, e, ranked, nwant, ex):
    """Walk the frozen ranked list: entry states first (in parallel batches), accept in rank order."""
    acc, tried, i = [], [], 0
    while len(acc) < nwant and i < len(ranked):
        batch = ranked[i:i + (nwant - len(acc)) + 2]
        i += len(batch)
        ents = list(ex.map(lambda x: P.entry(e['coin'], x['T'], 7), batch))
        for x, (s0, why) in zip(batch, ents):
            if len(acc) >= nwant:
                break
            tried.append({'T': x['T'], 'exec': bool(s0), 'why': why})
            if s0:
                acc.append(x)
    trades = list(ex.map(lambda x: P.trade(e['coin'], x['T'], 7), acc))
    return [dict(T=x['T'], id=x['id'], **tr) for x, tr in zip(acc, trades)], tried


def price(st, out):
    import hel
    first = json.load(open(os.path.join(out, 'pool_first_tx.json')))
    dc = json.load(open(os.path.join(out, 'datachecks_t2.json' if T2 else 'datachecks.json')))
    dropped = {p for p, v in dc['reserve_check'].items() if v['dropped']}
    P = Pricer(out, first)
    resp = os.path.join(out, 'priced.json')
    R = json.load(open(resp)) if os.path.exists(resp) else {}
    ex = cf.ThreadPoolExecutor(8)
    phases = [('primary', 'c1', N_C1), ('primary', 'c2', N_C2), ('primary', 'c1b', N_C1),
              ('armA', 'c1', N_ARM), ('armB', 'c1', N_ARM), ('armC', 'c1', N_ARM)]
    try:
        for arm, kind, nwant in phases:
            key = f'{arm}:{kind}'
            if R.get(key, {}).get('done'):
                continue
            R.setdefault(key, {'events': {}})
            for j, e in enumerate(st['tables'][arm]['events']):
                if e['id'] in R[key]['events']:
                    continue
                if PMAP[e['coin']]['program'] in dropped:
                    R[key]['events'][e['id']] = {'exec': False, 'why': 'pool type dropped by data check 3'}
                    continue
                rec = R.get(f'{arm}:c1', {}).get('events', {}).get(e['id']) if kind != 'c1' else None
                ev = rec['event'] if rec else {'line7': P.trade(e['coin'], e['T'], 7)}
                if arm == 'primary' and kind == 'c1':
                    ev['line60'] = P.trade(e['coin'], e['T'], 60)
                row = {'event': ev}
                if ev['line7']['exec']:
                    if kind == 'c2':
                        draws = [{'T': t, 'id': sha(TAG, e['id'], 'C2', t)[:16]} for t in e['c2_draws']]
                        row['controls'], row['tried'] = run_controls(P, e, draws, nwant, ex)
                    else:
                        ranked = e['c1b_ranked'] if kind == 'c1b' else e['controls_ranked']
                        row['controls'], row['tried'] = run_controls(P, e, ranked, nwant, ex)
                R[key]['events'][e['id']] = row
                if j % 10 == 0:
                    P.save(); dump_atomic(R, resp)
                    print(key, j, 'credits', hel.ledger()['credits'], flush=True)
            R[key]['done'] = True
            P.save(); dump_atomic(R, resp)
            print('phase done', key, 'credits', hel.ledger()['credits'], flush=True)
    except hel.CapReached as err:
        print('CAP REACHED:', err)
        R['_cap_reached'] = str(err)
    P.save(); dump_atomic(R, resp)


# ------------------------------------------------------------------ statistics
def tq(p, df):
    """Student-t quantile by bisection on a numerically integrated density (no scipy)."""
    c = math.exp(math.lgamma((df + 1) / 2) - math.lgamma(df / 2)) / math.sqrt(df * math.pi)
    xs = np.linspace(0, 40, 400001)
    dens = c * (1 + xs ** 2 / df) ** (-(df + 1) / 2)
    cdf = 0.5 + np.concatenate([[0], np.cumsum((dens[1:] + dens[:-1]) / 2 * (xs[1] - xs[0]))])
    return float(np.interp(p, cdf, xs))


def clustered(vals, days):
    v = np.asarray(vals, float); n = len(v)
    if n < 2:
        return None
    m = v.mean()
    g = {}
    for x, dd in zip(v, days):
        g[dd] = g.get(dd, 0.0) + (x - m)
    G = len(g)
    if G < 2:
        return None
    se = math.sqrt(sum(s * s for s in g.values())) / n * math.sqrt(G / (G - 1))
    t = tq(0.975, G - 1)
    return [m - t * se, m + t * se]


def boot(vals, days, B=10000, seed=7):
    v = np.asarray(vals, float)
    ud = sorted(set(days))
    if len(ud) < 2:
        return None
    idx = {dd: [] for dd in ud}
    for i, dd in enumerate(days):
        idx[dd].append(i)
    sums = np.array([v[idx[dd]].sum() for dd in ud]); cnts = np.array([len(idx[dd]) for dd in ud])
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(ud), size=(B, len(ud)))
    means = sums[draws].sum(1) / cnts[draws].sum(1)
    return [float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))]


def summarize(rows, label):
    """rows: dicts with n, gross, c (or None), day, coin, T, fr, n60, c2, c1b."""
    lift = [r for r in rows if r['c'] is not None]
    out = {'label': label, 'events_exec': len(rows), 'coins': len({r['coin'] for r in rows}),
           'days': len({r['day'] for r in rows}), 'lift_events': len(lift),
           'lift_days': len({r['day'] for r in lift})}
    if rows:
        n = [r['n'] for r in rows]
        out.update(mean_n_all=float(np.mean(n)), median_n_all=float(np.median(n)),
                   mean_gross_all=float(np.mean([r['gross'] for r in rows])),
                   median_gross_all=float(np.median([r['gross'] for r in rows])),
                   win_all=float(np.mean([x > 0 for x in n])))
    if lift:
        n = [r['n'] for r in lift]; d = [r['n'] - r['c'] for r in lift]; dy = [r['day'] for r in lift]
        out.update(mean_n=float(np.mean(n)), median_n=float(np.median(n)), mean_d=float(np.mean(d)),
                   median_d=float(np.median(d)), mean_c1=float(np.mean([r['c'] for r in lift])),
                   win=float(np.mean([x > 0 for x in n])),
                   mean_gross=float(np.mean([r['gross'] for r in lift])),
                   median_gross=float(np.median([r['gross'] for r in lift])),
                   ci_n_boot=boot(n, dy), ci_d_boot=boot(d, dy),
                   ci_n_t=clustered(n, dy), ci_d_t=clustered(d, dy))
        n60 = [r['n60'] for r in lift if r['n60'] is not None]
        out['mean_n60'] = float(np.mean(n60)) if n60 else None
        out['n60_count'] = len(n60)
        out['mean_stress'] = float(np.mean(n) - 0.01)
        c2 = [r['c2'] for r in lift if r['c2'] is not None]
        c1b = [r['c1b'] for r in lift if r['c1b'] is not None]
        out['mean_c2'] = float(np.mean(c2)) if c2 else None; out['c2_events'] = len(c2)
        out['mean_c1b'] = float(np.mean(c1b)) if c1b else None; out['c1b_events'] = len(c1b)
    return out


def stats(st, out):
    import time as _t
    R = json.load(open(os.path.join(out, 'priced.json')))
    res = {'cap_reached': R.get('_cap_reached'), 'arms': {}}

    def rows_for(arm, nmin):
        key = f'{arm}:c1'
        if key not in R:
            return None, None
        evs = {e['id']: e for e in st['tables'][arm]['events']}
        rows, drop = [], {}
        for eid, rec in R[key]['events'].items():
            e = evs[eid]
            ev = rec.get('event', {}).get('line7') if 'event' in rec else rec
            if not ev or not ev.get('exec'):
                w = (ev or rec).get('why', 'unknown'); drop[w] = drop.get(w, 0) + 1
                continue
            ctl = [x['net'] for x in rec.get('controls', []) if x.get('exec')]
            c = float(np.mean(ctl)) if len(ctl) >= 3 else None
            l60 = rec['event'].get('line60')
            r = {'id': eid, 'coin': e['coin'], 'T': e['T'], 'day': e['T'] // 86400, 'n': ev['net'],
                 'gross': ev['gross'], 'c': c, 'nctl': len(ctl), 'fr': e['funding_rate'],
                 'n60': l60['net'] if l60 and l60.get('exec') else None, 'c2': None, 'c1b': None,
                 'r24': e['r24'], 'm24': e['m24'], 'vol6': e['vol6'], 'hour': (e['T'] % 86400) / 3600}
            for kind in ('c2', 'c1b'):
                rr = R.get(f'{arm}:{kind}', {}).get('events', {}).get(eid)
                if rr and rr.get('controls'):
                    v = [x['net'] for x in rr['controls'] if x.get('exec')]
                    r[kind] = float(np.mean(v)) if v else None
            r['entry_age'] = e['T'] + 7 - ev['entry_bt']
            r['n_c2'] = len([x for x in (R.get(f'{arm}:c2', {}).get('events', {}).get(eid) or {}).get('controls', [])
                             if x.get('exec')])
            rows.append(r)
        return rows, drop

    prim, drop = rows_for('primary', 3)
    lift = [r for r in prim if r['c'] is not None]
    P = summarize(prim, 'primary')
    P['dropped'] = drop
    P['too_few_controls'] = sum(1 for r in prim if r['c'] is None)
    P['entry_state_older_than_1h'] = sum(1 for r in prim if r['entry_age'] > 3600)
    P['events_with_fewer_than_5_c2'] = sum(1 for r in prim if r['n_c2'] < 5)
    # halves split at the median entry date of the lift set
    if lift:
        mid = float(np.median([r['T'] for r in lift]))
        P['half_split_utc'] = _t.strftime('%Y-%m-%d %H:%M', _t.gmtime(mid))
        P['halves'] = [summarize([r for r in prim if (r['T'] < mid) == first], h)
                       for first, h in ((True, 'first half'), (False, 'second half'))]
        P['by_year'] = {y: summarize([r for r in prim if _t.gmtime(r['T']).tm_year == y], str(y))
                        for y in sorted({_t.gmtime(r['T']).tm_year for r in prim})}
        P['by_coin'] = {c: summarize([r for r in prim if r['coin'] == c], c) for c in sorted({r['coin'] for r in prim})}
        P['by_funding_sign'] = {'below 0': summarize([r for r in prim if r['fr'] < 0], 'fr<0'),
                                '0 and above': summarize([r for r in prim if r['fr'] >= 0], 'fr>=0')}
        # balance: standardized mean differences of matching variables, events vs accepted C1 controls
        P['balance'] = balance(st, R, lift)
        # events within 72 h before a perp's funding cut
        P['near_cut'] = near_cut(st, prim)
    res['arms']['primary'] = P
    # arm D (spot-signal coins) and E (first event per UTC day), from the primary's priced events
    spot = {'WIF', 'BOME', 'PNUT', 'PENGU', 'TRUMP', 'kBONK'}
    res['arms']['D'] = summarize([r for r in prim if r['coin'] in spot], 'D spot-signal coins')
    firsts = {}
    for r in sorted(prim, key=lambda r: r['T']):
        firsts.setdefault(r['day'], r)
    res['arms']['E'] = summarize(list(firsts.values()), 'E one trade a day')
    for arm in ('armA', 'armB', 'armC'):
        rows, dr = rows_for(arm, 3)
        if rows is None:
            res['arms'][arm] = {'not_run': True}
            continue
        s = summarize(rows, arm); s['dropped'] = dr
        s['complete'] = bool(R.get(f'{arm}:c1', {}).get('done'))
        res['arms'][arm] = s
    res['verdict'] = verdict(P)
    import hel
    res['credits'] = hel.ledger()
    json.dump(res, open(os.path.join(out, 'results.json'), 'w'), indent=1, default=float)
    print(json.dumps(res['verdict'], indent=1))


def balance(st, R, lift):
    """Standardized mean difference of each matching variable, events against their accepted C1 controls."""
    evs = {e['id']: e for e in st['tables']['primary']['events']}
    ev, ctl = [], []
    for r in lift:
        e = evs[r['id']]
        ev.append([e['r24'], e['m24'], e['vol6'], (e['T'] % 86400) / 3600])
        feats = {x['id']: x for x in e['controls_ranked']}
        for x in R['primary:c1']['events'][r['id']].get('controls', []):
            if x.get('exec'):
                f = feats[x['id']]
                ctl.append([f['r24'], f['m24'], f['vol6'], (f['T'] % 86400) / 3600])
    ev, ctl = np.array(ev, float), np.array(ctl, float)
    out = {}
    for j, name in enumerate(['r24', 'm24', 'vol6', 'hour']):
        a, b = ev[:, j], ctl[:, j]
        if name == 'hour':                                           # circular: compare on the unit circle
            out['hour_sin'] = smd(np.sin(a * np.pi / 12), np.sin(b * np.pi / 12))
            out['hour_cos'] = smd(np.cos(a * np.pi / 12), np.cos(b * np.pi / 12))
        else:
            out[name] = smd(a, b)
    return out


def smd(a, b):
    return float((a.mean() - b.mean()) / math.sqrt((a.var(ddof=1) + b.var(ddof=1)) / 2))


def near_cut(st, prim):
    ct = st['info'].get('cut_time', {})
    rows = [r for r in prim if r['coin'] in ct and 0 <= ct[r['coin']] - r['T'] <= 72 * 3600]
    return {'cut_time': ct, 'events': [{'coin': r['coin'], 'T': r['T'], 'n': r['n'], 'c': r['c']} for r in rows]}


def verdict(P):
    ev, days = P.get('lift_events', 0), P.get('lift_days', 0)
    if ev < 150 or days < 100:
        return {'verdict': 'UNRESOLVED', 'why': f'{ev} executable events with a C1 set on {days} days (need 150 and 100)'}
    if P['mean_n'] <= 0 or P['mean_d'] <= 0 or P['mean_n_all'] <= 0:
        return {'verdict': 'KILLED', 'why': f"mean n {P['mean_n']:.4f} (all executable {P['mean_n_all']:.4f}), "
                                           f"mean d {P['mean_d']:.4f}"}
    h = P['halves']
    conds = {
        'ci_n_lower>0 (bootstrap and t)': P['ci_n_boot'][0] > 0 and P['ci_n_t'][0] > 0,
        'ci_d_lower>0 (bootstrap and t)': P['ci_d_boot'][0] > 0 and P['ci_d_t'][0] > 0,
        'halves n,d > 0': all(x.get('mean_n', -1) > 0 and x.get('mean_d', -1) > 0 for x in h),
        'line60 mean n > 0': (P['mean_n60'] or -1) > 0,
        'stress mean > 0': P['mean_stress'] > 0}
    return {'verdict': 'PROMISING' if all(conds.values()) else 'INCONCLUSIVE', 'conditions': conds}


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'stats':
        stats(load(sys.argv[2], sys.argv[3]), sys.argv[4])
    else:
        st = load(sys.argv[2], sys.argv[3])
        os.makedirs(sys.argv[4], exist_ok=True)
        if cmd == 'check':
            check(st, sys.argv[4])
        elif cmd == 'check_t2':
            check(st, sys.argv[4], True)
        else:
            price(st, sys.argv[4])
