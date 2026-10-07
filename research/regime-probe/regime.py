"""Regime probe (PREREG.md): HOT(t) = share of sampled coins entered in [t-72h, t-24h] whose max close within 24h of
their own entry reached >= 2x entry. Outcome = R1 hourly net at $50."""
import json, os, sys, random, statistics, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'runner-probe')); sys.path.insert(0, os.path.join(HERE, '..', 'lottery-probe'))
import runner, lottery
H = 3600
def load(sample, hdir, tag):
    cs, counts = runner.coins(sample, hdir)
    out = []
    for x in cs:
        if x['ts'][1] + runner.MAX_HOLD * H > runner.WALL - H: continue
        r = runner.trade(x, 0.3, 2.0, 0.4, 'pess')
        if r is None: continue
        p0 = x['c'][1]
        win24 = max((c for c, v in zip(x['c'][2:26], x['v'][2:26]) if v > 0), default=0.0) >= 2 * p0
        net = lottery.net(p0, max(r[1], 1e-18), runner.SIZES['$50'])[0]
        out.append({'s': tag, 't': x['ts'][1] + H, 'net': net, 'cap': min(net, 19.0), 'win24': win24})
    return out, counts
def boot_days(rows, stat, n=4000, seed=7):
    days = {}
    for r in rows: days.setdefault(r['t'] // 86400, []).append(r)
    keys = list(days); rng = random.Random(seed); vals = []
    for _ in range(n):
        smp = [r for k in (rng.choice(keys) for _ in keys) for r in days[k]]
        v = stat(smp)
        if v is not None: vals.append(v)
    vals.sort(); return vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]
def spearman(a, b):
    def rk(v):
        o = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v)
        for k, i in enumerate(o): r[i] = k
        return r
    ra, rb = rk(a), rk(b); n = len(a)
    if n < 3: return None
    ma, mb = statistics.fmean(ra), statistics.fmean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb)); den = (sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb)) ** 0.5
    return num / den if den else None
def main(explore_h, val_h, out):
    a, ca = load(os.path.join(HERE, '..', 'lottery-probe', 'sample.json'), explore_h, 'exploration')
    b, cb = load(os.path.join(HERE, '..', 'runner-probe', 'validation_sample.json'), val_h, 'validation')
    rows = sorted(a + b, key=lambda r: r['t'])
    excluded = 0; sig = []
    for r in rows:
        w = [q for q in rows if r['t'] - 72 * H <= q['t'] <= r['t'] - 24 * H]
        if len(w) < 15: excluded += 1; continue
        sig.append({**r, 'hot': sum(q['win24'] for q in w) / len(w), 'nwin': len(w)})
    med = statistics.median(s['hot'] for s in sig)
    hi = [s for s in sig if s['hot'] > med]; lo = [s for s in sig if s['hot'] <= med]
    mean = lambda L, k='cap': statistics.fmean(x[k] for x in L) if L else None
    def diff(L):
        h = [x for x in L if x['hot'] > med]; l = [x for x in L if x['hot'] <= med]
        return (mean(h) - mean(l)) if h and l else None
    res = {'counts': {'exploration': ca, 'validation': cb}, 'entries': len(rows), 'excluded_no_signal': excluded, 'signalled': len(sig),
           'median_hot': med,
           'primary': {'hot_mean_cap': mean(hi), 'cold_mean_cap': mean(lo), 'diff': diff(sig), 'ci95': boot_days(sig, diff), 'n_hot': len(hi), 'n_cold': len(lo),
                       'hot_mean_net': mean(hi, 'net'), 'cold_mean_net': mean(lo, 'net')},
           'spearman': {'rho': spearman([s['hot'] for s in sig], [s['cap'] for s in sig]),
                        'ci95': boot_days(sig, lambda L: spearman([s['hot'] for s in L], [s['cap'] for s in L]))}}
    q90 = sorted(s['hot'] for s in sig)[int(0.9 * len(sig))]
    top = [s for s in sig if s['hot'] >= q90]
    span_w = (sig[-1]['t'] - sig[0]['t']) / (7 * 86400)
    res['top_decile'] = {'threshold': q90, 'n': len(top), 'trades_per_week_in_sample': len(top) / span_w, 'mean_net': mean(top, 'net'), 'mean_cap': mean(top),
                         'ge2x': sum(1 for s in top if s['net'] >= 1), 'ge5x': sum(1 for s in top if s['net'] >= 4),
                         'ci95_cap': boot_days(top, lambda L: mean(L)), 'days': len({s['t'] // 86400 for s in top})}
    for tag in ('exploration', 'validation'):
        L = [s for s in sig if s['s'] == tag]
        res[tag] = {'n': len(L), 'diff': diff(L), 'hot_mean_cap': mean([s for s in L if s['hot'] > med]), 'cold_mean_cap': mean([s for s in L if s['hot'] <= med])}
    res['all_mean_net'] = mean(sig, 'net'); res['all_mean_cap'] = mean(sig)
    res['reading'] = 'worth a forward test' if (res['primary']['ci95'][0] > 0 and res['top_decile']['mean_cap'] > 0) else 'no usable timing signal in this data'
    os.makedirs(out, exist_ok=True); json.dump(res, open(os.path.join(out, 'results.json'), 'w'), indent=1)
    print(json.dumps({k: res[k] for k in ('entries', 'excluded_no_signal', 'signalled', 'median_hot', 'primary', 'spearman', 'top_decile', 'exploration', 'validation', 'all_mean_net', 'all_mean_cap', 'reading')}, indent=1))
if __name__ == '__main__':
    main(*sys.argv[1:4])
