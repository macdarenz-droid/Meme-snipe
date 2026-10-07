"""Step 8: screen table for every trial and the control, the deflated Sharpe ratio over all trials so far
(Bailey & Lopez de Prado 2014) and the probability of backtest overfitting by CSCV over day blocks.
Reads data/trades_screen_<rule>_<U>.json written by 07_sim.py run. Writes results/screen.json."""
import itertools, json, math, os, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
import importlib.util
_s = importlib.util.spec_from_file_location('sim', os.path.join(HERE, '07_sim.py')); sim = importlib.util.module_from_spec(_s); _s.loader.exec_module(sim)
N01 = statistics.NormalDist()
period = sys.argv[1] if len(sys.argv) > 1 else 'screen'
trials = json.load(open(os.path.join(HERE, 'trials.json')))
names = trials['primary'] + [v['id'] for v in trials['variants']] + ['S0-A', 'S0-B']
res, series = {}, {}
for nm in names:
    f = os.path.join(DATA, f'trades_{period}_{nm.replace("-", "_")}.json')
    if not os.path.exists(f): continue
    tr = json.load(open(f)); res[nm] = sim.summary(tr); series[nm] = tr
# Deflated Sharpe over the trials (not the control)
tn = [n for n in names if n in res and not n.startswith('S0') and res[n]['n'] > 2]
srs = [res[n]['sharpe_per_trade'] or 0 for n in tn]
N = max(len(trials['primary']) + len(trials['variants']), 1)
if len(srs) > 1:
    v = statistics.pvariance(srs); g = 0.5772156649
    sr0 = math.sqrt(v) * ((1 - g) * N01.inv_cdf(1 - 1 / N) + g * N01.inv_cdf(1 - 1 / (N * math.e)))
    for n in tn:
        rs = [t['ret'] for t in series[n]]; k = len(rs); m = sum(rs) / k; sd = statistics.stdev(rs)
        sk = sum((x - m) ** 3 for x in rs) / k / sd ** 3; ku = sum((x - m) ** 4 for x in rs) / k / sd ** 4
        sr = m / sd
        den = math.sqrt(max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr * sr))
        res[n]['dsr'] = N01.cdf((sr - sr0) * math.sqrt(k - 1) / den); res[n]['sr0'] = sr0
# PBO by CSCV: 8 blocks of days, all 70 half/half splits; best in-sample trial's out-of-sample rank
days = sorted({t['T'] // 86400 for n in tn for t in series[n]})
pbo = None
if len(tn) > 1 and len(days) >= 8:
    blocks = [days[i * len(days) // 8:(i + 1) * len(days) // 8] for i in range(8)]
    def mean_in(n, ds):
        xs = [t['ret'] for t in series[n] if t['T'] // 86400 in ds]
        return sum(xs) / len(xs) if xs else -1e9
    logits = []
    for comb in itertools.combinations(range(8), 4):
        ins = {d for i in comb for d in blocks[i]}; outs = {d for i in range(8) if i not in comb for d in blocks[i]}
        best = max(tn, key=lambda n: mean_in(n, ins))
        oos = sorted(tn, key=lambda n: mean_in(n, outs)); w = (oos.index(best) + 1) / (len(tn) + 1)
        logits.append(math.log(w / (1 - w)))
    pbo = sum(1 for l in logits if l <= 0) / len(logits)
os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
out = {'period': period, 'trialsCounted': N, 'pbo_cscv': pbo, 'results': res}
json.dump(out, open(os.path.join(HERE, 'results', f'{period}.json'), 'w'), indent=1)
print(f"{'trial':8} {'n':>4} {'coins':>5} {'days':>4} {'win':>5} {'mean':>7} {'median':>7} {'ci95':>17} {'gross':>7} {'DSR':>5}")
for n, r in res.items():
    if r['n'] == 0: print(n, 0); continue
    ci = r['ci95']; cis = f"[{ci[0]*100:6.1f},{ci[1]*100:6.1f}]" if ci[0] is not None else ''
    print(f"{n:8} {r['n']:4} {r['coins']:5} {r['days']:4} {r['win']*100:4.0f}% {r['mean']*100:6.2f}% {r['median']*100:6.2f}% {cis:>17} {r['mean_gross_move']*100:6.2f}% {r.get('dsr', float('nan')):5.2f}")
print('PBO (CSCV, 8 day blocks):', pbo)
