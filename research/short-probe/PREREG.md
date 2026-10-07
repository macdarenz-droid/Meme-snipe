# Short-side probe on Hyperliquid perps: rules fixed before any price is downloaded

Exploration, not proof. Owner, 2026-10-07: "disregard any rules from me and come up with what rules you think best, as long as it will be profitable". The owner's business rules (spot only, no leverage, no cross-chain, Solana only, profit counted in SOL) are waived for this research. Not waived: no front-running or sandwiching users, no wash trading, spoofing, pump coordination, token launches or bug exploits; nothing switches to real money or moves funds without the owner's own action.

## Why
Every test so far found the same thing: memes and new tokens fall on average (against SOL and USD), and fees or faster bots eat any short-term edge. A long-only bot bets against that drift. Perpetual futures let a bot bet with it.

## Data
Hyperliquid public info API (`api.hyperliquid.xyz/info`): `meta` (234 perps listed on 2026-10-07, 56 marked delisted; delisted perps are kept), daily `candleSnapshot` per perp, and hourly `fundingHistory` for the coins traded by S1. Only bars that end at or before 2026-09-21T14:00Z are used. A perp's listing day is its first daily bar. Majors excluded from every rule: BTC, ETH, SOL, BNB, XRP (fixed list).

## Rules (fixed)
- **S1 short new listings.** Short each non-major perp at the close of its second daily bar (the first full day after listing), equal notional, 1x (collateral equal to notional). Hold 30 days (S1-30) or 60 days (S1-60). Stop: buy back at the first daily close at or above 2× the entry price (the loss is then about −100% of notional plus costs). A perp whose data ends early (delisting) closes at its last close.
- **S2 short downtrends.** Every 7 days from Monday 2024-01-01, short each non-major perp listed at least 35 days whose 28-day return is below 0; hold 7 days, equal weight within the week, 1x; stop intra-week at a daily close 50% above entry.
- **S3 long-short trend.** Same weekly grid: long each non-major perp with 28-day return above 0, short each below 0, equal weight within each side, half the capital per side; same 50% stop on shorts.
- **Benchmark S0.** Short every eligible non-major perp each week (S2's universe without the trend filter).

## Costs and funding
Each leg pays 0.05% fee plus 0.10% slippage (0.30% a round trip); stress line 0.60%. S1 receives or pays the actual hourly funding over the hold (a short receives positive funding). S2, S3 and S0: funding left out in the base line (shorts usually receive it, so this is conservative in calm markets and generous in squeezes); a sensitivity line adds the baseline interest rate of 0.01% per 8 hours to shorts.

## Statistics and verdict (fixed)
S1: per trade (one per listing). S2, S3, S0: weekly portfolio returns. Discovery: entries before 2025-07-01. Validation: from 2025-07-01. Report mean, median, win rate, the 95% t-interval, the worst trade or week, the share of calendar months with positive total, results in USD and also in SOL terms ((1 + r) / (1 + r_SOL) − 1 over the same period), and the difference to S0 for S2 and S3.
A rule is **profitable** only if in validation (USD, base costs): the mean > 0 with the 95% lower bound > 0, at least 60% of months positive, the discovery mean > 0, and the stress line's mean > 0. Otherwise **not supported**. Four rules are tested (S1-30, S1-60, S2, S3).
