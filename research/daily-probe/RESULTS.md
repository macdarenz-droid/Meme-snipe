# Daily-horizon probe: result

Run 2026-10-07 on commit `2a64f5c` (rules in `PREREG.md` plus the pre-run amendments). Exploration, not proof. 477 pools, 9,008 eligible pool-days, decisions 2026-06-01 to 2026-09-20.

## Verdict (as registered)
All five rules: **not supported**.

## Numbers ($200 a trade, groups A + B + C, % of the trade, in SOL)

| Rule | Discovery net | Validation net | Validation 95% CI (batch t) | Validation median | Win | Vol-matched rule − S0 (validation) |
|---|---|---|---|---|---|---|
| D-REV1 (fell ≥ 22% yesterday, hold 1 day) | +0.3 (n 187) | −1.5 (n 95) | −12.7 to +5.9 | −6.3 | 42% | +3.4 (−5.2 to +9.7) |
| D-REV3 (same, hold 3 days) | +6.7 (n 187) | +3.6 (n 93) | −25.6 to +24.5 | −11.2 | 33% | +10.1 (−12.2 to +24.1) |
| W-REV (bottom 20% by 7-day return, hold 7) | −5.2 | −14.0 | −24.8 to −0.6 | −15.3 | 25% | −1.5 |
| W-MOM (top 20%, hold 7) | +7.0 | −15.8 | −26.9 to −0.1 | −22.2 | 25% | +0.2 |
| TREND (new 7-day high, hold 7) | +4.6 | −12.9 | −22.7 to −0.5 | −14.7 | 25% | −0.9 |
| Buy everything (S0), hold 1 / 3 / 7 days | −2.0 / −2.3 / −3.0 | −3.0 / −5.1 / −11.3 | | | | |

## What it means
- At a daily horizon the cost and speed problems disappear (a round trip of about 2% is small next to moves of ±10–25%), and the problem becomes direction: even this survivor-only list lost about 9% a week (gross) from 2026-08-16 to 09-20 if you simply bought everything.
- D-REV3 is the only rule positive in both periods, but the typical trade lost (median −11%), the mean rests on a few large winners, the A + B coins lost (−5.5%, n 16), the intervals are very wide, and it is exactly the kind of reversal result the survivor bias can create (shown on synthetic data in the pre-run review). Not evidence of an edge until a survivorship-free re-test.
- Momentum and trend made money in June to mid-August and lost from mid-August, when memes fell: a regime, not a rule.

## Limits
Survivor-only coin list (coins worth about $81k or more on 2026-10-06); daily OHLCV from a public aggregator; 2026-06-01 is data-limited; discovery and validation overlap by up to 6 days for H = 3 and 7. A survivorship-free list of 85,111 graduates (created 2026-06-01 to 09-21, with canonical pools) was built from pump.fun's API during the run but has no market-cap fields, so prices for the coins that grew large would need about 85,000 free price calls or the paid history month.

## Survivorship check (2026-10-07)
- **The survivor list was badly biased.** In the 900-coin random sample, 33 of 588 normal canonical graduates closed at least one day at ≥ 9,820 SOL market cap; only 1 of those 33 is in the 481-coin list. Most coins that reach that size later die, so the first run mostly saw winners.
- **Random-sample re-run** (registered; daily bars built from hourly): only 3 sampled coins were ever eligible (alive at group C size with 8 real daily bars). Every trade lost: D-REV3 one trade −72%, TREND four trades (mean −64%), buy-everything −26% at 1 day and −52% at 7 days. Too small to prove anything alone, but the direction matches the bias.
- **Full re-test running.** 16,367 coins (all graduates since March whose pump.fun all-time high passes the filter, traded 9+ days, not dust on chain) are being downloaded in random order (about 32 hours at the free limit); the rules will be re-run on whatever has arrived, which is a random subsample at every point.
