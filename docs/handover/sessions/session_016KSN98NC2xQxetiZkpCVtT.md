# Handover: session_016KSN98NC2xQxetiZkpCVtT (builder "BT-1", later the EXIT and RENT cards)

## Role, cards and model
- Builder. Supervisor: session_01Bne9GqXR99gJn6D9U2mJFZ.
- Cards, in order: BT-1c, BT-1d (backtest harness), BT-3 (pre-funding gate items 1 and 2), EXIT-1c, EXIT-1d, EXIT-1e, EXIT-1f, RENT-1, EXIT-1g (with audit M7), EXIT-1h.
- Model: the session was configured for the Opus 5.5 tier, at the session's default effort.

## PRs and branches (heads as of 2026-10-04 19:15 AEDT)
| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #73 | claude/backtest-1d | (merged) | merged | BT reviewer 012efQ PASS |
| #89 | claude/bt-3 | c140034 (remote, base merges by the supervisor) | merged (BT-3) | 01DKMn: FAIL at 982ee3d (pass terms unpinned), fixed; then merged |
| #93 | claude/exit-1c | 50a3a74 | merged | 01UXzG: FAIL at 132fd8c (B1 visibility), PASS at 0bc1fb2 |
| #100 | claude/exit-1d | 74dcb04 | merged through #102 | 01UXzG: FAIL at 10fda3e (B1, B2), PASS at e077aa2 |
| #102 | claude/exit-1e | merged at 6df3b9f as 62eb6cc | merged | 01UXzG: FAIL at d403bc0 (B1 refused restore), PASS at 34f5477 |
| #107 | claude/exit-1f | ce7c78b | open, PASS | 01UXzG: FAIL at 1ba212c (B1 first-open pin), PASS at ce7c78b (8 of 11 mutants killed). Queued after #117 and #106 (supervisor). Do not push to it. |
| #114 | claude/rent-1 | 10ec76a (remote; my last push 02d5f1d) | open, ready, PASS | 012efQ: PASS at 484d50a (5 of 6 mutants; the survivor is equivalent); required doc fix and nit done at 02d5f1d |
| #128 | claude/exit-1g | ed0cdc0 | open draft, stacked on #107 | with 01UXzG, no verdict yet |
| (none yet) | claude/exit-1h | 33f2998 | pushed, no PR yet, stacked on claude/exit-1g | not reviewed |

Commits not in a merged PR were never pushed to the integration branch. claude/backtest-1d, claude/exit-1c/1d/1e and claude/bt-3 are merged.

## What is done
- **BT-3** (merged):
  - `packages/backtest/src/evidence.ts`: runEvidence replays each window N times. The pass terms are each pinned by a stubbed test. Gate mode needs SHA256SUMS to cover every file read, plus 14 lead-in days.
  - `packages/backtest/scripts/evidence.ts`: the one-command run.
  - `docs/evidence/bt3/synthetic/`: synthetic evidence at 0d1e535 (fills-2 code). It **must be re-run on fills-3 code after #114 merges.**
- **EXIT-1c** (merged, `packages/core/src/exits/rules.ts`): a full exit that fires with no fresh quote is remembered (pendingFull) and goes on the first fresh quote, never booked blocked. The wait is visible: exit-pending flag, pending_exits, and the exit-blocked alert after blockedRetryMs (`run/api.ts`, `run/worker.ts`).
- **EXIT-1d** (merged, `packages/worker/src/engine/strategy.ts` #sendExit): an owner's next attempt waits for a fresh market (unknown, malformed, no fees, stale, or no slot yet), never booked blocked. The wait start is saved (SavedExit.waitingSinceMs) and ended from the book.
- **EXIT-1e** (merged): no position is managed before the boot's restore fact. A refused restore releases the gate. An unrunnable saved plan is refused per entry.
- **EXIT-1f** (#107):
  - plan and tracker checked per field (`runnablePlan`, `runnableTracker`);
  - fallback open time = the ledger's first `open` event ts (restore fact `openedAt`), capped at now;
  - a reconcile-time booking (placed from the journal, `run/booked.ts`) uses min(booked, slot-dated); a live booking stays exact;
  - `maxSlotMs` = 500 ms (`run/settings.ts`) is the fallback only.
- **RENT-1** (#114):
  - the conservative (scored) scenario refunds rent per the modelled sell-and-close outcome (`backtest/src/trades.ts`, `backtest/src/research/outcome.ts`);
  - the `rentRecovery` flag is removed and the fills version is `fills-3`;
  - the no-recovery line stays in economics (`allInNoRentRecoveryMicro`).
- **EXIT-1g** (#128):
  - audit M7, sell-only recovery: a missing or refused plan or tracker, or no seed, leads to an emergency full exit at the next fresh quote, logged as `recovery exit` with the reason;
  - the fallback entry price is cost ÷ bought;
  - N4 and N6 tests;
  - N7: the journal is streamed (`run/booked.ts` journalLines, placeBookingsAt).
- **EXIT-1h** (claude/exit-1h, 33f2998): entry decision seeds are written to `entry-seeds.json` after each engine drain and before desk.consume. The restore fact carries them, so a restored seed rebuilds the real plan, dated at the booked fill. Seeds are pruned when the plan is made or the entry ends unfilled.

## Work in progress
- **EXIT-1h**: 33f2998 is committed and pushed. Its full `pnpm check` was still running at handover. Focused tests passed:
  - the EXIT-1h test, with 2 mutants killed: seeds missing from the restore fact, and a restored seed dated at the restart;
  - the seed-prune check (the no-prune mutant is killed).
  - Not done: the draft PR (base claude/exit-1g), the report to the supervisor, and review by 01UXzG.
- **BT-3 evidence re-run on fills-3**: not started (it waits for #114 to merge).

## Next steps (in order)
1. On claude/exit-1h: run `pnpm check`. If it's green, open a draft PR against `claude/exit-1g`, titled "EXIT-1h: entry decision seeds saved before the intent is booked". Reviewer 01UXzG.
2. When #107 merges, retarget #128 to the integration branch, then merge `origin/ccr-14987baf-i6lrsl` into claude/exit-1g with a merge commit. Then merge claude/exit-1g into claude/exit-1h. Run `pnpm check` on each and push one head per PR. Expect conflicts in `packages/worker/src/run/worker.ts` (restore block) and `docs/DECISIONS.md` (EXIT section).
3. When #114 merges, re-run BT-3's synthetic evidence on that commit: `node packages/backtest/scripts/evidence.ts --synthetic` on a clean tree. Commit `docs/evidence/bt3/synthetic/` as its own commit on a claude/* branch.
4. If #83 (TEST-3) lands with its own no-slot rule in `#sendExit`, merge it with EXIT-1d's no-slot wait into one rule (supervisor ruling: whichever merges second).
5. When WORKER-ORDER (#123, `claude/worker-order`) merges, rebase nothing; merge it into exit-1h. A crash-image test, using its desk `crashPoint` seam, can then prove the seed is on disk before the fill's ledger commit.

## Findings and research results
- Rent drag (RENT-1, supervisor's estimate checked in code): conservative lost the whole token-account rent, about 9% of a $2 trade. A flat trade scored about −10.9% instead of about −2.6%. Test: research.test "still pool" bands. With the close landing, a flat trade is between −5% and −1%; otherwise between −14% and −10%.
- Mainnet slot time: the target has been 350 ms since epoch 1020 (Aug 2026), about 360 ms measured, and 400 ms before that (theblock.co, solanacompass.com). `maxSlotMs` = 500 is the fallback bound only.
- Journal placement memory: a 200 MB journal is placed in under 10 s and under 160 MB RSS when streamed. The read-it-all version used about 520 MB. Test: `packages/worker/test/booked.test.ts`.
- BT-3 synthetic run: 10 replays, one hash (733ef72c…), 0 crashes, 0 illegal states, 0 unreconciled intents, and the ledger replay ok. That was at fills-2 code (`docs/evidence/bt3/synthetic/evidence.json`).
- POS-1 harness change: `Market.pool()` doesn't publish the pool fact for a held position unless `heldPoolFacts` (HELD) is set. Tests that use a pool read as "the first fresh market" need HELD.
- Flaky: `packages/runner/test/runner.test.ts` (host-loss tabletop) fails sometimes under full load. That's CI-1's (#105).

## Rulings received
Recorded in `docs/DECISIONS.md` (EXIT-1c to 1h, RENT-1, BT-3):
- exits never wait;
- blocked is only for a real refusal;
- guards are never removed, even when redundant;
- the booked time stays exact and min() applies to reconcile-time bookings only;
- sell-only recovery when there's no plan of its own (M7);
- seeds are saved with the WORKER-ORDER order (EXIT-1h);
- in RENT-1, DECISIONS line 108 governs and the no-recovery line is a sensitivity;
- no new saved data except the bot's own decision data (stored-data ruling).

## Open risks and known gaps
- The EXIT-1h write order (seed before ledger) follows from the step order and has no crash-image test yet (see next step 5).
- The no-decision-seed path of M7 can't be staged in the paper harness; it shares the code path with the tested ones.
- EXIT-1d's wait start was in memory before its review fix; it's saved now.
- BT-3 evidence is valid only for its commit, and fills-3 needs a re-run.
- Real-data BT-3 windows: none had been published with their 14 lead-in days at handover.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` (about 10 minutes; use a background run).
- Focused tests:
  - `pnpm vitest run packages/worker/test/worker-flow.test.ts -t "EXIT-1"`
  - `pnpm vitest run packages/worker/test/worker-recorder.test.ts -t "EXIT-1"`
  - `pnpm vitest run packages/worker/test/booked.test.ts`
  - `pnpm vitest run packages/backtest/test/research.test.ts -t "outcome stage"`
  - `pnpm vitest run packages/backtest/test/run.test.ts -t "RENT-1"`
  - `pnpm vitest run packages/backtest/test/evidence.test.ts`

## Remaining-time estimate
- The EXIT-1h PR plus the review round: about 1 h (±0.5 h).
- Merging the stack after #107: about 0.5 h per PR.
- BT-3 re-run: about 0.5 h (the run itself takes about 9 minutes).
- Total: about 2.5–3.5 h of builder time, plus review latency.
