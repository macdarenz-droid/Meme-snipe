# H1-CGO amendment 6: the $5 tradable sample follows the bot (lead ruling, 2026-10-08, before any primary is scored)

The red team found that H1-CGO and D1 build their H8-tradable $5 samples differently:
- H1-CGO took the first entry per coin per day and then applied the H8 filter.
- D1 applies its own limit inside the H8-eligible subset.

The bot only ever considers entries that pass its gates, so the tradable sample must do the same. From now on, the H1-CGO H8-tradable stratum applies the H8 filter first, then keeps the first H8-eligible entry per coin per day. The unfiltered primary is unchanged. This aligns H1-CGO with D1's reading and is decided before any outcome is read.
