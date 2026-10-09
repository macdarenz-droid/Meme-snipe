# OF-6 no second archive read: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-6 bullet. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`, branch `claude/of6-no-reread`, stacked on OF-5 (`claude/of5-completion`).

## Supervisor rulings on the builder's design calls (9 Oct about 9:50 AM)

1. **Q1, where D+1's shared margin units come from.** Accepted: D's release carries `margin-D.tar` (D's units that reach past D's midnight), listed in SHA256SUMS and read back. Before D+1's scan, a clean store step downloads it (no archive request) and places those units so the scanner skips them.
2. **Q2, the taken units enter D+1 untouched.** Accepted, with one required property: **every coin in D+1's PM-01 list has complete events in the units D+1 takes from D's store.** D's copy is trimmed with D's list, so a coin that migrates during D (inside the forward margin) could be trimmed out of units that D+1 then reuses. The builder picks the mechanism (for example, trim D's forward-margin units with D's list plus the migrations D's own scan found) and proves the property with a test: a coin that migrates in D's forward margin keeps all its events in D+1. The per-unit log line names the source ("from data-day-D").
3. **Q3, re-read after a QA failure.** Accepted: a pinned DECISIONS row `QA-REREAD id=<id> day=D units=… toldAt=<UTC>`, written only after the owner is told; `scan-day` with `ARCHIVE_REREAD_ID` reads exactly those units through a new scanner flag `-units FILE` at the day's recorded retention; the guard refuses a whole-day read of a day with a counted failure since `ARCHIVE_REARM_AT` and no matching row. The new flag changes the scanner revision, which is allowed now because no batch has run (OF-3 freezes the revision from batch 1).
4. **Rescan unit.** Accepted: a check refuses a rescan range longer than one unit, with a test.
5. **From the OF-5 red team (9 Oct about 11:40 AM), required.** The `-k3` release producer (trim and QA, OF-6) writes and reads back the `readback-ok-D` marker exactly as publish-day does, so its first `-k3` release counts as done. Test: every release create of a `data-day-*` tag sits in a script that writes and reads back the marker.

## Round 1 (PR #317, head `dd7dc504`, diffed against #316 `dd60bd46`)

- Builder: test-ci 282/0; go vet/test clean; label `deps-reviewed:78e14f7f6f55669121708725b85d8605`. TestMarginMigrationKeptForNextDay passes on the old code too (the builder says the property already held).
- Red team: FAIL, 0 BLOCKER, 2 MAJOR, 2 MINOR. MAJOR 1: the first K3 day after the K2 days takes K2 margin units untouched, so finalize refuses mixed retention (a counted QA failure that a re-read cannot fix), or K2 bytes would be stored past batch 2. MAJOR 2: b10-done never counts a day with taken units, because their log lines carry D-1's list sha. m1: margin-fetch accepts symlink or hardlink members. m2: margin coverage relies on about 1 h of slack between two time estimates. Held: margin-fetch fails closed; no whole-day re-read without a row; `-units` reads only listed units at the recorded retention; one-unit rescan; the `-k3` marker path; no tracked binary; ruling 2's property holds for K3 → K3.
- Rulings for round 2 follow after the reviewer's verdict.
- Reviewer (round 1): FAIL, 0 BLOCKER, 1 MAJOR (the same K2 → K3 boundary as red team MAJOR 1). Rulings 1, 3, 4, 5 and the .gitignore guard are met; test-ci 282/0; label matches. The builder's claim holds for a structural reason: D's list is built from all of D's units including the forward margin, so a coin migrating inside the margin is on D's list and its records survive D's trim; the test pins it.

### Supervisor rulings for round 2 (9 Oct about 12:35 PM)

6. **MAJOR (reviewer and red team MAJOR 1), required: option (a).** For a K3 day, margin-fetch takes the day before's margin only from a release at the same retention: `data-day-<D-1>-k3` when D-1 was read at K2; otherwise it refuses before any archive read and the chain holds. Every taken unit's recorded retention must equal D's. This keeps the two copies of a shared unit equal, so assemble's midnight merge still holds; trimming taken K2 units with D's list (option b) would make D's copy differ from D-1's `-k3` copy. The `-k3` trim of 07-22 and 07-23 comes before batch 3 (OF-3), so 07-24 waits for `data-day-2026-07-23-k3`. Tests: 07-23 K2 → 07-24 K3 with the `-k3` release present finalizes, every unit K3, and the shared units merge equal with 07-23's `-k3` copy; without the `-k3` release, 07-24 is refused before any archive read.
7. **Red team MAJOR 2, required.** `ag_b10_ok` accepts a taken unit whose log line is marked "from data-day-<D-1>…" and whose list sha equals the list sha in D-1's done release SUMS; every other unit needs D's own list sha. Test: a two-day K3 chain counts both days as B-10 done.
8. **Red team m1, required.** margin-fetch refuses any tar member that is not a regular file or a directory, and extracts with `--no-same-owner --no-overwrite-dir`. Test with a symlink member.
9. **Red team m2, required.** `scan-day` refuses when a planned unit overlaps D-1's stored units but is not in `from-store.txt`, so a drift between the two time estimates can never cause a second archive read. Test it.
- OF-7 #318 (B10-PULL row, `0de275aa`) pins the scanner tree at OF-6; it re-pins after OF-6 round 2, as its own test requires.

## Round 2 (head `396e28f4`, base `d01875dc` merged)

- Red team: PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR. Round 1 MAJORs 1–2 and m1–m2 closed (no tag order or fallback brings K2 units into a K3 day; b10-done refuses forged "from" lines; tar `h`/`l` members refused; `-stored`/`-taken` refuse an overlapping untaken unit). MINOR: every first-day exemption keys on the head of `ARCHIVE_DAYS`, so a later edit of that list would skip the prior-list, margin and `-stored` checks for a day whose D-1 is stored. The reviewer's round 2 verdict is pending.
- Reviewer (round 2): PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR. Rulings 6–9 met; fail-before shown (and the new Go test does not build on `dd7dc504`). The evidence does not yet prove ruling 6's "finalizes": finalize and `checkUnitLog` never run on a day that mixes taken units with D's own.

### Supervisor rulings for round 3 (9 Oct about 1:47 PM)

10. **Reviewer MINOR, required (ruling 6 asks for it).** A Go test: trim a D-1 K2 unit with D-1's list (the `-k3` copy), take it into D next to one of D's own units trimmed with D's list, build D's `units-D.log` as trim-day does, then run `checkUnitLog` and finalize, expecting success, with the shared unit byte-equal to the `-k3` copy.
11. **Red team MINOR, required.** A day is exempt from the prior-list, margin and `-stored` checks only when the store holds no `data-day-<D-1>[-k3]` release, not because it heads `ARCHIVE_DAYS`. Test: with D-1 stored, the head of an edited `ARCHIVE_DAYS` still runs the full checks.
- OF-7 re-pins on the round 3 scanner tree.
