# Handover: FACTS-1 builder (session_01GDycboQzFrFWxVniy6B6Ps)

## Role, cards, model
- **Role:** builder, reporting to the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). The usual reviewer was 012QdD (session_012QdDAuRuYt57E9PCjHfuKT).
- **Cards:** FACTS-1, 1b, 1c, 1e, 1f; TEST-1; REC-1; POOL-1. FACTS-1d was built by another session; my duplicate was discarded.
- **Model:** configured as claude-opus-5-5, at the session's default effort.

## PRs and branches
| PR | Branch | Head | State | Verdicts |
|---|---|---|---|---|
| #54 FACTS-1 | claude/facts-1 | merged (1faac04) | merged | passed before merge |
| #75 FACTS-1b | claude/facts-1b | merged (9166874) | merged | passed |
| #68 FACTS-1c | claude/facts-1c | merged (2cdfa42) | merged | passed |
| #84 FACTS-1e | claude/facts-1e | merged (565a195) | merged | passed |
| #101 POOL-1 | claude/pool-1 | merged (e7a1fdf) | merged | passed; its two follow-ups were done in #106 |
| #95 REC-1 | claude/rec-1 | merged (50ec66d) | merged | PASS at a477acb (012QdD) |
| #90 TEST-1 | claude/test-1 | merged (4e8be04) | merged | PASS at af6b9b5; later merges only |
| **#106 FACTS-1f** | **claude/facts-1f** | **d06ebdb** | **open, ready** | PASS at 76ab960, merge check PASS at 403924e (012QdD). **d06ebdb (merged with base 5087bd4, #117) has had no merge check yet.** |

Nothing is unpushed. My local branches are all at or behind their origin heads.

## What is done (#106, still open)
All in `packages/worker/src/engine/strategy.ts`:
- **`stagedHardRejects`.** Runs GATE-2's stages in BT-2's three groups: stage 1, then stage 2, then stages 3 and 4 together (`HARD_STAGE_GROUPS`).
  - Every gate inside a group is evaluated (`stopAtFirst: false`).
  - It stops at the first group that rejects. The gates after it are named as `not evaluated: H…` (`NOT_EVALUATED`).
- **`hardAllowsEntry`.** GATE-2's entry rule: `complete` against core's `HARD_GATES`, and no reasons.
  - A pass with no reasons that left a gate out is logged as `hard rejects incomplete`.
- **WORKER-1e note handling is kept.** The staged call gets `...diag`, and the `s0-diagnostic` note still marks `h14-creates-coverage` as waived.
- **REC-1 backstop.** `#entries` keeps `if (now >= to) continue;`.
- **POOL-1 follow-ups:**
  - `RpcStream.onServed` (`providers/solana-ws.ts`) makes PoolWatch (`run/pool-watch.ts`) forget a pool's retry wait.
  - The loop in the refused-retry test is bounded.
- **Tests:**
  - `packages/worker/test/facts-stages.test.ts`;
  - `packages/worker/test/rec-same-event.test.ts`;
  - `streams.test.ts`: the served-again test.
  - `fault-injection.test.ts`: the TEST-3 rate-limit reject text now carries the exact staged suffix `; not evaluated: H12,H13,H15`.
- **Test harness.** `makeWorker` in `packages/worker/test/worker-harness.ts` takes `strategy?: Partial<StrategyConfig>`.
- **Docs.** `docs/DECISIONS.md` has FACTS-1f in the FACTS-1 section, and REC-1 and POOL-1 lines in the WORKER-1 section.

Earlier cards, all merged (see DECISIONS for each):
- **FACTS-1b:** live fact staging (`facts/source.ts` LiveFacts, `readsFor`, `candidates()`).
- **FACTS-1c:** holder scan.
- **FACTS-1e:** re-evaluation when a read lands (`#readLanded`, `#landedFresh`).
- **TEST-1:** parity harness (`run/parity.ts`, `scripts/parity.ts`).
- **REC-1:** tails for rejected candidates (`#tail`, `#windowEnds`, `maxTails`).
- **POOL-1:** dropped watches are watched again.

## Work in progress
None. #106 is complete and is waiting for 012QdD's merge check at d06ebdb, then the supervisor's merge.

## Next steps
1. 012QdD does the merge check on #106 at d06ebdb. The conflicts and how each was resolved are in the supervisor message of 18:58 Melbourne:
   - strategy.ts imports: base order, with the FACTS-1f imports added;
   - `#evaluate`: staged call with `...diag`, then the s0 waived push, then `hardAllowsEntry`;
   - worker-harness: base options plus `strategy?`;
   - DECISIONS: #106's REC-1 and POOL-1 lines plus the base's WORKER-1c section.
2. If the base moves before #106 merges:
   - merge `origin/ccr-14987baf-i6lrsl` with a merge commit;
   - keep `hardAllowsEntry`, the backstop and the same-event test;
   - run `pnpm check`, plus facts-stages, worker-1e, rec-same-event and fault-injection;
   - push, and send the SHA to the supervisor.
3. BT-2 (01VBTf) mirrors B2: one complete authorisation at one decision time (see Rulings).
4. Optional, from earlier: TEST-1's `loadSession` could cross-check the manifest seed once the recorder records it.

## Findings and numbers
- **Pre-existing CI timing failures** in the runner drill tests: `packages/runner/test/runner.test.ts:138` and `run1f.test.ts:99`.
  - Seen on #90 at af6b9b5 (run 37170685851) and on #106 at d79e9db (run 37174504068).
  - The other run on each of those commits passed.
  - Tracked as CI-1 with the RUN builder. I commented on both PRs.
- **REC-1 tail cost.** About 2.2 Helius credits a minute per busy tail, so up to about 265 credits over 120 minutes.
  - Method: the budget's planning figure of 60 swaps a minute at 1.84 KB each, at 2 credits per 0.1 MB. This is a planning estimate, not a measurement.
- **`pnpm check` on #106 at d06ebdb:** 4530/4530, about 10 minutes locally.

## Rulings and decisions
- **GATE-2 entry rule (supervisor).** An entry needs `complete && reasons.length === 0`. The guard stays even though the current groups cannot reach it, because it catches any future change to the groups.
- **REC-1 hardening (supervisor).** A `now >= to` backstop in `#entries`, plus a same-event test. The test must fail only when the backstop is removed and the passes are swapped together.
- **B2 (audit).** Staged reads build up over several evaluations, but every entry decision re-runs all stages from stage 1 in one call, at one `ctx.now`. Nothing that passed earlier is carried forward. This is stated in #106's body.
- **Merge order (supervisor).** #106 merges after #99, #113, #110 and #117. #117 is merged.

## Open risks and gaps
- **H14 waiver.** When an earlier stage rejects, H14 is not evaluated, so the s0 diagnostic does not record `h14-creates-coverage` as waived for that decision. That is intended (a gate that was not evaluated was not waived), but anyone reading the waiver counts should know it.
- **Runner drill timing (CI-1).** These failures can turn a CI run red without the PR being at fault.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- `npx vitest run packages/worker/test/facts-stages.test.ts packages/worker/test/rec-same-event.test.ts packages/worker/test/worker-1e.test.ts packages/worker/test/fault-injection.test.ts packages/worker/test/streams.test.ts`

## Remaining time
- My cards: 0, apart from the #106 merge.
- A further base merge, if needed: about 15–25 minutes, including a 10-minute check. Uncertainty is moderate: it depends on what lands in `strategy.ts`.
