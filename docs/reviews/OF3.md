# OF-3 review log (PR #299)

Card OF-3, `research/z-h-estimate/OLD-FAITHFUL.md` §5. Builder: the data builder `session_01SP5ftusK23iJPxYXEMY9y7`, branch `claude/of3-scanner`, stacked on `claude/archive-safe-b` (#214 + OF-2).

## Ready report (head `553ac25d`, 8 Oct 2026, 3:19 PM)

- test-ci 191/0; scanner and rpcscan go vet and go test ok; lint ok. Fail-before: 6 test-ci cases fail on `85bf868e`; `retention_test.go` does not compile on the old code.
- Design choices: (1) K2/K3 extra raw goes to a new `raw_canonical.jsonl.zst`; `raw.jsonl.zst` stays exactly K1, so the trim is a line filter; finalize does not read the new file yet. (2) P12 = a transaction that writes a config account. (3) List format `MINT FROM_UNIX UNTIL_UNIX`, horizon 240 min. (4) No new rpcscan symlinks. (5) K3 in CI refused until the list is wired (OF-5/OF-6).
- Open question: day D's own migrations cannot be in a list pinned before D is read, so a K3 scan of D misses trades after a same-day migration. Options (a) read every day at K2 and trim to K3 before storing, (b) D's own migrations wait for D+1, (c) two passes.

### Supervisor rulings (8 Oct 2026, 3:24 PM)

1. **Order.** `claude/of2-holds` is still `e1412b7c`: the OF-2 round 2 rulings (`docs/reviews/OF2.md`, 3:04 PM) are not applied. Do them first, then merge OF-2 into `claude/archive-safe-b` and that into `claude/of3-scanner` (merge commits only), then apply the rulings below. OF-3's reviewer and red team start on that head, not on `553ac25d`, so no review is spent on code about to change.
2. **Open question: (a).** Every day is read at K2 and trimmed to K3 before it is stored. After batches 1 and 2, no K2 bytes are stored. Before a unit's K2 raw is deleted, its file hashes go in the per-unit log (the determinism evidence of §3).
   - (b) is refused: PM-01 enters 20–120 min after a migration, so dropping same-day migrations drops most of each day's universe.
   - (c) is refused: a second full read doubles the load on the archive, against the owner's rule to read in small, gentle batches.
3. **Disk.** K2 raw is about 17–45 GB a day (October activity, ±2×; **VERIFY** on batch 1). The guard today checks 24 GB. Before any archive read, the guard must check the K2 peak, and refuse with no request if it does not fit.
   - To bound the peak, trim each unit as soon as it is read, with the list of earlier days plus D's migrations up to and including that unit, then delete its K2 raw. This equals a trim with D's full list only if units are read in slot order (a pool has no trades before its migration). Use it only with a test that trims with the prefix list and with the full day list and gets the same bytes; otherwise trim after the whole day and size the guard for the full K2 day.
   - If batch 1 shows a K2 day cannot fit the runner either way, the chain stops before batch 3 and the supervisor decides (the retention step already sits there).
4. **Horizon: 300 min, not 240.** PM-01's PREREG §3 (PM01-P5, `c0bdb04a` L45) keeps each listed pool from the migration slot to migration + 300 min (last entry at +120, time stop 120, plus 60 for the exit ladder). The list's lead-in must therefore include earlier migrations whose window reaches into D. The list builder takes the value from that section, with a citation; the scanner stays horizon-free (the list carries FROM and UNTIL).
5. **OLD-FAITHFUL.md.** Change §2 and the OF-3 row: D's list is built from the days before D plus D's own migrations read from D's K2 units; D+1 is dispatched only after D is stored (read done).
6. **Choices 1, 2, 4 and 5 accepted.** The B-10 loader must read `raw_canonical.jsonl.zst` and the config records: add that to card Z-H's acceptance in the doc, so it is not lost. P12's size stays **VERIFY** on batch 1.

## Rulings 2–6 applied (head `4bfd4e01`, 8 Oct 2026, 4:03 PM report)

- test-ci 201/0; 4 cases fail with the changed files set back to `aff19758`; `retention_test.go` does not compile on the old code. Label `deps-reviewed:4605e91c6cc7b5c92f425024b48e78df` (data-scan.yml changed).
- Units are read newest first, so the per-unit prefix trim is not valid: the trim runs after the whole day, and `ARCHIVE_K2_PEAK_BYTES` is 55,000,000,000 (45 GB K2 high estimate + one trimmed unit + 5 GB; **VERIFY** on batch 1).
- Fails closed until OF-5: the prior day's pinned list must come from the store, so every K3 day after the first stops before QA.
- Open: a K2 day's progress (up to about 45 GB) cannot fit the 10 GB Actions cache, so a chained restart would lose it.

### Supervisor ruling (8 Oct 2026, 4:04 PM)

7. **K2 progress (OF-4 requirement).** A day whose saved progress cannot hold its units never restarts from zero: the continue job refuses the chained restart when the progress entry is missing or short of the day's finished units (the `expect_units` check already exists), the day counts as failed, and the chain holds for a decision. OF-4 decides whether K2 progress goes to private zeroed-data. Add this to the OF-4 row. Reviewer and red team for OF-3 start now on `4bfd4e01`, scoped to the OF-3 commits (`aa09d0b0..4bfd4e01`); OF-2 round 3 merges forward afterwards as a delta.
