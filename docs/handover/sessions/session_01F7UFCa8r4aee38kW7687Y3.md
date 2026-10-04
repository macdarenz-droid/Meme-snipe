# Handover: session_01F7UFCa8r4aee38kW7687Y3 (WORKER-1, builder)

Written 2026-10-04, about 19:20 AEDT. Supervisor: session_01Bne9GqXR99gJn6D9U2mJFZ. Base branch: `ccr-14987baf-i6lrsl`.

## Role, cards, model
- **Role:** builder WORKER-1 (the live paper worker).
- **Cards this session:** WORKER-1e (audit, then build), PERSIST-2, EXIT-ROUTE, PERSIST-3.
- **Earlier cards:** WORKER-1 to 1c (PR #48 and others). The supervisor's HANDOVER covers those.
- **Model:** `claude-opus-5-5`, the session default.
- **Standing rules:**
  - paper mode only;
  - no key and no sent transaction;
  - never raise a limit or remove a stop;
  - never remove a guard, even a redundant one (supervisor ruling).

## PRs and branches
| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #117 WORKER-1e | `claude/worker-1e` | 902040c (merged as 5087bd4) | **merged** | 017PBU risk PASS, 8/8 mutants; 012QdD facts PASS at cb0a219; delta at 84cce73; merged after the supervisor's base merge 902040c |
| #125 PERSIST-2 | `claude/persist-2` | 4322300 | open (draft) | 01NZwy interim notes on af82601, both addressed in 4322300; no verdict yet |
| #130 EXIT-ROUTE | `claude/exit-route` | 8a6a71e | open (draft) | not reviewed yet (reviewer 012QdD) |
| #131 PERSIST-3 | `claude/persist-3` | 561ee38 | open (draft) | not reviewed yet (reviewer 01NZwy) |

All four branches are pushed at the heads above. There are no uncommitted changes.

## Done

### #117 WORKER-1e (merged)
- **H15 live:**
  - `packages/worker/src/run/sim-read.ts` runs SIM-1's `RoundTripSimulator` at P2, using the first `ZEROED_STANDINS` address, and never sends.
  - It runs at the spend the candidate was judged at (`Candidate.spend`), at most 120 times in any rolling hour.
  - LiveFacts' `sim` read kind feeds it (`facts/source.ts`); the answer goes onto the feed as `read:sim:<mint>`.
  - Each attempt is journaled as `h15_sim`, and the runner report counts them (`H15 simulations: N run of M, C Helius credits`).
- **S0 diagnostic set** (`ZEROED_S0_DIAGNOSTIC=on`, S0 only, refused in any release that names a qualifying run). Four parts: `regime-volume`, `regime-survival`, `exec-health`, `h14-creates-coverage`.
  - Code: `core/src/gates/regime.ts`, `hard.ts`.
  - Each part is named on the decision lines it affected (rejects, `enter`, `mark_eligible`, `approve_risk`), on the `start` line, in `/health` and in the runner report.
  - The reject dedupe key includes the waived set.
- **Paper exec-health:** `PaperWorld.execStats`, published every 10 s, measured and never judged.
- **Exit flow** from held-pool swaps: `strategy.#addFlow`. The open-minute guard is in both `closedFlow` and EXIT-1's `negativeRun`.

### #125 PERSIST-2
- The graduates series is saved in the PERSIST-1 state (`persist/state.ts`, optional `graduates`, `STATE_VERSION` still 1).
- It is restored as a recorded raw read, `read:graduates-seed` (`core/src/facts/raw.ts`, `producer.#seedGraduates`).
- As-of checks: a seed dated after its release is refused, and an entry counts only once its mark ≤ the seed's as-of time.
- A seed that disagrees with what's known is refused whole. A live measurement replaces a seeded entry.
- The outcome of every seed is journaled (`graduates_seed`), shown in `/health` and alerted on refusal.
- `source: 'data-1'` uses the same shape, but its day-file loader is not built.
- `docs/DECISIONS.md` "Graduates across restarts" lists every input a restart still resets.

### #130 EXIT-ROUTE
- `sellRouteOf` in `engine/strategy.ts` reads the route from the held pool's own quote:
  - `ok` when the pool quotes the full sale;
  - `missing` on a market refusal: no-liquidity, exceeds-reserves, zero-output or unsupported-coin;
  - unknown (null) otherwise, never `ok`.
- There is no Jupiter call.
- Tests in `packages/worker/test/exit-route.test.ts` go producer to exit:
  - a drained vault fires `no_route`;
  - a quiet pool never fires it;
  - #117's flow, from real swap logs, fires `negative_flow`.

### #131 PERSIST-3
- `SavedExit` gains `deployer`, `deployerSales` and `flow`, with as-of rules on both save and restore.
- Missing or malformed fields flatten the position, logged as `sell-only` with the reason.
- Tests: `packages/worker/test/persist-3.test.ts`.

## Work in progress
- **#125:** the full suite on 4322300 was running when the handover order came (log `scratchpad/p2b.log`, not kept). The previous full run, on af82601, passed: 150 files, 4,499 tests. The changes since then are tested by their own focused tests, which pass, and typecheck is clean.
- **#131:** typecheck is clean and its 4 tests pass, but the full suite has not been run on 561ee38.
- Nothing else is half-done.

## Next steps, in order
1. Run the full suite on #125 (4322300) and #131 (561ee38): `npx vitest run --maxWorkers=2` from the repo root. Post the result on each PR.
2. Ask the reviewers: 01NZwy for #125 (verdict on 4322300) and #131; 012QdD for #130.
3. Merge the base into each PR as other PRs land.
   - #125 and #130 both touch `engine/strategy.ts` and `core/src/gates/regime.ts`.
   - #131 touches `strategy.ts` (SavedExit, restore, `#deployerOf`).
   - Expect small conflicts, and keep both sides.
4. Supervisor's non-blocking ask: propose a minimum number of graduates per day for the survival median. My proposal is 30 a day, treating a day with fewer as unknown. Reason: with n = 30 the standard error of a survival share near 0.5 is about 0.09, which is already wide against a median compared across 14 days, and n = 20 gives about 0.11. This is not implemented; check the measured daily graduation counts before choosing.
5. Then the owner-side open items below.

## Findings and numbers
- **WORKER-1e audit** (file:line evidence sent to the supervisor). Before #117 the live dry run could not make a paper trade:
  - H15 had no simulation;
  - exec-health was never green without owner limits;
  - regime volume needs 28 published days, survival needs 15 days of graduates, and H14 needs 14 days of creates coverage;
  - exits had `sellRoute: null` and `flow: []`.
- **H15 credits:** about 3 Helius credits per simulation (market read 1, simulate 1, stand-in check amortised), so at most about 8.6k a day at the 120-an-hour cap. This is an estimate; the measured figure will be `journal.h15_sim.credits` from the shakedown.
- **Creates coverage across restarts:** continuous only when the downtime fill completes within 90 s. This is proven in code by the worker-flow tests; on the host, check each restart's `Deployer index: fill (…)` log line.
- Full suite counts on my heads:
  | Head | Branch | Files | Tests |
  |---|---|---|---|
  | 84cce73 | #117 | 153 | 4,516 |
  | 8a6a71e | #130 | 154 | 4,522 |
  | af82601 | #125 | 150 | 4,499 |

## Rulings received
- (a) Exec-health in S0 is measured, never judged. Its limits are the owner's: an open owner item.
- (b) There is exactly one S0 diagnostic set. It now has four parts; `regime-survival` was added by a later ruling.
- (c) H15 runs on `RoundTripSimulator` at P2 with an hourly cap of 120, which was accepted.
- (d) Creates-coverage timeline risk: about 14 days of continuous host uptime.
- Never remove a guard, even a redundant one. That is why `closedFlow` keeps its own open-minute filter.
- The graduates series is public market data, approved under the stored-data ruling.
- PERSIST-3: when inputs can't be restored, use sell-only recovery.

## Open risks and gaps
- **Owner:** set the exec-health limits (`ExecHealthLimits`) before the qualifying run.
- **DATA-1:** no day-file loader for the graduates seed yet, so a fresh host still needs about 15 days for survival (the S0 shakedown logs it through `regime-survival`).
- **Restart resets that remain** (DECISIONS "Graduates across restarts"):
  - candidates migrated before a restart are forgotten;
  - graduates whose mark falls inside the downtime are never measured;
  - creates coverage depends on the 90 s fill.
- **#131 deploy effect:** the first deploy flattens any position held across it, because its saved exit predates the new fields.

## How to verify
- `pnpm install --frozen-lockfile && pnpm typecheck`
- `npx vitest run --maxWorkers=2` from the repo root. The root config holds the setup file, so running from a package directory makes the engine runtime-trap tests fail falsely.
- Focused tests:
  - `packages/worker/test/{worker-1e,sim-read,exit-route,persist-3,persist-worker,persist}.test.ts`
  - `packages/core/test/gates/s0-diagnostic.test.ts`
  - `packages/core/test/facts/producer.test.ts -t PERSIST-2`

## Remaining time
- Full-suite runs and pushes for #125 and #131: about 30 min.
- Review rounds: about 1 to 2 h each, depending on findings (uncertain).
- Survival minimum-samples proposal plus a test: about 1 h, after a ruling.
