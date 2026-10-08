# W1 tape code: open questions

These are the places where PREREG.md and AMENDMENT_1.md are silent or ambiguous. For each one the code takes the reading marked **Chosen**. Where the readings differ in how strict they are, the chosen one is the conservative one; that is marked "(conservative)". A reviewer can overturn any of them before the primary is scored. The Q numbers match the references in the code.

## Costs and cash
- **Q1. Is tx_fee on S?** AMENDMENT_1 assumed that S has no `tx_fee`. Every cached unit, v1 and v2, carries the scanner's `tx_fee` and `jito_tip` on every trade row (0 missing in the units checked). **Chosen:** the amendment's first branch, "uses it as written". The amendment's fallback (cost = signer SOL change − swap SOL − identified rent, split over the transaction's swaps, used only when the signer owns every swap; otherwise the fixed cost per leg) is implemented and fixture-tested. It runs only on rows where `tx_fee` is missing, and the manifest counts rows by cost source.
- **Q2. Which fees count?** §4 says "fees included". **Chosen:**
  - The fees in the swap event: curve `fee + creator_fee + cashback`, and PumpSwap `user_quote_amount`. Cashback is counted as paid and never as refunded (conservative).
  - Router and front-end platform fees are not counted. They are paid by separate system transfers outside the swap, so trader P&L is overstated for traders who use such apps. The signer's SOL change would capture them, but only when signer = owner, and §4 does not ask for it. This needs a reviewer's ruling.
  - Token-account rent is not counted.
- **Q3. How are marks priced?** **Chosen:**
  - The fee rate is the sum of the rates the venue's last trade paid, with one ceil on the summed rate. Core rounds each part up, so this differs by a few lamports.
  - Marks inside the vectorised ledger use float64 (within about 1 lamport of the integer quote; tested).
  - The replay uses exact integers.
- **Q4. What is "the repo's fixed cost per leg" (AMENDMENT_1)?** **Chosen:** edge-costs.ts `expectedFixed()` ÷ 2 = 207,005 lamports. The alternative is the landed leg alone (30,000). It is used only where `tx_fee` is missing.
- **Q29. Which swaps share the transaction cost?** `tx_fee + jito_tip` is split evenly over every swap row of the transaction, including non-SOL and excluded rows.

## Traders
- **Q5. What does "a transfer ran between them" mean?** **Chosen:** the literal reading. Two owners are joined only by a direct W or T link between them; union-find then chains such links.
  - A hub is an address with more than 50 distinct owner neighbours over links made on or before the cluster day.
  - Excluded addresses (pools, curves, off-curve, fixed vaults and authorities) never join.
  - The alternative also joins through non-owner intermediaries such as a common funder. On 2 dev units it merged 4,495 owners into one cluster, against a largest cluster of 44 under the literal reading. `hub_effect` reports it, and it is never used.
- **Q6. What is a "pump mint" (T links)?** **Chosen:** a mint traded on the pump curve, created by CreateEvent, or the base mint of a canonical PumpSwap pool (as of that day), plus mints whose address ends in `pump`.
- **Q23. Which addresses are excluded?**
  - The BOOST vault has no fixed address on the tape. Boost buy-and-burn rows carry no owner and are dropped as protocol flow, and the `authority` of every `BoostBuyAndBurnEvent` is excluded.
  - Mayhem vault: `BwWK17…`. Buyback authority: `GmFrDZT2…`.
  - Pools and curves come from S and E.
  - Rows flagged `protocol` ≠ 0 are excluded.
  - Off-curve is tested with curve25519-dalek's decompression rule.

## Positions and P&L
- **Q7. What is a position?** **Chosen:** one trader, one mint, one day, so several round trips in a day are one position (fewer positions, so conservative for the 20/5 thresholds).
- **Q8. What does "P&L ÷ SOL paid in" divide by?** **Chosen:** P&L ÷ (start-of-day mark + SOL paid in that day). SOL paid in is buys with their cost share, plus tokens received from outside the trader at their mark; a transfer inside the trader is excluded. For a position opened and closed the same day this equals SOL paid in. A carried position with no buy would otherwise divide by zero.
- **Q9. How are unresolved mints treated?** T_coverage `unresolved` marks a mint from its first slot onward. Any row active or held at or after that slot is left out, on every later day too (conservative).
- **Q10. How are mints with partial movement coverage treated?** These are mints with scope `pump_transactions`, mostly non-`pump` addresses. A position held at day end in such a mint is left out, because unseen transfers could change it (conservative). A closed position is kept, because its swaps' pre and post balances check it.
- **Q22. When is a start "unknown"?**
  - A position whose first swap reports a balance the tape did not build (`owner_token_pre` ≠ the tracked balance) is left out until it is seen at zero. This covers positions opened before the first day read.
  - Any gap in the slots read makes every carried position unknown.
  - Any day with a balance mismatch, a movement that could not be valued, or a mint-to receipt is left out (conservative).
  - Observed: `owner_token_pre/post` sum only the accounts the transaction touches, so owners with several token accounts mismatch and are left out.
  - On the first day read most rows are left out. On 2 dev units: 311k owner-mint rows, of which 196k were dirty, mostly starts not seen.
- **Q24. Are non-SOL quotes used?** Curves and pools quoted in anything but SOL or WSOL are not used (P&L is in SOL).
- **Q26. What is a day?** A day is the tape's day label (a UTC day). Its end is the last slot read for it.
- **Q28. How are movements valued?** A transfer is valued at the executable sell of the moved amount, at the state after the transaction's swaps. A burn loses the tokens at zero value. A mint-to receipt makes the position dirty.

## Latency class
- **Q11. What about a trader with no buy that day?** **Chosen:** slow. The share denominators are all of the trader's SOL-quoted buys that day.
- **Q12. What do "within 2 slots of" and "after another trader's buy" mean?**
  - Create or migration: |slot − event slot| ≤ 2, either side. G is CompleteEvent, CompletePumpAmmMigrationEvent or CreatePoolEvent.
  - Following: the latest earlier buy (in transaction order) of at least 1 SOL by a different trader (clusters of that day) is at most 2 slots before. "1 SOL" is SOL paid including venue fees. Buys by excluded owners count as another trader's buy (conservative: more traders classed fast).

## Gate and persistence
- **Q13. What are the size bands (§6)?** §6 does not define them. **Chosen:** SOL paid in per position: < 0.1, 0.1–0.5, 0.5–2, 2–10, ≥ 10 SOL.
- **Q14. When does the gate kill?** **Chosen:** if either Step A day has fewer than 200 slow traders with 20+ counted positions (conservative).
- **Q15. How is the ranking built?** A trader whose t is undefined (sd 0) is left out and counted. Ties in t break by trader id. Deciles come from rank: decile = ⌊10·i/N⌋ + 1.
- **Q21. How are the lift and its bounds computed?**
  - The lift is the pooled trade mean of the top decile minus the pooled trade mean of deciles 5–6.
  - The bootstrap resamples traders within each group (10,000 draws, seed 20261008). In validation each trader carries its trades from both test days.
  - Discovery uses the 95th percentile as the one-sided upper bound. Validation uses the 0.25th and 99.75th percentiles.
  - Eligibility (5+ positions) is checked on each test day separately.
- **Q16. How is the replay run?**
  - "Delayed 23 slots" means the state at the end of slot (event + 23).
  - A position still held at day end exits at the day-end state with no delay.
  - A position with no buy on the test day (carried in) is not replayed and is counted.
  - Our own buy is not applied to the exit state (conservative).
  - Slots beyond the last one read are capped to it.
  - The replay mean is the point mean over the trades replayed.
- **Q27. How is validation pooled?** Traders are ranked on 09-07 and tested on 09-08 and on 09-09, with identity as of 09-07 on both.

## Rule extraction and rule test (§8)
- **Q17. Who are the winners ("whose test-day lift held")?** **Chosen:** top-decile traders whose own mean test-day return is above the pooled mean of deciles 5–6.
- **Q18. What counts as an entry?** **Chosen:** an opening buy (`owner_token_pre` = 0). Matched entries are opening buys by non-winners on SOL-quoted coins in the same `block_time // 600` window, drawn without replacement with a fixed seed. Fewer than 5 are taken when fewer exist.
- **Q31. How are the holder features built?** From S post balances and T movements inside the tape, so holders from before the first day read are unknown. Supply is CreateEvent `token_total_supply`, else 10^15. Excluded addresses are left out of the top 10.
- **Q19. When does the rule fire?** On opening buys by anyone whose as-of features fall in the leaf, with at most one open rule position per mint. Exit is at entry + hold, in slots. The control is a random other SOL coin with a swap in the same 10-minute window, entered at the same slot with the same hold.
- **Q20. How is the 99.5% lower bound of the rule test computed?** As a percentile bootstrap over trades (0.25th percentile).
- **Q32. Missing features.** A missing feature (for example curve progress on a pool) is coded as −10^18, below every value, so the tree can split on it.

## Not code questions
- **Q30. Was W kept?** §2 says W is kept only if Phase 0 allows. W is present in every cached unit. If it is absent, the code records the limitation and clusters use T only.
- **§9.4.** Committing the code, seeds and input hashes before the validation days are read is the supervisor's step. `ledger` writes the hashes to WORK/manifest.json.
