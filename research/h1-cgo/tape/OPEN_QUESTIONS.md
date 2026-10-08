# H1-CGO scoring: open questions

**Resolved by `../AMENDMENT_1.md` (2026-10-08): all 25 readings below are confirmed as written.** `../AMENDMENT_2.md` sets the rent by date. `../AMENDMENT_3.md` adds the D60 arm and, through `research/brainstorm-loop/H8_AMENDMENT.md`, the H8-eligible stratum and count row. All changes are listed below, with the BOOST handling for decoder v3. `../AMENDMENT_4.md` confirms the D and H readings at the end and adds H8's dust check and the committed SOL/USD input. Each item was a point where `../PREREG.md` is silent or ambiguous; the code uses the reading marked **Used**, the more conservative one.

## Changes from the amendments and decoder v3
- **Rent (AMENDMENT_2, replacing amendment 1's flat figure).** Rent = (128 + account size) × the lamports a byte in force at the trade's entry slot, with RENT-1's refund model (`pumpswap.token_account_rent(program, slot)`, applied per trade in `outcomes.run`).
  - Rates: 6,960 before epoch 1028; 6,333 from epoch 1028; 5,080 from epoch 1033.
  - Account sizes: Token-2022 170 bytes, SPL Token 165; an unknown program is charged 170.
  - Token-2022 rent is 2,074,080, 1,887,234 or 1,513,840 lamports.
  - **Reading used:** the band comes from the slot's epoch (slot ÷ 432,000), because the rate changes at epoch boundaries. Epoch 1028 began 2026-09-03 23:24 UTC (`docs/research/execution.md` F1), so from 00:00 to 23:24 on 09-03 the dearer 6,960 applies. No day in this design's sets is affected.
  - The repo's 1,513,840 remains only in the parity check with `research/edge/costs.json`. Item 15's fixed cost follows this rule.
- **Other protocol addresses (item 10).** None is added, because none held tokens. One is to be added if an address appears whose tokens come only from protocol instructions.
- **BOOST swaps.** Decoder v3 sets `protocol=1` on BOOST swaps. Older units leave it 0, so an S_amm row also counts as protocol flow when its (signature, outer_ix, pool) matches a `BoostBuyAndBurnEvent` in E (`features.boost_keys`). On 09-11 unit 446265000-446269499, 651 of 651 events matched exactly one row each. Protocol rows never enter the holder ledger, and their owner is excluded as `protocol`.

- **H8 amendment 2 (red team R2-10).** `research/brainstorm-loop/H8_AMENDMENT_2.md` (frozen) changes the stratum: the floor of the universe the bot would tag (U2 60–240 min with H11; U1 $50k; 4–24 h not tradable), H6, and tradable only at $5. Not implemented yet, so `h8_stratum` reports its rows and `tradable_under_superseded_h8_rule`, and sets `tradable_as_bot_stands` to None.
- **Registered plans (red team R2-5).** `--plan` must be a registered plan (`tapeio.REGISTERED_PLANS`: Step A `fa99c878…` for 09-10 and 09-11, Step B `44f133a5…` for 09-07..09-09), registered for every day used; `features` and every later stage refuse any other plan. This answers item 24's wait for Step B's plan.
- **H8-tradable sample (AMENDMENT_6, red team R1-19).** `h8_stratum` filters each decision point by its own as-of H8 flag first, then keeps the first H8-eligible entry per coin per day (as D1). The unfiltered primary still takes the first entry.
- **Whole discovery (red team R2-4).** `gate0` passes only on both Step A days (`whole_discovery`); `freeze` and `score` refuse breakpoints, sign and futility made from a subset of the discovery days or of their creation days.

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

## Readings for AMENDMENT_3 (confirmed by AMENDMENT_4)

**D60** (`habits.py`, `MintStream.snapshot`, `stats.d60_gate`, `stats.d60_arm`)
- **D1. Round trip.** A position opens on a buy that takes the owner's balance from 0 (`owner_token_pre` = 0, `owner_token_post` > 0). It closes on a sell that leaves 0. The hold time is close time − open time. Round trips on every coin on the tape count. Protocol and BOOST swaps are left out. Positions that open or close by transfer are not seen.
- **D2. Habit.** The median hold time over the owner's round trips that closed at or before the decision slot.
- **D3. Due.** A holder is due when that median ≤ the age of their current position + 60 minutes, so an overdue holder counts as due. The position's age is measured from its open on this coin. A holder with no habit, or no recorded open, adds nothing to D60. A position emptied by a transfer or a burn loses its open, so tokens that come back later are untraceable.
- **D4. Scale.** D60 = due tokens ÷ all tokens of included holders (the float). Realised sells = every token sold on the pool in (decision slot, last slot before hour + 60 min] ÷ the same float. Sells by holders who bought after the decision also count, which makes ρ harder to reach.
- **D5. Habit classifier at ≥ 60%.** The pooled share of (decision point, holder) pairs whose holder has a habit, over eligible, in-time Step A points.
- **D6. ρ lower bound.** A pool-clustered bootstrap stratified by day: 10,000 resamples, the 2.5th percentile.
- **D7. Independence.** R² is OLS with an intercept on r_1h, r_6h, r_mig, vol_1h, volume_1h and CGO:
  - vol_1h is the standard deviation of log changes of trade mids in the past hour;
  - volume_1h is the pool's SOL volume in the past hour.

  Partial ρ is the Spearman partial correlation of D60 and realised sells, controlling for CGO and volume_1h.
- **D8. Traceable float.** Tokens of holders with both a habit and a recorded open ÷ float, pooled.
- **D9. Bottom quintile.** D60 ≤ its P20 over the gate sample, frozen in `frozen.json`. Net flow = SOL paid by buyers (fees included) − SOL received by sellers in the next hour, with protocol and BOOST left out. The row needs a mean above 0.
- **D10. The arm.** It is judged only if the D60 gate passed on Step A and H1-CGO's primary passes. It must meet the four §8 conditions plus a lift over H1-CGO's own entries above 0. D60 ≤ P20 is applied before the first-per-coin-per-day rule.

**H8** (`h8.py`, `stats.h8_stratum`)
- **H1. SOL/USD.** The bot's hourly point: the close of the hour bar that ended at or before the decision hour. A point older than 2 hours, or a missing one, means not eligible (the bot's H16). The input is the Binance public archive's SOLUSDT kline CSVs (1-minute or 1-hour, in ms or µs), and each file's sha256 is recorded. **AMENDMENT_4:**
  - H8's dust-at-migration check is applied as the bot does it: the migration pool's `CreatePoolEvent` `pool_quote_amount` must be at least 5 SOL, and a coin with no such event fails. This only removes points.
  - SOL/USD comes from the committed `research/brainstorm-loop/sol-usd/` (1h points). `gate0` and `score` refuse when:
    - any file listed in `SHA256SUMS` is missing or its sha256 differs;
    - a decision day, or the day before it, lacks its 1h or 1m file;
    - a 1h close differs from that hour's last 1-minute close.
    - `SHA256SUMS` itself does not have the pinned sha256 `02083908…a964` (`h8.SOL_USD_SUMS_SHA256`). `freeze` records that hash in `frozen.json`, and `score` refuses a freeze with any other hash.
- **H2.** Eligibility uses the effective quote as of the decision slot, as the bot evaluates H8 at decision time.
- **H3.** For each size, the stratum keeps the entries of the frozen rule whose pool passes H8 at that size, priced at that size and held 60 min. Its baseline for lift is the H8-eligible eligible points at the same size. It is tradable as the bot stands only if some size has at least 300 trades and a mean above 0. Otherwise the note reads "this works only in pools below H8's floor".
- **H4. Count row** (in `gate0.json`). H8-eligible pool-hours and graduates per day at each size, on two bases: decision points with a pool state, and H1-CGO-eligible points. `--sol-usd` defaults to the committed folder.

## Readings for H8_AMENDMENT_2 (open until the design owner confirms; each is the conservative one)
Code: `h8.universe_tag/floor_micro_usd/tradable/count_rows`, `MintStream._candle/h11`, `features.lp_events_of`, `stats.h8_stratum`.
- **H5. Universe tag by age.** Age is the decision hour − the migration time.
  - U2: 60 ≤ age < 240 min. The end is excluded, which gives fewer tradable points.
  - U1: 24 h ≤ age ≤ 14 days (ARCHITECTURE §3.2).
  - Otherwise there is no tag, and the point is not tradable.
  - The floors are max($15k, 1,000 × size), raised to $50k on U1 (hard.ts `liquidityFloor`).
- **H6. H11 as the bot runs it** (hard.ts `h11`, producer.ts `#addTrade`):
  - **Candles.** 1-minute candles of each pool trade's pre- and post-trade price on effective reserves, built as of the decision.
  - **Spike.** A spike rejects: a known candle ending inside the last 3 minutes before the decision hour whose high is more than 25% above its open.
  - **Chase (U2 only).** It rejects when the close of the last candle ending by migration + 5 min is above the migration price, which is the migration pool's `CreatePoolEvent` quote ÷ base. It also rejects when no candle lies between migration and + 5 min, or no `CreatePoolEvent` was seen.
  - **Out-of-order trades.** A trade stamped before the latest candle makes the candles partial, and both checks then reject (fail closed).
- **H7. H6: LP outstanding.** Migration LP is burned, so a canonical pool starts at 0. As of the decision slot, outstanding = Σ `DepositEvent.lp_token_amount_out` − Σ `WithdrawEvent.lp_token_amount_in` on the pool, and any value other than 0 rejects. The bot reads the LP mint's supply instead. The tape has no LP mint supply outside these events, so a burn made outside a withdrawal is not seen.
- **H8. Tradable.** At $5 only: at least 300 validation trades in the $5 stratum with a mean above 0. The $20 and $50 rows carry "research: needs the owner to raise maxNotional". There is no longer any flag under the flat floor.
- **H9. Count row.** Sizes $5, $20, $50, $100, $200, $500, $1,000 and $10,000, each on its universe floor with H6, H11 and the dust check, on the two bases of H4.
  - Per day, it also counts distinct canonical pools whose latest trade, as of a decision point that day, charged no creator fee: the creator is the default key, or the creator fee bps is 0.

## Not done here
25. §9.4 asks for the code, seeds and input hashes to be committed before validation days are read. `features_meta.json` and `frozen.json` record the sha256 of every input file and source file. The commit itself is for the supervisor (this builder runs no git).
