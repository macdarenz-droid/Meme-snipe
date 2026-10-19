"""Step 7: trade simulation of the signals on 1-minute bars with the bot's U1 exits and the real costs at $2.

  python3 07_sim.py need  --period screen        -> data/need.json (candidate entries whose 1-min bars step 6 fetches)
  python3 07_sim.py run   --period screen [--rules H1,H2] [--universe A|B] [--tag name]

Period 'screen' = entries in [ENTRY_FROM, HOLDOUT_FROM); 'holdout' = [HOLDOUT_FROM, WALL - 125 min). The holdout is
only run after the screen has named at most one candidate (README).

Entry: the signal at bar end T fills at the close of the 1-min bar [T, T+60) (the next bar), else at the last price.
Size $2 at the hour's SOL/USD; all money is counted in SOL. Venue fee by market-cap tier both legs, constant-product
price impact at the real size, fixed network/rent costs from edge.md (414,009 lamports per position, +149,784 per extra
exit tx). Exits (policy U1 block, packages/core/src/exits/rules.ts decideExit), evaluated at each 1-min bar end:
  price_stop  bar low <= stop          -> fill min(stop, next bar open)
  negative_flow 5 contiguous minutes each closing below the previous close (net SOL out of a constant-product pool)
  time_flat   by 30 min P&L never reached 0.5 R (judged on closes) -> next open
  time_max    120 min -> next open
  take_profit (close only, conservative scenario) P&L >= 2 R or >= 10% of cost basis -> sell half at next open (one
              partial at $2: maxExitTxAtMinNotional 2); then break_even (P&L <= 0) and trail peak - 3 x ATR(14, 5 min)
Not modelled: deployer_sell, quote failures, no-route (no data). Per mint: one entry a UTC day, none while open, none for
24 h after a stop-out (policy positions). maxOpen/maxEntriesPerDay are portfolio limits, applied only in the
'portfolio' report of a surviving candidate.
"""
import argparse, bisect, glob, json, math, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
import importlib.util
_s = importlib.util.spec_from_file_location('sig', os.path.join(HERE, '05_signals.py')); sig = importlib.util.module_from_spec(_s); _s.loader.exec_module(sig)

def period_ok(T, period):
    return (ENTRY_FROM <= T < HOLDOUT_FROM) if period == 'screen' else (HOLDOUT_FROM <= T <= WALL - TMAX - 300)

def load_signals(period, rules, universe):
    out = []
    for l in open(os.path.join(DATA, 'signals.jsonl')):
        s = json.loads(l)
        if s['rule'] in rules and period_ok(s['T'], period) and (universe == 'A' or s['B']): out.append(s)
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

class Pool:
    def __init__(self, k): self.k = k
    def sell(self, p, Q, f):   # SOL out for Q tokens at spot p
        q = math.sqrt(self.k * p); b = q / p
        return q * Q / (b + Q) * (1 - f)
    def buy(self, p, S, f):    # tokens for S SOL at spot p
        q = math.sqrt(self.k * p); b = q / p; x = S * (1 - f)
        return b * x / (q + x)

def atr_at(pool, t):
    m5 = pool_bars(pool)['m5']; ends = [b[0] + 300 for b in m5]
    i = bisect.bisect_right(ends, t) - 1
    return sig.atr14(m5, i) if i >= 0 else None

def simulate(s, bars1, spans):
    T, pool = s['T'], s['pool']
    if not any(a <= T and min(T + 7800, WALL) <= z for a, z in spans): return None
    d = pool_bars(pool); P = Pool(d['tok'] * d['sol'])
    starts = [b[0] for b in bars1]
    by = {b[0]: b for b in bars1}
    usd = s['usd']; S = NOTIONAL_USD / usd
    first = by.get(T)
    pe = first[4] if first else s['p']
    opened = T + 60
    fee = lambda p: fee_bps(p * 1e9) / 1e4
    Q = P.buy(pe, S, fee(pe)); Q0 = Q
    stop = s['stop']
    C = S + TX / 1e9
    exit_cost = TX / 1e9
    R = S - P.sell(stop, Q, fee(stop))
    if R <= 0: R = 1e-12
    realized, partials, flat_met = 0.0, 0, False
    peak, trail, prev_close, neg_run = pe, None, pe, 0
    def pnl(p): return realized + P.sell(p, Q, fee(p)) - exit_cost - C
    def next_open(t_end, fallback):
        b = by.get(t_end)
        return b[1] if b else fallback
    last = pe; reason = None; exit_px = None; t_exit = None
    for m in range(opened, opened + TMAX + 60, 60):
        b = by.get(m)
        end = m + 60; el = end - opened
        if b: o, h, l, c = b[1], b[2], b[3], b[4]
        else: o = h = l = c = last
        full = None
        if l <= stop: full = ('stop', min(stop, next_open(end, c)))
        if partials >= 1:
            # the trail level comes from bars before this one (a bar's high may come after its low)
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
            realized += P.sell(exit_px, Q, fee(exit_px)); Q = 0
            break
        if partials < 1 and (pnl(c) >= 2 * R or pnl(c) >= 0.10 * C):
            px_ = next_open(end, c); q_s = Q * 0.5
            realized += P.sell(px_, q_s, fee(px_)); Q -= q_s; partials += 1; peak = max(peak, h)
    if Q > 0:  # safety: should not happen (time_max fires)
        realized += P.sell(last, Q, fee(last)); reason = reason or 'end'; t_exit = t_exit or opened + TMAX
    fixed = (FIXED_ONE_EXIT + EXTRA_EXIT * partials) / 1e9
    net = realized - S - fixed
    gross = Q0 * 0  # placeholder
    return {'rule': s['rule'], 'pool': pool, 'mint': s['mint'], 'T': T, 'net_sol': net, 'ret': net / S,
            'gross_move': (exit_px or last) / pe - 1, 'reason': reason, 'hold_min': (t_exit - opened) / 60,
            'partials': partials, 'S': S, 'B': s['B'], 'stop_pct': 1 - stop / s['p']}

MISSING = []
def run(signals, need_only=False):
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
        r = None if bars1 is None else simulate(s, bars1, spans)
        if r is None: missing += 1; MISSING.append({'pool': s['pool'], 'T': T}); continue
        trades.append(r); last_day = day; last_exit = T + 60 + r['hold_min'] * 60
        if r['reason'] == 'stop': block_until = last_exit + 86400
    return (need if need_only else trades), missing

def boot_ci(trades, B=4000, seed=7):
    by = {}
    for t in trades: by.setdefault(t['mint'], []).append(t['ret'])
    ks = list(by); rng = random.Random(seed); means = []
    for _ in range(B):
        xs = []
        for _ in ks: xs += by[rng.choice(ks)]
        means.append(sum(xs) / len(xs))
    means.sort()
    return means[int(0.025 * B)], means[int(0.975 * B) - 1]

def summary(trades):
    if not trades: return {'n': 0}
    rs = sorted(t['ret'] for t in trades); n = len(rs)
    mean = sum(rs) / n; sd = (sum((x - mean) ** 2 for x in rs) / (n - 1)) ** 0.5 if n > 1 else 0
    lo, hi = boot_ci(trades) if n > 1 else (None, None)
    reasons = {}
    for t in trades: reasons[t['reason']] = reasons.get(t['reason'], 0) + 1
    return {'n': n, 'coins': len({t['mint'] for t in trades}), 'win': sum(1 for x in rs if x > 0) / n, 'mean': mean,
            'median': rs[n // 2] if n % 2 else (rs[n // 2 - 1] + rs[n // 2]) / 2, 'sd': sd, 'ci95': [lo, hi],
            'sharpe_per_trade': mean / sd if sd else None, 'net_sol_total': sum(t['net_sol'] for t in trades),
            'mean_gross_move': sum(t['gross_move'] for t in trades) / n, 'reasons': reasons,
            'days': len({t['T'] // 86400 for t in trades})}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('mode'); ap.add_argument('--period', default='screen'); ap.add_argument('--rules', default='H1,H2,H3,H6')
    ap.add_argument('--universe', default='A'); ap.add_argument('--tag', default='')
    a = ap.parse_args()
    rules = a.rules.split(',')
    if a.mode == 'need':
        allneed = []
        for u in ('A',):
            nd, _ = run(load_signals(a.period, rules, u), need_only=True); allneed += nd
        uniq = {(x['pool'], x['T']): x for x in allneed}
        json.dump(list(uniq.values()), open(os.path.join(DATA, 'need.json'), 'w'))
        print('need', len(uniq), 'pools', len({x['pool'] for x in uniq.values()}))
    else:
        res = {}
        for r in rules:
            for u in (['A', 'B'] if a.universe == 'AB' else [a.universe]):
                tr, miss = run(load_signals(a.period, [r], u))
                res[f'{r}-{u}'] = dict(summary(tr), missing_m1=miss)
                json.dump(tr, open(os.path.join(DATA, f'trades_{a.period}_{r}_{u}{a.tag}.json'), 'w'))
        json.dump(MISSING, open(os.path.join(DATA, 'need_missing.json'), 'w'))
        print(json.dumps(res, indent=1))
