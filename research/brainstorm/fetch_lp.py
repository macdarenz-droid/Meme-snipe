"""LP supply (offset 203) and on-chain cashback byte for each graduate pool in the exploration window, via public RPC."""
import json, sys, base64, struct, time, urllib.request, datetime, os
RPC = 'https://api.mainnet-beta.solana.com'
src, out = sys.argv[1], sys.argv[2]
VAL_START = int(datetime.datetime(2026, 8, 21, tzinfo=datetime.UTC).timestamp()) * 1000
def rpc(method, params):
    for i in range(6):
        try:
            req = urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), headers={'content-type': 'application/json'})
            r = json.load(urllib.request.urlopen(req, timeout=30))
            if 'error' in r: raise Exception(r['error'])
            return r['result']
        except Exception as e:
            print('retry', e, file=sys.stderr); time.sleep(3 + 5 * i)
    raise SystemExit('rpc failed')
done = json.load(open(out)) if os.path.exists(out) else {}
pools = sorted({r['pump_swap_pool'] for r in map(json.loads, open(src)) if r['created_timestamp'] < VAL_START and r.get('pump_swap_pool')} - set(done))
print('to fetch', len(pools), flush=True)
for i in range(0, len(pools), 100):
    chunk = pools[i:i + 100]
    for p, acc in zip(chunk, rpc('getMultipleAccounts', [chunk, {'encoding': 'base64', 'dataSlice': {'offset': 0, 'length': 261}}])['value']):
        if acc is None: done[p] = None; continue
        d = base64.b64decode(acc['data'][0])
        done[p] = {'lp': struct.unpack_from('<Q', d, 203)[0], 'cb': d[244] if len(d) > 244 else None}
    if i % 2000 == 0:
        json.dump(done, open(out, 'w')); print(i, flush=True)
    time.sleep(0.6)
json.dump(done, open(out, 'w')); print('LP_DONE', len(done))
