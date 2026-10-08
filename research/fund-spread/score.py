"""FUND-SPREAD (PREREG.md): gate, then the primary score. Paper research only.

  python3 -I score.py gate  <data_dir> <out_dir>     # section 4 gate: reads funding and price ranges, no trade P&L
  python3 -I score.py score <data_dir> <out_dir>     # sections 5-6: runs only if the gate file says PASS

Data (pre-wall only, nothing at or after 2026-09-21T14:00Z):
  hl/f_<COIN>.json   Hyperliquid hourly fundingHistory (research/short-probe/fetch_hl.py), squeeze funding cut
  hl/c_<COIN>.json   Hyperliquid daily candles; a candle is used only if it closed before the wall
  bnfs/fund_<SYM>.csv, bnfs/d_<SYM>.csv   Binance USD-M funding settlements and daily klines (fetch_fs.py)

Choices the PREREG leaves open, fixed here before any return was computed (see RESULTS.md):
  * Signal coverage: s is evaluable at day D only if Hyperliquid has >= 23 rows and Binance settlements cover >= 16 h
    among rows stamped in [D - 24 h, D). Binance per-hour rate = sum(rate) / sum(interval hours) of those rows.
  * Accounting is per unit of one leg's notional N (the PREREG's 0.90% pair cost and its entry rule are per N).
    A per-capital line (2N collateral, SOL leg sized to it) is reported beside it as a sensitivity.
  * Funding over the hold: settlements stamped in [entry + 30 min, exit + 30 min) on each venue (the one at entry pays
    the interval before it; the one at exit pays the last held interval); each rate weighted by that venue's daily close
    of the row's day over the entry price (short-probe rule). Shorts receive positive rates, longs pay them. A pair whose
    Hyperliquid rows number fewer than hold hours - 1, or whose Binance or SOL settlements cover fewer than hold hours
    - 8, is non-executable (coverage, short-probe rule).
  * Verdict (after review): the per-N line and the per-capital line (SOL leg equal to the 2N collateral) must both pass.
  * Gate entries count only pairs whose price bars exist at entry and exit (no return is read).
  * SOL leg: Binance SOLUSDT perp, daily opens for r_SOL; it pays Binance SOLUSDT funding over the hold.
  * Tail gate: a coin-day window counts if either venue's high within 72 h reaches 1.5x the day's open or its low
    reaches 0.5x (a pair always holds one short and one long leg on the coin).
  * Liquidation: the short leg's venue daily high on a hold day >= 1.714x its entry -> that leg returns -1.
"""
import hashlib, json, math, os, sys
import numpy as np

WALL = 1789999200
DAY = 86400
NAMES = ['WIF', 'POPCAT', 'BOME', 'MEW', 'GOAT', 'PNUT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'PENGU', 'ZEREBRO',
         'GRIFFAIN', 'VINE', 'USELESS', 'kBONK', 'SPX', 'TRUMP', 'MELANIA', 'YZY', 'AI16Z', 'MYRO', 'LAUNCHCOIN',
         'JELLY', 'DOOD']
BN = {'kBONK': '1000BONK', 'JELLY': 'JELLYJELLY'}
LEG = 0.0015                          # 0.05% fee + 0.10% slippage per side per venue leg
PAIR_COST = 4 * LEG                   # 0.60%
SOL_COST = 0.003                      # SOL leg round trip
RT = PAIR_COST + SOL_COST             # 0.90%
LIQ = 2 / (1 + 1 / (2 * 3))           # 1.714x
STAKE = 0.048                         # edge.md 7.2, per year
LVL = 0.995


def hl_funding(d, coin):
    p = os.path.join(d, 'hl', f'f_{coin}.json')
    if not os.path.exists(p):
        return None
    rows = sorted(((int(x['time']) / 1000.0, float(x['fundingRate'])) for x in json.load(open(p))))
    rows = [r for r in rows if r[0] < WALL]
    k = len(rows)
    while k and rows[k - 1][1] == 0.0:                                # squeeze funding cut
        k -= 1
    rows = rows[:k]
    return (np.array([r[0] for r in rows]), np.array([r[1] for r in rows])) if rows else None


def bn_funding(d, sym):
    p = os.path.join(d, 'bnfs', f'fund_{sym}.csv')
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return None
    a = np.loadtxt(p, delimiter=',', ndmin=2)
    a = a[a[:, 0] / 1000.0 < WALL]
    return a[:, 0] / 1000.0, a[:, 1], a[:, 2]                         # time s, interval h, rate


def hl_daily(d, coin):
    p = os.path.join(d, 'hl', f'c_{coin}.json')
    if not os.path.exists(p):
        return None
    out = {}
    for c in json.load(open(p)):
        t = int(c['t']) // 1000
        if t % DAY == 0 and t + DAY <= WALL:                          # closed before the wall
            out[t // DAY] = (float(c['o']), float(c['h']), float(c['l']), float(c['c']))
    return out or None


def bn_daily(d, sym):
    p = os.path.join(d, 'bnfs', f'd_{sym}.csv')
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return None
    a = np.loadtxt(p, delimiter=',', ndmin=2)
    return {int(r[0]) // DAY: (r[1], r[2], r[3], r[4]) for r in a if int(r[0]) % DAY == 0 and int(r[0]) + DAY <= WALL} or None


def signal(hf, bf, D):
    """s at 00:00 of day D (D in days): HL mean hourly rate minus Binance per-hour rate, trailing 24 h, settled < D."""
    t0, t1 = D * DAY - DAY, D * DAY
    i, j = np.searchsorted(hf[0], t0), np.searchsorted(hf[0], t1)
    if j - i < 23:
        return None
    k, l = np.searchsorted(bf[0], t0), np.searchsorted(bf[0], t1)
    hrs = bf[1][k:l].sum()
    if hrs < 16:
        return None
    return float(hf[1][i:j].mean() - bf[2][k:l].sum() / hrs)


def load(d):
    U = {}
    for c in NAMES:
        sym = BN.get(c, c) + 'USDT'
        hf, bf, hd, bd = hl_funding(d, c), bn_funding(d, sym), hl_daily(d, c), bn_daily(d, sym)
        U[c] = dict(sym=sym, hf=hf, bf=bf, hd=hd, bd=bd)
    return U


def sig_days(u):
    if u['hf'] is None or u['bf'] is None:
        return {}
    lo = int(max(u['hf'][0][0], u['bf'][0][0]) // DAY)
    hi = int(min(u['hf'][0][-1], u['bf'][0][-1]) // DAY) + 1
    out = {}
    for D in range(lo, hi + 1):
        s = signal(u['hf'], u['bf'], D)
        if s is not None:
            out[D] = s
    return out


def pairs_of(S):
    """Entries under the one-open-pair cap; exit day = D + 3 or the first day whose s has the opposite sign."""
    out, free = [], -1
    for D in sorted(S):
        if D < free or abs(S[D]) * 72 < 2 * RT:
            continue
        E = D + 3
        for k in (1, 2):
            s2 = S.get(D + k)
            if s2 is not None and s2 * S[D] < 0:
                E = D + k
                break
        out.append({'D': D, 'E': E, 's': S[D], 'short': 'HL' if S[D] > 0 else 'BN'})
        free = E
    return out


def step0(d):
    """Binance funding archive exists and its calc_time sits on settlement times (within 1 s of the hour, on the
    row's own interval grid)."""
    off, bad, files = 0, 0, 0
    for c in NAMES + ['SOL']:
        f = bn_funding(d, BN.get(c, c) + 'USDT')
        if f is None:
            continue
        files += 1
        ms = np.round(f[0] * 1000).astype(np.int64)
        o = ms % 3600000
        off = max(off, int(np.minimum(o, 3600000 - o).max()))
        hr = np.round(ms / 3600000).astype(np.int64)
        bad += int(((hr % f[1].astype(np.int64)) != 0).sum())
    return {'symbols_with_funding': files, 'max_offset_ms': off, 'rows_off_interval_grid': bad,
            'ok': files > 0 and off <= 1000}


def gate(d, out):
    U = load(d)
    SOLD = bn_daily(d, 'SOLUSDT')
    res = {'coins': {}, 'excluded': {}, 'step0': step0(d)}
    for c, u in U.items():
        miss = [k for k in ('hf', 'bf', 'hd', 'bd') if u[k] is None]
        if miss:
            res['excluded'][c] = 'missing ' + ', '.join(miss)
            continue
        S = sig_days(u)
        ov = len(S)
        if ov < 180:
            res['excluded'][c] = f'{ov} overlapping signal days (< 180)'
            continue
        P = [p for p in pairs_of(S) if p['D'] in u['hd'] and p['D'] in u['bd'] and p['D'] in SOLD
             and p['E'] in SOLD and (p['E'] in u['hd'] or any(p['D'] <= k < p['E'] for k in u['hd']))
             and (p['E'] in u['bd'] or any(p['D'] <= k < p['E'] for k in u['bd']))]
        win = tail = 0
        for D in sorted(set(u['hd']) & set(u['bd'])):
            if not all(D + k in u['hd'] and D + k in u['bd'] for k in (1, 2)):
                continue
            win += 1
            hit = False
            for px in (u['hd'], u['bd']):
                o = px[D][0]
                if max(px[D + k][1] for k in range(3)) >= 1.5 * o or min(px[D + k][2] for k in range(3)) <= 0.5 * o:
                    hit = True
            tail += hit
        res['coins'][c] = {'overlap_days': ov, 'signal_entries': len(P), 'windows': win, 'tail_windows': tail,
                           'first_day': min(S), 'last_day': max(S)}
    n_coins = len(res['coins'])
    n_sig = sum(v['signal_entries'] for v in res['coins'].values())
    win = sum(v['windows'] for v in res['coins'].values()); tail = sum(v['tail_windows'] for v in res['coins'].values())
    res['checks'] = {'step0': [res['step0']['max_offset_ms'], res['step0']['ok']], 'coins': [n_coins, n_coins >= 10], 'signal_coin_days_after_cap': [n_sig, n_sig >= 300],
                     'tail_share': [tail / win if win else None, bool(win) and tail / win <= 0.01]}
    res['verdict'] = 'PASS' if all(v[1] for v in res['checks'].values()) else 'CLOSED'
    os.makedirs(out, exist_ok=True)
    json.dump(res, open(os.path.join(out, 'gate.json'), 'w'), indent=1, sort_keys=True)
    print(json.dumps({'checks': res['checks'], 'verdict': res['verdict'], 'excluded': res['excluded']}))


# ------------------------------------------------------------------ statistics (squeeze-probe stage2.py)
def tq(p, df):
    c = math.exp(math.lgamma((df + 1) / 2) - math.lgamma(df / 2)) / math.sqrt(df * math.pi)
    xs = np.linspace(0, 40, 400001)
    dens = c * (1 + xs ** 2 / df) ** (-(df + 1) / 2)
    cdf = 0.5 + np.concatenate([[0], np.cumsum((dens[1:] + dens[:-1]) / 2 * (xs[1] - xs[0]))])
    return float(np.interp(p, cdf, xs))


def clustered(vals, days, lvl=LVL):
    v = np.asarray(vals, float); n = len(v)
    if n < 2:
        return None
    m = v.mean(); g = {}
    for x, dd in zip(v, days):
        g[dd] = g.get(dd, 0.0) + (x - m)
    G = len(g)
    if G < 2:
        return None
    se = math.sqrt(sum(s * s for s in g.values())) / n * math.sqrt(G / (G - 1))
    t = tq(1 - (1 - lvl) / 2, G - 1)
    return [m - t * se, m + t * se]


def boot(vals, days, B=10000, seed=7, lvl=LVL):
    v = np.asarray(vals, float)
    ud = sorted(set(days))
    if len(ud) < 2:
        return None
    idx = {dd: [] for dd in ud}
    for i, dd in enumerate(days):
        idx[dd].append(i)
    sums = np.array([v[idx[dd]].sum() for dd in ud]); cnts = np.array([len(idx[dd]) for dd in ud])
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(ud), size=(B, len(ud)))
    means = sums[draws].sum(1) / cnts[draws].sum(1)
    a = (1 - lvl) / 2 * 100
    return [float(np.percentile(means, a)), float(np.percentile(means, 100 - a))]


# ------------------------------------------------------------------ trade
def fund_sum(times, rates, t0, t1, px, p0):
    """Sum of rates stamped in [t0 + 30 min, t1 + 30 min), each weighted by the venue's daily close of the row's day / p0.
    The settlement stamped at entry pays for the interval before it and is left out; the one stamped at exit pays
    for the last held interval and is counted (row stamps lag the hour by up to about 15 min on Hyperliquid)."""
    i, j = np.searchsorted(times, t0 + 1800), np.searchsorted(times, t1 + 1800)
    tot = 0.0
    for t, r in zip(times[i:j], rates[i:j]):
        dd = int(t // DAY)
        w = px[dd][3] / p0 if dd in px else 1.0
        tot += r * w
    return float(tot), (i, j)


def mark(px, D, E):
    """Exit price: open of day E, else the last close before E (delisted perp marked at its last settlement)."""
    if E in px:
        return px[E][0], False
    prev = [k for k in px if D <= k < E]
    return (px[max(prev)][3], True) if prev else (None, True)


def trade(u, sol, solf, p):
    D, E = p['D'], p['E']
    if D not in u['hd'] or D not in u['bd'] or D not in sol or E not in sol:
        return None
    legs = {'HL': u['hd'], 'BN': u['bd']}
    sh, lg = p['short'], ('BN' if p['short'] == 'HL' else 'HL')
    e_s, e_l = legs[sh][D][0], legs[lg][D][0]
    x_s, ms = mark(legs[sh], D, E); x_l, ml = mark(legs[lg], D, E)
    if x_s is None or x_l is None:
        return None
    liq = any(legs[sh][k][1] >= LIQ * e_s for k in range(D, E) if k in legs[sh])
    short_leg = -1.0 if liq else max(1 - x_s / e_s, -1.0)
    long_leg = x_l / e_l - 1
    t0, t1 = D * DAY, E * DAY
    hf, bf = u['hf'], u['bf']
    f_hl, (i, j) = fund_sum(hf[0], hf[1], t0, t1, u['hd'], u['hd'][D][0])
    nh = j - i
    f_bn, (k, l) = fund_sum(bf[0], bf[2], t0, t1, u['bd'], u['bd'][D][0])
    nb = float(bf[1][k:l].sum())
    hold_h = (E - D) * 24
    fund = (f_hl - f_bn) if sh == 'HL' else (f_bn - f_hl)        # short receives its venue's rate, long pays its own
    if liq:
        fund -= (f_hl if sh == 'HL' else f_bn)                     # a liquidated short collects nothing after entry
    f_sol, (k, l) = fund_sum(solf[0], solf[2], t0, t1, sol, sol[D][0])  # long SOL perp pays it
    ns = float(solf[1][k:l].sum())
    if nh < hold_h - 1 or nb < hold_h - 8 or ns < hold_h - 8:                   # funding coverage (short-probe rule)
        return None
    r_sol = sol[E][0] / sol[D][0] - 1
    hold = E - D
    stake = (1 + STAKE) ** (hold / 365) - 1
    out = {'coin': None, 'D': D, 'E': E, 'short': sh, 's': p['s'], 'liq': liq, 'marked': ms or ml,
           'price': short_leg + long_leg, 'fund': fund, 'f_sol': f_sol, 'r_sol': r_sol, 'stake': stake,
           'hl_rows': nh, 'bn_rows': nb}
    for name, k in (('n', 1), ('n2', 2)):
        R = short_leg + long_leg + fund - k * PAIR_COST - k * SOL_COST - f_sol          # per N
        out[name] = (1 + R) / (1 + r_sol) - 1
        Rc = (short_leg + long_leg + fund - k * PAIR_COST) / 2 - k * SOL_COST - f_sol   # per 2N capital
        out[name + '_cap'] = (1 + Rc) / (1 + r_sol) - 1
        out[name + '_hedged'] = (1 + R + r_sol) / (1 + r_sol) - 1                          # descriptive only
    return out


def summ(rows, key):
    v = [r[key] for r in rows]; x = [r[key] - r['stake'] for r in rows]; dy = [r['D'] for r in rows]
    return {'mean': float(np.mean(v)), 'median': float(np.median(v)), 'mean_excess': float(np.mean(x)),
            'ci_boot': boot(v, dy), 'ci_t': clustered(v, dy), 'ci_excess_boot': boot(x, dy), 'ci_excess_t': clustered(x, dy)}


def score(d, out):
    g = json.load(open(os.path.join(out, 'gate.json')))
    if g['verdict'] != 'PASS':
        print('gate closed; nothing scored'); return
    U = load(d)
    sol, solf = bn_daily(d, 'SOLUSDT'), bn_funding(d, 'SOLUSDT')
    rows, nonexec = [], 0
    for c in sorted(g['coins']):
        u = U[c]
        for p in pairs_of(sig_days(u)):
            r = trade(u, sol, solf, p)
            if r is None:
                nonexec += 1; continue
            r['coin'] = c
            rows.append(r)
    rows.sort(key=lambda r: (r['D'], r['coin']))
    days = sorted(r['D'] for r in rows)
    med = days[len(days) // 2]
    h1 = [r for r in rows if r['D'] < med]; h2 = [r for r in rows if r['D'] >= med]
    res = {'pairs': len(rows), 'nonexec': nonexec, 'days': len(set(days)), 'coins': len({r['coin'] for r in rows}),
           'split_day': med, 'liq_pairs': sum(r['liq'] for r in rows), 'marked_pairs': sum(r['marked'] for r in rows),
           'primary': summ(rows, 'n'), 'cost2x': summ(rows, 'n2'), 'per_capital': summ(rows, 'n_cap'),
           'per_capital_cost2x': summ(rows, 'n2_cap'), 'hedged_descriptive': summ(rows, 'n_hedged'),
           'half1': summ(h1, 'n') if len(h1) > 1 else None, 'half2': summ(h2, 'n') if len(h2) > 1 else None,
           'half1_cap': summ(h1, 'n_cap') if len(h1) > 1 else None, 'half2_cap': summ(h2, 'n_cap') if len(h2) > 1 else None,
           'mean_parts': {k: float(np.mean([r[k] for r in rows])) for k in ('price', 'fund', 'f_sol', 'r_sol', 'stake')},
           'win': float(np.mean([r['n'] > 0 for r in rows])),
           'per_coin': {c: [sum(r['coin'] == c for r in rows), float(np.mean([r['n'] for r in rows if r['coin'] == c]))]
                        for c in sorted({r['coin'] for r in rows})}}
    P = res['primary']
    lb = lambda ci: ci is not None and ci[0] > 0
    if len(rows) < 150:
        verdict = 'UNRESOLVED'
    else:
        ok = (lb(P['ci_boot']) and lb(P['ci_t']) and lb(P['ci_excess_boot']) and lb(P['ci_excess_t'])
              and res['half1'] and res['half2'] and res['half1']['mean'] > 0 and res['half2']['mean'] > 0
              and res['half1']['mean_excess'] > 0 and res['half2']['mean_excess'] > 0
              and res['cost2x']['mean'] > 0 and res['cost2x']['mean_excess'] > 0
              and res['liq_pairs'] <= 0.01 * len(rows)
              and lb(res['per_capital']['ci_boot']) and lb(res['per_capital']['ci_t'])
              and lb(res['per_capital']['ci_excess_boot']) and lb(res['per_capital']['ci_excess_t'])
              and res['half1_cap']['mean'] > 0 and res['half2_cap']['mean'] > 0
              and res['half1_cap']['mean_excess'] > 0 and res['half2_cap']['mean_excess'] > 0
              and res['per_capital_cost2x']['mean'] > 0 and res['per_capital_cost2x']['mean_excess'] > 0)
        verdict = 'PASS' if ok else 'KILLED'
    res['verdict'] = verdict
    blob = json.dumps({'summary': res, 'rows': rows}, sort_keys=True, indent=0).encode()
    open(os.path.join(out, 'results.json'), 'wb').write(blob)
    print(json.dumps(res, indent=1)); print('results.json sha256', hashlib.sha256(blob).hexdigest())


if __name__ == '__main__':
    {'gate': gate, 'score': score}[sys.argv[1]](sys.argv[2], sys.argv[3])
