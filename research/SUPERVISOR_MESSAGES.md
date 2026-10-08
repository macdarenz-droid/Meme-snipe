# Project decision and supervisor messages (2026-10-07)

## Owner decision (final)
The owner prefers the Blueprint, especially its dashboard. Owner's words: "We continue blueprint first. Like main project, what zeroed has. Will be migrated to the blueprints, i mean its server etc. So that i will not need to setup again." And: "Replace everything what current on blueprint is. But i want app name zeroed".

Applied as follows:
- The Blueprint is the main project and the design authority. The app keeps the name Zeroed.
- The Blueprint supervisor takes over the Meme-snipe repo, and the Zeroed supervisor hands over and stands down.
- Work stays in the Meme-snipe repo because its GitHub secrets, deploy pipeline, server update gate, Tailscale, Telegram bot and Cloudflare watchdog are all tied to it. That is how "no setup again" is met.
- Zeroed's working code is migrated module by module into the Blueprint design (`docs/MIGRATION.md`). It is not rewritten.

## Message to the Blueprint supervisor (new lead)

**To the Blueprint supervisor (session "SHITCOIN V2"): owner decision, 2026-10-07**

**Decision.** The Blueprint (claude.ai/artifact/SWxLJXAncuoyZvq2vXcbMK) is now the main project and the design authority. The app keeps the name **Zeroed**. Otherwise the Blueprint replaces what Zeroed has today: architecture where they differ, process model, gates, risk, and the dashboard, which replaces the Zeroed app and its two themes. Zeroed's working parts are migrated into the Blueprint, so the owner does not set anything up again.

**Where you work: inside `macdarenz-droid/Meme-snipe`, not a new repo.**
- That repo already holds everything the owner set up:
  - GitHub secrets `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`;
  - the deploy pipeline: tag `deploy` plus the server's update gate, which takes only signed, all-green commits;
  - the Vultr server `zeroed` (vhp-1c-1gb, Frankfurt), reached over Tailscale;
  - the Telegram bot @Zeroed_alerts_bot and the Cloudflare watchdog on workers.dev.
  These facts are in PROJECT_STATE.md "Owner setup" on branch `ccr-14987baf-i6lrsl`.
- A new repo would mean re-adding every secret and re-installing the server.
- Add the repo to your session with push access. The owner approves if asked.
- You become this repo's only supervisor: task board, merge queue and HANDOVER.md. The Zeroed supervisor will hand over to you and stand down.

**Rules that stay in force.** Read CLAUDE.md and AGENTS.md on `ccr-14987baf-i6lrsl`:
- paper only; nothing live and no fund moves without the owner;
- profit counted in SOL (lamports);
- paper treated as real money;
- no keys in chat or in the repo;
- file ownership (`packages/core/src/risk/**`, `packages/signer/**`, `.github/**`, saved data shapes);
- removing paper or backtest code is high risk and needs replay-to-identical proof;
- the model range and owner-chat rules.

The owner changed only these today, and you record them as dated owner additions in CLAUDE.md:
- the Blueprint is the design authority;
- the Blueprint dashboard and its look replace the app and the "Paper" / "Silent Black" themes;
- the name stays Zeroed.

For any other clash between the Blueprint and an owner rule (for example, Telegram vs the D27 watcher, or the 2 GiB host), list it for the owner with your recommendation. Never drop an owner rule silently.

**First task: a migration map (analysis only, no code).** Write `docs/MIGRATION.md`:
- For each Blueprint module M01–M30 and decision D01–D31, name the existing Zeroed package and files. Mark each one:
  - **keep:** it meets the Blueprint spec; cite its tests;
  - **adapt:** list the gaps;
  - **replace:** say why;
  - **missing:** no Zeroed counterpart.
- Zeroed assets worth keeping, all merged with tests:
  - ENG-1 (#10) engine with leak proofs;
  - LEDGER-1 (#9);
  - DEC-1 (#11) decoders with mainnet golden vectors;
  - GATE-1 (#22) hard rejects;
  - BT-1 (#24) transaction-level backtester;
  - EXIT-1 (#33);
  - RISK-1 (#18);
  - TX-1 (#20);
  - FEED-1 (#21);
  - the ops installer, update gate and watchdog.
- Ops:
  - Reuse the server. Blueprint D07 wants 2 GiB; this host has 1 GB, and the worker hit V8 out-of-memory on it. An in-place resize is new spend, so the owner decides.
  - Reuse the deploy gate and the secrets (names only).
- Then give the ticket order. Follow the Blueprint milestones: M0 → M1 (recording and the Phase 0 kill decision) → M2 → M3 (paper and dashboard). M4 (live) stays blocked by the gates and by the owner. Reuse Zeroed code wherever it passes your specs, to skip work.

**Research you inherit (branch `ccr-7fae2302-drz4co`).** Owner: merging this research is allowed; this lifts the 6 Oct parking.
- **Close versions of both your strategies lost.**
  - MR-01's proxies (deep-pool MR-A/MR-B on 5-minute bars) made −0.76% and −1.03% a trade in 0.30–0.55% pools, and −0.17% and −0.40% in the 0.30% tier, with CIs crossing zero (`research/deep-pool-probe/RESULTS.md:13,15,19`). MR-01's 15 s signal is untested.
  - PM-01 overlaps U2 at 60–120 min. Relaxed U2 lost 10.6% (PR #267). Buying every graduate at hour 1 lost 22.4% (`research/runner-probe/RESULTS.md`).
- **Still running, scored as pre-registered:** cheap-venue dip probe, launch-delay probe, hype Test 1 (paid DexScreener attention) and the execution audit. The audit found that hourly bars hid a one-swap crash: a real-time trail sold the exploration jackpot at about 27×, not about 130×.
- **Other inputs:**
  - Sizing: a floor-based risk layer for after an edge passes (`research/sizing/RESULTS.md`).
  - Short side: not supported (`research/short-probe/RESULTS.md`).
  - Hype research: attention only as a reject rule (`research/hype/RESEARCH.md`).
- **Bugs to carry into your specs:**
  - `SLOT_MS = 400` is hard-coded in four places (slots now run at 250 ms);
  - H8 counts post-BOOST virtual quote as depth;
  - holdout contamination in Zeroed's window (`docs/research/edge.md` §6.5);
  - Zeroed's risk core is still in micro-USD (#197). Use lamports.
- **Data and terms:**
  - pump.fun Terms §21(h) bans bots and forged headers. The research scripts are stopped. Owner: keep the pump.fun data already collected; make no new pump.fun requests.
  - Helius §3.2(xi) (business purpose only) is still the owner's question.
  - The Helius Developer plan is active: 126k of 10M credits used, cycle 6 Oct–6 Nov, autoscaling off.

**No bugs migrate (owner, 2026-10-07).** Nothing is copied in bulk. A Zeroed module enters the Blueprint build only after the migration map marks it keep or adapt, and only when all three hold:
1. it passes the Blueprint module's acceptance tests;
2. every known bug that touches it has a test that fails on the old Zeroed code and passes on the migrated code;
3. a fresh reviewer passes it.

Known bugs to close or leave behind:
- the restart loop and V8 out-of-memory on the 1 GB host;
- Helius credit burn of about 80k an hour with zero trades;
- `SLOT_MS = 400` hard-coded in four places, while slots run at 250 ms;
- H8 counting post-BOOST virtual quote as depth;
- risk limits in micro-USD instead of lamports (#197);
- the watchdog cannot sell, because there is no exit takeover;
- red team C's critical findings (fixes #271, #274 and #279 are merged but not deployed);
- the fake 17.8% paper edge (#268);
- holdout contamination.

The server starts the Blueprint build from a clean state. Reuse the host, keys, Tailscale and the deploy gate. Do not reuse the old worker's saved state, ledgers or caches. Nothing runs on the server except the stand-in until the Blueprint's paper gates pass.

**Do not:**
- delete Zeroed code before the map marks it replaced and its replacement passes the same tests and replays;
- resume the worker before the owner's resume order;
- buy a droplet, data or any service;
- deploy outside the update gate;
- run more than one supervisor on the repo.


## Message to the Zeroed supervisor (handover)

**To the Zeroed supervisor: owner decision, 2026-10-07**

**Decision.** The Solana Meme Bot Blueprint (claude.ai/artifact/SWxLJXAncuoyZvq2vXcbMK) is now the main project. Its supervisor (session "SHITCOIN V2") takes over this repo, the server and the merge queue. The app keeps the name Zeroed. Over time the Blueprint design replaces the rest, including the app and its two themes, which a Blueprint dashboard will replace. Your job now is a clean handover, then stand down.

**Freeze, starting now:**
- Make no new merges or deploys, except a fix for a safety or security problem. Report any such fix in HANDOVER.
- The server stays on the stand-in (`"worker": "stub"`).
- Do not resume the worker, and do not merge #268, which turns the worker back on.
- Start no new cards or sessions.

**Hand over.** Bring HANDOVER.md and PROJECT_STATE.md up to date; both are stale since 5 Oct. They must cover:
1. **Server and deploy:** the current `deploy` tag and its sha; stub state; how a safe deploy runs (checklist, signed commits, update gate); Tailscale; the Cloudflare watchdog; the data repo and DATA_STORE_TOKEN status.
2. **Secrets and accounts, names only:**
   - GitHub secrets;
   - the Helius Developer plan (owner's dashboard 7 Oct: 126k of 10M used, cycle 6 Oct–6 Nov, autoscaling off);
   - Telegram @Zeroed_alerts_bot;
   - Vultr `zeroed` (1 GB).
3. **Open PRs:** one line each with status and your recommendation (merge, park or close).
4. **Sessions:** live and parked sessions with their branches; anything mid-task.
5. **Known problems:**
   - the restart loop and V8 out-of-memory on 1 GB;
   - credit burn at about 80k/h;
   - red team C findings, with the fixes merged but not deployed (#271, #274, #279);
   - `SLOT_MS = 400` in four places;
   - H8 virtual-quote depth;
   - SOL-BOOKS #197;
   - holdout contamination;
   - the watchdog cannot sell.
6. **Owner waits and owner decisions,** with dates. That includes today's:
   - pump.fun data already collected is kept, with no new pump.fun requests;
   - the Helius §3.2(xi) question is open.
7. **Where the research lives:** branch `ccr-7fae2302-drz4co`, not yet merged; the owner has allowed merging it.

**Then:**
- Send the new supervisor the HANDOVER commit sha and confirm in one line that you are done.
- Archive your builder and reviewer sessions under the archive rule. Keep every branch, and leave PRs open for the new supervisor to triage.
- Stop working on this repo.

**Do not:**
- delete branches or code;
- close PRs;
- change secrets or server settings;
- rewrite history;
- post in the owner's chat beyond the owner-chat rules.


## Earlier recommendation (overridden by the owner)

A 5-agent comparison, with a fact-checker who corrected 20 claims, had recommended keeping Zeroed and stopping the Blueprint build. Its findings still hold as inputs: close versions of both Blueprint strategies lost, Zeroed has the built engine, and the Blueprint has the stricter gates and safety design.

Keep meme-snipe (Zeroed). Stop the Blueprint as a build, and hand its design over to Zeroed as reference research.

Why:
- **Zeroed has a built, tested engine; the Blueprint has no code.** Zeroed's paper engine is merged (ENG-1 #10, LEDGER-1 #9, GATE-1 #22, BT-1 #24, EXIT-1 #33, RISK-1 #18, TX-1 #20; packages backtest/core/ops/runner/worker on origin/ccr-14987baf-i6lrsl). It has not yet run stably on the server. The Blueprint carries a "DESIGN ONLY" banner (its own repos could not be checked) and 174 tickets: about 87 + 104 engineer-days plus UI, by its own rough estimate (A-33).
- **Zeroed's research tested close versions of both Blueprint strategies, and both lost.**
  - Deep-pool MR-A and MR-B copy MR-01's lookbacks, 3σ entry, stops and time limits, on 5-minute bars. In 0.30–0.55% pools, validation net was −0.76% and −1.03% per trade, with CIs below zero (ccr-7fae2302-drz4co:research/deep-pool-probe/RESULTS.md:13,15). In MR-01's own 0.30% tier it was −0.17% and −0.40%, with CIs crossing zero (RESULTS.md:19; results.json). MR-01's 15 s signal is untested.
  - PM-01 overlaps U2 only at 60–120 min after migration. Relaxed U2 lost 10.6% a trade (CI −15.3 to −5.5; PR #267, open). The runner rule, which bought every usable graduate at hour 1, lost 22.4% (runner-probe/RESULTS.md:20).
  - The Blueprint is built to stop at M1/M2 if its gates fail (#overview--blockers). Under D08, a failed MR-01 moves effort to PM-01 replay.
- **Zeroed gives the fastest yes-or-no answer.** Three pre-registered tests are committed with no results yet (6033cd0c, 8d55507b, 2349dfe2). The execution audit (PREREG 42afe72a) has 4 of 72 targets done (3b17c8bb). The Blueprint needs M0 built and about 15 days of its own recording before Phase 0 can report (A-M13-01).
- **Only the Blueprint's value can be carried over.** Its gates, risk tables, signer and sentinel specs, and facts register move as documents. Zeroed's code and data cannot move into a design.

**Strongest counter-argument.** Zeroed has spent heavily and never made a paper trade:
- about US$1,450–1,500 of Claude usage since 6 Oct (session metadata, not a verified bill);
- about 80k Helius credits an hour with zero trades (DECISIONS.md:3466);
- red team C rated it NOT READY on 959d801 (fixes #271, #274 and #279 are merged but not deployed);
- its watchdog cannot sell (ARCHITECTURE.md:398-400).

The Blueprint is cleaner and tests before it builds.

**Why it loses.** That way of working can be adopted inside Zeroed in days. Rebuilding would likely reach the same "no edge, stay in paper" answer later and at higher cost. The cure is a freeze on new features plus the Blueprint's gates, not a new codebase.
