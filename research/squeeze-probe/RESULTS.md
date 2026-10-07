# Squeeze probe (H1): results

The rules are in `PREREG.md` (items 1–23 record every fix, each committed before the outcomes it could affect). This is exploration, not proof, and nothing here counts toward the pre-funding gate. Results are in `results_registered.json` and `results_t2.json`; the data checks are in `datachecks.json` and `datachecks_t2.json`. Percentages are net returns in SOL per $50 (0.4193 SOL) round trip, after all costs.

## Verdicts
| Trial | Verdict | Why |
|---|---|---|
| **Registered primary** (PREREG item 20) | **UNRESOLVED** | Data check 3 failed 10 of 191 AMM v4 swaps (5.24%, limit 5%), so AMM v4 pools are dropped. Every primary pool is AMM v4, so no trade could be priced. |
| **H1-T2** (item 21: same rules, data check 3 counts only swaps of 0.001 SOL or more in single-swap transactions; amendment committed before any outcome) | **KILLED** (95% level and 99.58% family level) | Mean net n = **−0.71%** ≤ 0. The mean lift d is +0.32%, but the kill rule fires on n alone. |
| H1-PERP (item 23) | not run, exploratory | It arrived after T2 had read pool prices. |

Why the registered check failed: 9 of the 10 failures are dust swaps of 19–128 lamports, where the pool's own integer rounding alone moves the price by more than 0.1%. The others are transactions holding 2–4 swaps on the same pool, so their netted vault changes are not one swap. Exact AMM v4 integer math reproduces the dust swaps to within about a unit. Under the amended check, 1 of 196 swaps failed (0.5%). The registered verdict stays UNRESOLVED; T2 is a separately labelled new trial.

## H1-T2 primary (Binance OI; 238 frozen events)
All 238 events were executable and every one had a full C1 set, so the lift set is the whole primary. That clears the minimum of 150 events and 100 days.

| Measure | Value |
|---|---|
| Events / coins / UTC days | 238 / 13 / 195 |
| Mean n (median) | **−0.71%** (−0.70%) |
| Mean gross, pool mid price only (median) | −0.11% (−0.10%) |
| Win rate (n > 0) | 34.5% |
| Mean C1, matched ordinary breakouts | −1.03% |
| Mean d = n − C1 (median) | **+0.32%** (−0.07%) |
| 95% day-block bootstrap: n | −1.40% to +0.002% |
| 95% day-block bootstrap: d | −0.39% to +1.08% |
| 95% day-clustered t: n | −1.42% to −0.004% |
| 95% day-clustered t: d | −0.42% to +1.06% |
| 99.58% (family k = 12): n, bootstrap / t | −1.68% to +0.39% / −1.75% to +0.33% |
| 99.58%: d, bootstrap / t | −0.67% to +1.49% / −0.77% to +1.41% |
| 60-second line, mean n | −0.71% |
| Stress line (n − 1 point) | −1.71% |
| C2 random-entry drift, mean | −0.54% |
| C1b (F or O alone, never both), mean | −0.88% |

- **Balance.** Standardized mean differences, events against C1: r24 +0.12, m24 −0.10, vol6 **+0.39** (events were more volatile than their controls), hour sin +0.07, cos +0.02.
- **Data quality.** No entry state older than 1 h. Every event got 5 C2 controls. No event fell within 72 h of a perp's funding cut.

**Halves (split 2025-11-07):**

| Half | Events | Mean n | Mean d |
|---|---|---|---|
| First | 119 | −0.50% | +0.64% |
| Second | 119 | −0.92% | −0.01% |

**By year:**

| Year | Events | Mean n | Mean d |
|---|---|---|---|
| 2024 | 14 | −1.78% | −0.50% |
| 2025 | 148 | −0.45% | +0.66% |
| 2026 | 76 | −1.02% | −0.19% |

**Funding sign at the trigger hour:**

| Funding | Events | Mean n | Mean d |
|---|---|---|---|
| Below 0 | 187 | −0.45% | +0.63% |
| 0 and above | 51 | −1.67% | −0.81% |

**Per coin (mean n / mean d):**

| Coin | Events | Mean n | Mean d |
|---|---|---|---|
| MEW | 42 | +0.01% | +0.82% |
| WIF | 41 | −0.63% | −0.17% |
| PNUT | 27 | −0.68% | +0.19% |
| BOME | 26 | −1.42% | −0.75% |
| SPX | 23 | −0.59% | +0.55% |
| MOODENG | 20 | +1.97% | +4.12% |
| POPCAT | 16 | −0.79% | +0.29% |
| FARTCOIN | 13 | −2.50% | −1.54% |
| GRIFFAIN | 9 | −0.55% | +0.99% |
| GOAT | 8 | −2.69% | −0.74% |
| CHILLGUY | 6 | −1.60% | +0.13% |
| VINE | 6 | −4.61% | −2.94% |
| ZEREBRO | 1 | −5.34% | −3.08% |

Only 2 of 13 coins have a positive mean n; MOODENG alone is above the cost.

## Secondary arms (descriptive; they never rescue the primary)
| Arm | Events (days) | Mean n | Mean d | 95% bootstrap, d |
|---|---|---|---|---|
| A: funding + breakout, no OI; before D_split 2025-09-19 | 676 (277) | −0.24% | +0.39% | +0.01% to +0.77% |
| B: Hyperliquid daily OI, to 2026-04-03 | 119 (93) | −1.04% | −0.55% | −1.54% to +0.39% |
| C: coin-specific funding (minus universe median) | 170 (125) | −0.65% | +0.52% | −0.79% to +1.82% |
| D: spot-signal coins (WIF, BOME, PNUT) | 94 (88) | −0.86% | −0.22% | −0.94% to +0.46% |
| E: first event per UTC day | 195 (195) | −0.68% | +0.26% | −0.54% to +1.15% |

- Arm A's lift interval sits just above 0 (t-interval +0.004% to +0.78%), but its mean net is still negative (−0.24%, bootstrap −0.61% to +0.15%). A selection effect that does not cover costs is not a trade.
- Arm A's sealed holdout (749 events from 2025-09-19, SHA-256 `6ee6e297…`) was not read. It remains available for a later 300-trade test of the reduced rule, which would have to beat costs, not only controls.

## Credits and data
- **Helius:** 178,020 credits booked of the 400,000 cap (17,802 calls at the conservative 10-credit convention). The cap was not reached.
- **Free data:** about 47 Binance archive series (file hashes in `data_manifest.json`), Hyperliquid funding and candles, the Hyperliquid stats OI JSON, 8 GeckoTerminal lookups and 7 CoinGecko list calls. All downloads are outside the repo, and no pump.fun request was made.

## Caveats
- **Live parity.** Binance market data returned HTTP 451 from the research hosts (fapi and api.binance.com). Whether a production host can reach Binance spot klines and futures OI is unverified. This history, read from the public archive, could not be reproduced live from such a host. Any forward version needs one request each from the production host first, or the pool's own 5-minute price plus recorded Hyperliquid OI.
- **New trial, not the registered test.** T2 changed one data check after seeing that check's (non-outcome) result. The amendment was committed before any outcome was read, but T2 is still a different trial from the registered one.
- **Perp-proxy signal.** 10 of 13 coins use Binance perp closes for the breakout. Arm D (spot signal) is no better.
- **Survivorship.** The pools and the classification are today's. 7 coins were dropped for lacking a deep Raydium constant-product pool today (kBONK, PENGU, TRUMP, MELANIA, AI16Z, MYRO, DOOD).
- **Reserves.** Vault balances include small uncollected protocol fees. The amended check bounds the error at 0.1% for all but 0.5% of real swaps.
- **Clustering.** Events concentrate in market-wide funding lows (238 events on 195 days). The intervals are clustered by day.
- **Power.** The PREREG assumed a 6-hour σ of 6–8%. The realized d interval is about ±0.7 points wide, so a true lift smaller than the round trip could not be resolved either way.
- **Correction (PREREG item 1).** The transaction-version note was wrong at first: version-1 transactions exist, and the call now retries with version 1. No rule changed.

## Plain words
We tested buying a big Solana meme when its perp shorts looked crowded (very low funding and high open interest) and its price had just broken its 6-hour high, then selling 6 hours later. Under the exact registered rules, a data-quality check tripped on tiny dust trades, so the official answer is "unresolved". With that check fixed in advance and run as a new trial, the trade lost about 0.7% each time after costs, over 238 trades on 195 days. It did beat ordinary breakouts of the same coins by about 0.3 points, but not reliably. Even the best variant without the open-interest filter, which did select slightly better entries, still lost money after costs. By the registered rules this idea is **killed** as a spot trade. Nothing here supports a forward test.
