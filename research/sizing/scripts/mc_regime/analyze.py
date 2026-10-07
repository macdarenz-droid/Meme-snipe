#!/usr/bin/env python3
"""Tables and break-even rates from main_results.json and sweep_results.json -> report.txt and summary.json."""
import json, math, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = []
def p(*a): OUT.append(' '.join(str(x) for x in a))
def lamf(x): return '1/%d' % round(1 / x) if x and x > 0 else '-'
def g(x): return '-' if x is None else ('%.3g' % x if abs(x) >= 1000 else '%.1f' % x)
def f3(x): return '-' if x is None else '%.3f' % x


def poisson_ci1():
    """Exact 95% CI for a Poisson mean when 1 event was seen."""
    lo = -math.log(1 - 0.025)
    a, b = 1.0, 20.0
    for _ in range(200):
        m = (a + b) / 2
        a, b = (m, b) if math.exp(-m) * (1 + m) > 0.025 else (a, m)
    return lo, (a + b) / 2


def cross(xs, ys, ses=None):
    out = []
    for i in range(len(xs) - 1):
        y0, y1 = ys[i], ys[i + 1]
        if y0 == 0 or y0 * y1 < 0:
            x = xs[i] + (xs[i + 1] - xs[i]) * (-y0) / (y1 - y0)
            se = None
            if ses is not None:
                slope = (y1 - y0) / (xs[i + 1] - xs[i]); se = 0.5 * (ses[i] + ses[i + 1]) / abs(slope)
            out.append((x, se))
    return out


def cs(c, ys=None):
    if not c:
        if ys is None: return 'none in grid'
        return 'OWNER ahead at every rate in grid' if min(ys) > 0 else ('OWNER behind at every rate in grid' if max(ys) < 0 else 'mixed')
    return '; '.join('%s (approx %s..%s)' % (lamf(x), lamf(x + 2 * se), lamf(max(x - 2 * se, 1e-9))) if se else lamf(x) for x, se in c)


def main():
    M = json.load(open(os.path.join(HERE, 'main_results.json')))
    info = M['info']; summ = dict(info=info)
    lo, hi = poisson_ci1()
    p('MONTE CARLO OF SIZING SCHEMES  (N=%d paths x T=%d trades per cell, start %g units, ruin < %g units, absorbing)' % (M['N'], M['T'], M['start'], M['ruin']))
    p('Model from R1 pess exploration+validation: %d trades = %d losses (mean net %+.3f), %d small winners (rate %.4f, mean net %+.3f, %d at >=2x, %d at >=10x).'
      % (info['ntot'], info['nloss'], info['loss_mean'], info['nwin'], info['pw'], info['win_mean'], info['win_ge2x'], info['win_ge10x']))
    p('Removed and replaced by the jackpot process: net', [round(x, 1) for x in info['jack_removed']], '-> data jackpot rate 1/%d, exact Poisson 95%% CI 1/%d .. 1/%d per trade.'
      % (info['ntot'], round(info['ntot'] / lo), round(info['ntot'] / hi)))
    p('EV per trade without jackpots: %+.4f. FIXED break-even jackpot rate (analytic, mu = 0): %s' % (info['base_ev_no_jack'], ', '.join('J=%g: %s' % (float(J), lamf(v)) for J, v in info['be_fixed'].items())))
    p('Info delay (later entries before close): losses median %g, small winners median %g; jackpot fixed at 31.' % (info['loss_delay_median'], info['win_delay_median']))
    summ['jack_rate_ci'] = [1 / (info['ntot'] / lo), 1 / (info['ntot'] / hi)]
    R = M['results']
    schemes = list(R[0]['res'].keys())
    summ['main'] = []
    for world in ('IID', 'REGIME'):
        p(''); p('=' * 30, world, '(hot 10% of trades, mean hot run 30 trades, winner+jackpot rates 5x in hot)' if world == 'REGIME' else '(independent trades)', '=' * 30)
        for J in (30.0, 100.0, 300.0):
            cells = sorted([c for c in R if c['world'] == world and c['J'] == J], key=lambda c: c['lam'])
            lams = [c['lam'] for c in cells]
            be = info['be_fixed'][str(J)]
            p(''); p('--- J = %g net (%gx proceeds); FIXED break-even 1/%d ---' % (J, J + 1, round(1 / be)))
            show = [c for c in cells if any(abs(c['lam'] - x) / x < 1e-9 for x in (1 / 2000, 1 / 1000, be, 1 / 200, 1 / 100))]
            for c in show:
                p('  lam %s  mu %+.3f/unit  Kelly f* %.4f  jackpots/path %.2f' % (lamf(c['lam']), c['mu'], c['kelly_f'], c['jack_per_path']))
                p('    %-11s %9s %8s %7s %7s %6s %7s %8s %7s %6s' % ('scheme', 'mean', 'median', 'P(ruin)', 'P(>st)', 'maxDD', 'stake', 'ret/stk', 'jackCap', 'hot%'))
                for a in schemes:
                    v = c['res'][a]
                    p('    %-11s %9s %8s %7.3f %7.3f %6.2f %7s %8s %7s %6s' % (a, g(v['mean']), g(v['median']), v['p_ruin'], v['p_gain'], v['mdd'], g(v['stake']),
                      '-' if v['ros'] is None else '%+.4f' % v['ros'], '-' if v['jack_capture'] is None else '%.3g' % v['jack_capture'], '-' if v['hot_stake_share'] is None else '%.3f' % v['hot_stake_share']))
            # break-evens
            p('  Break-even jackpot rate (mean P&L = 0; ~2-SE band from Monte Carlo noise):')
            be_out = {}
            for a in ('FIXED', 'OWNER', 'OWNER_LAG', 'OWNER_FF', 'FF1'):
                c_ = cross(lams, [c['res'][a]['mean'] - M['start'] for c in cells], [c['res'][a]['se'] for c in cells])
                be_out[a] = [x for x, _ in c_]
                p('    %-10s %s' % (a, cs(c_)))
            yo = [c['res']['OWNER']['mean'] - c['res']['FIXED']['mean'] for c in cells]
            ym = [c['res']['OWNER']['median'] - c['res']['FIXED']['median'] for c in cells]
            xo = cross(lams, yo); xm = cross(lams, ym)
            p('    OWNER mean beats FIXED mean below: %s;  OWNER median beats FIXED median below: %s' % (cs(xo, yo), cs(xm, ym)))
            # IID identity check and regime uplift
            dev = max(abs(c['res'][a]['ros'] - c['mu']) for c in cells for a in ('FIXED', 'OWNER', 'OWNER_LAG') if c['res'][a]['ros'] is not None)
            cbe = [c for c in cells if abs(c['lam'] - be) / be < 1e-9][0]
            up = {a: cbe['res'][a]['ros'] - cbe['res']['FIXED']['ros'] for a in ('OWNER', 'OWNER_LAG', 'OWNER_FF', 'FF1')}
            p('    max |return per unit staked - mu| over grid (FIXED, OWNER, OWNER_LAG; should be ~0 only in IID): %.4f' % dev)
            p('    at mu = 0: return per unit staked minus FIXED: ' + ', '.join('%s %+.4f' % (k, v) for k, v in up.items()))
            summ['main'].append(dict(world=world, J=J, be_fixed_analytic=be, breakeven=be_out, owner_mean_beats_fixed_below=[x for x, _ in xo],
                                     owner_median_beats_fixed_below=[x for x, _ in xm], ros_uplift_at_mu0=up, max_ros_dev=dev,
                                     at_mu0={a: cbe['res'][a] for a in schemes}))
    S_ = os.path.join(HERE, 'sweep_results.json')
    if os.path.exists(S_):
        S = json.load(open(S_)); R = S['results']; be = info['be_fixed']['100.0']; summ['sweep'] = []
        p(''); p('=' * 30, 'PERSISTENCE SWEEP (J=100, hot share 10%; L = mean hot run in trades; m = hot/cold rate ratio)', '=' * 30)
        p('  %-3s %-6s %-14s %-14s %-12s %-12s %-10s %-10s %-22s' % ('m', 'L', 'BE OWNER', 'BE OWNER_LAG', 'ret/stk O-F', 'ret/stk OL-F', 'hot% O', 'hot% OL', 'OWNER mean>FIXED below'))
        keys = sorted({(c['mult'], c['L']) for c in R})
        for mult, L in keys:
            cells = sorted([c for c in R if c['mult'] == mult and c['L'] == L], key=lambda c: c['lam'])
            lams = [c['lam'] for c in cells]
            bo = cross(lams, [c['res']['OWNER']['mean'] - S['start'] for c in cells], [c['res']['OWNER']['se'] for c in cells])
            bl = cross(lams, [c['res']['OWNER_LAG']['mean'] - S['start'] for c in cells], [c['res']['OWNER_LAG']['se'] for c in cells])
            bf = cross(lams, [c['res']['FIXED']['mean'] - S['start'] for c in cells])
            yo = [c['res']['OWNER']['mean'] - c['res']['FIXED']['mean'] for c in cells]; xo = cross(lams, yo)
            cbe = [c for c in cells if abs(c['lam'] - be) / be < 1e-9][0]['res']
            u1 = cbe['OWNER']['ros'] - cbe['FIXED']['ros']; u2 = cbe['OWNER_LAG']['ros'] - cbe['FIXED']['ros']
            p('  %-3d %-6.1f %-14s %-14s %+-12.4f %+-12.4f %-10.3f %-10.3f %-22s' % (mult, L, lamf(bo[0][0]) if bo else 'none', lamf(bl[0][0]) if bl else 'none', u1, u2,
              cbe['OWNER']['hot_stake_share'], cbe['OWNER_LAG']['hot_stake_share'], cs(xo, yo)))
            summ['sweep'].append(dict(mult=mult, L=L, be_owner=[x for x, _ in bo], be_owner_lag=[x for x, _ in bl], be_fixed_sim=[x for x, _ in bf],
                                      ros_uplift_owner=u1, ros_uplift_owner_lag=u2, hot_share_owner=cbe['OWNER']['hot_stake_share'],
                                      hot_share_owner_lag=cbe['OWNER_LAG']['hot_stake_share'], owner_mean_beats_fixed_below=[x for x, _ in xo],
                                      at_mu0={a: cbe[a] for a in cbe}))
        p('  FIXED break-even (analytic, every L and m): %s' % lamf(be))
    dc = os.path.join(HERE, 'data_check.json')
    if os.path.exists(dc):
        cl = json.load(open(dc))['cluster']; summ['data_cluster'] = cl
        p(''); p('=' * 30, 'DO 2x WINS CLUSTER IN THE REAL DATA? (pairs of 2x wins within 30 trades, permutation test)', '=' * 30)
        for k, v in cl.items():
            p('  %s: %d trades, %d 2x wins, pairs %d vs %.1f expected if random, one-sided p = %.2f' % (k, v['n'], v['wins2x'], v['pairs_within_30'], v['null_mean'], v['p_value']))
    pw = os.path.join(HERE, 'power_results.json')
    if os.path.exists(pw):
        pr = json.load(open(pw)); summ['power'] = pr
        p('  Power of that test to detect a regime (share of simulated sequences with p < 0.05):')
        for k, v in pr.items(): p('    %s: %.2f' % (k, v))
    tr = os.path.join(HERE, 'trial_results.json')
    if os.path.exists(tr):
        T_ = json.load(open(tr)); summ['trial'] = []
        p(''); p('=' * 30, "OWNER'S TRIAL SIZE: 1 unit = 10%% of start (start %g, ruin < %g), J=100" % (T_['start'], T_['ruin']), '=' * 30)
        for c in T_['results']:
            p('  %s lam %s mu %+.3f: ' % (c['world'], lamf(c['lam']), c['mu']) + '; '.join('%s median %.2f P(ruin) %.3f P(>start) %.3f' % (a, c['res'][a]['median'], c['res'][a]['p_ruin'], c['res'][a]['p_gain']) for a in ('FIXED', 'OWNER', 'OWNER_LAG')))
            summ['trial'].append(dict(world=c['world'], lam=c['lam'], mu=c['mu'], res={a: c['res'][a] for a in ('FIXED', 'OWNER', 'OWNER_LAG')}))
    open(os.path.join(HERE, 'report.txt'), 'w').write('\n'.join(OUT) + '\n')
    json.dump(summ, open(os.path.join(HERE, 'summary.json'), 'w'), indent=1)
    print('\n'.join(OUT))


if __name__ == '__main__':
    main()
