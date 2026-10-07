"""Bet-sizing rules on the R1/R2 trade lists. Non-anticipating: a stake decided at entry_ts uses only trades with exit_ts <= entry_ts.
Usage: python3 -I sim.py <trades.json>
"""
import json, math, random, sys, statistics as st, bisect

D = json.load(open(sys.argv[1]))['trades']
FIXED = 414009 / 1e9
SOL_USD = 119.26
Q10 = 10 / SOL_USD

def net_at(net10, usd):
    """Approximate net return at a different size: swap the fixed-cost share only (price impact ~0.1% at these sizes, ignored)."""
    q = usd / SOL_USD
    x = net10 + FIXED / Q10 - FIXED / q
    return max(x, -1 - FIXED / q)

# ---------- rules: each returns stake multiplier b given closed history (list of nets in exit order) and state ----------
def ladder(closed, good, levels=((10, 1.0), (30, 0.5), (60, 0.25)), floor=0.125, boost=None, entries_since_big=None):
    L = 0
    for x in reversed(closed):
        if x >= good:
            break
        L += 1
    b = floor
    for lim, v in levels:
        if L < lim:
            b = v
            break
    if boost and entries_since_big is not None and entries_since_big < boost[1]:
        b = max(b, boost[0])
    return b

def run(trades, rule):
    """rule(closed_nets, ctx) -> b. Returns per-trade stakes."""
    ex = sorted(range(len(trades)), key=lambda i: (trades[i]['exit_ts'], trades[i]['entry_ts']))
    ex_ts = [trades[i]['exit_ts'] for i in ex]
    stakes = []
    ctx = {'n_entries': 0, 'last_big_entry_idx': None}
    for j, t in enumerate(trades):
        k = bisect.bisect_right(ex_ts, t['entry_ts'])
        closed_idx = ex[:k]
        closed = [trades[i]['net'] for i in closed_idx]
        b = rule(closed, j, closed_idx, trades)
        stakes.append(b)
    return stakes

def r_fixed(closed, j, ci, T):
    return 1.0

def mk_ladder(good, floor=0.125, boost=None):
    def r(closed, j, ci, T):
        esb = None
        if boost:
            # entries made since a >=10x trade became known (closed)
            bigs = [T[i]['exit_ts'] for i in ci if T[i]['net'] >= 9]
            if bigs:
                tb = max(bigs)
                esb = sum(1 for u in T[:j] if u['entry_ts'] >= tb)
        return ladder(closed, good, floor=floor, boost=boost, entries_since_big=esb)
    return r

def mk_ec(n, low):
    """Equity-curve filter on the fixed-stake shadow curve: full stake if realized cum P&L >= its mean over the last n closed points."""
    def r(closed, j, ci, T):
        if len(closed) < n:
            return 1.0
        cum, c = [], 0.0
        for x in closed:
            c += x
            cum.append(c)
        ma = sum(cum[-n:]) / n
        return 1.0 if cum[-1] >= ma else low
    return r

def mk_winrate_gate(n, thr, low):
    """Stake full if the hit rate (net>0) over the last n closed trades >= thr, else low."""
    def r(closed, j, ci, T):
        if len(closed) < n:
            return 1.0
        w = sum(1 for x in closed[-n:] if x > 0) / n
        return 1.0 if w >= thr else low
    return r

RULES = [
    ('fixed', r_fixed),
    ('owner ladder, reset on >=2x (net>=+1)', mk_ladder(1.0)),
    ('owner ladder, reset on >=10x only', mk_ladder(9.0)),
    ('owner ladder >=2x reset + 1.5x for 30 entries after a 10x', mk_ladder(1.0, boost=(1.5, 30))),
    ('equity-curve filter MA20, else 0.25', mk_ec(20, 0.25)),
    ('equity-curve filter MA20, else 0', mk_ec(20, 0.0)),
    ('equity-curve filter MA50, else 0', mk_ec(50, 0.0)),
    ('hit-rate gate last 50 >=5%, else 0.25', mk_winrate_gate(50, 0.05, 0.25)),
]

def maxdd(trades, stakes):
    ev = sorted(range(len(trades)), key=lambda i: trades[i]['exit_ts'])
    c = peak = dd = 0.0
    for i in ev:
        c += stakes[i] * trades[i]['net']
        peak = max(peak, c)
        dd = max(dd, peak - c)
    return dd

out = {}
for key in D:
    T = D[key]
    nets = [t['net'] for t in T]
    top = sorted(range(len(T)), key=lambda i: -nets[i])[:3]
    print(f'\n== {key}  n={len(T)} mean={st.mean(nets):+.4f}')
    print(f"{'rule':58s} {'stake':>7s} {'P&L':>8s} {'P&L/stake':>9s} {'ex-top1':>8s} {'maxDD':>7s} b@top1..3")
    res = {}
    for name, rule in RULES:
        s = run(T, rule)
        S = sum(s)
        pnl = sum(b * x for b, x in zip(s, nets))
        ex1 = pnl - s[top[0]] * nets[top[0]]
        res[name] = dict(stake=S, pnl=pnl, ros=pnl / S if S else float('nan'), ex_top1=ex1, maxdd=maxdd(T, s), b_top=[s[i] for i in top])
        print(f"{name:58s} {S:7.1f} {pnl:+8.2f} {pnl / S if S else float('nan'):+9.4f} {ex1:+8.2f} {res[name]['maxdd']:7.2f} {[round(s[i], 3) for i in top]}")
    out[key] = res

# ---------- Kelly: argmax mean log(1+fX), X = per-trade net ----------
def kelly(xs):
    lo = min(xs)
    fmax = 0.999 / (-lo) if lo < 0 else 1.0
    best, bf = 0.0, 0.0
    steps = 4000
    for i in range(1, steps):
        f = fmax * i / steps
        g = sum(math.log1p(f * x) for x in xs) / len(xs)
        if g > best:
            best, bf = g, f
    return bf, best

print('\n== Kelly fraction (growth-optimal fraction of bankroll per trade, sequential iid view)')
kel = {}
for key in D:
    xs = [t['net'] for t in D[key]]
    f, g = kelly(xs)
    xs2 = sorted(xs)[:-1]
    f2, g2 = kelly(xs2)
    kel[key] = (f, g, f2, g2)
    print(f'{key:24s} f*={f:.4f} growth/trade={g:+.5f} | without top trade: mean={st.mean(xs2):+.4f} f*={f2:.4f}')

# ---------- serial dependence checks ----------
print('\n== Serial dependence: P(win) after a win closed in last 48h vs otherwise (win = net>0)')
for key in ['exploration|R1|pess', 'validation|R1|pess', 'exploration|R1|opt', 'validation|R1|opt']:
    T = D[key]
    a = b = na = nb = 0
    for t in T:
        recent = any(u['net'] > 0 and t['entry_ts'] - 48 * 3600 <= u['exit_ts'] <= t['entry_ts'] for u in T)
        w = t['net'] > 0
        if recent:
            na += 1; a += w
        else:
            nb += 1; b += w
    # daily dispersion (entry day) vs permutation
    days = {}
    for t in T:
        days.setdefault(t['entry_ts'] // 86400, []).append(1 if t['net'] > 0 else 0)
    obs = sum((sum(v) - len(v) * sum(sum(v) for v in days.values()) / len(T)) ** 2 / len(v) for v in days.values())
    flat = [x for v in days.values() for x in v]
    rng = random.Random(7)
    ge = 0
    R = 2000
    sizes = [len(v) for v in days.values()]
    p = sum(flat) / len(flat)
    for _ in range(R):
        rng.shuffle(flat)
        k = 0; s = 0.0
        for n in sizes:
            v = flat[k:k + n]; k += n
            s += (sum(v) - n * p) ** 2 / n
        ge += s >= obs
    print(f'{key:24s} after-recent-win {a}/{na}={a / max(na, 1):.3f}  otherwise {b}/{nb}={b / max(nb, 1):.3f}  day-clustering perm p={ (ge + 1) / (R + 1):.3f}')

# ---------- bootstrap: does the ladder beat fixed when order is random (iid)? sequential, immediate feedback ----------
print('\n== iid bootstrap, sequential (no overlap), 500 trades/path, 4000 paths: P&L per unit staked, ladder vs fixed')
def seq_ladder(xs, good):
    L = 0; S = 0.0; P = 0.0
    for x in xs:
        b = 1.0 if L < 10 else 0.5 if L < 30 else 0.25 if L < 60 else 0.125
        S += b; P += b * x
        L = 0 if x >= good else L + 1
    return S, P
boot = {}
for key in ['exploration|R1|pess', 'validation|R1|pess']:
    xs = [t['net'] for t in D[key]]
    rng = random.Random(11)
    ros_l, ros_f, diff, agg_S, agg_P = [], [], [], [], []
    for _ in range(4000):
        path = [rng.choice(xs) for _ in range(500)]
        S, P = seq_ladder(path, 1.0)
        ros_l.append(P / S); ros_f.append(sum(path) / 500)
        diff.append(P / S - sum(path) / 500)
        agg_S.append(S); agg_P.append(P)
    boot[key] = (st.mean(ros_l), st.mean(ros_f), st.mean(diff), sum(agg_P) / sum(agg_S))
    print(f'   aggregate E[P]/E[S] ladder={sum(agg_P) / sum(agg_S):+.4f}  avg stake/trade={sum(agg_S) / (500 * 4000):.3f}')
    print(f'{key:24s} mean P&L/stake ladder={st.mean(ros_l):+.4f} fixed={st.mean(ros_f):+.4f} diff={st.mean(diff):+.4f} (true mean {st.mean(xs):+.4f})')

# ---------- $20 bankroll, sequential iid bootstrap with size-dependent fixed cost ----------
print('\n== $20 bankroll, 300 sequential trades, iid bootstrap, 4000 paths, fixed cost re-applied at each size')
def path_sim(xs, policy, rng, n=300, B0=20.0, min_usd=0.0):
    B = B0; peak = B0; mdd = 0.0; L = 0; busted = False
    for _ in range(n):
        usd = policy(B, L)
        if usd is None:
            busted = True; break
        usd = min(usd, B)
        if usd <= 0.01:
            busted = True; break
        x10 = rng.choice(xs)
        x = net_at(x10, usd)
        B += usd * x
        peak = max(peak, B); mdd = max(mdd, (peak - B) / peak)
        L = 0 if x10 >= 1.0 else L + 1
    return B, mdd, busted
pols = {
    'fixed $2': lambda B, L: 2.0,
    'ladder $2/$1/$0.5/$0.25': lambda B, L: 2.0 if L < 10 else 1.0 if L < 30 else 0.5 if L < 60 else 0.25,
    'ladder $2/$1/$0.5 floor $0.5': lambda B, L: 2.0 if L < 10 else 1.0 if L < 30 else 0.5,
    '10% of bankroll': lambda B, L: 0.10 * B,
    '10% of bankroll, pause below $1 stake': lambda B, L: 0.10 * B if 0.10 * B >= 1.0 else None,
    'floor $14 + cushion x0.35, min $1 else pause': lambda B, L: (0.35 * (B - 14) if 0.35 * (B - 14) >= 1.0 else None),
}
bank = {}
for key in ['exploration|R1|pess', 'validation|R1|pess']:
    xs = [t['net'] for t in D[key]]
    for pn, pol in pols.items():
        rng = random.Random(5)
        rs = [path_sim(xs, pol, rng) for _ in range(4000)]
        fin = sorted(r[0] for r in rs)
        bust = sum(r[2] for r in rs) / len(rs)
        half = sum(1 for r in rs if r[1] >= 0.5) / len(rs)
        bank[(key, pn)] = dict(median=fin[len(fin) // 2], mean=st.mean(fin), p_up=sum(1 for f in fin if f > 20) / len(fin), p_dd50=half, p_bust=bust)
        print(f"{key:22s} {pn:30s} median end ${fin[len(fin) // 2]:7.2f} mean ${st.mean(fin):8.2f} P(end>$20)={bank[(key, pn)]['p_up']:.3f} P(DD>=50%)={half:.3f} P(stopped/paused)={bust:.3f} P(end<$10)={sum(1 for f in fin if f < 10) / len(fin):.3f}")

print('\nFixed-cost share at size: ' + ', '.join(f'${u}: {FIXED / (u / SOL_USD) * 100:.1f}%' for u in (0.25, 0.5, 1, 2, 5, 10)))
json.dump({'rules': out, 'kelly': kel, 'boot': boot, 'bank': {f'{a}|{b}': v for (a, b), v in bank.items()}}, open(sys.argv[1].rsplit('/', 1)[0] + '/kelly_theory/results.json', 'w'), indent=1)
