# Z-H history credit estimate: review record

## Round 1 (head `db3050b3`, 8 Oct 2026)

### Fresh review (FAIL)

REVIEW Z-H credit estimate — branch claude/research-zh-estimate @ db3050b3d1c45207bc9d3204aa5c7446eed56140 (confirmed by git ls-remote). Review only: no edits, no Helius calls. Verdict: **FAIL** (1 BLOCKER, 3 MAJOR, 4 MINOR).

VERIFIED OK
- Credit costs match Helius docs. helius.dev returns 403 to the web fetcher, so I read the .md copies with curl on 2026-10-07:
  - credits.md:88 Standard RPC 1; :94 gPA 10; :100 gPAV2 1; :124 Enhanced 100 (maintenance mode); :130/139 Parsed Events 10 per request.
  - :145 "Historical data queries … cost 1 credit each"; :160/166 getBlock and getBlocks 1.
  - :210/231-232 getTransactionsForAddress: 10 per 100 full tx rounded up, 10 minimum; signatures 10 flat; failed responses free; up to 1,000 per call.
  - rate-limits.md:34-35 Developer RPC 50/s, DAS &amp; Enhanced 10/s; :143-146 gPA 25/s Developer; :152-188 historical batch: getTransaction 100 items, getTransactionsForAddress and getTransfersByAddress no batch, other historical methods 10 items.
- Arithmetic, as written:
  - 30.25×255k = 7.71M, 7.41M to 8.50M; 60.25× = 15.36M.
  - 255k/25 = 10,200 s = 2.83 h per day, so about 86 h (3.6 days).
  - 255k × 1.65 MB = 420 GB a day, 12.7 TB, 41 MB/s.
  - 9.87M − 8.6M = 1.27M.
  - MR point: 1,125 × 2,060 + 0.77M = 3.09M.
  - Slip: the PM lower bound is 1,270 × 8,000 × 0.1 × 30 = 30.5M, not 28M (RESULTS:172).
- Window: post-BOOST; ends 09-21, so outside B3_CONTAMINATED (2026-09-22T00Z to 10-21T00Z, Z0D SPEC-A:2247) and before any W_R.
- Universe: from chain events only.
- No pump.fun host: the scripts call only api.mainnet-beta.solana.com and GitHub release downloads (deep_sample.py:11). Its limiter is 1 request every 2 s, honours Retry-After and stops after 3 failures (:6, :28-36).
- The "item 2 only, not an untouched item-6 holdout" conclusion is correct.

F1 BLOCKER — Slot-time basis is wrong, so the per-day cap stops the run on day 1 and the range is not a bound.
- RESULTS:155-162 uses 0.329 to 0.344 s for the whole window. FACTS.json:987 (LD-08, SIMD-0525) says targets were 350 ms from 08-21 (epoch 1020), 300 ms from 08-28 (epoch 1024) and 250 ms from 09-18 (epoch 1037); about 0.266 s was measured. RESULTS' own sample slots fit this: 09-02→09-16 is 3.70M slots in about 14 d ≈ 0.327 s. Its last sample (09-16) is before epoch 1037 (slot 447,984,000).
- So 09-18 to 09-21 run at about 325k slots a day, not 251k to 263k.
- The planner also adds ±1 h margin per day (rpcscan/main.go:302, 3,600 s of units each side), i.e. about 27k slots on 250 ms days, re-read on adjacent days.
- Measured evidence agrees:
  - 09-21's plan was 79 units × 4,500 = 355,500 slots (HANDOVER:1227).
  - The 270k cap was spent with only 56 of 79 units done, 18% of them 429 retries (HANDOVER:1379).
  - Net of retries that is about 3.95k credits per unit, so about 310k for the full 09-21, before retries.
- Rough re-derivation, planned slots for 30.25 d:
  - 5.25 d × 260k + 21 d × 286k + 4 d × 352k ≈ 8.8M.
  - Billed at 0.88 to 1.0 per planned slot, the produced-block share (0.88 implied by the 09-21 run, approximate): about 7.7M to 8.8M before retries.
  - The client cap counts every HTTP attempt (RESULTS:205-206). Retries ran 12% (pilot 625/5,225) and 18% (09-21) on Free; the Developer rate is unknown.
- Consequences:
  - (a) The per-day cap of 290k (RESULTS:207) will trip on 09-21, 09-20, 09-19 and 09-18. Newest-first order makes those the first days, so the run stops for review at once.
  - (b) The 8.6M total cap may end the pull before 30 clean days. Rule 5 then leaves spent credits and B-10 still failing.
  - (c) The 8.50M "range top" is not an upper bound.
  - (d) The second 30 days (07-24 to 08-20, 400 ms slots) cost less than 7.7M.
- Fix: compute per day by slot-time regime, with margin units and a stated skip-rate source. Use the 09-21 plan and spend as measured anchors. Set per-regime day caps. Add retry overhead to the client-cap budget. Re-check the total cap against the 9.87M left. Give the block times (UTC) behind the cited slots. Add the SIMD-0525 changes to the §3 regime-break list.

F2 MAJOR — "Whole blocks give every field B-10 needs, including transfers for holder checks" (RESULTS:26, :44) is overstated.
- top10_holders and single_holder are HARD gates (Z0D ARCH:2189-2190). They need the full holder distribution at entry.
- MR pools are at least 24 h old and often months old. 30 days + 6 h of movements cannot rebuild balances; DATA-2 itself says ownership at a window's start is "unresolved until movements begin" (historical-data.md, lead-in note ~:163). preTokenBalances only cover touched accounts.
- The same problem applies to the starting virtual_quote_reserves and pool config of pools created before the lead-in.
- If the engine fails closed on missing holder data, MR makes zero entries and B-10 "zero crashes" becomes vacuous.
- Missed method: getTransfersByAddress (credits.md:216, 10 credits per up to 100 transfers, Developer+, no batching) for per-mint holder history back to creation. Estimate it, or state the gap and how the replay handles it.

F3 MAJOR — Feasibility is not shown end to end, and storage has no allowed home today.
- Where it would run: GitHub-hosted runners via ci/rpc-day.sh. The repo is public (list_repos), so minutes are free; runners have 4 CPU, 16 GB RAM and 14 GB SSD (historical-data.md:220).
- It must not run on the 2 GB / 55 GB host: the disk can't hold 95 to 255 GB, and ARCH D29/CA-26 keeps replays off the live host.
- Reading and transfer can plausibly be $0 (Helius bills per call), but nothing above 5 blocks/s has been measured.
- Storage is the blocker:
  - the Actions cache is 10 GB per repo (about 1 day);
  - DATA-PUB keeps Helius-derived assets cache-only and never published until Helius §3.2(xi) is settled (historical-data.md ~:318);
  - releases on the private repo (#150 DATA-STORE) wait on the owner.
- Where the 30-day engine replay reads its data from is not stated.
- Plain answer: not doable end to end today within free tiers. It becomes $0-feasible only after §3.2(xi) and storage are decided. Fix: say this in §6 and in the owner summary.

F4 MAJOR — The owner summary (RESULTS:239-242) misleads by omission: it reads as ready to start. It needs to add:
- (1) Z0D ARCH:458: "No download credit is spent until a strategy has survived Phase 0 and the owner has ruled on C-76." This is also missing from the §7.6 preconditions.
- (2) Helius §3.2(xi) is open.
- (3) The storage for 95 to 255 GB is not in place.
- (4) These 30 days serve item 2 only, never the item-6 holdout.
- (5) The 25 req/s rate is unmeasured: the pilot ran 5/s, and reading time could be about 5× longer.
- (6) The F1-corrected credits and cap.

F5 MINOR — The transfer figure uses 1.65 MB/block, which is the archive's (historical-data.md:85). The RPC pilot recorded about 3.0 MB/block (docs/handover/sessions/session_01XHH3k24fjmkpmmt28xSaYv.md:31), giving about 23 TB and about 75 MB/s. No credit impact, but restate it.

F6 MINOR — "2026-09-21 was read over Helius" (RESULTS:69) is overstated. The day never finished: 56, later 66, of 79 units cached (HANDOVER:1379, :1285, :1221; kept by DATA-KEEP, :559). The saving is the cached units only, if they pass checks, and they are raw getBlock data under DATA-PUB.

F7 MINOR — The viewed-window list (RESULTS:71-76) is incomplete. Also add:
- U1/U1-B: walk-forward 08-17→09-11, pre-registered holdout 09-12→09-21 (HANDOVER:615);
- RS-24 hour-1 runner: graduates 08-21→09-06;
- RS-31 lottery basket: 07-22→08-20 (both in the Z0D ARCH results table).
These touch PM-01's universe too. The conclusion is unchanged; the A12 ledger entries must list them.

F8 MINOR — "B3" names two things:
- the regimes.json fee-config break of 2026-09-09 (RESULTS:43, :60);
- the MIGRATION B3 holdout (RESULTS:32, :54).
Label the first "regime B3 (regimes.json)".

Result: FAIL at db3050b3. Re-review after F1-F4 are fixed. F5-F8 can ride the same push.

### Red team (4 BLOCKER, 8 MAJOR, 5 MINOR)

RED TEAM REPORT: Z-H history credit estimate
Target: research/z-h-estimate/RESULTS.md on claude/research-zh-estimate @ db3050b3 (confirmed by git ls-remote before and after: unchanged). Rule read: CLAUDE.md "History for the past-data test" at 651b1737:89.
What I did: no edits, commits, pushes or Helius calls. I read the code at db3050b3 (research/historical/rpcscan, ci/, .github/workflows/data-scan.yml) and the docs on supervisor-docs (HANDOVER, PROJECT_STATE, DECISIONS, MIGRATION, historical-data.md, FACTS LD-08). I fetched Helius's credits, rate-limits and terms pages on 2026-10-07.

VERDICT: NOT READY to show the owner as written. The pull would very likely hit or pass its own cap. The 8.6M cap is not enforced by any code. And the downloaded data has no place to be kept.
Totals: 4 BLOCKER, 8 MAJOR, 5 MINOR.

== BLOCKERS ==

RT-01 BLOCKER: under-estimate, because slot time fell inside the window.
- Problem: the estimate uses 255k credits per chain day, the pilot's average over 19 Jul to 3 Oct. Solana's slot time changed during the window: 350 ms from 08-21, 300 ms from 08-28, and 250 ms from 09-18, epoch 1037 (FACTS.json LD-08 "confirmed"; about 267 ms measured). RESULTS only measured anchors up to 09-16.
- Real cost of 09-21: 79 units are planned, so about 355k credits for the day (HANDOVER:1227 "a full day is about 33 h and about 355k credits"). The 66 units cost 319,730 credits, about 4.84k per unit including retries.
- My re-derivation (uncertain, DERIVED): about 5.25 days at about 246k slots, about 21 days at about 264k, and 4 days at about 324k. That is about 8.14M slots. At the 09-21 ratio of about 1.10 credits per slot, plus about 0.15M for determinism rescans, the total is about 8.9–9.3M. The estimate says 7.7M (range 7.4–8.5M).
- Consequence 1: the 8.6M cap is likely to stop the pull before 30 days. Rule §7.5 says never run a shorter check, so millions of credits would buy nothing usable.
- Consequence 2: the 290k per-day cap (§7.2) trips on the very first day read (09-21, newest first, about 355k).
- Fix: re-estimate per day. Count slots per day from free getBlockTime anchors on the keyless public RPC, use 09-21's real usage files for credits per unit and the 429 overhead, and add the rescan. Then reset the cap and the per-day cap, or shift or shorten the window plan, and re-present to the owner.

RT-02 BLOCKER: the 8.6M "hard cap" is not enforced by any code.
- What exists: `-max-credits` is per process (helius.go:155). rpc-day.sh caps ONE day across chained runs, with the counter in that day's OUT/rpc-credits-used (rpc-credits.sh). data-scan.yml limits max_credits to 1–1,000,000 per day (line 150). Nothing sums across days.
- The counter also lives in an evictable Actions cache. A restore of an older or smaller cache resets it, which already happened on 09-21: it restarted from 0 of 79 units (HANDOVER:1227). HANDOVER:1221 N5 says "the pick can't see credits; #127's ledger bounds spend", but #127 is not merged.
- A rescan after a scanner or rpcscan revision change re-reads every cached unit at full price (rpc-day.sh "Units of another revision are reread"; HANDOVER:1378 "drops all 56 units, about 250k credits").
- Fix: before any spend, add a single cross-day ledger that is persisted outside the cache, checked before each request and fail-closed, with a test. Freeze scanner and rpcscan revisions for the whole pull. Set per-day caps whose sum is no more than the global cap. Today 30 × 290k = 8.7M, which is more than 8.6M.

RT-03 BLOCKER: the data has nowhere to be kept, so credits are wasted to eviction.
- DATA-PUB (historical-data.md:317): Helius days are NEVER published to releases until Helius's terms are confirmed. They live only in the Actions cache: 10 GB per repo, LRU eviction, and eviction after 7 days without access.
- One day is about 5–6 GB in the cache (09-21: 56 units = 3.6 GB, HANDOVER:1379; 11 units = 811 MB).
- So while day N+1 is read, day N's progress and assets get evicted. 30 days (95–255 GB by RESULTS' own figure) cannot exist anywhere under the current rules.
- RESULTS §6 says it "needs DATA-STORE (#150) private releases", but it does not say that DATA-PUB forbids that for Helius-derived units, which carry raw getBlock responses. It also does not say DATA-STORE needs owner steps first.
- Fix: make storage plus a DATA-PUB ruling (tied to the terms question, RT-11) hard preconditions. Size them, and name where the replay will run and how it streams per day.

RT-04 BLOCKER: the owner summary is misleading by omission.
- The summary reports only credits, cap and time. It is missing:
  - the risk that the cap stops the pull before 30 days, so the credits are lost (RT-01);
  - that the cap is not enforced today (RT-02);
  - that storage is not available (RT-03);
  - that the key and the 1.27M left over are shared (RT-05);
  - the open Helius terms question (RT-11);
  - the viewed-window limit (RT-09);
  - what the owner gets if it stops early: nothing usable.
- It also says "3.6 days of non-stop reading" (86 h) without saying that 25 req/s is unmeasured. Measured so far: 3–5 blocks/s, with 18% 429s at 5 rps on the free plan (HANDOVER:1379).
- Fix: rewrite the summary after RT-01 to RT-03, with the stop conditions and the downside stated plainly.

== MAJOR ==

RT-05 MAJOR: shared key and the rest of the cycle.
- MIGRATION A03 says "the bot shares the owner's Developer-plan key". HANDOVER:1227 says "beside the bot's about 25k an hour on the same account", and bug B4 measured up to about 87k an hour.
- If anyone restarts the Zeroed worker, or anything else uses the key, the 1.27M left over lasts about 15–50 h. Autoscaling is off, so Helius then refuses every call until 6 Nov, for the bot and everything else.
- About 126k credits were used on 7 Oct while the worker was "off", and the consumer is not identified.
- Fix: before the pull, name every Helius consumer and its expected use, or use a separate key or project with its own limit if Helius allows it (VERIFY in the dashboard). Make "no other Helius consumer for the whole pull" a pre-condition.

RT-06 MAJOR: the owner's "stop after 3 failures" is not implemented.
- helius.go retries 429, 5xx and network errors with no count limit, until a 15-minute back-off budget runs out. Then it exits 75 (resumable), and the chain re-dispatches up to 12 runs.
- A 429 "max usage reached" is not told apart from an ordinary 429 (§7.4 assumes it is).
- Helius documents JSON-RPC rate-limit code -32005 (rate-limits page). The client only recognises -32429 and 429 in the body (helius.go call()), so a -32005 sent with HTTP 200 would end the run as a non-retryable failure. That fails closed, but the cause is labelled wrongly.
- Fix: a code change plus a test before the pull: stop after 3 consecutive failures, a separate exit for credits exhausted, and handling of -32005.

RT-07 MAJOR: MR pools have state from before the window that the blocks do not contain.
- RESULTS says whole blocks give "every field B-10 needs, including transfers for holder checks". That is true only for mints created inside the window.
- MR pools are old and deep. Their holder state (top10, single_holder, creator_balance), the per-pool creator-fee config (A08) and, possibly, virtual-reserve changes are set before 08-22.
- historical-data.md: "Lead-in days carry no movements … ownership unresolved". So holder gates are unresolved for all MR pools, and fail-closed means the MR replay never enters (it proves nothing).
- Pool age at or above 24 h for pools created before the lead-in needs getTransactionsForAddress at 10 credits per pool, and the number of pools is not counted in the credit total (it could be hundreds of thousands of credits).
- Fix: list the state each gate needs at the window start and its source. Budget for the age lookups, or lengthen the lead-in to at least 24 h. Decide whether the MR universe can be replayed at all, before spending.

RT-08 MAJOR: "same engine code" is only partly met at sample 0.05.
- CI runs `-sample 0.05`. Raw transactions, the input to the shared TS decoder `transactionEvents`, are kept only for hash-sampled mints and creates and migrations (historical-data.md "Raw records").
- For about 95% of mints the replay would feed rows decoded by the Go scanner, not the engine's live decoder.
- Fix: state this against owner item 2 ("replayed transaction by transaction through the same engine code"). Either rule that Go rows plus parity are acceptable, or set the sample to 1.0 for the universe mints and re-cost the storage.

RT-09 MAJOR: viewed window and the 09-21 reuse.
- The 09-21 cached day was collected before 2026-10-07. MIGRATION A02 (supervisor tightening) says such data "serves research only, never a Blueprint universe or gate". So reusing it in B-10 breaks A02 unless that is lifted.
- 09-21 was also the 6 Oct data study's day (CLAUDE.md "Data study"). The saving is also wrong: about 355k, not 0.25M.
- The whole window was explored by MR-A and MR-B, which are near MR-01's configs. If MR-01's two configs were registered after that probe, then B-10 on this window is in-sample, not just "viewed".
- Fix: drop the 09-21 reuse (or get A02 lifted). Check MR-01's registration time against the probe. Tell the owner plainly that B-10 here is a robustness check, not evidence of edge.

RT-10 MAJOR: the VERIFY items can sink the whole pull and are free to check now.
- Two facts are unverified: whether the DATA-2 filter keeps pump_fees admin transactions (fee-tier changes, B3 2026-09-09) and every virtual_quote_reserves change.
- If either is missing, the 9M-credit dataset cannot price fees and reserves correctly.
- Fix: verify both on the cached 09-21 units, or on code, before showing the owner a number. It costs no credits.

RT-11 MAJOR: Helius terms (I verified the text).
- The Cloud Services Agreement, "Last Updated: September 28, 2026", §3.2(xi): Customer will not "use or access the Services in any personal, household, or familial capacity, or for any purpose other than a lawful business purpose".
- §6.2: Helius "may suspend Customer's access … if Customer breaches Section 3.2 … or uses the Services in a manner that materially harms the Services".
- I found no clause in §3.2 that names bulk download or storage of chain data. §3.2(ii) bans "distribute … the Services to third parties" and (iv) bans "derivative works of the Services". Whether those reach stored blockchain data is a legal reading I cannot confirm.
- The real risk: a sustained pull of about 9M getBlock calls (about 14 TB) from a personal account brings the open (xi) question to a head. A suspension would also cut off the account's other uses (RT-05).
- Fix: the owner rules on (xi) before the pull, not "or accepts as is" afterwards. That ruling also decides DATA-PUB (RT-03).

RT-12 MAJOR: time and throughput are unproven.
- RPC_CONC is not a workflow input and defaults to 4, so the throughput is about 4 divided by the getBlock latency. 25/s needs a latency of 160 ms or less for blocks of about 1.65 MB (unmeasured).
- Measured so far: about 3 blocks/s at rps 3 (09-21: 25 min per 4,500-block unit) and 18% 429s at rps 5 on Free.
- Retries reserve credits in the client count, so a high 429 rate also uses up the cap.
- The chain re-dispatches at most 12 runs, so a 30-day pull needs repeated dispatches.
- Fix: a short paid measurement (for example the first 1,000 blocks, already in §8) at chosen rps and conc, before the owner sees a time figure. Expose RPC_CONC.

== MINOR ==

RT-13 MINOR: wrong exit code. §7.1 says the cap exits 75; the code exits 3 (main.go rpcExitCode; 75 is the back-off).

RT-14 MINOR: transfer figure. At about 8.9M blocks × 1.65 MB, transfer is about 14.7 TB, not 12.7 TB. That is decompressed size (helius.go "after decompression"). The wire size is probably smaller with gzip (VERIFY). Helius bills RPC per call; per-MB billing applies only to the LaserStream and streaming products (credits page). So transfer is not a credit risk.

RT-15 MINOR: the MIGRATION Z-H card still says "no new download and no new credits" (MIGRATION:810). Update it to the owner's 10-08 rule so reviewers do not block on it.

RT-16 MINOR: HELIUS_DAYS in archive-limits.conf lists only 2026-09-21. Every new day needs a reviewed change before dispatch (ARCHIVE-NODUP). Also, the repo is public. Actions caches made on the default branch can be restored by PR workflows, possibly including PRs from forks (VERIFY GitHub's cache scoping). That matters for raw Helius data under §3.2(ii).

RT-17 MINOR: there is a free alternative.
- The Old Faithful archive route (same scanner, parity proven, 0 Helius credits) is not compared in RESULTS. The owner said on 6 Oct "u can download other days for that politely". Its limits: 429 back-offs, publication waiting on Triton, and the Blueprint's "no bulk downloads".
- If the supervisor's options to the owner did not include it, add it as an option.

== What I verified and what I could not ==
Verified from Helius pages, fetched 2026-10-07:
- getBlock and getBlocks cost 1 credit; "Historical data queries … cost 1 credit each"; getTransactionsForAddress failed responses are free.
- Developer RPC limit is 50 req/s; historical methods allow batches of at most 10 items, getTransaction 100.
- Credits are consumed "monthly, prepaid, autoscaling".
- There is no separate archive price.
Could not verify:
- whether 429 or failed getBlock calls are billed (the docs say "free" only for getTransactionsForAddress);
- whether a batch counts as one request toward the rate limit;
- the cycle's real usage (only the owner's dashboard shows it);
- whether Helius's 50 req/s holds for 1.65 MB getBlock responses.

Report time: 8 Oct 2026, about 1:19 AM Melbourne.

### Supervisor rulings for round 2 (8 Oct 2026, about 1:25 AM)

No credit is spent until two things have happened: a strategy has survived Phase 0, and the owner has ruled on C-76 (Z0D SPEC-A, ARCH B-10). Round 2 is research and docs only, with zero Helius calls. Every number in it is either measured or derived with its source.

1. **Re-estimate per day (F1 / RT-01).**
   - Count slots per day for each slot-time regime from LD-08: 400, 350, 300 and 250 ms. Use free `getBlockTime` anchors on the keyless public RPC, with its ≤ 50% limiter.
   - Add the ±1 h margin units, the skip rate (with its source), the measured retry overhead and the determinism rescans.
   - Use 09-21's real plan and usage files (HANDOVER:1227, :1379) as anchors.
   - Give a point estimate and a true upper bound.
   - Compare candidate clean post-BOOST 30-day windows, including earlier ones with longer slots. Recommend the cheapest window that meets B-10.
   - Set per-day caps whose sum is no more than the global cap.
2. **Spend-safety preconditions (RT-02, RT-06, RT-12, RT-13, RT-16).** These become a code card, "Z-H prep", built and reviewed before any spend. List each precondition with its file and a test:
   - a single cross-day ledger, persisted outside the Actions cache, checked before every request and fail-closed;
   - scanner and rpcscan revisions frozen for the whole pull;
   - stop after 3 consecutive failures;
   - a separate exit when credits run out;
   - handling of the -32005 error;
   - RPC_CONC exposed;
   - the correct exit codes;
   - a HELIUS_DAYS change for each day.

   The ~1,000-block throughput measurement is part of what the owner approves, with its own small cap.
3. **Storage and where it runs (F3 / RT-03).** Size storage per day and in total, with the raw data kept for the universe mints (item 6). Name:
   - where the pull runs: GitHub-hosted runners;
   - where the data is kept;
   - where and how the replay streams it day by day.

   Storage needs two owner decisions first, and both are hard preconditions: the DATA-PUB ruling (tied to Helius terms) and DATA-STORE.
4. **Shared key (RT-05).**
   - List every consumer of the Helius key, and find what used about 126k credits on 7 Oct.
   - Make "no other Helius consumer during the pull" a precondition.
   - VERIFY whether Helius allows a separate key or project with its own limit.
5. **Pre-window state (F2 / RT-07).**
   - For each gate, list the state it needs at the window start and its source. This covers holders (top10, single_holder, creator_balance), creator-fee config and pool age.
   - Cost `getTransfersByAddress` for the MR mints, and pool-age lookups.
   - Decide whether the MR universe can be replayed at all, and say how the replay handles any gap. Fail-closed gates that block every entry make B-10 meaningless, so say so if that is the case.
6. **Same engine code (RT-08).** Owner item 2 says "replayed transaction by transaction through the same engine code". Plan for sample 1.0 for the universe mints, so the engine's own decoder reads the raw transactions, and re-cost storage. A path using Go-decoded rows needs a recorded ruling; I am not making one.
7. **Viewed windows and reuse (RT-09 / F7).**
   - Drop the reuse of the 09-21 cached day: under MIGRATION A02, data collected before 7 Oct never feeds a gate.
   - Complete the viewed-window list: U1/U1-B, RS-24, RS-31 and the deep-pool MR-A/MR-B.
   - Check when MR-01's configs were registered against the deep-pool probe.
   - State plainly that B-10 on this window is a robustness check (item 2), never evidence of an edge.
8. **Verify for free now (RT-10).** Check from code, and from cached data if any is still present, that the DATA-2 filter keeps pump_fees admin transactions and every `virtual_quote_reserves` change.
9. **Terms (RT-11).** Quote §3.2(xi), §3.2(ii), §3.2(iv) and §6.2 of Helius's Cloud Services Agreement, last updated 28 Sep 2026, with the URL. State what you could not confirm. Whether the owner's use is a "lawful business purpose" is the owner's decision, not ours. Phrase it as a question for the owner.
10. **Free alternative (RT-17).** Compare the Old Faithful archive route on credits (0), time, storage, parity, politeness limits and the "no bulk historical downloads" rule. That rule would need an owner exception, as Helius did.
11. **Minor fixes:** F5 / RT-14 (transfer at the measured MB per block; decompressed versus wire), F6 (09-21 never finished), F8 (call the fee-config break "regime B3 (regimes.json)"), F1's PM arithmetic slip (30.5M), and RT-15 (MIGRATION Z-H is updated in Z0D PR #286; cite that).
12. **Owner summary (F4 / RT-04).** Rewrite it as at most 6 short lines in plain words. Cover: credits (point and upper bound), the cap, what happens if the pull stops early, the preconditions (Phase 0 survival, the C-76 ruling, Helius terms, storage, the Z-H prep code, no other Helius consumer), that it is a robustness check rather than proof of an edge, and the free Old Faithful alternative.

Push to the same branch, and send the supervisor the head sha and an item→section table.

## Round 2 (head `e6860267`, 8 Oct 2026)

### Fresh review (FAIL: 3 MAJOR, 4 MINOR)

REVIEW Z-H round 2 (delta) — claude/research-zh-estimate @ e686026777a914b60fcc0a81e8377722e9c95e59 (confirmed by ls-remote). Spec: your rulings 1–12 in docs/reviews/ZH.md @ 9f31f1ae; PR #286 @ e28dfab4. No Helius calls, no edits. Verdict: **FAIL** (3 MAJOR, 4 MINOR; no BLOCKER). The arithmetic is now sound. What fails is spend-rule fit and the honesty of the owner summary.

YOUR CHECKS
1. **Window: clean and post-BOOST. YES.**
   - BOOST is 2026-07-21T14:23Z, slot 434,319,990. Source: research/historical/regimes.json:4 (B2, "admin BOOST on"), which agrees with ARCH §3.3 [ST-06].
   - The lead-in 07-22 starts about 9.6 h after BOOST.
   - 07-22..08-21 is outside B3_CONTAMINATED (09-22T00Z..10-21T00Z) and before any future W_R.
   - 08-21 is the first 350 ms day (epoch 1020).
2. **Arithmetic: REPRODUCED EXACTLY.** I ran `python3 -I estimate.py slot_grid.json`; the output is byte-identical to estimate.json. Recomputed:
   - window 07-22..08-21 (31 days): point 7,735,933 (1,599 units, 7,185,977 blocks);
   - upper 8,996,378, the sum of per-day uppers 286,939..315,070, so cap 9.0M;
   - R_POINT 0.0763 from 319,730 credits / 66 units against a 09-21 model of 79 units (matches the measured plan);
   - regime table, windows, 60 days (17.84M / 20.74M) and time (16.6 d at 5/s, 3.3 d at 25/s) all match.
   - The grid's minimum produced share is 0.976, at a point before the window; ≥ 0.99 inside it, as stated.
   - Still verified: scanner/scan.go:761-780 (rpcscan symlinks it) keeps only pump/PumpSwap instructions, so FeeConfig changes are dropped (P12 is correct).
   - Still verified: the Helius terms quotes for §3.2(ii), (iv) and (xi), §6.2 and the 28 Sep 2026 date match helius.dev/terms, fetched today.
3. **Fit with A-M14-05 (PR #286). Only partly; see N1.** The 1.1× rule holds if S ≤ 0.986M, since U = min(9.0M, 9.5M − S) ≥ 8.51M. Three conflicts the result does not address:
   - (a) **14-day window.** The B-10 window `[from,to)` is at most 14 days and the job stops at `to`. At the only measured rate (5 blocks/s) reading alone takes 16.6 d plus about 1 d of QA. A one-window pull needs at least about 6.4 blocks/s sustained: 7.19M / (14 d − 23 h).
   - (b) **exclusive=yes.** It needs "nothing else uses the Helius account during the window or in the 31 days before it". The worker and the audit used Helius on 7 Oct, so no window can open before about 8 Nov. The 6 Oct–6 Nov cycle framing ("leaves about 0.87M of the cycle", the owner line "of this month's 10 million") is therefore wrong.
   - (c) **"No partial runs."** It gates the start on U ≥ 1.1 × point (8.51M), but the upper bound is 9.0M. With U between 8.51M and 9.0M the job can still stop short. Fix: recommend U ≥ upper (S ≤ 0.5M), or state the shortfall case. Also, "the rest waits for next month" means a new B10-ACK, and U counts as spent for 31 days.
4. **Owner summary: NOT accurate. See N2.**

RULINGS 1–12
1. **DONE.** Note (M1 below): HANDOVER citations drifted. HANDOVER:1221 and :1285 are now 1231 and 1295 at 2b736a3c.
2. **DONE** (P1–P13, files and tests), apart from the PR #286 alignment in N1:
   - P1's ledger should be the A-M14-05 written-ahead ledger and lease in zeroed-data, not a second ledger.
   - The admin usage API's cost and availability are VERIFY.
3. **PARTIAL.** See N3.
4. **DONE.** The 126k split is left VERIFY, honestly.
5. **PARTIAL.** See N2: honeypot_sim.
6. **DONE.** The Go-row holder movements are flagged for a ruling.
7. **DONE.** RS-40, U1/U1-B, RS-24, RS-31, the deep-pool probe and the execution audit are listed. MR-01's timing is VERIFY. "Robustness only" is stated.
8. **DONE.**
9. **DONE.** Quotes verified.
10. **DONE.**
11. **DONE.**
12. **PARTIAL.** See N2.

NEW FINDINGS
**N1 MAJOR — No reconciliation with A-M14-05 (PR #286).**
- Missing: the 14-day window, the 31-day exclusivity (so the earliest start is about 8 Nov), the 1.1× rule against the 9.0M upper, the rolling 31-day acctCap of 9.5M against a 60-day pull (upper 20.74M needs at least 3 windows, not "two months"), and the throughput needed to finish inside one window.
- Fix: add a short §7 subsection on fit with A-M14-05 at e28dfab4, and make throughput of at least about 6.4 blocks/s (inside 14 days) a P10 pass criterion.
- PR #286 itself still cites the db3050b3 figures at SPEC-A:2498 (95–255 GB, 7.7M, cap 8.6M). Those need updating to this result before it merges. That is a Z0D-side follow-up.

**N2 MAJOR — "PM-01 can be replayed with real gates" (§1:54, §5:222, owner line 5) contradicts §5:206.**
- honeypot_sim is a HARD gate (Z0D ARCH:2193). Its `error` blocks entries (ARCH:1050), and §5 itself says it is "not possible in history".
- So in an honest replay PM also fails closed on every entry, and PM B-10 is as vacuous as MR's unless the same replay-mode ruling covers honeypot_sim.
- Fix: say so in §1 and §5. Make the ruling cover both strategies: holder gates for MR, honeypot_sim for both, and fee_config_known/venue_enabled until P12.
- The owner summary should say a ruling is needed for both strategies, not MR only.
- Also owner line 1: "of this month's 10 million" is wrong per N1(b), and "60 days … two months" is wrong (upper 20.7M is more than 2 × 10M and more than 2 × the 9.5M rolling cap).

**N3 MAJOR — Storage and where it runs: the plan does not fit the runner as written.**
- §6 sizes a day at about 17–45 GB, but the documented runner SSD is 14 GB (§6:248).
- §6 says each unit's files move off the runner "before the next". P13 says "every finished day uploaded and verified before the next day starts".
- The existing day pipeline (finalize parent-chain check, QA, determinism rescan, packaging; disk-guard needs 24 GB) works on a whole day locally.
- Fix: P13 (or a new P14) must define per-unit upload with day-level finalize/QA run from the store, or measure /mnt space. Today the real free space is logged, not documented.

**M1 MINOR — Pin HANDOVER citations to a sha.** RESULTS:104, :126, :128 cite 1221/1227/1285/1379; at 2b736a3c the figures are at 1231/1295 (319,730 at :1231 and :1295).
**M2 MINOR — The total exposure is not bounded under one number.** P10 (12k), MR pool-age/mint lookups (≤ about 25k) and P12 (≤ about 1k) sit outside the 9.0M cap. Under A-M14-05 they count in S, so they reduce U. State that, or fold them into the row cap.
**M3 MINOR — The margin of about 0.87M (§1:39) also ignores the possible 63k from the audit (§8).** It may be about 0.81M. This is moot under N1(b) anyway.
**M4 MINOR — RESULTS:121 says "1 getBlocks per unit".** The upper formula is (units+1)×4,501×1.25. Fine, but say that the rescan unit also carries retries.

RESULT: FAIL at e686026777a914b60fcc0a81e8377722e9c95e59. A round 3 needs N1–N3 and the owner-summary fixes. M1–M4 can ride along.

### Red team (0 BLOCKER, 5 MAJOR, 3 MINOR)

RED TEAM ROUND 2: Z-H estimate
Target: research/z-h-estimate/RESULTS.md, claude/research-zh-estimate @ e686026777a914b60fcc0a81e8377722e9c95e59 (ls-remote confirmed).
Read: rulings docs/reviews/ZH.md @ 9f31f1ae; Z0D PR #286 @ e28dfab4 (SPEC-A A-M14-05 ~:2490-2530, DECISIONS:114, ARCH:2197/:3190); Helius admin-usage and getTransfersByAddress pages (fetched 2026-10-07).
No edits, pushes or Helius calls.

VERDICT: the round-1 blockers are fixed, and the estimate is now sound. The owner summary is still not honest enough to show, because of what Z0D's spend rules do around the pull. The PM replay claim is also contradicted by the document's own gate table.
Totals: 0 BLOCKER, 5 MAJOR, 3 MINOR.

== VERIFIED OK ==
- The per-day model reproduces 09-21's measured 79 units (estimate.json anchor_0921).
- The day caps sum to 8,996,378, and 30.25 days × the regime figures are plausible. For example, at 420 ms: 205.7k slots plus the ±1 h margin gives 50–51 units, so about 249k point and 292.6k upper.
- The window (07-23..08-21 with lead-in 07-22) is post-BOOST, before the holdout, and outside W_R.
- The 09-21 reuse is dropped.
- The pump_fees claim holds. rpcscan/scan.go is a symlink to scanner/scan.go, whose :761-780 keeps only pump and AMM instructions.
- getTransfersByAddress is wallet-based (docs); the "MR holders cannot be rebuilt" claim stands.
- The admin usage endpoint exists. It authenticates with the same key (X-Api-Key or ?api-key) and is per project. Its credit cost is still VERIFY.
- The terms quotes match the text I fetched earlier (last updated 28 Sep 2026), and the owner question is fairly put.

== MAJOR ==

R2-01 MAJOR: the plan does not fit A-M14-05's 14-day B-10 window.
- SPEC-A A-M14-05 says the window [from,to) is "at most 14 days" and "the job sends only inside [from,to) and stops at to".
- RESULTS §3: reading takes 3.3–16.6 days plus about 23 h of QA. At the only measured rate (5 blocks/s), it overruns `to` and stops partway, with U counted in full for 31 days anyway.
- Minimum sustained rate needed: 7.19M blocks ÷ (14 d − 23 h) ≈ 6.4 blocks/s, including gaps between chained jobs. Without margin this is unproven.
- P10 (the throughput test, 12k credits) has no Helius allocation outside a B-10 window: the "B-10 job 0 credits" default applies. So P10 itself needs an ack or allocation.
- RESULTS never mentions the 14-day limit.
- Fix: make P10 a pass/fail gate, for example at least 8 blocks/s sustained and retries at or below 25%, or else no pull. State the 14-day limit and P10's own allocation path.

R2-02 MAJOR: after the pull the engine has no Helius for about 31 days, and paper is blocked. The owner summary is silent, and two claims are wrong.
- Under A-M14-05, U (about 9M) is "counted in full for 31 days". The default account cap returns to 5M after the window, so the engine's Helius allocation is 0. "M26 refuses paper or above until the engine's headroom is back above its floor" (1M).
- So for about 31 days after the window, M3 paper cannot start (DECISIONS:114 states this risk on #286).
- This collides directly with the owner's "Trading first" rule, and the owner is not told.
- Wrong in RESULTS: "leaves at least about 0.87M of the cycle's 10M". Under the rolling-31-day ledger, the engine cannot use it.
- Wrong in the summary: "the rest waits for next month". A second window needs S to fall: U = min(cap, 9.5M − S), and S includes the first U, so the rest waits about 31 days after the first window, not until 6 Nov. A second 30 days therefore pushes paper back another month.
- Fix: put the paper-blocked month(s) into the owner summary in plain words, and correct both claims.

R2-03 MAJOR: P1 diverges from the A-M14-05 contract. The owner steps and the U condition are missing.
- A-M14-05 already specifies the job's spend control:
  - the B10-ACK row, with exclusive=yes and a dashUsed reading no more than 3 days old;
  - `botctl b10-reserve` run by the owner on the host, or a tailnet path;
  - the Helius key placed by the owner as an Actions secret of the job's repo;
  - a ledger written ahead in chunks of at most 10k before pages are fetched;
  - a compare-and-swap lease with a 15-minute TTL in zeroed-data;
  - a missing ledger counting as the whole U spent;
  - an estimate cited with its file and sha;
  - "no partial runs: start only if U ≥ 1.1 × the estimate the owner saw".
- P1 is a different design: a per-run check with credits booked after each run, plus a Helius-usage tolerance. Two ledgers for one account would conflict.
- The arithmetic the owner needs:
  - 1.1 × 7.74M = 8.51M. That requires S ≤ 0.99M at reservation (U = 9.5M − S).
  - For U to reach the proposed 9.0M cap, S must be ≤ 0.5M.
  - If S is between 0.5M and 0.99M, U is below the 9.0M upper bound, so an early stop is possible.
  - S includes the engine's rolling Helius use in M1 and M2. Its size is not estimated.
- Fix: rewrite §7 as the Z-H prep implementation of A-M14-05; keep P2–P13 as additions. List the owner steps (b10-reserve or tailnet, the key secret, the B10-ACK message with the dashboard reading) in §1 and in the summary. State the S condition.

R2-04 MAJOR: honeypot_sim blocks PM too, so "PM-01 can be replayed with real gates" contradicts §5's own table.
- `honeypot_sim` is a HARD gate for every candidate (ARCH:2197 on #286: a buy-then-sell simulation, "hard").
- §5's table says: "Not possible in history | Replay rule needed".
- I found no replay or backtest rule for honeypot_sim anywhere in docs/blueprint on #286 (grep "honeypot" with replay, backtest or M11 found nothing).
- Fail-closed, then, every PM candidate is rejected as well, and PM B-10 is as empty as MR's.
- The §1 bottom line, the §5 verdict and the owner summary ("For the MR strategy …") all say only MR needs a ruling.
- Fix: state that BOTH universes need a replay-mode ruling (honeypot_sim; plus the holder gates for MR). Put it in the summary before any spend. Without the ruling, the pull buys a run that never trades.

R2-05 MAJOR: the cheapest window does not exercise the chain as it is today. The summary overstates what is proved.
- 07-23..08-21 is entirely pre-B3 fees and pre-B4 event layout, at about 420 ms slots.
- So B-10 never runs:
  - the post-B4 decoder path the live bot uses today;
  - the current fee regime;
  - any slot time near the live 267 ms (200 ms is due at epoch 1052).
- A hard-coded 400 ms bug (B1 class) would be invisible at 420 ms.
- "It proves the bot runs without crashing on real history" reads as proof against today's chain.
- Forward M07 data (gate B, A06 "both") covers the current regime, but the owner is not told that this was the trade-off for the lower price.
- Fix: one line in the summary ("old-format days; today's format is covered by the live recording"). Or offer the costed option of adding the newest clean days (09-18..09-21 cost about 384k a day, outside the 9.0M).

== MINOR ==

R2-06 MINOR: the summary also omits:
- the storage size (about 0.5–1.4 TB, which the owner must place);
- the reading time (3.3–16.6 days, inside a 14-day window).
And "9.0 million of this month's 10 million" implies the pull happens this cycle, but it cannot start before Phase 0 survival and the C-76 ruling (in practice M2). Say "a month's credits".

R2-07 MINOR: the extras are outside the cap.
- P10 (12k), P12 (up to about 1k), the MR age and config lookups (up to about 25k) and the admin-usage calls (cost VERIFY) are all outside the 9.0M, which equals the sum of the day caps.
- Inside one ledger, they leave the last day short. Outside it, they breach the cap.
- Fix: budget them inside U, or above it with their own allocation.

R2-08 MINOR: GitHub storage.
- GitHub releases have no stated total-size limit (supervisor-verified).
- Putting 0.5–1.4 TB, mostly raw Helius getBlock responses, in one private repo's releases may still meet GitHub's acceptable-use and excessive-bandwidth terms, and the replay downloads it all again. I have not confirmed this.
- It also raises the §3.2(ii)/(iv) question.
- Fix: VERIFY GitHub's acceptable-use terms before the owner names it the "$0 location" (#286 storage precondition).

Report time: 8 Oct 2026, about 1:50 AM Melbourne. Head unchanged at send: e686026777a914b60fcc0a81e8377722e9c95e59.

### Supervisor rulings for round 3 (8 Oct 2026, about 1:55 AM)

I accept every finding: the reviewer's N1–N3 and M1–M4, and the red team's R2-01..R2-08. The result must let the owner choose with the full picture. That includes what the pull would cost in paper-trading time.

1. **Fit with A-M14-05 (N1, R2-01, R2-03).** Rewrite §7 as the Z-H prep implementation of A-M14-05, as written on PR #286 @ e28dfab4. Do not build a second ledger. Keep P2–P13 as additions. State:
   - the 14-day window;
   - the S conditions: U ≥ 1.1 × the point estimate needs S ≤ 0.99M, and the full 9.0M needs S ≤ 0.5M;
   - what happens when S falls between those two values;
   - that a second window waits about 31 days after the first.

   P10 becomes a pass/fail gate: at least 8 blocks/s sustained, with retries at or below 25%, otherwise no pull. P10 needs its own small B10-ACK and allocation; name them.
2. **Replay mode for gates that can't be rebuilt from history (N2, R2-04).** State that both universes, MR and PM, need a replay-mode ruling. Here is my ruling; record it as pending the Z0D spec change, which I will raise:
   - In a B-10 run only, a gate whose input cannot exist in history (honeypot_sim, and holder state from before the window) receives a typed `replay_unavailable` value from the replay input provider.
   - A config key, valid only in replay mode with a B-10 trial key, treats that value as "assumed pass, flagged".
   - Config validation refuses that key in paper and live mode, and a test proves it.
   - Every decision taken under the key is tagged, and it is excluded from every edge statistic (B, R and P).
   - The engine code stays the same; only the input provider and the config differ.
   - fee_config_known and venue_enabled stay fail-closed until P12 is done.
3. **Storage (N3, R2-08).**
   - Add P14: upload per unit, then run the day-level finalize and QA from the store. Or measure the runner's real free space on /mnt and cite it.
   - VERIFY GitHub's acceptable-use and bandwidth terms for keeping 0.5–1.4 TB in a private repo's releases. Say what you could confirm and what you could not.
4. **The paper blackout (R2-02).** Under A-M14-05, after the pull the engine has no Helius for about 31 days, so M3 paper cannot start.
   - Put this in the owner summary in plain words.
   - Correct "leaves about 0.87M" and "the rest waits for next month".
   - Estimate the delay to paper trading for each option.
5. **Old-format days (R2-05).** Add one line saying the window uses old-format days. Today's format is covered by the forward recording. Also cost the option of adding the newest clean days.
6. **Extras (R2-07, M2).** Budget P10, P12, the MR lookups and the admin-usage calls inside U or under their own allocation. Give one total for all exposure.
7. **Minors.** M1: pin HANDOVER citations to `2b736a3c`. M3, M4, R2-06: storage size, reading time, and "a month's credits" rather than "this month's".
8. **Compare the options.** In §10, put side by side:
   - (b) the Helius pull: credits, time, paper delay, storage, the terms question;
   - Old Faithful: 0 credits, time, storage, politeness limits, and the exception it would need to "no bulk historical downloads";
   - (c) dropping the history part.

   For each, say what it proves and what it doesn't.
9. **Owner summary.** At most 8 short lines in plain words, covering the options above, with no recommendation. I will add the recommendation.

Push to the same branch, then send me the head sha and an item→section table.
