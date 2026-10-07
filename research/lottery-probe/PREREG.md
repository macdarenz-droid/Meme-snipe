# Lottery-basket probe: rules fixed before any return is computed

Exploration, not proof (owner, 2026-10-07: "not perfect, but profitable at the end of the month ... out of 100 trades ... low win rate but take home big"). Pushed before any price was downloaded. Nothing here enters the bot or any holdout.

## Question
If the bot buys many fresh pump.fun graduates with small, equal bets and holds them for weeks, do the few big winners pay for all the losers, in SOL, after costs?

## Data (survivorship-free, pre-wall)
- Coins: a fixed random sample (seed 20261007) of 900 of the 29,382 SOL-quoted pump.fun coins created 2026-07-22 to 2026-08-20 that graduated to PumpSwap, from pump.fun's `coins/search-unrestricted?pumpSwapGraduatedOnly=true` sliced by creation time (built 2026-10-06 by a helper agent; dead coins included; completeness not independently verified). List: `sample.json`.
- Prices: GeckoTerminal hourly OHLCV in SOL for each canonical pool, one call per pool ending at min(first bar + 41 days, the wall). Only bars that end at or before 2026-09-21T14:00Z. Missing hours mean no trades: close carried. A pool with no data is reported and left out (not graduated or never traded).
- Migration hour t0 = the pool's first bar.

## Rules (three entries × three holds, fixed)
- LB-1H: enter at the close of the bar t0 + 1 h (1–2 hours after migration, outside the first-hour window the bot never trades), if that bar or the one before has volume.
- LB-SLOW: LB-1H, only for coins whose pool's first bar is at least 1 hour after the coin's creation (not an instant bundled graduation).
- LB-24H: enter at the close of the bar t0 + 24 h, only if any of the 6 bars before it has volume (the coin still trades a day later).
- Holds: exit at the close of the bar entry + 7, 14 and 30 days; a trade whose exit would end after the wall is left out (depends on time only). No stop.

## Costs (in SOL, at bet sizes $5, $20 and $100 at SOL $119.26)
Net = (1 + g)(1 − f_entry)(1 − f_exit) / ((1 + q/R_entry)(1 + q(1 + g)/R_exit)) − 1 − 414,009 lamports / q, floored at −100% − fixed. f is the canonical PumpSwap tier fee at the market cap (price × 1e9) at entry and at exit; R = sqrt(85 × 206,900,000 × mcap / 1e9) SOL (constant product, effective reserves; optimistic for dead pools, which hardly matters at −99%).

## Statistics and verdict (fixed)
Per line: coins with data, trades, win rate, mean and median net, average win and average loss, the largest multiple, the mean without the top 1% of trades (how much rests on the tail), the 95% interval of the mean by bootstrap over creation days (5,000 resamples), and P(100 trades end positive): 10,000 random batches of 100 trades drawn with replacement, share whose total net is > 0.
A line is **profitable** only if, at $20: the mean net > 0 with the 95% lower bound > 0, and P(100 trades end positive) ≥ 60%. Otherwise **not supported**. Nine lines are tested; a single pass is reported with that count.

Correction before any price was downloaded: the window holds 28,563 SOL-quoted graduates (29,382 is the count across all quote mints); the 900 are drawn from the 28,563.
