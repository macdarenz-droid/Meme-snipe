"""Liquidation probe (H3) GeckoTerminal downloads (PREREG.md F1-F3). Keyless, 7-second pace, back-off on 429.
No pump.fun request. Downloads go to <outdir>, outside the repo.

  python3 -I fetch.py daily <outdir>          # daily bars for the 481 deep-pool pools (F1), then run
                                              # deep-pool probe.py eligible on <outdir>/daily
  python3 -I fetch.py bars_ps <eligible_full.json> <outdir>   # 5-minute bars, U-PS (best group A or B)
  python3 -I fetch.py bars_ray <outdir>       # 5-minute bars, U-RAY (Raydium AMM v4 and CPMM)
  python3 -I fetch.py sha <outdir>            # SHA-256 of every bar file
"""
import hashlib, json, os, ssl, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
WALL = 1789999200            # 2026-09-21T14:00:00Z
START = 1784419200           # 2026-07-19T00:00:00Z
DEC_START = 1784678400       # 2026-07-22T00:00:00Z
DAY = 86400
WSOL = 'So11111111111111111111111111111111111111112'
GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{}/ohlcv/{}?aggregate={}&before_timestamp={}&limit={}&currency=token'
PACE = 7.0
RAY_VENUES = ('Raydium AMM v4', 'Raydium CPMM')

def ctx():
    for f in (os.environ.get('SSL_CERT_FILE'), '/root/.ccr/ca-bundle.crt'):
        if f and os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()

CTX = ctx()
_last = [0.0]

def get(url):
    """JSON body; None on 404. One request per PACE seconds; backs off on 429 and network errors."""
    for attempt in range(10):
        w = _last[0] + PACE - time.time()
        if w > 0:
            time.sleep(w)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(30 * (attempt + 1) if e.code == 429 else 10 * (attempt + 1))
        except Exception:
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('failed: ' + url)

def daily(outdir):
    d = os.path.join(outdir, 'daily')
    os.makedirs(d, exist_ok=True)
    for u in json.load(open(os.path.join(ROOT, 'research/deep-pool-probe/universe.json'))):
        p = os.path.join(d, u['pool'] + '.json')
        if not os.path.exists(p):
            json.dump(get(GT.format(u['pool'], 'day', 1, WALL, 120)) or {}, open(p, 'w'))

def _series(pool, start, end, extra=''):
    rows, before = {}, end
    while before > start:
        dd = get(GT.format(pool, 'minute', 5, before, 1000) + extra) or {}
        lst = (dd.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
        if not lst:
            break
        for r in lst:
            rows[r[0]] = r
        oldest = min(r[0] for r in lst)
        if oldest >= before:
            break
        before = oldest
    return sorted(rows.values())

def bars_ps(elig, outdir):
    d = os.path.join(outdir, 'bars')
    os.makedirs(d, exist_ok=True)
    for u in sorted((u for u in json.load(open(elig)) if u['best'] in 'AB'), key=lambda u: (u['best'], u['pool'])):
        p = os.path.join(d, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        days = sorted(int(x) for x in u['days'])
        # 1 hour of look-back before the first eligible day covers M (previous close) and m60
        rows = _series(u['pool'], max(START, days[0] - 3600), min(WALL, days[-1] + DAY))
        json.dump(rows, open(p, 'w'))

def ray_pools():
    return [u for u in json.load(open(os.path.join(ROOT, 'research/cheap-venue-probe/universe.json')))['pools']
            if u['venue'] in RAY_VENUES]

def bars_ray(outdir):
    d = os.path.join(outdir, 'bars')
    os.makedirs(d, exist_ok=True)
    for u in ray_pools():
        p = os.path.join(d, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        side = 'quote' if u['base'] == WSOL else 'base'
        json.dump(_series(u['pool'], DEC_START - 3600, WALL, '&token=' + side), open(p, 'w'))

def sha(outdir):
    d = os.path.join(outdir, 'bars')
    out = {f[:-5]: hashlib.sha256(open(os.path.join(d, f), 'rb').read()).hexdigest() for f in sorted(os.listdir(d))}
    json.dump(out, open(os.path.join(HERE, 'bars_sha256.json'), 'w'), indent=0)
    print(len(out), 'files')

if __name__ == '__main__':
    {'daily': daily, 'bars_ps': bars_ps, 'bars_ray': bars_ray, 'sha': sha}[sys.argv[1]](*sys.argv[2:])
