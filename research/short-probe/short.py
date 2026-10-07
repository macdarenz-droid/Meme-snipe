"""Short-side probe analysis (rules in PREREG.md, fixed before any price was downloaded).

  python3 -I short.py funding_rows <hldir> <out.json>   # [coin, start_ms, end_ms] for S1 funding
  python3 -I short.py run <hldir> <outdir>
"""
import glob, json, math, os, statistics, sys, datetime

WALL_MS = 1789999200 * 1000
DAYMS = 86400000
START_D = 1704067200 * 1000 // DAYMS        # Monday 2024-01-01 (day index)
VAL_D = 1751328000 * 1000 // DAYMS          # 2025-07-01
CUT_D = 1672531200 * 1000 // DAYMS          # 2023-01-01: fetch start; first bar here = listing unknown
MAJORS = {'BTC', 'ETH', 'SOL', 'BNB', 'XRP'}
COST = {'base': 0.003, 'stress': 0.006}
BASE_FUND_DAY = 0.0003                      # 0.01% per 8 h

def load(hl):
    px = {}
    for f in glob.glob(os.path.join(hl, 'c_*.json')):
        coin = os.path.basename(f)[2:-5]
        rows = [r for r in json.load(open(f)) if int(r['T']) + 1 <= WALL_MS]
        if rows:
            px[coin] = {int(r['t']) // DAYMS: float(r['c']) for r in rows}
    return px

def s1_trades(px, H):
    """Short at the close of a perp's second daily bar; exit at the first close >= 2x entry (stop), else at the
    last close on or before entry + H days. A perp delisted before then closes at its last close; a hold that
    would run past the wall while the perp still trades is left out (time-only)."""
    wall_day = WALL_MS // DAYMS - 1
    out = []
    for coin, p in px.items():
        if coin in MAJORS:
            continue
        days = sorted(p)
        if days[0] <= CUT_D or len(days) < 2:
            continue
        d_entry = days[1]
        entry = p[d_entry]
        target = d_entry + H
        if target > wall_day and days[-1] >= wall_day - 1:
            continue
        exit_d, exit_p, stopped = None, None, False
        for d in days:
            if d <= d_entry or d > target:
                continue
            exit_d, exit_p = d, p[d]
            if p[d] >= 2 * entry:
                stopped = True
                break
        if exit_d is None:
            continue
        out.append({'coin': coin, 'd0': d_entry, 'd1': exit_d, 'entry': entry, 'exit': exit_p, 'stopped': stopped})
    return out

def funding_rows(hl, outf):
    px = load(hl)
    rows = {}
    for H in (30, 60):
        for t in s1_trades(px, H):
            s, e = (t['d0'] + 1) * DAYMS, (t['d1'] + 1) * DAYMS
            a = rows.get(t['coin'])
            rows[t['coin']] = [t['coin'], min(s, a[1]) if a else s, max(e, a[2]) if a else e]
    json.dump(sorted(rows.values()), open(outf, 'w'))
    print(len(rows), 'coins')

def funding_sum(hl, coin, s_ms, e_ms):
    f = os.path.join(hl, f'f_{coin}.json')
    if not os.path.exists(f):
        return None
    return sum(float(x['fundingRate']) for x in json.load(open(f)) if s_ms <= int(x['time']) < e_ms)

def t_ci(xs):
    n = len(xs)
    if n < 3:
        return None
    m, se = statistics.fmean(xs), statistics.stdev(xs) / math.sqrt(n)
    df = n - 1
    cst = math.gamma((df + 1) / 2) / (math.sqrt(df * math.pi) * math.gamma(df / 2))
    f = lambda t: cst * (1 + t * t / df) ** (-(df + 1) / 2)
    def cdf(x):
        k, hh = 2000, x / 2000
        return 0.5 + (f(0) + f(x) + sum((4 if i % 2 else 2) * f(i * hh) for i in range(1, k))) * hh / 3
    lo, hi = 0.0, 50.0
    for _ in range(70):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if cdf(mid) < 0.975 else (lo, mid)
    tq = (lo + hi) / 2
    return [m - tq * se, m + tq * se]

def month(d):
    return datetime.datetime.fromtimestamp(d * 86400, datetime.UTC).strftime('%Y-%m')

def summarize(rows):
    """rows: list of (day, r_usd, r_sol)."""
    if not rows:
        return {'n': 0}
    xs = [r for _, r, _ in rows]; ss = [s for _, _, s in rows]
    bym = {}
    for d, r, _ in rows:
        bym.setdefault(month(d), []).append(r)
    return {'n': len(xs), 'mean': statistics.fmean(xs), 'median': statistics.median(xs), 'win': sum(1 for x in xs if x > 0) / len(xs),
            'worst': min(xs), 'best': max(xs), 'ci95': t_ci(xs), 'months_pos': sum(1 for v in bym.values() if sum(v) > 0) / len(bym),
            'n_months': len(bym), 'mean_sol': statistics.fmean(ss)}

def run(hl, outdir):
    os.makedirs(outdir, exist_ok=True)
    px = load(hl)
    sol = px['SOL']
    res, verdict = {}, {}
    # S1
    for H in (30, 60):
        tr = s1_trades(px, H)
        for ck, cost in COST.items():
            rows, nofund = [], 0
            for t in tr:
                fs = funding_sum(hl, t['coin'], (t['d0'] + 1) * DAYMS, (t['d1'] + 1) * DAYMS)
                if fs is None:
                    fs, nofund = 0.0, nofund + 1
                r = max(1 - t['exit'] / t['entry'], -1.0) + fs - cost
                rs = sol.get(t['d1'], None); r0 = sol.get(t['d0'], None)
                rsol = (1 + r) / (rs / r0) - 1 if rs and r0 else r
                rows.append((t['d0'], r, rsol))
            for per, f in (('disc', lambda d: d < VAL_D), ('val', lambda d: d >= VAL_D), ('all', lambda d: True)):
                res[f'S1-{H}|{ck}|{per}'] = {**summarize([x for x in rows if f(x[0])]), 'no_funding_file': nofund,
                                             'stopped': sum(1 for t in tr if t['stopped'] and f(t['d0']))}
    # weekly rules
    def r_back(c, D, L):
        a, b = px[c].get(D - 1 - L), px[c].get(D - 1)
        return None if a is None or b is None or a <= 0 else b / a - 1
    def week_ret(c, D, side):
        p0 = px[c].get(D - 1)
        if not p0:
            return None
        last = None
        for d in range(D, D + 7):
            if d not in px[c]:
                continue
            last = px[c][d]
            if side < 0 and last >= 1.5 * p0:
                break
        if last is None:
            return 0.0
        r = last / p0 - 1
        return max(-r, -1.0) if side < 0 else max(r, -1.0)
    first = {c: min(p) for c, p in px.items()}
    lastd = {c: max(p) for c, p in px.items()}
    weeks = []
    D = START_D
    while (D + 7) * DAYMS + DAYMS <= WALL_MS:
        weeks.append(D); D += 7
    def eligible(D):
        return [c for c in px if c not in MAJORS and first[c] <= D - 35 and lastd[c] >= D - 1 and (D - 1) in px[c] and (D - 29) in px[c]]
    for rule in ('S2', 'S3', 'S0'):
        for ck, cost in COST.items():
            for fund in ('none', 'baseline'):
                prev = {}
                rows = []
                for D in weeks:
                    el = eligible(D)
                    sc = {c: r_back(c, D, 28) for c in el}
                    if rule == 'S0':
                        pos = {c: -1 for c in el}
                    elif rule == 'S2':
                        pos = {c: -1 for c in el if sc[c] is not None and sc[c] < 0}
                    else:
                        pos = {c: (1 if sc[c] > 0 else -1) for c in el if sc[c] is not None and sc[c] != 0}
                    longs = [c for c in pos if pos[c] > 0]; shorts = [c for c in pos if pos[c] < 0]
                    w = {}
                    if rule == 'S3':
                        for c in longs: w[c] = 0.5 / len(longs)
                        for c in shorts: w[c] = 0.5 / len(shorts)
                    else:
                        for c in shorts: w[c] = 1 / len(shorts) if shorts else 0
                    r = 0.0
                    for c, wt in w.items():
                        x = week_ret(c, D, pos[c])
                        if x is None:
                            continue
                        if fund == 'baseline':
                            x += BASE_FUND_DAY * 7 * (1 if pos[c] < 0 else -1)
                        r += wt * x
                    changed = sum(abs(w.get(c, 0) - prev.get(c, 0)) for c in set(w) | set(prev))
                    r -= changed * cost / 2
                    prev = w
                    rs0, rs1 = sol.get(D - 1), sol.get(D + 6)
                    rows.append((D, r, (1 + r) / (rs1 / rs0) - 1 if rs0 and rs1 else r))
                for per, f in (('disc', lambda d: d < VAL_D), ('val', lambda d: d >= VAL_D), ('all', lambda d: True)):
                    res[f'{rule}|{ck}|{fund}|{per}'] = summarize([x for x in rows if f(x[0])])
    for rule in ('S1-30', 'S1-60'):
        v, d, s = res[f'{rule}|base|val'], res[f'{rule}|base|disc'], res[f'{rule}|stress|val']
        verdict[rule] = 'profitable' if (v['n'] and v['mean'] > 0 and v['ci95'] and v['ci95'][0] > 0 and v['months_pos'] >= 0.6
                                         and d['n'] and d['mean'] > 0 and s['mean'] > 0) else 'not supported'
    for rule in ('S2', 'S3'):
        v, d, s = res[f'{rule}|base|none|val'], res[f'{rule}|base|none|disc'], res[f'{rule}|stress|none|val']
        verdict[rule] = 'profitable' if (v['n'] and v['mean'] > 0 and v['ci95'] and v['ci95'][0] > 0 and v['months_pos'] >= 0.6
                                         and d['n'] and d['mean'] > 0 and s['mean'] > 0) else 'not supported'
    json.dump({'verdict': verdict, 'results': res}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'funding_rows': funding_rows, 'run': run}[sys.argv[1]](*sys.argv[2:])
