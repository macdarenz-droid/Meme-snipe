# Supervisor handover

The one file a new supervisor reads to take over the Zeroed build. It says what the supervisor does, how the work runs, where everything stands now, what comes next and what waits on the owner. It is updated in place after each merge batch, ruling batch or milestone, and not while a PR is in its final CI run (a push to the integration branch makes every queued PR re-run CI).

**Last updated:** Sun 4 Oct 2026, 9:05 AM Melbourne (AEDT).

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

## 4. Current state (4 Oct, 9:05 AM)

**Merged since 3:50 AM:**
- RES-3 #47 (signal research plan and code)
- RUN-1c #49 (dry-run quota, coverage and exposure report)
- GATE-1d #50 (holder worst-case bound)
- TX-1b #51 (supported transaction shape, H17)
- TEST-2 diagnostics #60
- CFG-2 #57 (exit parameters per universe, T_max cap 120 min)
- GATE-1e #61 (mint read first, delegates count as control)
- GATE-1f #65 (mint read before any holder view, min() for partial delegation)
- TX-1c #63 (exported account pickers check the shape)
- FACTS-1 #54 (gate fact producers, live readers, parity)
- APP-2 #43 (live paper screens from the tailnet server)
- EXIT-1b #55 (partial quotes, retry affordability, sell-only recovery)
- RISK-1b #58 (flow-neutral limits, NAV kill switch, `AccountHistory.costs`, withdrawal leaving no valuation refused)
- SIM-1 #59 (H15 round-trip simulation)
- DATA-1 #46 (retention, schema 3 swap-leg owners, unattended run chaining)
- SEED-1 #45 (deployer index seed at start-up)
- APP-2b #67 (server card state per endpoint)
- FACTS-1c #68 (mint-only Token-2022 holder scan, one indexed retry on -32600)
- WORKER-1 #48 (always-on paper worker, recorder, API; exits never wait on the seed; rent as a cost)
- BT-1c #53 (network state over gaps, close draws, discoveries through blackouts, holdout registry on the remote branch)
- FILL-2 #70 (trade-stream gap fills; position fills at P2 with a page cap)
- DATA-1b #69 (delegation rows; QA phase budget; resumable QA 429s)
- RUG-1c #74 (on-demand deployer rug check, the rug restart-gap closer)
- OPS-1e #66 (server extras; real worker behind a reviewed `"worker": "release"` switch; serve, never Funnel)

Earlier merges are listed in `PROJECT_STATE.md`.

**Open work** (PR → state → next action):

| Card | PR / branch | State | Next |
|---|---|---|---|
| Scan run 1 | Actions run 37156026657 | 2026-09-21 back to 09-14, 80 MB/s, one lane | DATA-1 builder reports the first published day; then batch 2 (09-13 back to 09-06), and so on to 07-20; then holdout days |
| Worker flakes | (WORKER builder, `claude/worker-1-flake`) | worker-flow, run1c and worker-recorder tests fail about 1 in 7 on the base | root cause and fix PR; blocks clean merges |
| PERSIST-1 | #71 | PASS at 76df453; merged-head CI hits the worker flake | merge after the flake fix |
| FACTS-1b live facts | #75 | delta review at f5fb54d | merge; then FACTS-1e (re-evaluate when a read lands) |
| FACTS-1d regime rule | new builder, `claude/facts-1d` | expanding window from 07-20, min 28 days, D−3; shared asset parser | review |
| DATA-1c volume assets | DATA-1 builder | `volume-hours-DAY.csv` per day plus back-fill | review; feeds FACTS-1d and BT-2 |
| OPS-1f update safety | #72 | FAIL: trap after the Node step; plus unit state and leftover backups | fixes; delta; merge; then the owner's install, Tailscale and branch-protection steps with the APK link |
| RUN-1d drills by cause | #64 | FAIL: 'unknown' universe passes; label guard | fixes; delta; merge |
| RUN-1e | #76 (stacked on #64) | tabletop ownership, compare, pending-reboot, quota, no-strategy label | review after #64 |
| BT-1d | #73 | one registry, attempt-2 window, schema-3 loader, HolderBook, congestion test (44 s), remote pin | in review |
| BT-2 study | #41 (draft) | regime wired, rent cost, staged reads, conservative defaults | first funnel count when 09-21 is testable |
| STATS-1b G3 | #52 | FAIL: B5 inside the holdout must not fail revalidation; R2/U2 tests | fixes; re-review |
| STATS-1c | #62 | rework after #52 | review; owner SPA sign-off |
| RES-3b | #56 | wall at 2026-09-21T14:00Z | waits for STATS-1c |
| WORKER-1b | `claude/worker-1b` | RUN-1d fields, sell-only flatten, PERSIST-1 wiring, all open positions in health, checkDeployer wiring | after the flake fix |
| RUG-1b | RUG builder | next card | PR |

**Blocked or parked:**
- The OPS-1d session (archived) was stopped by the auto-mode safety check while writing a server → GitHub evidence uploader. OPS-1e rebuilt everything else. Evidence stays on the host; an upload path needs the owner's decision later.

## 5. Sessions

| Role | Card | Session |
|---|---|---|
| Builder | DATA-1c, scan runs | session_01XHH3k24fjmkpmmt28xSaYv |
| Builder | WORKER-1, WORKER-1b | session_01F7UFCa8r4aee38kW7687Y3 |
| Builder | FACTS-1b, FACTS-1e | session_01GDycboQzFrFWxVniy6B6Ps |
| Builder | FACTS-1d | session_019cENcTEidMc4LEhPydYAZK |
| Builder | FILL-2, PERSIST-1 | session_013LeD4RMaJMybRnPVRn4LXM |
| Builder | RUG-1b/1c | session_01WGpxEWFacSgAuXL5KAzrKc |
| Builder | BT-1c, BT-1d | session_016KSN98NC2xQxetiZkpCVtT |
| Builder | BT-2 | session_01VBTfAwrhgoCssEzST2J2q5 |
| Builder | STATS-1b/1c | session_01J9yEWHRunNxvo5CaTbuYSe |
| Builder | RUN-1d, RUN-1e | session_01VgCLpHWaM7FjpwofRcgrwM |
| Builder | OPS-1f | session_01VM97q6A98GgtoPKCamoiT6 |
| Builder | RES-3b | session_018esLCVLp9yCExK5cdnzCz8 |
| Reviewer | DATA-1 | session_01DKMnUiqVLxVjHbaqdoBnJD |
| Reviewer | WORKER-1 | session_012QdDAuRuYt57E9PCjHfuKT |
| Reviewer | FACTS-1c | session_01UhbBj5bHiTC8AUMzp5db7L |
| Reviewer | SEED-1, FILL-2, PERSIST-1 | session_01NZwyB8decLbgxKJoG2cAbP |
| Reviewer | risk (WORKER-1 rent, risk/**) | session_017PBUwcGJWG4DJpJKVBcAas |
| Reviewer | OPS-1e | session_01Ty8Lvbxybv8cRixTifx6y3 |
| Reviewer | BT-1c | session_012efQfLAwWStK3PT6ZW2PHz |
| Reviewer | STATS-1b/1c | session_01FHfbJwz7sbf2eVDNRxMigZ |
| Reviewer | RUN-1d | session_01DdN4xy9WX2t7nLUq7ww4E5 |
| Reviewer | RUG-1c | session_01Kr3kePFCkJYuctQVaMuALW |

Sessions belong to the current supervisor's account. A supervisor on another account cannot message them; it would start its own sessions from this file.

## 6. Plan and timeline (Melbourne time; estimates, not promises)

| Milestone | When | Depends on |
|---|---|---|
| Scan run 1 started 8:42 AM: 21 Sep back to 14 Sep (then batches of 6–8 days back to 29 Aug and on to 20 Jul) | Sun 4 Oct, 8:42 AM | — |
| First practice day testable (21 Sep, after 15 days) | Mon 5 Oct, about midday–evening (±8 h) | archive speed (80 MB/s cap, one lane, 1 h per 429) |
| All practice days testable (24 days scanned) | Tue 6 Oct, about midday (±12 h) | run 1 |
| Rest of the pre-holdout days (28 Aug back to 20 Jul) | about Fri 9 Oct (±1 day) | runs 2–3 |
| Holdout days 1 Oct back to 22 Sep, then forward days as the archive publishes them | from about Sat 10 Oct | pre-holdout days done |
| Worker ready for the server | Sun 4 Oct, about 6–10 PM (±4 h) | #48, #54, FACTS-1b, #45, FILL-2, #59, OPS-1e |
| S0 shakedown on the VPS | Mon 5 Oct | owner pastes the install line; phone view needs Tailscale |
| Practice-day funnel count, then study | Tue 6 – Fri 9 Oct | practice days and their look-back published |
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
  - Tailscale setup for the phone view — steps will be sent;
  - a GitHub ruleset protecting the `holdout-registry` branch from deletion and force-push (Settings → Rules → Rulesets).
- **About Mon 5 Oct:** yes or no on replacing the DSR gate with the SPA test, with STATS-1c's simulation evidence.
- **Before live:**
  - R8 "5 losses in 20" rule;
  - the daily/weekly loss boundary switch;
  - the RISK-1 findings (C ≈ $0.79 per trade, $5 entries blocked until $29 week-start equity, stop near 84% of peak);
  - one loss of about $0.70 ends the day;
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
- **Scan order:** pre-holdout days first (21 Sep back to 20 Jul, newest first), then the holdout days, then forward days. Research and G1 need only pre-holdout days; the holdout opens only after G1, and the live index fills from RPC.
- **One holdout registry:** BT-1c's file on the remote `holdout-registry` branch, with sections plan, g1, attempts and windows.
- **Exits never wait:** not on the seed, a figure or a missing universe (sell-only flatten).

## 9. Infrastructure

- **Server:** Vultr, Frankfurt, `zeroed`, Ubuntu 24.04, US$6/month. Paired with the Telegram bot @Zeroed_alerts_bot. The worker API binds to loopback 127.0.0.1:8788; health is on :8787.
- **Keys:** GitHub secrets only: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Never in the repo or in chat.
- **Watchdog:** Cloudflare Workers, free plan, `workers.dev`. No custom domain.
- **App:** Android preview APK at the fixed `preview` release link (see `PROJECT_STATE.md`).

## 10. Risks being watched

- **U2 holdout size:** the holdout may hold fewer than 300 U2 trades. The funnel count decides, and "not proven yet" is a valid outcome.
- **DSR gate:** today's gate is close to unpassable at about 50 days, which puts the SPA sign-off on the critical path.
- **Live data gaps:**
  - Live regime volume now comes free from our own published day assets (FACTS-1d, DATA-1c), lagged to D−3.
  - Lead-in days have no token movements, so ownership is unresolved early in the window.
- **Free-tier credits:** Helius serves getProgramAccounts at 10 credits a call (gpa-probe run 37149567929); Alchemy answered 429 to back-to-back calls and is unmeasured. The RPC fill must run once per host (PERSIST-1): a 14-day create backfill on every boot projected 11.9M credits a month.
- **Archive 429s:** each costs at least 1 h; run timings above include no allowance beyond that.
- **Process:** base churn from docs pushes slows the merge queue (rule in §3).
