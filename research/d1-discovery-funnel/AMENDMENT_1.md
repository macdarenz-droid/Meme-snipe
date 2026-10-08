# D1 amendment 1: answers to the scoring code's open questions

Design owner's rulings (brainstorm partner), 2026-10-08, before the search runs on any full Step A day. They answer `research/d1-discovery-funnel/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co. Every item not named below is confirmed as the code reads it.

- **Item 10, our own buy left out of the exit state:** keep it, but it is conservative, not optimistic. Under constant product our buy's reserve change stays in the pool, so leaving it out understates the price we sell into.
- **Item 11, rent:** use the rent for the token account the mint actually needs. A Token-2022 associated account with extensions (170 bytes) costs 2,074,080 lamports. Apply RENT-1's refund model to that amount. This is the more conservative cost, and the same ruling applies to G1 and H1-CGO.
- **Item 23, binary or degenerate features:**
  - For a binary feature, "top" is value 1 and "bottom" is value 0.
  - A feature whose 20th and 80th percentiles are equal in a training fold gives no rule in that fold.
  - NaN is in neither extreme.
- **Item 24, the cost screen, clarified before any search ran:**
  - Its intent was that a rule must clear costs: an out-of-fold mean **net** return above 0. Requiring net to exceed the cost again would charge costs twice.
  - The screen is therefore: out-of-fold mean net return above 0 in every fold, and the sign the same in all four folds (item 25).
  - Validation stays as frozen: a 99.5% lower bound above 0, at least 300 trades, each day positive, a lift above random, then a forward confirmation.
- **Item 28:** a pool seen on two days counts as two clusters, one in each day stratum. Confirmed.
