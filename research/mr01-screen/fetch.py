"""MR-01 1-minute screen data fetch (see PREREG.md). Pre-wall data only, GeckoTerminal keyless.

  python3 -I fetch.py daily <eligible.json> <dailydir>              # daily OHLCV for the group-A pools
  python3 -I fetch.py minute <eligible.json> <dailydir> <minutedir> # 1-minute OHLCV over each pool's eligible span
"""
import json, os, ssl, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from screen import WALL, DAY, eligible_days

GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{}/ohlcv/{}?aggregate=1&before_timestamp={}&limit={}&currency=token'
PACE = 6.5

def ctx():
    for f in (os.environ.get('SSL_CERT_FILE'), '/root/.ccr/ca-bundle.crt'):
        if f and os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()

CTX = ctx()

def get(url):
    """JSON body; None when the pool is unknown (404). Backs off on 429 and network errors."""
    for attempt in range(8):
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

def pools_a(elig):
    return [u for u in json.load(open(elig)) if u['best'] == 'A']

def daily(elig, ddir):
    os.makedirs(ddir, exist_ok=True)
    for u in pools_a(elig):
        p = os.path.join(ddir, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        d = get(GT.format(u['pool'], 'day', WALL, 200))
        json.dump(d or {}, open(p, 'w'))
        time.sleep(PACE)

def minute(elig, ddir, mdir):
    """1-minute bars from 7 h before the first eligible day to 2 h after the last one (capped at the wall)."""
    os.makedirs(mdir, exist_ok=True)
    for u in pools_a(elig):
        p = os.path.join(mdir, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        days = sorted(eligible_days(os.path.join(ddir, u['pool'] + '.json')))
        if not days:
            json.dump([], open(p, 'w'))
            continue
        start = days[0] - 7 * 3600
        end = min(WALL, days[-1] + DAY + 2 * 3600)
        rows, before = {}, end
        while before > start:
            d = get(GT.format(u['pool'], 'minute', before, 1000)) or {}
            lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
            time.sleep(PACE)
            if not lst:
                break
            for r in lst:
                rows[r[0]] = r
            oldest = min(r[0] for r in lst)
            if oldest >= before:
                break
            before = oldest
        json.dump(sorted(rows.values()), open(p + '.tmp', 'w'))
        os.replace(p + '.tmp', p)
        print(u['symbol'], len(rows), 'minutes', flush=True)

if __name__ == '__main__':
    cmd = sys.argv[1]
    {'daily': daily, 'minute': minute}[cmd](*sys.argv[2:])
