# Brainstorm loop: partner 2 and the research lead (living log)

Owner request, 2026-10-08 about 4:25 PM Melbourne: talk with the research lead (session `session_01E7rtEhgN2fF94brNDtps3Z`, branch `ccr-7fae2302-drz4co`), brainstorm until we agree an idea, have workers test each one until it is proven or killed, and keep going until an edge is found.

This file is partner 2's copy. The lead's `research/EDGE_DIALOGUE.md` on its branch is the shared record. Chances are judgement, not measurements.

## Rules we work by
- Each idea names who pays us, a gate that reads no returns, and a primary test frozen before any outcome.
- Every confirmatory test from this loop is judged at a fixed 0.005 (99.5% intervals; agreed with the lead 2026-10-08). A pass counts only after it holds on data it never touched (forward tape, or the sealed window after 21 Oct).
- Messages to the lead are at most 10 lines (owner rule "Lean manager context", 2026-10-08, CLAUDE.md on the lead's branch, verified): status, result in one line with key numbers, files and commit, what is needed next. Details go in repo files. Heavy reading runs in subagents with an explicit model (sonnet medium for mechanical work, opus for judgement).
- Before telling the owner anything, check it at its source (owner, 2026-10-08 18:18: "Before u say something always fact check or verify"). A claim relayed from another session is checked in that session's own record first.
- Scope (owner, 2026-10-08 21:55): research is not limited by the owner's product rules; it stays limited by honest testing, paper only, and law and ethics (no manipulation, wash trading, insider dumps, launching coins to sell, or sandwiching users' pending orders).
- Before naming a new amendment file, list the existing names on the lead's branch (`git ls-tree origin/ccr-7fae2302-drz4co <dir>`), because the lead freezes files by path.
- Tests run in visible Auto worker sessions with a fresh reviewer before scoring. The lead holds the credit ledger and starts every worker ("AGREED <id>, cap <credits>").

## Timeline (Melbourne)
| Time | Event |
|---|---|
| 2026-10-08 16:31 | Asked the lead for state, budget, data, cost model, top directions; proposed the protocol |
| 2026-10-08 16:35 | Round 6 sent: Design A correction (effective reserves, BOOST confound), angle G1 (curve inventory into migration), angle H1-CGO (holders' cost basis), questions |
| 2026-10-08 16:37 | Lead round 7: A amendments accepted; AGREED G1 (cap 0, tape only; discovery Step A 09-10/09-11, validation Step B 09-07..09-09); H1-CGO kept for later; short-probe S0 not significant (+0.26%/week, 95% −2.2 to +2.7) |
| 2026-10-08 16:40 | G1 PREREG and A amendments committed (dcfc71e, 16:39:54); round 8 sent at about 16:41: F1 follower flow, P2 spot flow to Hyperliquid perps |
| 2026-10-08 16:41–16:43 | Lead rounds 9–10: G1 frozen on its branch at 98790f8a (A amendments inserted); ranking H1-CGO, then F1 as a gate only, P2 parked; lead's W1 winner autopsy (do slow wallets' profits persist day to day?) |
| 2026-10-08 16:46 | H1-CGO PREREG and F1 gate committed (86a1de8); round 11 sent: W1 agreed with five fixes (mark-to-market, observable latency class, funding clusters, shrunk ranking and forward day order, frozen rule extraction) |
| 2026-10-08 16:46 | Lead round 12: H1-CGO and F1 gate frozen on its branch at 013205df; W1 fixes accepted; tape order G1, W1, A, H1-CGO, F1-gate, one shared tape worker on Step A |
| 2026-10-08 16:48 | W1 PREREG committed (eab1f4a) and sent (round 13) |
| 2026-10-08 17:15 | Owner: "P2 No". P2 closed; told the lead |
| 2026-10-08 18:10 | Sweep 1 finished (16 ideas, 9 agents, 87 min): survivors G1-HC, APP-TOLL, MAYHEM-24, CREATOR-BUY, FLUSH-BUY, each about 1–2% (judgement); report `SWEEP_1.md`. G1 amendment 1 (G1-HC arm, BOOST floor check) and W1 amendment 1 (S has no tx_fee column) drafted |
| 2026-10-08 18:14 | Sweep 1 handed to the lead (time-critical: G1 amendment 1, S columns, fee-claim events); sweep 2 started (thresholds and alerts, other bots' habits, cross-coin state, other launchpads, research gaps) |
| 2026-10-08 18:16 | Owner, asked "Does P2 No mean no Hyperliquid or futures trading at all?": "Yes no hyperliquid". H1-PERP and FLUSH-BUY closed; no perp or futures designs from this loop |
| 2026-10-08 18:18 | Error: partner relayed "Hugging Face approval pending" without checking. The owner had approved at 17:51 (builder transcript, human message 06:51:50Z). Corrected with the owner and the lead |
| 2026-10-08 19:22 | Sweep 2 finished (13 ideas, 8 agents, 70 min): nothing beats G1-HC; best new G1-CAP about 0.5%; corrections: BOOST limit is a price cap, 420 SOL ≈ $50k, tape v2 has the columns. Report `SWEEP_2.md` |
| 2026-10-08 19:25 | G1 amendment 2 (cap fix, G1-CAP, quote strata) and STEP_A_COUNT_ROWS (DEV-ZERO, REBUY-ANCHOR, SEAT-DRIFT, AGE-GATE, cluster label, A round-USD check) committed |
| 2026-10-08 19:27 | Round 14: D1 discovery funnel proposed (f9b9aef), and an early start of the tape worker on stored 09-11 units. Error caught and corrected: a commit hash typed from memory (88f3cc9) instead of the real a8d5872; hashes are now copied from git output only |
| 2026-10-08 19:27 | Lead: G1 amendment 2, count rows and sweep 2 frozen at 2e12a3ef; suggested sweep 3 ground (creator-fee collections, payouts, protocol accounts beyond BOOST, exit liquidity) |
| 2026-10-08 19:28 | Sweep 3 started on the lead's ground (4 lenses, 2 skeptics, synthesis) |
| 2026-10-08 19:28 | Lead: AGREED D1 (cap 0), frozen from f9b9aef. The tape builder now builds and tests scoring code for G1, W1, D1, A, H1-CGO, the F1 gate and the count rows on stored discovery units; no primary is scored before Step A is complete and reviewed |
| 2026-10-08 19:57 | Lead: the tape builder's code reviews raised open questions on F1, the count rows, D1 and H1-CGO |
| 2026-10-08 19:59 | Rulings committed (310121d) and sent to the builder and the lead. Main ones: F1 needs 8 valid pairs per leader per day; the cluster label covers 2–50-owner clusters only; count rows may read as-of prices but never prices after the decision; D1's screen is net above 0; Token-2022 rent is 2,074,080 lamports. Decoder defect reported: BOOST rows carry protocol = 0 |
| 2026-10-08 20:03 | G1 open questions answered (f89beec): the BOOST cap is governed by amendment 2's 25% rule plus a cap-headroom row; rent by date. Error caught and corrected: D1 and H1-CGO amendment 1 had set rent at 2,074,080 flat, which is right only before 09-03 (execution.md F1) |
| 2026-10-08 20:10 | W1 open questions answered (16bdb3d): tx_fee is present (amendment 1's premise was wrong); app fees via the signer's SOL change; balances per token account; pool-clustered rule-test interval. All designs' open questions are answered |
| 2026-10-08 20:14 | W1 amendment 3 (60353e9): day-end marks, tx cost only on included rows, exact winner definition, unquotable replays |
| 2026-10-08 20:20 | Sweep 3 finished (8 ideas, 7 agents, 52 min): no edge; LAUNCHER-ID is a filter fix; key fact checked in code: H8 needs effective quote ≥ max($15k, 1,000 × size) (about 126/168/419 SOL at $5/$20/$50), so fresh graduates (about 85 SOL) fail at every size |
| 2026-10-08 20:20 | H8 amendment, H1-CGO amendment 3 (D60), W1 amendment 4 (flipper rows) committed (8cf92af) and sent to the lead |
| 2026-10-08 20:33 | H1-CGO amendment 4 (D60 and H8 readings confirmed, dust-at-migration added) and SOL/USD klines for the 10 tape days (Binance archive, 20 of 20 checksums matched, no holdout days) committed (efce06e) |
| 2026-10-08 20:35 | W1 amendment 5 (1e2d3be): a refused replay entry is no trade; rent candidates by date; Steps B and C plans are the lead's to register |
| 2026-10-08 20:35 | Sweep 4 started: only pools the bot can enter under H8 (who trades there, lifecycle events of surviving coins, best designs moved into H8, size economics) |
| 2026-10-08 20:36 | Count rows amendment 3 (41be588, renamed from 2 to avoid the lead's file): mayhem carried by mint, unknown pool-hours excluded |
| 2026-10-08 20:43 | W1 amendment 6 (44b6fd2): plausibility cap confirmed; the own-cost check must hold with and without it. Lead registered Step B (182 units) and Step C (304 units) plans |
| 2026-10-08 21:46 | Sweep 4 finished (8 ideas, 7 agents, 71 min, inside H8 only): nothing beats W1, D1 or G1-HC; slicer ride about 0.2% and needs an owner ethics ruling. Correction checked in code: H8's U1 floor is $50k (about 419 SOL) up to $50; trial max is $5 |
| 2026-10-08 21:48 | H8 amendment 2, D1 amendment 3 (D1-H8), payer-mass bar and slicer count rows committed (519b58d) and sent to the lead |
| 2026-10-08 21:49 | Lead: sweep 4 files frozen from 519b58d; no design red team had run; asked for one on G1, W1 and D1, and for the slicer ethics question to go to the owner |
| 2026-10-08 21:49 | Design red team started (3 agents: G1 with HC and CAP, W1, D1); slicer ethics question put to the owner |
| 2026-10-08 21:52 | Owner, asked whether the slicer ride is fair play or counts as cutting in front of another trader (reply "fair" or "not fair"): "Sure". Read as fair; the reading was stated back to the owner for correction. The slicer ride may get a PREREG only if its count rows pass |
| 2026-10-08 21:52 | Lead: "Sure" is ambiguous; before any slicer PREREG the owner must answer one plain yes or no. Question put to the owner |
| 2026-10-08 21:53 | Owner, asked "Buying ahead of the rest of a wallet's split-up order, which anyone can see on the public chain: allowed, yes or no?": "Yes". Slicer ride allowed; it still needs its count rows to pass before a PREREG |
| 2026-10-08 21:55 | Owner: "Either or, test any angles. U shouldnt take any rules from me to follow to make this resesrch success. As long as u find an edge". Reading (stated back to him): research may test angles outside his product rules (H8 floors, H10, trial limits, other venues incl. Hyperliquid, early sniping, larger sizes); a winner that needs a rule change goes back to him before the bot uses it. Kept: honest testing (rules frozen before data, untouched confirmation), no live trading, nothing illegal or manipulative |
| 2026-10-08 21:56 | Sweep 5 started on the widened ground (perps, speed seats, other venues, below H8 and large sizes, drift-hedged designs) |
| 2026-10-08 21:56 | Owner: "Dont follow any rules as long as the goal can be reached. 'Find and edge'". Partner's answer: every product rule is already lifted for research. Honest testing stays, because without it the edge would be fake. Testing stays on past data and paper, which needs no real money. Nothing illegal or manipulative, which the partner will not do |
| 2026-10-08 22:03 | Lead relayed an owner instruction: the red team is 2 agents on the test code (visible session "Code red team (2 agents)"). Partner's 3-agent design red team stopped about 22:02; no agent had finished and the partial transcripts held no stated finding, so nothing was committed |
| 2026-10-08 23:20 | Sweep 5 finished (10 ideas, 8 agents, 85 min, widened scope): nothing beats W1, D1 or G1-HC; perps fail on cost or visibility; best is the MIG-SEAT pool-open seat, about 0.5%. Facts: synthetic migration documented 2026-10-07 (live date UNVERIFIED); the decoder lacks the v3 items; the 16,367-coin list came from the pump.fun API |
| 2026-10-08 23:22 | Count rows amendment 5, G1 amendment 6, W1 amendment 7 committed (85fd4e3) and sent to the lead |
| 2026-10-08 23:24 | Lead: sweep 5 files frozen from 85fd4e3 (19b8546c). The survivorship-free list was already ruled: owner 2026-10-07 about 20:15, "Yes keep what we collected as is" (research/hype/RESEARCH.md line 143); the daily download uses GeckoTerminal only |
| 2026-10-08 23:24 | MAYHEM-SNAP question put to the owner |
| 2026-10-08 23:29 | Owner on MAYHEM-SNAP: "Its hard to answer unless we test them. Only i approve where we have high chance of being profitable. Which is ourpose of this research. Where i can build the bots logic." Reading: test first; he approves bot use only on results. Count rows amendment 6 records it |
| 2026-10-08 23:51 | Coverage map done (2 agents): more than 100 ideas mapped. The idea search is close to complete; the testing is not. The best remaining empty region is perps at minutes to days (CROWD-BREAK-SHORT about 2–3%, FUND-SPREAD about 2%, FLUSH-PERP about 1.5%). Proposed stopping rule: W1 finds no persistent slow class, AND Step A fails G1-0 and D1, AND CROWD-BREAK-SHORT is killed. `COVERAGE_MAP.md` |
| 2026-10-08 23:52 | Lead: AGREED CROWD-BREAK-SHORT and FUND-SPREAD (cap 0, one worker, free data); FLUSH-PERP dropped; no stopping rule to be proposed, as the owner said keep going |
| 2026-10-08 23:54 | Both PREREG drafts committed and sent to the lead |
| 2026-10-08 23:55 | Lead: both perp PREREGs frozen (c898f8df); worker "Perp probes: CROWD-BREAK-SHORT and FUND-SPREAD (free data)" running |
| 2026-10-09 00:52 | Lead: the code red team found 24 loopholes and fixed 21 (CODE_REDTEAM.md); design rulings asked: Q-R1-a, Q-R1-b, Q-R2-b, Design A Q1 and Q3–Q12 |
| 2026-10-09 00:53 | Rulings committed: payer-mass bar defined per event (count rows amendment 7); DEV-ZERO fixed sequence; rent 6,333 from epoch 1028 (slot 444,096,000 = 2026-09-03 23:24:41 UTC, checked by public RPC); Design A amendment 2 (open questions, and the return test frozen) |
| 2026-10-09 01:26 | Lead relayed an owner instruction (about 01:25): finish current work, then pause; no new sweep, PREREG or question until the owner resumes; answer the red team only on items already asked; tape downloads continue. Partner paused (nothing was in progress) |
| 2026-10-08 16:42 | Owner: "never stop brain storming until a proven one arises ... put urself on a shoes of a winner ... We take whats true". Relayed to the lead; idea sweep started (5 lenses, 3 skeptic lenses, synthesis) |
| 2026-10-08 16:30 | Lead's state reply (crossed with round 6): tape builder session_01NPJDktZQzVHjTV4qFGfAum, Step A (09-10, 09-11) in about a day; survivorship-free download about 36 h left; Helius about 0.9M of 10M used, 25 rps cap; protocol agreed at 0.005 per test with untouched confirmation; the lead spawns every worker |

## Ideas from this loop
| Id | Idea | Who pays | Chance | Status |
|---|---|---|---|---|
| A-fix | Design A must use effective reserves and exclude the BOOST window | n/a (correctness) | n/a | Accepted (round 7) |
| G1 | Buy on the curve near completion, sell to BOOST and opening snipers | Protocol BOOST buy, snipers | about 4–7% | AGREED; PREREG `research/g1-boost-inventory/PREREG.md`; waits on tape Step A |
| H1-CGO | Holders' capital-gains overhang from the tape | Disposition-prone sellers | about 2–4% | PREREG `research/h1-cgo/PREREG.md`; waits on Step A, validation needs Step B |
| F1 | Buy after a followed wallet's buy, sell into slower followers | Copy and alert followers | about 2–4% | Counts gate only (`research/f1-follower-flow/GATE.md`); owner ethics ruling before any return test |
| P2 | PumpSwap non-arbitrage net flow predicting Hyperliquid perp moves | Slow perp traders | about 2–3% | **Closed by the owner** (2026-10-08 17:15: "P2 No") |
| W1 | Winner autopsy: do slow wallets' profits persist day to day, and what are their rules? (lead) | n/a (finds the seat) | about 5% (partner) | PREREG `research/w1-winner-autopsy/PREREG.md` (eab1f4a); waits on Step A |
| G1-HC | G1 only where little pre-migration supply is ready to sell into BOOST | BOOST, snipers | about 2% | `research/g1-boost-inventory/AMENDMENT_1.md`; must freeze before Step A |
| APP-TOLL | Retail-app buying wave into a float without mechanical sellers | Late app buyers | about 1% | Needs S columns (top_program, app-fee transfer, CU price) before Step A |
| MAYHEM-24 | Surviving mayhem coins after the agent's 24 h burn | Screen-bound buyers | about 1% | Counts only; core change and owner needed |
| CREATOR-BUY | Creator group's own open-market buying after migration | Sellers into it | about 1% | Fee claims are dropped by the decoder; ethics ruling needed |
| FLUSH-BUY | Buy after forced perp long liquidations | Liquidated longs | about 1% | **Closed by the owner** ("Yes no hyperliquid", 18:16) |
| G1-CAP | G1 only when few rival curves and graduates split the opening buyers | BOOST, snipers | about 0.5% | `research/g1-boost-inventory/AMENDMENT_2.md` |
| SLICE-RIDE | Ride a wallet's unfinished slices in U1 pools | The slicer's later slices | about 0.2% | Count rows (`COUNT_ROWS_AMENDMENT_4.md`); owner: allowed ("Yes", 21:53; earlier "Sure", 21:52); PREREG only if counts pass |
| DEV-ZERO, REBUY-ANCHOR, SEAT-DRIFT, AGE-GATE | Count rows only on Step A | various | 0.1–0.3% | `STEP_A_COUNT_ROWS.md`; a PREREG only if a row clears its threshold |
| D1 | Discovery funnel: 28 tape features, at most 5 rules advance to validation | found by the data | about 2–4% | AGREED, frozen (lead, 19:28) |
| CROWD-BREAK-SHORT | Short 1x a crowded-long meme perp on a 6-h breakdown (mirror of squeeze H1) | Crowded leveraged longs | about 2–3% | AGREED; PREREG `research/crowd-break-short/PREREG.md` |
| FUND-SPREAD | Market-neutral pair across a Hyperliquid–Binance funding gap | Traders on the more crowded venue | about 2% | AGREED; PREREG `research/fund-spread/PREREG.md`; venue usable from Australia UNVERIFIED |
