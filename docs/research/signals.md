# Signal research on practice days (RES-3)

Task RES-3, started 2026-10-04 (Melbourne). Goal: find, on the **practice days only**, which as-of signals separate positive from negative net return after full costs, and hand BT-2 at most **one candidate configuration per universe** (U1, U2) to pre-register before the sealed holdout is opened. U3 is out (RES-2: whale copy-trading lost about 11% a trade, 0 of 120 variants positive).

Sections 1–7 are the **pre-registered plan**. They were written and committed before any practice-day row was read (the commit that adds this file has no result in it). Any later change to them is listed in §8 with its date and reason, and every trial it adds is counted. Results go in §10 only.

## 1. Data and the holdout wall

- Decision window: 2026-08-03 to 2026-10-01 (60 days, pending UPG-1's regime check). DATA-1 adds a 14-day lead-in before it, which features may read as history (never as decision days).
- The holdout is the latest days of the window, set by BT-2 in the STATS-1 registry. **RES-3 never reads, loads or computes anything on a holdout day**, and never on the embargo day before it.
- Practice days = decision days strictly before `holdoutFrom − embargo`. Embargo = 1 full UTC day (longer than the 2 h horizon plus the exit ladder, ARCHITECTURE.md §13.2).
- The wall is in code: `packages/backtest/src/research/practice.ts` loads the boundary from `research/signals/window.json`, refuses any holdout or embargo day before a file is opened, and throws if any row at or after the wall reaches the analysis. A guard test plants a holdout-day row and expects the refusal.
- Until BT-2 confirms the boundary, the wall is **2026-09-17** (conservative: the last 15 days are off limits). The wall may only move earlier without BT-2's confirmation, never later.
- A candidate whose outcome window (decision + 120 min horizon + exit ladder) would reach the embargo day is dropped (purge at the wall).

## 2. Universes and decision points

Both universes take canonical PumpSwap pools with a SOL quote, not mayhem (H5), as the backtester's Market sees them (`CreatePoolEvent` checked against the canonical PDA).

| Universe | Decision points | Base filters (proxies of GATE-1 that the dataset supports) |
|---|---|---|
| **U2** post-graduation reclaim | Every migration (`CompletePumpAmmMigrationEvent`), at fixed ages **60, 120 and 180 min** after migration (3 decisions a mint; fixed, not tuned) | H8: quote at migration ≥ 5 SOL and live liquidity ≥ the policy floor ($15k); H9: creation to migration ≥ 5 min (creation must be in the data, else unknown → excluded); H11: price at +5 min not above the migration price, and no 1-min close +25% within the last 3 min |
| **U1** survivors | A fixed UTC grid every **4 h** (00, 04, …, 20 UTC); every pool aged 24 h–14 days since migration at that moment is checked | Liquidity (2 × quote reserve in USD) ≥ $50k (policy `u1FloorUsd`), market cap ≥ 1,470 SOL, migration seen in the data |

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
| f_bundle | share of supply bought in the creation slot by wallets other than the pool | Bundle | H13, §7.2 item 2 |
| f_top10 | supply held by the 10 largest net buyers (trade flows only) | Concentration | H12 proxy |
| f_dep24 | mints the creator launched in the 24 h before this mint's creation | Deployer | H14 |
| f_grad24 | migrations seen in the last 24 h (all mints in the data) | Regime | §6.4 |
| f_sol24 | SOL/USD log change over 24 h (off-chain series as of the decision) | Regime | §6.4 |

24 features. FACTS-1's producers replace the trade-flow proxies (f_devnet, f_bundle, f_top10, f_dep24) when they land; a feature that changes definition is a new feature and a new trial.

## 4. Outcome

The outcome stage (`outcome.ts`) runs after the feature stage and is never imported by it (an import-guard test checks this). It replays the pool's real swaps after the decision through CORE-2's exact pool maths (`ShiftedPool`, so our own trade moves the pool) and labels each candidate with STATS-1's execution-aware triple barrier (`labelTripleBarrier`).

- Size: the policy's `capital.minNotional` ($2 trial setting), converted at the SOL/USD as of the decision. Quotes are exact at that size.
- **Conservative scenario** (`FILL_CONFIG.scenarios.conservative`): entry lands 6 slots after the decision, discovery and landing at the p90 values, executed shortfall × 1.5, land probability 66% on PumpSwap (one entry attempt; a failed attempt pays base + priority fee and the decision returns that loss), token-account rent **not** recovered, take-profit judged on the slot's value (close), exits on the policy ladder (5 attempts, 6 slots apart, each failed attempt pays base + its rung's priority fee).
- Fixed costs per trade: base fee and priority fee per transaction, the 5,000-lamport tip per landed transaction, token-account rent 1,513,840 lamports.
- Barrier configurations (every one is a trial):
  - **B1 (primary): take-profit +50%, stop −20%, time stop 120 min** (policy `tMaxMs`).
  - B2: time stop only, 120 min (no take-profit, stop at −100%).
  - B3: take-profit +30%, stop −15%, time stop 60 min.
- `r_net` = net SOL return ÷ entry cost, all costs. Unobserved windows are censored, never 0.
- Base-scenario results are reported beside the conservative ones for context; **decisions use conservative only**.

## 5. Folds and selection

- Practice days are split into **K = 5 contiguous day blocks** of equal size (the last block takes the remainder).
- **Primary: expanding walk-forward.** For k = 2..5, rules are chosen on blocks 1..k−1 and applied to block k. One embargo day is dropped on each side of the test block from the training set, and any training candidate whose outcome window reaches into the test block is purged.
- **Secondary: combinatorially purged blocked CV** (all 10 splits of 5 blocks into 3 train and 2 test), used only for the probability of backtest overfitting (PBO, STATS-1 `probabilityOfBacktestOverfitting`).
- Rule family (fixed): a filter on the base universe made of one or two conditions `feature ≥ t` or `feature ≤ t`, with `t` at the training set's 20th, 40th, 60th or 80th percentile (192 single conditions; a second condition is chosen greedily from the same 192 given the first, so at most 383 rules per universe, barrier and fold).
- Selection score on the training set: the one-sided 95% lower bound of mean `r_net` (STATS-1 day-block bootstrap, 2,000 resamples), among rules with ≥ 30 trades on ≥ 5 days. Ties: fewer conditions, then the lower feature ID.
- Out-of-sample result of the **procedure** = the trades its chosen rules select in the test blocks, pooled. This is the estimate BT-2 can expect; the in-sample score of the final rule is never reported as performance.
- Univariate view (descriptive, also counted): for each feature, the Spearman correlation with `r_net` and the mean `r_net` per training-quintile, with day-block bootstrap 95% intervals, Holm-adjusted across the 24 features.

Every rule evaluated in every fold, universe and barrier is written to the trial registry (`research/signals/trials.jsonl`: id, definition, fold, n, mean). The deflated Sharpe ratio uses the registry's count and the variance of its Sharpe ratios.

## 6. Stopping rule and what is handed to BT-2

For each universe, the candidate is the rule the procedure picks on **all** practice days, with barrier B1 unless B2 or B3 passes and B1 does not. It is handed to BT-2 only if **all** of these hold on the pooled walk-forward out-of-sample trades (conservative scenario):

1. Mean `r_net` > 0 at the one-sided 95% day-block lower bound.
2. The paired difference against base on the same days > 0 at the one-sided 95% lower bound.
3. Deflated Sharpe ratio ≥ 0.95 and PBO ≤ 0.25 from the registry.
4. ≥ 100 out-of-sample trades on ≥ 10 days.
5. Top 1% of trades ≤ 50% of P&L; no day > 25% of P&L; `y_severe` ≤ 10%; blocked exits ≤ 5%.
6. The rule chosen in each fold uses the same feature group as the final rule in at least 3 of 4 folds (stability).

Otherwise the answer for that universe is **"no reliable signal"**, stated plainly, and no candidate is handed over (the bot keeps abstaining in that universe).

Stopping: one main run when the supervisor says the practice days are in. At most **one** further round, only on newly arrived practice days and only with additions written into §8 before that run; all trials of both rounds count. No feature, threshold grid, barrier or fold change after a result has been seen, except as such a recorded round. Then RES-3 stops, whatever the result.

## 7. Known limits (stated before the run)

- Holder and insider features come from trade flows; token transfers are not in the dataset, so f_devnet, f_bundle and f_top10 are proxies.
- One entry attempt per decision, as in S0; the live bot may retry.
- The 60-day window holds roughly 2.6% graduations of ~50k launches a day, sampled by mint hash (DATA-1); the U2 sample per day depends on that sample rate.
- Practice-day results say nothing final: only BT-2's sealed holdout is proof (pre-funding item 6).

## 8. Changes to the plan

None yet.

## 9. Literature and evidence

Pending (see the RES-3 PR).

## 10. Results

Pending: practice days arrive from about Tue 6 Oct.
