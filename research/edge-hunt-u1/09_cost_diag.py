"""Diagnostics on the screen (never used for selection): the same trades with (a) no costs at all, (b) a $20 size,
(c) a $5 size. Shows how far each rule is from break-even and whether a larger size alone would change the answer."""
import json, os, sys, importlib.util
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
spec = importlib.util.spec_from_file_location('sim', os.path.join(common.HERE, '07_sim.py')); sim = importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)
period = sys.argv[1] if len(sys.argv) > 1 else 'screen'
rules = sys.argv[2].split(',') if len(sys.argv) > 2 else ['H1', 'H2', 'H3', 'H6', 'S0']
base = (sim.fee_bps, sim.FIXED_ONE_EXIT, sim.EXTRA_EXIT, sim.NOTIONAL_USD)
scen = {'no costs': (lambda m: 0, 0, 0, 2.0), '$2 (base)': (base[0], base[1], base[2], 2.0),
        '$5': (base[0], base[1], base[2], 5.0), '$20': (base[0], base[1], base[2], 20.0)}
out = {}
for name, (fb, f1, f2, usd) in scen.items():
    sim.fee_bps, sim.FIXED_ONE_EXIT, sim.EXTRA_EXIT, sim.NOTIONAL_USD = fb, f1, f2, usd
    for r in rules:
        for u in ('A', 'B'):
            tr, _ = sim.run(sim.load_signals(period, [r], u))
            s = sim.summary(tr); out.setdefault(f'{r}-{u}', {})[name] = {k: s.get(k) for k in ('n', 'mean', 'ci95')}
print(f"{'trial':6} " + ' '.join(f'{k:>24}' for k in scen))
for t, v in out.items():
    print(f'{t:6} ' + ' '.join(f"{v[k]['mean']*100:7.2f}% [{v[k]['ci95'][0]*100:5.1f},{v[k]['ci95'][1]*100:5.1f}]" if v[k]['n'] > 1 else f"{'-':>24}" for k in scen))
json.dump(out, open(os.path.join(common.HERE, 'results', f'cost_diag_{period}.json'), 'w'), indent=1)
