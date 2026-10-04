import json, struct, sys
from mig import *
from solders.pubkey import Pubkey

rows = json.load(open('mig_rows.json'))
std = [r for r in rows if r['boost'] and r['q'].startswith('1111') and 84e9 < r['sa'] < 86e9]
for r in std[int(sys.argv[1]):int(sys.argv[2])]:
    res, evs = events(r['sig'])
    pool = None
    for d, b in evs:
        if d and d[1] == 'InitBoostEvent':
            pool = str(Pubkey.from_bytes(b[8 + 8 + 64:8 + 8 + 96]))
    mt = r['t']
    sigs = []
    before = None
    for _ in range(4):
        p = {"limit": 1000}
        if before:
            p["before"] = before
        page = rpc("getSignaturesForAddress", [pool, p])['result']
        if not page:
            break
        sigs += page
        before = page[-1]['signature']
        if page[-1].get('blockTime') and page[-1]['blockTime'] < mt - 5:
            break
    win = [s for s in sigs if s.get('blockTime') and mt - 2 <= s['blockTime'] <= mt + 900 and not s.get('err')]
    win.sort(key=lambda x: x['blockTime'])
    print('window txs',len(win),flush=True)
    win=win[:150]
    burns = []
    for sg in win:
        rs, ev = events(sg['signature'])
        if not ev:
            continue
        for d, b in ev:
            if d and d[1] == 'BoostBuyAndBurnEvent':
                o = 8 + 8 + 32 * 4
                req, used, burned = struct.unpack('<3Q', b[o:o + 24])
                o += 24 + 16 + 16
                rem = struct.unpack('<Q', b[o:o + 8])[0]
                burns.append((rs['blockTime'], used / 1e9, burned / 1e6, rem / 1e9))
    burns.sort()
    print('pool', pool[:8], 'tx in window', len(win), 'burns', len(burns),
          'first dt', burns[0][0] - mt if burns else None,
          'last dt', burns[-1][0] - mt if burns else None,
          'sum SOL used', round(sum(x[1] for x in burns), 4),
          'last vault rem', burns[-1][3] if burns else None, flush=True)
