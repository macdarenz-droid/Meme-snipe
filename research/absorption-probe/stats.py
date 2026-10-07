"""Statistics and verdict (rules in PREREG.md).  python3 -I stats.py <events.json> <outcomes.json> <out.json>"""
import json, math, random, statistics, sys
from collections import defaultdict
CAP = 19.0
SPLIT = 1787270400
N_MIN = 30

def tq(df, p=0.975):
    """Student t quantile by bisection on the regularized incomplete beta (no scipy)."""
    def cdf(t):
        x = df / (df + t * t)
        return 1 - 0.5 * ibeta(df / 2, 0.5, x)
    lo, hi = 0.0, 50.0
    for _ in range(100):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if cdf(m) < p else (lo, m)
    return (lo + hi) / 2

def ibeta(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    if x > (a + 1) / (a + b + 2):
        return 1 - ibeta(b, a, 1 - x)
    f, c, d = 1.0, 1.0, 0.0
    for i in range(300):
        m = i // 2
        if i == 0: num = 1.0
        elif i % 2 == 0: num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
        else: num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
        d = 1 + num * d; d = 1 / d if abs(d) > 1e-30 else 1e30
        c = 1 + num / c if abs(c) > 1e-30 else 1e30
        f *= c * d
        if abs(c * d - 1) < 1e-12: break
    return math.exp(lbeta) / a * (f - 1)

def day(t):
    return int(t // 86400)

def cluster_t(pairs):
    """pairs: [(day, value)]. Trade-weighted mean, cluster-robust SE by UTC day, t with D-1 df, 95% interval."""
    n = len(pairs)
    if n == 0:
        return None
    m = sum(v for _, v in pairs) / n
    by = defaultdict(list)
    for d, v in pairs:
        by[d].append(v)
    D = len(by)
    if D < 2:
        return {'n': n, 'days': D, 'mean': m, 'ci95': None}
    var = D / (D - 1) * sum((sum(vs) - len(vs) * m) ** 2 for vs in by.values()) / n ** 2
    se = math.sqrt(var); q = tq(D - 1)
    return {'n': n, 'days': D, 'mean': m, 'se': se, 'ci95': [m - q * se, m + q * se]}

def boot_days(pairs, fn=None, B=5000, seed=7):
    by = defaultdict(list)
    for d, v in pairs:
        by[d].append(v)
    days = list(by); rng = random.Random(seed); ms = []
    if len(days) < 2:
        return None
    for _ in range(B):
        xs = []
        for _ in days:
            xs += by[days[rng.randrange(len(days))]]
        ms.append(sum(xs) / len(xs))
    ms.sort()
    return [ms[int(0.025 * B)], ms[int(0.975 * B) - 1]]

def boot_diff(pa, pc, B=5000, seed=11):
    """Mean(A) - mean(C), resampling UTC days jointly."""
    by = defaultdict(lambda: ([], []))
    for d, v in pa: by[d][0].append(v)
    for d, v in pc: by[d][1].append(v)
    days = list(by); rng = random.Random(seed); ms = []
    for _ in range(B):
        a, c = [], []
        for _ in days:
            x = by[days[rng.randrange(len(days))]]; a += x[0]; c += x[1]
        if a and c:
            ms.append(sum(a) / len(a) - sum(c) / len(c))
    ms.sort()
    return [ms[int(0.025 * len(ms))], ms[int(0.975 * len(ms)) - 1]] if ms else None

def describe(vals):
    if not vals:
        return {'n': 0}
    return {'n': len(vals), 'mean_capped': statistics.fmean(min(v, CAP) for v in vals), 'mean_raw': statistics.fmean(vals),
            'median': statistics.median(vals), 'win_rate': sum(1 for v in vals if v > 0) / len(vals),
            'n_proceeds_ge_2x': sum(1 for v in vals if v >= 1.0), 'n_proceeds_ge_5x': sum(1 for v in vals if v >= 4.0)}

def run(evfile, outfile, dst):
    E = json.load(open(evfile)); O = json.load(open(outfile))
    evs = {e['id']: e for e in E['events'] + E.get('b_events', []) if e.get('traded')}
    res = {}
    for L in ('L10', 'L2'):
        for sens in ('primary', 'data-ends-at-minus-100', 'wall-censored-excluded'):
            def val(k):
                o = O[k][L]
                if sens == 'data-ends-at-minus-100' and o['exit_flag'] == 'no-swap-after':
                    return -1 - (o['mult'] - 1 - o['net'])        # -100% of the stake minus the fixed cost
                if sens == 'wall-censored-excluded' and o['exit_reason'] == 'wall':
                    return None
                return o['net']
            for per in ('all', 'A', 'B'):
                inper = lambda k: per == 'all' or ((O[k]['entry_t'] < SPLIT) == (per == 'A'))
                g = {grp: [(day(O[k]['entry_t']), val(k)) for k in O if k in evs and O[k]['group'] == grp and inper(k)] for grp in 'ABC'}
                g = {grp: [(d, v) for d, v in xs if v is not None] for grp, xs in g.items()}
                cap = {grp: [(d, min(v, CAP)) for d, v in xs] for grp, xs in g.items()}
                r = {grp: describe([v for _, v in g[grp]]) for grp in 'ABC'}
                r['A_ci_cluster_t'] = cluster_t(cap['A']); r['A_ci_boot_days'] = boot_days(cap['A'])
                diffs = []
                for k, e in evs.items():
                    if e['group'] != 'A' or k not in O or not inper(k):
                        continue
                    bs = [b for b, eb in evs.items() if eb.get('matched_to') == k and b in O]
                    va = val(k); vb = [val(b) for b in bs]; vb = [x for x in vb if x is not None]
                    if va is None or not vb:
                        continue
                    diffs.append((day(O[k]['entry_t']), min(va, CAP) - statistics.fmean(min(x, CAP) for x in vb)))
                r['A_minus_B_cluster_t'] = cluster_t(diffs); r['A_minus_B_n_pairs'] = len(diffs)
                r['A_minus_C_boot_days'] = boot_diff(cap['A'], cap['C']) if cap['A'] and cap['C'] else None
                r['A_minus_C_mean'] = (r['A']['mean_capped'] - r['C']['mean_capped']) if r['A']['n'] and r['C']['n'] else None
                r['cost_paid_mean'] = {grp: statistics.fmean(O[k][L]['entry_cost'] + (O[k][L]['exit_cost'] or 0) for k in O
                                                              if k in evs and O[k]['group'] == grp and inper(k)) if r[grp]['n'] else None for grp in 'ABC'}
                res[f'{L}|{sens}|{per}'] = r
    p = res['L10|primary|all']
    nA = p['A']['n']
    if nA < N_MIN:
        verdict = 'unresolved'
    else:
        a, d = p['A_ci_cluster_t'], p['A_minus_B_cluster_t']
        if p['A']['mean_capped'] <= 0 or (d and d['mean'] <= 0):
            verdict = 'killed'
        elif a['ci95'] and a['ci95'][0] > 0 and d and d['ci95'] and d['ci95'][0] > 0:
            verdict = 'supported'
        else:
            verdict = 'not shown (shelved)'
    json.dump({'verdict': verdict, 'n_A': nA, 'results': res}, open(dst, 'w'), indent=1)
    print(verdict, nA)

if __name__ == '__main__':
    run(*sys.argv[1:])
