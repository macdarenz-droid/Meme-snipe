"""List pump.fun graduates by creation time via frontend-api-v3 /coins/search-unrestricted (pumpSwapGraduatedOnly)."""
# Stopped (owner rule A02, 2026-10-07: no new requests to pump.fun-operated hosts; Z01 ruling 5.5). This client must
# not run again; it is kept as a record of how the 2026-10 sample was collected.
raise SystemExit('stopped: no new requests to the venue host (owner rule A02, 2026-10-07); kept as a record only')
import sys, json, time, calendar
sys.path.insert(0, sys.argv[1])
from pf import get
KEEP = ['mint', 'pump_swap_pool', 'created_timestamp', 'quote_mint', 'creator', 'twitter', 'website', 'telegram', 'reply_count', 'is_currently_live', 'ath_market_cap', 'ath_market_cap_timestamp', 'nsfw', 'is_cashback_enabled', 'is_holder_reward', 'boost_mode']
EXTRA = sys.argv[5] if len(sys.argv) > 5 else 'pumpSwapGraduatedOnly=true'
stats = {'calls': 0, 'slices': 0, 'splits': 0}
import os
STEP = int(os.environ.get("STEP", "86400"))
CAP = 650  # measured: a query returns at most ~700 rows (offset+limit clamp), so a slice at or above 650 is split
def fetch(a, b):
    """All rows created in [a, b) seconds; returns None if the slice overflows the 1000-row window."""
    rows = {}
    for off in range(0, 1000, 200):
        now = int(time.time())
        u = ('https://frontend-api-v3.pump.fun/coins/search-unrestricted?' + EXTRA + '&includeNsfw=true'
             f'&minAgeSeconds={max(0, now - b - 60)}&maxAgeSeconds={now - a + 60}&limit=200&sort=created_timestamp&order=DESC&offset={off}')
        code, body = get(u); stats['calls'] += 1
        if code != 200: raise RuntimeError(f'http {code} {body[:200]}')
        d = json.loads(body)
        new = 0
        for r in d:
            if r['mint'] not in rows: new += 1
            rows[r['mint']] = r
        time.sleep(0.8)
        if len(d) < 200 or new == 0:
            return rows if len(rows) < CAP else None
    return None
def collect(a, b, out):
    r = fetch(a, b)
    if r is None:
        stats['splits'] += 1; m = (a + b) // 2
        collect(a, m, out); collect(m, b, out); return
    stats['slices'] += 1
    kept = 0
    for x in r.values():
        ts = x.get('created_timestamp') or 0
        if a * 1000 <= ts < b * 1000:
            out.write(json.dumps({k: x.get(k) for k in KEEP}) + '\n'); kept += 1
    return kept
if __name__ == '__main__':
    start, end, path = sys.argv[2], sys.argv[3], sys.argv[4]
    a = calendar.timegm(time.strptime(start, '%Y-%m-%dT%H:%M')); b = calendar.timegm(time.strptime(end, '%Y-%m-%dT%H:%M'))
    t0 = time.time()
    with open(path, 'a') as f:
        day = a
        while day < b:
            nd = min(day + STEP, b)
            k = collect(day, nd, f); f.flush()
            if day % 86400 == 0: print(time.strftime('%Y-%m-%d', time.gmtime(day)), 'calls', stats['calls'], 'splits', stats['splits'], '%.0fs' % (time.time() - t0), flush=True)
            day = nd
    print('done', stats, '%.0fs' % (time.time() - t0))
