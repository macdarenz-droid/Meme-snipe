# Shared tape Phase 0: done (one unit of 2026-09-11)

Builder session, 2026-10-08. Run 16:51–17:17 AEDT (05:51–06:17Z). Spec: research/SHARED_TAPE_PLAN.md. Step A not started; the parent decides.

## Preconditions
- P2: `HELIUS_DAYS="2026-09-21 2026-09-11 2026-09-10"` (commit d5dd99d; test-ci 136/136). No data-day release exists for 09-10 or 09-11.
- P3: the owner approved attaching zeroed-data with push access in this session. The tape is on a new branch, `tape`, under `tape/` only. After the run, `main` (56aa581) and the `rec-*` tags were unchanged.
- P4: the tee capped this process at 10/s, then 25/s, honoured Retry-After, and would have stopped after 3 consecutive 429 or 403 answers. There were no 429s or 403s. The parent reported no other research use of the key; a Zeroed or Blueprint server might still have used it, at an unknown rate.
- P1: the owner waived the dashboard readings on 2026-10-08, so the ledger below is the only count of calls.
- Review: one fresh opus review. Its blocker B1 (the identity check counted the unit-selection calls) was fixed. Its re-check found one new blocker, a burst above 25/s after a pause, which was also fixed, with a test that fails before the fix and passes after. Both fixes landed before any Helius call.

## Unit
- Epoch 1032, slots 446017500–446021999. 4,496 blocks, 4 slots skipped.
- First block 2026-09-11T00:12:43Z, last 00:36:34Z: about 318 ms a slot.
- It is the first whole unit of the day: the unit before it starts 2026-09-10T23:48:54Z.

## Calls (tee ledger, by method)
| Method | Calls | HTTP 200 | 429 | 403 |
|---|---|---|---|---|
| getBlock | 4,496 | 4,496 | 0 | 0 |
| getBlocks | 1 | 1 | 0 | 0 |
| getBlocksWithLimit (unit choice) | 2 | 2 | 0 | 0 |
| getBlockTime (unit choice) | 2 | 2 | 0 | 0 |
| **Total** | **4,501** | 4,501 | 0 | 0 |

- No retries and no local refusals. Paused 0 s. The cap was 6,000; 4,501 are booked in credits-used.
- Identity holds: rpcscan's credits = requests = 4,497 (getBlock and getBlocks), and its response_bytes equal the tee's decoded bytes of those methods.
- The unit rebuilt from the spool has the same digest as the live unit.

## Rates and bytes
- At the 10/s setting: 2,000 calls in 215 s (9.3/s).
- At the 25/s setting: 2,501 calls in 220 s (11.4/s). The rate cap was not the limit: bandwidth was. 4.62 GB came over the wire in 434 s, about 10.6 MB/s, with a mean latency of 1.15 s and 32 requests in flight.
- Bytes per block: 1.03 MB gzip on the wire, 4.87 MB decoded. The plan assumed 2.1–2.5 MB decoded.
- Request time: 434 s for the unit.

## Rows per table (one unit; research tables keep every mint)
| Table | Rows | File size |
|---|---|---|
| S (curve) | 57,527 | 11.4 MB |
| S (PumpSwap) | 426,234 | 82.2 MB |
| F failed | 119,031 | 10.2 MB |
| W transfers ≥ 0.05 SOL | 182,040 | 16.7 MB |
| T movements (+ coverage) | 61,753 (+777) | 3.7 MB |
| D delegations | 2,164 | 0.14 MB |
| B blocks | 4,496 | 0.07 MB |
| E other events (C: 653 CreateEvent; G: 22 CompleteEvent, 22 migrations, 66 CreatePoolEvent) | 2,109 | 0.34 MB |
| H hourly census | 4,135 | 0.48 MB |

- Decoder counts: 5,595,870 transactions (3,026,439 votes); 794,341 failed.
  - 569,467 ran pump or PumpSwap, and 119,031 of those failed.
  - Truncated logs: 5,440, of which 2,371 ran pump or PumpSwap.
  - Decode errors: 0. Blocks dropped as outside the day: 0.
- F classes:
  - slippage 88,212
  - other program 19,032
  - insufficient funds 7,473
  - account or constraint 2,444
  - liquidity 1,014
  - cyclic arbitrage 240
  - arithmetic 209
  - compute 195
  - state 140
  - unclassified 72 (0.06%)

## Disk and CPU
| Item | Per unit | Per day (×60.4 units) |
|---|---|---|
| Core unit | 81 MB | about 4.9 GB |
| Research tables | 125 MB | about 7.6 GB (the plan estimated 1.5–4 GB) |
| W alone | 16.7 MB | about 1.0 GB, right at the plan's 1 GB keep line |
| Raw spool (zstd) | 3.0 GB | about 181 GB: cannot be kept |

- The day count of 60.4 units comes from 318 ms slots (about 272k slots a day).
- Decode: 417 s wall, 1,253 s CPU (4 workers).
- The spool replay digest check took 11 minutes.

## Upload
- zeroed-data, branch `tape`, commit 6fa7560: `tape/2026-09-11/phase0/` with 27 files (core unit, research tables, ledger, usage, decode stats, getBlock manifest, SHA256SUMS).
- Read back from a fresh clone: every sha256 matched. GitHub warned that S_amm (78 MB) is above its 50 MB recommendation; the hard limit is 100 MB.
- The raw spool (3.0 GB) is kept only in this container (/home/user/tape-work/spool), for a re-decode if the parent wants one. It is not uploaded.

## Estimates for Step A (09-11 and 09-10), from this unit
- Credits: about 4,500 calls a unit × 60.4 = about 272k a day, about 0.55M for Step A, in line with the plan's 0.6M.
- Time: at about 11 blocks a second (bandwidth-bound), a day takes about 6.9 h of requests, not the plan's 2.7–3.3 h.
- Decode CPU: about 21 CPU-hours a day, so decoding must run alongside the reads.
- Disk: the spool must be decoded and deleted unit by unit. It cannot be kept: one day would be about 181 GB.

## Open for the parent before Step A
- B2 (review): rpc-run's planner adds a 3,600 s margin on each side of the day, so a full read of 09-11 would also read 09-12 blocks (00:00–01:00Z, U1-B's holdout) and write them into core units. The research decoder drops them, but the core units would hold them. Step A needs units clipped to the day, or a supervisor ruling.
- Step A runs per unit, not through rpc-day.sh. Each unit's spool is decoded, then deleted. Uploads go per unit or in batches, because GitHub refuses a push above 2 GB.
- The replay digest check takes 11 minutes a unit. For Step A, either run it on a sample of units or accept the counter identity alone.
- m9 (review): with these days in HELIUS_DAYS, anyone can now start a data-scan helius run for them on the same key. Nothing enforces "one user of the key".
- W is at the 1 GB a day line: keep it or drop it.
- The research tables are 2–5× the disk estimate.
