"""EDGE-HUNT-U2 simulator: the bot's U2 gates, entry rules and U2 exits, applied as of each minute to 1-minute
GeckoTerminal candles of every sampled PumpSwap graduate (exploratory candle proxy, see README "Proxies").

Usage: python3 -I simulate.py <datadir> <out.json> [--holdout TRIAL]
Without --holdout, graduates on or after HOLDOUT_FROM are never read. With it, only that one trial is run, on the
holdout only. Python standard library only.
"""
import json, math, os, sys
from bisect import bisect_right

HOLDOUT_FROM = 1791007200  # 2026-10-02T18:00:00Z; window 2026-09-22T00:00Z .. 2026-10-06T05:30Z, holdout ~24.5%
MIN = 60

# ---- policy values copied from packages/core/src/config/policy.ts (TRIAL_VALUES) and research/edge/preregistration.json
NOTIONAL_USD = 2.0
DUST_SOL = 5.0
H11_SPIKE = 0.25            # candleSpikeBps 2500
H11_WINDOW = 3 * MIN        # candleWindowMs
CHASE_AT = 5 * MIN          # chaseCheckAfterMs; chaseMaxAboveMigrationBps 0
WIN_FROM, WIN_TO = 60 * MIN, 240 * MIN   # U2 window (H10 + preregistration fromMs/toMs)
STOP_MAX = 0.20             # loss.stopMaxBps
U2X = dict(stop_atr=3.0, t_flat=15 * MIN, flat_min_r=0.5, t_max=120 * MIN, partial_share=0.5, partial_r=1.5,
           partial_gain=1.0, atr_period=14, trail_atr=3.0)
NEG_FLOW_MIN = 5            # exits.negativeFlowMinutes
LIQ_DROP = 0.30             # exits.liquidityDropBps
MAX_EXIT_TX = 2             # maxExitTxAtMinNotional: one partial, then the rest
# ---- costs: research/edge/costs.json (young, $2) and edge-costs.ts terms
FIXED_ONE_EXIT = 414_009    # lamports per filled round trip with one exit (entry, exit, expected failed exits, rent loss)
FIXED_EXTRA_EXIT = 30_000 + 0.7728 * 155_000  # one more exit tx: base+priority+tip, plus its expected failed attempts
VIRTUAL_SOL = 17.6          # BOOST virtual quote on a standard migration (edge-costs.ts 'young' pool)

TRIALS = {
    # id: (entry rule, H8 floor USD, H11 chase check on)
    'T1-H4-current':      ('H4', 15000.0, True),
    'T2-H4-relaxed':      ('H4', 5000.0, False),
    'T3-H4-H8only':       ('H4', 5000.0, True),
    'T4-H4-H11only':      ('H4', 15000.0, False),
    'T5-H5p-current':     ('H5p', 15000.0, True),
    'T6-H5p-relaxed':     ('H5p', 5000.0, False),
}


def load_solusd(path):
    L = sorted(json.load(open(path))['data']['attributes']['ohlcv_list'])
    ts = [b[0] for b in L]
    return lambda t: L[max(0, bisect_right(ts, t) - 1)][4]


def fee_rate(mcap_sol):
    # PumpSwap canonical tiers (ARCHITECTURE §5): 1.25% below 420 SOL, 1.20% to 1,470 SOL; above that the 1.20% is kept
    # as an upper bound (lower tiers not modelled: conservative).
    return 0.0125 if mcap_sol < 420 else 0.012


class Pool:
    def __init__(self, mig, bars):
        self.mig = mig
        self.real0 = mig['sol']
        self.base0 = mig['tok']
        self.mig_spot = mig['migPriceSol']      # the bot's migration price: created pool quote / base (no virtual)
        q0 = self.real0 + (VIRTUAL_SOL if self.real0 > 50 else 0.0)
        self.k = q0 * self.base0                  # constant product on effective reserves (LP fee growth ignored)
        self.bars = bars                          # actual bars with trades: (t, o, h, l, c, v), ascending
        self.ts = [b[0] for b in bars]

    def quote_at(self, p):
        return math.sqrt(self.k * p)

    def base_at(self, p):
        return math.sqrt(self.k / p)

    def finished(self, t):
        """Bars that finished by t."""
        return self.bars[:bisect_right(self.ts, t - MIN)]


def atr(bars, period, now):
    done = [b for b in bars if b[0] + MIN <= now]
    if not done:
        return None
    i = len(done) - 1
    while i > 0 and done[i - 1][0] + MIN == done[i][0]:
        i -= 1
    run = done[i:]
    if len(run) < period:
        return None
    tr = []
    for j, b in enumerate(run):
        pc = run[j - 1][4] if j else None
        hi = max(b[2], pc) if pc is not None else b[2]
        lo = min(b[3], pc) if pc is not None else b[3]
        tr.append(hi - lo)
    v = sum(tr[:period]) / period
    for x in tr[period:]:
        v = (v * (period - 1) + x) / period
    return v


def gates(pool, t, done, spot, floor_usd, chase, solusd):
    """None when every modelled hard reject passes at t, else the failing gate."""
    if pool.real0 < DUST_SOL:
        return 'H8:dust'
    if pool.quote_at(spot) * solusd(t) < floor_usd:
        return 'H8:floor'
    for b in done:
        if b[0] + MIN > t - H11_WINDOW and b[2] > b[1] * (1 + H11_SPIKE):
            return 'H11:spike'
    if chase:
        at = pool.mig['blockTime'] + CHASE_AT
        last = None
        for b in done:
            if b[0] + MIN <= at:
                last = b
        if last is None or last[0] + MIN <= pool.mig['blockTime']:
            return 'H16:not-covered'
        if last[4] > pool.mig_spot:
            return 'H11:chase'
    return None


def h4_setup(pool, t, done, spot):
    """U2 reclaim (study.ts u2Setup): flush >= 30% below the migration price before the last 15 min, a higher low >= 5%
    above it in the last 15 min, spot above the VWAP since migration, positive net flow over the last 15 min (proxy:
    on a constant-product pool net SOL flow has the sign of the price change), stop 1% below the recent low."""
    recent = [b for b in done if b[0] >= t - 15 * MIN]
    before = [b for b in done if b[0] < t - 15 * MIN]
    if not before:
        return None
    flush = min(b[3] for b in before)
    if flush > pool.mig_spot * 0.70:
        return None
    if not recent:
        return None
    rlow = min(b[3] for b in recent)
    if rlow < flush * 1.05:
        return None
    vol = sum(b[5] for b in done)
    if vol <= 0 or spot <= sum((b[2] + b[3] + b[4]) / 3 * b[5] for b in done) / vol:
        return None
    ref = before[-1][4]  # price at the start of the recent window
    if spot <= ref:
        return None
    return rlow * 0.99


def h5p_setup(pool, t, done, spot):
    """H5 exhausted dump, price-only part (f_early_sold and f_devnet not available, so this is looser than H5):
    f_dd <= -0.60 vs the high since migration, f_net15 >= 0 (proxy: price now >= price 15 min ago), f_hl = 1 (low of the
    last 30 min above the low of 30-60 min ago), stop 20% below spot."""
    peak = max(b[2] for b in done)
    if spot / peak - 1 > -0.60:
        return None
    b15 = [b for b in done if b[0] < t - 15 * MIN]
    if not b15 or spot < b15[-1][4]:
        return None
    lr = [b[3] for b in done if t - 30 * MIN <= b[0] < t]
    lp = [b[3] for b in done if t - 60 * MIN <= b[0] < t - 30 * MIN]
    if not lr or not lp or not min(lr) > min(lp):
        return None
    return spot * 0.80


def stop_ok(entry, stop, a):
    if stop <= 0 or stop >= entry:
        return False
    d = entry - stop
    if d > STOP_MAX * entry:
        return False
    if a is None or d > U2X['stop_atr'] * a:
        return False
    return True


def price_at_open(pool, t):
    """Price a transaction sent at t meets: the open of the bar starting at t, else the last close (no trades since)."""
    i = bisect_right(pool.ts, t) - 1
    if i >= 0 and pool.bars[i][0] == t:
        return pool.bars[i][1]
    return pool.bars[i][4] if i >= 0 else None


def buy(pool, p, sol_in):
    f = fee_rate(p * 1e9)
    x = sol_in * (1 - f)
    q, b = pool.quote_at(p), pool.base_at(p)
    return b * x / (q + x)


def sell_value(pool, p, tokens):
    f = fee_rate(p * 1e9)
    q, b = pool.quote_at(p), pool.base_at(p)
    return q * tokens / (b + tokens) * (1 - f)


def simulate_trade(pool, t_entry, stop, solusd):
    paid = NOTIONAL_USD / solusd(t_entry)                      # SOL
    fixed1 = FIXED_ONE_EXIT / 1e9
    pe = price_at_open(pool, t_entry)
    tokens = buy(pool, pe, paid)
    s = (pe - stop) / pe if pe > stop else 0.0
    R = paid * s + paid * 0.025 + fixed1                       # planned loss at the stop, costs included (R5)
    cost_basis = paid + fixed1
    held, realized, partials, peak, trail, flat_met = tokens, 0.0, 0, None, None, False
    q_entry = pool.quote_at(pe)
    reason, t_exit, px_exit = None, None, None
    end = t_entry + U2X['t_max']
    bars = [b for b in pool.bars if b[0] >= t_entry and b[0] < end]
    neg_run, last_start, last_close = 0, None, None
    prev = pool.finished(t_entry)
    last_close = prev[-1][4] if prev else pe
    fixed = fixed1

    def pnl_at(p):
        return realized + sell_value(pool, p, held) - cost_basis - (FIXED_EXTRA_EXIT / 1e9 if partials else 0)

    events = []
    for b in bars:
        t0, o, h, l, c, v = b
        # time stops fire at their time: fill at the price then
        if not flat_met and t0 >= t_entry + U2X['t_flat']:
            reason, t_exit = 'time_flat', t_entry + U2X['t_flat']
            px_exit = price_at_open(pool, t_exit)
            break
        # price levels inside the bar: never better than the level or a gap open below it, never the wick
        if l <= stop:
            reason, t_exit, px_exit = 'price_stop', t0, min(stop, o, c)
            break
        if trail is not None and l <= trail:
            reason, t_exit, px_exit = 'trailing_stop', t0, min(trail, o, c)
            break
        if pool.quote_at(c) <= q_entry * (1 - LIQ_DROP):
            reason, t_exit, px_exit = 'liquidity_drop', t0 + MIN, price_at_open(pool, t0 + MIN)
            break
        # bar close: state triggers, filled at the next bar
        net_neg = c < last_close
        neg_run = (neg_run + 1 if (net_neg and last_start is not None and t0 == last_start + MIN) else (1 if net_neg else 0))
        last_start, last_close = t0, c
        pnl = pnl_at(c)
        peak = c if peak is None else max(peak, c)  # spot terms, like the stop and the bar lows it is compared with
        if not flat_met and t0 + MIN - t_entry <= U2X['t_flat'] and pnl >= U2X['flat_min_r'] * R:
            flat_met = True
        if partials >= 1:
            a = atr(pool.bars, U2X['atr_period'], t0 + MIN)
            if a is not None:
                lvl = peak - U2X['trail_atr'] * a
                trail = lvl if trail is None else max(trail, lvl)
            if pnl <= 0:
                reason, t_exit = 'break_even', t0 + MIN
                px_exit = price_at_open(pool, t_exit)
                break
        if neg_run >= NEG_FLOW_MIN:
            reason, t_exit = 'negative_flow', t0 + MIN
            px_exit = price_at_open(pool, t_exit)
            break
        k = partials + 1
        if partials < MAX_EXIT_TX - 1 and (pnl >= k * U2X['partial_r'] * R or pnl >= k * U2X['partial_gain'] * cost_basis):
            tp = price_at_open(pool, t0 + MIN)
            sell = held * U2X['partial_share']
            realized += sell_value(pool, tp, sell)
            held -= sell
            partials += 1
            fixed += FIXED_EXTRA_EXIT / 1e9
            events.append(('take_profit', t0 + MIN, tp))
    if reason is None:
        # no bar reached the next time stop: it fires at its time, at the price then
        reason = 'time_flat' if not flat_met else 'time_max'
        t_exit = t_entry + U2X['t_flat'] if not flat_met else end
        px_exit = price_at_open(pool, t_exit)
    proceeds = realized + sell_value(pool, px_exit, held)
    net = proceeds - paid - fixed
    return dict(entry_t=t_entry, entry_px=pe, stop=stop, exit_t=t_exit, exit_px=px_exit, reason=reason, partials=partials,
                last_leg_move=px_exit / pe - 1, net_sol=net, net_ret=net / paid, paid_sol=paid, events=events)


def run_trial(trial, pools, solusd):
    rule, floor, chase = TRIALS[trial]
    setup = h4_setup if rule == 'H4' else h5p_setup
    trades, funnel = [], {}
    for pool in pools:
        mt = pool.mig['blockTime']
        first = (mt + WIN_FROM + MIN - 1) // MIN * MIN
        stage = 'no-bars'
        rank = {'no-bars': 0, 'gate': 1, 'no-setup': 2, 'stop-check': 3, 'entered': 4}
        gate_seen = None
        for t in range(first, mt + WIN_TO, MIN):
            done = pool.finished(t)
            if not done:
                continue
            spot = done[-1][4]
            g = gates(pool, t, done, spot, floor, chase, solusd)
            if g:
                gate_seen = gate_seen or g
                stage = max(stage, 'gate', key=rank.get)
                continue
            stop = setup(pool, t, done, spot)
            if stop is None:
                stage = max(stage, 'no-setup', key=rank.get)
                continue
            if not stop_ok(spot, stop, atr(pool.bars, U2X['atr_period'], t)):
                stage = max(stage, 'stop-check', key=rank.get)
                continue
            tr = simulate_trade(pool, t, stop, solusd)
            tr.update(pool=pool.mig['pool'], mint=pool.mig['mint'], mig_t=mt, signal_t=t)
            trades.append(tr)
            stage = 'entered'
            break
        key = stage if stage != 'gate' else gate_seen
        funnel[key] = funnel.get(key, 0) + 1
    return trades, funnel


def load(datadir, holdout):
    M = {}
    for l in open(os.path.join(datadir, 'migrations.jsonl')):
        d = json.loads(l)
        if d.get('kind') == 'migrate' and d.get('pool') and d.get('tok') and d['pool'] not in M:
            M[d['pool']] = d
    pools, cov = [], dict(migrations=len(M), fetched=0, err=0, empty=0, used=0)
    for pool_id, m in M.items():
        if (m['blockTime'] >= HOLDOUT_FROM) != holdout:
            continue
        f = os.path.join(datadir, 'ohlcv', pool_id + '.json')
        if not os.path.exists(f):
            continue
        cov['fetched'] += 1
        r = json.load(open(f))['resp']
        if '_err' in r:
            cov['err'] += 1
            continue
        L = sorted(tuple(b) for b in r['data']['attributes']['ohlcv_list'] if b[0] + MIN > m['blockTime'] and b[1] > 0)
        if not L:
            cov['empty'] += 1
            continue
        cov['used'] += 1
        pools.append(Pool(m, L))
    return pools, cov


if __name__ == '__main__':
    datadir, out = sys.argv[1], sys.argv[2]
    hold = sys.argv[sys.argv.index('--holdout') + 1] if '--holdout' in sys.argv else None
    solusd = load_solusd(os.path.join(datadir, 'solusd_hour.json'))
    pools, cov = load(datadir, holdout=hold is not None)
    res = dict(coverage=cov, holdout=hold is not None, trials={})
    for trial in ([hold] if hold else TRIALS):
        trades, funnel = run_trial(trial, pools, solusd)
        res['trials'][trial] = dict(trades=trades, funnel=funnel)
        print(trial, 'trades', len(trades), 'funnel', funnel)
    json.dump(res, open(out, 'w'))
    print('coverage', cov)
