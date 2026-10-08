# H1-CGO: holders' capital-gains overhang (pre-registration)

Drafted 2026-10-08 (Melbourne) by the brainstorm partner; ranked next by the research lead in round 9. Written before any shared-tape day exists; nothing here was computed on market data. Tape only, 0 credits. Changes after a reviewer signs it are logged as dated amendments with a reason. Chances are judgement.

## 1. Idea and who pays
- Every test so far read price or social data. H1-CGO reads who holds the coin and at what cost, which no test has used.
- Capital-gains overhang (CGO): how far the price sits above or below the average cost of the coin's current holders. In stocks, the disposition effect (selling winners early, holding losers) makes high-CGO stocks earn more later (Grinblatt and Han, 2005, Journal of Financial Economics; I am confident the paper exists, and its details are worth checking). For memes the sign is not obvious: holders in profit may keep selling instead, because there is no fundamental value for the price to return to. So the sign is chosen once on discovery days and frozen (section 7).
- Who pays: holders whose selling or holding depends on their own entry price rather than on the coin.
- Chance of a tradable edge: about 2–4% (judgement). It is low because a 60-minute hold on a young pool must clear a round trip of about 3% at $50.

## 2. Data
- Shared tape (`research/SHARED_TAPE_PLAN.md`, SCHEMA):
  - S: curve and PumpSwap swaps with `owner` (= `user_token_owner`), amounts, fee parts and reserves.
  - T: token movements outside pump instructions. For mints ending in "pump", T holds every movement in every successful transaction (`docs/research/historical-data.md`).
  - C: creates. G: migrations.
- Discovery days: Step A (2026-09-11, 09-10). Validation days: Step B (2026-09-07..09-09), if Step B is released under the tape plan's rules. Without Step B, H1-CGO waits; it never justifies a step on its own.
- Windows: before the wall, outside U1-B's holdout (09-12..09-21) and the sealed window. A decision whose 60-minute window would end after the last slot read is dropped by time, before any outcome is read.

## 3. Universe and decision points
- Canonical PumpSwap SOL pools of pump graduates, created (C row) on a tape day, so the whole holder history is on the tape. Not mayhem, not cashback, SOL quote only.
- Decision points: each whole UTC hour from migration + 60 minutes (H10's floor) to migration + 24 hours.
- Eligible at a decision point, from as-of data only: effective quote (vault + signed `virtual_quote_reserves`) of at least 50 SOL, and a real vault of at least 30 SOL.
- At most one entry per mint per UTC day (the first qualifying decision point).

## 4. Measuring CGO (as of the decision slot)
- Per (mint, owner), keep tokens held and their cost in SOL with the average-cost method:
  - a buy adds its tokens and the SOL the owner paid, fees included;
  - a sell removes tokens and a proportional share of cost;
  - a transfer moves tokens and a proportional share of the sender's cost to the receiver;
  - tokens with no known cost (for example, received from an owner whose cost is unknown) are marked "unknown".
- Excluded from holders: the bonding curve, the pool's vaults, burn and protocol accounts, and BOOST burns.
- Coverage = known-cost tokens ÷ all tokens held by included owners. A decision point needs coverage of at least 90%.
- Reference price RP = total known cost ÷ known-cost tokens. P = the pool's executable mid on effective reserves. CGO = (P − RP) ÷ P.

## 5. Gate H1-CGO-0 (discovery days; reads no forward return)
- (a) Eligible decision points with coverage of at least 90%: at least 150 a day on average. Fewer means validation cannot reach 300 trades, so H1-CGO closes as untestable.
- (b) CGO must not be a disguised price path. Regress CGO on the pool's returns over the past 1 hour, past 6 hours and since migration. If R² is at least 0.8, CGO is mostly momentum (already dead), and H1-CGO closes.
- (c) CGO's spread between the 20th and 80th percentiles must be at least 0.2. Otherwise the feature barely varies, and H1-CGO closes.
- The gate reads timing, holdings and past prices only, so it sits outside the loop family.

## 6. Trade rule (fixed now, except the sign)
- Breakpoints: the 20th and 80th percentiles of CGO over all eligible discovery decision points, frozen before validation.
- Entry: a buy of $50 at the repo's reference price ($119.26, so 0.4193 SOL) on the canonical pool, D = 23 slots after the decision slot. Price: the worse of the pool state at the start and at the end of that slot. Fee: the tier the program applies at that market cap.
- Exit: a sell of all tokens 60 minutes after entry (+ D slots), priced the same way. There is no stop: this tests the feature, not an exit.
- Costs, all in SOL: venue fees and impact on both legs, and fixed costs as `packages/backtest/src/research/edge-costs.ts` charges them.

## 7. Futility and sign (discovery days; may only kill or fix the sign)
- For both extremes (CGO above the 80th percentile, below the 20th), compute the mean gross 60-minute return of entries minus that of all eligible decision points (the lift).
- The sign is the extreme with the larger lift. It is frozen, with the breakpoints, in a commit before any validation day is read.
- Futility: if that lift is below the median round-trip cost of the discovery trades at $50, H1-CGO closes as not supported.

## 8. Primary statistic and judgement (validation days)
- Primary: mean net return per trade in SOL for entries in the chosen extreme, pooled over the validation days.
- Interval: a pool-clustered bootstrap stratified by day (10,000 resamples, fixed seed), 99.5% two-sided (the loop family's 0.005), with 95% shown beside it.
- **Pass, all required:**
  - the 99.5% lower bound is above 0;
  - at least 300 trades;
  - the mean is above 0 on each validation day;
  - the point lift over all eligible decision points (same costs) is above 0.
- Short of a pass: fewer than 300 trades is **unresolved**; anything else is **not supported**.

## 9. Checks before scoring (worker, then a fresh reviewer)
1. As-of only, with a planted future-marker test.
2. Cost-basis accounting on fixtures: buy, sell, router trade (owner differs from signer), transfer in and out, sell that closes an account.
3. Coverage counts, and the excluded accounts listed by address type.
4. Code, seeds and input hashes committed before validation days are read.

## 10. Secondary (reported, never judged)
- Holds of 15 minutes and 4 hours. All five CGO quintiles.
- Sizes $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and price impact shown separately.
- CGO measured on holders who bought after migration only.

## 11. What a pass earns
- A confirmation on data H1-CGO never touched (the forward recorder), under the mechanics in force then. Nothing live, and no change to the bot without the owner.
