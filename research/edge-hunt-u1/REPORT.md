# EDGE-HUNT-U1 report

2026-10-07, 2:30 AM Melbourne. Exploratory screen on candles; method and reproduction in [README.md](README.md).

## Headline

**Money-making: no.** None of the four pre-registered U1 rules makes money after the bot's real costs at $2.

- **Wide U1 (pool quote ≥ 100 SOL).** Every rule loses money, and the two with enough trades lose clearly:
  - H1 dip-reversal: −5.0% a trade (95% CI −6.7% to −3.2%, 151 trades, 53 coins).
  - H6 dip-reversal with SOL up: −6.3% a trade (95% CI −9.1% to −3.7%).
  - Before any cost, H1 is already −0.8% a trade: the dip keeps falling, so no cheaper venue or bigger size rescues it.
- **The bot's own U1 (H8's $50k quote floor).** There are too few trades to call: 7–13 per rule, from 5–6 coins.
  - The means sit between −3.8% and +0.1% a trade.
  - Every 95% upper bound is below +3.7%, so the +5% edge the proof needs is not there either.
- **No candidate.** The pre-committed selection rule (n ≥ 30 and a positive screen mean) picked none, so this study's
  holdout (Melbourne 2026-09-12 to 09-21) was never read. It stays clean for a later test.

What would change the answer is below ("What would change it"). In short: only universe B is still open. Settling it
needs about 12× more data (the full graduation list instead of an 8% sample), not a new rule.

## Data

| Step | Count |
|---|---|
| Successful pump.fun migrations, 2026-08-02 14:00Z → wall (public RPC) | 74,703 |
| Uniform 8% random sample by sha256(signature) | 6,229 |
| … USDC-quoted pools (outside U1) | 317 |
| … pools with under 1 SOL of quote at migration (junk, cannot reach 100 SOL) | 1,677 |
| … other / failed decodes | 221 |
| SOL pools old enough for day 1 before the wall | 3,857 |
| Priced on GeckoTerminal (busy pools + 10% random audit + the first 408) | 809 (7 not indexed) |
| Pools with any U1 hour | 207 |
| Pools with U1 checks in the screen window (entries 2026-08-17 → 09-11, 26 days) | 117 |
| … of which any check had an ATR wide enough for the 15% stop | 74 |
| U1 checks in the screen window / with an ATR / ATR wide enough | 76,352 / 34,645 / 9,258 |

Survivorship: the sample is drawn from every migration transaction before anything about the coin is known, and coins
that later died stay in. The audit subset shows the busy-only shortcut lost no trades (README, universe notes).

## Screen results ($2, SOL, conservative fills)

Mean, median and 95% CI are net return per trade on the $2 notional, in SOL terms. The CI resamples whole coins
(4,000 resamples). Gross = mean price move on the final exit leg, before costs. Days = distinct UTC days with an entry.

| Trial | n | coins | days | win | mean | median | 95% CI | gross | DSR |
|---|---|---|---|---|---|---|---|---|---|
| H1-A dip-reversal | 151 | 53 | 27 | 26% | **−5.03%** | −5.59% | [−6.7, −3.2] | −1.50% | 0.00 |
| H2-A quiet accumulation (proxy) | 68 | 32 | 25 | 19% | **−3.07%** | −4.62% | [−6.1, +1.5] | +1.94% | 0.00 |
| H3-A range breakout (proxy) | 9 | 7 | 7 | 11% | −2.17% | −2.66% | [−3.2, −0.8] | +0.81% | 0.00 |
| H6-A dip-reversal, SOL up | 114 | 47 | 23 | 24% | **−6.25%** | −6.21% | [−9.1, −3.7] | −2.69% | 0.00 |
| H1-B | 13 | 6 | 10 | 38% | −0.95% | −1.56% | [−4.5, +3.6] | +2.46% | 0.00 |
| H2-B | 8 | 5 | 7 | 25% | −3.77% | −2.42% | [−8.2, +0.4] | −0.18% | 0.00 |
| H3-B | 7 | 6 | 5 | 0% | −2.69% | −2.66% | [−3.5, −1.9] | +0.70% | 0.00 |
| H6-B | 10 | 6 | 9 | 40% | +0.14% | −1.02% | [−3.0, +3.7] | +3.45% | 0.00 |
| S0-A random U1 entry (control) | 44 | 34 | 23 | 32% | −3.68% | −4.28% | [−7.3, −0.2] | −0.47% | — |
| S0-B (control) | 7 | 6 | 6 | 43% | −0.51% | −2.02% | [−5.3, +2.4] | +2.78% | — |

Total over the screen, all at $2: H1-A −0.168 SOL, H6-A −0.156 SOL, H2-A −0.044 SOL (`results/screen_sim.json`).

- **Luck control.** 8 trials were counted (H1, H2, H3, H6 × A, B; `trials.json`). The deflated Sharpe ratio is 0.00
  for all of them. PBO (CSCV over 8 day-blocks, 70 splits) is 0.20, but it means little when every trial loses.
- **Against random entry.** H1-A and H6-A do worse than entering U1 at random (S0-A −3.7%): the dip filter picks
  worse entries, not better ones. That matches empirical.md's finding that weakness after migration keeps going.
- **Exits.** Of H1-A's trades:
  - 46% ended on the 30-minute flat rule and 25% on the 5-minute negative-flow rule.
  - 15% were stopped out, 13% took the half-profit and then trailed out or hit break-even.
  - The win rate (26%) is far below the about 48% a +20/−10 bracket needs at $2 (edge.md table).

## Cost diagnostics (never used for selection; `results/cost_diag_screen.json`)

The same rules run with other cost settings. Exits depend on costs, so the trade lists differ slightly between columns.
That is why H1-B's "no costs" column is worse than its $2 column (13 trades, 6 coins: one coin moves it).

| Trial | no costs | $2 | $5 | $20 |
|---|---|---|---|---|
| H1-A | −0.83% [−2.5, +1.0] | −5.03% | −3.80% | −3.34% [−5.1, −1.5] |
| H2-A | +1.07% [−2.0, +5.8] | −3.07% | −1.85% | −1.40% [−4.4, +3.2] |
| H3-A | +2.58% [+0.2, +5.0] | −2.17% | −0.87% | −0.29% [−1.4, +1.2] |
| H6-A | −1.96% [−4.9, +0.5] | −6.25% | −5.05% | −4.61% [−7.5, −2.1] |
| H1-B | −4.04% [−13.4, +5.2] | −0.95% | +0.31% | +0.88% [−2.7, +5.5] |
| H6-B | −5.00% [−19.5, +5.2] | +0.14% | +1.39% | +1.96% [−1.2, +5.6] |
| S0-B | +3.22% [−2.1, +6.4] | −0.51% | +0.87% | +1.52% [−3.6, +4.6] |

## Honest limits

- **Candles, not transactions.** f_2side60 (H1, H2), f_indep60 (H2) and holder growth (H3) cannot be seen on candles,
  so they were left out. These rules are therefore looser than registered.
  - A stricter filter could select differently. But H1's loss comes from the price path itself, which no wash-share
    filter changes. Also, without the omitted filters H1-A already fails with n = 151.
  - H2 and H3 are proxies and stay exploratory.
- **Fills.** Entry at the close of the next 1-minute bar. Stops fill at the lower of the stop and the next open. Exit
  rules are judged on 1-minute bars, not on every trade. The real bot reacts within seconds, which could help or hurt.
  This was not measured.
- **Costs.**
  - Fee tiers come from the 2026-10-03 snapshot, applied to August–September. Fees before B3 (09-09) may have differed.
  - The fixed costs are edge.md's conservative scenario.
  - Not modelled: deployer-sell exits, risk sizing (`evaluateEntry`), and the portfolio limits (1 open position,
    3 entries a day). Those limits would only drop trades; they cannot turn a loss per trade into a gain.
- **Quote reserve.** It is the constant-product proxy √(k·p) from migration reserves. LP fee growth makes the real
  reserve slightly larger, so U1 membership is slightly understated. A liquidity deposit would break the proxy; none
  was checked.
- **Size of B.** 5–6 coins. The coin-cluster CI is fragile with that few clusters. The sample is 8% of graduations; at
  100% the B screen would have about 90–160 trades per rule.
- **Days.** 26 screen days (2026-08-17 → 09-11), one market stretch: SOL/USD rose from about $75 to $110 (Aug 27), then ended near $105.
  - Coverage of the B3/B4 regime boundaries is partial.
  - 2026-10-02 (B5) and the sealed holdout (from 09-22) were never read.
- **Power.** The per-trade SD is 12% for H1-A, so 43 trades detect a +5% edge with 80% power. With 151 trades H1-A is
  well powered, and its result is a clear no. For B the SD is about 6%, so about 11 trades would be enough in theory,
  but 6 coins is too few clusters to trust that.
- **GeckoTerminal.** It can re-index. `manifest.json` (939 files, aggregate sha256 3ca21fec…) pins the exact bars used.

## What would change it

- **Size.**
  - Universe A: no. At $20, H1-A is still −3.3% and H6-A −4.6%, because there is no edge before costs.
  - Universe B: at $20, H1-B and H6-B are +0.9% and +2.0%, with CIs that span zero. That is not enough for the +5%
    bar either, and only the owner can raise size.
- **Venue.** A cheaper pool (0.30% non-canonical, refused by H5) would cut about 1.8% from a round trip. H1-A would
  still lose (−0.8% gross). H3 shows a small gross edge (+2.6%, 9 trades) that a cheaper venue might turn positive,
  but 9 trades prove nothing.
- **Holding time.** Most exits come from the 30-minute flat rule and the 5-minute negative-flow rule. A different
  horizon or exit is a new hypothesis. It would need a new pre-registration and a never-run window; the sealed holdout
  from 09-22 is reserved for the formal proof.
- **The one open question is universe B.** H1-B, H6-B and S0-B sit near zero after costs with very few coins.
  - Settling it means pricing the full graduation list instead of 8%.
  - Cost: about 70,000 more public-RPC calls (about 20 hours at about 1 a second) and about 3,000–4,000 GeckoTerminal
    calls (about 3–4 hours).
  - That is a data job, not new research. Even then, a positive B result would be about 6 entries a day across the
    whole market before the bot's 3-a-day limit.

## How it would run in the bot

Not applicable: no rule survived the screen, so nothing was taken to the holdout and nothing is proposed for the bot.
The bot keeps abstaining in U1, as edge.md §4 foresees.

Estimated entries a day, for planning only (8% sample scaled to 100%, before the portfolio limits):
- H1-A: about 73 a day.
- H1-B: about 6 a day.
- H6-B: about 5 a day.

## Files

- `trials.json`: the trial list, the selection rule and the holdout verdict, committed before results (2e83460).
- `results/screen.json`: the table above, with DSR and PBO.
- `results/screen_sim.json`: per-trial summaries with exit reasons and SOL totals.
- `results/cost_diag_screen.json`: the cost diagnostics.
- `results/trades/*.json`: every simulated trade.
- `manifest.json`: sha256 of every input file.
