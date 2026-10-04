# Empirical base rates for pump.fun graduations (Meme-snipe)

Research date: 2026-10-03. Analyst: research subagent. All numbers below come from saved raw data and scripts in
`research/empirical-data/` and can be recomputed (`python3 analyze.py`, `python3 analyze_live.py`, `python3 tables.py`).

## Bottom line (plain words)

1. **No rule tested makes money after costs.** 72 rule variants were tested on 361 graduated tokens. None had a positive average result after costs, and none had a confidence interval entirely above zero. The best one averaged **-6.6% per trade** (95% CI -34% to +37%, n=75). The tightest estimate was **-7.4% per trade** (95% CI -9.2% to -5.4%, n=361). Even with the cheapest cost assumption, the best rule still lost 2.9% per trade on average.
2. **Most graduations are pump-and-dump setups.** In the 12-hour backfill:
   - **76%** of normal graduations lost at least 80% of their migration price within 1 hour.
   - **93%** were down 80% or more 24 to 37 hours later.
   - The usual end state is about **-94.5%**. That is the price when nearly everything bought on the curve has been sold back into the pool.
   - Median pool liquidity went from about **$16.1k** at migration to about **$225** a day later.
3. **The bounce right after graduation is a trap.** Median price at +5 minutes was **+101%** above the migration price. Median price at +1 hour was **-93%**. Tokens that were still above their migration price at +5 minutes did worse afterwards (median -97% by +1 hour) than tokens that were not (median -67%).
4. **About 3 in 4 graduations are "instant."** In the backfill, 76% of normal graduations happened less than 5 minutes after the token was created, and 57% within 5 seconds. In the live sample, 22 of 31 migrations were tokens created and graduated within about 0.1 seconds. In the cases checked, the creator still held about 79% of supply. These are bundled launches, not organic demand.
5. **The bot design follows from this:** paper mode only. The default answer is "no trade." No live entries until a rule shows positive net expectancy in forward paper data, with a confidence interval that excludes zero. On this evidence, that will take hundreds of paper trades.

Every positive-looking difference below is a **hypothesis to test in paper mode**, never an edge.

## Data sources (all checked working on 2026-10-03, no keys)

| Source | Used for | Notes |
|---|---|---|
| Public Solana RPC `api.mainnet-beta.solana.com` | Historical universe: `getSignaturesForAddress` on the pump.fun migration account `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`, then `getTransaction` for each one | Throttled (429s seen). `getTokenLargestAccounts` was throttled during the live run, so it was dropped |
| PumpPortal free websocket `wss://pumpportal.fun/api/data` | Live `subscribeNewToken` and `subscribeMigration` | **`subscribeTokenTrade` now requires an API key funded with at least 0.02 SOL** (server message, 2026-10-03). Trade-level data (unique buyers, dev sells on the curve) was therefore not collected |
| GeckoTerminal API v2 | 1-minute OHLCV per PumpSwap pool, SOL-denominated (`currency=token`) | Heavily shared and rate-limited, about 10 calls/min achieved. Pool listings cannot be sorted by creation time, so they were not used for the universe |
| Jupiter lite-api tokens v2 (`/search`, 50 mints per call) | `createdAt` (validated against PumpPortal creation timestamps to within about 1 s), socials from metadata, dev mint count, audit fields, and current price and liquidity | Current values are used as outcomes only, except fields fixed before migration |
| DexScreener `tokens/v1` | Live: pair, liquidity, 5-minute txns (buys and sells) at decision time. Backfill: profile and boost **as of collection** (look-ahead, labelled) | |
| RugCheck `/v1/tokens/{mint}/report` | Live, at mig+60s: risks, score, top holders excluding the AMM pool, insider flags | |
| On-chain PumpSwap event logs (`verify_fees.py`) | Actual fee basis points | Verified **LP 20 + protocol 5 + creator 95 bps = 1.20% per side** on a live pool at about $0.3-0.5M market cap. A second decode on a dead pool returned an implausible layout (2/93/30 bps). Treat that record as misdecoded: the low-cap fee tier is **unverified** |

## Selection rule (survivorship-free)

**Backfill universe:** every successful transaction touching the pump.fun migration account `39azUYF...` with block time in
**[2026-10-01T23:00:00Z, 2026-10-02T11:00:00Z)**, classified from logs (`Instruction: MigrateV2` / `Migrate`). Then deduplicated by mint (earliest migration kept).

- Counts: 1,166 signatures → 754 succeeded → 718 migrate txs, 15 other, 21 that could not be fetched (2.8%, so the universe may be slightly undercounted) → **518 unique migrated mints (43.3 per hour)**.
- The pool and initial reserves were read from the migrate tx's post-token balances: the owner holding both the mint and WSOL.
- Selection happens at the migration event, which comes before any outcome. No trending lists were used.

**Pool classes (observable at decision time):**
- **standard**: 50 SOL or more in the pool at migration. 405 tokens (78.2%), median 67.4 SOL, about $16.1k two-sided at $119.39/SOL.
- **dust**: under 5 SOL. 112 tokens (21.6%), median 0.13 SOL. Median return at +1h is -96%. These are untradeable at any size, and the bot should reject them outright.
- **mid**: 1 token.

**Analysis set:** the 405 standard graduations, minus 1 with no trades after migration and 43 excluded for data quality, leaves **n = 361**.
- Data-quality exclusions (flags overlap):
  - 19 violate constant-product physics: candle high above 1.5x the price reachable with the reported SOL volume.
  - 32 show a >50x first-minute spike in GeckoTerminal that is gone by collection time (Jupiter price back at the dump floor). A cluster sits at about 1.45e-3 SOL with thousands of SOL of reported first-minute volume. It is unclear whether these are parsing errors or whale self-pumps.
  - Tokens whose spike persisted, i.e. real runners such as one now at about $9M market cap, were **kept**.
- **Sensitivity run** including the 32 spike tokens (n = 382; `results/*_incl_flagged.*`): conclusions unchanged. Best rule -7.1%, and no variant above zero.

**Live forward sample:** every `create` and `migrate` event pushed by PumpPortal between about 11:16 and 12:12 UTC on 2026-10-03.
- Small gaps when the collector was restarted at 11:18:48, 11:27:51 and 11:45:02 (each a few seconds) are logged in `live/collector.log`.
- 1,545 launches and 31 migrations were collected.
- Snapshots were taken at mig+60s and mig+5m. 1-minute candles were fetched at 12:14 UTC.

## Method

- **Reference price** = pool price at migration from on-chain reserves (`pool SOL / pool tokens`). GeckoTerminal first-candle opens are on average +27.6% above it (median), because buys land in the same minute.
- **No look-ahead:**
  - Decision time D = migration + X, rounded up to the next full minute.
  - Features use only candles that ended by D.
  - The entry price is the last close before D, i.e. the pool price at D.
  - Exits use candles starting at D or later.
- **Exits:** checked bar by bar on 1-minute candles.
  - **Stop:** if the bar opens below the stop, exit at the open (gap). If the low touches the stop, exit at the stop, or at the bar close if the bar closes below it (a bot polling once per minute).
  - **Take-profit:** counts only if the bar **closes** above it, and the fill is capped at the TP price.
  - If stop and TP fall in the same bar, the stop wins.
  - An optimistic "wick-TP" variant (fill whenever the high touches TP) is reported separately.
  - Time stop: exit at the last close.
- **Outcome at +24h:** GeckoTerminal candles were fetched only to +5h, to fit the shared rate limit. The 24h outcome therefore uses Jupiter's price at collection, 24.7 to 36.7 hours after migration, converted to SOL at $119.39.
- **Cost model for a $2 trade** (q = 0.01675 SOL), applied to both sides:

| Scenario | Venue fee per side | Adverse fill/MEV per side | Jupiter fee per side | Fixed SOL (buy+sell, incl. 25% retry allowance) | Rent |
|---|---|---|---|---|---|
| low | 0.30% | 0 | 0 | 0.00011 (about 0.65% of $2) | recovered |
| **base** | **1.25%** (measured 1.20%) | 0.5% | 0 | 0.00026 (about 1.6% of $2) | recovered (close the token account) |
| conservative | 1.25% | 1.5% | 0.5% (Ultra path, token under 24h old) | 0.00026 | recovered |
| base, rent lost | as base | | | | +0.00207 SOL (about 12% of a $2 trade) |

  Price impact is computed from pool reserves. The SOL reserve is scaled as `R0*sqrt(P/P_mig)` (constant product), and impact = q/(R+q). At 67 SOL this is about 0.03%. On a drained pool of about 1-3 SOL it is about 0.6-1.6%.
- **Statistics:** medians and means with bootstrap 95% CIs (1,000 resamples, seed 7). For signals: difference of medians and of means between yes and no groups. The grid has 72 variants. **No correction for multiple comparisons was applied to the CIs**, so any single "significant" cell would have been expected by chance alone. That is why everything positive is labelled a hypothesis.

## Q1. Base rates

**Launch and graduation rate (live, 0.91 observed hours on 2026-10-03 11:16-12:12 UTC):**
- **about 1,700 new pump.fun tokens per hour**; 30% "mayhem mode"; 71% of mints end in `pump`
- **34 migrations per hour**
- Rate ratio **2.0%** of launches graduate (steady-state approximation).
- Cohort lower bound: 22 of 1,535 tokens created in the window had already migrated by its end (1.4%; censored).
- Backfill migration rate: 43.3 per hour (2026-10-02 overnight UTC).
- **Graduations are dominated by instant launches.**
  - Live: 22 of 31 migrations (71%) were of tokens created in the window, with a median creation-to-graduation time of **0.1 s**.
  - Backfill (standard pools): 76% graduated under 5 minutes after creation, and 57% within 5 s.
  - Live RugCheck/Jupiter snapshots for the instant ones show the dev holding about **79% of supply** and 210-240 SOL in the pool at +60 s.
- **Share of migrations that are untradeable dust pools** (under 5 SOL): 21.6% in the backfill, 8 of 24 (33%) live where liquidity was known at +60 s.

**Returns from the migration pool price (standard graduations, n = 361).** The +24-31h row uses Jupiter's price at collection (24.7-36.7 h after migration).

| horizon | n | p10 | p25 | median [95% CI] | p75 | p90 | mean | share up | share <= -80% | share >= +100% |
|---|---|---|---|---|---|---|---|---|---|---|
| +5m | 361 | -72.6% | -8.4% | +100.8% [+73.5%, +123.9%] | +763.8% | +1034.5% | +367.9% | +73% | +5% | +50% |
| +15m | 361 | -94.5% | -93.3% | -80.3% [-86.6%, -55.8%] | +160.3% | +1343.1% | +253.4% | +37% | +50% | +30% |
| +1h | 361 | -94.5% | -94.5% | -92.9% [-93.4%, -92.5%] | -82.8% | +30.2% | +23.4% | +12% | +76% | +7% |
| +4h | 361 | -94.5% | -94.5% | -93.1% [-93.7%, -92.8%] | -89.6% | -52.0% | +19.5% | +7% | +84% | +4% |
| +24-31h (at collection, Jupiter price) | 361 | -94.5% | -94.4% | -93.5% [-93.8%, -93.1%] | -92.1% | -86.7% | -15.0% | +3% | +93% | +2% |

How to read this table:
- The median path is a **sharp spike, then a full dump**. +5 minutes: +101%. +15 minutes: -80%. +1 hour: -93%.
- The floor at about -94.5% matches a pool where nearly all supply bought on the curve has been sold back. For a 67.4 SOL / 206.9M-token pool, constant product puts that floor at about -95%; LP fees keep it slightly higher.
- Means are positive at short horizons only because of a thin right tail: p90 is +1,034% at 5 minutes, and a few tokens ran. The mean at collection is -15%. Only **2%** of tokens were at +100% or more a day later, and **3%** were above their migration price at all.

**Max favourable / adverse excursion (from migration price):**

| metric | n | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|
| mfe_1h | 361 | +48.0% | +89.2% | +303.0% | +1207.3% | +2297.2% |
| mae_1h | 361 | -94.6% | -94.5% | -93.0% | -87.8% | -40.4% |
| mfe_4h | 361 | +49.6% | +89.2% | +318.2% | +1271.2% | +2364.6% |
| mae_4h | 361 | -94.6% | -94.5% | -93.3% | -90.4% | -76.1% |
| min_after1m_1h | 361 | -94.6% | -94.5% | -93.0% | -87.7% | -40.4% |
| p0_vs_mig | 361 | +23.9% | +26.1% | +27.6% | +30.6% | +275.1% |
| early_mom | 361 | -78.1% | -19.4% | +82.9% | +785.3% | +1080.8% |

- **Rug-like (at least 80% loss vs migration price):**
  - close at +1h: **76%**
  - any low within 1h: **81%**
  - close at +4h: **84%**
  - at 24-37h: **93%**
  - Dust pools: median -96% at +1h.
- **Liquidity (standard pools, n = 405):**
  - At migration: median $16.1k (2 x 67.4 SOL).
  - At collection (Jupiter): median **$225**, p90 $1,489.
  - Median ratio now/migration **1.4%**. **91%** lost more than 90% of their liquidity.
  - Only **4.0%** still had more than $10k of liquidity a day later.

## Q2. Signals at decision time

Setup: entry at mig+5m (decision minute D). Outcome = price change from D to D+60m. "Dead" means at least 80% below the entry price at collection. The last column is the mean result of buying every "yes" token and holding 1 hour, net of base costs.

| signal | n yes / no | median 1h yes | median 1h no | diff of medians [95% CI] | mean 1h yes | mean 1h no | diff of means [95% CI] | dead (<= -80%) at collection yes / no | yes-group mean net (base costs) [95% CI] |
|---|---|---|---|---|---|---|---|---|---|
| price at mig+5m above migration price | 253 / 108 | -97.3% | -67.0% | [-41.9%, -25.8%] | -62.1% | -52.7% | [-23.3%, +5.8%] | +94% / +31% | -65.0% [-76.0%, -51.3%] |
| early_vol_sol >= median | 181 / 180 | -73.2% | -99.3% | [+21.4%, +32.5%] | -42.5% | -76.2% | [+15.5%, +51.1%] | +67% / +84% | -46.0% [-58.8%, -32.4%] |
| early_active_min == 5 (trades every minute) | 353 / 8 | -93.7% | +115.3% | [-403.9%, -118.3%] | -64.5% | +168.9% | [-379.5%, -124.8%] | +76% / +50% | -67.2% [-74.4%, -58.9%] |
| early_drawdown_from_high > -30% | 200 / 161 | -99.2% | -72.0% | [-30.5%, -23.6%] | -64.9% | -52.3% | [-30.8%, +5.8%] | +94% / +53% | -67.7% [-79.5%, -52.7%] |
| socials present (metadata) | 75 / 286 | -71.9% | -96.1% | [+15.5%, +35.4%] | -51.1% | -61.4% | [-10.5%, +36.1%] | +57% / +80% | -54.4% [-72.6%, -33.5%] |
| twitter present (metadata) | 70 / 291 | -74.2% | -96.0% | [+8.7%, +35.4%] | -51.2% | -61.2% | [-12.4%, +37.2%] | +59% / +79% | -54.5% [-73.1%, -29.5%] |
| ttg > 30 min (slow graduation) | 38 / 323 | -63.1% | -96.0% | [+17.1%, +51.4%] | -45.0% | -61.0% | [-4.9%, +36.9%] | +79% / +75% | -48.5% [-63.5%, -32.4%] |
| ttg < 5 min (fast/bundled graduation) | 264 / 97 | -97.1% | -65.6% | [-42.6%, -24.2%] | -68.0% | -35.5% | [-54.7%, -12.6%] | +77% / +72% | -70.7% [-79.9%, -60.1%] |
| dev_mints == 1 (first launch) | 193 / 168 | -96.1% | -79.0% | [-25.6%, -5.4%] | -64.2% | -53.6% | [-27.9%, +10.0%] | +75% / +76% | -67.0% [-78.5%, -53.2%] |
| dexscreener profile (LOOK-AHEAD: current) | 102 / 259 | -66.1% | -96.9% | [+19.1%, +45.4%] | -20.9% | -74.4% | [+29.1%, +82.3%] | +74% / +76% | -25.2% [-47.0%, +0.2%] |
| dexscreener boost active (LOOK-AHEAD: current) | 2 / 359 | -15.1% | -92.6% | – | -15.1% | -59.5% | – | +100% / +75% | -19.6% – |

How to read this table:
- **Momentum in the first 5 minutes is a strong *negative* signal.** If price at +5m is above the migration price, the median 1h outcome is -97% (vs -67% when it is not). 94% are dead at collection (vs 31%). The same goes for "price within 30% of its early high" and "traded every minute". The early pump *is* the dump setup.
- **Fast or instant graduation (under 5 minutes) is negative:** median -97% vs -66%. The difference of means is -12.6% to -54.7%, the only mean difference whose CI excludes zero in the negative direction among the pre-migration features.
- **Less-bad markers, all still losing money net:**
  - socials in metadata
  - slow graduation (over 30 minutes)
  - early volume at or above the median
  - a DexScreener profile, which is look-ahead in the backfill because it was read at collection
  
  These shift the median 1h outcome up by about 15-45 points. Early volume at or above the median is the only one whose difference of *means* also excludes zero (+15.5% to +51.1%); this is a **hypothesis to test in paper mode**, with an in-sample threshold. Every yes-group still has mean net -25% to -54% per trade. **No signal survives costs.** The DexScreener-profile CI touches zero (-47.0% to +0.2%). It is also look-ahead, so it is not usable as evidence.
- **Not measurable with free data on 2026-10-03:**
  - unique buyer count and dev sells on the bonding curve, because the PumpPortal trade stream needs a funded key
  - historical top-10 holder share at migration time
  
  These were collected for the live sample only (below).

**Live forward sample (n = 31 migrations; outcomes only for the 14-19 that had at least 15-30 minutes of data before the 12:14 UTC candle fetch):**
- Entry at mig+6m (after the +5m snapshot):
  - **+15m:** median -4.5% (95% CI -96% to +5%), n = 19
  - **+30m:** median **-92%** (95% CI -99% to -18%), n = 14. 64% were down 50% or more.
- A stop -30% / TP +50% / 30-minute rule averaged **-7.6% net** (95% CI -37% to +21%), n = 14. **Too small to conclude anything.**
- Decision-time holder data (RugCheck top-10 excluding the pool, Jupiter top-holders and dev %, DexScreener 5-minute buy/sell ratio, holders at +5m) was captured for 7-14 tokens per feature. Group sizes were 3-8. **n is far too small to estimate any effect.** Raw per-token values are in `results/live_tokens.csv`.
- The live data does confirm the structure. Instant graduations show dev holdings of 47-79% with RugCheck "Single holder ownership / High ownership" flags. Buy/sell count ratios at +5m cluster at 0.49-0.73 even on tokens that later go to -99%: buy pressure by count is not protective.

## Q3. Naive rule tests

The grid had **72 variants**:
- entry at mig+1m, +5m, +15m or +60m
- filter: none, price above migration price, early volume at or above the median, socials, graduation time of 5 minutes or more, or graduation time of 5 minutes or more plus socials
- exit: stop -30% / TP +50% / 60-minute time stop, stop -20% / TP +100% / 240-minute time stop, or a 60-minute time stop only

All results are net of base costs for a $2 trade. The top 12 by mean are shown below; the full table is in `results/tables_main.md`. "Trades/day" assumes the bot could take every signal, which a single-position $20 bot cannot.

| entry | filter | exit | n | trades/day | mean net [95% CI] | median net | win rate | avg win | avg loss | worst | low-cost mean | conservative mean | wick-TP mean | 1st half / 2nd half mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mig+15m | socials | time-only 60m | 75 | 150 | -6.6% [-34.0%, +36.8%] | -12.4% | +17% | +157.7% | -41.0% | -101.0% | -2.9% | -9.5% | -6.6% | +6.7% / -38.5% |
| mig+60m | none | S-30/TP+50/60m | 361 | 724 | -7.4% [-9.2%, -5.4%] | -5.2% | +10% | +35.1% | -11.9% | -101.0% | -3.7% | -10.2% | -6.3% | -7.1% / -7.8% |
| mig+60m | ttg>=5m | S-30/TP+50/60m | 97 | 195 | -7.7% [-14.2%, -1.4%] | -8.7% | +26% | +35.8% | -22.9% | -84.7% | -4.0% | -10.6% | -5.5% | -7.6% / -7.9% |
| mig+60m | vol>=median | S-30/TP+50/60m | 181 | 363 | -8.5% [-12.3%, -4.9%] | -5.4% | +15% | +38.2% | -17.1% | -101.0% | -4.9% | -11.3% | -6.4% | -8.4% / -8.6% |
| mig+60m | socials | S-30/TP+50/60m | 75 | 150 | -8.6% [-13.2%, -3.7%] | -5.8% | +13% | +33.6% | -15.1% | -51.0% | -5.0% | -11.4% | -7.8% | -7.0% / -12.5% |
| mig+60m | none | S-20/TP+100/240m | 361 | 724 | -9.0% [-11.4%, -6.5%] | -5.7% | +5% | +62.1% | -12.9% | -101.2% | -5.3% | -11.8% | -6.8% | -8.6% / -9.5% |
| mig+60m | ttg>=5m | time-only 60m | 97 | 195 | -9.0% [-19.2%, +1.4%] | -9.7% | +21% | +61.5% | -27.4% | -96.2% | -5.4% | -11.8% | -9.0% | -14.5% / -2.7% |
| mig+60m | none | time-only 60m | 361 | 724 | -9.3% [-12.4%, -6.1%] | -5.2% | +8% | +53.1% | -14.6% | -101.1% | -5.7% | -12.1% | -9.3% | -11.5% / -6.1% |
| mig+60m | vol>=median | S-20/TP+100/240m | 181 | 363 | -9.9% [-14.3%, -5.5%] | -7.1% | +9% | +68.0% | -17.5% | -101.2% | -6.3% | -12.7% | -6.1% | -10.3% / -9.6% |
| mig+60m | mom>0 | S-30/TP+50/60m | 43 | 86 | -10.0% [-21.0%, +0.9%] | -25.1% | +33% | +38.5% | -33.4% | -101.0% | -6.4% | -12.8% | -4.0% | -7.2% / -14.2% |
| mig+60m | ttg>=5m | S-20/TP+100/240m | 97 | 195 | -10.2% [-16.9%, -2.4%] | -24.4% | +11% | +83.1% | -22.1% | -84.7% | -6.5% | -12.9% | -7.2% | -8.5% / -12.1% |
| mig+15m | ttg>=5m | S-20/TP+100/240m | 97 | 195 | -10.7% [-18.8%, -1.4%] | -24.4% | +14% | +85.3% | -26.8% | -98.4% | -7.1% | -13.4% | -4.9% | -6.8% / -15.1% |

- **0 of 72 variants had a positive mean net result. 0 of 72 had a CI excluding zero on the positive side.** 65 of 72 CIs lie entirely below zero. No variant was positive in both the first and second half of the window.
- In the **low-cost** scenario (0.30% fee per side, no slippage) the best mean is **-2.9%**.
- In the **conservative** scenario every variant is -9.5% or worse.
- With the **optimistic wick-TP fill**, 3 of 72 variants turn slightly positive. The best is mig+5m, price above migration, stop -20% / TP +100% / 240m, at +2.2%. That depends entirely on selling at the top of 1-minute wicks, which a polling bot cannot rely on. It is not evidence.
- **Worst single trade is about -100% or worse** in most variants: a dead pool plus fixed fees. The stop does not protect when the pool is drained inside one bar.
- Entries at +60m look "least bad" (-7% to -9%) only because most tokens are already dead by then. The trade then mostly pays costs on a flat price.

## Q4. Implications for a $20 bankroll with $2-$5 trades

- **There is no rule with positive net expectancy whose CI excludes zero.** The data says plainly: do not trade pump.fun graduations with these rules.
- **What it costs to be wrong:** at the most precisely estimated rule (-7.4% per $2 trade), 10 trades lose about $1.50. At the typical early-entry rule (-20% to -30%), 10 trades lose $4-$6 of the $20.
- **Fixed costs bite at $2.**
  - About 1.6% of each $2 trade goes to network fees (base model).
  - An unrecovered token-account rent deposit (about 0.00207 SOL) would cost about 12% of a $2 trade by itself. The bot must close token accounts after exit.
  - Going from $2 to $5 lowers the fixed share. It does not change the sign of any result, because the losses come from price paths, not fees.
- **Data volume needed:**
  - For low-variance rules (per-trade SD of net about 0.20-0.30, e.g. mig+60m stop/TP rules), detecting a true +5% mean with a 95% CI excluding zero needs about **60-140 trades**. We had 97-361 and observed about -7%, which rules out +5% for those rules.
  - For high-variance rules (SD about 1.8, e.g. "socials, hold 60m"), it needs about **4,800 trades**, roughly 30+ days of every-signal paper trading.
  - Any new hypothesis should be pre-registered and tested on a later, untouched forward window. At minimum: n of 300 or more paper trades, net of measured fills, with the first and second half both positive.

## Limitations

- **Window:**
  - One 12-hour backfill window (overnight UTC on 1-2 October 2026) plus about 1 hour live.
  - The market regime can change.
  - The first-half/second-half split inside the window was stable (columns in the grid), but that is not an out-of-sample test across regimes.
- **Prices from GeckoTerminal 1-minute candles:**
  - These are trade prices, not executable quotes.
  - Gaps mean no trades.
  - Intra-minute order is unknown; stop-first and close-confirmation rules were used to stay conservative.
  - 43 of 405 standard tokens were excluded for data errors or unverifiable spikes; a sensitivity run is provided.
  - The candle volume is the reported quote volume and could include wash trades.
- **24h outcome** = Jupiter price at a variable 24.7-36.7 hours after migration, not exactly +24h.
- **Holder concentration, unique buyers, dev sells and RugCheck at decision time:**
  - Only in the live sample (n tiny).
  - Unique-buyer and dev-sell data on the curve was not obtainable without a paid PumpPortal key.
  - Backfill RugCheck was skipped, because the current report would be look-ahead.
- **Look-ahead features (backfill):**
  - DexScreener profile and boost, and the Jupiter dev-mint count, were read at collection.
  - Socials come from token metadata, which is normally fixed at creation but could have been updated.
- **Fees:**
  - 1.20% per side was verified on one pool at about $0.3-0.5M market cap.
  - The creator-fee tier for pools under about $88k is unverified, hence the low-cost scenario.
- **Universe:**
  - 21 of 754 successful migration-account txs (2.8%) could not be fetched or classified.
  - Duplicate successful MigrateV2 txs per mint exist (718 txs for 518 mints); the earliest was kept.
- **Multiple testing:**
  - 72 grid variants and 11 backfill signals were tested, with no formal correction.
  - Signal thresholds such as the "early volume median" were set in-sample.

## Implications for the bot design

1. **Default to "no trade."** Ship the Snipe screen with paper execution only. Show the funnel: X graduations seen, Y rejected (dust pool, instant graduation, dev at least 40%, ...), 0 entries. That *is* the expected output on today's evidence.
2. **Hard rejects that the data supports** (these avoid losses; they do not create edge):
   - pool SOL under 5 at migration (21.6% of migrations)
   - creation-to-graduation under 5 minutes (76% of standard graduations, the worst outcomes)
   - dev or single holder at 40% or more of supply at +60s (live)
   - chasing a post-migration pump (price above migration price at +5m is the most negative signal measured)
3. **Measure, do not assume:**
   - Log every candidate with its decision-time features (this collector's snapshot schema is a working template) and the realised path.
   - Re-run `analyze.py` weekly on fresh, untouched windows.
   - Promote a rule to a live canary only if its forward paper result has n of 300 or more and a 95% CI for mean net that is above zero.
4. **Costs to hard-code as checks:**
   - Read the PumpSwap fee bps from the pool or event: 1.20% per side observed.
   - Close token accounts after every exit (rent is about 12% of a $2 trade).
   - Size impact from live reserves.
   - Treat fills inside the first minutes after migration as highly uncertain: wick-vs-close fills changed results by about 20 points.
5. **Consider a different universe before building more entry logic.** Graduations in this regime are mostly engineered dumps. A future study should test older tokens, e.g. those that survive at least 24h with at least $50k liquidity, using the same survivorship-free method (select at a fixed age, not from trending lists).

## Saved files (`research/empirical-data/`)

| Path | What |
|---|---|
| `lib.mjs` | polite fetch with 429 backoff, RPC helper, GeckoTerminal spacing |
| `backfill_migrations.mjs` | builds the universe from the migration account (RPC) |
| `fetch_ohlcv.mjs` | GeckoTerminal 1-minute SOL-denominated candles for each pool (backfill and live) |
| `fetch_meta.mjs` | Jupiter tokens v2 and DexScreener batch metadata, SOL/USD |
| `live_collector.mjs`, `run_live.sh` | PumpPortal live collector with snapshots at mig+60s and mig+5m (RugCheck, DexScreener, Jupiter) |
| `verify_fees.py`, `fees_observed.json` | on-chain PumpSwap fee decode. The last record (2/93/30 bps on a dead pool) is a misdecode; ignore it |
| `analyze.py` | backfill base rates, signals, 72-variant rule grid, cost scenarios (`INCLUDE_FLAGGED=1` for the sensitivity run) |
| `analyze_live.py` | live sample: launch and migration rates, decision-time features, short-horizon outcomes (`pools` subcommand writes the pool list) |
| `tables.py` | renders the markdown tables |
| `ws_test.mjs` | websocket connectivity probe |
| `backfill/migration_sigs.json` | 1,166 signatures in the window |
| `backfill/migrations.jsonl` | 754 classified txs (mint, pool, reserves, block time) |
| `backfill/ohlcv_1m/*.json` | 518 raw GeckoTerminal responses (1 error) |
| `backfill/meta.json` | Jupiter and DexScreener state at collection plus SOL/USD |
| `live/new_tokens.jsonl` | 1,545 launches |
| `live/migrations.jsonl`, `live/migrations_with_pool.jsonl` | 31 migrations |
| `live/snapshots.jsonl` | 51 decision-time snapshots |
| `live/ohlcv_1m/` | 27 raw candle files |
| `live/collector.log` | restarts and gaps |
| `results/backfill_results.json`, `results/backfill_tokens.csv` | main backfill results and per-token rows |
| `results/*_incl_flagged.*` | sensitivity run |
| `results/live_results.json`, `results/live_tokens.csv` | live results and per-token rows |
| `results/tables_main.md`, `results/tables_incl_flagged.md` | full rendered tables, including the complete 72-row grid |
| `results/*_stdout.txt` | console output of each run |

## Audit

Independent review, 2026-10-03, by a sceptical reviewer. I recomputed the numbers with my own code (`research/supervisor/audit/recompute.py`, numpy, different bootstrap seed and 4,000 resamples). I also ran two perturbation runs: `research/supervisor/audit/analyze_allin.py`, which puts back all 43 excluded tokens, and `research/supervisor/audit/mig1m_bias.py`, which puts back the runners dropped at mig+1m.

**Verdict in one line:** the main conclusion holds. No tested rule has positive net expectancy, and nothing I changed flips any sign. Several specific numbers and method claims are weaker than stated, and they are listed below.

### Headline claims

| # | Claim in the study | My recomputation | Verdict |
|---|---|---|---|
| 1 | 0 of 72 variants positive after base costs. Best is mig+15m / socials / hold 60m: -6.6% [-34.0%, +36.8%], n = 75 | -6.6% [-34.8%, +39.3%], n = 75. With all 43 exclusions put back (n = 404): best -7.0%, 0 of 72 positive, 0 with CI above zero. One trade (+1,450%) drives this rule's mean. Without that trade it is **-26.3%** | **Holds.** The "best" figure is fragile: it is a winner-of-72 statistic driven by one token. Read it as "not positive", not as "-6.6%" |
| 2 | Tightest estimate: mig+60m / none / S-30/TP+50/60m: -7.4% [-9.2%, -5.4%], n = 361 | -7.4% [-9.4%, -5.4%], n = 362. All-in: -7.1% [-9.2%, -5.0%], n = 404 | **Holds** numerically. But the median (-5.2%) is about one round-trip of modelled cost on a flat, dead price, so this CI mostly measures the cost model, not the market. The iid bootstrap over one 12-hour window also understates real uncertainty |
| 3 | 76% of standard graduations at <= -80% at +1h; 93% at 24-37h | 76.2% and 93.1% (n = 362). With the 43 excluded tokens put back (n = 404): **71.3%** and **91.8%** | **Weakened slightly.** Quote it as 71-76% and 92-93%. It depends on the outcome-dependent exclusions below |
| 4 | Median +5m = +101%, +1h = -93%. Above migration price at +5m: median 1h -97% vs -67% | +100.9% [+73.8%, +125.3%]; -92.8% [-93.4%, -92.4%]; -97.3% vs -67.0% (n 254/108) | **Holds** |
| 5 | 76% graduate under 5 minutes after creation; 57% within 5 s | 76.0% and 56.5% (n = 405, Jupiter `createdAt`) | **Holds** |
| 6 | Pool liquidity $16.1k at migration, $225 at collection | $16,095 and $225 (n = 405) | **Holds.** Migration USD uses today's SOL price, which is minor |
| 7 | Low-cost scenario: best rule -2.9% | Reproduces (-2.86%). But see the costs section: the 0.30% fee per side is probably not reachable | **Weakened.** The scenario is likely unrealistic. Real costs are probably at or above base |
| 8 | Data needed: 60-140 trades (SD 0.2-0.3) or about 4,800 trades (SD 1.8) to detect +5% | The formula n = (1.96·SD/0.05)² sizes a CI half-width, which is only **50% power** | **Weakened.** For 80% power, multiply by about 2: **about 125-290** and **about 9,800** trades |

### Universe and selection
- **The selection timing is survivorship-free.** I verified this:
  - Signature paging covers the whole window: the first signature is at 23:00:40, the last at 10:58:48, and paging stopped only after passing T0.
  - Membership is fixed at the migration transaction, before any outcome.
  - Every mint had a candle fetch attempted: 517 files plus 1 GeckoTerminal 404.
- **The undercount is larger than stated.** Besides the 21 fetch failures (2.8%), **28 transactions classified as migrate had no pool or mint parsed and were dropped silently**. The report does not mention them. At about 1.33 transactions per mint, up to about 5-9% of migrations may be missing. The drop happens at migration time, so it should not bias outcomes. It is an undercount, not survivorship.
- **Duplicates were handled correctly.** Several transactions per mint are bundled "MigrateV2 + buy" transactions seconds later. Keeping the earliest one gives the canonical reserves (206.9M tokens / about 67 SOL).
- **Dust pools are real, not a parsing error.** For the 112 dust pools, the first candle open divided by the parsed migration price has a median of 1.00.

### Look-ahead
- **Decision timing is clean.** The entry is the close of the last candle that ended by D (`x[0]+60 <= D`). Exits use candles that start at D or later. Features use candles that start before D. No bar straddles D.
- **The sample definition uses future data. This is the main look-ahead.**
  - The 19 "physics" exclusions are checked over the full 5-hour path.
  - The 31 "implausible 50x" exclusions are defined by the Jupiter price at collection: a spike is kept only if it persisted.
  - 18 of the 43 excluded tokens have truncated candle files (next point). For those, the physics bound is computed with the first minutes of volume missing, which makes false violations more likely on the most active tokens.
  - Putting all 43 back does not change any conclusion, but the 76% rug-rate figure moves to 71%.
  - With the optimistic wick-TP fill, 10 of 72 variants are positive (best about +10%). The main set has 3 (best +2.2%), so "conclusions unchanged" in the sensitivity note is true only for close-based fills.
- **The candle fetch truncates the biggest runners.** `fetch_ohlcv.mjs` asks for `limit=300` over a 301-minute window. 30 pools hit the cap, 12 of them in the analysis set. These 12 are the 12 strongest runners: +1h returns of +34% to +6,069%, and they are missing their first 1-2 minutes.
  - **8 of them were silently dropped from every mig+1m variant** (n 353 instead of 361).
  - I put them back approximately: entry at the first available close, about mig+2m.
  - This moves mig+1m means up by as much as **+18 points**. Socials / hold 60m goes from -71.9% to -53.6%. ttg>=5m / hold 60m goes from -51.5% to -38.1%. All variants stay strongly negative.
  - Early features (volume, active minutes) are also understated for these 12 tokens.
- **Some features are read at collection.** Socials and the dev-mint count come from the current Jupiter record, and the DexScreener fields are current values. The study labels these openly. The "early_active_min == 5" label actually means `>= 5`, and the count can reach 6. This is cosmetic.

### Costs and fills
- **Costs are applied to both sides.** Fee, slippage and impact are charged on the buy and on the sell. The fixed SOL covers both transactions. Rent is recovered in base.
- **The fee tier is probably not unverified.** The "misdecoded" record on the 3.5 SOL pool (LP 2 + protocol 93 + creator 30 bps) adds up to **1.25%**. That matches what I recall as pump.fun's lowest-market-cap PumpSwap fee tier. I did not re-verify it here. If it is right, the base fee of 1.25% per side is correct for these pools, and the "low" 0.30% scenario is not a real possibility.
- **The fixed network cost is optimistic for early entries.** 0.00026 SOL for buy plus sell is fine for an uncontested mig+15m or mig+60m entry. It is low for mig+1m or mig+5m, where priority fees or Jito tips are normal.
  - Adding 0.001 SOL per side moves the two headline rules to **-18.5%** and **-19.3%**.
  - At $2, fixed fees dominate. Any priority-fee policy must be costed in.
- **The same-bar rule is conservative where it matters.**
  - The stop wins over the TP in the same bar.
  - The TP needs a close above the target and is filled at the target, not at the close.
  - The stop fills at the lower of the stop price and the close, which is the worse of "resting stop" and "1-minute poll".
  - The one non-conservative point is the entry, at the exact last close with only 0.5% slippage. At mig+1m to mig+5m, prices move about 100% per minute, so latency could cost far more. Those variants lose 20-73% anyway.

### Statistics and multiple testing
- **The bootstrap is implemented correctly** (percentile method, indices 25 and 974 of 1,000), and my independent CIs agree to within about 2 points.
- **The bootstrap treats tokens as independent, but they all come from one 12-hour regime.** The true uncertainty, especially across days, is larger than the CIs show.
- **The study tested 72 rules plus 11 signals × 2 statistics with no correction, as it admits.**
  - The best-of-72 mean is biased *upward* (winner's curse), which only strengthens "no edge".
  - The "early volume >= median" mean difference (CI +15.5% to +51.1%) uses an in-sample median threshold and is one of about 22 signal tests. Treat it as a hypothesis only, as the study does.
- **Several groups are too small to estimate an effect:**
  - "early_active_min" no-group: n = 8
  - "ttg>=5m & socials": n = 30
  - DexScreener boost: n = 2
  - live sample: n = 14-19

### Bottom line for the bot
The negative result is robust. I tried putting back the exclusions, putting back the truncated runners, raising priority fees and dropping the top trade. None of it produces a rule with a positive mean, and certainly none with a CI above zero.

Required fixes before re-running the study on new windows:
1. Fetch candles with `limit=1000`, or in two pages, so runners are not truncated.
2. Log and investigate the 28 migrate transactions with no pool parsed.
3. Define the data-quality exclusions without using post-decision prices, or report both sets side by side.
4. Size forward paper tests for 80% power: about 2× the trade counts in Q4.
5. Cost priority fees explicitly for any entry earlier than mig+15m.
