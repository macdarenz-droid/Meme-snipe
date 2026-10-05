# App queue handover (Supervisor 2)

Owner, Tue 6 Oct about 1:00 AM: a second supervisor (S2) takes the parked **app and screens** tasks below to speed them up. S2 is a different AI agent, not Claude, running on the owner's other account. Supervisor 1 (S1) keeps the bot, server and data work. S1 is the only one who merges and deploys.

From here on, S2 owns this file. S2 keeps it current on its own branch `claude/s2-docs`, which starts from S1's docs branch `ccr-528521bb-f7a7zo`. S1 reads it there and does not edit it.

## S2 events (newest first)

- **2026-10-06 01:50:30 AEDT** — API-1 already independently reviewed on final exact head6af4e43b707960316d8cd8419cb2e513fa9f4b60: api1_api_review APP/API PASS and api1_facts_review strategy/worker facts PASS. Actual contained integration base73c61006b08be35fff804155e6f700fa1c13d7b8. Test expectation follows precise base no-fee-context; preserved full four-part assertion fails without served fix on missing H14 and all10 worker-1e tests pass after. Frozen install/workspace typecheck pass before test-only follow-up. Task head pushed and remote verified. Production changes affect served status only, not gate/risk or actual per-decision waiver facts; values already match existing strict app enums. Completed exact-head independent PASS verdicts for queue items1–6 are now recorded in this handover. Required final full-suite checks and exact-head GitHub check/historical-data are incomplete, and PR verdict publication remains blocked by api.github.com restriction; none is S2-READY. RISK-DIAL has no code authorization: design/risk review/explicit final owner approval still required; SEC-1 historical review remains recorded, owner keystore and preparation outstanding. S1 alone merges/deploys.

- **2026-10-06 01:49:17 AEDT** — Base observation correction: integration advanced to73c61006b08be35fff804155e6f700fa1c13d7b8 during API-1 fetch; API-1 merge ebb19f7c70485b64d1df8e93e3aabc0ae54a419c second parent is73c61006, not earlier efa3b006. Focused API-1 test caught newer base precise no-fee-context code replacing old no-market; keeping exact assertion, updating fixture only. With served fix removed, regression fails specifically on missing H14 waiver; corrected full worker-1e test run in progress before normal follow-up commit and renewed exact-head review. APP-SOL final5ee1d4da independent APP/API PASS pushed/remote verified; full check running. No CI observed and no S2-READY claim. PR review bodies for reviewed tasks are prepared outside repo for publication once api.github.com access is enabled.

- **2026-10-06 01:47:13 AEDT** — APP-SOL independent reviewer app_sol_api_review APP/API PASS on exact corrected head5ee1d4da65e7331895827e42ab90933bc3f67194. Reviewer caught distinct-day unvalued settlement totals; fail-before tests now guard calendar month/daily/cumulative incompleteness, exact late-fill entry size and empty calendar. Reviewed correction independently; default/unknown capability matches frozen integration-base schema and new lamport fields require explicit opt-in. Actual owner-installed APK SHA remains unverified. Builder typechecks and93 focused tests pass; final-head full check running with writable GPG home. EXIT-RUNG reviewed head5c91e8cf95d14c2980533c3e530593e965416ec5 pushed/remote verified. API-1 base merge committed at ebb19f7c70485b64d1df8e93e3aabc0ae54a419c, frozen install and workspace typechecks pass; focused checks running and fresh APP/API plus strategy/worker-facts reviews started. All completed verdicts are recorded here as requested; PR comment publication and exact-head CI still blocked by restricted GitHub API access. No task is claimed S2-READY.

- **2026-10-06 01:45:39 AEDT** — EXIT-RUNG independent exact-head reviews all PASS at5c91e8cf95d14c2980533c3e530593e965416ec5: exit_rung_exit_review EXIT (18 targeted retry/crash/recovery tests plus partial-to-close restart/replay probes), exit_rung_api_review APP/API (29 API/money plus14 late-settlement tests; schemas byte-identical to base), exit_rung_facts_review strategy/worker facts (10 targeted accounting/replacement/retry/restart tests and synchronous signed-rung verification). No new saved shape. Frozen install/typechecks/329 builder-focused tests pass. Full check and GitHub CI still pending, PR evidence publication blocked by API restriction. This head is reviewed, not S2-READY. APP-SOL independent review caught distinct-day unvalued settlement totals; builder is correcting before final verdict. API-1 base merge preparation begins in isolated checkout; only strategy import conflict, preserving both S0 diagnostic set and newer base imports.

- **2026-10-06 01:43:54 AEDT** — FUNNEL-PERSIST reviewed head2810981c56822430d309c9b40de241b4f3d17c7a pushed and remote verified; required full pnpm check now runs with writable GNUPGHOME. EXIT-RUNG builder completed head5c91e8cf95d14c2980533c3e530593e965416ec5 with base efa3b006; frozen install, typechecks and329 focused tests pass, including fail-before actual charged fee regressions. Fresh independent EXIT, APP/API and strategy/worker-facts reviews started on that head. APP-SOL builder is correcting independent APP/API findings before final exact-head verdict/full check. No PR handoff or CI green claimed; API restriction unchanged.

- **2026-10-06 01:41:27 AEDT** — Already reviewed: APP-TRUTH 1790097accb0fa680462a7a595505a95ca2d500b — app_truth_review, APP/API PASS; FUNNEL-TRUTH 0f1a3c386e9d703231bad7fc56d80615b4beb041 — funnel_api_review APP/API PASS and funnel_facts_review strategy/worker facts PASS; FUNNEL-PERSIST 2810981c56822430d309c9b40de241b4f3d17c7a — persist_api_review APP/API PASS, persist_facts_review strategy/worker facts PASS, persist_data_review saved data PASS. All were independent of the builder and reviewed these exact heads. Historical prior-head reviews remain historical. Final PERSIST overflow correction independently reproduced live/replay agreement, with all31 focused tests passing. Required PR verdict publication and exact-head GitHub check + historical-data evidence remain blocked by restricted api.github.com access; these are reviewed, not S2-READY. Completed local full checks: APP-TRUTH 5469 passed/3 failed (two GPG-home setup failures, one inherited STATE-DEDUPE SHA mismatch); FUNNEL-TRUTH 5464 passed/2 failed (same GPG setup). Writable GNUPGHOME is prepared for required reruns; no tests or guards changed.

- **2026-10-06 01:34:09 AEDT** — FUNNEL-PERSIST second correction review caught an overflow-recovery corner: first fills during daily display overflow were not remembered, so a partial after midnight looked new live but not on rebuild. All three independent areas requested this change at e570f862cb28c36764fc39e1203ba3f8404e1e4f. Regression failed before, then all31 focused persistence/classification/API tests pass after bookkeeping moved outside display-availability guard. No current PASS yet; reviewers must validate final exact head. APP-SOL builder and EXIT-RUNG builder are preparing their existing task branches in isolated checkouts, preserving prior completed work and base fixes; no extra full suites started.

- **2026-10-06 01:28:24 AEDT** — FUNNEL-PERSIST midnight/retention corrections committed (exact head in next review event). Five regression checks failed before, including strengthened worker from-timestamp equality; after correction all 31 tests across persistence, classification and worker API pass and all workspace typechecks pass. Live/replay now agree on Melbourne day windows; streamed old entry lines seed first-ever fill identity. Per-day mint and lifetime entry keys each cap at 200,000; incomplete candidate views fail closed with HTTP503 only for funnel/decisions, never silent dropped counts. No new saved shape, schema field/enum, risk limit or protected-source change. Final independent correction reviews requested; full check pending resource availability.

- **2026-10-06 01:23:16 AEDT** — FUNNEL-PERSIST now stacks reviewed FUNNEL-TRUTH head 0f1a3c386e9d703231bad7fc56d80615b4beb041 so persistent replay uses the corrected classify function. This is a task-branch dependency merge, never a PR or integration merge; S1 must land FUNNEL-TRUTH before FUNNEL-PERSIST. Conflict resolution preserves FunnelView worker path instead of restoring the deleted duplicate view code. Base remains efa3b006; all final reviews must target the corrected stacked head. Working on midnight, first-fill and retention corrections next.

- **2026-10-06 01:20:48 AEDT** — FUNNEL-PERSIST independent APP/API, worker/facts and saved-data reviewers all CHANGES NEEDED at bb70cf38b072793999e1c63b5a28646148361f70. Cross-midnight live/replay windows differ and partial fills can be counted twice after restart; retained per-mint and trade maps need bounds. No new stored shape found. Fixes must preserve lifetime first-fill identity from existing data, agree on day windows/from timestamps and keep current-day retention bounded. Review evidence remains historical until corrected exact head passes. APP-TRUTH full run found a setup failure in public Tailscale key fingerprint check: GPG cannot create read-only home keyring. Verified unchanged public key using writable workspace GNUPGHOME; no signature or trust checks disabled.

- **2026-10-06 01:16:50 AEDT** — FUNNEL-PERSIST head bb70cf38b072793999e1c63b5a28646148361f70 adds the requested heap guard; all seven focused tests passed, including actual worker restart and 128 MiB journal replay under 64 MiB heap. Fresh independent reviewers persist_api_review (APP/API), persist_facts_review (strategy/worker facts) and persist_data_review (saved data) started on exact head. No current-head review verdict yet. No new persisted shape introduced by builder; persist reviewer must verify. Local-only preparation continues while API and exact-head CI handoff remain blocked.

- **2026-10-06 01:14:52 AEDT** — FUNNEL-PERSIST base merge at 8532523c16043cbe721761aa46c6a2fa65fe336e includes efa3b006e5fa7bcf745a9b344d7232116511ab85. Resolved worker view conflict retaining the task FunnelView and S1 bounded CappedMap symbols; docs retain both sections. Existing journalLines reads chunks, so no new journal loader is needed. Adding the requested real heap check before independent APP/API, worker/facts and persist reviews. Task still uses old stageOf until FUNNEL-TRUTH is integrated; any resulting base update requires a delta check and exact-head reviews.

- **2026-10-06 01:11:58 AEDT** — FUNNEL-TRUTH fresh independent APP/API reviewer funnel_api_review and strategy/worker facts reviewer funnel_facts_review both PASS at exact corrected head 0f1a3c386e9d703231bad7fc56d80615b4beb041. APP/API reviewer independently checked six invalid gates, 68 valid gate/delimiter combinations, risk stages and strict funnel schema; facts reviewer confirmed actual worker fault/R14 test reasons and conservative stage semantics. Frozen install and all workspace typechecks passed; full check running. Head pushed to task branch; no PR yet because API is blocked. APP-TRUTH 1790097accb0fa680462a7a595505a95ca2d500b was also pushed and verified. Required PR verdict comments and CI evidence remain pending; neither task is S2-READY.

- **2026-10-06 01:10:39 AEDT** — FUNNEL-TRUTH independent reviewers funnel_api_review (APP/API) and funnel_facts_review (strategy/worker facts) both CHANGES NEEDED at 2d53119c4e9e5d3749255700fd7660f3434b1b90. Corrected head 0f1a3c386e9d703231bad7fc56d80615b4beb041 bounds hard checks to H1–H17 with delimiters and counts generic risk refusals at stage 1; risk-approved size mismatch retains stage 2. Nine tests failed before (including real worker fault and R14 paths); all 11 pass after. Docs updated in place. No core risk, policy, strategy decision or protected path edits. Both reviewers will inspect correction delta on exact head; CI and PR creation pending API access.

- **2026-10-06 01:09:53 AEDT** — APP-TRUTH independent APP/API reviewer app_truth_review PASS on corrected exact head 1790097accb0fa680462a7a595505a95ca2d500b. Reviewed only fallback correction delta; direct runtime checks confirm inherited names fall back and known words remain. No remaining APP/API findings. Full pnpm check still running. Prior review at 4b6ed6ef remains historical, not reused as current-head evidence. Verdict must be copied to PR #216 once API access works; no CI green or S2-READY claimed.

- **2026-10-06 01:08:45 AEDT** — APP-TRUTH fallback fixed at bld pending exact SHA in next event: three new inherited-property regression cases failed before with TypeError, then all 17 APP-TRUTH tests passed after Object.hasOwn guard. Historical review remains recorded; fresh reviewer will inspect corrected exact head before current PASS. Obsolete full run ended by supervisor with exit 143, not counted as passed or failed tests.

- **2026-10-06 01:06:25 AEDT** — APP-TRUTH independent APP/API delta review CHANGES NEEDED at 3a75e48c3df70b394ad2369eb826b53743b319fd: inherited object-property risk sources (constructor, toString, __proto__) crash label rendering rather than fallback. Reviewer app_truth_review passed 53 focused tests and verified all 40 entry risk labels, but found this additional schema-valid case. No PASS claimed; add fail-before regression then own-property lookup. Stop the obsolete in-progress full suite and run the finished head once after correction. PR comment publication is pending outbound API access.

- **2026-10-06 01:05:12 AEDT** — Owner clarified review publication: every task gets fresh independent agents for each touched area; no builder self-approval and no S1 review fallback. Existing historical PASS remains attributed only to its old head. APP-TRUTH fresh delta review and full checks remain in progress; no current-head PASS or S2-READY claimed.

- **2026-10-06 01:04:52 AEDT** — FUNNEL-TRUTH base merge completed in an isolated builder checkout at 2d53119c4e9e5d3749255700fd7660f3434b1b90, containing efa3b006e5fa7bcf745a9b344d7232116511ab85. Only docs/DECISIONS.md conflicted; both sections preserved. Task diff remains API, worker, funnel tests and two docs. Frozen install passed; no direct edits to protected S1 paths. Owner explicitly requires independent agents per touched area, with every exact-head verdict in a PR comment. S1 does not supply reviews. Independent APP/API and worker/facts reviews will cover this head.

- **2026-10-06 01:04:03 AEDT** — APP-TRUTH base merge completed at 3a75e48c3df70b394ad2369eb826b53743b319fd, containing efa3b006e5fa7bcf745a9b344d7232116511ab85. Resolved only docs/DECISIONS.md by retaining both sections. Task diff remains seven app/test/docs files; no direct edits to S1-owned paths. Frozen install and all workspace typechecks passed. Full pnpm check is running. Independent APP/API delta reviewer started on an isolated exact-head checkout; no duplicate full suite. GitHub CI remains unobserved.

### 2026-10-06 01:02:10 AEDT — revised platform-neutral protocol accepted
- Re-read all four required docs at `e0071e10d4d73162efeddc55b4791cccd3f99ce8`. Owner now permits S2 to build directly and use independent platform reviewers; prior Claude-session blocker is superseded. Start APP-TRUTH and FUNNEL-TRUTH from existing heads, preserve completed evidence. GitHub API remains blocked; network draft is saved but not applied. No CI or review handoff claimed.

### 2026-10-06 01:00:38 AEDT — startup inspection; session and API blockers
- Read AGENTS.md, CLAUDE.md, this handover and PROJECT_STATE.md “Last part” from S1's docs branch. Created `claude/s2-docs` from that branch. Preserve all recorded completed work.
- Verified integration base `efa3b006e5fa7bcf745a9b344d7232116511ab85`, APP-TRUTH `4b6ed6ef8b36aabe0cd586e858c2c02b1ca74361`, FUNNEL-TRUTH `7cf40fbefef25e3ee751e0c2a4c8152df696776d` through read-only remote Git operations.
- Simulated both base merges with `git merge-tree --write-tree` without changing task branches. Both have a content conflict only in `docs/DECISIONS.md`; app labels and worker.ts auto-merge. These are conflict-discovery results, not completed merges or reviews.
- Required separate visible Claude builder/reviewer sessions cannot be created here: no session-management tool or Claude executable is available. The available subagents do not offer the owner's required models. No substitute or hidden agents were started. Owner action: continue these builders/reviewers in the Claude account, or explicitly revise the session/model requirement for Codex.
- Git reads work. GitHub API is blocked at the outbound proxy: `gh pr view 216` returned Forbidden; a header-only request to api.github.com returned CONNECT 403. Cannot inspect PR comments, exact-head CI, create a PR or post S2-READY. No missing Git credential inferred.
- Saved an additive network draft allowing `api.github.com`, preserving package-manager presets; draft save confirmed, runtime change/publication not performed. Owner action: review and save the environment settings, then publish as requested by the platform. Retry the PR read after network access changes; request credentials only if that operation then establishes an authentication failure.
- Initial environment setup installed the frozen lockfile successfully with pinned pnpm 10.28.0 and workspace-local Corepack/store caches; no source or lockfile edits. Typecheck, full tests and build have not run. This does not establish workflow readiness.
- APP-TRUTH and FUNNEL-TRUTH wait for the required builder sessions. No S2-READY, merge, Deploy, integration push or risk change. No routine/scheduler capability is available here; no background monitor was started. Remaining queue and original review evidence below are unchanged.

## How S1 and S2 work together

- **Channel.** The two supervisors run on different platforms and can't message each other. They use:
  - this file;
  - PR comments;
  - the owner.
- **Merging.**
  - S1 merges in S1's order. Bot and server fixes go first; the app batch follows.
  - When a PR is ready, S2 takes it out of draft and posts a PR comment that starts `S2-READY <full head SHA>` and lists:
    - each review verdict with the reviewer, area and exact head;
    - the green CI run on that head;
    - the base SHA the head contains;
    - any owner step still needed.
  - S1 checks it, then merges with a merge commit and expectedHeadSha.
  - If the base moved meanwhile, S1 asks for a base merge in a PR comment, or GitHub-updates the branch itself when the merge is clean.
- **Deploys and the APK.**
  - S1 runs Deploy.
  - Every push to the integration branch builds the Android preview release (`preview`).
  - After the app batch is merged, S2 gives the owner the APK link, what changed, and what to check on the phone.
- **Files S2 must not change** (S1's active work; conflicts would cost the crash fixes a CI cycle):
  - `packages/core/src/facts/producer.ts`;
  - `packages/worker/src/run/store-rules.ts`;
  - `packages/worker/src/providers/**`;
  - `packages/worker/src/facts/readers.ts`;
  - `packages/worker/src/seed/**`;
  - `ops/**`, `packages/ops/**`, `.github/**`;
  - `research/historical/**`.

  If a task needs one of them, write the need here and in a PR comment, and wait for S1.
- **Reviews.** Every PR needs an independent review on the exact head: never by the one who built it. If S2's platform can run a separate reviewer with no shared context, S2 uses it. If not, S2 posts a PR comment that starts `S2-REVIEW-REQUEST <full head SHA>`, naming the areas, and S1 arranges the review. Changes outside the app need the reviewer for their area:
  - `packages/core/src/risk/**`: the risk reviewer, with tests that fail before and pass after (AGENTS.md file ownership);
  - exits: the EXIT reviewer;
  - worker facts and strategy: the worker/facts reviewer;
  - saved data: the persist reviewer. A new kind of saved data (the bot's own decisions or public market data only) needs S1's approval after review. Personal data or data sent to a third party needs the owner.
- **The app's strict schema.** The installed APK parses server responses strictly. A new field or enum value from the server can break the owner's app ("Data failed checks", 5 Oct 12:09 AM). So server changes must stay readable by the installed APK. New values ship together with a new APK, and the server must stay tolerant of the old one until the owner installs it.

## The queue, in the owner's order

### 1. APP-TRUTH (#216): app labels match the real data; risk stops name their rule; short decision list
- Branch `claude/app-truth`, head `4b6ed6ef`, draft. Its base is from 5 Oct morning.
- Done: run/CI review PASS at 4b6ed6ef (5 Oct 11:45 AM):
  - labels true to the served data;
  - every entry RiskCode mapped (withdrawal codes fall back to "risk limit");
  - journal newest first;
  - 12 of 14 new tests fail before;
  - 7 mutants killed.
- Left: merge the base (expect conflicts in apps/web and the API), a delta re-check, CI, then S2-READY.

### 2. FUNNEL-TRUTH (no PR yet): fix the wrong "Costs" label in the coin funnel
- Branch `claude/funnel-truth`, head `7cf40fbe`. No PR. Not reviewed: its full check was pending when the 5 Oct 4:37 PM stop order paused it.
- The cause, pinned on 5 Oct 4:28 PM:
  - api.ts `checkOf` (about line 124) falls through to `cost` for pool-data refusals (pool state unknown, flagged or malformed; fee context unknown);
  - "live SOL price unknown" lifts the funnel stage (api.ts about line 126; worker.ts about line 1424 keeps the max stage);
  - so the funnel read "passed cost gate N → passed risk 0" and "Costs 40" (the owner's screenshot on 5 Oct 11:53 PM). It was not the R14 cost gate.
- 7cf40fbe reworks this server-only, so the installed APK keeps working:
  - every reject reason in strategy.ts is mapped to an existing check, and missing data maps to H16 "Stale or unknown data";
  - there is no fallthrough (an unknown reason gives no check);
  - a guard test counts the reject sites;
  - the responses pass the current app schema.
- Left:
  - merge the base and open the PR;
  - run/CI + worker/facts review;
  - then the app side (proper data and "other" labels), which is new values and needs the new APK.

### 3. FUNNEL-PERSIST (#210): the "Seen" counts and decisions survive restarts
- Branch `claude/funnel-persist`, head `6646f360`, draft.
- What it does: the funnel, entries and decision rows are rebuilt from today's journal at boot, so the live view is the rebuilt view. Why: the app's counts reset at every restart (the owner saw Seen 80+ fall to 40+ on 5 Oct).
- Reviews: asked for at fe74d0e (5 Oct 7:11 AM; run/CI + worker/facts). No verdict is recorded, so treat 6646f360 as unreviewed.
- Two cautions:
  - The worker has just been fixed for out-of-memory crashes, so any journal read at boot must be bounded (read in slices, never the whole file). Add a heap test.
  - If it adds a new saved shape, get the persist review and S1's approval.

### 4. APP-SOL (#182): every money figure in SOL first, dollars small
- Branch `claude/app-sol`, head `c5465c61`, draft.
- Done: run/CI PASS at c5465c6 (5 Oct 3:12 AM):
  - SOL headline from lamports, dollars secondary;
  - Return on lamports;
  - lamport sums fail closed;
  - meters interim until SOL-BOOKS (#197, which is S1's money group, parked);
  - 15 mutants.
- It overlaps #181 in the API; the second to land resolves the overlap.
- Left: merge the base (conflicts in the app and API), a delta re-check, CI.

### 5. APP-TRADE follow-up (#181, EXIT-RUNG): an open trade's profit uses the right closing fee
- Branch `claude/exit-rung`, head `9b865f4a`, draft.
- What it does: the open P&L's close fee is the rung the next exit attempt uses. Core `attemptRung` / `closeRungOf` are shared by `#sendExit` and the close rung, and the API's closeFee = next rung + base + tip, capped.
- Reviews:
  - EXIT PASS at 6731f13;
  - 9b865f4 (closeRungOf made pure, plus a C1 test) went to an EXIT delta review on 5 Oct 3:57 AM, and no verdict is recorded.
- It touches exits code, so it needs the EXIT reviewer. Conflicts in strategy.ts and worker.ts.

### 6. API-1 N1' (#167): the app shows the right "waived" checks
- Branch `claude/api-1`, head `e37f35ec`, draft.
- What it does: the served `regime.waived` is the whole S0 set while the diagnostic is on.
- Conflicts in strategy.ts. Left: merge the base, a delta check, CI.

### 7. Not S2's: in-app Pause and Start
The Pause button that pauses the server, and Start beginning a new day. The owner kept this for S1, second to last in S1's queue (before paper and backtest removal).

### 8. RISK-DIAL: the risk % slider
- No branch. The design was reviewed on 5 Oct about 4:16 PM: the risk reviewer said CHANGES NEEDED. Notes are in PROJECT_STATE.md, "Last part".
- The owner's request: an app slider from 5% (the default) to 100%, set only by the owner. It was parked "until I say so"; the owner has now put it in S2's queue.
- Blocking points to solve in the design:
  - the dial also drives R5 sizing (evaluate.ts about lines 505–506), so on the $20 trial its effective range is only about 6–16%, depending on the stop;
  - the 33.3% median-target share and S0's expected-net limit (about 17.8%) also bind;
  - passkeys can't work in the Capacitor app without a domain, so the owner's signature would be a device-bound Android Keystore key with a biometric prompt, registered on the host only;
  - every error path must fall back to exactly 500 bps (5%);
  - lowering applies at once, raising only when no trade is open;
  - paper only, and it resets at live (enforced in core and worker).
- Risk limits are owner-only (AGENTS.md). So: the design goes first, then the risk review, then the owner's explicit OK in chat on the final design, then the build. Until then, R14 stays at 500.

### 9. SEC-1 (#136): sign the app with the owner's own key
- Branch `claude/sec-1`, head `e44829ce`, ready (not draft).
- What it does: the preview APK's signing key moves out of the Actions cache into a secret, with a certificate check.
- Done: ops reviewer PASS at e44829c (12 of 13 mutants; 1 equivalent).
- It touches `.github/**`, so S2 prepares it and S1 merges it. It conflicts with #149 (S1's parked ops PR: require-check WAIT_S, android test). Agree the order with S1 in a PR comment.
- The owner's steps are in `docs/ANDROID_PREVIEW.md` on the branch: create the keystore and the secret. Tell the owner plainly that changing the key means reinstalling the app.

## State when S2 starts (6 Oct about 1:00 AM)
- Base `ccr-14987baf-i6lrsl` at efa3b006 (#232 OOM-HEADS). S1's work in flight, which merges first and will move the base:
  - #233 OOM-SEEN;
  - the OOM-MINT follow-up;
  - #234 (data lanes);
  - #214 (archive scanner caps, after the 21 Sep download);
  - the recordings uploader.
- The old API/APP builder session on S1's account is parked. S2 does the building itself, or with its own helpers.
