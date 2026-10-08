# G1 amendment 6: synthetic migration and the v3 decode gap

Brainstorm partner, 2026-10-08, before any primary is scored. From sweep 5 (`research/brainstorm-loop/SWEEP_5.md`).

- **Fact:** pump-public-docs added `SYNTHETIC_MIGRATION.md` on 2026-10-07. A curve-crossing buy (`buy_v3`) completes the curve and buys into the new pool in one step, with no maximum size. Later curve trades fail with `BondingCurveComplete`. The date it went live on mainnet is UNVERIFIED. The tape decoder's pump IDL has no `buy_v3`, `buy_exact_quote_in_v3` or `PostCompleteBuyEvent`.
- **Tape days (09-02..09-11):** they predate the documentation. G1-0 adds a row: the count of `PostCompleteBuyEvent` (expected 0, and "not checkable" until the decoder has the v3 items).
- **Forward days:**
  1. Add the v3 IDL items to the decoder before any forward day is decoded. Add a unit check that flags pools whose opening reserves differ from a plain migrate deposit when no `PostCompleteBuyEvent` is present.
  2. G1-0's catchable share on the tape days is an upper bound for forward days. Re-count it on post-v3 days before any forward return is read.
  3. The v3 completer is a new rival seller into the same BOOST flow. Report its pool part per graduation.
- **BOOST accounting row (descriptive):** for each slice, `virtual_quote_reserves`, `real_quote_reserves_after` and `boost_vault_remaining`. G1's exit stays priced on vault + signed virtual reserves.
