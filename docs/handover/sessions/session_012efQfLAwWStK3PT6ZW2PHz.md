# Handover: session_012efQfLAwWStK3PT6ZW2PHz (reviewer)

Written 2026-10-04 19:15 AEDT (Melbourne) on the owner's handover order.

## Role, cards, model
- Role: Reviewer under the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). I review PR heads and reply PASS or FAIL to the supervisor by send_message. I don't push, merge or approve on GitHub.
- Cards reviewed: BT-1, BT-1b, BT-1c, BT-1d, BT-1e, BT-1f, STATS-1c (BT call site), RENT-1, RES-4 (C1 and the definitions), BT-2, BT-TAIL.
- Model: claude-opus-5-5 (configured; the serving model was not independently checked).
- I own no branches or PRs, and I have no unpushed code. The scratch worktrees under my session's /tmp scratchpad hold only temporary mutants and logs. None of them is needed; everything below can be reproduced from the commands given.

## PRs reviewed: last verdict and its SHA
| PR | Card | Last verdict | SHA | Open findings |
|---|---|---|---|---|
| #24 | BT-1 | PASS | 9d42ac6 | none |
| #30 | BT-1b | PASS | c2aab4f | none |
| #53 | BT-1c | PASS | ac8a1fa | none (blocked-exit drop shown to be noise and composition, 48-run experiment) |
| #73 | BT-1d | PASS | 7a1c636 | a worker test flake that also fails on base, routed to the WORKER-1 owner (not verified fixed). Non-blocking: 'short' trusted the caller's requiredTrades, since addressed by STATS-1c's frozen requirement |
| #86 | BT-1e | PASS | e7ae620 | none |
| #62 | STATS-1c (BT call site) | PASS with required fix S1 | fcdd901 | **S1** (see below; not verified fixed by me) |
| #92 | BT-1f | PASS | d24ab34 | non-blocking: (a) add off-curve `creator` from CreatePoolEvent rows to `owners`; (b) a supplement download helper checking the release author, not-draft and SHA256SUMS as collect.sh does |
| #114 | RENT-1 | PASS with required doc fix | 484d50a | **REQUIRED**: docs/ARCHITECTURE.md:307 still says "no rent recovery" for conservative; it should say "rent back per the modelled sell-and-close outcome; the no-recovery line is a reported sensitivity" |
| #115 | RES-4 | FAIL | 8dc0f49 | **C1b** (blocking), plus the definitions dependency (see below). Earlier FAIL at bf56528 (C1) |
| #41 | BT-2 | FAIL | dd19015 | **B1, B2** (blocking), three non-blocking (see below). Earlier work at 501200d |
| #122 | BT-TAIL | not yet sent (in progress) | b6200d1 | none found so far |

### Open findings in full
- **#62 S1**: `endAttempt` 'short' takes `minDays` from the caller (holdout.ts). A ready holdout at 300 trades on 12 days, called with minDays 20, is judged short and burns unopened.
  - Fix: read the days and trades from the frozen requirement (a later commit added `requiredDays` to FrozenRequirement, so this may already be fixed).
  - Verify: a test passing minDays 20 must not burn.
- **#41 B1** (packages/worker/src/engine/strategy.ts:432): the live `observedTip` is untested. Changing `observedTip: ctx.now.slot` to `0n` passes all 737 worker and runner tests, and in that state nothing is ever stale live.
  - Fix: a worker test with a chain fact or stream head more than maxStateSlotLag behind the clock slot. It must abstain 'stale' and fail with the tip lowered.
- **#41 B2** (packages/backtest/src/strategy/study.ts:750–757 `walletHolders`): H3's holder growth doesn't follow #115's `definitions.holderGrowth`. The code:
  - counts token accounts, not distinct owners;
  - counts the 'locker' and 'unknown-program' classes;
  - calls `mintAccounts(mint, null)`, so the pool vault isn't excluded;
  - counts zero balances.

  Fix: count distinct owners with summed amount > 0 among cls 'wallet', with the pool from the tape and complete coverage at both moments, else null. Add tests for each case. This must land before `STUDY_CONFIG.preregistration.sha256` is pinned.
- **#41 non-blocking**:
  - Merge base 669de71 (clean).
  - Add early-CLI tests for refusing non-practice and incomplete days.
  - `study` silently ignores `--preregistration`; refuse it there.
- **#115 C1b** (packages/backtest/test/edge.test.ts parity): outcome.ts can change alone without a failing test.
  - Not caught: removing the failed-close fee `- (!p.dust && !p.closes ? failedExit : 0n)`, and removing `net.tip` from exitFixed.
  - Caught: failed attempt at rung 1, ignoring dust, rent always back.
  - Fix: exact zero-variance parity under scenario overrides, asserting exact lamports against costRow and terms:
    - landPpm 1e6, close 1e6, dust 0;
    - close 0;
    - dust 1e6.

    Or share one `scoringTerms` between both sides.
- **#115 definitions**: the text is sound, but the test only regex-matches the wording, and the implementing code doesn't follow holderGrowth yet (#41 B2). Don't pin the sha until #41 B2 is fixed.
- **#115 non-blocking** (from bf56528): the cost tables leave out congestion, ladder escalation and the exit retry haircut, as the outcome stage does. Say so under the table.

## Done
All the verdicts above were sent to the supervisor. The evidence is in each verdict message: gate counts, mutants, and fail-before/pass-after runs.

## Work in progress (exact state)
- **#122 BT-TAIL at b6200d1**:
  - Done:
    - (a) The new test packages/backtest/test/outcome-tail.test.ts fails on the old outcome.ts (10 s per slot case) and passes on the new one.
    - (b) Equality check: old and new `scoreCandidates` give byte-identical outcomes on 36 synthetic candidates × all PLAN_BARRIERS × the conservative and base scenarios at 400 ms slots (72/72 identical). So the change alters nothing else in scoring at real slot times; it only stops censoring when slots are slow.
    - (c) It merges cleanly into base 669de71 (its merge base is the old d92b73e).
  - Not done: the full `pnpm check` on b6200d1 merged with 669de71 was stopped by the handover. Expected verdict: PASS if that check is green.
- **#115 at 8dc0f49**: the full `pnpm check` was stopped by the handover. The edge tests pass (9/9) at 8dc0f49.

## Next steps (in order)
1. #122: run `pnpm install --frozen-lockfile && pnpm check` on b6200d1 merged with the current base. If green, PASS b6200d1. Note that the builder must merge base before merge.
2. #41: when the builder pushes the B1 and B2 fixes:
   - re-run the B1 mutant (live `observedTip: 0n` in packages/worker/src/engine/strategy.ts) against `npx vitest run packages/worker/test packages/runner`; it must fail;
   - check that the holder-growth tests cover multi-account owners, locker, program-owned, vault and zero balance;
   - run the full check on the head with the latest base.
3. #115: when C1b is fixed, re-run the mutants below on outcome.ts alone against `npx vitest run packages/backtest/test/edge.test.ts`. All five must fail:
   - A: failedExit at steps[0];
   - B: drop the failed-close fee;
   - C: `p.closes = closeSucceeds` (ignore dust);
   - D: rent always back;
   - E: drop `net.tip` from exitFixed.
4. Check #62 S1 and #114's ARCHITECTURE.md:307 doc fix on the current base; report if they're still open.

## Findings and numbers (how measured, where)
- #41 dd19015: `pnpm check` 4,542/4,542 tests, 159 files, exit 0, run locally 18:40–19:07 AEDT.
- Digest: dd19015's observed-tip.test.ts run on pure base 77bec22 (no tip field) passes with digest 677234af…, so the digest change came from the base, not the tip.
- Mutants on #41 (run at 501200d; evidence.ts, market.ts and score.ts are unchanged in dd19015):

  | Mutant | Change | Result |
  |---|---|---|
  | E1 | Evidence uses now.slot for chain facts | caught by core/test/gates/hard.test.ts |
  | E2 | no clamp | caught |
  | E3 | stream head vs now.slot | caught |
  | F1 | devFunderOf ignores `complete` | caught (study.test.ts) |
  | F2 | any wallet's funder | caught |
  | R1 | register when unsizable | caught (3 full-study tests) |
  | M1 | tip jumps to the batch max | caught (replay.test.ts) |
  | W1 | live tip lowered (−50 or 0n) | **survives**: this is B1 |
- #41 501200d: `pnpm check` 4,458/4,458.
- #115 8dc0f49 mutants: A, C, D caught; B and E survive (C1b).
- #122: 72/72 identical outcomes old vs new at 400 ms slots; outcome-tail.test.ts fails before (10 s case) and passes after.

## Rulings received
- From the supervisor: the backtest tip is the newest chain slot released so far, in chain order; live passes the clock's slot.
- From the supervisor: a missing funder label fails G2, with no shared or singleton "unknown" cluster.
- From the supervisor: registration freezes max(300, n_power, closed form) plus the n_power seed; an unsizable walk-forward registers nothing.
- From the supervisor: the early-look `--preregistration` is never a freeze.
- A separate SPA family (k = 6) and a pre-registration hash change come later.

## Open risks and gaps
- If #41 merges without B1, a regression in live freshness would go unnoticed.
- If the pre-registration sha is pinned before #41 B2, H3 is evaluated on a different quantity than pre-registered, which voids the family.
- The parity guard in #115 can't see small outcome-stage cost drifts (C1b).
- The worker flake from #73 may still be on base (not rechecked).
- Running two full `pnpm check`s at once on this container runs out of memory (vitest SIGKILL); run them one at a time.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` on each head.
- Mutation: apply the one-line change with perl, then `npx vitest run <targeted tests>`, then `git checkout -- <file>`. The mutant definitions are in the sections above.

## Remaining time
- #122 PASS/FAIL: about 45 min (one full check).
- Re-reviews of #41 and #115 after fixes: about 1 h each, including mutants.
- #62 S1 and #114 doc check: about 15 min.
- Total about 3 h ± 1 h, depending on when the fixes arrive.
