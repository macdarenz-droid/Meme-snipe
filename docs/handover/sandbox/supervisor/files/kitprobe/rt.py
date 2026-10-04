import json,urllib.request,time,sys
SOL="So11111111111111111111111111111111111111112"
def q(i,o,a):
    u=f"https://api.jup.ag/swap/v2/order?inputMint={i}&outputMint={o}&amount={a}"
    d=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={"user-agent":"curl/8"}),timeout=20)); time.sleep(2.2); return d
for mint in sys.argv[1:]:
  try:
    for lam in (16754000, 41886000):
        b=q(SOL,mint,lam); s=q(mint,SOL,b['outAmount'])
        loss=1-int(s['outAmount'])/lam
        print('slip',b.get('slippageBps'),s.get('slippageBps'),mint[:6], lam, [r['swapInfo']['label'] for r in b['routePlan']], 'feeBps',b['feeBps'],s['feeBps'],'impact',b.get('priceImpactPct')[:6],s.get('priceImpactPct')[:6],'roundtrip_loss_pct',round(loss*100,3))
  except Exception as e: print(mint[:6],'ERR',e)
