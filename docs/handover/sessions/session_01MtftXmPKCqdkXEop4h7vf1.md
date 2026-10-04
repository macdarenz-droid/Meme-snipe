# Handover: session_01MtftXmPKCqdkXEop4h7vf1 (builder)

## Role, cards, model
- Builder for the Zeroed paper-trading bot. Supervisor: session_01Bne9GqXR99gJn6D9U2mJFZ. Risk reviewer: 017PBU.
- Model: claude-opus-5-5 (Opus 5.5), session default effort.
- Cards, in order: POS-1 (live position market from swap events), RISK-MARK (executable mark for each open position), RISK-LATCH (audit M1), RISK-PARTIAL (audit M3).

## PRs and branches
All PRs target the integration branch `ccr-14987baf-i6lrsl`.

| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #88 POS-1 | claude/pos-1 | 12ea2a3 | Merged (fefe332) | Risk review passed after fixes B1, N1, N2, N4, N5 |
| #103 RISK-MARK | claude/risk-mark | 33de0f9 | Merged (b565123) | Risk review passed after fixes B1–B4, N1, N2, N3 (noted), N7 |
| #124 RISK-LATCH | claude/risk-latch | 23fc039 | Open, draft | **FAIL** from 017PBU at 23fc039 (see Next steps) |
| #132 RISK-PARTIAL | claude/risk-partial | a244707 | Open, draft | Not reviewed yet. CI suite completed on a244707; the supervisor said it continues after RISK-LATCH |

Nothing is left uncommitted: both open branches are pushed at the heads above.

## Done (merged)
**POS-1**
- `core/src/fills/pool.ts` (`realSwap`, `swapEventState`) gives one pool-state function shared by live and backtest.
- `core/src/facts/producer.ts` (`PoolChain`): pool facts after each decoded swap. It fails closed on gaps, decode failures and reserve mismatches.
- The harness has a `heldPoolFacts` test switch.
- `run/pool-watch.ts` and `providers/solana-ws.ts` raise a watch's priority in place.
- DECISIONS section: "Position market from swaps (POS-1)".

**RISK-MARK**
- `worker/src/engine/marks.ts` (`markedHistory`, `riskAccount`, `markSettings`) and `core/src/exits/value.ts` (`executableMark`): the full-size sell quote after fees and the last-rung slippage and fee.
- The mark is null on a stale or flagged market or a stale SOL price.
- Entry fails closed on a marking fault. An exit falls back to the unmarked account.
- DECISIONS section: "Risk marks (RISK-MARK)".

## Work in progress
**#124 RISK-LATCH, head 23fc039 (complete, but the review FAILED)**
- The fix: `packages/worker/src/run/worker.ts` `#markAccount` runs `evaluateExit(input)` on the snapshot's input and latches its trips through a new `#latch(trips, at)`. `#afterRecord` uses the same `#latch`.
- Tests: `packages/worker/test/kill-latch.test.ts`.
- DECISIONS section: "Risk latches from the account valuation (RISK-LATCH)".

**#132 RISK-PARTIAL, head a244707 (complete, not reviewed)**
- Core: `packages/core/src/risk/types.ts` adds `RealizedPart`, plus optional `partials` on `OpenPosition` and `ClosedTrade`.
- Core: `packages/core/src/risk/evaluate.ts` adds `realized()` and `partialTimes()`. These feed `realizedBefore`, `accountEvents` (the HWM and week base), time validation and NAV `lastChange`.
- Worker: `packages/worker/src/run/account.ts` adds `soldBasis`, `pnlUsd`, and partial booking in `filled()`. The open-position basis is entry SOL plus entry fees, less the realized share.
- Tests: `core/test/risk/partials.test.ts`, `worker/test/partial-sale.test.ts`, and the take-profit test in `worker/test/position-market.test.ts`.
- DECISIONS section: "Partial sales in risk (RISK-PARTIAL)".

## Next steps (in order)
1. **Fix the #124 review FAIL (017PBU at 23fc039).** The finding: the valuation latches on missing evidence.
   - In `#markAccount`, latch only when `marked` is true and the SOL price is fresh. `marked` is already computed there: every open position has a mark, and its `markAtMs` is ≤ now and within `maxQuoteAgeMs`.
   - Fresh SOL price means `this.#solPriceAt` is not null and `now - solPriceAt` is within `policy.gates.maxQuoteAgeMs` and ≥ 0.
   - Move the `trips` and `#latch` block after the `marked` computation and gate it on `marked && solFresh`.
   - Apply the same condition in `packages/worker/src/engine/strategy.ts` `#exitDecision` (~line 1009–1020). There, `this.#marked(..., {fallback:true})` can return the unmarked account. Push `TRIP_PREFIX` trips only when every `account.openPositions` mark is non-null and fresh, and `sol` is fresh. Keep logging the tripped codes; just don't emit the `TRIP_PREFIX` lines.
   - Tests that must fail before and pass after:
     - (a) A held position whose mark is null, where the total-loss stand-in would push past the weekly line (e.g. $2.01 realized loss plus a $2 held position), must not latch R9 or R10 from the valuation.
     - (b) The same account with a fresh mark showing a real dip must latch.
     - (c) The `#exitDecision` path with a fallback (unmarked) account must not latch.
   - Tools for (a) and (b): `makeWorker`, `passingMarket(h, { heldPoolFacts: true })`, the `markedHistory` seam (`WorkerDeps.markedHistory` / harness option) to force null marks, and the `account.json` trade injection pattern from `kill-latch.test.ts` (second test).
   - For (c): `position-market.test.ts` "injected mark fault" shows how to make marking fail during an exit.
   - Run mutants on the new conditions, run `pnpm check`, push, and send the SHA to the supervisor.
2. **RISK-PARTIAL #132.** After #124 merges, merge the base into `claude/risk-partial` (a merge commit). `docs/DECISIONS.md` will conflict: both PRs add a section just before "## Live/replay parity (TEST-1"; keep both. Then run `pnpm check`, push, and ask 017PBU for review.
3. Check the #132 open question with the reviewer:
   - `pnlUsd` with no SOL price books a gain as 0 and a loss as the part's whole dollar share. This is the safe side and mirrors the close's rule.
   - Tokens sold without a booked sale (an `external_sale`) keep their basis until the next booked part, which then realizes their loss.

## Findings and research results
- **Audit M1 reproduction** (`kill-latch.test.ts`, real harness, SOL at $150 then 44%):
  - On 3f14e0f, the kill latch stays null after a NAV breach with nothing held. Fixed at 23fc039.
  - A booked $4.50 weekly loss (limit 20% of $20 = $4) does not latch R9 on 3f14e0f. Fixed at 23fc039.
- **Observation, no change** (recorded in DECISIONS for the risk reviewer):
  - The R10 NAV kill line is 70% of an HWM seeded at the $20 opening equity, but NAV excludes the operations floor. Measured in the harness: NAV ≈ $17.55 at the trial start, with wallet 131,987,133 lamports at $150 and setup rent 1,346,200 lamports.
  - So the NAV measure trips after a trading loss of about $3.55 rather than $6. That is tighter, never looser.
  - Seen in kill-latch test 2: a $4.50 loss also tripped R10.
- **Audit M3 reproduction** (`partial-sale.test.ts`, SOL $100):
  - On 3f14e0f, the open notional stays $5 after half is sold, and equity is $18. After the fix: notional $2.50, equity $20.50, day loss 0, cash $18.
  - A losing part: equity $19.40 with a day loss of $0.60, against $17.40 on the base.
  - A part across the day boundary: day loss $0.50, against 0 on the base (the base was looser).
- **Mutants**
  - RISK-LATCH: 3 killed. 1 is equivalent: re-stamping an already-set latch, because risk stops reporting a trip once it is latched.
  - RISK-PARTIAL: 22 tried, 22 killed. Specs are in `docs/handover/sandbox/session_01MtftXmPKCqdkXEop4h7vf1/muts*.json` and the runner is `mutp.py`.
- **`pnpm check`**
  - 23fc039: 151 files, 4495 tests passed.
  - a244707: 152 files, 4504 tests passed.

## Rulings and decisions
- Supervisor: RISK-LATCH comes first, then RISK-PARTIAL. Each defect must be reproduced in a test that fails on 3f14e0f before any code changes. Limits never loosen.
- 017PBU, on #124: latch only on full evidence (marked and SOL fresh), and apply the same rule in `#exitDecision`.
- My own decisions:
  - Core risk is untouched for RISK-LATCH; it uses `evaluateExit` (account-level trips).
  - Lifecycle is untouched for RISK-PARTIAL: the allocation derives from `cost` and `bought`.
  - The `account.json` shape gained partial fields. They hold the bot's own trades only, under the supervisor's data ruling.

## Open risks and known gaps
- #124 as it stands can latch R9 or R10 on a momentary null mark (the review FAIL). Do not merge 23fc039.
- #132 changes the risk equity basis. Exit fees now go to the realized part instead of the held basis; review that this is wanted.
- The #124/#132 DECISIONS merge conflict is expected and trivial.
- One load-sensitive runner test flaked once earlier (during RISK-MARK). It passed on rerun and in isolation, and was reported to the supervisor then.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- `cd packages/worker && npx vitest run test/kill-latch.test.ts test/partial-sale.test.ts test/position-market.test.ts`
- `cd packages/core && npx vitest run test/risk`
- Before/after check: `git stash -- packages/*/src`, run the test, then `git stash pop`.

## Remaining time (estimate)
- The #124 fix plus tests: about 1–1.5 h, including `pnpm check` (about 12–15 min a run on this container).
- The #132 base merge and the review round: about 0.5–1 h, plus review fixes (unknown; 0–2 h).
- Uncertainty is mainly in review rounds.
