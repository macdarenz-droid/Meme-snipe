# Approximate the 8 truncated runner tokens dropped from mig+1m entries: enter at the first available candle close
# (about mig+2m, i.e. LATER than the rule), simulate the same exits, and recompute the mig+1m grid means.
import json, math, csv, numpy as np
exec(open('recompute.py').read().split('# rule simulation')[0].split("for h,s in")[0])  # reuse loaders/recs
q=2/SOL
def net(g,rin,rout):
    ii=q/(rin+q); io=q/(rout+q); return (q*(1-0.0175-ii)*g*(1-0.0175-io)-0.00026)/q-1
def sim(C,Dt,pe,stop,tp,tmax):
    last=pe
    for t,o,h,l,c,v in C[(C[:,0]>=Dt)&(C[:,0]<Dt+tmax)]:
        if stop is not None:
            sp=pe*(1+stop)
            if o<=sp: return o/pe
            if l<=sp: return min(sp,c)/pe
        if tp is not None and c>=pe*(1+tp): return 1+tp
        last=c
    return last/pe
soc=lambda r: bool(r['j'].get('twitter') or r['j'].get('website') or r['j'].get('telegram'))
def ttg(r):
    ca=r['j'].get('createdAt'); 
    return r['t0']-datetime.fromisoformat(ca.replace('Z','+00:00')).timestamp() if ca else None
filters={'none':lambda r:True,'socials':soc,'ttg>=5m':lambda r:(ttg(r) or 0)>=300,'ttg>=5m & socials':lambda r:(ttg(r) or 0)>=300 and soc(r)}
exits={'S-30/TP+50/60m':(-0.3,0.5,3600),'S-20/TP+100/240m':(-0.2,1.0,14400),'time-only 60m':(None,None,3600)}
G={(x['filter'],x['exit']):x for x in json.load(open(D+'/results/backfill_results.json'))['rule_grid'] if x['entry']=='mig+1m'}
for fn,f in filters.items():
    for en,(s,tp,tm) in exits.items():
        add=[]
        for r in recs:
            C=r['C']; Dt=math.ceil((r['t0']+60)/60)*60
            if last_close(C,Dt) is not None or not f(r): continue
            Dt2=C[0,0]+60; pe=C[0,4]; g=sim(C,Dt2,pe,s,tp,tm)
            add.append(net(g,r['R0']*math.sqrt(pe/r['pm']),r['R0']*math.sqrt(pe*g/r['pm'])))
        x=G[(fn,en)]; n0=x['n']; m0=x['mean_net']
        m1=(m0*n0+sum(add))/(n0+len(add)) if add else m0
        print(f'mig+1m {fn:18s} {en:17s} n {n0}+{len(add)} mean {100*m0:6.1f}% -> {100*m1:6.1f}%  added nets {[round(100*a) for a in add]}')
