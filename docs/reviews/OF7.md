# OF-7 records and the B10-PULL pin: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-7 bullet. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`. PR #318 (draft, stacked on OF-6 #317), branch `claude/of7-records`. Reviewer `session_01DK9TU4gHh9V1Accrv4yuPY`, red team `session_01Uoe1pFxvHNzq9yCieDicqQ`.

## Round 1 (head `c0ea5b17`, diffed against `396e28f4`)

- Builder: DECISIONS row `B10-PULL id=b10pull-of-1 source=old-faithful scannerRev=1b569029…-go1.24.7 days=2026-07-22..2026-08-21 pinnedAt=2026-10-09T02:09:34Z`; test-ci 283/0. It re-pins on every scanner change (its test forces it).
- Red team: PASS, 0 BLOCKER, 0 MAJOR, 2 MINOR. The row arms nothing (`ARCHIVE_ARM` empty; zero or two rows fail closed); the changed OF-2 test still catches an early arm; the Go version matches `GO_VERSION`.

### Supervisor rulings (9 Oct about 1:50 PM; the reviewer's verdict is folded in when it arrives)

1. **Red team m1, required.** In a git checkout the pin check requires a non-empty scanner tree hash and fails otherwise.
2. **Red team m2, required.** A runtime check: the guard's attest step (or scan-day) refuses when `$SCANNER_REVISION` is not the pinned row's `scannerRev=<tree>-go<ver>`. Branch protection is not on yet (an owner step), so review-time tests alone do not cover every merge path. Test it.
- Reviewer (round 1): PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR, the same as red team m1 (ruling 1). The row matches the card; the changed OF-2 test is stricter (adds `! ag_armed`); `ARCHIVE_ARM` is empty. Arming is now a one-line change (`ARCHIVE_ARM=b10pull-of-1`); it stays a reviewed step taken only with the owner's arm-time steps (CLAUDE.md "Pause after the current tasks").

## Round 2 (head `5931f1eb`, re-pinned `scannerRev=e684544b…-go1.24.7`)

- Red team: PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR. m1 and m2 closed: the tree hash must be 40 hex digits; scan-day refuses any `SCANNER_REVISION` other than the pinned row before any read, and no archive scan path skips it.
3. **Red team MINOR (scan-day compares the environment value, not the binary's own revision), declined (9 Oct about 3:20 PM).** No step can rewrite `GITHUB_ENV` or `GITHUB_PATH` between the build and the scan, and every workflow change is reviewed and red-teamed. Possible later hardening: a `zeroed-scan revision` check.
- Reviewer (round 2): PASS, 0/0/0. The re-pin equals the scanner tree at `5931f1eb`; rulings 1–2 met. **#318 approved at `5931f1eb`.**
- Merge plan (9 Oct about 3:55 PM): #318 contains #317 and base `d01875dc`, so #318 merges alone and GitHub marks #317 merged. The supervisor read the guarded diff (data-scan.yml +27/−1: the margin step in the clean `env -i` shell, the `reread_id` input passed to the scan and the chained dispatch); nothing loosened. #318 retargeted to the base, marked ready, label `deps-reviewed:78e14f7f6f55669121708725b85d8605` added after the head (04:54 UTC).

## Merged (9 Oct 2026, 4:23 PM)

**#318 merged at `fc38d3f7`** (the new base), carrying OF-6; GitHub marked **#317 merged**. Labelled CI green on `5931f1eb`. OF-1 to OF-7 are all merged; `ARCHIVE_ARM` stays empty. Last piece before any arm: OF6.md ruling 12 (the `-k3` producer for 07-22 and 07-23), with the data builder on `claude/of3-k3-producer`.
