"""Report-only (not pre-registered; found after the run): coins whose hold contains a spike print, i.e. an hourly close
at least 5x the previous close on under 5 units of volume. Recomputes D_capped without them.

  python3 -I artefacts.py <sample.json> <hourlydir> <fresh_orders.jsonl>
"""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze as A

def main(sample, hdir, orders_path):
    cs, _ = A.runner.coins(sample, hdir)
    orders = A.load_orders(orders_path)
    rows = []
    for x in cs:
        if x['ts'][1] + A.runner.MAX_HOLD * A.H > A.runner.WALL - A.H:
            continue
        leg = A.runner.trade(x, A.STOP, A.ARM, A.TRAIL, 'pess')
        if leg is None or orders.get(x['u']['mint']) is None:
            continue
        c, v = x['c'], x['v']
        spike = any(c[i] >= 5 * c[i - 1] and v[i] < 5 for i in range(2, 2 + A.runner.MAX_HOLD))
        rows.append((A.day_of(x['u']['created_ts_ms']), A.flags(orders[x['u']['mint']], x['ts'][1] + A.H)['PAID'], min(A.net_of(leg), A.CAP), spike))
    keep = [r for r in rows if not r[3]]
    g = np.array([r[1] for r in keep]); v = np.array([r[2] for r in keep])
    dd = A.diff_dist(A.DayBoot([r[0] for r in keep]), v, g)
    print(json.dumps({'spike_coins': {'PAID': sum(1 for r in rows if r[3] and r[1]), 'UNPAID': sum(1 for r in rows if r[3] and not r[1])},
                      'without_spikes': {'n_paid': int(g.sum()), 'n_unpaid': int((~g).sum()), 'mean_paid': float(v[g].mean()),
                                         'mean_unpaid': float(v[~g].mean()), 'D_capped': float(v[g].mean() - v[~g].mean()),
                                         'ci95_day': A.pct(dd, 0.95), 'ci9833_day': A.pct(dd, 1 - 0.05 / 3)}}))

if __name__ == '__main__':
    main(*sys.argv[1:])
