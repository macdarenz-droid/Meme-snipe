"""Stage 1 of the squeeze probe (H1): events, controls and arms from local data. Computes no return.

  python3 -I stage1.py <data_dir> <out_dir>

Reads only: Hyperliquid funding (hl/f_*.json), Hyperliquid daily candles and stats OI (hl/c_*.json,
hl/open_interest.json) for arm B, Binance OI metrics and 5-minute closes (bn/*.csv), pool_map.json.
No price after a decision time T is used for any decision: breakout, r24, m24 and vol6 read closes of bars
that ended at or before T; funding and OI percentiles read trailing rows only. Clean-day control pools use
whole-day signal flags (funding and OI, never prices), as the PREREG specifies.
Writes <out_dir>/stage1.json (frozen table) and prints its SHA-256.
"""
import hashlib, json, math, os, sys
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

HERE = os.path.dirname(os.path.abspath(__file__))
WALL = 1789999200                      # 2026-09-21T14:00:00Z
H0 = 1672531200                        # 2023-01-01, start of the hourly grid
BAR = 300
HOLD = 6 * 3600
LAST_DELAY = 67                        # T + 60 s line plus the 7 s entry slack bound
NAMES = ['WIF', 'POPCAT', 'BOME', 'MEW', 'GOAT', 'PNUT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'PENGU', 'ZEREBRO',
         'GRIFFAIN', 'VINE', 'USELESS', 'kBONK', 'SPX', 'TRUMP', 'MELANIA', 'YZY', 'AI16Z', 'MYRO', 'LAUNCHCOIN',
         'JELLY', 'DOOD']
BN = {'kBONK': '1000BONK', 'JELLY': 'JELLYJELLY'}                     # Binance USD-M symbol where it differs
SPOT = {'WIF': 'WIF', 'BOME': 'BOME', 'kBONK': 'BONK', 'PNUT': 'PNUT', 'PENGU': 'PENGU', 'TRUMP': 'TRUMP'}
TAG = 'H1-v1'


def sha(*parts):
    return hashlib.sha256('|'.join(str(p) for p in parts).encode()).hexdigest()


# ---------------------------------------------------------------- funding
def funding(d, coin):
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
    n = (WALL - H0) // 3600
    rate = np.full(n, np.nan); tm = np.full(n, np.nan)
    for r in rows:
        t = int(r['time']) / 1000.0
        h = int((t - H0) // 3600)
        if 0 <= h < n and np.isnan(rate[h]):                         # the row stamped in [h, h + 1 h)
            rate[h] = float(r['fundingRate']); tm[h] = t
    return rate, tm, cut


def low_rank(x, win=720, need=600, frac=0.9):
    """x[h] lower than at least frac of the present values among x[h-win..h-1] (strict). Returns (flag, eval)."""
    n = len(x)
    flag = np.zeros(n, bool); ev = np.zeros(n, bool)
    if n <= win:
        return flag, ev
    W = swv(x[:-1], win)                                             # W[i] = x[i .. i+win-1] -> trailing for h=i+win
    cur = x[win:]
    present = (~np.isnan(W)).sum(1)
    higher = (W > cur[:, None]).sum(1)                               # NaN compares False
    e = (~np.isnan(cur)) & (present >= need)
    ev[win:] = e
    flag[win:] = e & (higher >= frac * present)
    return flag, ev


def high_rank(x, win=720, need=600, frac=0.9):
    n = len(x)
    flag = np.zeros(n, bool); ev = np.zeros(n, bool)
    if n <= win:
        return flag, ev
    W = swv(x[:-1], win)
    cur = x[win:]
    present = (~np.isnan(W)).sum(1)
    lower = (W < cur[:, None]).sum(1)
    e = (~np.isnan(cur)) & (present >= need)
    ev[win:] = e
    flag[win:] = e & (lower >= frac * present)
    return flag, ev


# ---------------------------------------------------------------- Binance OI
def oi_hourly(d, coin):
    p = os.path.join(d, 'bn', f'metrics_{BN.get(coin, coin)}.csv')
    if not os.path.exists(p):
        return None
    a = np.loadtxt(p, delimiter=',', ndmin=2)
    if not len(a):
        return None
    t, v = a[:, 0], a[:, 1]
    n = (WALL - H0) // 3600
    hours = H0 + np.arange(n) * 3600
    bound = hours - 300                                              # latest create_time <= h - 300 s
    i = np.searchsorted(t, bound, side='right') - 1
    ok = (i >= 0)
    out = np.full(n, np.nan)
    ii = np.where(ok, i, 0)
    fresh = ok & (t[ii] >= bound - 3600)                             # no older than 1 h
    out[fresh] = v[ii[fresh]]
    return out, (t.min(), t.max())


# ---------------------------------------------------------------- signal closes
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
    """Per bar i (open t0 + i*BAR, known at T = open + BAR): breakout, b6, r24, vol6. Only bars <= i are read."""
    n = len(r)
    brk = np.zeros(n, bool)
    if n > 72:
        pm = swv(r[:-1], 72).max(1)                                  # NaN if any of the 72 previous closes missing
        cur = r[72:]
        brk[72:] = (~np.isnan(pm)) & (~np.isnan(cur)) & (cur > pm)
    cs = np.concatenate([[0], np.cumsum(brk)])
    b6 = np.full(n, -1)
    idx = np.arange(n)
    b6[72:] = cs[idx[72:]] - cs[idx[72:] - 72]                       # breakouts among bars i-72 .. i-1
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


# ---------------------------------------------------------------- main
def main(d, out):
    pmap = json.load(open(os.path.join(HERE, 'pool_map.json')))
    nH = (WALL - H0) // 3600
    F, FE, FT, FR, CUT = {}, {}, {}, {}, {}
    for c in NAMES:
        f = funding(d, c)
        if f is None:
            continue
        rate, tm, cut = f
        FR[c] = rate; FT[c] = tm; CUT[c] = cut
        F[c], FE[c] = low_rank(rate)
    # universe median funding per hour (arm C)
    M = np.vstack([FR[c] for c in FR])
    with np.errstate(all='ignore'):
        med = np.nanmedian(M, 0)
    FC, FCE = {}, {}
    for c in FR:
        FC[c], FCE[c] = low_rank(FR[c] - med)
    O, OE, OIR = {}, {}, {}
    for c in NAMES:
        o = oi_hourly(d, c)
        if o is None:
            continue
        O[c], OE[c] = high_rank(o[0]); OIR[c] = o[1]
    SIG = {}
    for c in NAMES:
        s = closes(d, c)
        if s is not None:
            SIG[c] = (s[0], s[1]) + bar_features(*s)
    # arm B: Hyperliquid daily OI (stats JSON) in tokens = USD / typical price of that day's HL daily candle
    B, BE = arm_b_flags(d)
    # ---- universe kept / excluded
    kept, excl = [], {}
    for c in NAMES:
        why = []
        if c not in FR:
            why.append('no Hyperliquid funding file')
        if c not in O:
            why.append('no Binance OI metrics')
        elif c in FR:
            fh = np.where(~np.isnan(FR[c]))[0]
            lo, hi = H0 + fh.min() * 3600, H0 + fh.max() * 3600
            if OIR[c][1] < lo or OIR[c][0] > hi:
                why.append('Binance OI rows do not overlap Hyperliquid funding')
        if c not in SIG:
            why.append('no Binance signal series')
        pm = pmap.get(c, {})
        if not pm.get('program'):
            why.append('no constant-product pool: ' + pm.get('out', 'not in pool map'))
        if why:
            excl[c] = why
        else:
            kept.append(c)
    # ---- m24 on the global 5-minute grid: median r24 over the 24 names with data at T
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

    def day_ok(c, day, flags, evals, rule):
        """flags/evals: lists of (array dict). rule 'clean': all evaluable, none true;
        'c1b': all evaluable, S false at all hours, F or O true at some hour."""
        h0 = (day * 86400 - H0) // 3600
        hs = range(h0, h0 + 24)
        if h0 < 0 or h0 + 24 > nH:
            return False
        for e in evals:
            if not all(hour_flag(e, c, h) for h in hs):
                return False
        if rule == 'clean':
            return not any(hour_flag(f, c, h) for f in flags for h in hs)
        s_any = any(all(hour_flag(f, c, h) for f in flags) for h in hs)
        one_any = any(hour_flag(f, c, h) for f in flags for h in hs)
        return (not s_any) and one_any

    # ---- event finder (generic over the trigger)
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
                            'funding_rate': float(FR[c][h]), 'b6': int(b6[i]),
                            'r24': None if np.isnan(r24[i]) else float(r24[i]),
                            'vol6': None if np.isnan(vol[i]) else float(vol[i])})
                last_T = T; days.add(T // 86400)
                break
        for e in evs:
            e['id'] = sha(TAG, e['coin'], e['T'])[:16]
            e['m24'] = m24(e['T'])
        return evs

    def candidates(c, day_pred):
        """Breakout bars of coin c whose T' falls on a UTC day passing day_pred, with full features."""
        t0, r, brk, b6, r24, vol = SIG[c]
        out, okday = [], {}
        for i in np.where(brk)[0]:
            T = t0 + int(i) * BAR + BAR
            if T + LAST_DELAY + HOLD > WALL or np.isnan(r24[i]) or np.isnan(vol[i]):
                continue
            dy = T // 86400
            if dy not in okday:
                okday[dy] = day_pred(dy)
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

    def sds(cands):
        a = np.array([[x['r24'], x['m24'], x['vol6']] for x in cands if not math.isnan(x['m24'])])
        return [float(v) for v in a.std(0, ddof=1)], len(a)

    def c2_draws(e, n=40):
        lo, hi = e['T'] - 30 * 86400, min(WALL - HOLD - LAST_DELAY, e['T'] + 30 * 86400)
        out = []
        for k in range(n):
            u = int(sha(TAG, e['id'], 'C2', k), 16)
            out.append(int(lo + u % (hi - lo + 1)))
        return out

    tables = {}
    # ---- primary: S = F & O
    S = {c: F[c] & O[c] for c in kept}
    prim = sum((find_events(c, S[c]) for c in kept), [])
    c1 = sum((candidates(c, lambda dy, c=c: day_ok(c, dy, [F, O], [FE, OE], 'clean')) for c in kept), [])
    sd, nsd = sds(c1)
    match(prim, c1, sd)
    c1b = sum((candidates(c, lambda dy, c=c: day_ok(c, dy, [F, O], [FE, OE], 'c1b')) for c in kept), [])
    c1b_events = [dict(e) for e in prim]
    match(c1b_events, c1b, sd)
    for e, eb in zip(prim, c1b_events):
        e['c1b_ranked'] = eb['controls_ranked']
        e['c2_draws'] = c2_draws(e)
    tables['primary'] = {'events': prim, 'sd': sd, 'n_sd_pool': nsd, 'n_c1_pool': len(c1), 'n_c1b_pool': len(c1b)}
    # ---- arm A: F + breakout; holdout seal
    A = sum((find_events(c, F[c]) for c in kept), [])
    days = sorted({e['T'] // 86400 for e in A})
    dsplit = days[len(days) // 2]
    sealed = sorted([[e['coin'], e['T']] for e in A if e['T'] // 86400 >= dsplit])
    seal_hash = hashlib.sha256(json.dumps(sealed, separators=(',', ':')).encode()).hexdigest()
    split_ts = dsplit * 86400
    pre = lambda T: T + LAST_DELAY + HOLD < split_ts
    A_pre = [e for e in A if pre(e['T'])]
    cA = [x for x in sum((candidates(c, lambda dy, c=c: day_ok(c, dy, [F], [FE], 'clean')) for c in kept), []) if pre(x['T'])]
    sdA, nA = sds(cA)
    match(A_pre, cA, sdA)
    tables['armA'] = {'events': A_pre, 'n_full': len(A), 'sd': sdA, 'n_sd_pool': nA,
                      'D_split': int(dsplit), 'D_split_utc': day_str(dsplit), 'sealed_n': len(sealed),
                      'sealed_sha256': seal_hash}
    # ---- arm B: F + HL daily OI + breakout (to 2026-04-03)
    Bk = [c for c in kept if c in B]
    Bev = [e for e in sum((find_events(c, F[c] & B[c]) for c in Bk), []) if pre(e['T'])]
    cB = [x for x in sum((candidates(c, lambda dy, c=c: day_ok(c, dy, [F, B], [FE, BE], 'clean')) for c in Bk), []) if pre(x['T'])]
    sdB, nB = sds(cB) if cB else ([1, 1, 1], 0)
    match(Bev, cB, sdB)
    tables['armB'] = {'events': Bev, 'sd': sdB, 'n_sd_pool': nB, 'coins': Bk}
    # ---- arm C: excess funding + O + breakout
    Cev = [e for e in sum((find_events(c, FC[c] & O[c]) for c in kept), []) if pre(e['T'])]
    cC = [x for x in sum((candidates(c, lambda dy, c=c: day_ok(c, dy, [FC, O], [FCE, OE], 'clean')) for c in kept), []) if pre(x['T'])]
    sdC, nC = sds(cC)
    match(Cev, cC, sdC)
    tables['armC'] = {'events': Cev, 'sd': sdC, 'n_sd_pool': nC}
    # ---- counts with no outcomes
    cut_time = {c: float(np.nanmax(FT[c])) for c in CUT if CUT[c]}         # last kept funding row
    info = {'kept': kept, 'excluded': excl, 'funding_cut_rows': CUT, 'cut_time': cut_time,
            'funding_low_hours': {c: int(F[c].sum()) for c in F}, 'pool_map_sha256': fsha(os.path.join(HERE, 'pool_map.json')),
            'classification_sha256': fsha(os.path.join(HERE, 'classification.json')),
            'n_primary': len(prim), 'primary_days': len({e['T'] // 86400 for e in prim}),
            'primary_coins': sorted({e['coin'] for e in prim})}
    table = {'info': info, 'tables': tables}
    os.makedirs(out, exist_ok=True)
    blob = json.dumps(table, sort_keys=True, separators=(',', ':')).encode()
    open(os.path.join(out, 'stage1.json'), 'wb').write(blob)
    print(json.dumps({k: v for k, v in info.items() if k != 'excluded'}, indent=0))
    print('excluded', json.dumps(excl))
    for k, v in tables.items():
        ev = v['events']
        nc = [len(e['controls_ranked']) for e in ev]
        print(k, 'events', len(ev), 'days', len({e['T'] // 86400 for e in ev}),
              'with>=3 ranked', sum(x >= 3 for x in nc), 'with>=10', sum(x >= 10 for x in nc))
    print('armA D_split', tables['armA']['D_split_utc'], 'sealed', len(sealed), seal_hash)
    print('stage1.json sha256', hashlib.sha256(blob).hexdigest())


def day_str(dy):
    import time
    return time.strftime('%Y-%m-%d', time.gmtime(dy * 86400))


def fsha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def arm_b_flags(d):
    """Daily flag per hour: the previous completed UTC day's HL OI (tokens) above >= 90% of the 30 days before
    it (>= 25 present). Returns hour-indexed bool arrays per coin."""
    p = os.path.join(d, 'hl', 'open_interest.json')
    if not os.path.exists(p):
        return {}, {}
    from arm_b import daily_oi_tokens                                 # parsing kept separate (format check)
    nH = (WALL - H0) // 3600
    B, BE = {}, {}
    for c, series in daily_oi_tokens(d).items():                      # {day_index: oi_tokens}
        if not series:
            continue
        d0, d1 = min(series), max(series)
        fl = np.zeros(nH, bool); ev = np.zeros(nH, bool)
        for h in range(nH):
            day = (H0 + h * 3600) // 86400
            prev = day - 1
            if prev not in series:
                continue
            past = [series[k] for k in range(prev - 30, prev) if k in series]
            if len(past) < 25:
                continue
            ev[h] = True
            fl[h] = sum(x < series[prev] for x in past) >= 0.9 * len(past)
        B[c], BE[c] = fl, ev
    return B, BE


if __name__ == '__main__':
    sys.path.insert(0, HERE)
    main(sys.argv[1], sys.argv[2])
