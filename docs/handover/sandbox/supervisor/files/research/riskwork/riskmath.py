import random, math, statistics as st
SOL=119.46
ATA=0.00203928*SOL
print(f"ATA rent USD {ATA:.3f}")
for pri in [0,0.0001,0.0005]:
    print(f"tx fixed cost pri={pri} SOL -> ${(5000/1e9+pri)*SOL:.4f}")
# Per-trade loss given loss
def loss_given_loss(q,pc,stop,slip,v,F):
    return q*(pc*1.0+(1-pc)*(stop+slip)) + q*v + F
print("\nExpected loss on a losing trade (USD, % of $20):")
for q in [2,5]:
  for pc in [0.03,0.05,0.10]:
    for stop in [0.10,0.15,0.25]:
      L=loss_given_loss(q,pc,stop,0.05,0.035,0.03)
      print(f" q=${q} pc={pc:.2f} stop={stop:.2f}+5%slip v=3.5% F=$0.03 -> ${L:.3f} ({L/20*100:.1f}%)")
# Break-even avg win needed
print("\nRequired avg net win (as % of notional) for zero expectancy, q=$2, losers = mixture pc catastrophic + stop:")
for pc_all in [0.05,0.10]:
  for stop in [0.15,0.25]:
    for w in [0.3,0.4,0.5]:
      # among all trades: win rate w; losers (1-w) of which fraction cat = pc_all/(1-w) (pc_all of all trades)
      lossfrac=(1-w)
      avg_loss_pct=(pc_all*1.0+(lossfrac-pc_all)*(stop+0.05))  # gross per trade from losers
      cost=0.035+0.03/2  # per trade proportional + fixed/notional
      need=(avg_loss_pct+cost)/w
      print(f" pc={pc_all:.2f} stop={stop:.2f} win={w:.0%} -> avg gross win needed {need*100:.0f}% of notional")
# Kelly with uncertainty
print("\nKelly binary p, b (R):")
for p,b in [(0.4,2.0),(0.35,3.0),(0.5,1.2)]:
    f=p-(1-p)/b
    for n in [30,100,300]:
        se=math.sqrt(p*(1-p)/n); pl=p-se
        fl=pl-(1-pl)/b
        print(f" p={p} b={b} f*={f:.3f} half={f/2:.3f} | n={n} p-1se={pl:.3f} f*(p-1se)={fl:.3f}")
# Monte Carlo
def sim(dist, q=2.0, bank=20.0, n_trades=100, v=0.035, F=0.03, daily_limit=None, trades_per_day=3, ruin=10.0, kill_dd=None, runs=20000, seed=1):
    rnd=random.Random(seed); ruined=0; finals=[]; maxdds=[]; killed=0
    probs=[d[0] for d in dist]; rets=[d[1] for d in dist]
    for _ in range(runs):
        b=bank; peak=b; mdd=0; t=0; dead=False
        while t<n_trades:
            day_pnl=0
            for k in range(trades_per_day):
                if t>=n_trades: break
                if b<q+0.5: dead=True; break
                r=rnd.choices(rets,probs)[0]
                pnl=q*r - q*v - F
                b+=pnl; day_pnl+=pnl; t+=1
                peak=max(peak,b); mdd=max(mdd,(peak-b)/peak)
                if daily_limit is not None and day_pnl<=-daily_limit: break
            if dead: break
            if kill_dd is not None and b<=bank*(1-kill_dd): killed+=1; break
        if b<=ruin: ruined+=1
        finals.append(b); maxdds.append(mdd)
    finals.sort()
    return dict(ev_trade=sum(p*r for p,r in dist)-v-F/q, p_ruin=ruined/runs, median=finals[len(finals)//2], p10=finals[len(finals)//10], p90=finals[int(len(finals)*.9)], mdd_med=st.median(maxdds), killed=killed/runs)
scen={
 "S1 negative (typical retail-like)":[(0.08,-0.95),(0.50,-0.22),(0.27,0.15),(0.15,0.60)],
 "S2 marginal":[(0.05,-0.95),(0.45,-0.20),(0.32,0.20),(0.18,0.70)],
 "S3 positive edge":[(0.04,-0.95),(0.42,-0.18),(0.32,0.25),(0.22,0.90)],
}
print("\nMonte Carlo, $20 bank, 100 trades, v=3.5%, F=$0.03, ruin <= $10")
for name,d in scen.items():
  for q in [2,5]:
    r=sim(d,q=q)
    r2=sim(d,q=q,daily_limit=3.0,kill_dd=0.30)
    print(f" {name} q=${q}: EV/trade(net,% notional)={r['ev_trade']*100:.1f}% | no-limits: P(bank<=10)={r['p_ruin']:.2%} median=${r['median']:.2f} p10=${r['p10']:.2f} p90=${r['p90']:.2f} medMDD={r['mdd_med']:.0%} | with daily $3 + kill at -30%: P(<=10)={r2['p_ruin']:.2%} median=${r2['median']:.2f} killed={r2['killed']:.0%}")
