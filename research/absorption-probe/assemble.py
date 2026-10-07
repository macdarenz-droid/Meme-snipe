"""Assemble the traded event set, matching features and the group-B matches (no returns).

  python3 -I assemble.py tag <large.json>...  <cands.json> <out events.json>   # A/C set with features
  python3 -I assemble.py match <events.json> <cands.json> <out events.json>    # confirm and match B (3 per A)
"""
import bisect, datetime, json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import events, hel, screen
SCRATCH = os.environ.get('AB_SCRATCH') or sys.exit('set AB_SCRATCH')
WALL = 1789999200
SPLIT = 1787270400                  # 2026-08-21T00:00Z: period A before, period B from
H = 3600
B_PER_A = 3
B_TRIES = 8

def hourly(pool):
    p = os.path.join(SCRATCH, 'gt_hourly', pool + '.json')
    return {int(r[0]): [float(x) for x in r[1:6]] for r in json.load(open(p))} if os.path.exists(p) else {}

def close_at(bars, t, step):
    """Close of the last complete bar ending at or before t (carried; None if none in the prior 7 days)."""
    k = t - t % step - step
    for _ in range(7 * 86400 // step):
        if k in bars:
            return bars[k][3]
        k -= step
    return None

def feats(pool, t, qeff, birth, mb, hb):
    c_now_m, c_1h = close_at(mb, t, 60), close_at(mb, t - H, 60)
    c_now_h, c_24h = close_at(hb, t, H), close_at(hb, t - 24 * H, H)
    r1 = (c_now_m / c_1h - 1) if c_now_m and c_1h else None
    r24 = (c_now_h / c_24h - 1) if c_now_h and c_24h else None
    age = (t - birth) / 86400 if birth else None
    return {'age_b': None if age is None else (0 if age < 7 else 1 if age < 30 else 2),
            'liq_b': None if qeff is None else (0 if qeff < 1000 else 1 if qeff < 2500 else 2),
            'r1_b': None if r1 is None else (0 if r1 < -0.05 else 1 if r1 <= 0.05 else 2),
            'r24_b': None if r24 is None else (0 if r24 < -0.2 else 1 if r24 <= 0.2 else 2),
            'week': datetime.datetime.fromtimestamp(t, datetime.UTC).isocalendar()[1],
            'period': 'A' if t < SPLIT else 'B', 'r1': r1, 'r24': r24, 'age_d': age, 'qeff': qeff}

def tag(*args):
    *srcs, cands, out = args
    evs = []
    for s in srcs:
        evs += [e for e in json.load(open(s))['events']]
    events.overlaps(evs)
    mcache = {}
    for n, e in enumerate(sorted(evs, key=lambda e: (e['sale_t0'], e['pool']))):
        e['id'] = f"{e['group']}{n:04d}"
        en = e.get('entry')
        ok = e['group'] in ('A', 'C') and not e.get('overlap') and en and en['eligible'] and en['L10']['complete'] and en['L10']['t'] < WALL
        e['traded'] = bool(ok)
        if not ok:
            e['not_traded_why'] = ('overlap' if e.get('overlap') else 'no entry' if not en else 'ineligible' if not en['eligible']
                                   else 'entry state incomplete' if not en['L10']['complete'] else e['group'])
            continue
        p = e['pool']
        if p not in mcache:
            mcache[p] = (screen.bars(p) or {}, hourly(p))
        mb, hb = mcache[p]
        e['feat'] = feats(p, en['L10']['t'], en['qeff_sol'], e['pool_birth'], mb, hb)
    json.dump({'events': evs}, open(out, 'w'), indent=0)
    from collections import Counter
    print(Counter((e['group'], e['traded']) for e in evs))

def match(evfile, cands, out):
    D = json.load(open(evfile))
    res = json.load(open(out)) if os.path.exists(out) else {'events': D['events'], 'b_events': [], 'b_rejected': [], 'tried': []}
    tried = set(map(tuple, res['tried']))
    used = {(b['pool'], b['bar_t']) for b in res['b_events']}
    C = [c for c in json.load(open(cands))['recovery'] if not c.get('drop_in_prior_2h')]
    births, mcache = {}, {}
    def bfeat(c):
        p = c['pool']
        if p not in mcache:
            mcache[p] = (screen.bars(p) or {}, hourly(p))
        if p not in births:
            births[p] = events.pool_birth(p)
        return feats(p, c['t'], None, births[p], *mcache[p])
    A = sorted([e for e in res['events'] if e.get('traded') and e['group'] == 'A'], key=lambda e: e['entry']['L10']['t'])
    rng = random.Random(20261010)
    for a in A:
        have = [b for b in res['b_events'] if b.get('matched_to') == a['id']]
        if len(have) >= B_PER_A or a['id'] in {x[0] for x in tried if x[1] == 'closed'}:
            continue
        fa = a['feat']
        levels = [
            lambda f: f['week'] == fa['week'] and f['age_b'] == fa['age_b'] and f['r1_b'] == fa['r1_b'] and f['r24_b'] == fa['r24_b'],
            lambda f: abs(f['week'] - fa['week']) <= 1 and f['age_b'] == fa['age_b'] and f['r1_b'] == fa['r1_b'] and f['r24_b'] == fa['r24_b'],
            lambda f: abs(f['week'] - fa['week']) <= 1 and f['age_b'] == fa['age_b'] and f['r1_b'] == fa['r1_b'],
            lambda f: abs(f['week'] - fa['week']) <= 1 and f['age_b'] == fa['age_b'],
            lambda f: f['period'] == fa['period'] and f['age_b'] == fa['age_b'],
            lambda f: f['period'] == fa['period'],
        ]
        tries = sum(1 for x in tried if x[0] == a['id'])
        for lv, fn in enumerate(levels):
            if len(have) >= B_PER_A or tries >= B_TRIES:
                break
            pool_c = [c for c in C if (c['pool'], c['t']) not in used and (c['pool'], c['t']) not in {(x[2], x[3]) for x in tried}]
            pool_c = [c for c in pool_c if c['t'] + 3600 < WALL]
            fc = [(c, bfeat(c)) for c in pool_c]
            fc = [(c, f) for c, f in fc if None not in (f['age_b'], f['r1_b'], f['r24_b']) and fn(f)]
            fc.sort(key=lambda x: (x[0]['pool'], x[0]['t']))
            rng.shuffle(fc)
            for c, f in fc:
                if len(have) >= B_PER_A or tries >= B_TRIES:
                    break
                ev, rej = events.confirm_b(c)
                tries += 1
                res['tried'].append([a['id'], lv, c['pool'], c['t']]); tried.add((a['id'], lv, c['pool'], c['t']))
                if ev is None:
                    res['b_rejected'].append(dict(rej, for_a=a['id'], level=lv))
                else:
                    en = ev['entry']
                    ev['feat'] = feats(c['pool'], en['L10']['t'], en['qeff_sol'], ev['pool_birth'], *mcache[c['pool']])
                    okm = en['eligible'] and en['L10']['complete'] and ev['feat']['liq_b'] == fa['liq_b'] and fn(ev['feat'])
                    ev['id'] = f"B{len(res['b_events']):04d}"
                    ev['matched_to'] = a['id'] if okm else None
                    ev['match_level'] = lv if okm else None
                    ev['traded'] = bool(okm)
                    if not okm:
                        ev['not_traded_why'] = 'ineligible' if not en['eligible'] else 'features differ at entry'
                    res['b_events'].append(ev); used.add((c['pool'], c['t']))
                    if okm:
                        have.append(ev)
                json.dump(res, open(out + '.tmp', 'w'), indent=0); os.replace(out + '.tmp', out)
                print(a['id'], lv, 'B' if ev else rej['why'], len(have), hel.credits()['credits'], flush=True)
        res['tried'].append([a['id'], 'closed', '', 0])
        json.dump(res, open(out + '.tmp', 'w'), indent=0); os.replace(out + '.tmp', out)

if __name__ == '__main__':
    {'tag': tag, 'match': match}[sys.argv[1]](*sys.argv[2:])
