# OF-FIX batch-1 zero units: review log

Card: Z-H, Old Faithful chain, OF-FIX. Builder: `session_01JfcmEyJ1AqL4BQbyoGAZHT`, branch `claude/of-fix` from `fa741fb4` (#326, the revert of the arm #321). Supervisor: `session_01UQmXJHSgmb2Tj7PK7VDKRz`.

## Fault

Batch 1 was data-scan run 38776359833 for 2026-07-22. The scan step exited 0 after about 15 s with "progress-guard: 0 finished units". The K3 trim then refused ("holds no finished units", `trim-day.sh`), and nothing was written to `zeroed-data`. It counts as 1 failure of 3.

## Root cause

The root cause is shown from the code and an anchor already in the repo, without reading the archive.

- The old `planUnits` (`scanner/main.go`, before this change) estimated a slot from one anchor: slot 452,500,000 at 1,790,914,653, about 0.267 s per slot in Oct 2026. It then opened the estimated epochs ±2.
  - For 2026-07-22 00:00Z the estimate is slot 429,153,310, which is epoch 993, so it opened epochs 991–996.
- `research/historical/regimes.json` B2 puts slot 434,319,990 at 2026-07-21T14:23Z. That places 07-22 in epoch 1005 (slots 434,160,000–434,591,999), possibly running into 1006.
- Epochs 991–996 exist in the archive, so they opened. But their interpolated block times all lie before the day, so no unit passed the time filter. The plan was empty and the scanner exited 0.
- `scan-day.sh` took exit 0 as "scanned".
- Proof (OFX-5): `TestPlanUnitsFakeArchive/2026-07-22` was run against the old planner, with the old `planUnits` restored next to the new test files. It fails with `epochs 991-996, 0 units: epoch 991 does not hold the window start`. It passes on the new planner.

## Supervisor rulings (15 Oct)

- **OFX-1.** The bracket comes from the cited anchors, with slot time bounded to 0.20–0.50 s.
  - A day outside the bracket is an error, never silently widened.
  - At most 10 epochs are probed per day; above that the plan fails closed.
  - The fake-archive test pins the caps:
    - 07-22: at most 14 requests and about 20 MiB of range reads.
    - Every allow-listed day: at most 8 probes.
- **OFX-2.** `scan-day.sh` fails at the scan step on 0 finished units. `planUnits` returns an error, never an empty plan. A needed epoch that is "not in the archive yet" is an error for that day.
- **OFX-3.** A new row `B10-PULL id=b10pull-of-2` carries the new scannerRev and cites this fix.
  - `b10pull-of-1` stays as history.
  - The builder drafts the row and the supervisor confirms it in review.
  - `ARCHIVE_ARM` stays empty in this PR.
- **OFX-4.** The failure count stays at 1 of 3, with no reset. Re-arming is a later, separate reviewed change. The batch summary prints "N units planned" and the epoch list, and N = 0 is a failure.
- **OFX-5.** The proof test fails on the old planner and passes on the new one. `archiveBase` is a test-only seam that production code cannot override, and a test checks that.

## What was built

- `scanner/plan.go` holds `epochBracket`, `pickEpochs` and the new `planUnits`.
  - The anchor nearest the window start (B2, B4, or the October slot) bounds the epochs at 0.20–0.50 s per slot, with ±120 s of slack because B2 and B4 are known only to the minute.
  - A bisect on epoch first-block times finds the last epoch whose first block is at or before t0.
  - A walk then adds epochs while the next one starts before t1.
  - Each probe is `OpenEpoch` (cid, HEAD, 64 B header) plus one 4 MiB first-block read. The selected epochs also get one 4 MiB last-block read, as before.
  - It fails when:
    - the window start lies before the bracket;
    - the window end lies past it;
    - more than 10 epochs are probed;
    - an epoch is missing (`errNotInArchive`);
    - the plan is empty.
- The scanner writes `plan.txt`, containing "N units planned (epochs …)" with a count and epoch numbers only, and refuses to run on 0 units.
- `scan-day.sh` copies that plan line to the summary. On scanner exit 0 the day fails with exit 1 at the scan step if the plan line is missing, if N = 0, or if there are 0 finished units. It is then never reported as "scanned".
- `archiveBase` is now a `var` that starts as `defaultArchiveBase`. No flag, environment variable or non-test file assigns it or takes its address; `TestArchiveBaseIsATestOnlySeam` parses every non-test file to check this.
- The B10-PULL rows are append-only, and `ag_pinned_id` required exactly one. So an older pin is now retired by a `B10-PULL-RETIRED id=<old> by=<new>` row whose `<new>` is itself a pinned row.
  - A retirement by an unknown id, or two pins retiring each other, leaves nothing pinned, which fails closed.
  - The test-ci OF-7 row check applies the same rule.

## Open point for the supervisor

OF-2 ruling 36 keeps the scanner's plan counts out of the job log and step summary. OFX-4 asks for "N units planned" and the epoch list in the batch summary. The line that reaches the summary carries only the unit count and the epoch numbers. Neither is archive content: both follow from the day and the epoch layout. Per-unit counts (curve, amm and so on) stay private. This reading of OFX-4 over ruling 36 needs the supervisor's confirmation.

## Evidence

Go tests: `cd research/historical/scanner && go test .`. test-ci: `bash research/historical/ci/test-ci.sh`. Counts are in the PR body for the exact head.
