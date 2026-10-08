# D1: a pre-registered discovery funnel on the tape

Drafted 2026-10-08 (Melbourne) by the brainstorm partner. Nothing here was computed on market data. Tape only, 0 credits. Chances are judgement.

## 1. Why
- Every design so far was guessed by people and then tested. Two sweeps of guessing now return ideas judged at 0.1–2%.
- D1 lets the discovery days suggest rules, under a fixed budget of what may go on to validation. That keeps the false-pass rate known.
- Chance that D1 yields a rule that passes validation and forward confirmation: about 2–4% (judgement). Most data-mined rules fail out of sample.

## 2. Data
- Discovery: Step A (2026-09-10, 09-11). Validation: Step B (09-07..09-09) if released, otherwise forward recorder days named before any is read. Then a forward confirmation, as for every design.
- Holdouts as everywhere: before the wall, not U1-B, not the sealed window, windows dropped by time if they cross the last slot read.

## 3. Decision points and trades (fixed now)
- Universe: canonical, non-mayhem SOL PumpSwap pools from migration + 60 minutes (H10) to + 24 hours, with effective quote of at least 50 SOL and a real vault of at least 30 SOL. The curve phase is left out, because its builder is paper-only and G1 covers it.
- Decision points: every 5 minutes per eligible pool, as of the decision slot.
- Trade: buy $50 at the decision + 23 slots and sell after a fixed hold of 15 or 60 minutes (two hold arms, both counted in the budget below). Costs in SOL as `edge-costs.ts`, with fees from each trade's own fields and impact on effective reserves capped by the real vault.
- At most one entry per pool per hour.

## 4. Features (fixed list, all as of the decision slot)
Price path: returns over 5, 15 and 60 minutes and since migration; realised volatility over 15 minutes.
Flow: buys, sells and net SOL over 5 and 15 minutes; unique buyers and first-time buyers over 15 minutes; largest single sell over 15 minutes as a share of quote.
Who: share of buy SOL from W1's fast class, from the creator cluster, and from app-routed transactions (`top_program`); share of failed buys (F, slippage class) in the last 15 minutes.
Holders: top-10 share, creator share, H1-CGO's CGO and coverage.
Protocol: BOOST finished (yes or no); market cap relative to 420 SOL; creator-fee collections in the last hour (CF).
Pool: effective quote, real vault, age since migration.
That is 28 features (5 price path, 9 flow, 4 who, 4 holders, 3 protocol, 3 pool). Nothing is added after the first Step A row is read.

## 5. Search on discovery (fixed method)
- Folds: each discovery day is split into four 6-hour blocks; folds leave one block out, with a 60-minute gap on each side.
- Candidates: every single-feature rule "feature in its top or bottom quintile" (56 rules) and every two-feature rule "each of two features in one of its extreme quintiles" (378 pairs × 4 = 1,512 rules), for each hold. Quintile edges come from the training folds only.
- Score: the mean out-of-fold net return per trade, with at least 30 trades in each fold. Rules whose out-of-fold mean is below the median round-trip cost are discarded.
- **Advance at most 5 rules** to validation, the 5 best by score among rules whose sign is the same in all four folds. Their exact definitions and the full-discovery quintile edges are committed before any validation day is read.
- If no rule meets these conditions, D1 closes as "nothing found".

## 6. Validation (each advanced rule is one loop-family test at 0.005)
- Pass, all required: a 99.5% lower bound above 0 for mean net return per trade (pool-clustered bootstrap stratified by day); at least 300 trades; positive on each validation day; a point lift above 0 over random eligible decision points with the same hold and costs.
- Short of a pass: fewer than 300 trades is unresolved; anything else is not supported.
- Over 5 rules at 0.005, the chance of at least one false pass is at most about 2.5%. The forward confirmation catches the rest.

## 7. Checks before scoring (worker, then a fresh reviewer)
- As-of features, with a planted future-marker test; the fold gaps; quintile edges fitted on training folds only; code, seeds and input hashes committed before validation.

## 8. What a pass earns
- A forward confirmation on never-touched days, then a paper strategy proposal through the strategy slot. The bot's entry limits (3 a day, 1 open) are the owner's to change.
