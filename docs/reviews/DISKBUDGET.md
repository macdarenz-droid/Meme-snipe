# DISK-BUDGET (#307): reviews and rulings

## Round 1 (head `c7b9122f`, base `1e4df569`): reviewer + red team `session_012Hzd9JU63NkCCbX8kQvW8j`

Review FAIL. Red team 0 BLOCKER, 4 MAJOR, 6 MINOR. Public-repo scan clean. Numbers recomputed and reproduced.

R2 confirmed on the current unit: `zeroed-worker.service:32` StateDirectory=zeroed, `:44` ProtectSystem=strict, no ReadWritePaths; `m24/config.ts:9` `/var/lib/bot/bot.db`, `m27/config.ts:19` `/var/lib/bot/log`, SPEC-A:1305,1311 `/data/md`; `zeroed-backup:9` SRC=/var/lib/zeroed. The engine would not be able to write its ledger, and the backup would miss it.

### Supervisor rulings for round 2 (9 Oct 2026, about 12:05 AM)

1. **MAJOR 1, R6.** Drop the shallow fetch. Only a step that keeps `zeroed-update:325` (`merge-base --is-ancestor`) fully working may stay (for example a plain `git gc`); never loosen that check.
2. **MAJOR 2, R4.** Keep the Blueprint's signed PullReceipt (ARCH:1078, SPEC-A:1340): nothing is deleted without a verified receipt, and a sha256 read-back is not a receipt. R4 keeps its byte cap and floor; at the cap with no receipts, the host alerts and the recorder pauses (fail closed). Any receiptless deletion is an open point for an owner or spec decision, never a default.
3. **MAJOR 3, R1.** A copy-count floor (at least 24 hourly and 7 daily) that the byte budget never cuts. At overflow, alert and shed the other growers, never backups.
4. **MAJOR 4, R2.** List every Blueprint write path (`bot.db`, the m27 log dir, `/data/md`, `/data/backups`, `recovery-*.ndjson`, `/var/lib/bot-init`), all under the unit's writable state. Name one backup owner (M24's online backup or `zeroed-backup`) with the reason, and budget it once.
5. **MINORs.** Apply all six as the red team wrote them: the 24.8 GB total; the 1.87 GB basis (or say "raw 1.56 basis"); align the fixed items; fill dates as days from start only; R3 "rollups can be rebuilt" UNVERIFIED or dropped; R7 warn sampling marked as a spec change needing a DECISIONS entry, and 56–58%.
6. **Card PATHS-FIX (from R2), supervisor ruling.** A bug fix on merged Z02 work, not a new feature: move the Blueprint's default write paths under the worker's writable state, change SPEC-A's `/data/md` and SPEC-B's paths in the same PR with the reason, and add a test that every configured write path sits inside the unit's StateDirectory or ReadWritePaths (the test fails on today's defaults). It starts when a builder slot frees, after #307's round 2 settles the path list, and before any M1 recorder deploy.

## Round 2 (head `ecb09dd0`): delta review + red team, same session

Review PASS with notes; rulings 1–6 applied. Red team 0 BLOCKER, 1 MAJOR, 3 MINOR. Numbers reproduce. Nothing loosens a guard.

### Supervisor rulings for round 3 (9 Oct 2026, about 12:12 AM)

7. **MAJOR, last fail-closed step.** Name it: at the critical floor the M24 disk guard (SPEC-B:2027, 2035: 500 MB reserve, `disk_crit_pct`) blocks new entries and raises a critical alert; nothing protected is deleted. Moving the 7 daily copies off the host is the recommended default until R10 measures `bot.db`, but it waits on the owner's open "off-server backup" answer (HANDOVER owner waits); say so.
8. **MINOR 1.** Add M24's pre-migration backup (`m24/migrate.ts:86,135-137`; SPEC-B:1992) as a row, kept out of the backup glob, budgeted at 1× ledger; the writer lock `<db>-writer.lock` (`m24/db.ts:225`) moves with the db.
9. **MINOR 2.** The import spool (group `botops` write, SPEC-B:2539) and md-pull's read of `/md` get their own directories and modes (an extra StateDirectory or ReadWritePaths entry); PATHS-FIX builds them.
10. **MINOR 3.** R3's split: add the cross-file atomicity point (SQLite WAL with ATTACH; cite the SQLite docs, or mark UNVERIFIED) to the R3 spec ruling, and label the market.db and metrics.db budget rows "if R3 is ruled".

## Round 3 (head `10ea904a`): delta review + red team, same session

Review PASS (rulings 7–10 applied; the SQLite ATTACH quote matches). Red team 0 BLOCKER, 2 MAJOR, 2 MINOR.

### Supervisor rulings for round 4 (9 Oct 2026, about 12:20 AM)

11. **MAJOR 1, one mode per unit.** Do not rely on per-entry StateDirectory modes (systemd.exec: one StateDirectoryMode per unit, folders owned by the unit's user; the builder checks it on the host's systemd version and records it). The installer creates the spool and md folders with explicit owner, group and mode, and the unit lists them in ReadWritePaths.
12. **MAJOR 2, md readable by the pull group.** The md folder is 2750, setgid to the pull group. The recorder sets explicit modes (0750 folders, 0640 files); the unit's UMask=0077 stays.
13. **MINOR 1, spool.** 2730, and name how the worker gets read access (the mode the operator copies with, a group, or an ACL).
14. **MINOR 2, receipts.** State the sftp umask (`sftp-server -u`) or the worker's group membership, so receipts are readable. An unreadable receipt still fails closed.

## Round 4 (head `2f42c086`): delta review + red team, same session

Rulings 11, 12, 14 applied correctly; 13 applied but its route breaks the process split. Red team 0 BLOCKER, 1 MAJOR, 1 MINOR.

### Supervisor rulings for round 5 (9 Oct 2026, about 12:15 AM)

15. **MAJOR, botops.** The worker never joins botops (it owns `/run/signer/ops.sock`; under SPEC-B:668 fallback (b) membership would carry sentinel or operator identity). Use the dedicated group `zeroed-spool` = {operator, zeroed-worker}: folder 2730, owner zeroed-worker, group zeroed-spool, made by the installer; botctl writes 0640. PATHS-FIX changes SPEC-B:2539's "group botops" to this, with the reason.
16. **MINOR, pull account.** Sftp-only Match block with no shell and a ChrootDirectory (ForceCommand internal-sftp already named), and the pull account is added to B-M30-02's host user list (SPEC-B:2584) by PATHS-FIX.

## Round 5 (head `bead6dca`): delta review + red team, same session

Review PASS, final. Red team 0 BLOCKER, 0 MAJOR, 2 MINOR. The spool route gives no access to `ops.sock`; the chroot and bind mount keep the pull account inside the md subtree.

### Supervisor rulings (9 Oct 2026, about 12:25 AM): both MINORs go to PATHS-FIX, not this doc

17. **Receipts cap.** The pull account can write without limit into `receipts/`. PATHS-FIX caps their size and count: the worker deletes files that are not valid receipts and alerts. Alternatively, receipts get a small filesystem or a quota.
18. **Bind mount.** It persists through a systemd `.mount` unit (or fstab), ordered before `ssh.service`. `md` is mounted read-only, with a separate read-write bind for `md/receipts` only.

#307 is ready to merge once it is out of draft and green on a head that contains the latest base.

## PATHS-FIX #311 (head `c173f777`, base `d7c9c646`)

### Red team `session_01HLmKT9VCuhF4Pzd2B7LXxW`: 1 BLOCKER, 1 MAJOR, 3 MINOR

BLOCKER (`m07/receipts.ts:85`): `rmSync(path, { recursive: true })` on an entry the pull account made can delete the worker's own files. Swapping a directory for a symlink to `/var/lib/zeroed` during the recursive walk deletes through the link; the ledger stand-in was deleted in 10 of 10 local runs. MAJOR: receipts/ has no hard bound. The sweep runs after the fact and nothing calls it yet, so inode or byte exhaustion hits the disk the ledger shares, and duplicate valid receipts are kept. MINOR 1: SPEC-A:1307 and :2513 are stale (`/data/md`, `/data/rpc-usage.db` with group sentinel 0660), and the question of who writes rpc-usage.db is unanswered. MINOR 2: SPEC-B:2031 (M24 `/data/backups`) and :2584 (`/var/lib/bot`) are stale. MINOR 3: a failed pull mount fails closed, but nothing alerts. Clean: the Match block, the read-only md, the chroot, the groups (no path to ops.sock), every ENGINE_PATHS entry inside the writable paths, upgrade order, no guard loosened.

### Supervisor rulings for round 2 (9 Oct 2026, about 1:35 AM; sent with the reviewer's findings)

19. **BLOCKER.** Never recurse on anything the pull account can write. Unlink regular files and symlinks with `unlinkSync`, which never follows links. For a directory use `rmdirSync`, never recursive. If it is not empty, record it as `stuck` and alert. Anything else is `stuck`. Test: a race that swaps a directory for a symlink to the state folder deletes nothing outside receipts/.
20. **MAJOR.** Hard bound: receipts/ lives on its own small fixed-size filesystem with a fixed inode count (a loop-mounted image the installer creates, mounted at `/var/lib/zeroed-md/receipts`, ordered with the other pull mounts). A full image fails closed. Bind each receipt's file name to its segment, and delete duplicate valid receipts. Record the image size and inode count with the reason.
21. **MINOR 1.** Fix SPEC-A:1307 and :2513. For `rpc-usage.db`, find in the specs who writes it. If the sentinel must write it, give it its own shared state folder with the right group instead of the 0700 worker folder. Record the decision in DECISIONS.
22. **MINOR 2.** SPEC-B:2031: "M24 backup step not built; zeroed-backup is the one backup owner (DISK-BUDGET §2.6)". SPEC-B:2584: replace `/var/lib/bot`.
23. **MINOR 3.** `zeroed-check` alerts when a pull mount is inactive. This is monitoring of a component this PR adds, so it is in scope here. Test: inactive mount gives the alert; active gives none.

### #311 round 2 (head `c4d5d6db`, contains `e99e61af`; #312 carried forward to `3c09b1b0`)

Rulings 19–23 applied, as the builder reports:
- 19: unlink and rmdir only; a race test covers it.
- 20: a 64 MiB ext4 image with 32,768 inodes, caps of 30,000 receipts / 24 MiB, and segment-bound names.
- 21–22: rpc-usage.db moves to `/var/lib/zeroed-usage` (2770 zeroed-worker:zeroed-sentinel, setgid), because A-M14 says both the engine and the sentinel write it; SPEC lines fixed.
- 23: pull-mount alerts.

### Supervisor rulings (9 Oct 2026, about 1:48 AM)

24. **Builder MAJOR, rpc-usage.db not backed up.** Add `/var/lib/zeroed-usage` to zeroed-backup, as a consistent online copy (SQLite backup API or `.backup`, the same way as the other databases), counted in the backup budget. Test: a backup bundle contains rpc-usage.db, and a restore drill restores it.
25. **Builder MINORs.** No code now; they are card notes. The sentinel user and unit (B-M30-02) must run with group `zeroed-sentinel`. M14 must create the db, -wal and -shm as 0660 under UMask=0077. Both lines go in the PR's DECISIONS row.

### #311 round 2 red team (delta `c173f777..c4d5d6db`): 0 BLOCKER, 0 MAJOR, 2 MINOR

The BLOCKER is closed: 0 of 10 plain-rename races and 0 deletions in 255k atomic-exchange sweeps. The receipts image cannot be filled, grown or escaped, and the receipts bind fails closed without it. The usage folder gives the worker no new group. The mount alerts are right.

### Supervisor rulings (9 Oct 2026, about 1:51 AM)

26. **MINOR 1.** Preallocate the receipts image (`fallocate -l 64M`, or `truncate` followed by `fallocate`) so a full host disk cannot leave it half-written, and count the 64 MiB in the disk budget. Test: the installed image has 64 MiB of allocated blocks.
27. **MINOR 2.** No change now; it is a card note for B-M30-02 and M14, recorded in the PR's DECISIONS row. The sentinel opens `rpc-usage.db` and its -wal/-shm only after an lstat check (each must be a regular file, never a link), or with O_NOFOLLOW where the driver allows it. A root-owned 3770 folder stays a fallback, to be decided once SQLite's WAL deletion under a sticky folder is checked.
