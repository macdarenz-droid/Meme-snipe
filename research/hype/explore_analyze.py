"""Exploration only (coins created 2026-07-22..08-20). Descriptive: does a public attention signal
known at entry (close of hour 1 after graduation) go with a bigger later peak? No strategy returns."""
import json, os, sys, statistics, datetime
sys.path.insert(0, '/home/user/Meme-snipe/research/runner-probe'); sys.path.insert(0, '/home/user/Meme-snipe/research/lottery-probe')
import runner
S = '/tmp/claude-0/-home-user-Meme-snipe/b87ffbbf-f1e1-5a15-b7d3-6a3e38afe9c2/scratchpad'
H = S + '/lottery/hourly'; D = S + '/hype/crypto-native/data'
CUT = int(datetime.datetime(2026, 8, 21, tzinfo=datetime.UTC).timestamp() * 1000)
cs, counts = runner.coins('/home/user/Meme-snipe/research/lottery-probe/sample.json', H)
assert all(x['u']['created_ts_ms'] < CUT for x in cs)
orders = {}
for l in open(D + '/orders_explore.jsonl'):
    r = json.loads(l); orders[r['mint']] = r.get('body') or {}
callouts = {}
if os.path.exists(D + '/callouts_explore.jsonl'):
    for l in open(D + '/callouts_explore.jsonl'):
        r = json.loads(l); callouts[r['mint']] = r.get('callouts')
rows = []
for x in cs:
    m = x['u']['mint']; ts, c, v = x['ts'], x['c'], x['v']
    grad = ts[0]; te = ts[1] + 3600            # entry = close of hour 1 (same as the runner sims)
    e = 1; last = min(len(c) - 1, e + runner.MAX_HOLD)
    seg = [(c[i], ts[i]) for i in range(e + 1, last + 1) if v[i] > 0]
    if not seg: continue
    pk, pkt = max(seg)
    peak = pk / c[e]
    o = orders.get(m, {})
    prof = sorted(z['paymentTimestamp'] / 1000 for z in o.get('orders', []) if z['type'] == 'tokenProfile' and z['status'] == 'approved')
    cto = sorted(z['paymentTimestamp'] / 1000 for z in o.get('orders', []) if z['type'] == 'communityTakeover' and z['status'] == 'approved')
    ads = sorted(z['paymentTimestamp'] / 1000 for z in o.get('orders', []) if z['type'] in ('tokenAd', 'trendingBarAd') and z['status'] == 'approved')
    boosts = sorted((z['paymentTimestamp'] / 1000, z['amount']) for z in o.get('boosts', []))
    cl = callouts.get(m)
    clt = sorted(int(z['createdAt']) / 1000 for z in (cl or []))
    rows.append(dict(mint=m, grad=grad, te=te, peak=peak, pkt=pkt, created=x['u']['created_ts_ms'] / 1000,
        prof=prof, cto=cto, ads=ads, boosts=boosts, clt=clt, cl_known=cl is not None, cl_capped=(cl is not None and len(cl) >= 100)))
print('usable coins', len(rows), counts)
from math import comb
def fisher(a1, a0, b1, b0):
    n1, n0, k = a1 + a0, b1 + b0, a1 + b1; N = n1 + n0
    p = lambda x: comb(n1, x) * comb(n0, k - x) / comb(N, k)
    obs = p(a1); return sum(p(x) for x in range(max(0, k - n0), min(k, n1) + 1) if p(x) <= obs * (1 + 1e-9))
def tab(name, pick, base=None):
    base = rows if base is None else base
    a = [r for r in base if pick(r)]; b = [r for r in base if not pick(r)]
    def f(g):
        if not g: return 'n=0'
        pk = [r['peak'] for r in g]
        return 'n=%3d  >=2x %4.1f%%  >=5x %4.1f%%  >=10x %4.1f%%  >=50x %d  median peak %.2fx' % (len(g), 100*sum(p>=2 for p in pk)/len(g), 100*sum(p>=5 for p in pk)/len(g), 100*sum(p>=10 for p in pk)/len(g), sum(p>=50 for p in pk), statistics.median(pk))
    pv = ' '.join('p(>=%dx)=%.2f' % (t, fisher(sum(r['peak']>=t for r in a), sum(r['peak']<t for r in a), sum(r['peak']>=t for r in b), sum(r['peak']<t for r in b))) for t in (2, 5, 10))
    print(f'{name:48s} YES {f(a)}\n{"":48s} NO  {f(b)}   Fisher {pv}')
print('\n-- coverage (any time) --')
for k in ('prof', 'cto', 'ads', 'boosts', 'clt'):
    print(k, sum(1 for r in rows if r[k]), 'of', len(rows))
print('callout scan known for', sum(r['cl_known'] for r in rows), 'capped at 100:', sum(r['cl_capped'] for r in rows))
def hrs(lst, ref): return [(t - ref) / 3600 for t in lst]
lag = sorted((r['prof'][0] - r['grad']) / 3600 for r in rows if r['prof'])
if lag: print('first paid profile, hours after graduation bar: p10 %.1f p25 %.1f p50 %.1f p75 %.1f p90 %.1f; before graduation %d' % tuple([lag[int(q*(len(lag)-1))] for q in (.1,.25,.5,.75,.9)] + [sum(l < 0 for l in lag)]))
lagb = sorted((r['boosts'][0][0] - r['grad']) / 3600 for r in rows if r['boosts'])
if lagb: print('first boost, hours after graduation bar: p10 %.1f p50 %.1f p90 %.1f (n=%d)' % (lagb[int(.1*(len(lagb)-1))], lagb[len(lagb)//2], lagb[int(.9*(len(lagb)-1))], len(lagb)))
lagc = sorted((r['clt'][0] - r['grad']) / 3600 for r in rows if r['clt'])
if lagc: print('first callout, hours after graduation bar: p10 %.1f p50 %.1f p90 %.1f (n=%d); before graduation %d' % (lagc[int(.1*(len(lagc)-1))], lagc[len(lagc)//2], lagc[int(.9*(len(lagc)-1))], len(lagc), sum(l<0 for l in lagc)))
print('\n-- signal known at entry (close of hour 1) vs peak close over next 14 d, relative to entry close --')
tab('paid DEX profile paid before entry', lambda r: any(t <= r['te'] for t in r['prof']))
tab('any DEX boost paid before entry', lambda r: any(t <= r['te'] for t, _ in r['boosts']))
tab('profile or boost before entry', lambda r: any(t <= r['te'] for t in r['prof']) or any(t <= r['te'] for t, _ in r['boosts']))
known = [r for r in rows if r['cl_known']]
tab('>=1 pump.fun callout before entry', lambda r: sum(t <= r['te'] for t in r['clt']) >= 1, known)
tab('>=5 pump.fun callouts before entry', lambda r: sum(t <= r['te'] for t in r['clt']) >= 5, known)
tab('>=1 callout in the hour after graduation', lambda r: sum(r['grad'] <= t <= r['te'] for t in r['clt']) >= 1, known)
tab('>=3 callouts in the hour after graduation', lambda r: sum(r['grad'] <= t <= r['te'] for t in r['clt']) >= 3, known)
print('\n-- any time (look-ahead, for lead/lag only) --')
tab('paid DEX profile ever', lambda r: bool(r['prof']))
print('\n-- runners (peak >= 10x): when did the first signal arrive vs entry and vs peak? --')
for r in sorted(rows, key=lambda r: -r['peak']):
    if r['peak'] < 10: break
    fp = r['prof'][0] if r['prof'] else None; fb = r['boosts'][0][0] if r['boosts'] else None; fc = r['clt'][0] if r['clt'] else None
    h = lambda t: ('%+.1fh' % ((t - r['te']) / 3600)) if t else '  -  '
    print('%s peak %6.1fx at %+6.1fh | profile %s | boost %s (n=%d, sum %d) | first callout %s, callouts before entry %d of %d%s' % (
        r['mint'][:6], r['peak'], (r['pkt'] - r['te']) / 3600, h(fp), h(fb), len(r['boosts']), sum(a for _, a in r['boosts']), h(fc), sum(t <= r['te'] for t in r['clt']), len(r['clt']), ' (capped)' if r['cl_capped'] else ''))
# lead/lag of profile vs the move: among coins with a profile after entry, was price already up?
print('\n-- for coins whose profile was paid AFTER entry: price at payment hour vs entry close --')
res = []
for x in cs:
    m = x['u']['mint']; r = next((q for q in rows if q['mint'] == m), None)
    if not r or not r['prof']: continue
    t = r['prof'][0]
    if t <= r['te']: continue
    idx = max((i for i, tt in enumerate(x['ts']) if tt <= t), default=None)
    if idx is None or idx < 1: continue
    res.append(x['c'][idx] / x['c'][1])
res.sort()
if res: print('n=%d  median %.2fx  p25 %.2fx  p75 %.2fx  share already >=2x %.0f%%' % (len(res), res[len(res)//2], res[len(res)//4], res[3*len(res)//4], 100*sum(z>=2 for z in res)/len(res)))
