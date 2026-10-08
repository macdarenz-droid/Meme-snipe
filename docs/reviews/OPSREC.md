# Ops cards REC-UPLOAD-QUIET (#309) and OLD-SERVER-COPY: reviews and rulings

Builder `session_01SUwY9FRqJYhmgEp25p27nV`.

## REC-UPLOAD-QUIET: #309 (head `53827d83`)

`record_alerts` takes the recorder path. If it is missing (the same test as the unit's `ConditionPathExists`), the status reads as disabled and all four alerts clear. host-logic 78/78 pass. Fail-before: 3 tests fail on the base files. No guarded files. Ops e2e could not run here (container TLS proxy); CI's ops-e2e decides. Reviewer and red team: see below.

## OLD-SERVER-COPY: builder stopped with 3 MAJOR findings on the premise

The old server holds no DATA_STORE_TOKEN; the watchdog's `/record` allow-list refuses the ledger and the whole journal; `zeroed-backup-offsite` goes to Telegram (a third party; switched off; needs the owner). Which release the old server last ran is VERIFY.

### Supervisor ruling (9 Oct 2026, about 12:35 AM)

1. **Route: copy over the owner's own tailnet to the 2 GB host (option F).** It adds no new provider and no spend, and the data goes to no third party. Rejected: Telegram (option A: a third party and a 50 MB cap), a new watchdog route (option B: new code and a possibly rotated key), and a Vultr snapshot (option C: new spend). The copy lands in a root-only archive folder on the new host (for example `/var/lib/zeroed-archive/old-server/`, mode 0700, outside the worker's paths). It is never read by the bot ("Its state is never reused"). The sha256 of each file is checked on both ends.
2. **Before writing the steps, VERIFY from primary sources:**
   - which release the old server last ran (deploy workflow runs and tags);
   - which services start at boot and whether any of them calls a provider or sends alerts; the steps stop them first, or show the boot is the stand-in only;
   - the exact paths of the ledger, saved state and journal for that release;
   - the tailnet copy method (`tailscale file cp` or scp over the tailnet), checked against the Tailscale docs, with what each machine needs.
3. **Deliverable.** A short owner runbook (`ops/OLD-SERVER-COPY.md`) in a draft PR, reviewed and red-teamed before it goes to the owner. The owner deletes the old server only after the copy is verified on the new host. The new host's off-server backup stays an open owner wait.

### #309 reviewer + red team `session_01PmY8SJe37nxiYu5WU7HpHs` (head `53827d83`): REVIEW PASS; red team 0 BLOCKER, 0 MAJOR, 1 MINOR

`install.sh` rebuilds byte-identical; the tests fail before the fix and pass after. A broken upload while the recorder exists still alerts; the alerts clear only while the path is missing.

### Supervisor ruling for round 2 (9 Oct 2026, about 12:23 AM)

1. **MINOR, first-hour false alarm (`logic.sh:250`).** Fix it in this PR, because it is the same false-alarm class and fires the day the M1 recorder starts. Hold only "never reported" until the recorder folder is older than about 70 minutes (`stat -c %Y`; the timer is OnUnitInactiveSec=1h). The other three alerts are unchanged. Test: folder 10 minutes old, no status: no alert; folder 71 minutes old, no status: alert. Merge the base `e6cc8278` first (merge commit).
