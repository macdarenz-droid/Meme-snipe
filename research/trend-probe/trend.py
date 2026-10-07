"""Established-meme trend probe (rules in PREREG.md, fixed before any return was computed).

  python3 -I trend.py run <hl_dir> <outdir>
"""
import glob, json, math, os, statistics, sys

WALL = 1789999200                      # 2026-09-21T14:00:00Z
DAYS = 86400
START = 1704067200                     # Monday 2024-01-01
VAL = 1751328000                       # 2025-07-01
COINS = ['AI16Z', 'BOME', 'CHILLGUY', 'FARTCOIN', 'GOAT', 'GRIFFAIN', 'MELANIA', 'MEW', 'MOODENG', 'MYRO',
         'PENGU', 'PNUT', 'POPCAT', 'PUMP', 'SPX', 'TRUMP', 'USELESS', 'WIF', 'kBONK']
COSTS = {'base': 0.006, 'stress': 0.012}

def load(path):
    rows = json.load(open(path))
    out = {}
    for r in rows:
        if int(r['T']) // 1000 + 1 <= WALL:          # bar ends (T is the last ms) at or before the wall
            out[int(r['t']) // 1000 // DAYS] = float(r['c'])
    return out

def t_ci(xs, p=0.975):
    n = len(xs)
    if n < 3:
        return None
    m, se = statistics.fmean(xs), statistics.stdev(xs) / math.sqrt(n)
    # t quantile by bisection on a Simpson-integrated density
    df = n - 1
    cst = math.gamma((df + 1) / 2) / (math.sqrt(df * math.pi) * math.gamma(df / 2))
    f = lambda t: cst * (1 + t * t / df) ** (-(df + 1) / 2)
    def cdf(x):
        k, hh = 2000, x / 2000
        return 0.5 + (f(0) + f(x) + sum((4 if i % 2 else 2) * f(i * hh) for i in range(1, k))) * hh / 3
    lo, hi = 0.0, 50.0
    for _ in range(70):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if cdf(mid) < p else (lo, mid)
    tq = (lo + hi) / 2
    return [m - tq * se, m + tq * se]

def run(hl, outdir):
    os.makedirs(outdir, exist_ok=True)
    sol = load(os.path.join(hl, 'candles_1d_SOL.json'))
    px = {}
    for c in COINS:
        raw = load(os.path.join(hl, f'candles_1d_{c}.json'))
        px[c] = {d: v / sol[d] for d, v in raw.items() if d in sol and sol[d] > 0 and v > 0}
    first = {c: min(px[c]) for c in COINS if px[c]}
    last = {c: max(px[c]) for c in COINS if px[c]}
    last_full = (WALL // DAYS) - 1                    # 2026-09-20
    weeks = []
    D = START // DAYS
    while D + 6 <= last_full:
        weeks.append(D)
        D += 7

    def r_back(c, D, L):
        a, b = px[c].get(D - 1 - L), px[c].get(D - 1)
        return None if a is None or b is None else b / a - 1

    def fwd(c, D):
        p0 = px[c].get(D - 1)
        if p0 is None:
            return None
        end = min(D + 6, last[c])
        while end >= D and end not in px[c]:
            end -= 1
        return px[c][end] / p0 - 1 if end >= D else 0.0

    def eligible(D):
        return [c for c in COINS if c in first and D >= first[c] + 35 and last[c] >= D - 1 and (D - 1) in px[c]]

    def choose(rule, D):
        el = eligible(D)
        if rule == 'HOLD-ALL':
            return el
        if rule in ('TSM-28', 'TSM-14'):
            L = 28 if rule == 'TSM-28' else 14
            return [c for c in el if (r_back(c, D, L) or -1) > 0]
        if len(el) < 6:
            return []
        if rule == 'XS-MOM':
            sc = [(r_back(c, D, 28), c) for c in el if r_back(c, D, 28) is not None]
            return [c for _, c in sorted(sc)[-3:]]
        if rule == 'XS-REV':
            sc = [(r_back(c, D, 7), c) for c in el if r_back(c, D, 7) is not None]
            return [c for _, c in sorted(sc)[:3]]

    results, series = {}, {}
    for rule in ('TSM-28', 'TSM-14', 'XS-MOM', 'XS-REV', 'HOLD-ALL'):
        for ck, cost in COSTS.items():
            prev, rows = [], []
            for D in weeks:
                held = choose(rule, D)
                rets = [fwd(c, D) for c in held]
                rets = [x for x in rets if x is not None]
                enter = [c for c in held if c not in prev]
                exit_ = [c for c in prev if c not in held]
                cc = (len(enter) * cost / 2 / len(held) if held else 0.0) + (len(exit_) * cost / 2 / len(prev) if prev else 0.0)
                r = (statistics.fmean(rets) if rets else 0.0) - cc
                rows.append({'D': D, 'r': r, 'n': len(held)})
                prev = held
            series[(rule, ck)] = rows
    for (rule, ck), rows in series.items():
        hold = {x['D']: x['r'] for x in series[('HOLD-ALL', ck)]}
        for per, (lo, hi) in (('disc', (START, VAL)), ('val', (VAL, WALL)), ('all', (START, WALL))):
            xs = [x for x in rows if lo // DAYS <= x['D'] < hi // DAYS]
            rs = [x['r'] for x in xs]
            if not rs:
                continue
            g = 1.0; peak = 1.0; worst4 = 0.0
            for i in range(len(rs)):
                g *= 1 + rs[i]
                w = 1.0
                for x in rs[max(0, i - 3):i + 1]:
                    w *= 1 + x
                worst4 = min(worst4, w - 1)
            diffs = [x['r'] - hold[x['D']] for x in xs]
            results[f'{rule}|{ck}|{per}'] = {
                'weeks': len(rs), 'mean': statistics.fmean(rs), 'median': statistics.median(rs),
                'growth': g - 1, 'pos': sum(1 for x in rs if x > 0) / len(rs), 'worst4': worst4,
                'avg_n': statistics.fmean(x['n'] for x in xs), 'ci95': t_ci(rs),
                'diff_hold_mean': statistics.fmean(diffs), 'diff_hold_ci95': t_ci(diffs)}
    verdict = {}
    for rule in ('TSM-28', 'TSM-14', 'XS-MOM', 'XS-REV'):
        v, d, s = results.get(f'{rule}|base|val'), results.get(f'{rule}|base|disc'), results.get(f'{rule}|stress|val')
        h = results.get('HOLD-ALL|base|val')
        ok = bool(v and d and s and h and v['mean'] > 0 and v['ci95'] and v['ci95'][0] > 0
                  and v['mean'] > h['mean'] and d['mean'] > 0 and s['mean'] > 0)
        verdict[rule] = 'promising' if ok else 'not supported'
    json.dump({'verdict': verdict, 'results': results}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
