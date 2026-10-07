"""GeckoTerminal fetchers for the absorption probe (keyless, paced 6.5 s, backs off on 429). Pre-wall data only.
Raw responses go to the scratch directory (AB_SCRATCH), never the repo.

  python3 -I gt.py daily               # daily bars: deep-pool eligible pools, then the lottery random sample
  python3 -I gt.py minute <pools.json> # 1-minute bars over each pool's listed day spans
  python3 -I gt.py hourly <pools.json> # hourly bars 2026-07-21 to the wall
"""
import json, os, ssl, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get('AB_SCRATCH') or sys.exit('set AB_SCRATCH (outside the repo)')
WALL = 1789999200            # 2026-09-21T14:00:00Z
START = 1784678400           # 2026-07-22T00:00:00Z
GTU = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{}/ohlcv/{}?aggregate=1&before_timestamp={}&limit={}&currency=token'
PACE = 6.5
_last = [0.0]

def ctx():
    for f in (os.environ.get('SSL_CERT_FILE'), '/root/.ccr/ca-bundle.crt'):
        if f and os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()
CTX = ctx()

def get(url):
    """JSON body; None on 404. Paced; backs off on 429 and network errors."""
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
            time.sleep(20 * (attempt + 1))
        except Exception:
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('failed: ' + url)

def ohlcv(d):
    return ((d or {}).get('data') or {}).get('attributes', {}).get('ohlcv_list') or []

def pools_all():
    deep = json.load(open(os.path.join(HERE, '..', 'deep-pool-probe', 'eligible.json')))
    lot = json.load(open(os.path.join(HERE, '..', 'lottery-probe', 'sample.json')))
    out = [{'pool': u['pool'], 'src': 'survivor-list'} for u in deep]
    seen = {u['pool'] for u in out}
    out += [{'pool': u['pool'], 'src': 'random-sample', 'mint': u['mint']} for u in lot if u['pool'] not in seen]
    return out

def daily():
    d = os.path.join(SCRATCH, 'gt_daily'); os.makedirs(d, exist_ok=True)
    for u in pools_all():
        p = os.path.join(d, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        rows = ohlcv(get(GTU.format(u['pool'], 'day', WALL, 120)))
        json.dump(rows, open(p + '.tmp', 'w')); os.replace(p + '.tmp', p)

def span_fetch(pool, kind, start, end, outdir, tag=''):
    p = os.path.join(outdir, pool + tag + '.json')
    if os.path.exists(p):
        return
    rows, before = {}, end
    while before > start:
        lst = ohlcv(get(GTU.format(pool, kind, before, 1000)))
        if not lst:
            break
        for r in lst:
            rows[r[0]] = r
        oldest = min(r[0] for r in lst)
        if oldest >= before:
            break
        before = oldest
    rows = [r for r in rows.values() if start <= r[0] and r[0] + (60 if kind == 'minute' else 3600) <= WALL]
    json.dump(sorted(rows), open(p + '.tmp', 'w')); os.replace(p + '.tmp', p)
    print(pool, kind, len(rows), flush=True)

def minute(spec):
    """spec: [{pool, start, end}] (unix seconds); one file per pool."""
    d = os.path.join(SCRATCH, 'gt_minute'); os.makedirs(d, exist_ok=True)
    for u in json.load(open(spec)):
        span_fetch(u['pool'], 'minute', u['start'], min(u['end'], WALL), d, '_%d' % u['start'])

def hourly(spec):
    d = os.path.join(SCRATCH, 'gt_hourly'); os.makedirs(d, exist_ok=True)
    for u in json.load(open(spec)):
        span_fetch(u['pool'], 'hour', START - 86400, WALL, d)

if __name__ == '__main__':
    {'daily': daily, 'minute': minute, 'hourly': hourly}[sys.argv[1]](*sys.argv[2:])
