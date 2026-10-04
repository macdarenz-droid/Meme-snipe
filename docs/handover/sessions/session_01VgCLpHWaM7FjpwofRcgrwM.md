# Session 01VgCLpHWaM7FjpwofRcgrwM: runner, CI and ops builder

## Role, cards, model
Builder. Cards came from the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ) as cross-session messages. Model: Opus 5.5 (`claude-opus-5-5`).

Cards, in order:
- RUN-1, 1b, 1c, 1d, 1e, 1f: the dry-run runner;
- GATE-2;
- CI-1, MEM-1, CI-1b;
- then the ops queue from the 2026-10-04 external audit: OPS-GATE (O2), PNPM-CLAIMS (O3), SEC-1 (O1). Reviewer for all three: 01Ty8L (OPS).

## PRs and branches (as of 2026-10-04 ~20:15 AEDT)
| PR | Branch | Head | State | Review |
|---|---|---|---|---|
| #32 RUN-1 | see PR | (merged) | closed | see PR |
| #37 RUN-1b | see PR | (merged) | closed | see PR |
| #49 RUN-1c | see PR | (merged) | closed | see PR |
| #64 RUN-1d | see PR | (merged) | closed | see PR |
| #76 RUN-1e | see PR | (merged) | closed | see PR |
| #91 RUN-1f | see PR | (merged) | closed | see PR |
| #94 GATE-2 | claude/gates-stage | e52dae7 | merged 02:05Z | passed |
| #105 CI-1 | see PR | (merged) | closed | see PR |
| #112 MEM-1 | see PR | (merged) | closed | see PR |
| #116 CI-1b | claude/ci-1b | c5aaf88 | open, CI green on c5aaf88 | reviewer recheck asked for wording only (§12.4 write-order text as the supervisor ruled); supervisor merges |
| #134 OPS-GATE | claude/ops-gate | 8c3aef3 | open draft; e2e was red on ec0d3e4, fix 8c3aef3 made e2e green (run 37189806877); `check` skipped while draft | not reviewed (reviewer 01Ty8L) |
| #135 PNPM-CLAIMS | claude/pnpm-claims | 3fc13c3 | open draft; diff approved by supervisor | not reviewed |
| #136 SEC-1 | claude/sec-1 | 6280ae5 | open draft, **WIP** | not reviewed |

## Done
- RUN-1 to RUN-1f, CI-1: `packages/runner/**` (runner.ts, stub/worker.ts, tests), docs/ARCHITECTURE.md §12.4.
- MEM-1: `packages/backtest/src/report.ts` uses one shared Melbourne-day formatter; `research.test.ts` has a memory bound.
- CI-1b (#116):
  - `openedSince` (trades opened after the reply must be kept);
  - entry lines carry `universe`;
  - a guard on the memory test (isMainThread, heavy project with `pool: 'forks'` and `isolate: true`).
- OPS-GATE (#134):
  - logic.sh adds `commit_verdict NAME` and `e2e_commit REPO REF`. The server (`zeroed-update`) and `ops/deploy/tag.sh` both use them.
  - A commit is green only when:
    - GitHub Actions' `check` succeeded on it (the latest run counts);
    - no other GitHub Actions run on it failed or is still running;
    - GitHub listed every run it reports (`total_count`);
    - `e2e` succeeded on the newest first-parent commit at or before it that touched the ops e2e paths (`E2E_PATHS`, test-checked against ops-e2e.yml).
  - The preview release waits for `check` (`.github/scripts/require-check.sh`).
  - Other files: README gate list and re-pin (3c5a8fc), DECISIONS row, install.sh regenerated.
- PNPM-CLAIMS (#135):
  - `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`, `trustPolicy: no-downgrade` and `blockExoticSubdeps: true`.
  - New test `packages/ops/test/supply-chain.test.ts`.
  - ARCHITECTURE.md:376 updated.

## Work in progress
- **#134**:
  - CI run 37188909082 (e2e) failed at "deployed with a failed check". Cause: the newest signed merge (7d5e203, the #126 merge) touched ops, so it is its own e2e commit. e2e.sh pre-marked it green, and the update timer deployed it before the gate cases ran.
  - Fix 8c3aef3: don't pre-mark a test commit that is its own e2e commit. Pushed; e2e green on 8c3aef3 (run 37189806877).
- **#135**:
  - 231dc8b's new test was red under `pnpm check`. pnpm passes its settings to child processes as npm_config_* variables, so the "without the settings" installs saw them too.
  - Fix 3fc13c3 drops those variables in the test. `pnpm test packages/ops/test/supply-chain.test.ts`: 4/4 pass.
  - A full `pnpm check` on 3fc13c3 was still running at handover.
- **#136 SEC-1** (WIP):
  - Code and tests are written. `apps/web/test/android-workflow.test.ts` passes (9 tests). The full `pnpm check` has not been run.
  - Not reviewed.
  - It will conflict with #134 in the android-preview.yml release job.

## Next steps (in order)
1. #134:
   - Confirm `e2e` is green on 8c3aef3; if it is red, read the e2e step summary first.
   - Merge the base with a merge commit.
   - Request review from 01Ty8L.
2. #135: confirm `pnpm check` and CI are green on 3fc13c3, then request review.
3. #136:
   - Merge the base after #134 lands. In the release job, keep both new steps in this order: `Require CI's check on this commit`, then `Check the signing certificate`, then publish.
   - Run `pnpm check`, then get a review (security plus OPS).
4. Owner steps for SEC-1, from docs/ANDROID_PREVIEW.md "Owner steps" on the sec-1 branch, after #136 merges:
   - generate the keystore with keytool;
   - set the secrets `PREVIEW_KEYSTORE_B64` and `PREVIEW_KEYSTORE_PASSWORD`, and the variable `PREVIEW_CERT_SHA256`;
   - delete the cache `zeroed-preview-debug-keystore-v1`;
   - uninstall and reinstall the app on the phone.
5. #116: the supervisor merges it after the reviewer's wording recheck.

## Findings and research results
- **pnpm 10.28.0 settings.** Each was tested by a real install, in a scratch project and now in supply-chain.test.ts:
  - `minimumReleaseAge: 10080`: `pnpm add typescript@next` resolved 7.1.0-dev.20260926.1 with the setting and 20261003.1 without it.
  - `blockExoticSubdeps: true`: a git subdependency is refused with `ERR_PNPM_EXOTIC_SUBDEP`. A tarball-URL subdependency was **not** refused in my runs (possible pnpm gap or a cache effect; not investigated), so nothing claims it.
  - `trustPolicy: no-downgrade`: against a fake registry where 1.0.0 had provenance and 1.0.1 did not, `zz@1.0.1` is refused with `ERR_PNPM_TRUST_DOWNGRADE`. pnpm's rank is trustedPublisher (2) > provenance (1) > none, comparing earlier-published versions by date.
  - Before the change, all three read `undefined` in `pnpm config get`. `.npmrc` already had `ignore-scripts=true`.
  - pnpm passes its settings to children as `npm_config_*`. Any test that runs pnpm under `pnpm test` must strip those variables.
- **SEC-1 exposure**, verified without reading the key:
  - Run 37188909095 (pull_request event, PR #134) skipped "Create debug keystore", which means the cache restore hit.
  - So pull-request runs restore `zeroed-preview-debug-keystore-v1` from the base branch.
  - A fork's pull request runs the fork's workflow files, so the `if:` guard at android-preview.yml:80 does not protect against forks. Unless fork-run approval stops it, a fork can add a cache restore in any workflow it runs.
  - Holding that key lets someone sign an APK that installs over Zeroed.
- **OPS-GATE**: `e2e_commit` on the base tip at 2026-10-04 08:20Z gives 669de71, whose e2e was red. Once #134 merges, deploys stay blocked until an ops change lands with a green e2e. That is intended.
- Earlier runner findings, all in merged PRs and ARCHITECTURE §12.4:
  - The tabletop flake was reproduced with `ZEROED_STUB_EXIT_GAP_MS` and fixed by write order: exits are journaled before state drops them, entries after state saves them.
  - The research-test memory growth came from creating an Intl formatter per call.

## SEC-1 plan (as built in #136)
- Pull requests and other branches always sign with a throwaway key. They never restore the cache or read the secret.
- The integration branch (push or dispatch):
  - decodes the `PREVIEW_KEYSTORE_B64` secret to `~/.zeroed-preview/preview.p12` with umask 077;
  - refuses unless the keystore opens with `PREVIEW_KEYSTORE_PASSWORD` (OpenSSL, with a fallback to `-legacy`) and its certificate SHA-256 equals the `PREVIEW_CERT_SHA256` variable;
  - gradle signs with alias `zeroed-preview` and that password.
- The APK must have exactly one signer, and it must be the pinned certificate. This is checked in the build job and again in the release job before publishing.
- Before the owner adds the secrets, the cached key is still used and every run warns, so nothing breaks. Setting the variable without the secret fails.
- Rotation means a new keystore, the same steps, and an uninstall and reinstall on the phone (app data is not backed up).

## Rulings received
- §12.4 wording for CI-1b, as the supervisor gave it: the stub follows the write order; the real worker's exits stay ledger-first until WORKER-ORDER; until then a kill between the two writes can make a drill fail and can never make one pass.
- Supervisor-owned files (.github, package.json, the lockfile, .npmrc, pnpm-workspace.yaml) are add-checks-only, with the diff sent to the supervisor first. The pnpm-workspace.yaml diff was approved at 08:28Z.
- 08:26Z: handover pause, start no new work. SEC-1 was already built by then, so it is pushed as WIP.

## Open risks and gaps
- #134 changes `zeroed-update` on servers. Until an ops commit with a green e2e lands, the server deploys nothing new. That is intended, but say so when merging.
- #136: the GitHub cache entry stays readable until it is deleted (an owner or supervisor step). After rotation, the old key is worthless.
- The tarball-URL case of `blockExoticSubdeps` is unverified.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check`
- Focused tests:
  - `npx vitest run packages/ops/test/host-logic.test.ts -t 'deploy gate'`
  - `npx vitest run packages/ops/test/ops-files.test.ts -t 'deploy tag'`
  - `pnpm test packages/ops/test/supply-chain.test.ts`
  - `npx vitest run apps/web/test/android-workflow.test.ts`
- `node ops/build-install.mjs --check`
- `ops/test/e2e.sh` runs in CI only (Docker).

## Remaining time (rough, ±50%)
| Task | Remaining |
|---|---|
| #134 green and reviewed | ~30 min of work plus review |
| #135 | ~10 min plus review |
| #136 merge with #134, check, review | ~45 min plus review |
| Owner's SEC-1 steps | ~20 min of the owner's time |
| **Total** | **about 1.5 h of agent work** |
