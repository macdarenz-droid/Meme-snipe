"""Step 5: as-of signals for the pre-registered U1 rules on 5-minute candles (exploratory candle proxies).

Each sampled pool is checked every 5 minutes at bar ends T with age in [1 d, 14 d] and T in [ENTRY_FROM, WALL - 125 min].
Only bars that ended at or before T are used. Quote reserve is the constant-product proxy sqrt(k * price) from the
migration reserves (LP fees grow k a little, so the proxy slightly understates the quote: conservative for U1).

Rules (preregistration.json, thresholds unchanged; '[omitted]' = not observable on candles, so the proxy rule is looser):
  H1  f_dd <= -0.35, f_ret60 >= -0.03, f_hl = 1, f_liqchg60 >= -0.10, [omitted f_2side60 <= 0.6]; stop 15% below spot
  H6  H1 and f_sol24 >= 0
  H2  f_net60 >= 0.01 (constant-product proxy: 1 - sqrt(p60/p)), f_ret60 <= 0.10, f_turn60 <= 0.5,
      [omitted f_indep60 >= 8, f_2side60 <= 0.4]; stop 15% below spot
  H3  price above the high of [T-6h, T-15m), SOL volume of the last 15 min >= 2.0 x that range's mean per 15 min,
      market cap >= 1470 SOL, [omitted holder growth +5%]; stop 1% below the 60-min low
Every entry also needs BT-2's stop check (packages/core/src/exits/rules.ts checkStopDistance): the stop distance is at
most 20% (policy stopMaxBps) and at most 3 x ATR(14, 5-min bars, contiguous run, Wilder), else no entry.
S0  control, not a trial: a random U1 check (one hashed time of day per pool-day, a fixed 30% of pool-days by hash);
    stop 15% below spot. It tells whether a rule beats entering U1 at random under the same exits and costs.
Universe A: quote proxy >= 100 SOL (preregistered window). Universe B: A and quote >= $50k (H8, policy u1FloorUsd).
Output: data/signals.jsonl, one line per (rule, pool, T) that fired.
"""
import glob, hashlib, json, math, os, sys, bisect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *

def atr14(bars, i_end):
    """ATR over the contiguous run of 5-min bars ending at index i_end (inclusive), Wilder smoothing as core atr()."""
    j = i_end
    while j > 0 and bars[j - 1][0] + 300 == bars[j][0]: j -= 1
    run = bars[j:i_end + 1]
    if len(run) < 14: return None
    tr = []
    for k, b in enumerate(run):
        prev = run[k - 1][4] if k else None
        hi = max(b[2], prev) if prev is not None else b[2]
        lo = min(b[3], prev) if prev is not None else b[3]
        tr.append(hi - lo)
    v = sum(tr[:14]) / 14
    for x in tr[14:]: v = (v * 13 + x) / 14
    return v

def scan(d, out):
    t0, k = d['t'], d['tok'] * d['sol']
    m5 = d['m5']; h = d['h']
    if not m5 or t0 < MIG_FROM: return
    m5_from = m5[0][0]
    pre_peak = max([b[2] for b in h if b[0] + 3600 <= m5_from] or [0])
    ends = [b[0] + 300 for b in m5]
    # running peak over m5 highs
    peak_run, pk = [], pre_peak
    for b in m5: pk = max(pk, b[2]); peak_run.append(pk)
    def idx(t):  # last m5 bar that ended at or before t
        return bisect.bisect_right(ends, t) - 1
    def px(t):
        i = idx(t)
        if i >= 0: return m5[i][4]
        hb = [b for b in h if b[0] + 3600 <= t]
        return hb[-1][4] if hb else None
    def bars_in(a, b):  # bars with start >= a and end <= b
        i0 = bisect.bisect_left([x[0] for x in m5], a) if False else bisect.bisect_left(ends, a + 300)
        i1 = idx(b)
        return m5[i0:i1 + 1] if i1 >= i0 else []
    lo_t = max(t0 + D1, ENTRY_FROM, m5_from + 7 * 3600)
    hi_t = min(t0 + D14, WALL - TMAX - 300)
    T = (lo_t + 299) // 300 * 300
    while T <= hi_t:
        i = idx(T)
        if i < 0 or ends[i] < T - 3600: T += 300; continue  # no trade for an hour: no fresh state
        p = m5[i][4]
        quote = math.sqrt(k * p); usd = sol_usd(T)
        if quote < 100 or usd is None: T += 300; continue
        mcap = p * 1e9
        p60 = px(T - 3600); p30 = px(T - 1800)
        if not p60 or not p30: T += 300; continue
        peak = max(peak_run[i], p)
        f = {
            'f_dd': p / peak - 1, 'f_ret60': p / p60 - 1, 'f_liqchg60': math.sqrt(p / p60) - 1,
            'f_net60': 1 - math.sqrt(p60 / p), 'f_sol24': None,
        }
        u24 = sol_usd(T - D1)
        if u24: f['f_sol24'] = math.log(usd / u24)
        rec = bars_in(T - 1800, T); pri = bars_in(T - 3600, T - 1800)
        low_r = min([p30] + [b[3] for b in rec]); low_p = min([p60] + [b[3] for b in pri])
        f['f_hl'] = 1 if low_r > low_p else 0
        w60 = bars_in(T - 3600, T)
        f['f_turn60'] = sum(b[5] for b in w60) / quote
        a = atr14(m5, i)
        fired = []
        if f['f_dd'] <= -0.35 and f['f_ret60'] >= -0.03 and f['f_hl'] == 1 and f['f_liqchg60'] >= -0.10:
            fired.append(('H1', p * 0.85))
            if f['f_sol24'] is not None and f['f_sol24'] >= 0: fired.append(('H6', p * 0.85))
        if f['f_net60'] >= 0.01 and f['f_ret60'] <= 0.10 and f['f_turn60'] <= 0.5:
            fired.append(('H2', p * 0.85))
        rng = bars_in(T - 6 * 3600, T - 900); last15 = bars_in(T - 900, T)
        if rng and last15 and mcap >= 1470:
            rh = max(b[2] for b in rng)
            vr = sum(b[5] for b in rng) / 23.0; v15 = sum(b[5] for b in last15)
            if p > rh and vr > 0 and v15 >= 2.0 * vr:
                l60 = bars_in(T - 3600, T)
                fired.append(('H3', 0.99 * min(b[3] for b in l60)))
        hd = hashlib.sha256(f"{d['pool']}:{T // 86400}".encode()).digest()
        if hd[0] < 77 and T % 86400 >= (int.from_bytes(hd[1:3], 'big') % 288) * 300:
            fired.append(('S0', p * 0.85))
        for rule, stop in fired:
            dist = p - stop
            if not (0 < stop < p): continue
            if dist > 0.20 * p: continue                  # stopMaxBps 2000
            if a is None or dist > 3 * a: continue       # 3 x ATR(14, 5 min)
            out.write(json.dumps({'rule': rule, 'pool': d['pool'], 'mint': d['mint'], 'T': T, 'p': p, 'stop': stop,
                                  'quote': quote, 'mcap': mcap, 'usd': usd, 'B': quote * usd >= 50000,
                                  'hold': T >= HOLDOUT_FROM, 'f': f, 'atr': a}) + '\n')
        T += 300

if __name__ == '__main__':
    files = sorted(glob.glob(os.path.join(DATA, 'bars', '*.json')))
    with open(os.path.join(DATA, 'signals.jsonl'), 'w') as out:
        n = 0
        for fn in files:
            d = json.load(open(fn))
            scan(d, out); n += 1
    print('pools scanned', n)
