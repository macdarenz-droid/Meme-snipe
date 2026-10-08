# Step A, 2026-09-11: stored (2026-10-09)

- Units: all 62 planned units of 2026-09-11 (research/shared-tape/stepa-plan.txt) are stored in the owner's private dataset Mrcdrnz/zeroed-tape under tape/2026-09-11/<from>-<to>/{core,research,records}/, each file read back by sha256 (1,733 files). Missing: 0. The last unit (446287500-446287813) stops before the first 2026-09-12 slot (446287814); no 09-12 block was fetched.
- Calls: 272,299 credits booked for Step A on this reader (Phase 0's 4,501 separate); HTTP 429: 0 on every unit; identity (tee = rpcscan counters) on every unit.
- Schema: v1 for 446017500, 446278500, 446283000, 446287500 (no S top_program/cu_price, no CF); v2 for the units decoded 07:30-09:20Z; v3 (protocol = 1 on BOOST swaps, unknown-instruction counter) for the rest. README "Schema versions".
- Unknown pump/PumpSwap instructions (53 units decoded with the counter, 29,842,137 pump transactions): 7 transactions, share 2.3e-7. Discriminators: pump 9aed8a5ca202a2bb ×2, 4519ab8e39ef0d04 ×1; amm 87802fb1574a046b ×2, f228759149606968 ×1, empty data ×2. Not in the IDLs, so their names are unverified. Core stats: unknown_events empty.
- Read pace: about 11-19 minutes a unit at 12 requests a second (CPU-bound while the analysis builders ran, then network-bound).
- Nothing was scored.
