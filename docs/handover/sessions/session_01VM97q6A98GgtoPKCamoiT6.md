# Handover: session_01VM97q6A98GgtoPKCamoiT6 (builder, ops)

Written 2026-10-04, about 19:15 Melbourne time (AEDT), on the owner's handover order.

## Role, cards, model

- **Role:** builder. I reported to the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ) and opened draft PRs into `ccr-14987baf-i6lrsl`.
- **Cards, in order:** OPS-1e (server extras), OPS-1h (live view never waits unseen), SWITCH-1 (#110, the host runs the release's own worker), API-1 (#118, worker status fields for the app card) and E2E-DRILL (#126, an e2e race on the push path).
- **Model:** the high-complexity model of CLAUDE.md's model range, at the session's default effort. The exact id is in the session record, not here (no model ids in the repo).

## PRs and branches

| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #110 SWITCH-1 | `claude/switch-1` | fec3404 (merged as 669de71) | merged | 01Ty8L PASS at 692862e; the ops review passed. The supervisor merged the base in (fec3404). |
| #118 API-1 | `claude/api-1` | **62242b3** | open, marked ready | 01DdN4: FAIL at 7433148 (B1, B2); FAIL at ca0648c (throw path and mark fallback); PASS at 32c14d9. 62242b3 is not reviewed yet: it needs 01DdN4's delta from 32c14d9. |
| #126 E2E-DRILL | `claude/e2e-drill` | 2575ee1 | open, marked ready, sent to 01Ty8L | No verdict yet. |

**Local only, never to be pushed:** local `claude/switch-1` holds two unpushed commits, 217e422 and 84a403a. 217e422 made the OOM process check conditional, and the supervisor ruled that the strict check stays. Drop them. The ruling is under Rulings.

## Done

- **SWITCH-1 (#110, merged):**
  - `ops/host/files/usr/local/lib/zeroed/worker-smoke` runs a trial of a release's worker in transient units, under the worker unit's sandbox.
  - `zeroed-update` runs that trial, then switches, holds, and rolls back with an alert if the worker doesn't stay up.
  - The unit has `OOMScoreAdjust=-500`; the trial runs at +1000.
  - `ops/host-config.json` sets `"worker": "release"`.
  - `zeroed-check` alerts when `serve reset` fails (the #108 nit).
  - e2e section 10b2 covers all of this. DECISIONS has the SWITCH-1 entry.
- **API-1 (#118, at 62242b3):**
  - `/api/v1/paper/status` serves `haltReasons`, which include the account's risk stops: daily-loss, weekly-loss, weekly-review, kill-switch, wallet-below-kill-line, loss-cooldown, loss-day-pause, loss-review, session-ended, max-open-positions, risk, and risk-unknown.
  - Status also serves `exitCapable`, `alerts`, and `regime` with `current` and `waived`.
  - The worker answers "Not running" for live and backtest; the app refuses a `notRunning` answer for paper.
  - Code: `packages/worker/src/engine/strategy.ts` (`#readStops`, `riskStops()`, `RegimeView`) and `packages/worker/src/run/api.ts` (`stopHalts`, `STOPS_MAX_AGE_MS`).
  - App: `contract.ts`, `schemas.ts`, `modes.ts`, `dashboard/Sections.tsx` (`statusRows`) and `dashboard/labels.ts`.
  - Tests: `packages/worker/test/status-stops.test.ts`, `worker-status.test.ts`, `apps/web/test/status-card.test.ts` and `not-running.test.ts`.
  - Docs: ARCHITECTURE §12.4 (App API row) and the DECISIONS API-1 entries.
- **E2E-DRILL (#126):**
  - `ops/test/e2e.sh`: 10b2 waits for this invocation's start line, then for /health answering with that boot.
  - Section 7 waits for the server's end states after a rotation.
  - Cleanup writes `logs/failure-worker.txt` on failure.
  - `.github/workflows/ops-e2e.yml` (add-only): prints that file and uploads the logs as an artifact on failure.

## Work in progress

- **API-1 at 62242b3:**
  - It contains base 5087bd4 (#117), merged as 516f687. The one conflict was in `#evaluate`; it kept #117's `s0Diagnostic` regime call and `#waived`, plus API-1's `#regime`.
  - It also merges the #126 fix (02c5c03), so its ops e2e can pass. That merge no-ops once #126 is in the base.
  - Last change (62242b3): `regime.waived` is served. With any waived part the card shows "Regime: On (practice: … not judged)" and "Entries: On (practice)", never a plain "On".
  - **Not run on 62242b3:** the full `pnpm check` was stopped by the handover order. Run on it: `pnpm typecheck` (clean) and the app tests plus status-stops and worker-status (307 tests, all pass). The full check last passed at 32c14d9, with 4603 tests.
- **#126:** CI on 2575ee1 had not reported when I stopped.

## Next steps, in order

1. On `claude/api-1` (62242b3), run `pnpm install --frozen-lockfile && pnpm check`. If green, send the SHA to the supervisor for 01DdN4's delta, which covers 32c14d9 → head: the base merge, the #126 merge and the waived regime parts.
2. Watch #126 CI. Ops e2e must pass on the PR. After the merge, the push run on the base must pass too; it is the path that failed twice before.
3. Once #126 merges, merge the base into `claude/api-1` again, with a merge commit.
4. Leave for later, not assigned:
   - an e2e sandbox opt-in for the OOM process check (`ZEROED_E2E_ALLOW_NO_OOM`, opt-in only, with CI proven to fail without it);
   - the API-1 note shown when the daily-loss room after one minimum trade's costs is gone.

## Findings and evidence

- **Push-path e2e failure** ("the drill endpoint is not on", runs 37185231700 and 37186416636):
  - The 10b2 wait searched the whole unit journal. On the push path the update step had already deployed signed 669de71, whose worker logged the same "Worker up … release <sha12>" line.
  - The wait matched that old line. The probe then ran while the new invocation was still in ExecStartPre (port closed).
  - Reproduced locally on 669de71: the only matching line was from 07:42:51, the restart came at 07:45:53, and the restarted worker takes about 30 s to log its own line because of the deployer index wait.
  - The fix (d4b98b1) passed all 23 checks on the same path.
- **Rotation race (section 7):** the heartbeat key was compared before the server stored it. Seen once locally; the keys matched a minute later.
- **OOM in the sandbox:** this cloud sandbox's kernel refuses any negative `oom_score_adj`, even to root. `echo -1 > /proc/self/oom_score_adj` gives an I/O error, so the e2e process check fails locally only. GitHub's runner allows it. Local evidence runs skipped only that line, in an uncommitted edit.
- **Regime freshness bound:** 2 × `evaluateEveryMs`, where `evaluateEveryMs` = policy `maxQuoteAgeMs` (`packages/worker/src/run/settings.ts:47`). That is 4 s on the trial policy.

## Rulings received

- **Strict OOM check:** the e2e −500 check stays strict; no conditional check in the repo (supervisor, 2026-10-04).
- **B1 risk stops:** serve them as halt codes, read-only from the worker's risk state. "Entries: On" only with none active and a current regime. No change under `packages/core/src/risk/**`.
- **Status judging:** status judges the account as the entry path does: `fallback:false`, and `riskSnapshot` null means unknown.
- **evaluateExit fault code:** a separate core card, RISK-FAULT, for a risk reviewer.
- **S0 diagnostic:** serve the waived regime parts; never show a plain "On" while any part is waived.
- **#126 workflow change:** the failure diagnostics and log artifact in `ops-e2e.yml` are approved (add-only).

## Risks and gaps

- `evaluateExit` returns nothing tripped when it throws, the same as a clean account. Status guards against this with `riskSnapshot`; the core fix is RISK-FAULT.
- Stops older than 5 s read `risk-unknown`. In a quiet market with no events the card would read Off. That errs on the safe side.
- The status daily-loss meter counts only losing trades. When it reaches the limit, `daily-loss` is also served, which is conservative.

## How to verify

- `pnpm install --frozen-lockfile && pnpm check`
- `npx vitest run packages/worker/test/status-stops.test.ts apps/web/test/status-card.test.ts apps/web/test/not-running.test.ts`
- Ops e2e: `bash ops/test/e2e.sh` (needs Docker; CI runs `.github/workflows/ops-e2e.yml`).
- `node ops/build-install.mjs --check` (the README install pin).

## Remaining time

| Task | Estimate |
|---|---|
| API-1 full check and delta review | about 30 to 60 min |
| #126 review and CI | about 30 to 45 min |

Uncertainty is moderate: CI on the push path and reviewer findings can add a round each.
