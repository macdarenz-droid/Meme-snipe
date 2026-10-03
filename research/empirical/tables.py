#!/usr/bin/env python3
"""Render markdown tables from results/*.json (used to build ../empirical.md)."""
import json, os, sys
D = os.path.dirname(os.path.abspath(__file__))
P = lambda x, d=1: '–' if x is None else f'{100 * x:+.{d}f}%'
F = lambda x, d=2: '–' if x is None else f'{x:.{d}f}'


def ci(c):
    return '–' if not c or c[0] is None else f'[{P(c[0])}, {P(c[1])}]'


def main(fn='results/backfill_results.json'):
    r = json.load(open(os.path.join(D, fn)))
    print('### Return distribution from migration pool price (standard graduations)\n')
    print('| horizon | n | p10 | p25 | median [95% CI] | p75 | p90 | mean | share up | share <= -80% | share >= +100% |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for k, v in r['returns_from_p0'].items():
        lab = {'now': '+24-31h (at collection, Jupiter price)'}.get(k, '+' + k)
        print(f"| {lab} | {v['n']} | {P(v['p10'])} | {P(v['p25'])} | {P(v['median'])} {ci(v['median_ci'])} | {P(v['p75'])} | {P(v['p90'])} | {P(v['mean'])} | {P(v['share_up'], 0)} | {P(v['share_le_-80'], 0)} | {P(v['share_ge_+100'], 0)} |")
    print('\n### Excursions from migration pool price\n')
    print('| metric | n | p10 | p25 | median | p75 | p90 |')
    print('|---|---|---|---|---|---|---|')
    for k, v in r['excursions'].items():
        print(f"| {k} | {v['n']} | {P(v['p10'])} | {P(v['p25'])} | {P(v['median'])} | {P(v['p75'])} | {P(v['p90'])} |")
    print('\n### Signals (entry at mig+5m, outcome = price change to +1h; yes vs no)\n')
    print('| signal | n yes / no | median 1h yes | median 1h no | diff of medians [95% CI] | mean 1h yes | mean 1h no | diff of means [95% CI] | dead (<= -80%) at collection yes / no | yes-group mean net (base costs) [95% CI] |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for k, v in r['signals'].items():
        print(f"| {k} | {v['n_yes']} / {v['n_no']} | {P(v['median_1h_yes'])} | {P(v['median_1h_no'])} | {ci(v['diff_median_1h_ci'])} | {P(v['mean_1h_yes'])} | {P(v['mean_1h_no'])} | {ci(v['diff_mean_1h_ci'])} | {P(v['rug_now_yes'], 0)} / {P(v['rug_now_no'], 0)} | {P(v['yes_mean_net_base_hold1h'])} {ci(v['yes_mean_net_base_ci'])} |")
    print('\n### Rule grid (net of base costs, $2 trade)\n')
    print('| entry | filter | exit | n | trades/day | mean net [95% CI] | median net | win rate | avg win | avg loss | worst | low-cost mean | conservative mean | wick-TP mean | 1st half / 2nd half mean |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for g in sorted(r['rule_grid'], key=lambda g: -(g.get('mean_net') if g.get('mean_net') is not None else -9)):
        if not g.get('n'):
            print(f"| {g['entry']} | {g['filter']} | {g['exit']} | 0 | – | – | – | – | – | – | – | – | – | – | – |"); continue
        print(f"| {g['entry']} | {g['filter']} | {g['exit']} | {g['n']} | {g['per_day']:.0f} | {P(g['mean_net'])} {ci(g['ci95'])} | {P(g['median_net'])} | {P(g['win_rate'], 0)} | {P(g['avg_win'])} | {P(g['avg_loss'])} | {P(g['worst'])} | {P(g.get('mean_net_low'))} | {P(g.get('mean_net_conservative'))} | {P(g.get('mean_net_base_wickTP'))} | {P(g.get('mean_net_first_half'))} / {P(g.get('mean_net_second_half'))} |")


if __name__ == '__main__':
    main(*(sys.argv[1:] or []))
