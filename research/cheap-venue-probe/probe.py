"""Cheap-venue probe analysis (rules in PREREG.md, fixed before any return was computed).

  python3 -I probe.py universe <dl_dir> <exclusions.json> <seeds.json> <out universe.json>
  python3 -I probe.py run <universe.json> <barsdir> <outdir>
"""
import hashlib, json, math, os, random, statistics, sys

WALL = 1789999200                      # 2026-09-21T14:00:00Z
DAY = 86400
BAR = 300
DEC_START = 1784678400                 # 2026-07-22T00:00:00Z
VAL_START = 1787270400                 # 2026-08-21T00:00:00Z
SOL_USD = 119.26                       # repo constant (deep-pool and lottery probes)
SIZES = {'$200': 200.0, '$1000': 1000.0}
FIXED = 414009 / 1e9                   # research/lottery-probe/lottery.py FIXED, SOL per round trip
LOOKBACK = 864                         # 3 days of 5-minute bars
MIN_WINDOW = 500
STRESS = 0.01
SEEDS = 10
BOOT = 5000
WSOL = 'So11111111111111111111111111111111111111112'
MIN_RESERVE = 250_000
MAX_FEE = 0.003
OK_RAYDIUM = {'675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
              'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
              'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM'}
ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
CONCENTRATED = {'Raydium CLMM', 'Orca Whirlpool'}

# ---------- universe (PREREG "Universe"; no prices read) ----------
def universe(dl, excl_path, seeds_path, out):
    excl = json.load(open(excl_path))
    seeds = {s['mint'] for s in json.load(open(seeds_path))}
    fees = json.load(open(os.path.join(dl, 'fees.json')))
    tdir = os.path.join(dl, 'tokens')
    pools, tokens, dropped = [], [], []
    for f in sorted(os.listdir(tdir)):
        mint = f[:-5]
        d = json.load(open(os.path.join(tdir, f)))
        info = d.get('info') or {}
        row = {'mint': mint, 'symbol': info.get('symbol'), 'name': info.get('name'),
               'categories': info.get('categories'), 'seed': mint in seeds}
        if mint in excl:
            dropped.append({**row, 'reason': excl[mint]})
            continue
        best, why = None, []
        for p in d['pools']:
            if WSOL not in (p['base'], p['quote']) or p['reserve_usd'] < MIN_RESERVE:
                continue
            fr = fees.get(p['pool'])
            if not fr or fr.get('fee') is None:
                why.append(f"{p['pool']} {p['dex']}: fee not verified")
                continue
            if fr.get('src') == 'raydium-api':
                venue = OK_RAYDIUM.get(fr.get('program'))
            elif fr.get('program') == ORCA:
                venue = 'Orca Whirlpool' if fr.get('fee_tier_seed') == fr.get('tick_spacing') else None
            else:
                venue = None
            if not venue:
                why.append(f"{p['pool']} {p['dex']}: venue not allowed or adaptive fee")
                continue
            if fr['fee'] > MAX_FEE + 1e-12:
                why.append(f"{p['pool']} {venue}: fee {fr['fee']:.4%} > 0.30%")
                continue
            fee = fr['fee']
            if venue == 'Raydium CPMM':
                # PREREG amendment: the creator fee is charged as if enabled (not verified per pool), an upper bound.
                fee += fr.get('creator_fee') or 0
            if fee > MAX_FEE + 1e-12:
                why.append(f"{p['pool']} {venue}: fee {fee:.4%} (with creator fee) > 0.30%")
                continue
            cand = {**p, 'venue': venue, 'fee': fee}
            if best is None or (cand['fee'], -cand['reserve_usd']) < (best['fee'], -best['reserve_usd']):
                best = cand
        if best:
            pools.append({'mint': mint, 'symbol': row['symbol'], 'seed': row['seed'], **best})
        else:
            tokens.append({**row, 'why': why or ['no SOL pool with reserve >= $250k']})
    pools.sort(key=lambda r: r['mint'])
    json.dump({'pools': pools, 'excluded_non_meme': dropped, 'no_qualifying_pool': tokens}, open(out, 'w'), indent=1)
    print(len(pools), 'pools;', len(dropped), 'non-meme;', len(tokens), 'without a qualifying pool')

# ---------- bars ----------
def load_bars(path):
    raw = [r for r in json.load(open(path)) if int(r[0]) + BAR <= WALL]
    if not raw:
        return None
    raw.sort(key=lambda r: r[0])
    by = {int(r[0]): r for r in raw}
    ts, o, h, l, c, v = [], [], [], [], [], []
    prev = float(raw[0][1])
    t = int(raw[0][0])
    while t <= WALL - BAR:
        r = by.get(t)
        if r:
            oo, hh, ll, cc, vv = map(float, r[1:6])
        else:
            oo = hh = ll = cc = prev
            vv = 0.0
        ts.append(t); o.append(oo); h.append(hh); l.append(ll); c.append(cc); v.append(vv)
        prev = cc
        t += BAR
    return ts, o, h, l, c, v

def lret(c, i, L):
    a, b = c[i - L], c[i]
    return math.log(b / a) if a > 0 and b > 0 else float('nan')

CONFIGS = {
    'MR-A':    {'L': 1,  'dir': -1, 'z': 3.0, 'vol': None,   'tp': 0.06, 'sl': 0.04, 'H': 6},
    'MR-A-LV': {'L': 1,  'dir': -1, 'z': 3.0, 'vol': 'low',  'tp': 0.06, 'sl': 0.04, 'H': 6},
    'MR-B':    {'L': 3,  'dir': -1, 'z': 3.0, 'vol': None,   'tp': 0.08, 'sl': 0.05, 'H': 12},
    'MR-B-LV': {'L': 3,  'dir': -1, 'z': 3.0, 'vol': 'low',  'tp': 0.08, 'sl': 0.05, 'H': 12},
    'MOM-C':   {'L': 12, 'dir': +1, 'z': 3.0, 'vol': 'high', 'tp': 0.08, 'sl': 0.04, 'H': 24},
}

def window_ok(bars, cfg, traded_min):
    """ok[i]: bar i has the 3-day look-back (>= 500 valid returns; with traded_min, >= 500 traded bars)
    using bars < i only. Also returns sd[i] of the previous LOOKBACK L-bar returns."""
    ts, o, h, l, c, v = bars
    L, n = cfg['L'], len(c)
    rets = [float('nan')] * n
    for i in range(L, n):
        rets[i] = lret(c, i, L)
    ok, sd = [False] * n, [0.0] * n
    s = ss = 0.0
    cnt = traded = 0
    for i in range(L, n):
        # window = rets[i-LOOKBACK : i] (bars strictly before i), restricted to indices >= L
        if i - 1 >= L:
            a = rets[i - 1]
            if not math.isnan(a):
                s += a; ss += a * a; cnt += 1
            traded += 1 if v[i - 1] > 0 else 0
        j = i - 1 - LOOKBACK
        if j >= L:
            dd = rets[j]
            if not math.isnan(dd):
                s -= dd; ss -= dd * dd; cnt -= 1
            traded -= 1 if v[j] > 0 else 0
        if i < L + LOOKBACK or cnt < MIN_WINDOW or (traded_min and traded < MIN_WINDOW):
            continue
        var = ss / cnt - (s / cnt) ** 2
        if var > 0:
            ok[i], sd[i] = True, math.sqrt(var)
    return rets, ok, sd

def signals(bars, cfg, traded_min=False):
    """Indices i of signal bars; uses only bars <= i."""
    ts, o, h, l, c, v = bars
    L, n = cfg['L'], len(c)
    rets, ok, sd = window_ok(bars, cfg, traded_min)
    vols = [0.0] * n
    for i in range(L, n):
        vols[i] = sum(v[i - L + 1:i + 1])
    out = []
    for i in range(n - 1):
        if not ok[i] or math.isnan(rets[i]) or v[i] <= 0:
            continue
        z = rets[i] / sd[i]
        if cfg['dir'] < 0 and z > -cfg['z']:
            continue
        if cfg['dir'] > 0 and z < cfg['z']:
            continue
        if cfg['vol']:
            med = statistics.median(vols[i - LOOKBACK:i])
            if cfg['vol'] == 'low' and not vols[i] <= 2 * med:
                continue
            if cfg['vol'] == 'high' and not vols[i] >= 2 * med:
                continue
        out.append(i)
    return out, ok

def simulate(bars, e, cfg, real=False):
    """Registered: enter at the open of bar e, hold bars e..e+H-1.
    Realistic: enter at the close of the first bar with volume among e..e+2, hold the next H bars,
    and a stop fills at min(stop, that bar's close). Returns (exit_index, gross, entry_index) or None."""
    ts, o, h, l, c, v = bars
    if real:
        k = next((j for j in range(e, min(e + 3, len(c))) if v[j] > 0), None)
        if k is None:
            return None
        p0, first, last = c[k], k + 1, k + cfg['H']
    else:
        k, p0, first, last = e, o[e], e, e + cfg['H'] - 1
    if last >= len(c) or ts[last] + BAR > WALL or p0 <= 0:
        return None
    tp, sl = p0 * (1 + cfg['tp']), p0 * (1 - cfg['sl'])
    for j in range(first, last + 1):
        if j > first and o[j] <= sl:
            return j, o[j] / p0 - 1, k
        if l[j] <= sl:
            return j, (min(sl, c[j]) if real else sl) / p0 - 1, k
        if h[j] >= tp:
            return j, tp / p0 - 1, k
    return last, c[last] / p0 - 1, k

def cost(pool, Q):
    """Round-trip cost as a fraction of the trade (PREREG: 2 fee + 2 Q/R + FIXED/q)."""
    R = pool['reserve_usd'] / 2
    return 2 * pool['fee'] + 2 * Q / R + FIXED / (Q / SOL_USD)

def day_of(t):
    return t - t % DAY

def period(t):
    if DEC_START <= t < VAL_START:
        return 'disc'
    if VAL_START <= t < WALL:
        return 'val'
    return None

def run_pool(pool, bars, cfg, real=False):
    ts = bars[0]
    sig, _ = signals(bars, cfg, traded_min=real)
    trades, busy_until, used_days = [], -1, set()
    for i in sig:
        e = i + 1
        if e <= busy_until or ts[e] < DEC_START:
            continue
        d = day_of(ts[e])
        if d in used_days:
            continue
        sim = simulate(bars, e, cfg, real)
        if not sim:
            continue
        x, g, k = sim
        busy_until = x
        used_days.add(d)
        trades.append({'pool': pool['pool'], 'sym': pool['symbol'], 't': ts[e], 'day': d, 'per': period(ts[e]), 'g': g})
    return trades

def matched_random(pool, bars, cfg, trade, ok, real=False):
    """PREREG: 10 entries, same pool, same UTC hour of day, a uniformly drawn other day of the same period
    on which the pool has the look-back; uniform 5-minute bar in that hour."""
    ts = bars[0]
    t0 = ts[0]
    hour = (trade['t'] % DAY) // 3600
    per = trade['per']
    lo, hi = (DEC_START, VAL_START) if per == 'disc' else (VAL_START, WALL)
    days = []
    d = lo
    while d < hi:
        if d != trade['day']:
            idx = [(d + hour * 3600 + m * BAR - t0) // BAR for m in range(12)]
            idx = [i for i in idx if 1 <= i < len(ts) and ts[i] + BAR <= WALL and ok[i - 1]]
            if idx:
                days.append(idx)
        d += DAY
    out = []
    if not days:
        return out
    for sd in range(SEEDS):
        hsh = int(hashlib.sha256(f"{sd}|{pool['pool']}|{trade['t']}".encode()).hexdigest(), 16)
        idx = days[hsh % len(days)]
        e = idx[(hsh // len(days)) % len(idx)]
        sim = simulate(bars, e, cfg, real)
        if sim:
            out.append(sim[1])
    return out

def boot_ci(rows, key, reps=BOOT, seed=7):
    byday = {}
    for t in rows:
        byday.setdefault(t['day'], []).append(t[key])
    ds = sorted(byday)
    if len(ds) < 2:
        return None
    rng = random.Random(seed)
    means = []
    for _ in range(reps):
        s, n = 0.0, 0
        for _ in ds:
            xs = byday[ds[rng.randrange(len(ds))]]
            s += sum(xs); n += len(xs)
        means.append(s / n)
    means.sort()
    q = lambda p: means[min(len(means) - 1, max(0, int(p * len(means))))]
    return {'95': [q(0.025), q(0.975)], '99': [q(0.005), q(0.995)]}

def t_quantile(p, df):
    def cdf(x):
        if x == 0:
            return 0.5
        a, b, n = 0.0, abs(x), 2000
        hh = (b - a) / n
        cst = math.gamma((df + 1) / 2) / (math.sqrt(df * math.pi) * math.gamma(df / 2))
        f = lambda t: cst * (1 + t * t / df) ** (-(df + 1) / 2)
        sm = f(a) + f(b) + sum((4 if k % 2 else 2) * f(a + k * hh) for k in range(1, n))
        area = sm * hh / 3
        return 0.5 + area if x > 0 else 0.5 - area
    lo, hi = -50.0, 50.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2

def t_ci(rows, key):
    byday = {}
    for t in rows:
        byday.setdefault(t['day'], []).append(t[key])
    D = len(byday)
    if D < 3:
        return None
    N = sum(len(x) for x in byday.values())
    m = sum(sum(x) for x in byday.values()) / N
    var = sum((sum(x) - len(x) * m) ** 2 for x in byday.values()) / N ** 2 * D / (D - 1)
    se = math.sqrt(var)
    return {lev: [m - t_quantile(p, D - 1) * se, m + t_quantile(p, D - 1) * se] for lev, p in (('95', 0.975), ('99', 0.995))}

def summarize(rows):
    if not rows:
        return {'n': 0}
    xs = [t['net'] for t in rows]
    withr = [t for t in rows if t['diff'] is not None]
    return {
        'n': len(rows), 'days': len({t['day'] for t in rows}), 'pools': len({t['pool'] for t in rows}),
        'mean_net': statistics.fmean(xs), 'median_net': statistics.median(xs),
        'win': sum(1 for x in xs if x > 0) / len(xs),
        'mean_gross': statistics.fmean(t['g'] for t in rows),
        'mean_cost': statistics.fmean(t['g'] - t['net'] for t in rows),
        'mean_stress': statistics.fmean(x - STRESS for x in xs),
        'ci': boot_ci(rows, 'net'), 't_ci': t_ci(rows, 'net'),
        'rand_n': sum(t['rand_n'] for t in rows),
        'rand_mean_net': statistics.fmean(t['rand_net'] for t in withr) if withr else None,
        'diff_n': len(withr),
        'diff_mean': statistics.fmean(t['diff'] for t in withr) if withr else None,
        'diff_ci': boot_ci(withr, 'diff'),
    }

def run(uni, bdir, outdir):
    os.makedirs(outdir, exist_ok=True)
    pools = json.load(open(uni))['pools']
    modes = ('reg', 'real')
    raw = {(m, k): [] for m in modes for k in CONFIGS}
    manifest = []
    for p in pools:
        path = os.path.join(bdir, p['pool'] + '.json')
        if not os.path.exists(path):
            continue
        rawb = json.load(open(path))
        manifest.append({'pool': p['pool'], 'sym': p['symbol'], 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(),
                         'bars': len(rawb), 'first': min((r[0] for r in rawb), default=None),
                         'last': max((r[0] for r in rawb), default=None)})
        bars = load_bars(path)
        if not bars or len(bars[0]) < LOOKBACK + 20:
            continue
        for m in modes:
            real = m == 'real'
            for k, cfg in CONFIGS.items():
                _, ok = signals(bars, cfg, traded_min=real)
                for t in run_pool(p, bars, cfg, real):
                    if t['per'] is None:
                        continue
                    t['rand_g'] = matched_random(p, bars, cfg, t, ok, real)
                    t['fee'], t['reserve_usd'] = p['fee'], p['reserve_usd']
                    raw[(m, k)].append(t)
    results, trades_out = {}, {}
    for m in modes:
        for k in CONFIGS:
            key = k if m == 'reg' else k + ' (realistic)'
            results[key] = {}
            for sz, Q in SIZES.items():
                rows = []
                for t in raw[(m, k)]:
                    c = cost(t, Q)
                    rn = [g - c for g in t['rand_g']]
                    rmean = statistics.fmean(rn) if rn else None
                    rows.append({**t, 'net': t['g'] - c, 'rand_n': len(rn), 'rand_net': rmean,
                                 'diff': (t['g'] - c - rmean) if rn else None})
                for per in ('disc', 'val'):
                    results[key][f'{sz}|{per}'] = summarize([r for r in rows if r['per'] == per])
                if sz == '$200' and m == 'reg':
                    trades_out[k] = [{x: r[x] for x in ('sym', 'pool', 't', 'per', 'g', 'net', 'rand_net')} for r in rows]
    verdict = {}
    for k in CONFIGS:
        v, d = results[k]['$200|val'], results[k]['$200|disc']
        ok = (v.get('n', 0) > 0 and v['mean_net'] > 0 and v['ci'] and v['ci']['99'][0] > 0
              and v['diff_ci'] and v['diff_ci']['95'][0] > 0
              and d.get('n', 0) > 0 and d['mean_net'] > 0 and v['mean_stress'] > 0)
        verdict[k] = 'promising' if ok else 'not supported'
    json.dump({'results': results, 'verdict': verdict, 'manifest': manifest, 'trades_$200_registered': trades_out},
              open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'universe': universe, 'run': run}[sys.argv[1]](*sys.argv[2:])
