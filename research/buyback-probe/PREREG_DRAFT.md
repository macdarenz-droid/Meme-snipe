<!-- Draft from the advisor-six-ideas workflow (2026-10-08), adversarially reviewed and corrected. The builder commits the final PREREG.md before any data pull. -->

# Revenue-funded buybacks of pump.fun Tokenized-Agent coins (pre-registration, 2026-10-08; corrected after adversarial review)

Idea 3 from the outside reviewer, in the reviewer family (k = 10). It is applied to the only Solana meme source with many coins and exact on-chain buyback amounts.

## Looked at before writing
- **FLOKI docs:** 1% bot fee, 50% of it spent on buy-and-burn. FLOKI is a BNB/Ethereum token, so it is out of scope.
- **Keyrock, 'Designing Token Buybacks':** 12 DeFi protocols, no memecoins, and no test of whether buybacks predict returns.
- **pump.fun Tokenized Agents:**
  - program AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7 (npm @pump-fun/agent-payments-sdk 3.0.3);
  - buyback authority GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG.
- **Public RPC on 2026-10-07:** an account snapshot and monthly signature counts. 233,878 toggles; 75,746 SOL of lifetime buybacks; 174,481 authority transactions; 30 sampled transactions (20 buybacks, 10 creator-fee payouts).
- **GeckoTerminal:** one call confirmed daily SOL candles for one agent pool.
- **Rule breach:** the scout also fetched one pump.fun docs page (tokenized-agent-disclaimer) against the owner's no-pump.fun-requests rule. It is not cited here and is never fetched again.
- No price, return or volume was computed.

## Question (stage 1)
Take Tokenized-Agent coins that trade on their canonical PumpSwap pool. Suppose buyback spend accelerates over complete UTC day t. Does that predict the coin's SOL return on day t+1, beyond:
- the coin's prior returns;
- its own volume growth;
- the buyback its own volume mechanically implies;
- that day's market?
The effect must also be large enough to matter against the round-trip cost.

## Data
1. **Authority history.** Helius getTransactionsForAddress (full, succeeded) on the authority, blockTime 2026-03-12 to 2026-09-12T00:00Z.
   - Decode AgentBuybackTriggerEvent: tokenized_agent_mint, currency_mint, currency_mint_amount_for_buyback, swap_program, slot, time.
   - Decode the DistributeCreatorFees payouts.
   - Check first: on 20 sampled buybacks, currency_mint_amount_for_buyback must match the agent PDA's SOL balance change within 1% in at least 19 of 20. Otherwise the field mapping is fixed first.
2. **Program history.** getTransactionsForAddress on AgenTMiC2…, same time bounds.
   - AgentInitializeEvent gives the eligibility date and buyback_bps.
   - AgentUpdateBuybackBpsEvent gives changes to buyback_bps.
   - GlobalUpdateAuthoritiesEvent: if the authority changed, the new authority's history is pulled too.
3. **Prices.** Daily OHLCV in SOL (currency=token) from GeckoTerminal for each coin's canonical pool. The pool address is derived from the mint.
   - One call per coin, at least 7.5 s apart (under 50% of the documented free limit).
   - Rows dated 2026-09-12 or later are dropped before saving.
   - Raw candles stay in scratch and are never committed.
   - Coins fetched (a superset of every coin that can be eligible): PumpSwap SOL buybacks of at least 1 SOL in some 7-day span ending by 09-10, from events.
   - Before Stage 1, confirm whether the ohlcv volume is in SOL or USD with currency=token (API docs, or one coin-day against on-chain volume). Use SOL, and record which.

## Windows
- **Start (forced by the data):** GeckoTerminal serves 180 days of candles (docs/research/historical-data.md). So the first decision day is the first day with candles for t−7..t at fetch time: about 2026-04-21 if fetched on 10-10.
- **Stage 1 decision days:** from the first covered day to 2026-06-30, the period when new agent coins were still launched.
- **Stage 2 holdout decision days:** 2026-07-01 to 2026-09-10, with outcomes by 09-11.
  - Nothing from U1-B's holdout (09-12 to 09-21) or from after the wall is read.
  - These candles are saved to a separate file that the stage-1 code never opens.

## Eligibility (coin i, day t; known at the end of t)
- The agent was initialised with buyback_bps > 0 before day t.
- The canonical pool migrated at least 1 day before t.
- PumpSwap SOL buybacks over t−6..t total at least 1 SOL.
- Candles exist for t−7..t. A missing candle means no trades: the price is carried forward and volume is 0.
- Excluded: USDC buybacks (103 coins) and buybacks made during the bonding-curve phase.

## Variables
- **B_{i,t}:** SOL spent on day t, i.e. the sum of currency_mint_amount_for_buyback, SOL buybacks on PumpSwap only.
- **Treatment A_{i,t}** = ln(1 + B_t) − ln(1 + mean(B_{t−3..t−1})), with B in SOL.
- **Pseudo-buyback PB_{i,t}** = creator-fee rate × own SOL volume_t × buyback_bps_t / 10,000.
  - The fee rate is the tier from fee-configs.json at the day-t market cap, taken as close × 1,000,000,000 tokens (burns ignored).
  - Control: its acceleration.
- **Controls:**
  - r_t and Σ r_{t−6..t−1};
  - own volume growth, ln(1 + V_t) − ln(1 + mean V_{t−3..t−1});
  - PB acceleration;
  - ln age;
  - day-(t+1) fixed effects, which absorb the meme market.
- **Outcome:** r_{t+1} = ln(close_{t+1} / close_t) in SOL. Gross; costs enter only in stage 2.

## Stage 0 (counts only, from events, before any candle is fetched)
- At least 2,000 eligible coin-days in the stage-1 window, over at least 30 days.
- At least 300 holdout coin-days with A at or above the stage-1 window's 90th percentile.
- If either fails: stop, UNRESOLVED (too few events), and fetch no candles.

## Primary test (stage 1)
- **Model:** OLS of r_{t+1} on A_t, the controls and day fixed effects.
- **Interval for β_A** (95%, two-sided): the widest of day-clustered CR1 with t_{N−1}, two-way (day, coin) CR1 with t_{N−1}, and a wild cluster bootstrap-t by day (Webb six-point weights, 9,999 replicates, seed 20261008).
- **Materiality (fixed now):** β̂_A × (A_p90 − A_p50) ≥ c̃, where c̃ = the median estimated $50 round-trip cost (from pool reserves at the end of day t) over eligible coin-days with A ≥ A_p90.
- **PASS:** the CI lies above 0, and materiality holds.
- **KILL:** β̂_A ≤ 0, or the CI lies above 0 but the effect is immaterial.
- **UNRESOLVED:** β̂_A > 0 but the CI includes 0. This counts as not supported for the bot.

## Secondary (descriptive)
- β on PB alone: if PB predicts as much as A, the signal is just volume.
- Residual buyback: B_t minus its fitted value from PB and own volume.
- Pending agent balance at day end.
- Bonding-curve buybacks.

## Stage 2 (separate registration, only after a PASS)
- **Entries:** holdout coin-days with A at or above the stage-1 90th percentile.
- **Trade:** buy at the first swap after 00:05Z on day t+1; exit at the first swap 24 h later. Both are priced from pool states via getTransactionsForAddress, at most 4 calls a trade.
- **Benchmark:** 10 matched random eligible agent coin-days on the same day.
- **PASS needs:** at least max(300, n_power at the family level) trades on at least 10 days, and family-level CIs (99.5% two-sided, Bonferroni k = 10) above 0, both for the absolute return and against matched random. 95% CIs are also reported.
- **Sizes:** $50 is the primary. Also $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and impact shown separately.
- **Costs:** the conservative scenario, in SOL. $50 = 419,252,054 lamports at SOL $119.26 (packages/backtest/src/research/edge-costs.ts; 414,009 lamports fixed per round trip, rent loss included).

## Look-ahead guards
- **Eligibility** comes from event history, never from the 2026-10-07 account snapshot. A close-account instruction exists, so closed accounts are missing from that snapshot.
- **Days:** complete UTC days only; no buyback schedule is assumed.
- **Prices** come from candles, never from buyback fills.
- **Sealing:** every request is bounded before 2026-09-12T00:00Z, and the holdout file stays sealed until stage 2.
- **Regime breaks:** B2 (07-21) and B3 (09-09) fall in the holdout, and no new agent coins exist after 06-30. Holdout results are reported as a different regime.
- **Leak test:** a planted future buyback on day t+1 must not change A_t.

## Budget
- **Helius:** at most 170k credits, at the documented getTransactionsForAddress metering (10 per 100 returned full transactions; 10 minimum).
  - Authority history: about 17.5k.
  - Program history: 25-100k (not measured).
  - Stage 2: at most 20k.
- **Fallback** if the method is not on the Developer plan: public RPC getSignaturesForAddress plus getTransaction, within 50% of the documented public limits (about 1 a second, about 48 h, 0 credits).
- **GeckoTerminal:** at most 4,660 calls, about 10 h at 7.5 s spacing.
- **Builder:** about 2 days.

## Executor notes

Not started now. Run it only when a builder would otherwise sit idle, after the core cards, and under the P0 ruling (its Helius and GeckoTerminal reads are research reads in the reviewer family).

Setup:
- Builder: one Sonnet 5.5 at medium effort (mechanical decoding), with the stats reviewer for the regression.
- Branch: claude/buyback-probe.
- Commit research/buyback-probe/PREREG.md first.

Order of work:
1. Make one getTransactionsForAddress call to confirm the Developer plan can use the method; read the credits from the dashboard.
2. Pull the authority and program histories. Keep a hard credit ledger: getTransactionsForAddress counted at 10 per 100 returned transactions (heli.py's flat 10 per call undercounts this method). Every request is bounded before 2026-09-12T00:00Z.
3. Run the Stage 0 counts. If they fail, stop before any GeckoTerminal call.
4. Fetch the candles. The holdout rows go to a sealed file; the stage-1 code never opens it.

Checks: a fresh reviewer and a red team check the code before the primary is read.

Rules: no pump.fun requests (the scout's one docs fetch is not repeated); python3 -I; raw data stays in scratch.
