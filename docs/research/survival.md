# What separates surviving graduates from look-alikes that die (RES-5)

Task RES-5, owner's go 2026-10-04 about 5:15 PM (Melbourne). **Research only: nothing from this card goes into the bot or the app.** Every result here is **exploration, not proof**.

Sections 1–6 are fixed before any data is read (the commit that adds them holds no result). Later changes go in §8 with their date and reason, and every feature or rule tried is counted.

## 1. Label (fixed before data)

A graduate is a canonical PumpSwap pool with a SOL quote, not mayhem, whose migration (`CompletePumpAmmMigrationEvent`) is in the data. For a decision at age *a* after migration, the label is read at **T = migration + 24 h** for a = 60 min and 240 min, and at **T = migration + 48 h** for a = 24 h, so the label always lies at least 20 h after the decision.

**Survivor** at T, all three:
1. **Liquidity:** the pool's real quote vault is ≥ **30 SOL** (a fresh graduate starts with about 67.4 SOL real).
2. **Price:** the spot price is ≥ **0.5 ×** the migration price (the price before the first swap after migration).
3. **Still trading:** at least one swap in the hour before T.

Otherwise **not a survivor**. Also recorded, for description only: **rug** = price ≤ 0.1 × the migration price at T.

**Censored** (left out, counted) when T lies past the last row read, or past the holdout wall (2026-09-21T14:00Z, RES-3's wall): a label never reads a row at or after the wall.

The label is computed by the outcome stage (`packages/backtest/src/research/survival-outcome.ts`), which the feature stage never imports (a test checks this). The pure label rule (`survival-label.ts`) is shared: the feature stage may apply it only to **other** graduates whose T has already passed at the decision time (creator history and the market's survival rate); a test checks that it is never asked about a T after the moment being decided.

## 2. Features (as of the decision; at most 15)

Each is computed from rows released before the decision, at ages 60 min, 240 min and 24 h after migration. Holder and wallet features use trade flows only: token transfers are not in the data, so a wallet that moves tokens away looks like a seller.

| ID | Feature | Owner's list item |
|---|---|---|
| s_indep60 | wallets that bought and did not sell in the last 60 min | independent new buyers |
| s_new60 | of those, wallets never seen trading this mint before the last 60 min | independent new buyers (fresh) |
| s_bundle | share of supply bought in the creation slot | same-funder clusters (proxy: funders are not in the data) |
| s_top10 | supply held by the 10 largest net buyers now | top-holder share |
| s_top10chg | s_top10 now minus 60 min ago | top-holder share trend |
| s_devnet | creator's net tokens bought minus sold ÷ supply | creator selling |
| s_early_sold | share of the first 20 curve buyers' tokens they no longer hold | early-wallet selling |
| s_liqmig | quote vault now ÷ at migration − 1 | pool quote-vault trend |
| s_liqchg60 | quote vault now ÷ 60 min ago − 1 | pool quote-vault trend (short) |
| s_c2g | log minutes from creation to migration | time to graduate |
| s_net60 | (buy SOL − sell SOL) over 60 min ÷ quote reserve | net flow |
| s_ret60 | log price change over 60 min | (reversal evidence, edge.md) |
| s_creator_surv | share of the creator's earlier graduates that survived (labels already matured) | creator's past survivors |
| s_creator_rugs | number of the creator's earlier graduates labelled rug (matured) | creator's past rugs |
| s_market_surv | share of graduates whose label matured in the last 24 h that survived | the market's daily survival rate (regime) |

15 features × 3 decision ages = **45 feature tests**, all counted.

## 3. Method against hindsight

- **Look-alikes:** at each decision age, graduates are put in strata by what they looked like then: market cap (< 300, 300–1,000, 1,000–3,000, ≥ 3,000 SOL) × real quote vault (< 20, 20–50, 50–150, ≥ 150 SOL). Survivors are compared only with losers in the same stratum, never with all losers.
- **Per feature:** split at the median of the find-days (below), fixed before the check-days are read. Report:
  - the survival rate with the feature high and the base rate at that age, with Wilson 95% intervals;
  - the stratum-matched risk difference (Mantel–Haenszel weights), with a 95% interval from a day-block bootstrap (2,000 resamples).
- **Multiple tests:** Holm across all 45 on the check-days. A feature "held up" only if its check-day matched difference has the same sign as on the find-days and passes Holm.

## 4. Data split

- Only practice days before RES-3's wall (2026-09-21T14:00Z); a holdout day is never read. The wall guard (`practice.ts`) covers both stages.
- **Find-days:** the earliest two thirds of the labelled days; **check-days:** the latest third. Days used to find a feature never count in its check.
- With the early-look days only (09-20, 09-21), nothing can be checked: the 24 h label leaves 09-20 graduates up to about 13:30 UTC labelled, so phase B on those days is description only.

## 5. Comparison with what we have

On the check-days, with one exit for every rule (STATS-1's triple barrier through `outcome.ts`: B2, 120-min time stop; B1, +50% / −20% / 120 min as a second line), conservative fills, and rent per RENT-1 (`rentModel: 'rent-1'`, the same scoring as RES-4's cost math: seeded draws; the rent comes back when the sell-and-close lands with no dust, 90% × 95% = 85.5%, and a close that fails without dust pays one more failed exit):
- **Survival-filtered rule:** at the decision age, enter only graduates whose held-up features (at most two, chosen on the find-days) point to survival; U2 hard-reject proxies applied as in RES-3.
- **RES-4's H1, H2, H5, H6** (feature rules) and **S0** (every eligible candidate). H3 and H4 use BT-2's own rule kinds, which this harness does not evaluate; they come from BT-2's runs.
- Measures: entries, win rate, mean and median net return, profit factor (gross wins ÷ gross losses), each with a day-block 95% interval; the paired difference against S0 and against the best RES-4 rule on the same days.

## 6. What comes out

- Plain statement: does a survival-filtered rule beat what we have, by how much, with intervals, or not.
- At most 2–3 ideas proposed as candidates for a future registration. None is registered or implemented here: adding one to the study later is a counted trial and, after registration, needs a new holdout window.

## 7. Known limits

- No transfers and no funding links in the data: clusters and holder shares are trade-flow proxies.
- s_creator_surv, s_creator_rugs and s_market_surv see only graduates in DATA's sample; they are rates within the sample.
- One exit design for every rule; the bot's real exits (policy per universe) may score differently.
- Days are few: with the practice days DATA-1 publishes (09-21 back to 08-29), a feature needs a large effect to pass Holm across 45 tests.

## 7a. Code and how to run

`packages/backtest/src/research/`: `survival-label.ts` (the pure label rule), `survival.ts` (feature stage), `survival-outcome.ts` (labels, second pass), `survival-analysis.ts` (split, strata, Mantel–Haenszel, Wilson, day bootstrap, Holm, trade measures), `survival-compare.ts` (the survival rule, RES-4's feature rules, comparison with S0), `survival-cli.ts`. Tests: `packages/backtest/test/survival.test.ts` on a synthetic market with known fates (`survival-fixture.ts`): label thresholds, a label time after "now" refused, creator and market history only from matured labels of other graduates, a planted future swap moves no earlier feature, no outcome import in the feature stage, labels per fate and censoring, the wall in both stages, RENT-1 refund, a Simpson's-paradox case and a hand-computed Mantel–Haenszel weight, a planted feature holding up after Holm while noise does not, the trade measures, the CLI.

```
node packages/backtest/src/research/survival-cli.ts --dataset <DATA dir> --sol-usd <SOL/USD series> [--out research/survival]
```

## 8. Changes to the plan

- 2026-10-04, before any data was read, while building:
  - The comparison (§5) runs at the study's own decision points: U2 rules (H5, S0's U2 part) at 60 and 240 min, U1 rules (H1, H2, H6, S0's U1 part) at 24 h, on decisions that pass RES-3's base filters for that universe. BT-2 checks every minute (U2) or 5 minutes (U1), so its numbers will differ; this is a like-for-like comparison among rules, not BT-2's backtest.
  - The market survival rate leaves out the graduate's own label.
  - The outcome stage now waits for the exit ladder in slots, not in wall-clock seconds, so a ladder is fully observed whatever the slot time (found on the 10-second-slot test market, where trades were wrongly censored).

## 9. Results

Pending: phase B starts with DATA-2's early-look days.
