"""Markdown tables for RESULTS.md from derived/results_<window>.json.

  python3 -I report.py discovery|validation
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
LS = (2, 10, 40, 120, 480)
EXITS = ('T1', 'T5', 'T15', 'T60', 'ST2', 'ST10', 'MG2', 'MG10')

def pct(x):
    return '%+.1f%%' % (100 * x)

def main(w):
    r = json.load(open(os.path.join(HERE, 'derived', 'results_%s.json' % w)))
    m = r['meta']
    print('Launches %d; graduated within 60 min: %d (%.2f%%); pool traded within 60 min: %d; mayhem-mode: %d; '
          'real-reserve chain breaks: %d coins; undecodable: %d; unpriced values: %d.' % (
              m['launches'], m['graduated_60m'], 100 * m['graduation_rate_60m'], m['migrated_pool_60m'],
              m['mayhem_coins'], m['chain_breaks_coins'], m['undecodable_coins'], m['unpriced_values']))
    print('L in seconds (mean): ' + ', '.join('%s slots = %.2f s' % (k, v) for k, v in m['sec'].items()) +
          '. No entry (curve already complete): ' + ', '.join('L%s: %d' % kv for kv in m['no_entry'].items()) + '.')
    print()
    print('| pair | n | days | mean | 95% CI (day bootstrap) | median | win | >= 2x | mean capped 20x | stress mean | stress CI |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for L in LS:
        for e in EXITS:
            k = 'L%d_%s' % (L, e)
            b, s = r['pairs'][k]['base'], r['pairs'][k]['stress']
            print('| %s | %d | %d | %s | [%s, %s] | %s | %.1f%% | %.1f%% | %s | %s | [%s, %s] |' % (
                k, b['n'], b['days'], pct(b['mean']), pct(b['ci95'][0]), pct(b['ci95'][1]), pct(b['median']),
                100 * b['win'], 100 * b['ge2x'], pct(b['mean_cap20x']), pct(s['mean']), pct(s['ci95'][0]),
                pct(s['ci95'][1])))
    if 'filters' in r:
        print()
        print('Primary pair %s. Verdict: **%s**.' % (r['primary'], r['verdict']))
        print()
        print('| filter | n | mean | 95% CI | one-sided p | Holm p | stress mean | passes |')
        print('|---|---|---|---|---|---|---|---|')
        for f, v in r['filters'].items():
            b, s = v['base'], v['stress']
            if not b.get('n'):
                print('| %s | 0 | | | | | | no |' % f); continue
            print('| %s | %d | %s | [%s, %s] | %.4f | %.4f | %s | %s |' % (
                f, b['n'], pct(b['mean']), pct(b['ci95'][0]), pct(b['ci95'][1]), b['p_le0'], v['holm_p'],
                pct(s['mean']), 'yes' if v['passes'] else 'no'))

if __name__ == '__main__':
    main(sys.argv[1])
