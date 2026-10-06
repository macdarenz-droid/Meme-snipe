"""Daily-horizon probe (rules in PREREG.md, fixed before any return was computed).

  python3 -I daily.py run <universe.json> <dailydir> <outdir>
"""
import json, math, os, random, statistics, sys

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
        for j in range(8, len(ts)):
            D = ts[j]
            if D < DEC_START:
                continue
            m = c[j - 1] * 1e9
            g = group(m)
            if not g or v[j - 1] <= 0 or min(c[j - 8:j]) <= 0:
                continue
            r1 = math.log(c[j - 1] / c[j - 2])
            r7 = math.log(c[j - 1] / c[j - 8])
            hi7 = max(c[j - 8:j - 1])
            out.append({'pool': u['pool'], 'sym': u['symbol'], 'D': D, 'j': j, 'r1': r1, 'r7': r7,
                        'newhigh': c[j - 1] > hi7, 'g': g, 'mcap': m})
    return out, series

def outcome(series, cand, H):
    ts, c, v = series[cand['pool']]
    k = cand['j'] + H - 1
    if k >= len(ts) or ts[k] + DAY > WALL:
        return None
    return c[k] / c[cand['j'] - 1] - 1

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

def block_boot(days_vals, L, reps=BOOT, seed=11):
    """days_vals: list of (day, [values]) in time order. Circular moving-block bootstrap of the trade-weighted mean."""
    n = len(days_vals)
    if n < 3:
        return None
    rng = random.Random(seed)
    means = []
    for _ in range(reps):
        s = cnt = 0.0
        picked = 0
        while picked < n:
            st = rng.randrange(n)
            for o in range(L):
                if picked >= n:
                    break
                xs = days_vals[(st + o) % n][1]
                s += sum(xs); cnt += len(xs); picked += 1
        if cnt:
            means.append(s / cnt)
    means.sort()
    q = lambda p: means[min(len(means) - 1, max(0, int(p * len(means))))]
    return {'95': [q(0.025), q(0.975)], '99': [q(0.005), q(0.995)]}

def summarize(trs, s0, H):
    if not trs:
        return {'n': 0}
    L = max(H, 3)
    byday = {}
    for t in trs:
        byday.setdefault(t['D'], []).append(t['net'])
    dv = sorted(byday.items())
    s0day = {}
    for t in s0:
        s0day.setdefault(t['D'], []).append(t['net'])
    diffs = [(D, [statistics.fmean(xs) - statistics.fmean(s0day[D])]) for D, xs in dv if D in s0day]
    xs = [t['net'] for t in trs]
    return {
        'n': len(trs), 'days': len(dv), 'pools': len({t['pool'] for t in trs}),
        'mean_net': statistics.fmean(xs), 'median_net': statistics.median(xs),
        'win': sum(1 for x in xs if x > 0) / len(xs), 'mean_gross': statistics.fmean(t['gross'] for t in trs),
        'mean_stress': statistics.fmean(x - STRESS for x in xs), 'ci': block_boot(dv, L),
        's0_mean_net': statistics.fmean(t['net'] for t in s0) if s0 else None,
        'diff_mean': statistics.fmean(d[1][0] for d in diffs) if diffs else None,
        'diff_ci': block_boot(diffs, L) if diffs else None,
    }

def run(uni, ddir, outdir):
    os.makedirs(outdir, exist_ok=True)
    cands, series = candidates(uni, ddir)
    sel = select(cands)
    results = {}
    for name, H in list(RULES.items()) + [('S0-H1', 1), ('S0-H3', 3), ('S0-H7', 7)]:
        base = sel[name] if name in sel else cands
        s0base = cands
        rows, s0rows = [], []
        for x in base:
            g = outcome(series, x, H)
            if g is not None:
                rows.append({**x, 'gross': g})
        for x in s0base:
            g = outcome(series, x, H)
            if g is not None:
                s0rows.append({**x, 'gross': g})
        results[name] = {}
        for sz, q in SIZES.items():
            tr = [{**t, 'net': net(t['gross'], t['mcap'], q)} for t in rows]
            s0 = [{**t, 'net': net(t['gross'], t['mcap'], q)} for t in s0rows]
            for gname, gset in (('ABC', 'ABC'), ('AB', 'AB'), ('A', 'A'), ('C', 'C')):
                for per, (lo, hi) in (('disc', (DEC_START, VAL_START)), ('val', (VAL_START, WALL)), ('all', (DEC_START, WALL))):
                    f = lambda t: t['g'] in gset and lo <= t['D'] < hi
                    results[name][f'{sz}|{gname}|{per}'] = summarize([t for t in tr if f(t)], [t for t in s0 if f(t)], H)
    verdict = {}
    for name in RULES:
        v = results[name]['$200|ABC|val']; d = results[name]['$200|ABC|disc']
        ok = (v.get('n', 0) > 0 and v['mean_net'] > 0 and v['ci'] and v['ci']['99'][0] > 0
              and v['diff_ci'] and v['diff_ci']['95'][0] > 0
              and d.get('n', 0) > 0 and d['mean_net'] > 0 and v['mean_stress'] > 0)
        verdict[name] = 'promising' if ok else 'not supported'
    json.dump({'verdict': verdict, 'results': results, 'n_candidates': len(cands), 'n_pools': len(series)},
              open(os.path.join(outdir, 'results.json'), 'w'), indent=0)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
