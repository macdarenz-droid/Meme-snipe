"""Sensitivity of the validation primary pair to the pool replay (review of amendment 3).

  LP_SCRATCH=... python3 -I sensitivity.py
Each launch whose curve completed (pool phase) gets, instead of its primary-pair return, the BEST return it has
over all 40 pairs: an upper bound on any error in the thinned pool replay. Non-pool launches are unchanged.
"""
import json, os, statistics, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze as A
prim = json.load(open(os.path.join(A.DERIVED, 'primary.json')))['primary']
Lp, Ep = int(prim.split('_')[0][1:]), prim.split('_', 1)[1]
slotlen = A.slot_len_fn()
out = {}
for w in ('discovery', 'validation'):
    coins, _ = A.load_window(w)
    rows = []
    for c in coins:
        en = A.entry(c, Lp, slotlen)
        if en is None:
            continue
        r = A.ret(A.exits(c, en)[Ep], False)
        if c.complete is not None:
            best = r
            for L in A.LS:
                e2 = A.entry(c, L, slotlen)
                if e2:
                    best = max(best, max(A.ret(v, False) for v in A.exits(c, e2).values()))
            r = best
        rows.append((c.L['time'] // 86400, r))
    out[w] = A.stats(rows)
    print(w, prim, 'pool coins at their best pair: mean %.4f CI %s' % (out[w]['mean'], out[w]['ci95']))
json.dump(out, open(os.path.join(A.DERIVED, 'sensitivity.json'), 'w'), indent=1)
