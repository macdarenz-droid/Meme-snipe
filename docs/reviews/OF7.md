# OF-7 records and the B10-PULL pin: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-7 bullet. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`. PR #318 (draft, stacked on OF-6 #317), branch `claude/of7-records`. Reviewer `session_01DK9TU4gHh9V1Accrv4yuPY`, red team `session_01Uoe1pFxvHNzq9yCieDicqQ`.

## Round 1 (head `c0ea5b17`, diffed against `396e28f4`)

- Builder: DECISIONS row `B10-PULL id=b10pull-of-1 source=old-faithful scannerRev=1b569029…-go1.24.7 days=2026-07-22..2026-08-21 pinnedAt=2026-10-09T02:09:34Z`; test-ci 283/0. It re-pins on every scanner change (its test forces it).
- Red team: PASS, 0 BLOCKER, 0 MAJOR, 2 MINOR. The row arms nothing (`ARCHIVE_ARM` empty; zero or two rows fail closed); the changed OF-2 test still catches an early arm; the Go version matches `GO_VERSION`.

### Supervisor rulings (9 Oct about 1:50 PM; the reviewer's verdict is folded in when it arrives)

1. **Red team m1, required.** In a git checkout the pin check requires a non-empty scanner tree hash and fails otherwise.
2. **Red team m2, required.** A runtime check: the guard's attest step (or scan-day) refuses when `$SCANNER_REVISION` is not the pinned row's `scannerRev=<tree>-go<ver>`. Branch protection is not on yet (an owner step), so review-time tests alone do not cover every merge path. Test it.
