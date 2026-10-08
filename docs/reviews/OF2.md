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

### Supervisor rulings for round 2 (8 Oct 2026, 3:04 PM)

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

## Round 2 (head `b731b0b5`): reviewer PASS (4 MINOR); red team 0 BLOCKER, 3 MAJOR, 4 MINOR

- Round 1 BLOCKERs and MAJORs closed in code (both).
- Red team M1: old branches (319 remote refs) carry the pre-OF-2 data-scan.yml with no guard; a dispatch from one reads the archive unguarded, and its publish success counts as S.
- Red team M2 and reviewer m3: the private-storage arm check is a literal-string deny-list (`${GITHUB_REPOSITORY}`, `-R`, `GH_REPO=`, a dropped `--repo`, a new script, a renamed artifact, and assemble.sh all slip past).
- Red team M3 and reviewer m2: the Retry-After end lives only in an evictable cache key, and a missing key reads as "no back-off".
- Red team m4: a re-run continue job can grant an extra restart. m5: ag_full has no lane-busy check. m6: a lost runner can leave the probe step with a null conclusion, uncounted. m7: unparsed or huge Retry-After values are ignored.
- Reviewer m1: test-ci:335 aborts a fail-before run under set -e. m4: --probe has no arm or allow-list check of its own.

### Supervisor rulings for round 3 (8 Oct 2026, 3:55 PM)

12. **M1.** (a) ag_history counts S only from default-branch runs whose plan job's "Archive guard" step succeeded. (b) A hold: any data-scan archive run from a non-default branch since `ARCHIVE_REARM_AT` stops the chain (no request) until a reviewed re-arm; test it. (c) A read-only script in ci/ lists remote refs whose data-scan.yml can read the archive without archive-guard.sh. Deleting hundreds of branches is hard to undo, so at arm time the supervisor puts that list to the owner with a recommendation; it is not deleted by an agent.
13. **M2 and reviewer m3.** Test the capability, not the spelling. Arming refuses unless: data-scan.yml's scan, volume and assemble jobs have no `contents: write`; the scan job has no `actions/upload-artifact` other than the `resume-` one; every `gh release` call under `research/historical/ci/` (assemble.sh included) carries `--repo "$DATA_REPO"`. Add a test-ci case for each bypass form named above.
14. **M3 and reviewer m2.** The failing run records the back-off end durably as a check-run annotation (`archive-backoff` title, `end=<unix>`), and hold 2 reads it for every counted failure since `ARCHIVE_REARM_AT`; an unreadable record fails closed. The cache key stays as a fast path. **VERIFY** that annotations stay readable for at least the 3-failure window. This replaces my 3:47 PM message that put a durable tag in OF-4.
15. **m4.** The continue step refuses `GITHUB_RUN_ATTEMPT` ≠ 1.
16. **m5.** ag_full refuses while any other non-Helius data-scan run is not completed, and treats it as ending now for the 60-min check.
17. **m6.** Count the probe step when its conclusion is anything but success or skipped on a completed attempt, null included.
18. **m7.** Parse Retry-After strictly (delta-seconds or IMF-fixdate, RFC 9110). Present but unclean, or above 7 days: record a sentinel that holds the chain until a reviewed re-arm.
19. **Reviewer m1.** Guard test-ci.sh:335 so a fail-before run completes.
20. **Reviewer m4.** `--probe` runs `ag_local` itself before any request.

## Round 3 (head `3b67e97d`): reviewer PASS (3 MINOR); red team 0 BLOCKER, 3 MAJOR, 5 MINOR

- Round 2 items closed (both). Red team A: re-running an old default-branch run (data-scan #1–#8, archive-check #1–#14, old unguarded code) reads the archive, and the new history misses it (selected by createdAt, headBranch is the default). B: a guard refusal inside the scan job counts as a failure with no request made; AG_BUSY also counts `data-scan volume` runs and a queued manual dispatch, so a clean batch can be counted F. C: check-day prints the QA report (block and trade counts, account addresses, slots) to the public job log. m1 AG_FOREIGN also stops on runs that read nothing. m2 GitHub's per-job annotation limits can drop the back-off record. m4 the `contents: write` check is a literal match (quoted values, `write-all`, flow mappings, a removed block) and other workflows are not checked. m5 a trailing space in Retry-After triggers the hold.
- Reviewer: m1 = red team m4; m2 annotation retention is not verified, and a deleted annotation reads as "none"; m3 an old branch's archive-check.yml can be dispatched by hand; test-ci.sh:714 has the unguarded awk.

### Supervisor rulings for round 4 (8 Oct 2026, 4:50 PM)

21. **A.** Select runs by `updatedAt` ≥ `AG_SINCE`, not `createdAt`. Any attempt > 1 of a run whose head SHA has no archive-guard.sh is foreign and stops the chain. At arm time, the arm checklist lists every old run whose re-run window is still open; deleting runs is hard to undo, so the supervisor puts "delete them or wait for the window to close" to the owner then.
22. **B.** The classifier never counts a scan job whose failed step is "Archive guard before the scan" or "Archive guard before QA" (no request was made). guardqa skips AG_BUSY and the 60-min check. AG_BUSY and AG_LANE_END ignore titles starting "data-scan volume".
23. **C.** QA output goes to the dataset directory (the private store), never to a log or step summary. Public logs and summaries in the archive path carry only pass or fail, unit counts and file sizes. A test-ci check that no archive-path step prints the report; ag_private_storage checks it.
24. **m1.** AG_FOREIGN counts only runs where a `scan (...)` job started, or whose head SHA lacks archive-guard.sh.
25. **m2.** Emit the back-off annotation first, in its own step. A counted probe failure with no annotation reads as `end=hold` (fail closed), not "none".
26. **m4 / reviewer m1.** Parse permissions structurally (yq or python3's yaml, whichever the runner has: **VERIFY**). Arming requires an explicit top-level `permissions:` with `contents: read`, no `write-all`, and no job that grants `contents: write` (quoted, flow or block form). Every workflow is checked for scan-day.sh, zeroed-scan, archive-derived cache keys and release writes. test-ci cases for the four forms, a removed block and `write-all`.
27. **m5.** Trim whitespace before the strict Retry-After parse.
28. **Reviewer m2.** Read the repository's Actions log retention through the API if it is readable (read only); otherwise it becomes a one-line owner check on the arm checklist. Record the value in DECISIONS.
29. **Reviewer m3.** unguarded-refs.sh also lists branches whose archive-check.yml lacks archive-guard.sh, and AG_FOREIGN counts completed archive-check runs from non-default branches since `ARCHIVE_REARM_AT`.
30. **Reviewer note.** Guard test-ci.sh:714 the same way as :356.

## Round 4 (heads: of2-holds `dd08171c`, archive-safe-b `9738777b`, of3-scanner `ac220b25`; base `80854aaf`)

Builder: rulings 21–30 done; test-ci 212/0, 213/0 and 224/0; 15 rows fail on `3b67e97d`. It asked 11 questions.

### Supervisor rulings on the builder's questions (8 Oct 2026, 6:41 PM)

31. **Q1, accepted.** A workflow is an archive path when it mentions scan-day.sh, zeroed-scan, the `data-scan-` / `data-rpc-` caches, or the `data-day-` / `data-volume-` releases, including any download of those caches or release assets. `deploy.yml`'s key-handoff release is not one. Add a test-ci case that deploy.yml carries none of these markers, so it stays outside and is noticed if it changes.
32. **Q2, accepted.** A repeated key is refused (fail closed). The volume-write bypass test now expects the refusal.
33. **Q3.** If the runner has no parser that refuses repeated keys, arming refuses (fail closed). The check prints which parser it used and its version. Arm checklist item 4 confirms this on the first armed run (VERIFY).
34. **Q4, accepted** if the annotation step runs whatever came before (`if: always()` or `!cancelled()`). A test-ci case checks the condition; a missing annotation still reads as `end=hold`.
35. **Q5 to Q11, accepted.**
    - A probe timeout reads as `end=hold` and needs a reviewed re-arm (arm checklist).
    - `$ds-log` never goes to a public place. The builder states whether it is uploaded to the private store or dropped at job end.
    - The determinism rescan stays off the public log.
    - The wrapper-agnostic guard pattern stands.
    - Two VERIFY items go to the arm checklist: the 500-run window with the re-run window length, and the log retention read with an owner fallback.
    - Merge base `3a734e74` with the OF-3 round 3 push.

### Round 4 red team (delta `3b67e97d..dd08171c`): 1 MAJOR, 6 MINOR

Round 3 items A, B and C are closed. No archive request is possible from current code while unarmed, held or backed off. The remaining paths are old code on old refs: detection stops the chain, and prevention is the arm-time cleanup.

### Supervisor rulings (8 Oct 2026, 6:50 PM)

36. **MAJOR 1.** The scanner's output (`zeroed-scan run` and `unit`: plan counts and per-unit counts) goes to the private side, next to the QA output from ruling 35, never to the job log or step summary. The public log keeps only pass or fail, the exit code and 429/back-off lines. The ag_private_storage guard covers every `zeroed-scan` call except an allow-list of subcommands shown to print nothing archive-derived (fail closed). Test: a stub `zeroed-scan run` that prints `curve=5` never reaches the log or the summary, and an unredirected `zeroed-scan run` line in ci/*.sh is refused.
37. **MINOR 2.** unguarded-refs.sh also walks tags, and the arm checklist covers them. Today `preview` (13cdf32) carries an unguarded data-scan.yml. `deploy` moves forward with each deploy, so after OF-2 merges and the next deploy it is guarded. Deleting or moving a tag is hard to undo, so at arm time the supervisor puts each unguarded tag to the owner.
38. **MINOR 3.** An archive-check run off the default branch counts as AG_FOREIGN only if its head SHA lacks archive-guard.sh or its "Archive probe" step was not skipped.
39. **MINOR 4.** Archive workflows allow only `contents: read` and `actions: read`; `actions: write` is allowed only where the builder shows it is needed. Every other scope must be absent or `none`. upload-artifact is checked in every job of an archive workflow, and `run:` blocks are scanned for qa and scanner calls under ruling 36. test-ci cases: a volume job with `pages: write` refuses, and an assemble step with upload-artifact refuses.
40. **MINOR 5.** OLD-FAITHFUL §2 states that one cancelled or timed-out check stops the chain until a reviewed re-arm. Whether `always()` steps run after a job-level timeout is VERIFY; the chain fails closed either way.
41. **MINOR 6.** The "data-scan volume" title skip applies only to default-branch runs whose head SHA is guarded.
42. **MINOR 7.** If the run list reaches its cap (500), the guard fails closed. It also lists `status=in_progress` runs explicitly.

### Round 4 reviewer: PASS at `dd08171c` (2 MINOR)

- test-ci 212/213/224 pass; 15 rows fail on the `3b67e97d` files. Labels match. Merge-forwards consistent. Arming refuses today: data-scan.yml still grants `contents: write` and uploads the day artifact.
- m1 is the red team's MAJOR 1, covered by ruling 36. m2: the parser and the log retention stay VERIFY items on the arm checklist (rulings 28 and 33).

## Round 5 (heads: of2-holds `89f99393`, archive-safe-b `8f6b7e34`, of3-scanner `d59ab431`)

- Builder: rulings 36–42 done. test-ci 218/219/233; fail-before rows for 36–39, 41 and 42.
- Readings, accepted (8 Oct 2026, 8:05 PM):
  - The allow-list in 36 is empty: every zeroed-scan call writes to a file or is captured.
  - Ruling 33 now means python3 with yaml only; yq is dropped because it keeps a repeated key.
  - `actions: write` is allowed only for archive-check.yml at the top level and for the continue job in data-scan.yml.
- Risk from 42: archive-check reaches 500 listed runs in about 62 days, and then the guard fails closed. The cap stays as it is: the 31 days in batches should finish well before then. If the cap does trip, it goes to the owner, because deleting runs is hard to undo. A filter on run creation date stays a VERIFY idea in OLD-FAITHFUL; it is not built now.

### Round 5 reviewer: PASS at `89f99393` (1 MINOR)

- test-ci 218/219/233; 10 rows fail on the `dd08171c` files. Every zeroed-scan, finalize and qa call is redirected. data-scan.yml is refused until OF-4 (`contents: write`). No parser means fail closed. Merge-forwards are consistent.
- m1 (the 500-run cap) is not changed: a `--created >= AG_SINCE` filter would hide re-runs of runs created before `AG_SINCE`, which is exactly what ruling 21 catches. The arm checklist records archive-check's run count and the date the cap is reached; a cap trip goes to the owner.

### Round 5 red team (delta `dd08171c..89f99393`): 2 MAJOR, 4 MINOR

Round 4 repros are closed. From current code, no archive request is possible while unarmed, held or backed off.

### Supervisor rulings for round 6 (8 Oct 2026, 8:20 PM)

43. **MAJOR 1, run-list cap.** The cap trips for good once a workflow has 500 runs, which for archive-check is about early December. This ruling replaces the round 5 reviewer note.
    - List only runs created within the re-run window: `--created ">=<now − 35 days>"`. That still covers every possible re-run, because a run older than 30 days cannot be re-run (VERIFY the 30-day limit in GitHub's docs and record the source).
    - Fail closed only if that windowed list reaches the cap.
    - List every non-completed state (queued, in_progress, waiting, requested, pending).
    - VERIFY that the runner's gh version supports `--created` and these `--status` values; print it, and fail closed if not.
    - Test: a stub with 500 old runs outside the window passes; 500 inside the window fails closed.
44. **MAJOR 2, cache readable by fork PRs.** In this public repo, a fork's pull_request workflow can restore the base branch's caches.
    - Archive-derived bytes in the Actions cache (progress, units, k2 copies) are encrypted with an authenticated cipher available on the runner. The key comes from a secret (fork PRs get no secrets): derive it from `DATA_STORE_TOKEN` with HMAC and a fixed label, so the owner adds no new secret.
    - A failed decrypt fails closed. A rotated token means the cache counts as missing, which ruling 7 / OF-4 already handles.
    - The arm check asserts that the saved cache paths hold only encrypted files.
    - The `data-rpc-*` Helius caches held today are not encrypted. They expire after 7 days unused, and are not deleted by hand (hard to undo).
    - On the arm checklist, an owner step for defence in depth: set "Fork pull request workflows" to require approval for all outside collaborators.
45. **m3, honest checker bypasses.** Match `zeroed-scan` after `/`, a quote or `-c `. Refuse `GITHUB_STEP_SUMMARY`, `GITHUB_OUTPUT` and `/dev/std*` as redirect targets. Also scan the `*.sh` files outside `ci/` that the workflows call. Tests: the red team's three lines.
46. **m4, uploads.** Archive workflows refuse `uses: ./` composite actions unless their action.yml is checked the same way, and refuse the whole `actions/upload-*` family by prefix.
47. **m5.** Compute `ag_sha_guarded` once per SHA in the parent shell, not in `$( )`. Test: one contents call per SHA.
48. **m6.** Tags are checked as `refs/tags/NAME`, so a branch and a tag with the same name are both checked.
44a. **Ruling 44 amended (8:18 PM; the red team's design notes).**
    - The cache name carries a key id (a short hash of the derived key). A cache that cannot be decrypted makes the scan refuse with no read; it never starts the day fresh. A day is never read whole twice.
    - The arm checklist adds an owner line: do not rotate `DATA_STORE_TOKEN` while the download runs.
    - The token is used only in the `env -i` guard and crypt steps, never in the Scan or QA steps. Plaintext stays on the runner only. Save and restore paths hold only the encrypted files and their MAC, and the arm check asserts it.
    - The `-qa` cache and any future `data-rpc-*` saves are encrypted the same way. Use authenticated encryption, or encrypt-then-MAC, so a tampered cache is refused.

## Round 6 (heads: of2-holds `4fc50e38`, archive-safe-b `40cef3a1`, of3-scanner `b4e62fdd`)

- Builder: rulings 43–48 and 44a are done. test-ci passes 225/226/240, and 15 rows fail on `89f99393`.
- Readings accepted (8 Oct 2026, 9:38 PM):
  - The run list starts at the earlier of now − 35 days and `ARCHIVE_REARM_AT`.
  - gh's support is read from `gh run list --help`, and the version is logged.
  - The cache seal is AES-256-CTR, then HMAC-SHA256 (encrypt-then-MAC). Both keys come from HMAC(`DATA_STORE_TOKEN`, labels). The key id is in the entry name. A wrong key, a changed byte or an extra file is refused, and the day does not start again.
- Accepted risk, with a DECISIONS row: the AES key reaches openssl as a command-line argument. Only processes on the same short-lived runner can see it, and those are the job's own steps.
- Follow-up on the OF-4 row, not this PR: keep-check.sh / data-keep do not refresh sealed `data-rpc` progress entries yet. Helius is not in use (its headroom stays unused), so nothing breaks now.

### Round 6 red team (delta `89f99393..4fc50e38`): 1 MAJOR, 4 MINOR

Closed: checker bypasses, composites and the upload-* actions, the sha cache, branch/tag names, and the fork-PR restore of sealed progress. The seal is sound: a fresh random IV each time, encrypt-then-MAC over version, kid, IV and ciphertext, a constant-time check before decrypt, and no plaintext left in saved paths.

### Supervisor rulings for round 7 (8 Oct 2026, 9:52 PM)

49. **MAJOR, run window.** `from = min(ARCHIVE_REARM_AT, now − 35 d)` still grows past 500 runs about two months after a re-arm. Page the runs API fully (`created>=FROM`, `per_page=100`) instead of capping at 500. Fail closed on an API error, or above a hard limit of 5,000 runs. Test: rearm + 70 days with 600 runs passes; an API error fails closed.
50. **m2.** The MAC header binds the cache key prefix (source and day, e.g. `data-scan-DAY`), and `open` checks it against the prefix being resumed. Test: day A's sealed entry restored under day B's name is refused.
51. **m3.**
    - `data-rpc-assets` is sealed the same way; `ag_permissions_py` drops its exemption.
    - data-keep / keep-check refresh only sealed entries, so the old plaintext entries (including 09-21) expire unused. This matches DECISIONS "drop the cache", and it closes the OF-4 follow-up from round 6.
    - Arm check: list the caches and assert that no unsealed `data-scan-` / `data-rpc-` entry remains. If one is still there at arm time, deleting it goes to the owner.
52. **m4.** Keep the AES key out of argv where the runner allows it: an in-process cipher (python `cryptography`, if present on the runner; VERIFY, print its version), or pass the key through a file descriptor. If neither works without weakening the scheme, the accepted-risk DECISIONS row stays, naming the background-process case.
53. **m5.** Redirect targets must be one of the named log variables (`$qlog`, `$slog`, `$tlog`, `$out-log`), and each one's assignment is checked to be a path under `$RUNNER_TEMP` or `$out`. A scanner binary called through a variable is refused.

### Round 6 reviewer: PASS at `4fc50e38` (1 MINOR)

The reviewer exercised the seal directly: a round trip, a wrong key, a flipped byte, a swapped IV and an extra file. The token appears only in clean steps. A failed open stops before the scan, and the day never starts fresh. The m1 run-window concern is the same one the red team reported as MAJOR 1, and ruling 49 covers it. The arm checklist also moves `ARCHIVE_REARM_AT` to the arm time.
