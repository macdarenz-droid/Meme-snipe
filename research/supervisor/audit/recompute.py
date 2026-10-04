# Independent recomputation of empirical.md headline numbers (auditor's own code; numpy-based)
import json, glob, os, math, csv, numpy as np
from datetime import datetime
D='/tmp/claude-0/-home-user-Meme-snipe/bfe97b8d-9361-5e1a-a5d2-7a95e7d0e23b/scratchpad/research/empirical-data'
rng=np.random.default_rng(12345)
rows=[json.loads(l) for l in open(D+'/backfill/migrations.jsonl') if l.strip()]
first={}
for r in rows:
    if r.get('kind')!='migrate' or not r.get('mint') or not r.get('pool'): continue
    if r['mint'] not in first or r['blockTime']<first[r['mint']]['blockTime']: first[r['mint']]=r
meta=json.load(open(D+'/backfill/meta.json')); SOL=meta['solUsd']
def candles(pool):
    f=f'{D}/backfill/ohlcv_1m/{pool}.json'
    if not os.path.exists(f): return None
    resp=json.load(open(f))['resp']
    if not isinstance(resp,dict) or 'data' not in resp: return None
    agg={}
    for t,o,h,l,c,v in sorted(resp['data']['attributes']['ohlcv_list'],key=lambda x:x[0]):
        if t in agg: a=agg[t]; agg[t]=[t,a[1],max(a[2],h),min(a[3],l),c,a[5]+v]
        else: agg[t]=[t,o,h,l,c,v]
    return np.array(sorted(agg.values())) if agg else np.zeros((0,6))
std=[m for m in first.values() if m['sol']>=50]
print('unique mints',len(first),'standard',len(std),'dust',sum(m['sol']<5 for m in first.values()))
def last_close(C,t):
    k=C[:,0]+60<=t
    return C[k][-1,4] if k.any() else None
recs=[]; trunc_in=0; excl_phys=0; excl_spk=0
for m in std:
    C=candles(m['pool'])
    if C is None or len(C)==0: continue
    pm=m['migPriceSol']; R0=m['sol']; t0=m['blockTime']
    cum=np.cumsum(C[:,5]); phys=bool((C[:,2]>1.5*pm*((R0+cum)/R0)**2).any())
    j=meta['jup'].get(m['mint'],{})
    now=(j.get('usdPrice') or 0)/SOL or None
    spike=C[:,2].max()>50*pm and not (now and now>2*pm)
    if phys: excl_phys+=1
    if spike: excl_spk+=1
    if phys or spike: continue
    if len(C)>=300: trunc_in+=1
    recs.append(dict(m=m,C=C,pm=pm,R0=R0,t0=t0,now=now,j=j))
print('analysis n',len(recs),'phys',excl_phys,'spike',excl_spk,'truncated(300 candles) in set',trunc_in)
def ret(r,s):
    p=last_close(r['C'],r['t0']+s); return p/r['pm']-1 if p else 0.0
def bci(x,fn=np.mean,B=4000):
    x=np.asarray(x); idx=rng.integers(0,len(x),(B,len(x))); v=fn(x[idx],axis=1); return np.percentile(v,[2.5,97.5])
for h,s in [('5m',300),('15m',900),('1h',3600),('4h',14400)]:
    x=np.array([ret(r,s) for r in recs]); lo,hi=bci(x,np.median)
    print(h,'median %.1f%% [%.1f,%.1f] mean %.1f%% share<=-80 %.1f%%'%(100*np.median(x),100*lo,100*hi,100*x.mean(),100*(x<=-0.8).mean()))
xn=np.array([r['now']/r['pm']-1 for r in recs if r['now']])
print('now n',len(xn),'median %.1f%% share<=-80 %.1f%% share up %.1f%%'%(100*np.median(xn),100*(xn<=-0.8).mean(),100*(xn>0).mean()))
# +5m above migration price split
a=[];b=[]
for r in recs:
    Dt=math.ceil((r['t0']+300)/60)*60; pe=last_close(r['C'],Dt) or r['pm']; p1=last_close(r['C'],Dt+3600) or pe
    (a if pe>r['pm'] else b).append(p1/pe-1)
print('above-mig@5m n',len(a),len(b),'median 1h %.1f%% vs %.1f%%'%(100*np.median(a),100*np.median(b)))
# ttg
tt=[]
for m in std:
    j=meta['jup'].get(m['mint'],{})
    if j.get('createdAt'): tt.append(m['blockTime']-datetime.fromisoformat(j['createdAt'].replace('Z','+00:00')).timestamp())
tt=np.array(tt); print('ttg n',len(tt),'<5min %.1f%% <=5s %.1f%%'%(100*(tt<300).mean(),100*(tt<=5).mean()))
liq=[meta['jup'].get(m['mint'],{}).get('liquidity') for m in std]; liq=[x for x in liq if x]
print('liq mig median $%.0f now median $%.0f n %d'%(np.median([2*m['sol']*SOL for m in std]),np.median(liq),len(liq)))
# rule simulation (own implementation)
q=2/SOL
def net(g,rin,rout,fee=0.0125,slip=0.005,fixed=0.00026):
    ii=q/(rin+q); io=q/(rout+q)
    return (q*(1-fee-slip-ii)*g*(1-fee-slip-io)-fixed)/q-1
def run(X,flt,stop,tp,tmax,fee=0.0125,slip=0.005,fixed=0.00026):
    out=[]
    for r in recs:
        C=r['C']; Dt=math.ceil((r['t0']+X)/60)*60; pe=last_close(C,Dt)
        if pe is None or not flt(r): continue
        g=None; last=pe
        for t,o,h,l,c,v in C[(C[:,0]>=Dt)&(C[:,0]<Dt+tmax)]:
            if stop is not None:
                sp=pe*(1+stop)
                if o<=sp: g=o/pe; break
                if l<=sp: g=min(sp,c)/pe; break
            if tp is not None and c>=pe*(1+tp): g=1+tp; break
            last=c
        if g is None: g=last/pe
        out.append(net(g,r['R0']*math.sqrt(pe/r['pm']),r['R0']*math.sqrt(pe*g/r['pm']),fee,slip,fixed))
    return np.array(out)
soc=lambda r: bool(r['j'].get('twitter') or r['j'].get('website') or r['j'].get('telegram'))
for name,args in [('mig+15m socials time60',(900,soc,None,None,3600)),('mig+60m none S30/TP50/60',(3600,lambda r:True,-0.3,0.5,3600))]:
    x=run(*args); lo,hi=bci(x)
    print(name,'n',len(x),'mean %.1f%% [%.1f,%.1f] median %.1f%%'%(100*x.mean(),100*lo,100*hi,100*np.median(x)))
    # heavier-cost sensitivity: priority/Jito fee 0.001 SOL per side
    y=run(*args,fixed=0.002+0.00026); print('   with +0.001 SOL priority per side: mean %.1f%%'%(100*y.mean()))
    # trimmed: drop single best trade
    print('   drop top-1 trade mean %.1f%%; top trade %.0f%%'%(100*np.sort(x)[:-1].mean(),100*x.max()))
