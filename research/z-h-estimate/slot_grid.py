"""Keyless slot-time and skip-rate grid for 2026-07-19 .. 2026-09-23 (public Solana RPC only, no key, no credits).

Limiter: one request every 2 s (half the stricter of the documented 40 per 10 s per method, solana.com/docs/
references/clusters "Mainnet rate limits", and the 10 per 10 s measured in response headers, historical-data.md
line 33). A 429 honours Retry-After (else 10 s); 3 failures in a row stop the run.
For each grid slot S: the block time of the first produced slot at or after S (getBlocks over [S, S+SKIPWIN] gives
the produced slots, so the skip rate of that window comes for free). Output JSON on stdout.
Usage: slot_grid.py START_SLOT END_SLOT STEP SKIPWIN
"""
import json, sys, time, urllib.request, urllib.error

URL = 'https://api.mainnet-beta.solana.com'
GAP = 2.0
last = [0.0]; fails = [0]; calls = [0]

def rpc(method, params):
    while True:
        w = last[0] + GAP - time.time()
        if w > 0: time.sleep(w)
        last[0] = time.time(); calls[0] += 1
        req = urllib.request.Request(URL, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
                                     {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
            fails[0] = 0
            if 'error' in d: raise RuntimeError(d['error'])
            return d['result']
        except urllib.error.HTTPError as e:
            fails[0] += 1
            if fails[0] >= 3: raise SystemExit(f'stopped after 3 failures: HTTP {e.code}')
            time.sleep(float(e.headers.get('Retry-After') or 10))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            fails[0] += 1
            if fails[0] >= 3: raise SystemExit(f'stopped after 3 failures: {e}')
            time.sleep(10)

start, end, step, win = (int(x) for x in sys.argv[1:5])
rows = []
for s in range(start, end + 1, step):
    produced = rpc('getBlocks', [s, s + win - 1, {'commitment': 'finalized'}])
    if not produced:
        rows.append({'slot': s, 'produced': 0}); continue
    t = rpc('getBlockTime', [produced[0]])
    rows.append({'slot': s, 'first_produced': produced[0], 'time': t, 'win': win, 'produced': len(produced)})
    print(json.dumps(rows[-1]), file=sys.stderr, flush=True)
json.dump({'start': start, 'end': end, 'step': step, 'win': win, 'calls': calls[0], 'rows': rows}, sys.stdout, indent=0)
