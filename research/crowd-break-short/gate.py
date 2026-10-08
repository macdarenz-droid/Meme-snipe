"""CROWD-BREAK-SHORT gate (PREREG section 3). Reads stage1.json and Binance OI only; reads no price after any T.

  python3 -I gate.py <data_dir> <out_dir>

Checks: (1) at least 10 kept coins with at least 600 h of overlap; (2) median Hyperliquid funding at event hours
above 0; (3) OI-only mechanism: the share of events whose as-of OI at T + 6 h is at least 5% below the as-of OI at
T exceeds the same share among their C1 controls, with a one-sided 95% lower bound above 0.
Choices fixed here: the C1 set for this check is the first 10 ranked candidates (no executability test, which
would read a post-T price); an event needs at least 3 controls with both OI values; "by T + 6 h" is the
end-point change; the lower bound must hold for both the day-block bootstrap and the day-clustered t (as in
PREREG section 7). Writes <out_dir>/gate.json.
"""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stage1 import oi_series, oi_asof, HOLD
from stage2 import boot, clustered


def main(d, out):
    st = json.load(open(os.path.join(out, 'stage1.json')))
    info, evs = st['info'], st['events']
    OI = {}
    rows = []
    for e in evs:
        c = e['coin']
        if c not in OI:
            OI[c] = oi_series(d, c)
        t, v = OI[c]

        def fell(T):
            a, b = oi_asof(t, v, [T, T + HOLD])
            if np.isnan(a) or np.isnan(b) or a <= 0:
                return None
            return float(b / a - 1 <= -0.05)
        fe = fell(e['T'])
        cs = [fell(x['T']) for x in e['controls_ranked'][:10]]
        cs = [x for x in cs if x is not None]
        if fe is None or len(cs) < 3:
            continue
        rows.append({'id': e['id'], 'day': e['T'] // 86400, 'e': fe, 'c': float(np.mean(cs)), 'nc': len(cs)})
    dlt = [r['e'] - r['c'] for r in rows]; dy = [r['day'] for r in rows]
    lb_boot = boot(dlt, dy, lvl=0.90)[0] if len(set(dy)) > 1 else None      # 5th percentile = one-sided 95%
    lb_t = clustered(dlt, dy, lvl=0.90)[0] if len(set(dy)) > 1 else None
    kept = info['kept']
    checks = {
        'coins_with_600h': [len(kept), bool(len(kept) >= 10)],
        'median_event_funding': [info['median_event_funding'],
                                 info['median_event_funding'] is not None and info['median_event_funding'] > 0],
        'oi_mechanism': [{'events_used': len(rows), 'event_share': float(np.mean([r['e'] for r in rows])) if rows else None,
                          'control_share': float(np.mean([r['c'] for r in rows])) if rows else None,
                          'mean_diff': float(np.mean(dlt)) if rows else None, 'lb95_boot': lb_boot, 'lb95_t': lb_t},
                         bool(lb_boot is not None and lb_t is not None and lb_boot > 0 and lb_t > 0)]}
    res = {'checks': checks, 'verdict': 'PASS' if all(v[1] for v in checks.values()) else 'CLOSED',
           'n_events': len(evs), 'events_dropped_oi': len(evs) - len(rows)}
    json.dump(res, open(os.path.join(out, 'gate.json'), 'w'), indent=1, sort_keys=True)
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
