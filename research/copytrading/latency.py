#!/usr/bin/env python3
"""Detection lag of the free path: time the collector received each trade (local clock, NTP-synced container) minus
the block time (whole seconds, so each value carries up to 1 s of rounding; we report receipt minus block_time - 0.5 s
as the central estimate). Commitment: confirmed. Usage: python3 latency.py <startISO> <endISO>"""
import sys, os, gzip, glob, json, statistics
import analyze as A
a, b = A.ts(sys.argv[1]), A.ts(sys.argv[2]); lags = []
for f in sorted(glob.glob(os.path.join(A.RAW, 'trades_*.jsonl.gz'))):
    try:
        for line in gzip.open(f, 'rt'):
            try: r = json.loads(line)
            except Exception: continue
            if r[0] not in ('A', 'P'): continue
            bt = r[14] if r[0] == 'A' else r[13]
            if a <= bt < b: lags.append(r[2] / 1000 - bt - 0.5)
    except (EOFError, OSError): pass
lags.sort(); q = lambda p: lags[int(p * (len(lags) - 1))]
res = {'window': sys.argv[1:3], 'n': len(lags), 'p10_s': q(.1), 'median_s': q(.5), 'p90_s': q(.9), 'p99_s': q(.99)}
print(json.dumps(res)); json.dump(res, open(os.path.join(A.OUT, 'latency.json'), 'w'), indent=1)
