# Absorption entry: buy only after new demand beats a large seller (hypothesis, 2026-10-08)

Proposed by the outside reviewer and passed on by the owner. Owner context: a bot that watches all day, may stay idle for weeks, and puts about $50 a trade at risk (the full $50 can be lost).

## The idea
A promising, established coin survives a large seller, and the bot buys only once new demand has visibly replaced that seller. The earlier dip rules bought weakness. This rule waits for recovery and for evidence of replacement demand.

1. **Watch broadly without buying.** Most coins never qualify, and there is no trade quota.
2. **Established, executable market** (starting settings, not proven thresholds): at least 24 h since graduation; an estimated buy-and-sell cost at $50 below 1.5% (pool fee, price impact and fixed costs, at the moment of decision); reliable pool and transaction data.
3. **A genuine selling event:** a confirmed holder sale extracts at least 10% of the pool's preceding SOL reserve. Record the seller, the reserves and the price just before it. Do not buy the initial drop.
4. **Buy only after the market absorbs the sale:** the price recovers to its pre-sale level within an hour; the recovery includes buying by several apparently independent funding groups (wallet count alone is not enough; freeze how independence is measured); liquidity remains. Every condition must be observable when the bot acts.
5. **Exit unchanged while testing the entry:** one existing frozen runner exit, with execution at the real $50 size. Do not tune the entry, stop, trail and ladder together.

## The comparison (same exits and costs for all three)
| Group | What it tells us |
|---|---|
| A: large sale, then recovery with broad buying | the proposed setup |
| B: ordinary recovery or breakout, matched on age, liquidity and prior returns | whether the seller event adds information |
| C: similar large sales that do not meet the recovery trigger | how much the confirmation changes outcomes |

Rejected candidates stay in the dataset.

**Kill rule:** shelve the entry if the selected trades lose after realistic execution, or if they do not beat comparable ordinary breakouts. Too few qualifying events means **unresolved**, not success.

## Why it might fail
- The recovery could be manufactured, for example by wash buys from linked wallets.
- The seller could hold more inventory elsewhere.
- The rebound could use up the remaining buyers.
- The entry could just be an expensive form of momentum. Momentum has done worse than random in our tests (`../deep-pool-probe`, `../cheap-venue-probe`).

## Sizing notes
- A 330× marked winner from $50 would be about $16,500. Its exit impact must be computed at that size; the $10 results cannot simply be multiplied by five.
- At two trades a month, 100 trades take about 50 months. The watcher learns from thousands of rejected candidates, but it cannot create more evidence about the few selected ones.
