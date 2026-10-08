"""Stage 1 of CROWD-BREAK-SHORT (PREREG.md): events and control lists from local data. Computes no return.

  python3 -I stage1.py <data_dir> <out_dir>

Reads only: Hyperliquid hourly funding (hl/f_*.json), Binance OI metrics and 5-minute closes (bn/*.csv) and the
Binance USD-M 1-minute kline listing (bn1m/listing.json, file names only). No price after a decision time T is
used: breakdown, b6, r24, m24 and vol6 read closes of bars that ended at or before T; funding and OI ranks read
trailing rows only. Mirrors research/squeeze-probe/stage1.py (H1) with the signs reversed (PREREG section 4).
Writes <out_dir>/stage1.json (frozen table) and prints its SHA-256.
"""
import hashlib, json, math, os, sys
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

WALL = 1789999200                      # 2026-09-21T14:00:00Z
H0 = 1672531200                        # 2023-01-01, start of the hourly grid
BAR = 300
HOLD = 6 * 3600
LAST_DELAY = 67                        # PREREG 4: T + 67 s + 6 h <= wall
NAMES = ['WIF', 'POPCAT', 'BOME', 'MEW', 'GOAT', 'PNUT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'PENGU', 'ZEREBRO',
         'GRIFFAIN', 'VINE', 'USELESS', 'kBONK', 'SPX', 'TRUMP', 'MELANIA', 'YZY', 'AI16Z', 'MYRO', 'LAUNCHCOIN',
         'JELLY', 'DOOD']              # squeeze PREREG's 24 classified Solana-meme perps
BN = {'kBONK': '1000BONK', 'JELLY': 'JELLYJELLY'}                     # Binance USD-M symbol where it differs
SPOT = {'WIF': 'WIF', 'BOME': 'BOME', 'kBONK': 'BONK', 'PNUT': 'PNUT', 'PENGU': 'PENGU', 'TRUMP': 'TRUMP'}
TAG = 'CBS-v1'


def sha(*parts):
    return hashlib.sha256('|'.join(str(p) for p in parts).encode()).hexdigest()


def funding(d, coin):
    """Hourly grid: the first row stamped in [h, h + 1 h), after the squeeze PREREG's funding cut."""
    p = os.path.join(d, 'hl', f'f_{coin}.json')
    if not os.path.exists(p):
        return None
    rows = sorted(json.load(open(p)), key=lambda x: int(x['time']))
    rows = [r for r in rows if int(r['time']) // 1000 < WALL]
    k = len(rows)
    while k and float(rows[k - 1]['fundingRate']) == 0.0:          # cut the trailing exact-0.0 run
        k -= 1
    cut = len(rows) - k
    rows = rows[:k]
    if not rows:
        return None
    n = (WALL - H0) // 3600
    rate = np.full(n, np.nan); tm = np.full(n, np.nan)
    for r in rows:
        t = int(r['time']) / 1000.0
        h = int((t - H0) // 3600)
        if 0 <= h < n and np.isnan(rate[h]):
            rate[h] = float(r['fundingRate']); tm[h] = t
    return rate, tm, cut


def high_rank(x, win=720, need=600, frac=0.9):
    """x[h] higher than at least frac of the present values among x[h-win..h-1] (strict). Returns (flag, eval)."""
    n = len(x)
    flag = np.zeros(n, bool); ev = np.zeros(n, bool)
    if n <= win:
        return flag, ev
    W = swv(x[:-1], win)
    cur = x[win:]
    present = (~np.isnan(W)).sum(1)
    lower = (W < cur[:, None]).sum(1)                                # NaN compares False
    e = (~np.isnan(cur)) & (present >= need)
    ev[win:] = e
    flag[win:] = e & (lower >= frac * present)
    return flag, ev


def oi_series(d, coin):
    p = os.path.join(d, 'bn', f'metrics_{BN.get(coin, coin)}.csv')
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return None
    a = np.loadtxt(p, delimiter=',', ndmin=2)
    return a[:, 0], a[:, 1]


def oi_asof(t, v, x):
    """OI as of time(s) x: latest create_time <= x - 300 s, no older than 1 h; NaN otherwise."""
    x = np.asarray(x, float)
    bound = x - 300
    i = np.searchsorted(t, bound, side='right') - 1
    ok = i >= 0
    ii = np.where(ok, i, 0)
    fresh = ok & (t[ii] >= bound - 3600)
    return np.where(fresh, v[ii], np.nan)


def closes(d, coin):
    if coin in SPOT:
        cp, sp = f'k_spot_{SPOT[coin]}', 'k_spot_SOL'
    else:
        cp, sp = f'k_perp_{BN.get(coin, coin)}', 'k_perp_SOL'
    p = os.path.join(d, 'bn', cp + '.csv')
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return None
    a = np.loadtxt(p, delimiter=',', ndmin=2); s = np.loadtxt(os.path.join(d, 'bn', sp + '.csv'), delimiter=',', ndmin=2)
    sol = dict(zip(s[:, 0].astype(np.int64), s[:, 1]))
    t0 = int(a[0, 0]); t1 = int(a[-1, 0])
    n = (t1 - t0) // BAR + 1
    r = np.full(n, np.nan)
    for t, c in zip(a[:, 0].astype(np.int64), a[:, 1]):
        if t % BAR == 0 and t in sol and c > 0 and sol[t] > 0:
            r[(t - t0) // BAR] = c / sol[t]
    return t0, r


def bar_features(t0, r):
    """Per bar i (open t0 + i*BAR, known at T = open + BAR): breakdown, b6, r24, vol6. Only bars <= i are read."""
    n = len(r)
    brk = np.zeros(n, bool)
    if n > 72:
        pm = swv(r[:-1], 72).min(1)                                  # NaN if any of the 72 previous closes missing
        cur = r[72:]
        brk[72:] = (~np.isnan(pm)) & (~np.isnan(cur)) & (cur < pm)
    cs = np.concatenate([[0], np.cumsum(brk)])
    b6 = np.full(n, -1)
    idx = np.arange(n)
    b6[72:] = cs[idx[72:]] - cs[idx[72:] - 72]                       # breakdowns among bars i-72 .. i-1
    lr = np.full(n, np.nan); lr[1:] = np.log(r[1:]) - np.log(r[:-1])
    vol = np.full(n, np.nan)
    if n > 72:
        vol[71:] = swv(lr, 72).std(1, ddof=1)                        # 72 returns of the 73 closes ending at i
    r24 = np.full(n, np.nan); r24[288:] = np.log(r[288:]) - np.log(r[:-288])
    return brk, b6, r24, vol


def b6cls(b):
    return 0 if b == 0 else (1 if b <= 2 else 2)


def circ(a, b):
    x = abs(a - b) % 24
    return min(x, 24 - x)


def main(d, out):
    nH = (WALL - H0) // 3600
    listing = json.load(open(os.path.join(d, 'bn1m', 'listing.json')))   # {symbol: [months]} for 1m perp klines
    F, FE, FT, FR, CUT = {}, {}, {}, {}, {}
    for c in NAMES:
        f = funding(d, c)
        if f is None:
            continue
        FR[c], FT[c], CUT[c] = f
        F[c], FE[c] = high_rank(FR[c])
    O, OE, OIS = {}, {}, {}
    hours = H0 + np.arange(nH) * 3600
    for c in NAMES:
        s = oi_series(d, c)
        if s is None:
            continue
        OIS[c] = s
        O[c], OE[c] = high_rank(oi_asof(s[0], s[1], hours))
    SIG = {}
    for c in NAMES:
        s = closes(d, c)
        if s is not None:
            SIG[c] = (s[0], s[1]) + bar_features(*s)
    kept, excl, overlap = [], {}, {}
    for c in NAMES:
        why = []
        if c not in FR:
            why.append('no Hyperliquid funding file')
        if c not in O:
            why.append('no Binance OI metrics')
        elif c in FR:
            overlap[c] = int((FE[c] & OE[c]).sum())                    # hours where F+ and O are both evaluable
            if overlap[c] < 600:
                why.append(f'Binance OI and Hyperliquid funding overlap in only {overlap[c]} evaluable hours (< 600)')
        if c not in SIG:
            why.append('no Binance signal series')
        if not listing.get(BN.get(c, c) + 'USDT'):
            why.append('no Binance USD-M 1-minute klines')
        if why:
            excl[c] = why
        else:
            kept.append(c)

    def r24_at(c, T):
        t0, r, brk, b6, r24, vol = SIG[c]
        i = (T - BAR - t0) // BAR
        return r24[i] if 0 <= i < len(r24) else np.nan
    m24cache = {}

    def m24(T):
        if T not in m24cache:
            v = [r24_at(c, T) for c in SIG]
            v = [x for x in v if not np.isnan(x)]
            m24cache[T] = float(np.median(v)) if v else float('nan')
        return m24cache[T]

    def hour_flag(arr, c, h):
        return bool(arr[c][h]) if c in arr and 0 <= h < nH else False

    def day_clean(c, day):
        """F+ and O evaluable at all 24 hours of the UTC day, and neither true at any hour."""
        h0 = (day * 86400 - H0) // 3600
        if h0 < 0 or h0 + 24 > nH:
            return False
        hs = range(h0, h0 + 24)
        if not all(hour_flag(FE, c, h) and hour_flag(OE, c, h) for h in hs):
            return False
        return not any(hour_flag(F, c, h) or hour_flag(O, c, h) for h in hs)

    def find_events(c, trig):
        t0, r, brk, b6, r24, vol = SIG[c]
        evs, last_T, days = [], -10 ** 12, set()
        for h in np.where(trig)[0]:
            hs = H0 + int(h) * 3600
            ft = FT[c][h]
            i0 = max(0, (hs - t0) // BAR)
            for i in range(i0, min(len(r), (hs + 3600 - t0 + BAR - 1) // BAR)):
                o = t0 + i * BAR
                if o < hs or o >= hs + 3600 or not brk[i]:
                    continue
                T = o + BAR
                if T < ft or T + LAST_DELAY + HOLD > WALL:
                    continue
                if T < last_T + HOLD or T // 86400 in days:
                    continue
                evs.append({'coin': c, 'T': int(T), 'hour': int(hs), 'bar_open': int(o),
                            'funding_rate': float(FR[c][h]), 'funding_time': float(ft), 'b6': int(b6[i]),
                            'r24': None if np.isnan(r24[i]) else float(r24[i]),
                            'vol6': None if np.isnan(vol[i]) else float(vol[i])})
                last_T = T; days.add(T // 86400)
                break
        for e in evs:
            e['id'] = sha(TAG, e['coin'], e['T'])[:16]
            e['m24'] = m24(e['T'])
        return evs

    def candidates(c):
        t0, r, brk, b6, r24, vol = SIG[c]
        out, okday = [], {}
        for i in np.where(brk)[0]:
            T = t0 + int(i) * BAR + BAR
            if T + LAST_DELAY + HOLD > WALL or np.isnan(r24[i]) or np.isnan(vol[i]):
                continue
            dy = T // 86400
            if dy not in okday:
                okday[dy] = day_clean(c, dy)
            if okday[dy]:
                out.append({'coin': c, 'T': int(T), 'b6': int(b6[i]), 'r24': float(r24[i]),
                            'vol6': float(vol[i]), 'm24': m24(int(T)), 'id': sha(TAG, 'cand', c, int(T))[:16]})
        return out

    def match(events, cands, sd, keep=60):
        byc = {}
        for x in cands:
            byc.setdefault(x['coin'], []).append(x)
        for e in events:
            e['controls_ranked'] = []
            if e['r24'] is None or e['vol6'] is None or math.isnan(e['m24']):
                e['no_match_reason'] = 'missing r24/vol6/m24'
                continue
            hd = (e['T'] % 86400) / 3600
            best = {}
            for x in byc.get(e['coin'], []):
                if abs(x['T'] - e['T']) > 30 * 86400 or b6cls(x['b6']) != b6cls(e['b6']) or math.isnan(x['m24']):
                    continue
                dist = math.sqrt(((e['r24'] - x['r24']) / sd[0]) ** 2 + ((e['m24'] - x['m24']) / sd[1]) ** 2 +
                                 ((e['vol6'] - x['vol6']) / sd[2]) ** 2 + (circ(hd, (x['T'] % 86400) / 3600) / 6) ** 2)
                key = (dist, sha(TAG, e['id'], x['id']))
                dy = x['T'] // 86400
                if dy not in best or key < best[dy][0]:
                    best[dy] = (key, x)
            ranked = sorted(best.values(), key=lambda kv: kv[0])[:keep]
            e['controls_ranked'] = [{'T': x['T'], 'id': x['id'], 'dist': round(k[0], 6), 'b6': x['b6'],
                                     'r24': x['r24'], 'm24': x['m24'], 'vol6': x['vol6']} for k, x in ranked]
            e['n_candidate_days'] = len(best)

    def c2_draws(e, n=40):
        lo, hi = e['T'] - 30 * 86400, min(WALL - HOLD - LAST_DELAY, e['T'] + 30 * 86400)
        return [int(lo + int(sha(TAG, e['id'], 'C2', k), 16) % (hi - lo + 1)) for k in range(n)]

    S = {c: F[c] & O[c] for c in kept}
    prim = sum((find_events(c, S[c]) for c in kept), [])
    c1 = sum((candidates(c) for c in kept), [])
    a = np.array([[x['r24'], x['m24'], x['vol6']] for x in c1 if not math.isnan(x['m24'])])
    sd = [float(v) for v in a.std(0, ddof=1)]
    match(prim, c1, sd)
    for e in prim:
        e['c2_draws'] = c2_draws(e)
    info = {'kept': kept, 'excluded': excl, 'overlap_hours': overlap, 'funding_cut_rows': CUT,
            'funding_high_hours': {c: int(F[c].sum()) for c in F}, 'oi_high_hours': {c: int(O[c].sum()) for c in O},
            's_hours': {c: int(S[c].sum()) for c in kept},
            'n_primary': len(prim), 'primary_days': len({e['T'] // 86400 for e in prim}),
            'primary_coins': sorted({e['coin'] for e in prim}), 'sd': sd, 'n_sd_pool': len(a), 'n_c1_pool': len(c1),
            'median_event_funding': float(np.median([e['funding_rate'] for e in prim])) if prim else None}
    table = {'info': info, 'events': prim}
    os.makedirs(out, exist_ok=True)
    blob = json.dumps(table, sort_keys=True, separators=(',', ':')).encode()
    open(os.path.join(out, 'stage1.json'), 'wb').write(blob)
    print(json.dumps({k: v for k, v in info.items() if k != 'excluded'}))
    print('excluded', json.dumps(excl))
    nc = [len(e['controls_ranked']) for e in prim]
    print('events', len(prim), 'days', info['primary_days'], 'with>=3 ranked', sum(x >= 3 for x in nc),
          'with>=10', sum(x >= 10 for x in nc))
    print('stage1.json sha256', hashlib.sha256(blob).hexdigest())


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
