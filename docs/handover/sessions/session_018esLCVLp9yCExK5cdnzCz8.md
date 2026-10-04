# Handover: session_018esLCVLp9yCExK5cdnzCz8 (RES-3, RES-4, RES-5, BT-TAIL builder)

Written 2026-10-04 about 6:45 PM Melbourne (AEDT).

## Role, cards and model
- Builder for RES-3 (signals), RES-4 (edge and costs), RES-5 (survival study, phase A) and BT-TAIL (a split-out fix to `outcome.ts`).
- Model: claude-opus-5-5, at the session's default effort.

## PRs and branches
All heads were checked against `origin` at handover. Integration branch: `ccr-14987baf-i6lrsl` (at 3dec6ccd).

| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #47 RES-3 plan, code and tests | claude/res-3 | eb8d7ce5 | merged | supervisor PASS |
| #56 RES-3 follow-up (regimes, registry wall, DSR over selectable trials) | claude/res-3b | 27a13d20 | open | not reviewed at this head |
| #115 RES-4 edge.md, costs, pre-registration | claude/res-4 | 8dc0f494 | open, stacked on RENT-1 #114 | 01FHfb: FAIL, then PASS on the pre-registration and §4 wording at bf56528. **012efQ: FAIL on the cost-math parity (see Open risks).** |
| #120 RES-5 survival phase A | claude/res-5 | cd084b09 | open, stacked on #114 | 01FHfb/012efQ: FAIL at 8a7856e (invalid bootstrap p, selection from noise); fixed at cd084b09, re-review pending |
| #122 BT-TAIL slot-based outcome tail | claude/bt-tail | b6200d15 | open draft | reviewer 012efQ, verdict pending |

No unpushed or uncommitted work: every worktree was clean at handover, so there are no WIP commits.

## What is done
- **RES-3:**
  - Pre-registered plan in `docs/research/signals.md` §1–7 (commit 78d5d3f), plus the literature table (§9).
  - Holdout wall: `practice.ts`, `window.json`, and guard tests.
  - As-of tracker with 27 features (`tracker.ts`), plus decision points and purge (`candidates.ts`).
  - Analysis: walk-forward K=5 with embargo, trial registry, DSR, PBO, Holm and regime views (`analysis.ts`), and the CLI.
  - Handoff to BT-2: B1→B2→B3 with `handoff.json`.
- **RES-4:**
  - Cost math is derived in `edge-costs.ts`, with `research/edge/costs.json` and fee snapshots under `research/edge/snapshot/`.
  - Six ranked hypotheses H1–H6 in `research/edge/preregistration.json`, written in BT-2's UniverseConfig shape with a `definitions` block.
  - `docs/research/edge.md`, with an owner summary of 141 words.
  - 9 tests in `edge.test.ts`.
- **RES-5 (phase A):**
  - Label, 15 features and look-alike strata.
  - Find/check split, plus the permutation test (B = 18,000) and Holm across 45 tests.
  - freeze/check CLI with a committed `frozen.json`.
  - Comparison against S0 and RES-4 H1/H2/H5/H6.
  - 25 tests, including null calibration and leakage.
- **BT-TAIL:** the outcome tail is now `(maxAttempts+1)·latency` slots after the last vertical, not wall-clock ms. Test: `outcome-tail.test.ts` at 400 ms and 10 s per slot.

## Work in progress
- None in code. Waiting on reviews (#56, #120, #122) and on the #115 parity fix below.

## Next steps
1. **#115:** fix 012efQ's FAIL. The C1 drift guard in `edge.test.ts` / `edge-costs.ts` leaves out the failed-close fee and the exit tip.
   - Either make the parity exact, by adding both terms to the guard's comparison against `outcome.ts` scoring,
   - or share one exported `scoringTerms` with `outcome.ts`. Ruling: no proof-scoring change rides in a research PR, so that change needs its own PR or a supervisor OK.
2. **After RENT-1 #114 merges:** merge `origin/ccr-14987baf-i6lrsl` (with a merge commit) into res-4 and res-5, re-run `pnpm check`, then ask for re-review.
3. **#120:** get the 01FHfb and 012efQ re-reviews at cd084b09.
4. **#56:** review, then merge `origin/ccr-14987baf-i6lrsl` into res-3b.
5. **Phase B (data):** when DATA publishes practice days, run the RES-3 CLI and the RES-5 `freeze`, commit `frozen.json`, then run `check` once.
   - Results go in signals.md §10 and survival.md §9.

## Findings and research results
- **No real-data result exists yet.** Practice days had not been published, so every analysis number in signals.md and survival.md is "pending".
- **RES-4 cost math.** Derived in `edge-costs.ts` from repo constants and fee snapshots; output in `research/edge/costs.json`; table in edge.md.
  - Expected fixed costs per round trip: **414,009 lamports**. This is entry landed, plus exit fixed, plus expected failed exits (f = 0.44, 155,000 each, up to 5 attempts), plus rent × (1 − 0.855), plus failed close (0.095 × 155,000).
  - Break-even net move:

    | Size | young PumpSwap | U1, 0.95% tier | U1 at 1.15% |
    |---|---|---|---|
    | $2 | 4.98% | 4.36% | 4.75% |
    | $5 | 3.55% | 2.89% | 3.28% |
    | $20 | 3.09% | 2.21% | 2.60% |

  - Parity test: 2,000 seeded trades, mean within 4 SE of the outcome-stage scoring (but see the 012efQ gap below).
- **Synthetic checks only:**
  - RES-5 null calibration: 40 noise runs, and the share choosing a rule is consistent with α (Clopper–Pearson lower bound ≤ 0.05; about 46 s).
  - A planted feature passes Holm.
  - RES-3: a planted +30% edge is found once DSR is restricted to selectable trials.

## Rulings and decisions
- No proof-scoring (`outcome.ts`) change may ride in a research PR; the slot-tail fix went to BT-TAIL #122.
- One rent model (RENT-1 #114); res-4 and res-5 are stacked on it.
- Holdout wall: Melbourne 2026-09-22 (2026-09-21T14:00Z).
  - `window.json`: holdoutFrom 2026-09-23, embargo 1, confirmed by the DECISIONS sealed-window ruling @ a947f0f.
  - A registry, when present, must agree with the wall; a missing one does not block.
- External audit: the RES-5 rule is chosen on find-days only and hashed before the check. RES-4 definitions are fixed (holderGrowth = distinct owners).
- Review of #120: the permutation test replaces the bootstrap p; MIN_FIND_DAYS = 10.
- DSR is computed over selectable trials only (documented in signals.md §8).

## Open risks and known gaps
- **012efQ #115 FAIL (open):** the C1 drift guard misses the failed-close fee and the exit tip. RES-4's costs could drift from `outcome.ts` without a test failing. Fix: make parity exact, or share `scoringTerms`.
- #115 and #120 depend on #114. If RENT-1 changes before it merges, the RES-4 expected rent term and the RES-5 comparison must be re-derived.
- Trade-flow proxies only: there are no transfers and no funding links, so clusters and holders are approximate.
- Few practice days: Holm across 45 tests needs large effects.
- BT-TAIL changes censoring for slow-slot data. Any evidence scored before #122 is valid only for its own commit.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` on each branch head.
- The heavy tests (`research.test.ts`, `survival.test.ts`) are in vitest's heavy project.
- RES-4: `edge.test.ts` (costs.json regenerates identically, policy-exit copy equality, and parity).
- Wall: the guard tests in `research.test.ts` (planted holdout row throws; the registry must agree).

## Remaining-time estimate
- #115 parity fix: about 30–60 min.
- Base merges after #114: about 20 min each.
- Phase B per study: about 1–2 h once the data exists.
- Uncertainty: high; it depends on the review outcomes and when DATA publishes.
