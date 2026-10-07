"""MR-01 1-minute kill-only screen (rules in PREREG.md, fixed and pushed before any return was computed).

  python3 -I screen.py run <eligible.json> <dailydir> <minutedir> <out.json>
"""
import hashlib, json, math, os, random, statistics, sys

import numpy as np

WALL = 1789999200                      # 2026-09-21T14:00:00Z
DAY = 86400
M = 60
DEC_START = 1784678400                 # 2026-07-22T00:00:00Z
VAL_START = 1787270400                 # 2026-08-21T00:00:00Z
SOL_USD = 119.26
SIZES = {'$200': 200 / SOL_USD, '$1000': 1000 / SOL_USD}
FIXED = 414009 / 1e9                   # lottery-probe/lottery.py FIXED
K_MIG = 85 * 206_900_000
MCAP_MIN = 98240                       # 0.30% tier
FEE = 0.0030
DEPTH_MIN = 300
WIN = 360                              # 6 h of 1-minute bars
MAD_K = 0.67449
STRESS = 0.01
N_RAND = 20
BOOT = 5000
CONFIGS = {
    'MR-01-5':  {'L': 5,  'z': 3.0, 'a': 0.04, 'T': 30},
    'MR-01-15': {'L': 15, 'z': 3.0, 'a': 0.05, 'T': 60},
}
TP = 0.06

def depth(mcap):
    return math.sqrt(K_MIG * mcap / 1e9)

# ---------- eligibility (previous UTC day's close, pool age, depth) ----------
def eligible_days(dpath):
    """{day_start: mcap} for days d in [DEC_START, WALL) on which the pool qualifies."""
    if not os.path.exists(dpath):
        return {}
    d = json.load(open(dpath))
    lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
    if not lst:
        return {}
    first = min(int(r[0]) for r in lst)
    closes = {int(r[0]): float(r[4]) for r in lst if int(r[0]) + DAY <= WALL}
    out = {}
    t = DEC_START
    while t < WALL:
        c = closes.get(t - DAY)
        if c:
            m = c * 1e9
            if m >= MCAP_MIN and depth(m) >= DEPTH_MIN and first <= t - 2 * DAY:
                out[t] = m
        t += DAY
    return out

# ---------- 1-minute bars, missing minutes filled with the previous close ----------
def load(mpath, end):
    raw = [r for r in json.load(open(mpath)) if int(r[0]) + M <= min(WALL, end)]
    if not raw:
        return None
    raw.sort(key=lambda r: r[0])
    by = {int(r[0]): r for r in raw}
    t0 = int(raw[0][0])
    t_end = min(WALL, end) - M
    ts, o, h, l, c, v = [], [], [], [], [], []
    prev = float(raw[0][1])
    t = t0
    while t <= t_end:
        r = by.get(t)
        if r:
            oo, hh, ll, cc, vv = map(float, r[1:6])
        else:
            oo = hh = ll = cc = prev
            vv = 0.0
        ts.append(t); o.append(oo); h.append(hh); l.append(ll); c.append(cc); v.append(vv)
        prev = cc
        t += M
    return {k: np.array(x) for k, x in zip('tohlcv', (ts, o, h, l, c, v))}

def scale_1m(c):
    """sigma[i] = MAD/0.67449 of r1[i-360 .. i-1] (past returns only); nan where unavailable."""
    n = len(c)
    r1 = np.full(n, np.nan)
    r1[1:] = np.log(c[1:] / c[:-1])
    sig = np.full(n, np.nan)
    if n <= WIN + 1:
        return sig
    w = np.lib.stride_tricks.sliding_window_view(r1[1:], WIN)   # w[k] = r1[k+1 .. k+WIN]
    med = np.median(w, axis=1)
    mad = np.median(np.abs(w - med[:, None]), axis=1)
    # window w[k] ends at r1[k+WIN]; it is the past window of minute i = k+WIN+1
    sig[WIN + 1:] = (mad / MAD_K)[:n - WIN - 1]
    return sig

def signals(b, cfg, elig):
    L = cfg['L']
    c, v, ts = b['c'], b['v'], b['t']
    sig = scale_1m(c)
    out = []
    for i in range(WIN + L, len(c)):
        if v[i] <= 0 or not (sig[i] > 0):
            continue
        d = int(ts[i]) - int(ts[i]) % DAY
        if d not in elig:
            continue
        z = math.log(c[i] / c[i - L]) / (sig[i] * math.sqrt(L))
        if z <= -cfg['z']:
            out.append(i)
    return out

def simulate(b, i, cfg, delay=0, pess=False):
    """Enter at close of minute i+delay; returns (exit_index, gross) or None if the data ends first."""
    o, h, l, c = b['o'], b['h'], b['l'], b['c']
    k = i + delay
    if k >= len(c):
        return None
    p0 = c[k]
    stop = p0 * (1 - cfg['a'])
    for j in range(k + 1, k + cfg['T'] + 1):
        if j >= len(c):                # data (the wall or the fetch end) reached before any exit
            return None
        tgt = min(float(np.median(c[j - WIN:j])), p0 * (1 + TP))
        if o[j] >= tgt:
            return j, o[j] / p0 - 1
        if l[j] <= stop:
            if pess:
                fill = min(stop, c[j])
            else:
                fill = o[j] if o[j] <= stop else stop
            return j, fill / p0 - 1
        if h[j] >= tgt:
            return j, tgt / p0 - 1
    j = k + cfg['T']
    return j, c[j] / p0 - 1

def run_line(b, sigs, cfg, elig, delay=0, pess=False):
    trades, busy = [], -1
    ts = b['t']
    for i in sigs:
        if i <= busy:
            continue
        sim = simulate(b, i, cfg, delay, pess)
        if not sim:
            continue
        busy = sim[0]
        ti = int(ts[i])
        t = int(ts[i + delay])         # period and clustering day from the entry minute
        trades.append({'i': i, 't': t, 'day': t - t % DAY, 'g': float(sim[1]), 'mcap': elig[ti - ti % DAY]})
    return trades

def period(t):
    return 'disc' if t < VAL_START else 'val'

def random_bench(b, trades, cfg, elig, pool):
    """N_RAND random traded minutes per trade: same pool, same UTC hour of day, eligible day, same period."""
    ts, v = b['t'], b['v']
    L = cfg['L']
    cand = {}
    for i in range(WIN + L, len(ts)):
        if v[i] <= 0:
            continue
        t = int(ts[i]); d = t - t % DAY
        if d in elig:
            cand.setdefault((period(t), (t % DAY) // 3600), []).append(i)
    out = []
    for tr in trades:
        pool_c = cand.get((period(tr['t']), (tr['t'] % DAY) // 3600), [])
        if not pool_c:
            continue
        for s in range(N_RAND):
            hsh = int(hashlib.sha256(f"{s}|{pool}|{tr['t']}".encode()).hexdigest(), 16)
            i = pool_c[hsh % len(pool_c)]
            sim = simulate(b, i, cfg)
            if not sim:
                continue
            t = int(ts[i]); d = t - t % DAY
            out.append({'t': t, 'day': d, 'g': float(sim[1]), 'mcap': elig[d]})
    return out

def net(g, mcap, q, extra=0.0):
    return g - 2 * FEE - 2 * q / depth(mcap) - FIXED / q - extra

def boot_ci(xs_by_day, reps=BOOT, seed=7):
    ds = sorted(xs_by_day)
    if len(ds) < 2:
        return None
    rng = random.Random(seed)
    means = []
    for _ in range(reps):
        s, n = 0.0, 0
        for _ in ds:
            xs = xs_by_day[ds[rng.randrange(len(ds))]]
            s += sum(xs); n += len(xs)
        means.append(s / n)
    means.sort()
    return [means[int(0.025 * reps)], means[min(reps - 1, int(0.975 * reps))]]

def summarize(trs, q, extra=0.0, bench=None):
    if not trs:
        return {'n': 0}
    xs = [net(t['g'], t['mcap'], q, extra) for t in trs]
    byday = {}
    for t, x in zip(trs, xs):
        byday.setdefault(t['day'], []).append(x)
    out = {'n': len(xs), 'days': len(byday), 'pools': len({t['pool'] for t in trs}),
           'mean_gross': statistics.fmean(t['g'] for t in trs),
           'mean_net': statistics.fmean(xs), 'median_net': statistics.median(xs),
           'win': sum(1 for x in xs if x > 0) / len(xs), 'ci95': boot_ci(byday)}
    if bench is not None:
        out['rand_n'] = len(bench)
        out['rand_mean_net'] = statistics.fmean(net(t['g'], t['mcap'], q, extra) for t in bench) if bench else None
        out['excess_over_rand'] = out['mean_net'] - out['rand_mean_net'] if bench else None
    return out

def run(elig_path, ddir, mdir, out_path):
    pools = [u for u in json.load(open(elig_path)) if u['best'] == 'A']
    lines = ('main', 'delayed', 'pess')
    T = {(ln, k): [] for ln in lines for k in CONFIGS}
    R = {k: [] for k in CONFIGS}
    manifest, cover = [], []
    for u in pools:
        elig = eligible_days(os.path.join(ddir, u['pool'] + '.json'))
        mp = os.path.join(mdir, u['pool'] + '.json')
        if not elig or not os.path.exists(mp):
            cover.append({'pool': u['pool'], 'sym': u['symbol'], 'elig_days': len(elig), 'minutes': 0})
            continue
        manifest.append({'pool': u['pool'], 'sha256': hashlib.sha256(open(mp, 'rb').read()).hexdigest()})
        end = min(WALL, max(elig) + DAY + 2 * 3600)
        b = load(mp, end)
        if b is None:
            cover.append({'pool': u['pool'], 'sym': u['symbol'], 'elig_days': len(elig), 'minutes': 0})
            continue
        inel = [i for i in range(len(b['t'])) if (int(b['t'][i]) - int(b['t'][i]) % DAY) in elig]
        cover.append({'pool': u['pool'], 'sym': u['symbol'], 'elig_days': len(elig), 'minutes': len(b['t']),
                      'first_minute': int(b['t'][0]), 'wanted_from': min(elig) - 7 * 3600,
                      'traded_share_eligible': float(np.mean(b['v'][inel] > 0)) if inel else None,
                      'open_eq_prev_close': float(np.mean(np.isclose(b['o'][1:], b['c'][:-1], rtol=1e-9)))})
        for k, cfg in CONFIGS.items():
            sigs = signals(b, cfg, elig)
            for ln in lines:
                tr = run_line(b, sigs, cfg, elig, delay=1 if ln == 'delayed' else 0, pess=ln == 'pess')
                for t in tr:
                    t['pool'] = u['pool']
                T[(ln, k)] += tr
            rb = random_bench(b, [t for t in T[('main', k)] if t['pool'] == u['pool']], cfg, elig, u['pool'])
            for t in rb:
                t['pool'] = u['pool']
            R[k] += rb
        print(u['symbol'], 'done', flush=True)
    res = {}
    for k in CONFIGS:
        for sz, q in SIZES.items():
            for per in ('disc', 'val'):
                f = lambda xs: [t for t in xs if period(t['t']) == per]
                bench = f(R[k])
                res[f'{k}|{sz}|{per}|main'] = summarize(f(T[('main', k)]), q, bench=bench)
                res[f'{k}|{sz}|{per}|stress+1pt'] = summarize(f(T[('main', k)]), q, STRESS)
                res[f'{k}|{sz}|{per}|delayed'] = summarize(f(T[('delayed', k)]), q)
                res[f'{k}|{sz}|{per}|delayed+stress'] = summarize(f(T[('delayed', k)]), q, STRESS)
                res[f'{k}|{sz}|{per}|pess_stop'] = summarize(f(T[('pess', k)]), q)
    killed = all(res[f'{k}|$200|val|main'].get('ci95') and res[f'{k}|$200|val|main']['ci95'][1] < 0 for k in CONFIGS)
    verdict = 'KILLED' if killed else 'NOT KILLED: needs the 15 s recorded test'
    json.dump({'verdict': verdict, 'results': res, 'coverage': cover, 'manifest': manifest}, open(out_path, 'w'), indent=1)
    print(verdict)

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
