import json, urllib.request, time, re, datetime
ends={e:end for e,end,_ in json.load(open("lag.json"))}
rows=[]
for e in range(1018,1048):
    req=urllib.request.Request(f"https://files.old-faithful.net/{e}/tx-metadata-check.log",headers={"User-Agent":"zeroed-historical-scanner/2 (research backtest; +https://github.com/macdarenz-droid/Meme-snipe)"})
    try:
        t=urllib.request.urlopen(req,timeout=30).read().decode(errors="replace")
    except Exception as ex:
        print(e,"ERR",ex,flush=True)
        if "429" in str(ex): break
        time.sleep(1.5); continue
    m=[x for x in re.findall(r"^I(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})",t,re.M)]
    if not m: print(e,"no stamp",flush=True); time.sleep(1.5); continue
    mo,d,H,M,S=map(int,m[-1])
    ts=datetime.datetime(2026,mo,d,H,M,S,tzinfo=datetime.timezone.utc).timestamp()
    lag=(ts-ends[e])/86400
    rows.append((e,ends[e],ts,lag))
    print(e,datetime.datetime.utcfromtimestamp(ends[e]).isoformat(),datetime.datetime.utcfromtimestamp(ts).isoformat(),round(lag,2),flush=True)
    time.sleep(1.5)
json.dump(rows,open("lag2.json","w"))
lags=sorted(r[3] for r in rows)
n=len(lags)
print("n",n,"median",round(lags[n//2],2),"max",round(max(lags),2),"min",round(min(lags),2),">1d",sum(l>1 for l in lags),">2d",sum(l>2 for l in lags),">3d",sum(l>3 for l in lags))
