# Supervisor handover

The one file a new supervisor reads to take over the Zeroed build. It says what the supervisor does, how the work runs, where everything stands now, what comes next and what waits on the owner. It is updated in place after each merge batch, ruling batch or milestone, and not while a PR is in its final CI run (a push to the integration branch makes every queued PR re-run CI).

**Last updated:** Mon 5 Oct 2026, about 12:55 AM Melbourne (AEDT), by the new account's supervisor (session_012En9L5mnYQtEz7oyp1Eryf). §0 below is the 7:45 PM account-transition handover from the first account; "New account" right after this line is what changed since.

**New account (from about 8:00 PM, 4 Oct).**
- Supervisor: session_012En9L5mnYQtEz7oyp1Eryf. It read AGENTS.md, CLAUDE.md, this file, all 22 session notes and the supervisor log, and re-listed the open PRs (heads matched §4).
- 24 new sessions were started at about 8:05 PM, one per card line, each from its predecessor's notes: 10 builders, 8 reviewers and 6 read-audit sessions (the owner asked for every file in the repo to be read; the audits cover all 2,015 tracked files in six slices and report findings only). The table is in §5.
- Base CI was red on 456d58fe (push run 37190077658): `packages/runner/test/runner.test.ts:179`, the host-loss tabletop, `recovered_state: false`. The only change since the green 35d31f4e was HANDOVER.md, so it is the known stub write-order flake, which CI-1b #116 fixes (20e8d5f: the stub journals an exit before its state drops the position). #116 merged first, at about 8:15 PM (bf62839; check green on 80b50d1, change identical to the reviewed c5aaf88).
- The first account's supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ) pushed two docs commits after the handover (a8165aa, fff0017 at 7:59 PM). The owner stopped it at about 8:42 PM.
- **Online confirmed by the owner at about 8:42 PM** (the app shows Online): the server runs the release's paper worker from the 7:28 PM Deploy (7d5e203). It makes no practice trades yet: PRACTICE-ON sets the S0 shakedown.
- **DATA-PUB #144 merged at about 8:56 PM** (c83b92d; data reviewer PASS at 4b57346, 13/13 mutants; check green; the supervisor checked the `.github` change: guards only plus one cache-save step on the repo's existing pin). A helius day is now never uploaded or published; its packaged assets stay in the actions cache (`data-rpc-assets-DAY-*`). Chain run 1 (37185822426) still runs the old yaml; its continue job dispatches run 2 at about 11:28 PM from the branch tip, which has the fix. Rulings: the finalize.go:1003 "Old Faithful" source label lands with the DATA-5 B5 decoder card, which moves the scanner tree (and so both the archive and rpcscan revisions) anyway; in #127 it would move the archive revision twice, and moving it now would re-read about 250k credits of cached 09-21 units. Risk noted: the actions cache is neither private (the integration branch is the default branch, so any branch can restore it) nor durable (7-day idle eviction, 10 GB cap); BT-2e must restore the 09-21 assets within 7 days, and their size is checked when the chain ends.
- **09-21 chain run 2 dispatched at 11:28 PM** (37202213673, from tip a8b0355, which has the DATA-PUB fix). Run 1's scan stopped resumably at its time budget (scan step marked failed, "Mark the day resumable" and "Save progress" succeeded, continue job dispatched run 2), as designed. Expected finish Monday about 9–11 AM Melbourne.
- **Owner's Snipe screenshots at 10:42 PM:** server Online; the S0 worker live since about 10:38 PM (funnel window 22:38–22:42: Seen 1, passed hard rejects 0, entered 0; per-day chart 2 seen on 4 Oct); Risk shows the served daily loss "$0.00 of $1.50"; Decision journal empty because a row is written only when a candidate is rejected or skipped (worker.ts #view). Snipe's Session card is also EMPTY_SESSION ("Not started", limits "Not set", "Start paper session — Worker not connected") although the worker starts its own session (main.ts startSession(TRIAL_POLICY)); APP-HOME now covers it. The switch at about 10:38 PM, rather than about 10:10 PM, is unexplained from here (no server access); the daily summary will show restarts.
- **Owner's phone at 10:28 PM:** Paper, "Not started · Online", Home "No tokens discovered / Waiting for the data feed". Online is real (the app reaches the server). "Not started" and the empty Discovered list are placeholders not wired to the worker (App.tsx renders `<Home />` without rows; the session line is EMPTY_SESSION). The decisions are on the Snipe tab (Funnel, Journal, served at /api/v1/paper/*). The owner was asked for a Snipe screenshot. APP-HOME (API builder, after #118) wires Home and the session line to the worker, then a new APK.
- **Owner, about 10:25 PM: "yes summary".** A daily summary of the paper bot (decision counts, refusal reasons, paper trades, paper P&L; never keys, the tailnet name or personal data) goes from the server to a private GitHub repo the supervisor can read, because no agent can reach the server. Card OPS-SUMMARY (session_01HHYJq5qSsQ316kEvuzKDaM): design first (transport with the fewest server secrets, preferably the signed heartbeat → watchdog → private repo), then build. The owner's steps (create the private repo, create a token) come with the PR. Design approved at about 10:30 PM: the worker builds the summary from journal.jsonl and POSTs it every 30 min, plus a midnight close, to a new signed watchdog route; the watchdog writes reports/ in the private repo with a Cloudflare-only token; a new Deploy step deploys the watchdog code-only and never touches HEARTBEAT_HMAC_KEY. Found while designing: a Deploy run with a stale DEPLOY_CODE would rotate the watchdog HMAC key without the server picking it up (heartbeats then 401, /pause stops working). DEPLOY_CODE is absent, so nothing is broken; KEY-ROTATE-SAFE fixes it next. KEY-ROTATE-SAFE design (about 11:03 PM): B2. The watchdog holds two heartbeat-key slots (and two webhook-secret slots), and the workflow writes only the inactive slot. The first heartbeat signed with it promotes it and retires the old one (stored as a hash only). A wrong or stale DEPLOY_CODE leaves the active key working, and an offer pending over 24 h raises an alert.
- **DEPLOY HOLD (about 11:15 PM; lifted at about 11:56 PM when #156 merged):** #123 merged at 16555b5, after which the worker/facts reviewer withdrew the PASS. readJournalFills reads the whole journal with readFileSync on every boot, which risks an OOM kill under MemoryMax=800M as the shakedown journal grows. The server runs bfb2384 (without #123), so it is not affected yet. No Deploy until the fix-forward PR (claude/worker-order-fix: stream via booked.ts journalLines, chunk-boundary test) merges.
- **#157 APP-HOME merged at about 12:08 AM Mon 5 Oct** (f3fca3d). Next: push CI on f3fca3d green, then a code-only Deploy (it adds the worker /discovered endpoint and restarts the worker), then #158 APP-WORDS 2, then a new APK for the owner. **#41 BT-2: stats PASS at ecb6e3f** (M1 one α budget 0.05/4 with aliases, CR2 gap on capped returns; M2 replicates ceil(20/(α/m)) and the same-regime control in the fingerprint; mutants killed; 140/140 locally); stats queue empty. Optional later hardening: one g2SeriesOf(u) helper for powerOf and the gateG2 input. #41 still needs BT and worker passes and a base merge.
- **Deploy at about 12:21 AM Mon 5 Oct** (run 37205298918): tag `deploy` → f3fca3d (APP-HOME, plus #123, #129, #56, #120, #156 since bfb2384); log shows "No DEPLOY_CODE secret: code update only, no keys sent."; check green on f3fca3d; no ops-touching commit since bfb2384. f3fca3d's status also carries `session`, so only an APK with #157 (preview-296cc47 or later) reads it; the preview link served preview-296cc47 from 12:20 AM. The owner was told to install it after Telegram reports "deployed f3fca3dd8e5d". #158 APP-WORDS 2 merged right after (2af7984; no API schema change, compatible with f3fca3d). Next Deploy: after #159 (and #158's worker trigger words).
- **Server on f3fca3d at 12:24 AM Mon 5 Oct** (owner's Telegram: "deployed f3fca3dd8e5d. Worker restarted and up."; 3 min after the Deploy). The owner was sent the APK link and checks (Online holds, Home lists tokens, Session card shows the worker's session). This restart also counts for the memory stopgap: next restart by Thu 8 Oct about 12:24 AM.
- **Owner, 12:26 AM: the new APK works** ("Running · Online", Home lists a discovered token). **Owner ask, about 12:30 AM:** see paper/live traded coins with P&L, running time, % return (ROE) and margin, like normal live trade info. Today the Snipe tab has an Open trade card (entry price, size, liquidation value, unrealized $, costs, exit rules) and a closed-trades list ($, R, size, costs, held, exit); missing: price now, % return, a running timer, % on closed trades. Card APP-TRADE sent to the API/APP builder (after #162 APP-COMPAT merges). Margin is not added: the bot buys outright (spot, no leverage), so size is the full amount at risk. Owner, 12:31 AM: copy a token's address and open it in Pump.fun; added to APP-TRADE as item 6 (full mint to the clipboard; https://pump.fun/coin/<mint> opened outside the webview, built only from a mint that passes the MINT check). Also carded: Home's Volume 24h and Holders columns are hard-coded null (always "—"), and Liquidity read "—" on a 1m19s-old token.
- **G4b ruling (about 12:35 AM Mon 5 Oct):** the deployer index measures 49 MB at 1M with shared strings (the 260 MB figure was wrong); the 1M boot cost (1,077 MB) is the index carried as one JSON tree through several copies. Approved: (a) the index saved as one line per creator, streamed and hashed incrementally; (b) the seed fact carries the saved state's hash, the recorder copies state.json's exact bytes into the boot's recording folder, and the parity replay restores from that copy and refuses on a missing copy or hash mismatch. Supervisor-approved under the stored-data rule (same public data and own labels). Expected 1M boot about 300 MB. Reviews: worker/facts, persist (state.json v2, atomic save), BT (parity replay).
- **Owner, 12:40 AM: "update like a kid": workers, tasks, overall timeline, data gathering.** Answered at 12:42 AM with a builders/checkers table, the merge line, the overall timeline and the three data streams (live notebook since Sun 10:08 PM, 09-21 download ending Mon 9–11 AM, daily summary after #155 plus the owner's 5 steps). #41 marked ready so CI runs (head 2b13665, base 50c6227 merged; survival-fixture fill-ins 0n/0n/'' for the BT delta check).
- **Owner, 12:38 AM: no practice trades.** App on f3fca3d: Candidates 00:23–00:37 Seen 4, Passed hard rejects 0, Entered 0; since PRACTICE-ON (10:08 PM) no entries at all. Lead: hard gates may need facts the live feed doesn't produce in time (WORKER-HARDEN's note on processed logs), which fails safe but means the shakedown never exercises entries. Card S0-ZERO to the PRACTICE-ON builder (un-parked, 01MgoMnQ): map hard rejects to the facts they need and whether live produces them in time; fix by making evidence arrive, never by loosening a gate. Owner asked for a Decision journal row screenshot.
- **OWNER GOLDEN RULE (about 1:00 AM Mon 5 Oct): treat paper money as real money.** Recorded in CLAUDE.md (89a6f73) and sent to all 26 builder and reviewer sessions, with a request to re-rate any finding they downgraded because it "only affects paper". The mode stays paper; only the owner switches to live. Applied by the supervisor: the zero-entries bug and the restart loss of candidates are treated as real-money outages (top of the queue), and paper P&L display rounding (#165 N2) is fixed before merge.
- **Golden-rule re-ratings (about 1:00–1:10 AM), rulings:** (1) #165: subtract the expected exit network fee in openPnl (P&L = net if closed now); per-row cent rounding stays. (2) #161: webhook co-switch window reversed to blocking: the webhook offer is marked adopted at the heartbeat switch and the old secret stays accepted until Telegram's first new-secret request or 24 h; in the #161 /summary push; ops re-review. (3) OPS-SUMMARY follow-up: unrealized P&L per open position + day total + unquotable count, plus rss_bytes. (4) #41 merges as is; powerInputs (b8fd49a4) and a SOL/USD-stale flag go to BT-2f after it. (5) PAPER-2 blocking: oversell/phantom proceeds (run/CI's #133 N1, same path: never sell more than the current quantity; paper TokenAccounts refuses a sell beyond balance), #why bound, late-stop reasons from the ledger, late fees on closed trades, late sell updating net, sibling rent, restart-in-flight reachability test. (6) ACCOUNT-RATE to the worker-order builder: a fill before the first SOL price waits for its rate instead of booking −notional (could trip a wrong daily_loss halt); behind() catches a missed partial exit; legacy unpriced fills counted in the run report. (7) #149 item b blocking (ops): state the limit, console recovery procedure, alert while updates are held by intents with the worker down. (8) REGIME-MIN to the RES builder (persist reviewer's #125 N4): minimum graduates per day behind the survival median, thin day = unknown; blocks the qualifying run and live. RES-5c creator-block permutation before RES-5 phase B; #115 extra-dump test after #115. (9) API-1 N1' to the API/APP builder after #165: the served waived list is the S0 set's union while S0 diagnostic is on. (10) N2-WRITES as its own PR from WORKER-HARDEN (writeAll + tmp size check before rename). (11) EXIT: restore-time drop of saved exits with no booked position, after #142. (12) risk reviewer to rule on #132's deferred external_sale loss vs daily_loss. Stayed as rated with reasons: stats reviewer's #120 N5 (RES-5 gates nothing; blocking if ever used as an entry filter), EXIT reviewer's #165 notes (display-only), persist reviewer's #131 N6 (proved harmless).
- **More golden-rule verdicts (about 1:05 AM):** #132 RISK-PARTIAL now FAIL at a244707 (risk: no-price partial lostShare leaves out entry fees; external_sale basis kept until the next booked part mis-times daily_loss across days; fix by routing an exit's orphan_fill into filled() as #133's 761e1b2; whichever of #132/#133 lands second carries it). #133 PAPER-1 now FAIL (risk: a stray entry fee can be lost when #fold runs with no SOL price; loss rounding unpinned; a test proving no entry orphan_fill after close in paper). Both builders told; #133 leaves the immediate merge line until fixed. #41's head moved to b1b9fdb (builder pushed powerInputs + SOL/USD-stale flag before the hold arrived); ruled keep (no revert): stats PASS on powerInputs at b1b9fdb (1:04 AM; same series by construction; G2 mismatch path fails closed in core), BT reviews the flag. Worker/facts reviewer re-check: none (paper-unreachability of #133 items 2, 4, 5 re-verified from code). #149: ops builder at ab4cdf5 (two e2e test bugs fixed; CLOCK_FILE flake fix replaces #153's WAIT 60; full check running).
- **Real-money audits started (1:06 AM, owner: "you found 8 problems by considering it real money"):** four read-only Opus sessions audit every money path with the golden-rule lens and report findings only (file:line, trigger, effect, failing-test sketch): AUDIT-RM1 fills/settlement/P&L (session_016kzPnTREpQTK5DiZ4uhh21), AUDIT-RM2 risk limits/halts/stops (session_01SPadkovMbm51pBCnH1v3JE), AUDIT-RM3 exits/recovery/restarts (session_012SGxTeYVa3bjDxkGxVuett), AUDIT-RM4 entry gates/data truth (session_01WircdoNdNPMpQefmbESEA9). Each is archived after its report is carded.
- **S0-ZERO findings (12:44 AM, code at d3cfc14): every live candidate is blocked structurally, not by bad coins.** (1) H11 (and H5's event-tail check) can never pass live: candles are observed at the migration slot but `trades:<pool>` coverage starts at the first live slot after PoolWatch subscribes (no first-subscribe fill), so H16 `gap` rejects 100% (producer.test.ts:203 pins the case). (2) Candidates are in memory only and S0 evaluates 60–240 min after migration, so every restart (each Deploy) forgets them; tonight's 00:23–00:37 "Seen 4, passed 0" could not have been evaluated before about 1:23 AM. (3) After a restart, coins created earlier reject on H9 (a processed-only create makes no fact; the create tx is fetched only if this process saw its log). Rulings: (1) builds now on claude/s0-zero (open gap [migration slot, first live slot) closed by FILL-2's fill at P3, resume only on a complete fill, credits charged to the budget ledger; worker/facts review; ETA about 2.5–3.5 h + review). (2)+(3) carded as RESTART-KEEP to the PERSIST builder; design approved 12:52 AM: hybrid A + B-for-downtime (new state.json field `candidates`: mint, pool, migratedAtMs, migration slot, create signature when seen, tries, lastEvalMs; supervisor-approved, public data + own state; capped 10-page create-signature walk; ETA about 15:00 Mon ±4 h). **PERSIST builder found FILL-2's fill is not wired into the worker at all** (sources.ts passes no WatchOptions.fill), so no first-subscribe, reconnect or restart gap on pool trades is ever filled; S0-ZERO (1) owns that wiring (first-subscribe + reconnect/restart), RESTART-KEEP builds on it. Owner, 12:44 AM: "can't tap anything": Decision journal empty (no candidate reached its 60–240 min moment since the 12:24 AM restart), no trades, Home rows have no actions until #165; explained, no code fault found. **Deploy batching until RESTART-KEEP lands:** each restart costs up to 4 h of candidates, so Deploys are batched; the next one carries #151, #155, #162, #41, #163, #165 and S0-ZERO (1), about 4–5 AM.
- **Owner, 12:09 AM Mon 5 Oct: app flips from Online to "Server error" after a few seconds; the Worker card says "Data failed checks".** Cause (verified in code): the owner's APK predates API-1 (it was Online at 10:43 PM on 421eba2). Since the 11:02 PM Deploy (bfb2384) the worker's status always carries haltReasons, exitCapable, alerts and regime, and the old app's strict schema refuses unknown fields (schema.ts obj: "unknown field"), so the status poll reports bad. The server itself is fine (Telegram /status 12:09 AM: heartbeat 6 s, no alerts). Fix: Deploy f3fca3d (no ops-touching commit since bfb2384, so the OPS-GATE stands on bfb2384's green e2e), then the owner installs the preview APK, which carries API-1 and APP-HOME. Not before the Deploy: the new app polls /discovered, which bfb2384 answers 404, and a 404 also counts as bad. Gap carded for API work: the app should not turn the whole connection red when a newer worker adds a field.
- **WORKER-HARDEN interim (about 12:30 AM Mon 5 Oct), measured:** G4a (AsOfStore retention; raw creates keep their newest entry because #deployerOf reads them for the deployer-sell exit) cuts heap growth from +201 MB/day to about +87 MB/day (in-RAM OOM point from about 3–5 days to about 7); it does not bound it. G4b at full size (1M creates + 1M-mint index) boots at 1,629 MB on #159 alone, 1,085 MB with G4b's first change, 365 MB at 200k (about 3 days); the old whole-file deployers.jsonl read would exceed V8's max string length at that size (#159 removes it). Bounding needs G4b part 2: a compact per-mint create record in core shared by the deployer index, #deployerOf and the gates' create alias (worker/facts review plus parity). Timeline (±50%): G4a PR about 1 AM Mon; G4b part 1 about midday Mon; part 2 Mon night or Tue morning; G4c about 4 h after. **Stopgap ruling stands:** restart the worker at least every 3 days until G4b part 2 is deployed (the f3fca3d Deploy restarts it about 12:30 AM Mon; next by Thu 8 Oct about 12:30 AM).
- **#41 BT-2 worker/facts PASS** at 0b134bb (staged.ts and packages/worker; live decisions byte-identical, ablate unreachable live, one staged function for live and backtest) and the same scope at ecb6e3f. BT PASS at ecb6e3f (12:32 AM: D1 closed per ruling (b), holderGrowth counts distinct wallet owners; mutants killed; 4881/4881). Worker/facts PASS on core asof/engine retention and graduatesFact at ecb6e3f (12:42 AM; live byte-identical, retention unreachable live, 5,000-case differential test); scope unchanged at 2b13665. Retention clash with G4a ruled: #41 merges first, G4a unifies into one mechanism (its prune/RetentionRule, #41's study rule expressed in it, study outputs identical, one rule object for live, parity and live-parity backtest) and takes the producer notes (pin the kept write-back; reassign instead of splice-spread). Left on #41: CI on 2b13665 and a BT delta check of the survival-fixture fill-ins. Earlier open items: a base merge (done at 2b13665) and a worker/facts review of #41's core asof.ts/engine.ts optional `retention` and producer.ts `graduatesFact` refactor (assigned 12:20 AM). G4a also adds AsOfStore retention: WORKER-HARDEN told to build on #41's option (one mechanism).
- **Memory growth risk (GROWTH-SWEEP, about 11:16 PM):** DeployerStore.load at every worker boot read deployers.jsonl whole (about 64k creates a day, about 560 B a line, trimmed only at a start to look-back + 1 day). Measured: 300k lines (168 MB, about 4.7 days) peaked at 1,036 MB RSS, over MemoryMax=800M, so a restart after about 4–5 days of shakedown would be OOM-killed at boot and crash-loop. The streaming fix (claude/growth-sweep) brings that to 432 MB, but the parsed seed still reaches 800 MB at about 8–9 days. Card 4 WORKER-GROW (bound the seed, rotate the journal) must be merged and deployed before Thu 8 Oct. Also fixed in the sweep: booked.ts chunk-boundary UTF-8, and the runner's whole-journal reads at finish and in drills. **Also, measured at about 11:28 PM:** the live worker's RAM grows about 140 MB a day with no restart, because core/src/engine/asof.ts AsOfStore appends every released event and never prunes. MemoryMax=800M is reached after about 3–5 days (about 7–9 Oct). Plan: G4a (AsOfStore.prune driven by the engine clock, horizon from the policy's longest look-back; BT reviewer), G4b (deployer seed and index bounds; worker/facts), G4c (journal rotation; worker/facts). **Stopgap ruling:** until G4a is deployed, the worker restarts at least every 3 days (code Deploys restart it; #159 keeps the boot safe up to about 8 days of deployers.jsonl). The next restart is due by Wed 7 Oct morning at the latest. The daily summary gains rss_bytes min, max and last per day to show the slope.
- **Sessions archived at about 9:35 PM** (owner, standing habit: archive a session when its task is done or ended, park it otherwise): the six read-audits A1–A6 (findings all carded) and ops builder 1 (session_015LRm59hPdRdz8jbGtxs6pV, broken container; ops builder 2 has its cards, including #135 PNPM-CLAIMS). Every other session has an open PR or follow-up and is parked or working.
- **Owner, about 9:00 PM: Helius purchase deferred.** The owner was told the difference: Developer US$49 a month reads the new days (the D−3 volume the regime gate needs from about 5 Oct, and the holdout days 2–19 Oct); about US$94 is the same plan plus extra credits for the one-off 19 Jul – 3 Oct pull. Both in one month come to about US$120–145. The owner's answer: "ill buy once i see the product". Exact purchase steps are sent once practice trades run and the early look is out. Verified for the steps: upgrade from dashboard.helius.dev/billing (immediate, prorated); extra credits need Autoscaling turned on (Usage page → Autoscaling → Manage; set in credits, off by default, cap 50M). Whether the API key stays the same is not documented.
- **Storage gap found (about 9:00 PM).** Under DATA-PUB a helius day lives only in the Actions cache (10 GB per repository, LRU, 7-day idle eviction), and a day's units are about 6.4–8.5 GB. So the cache holds about one day, and a paid pull would evict itself. DATA-STORE (session_018c27uWDzKUKjHMpzYJzjzk) delivered #150, docs only, head 7f7ab26; data review queued. It recommends releases in a private GitHub repo: free, no eviction, and no total size or bandwidth limit (GitHub "About releases", verified by the supervisor). About 510–680 GB for 80 days (estimate). This needs three owner steps when the purchase happens: create the private repo, create a fine-grained token for it (Contents read/write), and add the secret DATA_STORE_TOKEN plus the variable DATA_REPO. **Helius terms (28 Sep 2026, verified by the supervisor):** §3.2(xi) bars use "in any personal, household, or familial capacity, or for any purpose other than a lawful business purpose". This affects the free plan in use now as well as a purchase. The owner's question to Helius is drafted in #150 and goes to the owner with the purchase steps. DATA-KEEP (data builder) keeps the 09-21 entry alive until it is used.
- **PRACTICE-ON #145** (claude/practice-on, d31fa81; draft): an S0 shakedown block in `ops/host-config.json` with five names only (S0, S0_DIAGNOSTIC=on, PAPER_EDGE_PPM=178092, a stand-in, a keyless wallet PDA); `ZEROED_S0_DIAGNOSTIC` added to ENV_NAMES; parity rebuilds the diagnostic set; worker-smoke refuses the block in a qualifying release. Its PR e2e is green; the builder is merging the base. Reviews are split with no overlap: ops reviewer (ops/**, e2e), worker/facts reviewer (packages/worker, runner contract), risk reviewer (the edge value only). Rulings: (1) the edge is sized to SOL's one-year high, which is accepted, because it is paper-only, the release is non-qualifying, the size stays $2 and no limit or stop changes; (2) the commit that adds qualifying-run.json must remove the shakedown block (worker-smoke refusing the release is the fail-safe). After merge: a green push `Ops end-to-end`, then a code-only Deploy. Practice trades are expected between about 11 PM and 1:30 AM, or Monday morning if a review finds a real problem.
  - **MERGED at about 9:49 PM** (421eba2; check and e2e green on f9acac5, change identical to the triple-PASS bdf01dc). Next: the push CI on 421eba2 (check, e2e) green, then a code-only Deploy (log must show "No DEPLOY_CODE secret: code update only, no keys sent."), then the owner's app check for practice trades.
  - **Deployed at about 10:03 PM**: Deploy run 37197392841 tagged `deploy` → 421eba2; its log shows "No DEPLOY_CODE secret: code update only, no keys sent." Push CI on 421eba2 was all green (check, e2e, build, release). The server's update timer runs every 5 min, so it switches by about 10:10 PM. Owner asked to open the app after 10:15 PM and report Online and whether trades show.
  - **Second Deploy at about 10:58 PM** (run 37200511167): tag `deploy` → bfb2384 (API-1 #118 on top of PRACTICE-ON); push CI on bfb2384 all green (check, e2e); log shows "No DEPLOY_CODE secret: code update only, no keys sent."

## 0. Account transition (read this first)

**What happened.** At about 7:15 PM on 4 Oct the owner ordered a full handover. The project continues from a new Claude account. Every builder and reviewer session of the first account was told to:
- push all code, including unfinished work, to its own branch, with unfinished commits marked "WIP: …, not reviewed";
- write its notes to `docs/handover/sessions/<session id>.md`;
- stop.
The supervisor wrote this file, `PROJECT_STATE.md`, `docs/DECISIONS.md` and `docs/handover/supervisor/`, then paused too. Nothing is lost: every finding, ruling, review verdict and piece of work in progress is in the repo or on a PR branch.

**What the new account cannot do.** It can't message the first account's sessions; their ids in §5 are history. Start fresh builder and reviewer sessions from the notes. A new session continues a card by reading:
1. its card row in §4;
2. its predecessor's notes file;
3. the PR's branch.

**Handover completeness (checked at about 7:50 PM):**
- **Session notes:** 22 of 23 first-account sessions wrote `docs/handover/sessions/<id>.md`. The missing one is the EXIT reviewer (session_01UXzG7h8LWHGLxtJzf7C95N). The owner had paused it in its own chat, and it stayed paused, so it didn't act on the handover order. Its finished verdicts are in `docs/handover/supervisor/supervisor-log.md`: POS-1 #88, EXIT-1c #93, EXIT-1d #100, EXIT-1e #102, WORKER-1b #82, and EXIT-1f #107 PASS at ce7c78b. Its #128 review was unfinished, with no verdict.
- **Sandbox data:** 21 folders in `docs/handover/sandbox/` (20 sessions plus the supervisor's), each with a MANIFEST.md of every file, committed or excluded with the reason. Three are missing:
  - the risk reviewer (017PBU): its copy command was refused by the environment's permission check, and its findings are in its notes;
  - WATCH/G3 builder (01WGpx): the supervisor's request was refused by the same check, and its code and WIP branches are pushed;
  - the EXIT reviewer (01UXzG): paused by the owner.
  None of these was worked around. The owner can allow it, or resume those sessions, if the raw scratch files are wanted.
- **Kept out of the public repo on purpose** (each listed in the manifests with a source or regenerate command): secrets, third-party pages, papers and clones, raw provider data (Helius terms), raw GeckoTerminal OHLCV, node_modules and worktrees.

**What keeps running with nobody watching:**
- **Server** (Vultr `zeroed`, Frankfurt): the code-only Deploy at about 7:28 PM tagged 7d5e203, which runs the release's own worker in paper mode (SWITCH-1; `ops/host-config.json` has `"worker": "release"`). Whether the switch succeeded is confirmed only by the owner's Online check. See "First steps" below.
- **GitHub Actions:**
  - The free-day Helius pull for 2026-09-21 is running: `data-scan.yml` run 37185822426, dispatched 07:27 UTC, about 14 h, chained runs. It books credits per run and caps at 270,000.
  - ARCHIVE-CHECK runs every 3 h on a cron and makes one ≤64-byte request with our real User-Agent. It no-ops while a data-scan runs.
  - Nothing else is scheduled.
- **Cloudflare watchdog** (workers.dev, free) and the Telegram bot: unchanged.
- **Session reminders:** the first account's self-reminder triggers were disabled at the handover, so no paused session wakes on its own. They are trig_01QiK9Jk2vujMAgopD8jNHFn (read the 09-21 end), trig_01W4gKmNHMbURTkaqVKs5r8Y (archive check) and trig_01NTfGmeQYMhRAiRtQ3qvSMR (#110 check-in).
- **Keys:** GitHub repository secrets only (see §9). The new account needs nothing new to read the repo. Workflows run with the repo's own secrets.

**First steps for the new supervisor, in order:**
1. Read `AGENTS.md`, `CLAUDE.md`, this file, then every `docs/handover/sessions/*.md` (one per first-account session) and `docs/handover/supervisor/supervisor-log.md` (the full decision log).
2. Re-list open PRs and check each head against the table in §4. Notes written after this file may name newer heads; the PR head on GitHub wins.
3. **Online (critical path):** done by the first supervisor at the very end.
   1. #126 merged (7d5e203), and its push run of `Ops end-to-end` is green, as are check, build and release.
   2. Deploy run 37189025276 (08:28 UTC, about 7:28 PM) logged "No DEPLOY_CODE secret: code update only, no keys sent." and moved the `deploy` tag to 7d5e203. That commit has SWITCH-1, WORKER-1e and the e2e fix.
   3. The server switches within about 5 min when no intent is open.
   4. **First thing to confirm:** ask the owner to open the app (the Paper tab shows Online) or send /status to the Telegram bot. If it isn't Online, read the server's alert in Telegram. zeroed-update keeps the old release on any failed check, and its post-switch hold rolls back a worker that doesn't stay healthy.
   5. Future Deploys: never while the e2e on the newest ops-touching commit is red. Until OPS-GATE (#134) merges, `tag.sh` would accept a later commit that ran no e2e.
4. **Practice trades** come with the merged WORKER-1e (#117, in base). They start once the real worker runs. Practice P&L stays inexact until PAPER-1 merges (failed-entry fees, two currencies, rent). Tell the owner to treat the numbers as rough until then.
5. Work the queue in §4 in order: critical path first, then the audit fixes.
6. When the 09-21 pull finishes:
   1. Merge DATA-4 #127 (after review).
   2. Init the credit ledger with `used` = the higher of the owner's Helius dashboard figure and the builder's conservative sum.
   3. Run BT-2e's early look only after BT-2's audit fixes (B1–B5, S2) and the frozen SE floor and pick rule are merged.

## 1. Read first, in this order

1. `AGENTS.md` and `CLAUDE.md`: the owner's rules. They override everything here.
2. This file, then `docs/handover/sessions/*.md` (each first-account session's own notes) and `docs/handover/supervisor/` (the supervisor's log, queue tools and the map poster).
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
  - The real worker needs `ops/host-config.json` `"worker": "release"`; SWITCH-1 #110 set it (merged 669de71).
- **After merging anything under `ops/**`:** the push run of `Ops end-to-end` on the merge commit must be green before Deploy. The PR run tests a different path from the push run (on push, the update step already deploys the signed merge). On 4 Oct, 669de71 passed on its PR and failed twice on push; #126 fixed the test's wait. Until OPS-GATE merges, the deploy gate would accept a later commit that ran no e2e at all, so check it by hand.
- **Data downloads** run on GitHub Actions (`data-scan.yml`), not in a session:
  - Dispatch inputs: `mode=scan`, `days=<UTC days, newest first, comma-separated>`, `max_mbps=80`. `assemble` builds a dataset window.
  - One concurrency group; it stops on HTTP 429 and resumes with back-off.
  - Each finished UTC day is published as a release tagged `data-day-YYYY-MM-DD`.

## 4. Current state (4 Oct, about 7:45 PM)

### New-account queue (live; updated about 11:57 PM)

**Merge order** (serial; each merge needs ready → update branch → green `check` (and `Ops end-to-end` for ops) → contains base → change identical to the reviewed SHA). For a stacked or re-based PR whose diff comparison is noisy, the identity check is `git merge-tree --write-tree <base> <reviewed SHA>` giving the same tree as the CI-tested head:

| # | Card | Reviewed SHA | Verdict (new account unless noted) | Note |
|---|---|---|---|---|
| 116 | CI-1b | c5aaf88 | PASS (first account) | MERGED bf62839 (~8:15 PM) |
| 114 | RENT-1 | 10ec76a (02d5f1d) | PASS (first account) | MERGED e5e1e78 (~8:28 PM) |
| 121 | WATCH-1c | 26d992a | PASS (risk reviewer, 4525/4525) | the base merge into claude/watch-1c was denied by the classifier ("Modify Shared Resources"; not worked around). #121's commits reach the base through #141, which already carries them with the same import-union resolution; #121 is closed as merged via #141 |
| 134 | OPS-GATE (O2) | 8c3aef3 | PASS (ops reviewer) | MERGED 47b6009 (~8:42 PM); its push `Ops end-to-end` must be green before any Deploy; #137 re-pins after it |
| 144 | DATA-PUB | 4b57346 | PASS (data reviewer, 13/13 mutants) | MERGED c83b92d (~8:56 PM), ahead of the queue (needed before chain run 2) |
| 106 | FACTS-1f | d06ebdb | PASS (first account) | MERGED 7ce113d (~9:08 PM; check green on bef5ff2, change identical to d06ebdb) |
| 107 | EXIT-1f | ce7c78b | PASS (first account) | MERGED e452e02 (~9:22 PM; check green on af69ce4, change identical to ce7c78b); the EXIT builder retargets #128 |
| 128 | EXIT-1g | fa52906 | PASS (EXIT reviewer, 6/6 mutants) | stacked on #107: retarget to the integration branch and merge the base after #107 |
| 140 | SAMPLE-QR | e62993c | PASS (run/CI reviewer) | MERGED cae4ac4 (~9:38 PM; check green on 562387c, change identical) |
| 153 | CI-FLAKE | 7434d0e | PASS (run/CI reviewer; 0/15 failures on head vs 1/15 on base) | MERGED 433afd7 (~10:04 PM): the OPS-GATE test's multi-poll success run waits up to 60 s (bash SECONDS whole-second deadline flaked PR CI about 1 run in 3); the injected-clock fix and a spawnSync timeout ride #149 |
| 136 | SEC-1 (audit O1) | e44829c | PASS (ops reviewer, 12/13 mutants, 1 equivalent) | after #153 and #145; conflicts with #149 (require-check WAIT_S, android test). Before the owner's keystore steps, previews keep signing with the cached key and a warning. Follow-ups after the owner's steps: an unset pin becomes an error in both scripts; gate the two secrets in YAML (hygiene) |
| 128 | EXIT-1g | fa52906 | PASS (EXIT reviewer) | MERGED f8465f9 (~10:16 PM; check green on c3025e8, whose tree equals `git merge-tree` of the reviewed fa52906 with the base) |
| 56 | RES-3b | b8f8968 | PASS (stats reviewer) | MERGED bde154c (~11:31 PM; tree identical to merge-tree of b8f8968 with the base) |
| 150 | DATA-STORE (docs) | 26099c7 | PASS (data reviewer) | needs base merge |
| 151 | APP-WORDS part 1 | 923aac3 | MERGED about 12:54 AM Mon 5 Oct (483df20; check green on e4f70b6, merge-tree identical to 923aac3). PASS (run/CI reviewer) | after #153 (its f4e73b8 is #153's change); next part carries N1 (drop the 24 h notice's second sentence) and N2 (DepositPanel explaining lines) |
| 129 | STATS-1g | d89df54 | PASS (stats reviewer, 9/9 mutants; CR2/BM coverage within MC error at α/4 and α/8) | MERGED 6fcc3d4 (~11:18 PM; tree identical to merge-tree of d89df54 with the base); follow-up STATS-1h refuses alpha > 0.0125 in clusterWelchBounds |
| 148 | WORKER-CRASH | e69bf8c | PASS (data reviewer, 7/7 mutants) | needs base merge |
| 123 | WORKER-ORDER | a8e4e0b → a7ac102 (readFileSync import restored after the #118/#128/#142 merge) | PASS (worker/facts reviewer, ruling (a): entries line-first; 13 mutants over two rounds) | MERGED 16555b5 (~11:05 PM; check green on a7ac102; worker/facts PASS at e03a45a plus the one-line import fix) |
| 152 | DATA-KEEP | 48b0e29 | PASS (data reviewer; supervisor checked the workflow) | needs base merge; after merge, dispatch once and record whether a restore moves last_accessed_at |
| 137 | OPS-1i | b39b3b0 | PASS (ops reviewer; re-pinned after #145 at a8eb6b9) | after the PRACTICE-ON Deploy; #149 re-pins after it |
| 120 | RES-5 | d7a0c90 | PASS (stats reviewer: day-confounded null calibration, frozen-rule CLI, wall.ts) | MERGED 581fd2a (~11:41 PM; tree identical to merge-tree of d7a0c90 with the base) |
| 139 | WORKER-1d | c940763 | PASS (worker/facts reviewer, clean full check 4585/4585) | needs base merge |
| 142 | EXIT-1h | 448a03e | PASS (EXIT reviewer, 5/5 mutants) | MERGED 7e9270c (~10:31 PM; tree identical to merge-tree of 448a03e with the base) |
| 146 | CORE-TIDY | 7172643 | PASS (run/CI reviewer) | needs base merge; follow-up pins the read count against a copying parse (mutant F4) |
| 141 | WATCH-1d (+ #121 WATCH-1c) | 05b0d85 | PASS (risk reviewer, 11/11 mutants; #121's import union and carry mutants re-checked) | needs base merge (a risk delta check only if the merge touches watch.ts, strategy.ts or the carry/snapshot code); then close #121 as merged via #141 |
| 133 | PAPER-1 | 2c4abb2 | FAIL (risk, golden rule, 1:05 AM: stray fee lost on fold with no SOL price; rounding unpinned; orphan_fill-after-close test) — earlier PASS (worker/facts: restart settle and the rest; run/CI: desk orphan_fill, late-buy guard, late-sell close; merge delta with #123 PASS at 2c4abb2: behind() skips .o<n> late buys, rent kept per PAPER-1; 40 tests' mutants killed; 4753/4753) | after #123: the builder merges the base and carries #123's solUsd with its own legs; does not wait for #132 |
| 154 | BT-WALL (+ BT-3 labelling) | 6d82734 → cc3b188 | PASS (BT, 12:49 AM: W1b closed, 3/3 mutants; 4810/4810 on cc3b188+d3cfc14); needs a base update before merge. Was FAIL (BT reviewer, W1b: the --release SHA256SUMS byte comparison has no test; `if (false)` mutant survives 15/15; W1 writer flag, RELEASE_TAG gate and holdout guard all fine) | fixing: one evidence-script test (differing and missing SHA256SUMS via the fake gh), then the BT re-check and full check |
| 155 | OPS-SUMMARY | 07112fd → 17e4e50 → 323d5c0 (base merge; differs from merge-tree(d3cfc14, 17e4e50) only in DECISIONS.md, no markers) → 6fc0b10 (GitHub base update after #151; merge-tree identical; CI running) | ops PASS at 17e4e50 (deploys the watchdog from refs/tags/deploy, only after the tag and tooling steps succeed); worker/facts PASS at 17e4e50 (chunked fold with ts skip, worker guard and tick catch-all pinned; mutants killed; 4763/4763); the supervisor checked the deploy.yml step (runs reports.sh only when CLOUDFLARE_API_TOKEN and DATA_STORE_TOKEN exist; one secret via stdin; DATA_REPO as a var, re-added after any handoff deploy) | owner steps (private repo zeroed-data, fine-grained token, secret DATA_STORE_TOKEN, var DATA_REPO, Claude app access, run Deploy) go to the owner after merge |
| 163 | APP-WIRE | 9ff0822 | PASS (run/CI, 12:53 AM: app httpApi against the real worker route, every paper endpoint ready, live/backtest not-running, no 404; P1–P5 killed; 4787 tests; N: one test matches App.tsx source text, render-based would be sturdier); needs a base merge | follow-up of #157; full check 4787/4787 at 1b9ed9a, 9ff0822 adds only a base merge |
| 166 | S0-ZERO (1) | ba947ac (code 6aa6ac4) | worker/facts review (assigned 1:10 AM, top priority) | FILL-2 wired via tradesFill (first subscribe from the migration slot + reconnect gaps; 500 credits/fill, 20k/day fill budget; trades_fill journal line); feed ordering fix (IngestOptions.after); history-end complete only at the pool's CreatePoolEvent; 19 tests, 16 mutants. Per-fill cap to be ruled from the first hour of trades_fill data. claude/backtest-2f (stale, = #41's head) could not be deleted by its builder; left in place |
| 165 | APP-TRADE | 7276569 → 1f441d2 (item 6) → 5db4478 (N1 pin, N2 one rounding) → f6b6a18 (exit fee in openPnl; EXIT delta check). App part PASS (run/CI, 1:09 AM, holds at f6b6a18: exact Return, server clock, MINT_RE-gated Pump.fun URL via Capacitor ACTION_VIEW, honest copy, no row clicks; 4818 tests) | worker PASS (EXIT, 12:54 AM, at 7276569: one exact openPnl equal to account.ts net at close; mark = our-size quote; unrealizedUsd read only by the app; 7/8 mutants; 4814 tests); N1 pin + N2 same rounding asked (12:58 AM); run/CI app part running | owner ask 12:30 AM; Running, Price now, P&L, Return; Return on trades; Home Volume 24h/Holders removed; Liquidity "—" likely poolOf needing fee terms (reservesOf fix); no margin (spot) |
| 164 | G4a WORKER-GROW (AsOfStore retention) | f7e10d4 → 63796f7 → #41 merged in, unified on #41's Retention + { horizonMs, dropStale } + hourly prune on the event clock (accepted; proof owed: study outputs identical, one rule object test, producer notes) | worker/facts review (after their #41 core-engine pass) | growth +201 → +87 MB/day; one-shot keys (worker:seed dropped after an hour); must share #41's retention option |
| (next) | OPS-SUMMARY-PNL (summary v2) | branch claude/ops-summary-pnl 145f6ef (on #155's cb1b6d8) | PR after #155 merges | open positions with liquidation value or null, marked net total over quotable only, unquotable/unlisted counts, daily rss min/max/last; watchdog accepts v1 or v2, never a mix; 12 mutants |
| 162 | APP-COMPAT | 9b46b9f (head a21184b = clean base merge on d3cfc14; full check 4806 green; marked ready 12:52 AM) | PASS (run/CI, 12:35 AM: checks stay strict, only a pure unknown-field refusal gives "App update needed", mixed stays "Server error", error outranks update, TTL unchanged; C1–C9 mutants killed bar one equivalent; 4791 tests; N: comment that the module-level flag relies on synchronous checks) | an "unknown field"-only refusal (worker newer than the app) shows "App update needed" instead of "Server error"; checks stay strict; from the owner's 12:09 AM field report |
| 159 | GROWTH-SWEEP | 9ce5398 | MERGED about 12:37 AM Mon 5 Oct (8a80a0b; check green on 9179b41, merge-tree identical to 9ce5398). Next: push CI on 8a80a0b, then #155, then a code-only Deploy carrying #158, #159 and #155. PASS (data reviewer, 12:14 AM: streamed load identical to the old on 9 inputs, crash-safe tmp+fsync+rename, UTF-8 test fails on base, runner verdicts unchanged; 12/12 mutants killed; 4,739/4,739; N1 problem order above 50 may differ; N2 pre-existing writeSync count unchecked, carded to WORKER-HARDEN) | streams deployers.jsonl at boot (1,036 → 432 MB peak on 4.7 days), booked.ts UTF-8 chunk boundary, runner whole-journal reads; front of the queue |
| 160 | STATS-1h | a2df10b | PASS (stats reviewer) | needs base merge; DECISIONS' STATS-1g S4 numbers to be marked historical in a later docs touch |
| 161 | KEY-ROTATE-SAFE (B2) | 5a8a314 → 5cf8dbe → 27dc241 → 6d0f672 (warning text + DECISIONS only; ops delta PASS) | ops PASS at 5cf8dbe, carried to 27dc241 (test-only: stand-in age in the check job; 116/116; 6 of 7 mutants killed, the survivor near-equivalent). Order ruling: #155 merges first; #161 then carries the /summary candidates() follow-up with a test, the FORCE_KEY_ROTATE leftover warning wording, and a DECISIONS line keeping the few-second webhook 401 window at the co-switch (Telegram retries; webhook-failed alerts). Earlier: ops re-review (5cf8dbe: /slot reports pending; publish.sh refuses over a pending offer with a loud warning, API keys still handed over; FORCE_KEY_ROTATE=yes override; webhook offer switches with the heartbeat key). Was FAIL (ops: a second run can overwrite a pending offer before the server's first beat); fixed with ruling (a): refuse to rotate while an offer is pending, owner override via repository variable FORCE_KEY_ROTATE=yes | two-slot watchdog key rotation plus the 24 h "Key offer pending" alert; overlaps #155 in watchdog/worker.ts, and the builder resolves whichever merges second |
| 156 | WORKER-ORDER-FIX | aba701b | PASS (worker/facts, 2/3 mutants; chunk boundaries proven in journalLines itself) | MERGED a116cc1 (~11:56 PM; tree identical); the #123 part of the Deploy hold is lifted | the #123 fix-forward (readJournalFills streams via journalLines); lifts the Deploy hold when merged |
| 158 | APP-WORDS part 2 | da4ad48 | MERGED about 12:24 AM Mon 5 Oct (2af7984; check green on f227af2, merge-tree identical to da4ad48) | after #157; follow-up: one route() assertion that the decisions view uses servedReason |
| 157 | APP-HOME | 94a940e | MERGED about 12:08 AM Mon 5 Oct (f3fca3d; check green on 21eb13e, merge-tree identical to 94a940e) | after #156; then a new APK for the owner (Home and Session show real data) | wires Home Discovered (/discovered), the shell state and the Snipe Session card to the worker; then a new APK for the owner |
| 118 | API-1 | cd9d60f → ded20fb | PASS (run/CI reviewer; hand merge of one strategy.ts block checked, 3/3 mutants, 4678 tests) | MERGED bfb2384 (~10:44 PM; check and e2e green on 88ee313, tree identical to merge-tree of ded20fb with the base); a code-only Deploy follows once its push CI is green |
| 124 | RISK-LATCH | 5594923 | PASS (risk reviewer, 5/7 mutants, 2 equivalent or optional) | needs base merge; #147 then needs the risk reviewer's strategy.ts delta check; #132 keeps both DECISIONS sections |
| 147 | RISK-FAULT | 911eac6 | PASS (risk reviewer, 4/4 mutants) | after #124: base merge, keep the latchable gate plus the fault line, log a valuation fault once per episode, then a risk delta check |
| 125 | PERSIST-2 | 8f82e5d | PASS (PERSIST reviewer, 13/13 mutants) | base merged by hand at d8db7f1: PERSIST merge check PASS (change identical apart from the import union; seed still lands before the first read; 8/8 mutants) |
| 130 | EXIT-ROUTE (M6) | 8a6a71e | PASS (worker/facts reviewer) | needs base merge |
| 98 | TEST-3 G3 report | c1f3f45 | PASS (first account) | then the WATCH builder's G3 fold |
| 122 | BT-TAIL | b6200d1 | PASS (BT reviewer, 4518/4518 on a local merge) | needs base merge; before #120 |
| 131 | PERSIST-3 | 8fb5c23 | PASS (PERSIST reviewer, 12/13 mutants) | needs base merge after #125 |
| 115 | RES-4 | debd4f7 | PASS (BT reviewer: C1c and C1d closed; stats reviewer: §4 line, preregistration sha, holderGrowth) | needs base merge |

**In review or fixing:** #121 WATCH-1c (risk delta); #127 DATA-4 (PASS at 6854871; the gate-test exemption at 18094b4 is in a short data re-check; merges only after the chain ends, then ledger init with 700000);   #132 RISK-PARTIAL (risk review);    #41 BT-2 (0b134bb: stats PASS; BT FAIL D1, because H3 lifted the delegate-only partial flag while also grouping owners by delegate. Ruling (b): H3 follows #115's pre-registered holderGrowth (distinct owners, no delegate grouping); M1/M2 after #129 merges); PAPER-2 after #133 (an emptied position's owning exit can oversell in paper, giving phantom proceeds; #why must stay bounded);  #149 OPS-1j (ops review after #145 and #137); #135 PNPM-CLAIMS (ops review);   #140 SAMPLE-QR (run/CI review); #141 WATCH-1d (fix at 4418faa, base re-merge pending; full risk review after #147); #41 BT-2 (audit fixes building; S2 estimand passed with conditions C1–C6).

**New cards from the six read-audits (all assigned, §5):**
- DATA-PUB (urgent): data-scan.yml would publish a Helius-source day (raw getBlock responses in raw.jsonl.zst) to a public release and a 14-day artifact; chained runs use the workflow on the branch, so the gate must merge before the 09-21 chain's last run (about 11:30 PM–1 AM).
- PRACTICE-ON (top priority): as deployed, the paper worker makes no practice trades (ZEROED_STRATEGY defaults to none, ZEROED_STANDINS and ZEROED_WALLET unset, ZEROED_S0_DIAGNOSTIC dropped by ENV_NAMES); the earlier "practice trades start once the real worker runs" was wrong and the owner was told.
- WORKER-HARDEN: crash paths (canonical.ts 'tx' decode, ENOSPC loop, DelayProbe), stuck exits invisible to the watchdog, holder-scan cap lost on restart, credit-halt vs ledger, unbounded growth (recorder, journal, deployers.jsonl, AsOfStore, FactProducer maps, DeployerIndex).
- OPS-1j: backups miss the worker's JSON state (control.json pause and latches, credits, exits, account); update gate skips the open-intents check when the worker isn't active; deploy.yml key handoff on `!cancelled()`.
- SAMPLE-QR, APP-WIRE (app screens never wired to the worker), APP-WORDS (raw reason codes on screen; copy guard gaps; tests that cannot fail), screenshots.
- BT-WALL: evidence path has no holdout wall; the leak test's labels check can never fire; publish-report delete-then-upload; synthetic BT-3 evidence labelled gate.
- DATA-5 now also covers holdout day files 10-02..10-19 (nothing can fetch them today).
- SANDBOX-TIDY: blocked by the environment's safety check ("Modify Shared Resources") on `git rm`; not worked around; waits on the owner. DOCS-ALIGN and CORE-TIDY are being built.


**Base:** `ccr-14987baf-i6lrsl` at 7d5e203 (#126, deployed to the server), plus the handover docs commits. 76 PRs merged since midnight on 4 Oct. This evening: DATA-2 #111, MEM-1 #112, STATS-1f #109, WORKER-1c #99 (5:51 PM), WATCH-1b #113 (6:02 PM), SWITCH-1 #110 (6:15 PM), BT-2e data path #119 (6:27 PM), WORKER-1e #117 (6:42 PM), E2E-DRILL #126 (about 7:30 PM).

**GitHub:** the owner is on GitHub Pro. Declined payments locked Actions twice on 4 Oct (3:15–3:23 and 3:37–3:42 PM). If "account is locked due to a billing issue" returns, nothing merges or deploys: send the owner to github.com/settings/billing.

**External audit (owner-relayed, "Report 1", base d92b73e).** It found real defects. Each is mapped to a card below. The full text and the supervisor triage are in DECISIONS, "External audit 1". Its verdict stands: continue paper and research mode.

**Open PRs, in merge order.** Review means a fresh reviewer session's verdict at the SHA given. Each merge needs ready → update branch → green CI → contains base → change identical to the reviewed SHA (§3).

| # | Card | Head | Review | Next |
|---|---|---|---|---|
| 114 | RENT-1: one rent model in proof scoring | 10ec76a | PASS (012efQ at 484d50a; supervisor checked 02d5f1d; identical) | update branch, merge; unblocks #115 |
| 116 | CI-1b: memory-bound guard, keep counts once, tabletop write order | c5aaf88 | PASS (01DdN4 at 82c49a1 and c5aaf88) | update branch, merge |
| 118 | API-1: status shows why entries are off; risk stops as halt codes; regime current; waived regime parts shown | 62242b3 | PASS at 32c14d9 (01DdN4). Since then: a base merge, #126 merged in, the waived-regime field. PR CI is green at 62242b3, ops e2e included | delta review of 32c14d9..62242b3, then merge |
| 106 | FACTS-1f: live staged hard rejects | d06ebdb | merge-check PASS at d06ebdb (012QdD: 4530/4530; conflicts right; mutants killed; every decision re-runs all stages at one `ctx.now`). Non-blocking: reject lines count `h14-creates-coverage` more often than under #117 | update branch, CI, merge; BT-2 mirrors its staged path (B2) |
| 107 | EXIT-1f: restored exit state per field | ce7c78b | PASS (01UXzG) | update branch, merge; #128 is stacked on it |
| 98 | TEST-3 G3 report | c1f3f45 | PASS (01FHfb) | update branch, merge; then the G3 fold card |
| 123 | WORKER-ORDER: journal the exit before the ledger closes it | b849d9f | draft FAIL, small (012QdD; not yet sent as a verdict; check unfinished): (1) the catch-up values a missed fill at the SOL price after restart, not at the fill's own rate, so put `sol_usd` on entry and exit lines and use it; (2) the missed-entry catch-up branch of `behind()` has no test. The dedupe key is fine; a clean run changes no risk numbers | fix both, then re-review; the §12.4 contract in #116 points to it |
| 124 | RISK-LATCH (audit M1) | 23fc039 | FAIL (017PBU): it latches on unknown marks | latch only when every mark is known and fresh and the SOL price is fresh; same condition on `#exitDecision`'s latch; tests |
| 121 | WATCH-1c: quiet held pools by coverage, verify read | 26d992a | FAIL at 6725a30 (017PBU: no test pinned `#sendEntry` with the carry off). Since then the builder added the send-path test (it fails with the carry at send), corrected DECISIONS and merged base 5087bd4; 4525/4525 at 0715095, and 26d992a only removes a stray node_modules link | 017PBU delta review, then merge |
| 125 | PERSIST-2: graduates series across restarts | 4322300 | interim notes (01NZwy) at af82601; the builder added the splice test and journals, reports in /health and alerts a refused seed. Full suite unfinished | base merge (5087bd4+), full check, final review |
| 128 | EXIT-1g: sell-only recovery (audit M7), N4, N6, N7 | ed0cdc0 | in review (01UXzG) | review; merges after #107 |
| 132 | RISK-PARTIAL (audit M3): partial sales realise proceeds minus their share of the entry basis; core `RealizedPart`; whole-trade stats kept | a244707 | not yet reviewed; 22/22 mutants killed; 4504 tests; the audit example now gives $20.50 equity and no day loss. `account.json` trade records gain partial fields (the bot's own data) | risk review (017PBU); trivial DECISIONS merge with #124 |
| 133 | PAPER-1 (audit M4, M5, M8 rent): one settlement module `core/src/fills/settle.ts` used by backtest and paper; fees per signature; `strayFees`; 'failed_entry'; dollars at each flow's own price; rent per the shared model | 65283f8 | not yet reviewed; 4537 tests; 7 of 10 new tests fail on base; 12/12 mutants. One existing test changed (boundary-marks NAV peak needs a 40% rise because rent now leaves at entry; assertion unchanged); a fill counted before reconcile fixed | risk review of the kind (017PBU) and a worker review |
| 134 | OPS-GATE (audit O2): server and tag.sh share `commit_verdict`/`e2e_commit` (named `check`, no failed or running runs, full listing, e2e on the newest ops-touching commit); preview release waits for `check` | 8c3aef3 | not yet reviewed; 4529 tests. Its own e2e was red at ec0d3e4 (the e2e marked the newest signed merge green too early); e2e green on 8c3aef3 (run 37189806877); `check` is skipped while the PR is a draft | mark ready for full CI, ops review |
| 135 | PNPM-CLAIMS (audit O3): `minimumReleaseAge 10080`, `trustPolicy no-downgrade`, `blockExoticSubdeps true` in pnpm-workspace.yaml (supervisor approved), with an offline test of each (3fc13c3 strips pnpm's npm_config_* from child installs; 4/4 under `pnpm test`; full `pnpm check` passed on 3fc13c3: 154 files, 4520 tests) | 3fc13c3 | not yet reviewed | mark ready for CI, ops review |
| 136 | SEC-1 (audit O1): preview APK signing out of the Actions cache; exposure verified without touching the key (run 37188909095 restored the keystore cache); plan and owner steps in docs/ANDROID_PREVIEW.md on the branch | 6280ae5 (WIP) | not yet reviewed; android-workflow tests pass (9); conflicts with #134 in the release job | finish after #134; owner creates the secret |
| 129 | STATS-1g: audit S1 (α/4 per part, t-bound execution allowance), S3 (exact canonical fingerprint, n_power revalidated on an independent seed, MC SE), S4 (CR1 cluster-robust by creator, 17.5% → 4.45% miss rate) | 89df086 | not yet reviewed; `pnpm check` green locally (4,520) | stats review, then mark ready for CI |
| 130 | EXIT-ROUTE: sell route from the held pool's quote (audit M6) | 8a6a71e | not yet reviewed; full suite green locally (4,522) | worker/facts review |
| 131 | PERSIST-3: deployer, deployerSales and flow saved with the exits file; unrestorable means sell-only | 561ee38 | new draft; its 4 tests pass, full suite not run | full check, review (PERSIST reviewer) |
| 127 | DATA-4: account-wide Helius credit ledger, reserve before spend | e5552a4 | FAIL (01DKMn). B1: `gh release upload --clobber` deletes then uploads, so a failed upload loses the ledger and every open reservation; write `ledger.next.json` first, fall back to it, and have init refuse while either exists. B2: a failed write isn't tested (the `\|\| true` mutant survives). Also document that merging re-reads any unpublished helius day | fix B1, B2 and the doc line; merge only after 09-21 is published; then init (`used` = the higher of the owner's dashboard figure and the conservative sum in 01XHH3k's notes) |
| 41 | BT-2 study + BT-2e early runner | ac003d4 (RES-4 (b)/(c) done: per-hypothesis replays, joint SPA with `s0Of`, pick, trials; a `recordTrials` dedupe bug fixed) | FAIL (012efQ). (1) The live tip is untested: `observedTip: 0n` passes all 737 worker and runner tests, so add a stale-fact test that fails with the tip lowered. (2) U1 holder growth (`walletHolders`, study.ts:750–757) counts token accounts, lockers and program-owned accounts, the pool vault and zero balances, against #115's definition | fix both, plus audit B1–B5 and S2, before any early run; then RES-4 (b)/(c) under 01FHfb's rulings (§8); merge base 669de71+ |
| 115 | RES-4: cost math, six pre-registered hypotheses, definitions | 8dc0f49 | FAIL (012efQ): the C1 drift guard is incomplete. Dropping the failed-close fee or `net.tip` from exitFixed in outcome.ts alone still passes. Make parity exact (zero-variance overrides, exact lamport equality: all land and close, closeSuccess 0, dust 1e6), or share one `scoringTerms`. The definitions text is sound. 01FHfb also has a FAIL at 6915f26 on the §4 line (see its notes) | fix; don't pin the sha until BT-2 follows the holderGrowth definition |
| 122 | BT-TAIL: exit-ladder tail in slots | b6200d1 | no verdict yet (012efQ: the test fails before and passes after; old and new scoring 72/72 identical at 400 ms slots; merges cleanly; full check stopped by the handover, PASS expected if green) | full check, verdict, merge before #120 |
| 120 | RES-5: survivor markers (research only) | cd084b09 | FAIL at 8a7856e (01FHfb: the bootstrap p picked noise 20/20; the one look wasn't enforced). Fixed since: permutation p in day × stratum cells (B = 18,000), MIN_FIND_DAYS 10, a null calibration (40 runs, Clopper–Pearson ≤ α), separate `freeze`/`check` with frozen.json and refusals, N1–N3 | stats re-review |
| 56 | RES-3b | 27a13d2 | draft | after the study inputs; carried in #120 |

**Cards without a PR yet (or WIP on a branch; see the builder's notes):**

| Card | What | Builder (first account) | Reviewer |
|---|---|---|---|
| PAPER-1 (now #133) | audit M4 (failed paper fees settled once per signature, `strayFees` bounded), M5 (dollar P&L per cash flow at its own rate, SOL and USD both shown), M8 rent (paper uses RENT-1's model); `AccountCost.kind 'failed_entry'` (approved; needs risk review) | 01Wh1t | 017PBU (risk kind), worker reviewer |
| RISK-PARTIAL (now #132) | audit M3: partial sales allocate cost basis and fees, realised P&L at once, whole-trade stats kept | 01MtftX (after #124) | 017PBU |
| WATCH-1d | audit M2: snapshot context slot through quotes and marks, `minContextSlot`, stale when it lags a healthy confirmed head. WIP on `claude/watch-1d` at 221f291: minContextSlot, head-lag and repeated-bank refusals, confirming snapshots; 7/7 mutants; next merge claude/watch-1c in, then open the PR | 01WGpx | 017PBU |
| EXIT-1h | persist the entry seed with the fill (write order as #123), so a kill between fill and plan restores instead of selling. Branch `claude/exit-1h` at 33f2998, pushed, no PR; full check 4515/4515 | 016KSN | 01UXzG |
| PERSIST-3 | now PR #131 (see above) | 01F7UF | 01NZwy |
| OPS-GATE (now #134) | audit O2: deploy gate requires named checks (`check` always, `e2e` green on the newest ops-touching commit in range); server and tag.sh agree; preview release requires `check` | 01VgCL | 01Ty8L |
| PNPM-CLAIMS | audit O3: configure the three pnpm protections ARCHITECTURE claims, or correct the text (supervisor sees the diff first) | 01VgCL | 01Ty8L |
| SEC-1 | audit O1: preview APK key out of the Actions cache into a secret plus a certificate check; owner creates the secret; rotating means reinstalling the app | 01VgCL | 01Ty8L |
| DATA-5 | audit D1, design only: daily regime volume for days ≥ 2 Oct (the scan refuses them; the regime gate needs D−3). Research is done, the write-up isn't. Draft: upgrade-aware decoding by default. The money choice is a paid RPC for full D−3 days (about US$136/month on Alchemy, or Helius Developer at US$49). Without one, the regime gate is off from about 5 Oct (the S0 diagnostic waives it for the shakedown only) | 01XHH3k | supervisor, then the owner |
| RISK-FAULT | core `evaluateExit` returns no trips when it throws inside (same as a clean account); return a fault code (status side already fails closed in #118) | unassigned | 017PBU |
| G3 fold | `worker:*` reasons folded for G3. WIP on `claude/g3-worker-fold` at a650ec8 (fold and tests in; needs a base merge after #98, DECISIONS text, then a PR) | 01WGpx | 01FHfb |
| WORKER-1d | prune saved coverage before long runs | 019cEN | 012QdD |
| OPS hardening (optional) | `holds()` also checks /health `git_sha` equals the new commit; scope e2e.sh:645 to the invocation | 01VM97 | 01Ty8L |
| VERIFY-MARKS | the RISK-MARK reviewer's open item: confirm #99, as merged, records day, week and NAV-peak boundary marks only when every mark is fresh (items b, c and e of the second-lander spec; a and d confirmed) | any worker builder | 017PBU |
| STATS leftovers | 012efQ's notes list #62 S1 as not verified closed (#114's ARCHITECTURE:307 fix was checked by the supervisor at 02d5f1d) | stats builder | 01FHfb |
| SIGN-1 note | the signer unit gets OOMScoreAdjust −500 when the real signer lands; late-landing and ambiguous-result recovery is a before-live item (audit M8) | — | — |

**Audit findings → where they stand.** M1 → #124 (FAIL, fixing). M2 → WATCH-1d. M3 → RISK-PARTIAL. M4, M5, M8 (rent) → PAPER-1. M6 → #117 flow (merged) and #130. M7 → #128. M8 (late landing) → before live. B1, B2, B3, B4, B5, S2 → #41. B3/B4 wording → #115 (done at 8dc0f49). B6 → #120 (selection fixed, p-values FAIL). S1, S3, S4 → #129. D1 → DATA-5. D2 → noted (the paid-plan speed is unmeasured; retries and worker use are excluded). D3 → #119 (merged, fail-closed) and #127. O1 → SEC-1. O2 → OPS-GATE. O3 → PNPM-CLAIMS. §10 (a 20% stop isn't the maximum loss) → the owner's before-live list.

**Data:**
- 09-21 free-day pull: run 37185822426, chained, cap 270k credits, 5 requests/s, started 07:27 UTC, about 14 h.
- Helius free is 1M credits a month. A day costs about 250k, and the live worker needs about 408k a month. So only about 2–3 practice days a month fit; never dispatch a second day without checking the ledger.
- The archive (Old Faithful) blocks our scanner. Triton has been emailed by the owner. ARCHIVE-CHECK asks every 3 h; never disguise the scanner.

## 5. Sessions

### New account (live; started about 8:05 PM, 4 Oct)

Every session reports to the supervisor with `send_message`. Model: `claude-opus-5-5` unless noted. Each continues from the first-account notes named in its prompt.

| Role | Cards (in order) | Predecessor | Session |
|---|---|---|---|
| Builder | WORKER-ORDER #123 fix, then WORKER-1d (branch claude/worker-1d-prune) | 019cEN | session_01WFmrBXa6KfoKgBaRVXXCW8 |
| Builder | RISK-LATCH #124 fix, RISK-FAULT (claude/risk-fault), RISK-PARTIAL #132 base merge after #124 | 01MtftX | session_01Dn7Qz3cPQH9nPpwv5eSVVb |
| Builder | WATCH-1d PR, #121 upkeep, G3 fold after #98 | 01WGpx | session_012uJsLd8BGFN9FzFw4hJeRH |
| Builder | EXIT-1h PR, the #107/#128/EXIT-1h stack after #107, BT-3 evidence re-run on fills-3 after #114 (claude/bt3-fills3) | 016KSN | session_01L9Zdh5zpjSQ9go7WEQQZcC |
| Builder | BT-2 #41: base merge, audit B5, B1, B3, B2, B4, S2 (estimand ruling first), 012efQ B1, rulings | 01VBTf | session_01AYk3qRoMccUhz8xEwEjvER |
| Builder | RES-4 #115 C1b (test-only exact parity) and §4 line; base merges into res-4/res-5 after #114; #56 | 018esL | session_01QvPYMaMxLVnoBuWzjswcvW |
| Builder | DATA-4 #127 B1/B2 and doc line; DATA-5 write-up (claude/data-5); 09-21 spend after the chain | 01XHH3k | session_01J1javobgRjnF4MT3xz3er9 |
| Builder | OPS-GATE #134, PNPM-CLAIMS #135, SEC-1 #136 after #134 | 01VgCL | session_015LRm59hPdRdz8jbGtxs6pV |
| Builder | API-1 #118 check and base merge; APP-MODES; OPS-1i (holds() git_sha, e2e.sh:645 scope) | 01VM97 | session_01UkTpC4mnY6EVAK7Y7qBNM4 |
| Builder | PERSIST-2 #125 base merge, PERSIST-3 #131 check, EXIT-ROUTE #130 upkeep | 01F7UF | session_01XVYJjps9QBz53C8jjWZsgi |
| Reviewer | risk: #121 delta, #132, #133 failed_entry kind, VERIFY-MARKS; later #124, WATCH-1d, RISK-FAULT | 017PBU | session_01R3CGBftm63CCqU4mfNqWvx |
| Reviewer | worker/facts: #130, #133 (all but the risk type); later #123 | 012QdD | session_01NGXuvZax56XDPC3y6AUCNo |
| Reviewer | PERSIST: #131, then #125 | 01NZwy | session_014EaQVyrAfSCS4FRodKNUWQ |
| Reviewer | ops: #134, #135, later #136; push e2e after the next ops merge | 01Ty8L | session_018aCfZbFj6u7zkwK7Wg7Czb |
| Reviewer | BT: #122 full check, #62 S1 and #114 doc check; later #41, #115 | 012efQ | session_01L7GdfN89hXuBxLHRS8jnY6 |
| Reviewer | stats: #129, #120; later #115 §4, s0Of, SE-floor calibration | 01FHfb | session_017ngaDxRifzZxMNLokAJ8LZ |
| Reviewer | run/CI: #118 delta | 01DdN4 | session_01SndtRnoTtCGJrTDuJhTWMW |
| Reviewer | EXIT: #128, later EXIT-1h | 01UXzG (no notes) | session_01AeE2xarrFptXtPvuugJXUP |
| Read-audit | packages/core | — | session_01HHVUjTjH6BxWnBgc3w5sMZ |
| Read-audit | packages/worker, runner, ops | — | session_016zNeDtRwejxacaL3e9y6wi |
| Read-audit | packages/backtest, research | — | session_01Q5o53anApTveK5RMUEusnK |
| Read-audit | apps, ops, .github, brand, root files | — | session_01VjRmz6eLWhKx9fhE4c6A4m |
| Read-audit | docs (all but the sandbox), HANDOVER, PROJECT_STATE | — | session_014g6TsnoKDTzrPa8CKZdWW2 |
| Read-audit | docs/handover/sandbox (manifests, exposure scan); `claude-sonnet-5-5` | — | session_01SMMcQJZka8e3j3TVC5KoHd |

Not started yet: a data reviewer for #127 (after the builder's fix), PAPER-1 and STATS-1g builders (started when their reviews return findings), and the unassigned leftovers in §4 (VERIFY-MARKS went to the risk reviewer).

### First account (paused, not reachable from the new account)

Each session's notes: `docs/handover/sessions/<session id>.md`.

| Role | Cards | Session |
|---|---|---|
| Builder | DATA-2, pilot, ARCHIVE-CHECK, #119, DATA-4 #127, DATA-5 | session_01XHH3k24fjmkpmmt28xSaYv |
| Builder | WORKER-1/1b/1e #117, PERSIST-2 #125, EXIT-ROUTE #130, PERSIST-3 | session_01F7UFCa8r4aee38kW7687Y3 |
| Builder | FACTS-1/1f #106, TEST-1 | session_01GDycboQzFrFWxVniy6B6Ps |
| Builder | WORKER-1c (second lander), WORKER-ORDER #123, WORKER-1d | session_019cENcTEidMc4LEhPydYAZK |
| Builder | RUG-1, TEST-3 #98, WATCH-1b/1c #121, WATCH-1d, G3 fold | session_01WGpxEWFacSgAuXL5KAzrKc |
| Builder | POS-1, RISK-MARK, RISK-LATCH #124, RISK-PARTIAL | session_01MtftXmPKCqdkXEop4h7vf1 |
| Builder | BT-1, EXIT-1f #107, RENT-1 #114, EXIT-1g #128, EXIT-1h | session_016KSN98NC2xQxetiZkpCVtT |
| Builder | BT-2 #41, BT-2e | session_01VBTfAwrhgoCssEzST2J2q5 |
| Builder | STATS-1b/1f, STATS-1g #129 | session_01J9yEWHRunNxvo5CaTbuYSe |
| Builder | RUN-1, MEM-1, CI-1b #116, OPS-GATE, PNPM-CLAIMS, SEC-1 | session_01VgCLpHWaM7FjpwofRcgrwM |
| Builder | OPS-1e/1h, SWITCH-1, APP-3, API-1 #118, E2E-DRILL #126 | session_01VM97q6A98GgtoPKCamoiT6 |
| Builder | RES-3/3b #56, RES-4 #115, RES-5 #120, BT-TAIL #122 | session_018esLCVLp9yCExK5cdnzCz8 |
| Builder | PAPER-1 | session_01Wh1trUafgBq5CjrGuLYkGj |
| Reviewer | DATA (#111, #119, #127) | session_01DKMnUiqVLxVjHbaqdoBnJD |
| Reviewer | WORKER, FACTS (#117, #106, #123, EXIT-ROUTE) | session_012QdDAuRuYt57E9PCjHfuKT |
| Reviewer | #99, PERSIST-1/2/3 | session_01NZwyB8decLbgxKJoG2cAbP |
| Reviewer | risk (#99, #113, #117, #121, #124, PAPER-1 kind, RISK-PARTIAL, WATCH-1d) | session_017PBUwcGJWG4DJpJKVBcAas |
| Reviewer | OPS (#110, #126, OPS-GATE, SEC-1) | session_01Ty8Lvbxybv8cRixTifx6y3 |
| Reviewer | BT (#41, #114, #115, #122) | session_012efQfLAwWStK3PT6ZW2PHz |
| Reviewer | STATS (#109, #98, #120, STATS-1g) | session_01FHfbJwz7sbf2eVDNRxMigZ |
| Reviewer | RUN, TEST-3, CI (#116, #118) | session_01DdN4xy9WX2t7nLUq7ww4E5 |
| Reviewer | EXIT (#107, #128, EXIT-1h) | session_01UXzG7h8LWHGLxtJzf7C95N |
| Reviewer | RISK-MARK (#103, merged) | session_01NrMeuDsAQNtz4bW1LjBwYT |
| Supervisor | board, queue, rulings | session_01Bne9GqXR99gJn6D9U2mJFZ |

## 6. Plan and timeline (Melbourne time; estimates, not promises)

Times count from when the new supervisor resumes (R).

| Milestone | When | Depends on |
|---|---|---|
| Real worker on the server (paper), Online in the app | R + about 30–60 min if the push e2e on 7d5e203 is green; otherwise after its fix | #126's push e2e, Deploy, owner's check |
| Practice trades (S0 shakedown, labelled diagnostic set) | right after Online | real worker; P&L rough until PAPER-1 |
| Practice P&L exact | R + about 1 day | PAPER-1, RISK-PARTIAL, reviews |
| Audit fixes merged | R + about 2–3 days (±1) | the cards in §4 |
| First free practice day (09-21) | about Mon 5 Oct 8 AM | run 37185822426 |
| Early look (descriptive only, no G1/SPA verdict under 10 days) | about Tue 6 – Wed 7 Oct | 09-21 data, BT-2 audit fixes, frozen SE floor and pick rule |
| Historical days for proof (≈50 practice days plus 28 holdout days) | not scheduled | the owner's paid-month decision (about US$94, 5–6 days best case, unmeasured) or Triton |
| Holdout entry cutoff E | 20 Oct (UTC), fixed | — |
| Funding | not before every pre-funding item passes; impossible on free data alone | proof |

## 7. Waiting on the owner

- **Now:** nothing. When Online is deployed: open the app (Paper tab shows Online) or send /status to the Telegram bot, and tell the supervisor what it shows.
- **When 09-21 finishes (about Mon 8 AM):** the Helius dashboard's credits-used number for the ledger init. A conservative estimate is used if it doesn't come.
- **SEC-1:** create the preview APK signing secret (exact steps come with the PR). A new key means reinstalling the app.
- **Spend:** the paid Helius month (about US$94) only after the owner has seen the finished product: Online, practice trades and the early look. Free alone can't prove a strategy.
- **Before the qualifying run:** the execution-health limits (a proposal from the shakedown's measured figures).
- **Before live:**
  - R8 "5 losses in 20";
  - the daily and weekly loss boundary switch;
  - the RISK-1 findings: C ≈ $0.79 per trade; $5 entries blocked until $29 week-start equity; R10 trips after about a $3.55 loss because the HWM includes the ops floor;
  - one loss of about $0.70 ends the day;
  - the worst case per trade is about 40% of principal plus fees (a 20% stop plus a 25% emergency rung), not 20%;
  - late-landing and ambiguous-result recovery for real transactions;
  - whether the server may upload evidence to GitHub (OPS-1d).
- **Forward** any Triton reply.
- **Done on 4 Oct:**
  - GitHub Pro;
  - Helius free only and no spend before a finished product;
  - the Tailscale key expiry disabled;
  - SPA for G1;
  - code-only Deploy authorised;
  - `DEPLOY_CODE` deleted;
  - a disguised scraper declined (by the supervisor);
  - the handover to a new account.

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

- **Evening rulings (4 Oct, after the audit):**
  - One rent model in proof scoring (RENT-1). Research PRs never change `outcome.ts`; proof-scoring changes get their own PR (BT-TAIL).
  - "Entries: On" only when true: no halt, no risk stop, the risk snapshot known, and a fresh regime. "Regime: On" is never shown plain while the S0 diagnostic waives a part (API-1).
  - Entries never read WATCH-1c's carry; it serves held positions only.
  - A persistent risk latch rests on evidence: latch only when every mark is known and fresh (RISK-LATCH).
  - Recovery without a trustworthy plan is sell-only, never a new holding period or a looser stop (EXIT-1g).
  - Write order: journal the exit, then commit the ledger close (WORKER-ORDER; ARCHITECTURE §12.4).
  - The live worker owns exits, so it gets OOMScoreAdjust −500 under MemoryMax 800M, and the switch trial gets +1000.
  - The e2e OOM check stays strict; a sandbox opt-in may only come explicitly, in a later PR.
  - Credits are reserved before spending, and the books fail closed (#119, DATA-4).
  - Stats (01FHfb): SPA needs at least 10 active days, so the early look reports no G1 or SPA verdict.
  - The SE floor is 0.0005 of the base per day, frozen per attempt, with a calibration case, and never chosen from data.
  - Pick rule: the highest min(zVsZero, zVsS0) among SPA passers; drop a variant that can't fill the holdout; familySize stays 2. `s0Of` is required for k = 6.
  - Pre-registration definitions are amended before any data: holder growth counts distinct owners; "non-creator-user flow" replaces "independent buying".
  - Stored data approved by the supervisor (the bot's own data only): `strayFees` (bounded) in account.json, the graduates series, and the entry seed with the fill (EXIT-1h).

## 9. Infrastructure

- **Server:** Vultr, Frankfurt, `zeroed`, Ubuntu 24.04, US$6/month, re-installed at pin e28788a on 4 Oct.
  - Paired with the Telegram bot @Zeroed_alerts_bot.
  - The worker API binds to loopback 127.0.0.1:8788 and is published on the tailnet by `tailscale serve`. Health is on :8787.
  - Since the 7d5e203 deploy it runs the release's worker (paper), unless zeroed-update kept or rolled back to the old release on a failed check (an alert goes to Telegram).
- **Keys:** GitHub secrets only: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. `DEPLOY_CODE` is deliberately absent. Never in the repo or in chat.
- **Watchdog:** Cloudflare Workers, free plan, `workers.dev`. No custom domain.
- **App:** Android preview APK at the fixed `preview` release link (see `PROJECT_STATE.md`).
- **CI:** GitHub-hosted runners, free for a public repository. The owner's account is on GitHub Pro (owner's decision, 4 Oct): 40 jobs at once.

## 10. Risks being watched

- **GitHub billing lock:** from declined GitHub Pro payments (3:15–3:23 PM and from 3:37 PM, 4 Oct). It stops CI, merges, server updates and data jobs, and only the owner can clear it.
- **External audit defects** (§4): until PAPER-1, RISK-LATCH, RISK-PARTIAL, WATCH-1d and EXIT-1g merge, paper P&L, latches, stale-snapshot handling and recovery are not trustworthy evidence. The qualifying run waits for them.
- **Free credits:** 1M a month shared by the practice-day pulls and the live worker. DATA-4's ledger is the guard; the worker's share is held back.
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
