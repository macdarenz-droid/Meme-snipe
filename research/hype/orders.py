import json, sys, time, urllib.request, os
src, out = sys.argv[1], sys.argv[2]
mints = json.load(open(src))
done = set()
if os.path.exists(out):
    for l in open(out):
        try: done.add(json.loads(l)['mint'])
        except Exception: pass
f = open(out, 'a')
for x in mints:
    m = x['mint']
    if m in done: continue
    url = f"https://api.dexscreener.com/orders/v1/solana/{m}"
    for attempt in range(4):
        t0 = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'research-readonly/0.1'})
            with urllib.request.urlopen(req, timeout=20) as r:
                body = json.loads(r.read()); st = r.status
            f.write(json.dumps({'mint': m, 'created_ts_ms': x['created_ts_ms'], 'status': st, 'fetched_at': int(time.time()*1000), 'body': body}) + '\n'); f.flush()
            break
        except urllib.error.HTTPError as e:
            print('HTTP', e.code, m, flush=True)
            if e.code == 429: time.sleep(30)
            else:
                f.write(json.dumps({'mint': m, 'created_ts_ms': x['created_ts_ms'], 'status': e.code}) + '\n'); f.flush(); break
        except Exception as e:
            print('ERR', e, m, flush=True); time.sleep(5)
    time.sleep(max(0, 1.1 - (time.time() - t0)))
print('done')
