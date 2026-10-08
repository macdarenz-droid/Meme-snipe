"""Maker probe, design C (rules in PREREG.md, fixed before any bar was downloaded).

  python3 -I maker.py <elig12.json> <dailydir> <barsdir> <out.json>

Reuses research/deep-pool-probe/probe.py for bars, MR-A's sigma window, S0, costs and intervals.
"""
import hashlib, json, math, os, random, statistics, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'deep-pool-probe'))
import probe as P  # noqa: E402

Q = P.SIZES['$50']                     # SOL per trade
PRIORITY_SOL = 0.001
FILL_SLACK = 0.995                     # low must be at or under bid x 0.995
TP, SL, H = 0.06, 0.04, 6              # +6% / -4% / 30 min, from the bid
BOOT = 20000
LEVELS = {'95': 0.025, '99.58': 0.05 / 12 / 2}
MRA = P.CONFIGS['MR-A']

def ab_pool(p):
    """The pool with only its group A or B days (deep-pool primary group)."""
    return {**p, 'days': {k: v for k, v in p['days'].items() if v['g'] in 'AB'}}

def sigmas(bars):
    """(i, sd) for each bar i whose previous 864 5-minute log returns give a usable sigma:
    at least 500 returns, at least 500 bars with volume, sd > 0. Same rolling window as probe.signals
    (traded_min=True): returns of bars i-864 .. i-1, never bar i itself."""
    ts, o, h, l, c, v = bars
    L, n = 1, len(c)
    rets = [float('nan')] * n
    for i in range(L, n):
        rets[i] = P.lret(c, i, L)
    s = ss = 0.0
    cnt = 0
    traded = sum(1 for j in range(L, L + P.LOOKBACK) if v[j] > 0)
    for j in range(L, L + P.LOOKBACK):
        if not math.isnan(rets[j]):
            s += rets[j]; ss += rets[j] * rets[j]; cnt += 1
    for i in range(L + P.LOOKBACK, n):
        if i > L + P.LOOKBACK:
            add, drop = rets[i - 1], rets[i - 1 - P.LOOKBACK]
            if not math.isnan(add):
                s += add; ss += add * add; cnt += 1
            if not math.isnan(drop):
                s -= drop; ss -= drop * drop; cnt -= 1
            traded += (1 if v[i - 1] > 0 else 0) - (1 if v[i - 1 - P.LOOKBACK] > 0 else 0)
        if cnt < P.MIN_WINDOW or traded < P.MIN_WINDOW:
            continue
        var = ss / cnt - (s / cnt) ** 2
        if var > 0:
            yield i, math.sqrt(var)

def run_maker(pool, bars):
    days = {int(k): v for k, v in pool['days'].items()}
    ts, o, h, l, c, v = bars
    n = len(c)
    fills, busy, used = [], -1, set()
    for i, sd in sigmas(bars):
        if i <= busy:
            continue
        d = P.day_of(ts[i])
        if ts[i] < P.DEC_START or d not in days or d in used or c[i - 1] <= 0:
            continue
        bid = c[i - 1] * math.exp(-3 * sd)
        if not l[i] <= bid * FILL_SLACK:
            continue
        last = i + H
        if last >= n or ts[last] + P.BAR > P.WALL:
            continue
        tp, sl = bid * (1 + TP), bid * (1 - SL)
        x, px = last, c[last]
        if l[i] <= sl:                     # fill bar: stop only, never the target
            x, px = i, min(sl, c[i])
        else:
            for j in range(i + 1, last + 1):
                if l[j] <= sl:
                    x, px = j, min(sl, c[j]); break
                if h[j] >= tp:
                    x, px = j, tp; break
        busy = x
        used.add(d)
        fills.append({'pool': pool['pool'], 'sym': pool['symbol'], 't': ts[i], 'day': d, 'g': px / bid - 1,
                      'mcap': bid * 1e9, 'grp': days[d]['g'], 'exit_bars': x - i})
    return fills

def net_exit(g, mcap, q=Q):
    """Design C costs: exit tier fee + exit impact q/R + 0.001 SOL priority; no entry cost."""
    return g - P.fee_bps(mcap) / 1e4 - q / math.sqrt(P.K_MIG * mcap / 1e9) - PRIORITY_SOL / q

def boot(trs, reps=BOOT, seed=7):
    byday = {}
    for t in trs:
        byday.setdefault(t['day'], []).append(t['net'])
    ds = sorted(byday)
    if len(ds) < 2:
        return None
    rng = random.Random(seed)
    means = []
    for _ in range(reps):
        s = k = 0
        for _ in ds:
            xs = byday[ds[rng.randrange(len(ds))]]
            s += sum(xs); k += len(xs)
        means.append(s / k)
    means.sort()
    qt = lambda p: means[min(len(means) - 1, max(0, int(p * len(means))))]
    return {lv: [qt(a), qt(1 - a)] for lv, a in LEVELS.items()}

def tci(trs):
    byday = {}
    for t in trs:
        byday.setdefault(t['day'], []).append(t['net'])
    D = len(byday)
    if D < 3:
        return None
    N = sum(len(x) for x in byday.values())
    m = sum(sum(x) for x in byday.values()) / N
    se = math.sqrt(sum((sum(x) - len(x) * m) ** 2 for x in byday.values()) / N ** 2 * D / (D - 1))
    return {lv: [m - P.t_quantile(1 - a, D - 1) * se, m + P.t_quantile(1 - a, D - 1) * se] for lv, a in LEVELS.items()}

def summ(trs, full=False):
    if not trs:
        return {'n': 0}
    xs = [t['net'] for t in trs]
    out = {'n': len(xs), 'days': len({t['day'] for t in trs}), 'pools': len({t['pool'] for t in trs}),
           'mean_net': statistics.fmean(xs), 'mean_net_sol': statistics.fmean(xs) * Q,
           'median_net': statistics.median(xs), 'win': sum(x > 0 for x in xs) / len(xs),
           'mean_gross': statistics.fmean(t['g'] for t in trs)}
    if full:
        out['boot'] = boot(trs)
        out['t'] = tci(trs)
    return out

def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()

def main(elig, ddir, bdir, outp):
    pools = [ab_pool(p) for p in json.load(open(elig))]
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'deep-pool-probe')
    um = {u['mint']: u['pool'] for u in json.load(open(os.path.join(here, 'universe.json')))}
    frozen = {um[c['mint']] for c in json.load(open(os.path.join(here, 'dlmm_gate0.json')))['coins'] if c['passes_50_sol']}
    assert len(frozen) == 12 and {p['pool'] for p in pools} == frozen, 'eligibility file is not the 12 frozen pools'
    maker, s0, mra, manifest = [], [], [], []
    for p in pools:
        path = os.path.join(bdir, p['pool'] + '.json')
        dpath = os.path.join(ddir, p['pool'] + '.json')
        manifest.append({'pool': p['pool'], 'sym': p['symbol'], 'ab_days': len(p['days']),
                         'bars_sha256': sha(path) if os.path.exists(path) else None,
                         'daily_sha256': sha(dpath) if os.path.exists(dpath) else None})
        if not p['days'] or not os.path.exists(path):
            continue
        bars = P.load_bars(path)
        if not bars or len(bars[0]) < P.LOOKBACK + 20:
            continue
        maker += run_maker(p, bars)
        for sd in range(P.SEEDS):
            s0 += P.run_s0(p, bars, MRA, sd, real=True)
        mra += P.run_pool(p, bars, MRA, real=True)
    for t in maker + s0:
        t['net'] = net_exit(t['g'], t['mcap'])
    s0_full = [{**t, 'net': P.net(t['g'], t['mcap'], Q)} for t in s0]
    for t in mra:
        t['net'] = P.net(t['g'], t['mcap'], Q)
    per = {'disc': (P.DEC_START, P.VAL_START), 'val': (P.VAL_START, P.WALL)}
    sel = lambda trs, k: [t for t in trs if per[k][0] <= t['t'] < per[k][1]]
    res = {k: {'maker': summ(sel(maker, k), full=True), 's0_same_costs': summ(sel(s0, k)),
               's0_full_taker_costs': summ(sel(s0_full, k)), 'mra_taker': summ(sel(mra, k), full=True)}
           for k in per}
    v = res['val']
    m, s = v['maker'], v['s0_same_costs']
    lift = m['mean_net'] - s['mean_net'] if m['n'] and s['n'] else None
    def verdict(lv):
        if m['n'] < 30:
            return 'unresolved'
        ok = m['boot'] and m['boot'][lv][0] > 0 and lift is not None and lift >= 0.0045
        return 'pass' if ok else 'not supported'
    out = {'verdict': {'99.58 (judged)': verdict('99.58'), '95 (shown)': verdict('95')},
           'lift_over_s0_points': lift * 100 if lift is not None else None,
           'q_sol': Q, 'results': res, 'manifest': manifest, 'elig_sha256': sha(elig),
           'val_fills': [{k: t[k] for k in ('sym', 't', 'g', 'net', 'mcap', 'exit_bars')} for t in sel(maker, 'val')]}
    json.dump(out, open(outp, 'w'), indent=1)
    print(json.dumps({'verdict': out['verdict'], 'lift_points': out['lift_over_s0_points'], 'val_n': m['n']}))

if __name__ == '__main__':
    main(*sys.argv[1:])
