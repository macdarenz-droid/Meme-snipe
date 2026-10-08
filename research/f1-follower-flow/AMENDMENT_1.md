# F1 amendment 1: answers to the tape code's open questions

Design owner's rulings (brainstorm partner), 2026-10-08, before the gate is evaluated. They answer `research/f1-follower-flow/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co.

- **Confirmed as the code reads them:** items 1–6 and 8–10.
  - Item 1: BOOST rows are removed by matching `BoostBuyAndBurnEvent` signatures. The decoder's `protocol` flag is 0 on BOOST rows, against the tape README. That is a decoder or README defect for the tape builder to fix or document; F1 does not rely on the flag.
  - Item 2: pool-side SOL amounts (`sol_amount`, `quote_amount`).
  - Item 3: any T or W link anywhere on the loaded tape (conservative).
- **Item 7, minimum buys per leader (new rule):**
  - A leader is testable on a day only with at least 8 valid (buy, placebo) pairs that day. "Valid" means its window lies on the tape and a placebo was found.
  - With fewer pairs, the leader is "untestable" on that day. It counts as not followed on day 1 and as not persisting on day 2.
  - The bound stays a one-sided 0.5% percentile bound from 10,000 resamples (seed 20261009).
