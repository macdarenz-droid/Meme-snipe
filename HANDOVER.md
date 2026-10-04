# Supervisor handover

The one file a new supervisor reads to take over the Zeroed build. It says what the supervisor does, how the work runs, where everything stands now, what comes next and what waits on the owner. It is updated in place after each merge batch, ruling batch or milestone, and not while a PR is in its final CI run (a push to the integration branch makes every queued PR re-run CI).

**Last updated:** Sun 4 Oct 2026, 6:07 PM Melbourne (AEDT).

## 1. Read first, in this order

1. `AGENTS.md` and `CLAUDE.md`: the owner's rules. They override everything here.
2. This file.
3. `PROJECT_STATE.md`: owner goals, done list, board, follow-ups, owner setup.
4. `docs/DECISIONS.md`, especially these sections: "Supervisor rulings after the external review", "Follow-up rulings", "Third-opinion rulings", "Consensus of the three reviews" (with "Closing items").
5. `docs/ARCHITECTURE.md` §6.5 (data window, regimes), §12 (host), §14 (gates G0–G5, holdout), §15 (pre-funding gate), §18 (acceptance cases).

## 2. The supervisor's role

- Owns the task board, the merge queue and the rules. It does not build features itself, beyond small docs and board edits.
- Runs every builder and reviewer as a visible Claude Code session (`create_session`), one task per session, on its own `claude/*` branch, with a PR into the integration branch `ccr-14987baf-i6lrsl`. No hidden parallel agents inside the supervisor's chat (owner rule, repeated by the owner on 4 Oct at about 4:25 PM). This includes in-chat workflows, even when a session setting such as "ultracode" asks for them: research goes to a visible session, or the supervisor does it alone.
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
  1. `update_pull_request` with `draft: false`. Once CI-2 (#104) is in, drafts run no CI at all, so a PR must be ready before its final update.
  2. `update_pull_request_branch` with the full head SHA as `expectedHeadSha` (GitHub writes a merge commit into the head).
  3. Wait for CI on the new head. The helper polls `api.github.com/repos/<repo>/commits/<sha>/check-runs` until nothing is queued or in progress.
  4. Confirm the head contains the latest base (`git merge-base --is-ancestor`).
  5. When the reviewed SHA is older than the head, confirm the code change lines are identical. Diff `git diff -U0 base..reviewed` against `git diff -U0 base..head`, with the `@@` and `index` lines stripped and docs excluded. Anything else goes back to the reviewer for a merge check.
  6. `merge_pull_request` with `expectedHeadSha` and `merge_method: merge`.
- **Serial merges.** Every merge moves the base, so the next PR needs another update and another CI run (about 8–15 min each while the queue is busy). Update one or two PRs at a time, in queue order.
- **CI-2 (#104), once merged:**
  - Feature branches run CI only through their PR, not also on push.
  - Drafts wait until they are marked ready.
  - A newer head cancels the older PR run.
  - The base branches still run on every push.
- **Docs pushes.** Don't push docs while a PR is in its final CI run; the push forces another cycle. Push right after a merge, before updating the next PR.
- **Background waits.** Give background shell waits `timeout: 7200000`; the default 30 min kills them. Stamp the log with `date -u`, never from memory.
- **Shell pitfall.** In a shell wait loop, never `pkill -f "<pattern>"` with a pattern that also matches the killing command: it kills its own shell.
- **Cancelling runs.** Mass-cancelling other workflow runs was refused by the auto-mode safety check; do not do it.
- **Stacked PRs.** Some PRs carry another PR's commits merged in. Merge the dependency first, or merge the carrier and close the carried PR with a comment (as #100 went in through #102).
- **Server code updates (owner authorisation, 4 Oct, 2:45 PM):**
  - The supervisor may run the Deploy workflow for code updates only, never keys.
  - The `DEPLOY_CODE` secret stays absent: the owner deleted it at 2:47 PM because the old code had been shown in chat. Never reuse that code.
  - A run must log "No DEPLOY_CODE secret: code update only, no keys sent." (first run 37174740782 did).
  - Deploy moves the `deploy` tag to the newest GitHub-signed merge commit. Every 5 min, `zeroed-update` on the server switches to it if CI on that commit is green, no dry run is active and no intents are open.
  - The real worker also needs `ops/host-config.json` `"worker": "release"` (it is `"stub"` now), which goes in its own reviewed PR.
- **Data downloads** run on GitHub Actions (`data-scan.yml`), not in a session:
  - Dispatch inputs: `mode=scan`, `days=<UTC days, newest first, comma-separated>`, `max_mbps=80`. `assemble` builds a dataset window.
  - One concurrency group; it stops on HTTP 429 and resumes with back-off.
  - Each finished UTC day is published as a release tagged `data-day-YYYY-MM-DD`.

## 4. Current state (4 Oct, 6:07 PM)

**GitHub:** the owner's account is on GitHub Pro since about 3:47 PM (40 jobs at once). Declined Pro payments locked Actions from 3:15 to 3:23 PM and from 3:37 to 3:42 PM. If "The job was not started because your account is locked due to a billing issue" returns:
- nothing merges, the server takes no update and no data job runs;
- send the owner to github.com/settings/billing;
- tell the builders a red check with that annotation is not theirs.

**Merged since 10:25 AM** (31): FACTS-1e #84, FACTS-1d #78, BT-1e #86, RUN-1e #76, flake fix #85, RUN-1f #91, POS-1 #88, POOL-1 #101, GATE-2 #94, PERSIST-1 #71, BT-1f #92, EXIT-1c #93, DATA-1c #77, EXIT-1e #102 (with EXIT-1d #100), REC-1 #95, STATS-1c #62, WATCH-1 #87, STATS-1d/1e #96, CI-1 #105, WORKER-1b #82, CI-2 #104, OPS-1h #108, TEST-1 #90, BT-3 #89, RISK-MARK #103, APP-3 #97, DATA-2 #111, MEM-1 #112 (5:16 PM), STATS-1f #109 (5:29 PM), WORKER-1c #99 (5:51 PM), WATCH-1b #113 (6:05 PM). Base head 8706826.

**Merge queue.** Before each merge, check that the PR's files don't overlap a critical-path PR that is in a merge check. Merging #90 forced #103 into another base merge. Every merge makes the other PR heads stale (each needs a base update and a CI run of about 8–10 min), so the critical path goes first and docs pushes ride right after a merge.

| Order | PR | State | Note |
|---|---|---|---|
| 2 | BT-2e data pull #119 | PASS 083af50 (01DKMn) + test-only a26c2c5 (supervisor checked); base update in CI | then dispatch data-scan: mode scan, source helius, day 2026-09-21, max_credits 270000, rpc_rps 5 |
| 1 | SWITCH-1 #110 | delta PASS 692862e (01Ty8L: trial OOMScoreAdjust +1000, worker −500); base update in CI | then Deploy (code only) and check Online |
| 4 | RENT-1 #114 | PASS; green 0eae86d (identical to 02d5f1d) | before #115 (one rent model) |
| 3 | WORKER-1e #117 | PASS both sides cb0a219 (017PBU, 012QdD); push asked (open-minute flow test, REPORT H15 line, approve_risk label, dedupe key) → 012QdD quick delta | makes practice trades possible |
| 6 | FACTS-1f #106 | merge check PASS 403924e (012QdD) | after #117; adapts to #117's path (trial merge 48/48 done locally) |
| 7 | CI-1b #116 | PASS 82c49a1 (01DdN4); green 38b6743 before #99 merged | needs a base update (overlapped #99); nit 1 (keep double count) on its next push |
| 8 | EXIT-1f #107 | PASS ce7c78b (01UXzG) | then EXIT-1g |
| 9 | TEST-3 G3 report #98 | PASS c1f3f45 (01FHfb) | then the G3 fold |
| 10 | API-1 #118 | FAIL 7433148 (01DdN4): "Entries: On" while a risk stop refuses entries; notRunning accepted for paper → 01VM97 | after #110 |
| 11 | RES-4 #115 | C1 fixed d8e500b; ruling: one rent model (#114's), term export only as a pure refactor with a golden test | then 012efQ re-checks C1 |
| — | BT-TAIL (new) | the slot-tail change leaves #56/#120 into its own PR (018esL; 012efQ) | proof-scoring change, test fails before and passes after |

Merged this evening: WATCH-1b #113 (8706826, 6:05 PM), WORKER-1c #99 (d92b73e, 5:51 PM), STATS-1f #109, MEM-1 #112, DATA-2 #111, APP-3 #97, RISK-MARK #103.

**In review or building:**

| Card | PR / branch | State | Next |
|---|---|---|---|
| Helius pilot | run 37181739639 | PASSED: parity on all tables (raw logs = Agave's cut), full history depth, 5,225 credits, 5 blocks/s on free. Full pull ≈ 18.95M credits (≈ US$94 on Developer, 5–6 days best case, unmeasured) | the owner chose free only (one day per ~14 h); paid month not before a finished product |
| ARCHIVE-CHECK | live on the default branch | one ≤64-byte request every 3 h with our real User-Agent; dispatches the scan only on a 206 | 01XHH3k reports the first answers |
| BT-2 study | #41 (draft) 501200d in review (012efQ) | funder cluster, `observedTip`, STATS-1c freeze | next: RES-4's six hypotheses as one SPA family (k = 6), the pre-registration hash check, one trial log per registry, the BT-2e runner (01VBTf, about 8 PM – 2 AM) |
| BT-2e early look | 01VBTf | U2 plus RES-4's U2 ideas plus S0 on the free days, labelled "early look, not proof" | about Tue 6 – Wed 7 Oct |
| RES-5 survival markers | #120 (draft, 018esL) | owner's idea: what separates the ~9% survivors from look-alike losers at buy time; research only, nothing into the bot or app; tell the owner only if it beats what we have | Phase A code up (7c9f0ef); Phase B on the free days, after #115 and BT-TAIL |
| WATCH-1c | #121 (01WGpx; 017PBU reviewing 12ae9f5) | coverage-proven freshness for quiet held pools (0 reads while the trade stream is continuous), a non-swap transaction makes the chain stale, a 30 s verify read against vault donations, measured p99 slot time in the guard | after #113 |
| PERSIST-2 | 01F7UF | save and seed the graduates series; list every input a restart resets | after #117 |
| EXIT-ROUTE | — | wire `sellRoute` so the no_route exit can fire | before the qualifying run |
| EXIT-1g | 016KSN | N4, N6, N7 (bounded journal read at start) | after #107 |
| WORKER-1d | 019cEN | prune saved coverage before long runs | after #99 |
| G3 fold | 01WGpx | `worker:*` reasons folded for G3 | after #98 |
| API-1 | #118 (01VM97) | status serves why entries are off; FAIL 7433148 → serve risk stops (daily, weekly, session, kill latch, loss pauses) as read-only halt codes, fresh regime only; fall back to APP-3's never-On rule if risk/** would change | after #110 |
| RES-3b | #56 (draft) | wall at 2026-09-21T14:00Z | after the study's inputs |

**Blocked or parked:**
- The server → GitHub evidence uploader (OPS-1d, stopped by the safety check) needs the owner's decision later. Evidence stays on the host.

## 5. Sessions

| Role | Card | Session |
|---|---|---|
| Builder | DATA-2 (merged), pilot, ARCHIVE-CHECK, free practice-day pull | session_01XHH3k24fjmkpmmt28xSaYv |
| Builder | WORKER-1e #117, PERSIST-2 | session_01F7UFCa8r4aee38kW7687Y3 |
| Builder | FACTS-1f #106, TEST-1 #90 | session_01GDycboQzFrFWxVniy6B6Ps |
| Builder | WORKER-1c #99 (second lander), WORKER-1d | session_019cENcTEidMc4LEhPydYAZK |
| Builder | TEST-3 #98, WATCH-1b #113, WATCH-1c, G3 fold | session_01WGpxEWFacSgAuXL5KAzrKc |
| Builder | RISK-MARK #103 | session_01MtftXmPKCqdkXEop4h7vf1 |
| Builder | EXIT-1f #107, RENT-1 #114, EXIT-1g | session_016KSN98NC2xQxetiZkpCVtT |
| Builder | BT-2 #41, BT-2e early look | session_01VBTfAwrhgoCssEzST2J2q5 |
| Builder | STATS-1f #109 | session_01J9yEWHRunNxvo5CaTbuYSe |
| Builder | MEM-1 (merged), CI-1b #116 | session_01VgCLpHWaM7FjpwofRcgrwM |
| Builder | SWITCH-1 #110, APP-3 #97, API-1 | session_01VM97q6A98GgtoPKCamoiT6 |
| Builder | RES-4 #115, RES-5, RES-3b #56 | session_018esLCVLp9yCExK5cdnzCz8 |
| Reviewer | DATA (#111) | session_01DKMnUiqVLxVjHbaqdoBnJD |
| Reviewer | WORKER, FACTS | session_012QdDAuRuYt57E9PCjHfuKT |
| Reviewer | #99, PERSIST-1 | session_01NZwyB8decLbgxKJoG2cAbP |
| Reviewer | risk | session_017PBUwcGJWG4DJpJKVBcAas |
| Reviewer | OPS | session_01Ty8Lvbxybv8cRixTifx6y3 |
| Reviewer | BT (BT-2, BT-3) | session_012efQfLAwWStK3PT6ZW2PHz |
| Reviewer | STATS (#109), G3 | session_01FHfbJwz7sbf2eVDNRxMigZ |
| Reviewer | RUN, TEST-3, CI-1 | session_01DdN4xy9WX2t7nLUq7ww4E5 |
| Reviewer | EXIT (#107 PASS), POS-1 | session_01UXzG7h8LWHGLxtJzf7C95N |
| Reviewer | RISK-MARK | session_01NrMeuDsAQNtz4bW1LjBwYT |

Sessions belong to the current supervisor's account. A supervisor on another account cannot message them; it would start its own sessions from this file.

## 6. Plan and timeline (Melbourne time; estimates, not promises)

| Milestone | When | Depends on |
|---|---|---|
| Real worker on the server (paper), Online in the app | Sun 4 Oct about 7–9 PM (about midnight if a check fails) | SWITCH-1 #110, Deploy (#99 and #113 merged) |
| Practice trades (S0 shakedown with the labelled diagnostic set) | tonight about 10 PM – 1 AM (owner asked for speed, quality unchanged); else Mon morning | WORKER-1e #117, a second code-only Deploy |
| Live dry run (48 h minimum) with restart drills | starts once the real worker runs; the qualifying run waits for the registered strategy | real worker |
| Free practice days (09-21, then 09-20, 09-19) | one day per about 14 h on Helius free; 09-21 starts tonight after #119 | #119 |
| Historical days (19 Jul – 3 Oct) | not scheduled: the owner wants a finished product before any spend (paid month about US$94, 5–6 days best case) | owner decision after Online, practice trades and the early look |
| Funnel count, study, G1 on SPA | after the practice days and their look-back are published | data |
| Strategy registered (configs frozen, attempt committed) | was planned for Fri 9 – Sat 10 Oct; slips with the data | G1 pass on practice days |
| Holdout entry cutoff E | 20 Oct (UTC), fixed | — |
| Holdout scored (attempt 1) | Fri 23 – Sat 24 Oct at the earliest | days to 19 Oct published; observation tail matured; G1 pass |
| Funding possible | late October at the earliest, only if every gate passes | — |

If attempt 1 is not proven or fails, attempt 2 (α 0.005) starts only after its configuration is registered, on a fresh 28-day window: about 5 more weeks.

## 7. Waiting on the owner

- **Now:** nothing.
- **Before the qualifying run:** the execution-health limits (live risk limits; a proposal from the shakedown's measured figures).
- **History source:** free Helius only, one day at a time (owner, about 5:35 PM). No paid month until the owner has seen a finished product: the server Online, practice trades in the app and the early-look report (owner, about 5:40 PM). The Triton email was sent by the owner; ARCHIVE-CHECK keeps asking politely every 3 h. Disguising the scanner was declined (terms, ban risk).
- **Done today:**
  - setup parts A–D at 2:31 PM (server re-install at pin e28788a, Tailscale with HTTPS and serve, the APK, and ruleset 24441882 on `holdout-registry`);
  - SPA chosen for G1 at 2:33 PM;
  - Deploy authorised for code updates only at 2:45 PM;
  - `DEPLOY_CODE` deleted at 2:47 PM.
  - The app shows "Server error" until the real worker runs; that is expected.
- **Before live:**
  - R8 "5 losses in 20" rule;
  - the daily/weekly loss boundary switch;
  - the RISK-1 findings (C ≈ $0.79 per trade, $5 entries blocked until $29 week-start equity, stop near 84% of peak);
  - one loss of about $0.70 ends the day;
  - whether the server may upload evidence to GitHub (the blocked OPS-1d part).
- **Later (owner's idea, not now):** a switch to choose G1's test (SPA or DSR). Both paths are kept and tested in STATS-1f; no UI or config switch is built.

## 8. Key rulings in one place (details in DECISIONS)

- Paper only until all six pre-funding items pass.
- **Holders:**
  - The mint is read first, at confirmed commitment, and must have no mint authority.
  - Then one getProgramAccounts call (V1, indexed filters), with an exact sum to supply and no duplicates or foreign mints.
  - Delegates count as control. Top-20 lists are for definite rejects only.
- **Statistics:**
  - G1 gates on the SPA test (owner, 4 Oct). The test is fixed per attempt in the registration (`g1Test`), and a registration without it fails G1. The clamped DSR is still reported.
  - SPA: block lengths 3/5/7 with the maximum p-value, within regimes (short regimes merged into a neighbour), two benchmarks in one joint test, α 0.05.
- **Holdout:**
  - Sealed window 22 Sep to 20 Oct (UTC). E is the entry cutoff; scored once, after the observation tail, and only after a G1 pass.
  - Registration commits the attempt. The error budget is 0.04, then 0.01/2^(k−1).
- **G3:**
  - α/3 on the veto-bias composite; consistency checks keep their own levels; a joint reject-mix test; power reported at 48 h.
  - The observation tail is at least the maximum hold plus the exit ladder. Decisions are cut at the evaluation time, outcomes are read to the cut plus the tail, and censoring is symmetric.
- **Capital:** three measures (NAV per unit for the kill switch, trading P&L for day and week limits, the lower of ledger and wallet-marked equity for sizing); withdrawals queue until the bot is flat.
- **Marks (RISK-MARK):** each open position is marked at the worst executable rung with a fresh SOL price. With no mark, the exit fallback applies; an entry that throws is caught.
- **Rent:** refunded only when a full atomic sell-and-close lands.
- **Exits:**
  - Per-universe settings, with T_max ≤ 120 min in phase 1. The R9 stops (including the flow stop) stay global.
  - Exits never wait: not on the seed, a figure or a missing universe (sell-only flatten).
  - A restored position's open time is the exact ledger open-event time; the slot bound is only a fallback, so a time stop can never restart.
- **Never remove a guard.** A simplification that drops a guard is reverted. This happened three times today: `hardAllowsEntry` in #106, the max-guard in #99 and the `#lifecycle` line in #107.
- **Restart ordering:** a halt raised before the restore keeps both layers, the worker's ordering (#82) and the strategy's gate (#102).
- **Deployer checks (WORKER-1c):**
  - a cache per creator;
  - a slot guard on every answer;
  - one check in flight per creator;
  - roll forward only;
  - the budget reserved before the read.
- **Live positions must be priced:** POS-1 derives a held position's pool state from its own swap events. WATCH-1's coherent second-path read is the fallback, covering entries in flight and reading once at the open. A gap or mismatch is stale, never guessed.
- **Observation delay** re-stamps receipt time only. `GateContext.observedTip` is required in both live and backtest (live uses the feed tip).
- **BT-2 funder cluster** comes from the funding supplement. A missing supplement fails G2.
- **A rate limit stops entries through the gates failing closed** on the missing fact, not a global halt; exits keep their quota.
- **Live volume releases are trusted only by provenance** (API metadata, digest-verified download, verified days persisted).
- **Worker tests are deterministic** (fixed harness boot seed, bounded waits on effects).
- **Scan order:** pre-holdout days first (21 Sep back to 20 Jul, newest first), then the holdout days, then forward days.
- **One holdout registry:** BT-1c's file on the remote `holdout-registry` branch, protected by ruleset 24441882 (no deletion, no force-push).
- **Server networking:**
  - The dashboard is published on the tailnet only, with `tailscale serve`, never Funnel.
  - `zeroed-tailscale` checks HTTPS and MagicDNS first, bounds every call and accepts only the exact serve config (#108).
  - The tailnet's DNS name stays out of the repo.
- **Stored data:** `account.json` marks, `deployer-state.json` and `fill-budget.json` are the bot's own state, approved by the supervisor under the stored-data ruling.

## 9. Infrastructure

- **Server:** Vultr, Frankfurt, `zeroed`, Ubuntu 24.04, US$6/month, re-installed at pin e28788a on 4 Oct.
  - Paired with the Telegram bot @Zeroed_alerts_bot.
  - The worker API binds to loopback 127.0.0.1:8788 and is published on the tailnet by `tailscale serve`. Health is on :8787.
  - It runs the stub worker until the switch PR.
- **Keys:** GitHub secrets only: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. `DEPLOY_CODE` is deliberately absent. Never in the repo or in chat.
- **Watchdog:** Cloudflare Workers, free plan, `workers.dev`. No custom domain.
- **App:** Android preview APK at the fixed `preview` release link (see `PROJECT_STATE.md`).
- **CI:** GitHub-hosted runners, free for a public repository. The owner's account is on GitHub Pro (owner's decision, 4 Oct): 40 jobs at once.

## 10. Risks being watched

- **GitHub billing lock:** from declined GitHub Pro payments (3:15–3:23 PM and from 3:37 PM, 4 Oct). It stops CI, merges, server updates and data jobs, and only the owner can clear it.
- **Historical data:** the archive blocks our scanner. Without a working source there is no backtest, no G1 and no registration, so the proof timeline slips day for day.
  - Helius is untested for this use: its history depth, newer transaction versions, reply-size limits and our speed are all unknown, which is why the free pilot comes before any spend.
  - Helius's terms forbid passing on their service, so raw files stay out of public releases until the terms are confirmed.
  - The pull shares credits with the live dry run, so measure the dry run's use before setting the cap.
- **U2 holdout size:** the holdout may hold fewer than 300 U2 trades. The funnel count decides, and "not proven yet" is a valid outcome.
- **Live data gaps:** live regime volume comes from our own published day assets, lagged to D−3, so it is unknown until the scan reaches those days. Lead-in days have no token movements, so ownership is unresolved early in the window.
- **Free-tier credits:** Helius serves getProgramAccounts at 10 credits a call; Alchemy answered 429 to back-to-back calls and is unmeasured. The RPC fill runs once per host (PERSIST-1).
- **CI queue:** about 1,500 runs today. CI-2 halves the load; serial merges remain the bottleneck.
- **Memory:** `research.test.ts` peaks about 5.6 GB RSS and was killed under parallel load.
- **Session context loss:** resend the full queue after any long silence and check the post-turn summary.
- **Model fallback:** check `last_served_model` with get_session before trusting a session's tier; fresh Opus 5.5 reviews and fail-before tests stay the quality check.
