# OPS-CLEAN (PR #295) review log

## Round 1 (head `85a3d9b1`)

### Reviewer `session_01DtJhuG6jJN4bmPrYeyvbRn`: PASS, with 4 MINOR

The unpaired-switch fix is correct: update-unpaired fails 2 of 5 on the old code and passes 5 of 5 on the new. install.sh rebuilds identically, and the pins match.
- MIGRATION cites `CLAUDE.md` "Phone access", which only #298 lands.
- DECISIONS:68 (the OPS-GATE row) still names the removed files.
- `r2-late-crash` runs at 4.8–5.1 s against vitest's 5 s default: a CI-red risk, pre-existing.
- An active worker with worker_ready false is left on the old code.

### Red team `session_01KZYoXask6kVEnPuzzHKADs`: 1 MAJOR, 3 MINOR

- M1: a release switched to on an unpaired host is later started by the pairing script, with no hold and no probation, so a broken release stays deployed with no rollback. zeroed-update also takes no `lock`.
- m2: an active worker while worker_ready is false: the switch leaves the old process running under a new deployed record.
- m3: test cases for M1 and m2 are missing.
- m4: linuxuser is unverified (the owner confirmed it on 8 Oct: "Not root its linuxuser").

### Supervisor rulings for round 2 (8 Oct 2026, 3:09 PM)

1. **M1: every first start of a deployed release is held.**
   - When a switch happens with worker_ready false, zeroed-update writes `$STATE_DIR/switch_unheld` (commit|prev|current). The installer writes the same marker for its first release.
   - Early in zeroed-update (after probation_check, before the fetch): if the marker exists and worker_ready is true, restart, `holds()`, `due_rollback` on failure, write the probation baseline, and remove the marker.
   - zeroed-telegram-pair no longer starts the worker directly when a marker exists. It starts `zeroed-update.service` instead, so the held start happens at once rather than at the next timer.
   - zeroed-update takes the host `lock` (the same /run/zeroed-host.lock) around the check-and-switch.
   - Tests: an unpaired switch, then /pair, then a worker that dies after the hold → rollback to the previous release with failed_release set; a worker that crashes only with credentials; /pair landing mid-switch.
2. **m2.** If the worker is active and worker_ready is false, the switch is refused ("Waiting on B: the worker runs but a key or the pairing is missing"), with one alert. Add a test.
3. **m3.** Covered by 1 and 2, in update-unpaired.test.ts.
4. **m4.** Confirmed by the owner on 8 Oct ("Not root its linuxuser"); no change.
5. **Reviewer: the DECISIONS OPS-GATE row.** Add "(removed by #295, 8 Oct)" to its evidence cell.
6. **Reviewer: `r2-late-crash`.** Give it an explicit timeout sized from measurement (20 s), as the CI-1 pattern does. It is a CI-red risk that blocks deploys.
7. **Reviewer: the MIGRATION citation.** No change. #298 lands CLAUDE.md "Phone access" on the base.
