# OF-4 nothing public: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-4 bullet, plus the OF2.md ruling 73 notes. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`, branch `claude/of4-nothing-public` from base `3aaee37e`. Reviewer `session_01DK9TU4gHh9V1Accrv4yuPY` and red team `session_01Uoe1pFxvHNzq9yCieDicqQ` (kept from OF-3).

## Supervisor rulings on the builder's open points (9 Oct about 7:00 AM)

1. **Q1, deleting the progress cache after read-back.** The scanner job does not get `actions: write`. The delete runs in its own small job that `needs:` the scan job, holds only `actions: write` (plus what checkout needs), runs no archive or scanner code, and runs only when the scan job's read-back output says passed. It deletes only this day's `data-scan-DAY-k<kid>-*` keys. The guard allow-list names that job alone; a test fails if any other job or step gains `actions: write`. Least privilege keeps the token away from the job that talks to the archive.
2. **Q2, the measured PM-01 subset for K2 days.** Accepted as recommended: `trim-day.sh --list-only` measures each K2 unit in a temporary directory, deletes it, and writes `pm01-subset-DAY.txt` into the assets (listed in SHA256SUMS). The storage check reads it from the stored K2 release and fails closed when it is missing.
3. **Q3, the skip step.** Accepted: `publish-day.sh --check` reads `DATA_REPO` in OF-4, so writing and skipping use one store. OF-5 adds the `-k3` predicate and the archive-check queue.
4. **K2 progress (OF-3 ruling 7).** Accepted: it does not go to zeroed-data. A K2 day that cannot finish in one job holds the chain for a decision. Record it in OLD-FAITHFUL and DECISIONS.

## Round 1 (PR #315, head `5abcabdf`)

- Builder report: test-ci 264/0; the 6 new OF-4 test blocks and the ruling 2 checks fail on base `3aaee37e`; label `deps-reviewed:3ed65ac45ab38a0221bcc3a85892c2ed`. Rulings 1–4 built.
5. **Builder's flag, ruled (9 Oct about 8:10 AM).** Split the assemble step: the store-token download runs alone in an `env -i` clean step; assemble then runs with no token. Least privilege, the same shape as every other store step. Test: the guard refuses a store token in any step that is not an `env -i` store step. Then the reviewer and red team start.
