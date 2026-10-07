# Idea board: every idea, ranked by chance of profit (living document)

Updated 2026-10-08 02:30 AEDT. "Chance" is my judgement of the chance that the idea yields a tradable edge after realistic costs and delay. It is not a measured probability. Order: open ideas from highest to lowest chance, then everything already tested. Evidence is on branch `ccr-7fae2302-drz4co`.

## Open ideas, highest chance first

| # | Idea (source) | Why it might work | Chance | Status / next step |
|---|---|---|---|---|
| 1 | **Absorption entry:** buy only after new, independent buyers absorb a large seller (advisor) | Uses information no price test used: who sold, who replaced them. Slow enough for our latency | low (about 10%) | Running on Helius, three-group test (`research/absorption-probe/`) |
| 2 | **Squeeze:** spot breakout while perp funding is very negative and open interest high (advisor) | A possible extra source of demand: forced short covering | low (about 5–10%) | Data check running (is historical open interest available?) |
| 3 | **Audience gains:** a meme's usual buyers just made money elsewhere (advisor; Sun 2023) | Behavioural evidence that gains spill into lottery-like buying; it reads the buyers, not the chart | low (about 5–10%) | Data check running; needs a shared wallet-level dataset |
| 4 | **Stacked loss-reducers:** real-time stop + hourly trail, paid-ad reject, hot-market timing, absorption entry (our research) | Each piece cut losses by a few points; together they might reach break-even | low (about 5%); high overfit risk | To be designed overnight; only an untouched holdout can judge it |
| 5 | **First spot listing** on a new retail venue (advisor) | A real new buyer base | very low to low | Data check running (announcement timestamps) |
| 6 | **Community crossing:** new buyers from previously separate wallet communities (advisor) | Spreading demand differs from one circle recycling | very low to low | Data check running; shared dataset |
| 7 | **Multi-token liquidation:** buy the drop when a wallet empties several unrelated coins (advisor; Coval & Stafford) | Forced, non-informative selling recovers in equities | very low to low | Data check running; Helius |
| 8 | **Revenue-funded buybacks** (advisor) | Measurable real demand | very low (few Solana memes qualify) | Data check running |
| 9 | **Holding-incentive expiry short** (advisor; Liebi) | Demand ends at a known time | very low (rare, often priced before) | Data check running |
| 10 | **Failed transactions** as hidden demand (advisor) | Data our candles never had | very low | Data check running; shared dataset |
| 11 | **SOLMEMES text features** replication (advisor) | A published positive result exists | very low (6-day out-of-time window; metadata alone was not profitable) | Data check running |
| 12 | **Theme leader** when a theme goes viral (advisor; Li et al.) | Attention can flow to the known coin, not clones | very low; forward-only | Design a forward collector |
| 13 | **Owner's own picks** (advisor) | Human selection was never measured | n/a | Owner declined (rarely trades memes) |

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
| Hype as a buy signal | paid-ad coins jumped more often but lost more |
| LP, carry, arbitrage, cashback | not reachable or not positive |

## Common cause (`docs/research/edge.md` §10)
Public signals add about a tenth of the round-trip toll. Ideas 1–3 and 6–10 try to use information beyond public price and social data (who sells, who buys, positioning, failed attempts). That is the only route the evidence leaves open.
