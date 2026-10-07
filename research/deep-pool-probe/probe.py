"""Deep-pool probe analysis (rules in PREREG.md, fixed before any return was computed).

  python3 -I probe.py eligible <universe.json> <dailydir> <out.json>
  python3 -I probe.py run <eligible.json> <barsdir> <outdir>
"""
import bisect, hashlib, json, math, os, random, statistics, sys

WALL = 1789999200                      # 2026-09-21T14:00:00Z
DAY = 86400
BAR = 300
DEC_START = 1784678400                 # 2026-07-22T00:00:00Z
VAL_START = 1788220800                 # 2026-09-01T00:00:00Z
SOL_USD = 119.26
SIZES = {'$50': 50 / SOL_USD, '$200': 200 / SOL_USD, '$500': 500 / SOL_USD}
FIXED_SOL = 414009 / 1e9
K_MIG = 85 * 206_900_000               # SOL x tokens, migration constant product
LOOKBACK = 864                         # 3 days of 5-minute bars
MIN_WINDOW = 500
STRESS = 0.005
SEEDS = 10
BOOT = 5000

FEE_TIERS = [(0, 125), (420, 120), (1470, 115), (2460, 110), (3440, 105), (4420, 100), (9820, 95), (14740, 90),
             (19650, 85), (24560, 80), (29470, 75), (34380, 70), (39300, 65), (44210, 60), (49120, 55), (54030, 53),
             (58940, 50), (63860, 48), (68770, 45), (73681, 43), (78590, 40), (83500, 38), (88400, 35), (93330, 33),
             (98240, 30)]

def fee_bps(mcap):
    f = FEE_TIERS[0][1]
    for th, bps in FEE_TIERS:
        if mcap >= th:
            f = bps
    return f

def group(mcap):
    if mcap >= 98240:
        return 'A'
    if mcap >= 49120:
        return 'B'
    if mcap >= 9820:
        return 'C'
    return None

# ---------- eligibility from daily bars (previous UTC day's close) ----------
def eligible(uni, ddir, out):
    res = []
    for u in json.load(open(uni)):
        p = os.path.join(ddir, u['pool'] + '.json')
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
        closes = {int(r[0]): float(r[4]) for r in lst if int(r[0]) + DAY <= WALL}
        days = {}
        t = DEC_START
        while t < WALL:
            c = closes.get(t - DAY)
            if c:
                m = c * 1e9
                g = group(m)
                if g:
                    days[t] = {'g': g, 'mcap': m}
            t += DAY
        if days:
            best = min(v['g'] for v in days.values())
            res.append({**u, 'best': best, 'days': {str(k): v for k, v in days.items()}})
    res.sort(key=lambda r: (r['best'], r['mint']))
    json.dump(res, open(out, 'w'))
    from collections import Counter
    print(len(res), 'eligible pools; by best group', Counter(r['best'] for r in res))

# ---------- bars ----------
def load_bars(path):
    raw = [r for r in json.load(open(path)) if int(r[0]) + BAR <= WALL]
    if not raw:
        return None
    raw.sort(key=lambda r: r[0])
    t0, t1 = int(raw[0][0]), int(raw[-1][0])
    by = {int(r[0]): r for r in raw}
    ts, o, h, l, c, v = [], [], [], [], [], []
    prev = float(raw[0][1])
    t = t0
    t_end = WALL - BAR                 # last bar that ends at or before the wall (PREREG amendment)
    while t <= t_end:
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
    'MR-A':    {'L': 1,  'dir': -1, 'z': 3.0, 'vol': None,  'tp': 0.06, 'sl': 0.04, 'H': 6},
    'MR-A-LV': {'L': 1,  'dir': -1, 'z': 3.0, 'vol': 'low',  'tp': 0.06, 'sl': 0.04, 'H': 6},
    'MR-B':    {'L': 3,  'dir': -1, 'z': 3.0, 'vol': None,  'tp': 0.08, 'sl': 0.05, 'H': 12},
    'MR-B-LV': {'L': 3,  'dir': -1, 'z': 3.0, 'vol': 'low',  'tp': 0.08, 'sl': 0.05, 'H': 12},
    'MOM-C':   {'L': 12, 'dir': +1, 'z': 3.0, 'vol': 'high', 'tp': 0.08, 'sl': 0.04, 'H': 24},
}

def signals(bars, cfg, traded_min=False):
    """Indices i of signal bars; uses only bars <= i. traded_min: the 500-bar minimum counts bars with volume."""
    ts, o, h, l, c, v = bars
    L = cfg['L']
    n = len(c)
    rets = [float('nan')] * n
    vols = [0.0] * n
    for i in range(L, n):
        rets[i] = lret(c, i, L)
        vols[i] = sum(v[i - L + 1:i + 1])
    out = []
    # Rolling sums over rets[i - LOOKBACK : i] (the previous 3 days, never bar i itself).
    s = ss = 0.0
    cnt = 0
    traded = sum(1 for j in range(L, L + LOOKBACK) if v[j] > 0)
    for j in range(L, L + LOOKBACK):
        if not math.isnan(rets[j]):
            s += rets[j]; ss += rets[j] * rets[j]; cnt += 1
    for i in range(L + LOOKBACK, n - 1):
        if i > L + LOOKBACK:
            add, drop = rets[i - 1], rets[i - 1 - LOOKBACK]
            if not math.isnan(add):
                s += add; ss += add * add; cnt += 1
            if not math.isnan(drop):
                s -= drop; ss -= drop * drop; cnt -= 1
            traded += (1 if v[i - 1] > 0 else 0) - (1 if v[i - 1 - LOOKBACK] > 0 else 0)
        if cnt < MIN_WINDOW or math.isnan(rets[i]) or v[i] <= 0:
            continue
        if traded_min and traded < MIN_WINDOW:
            continue
        var = ss / cnt - (s / cnt) ** 2
        sd = math.sqrt(var) if var > 0 else 0.0
        if sd <= 0:
            continue
        z = rets[i] / sd
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
    return out

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
    if last >= len(c) or ts[last] + BAR > WALL:
        return None
    if p0 <= 0:
        return None
    tp, sl = p0 * (1 + cfg['tp']), p0 * (1 - cfg['sl'])
    for j in range(first, last + 1):
        if j > first and o[j] <= sl:
            return j, o[j] / p0 - 1, k
        if l[j] <= sl:
            fill = min(sl, c[j]) if real else sl
            return j, fill / p0 - 1, k
        if h[j] >= tp:
            return j, tp / p0 - 1, k
    return last, c[last] / p0 - 1, k

def net(gross, mcap, q):
    """Additive, as written in PREREG: gross - 2 fee - 2 q/R - fixed/q."""
    f = fee_bps(mcap) / 1e4
    R = math.sqrt(K_MIG * mcap / 1e9)
    return gross - 2 * f - 2 * q / R - FIXED_SOL / q

def day_of(t):
    return t - t % DAY

def run_pool(pool, bars, cfg, real=False):
    days = {int(k): v for k, v in pool['days'].items()}
    ts, c = bars[0], bars[4]
    trades, busy_until, used_days = [], -1, set()
    for i in signals(bars, cfg, traded_min=real):
        e = i + 1
        if e <= busy_until:
            continue
        d = day_of(ts[e])
        if d not in days or d in used_days or ts[e] < DEC_START:
            continue
        sim = simulate(bars, e, cfg, real)
        if not sim:
            continue
        x, g, k = sim
        busy_until = x
        used_days.add(d)
        mcap = c[i] * 1e9 if real else days[d]['mcap']
        trades.append({'pool': pool['pool'], 'sym': pool['symbol'], 't': ts[e], 'day': d, 'g': g, 'grp': days[d]['g'], 'mcap': mcap})
    return trades

def run_s0(pool, bars, cfg, seed, real=False):
    days = {int(k): v for k, v in pool['days'].items()}
    ts, c = bars[0], bars[4]
    out = []
    for d, info in days.items():
        lo = bisect.bisect_left(ts, max(d, ts[0] + (LOOKBACK + cfg['L']) * BAR))
        hi = bisect.bisect_left(ts, d + DAY)
        if hi - lo < 1:
            continue
        hsh = int(hashlib.sha256(f"{seed}|{pool['pool']}|{d}".encode()).hexdigest(), 16)
        e = lo + hsh % (hi - lo)
        sim = simulate(bars, e, cfg, real)
        if sim:
            mcap = c[max(sim[2] - 1, 0)] * 1e9 if real else info['mcap']
            out.append({'pool': pool['pool'], 't': ts[e], 'day': d, 'g': sim[1], 'grp': info['g'], 'mcap': mcap})
    return out

def boot_ci(trs, key, reps=BOOT, seed=7):
    byday = {}
    for t in trs:
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
    """Inverse Student t CDF by bisection on a Simpson-integrated density."""
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

def t_ci(trs, key):
    byday = {}
    for t in trs:
        byday.setdefault(t['day'], []).append(t[key])
    D = len(byday)
    if D < 3:
        return None
    N = sum(len(x) for x in byday.values())
    m = sum(sum(x) for x in byday.values()) / N
    var = sum((sum(x) - len(x) * m) ** 2 for x in byday.values()) / N ** 2 * D / (D - 1)
    se = math.sqrt(var)
    out = {}
    for lev, p in (('95', 0.975), ('99', 0.995)):
        tq = t_quantile(p, D - 1)
        out[lev] = [m - tq * se, m + tq * se]
    return out

def summarize(trs, s0):
    if not trs:
        return {'n': 0}
    xs = [t['net'] for t in trs]
    return {
        'n': len(trs), 'days': len({t['day'] for t in trs}), 'pools': len({t['pool'] for t in trs}),
        'mean_net': statistics.fmean(xs), 'median_net': statistics.median(xs),
        'win': sum(1 for x in xs if x > 0) / len(xs),
        'mean_gross': statistics.fmean(t['g'] for t in trs),
        'mean_stress': statistics.fmean(t['net'] - STRESS for t in trs),
        'ci': boot_ci(trs, 'net'), 't_ci': t_ci(trs, 'net'),
        's0_n': len(s0), 's0_mean_net': statistics.fmean(t['net'] for t in s0) if s0 else None,
    }

def run(elig, bdir, outdir):
    os.makedirs(outdir, exist_ok=True)
    pools = json.load(open(elig))
    modes = ('reg', 'real')
    allt = {(m, k): [] for m in modes for k in CONFIGS}
    alls0 = {(m, k): [] for m in modes for k in CONFIGS}
    manifest = []
    for p in pools:
        path = os.path.join(bdir, p['pool'] + '.json')
        if not os.path.exists(path):
            continue
        manifest.append({'pool': p['pool'], 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest()})
        bars = load_bars(path)
        if not bars or len(bars[0]) < LOOKBACK + 20:
            continue
        for m in modes:
            real = m == 'real'
            for k, cfg in CONFIGS.items():
                allt[(m, k)] += run_pool(p, bars, cfg, real)
                for sd in range(SEEDS):
                    alls0[(m, k)] += run_s0(p, bars, cfg, sd, real)
    results = {}
    for m in modes:
        for k in CONFIGS:
            key = k if m == 'reg' else k + ' (realistic)'
            results[key] = {}
            for sz, q in SIZES.items():
                tr = [{**t, 'net': net(t['g'], t['mcap'], q)} for t in allt[(m, k)]]
                s0 = [{**t, 'net': net(t['g'], t['mcap'], q)} for t in alls0[(m, k)]]
                for gname, gset in (('AB', 'AB'), ('A', 'A'), ('B', 'B'), ('C', 'C')):
                    for per, (lo, hi) in (('disc', (DEC_START, VAL_START)), ('val', (VAL_START, WALL)), ('all', (DEC_START, WALL))):
                        f = lambda t: t['grp'] in gset and lo <= t['t'] < hi
                        results[key][f'{sz}|{gname}|{per}'] = summarize([t for t in tr if f(t)], [t for t in s0 if f(t)])
    verdict = {}
    for k in CONFIGS:
        v = results[k]['$200|AB|val']; d = results[k]['$200|AB|disc']
        ok = (v.get('n', 0) > 0 and v['mean_net'] > 0 and v['ci'] and v['ci']['99'][0] > 0
              and v['s0_mean_net'] is not None and v['mean_net'] > v['s0_mean_net']
              and d.get('n', 0) > 0 and d['mean_net'] > 0 and v['mean_stress'] > 0)
        verdict[k] = 'promising' if ok else 'not supported'
    json.dump({'results': results, 'verdict': verdict, 'manifest': manifest}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'eligible': eligible, 'run': run}[sys.argv[1]](*sys.argv[2:])
