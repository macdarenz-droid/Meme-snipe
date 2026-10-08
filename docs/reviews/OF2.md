# OF-2 (PR #296) review log

## Round 1 (head `e1412b7c`)

### Reviewer `session_017x89LKh2CEx5Hwkte14btR`: PASS, with 3 MINOR

test-ci re-run gives 186/0 at the head and 143/44 on the base. Go, lint and the policy check pass, and the label matches.
- M1: the scanner has no `-retention` flag (OF-3).
- M2: publish-day and the skip step still use the public repo (OF-5 before arming).
- M3: hold 2 does not honour a Retry-After longer than 3 h.

### Red team `session_01LQHpKvikNEWAw96tHRnZq3`: 2 BLOCKER, 4 MAJOR, 5 MINOR

- B1: re-running a failed archive-check skips the back-off and the 3-failure stop, because the run's own failure disappears while it re-runs.
- B2: re-running a failed batch reads the archive after failure #3, and a green re-run turns F into S.
- M3: a manual dispatch bypasses holds 2, 5, 6 and 7 (back-off, 60 min, day order, read done).
- M4: a no-op success resets the count.
- M5: archive-check runs on any ref, but failures and markers count only from the default branch.
- M6: the one-restart rule follows `inputs.chain`, not the day.
- m7: the `-retention` flag (OF-3). m8: a check cut short after the probe is not counted. m9: the storage-stop form. m10: the guard pass is not bound to retention, run or attempt. m11: if armed before OF-4, data reaches the artifact and this repo's releases.

### Supervisor rulings for round 2 (8 Oct 2026, 3:05 PM)

1. **B1, B2: re-runs.** archive-check.sh, and the guard's `attest` and `full` modes, refuse when `GITHUB_RUN_ATTEMPT` is not 1. Failures are counted across every attempt of a run (`actions/runs/{id}/attempts/{n}`), not only the latest, so a green re-run never erases an F. Add test-ci cases: a re-run of a failed check, and a re-run of failed batch #3.
2. **M3: manual dispatch.** In archive scan mode, `ag_full` applies the same back-off and 60-min gap as archive-check. DAY must be the oldest allow-listed day not read done (`ag_read_done`), so out-of-order and done days are refused. Add test-ci cases for (a)–(d) of the report.
3. **M4: what counts as a success.** S counts only when the run actually stored a day: its publish step succeeded and the `published` step did not mark the day complete beforehand. Once OF-4/OF-5 move storage to zeroed-data, S counts only when a new `data-day-D` tag created by that run exists there. Add a test case: a no-op success after 2 failures does not reset the count.
4. **M5: default branch only.** archive-check.sh and the data-scan guard refuse unless `GITHUB_REF` is the default branch. Failures are counted from archive-check runs on every branch, since a probe from any branch is a request.
5. **M6: restarts per day.** exit-75 stops are counted per day from run history, not from `inputs.chain`.
6. **m8.** Write a "probe sent" mark before the curl. Count any completed check whose probe step ran but did not end served, whatever its conclusion (failure, cancelled, timed out).
7. **m9.** The stop marker is a published tag `storage-stop` in zeroed-data. Write it into the OF-4 row, and test it from both sides when OF-4 lands.
8. **m10.** The pass file carries the retention, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, and the check compares all three.
9. **m11 and reviewer M2.** The arm check refuses while `publish-day.sh` or the skip step targets `GITHUB_REPOSITORY`, so OF-4 and OF-5 must land before arming, enforced in code. Add a test case.
10. **Reviewer M3: Retry-After.** archive-check parses Retry-After from its probe's 429. The scan records its back-off end where archive-check can read it (for example an Actions cache key `archive-backoff-<end>`). Hold 2 waits for max(3 h, the recorded end). The owner's rule is to honour Retry-After.
11. **Reviewer M1 and m7.** OF-3 adds the flag (in progress). After OF-3, test-ci checks that the real binary accepts `-retention`.
