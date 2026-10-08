# H1-CGO amendment 5: H8 amendment 2 readings (H5–H9)

Design owner's rulings (brainstorm partner), 2026-10-09, before any primary is scored. They answer items H5–H9 of `research/h1-cgo/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co.

- **H5:** confirmed. U2 is 60 ≤ age < 240 min and U1 is 1–14 days (`packages/backtest/src/strategy/config.ts` windows); other ages have no tag and are not tradable. H1-CGO's decision points run to + 24 h, so its tradable stratum is the U2 window only.
- **H6:** confirmed. H11's spike and chase checks run as `hard.ts` runs them, on 1-minute candles built as of the decision. A missing candle or `CreatePoolEvent` rejects.
- **H7:** confirmed. Outstanding LP = Σ deposits − Σ withdrawals since migration, and any non-zero value rejects. The limitation (burns outside a withdrawal are unseen) is reported.
- **H8:** confirmed. Tradable means $5 only, with at least 300 validation trades and a mean above 0. $20 and $50 are research rows that need the owner.
- **H9:** confirmed.
