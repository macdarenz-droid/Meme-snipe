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

- Reviewer (round 1, `83a396cb`): PASS, 0 BLOCKER, 0 MAJOR, 3 MINOR. Every card point and rulings 1–5 met; test-ci 265/0; label matches. The base fails broadly before (its guard refuses every archive path), so the per-block fail-before rests on the builder's run.
- Red team (round 1): PASS, 0 BLOCKER, 0 MAJOR, 4 MINOR, plus one note outside the diff.

### Supervisor rulings for round 2 (9 Oct about 8:58 AM)

6. **Reviewer MINOR 1, required.** The storage check counts everything stored for a day: for a K3 day the trimmed units plus `events-DAY.tar` and the `data-volume-DAY` release; a K2-based projection adds the same parts on top of the pm01-subset figure. The cap is a safety stop, so it must not undercount. Test with a K2 day near the cap.
7. **Reviewer MINOR 2 and red team m1, required.** The archive lane is one UTC day per batch (MIGRATION Card Z-H). The plan job refuses more than one archive day per run, so the forget output always covers the run's only day. Test: a two-day archive dispatch is refused before any request.
8. **Reviewer MINOR 3, required.** The guard also scans `run:` lines: `secrets.DATA_STORE_TOKEN` written into a `run:` line, `toJSON(secrets)`, `secrets[...]` and `secrets: inherit` are refused in archive workflows. One test each.
9. **Red team m2, required.** After `release create`, read-back requires the release's asset names to equal the SHA256SUMS set (`release_state` complete) before `readback=true`.
10. **Red team m3, required.** The assemble store step creates the release with its files in one call, uploads only the files SHA256SUMS lists, and reads them back as publish-day does.
11. **Red team m4, recorded.** A DECISIONS row: within one job, the tokenless and clean-shell split limits mistakes, not a compromised earlier step (shared workspace, runner sudo). Accepted as a known limit for the archive lane.
12. **Red team note outside the diff (deploy.yml "Set up the daily summary" holds `DATA_STORE_TOKEN` in a step that is not clean).** Not this card. Recorded as an identified hardening item (REPORTS-TOKEN: a separate reports token or a clean step) for after the owner's resume.

## Round 2 (head `93140d9d`)

- Red team: PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR. Round 1 m1–m3 are closed; ruling 6 holds and fails closed without the events tar.

### Supervisor ruling for round 3 (9 Oct about 10:06 AM)

13. **Red team MINOR, required.** The store-token checks match the literal `DATA_STORE_TOKEN` case-sensitively, while only the `run:` regex ignores case. GitHub's handling of secret-name case is not verified here, so the guard fails closed: every store-token check matches the secret name case-insensitively (for example `secrets\s*\.\s*data_store_token` with `re.I`). Test: `GH_TOKEN: ${{ secrets.data_store_token }}` in a step that is not clean is refused.

## Round 3 (head `ab2c9b87`)

- Ruling 13 built; red team delta: closed, PASS 0/0/0; no legitimate line refused. test-ci 270/0 (builder).
- Guarded diff (archive-check.yml, data-scan.yml) read by the supervisor's Opus read job: OK to label. No new write scope except the forget job's `actions: write`; all 21 store-token steps clean; `uses:` pinned; only the resume marker is an artifact; caps and `ARCHIVE_ARM` unchanged; nothing loosened.
14. **Read job's note, ruled (9 Oct about 10:57 AM).** "Storage check after the batch" (data-scan.yml:739) is skipped if the volume step fails after the day is stored; the job still fails and the chain stops, so it fails closed. Fold into OF-5 #316 (same file): the storage check also runs when the day was stored and a later step failed (`!cancelled()` and the stored output), with a test.
- #315 approved at `ab2c9b87`; marked ready; label `deps-reviewed:77c497b7b9abb6b3335ae2d31087e6f3` added 23:55 UTC after the head; merges on green labelled CI.
