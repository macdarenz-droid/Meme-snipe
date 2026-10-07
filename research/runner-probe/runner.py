"""Runner probe: cut losses, ride the rare big winner (owner's concept, 2026-10-07).

  python3 -I runner.py run <sample.json> <hourlydir> <outdir> [configs.json]
"""
import json, os, random, statistics, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lottery-probe'))
import lottery

WALL = 1789999200
H = 3600
DAY = 86400
SIZES = {'$3': 3 / lottery.SOL_USD, '$10': 10 / lottery.SOL_USD, '$50': 50 / lottery.SOL_USD}
MAX_HOLD = 14 * 24
VOL_OK = 20.0          # SOL traded in a bar for an exit at the trailing level to count as fillable (optimistic mode)

def coins(sample, hdir):
    meta_f = os.path.join(hdir, '_before.json')
    meta = json.load(open(meta_f)) if os.path.exists(meta_f) else {}
    out, counts = [], {'ok': 0, 'dust': 0, 'start-missing': 0, 'no-data': 0, 'no-entry': 0}
    for u in json.load(open(sample)):
        p = os.path.join(hdir, u['pool'] + '.json')
        if not os.path.exists(p):
            counts['no-data'] += 1; continue
        s = lottery.load(p, meta.get(u['pool'], min(u['created_ts_ms'] // 1000 + 41 * DAY, WALL)))
        if not s:
            counts['no-data'] += 1; continue
        k = lottery.classify(s)
        if k != 'ok':
            counts[k] += 1; continue
        ts, c, v, lo, fo = s
        if len(ts) < 3 or not (v[0] > 0 or v[1] > 0) or min(lo[:2]) < lottery.FLOOR:
            counts['no-entry'] += 1; continue
        counts['ok'] += 1
        out.append({'u': u, 'ts': ts, 'c': c, 'v': v, 'lo': lo, 'slow': ts[0] - u['created_ts_ms'] // 1000 >= H})
    return out, counts

def trade(x, stop, arm, trail, mode):
    """Enter at the close of hour 1. Returns (p0, p_exit, reason)."""
    c, v, lo = x['c'], x['v'], x['lo']
    e = 1; p0 = c[e]; peak = p0; armed = False
    last = min(len(c) - 1, e + MAX_HOLD)
    for i in range(e + 1, last + 1):
        if stop is not None and lo[i] <= p0 * (1 - stop) and not armed:
            lvl = p0 * (1 - stop)
            return p0, (lvl if mode == 'opt' else min(lvl, c[i])), 'stop'
        if c[i] > peak and v[i] > 0:
            peak = c[i]
        if not armed and peak >= arm * p0:
            armed = True
        if armed and c[i] <= peak * (1 - trail):
            lvl = peak * (1 - trail)
            fill = lvl if (mode == 'opt' and v[i] >= VOL_OK) else c[i]
            return p0, fill, 'trail'
    return p0, c[last], 'time'

def stats(vals, seed=5):
    n = len(vals)
    if not n:
        return {'n': 0}
    rng = random.Random(seed)
    srt = sorted(vals)
    pos = sum(1 for _ in range(10000) if sum(vals[rng.randrange(n)] for _ in range(100)) > 0) / 10000
    return {'n': n, 'win': sum(1 for x in vals if x > 0) / n, 'mean': statistics.fmean(vals), 'median': statistics.median(vals),
            'best': srt[-1], 'mean_wo_best': statistics.fmean(srt[:-1]) if n > 1 else None,
            'per100_total': statistics.fmean(vals) * 100, 'p100_positive': pos}

GRID = [(stop, arm, trail) for stop in (0.3, 0.5, None) for arm in (2.0, 3.0) for trail in (0.4, 0.6)]

def run(sample, hdir, outdir, configs=None):
    os.makedirs(outdir, exist_ok=True)
    cs, counts = coins(sample, hdir)
    grid = [tuple(g) for g in json.load(open(configs))] if configs else GRID
    res = {}
    for filt in ('all', 'slow'):
        pool = [x for x in cs if filt == 'all' or x['slow']]
        for stop, arm, trail in grid:
            for mode in ('pess', 'opt'):
                key = f"{filt}|stop={stop}|arm={arm}|trail={trail}|{mode}"
                legs = [trade(x, stop, arm, trail, mode) for x in pool]
                for sz, q in SIZES.items():
                    vals = [lottery.net(p0, p1, q)[0] for p0, p1, _ in legs]
                    res[f'{key}|{sz}'] = stats(vals)
                res[f'{key}|reasons'] = {r: sum(1 for *_, rr in legs if rr == r) for r in ('stop', 'trail', 'time')}
    json.dump({'counts': counts, 'results': res}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(counts))

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
