# Review record: card Z-H-OF (PR #292)

Old Faithful route for gate B-10 (owner, 8 Oct about 7:25 AM: "Old faithful but by batch to avoid blockage") and the C-76 ruling (owner, 8 Oct about 7:31 AM: MR-01 parked). Builder session_01QxNHHJxUan1nnCAi2E5QEP. Reviewer session_01QKHK6RxUATkRY7SRF5MQEa. Red team session_01QBWebYD6N9KJ7agcvkqTa9.

## Builder report (heads `99792ba7`, then `60612d8b`)

- Limits: Triton documents no limit for `files.old-faithful.net`, so the caps stay at 10 req/s and 40 MB/s (`archive-limits.conf:5-6`). The Terms of Use page was not found. Whether a private store needs Triton's OK is unclear.
- Batch plan:
  - one UTC day per batch, one at a time, dispatched by a served archive-check, at least 60 min after the last batch;
  - 429, 403 or 503 stops the chain for ≥ 3 h; 3 failures stop it until a reviewed re-arm;
  - order: 07-22 lead-in, 07-23..08-21, then 08-22..09-20;
  - about 3.4 h a batch; about 8 days for 31 days (12–16 days if crons drop).
- Storage: about 0.20–0.26 TB for 31 days with retention K3.
- Findings:
  - #214 must not merge before the batch scheduler OF-2, or it dispatches 09-20 and then holdout days;
  - `publish-day.sh:87` publishes to the public repository.
- 09-21: recommends (a). Drop the Helius cache when #214 merges; 09-21 stays in HELIUS_DAYS; stop DATA-KEEP's refresh of it.
- C-76 commit: MR-01 parked across ARCH 3.2/3.3/D08/3.4/9.2, SPEC-A (MA-0c, A-M09-02, A-M13-01 step 9, R0, A-M13-06, C-76), INTEGRATION, MIGRATION, DECISIONS and FACTS RS-40. B-10 replays the stage's strategy (PM-01 or a future slot strategy). If none has reached gate B, B-10 stays pending, failing closed.

## Owner answers (8 Oct about 7:42 AM)

- Triton: "No reply".
- Storage: "Store them". Day files go only in the private zeroed-data repository; publishing stays off until Triton answers (CLAUDE.md "History for the past-data test" → "Storage").

## Supervisor rulings on the builder's open points (8 Oct about 7:50 AM)

1. **C-56 end state with MR-01 parked.**
   - A parked MR-01 counts as "failed" for C-56: it failed its screen and will not run. So C-56 now turns on PM-01.
   - Reading of the two owner rules together: the 31 Dec stop applies to strategy work the agents start on their own. A strategy the owner brings through the M09 slot (owner, 8 Oct about 7:27 AM, "Strategy slots") may continue after 31 Dec within the spend the owner already pays (nothing new). The later owner instruction governs where the two meet.
   - List this in MIGRATION's clash table with that recommendation, marked for the owner to overrule.
2. **Retention: K3.** Keep raw records for PM-01's universe only. That stays inside the owner's approved 0.2–0.5 TB; K2's 0.5–1.4 TB does not.
   - A future slot strategy that needs other pools reads those days again from the archive. That is 0 credits, only time, under the same batch rules, and it needs the owner's OK as a new download.
   - State this in OLD-FAITHFUL.md §3 and the Z-H card.
3. **D30 and A-24/A-24b.**
   - D30 (daily enumeration of established pools) exists for MR. Park it: no Helius job. The owner's pending D30 question is withdrawn.
   - A-24b (the precondition for writing MR-01's ticket): park it.
   - A-24 (the move distribution from recorded M07 data): keep it only where another gate or study uses it. Otherwise mark it optional evidence for a revised MR version.
   - Say so in ARCH, SPEC-A, MIGRATION and Owner waits.
4. **Owner answers.** Record Triton "No reply" and "Store them" in OLD-FAITHFUL.md §1 and §3, the Z-H card, OF-4 (redirect `publish-day.sh` to zeroed-data, private, before batch 1) and DECISIONS.

## Round 1 (head `99792ba7`; both reports were written before the C-76 commit `60612d8b` landed)

### Fresh review (FAIL: 1 BLOCKING, 1 HIGH, 1 MEDIUM, 3 LOW, 2 NIT)

Reviewer, about 7:43 AM. Items 1–6 of the Old Faithful part pass. All 7 sources were opened and say what is claimed. Every number was recomputed (blocks a day, GB a day, hours at 40 MB/s, 3.36 h a batch, 7.75 days for 31, 10,566 GB read, 0.198–0.264 TB stored, option (c) credits) and matches. The code citations match. Both builder findings are confirmed. Scripts clean.
- BLOCKING-1: the C-76 ruling is missing. It is addressed by `60612d8b`, to be confirmed in the delta review.
- HIGH-1: the plan queues 08-22..09-20 (61 days, about 23.9 TB read), beyond the owner's "30 days ... for these days only".
- MEDIUM-1: K3 storage is sized on MR's universe; with MR parked, PM-01's raw size is VERIFY, bounded above by K2 (0.5–1.4 TB).
- LOW-1: "4.7 h for a 250 ms day" is really the 269 ms mean.
- LOW-2: "12–16 days" has no derivation (every other check dropped gives 15.5 days).
- LOW-3: §1 row 4 joins two URLs.
- NIT-1: quote "currently completely free to use" exactly.
- NIT-2: `b10ReservationActiveMinutes` at SPEC-A:2253 and :2266 should be marked [not chosen, C-79].

### Red team (0 CRITICAL, 8 MAJOR, 4 MEDIUM, 2 MINOR)

Red team, about 7:44 AM. Clean: only `files.old-faithful.net` is reached; HELIUS_DAYS are refused; no past day is in W_R; the account ledger and P21 stay.
1. archive-check sends its probe without reading the persisted back-off, so after a 429 a request goes out at about T+1 h.
2. Holdout and out-of-list days can be read through a manual or chained data-scan; only archive-check's queue is guarded.
3. OF-4 misses the public 14-day `day-DAY` artifact (`data-scan.yml:436-442`) and `publish-volume.sh:45`.
4. "Day done" is read from the public repo, so once OF-4 publishes privately, 07-22 is re-read forever.
5. No code hold makes OF-3..OF-6 land before the first dispatch.
6. The day list goes beyond the owner's 30-day exception (same as HIGH-1).
7. MR-01 is not parked in this diff, and K3 is sized on MR. Covered by `60612d8b` for the parking; retention below.
8. The owner was shown 0.2–0.5 TB, which is not an upper bound.
9. Two dispatches can race (a queued check runs before the new run is listed).
10. Failures cannot be counted from run conclusions (a non-served check exits 0), and a re-arm cannot reset a count read from history.
11. The time estimate understates a long block (the 4 Oct block lasted more than 6 h).
12. The determinism rescan unit (`check-day.sh:80`) adds about 2% reading and a second read of one unit.
13. #214's test-ci expects a dispatch of 2026-09-20.
14. B-10 should fail when a replay names no strategy, or a strategy other than the selected configuration.

### Supervisor rulings for round 2 (8 Oct 2026, about 7:55 AM)

I accept every finding. Together with the rulings above (C-56, K3, D30, owner answers), apply these:

1. **Days: 31 only.**
   - The queue, the allow-list and every doc stop at 07-22..08-21: the lead-in plus 30 decision days.
   - Days 08-22..09-20 are an owner question. The owner was asked at about 7:45 AM whether to continue to 60 after the first 30. They are not queued unless the owner says yes.
   - Say plainly that 30 days leaves no spare if a day fails QA.
2. **One allow-list, enforced everywhere.** `archive-limits.conf` holds the allow-list. The data-scan plan job, `scan-day.sh`, `check-day.sh` and archive-check all refuse any day outside it, and refuse HELIUS_DAYS. Add test-ci cases for a holdout day, a day before 07-22, and a manual dispatch.
3. **Back-off before any request.** archive-check sends nothing, not even the 64-byte probe, until `ARCHIVE_BACKOFF_S` has passed since the last exit 4 or the last non-206 check. Every hold (back-off, arm, rps, queue empty) comes before the request. Add test-ci: a block 61 min ago means no request.
4. **Nothing public.** OF-4 covers every archive-path output:
   - `publish-day.sh` and `publish-volume.sh` go to zeroed-data (private);
   - the `day-DAY` artifact is dropped, or kept in the Actions cache only.
   - Add a test: no archive-path step writes a release or an artifact to `GITHUB_REPOSITORY`.
5. **Completion from the private store.** "Is this day done?" reads zeroed-data and fails closed if zeroed-data cannot be read. Add a test.
6. **An arm switch in code.** OF-2 adds a fail-closed arm value to `archive-limits.conf`, for example the pinned B10-PULL id, checked before any request. Only the last reviewed change after OF-3..OF-6 sets it. #214 merges with or after OF-2, and its test-ci is updated in that same change.
7. **Retention K3 for PM-01, and an honest storage figure.**
   - Batch 1 measures PM-01's raw-record size.
   - The owner approved about 0.2–0.5 TB. If batch 1's projection for 31 days is above 0.5 TB, the chain stops after batch 1 and the owner is asked.
   - Show the full range (about 0.1 to 1.4 TB), with its sources and the ±2× July uncertainty.
   - No Phase 0 precondition is needed for the download itself (0 credits). B-10 runs only once a strategy reaches gate B.
   - A future strategy that needs raw records for other pools reads those days again, at 0 credits, under the same batch rules, with the owner's OK.
8. **Dispatch race.** Write a dispatch marker (or poll until the new run is listed) before a second check can dispatch. Add a test.
9. **Countable failures.**
   - A non-served check ends with a distinct, countable conclusion or run title.
   - `archive-limits.conf` holds a re-arm timestamp, and the 3-failure count starts from it.
   - Add tests.
10. **Honest time.**
    - State the long-block case: on 4 Oct a block lasted more than 6 h, so a similar block stops the chain after about 9 h until it is re-armed.
    - Count the determinism rescan unit (about 2% more reading), and name it as the one allowed second read of a unit.
    - Fix LOW-1 (the 269 ms day) and LOW-2 (derive the figure or drop it).
11. **B-10 needs a named strategy.** In SPEC-A A-M13-06, a replay that names no strategy, or a strategy other than the selected configuration, fails B-10. Add a case.
12. **LOW-3, NIT-1, NIT-2:** split the §1 row; quote the page exactly; mark `b10ReservationActiveMinutes` and the "reservation active" minute [not chosen, C-79].
13. **The open points ruled above** (C-56, K3, D30 parked, A-24b parked, owner answers): apply them in the same push.

### Delta reports on `60612d8b` (written before the hold reached them)

- Reviewer: FAIL. C-76 is mostly fixed, with evidence. HIGH-1 and MEDIUM-1 are still open. New:
  - MEDIUM-2: stale C-76 text at ARCH:3132, :3150, :3235, and the last sentences of SPEC-A C-76.
  - MEDIUM-3: the A17/C-56 end state is ambiguous with MR-01 parked.
- Red team: 8 MAJOR (round 1's 1–6 and 8 carried; round-1 #7 downgraded to MEDIUM; #14 closed). New:
  - MAJOR 15: the A17 stop can no longer trigger, because a parked strategy never "fails".
  - MEDIUM 16: `W_B`'s start is still tied to MR-01's pre-registration (SPEC-A:2022, C-26 :2602).
  - Downgraded #7: make the K3/K2 choice an OF-3 precondition with recorded numbers, and tell the owner that the days may wait unused.
- Checked by the red team: no gate passes with nothing real behind it, except the A17 stop (#15).

### Supervisor rulings, round 2 addendum (8 Oct 2026, about 8:00 AM)

14. **C-56 re-keyed (MAJOR 15, MEDIUM-3).** This replaces the open-point ruling 1 wording.
    - "If PM-01 fails and no other strategy is in its gates (parked MR-01 counts as failed), strategy work the agents start stops by 31 Dec 2026, with the spend cap the owner already pays."
    - A strategy the owner brings through the M09 slot may continue after 31 Dec within that same spend. This is the owner's 8 Oct "Strategy slots" instruction, the later one.
    - Write this into C-56, ARCH D08 (:1722) and :3090, MIGRATION A17 and the DECISIONS row. Add an acceptance line: PM-01 fails, with no other strategy in its gates, so the stop applies.
    - The owner's stop date and spend cap are not weakened.
15. **Stale C-76 text (MEDIUM-2).**
    - Mark ARCH:3132 RULED.
    - Tag ARCH:3150 and :3235 [not chosen, C-79], or remove C-76 from them.
    - Rewrite the last sentences of SPEC-A C-76 to match the ruling: no Phase 0 check of MR-01 runs, and the owner wait is resolved.
16. **`W_B`'s start (MEDIUM 16).** `W_B` begins after the configurations of the stage's strategy (PM-01 or a slot strategy) are pre-registered. The Phase 0 study week stays excluded. Fix SPEC-A:2022 and C-26.
17. **Retention decided from measurement (red team #7, refines ruling 7).**
    - Batch 1 keeps raw records for every canonical pool (K2) for that one day, so both sizes are measured: PM-01's universe and the full set.
    - The retention for batches 2 onward is then chosen and recorded before batch 2, as an OF-3 step with the numbers: K3 if the 31-day PM-01 projection fits under 0.5 TB, otherwise stop and ask the owner.
    - Batch 1's extra raw is trimmed to the chosen retention.
    - The docs say plainly, and so will the supervisor to the owner, that the days may wait unused until a strategy reaches gate B, and under A17 may never be used.

### Delta review on `ccd0d9c9` (before the addendum commit `49529d6d`)

Reviewer: FAIL. Rulings 1–13 and open points 1–4 are applied, and every number was recomputed and is correct. HIGH-1..4 are rulings 14–17, which `49529d6d` addresses. New:
- HIGH-5: parked A-M03-03 (D30) is still a dependency of A-M05-01 (SPEC-A:76, :945), A-M06-04 (:82) and A-M03-04 (:72, :809), and is listed in MA-0b (:43) and in INTEGRATION M1's ticket list. Core tickets would wait on a ticket that will never exist.
- MEDIUM-1: INTEGRATION M1's exit (:22) and ARCH Phase 0 (:2912) still list A-24 and A-24b and "Stop MR-01 if …". Resting MA-0c on A-48 alone is sound.
- LOW-1: the provenance should cite ZHOF @ `c2f8f899`.

### Supervisor rulings for round 3 (8 Oct 2026, about 8:10 AM)

18. **HIGH-5: no dependency on a parked ticket.**
    - Remove A-M03-03 from the dependency lists of A-M05-01, A-M06-04 and A-M03-04, and from MA-0b and INTEGRATION M1. A-M05-01 takes migrations from A-M03-02 only.
    - Park A-M03-04's enumeration cross-check part, or point it at migrations.
    - Recount M1 (24 tickets) and re-run the ticket graph.
19. **MEDIUM-1:** align INTEGRATION M1's exit and ARCH Phase 0 (:2912) with MA-0c: the 48 h recording at ≥ 95% plus the A-48 report. The Stop-MR-01 conditions apply only to a revised MR version.
20. **LOW-1:** cite ZHOF @ `c2f8f899` in DECISIONS:125 and OLD-FAITHFUL.md :4.

### Red team round 3 on `ccd0d9c9` (also before `49529d6d`)

2 MAJOR, 5 MEDIUM, 3 MINOR.
- A is rulings 14–17, which `49529d6d` covers.
- C (retention must not break the single revision) is answered by the builder's per-unit `retention` tag in `49529d6d`; check it at the final head.
- F is the same as round 3 items 18–19.
- New:
  - B MAJOR: the arm and the 3-failure stop are enforced only in archive-check, so a manual data-scan dispatch reads the archive unarmed or after a stop.
  - D: the 0.5 TB stop is checked only after batch 1.
  - E: a day that fails QA is re-read whole without the owner.
  - G: under OF-6, a missing day D blocks D+1's margin units.
  - H: the dispatch marker's place and freshness are unspecified.
  - I: PM-01 has no Phase 0 check; say so.

### Supervisor rulings for round 3, continued (8 Oct 2026, about 8:15 AM)

21. **B: the arm and the stop everywhere.** The data-scan plan job and `scan-day.sh` also refuse, before any request, when `ARCHIVE_ARM` is unset or not the pinned id, and when the 3-failure stop is active. Add test-ci: an unarmed manual dispatch is refused; a manual dispatch after 3 failures is refused.
22. **D: the storage stop after every batch.** After each batch, OF-4 checks that the stored total plus the remaining days × the largest day so far stays ≤ 0.5 TB. Otherwise it stops and asks the owner. Add a test.
23. **E: no whole-day re-read.** After a QA failure, only the units QA names are read again, and only after the owner is told. Otherwise the day counts as missing, B-10 is short, and the owner is asked about a spare day. Never re-read a whole day.
24. **G: day order under OF-6.** Day D+1 is dispatched only after day D is stored, because D+1 takes D's margin units from the store. Write this into OF-2 and OF-6, with a test.
25. **H: the marker.** Name where the dispatch marker lives (an Actions cache key or an artifact in the private store) and its TTL (at least 10 min).
26. **I:** A-M13-01 "Parked parts" says plainly that PM-01 has no Phase 0 check; its first evidence is gate B.
27. **C:** confirm in OLD-FAITHFUL.md §3 and OF-3 that one scanner revision covers both retention values, recorded per unit, and that finalize refuses a day that mixes them. If `49529d6d` already says this, cite the line.
