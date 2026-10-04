import json,time,urllib.request,datetime,collections
from solders.pubkey import Pubkey
RPC='https://api.mainnet-beta.solana.com'
PUMP=Pubkey.from_string('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
TIPS=set(json.loads(urllib.request.urlopen(urllib.request.Request('https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts',data=b'{"jsonrpc":"2.0","id":1,"method":"getTipAccounts","params":[]}',headers={'content-type':'application/json'})).read())['result'])
def rpc(m,p):
    for i in range(5):
        try:
            r=urllib.request.urlopen(urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers={'content-type':'application/json'}),timeout=30)
            j=json.loads(r.read())
            if 'error' in j: raise Exception(j['error'])
            return j['result']
        except Exception as e:
            time.sleep(2+i*2)
    return None
new=json.loads(urllib.request.urlopen(urllib.request.Request('https://api.jup.ag/tokens/v2/recent',headers={'User-Agent':'r'})).read())
mints=[t for t in new if t['id'].endswith('pump') and t.get('launchpad')=='pump.fun']
now=datetime.datetime.now(datetime.timezone.utc)
out=[]
for t in mints[:25]:
    m=Pubkey.from_string(t['id']); bc,_=Pubkey.find_program_address([b'bonding-curve',bytes(m)],PUMP)
    sigs=rpc('getSignaturesForAddress',[str(bc),{'limit':1000}]) or []
    time.sleep(0.6)
    if not sigs: continue
    sigs=[s for s in sigs if s.get('err') is None]
    s0=min(s['slot'] for s in sigs)
    first=[s for s in sigs if s['slot']==s0]
    first1=[s for s in sigs if s0<s['slot']<=s0+2]
    signers=set();tip=False;creator=None
    for s in first:
        tx=rpc('getTransaction',[s['signature'],{'maxSupportedTransactionVersion':0,'encoding':'json'}]); time.sleep(0.6)
        if not tx: continue
        keys=tx['transaction']['message']['accountKeys']+(tx['meta'].get('loadedAddresses',{}).get('writable',[]) )
        signers.add(keys[0])
        logs=' '.join(tx['meta'].get('logMessages') or [])
        if 'Instruction: Create' in logs: creator=keys[0]
        if any(k in TIPS for k in keys): tip=True
    age=(now-datetime.datetime.fromisoformat(t['createdAt'].replace('Z','+00:00'))).total_seconds()
    row=dict(mint=t['id'],age_s=int(age),n_tx_total=len(sigs),tx_slot0=len(first),signers_slot0=len(signers),creator_in_slot0=creator is not None,jito_tip_slot0=tip,tx_slots1_2=len(first1),devMints=(t.get('audit') or {}).get('devMints'))
    print(row,flush=True); out.append(row)
json.dump(out,open('bundle_probe.json','w'))
n=len(out)
print('n',n,'multi-signer slot0',sum(r['signers_slot0']>1 for r in out),'jito tip slot0',sum(r['jito_tip_slot0'] for r in out),'any buys slots1-2',sum(r['tx_slots1_2']>0 for r in out))
