# Idea board: every idea, ranked by chance of profit (living document)

Updated 2026-10-08 07:40 AEDT. "Chance" is my judgement of the chance that the idea yields a tradable edge after realistic costs and delay. It is not a measured probability. Order: open ideas from highest to lowest chance, then everything already tested. Evidence is on branch `ccr-7fae2302-drz4co`.

## Open ideas, highest chance first

| # | Idea (source) | Why it might work | Chance | Status / next step |
|---|---|---|---|---|
| 1 | **Absorption entry:** buy only after new, independent buyers absorb a large seller (advisor) | Uses information no price test used: who sold, who replaced them. Slow enough for our latency | low (about 10%) | **UNRESOLVED (too rare):** 44 confirmed large sales, 8 absorptions, 5 tradable in 55% of eligible pool-days; no returns computed (`research/absorption-probe/RESULTS.md`). Needs forward recording |
| 2 | **Audience gains:** a meme's usual buyers just made money elsewhere (advisor; Sun 2023) | Behavioural evidence that gains spill into lottery-like buying; it reads the buyers, not the chart | low (about 5–10%) | Scouted; shared tape approved 2026-10-08; build and Phase 0 started; about 15–17M credits at 10 per call, not recommended |
| 3 | **First spot listing** on a new retail venue (advisor) | A real new buyer base | very low to low | Deferred: too few events (`listing-probe/PREREG_DRAFT.md`) |
| 4 | **Community crossing:** new buyers from previously separate wallet communities (advisor) | Spreading demand differs from one circle recycling | very low to low | Scouted; shared tape approved 2026-10-08; build and Phase 0 started |
| 5 | **Multi-token liquidation:** buy the drop when a wallet empties several unrelated coins (advisor; Coval & Stafford) | Forced, non-informative selling recovers in equities | very low to low | **UNRESOLVED (too rare):** at most 2 events of the right shape in 1,336 candidate bars at the 200k-credit cap; 100 needed (`research/liquidation-probe/RESULTS.md`) |
| 6 | **Revenue-funded buybacks** (advisor) | Measurable real demand | very low (few Solana memes qualify) | Scouted; PREREG draft ready; deferred until GeckoTerminal load eases |
| 7 | **Holding-incentive expiry short** (advisor; Liebi) | Demand ends at a known time | very low (rare, often priced before) | Dropped: too few events |
| 8 | **Failed transactions** as hidden demand (advisor) | Data our candles never had | very low | Scouted; shared tape approved 2026-10-08; build and Phase 0 started |
| 9 | **SOLMEMES text features** replication (advisor) | A published positive result exists | very low (6-day out-of-time window; metadata alone was not profitable) | Scouted; shared tape approved 2026-10-08; build and Phase 0 started |
| 10 | **Theme leader** when a theme goes viral (advisor; Li et al.) | Attention can flow to the known coin, not clones | very low; forward-only | Design a forward collector |
| 11 | **Owner's own picks** (advisor) | Human selection was never measured | n/a | Owner declined (rarely trades memes) |

## Tested, not supported (pre-registered unless noted)

| Idea | Result |
|---|---|
| Blueprint MR-01 dip-buy, 1-minute bars | **KILLED:** −0.77% a trade (CI −0.79 to −0.74) |
| 5-minute dips and breakouts on the cheapest venues | −0.55% to −0.59% a trade; the bounce about +0.05% |
| 5-minute dips on PumpSwap deep pools | bounce +0.1–0.6% below a 0.85–1.0% toll |
| Launch sniping, 0.7 s to 3 min after creation | all 40 pairs lose; primary −7.1% |
| Runner (cut loss, ride the giant), R1–R4 | validation −22.4% a trade; no 50× winner |
| Lottery basket | lost |
| Hot-market timing (exploratory) | hot stretches lose less, but still lose; top decile −21% |
| Bet sizing (owner's loss-shrinking loop) | protects capital, creates no edge |
| Short side on Hyperliquid (S1–S3) | no edge beyond market drift |
| Daily and weekly holds, trend | not supported; the one positive was survivor bias (survivorship-free re-test downloading) |
| Graduation window, BOOST window, copy-trading | not supported |
| Social links, creator history, slow graduation, time of day (exploration) | no separation |
| Hype as a buy signal (exploration) | paid-ad coins jumped more often but lost more |
| Paid attention at entry (hype Test 1; 1,603 fresh coins) | **kill (a):** paid −27.1% vs unpaid −22.3% a trade; gap −4.8 points, 98.33% CI −11.5 to +2.8; paid sits inside the random-group band. Unfiltered R1 basket −24.1% a trade (`research/hype/test1/RESULTS.md`) |
| Squeeze, spot (H1) | registered primary **UNRESOLVED** (AMM v4 data check failed on dust swaps); new trial H1-T2 **KILLED:** −0.71% a trade after costs over 238 events, lift over ordinary breakouts +0.32% (not significant); every secondary arm negative (`research/squeeze-probe/RESULTS.md`) |
| Maker seat: resting bids on 12 deep-pool coins (design C, `EDGE_DIALOGUE.md`) | **not supported:** −1.41% a fill over 152 fills (99.58% CI −2.68% to −0.42%); lift over random buys −0.43 points; dips deep enough to fill kept falling (`research/maker-probe/RESULTS.md`) |
| Crowd-break short on perps (CROWD-BREAK-SHORT) | **KILLED:** −0.92% a trade over 376 events (99.5% CI −1.96% to +0.27%); the crowd does get flushed (OI flush 9.6% vs 3.2%), but shorting it does not pay (`research/crowd-break-short/RESULTS.md`) |
| Funding spread, Hyperliquid vs Binance (FUND-SPREAD) | **CLOSED at the gate:** only 27 executable entries (300 needed), and 2.96% of 72 h windows had a 50% move (limit 1%); no return read (`research/fund-spread/RESULTS.md`) |
| Stacked loss-reducers (A-FULL) | judged in `CONNECT_THE_DOTS.md`, not run: every part was found on viewed windows and stacked losers still lose |
| LP, carry, arbitrage, cashback | not reachable or not positive |

## Common cause (`docs/research/edge.md` §10)
Public signals add about a tenth of the round-trip toll. Ideas 1, 2 and 4–8 try to use information beyond public price and social data (who sells, who buys, positioning, failed attempts). That is the only route the evidence leaves open.


## Reviewer family and error control (2026-10-08)
Every confirmatory primary from the outside reviewer's ideas, and the connect-the-dots survivors, counts toward one family: k = 12. Each primary is judged at 0.05/12 = 0.0042 (99.58% intervals), with 95% shown beside it. Weighted Bonferroni applies, and Holm only after all 12 report.

| Member | Status |
|---|---|
| Absorption entry (+ ABS-S1 secondary, fixed sequence) | UNRESOLVED: too few events (5 tradable of about 30 needed) |
| Squeeze, spot (H1) | registered primary UNRESOLVED; new trial H1-T2 KILLED (mean net −0.71%; 99.58% CI −1.68% to +0.39%) |
| Squeeze traded on the perp (H1-PERP, P1) | **Reopened for research** (owner, 2026-10-08 21:55: "Either or, test any angles. U shouldnt take any rules from me to follow to make this resesrch success. As long as u find an edge"). Research may test any venue or rule. A winner that needs a product-rule change (Hyperliquid, H8, H10, sizes) goes back to the owner before the bot uses it. Kept: honest testing, paper only, law and ethics |
| Liquidation fire-sale (H3) | UNRESOLVED: too rare (at most 2 events of 100 needed) |
| D-SPLIT: liquidated, not dying (P2) | frozen in `daily-probe/PREREG.md`; waits for the survivorship-free download |
| Failed transactions; community crossing; SOLMEMES; audience gains | shared tape approved 2026-10-08; build and Phase 0 started |
| Buybacks | ready; deferred for GeckoTerminal load |
| Listing (H4) | deferred: too few events |
| Theme leader (H2) | forward-only |
| Incentive expiry | dropped: too few events |

Connect-the-dots (`CONNECT_THE_DOTS.md`): 14 combinations, none points to an edge. Three survivors earn cheap, fair tests, judged at about 3–5% each. The chance that at least one is real is about 9–14% (judgement).
