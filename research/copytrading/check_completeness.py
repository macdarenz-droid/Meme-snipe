#!/usr/bin/env python3
"""Capture-rate check for the live stream: for random WSOL PumpSwap pools and bonding-curve mints with trades in
[A, B], list successful signatures from public RPC getSignaturesForAddress and count how many the collector saw.
Pools: nearly every successful pool tx is a swap, but missed ones are fetched and checked
for a trade event, so the estimate counts only trade transactions. Usage: python3 check_completeness.py <startISO> <endISO> [n]"""
import sys, os, json, gzip, glob, random, time
import analyze as A
a, b = A.ts(sys.argv[1]), A.ts(sys.argv[2]); N = int(sys.argv[3]) if len(sys.argv) > 3 else 20
pmap = json.load(open(os.path.join(A.OUT, 'pool_map.json')))
seen = {}; keys = {'a': set(), 'c': set()}
for f in sorted(glob.glob(os.path.join(A.RAW, 'trades_*.jsonl.gz'))):
    try:
        for line in gzip.open(f, 'rt'):
            try: r = json.loads(line)
            except Exception: continue
            if r[0] not in ('A', 'P'): continue
            bt = r[14] if r[0] == 'A' else r[13]
            seen.setdefault(r[4], set()).add(r[3])
            if a <= bt < b:
                if r[0] == 'A' and pmap.get(r[4], [0, 0])[1] == A.WSOL: keys['a'].add(r[4])
                elif r[0] == 'P': keys['c'].add(r[4])
    except (EOFError, OSError): pass
rnd = random.Random(7); res = {}
for kind in ('a', 'c'):
    sample = rnd.sample(sorted(keys[kind]), min(N, len(keys[kind])))
    tot = hit = 0; missing = []
    for k in sample:
        before = None; done = False
        while not done:
            r = A.rpc('getSignaturesForAddress', [k, {'limit': 1000, **({'before': before} if before else {})}])
            arr = r.get('result') or []
            if not arr: break
            for s in arr:
                if s['blockTime'] is None or s['blockTime'] >= b: continue
                if s['blockTime'] < a: done = True; break
                if s['err'] is None:
                    tot += 1
                    if s['signature'][:16] in seen.get(k, ()): hit += 1
                    else: missing.append(s['signature'])
            before = arr[-1]['signature']
            if len(arr) < 1000: break
            time.sleep(0.5)
        time.sleep(0.5)
    # classify missed transactions: did they contain a trade event at all? (up to 80 checked per kind)
    chk = rnd.sample(missing, min(80, len(missing))); trade_missed = 0
    for sg in chk:
        t = A.rpc('getTransaction', [sg, {'encoding': 'json', 'maxSupportedTransactionVersion': 0}]).get('result')
        logs = (t or {}).get('meta', {}).get('logMessages') or []
        trade_missed += any(x.startswith(('Program data: Z/RS', 'Program data: Pi83', 'Program data: vdt/')) for x in logs)
        time.sleep(0.6)
    est_missed_trades = trade_missed / len(chk) * len(missing) if chk else 0
    res[kind] = {'keys': len(sample), 'rpc_success_sigs': tot, 'captured': hit, 'missed': len(missing), 'missed_checked': len(chk),
                 'missed_checked_with_trade_event': trade_missed,
                 'trade_tx_capture_rate_est': hit / (hit + est_missed_trades) if hit + est_missed_trades else None}
print(json.dumps(res))
json.dump({'window': sys.argv[1:3], **res}, open(os.path.join(A.OUT, 'completeness.json'), 'w'), indent=1)
