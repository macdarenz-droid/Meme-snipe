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
    """Daily close, high and trade count per perp, bars ending by the wall."""
    px, hi, nt = {}, {}, {}
    for f in glob.glob(os.path.join(hl, 'c_*.json')):
        coin = os.path.basename(f)[2:-5]
        rows = [r for r in json.load(open(f)) if int(r['T']) + 1 <= WALL_MS]
        if rows:
            px[coin] = {int(r['t']) // DAYMS: float(r['c']) for r in rows}
            hi[coin] = {int(r['t']) // DAYMS: float(r['h']) for r in rows}
            nt[coin] = {int(r['t']) // DAYMS: int(r.get('n', 0)) for r in rows}
    return px, hi, nt

LIQ = 2 / (1 + 1 / (2 * 3))          # 1.714x: 1x short liquidation on a 3x-max perp
RECORDS_START_D = 1677369600 * 1000 // DAYMS   # 2023-02-26
MIGRATIONS = {'RENDER', 'POL', 'S'}

def first_traded(nt, coin):
    ds = sorted(d for d, n in nt[coin].items() if n > 0)
    return ds[0] if ds else None

def s1_trades(data, H):
    """Short at the close of the bar after the listing day (first traded bar); liquidation at 1.714x (daily high),
    close-based stop at 2x, else exit at the last close on or before entry + H days."""
    px, hi, nt = data
    wall_day = WALL_MS // DAYMS - 1
    out = []
    for coin, p in px.items():
        if coin in MAJORS:
            continue
        lst = first_traded(nt, coin)
        if lst is None or lst <= RECORDS_START_D + 60:
            continue
        d_entry = lst + 1
        if d_entry not in p or nt[coin].get(d_entry, 0) <= 0:
            continue
        if d_entry + H > wall_day:
            continue
        entry = p[d_entry]
        exit_d, exit_p, why = None, None, 'time'
        later = [d for d in sorted(p) if d_entry < d <= d_entry + H]
        if not later:
            out.append({'coin': coin, 'd0': d_entry, 'd1': d_entry, 'entry': entry, 'exit': entry, 'why': 'no-bar'})
            continue
        for d in later:
            exit_d, exit_p = d, p[d]
            if hi[coin].get(d, 0) >= LIQ * entry:
                why = 'liquidated'; break
            if p[d] >= 2 * entry:
                why = 'stop'; break
        out.append({'coin': coin, 'd0': d_entry, 'd1': exit_d, 'entry': entry, 'exit': exit_p, 'why': why})
    return out

def funding_rows(hl, outf):
    """Funding windows: every non-major from its first traded day to the wall (covers S1 and the weekly rules)."""
    px, hi, nt = load(hl)
    rows = []
    for coin in px:
        if coin in MAJORS:
            continue
        lst = first_traded(nt, coin)
        if lst is None:
            continue
        rows.append([coin, lst * DAYMS, WALL_MS])
    json.dump(sorted(rows), open(outf, 'w'))
    print(len(rows), 'coins')

_FUND = {}
def funding_sum(hl, coin, s_ms, e_ms, px=None, p0=None):
    """Sum of hourly rates in [s_ms, e_ms), each weighted by that day's close / p0. None if coverage is short."""
    if coin not in _FUND:
        f = os.path.join(hl, f'f_{coin}.json')
        _FUND[coin] = sorted((int(x['time']), float(x['fundingRate'])) for x in json.load(open(f))) if os.path.exists(f) else None
    rows = _FUND[coin]
    if rows is None:
        return None
    sel = [(t, r) for t, r in rows if s_ms <= t < e_ms]
    need = (e_ms - s_ms) / 3600000 - 1
    if len(sel) < need:
        return None
    tot = 0.0
    for t, r in sel:
        w = (px.get(t // DAYMS, p0) / p0) if (px and p0) else 1.0
        tot += r * w
    return tot

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
    data = load(hl)
    px, hi, nt = data
    sol = px['SOL']
    res, verdict = {}, {}
    # ---------- S1 ----------
    for H in (30, 60):
        tr = s1_trades(data, H)
        for ck, cost in COST.items():
            rows, missing = [], 0
            for t in tr:
                if t['why'] == 'liquidated':
                    r = -1.0 - cost
                else:
                    fs = funding_sum(hl, t['coin'], (t['d0'] + 1) * DAYMS, (t['d1'] + 1) * DAYMS, px[t['coin']], t['entry'])
                    if fs is None:
                        missing += 1; fs = 0.0
                    r = max(1 - t['exit'] / t['entry'], -1.0) + fs - cost
                r0, r1 = sol.get(t['d0']), sol.get(t['d1'])
                rows.append((t['d0'], r, (1 + r) / (r1 / r0) - 1 if r0 and r1 else r, t['coin']))
            for per, f in (('disc', lambda d: d < VAL_D), ('val', lambda d: d >= VAL_D), ('all', lambda d: True)):
                sub = [x for x in rows if f(x[0])]
                coh = {}
                for d, r, _, _ in sub:
                    coh.setdefault(month(d), []).append(r)
                cm = [statistics.fmean(v) for v in coh.values()]
                res[f'S1-{H}|{ck}|{per}'] = {**summarize([(d, r, sr) for d, r, sr, _ in sub]),
                                             'funding_missing': missing, 'liquidated': sum(1 for t in tr if t['why'] == 'liquidated' and f(t['d0'])),
                                             'stopped': sum(1 for t in tr if t['why'] == 'stop' and f(t['d0'])),
                                             'cohort_months': len(cm), 'cohort_mean': statistics.fmean(cm) if cm else None, 'cohort_ci95': t_ci(cm),
                                             'mean_wo_migrations': statistics.fmean([r for d, r, _, c in sub if c not in MIGRATIONS]) if sub else None}
    # ---------- weekly rules ----------
    firstt = {c: first_traded(nt, c) for c in px}
    lastd = {c: max(p) for c, p in px.items()}
    def r_back(c, D, L):
        a, b = px[c].get(D - 1 - L), px[c].get(D - 1)
        return None if a is None or b is None or a <= 0 else b / a - 1
    def week_ret(c, D, side):
        """(price return for the side, stopped_or_liquidated, end_day)."""
        p0 = px[c].get(D - 1)
        last, end = None, D - 1
        for d in range(D, D + 7):
            if d not in px[c]:
                continue
            if side < 0 and hi[c].get(d, 0) >= LIQ * p0:
                return -1.0, True, d
            last, end = px[c][d], d
            if side < 0 and last >= 1.5 * p0:
                return max(-(last / p0 - 1), -1.0), True, d
        if last is None:
            return 0.0, False, end
        r = last / p0 - 1
        return (max(-r, -1.0) if side < 0 else max(r, -1.0)), False, end
    weeks = []
    D = START_D
    while (D + 7) * DAYMS + DAYMS <= WALL_MS:
        weeks.append(D); D += 7
    def eligible(D):
        return [c for c in px if c not in MAJORS and firstt[c] is not None and firstt[c] <= D - 35 and lastd[c] >= D - 1
                and (D - 1) in px[c] and (D - 29) in px[c] and nt[c].get(D - 1, 0) > 0]
    series = {}
    for rule in ('S2', 'S3', 'S0'):
        for ck, cost in COST.items():
            for fund in ('none', 'baseline', 'actual'):
                prev = {}
                rows, flagged = [], 0
                for D in weeks:
                    el = eligible(D)
                    sc = {c: r_back(c, D, 28) for c in el}
                    if rule == 'S0':
                        side = {c: -1 for c in el}
                    elif rule == 'S2':
                        side = {c: -1 for c in el if sc[c] is not None and sc[c] < 0}
                    else:
                        side = {c: (1 if sc[c] > 0 else -1) for c in el if sc[c] is not None and sc[c] != 0}
                    longs = [c for c in side if side[c] > 0]; shorts = [c for c in side if side[c] < 0]
                    w = {}
                    if rule == 'S3':
                        for c in longs: w[c] = 0.5 / len(longs)
                        for c in shorts: w[c] = -0.5 / len(shorts)
                    else:
                        for c in shorts: w[c] = -1.0 / len(shorts)
                    r = 0.0
                    turnover = sum(abs(w.get(c, 0) - prev.get(c, 0)) for c in set(w) | set(prev))
                    nxt = dict(w)
                    for c, wt in w.items():
                        sd = 1 if wt > 0 else -1
                        x, stopped, end = week_ret(c, D, sd)
                        if fund == 'baseline':
                            x += BASE_FUND_DAY * 7 * (1 if sd < 0 else -1)
                        elif fund == 'actual':
                            fs = funding_sum(hl, c, D * DAYMS, (end + 1) * DAYMS, px[c], px[c][D - 1])
                            if fs is None:
                                flagged += 1; fs = 0.0
                            x += fs * (1 if sd < 0 else -1)
                        r += abs(wt) * x
                        if stopped:
                            turnover += abs(wt)          # exit leg now; next week's re-entry is charged in full
                            nxt[c] = 0.0
                    r -= turnover * cost / 2
                    prev = nxt
                    rs0, rs1 = sol.get(D - 1), sol.get(D + 6)
                    rows.append((D, r, (1 + r) / (rs1 / rs0) - 1 if rs0 and rs1 else r))
                series[(rule, ck, fund)] = rows
                for per, f in (('disc', lambda d: d < VAL_D), ('val', lambda d: d >= VAL_D), ('all', lambda d: True)):
                    res[f'{rule}|{ck}|{fund}|{per}'] = {**summarize([x for x in rows if f(x[0])]), 'funding_flagged_weeks': flagged}
    for rule in ('S2', 'S3'):
        for fund in ('none', 'actual'):
            a = {D: r for D, r, _ in series[(rule, 'base', fund)]}; b = {D: r for D, r, _ in series[('S0', 'base', fund)]}
            for per, f in (('disc', lambda d: d < VAL_D), ('val', lambda d: d >= VAL_D)):
                diffs = [a[D] - b[D] for D in a if f(D)]
                res[f'{rule}-S0|base|{fund}|{per}'] = {'n': len(diffs), 'mean': statistics.fmean(diffs) if diffs else None, 'ci95': t_ci(diffs)}
    # ---------- verdicts ----------
    for rule in ('S1-30', 'S1-60'):
        v, d, s_ = res[f'{rule}|base|val'], res[f'{rule}|base|disc'], res[f'{rule}|stress|val']
        if v.get('funding_missing'):
            verdict[rule] = 'withheld (funding missing)'
            continue
        ok = (v.get('n') and v['mean'] > 0 and v['ci95'] and v['ci95'][0] > 0 and v['months_pos'] >= 0.6
              and v['cohort_ci95'] and v['cohort_ci95'][0] > 0 and d.get('n') and d['mean'] > 0 and s_.get('n') and s_['mean'] > 0)
        verdict[rule] = 'profitable' if ok else 'not supported'
    for rule in ('S2', 'S3'):
        v, d, s_ = res[f'{rule}|base|actual|val'], res[f'{rule}|base|actual|disc'], res[f'{rule}|stress|actual|val']
        ok = (v.get('n') and v['mean'] > 0 and v['ci95'] and v['ci95'][0] > 0 and v['months_pos'] >= 0.6
              and d.get('n') and d['mean'] > 0 and s_.get('n') and s_['mean'] > 0)
        verdict[rule] = 'profitable' if ok else 'not supported'
    json.dump({'verdict': verdict, 'results': res}, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    print(json.dumps(verdict))

if __name__ == '__main__':
    {'funding_rows': funding_rows, 'run': run}[sys.argv[1]](*sys.argv[2:])
