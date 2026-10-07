"""Brainstorm ideas 1 (socials), creator history, and 2 (slow graduation). EXPLORATION window only (created before 2026-08-21).
Part A: all graduates, outcome proxy = pump.fun ath_market_cap / graduation cap (410.8 SOL x SOL/USD that day). ATH is used ONLY as the outcome.
Part B: the 900-coin exploration hourly sample, runner sims split by the same creation-time features."""
import json, sys, math, collections, datetime, statistics
S = '/tmp/claude-0/-home-user-Meme-snipe/b87ffbbf-f1e1-5a15-b7d3-6a3e38afe9c2/scratchpad'
VAL_START = int(datetime.datetime(2026, 8, 21, tzinfo=datetime.UTC).timestamp()) * 1000
GRAD_SOL = 4.108e-7 * 1e9
sol = {int(r['t']) // 86400000: float(r['c']) for r in json.load(open(S + '/maze/hl/candles_1d_SOL.json'))}
rows, seen = [], set()
for l in open(S + '/socials/grads_socials.jsonl'):
    r = json.loads(l)
    if r['mint'] in seen: continue
    seen.add(r['mint']); rows.append(r)
allrows = sorted(rows, key=lambda r: r['created_timestamp'])
# creator history: graduates by the same creator created BEFORE this coin (any time in the collected window)
prior = {}; cnt = collections.Counter()
for r in allrows:
    prior[r['mint']] = cnt[r['creator']]; cnt[r['creator']] += 1
ex = [r for r in allrows if r['created_timestamp'] < VAL_START]
def s(v): return bool(v and str(v).strip())
def tw_kind(u):
    if not s(u): return 'none'
    u = u.lower()
    if '/status/' in u: return 'tweet-link'
    if '/communities/' in u or '/i/communit' in u: return 'community'
    if 'x.com/' in u or 'twitter.com/' in u: return 'account'
    return 'other'
def feats(r):
    n = s(r['twitter']) + s(r['website']) + s(r['telegram'])
    p = prior[r['mint']]
    return {'twitter': tw_kind(r['twitter']), 'website': s(r['website']), 'telegram': s(r['telegram']), 'n_socials': n,
            'creator_prior_grads': '0' if p == 0 else ('1' if p == 1 else '2+'), 'nsfw': bool(r['nsfw']),
            'cashback': bool(r['is_cashback_enabled']), 'holder_reward': bool(r['is_holder_reward']),
            'quote': 'native' if r['quote_mint'] == '11111111111111111111111111111111' else 'wsol/other'}
def wilson(k, n, z=1.96):
    if n == 0: return (0, 0)
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)
def mult(r):
    px = sol.get(r['created_timestamp'] // 86400000)
    if not px or not r['ath_market_cap']: return None
    return r['ath_market_cap'] / (GRAD_SOL * px)
if __name__ == '__main__' and sys.argv[1] == 'A':
    data = [(feats(r), mult(r)) for r in ex]
    data = [(f, m) for f, m in data if m is not None]
    print('Part A graduates (exploration window):', len(data), 'of', len(ex))
    base = {k: sum(m >= k for _, m in data) / len(data) for k in (3, 10, 50)}
    print('base rates  >=3x %.2f%%  >=10x %.2f%%  >=50x %.3f%%' % tuple(100 * base[k] for k in (3, 10, 50)))
    for key in ['twitter', 'website', 'telegram', 'n_socials', 'creator_prior_grads', 'nsfw', 'cashback', 'holder_reward', 'quote']:
        print('--', key)
        g = collections.defaultdict(list)
        for f, m in data: g[f[key]].append(m)
        for val in sorted(g, key=str):
            ms = g[val]; n = len(ms)
            out = []
            for k in (3, 10, 50):
                c = sum(m >= k for m in ms); lo, hi = wilson(c, n)
                out.append(f'>={k}x {100*c/n:5.2f}% [{100*lo:5.2f},{100*hi:5.2f}] (lift {c/n/base[k]:4.2f})')
            print(f'   {str(val):11s} n={n:6d}  ' + '  '.join(out))
if __name__ == '__main__' and sys.argv[1] == 'B':
    sys.argv = sys.argv[:1]
    sys.path.insert(0, S)
    import brainstorm1 as b1   # prints its own table first; reuse its coins and sim
    fm = {r['mint']: feats(r) for r in ex}
    miss = sum(1 for x in b1.cs if x['u']['mint'] not in fm)
    print('\nPart B exploration hourly sample: coins', len(b1.cs), 'missing socials row', miss)
    groups = {
        'twitter any': lambda f: f['twitter'] != 'none', 'twitter none': lambda f: f['twitter'] == 'none',
        'twitter account': lambda f: f['twitter'] == 'account', 'twitter tweet-link': lambda f: f['twitter'] == 'tweet-link',
        'twitter community': lambda f: f['twitter'] == 'community',
        'website yes': lambda f: f['website'], 'telegram yes': lambda f: f['telegram'],
        'socials 0': lambda f: f['n_socials'] == 0, 'socials 2+': lambda f: f['n_socials'] >= 2,
        'creator first grad': lambda f: f['creator_prior_grads'] == '0', 'creator repeat': lambda f: f['creator_prior_grads'] != '0',
    }
    for name, g in groups.items():
        for kw, lab in (({}, 'R2'), ({'leash': True}, 'leash')):
            b1.report(f'{name} [{lab}]', pick=lambda x, g=g: x['u']['mint'] in fm and g(fm[x['u']['mint']]), **kw)
    for kw, lab in (({}, 'R2'), ({'leash': True}, 'leash')):
        b1.report(f'IDEA2 slow grad (>=1h) [{lab}]', pick=lambda x: x['slow'], **kw)
        b1.report(f'IDEA2 fast grad (<1h) [{lab}]', pick=lambda x: not x['slow'], **kw)
