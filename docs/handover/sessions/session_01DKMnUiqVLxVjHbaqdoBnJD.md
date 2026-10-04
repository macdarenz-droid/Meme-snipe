# Handover: session_01DKMnUiqVLxVjHbaqdoBnJD (reviewer, historical data and Helius RPC)

## Role, cards, model
- Fresh-context reviewer under AGENTS.md. Tasks came only from the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). Verdicts went to the supervisor by send_message, never to GitHub: no approvals, comments, pushes or merges.
- Cards reviewed: DATA-1 (#35, #46), DATA-1b (#69), DATA-1c (#77), BT-3 (#89), DATA-2 and ARCHIVE-CHECK (#111), BT-2e practice days (#119), DATA-4 (#127).
- Model: configured `claude-opus-5-5`. The model that served each turn can differ. The effort level is not recorded here, because I have no record of it.

## PRs and branches
I own no branch and no PR. Before this note, I pushed nothing.

Last verdict per PR (all heads on `claude/data-historical` unless noted):

| PR | Card | Verdict history | Last verdict |
|---|---|---|---|
| #35 | DATA-1 | FAIL (Go version, partial release, 2026-10-02); FAIL (R1 size comparison) | PASS at f58ca8b |
| #46 | DATA-1 movements | FAIL on disk; FAIL on M1 (lookup-table pump txs); FAIL on empty-owner net; FAIL on swap-leg owner; PASS at e9f2591 | delta PASS at 8805675 |
| #69 | DATA-1b delegations | PASS at bc829fa | delta PASS at da3d7c2 (10-01: 39 rows, Go/TS match) |
| #77 | DATA-1c volume | FAIL at b0f5826 (stats_match); FAIL at 502a7d0 (pending a measurement); PASS at 2445114 | delta PASS at 273f62b |
| #89 | BT-3 evidence | FAIL at 982ee3d (pass terms unpinned) | PASS at 3cdf71e (code 0d1e535, replay hash 733ef72c3e12b3f3) |
| #111 | DATA-2 + ARCHIVE-CHECK | FAIL at 1697ddd (exemption unpinned); PASS at 8389984 | PASS at 956bb7f |
| #119 | BT-2e practice days | FAIL at 6b1c492 (unbooked credits); FAIL at e8148c5 (same) | PASS at 083af50; merged as 3f14e0f |
| #127 | DATA-4 ledger | — | **FAIL at e5552a4** (open, see below) |

## What is done
- Every review above is finished and reported, except #127, which is reported as FAIL and is waiting for the builder's fix.
- Method, on each head:
  - `go vet` and `go test` in `research/historical/scanner` and `research/historical/rpcscan`;
  - `bash research/historical/ci/test-ci.sh`;
  - hand-made mutants (perl edits, each restored with a backup copy and `git status` checked clean);
  - real-data checks where useful.

## Work in progress: #127 DATA-4 (head e5552a4)
The review is complete; the verdict is FAIL with two blocking items. It was sent to the supervisor on 2026-10-04 at about 08:10 UTC. I have not reviewed a newer head.

Evidence:
- go vet and go test pass, and test-ci passes 121/0.
- The scanner tree is 64e1335c and the rpcscan tree is 1f1d2e72.
- The head does not contain base 5087bd4, but merges it cleanly.
- 12 of my 13 mutants are killed.

Blocking items:
- **B1.** `research/historical/ci/rpc-ledger.sh`, `push()` uses `gh release upload --clobber`.
  - gh 2.89 deletes the old asset first, then uploads (cli/cli `pkg/cmd/release/shared/upload.go`, `uploadWithDelete`; I read the source).
  - If the upload fails after the delete, ledger.json is lost. The only recovery is `init`, with typed-in numbers and an empty `outstanding`, so open reservations are never booked: under-booking.
  - Fix:
    - under the lock, upload `ledger.next.json` without clobber first, then clobber ledger.json, then delete next;
    - `fetch` falls back to next;
    - `init` refuses while either one exists;
    - print the ledger to the step summary on a failed write.
  - Test it with a fake gh that fails the upload after the delete.
- **B2.** The mutant that ignores a failed push (`|| true`) survives test-ci (121/0).
  - With it, reserve exits 0 and the job spends unbooked credits.
  - It needs a test where the fake gh's `upload --clobber` fails: reserve and settle must exit non-zero.

Non-blocking items for #127:
- `unlock` deletes the lock whoever owns it. It could refuse a lock younger than LOCK_WAIT. Also check that data-scan and the pilot share the `data-helius` concurrency group with helius-ledger.yml.
- Unverified: GitHub's asset listing could lag right after a clobber. A stale listing should fail closed, because asset ids change with every upload. I could not test this against a real release.
- The rpcscan tree change gives RPC units a new revision, so every unpublished helius day is reread for nothing (the unit bytes are unchanged). The docs don't say this. Merge only after 09-21 is published, and document it.

## Open findings on other PRs (all non-blocking, as reported)
- #111 (merged code), digest.go:
  - The table-level exemption conditions are redundant with the per-record check: single-condition mutants survive, but pairs are killed.
  - The `head -c 65` layer in archive-check.sh has no test of its own, because `--max-filesize` aborts first.
- #119:
  - The rps bound (1..50) is not tested by value; changing 50 to 500 still passes. It may have landed later, but I didn't check.
  - b) rc 3 at the time budget gives 75 (safe).
  - c) check-day rc 3 falls through to exit 1 (safe).
- #89, #77, #69, #46, #35: nothing open from my side.

## Next steps (for a new reviewer)
1. Fetch #127's newest head.
2. Check that it merges the latest `ccr-14987baf-i6lrsl`.
3. Rerun test-ci, plus these mutants on `research/historical/ci/rpc-ledger.sh`. Each must be killed:
   - push `|| true`;
   - delete-then-failed-upload;
   - lock uploaded with `--clobber`;
   - `actual = max(actual,0)` ignoring notes;
   - `out_all = 0`;
   - `out_day = 0`;
   - the worker term dropped from `left_period`;
   - no lock in reserve or in settle;
   - the `final` check removed.
4. Check that B1's fallback keeps every reservation, and that init refuses while next exists.
5. Check that the docs record the reread caused by the RPC revision, and that the merge waits for 09-21 to be published.
6. Report PASS or FAIL with the SHA to the supervisor.

## Findings and numbers (with where they came from)
- **#111 Agave log cut:**
  - drop a message when bytes_written + len ≥ 10,000;
  - write "Log truncated" once, at the first drop;
  - keep later messages that fit.
  - This matches Agave's LogCollector, and the builder reproduced all 118 raw records of the comparison unit (fixtures in `research/historical/rpcscan/testdata/rpc/`).
- **#111 baseline regeneration:** only the raw records' `l` (17,614) and `c` (158) hashes changed (I decompressed both baselines and diffed them field by field). That proves the length-prefix change was the only change.
- **#111 archive-check:** curl 8.5 aborts a chunked 200 with no length at 64 bytes (exit 63) under `--max-filesize 64`, as test-ci's real-server case shows.
- **gh `--clobber`** is delete-then-upload in gh 2.89.0 (the runner's version here; source fetched from cli/cli trunk).

## Rulings received
- #111:
  - pin every exemption condition;
  - make the exemption per record;
  - keep the archive scanner revision at 64e1335c;
  - the holdout fixtures are for integrity checks only.
- #119: 09-21 credit cap of 270k; rpc_rps default 5.
- #127: don't merge while the 09-21 chain runs; then init the ledger.

## Open risks
- #127 must not merge before B1 and B2 are fixed and reviewed. Until then, the cap relies on the #119 per-day counter in the cache.
- The ledger trusts a static worker share. If the live worker overspends, history can still push the account over the month's credits. The worker's own 70% halt is the backstop.

## How to verify
```
cd research/historical/scanner && go vet ./... && go test ./...
cd research/historical/rpcscan && go vet ./... && go test ./...
bash research/historical/ci/test-ci.sh   # expect "N passed, 0 failed"
git rev-parse HEAD:research/historical/scanner   # 64e1335c07ed3bc7e2e7408c16242cd5668dc3bb
```

## Remaining time
- A re-review of #127 after the fix takes about 30–45 min, including the mutants. test-ci takes about 25–40 s a run, so 13 mutants take about 8 min.
- It could take longer if the fix changes the lock or the workflows widely.
