# Handover: session_01FHfbJwz7sbf2eVDNRxMigZ (fresh-context reviewer)

Written 2026-10-04, about 19:20 Melbourne (AEDT).

## Role, cards, model
- Role: a fresh-context **reviewer** (AGENTS.md "Reviewer"), working on requests from the supervisor session `session_01Bne9GqXR99gJn6D9U2mJFZ`. I send verdicts to the supervisor only. I never approve, comment, push or merge on GitHub, and I own no code branches.
- Cards reviewed: RES-3 (#47), STATS-1b (#52), STATS-1c (#62), STATS-1d/1e (#96), G3 report (#98), STATS-1f (#109), RES-4 (#115) and RES-5 (#120), plus stats rulings for BT-2's RES-4 (b)/(c).
- Model: configured as `claude-opus-5-5`. I did not confirm the serving model per turn.
- Method: local `pnpm check` or the focused test files, then mutation checks: I replace a string in the source, run the test, and restore from a backup. GitHub Actions has been locked by a billing issue since 4 Oct 04:20 UTC, so every verdict rests on local runs.

## PRs reviewed (last verdict and its SHA; the PR head at handover is from `git ls-remote`)
| PR | Card | Verdicts (SHA) | Head at handover |
|---|---|---|---|
| #47 | RES-3 | FAIL 3a57ced, FAIL 89c6375, FAIL b4598eb, PASS 658a01e, PASS delta 4c8e8a6 | eb8d7ce |
| #52 | STATS-1b | FAIL 7998c2c, FAIL b5296a0, PASS 9794b64 | fe03dec |
| #62 | STATS-1c | FAIL fcdd901/7c13f54, PASS for merge fa9ad64 | 547af3c |
| #96 | STATS-1d+1e | FAIL e23e971, PASS 666284d | 22ce01c |
| #98 | G3 report | FAIL ea88197, FAIL 07dede2, PASS c1f3f45 | c1f3f45 |
| #109 | STATS-1f | FAIL 8e9d7f1, PASS 7a52940 | f6c2979 |
| #115 | RES-4 | FAIL 1f83fd9, FAIL 6915f26 (one line left) | 8dc0f49 (**not reviewed**) |
| #120 | RES-5 | FAIL 8a7856e | 8a7856e |

Each PASS carried the condition: merge base again and get green CI on that exact head before merging. A head that differs from the verdict SHA is valid only after the delta is re-checked; base merges alone were not re-reviewed.

## Open findings
- **#115 RES-4 (FAIL 6915f26), blocking:** in edge.md §4, the first bullet still says every registered hypothesis gets G2 on the holdout. Replace it with: "For each registered hypothesis: whether it beats costs and S0 on practice days (G1, SPA over all six, k = 6). The one hypothesis per universe that SPA picks then gets G2 once on the sealed holdout (Holm across U1 and U2)." Head 8dc0f49 adds the audit definitions (holder growth counts owners; U2 flow renamed). **Not reviewed**: re-check the §4 line, that the preregistration sha256 in edge.md matches the file (it changes if the JSON changed), and edge.test.
  - Non-blocking, from 1f83fd9: let BT-2 load preregistration.json and refuse a freeze if the hash differs (now in edge.md §3 as a BT-2 requirement). BT-2's trial log defaults to `<out>/trials.json`, so a new `--out` starts an empty log (BT-2 study.ts:214).
- **#120 RES-5 (FAIL 8a7856e), blocking:**
  - B1, the find-day p-value is invalid. `dayBootstrap` in survival-analysis.ts computes p = 2·min(share ≤ 0, share ≥ 0), with no (1+k)/(1+B), and it is often exactly 0 with few days. Null simulation through the real `freezeRule` (2000 replicates, seed 17, 15 features × 3 ages, 80 decisions per day per age, labels independent of every feature, 20 runs each): a rule is chosen in 20/20 runs with 2, 3 and 4 find days, and 10/20 with 10 find days. The target is ≤ 5%.
    - Fix: a permutation test that shuffles labels within day × stratum, p = (1+k)/(1+B), B ≥ ceil(20·45/α); a registered minimum of 10 find days (otherwise "no rule"); and a null-calibration test that includes the 2-find-day case.
  - B2, the one look is not enforced. The hash exists only inside the process, so a re-run with other `--replicates`, `--window` or `--dataset` can freeze another rule after the check results were seen.
    - Fix: two commands. `freeze` writes and commits research/survival/frozen.json (rule, hash, dataset hash, find days, replicates, seed) and reads no check label. `check` refuses unless frozen.json matches, and refuses to overwrite.
  - Non-blocking:
    - N1: split on the window's readable days, not on labelled days.
    - N2: label the comparison's 10 intervals "unadjusted, exploration".
    - N3: mark the RES-4 rows "not RES-4's registered test (PLAN_BARRIERS exits)".
- **#109 STATS-1f (PASS 7a52940), carried to BT-2:** `G1Input.holdoutRegistry` is typed `Pick<HoldoutRegistry,'g1Test'>`. BT-2 must pass the registry it read with `readHoldoutStore`, never a literal, and pin that with a test at the call site.
- **#62 STATS-1c (PASS fa9ad64):** reword the `G3Input.dryRunHours` doc: decisions are cut at evaluateAtMs, and outcomes are read to evaluateAtMs + outcomeTailMs.
- **#52 STATS-1b (PASS 9794b64):** `insideReport` is a claim the caller supplies. The card that produces the B5 before/after report must keep the report file and its hash in the repo.
- **#47 RES-3:**
  - signals.md §1 says "Embargo = 1 full day", but the real gap to a UTC-registered holdout is 10–11 h.
  - If BT-2 uses medianTargetBps as a take-profit, count it in BT-2's registry.
- **#96:** spa-calibration.yml writes the jsonl only after a loop finishes, so a failing assertion leaves no jsonl (the .txt log still has the output). Acceptable for a job run by hand.

## Review queue at handover
- Re-review #115 at 8dc0f49 or later (the §4 line).
- Re-review #120 after the B1/B2 fixes.
- Review the coming `s0Of` change (an optional per-variant S0 in core spaTest) when BT-2's builder pushes it. For k = 6 it is required, not optional.

## Rulings I gave (supervisor request, 2026-10-04, for BT-2's RES-4 (b)/(c))
- **No G1 or SPA under 10 days.** spaTest throws when T < 10 (spa.ts, SPA_MIN_ACTIVE_DAYS = 10). The early look (1–2 days) reports engine validity and funnel counts only. SPA is G1 on the practice walk-forward window (about 50 days). The holdout uses G2, which has no SE floor.
- **SE floor = 0.0005 of the capital base per day (sound),** registered as a fraction of the base.
  - Why: at the $20 base it is $0.01 a day, 60–200× below any realistic ω (daily SD about 0.03–0.1 of the base). It guards degenerate series only, and the STATS-1c calibration (floor 1e-6) stays valid.
  - Conditions:
    - (i) frozen in the registered plan with g1Test, per attempt;
    - (ii) one calibration case at 0.0005 on the real layout with k = 6 plus per-universe S0, at zero edge, including a sparse variant and an all-costs variant, with global size ≤ α;
    - (iii) never raised later from practice-day ω.
- **Pick rule (sound, Holm family stays 2), with amendments:**
  - (a) rank SPA-passing variants by min(zVsZero, zVsS0), ties by file order;
  - (b) first drop variants whose practice entries per day × 28 < max(300, n_power);
  - (c) the plan's familySize stays 2 whatever G1 finds (today `holdoutPlanOf` uses `c.universes.length`, study/plan.ts:146); a universe with no pick is "no configuration", p = 1 in Holm, "not proven".
- **s0Of is required** for one SPA over six variants: H1/H2/H3/H6 against S0-U1, H4/H5 against S0-U2.

## Findings and numbers (evidence)
- SPA calibration on the real layout with `mergeShortRegimes` ([0,54) [54,64)), measured by me at #62/#96: promotion ≤ 0.67%, global ≤ 4.3% (seeds 123000 and 201000). Without the merge, global reached 7.0%. Pinned 40-run counts are in the core stats tests.
- RES-4 cost table (#115, conservative, $2): break-even 3.74% (U1) to 4.36% (young PumpSwap); at $20, 2.15–3.03%. Reproduced from `packages/backtest/src/research/edge-costs.ts` through edge.test (7/7). The cost math itself was reviewed by reviewer 012efQ.
- RES-5 null simulation: numbers above. The simulation file was temporary and deleted; to re-create it, generate decisions with independent uniform features and Bernoulli(0.3) labels at three ages, then call `freezeRule(data, 2000, 17)` and count non-empty `conds`.

## Rulings I received
- G1 gates on SPA (owner, 4 Oct 14:33). The clamped DSR is reported only.
- The holdout is [09-22, 10-20) in Melbourne days, with a 1-day tail. B5 is a decoder boundary inside the window, judged by `insideReport`.

## Open risks
- Local-only evidence while CI is locked. Re-run CI on each merge head once Actions is back.
- RES-5 as built would hand a noise rule to the check days (B1 above).
- The BT-2 requirements from RES-4 (SPA k = 6, the pick rule, familySize 2, the hash check at freeze, s0Of) are not built yet. They are on BT-2's card (builder 01VBTf, PR #41).

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- `npx vitest run packages/backtest/test/edge.test.ts packages/backtest/test/survival.test.ts`
- `npx vitest run packages/core/test/stats-math.test.ts packages/core/test/stats-gates.test.ts packages/core/test/stats-simulation.test.ts`

## Remaining time (estimate)
- #115 re-check: about 10 minutes.
- #120 re-review after the fixes: 30–60 minutes, including a null calibration re-run.
- s0Of review: about 30 minutes.
- Uncertainty is about ±50%, driven by how many rounds the builders need.
