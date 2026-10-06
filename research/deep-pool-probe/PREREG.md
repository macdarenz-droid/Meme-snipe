# Deep-pool probe: rules fixed before any return is computed

Exploration, not proof (RES-6 follow-up, 2026-10-06, owner request "find a way"). Written and pushed before any 5-minute candle was downloaded or any return computed. Nothing here enters the bot, the registered attempt 1 (H1–H6) or any holdout. Changing a rule after this commit is a new trial and must be reported as one.

## Question
Do sharp moves in established pump.fun coins (canonical PumpSwap SOL pools in the low fee tiers) give a buy signal that beats all costs, in SOL, at the sizes the owner would really trade (about $50, $200 and $500)?

## Data (pre-wall only)
- Universe source: pump.fun `frontend-api-v3 /coins?sort=market_cap&complete=true`, fetched 2026-10-06; coins with a `pump_swap_pool`, SOL quote, total supply 1,000,000,000 (6 decimals), created at least 3 days before the wall. Known bias: the list only reaches coins worth about $81k or more today, so coins that collapsed later are missing (favours dip-buying; a null result is therefore stronger than a positive one).
- Prices: GeckoTerminal public API, pool OHLCV in the quote token (SOL), daily and 5-minute bars, `before_timestamp` at the wall. Only bars that END at or before 2026-09-21T14:00:00Z are used (the wall). Missing 5-minute bars mean no trades: close carried, volume 0.
- Period: decisions from 2026-07-22T00:00Z (after BOOST) to the wall. Discovery: 07-22 to 08-31. Validation: 09-01 to the wall.

## Eligibility (as of each decision, no look-ahead)
Market cap in SOL = previous UTC day's daily close × 1e9. Group A: ≥ 98,240 SOL (0.30% fee). Group B: 49,120–98,240 SOL (0.55%–0.33%). Group C: 9,820–49,120 SOL (0.95%–0.60%). A and B together are the primary group; C is reported for comparison only.

## Costs per round trip, in SOL, at size q (0.42, 1.68, 4.19 SOL = $50, $200, $500 at SOL $119.26)
- Venue fee: 2 × the PumpSwap tier fee at the eligibility market cap (`research/edge/snapshot/fee-configs.json`).
- Price impact: 2 × q / R, with R = sqrt(85 × 206,900,000 × mcap / 1e9) SOL, the migration constant product with no LP growth (shallower than real, so conservative).
- Fixed: 414,009 lamports per round trip (repo conservative: landing fees, expected failed exits, expected lost rent).
- Stress line: a further 0.5 points per round trip for entry delay and stop slippage.

## Rules (five configurations, fixed)
Entry at the open of the bar after the signal bar. One open position per pool, at most one entry per pool per UTC day. Inside a bar the stop is checked before the target; a bar that opens beyond the stop fills at its open; the target fills at its level. Time exit at the close of the last bar.
- MR-A: 5-min log return ≤ −3 × the standard deviation of 5-min log returns over the previous 3 days (at least 500 bars). Target +6%, stop −4%, time 30 min.
- MR-A-LV: MR-A, and the signal bar's volume ≤ 2 × the median 5-min volume of the previous 3 days.
- MR-B: 15-min log return (3 bars) ≤ −3 × the standard deviation of overlapping 15-min log returns over the previous 3 days. Target +8%, stop −5%, time 60 min.
- MR-B-LV: MR-B, and the 3 bars' volume ≤ 2 × the median 3-bar volume of the previous 3 days.
- MOM-C: 60-min log return (12 bars) ≥ +3 × the standard deviation of overlapping 60-min log returns over the previous 3 days, and its volume ≥ 2 × the median 12-bar volume. Target +8%, stop −4%, time 120 min.
- S0 control for each configuration: one entry per eligible pool-day at a pseudo-random bar (10 fixed seeds), same exits and costs.

## Statistics and verdict (fixed)
Per configuration, group and period: trades, mean and median net return in SOL as % of q, win rate, mean gross, 95% and 99% confidence intervals of the mean by day-block bootstrap (5,000 resamples of UTC days), and the S0 mean.
A configuration is **promising** only if, in the primary group at the $200 size: validation mean net > 0 with the 99% CI lower bound > 0 (about Bonferroni over 5 trials), validation mean net > the S0 mean, discovery mean net > 0, and the stress line's validation mean > 0. Otherwise **not supported**. Even "promising" is only a reason to register a proper test on a never-run window, never a reason to trade.
