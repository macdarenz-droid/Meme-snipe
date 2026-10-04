import json,urllib.request,time,sys
RPC=sys.argv[1]
def call(m,p):
    for i in range(5):
        try:
            j=json.load(urllib.request.urlopen(urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers={"content-type":"application/json","user-agent":"curl/8.5.0"}),timeout=30))
            if 'result' in j: return j['result']
            print('err',j.get('error'))
        except Exception as e: print('exc',e)
        time.sleep(2)
sigs=call("getSignaturesForAddress",["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",{"limit":100}]) or []
seen=set()
for s in sigs:
    if s['err']: continue
    t=call("getTransaction",[s['signature'],{"encoding":"jsonParsed","maxSupportedTransactionVersion":1}])
    if not t: continue
    keys=[k['pubkey'] for k in t['transaction']['message']['accountKeys']]
    for b in t['meta'].get('postTokenBalances') or []:
        if b['mint'].startswith('So111') or b['mint'] in seen: continue
        if b.get('owner') in ('',None): continue
        acc=keys[b['accountIndex']]
        ai=call("getAccountInfo",[acc,{"encoding":"jsonParsed"}])
        if ai and ai['value']:
            v=ai['value']; info=v['data']['parsed']['info'] if isinstance(v['data'],dict) else {}
            ext=info.get('extensions')
            print(b['mint'], b['programId'][:6], 'space',v['space'],'lamports',v['lamports'],'ext',[e['extension'] for e in ext] if ext else None)
            seen.add(b['mint']); break
    if len(seen)>=5: break
for mint in list(seen)[:3]:
    mi=call("getAccountInfo",[mint,{"encoding":"jsonParsed"}])
    v=mi['value']; print('mint',mint,'owner',v['owner'][:8],'space',v['space'],'exts',[e['extension'] for e in v['data']['parsed']['info'].get('extensions',[])])
