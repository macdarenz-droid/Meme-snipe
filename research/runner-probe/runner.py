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
    if e + MAX_HOLD > len(c) - 1:
        return None                      # the full hold would run past the data window: left out (time-only)
    last = e + MAX_HOLD
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

def trade_ladder(x, stop, ladder, arm, trail, mode):
    """Cut loss at -stop until the first take-profit fills; sell fraction f at each multiple m in `ladder`
    [(m, f), ...]; the rest trails `trail` below its peak close once the close reaches `arm` x entry.
    Returns (p0, average exit price)."""
    c, v, lo = x['c'], x['v'], x['lo']
    raw_hi = x.get('hi') or c
    e = 1; p0 = c[e]; peak = p0; armed = False
    left = 1.0; got = 0.0; steps = list(ladder)
    if e + MAX_HOLD > len(c) - 1:
        return None
    last = e + MAX_HOLD
    for i in range(e + 1, last + 1):
        if stop is not None and left == 1.0 and lo[i] <= p0 * (1 - stop):
            lvl = p0 * (1 - stop)
            return p0, (lvl if mode == 'opt' else min(lvl, c[i]))
        while steps:
            m, f = steps[0]
            # a take-profit fills at its level, never above, and only in an hour with real volume;
            # the hourly line needs an hourly close at or above the level, the real-time line only the hour's high
            ok = v[i] >= VOL_OK and ((raw_hi[i] >= m * p0) if mode == 'opt' else (c[i] >= m * p0))
            if not ok:
                break
            sell = min(f, left)
            got += sell * m * p0
            left -= sell; steps.pop(0)
        if left <= 1e-9:
            return p0, got
        if c[i] > peak and v[i] > 0:
            peak = c[i]
        if not armed and peak >= arm * p0:
            armed = True
        if armed and c[i] <= peak * (1 - trail):
            lvl = peak * (1 - trail)
            fill = lvl if (mode == 'opt' and v[i] >= VOL_OK) else c[i]
            return p0, got + left * fill
    return p0, got + left * c[last]

LADDERS = {
    'TP5-all': [(5, 1.0)],
    'TP10-all': [(10, 1.0)],
    'half@5+trail': [(5, 0.5)],
    'third@3,7+trail': [(3, 1 / 3), (7, 1 / 3)],
    'quarter@5,10,20+trail': [(5, 0.25), (10, 0.25), (20, 0.25)],
}

def run_ladders(sample, hdir, outdir):
    os.makedirs(outdir, exist_ok=True)
    cs, counts = coins(sample, hdir)
    for x in cs:
        raw = {int(r[0]): r for r in json.load(open(os.path.join(hdir, x['u']['pool'] + '.json')))}
        x['hi'] = [float(raw[t][2]) if t in raw else x['c'][i] for i, t in enumerate(x['ts'])]
    res = {}
    for name, lad in LADDERS.items():
        for stop in (0.3, 0.5):
            for trail in (0.4, 0.6):
                for mode in ('pess', 'opt'):
                    legs = [l for l in (trade_ladder(x, stop, lad, 2.0, trail, mode) for x in cs) if l is not None]
                    vals = [lottery.net(p0, max(p1, 1e-18), SIZES['$10'])[0] for p0, p1 in legs]
                    res[f'{name}|stop={stop}|trail={trail}|{mode}|$10'] = stats(vals)
    json.dump({'counts': counts, 'results': res}, open(os.path.join(outdir, 'ladders.json'), 'w'), indent=1)

def bankroll(entries, bet):
    """Chronological account: every trade is a fixed bet placed at its entry hour and settled MAX_HOLD later at the
    latest (positions overlap). Reports cumulative P&L by calendar month, the worst drawdown and peak capital tied up."""
    import datetime
    ev = []
    for t, v in entries:
        ev.append((t, -bet, 0)); ev.append((t + MAX_HOLD * H, bet * (1 + v), 1))
    ev.sort()
    cash = 0.0; out = 0.0; peak_out = 0.0; pnl = 0.0; peak_pnl = 0.0; dd = 0.0; months = {}
    for t, amt, kind in ev:
        if kind == 0:
            out += bet; peak_out = max(peak_out, out)
        else:
            out -= bet; pnl += amt - bet
            peak_pnl = max(peak_pnl, pnl); dd = min(dd, pnl - peak_pnl)
            m = datetime.datetime.fromtimestamp(t, datetime.UTC).strftime('%Y-%m')
            months[m] = months.get(m, 0.0) + (amt - bet)
    return {'total_pnl_usd': pnl, 'worst_drawdown_usd': dd, 'peak_capital_tied_usd': peak_out, 'pnl_by_settle_month_usd': months}

def stats(vals, seed=5):
    n = len(vals)
    if not n:
        return {'n': 0}
    rng = random.Random(seed)
    srt = sorted(vals)
    pos = sum(1 for _ in range(10000) if sum(vals[rng.randrange(n)] for _ in range(100)) > 0) / 10000
    return {'n': n, 'win': sum(1 for x in vals if x > 0) / n, 'mean': statistics.fmean(vals), 'median': statistics.median(vals),
            'best': srt[-1], 'mean_wo_best': statistics.fmean(srt[:-1]) if n > 1 else None,
            'per100_total': statistics.fmean(vals) * 100,
            'p100_positive': pos, 'p100_note': 'share of 10,000 batches of 100 trades resampled from this sample whose total is > 0; cannot show winners never observed',
            'n_ge_10x': sum(1 for x in vals if x >= 9), 'n_ge_50x': sum(1 for x in vals if x >= 49)}

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
                legs = [(x, trade(x, stop, arm, trail, mode)) for x in pool]
                legs = [(x, l) for x, l in legs if l is not None]
                for sz, q in SIZES.items():
                    vals = [lottery.net(l[0], l[1], q)[0] for _, l in legs]
                    res[f'{key}|{sz}'] = stats(vals)
                    res[f'{key}|{sz}|capped20x'] = stats([min(v, 19.0) for v in vals])
                    if sz == '$10':
                        res[f'{key}|{sz}|bankroll'] = bankroll([(x['ts'][1], v) for (x, _), v in zip(legs, vals)], 10.0)
                res[f'{key}|reasons'] = {r: sum(1 for _, l in legs if l[2] == r) for r in ('stop', 'trail', 'time')}
    json.dump({'counts': counts, 'results': res}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(counts))

VALIDATION = {'R1': ('trail', 0.3, 2.0, 0.4), 'R2': ('trail', 0.3, 2.0, 0.6), 'R3': ('trail', None, 2.0, 0.4),
              'R4': ('ladder', 0.3, 2.0, 0.6)}

def validate(sample, hdir, outdir):
    """Exactly the pre-registered R1-R4, both execution lines, all usable coins."""
    os.makedirs(outdir, exist_ok=True)
    cs, counts = coins(sample, hdir)
    for x in cs:
        raw = {int(r[0]): r for r in json.load(open(os.path.join(hdir, x['u']['pool'] + '.json')))}
        x['hi'] = [float(raw[t][2]) if t in raw else x['c'][i] for i, t in enumerate(x['ts'])]
    res, verdict = {}, {}
    for name, (kind, stop, arm, trail) in VALIDATION.items():
        for mode in ('pess', 'opt'):
            legs = []
            for x in cs:
                l = trade(x, stop, arm, trail, mode) if kind == 'trail' else trade_ladder(x, stop, [(5, 0.5)], arm, trail, mode)
                if l is not None:
                    legs.append((x, l[0], max(l[1], 1e-18)))
            for sz, q in SIZES.items():
                vals = [lottery.net(p0, p1, q)[0] for _, p0, p1 in legs]
                res[f'{name}|{mode}|{sz}'] = stats(vals)
                res[f'{name}|{mode}|{sz}|capped20x'] = stats([min(v, 19.0) for v in vals])
                if sz == '$10':
                    res[f'{name}|{mode}|{sz}|bankroll'] = bankroll([(x['ts'][1], v) for (x, _, _), v in zip(legs, vals)], 10.0)
        a, b = res[f'{name}|pess|$10'], res[f'{name}|opt|$10']
        verdict[name] = 'supported' if (a.get('n') and a['mean'] > 0 and b.get('n') and b['mean'] > 0) else 'not supported'
    json.dump({'counts': counts, 'verdict': verdict, 'results': res}, open(os.path.join(outdir, 'validation.json'), 'w'), indent=1)
    print(json.dumps({'counts': counts, 'verdict': verdict}))

if __name__ == '__main__':
    {'run': run, 'ladders': run_ladders, 'validate': validate}[sys.argv[1]](*sys.argv[2:])
