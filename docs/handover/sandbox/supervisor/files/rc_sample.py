import json,time,urllib.request,datetime,collections,sys
def get(u):
    t=time.time()
    try:
        r=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'research'}),timeout=60)
        return r.status,json.loads(r.read()),time.time()-t,dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code,None,time.time()-t,dict(e.headers)
rows=[];risks=collections.Counter();lat=[]
for rnd in range(3):
    st,new,_,_=get('https://api.rugcheck.xyz/v1/stats/new_tokens')
    for tok in new[:6]:
        age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(tok['createAt'][:26]+'+00:00')).total_seconds()
        st,rep,dt,h=get(f"https://api.rugcheck.xyz/v1/tokens/{tok['mint']}/report")
        lat.append(dt)
        if rep:
            names=[r['name'] for r in rep.get('risks') or []]
            risks.update(names)
            rows.append(dict(mint=tok['mint'],age_s=round(age),http=st,lat=round(dt,2),supply=rep['token']['supply'],prog=rep['tokenProgram'][:6],score=rep.get('score'),norm=rep.get('score_normalised'),holders=rep.get('totalHolders'),liq=round(rep.get('totalMarketLiquidity') or 0),insiders=rep.get('graphInsidersDetected'),launch=(rep.get('launchpad') or {}).get('platform'),ncreator=len(rep.get('creatorTokens') or []),risks=names,rl=h.get('X-Rate-Limit-Remaining') or h.get('x-rate-limit-remaining')))
        else: rows.append(dict(mint=tok['mint'],http=st,lat=round(dt,2)))
        time.sleep(4.5)
    time.sleep(20)
for r in rows: print(r)
print(risks.most_common()); 
lat.sort(); print('lat p50',lat[len(lat)//2],'max',lat[-1],'n',len(lat))
json.dump(rows,open('rc_sample.json','w'))
