"""Editor check: sim2-style real-order bankroll run (B0 $5000, closed-trade info only, realized equity)
(a) exploration R1 pess with the audited real-time jackpot exit (net 25.65, exit 1787279323)
(b) trailing floor WITH an open-exposure cap (sum open stakes <= W - 0.8*M), normal and 100%-gap stress
(c) owner tiers applied to 0.2% of realized equity (delayed, real order).
Usage: python3 -I ed_sim.py <trades.json>"""
import json, sys, copy
D = json.load(open(sys.argv[1]))['trades']
FIXED = 414009 / 1e9; SOL_USD = 119.26; Q10 = 10 / SOL_USD
def net_at(net10, usd):
    q = usd / SOL_USD
    return max(net10 + FIXED / Q10 - FIXED / q, -1 - FIXED / q)
def tier(L): return 1.0 if L < 10 else 0.5 if L < 30 else 0.25 if L < 60 else 0.125
def simulate(T, policy, B0=5000.0):
    ev = sorted([(t['entry_ts'], 1, i) for i, t in enumerate(T)] + [(t['exit_ts'], 0, i) for i, t in enumerate(T)])
    cash = B0; op = {}; W = B0; M = B0; mdd = 0.0; L = 0; stakes = [0.0]*len(T); sk = 0; minratio = 1.0
    for ts, kind, i in ev:
        if kind == 0:
            if i not in op: continue
            s = op.pop(i); x = net_at(T[i]['net'], s); cash += s*(1+x); W += s*x
            M = max(M, W); mdd = max(mdd, (M-W)/M); minratio = min(minratio, W/M)
            L = 0 if T[i]['net'] >= 1.0 else L+1
        else:
            s = policy(W, M, L, sum(op.values()))
            if s is None or s < 0.5 or s > cash: sk += 1; continue
            cash -= s; op[i] = s; stakes[i] = s
    return W, mdd, stakes, sk, minratio
P = {
 'fixed $10': lambda W,M,L,o: 10.0,
 'owner ladder $10/$5/$2.5/$1.25': lambda W,M,L,o: 10.0*tier(L),
 'owner tiers x 0.2% of equity': lambda W,M,L,o: 0.002*W*tier(L),
 'floor 80%, 1% surplus (no cap)': lambda W,M,L,o: 0.01*(W-0.8*M),
 'floor 80%, 1% surplus, open<=surplus': lambda W,M,L,o: min(0.01*(W-0.8*M), (W-0.8*M)-o),
}
def run(label, T):
    j = max(range(len(T)), key=lambda i: T[i]['net'])
    print(f'\n== {label}')
    for pn, pol in P.items():
        W, mdd, st, sk, mr = simulate(T, pol)
        n = sum(1 for s in st if s > 0)
        print(f'{pn:40s} perStaked {(W-5000)/max(1e-9,sum(st)):+.3f} minR {mr:.5f} end ${W:8.1f} maxDD {mdd*100:5.1f}% stake@top ${st[j]:6.2f} avg ${sum(st)/max(1,n):5.2f} skipped {sk:3d} min W/peak {mr:.3f}')
for k in ('exploration|R1|pess', 'validation|R1|pess'):
    run(k, D[k])
T = copy.deepcopy(D['exploration|R1|pess'])
T[454]['net'] = 25.65; T[454]['exit_ts'] = 1787279323
run('exploration|R1|pess, real-time jackpot exit (26.65x)', T)
for k in ('exploration|R1|pess', 'validation|R1|pess'):
    G = copy.deepcopy(D[k])
    for t in G:
        if t['net'] < 0: t['net'] = -1.0
    run(k + ' STRESS: every loss = -100% (gap)', G)
