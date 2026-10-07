"""EDGE-HUNT-U2 statistics: H9 applied from created.jsonl, then per trial n, win rate, mean and median net return,
95% CIs (coin bootstrap and day-block bootstrap), exit reasons; across trials a deflated Sharpe ratio and PBO (CSCV).
Usage: python3 -I analyze.py <datadir> <sim.json> <out.md> [<out.json>]"""
import json, math, os, random, sys
from itertools import combinations
from statistics import NormalDist, mean, median

N = NormalDist()
DAY = 86400


def h9_table(datadir):
    t = {}
    f = os.path.join(datadir, 'created.jsonl')
    if os.path.exists(f):
        for l in open(f):
            x = json.loads(l)
            if x['oldestBefore'] is None:
                t[x['mint']] = None
            elif x['complete']:
                t[x['mint']] = x['migTs'] - x['oldestBefore'] >= 300
            else:
                t[x['mint']] = True if x['oldestBefore'] < x['migTs'] - 300 else None
    return t


def boot_ci(xs, groups=None, reps=10000, seed=1):
    if len(xs) < 2:
        return (None, None)
    rnd = random.Random(seed)
    if groups is None:
        ms = sorted(mean(rnd.choice(xs) for _ in xs) for _ in range(reps))
    else:
        keys = sorted(set(groups))
        by = {k: [x for x, g in zip(xs, groups) if g == k] for k in keys}
        ms = []
        for _ in range(reps):
            s = [x for k in (rnd.choice(keys) for _ in keys) for x in by[k]]
            ms.append(mean(s))
        ms.sort()
    return (ms[int(0.025 * reps)], ms[int(0.975 * reps) - 1])


def summarize(trades):
    r = [t['net_ret'] for t in trades]
    if not r:
        return dict(n=0)
    days = [t['mig_t'] // DAY for t in trades]
    lo, hi = boot_ci(r)
    dlo, dhi = boot_ci(r, days)
    reasons = {}
    for t in trades:
        reasons[t['reason']] = reasons.get(t['reason'], 0) + 1
    sd = (sum((x - mean(r)) ** 2 for x in r) / (len(r) - 1)) ** 0.5 if len(r) > 1 else None
    g = [t['gross_ret'] for t in trades]
    sweep = {}
    for usd in trades[0].get('sweep', {}):
        xs = [t['sweep'][usd]['net_ret'] for t in trades]
        ok = [t['sweep'][usd]['net_ret'] for t in trades if t['sweep'][usd]['r12_ok'] and t['sweep'][usd]['impact_ok']]
        sweep[usd] = dict(mean=mean(xs), ci=boot_ci(xs), median=median(xs), win=sum(x > 0 for x in xs) / len(xs),
                          impact_med=median(t['sweep'][usd]['entry_impact'] for t in trades),
                          n_allowed=len(ok), mean_allowed=(mean(ok) if ok else None), ci_allowed=boot_ci(ok))
    return dict(gross_mean=mean(g), gross_ci=boot_ci(g), gross_median=median(g), sweep=sweep, n=len(r), win=sum(x > 0 for x in r) / len(r), mean=mean(r), median=median(r), ci=(lo, hi), day_ci=(dlo, dhi),
                sharpe=(mean(r) / sd if sd else None), sum_sol=sum(t['net_sol'] for t in trades),
                partials=sum(t['partials'] for t in trades), reasons=reasons, days=len(set(days)))


def dsr(best, srs, n, skew=0.0, kurt=3.0):
    """Deflated Sharpe ratio (Bailey & Lopez de Prado 2014): P(true SR > SR0), SR0 from the trials' SR variance."""
    k = len(srs)
    if k < 2 or n < 2 or best is None:
        return None
    v = sum((s - mean(srs)) ** 2 for s in srs) / (k - 1)
    g = 0.5772156649
    sr0 = math.sqrt(v) * ((1 - g) * N.inv_cdf(1 - 1 / k) + g * N.inv_cdf(1 - 1 / (k * math.e)))
    den = math.sqrt(max(1e-12, 1 - skew * best + (kurt - 1) / 4 * best ** 2))
    return N.cdf((best - sr0) * math.sqrt(n - 1) / den)


def pbo(trials, n_groups=10):
    """CSCV: discovery days in n_groups blocks; in-sample best trial by mean, its out-of-sample relative rank."""
    days = sorted({t['mig_t'] // DAY for tr in trials.values() for t in tr})
    if len(days) < n_groups or len(trials) < 2:
        return None
    blocks = [days[i::n_groups] for i in range(n_groups)]
    names = list(trials)
    logits = []
    for ins in combinations(range(n_groups), n_groups // 2):
        isd = {d for i in ins for d in blocks[i]}

        def m(name, inside):
            xs = [t['net_ret'] for t in trials[name] if (t['mig_t'] // DAY in isd) == inside]
            return mean(xs) if xs else -1e9
        best = max(names, key=lambda x: m(x, True))
        oos = sorted(names, key=lambda x: m(x, False))
        w = (oos.index(best) + 1) / (len(names) + 1)
        logits.append(math.log(w / (1 - w)))
    return sum(l <= 0 for l in logits) / len(logits)


def pct(x):
    return '—' if x is None else f'{100 * x:+.1f}%'


if __name__ == '__main__':
    datadir, simf, outmd = sys.argv[1:4]
    sim = json.load(open(simf))
    h9 = h9_table(datadir)
    out = dict(coverage=sim['coverage'], holdout=sim['holdout'], trials={})
    kept = {}
    for name, t in sim['trials'].items():
        tr = t['trades']
        unknown = sum(1 for x in tr if h9.get(x['mint'], 'missing') in (None, 'missing'))
        rejected = sum(1 for x in tr if h9.get(x['mint']) is False)
        tr = [x for x in tr if h9.get(x['mint']) is True]
        kept[name] = tr
        s = summarize(tr)
        s.update(h9_rejected=rejected, h9_unknown=unknown, funnel=t['funnel'])
        out['trials'][name] = s
    srs = [s['sharpe'] for s in out['trials'].values() if s.get('sharpe') is not None]
    best = max(out['trials'].items(), key=lambda kv: kv[1].get('mean', -9) if kv[1].get('n', 0) else -9)
    out['dsr_best'] = dict(trial=best[0], dsr=dsr(best[1].get('sharpe'), srs, best[1].get('n', 0))) if len(srs) >= 2 else None
    out['pbo'] = pbo({k: v for k, v in kept.items() if v}) if not sim['holdout'] else None
    lines = [f"Sample: {sim['coverage']}; holdout={sim['holdout']}", '',
             '| Trial | n | Win | Mean net | Median net | 95% CI (coins) | 95% CI (days) | SOL total | H9 out | H9 unknown | Exits |',
             '|---|---|---|---|---|---|---|---|---|---|---|']
    for name, s in out['trials'].items():
        if not s['n']:
            lines.append(f"| {name} | 0 | — | — | — | — | — | — | {s['h9_rejected']} | {s['h9_unknown']} | |")
            continue
        lines.append(f"| {name} | {s['n']} | {100 * s['win']:.0f}% | {pct(s['mean'])} | {pct(s['median'])} | {pct(s['ci'][0])} to {pct(s['ci'][1])} | "
                     f"{pct(s['day_ci'][0])} to {pct(s['day_ci'][1])} | {s['sum_sol']:+.4f} | {s['h9_rejected']} | {s['h9_unknown']} | "
                     + ', '.join(f'{k} {v}' for k, v in sorted(s['reasons'].items())) + ' |')
    lines += ['', 'Funnel (furthest stage per graduate; gate = first failing modelled gate):', '']
    for name, s in out['trials'].items():
        lines.append(f"- {name}: " + ', '.join(f'{k} {v}' for k, v in sorted(s['funnel'].items(), key=lambda kv: -kv[1])))
    lines += ['', '## Size sweep and gross', '', 'Same signals; exits re-simulated at each size. "Allowed" = trades the bot would still take: pool quote side >= max(trial floor, 1,000 x size) (R12) and entry impact <= 1%.', '',
              '| Trial | n | Gross (no costs) mean, 95% CI | Size | Net mean | 95% CI | Win | Median entry impact | Allowed n | Allowed net mean (95% CI) |', '|---|---|---|---|---|---|---|---|---|---|']
    for name, s_ in out['trials'].items():
        if not s_['n']:
            continue
        for i, (usd, w) in enumerate(s_['sweep'].items()):
            gross = f"{pct(s_['gross_mean'])} ({pct(s_['gross_ci'][0])} to {pct(s_['gross_ci'][1])})" if i == 0 else ''
            allowed = f"{pct(w['mean_allowed'])} ({pct(w['ci_allowed'][0])} to {pct(w['ci_allowed'][1])})" if w['n_allowed'] else '—'
            lines.append(f"| {name if i == 0 else ''} | {s_['n'] if i == 0 else ''} | {gross} | ${int(usd):,} | {pct(w['mean'])} | {pct(w['ci'][0])} to {pct(w['ci'][1])} | {100 * w['win']:.0f}% | {100 * w['impact_med']:.2f}% | {w['n_allowed']} | {allowed} |")
    lines += ['', f"Deflated Sharpe of the best-mean trial: {out['dsr_best']}", f"PBO (CSCV, 10 day blocks): {out['pbo']}"]
    open(outmd, 'w').write('\n'.join(lines) + '\n')
    if len(sys.argv) > 4:
        json.dump(out, open(sys.argv[4], 'w'), indent=1)
    print('\n'.join(lines))
