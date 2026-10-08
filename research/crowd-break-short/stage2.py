"""Stage 2 of CROWD-BREAK-SHORT (PREREG sections 5-7): trades, controls, statistics, verdict. Paper research only.

  python3 -I stage2.py needs <out_dir>              # writes needs.json (1-minute months to download) from stage1.json
  python3 -I stage2.py score <data_dir> <out_dir>   # runs only if gate.json says PASS

Trade: short 1x the coin's Binance USD-M perp at the first 1-minute open at or after T + 7 s (lines at T + 60 s and
T + 120 s), exit at the first 1-minute open at or after entry + 6 h; if the perp has no bar within 1 h of that time
(delisted), it is marked at its last close before it. Return in SOL: (1 - r_meme + f - c) / (1 + r_SOL) - 1, with
1 - r_meme floored at 0 (a 1x short loses at most its collateral), r_SOL from the SOLUSDT perp at the same minutes,
and f = Hyperliquid funding of the hourly grid slots whose settlement hour lies in [entry, exit), each weighted by
the coin's 1-minute close at that minute over the entry price (short receives positive rates), minus the SOL-perp
long's Hyperliquid funding over the same slots (H1-PERP: funding on both legs; added after review). Costs c: base 0.60%, 2x 1.20%, low 0.40% (coin leg 0.30%
plus SOL-leg fees 0.10%). Liquidation line: a 1-minute high >= 1.714x entry in [entry, exit) -> gross -1 - c.
Executable: the coin and SOLUSDT both have a 1-minute bar at the entry minute found within 1 h of the target, and
entry + 6 h + 60 s is at or before the wall (late entries are counted). All needed month files must exist.
Controls: C1 walks the frozen ranked list, accepting the first 10 executable (entry state only); an event needs at
least 3 to enter the lift set (as in the squeeze PREREG). C2: the first 5 executable of the frozen random draws.
"""
import hashlib, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stage1 import BN, H0, HOLD, WALL, funding

LIQ = 2 / (1 + 1 / (2 * 3))
COST = {'base': 0.006, 'x2': 0.012, 'low': 0.004}
LVL = 0.995
MON = lambda t: __import__('time').strftime('%Y-%m', __import__('time').gmtime(t))


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


# ------------------------------------------------------------------ 1-minute prices
class Px:
    def __init__(self, d):
        self.d = d; self.cache = {}

    def month(self, sym, m):
        k = (sym, m)
        if k not in self.cache:
            p = os.path.join(self.d, 'bn1m', f'{sym}_{m}.csv')
            a = np.loadtxt(p, delimiter=',', ndmin=2) if os.path.exists(p) and os.path.getsize(p) else np.zeros((0, 5))
            self.cache[k] = a
        return self.cache[k]

    def rows(self, sym, t0, t1):
        """Bars with open time in [t0, t1)."""
        ms = sorted({MON(t) for t in range(int(t0) - int(t0) % 86400, int(t1) + 86400, 86400)})
        a = [self.month(sym, m) for m in ms]
        a = np.vstack([x for x in a if len(x)]) if any(len(x) for x in a) else np.zeros((0, 5))
        return a[(a[:, 0] >= t0) & (a[:, 0] < t1)] if len(a) else a

    def first_at(self, sym, t, within=3600):
        a = self.rows(sym, t, t + within)
        return (int(a[0, 0]), a[0, 1]) if len(a) else (None, None)

    def at(self, sym, t):
        a = self.rows(sym, t, t + 60)
        return a[0, 1] if len(a) else None

    def last_before(self, sym, t, lo):
        a = self.rows(sym, lo, t)
        return a[-1, 4] if len(a) else None


class Engine:
    def __init__(self, d):
        self.px = Px(d); self.d = d; self.fund = {}

    def sym(self, coin):
        return BN.get(coin, coin) + 'USDT'

    def entry(self, coin, T, delay):
        t = -(-(T + delay) // 60) * 60
        te, pe = self.px.first_at(self.sym(coin), t)
        if te is None:
            return None, 'no coin 1m bar within 1 h'
        if te + HOLD + 60 > WALL:
            return None, 'exit after the wall'
        ps = self.px.at('SOLUSDT', te)
        if ps is None:
            return None, 'no SOLUSDT 1m bar at entry'
        return (te, pe, ps), 'ok'

    def hl_rows(self, coin):
        if coin not in self.fund:
            f = funding(self.d, coin)
            if f is None:
                self.fund[coin] = (np.zeros(0), np.zeros(0))
            else:
                rate, tm, cut = f
                ok = ~np.isnan(rate)
                slot = H0 + np.arange(len(rate)) * 3600.0             # settlement hour of the grid slot
                self.fund[coin] = (slot[ok], rate[ok])
        return self.fund[coin]

    def trade(self, coin, T, delay=7):
        s0, why = self.entry(coin, T, delay)
        if s0 is None:
            return None
        te, pe, ps = s0
        sym = self.sym(coin)
        tx = te + HOLD
        tq_, px_ = self.px.first_at(sym, tx)
        marked = False
        if tq_ is None:
            px_ = self.px.last_before(sym, tx, te); tq_ = tx; marked = True
        sx = self.px.at('SOLUSDT', tq_) or self.px.last_before('SOLUSDT', tq_ + 60, te)
        bars = self.px.rows(sym, te, tx)
        hi = float(bars[:, 2].max()) if len(bars) else pe
        tm, rt = self.hl_rows(coin)
        sel = (tm >= te) & (tm < tx)
        f = 0.0
        for t, r in zip(tm[sel], rt[sel]):
            m = int(t // 60 * 60)
            c = self.px.rows(sym, m, m + 60)
            w = c[0, 4] / pe if len(c) else 1.0
            f += r * w
        tms, rts = self.hl_rows('SOL')                                    # the SOL-perp long pays its funding
        sel_s = (tms >= te) & (tms < tx)
        f_sol = 0.0
        for t, r in zip(tms[sel_s], rts[sel_s]):
            m = int(t // 60 * 60)
            c = self.px.rows('SOLUSDT', m, m + 60)
            f_sol += r * (c[0, 4] / ps if len(c) else 1.0)
        f -= f_sol
        r_meme = px_ / pe - 1; r_sol = sx / ps - 1
        out = {'entry_t': te, 'exit_t': int(tq_), 'r_meme': r_meme, 'r_sol': r_sol, 'f': f, 'f_sol': f_sol,
               'f_rows': int(sel.sum()), 'f_sol_rows': int(sel_s.sum()), 'entry_lag': te - (-(-(T + delay) // 60) * 60),
               'liq': bool(hi >= LIQ * pe), 'marked': marked}
        for k, c in COST.items():
            out['n_' + k] = (max(1 - r_meme, 0.0) + f - c) / (1 + r_sol) - 1
        out['n_liq'] = (-COST['base'] / (1 + r_sol) - 1) if out['liq'] else out['n_base']
        out['gross'] = (max(1 - r_meme, 0.0) + f) / (1 + r_sol) - 1
        return out


def needs(out):
    st = json.load(open(os.path.join(out, 'stage1.json')))
    nd = {}
    for e in st['events']:
        s = BN.get(e['coin'], e['coin']) + 'USDT'
        for t in range(e['T'] - 31 * 86400, min(WALL, e['T'] + 31 * 86400) + 86400, 86400):
            m = MON(min(t, WALL - 1))
            nd.setdefault(s, set()).add(m); nd.setdefault('SOLUSDT', set()).add(m)
    json.dump({k: sorted(v) for k, v in nd.items()}, open(os.path.join(out, 'needs.json'), 'w'), indent=0, sort_keys=True)
    print({k: len(v) for k, v in nd.items()})


def stats(rows, key):
    v = [r[key] for r in rows]; dy = [r['day'] for r in rows]
    return {'mean': float(np.mean(v)), 'median': float(np.median(v)), 'ci_boot': boot(v, dy), 'ci_t': clustered(v, dy)}


def score(d, out):
    g = json.load(open(os.path.join(out, 'gate.json')))
    if g['verdict'] != 'PASS':
        print('gate closed; nothing scored'); return
    st = json.load(open(os.path.join(out, 'stage1.json')))
    need = json.load(open(os.path.join(out, 'needs.json')))
    miss = [f'{k}_{m}' for k, ms in need.items() for m in ms if not os.path.exists(os.path.join(d, 'bn1m', f'{k}_{m}.csv'))]
    assert not miss, f'missing 1m month files: {miss[:5]} ({len(miss)})'
    E = Engine(d)
    rows, nonexec, trades = [], [], {}
    for e in st['events']:
        tr = E.trade(e['coin'], e['T'], 7)
        if tr is None:
            nonexec.append(e['id']); continue
        t60 = E.trade(e['coin'], e['T'], 60); t120 = E.trade(e['coin'], e['T'], 120)
        acc, tried = [], 0
        for x in e['controls_ranked']:
            if len(acc) >= 10:
                break
            tried += 1
            if E.entry(e['coin'], x['T'], 7)[0] is not None:
                acc.append(x)
        ctr = [E.trade(e['coin'], x['T'], 7) for x in acc]
        c2 = []
        for t in e['c2_draws']:
            if len(c2) >= 5:
                break
            if E.entry(e['coin'], t, 7)[0] is not None:
                c2.append(E.trade(e['coin'], t, 7))
        r = {'id': e['id'], 'coin': e['coin'], 'T': e['T'], 'day': tr['entry_t'] // 86400, 'n_controls': len(ctr),
             'controls_tried': tried, **tr,
             'n60': t60['n_base'] if t60 else None, 'n120': t120['n_base'] if t120 else None,
             'c1': float(np.mean([c['n_base'] for c in ctr])) if len(ctr) >= 3 else None,
             'c1_x2': float(np.mean([c['n_x2'] for c in ctr])) if len(ctr) >= 3 else None,
             'c2': float(np.mean([c['n_base'] for c in c2])) if c2 else None,
             'controls': [{'T': x['T'], 'n_base': c['n_base'], 'liq': c['liq']} for x, c in zip(acc, ctr)]}
        rows.append(r)
    lift = [r for r in rows if r['c1'] is not None]
    for r in lift:
        r['d'] = r['n_base'] - r['c1']
        r['d_x2'] = r['n_x2'] - r['c1_x2']
    lift.sort(key=lambda r: r['entry_t'])
    res = {'events_frozen': len(st['events']), 'executable': len(rows), 'nonexec': len(nonexec),
           'lift_events': len(lift), 'lift_days': len({r['day'] for r in lift}),
           'coins': len({r['coin'] for r in lift}), 'marked': sum(r['marked'] for r in rows),
           'liq_events': sum(r['liq'] for r in lift), 'f_rows_short': sum(r['f_rows'] < 5 for r in lift),
           'late_entries': sum(r['entry_lag'] > 0 for r in rows)}
    if rows:
        res['mean_n_all_exec'] = float(np.mean([r['n_base'] for r in rows]))
    if lift:
        days = sorted(r['day'] for r in lift); med = days[len(days) // 2]
        h1 = [r for r in lift if r['day'] < med]; h2 = [r for r in lift if r['day'] >= med]
        res.update(n=stats(lift, 'n_base'), d=stats(lift, 'd'), split_day=med,
                   half1={'n': float(np.mean([r['n_base'] for r in h1])) if h1 else None,
                          'd': float(np.mean([r['d'] for r in h1])) if h1 else None, 'count': len(h1)},
                   half2={'n': float(np.mean([r['n_base'] for r in h2])) if h2 else None,
                          'd': float(np.mean([r['d'] for r in h2])) if h2 else None, 'count': len(h2)},
                   mean_n60=float(np.mean([r['n60'] for r in lift if r['n60'] is not None])),
                   mean_n120=float(np.mean([r['n120'] for r in lift if r['n120'] is not None])),
                   mean_n_x2=float(np.mean([r['n_x2'] for r in lift])), mean_d_x2=float(np.mean([r['d_x2'] for r in lift])),
                   mean_n_low=float(np.mean([r['n_low'] for r in lift])),
                   mean_n_liq=float(np.mean([r['n_liq'] for r in lift])),
                   mean_gross=float(np.mean([r['gross'] for r in lift])), mean_c1=float(np.mean([r['c1'] for r in lift])),
                   mean_c2=float(np.mean([r['c2'] for r in lift if r['c2'] is not None])),
                   mean_f=float(np.mean([r['f'] for r in lift])), win=float(np.mean([r['n_base'] > 0 for r in lift])),
                   per_coin={c: [sum(r['coin'] == c for r in lift), float(np.mean([r['n_base'] for r in lift if r['coin'] == c])),
                                 float(np.mean([r['d'] for r in lift if r['coin'] == c]))] for c in sorted({r['coin'] for r in lift})})
    lb = lambda ci: ci is not None and ci[0] > 0
    if len(lift) < 150 or res['lift_days'] < 100:
        verdict = 'UNRESOLVED'
    elif res['n']['mean'] <= 0 or res['mean_n_all_exec'] <= 0 or res['d']['mean'] <= 0 or res['d']['mean'] < COST['base']:
        verdict = 'KILLED'
    elif (lb(res['n']['ci_boot']) and lb(res['n']['ci_t']) and lb(res['d']['ci_boot']) and lb(res['d']['ci_t'])
          and res['half1']['n'] > 0 and res['half1']['d'] > 0 and res['half2']['n'] > 0 and res['half2']['d'] > 0
          and res['mean_n60'] > 0 and res['mean_n_x2'] > 0 and res['mean_n_liq'] > 0):
        verdict = 'PASS'
    else:
        verdict = 'NOT PASSED (not killed)'
    res['verdict'] = verdict
    blob = json.dumps({'summary': res, 'rows': rows, 'nonexec': nonexec}, sort_keys=True, indent=0).encode()
    open(os.path.join(out, 'results.json'), 'wb').write(blob)
    print(json.dumps(res, indent=1)); print('results.json sha256', hashlib.sha256(blob).hexdigest())


if __name__ == '__main__':
    {'needs': lambda o: needs(o), 'score': lambda d, o: score(d, o)}[sys.argv[1]](*sys.argv[2:])
