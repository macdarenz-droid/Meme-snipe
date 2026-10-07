#!/usr/bin/env python3
"""Monte Carlo of sizing schemes on a trade-outcome model built from R1 pess trades (exploration + validation).

Model per trade: jackpot (net = J) with rate lam, small winner resampled from the data winners (0 <= net < 20),
otherwise a loss resampled from the data losers (net < 0). Each data trade carries its information delay
(number of later entries before it closed), so a lagged version of the owner loop can be tested.
Worlds: IID, or a 2-state Markov REGIME world (hot share h, mean hot length L trades, winner and jackpot rates
m times higher in hot than in cold), with the same overall rates as IID.
Schemes: FIXED 1 unit, OWNER tiers (fixed units), OWNER_LAG (same, but only closed trades count, real delays),
OWNER_FF (owner tiers x 1% of equity), FF1 (1% of equity), KELLY_HALF / KELLY_FULL (fraction from the model).
Bankroll 100 units, 1 unit = 1% of start; ruin = equity < 10 units (absorbing: trading stops).
Usage: python3 -I mc_sizing.py main|sweep|data   (outputs next to this file)
"""
import json, os, sys, time
import numpy as np
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'trades.json')
N, T = 10000, 1000
START, RUIN, MIN_BET = 100.0, 10.0, 0.05
JACK_MIN = 20.0            # data trades with net >= 20 (one coin, net 129.75) are replaced by the jackpot process
WIN2, WIN10 = 1.0, 9.0     # "2x win" = proceeds >= 2x (net >= 1); "10x win" = proceeds >= 10x (net >= 9)
JACK_DELAY = 31            # delay (later entries before close) of the only observed jackpot coin
LAMS = [1/2000, 1/1500, 1/1200, 1/1000, 1/800, 1/700, 1/600, 1/500, 1/400, 1/300, 1/250, 1/200, 1/150, 1/120, 1/100]
JS = [30.0, 100.0, 300.0]
SERIES = ('exploration|R1|pess', 'validation|R1|pess')


def load():
    d = json.load(open(DATA))['trades']
    nets, dls, src = [], [], []
    for k in SERIES:
        rows = d[k]
        en = np.array([r['entry_ts'] for r in rows]); ex = np.array([r['exit_ts'] for r in rows])
        assert (np.diff(en) >= 0).all()
        n = np.array([r['net'] for r in rows])
        dl = np.searchsorted(en, ex, side='left') - np.arange(len(rows)) - 1   # later entries with entry < exit
        nets.append(n); dls.append(np.maximum(dl, 0)); src += [k] * len(rows)
    n = np.concatenate(nets); dl = np.concatenate(dls)
    L = n < 0; W = (n >= 0) & (n < JACK_MIN)
    return dict(Lv=n[L], Ld=dl[L], Wv=n[W], Wd=dl[W], pw=W.sum() / len(n), ntot=len(n), njack=int((n >= JACK_MIN).sum()),
                jack_vals=n[n >= JACK_MIN].tolist())


def mu_of(m, lam, J):
    return lam * J + m['pw'] * m['Wv'].mean() + (1 - m['pw'] - lam) * m['Lv'].mean()


def be_fixed(m, J):
    base = m['pw'] * m['Wv'].mean() + (1 - m['pw']) * m['Lv'].mean()
    return -base / (J - m['Lv'].mean())


def kelly(m, lam, J):
    xs = np.concatenate([m['Lv'], m['Wv'], [J]])
    ps = np.concatenate([np.full(len(m['Lv']), (1 - m['pw'] - lam) / len(m['Lv'])), np.full(len(m['Wv']), m['pw'] / len(m['Wv'])), [lam]])
    mu = float(ps @ xs)
    if mu <= 0:
        return 0.0
    g = lambda f: float((ps * xs / (1 + f * xs)).sum())
    lo, hi = 0.0, 0.999 / (-xs.min())
    if g(hi) > 0:
        return hi
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if g(mid) > 0 else (lo, mid)
    return 0.5 * (lo + hi)


def base_draws(m, h, L, mult, seed):
    """Random streams shared by every lam and J in one world (common random numbers)."""
    rng = np.random.default_rng(seed)
    if mult == 1:
        S = np.zeros((N, T), bool)
    else:
        p_hc = 1.0 / L; p_ch = h * p_hc / (1 - h)
        assert p_ch <= 1 and p_hc <= 1
        S = np.empty((N, T), bool); s = rng.random(N) < h
        for t in range(T):
            S[:, t] = s
            u = rng.random(N)
            s = np.where(s, u >= p_hc, u < p_ch)
    U = rng.random((N, T))
    iL = rng.integers(0, len(m['Lv']), (N, T)); iW = rng.integers(0, len(m['Wv']), (N, T))
    return S, U, iL, iW


def outcomes(m, base, h, mult, lam, J):
    S, U, iL, iW = base
    c = 1.0 / (h * mult + 1 - h) if mult != 1 else 1.0
    lam_t = np.where(S, lam * mult * c, lam * c); pw_t = np.where(S, m['pw'] * mult * c, m['pw'] * c)
    assert (lam_t + pw_t).max() < 1
    jack = U < lam_t; win = U > 1 - pw_t
    X = np.where(jack, J, np.where(win, m['Wv'][iW], m['Lv'][iL]))
    D = np.where(jack, JACK_DELAY, np.where(win, m['Wd'][iW], m['Ld'][iL])).astype(np.int64)
    return X, D, jack


def owner_units(X, D, lag):
    """Owner tiers. Outcome of trade i is known from entry i+1 (+ its delay when lag=True)."""
    n, t_ = X.shape
    K = np.arange(t_)[None, :] + 1 + (D if lag else np.zeros_like(D))
    if lag:
        order = np.argsort(K, axis=1, kind='stable')
        Ks = np.take_along_axis(K, order, 1); Xs = np.take_along_axis(X, order, 1)
    else:
        Ks, Xs = K, X
    s = np.zeros((n, t_ + 1), np.int32); cur = np.zeros(n, np.int32)
    for k in range(t_):
        cur = np.where(Xs[:, k] >= WIN2, 0, cur + 1); s[:, k + 1] = cur
    flat = (np.minimum(Ks, t_ + 1) + np.arange(n)[:, None] * (t_ + 2)).ravel()
    cnt = np.cumsum(np.bincount(flat, minlength=n * (t_ + 2)).reshape(n, t_ + 2), axis=1)[:, :t_]
    st = np.take_along_axis(s, cnt, 1)
    tier = np.select([st < 10, st < 30, st < 60], [1.0, 0.5, 0.25], 0.125)
    r, c = np.nonzero(X >= WIN10); kk = K[r, c]; ok = kk < t_
    Dm = np.zeros(n * (t_ + 21), np.int64)
    np.add.at(Dm, r[ok] * (t_ + 21) + kk[ok], 1); np.add.at(Dm, r[ok] * (t_ + 21) + kk[ok] + 20, -1)
    boost = np.cumsum(Dm.reshape(n, t_ + 21), axis=1)[:, :t_] > 0
    return np.where(boost, 1.5, tier)


def simulate(X, jack, S, J, units, fracs, owner_ff=None):
    """units: {name: N x T array of unit bets}; fracs: {name: fraction of equity}; owner_ff: N x T tier multipliers x 1% equity."""
    names = list(units) + list(fracs) + (['OWNER_FF'] if owner_ff is not None else [])
    k = len(names); nu = len(units)
    E = np.full((k, N), START); peak = E.copy(); mdd = np.zeros((k, N)); alive = np.ones((k, N), bool)
    staked = np.zeros((k, N)); jcap = np.zeros((k, N)); hot = np.zeros((k, N)); ruined = np.zeros((k, N), bool)
    fr = np.array(list(fracs.values()))[:, None] if fracs else None
    U = np.stack([units[a] for a in units]) if units else None
    for t in range(T):
        parts = []
        if nu: parts.append(U[:, :, t])
        if fracs: parts.append(fr * E[nu:nu + len(fracs)])
        if owner_ff is not None: parts.append(owner_ff[None, :, t] * 0.01 * E[-1:])
        want = np.concatenate(parts, 0)
        bet = np.where(alive & (want >= MIN_BET), np.minimum(want, E), 0.0)
        x = X[:, t]
        E = np.maximum(E + bet * x, 0.0)
        staked += bet; jcap += bet * jack[:, t]; hot += bet * S[:, t]
        peak = np.maximum(peak, E); mdd = np.maximum(mdd, (peak - E) / peak)
        nr = alive & (E < RUIN); ruined |= nr; alive &= ~nr
    out = {}
    jf = jcap[names.index('FIXED')].sum() if 'FIXED' in names else np.nan
    for i, a in enumerate(names):
        st = staked[i].sum()
        out[a] = dict(mean=float(E[i].mean()), se=float(E[i].std() / np.sqrt(N)), median=float(np.median(E[i])),
                      p_ruin=float(ruined[i].mean()), p_gain=float((E[i] > START).mean()), mdd=float(mdd[i].mean()),
                      stake=float(staked[i].mean()), ros=float((E[i] - START).sum() / st) if st > 0 else None,
                      jack_capture=float(jcap[i].sum() * J / (jf * J)) if jf > 0 else None,
                      hot_stake_share=float(hot[i].sum() / st) if st > 0 else None)
    return out


def run_world(args):
    m, wname, h, L, mult, seed, js, schemes = args
    base = base_draws(m, h, L, mult, seed)
    res = []
    for J in js:
        for lam in sorted(LAMS + [be_fixed(m, J)]):   # grid plus the exact FIXED break-even (mu = 0)
            X, D, jack = outcomes(m, base, h, mult, lam, J)
            units = {'FIXED': np.ones((N, T))}
            ow = owner_units(X, D, lag=False); units['OWNER'] = ow
            units['OWNER_LAG'] = owner_units(X, D, lag=True)
            fracs, off = {}, None
            if schemes == 'all':
                fk = kelly(m, lam, J)
                fracs = {'FF1': 0.01, 'KELLY_HALF': 0.5 * fk, 'KELLY_FULL': fk}
                off = ow
            r = simulate(X, jack, base[0], J, units, fracs, off)
            res.append(dict(world=wname, h=h, L=L, mult=mult, J=J, lam=lam, mu=mu_of(m, lam, J),
                            kelly_f=kelly(m, lam, J), jack_per_path=float(jack.sum() / N), res=r))
            print(wname, J, round(1 / lam), 'mu %+.4f' % mu_of(m, lam, J),
                  ' '.join('%s %.1f' % (a, r[a]['mean']) for a in r), flush=True)
    return res


def crossings(lams, y):
    """lam values where y changes sign (linear interpolation)."""
    out = []
    for i in range(len(lams) - 1):
        if y[i] == 0: out.append(lams[i])
        elif y[i] * y[i + 1] < 0:
            out.append(lams[i] + (lams[i + 1] - lams[i]) * (-y[i]) / (y[i + 1] - y[i]))
    return out


def fmt_lam(x):
    return '1/%d' % round(1 / x) if x else '-'


def data_check(m):
    """Do 2x wins cluster in the real sequences? Permutation test (entry order)."""
    d = json.load(open(DATA))['trades']; rng = np.random.default_rng(7); out = {}
    for k in SERIES:
        n = np.array([r['net'] for r in d[k]]); w = np.where(n >= WIN2)[0]
        def stat(idx):
            idx = np.sort(idx); return int(sum(((idx[j + 1:] - idx[j]) <= 30).sum() for j in range(len(idx))))
        s0 = stat(w); null = np.array([stat(rng.choice(len(n), len(w), replace=False)) for _ in range(20000)])
        out[k] = dict(n=len(n), wins2x=len(w), pairs_within_30=s0, null_mean=float(null.mean()), p_value=float((null >= s0).mean()))
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'main'
    m = load()
    info = dict(ntot=m['ntot'], nloss=len(m['Lv']), nwin=len(m['Wv']), pw=m['pw'], loss_mean=float(m['Lv'].mean()),
                win_mean=float(m['Wv'].mean()), win_ge2x=int((m['Wv'] >= WIN2).sum()), win_ge10x=int((m['Wv'] >= WIN10).sum()),
                jack_removed=m['jack_vals'], base_ev_no_jack=float(m['pw'] * m['Wv'].mean() + (1 - m['pw']) * m['Lv'].mean()),
                loss_delay_median=float(np.median(m['Ld'])), win_delay_median=float(np.median(m['Wd'])),
                be_fixed={str(J): be_fixed(m, J) for J in JS})
    t0 = time.time()
    if mode == 'data':
        print(json.dumps(dict(info=info, cluster=data_check(m)), indent=1)); return
    if mode == 'main':
        tasks = [(m, 'IID', 0.1, 1.0, 1, 11, [J], 'all') for J in JS] + [(m, 'REGIME', 0.1, 30.0, 5, 12, [J], 'all') for J in JS]
        fn = os.path.join(HERE, 'main_results.json')
    else:
        tasks = [(m, 'SWEEP', 0.1, L, mult, 100 + 10 * i + j, [100.0], 'owner')
                 for i, mult in enumerate([2, 5, 10]) for j, L in enumerate([1 / 0.9, 3.0, 10.0, 30.0, 100.0, 300.0])]
        fn = os.path.join(HERE, 'sweep_results.json')
    with Pool(3) as p:
        res = [r for chunk in p.map(run_world, tasks) for r in chunk]
    json.dump(dict(info=info, N=N, T=T, start=START, ruin=RUIN, lams=LAMS, results=res, secs=time.time() - t0), open(fn, 'w'))
    print('saved', fn, 'secs', round(time.time() - t0))


if __name__ == '__main__':
    main()
