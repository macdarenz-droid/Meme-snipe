# Daily-horizon probe: rules fixed before any return is computed

Exploration, not proof (owner, 2026-10-07: "So ur giving up?"). Written and pushed before any daily return was computed. The only daily data read so far is each pool's previous-day close for the deep-pool probe's eligibility (market cap), never a return. Nothing here enters the bot, attempt 1 (H1–H6) or any holdout. A rule changed after this commit is a new trial.

## Why this horizon
Every short-horizon failure so far shares two causes: speed (fast bots take minute-scale edges) and costs (about 1% a round trip against sub-1% edges). Holding days to weeks removes both: entry delay of seconds is irrelevant, and a 1–2% round trip is small next to daily moves.

## Data (pre-wall only)
- Universe: `research/deep-pool-probe/universe.json` (481 pump.fun coins with a canonical PumpSwap SOL pool, created at least 3 days before the wall). Known bias: the list only reaches coins worth about $81k or more on 2026-10-06, so coins that later collapsed below that are missing. This flatters any long strategy held for days; see the verdict rule on S0.
- Prices: GeckoTerminal daily OHLCV in SOL, already downloaded for the deep-pool probe; only bars that end at or before 2026-09-21T14:00Z are used (the last full day is 2026-09-20).
- Decisions on days 2026-06-01 to 2026-09-20. Discovery: entries 06-01 to 08-15. Validation: entries 08-16 to the last day whose holding window ends by 09-20.

## Eligibility for decision day D (as of 00:00 UTC on D, no look-ahead)
Market cap = close of D−1 × 1e9 SOL. Group A ≥ 98,240; B 49,120–98,240; C 9,820–49,120 (fee tier ≤ 0.95%). At least 8 daily bars up to D−1, and volume > 0 on D−1. Primary group: A + B + C. Also reported: A + B (less exposed to the survivor bias).

## Entry, exit and costs
Entry at the open of D (equal to the close of D−1 in this data; at a daily horizon a seconds-long delay is immaterial). Exit at the close of day D + H − 1. No stops. One entry per pool per signal per day; holding windows may overlap.
Round-trip cost, additive, in SOL as % of size q: 2 × PumpSwap tier fee at the D−1 market cap + 2 × q/R with R = sqrt(85 × 206,900,000 × mcap / 1e9) + 414,009 lamports / q. Sizes $200 and $1,000 at SOL $119.26. Stress: a further −1 point.

## Rules (six, fixed)
With r1 = ln(c[D−1]/c[D−2]) and r7 = ln(c[D−1]/c[D−8]):
- D-REV1: r1 ≤ −0.25 (fell about 22% or more on D−1); hold H = 1 day.
- D-REV3: the same signal; hold H = 3 days.
- W-REV: among pools eligible on D (at least 10 that day), the bottom 20% by r7; hold H = 7.
- W-MOM: the top 20% by r7; hold H = 7.
- TREND: c[D−1] above every close of D−8..D−2 and r7 > 0; hold H = 7.
- S0 for each H in {1, 3, 7}: every eligible pool-day, the "buy everything" benchmark.

## Statistics and verdict (fixed)
Per rule, group, size and period: trades, mean and median net, win rate, mean gross, and the S0 mean for the same H. Confidence intervals by a moving-block bootstrap over entry days with block length max(H, 3) days (5,000 resamples), 95% and 99%; also the mean difference rule − S0 on matching days with its 95% interval.
A rule is **promising** only if, in the primary group at $200, all hold: validation mean net > 0 with the 99% lower bound > 0; the validation difference rule − S0 has its 95% lower bound > 0 (so the survivor bias, which lifts S0 too, cannot carry it); discovery mean net > 0; and the stress line's validation mean > 0. Otherwise **not supported**. Even "promising" means only: re-test on a survivorship-free coin list and then on a never-run window, never trade.

## Amendments before the first run (2026-10-07, from the pre-run review; no daily return had been computed)

The review showed, on synthetic data, two ways the rules above could pass by chance. Changes (deviations from the text above, made before any result):
1. **Intervals.** The moving-block bootstrap under-covers with about 30 validation entry days (nominal 99% covered about 86% at H = 7). Replaced by non-overlapping calendar batches of H days: each batch's trade-weighted mean, then a t-interval with (batches − 1) degrees of freedom. The verdict uses the 99% t lower bound for the mean and the 95% t lower bound for the difference.
2. **Survivor bias does not cancel against S0.** Keeping only coins alive on 2026-10-06 lifts later returns most for volatile coins bought low, so rule − S0 is biased upward for D-REV1, D-REV3 and W-REV (and downward for W-MOM and TREND). The comparator becomes a **volatility-matched S0**: the eligible pool-days of the same day, same group and same quintile of trailing volatility (standard deviation of the seven daily log returns D−8..D−1, as of D). The difference is trade-weighted per day. The verdict also requires the A + B group's difference to be positive. Stated plainly: a "promising" D-REV1, D-REV3 or W-REV result on this coin list cannot be told apart from survivor bias, and needs the survivorship-free re-test before it counts; W-MOM and TREND are judged conservatively.
3. **Exact exit cost.** A second cost line charges the exit at the exit-day fee tier and size: entry fee(m_D−1) + q/R, exit fee(m_exit) × (1 + g) + (q/R) × (1 + g)^1.5, plus the fixed cost. The verdict must hold on both lines.
4. **Real bars.** "At least 8 daily bars" counts bars with volume; closes are carried across no-trade days (an AMM price does not move without trades).

Known limits, reported with the result: 2026-06-01 is data-limited (most histories start 2026-05-25); discovery trades entered 08-10 to 08-15 share price paths with early validation trades at H = 3 and 7; the A + B lines use ranks computed across A + B + C.

## Survivorship-free re-test (registered 2026-10-07, before any new coin's prices were downloaded)

The first run (RESULTS.md) used a survivor-only list. This re-test runs the same five rules, code, costs and amended verdict on a universe that includes dead coins:
- Universe = the 481-coin list, plus every pump.fun coin created 2026-03-01 to the wall that graduated to a canonical PumpSwap SOL pool and whose all-time-high market cap, as reported by pump.fun's `coins/search-unrestricted` (USD), is at least US$589,809: 9,820 SOL (the group C floor) at the lowest SOL price from 2026-06-01 to the wall (US$60.06, Hyperliquid daily low). Any coin that ever reached group C before the wall passes this filter whatever SOL's price was then; coins that only grew after the wall pass it too and simply have no eligible days.
- Daily prices fetched exactly as before (GeckoTerminal daily OHLCV in SOL, bars ending by the wall). Coins with no data are counted and reported.
- Known remaining gap: coins created before 2026-03-01 that were large in June to September and are now below about $81k are still missing.
- Both runs are reported side by side; the survivorship-free run is the one that counts.

## Survivorship-free check on a random sample (registered 2026-10-07, before it is computed)

A count on the lottery-basket sample (no returns) showed the survivor list misses most of the real universe: of 588 normal canonical graduates (on-chain LP supply ≥ 4e12) created 2026-07-22 to 08-20, 33 closed at least one day at ≥ 9,820 SOL market cap, and only 1 of them is in the 481-coin list. The full re-test above needs daily prices for about 17,900 coins whose pump.fun all-time high passes the filter (about 35 hours of free calls), so it runs later. Now, the same five rules, costs and amended verdict run on the random sample itself:
- Universe: the 900 sampled coins minus dust pools (the lottery probe's amended dust rule: first bar opens below 2.41e-8 SOL).
- Daily bars built from the hourly bars (open of the first hour, high and low over the day, close of the last hour, volume summed; days with no hourly bar are missing and carried, as before). Only bars ending by the wall.
- Same eligibility, signals, holds, costs and periods (discovery entries before 2026-08-16, validation after).
- Expected to be small (a few dozen trades); reported with its intervals as a check on the survivor-only result, not as a verdict that can make a rule promising on its own.
