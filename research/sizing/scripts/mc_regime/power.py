#!/usr/bin/env python3
"""Could our data even detect a hot/cold regime? Power of the clustering test used on the real sequences
(count of 2x-win pairs within 30 trades, one-sided permutation p-value) under the regime model."""
import json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(5)
P2 = 15 / 934          # observed 2x-win rate (14 small winners >= 2x + 1 jackpot) in the pooled data
H = 0.10; W = 30; SIMS = 2000; PERMS = 4000


def stat(idx):
    idx = np.sort(idx)
    return int(sum(((idx[j + 1:] - idx[j]) <= W).sum() for j in range(len(idx))))


def null_table(n, kmax):
    tab = {}
    for k in range(kmax + 1):
        tab[k] = np.sort(np.array([stat(rng.choice(n, k, replace=False)) for _ in range(PERMS)])) if k >= 2 else None
    return tab


def regime_seq(n, mult, L):
    p_hc = 1 / L; p_ch = H * p_hc / (1 - H); c = 1 / (H * mult + 1 - H)
    s = rng.random() < H; out = np.empty(n, bool)
    for t in range(n):
        out[t] = rng.random() < P2 * (mult * c if s else c)
        u = rng.random(); s = (u >= p_hc) if s else (u < p_ch)
    return np.where(out)[0]


res = {}
for n in (492, 934, 3000):
    kmax = int(P2 * n * 3 + 15)
    tab = null_table(n, kmax)
    for mult, L in [(1, 1 / 0.9), (2, 30.0), (5, 10.0), (5, 30.0), (5, 100.0), (10, 30.0)]:
        rej = 0
        for _ in range(SIMS):
            w = regime_seq(n, mult, L); k = len(w)
            if k < 2 or k > kmax: continue
            s0 = stat(w); nt = tab[k]
            pv = (len(nt) - np.searchsorted(nt, s0, side='left')) / len(nt)
            rej += pv < 0.05
        res['n=%d m=%d L=%.1f' % (n, mult, L)] = rej / SIMS
        print('n=%d m=%d L=%.1f power %.3f' % (n, mult, L, rej / SIMS), flush=True)
json.dump(res, open(os.path.join(HERE, 'power_results.json'), 'w'), indent=1)
