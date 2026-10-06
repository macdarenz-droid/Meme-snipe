"""Funnel of U1 checks on the screen period: why checks do not become entries (counts only, no outcomes)."""
import glob, json, math, os, sys, bisect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
import importlib.util
_s = importlib.util.spec_from_file_location('sig', os.path.join(HERE, '05_signals.py')); sig = importlib.util.module_from_spec(_s); _s.loader.exec_module(sig)
period = sys.argv[1] if len(sys.argv) > 1 else 'screen'
c = {'pools': 0, 'pools_u1': 0, 'checks_u1': 0, 'u1B': 0, 'atr_none': 0, 'atr_ok15': 0, 'pools_atr_ok': 0, 'young': 0}
for fn in glob.glob(os.path.join(DATA, 'bars', '*.json')):
    d = json.load(open(fn)); c['pools'] += 1
    m5 = d['m5']
    if not m5 or d['t'] < MIG_FROM: continue
    k = d['tok'] * d['sol']; ends = [b[0] + 300 for b in m5]; any_u1 = any_ok = False
    lo = max(d['t'] + D1, ENTRY_FROM if period == 'screen' else HOLDOUT_FROM); hi = min(d['t'] + D14, (HOLDOUT_FROM if period == 'screen' else WALL - TMAX) - 300)
    T = (lo + 299) // 300 * 300
    while T <= hi:
        i = bisect.bisect_right(ends, T) - 1
        if i >= 0 and ends[i] >= T - 3600:
            p = m5[i][4]; q = math.sqrt(k * p)
            if q >= 100:
                any_u1 = True; c['checks_u1'] += 1
                if q * (sol_usd(T) or 0) >= 50000: c['u1B'] += 1
                a = sig.atr14(m5, i)
                if a is None: c['atr_none'] += 1
                elif 3 * a >= 0.15 * p: c['atr_ok15'] += 1; any_ok = True
        T += 300
    c['pools_u1'] += any_u1; c['pools_atr_ok'] += any_ok
print(json.dumps(c))
