"""Step 8 (EDGE-HUNT-U1-B): tables per period, fold and size; the pre-registered selection; deflated Sharpe over all
trials so far; PBO by CSCV on the walk-forward. Reads data/trades/*.json (07_sim.py). Writes results/*.json.

  python3 08_report.py wf        -> results/train_wf.json, results/selection.json (the candidate, or none)
  python3 08_report.py holdout   -> results/holdout.json (only when selection.json names a candidate)
"""
import csv, io, itertools, json, math, os, random, statistics, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, DATA, ENTRY_FROM, HOLDOUT_FROM, WALL, TMAX
N01 = statistics.NormalDist()
SIZES = [2, 5, 20, 100, 1000, 10000]
DAYS = {'train': 26, 'wf': 26, 'WF1': 9, 'WF2': 9, 'WF3': 8, 'holdout': 10}
N_TRIALS = 72 + 120 + 8 + 6 + 2           # preregistration.json statistics.luck
mode = sys.argv[1] if len(sys.argv) > 1 else 'wf'

def load(period, rule, size):
    f = os.path.join(DATA, 'trades', f'{period}_{rule}_{size}.json')
    return json.load(open(f)) if os.path.exists(f) else []

def boot_ci(tr, B=4000, seed=7):
    by = {}
    for t in tr: by.setdefault(t['mint'], []).append(t['ret'])
    ks = sorted(by); rng = random.Random(seed); means = []
    for _ in range(B):
        xs = []
        for _ in ks: xs += by[rng.choice(ks)]
        means.append(sum(xs) / len(xs))
    means.sort()
    return [means[int(0.025 * B)], means[int(0.975 * B) - 1]]

def summ(tr, days):
    if not tr: return {'n': 0}
    rs = sorted(t['ret'] for t in tr); n = len(rs); mean = sum(rs) / n
    sd = statistics.stdev(rs) if n > 1 else 0.0
    m = lambda k: sum(t[k] for t in tr) / n
    al = [t for t in tr if t['allowed']]
    return {'n': n, 'coins': len({t['mint'] for t in tr}), 'days': len({t['T'] // 86400 for t in tr}), 'win': sum(x > 0 for x in rs) / n,
            'mean': mean, 'median': statistics.median(rs), 'sd': sd, 'ci95': boot_ci(tr) if n > 1 else [None, None],
            'gross': m('gross'), 'fees': m('fees'), 'impact': m('impact'), 'fixed': m('fixed'),
            'net_sol_total': sum(t['net_sol'] for t in tr), 'entries_per_day': n / days,
            'sharpe_per_trade': mean / sd if sd else None,
            'allowed_n': len(al), 'allowed_mean': (sum(t['ret'] for t in al) / len(al)) if al else None,
            'reasons': dict(sorted({r: sum(t['reason'] == r for t in tr) for r in {t['reason'] for t in tr}}.items()))}

def dsr(rs, sr_var):
    k = len(rs); m = sum(rs) / k; sd = statistics.stdev(rs)
    sk = sum((x - m) ** 3 for x in rs) / k / sd ** 3; ku = sum((x - m) ** 4 for x in rs) / k / sd ** 4
    g = 0.5772156649; N = N_TRIALS
    sr0 = math.sqrt(sr_var) * ((1 - g) * N01.inv_cdf(1 - 1 / N) + g * N01.inv_cdf(1 - 1 / (N * math.e)))
    sr = m / sd
    return N01.cdf((sr - sr0) * math.sqrt(k - 1) / math.sqrt(max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr * sr))), sr0

def other_trial_srs():
    """Per-trade Sharpe of every earlier trial whose series is on hand: U1's 8 (results/screen.json) and U2's 6."""
    u1 = json.load(open(os.path.join(HERE, '..', 'edge-hunt-u1', 'results', 'screen.json')))['results']
    srs = [v['sharpe_per_trade'] for k, v in u1.items() if not k.startswith('S0') and v.get('sharpe_per_trade') is not None]
    raw = subprocess.check_output(['git', '-C', HERE, 'show', '0857be6:research/edge-hunt-u2/results/trades_discovery.csv']).decode()
    by = {}
    for r in csv.DictReader(io.StringIO(raw)): by.setdefault(r['trial'], []).append(float(r['net_ret_2usd']))
    srs += [statistics.mean(v) / statistics.stdev(v) for v in by.values() if len(v) > 2]
    return srs

out = {'mode': mode, 'nTrials': N_TRIALS}
if mode == 'wf':
    tab = {}
    for rule in ('H1', 'H6', 'S0', 'H2', 'H3'):
        for size in SIZES:
            tr = load('train', rule, size); wf = load('wf', rule, size)
            row = {'train': summ(tr, DAYS['train']), 'wf': summ(wf, DAYS['wf'])}
            for f in ('WF1', 'WF2', 'WF3'): row[f] = summ([t for t in wf if t['fold'] == f], DAYS[f])
            tab[f'{rule}-B ${size}'] = row
    out['table'] = tab
    # Selection (preregistration.json 'selection'), at $20 only
    cands = []
    for rule in ('H1', 'H6'):
        r = tab[f'{rule}-B $20']; w = r['wf']
        folds_pos = sum(1 for f in ('WF1', 'WF2', 'WF3') if r[f]['n'] and r[f]['mean'] > 0)
        ok = w['n'] >= 30 and w['mean'] > 0 and folds_pos >= 2
        cands.append({'rule': f'{rule}-B', 'wf_n': w['n'], 'wf_mean': w.get('mean'), 'wf_lo': (w.get('ci95') or [None])[0],
                      'folds_positive': folds_pos, 'qualifies': ok})
    q = [c for c in cands if c['qualifies']]
    best = max(q, key=lambda c: c['wf_lo']) if q else None
    out['selection'] = {'candidates': cands, 'candidate': best['rule'] if best else None}
    json.dump({'candidate': best['rule'] if best else None, 'candidates': cands}, open(os.path.join(HERE, 'results', 'selection.json'), 'w'), indent=1, sort_keys=True)
    # Luck: DSR of this study's two trials on the walk-forward at $20, N = all trials so far
    mine = {r: [t['ret'] for t in load('wf', r, 20)] for r in ('H1', 'H6')}
    srs = other_trial_srs() + [statistics.mean(v) / statistics.stdev(v) for v in mine.values() if len(v) > 2]
    v = statistics.pvariance(srs)
    out['dsr'] = {'srVariance': v, 'srsUsed': len(srs), **{f'{r}-B $20 wf': dict(zip(('dsr', 'sr0'), dsr(x, v))) for r, x in mine.items() if len(x) > 2}}
    # PBO: CSCV over 8 day-blocks of the walk-forward, configs = H1, H2, H3, H6 in B at $2 and $20
    cfg = {f'{r}-{s}': load('wf', r, s) for r in ('H1', 'H2', 'H3', 'H6') for s in (2, 20)}
    cfg = {k: v for k, v in cfg.items() if v}
    days = sorted({t['T'] // 86400 for v in cfg.values() for t in v})
    if len(cfg) > 1 and len(days) >= 8:
        blocks = [set(days[i * len(days) // 8:(i + 1) * len(days) // 8]) for i in range(8)]
        def mean_in(k, ds):
            xs = [t['ret'] for t in cfg[k] if t['T'] // 86400 in ds]
            return sum(xs) / len(xs) if xs else -1e9
        logits = []
        for comb in itertools.combinations(range(8), 4):
            ins = set().union(*(blocks[i] for i in comb)); outs = set().union(*(blocks[i] for i in range(8) if i not in comb))
            ks = sorted(cfg); best_k = max(ks, key=lambda k: mean_in(k, ins))
            oos = sorted(ks, key=lambda k: mean_in(k, outs)); w = (oos.index(best_k) + 1) / (len(ks) + 1)
            logits.append(math.log(w / (1 - w)))
        out['pbo'] = {'configs': sorted(cfg), 'splits': len(logits), 'pbo': sum(l <= 0 for l in logits) / len(logits)}
    fn = 'train_wf.json'
else:
    sel = json.load(open(os.path.join(HERE, 'results', 'selection.json')))
    assert sel['candidate'], 'no candidate: the holdout is not read'
    rule = sel['candidate'].split('-')[0]
    out['candidate'] = sel['candidate']
    out['table'] = {f'{sel["candidate"]} ${s}': summ(load('holdout', rule, s), DAYS['holdout']) for s in SIZES}
    h = out['table'][f'{sel["candidate"]} $20']
    lo = (h.get('ci95') or [None])[0]
    out['verdict'] = 'PASS' if h['n'] > 1 and lo > 0 else ('INCONCLUSIVE' if h['n'] and h['mean'] > 0 else 'NO')
    rs = [t['ret'] for t in load('holdout', rule, 20)]
    if len(rs) > 2:
        srs = other_trial_srs(); out['dsr'] = dict(zip(('dsr', 'sr0'), dsr(rs, statistics.pvariance(srs + [statistics.mean(rs) / statistics.stdev(rs)]))))
    fn = 'holdout.json'
os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
json.dump(out, open(os.path.join(HERE, 'results', fn), 'w'), indent=1, sort_keys=True)
print(json.dumps(out.get('selection') or out.get('verdict'), indent=1))
