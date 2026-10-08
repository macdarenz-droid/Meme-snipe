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
