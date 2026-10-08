# Design A amendment 2: rulings on the tape code's open questions, and the return test frozen

Brainstorm partner, 2026-10-09 00:53 Melbourne, before `--score-primary` runs and before any return is read. It answers `research/edge-a/tape/OPEN_QUESTIONS.md` Q1 and Q3–Q12 (Q2 is the lead's, in AMENDMENT_1).

## Confirmed as the code reads them
- Q1 (24-point grid, 4 dropped, 20 remain).
- Q3 (BOOST window end and its exclusions).
- Q4 (BOOST rows by signature; `protocol` from decoder v3).
- Q6, Q8, Q10, Q12.

## Q5: gate statistics
- Confirmed:
  - pooled seconds per band (Gate 2), and pooled creator net SOL ÷ pooled hours (Gate 3);
  - an undefined placebo counts as +inf, and a non-finite value at 420 is a fail;
  - the 95% lower bound is the 2.5th percentile of a two-sided percentile bootstrap.
- Registered now: 10,000 pool resamples, seed 20261009.

## Q7: count rule
- Confirmed: only non-BOOST swaps after the BOOST window and before hour 72, with pre-trade cap in [399, 441), count toward the 200 pools.

## Q11: the round-USD check
- It is frozen as count row 6 (`research/brainstorm-loop/STEP_A_COUNT_ROWS.md` §6, frozen by the lead) and implemented there.
- Design A's verdict reads it: if 420 SOL lies within 5% of a round USD level ($50k or $100k) on every tape day, a gate pass is recorded as "not separable from a USD level", and no return test runs.

## Q9: the return test, frozen now (runs only if Gates 2 and 3 both pass)
- **Days:** the tape days released when scoring starts, named in the scoring commit before any return is read.
- **Entry:**
  - Event: the first non-BOOST swap after the BOOST window and before hour 72 whose pre-trade cap is below 420 and post-trade cap is at least 420 (cap per Q2's rule). Only the crossing row is used.
  - Buy at the crossing slot + 23 slots, at the worse of that slot's start and end state.
  - At most one entry per pool.
- **Exit, whichever comes first:**
  - **stop:** the first later swap whose pre-trade cap is below 399; sell at its slot + 23 slots, worse-of state;
  - **time:** 60 minutes after entry, then + 23 slots.
- **Size and costs:**
  - $50 (419,252,054 lamports at $119.26) is primary; $5 is reported as the trial size.
  - Costs in SOL: each trade's own fee fields (the tier at that cap), impact on effective reserves capped by the real vault, 414,009 lamports fixed, rent by date (`research/brainstorm-loop/RENT_BOUNDARY.md`).
  - An exit the vault cannot pay is a total loss.
- **Control:** crosses from below at each of the 20 placebo levels L, under the same rules, with the stop at 0.95 L and the same 60-minute time exit. All placebo-cross trades are pooled into one control mean.
- **Statistics:**
  - mean net of the 420 trades, and lift = that mean − the placebo-cross mean;
  - pool-clustered bootstrap stratified by day, 10,000 resamples, seed 20261009;
  - 99.58% two-sided (Design A's registered family level, 0.05/12).
- **Pass, all required:**
  - both lower bounds above 0;
  - at least 300 trades;
  - positive on each day read.
- **Short of a pass:** fewer than 300 trades is unresolved; anything else is not supported.
- **Tradability:** a pool near 420 SOL cap holds about 86 SOL of effective quote, below H8's floor at every size (`research/brainstorm-loop/H8_AMENDMENT_2.md`). A pass is reported as "works only below H8's floor"; use needs the owner.
