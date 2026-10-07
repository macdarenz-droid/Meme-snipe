import json, os, sys, statistics, datetime
sys.path.insert(0, '/home/user/Meme-snipe/research/runner-probe'); sys.path.insert(0, '/home/user/Meme-snipe/research/lottery-probe')
import runner, lottery
S='/tmp/claude-0/-home-user-Meme-snipe/b87ffbbf-f1e1-5a15-b7d3-6a3e38afe9c2/scratchpad'; H=S+'/lottery/hourly'
cs, counts = runner.coins('/home/user/Meme-snipe/research/lottery-probe/sample.json', H)
for x in cs:
    raw = {int(r[0]): r for r in json.load(open(os.path.join(H, x['u']['pool'] + '.json')))}
    x['hi'] = [float(raw[t][2]) if t in raw else x['c'][i] for i, t in enumerate(x['ts'])]
VOL = runner.VOL_OK; MAXH = runner.MAX_HOLD
def sim(x, mode, stop=0.3, arm=2.0, trail=0.6, half_at=None, sleepy=None, leash=False):
    c, v, lo, hi = x['c'], x['v'], x['lo'], x['hi']
    e=1; p0=c[e]
    if e+MAXH > len(c)-1: return None
    peak=p0; armed=False; left=1.0; got=0.0; half_done=False
    for i in range(e+1, e+MAXH+1):
        if left==1.0 and not half_done and lo[i] <= p0*(1-stop) and not armed:
            lvl=p0*(1-stop); return p0, (lvl if mode=='opt' else min(lvl, c[i]))
        if sleepy and i == e+sleepy[0] and c[i] < sleepy[1]*p0 and not armed:
            return p0, c[i]
        if half_at and not half_done and v[i] >= VOL and ((hi[i] if mode=='opt' else c[i]) >= half_at*p0):
            got += 0.5*half_at*p0; left=0.5; half_done=True
        if c[i] > peak and v[i] > 0: peak=c[i]
        if not armed and peak >= arm*p0: armed=True
        tr = trail
        if leash:
            m = peak/p0
            tr = 0.6 if m < 10 else (0.4 if m < 50 else 0.3)
        if armed and c[i] <= peak*(1-tr):
            lvl=peak*(1-tr); fill = lvl if (mode=='opt' and v[i] >= VOL) else c[i]
            return p0, got + left*fill
    return p0, got + left*c[e+MAXH]
sol = {int(r['t'])//1000//86400*86400 + 0: float(r['c']) for r in json.load(open(S+'/maze/hl/candles_1d_SOL.json'))}
def sol_up(t):
    d = t - t % 86400
    a, b = sol.get(d - 86400), sol.get(d - 2*86400)
    return (a is not None and b is not None and a > b)
def report(name, pick=lambda x: True, **kw):
    for mode in ('pess', 'opt'):
        vals=[]
        for x in cs:
            if not pick(x): continue
            r = sim(x, mode, **kw)
            if r: vals.append(lottery.net(r[0], max(r[1],1e-18), runner.SIZES['$10'])[0])
        st = runner.stats(vals)
        print(f"{name:38s} {mode:4s} n={st['n']:4d} win {st['win']*100:4.1f}% mean {st['mean']*100:+6.1f}% woBest {st['mean_wo_best']*100:+6.1f}% capped20x {statistics.fmean(min(v,19) for v in vals)*100:+6.1f}% >=10x {st['n_ge_10x']}")
report('BASE R2 (stop30, arm2, trail60)')
report('IDEA10 free ride: half at 2x', half_at=2.0)
report('IDEA11 sleepy: sell if <1.2x at 6h', sleepy=(6, 1.2))
report('IDEA12 tighter leash as it grows', leash=True)
report('IDEA10+11+12 combined', half_at=2.0, sleepy=(6,1.2), leash=True)
report('IDEA13 only when SOL rose last day', pick=lambda x: sol_up(x['ts'][1]))
report('IDEA13 opposite: SOL fell last day', pick=lambda x: not sol_up(x['ts'][1]))
for lo_h, hi_h in ((0,8),(8,16),(16,24)):
    report(f'IDEA14 entry hour UTC {lo_h:02d}-{hi_h:02d}', pick=lambda x, a=lo_h, b=hi_h: a <= datetime.datetime.fromtimestamp(x['ts'][1], datetime.UTC).hour < b)
