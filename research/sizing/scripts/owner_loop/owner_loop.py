"""Owner's capital-preservation sizing loop vs alternatives, on the real R1/R2 trade lists.

  python3 -I owner_loop.py <trades.json> <outdir>

Parameter sets: PARAMS.txt (fixed before any result). No look-ahead: a bet is decided at entry_ts from trades with
exit_ts <= entry_ts only. Outputs: results.json (everything) and report.txt (tables).
"""
import json, math, os, random, statistics, sys, datetime as dt
from collections import defaultdict

SEED = 20261007
N_PERM_SERIAL = 2000
N_PERM_SIZING = 400
MIN_BET = 0.05
START = 100.0
FIXED_SOL = 414009 / 1e9          # lottery.FIXED (per-trade fixed cost, SOL)
SOL_USD = 119.26                  # lottery.SOL_USD
F10 = FIXED_SOL / (10 / SOL_USD)  # fixed cost as a share of a $10 trade (~0.49%)


# ---------------------------------------------------------------- policies
class Fixed:
    def __init__(s, b=1.0): s.b = b
    def reset(s): pass
    def size(s, st): return s.b
    def closed(s, net, st, taken=True): pass


class Owner:
    def __init__(s, tiers, reset_thr, boost_thr, boost_mult, boost_n):
        s.tiers, s.reset_thr, s.boost_thr, s.boost_mult, s.boost_n = tiers, reset_thr, boost_thr, boost_mult, boost_n
    def reset(s): s.streak = 0; s.boost = 0
    def size(s, st):
        if s.boost > 0:
            s.boost -= 1
            return s.boost_mult
        b = s.tiers[0][1]
        for th, v in s.tiers:
            if s.streak >= th: b = v
        return b
    def closed(s, net, st, taken=True):
        if net >= s.reset_thr: s.streak = 0
        else: s.streak += 1
        if net >= s.boost_thr: s.boost = s.boost_n


class FF:
    def __init__(s, f): s.f = f
    def reset(s): pass
    def size(s, st): return s.f * st['eq']
    def closed(s, net, st, taken=True): pass


class EQF:
    def __init__(s, n=50, hi=1.0, lo=0.25): s.n, s.hi, s.lo = n, hi, lo
    def reset(s): s.pts = [START]
    def size(s, st):
        if len(s.pts) == 1: return s.hi
        w = s.pts[-s.n:]
        return s.hi if st['eq'] > sum(w) / len(w) else s.lo
    def closed(s, net, st, taken=True):
        if taken: s.pts.append(st['eq'])   # equity points only from trades actually held


class House:
    def __init__(s, base=0.5, share=0.05): s.base, s.share = base, share
    def reset(s): pass
    def size(s, st): return s.base + s.share * max(0.0, st['eq'] - START)
    def closed(s, net, st, taken=True): pass


ANY = 1e-12  # "net > 0"
POLICIES = {
    'FIXED': lambda: Fixed(1.0),
    'O1_owner': lambda: Owner([(0, 1.0), (10, 0.5), (30, 0.25), (60, 0.125)], 1.0, 9.0, 1.5, 20),
    'O2_faster': lambda: Owner([(0, 1.0), (5, 0.5), (15, 0.25), (30, 0.125)], 1.0, 9.0, 1.5, 20),
    'O3_gentle': lambda: Owner([(0, 1.0), (20, 0.5), (50, 0.25)], ANY, 4.0, 1.5, 30),
    'FF1': lambda: FF(0.01),
    'EQF': lambda: EQF(),
    'FF0.5*': lambda: FF(0.005),
    'FF2*': lambda: FF(0.02),
    'HOUSE*': lambda: House(),
}
PREREG = ['FIXED', 'O1_owner', 'O2_faster', 'O3_gentle', 'FF1', 'EQF']


# ---------------------------------------------------------------- simulator
def simulate(tr, pol, constrained=True, cost_adj=False, record=False):
    """tr: list of (entry_ts, exit_ts, net) in entry order. Returns metrics dict."""
    pol.reset()
    ev = [(x, 0, i) for i, (e, x, n) in enumerate(tr)] + [(e, 1, i) for i, (e, x, n) in enumerate(tr)]
    ev.sort()
    cash, open_cost = START, 0.0
    bets = [0.0] * len(tr)
    st = {'eq': START}
    curve = [START]
    peak, mdd, mn = START, 0.0, START
    skipped = 0
    for ts, kind, i in ev:
        e, x, net = tr[i]
        if kind == 1:
            want = max(0.0, pol.size(st))
            b = min(want, cash) if constrained else want
            if b < MIN_BET:
                if want >= MIN_BET: skipped += 1
                b = 0.0
            bets[i] = b
            cash -= b; open_cost += b
        else:
            b = bets[i]
            if b > 0:
                nb = net - F10 * (1 / b - 1) if cost_adj else net
                cash += b * (1 + nb); open_cost -= b
                st['eq'] = cash + open_cost
                pol.closed(net, st)
                eq = st['eq']
                if record: curve.append(eq)
                peak = max(peak, eq); mn = min(mn, eq)
                mdd = max(mdd, (peak - eq) / peak if peak > 0 else 0)
            else:
                pol.closed(net, st, taken=False)   # an untaken trade's outcome is still public information
    taken = [i for i, b in enumerate(bets) if b > 0]
    staked = sum(bets)
    pnl = cash + open_cost - START
    out = {'final': cash, 'ret_pct': 100 * (cash - START) / START, 'mdd_pct': 100 * mdd, 'min_eq': mn,
           'n_taken': len(taken), 'n_skipped_cash': skipped, 'avg_bet': staked / len(taken) if taken else 0.0,
           'staked': staked, 'w_edge': pnl / staked if staked else 0.0, 'bets': bets}
    if record: out['curve'] = curve
    return out


def shuffled(tr, rng):
    """Shuffle null: (net, hold) pairs reassigned to the real entry times."""
    pairs = [(x - e, n) for e, x, n in tr]
    rng.shuffle(pairs)
    return [(e, e + h, n) for (e, _, _), (h, n) in zip(tr, pairs)]


# ---------------------------------------------------------------- stats helpers
def fisher_two_sided(a, b, c, d):
    """2x2 [[a,b],[c,d]]; two-sided exact p (sum of tables no more likely than observed)."""
    r1, r2, c1 = a + b, c + d, a + c
    n = r1 + r2
    def lp(k): return (math.lgamma(r1 + 1) - math.lgamma(k + 1) - math.lgamma(r1 - k + 1) + math.lgamma(r2 + 1)
                       - math.lgamma(c1 - k + 1) - math.lgamma(r2 - c1 + k + 1) - math.lgamma(n + 1)
                       + math.lgamma(c1 + 1) + math.lgamma(n - c1 + 1))
    lo, hi = max(0, c1 - r2), min(r1, c1)
    p0 = lp(a)
    return min(1.0, sum(math.exp(lp(k)) for k in range(lo, hi + 1) if lp(k) <= p0 + 1e-9))


def binom_two_sided(k, n, p):
    if n == 0: return 1.0
    def pmf(j): return math.exp(math.lgamma(n + 1) - math.lgamma(j + 1) - math.lgamma(n - j + 1) + j * math.log(p) + (n - j) * math.log(1 - p)) if 0 < p < 1 else float(j == round(n * p))
    p0 = pmf(k)
    return min(1.0, sum(pmf(j) for j in range(n + 1) if pmf(j) <= p0 * (1 + 1e-9)))


def wilson(k, n, z=1.96):
    if n == 0: return (float('nan'), float('nan'))
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def closed_order(tr):
    """For each entry j: list of indices closed by entry_ts_j, in exit order. Returned as (order, count_at_entry)."""
    order = sorted(range(len(tr)), key=lambda i: (tr[i][1], i))
    xs = [tr[i][1] for i in order]
    import bisect
    cnt = [bisect.bisect_right(xs, tr[j][0]) for j in range(len(tr))]
    return order, cnt


def cond_after_k_losses(tr, win, k):
    order, cnt = closed_order(tr)
    w = [win(n) for _, _, n in tr]
    yes = [0, 0]; no = [0, 0]
    for j in range(len(tr)):
        c = cnt[j]
        if c < k: continue
        last = order[c - k:c]
        if all(not w[i] for i in last): yes[0] += 1; yes[1] += w[j]
        else: no[0] += 1; no[1] += w[j]
    return yes, no


def streak_buckets(tr, reset, buckets):
    order, cnt = closed_order(tr)
    res = {b: [0, 0] for b in buckets}
    w0 = [n > 0 for _, _, n in tr]
    for j in range(len(tr)):
        s = 0
        for i in reversed(order[:cnt[j]]):
            if tr[i][2] >= reset: break
            s += 1
        bk = [b for b in buckets if s >= b][-1]
        res[bk][0] += 1; res[bk][1] += w0[j]
    return res


def runs_stat(seq):
    return 1 + sum(1 for a, b in zip(seq, seq[1:]) if a != b) if seq else 0


def post_winner(tr, thr, N, win):
    """Union of the next N entries (entry_ts >= exit_ts of a closed winner with net >= thr)."""
    ents = [e for e, _, _ in tr]
    import bisect
    idx = set(); events = 0
    for e, x, n in tr:
        if n >= thr:
            events += 1
            s = bisect.bisect_left(ents, x)
            idx.update(range(s, min(len(tr), s + N)))
    k = sum(win(tr[i][2]) for i in idx)
    return events, len(idx), k


def chi2_groups(groups):
    """groups: list of (n, k). Homogeneity chi-square for a binary outcome."""
    N = sum(n for n, _ in groups); K = sum(k for _, k in groups)
    if K == 0 or K == N: return 0.0
    p = K / N; x = 0.0
    for n, k in groups:
        if n == 0: continue
        e1, e0 = n * p, n * (1 - p)
        x += (k - e1) ** 2 / e1 + ((n - k) - e0) ** 2 / e0
    return x


# ---------------------------------------------------------------- main
def main(src, outd):
    data = json.load(open(src))['trades']
    rng = random.Random(SEED)
    R = {}
    rep = []
    W = {'W0(net>0)': lambda n: n > 0, 'W1(net>=1)': lambda n: n >= 1}
    for key, rows in data.items():
        tr = [(r['entry_ts'], r['exit_ts'], r['net']) for r in rows]
        assert all(x > e for e, x, _ in tr) and [e for e, _, _ in tr] == sorted(e for e, _, _ in tr)
        res = {'sizing': {}, 'serial': {}}
        top = sorted(range(len(tr)), key=lambda i: -tr[i][2])[:3]
        mean_net = statistics.mean(n for _, _, n in tr)
        # ---- sizing, constrained (main), unconstrained, cost-adjusted
        for pname, mk in POLICIES.items():
            row = {}
            for mode, kw in (('main', {}), ('no_cash_limit', {'constrained': False}), ('size_costs', {'cost_adj': True})):
                m = simulate(tr, mk(), **kw)
                bets = m.pop('bets')
                m['top'] = [{'net': round(tr[i][2], 3), 'bet': round(bets[i], 4), 'pnl_units': round(bets[i] * tr[i][2], 3)} for i in top]
                row[mode] = m
            # matched fixed: same average bet, flat
            mb = row['main']['avg_bet']
            mm = simulate(tr, Fixed(mb)); mm.pop('bets')
            row['matched_fixed_main'] = {k: mm[k] for k in ('final', 'ret_pct', 'mdd_pct', 'min_eq', 'n_taken', 'avg_bet', 'w_edge')}
            res['sizing'][pname] = row
        # ---- timing value vs shuffle null (unconstrained, so only the sizing rule is tested)
        tv_obs = {p: res['sizing'][p]['no_cash_limit']['w_edge'] - mean_net for p in POLICIES}
        null = {p: [] for p in POLICIES}
        prng = random.Random(rng.random())
        for _ in range(N_PERM_SIZING):
            sh = shuffled(tr, prng)
            for p, mk in POLICIES.items():
                if p == 'FIXED': continue
                null[p].append(simulate(sh, mk(), constrained=False)['w_edge'] - mean_net)
        for p in POLICIES:
            if p == 'FIXED': continue
            nl = null[p]
            res['sizing'][p]['timing_value'] = {'obs': tv_obs[p], 'null_mean': statistics.mean(nl),
                                                'p_one_sided_ge': (1 + sum(v >= tv_obs[p] for v in nl)) / (1 + len(nl))}
        # ---- order luck: same trades, random order (shuffle null), main mode with the cash limit
        jt = top[0]
        olr = random.Random(rng.random())
        luck = {p: {'final': [], 'top_bet': []} for p in POLICIES}
        for _ in range(N_PERM_SIZING):
            perm = list(range(len(tr)))
            olr.shuffle(perm)
            sh = [(tr[a][0], tr[a][0] + (tr[b][1] - tr[b][0]), tr[b][2]) for a, b in enumerate(perm)]
            pos = perm.index(jt)
            for p, mk in POLICIES.items():
                m = simulate(sh, mk())
                luck[p]['final'].append(m['final']); luck[p]['top_bet'].append(m['bets'][pos])
        for p in POLICIES:
            f = sorted(luck[p]['final']); tb = luck[p]['top_bet']; n = len(f)
            res['sizing'][p]['order_luck_main'] = {'median_final': f[n // 2], 'p10_final': f[n // 10], 'p90_final': f[(9 * n) // 10],
                                                   'P_final_gt_100': sum(v > START for v in f) / n,
                                                   'mean_bet_at_top': statistics.mean(tb), 'P_missed_top': sum(v == 0 for v in tb) / n}
        # ---- without the single best trade (replaced by a -30% stop), main mode
        tr_x = list(tr); e0, x0, _ = tr_x[jt]; tr_x[jt] = (e0, x0, -0.3)
        for p, mk in POLICIES.items():
            m = simulate(tr_x, mk())
            res['sizing'][p]['main_without_top1'] = {'final': m['final'], 'ret_pct': m['ret_pct'], 'mdd_pct': m['mdd_pct']}
        # ---- serial dependence
        srl = res['serial']
        for wname, wf in W.items():
            base_k = sum(wf(n) for _, _, n in tr)
            d = {'base': [len(tr), base_k]}
            # P(win | last k closed all lost)
            for k in (5, 10, 20):
                yes, no = cond_after_k_losses(tr, wf, k)
                obs = (yes[1] / yes[0] if yes[0] else float('nan')) - (no[1] / no[0] if no[0] else float('nan'))
                d[f'after_{k}_losses'] = {'cond': yes, 'other': no, 'cond_rate': yes[1] / yes[0] if yes[0] else None,
                                          'other_rate': no[1] / no[0] if no[0] else None, 'cond_wilson95': wilson(yes[1], yes[0]),
                                          'fisher_p': fisher_two_sided(yes[1], yes[0] - yes[1], no[1], no[0] - no[1]) if yes[0] and no[0] else None,
                                          'diff': obs}
            # runs test by entry order
            seq = [wf(n) for _, _, n in tr]
            n1 = sum(seq); n2 = len(seq) - n1; n = len(seq)
            Rr = runs_stat(seq)
            ER = 2 * n1 * n2 / n + 1
            VR = 2 * n1 * n2 * (2 * n1 * n2 - n) / (n * n * (n - 1)) if n1 and n2 else 0
            z = (Rr - ER) / math.sqrt(VR) if VR > 0 else float('nan')
            sims = []
            s2 = seq[:]
            for _ in range(10000):
                prng.shuffle(s2); sims.append(runs_stat(s2))
            p_lo = (1 + sum(v <= Rr for v in sims)) / 10001
            p_hi = (1 + sum(v >= Rr for v in sims)) / 10001
            d['runs'] = {'wins': n1, 'losses': n2, 'runs': Rr, 'expected': ER, 'z': z,
                         'p_fewer_runs(clustering)': p_lo, 'p_more_runs': p_hi, 'p_two_sided': min(1.0, 2 * min(p_lo, p_hi))}
            # after a big winner closes
            for thr, lab in ((1.0, '2x'), (9.0, '10x')):
                for N in (20, 50):
                    ev_n, m_n, k_n = post_winner(tr, thr, N, wf)
                    rate = k_n / m_n if m_n else None
                    nulls = []
                    for _ in range(N_PERM_SERIAL // 2):
                        sh = shuffled(tr, prng)
                        e2, m2, k2 = post_winner(sh, thr, N, wf)
                        if m2: nulls.append(k2 / m2)
                    pv = (1 + sum(v >= rate for v in nulls)) / (1 + len(nulls)) if rate is not None and nulls else None
                    d[f'after_{lab}_next{N}'] = {'winner_events': ev_n, 'entries': m_n, 'wins': k_n, 'rate': rate,
                                                 'base_rate': base_k / len(tr),
                                                 'binom_p_vs_base': binom_two_sided(k_n, m_n, base_k / len(tr)) if m_n else None,
                                                 'shuffle_p_ge': pv}
            # calendar week / day (UTC, by entry)
            for gname, fmt in (('iso_week', lambda t: '%d-W%02d' % dt.datetime.fromtimestamp(t, dt.timezone.utc).isocalendar()[:2]),
                               ('day', lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%Y-%m-%d'))):
                lab = [fmt(e) for e, _, _ in tr]
                keys = sorted(set(lab))
                def groups(s):
                    g = defaultdict(lambda: [0, 0])
                    for l, v in zip(lab, s): g[l][0] += 1; g[l][1] += v
                    return [tuple(g[k]) for k in keys]
                x_obs = chi2_groups(groups(seq))
                s2 = seq[:]; cnt_ge = 0
                for _ in range(N_PERM_SERIAL):
                    prng.shuffle(s2)
                    cnt_ge += chi2_groups(groups(s2)) >= x_obs - 1e-12
                gg = groups(seq)
                d[gname] = {'chi2': x_obs, 'df': len(keys) - 1, 'perm_p': (1 + cnt_ge) / (1 + N_PERM_SERIAL),
                            'table': {k: list(v) for k, v in zip(keys, gg)}}
                # robustness (post hoc): only groups with enough entries (weeks >= 20, days >= 5)
                mins = 20 if gname == 'iso_week' else 5
                keep = [i for i, (n_, _) in enumerate(gg) if n_ >= mins]
                idxs = [t for t, l in enumerate(lab) if gg[keys.index(l)][0] >= mins]
                sub = [seq[t] for t in idxs]; sublab = [lab[t] for t in idxs]; kk = sorted(set(sublab))
                def g2(s_):
                    g = defaultdict(lambda: [0, 0])
                    for l, v in zip(sublab, s_): g[l][0] += 1; g[l][1] += v
                    return [tuple(g[k]) for k in kk]
                xo = chi2_groups(g2(sub)); s3 = sub[:]; c3 = 0
                for _ in range(N_PERM_SERIAL):
                    prng.shuffle(s3); c3 += chi2_groups(g2(s3)) >= xo - 1e-12
                d[gname]['robust_min%d' % mins] = {'groups': len(kk), 'entries': len(sub), 'chi2': xo, 'perm_p': (1 + c3) / (1 + N_PERM_SERIAL)}
            srl[wname] = d
        srl['W0_rate_by_owner_streak(reset net>=1)'] = {str(k): v for k, v in streak_buckets(tr, 1.0, [0, 10, 30, 60]).items()}
        srl['W0_rate_by_owner_streak(reset net>0)'] = {str(k): v for k, v in streak_buckets(tr, ANY, [0, 10, 30, 60]).items()}
        R[key] = res
        print('done', key, file=sys.stderr)
    json.dump(R, open(os.path.join(outd, 'results.json'), 'w'), indent=1, default=float)
    write_report(R, os.path.join(outd, 'report.txt'))


def write_report(R, path):
    L = []
    for key, res in R.items():
        L.append('=' * 110); L.append(key); L.append('=' * 110)
        for mode in ('main', 'no_cash_limit', 'size_costs'):
            L.append(f'-- sizing [{mode}]  (start 100 units)')
            L.append('%-10s %8s %8s %7s %7s %5s %5s %6s %8s  %-40s %s' % ('policy', 'final', 'ret%', 'mdd%', 'mineq', 'taken', 'skip', 'avgbet', 'w_edge', 'top3 winners: net@bet', 'timing p'))
            for p, row in res['sizing'].items():
                m = row[mode]
                tops = ' '.join('%.1f@%.2f' % (t['net'], t['bet']) for t in m['top'])
                tv = row.get('timing_value')
                tvs = '' if (tv is None or mode != 'no_cash_limit') else 'tv=%+.4f p=%.3f' % (tv['obs'], tv['p_one_sided_ge'])
                L.append('%-10s %8.2f %+8.2f %7.2f %7.2f %5d %5d %6.3f %+8.4f  %-40s %s' % (p, m['final'], m['ret_pct'], m['mdd_pct'], m['min_eq'], m['n_taken'], m['n_skipped_cash'], m['avg_bet'], m['w_edge'], tops, tvs))
        L.append('-- matched fixed (flat bet = policy average bet, main mode)')
        for p, row in res['sizing'].items():
            mf = row['matched_fixed_main']; m = row['main']
            L.append('%-10s policy final %8.2f mdd %6.2f | matched flat %.3f final %8.2f mdd %6.2f' % (p, m['final'], m['mdd_pct'], mf['avg_bet'], mf['final'], mf['mdd_pct']))
        for wname, d in res['serial'].items():
            if not wname.startswith('W'): continue
            if wname.startswith('W0_rate') or wname.startswith('W0_'):
                pass
            if 'base' not in d:
                L.append(f'-- {wname}: ' + json.dumps(d)); continue
            n, k = d['base']
            L.append(f'-- serial {wname}: base {k}/{n} = {k / n:.3%}')
            for kk in (5, 10, 20):
                x = d[f'after_{kk}_losses']
                L.append('   after %2d closed losses: %s/%s = %s (95%% CI %.3f-%.3f) vs other %s/%s = %s  fisher p=%s' % (
                    kk, x['cond'][1], x['cond'][0], '%.3f' % x['cond_rate'] if x['cond_rate'] is not None else '-', *x['cond_wilson95'],
                    x['other'][1], x['other'][0], '%.3f' % x['other_rate'] if x['other_rate'] is not None else '-', '%.3f' % x['fisher_p'] if x['fisher_p'] is not None else '-'))
            r = d['runs']
            L.append('   runs: %d observed vs %.1f expected (z=%.2f), p(clustering)=%.3f, p two-sided=%.3f' % (r['runs'], r['expected'], r['z'], r['p_fewer_runs(clustering)'], r['p_two_sided']))
            for lab in ('2x', '10x'):
                for N in (20, 50):
                    x = d[f'after_{lab}_next{N}']
                    L.append('   after a %s winner closes, next %d entries: %d events, %s/%s = %s vs base %.3f, binom p=%s, shuffle p=%s' % (
                        lab, N, x['winner_events'], x['wins'], x['entries'], '%.3f' % x['rate'] if x['rate'] is not None else '-', x['base_rate'],
                        '%.3f' % x['binom_p_vs_base'] if x['binom_p_vs_base'] is not None else '-', '%.3f' % x['shuffle_p_ge'] if x['shuffle_p_ge'] is not None else '-'))
            for g in ('iso_week', 'day'):
                x = d[g]
                L.append('   by %s: chi2=%.1f df=%d perm p=%.3f  %s' % (g, x['chi2'], x['df'], x['perm_p'],
                         ' '.join(f'{k[-5:]}:{v[1]}/{v[0]}' for k, v in x['table'].items()) if g == 'iso_week' else ''))
        for s in ('W0_rate_by_owner_streak(reset net>=1)', 'W0_rate_by_owner_streak(reset net>0)'):
            L.append(f'-- {s}: ' + '  '.join(f'streak>={k}: {v[1]}/{v[0]}' for k, v in res['serial'][s].items()))
    open(path, 'w').write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])


# ---------------------------------------------------------------- pooled view + power (appended to report)
def mde_ratio(n1, n2, p0, alpha_z=1.959964, power_z=0.841621):
    """Smallest rate ratio r (p1 = r*p0 in group 1 vs p0 in group 2) detectable with 80% power, two-sided 5%."""
    if n1 == 0 or n2 == 0 or p0 <= 0: return None
    r = 1.0
    while r < 50:
        p1 = min(0.999, r * p0); pb = (n1 * p1 + n2 * p0) / (n1 + n2)
        se0 = math.sqrt(pb * (1 - pb) * (1 / n1 + 1 / n2)); se1 = math.sqrt(p1 * (1 - p1) / n1 + p0 * (1 - p0) / n2)
        if abs(p1 - p0) >= alpha_z * se0 + power_z * se1: return r
        r += 0.01
    return None


def pooled(outd):
    R = json.load(open(os.path.join(outd, 'results.json')))
    L = ['', '=' * 110, 'POOLED (exploration + validation counts summed; approximate, ignores that the samples differ)', '=' * 110]
    for rule in ('R1|pess', 'R1|opt', 'R2|pess', 'R2|opt'):
        for w in ('W0(net>0)', 'W1(net>=1)'):
            parts = []
            for k in (5, 10, 20):
                cy = [0, 0]; co = [0, 0]
                for smp in ('exploration', 'validation'):
                    x = R[f'{smp}|{rule}']['serial'][w][f'after_{k}_losses']
                    cy[0] += x['cond'][0]; cy[1] += x['cond'][1]; co[0] += x['other'][0]; co[1] += x['other'][1]
                fp = fisher_two_sided(cy[1], cy[0] - cy[1], co[1], co[0] - co[1]) if cy[0] and co[0] else float('nan')
                base = (cy[1] + co[1]) / (cy[0] + co[0]) if cy[0] + co[0] else 0
                mr = mde_ratio(cy[0], co[0], base)
                parts.append('k=%d: %d/%d=%.3f vs %d/%d=%.3f p=%.2f (detectable ratio>=%s)' % (
                    k, cy[1], cy[0], cy[1] / cy[0] if cy[0] else float('nan'), co[1], co[0], co[1] / co[0] if co[0] else float('nan'), fp,
                    '%.1f' % mr if mr else '-'))
            L.append(f'{rule} {w}: ' + ' | '.join(parts))
    L.append('')
    L.append('-- order luck (same trades in 400 random orders, main mode): median final [p10-p90], P(final>100), mean bet at top winner, P(missed it)')
    for key, res in R.items():
        L.append(key)
        for p, row in res['sizing'].items():
            o = row['order_luck_main']; w = row['main_without_top1']
            L.append('   %-10s %7.1f [%6.1f-%6.1f] P>100=%.2f  bet@top=%.2f  missed=%.2f | real order without top trade: final %.1f mdd %.1f%%' % (
                p, o['median_final'], o['p10_final'], o['p90_final'], o['P_final_gt_100'], o['mean_bet_at_top'], o['P_missed_top'], w['final'], w['mdd_pct']))
    L.append('')
    L.append('-- calendar robustness (post hoc; only weeks with >=20 and days with >=5 entries)')
    for key, res in R.items():
        for w in ('W0(net>0)', 'W1(net>=1)'):
            d = res['serial'][w]
            a = d['iso_week']['robust_min20']; b = d['day']['robust_min5']
            L.append('   %-22s %-11s week: chi2=%.1f groups=%d p=%.3f | day: chi2=%.1f groups=%d p=%.3f (all groups: week p=%.3f, day p=%.3f)' % (
                key, w, a['chi2'], a['groups'], a['perm_p'], b['chi2'], b['groups'], b['perm_p'], d['iso_week']['perm_p'], d['day']['perm_p']))
    open(os.path.join(outd, 'report.txt'), 'a').write('\n'.join(L) + '\n')


if __name__ == '__main__' and len(sys.argv) > 2:
    pooled(sys.argv[2])
