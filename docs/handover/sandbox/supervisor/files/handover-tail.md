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

## 4. Current state (4 Oct, 3:30 PM)

**Blocker since 3:20 PM:** every GitHub Actions job fails before it starts with "The job was not started because your account is locked due to a billing issue". The repository is public, so Actions should be free; the lock is a billing flag on the owner's account (a failed payment or card check). Steps went to the owner at 3:23 PM, with a push notification. Until it is lifted:
- nothing merges (the rule needs green CI);
- the server takes no code update (its gate needs green CI on the tagged commit);
- the data scan cannot run.

Builders and reviewers keep working and testing locally; a red check carrying that annotation says nothing about the code.

**Merged since 10:25 AM** (19): FACTS-1e #84, FACTS-1d #78, BT-1e #86, RUN-1e #76, flake fix #85, RUN-1f #91, POS-1 #88, POOL-1 #101, GATE-2 #94, PERSIST-1 #71, BT-1f #92, EXIT-1c #93, DATA-1c #77, EXIT-1e #102 (with EXIT-1d #100), REC-1 #95, STATS-1c #62, WATCH-1 #87, STATS-1d/1e #96, CI-1 #105. Base head 768a174.

**Merge queue** (review passed; each needs an update and green CI at its turn):

| Order | PR | Reviewed head | Note |
|---|---|---|---|
| 1 | CI-2 #104 | 92d8109 (supervisor's ci.yml; owner said "Allow") | — |
| 2 | OPS-1h #108 | PASS 932f670 (01Ty8L) | fixes the `zeroed-tailscale` hang |
| 3 | WORKER-1b #82 | merge check PASS 4ba930b (01UXzG) | real-worker prerequisite |
| 4 | WORKER-1c #99 | merge check PASS 66a534f (01NZwy) | real-worker prerequisite |
| 5 | RISK-MARK #103 | PASS f644ede (01NrMe) | real-worker prerequisite; whichever of #99 and #103 merges second takes the boundary marks from the marked account |
| 6 | TEST-1 #90 | 5a07ed1 (PASS af6b9b5 plus a base merge, change lines identical) | — |
| 7 | FACTS-1f #106 | PASS d79e9db (012QdD) | carries REC-1's backstop and same-event test |
| 8 | TEST-3 G3 report #98 | PASS c1f3f45 (01FHfb) | then the `worker:*` fold PR (01WGpx) |
| 9 | BT-3 #89 | 3cdf71e | — |
| 10 | APP-3 #97 | 0056506 | then API-1 (01VM97) |

**In review or building:**

| Card | PR / branch | State | Next |
|---|---|---|---|
| EXIT-1f | #107 (1ba212c) | exact open time from the ledger's open event; per-field restored-state check; `#lifecycle` line kept | 01UXzG review |
| STATS-1f | #109 (8e9d7f1) | G1 gates on the registered `g1Test` (`'spa'`, the owner's decision) | 01FHfb review: `g1Test` fixed per attempt in the registration |
| BT-2 study | #41 (draft) | `GateContext.observedTip` in live and backtest; funder cluster from the supplement | then the 09-21 funnel count and a credit estimate → 012efQ review |
| Real-worker switch | new PR | `ops/host-config.json` `"worker": "release"` | after #82, #99 and #103; review, CI, merge, then Deploy (code only) and check the server reports Online |
| WORKER-1d | — | prune saved coverage before long runs | 019cEN after #99 |
| G3 fold | — | `worker:*` reasons folded for G3, per-code counts still reported; WATCH-1 `calls.length` pin | 01WGpx after #98 |
| API-1 | — | includes the alert when `zeroed-check`'s serve reset fails (#108 nit) | 01VM97 after #97 |
| research.test.ts memory | — | peaks about 5.6 GB RSS and was SIGKILLed under parallel load | 01VgCL: shrink or stream, plus a memory assertion |
| RES-3b | #56 (draft) | wall at 2026-09-21T14:00Z | after the study's inputs |
| Historical data | data-scan | the archive answered 429 to every request for 5 h; run 1 published nothing; chained run 37171679398 still queued, and now blocked by the lock | data-source survey (BigQuery, Old Faithful mirrors and Filecoin, Triton bucket access, paid providers) in progress; if the archive keeps refusing, ask the owner to request bucket access or limits from Triton (GitHub issues on rpcpool/yellowstone-faithful, Triton Telegram, lk@triton.one) |

**Blocked or parked:**
- The server → GitHub evidence uploader (OPS-1d, stopped by the safety check) needs the owner's decision later. Evidence stays on the host.

## 5. Sessions

| Role | Card | Session |
|---|---|---|
| Builder | data scans, data source | session_01XHH3k24fjmkpmmt28xSaYv |
| Builder | WORKER-1b #82 | session_01F7UFCa8r4aee38kW7687Y3 |
| Builder | FACTS-1f #106, TEST-1 #90 | session_01GDycboQzFrFWxVniy6B6Ps |
| Builder | WORKER-1c #99, WORKER-1d | session_019cENcTEidMc4LEhPydYAZK |
| Builder | TEST-3 #98, G3 fold | session_01WGpxEWFacSgAuXL5KAzrKc |
| Builder | RISK-MARK #103 | session_01MtftXmPKCqdkXEop4h7vf1 |
| Builder | EXIT-1f #107, BT-3 #89 | session_016KSN98NC2xQxetiZkpCVtT |
| Builder | BT-2 #41 | session_01VBTfAwrhgoCssEzST2J2q5 |
| Builder | STATS-1f #109 | session_01J9yEWHRunNxvo5CaTbuYSe |
| Builder | CI-1 (merged), research.test.ts memory | session_01VgCLpHWaM7FjpwofRcgrwM |
| Builder | OPS-1h #108, API-1 | session_01VM97q6A98GgtoPKCamoiT6 |
| Builder | RES-3b #56 | session_018esLCVLp9yCExK5cdnzCz8 |
| Reviewer | DATA | session_01DKMnUiqVLxVjHbaqdoBnJD |
| Reviewer | WORKER, FACTS | session_012QdDAuRuYt57E9PCjHfuKT |
| Reviewer | #99, PERSIST-1 | session_01NZwyB8decLbgxKJoG2cAbP |
| Reviewer | risk | session_017PBUwcGJWG4DJpJKVBcAas |
| Reviewer | OPS | session_01Ty8Lvbxybv8cRixTifx6y3 |
| Reviewer | BT (BT-2, BT-3) | session_012efQfLAwWStK3PT6ZW2PHz |
| Reviewer | STATS (#109), G3 | session_01FHfbJwz7sbf2eVDNRxMigZ |
| Reviewer | RUN, TEST-3, CI-1 | session_01DdN4xy9WX2t7nLUq7ww4E5 |
| Reviewer | EXIT, POS-1, #82 merge check | session_01UXzG7h8LWHGLxtJzf7C95N |
| Reviewer | RISK-MARK | session_01NrMeuDsAQNtz4bW1LjBwYT |

Sessions belong to the current supervisor's account. A supervisor on another account cannot message them; it would start its own sessions from this file.

## 6. Plan and timeline (Melbourne time; estimates, not promises)

| Milestone | When | Depends on |
|---|---|---|
| GitHub billing lock lifted | owner | owner's billing page or GitHub Support |
| Real worker on the server (paper), Online in the app | Sun 4 Oct about 9 PM – Mon 1 AM if the lock lifts by about 5 PM; later by the length of the lock | #104, #108, #82, #99, #103, the switch PR, Deploy |
| Live dry run (48 h minimum) with restart drills | starts once the real worker runs; the qualifying run waits for the registered strategy | real worker |
| Historical days (pre-holdout first) | unknown until a working source is confirmed | archive 429s, the data-source survey, the lock |
| Funnel count, study, G1 on SPA | after the practice days and their look-back are published | data |
| Strategy registered (configs frozen, attempt committed) | was planned for Fri 9 – Sat 10 Oct; slips with the data | G1 pass on practice days |
| Holdout entry cutoff E | 20 Oct (UTC), fixed | — |
| Holdout scored (attempt 1) | Fri 23 – Sat 24 Oct at the earliest | days to 19 Oct published; observation tail matured; G1 pass |
| Funding possible | late October at the earliest, only if every gate passes | — |

If attempt 1 is not proven or fails, attempt 2 (α 0.005) starts only after its configuration is registered, on a fresh 28-day window: about 5 more weeks.

## 7. Waiting on the owner

- **Now:** lift the GitHub billing lock (steps sent 3:23 PM).
- **Maybe soon:** if the archive keeps refusing, a request to Triton for bucket access or limits (the owner had declined asking for a faster download; this would be about access at all).
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
- **CI:** GitHub-hosted runners, free for a public repository (20 concurrent jobs on the Free plan). The owner was told paid plans are not needed now.

## 10. Risks being watched

- **GitHub billing lock (now):** stops CI, merges, server updates and the data scan. Only the owner can clear it.
- **Historical data:** the archive refused every request for 5 h. Without a working source there is no backtest, no G1 and no registration, so the proof timeline slips day for day.
- **U2 holdout size:** the holdout may hold fewer than 300 U2 trades. The funnel count decides, and "not proven yet" is a valid outcome.
- **Live data gaps:** live regime volume comes from our own published day assets, lagged to D−3, so it is unknown until the scan reaches those days. Lead-in days have no token movements, so ownership is unresolved early in the window.
- **Free-tier credits:** Helius serves getProgramAccounts at 10 credits a call; Alchemy answered 429 to back-to-back calls and is unmeasured. The RPC fill runs once per host (PERSIST-1).
- **CI queue:** about 1,500 runs today. CI-2 halves the load; serial merges remain the bottleneck.
- **Memory:** `research.test.ts` peaks about 5.6 GB RSS and was killed under parallel load.
- **Session context loss:** resend the full queue after any long silence and check the post-turn summary.
- **Model fallback:** check `last_served_model` with get_session before trusting a session's tier; fresh Opus 5.5 reviews and fail-before tests stay the quality check.
