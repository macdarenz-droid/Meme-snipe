"""Swap-level event building for the absorption probe (no returns are computed here).

  python3 -I events.py large <cands.json> <out.json>   # confirm large sales, test the A trigger, set A/C entries
  python3 -I events.py ordinary <cands.json> <events.json> <out.json>  # confirm matched ordinary recoveries (B)

Definitions are the ones frozen in PREREG.md; constants below are those values.
"""
import bisect, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'lottery-probe'))
import hel, swaps, funding, lottery

Q = 50 / lottery.SOL_USD          # $50 in SOL at the repo's fixed rate (0.41925 SOL)
COST_MAX = 0.015
AGE_MIN = 86400
EXTRACT = 0.10                    # one wallet's sells within SALE_WIN extract >= 10% of the effective quote reserve
SALE_WIN = 300
REC_WIN = 3600
K_GROUPS = 5
MAX_SHARE = 0.40
RES_KEEP = 0.80
MIN_BUY = 0.10                    # SOL: a buyer counts toward groups and shares only with >= 0.1 SOL bought after the sale
LAT = (2, 10)
PRE = 6 * 60
POST = 72 * 60
HOT = 1000                        # transactions in the 10 minutes before the bar: at or above it, not processed
POOLX = ThreadPoolExecutor(6)
_age = {}

def pool_birth(pool):
    """Block time of the pool's first successful transaction (its migration)."""
    if pool not in _age:
        r = hel.rpc('getTransactionsForAddress', [pool, {'transactionDetails': 'signatures', 'sortOrder': 'asc', 'limit': 1,
                    'commitment': 'finalized', 'filters': {'status': 'succeeded'}}])
        d = r.get('data') or []
        _age[pool] = d[0]['blockTime'] if d else None
    return _age[pool]

def qeff(s, post=True):
    return ((s.Q1 if post else s.Q0) + s.V) / 1e9

def find_sales(sw, lo_t, hi_t):
    """Qualifying large sales whose first sell has block time in [lo_t, hi_t]. Earliest first sell wins;
    sales of different wallets may overlap (each is listed)."""
    out, used = [], set()
    sells = [i for i, s in enumerate(sw) if s.kind == 'sell']
    for i in sells:
        s1 = sw[i]
        if not (lo_t <= s1.t <= hi_t) or (s1.user, i) in used:
            continue
        ref = s1.Q0 + s1.V
        idx = [j for j in sells if j >= i and sw[j].user == s1.user and sw[j].t <= s1.t + SALE_WIN]
        ext = sum(sw[j].qpool for j in idx)
        if ext >= EXTRACT * ref:
            out.append({'i0': i, 'i1': idx[-1], 'seller': s1.user, 'extract_sol': ext / 1e9, 'extract_share': ext / ref,
                        'n_sells': len(idx)})
            used |= {(s1.user, j) for j in idx}
    return out

class Groups:
    """Union-find over wallets and their (non-hub) funders."""
    def __init__(self):
        self.p = {}
    def f(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def u(self, a, b):
        self.p[self.f(a)] = self.f(b)

_fund_cache = {}
_hub_cache = {}

def wallet_funder(w, sig, t):
    if w not in _fund_cache:
        _fund_cache[w] = funding.funder(w, sig, t)
    f, how = _fund_cache[w]
    if f is None:
        return None, how
    hk = (f, int(t // 86400))
    if hk not in _hub_cache:
        _hub_cache[hk] = funding.is_hub(f, sig, t)
    return (None, 'hub-funded') if _hub_cache[hk] else (f, how)

def state_at(sw, i_trig, L):
    """Index of the last swap with slot <= sw[i_trig].slot + L."""
    j = i_trig
    while j + 1 < len(sw) and sw[j + 1].slot <= sw[i_trig].slot + L:
        j += 1
    return j

def entry_record(sw, i_trig, birth):
    s = sw[i_trig]
    rec = {'trig_slot': s.slot, 'trig_t': s.t, 'trig_sig': s.sig, 'cost_at_trigger': swaps.round_trip_cost(Q, s, lottery.FIXED),
           'fee_bps': round(s.f * 1e4, 1), 'qeff_sol': qeff(s), 'age_h': (s.t - birth) / 3600 if birth else None}
    rec['eligible'] = bool(birth and s.t - birth >= AGE_MIN and rec['cost_at_trigger'] < COST_MAX)
    for L in LAT:
        j = state_at(sw, i_trig, L)
        e = sw[j]
        tok = swaps.buy_tokens(Q, e)
        rec[f'L{L}'] = {'slot': e.slot, 'idx': e.idx, 'k': e.k, 't': e.t, 'P_e': e.p1(), 'tokens_raw': tok,
                        'B': e.B1, 'Qr': e.Q1, 'V': e.V, 'f': e.f, 'complete': j + 1 < len(sw)}
    return rec

def a_trigger(sw, sale, birth):
    """First swap after the sale end, within REC_WIN seconds of it, where price, reserve and funding all pass."""
    s0, se = sw[sale['i0']], sw[sale['i1']]
    p_pre, q_pre = s0.p0(), s0.Q0 + s0.V
    seller = sale['seller']
    g = Groups()
    sf, show = wallet_funder(seller, s0.sig, s0.t)
    if sf:
        g.u(seller, sf)
    buys = {}                       # wallet -> [first sig, first t, SOL]
    known = set()
    checks = 0
    first_price_ok = None
    for i in range(sale['i1'] + 1, len(sw)):
        s = sw[i]
        if s.t > se.t + REC_WIN:
            return None, {'reason': 'no-trigger', 'price_recovered_at': first_price_ok, 'funding_checks': checks,
                          'seller_funder': sf, 'buyers': len(buys)}
        if s.kind == 'buy':
            b = buys.setdefault(s.user, [s.sig, s.t, 0.0]); b[2] += s.quser / 1e9
        if s.p1() < p_pre or (s.Q1 + s.V) < RES_KEEP * q_pre:
            continue
        if first_price_ok is None:
            first_price_ok = s.t - se.t
        new = [w for w in buys if w not in known and buys[w][2] >= MIN_BUY]
        res = list(POOLX.map(lambda w: (w, wallet_funder(w, buys[w][0], buys[w][1])), new))
        for w, (f, how) in res:
            known.add(w)
            if f:
                g.u(w, f)
        checks += 1
        sroot = g.f(seller)
        sol = {}
        for w, (_, _, x) in buys.items():
            if x < MIN_BUY:
                continue
            r = g.f(w)
            sol[r] = sol.get(r, 0.0) + x
        tot = sum(sol.values())
        indep = [r for r in sol if r != sroot]
        top = max(sol.values()) / tot if tot > 0 else 1.0
        if len(indep) >= K_GROUPS and top <= MAX_SHARE:
            return i, {'reason': 'trigger', 'groups': len(indep), 'top_share': top, 'buy_sol': tot,
                       'seller_group_buy_sol': sol.get(sroot, 0.0), 'buyers': len(buys), 'funding_checks': checks,
                       'seller_funder': sf, 'secs_after_sale': s.t - se.t,
                       'funder_how': {h: sum(1 for w in buys if _fund_cache.get(w, (0, '?'))[1] == h) for h in
                                      ('scan', 'oldest-first', 'scan-feepayer', 'oldest-first-feepayer', 'unresolved')}}
    return None, {'reason': 'window-short', 'funding_checks': checks}

def load_window(pool, t0, t1, cache):
    k = (pool, t0, t1)
    if k not in cache:
        sw, mism, ntx = swaps.window(pool, t0, t1)
        cache.clear(); cache[k] = (sw, mism, ntx)
    return cache[k]

def extend_until(pool, sw, t_need):
    """Append later swaps until one exists at or after t_need (dead pools), up to the wall."""
    t = sw[-1].t + 1 if sw else t_need
    step = 3600
    while (not sw or sw[-1].t < t_need) and t < lottery.WALL:
        more, _, _ = swaps.window(pool, t, min(t + step, lottery.WALL))
        sw += more
        t = min(t + step, lottery.WALL); step = min(step * 4, 7 * 86400)
    j = next((i for i, s in enumerate(sw) if s.t >= t_need), None)
    if j is not None:                                     # make sure the L-slot state after it is complete
        more, _, _ = swaps.window(pool, sw[-1].t + 1, sw[-1].t + 60) if sw[-1].slot <= sw[j].slot + max(LAT) else ([], 0, 0)
        sw += [m for m in more if m.key() > sw[-1].key()]
    return j

def large(cands, out, tier='1', ceiling=None):
    """tier 1: bar drop >= 15%; tier 2: 10-15%. Stops before the ledger passes `ceiling` credits."""
    C = json.load(open(cands))['large_drop']
    C = [c for c in C if (c['drop'] >= 0.15) == (tier == '1')]
    ceiling = int(ceiling) if ceiling else hel.CAP
    max_n = int(os.environ.get('AB_MAX_N', '0')) or None
    res = json.load(open(out)) if os.path.exists(out) else {'events': [], 'rejected': [], 'done': []}
    done = set(map(tuple, res['done']))
    seen = {(e['pool'], e['sale_sig']) for e in res['events']}
    cache = {}
    import random
    order = sorted(C, key=lambda x: (x['pool'], x['t']))
    random.Random(20261008).shuffle(order)          # any truncation by the credit cap is a random subsample
    n_new = 0
    for c in order:
        key = (c['pool'], c['t'])
        if key in done:
            continue
        if max_n and n_new >= max_n:
            print('sample size reached'); break
        n_new += 1
        if hel.credits()['credits'] >= ceiling:
            print('ceiling reached'); break
        cr0 = hel.credits()['credits']
        birth = pool_birth(c['pool'])
        if birth is None or c['t'] + 3900 < birth + AGE_MIN:
            res['rejected'].append({'pool': c['pool'], 'bar_t': c['t'], 'bar_drop': c['drop'], 'why': 'pool younger than 24 h at any possible decision',
                                    'credits': hel.credits()['credits'] - cr0})
            res['done'].append(list(key)); _save(res, out); continue
        act = hel.activity(c['pool'], c['t'])
        if act >= HOT:
            res['rejected'].append({'pool': c['pool'], 'bar_t': c['t'], 'bar_drop': c['drop'], 'why': 'too active (>= 1000 tx in 10 min before)',
                                    'credits': hel.credits()['credits'] - cr0})
            res['done'].append(list(key)); _save(res, out); continue
        t0, t1 = c['t'] - PRE, c['t'] + 11 * 60 + 1         # stage 1: enough to find a sale starting by t + 6 min
        try:
            sw, mism, ntx = load_window(c['pool'], t0, t1, cache)
        except hel.WindowTooLarge:
            res['rejected'].append({'pool': c['pool'], 'bar_t': c['t'], 'bar_drop': c['drop'], 'why': 'window over 400 pages',
                                    'activity_10min': act, 'credits': hel.credits()['credits'] - cr0})
            res['done'].append(list(key)); _save(res, out); continue
        sales = find_sales(sw, c['t'] - PRE, c['t'] + 6 * 60)
        if not sales:
            res['rejected'].append({'pool': c['pool'], 'bar_t': c['t'], 'bar_drop': c['drop'], 'why': 'no wallet extracted >= 10%',
                                    'swaps': len(sw), 'activity_10min': act, 'credits': hel.credits()['credits'] - cr0})
        for sale in sales:
            s0, se = sw[sale['i0']], sw[sale['i1']]
            if (c['pool'], s0.sig) in seen:
                continue
            ev = {'pool': c['pool'], 'bar_t': c['t'], 'sale_sig': s0.sig, 'seller': sale['seller'], 'sale_t0': s0.t,
                  'sale_slot0': s0.slot, 'sale_end_t': se.t, 'sale_end_slot': se.slot, 'extract_sol': sale['extract_sol'],
                  'extract_share': sale['extract_share'], 'n_sells': sale['n_sells'], 'pre_B': s0.B0, 'pre_Q': s0.Q0,
                  'pre_V': s0.V, 'pre_price': s0.p0(), 'post_sale_price': se.p1(), 'swaps_in_window': len(sw),
                  'reserve_mismatches': mism, 'pool_birth': birth, 'activity_10min': act}
            try:
                if sw[-1].t < se.t + REC_WIN:                # stage 2: the recovery hour
                    more, _, _ = swaps.window(c['pool'], max(t1, sw[-1].t + 1), se.t + REC_WIN + 120)
                    sw = sw + [m for m in more if m.key() > sw[-1].key()]; cache.clear()
                    t1 = se.t + REC_WIN + 120
                if 'group' not in ev:
                    i_trig, info = a_trigger(sw, sale, birth)
                    ev['trigger'] = info
                    if i_trig is not None:
                        ev['group'] = 'A'
                        ev['entry'] = entry_record(sw, i_trig, birth)
                    else:
                        ev['group'] = 'C'
                        j = extend_until(c['pool'], sw, se.t + REC_WIN)
                        cache.clear()
                        ev['entry'] = entry_record(sw, j, birth) if j is not None else None
            except hel.WindowTooLarge:
                ev['group'] = 'dropped'; ev['why'] = 'a later window passed 400 pages'; cache.clear()
            ev['reserve_mismatches'] = sum(1 for a, b in zip(sw, sw[1:]) if a.B1 != b.B0 or abs(a.Q1 - b.Q0) > 2)
            ev['swaps_in_window'] = len(sw)
            seen.add((c['pool'], s0.sig))
            ev['credits'] = hel.credits()['credits'] - cr0
            res['events'].append(ev)
            print(ev['pool'][:6], ev['group'], round(ev['extract_share'], 3), ev.get('trigger', {}).get('reason'),
                  (ev.get('entry') or {}).get('eligible'), ev['credits'], hel.credits()['credits'], flush=True)
        res['done'].append(list(key))
        _save(res, out)

def overlaps(events):
    """Chronological rule applied after processing: an event whose first sell falls inside an earlier kept
    event's recovery window (sale end + 60 min) in the same pool is marked overlap and not traded."""
    last = {}
    for e in sorted(events, key=lambda e: (e['pool'], e['sale_t0'], e['sale_slot0'])):
        if e['group'] not in ('A', 'C'):
            continue
        if e['sale_t0'] < last.get(e['pool'], -1) + REC_WIN:
            e['overlap'] = True
        else:
            e['overlap'] = False; last[e['pool']] = e['sale_end_t']
    return events

def _save(res, out):
    res['credits_total'] = hel.credits()
    json.dump(res, open(out + '.tmp', 'w'), indent=0); os.replace(out + '.tmp', out)

# ---------- group B: ordinary recoveries ----------
B_DIP = 0.10
B_SELLERS = 5
B_TOP_SELLER = 0.50
B_PRE = 66 * 60                   # swaps from 66 min before the bar candidate (the 60-min reference and the dip)
B_POST = 6 * 60

def b_trigger(sw, lo_t, hi_t):
    """First swap s with block time in [lo_t, hi_t] where: P(s) >= P_ref (price after the last swap at or before
    s.t - 3600); the lowest post-swap price strictly between that reference swap and s is <= (1 - B_DIP) * P_ref;
    the sells from the reference to that low come from >= B_SELLERS wallets with none above B_TOP_SELLER of their
    quote; and no qualifying large sale (find_sales) has its first sell in [s.t - 3600, s.t]."""
    ts = [x.t for x in sw]
    for i, s in enumerate(sw):
        if s.t < lo_t:
            continue
        if s.t > hi_t:
            return None, 'no swap met the rule in the bar window'
        r = bisect.bisect_right(ts, s.t - 3600) - 1
        if r < 0:
            return None, 'reference not covered'
        pref = sw[r].p1()
        if s.p1() < pref or i - r < 2:
            continue
        seg = sw[r + 1:i]
        jm = min(range(len(seg)), key=lambda k: seg[k].p1())
        if seg[jm].p1() > (1 - B_DIP) * pref:
            continue
        sells = {}
        for x in seg[:jm + 1]:
            if x.kind == 'sell':
                sells[x.user] = sells.get(x.user, 0) + x.qpool
        tot = sum(sells.values())
        if len(sells) < B_SELLERS or tot <= 0 or max(sells.values()) / tot > B_TOP_SELLER:
            continue
        if find_sales(sw, s.t - 3600, s.t):
            return None, 'large sale in the prior hour'
        return i, {'P_ref': pref, 'dip': 1 - seg[jm].p1() / pref, 'sellers': len(sells), 'top_seller': max(sells.values()) / tot}
    return None, 'window ended'

def confirm_b(c):
    """Confirm one ordinary-recovery bar candidate on swaps. Returns (event or None, rejection dict or None)."""
    cr0 = hel.credits()['credits']
    def rej(why, **kw):
        return None, dict({'pool': c['pool'], 'bar_t': c['t'], 'why': why, 'credits': hel.credits()['credits'] - cr0}, **kw)
    if c.get('drop_in_prior_2h'):
        return rej('large-drop bar candidate in the prior 2 h')
    birth = pool_birth(c['pool'])
    if birth is None or c['t'] + B_POST < birth + AGE_MIN:
        return rej('pool younger than 24 h')
    act = hel.activity(c['pool'], c['t'])
    if act >= HOT:
        return rej('too active (>= 1000 tx in 10 min before)')
    try:
        sw, mism, ntx = swaps.window(c['pool'], c['t'] - B_PRE, c['t'] + B_POST)
        prev = swaps.last_before(c['pool'], c['t'] - B_PRE)
        if prev is not None:
            sw = [prev] + sw
        i, info = b_trigger(sw, c['t'] - 5 * 60, c['t'] + 5 * 60)
        if i is None:
            return rej(info, swaps=len(sw), activity_10min=act)
        if sw[-1].slot <= sw[i].slot + max(LAT):
            more, _, _ = swaps.window(c['pool'], sw[-1].t + 1, sw[-1].t + 60)
            sw += [m for m in more if m.key() > sw[-1].key()]
    except hel.WindowTooLarge:
        return rej('window over 400 pages', activity_10min=act)
    ev = {'pool': c['pool'], 'bar_t': c['t'], 'group': 'B', 'trigger': info, 'pool_birth': birth,
          'activity_10min': act, 'reserve_mismatches': mism, 'swaps_in_window': len(sw),
          'entry': entry_record(sw, i, birth)}
    ev['credits'] = hel.credits()['credits'] - cr0
    return ev, None

if __name__ == '__main__':
    {'large': large}[sys.argv[1]](*sys.argv[2:])
