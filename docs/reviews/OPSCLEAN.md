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

## Round 2 (head `a19ba37e`): reviewer PASS (3 MINOR); red team 0 BLOCKER, 0 MAJOR, 4 MINOR

- Red team m1: a crash between writing `deployed` (zeroed-update:327) and the marker (:352) loses the marker, so the next start is unheld and A is lost as the rollback target.
- Reviewer and red team m2: `lock` (`flock -w 60`) timing out after `apply_host` exits 1 with no log, leaving the new host files under the old release until the next run.
- Red team m3: `/pair` while a zeroed-update run is active delays the held first start by up to 5 min.
- Reviewer and red team m4: with the lock released during the hold, a re-pair or zeroed-check's `try-restart` can restart the worker mid-hold and roll back a good release (pre-existing race).
- Reviewer: the lock is stubbed in tests (accepted for this card).

### Supervisor rulings for round 3 (8 Oct 2026, 3:34 PM)

8. **m1.** When `worker_ready` is false, write `switch_unheld` before the `ln`/`mv` switch (under the lock), so no crash point leaves a switched release without its marker. Test: a kill between the switch and the old marker point leaves the marker in place.
9. **m2.** On a lock timeout: log "Waiting on <commit>: the host lock is busy.", re-apply the running release's host files (best effort), and exit 0. Test: a held lock → that log line, exit 0, host files of the running release.
10. **m3.** At the end of zeroed-update, if the marker exists and `worker_ready` is true, run the marker block once more (under the lock). Test: `/pair` during an active run → the held start happens in the same run.
11. **m4.** While `held_restart` runs, write `$STATE_DIR/holding`; the re-pair and zeroed-check `try-restart` paths set `worker_restart_pending` instead while it exists; `held_restart` and `due_rollback` remove it. Test: a re-pair during the hold does not restart the worker and the hold passes; the pending restart runs after.
12. Note (a) stays as is: with no pairing the worker-unready alert can only be logged; `zeroed-status` shows it.
