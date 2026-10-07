import sys, json, time, urllib.request, urllib.error
import os
# STOPPED 2026-10-07: pump.fun Terms of Use (updated 25 Sep 2026) s21(h) bar bots and scripts except as s6.1 permits,
# tracking other users, and forged headers. This script used to send pump.fun's own Origin/Referer. It no longer forges
# headers and refuses to run unless the owner has approved its use (PUMPFUN_OWNER_OK=1).
if os.environ.get('PUMPFUN_OWNER_OK') != '1':
    raise SystemExit('pump.fun access is stopped pending the owner decision (Terms s21(h)); see research/hype/RESEARCH.md')
H = {'User-Agent': 'meme-snipe-research', 'Accept': 'application/json'}
def get(url, tries=12, base=4):
    for i in range(tries):
        req = urllib.request.Request(url, headers=H)
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code == 429:
                time.sleep(base + i * 2); continue
            return e.code, body
        except Exception as e:
            time.sleep(base); last = str(e)
    return 0, b'gave up'
if __name__ == '__main__':
    url = sys.argv[1]; out = sys.argv[2] if len(sys.argv) > 2 else None
    t = time.time(); code, body = get(url)
    if out: open(out, 'wb').write(body)
    try:
        d = json.loads(body)
    except Exception:
        print(code, len(body), body[:300]); sys.exit()
    if isinstance(d, list):
        print(code, 'list', len(d), '%.1fs' % (time.time() - t))
        for r in (d[:2] + d[-1:] if len(d)>2 else d):
            if isinstance(r, dict): print(' ', r.get('mint'), r.get('created_timestamp'), r.get('complete'), r.get('pump_swap_pool'), r.get('usd_market_cap'))
    else:
        print(code, json.dumps(d)[:600])
