# Established-meme trend probe: rules fixed before any return is computed

Exploration, not proof (owner, 2026-10-07; route ranked first by the untested-route map). Pushed before any return was computed. Nothing here enters the bot or any holdout.

## Question
Do large, established Solana memes held only while their price in SOL is trending up (time-series momentum, one of the best-documented effects in crypto at 1–4 week horizons) grow a SOL stack after costs? Profit is counted in SOL (owner rule), so every price is divided by SOL's.

## Data
Hyperliquid perpetual daily candles (public info API, downloaded 2026-10-06 by the RES-7 carry research) for 19 memes: AI16Z, BOME, CHILLGUY, FARTCOIN, GOAT, GRIFFAIN, MELANIA, MEW, MOODENG, MYRO, PENGU, PNUT, POPCAT, PUMP, SPX, TRUMP, USELESS, WIF, kBONK; and SOL. Perp closes stand in for spot (the basis is small for direction at weekly horizons; stated limit). Only bars that end at or before the wall (2026-09-21T14:00Z) are used. Known bias: the list is coins that became large enough for a perp listing, picked with hindsight; delisted perps (MYRO) are kept up to their last bar.

## Rules (four, fixed)
Decisions every 7 days at 00:00 UTC, starting on the first Monday 2024-01-01, using closes up to the previous day. A coin is eligible from 35 days after its first bar. Price in SOL p = close_coin / close_SOL. Positions are equal weight within the portfolio and held for 7 days; a coin not held means SOL (return 0 in SOL).
- TSM-28: hold each eligible coin whose 28-day SOL return is > 0.
- TSM-14: the same with a 14-day lookback.
- XS-MOM: hold the 3 eligible coins with the highest 28-day SOL return (needs at least 6 eligible).
- XS-REV: hold the 3 eligible coins with the lowest 7-day SOL return (needs at least 6 eligible).
- Benchmarks: HOLD-ALL (every eligible coin, equal weight, weekly) and SOL (0).
A delisted coin's position closes at its last close.

## Costs
Per coin, each leg that changes the position (enter or exit) pays half of a round trip: base 0.6% per round trip (deep meme pools at about 0.25–0.30% a side plus small impact at $500–$2,000; Raydium AMM v4 0.25% and Orca 0.16% pools exist for some of these coins, RES-6 speed-and-cost research); stress 1.2%. A week in which a held coin stays held pays nothing. The portfolio's weekly return is the mean of the held coins' 7-day SOL returns minus the cost of that week's changes spread over the portfolio's positions; an empty portfolio returns 0.

## Statistics and verdict (fixed)
Weekly portfolio returns are one observation per week. Discovery: weeks starting before 2025-07-01. Validation: weeks from 2025-07-01 to the last full week before the wall. Report mean, median and compounded growth in SOL, share of weeks positive, the worst 4-week drawdown, the mean weekly difference to HOLD-ALL, and 95% t-intervals.
A rule is **promising** only if all hold: validation mean weekly net (base costs) > 0 with the 95% t lower bound > 0; validation mean > HOLD-ALL's; discovery mean > 0; the stress line's validation mean > 0. Otherwise **not supported**. Even "promising" means only a re-test on a never-run window and an owner decision on venues, never a trade.
