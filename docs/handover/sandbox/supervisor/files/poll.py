import json,time,urllib.request,urllib.error,collections
seen={}
res=[]
def get(u):
    for i in range(4):
        try:
            s=time.time()
            r=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=30)
            b=r.read(); return json.loads(b),time.time()-s,dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code==429:
                time.sleep(10*(i+1)); continue
            return None,0,{'err':e.code}
        except Exception as e:
            return None,0,{'err':str(e)}
    return None,0,{'err':'429x4'}
t0=time.time()
while time.time()-t0<420 and len(res)<30:
    lst,_,_=get('https://api.rugcheck.xyz/v1/stats/new_tokens')
    time.sleep(2)
    for t in lst or []:
        m=t['mint']
        if m in seen: continue
        seen[m]=t
        j,dt,h=get(f'https://api.rugcheck.xyz/v1/tokens/{m}/report')
        time.sleep(2)
        if not j: continue
        age=time.time()-time.mktime(time.strptime(t['createAt'][:19],'%Y-%m-%dT%H:%M:%S'))+time.timezone*-1 if False else None
        tk=j.get('token') or {}
        res.append(dict(mint=m,dt=round(dt,2),pad=(j.get('launchpad') or {}).get('platform'),supply=tk.get('supply'),dec=tk.get('decimals'),ma=tk.get('mintAuthority'),fa=tk.get('freezeAuthority'),mut=(j.get('tokenMeta') or {}).get('mutable'),prog=j.get('tokenProgram'),risks=[r['name'] for r in j.get('risks') or []],rs=[r['score'] for r in j.get('risks') or []],score=j.get('score'),sn=j.get('score_normalised'),ins=j.get('graphInsidersDetected'),top=[(h['owner'],round(h['pct'],2)) for h in (j.get('topHolders') or [])[:2]]))
    json.dump(res,open('poll_out.json','w'))
    time.sleep(15)
json.dump(res,open('poll_out.json','w'))
print('done',len(res))
