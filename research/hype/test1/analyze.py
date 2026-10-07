"""Hype Test 1 analysis (rules fixed in PREREG.md before any API call).

  python3 -I analyze.py retention <explore_orders.jsonl> <fresh_orders.jsonl>
  python3 -I analyze.py run <sample.json> <hourlydir> <fresh_orders.jsonl> <out.json> [test2_p_EA test2_p_EB]
"""
import datetime, json, math, os, statistics, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'runner-probe'))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'lottery-probe'))
import runner, lottery

CUT_MS = 1787270400000                 # 2026-08-21T00:00Z: no coin created on or after this
H, DAY = 3600, 86400
Q = runner.SIZES['$10']
CAP = 19.0                              # net +1900% = gross proceeds 20x the stake
LOG_FLOOR = 0.001
B = 20000
ALPHA = 0.05
STOP, ARM, TRAIL = 0.3, 2.0, 0.4        # R1
OUTCOME_VIEWED = os.path.join(HERE, '..', '..', 'deep-pool-probe', 'universe.json')
EXPLORE = {'paid_share_2min': [201, 492], 'mean_paid': -0.317, 'mean_unpaid': 0.279, 'capped_paid': -0.317, 'capped_unpaid': -0.102}


def load_orders(path):
    """mint -> body of an HTTP 200 answer (the last one if several), or None when no 200 answer exists."""
    out = {}
    for l in open(path):
        try:
            r = json.loads(l)
        except Exception:
            continue
        m = r.get('mint')
        if m is None:
            continue
        if r.get('status') == 200 and isinstance(r.get('body'), dict):
            out[m] = r['body']
        else:
            out.setdefault(m, None)
    return out


def flags(body, te):
    """Signals from orders paid at or before the cutoff only (te in seconds)."""
    od = body.get('orders') or []
    bs = body.get('boosts') or []
    c15, c60 = (te - 900) * 1000, (te - 3600) * 1000
    prof = [o for o in od if o.get('type') == 'tokenProfile']
    def paid(cut, sts):
        return any(o.get('status') in sts and o.get('paymentTimestamp') is not None and o['paymentTimestamp'] <= cut for o in prof)
    return {
        'PAID': paid(c15, ('approved',)),
        'PAID60': paid(c60, ('approved',)),
        'PAID_CANC': paid(c15, ('approved', 'cancelled')),
        'NONAPPROVED_PROFILE': any(o.get('status') != 'approved' for o in prof),
        'BOOST': sum(b.get('amount') or 0 for b in bs if b.get('paymentTimestamp') is not None and b['paymentTimestamp'] <= c15) >= 10,
        'CTO': any(o.get('type') == 'communityTakeover' and o.get('status') == 'approved' and o.get('paymentTimestamp') is not None
                   and o['paymentTimestamp'] <= c15 for o in od),
    }


def trade_close_stop(x, stop, arm, trail):
    """R1 hourly line, but the stop fires only on an hourly close at or below the level (filled at that close)."""
    c, v = x['c'], x['v']
    e = 1; p0 = c[e]; peak = p0; armed = False
    if e + runner.MAX_HOLD > len(c) - 1:
        return None
    last = e + runner.MAX_HOLD
    for i in range(e + 1, last + 1):
        if stop is not None and not armed and c[i] <= p0 * (1 - stop):
            return p0, c[i], 'stop'
        if c[i] > peak and v[i] > 0:
            peak = c[i]
        if not armed and peak >= arm * p0:
            armed = True
        if armed and c[i] <= peak * (1 - trail):
            return p0, c[i], 'trail'
    return p0, c[last], 'time'


def net_of(leg):
    return lottery.net(leg[0], max(leg[1], 1e-18), Q)[0]


def day_of(ms):
    s = ms // 1000
    return s - s % DAY


# ---------- bootstrap machinery ----------

class DayBoot:
    """Day-block bootstrap: resample creation days with replacement, keep every coin of a drawn day.
    The same day draws are reused for every statistic (seeded)."""
    def __init__(self, days, seed=20261007):
        self.ud = sorted(set(days))
        idx = {d: i for i, d in enumerate(self.ud)}
        self.di = np.array([idx[d] for d in days])
        rng = np.random.default_rng(seed)
        D = len(self.ud)
        draws = rng.integers(0, D, size=(B, D))
        self.W = np.stack([np.bincount(r, minlength=D) for r in draws]).astype(float)   # B x D weights

    def sums(self, vals, mask):
        """B-vector of resampled sums and counts of vals over coins in mask."""
        D = len(self.ud)
        s = np.bincount(self.di[mask], weights=np.asarray(vals, float)[mask], minlength=D)
        n = np.bincount(self.di[mask], minlength=D).astype(float)
        return self.W @ s, self.W @ n


class CoinBoot:
    """iid bootstrap over coins (each coin is one trade)."""
    def __init__(self, n, seed=20261009):
        rng = np.random.default_rng(seed)
        self.W = np.empty((B, n), np.float32)          # about 130 MB at n = 1,640
        for b in range(B):
            self.W[b] = np.bincount(rng.integers(0, n, n), minlength=n)

    def sums(self, vals, mask):
        v = np.where(mask, np.asarray(vals, float), 0.0)
        return (self.W @ v.astype(np.float32)).astype(float), (self.W @ mask.astype(np.float32)).astype(float)


def diff_dist(bt, vals, g):
    sp, np_ = bt.sums(vals, g); su, nu = bt.sums(vals, ~g)
    ok = (np_ > 0) & (nu > 0)          # a replicate with an empty group is dropped (equivalent to redrawing)
    return (sp[ok] / np_[ok]) - (su[ok] / nu[ok])


def mean_dist(bt, vals, g):
    s, n = bt.sums(vals, g)
    ok = n > 0
    return s[ok] / n[ok]


def adj_dist(bt, vals, g, strata):
    """Stratified difference: sum over strata holding both groups of (n_s/N)(mean_P,s - mean_U,s), N over those strata."""
    acc = []
    for s in sorted(set(strata)):
        m = strata == s
        sp, np_ = bt.sums(vals, g & m); su, nu = bt.sums(vals, (~g) & m)
        both = (np_ > 0) & (nu > 0)
        ns = np_ + nu
        d = np.where(both, sp / np.where(np_ > 0, np_, 1) - su / np.where(nu > 0, nu, 1), 0.0)
        acc.append((np.where(both, ns, 0.0), d))
    N = sum(a[0] for a in acc)
    return sum(a[0] * a[1] for a in acc)[N > 0] / N[N > 0]


def adj_point(vals, g, strata):
    vals = np.asarray(vals, float)
    num = N = 0.0
    for s in sorted(set(strata)):
        m = strata == s
        if (g & m).any() and ((~g) & m).any():
            ns = m.sum()
            num += ns * (vals[g & m].mean() - vals[(~g) & m].mean()); N += ns
    return num / N if N else None


def pct(dist, level):
    a = (1 - level) / 2
    return [float(np.quantile(dist, a)), float(np.quantile(dist, 1 - a))]


def boot_p(dist):
    return float(max(1.0 / B, min(1.0, 2 * min((dist <= 0).mean(), (dist >= 0).mean()))))


def holm(ps, alpha=ALPHA):
    """Step-down Holm. Returns (reject list, per-hypothesis level used at its step)."""
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    rej = [False] * m; lvl = [None] * m; stop = False
    for k, i in enumerate(order):
        a = alpha / (m - k)
        lvl[i] = a
        if not stop and ps[i] <= a:
            rej[i] = True
        else:
            stop = True
    return rej, lvl


def random_band(vals, days, g, seed=20261008, reps=10000):
    """Capped means of random subsets with PAID's count per creation day."""
    rng = np.random.default_rng(seed)
    vals = np.asarray(vals, float)
    pools = {}
    for i, d in enumerate(days):
        pools.setdefault(d, []).append(i)
    need = {d: int(sum(1 for i in ix if g[i])) for d, ix in pools.items()}
    tot = sum(need.values())
    if not tot:
        return None
    out = np.empty(reps)
    for r in range(reps):
        s = 0.0
        for d, k in need.items():
            if k:
                s += vals[rng.choice(pools[d], size=k, replace=False)].sum()
        out[r] = s / tot
    return out


def gstats(vals, caps, logs):
    n = len(vals)
    if not n:
        return {'n': 0}
    srt = sorted(vals)
    return {'n': n, 'mean': statistics.fmean(vals), 'mean_capped': statistics.fmean(caps), 'mean_log': statistics.fmean(logs),
            'median': statistics.median(vals), 'win': sum(v > 0 for v in vals) / n, 'best': srt[-1],
            'mean_wo_best': statistics.fmean(srt[:-1]) if n > 1 else None, 'sd_capped': statistics.stdev(caps) if n > 1 else None,
            'n_ge_10x': sum(v >= 9 for v in vals), 'n_ge_50x': sum(v >= 49 for v in vals), 'sum_net_ge_10x': sum(v for v in vals if v >= 9)}


# ---------- retention check ----------

def retention(explore_path, fresh_path):
    lo, hi = 1784678400000, 1784937600000      # 2026-07-22T00:00Z .. 07-25T00:00Z
    res = {}
    for name, path in (('explore900', explore_path), ('fresh3000', fresh_path)):
        n200 = 0; total = 0; old_orders = 0; byday = {}
        created = {}
        for l in open(path):
            r = json.loads(l); created[r['mint']] = r['created_ts_ms']
        od = load_orders(path)
        for m, body in od.items():
            total += 1
            if body is None:
                continue
            n200 += 1
            prof = [o for o in body.get('orders') or [] if o.get('type') == 'tokenProfile' and o.get('status') == 'approved']
            old_orders += sum(1 for o in prof if lo <= (o.get('paymentTimestamp') or 0) < hi)
            d = datetime.datetime.fromtimestamp(created[m] / 1000, datetime.UTC).strftime('%m-%d')
            a = byday.setdefault(d, [0, 0]); a[1] += 1; a[0] += bool(prof)
        res[name] = {'mints_answered': total, 'http200': n200, 'approved_profiles_paid_0722_0724': old_orders,
                     'share_any_approved_profile': sum(a[0] for a in byday.values()) / max(1, sum(a[1] for a in byday.values())),
                     'by_creation_day': {d: [a[0], a[1], a[0] / a[1]] for d, a in sorted(byday.items())}}
    return res


# ---------- main run ----------

def run(sample, hdir, orders_path, out, p_ea='1', p_eb='1'):
    us = json.load(open(sample))
    assert all(u['created_ts_ms'] < CUT_MS for u in us), 'coin created on or after 2026-08-21'
    cs, counts = runner.coins(sample, hdir)
    assert all(x['u']['created_ts_ms'] < CUT_MS for x in cs)
    orders = load_orders(orders_path)
    n_mints = len(us)
    n200 = sum(1 for u in us if orders.get(u['mint']) is not None)
    viewed = {x['mint'] for x in json.load(open(OUTCOME_VIEWED))}
    last_bar = runner.WALL - H
    counts.update({'excluded-entry-near-cutoff': 0, 'hold-past-data': 0, 'orders-unknown': 0})
    rows = []
    for x in cs:
        if x['ts'][1] + runner.MAX_HOLD * H > last_bar:
            counts['excluded-entry-near-cutoff'] += 1; continue
        leg = runner.trade(x, STOP, ARM, TRAIL, 'pess')
        if leg is None:
            counts['hold-past-data'] += 1; continue
        body = orders.get(x['u']['mint'])
        if body is None:
            counts['orders-unknown'] += 1; continue
        te = x['ts'][1] + H
        f = flags(body, te)
        c, v = x['c'], x['v']
        last = 1 + runner.MAX_HOLD
        peak = max([c[i] for i in range(2, last + 1) if v[i] > 0] or [c[1]]) / c[1]
        rows.append({
            'mint': x['u']['mint'], 'day': day_of(x['u']['created_ts_ms']), 'te': te, **f,
            'viewed': x['u']['mint'] in viewed,
            'net': net_of(leg), 'reason': leg[2],
            'net_opt': net_of(runner.trade(x, STOP, ARM, TRAIL, 'opt')),
            'net_close': net_of(trade_close_stop(x, STOP, ARM, TRAIL)),
            'net_r3': net_of(runner.trade(x, None, ARM, TRAIL, 'pess')),
            'h1': c[1] / c[0], 'lv01': math.log(v[0] + v[1] + 1e-9), 'peak': peak,
        })
    n = len(rows)
    days = [r['day'] for r in rows]
    db = DayBoot(days); cb = CoinBoot(n)
    cap = lambda vals: [min(z, CAP) for z in vals]
    lg = lambda vals: [math.log(max(1 + z, LOG_FLOOR)) for z in vals]
    # strata: tertiles of h1 and of log hour 0-1 volume over all usable coins (no outcome used)
    h1 = np.array([r['h1'] for r in rows]); lv = np.array([r['lv01'] for r in rows])
    th = np.quantile(h1, [1 / 3, 2 / 3]); tv = np.quantile(lv, [1 / 3, 2 / 3])
    strata = np.searchsorted(th, h1, side='right') * 3 + np.searchsorted(tv, lv, side='right')

    LEVEL = [None]
    res = {'counts': counts, 'mints': n_mints, 'orders_http200': n200, 'orders_http200_share': n200 / n_mints, 'usable_known': n}

    def compare(name, flag, key='net', subset=None, level=None, full=False):
        level = level if level is not None else LEVEL[0]
        sel = np.array([subset(r) if subset else True for r in rows])
        g = np.array([bool(r[flag]) for r in rows])[sel]
        raw = [r[key] for r, s in zip(rows, sel) if s]
        cv, lgv = cap(raw), lg(raw)
        P = [i for i in range(len(raw)) if g[i]]; U = [i for i in range(len(raw)) if not g[i]]
        out = {'PAID': gstats([raw[i] for i in P], [cv[i] for i in P], [lgv[i] for i in P]),
               'UNPAID': gstats([raw[i] for i in U], [cv[i] for i in U], [lgv[i] for i in U])}
        if not P or not U:
            return out
        dsub = [d for d, s in zip(days, sel) if s]
        bt = db if subset is None else DayBoot(dsub)
        D = out['PAID']['mean_capped'] - out['UNPAID']['mean_capped']
        dd = diff_dist(bt, cv, g)
        out['D_capped'] = D; out['D_capped_ci95_day'] = pct(dd, 0.95); out['D_capped_p_day'] = boot_p(dd)
        out['boot_reps_kept_day'] = int(len(dd))
        if level is not None:
            out['D_capped_ci_holm_day'] = pct(dd, level)
        out['D_log'] = out['PAID']['mean_log'] - out['UNPAID']['mean_log']; out['D_log_ci95_day'] = pct(diff_dist(bt, lgv, g), 0.95)
        out['D_uncapped'] = out['PAID']['mean'] - out['UNPAID']['mean']
        if full:
            out['_dd'] = dd
            out['D_capped_ci95_coin'] = pct(diff_dist(cb, cv, g), 0.95)
            out['_paid_mean_dist'] = mean_dist(bt, cv, g)
        return out

    prim = compare('PAID', 'PAID', full=True)
    if 'D_capped_p_day' not in prim:                      # an empty group: nothing to compare
        res['primary'] = prim; res['verdict'] = 'insufficient data'
        json.dump(res, open(out, 'w'), indent=1, default=float)
        print(json.dumps({'counts': counts, 'n': n, 'verdict': res['verdict']}, default=float)); return
    ps = [prim['D_capped_p_day'], float(p_ea), float(p_eb)]
    rej, lvl = holm(ps)
    level = 1 - lvl[0]
    LEVEL[0] = level
    dd = prim.pop('_dd'); pm = prim.pop('_paid_mean_dist')
    prim['holm'] = {'family_p': {'T1_PAID': ps[0], 'T2_EA': ps[1], 'T2_EB': ps[2]}, 'reject_T1_PAID': rej[0], 'level': level}
    prim['D_capped_ci_holm_day'] = pct(dd, level)
    prim['PAID_mean_capped_ci_holm_day'] = pct(pm, level)
    prim['PAID_mean_capped_ci95_day'] = pct(pm, 0.95)
    g = np.array([r['PAID'] for r in rows])
    capv = cap([r['net'] for r in rows])
    band = random_band(capv, days, g)
    pm_obs = prim['PAID']['mean_capped']
    if band is not None:
        prim['random_band_holm'] = pct(band, level); prim['random_band_95'] = pct(band, 0.95)
        prim['PAID_inside_band_holm'] = prim['random_band_holm'][0] <= pm_obs <= prim['random_band_holm'][1]
        prim['PAID_inside_band_95'] = prim['random_band_95'][0] <= pm_obs <= prim['random_band_95'][1]
    adj = adj_dist(db, capv, g, strata)
    prim['D_adj'] = adj_point(capv, g, strata); prim['D_adj_ci_holm_day'] = pct(adj, level); prim['D_adj_ci95_day'] = pct(adj, 0.95)
    prim['strata_counts'] = {int(s): [int(((strata == s) & g).sum()), int(((strata == s) & ~g).sum())] for s in sorted(set(strata))}
    res['primary'] = prim
    allv = [r['net'] for r in rows]
    res['basket_R1_all'] = gstats(allv, cap(allv), lg(allv))
    res['basket_R1_all']['ci95_capped_day'] = pct(mean_dist(db, cap(allv), np.ones(n, bool)), 0.95)

    sens = {}
    sens['PAID60'] = compare('PAID60', 'PAID60')
    sens['PAID_incl_cancelled'] = compare('PAID_CANC', 'PAID_CANC')
    sens['PAID_clean'] = compare('PAID', 'PAID', subset=lambda r: not r['NONAPPROVED_PROFILE'])
    sens['without_outcome_viewed'] = compare('PAID', 'PAID', subset=lambda r: not r['viewed'])
    sens['realtime_line'] = compare('PAID', 'PAID', key='net_opt')
    sens['close_triggered_stop'] = compare('PAID', 'PAID', key='net_close')
    sens['R3_no_stop'] = compare('PAID', 'PAID', key='net_r3')
    sens['BOOST_descriptive'] = compare('BOOST', 'BOOST')
    sens['CTO_diagnostic'] = compare('CTO', 'CTO')
    res['sensitivity'] = sens
    res['outcome_viewed_in_usable'] = [r['mint'] for r in rows if r['viewed']]
    res['flag_counts'] = {k: sum(1 for r in rows if r[k]) for k in ('PAID', 'PAID60', 'PAID_CANC', 'NONAPPROVED_PROFILE', 'BOOST', 'CTO')}
    res['reasons'] = {grp: {k: sum(1 for r in rows if r['PAID'] == pv and r['reason'] == k) for k in ('stop', 'trail', 'time')}
                      for grp, pv in (('PAID', True), ('UNPAID', False))}
    res['at_entry'] = {grp: {'median_h1': statistics.median([r['h1'] for r in rows if r['PAID'] == pv]),
                             'median_vol01_gt_volume_units': statistics.median([math.exp(r['lv01']) for r in rows if r['PAID'] == pv])}
                       for grp, pv in (('PAID', True), ('UNPAID', False)) if any(r['PAID'] == pv for r in rows)}
    big = [r for r in rows if r['peak'] >= 10]
    res['peak_ge_10x'] = {'n': len(big), 'paid': sum(r['PAID'] for r in big),
                          'coins': [{'mint': r['mint'][:8], 'peak': round(r['peak'], 1), 'PAID': r['PAID'], 'net': round(r['net'], 3),
                                     'net_opt': round(r['net_opt'], 3)} for r in sorted(big, key=lambda r: -r['peak'])]}
    res['peak_ge_5x'] = {'paid': [sum(1 for r in rows if r['PAID'] and r['peak'] >= 5), sum(r['PAID'] for r in rows)],
                         'unpaid': [sum(1 for r in rows if not r['PAID'] and r['peak'] >= 5), sum(not r['PAID'] for r in rows)]}
    res['bankroll_all'] = runner.bankroll([(r['te'] - H, r['net']) for r in rows], 10.0)
    res['bankroll_without_paid'] = runner.bankroll([(r['te'] - H, r['net']) for r in rows if not r['PAID']], 10.0)
    byday = {}
    for r in rows:
        k = datetime.datetime.fromtimestamp(r['day'], datetime.UTC).strftime('%m-%d')
        a = byday.setdefault(k, [0, 0]); a[1] += 1; a[0] += r['PAID']
    res['paid_share_by_day'] = byday
    res['exploration_reference'] = EXPLORE
    res['power_note'] = 'normal approx, iid, capped SD from exploration 0.99; recomputed with this sample in RESULTS'
    res['verdict'] = verdict(res)
    json.dump(res, open(out, 'w'), indent=1, default=float)
    print(json.dumps({'counts': counts, 'n': n, 'http200_share': res['orders_http200_share'], 'verdict': res['verdict']}, default=float))


def verdict(res):
    p = res['primary']
    if res['orders_http200_share'] < 0.95 or res['usable_known'] < 1200:
        return 'insufficient data'
    better = p['holm']['reject_T1_PAID'] and p['D_capped'] > 0
    worse = p['holm']['reject_T1_PAID'] and p['D_capped'] < 0
    if better or worse:
        d60 = res['sensitivity']['PAID60'].get('D_capped')
        flip = d60 is not None and d60 * p['D_capped'] < 0
    if better and p['PAID_mean_capped_ci_holm_day'][1] < 0.08:
        return 'kill (b): PAID better but cannot rescue the strategy'     # a kill is never deferred (amendment A1)
    if (better or worse) and flip:
        return 'waits for Test 3 (sign flips between 15- and 60-min buffers)'
    if better:
        a = p['D_adj_ci_holm_day']
        if a[0] <= 0 <= a[1]:
            return 'better, but adds nothing beyond price and volume: prefer a price-only rule'
        return 'better: candidate entry filter, needs a written validation PREREG'
    if worse:
        return 'worse: candidate reject or exit-width feature for a validation PREREG only'
    if p.get('PAID_inside_band_holm'):
        return 'kill (a): drop attention at entry as an entry signal'
    return 'no supported difference; PAID outside the random band; not an entry signal'


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'retention':
        print(json.dumps(retention(*sys.argv[2:4]), indent=1))
    else:
        run(*sys.argv[2:])
