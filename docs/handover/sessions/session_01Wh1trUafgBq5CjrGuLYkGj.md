# Handover: session_01Wh1trUafgBq5CjrGuLYkGj (PAPER-1 builder)

## Role, cards, model
- Role: builder. Card: PAPER-1, "paper settlement must match the historical backtest's settlement" (audit of d92b73e: M4, M5, and the rent part of M8). Supervisor: session_01Bne9GqXR99gJn6D9U2mJFZ.
- Model: configured as `claude-opus-5-5`. The model that served each turn was not checked with get_session.

## PRs and branches
- PR #133, draft, branch `claude/paper-1` → `ccr-14987baf-i6lrsl`, head `65283f8608e8e539594d1893af1e4a9889f1299d`. Open, not reviewed yet: no review verdicts. Everything is pushed; nothing is WIP.
- The branch also merges in `claude/rent-1` (PR #114, RENT-1, not merged when this was written) and the latest base `5087bd4` (WORKER-1e). Both were merged with merge commits.
- Commits: 73c248a (main change), its follow-up test commit, then the base merge 65283f8.

## Done
- `packages/core/src/fills/settle.ts` (new) is the one settlement module, used by both the backtest and paper:
  - `feeParts`: the fee by attempt outcome;
  - `TokenAccounts`: dust, close draw, sell-only, and `restore` after a restart;
  - `lateFillOf`, `lateFillClaims`, `entryShare`: LEDGER-1b late fills;
  - `tradeRent` (the RENT-1 rule), `tradeNet`, `toUsd`, `tradeUsd`: each flow at its own SOL price, plus the split into `trading` and `solMove`.
- Backtest refactored onto it, with no change in behaviour: `backtest/src/sim/world.ts`, `backtest/src/trades.ts`, `backtest/src/report.ts`. All backtest tests pass unchanged.
- M4:
  - `worker/src/run/account.ts`: `paperTradeLamports` and `PaperAccount.settle`. Every attempt's fee is counted once per signature, failed ones included. A fill counts only once the book holds it.
  - account.json `strayFees` / `strayFolded`: fees of entries that never filled. Folded before the current Melbourne week, so the file stays bounded.
  - Risk `AccountCost.kind` gains `'failed_entry'` (`core/src/risk/types.ts`).
  - Wiring in `worker/src/run/worker.ts` (`#settle`): on book events, on a landed failure (`PaperWorld.landedFailed`), at the end of the reconcile, and at the first SOL price.
- M5:
  - The paper `netPnl` uses `tradeUsd`.
  - `worker/src/run/api.ts`: the trade record adds `netSol`, `tradingUsd`, `solMoveUsd`; stats add `netSol`, `solMoveUsd`; the rent and cost fields carry real values.
  - Web: `apps/web/src/api/contract.ts`, `schemas.ts`, `dev/dashboardFixtures.ts`, `dashboard/Trades.tsx` (rows "Net in SOL", "Trading", "SOL price move"), `dashboard/Sections.tsx`, and `lib/money.ts` (`formatSolExact`).
- M8:
  - `worker/src/run/paper-world.ts` uses `TokenAccounts`. A failed close fails the attempt with the reason `close failed`.
  - The SimLeg `closes` follows the account's sell-only state.
  - The state is rebuilt from paper.json at startup. Seeds are `paper:<sig>` and `paper:<mint>:<sig>`.
  - The `strategy.ts` comment is updated.
- DECISIONS: new section "Paper settlement equals the backtest's (PAPER-1)", including the before-live item. The API line now says rent is real.

## Work in progress
None. The PR waits on its review. Risk review (017PBU) is required for the `failed_entry` kind; the supervisor asked for it.

## Next steps
1. Get the reviews on #133: a fresh reviewer, plus 017PBU for risk/types.ts.
2. Fix any findings and merge `origin/ccr-14987baf-i6lrsl` with a merge commit. Once #114 merges, its diff drops out of #133.
3. CI was not watched yet after the push. Check it at head 65283f8.

## Findings and numbers
- M4 reproduced on the base: after one landed failed entry, the wallet was 25,000 lamports too high (base 5,000 + entry priority 20,000). The audit case is `attemptFee(500,000 priority, failed)` = 505,000.
- M5 example: buy 0.02 SOL at $100, sell 0.024 SOL at $80.
  - Before: +$0.32.
  - Now: −$0.08 = +$0.32 trading − $0.40 SOL move.
- Evidence: `packages/worker/test/paper-settlement.test.ts` and `packages/core/test/fills/settle.test.ts`.
- Fail-before: 7 of the 10 paper-settlement tests fail on the base.
  - The 3 that pass are guards: the fee sanity check, the clean close, and the unbooked-sell test, which was added after the fix.
  - The daily-trip test and the fold tests fail on the base because `settle` does not exist there.
- Mutants: 12, all killed. The script is at `docs/handover/sandbox/session_01Wh1trUafgBq5CjrGuLYkGj/mut.py`.
- `pnpm check` at 65283f8: 155 files, 4537 tests, all passed.

## Rulings
- Supervisor: `strayFees` and `strayFolded` are approved under the stored-data ruling, on two conditions: kept bounded by folding, and deduplicated across the fold. Both are done and tested.
- The `failed_entry` kind is approved in principle, pending 017PBU's pass and a daily-trip test; the test is done.
- Merging `claude/rent-1` into this branch was approved.

## Open risks and gaps
- Existing test changed: boundary-marks "NAV peak rises" now uses a 40% price rise instead of 30%. Rent now leaves the paper wallet at entry, so 30% no longer passes the pre-entry peak.
- The fold dates the folded total at the latest folded record. That moves older costs later, which can only lower equity in between (the safe side).
- Paper slippage cost counts only the extra slippage; the backtest's also includes price impact. Net results are the same.
- Before live: transactions that land late or have an unknown result after a crash belong to the signer work.
- An orphan fill on an abandoned entry would double count its failed fees. This cannot happen in paper (attempts die before abandon), but it is not guarded.
- Attempts in old paper.json files without `sentAtMs` are dated at the account's opening.

## How to verify
`pnpm install --frozen-lockfile && pnpm check`. Focused:
```
npx vitest run packages/worker/test/paper-settlement.test.ts packages/core/test/fills/settle.test.ts packages/worker/test/boundary-marks.test.ts apps/web
```

## Remaining time
Implementation is done. Review rounds: about 1–3 hours, depending on findings (uncertain).
