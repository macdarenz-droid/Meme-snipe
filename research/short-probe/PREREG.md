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

## Amendments before any return (2026-10-07, from the pre-run review; only file formats and venue docs had been read)
1. **Listing day** = the first daily bar with trades (`n > 0`). Hyperliquid back-fills bars with no trades before a perp starts trading (the first funding row matches the first traded bar in every case checked). First traded days within 60 days of 2023-02-26 (when Hyperliquid's records begin) count as "listing unknown". S1 enters at the close of the bar after the listing day and needs trades on that bar. The weekly rules count 35 days from the first traded bar and need trades on the entry day.
2. **Liquidation.** A fully collateralised 1x short is liquidated when the mark price reaches 2 / (1 + 1/(2 × max leverage)) × entry: 1.714× for 3x-max perps (most memes). Every non-major uses 1.714× (the most conservative). From the day after entry, a daily high at or above 1.714× entry books the short at −100% minus costs (backstop case, margin lost). The close-based stops above stay as written below that level.
3. **Funding.** S1 and the weekly rules use actual hourly funding (shorts receive positive funding, longs pay it), each hourly rate weighted by that day's close over the entry price. A trade or week whose funding rows cover less than the hold (minus one hour) is flagged; the verdict is withheld if any S1 trade lacks full funding. The weekly verdict is judged on the actual-funding line.
4. **Costs.** Turnover uses signed weights (a flip from long to short pays both legs); a stopped or liquidated weekly short pays its exit leg and re-enters at full cost.
5. **Wall.** An S1 trade with entry + hold past the last full day before the wall is dropped whether the perp was delisted or not (time-only). A perp with no bar after entry closes at its entry price (cost only).
6. **Added gate for S1:** a calendar-time test, the mean of monthly cohort returns (trades grouped by entry month) with its t-interval across months, must also have a lower bound above 0. Reported beside it: S1 without known ticker migrations (RENDER, POL, S), and S2 − S0 and S3 − S0 weekly differences.

## Primary rule, declared before any result (2026-10-07, outside review)
The primary short specification is **S2 (short downtrends)**, judged against **S0 (short everything)** at the same exposure: a pass also needs the S2 − S0 weekly difference on the actual-funding line to be positive in validation; otherwise S2 is reported as a broad market short, not a signal. S1 and S3 are secondary and reported without rescue sweeps of listing delays, stops or funding filters.
