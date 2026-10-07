"""Counts from the frozen stage-1 table (no returns). python3 -I -B report.py [stage1_table.json]"""
import collections, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DAY = 86400

def main(path=os.path.join(HERE, 'stage1_table.json')):
    t = json.load(open(path))
    bars, sales = t['bars'], t['sales']
    C = collections.Counter
    out = {'bars_processed': len(bars), 'pool_tx_in_bars': sum(b['n_tx'] for b in bars),
           'bars_by_venue_note': C(b.get('note') for b in bars),
           'large_sales': len(sales), 'groups': C(s.get('group') for s in sales),
           'groups_by_venue': C(f"{s['venue']}|{s.get('group')}" for s in sales),
           'drop_bins_full_exits': C(('3-5%' if s['drop'] < .05 else '5-10%' if s['drop'] < .10 else '>=10%')
                                     for s in sales if s.get('class') == 'full exit'),
           'k_of_full_exits': C(s.get('k') for s in sales if s.get('class') == 'full exit'),
           'events': [{k: s.get(k) for k in ('sig', 'pool', 'mint', 't', 'drop', 'k', 'seller', 'venue', 'excl')}
                      for s in sales if s.get('group') == 'H3 event'],
           'k_ge2_any_group': C(s.get('group') for s in sales if (s.get('k') or 0) >= 2),
           'event_days': len({s['t'] - s['t'] % DAY for s in sales if s.get('group') == 'H3 event'}),
           'hold_rule': t['hold_rule'], 'hold_rule_note': t.get('hold_rule_note'),
           'hold_checks_ok': sum(1 for h in t['hold_checks'] if h.get('ok')), 'hold_checks': len(t['hold_checks']),
           'early': t['early'], 'stop': t['stop'],
           'gate': {k: v for k, v in t['gate'].items() if k != 'controls'},
           'controls_per_event': {k: len(v) for k, v in t['gate']['controls'].items()},
           'credits': t['credits']}
    print(json.dumps(out, indent=1, default=str))

if __name__ == '__main__':
    main(*sys.argv[1:])
