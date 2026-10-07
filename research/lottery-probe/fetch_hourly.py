"""Hourly OHLCV for the lottery-basket sample (see PREREG.md). Pre-wall only.

  python3 -I fetch_hourly.py <sample.json> <outdir>
"""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'deep-pool-probe'))
from fetch import get, WALL

GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{}/ohlcv/hour?aggregate=1&before_timestamp={}&limit=1000&currency=token'

def main(sample, outdir, mode='first'):
    """mode 'first': window ends at created + 41 d. mode 'refetch': for pools whose holds would pass that
    window, refetch ending at min(t0 + 41 d, wall), t0 = first bar of the first fetch. Writes _before.json."""
    os.makedirs(outdir, exist_ok=True)
    metaf = os.path.join(outdir, '_before.json')
    meta = json.load(open(metaf)) if os.path.exists(metaf) else {}
    for u in json.load(open(sample)):
        p = os.path.join(outdir, u['pool'] + '.json')
        first_before = min(u['created_ts_ms'] // 1000 + 41 * 86400, WALL)
        if mode == 'first':
            if os.path.exists(p):
                continue
            before = first_before
        else:
            if not os.path.exists(p):
                continue
            rows = json.load(open(p))
            if not rows or meta.get(u['pool'], first_before) != first_before:
                continue
            t0 = int(min(r[0] for r in rows))
            if t0 + 24 * 3600 + 30 * 86400 + 3600 <= first_before:
                continue
            before = min(t0 + 41 * 86400, WALL)
            if before <= first_before:
                continue
        d = get(GT.format(u['pool'], before)) or {}
        lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
        json.dump(sorted(lst), open(p, 'w'))
        meta[u['pool']] = before
        json.dump(meta, open(metaf, 'w'))
        time.sleep(6.5)

if __name__ == '__main__':
    main(*sys.argv[1:])
