"""Exactness checks for thinned pools (review of amendment 3), from cached responses only (no new calls).

  LP_SCRATCH=... python3 -I check_pools.py
For each pool in the analysed sample: (a) slots between the pool's first successful signature and its first
decoded swap; whether every slot up to first swap + 10 was fetched; (b) for every time-exit checkpoint, whether
the last pool signature at or before it is a swap the replay holds (else the replay uses an earlier state).
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fetch, heli, analyze
calls0 = heli.credits()['calls']
order = json.load(open(os.path.join(fetch.DERIVED, 'fetch_order.json')))
pre = set(order[:json.load(open(os.path.join(fetch.DERIVED, 'fetch_report.json')))['prefix_complete']])
sl = json.load(open(os.path.join(fetch.DERIVED, 'slot_len.json')))['sec_per_slot_by_day_start']
out = []
for sig in order:
    if sig not in pre:
        continue
    rec = json.load(open(os.path.join(fetch.EV, sig + '.json')))
    if not rec['pool']:
        continue
    L = rec['launch']
    prow = heli.pool_sigs(rec['pool'], rec['migrate'][3] - 5, L['time'] + fetch.HORIZON)
    prow = [x for x in prow if x['err'] is None and x['slot'] >= rec['migrate'][0]]
    fetched = {x['slot'] for x in fetch.thin(prow, L)}
    swap_slots = {s[0] for s in rec['swaps']}
    first = min(swap_slots) if swap_slots else None
    gap = [s for s in {x['slot'] for x in prow} if first is not None and s <= first + 10 and s not in fetched]
    sec = sl[str(L['time'] // 86400 * 86400)]
    miss = 0; tot = 0
    for Lg in (2, 10, 40, 120, 480):
        for h in (60, 300, 900, 3600):
            t = L['time'] + Lg * sec + h
            b = [x['slot'] for x in prow if x['blockTime'] <= t]
            if b:
                tot += 1; miss += b[-1] not in swap_slots
    out.append({'sig': sig[:12], 'thinned': rec.get('pool_thinned'), 'first_sig_slot': prow[0]['slot'] if prow else None,
                'first_swap_slot': first, 'unfetched_slots_to_first_plus_10': len(gap),
                'checkpoints': tot, 'checkpoint_not_swap': miss, 'swaps_held': len(rec['swaps']), 'ok_sigs': len(prow)})
for o in out:
    print(o)
assert heli.credits()['calls'] == calls0, 'a call left the cache'
print('no new calls')
