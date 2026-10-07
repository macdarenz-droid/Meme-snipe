"""Bar-level screens (candidates only; every event is confirmed on swaps in events.py). No returns.

  python3 -I screen.py spans <out.json>        # pool-day spans worth 1-minute bars (daily close >= MCAP_MIN)
  python3 -I screen.py drops <spans.json> <out.json>  # large-drop and ordinary-recovery bar candidates
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get('AB_SCRATCH') or sys.exit('set AB_SCRATCH')
WALL = 1789999200
START = 1784678400           # 2026-07-22T00:00Z
DAY = 86400
MCAP_MIN = 36_000            # SOL; generous pre-screen (the $50 cost < 1.5% needs a fee tier near 0.65%, ~39k SOL)

# bar screens (frozen before any swap is read)
DROP = 0.10                  # low within the next 6 minutes at least 10% under the close before
DROP_WIN = 6
B_DIP = 0.10                 # ordinary recovery: back to the close of 60 min earlier after a >= 10% dip

def spans(out):
    d = os.path.join(SCRATCH, 'gt_daily')
    res = []
    for f in sorted(os.listdir(d)):
        rows = json.load(open(os.path.join(d, f)))
        days = sorted(int(r[0]) for r in rows if START - DAY <= int(r[0]) < WALL and float(r[4]) * 1e9 >= MCAP_MIN)
        if not days:
            continue
        # a day qualifies if its own close or the previous day's close passes; contiguous runs become spans
        qual = sorted({x for dd in days for x in (dd, dd + DAY) if START <= x < WALL})
        runs, cur = [], [qual[0], qual[0]]
        for x in qual[1:]:
            if x == cur[1] + DAY:
                cur[1] = x
            else:
                runs.append(cur); cur = [x, x]
        runs.append(cur)
        for a, b in runs:
            res.append({'pool': f[:-5], 'start': a - 3 * 3600, 'end': min(WALL, b + DAY), 'days': (b - a) // DAY + 1})
    json.dump(res, open(out, 'w'), indent=0)
    print(len({r['pool'] for r in res}), 'pools', sum(r['days'] for r in res), 'pool-days')

def bars(pool):
    d = os.path.join(SCRATCH, 'gt_minute')
    fs = [f for f in os.listdir(d) if f.startswith(pool + '_') and f.endswith('.json')]
    out = {}
    for f in fs:
        out.update({int(r[0]): [float(x) for x in r[1:6]] for r in json.load(open(os.path.join(d, f)))})
    return out or None

def drops(spec, out):
    """Large-drop candidates: minute m where min(low[m..m+5]) <= (1-DROP) * close[m-1] (carried close).
    Ordinary-recovery candidates: first minute m where close[m] >= close[m-60] and min(low[m-59..m]) <= (1-B_DIP) * close[m-60]."""
    pools = sorted({u['pool'] for u in json.load(open(spec))})
    cand_a, cand_b = [], []
    for pool in pools:
        b = bars(pool)
        if not b:
            continue
        t0, t1 = min(b), max(b)
        ts = list(range(t0, t1 + 60, 60))
        c, lo, hi, v, gap = [], [], [], [], []
        prev = b[t0][0]; last_real = t0
        for t in ts:
            r = b.get(t)
            gap.append(t - last_real)                    # seconds since the last real bar before t (carry age)
            if r:
                c.append(r[3]); lo.append(r[2]); hi.append(r[1]); v.append(r[4]); prev = r[3]; last_real = t
            else:
                c.append(prev); lo.append(prev); hi.append(prev); v.append(0.0)
        last = -10 ** 9
        for i in range(1, len(ts) - DROP_WIN):
            if ts[i] < START or b.get(ts[i]) is None or gap[i] > 3600:
                continue                                 # no reference close within the last hour
            m = min(lo[i:i + DROP_WIN])
            if m <= (1 - DROP) * c[i - 1] and ts[i] > last + 30 * 60 and c[i - 1] * 1e9 >= MCAP_MIN:
                cand_a.append({'pool': pool, 't': ts[i], 'ref': c[i - 1], 'low': m, 'drop': 1 - m / c[i - 1],
                               'vol': sum(v[i:i + DROP_WIN])})
                last = ts[i]
        lastb = -10 ** 9
        was = True
        for i in range(60, len(ts)):
            if ts[i] < START or gap[i - 60] > 3600:
                was = True; continue
            ok = c[i] >= c[i - 60] and min(lo[i - 59:i + 1]) <= (1 - B_DIP) * c[i - 60] and v[i] > 0
            if ok and not was and ts[i] > lastb + 60 * 60 and c[i - 60] * 1e9 >= MCAP_MIN:
                # any minute in the prior 2 h meeting the large-drop bar rule (no de-duplication, no size filter)
                dp = any(min(lo[k:min(k + DROP_WIN, i + 1)]) <= (1 - DROP) * c[k - 1] for k in range(max(1, i - 120), i + 1))
                cand_b.append({'pool': pool, 't': ts[i], 'ref': c[i - 60], 'dip_low': min(lo[i - 59:i + 1]), 'drop_in_prior_2h': dp})
                lastb = ts[i]
            was = ok
    json.dump({'large_drop': cand_a, 'recovery': cand_b}, open(out, 'w'), indent=0)
    print(len(cand_a), 'large-drop bar candidates;', len(cand_b), 'ordinary-recovery bar candidates')

if __name__ == '__main__':
    {'spans': spans, 'drops': drops}[sys.argv[1]](*sys.argv[2:])
