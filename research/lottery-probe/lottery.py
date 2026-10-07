"""Lottery-basket probe analysis (rules in PREREG.md, fixed before any price was downloaded).

  python3 -I lottery.py run <sample.json> <hourlydir> <outdir>
"""
import json, math, os, random, statistics, sys

WALL = 1789999200
H = 3600
DAY = 86400
SOL_USD = 119.26
SIZES = {'$5': 5 / SOL_USD, '$20': 20 / SOL_USD, '$100': 100 / SOL_USD}
FIXED = 414009 / 1e9
K_MIG = 85 * 206_900_000
HOLDS = {'7d': 7 * 24, '14d': 14 * 24, '30d': 30 * 24}
FEE_TIERS = [(0, 125), (420, 120), (1470, 115), (2460, 110), (3440, 105), (4420, 100), (9820, 95), (14740, 90),
             (19650, 85), (24560, 80), (29470, 75), (34380, 70), (39300, 65), (44210, 60), (49120, 55), (54030, 53),
             (58940, 50), (63860, 48), (68770, 45), (73681, 43), (78590, 40), (83500, 38), (88400, 35), (93330, 33),
             (98240, 30)]

def fee(m):
    f = FEE_TIERS[0][1]
    for th, b in FEE_TIERS:
        if m >= th:
            f = b
    return f / 1e4

def R(m):
    return math.sqrt(K_MIG * max(m, 1e-9) / 1e9)

def net(p0, p1, q):
    g = p1 / p0 - 1
    m0, m1 = p0 * 1e9, p1 * 1e9
    q1 = q * (1 + g)
    x = (1 + g) * (1 - fee(m0)) * (1 - fee(m1)) / ((1 + q / R(m0)) * (1 + q1 / R(m1))) - 1 - FIXED / q
    return max(x, -1 - FIXED / q), g

def load(path):
    rows = [r for r in json.load(open(path)) if int(r[0]) + H <= WALL]
    if not rows:
        return None
    by = {int(r[0]): r for r in rows}
    t0, t1 = min(by), max(by)
    ts, c, v = [], [], []
    prev = float(by[t0][1])
    t = t0
    end = WALL - WALL % H - H                    # last hour bar ending at or before the wall
    while t <= end:
        r = by.get(t)
        cc, vv = (float(r[4]), float(r[5])) if r else (prev, 0.0)
        ts.append(t); c.append(cc); v.append(vv); prev = cc
        t += H
    return ts, c, v

def trades_for(u, s):
    ts, c, v = s
    out = []
    created = u['created_ts_ms'] // 1000
    slow = ts[0] - created >= H
    entries = {}
    if len(ts) > 1 and (v[1] > 0 or v[0] > 0):
        entries['LB-1H'] = 1
        if slow:
            entries['LB-SLOW'] = 1
    if len(ts) > 24 and any(v[k] > 0 for k in range(18, 24)):
        entries['LB-24H'] = 24
    for name, e in entries.items():
        for hk, hh in HOLDS.items():
            x = e + hh
            if x >= len(ts) or ts[x] + H > WALL:
                continue
            out.append({'line': f'{name}|{hk}', 'pool': u['pool'], 'day': created - created % DAY, 'p0': c[e], 'p1': c[x]})
    return out

def summarize(trs, q, seed=3):
    xs = []
    for t in trs:
        n_, g = net(t['p0'], t['p1'], q)
        xs.append((t['day'], n_, g))
    vals = [x[1] for x in xs]
    n = len(vals)
    if n == 0:
        return {'n': 0}
    wins = [x for x in vals if x > 0]; losses = [x for x in vals if x <= 0]
    srt = sorted(vals)
    k = max(1, n // 100)
    byday = {}
    for d, x, _ in xs:
        byday.setdefault(d, []).append(x)
    days = list(byday)
    rng = random.Random(seed)
    means = []
    for _ in range(5000):
        s_ = c_ = 0.0
        for _ in days:
            ys = byday[days[rng.randrange(len(days))]]
            s_ += sum(ys); c_ += len(ys)
        means.append(s_ / c_)
    means.sort()
    pos = 0
    for _ in range(10000):
        if sum(vals[rng.randrange(n)] for _ in range(100)) > 0:
            pos += 1
    return {
        'n': n, 'win': len(wins) / n, 'mean': statistics.fmean(vals), 'median': statistics.median(vals),
        'avg_win': statistics.fmean(wins) if wins else None, 'avg_loss': statistics.fmean(losses) if losses else None,
        'max_multiple': max(1 + x[2] for x in xs), 'mean_wo_top1pct': statistics.fmean(srt[:-k]) if n > k else None,
        'ci95': [means[int(0.025 * len(means))], means[int(0.975 * len(means)) - 1]],
        'p100_positive': pos / 10000,
    }

def run(sample, hdir, outdir):
    os.makedirs(outdir, exist_ok=True)
    sample = json.load(open(sample))
    have = nodata = 0
    trs = []
    for u in sample:
        p = os.path.join(hdir, u['pool'] + '.json')
        if not os.path.exists(p):
            continue
        s = load(p)
        if not s:
            nodata += 1
            continue
        have += 1
        trs += trades_for(u, s)
    lines = sorted({t['line'] for t in trs})
    res = {}
    for ln in lines:
        for sz, q in SIZES.items():
            res[f'{ln}|{sz}'] = summarize([t for t in trs if t['line'] == ln], q)
    verdict = {}
    for ln in lines:
        x = res[f'{ln}|$20']
        verdict[ln] = 'profitable' if (x['n'] and x['mean'] > 0 and x['ci95'][0] > 0 and x['p100_positive'] >= 0.6) else 'not supported'
    json.dump({'coins_sampled': len(sample), 'coins_with_data': have, 'coins_no_data': nodata, 'verdict': verdict, 'results': res},
              open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps({'coins_with_data': have, 'no_data': nodata, 'verdict': verdict}))

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
