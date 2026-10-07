"""Diagnostics for the MR-01 screen (reported beside the registered result; no verdict uses them).

  python3 -I diag.py <eligible.json> <dailydir> <minutedir> <out.json>
Per configuration, main line: share of instant exits (6 h median at or below the entry price), the size of
the drop that triggered entry, and mean gross / net at $200 by drop-size bucket and period.
"""
import json, math, os, statistics, sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen as s

BUCKETS = [(0, 0.01), (0.01, 0.02), (0.02, 0.04), (0.04, 0.08), (0.08, 9)]

def run(elig_path, ddir, mdir, out_path):
    q = s.SIZES['$200']
    rows = {k: [] for k in s.CONFIGS}
    for u in json.load(open(elig_path)):
        if u['best'] != 'A':
            continue
        elig = s.eligible_days(os.path.join(ddir, u['pool'] + '.json'))
        mp = os.path.join(mdir, u['pool'] + '.json')
        if not elig or not os.path.exists(mp):
            continue
        b = s.load(mp, min(s.WALL, max(elig) + s.DAY + 2 * 3600))
        if b is None:
            continue
        c = b['c']
        for k, cfg in s.CONFIGS.items():
            for t in s.run_line(b, s.signals(b, cfg, elig), cfg, elig):
                i = t['i']
                med0 = float(np.median(c[i + 1 - s.WIN:i + 1]))   # target level at the first holding minute
                rows[k].append({'per': s.period(t['t']), 'drop': -math.log(c[i] / c[i - cfg['L']]),
                                'instant': med0 <= c[i], 'g': t['g'], 'net': s.net(t['g'], t['mcap'], q)})
    out = {}
    for k, rs in rows.items():
        for per in ('disc', 'val'):
            r = [x for x in rs if x['per'] == per]
            d = {'n': len(r), 'instant_share': sum(x['instant'] for x in r) / len(r),
                 'drop_median_pct': 100 * statistics.median(x['drop'] for x in r), 'buckets': {}}
            nonin = [x for x in r if not x['instant']]
            d['non_instant'] = {'n': len(nonin), 'mean_gross_pct': 100 * statistics.fmean(x['g'] for x in nonin),
                                'mean_net_pct': 100 * statistics.fmean(x['net'] for x in nonin)} if nonin else {'n': 0}
            for lo, hi in BUCKETS:
                xs = [x for x in r if lo <= x['drop'] < hi]
                if xs:
                    d['buckets'][f'{100*lo:g}-{100*hi:g}%'] = {
                        'n': len(xs), 'mean_gross_pct': 100 * statistics.fmean(x['g'] for x in xs),
                        'mean_net_pct': 100 * statistics.fmean(x['net'] for x in xs),
                        'win': sum(x['net'] > 0 for x in xs) / len(xs)}
            out[f'{k}|{per}'] = d
    json.dump(out, open(out_path, 'w'), indent=1)
    print(json.dumps(out, indent=1))

if __name__ == '__main__':
    run(*sys.argv[1:])
