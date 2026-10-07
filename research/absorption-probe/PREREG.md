# Absorption probe: rules fixed before any return is computed

Tests the entry in `HYPOTHESIS.md`. Nothing here enters the bot, attempt 1 or any holdout.

**Status (2026-10-08):** these are the definitions used for the Step 1 count, fixed before any exit price or return
was read. Step 1 found too few events (`RESULTS.md`: 5 tradable A events, 30 needed), so the run stopped there:
no return was computed and this file did not go through the pre-return review. A future run on a better data
source should take it through that review first. A rule changed after this commit is a new trial and is reported
as one.

## Data and period
- Swaps: Helius RPC (owner's paid account), read-only. `getTransactionsForAddress` (full transactions, oldest first,
  successful only) on the pool address; PumpSwap Buy/Sell events from inner `emit_cpi` instructions whose `pool`
  is the pool. Ordered by (slot, `transactionIndex`, inner order). Decoding and the reserve rules are those of
  `../execution-audit` (pre-swap reserves in each event; effective quote = real + `virtual_quote_reserves`; the
  pool's quote moves by `quote_amount_in_with_lp_fee` / `quote_amount_out_without_lp_fee`). Marginal price
  P = (Q + V) / B in SOL per token.
- Bars: GeckoTerminal, keyless, in SOL (`currency=token`): daily (pre-screen), 1-minute (candidate screen, return
  features), hourly (exit decisions, 24 h return feature). Every event is confirmed on swaps.
- Period: decisions 2026-07-22T00:00Z to the wall 2026-09-21T14:00Z; no data after the wall is read.
  Period A = entries before 2026-08-21T00:00Z, period B = from then. Both reported.
- No pump.fun request of any kind. Raw responses stay outside the repo.
- Credits: hard cap 2,000,000, counted 10 per standard call and 100 per `getTransactionsForAddress` call
  (conservative). Rate ≤ ~9 requests/s.

## Universe (known bias stated)
- `../deep-pool-probe/eligible.json`: the 163 pools of the 481-coin survivor list that closed a day at ≥ 9,820 SOL
  market cap. **Survivors only:** coins worth about $81k or more on 2026-10-06. This favours recoveries (coins that
  later died are missing), which flatters every group's returns, and may flatter A (a recovery rule) more than B or C.
- The lottery random sample (900 graduates, survivorship-free) is **not** included. Reason: a $50 round trip below
  1.5% needs about the 0.70% fee tier or lower (from 34,380 SOL market cap, ~$4.1M; the 36,000 SOL pre-screen below leaves a small band of it out), and the daily probe found only
  3 of those 900 coins ever eligible even at 9,820 SOL. Fetching it would not add usable events at this size.
  The 16,367-coin survivorship-free list is downloading elsewhere and is not used here.
- Pre-screen (no outcome): pool-days whose own or previous daily close × 1e9 ≥ 36,000 SOL; 1-minute bars are fetched
  for those days plus 3 h before (63 pools, 1,636 pool-days; 55% were downloaded before the count stopped, see `RESULTS.md`).

## Eligibility at the decision moment (all groups)
At the trigger swap (the decision):
1. pool age ≥ 24 h (age from the pool's first successful transaction);
2. estimated $50 round-trip cost < 1.5%: buy q = $50 / 119.26 = 0.41925 SOL against the state after the trigger
   swap and sell the tokens straight back, constant product on effective reserves, with the total fee (LP +
   protocol + creator bps) logged in that swap's event, plus `lottery.FIXED` (414,009 lamports) / q.

## Screens (candidates only; frozen)
- Large-drop bar candidate: minute m with the lowest low of m..m+5 at least 10% under the close of m−1, that
  close × 1e9 ≥ 36,000 SOL, a real bar within the hour before, at most one per 30 minutes per pool.
- Processing order: **tier 1** (bar drop ≥ 15%) in full; **tier 2** (10–15%) in a seeded random order as the
  credits allow, its yield reported (a 10% extraction drops the price 19% when nothing offsets it, so tier 2
  holds sales partly absorbed while they happened). Within a tier the order is seeded random, so a credit stop
  leaves a random subsample.
- Skipped without swap confirmation (counted): pool younger than 24 h at any possible decision; **activity cap:**
  ≥ 1,000 successful transactions touching the pool in the 10 minutes before the bar (busy launch-phase pools,
  about 8 of 63; one such window costs 30,000–300,000 credits). This leaves out the busiest moments, mostly
  coins in their first days; results describe calmer, established pools only.
- A window over 400 pages (40,000 transactions) is dropped and counted.

## Large sale (swap level)
- Swaps fetched from 6 min before the bar candidate to 11 min after (stage 1), then to the sale end + 62 min (stage 2).
- A **large sale** = one wallet (the event's `user`) whose sells with block time in [t₁, t₁ + 300 s] take out of the
  pool at least 10% of the effective quote reserve logged in the first of those sells (t₁ = that sell's time).
  The first sell must lie in [bar − 6 min, bar + 6 min]. The earliest qualifying first sell wins. Recorded: seller,
  pre-sale reserves (B, Q, V) and pre-sale price P_pre (marginal price before the first sell), extraction, sells.
  Sale end = the seller's last sell in that 300 s window.
- **No entry on the drop.** Overlaps: an event whose first sell falls within 60 min after an earlier kept event's
  sale end in the same pool is marked overlap and not traded (applied in time order after processing).

## Funding groups (a heuristic)
- A wallet's **funder** = the source of the first SOL transfer into it: in its oldest successful transactions
  (up to 3, oldest first), the first System `Transfer`, `CreateAccount` or `TransferWithSeed` crediting it; if
  none and its balance went from 0 to above 0, the fee payer. One hop. History is read with
  `getSignaturesForAddress` (1,000 signatures before the wallet's first buy in the window); if that page is full,
  the oldest transactions come from an oldest-first query limited to block times before that buy. **Every lookup
  uses only transactions before the wallet's own first buy (or the seller's first sell)**, so before the entry.
- **Hub** (exchange-like, non-informative): a funder with ≥ 1,000 transactions in the 24 h before that buy.
  Hub-funded wallets count as their own group.
- Groups = connected components of wallets joined to their non-hub funders (a wallet funded by another buyer
  joins its group). Unresolved funders: own group.
- The **seller's group** (the seller, its funder unless a hub, and every wallet linked to them) never counts
  toward K; its buys still count in the shares (as one group).
- Dust: a buyer counts only with ≥ 0.1 SOL bought after the sale end (up to the swap being tested).
- Plain words: shared first funding is a common but incomplete sign of common control. Wallets funded through
  exchanges, mixers or long chains look independent here; this can only overstate independence.

## Groups and entries
- **Group A (absorption):** the first swap s after the sale end, with block time ≤ sale end + 60 min, where all hold:
  (a) P after s ≥ P_pre; (b) effective quote reserve after s ≥ 80% of the pre-sale effective quote reserve;
  (c) among buys strictly after the sale end up to and including s: at least K = 5 groups other than the seller's;
  (d) no group above 40% of that buy SOL. Funding is checked only at swaps where (a) and (b) hold.
- **Group C:** qualifying large sales with no such swap. Trigger = the first swap with block time ≥ sale end + 60 min
  (later swaps are fetched for quiet pools).
- **Group B (ordinary recovery):** from 1-minute bar candidates (first minute m with close[m] ≥ close[m−60],
  the lowest low of m−59..m ≤ 0.9 × close[m−60], volume > 0, close[m−60] × 1e9 ≥ 36,000 SOL; no large-drop bar
  rule hit in the 2 h before m, using only bars up to m; one per hour per pool). Confirmed on swaps from 66 min before
  m to 6 min after (plus the last earlier swap): the first swap s with block time in [m − 5 min, m + 5 min] where
  P after s ≥ P_ref (price after the last swap at or before s − 60 min); the lowest post-swap price strictly between
  that swap and s ≤ 0.9 × P_ref; the sells from the reference to that low come from ≥ 5 wallets with none above 50%
  of their quote; and no qualifying large sale (rule above) has its first sell in [s − 60 min, s].
- **Entry (all groups):** at the trigger plus L slots, L ∈ {2, 10}; **primary L = 10**. Our buy lands after all swaps
  with slot ≤ trigger slot + L: tokens = B·x / (Q + V + x), x = q / (1 + f), q = 0.41925 SOL ($50), f from the last
  swap of that state. Entry price P_e = the marginal price of that state. Our trade is not fed back into history.
- Traded events: A and C that are eligible, not overlap, with a complete entry state before the wall; B that are
  eligible and matched.

## Matching B to A (3 per A)
- Features at entry: pool age (< 7 d, 7–30 d, ≥ 30 d); effective quote reserve (< 1,000, 1,000–2,500, ≥ 2,500 SOL);
  prior 1 h return from 1-minute closes (< −5%, ±5%, > +5%); prior 24 h return from hourly closes (< −20%, ±20%,
  > +20%); ISO week; period. Returns use only closes of bars that ended before the entry.
- For each A in time order, bar candidates are taken in a seeded random order within relaxation levels:
  L0 same week, age, 1 h and 24 h buckets; L1 week ± 1; L2 drop the 24 h bucket; L3 drop the 1 h bucket;
  L4 same period and age; L5 same period. A confirmed B is matched only if eligible and in the same liquidity bucket
  (checked on swaps) and still meets the level at its swap-level entry. Each B is used once. At most 8 swap
  confirmations per A; shortfalls reported.

## Exit (frozen R1, hourly-close version; the execution audit found it executable)
- Decisions on GeckoTerminal hourly bars from the entry's hour: stop when the hourly low ≤ 0.7 P_e (before arming;
  the entry's own hour uses its close, since its low may predate the entry); arm when the peak hourly close (bars
  with volume) ≥ 2 P_e; trail when the close ≤ 0.6 × peak; time exit 14 days after entry. Missing hours carry the close.
- Fill: sell all tokens against the real reserves after all swaps with slot ≤ (the first swap at or after the
  deciding bar's end).slot + L (the same L as the entry), pool fee from that swap. Source: swap events (Helius).
- Positions still open at the wall: sold against the last state before the wall (flag `wall`).
- Net (in SOL, share of the stake) = proceeds / q − 1 − FIXED / q.
- Sensitivity lines: (i) "data ends": an exit with no swap after the decision before the wall booked at −100% − fixed;
  (ii) wall-censored trades excluded.

## Statistics and verdict (fixed)
- Primary, at L = 10, all periods: (1) group A mean net, each trade capped at +19 (20× proceeds), with a 95%
  interval clustered by UTC entry day (cluster-robust standard error, t with days − 1 degrees of freedom);
  (2) A − B: for each A, its net minus the mean of its matched B (each capped), the same day-clustered interval.
- Also reported: A − C (difference of capped means, day bootstrap), medians, win rates, counts with proceeds ≥ 2× and
  ≥ 5×, the cost paid (entry fee and impact + exit fee and impact), uncapped means, a day bootstrap for (1), L = 2,
  periods A and B, and both sensitivity lines.
- **Verdict:** fewer than 30 traded A = **unresolved** (not success). Otherwise **killed** if A's mean ≤ 0 or
  A − B's mean ≤ 0; **supported** only if both lower bounds are > 0; else **not shown (shelved)**.
  Kill rule as in HYPOTHESIS.md: shelve the entry if the selected trades lose after realistic execution or do not
  beat comparable ordinary recoveries. Even "supported" means only: a forward test, never a deposit.
- Every rejected candidate is kept in the data tables with its reason.

## Known limits (stated now)
- Survivor-only universe (above). Counterfactual fills. The activity cap removes the busiest moments.
- Funding groups are a heuristic; the hub threshold and one hop are choices, not proven.
- GeckoTerminal hourly bars can carry prints that never appear in swaps (execution audit); exit decisions inherit that.
- Exit latency L is a stand-in for detection plus landing time.
