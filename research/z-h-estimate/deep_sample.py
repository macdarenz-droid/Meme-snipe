"""Keyless sample: successful and failed transaction counts per deep pool for one clean UTC day.

Public Solana RPC only (no key, no credits). Limits: the official docs give 40 requests per 10 s per RPC method
per IP (solana.com/docs/references/clusters, "Mainnet rate limits"); the endpoint's own headers were measured
at 10 per 10 s for getSignaturesForAddress (docs/research/historical-data.md line 33). The stricter one is used
and halved: at most 1 request every 2 s, one at a time. A 429 honours Retry-After (else 10 s); 3 failures in a
row stop the run. Usage: deep_sample.py eligible.json YYYY-MM-DD N_POOLS [OFFSET] > out.json
"""
import json, sys, time, datetime as dt, urllib.request, urllib.error

URL = 'https://api.mainnet-beta.solana.com'
GAP = 2.0
_last = [0.0]; _fails = [0]; calls = [0]

def rpc(method, params):
    while True:
        w = _last[0] + GAP - time.time()
        if w > 0: time.sleep(w)
        _last[0] = time.time(); calls[0] += 1
        req = urllib.request.Request(URL, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
                                     {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
            if 'error' in d:
                raise RuntimeError(d['error'])
            _fails[0] = 0
            return d['result']
        except urllib.error.HTTPError as e:
            _fails[0] += 1
            if _fails[0] >= 3: raise SystemExit(f'stopped after 3 failures: HTTP {e.code}')
            time.sleep(float(e.headers.get('Retry-After') or 10))
        except (urllib.error.URLError, TimeoutError) as e:
            _fails[0] += 1
            if _fails[0] >= 3: raise SystemExit(f'stopped after 3 failures: {e}')
            time.sleep(10)

def block_time(slot):
    for d in range(30):
        try:
            t = rpc('getBlockTime', [slot + d])
            if t is not None: return slot + d, t
        except RuntimeError:
            continue
    raise RuntimeError('no block')

def slot_at(T):
    s, t = block_time(rpc('getSlot', [{'commitment': 'finalized'}]) - 500)
    for _ in range(8):
        s2 = int(s + (T - t) / 0.4)
        s, t = block_time(max(s2, 1))
        if abs(t - T) < 60: break
    return s, t

def anchor_sig(T):
    s, t = slot_at(T)
    for d in range(30):
        try:
            b = rpc('getBlock', [s + d, {'transactionDetails': 'signatures', 'rewards': False,
                                         'maxSupportedTransactionVersion': 1, 'commitment': 'finalized'}])
        except RuntimeError:
            continue
        if b and b.get('signatures'):
            return b['signatures'][-1], s + d, b.get('blockTime')
    raise RuntimeError('no anchor')

def main():
    elig = json.load(open(sys.argv[1])); day = dt.datetime.strptime(sys.argv[2], '%Y-%m-%d').replace(tzinfo=dt.timezone.utc)
    n = int(sys.argv[3]); off = int(sys.argv[4]) if len(sys.argv) > 4 else 0; t0 = int(day.timestamp()); t1 = t0 + 86400
    pools = sorted((p for p in elig if p['best'] == 'A'), key=lambda p: -p['eligible_days'])[off:off + n]
    sig, aslot, atime = anchor_sig(t1)
    out = {'day': sys.argv[2], 'anchor_slot': aslot, 'anchor_time': atime, 'pools': []}
    for p in pools:
        before = sig; ok = err = 0; pages = 0; tmin = None; done = False
        while not done:
            page = rpc('getSignaturesForAddress', [p['pool'], {'before': before, 'limit': 1000, 'commitment': 'finalized'}])
            pages += 1
            if not page: break
            for x in page:
                bt = x.get('blockTime')
                if bt is not None and bt < t0: done = True; break
                if bt is not None and bt >= t1: continue
                if x.get('err') is None: ok += 1
                else: err += 1
                tmin = bt
            before = page[-1]['signature']
            if len(page) < 1000: break
            if pages >= 120: out.setdefault('truncated', []).append(p['pool']); break
        out['pools'].append({'pool': p['pool'], 'symbol': p['symbol'], 'eligible_days': p['eligible_days'],
                             'ok': ok, 'failed': err, 'pages': pages, 'earliest_seen': tmin})
        print(json.dumps(out['pools'][-1]), file=sys.stderr)
    out['calls'] = calls[0]
    json.dump(out, sys.stdout, indent=1)

main()
