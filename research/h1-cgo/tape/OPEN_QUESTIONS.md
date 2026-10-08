# H1-CGO scoring: open questions

**Resolved by `../AMENDMENT_1.md` (2026-10-08): all 25 readings below are confirmed as written.** `../AMENDMENT_2.md` sets the rent by date. Both changes are listed below, with the BOOST handling for decoder v3. Each item was a point where `../PREREG.md` is silent or ambiguous; the code uses the reading marked **Used**, the more conservative one.

## Changes from the amendments and decoder v3
- **Rent (AMENDMENT_2, replacing amendment 1's flat figure).** Rent = (128 + account size) × the lamports a byte in force at the trade's entry slot, with RENT-1's refund model (`pumpswap.token_account_rent(program, slot)`, applied per trade in `outcomes.run`).
  - Rates: 6,960 before epoch 1028; 6,333 from epoch 1028; 5,080 from epoch 1033.
  - Account sizes: Token-2022 170 bytes, SPL Token 165; an unknown program is charged 170.
  - Token-2022 rent is 2,074,080, 1,887,234 or 1,513,840 lamports.
  - **Reading used:** the band comes from the slot's epoch (slot ÷ 432,000), because the rate changes at epoch boundaries. Epoch 1028 began 2026-09-03 23:24 UTC (`docs/research/execution.md` F1), so from 00:00 to 23:24 on 09-03 the dearer 6,960 applies. No day in this design's sets is affected.
  - The repo's 1,513,840 remains only in the parity check with `research/edge/costs.json`. Item 15's fixed cost follows this rule.
- **Other protocol addresses (item 10).** None is added, because none held tokens. One is to be added if an address appears whose tokens come only from protocol instructions.
- **BOOST swaps.** Decoder v3 sets `protocol=1` on BOOST swaps. Older units leave it 0, so an S_amm row also counts as protocol flow when its (signature, outer_ix, pool) matches a `BoostBuyAndBurnEvent` in E (`features.boost_keys`). On 09-11 unit 446265000-446269499, 651 of 651 events matched exactly one row each. Protocol rows never enter the holder ledger, and their owner is excluded as `protocol`.

## Timing
1. **Decision slot.** §3 says "each whole UTC hour" without naming the slot. **Used:** the last slot whose block time is before the hour, and only when a later block in the same contiguous tape stretch shows the hour has closed. No row from the hour itself enters the features.
2. **Exit timing.** §6 says "60 minutes after entry (+ D slots)". **Used:** the last slot before (entry slot's block time + 60 min), plus 23 slots. The same rule applies to the 15-minute and 4-hour holds.
3. **Last slot read.** §2 drops a decision whose window ends after the last slot read. **Used:** the end of the contiguous run of units that holds the coin's creation. A gap in the units between creation and a decision removes that decision point, because the holder history would be incomplete.
4. **Migration time.** **Used:** the block time of `CompletePumpAmmMigrationEvent`, the G row that names the pool.

## Universe and eligibility
5. **Unresolved ownership.** The tape marks a coin `unresolved` in `T_coverage` (for example after an owner change or an undecoded transfer). From that point the holder ledger cannot be trusted. §4 is silent on this. **Used:** a decision point at or after a coin's first `unresolved` mark is not eligible.
6. **Pool state between trades.** **Used:** the state after the last PumpSwap trade at or before the slot. A deposit or withdrawal shows up only at the next trade. LP tokens are burned at migration, so this should be rare. The real vault is the on-chain balance when the tape has it (`last_in_tx`), and the v1 vault update otherwise. Check on 2 units: 50,224 consecutive trade pairs gave 0 mismatches against the next trade's pre-trade state.
7. **Validation sample.** §2 names the validation days but not whether a coin created on 09-09 can enter with a decision on 09-10. **Used:** decision day and creation day must both be in the stage's own day set (`--creation-days` defaults to `--decision-days`). One run may not mix discovery and validation days.

## Cost basis (§4)
8. **"Fees included."** **Used:** the venue fees. On the curve that is `sol_amount + fee + creator_fee`, where the buyback share is part of `fee`. On PumpSwap it is `quote_amount_lp_adjusted + protocol_fee + coin_creator_fee`, which covers both buy instructions. Transaction fees, tips and rent are left out because the signer pays them, and the signer may not be the owner.
9. **Tokens of unknown origin.** **Used:** these are unknown-cost tokens: a `mint` movement; a transfer from an account with no known cost (the pool, the curve or an unknown holder); and tokens sent beyond what the ledger shows the sender holding. The overdraw is counted. Movement rows with an empty owner are left out, as the tape's holder-rebuild rule says.
10. **Protocol and burn accounts.** §4 lists the classes but not their addresses. **Used:**
    - bonding curve: the `CreateEvent` curve address;
    - pool: the migration pool address;
    - burn: the incinerator;
    - protocol: the buyback authority `GmFrDZT2…` and every owner of an S row the tape flags `protocol`.

    BOOST buy-and-burn rows have an empty owner, so their tokens never reach a holder. Each decision point reports the tokens held by each excluded class. **Open:** other protocol addresses, such as fee recipients and global accounts, are not listed. In the check run they held no tokens.
11. **Ledger check.** No rule in the prereg covers this. The code compares the ledger with the tape's `owner_token_post` at the end of each transaction and counts mismatches (`owner_checks`, `owner_mismatch`). It reports the counts and corrects nothing. Check on 2 units: 79 mismatches in 47,201 checks, from 4 coins.

## Pricing and costs (§6)
12. **Fee tier.** **Used:** the PumpSwap tier table in `research/edge/snapshot/fee-configs.json` (October), applied to the market cap of the state being priced. Check on 2 units of 09-11: 49,673 of 49,673 canonical SOL trades matched the tape's own fee bps (572 zero-fee rows were skipped). A creator-fee override is not modelled; the check run found none. An empty `coin_creator` is treated as charged, the dearer reading.
13. **Refused quotes.** **Used:** if either state at the entry slot refuses the buy, there is no trade, and it is counted. If either state at the exit slot refuses the sell (the vault cannot pay), the trade receives 0 SOL: a total loss.
14. **Size.** **Used:** $50 = `floor(50 / 119.26 × 1e9)` = 419,252,054 lamports, the same rounding as edge-costs `spendOf`. The prereg's "0.4193 SOL" is this value rounded.
15. **Gross return and cost.** **Used:**
    - gross = mid of the exit state ÷ mid of the entry state − 1, using the states the trade was priced on;
    - round-trip cost = (fees + impact on both legs + fixed) ÷ SOL paid;
    - net = (SOL received − SOL paid − fixed) ÷ SOL paid.

    Fixed = edge-costs `expectedFixed()` (414,009 lamports with the repo's rent, checked against `research/edge/costs.json`), with the rent as set by AMENDMENT_2 (see above).

## Statistics
16. **Gate (a) count.** "Eligible decision points" could mean every point or one per coin per day. **Used:** the first eligible point per coin per UTC day, which is stricter. Both counts are reported.
17. **Gate (b).** **Used:** simple returns. The gate closes if simple or log returns give R² ≥ 0.8, or if R² cannot be computed. When the coin is younger than 6 hours, the 6-hour return starts from the migration price.
18. **Breakpoints.** **Used:** numpy linear-interpolation percentiles over every eligible discovery point that is in time (not deduplicated). An entry needs CGO strictly above P80 ("high") or strictly below P20 ("low").
19. **Baseline for lift.** §7 and §8 say "all eligible decision points". **Used:** every eligible point that is in time and was priced, not deduplicated, at the same size and with the same costs.
20. **Entries.** **Used:** points are dropped by time first. Then the entry is the first point per coin per UTC day that is eligible and in the extreme.
21. **Bootstrap.** **Used:** percentile intervals. Within each day, pools are resampled with replacement and the resampled trades of all days are pooled. Seed 20261008, set before any scoring. A validation day with no trades fails "mean above 0 on each day".
22. **Futility cost.** §7 says "the median round-trip cost of the discovery trades at $50". **Used:** the median of (fees + impact on both legs + fixed) ÷ paid over the discovery entries of the chosen extreme.
23. **Secondary "holders who bought after migration only."** **Used:** owners with at least one PumpSwap buy and no curve buy, counting their post-migration lots. That CGO gets its own P20 and P80 from discovery, frozen with the rest.

24. **Validation plan.** `research/shared-tape/stepa-plan.txt` lists only 2026-09-10 and 09-11. The validation stage needs Step B's committed plan, passed with `--plan`. Until it exists, validation runs are refused.

## Not done here
25. §9.4 asks for the code, seeds and input hashes to be committed before validation days are read. `features_meta.json` and `frozen.json` record the sha256 of every input file and source file. The commit itself is for the supervisor (this builder runs no git).
