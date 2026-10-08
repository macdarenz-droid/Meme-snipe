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

## Round 1 review (head `4bfd4e01`, scope `aa09d0b0..4bfd4e01`): reviewer PASS (4 MINOR); red team 0 BLOCKER, 2 MAJOR, 6 MINOR

- Reviewer: test-ci 201/0; 197/4 with the old files; every OF-3 row test present and failing on old code; nothing can send a request. m1: k2 hashes held only in memory while K2 units are deleted. m2: the first allow-listed day has no prior list. m3: "canonical-pool transaction" keeps trade instructions only; deposits and withdrawals are not kept. m4: a hosted runner may not have 55 GB free.
- Red team: M1 a K3 day after the first reads the whole day at K2 and only then is refused at the trim (no prior list), and again on every re-dispatch. M2 a K3 day whose QA was resumable cannot finish without a second full read (restored K3 units are refused by scan-day and trim-day). m3 = reviewer m2. m4 K2 days write no list-D.txt; trim accepts any file as the prior list. m5 k2 hash lines are checked only for the sampled unit. m6 k2 lines follow the locale's glob order. m7 the K2 peak is checked once, before the read. m8 = reviewer m1, plus no trim time budget.

### Supervisor rulings for round 2 (8 Oct 2026, 4:12 PM)

8. **M1.** scan-day.sh refuses (exit 2), before the disk guard, the back-off and any scanner call, when the retention is K3, the day is not the first allow-listed day, and no verified prior list is present. Test: no scanner call on that path.
9. **M2.** "Read done" also covers a restored day where every unit is K3, units.log is present, `unitlog -check` passes and `expect_units` is met: scan-day exits 0 with no request, trim-day does nothing, check-day runs. Anything else is refused. Test.
10. **m2 / m3.** No code change. 07-22 is lead-in only (PREREG §6.4: entries count from 07-23), so its missing prior-day pools change no PM-01 count. State in the B10-PULL row that `data-day-2026-07-22-k3` lacks pools migrated on 07-21 from 19:00 UTC; the K2 release of 07-22 stays private and complete.
11. **m4.** Write `list-D.txt` for K2 days too (OF-3). The prior list must be `list-<D-1>.txt` with a sha256 verified against the stored SHA256SUMS (OF-5's row).
12. **m5.** `unitlog -check` requires exactly one k2 line per K2 file of each K3 unit, and the sha256 of every K3 file other than `raw_canonical.jsonl.zst` and `stats.json` must equal its k2 line.
13. **m6.** Sort the k2 lines with `LC_ALL=C` by path.
14. **m7.** Between units, stop the scan (exit 75) when free space falls below the largest unit so far plus the trim headroom; under ruling 7 that day then counts as failed rather than re-read.
15. **m8 / reviewer m1.** Before deleting a unit's K2 copy, append its k2 lines to `units.log.partial` and fsync; the trim resumes from `units.k3` plus that file. Give the trim its own time budget, measured on batch 1 (**VERIFY**).
16. **Reviewer m3.** Keep pool deposits and withdrawals, and any other reserve-changing pool instruction (PM-01 part 7 names `boost_buy_and_burn` and buybacks), as canonical-pool transactions in K2 and K3: PM-01 depends on depth. Fixture tests per discriminator. The scanner revision is not frozen before batch 1, so this is in time.
17. **Reviewer m4.** Batch 1 records the runner's free disk on the volume that holds `$RUNNER_TEMP` (**VERIFY**), beside the sizes.

## Round 2 (head `48ac220c`): reviewer PASS (2 MINOR); red team PASS, 0 MAJOR, 4 MINOR

- Both: rulings 7–17 applied; test-ci 217/0, 7 new cases fail on the old code; the reserve-changing set comes from the pinned IDL with a fixture per discriminator; the disk watcher cannot hit the wrong process.
- Minors: the trim step always passes "-" as the prior list, so once OF-5 wires it, a day could pass scan-day and fail at the trim (red team m1; reviewer m2: until then every day after 07-22 is refused before any read, batch 2 included); a trim stopped by its budget is chained and re-trims from scratch (m2); a torn k2 append can lose a unit's hashes before its K2 copy is deleted (m3); the read-done path copies a list without checking its sha256 against the units (m4); a disk stop exits 75 (resumable) instead of failing the day (reviewer m1).

### Supervisor rulings for round 3 (8 Oct 2026, 5:17 PM)

18. **m1.** Both trim calls take `${ARCHIVE_PRIOR_LIST:--}` (and the sums); a test-ci case where the same prior inputs pass scan-day and trim-day.
19. **Reviewer m2.** The OF-5 row states that until the prior list is wired, only 07-22 can be read; batch 2 (07-23) waits for OF-5.
20. **m2 and reviewer m1.** A disk stop and a trim out of budget are not resumable: exit 1 with the reason, the day counts as failed, the chain holds (ruling 7). Tests.
21. **m3.** Write a unit's k2 lines to a temp file, then append and sync; on resume, require the unit's k2 line count to equal its `.zst` count before deleting the K2 copy. Test with a torn line.
22. **m4.** The read-done path checks the list's sha256 against every unit's `migration_list_sha256` before copying it. Test.

## Round 3 (head `71ea6630`): reviewer PASS; red team PASS (1 MINOR)

Rulings 18, 20, 21 and 22 are closed. There is no path to a K2 or K3 day counted done with missing or duplicated units, or kept past its retention.

23. **m1 (8 Oct 2026, 7:25 PM).** `ARCHIVE_PRIOR_LIST` and `ARCHIVE_PRIOR_SUMS` are declared once at job level in data-scan.yml, empty for now, so both the scan and the trim step see the same value. A test-ci assertion checks that no step sets them on its own.

- Reviewer (7:37 PM): rulings 18–22 PASS. 227/0 on the head; 5 rows fail with the old files.
- Reviewer MAJOR, out of this diff: ruling 7 is still open on the OF-4 row and blocks arming. The `continue` job (data-scan.yml:664) passes on its own `expect_units` input, which is empty by default, not on the day's saved unit count. After a resumable stop, a missing or short progress cache therefore restarts the day from unit 0.
  - OF-4's acceptance: before dispatch, count the finished units in the saved progress and pass that count as `expect_units`; refuse to chain when the count is 0 or the save failed. Test: a chained run that restores nothing stops before any read.

## Round 4 (head `09e04446`): reviewer PASS (1 MINOR); red team PASS (0 findings)

Ruling 23 is in, and OF-2 36–42 are merged forward along with of3's own redirects. test-ci passes 233/0. No scanner or trim output reaches a public log, every step sees the same ARCHIVE_PRIOR value, and the done logic is unchanged. Next comes the OF-2 round 6 merge-forward (43–48) as a delta.

24. **Reviewer m1 (8:46 PM).** A failed day's scanner, trim and unitlog reasons (`$out-log`, `$qlog`) are lost when the runner ends. Keep them with the encrypted cache from OF-2 ruling 44, so they stay private and can be read. Until that lands, OLD-FAITHFUL §2 says the reasons are not kept. Merged forward with OF-2 round 6.

## Round 5 (of3-scanner `8db8b0bf`, on OF-2 round 7)

### Round 5 red team `session_01Uoe1pFxvHNzq9yCieDicqQ`: PASS (0 BLOCKER, 0 MAJOR, 2 MINOR)

test-ci 245/0. `$out/logs` reaches no clear-text path. m1 (`data-scan.yml:533-535`): when trim-day exits 1, the QA step is skipped, and the trim, migration and unitlog reasons are lost with the runner. m2: the redirect lint sees only plain `qlog=` assignments. It misses `for`, `read`, `:=`, `printf -v`, `ln -sf` and a later `cat` (a lint gap, not a live leak).

### Supervisor rulings for round 6 (9 Oct 2026, about 12:36 AM; sent together with the reviewer's findings)

25. **m1.** When the trim step fails, seal only `$out/logs` under its own key (`data-scan-DAY-k<kid>-RUN-ATTEMPT-logs`). Never seal half-trimmed units. Test: a forced trim failure leaves a sealed logs entry and no units entry.
26. **m2.** Merged into OF-2 ruling 57, which now also covers: any write to qlog, slog or tlog other than a plain assignment (`for`, `read`, `printf -v`, `declare`, `:=`), and `ln`, `cat`, `tee`, `head` or `tail` on `"$qlog|$slog|$tlog/..."` in the CI scripts. One test per form.

### Round 5 reviewer `session_01DK9TU4gHh9V1Accrv4yuPY`: FAIL at `8db8b0bf` (1 MAJOR, 1 MINOR)

MAJOR: the same gap as the red team's m1. "Save progress" (`data-scan.yml:444`) runs before the trim (`:472`). On a trim failure, the QA steps are skipped, and sealqa and the save after QA (`:535`, `:548`) look only at `qa.outcome`, so the trim, migration and unitlog logs are lost. MINOR: a K2 day's progress over the 10 GB cache cannot be saved, so its logs are lost too.

### Ruling 25 refined and ruling 27 (9 Oct 2026, about 12:42 AM)

- **25 (refined).** shrinkqa, sealqa and the save after QA also run when `steps.trim.outcome == 'failure'`. Only `$out/logs` is sealed in that case; half-trimmed units never are. Add a workflow-structure assertion for it, alongside the forced-failure test.
- **27. MINOR.** Whenever the full progress save is skipped or fails, seal and save `$out/logs` alone as a small separate entry (`if: always()`).

### Round 6 reviewer (head `024399cb`): PASS, final

The builder's reading of ruling 25 is right. After a trim failure, `$out` holds a half-trimmed day, so only the logs are sealed. The pre-trim "Save progress" entry stays as the intact K2 record, and progress-pick never resumes from a `-logs` key. MINOR: rulings 25–27 were not on the base or on `supervisor-docs-2`. They are in this log on `claude/supervisor-docs-3`, which goes to the base in the next supervisor docs PR.
