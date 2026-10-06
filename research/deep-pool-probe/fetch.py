"""Deep-pool probe data fetch (see PREREG.md). Pre-wall data only.

  python3 -I fetch.py universe <pump_mc_dir> <out.json>   # trims the pump.fun coin pages
  python3 -I fetch.py daily <universe.json> <outdir>      # daily OHLCV per pool, before the wall
  python3 -I fetch.py bars <eligible.json> <outdir>       # 5-minute OHLCV per pool, 2026-07-19 to the wall
"""
import glob, json, os, ssl, sys, time, urllib.request

WALL = 1789999200            # 2026-09-21T14:00:00Z
START = 1784419200           # 2026-07-19T00:00:00Z (3-day look-back before 07-22)
GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{}/ohlcv/{}?aggregate={}&before_timestamp={}&limit={}&currency=token'
WSOL = 'So11111111111111111111111111111111111111112'

def ctx():
    for f in (os.environ.get('SSL_CERT_FILE'), '/root/.ccr/ca-bundle.crt'):
        if f and os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()

CTX = ctx()

def get(url):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                return json.load(r)
        except Exception as e:  # 429 or network: back off
            time.sleep(5 * (attempt + 1))
    raise RuntimeError('failed: ' + url)

def universe(src, out):
    coins = {}
    for f in glob.glob(os.path.join(src, 'pump_mc_*.json')):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if isinstance(d, list):
            for x in d:
                coins[x['mint']] = x
    keep = []
    for x in coins.values():
        if not x.get('pump_swap_pool'):
            continue
        if (x.get('quote_mint') or WSOL) != WSOL:
            continue
        if str(x.get('total_supply')) != '1000000000000000':
            continue
        if (x.get('created_timestamp') or 0) >= (WALL - 3 * 86400) * 1000:
            continue
        keep.append({'mint': x['mint'], 'symbol': x.get('symbol'), 'pool': x['pump_swap_pool'], 'created_ms': x.get('created_timestamp')})
    keep.sort(key=lambda r: r['mint'])
    json.dump(keep, open(out, 'w'), indent=0)
    print(len(keep), 'pools')

def daily(uni, outdir):
    os.makedirs(outdir, exist_ok=True)
    for u in json.load(open(uni)):
        p = os.path.join(outdir, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        d = get(GT.format(u['pool'], 'day', 1, WALL, 120))
        json.dump(d, open(p, 'w'))
        time.sleep(2.1)

def bars(elig, outdir):
    os.makedirs(outdir, exist_ok=True)
    for u in json.load(open(elig)):
        p = os.path.join(outdir, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        rows, before = {}, WALL
        while before > START:
            d = get(GT.format(u['pool'], 'minute', 5, before, 1000))
            lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
            time.sleep(2.1)
            if not lst:
                break
            for r in lst:
                rows[r[0]] = r
            oldest = min(r[0] for r in lst)
            if oldest >= before:
                break
            before = oldest
        json.dump(sorted(rows.values()), open(p, 'w'))

if __name__ == '__main__':
    cmd = sys.argv[1]
    {'universe': universe, 'daily': daily, 'bars': bars}[cmd](*sys.argv[2:])
