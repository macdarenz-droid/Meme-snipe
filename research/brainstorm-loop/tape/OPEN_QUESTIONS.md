# Step A count rows: open questions

`STEP_A_COUNT_ROWS.md` is frozen. The design owner answered these questions in `../COUNT_ROWS_AMENDMENT_1.md` (frozen, 2026-10-08), and the code implements that amendment. Items the amendment names are marked **[A1]** with its ruling. Every other item is confirmed as the code reads it. Items marked **[open]** are new readings the amendment does not settle; each takes the conservative choice. Question numbers match the `Q<n>` notes in the code.

## Shared
- **Q1 Intervals [A1].** A pool-clustered bootstrap stratified by day, 10,000 resamples, seed 20261008 (`rows.boot_lb_clustered`). Within each day, pools are drawn with replacement and every row of a drawn pool comes along. Event and control sets are resampled separately. A draw where the statistic is undefined counts as minus infinity (conservative). Row 6's bunching interval is pool-clustered within each day.
- **Q2 First-time buyer.** The rows say "first-time buyer" but do not say how much history is needed.
  - *Used:* a buy is first-time when it is the owner's first buy of the mint on the loaded tape. It counts only when the coin's CreateEvent lies in the same contiguous run of units, so the whole history is on the tape (W1's rule). Without that, the event is dropped (`history_not_on_tape`).
  - This removes most graduates whose curve began before the loaded units. It can be switched off with `require_history=False`, but that is not the conservative reading.
- **Q3 Coverage.** A window counts only if one contiguous run of loaded units of one day covers it, so windows across a day boundary are dropped.
- **Q4 Mayhem [`../COUNT_ROWS_AMENDMENT_3.md`].** Mayhem is the mint's flag, taken in order from its CreateEvent, then any curve trade of the mint (`mayhem_mode`), then CreatePoolEvent (`Tape.mayhem_of_mint`). A 2B `base_supply` is never used to infer it. A coin whose flag is unknown is dropped from rows. In the H8 capacity row, its pool-hours are reported apart as `*_mayhem_unknown` and are never counted as H8-eligible.
- **BOOST rows [A1].** Removing them by `BoostBuyAndBurnEvent` signature is correct; the v1/v2 `protocol` flag of 0 is a decoder defect. Decoder v3 sets `protocol=1` on BOOST swaps. Any non-zero `protocol` is excluded, and the signature match stays for older units (tested both ways).
- **SOL amounts.** The code uses `sol_amount` on curve rows and `quote_amount` on PumpSwap rows (pool-side, without user fees). Non-SOL-quoted swaps carry no SOL amount.

## 1 DEV-ZERO
- **Q5 "Near-full exits that leave 0–10%".** *Used:* a dev sale leaving more than 0 and at most 10% of the dev's pre-sale holding. The other reading is 0–10% of supply.
- **Q6 Placebo crossings.** A sale that crosses both the cutoff and its placebo (for example 6% → 3%) is an event only. A placebo control must cross the placebo level without crossing the cutoff.
- **Q7 Creator group.** The group is a union-find on T and W links on or before the event slot. It is seeded with the pool's `coin_creator`, the selling owner, and the CreateEvent `creator` and `user`. An address linked to more than 50 owners (as of the slot) is neither added nor crossed. A seed always stays in the group.
- **Q8 One crossing per pool.** Only the first crossing per pool, arm and kind counts. A dev who buys back and crosses again is not counted twice.
- **Excess.** Net = (first-time buyer SOL − existing holders' sell SOL), both in (e + 23 slots, e + 15 min], divided by the effective quote just after the dev's sale.
  - Excess at the median = median(event net) − median(control net).
  - "Existing holder" = a seller whose first tape buy of the mint is not after the event (holders with no tape buy are included).
  - "At least 50% of it lands after 23 slots" is read as late first-time buyer SOL ÷ all first-time buyer SOL in (e, e + 15 min]. This is the only reading that can be computed, since the row window already starts at +23 slots.
- **Dev-sell exits.** SWEEP_2 said to subtract automated dev-sell exits, but the frozen row says to exclude creator-group rows. The frozen text wins: creator-group rows are excluded.
- **Mint vs pool.** Flows are counted on the canonical pool only.

## 2 REBUY-ANCHOR
- **Q14 What may be read [A1].** As-of price levels and as-of past returns are allowed. That covers the mid compared with an ex-holder's sale price, realised gains, and past return, drawdown, age and depth. After a decision point the code reads flows only. `test_no_price_after_the_decision_point_is_read` plants a price after t and checks that nothing at t changes.
- **Q15 Decisions, RB and materiality [A1].** Implemented in `rebuy.py`.
  - Decision points are m + 1 h, …, m + 12 h on eligible pools.
  - RB = the proceeds of readable gain ex-holders who exited in the last 12 h, whose exit price is above the mid, divided by effective quote.
  - Net rebuy flow = ex-holders' buy SOL − other owners' sell SOL in (t + 23 slots, t + 2 h], divided by effective quote.
  - The comparison is the top RB quintile against points within ±10 percentile points of the median RB, inside (day, drawdown tercile).
- **[open] Rebuy readings.**
  - Points are hourly from migration time (not whole UTC hours).
  - The mid is the post-swap effective-reserve mid of the last canonical-pool swap at or before t, read from that swap's `chain_pool_*`. The next swap's pre-trade reserves are used only when that swap is itself at or before t (block_time ≤ t, slot ≤ the decision slot). Otherwise the state is NaN and the point is skipped, so a later deposit or swap is never read (reviewer L1). Row 6's market-cap segments likewise use no next-swap fallback.
  - Top-quintile decisions a day count points with rb_pct > 0.8 (the materiality ranking within day × drawdown tercile) and RB > 0 (reviewer L2).
  - Past return is over 1 h; drawdown is from the peak mid since migration.
  - A rebuy is any buy of the mint by the ex-holder in (t, t + 2 h]. A buy also ends ex-holder status.
  - The odds-ratio population is the ex-holders who exited in the last 12 h, one row per (ex-holder, point). Gain = 0 is left out of the gain/loss odds ratio. An empty cell makes the odds ratio undefined, which fails the row.
  - Materiality pools the strata's (top − mid) mean differences, weighted by top counts. Top and mid membership is fixed at the point estimate, and the two sets are resampled separately.
  - R² is plain OLS with an intercept.
- **Exits [open].** An exit is a SOL-quoted sale leaving the owner at 0 (tape `owner_token_post`, else the ledger). It closes a holding episode, and the episode's proceeds, tokens and known cost give the exit VWAP and the realised gain. Gain is unknown when any sold token had unknown cost. Readable means every sale of the episode was signed by the owner, with a signer SOL reading. Leaving by transfer is not an exit.
- **Ledger [A1].** This is H1-CGO's `Ledger` (`research/h1-cgo/tape/h1cgo/ledger.py`), loaded read-only and fed with swaps (cost with fees, as H1-CGO counts it; proceeds after fees) and T transfer/mint/burn rows. History must be on the tape (Q2).

## 3 SEAT-DRIFT
- **Q9 Busy vs lone [A1, ties ruled in `../COUNT_ROWS_AMENDMENT_2.md`].** Lone = the bottom tercile and busy = the top tercile of N_m, over each day's eligible graduates.
  - The cuts are c1 and c2, the 1/3 and 2/3 quantiles (numpy linear).
  - Bins: lone is N_m ≤ c1, middle is c1 < N_m ≤ c2, busy is N_m > c2. A value equal to a cut goes to the lower bin, the same way on every day, and no graduate is dropped.
  - The summary reports each day's cuts and the rows tied at each one (`tercile_cuts_and_ties`).
- **Q10 G1-CAP definitions.**
  - N_m counts other eligible graduates (canonical, SOL, not mayhem) whose creator seeds (create `creator`/`user`, pool `coin_creator`) are outside the coin's creator group as of m.
  - A graduate whose normalised name or symbol matches another graduate in the window is dropped (theme wave). The match uses only coins whose CreateEvent is on the tape.
  - G1-CAP's 68-SOL curve term belongs to N(t), not N_m, and is not used.
- **Windows and normalisation.** "m + 60 min + 23 slots" is the first block at or after m + 3,600 s, plus 23 slots. Each window is divided by the effective quote of the last pool swap at or before the window start. The 95% bound uses Q1.

## 4 AGE-GATE
- **Q16 "Around" an age.** *Used:* step = first-time buyer SOL in [x, x + 60 s) − first-time buyer SOL in [x − 60 s, x).
- **Q17 Placebo ages.** Placebo ages that are not positive, or that equal another round age, are dropped. The placebo summary is the median, over placebo ages, of the mean step. Ages are counted from the create and from migration, using block_time.
- **W1 class.** The class is computed per day from all non-BOOST buys on the loaded tape, by W1 §5. Owners with no buy that day are "slow".

## 5 Two-sided clusters
- **Q11 Cluster rules.**
  - hub-cap-50 = connected components after removing every edge that touches an address linked to more than 50 owners.
  - hub-keyed = each owner linked to such a hub is keyed by the hub of its earliest hub link, and owners with the same key form one cluster.
  - Both rules use all links on the loaded tape, not as-of. This matters only for a label; it reads no outcome.
- **Q12 "Short windows".** *Used:* 600 slots (F1's window): a cluster buy and a cluster sell of the same mint within 600 slots.
- **Q13 Label use [A1].** Only clusters of 2–50 owners are labelled. The summary reports the share of swap rows labelled before and after the cap (`either_rule`, and per rule).
- **Shape seen on two units of 09-11 [open].** The share is taken over owner-known, non-BOOST, SOL-quoted swap rows. It falls from 58% of rows labelled without the cap to 43% with it, so the label is still broad. The 600-slot window (Q12) is the remaining lever for the lead.

## 6 Round-USD and Gate 3 split
- **Q18 Placebo grid.** Design A gives "20 placebo cutoffs on a log grid from 340 to 1,300 SOL, each more than 10% from 420 and 1,470".
  - *Used:* `geomspace(340, 1300, 20)`, then the exclusions are applied, so fewer than 20 remain. The amendment then drops cutoffs within 10% of that day's $50k and $100k SOL levels.
- **Q19 Market cap [A1: `base_supply` until A amendment (a)'s program read].** Market cap = (pool quote after the swap + `virtual_quote_reserves`) ÷ pool base after the swap × `base_supply`. Post-swap reserves come from `chain_pool_*` only; a segment without that reading has no market cap (NaN), so no later state is used. Pools are kept for hours 0–72 after migration, from the end of the last BOOST event (or m + 5 min) to the end of the loaded tape. Market-cap levels are as-of states, which A1 allows.
- **Bunching statistic.** It is Design A gate 2's statistic at each USD level: the log ratio of time in [L, 1.05 L) to time in [0.95 L, L), minus the median of the same ratio at the placebo cutoffs, with a pool-clustered bootstrap.
- **"Round USD level".** Only $50k and $100k are checked, as named.
- **Q22 SOL/USD input [A1, with an open reading].** By default `--sol-usd` reads the committed `../sol-usd/` folder, which holds the Binance SOLUSDT 1-minute daily klines. Each loaded day's zip is checked against `SHA256SUMS`, and so is the previous day's zip when listed (for the 00:00 close). `SHA256SUMS` itself must match the sha256 pinned in `run_step_a.SOL_USD_SUMS_SHA256`. The run refuses a missing day or any mismatch. The 1-hour files are not read, since the hour value comes from the 1-minute closes (Q23). Open times may be in ms or µs, and the UTC day comes from the open time. The summary records each file's sha256 (`sol_usd_files`).
  - *[open]* A day's bunching uses the levels at its median close.
  - The "420 within 5%" flag, and the 10% placebo drop, use every minute's level in the day's [min, max] close range. That is conservative: it flags and drops more.
- **Q20 Focused vs spread.**
  - *Used:* spread = the coin creator's group (same creator-group rule, as of the end of the loaded tape) holds the creator role on 2 or more mints on the tape. The role comes from CreateEvent `creator` and the S `creator`/`coin_creator` columns.
  - The measure is Design A gate 3: the creator's net SOL buying per hour while the pool is in [399, 441), minus the median of the same measure in ±5% bands around the placebo cutoffs.
  - CF names no mint, so CF collections by group members are reported as a count beside the split; they are not attributed to a coin.
- **Q21 USDC-quoted pools.** These are excluded from row 6 (SOL pools only, as Design A states).

## H8 stratum and capacity row (`../H8_AMENDMENT.md`)
- **Rule [`../H8_AMENDMENT_2.md`].** Each point is checked under the universe the bot would tag it with (`h8.GateCtx.check`).
  - U2 (60–240 min after migration): max($15,000, 1,000 × size), plus H11.
  - U1 (1–14 days): max($50,000, 1,000 × size).
  - 4–24 h, under 60 min and over 14 days are not tradable.
  - H6 (no outstanding LP) and dust at migration (≥ 5 SOL) always apply.
  - Sizes run $5 to $10,000; $5 is the trial line and the rest are research lines.
  - A missing price, effective quote or universe makes the point not eligible. A missing price or effective quote makes the row not eligible.
- **Q23 "That hour's SOL/USD" [confirmed by `../COUNT_ROWS_AMENDMENT_3.md`].**
  - *Used:* the close of the Binance 1-minute bar that ends at the hour start, which is the last value known when the hour begins (no look-ahead). It is read from the same `--sol-usd` kline files, whose sha256 are recorded.
  - Without minute files, the stratum and the capacity row report "needs SOL/USD 1-minute closes".
- **Q24 Which state is tested [open].** Each row's own as-of point is used:
  - DEV-ZERO: the effective quote just after the dev's sale.
  - REBUY-ANCHOR: the decision point's effective quote. Pairs follow their points, and ex-holder readability uses all exits.
  - SEAT-DRIFT: the effective quote at m + 60 min.
  
  Within the stratum the summaries are recomputed exactly as for the full row. SEAT-DRIFT keeps the lone/busy terciles from the full day, and REBUY's quintiles and terciles are recomputed inside the stratum.
- **Q25 Capacity row [open].**
  - Pool-hours are taken at each whole UTC hour inside the loaded tape, for canonical WSOL PumpSwap pools with an as-of state at the hour start.
  - Non-mayhem is required (Q4). Pools whose mayhem flag is not on the tape (most pools that predate the loaded units) are counted apart as `*_mayhem_unknown` and never in the main count. On two partial units of 09-11, every pool-hour fell in that group.
  - A pool-hour whose last state lies before a gap in the loaded tape is skipped and counted as `pool_hours_state_not_on_tape`.
  - Each stratum reports `rows_without_sol_usd`, the rows whose hour has no price; those rows are never eligible.
  - Graduates (migration on the tape) count when their effective quote at m + 60 min (H10's earliest entry) meets the floor. A graduate whose m + 60 min is not on the tape is reported as not assessable.

## H8 amendment 2 readings (`../H8_AMENDMENT_2.md`)
- **Q26 [open] H11 in U1.** The amendment names H11 for U2 only. The core's H11 also runs its candle-spike check for every universe (`hard.ts` h11), so U1 points get the spike check too; only the chase check is U2-only. This is the stricter reading.
- **Candles.** These follow `facts/producer.ts`:
  - 1-minute buckets of pool trades at or before the point, BOOST rows included.
  - open = the first trade's pre-trade mid, high = the max of pre and post, close = the last post. The post-trade state comes from the event (base ± base amount, quote ± lp-adjusted quote) on effective reserves.
  - A trade without a price fails H11 (the core flags such candles partial and refuses them).
  - The migration price is CreatePoolEvent quote ÷ base, without virtual reserves, as the core.
- **Universe bounds.** U2 runs [60, 240] min and U1 [1, 14] days after migration, both inclusive. A pool whose migration is not on the tape has no age, so it is never eligible (`age_unknown`). On Step A that excludes every pool that predates the loaded units, and so in practice all U1 pools older than the tape.
- **H6.** Outstanding LP = DepositEvent LP out − WithdrawEvent LP in since migration, as of the point (migration LP is burned, as the core assumes).
- **Creator fee 0.** A canonical WSOL pool counts on a day when every one of its rows that day has `coin_creator_fee_basis_points` = 0.

## Slicer ride (`../COUNT_ROWS_AMENDMENT_4.md`; details from `SWEEP_4.md` survivor 1)
- **Q27 [open] Event.**
  - One event per (mint, owner): the first buy at which the owner has at least 3 buys of the mint within the past 30 min, spanning at least 3 slots and 60 s.
  - Slices are counted on canonical WSOL pools only, where Q (the effective quote) exists.
  - "Not a PDA" follows from signer = owner, since a PDA cannot sign.
  - Routed slices: on v2+ units, every slice's `top_program` must be pump or PumpSwap; an empty one counts as routed. On v1 units only the signer test applies. App-fee transfers are not detected, since there is no listed fee-wallet set.
  - Regular cadence uses the CV with the population SD; a zero mean counts as regular.
- **Rows.**
  - Continuation = X's own net buy SOL of the mint in (t + 23 slots, t + 60 min].
  - (a) is a one-sided 95% bound, pool-clustered within day.
  - (b) waits for the payer-mass bar (`COUNT_ROWS_AMENDMENT_7` names only DEV-ZERO, REBUY-ANCHOR, SEAT-DRIFT and F1), so it is "not computed" and the rows never all pass.
  - (d) uses events with B < 0.5% of Q.
  - (e) regresses continuation ÷ Q on 5, 15 and 60-min past returns, 15-min volatility (SD of 1-minute log closes), 15-min SOL volume and buy count.
  - (f) uses the median of fast-class buy SOL ÷ B.
  - (g): X sells at least half of the tokens bought through t + 60 min, within 4 h of its last buy.
  - (i) counts U1 events that pass the $5 checks.
  - Rows use all universes; the counts by universe are reported.
- **Q28 [open] Dispersed-flow control.**
  - It fires at the first time per pool and 2-h block at which at least 3 wallets, each with exactly one buy in the past 30 min and in different hub-cap-50 clusters, sum to at least 1% of Q.
  - Its continuation is those wallets' net buy in (t' + 23 slots, t' + 60 min].
  - Matching keeps controls in the events' (day, 2-h block, age tercile, Q tercile) cells, with terciles cut on the events.

## MIG-SEAT and MAYHEM-SNAP (`../COUNT_ROWS_AMENDMENT_5.md`, `_6.md`)
- **Q29 [open] Creator group.** The group is the LAUNCHER-ID set (create `creator`, `user` and pool `coin_creator`) plus every address within 2 W links on or before s0. No hub cap is applied, since none is named.
  - Non-linked rows also exclude BOOST, the mayhem agent (top program, or the mayhem vault owner) and the buyback authority (signer or owner starting `GmFrDZT2`, as the tape README abbreviates it).
- **Q30 [open] Graduations.**
  - A graduation is a CreatePoolEvent of a pool that a pump migration created, with a SOL quote and mayhem known to be 0.
  - Gradual = CreateEvent to CompleteEvent more than 5 s. Without both on the tape the speed is "unknown", which is neither arm.
  - The window must lie on the tape up to the slot time of s0 + 2 plus 300 s.
- **Q31 [open] G-rows.**
  - G2 uses the median over all seat buys on v2+ units; v1 buys are counted apart.
  - G3 counts distinct failed signatures on the pool in s0..s0+3.
  - G4 counts creator-group sells of the pool from s0, as a share of `base_supply`.
  - G5 is normalised per graduation (payer SOL ÷ X*_g, with Q_g the as-of effective quote at the end of s0 + 2). It needs a median ≥ 2 and a day-clustered 95% bound ≥ 1, resampling days as clusters.
  - G6 is per graduation, Σ used ÷ Σ requested within t0 + 300 s.
  - The kill row pools first-minute SOL over graduations.
  - G8 always reads "not checkable", so MIG-SEAT earns no PREREG until the decoder has the v3 items.
- **MAYHEM-SNAP readings [open].**
  - (a): a re-price is attributed when an S row in the same transaction has `top_program` = the mayhem program. Re-prices in transactions without an S row count as not attributed, and their share is reported.
  - (b): a later re-price on the same mint within 120 s with step ≥ |j|/2. The up-step placebo mirrors it. The non-agent-sell placebo uses curve sells on mayhem curves with a price step ≤ −6.2%, followed within 120 s by a curve price ≥ (1 + |j|/2) × the post-sell price.
  - (c): the median seconds to the up step, and the share with a non-agent curve buy in the down step's slot.
  - (d): real SOL in the up-step event ≥ 2 × $100 at that hour's SOL/USD.
  - (e): qualifying down steps (j ≤ −6.2%, real SOL ≥ 5) on SOL-quoted mayhem curves, per loaded day.
  - The re-price rule is written down as invariants (k, vSOL or vToken unchanged); fitting the full rule is left to the reader of those shares.
  - Amendment 6: `prereg_may_be_written` once (a), (b), (d) and (e) pass. The owner rules before any bot use, and a legal check comes before any real use.

