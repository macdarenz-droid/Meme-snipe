import json, urllib.request, time, email.utils, sys
RPC="https://api.mainnet-beta.solana.com"
def rpc(m,p):
    r=urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers={"content-type":"application/json"})
    return json.load(urllib.request.urlopen(r,timeout=20))
out=[]
for e in range(1018,1049):
    end=None
    for back in range(0,40):
        s=(e+1)*432000-1-back
        j=rpc("getBlockTime",[s])
        if j.get("result"): end=j["result"]; break
        time.sleep(0.3)
    lm=None
    if e<1048:
        req=urllib.request.Request(f"https://files.old-faithful.net/{e}/epoch-{e}.car",method="HEAD",headers={"User-Agent":"zeroed-historical-scanner/2 (research backtest; +https://github.com/macdarenz-droid/Meme-snipe)"})
        try:
            h=urllib.request.urlopen(req,timeout=20)
            lm=email.utils.parsedate_to_datetime(h.headers["Last-Modified"]).timestamp()
        except Exception as ex:
            print("head",e,ex,file=sys.stderr)
            if "429" in str(ex): break
    out.append((e,end,lm))
    print(e,end,lm,flush=True)
    time.sleep(1.5)
json.dump(out,open("lag.json","w"))
