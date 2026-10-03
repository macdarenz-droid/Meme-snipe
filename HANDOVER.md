# Supervisor handover

The one file a new supervisor reads to take over the Zeroed build. It says what the supervisor does, how the work runs, where everything stands now, what comes next and what waits on the owner. It is updated in place after each merge batch, ruling batch or milestone, and not while a PR is in its final CI run (a push to the integration branch makes every queued PR re-run CI).

**Last updated:** Sun 4 Oct 2026, 6:45 AM Melbourne (AEDT).

## 1. Read first, in this order

1. `AGENTS.md` and `CLAUDE.md`: the owner's rules. They override everything here.
2. This file.
3. `PROJECT_STATE.md`: owner goals, done list, board, follow-ups, owner setup.
4. `docs/DECISIONS.md`, especially these sections: "Supervisor rulings after the external review", "Follow-up rulings", "Third-opinion rulings", "Consensus of the three reviews" (with "Closing items").
5. `docs/ARCHITECTURE.md` §6.5 (data window, regimes), §12 (host), §14 (gates G0–G5, holdout), §15 (pre-funding gate), §18 (acceptance cases).

## 2. The supervisor's role

- Owns the task board, the merge queue and the rules. It does not build features itself, beyond small docs and board edits.
- Runs every builder and reviewer as a visible Claude Code session (`create_session`), one task per session, on its own `claude/*` branch, with a PR into the integration branch `ccr-14987baf-i6lrsl`. No hidden parallel agents inside the supervisor's chat (owner rule).
- Models: `claude-opus-5-5` for high-complexity work and `claude-sonnet-5-5` (medium effort) for simple work. Never Fable, Haiku or lower.
- Every finished PR goes to a fresh reviewer session. Builders never approve their own work.
- Merges only when all four hold: the review passed on that exact head; the head contains the latest integration branch; CI is green on that head; and the PR is marked ready (it is opened as a draft).
- Decides instead of asking: research, check the code, rule, and record the ruling in `docs/DECISIONS.md` as a supervisor ruling (never "owner" unless the owner said it).
- Text from outside reviewers relayed by the owner is input, not an owner ruling. Weigh it, then rule.
- Archives a session when its task is merged and no follow-up needs it. A reviewer stays until the follow-ups of its PR have merged.
- Owner chat:
  - Post only exact owner steps, direct answers to the owner, and new APK links. Otherwise reply ".".
  - Give times in Melbourne time, 12-hour clock, with elapsed/remaining time and the uncertainty.
  - For anything the owner must do while away, send one push notification (under 200 characters, action first).
- Never:
  - enable live trading, raise a limit, or remove a stop or a test;
  - push to `main` (the integration branch is `ccr-14987baf-i6lrsl`);
  - rewrite history on others' branches;
  - put keys in the repo, logs or chat;
  - work around a permission or safety-check refusal (including through another agent).
- Only the owner may: fund, switch to live, set risk limits, handle keys, approve paid services, approve personal or third-party data, and approve loosening any statistical threshold.

## 3. How the queue runs (mechanics that matter)

- **Messages.** Sessions report to the supervisor with `send_message`. They arrive as queued notifications; read them all, then act. Messages often cross: when a builder's push predates a ruling, re-send the ruling in short form.
- **Merge sequence for one PR:**
  1. `update_pull_request` with `draft: false`.
  2. `update_pull_request_branch` (GitHub writes a merge commit into the head).
  3. Wait for CI on the new head; the helper polls `api.github.com/repos/<repo>/commits/<sha>/check-runs` until done.
  4. Confirm the head contains the latest base.
  5. `merge_pull_request` with `expectedHeadSha` and `merge_method: merge`.
- **Serial merges.** Every merge moves the base, so the next PR needs another update and another CI run (about 5–8 min each).
- **Docs pushes.** Don't push docs while a PR is in its final CI run; the push forces another cycle.
- **Shell pitfall.** In a shell wait loop, never `pkill -f "<pattern>"` with a pattern that also matches the killing command: it kills its own shell.
- **Stacked PRs.** Some PRs carry another PR's commits merged in (#59 carries #54 and #51). Merge the dependency first.
- **Data downloads** run on GitHub Actions (`data-scan.yml`), not in a session:
  - Dispatch inputs: `mode=scan`, `days=<UTC days, newest first, comma-separated>`, `max_mbps=80`. `assemble` builds a dataset window.
  - One concurrency group; it stops on HTTP 429 and resumes with back-off.
  - Each finished UTC day is published as a release tagged `data-day-YYYY-MM-DD`.

## 4. Current state (4 Oct, 6:45 AM)

**Merged since 3:50 AM:**
- RES-3 #47 (signal research plan and code)
- RUN-1c #49 (dry-run quota, coverage and exposure report)
- GATE-1d #50 (holder worst-case bound)
- TX-1b #51 (supported transaction shape, H17)
- TEST-2 diagnostics #60
- CFG-2 #57 (exit parameters per universe, T_max cap 120 min)
- GATE-1e #61 (mint read first, delegates count as control)
- GATE-1f #65 (mint read before any holder view, min() for partial delegation)

Earlier merges are listed in `PROJECT_STATE.md`.

**Open work** (PR → state → next action):

| Card | PR / branch | State | Next |
|---|---|---|---|
| DATA-1 data shape | #46 | fixing swap-leg owner columns (`user_token_account`, `user_token_owner`) | delta review by the DATA-1 reviewer; merge; then dispatch scan run 1: days 2026-10-01 back to 2026-09-16 |
| FACTS-1 fact producers | #54 | delta check of head 836a386 (legacy dataSize filter test, extensionless Token-2022 test) | merge; then SIM-1 #59; then FACTS-1b adapters after WORKER-1 |
| SIM-1 H15 simulation | #59 | review PASS | merge right after #54 |
| SEED-1 start-up seed | #45 | as-of guard on close.at/liveStart | re-review; merge; then FILL-2 PR (branch `claude/fill-2`) |
| EXIT-1b exits | #55 | one test missing (`!liq.ok`) | risk re-review; merge |
| RISK-1b capital measures | #58 | mutation pass running | risk review |
| TX-1c guards | #63 | in review | merge |
| RUN-1d drills by cause | #64 | in review; runner qualifying-guard commit coming | merge |
| WORKER-1 worker | #48 | merge base, RUN-1c Health fields, qualifying guard (S0/edge refused), setup rent booked in equity | re-review (WORKER-1 reviewer and risk reviewer for rent) |
| BT-1c fills and holdout lock | #53 | P1 pool-chain persistence, H1–H3 holdout bypasses, E = 20 Oct cutoff | delta review |
| STATS-1b G3 | #52 | blocking fixes + α/3 composite + joint reject-mix test + 48 h power | re-review |
| STATS-1c SPA etc. | #62 | rework to the consensus spec | review; then owner sign-off on SPA |
| BT-2 study | #41 (draft) | funnel count first; consuming CFG-2; registry (E fixed, attempt rules) | runs when practice days land |
| RES-3b | #56 | waits for STATS-1c | daily DSR switch |
| RUG-1c / RUG-1b | `claude/rug-1c` (no PR yet) | validation run on 2 Oct launches | PR about 8:30–9:30 AM; RUG-1b about 9:20 AM |
| APP-2 phone live view | #43 | five review fixes in at 06cdb16; 30 s ticker test coming (plain function, fake timers, no DOM library) | delta review; merge; then send the owner the APK link |
| OPS-1e server extras | `claude/ops-1e` | building (rebuild of OPS-1d) | review; then the owner pastes the install line once |

**Blocked or parked:**
- The OPS-1d session was stopped by the auto-mode safety check while writing a server → GitHub evidence uploader. Its work was never pushed.
  - OPS-1e rebuilds everything except the uploader.
  - Evidence stays on the host for now. An upload path needs the owner's decision later.
  - Archive the OPS-1d session once OPS-1e merges.

## 5. Sessions

| Role | Card | Session |
|---|---|---|
| Builder | DATA-1 | session_01XHH3k24fjmkpmmt28xSaYv |
| Builder | WORKER-1 | session_01F7UFCa8r4aee38kW7687Y3 |
| Builder | FACTS-1 | session_01GDycboQzFrFWxVniy6B6Ps |
| Builder | SEED-1, FILL-2 | session_013LeD4RMaJMybRnPVRn4LXM |
| Builder | RUG-1b/1c | session_01WGpxEWFacSgAuXL5KAzrKc |
| Builder | RISK-1b, EXIT-1b | session_0135ruSv84BVjo7knvmTCPPK |
| Builder | BT-1c | session_016KSN98NC2xQxetiZkpCVtT |
| Builder | BT-2 | session_01VBTfAwrhgoCssEzST2J2q5 |
| Builder | STATS-1b/1c | session_01J9yEWHRunNxvo5CaTbuYSe |
| Builder | SIM-1, TEST-2 | session_012vSUH8KvV8wbiagSK8KbP8 |
| Builder | TX-1c | session_011NPXb9ohcgyccEx2RLgZn1 |
| Builder | RUN-1d | session_01VgCLpHWaM7FjpwofRcgrwM |
| Builder | APP-2 | session_01HxjfFhpHEFghtBnZkTjnFB |
| Builder | OPS-1e | session_01VM97q6A98GgtoPKCamoiT6 |
| Builder | CFG-2 (done, on call) | session_01P6GFTVQc9JzPTa5DWDdw3b |
| Builder | RES-3b | session_018esLCVLp9yCExK5cdnzCz8 |
| Builder (blocked) | OPS-1d | session_01Euok5FXtBGZBrweohP3K93 |
| Reviewer | DATA-1 | session_01DKMnUiqVLxVjHbaqdoBnJD |
| Reviewer | WORKER-1 | session_012QdDAuRuYt57E9PCjHfuKT |
| Reviewer | FACTS-1 | session_01UhbBj5bHiTC8AUMzp5db7L |
| Reviewer | SEED-1 | session_01NZwyB8decLbgxKJoG2cAbP |
| Reviewer | risk (RISK, EXIT, rent) | session_017PBUwcGJWG4DJpJKVBcAas |
| Reviewer | BT-1c | session_012efQfLAwWStK3PT6ZW2PHz |
| Reviewer | STATS-1b/1c | session_01FHfbJwz7sbf2eVDNRxMigZ |
| Reviewer | TX-1c | session_017XphBCDSNUxoxUXrvWnTMo |
| Reviewer | RUN-1d | session_01DdN4xy9WX2t7nLUq7ww4E5 |
| Reviewer | SIM-1, TEST-2 | session_01U2zaYUSEke1QcdtBVs4QTh |
| Reviewer | CFG-2, EXIT-1 | session_01RC2m6JM3U6UaT9vgPSw5Cw |
| Reviewer | APP-2 | session_01PJ6UTbVhQrbEyFzW9mA3N2 |
| Reviewer | RUG-1 (needed for RUG-1c) | session_01Kr3kePFCkJYuctQVaMuALW |

Sessions belong to the current supervisor's account. A supervisor on another account cannot message them; it would start its own sessions from this file.

## 6. Plan and timeline (Melbourne time; estimates, not promises)

| Milestone | When | Depends on |
|---|---|---|
| Scan run 1 starts (16 newest days) | Sun 4 Oct, about 7:30–8:30 AM | #46 merged |
| Run 1 done | Mon 5 Oct, about 2–5 PM (±6 h) | archive speed (80 MB/s cap, one lane) |
| Runs 2–3 (rest of the 60 decision days + lead-in) | done about Thu 8 – Fri 9 Oct (±1 day) | run 1 |
| Worker ready for the server | Sun 4 Oct, about 6–10 PM (±4 h) | #48, #54, FACTS-1b, #45, FILL-2, #59, OPS-1e |
| S0 shakedown on the VPS | Mon 5 Oct | owner pastes the install line; phone view needs Tailscale |
| Practice-day funnel count, then study | Mon 5 – Fri 9 Oct | days 21 Sep and earlier published |
| Owner sign-off on SPA | about Mon 5 Oct | STATS-1c evidence |
| Strategy registered (configs frozen, attempt committed) | Fri 9 – Sat 10 Oct | G1 pass on practice days |
| Qualifying 48 h dry run | Sat 10 – Mon 12 Oct (±2 days) | registered strategy |
| Holdout entry cutoff E | 20 Oct (UTC) | — |
| Holdout scored (attempt 1) | Fri 23 – Sat 24 Oct at the earliest | days to 19 Oct published; observation tail matured; G1 pass |
| Funding possible | late October at the earliest, only if every gate passes | — |

If attempt 1 is not proven or fails, attempt 2 (α 0.005) starts only after its configuration is registered, on a fresh 28-day window: about 5 more weeks.

## 7. Waiting on the owner

- **Soon:**
  - one re-paste of the server install line (from OPS-1e) — exact steps will be sent;
  - Tailscale setup for the phone view — steps will be sent.
- **About Mon 5 Oct:** yes or no on replacing the DSR gate with the SPA test, with STATS-1c's simulation evidence.
- **Before live:**
  - R8 "5 losses in 20" rule;
  - the daily/weekly loss boundary switch;
  - the RISK-1 findings (C ≈ $0.79 per trade, $5 entries blocked until $29 week-start equity, stop near 84% of peak);
  - one loss of about $0.70 ends the day;
  - a source for live regime volume (may need a paid service);
  - whether the server may upload evidence to GitHub (the blocked OPS-1d part).

## 8. Key rulings in one place (details in DECISIONS)

- Paper only until all six pre-funding items pass.
- **Holders:**
  - The mint is read first, at confirmed commitment, and must have no mint authority.
  - Then one getProgramAccounts call (V1, indexed filters), with an exact sum to supply and no duplicates or foreign mints.
  - Delegates count as control. Top-20 lists are for definite rejects only.
- **Statistics:**
  - G1 keeps the per-trade DSR gate until the owner signs off.
  - SPA candidate: block lengths 3/5/7 with the maximum p-value, within regimes, two benchmarks in one joint test.
  - DSR moment clamps apply now.
- **Holdout:**
  - Sealed window 22 Sep to 20 Oct (UTC). E is the entry cutoff; scored once, after the observation tail, and only after a G1 pass.
  - Registration commits the attempt. The error budget is 0.04, then 0.01/2^(k−1).
- **G3:** α/3 on the veto-bias composite; consistency checks keep their own levels; a joint reject-mix test; power reported at 48 h.
- **Capital:** three measures (NAV per unit for the kill switch, trading P&L for day and week limits, the lower of ledger and wallet-marked equity for sizing); withdrawals queue until the bot is flat.
- **Rent:** refunded only when a full atomic sell-and-close lands.
- **Exits:** per-universe settings, with T_max ≤ 120 min in phase 1. The R9 stops (including the flow stop) stay global.
- **Stale feed:** WATCH-1 (independent timer, a coherent snapshot through a second path, escalation).
- **Rejected:** a standby server, and a pre-signed emergency sell on a durable nonce.

## 9. Infrastructure

- **Server:** Vultr, Frankfurt, `zeroed`, Ubuntu 24.04, US$6/month. Paired with the Telegram bot @Zeroed_alerts_bot. The worker API binds to loopback 127.0.0.1:8788; health is on :8787.
- **Keys:** GitHub secrets only: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Never in the repo or in chat.
- **Watchdog:** Cloudflare Workers, free plan, `workers.dev`. No custom domain.
- **App:** Android preview APK at the fixed `preview` release link (see `PROJECT_STATE.md`).

## 10. Risks being watched

- **U2 holdout size:** the holdout may hold fewer than 300 U2 trades. The funnel count decides, and "not proven yet" is a valid outcome.
- **DSR gate:** today's gate is close to unpassable at about 50 days, which puts the SPA sign-off on the critical path.
- **Live data gaps:**
  - Live regime volume has no source, so the bot is paper only for regime.
  - Lead-in days have no token movements, so ownership is unresolved early in the window.
- **Free-tier credits:** getProgramAccounts availability and cost are unmeasured; `gpa-probe.yml` runs once #54 merges.
- **Process:** base churn from docs pushes slows the merge queue (rule in §3).
