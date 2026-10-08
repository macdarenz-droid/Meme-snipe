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

## OLD-SERVER-COPY #310 (head `7028a38a`): reviewer + red team `session_0138fsn8QYHHe227K9RWwim5`

REVIEW FAIL: 1 BLOCKER, 3 MAJOR, 4 MINOR. Release `171a61ce` and the current deploy tag `27043969` were both checked.

### Supervisor rulings for round 2 (9 Oct 2026, about 12:32 AM)

2. **BLOCKER, no MagicDNS** (`--accept-dns=false`, `zeroed-tailscale:58`). Step 4 prints `tailscale ip -4` and the DNSName. Step 5 uses `curl --resolve "<name>:443:<ip>"`, so TLS is still checked against the name.
3. **MAJOR, race at boot.** Primary method: never boot the old OS with zeroed units enabled.
   - Vultr Custom ISO "SystemRescue": mount the root partition and remove `etc/systemd/system/{multi-user,timers}.target.wants/zeroed-*`.
   - From the rescue shell, VERIFY the release (`readlink /mnt/opt/zeroed/current` and that release's `ops/host-config.json` worker kind).
   - Leave `/root/OLD-SERVER-ONLY`, then detach the ISO.
   - VERIFY that the ISO library is free and the login still works (cite Vultr docs).
   - Fallback, only if the ISO is not available: `systemd.mask=` in GRUB (VERIFY that the menu can be reached).
   - Step 2 then only checks that no zeroed unit is active.
4. **MAJOR, webhook fallback.** Moot with the ISO method. The doc still names the real fallback, "on the new host: `zeroed-new-deploy-code`, then Deploy". After the copy, a step checks on the new host that Telegram is still paired to it. The finding that `webhook_fp` hashes the URL but not `secret_token` (`logic.sh:31`) becomes the follow-up card WEBHOOK-FP for the ops builder after #310.
5. **MAJOR, a release worker may run.** Covered by ruling 3's rescue-shell VERIFY before any boot.
6. **MINORs.**
   - Wrap every old-server block in an `OLD-SERVER-ONLY` guard. Step 6 also requires `/root/old-copy`.
   - Never open the live ledger read-write: use `sqlite3 -readonly`, or copy the db, -wal and -shm with `cp -p` and back up from the copy.
   - Note that one host shows as `zeroed-1`, and use the DNSName printed in step 4.
   - The dryrun and backup units are moot with the ISO method.

### #309 round 2 (head `672eb59f`): delta review PASS on mechanics; red team 1 MAJOR, 1 MINOR

The MAJOR: the folder's mtime moves with every worker start (a new boot folder) and with every prune of an empty one. A crash loop slower than StartLimitBurst (10 per 600 s) but faster than one per 70 min keeps re-arming the hold, so "never reported" stays silent indefinitely while the budget prunes unuploaded recordings. The MINOR: a future mtime gives a negative age, which counts as young.

### Supervisor rulings for round 3 (9 Oct 2026, about 12:34 AM)

7. **MAJOR.** Fix (a): `zeroed-check` writes a first-seen stamp once when the recorder folder appears, and removes it when the folder is gone. The hold is 70 minutes from that stamp, and nothing else moves it. Tests:
   - after the stamp is 71 minutes old, touching the folder or adding a boot folder still raises the alert;
   - removing the folder clears the stamp;
   - a new folder starts a new hold.
8. **MINOR.** A negative age counts as old (alert). The fixed stamp covers most of it; keep the explicit check too.

### WEBHOOK-FP closed (9 Oct 2026, about 12:40 AM)

The builder found the premise wrong. Telegram's `getWebhookInfo` reply (WebhookInfo) has no `secret_token` field; it exists only as a `setWebhook` parameter (core.telegram.org/bots/api#webhookinfo). So the fingerprint cannot see a re-set with another secret. Ruling: option C, close the card with no code. #310's rescue-disk method already stops the old server from re-setting the webhook. A new alert (option A) or a watchdog counter (option B) would be new Telegram and alert work, which waits under the owner's "Bot first" rule. The unpushed branch `claude/ops-webhook-fp` is dropped.

### #310 round 2 (head `fc106e20`): REVIEW PASS, final; red team 0 BLOCKER, 0 MAJOR, 4 MINOR

### Supervisor rulings for round 3 (9 Oct 2026, about 12:42 AM): apply all four, because the owner runs this text by hand

9. Use `grep '^Telegram:'` (L35, L123).
10. Line 46 starts with `mountpoint -q /mnt && [ -d /mnt/etc/systemd/system ] &&`. The check lists at least `zeroed-worker.service` and `zeroed-check.timer` as removed.
11. The GRUB fallback also masks `zeroed-dryrun-tick.timer`.
12. On the fallback path, after login: `touch /root/OLD-SERVER-ONLY`, then check that no zeroed unit is active.

### #310 round 3 (head `f5399438`)

The supervisor checked the delta from `fc106e20` itself: one file, rulings 9–12 applied as worded. **#310 is approved.** It merges in the docs bundle (#305).

### #309 round 3 (head `715fa2b2`): REVIEW PASS, final; red team 0 BLOCKER, 0 MAJOR, 1 MINOR

The restart-loop MAJOR is closed: only `zeroed-check` writes the stamp. MINOR: when the stamp cannot be written, `recorder_first_seen` still prints "now", so the hold lasts forever (fails open).

### Supervisor ruling for round 4 (9 Oct 2026, about 12:38 AM)

13. **Fix now, because it fails open.** Print the time only if the write and the move both succeed; otherwise print nothing, which counts as old (the alert fires): `{ printf … > "$3.new" && mv -f "$3.new" "$3"; } || return 0`. Test: an unwritable stamp path with no status gives the alert.

### #309 round 4 (head `de6632a5`): REVIEW PASS, final; red team 0/0/0

**#309 is approved.** It was marked ready at about 12:52 AM so CI (including ops-e2e) runs. It merges once it is green on a head that contains the latest base.

## OFFSITE-ON #312 (head `92d7bf0f`, stacked on #311): reviewer + red team `session_01PmY8SJe37nxiYu5WU7HpHs`

REVIEW PASS, final. Red team 0 BLOCKER, 0 MAJOR, 2 MINOR. The send is refused until the switch is on, a valid owner recipient exists and Telegram is paired. The copy is encrypted only to the owner, with one document and no other data. The 50 MB cap fails loud. Times are right in both AEST and AEDT. Tests fail before and pass after.

### Supervisor rulings (9 Oct 2026, about 1:28 AM)

14. **MINOR 1, README step 3.** Write: "The first copy arrives at the next 17:20 UTC (04:20 Melbourne in daylight time, 03:20 otherwise), up to 5 minutes later."
15. **MINOR 2, no alert when the owner step is never done.** No new alert now ("Bot first", and the owner's pause). Instead, the supervisor tracks the owner's `zeroed-backup-code` step in HANDOVER owner waits, and checks the `zeroed-status` backup line after the deploy.

### #312 round 2 (head `deeb0e66`)

The supervisor checked the delta itself: one README line, ruling 14 applied as worded. **#312 is approved.** It merges after #311, with #311's rebuild and re-pin carried forward.
