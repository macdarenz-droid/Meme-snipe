#!/usr/bin/env python3
"""Checks the fill model in analyze.py against real trades: predict each trade's token output from the pool state
just before it (the previous trade's after-state for the curve, the event's own before-reserves for PumpSwap) and
compare with the tokens the trade actually got. Also reports how often the stream order within a slot is consistent."""
import os, sys, statistics
os.environ.setdefault('ADVERSE', '0')
sys.argv = [sys.argv[0], 'dev']
import analyze as A
trades, created, pool_new = A.load()
errs = {'c': [], 'a': []}; prev = {}; chain_ok = chain_bad = 0
for t in trades:
    slot, seq, bt, key, venue, user, buy, us, tok, S, T, fee, creator = t
    if venue == 'c':
        if S <= 0 or T <= 0: continue
        if key in prev:
            ps, pS, pT = prev[key]
            if buy and tok > 0:
                pred = A.buy_fill(('c', pS, pT, fee), us)
                errs['c'].append(pred / tok - 1)
            # chain consistency: previous after-state + this trade's change == this after-state
            exp = pS + int(round(us / (1 + A.CURVE_FEE))) if buy else pS - int(round(us / (1 - A.CURVE_FEE)))
            if abs(exp - S) <= max(2, S * 1e-6): chain_ok += 1
            else: chain_bad += 1
        prev[key] = (slot, S, T)
# PumpSwap: the event carries the before-reserves (raw fields 9 and 10)
import gzip, glob, json
pmap = json.load(open(os.path.join(A.OUT, 'pool_map.json')))
for f in sorted(glob.glob(os.path.join(A.RAW, 'trades_*.jsonl.gz'))):
    try:
        for line in gzip.open(f, 'rt'):
            try: r = json.loads(line)
            except Exception: continue
            if r[0] != 'A' or r[6] != 1 or r[14] > A.X1 or pmap.get(r[4], [0, 0])[1] != A.WSOL: continue
            q_user, base_out, qb, bb = int(r[7]), int(r[8]), int(r[9]), int(r[10])
            fee = (int(r[11]) + int(r[12]) + int(r[13] or 0)) / 1e4
            if base_out <= 0 or qb <= 0: continue
            errs['a'].append(A.buy_fill(('a', qb, bb, fee), q_user) / base_out - 1)
    except (EOFError, OSError): pass
for k, e in errs.items():
    if e:
        e = sorted(e)
        print(k, 'n', len(e), 'median err %.4f%%' % (100 * statistics.median(e)), 'p5 %.3f%% p95 %.3f%%' % (100 * e[len(e) // 20], 100 * e[-len(e) // 20]))
print('curve chain consistent', chain_ok, 'inconsistent', chain_bad, 'share %.1f%%' % (100 * chain_bad / max(1, chain_ok + chain_bad)))
# After calibration: predict each PumpSwap trade from the previous trade's after-state in the same pool (as the simulator does)
import collections
pmap = json.load(open(os.path.join(A.OUT, 'pool_map.json')))
prevs = {}; e2 = {'buy': [], 'sell': []}
for t in trades:
    slot, seq, bt, key, venue, user, buy, us, tok, S, T, fee, creator = t
    if venue != 'a' or pmap.get(key, [0, 0])[1] != A.WSOL: continue
    if key in prevs and tok > 0 and us >= 1_000_000 and S > 0 and T > 0:
        st = prevs[key]
        if buy: e2['buy'].append(A.buy_fill(st, us) / tok - 1)
        else: e2['sell'].append(A.sell_fill(st, tok) / us - 1)
    prevs[key] = ('a', S, T, fee)
for k, e in e2.items():
    e = sorted(e)
    if e: print('calibrated AMM', k, 'n', len(e), 'median err %.3f%%' % (100 * statistics.median(e)), 'p10 %.2f%% p90 %.2f%%' % (100 * e[len(e) // 10], 100 * e[-len(e) // 10]), 'share within 1%%: %.1f%%' % (100 * sum(abs(x) < 0.01 for x in e) / len(e)))
