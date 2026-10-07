#!/usr/bin/env python3
"""Same model, but the owner's trial setting: 1 unit = 10% of the starting bankroll ($2 on $20). J=100."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mc_sizing as M

M.START, M.RUIN = 10.0, 1.0
m = M.load(); be = M.be_fixed(m, 100.0)
M.LAMS = [1 / 1000, 1 / 200]   # run_world adds the exact break-even
out = []
for args in [(m, 'IID', 0.1, 1.0, 1, 21, [100.0], 'all'), (m, 'REGIME', 0.1, 30.0, 5, 22, [100.0], 'all')]:
    out += M.run_world(args)
json.dump(dict(start=M.START, ruin=M.RUIN, results=out), open(os.path.join(HERE, 'trial_results.json'), 'w'))
for c in out:
    print('%s lam 1/%d mu %+.3f' % (c['world'], round(1 / c['lam']), c['mu']))
    for a in ('FIXED', 'OWNER', 'OWNER_LAG'):
        v = c['res'][a]
        print('   %-10s mean %7.2f median %6.2f P(ruin) %.3f P(>start) %.3f maxDD %.2f' % (a, v['mean'], v['median'], v['p_ruin'], v['p_gain'], v['mdd']))
