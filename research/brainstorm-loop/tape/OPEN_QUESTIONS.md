# Step A count rows: open questions

`STEP_A_COUNT_ROWS.md` is frozen, and the documents it points to are SWEEP_1/2, G1 amendments 1–2, W1 and H1-CGO. None of them settles the points below. Each entry gives the reading the code uses, chosen as the most conservative one: it makes a row harder to pass, or it computes nothing. A reviewer or the lead should confirm or replace each one before any threshold is applied. The question numbers match the `Q<n>` notes in `rows.py`.

## Shared
- **Q1 Intervals.** "95% lower bound" is read as a percentile bootstrap, 10,000 resamples, seed 20261008. Event and control sets are resampled separately, with no clustering by pool or day. A pool-clustered or day-stratified bootstrap would also fit; the lead should fix one.
- **Q2 First-time buyer.** The rows say "first-time buyer" but do not say how much history is needed.
  - *Used:* a buy is first-time when it is the owner's first buy of the mint on the loaded tape. It counts only when the coin's CreateEvent lies in the same contiguous run of units, so the whole history is on the tape (W1's rule). Without that, the event is dropped (`history_not_on_tape`).
  - This removes most graduates whose curve began before the loaded units. It can be switched off with `require_history=False`, but that is not the conservative reading.
- **Q3 Coverage.** A window counts only if one contiguous run of loaded units of one day covers it, so windows across a day boundary are dropped.
- **Q4 Mayhem.** It is read from CreateEvent, then CreatePoolEvent, then curve rows. A coin whose mayhem flag is unknown is dropped.
- **BOOST finding.** On v2 unit 09-11 446265000-446269499, all 651 BOOST buy-and-burn rows in S_amm have `protocol` = 0 and an empty `user_token_owner`. The tape README says `protocol` marks BOOST, but it does not. The code removes BOOST rows by matching E `BoostBuyAndBurnEvent` signatures. The decoder's `protocol` flag should be checked.
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
- **Q14 Price and return.** Three rows need a price comparison or a realised gain or return:
  - the two odds ratios ("price below the sale price"; gain-sellers vs loss-sellers);
  - the share of gain ex-holders who rebuy once below the sale price;
  - the R² "on past returns, drawdown, age and depth".
  This build may compute no return or price change. *Used:* none of these is computed. The code reports only ex-holder exits, rebuys within 2 h of the exit (not conditioned on price), the split by exit-size tercile, and the share of exit proceeds readable (signer = owner, `signer_sol_post` present). The lead must rule whether these rows may read prices and gains.
- **Q15 Rebuy-pressure measure.** The measure (RB, its P90 and median, and the top quintile) and the "predicted" net rebuy SOL are not defined in the frozen row, SWEEP_2 or H1-CGO. Not computed.
- **Exits.** An exit is a sale leaving the owner's `owner_token_post` at 0. SWEEP_2's "young pools, hours 1–12" is not in the frozen row, so all coins are kept. Exit-size bands are not fixed, so terciles are used (descriptive only).
- **Ledger.** H1-CGO's per-(mint, owner) cost ledger does not exist in the repo yet. Only its holding fields, which carry no price, are used here.

## 3 SEAT-DRIFT
- **Q9 Busy vs lone.** These are not defined. *Used:* lone = N_m = 0, busy = N_m ≥ 1.
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
- **Q13 Label use.** An owner is labelled on a mint if either rule flags its cluster on that mint. Labelled owners are removed from rows 1, 3 and 4's first-time-buyer counts.
- **Shape seen on two units of 09-11.** The label covers about 35% of swap rows. The hub-cap rule has one component of 6,433 owners, and hub-keyed clusters reach 8,835 owners (probably exchange or router hubs). The label is therefore broad, and it removes a lot of first-time demand. That makes rows 1, 3 and 4 harder to pass. The lead should decide whether to cap the cluster size or narrow the window.

## 6 Round-USD and Gate 3 split
- **Q18 Placebo grid.** Design A gives "20 placebo cutoffs on a log grid from 340 to 1,300 SOL, each more than 10% from 420 and 1,470".
  - *Used:* `geomspace(340, 1300, 20)`, then the exclusions are applied, so fewer than 20 remain. The amendment then drops cutoffs within 10% of that day's $50k and $100k SOL levels.
- **Q19 Market cap.** Market cap = (pool quote after the swap + `virtual_quote_reserves`) ÷ pool base after the swap × `base_supply`.
  - Post-swap reserves come from `chain_pool_*`, or else from the next swap's pre-trade reserves.
  - Which supply the FeeConfig tier uses is still to be read from the program (A amendment (a)). `base_supply` is used until then.
  - Pools are kept for hours 0–72 after migration, from the end of the last BOOST event (or m + 5 min) to the end of the loaded tape.
- **Bunching statistic.** It is Design A gate 2's statistic at each USD level: the log ratio of time in [L, 1.05 L) to time in [0.95 L, L), minus the median of the same ratio at the placebo cutoffs, with a pool-clustered bootstrap.
- **"Round USD level".** Only $50k and $100k are checked, as named.
- **SOL/USD.** This is an input file, because the code makes no network request.
- **Q20 Focused vs spread.**
  - *Used:* spread = the coin creator's group (same creator-group rule, as of the end of the loaded tape) holds the creator role on 2 or more mints on the tape. The role comes from CreateEvent `creator` and the S `creator`/`coin_creator` columns.
  - The measure is Design A gate 3: the creator's net SOL buying per hour while the pool is in [399, 441), minus the median of the same measure in ±5% bands around the placebo cutoffs.
  - CF names no mint, so CF collections by group members are reported as a count beside the split; they are not attributed to a coin.
- **Q21 USDC-quoted pools.** These are excluded from row 6 (SOL pools only, as Design A states).
