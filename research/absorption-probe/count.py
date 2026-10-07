"""Step 1 counts (no returns): writes step1_counts.json and step1_events.csv from the scratch outputs.

  python3 -I count.py <large_t1.json> <large_t2.json> <cands.json> <spans.json> <b_costtest.json>
"""
import csv, json, os, statistics, sys
from collections import Counter
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import events, screen
SPLIT = 1787270400

def bar_high(e):
    """Independent check: highest 1-minute GeckoTerminal high in the minutes after the sale end (within 60 min),
    over the swap-level pre-sale price."""
    b = screen.bars(e['pool']) or {}
    t0 = e['sale_end_t']
    hs = [v[1] for k, v in b.items() if t0 - t0 % 60 + 60 <= k < t0 + 3600]
    return round(max(hs) / e['pre_price'], 4) if hs else None

def run(t1, t2, cands, spans, btest, ledger):
    L1, L2 = json.load(open(t1)), json.load(open(t2))
    C = json.load(open(cands)); S = json.load(open(spans)); BT = json.load(open(btest))
    evs = L1['events'] + L2['events']
    events.overlaps(evs)
    out = {'universe': {'pools_prescreened': len({u['pool'] for u in S}), 'pool_days_prescreened': sum(u['days'] for u in S)}}
    ld = C['large_drop']
    done1, done2 = {tuple(x) for x in L1['done']}, {tuple(x) for x in L2['done']}
    out['bar_candidates'] = {
        'large_drop_total': len(ld), 'tier1_ge15pct': sum(1 for x in ld if x['drop'] >= 0.15),
        'tier2_10to15pct': sum(1 for x in ld if x['drop'] < 0.15),
        'tier1_processed': len(done1), 'tier2_processed_random_sample': len(done2),
        'ordinary_recovery_total': len(C['recovery']),
        'ordinary_recovery_no_drop_prior_2h': sum(1 for x in C['recovery'] if not x.get('drop_in_prior_2h'))}
    out['rejected_tier1'] = dict(Counter(r['why'] for r in L1['rejected']))
    out['rejected_tier2'] = dict(Counter(r['why'] for r in L2['rejected']))
    prev = {}
    for e in sorted(evs, key=lambda e: (e['pool'], e['bar_t'], e['credits'])):
        k = (e['pool'], e['bar_t'])
        e['credits_own'] = e['credits'] - prev.get(k, 0)     # `credits` is cumulative within one bar candidate
        prev[k] = e['credits']
    rows = []
    for e in sorted(evs, key=lambda e: (e['sale_t0'], e['pool'])):
        en = e.get('entry') or {}
        tr = e.get('trigger') or {}
        traded = e['group'] in ('A', 'C') and not e.get('overlap') and en.get('eligible') and en.get('L10', {}).get('complete')
        rows.append({'pool': e['pool'], 'sale_t0': e['sale_t0'], 'period': 'A' if e['sale_t0'] < SPLIT else 'B', 'group': e['group'],
                     'overlap': e.get('overlap'), 'extract_share': round(e['extract_share'], 4), 'extract_sol': round(e['extract_sol'], 2),
                     'n_sells': e['n_sells'], 'pre_qeff_sol': round((e['pre_Q'] + e['pre_V']) / 1e9, 1),
                     'post_sale_over_pre': round(e['post_sale_price'] / e['pre_price'], 4),
                     'trigger': tr.get('reason'), 'secs_after_sale': tr.get('secs_after_sale'), 'groups': tr.get('groups'),
                     'top_share': None if tr.get('top_share') is None else round(tr['top_share'], 3),
                     'eligible_at_decision': en.get('eligible'), 'cost_at_decision': None if not en else round(en['cost_at_trigger'], 5),
                     'fee_bps': en.get('fee_bps'), 'age_h': None if en.get('age_h') is None else round(en['age_h'], 1),
                     'would_trade': bool(traded), 'activity_10min': e['activity_10min'], 'swaps_read': e['swaps_in_window'],
                     'reserve_mismatches': e['reserve_mismatches'], 'credits': e['credits_own'],
                     'price_and_reserve_ok_secs': tr.get('price_recovered_at') if tr.get('reason') != 'trigger' else tr.get('secs_after_sale'),
                     'funding_checks': tr.get('funding_checks'), 'bar_high_1h_over_pre': bar_high(e)})
    with open(os.path.join(HERE, 'step1_events.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    rej = [dict(r, tier=1) for r in L1['rejected']] + [dict(r, tier=2) for r in L2['rejected']]
    with open(os.path.join(HERE, 'step1_rejected.csv'), 'w', newline='') as f:
        keys = ['tier', 'pool', 'bar_t', 'bar_drop', 'why', 'swaps', 'activity_10min', 'credits']
        w = csv.DictWriter(f, fieldnames=keys, extrasaction='ignore'); w.writeheader(); w.writerows(rej)
    g = Counter((r['group'], r['period'], r['would_trade']) for r in rows)
    out['events'] = {f'{k[0]}|period {k[1]}|traded={k[2]}': v for k, v in sorted(g.items(), key=str)}
    out['events_total'] = len(rows)
    out['A_traded'] = sum(1 for r in rows if r['group'] == 'A' and r['would_trade'])
    out['C_traded'] = sum(1 for r in rows if r['group'] == 'C' and r['would_trade'])
    out['pools_with_sales'] = len({r['pool'] for r in rows}); out['pools_with_sales_not_dropped'] = len({r['pool'] for r in rows if r['group'] != 'dropped'})
    out['bar_check'] = {g: [min(r['bar_high_1h_over_pre'] for r in rows if r['group'] == g and r['bar_high_1h_over_pre']),
                            max(r['bar_high_1h_over_pre'] for r in rows if r['group'] == g and r['bar_high_1h_over_pre'])] for g in 'AC'}
    out['C_price_and_reserve_ever_ok'] = sum(1 for r in rows if r['group'] == 'C' and r['price_and_reserve_ok_secs'] is not None)
    out['A_pools'] = dict(Counter(r['pool'][:8] for r in rows if r['group'] == 'A' and r['would_trade']))
    cr_ev = [r['credits'] for r in rows]
    out['credits'] = {'ledger_final': json.load(open(ledger)), 'on_events': sum(cr_ev), 'on_rejected': sum(r['credits'] for r in rej),
                      'per_event_mean': sum(cr_ev) / len(cr_ev), 'per_event_median': statistics.median(cr_ev), 'per_event_max': max(cr_ev),
                      'per_A': [r['credits'] for r in rows if r['group'] == 'A'],
                      'b_confirm_test': [{'ok': x['ev'] is not None, 'credits': (x['ev'] or x['rej'])['credits'],
                                          'why': None if x['ev'] else x['rej']['why']} for x in BT]}
    json.dump(out, open(os.path.join(HERE, 'step1_counts.json'), 'w'), indent=1)
    print(json.dumps({k: out[k] for k in ('events_total', 'A_traded', 'C_traded', 'events', 'A_pools')}, indent=0))

if __name__ == '__main__':
    run(*sys.argv[1:])
