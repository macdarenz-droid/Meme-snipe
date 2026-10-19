# EDGE-HUNT-U2 report

Written 2026-10-07 about 08:20 (Melbourne). Paper research only; no trade was sent.

## Answer first

**Would the owner's relaxed rules (H8 floor $15k → $5k, H11 without the "+5 min above migration" check) make money? No.**

- They turn "almost never trades" into trades that lose. On 10.75 days of every PumpSwap graduate (22 Sep – 2 Oct), the relaxed rules give 109 trades. Mean **−10.6%** per $2 trade after costs, 95% CI −15.3% to −5.5%, 19% of trades win.
- The current rules give 10 trades in those 10.75 days, about one a day. Mean −9.8%, CI −23.9% to +6.7%: too few to prove anything, and the point estimate is a loss.
- **H4 (reclaim) does not make money.** The current-rule version above is H4; every relaxed variant loses.
- **H5 (exhausted dump) does not make money either.** Only its price conditions could be tested, which makes it a looser rule than the real H5. With relaxed gates: 323 trades, −11.5%, CI −14.5% to −8.2%. With current gates: 4 trades, −4.9%.
- **The losses are not mainly fees.** Before any cost, every rule with a real sample is already negative: −4% to −10% per trade. The rules pick coins that keep falling. Costs add about 5% on top.
- **Bigger trades do not fix it.** The net mean stays at about −4% to −14% from $5 to $100. It is about −12% to −25% at $1,000, and −40% to −71% at $10,000, where a single buy moves these pools 35–54%. The bot's own R12 rule (pool ≥ 1,000 × trade size) blocks nearly every trade from $20 up.
- **Untouched holdout (2 Oct 18:00 UTC – 6 Oct).** The one pre-selected rule (relax H8 only, the best discovery mean) gave 11 trades, mean **−9.3%**, CI −17.9% to +0.8%.

Verdict under the pre-registered rule: every trial's discovery mean is below zero, so the answer is **no**, not "unclear".

## Numbers

All are net returns per trade in SOL terms at $2, after the bot's real costs. The cost model charges the PumpSwap fee by market cap (1.25% per side below 420 SOL, 1.20% above), and constant-product impact at the modelled reserves. It also charges 414,009 lamports fixed per round trip, which covers expected failed exits and rent loss (`research/edge/costs.json`), plus 146,784 lamports for the second exit after a partial. The CI resamples coins (one trade per coin); a day-block CI is in `results/discovery.md`.

| Rule (trial) | H8 floor | H11 +5-min check | Trades | Win | Mean net | Median net | 95% CI | Gross, before costs |
|---|---|---|---|---|---|---|---|---|
| T1: current U2 rules (H4) | $15k | on | 10 | 30% | −9.8% | −20.2% | −23.9% to +6.7% | −4.7% |
| T2: owner's relaxed H4 | $5k | off | 109 | 19% | −10.6% | −20.6% | −15.3% to −5.5% | −5.7% |
| T3: H4, only H8 relaxed | $5k | on | 38 | 29% | −8.7% | −20.6% | −16.2% to −0.3% | −3.6% |
| T4: H4, only H11 relaxed | $15k | off | 39 | 15% | −15.0% | −23.6% | −22.6% to −6.1% | −10.2% |
| T5: H5 price-only, current | $15k | on | 4 | 50% | −4.9% | −6.2% | −30.3% to +21.7% | +0.5% |
| T6: H5 price-only, relaxed | $5k | off | 323 | 23% | −11.5% | −24.4% | −14.5% to −8.2% | −6.5% |
| **Holdout, T3** (the one pre-selected) | $5k | on | 11 | 27% | **−9.3%** | −15.9% | −17.9% to +0.8% | −4.3% |

Gross = the same trades and exits with no fee, impact or fixed cost. Most trades end at the price stop within minutes; the exit counts per trial are in `results/discovery.md`.

### Size sweep (owner request via S1)

The same signals, with exits re-run at each size. Impact is constant-product at the pool's modelled reserves, on both legs. "Allowed" counts the trades the bot itself would still take: R12 requires the pool's quote side to be at least max(floor, 1,000 × size), and entry impact must be ≤ 1%.

| Rule | $2 | $5 | $20 | $100 | $1,000 | $10,000 | Allowed at $20 / $100+ |
|---|---|---|---|---|---|---|---|
| T1 current | −9.8% | −8.2% | −7.5% | −8.0% | −18.8% | −56.3% | 1 / 0 |
| T2 relaxed | −10.6% | −9.7% | −8.9% | −9.7% | −19.4% | −62.8% | 11 / 0 |
| T3 H8 only | −8.7% | −7.5% | −6.1% | −7.3% | −18.1% | −64.2% | 1 / 0 |
| T4 H11 only | −15.0% | −13.7% | −13.0% | −13.4% | −19.2% | −54.7% | 12 / 0 |
| T5 H5p current | −4.9% | −4.2% | −4.0% | −4.4% | −11.9% | −40.1% | 1 / 0 |
| T6 H5p relaxed | −11.5% | −9.8% | −9.3% | −10.8% | −25.4% | −70.7% | 11 / 0 |
| Holdout T3 | −9.3% | −8.2% | −7.7% | −8.7% | −17.0% | −65.8% | 0 / 0 |

CIs for every cell are in `results/discovery.md` and `results/holdout_T3.md`. No cell's mean is positive; the only CIs that reach above zero are those of the small samples (T1, T3, T5 and the holdout).

In plain words: at $5–$100 the cost per trade falls a little, but the coins chosen still fall. Above about $1,000 our own buying moves these small pools so much that losses grow. The bot's liquidity rule already refuses those sizes on these coins.

## How it was tested

- **Universe.** Every successful pump.fun migration from 2026-09-22 00:00 UTC to 2026-10-06 05:30 UTC, taken from the public keyless RPC: 16,546 pools. No list was filtered by later survival, so there is no survivorship bias.
  - 12,575 had at least 5 SOL at migration. The rest are dust pools, which H8 rejects.
  - All 12,575 got an on-chain creation-time check: 2,803 pass H9 and 9,772 are instant graduations, which H9 rejects.
  - Every graduate that passes H9 got 1-minute candles from GeckoTerminal's free API; one pool was missing there (404).
- **Split.**
  - Discovery: before 2026-10-02 18:00 UTC, 10.75 days, 12,612 graduates.
  - Holdout: after it, 3.48 days, 3,934 graduates.
- **Rules, as of each minute from migration +60 to +240 min.**
  - H8: dust check, plus the floor on effective quote reserve in USD.
  - H10.
  - H11: the spike check (any of the last 3 candles high > open + 25%), plus the +5-min check where it is on.
  - H9.
  - The U2 entry rule, exactly as `study.ts` `u2Setup`: a 30% flush, a higher low 5% above it, price above the VWAP since migration, positive 15-min flow, stop 1% below the 15-min low.
  - The stop-distance check (≤ 20% and ≤ 3 × ATR(14, 1 min)).
  - Then the U2 policy exits: structure stop; take 50% at +1.5R or +100%; then a 3 × ATR trail and break-even; flat exit at 15 min unless +0.5R; negative flow for 5 min; liquidity drop of 30%; T_max 120 min. One trade per coin.
- **Fills.** Signals are taken at the minute boundary. Entry is at the next bar's open. A stop or trail fills at the worst of the level, the bar's open and the bar's close, never at the wick. State exits fill at the next bar's open.
- **Trials.** There were 6, all fixed in `preregistration.json` before any result (commit d328705). The deflated Sharpe of the best-mean trial is 0.29 (it would need to be ≥ 0.95). PBO by CSCV over 10 day blocks is 0.83 (it would need to be ≤ 0.25). Both say there is no edge, rather than a hidden one.
- **One holdout trial**, chosen by the pre-registered rule: the highest discovery mean among trials with n ≥ 30.

## Honest limits

1. **Candle proxies (exploratory).**
   - Net SOL flow is taken as the sign of the price change. That is exact for net flow on a constant-product pool, but the creator's own swaps cannot be excluded, as the bot does.
   - VWAP is computed from candle typical prices.
   - Reserves come from the migration constant product, with BOOST virtual quote of 17.6 SOL and LP fee growth ignored.
   - The REPLAY-1000 chain data was not pushed in time to check these against exact trades.
2. **Not applied (no free historical data):** H1–H7, H12–H14, H15–H17 and the deployer-sell exit. Each would only remove trades, so the bot would trade **less** than shown. That cannot turn a negative mean positive unless those gates happen to remove the losers, and no sample can show that here.
3. **H5 was tested without** f_early_sold and f_devnet, so H5p is a looser rule than H5. The real H5 has only 1–4 trades in this window even when looser.
4. **Small samples for the current rules.** T1 (10 trades) and T5 (4) cannot be called significantly negative. They are negative in point estimate, and they trade about once a day or less, far from the 300-trade proof bar.
5. **H9 uses migration time** instead of graduation time, which is seconds earlier, so H9 is very slightly looser than in the bot.
6. **Data fix and holdout reads.** Some pools have later transactions that also log a Migrate instruction. The first loader sometimes keyed a pool to such a later record (307 candle windows, 537 H9 checks). The fix uses the earliest record per pool; it is recorded in `preregistration.json` (amendments). The holdout was therefore read **twice for the same trial (T3)**: once on the faulty data and once on the corrected data. Both gave n 11 and −9.3%. Discovery barely moved and selected T3 both times.
7. **One regime only.** These are 14 days in late September and early October 2026, with SOL about $110–$125; another regime could differ. The 2 Oct program upgrade does not affect candle data.

## Note for the bot (not a bug, a definition)

The bot's migration price (`facts/producer.ts`, from `CreatePoolEvent.poolQuoteAmount / poolBaseAmount`) leaves out the pool's 17.6 SOL of virtual quote, while its candles and spot include it. So the effective price at migration is about 26% above the "migration price". As a result:
- "Above the migration price at +5 min" (H11) means "fell less than about 21% by +5 min".
- The U2 30% flush means about a 45% fall from the effective price.

The earlier empirical study used the same convention, so the rules match their evidence. Anyone reading the rules as written should know this.

## Files

`README.md` (how to reproduce), `preregistration.json`, `manifest.json` (sha256 of every input; the raw data is not committed), `results/` (`discovery.md`, `holdout_T3.md`, `holdout_T3_firstpass_faulty_data.md`, `trades_*.csv` and the stats JSON).
