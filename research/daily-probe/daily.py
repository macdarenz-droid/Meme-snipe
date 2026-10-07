"""Daily-horizon probe (rules in PREREG.md, fixed before any return was computed).

  python3 -I daily.py run <universe.json> <dailydir> <outdir>
"""
import json, math, os, statistics, sys

WALL = 1789999200                      # 2026-09-21T14:00:00Z
DAY = 86400
DEC_START = 1780272000                 # 2026-06-01T00:00:00Z
VAL_START = 1786838400                 # 2026-08-16T00:00:00Z
SOL_USD = 119.26
SIZES = {'$200': 200 / SOL_USD, '$1000': 1000 / SOL_USD}
FIXED_SOL = 414009 / 1e9
K_MIG = 85 * 206_900_000
STRESS = 0.01
BOOT = 5000
FEE_TIERS = [(0, 125), (420, 120), (1470, 115), (2460, 110), (3440, 105), (4420, 100), (9820, 95), (14740, 90),
             (19650, 85), (24560, 80), (29470, 75), (34380, 70), (39300, 65), (44210, 60), (49120, 55), (54030, 53),
             (58940, 50), (63860, 48), (68770, 45), (73681, 43), (78590, 40), (83500, 38), (88400, 35), (93330, 33),
             (98240, 30)]
RULES = {'D-REV1': 1, 'D-REV3': 3, 'W-REV': 7, 'W-MOM': 7, 'TREND': 7}

def fee_bps(m):
    f = FEE_TIERS[0][1]
    for th, bps in FEE_TIERS:
        if m >= th:
            f = bps
    return f

def group(m):
    return 'A' if m >= 98240 else 'B' if m >= 49120 else 'C' if m >= 9820 else None

def net(g, m, q):
    return g - 2 * fee_bps(m) / 1e4 - 2 * q / math.sqrt(K_MIG * m / 1e9) - FIXED_SOL / q

def net_exact(g, m, m_exit, q):
    R = math.sqrt(K_MIG * m / 1e9)
    return (g - fee_bps(m) / 1e4 - q / R - fee_bps(m_exit) / 1e4 * (1 + g)
            - (q / R) * (1 + g) ** 1.5 - FIXED_SOL / q)

def load(path):
    """Contiguous daily closes and volumes from the first bar to the last full day before the wall."""
    d = json.load(open(path))
    lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
    rows = {int(r[0]): r for r in lst if int(r[0]) + DAY <= WALL}
    if not rows:
        return None
    t, last = min(rows), WALL - WALL % DAY - DAY          # last full UTC day: 2026-09-20
    ts, c, v = [], [], []
    prev = float(rows[t][1])
    while t <= last:
        r = rows.get(t)
        cc, vv = (float(r[4]), float(r[5])) if r else (prev, 0.0)
        ts.append(t); c.append(cc); v.append(vv); prev = cc
        t += DAY
    return ts, c, v

def candidates(uni, ddir):
    """Every eligible pool-day: (pool, D, entry index j, features, group, mcap)."""
    out, series = [], {}
    for u in json.load(open(uni)):
        p = os.path.join(ddir, u['pool'] + '.json')
        if not os.path.exists(p):
            continue
        s = load(p)
        if not s:
            continue
        series[u['pool']] = s
        ts, c, v = s
        real = 0
        for j in range(len(ts)):
            if j >= 8:
                D = ts[j]
                m = c[j - 1] * 1e9
                g = group(m)
                if D >= DEC_START and g and v[j - 1] > 0 and real >= 8 and min(c[j - 8:j]) > 0:
                    r1 = math.log(c[j - 1] / c[j - 2])
                    r7 = math.log(c[j - 1] / c[j - 8])
                    hi7 = max(c[j - 8:j - 1])
                    rets = [math.log(c[k] / c[k - 1]) for k in range(j - 7, j)]
                    out.append({'pool': u['pool'], 'sym': u['symbol'], 'D': D, 'j': j, 'r1': r1, 'r7': r7,
                                'newhigh': c[j - 1] > hi7, 'g': g, 'mcap': m, 'vol7': statistics.pstdev(rets)})
            if v[j] > 0:
                real += 1
    return out, series

def add_vol_bucket(cands):
    by = {}
    for x in cands:
        by.setdefault((x['D'], x['g']), []).append(x)
    for xs in by.values():
        xs.sort(key=lambda x: x['vol7'])
        n = len(xs)
        for i, x in enumerate(xs):
            x['vq'] = min(4, i * 5 // n)

def outcome(series, cand, H):
    ts, c, v = series[cand['pool']]
    k = cand['j'] + H - 1
    if k >= len(ts) or ts[k] + DAY > WALL:
        return None
    return c[k] / c[cand['j'] - 1] - 1, c[k] * 1e9

def select(cands):
    by_day = {}
    for x in cands:
        by_day.setdefault(x['D'], []).append(x)
    sel = {k: [] for k in RULES}
    for D, xs in by_day.items():
        for x in xs:
            if x['r1'] <= -0.25:
                sel['D-REV1'].append(x); sel['D-REV3'].append(x)
            if x['newhigh'] and x['r7'] > 0:
                sel['TREND'].append(x)
        if len(xs) >= 10:
            xs2 = sorted(xs, key=lambda x: x['r7'])
            k = math.ceil(0.2 * len(xs2))
            sel['W-REV'] += xs2[:k]
            sel['W-MOM'] += xs2[-k:]
    return sel

def t_quantile(p, df):
    def cdf(x):
        if x == 0:
            return 0.5
        b, n = abs(x), 2000
        hh = b / n
        cst = math.gamma((df + 1) / 2) / (math.sqrt(df * math.pi) * math.gamma(df / 2))
        f = lambda t: cst * (1 + t * t / df) ** (-(df + 1) / 2)
        area = (f(0) + f(b) + sum((4 if k % 2 else 2) * f(k * hh) for k in range(1, n))) * hh / 3
        return 0.5 + area if x > 0 else 0.5 - area
    lo, hi = -200.0, 200.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2

def batch_t(points, H, start):
    """points: list of (D, value, weight). Non-overlapping H-day calendar batches from `start`;
    each batch's weighted mean; t-interval over batches."""
    batches = {}
    for D, x, w in points:
        b = (D - start) // (H * DAY)
        s_, w_ = batches.get(b, (0.0, 0.0))
        batches[b] = (s_ + x * w, w_ + w)
    means = [s_ / w_ for s_, w_ in batches.values() if w_ > 0]
    k = len(means)
    if k < 3:
        return {'batches': k}
    m = statistics.fmean(means)
    se = statistics.stdev(means) / math.sqrt(k)
    out = {'batches': k, 'mean_of_batches': m}
    for lev, p in (('95', 0.975), ('99', 0.995)):
        tq = t_quantile(p, k - 1)
        out[lev] = [m - tq * se, m + tq * se]
    return out

def summarize(trs, s0, H, start, key='net'):
    if not trs:
        return {'n': 0}
    pool = {}
    for t in s0:
        pool.setdefault((t['D'], t['g'], t['vq']), []).append(t[key])
    diffs = []
    for t in trs:
        ref = pool.get((t['D'], t['g'], t['vq']))
        if ref:
            diffs.append((t['D'], t[key] - statistics.fmean(ref), 1.0))
    xs = [t[key] for t in trs]
    return {
        'n': len(trs), 'days': len({t['D'] for t in trs}), 'pools': len({t['pool'] for t in trs}),
        'mean': statistics.fmean(xs), 'median': statistics.median(xs),
        'win': sum(1 for x in xs if x > 0) / len(xs), 'mean_gross': statistics.fmean(t['gross'] for t in trs),
        'mean_stress': statistics.fmean(x - STRESS for x in xs),
        'ci': batch_t([(t['D'], t[key], 1.0) for t in trs], H, start),
        's0_mean': statistics.fmean(t[key] for t in s0) if s0 else None,
        'diff_vm_mean': statistics.fmean(d[1] for d in diffs) if diffs else None, 'diff_vm_n': len(diffs),
        'diff_vm_ci': batch_t(diffs, H, start) if diffs else None,
    }

def run(uni, ddir, outdir):
    os.makedirs(outdir, exist_ok=True)
    cands, series = candidates(uni, ddir)
    add_vol_bucket(cands)
    sel = select(cands)
    results = {}
    for name, H in list(RULES.items()) + [('S0-H1', 1), ('S0-H3', 3), ('S0-H7', 7)]:
        base = sel[name] if name in sel else cands
        rows, s0rows = [], []
        for src, dst in ((base, rows), (cands, s0rows)):
            for x in src:
                o = outcome(series, x, H)
                if o is not None:
                    dst.append({**x, 'gross': o[0], 'm_exit': o[1]})
        results[name] = {}
        for sz, q in SIZES.items():
            tr = [{**t, 'net': net(t['gross'], t['mcap'], q), 'exact': net_exact(t['gross'], t['mcap'], t['m_exit'], q)} for t in rows]
            s0 = [{**t, 'net': net(t['gross'], t['mcap'], q), 'exact': net_exact(t['gross'], t['mcap'], t['m_exit'], q)} for t in s0rows]
            for gname, gset in (('ABC', 'ABC'), ('AB', 'AB'), ('A', 'A'), ('C', 'C')):
                for per, (lo, hi) in (('disc', (DEC_START, VAL_START)), ('val', (VAL_START, WALL)), ('all', (DEC_START, WALL))):
                    f = lambda t: t['g'] in gset and lo <= t['D'] < hi
                    a, b = [t for t in tr if f(t)], [t for t in s0 if f(t)]
                    for key in ('net', 'exact'):
                        results[name][f'{sz}|{gname}|{per}|{key}'] = summarize(a, b, H, lo, key)
    verdict = {}
    for name in RULES:
        ok = True
        for key in ('net', 'exact'):
            v = results[name][f'$200|ABC|val|{key}']; d = results[name][f'$200|ABC|disc|{key}']
            ab = results[name][f'$200|AB|val|{key}']
            ok = ok and (v.get('n', 0) > 0 and v['mean'] > 0 and v['ci'].get('99') and v['ci']['99'][0] > 0
                         and v['diff_vm_ci'] and v['diff_vm_ci'].get('95') and v['diff_vm_ci']['95'][0] > 0
                         and ab.get('n', 0) > 0 and (ab['diff_vm_mean'] or 0) > 0
                         and d.get('n', 0) > 0 and d['mean'] > 0 and v['mean_stress'] > 0)
        verdict[name] = 'promising' if ok else 'not supported'
    json.dump({'verdict': verdict, 'results': results, 'n_candidates': len(cands), 'n_pools': len(series)},
              open(os.path.join(outdir, 'results.json'), 'w'), indent=0)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
