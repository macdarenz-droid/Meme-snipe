# Reviewer session session_01NZwyB8decLbgxKJoG2cAbP

## Role, cards, model
- Fresh-context reviewer for the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). No builds and no branches of my own; I never pushed code, approved, commented on or merged anything on GitHub.
- Method for every review: diff against spec, tests fail on old code and pass on head, my own mutants (temporary, always reverted), and `pnpm check` (run in the background, since it takes over 600 s).
- Model: claude-opus-5-5 as configured (serving model not separately verified).

## PRs reviewed (verdicts in order, with SHA)
| PR | Card | Verdicts |
|---|---|---|
| #45 | SEED-1 | FAIL 3857e91, FAIL a3fc28d, FAIL 92cdd97, FAIL 809c5ee, FAIL ae6505d, FAIL da5a65d, **PASS 745fa46** |
| #70 | FILL-2 | FAIL 6b6ab12, **PASS 77fa5f9** |
| #71 | PERSIST-1 | FAIL b0fe47d, PASS 76df453, FAIL 53acae8, **PASS d716798** |
| #85 | worker-1-flake | FAIL 998a01b, **PASS af44410** |
| #90 | TEST-1 | FAIL cd187c0, PASS ed282e3, **PASS af6b9b5** |
| #104 | CI-2 | **PASS ddf8969** |
| #99 | WORKER-1c / RISK-MARK | PASS a7f6cef (interim), PASS 7fe7030, merge PASS 66a534f, merge PASS 3d53e94, FAIL 2fc1fd1 (port clash), **no objection at 0e6385d** (fix 1ef7fed) |
| #125 | PERSIST-2 | **Interim only at af82601, no verdict yet** (see below) |

Every PR above except #125 is closed out from my side, with no open findings.

## Work in progress: #125 PERSIST-2
- State: reviewed at af82601. At handover the PR head is still af82601 and does **not** contain base 5087bd4 (#117). The supervisor asked for PASS/FAIL only on the head after that base merge.
- Already verified at af82601:
  - As-of honesty in save, load and producer. Mutants caught: late migration, asOf mismatch, duplicate mint, no load check.
  - No half-apply. Mutant `continue` instead of `return` on a disagreeing mint: caught.
  - Replay parity: the seed is an off-chain `read:graduates-seed` frame at `startAt`, ahead of the halt fact at `startAt + 1`.
  - Old files without `graduates` still load.
- Open findings, sent to the supervisor as interim:
  1. (Non-blocking test gap) The splice in `packages/core/src/facts/producer.ts` `#resolve`, where a live measurement replaces a seeded entry for the same mint, has no test, and its mutant survives. Without it the mint counts twice in the survival share. Add a test in which a seeded mint is later measured live.
  2. (Non-blocking) A refused seed is silent: `#seedGraduates` just returns. Journal it ("graduates seed refused: <reason>").
  3. (Follow-up card, now PERSIST-3) The reset list says deployerSales and flow restart from zero on a restore. That is not fail-safe for a held position's exits. Example: the deployer sold 40% before the restart against a 50% threshold, then 40% after it, and `deployer_sell` never fires. Persist them with the exits file, or flag the position for a conservative exit. Also consider a minimum sample count per day for the survival median.

## Next steps (for the reviewer who takes over)
1. `git fetch origin +refs/pull/125/head:refs/remotes/pr125`, then confirm that `git merge-base --is-ancestor 5087bd4 pr125` succeeds.
2. Diff the merge against af82601 and 5087bd4. Check that `packages/core/src/gates/regime.ts` keeps both #117's changes and the `survival` → exported `survivalCondition` rename, and that `packages/worker/src/engine/strategy.ts` keeps #117's changes plus `persistable().graduates` and the `#graduatesFact` update on GRADUATES_KEY.
3. Re-run the mutants: producer `return`→`continue`, drop the `asOfMs > at` check, drop the mark filter, drop the splice; state.ts `graduatesProblem` checks; and no load check.
4. Check that finding 1 has a test that fails without the splice; if finding 2 was done, check the journal line.
5. Run `pnpm check` in the background (over 600 s) and send PASS/FAIL with the SHA to the supervisor.

## Findings worth keeping (reviewer lessons)
- Ids that happen to sort favourably in tests hide tie-ordering guards (#70, SEED-1). Use ids that sort against the expected order.
- `continuing` must not suppress restart gaps (#71).
- A parity check must fail on a missing recording, on redactions and on `ledger_refused` (#90).
- Fixed test ports must never be shared across test files, because vitest runs files in parallel processes. The harness default is 21000 + pool·200. In #99 at 2fc1fd1, persist-worker.test.ts and market-inputs.test.ts both used 18860/18861: 1 failed and 4468 passed in the full suite, while the test passed alone 3 of 3 times.
- RPC pagination: an empty page before `afterSlot` must not count as "done" (#45). It falsely claimed coverage on a pruned node.

## Rulings received
- Review only. Do not approve, comment, push or merge on GitHub. Reviewers never write to the owner.
- The #125 verdict must be given on the head that contains #117 (5087bd4).

## Open risks and gaps
- #125 has no final verdict. The regime.ts/strategy.ts conflict resolution is unreviewed.
- PERSIST-3 (persisting deployerSales/flow) is unbuilt, so held-position exits are weaker after every restart until it lands.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` (run it in the background).
- Single file: `pnpm -C packages/<pkg> exec vitest run test/<file>`.

## Remaining time
- About 30–60 min of review for #125 once the merged head exists. This is uncertain and depends on the size of the conflict resolution and on the full suite (about 10–15 min).
