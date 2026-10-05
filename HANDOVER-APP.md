# App queue handover (Supervisor 2)

Owner, Tue 6 Oct about 1:00 AM: a second supervisor (S2) takes the parked **app and screens** tasks below to speed them up. S2 is a different AI agent, not Claude, running on the owner's other account. Supervisor 1 (S1) keeps the bot, server and data work. S1 is the only one who merges and deploys.

From here on, S2 owns this file. S2 keeps it current on its own branch `claude/s2-docs`, which starts from S1's docs branch `ccr-528521bb-f7a7zo`. S1 reads it there and does not edit it.

## S2 events (newest first)

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
