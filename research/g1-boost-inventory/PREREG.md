# G1: curve inventory into migration (pre-registration)

Drafted 2026-10-08 (Melbourne) by the brainstorm partner, agreed by the research lead in round 7 ("AGREED G1, cap 0 credits, spawner: lead"). Written before any shared-tape day exists. Nothing here was computed on market data. Changes after a reviewer signs it are logged as dated amendments with a reason, never edited in place. Chances are judgement.

## 1. Idea and who pays
- Earlier graduation tests bought at or after migration and raced the snipers (`docs/research/edge.md` line 75: 0 of 72 rules; line 175: BOOST window dropped for the 23-slot delay). None held curve inventory into migration.
- G1 buys on the bonding curve shortly before completion, when no race exists, and sells after migration to two price-blind buyers:
  - the protocol's BOOST buy-and-burn: about 17.6 SOL per SOL pool, spent as a TWAP in the first 5 minutes after migration (`docs/research/venues.md` 2.6, line 110; live since B2, 2026-07-21);
  - the opening snipers.
- Who pays: the protocol rule and the snipers. Who competes: creators and early holders, who also sell into the end of the curve and the open (`venues.md` line 57).
- Chance of a tradable edge: about 4–7% (judgement).

## 2. Data
- Shared tape (`research/SHARED_TAPE_PLAN.md`, SCHEMA): S (curve and PumpSwap swaps with reserves, `virtual_quote`, fee parts, flags `boost`, `mayhem`, `protocol`), G (migrations, pool creations), C (creates: quote mint, mayhem, cashback). No other source and no credits beyond the tape.
- Discovery days: Step A (2026-09-11, 2026-09-10). Validation days: Step B (2026-09-07, 09-08, 09-09). BOOST has been live on all of them.
- Windows: every day is before the wall (2026-09-21T14:00Z), outside U1-B's holdout (09-12..09-21) and outside the sealed window. A decision whose window (entry + 30 min + exit delay) would end after the last slot of the days read is dropped by time, before any outcome is read.
- B3 (2026-09-09 19:30Z) falls inside validation day 09-09. Fees are therefore taken from each trade's own on-chain fee fields, never from today's snapshot.

## 3. Universe
- Pump bonding curves quoted in SOL, created by `create` or `create_v2`, that reach the trigger on a tape day.
- Excluded at decision time, from as-of data only: mayhem coins, cashback coins (H17) and non-SOL quote. Flags come from the create row, or from the trade rows when the create predates the tape (`mayhem_mode`, `quote_mint`, a non-zero cashback fee). A curve whose flags cannot be read is excluded. The curve's state needs no create row: each trade event carries its reserves.
- At most one trade per mint. Each curve completes at most once.

## 4. Rule (primary configuration, fixed now)
- **Progress:** real SOL in the curve = `virtual_sol_reserves − 30 SOL` after each curve trade (curve trade reserves are after the trade). Target = 85.005 SOL (`research/edge/snapshot/pump-global.json`; `venues.md` 2.2). The worker checks that the target holds on the tape days from the first completions; a mismatch is logged as an amendment before validation.
- **Trigger slot t0:** the first curve trade whose real SOL reaches at least 90% of target (76.50 SOL).
- **Landing delay D:** 23 slots (the repo's conservative entry delay). Delays are counted in slots, never in seconds.
- **Entry:** a buy of the trade size on the curve in slot t0 + D. Price: the worse of the curve state at the start and at the end of that slot, with our own impact on the constant-product virtual reserves and the curve fee from the neighbouring trades' fee fields. If the curve completes in a slot before t0 + D, there is no entry; the miss is counted and reported, not scored.
- **Exit A (migration):** if the migration (G row, `CompletePumpAmmMigrationEvent` and pool creation) lands in slot m, sell all tokens on the canonical PumpSwap pool in slot m + D. Price: the worse of the pool state at the start and at the end of that slot, on effective quote = vault + signed `virtual_quote_reserves`, with the fee tier the program applies at that market cap (see 7, check 3), and the sell capped by the real vault.
- **Exit B (abort):** if no migration lands within 30 minutes of entry (by block time), sell on the curve in the first slot at least 30 minutes after entry, priced as the entry.
- **Size (primary):** $50 at the repo's reference SOL price ($119.26, so 0.4193 SOL).
- **Costs, all in SOL:** both legs' venue fees and price impact as above; fixed costs per filled round trip exactly as `packages/backtest/src/research/edge-costs.ts` charges them (base fee, priority fees, tip, expected failed exit attempts, RENT-1 rent loss). The worker checks the token-account size for Token-2022 mints and uses the matching rent; a mismatch with the repo's 1,513,840 lamports is logged.

## 5. Control (S0)
- For each validation day, random curve buys on the same universe at a uniformly drawn progress between 50% and 80% of target, one per mint, with the same entry delay, exits, sizes and costs. Seeds are fixed and committed before scoring.
- S0 shows whether any gain comes from holding into migration and BOOST rather than from the curve in general.

## 6. Gate G1-0 (discovery days only; reads no strategy return)
- (a) Curves a day that reach the trigger (after the universe rules).
- (b) Slots from t0 to migration, for curves that migrate. Report the median and the share with more than D slots (we can be filled before completion).
- (c) BOOST timing for each migration: slots from m to the first and to the last `boost_buy_and_burn`; the share of the BOOST quote spent after m + D; the share of graduates with any BOOST.
- **Kill (G1 closes, no return read):** the median in (b) is D slots or fewer; or the BOOST quote spent after m + D is under 25% on most graduates; or fewer than 100 catchable triggers a day on average over the two discovery days, since validation then cannot reach 300 trades.
- The gate sits outside the loop family: it reads timing, not returns.

## 7. Checks before scoring (worker, then a fresh reviewer)
1. The trigger, entry, exits and costs use only data in slots at or before the decision slot (as-of). A planted future marker test fails if any step can see a later slot.
2. Curve trade reserves are after the trade; PumpSwap reserves are before the trade (`docs/research/historical-data.md`). The worker tests both on fixtures.
3. Which market cap the PumpSwap tier rule uses (effective quote, base reserve, supply after BOOST burns or 1B), read from the program or IDL. The same check as Design A's round 7 amendment (a).
4. The 85.005 SOL target and the 0.015 SOL migration fee (`pump-global.json`) against the first tape completions.
5. Code, seeds and the input file hashes are committed before validation days are read.

## 8. Futility (discovery days; may only kill)
- After G1-0 passes, the primary is computed on the discovery days for information only.
- If its one-sided 95% upper bound is below 0, G1 closes as not supported, and Step B is not released for G1.
- Discovery results never change the rule. Any change is an amendment that resets G1 to a new idea.

## 9. Primary statistic and judgement (validation days)
- Primary: mean net return per filled trade in SOL (net SOL change ÷ SOL paid in, fixed costs included), pooled over the three validation days.
- Interval: a pool-clustered bootstrap stratified by day (10,000 resamples, fixed seed), 99.5% two-sided (the loop family's 0.005), with 95% shown beside it.
- **Pass, all required:**
  - the 99.5% lower bound is above 0;
  - at least 300 filled validation trades;
  - the mean is above 0 on each validation day;
  - the point lift over S0 is above 0.
- Short of a pass: fewer than 300 filled trades is **unresolved**; anything else is **not supported**.

## 10. Secondary (reported, never judged)
- Exit delay 8 and 45 slots; exit at m + 2D (one failed exit attempt); exit at m + 150 and m + 750 slots (about 1 and 5 minutes, inside and at the end of the BOOST TWAP).
- Trigger at 80% and 95%.
- Sizes $5, $20, $100, $1,000 and $10,000 (owner rule "Size is not the trial"), each with gross return, fixed costs, percentage fees and price impact shown separately. A size the remaining curve cannot fill is reported as infeasible.
- Decomposition: curve leg (entry to last curve price), migration step, and the window m to m + D.
- Flow in m to m + D: BOOST quote spent, sniper buys, and sells by wallets that held before migration.
- Share of entries ending in exit B, and their mean.

## 11. What a pass earns
- Nothing live. First, a confirmation on data G1 never touched, under the mechanics in force when it runs: the forward recorder, or the sealed window after 2026-10-21 if the supervisor allows. Negative `virtual_quote_reserves` (from 2026-09-30) and any later pump change must be modelled there.
- Then a paper strategy proposal through the Blueprint's strategy slot. It needs the owner, because it trades inside H10's excluded window (before migration + 60 min) and on the curve, which is paper-only today. It is not a first-block snipe: it buys before completion and sells after migration.
