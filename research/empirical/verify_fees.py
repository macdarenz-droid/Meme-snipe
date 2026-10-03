#!/usr/bin/env python3
"""Decode PumpSwap (pAMM) Buy/Sell event logs from recent swaps on given pools to read the actual fee basis points
(LP, protocol, coin-creator). Uses public RPC (few calls). Output: fees_observed.json"""
import json, sys, base64, struct, time, urllib.request, os
RPC = 'https://api.mainnet-beta.solana.com'
def rpc(m, p):
    for i in range(6):
        req = urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(), headers={'content-type': 'application/json'})
        try:
            r = json.load(urllib.request.urlopen(req, timeout=30))
            if 'error' in r and r['error'].get('code') == 429: time.sleep(3 * (i + 1)); continue
            return r
        except Exception as e:
            time.sleep(3 * (i + 1))
    return {}
out = []
for pool in sys.argv[1:]:
    sigs = rpc('getSignaturesForAddress', [pool, {'limit': 8}]).get('result', [])
    for s in sigs[:4]:
        if s.get('err'): continue
        t = rpc('getTransaction', [s['signature'], {'encoding': 'json', 'maxSupportedTransactionVersion': 0}]).get('result')
        time.sleep(0.6)
        if not t: continue
        for l in t['meta']['logMessages']:
            if not l.startswith('Program data: '): continue
            b = base64.b64decode(l[len('Program data: '):])
            if len(b) < 8 + 8 * 14 + 32 * 7 + 16: continue
            v = struct.unpack_from('<q13Q', b, 8)
            off = 8 + 8 * 14 + 32 * 7
            cbps, cfee = struct.unpack_from('<2Q', b, off)
            # buy: v[8]=lp_fee_bps v[10]=protocol_fee_bps ; sell layout has same positions for these fields
            out.append({'pool': pool, 'sig': s['signature'], 'lp_fee_bps': v[8], 'protocol_fee_bps': v[10], 'creator_fee_bps': cbps,
                        'pool_quote_reserve_sol': v[6] / 1e9})
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fees_observed.json'), 'w'), indent=1)
print(json.dumps(out, indent=0))
