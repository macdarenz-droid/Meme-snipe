import json,urllib.request,time,sys,statistics as st
RPC="https://api.mainnet-beta.solana.com"
def call(m,p):
    for i in range(5):
        try:
            r=urllib.request.urlopen(urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers={"content-type":"application/json"}),timeout=30)
            j=json.load(r)
            if 'error' in j: raise Exception(j['error'])
            return j['result']
        except Exception as e:
            time.sleep(1.5*(i+1))
    return None
JITO=set("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5 HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49 DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL 3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT".split())
prog=sys.argv[1]; N=int(sys.argv[2])
sigs=call("getSignaturesForAddress",[prog,{"limit":N}])
rows=[]
for s in sigs:
    t=call("getTransaction",[s['signature'],{"encoding":"jsonParsed","maxSupportedTransactionVersion":1,"commitment":"confirmed"}])
    if not t: continue
    m=t['meta']; tx=t['transaction']; nsig=len(tx['signatures'])
    prio=m['fee']-5000*nsig
    cu=m.get('computeUnitsConsumed')
    tip=0; other_tip=0
    for ix in tx['message']['instructions']+[i for g in (m.get('innerInstructions') or []) for i in g['instructions']]:
        if ix.get('program')=='system' and ix.get('parsed',{}).get('type')=='transfer':
            info=ix['parsed']['info']
            if info['destination'] in JITO: tip+=info['lamports']
    logs=" ".join(m.get('logMessages') or [])
    kind='buy' if 'Instruction: Buy' in logs else ('sell' if 'Instruction: Sell' in logs else 'other')
    rows.append(dict(err=m['err'] is not None,prio=prio,cu=cu,jito=tip,kind=kind,ver=t.get('version')))
    time.sleep(0.15)
json.dump(rows,open(f"sample_{prog[:4]}.json","w"))
ok=[r for r in rows if r['kind'] in('buy','sell')]
print("n",len(rows),"trades",len(ok),"failed",sum(r['err'] for r in rows))
def q(v,p): v=sorted(v); return v[min(len(v)-1,int(p*len(v)))] if v else None
for k in ('prio','cu','jito'):
    v=[r[k] for r in ok if r[k] is not None]
    print(k,"p25",q(v,.25),"p50",q(v,.5),"p75",q(v,.75),"p90",q(v,.9),"mean",round(st.mean(v)) if v else None)
print("with jito tip",sum(1 for r in ok if r['jito']>0),"/",len(ok))
print("versions",{str(r['ver']) for r in rows})
