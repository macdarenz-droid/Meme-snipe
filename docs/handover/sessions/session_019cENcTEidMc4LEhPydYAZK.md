# Handover: session_019cENcTEidMc4LEhPydYAZK (builder)

## Role, cards, model
- Builder. Took cards from the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). Never wrote to the owner.
- Cards: FACTS-1d (done), WORKER-1c (done), the RISK-MARK follow-up on #99 (done), the #99 port-clash fix (done), WORKER-ORDER (PR open), WORKER-1d (assigned, not started).
- Model: claude-opus-5-5, the session's default effort.

## PRs and branches
| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #78 FACTS-1d | claude/facts-1d | - | merged as 45abc25 | passed (supervisor) |
| #99 WORKER-1c | claude/worker-1c | 1ef7fed (my last push; the remote is now 0e6385d, a supervisor update) | merged as d92b73ed ("change identical to 1ef7fed") | items 2–4 passed earlier; item 1 passed at 7fe7030 (01NZwy); base merges checked by 01NZwy; RISK-MARK delta at 2fc1fd1: risk PASS (017PBU), worker verified (01NZwy); port fix at 1ef7fed |
| #123 WORKER-ORDER | claude/worker-order | b849d9f | open, draft, not reviewed yet (reviewer 012QdD) | none yet |
| - | claude/worker-1d | a7f6cef (old) | unused | the supervisor said to leave it alone; WORKER-1d starts fresh from the base |

## Done
- FACTS-1d: regime volume rule and live volume-hours reader (`packages/worker/src/facts/volume-hours.ts`, `packages/core/src/gates` regime volume). Merged.
- WORKER-1c (#99, merged):
  - PERSIST-1 in the worker: `persist/state.ts`, `run/worker.ts` `#persist`, the restore travelling in the `worker:seed` fact, fill budget `fill-budget.json`.
  - /health `open_positions`: `run/open-positions.ts`, with the universe taken from `#positionsWithUniverse`.
  - Day and week loss is the stricter of realized and marked (`core/src/risk/evaluate.ts`).
  - Boundary marks and NAV peak: `run/account.ts` `mark`, worker `#markAccount`. They come from the marked account (marks.ts `riskAccount`, fallback) and are recorded only when every mark is fresh.
  - Deployer check cache and daily cap: `facts/deployer-checks.ts`.
  - `strategy.markOf` renamed `displayQuoteOf`.
  - Tests: `persist-worker`, `account-marks`, `boundary-marks`, `open-positions`, `deployer-check`.
  - DECISIONS section "Worker follow-ups (WORKER-1c …)".
- Test port clashes: `persist-worker.test.ts` and `facts-source.test.ts` now use the harness's per-pool ports, 21000 and up (in #99).

## Work in progress
- #123 WORKER-ORDER at b849d9f. It is complete and green (`pnpm check`: 154 files, 4519 tests on b849d9f, base 5087bd4 merged in) and waits for 012QdD's review.
  - `run/desk.ts` `#write`: journals the fill line (built from the pure `applyBookEvent` step) before `ledger.recordBookEvent`.
  - `journaledFillKeys`: skips a fill line the journal already holds, for a restart that books the same fill again.
  - `PaperAccount.behind`, plus worker `#catchUpAccount`: fills the ledger holds but account.json missed are recorded at the first SOL price.
  - `crashPoint` test seam.
  - Tests in `packages/worker/test/write-order.test.ts`.
- Nothing half-done. No uncommitted work.

## Next steps, in order
1. #123: answer 012QdD's review. Merge `origin/ccr-14987baf-i6lrsl` with a merge commit if the base moves, then run `pnpm check`. Link to #116 (§12.4 wording) is in the PR body.
2. WORKER-1d, coverage pruning. The card, verbatim, from the supervisor:
   - "Prune coverage facts older than the look-back, keeping one start at or before the retain point. Bound growth across restarts. Tests: 50 simulated restarts keep the file size bounded; coverage inside the look-back is unchanged, including restart gaps; a replay still rebuilds the same state. Draft PR; tell me the SHA."
   - Branch `claude/worker-1d`, fresh from the latest base.
   - Root cause (01NZwy's note): `strategy.persistable()` saves `#coverageFacts` unpruned. Each restart re-wraps the saved facts in the seed history with a new `#pre<k>` suffix plus a restart gap per via (`run/worker.ts`: the seed history built from `[...saved.coverage, ...result.coverage, ...extra]`). So the file and the seed history grow with every restart.
   - Planned approach:
     - in `persistable(retainFromMs)`, drop coverage facts with `moment.receivedAt < retainFromMs`, except the latest `start` per stream and via at or before that point;
     - keep every gap, resume and restart gap inside the look-back;
     - do not stack `#pre` suffixes: wrap with the original id.

## Findings and results
- WORKER-ORDER race, confirmed by test (`write-order.test.ts`, crash image of the state dir between the two writes):
  - With the ledger written first, the runner's `recoveredState` reports "not recovered: exit p:…, position p:…", the CI-1b symptom. With the line first it passes.
  - The reverse case (line written, ledger not) recovers: the paper world saves a landing before it reports it. One fill, one exit line.
  - account.json behind the ledger: confirmed. Before the fix the trade stays open forever. Now it is caught up.
  - Mutants: 3 of 3 killed.
- RISK-MARK measures: risk caps each mark at its notional, so with no flows the realized day loss (the whole open loss since entry) is always at least the marked one. The marked measure alone cannot trip `daily_loss` at trial sizes: its maximum here is about the position's mark, about $1.39, under the $1.50 limit. Shown in `boundary-marks.test.ts` test 3, recorded in DECISIONS.
- Port clashes: persist-worker used 18860/18861, also used by market-inputs. facts-source used 18900/18901, also used by fault-injection. Two `pnpm check` runs green after the fix: 150 files, 4486 tests.
- Known base flakes seen earlier: the runner.test tabletop test (CI-1, #105) and worker-flow. Not mine.

## Rulings received
- `deployer-state.json` and `fill-budget.json` are bot state, approved by the supervisor.
- Deployer-check credits: 5,000 a day.
- `markOf`: renamed (first `saleQuoteOf`, then `displayQuoteOf` per review N3). I kept it from being called "spot" because it is a sale quote after price impact.
- A guard that is "equivalent" is still a guard: never remove one (the `#lastMoment` max guard was restored).
- RISK-MARK spec (01NrMe): (a)–(e), all done.
- WORKER-ORDER: option (a), line before the ledger commit.

## Open risks and gaps
- A fill booked at a start reconcile before any SOL price is valued as a loss of its notional (existing behaviour, the safe side). Not changed.
- WORKER-1d is not started, so the saved coverage still grows with every restart.
- `claude/worker-1d` (a7f6cef) is stale. The supervisor will clean up branches.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- Focused: `cd packages/worker && npx vitest run test/write-order.test.ts test/boundary-marks.test.ts test/account-marks.test.ts test/persist-worker.test.ts`

## Remaining time
- #123 review fixes: 0.5–2 h, depending on findings.
- WORKER-1d: 2–4 h including tests and mutation checks.
- Uncertainty: about ±50%.
