# Risk reviewer: session_017PBUwcGJWG4DJpJKVBcAas

## Role, cards, model
- Role: risk reviewer (fresh context, review only). Owns review of `packages/core/src/risk/**`. I also review risk-relevant worker, exit and watch changes when the supervisor asks.
- Rules I followed:
  - Never push code, approve, merge or comment on GitHub.
  - Verdicts (PASS or FAIL, with the SHA) go to the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). Blocking items also go to the builder.
- Model: configured `claude-opus-5-5`, at the session's default effort. The CLI showed `/effort ultracode` at the start.
- No cards built. This session has no branches and no PRs of its own, so it has no code to push.

## PRs and branches
None of my own. Every review verdict follows (UTC, 2026-10-03/04).

| PR | Card | Verdicts (SHA → result) | Last verdict |
|---|---|---|---|
| #18 | RISK-1 | d99d5ee FAIL (3 blocking) → 0f7d142 PASS, corrected to FAIL (R7 clamp mutant survived) → ce67168 PASS → 61ebf03 delta PASS | PASS 61ebf03 (merged) |
| #40 | LEDGER-1c | 2d13643 FAIL (3 fail-open edges) → 444f1a3 PASS | PASS 444f1a3 |
| #48 | WORKER-1 item 7 (setup rent) | 6a9e19d FAIL → f55538f FAIL (shape) → 83d1144 PASS | PASS 83d1144 |
| #55 | EXIT-1b | be82457 FAIL → 674d458 FAIL (test for `!liq.ok`, rules.ts:347) → 265b815 PASS | PASS 265b815 |
| #58 | RISK-1b | 6ca2c62 FAIL → a726f24 PASS | PASS a726f24 |
| #82 | WORKER-1b | 28579f5 FAIL (test) → 3110f48 FAIL (test) → 48ddb52 PASS | PASS 48ddb52 |
| #87 | WATCH-1 | 334f6d8 FAIL (3) → 80119ef FAIL (2) → b39c057 FAIL (1) → 569a7ae PASS → 840566f merge PASS | PASS 840566f |
| #99 | WORKER-1c | d3c7acd item 2 PASS → 2fc1fd1 delta PASS | PASS 2fc1fd1 (merged as d92b73e) |
| #101 | POOL-1 | 813c7fd PASS | PASS 813c7fd |
| #113 | WATCH-1b | c899f04 PASS → 32b9d36 delta PASS | PASS 32b9d36 |
| #117 | WORKER-1e | cb0a219 PASS | PASS cb0a219 (merged as 5087bd4, at 902040c) |
| #121 | WATCH-1c | 12ae9f5 FAIL → 4eb4dba FAIL → 6725a30 FAIL (test gap) | **FAIL 6725a30, open** |
| #124 | RISK-LATCH | 23fc039 FAIL (code read; `pnpm check` not run on it) | **FAIL 23fc039, open** |

## Done
All the reviews above. Evidence for each: I ran `pnpm install --frozen-lockfile && pnpm check` on the exact SHA, plus my own hand mutants (sed edit → `pnpm vitest run <dir>` → `git checkout`). The full texts of the verdicts are in the supervisor session's transcript.

## Work in progress: open findings

### #121 WATCH-1c at 6725a30: FAIL, 1 blocking
- **Blocking (a test gap; the code is right).** In `#sendEntry` (packages/worker/src/engine/strategy.ts:870, `this.#market(ctx, mint, { carry: false })`), the mutant that restores the carry survives: 576/576 worker tests pass. The builder called it equivalent; it is not.
  - `#sendEntry` runs in `#lifecycle` on a later decide call than `#evaluate`, after the reservation.
  - Example: the pool fact is received 1.9 s before evaluate, and a slot notice comes 0.4 s later. The uncarried age is then 2.3 s, which is over maxQuoteAgeMs of 2 s. The fixed code cancels the entry; the mutant sends it on the carry.
  - Needed: a test where a carry is present, evaluate passes just under the quote age, the next event pushes the uncarried age past it, and the entry is cancelled with "pool state is stale".
- Base: 6725a30 does not contain 5087bd4 (the #117 merge). It needs a merge.
- Checked and passing at 6725a30:
  - `pnpm check`: 150 files, 4500 tests, all green.
  - The `#evaluate` carry:false mutant is killed.
  - The `chooseMarket` slot and flag guards are now pinned.
- Earlier rulings that still hold:
  - Exits and marks may be priced from a donated or silently stalled pool for at most one verify interval (30 s, plus one period and the latency).
  - A reported gap, hole, open gap, out-of-order swap or non-swap pump_amm event stops the carry at once.
  - Mutants that only tighten and survive (not blocking): staling on non-swap events at or before the read slot; counting processed events.

### #124 RISK-LATCH at 23fc039: FAIL, 1 blocking
- **Blocking.** `Worker.#markAccount` (packages/worker/src/run/worker.ts, the new `evaluateExit(input).trips` → `#latch`) latches R9/R10 on every valuation. That includes valuations where a held mark is null: a stale market, a stale SOL price, or the `fallback: true` unmarked account.
  - Core `figures` (packages/core/src/risk/evaluate.ts ~144-156) counts an unknown mark as a total loss. That stand-in is for refusing entries, not for proving a breach.
  - Result: a momentary null mark can latch R9 for the week, or R10, until the owner reviews it.
    - At trial settings: $2.01 realized week loss plus a $2 held position reaches the 20% weekly line ($4). A single $4–5 position does it on its own.
  - Fix: latch from the valuation only when `marked` is true (every open mark known and fresh; computed on the next line) and the SOL price is fresh.
  - Test, failing before and passing after: a null mark whose stand-in crosses the weekly line does not latch; a fresh mark showing a real dip does.
- Follow-up, same issue, already present before this PR: `#exitDecision` (strategy.ts ~1018) latches `r.trips` from a fallback, unmarked account. Apply the same condition there.
- Matches its DECISIONS note (not blocking): R10 at 70% of an HWM seeded at the $20 opening equity, while NAV excludes the ops floor, trips at about a $3.55 loss. That is tighter, and it is already on the owner's before-live list (RISK-1).
- `pnpm check` was not yet run on 23fc039.

### Non-blocking follow-ups from earlier reviews (not yet cards unless noted)
- #113 (a2): the quiet-pool watch cost was not bounded by T_flat. WATCH-1c now bounds it with the carry plus the 30 s verify read.
- The watch guard should use a measured p99 slot time. WATCH-1c measured 278 ms (docs/RESEARCH.md "Slot time") and kept 400 ms. Single slots are still to be measured in the dry run.
- POOL-1: the retry wait should reset on `onSubscribed`.
- Marks under maxOpen = 2 need a version requirement (raised in the RISK-MARK and WORKER-1c reviews).
- #117: the `approve_risk` line has no `s0_diagnostic` label. The reject line is deduped by reason key, so a change only in the waived set is not re-logged.
- #113: the transition-bound refusal in `watchTimingProblem` cannot be reached, because the steady bound implies it. That is an equivalent mutant, and it is accepted.

## Next steps (in order)
1. Re-review #121 when the builder pushes the `#sendEntry` test and the base merge. Run the carry:true-at-send mutant (strategy.ts `#sendEntry`) and confirm it is killed, then run `pnpm check`. PASS if green and the base is contained.
2. Re-review #124 after the `marked`-gated latch fix and its test. Mutate the gate: drop the `marked` condition and confirm the null-mark test fails; latch on an unmarked valuation and confirm it is killed. Also check the `#exitDecision` follow-up.
3. Queue: PAPER-1 `failed_entry` kind, RISK-PARTIAL, WATCH-1d. None had arrived when the session stopped.

## Findings and numbers
- Setup rent (#48): (128 + 137) × 5,080 = 1,346,200 lamports, about 0.00135 SOL, about $0.16 at $119.46. Sources: config/fills.ts:28, tx/rent.ts:11.
- WATCH-1b timing at the defaults: steady 500 + 200 + 400 + 800 = 1900 < 2000; transition 2700 ≤ 2800; a 0.7 s window in which an exit waits (EXIT-1d).
- Test counts I ran:

| PR | SHA | Files | Tests |
|---|---|---|---|
| #117 | cb0a219 | 149 | 4460 |
| #113 | 32b9d36 | 146 | 4441 |
| #121 | 12ae9f5 | 146 | 4451 |
| #121 | 6725a30 | 150 | 4500 |

- Mutation results by PR:
  - #117: 8/8 hand mutants killed.
  - #113: steady `<` → `<=` killed; the transition refusal is equivalent.
  - #121 at 12ae9f5: 4 killed; 4 survivors, all either tightening or equivalent.
  - #121 at 6725a30: `#evaluate` killed, `#sendEntry` survives (the blocking item).
- Flakes seen: one unnamed failure in 1 of 5 full runs, and the runner.test.ts tabletop. Both reported as not blocking.

## Rulings I made
- An exit flow trigger (#117) must not fire on a gap or a quiet minute. It is a positive-evidence sell signal; outages are covered by the stale-market wait, WATCH-1 and the time stops.
- Entries never use the carry (#121). Candidates get no verify read, so "unproven means no trade" applies.
- A persistent latch (R9/R10) must rest on a fully marked, fresh valuation (#124).

## Open risks
- #121: a silent logs stall or a vault donation can skew a held position's exit quote or mark for up to about 30 s.
- #124 as it stands: spurious week-long R9 latches during the dry run.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- Mutants: `sed -i '<edit>' <file>; pnpm vitest run packages/worker/test; git checkout -- .`
- The scripts in `research/risk/` (`mutate.py`, `montecarlo.py`) are in the repo.

## Remaining time
- #121: about 15 min after the builder's push. #124: about 30 min.
- Each new card in the queue: 30–60 min.
- Uncertainty: about ±50%, depending on how many review rounds each needs.
