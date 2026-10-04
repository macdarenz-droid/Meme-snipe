# session_012QdDAuRuYt57E9PCjHfuKT: reviewer

## Role, cards, model
- Fresh-context REVIEWER under AGENTS.md and CLAUDE.md, started by supervisor `session_01Bne9GqXR99gJn6D9U2mJFZ`. Model: `claude-opus-5-5` (session record), auto mode.
- Reviews only. I never approved, commented, pushed or merged on GitHub; verdicts went to the supervisor by `send_message`. Risk parts (`packages/core/src/risk/**`) were reviewed by the risk reviewer (017PBU), not me.
- I own no branches or PRs and have no unpushed code. This file is my only commit.

## PRs reviewed: last verdict and its SHA
| PR | Card | Last verdict | SHA |
|---|---|---|---|
| #48 | WORKER-1 | PASS | 83d1144 (base 497ce54) |
| #82 | WORKER-1b | PASS (drop-rpc item) | 48ddb52 |
| #84 | FACTS-1e | PASS | 062ad81 |
| #95 | REC-1 | PASS | a477acb |
| #99 | WORKER-1c item 4 (deployer-check cache, daily cap) | PASS | e4ee960 |
| #101 | POOL-1 | PASS | 813c7fd |
| #106 | FACTS-1f | PASS at 403924e; **merge check at d06ebdb not finished** (below) | 403924e |
| #117 | WORKER-1e (my part, not risk) | PASS | 902040c |
| #123 | WORKER-ORDER | **no verdict sent yet** (below) | under review: b849d9f |

Earlier FAILs (#48 at f679188, 6a9e19d, f55538f, 9fdf837; FACTS-1e at 42786f1; #82 at 28579f5, 3110f48; #95 at 4730074; #99 at fe8b66b) were all fixed by the PASS heads above. I sent no verdict on #118 (01DdN4 has it).

## Work in progress

### #123 WORKER-ORDER at b849d9f (branch `claude/worker-order`)
- b849d9f = 56a8afc + base 5087bd4 (#117). The PR's own patch in `packages/worker/src` and `write-order.test.ts` is byte-identical to 56a8afc's over 3f14e0f (diffed). The only conflict was `worker-harness.ts`, which keeps `s0Diagnostic` and adds `crashPoint`. That resolution is fine.
- `pnpm check` at b849d9f: **started, then stopped at the handover order. Not done.** The supervisor reports 4519 pass. I have not verified that number.
- Mutants at b849d9f, against `write-order.test.ts` + `account-marks.test.ts` (10 tests, base green):
  - Killed: dedupe skip removed (1 fails); journal written after the commit (3 fail); catch-up call removed (1 fails).
  - Also killed at 56a8afc: dedupe key without tokens; `behind()` exit condition removed.
  - **Survived:** `behind()` entry branch removed (a missed entry, ledger committed but `account.json` not, is untested). Also `journaledFills.delete(key)` removed, which is near-equivalent because cumulative tokens never repeat a key for one intent.
- Draft verdict: **FAIL (small)**. Blocking:
  1. `worker.ts #catchUpAccount` values a missed fill at the SOL/USD price after restart (`this.#solPrice`), not at the fill's own rate. PAPER-1 says each cash flow is valued at its own execution rate.
     - Fix: write the SOL/USD price used at booking (`sol_usd`, micro-dollars) on the entry and exit journal lines in `desk.ts #fill`, which is journaled before the ledger commit. Use it in `#catchUpAccount`, and fall back to the current price only when it is absent, with a flag in the reasons.
     - Test: a crash at `fill-committed` with the SOL price moved before restart must book `netPnl` at the fill-time price.
     - Lamports are exact either way; only the USD valuation is off, and only on the crash path.
  2. Add a test for the missed-entry catch-up (a kill after the entry is committed, before the account is written), so the `behind()` entry mutant is killed.
- Answers to the supervisor's questions:
  - The dedupe key (intent + cumulative tokens) cannot swallow a genuine second fill of the same size: two equal partials have different cumulative totals, exit intents differ per exitSeq, and each key is consumed once.
  - A clean run changes no risk numbers: the fill values are the same, `journaledFills` is empty, and only the order changes (journal before ledger).
- Non-blocking notes:
  - `behind()` ignores a missed partial exit. The wallet self-corrects at the position's next fill, because `filled()` recomputes net from the book (`net - t.booked`).
  - When the ledger refuses a fill, the line is already journaled. The book still takes `step.state` and a divergence is raised, which is consistent.

### #106 FACTS-1f merge check at d06ebdb (branch `claude/facts-1f`)
- d06ebdb merges base 5087bd4 into 403924e (my last PASS). Remerge-diff conflicts were in 3 files, all resolved correctly:
  - `strategy.ts`: imports unioned; `stagedHardRejects(..., ...diag)`; the H14 `s0-diagnostic` waived push comes right after the call, before the `hardAllowsEntry` reject.
  - `worker-harness.ts`: has `s0Diagnostic`, `markedHistory` and `strategy?`.
  - `DECISIONS.md`: kept 403924e's REC-1 and POOL-1 text, which is the superset (the backstop and 813c7fd sentences).
- Mutants at d06ebdb, against `worker-1e.test.ts` + `facts-stages.test.ts` (20 tests, base green), all killed: `...diag` dropped from the staged call (2 fail); the H14 waived push removed (2 fail).
- Builder's claim confirmed by reading: every entry decision re-runs all stages from stage 1 in one call at one `ctx.now`.
  - `#evaluate` calls `stagedHardRejects` once, with the `gctx` built per tick from `ctx.now` (strategy.ts:526, 1278).
  - The loop in `stagedHardRejects` (strategy.ts:144) keeps no state between calls, so nothing carries forward.
- "An earlier stage's reject means H14 is never marked waived": this holds, but only trivially, because H14 is in stage 1 (`HARD_STAGE`, hard.ts:637). Only the regime runs before it, and it returns before the push.
- Non-blocking note on the same check:
  - Stage 1 runs with `stopAtFirst: false`. So a reject by a stage-1 sibling (H7, H9, H10, H11) or by any later stage still lists `h14-creates-coverage` on the reject line whenever H14 judged on the short window.
  - In #117 (cost order, stop at first), an H1–H6 reject skipped H14.
  - `runner/src/journal.ts:75` counts `s0_diagnostic` on all decision lines, rejects included, so the `h14-creates-coverage` count will be higher than under #117.
  - This affects only a reporting figure, not entries. Say so in DECISIONS, or count entry lines only.
- `pnpm check` at d06ebdb: **not run (stopped at the handover).** The supervisor reports 4530 pass, unverified by me.
- Draft verdict: PASS pending `pnpm check` exit 0 on d06ebdb.

## Next steps, in order
1. #123: run `pnpm check` on b849d9f (more than 10 min: run it in the background). Send FAIL (small) with the two blocking items above, unless the builder has already added `sol_usd`. On the fix head, re-run the mutants listed above and a fail-before test for the price.
2. #106: run `pnpm check` on d06ebdb (or the current head; evidence counts only for the exact SHA). If exit 0, PASS with the H14 count note.
3. EXIT-ROUTE: queued by the supervisor "later". Not started, and I have no spec for it.

## Findings and numbers
- Test counts I verified myself (`pnpm check` exit 0): 4424 at #106 403924e; 4460 at #117 cb0a219; 4516 at #117 902040c. Earlier counts are in the table's verdict messages.
- No research data. Mutant scripts were throwaway: a python `replace once` on the named line, then `npx vitest run <test files>`. Every mutant's pattern and result is above.

## Rulings received
- Reviewer only: do not approve, comment, push or merge on GitHub. The worker is paper only.
- #118 is not mine (01DdN4 has it). My queue: #123, then #106's merge check, then EXIT-ROUTE.

## Open risks and gaps
- #123: the crash-path USD valuation (blocking item 1) and the missing missed-entry test (item 2).
- #106: the semantics of the H14 waived count on reject lines (non-blocking).
- Neither head has my own `pnpm check` result.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` in a worktree of the SHA.
- `npx vitest run packages/worker/test/write-order.test.ts packages/worker/test/account-marks.test.ts` (#123).
- `npx vitest run packages/worker/test/worker-1e.test.ts packages/worker/test/facts-stages.test.ts` (#106).
- `git show --remerge-diff <merge sha>` shows how each conflict was resolved.

## Remaining time
About 1–1.5 h: about 25 min per full `pnpm check` (×2), plus re-reviewing #123's fix (about 20 min). EXIT-ROUTE is unknown until it is specified.
