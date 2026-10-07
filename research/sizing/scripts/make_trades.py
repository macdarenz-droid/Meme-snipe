"""Chronological trade lists (entry and exit times) for R1/R2 on both samples, both lines, $10, for sizing research."""
import json, os, sys
sys.path.insert(0, '/home/user/Meme-snipe/research/runner-probe'); sys.path.insert(0, '/home/user/Meme-snipe/research/lottery-probe')
import runner, lottery
H = 3600; S = sys.argv[1]
def walk(x, stop, arm, trail, mode):
    c, v, lo = x['c'], x['v'], x['lo']; e = 1; p0 = c[e]; peak = p0; armed = False; last = e + runner.MAX_HOLD
    if last > len(c) - 1: return None
    for i in range(e + 1, last + 1):
        if stop is not None and lo[i] <= p0 * (1 - stop) and not armed:
            lvl = p0 * (1 - stop); return i, p0, (lvl if mode == 'opt' else min(lvl, c[i])), 'stop'
        if c[i] > peak and v[i] > 0: peak = c[i]
        if not armed and peak >= arm * p0: armed = True
        if armed and c[i] <= peak * (1 - trail):
            lvl = peak * (1 - trail); return i, p0, (lvl if (mode == 'opt' and v[i] >= runner.VOL_OK) else c[i]), 'trail'
    return last, p0, c[last], 'time'
out = {}
q = runner.SIZES['$10']
for name, sample, hdir in (('exploration', '/home/user/Meme-snipe/research/lottery-probe/sample.json', S + '/lottery/hourly'),
                           ('validation', '/home/user/Meme-snipe/research/runner-probe/validation_sample.json', S + '/runner_val/hourly')):
    cs, counts = runner.coins(sample, hdir)
    for rule, (stop, arm, trail) in (('R1', (0.3, 2.0, 0.4)), ('R2', (0.3, 2.0, 0.6))):
        for mode in ('pess', 'opt'):
            rows = []
            for x in cs:
                if x['ts'][1] + runner.MAX_HOLD * H > runner.WALL - H: continue
                w = walk(x, stop, arm, trail, mode)
                if not w: continue
                i, p0, p1, why = w
                r = runner.trade(x, stop, arm, trail, mode)
                assert abs(r[1] - p1) <= 1e-12 * max(1, abs(p1)), (r, p1)
                rows.append({'mint': x['u']['mint'], 'entry_ts': x['ts'][1] + H, 'exit_ts': x['ts'][i] + H, 'net': lottery.net(p0, max(p1, 1e-18), q)[0], 'why': why})
            rows.sort(key=lambda r: r['entry_ts'])
            out[f'{name}|{rule}|{mode}'] = rows
            print(name, rule, mode, len(rows), 'mean %+.4f' % (sum(r['net'] for r in rows) / len(rows)))
json.dump({'note': 'net = net return per $10 trade in SOL terms (lottery.net, costs included). pess = hourly line (executable approx), opt = optimistic bound (uses unfinished-hour info). Times unix seconds: entry = close of hour 1, exit = close of the exit bar. Exploration = 2026-07-22..08-20 creations; validation = 2026-08-21..09-06 (already run, results public). The execution audit found the opt line overstates the exploration jackpot (real-time trail would have sold ~27x, not ~330x).', 'trades': out}, open(S + '/sizing/trades.json', 'w'))
