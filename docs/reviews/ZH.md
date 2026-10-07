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
