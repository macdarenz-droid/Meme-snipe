#!/usr/bin/env python3
"""RES-2 copy-trading test. Implements PREREG.md.

Usage:
  python3 analyze.py dev     # development split inside F only (never reads data after 14:00)
  python3 analyze.py final   # pre-registered windows: formation [12:37,14:00), test [14:00,14:50), exits to 15:20
  python3 analyze.py replay derived/final_replay.json.gz   # recompute every test cell from the committed subset
  ADVERSE=0 python3 analyze.py replay ...                  # sensitivity: no adverse fill
Input: data/raw/trades_*.jsonl.gz (collect.mjs). Output: derived/<mode>_*.json|csv and stdout tables.
"""
import sys, os, json, gzip, glob, random, statistics, urllib.request, base64, time, datetime as dt, collections

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'data', 'raw')
OUT = os.path.join(HERE, 'derived')
WSOL = 'So11111111111111111111111111111111111111112'
CURVE_FEE = 0.0125          # pump.fun bonding curve, per side (PREREG)
ADVERSE = float(os.environ.get('ADVERSE', '0.005'))  # adverse fill/MEV per side
FIXED_SOL = 0.00026         # per round trip
DELAYS = [1, 5, 25, 75]
SIZES_USD = [2, 5, 50, 200]
TIME_STOP_S = 30 * 60
STOP, TP = -0.30, 0.50
MIN_SIGNAL_SOL = 0.05


def ts(s):
    return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())


MODE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("dev", "final") else "dev"
if MODE == 'final':
    F0, F1, T0, T1, X1 = ts('2026-10-03T12:37:00Z'), ts('2026-10-03T14:00:00Z'), ts('2026-10-03T14:00:00Z'), ts('2026-10-03T14:50:00Z'), ts('2026-10-03T15:20:00Z')
else:  # dev: split the data collected so far, all before 14:00 (F only): 60% formation, next 25% pseudo-test
    F0 = ts('2026-10-03T12:37:00Z'); X1 = min(int(os.environ.get('DEV_END', time.time() - 60)), ts('2026-10-03T14:00:00Z'))
    F1 = T0 = F0 + int(0.6 * (X1 - F0)); T1 = F0 + int(0.85 * (X1 - F0))

ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n:
        n, r = divmod(n, 58); s = ALPH[r] + s
    for c in b:
        if c: break
        s = '1' + s
    return s


def rpc(method, params):
    for i in range(8):
        try:
            req = urllib.request.Request('https://api.mainnet-beta.solana.com', data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), headers={'content-type': 'application/json'})
            r = json.load(urllib.request.urlopen(req, timeout=60))
            if 'error' in r and r['error'].get('code') == 429:
                time.sleep(3 * (i + 1)); continue
            return r
        except Exception:
            time.sleep(3 * (i + 1))
    return {}


# ---------------------------------------------------------------- load
def load():
    """Returns trades sorted by (slot, recv order) with block time <= X1, plus creation info and pool map."""
    trades = []  # (slot, seq, bt, mint_or_pool, venue, user, is_buy, user_sol, tok, sA, tA, fee, creator)
    created = {}  # mint -> (slot, creator)
    pool_new = {}  # pool -> (base, quote)
    calib = {}  # pool -> effective/event base reserve
    seq = 0
    for f in sorted(glob.glob(os.path.join(RAW, 'trades_*.jsonl.gz'))):
        try:
            fh = gzip.open(f, 'rt')
            for line in fh:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                seq += 1
                k = r[0]
                if k == 'P':
                    bt = r[13]
                    if bt > X1: continue
                    sol, tok, vs, vt = int(r[7]), int(r[8]), int(r[9]), int(r[10])
                    buy = r[6] == 1
                    us = sol * (1 + CURVE_FEE) if buy else sol * (1 - CURVE_FEE)
                    # state after trade: virtual reserves (curve)
                    trades.append((r[1], seq, bt, r[4], 'c', r[5], buy, us, tok, vs, vt, CURVE_FEE, r[12]))
                elif k == 'A':
                    bt = r[14]
                    if bt > X1: continue
                    buy = r[6] == 1
                    q_user, base_amt, qb, bb, lp, pr, cr, q_gross = int(r[7]), int(r[8]), int(r[9]), int(r[10]), int(r[11]), int(r[12]), int(r[13] or 0), int(r[15])
                    lpfee = q_gross * lp // 10000
                    # The event's base reserve does not price fills exactly on some pools (validate_fills.py): derive
                    # the effective base reserve from this trade's own amounts, c = B_eff / B, kept per pool.
                    if q_gross >= 1_000_000 and base_amt > 0 and qb > 0:
                        b_eff = base_amt * (qb + q_gross) / q_gross if buy else qb * base_amt / q_gross - base_amt
                        if b_eff > 0: calib[r[4]] = b_eff / bb
                    c = calib.get(r[4], 1.0)
                    if buy:
                        qa, ba = qb + q_gross + lpfee, c * bb - base_amt
                    else:
                        qa, ba = qb - (q_gross - lpfee), c * bb + base_amt
                    fee = (lp + pr + cr) / 1e4
                    trades.append((r[1], seq, bt, r[4], 'a', r[5], buy, q_user, base_amt, qa, ba, fee, None))
                elif k == 'C':
                    b = base64.b64decode(r[4]); o = 8
                    for _ in range(3):
                        n = int.from_bytes(b[o:o + 4], 'little'); o += 4 + n
                    mint = b58(b[o:o + 32]); user = b58(b[o + 64:o + 96]); creator = b58(b[o + 96:o + 128])
                    created[mint] = (r[1], {user, creator})
                elif k == 'N':
                    b = base64.b64decode(r[4])
                    pool_new[b58(b[173:205])] = (b58(b[50:82]), b58(b[82:114]))
        except (EOFError, OSError, gzip.BadGzipFile):
            pass  # the file being written may end mid-block
    trades.sort(key=lambda t: (t[0], t[1]))
    return trades, created, pool_new


def map_pools(pools, known):
    cache_f = os.path.join(OUT, 'pool_map.json')
    cache = json.load(open(cache_f)) if os.path.exists(cache_f) else {}
    cache.update({p: list(v) for p, v in known.items()})
    need = [p for p in pools if p not in cache]
    for i in range(0, len(need), 100):
        chunk = need[i:i + 100]
        r = rpc('getMultipleAccounts', [chunk, {'encoding': 'base64'}])
        vals = (r.get('result') or {}).get('value') or [None] * len(chunk)
        for p, v in zip(chunk, vals):
            if v and v['data'][0]:
                b = base64.b64decode(v['data'][0])
                if len(b) >= 107: cache[p] = [b58(b[43:75]), b58(b[75:107])]
        time.sleep(0.3)
    json.dump(cache, open(cache_f, 'w'))
    return cache


# ---------------------------------------------------------------- fills
def buy_fill(state, q):
    """state=(venue, solRes, tokRes, fee). q = SOL spent including fees. Returns tokens received."""
    v, S, T, fee = state
    qn = q * (1 - fee) if v == 'c' else q / (1 + fee)
    return T * qn / (S + qn) * (1 - ADVERSE)


def sell_fill(state, tok):
    v, S, T, fee = state
    gross = S * tok / (T + tok)
    return gross * (1 - fee) * (1 - ADVERSE)


def mid(state):
    return state[1] / state[2] if state[2] > 0 else 0.0


# ---------------------------------------------------------------- build per-mint series
def build(trades, pool_map):
    series = collections.defaultdict(list)  # mint -> [(slot, bt, state)]
    events = []  # normalized trades: (slot, seq, bt, mint, user, buy, user_sol, tok)
    dropped = 0
    for t in trades:
        slot, seq, bt, key, venue, user, buy, us, tok, S, T, fee, creator = t
        if venue == 'a':
            m = pool_map.get(key)
            if not m or m[1] != WSOL:
                dropped += 1; continue
            mint = m[0]
        else:
            mint = key
        if S <= 0 or T <= 0: continue
        series[mint].append((slot, bt, (venue, S, T, fee)))
        events.append((slot, seq, bt, mint, user, buy, us / 1e9, tok, creator))
    return series, events, dropped


def state_at_slot_end(ser, slot, start_idx=0):
    """index of last series entry with entry.slot <= slot (series sorted by slot, seq)."""
    lo, hi = start_idx, len(ser) - 1; ans = -1
    while lo <= hi:
        md = (lo + hi) // 2
        if ser[md][0] <= slot: ans = md; lo = md + 1
        else: hi = md - 1
    return ans


# ---------------------------------------------------------------- wallet scoring
def score_wallets(events, series, created, t_lo, t_hi):
    pos = collections.defaultdict(lambda: {'cost': 0.0, 'tok': 0, 'bought_tok': 0, 'sold_tok': 0, 'real': 0.0, 'buy_sol': 0.0,
                                           'first_buy': None, 'first_buy_slot': None, 'first_sell': None})
    devs = set()
    for slot, seq, bt, mint, user, buy, sol, tok, creator in events:
        if bt < t_lo or bt >= t_hi: continue
        if creator and creator == user: devs.add(user)
        p = pos[(user, mint)]
        if buy:
            if p['first_buy'] is None: p['first_buy'], p['first_buy_slot'] = bt, slot
            p['cost'] += sol; p['tok'] += tok; p['bought_tok'] += tok; p['buy_sol'] += sol
        else:
            if p['bought_tok'] == 0: continue  # selling a position opened before the window: not scored
            sell_tok = min(tok, p['tok'])
            if sell_tok <= 0: continue
            avg = p['cost'] / p['tok']
            p['real'] += sol * sell_tok / tok - avg * sell_tok
            p['cost'] -= avg * sell_tok; p['tok'] -= sell_tok; p['sold_tok'] += sell_tok
            if p['first_sell'] is None: p['first_sell'] = bt
    for (user, mint) in pos:  # PREREG (a): the wallet created a token it traded
        if mint in created and user in created[mint][1]: devs.add(user)
    # mark remaining at last state before t_hi
    last_state = {}
    for mint, ser in series.items():
        i = len(ser) - 1
        while i >= 0 and ser[i][1] >= t_hi: i -= 1
        if i >= 0: last_state[mint] = ser[i][2]
    W = collections.defaultdict(lambda: {'tokens': 0, 'closed': 0, 'buy_sol': 0.0, 'pnl': 0.0, 'wins': 0, 'holds': [], 'first_buys': [], 'bundle': 0, 'known_create': 0})
    for (user, mint), p in pos.items():
        if p['first_buy'] is None: continue
        mark = sell_fill(last_state[mint], p['tok']) / 1e9 if p['tok'] > 0 and mint in last_state else 0.0
        pnl = p['real'] + mark - p['cost']
        w = W[user]
        w['tokens'] += 1; w['buy_sol'] += p['buy_sol']; w['pnl'] += pnl; w['wins'] += pnl > 0
        if p['sold_tok'] >= 0.9 * p['bought_tok']: w['closed'] += 1
        if p['first_sell'] is not None: w['holds'].append(p['first_sell'] - p['first_buy'])
        w['first_buys'].append((mint, p['first_buy_slot']))
        if mint in created:
            w['known_create'] += 1
            if created[mint][0] == p['first_buy_slot']: w['bundle'] += 1
    return W, devs


def select(W, devs):
    elig = {}
    for u, w in W.items():
        if w['tokens'] >= 5 and w['closed'] >= 3 and w['buy_sol'] >= 0.5 and w['pnl'] > 0 and w['wins'] / w['tokens'] >= 0.55:
            if u in devs: continue
            if w['known_create'] and w['bundle'] / w['known_create'] >= 0.20: continue
            elig[u] = w
    # co-buy clusters
    by_ms = collections.defaultdict(list)
    for u, w in elig.items():
        for m, s in w['first_buys']: by_ms[(m, s)].append(u)
    pair = collections.Counter()
    for us in by_ms.values():
        us = sorted(set(us))
        for i in range(len(us)):
            for j in range(i + 1, len(us)): pair[(us[i], us[j])] += 1
    parent = {u: u for u in elig}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for (a, b), c in pair.items():
        if c >= 3: parent[find(a)] = find(b)
    best = {}
    for u in elig:
        r = find(u)
        if r not in best or elig[u]['pnl'] > elig[best[r]]['pnl']: best[r] = u
    kept = sorted(best.values(), key=lambda u: -elig[u]['pnl'])
    s1 = kept[:50]
    s2 = [u for u in kept if elig[u]['holds'] and statistics.median(elig[u]['holds']) >= 60][:50]
    c0 = [u for u, w in W.items() if w['tokens'] >= 5]
    info = {'eligible_before_clusters': len(elig), 'after_clusters': len(kept), 'linked_groups': sum(1 for r in best if sum(1 for u in elig if find(u) == r) > 1)}
    return {'S1': s1, 'S2': s2, 'C0': c0}, elig, info


# ---------------------------------------------------------------- simulation
def signals(events, sel, t_lo, t_hi):
    seen_buy = set(); out = {k: [] for k in sel}; sets = {k: set(v) for k, v in sel.items()}
    copied = {k: set() for k in sel}
    for slot, seq, bt, mint, user, buy, sol, tok, creator in events:
        if not buy: continue
        first = (user, mint) not in seen_buy
        seen_buy.add((user, mint))
        if not first or bt < t_lo or bt >= t_hi or sol < MIN_SIGNAL_SOL: continue
        for k, s in sets.items():
            if user in s and mint not in copied[k]:
                copied[k].add(mint); out[k].append((slot, bt, mint, user, sol, tok))
    return out


def leader_first_sell(events_by_wm, user, mint, after_slot):
    for slot, bt, buy in events_by_wm.get((user, mint), []):
        if not buy and slot > after_slot: return slot
    return None


def simulate(sig, series, events_by_wm, delay, q, exit_rule, optimistic=False):
    slot, bt, mint, user, lsol, ltok = sig
    ser = series[mint]
    target = slot + delay - (1 if optimistic else 0)
    i = state_at_slot_end(ser, target)
    if i < 0: return None
    st = ser[i][2]
    tok = buy_fill(st, q * 1e9)
    entry_mid = mid(st)
    # leader's own fill price (SOL per token, incl. fees) vs our effective price
    lead_px = lsol / ltok if ltok else 0
    our_px = q / tok if tok else 0
    t_entry = ser[i][1]
    deadline = t_entry + TIME_STOP_S
    trig_slot = None
    if exit_rule == 'E1':
        ls = leader_first_sell(events_by_wm, user, mint, slot)
        if ls is not None:
            j = state_at_slot_end(ser, ls)
            if j >= 0 and ser[j][1] <= deadline: trig_slot = ls
    else:
        for j in range(i + 1, len(ser)):
            s_, b_, stj = ser[j]
            if b_ > deadline: break
            r = mid(stj) / entry_mid - 1
            if r <= STOP or r >= TP:
                trig_slot = s_; break
    if trig_slot is None:  # time stop: last state at or before deadline
        j = i
        while j + 1 < len(ser) and ser[j + 1][1] <= deadline: j += 1
        trig_slot = ser[j][0]
    k = state_at_slot_end(ser, trig_slot + delay)
    out = sell_fill(ser[k][2], tok) / 1e9
    net = (out - q - FIXED_SOL) / q
    return {'net': net, 'lead_px': lead_px, 'our_px': our_px, 'gap': our_px / lead_px - 1 if lead_px else None, 'mint': mint, 'user': user}


def boot(xs, f, n=10000, seed=7):
    rnd = random.Random(seed); m = len(xs)
    vals = sorted(f([xs[rnd.randrange(m)] for _ in range(m)]) for _ in range(n))
    return vals[int(0.025 * n)], vals[int(0.975 * n) - 1]


def summarize(rs):
    xs = [r['net'] for r in rs if r]
    if not xs: return {'n': 0}
    mean = sum(xs) / len(xs); med = statistics.median(xs)
    nb = 10000 if len(xs) < 2000 else 2000
    mci = boot(xs, lambda a: sum(a) / len(a), nb); dci = boot(xs, statistics.median, nb)
    gaps = [r['gap'] for r in rs if r and r['gap'] is not None]
    return {'n': len(xs), 'mean': mean, 'mean_ci': mci, 'median': med, 'median_ci': dci, 'win': sum(x > 0 for x in xs) / len(xs),
            'worst': min(xs), 'best': max(xs), 'gap_gt10': sum(g > 0.10 for g in gaps) / len(gaps) if gaps else None, 'gap_median': statistics.median(gaps) if gaps else None}


def run_cells(sig, series, events_by_wm, px):
    cells = []
    for setname in ['S1', 'S2', 'C0']:
        for d in DELAYS:
            for usd in SIZES_USD:
                for ex in ['E1', 'E2']:
                    for opt in ([False, True] if d == 1 else [False]):
                        rs = [simulate(s, series, events_by_wm, d, usd / px, ex, opt) for s in sig[setname]]
                        sm = summarize(rs)
                        sm.update({'set': setname, 'delay': d, 'usd': usd, 'exit': ex, 'optimistic': opt})
                        cells.append(sm)
    return cells


def print_cells(cells):
    print('set delay usd exit opt | n mean [95% CI] median [95% CI] win worst gap>10%')
    for c in cells:
        if c['n'] == 0:
            print(c['set'], c['delay'], c['usd'], c['exit'], c['optimistic'], '| n=0'); continue
        g = c['gap_gt10'] * 100 if c['gap_gt10'] is not None else float('nan')
        print(f"{c['set']} {c['delay']:>2} {c['usd']:>3} {c['exit']} {'opt' if c['optimistic'] else '   '} | {c['n']:>4} {c['mean']*100:+7.1f}% [{c['mean_ci'][0]*100:+.1f}, {c['mean_ci'][1]*100:+.1f}]  {c['median']*100:+7.1f}% [{c['median_ci'][0]*100:+.1f}, {c['median_ci'][1]*100:+.1f}]  {c['win']*100:4.0f}% {c['worst']*100:+6.0f}%  {g:4.0f}%")


def replay(path):
    """Recompute every test cell from the committed replay subset (no raw stream needed)."""
    global ADVERSE
    rep = json.load(gzip.open(path, 'rt'))
    ADVERSE = float(os.environ.get('ADVERSE', rep['adverse']))
    series = {m: [(a, b, tuple(c)) for a, b, c in v] for m, v in rep['series'].items()}
    ebw = {tuple(k.split('|')): [tuple(x) for x in v] for k, v in rep['leader_events'].items()}
    sig = {k: [tuple(x) for x in v] for k, v in rep['signals'].items()}
    cells = run_cells(sig, series, ebw, rep['sol_usd'])
    print(f"replay {path}: SOL/USD {rep['sol_usd']:.2f} adverse {ADVERSE} signals { {k: len(v) for k, v in sig.items()} }")
    print_cells(cells)
    return cells


def sol_usd():
    try:
        r = json.load(urllib.request.urlopen('https://lite-api.jup.ag/price/v3?ids=' + WSOL, timeout=30))
        return r[WSOL]['usdPrice']
    except Exception:
        return 119.38  # RES-1 value; only used if Jupiter is unreachable


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    trades, created, pool_new = load()
    print(f'mode={MODE} trades<=X1: {len(trades)}  created: {len(created)}  pools created live: {len(pool_new)}  load {time.time()-t0:.0f}s', flush=True)
    pools = sorted({t[3] for t in trades if t[4] == 'a'})
    pool_map = map_pools(pools, pool_new)
    series, events, dropped = build(trades, pool_map)
    print(f'mints: {len(series)}  events: {len(events)}  AMM trades dropped (non-WSOL or unmapped pool): {dropped}', flush=True)
    W, devs = score_wallets(events, series, created, F0, F1)
    sel, elig, info = select(W, devs)
    print('formation wallets', len(W), 'devs', len(devs), info, {k: len(v) for k, v in sel.items()}, flush=True)
    sig = signals(events, sel, T0, T1)
    events_by_wm = collections.defaultdict(list)
    for slot, seq, bt, mint, user, buy, sol, tok, creator in events:
        events_by_wm[(user, mint)].append((slot, bt, buy))
    px = sol_usd()
    results = {'mode': MODE, 'sol_usd': px, 'adverse': ADVERSE, 'windows': [F0, F1, T0, T1, X1], 'select_info': info,
               'n_formation_wallets': len(W), 'n_selected': {k: len(v) for k, v in sel.items()}, 'n_signals': {k: len(v) for k, v in sig.items()}}
    results['cells'] = run_cells(sig, series, events_by_wm, px)
    # replay subset: everything the test cells need, so they can be recomputed without the raw stream
    first = {}
    for v in sig.values():
        for s in v: first[s[2]] = min(first.get(s[2], s[0]), s[0])
    rep = {'sol_usd': px, 'adverse': ADVERSE, 'signals': sig,
           'series': {m: [[a, b, list(c)] for a, b, c in series[m] if a >= first[m] - 1] for m in first},
           'leader_events': {s[3] + '|' + s[2]: events_by_wm[(s[3], s[2])] for v in sig.values() for s in v}}
    with gzip.open(os.path.join(OUT, f'{MODE}_replay.json.gz'), 'wt') as fh: json.dump(rep, fh)
    # leader persistence (S1/S2): own PnL in the test window vs formation
    WT, _ = score_wallets(events, series, created, T0, X1)
    pers = {}
    for k in ['S1', 'S2']:
        f = [elig[u]['pnl'] for u in sel[k]]; t = [WT[u]['pnl'] for u in sel[k] if u in WT]
        pers[k] = {'n_active_in_T': len(t), 'F_pnl_sum_sol': sum(f), 'T_pnl_sum_sol': sum(t), 'T_share_positive': sum(x > 0 for x in t) / len(t) if t else None,
                   'T_median_pnl_sol': statistics.median(t) if t else None}
    results['persistence'] = pers
    json.dump(results, open(os.path.join(OUT, f'{MODE}_results.json'), 'w'), indent=1)
    with open(os.path.join(OUT, f'{MODE}_selected.csv'), 'w') as fh:
        fh.write('set,rank,wallet,tokens,closed,buy_sol,pnl_sol,win_share,median_hold_s\n')
        for k in ['S1', 'S2']:
            for i, u in enumerate(sel[k]):
                w = elig[u]
                fh.write(f"{k},{i+1},{u},{w['tokens']},{w['closed']},{w['buy_sol']:.4f},{w['pnl']:.4f},{w['wins']/w['tokens']:.3f},{statistics.median(w['holds']) if w['holds'] else ''}\n")
    with open(os.path.join(OUT, f'{MODE}_signals.csv'), 'w') as fh:
        fh.write('set,slot,block_time,mint,leader,leader_sol,leader_tok\n')
        for k, v in sig.items():
            for s in v: fh.write(f'{k},{s[0]},{s[1]},{s[2]},{s[3]},{s[4]:.6f},{s[5]}\n')
    print(f"SOL/USD {px:.2f}  signals {results['n_signals']}  persistence {json.dumps(pers)}")
    print_cells(results['cells'])
    print(f'total {time.time()-t0:.0f}s')


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == 'replay':
        replay(sys.argv[2])
    else:
        main()
