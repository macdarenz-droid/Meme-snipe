"""Hourly OHLCV for the Test 1 sample: `../../lottery-probe/fetch_hourly.py` logic, with each pool in try/except
(a failed pool gets no file, is logged, and is retried on the next run). Pre-wall only. No pump.fun requests.

  python3 -I fetch_prices.py <sample.json> <outdir> first|refetch
"""
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'deep-pool-probe'))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'lottery-probe'))
from fetch import get, WALL
from fetch_hourly import GT

CUT_MS = 1787270400000      # 2026-08-21T00:00Z


def main(sample, outdir, mode):
    os.makedirs(outdir, exist_ok=True)
    us = json.load(open(sample))
    assert all(u['created_ts_ms'] < CUT_MS for u in us), 'coin created on or after 2026-08-21'
    metaf = os.path.join(outdir, '_before.json')
    meta = json.load(open(metaf)) if os.path.exists(metaf) else {}
    failf = open(os.path.join(outdir, '_failures.log'), 'a')
    done = fails = 0
    for u in us:
        p = os.path.join(outdir, u['pool'] + '.json')
        first_before = min(u['created_ts_ms'] // 1000 + 41 * 86400, WALL)
        if mode == 'first':
            if os.path.exists(p):
                continue
            before = first_before
        else:
            if not os.path.exists(p):
                continue
            rows = json.load(open(p))
            if not rows or meta.get(u['pool'], first_before) != first_before:
                continue
            t0 = int(min(r[0] for r in rows))
            if t0 + 24 * 3600 + 30 * 86400 + 3600 <= first_before:
                continue
            before = min(t0 + 41 * 86400, WALL)
            if before <= first_before:
                continue
        try:
            d = get(GT.format(u['pool'], before)) or {}
            lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
            tmp = p + '.tmp'
            json.dump(sorted(lst), open(tmp, 'w'))
            os.replace(tmp, p)
            meta[u['pool']] = before
            json.dump(meta, open(metaf + '.tmp', 'w'))
            os.replace(metaf + '.tmp', metaf)
            done += 1
        except Exception as e:
            fails += 1
            failf.write(json.dumps({'pool': u['pool'], 'mode': mode, 'err': str(e)[:200], 't': int(time.time())}) + '\n'); failf.flush()
        if (done + fails) % 100 == 0:
            print(mode, 'done', done, 'fails', fails, time.strftime('%H:%M:%S'), flush=True)
        time.sleep(6.5)
    print(mode, 'finished: done', done, 'fails', fails, flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:])
