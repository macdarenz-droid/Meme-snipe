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

## Round 3 (head `52555101`): reviewer PASS (3 MINOR); red team 0 BLOCKER, 0 MAJOR, 3 MINOR

- Both confirm rulings 8–11 and the builder's marker-rewrite extra; base merge `52555101` is docs only (tree equals `git merge-tree`).
- Red team m1 (borderline MAJOR): a crash between `mv -Tf current` (zeroed-update:364) and the `deployed` write (:365) splits current from deployed; unheld_start then drops the marker and the next switch takes the never-run release as its rollback target.
- Red team m2 and reviewer m2: zeroed-pair's key-rotation restart ignores the hold, so a handoff inside the ~90 s hold can fail a good release, or (unheld path) leave the new keys unloaded.
- Red team m3: on a busy lock, apply_host silently does nothing when the running release's installer predates `--update`.
- Reviewer m1: `holding` is written after `flock -u 9`, leaving a short gap. m3: the "Waiting on the first held start" line is logged twice per run.

### Supervisor rulings for round 4 (8 Oct 2026, 3:56 PM)

13. **Red team m1.** (a) At the start of unheld_start and of the switch: if `basename "$(readlink -f current)"` differs from `deployed`, put `current` back to the deployed release first, with one log line. (b) Take `prev` from `deployed`, never from `readlink current`. (c) Write the marker before `ln`/`mv` in the ready case too, and let held_restart remove it, so a reboot between the switch and the hold is covered. Test: kill between `mv` and the `deployed` write, run again → `current` equals `deployed`, and the rollback target is A.
14. **Red team m2 and reviewer m2.** In zeroed-pair, if `$STATE_DIR/holding` exists, write `worker_restart_pending` instead of restarting or starting; pending_restart restarts after the hold. Test: rotation during a hold → no restart, the pending file, then one restart after `holding` clears, with the new keys loaded.
15. **Red team m3.** Log a line when apply_host skips because the running release's installer has no `--update`; note it as accepted in DECISIONS.
16. **Reviewer m1.** Write `holding` before `flock -u 9`.
17. **Reviewer m3.** Skip the at-exit "Waiting on" line when the start-of-run check already logged it.

## Round 4 (head `15e7c48c`): reviewer PASS (2 MINOR); red team 0 BLOCKER, 0 MAJOR, 1 MINOR (borderline) and 1 pre-existing note

- Both accept the builder's deviation: realign_current acts only on a 40-hex release folder, so a hand-placed practice copy stays current and stays the rollback target; every kill point of the forward switch now ends on a release that ran or a held start.
- Red team m1 (a regression from realign_current): a run killed inside rollback() between the `current` move and the `deployed` write now ends on the failed release with no rollback (realign moves `current` back to C; the probation file is already gone).
- Red team note (pre-existing): with a due rollback held and the failed release's worker dead, a newer deploy can switch with the failed release as `prev`.
- Reviewer m1: after a power loss between `mv` and the `deployed` write, the worker boots on C unheld and keeps running C until a later run switches under the hold. m2: whether a manual try-restart raises NRestarts (probation) is unverified.

### Supervisor rulings for round 5 (8 Oct 2026, 4:31 PM)

18. **Red team m1.** rollback() writes `deployed` (the target) before the `ln`/`mv`, and a rollback is resumable: `$STATE_DIR/rollback_due` (commit|prev|current|why) stays until the restart is done, and the next run's probation_check finishes it (apply_host of the target, restart, alert). Test: kill between the `mv` and the `deployed` write in rollback(), run again → `current` = `deployed` = A, and A's worker restarted.
19. **Red team note.** The forward switch waits while `$STATE_DIR/probation` holds a due rollback, with the alert it already has. Test.
20. **Reviewer m1.** When realign_current moves `current` while the worker is active, bring the running process to the deployed release under the hold rules: held_restart when no intent or dry run is open; otherwise keep a marker that unheld_start honours. Test: reboot-start on C after a killed switch → the next run holds a restart on the deployed release.
21. **Reviewer m2.** If the ops e2e runs real systemd, assert that a manual try-restart does not raise NRestarts (or that probation tolerates it); otherwise record it as **VERIFY** on the host in the README's checks.

This is meant to be the last round on the host logic: after it, the reviewer and red team check closure only, then the label goes on and the labelled run with e2e decides the merge.

## Round 5 (head `66ff6e42`): reviewer PASS (1 MINOR); red team 0 MAJOR (1 borderline MINOR, 1 note)

- Both: rulings 18–21 applied; every kill point in a rollback now ends on the target; the e2e asserts NRestarts unchanged after a planned restart.
- Red team m1: realign_current's marker can overwrite an existing marker (C|A|A becomes C|releases/C|C after a killed switch to D and a reboot), losing A as the rollback target.
- Red team note: a due rollback held by stale `open_intents` or `open_positions` files of a dead worker now also blocks every newer deploy until the owner clears it.
- Reviewer m1: realign marks a held restart even when the worker still runs the deployed release (one extra held restart, harmless).

### Supervisor rulings for round 6 (8 Oct 2026, 4:52 PM)

22. **Red team m1.** realign_current writes its own marker only when no marker exists; otherwise unheld_start's rewrite branch handles it. Test: C|A|A, a killed switch to D, a reboot → the marker becomes C|A|A again and a failed hold of C rolls back to A.
23. **Red team note.** Accepted and recorded in DECISIONS: the held alert names the stale file, and says the owner checks positions before clearing it. A dead worker manages nothing either way, and paper is treated as real money, so an agent never clears it.
24. **Reviewer m1.** No change (harmless).

After this push, a closure check by both; then the label and the labelled run with e2e decide the merge.
