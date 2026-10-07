"""Step 7 (EDGE-HUNT-U1-B): trade simulation of the B signals on 1-minute bars with the bot's U1 exits and the bot's own
PumpSwap quote code (costs.py, parity-tested against packages/core/src/amm/pump-swap.ts), at every pre-registered size.

  python3 07_sim.py need                       -> data/need.json (entries whose 1-minute bars step 6 fetches)
  python3 07_sim.py run --periods train,wf     -> data/trades/<period>_<rule>_<size>.json
  python3 07_sim.py run --periods holdout --rules <candidate>   (only after 08_report.py named the candidate)

Exits and fills are U1's 07_sim.py unchanged (preregistration.json 'fills'). Changes from U1: every graduation, the B
universe only, the bot's integer quote code on effective reserves (BOOST virtual quote included), sizes $2-$10k, a
per-trade cost breakdown (gross, fees, impact, fixed) and the bot-allowed flag (R12 floor and the 1% round-trip impact
cap, as risk/evaluate.ts feasibleSize).
"""
import argparse, bisect, hashlib, json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
import costs
import importlib.util
_s = importlib.util.spec_from_file_location('sig', os.path.join(HERE, '05_signals.py')); sig = importlib.util.module_from_spec(_s); _s.loader.exec_module(sig)

SIZES = [2, 5, 20, 100, 1000, 10000]
FOLDS = {'WF1': (1786888800, 1787666400), 'WF2': (1787666400, 1788444000), 'WF3': (1788444000, HOLDOUT_FROM)}
HOLD_TO = WALL - TMAX - 300

def frac(s): return int(hashlib.sha256(s.encode()).hexdigest()[:8], 16) / 2 ** 32

_mig = None
def mig_sig(pool):
    global _mig
    if _mig is None:
        _mig = {}
        for l in open(os.path.join(DATA, 'migrations.jsonl')):
            r = json.loads(l)
            if r.get('pool') and (r['pool'] not in _mig or r['t'] < _mig[r['pool']]['t']): _mig[r['pool']] = r
    return _mig[pool]['sig']

def period_of(s):
    T = s['T']; u1 = frac(mig_sig(s['pool'])) < 0.08
    if ENTRY_FROM <= T < HOLDOUT_FROM:
        if u1: return 'train'
        for f, (a, b) in FOLDS.items():
            if a <= T < b: return f
    if HOLDOUT_FROM <= T <= HOLD_TO: return 'holdout'
    return None

def load_signals(periods, rules):
    out = []
    for l in open(os.path.join(DATA, 'signals.jsonl')):
        s = json.loads(l)
        if s['rule'] not in rules or not s['B']: continue
        p = period_of(s)
        if p is None: continue
        if p.startswith('WF'): s['fold'] = p; p = 'wf'
        if p in periods: s['period'] = p; out.append(s)
    out.sort(key=lambda s: (s['rule'], s['pool'], s['T']))
    return out

_bars = {}
def pool_bars(pool):
    if pool not in _bars: _bars[pool] = json.load(open(os.path.join(DATA, 'bars', pool + '.json')))
    return _bars[pool]

def m1(pool):
    f = os.path.join(DATA, 'm1', pool + '.json')
    if not os.path.exists(f): return None, []
    return json.load(open(f)), json.load(open(os.path.join(DATA, 'm1', pool + '.spans.json')))

_atr = {}
def atr_at(pool, t):
    m5 = pool_bars(pool)['m5']
    if pool not in _atr: _atr[pool] = [b[0] + 300 for b in m5]
    i = bisect.bisect_right(_atr[pool], t) - 1
    return sig.atr14(m5, i) if i >= 0 else None

def allowed(P, p, S_l, usd, size):
    """Bot's own refusals at this size: R12/H8 floor on the effective quote, and the 1% round-trip impact cap."""
    floor = max(15000, 1000 * size, 50000)
    if P.eff_quote_sol(p) * usd < floor: return False
    v, vi, b = P.state(p); r = costs.buy(v, vi, b, S_l)
    if r is None: return False
    base, fee, imp = r
    # pool after the buy (LP fee stays in the vault; v1), then sell the same base back
    quote_in = S_l - fee; lp = costs.fees_for(v + vi, b)[0]
    s = costs.sell(v + quote_in + costs.ceil_bps(quote_in, lp), vi, b - base, base)
    if s is None: return False
    return (imp + s[2]) * 10_000 <= 100 * S_l          # maxImpactBps 100 (ppm of paid, round trip)

def simulate(s, bars1, spans, size):
    T, pool = s['T'], s['pool']
    if not any(a <= T and min(T + 7800, WALL) <= z for a, z in spans): return None
    d = pool_bars(pool); P = costs.Pool(d['tok'], d['sol'])
    by = {b[0]: b for b in bars1}
    usd = s['usd']; S_l = int(size / usd * 1e9); S = S_l / 1e9
    first = by.get(T)
    pe = first[4] if first else s['p']
    opened = T + 60
    r = P.buy(pe, S_l)
    if r is None: return None
    Q, fee_in, imp_in = r; Q0 = Q
    fees, impact = fee_in / 1e9, imp_in / 1e9
    stop = s['stop']
    C = S + TX / 1e9
    exit_cost = TX / 1e9
    def proceeds(p, q):
        x = P.sell(p, q)
        return (0.0, 0, 0) if x is None else (x[0] / 1e9, x[1], x[2])
    R = S - proceeds(stop, Q)[0]
    if R <= 0: R = 1e-12
    realized, partials, flat_met = 0.0, 0, False
    peak, trail, prev_close, neg_run = pe, None, pe, 0
    legs = []   # (tokens, price) of each exit leg, for the gross return
    def pnl(p): return realized + proceeds(p, Q)[0] - exit_cost - C
    def next_open(t_end, fallback):
        b = by.get(t_end)
        return b[1] if b else fallback
    def sell_leg(px_, q):
        nonlocal realized, fees, impact
        u, f, i = proceeds(px_, q); realized += u; fees += f / 1e9; impact += i / 1e9; legs.append((q, px_))
    last = pe; reason = None; exit_px = None; t_exit = None
    for m in range(opened, opened + TMAX + 60, 60):
        b = by.get(m)
        end = m + 60; el = end - opened
        if b: o, h, l, c = b[1], b[2], b[3], b[4]
        else: o = h = l = c = last
        full = None
        if l <= stop: full = ('stop', min(stop, next_open(end, c)))
        if partials >= 1:
            if full is None and trail is not None and l <= trail: full = ('trail', min(trail, next_open(end, c)))
            if full is None and pnl(c) <= 0: full = ('break_even', next_open(end, c))
            peak = max(peak, h)
            a = atr_at(pool, end)
            if a is not None: trail = max(trail or 0, peak - 3 * a)
        if b:
            neg_run = neg_run + 1 if c < prev_close else 0
            prev_close = c
        else:
            neg_run = 0
        if full is None and neg_run >= 5: full = ('negative_flow', next_open(end, c))
        if not flat_met and el <= 1800 and pnl(c) >= 0.5 * R: flat_met = True
        if full is None and el >= TMAX: full = ('time_max', next_open(end, c))
        elif full is None and el >= 1800 and not flat_met: full = ('time_flat', next_open(end, c))
        last = c
        if full:
            reason, exit_px = full; t_exit = end
            sell_leg(exit_px, Q); Q = 0
            break
        if partials < 1 and (pnl(c) >= 2 * R or pnl(c) >= 0.10 * C):
            px_ = next_open(end, c); q_s = Q // 2
            sell_leg(px_, q_s); Q -= q_s; partials += 1; peak = max(peak, h)
    if Q > 0:
        sell_leg(last, Q); reason = reason or 'end'; t_exit = t_exit or opened + TMAX
    fixed = (FIXED_ONE_EXIT + EXTRA_EXIT * partials) / 1e9
    net = realized - S - fixed
    gross = sum(q * px_ for q, px_ in legs) / Q0 / pe - 1          # same exits, spot prices, no fee/impact/fixed
    return {'rule': s['rule'], 'pool': pool, 'mint': s['mint'], 'T': T, 'period': s['period'], 'fold': s.get('fold'),
            'size': size, 'S': S, 'net_sol': net, 'ret': net / S, 'gross': gross, 'fees': fees / S, 'impact': impact / S,
            'fixed': fixed / S, 'reason': reason, 'hold_min': (t_exit - opened) / 60, 'partials': partials,
            'allowed': allowed(P, pe, S_l, usd, size)}

MISSING = []
def run(signals, size, need_only=False):
    trades, need, missing = [], [], 0
    cur = None
    for s in signals:
        key = (s['rule'], s['pool'])
        if key != cur: cur, last_exit, last_day, block_until = key, -1, None, -1
        T = s['T']; day = T // 86400
        if T < last_exit or day == last_day or T < block_until: continue
        if need_only:
            need.append({'pool': s['pool'], 'T': T}); last_day = day; continue
        bars1, spans = m1(s['pool'])
        r = None if bars1 is None else simulate(s, bars1, spans, size)
        if r is None: missing += 1; MISSING.append({'pool': s['pool'], 'T': T}); continue
        trades.append(r); last_day = day; last_exit = T + 60 + r['hold_min'] * 60
        if r['reason'] == 'stop': block_until = last_exit + 86400
    return (need if need_only else trades), missing

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('mode'); ap.add_argument('--periods', default='train,wf'); ap.add_argument('--rules', default='H1,H6,S0,H2,H3')
    a = ap.parse_args()
    rules = a.rules.split(','); periods = a.periods.split(',')
    if 'holdout' in periods and a.mode == 'run':
        sel = json.load(open(os.path.join(HERE, 'results', 'selection.json')))
        assert sel['candidate'] and rules == [sel['candidate'].split('-')[0]], 'holdout is read only by the selected candidate'
    if a.mode == 'need':
        allneed = []
        for r in rules:
            nd, _ = run(load_signals(periods, [r]), 20, need_only=True); allneed += nd
        uniq = {(x['pool'], x['T']): x for x in allneed}
        json.dump(sorted(uniq.values(), key=lambda x: (x['pool'], x['T'])), open(os.path.join(DATA, 'need.json'), 'w'))
        print('need', len(uniq), 'pools', len({x['pool'] for x in uniq.values()}))
    else:
        os.makedirs(os.path.join(DATA, 'trades'), exist_ok=True)
        for r in rules:
            sigs = load_signals(periods, [r])
            for size in SIZES:
                tr, miss = run(sigs, size)
                for p in periods:
                    json.dump([t for t in tr if t['period'] == p], open(os.path.join(DATA, 'trades', f'{p}_{r}_{size}.json'), 'w'), sort_keys=True)
                if size == 20: print(r, 'trades', len(tr), 'missing m1', miss)
        json.dump(MISSING, open(os.path.join(DATA, 'need_missing.json'), 'w'))
