# Session session_01WGpxEWFacSgAuXL5KAzrKc: builder (TEST-3, WATCH-1, G3)

## Role, cards, model
- Builder session. Cards came from supervisor session_01Bne9GqXR99gJn6D9U2mJFZ.
- Cards, in order:
  - RUG-1b
  - TEST-3 (§18 fault injection)
  - TEST-3 G3 report
  - WATCH-1, then 1b, 1c and 1d (the second price path for held positions)
  - the G3 reject-mix fold
- Model: Opus 5.5 (`claude-opus-5-5`) at the session's default effort.

## PRs and branches (heads as pushed at handover)
| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #81 RUG-1b | (merged) | 31ca4da | merged | passed |
| #83 TEST-3 PR 1 | claude/test-3 | cfdeac9 | merged into base earlier | reviewer 01DdN4 |
| #87 WATCH-1 | claude/watch-1 | 840566f (merged as fa22e66) | merged | 017PBU: FAIL B1 at b39c057, then PASS at 569a7ae |
| #98 G3 report | claude/test-3-g3 | c1f3f45 | in the merge queue (PASS) | 01FHfb: FAIL at ea88197 (outcome tail), FAIL at 07dede2 (two test gaps), PASS at c1f3f45 |
| #113 WATCH-1b | claude/watch-quiet | merged as 8706826 | merged | 017PBU: PASS at c899f04, then conditions delta at 32b9d36 |
| #121 WATCH-1c | claude/watch-1c | 26d992a | open, draft | 017PBU: FAIL at 12ae9f5 (entry reads the carry), FAIL at 6725a30 (send-path test gap); fix and test at c8227ea, head 26d992a not yet reviewed |
| none yet | claude/watch-1d | 221f291 | WIP, no PR | not reviewed |
| none yet | claude/g3-worker-fold | a650ec8 | WIP, no PR | not reviewed |

Notes on the WIP branches:
- `claude/watch-1d` is built on WATCH-1c 6725a30 plus base 5087bd4. It does not yet contain c8227ea, the latest #121 test. Merge `claude/watch-1c` into it.
- `claude/watch-1c` head 26d992a: the full `pnpm check` on this exact head did not finish before the handover. The same content minus a stray `node_modules` link was mid-check. Re-run `pnpm check` before review.

## Done (with paths)
- **TEST-3:** the §18 fault cases in `packages/worker/test/fault-injection.test.ts`.
- **G3 report:**
  - code: `packages/worker/src/research/g3.ts`, `counterfactual.ts`, `recording.ts`, `scripts/g3.ts`;
  - tests: `packages/worker/test/g3.test.ts`;
  - DECISIONS section "G3 report".
  - The outcome tail works like this. The registration has `outcomeTailMs`, at least tMaxCap + the exit ladder (2 h 10 min on the trial policy). Decisions are cut at evaluateAtMs. Outcomes and simulations are read to cut + tail. A kept trade still open at the end of the tail is censored and G3 is not proven. `censoredKind` is set.
- **WATCH-1:**
  - code: `packages/worker/src/run/watch.ts`, `run/snapshot.ts`, `run/config.ts` (watch settings, `watchTimingProblem`), `run/worker.ts`;
  - the strategy's `chooseMarket`, `snapshotWins` and `#market` in `packages/worker/src/engine/strategy.ts`.
  - WATCH-1b: a feed pool fact counts from its release. The guard checks steady < maxQuoteAge and transition ≤ maxQuoteAge + one release.
  - WATCH-1c:
    - POS-1's producer releases a `carryKey` with each slot notice while the trade stream is covered (`packages/core/src/facts/producer.ts`, `core/src/gates/facts.ts`).
    - A non-swap pump_amm event, or an out-of-order swap, makes the chain stale.
    - There is a verify read every `ZEROED_WATCH_VERIFY_MS` (30 s).
    - Entries never read the carry.
  - DECISIONS sections: "Position watch (WATCH-1)", "Released-fact freshness", "Coverage-proven freshness", "A snapshot's bank is held to the chain head" (the last only on the watch-1d branch).
- **Slot-time measurement:** docs/RESEARCH.md "Slot time" (on the watch-1c branch).

## Work in progress
1. **#121 WATCH-1c, head 26d992a.**
   - Both review findings are fixed:
     - `#evaluate` and `#sendEntry` call `#market(..., { carry: false })`.
     - Test 1 (`position-market.test.ts`): "a carry never dates an entry ... R13". It fails with the carry back at evaluate.
     - Test 2: "an entry evaluated on a quote nearly at the age limit is cancelled at the send...". It fails with the carry back at send (verified by mutant). It uses the chain read's reserves (`m.chainState`) so the carry applies.
   - DECISIONS no longer calls the send mutant "equivalent".
   - Needs: a full `pnpm check` on 26d992a, then 017PBU's delta.
2. **WATCH-1d (`claude/watch-1d`, 221f291).**
   - Audit fix in place:
     - `minContextSlot` = live head − `maxStateSlotLag` (`solana-http.ts getMultipleAccounts`, `sources.watchRead`);
     - a bank behind a live head is refused with an alert;
     - on a dead feed, a repeated bank is not put and is refused once it has stood for `staleMs`;
     - a bank going backwards is refused;
     - a snapshot that reads the pool fact's own reserves confirms it, `confirmedAtMs` in `chooseMarket` (otherwise the watch chases a bank one slot ahead).
   - The harness `scaledRead` now answers at `slotAt(now) - 2` (the chain's own slot).
   - Tests: `snapshot.test.ts` "a snapshot's bank is held to the chain head" (3 cases) and fault-injection "a node that answers from a bank far behind the live head". Mutants 7/7 killed.
   - Full check passed (4527) before the last base merge.
   - Remaining:
     - merge `claude/watch-1c` (c8227ea and later);
     - re-run `pnpm check`;
     - open a draft PR to 017PBU.
3. **G3 worker fold (`claude/g3-worker-fold`, a650ec8).**
   - `foldWorkerReasons` in `packages/core/src/stats/gates.ts`. G3 folds `worker:*` into `worker` for the per-reason intervals and the G-test, and reports per-code counts and the worker share (`metrics.workerShare*`, a note).
   - Test in `packages/core/test/stats-gates.test.ts`. Mutants 4/4 killed.
   - Remaining:
     - merge the base (it now has #98);
     - add the DECISIONS text to the "G3 report" section: worker codes differ by design between the live worker (no-sol-price, no-market, no-account, no-round-trip, size-mismatch) and the study (market-data, book-busy, no-quote, not-evaluated);
     - open a draft PR, review 01FHfb.
   - The supervisor also asked for `expect(calls.length).toBe(before)` before the feed dies in the fault test. That is now covered on WATCH-1b/1c (the healthy-minute pin), so it is not needed on this branch.

## Next steps (in order)
1. On `claude/watch-1c`: `pnpm check`. If green, tell the supervisor that the head is ready for 017PBU's delta.
2. On `claude/watch-1d`:
   - `git merge origin/claude/watch-1c`, then merge the base (`origin/ccr-14987baf-i6lrsl`), with merge commits;
   - `pnpm check`;
   - open a draft PR "WATCH-1d: a snapshot's bank is held to the chain head", reviewer 017PBU. The PR body is in the commit message plus DECISIONS.
3. After #98 merges: on `claude/g3-worker-fold`:
   - merge the base;
   - add DECISIONS (see WIP 3);
   - `pnpm check`;
   - draft PR, reviewer 01FHfb.
4. A later card (supervisor's note), if the dry run shows the 0.7 s transition window matters: release WATCH-1's snapshot outside the feed horizon (option a2). That needs a feed release rule and replay parity.

## Findings and numbers
- **Healthy feed:** released pool facts are 650–950 ms old by design (2-slot horizon).
  - With receipt-age judging the watch read about 300 times a held minute.
  - With release-time judging (1b): 0 reads plus 1 per 30 s verify read (1c).
  - Measured in `fault-injection.test.ts`.
- **Quiet pool (no swaps):**
  - On snapshots alone: about one read every 0.4 s, 50 reads in 20 s (about 0.36 M CU per 120-minute hold).
  - With the carry (1c): 20 reads in 10 minutes. That is 1 at the open + 1 per 30 s, about 4.8 k CU per 120-minute hold.
- **Quote-age arithmetic at the defaults** (stale 500, every 200, latency 400, release 800):
  - steady 1900 < 2000;
  - transition (feed facts stop) 2700 ≤ 2800, a 0.7 s window in which exits wait (EXIT-1d).
  - The supervisor ruled this (a1') with its reason: a3 burns the free tier, a2 is too wide.
- **Slot time:** mainnet `getRecentPerformanceSamples(720)` at 2026-10-04 06:08 UTC, 279 one-minute samples. Mean 267 ms, p50 267, p95 274, p99 278, max 283. Single-slot spread is not measurable over RPC (1 s block times); measure it from the dry run's recorded slot receipts.
- **Gates' `maxStateSlotLag`** is 2 slots. An entry's evaluate→send gap is one decision. Quotes are judged on the uncarried moment.
- **Merge rule M:** the newest whole market (snapshot vs pool fact vs carry) is chosen first, and POS-1's flag is checked only on the pool-fact branch.
- **The harness's `heldPoolFacts`** switch keeps pool facts coming while held (the test convention since POS-1).

## Rulings received
- Owner chat: answer with "." when there is nothing for the owner. Report times in Melbourne time.
- (a1'): accepted, conditional on the guard checking both bounds and the DECISIONS ruling text (done in #113).
- WATCH-1c design: the two holes are accepted.
  - Hole 1: a non-swap tx makes the chain stale.
  - Hole 2: a verify read every 30 s; a donation can skew an exit quote for at most one verify interval.
  - Entries ignore the carry.
- G3 fold: fold `worker:*` for the G-test (and the intervals). Keep the per-code counts and the worker share visible. Review goes to 01FHfb.
- G3 option b (outcome tail): the registration's `outcomeTailMs`, refused below tMax plus the exit ladder.

## Open risks and gaps
- **A silent logs-subscription stall** keeps carrying for at most one verify interval (30 s), bounded by the verify read.
- **A donation into a vault:** an exit quote can be skewed for at most one verify interval, at the attacker's cost.
- **The 0.7 s transition window** after a pool's facts stop: exits wait for a fresh market.
- **The runner tabletop test** (`packages/runner/test/runner.test.ts`, "host loss and chain rebuild", `recovered_state`) failed once under full-suite load and passed 3/3 alone. It is unrelated to the WATCH work, but watch it.
- **Equivalent mutants**, all documented in DECISIONS:
  - in WATCH-1b: a winning snapshot judged by the pool's release;
  - in WATCH-1: the reconcile-signed skip;
  - in the G3 fold: none.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` on each branch.
- Focused runs:
  - `npx vitest run packages/worker/test/fault-injection.test.ts packages/worker/test/snapshot.test.ts packages/worker/test/position-market.test.ts packages/worker/test/facts-parity.test.ts packages/core/test/facts/pool-chain.test.ts`
  - `npx vitest run packages/worker/test/g3.test.ts`
  - `npx vitest run packages/core/test/stats-gates.test.ts`
- Mutation scripts were ad hoc in Python (replace a line, run the files above, restore). The mutant lists are in each DECISIONS section.

## Remaining time (estimate)
- #121 green-and-ready: about 15 min (one full check), plus the reviewer delta.
- WATCH-1d to a draft PR: about 30–45 min (merge, possible conflicts in `strategy.ts`/`worker.ts`, one full check).
- G3 fold to a draft PR: about 30 min after #98 merges.
- Uncertainty: each extra review round costs about 30–60 min, and base movement adds merge time.
