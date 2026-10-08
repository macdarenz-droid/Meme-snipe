# W1 tape code: open questions

These are the places where PREREG.md and AMENDMENT_1.md are silent or ambiguous. AMENDMENT_2, AMENDMENT_3 and AMENDMENT_4 have since ruled on several of them; each ruled item says so and states what the code now does. Any Q not marked was confirmed as read. For each one the code takes the reading marked **Chosen**. Where the readings differ in how strict they are, the chosen one is the conservative one; that is marked "(conservative)". A reviewer can overturn any of them before the primary is scored. The Q numbers match the references in the code.

## Costs and cash
- **Q1. Is tx_fee on S?** *Ruled (AMENDMENT_2): as below.* AMENDMENT_1 assumed that S has no `tx_fee`. Every cached unit, v1 and v2, carries the scanner's `tx_fee` and `jito_tip` on every trade row (0 missing in the units checked). **Chosen:** the amendment's first branch, "uses it as written". The amendment's fallback (cost = signer SOL change − swap SOL − identified rent, split over the transaction's swaps, used only when the signer owns every swap; otherwise the fixed cost per leg) is implemented and fixture-tested. It runs only on rows where `tx_fee` is missing, and the manifest counts rows by cost source.
- **Q2. Which fees count?** *Ruled (AMENDMENT_2).*
  - When the signer owns every swap of a transaction (all SOL-quoted, `tx_fee` present), the cash is the signer's SOL change less identified token-account rent, split evenly over the swaps. App fees paid by separate transfers are then counted.
  - Otherwise the venue method applies: event fees plus `tx_fee + jito_tip`.
  - Every position also keeps the venue-method cash (`*_alt`). The scored stages report the share of positions and of |P&L| under each method, and the top decile's mean return under both.
  - **Q35: identifying rent.** *Confirmed (AMENDMENT_5), with rents by date.* The candidate rents are (128 + size) × lamports per byte in force at the slot, for 170 bytes (Token-2022) and 165 bytes (SPL):
    - 6,960 before 2026-09-03: 2,074,080 / 2,039,280;
    - 6,333 from 2026-09-03: 1,887,234 / 1,855,569;
    - 5,080 from epoch 1033: 1,513,840 / 1,488,440.
    - Opening a mint (a buy from zero) adds back the smaller rent, only when the SOL spent beyond fees is at least that large.
    - Closing (a sell to zero) subtracts the candidate nearest to a visible refund. When app fees hide the refund, it subtracts the larger rent (conservative).
    - The signer method is refused, and the venue method used, when the implied app fee is negative or above 5% of the SOL traded + 0.01 SOL. A persistent WSOL account, for example, would show such a change. See Q37.
  - Cashback is counted as paid. Rent is otherwise not counted.
- **Q3. How are marks priced?** **Chosen:**
  - The fee rate is the sum of the rates the venue's last trade paid, with one ceil on the summed rate. Core rounds each part up, so this differs by a few lamports.
  - Marks inside the vectorised ledger use float64 (within about 1 lamport of the integer quote; tested).
  - The replay uses exact integers.
- **Q4. What is "the repo's fixed cost per leg" (AMENDMENT_1)?** **Chosen:** edge-costs.ts `expectedFixed()` ÷ 2 = 207,005 lamports. The alternative is the landed leg alone (30,000). It is used only where `tx_fee` is missing.
- **Q29. Which swaps share the transaction cost?** *Ruled (AMENDMENT_3).* `tx_fee + jito_tip` is charged only to the transaction's included rows (SOL-quoted, owner not excluded, not protocol flow), split evenly over them. One owner of every included row pays all of it; excluded rows pay nothing.

## Traders
- **Q5. What does "a transfer ran between them" mean?** *Confirmed (AMENDMENT_2).* **Chosen:** the literal reading. Two owners are joined only by a direct W or T link between them; union-find then chains such links.
  - A hub is an address with more than 50 distinct owner neighbours over links made on or before the cluster day.
  - Excluded addresses (pools, curves, off-curve, fixed vaults and authorities) never join.
  - The alternative also joins through non-owner intermediaries such as a common funder. On 2 dev units it merged 4,495 owners into one cluster, against a largest cluster of 44 under the literal reading. `hub_effect` reports it, and it is never used.
- **Q6. What is a "pump mint" (T links)?** **Chosen:** a mint traded on the pump curve, created by CreateEvent, or the base mint of a canonical PumpSwap pool (as of that day), plus mints whose address ends in `pump`.
- **Q23. Which addresses are excluded?** (Review item 4: every swap in a transaction that emitted a `BoostBuyAndBurnEvent` in E is protocol flow, matched by slot and tx_idx, the same in every schema version.)
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
- **Q22. When is a start "unknown"?** *Ruled (AMENDMENT_2).*
  - Balances are tracked per `user_token_account` (and per T `from_account`/`to_account`) and summed per owner.
  - A swap checks `owner_token_pre/post` against the sum of the accounts the transaction touches. Owners with several token accounts are therefore no longer left out.
  - When a swap touches a single account, its post anchors that account.
  - A start never seen stays excluded until the balance is seen at zero. A gap makes carried positions unknown, and scored runs refuse gaps.
  - Rows dirty only because their start was not seen are flagged (`dirty_start_only`), for Q14.
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
- **Q14. When does the gate kill?** *Confirmed (AMENDMENT_2).* It kills if either Step A day has fewer than 200 slow traders with 20+ counted positions. One exception: the shortfall is on the tape's first day read, and the count reaches 200 when positions left out only for an unseen start are added. That day is then reported as "untestable on the tape's first day". Both Step A days must be present.
- **Q15. How is the ranking built?** A trader whose t is undefined (sd 0) is left out and counted. Ties in t break by trader id. Deciles come from rank: decile = ⌊10·i/N⌋ + 1.
- **Q21. How are the lift and its bounds computed?**
  - The lift is the pooled trade mean of the top decile minus the pooled trade mean of deciles 5–6.
  - The bootstrap resamples traders within each group (10,000 draws, seed 20261008). In validation each trader carries its trades from both test days.
  - Discovery uses the 95th percentile as the one-sided upper bound. Validation uses the 0.25th and 99.75th percentiles.
  - Eligibility (5+ positions) is checked on each test day separately.
- **Q16. How is the replay run?** *Ruled (AMENDMENT_3).*
  - "Delayed 23 slots" means the state at the end of slot (event + 23).
  - A position still held at day end is marked at the day-end executable sell, with no delay.
  - A position with no buy on the test day is not replayed and is counted.
  - Our own buy is not applied to the exit state.
  - An exit the real vault cannot (fully) pay scores what it pays, so the unpaid part is −100%.
  - A trade whose entry or exit slot was not read, or whose mint has no state on the tape, is dropped from the mean and the count. Its share is reported.
  - **Q33** *Ruled (AMENDMENT_5).* An entry the venue refuses although its state is on the tape (pool with no effective quote, curve past its cap) is **no trade**: no SOL is spent, and it is not in the mean or the count. Its share is reported beside the mean. Above 10%, the replay is flagged "mostly not executable at our latency". The rule test does the same.
  - The units come from the ledger's manifest, never the cache.
- **Q27. How is validation pooled?** Traders are ranked on 09-07 and tested on 09-08 and on 09-09, with identity as of 09-07 on both.

## Rule extraction and rule test (§8)
- **Q17. Who are the winners?** *Ruled (AMENDMENT_3), as written:*
  - top decile on 09-07;
  - 5+ positions on at least one test day;
  - own mean pooled over the test days it qualifies on is above the pooled mean of deciles 5–6 over the same days;
  - and that own mean is above 0.
- **Q18. What counts as an entry?** **Chosen:** an opening buy (`owner_token_pre` = 0). Matched entries are opening buys by non-winners on SOL-quoted coins in the same `block_time // 600` window, drawn without replacement with a fixed seed. Fewer than 5 are taken when fewer exist.
- **Q31. How are the holder features built?** From S post balances and T movements inside the tape, so holders from before the first day read are unknown. Supply is CreateEvent `token_total_supply`, else 10^15. Excluded addresses are left out of the top 10.
- **Q19. When does the rule fire?** On opening buys by anyone whose as-of features fall in the leaf, with at most one open rule position per mint. Exit is at entry + hold, in slots. The control is a random other SOL coin with a swap in the same 10-minute window, entered at the same slot with the same hold.
- **Q20. How is the 99.5% lower bound of the rule test computed?** *Ruled (AMENDMENT_2).* As a pool-clustered bootstrap (pools = mints) stratified by day, 0.25th percentile. Every Step C day must have rule trades.
- **Q32. Missing features.** A missing feature (for example curve progress on a pool) is coded as −10^18, below every value, so the tree can split on it.

## Not code questions
- **Q30. Was W kept?** §2 says W is kept only if Phase 0 allows. W is present in every cached unit. If it is absent, the code records the limitation and clusters use T only.
- **§9.4.** Committing the code, seeds and input hashes before the validation days are read is the supervisor's step. `ledger` writes the hashes to WORK/manifest.json.

## Added with the amendments and the review
- **Q34. Flipper rows (AMENDMENT_4).** *Confirmed (AMENDMENT_5).*
  - A round trip runs from the owner's balance leaving zero to its return to zero. A token movement or a balance mismatch inside it breaks it.
  - Flipper: 5+ unbroken trips with a median hold of 30 s to 10 min. The class is computed per day, for persistence, and over the tape's days, for the census and flows.
  - Flows around each flipper trip are measured in SOL, not prices:
    - other traders' net buy SOL inside the trip;
    - the share of it after the first 23 slots;
    - other traders' net sell SOL after the exit, over the trip's own length (the reversal).
  - The census is buy SOL by fast, slow and flipper.
  - These rows change no ranking. Stage `flippers` runs under the same guards.
- **Q36. Plans for Steps B and C.** *Ruled (AMENDMENT_5).*
  - Steps B and C run only from `research/shared-tape/stepb-plan.txt` and `stepc-plan.txt`.
  - Each is checked against the sha256 in the committed `stepb-plan.sha256` / `stepc-plan.sha256`, the same way as Step A against its registered hash. A missing file or a hash mismatch refuses.
  - W1 runs discovery only until a registered gate releases Step B: `validation`, `extract` and `ruletest` refuse while `guard.STEP_B_RELEASED` is False. Flipping it is a reviewed code change.
  - `ruletest` also verifies the extract work it reads.
- **Q37. The signer-method plausibility cap.** *Ruled (AMENDMENT_6): the cap is confirmed and the primary uses the capped method. Validation's "top-decile mean above 0" must hold under both the capped and the uncapped signer method; otherwise the verdict is "persistence depends on cost attribution" and it is not a pass.*
  - AMENDMENT_2 does not have the cap: an implied app fee below 0 or above 5% of the SOL traded + 0.01 SOL keeps the venue method.
  - It is kept. Every row also carries the signer method without the cap (`*_nc`).
  - The scored stages report the share of positions the cap moved, and the top decile's mean with the cap, without it, and under the venue method alone.

## Red team R2-8 (2026-10-08)
- **Fee-free rows.** BOOST slices and protocol swaps carry fee fields of 0. A venue state after one keeps its reserves but takes the fee rate of the venue's last fee-paying row (same mint and class), or, before the first such row, the dearest rate `ledger.FALLBACK_BPS` (125 bps; red team R2-11: no later row is read) (`ledger._paid_bps`, used by `States.asof` and `States.advance`). Replays, rule-test fills and marks therefore never trade fee-free.
- **Q38. Seat-cost tag (AMENDMENT_7; reading, for the lead).**
  - Per trader and day: the median of the transaction's whole `tx_fee + jito_tip` over its trades (buys and sells; rows with no `tx_fee` left out), in SOL. This is MIG-SEAT's G2 measure.
  - The median within-slot rank of its buys: the dense rank of the buy's transaction among the slot's SOL-quoted swaps of the same mint, 1 = first.
  - The tag is reported per class (quartiles) in `gate`, and for the winners beside any extracted rule. It never enters the class or the ranking.
  - W1 ranks slow traders only, so a rule never comes from fast winners. `rule.json` still names MIG-SEAT's seat estimate as the reference.

## Red team R2-12 (2026-10-08, parent's ruling on Q-R2-c)
- **Replay rent by date.** The §7 replay and §8 rule test charge edge-costs' fixed costs with rent (128 + 170) × the lamports per byte at the entry slot (6,960 / 6,333 / 5,080), as D1, G1 and H1-CGO (`costs.fixed_round_trip`). The account is taken as 170 bytes (the larger) because the replay does not read the mint's token program. The 6,333 band starts on the date 2026-09-03, as D1 and AMENDMENT_5 Q35 read it; it follows any ruling on Q-R2-b (epoch 1028 began 23:24 UTC that day).
