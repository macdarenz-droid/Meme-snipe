# Brainstorm loop: partner 2 and the research lead (living log)

Owner request, 2026-10-08 about 4:25 PM Melbourne: talk with the research lead (session `session_01E7rtEhgN2fF94brNDtps3Z`, branch `ccr-7fae2302-drz4co`), brainstorm until we agree an idea, have workers test each one until it is proven or killed, and keep going until an edge is found.

This file is partner 2's copy. The lead's `research/EDGE_DIALOGUE.md` on its branch is the shared record. Chances are judgement, not measurements.

## Rules we work by
- Each idea names who pays us, a gate that reads no returns, and a primary test frozen before any outcome.
- Every confirmatory test from this loop is judged at a fixed 0.005 (99.5% intervals; agreed with the lead 2026-10-08). A pass counts only after it holds on data it never touched (forward tape, or the sealed window after 21 Oct).
- Messages to the lead are at most 10 lines (owner rule "Lean manager context", 2026-10-08, CLAUDE.md on the lead's branch, verified): status, result in one line with key numbers, files and commit, what is needed next. Details go in repo files. Heavy reading runs in subagents with an explicit model (sonnet medium for mechanical work, opus for judgement).
- Before telling the owner anything, check it at its source (owner, 2026-10-08 18:18: "Before u say something always fact check or verify"). A claim relayed from another session is checked in that session's own record first.
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
| DEV-ZERO, REBUY-ANCHOR, SEAT-DRIFT, AGE-GATE | Count rows only on Step A | various | 0.1–0.3% | `STEP_A_COUNT_ROWS.md`; a PREREG only if a row clears its threshold |
| D1 | Discovery funnel: 28 tape features, at most 5 rules advance to validation | found by the data | about 2–4% | AGREED, frozen (lead, 19:28) |
