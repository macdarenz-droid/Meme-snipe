# Copy-trading test: pre-registered rules (RES-2)

Written and committed **before the test window opens** (14:00 UTC, 2026-10-03). The git commit time of this file is the
proof. After it is committed, the rules below are frozen: any later change is listed in `docs/research/copytrading.md`
under "Deviations", with its reason, and the frozen version is reported as well.

## Data

- Source: `collect.mjs`. Free public RPC websocket `logsSubscribe` (commitment `confirmed`) on the pump.fun
  bonding-curve program `6EF8rrec...` and the PumpSwap AMM program `pAMMBay6...`. Anchor events are decoded from the logs:
  pump.fun `TradeEvent`, PumpSwap `BuyEvent`/`SellEvent`, `CreateEvent`, `CompleteEvent`, `CreatePoolEvent`.
  - This captures every trade the stream delivers, whatever the token. There is no list or ranking, so no survivorship.
  - Failed transactions are counted but not stored.
- Collection started at 12:36:58 UTC and runs until at least 15:21 UTC.
- Completeness check: for a random sample of pools, compare the captured signatures against `getSignaturesForAddress`.
  The capture rate is reported.
- PumpSwap pools are mapped to mints with `getMultipleAccounts` (base_mint at offset 43, quote_mint at offset 75).
  Only pools quoted in WSOL are used.
- A token's trades on the bonding curve and on its PumpSwap pool form one series, keyed by mint.

## Windows (UTC, 2026-10-03)

- **Formation F:** trades with block time in [12:37:00, 14:00:00). Wallets are scored only from F.
- **Test T:** copy signals with block time in [14:00:00, 14:50:00). Exits may use trades up to 15:20:00.
- T data is not read before the analysis code is frozen and committed. Simulation code is developed on F data only.

## Wallet scoring (F only)

Per wallet and token, using the SOL the wallet actually paid or received: buy = `user_quote_amount_in` (all fees
included) or the pump.fun `sol_amount` plus fees; sell = net amount received.

- PnL per token = realized PnL (average cost) plus the remaining position marked at the end of F. The mark is the SOL
  received by selling the whole remainder into the pool at the last reserves of F (constant product, fees included).
- **Eligible (S1)** if all of the following hold:
  - bought at least 5 distinct tokens in F;
  - sold at least 90% of the position in at least 3 of them;
  - bought at least 0.5 SOL in total;
  - net PnL above 0;
  - positive PnL on at least 55% of the tokens it bought.
- **Exclusions**, applied before ranking:
  - (a) the wallet created any token it traded (dev);
  - (b) at least 20% of its first buys landed in the token's creation slot (bundle / insider);
  - (c) co-buy clusters: two eligible wallets whose first buys of the same token fell in the same slot on 3 or more
    tokens are linked, and only the best-scoring wallet of each linked group is kept. Funder tracing is not done (no
    budget) and is listed as a limit.
- **S1** = top 50 eligible wallets by net PnL in SOL.
- **S2** = S1 rules plus a median hold of at least 60 s, measured from the first buy to the first sell per token
  (wallets a 2-30 s copier can follow). Top 50 by net PnL.
- **Control C0** = every wallet with at least 5 tokens bought in F, with no PnL filter. Tells us whether selection adds
  anything.

## Signals (T)

- A signal is a selected wallet's **first buy of a token** seen in the whole collection, of at least 0.05 SOL, with
  block time in T.
- Each token is copied once per selection set: the earliest signal wins.

## Copy simulation

- **Delay:** our buy fills against the pool state at the end of slot `s + d`, where `s` is the signal slot and `d` is
  1, 5, 25 or 75 slots (about 0.4 s, 2 s, 10 s and 30 s). The 1-slot cell is also reported at the start of slot `s + 1`
  (optimistic).
- **Pool state:**
  - Bonding curve: the virtual reserves after the last trade of the slot, in stream order.
  - PumpSwap: the "before" reserves of the next trade, or the last trade's reserves plus its own change.
  - If a token migrated while held, its pool continues the series.
- **Fills:** constant product on reserves at the real size, so price impact comes from reserves.
  - Fees per side: PumpSwap uses the LP, protocol and creator bps recorded in the event; the bonding curve uses 1.25%.
  - Plus 0.5% adverse fill/MEV per side (the base case of the RES-1 study; 0% reported as sensitivity).
  - Fixed cost per round trip: 0.00026 SOL (base fee, priority fee and 25% retry allowance, same as RES-1). Token
    account rent is recovered.
- **Sizes:** $2, $5, $50 and $200, converted to SOL at Jupiter's SOL price read when the analysis runs.
- **Exits**, checked on every later trade in the token (the mid price after each trade):
  - **E1 mirror:** sell `d` slots after the leader's first sell of the token, or at the 30-minute time stop.
  - **E2 own:** stop at -30%, take-profit at +50%, time stop at 30 minutes, measured on mid price from our fill.
    Executed `d` slots after the trigger, at the pool state then.
  - If a token has no trade after the trigger, the exit fills at the last state.
- Net return = (SOL out - SOL in - fixed costs) / SOL in.

## Grid and decision rule

- Grid: {S1, S2, C0} x {1, 5, 25, 75 slots} x {$2, $5, $50, $200} x {E1, E2} = 96 cells, plus the optimistic 1-slot
  variants. All cells are reported.
- **Primary cell:** S2, 5 slots (about 2 s), $5, E1.
- Statistics: n, mean and median net return, bootstrap 95% CIs (10,000 resamples, seed 7), win rate, worst trade.
- **Decision:** copying is a "hypothesis for paper mode" only if the primary cell has a mean net return above 0 **and**
  a 95% CI lower bound above 0, with n of at least 30. Otherwise the verdict is "not a usable entry signal on this
  evidence". Any other cell that clears this bar is reported as a hypothesis, flagged for multiple comparisons (96 cells).
- Also reported:
  - leader persistence: the selected wallets' own PnL in T against their PnL in F;
  - the share of signals where the price had already moved more than 10% between the leader's fill and ours.
