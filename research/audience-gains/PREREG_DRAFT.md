<!-- Draft from the advisor-six-ideas workflow (2026-10-08), adversarially reviewed and corrected. The builder commits the final PREREG.md before any data pull. -->

# Audience gains, stage 1: does the buyer cohort's outside gain predict the meme's next buying? (pre-registration, 2026-10-08; corrected after adversarial review)

Idea 1 from the outside reviewer, in the reviewer family (k = 10). This file registers stage 1 only. A trade test is registered only after a stage-1 PASS, and it needs its own untouched window.

## Looked at before writing
- **Sun, 'Personal Experience Effects across Markets: Evidence from NFT and Cryptocurrency Investing'**, working paper 2023-09-29 (afajof.org/management/viewp.php?n=61600). Read by the scout on 2026-10-07 and re-checked here (scratchpad/six/sun/sun.txt).
  - Getting a rare NFT at mint (random) raised next-month log purchases of lottery-like crypto by 0.0047 (Table 3).
  - Table 7: holders +0.0061 (SE 0.0021, significant). Minters who sold, i.e. realised the gain: −0.0022 (SE 0.0045, not significant and imprecise).
  - Section 6.2 judges the house-money effect unlikely to be the key driver.
  - So the paper does not support realised gains spilling into a specific coin within hours. The prior is low.
- **Descriptive only:** activity of 20 buyer wallets (public RPC, 2026-10-07); GeckoTerminal buyer counts for 5 trending memes.
- No cohort, gain, flow or price data in any test window was looked at.

## Question (stage 1; the only question registered here)
Take a pump.fun graduate B and the owners who bought it in the 7 complete days before today. Suppose those owners realise unusually large SOL gains in other coins during hour h. Does B then receive more net SOL buying over the next 6 h, after our delay, than predicted by:
- its own momentum;
- the meme market;
- shared themes;
- the gains of matched unlinked wallets?
The effect must also be large enough to matter against the round-trip cost.

## Data and windows
- **Data:** pump-only, per-owner trades from core archive units (curve-all plus canonical-all; owner = user_token_owner).
- **Days:** 2026-07-20 to 09-11, 54 UTC days. All are before the wall, before U1-B's holdout and outside the sealed window.
- **Split:**
  - warm-up 07-20 to 08-02 (14 days: 7 for the cohort, 7 more of cost-basis history);
  - discovery 08-03 to 08-22 (20 days): fixes caps and wash thresholds and checks the code; estimates are reported, but no decision rests on them;
  - validation 08-23 to 09-11 (20 days): the primary.
  - The last sampled h_end is 09-11 12:00Z, so every outcome window ends by 09-11 18:05Z, inside the data.
- **Regimes:**
  - B2 (07-21) falls in warm-up.
  - B3 (09-09 19:30Z) falls in validation, so a regime indicator is included.
  - Fees come from each row's own fields.
- **Source:**
  - Zero credits if the archive publishes these days.
  - Days 09-02 to 09-11 may come from the shared tape's core-standard units if Step C is read.
  - A Helius read of the other 44 days would cost about 10-12M credits. Repo slot rates for 07-21 to 09-09 average 382 ms (research/historical/regimes.json), about 244k calls a day. That is beyond the cycle, needs owner approval, and is not requested at this prior.

## Feasibility gate (Stage 0, counts only)
Runs on the shared tables for 09-09 to 09-11, only if Step C was read (the 7-day cohorts need 09-02 onward).
- The median cohort size of eligible B is at least 100 owners after caps.
- The mean number of eligible B per hour is at least 5.
- The unknown-cost share of cohort sell quantity is at most 50% (measured with owner_token_pre).
- The O table shows at most 30% of eligible B's successful transactions outside pump/PumpSwap.
- If any check fails: stop, UNRESOLVED.

## Coverage check
Runs only after the gate passes and only once the archive days are queued. Budget: at most 0.45M credits.
- **Sample:** 1,000 owners sampled by hash from the cohorts of 3 Phase 1 days. Bots above 1,000 transactions a day are excluded.
- **Call:** getTransactionsForAddress, full, status succeeded, blockTime 2026-08-15T00:00Z to 2026-09-12T00:00Z.
- **Rule:** the Spearman ρ between pump-only G and full-history G must be at least 0.5. Otherwise stop, UNRESOLVED.

## Definitions (all as of hour h = [h_start, h_end))
- **Wallet:** the owner (user_token_owner). Rows with an empty owner are excluded and counted.
- **Cohort C_B(D):** owners with at least one successful buy of B of at least 0.01 SOL in the 7 complete UTC days D−7..D−1, using only slots before the start of day D. Fixed for every hour of D.
- **Eligible B at h:**
  - a graduate with a canonical PumpSwap pool;
  - age 1-30 days;
  - |C_B| ≥ 100 after caps;
  - an estimated $50 round trip of 3.0% or less at h_end.
  - Chosen at h, never by later survival.
- **Cost basis:** FIFO lots per (owner, coin) from successful buys since coverage began. Lot cost = SOL paid, including the venue fees in the event.
  - A sell of q tokens for proceeds P books realised = P·q_known/q − cost(q_known).
  - q_unknown (tokens received by transfer, holdings from before coverage, buys on other venues) is UNKNOWN-COST. It is excluded from gains, never treated as zero cost, and its share is reported.
  - Trades quoted in a token other than SOL are excluded.
- **Coins excluded for B:** B itself; coins with the same normalised ticker or name; coins with the same creator.
- **Realised P&L R_w(h):** owner w's realised SOL P&L in hour h on non-excluded coins.
  - Cap K = the 99th percentile of |R_w(h)| on discovery days.
  - Linked groups (owners sharing a signer within D−7..D−1, joined by union-find) share one cap.
- **Signal:** G_B(h) = Σ over w in C_B of clip(R_w(h), −K, K), divided by |C_B|. It is z-scored against B's own hourly G over the previous 7 days (past only).
- **Pseudo-cohort U_B(D):** |C_B| owners drawn by hash (seed 20261008) from owners active on pump in D−7..D−1.
  - They did not buy B in that window and share no linked group with C_B.
  - They are matched on deciles of trade count and buy SOL.
  - G^U_B(h) is computed the same way.

## Outcome (separate scoring stage)
Y = net SOL buying of B (canonical-pool buy SOL − sell SOL; wash-flagged owners and protocol flow excluded) in (h_end + d, h_end + d + 6 h], divided by B's quote reserve at h_end.
- **Delay d = 5 min:** the live pipeline must update FIFO state for the whole cohort first.
- **Wash flag:** a buy and a sell within 60 s with a net token change of at most 5% of the gross.
- **Sampling:** only h_end ∈ {00, 06, 12, 18}:00Z, so outcome windows do not overlap. Each window must end inside the data.

## Primary test
- **Model:** panel OLS on validation days of Y on:
  - z(G_B) and z(G^U_B);
  - B's log returns over 1 h, 6 h and 24 h;
  - B's net flow over 6 h and 24 h, divided by reserve;
  - age bin, reserve bin and regime;
  - hour-of-sample fixed effects, which absorb the whole meme market at h.
- **Interval for β_G** (95%, two-sided): the widest of day-clustered CR1 with t_{N−1}, two-way (day, B) CR1 with t_{N−1}, and a wild cluster bootstrap-t by day (Webb six-point weights, 9,999 replicates, seed 20261008).
- **Materiality (fixed now):** 2 × β̂_G × (z_p90 − z_p50) ≥ c̃, where c̃ = the median estimated $50 round-trip cost at h_end over eligible B with z at or above the 90th percentile.
- **PASS:** the CI lies above 0, N ≥ 10, and materiality holds.
- **KILL:** β̂_G ≤ 0, or the CI lies above 0 but the effect is immaterial.
- **UNRESOLVED:** β̂_G > 0 but the CI includes 0, or any gate above unmet. This counts as not supported for the bot.

## Secondary (descriptive)
- β_G − β_U.
- A trailing 6 h version of G.
- Average cost basis instead of FIFO.
- Day-blocked out-of-sample incremental R².
- Y_C, net buying by cohort owners only (the mechanism check).
- Theme exclusion by a creation-text cluster fitted only on coins created before h.
- Discovery-day estimates.

## Stage 2 (only after a PASS; separate registration)
- **Entries:** top-decile G.
- **Trade:** buy at the first swap after h_end + d; exit at the first swap after +6 h.
- **Benchmark:** 10 matched random eligible B of the same age in the same hour.
- **Data:** needs an untouched later window with at least max(300, n_power at the family level) trades on at least 10 days.
- **Interval:** family-level CI (99.5% two-sided, Bonferroni k = 10); 95% also reported.
- **Sizes:** $50 is the primary. Also $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and impact shown separately.
- **Costs:** the conservative scenario, in SOL. $50 = 419,252,054 lamports at SOL $119.26 (414,009 lamports fixed per round trip, rent loss included).

## Look-ahead guards
- **Cohort:** built only from slots before day D.
- **Controls:** the control group is defined as 'did not buy B in D−7..D−1', never 'never bought B'.
- **FIFO:** lots are matched only to earlier buys. Warm-up comes before the first decision day.
- **Thresholds:** caps and wash thresholds come from discovery days only.
- **Universe:** chosen from the state at h.
- **Normalisation:** by values at h_end, never by the future window.
- **Days:** no sealed-window day and no U1-B holdout day. The coverage-check window is bounded before 09-12, and outcome windows end inside the data.
- **Leak test:** a planted sell one slot after h_end must not change G_B(h).

## Budget
- **Stage 0:** 0 credits.
- **Coverage check:** at most 0.45M credits.
- **Stage 1:** 0 credits on archive days.
- **Builder:** about 2-3 days for FIFO lots, cohorts, controls and the panel.
- **Compute:** about 1.4B rows, streamed day by day.

## Executor notes

Commit research/audience-probe/PREREG.md now (stage 1 only).

What runs now: nothing.
- The zero-cost Stage 0 counts run only if Step C of the tape is read for ideas 4 or 5.
- The community-probe builder may add them, because both use cohort and graph code over S.

What waits:
- Do not request the Helius fallback.
- Run the coverage check only after Stage 0 passes, and only when the archive days 07-20 to 09-11 are published or queued.
- Run stage 1 only on those days.

Rules:
- The outcome scoring script stays separate from the feature code.
- A fresh reviewer and a red team check the code against this PREREG before validation is read.
- No pump.fun requests; python3 -I.
