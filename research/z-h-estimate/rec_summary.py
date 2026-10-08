"""Summarise rec_rates.py output: successful transactions per pool by pool age. Usage: rec_summary.py rates.json"""
import json, sys, statistics as st
d = json.load(open(sys.argv[1])); M = d['migratedAtMs']
rows = []
for f in d['files']:
    for a, (n_all, n_ok, slot_span) in f['addr'].items():
        if a in M:
            rows.append(((f['start_ms'] - M[a]) / 3.6e6, n_ok / f['span_s'], n_all / f['span_s']))
def q(v, p):
    v = sorted(v); return v[min(len(v) - 1, int(p * len(v)))]
bands = [(0, 1/3), (1/3, 1), (1, 2), (2, 6), (6, 24)]
out = {'pool_observations': len(rows), 'files': len(d['files']),
       'seconds_sampled': sum(f['span_s'] for f in d['files']), 'bands': []}
tot_mean_ok = tot_mean_all = tot_med_ok = 0.0
for lo, hi in bands:
    r = [x for x in rows if lo <= x[0] < hi]
    if not r:
        continue
    ok = [x[1] for x in r]; al = [x[2] for x in r]; hours = hi - lo
    band = {'age_h': [round(lo, 3), hi], 'n': len(r), 'ok_per_s': {'p25': q(ok, .25), 'median': q(ok, .5),
            'p75': q(ok, .75), 'p90': q(ok, .9), 'mean': st.mean(ok)}, 'all_per_s_mean': st.mean(al),
            'ok_tx_in_band_mean': st.mean(ok) * hours * 3600, 'ok_tx_in_band_median': q(ok, .5) * hours * 3600,
            'all_tx_in_band_mean': st.mean(al) * hours * 3600}
    if hi <= 6:
        tot_mean_ok += band['ok_tx_in_band_mean']; tot_mean_all += band['all_tx_in_band_mean']
        tot_med_ok += band['ok_tx_in_band_median']
    out['bands'].append(band)
out['first_6h_per_pool'] = {'ok_mean': tot_mean_ok, 'all_mean': tot_mean_all, 'ok_median_sum': tot_med_ok}
json.dump(out, sys.stdout, indent=1)
