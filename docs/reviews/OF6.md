# OF-6 no second archive read: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-6 bullet. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`, branch `claude/of6-no-reread`, stacked on OF-5 (`claude/of5-completion`).

## Supervisor rulings on the builder's design calls (9 Oct about 9:50 AM)

1. **Q1, where D+1's shared margin units come from.** Accepted: D's release carries `margin-D.tar` (D's units that reach past D's midnight), listed in SHA256SUMS and read back. Before D+1's scan, a clean store step downloads it (no archive request) and places those units so the scanner skips them.
2. **Q2, the taken units enter D+1 untouched.** Accepted, with one required property: **every coin in D+1's PM-01 list has complete events in the units D+1 takes from D's store.** D's copy is trimmed with D's list, so a coin that migrates during D (inside the forward margin) could be trimmed out of units that D+1 then reuses. The builder picks the mechanism (for example, trim D's forward-margin units with D's list plus the migrations D's own scan found) and proves the property with a test: a coin that migrates in D's forward margin keeps all its events in D+1. The per-unit log line names the source ("from data-day-D").
3. **Q3, re-read after a QA failure.** Accepted: a pinned DECISIONS row `QA-REREAD id=<id> day=D units=… toldAt=<UTC>`, written only after the owner is told; `scan-day` with `ARCHIVE_REREAD_ID` reads exactly those units through a new scanner flag `-units FILE` at the day's recorded retention; the guard refuses a whole-day read of a day with a counted failure since `ARCHIVE_REARM_AT` and no matching row. The new flag changes the scanner revision, which is allowed now because no batch has run (OF-3 freezes the revision from batch 1).
4. **Rescan unit.** Accepted: a check refuses a rescan range longer than one unit, with a test.
