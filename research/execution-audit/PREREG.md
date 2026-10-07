# Execution audit: are the runner's hourly exits executable? (pre-registered 2026-10-07)

Exploration coins only (`targets.json`, from the lottery probe's exploration sample). No coin in
`../runner-probe/validation_sample.json` is read in any way. This file is fixed before any audit result is computed.

## What was looked at before writing this
- `targets.json` (hourly-model results per coin), the runner and lottery code.
- For the jackpot (winners[0]) only: GeckoTerminal minute bars from entry − 1 h to the R2 hourly exit, its
  pool's signature list for that window (16,047 signatures, 15,957 successful), and three decoded swaps before
  entry used to check the event layout. No replay was run.
- Facts fixed from those three swaps (they define the method, not a result):
  - `pool_base_token_reserves` / `pool_quote_token_reserves` in BuyEvent/SellEvent are the reserves **before**
    the swap (pre-base + base sold = the next event's pre-base, exactly).
  - The curve uses effective quote reserves = real quote + `virtual_quote_reserves` (the logged sell output equals
    Q_eff·b/(B+b) to the lamport). The LP fee stays in the pool; protocol and creator fees leave it.
  - `getTransaction` returns `transactionIndex`, so swaps are ordered by (slot, transactionIndex, inner-instruction order).

## Data
- Helius RPC, read-only: `getSlot`, `getBlockTime`, `getBlock` (signatures only, to find a paging anchor),
  `getSignaturesForAddress` on the pool, `getTransaction` (json, maxSupportedTransactionVersion 0).
  Failed transactions are dropped. Only PumpSwap (pAMMBay…) BuyEvent/SellEvent from inner `emit_cpi`
  instructions whose `pool` equals the target pool are used. Other pools of the same mint are ignored
  (the bot trades the canonical pool).
- GeckoTerminal minute bars only to choose which time ranges to fetch; every audited number comes from swaps.
- Raw responses stay outside the repo; only code and derived per-trade numbers are committed.

## Replay (per coin)
State after a swap: B' = B ∓ base amount, Q' = Q ± quote amount (curve amount) + LP fee (buy: +, sell: −), with
virtual quote reserves V from the event. Whenever an event is read, its own pre-swap reserves replace the
carried state (mismatches are counted and reported). Marginal price P = (Q + V) / B, in SOL per token.

1. **Entry.** Stake q = $10 / `lottery.SOL_USD` (119.26) = 0.083850 SOL. State = after the last swap with block
   time < `entry_ts`. Entry price P_e = its marginal price. Total fee f = (LP + protocol + creator bps of that
   swap) / 10⁴. Curve input q/(1+f); tokens = B·x/(Q+V+x). The buy is not inserted into the later history
   (counterfactual; our size is small next to the moves studied, and this is stated as a limit).
2. **Real-time path.** Swaps with block time ≥ `entry_ts`, in order. Running peak = max post-swap P from P_e
   onward. Armed once the running peak ≥ 2·P_e.
   - **Stop** (R1 and R2, only while not armed): the first swap whose post-swap P ≤ 0.7·P_e.
   - **R1 trail** (40%) / **R2 trail** (60%): once armed, the first swap whose post-swap P ≤ (1 − trail)·running peak.
   - **Time**: no trigger before `entry_ts` + 14 days → trigger = first swap at/after that time.
3. **Hourly exits.** For R1 and R2: trigger = the first swap with block time ≥ end of the exit bar in
   `targets.json` (`exit_bar_start` + 3600).
4. **Fill at latency L ∈ {1, 5, 25, 150} slots.** For every trigger at slot S: sell all tokens against the state
   after all swaps with slot ≤ S + L. Sell: gross = (Q+V)·b/(B+b); proceeds = gross·(1 − f) with f from the last
   swap in that state.
5. **Numbers per trade.** Proceeds/stake (multiple of $10) and net return = proceeds/q − 1; the network/priority
   cost `lottery.FIXED` (414,009 lamports per round trip) reported separately (net with and without it).
   For trails: proceeds as a share of peak position value (tokens × running peak at the trigger).
   Model comparison: `net_$10` in `targets.json` (hourly model, which includes FIXED) against the replay net.
   Stops: replay vs the hourly model's fill min(level, close) (the `p_exit` of `R1_hourly`).
6. **Entry check (D).** Replay tokens per SOL against what `lottery.net()` implies at entry:
   (1/p0_hourly_close)·(1 − fee(m0))/(1 + q/R(m0)). Ratio > 1 means the model charged at least the real entry cost.

## Order of work and the credit cap
Goals A (jackpot), B (winners[1..9]), C (30 random stop-outs), D (entry check on every audited coin), within
1,500,000 credits counted as 10 per RPC call. For each coin all pool swaps are fetched contiguously from the last
swap before entry to the latest trigger the replay needs (so the running peak is exact), plus each hourly-exit
and latency window (trigger slot + 150). Minute bars only guess how far to fetch; if a trigger is not found in the
fetched range, the range is extended. A coin is skipped whole, never partly, if its windows would break the cap;
skips are reported with their reason.

## Known limits (stated now)
- Counterfactual: our own buy and sell are not fed back into the history; other traders' reactions are unknown.
- Latency in slots is a stand-in for detection + landing time; the four values bracket it.
- Arbitrage with other pools of the mint is not modelled.
- `lottery.SOL_USD` is a fixed rate; all results are in SOL multiples of the stake, so the rate only sets size.
