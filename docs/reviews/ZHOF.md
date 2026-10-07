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
