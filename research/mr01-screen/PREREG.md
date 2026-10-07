# MR-01 1-minute screen: rules fixed before any return is computed

Kill-only screen of the Blueprint's first strategy MR-01 (`MR01_SPEC.md`, verbatim) at 1-minute resolution, closer to the 15 s spec than the earlier 5-minute proxy (`../deep-pool-probe`). Written, committed and pushed before any 1-minute candle was analysed or any return computed (one 1-minute page was downloaded only to check that July history exists). Nothing here enters the bot, the registered attempt or any holdout. Changing a rule after this commit is a new trial and is reported as one.

## Question
Can MR-01, as specified, be ruled out on 1-minute data before building the 15 s recorder? A pass is not evidence for MR-01; it only means the 15 s recorded test is still needed.

## Data (pre-wall only)
- Coins: `../deep-pool-probe/eligible.json`, the 25 pools whose best group is A (market cap ≥ 98,240 SOL on at least one day). That list comes from pump.fun's market-cap ranking fetched 2026-10-06 (`../deep-pool-probe/universe.json`, filters in `fetch.py`), so it holds **survivors only** (coins still worth about $81k or more in October). Survivors favour dip-buying: a KILL on this list is strong evidence, a pass is weak.
- Daily bars (for eligibility and pool age) and 1-minute bars: GeckoTerminal public API, keyless, `currency=token` (prices in SOL), `before_timestamp` at the wall, paced 6.5 s per call, backing off on 429. No pump.fun requests. Downloads stay outside the repo; Python that reads them runs as `python3 -I`.
- Wall: 2026-09-21T14:00:00Z. Only bars that end at or before the wall are used.
- GeckoTerminal omits minutes with no trade and its open equals the previous close. Missing minutes are filled with the previous close (open = high = low = close, volume 0), up to the last minute that ends at or before the wall.

## Universe on each day (as of the decision, no look-ahead)
A pool is eligible on UTC day d when all hold:
1. Market cap = previous UTC day's daily close (SOL) × 1e9 ≥ 98,240 SOL (the 0.30% PumpSwap tier, EX-07).
2. Effective quote depth R ≥ 300 SOL, with R from the probe's constant-product model: R = sqrt(85 × 206,900,000 × mcap / 1e9) SOL (migration constant product, no LP growth; shallower than real). At 98,240 SOL this gives R ≈ 1,314 SOL, so this filter never binds in this tier; it is applied anyway.
3. Pool age ≥ 24 h at every moment of day d: the pool's first daily bar is on or before day d − 2.
Period: entries from 2026-07-22T00:00Z to the wall. **Discovery** = entries before 2026-08-21T00:00Z; **validation** = entries from 2026-08-21T00:00Z to the wall.

## Signal (MR-01 adapted to 1-minute bars)
- r1[j] = ln(c[j] / c[j−1]), 1-minute log returns on the filled series (a no-trade minute is a zero return, as a 15 s aggregator would produce).
- Scale at minute i: MAD / 0.67449 of r1 over the previous 6 h, the 360 returns r1[i−360 … i−1] (never minute i or later), × sqrt(L in minutes). MAD = median of |r1 − median(r1)|.
- z = ln(c[i] / c[i−L]) / scale. Entry signal when z ≤ −3.0.
- A signal needs: minute i has a trade (volume > 0); 360 + L earlier minutes exist in the pool's fetched history; MAD > 0 (else no signal); the UTC day of minute i is eligible.
- One position per pool at a time: a new signal is taken only after the previous trade's exit minute. No once-per-day cap.

## Configurations (exactly as specified, both fixed)
| Name | L | z_entry | stop a | time stop T |
|---|---|---|---|---|
| MR-01-5 | 5 min | 3.0 | 4% | 30 min |
| MR-01-15 | 15 min | 3.0 | 5% | 60 min |

## Fills and exits
- Entry at the close of the signal minute i (p0 = c[i]). Holding minutes i+1 … i+T.
- Targets, whichever comes first: the 6 h rolling median (at minute j: median of closes c[j−360 … j−1], past only) or p0 × 1.06. Target level = the lower of the two.
- Order inside minute j: (1) if the minute's open is already at or above the target level, exit at the open; (2) else if the low ≤ p0 × (1 − a), stop; (3) else if the high ≥ the target level, exit at the level; (4) at minute i+T, exit at its close. Stop before target inside a minute is the pessimistic order.
- **Stop fill, main line:** at the stop level; if the minute opens at or below the stop (gapped through), at the open. Because GeckoTerminal's open equals the previous close, a gap can never show, so every main-line stop fills at its level. This is the **optimistic** fill, used for the verdict because a kill-only screen must not kill on pessimistic assumptions.
- **Stop fill, pessimistic line:** at the lower of the stop level and that minute's close.
- A trade whose exit minute would end after the wall is dropped.

## Costs per round trip (additive, in SOL, as % of the trade size q)
net = gross − 2 × 0.30% − 2 × q / R − FIXED / q
- Sizes: $200 and $1,000 at SOL $119.26 (the probe's rate): q = 1.677 and 8.385 SOL.
- R from the eligibility market cap (previous day's close) with the model above.
- FIXED = 414,009 lamports (`../lottery-probe/lottery.py` `FIXED`): landing fees, expected failed exits, expected lost rent.

## Lines reported
1. **Main** (registered, verdict line).
2. **Delayed entry:** entry at the close of minute i+1 (filled close if no trade), holding i+2 … i+1+T, same exits.
3. **Cost stress:** main − 1 percentage point per round trip.
4. **Pessimistic stop fill:** stop at min(level, close).
5. **Delayed + stress:** lines 2 and 3 together.

## Random-entry benchmark (matched by pool and hour)
For each main-line trade: 20 random entries in the same pool, at the close of a random minute that has a trade, in the same UTC hour of day, on an eligible day of the same period (discovery or validation), drawn with a fixed seed (SHA-256 of seed, pool, trade time). Same exits and costs; the one-position rule is not applied. Reported as mean net and the dip line's excess over it.

## Statistics
Per configuration, period, size and line: trades, mean, median, win rate (net > 0), mean gross, and a 95% CI of the mean net by day-clustered bootstrap (5,000 resamples of UTC entry days, seed 7, percentile interval).

## Filters not applied (cannot be computed from OHLCV)
- Depth has not fallen > 10% over L: would only remove trades.
- Authority or fee-config change pending, token-safety checks (section 8.4): would only remove trades.
- REGIME (section 8.1): would only remove trades.
- ENTRYRATE (section 8.1): would only remove trades.
- Universal exits (section 8.6): add exits, can shorten trades either way; not modelled.
Removing trades by a filter that is unrelated to future returns leaves the CI's centre about the same; a filter could raise the mean only if it selects better trades, which this screen cannot test.

## Verdict (fixed, kill-only, Blueprint CS-1 style)
**KILLED** if, in validation at $200 on the main line, BOTH configurations have a 95% CI upper bound < 0.
Otherwise **NOT KILLED: needs the 15 s recorded test**.
Discovery, $1,000, the stress lines and the benchmark are reported but do not change the verdict.

## Known limits (stated in advance)
- Survivor-only coin list (see above). 1-minute OHLCV from an aggregator, not 15 s pool snapshots or fills. Fee tier from the 2026-10-03 snapshot assumed unchanged. Depth model ignores LP growth (overstates impact). Fewer than 31 validation days, so the bootstrap is somewhat liberal.
