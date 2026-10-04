import base64,json,time,hashlib,sys
from rpc import rpc
pump=json.load(open('idl_pump.json')); amm=json.load(open('idl_pump_amm.json'))
disc={}
for idl,prog in ((pump,'pump'),(amm,'amm')):
    for e in idl['events']:
        disc[bytes(e['discriminator'])]=(prog,e['name'])
WA="39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
MA="TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"
def sample(addr,n):
    sigs=rpc("getSignaturesForAddress",[addr,{"limit":n}])['result']
    return sigs
def events(sig):
    for _ in range(5):
        r=rpc("getTransaction",[sig,{"encoding":"json","maxSupportedTransactionVersion":0}])
        if r.get('result') is not None or 'error' not in r: break
        time.sleep(1)
    res=r.get('result')
    if not res: return None,None
    logs=res['meta']['logMessages']; evs=[]
    for l in logs:
        if l.startswith('Program data: '):
            b=base64.b64decode(l[14:])
            d=disc.get(b[:8])
            evs.append((d,b))
    return res,evs
if __name__=='__main__':
    which=sys.argv[1]; n=int(sys.argv[2])
    addr=WA if which=='wa' else MA
    sigs=sample(addr,n)
    out=[]
    for s in sigs:
        if s.get('err'): continue
        res,evs=events(s['signature'])
        if evs is None: out.append((s['signature'],None)); continue
        out.append((s['signature'],[e[0][1] if e[0] else 'unk' for e in evs],res['blockTime']))
    json.dump(out,open(f'{which}_sample.json','w'))
    for o in out: print(o)
