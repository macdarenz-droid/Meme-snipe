"""Hyperliquid data for the short-side probe (see PREREG.md). Pre-wall only.

  python3 -I fetch_hl.py candles <outdir>          # meta + daily candles for every perp
  python3 -I fetch_hl.py funding <outdir> <coins.json>  # hourly funding for [coin, start_ms, end_ms] rows
"""
import json, os, ssl, sys, time, urllib.request

URL = 'https://api.hyperliquid.xyz/info'
WALL_MS = 1789999200 * 1000
START_MS = 1672531200 * 1000          # 2023-01-01
CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt') if os.path.exists('/root/.ccr/ca-bundle.crt') else ssl.create_default_context()

def post(body):
    for i in range(8):
        try:
            req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=40, context=CTX) as r:
                return json.load(r)
        except Exception:
            time.sleep(3 + 3 * i)
    raise RuntimeError('failed ' + json.dumps(body))

def candles(outdir):
    os.makedirs(outdir, exist_ok=True)
    meta = post({'type': 'meta'})
    json.dump(meta, open(os.path.join(outdir, 'meta.json'), 'w'))
    for a in meta['universe']:
        p = os.path.join(outdir, f"c_{a['name']}.json")
        if os.path.exists(p):
            continue
        d = post({'type': 'candleSnapshot', 'req': {'coin': a['name'], 'interval': '1d', 'startTime': START_MS, 'endTime': WALL_MS}})
        json.dump(d, open(p, 'w'))
        time.sleep(0.4)

def funding(outdir, rows):
    os.makedirs(outdir, exist_ok=True)
    for coin, s, e in json.load(open(rows)):
        p = os.path.join(outdir, f'f_{coin}.json')
        if os.path.exists(p):
            continue
        out, t = [], s
        while t < e:
            d = post({'type': 'fundingHistory', 'coin': coin, 'startTime': t, 'endTime': e})
            if not d:
                break
            out += d
            last = max(int(x['time']) for x in d)
            if last <= t:
                break
            t = last + 1
            time.sleep(0.4)
        json.dump(out, open(p, 'w'))

if __name__ == '__main__':
    {'candles': lambda o: candles(o), 'funding': lambda o, r: funding(o, r)}[sys.argv[1]](*sys.argv[2:])
