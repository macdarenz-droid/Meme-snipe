# Project decision and supervisor messages (2026-10-07)

Produced by a 5-agent comparison workflow (3 readers, a decision maker, an adversarial fact-checker who corrected 20 claims). The supervisor then added confirmed facts: the Helius plan, the data-terms decisions, sizing and the execution audit.

## Recommendation

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

## Message to the Zeroed (meme-snipe) supervisor

**To the Zeroed supervisor (owner decision, 2026-10-07)**

The owner is stopping the separate "Solana Meme Bot Blueprint" (claude.ai/artifact/SWxLJXAncuoyZvq2vXcbMK; design only, no code by its own statement) and keeping Zeroed. Its supervisor will send you its design as reference research. Both projects agree no edge is proven. Your job: reach a yes-or-no answer on an edge cheaply and correctly, and adopt the Blueprint's stricter rules. Check every input against its source first. Run the items one at a time (CLAUDE.md:40).

**Adopt, in this order**

1. **Merge the research.** Owner: I lift, for this research only, the 6 Oct parking of research merges (CLAUDE.md:18). `ccr-7fae2302-drz4co` is not an ancestor of `ccr-14987baf-i6lrsl` (cd4d7a64 when checked). Four research sessions are still pushing results to it: execution audit, hype Test 1, launch probe and cheap-venue probe. Merge its head when they finish, or merge now and again later. Bring in `docs/research/edge.md` §6–§9 and `research/*`, including `research/sizing`, `research/hype` and `research/execution-audit` (PREREG, RESULTS, code; no `__pycache__`), through a reviewed PR. *Check:* the integration branch's edge.md has §6.10, and `research/deep-pool-probe/RESULTS.md` exists there.

2. **Measure before you build** (Blueprint A-M13-01, D08, D17).
   - Freeze engine feature work. Allowed: blocker fixes, the items below, and code for a strategy that has passed its pre-registered screen.
   - Score these as registered: cheap-venue probe (PREREG 6033cd0c, code 28ddd35a), launch probe (8d55507b, amendment d7a1a02d), hype Test 1 (2349dfe2), the daily survivorship-free re-test, and the execution audit (PREREG 42afe72a; 4 of 72 targets at 3b17c8bb).
   - Record that deep-pool MR-A/MR-B are close proxies of MR-01's two configurations, both not supported (RESULTS.md:13,15). In the 0.30% tier their validation CIs cross zero (RESULTS.md:19). Also record that PM-01 overlaps U2 at 60–120 min (#267).
   - At most 2 configurations per new hypothesis. Never search the same window again.
   - *Check:* one DECISIONS entry per verdict, each citing its PREREG sha.

3. **Correctness fixes**, each with a test that fails before and passes after:
   - (a) `SLOT_MS = 400` at `packages/worker/src/engine/strategy.ts:1749`, `packages/worker/src/run/config.ts:84`, `packages/backtest/src/sim/world.ts:61` and `packages/backtest/test/study-world.ts:21`. Derive slot time from block-time anchors, with one function shared by live and backtest.
   - (b) H8 at `packages/core/src/gates/hard.ts:311` counts virtual quote as depth. Use the real vault for "can exit" and collapse checks (Blueprint §8.1 DEPTHPCT min(effective, real); §8.4). Add a fixture where a drained post-BOOST pool fails H8.
   - (c) Rule on the holdout contamination (edge.md:162-163): exclude 2026-10-01T23:00Z to 10-03T23:59Z from G2. This only tightens. Also rule on #267, which read U2 on 22 Sep–6 Oct, inside the sealed window [09-22, 10-20) (DECISIONS.md:181).

4. **SOL books (owner rule).** Finish SOL-BOOKS #197 so `packages/core/src/risk/types.ts` works in lamports, with a risk-reviewer pass. *Check:* a test where SOL/USD moves ±20% with no trade shows zero P&L and trips no limit.

5. **Tighten the gates.** ARCHITECTURE.md:420 lets anyone tighten.
   - PBO ≤0.05 (`stats/gates.ts:89` is 0.25), and DSR ≥0.95 always gating.
   - A MinBTL trial budget; t ≥3; positive in the holdout and in every calendar week (Blueprint B-1..B-8).
   - Replay must keep ≥50% of the backtest mean and survive 2× p95 latency with sandwich fills at minOut (R-3, R-4, §9.3).
   - Fixed monthly cost inside the profit gate at every reported size (P-2b).
   - A trial-identity hash over every config that affects returns, the cost and fill model versions, and the data manifest (§3.4).
   - Coarse screens may only kill a strategy (CS-1).
   - *Check:* tests that passed on the old thresholds fail on the new ones.

6. **Credit use before the worker resumes.** Keep the owner's 6-step resume order (CLAUDE.md:42-48).
   - The Helius Developer plan is active: owner's dashboard on 2026-10-07 showed 126k of 10M credits used, cycle 6 Oct–6 Nov, autoscaling off at a $0 limit. Some docs still assume the free 1M plan (PROJECT_STATE.md:19); correct them.
   - Research sessions use the same key under their own caps: the execution audit and the launch probe at 1.5M each.
   - Before step 5, bring the worker's own count down to ≤10k Helius credits an hour, mainly by watching fewer pools. Derived: 10M/month ÷ 720 h ≈ 13.9k/h, minus room for research. It ran at about 80k/h (DECISIONS.md:3466). This is a design target. HELIUS-EXHAUSTED (owner, DECISIONS.md:750-751) removed the worker's own Helius halt, so a hard cap needs the owner.
   - Watch only an enumerated list of eligible pools (Blueprint D30, §11.2).
   - Keep research credits separate from the worker's.
   - A 2 GiB host (D07) is new spend, so the owner decides.
   - *Check:* 24 h of summaries under the target.

7. **Before any live money (each needs the owner's approval; do not build now):**
   - SIGN-1 built to Blueprint M17 (`packages/signer/**`, owner approves);
   - an M29 sentinel exit takeover, which closes the ARCHITECTURE.md §12.5 gap (the watchdog cannot sell);
   - HOTCAP with a sweep to the owner's saved wallet (ARCHITECTURE.md:349), using the Blueprint's §12.2 numbers;
   - FEEDAY, which never blocks exits (§8.2);
   - flow-adjusted equity;
   - a two-provider expiry proof (M18);
   - the §16.5 failure cases and the §16.7 go-live checklist.
   - The floor-based sizing layer from `research/sizing/RESULTS.md`: an 80% SOL equity floor, open stakes no larger than the surplus, a pre-registered stop switch back to paper, and growth only from realised SOL. The owner's loss-shrinking loop halved drawdowns but could not create an edge.
   *Check:* these exist as parked cards only.

8. **Data and terms.**
   - pump.fun Terms §21(h) (updated 25 Sep 2026) bar bots and scripts except as §6.1 permits, tracking other users, and forged headers. The research scripts sent pump.fun's own Origin and Referer headers. This is now stopped (`research/brainstorm/pf.py` refuses to run).
   - Owner decision, 2026-10-07: keep the pump.fun data already collected as it is, and make no new pump.fun requests.
   - Check whether the worker or the app calls pump.fun frontend endpoints. If they do, list them for the owner.
   - Helius Terms §3.2(xi) (business purpose only) is still the owner's open question.

**Stop or freeze**
- New features, and app and Telegram work.
- The fake 17.8% paper edge. #268 removes it but also switches the real worker back on, so merge it only at step 5, or split out the edge removal.
- Starting Fable sessions (CLAUDE.md:24). The one Fable session was started from the owner's phone and is archived.
- Duplicate reviewers. Triage the 55 open PRs and park those outside items 1–6.
- HANDOVER.md and PROJECT_STATE.md are stale since 5 Oct. Update both.

**Strategy direction.** The research puts the chance of no edge at 75–85% (edge.md:113-118). The live threads:
- the cheapest venues: the 0.30% tier CI is −0.71 to +0.32, and cheap non-PumpSwap seats cost 0.33–0.65% but need the owner (edge.md:255-261);
- the D-REV3 survivorship re-test;
- attention signals as a reject rule only;
- MR-01's 15 s signal, which is untested. Most of the bounce comes in the first 5 minutes (deep-pool RESULTS.md:25). A passing test needs our own 1 Hz recording, which is new data spend (CLAUDE.md:49). A kill-only screen could use Birdeye 15 s bars ($39, owner decides; Blueprint D17).

- Fills: use transaction-ordered fills, as BT-1 does. The research's hourly approximation sold the exploration jackpot at about 132×, where a real-time trail on the actual swaps sold it at about 27× (`research/execution-audit/`).

If these fail, tell the owner: stay in paper, no deposit, and cut spend to the minimum.

**Cost discipline.** Every task must move the edge answer or close a blocker. Use Sonnet for mechanical cards and Opus for judgement. Report results across sizes from $5 to $10,000, with the fixed cost shown (CLAUDE.md:50).

## Message to the Blueprint supervisor

**To the Blueprint supervisor (session "SHITCOIN V2"), owner decision, 2026-10-07**

The owner is stopping the Blueprint as a build and keeping Zeroed (repo macdarenz-droid/Meme-snipe). Zeroed already has a paper engine, and its research has tested close versions of your two strategies:
- Its deep-pool MR-A and MR-B use MR-01's lookbacks, 3σ entry, stops and time limits, on 5-minute bars. In 0.30–0.55% pools, validation net was −0.76% and −1.03% a trade, with CIs below zero (`ccr-7fae2302-drz4co:research/deep-pool-probe/RESULTS.md:13,15`). In the 0.30% tier it was −0.17% and −0.40%, with CIs crossing zero (RESULTS.md:19; results.json).
- PM-01 overlaps its U2 universe at 60–120 min. Relaxed U2 lost 10.6% a trade (CI −15.3 to −5.5; PR #267). Buying every usable graduate at hour 1 lost 22.4% (`research/runner-probe/RESULTS.md:20`).

Your plan is built to stop at M1/M2 if its gates fail (#overview--blockers), and D08 then moves effort to PM-01 replay. Your design is the most valuable part of this project and must survive.

**Stop:** write no code and start no M0 ticket. Rent no droplet, buy no data (Birdeye, Bitquery) and make no RPC pulls.

**Hand over** one Markdown file, `blueprint-handover.md`. For each item give its artifact anchor and keep the exact numbers:
1. The facts register (236 kept, 63 dropped with reasons): `#facts--register`, `#facts--dropped`.
2. Decision records D01–D31.
3. The §2.1–§2.4 cost formulas and break-even tables.
4. The §3.4 gates B, R, P, LS, L and CS-1, with the exact MinBTL and MinTRL tables, CUSUM L-1, LS-3 non-inferiority and the trial-key definition.
5. §8: the risk limits, breakers, caps, filters, exit ladder and the §8.8 enforcement summary.
6. §9.3, the pessimistic fill model.
7. M17 signer, M29 sentinel, M18/M19 send and expiry proof, D22 janitor, D31 simulation payer, and §7.6 crash recovery.
8. §11, the provider and cost plan, and §12.2–§12.3, keys and supply chain.
9. §16.5, the failure cases, and §16.7, the go-live checklist.
10. The 124-item VERIFY register.
11. An open-questions note. The deep-pool probe did not test MR-01's 15 s signal, its MAD scale, its 6 h-median exit or config 2's +6% target: it used 5-minute bars, a 3-day standard deviation and +8%, and its main group included 0.33–0.55% pools.

**Where:** give the file and the artifact link to the Zeroed supervisor, who files it as one document, `docs/research/blueprint.md`, through their own reviewed PR. Do not push to Meme-snipe yourself.

**Archive:** keep the artifact published and unchanged as the reference; never delete or edit it. After the Zeroed supervisor confirms receipt, archive your design and critic sessions.

**Do not:**
- re-research facts Zeroed has already verified (its decoders have mainnet golden vectors, `PROJECT_STATE.md:27`);
- claim MR-01 or PM-01 has no evidence against it: close versions lost, though their exact signals are untested;
- use the owner's Helius account;
- create keys or move funds;
- post progress in the owner's chat.
