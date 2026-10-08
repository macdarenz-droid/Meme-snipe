# Supervisor docs PRs: reviews and rulings

Covers the supervisor's own docs PRs (#284, #291, #298, #302, #303 after merge; #305 and later before merge).

## Retro red team on merged PRs (`session_0125Rvnn1TtrYrEa4myEL9gk`, base `1e4df569`, 8 Oct about 11:51 PM): 0 BLOCKER, 8 MAJOR, 10 MINOR

No secrets, IPs, hosts or tailnet names in any of the five diffs. #291 clean (and moot: #295 removed those files). #302 1 MINOR.

### Supervisor rulings (8 Oct 2026, 11:58 PM), applied on `claude/supervisor-docs-3`

1. **#284 MAJOR, `isTransaction`.** Accepted. Re-checked here: `'isTransaction' in new DatabaseSync(':memory:')` is `true` on Node 22.22.0. RESULTS.md row 17, flag 5 and the JSON claim now say Node 22 has it (CI asserts it on 22.23.3).
2. **#298 MAJOR ×3 and MINOR ×4, owner words vs supervisor reading in CLAUDE.md.** Accepted. Marked as the supervisor's reading, procedure, additions, conditions or note: "Parallel work" (the Ultracode line and the "Lean supervisor" narrowing), "Workers run in Auto" (replacement procedure), "Strategy slots" (from SPEC-A A-M09-01 and UI.md), "MR-01 parked" (only "kept on file as a future strategy, switched off" is the owner's), "Phone access" (`/m`, `apps/web`, "a new APK"), "History for the past-data test" (the batch conditions), "Research addendum" (the A05/A17 note).
3. **#298 MINOR, day count.** Rejected as worded: 2026-07-23 to 08-21 is 30 days, not 31 (checked by date arithmetic). CLAUDE.md now says "30 days (2026-07-23 to 08-21, plus the 07-22 lead-in day)". The "31 days" in the DECISIONS A06 Old Faithful row miscounts the same range; that row belongs to the OF chain, so the fix goes to it as `docs/reviews/OF2.md` ruling 54.
4. **#302 MINOR, SPEC-B stale branch wording.** Accepted: the A-45 check is cited as merged with Z02 in #301.
5. **#303 MAJOR, fetch path.** Accepted. CLAUDE.md now says the fetch path is still the owner's choice (STRATEGY-INTAKE section 1) and Z-STRAT proposes one.
6. **#303 MAJOR, #294 merge condition.** Accepted: "reviews, red team and green CI" (#294 had its red team: 0 MAJOR since round 11).
7. **#303 MINOR, STRATEGY-INTAKE open point 7 and the owner-waits row.** Accepted: the location is recorded as answered (Snipe-solana); only the fetch path stays pending.
8. **#303 MINOR, "checked private".** Accepted: re-checked with `list_repos` on 8 Oct (`macdarenz-droid/Snipe-solana`, visibility private); CLAUDE.md names the check.
9. **#303 MINOR, "Lean supervisor" bullets.** Accepted: marked as the supervisor's rule made under the owner's 4:48 PM instruction.
10. **Not covered:** HANDOVER and the review logs were scanned for secrets and hosts only, not line by line. Accepted as a known limit; #305's reviewer covers the current HANDOVER.

## #305 (`claude/supervisor-docs-2` at `cc405609`, base `1e4df569`): reviewer and red team `session_01TmNbs3Nf6q3ysiDMU4LJf5`

Reviewer PASS. Red team PASS: 0 BLOCKER, 0 MAJOR, 3 MINOR. Secret and host scan clean; 96 of 102 shas resolve; no ruling loosens a check.

### Supervisor rulings (9 Oct 2026, about 12:00 AM), applied on `claude/supervisor-docs-3` (not on #305, so its reviewed head stays)

11. **MINOR 1, six shas on no branch.** Accepted: each now names its review log and says the log commit is not on any branch now.
12. **MINOR 2, mixed order.** Accepted: an order note above the 3:12 PM entry.
13. **MINOR 3, REC-UPLOAD-NEWHOST.** Accepted: marked superseded by REC-UPLOAD-QUIET.
