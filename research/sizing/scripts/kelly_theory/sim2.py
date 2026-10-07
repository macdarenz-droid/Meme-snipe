"""Real chronological order, overlapping positions, bankroll-based sizing with realized equity only (no look-ahead).
Also: shots-budget arithmetic for rare big winners.
Usage: python3 -I sim2.py <trades.json>
"""
import json, math, sys, statistics as st

D = json.load(open(sys.argv[1]))['trades']
FIXED = 414009 / 1e9
SOL_USD = 119.26
Q10 = 10 / SOL_USD

def net_at(net10, usd):
    q = usd / SOL_USD
    return max(net10 + FIXED / Q10 - FIXED / q, -1 - FIXED / q)

def simulate(T, policy, B0=5000.0):
    """Events in time order; exits at a timestamp are processed before entries at the same timestamp.
    Realized equity W = cash + stakes of open positions at cost. Stake <= free cash."""
    ev = []
    for i, t in enumerate(T):
        ev.append((t['entry_ts'], 1, i))
        ev.append((t['exit_ts'], 0, i))
    ev.sort()
    cash = B0; open_stake = {}; W = B0; M = B0; peak = B0; mdd = 0.0
    streak = 0; stakes = [0.0] * len(T); skipped = 0; last_big_exit = None; entries_since_big = 10 ** 9
    for ts, kind, i in ev:
        if kind == 0:
            if i not in open_stake:
                continue
            s = open_stake.pop(i)
            x = net_at(T[i]['net'], s)
            cash += s * (1 + x)
            W += s * x
            M = max(M, W); peak = max(peak, W); mdd = max(mdd, (peak - W) / peak)
            streak = 0 if T[i]['net'] >= 1.0 else streak + 1
            if T[i]['net'] >= 9.0:
                entries_since_big = 0
        else:
            s = policy(W, M, streak, entries_since_big)
            entries_since_big += 1
            if s is None or s < 0.5 or s > cash:
                skipped += 1
                continue
            cash -= s; open_stake[i] = s; stakes[i] = s
    return W, mdd, stakes, skipped

P = {
    'fixed $10': lambda W, M, L, e: 10.0,
    '0.2% of realized equity': lambda W, M, L, e: 0.002 * W,
    'owner ladder $10/$5/$2.5/$1.25 (reset on >=2x)': lambda W, M, L, e: 10.0 if L < 10 else 5.0 if L < 30 else 2.5 if L < 60 else 1.25,
    'trailing floor 80% of peak, stake=1% of surplus': lambda W, M, L, e: 0.01 * (W - 0.8 * M),
    'trailing floor 80%, 1% surplus, min $5 else pause': lambda W, M, L, e: (0.01 * (W - 0.8 * M) if 0.01 * (W - 0.8 * M) >= 5 else None),
    'ladder + 1.5x for 30 entries after a 10x': lambda W, M, L, e: max(10.0 if L < 10 else 5.0 if L < 30 else 2.5 if L < 60 else 1.25, 15.0 if e < 30 else 0),
}
res = {}
for key in D:
    T = D[key]
    nets = [t['net'] for t in T]
    j = max(range(len(T)), key=lambda i: nets[i])
    print(f'\n== {key} (B0 $5000, real order, overlap, realized equity only)')
    for pn, pol in P.items():
        W, mdd, stakes, sk = simulate(T, pol)
        res[f'{key}|{pn}'] = dict(end=W, maxdd=mdd, stake_at_top=stakes[j], skipped=sk, avg_stake=sum(stakes) / max(1, sum(1 for s in stakes if s > 0)))
        print(f'{pn:52s} end ${W:8.1f}  maxDD {mdd * 100:5.1f}%  stake at best trade ${stakes[j]:6.2f}  avg stake ${res[f"{key}|{pn}"]["avg_stake"]:5.2f}  skipped {sk}')

# ---------- shots budget ----------
def cp(k, n, a=0.05):
    def cdf(p, k):  # P(X<=k)
        return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))
    def solve(f, lo, hi):
        for _ in range(200):
            mid = (lo + hi) / 2
            if f(mid) > 0: lo = mid
            else: hi = mid
        return (lo + hi) / 2
    lo = 0.0 if k == 0 else solve(lambda p: 1 - cdf(p, k - 1) - a / 2 < 0 and 1 or -1, 0, 1)
    hi = solve(lambda p: cdf(p, k) - a / 2 > 0 and 1 or -1, 0, 1)
    return lo, hi
print('\n== Shots budget (pess lines, both samples pooled: 934 trades)')
pool = [t['net'] for k in ('exploration|R1|pess', 'validation|R1|pess') for t in D[k]]
for thr, lab in ((1.0, '>=2x proceeds'), (9.0, '>=10x proceeds')):
    k = sum(1 for x in pool if x >= thr); n = len(pool)
    p = k / n; lo, hi = cp(k, n)
    L = -st.mean([x for x in pool if x < thr])
    def N50(pp): return math.log(0.5) / math.log(1 - pp)
    print(f'{lab}: {k}/{n} = {p:.4f} (95% CI {lo:.4f}-{hi:.4f}); trades for 50% chance of >=1: {N50(p):.0f} (CI {N50(hi):.0f}-{N50(lo):.0f}); mean loss of the other trades {L:.3f} of stake')
    for B, s in ((20, 2), (20, 5), (100, 2), (500, 5)):
        shots = B / (s * L)
        print(f'   bankroll ${B}, stake ${s}: ~{shots:.0f} losing shots affordable -> P(>=1 hit) ~ {1 - (1 - p) ** shots:.2f} (CI {1 - (1 - lo) ** shots:.2f}-{1 - (1 - hi) ** shots:.2f})')
json.dump(res, open(sys.argv[1].rsplit('/', 1)[0] + '/kelly_theory/results2.json', 'w'), indent=1)
