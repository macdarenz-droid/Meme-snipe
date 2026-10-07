# Hype Test 1: paid attention at entry (pre-registration)

Written 2026-10-07 about 20:25 Melbourne, before any API call for this test. Design: `../TEST1_DESIGN.md` with all three critics' fixes; context `../RESEARCH.md`. Nothing below changes after data is seen; any later change is an amendment with its time and reason, and cannot loosen a kill rule.

## Coins
- `../test1_sample.json`: 3,000 mints (seed 20261008), created 2026-07-22..08-20 UTC on 30 days, SOL-quoted (native, WSOL or null quote) graduates with a pump_swap_pool, disjoint from `../../lottery-probe/sample.json` (checked: 0 overlap). 3,000 distinct mints and pools.
- Code asserts every `created_ts_ms < 1787270400000` (2026-08-21T00:00Z) and stops otherwise.
- Null-quote rows are kept in the draw. The sample file does not say which rows are null-quote and no on-chain check is made (no extra data source). A pool whose quote is not SOL prices outside 0.5x-10x of the canonical migration price and is dropped by the existing start-price rule (`lottery.classify` = start-missing); that count is reported.
- The fresh draw shares its 30 calendar days with the 492 exploration coins, so a result here repeats the exploration finding on new coins; it is not a test on a new time period. A time-independent claim needs a written validation PREREG (`../../runner-probe/validation_sample.json`, created 08-21..09-06).
- Outcome-viewed set: sample mints that appear in `../../deep-pool-probe/universe.json` (5 mints, whose daily prices were looked at; includes GEOM and TOAD; CATE is not in the sample). The "top 10 by market cap" list named in RESEARCH.md is not in the repo; the deep-pool universe is used as the verifiable stand-in. Every primary figure is reported with and without this set; the verdict uses all coins.
- The universe came from scripted pump.fun access with forged Origin and Referer headers (RESEARCH.md, Risks). The owner decided on 2026-10-07 to keep that existing data. No pump.fun request of any kind is made in this test; callouts (CALLED5) are not collected and not analysed.

## Data (downloads only to the session scratch directory, never the repo)
1. DexScreener `GET https://api.dexscreener.com/orders/v1/solana/{mint}` with `../orders.py` (1.1 s pacing, at most about 55 requests a minute). Up to 3 passes (the script skips mints already answered). A mint without an HTTP 200 answer after the passes has unknown PAID status and is left out of the comparisons, counted.
   - Retention check, before the fresh fetch: the same endpoint for the 900 exploration mints (`../../lottery-probe/sample.json`). Reported: how many approved profile orders with a paymentTimestamp on 2026-07-22..07-24 are still returned (order retention), and the share of coins with any approved profile, per creation day, exploration 900 vs fresh 3,000. A gap above 10 points overall is a caveat, not a kill. The exploration result (201 of 492 paid at least 2 min before entry, 41%) is the reference.
2. GeckoTerminal hourly OHLCV in SOL (currency=token) by `../../lottery-probe/fetch_hourly.py` logic, mode `first` then `refetch`, bars ending by the wall 2026-09-21T14:00Z. A wrapper in this folder runs each pool in try/except, logs failures and retries them on the next pass (a failed pool gets no file). Pools still failing are reported as no-data.
- GeckoTerminal/CoinGecko terms (keyless API "not for production or scheduled polling"; the storage clause) are unverified and listed as an owner risk beside pump.fun's; the data path is not presented as cleared. DexScreener API terms (read 2026-10-07) allow this use.

## Entry, exit, costs (unchanged from the runner probe)
- Usable coin: `runner.coins` (lottery classify == ok; not dust; tradeable at hour 1; no bar below the depth floor before entry), the full 14-day hold inside the data (`trade` not None), and entry + 14 d ending by the last full bar before the wall. Counts of each exclusion reported.
- Entry at the close of the bar at `ts[1]`; t_e = ts[1] + 3600 (seconds). Size $10 (10 / 119.26 SOL). Costs: `lottery.net` (PumpSwap tier fee each side, constant-product impact, 414,009 lamports fixed). Results are net returns in SOL terms.
- Exit R1 on the hourly-pessimistic line: stop -30% filled at min(level, close) until armed; arm when the close reaches 2x; trail 40% below the peak close, filled at the close; max hold 14 days. The real-time line (`mode='opt'`) is reported as an optimistic bound only.

## Signals (all computed only from orders with paymentTimestamp before the cutoff; nothing read "as of today")
- **PAID (primary)**: the orders response contains an order with `type == 'tokenProfile'`, `status == 'approved'` and `paymentTimestamp <= (t_e - 900) * 1000`. UNPAID = 200 answer and not PAID.
- PAID60 (sensitivity): same with a 60-min buffer (`t_e - 3600`).
- PAID+cancelled (sensitivity): status in {approved, cancelled}, 15-min buffer.
- PAID-clean (sensitivity): primary rule, leaving out coins with any tokenProfile order whose status is not approved.
- BOOST (descriptive only, whatever its count): sum of `boosts[].amount` with paymentTimestamp <= t_e - 900 s is >= 10. CTO (`communityTakeover`, approved, same cutoff): diagnostic only. CALLED5: not collected.
- Never used: "has a profile now", tokens/v1 info, any field without a timestamp before the cutoff.
- Known limit: paymentTimestamp precedes visibility by an unknown lag (70 s and 5.3 min seen live; up to 12 h allowed). The 15/60-min buffers bound it; Test 3 measures it.

## Endpoints
- **Primary (one)**: D = mean capped net(PAID) - mean capped net(UNPAID), R1 hourly line, $10, where capped net = min(net, 19.0) (gross proceeds at most 20x the stake; statistics only, exits uncapped).
- Beside it (report only): mean of log(max(1 + net, 0.001)) per group and its difference; uncapped means; mean without the best trade; counts of trades with net >= 9 (10x proceeds) and >= 49 (50x), their summed net proceeds per group, and how many of the coins whose peak close within the hold reached 10x entry were PAID. The 50x question is not testable at this n (power about 22-41%) and is descriptive only.
- Secondary diagnostics (report only, no verdict on their own):
  - Covariate-adjusted D: strata = tertiles of h1 = c[1]/c[0] x tertiles of log(v[0] + v[1]) (both known at t_e; cutpoints from all usable coins), D_adj = sum over strata holding both groups of (n_s / N) * (mean_P,s - mean_U,s). Same bootstrap.
  - Close-triggered stop: the stop fires only when an hourly close is at or below the level, filled at that close.
  - R3 (no stop; arm 2x, trail 40%) PAID vs UNPAID, to see whether any difference is an artefact of the stop.
  - The sensitivity flags above, the real-time line, with and without the outcome-viewed set.
  - A chronological account with fixed $10 bets (`runner.bankroll`) for all coins and for all coins minus PAID.
  - Exploration comparison: the fresh draw's PAID share and D beside the exploration figures (201/492; -31.7% vs +27.9%, capped -31.7% vs -10.2%).

## Statistics
- Day-block bootstrap (primary interval): resample the 30 creation days (UTC) with replacement, keep every usable coin of a drawn day, B = 20,000, seed 20261007; percentile interval. A replicate with an empty group is redrawn.
- Coin-level bootstrap (each coin is one trade, so this is the coin-clustered one): iid over coins, B = 20,000, reported beside it.
- Two-sided bootstrap p for D: p = min(1, 2 * min(share of D* <= 0, share of D* >= 0)), floored at 1/B.
- **Holm family, fixed now (m = 3):** Test 1 PAID D, Test 2 E-A, Test 2 E-B (the primary endpoints of Tests 1 and 2 on this draw). Test 2's p-values are taken from `../test2/RESULTS.md` if it reports them when this analysis runs; otherwise (absent, or "not enough data") they count as p = 1, so PAID is tested at alpha = 0.05/3 = 0.0167. The kill rules use the interval at the PAID's Holm level (98.33% when Test 2 is absent). 95% intervals are shown beside it.
- Random-subset benchmark: 10,000 random subsets of the usable coins with the same count per creation day as PAID (seed 20261008); PAID's capped mean is inside the band if it lies in the central interval at the same Holm level (also shown at 95%).
- Power, recomputed at alpha 0.0167 (normal approximation, iid, capped SD 0.99 from exploration): expected about 1,640 usable coins, about 41% PAID (690 vs 950): 73% power for a 15-point difference; at 1,200 usable coins (492 vs 708): 57%. Day clustering lowers both. At SD 0.5 over 99%.

## Verdict (in order; the first that applies)
1. **Insufficient data** if under 95% of the 3,000 mints got an HTTP 200 orders answer, or under 1,200 usable coins with known PAID status. Everything is still reported.
2. **Better**: D's Holm-level interval is entirely above 0.
   - If the upper end of PAID's own capped mean interval (day-block, Holm level) is below +0.08: **kill (b), cannot rescue the strategy**; attention at entry is dropped as an entry signal.
   - Otherwise: candidate entry filter, valid only after a written validation PREREG; if D_adj's Holm-level interval includes 0, it **adds nothing beyond price and volume** and a price-only rule is preferred.
3. **Worse**: D's Holm-level interval is entirely below 0. Kept only as a candidate reject or exit-width feature for a written validation PREREG, never as proof.
4. For 2 and 3: if PAID60's D has the opposite sign to PAID's D, the verdict **waits for Test 3's lag measurement** (reported as such).
5. **Kill (a), drop**: D's interval includes 0 and PAID's capped mean is inside the random-subset band.
6. Otherwise (interval includes 0, PAID outside the band): **no supported difference**; not an entry signal.

## Not done, stated now
- The spot-check of about 20 inactive pools for missing GeckoTerminal data needs a second keyless historical source; none is allowed here (no pump.fun, no Helius key), so it is not done and is listed as a caveat.
- No portfolio simulation with the live bankroll limits beyond the fixed-bet account above.

## Order of work
This file is committed and pushed, then its commit hash and time are added below in a second commit, pushed, and only then is the first API call made. Analysis code is reviewed by a fresh-context reviewer before RESULTS.md is written.

## Commit record
