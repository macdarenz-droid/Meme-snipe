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
DUST_OPEN = 5 / 206_900_000          # 2.41e-8 SOL: under 5 SOL at migration (H8)
FLOOR = 85 * 206_900_000 / 1e18      # 1.76e-8 SOL: below this a canonical pool has lost its depth
MIG = 85 / 206_900_000               # 4.108e-7 SOL: canonical effective migration price
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

def load(path, before):
    """Hourly closes carried across no-trade hours, only up to the fetched window's end."""
    rows = [r for r in json.load(open(path)) if int(r[0]) + H <= min(WALL, before)]
    if not rows:
        return None
    by = {int(r[0]): r for r in rows}
    t0 = min(by)
    ts, c, v, lo = [], [], [], []
    prev = float(by[t0][1])
    t = t0
    end = min(WALL, before) - H
    while t <= end:
        r = by.get(t)
        cc, vv, ll = (float(r[4]), float(r[5]), float(r[3])) if r else (prev, 0.0, prev)
        ts.append(t); c.append(cc); v.append(vv); lo.append(ll); prev = cc
        t += H
    return ts, c, v, lo, float(by[t0][1])

def classify(s):
    ts, c, v, lo, first_open = s
    if first_open < DUST_OPEN:
        return 'dust'
    if not (0.5 * MIG <= first_open <= 10 * MIG):
        return 'start-missing'
    return 'ok'

def trades_for(u, s):
    ts, c, v, lo, first_open = s
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
        if min(lo[:e + 1]) < FLOOR:          # pool lost its depth before entry (dust rule)
            continue
        for hk, hh in HOLDS.items():
            x = e + hh
            if x >= len(ts):
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
    pos_day = 0
    for _ in range(10000):
        tot = 0.0
        for _ in range(100):
            ys = byday[days[rng.randrange(len(days))]]
            tot += ys[rng.randrange(len(ys))]
        pos_day += tot > 0
    trimmed = srt[:-k] if n > k else srt
    pos_trim = sum(1 for _ in range(10000) if sum(trimmed[rng.randrange(len(trimmed))] for _ in range(100)) > 0)
    return {
        'n': n, 'win': len(wins) / n, 'mean': statistics.fmean(vals), 'median': statistics.median(vals),
        'avg_win': statistics.fmean(wins) if wins else None, 'avg_loss': statistics.fmean(losses) if losses else None,
        'max_multiple': max(1 + x[2] for x in xs), 'mean_wo_top1pct': statistics.fmean(srt[:-k]) if n > k else None,
        'ci95': [means[int(0.025 * len(means))], means[int(0.975 * len(means)) - 1]],
        'p100_positive': pos / 10000, 'p100_by_day': pos_day / 10000, 'p100_without_top1pct': pos_trim / 10000,
        'insufficient': n < 100,
    }

def run(sample, hdir, outdir):
    os.makedirs(outdir, exist_ok=True)
    sample = json.load(open(sample))
    missing = [u['pool'] for u in sample if not os.path.exists(os.path.join(hdir, u['pool'] + '.json'))]
    if missing:
        raise SystemExit(f'{len(missing)} of {len(sample)} coins have no file; refusing to run')
    meta = json.load(open(os.path.join(hdir, '_before.json'))) if os.path.exists(os.path.join(hdir, '_before.json')) else {}
    counts = {'ok': 0, 'dust': 0, 'start-missing': 0, 'no-data': 0}
    excluded = []
    trs = []
    for u in sample:
        before = meta.get(u['pool'], min(u['created_ts_ms'] // 1000 + 41 * DAY, WALL))
        s = load(os.path.join(hdir, u['pool'] + '.json'), before)
        if not s:
            counts['no-data'] += 1; excluded.append((u, 'no-data')); continue
        k = classify(s)
        counts[k] += 1
        if k != 'ok':
            if k == 'start-missing':
                excluded.append((u, k))
            continue
        trs += trades_for(u, s)
    lines = sorted({t['line'] for t in trs})
    res = {}
    for ln in lines:
        for sz, q in SIZES.items():
            res[f'{ln}|{sz}'] = summarize([t for t in trs if t['line'] == ln], q)
        # sensitivity: excluded no-data and start-missing coins booked at -100% - fixed, one trade each
        q = SIZES['$20']
        base = [t for t in trs if t['line'] == ln]
        vals = [net(t['p0'], t['p1'], q)[0] for t in base] + [-1 - FIXED / q] * len(excluded)
        res[f'{ln}|$20|worst-case-excluded'] = {'n': len(vals), 'mean': statistics.fmean(vals) if vals else None}
    verdict = {}
    for ln in lines:
        x = res[f'{ln}|$20']
        if x['n'] < 100:
            verdict[ln] = 'insufficient'
        else:
            verdict[ln] = 'profitable' if (x['mean'] > 0 and x['ci95'][0] > 0 and x['p100_positive'] >= 0.6) else 'not supported'
    json.dump({'coins_sampled': len(sample), 'counts': counts, 'excluded': [(u['pool'], why) for u, why in excluded],
               'verdict': verdict, 'results': res}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps({'counts': counts, 'verdict': verdict}))

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
