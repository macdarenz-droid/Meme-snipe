# D1 scoring code: open questions

Places where `PREREG.md` is silent or ambiguous. Each one has the reading the code uses now. CONSERVATIVE means I chose the safer reading because nothing in the repo decides it. A reviewer or the design owner should confirm or amend each one before the search runs on the full Step A.

## Universe and decision points
1. **Grid anchor.** "Every 5 minutes per eligible pool" does not say what the marks are aligned to. The code uses UTC-aligned 5-minute marks tau inside [migration + 60 min, migration + 24 h], both ends included. H1-CGO uses whole UTC hours. The decision slot is the last produced slot with block_time < tau.
2. **Migration not on the tape.** A pool whose migration happened before the first unit read has no known age, so it is excluded. CONSERVATIVE. As a result, early 2026-09-10 has few pools, because pools that migrated on 09-09 are never seen. Fold 0 on day 1 is therefore thin.
3. **Mayhem flag unknown.** The flag is read from CreatePoolEvent, then CreateEvent, then the curve rows. If none of these has it, the pool is excluded, as G1 §3 does. CONSERVATIVE.
4. **Coverage.** A decision needs gap-free tape from the migration to d. A hold arm needs it from d to its exit slot. Otherwise the arm is dropped by time.

## Trade and costs
5. **Fill price inside a slot.** The code takes the worse of the pool state at the start and at the end of the entry slot and of the exit slot. This copies H1-CGO §6 and G1 §4. CONSERVATIVE.
6. **Exit delay.** The trigger is the first slot at or after entry time + hold. The sell lands 23 slots later, as in H1-CGO ("+ D slots"). CONSERVATIVE.
7. **One entry per pool per hour.** The code uses a rolling 60 minutes from the last entry, chosen greedily in time order. A clock hour would allow entries 5 minutes apart. CONSERVATIVE.
8. **Fee rates.** The rates are the lp, protocol and creator bps on the pool row whose state is used. Red team R2-2: BOOST slices and protocol swaps carry fee fields of 0, so they never set the rate; the last fee-paying row at or before the state does (before the pool's first fee-paying row, the dearest tier `config.FALLBACK_FEE_BPS`, 125 bps; red team R2-11: no later row is read).
9. **A sell larger than the real vault.** The program would refuse such a sell. The code caps the quote out at the real vault. CONSERVATIVE. Red team R2-3: a state with no usable reserves at the exit slot (start or end) makes the exit a total loss (0 SOL back), as H1-CGO item 13; the trade is never dropped.
10. **Our own trade's effect on the pool.** Our buy's impact is not carried into the exit state, so the exit is priced on the market's own state. This is PESSIMISTIC: under constant product our buy's reserve change stays in the pool, so leaving it out understates the sell price. Confirmed by AMENDMENT_1.
11. **Rent.** RESOLVED by AMENDMENT_1 item 11 and AMENDMENT_2. Rent = (128 + account bytes) × the lamports per byte in force at the entry slot: 6,960 before 2026-09-03, 6,333 from 2026-09-03, 5,080 from epoch 1033 (slot 446,256,000). Accounts are 170 bytes for Token-2022 and 165 for SPL Token, with RENT-1's refund model (`costs.rent_for`, `costs.fixed_for`). A mint whose create row (`token_program`) is not on the tape counts as 170 bytes. CONSERVATIVE.
12. **Pool state between trades.** It comes from trade rows only. InitBoost, deposits and withdrawals show up only at the pool's next trade. How large this effect is has not been measured.

## Features
13. **Window for "Who".** A 15-minute window is stated only for failed buys. The code uses [tau - 15 min, tau) for all four "Who" shares. CONSERVATIVE.
14. **"App-routed".** There is no registered list of app programs. The code counts a buy as app-routed when its `top_program` is neither PumpSwap nor pump, so trading-bot programs count too. On schema v1 units the share is NaN.
15. **W1's fast class.** W1 classifies "on that day", which would look ahead. The code reads it as of the decision: the cluster's buys from the start of tau's UTC day up to d. Clusters are rebuilt exactly at every tau. W1's exclusion of off-curve (PDA) owners is not applied, because there is no on-curve check without a new dependency. Hub degree counts every distinct linked address, not owners only.
16. **Creator cluster seeds.** The seeds are the create row's creator and user (G1 amendment 1). When the create predates the tape, the seed is the pool's `coin_creator`.
17. **"Creator share".** The code uses the creator address's own balance divided by supply, not the whole cluster's.
18. **Holders.** Only owners seen on the tape are counted. For coins created before the tape, `top10_share` is therefore a lower bound. Holdings from before the tape are found through `owner_token_pre/post` and given unknown cost. The denominator is `base_supply`. CGO is computed at any coverage; H1-CGO's 90% floor is not applied, because coverage is its own feature. Burn and protocol accounts other than the pool and the curve are not excluded, because the tape does not list them.
19. **CF.** The feature is the count of both collection events by the coin's creator in the last hour. Neither event names a mint, so collections from the creator's other coins count too. Windows that touch a v1 unit are NaN.
20. **BOOST finished.** It is 1 when the pool's last BoostBuyAndBurnEvent at or before d has `boost_vault_remaining` = 0, and 0 otherwise, including pools with no BOOST.
21. **BOOST and protocol swaps; definitions not spelled out in the PREREG.**
    - BOOST swaps have protocol = 0 and no owner on decoder v1 and v2, so they are flagged by signature through E's `BoostBuyAndBurnEvent`. Decoder v3 sets protocol = 1 on them, and both checks are kept. The flags are exposed as `boost` and `protocol` on the pool rows, with each row's `signature`.
    - Whether BOOST and protocol swaps count as flow is OPEN for the lead. Until a ruling they are EXCLUDED (CONSERVATIVE, `config.EXCLUDE_PROTOCOL_SWAPS`): from buy and sell counts, net SOL, unique and first-time buyers, largest sell, all four "Who" shares and the fast-class buys. Pool state, prices and volatility still use every row.
    - net SOL is buy minus sell `quote_amount` (pre-fee);
    - largest sell is divided by the effective quote at d;
    - a first-time buyer is one whose first buy of the mint on the tape (curve or PumpSwap) falls in the window;
    - realised volatility is the square root of the sum of squared log changes of the post-trade mid over the window;
    - "since migration" is measured from the first pool row's pre-trade mid.
## Search
22. **Folds.** Four folds: fold j holds out block j (00–06, 06–12, 12–18, 18–24 UTC) on every discovery day. A training point is dropped when its whole window [tau, exit] comes within 60 minutes of a held-out block. CONSERVATIVE: this also covers the hold. Points whose arm runs past the tape are used neither for edges nor for scoring.
23. **Quintiles.** RESOLVED by AMENDMENT_1 item 23. Edges are numpy linear percentiles; top is x ≥ q80 and bottom is x ≤ q20. A binary feature (`config.BINARY_FEATURES`: `boost_finished`) uses top = 1 and bottom = 0. A feature whose training q20 equals its q80 gives no rule in that fold. NaN is in neither extreme.
24. **Cost screen.** RESOLVED by AMENDMENT_1 item 24. A rule needs out-of-fold mean NET return above 0 in every fold, which also makes the sign the same in all four folds. Costs are not charged twice. The median round-trip cost is reported only.
25. **Sign rule.** "The same in all four folds" is read as all four fold means non-zero with one sign. The 5 advanced rules are counted across both holds together.

## Validation (not run)
26. **Lift baseline.** "Random eligible decision points" is the mean over all eligible points valid for the hold, with no throttle. That is the expected value of a random draw, so no sampling noise.
27. **Days without trades.** A validation day with no trade counts as not positive. CONSERVATIVE.
28. **Interval method.** The bootstrap gives a percentile interval. Clusters are pools within each day stratum, so a pool seen on two days counts as two clusters.

## Scale (not yet measured)
29. **Full Step A run.** Expected cost:
    - loading about 96 units takes about 10 s each;
    - one connected-components pass per 5-minute mark (about 576) takes several seconds each on 10M+ links;
    - memory is a few GB after the migrated-pool prefilter.

    None of this was run beyond 2 units, by rule.

## Step A completeness (review fix)
30. **Plan check.** stage1 checks `research/shared-tape/stepa-plan.txt` against the sha256 fixed in `config.STEPA_PLAN_SHA256`. It records whether each day's units equal that day's plan rows exactly, with no gaps (`stepa.plan_check`). search refuses unless the result is complete.
31. **Validation days.** The Step A plan does not cover validation days, so a completeness check for Step B or forward days needs its own plan and sha. That is not written yet.

## H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md; reporting only)
32. **"That hour's SOL/USD".** The code uses the close of the last complete UTC hour before tau (as-of). A missing hour in the price file means no price, so the point is not H8-eligible. CONSERVATIVE.
33. **Stratum trades.**
    - The stratum at $5 and $20 uses fills at that size: same slots, own impact and fees, the same fixed costs.
    - The $5 and $20 sizes convert to SOL at the frozen $119.26, as the primary does. Only the H8 floor uses the hourly SOL/USD.
    - The $50 stratum uses the primary's own fills (`net_ret_<h>_s50` = `net_ret_<h>`).
    - Entries are throttled inside the stratum, because the bot can enter only H8-eligible pools.
    - Effective quote is the as-of feature at d.
34. **Count row 4.** It runs over D1's eligible decision points (from 50 SOL up):
    - pool-hours are distinct (pool, UTC hour) with an H8-eligible point;
    - graduates are distinct pools.
35. **Price input.** RESOLVED. `--solusd` defaults to `research/brainstorm-loop/sol-usd` (Binance SOLUSDT 1h, 09-02..09-11), and only that directory form is accepted. Its SHA256SUMS is pinned by `config.SOLUSD_SUMS_SHA256`, and validate refuses an input whose sha differs from `frozen["solusd_sha256"]`. The code checks each needed day's file against `SHA256SUMS`: the decision days, plus the day before the first one. A missing day or a mismatch is refused, and the sha256 of SHA256SUMS is recorded.

## AMENDMENT_3 and H8_AMENDMENT_2 (the H8-tradable subset)
36. **H17 from the tape.**
    - The mint program and cashback flag come from the create row.
    - The pool account size is the pool's last ExtendAccountEvent up to d. On the units read, every migration pool is extended from 270 to 301 bytes in its migration transaction. Without the event the size is unknown.
    - Mint extensions are taken as supported when the create row is on the tape, because `tx/shape.ts` says pump creates carry only MetadataPointer and TokenMetadata. That is an assumption from the core's comment, not read per mint.
    - Without a create row, H9, H12, H13 and H17 are unknown (the bot's `readCreate`). Coins created before the tape are never H8-tradable.
37. **H13 needs funder reads the tape cannot give.** The bot links insiders through each wallet's first-ever funding transfer (`facts/funding.ts`), and a 2-day tape cannot prove a wallet's first funding. So H13 is unknown for every point, and the H8-tradable subset is EMPTY on the tape as built. CONSERVATIVE: missing evidence is never a pass.
    - Consequence: AMENDMENT_3's ranking adds nothing, and no validation result can be "tradable as the bot stands". `validate` reports `unknown_share` so the owner sees that the cause is evidence, not the floor.
    - Needs a ruling: supply funder reads (`holder_features(funders=...)` takes them), or accept a tape proxy.
    - Creation buyers and first buyers are curve-buy owners (`user_token_owner`), where the bot keys on the curve `user`.
38. **The universe's own exits.** AMENDMENT_3 asks for these as a secondary (U2: ATR stop, T_flat, partial at +1.5R, trail, flow, liquidity and deployer stops, `exits/rules.ts`), but they are NOT built. They need an entry stop and 1R, which come from a strategy's structure stop, and D1's rules do not define one. Building them would invent the stop. Needs a ruling on the stop. Secondary only: no judgement depends on it.
39. **Readings in the gates.**
    - H11's spike check applies in every universe, as `hard.ts` does; the chase check only in U2.
    - U1 also needs a market cap of at least 1,470 SOL (ARCHITECTURE §3.2). Within D1's window only a decision at exactly migration + 24 h can be U1.
    - H6: LP minted by DepositEvents minus LP burned by WithdrawEvents up to d. Migration LP is burned.
    - Dust is checked on CreatePoolEvent `pool_quote_amount` (as `facts/producer.ts`).
    - H12 and H13 use circulating = supply − pool base reserve. Tokens the book does not account for go to the worst place (GATE-1d), which gives unknown.
40. **Ranking and stratum.**
    - The $5 subset is throttled inside itself, one entry per pool per rolling hour. The bot's own daily limits (3 a day, 1 per mint a day) are not applied, because AMENDMENT_3 does not name them.
    - `h8_first` never makes a rule qualify.
    - The count row reports each size both on floor and gates ("tradable") and on the floor only. It also reports the canonical pools on the tape whose last row of the day charged a 0 creator fee.
