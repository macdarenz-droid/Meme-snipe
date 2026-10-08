# Shared on-chain tape: plan and blockers (2026-10-08)

From the advisor-six-ideas workflow, as corrected by its adversarial review. **Not started.** It needs owner and supervisor decisions; see the preconditions.

**Owner decision (2026-10-08, about 09:40 AEDT): "Yes shared tape."** This covers P0's owner question, the stepwise research pull, and the exception to the 2026-10-06 "no bulk historical downloads" rule for this plan only. P2–P5 still apply as written.

**P1 evidence so far (dashboard, owner screenshots).** 125,629 credits at about 2026-10-07T07:50Z and 675,408 at about 22:30Z: a rise of 549,779. Our ledgers logged at least 233,559 calls in between (audit 63,136; launch 140,741; absorption 11,880; squeeze 17,802; liquidation not yet counted). A flat 10 credits a call would need at least 2.34M, so it is ruled out. The average is at most 2.35 credits a call. Phase 0 still measures getBlock's own price. The owner waived the dashboard readings on 2026-10-08 ("Dont mind the how many per call ... we gonna use them anyway"), so P1 no longer needs them; the builder's per-method ledger is enough.

SHARED TAPE (corrected 2026-10-08 after adversarial review). One Helius full-block read per chain day, for research only. Nothing is read until P0-P6 hold.

PRECONDITIONS (go/no-go)
P0. Owner rules. Before any read, the current supervisor (SHITCOIN V2) records in docs/DECISIONS.md:
- that the owner's 2026-10-08 approval ('I dont mind u using credits on helius ... So use wisely', docs/research/edge.md §10.4) covers this stepwise research pull. This is given the owner's 2026-10-06 rule 'no bulk historical downloads; fetch only the minimum sample a test needs' (CLAUDE.md on claude/blueprint-migration, line 89).
- that docs/MIGRATION.md line 707 ('spend nothing new on Helius until the owner answers' Helius §3.2(xi)) no longer blocks it.
- The stepwise design below is the minimum sample. If the supervisor cannot so rule, the owner gets one question (a push under 200 characters, steps in chat), and nothing is read until he answers.
- that these are research reads. The Blueprint's history replay uses only data already held, with no new downloads or credits (owner, 2026-10-07 about 10:58 PM, A06 item 2), so no core benefit is claimed.
- that raw responses and derived tables stay private while §3.2(xi) is open (DATA-PUB).

P1. Price per getBlock.
- Helius docs (credits page fetched 2026-10-07, scratchpad/six/dl/helius_credits.md line 145): archival calls cost 1 credit. research/execution-audit/heli.py line 18 counts 10.
- Phase 0 runs while no other process uses the key. The absorption probe is paused, or its own ledger delta for the same interval is subtracted.
- The owner reads the dashboard at least 15 minutes before and after Phase 0 (a login).
- A delta within ±20% of the calls sent means 1 credit: continue. About 10 × the calls means cancel every Helius step (Phase 1 would cost about 24-29M).
- 'Past spends were 10 times too high' holds only for 1-credit methods (getBlock, getTransaction, getSignaturesForAddress). It does not hold for getTransactionsForAddress or getProgramAccounts. The absorption probe's methods are not in the repo, so its real spend comes from the dashboard.

P2. One source per day (ARCHIVE-NODUP).
- Each day is added to HELIUS_DAYS (research/historical/ci/archive-limits.conf) by a reviewed supervisor change before its read.
- The supervisor accepts in writing that such days can never be published (DATA-PUB).
- Before each day: if a data-day release exists for it, that release is used at 0 credits instead.

P3. Private storage: zeroed-data (ops/README.md lines 143-152).
- DATA_STORE_TOKEN is an Actions secret. The builder session first checks write access through the Claude app.
- If access is missing, owner step 4 of that README is the second owner step.
- Never the public repo.

P4. Rate (owner rule).
- At most 25 requests a second for all users of the key together (50% of the Developer plan's 50).
- Retry-After honoured; a resumable stop after 3 consecutive 429 or 403 answers.
- The roughly 3M recorder and bot reserve and the absorption probe's cap stay untouched.

P5. Windows and outcome tails.
- Every day read is before the wall (2026-09-21T14:00Z).
- It is outside U1-B's holdout (09-12..09-21, prereg 625e6e6, read at most once).
- It is outside the sealed window (2026-09-22 to the 10-20 entry cutoff, tail exclusive 10-21; packages/core/src/config/research.ts).
- A decision whose outcome window would end after the last day read is dropped by time, before any outcome is read.
- The supervisor confirms the absorption probe's windows.

P6. Reviewer family. research/IDEA_BOARD.md gains a 'Reviewer family' section before Step A.
- Members (k = 10; idea 2 dropped): the absorption probe; squeeze, theme leader, multi-token liquidation, first spot listing; ideas 1, 3, 4, 5, 6.
- Stage-1 screens use their own 95% rules.
- Every confirmatory test (each stage 2, and idea 6's primary) uses Bonferroni 0.05/10: a 99.5% two-sided CI, with the 95% CI also reported, and n = max(300, n_power at that level).
- At most one idea per universe goes on to a core holdout (precedent: DECISIONS line 453).

HOW ONE READ SERVES BOTH (no scanner or rpcscan change)
- The standard rpcscan binary, built from the unchanged scanner and rpcscan trees, runs as ci/rpc-day.sh runs it. The one difference: its existing -helius-url flag (research/historical/rpcscan/helius.go line 50) points at a loopback tee on 127.0.0.1.
- The tee holds the real key; rpcscan gets a non-empty placeholder.
- It forwards each request and returns headers and bodies unchanged, 429 and Retry-After included.
- It enforces P4 and never logs a URL or query string.
- It records sha256 and byte totals, and hands a decompressed copy of each getBlock body to the research decoder.
- Result: the core units keep their revision label (historical-data.md line 269), the paid 09-21 progress cache stays valid, and each block is read once.
- Identity holds by construction: the tee's hashes and byte totals must equal rpcscan's own counters.
- The research decoder uses the scanner's IDLs and decoders read-only, through symlinks as rpcscan does.

STEPWISE PULL (newest first; a day is read whole or not at all)
- Phase 0: the first unit of 2026-09-11 (4,500 slots), kept as part of Step A. It measures:
  - P1;
  - bytes per block;
  - blocks a second and 429s at 10 and 25 requests a second;
  - decode CPU;
  - rows per table per unit;
  - F and W sizes.
- Step A: 09-11 and 09-10. Then idea 4's Stage 0 and idea 5's reach-rate pre-gate.
- Step B: 09-09, 09-08 and 09-07, only if idea 4 passes Stage 0 or idea 5 passes its pre-gate. Then idea 5's full gates (decision days 09-10 and 09-11).
- Step C: 09-02 to 09-06, only if one of these holds:
  - idea 4 passes Stage 0;
  - idea 5 passes its full gates;
  - another family idea's registered gate needs these days.
- Ideas 6 and 1 never justify a step on their own.
- If fewer than 10 days are read, every primary that needs 10 days moves unchanged to Phase 2.

CREDITS (1 per getBlock)
- 4,844 calls per 4,500-slot unit with retries (09-21: 319,730 for 66 units; HANDOVER.md on origin/ccr-14987baf-i6lrsl).
- Slot rates from research/historical/regimes.json: 07-21 to 09-09 averaged 382 ms (about 226k slots a day); 09-09 to 09-12 averaged 317 ms (about 273k). 09-21's 79 units came from faster slots, so 355-385k a day overstates these days.
- Phase 1: about 244k-294k calls a day, about 2.4-2.9M in all (Step A about 0.6M, B about 0.8M, C about 1.3M).
- Hard cap 3.4M, below the 3.8M unallocated.
- A day starts only if 1.15 × its slot count (from getBlocks, 1 credit a call) is left under the cap.

RUNTIME
- About 2.7-3.3 h of requests per day at 25 a second. Unmeasured on Developer; Phase 0 measures it.
- Testdata blocks are 2.1-2.5 MB of JSON, so bandwidth may bind.

DISK
- Core units: about 63 MB each (09-21: 66 units = 4.19 GB), so about 3.2-3.9 GB a day at September slot rates.
- Research tables: an estimated 1.5-4 GB a day (±50%), measured in Phase 0.
- 27 GB was free in this session (df).
- At most one finished day plus the day in progress stays local. A finished day is uploaded and read back (sha256) before the next-but-one starts.
- The run stops resumably below 8 GB free.

BUILD (one builder card, a fresh data review and a red team)
- The tee, the research decoder and the uploader.
- Tests:
  - bodies pass unchanged (sha256);
  - a canary key never appears in any log or file;
  - the 3-failure stop works;
  - the credit cap stops resumably;
  - decoder counts on the 3 testdata blocks match an independent count (this review's recount: 2,951 transactions, 226 failed, 154 calling pump or PumpSwap, 12 of those failed, 5 slippage failures, 3 truncated logs). Counts only: those blocks are inside the sealed window.
- Red team (owner rule, CLAUDE.md line 89): key leakage, credit overrun, partial days, table keys and look-ahead.
- The supervisor reviews the new data shapes (F, W, O and the S additions) under CLAUDE.md 'Stored data': public chain data only, no off-chain identity joins, private storage.

SCHEMA (raw integers, lamports for SOL; rows keyed by slot, tx_idx, outer_ix, inner_ix)
- S swaps: every bonding-curve trade and every PumpSwap pool trade, all coins. Fields:
  - block_time, venue, pool_or_curve, mint, quote_mint, side;
  - base_amount, quote_amount;
  - fee parts: lp, protocol, creator, buyback, cashback, holder_rewards;
  - reserves_before base and quote, virtual_quote;
  - user, signer, owner (= user_token_owner);
  - owner_token_pre/post and signer_sol_pre/post (new);
  - top_program, tx_fee, cu, jito_tip, ix_name;
  - flags: canonical, boost, mayhem, protocol (boost_buy_and_burn, or a buyback authority such as GmFrDZT2…);
  - signature.
- F failed (new): every failed transaction that calls pump or PumpSwap. Fields:
  - block_time, signer, venue, pool_or_curve, mint;
  - the failing ix_name, side, amount_arg, limit_arg;
  - err_ix, err_code, err_program (the innermost 'Program X failed' log line), err_source_path;
  - err_class: slippage, insufficient funds, liquidity, arithmetic, account or constraint, state, compute, cyclic arbitrage, other program, or unclassified (the log is truncated or has no failure line);
  - n_swap_legs, top_program, tx_fee, cu, jito_tip, signature.
- T movements and D delegations: as today.
- W: SOL system transfers of at least 0.05 SOL outside pump instructions. Kept only if Phase 0 shows 1 GB a day or less.
- C creates; G migrations and pool creations; B blocks with n_pump_failed.
- H hourly census: readable only after its hour closes.
- O: other-venue coverage per 'pump' coin and hour.

USERS
- Idea 4: S, F, G, B. Stage 0 on Step A; the primary on all 10 days.
- Idea 5: S, C, G, W. Pre-gate on Step A, gates after Step B, futility after Step C; the primary in Phase 2.
- Idea 6: C, G, S. Training and futility only if Step C was read for idea 4 or 5; the test in Phase 2.
- Idea 1: S, O, T. Stage 0 counts only if Step C was read.
- The multi-token liquidation scout (S, T), if it is registered in the family.

PHASE 2 (a later cycle; nothing now)
- Window: decision days 2026-10-22 to 11-04, plus 11-05 read as an outcome tail (15 days), read once.
- When: only after every Phase 2 prereg and stage-2 registration is committed, and only if idea 4 is a material PASS or UNRESOLVED, or idea 5 passes its futility check.
- Extra preconditions:
  - (a) the Developer plan is active in the 6 Nov-6 Dec cycle;
  - (b) a reviewed research decoder that fails closed. The plan job and publish-day.sh refuse days on or after 10-02, and the strict QA fails on any pump discriminator beyond the three seen on 10-02 (historical-data.md lines 215 and 245). So a pool-day with an unknown trade layout, or a reserve chain that does not rebuild, is excluded whole and counted. If more than 10% of pool-days would be excluded, the fallback is used;
  - (c) the supervisor rules which source reads these days, once.
- Credits: mainnet slots measured about 268 ms on 2026-10-07 (one public RPC getRecentPerformanceSamples call, 60 one-minute samples), about 347k calls a day. 200 ms slots are scheduled (edge.md line 264, unverified), which would be about 465k a day. 15 days cost about 5.2-7.0M; the cap is set from getBlocks counts at the time.
- Fallback block if (b) or (c) fails: 2026-08-19 to 09-01 (14 days, pre-wall, about 3.4-3.7M at 350-382 ms). Outcomes of 09-01 end inside the already-read 09-02.
  - No failed-transaction, community, cohort or text measure was computed on these days.
  - They are before B3, B4 and B5, so a pass there needs a post-B5 check before any strategy registration.
  - Idea 6 can only be killed there.
- Both phases' windows are recorded as used research windows: in docs/DECISIONS.md now, and in the Blueprint trial registry (A-M13-02, E_WINDOW_OVERLAP) once it exists. Then no strategy whose rules or thresholds come from these results is gated on an overlapping window. Zeroed's holdout registry has no research-read field, and its attempt-2 window is fixed by rule (DECISIONS line 304).

FALLBACK if P0-P4 fail
- No Helius read.
- The archive route needs a scanner change (a new revision), so it waits for the supervisor. No date is promised.

## Review issues

- **blocking** (Shared tape (all ideas)): The plan breaks standing owner rules it does not cite. The current CLAUDE.md (claude/blueprint-migration, line 89; owner 2026-10-06) requires every external read to stay at or below 50% of the provider's documented limit, honour Retry-After and stop after 3 failures. The same line says 'no bulk historical downloads; fetch only the minimum sample a test needs'. The plan pulls all 10 days unconditionally. It tests 40 rps in Phase 0 (80% of the Developer plan's 50/s) and plans 25-40 rps. It relies on rpcscan's 15-minute back-off budget (helius.go), not a 3-failure stop. docs/MIGRATION.md line 707 on the same branch also says to spend nothing new on Helius until the owner answers the Helius §3.2(xi) question. The owner's 2026-10-08 approval ('use wisely', edge.md §10.4) covers credits, but does not say it lifts the bulk-download rule. Fix: Add precondition P0: the current supervisor records in docs/DECISIONS.md that the 2026-10-08 approval covers this research pull and that MIGRATION line 707 no longer blocks it. Otherwise the owner gets one question and nothing is pulled. Make the pull the minimum sample. Phase 0, then Step A (09-11, 09-10), then Step B (09-07..09-09) only if a registered pre-gate passes, then Step C (09-02..09-06) only if a full gate passes. Cap the rate at 25 requests/s for all users of the key together, and measure at 10 and 25 rps only. Honour Retry-After, and stop resumably after 3 consecutive 429 or 403 responses (the tee enforces this).
- **blocking** (Shared tape (all ideas)): The build cannot meet its own constraints. A 'research sidecar inside the rpcscan run' has only two forms:
- It edits rpcscan. That changes the RPC unit revision (<scanner tree>+rpc<rpcscan tree>, ci/rpcscan-rev.sh; historical-data.md line 269), so cached units, including the paid 09-21 progress cache, get rescanned.
- It is a separate binary. That needs a second getBlock read (double credits) or writes units that are not core-standard.
Byte-identity on 3 testdata blocks does not prove identity over about 2.5M blocks. Fix: Run the unchanged rpcscan binary exactly as ci/rpc-day.sh runs it. Point its existing -helius-url flag (research/historical/rpcscan/helius.go line 50) at a tee on 127.0.0.1. The tee:
- holds the real key; rpcscan gets a placeholder;
- forwards each request and returns headers and bodies unchanged, including 429 and Retry-After;
- enforces the 3-failure stop and never logs a URL;
- records sha256 and byte totals, which must equal rpcscan's own counters;
- hands a decompressed copy of each body to the research decoder.
The result is one read per block, an unchanged revision, and identity by construction.
- **major** (Shared tape (all ideas)): Precondition 2 is written for the old core. The Zeroed worker is frozen and the Blueprint is now the main project (HANDOVER.md top section, origin/ccr-14987baf-i6lrsl). The owner's A06 item 2 decision (2026-10-07 about 10:58 PM; CLAUDE.md line 86) says the history replay uses data already held, with no new downloads or credits. So 'the core backtest gets 10 more pre-wall standard days' is not a valid justification. Listing these core-window days in HELIUS_DAYS also makes them unpublishable for good (DATA-PUB). Fix: The current supervisor (SHITCOIN V2) rules on the HELIUS_DAYS change and accepts in writing that the days become unpublishable. Drop the core-benefit claim. Before each day, check for a data-day release; if one exists, use it at 0 credits.
- **major** (Shared tape (all ideas)): The P1 price check cannot tell 1 credit from 10 as designed. The absorption probe runs on the same key, so the dashboard delta around Phase 0 (about 4.5k calls) is confounded, and the dashboard may lag. The plan also says past counted spends, including the absorption probe's 4M cap, were 10 times too high if the price is 1. That holds only for getBlock, getTransaction and getSignaturesForAddress (the methods execution-audit and launch-probe used). It does not hold for getTransactionsForAddress (10 per 100 returned transactions) or getProgramAccounts (10). The absorption probe's methods are not in the repo. Fix: Run Phase 0 with every other Helius user paused, or subtract their own ledgers for the same interval. The owner reads the dashboard at least 15 minutes before and after. A delta within ±20% of calls sent means 1 credit; about 10 × calls means cancel. Restate headroom per method. Supporting but not decisive evidence: the 7 Oct dashboard showed about 126k of 10M used (HANDOVER §2).
- **major** (Phase 2 (ideas 4, 5, 6)): Phase 2 as written cannot be decoded or scored, and it is under-costed.
(a) The plan job and publish-day.sh refuse days on or after 2026-10-02. The strict QA fails on any pump discriminator beyond the three seen on 10-02 (historical-data.md lines 215 and 245).
(b) The last decisions' outcome windows run past 11-04 24:00Z, which is not in the tape (idea 5: up to 2 h + 6 h; idea 6: 15-60 min).
(c) Credits: 5.0-5.4M assumes 09-21's rate. Mainnet slots measured about 268 ms today (one public RPC getRecentPerformanceSamples call, 60 samples, 2026-10-07 16:35 UTC), which gives about 347k calls a day. The scheduled 200 ms slots (edge.md line 264, unverified) would give about 465k. 15 days would cost about 5.2-7.0M. Fix: Phase 2 = decision days 10-22..11-04, with 11-05 read as an outcome tail. Add three preconditions: the Developer plan is active next cycle; a reviewed research decoder fails closed (a pool-day with an unknown trade layout or a broken reserve chain is excluded whole and counted; if more than 10% are excluded, use the fallback); and the supervisor rules on the one source. Fallback block 2026-08-19..09-01 (pre-wall, about 3.4-3.7M): valid for ideas 4 and 5, but a pass needs a post-B5 check; idea 6 can only be killed there.
- **major** (Ideas 4, 5, 1, 3): Outcome windows cross the tape end into U1-B's holdout (09-12..09-21, read at most once; prereg 625e6e6, HANDOVER line 593):
- idea 4's last windows on 09-11 score into 09-12;
- idea 5's late 09-11 decisions score up to 8 h into 09-12;
- idea 1's 18:00Z sample on 09-11 ends at 00:05Z on 09-12;
- idea 3's stage-2 holdout (07-01..09-19, candles to 09-20) reads agent-coin prices inside U1-B's holdout. This contradicts the plan's own precondition 5. Fix: Global rule: a decision whose outcome window would end after the last day read is dropped by time, before outcomes are read. Idea 1: the last h_end is 09-11 12:00Z. Idea 3: holdout decision days 07-01..09-10, outcomes by 09-11, every request bounded before 2026-09-12T00:00Z, and rows from 09-12 on dropped before saving.
- **major** (All ideas (reviewer family)): There is no multiple-testing control across the reviewer's ideas now in flight. That is about 10 confirmatory tests, each at 95%:
- the absorption probe;
- the four ideas scouted elsewhere (squeeze, theme leader, multi-token liquidation, first spot listing);
- ideas 1, 3, 4, 5 and 6.
The repo's precedent treats pre-registered ideas as one family and sends at most one per universe to a holdout (DECISIONS line 453, RES-4). A false research pass burns a scarce core holdout attempt (holdout.ts: α 0.04, then 0.01/2^(k−1), each on a new 28-day window). Fix: Add a 'Reviewer family' section to research/IDEA_BOARD.md before Step A, with k = 10. Stage-1 screens keep their 95% rules, since they only release more data. Every confirmatory test (each stage 2, and idea 6's primary) uses Bonferroni 0.05/10: a 99.5% two-sided CI, with the 95% CI also reported, and n = max(300, n_power at that level). At most one idea per universe goes to a core holdout.
- **major** (Ideas 4, 5, 1, 3): A stage-1 PASS needs only a CI above zero. An economically trivial effect would then release Phase 2 (5-7M credits) and builder time. Edge.md §10.1 found that public signals add about a tenth of the toll, which is exactly the failure this screen should catch. For idea 4, the outcome includes the failed wallets' own retries, so a positive coefficient is close to mechanical. Fix: Add a materiality condition, fixed now, to every stage-1 PASS. The implied price effect of moving from the median to the 90th percentile of the signal must be at least the median estimated $50 round-trip cost at decision, for the units the stage-2 rule would enter. Under constant product, a net inflow ΔY of the quote reserve moves the price by about 2ΔY; for idea 3 the coefficient is already a return. A CI above 0 that is immaterial counts as KILL (immaterial). Idea 4 also reports Y with the window's failed signers excluded.
- **major** (5 Community crossing): The matching cannot work as written. Four quintile variables, a known-share tercile and a 4-hour bucket give 1,875 cells per bucket, against about 600 candidates a day. Nearly every stratum would lack one arm and be dropped, so the 200-per-arm rule fails by design. '4-hour UTC bucket' is also ambiguous: read as time of day pooled across days, it leaves day-level market rallies uncontrolled. Fix: Strata = calendar 12-hour UTC block × terciles of net SOL inflow, log price change and minutes from migration to decision. That is 27 cells per block, about a dozen candidates each. Cut points come from Phase 1 and are frozen before Phase 2. Curve-phase buyer count and known share move to a regression-adjusted secondary with calendar 4-hour fixed effects.
- **major** (Ideas 4, 3, 1 (regression primaries)): The regression primaries rely on CR1 with t_{N−1} over about 10-20 day clusters. The repo's few-cluster study (header of packages/core/src/stats/bootstrap.ts) found t_{N−1} intervals above nominal error in some cells and adopted the wider of bootstrap-t and t_{N−1}. The plan's claim that the regressions follow those conventions is therefore wrong. Fix: The interval for the key coefficient is the widest of: day-clustered CR1 with t_{N−1}; two-way CR1 with t_{N−1}; and a wild cluster bootstrap-t by day (Webb six-point weights, 9,999 replicates, seed 20261008; Cameron, Gelbach & Miller 2008, as cited in bootstrap.ts).
- **major** (Stage 2 of ideas 1, 3, 4, 5 and idea 6's primary): The owner rule 'Size is not the trial' (2026-10-07 about 6 AM; CLAUDE.md line 50 on claude/blueprint-migration) requires every strategy result at $5, $20, $100, $1,000 and $10,000 at least, with gross return, fixed costs, percentage fees and price impact from real depth shown separately. The plan reports $50 only. Fix: Keep $50 as the registered primary. Add the size table to every stage-2 registration and to idea 6's primary report, with impact computed from pre-trade reserves at each size.
- **major** (Shared tape (all ideas)): The disk plan does not fit. Up to 3 days stay local, each with core units (3.2-5 GB) and research tables (1.5-4 GB, an estimate), so up to about 27 GB. That equals all free space in this session (df: 27 GB available), before build caches and in-flight data. Fix: Keep at most one finished day plus the day in progress locally. Upload each finished day to zeroed-data and read it back (sha256) before the next-but-one day starts. Stop resumably below 8 GB free.
- **major** (Shared tape (Phase 2 hygiene)): The plan says Phase 2's days are 'declared to the STATS-1 holdout registry as research-read, so a later core holdout avoids them'. No such mechanism exists:
- holdout.ts and the registry have no research-read field;
- Zeroed's attempt-2 window is fixed by rule (first whole UTC day after registration, 28 days; DECISIONS line 304), not chosen to avoid days;
- under the Blueprint the guard is the trial registry with E_WINDOW_OVERLAP (MIGRATION B3, A-M13-02/05), which is not built yet. Fix: Record both phases' windows as used research windows in docs/DECISIONS.md now, and in the Blueprint trial registry once it exists. Then no strategy whose rules or thresholds come from these results can be gated on an overlapping window.
- **major** (All ideas (process)): An owner rule (2026-10-06, CLAUDE.md line 89) says every finished task is attacked by a red team before the supervisor approves it. The executor notes name fresh reviewers only. Fix: Add a red-team pass to the tape build (key leakage, credit overrun, partial days, table keys) and to each probe before its primary or Phase 2 read (feature/outcome separation, look-ahead, the leak test).
- **minor** (Shared tape (credits)): Phase 1 credits come from 09-21 (79 units a day, fast slots), but early September was slower. From research/historical/regimes.json, B2→B3 averaged 382 ms (about 226k slots a day) and B3→B4 317 ms (about 273k). At 4,844 calls per 4,500-slot unit, Phase 1 is about 2.4-2.9M, not 3.55-3.85M. The 3.85M cap also exceeds the 3.8M unallocated. Fix: Estimate 2.4-2.9M and cap at 3.4M. A day starts only if 1.15 × its slot count (from getBlocks, 1 credit a call) is left.
- **minor** (4 Failed transactions): Taking the failing program as 'the last inner instruction under the failing top-level instruction' can misattribute when a successful CPI precedes the failing check. An inner token error also passes up as the caller's custom 1 (seen twice for PumpSwap in testdata). This review's recount of the testdata:
- 2,951 transactions, 226 failed;
- 154 call pump or PumpSwap, 12 of them failed;
- 5 slippage failures (pump 6002 ×1, PumpSwap 6040 ×3 and 6004 ×1);
- 3 transactions with truncated logs. Fix: Use the innermost 'Program X failed' log line. A truncated log, or one with no such line, is 'unclassified': excluded and counted. Stage 0 requires unclassified at most 5%.
- **minor** (4 Failed transactions): The exclusion list mixes the two programs' code tables. Pump 6021/6023 are NotEnoughTokensToBuy/Sell and 6024 is Overflow; PumpSwap 6021 is DisabledSell, 6023 Overflow and 6024 Truncation (IDLs). PumpSwap's boost_buy_and_burn (protocol flow) is excluded from neither the failed nor the successful flow. Fix: Use per-program tables. Every code not on a slippage list is excluded and counted by class. Protocol instructions (boost_buy_and_burn, buyback updates, admin) are excluded from F and from the outcome flow.
- **minor** (4 Failed transactions): Four smaller defects:
- D names both the signal and the number of days.
- The B3 regime indicator is collinear with the window fixed effects.
- Pools created before the tape have no known age.
- The flow outcome is heavy-tailed. Fix: Call the signal I(p,w) and the day count N. Drop the regime indicator and report I × regime as a secondary. Give pre-tape pools age = time since tape start (a lower bound) plus an indicator. Clip Y to [−0.5, 0.5].
- **minor** (4 Failed transactions): The stage-2 sketch has four gaps:
- It does not say whether stage 2 counts when the Phase 2 confirmation fails.
- Repeated entries in the same pool during a hold double-count.
- The 15-minute hold does not match the 5-minute stage-1 horizon.
- The 90th percentile of the signal can fall on a mass point. Fix: Stage 2 counts only with a Phase 2 confirmation PASS. Allow one open trade per pool. Exit at the first swap after entry + 300 s, with 15 minutes as a secondary. Entries need I at or above the 90th percentile and FB ≥ 2.
- **minor** (6 SOLMEMES replication): Three problems:
- Graduates created before the tape start, or less than 48 h after it, have truncated curve-phase features and copy-saturation counts.
- The selection threshold is the 90th percentile of in-sample train predictions, which differ from out-of-sample predictions.
- On a pre-wall fallback block, the test would run earlier than the training data. Fix: Eligible graduates are created at least 48 h after the tape start and exit inside the tape. Take the threshold from forward-chained out-of-fold train predictions. A fallback-block test can only KILL or stay UNRESOLVED.
- **minor** (3 Buybacks): The PB control uses GeckoTerminal daily volume, but whether that volume is in SOL or USD with currency=token is unverified; the saved response (scratchpad/six/i3/gt/top1_ohlcv.json) does not label it. A USD volume would bring SOL/USD moves into a control. Fix: Before Stage 1, confirm the unit from the API docs, or by comparing one coin-day with on-chain volume. Use SOL and record which.
- **minor** (1 Audience gains): Two problems:
- The coverage check's 28-day getTransactionsForAddress window has no bounds, so it could read U1-B holdout or post-wall days.
- The Helius fallback estimate (15.6-17M in the prereg, 19M in the ranking) uses the fast-slot rate. Repo slot rates for 07-21..09-09 (382 ms) give about 244k calls a day, so about 10.7M for the 44 extra days. Fix: Bound blockTime to 2026-08-15T00:00Z..2026-09-12T00:00Z. Restate the fallback as about 10-12M: still beyond the cycle, needs owner approval, not requested.
- **minor** (1 Audience gains (ranking text)): 'The cited evidence points the other way' overstates Sun's Table 7 (re-checked in scratchpad/six/sun/sun.txt). The realised (sell) coefficient, −0.0022, has SE 0.0045, so it is imprecise, not opposite. The significant effect is the holders' 0.0061 (SE 0.0021). Fix: Say the paper found the effect for holders and no significant effect for sellers (imprecise), at a monthly, asset-class horizon. The prior stays low.
- **minor** (Ideas 1, 3, 4, 5, 6 (costs)): The cost lists give 414,009 lamports of fixed cost and then rent (1,513,840, refunded 85.5%) as a separate line. The 414,009 already includes the expected 14.5% rent loss and the failed exit attempts (edge.md line 156), so a literal reading counts rent twice. Fix: State that 414,009 lamports is the full expected fixed cost per round trip, rent loss included.
- **minor** (Shared tape (stored data)): The new table shapes (F, W, O, owner token pre/post, signer SOL) add wallet-to-wallet linkage. CLAUDE.md 'Stored data' requires the supervisor to review new data shapes. Fix: The supervisor reviews the shapes before the build merges. Public chain data only, no off-chain identity joins, private storage only.
- **minor** (4 Failed transactions): The live path has no cost estimate. logsSubscribe gives no signer for failed transactions, so each one needs a getTransaction, and the repo measured the full pump stream at about 14M credits a month (data.md line 15). Fix: Stage 0 also counts slippage failures per day in eligible pools. Any stage-2 registration states the live credits per month; above the plan's headroom it needs the owner's budget.
- **minor** (Shared tape (storage)): Storage access is unchecked. DATA_STORE_TOKEN is an Actions secret, so a builder session can write to zeroed-data only through the Claude app, which may need owner step 4 in ops/README.md. Fix: The builder checks write access first. If access is missing, that step becomes the second owner step.
- **minor** (6 SOLMEMES replication): IPFS gateways returned 429 and 1015 to the scout. A fixed 1 request a second may exceed a gateway's documented limit, and the owner's 50% and 3-failure rule applies. Fix: Stay at or below 50% of each gateway's documented limit, or 1 request a second where none is documented. Honour Retry-After, drop a gateway after 3 consecutive failures, log every failure, and never use a pump.fun host.
- **minor** (3 Buybacks (scout process)): The scout fetched one pump.fun docs page (tokenized-agent-disclaimer) despite the owner's no-pump.fun-requests rule (2026-10-07 about 9:25 PM). Fix: Record the fetch in the research log. Cite only press and on-chain sources, and never fetch that page again.

## Ranking (planner)

1. 4 Failed transactions as hidden demand (slippage-failed buys vs sells per completed 5-min window) (run_now=True): Uses information no candle and no earlier test had: who tried to trade and failed. It is measured exactly from full blocks and costs zero extra credits on the shared tape (one extractor, about 2 builder days). It is the only idea whose primary can be decided on Phase 1 alone (10 day clusters, which meets MIN_DAYS = 10 in packages/core/src/stats/g2rule.ts), and a counts-only density gate can kill it before any outcome is read. The evidence is weak. The cited paper (Zheng, Wan, Lo, Xie, Yang, PACMSE 2(ISSTA):1489-1512, 2025, DOI 10.1145/3728943) is a failure taxonomy from Aug 2023 to Jul 2024 and says nothing about demand or prices. Bots cause most failures: in repo testdata, 112 of 124 failed pump-mentioning transactions failed before reaching pump. Slippage failures may only echo the price move, which is the reviewer's own kill condition.
2. 5 Community crossing (new buyers from previously separate wallet communities vs one recurring circle) (run_now=True): It has the best literature support of the six, though only by analogy. Weng, Menczer and Ahn (Sci Rep 3:2522, 2013; ICWSM 8:535-544, 2014; both opened by the scout) found that early spread across communities predicted hashtag popularity, at about 7 times random precision in 2013. But their communities were follower (exposure) networks, ours would be wallet co-purchase groups, and their outcome was popularity, not price. The test costs zero extra credits on the shared tape. A counts-only known-share gate and a Phase 1 futility check can stop it cheaply. The primary needs Phase 2 (11 decision days, next credit cycle), because Phase 1 leaves only 7 decision days after the 3-day lookback. It needs a graph library, which needs the supervisor's OK.
3. 6 SOLMEMES replication (time/market baseline vs + creation-time text + copy saturation) (run_now=False): It costs zero extra credits on the shared tape and allows a clean, well-powered out-of-time test: train on Phase 1, then test on 12 Phase 2 days six weeks later, against the 6 days the reviewer reports for the paper. But its prior is the lowest of the testable ideas. The paper is real (Crossref DOI 10.1145/3789982.3790023, AICCC 2025, pp. 320-328), but its full text is closed, so its claims are unverified. Its public dataset pairs each mint with another coin's name and text (0 of 30 matched), and its code repo returns 404. Text is public at creation, the class of public signal that adds about a tenth of the toll (edge.md §10.1); social links and creator history showed no separation in earlier tests. The PREREG is committed now so it is frozen before any Phase 1 data exists. The build starts only when Phase 2 is approved, and this idea alone does not justify Phase 2.
4. 3 Revenue-funded buybacks (pump.fun Tokenized-Agent coins) (run_now=False): This is the cheapest independent test: at most 0.17M credits at the documented getTransactionsForAddress price, about 10 h of GeckoTerminal calls and about 2 builder days. The treatment is exact: 75,746 SOL of on-chain buybacks, each recorded with the SOL it spent. But the evidence and the value are both small. The buybacks are funded mostly by the coin's own creator fees (only 781 SOL came from invoice payments), so they amount to at most 0.95% of the coin's own volume, below a 1-2.5% round-trip toll. The reviewer's examples do not apply: FLOKI is not a Solana coin, and Keyrock studies 12 DeFi protocols and does not test whether buybacks predict returns. The flow is nearly gone: new agent coins stopped on 2026-06-30, and the buyback authority now makes about 35-40 transactions a day, so even a pass would give almost no live trades. The prereg is ready; run its Stage 0 counts only when a builder would otherwise sit idle.
5. 1 Audience gains (a meme's recent buyer cohort realises SOL gains in other coins) (run_now=False): The cited evidence points the other way. Sun (2023 working paper, opened by the scout) found the spillover for holders of a random NFT gain (+0.0061, p<0.01) and none for minters who sold and so realised the gain (-0.0022, not significant). That was at a monthly horizon and for lottery-like crypto as a class, not a specific coin within 6 h. A powered stage 1 needs 54 consecutive pre-holdout days of per-owner trades. They are free only if the archive publishes them, and none is published (the archive was refusing the scanner as of 2026-10-07). Otherwise they cost about 19M Helius credits, beyond this cycle, which needs owner approval. Live use would also need the full pump trade stream, which the repo measured at about 14M credits a month. Stage 1 is pre-registered now; only zero-cost feasibility counts run on the Phase 1 tape.
6. 2 Incentive-expiry short (perp short after a documented temporary holding requirement ends) (run_now=False): It fails its own kill rule: too few events to short. Only TRUMP has published holding-contest terms and a tradable perp. Before the wall there are 2-3 clean cutoffs (E1 2025-05-12, E2 2026-04-10, E3 2026-07-01 uncertain). Later contests roll into the next one with score carry-overs, so they are not true expiries. Three events can detect only a 24-hour abnormal move of about 5-9%, and the 300-trade gate can never be reached. Time-weighted scoring let holders sell before the cutoff (Arkham, 2025-05-02). Perps remain an open owner decision (edge.md line 180), and Australian legality is unconfirmed. Liebi's 'Raining Cryptos' measures price drops when a coin's holders receive new tokens (forks and airdrops), the class the reviewer excludes. Drop it.

## Not now

- Idea 2 (incentive-expiry short): drop as a strategy, with no logging work. Only TRUMP qualifies, with 2-3 clean pre-wall events and at most 6 by Feb 2027. The 300-trade gate is unreachable. Perps remain an open owner decision (edge.md line 180), and Australian legality is unconfirmed.
- Idea 1 confirmatory stage 1: waits for archive days 2026-07-20..09-11 (none published as of 2026-10-07). The Helius alternative costs about 15.6-17M credits beyond the cycle (owner approval, about US$75-85 at US$5/M). Not recommended at this prior.
- Idea 1 coverage check (getTransactionsForAddress on 1,000 owners, at most 0.45M credits): only after its Stage 0 gate passes and the archive days are queued.
- Idea 1 all-DEX balance table inside the core archive scanner: a core-owned scanner revision change. Not now; the shared-tape sidecar covers Phase 1 days without moving the scanner revision.
- Idea 3 (buybacks): prereg ready. Run only when a builder would otherwise be idle, Stage 0 counts first. PUMP and BONK buybacks are never tested (one token each; funded by the same meme-market activity the controls measure).
- Idea 6 build: prereg committed now. The build starts only when Phase 2 is approved, and idea 6 alone does not justify Phase 2.
- Shared-tape Phase 2 (2026-10-22..11-04, about 5M credits, next cycle): only if idea 4 passes or is unresolved, or idea 5 survives futility, and only after all Phase 2 preregs and stage-2 registrations are committed.
- Shared-tape Phase 1 itself: blocked until the owner's Helius dashboard confirms 1 credit per getBlock (Helius docs say 1; repo ledgers count 10; at 10 per call the pull is cancelled), the supervisor rules the read is the core's read of those days (ARCHIVE-NODUP), and durable private storage exists (DATA-STORE).
- Stage-2 trade tests for ideas 1, 3, 4 and 5: registered only after a stage-1 PASS.
- Live data paths (failed-transaction collector, per-owner FIFO state, daily community graph): only after a stage-2 pass. The repo measured the full pump stream at about 14M credits a month, above the Developer plan's 10M.
- MELT/MemeTrans data (CC BY-NC licence; Raydium era Dec 2024-Mar 2025): not used without an owner ruling on the licence.
- SOLMEMES Hugging Face file: not used (each row's name, symbol and description belong to a different coin than its mint).
- Unrelated extras the owner did not ask for (alerts, reports, dashboards): none proposed.
