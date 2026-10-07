<!-- Draft from the advisor-six-ideas workflow (2026-10-08), adversarially reviewed and corrected. The builder commits the final PREREG.md before any data pull. -->

# Failed slippage attempts as hidden demand (pre-registration, 2026-10-08; corrected after adversarial review)

Idea 4 from the outside reviewer, in the reviewer family (research/IDEA_BOARD.md, k = 10). Stage 1 asks only about order flow. No trade is tested until stage 1 passes and a separate stage-2 registration is committed. This file is committed before Step A of the shared tape.

## Looked at before writing (counts only)
- **Paper:** Zheng, Wan, Lo, Xie, Yang, 'Why Does My Transaction Fail? A First Look at Failed Transactions on the Solana Blockchain', PACMSE 2(ISSTA):1489-1512, 2025, DOI 10.1145/3728943 (Crossref); arXiv 2504.18055; repo github.com/ZXXYy/Solana_Failed_Tx @ e69ce66.
  - It is a failure taxonomy (Aug 2023-Jul 2024, before PumpSwap).
  - It makes no claim about demand or prices.
- **IDLs:** research/historical/rpcscan/idl/pump.json and pump_amm.json.
- **Three repo testdata blocks** (2026-10-01, inside the sealed window; data-integrity fixtures). Counts only. Recount:
  - 2,951 transactions, 226 failed;
  - 154 call pump or PumpSwap, and 12 of those failed;
  - slippage failures: pump 6002 ×1, PumpSwap 6040 ×3 and 6004 ×1;
  - other failures: pump 6024 ×2, pump 3012 ×1, PumpSwap 2006 ×1, PumpSwap custom 1 ×2 (an inner token error passed up);
  - 3 transactions had truncated logs.
  - No flow, price or outcome was or will be computed on them.
- **September:** no flow or price for this idea was looked at. Earlier price probes used September as validation; none computed a failed-transaction measure.

## Notation
- I(p,w) is the signal.
- N is the number of UTC days in a sample.

## Question (stage 1)
Take a completed 5-minute window on a canonical PumpSwap pool. Suppose more distinct wallets had BUY attempts fail on slippage than SELL attempts. Does that excess predict more net successful SOL buying in the next 5 minutes, after our delay? It must do so beyond the window's successful order flow, recent price move, volatility, pool age and reserves, and by enough to matter against the round-trip cost.

## Data
- **Tables:** shared tape S, F, G and B.
- **Phase 1:** the days read in Steps A-C, 2026-09-02 to 09-11 (10 UTC days). B3 starts 09-09 19:30Z.
- **Phase 2:** the registered Phase 2 block, read once, for the confirmation and stage 2. Either decision days 10-22 to 11-04 with 11-05 as tail, or the fallback 08-19 to 09-01.
- **If N < 10 in Phase 1:**
  - the primary moves unchanged to Phase 2;
  - Phase 1 serves only Stage 0 (MIN_DAYS = 10, packages/core/src/stats/g2rule.ts line 99).

## Units and eligibility (all known at window close t_c)
- **Unit:** (pool p, window w), with w = [300k, 300(k+1)) seconds UTC by block time.
  - Events are ordered by (slot, tx_idx, outer_ix, inner_ix).
  - A transaction belongs to its block's window.
- **Pool:** a canonical PumpSwap pool (canonical status from the trade itself, as the scanner decides it), at least 10 minutes old at window start.
  - Pools created before the tape get age = time since tape start (a lower bound), plus an indicator.
- **Activity:** at least 5 successful swaps in w.
- **Cost:** the estimated $50 round trip at the pool state at t_c is 3.0% or less (cost model below).
- **Tape end:** the outcome window must end at or before the end of the last day read. Otherwise the unit is dropped by time.
- **Bonding curves:** secondary only.

## Classifying a failed transaction (F rows)
- **Failing program:** the innermost 'Program X failed' line in the transaction's own log.
  - A truncated log (RPC cuts at 10,000 bytes), or a log with no such line, gives class 'unclassified': excluded and counted.
  - Only failures whose failing program is pump (6EF8…) or PumpSwap (pAMMBa…) can count.
  - A code raised by any other program is 'other program' (for example, 6002 from cpamdpZC… or dbcij3LW… in testdata).
- **Direction:** from the failing pump or PumpSwap instruction's own discriminator, top level or CPI. Never from the code.
  - BUY: pump buy, buy_v2, buy_exact_sol_in, buy_exact_quote_in_v2; PumpSwap buy, buy_exact_quote_in.
  - SELL: pump sell, sell_v2; PumpSwap sell.
  - Protocol instructions (boost_buy_and_burn, update_buyback_config, admin) are excluded.
- **Slippage (counted), per program:**
  - pump 6002 TooMuchSolRequired, 6003 TooLittleSolReceived, 6042 BuySlippageBelowMinTokensOut;
  - PumpSwap 6004 ExceededSlippage, 6040 BuySlippageBelowMinBaseAmountOut.
- **Every other code** is excluded and counted by class, per program:
  - insufficient funds: pump 6040, 6041; PumpSwap 6039; token or system custom 1; InsufficientFundsFor*;
  - liquidity: pump 6021 NotEnoughTokensToBuy, 6023 NotEnoughTokensToSell;
  - arithmetic: pump 6024 Overflow; PumpSwap 6023 Overflow, 6024 Truncation;
  - account and constraint: Anchor 2xxx and 3xxx; PumpSwap 6014, 6015, 6028;
  - state: pump 6005 BondingCurveComplete; PumpSwap 6021 DisabledSell, 6041, 6042;
  - compute exhaustion;
  - any code not listed.
- **Cyclic arbitrage (excluded):** two or more swap legs on the same mint in one transaction, or SOL in and SOL out with no net token.
- **Retry dedupe:** attempts with the same (signer, pool, direction) in one window count once, timed at the first. A chain that crosses windows belongs to its first attempt's window.
- **Wallet:** the signer. Failed transactions emit no events.

## Signal (known at t_c)
I(p,w) = ln(1 + FB) − ln(1 + FS).
- FB: the number of distinct signers with at least one slippage-failed BUY on p landing in w.
- FS: the same for SELLs.

## Controls (as of t_c; successful transactions only)
- **Order flow in w:** distinct buying and selling owners; net successful SOL flow divided by the quote reserve at t_c; trade count.
- **Price:** log change over the last 5, 15 and 60 min; realised volatility of 1-min returns over 60 min.
- **Pool:** ln age, the before-tape indicator, ln quote reserve at t_c.
- **Congestion:** ln(1 + failed transactions of any other class on p in w).
- **Window fixed effects:** they absorb market-wide flow, hour of day and failure shocks. They also absorb the B3 regime, so there is no separate indicator.

## Outcome (scored in a separate stage the feature code cannot read)
- Y(p,w) = [successful buy SOL − successful sell SOL by owners on p in (t_c + d, t_c + d + 300 s]] / quote reserve at t_c, clipped to [−0.5, 0.5].
- **Delay d = 30 s**, a conservative live delay: confirmed log feed, one getTransaction for the signer, quote, landing. Only a larger measured p90 may replace it, before Phase 2.
- **Amounts and exclusions:** quote amounts exclude fees. Cyclic-arbitrage transactions, protocol flow and wash-flagged owners are excluded.
- **Wash flag (outcome only):** an owner who buys and sells on p within 60 s with a net token change of at most 5% of the gross.
- **Y_ex (secondary):** Y without trades whose signer or owner is among w's failed signers on p (the retry share).

## Stage 0 gate (counts only, Step A days 09-10 and 09-11)
- **Density:** at least 20% of eligible (p,w) have FB + FS ≥ 3. Otherwise stop and record 'too sparse to trade'.
- **Classification:** 'unclassified' is at most 5% and 'other program' at most 10% of failures that call pump or PumpSwap. Otherwise the classifier is fixed on those two days (counts only, recorded) before the primary.
- **Also reported:**
  - buy:sell mix;
  - retries per wallet;
  - share failing inside routers;
  - per-block failed share;
  - slippage failures per day in eligible pools. This prices a live collector: one getTransaction per failure, plus the stream.

## Primary test (one)
- **Model:** OLS of Y on I, the controls and window fixed effects, over every eligible (p,w) on the Phase 1 days.
- **Interval for β_I** (95%, two-sided): the widest of
  - (a) day-clustered CR1 with t_{N−1};
  - (b) two-way (day, pool) CR1 with t_{N−1};
  - (c) a wild cluster bootstrap-t by day (Webb six-point weights, 9,999 replicates, seed 20261008).
  - This follows the repo convention: bootstrap.ts takes the wider of bootstrap-t and t_{N−1}.
- **Materiality (fixed now):**
  - M = 2 × β̂_I × (I_p90 − I_p50), with quantiles over eligible Phase 1 units. Under constant product, an extra net inflow ΔY of the quote reserve moves the price by about 2ΔY.
  - c̃ = the median estimated $50 round-trip cost (pool state at t_c) over eligible units with I ≥ I_p90.
- **PASS:** the CI lies above 0, N ≥ 10, and M ≥ c̃.
- **KILL:**
  - β̂_I ≤ 0 (redundant after controls); or
  - the CI lies above 0 but M < c̃ (immaterial: it cannot cover the toll).
- **UNRESOLVED** (counts as not supported for the bot):
  - β̂_I > 0 but the CI includes 0;
  - N < 10;
  - the Stage 0 classifier was not fixed.
- **Power:** no power calculation is possible before Stage 0. N ≥ 10 is the floor.

## After the verdict
- **PASS:** the same model, thresholds and materiality rule must PASS on Phase 2 (c̃ recomputed on Phase 2 pool states; N ≥ 10; read once).
  - Stage 2 is registered after the Phase 1 verdict and before Phase 2 is pulled.
  - Its result counts only if this confirmation passes.
- **UNRESOLVED:** the Phase 2 stage-1 test decides, once. Stage 2 counts only on a Phase 2 PASS.
- **KILL:** stop. The result goes in research/failed-tx-probe/RESULTS.md and on the idea board.
- **Fallback block:** a pass there needs a post-B5 check before any strategy registration.

## Secondary (descriptive; no decision rests on these)
- FB and FS separately.
- Y_ex.
- Attempted unfilled SOL.
- Delays of 2 s, 10 s and 120 s, and a split of the last 30 s.
- Outcomes at +15 and +60 min.
- I × B3 interaction.
- Bonding curves.
- Without bot-flagged signers (flags from prior days only).
- Placebo: I shuffled across pools within a window (expected β ≈ 0).
- Pool fixed effects.

## Stage 2 sketch (separate registration; confirmatory family)
- **Entries:** (p,w) with I at or above the Phase 1 I_p90 and FB ≥ 2. At most one open trade per pool; entries while one is open are skipped.
- **Trade:** buy at the first swap after t_c + d; exit at the first swap after entry + 300 s (the stage-1 horizon). Exit at +15 min is a secondary.
- **Benchmark:** 10 matched random eligible (p,w) in the same window, matched on reserve, age and 60-min-return terciles.
- **PASS needs all of:**
  - at least max(300, n_power at the family level) trades on at least 10 Phase 2 days;
  - the family-level CI (99.5% two-sided, Bonferroni k = 10) of mean net SOL return above 0;
  - the same CI of the difference against matched random above 0;
  - a passed Phase 2 stage-1 confirmation.
  - 95% CIs are also reported.
- **Sizes:** $50 is the primary. Results are also reported at $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and price impact from real reserves shown separately (owner, 2026-10-07).
- **Live cost:** the registration states the live collector's credits per month (from Stage 0's counts). Above the plan's headroom, it needs the owner's budget.

## Costs (stage 2 and the cost filter)
- **Size:** $50 = 419,252,054 lamports at SOL $119.26 (research/edge/costs.json).
- **Conservative scenario** (packages/backtest/src/research/edge-costs.ts; docs/research/edge.md §1):
  - venue fees from each event's own fee fields, with tiers by market cap from research/edge/snapshot/fee-configs.json;
  - constant-product price impact at our size from pre-trade reserves;
  - 414,009 lamports of expected fixed cost per round trip. This already includes the expected rent loss (14.5% of 1,513,840) and failed exit attempts (edge.md line 156);
  - adverse move over 6 slots (p90), ×1.5 on any shortfall.
- P&L in SOL.

## Look-ahead guards
- **Timing:** windows by landed block. A failed transaction counts only once its block exists (finalized getBlock historically, confirmed logs live).
- **Dedupe and 'never filled':** look forward only to the window close.
- **Flags:** bot and arbitrage flags use prior days only.
- **Eligibility:** as of window start or close. Pools that later rug stay in.
- **Direction:** from each transaction's own instruction and log, never from one code table applied across regimes.
- **Controls:** successful trades at or before t_c only.
- **Days:** outcome windows end inside the tape. No sealed-window day, U1-B-holdout day or Phase 2 day is read before its turn.
- **Leak test:** a planted future-only marker (a synthetic failed BUY and a swap one slot after t_c). The build fails if the feature code can read either.

## Budget
- 0 extra Helius credits (shared tape).
- Builder: about 1 day for the F extractor with tests (in the tape card), about 1 day for the analysis.
- Compute: hours.

## Executor notes

One builder (Opus 5.5) on branch claude/failed-tx-probe off ccr-7fae2302-drz4co.

Order of work:
1. Commit research/failed-tx-probe/PREREG.md and the 'Reviewer family' section of research/IDEA_BOARD.md before Step A.
2. Build the F extractor inside the tape card. Its tests on the 3 testdata blocks must reproduce 12 failed pump/PumpSwap calls and 5 slippage failures.
3. After Step A, run Stage 0 and record it in RESULTS.md before any outcome code exists.
4. If Stage 0 fails: no Step B or C on idea 4's account, and RESULTS.md is written the same day.
5. After Step C, freeze the feature tables (record their hash), then run the separate outcome script.

Checks:
- A fresh reviewer and a red team check the code against this PREREG before the primary is read.
- The stats reviewer checks the three interval computations and that the widest is used.

Rules:
- No pump.fun requests. python3 -I in scratch. No raw Helius response committed.
- Stage 2 is registered only after the Phase 1 verdict and before Phase 2.
