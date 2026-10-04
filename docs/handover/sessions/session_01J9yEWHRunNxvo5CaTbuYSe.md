# Handover: session_01J9yEWHRunNxvo5CaTbuYSe (stats builder)

## Role, cards, model
- Role: builder for the core statistics (`packages/core/src/stats/**`) and the promotion gates G0–G5. I report to the supervisor, session_01Bne9GqXR99gJn6D9U2mJFZ.
- Cards:
  - STATS-1: labels, statistics, gates.
  - STATS-1b: external review.
  - STATS-1c: SPA, day-level DSR, holdout registry.
  - STATS-1d: trailing U1 demotion.
  - STATS-1e: SPA short-regime merge and calibration.
  - STATS-1f: G1 on the registered test.
  - STATS-1g: external audit S1, S3 and S4.
- Model: the high-complexity tier of the model range in `CLAUDE.md`, at the session's default effort. The exact identifier is in the session record and is kept out of the repo by policy.

## PRs and branches
| PR | Branch | Head | State | Review |
|---|---|---|---|---|
| #8 | claude/stats-gates | f55274a | merged (450f9b4) | passed before merge |
| #52 | claude/stats-1b | fe03dec | merged (2609e1a) | two review rounds; round-2 fixes a8519ad, merged after a pass |
| #62 | claude/stats-1c | 547af3c | merged (1fa82fd) | review fixes 33a18fd and 0165048 (BT delta), merged after a pass |
| #96 | claude/stats-1d (with 1e) | 22ce01c | merged (4ea8f5e) | 1e review additions 666284d, merged after a pass |
| #109 | claude/stats-1f | f6c2979 | merged (77bec22) | B1 fixed at 73e15fe, merged after a pass |
| #129 | claude/stats-1g | 89df086 | **open, draft**, base ccr-14987baf-i6lrsl | not reviewed yet (reviewer 01FHfb assigned) |

The verdict SHAs of the merged PRs are in their PR review threads on GitHub; the merge commits above contain the reviewed heads.

## Done (summary)
- `packages/core/src/stats/` holds the pure stats library:
  - binomial, bootstrap, descriptive, e-process, holm, PBO, power, predictive, Sharpe/PSR/DSR, SPA, trials and rng;
  - `holdout.ts`: the registry and its attempt rules;
  - `g2rule.ts`: the n_power simulation;
  - `gates.ts`: gates G0–G5.
- The rules behind each change are written up in `docs/DECISIONS.md`: the STATS-1b section (line ~800), the STATS-1c section (~815), and the dated STATS-1d to 1g entries (~846 onward).
- Tests:
  - `packages/core/test/stats-*.test.ts`: gates, math, simulation, SPA, holdout and the others.
  - `.github/workflows/spa-calibration.yml` runs the full 300-run SPA calibration by hand.

## Work in progress
- PR #129 (STATS-1g) is complete, pushed and green locally:
  - `pnpm check` passes, 153 files and 4,520 tests, on 89df086 (base 5087bd4 merged in).
  - It is still a draft. CI skips draft PRs by design (`ci.yml`), so CI has not run yet.
- Nothing is half-done, and there are no uncommitted changes.

## Next steps
1. Mark #129 ready for review so CI runs, then get it reviewed (planned reviewer: 01FHfb).
2. If the reviewer finds something: fix it with a test that fails before and passes after, merge `origin/ccr-14987baf-i6lrsl` with a merge commit, and run `pnpm check`.
3. Merge once the review passes and CI is green on a head that contains the latest base.
4. Optional follow-up the audit did not ask for: make G3's agree checks cluster-robust too. They still assume independence, which can only add disagreements, so it is safe as it is.

## Findings and numbers (all reproducible from the tests)
- **S1:** the old union bound was 3·(0.05/3) + 0.05 = 0.10, so only 90% joint coverage. Now α/4 = 0.0125 per part. Test: `stats-gates.test.ts`, the S1 case.
- **S3:** the audit's counterexample (same n, days, mean and SD; independent creators against one creator) now gives different fingerprints. n_power is validated on an independent seed stream, and G2 needs power ≥ goal − 1.645·SE, with SE = √(p(1−p)/sims). Tests: `stats-gates.test.ts`, the S3 cases.
- **S4:** 2,000 runs with ICC 0.5, 5 trades per creator, 20 creators a side and a true gap of 0. The classic one-sided 95% bound missed in 17.5% of runs, the CR1 cluster bound in 4.45%. Test: `stats-simulation.test.ts`, the S4 coverage case.
- **STATS-1e/1f SPA calibration:** on the real 64-day layout, 300 runs per scenario over 12 scenarios. The promotion rule passed a variant in ≤0.67% of runs, and the global test rejected in ≤4.3%. Re-run with the `spa-calibration.yml` workflow.
- **STATS-1:** family-wise error across separate G2 calls, measured on 2,000 null runs (commit fbc1215).
- Every other number (DSR FPR and power, demotion power per universe, MIN_DAYS 10, the 300-trade / 10-day floor) is in `docs/DECISIONS.md` with its test.

## Rulings and decisions
- G1 gates on SPA (owner: "Spa", 2026-10-04 14:33 Melbourne). The test is stored in the holdout registry and the DSR is descriptive only.
- The SPA short-regime merge rule (STATS-1e, supervisor ruling).
- Holdout registry rules (STATS-1c): an attempt is spent at registration, the family size is locked, E and the tail are fixed, and "extend" is refused.
- STATS-1g: α is budgeted across four parts, the consistency intervals are not widened, the fingerprint is an exact canonical string (no crypto in stats), and the veto gap is CR1 by creator.

## Risks and gaps
- G3's agree intervals assume independence. This is conservative here, because it can only cause more disagreements.
- The CR1 bound with few clusters: a side with fewer than 2 creators is treated as unmeasured, so the worst case applies. With few clusters it is still only approximate.
- The canonical fingerprint string grows with the number of trades. It is fine at the expected sizes (hundreds of trades).
- The stats module must stay pure: local imports only, and no crypto, Date, Math.random or process.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- `npx vitest run packages/core/test/stats-gates.test.ts packages/core/test/stats-simulation.test.ts`
- Full SPA calibration: run `.github/workflows/spa-calibration.yml` by hand.

## Remaining time
- #129: review plus CI is about 20–40 minutes, and a review round adds about 30–60 minutes. Uncertainty is ±50%, depending on the findings.
