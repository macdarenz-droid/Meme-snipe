# Handover: session_01DdN4xy9WX2t7nLUq7ww4E5 (reviewer)

Written 2026-10-04 19:15 AEDT, on the owner's handover order.

## Role, cards and model
- Role: a fresh-context **reviewer**, started by the supervisor `session_01Bne9GqXR99gJn6D9U2mJFZ`.
- How a task runs:
  - A task arrives as a cross-session message naming a PR head SHA and a spec.
  - The reviewer checks it out, reads the diff, runs mutants and probes, and runs one `pnpm check`. Only one at a time: two in parallel ran out of memory on this box (SIGKILL in research.test.ts), before MEM-1 fixed the cause.
  - The verdict, PASS or FAIL with blocking items first, goes back by message.
- Never pushed, commented, approved or merged on GitHub. Reviews only.
- Model: by environment policy, no model identifier is written into the repo. The session record shows it, and the supervisor has it from the reply.
- Own branches and PRs: none. This notes file is my only commit.

## PRs reviewed: last verdict and open findings
| PR | Card | Last verdict SHA | Verdict | Open findings |
|---|---|---|---|---|
| #116 | CI-1b (builder session_01VgCLpHWaM7FjpwofRcgrwM) | c5aaf88 | PASS (wording and import merge only; full suite not re-run on c5aaf88, builder reports 4520; I ran typecheck plus ci1 and worker-flow, 42/42) | Non-blocking: WORKER-ORDER appears only in docs/ARCHITECTURE.md §12.4 and must be put on the board and in HANDOVER. Non-blocking: the memory guard in research.test.ts reads vitest.config.ts, so a command-line `--no-isolate` would escape it (CI does not pass it). |
| #118 | API-1 (builder session_01VM97q6A98GgtoPKCamoiT6) | 32c14d9 | PASS (`pnpm check` 153 files, 4603 tests) | **OPEN: a delta review is still due** after the builder pushes the "regime waived" card field, the base merge and the #126 e2e fix. Non-blocking: the per-entry daily-loss room (today's loss plus this trade's costs ≥ the limit) can refuse every candidate while the card reads "Entries: On". Non-blocking: "Exits: Ready" means a simulated exit in paper and needs its own condition for live. |
| #112 | MEM-1 | 1174a2b | PASS (4383 tests) | Mirror gap, later fixed by #116 (openedSince). Merged. |
| Earlier | RUN-1 series, WORKER, APP-3, #83, #105 and others (before this session's context was compacted) | see the PR threads and the supervisor's HANDOVER | as recorded by the supervisor | none known open from me |

### #118 history (for the next reviewer)
- **7433148 FAIL:**
  - (1) "Entries: On" was shown while a risk stop (daily or weekly loss, the kill latch) refused every entry;
  - (2) the app accepted `notRunning` for paper.
- **ca0648c FAIL:** "On" was still possible in two cases:
  - evaluateExit swallows an accountCheck throw and returns `tripped: []`;
  - #readStops marked with `fallback: true`, while the entry path uses `fallback: false`.
- **32c14d9 PASS:** fixed with `riskSnapshot` null giving unknown, and marking without fallback. Each fix was checked by a mutant.

### #116 history
- **82c49a1 PASS:** openedSince, the memory guard.
- **20e8d5f FAIL:** §12.4 claimed the exit write order for every worker, but the real worker is ledger-first (desk.ts `#write` calls recordBookEvent, then `#fills` journals).
- **c5aaf88 PASS:** the wording now states the real worker's exception, tracked as WORKER-ORDER.

## Done
- Reviews only. The verdicts above, each with mutants that fail before the fix and pass after.

## Work in progress
- None of mine. My review queue at the stop: the #118 delta (waived-regime field, base merge, #126 e2e fix), not started.

## Next steps (in order)
1. Review the #118 delta at its new head:
   - check that a waived regime can never make "Entries: On" show while core refuses entries;
   - run the wording guard on the new label;
   - check that the base merge changes no logic;
   - run one `pnpm check`.
2. Make sure WORKER-ORDER is on the board: the real worker's exit journal line must come before the ledger close, with a kill-between test (see §12.4).

## Findings and numbers
- MEM-1:
  - research.test.ts peak RSS is about 0.55 GB with the shared Melbourne-day formatter, against a bound of 1024 MB;
  - with the fix reverted it reproduced at 5564.7 MB;
  - the formatter output was identical over 23,040 timestamps around the DST changes.
  - All measured with `process.resourceUsage().maxRSS` in the test.
- Full-suite counts on the SHAs I ran:

  | SHA | Files | Tests |
  |---|---|---|
  | 82c49a1 | 146 | 4445 |
  | 7433148 | 148 | 4495 |
  | ca0648c | 153 | 4599 |
  | 20e8d5f | 150 | 4495 |
  | 32c14d9 | 153 | 4603 |

  All green.

## Rulings received
- Run a single full suite at a time (supervisor).
- Never push, comment or approve on GitHub; report by message (supervisor).

## Open risks and gaps
- WORKER-ORDER: a kill between the real worker's ledger close and its exit journal line makes a restart drill fail falsely (it never passes one).
- evaluateExit in core/risk returns "nothing tripped" on an internal throw. Any new caller that uses it for status must check `riskSnapshot` first, as #118 does.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` (one at a time).
- Focused tests:
  - `npx vitest run packages/runner/test/ci1.test.ts`
  - `npx vitest run packages/worker/test/status-stops.test.ts apps/web/test/not-running.test.ts apps/web/test/status-card.test.ts`

## Remaining time
- The #118 delta: about 15 to 25 min of review once it is pushed (uncertain: its size is not known yet).
