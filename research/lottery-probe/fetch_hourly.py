"""Hourly OHLCV for the lottery-basket sample (see PREREG.md). Pre-wall only.

  python3 -I fetch_hourly.py <sample.json> <outdir>
"""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'deep-pool-probe'))
from fetch import get, WALL

GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{}/ohlcv/hour?aggregate=1&before_timestamp={}&limit=1000&currency=token'

def main(sample, outdir):
    os.makedirs(outdir, exist_ok=True)
    for u in json.load(open(sample)):
        p = os.path.join(outdir, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        before = min(u['created_ts_ms'] // 1000 + 41 * 86400, WALL)
        d = get(GT.format(u['pool'], before)) or {}
        lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
        json.dump(sorted(lst), open(p, 'w'))
        time.sleep(6.5)

if __name__ == '__main__':
    main(*sys.argv[1:])
