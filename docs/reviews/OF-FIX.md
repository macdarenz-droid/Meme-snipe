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
  - A bisect on epoch first-block times finds the last epoch whose first block is before t0 (OFX-8).
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
- The B10-PULL rows are append-only, and `ag_pinned_id` required exactly one. So an older pin is now retired by a `B10-PULL-RETIRED id=<old> by=<new>` row.
  - Both `<old>` and `<new>` must be B10-PULL rows, and `<new>` must be dated on or after `<old>` (OFX-7).
  - Anything else leaves nothing pinned, which fails closed: an unknown successor, an unknown retired id, an older pin retiring a newer one, a RETIRED row that cannot be read, one id pinned under two dates, or two pins retiring each other.
  - A chain (a by b, b by c) keeps the newest.
  - The test-ci OF-7 row check applies the same rule.
- An epoch is kept when its first block is strictly before the window start (OFX-8). Block times are whole seconds, so the epoch before one whose first block is exactly at t0 can end with blocks of that same second.
- `firstBlockFrom` stops with an error after walking 64 MiB without a block node (OFX-9). That epoch then fails, instead of the file being read to its end.
- test-ci refuses any workflow or CI script that sets or names `archiveBase` at build time, for example `-X main.archiveBase` in any spelling (OFX-10).

## Review and red team rulings (15 Oct, at cf2a667c): OFX-7 to OFX-10

The review and the red team passed the PR, with two MINORs and two notes. All four were fixed, each with a test that fails before and passes after.

- **OFX-7.** At cf2a667c, a RETIRED row with an unknown successor was ignored, so the retired pin stayed pinned. An older pin could also retire a newer one and re-pin `b10pull-of-1`.
  - Rule: any RETIRED row whose `by=` is not a pinned row, or is dated before the retired row, leaves nothing pinned.
  - test-ci cases: by-unknown, older-retires-newer, retires-unknown, malformed, two-dates and chain.
  - Before the fix, by-unknown, older-retires-newer and two-dates failed.
- **OFX-8.** The bisect and the start check use `t < t0`, and `covers()` matches.
  - `TestPickEpochsSameSecondBoundary` sets t0 to the first block of epochs 1005, 1006 and 1010.
  - Before the fix it picked 1005 to 1005 for the first block of 1005; it now picks 1004.
- **OFX-9.** The walk to the next block node is capped at 64 MiB.
  - `TestFirstBlockFromCapsTheWalk` uses a 96 MiB fake CAR with no block node.
  - Before the fix it returned `no block after offset` after reading to the end of the file; it now returns the cap error after about 64 MiB.
- **OFX-10.** test-ci adds a check that refuses `-X …archiveBase` (or any mention of `archiveBase`) in `.github` and `research/historical/ci`. Fixtures in workflows and scripts are refused; a plain `-ldflags "-s -w"` is not.
- The scanner tree changed, so the `b10pull-of-2` row was re-pinned: scannerRev `730154f67f27fe688d1ca28f11a9e714182a674e-go1.24.7`, pinnedAt 2026-10-15T22:15:21Z.

## Ruling OFX-6 (15 Oct), on the open point

OF-2 ruling 36 keeps the scanner's plan counts out of the job log and step summary, while OFX-4 asked for "N units planned" and the epoch list in the batch summary.

Confirmed, narrowly: the run summary may show ONLY the total planned-unit count and the epoch numbers. Both are public chain facts, and both are needed to see a wrong plan within 15 s. Per-unit lists, sizes, URLs and any archive-derived data stay private, as ruling 36 says.

Recorded as a dated amendment under ruling 36 in `docs/reviews/OF2.md`. `scan-day.sh` copies the plan line only when it matches `^[0-9]+ units planned \(epochs [0-9 ]*\)$`. The B10-PULL-RETIRED mechanism is accepted for review.

## Evidence

Go tests: `cd research/historical/scanner && go test .`. test-ci: `bash research/historical/ci/test-ci.sh`. Counts are in the PR body for the exact head.

## CI and re-review rulings (15 Oct, at de129d3a): OFX-11 to OFX-13

- **OFX-11 (BLOCKER, E_SYMLINK).** The new link `research/historical/rpcscan/plan.go` was missing from `tools/policy/zeroed-files.txt`.
  - It is added between `pilot.go` and `polite.go`, with supervisor approval. The link stays, because test-ci "rpcscan links" needs it.
  - `node tools/policy/bin/check.ts` reported E_SYMLINK before the change and passes after.
  - This is a policy file, so CI asks for the deps-reviewed label, which the supervisor adds after review.
- **OFX-12.** `ag_pinned_id` counts B10-PULL rows raw. Any id with more than one row, even on one date, leaves nothing pinned. Before the fix, `sort -u` merged them and `ag_pinned_rev` took the first row's rev. The test-ci OF-7 row check refuses the same case.
- **OFX-13.** `ag_pinned_rev` matches the id exactly with awk `$1 == id` instead of inside a sed regex. Before the fix, `b10pull.a` read the rev of `b10pullXa`.
- test-ci cases same-date-dup and rev-regex fail on the old guard and pass on the new one.

