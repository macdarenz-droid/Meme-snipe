"""Exits and returns (run only after PREREG.md is pushed). Frozen R1, hourly-close version: stop -30% (only before
arming), arm at 2x, trail 40% under the peak hourly close, 14-day maximum. Decisions on GeckoTerminal hourly bars
(SOL per token); every exit is filled against the pool's real reserves at the first swap after the deciding bar's
end, plus the same L slots as the entry, from swap events (Helius). Our own trades are not fed back into history.

  python3 -I outcome.py run <events.json>... <out.json>
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'lottery-probe'))
import hel, swaps, lottery
from events import Q, LAT

SCRATCH = os.environ.get('AB_SCRATCH') or sys.exit('set AB_SCRATCH')
WALL = lottery.WALL
H = 3600
STOP, ARM, TRAIL, MAX_HOLD = 0.30, 2.0, 0.40, 14 * 86400

def hourly(pool):
    p = os.path.join(SCRATCH, 'gt_hourly', pool + '.json')
    if not os.path.exists(p):
        return None
    return {int(r[0]): [float(x) for x in r[1:6]] for r in json.load(open(p))}

def r1_exit_time(bars, entry_t, P_e):
    """Returns (time the exit decision is known, reason). Bars are hourly [o, h, l, c, v] keyed by start time.
    The entry's own hour: only its close counts (its low may predate the entry). Missing hours carry the close."""
    h0 = entry_t - entry_t % H
    peak, armed = P_e, False
    last_c = None
    t = h0
    while True:
        end = t + H
        if end > WALL:
            return WALL, 'wall'
        if end > entry_t + MAX_HOLD:
            return entry_t + MAX_HOLD, 'time'
        b = bars.get(t)
        if b is None:
            if last_c is None:
                t += H; continue
            lo, c, v = last_c, last_c, 0.0
        else:
            lo, c, v = (b[2] if t > h0 else b[3]), b[3], b[4]
        last_c = c
        if not armed and lo <= (1 - STOP) * P_e:
            return end, 'stop'
        if c > peak and v > 0:
            peak = c
        if not armed and peak >= ARM * P_e:
            armed = True
        if armed and c <= (1 - TRAIL) * peak:
            return end, 'trail'
        t += H

def fill_after(pool, T, L):
    """State after all swaps with slot <= (first swap at/after T).slot + L. Returns (swap, flag)."""
    t0 = int(T)
    span = 120
    first = None
    sw = []
    while t0 < WALL:
        t1 = min(WALL, t0 + span)
        more, _, _ = swaps.window(pool, t0, t1)
        sw += more
        if first is None and sw:
            first = sw[0]
        if first is not None and (sw[-1].slot > first.slot + L or t1 >= WALL):
            break
        if first is not None and t1 - first.t > 60:
            break
        t0 = t1; span = min(span * 6, 7 * 86400)
    if first is None:
        last = swaps.last_before(pool, WALL, back=30 * 86400)
        return last, 'no-swap-after'
    cur = first
    for s in sw:
        if s.slot <= first.slot + L:
            cur = s
    return cur, 'ok'

def trade(ev):
    out = {}
    bars = hourly(ev['pool'])
    for L in LAT:
        e = ev['entry'][f'L{L}']
        T, why = r1_exit_time(bars or {}, e['t'], e['P_e'])
        if why == 'wall':
            s = swaps.last_before(ev['pool'], WALL, back=30 * 86400); flag = 'wall'
        else:
            s, flag = fill_after(ev['pool'], T, L)
        proceeds = swaps.sell_sol(e['tokens_raw'], s.B1, s.Q1, s.V, s.f)
        val_entry = e['tokens_raw'] / 1e6 * e['P_e']
        out[f'L{L}'] = {'exit_reason': why, 'exit_flag': flag, 'exit_decision_t': T, 'exit_t': s.t, 'exit_slot': s.slot,
                        'P_exit': s.p1(), 'proceeds_sol': proceeds, 'mult': proceeds / Q,
                        'net': proceeds / Q - 1 - lottery.FIXED / Q,
                        'entry_cost': 1 - val_entry / Q,
                        'exit_cost': 1 - proceeds / (e['tokens_raw'] / 1e6 * s.p1()) if s.p1() > 0 else None,
                        'bars_end': max(bars) + H if bars else None}
    return out

def run(*args):
    *srcs, out = args
    res = json.load(open(out)) if os.path.exists(out) else {}
    for src in srcs:
        for ev in json.load(open(src))['events']:
            if not ev.get('traded'):
                continue
            k = ev['id']
            if k in res:
                continue
            res[k] = {'group': ev['group'], 'pool': ev['pool'], 'entry_t': ev['entry']['L10']['t'], **trade(ev)}
            json.dump(res, open(out + '.tmp', 'w'), indent=0); os.replace(out + '.tmp', out)
            print(k, ev['group'], round(res[k]['L10']['net'], 3), res[k]['L10']['exit_reason'], hel.credits()['credits'], flush=True)

if __name__ == '__main__':
    {'run': run}[sys.argv[1]](*sys.argv[2:])
