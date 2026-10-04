# Signal research on practice days (RES-3)

Task RES-3, started 2026-10-04 (Melbourne). Goal: find, on the **practice days only**, which as-of signals separate positive from negative net return after full costs, and hand BT-2 at most **one candidate configuration per universe** (U1, U2) to pre-register before the sealed holdout is opened. U3 is out (RES-2: whale copy-trading lost about 11% a trade, 0 of 120 variants positive).

Sections 1–7 are the **pre-registered plan**. They were written and committed before any practice-day row was read (the commit that adds this file has no result in it). Any later change to them is listed in §8 with its date and reason, and every trial it adds is counted. Results go in §10 only.

## 1. Data and the holdout wall

- Decision window: 2026-08-03 to 2026-10-01 (60 days, ARCHITECTURE.md §6.5). DATA-1 adds a 14-day lead-in from 2026-07-20, which features may read as history (never as decision days).
- **Days are Melbourne days** (AEST/AEDT), as in the STATS-1 registry and the reports. Dataset files are UTC days: a file is opened only if it ends at or before the wall's instant (Melbourne midnight), so a UTC day that straddles the wall stays unread.
- The holdout is the latest days of the window, set by BT-2 in the STATS-1 registry. **RES-3 never reads, loads or computes anything on a holdout day**, and never on the embargo day before it.
- Practice days = decision days strictly before `holdoutFrom − embargo`. The wall is 10 h before the holdout's first UTC instant, longer than the 2 h horizon plus the exit ladder (ARCHITECTURE.md §13.2).
- The wall is in code: `packages/backtest/src/research/practice.ts` loads the boundary from `research/signals/window.json`, refuses any holdout or embargo day before a file is opened, and throws if any row at or after the wall reaches the analysis. A guard test plants a holdout-day row and expects the refusal.
- **The wall is the start of Melbourne day 2026-09-22 (2026-09-21T14:00Z)**, 10 h before the sealed holdout (UTC days from 2026-09-22 to the 2026-10-20 entry cutoff, with the tail to 2026-10-21; `RESEARCH_CONFIG.holdout`, DECISIONS sealed-window ruling @ a947f0f, supervisor 2026-10-04). `window.json`: holdoutFrom 2026-09-23 (Melbourne), embargo 1. A test pins it. In code, a run can never use a later wall than the committed `window.json` (a later `--window` file is refused). The wall must always agree with `RESEARCH_CONFIG.holdout.fromDay`; when BT-2's holdout store exists (`RESEARCH_CONFIG.holdout.registryPath`, research/holdout/registry.json, or `--registry`), it is read with BT-2's reader and its plan's `fromDay` and every registered entry's `fromDay` must agree too, or the run is refused (`wall.ts`). A missing store does not block: the config date holds.
- A candidate whose outcome window (decision + 120 min horizon + exit ladder) would reach the wall is dropped (purge at the wall), and so is one whose hold would cross a regime boundary (BT-2's rule).
- BT-2 (2026-10-04, `study-1`, PR #41): holdout UTC days from 2026-09-22 to the 2026-10-20 entry cutoff, tail to 2026-10-21; practice ends 2026-09-21 14:00 UTC (the start of Melbourne 22 Sep). BT-2's registry plan (`holdout.fromDay` 2026-09-22) agrees.

## 2. Universes and decision points

Both universes take canonical PumpSwap pools with a SOL quote, not mayhem (H5), as the backtester's Market sees them (`CreatePoolEvent` checked against the canonical PDA).

| Universe | Decision points | Base filters (proxies of GATE-1 that the dataset supports) |
|---|---|---|
| **U2** post-graduation reclaim | Every migration (`CompletePumpAmmMigrationEvent`), at fixed ages **60, 120 and 180 min** after migration (3 decisions a mint; fixed, not tuned) | H8: quote at migration ≥ 5 SOL and effective quote reserve in USD ≥ the policy floor (max of $15k and 1,000 × size); H9: creation to migration ≥ 5 min (creation must be in the data, else unknown → excluded); H10: ≥ 60 min since migration; H11: price at +5 min not above the migration price, and no 1-min candle up > 25% (high ÷ open) in the last 3 min. All thresholds read from the policy, none in code |
| **U1** survivors | A fixed UTC grid every **4 h** (00, 04, …, 20 UTC); every pool aged 24 h–14 days since migration at that moment is checked | Effective quote reserve (vault + virtual) in USD ≥ $50k (GATE-1's H8 reading with policy `u1FloorUsd`), market cap (spot price × supply) ≥ 1,470 SOL, migration seen in the data, no 1-min candle up > 25% (high ÷ open) in the last 3 min |

The universe without any signal filter is the **base** rule; it plays the role of S0 (the same candidates, no selection). A rule counts only if it beats base.

GATE-1's full hard rejects (H12, H13 holders and insiders, H14 deployer index, H15/H16 live vetoes) are applied by BT-2 in the engine run, not here. The features below include trade-flow proxies of H12–H14 so their effect is measured.

## 3. Features (all as-of the decision moment)

Each feature is a pure function of rows released before the decision moment (`SignalTracker` in `packages/backtest/src/research/tracker.ts`). The driver releases rows in chain order and asks for features only between rows; asking about a moment earlier than the last released row throws, so future rows cannot leak in. Unknown inputs give `null`, and a `null` feature never passes a rule (abstain). Windows are measured on block time.

Price is the pool's spot price (quote reserve incl. virtual quote / base reserve). Buy and sell SOL are the traders' quote amounts, fees included.

| ID | Feature | Group | Evidence it may matter |
|---|---|---|---|
| f_net15 | (buy SOL − sell SOL) over the last 15 min ÷ quote reserve | Flow | §7.2 item 1, risk.md S1/S2 |
| f_net60 | the same over 60 min | Flow | same |
| f_bsr15 | buy SOL ÷ (buy + sell SOL), 15 min | Flow | same |
| f_indep60 | buyers in 60 min who did not also sell in that window | Flow, wash | §7.2 items 1, 3, 5 |
| f_size15 | mean SOL per trade, 15 min | Flow | §7.2 item 1 (raw counts are inflated) |
| f_trades15 | trade count, 15 min (log1p) | Activity | |
| f_ret15 | log price change over 15 min | Momentum | empirical.md Q2–Q3 |
| f_ret60 | log price change over 60 min | Momentum | same |
| f_dd | price ÷ highest price since migration − 1 | Flush | U2 hypothesis "flush" |
| f_vwap | price ÷ VWAP since migration − 1 | Reclaim | U2 hypothesis "reclaim of VWAP" |
| f_hl | 1 if the lowest price of the last 30 min is above the lowest of the 30 min before it, else 0 | Higher low | U2 hypothesis |
| f_vol60 | standard deviation of 1-min log returns, 60 min | Risk | |
| f_liq | log of quote reserve (SOL) | Liquidity | H8, R12 |
| f_liqchg60 | quote reserve now ÷ 60 min ago − 1 | Liquidity | liquidity pulls (safety.md) |
| f_age | minutes since migration (log) | Age | §3.2 |
| f_2side60 | share of SOL volume from wallets that both bought and sold in 60 min | Wash | §7.2 item 3 |
| f_top60 | share of SOL volume from the single largest wallet, 60 min | Concentration | §7.2 item 3 |
| f_c2g | log minutes from creation to migration | Launch | H9, empirical.md Q2 |
| f_devnet | creator's net tokens bought minus sold (curve and pool) ÷ supply | Insider | H12, H13 (trade-flow proxy; transfers are not in the data) |
| f_bundle | share of supply bought on the curve in the creation slot (all wallets, creator included) | Bundle | H13, §7.2 item 2, MELT (§9) |
| f_top10 | supply held by the 10 largest net buyers (trade flows only) | Concentration | H12 proxy |
| f_dep24 | mints the creator launched in the 24 h before this mint's creation | Deployer | H14 |
| f_grad24 | migrations seen in the last 24 h (all mints in the data) | Regime | §6.4 |
| f_sol24 | SOL/USD log change over 24 h (off-chain series as of the decision) | Regime | §6.4 |
| f_liqmig | quote vault now ÷ quote vault at migration − 1 | Liquidity | §9: depth collapses within a day |
| f_turn60 | SOL volume over 60 min ÷ quote reserve | Activity | §9: reversal in small coins is tied to low volume |
| f_early_sold | share of the tokens the first 20 curve buyers bought that they no longer hold (trade flows) | Insider | §9: MELT, early buyers sell into the pool |

27 features (the last three added from the literature pass before any data was read, §8). FACTS-1's producers replace the trade-flow proxies (f_devnet, f_bundle, f_top10, f_dep24) when they land; a feature that changes definition is a new feature and a new trial.

## 4. Outcome

The outcome stage (`outcome.ts`) runs after the feature stage and is never imported by it (an import-guard test checks this). It replays the pool's real swaps after the decision through CORE-2's exact pool maths (`ShiftedPool`, so our own trade moves the pool) and labels each candidate with STATS-1's execution-aware triple barrier (`labelTripleBarrier`).

- Size: the policy's `capital.minNotional` ($2 trial setting), converted at the SOL/USD as of the decision. Quotes are exact at that size.
- **Conservative scenario** (`FILL_CONFIG.scenarios.conservative`): entry lands 6 slots after the decision, discovery and landing at the p90 values, executed shortfall × 1.5, land probability 66% on PumpSwap (one entry attempt; a failed attempt pays base + priority fee and the decision returns that loss), token-account rent **not** recovered, take-profit judged on the slot's value (close), exits on the policy ladder (5 attempts, 6 slots apart, each failed attempt pays base + its rung's priority fee).
- Fixed costs per trade: base fee and priority fee per transaction, the 5,000-lamport tip per landed transaction, token-account rent 1,513,840 lamports.
- Exit attempts use the labeller's single cost per failed attempt: base fee + the third ladder rung's priority fee (150,000 lamports), above the first two rungs (conservative bound). A landed exit pays base + the first rung's priority + the tip. The scenario's extra slippage (× 1.5) also applies to the exit: the shortfall between the value at the touch and at the fill is scaled. Value is the slot's close for every scenario.
- Every barrier sees the same exit-attempt draws (common random numbers), so barriers differ only by their rule.
- A decision with no quote at the decision slot is not a trade and is left out (the bot would not sign).
- Barrier configurations (every one is a trial):
  - **B1 (primary): take-profit +50%, stop −20%, time stop 120 min** (policy `tMaxMs`).
  - B2: time stop only, 120 min (no take-profit, stop at −100%).
  - B3: take-profit +30%, stop −15%, time stop 60 min.
- `r_net` = net SOL return ÷ entry cost, all costs. Unobserved windows are censored, never 0.
- Base-scenario results are reported beside the conservative ones for context; **decisions use conservative only**.

## 5. Folds and selection

- Practice days are split into **K = 5 contiguous day blocks** of equal size (the last block takes the remainder).
- **Primary: expanding walk-forward.** For k = 2..5, rules are chosen on blocks 1..k−1 and applied to block k. The last embargo day before the test block is dropped from the training set, which also purges every training candidate whose outcome window could reach into the test block (training is always earlier, so nothing after the test block is used).
- **Secondary: PBO by combinatorially symmetric cross-validation** (STATS-1 `probabilityOfBacktestOverfitting`, S = 10 day blocks, or the largest even number ≤ the day count), over base and every single-condition rule, on daily P&L (sum of `r_net`; a day without a trade is 0).
- Rule family (fixed): a filter on the base universe made of one or two conditions `feature ≥ t` or `feature ≤ t`, with `t` at the training set's 20th, 40th, 60th or 80th percentile (216 single conditions; a second condition is chosen greedily from the same 216 given the first, so at most 432 rules plus base per universe, barrier and fold).
- Selection score on the training set: the one-sided 95% lower bound of mean `r_net`, mean − t₀.₉₅,D−1 · SE with the same day-clustered (CR1) SE that STATS-1's bootstrap studentizes, among rules with ≥ 30 trades on ≥ 5 days. Deterministic, so the choice does not depend on a seed. Reported intervals use STATS-1's day-block bootstrap-t (2,000 resamples). Ties: fewer conditions, then the lower feature ID.
- Out-of-sample result of the **procedure** = the trades its chosen rules select in the test blocks, pooled. This is the estimate BT-2 can expect; the in-sample score of the final rule is never reported as performance.
- Univariate view (descriptive, also counted): for each feature, the Spearman correlation with `r_net` and the mean `r_net` per training-quintile, with day-block bootstrap 95% intervals, Holm-adjusted across the 27 features. Its top and bottom quintiles are written to the trial registry as trials too.

Every rule evaluated in every fold, universe and barrier is written to the trial registry (`research/signals/trials.jsonl`: id, definition, fold, n, mean). The deflated Sharpe ratio is computed once, after every universe and barrier ran, against the registry's selectable trials (≥ 30 trades on ≥ 5 days; rules below the minimums can never be picked and their few-trade Sharpe ratios would only inflate the variance); the total trial count is reported beside it. The check is strict: the registry's Sharpe variance includes real differences between rules, so a family holding many variants of one strong rule raises its own benchmark (a test shows a planted +30% a trade edge failing it). It is G1's rule and stays.

## 5a. Regimes

UPG-1b (PR #44, venues.md §2.7) found three platform changes before the holdout: **B2 2026-07-21** (BOOST), **B3 2026-09-09** (fee config), **B4 2026-09-12** (holder rewards, a fee and layout change). The sealed holdout lies after B4, so only post-B4 economics match today. Each decision is tagged with the regime in force at its instant, from the exact boundary times in ARCHITECTURE.md §6.5 (B2 2026-07-21 14:23 UTC, B3 2026-09-09 19:30 UTC, B4 2026-09-12 15:24 UTC, B5 2026-10-02 15:47 UTC; `regimes` in `research/signals/window.json`). The **latest regime** is taken from the window, not from the data: the last boundary before the last decision day ends, which is B4 (B5 governs no decision day). Costs are as-of per swap: every fee comes from the swap row itself.

Every result is reported per regime: base mean, the final rule's mean, and the walk-forward out-of-sample mean and count. A signal must hold in all of them (§6 check 7).

## 6. Stopping rule and what is handed to BT-2

**One configuration per universe.** The barriers are tried in the fixed order **B1 → B2 → B3**; the first whose verdict passes every check below is handed over and later ones are not considered. The candidate is the rule the procedure picks on **all** practice days with that barrier, with its exact thresholds (`research/signals/handoff.json`, one entry per universe, with BT-2's `edgePpm`: the out-of-sample one-sided 95% lower bound in ppm, and `medianTargetBps`: the median out-of-sample winner; if BT-2 uses it as a take-profit, that counts as a trial in BT-2's registry). BT-2's `U1Rules`/`U2Rules` are fixed shapes; a feature-filter rule needs BT-2 to add a matching rule kind or map the conditions, which BT-2 decides. A verdict passes only if **all** of these hold on the pooled walk-forward out-of-sample trades (conservative scenario):

1. Mean `r_net` > 0 at the one-sided 95% day-block lower bound.
2. The paired difference against base on the same days > 0 at the one-sided 95% lower bound.
3. Deflated Sharpe ratio ≥ 0.95 and PBO ≤ 0.25 from the registry. Both are RES-3's own screen and descriptive for the proof: the proof's G1 gates on SPA (owner, 2026-10-04), never on this DSR.
4. ≥ 100 out-of-sample trades on ≥ 10 days.
5. Top 1% of trades ≤ 50% of P&L; no day > 25% of P&L; `y_severe` ≤ 10%; blocked exits ≤ 5%.
6. The rule chosen in each fold uses the same feature group as the final rule in at least 3 of 4 folds (stability).
7. Regimes (§5a): in every regime with ≥ 3 practice days, the final rule's mean `r_net` is above base's (the improvement has the same sign in every regime with data); and in the latest regime (B4, from the window) the walk-forward out-of-sample trades number ≥ 30 with a mean above 0. Too few post-B4 trades, zero included, fails this check: evidence from older economics alone is not enough.

Otherwise the answer for that universe is **"no reliable signal"**, stated plainly, and no candidate is handed over (the bot keeps abstaining in that universe).

Stopping: one main run when the supervisor says the practice days are in. At most **one** further round, only on newly arrived practice days and only with additions written into §8 before that run; all trials of both rounds count. No feature, threshold grid, barrier or fold change after a result has been seen, except as such a recorded round. Then RES-3 stops, whatever the result.

## 7. Known limits (stated before the run)

- Holder and insider features come from trade flows; token transfers are not in the dataset, so f_devnet, f_bundle and f_top10 are proxies.
- One entry attempt per decision, as in S0; the live bot may retry.
- The 60-day window holds roughly 2.6% graduations of ~50k launches a day, sampled by mint hash (DATA-1); the U2 sample per day depends on that sample rate.
- f_dep24 and f_grad24 count only mints in DATA-1's hash sample, so they scale with the sample rate (fine as a ranking within the data, not as absolute counts).
- Only eligible candidates are scored; rejected ones keep their reject reasons and features but get no label in this study (§13.1's audit of rejects is BT-2's run).
- **Few post-B4 practice days.** Post-B4 practice runs from 2026-09-12 15:24 UTC to the wall, about 8.9 days; check 7 needs ≥ 30 out-of-sample trades there, which may not be reached. Most practice evidence is from B2, whose economics no longer match today's.
- Practice-day results say nothing final: only BT-2's sealed holdout is proof (pre-funding item 6).

## 7a. Code and how to run

`packages/backtest/src/research/`: `practice.ts` (the wall), `tracker.ts` (as-of features), `candidates.ts` (decision points, base filters), `outcome.ts` (scoring stage), `analysis.ts` (folds, selection, registry, verdict), `cli.ts`. Tests: `packages/backtest/test/research.test.ts` (wall refusal on a planted holdout row, a planted future swap that must not move any earlier feature, as-of refusals, import guard, exact round-trip costs on a still pool, planted-signal and null-data selection, walk-forward embargo, CLI).

```
node packages/backtest/src/research/cli.ts --dataset <DATA-1 dir> --sol-usd <SOL/USD series> [--window research/signals/window.json] [--out research/signals]
```
Writes `research/signals/results.json`, `research/signals/handoff.json` (one configuration or "no reliable signal" per universe) and `research/signals/trials.jsonl` (the trial registry). `--window` may only move the wall earlier; `--registry <file>` gives the STATS-1 registry for a confirmed window.

## 8. Changes to the plan

- 2026-10-04, before any data was read (the data had not landed): written while building the code. U1 liquidity and the H8/H11 proxies now follow GATE-1's exact reading (effective quote reserve; candle high ÷ open); the selection score is the deterministic CR1 t-bound instead of a seeded bootstrap; PBO uses STATS-1's CSCV; exit-cost details, common random numbers and no-quote handling are written out (§4); three features added from the literature pass (f_liqmig, f_turn60, f_early_sold). No result existed when these were made.
- 2026-10-04, before any data was read: regimes added at the supervisor's request (§5a and check 7 in §6), after UPG-1b found boundaries B2, B3 and B4.
- 2026-10-04, before any data was read, after the PR #47 review: Melbourne days; default wall moved to the B4 day; the wall can never move later than the committed file, and a confirmed window must match the STATS-1 registry; regimes tagged by exact instant; one configuration per universe by the fixed barrier order; the DSR counts selectable trials and runs once on the full registry; the univariate quintiles are trials. Re-review: holds crossing a regime boundary are purged (BT-2's rule); a confirmed holdoutFrom must equal the registry's fromDay; the latest regime comes from the window (B4), B5 stored.
- 2026-10-04, review of #56 at afbf0f9: the registry check read a file shape BT-2 does not write, so it never ran. The wall is now checked against `RESEARCH_CONFIG.holdout.fromDay` always, and against BT-2's holdout store (read with BT-2's reader) when it exists. An earlier `--window` copy carries no ruling (`confirmedBy` null). The DSR is labelled descriptive in results.json (G1 gates on SPA).
- 2026-10-04, before any data was read: the wall set to the start of Melbourne 22 Sep by the supervisor's sealed-window ruling; a missing registry no longer blocks, a present one must agree.
- 2026-10-04, before any data was read: a U1-only 4 h time-stop barrier was proposed (f80ea8a) and withdrawn (67c20b1) because ARCHITECTURE.md §9 caps T_max at 120 min in phase 1. It never ran, so it adds no trial.

## 9. Literature and evidence

Literature pass by a RES-3 research helper, 2026-10-03; every number is from the primary page unless the row says otherwise.

Date: 2026-10-03. Scope: new or stronger sources beyond what `docs/RESEARCH.md` and `docs/research/*.md` already cite.
Already cited in the repo (not repeated as new, only confirmed or contradicted here): MELT/MemeTrans 2602.13480, Marino et al. 2602.14860,
Li et al. 2608.20271, Chen et al. 2603.24625 (SolRugDetector), Szwajcok et al. 2609.10246, Kamat 2607.02795 / 2607.02823 / 2609.18975,
Luo et al. 2601.08641, SolRPDS 2504.07132, Mongardini 2507.01963 / 2601.22185, Mancino 2512.11850, Cernera et al. 2206.08202,
Mazorra et al. 2201.07220, Solidus Labs 2025 rug-pull report, CoinGecko trader-profit pages, Barber et al. 2014.

Main finding in one line: **no published study measures forward returns for either U2 (60–240 min after migration) or U1
(canonical PumpSwap pools aged 24 h–14 d with ≥ $50k liquidity).** Every memecoin paper I found labels outcomes at or before
1 h after migration, or labels graduation itself. For U1/U2 we have to use evidence from nearby settings (small illiquid
coins, pump-and-dump episodes, DEX wash trading) and our own backtest.

### 9.1 Evidence table

Grades: A = peer-reviewed or reproducible with public data and code, on Solana/pump.fun 2025–2026; B = reputable on-chain
study or preprint with a clear method, or A-quality but older or another chain; C = blog/dashboard with partial method;
D = anecdote/marketing/unverifiable. "Opened" = I read the primary page (abstract, HTML or PDF) myself.

| # | Claim | Predictor | Direction & size | Population / period | Source | Grade |
|---|---|---|---|---|---|---|
| 1 | No post-1 h outcome is studied in the main pump.fun dataset | n/a (gap) | MELT labels risk on min price in the **first 20 min** after migration (high risk = min ratio < 0.3); features use only the first hour; no 6 h/24 h/7 d returns reported | 41,470 migrated pump.fun coins, 2024-12-01 to 2025-03-01 | [MELT v2, arXiv 2602.13480](https://arxiv.org/html/2602.13480v2) (opened) | A (old regime, pre-PumpSwap BOOST) |
| 2 | Concentration at migration marks dumps (confirms repo) | first-10/20 buyer share; bundle-adjusted concentration; launch duration; buyer count | High-risk coins: first 10 / 20 buyers hold **17 / 19 pp more**; bundle tracing raises measured concentration by **24 pp** (high risk) vs **6 pp** (low risk); shorter launch, fewer buyers, bigger average buys | same as #1 | [MELT v2](https://arxiv.org/html/2602.13480v2) (opened) | A |
| 3 | Pump-and-dump episodes reverse fast and almost fully | price/volume spike, pre-pump run-up | Reversal starts ~**70 s** after the pump; after **1 h most of the effect is gone**; run-ups before the pump suggest insider buying | Telegram-coordinated pumps on CEX coins, 2018 | [Li, Shin, Wang, JFQA (published)](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/abs/cryptocurrency-pumpanddump-schemes/97149DCD519BAF838F269F98DC76D682) (only search summary and listing seen; numbers not checked in text) | B (other venue, older) |
| 4 | Small, illiquid coins reverse week to week; large liquid coins trend | past 1-week return; distance from 1-week high; volume | Weekly reversal only in small/illiquid coins (**t = −7.31**); momentum in large/liquid (t = 2.33). Distance from 1-week high predicts returns **negatively for small/illiquid (t = −9.03)**, positively for large (t = 4.93). Reversal driven mainly by low volume | CEX-listed coins (sample size and period not stated in the abstract) | [Fičura 2023, FFA Working Paper 5:003](https://ideas.repec.org/p/prg/jnlwps/v5y2023id5.003.html) (abstract opened; sign convention of "distance" not checked in the full text) | B |
| 5 | Momentum lives in liquid coins; illiquid coins mean-revert | 14-day-ish past return × liquidity | Strong momentum in the most liquid coins; illiquid coins show reversal; long-only "illiquid losers + liquid winners" beat cap-weighted | CEX coins, to 2019 | [Begušić & Kostanjčar, arXiv 1904.00890](https://arxiv.org/abs/1904.00890) (abstract opened) | B (older, preprint) |
| 6 | Market, size and momentum explain crypto cross-section | size, momentum | Three factors price nine long-short strategies | CEX coins, 2014–2018 | [Liu, Tsyvinski, Wu, J. Finance 77(2) 2022](https://www.nber.org/papers/w25882) (abstract opened) | B (peer-reviewed, older, not DEX) |
| 7 | Most suspected pump-and-dumps die on day 0 | time since pool start; LP removal | Of 2,063,519 tokens launched in 2024, 873,957 (42.5%) on a DEX, **74,037 (3.59%) suspected P&D**; ~**94%** of those pools rugged by the pool creator; duration **median 0 days**, mean 6.23 days, 1% > 123 days. Criteria: creator removed ≥ 65% of pool liquidity (≥ $1k), pool inactive, > 100 txs before | all chains, 2024; no Solana split | [Chainalysis 2025 market-manipulation post](https://www.chainalysis.com/blog/crypto-market-manipulation-wash-trading-pump-and-dump-2025/) (opened) | B |
| 8 | Wash trading is common on DEXes and detectable from trades alone | self-trades, two-account round trips | ~**$159M** wash volume; **> 30%** of traded tokens hit; ~10% of EtherDelta tokens mostly wash traded | IDEX, EtherDelta (Ethereum), to 2020 | [Victor & Weintraud, WWW '21, arXiv 2102.07001](https://arxiv.org/abs/2102.07001) (opened) | B (peer-reviewed, other chain) |
| 9 | About half of new DEX tokens are scams | token/pool behaviour | ~10,000 scam tokens ≈ half of Uniswap listings; ≥ $16M taken from 39,762 victims | Uniswap V2, 2020–2021 | [Xia et al., arXiv 2109.00229](https://arxiv.org/abs/2109.00229) (abstract opened; peer-reviewed venue not confirmed on the page) | B |
| 10 | Wash-trading upper bound on DEXes 2024 | address heuristics | $704M (heuristic 1) to $2.57B combined upper bound | EVM + others, 2024 | [Chainalysis](https://www.chainalysis.com/blog/crypto-market-manipulation-wash-trading-pump-and-dump-2025/) (opened) | B |
| 11 | Persistent wallet "informativeness" exists on a public-ledger venue | wallet's past post-trade markouts | Rank correlation **0.52** across 10-day windows; adding top wallets lifts 1-second return R² by 13.2% (t = 9.2) | 147,113 wallets, $84.3B taker notional; venue not named in abstract (order-book DEX) | [Zhai, arXiv 2608.04373](https://arxiv.org/abs/2608.04373) (abstract opened) | B (other venue; horizon is seconds) |
| 12 | A paper-traded Solana memecoin bot's edge is fragile | hour of day; filter stack | 190 trades, mean +0.62%/trade, but **removing the top 3 trades (1.6%) makes it unprofitable**; worst-hour effect −11.6% vs +1.8%, **p = 0.56** (not significant). Of rejected tokens followed ≥ 6 h, **56.25%** hit a 50% drawdown | Solana DEX, 2026-03-29 to 04-12, paper fills vs aggregator quotes | [Kamat, arXiv 2606.08232](https://arxiv.org/abs/2606.08232) (PDF read in part; data on Zenodo 10.5281/zenodo.20043301) | C (single author, small n, paper fills) |
| 13 | Filter rules for rejecting DEX tokens: claimed net positive, but one tier failed validation | liquidity, age, holder-concentration filters | Save-to-miss ratio 3.7:1 by measured drawdown; "early-death" tier reached "gone" at **48.9% vs 57.6%** for other rejects (that is, no better than the rest) | Solana DEX, 2026-04-10 to 04-23, 2,402 rejection events | [Kamat, arXiv 2607.02830](https://arxiv.org/abs/2607.02830) (abstract opened) | C |
| 14 | pump.fun lifespans are short, but the measure misses PumpSwap | days to last curve trade | 68.67% die the same day; 80.37% within 0–1 day; 4.55% trade 90+ days. Graduates are **understated** (post-graduation trades not counted) | 18.67M pump.fun tokens, 2024-01-14 to 2026-06-18, Dune | [CoinGecko Research](https://www.coingecko.com/research/publications/average-lifespan-of-pumpfun-tokens) (opened) | C |
| 15 | Launch regime moves graduation rates 8× within weeks | platform incentive change (BOOST) | Graduation ~0.8% (June 2026 average), 2.5% the week before BOOST, 4.7% four-day average after, **6.7%** peak day | pump.fun, June–July 2026 | [The Block, 2026-07-29](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives) (opened) | C |
| 16 | Labelled snapshot data with forward **max** returns at 1 h/6 h/24 h/3 d exists | ~80 features incl. momentum trajectory, holder structure, LP burn | Author reports the momentum-trajectory group gave the largest gain, **ΔAUC +0.0095** (tiny) | ~44k snapshots of fresh pump.fun graduates and GMGN-trending tokens, 2026-06-10 to 06-30 | [ian05012/solana-memecoin-dataset (GitHub)](https://github.com/ian05012/solana-memecoin-dataset) (README opened) | C (labels are max return, not realisable; GMGN-selected) |
| 17 | Concentration and volatility mark fragile large memecoins | top-100 holder share, HHI, volatility | Top-100 wallets hold ~98% (TRUMP, LIBRA); framework flags > 80% holder share plus volatility spikes; no out-of-sample return test | large-cap memecoins, 2023–2025 | [Xiang et al., arXiv 2512.00377](https://arxiv.org/html/2512.00377v2) (opened) | B (descriptive, other population) |
| 18 | Large memecoins as a group lost ~79% in 2025–26 and track BTC | market regime | Equal-weight top-10 memecoins −78.74% (Jan 2025–Feb 2026), correlation with BTC 0.78 | top-10 memecoins | [Krause, SSRN 6292920](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6292920) (SSRN returned 403; numbers from a search snippet only) | D until opened |
| 19 | Rug detection on Ethereum with behaviour + contract features | contract, tx anomalies, liquidity moves | MLP accuracy 0.927, F1 0.787, AUC 0.952 | Ethereum; dataset size not given in abstract | [Song, Wang, Li, arXiv 2608.01609](https://arxiv.org/abs/2608.01609) (abstract opened) | C for us (other chain; no PumpSwap relevance beyond feature ideas) |

### 9.2 Candidate as-of features suggested by the evidence

"Trades-only" = computable from on-chain trade events (slot, user, SOL/token amounts, reserves, fees) plus mint creation
data, with no off-chain feed. Every feature must be computed from events at or before the decision slot.

#### U2: graduates aged 60–240 min after migration
1. **Size of the run-up and the drop since migration** (peak-to-now drawdown, return since migration, return over the last
   15–30 min). Evidence points to reversal, not momentum, in this kind of token: pumps fade within the hour (#3, B), small
   illiquid coins reverse and a big gap from the recent high predicts more downside (#4, B). Repo study: price above
   migration at +5 min → median −97% at 1 h. Trades-only: **yes**.
2. **Holder concentration at migration, adjusted for bundles** (share held by the first 10/20 buyers; same-transaction
   multi-buyer bundles). Strongest source: MELT (#2, A). Trades-only: **yes** (bundles = several buyer accounts in one
   transaction or slot; creator from mint creation).
3. **Launch tempo**: curve duration, buyer count and average buy size up to migration (#2, A; Marino, already in the repo).
   Trades-only: **yes**.
4. **Insider exit so far**: share of the early-buyer and creator-cluster supply already sold by the decision time. Inferred
   from MELT's mechanism (early buyers sell into the pool after migration) (#2, A). Measured directly: none. Trades-only:
   **yes**, if the cluster comes from same-slot/same-transaction buys; funder links need transfer data, so **no** for those.
5. **Wash/round-trip share of recent volume** (same wallet buys and sells within N slots; two-wallet loops). #8 (B) and
   Szwajcok (repo). Trades-only: **yes**.
6. **Remaining pool depth** (SOL reserve now, compared with the reserve at migration). #7, #14 and repo figures show
   liquidity collapses within the first day. Trades-only: **yes** (reserves).
7. **Regime**: graduations per hour and launches per hour, SOL trend. #15 shows the rate moves 8× after a platform change.
   Trades-only: launch and graduation counts **yes** (from mint creation and migrate events); SOL trend needs a price
   feed or the SOL/USDC pool, **yes** if we index that pool too.

#### U1: canonical PumpSwap SOL pools aged 24 h–14 d with liquidity ≥ $50k
1. **Gap from the 1-week (or since-launch) high and the 1-week return**: in small illiquid coins a deep gap predicts more
   downside and weekly returns reverse (#4, B; #5, B). Trades-only: **yes**.
2. **Volume relative to depth (turnover) and its trend**: per #4, reversal in small coins is driven by low volume.
   Trades-only: **yes**.
3. **Net flow from independent wallets**: net SOL bought by wallets that are not in creator/bundle/sniper clusters and are
   not round-tripping. Direct evidence for forward returns: none; only the wallet-persistence result (#11, B, seconds
   horizon) and the copy-trading decay already in the repo. Trades-only: **yes** for trade-based clusters.
4. **Distinct buyer growth after removing wash and sniper cohorts** (new unique buyers per hour). Repo (Kamat 2607.02795):
   raw buyer counts are inflated +16.1% by sniper rings. Trades-only: **yes**.
5. **Holder concentration of the current float** (top-10 share excluding the pool account). #17 (B, large coins), #2 (A, at
   migration). Trades-only: **partly**. Balances can be rebuilt from trades only if every transfer is also tracked;
   transfers are not trade events, so **no** for an exact figure.
6. **Pool age and survival so far**: Chainalysis' median P&D life is 0 days (#7, B), so a pool still deep at 24 h has
   already passed the main rug window. That says nothing about its forward return. Trades-only: **yes**.
7. **Regime** (as for U2) plus SOL trend; large memecoins track BTC (#18, D until opened). Trades-only: **yes** with a
   SOL/USDC pool indexed.

### 9.3 Contradictions and gaps

- **Gap (largest):** no study reports forward returns at 1–4 h after migration or for 1–14-day-old PumpSwap pools.
  MELT, Li et al. and Chen et al. all stop at ≤ 1 h or at a rug label. U1 and U2 have to be tested on our own blind backtest.
- **Momentum vs reversal:** crypto factor papers (#6, #5) find momentum, but only in large and liquid coins. A $50k pool is
  tiny by those standards, so the evidence that applies (#4, #5) predicts **reversal**. This agrees with the repo's own
  result (+5 min strength → worse 1 h outcome). Treat "buy strength" rules as unsupported for both U1 and U2.
- **Wash trading and success:** Szwajcok (repo) finds wash-traded coins graduate more often (2.0% vs 0.90%); Marino (repo)
  finds bot activity lowers graduation odds. These measure different things (wash loops vs any bot), so they are not a
  direct contradiction. Neither measures returns after migration.
- **Base rates move:** graduation went from 0.63% (Sep 2025, Marino) to 0.198% (May–Jun 2026, Kamat, a lower bound) to a
  4.7–6.7% peak after BOOST (Jul 2026, #15). Confirms the repo rule that a platform change is a regime break. Any U2 model
  trained on pre-BOOST graduates is out of date.
- **Predictors decay:** Kamat's 0.859 → 0.464 AUROC collapse (repo) is consistent with the fragile edge in #12 (the result
  flips when 3 trades are dropped) and the failed filter tier in #13. No source shows a stable as-of edge after costs.
- **LP pulls:** Chainalysis and Solidus rug definitions centre on the creator pulling liquidity. On canonical PumpSwap pools
  the migration liquidity is not held by the creator (see `docs/research/venues.md`), so the rug path is dumping supply into
  the pool, not removing LP. Rug base rates from LP-pull studies (#7, SolRPDS, Solidus) therefore **do not transfer**
  one-to-one to U1/U2.
- **Labels that cannot be traded:** the GitHub dataset (#16) uses forward **max** return, which overstates what any exit
  rule can capture. Do not reuse its labels.

### 9.4 Could not verify

- "15,548 graduates; 43.8% still had $5k liquidity at 30 min, 19.7% at 24 h; median liquidity $8,448 at +5 min →
  $2,888 at +24 h": appeared in a search-engine summary with no traceable source. The Kamat Zenodo record it seemed to
  point to (RED-PUMP-2026-v1) says it has **no** post-migration liquidity data. **Unverified. Do not cite.**
- Galaxy Research memecoin report (median Solana memecoin hold time ~100 s, down from ~300 s; 13M of 32M Solana tokens from
  pump.fun): seen only in news summaries; the Cointelegraph page returned 410 and I found no primary Galaxy page.
- Krause, SSRN 6292920 (#18): SSRN returned 403; numbers come from a search snippet only.
- Li, Shin, Wang JFQA (#3): the 70 s / 1 h figures come from a search summary of the published paper; I did not open the PDF.
- Gerzon et al., "Quantifying the Threat of Sandwiching MEV on Jito" (IMC 2025) and the Helius Solana MEV report: found
  but not opened. They are about execution cost, not predictors.
- Nansen, Flipside, Kaiko, Blockworks Research: no public study of post-graduation returns found (Blockworks metrics are
  paywalled).
- Xia et al. (#9): I did not confirm the peer-reviewed venue from the arXiv page.

**What it changed in the plan:** three features (f_liqmig, f_turn60, f_early_sold). **What it predicts:** for tokens this small the evidence points to reversal, not momentum, so "buy strength" rules start unsupported; no published study measures forward returns for U1 or U2, so only our own blind data can answer.

## 10. Results

Pending: practice days arrive from about Tue 6 Oct.
