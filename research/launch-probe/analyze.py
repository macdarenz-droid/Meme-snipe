"""Launch-probe replay and statistics (rules in PREREG.md, fixed before any return was computed).

  LP_SCRATCH=... python3 -I analyze.py discovery    # all pairs on discovery; picks and writes derived/primary.json
  LP_SCRATCH=... python3 -I analyze.py validation   # needs derived/primary.json committed first
"""
import bisect, json, math, os, random, statistics, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'lottery-probe'))
import lottery

SCR = os.environ.get('LP_SCRATCH') or sys.exit('LP_SCRATCH not set')
DERIVED = os.path.join(HERE, 'derived')
B = 10 / lottery.SOL_USD                        # SOL spent per entry, fees included
BL = int(B * 1e9)
FIXED = lottery.FIXED                           # SOL per round trip (network base + priority fee)
TIP = 0.001                                     # SOL per transaction, stress line
LS = (2, 10, 40, 120, 480)
EXITS = ('T1', 'T5', 'T15', 'T60', 'ST2', 'ST10', 'MG2', 'MG10')
HOLD = {'T1': 60, 'T5': 300, 'T15': 900, 'T60': 3600}
NBOOT = 10_000
WINDOWS = {'discovery': (1784678400, 1787270400), 'validation': (1787270400, 1788739200)}
BOOT_SEED = 20261074

def slot_len_fn():
    d = json.load(open(os.path.join(DERIVED, 'slot_len.json')))['sec_per_slot_by_day_start']
    return lambda t: d[str(t // 86400 * 86400)]

SOL_QUOTES = (None, '11111111111111111111111111111111', 'So11111111111111111111111111111111111111112')

def create_event(sig):
    """The cached create transaction's CreateEvent."""
    sys.path.insert(0, HERE)
    import pumpdec
    t = json.load(open(os.path.join(SCR, 'raw', 'tx_' + sig + '.json')))
    for kind, k, e in pumpdec.events(t):
        if kind == 'create':
            return e
    raise RuntimeError('create event missing')

class Coin:
    """Merged, ordered event stream of one launch: curve trades (post-trade state), completion, pool swaps."""
    def __init__(self, rec):
        self.L = rec['launch']
        self.bad = sum(1 for r in rec['trades'] if r[-1] == 'undecodable')
        tr = [r for r in rec['trades'] if r[-1] != 'undecodable']
        ce = create_event(self.L['sig'])
        v0, t0, r0, rt0 = ce['vsol'], ce['vtok'], 0, ce['rtok']
        self.sol_quote = ce['quote_mint'] in SOL_QUOTES
        self.creators = {ce['creator'], ce['user']}
        self.init = (v0, t0, r0, rt0, 95, 30)
        # chain check on real reserves: each trade's pre-state equals the previous post-state (a missing trade
        # breaks it). Virtual reserves are not used: in mayhem-mode coins they move outside the logged amounts.
        self.breaks = self.vjumps = 0
        pr, pt, pv = r0, rt0, (v0, t0)
        for r in tr:
            buy, sa, ta, vs, vt, rs, rt = r[4], r[5], r[6], r[7], r[8], r[9], r[10]
            pre = (rs - sa, rt + ta) if buy else (rs + sa, rt - ta)
            if pre != (pr, pt):
                self.breaks += 1
            vpre = (vs - sa, vt + ta) if buy else (vs + sa, vt - ta)
            if vpre != pv:
                self.vjumps += 1
            pr, pt, pv = rs, rt, (vs, vt)
        self.mayhem = any(r[14] for r in tr)
        self.trades = tr
        self.tkeys = [tuple(r[:3]) for r in tr]
        self.complete = tuple(rec['completes'][0][:3]) if rec['completes'] else None
        self.complete_t = rec['completes'][0][3] if rec['completes'] else None
        self.swaps = rec['swaps']
        self.thinned = bool(rec.get('pool_thinned'))
        self.fill_fallback = False
        self.skeys = [tuple(s[:3]) for s in self.swaps]
        ev = [('c', tuple(r[:3]), r[3], i) for i, r in enumerate(tr)]
        ev += [('p', tuple(s[:3]), s[3], i) for i, s in enumerate(self.swaps)]
        if self.complete:
            ev.append(('x', self.complete, self.complete_t, 0))
        ev.sort(key=lambda e: (e[1], {'c': 0, 'x': 1, 'p': 2}[e[0]]))
        self.ev = ev
        self.unpriced = False

    def curve_at(self, key):
        i = bisect.bisect_right(self.tkeys, key) - 1
        if i < 0:
            return self.init
        r = self.trades[i]
        return (r[7], r[8], r[9], r[10], r[11], r[12])

    def completed(self, key):
        return self.complete is not None and self.complete <= key

    def value(self, tokens, our_sol, key):
        """SOL proceeds of selling `tokens` at the state after every event with key <= `key`."""
        if not self.completed(key):
            vs, vt, rs, rt, f, c = self.curve_at(key)
            gross = min(tokens * vs // (vt + tokens), rs + our_sol)
            return (gross - math.ceil(gross * f / 1e4) - math.ceil(gross * c / 1e4)) / 1e9
        j = bisect.bisect_right(self.skeys, key) - 1
        if j >= 0:
            s = self.swaps[j]
            Bq, Qq, V, f = s[7], s[8], s[6], s[9]
        elif self.swaps:
            s = self.swaps[0]
            Bq, Qq, V, f = s[4], s[5], s[6], s[9]
        else:                                   # completed, pool not traded in the horizon: last curve state
            self.unpriced = True                # optimistic: sells at the final curve price though no sale was possible
            vs, vt, rs, rt, f, c = self.curve_at(key)
            gross = min(tokens * vs // (vt + tokens), rs + our_sol)
            return (gross - math.ceil(gross * f / 1e4) - math.ceil(gross * c / 1e4)) / 1e9
        Qe = Qq + V
        return Qe * tokens / (Bq + tokens) * (1 - f) / 1e9

def last_key_by_slot(coin, slot):
    return (slot, 1 << 62, 1 << 62)

def last_key_by_time(coin, t):
    """Key of the last event with block time <= t (None-safe: the creation key if none)."""
    k = (coin.L['slot'], coin.L['idx'], 1 << 62)
    for e in coin.ev:
        if e[2] <= t:
            k = e[1]
        else:
            break
    return k

def fill_key(coin, slot):
    """State a sell landing in `slot` sees. Exact on the curve and on fully fetched pools. On a thinned pool
    (amendment 3) the swaps up to `slot` may be unfetched, so the sell is priced at the first fetched swap at or
    after `slot` (the last one if none): a later, never earlier, state."""
    key = last_key_by_slot(coin, slot)
    if not (coin.thinned and coin.completed(key)):
        return key
    for k in coin.skeys:
        if k[0] >= slot:
            return last_key_by_slot(coin, k[0])     # after every fetched swap of that slot (all are fetched)
    coin.fill_fallback = True                       # no fetched swap at or after the fill slot: last one
    return key

def entry(coin, L, slotlen):
    s_e = coin.L['slot'] + L
    key = last_key_by_slot(coin, s_e)
    if coin.completed(key):
        return None
    vs, vt, rs, rt, f, c = coin.curve_at(key)
    sol = int(BL * 1e4 // (1e4 + f + c))
    tok = min(sol * vt // (vs + sol), rt)
    t_e = coin.L['time'] + L * slotlen(coin.L['time'])
    return {'s_e': s_e, 't_e': t_e, 'sol': sol, 'tok': tok}

def exits(coin, en):
    tok, sol, s_e, t_e = en['tok'], en['sol'], en['s_e'], en['t_e']
    out = {}
    for name, h in HOLD.items():
        out[name] = coin.value(tok, sol, last_key_by_time(coin, t_e + h))
    t60 = out['T60']
    # stop -30% / trail 40% after 2x, marks on every event after the entry slot
    trig = None
    peak = 0.0
    for e in coin.ev:
        if e[1][0] <= s_e or e[0] == 'x':
            continue
        if e[2] > t_e + 3600:
            break
        m = coin.value(tok, sol, e[1]) / B
        peak = max(peak, m)
        if m <= 0.70 or (peak >= 2.0 and m <= 0.60 * peak):
            trig = e[1][0]
            break
    for d in (2, 10):
        out['ST%d' % d] = t60 if trig is None else coin.value(tok, sol, fill_key(coin, trig + d))
    # first pool swap after migration
    first = coin.swaps[0] if coin.swaps else None
    for d in (2, 10):
        if first is not None and first[3] <= t_e + 3600 and first[0] > s_e:
            out['MG%d' % d] = coin.value(tok, sol, last_key_by_slot(coin, first[0] + d))
        else:
            out['MG%d' % d] = t60
    return out

def filters(coin, s_e):
    cr = coin.creators                          # CreateEvent creator and signer (user)
    buyers = {r[13] for r in coin.trades if r[0] <= s_e and r[4] and r[13] not in cr}
    dev = sum(r[5] for r in coin.trades if r[0] == coin.L['slot'] and r[1] == coin.L['idx'] and r[4] and r[13] in cr)
    return {'F1': len(buyers) >= 5, 'F2': dev >= 1_000_000_000}

def ret(proceeds, stress):
    return (proceeds - FIXED - (2 * TIP if stress else 0)) / B - 1

def boot(rows, seed=BOOT_SEED):
    """rows: list of (day, r). Day-clustered bootstrap of the mean (total / count). Returns (lo, hi, p_le0)."""
    by = {}
    for d, r in rows:
        by.setdefault(d, []).append(r)
    days = [(sum(v), len(v)) for v in by.values()]
    rng = random.Random(seed)
    ms = []
    for _ in range(NBOOT):
        s = c = 0
        for _ in days:
            a, b = days[rng.randrange(len(days))]
            s += a; c += b
        ms.append(s / c)
    ms.sort()
    return ms[int(0.025 * NBOOT)], ms[int(0.975 * NBOOT) - 1], sum(1 for m in ms if m <= 0) / NBOOT

def stats(rows):
    if not rows:
        return {'n': 0}
    rs = [r for _, r in rows]
    lo, hi, p = boot(rows)
    return {'n': len(rs), 'days': len({d for d, _ in rows}), 'mean': statistics.fmean(rs), 'median': statistics.median(rs),
            'win': sum(r > 0 for r in rs) / len(rs), 'ge2x': sum(r >= 1 for r in rs) / len(rs),
            'mean_cap20x': statistics.fmean(min(r, 19) for r in rs), 'ci95': [lo, hi], 'p_le0': p,
            'max_multiple': 1 + max(rs)}

def load_window(w):
    d = json.load(open(os.path.join(DERIVED, 'sample_%s.json' % w)))
    # the analysed sample: the completed prefix of the random fetch order (amendment 3)
    order = json.load(open(os.path.join(DERIVED, 'fetch_order.json')))
    prefix = set(order[:json.load(open(os.path.join(DERIVED, 'fetch_report.json')))['prefix_complete']])
    t0, t1 = WINDOWS[w]
    coins, dropped = [], {'outside_window': 0, 'non_sol_quote': 0, 'missing_events': 0}
    for x in d:
        for L in x['launches']:
            if L['sig'] not in prefix:
                continue
            if not t0 <= L['time'] < t1:        # the anchor may sit up to 20 s after the drawn instant
                dropped['outside_window'] += 1; continue
            p = os.path.join(SCR, 'events', L['sig'] + '.json')
            if not os.path.exists(p):
                dropped['missing_events'] += 1; continue
            c = Coin(json.load(open(p)))
            if not c.sol_quote:
                dropped['non_sol_quote'] += 1; continue
            coins.append(c)
    return coins, dropped

def run(w):
    slotlen = slot_len_fn()
    coins, dropped = load_window(w)
    per = {}
    meta = {'launches': len(coins), 'dropped': dropped, 'chain_breaks_coins': sum(1 for c in coins if c.breaks),
            'mayhem_coins': sum(1 for c in coins if c.mayhem),
            'virtual_jump_coins': sum(1 for c in coins if c.vjumps),
            'undecodable_coins': sum(1 for c in coins if c.bad),
            'graduated_60m': sum(1 for c in coins if c.complete_t is not None and c.complete_t <= c.L['time'] + 3600),
            'migrated_pool_60m': sum(1 for c in coins if c.swaps and c.swaps[0][3] <= c.L['time'] + 3600),
            'no_entry': {}, 'sec': {}}
    meta['graduation_rate_60m'] = meta['graduated_60m'] / len(coins)
    for L in LS:
        meta['sec'][L] = statistics.fmean(L * slotlen(c.L['time']) for c in coins)
        ne = 0
        for c in coins:
            en = entry(c, L, slotlen)
            if en is None:
                ne += 1; continue
            ex = exits(c, en)
            day = c.L['time'] // 86400
            fl = filters(c, en['s_e'])
            for k, v in ex.items():
                per.setdefault((L, k), []).append((day, v, fl, bool(c.breaks)))
        meta['no_entry'][L] = ne
    meta['unpriced_coins'] = sum(1 for c in coins if c.unpriced)
    meta['pool_thinned_coins'] = sum(1 for c in coins if c.thinned)
    meta['st_fill_fallback_coins'] = sum(1 for c in coins if c.fill_fallback)
    res = {}
    for (L, k), rows in per.items():
        res['L%d_%s' % (L, k)] = {
            'base': stats([(d, ret(v, False)) for d, v, _, _ in rows]),
            'stress': stats([(d, ret(v, True)) for d, v, _, _ in rows]),
            'base_no_chain_breaks': {'mean': statistics.fmean([ret(v, False) for d, v, _, b in rows if not b] or [float('nan')])},
        }
    return meta, res, per

def committed(path):
    r = subprocess.run(['git', '-C', HERE, 'log', '--oneline', '-1', '--', path], capture_output=True, text=True)
    st = subprocess.run(['git', '-C', HERE, 'status', '--porcelain', '--', path], capture_output=True, text=True)
    return bool(r.stdout.strip()) and not st.stdout.strip()

def main(w):
    if w == 'validation' and not committed(os.path.join(DERIVED, 'primary.json')):
        sys.exit('derived/primary.json must be committed before the validation run')
    meta, res, per = run(w)
    out = {'window': w, 'meta': meta, 'pairs': res}
    if w == 'discovery':
        best = max((k for k in res if res[k]['base']['n']), key=lambda k: (res[k]['base']['ci95'][0], res[k]['base']['mean']))
        json.dump({'primary': best, 'rule': 'highest discovery base-line bootstrap lower bound; ties by mean',
                   'discovery': res[best]}, open(os.path.join(DERIVED, 'primary.json'), 'w'), indent=1)
    else:
        prim = json.load(open(os.path.join(DERIVED, 'primary.json')))['primary']
        L, k = prim.split('_', 1)
        rows = per[(int(L[1:]), k)]
        fr = {}
        for f in ('F1', 'F2'):
            sub = [(d, v) for d, v, fl, _ in rows if fl[f]]
            fr[f] = {'base': stats([(d, ret(v, False)) for d, v in sub]),
                     'stress': stats([(d, ret(v, True)) for d, v in sub])}
        ps = sorted(((fr[f]['base'].get('p_le0', 1.0), f) for f in fr))
        holm, prev = {}, 0.0
        for i, (p, f) in enumerate(ps):
            prev = max(prev, min(1.0, (len(ps) - i) * p))
            holm[f] = prev
        for f in fr:
            fr[f]['holm_p'] = holm[f]
            b, s = fr[f]['base'], fr[f]['stress']
            fr[f]['passes'] = bool(b.get('n') and holm[f] < 0.05 and b['ci95'][0] > 0 and s['mean'] > 0)
        pb, psr = res[prim]['base'], res[prim]['stress']
        prim_pass = pb['n'] > 0 and pb['mean'] > 0 and pb['ci95'][0] > 0 and psr['mean'] > 0
        out['primary'] = prim
        out['filters'] = fr
        out['verdict'] = 'promising' if prim_pass or any(fr[f]['passes'] for f in fr) else 'not supported'
    json.dump(out, open(os.path.join(DERIVED, 'results_%s.json' % w), 'w'), indent=1)
    print(json.dumps({'meta': meta, 'primary': out.get('primary'), 'verdict': out.get('verdict')}, indent=1))

if __name__ == '__main__':
    main(sys.argv[1])
