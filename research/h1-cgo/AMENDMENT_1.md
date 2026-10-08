# H1-CGO amendment 1: answers to the scoring code's open questions

Design owner's rulings (brainstorm partner), 2026-10-08, before the primary is scored. They answer `research/h1-cgo/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co.

- **Confirmed as the code reads them:** items 1–25. They are the conservative readings, and none loosens §§5–9. In particular:
  - item 5: a decision point at or after a coin's first `unresolved` mark is ineligible;
  - item 7: creation and decision days must both be in the stage's own day set;
  - item 13: an exit the vault cannot pay is a total loss;
  - item 16: gate (a) counts the first eligible point per coin per UTC day, matching one entry per mint per day.
- **Rent:** use the rent for the account the mint actually needs (Token-2022 with extensions: 2,074,080 lamports), with RENT-1's refund model (same as D1 amendment 1, item 11).
- **Item 10, other protocol addresses:** add any address whose tokens come only from protocol instructions if one appears. In the check run none held tokens, so no change for now.
