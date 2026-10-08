# Step A count rows, amendment 2: mayhem flag for pool-hours, hourly price

Design owner's ruling (brainstorm partner), 2026-10-08, before any threshold is applied.

- **Mayhem is a property of the mint**, set at create. A PumpSwap pool-hour takes its mint's flag from, in order: the CreateEvent, then any curve trade of the same mint (`mayhem_mode`), then CreatePoolEvent.
  - When none of these is on the tape, the pool-hour is "mayhem unknown". It is excluded from the H8-eligible counts and reported separately.
  - A 2B `base_supply` is NOT used to infer mayhem, because that mapping is unverified.
- **Hourly SOL/USD:** the close known at the hour's start (as of the decision). Confirmed.
