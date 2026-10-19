# Risk management and trading habits for a $20 Solana memecoin bot

Research date: 2026-10-03. Author: research subagent (risk topic). Scope: position sizing, stops, profit taking, portfolio controls, documented habits of profitable memecoin traders, retail outcome data. The last two sections turn this into a risk policy spec and paper-mode strategies.

Conventions. "Data" means a measured statistic from a named dataset. "Anecdote" means a practitioner claim with no verifiable dataset. "Unverified" means I could not confirm it from a primary source. "Assumption" marks a number I chose for illustration. It is not a measurement. Live values used: SOL/USD = $119.46 (CoinGecko simple price API, last_updated 2026-10-03 12:06 UTC). All the arithmetic below was reproduced with `research/riskwork/riskmath.py` in this scratchpad.

---

## 0. Summary for the builder

1. **The base rates are very hostile.** 60.26% of migrated (graduated) memecoins in a 41,470-token sample fell below 0.2x their migration price within 20 minutes. Buying at migration and selling at a random time in the next hour lost 60.71% on average ([MemeTrans, arXiv 2602.13480, 2026-02-13](https://arxiv.org/html/2602.13480v1)). Only 0.63% of 655,770 pump.fun launches graduated in Sep 2025 ([Marino et al., arXiv 2602.14860, 2026-02-16](https://arxiv.org/html/2602.14860v1)). Among cross-chain memecoins that rose more than 100%, 82.8% show manipulation indicators ([Mongardini & Mei, arXiv 2507.01963v2, 2026-01-02](https://arxiv.org/pdf/2507.01963)).
2. **Professional per-trade risk norms cannot be met at a $2 minimum.** Elder's rule is 2% of capital per trade ([Incredible Charts summary of Elder](https://www.incrediblecharts.com/trading/6_percent_rule.php)), which is $0.40 here. A $2 entry with a 15% stop, 5% stop slippage, a 5% catastrophic probability and about 3.5% round-trip cost loses about **$0.58 (2.9% of bankroll) per losing trade**. A $5 entry loses about **$1.41 (7.0%)**. The full-loss tail is 10% or 25% of the bankroll. The policy has to compensate at the portfolio level: one position, a small daily loss trigger, a hard kill switch, and no size increases until the edge is measured.
3. **Sizing up multiplies ruin risk when the edge is marginal.** Monte Carlo over 100 trades: in a near-zero-edge scenario, P(bankroll ≤ $10) is **9.5% at $2/trade and 35.5% at $5/trade**. A −30% hard kill switch plus a $3 daily stop cuts those to 0.04% and 5.2% (section 1.6).
4. **Kelly gives no usable size until there is a large sample.** For example, p = 0.40 and win/loss = 2R gives full Kelly = 10% of bankroll at risk. With n = 30 trades the 1-sigma-lower win rate already gives a negative Kelly. MacLean, Thorp and Ziemba: practitioners "sharply reduce risk as their drawdown increases" and wagers "should be reduced" given "the extreme sensitivity of E log calculations to errors in mean estimates" ([Good and bad properties of the Kelly criterion, 2010](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf)).
5. **Costs are large relative to a $2 position.** PumpSwap canonical pools charge **1.25% per swap at 0–420 SOL market cap (~$0–50k) and 1.20% at 420–1,470 SOL (~$50k–176k)**. The fee falls to 0.30% only above 98,240 SOL ([pump.fun fees, 2026-05-20](https://pump.fun/docs/fees)). Jupiter's /order path adds **50 bps for tokens under 24h old** and 10 bps for "all other pairs"; /build charges no Jupiter platform fee ([Jupiter fees](https://developers.jup.ag/docs/swap/fees), [Swap overview](https://developers.jup.ag/docs/swap/index.md)). Round trip for a fresh graduate via /order is about 3.4% before slippage. Each extra exit transaction costs about $0.0125 at a 0.0001 SOL priority fee and about $0.06 at 0.0005 SOL. On a $1 half-tranche that is 1.3% to 6%. **At $2, use at most two exit transactions.**
6. **Copy trading loses most of the leader's edge.** Smart-money wallets averaged 14% per trade, but copiers made about 3% per trade after realistic frictions. Bundle bots appear in about a quarter of projects and sniper bots in the majority ([Luo et al., WWW 2026, arXiv 2601.08641](https://arxiv.org/html/2601.08641v2)). Influencer mentions earn +1.83% on day 1 and then −19% average after three months ([Merkley et al., Review of Accounting Studies 2024](https://ideas.repec.org/a/spr/reaccs/v29y2024i3d10.1007_s11142-024-09838-4.html)).
7. **Regimes change fast, and models trained on one month fail the next.** The share of profitable pump.fun wallets (realized PnL only) ranged from 30.1% (Jun 2025) to 73.3% (Apr 2026) ([CoinGecko, 2026-05-07](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)). A graduation model scored AUROC 0.859 in development and 0.464 on the next 14 days ([Kamat, arXiv 2607.02823 v4, 2026-09-10](https://arxiv.org/abs/2607.02823); single author, not peer reviewed).

---

## 1. Position sizing

### 1.1 Definitions (Van Tharp)
- **R** is the initial planned risk: (entry − stop) × quantity. A trade stopped exactly at plan is −1R. A trade that makes twice its risk is +2R. Tharp defines R as "the initial risk taken in a given position, as defined by one's initial stop loss" ([Van Tharp Institute](https://vantharp.com/Weekly_update/Weekly_273_May_31_2006.htm); [Tharp, S&C 2007 abstract](https://www.traders.com/Documentation/FEEDbk_docs/2007/01/Abstracts_new/Tharp/tharp.html)).
- **Expectancy** is the mean R-multiple per trade, equal to win% × avg win(R) − loss% × avg loss(R).
- **SQN** is mean(R) / sd(R) × √n ([SQN description](https://journalplus.featurebase.app/p/system-quality-number-sqn-is-a-performance-metric-using-r)). Use it only as a t-statistic-like screen.

**Memecoin adaptation (needed).** A stop does not cap a loss at −1R. Gaps, rugs and blocked sells produce −3R to −7R outcomes: with a 15% stop, a −100% loss is −6.7R. The journal must record realized R, not planned R. The tail must be modelled explicitly:

```
Expected loss on a losing trade  L(q) = q · [ P_cat · 1.0 + (1 − P_cat) · (s + σ_slip) ] + q · v + F
```

where q = notional, P_cat = probability that a loser is catastrophic (rug, honeypot, blocked exit or gap to near zero), s = stop distance, σ_slip = expected slippage beyond the stop, v = proportional round-trip cost (pool fees, Jupiter fee and price impact), and F = fixed cost (signatures, priority fees, tips and expected failed attempts). The brief's screening formula `q·(g − v) − F` is right **only if g is the mean of the full return distribution including the catastrophic tail**. State that explicitly in ARCHITECTURE.md.

### 1.2 Worked numbers for $20 (assumptions: v = 3.5%, σ_slip = 5%, F = $0.03 per round trip)

| q | P_cat | stop s | L(q) | % of $20 |
|---|---|---|---|---|
| $2 | 3% | 10% | $0.45 | 2.3% |
| $2 | 5% | 15% | $0.58 | 2.9% |
| $2 | 10% | 25% | $0.84 | 4.2% |
| $5 | 3% | 10% | $1.08 | 5.4% |
| $5 | 5% | 15% | $1.41 | 7.0% |
| $5 | 10% | 25% | $2.06 | 10.3% |

Full-loss exposure is $2 (10%) or $5 (25%) plus costs, as the brief already states.

**Average gross win needed for zero expectancy at q = $2.** Here P_cat is the share of *all* trades that are catastrophic.

| P_cat (of all trades) | stop | win rate 30% | 40% | 50% |
|---|---|---|---|---|
| 5% | 15% | +77% | +52% | +38% |
| 5% | 25% | +98% | +66% | +47% |
| 10% | 15% | +90% | +62% | +46% |
| 10% | 25% | +110% | +75% | +54% |

Implication: under hostile base rates a scalping profile (target +10–20%, stop −15%) cannot break even unless the catastrophic rate is held well below 5%. The strategy needs either strong pre-trade filtering, which is the bot's real "edge", or right-tail capture (runners).

### 1.3 Kelly and fractional Kelly
- For a binary bet, f* = p − (1 − p)/b, where b is the payoff in R. In general f* maximizes E[log(1 + f·X)]. MacLean–Thorp–Ziemba: "the optimal Kelly wager is the edge (expected return) divided by the odds". Kelly "can be very risky in the short term". Betting **2× Kelly gives zero growth** (continuous approximation): "it never pays to bet more than the Kelly strategy". Errors in means matter about 20:2:1 relative to errors in variances and covariances ([Good_Bad_Kelly.pdf, 2010-01-01](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf)).
- In the continuous approximation g(f) = fμ − f²σ²/2. Half Kelly gives exactly 3/4 of the maximum growth rate at 1/2 the volatility. This is my derivation from that formula; it is standard.
- **Parameter uncertainty (computed).**

| true p | b | full f* | n = 30, p − 1 SE → f* | n = 100 | n = 300 |
|---|---|---|---|---|---|
| 0.40 | 2.0 | 0.100 | −0.034 | 0.027 | 0.058 |
| 0.35 | 3.0 | 0.133 | 0.017 | 0.070 | 0.097 |
| 0.50 | 1.2 | 0.083 | −0.084 | −0.008 | 0.030 |

  Conclusion: Kelly sizing is undefined or negative for this bot until there are hundreds of trades. **Do not use Kelly to size up.** Use it only as a ceiling check once n ≥ 200: never risk more than 1/4 of the Kelly computed at the lower confidence bound.
- Kelly also assumes known, stationary distributions. Kamat's temporal non-generalization result (AUROC 0.86 → 0.46 one fortnight later) is direct evidence that memecoin distributions are not stationary ([arXiv 2607.02823](https://arxiv.org/abs/2607.02823)).

### 1.4 How many trades before you know anything
To detect a mean expectancy E (in R) at one-sided 95% with an R standard deviation of sd, you need n ≈ (1.645·sd/E)².

| sd(R) | E = 0.1R | 0.2R | 0.3R |
|---|---|---|---|
| 1.0 | 271 | 68 | 31 |
| 1.5 | 609 | 153 | 68 |
| 2.0 | 1,083 | 271 | 121 |

The fat tail of memecoin R (catastrophes at −5R to −7R and runners at +5R) makes sd ≥ 1.5R likely. That is an assumption to be measured in paper mode. **Expect to need roughly 150–300 trades before any size increase is justified.** At three trades a day that is 7–14 weeks. Thorp makes the same point: separating a 1.0% edge from a 1.1% edge takes two million trials ([Good_Bad_Kelly.pdf](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf)).

### 1.5 Fixed fractional versus fixed notional at $20
Fixed fractional at 2% would mean $0.40 of risk per trade. That is only achievable at $2 notional with a ≤ 13% total stop including costs and P_cat ≈ 0, which is not realistic. Recommendation: **fixed notional of $2 is the risk unit.** Changes are allowed only through gates (section 7). Never use size to "recover" losses. Thaler & Johnson document the break-even effect: after losses, people prefer gambles that offer a chance to get back to even ([Management Science 1990](https://ideas.repec.org/a/inm/ormnsc/v36y1990i6p643-660.html)). For a bot, the risk is the owner editing limits after a losing streak, so lock config changes during a session.

### 1.6 Risk of ruin (Monte Carlo, 20,000 paths, 100 trades, at most 3/day, $20 start)
The return distributions are assumptions:
- S1 negative: 8% −95%, 50% −22%, 27% +15%, 15% +60%.
- S2 marginal: 5% −95%, 45% −20%, 32% +20%, 18% +70%.
- S3 positive: 4% −95%, 42% −18%, 32% +25%, 22% +90%.

Costs v = 3.5% and F = $0.03 are applied to every trade.

| Scenario | q | Net EV/trade | No limits: P(B ≤ $10) | Median final | With $3 daily stop and −30% kill: P(B ≤ $10) | Median final | Share of paths killed |
|---|---|---|---|---|---|---|---|
| S1 negative | $2 | −10.5% | 92.5% | $2.28 | 0.3% | $13.22 | 99% |
| S1 negative | $5 | −9.7% | 98.4% | $4.66 | 12.3% | $12.22 | 100% |
| S2 marginal | $2 | +0.2% | 9.5% | $20.50 | 0.04% | $19.60 | 37% |
| S2 marginal | $5 | +1.1% | 35.5% | $23.50 | 5.2% | $13.54 | 62% |
| S3 positive | $2 | +11.4% | 0.01% | $42.88 | 0.00% | $42.74 | 2% |
| S3 positive | $5 | +12.3% | 2.7% | $81.65 | 1.1% | $78.55 | 17% |

Reading the table:
- (a) The kill switch is what bounds the loss when the edge turns out to be negative, which is the realistic prior.
- (b) $5 sizing only pays off when the edge is clearly positive, and even then it brings a 17% kill-switch hit rate.
- (c) With a marginal edge, $5 sizing gives a 1-in-3 chance of halving the bankroll. Size up only after the edge is proven.

**Re-run with the coded policy (RISK-1, 2026-10-03).** Same distributions, costs and 3 entries a day, now with R6 to R10 exactly as `packages/core/src/risk` applies them and worst-case costs C = $0.80 per trade (updated after EXIT-1: the exit ladder plus 5 blocked-exit retries at the fee cap). Script: `research/risk/montecarlo.py` (seeded; 20,000 paths, 100 trades or 120 days).

| Scenario | q | §8 limits: P(B ≤ $10) | Median final | Killed | Paused for an R8 review | Mean trades |
|---|---|---|---|---|---|---|
| S1 negative | $2 | 0.00% | $17.94 | 0% | 79% | 8 |
| S2 marginal | $2 | 0.00% | $19.70 | 0% | 94% | 10 |
| S3 positive | $2 | 0.00% | $21.90 | 0% | 97% | 11 |
| any | $5 | 0.00% | $20.00 | 0% | 0% | 0 |

If every R8 review passes at once: S1 ends at a median $16.74 after 14 trades, S2 at $18.30 after 39, S3 at $40.70 after 77; still no path reaches $10 or the kill switch.

What it shows:
- R6(a) stops entries before the kill switch can trip: a new entry needs E ≥ 0.7·HWM + q + C, which is $16.80 at q = $2. The working floor is about 84% of the high-water mark, not 70%.
- R6(b) blocks every $5 entry at B = $20: q + C = $5.80 is more than 20% of week-start equity ($4). A $5 trade needs E_week_start ≥ $29.
- R8's "5 losses in any 20 trades" pauses almost every path within about 10 trades, even a profitable one, because these strategies lose 42% to 50% of trades. Expect a review pause roughly every 10 trades at that loss rate.

**Stress re-run (RISK-1b, 2026-10-03).** The merged policy (C = $0.80) with three stresses on top of the same distributions: a bad day (20% of days) on which every trade draws from S1, so losses come in streaks; same-creator rug clusters (after a −95% trade the next is a rug too with probability 0.5); and outages (10% of losing trades exit late, filling at the emergency rung, 25% below the stop, and a fifth of those become total losses). Every R8 review is assumed to pass at once so paths keep trading. Script: `research/risk/montecarlo.py` (seeded).

| Scenario | q | P(B ≤ $10) | Median final | Killed | Max drawdown: median | 95th | 99th | worst | Mean trades |
|---|---|---|---|---|---|---|---|---|---|
| S1 negative | $2 | 0.00% | $16.58 | 0.00% | 19.5% | 25.1% | 26.0% | 27.4% | 11 |
| S2 marginal | $2 | 0.00% | $17.15 | 0.00% | 20.0% | 25.6% | 26.4% | 27.5% | 20 |
| S3 positive | $2 | 0.00% | $18.92 | 0.00% | 20.9% | 26.2% | 27.2% | 28.4% | 32 |

With the same stress and no limits, P(B ≤ $10) is 99.3% (S1), 73.0% (S2) and 23.2% (S3). Reading it: the kill switch never trips because R6(a) never starts a trade whose full loss could cross the kill line, so the worst drawdown stays under 30% (28.4% in 20,000 paths); and under this stress even the positive scenario loses money (median $18.92): clusters and late exits remove the edge, which is what the backtest must measure before any deposit.

---

## 2. Stops

### 2.1 Stops are attempts
On regulated markets a stop "becomes a market order" and the "stop price is not the guaranteed execution price"; a stop-limit "may prevent the order from being executed" ([SEC investor bulletin: stop, stop-limit, trailing stop](https://www.investor.gov/additional-resources/news-alerts/alerts-bulletins/investor-bulletin-stop-stop-limit-trailing-stop)). On an AMM a bot-driven stop is weaker still. It needs:
1. detection, from a polled or streamed pool state;
2. a fresh quote and transaction build;
3. landing, at about 400 ms per slot plus queueing, with possible failure;
4. a market that does not move in between.

The price path between detection and landing is the main slippage source, not the bot's own price impact. On a constant-product pool the impact of selling $2 into $20k per side is about 0.01–0.02%.

**Latency cost evidence** (blog, not peer reviewed; treat as indicative): simulated copy trades on pump.fun bonding curves showed relative slippage of 2.54% at 0.5 s, 5.88% at 1 s, 11.30% at 2 s and 24.12% at 5 s for 5-SOL trades ([Kurnovskii, pump.fun copy-trading feasibility](https://romankurnovskii.com/en/blog/pumpfun-copy-trading-feasibility/)). Fast moves of 5–10% per second are plausible in thin memecoin pools. Budget σ_slip ≥ 5% on normal stops and treat larger values as possible.

**Gap risk sources specific to memecoins:**
- **Coordinated dumps.** Median 7 senders per dump, up to 312, found in a 1% pump.fun sample ([Szwajcok et al., arXiv 2609.10246, 2026-09-09](https://arxiv.org/html/2609.10246v1)).
- **Bundled supply.** Bundled accounts hold 36.5% of supply in high-risk tokens ([MemeTrans](https://arxiv.org/html/2602.13480v1)).
- **LP removal.** On Raydium, 93% of pools showed soft-rug characteristics and the median rug was $2,832 ([Solidus Labs 2025 Rug Pull Report](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance)). Canonical PumpSwap pools created by graduation burn the LP tokens (secondary source: [madeonsol](https://madeonsol.com/blog/pumpfun-revenue-sharing-pumpswap-fees-creators); verify on-chain), so the main gap risk there is a supply dump, not LP pull.
- **Token-2022 controls.** Freeze authority, permanent delegate and transfer hooks (the brief already covers these).

### 2.2 Stop types and what to use
- **Structure-based (primary).** The stop goes below the invalidation level of the setup, such as the higher low that defined a pullback entry. It is only valid if the distance is ≤ s_max. If the structure needs a wider stop, **skip the trade**; never widen the stop to fit.
- **Volatility-based (cap and sanity check).** s = k × ATR(n) on 1-minute or 5-minute bars from executable-price samples. Reject entries where k·ATR > s_max: the token is too volatile for the risk budget. Le Beau's Chandelier default is 22 periods × 3 ATR, with the guidance that "more volatile stocks... require a bigger buffer" ([StockCharts ChartSchool](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit)). The 22 periods correspond to a month of daily bars, so for minute bars the parameters must be refit in paper mode. Starting hypothesis: ATR(14) on 1-minute bars, k = 2.5–3.
- **Time stop (mandatory).** Exit if the thesis has not progressed (for example, not +0.5R) within T minutes. Kaminski & Lo show that stop-loss rules reduce expected return under a random walk and add value only when returns have momentum or serial correlation ([J. Financial Markets 18, 2014](https://dspace.mit.edu/handle/1721.1/114876)). Memecoin attention decays, so a flat position is a decaying position: cut it.
- **Thesis or flow stops.** Exit if a deployer or top-10 non-pool holder sells more than X% of supply, if liquidity drops more than Y%, if a sell route disappears, or if net buyer flow turns negative for Z minutes. These often fire **before** the price stop and are the bot's best defence against gaps.
- **Disaster stop and emergency escalation.** As in the brief: bounded slippage and fee escalation, then "exit blocked".
- **Trigger source.** Use executable liquidation value from a reverse quote or the pool state, never a last-trade print. This confirms the brief.

---

## 3. Profit taking

- **Scaling out / "take initials".** Practitioner habit (anecdote, widely repeated in Solana trading communities): sell enough at about 2x to recover the initial stake and let the rest "ride for free". This improves the *distribution*: lower variance and fewer round trips from winner to loser. It does not change expectancy unless there is path dependence (momentum then reversal), which is the typical memecoin shape.
- **Fixed-cost trade-off at $2 (computed).** One extra exit transaction costs about $0.0125 at a 0.0001 SOL priority fee and about $0.06 at 0.0005 SOL. On a $1 tranche that is 1.25%–6.0% of the tranche. Proportional pool and Jupiter fees do not change with scaling. The token account rent of 0.00203928 SOL (≈ $0.244, which is 12% of a $2 trade) is recovered only after the full balance is sold and the account is closed. A runner that dies leaves dust and strands the rent unless the bot sells the remainder or burns and closes.
  - **Rule:** at q = $2, use at most one partial and one final exit. The partial is ≥ 50% of the position and is only allowed when the unrealized gain is ≥ +1.5R, so the fixed cost is under 2% of the tranche. At q ≥ $4, up to three exits.
- **Trailing exits on short bars.** After +1R, move the stop to break-even plus costs. After the partial, trail the runner with a chandelier stop: highest executable price since entry − k × ATR(14, 1-minute), with k starting at 3. Fit k in paper mode. The trail must also respect flow stops. Candle-based trails cannot see intrabar order (the brief already notes this), so replay on transaction-level data.
- **Hard maximum hold.** Every position closes by T_max even when profitable. Attention decay plus the regime evidence shows that holding open-ended is unsafe for an unattended bot.

---

## 4. Portfolio controls professionals use (and how they translate)

| Professional rule | Source | Translation for $20 |
|---|---|---|
| ≤ 2% capital at risk per trade | Elder ([summary](https://www.incrediblecharts.com/trading/6_percent_rule.php); [TD Ameritrade tickertape](https://tickertape.tdameritrade.com/trading/rules-to-manage-risk-15908)) | Not achievable at a $2 minimum (planned 1R ≈ $0.45–0.60). Compensate with one position, a small daily trigger and a kill switch. |
| Stop trading for the month after a 6% monthly loss | Elder 6% rule, "Come Into My Trading Room" ([Incredible Charts](https://www.incrediblecharts.com/trading/6_percent_rule.php)) | Weekly pause at −$4 (−20%) and a hard kill at −$6 (−30%) from the high-water mark. Scaled up because one full loss is already 10%. |
| Max daily loss 5% (2-Step) / 3% (1-Step), including floating P&L | FTMO ([trading objectives](https://ftmo.com/en/trading-objectives/), fetched 2026-10-03) | Daily trigger at −$1.50 realized plus marked (≈ 3 planned losses). Pause entries, keep exits. Worst-case daily budget = $1.50 + one open position principal. |
| Max loss 10%: static (FTMO 2-Step) or trailing end-of-day (FTMO 1-Step, Topstep) | FTMO; Topstep (secondary summary: [TradersPost](https://blog.traderspost.io/article/topstep-review); primary [Topstep help](https://intercom.help/topstep-llc/en/articles/8284197)) | Trailing kill switch at 30% below the equity high-water mark, capped at the $20 start; manual re-arm only. |
| Consistency rule: best day < 50% of profits | FTMO 1-Step "Best Day Rule"; Topstep consistency target | A promotion gate: no single trade may supply > 50% of cumulative net P&L when evaluating an edge. This screens out lottery-ticket "edges". |
| Reduce risk as drawdown grows | MacLean–Thorp–Ziemba ([2010](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf)) | Size can only step down. At $2 there is no lower step, so drawdown leads to a pause, not smaller trades. |
| No averaging down; one idea at a time | Common professional discipline; brief already bans it | Also: no re-entry on the same mint within 24h after a stop, and at most one entry per mint per day. |
| Max consecutive losses then cooldown | Prop-desk practice (anecdote: no primary dataset found) | 2 consecutive losses → 2h cooldown; 3 → stop for the day; 5 within 20 trades → stop and review. |
| Overtrading destroys returns | Barber, Lee, Liu, Odean: fewer than 1% of Taiwanese day traders predictably earn positive abnormal returns net of fees ([J. Financial Markets 18, 2014](https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html)) | Max 3 entries per day (brief hypothesis kept). Remove the cap only after the edge is proven per trade, not per day. |
| Journaling and review | Tharp: judge a system by its R distribution ([Van Tharp Institute](https://vantharp.com/Weekly_update/Weekly_273_May_31_2006.htm)) | Automated journal per trade: setup ID, evidence snapshot, planned R, realized R, MAE/MFE in R, quote versus fill slippage, fees, exit reason, regime tags. Daily auto-summary; weekly review every 20 trades; promotion review at 50/100/200 trades. |

---

## 5. What data says about memecoin outcomes and profitable traders

### 5.1 Retail outcomes (data)
- **Pump.fun wallet PnL, realized only.** Profitable-wallet share was below 50% in most months from Apr 2024 to Jan 2026, with a minimum of 30.1% in June 2025. It rose to 56.8% in Feb 2026, 70.0% in Mar and 73.3% in Apr 2026. In Apr 2026, 65.1% of profitable wallets made $1–$500 and 5.4% made more than $1,000. Monthly active wallets fell from 5.2M (May 2025) to 1.8M (Dec 2025). CoinGecko attributes the rise to unprofitable traders leaving. Caveats: realized PnL only (this "understates losses"), bots and wash trading not filtered, and Dune pricing can be "missing, stale, or distorted" ([CoinGecko, 2026-05-07](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback); [Dune dashboard](https://dune.com/coingecko_content/pump-fun-annual-trader-profitability); [Crowdfund Insider, 2026-05-11](https://www.crowdfundinsider.com/2026/05/277755-solana-based-meme-coins-trading-platform-pump-fun-makes-recovery-research/)).
- **Earlier Dune snapshot (Jan 2025).** 55,296 of 13.55M wallets (0.412%) had realized more than $10k; about 0.048% more than $100k; 293 wallets (0.00217%) more than $1M. Caveat: post-graduation DEX trades may be excluded ([Cointelegraph](https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data); [Decrypt](https://decrypt.co/300403/pump-fun-traders-millionaires)).
- **6-month Dune snapshot reported June 2025.** "Over 60%" (62.5%) of 4.2M wallets had losses; 27.2% were profitable ([crypto.news, 2025-06-05](https://crypto.news/over-60-pump-fun-traders-saw-losses-less-than-0-01-made-over-1m/)). The query author is not named, so methodology is unverified.
- **Profit concentration.** "Top 1% of profitable wallets captured 81.4% of all gains" appeared in a search summary attributed to an arXiv study of DeFi agents ([arXiv 2605.29174](https://arxiv.org/pdf/2605.29174)). **Unverified**: I did not read the primary text.
- **Day trading generally.** Fewer than 1% of day traders are predictably profitable net of fees ([Barber et al. 2014](https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html)).

### 5.2 Token outcomes (data)
- **Fraud prevalence.** 98.6–98.7% of pump.fun tokens (over 7M, Jan 2024 to Mar 2025) showed pump-and-dump or rug characteristics. Fewer than 100k kept ≥ $1k liquidity ([Solidus Labs, 2025-05](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance); [ForkLog](https://forklog.com/en/report-98-of-pump-funs-memecoins-deemed-scams/)).
- **Graduation rate.** 0.63% (Sep 2025, n = 655,770). Graduation probability conditional on curve fill was about 35% at 80 SOL virtual and about 64% at 100 SOL. Buying on the curve breaks even only if p(grad) > (vSol/115)², and most conditional curves lie below that line. 92.22% of tokens with ≥ 30 swaps show dump events. Median graduation took 457 trades and 4.4 minutes ([Marino et al.](https://arxiv.org/html/2602.14860v1)). Pooled graduation in 2026 data: 0.198% ([Kamat](https://arxiv.org/html/2607.02823v3), lower confidence). Dune (adam_tehc) via Cryptopolitan: 1.15% in Feb 2026, with a range of 0.5–2% over time ([Cryptopolitan, 2026-02-19, updated 2026-05-05](https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/)).
- **After migration.** 60.26% of 41,470 migrated tokens (Dec 2024 to Mar 2025) hit < 0.2× their migration price within 20 minutes. 84.13% were classed high-risk (price < 0.3× within 20 minutes, or a manipulation score ≥ 0.7). A random buy at migration with a random exit within one hour lost 60.71% on average. The MLP risk filter cut losses by "up to 56%" ([MemeTrans](https://arxiv.org/html/2602.13480v1)). Note: this sample is mostly from before PumpSwap (Raydium migrations).
- **Manipulation at scale.** Of 15.2M pump.fun coins: wash trading made up 17% of transactions in a 1% sample, rising to 50.31% for coins with ≥ 10k transactions. Wash-traded coins graduate at 2.0% versus 0.90% for others, so **activity metrics are gamed and graduation is partly bought**. 1.49M copycat coins graduate at 0.86% versus 9.20% for originals. The top 1% of creator clusters made 58.6% of coins. "Market-Manipulation-as-a-Service" sites sell bundling and comment bots ([Szwajcok et al., 2026-09-09](https://arxiv.org/html/2609.10246v1)).
- **High returns are mostly manufactured.** 82.8% of 707 cross-chain memecoins with > 100% return showed artificial-growth indicators. 62.9% of profit-extraction cases were preceded by wash trading or LP-based inflation ([Mongardini & Mei](https://arxiv.org/pdf/2507.01963)).
- **Coordinated sniper rings.** 1,012 persistent wallet cohorts were found. They raise first-30-minute buyer *count* by +16.1% (95% CI +13.0% to +19.4%) but SOL inflow by only +6.3% (CI includes 0). 7.0% of treated launches had zero outside buyers in the first 30 minutes ([Kamat, arXiv 2607.02795](https://arxiv.org/abs/2607.02795), lower confidence). **Implication: raw "unique buyer" counts overstate demand; weight buyers by SOL and by independence of funding.**
- **Unverified.** A widely repeated figure that "of 15,548 graduated tokens only 19.7% still had ≥ $5k liquidity at 24h" could not be traced to a primary dataset. Do not use it.

### 5.3 Habits of consistently profitable traders
**Data:**
- **Speed bots versus manual traders.** In one blog analysis, sub-5-second-hold wallets (14.2% of wallets) were 58.1% profitable versus 12.4% for manual traders holding more than 5 minutes ([Kurnovskii](https://romankurnovskii.com/en/blog/pumpfun-copy-trading-feasibility/), indicative only). Profits concentrate in infrastructure-advantaged actors (snipers, bundlers, deployers), which this bot cannot and should not be.
- **Smart money.** Luo et al. identify smart money by consistent profitability, a t-stat > 1.645, sufficient volume, low return volatility and tenure. Those wallets averaged 14% per trade, but copiers got about 3% after frictions, and most statistic-only copy approaches were negative. Named pitfalls: latency, imitation price impact, bots built to look like smart money, and the convex bonding curve that penalizes late entrants ([arXiv 2601.08641](https://arxiv.org/html/2601.08641v2)).
- **Influencers (KOLs).** Mentions give +1.83% on day 1 and −19% after three months. The effect is strongest for small caps, self-styled experts and accounts with large followings ([Merkley et al. 2024](https://ideas.repec.org/a/spr/reaccs/v29y2024i3d10.1007_s11142-024-09838-4.html)). Social manipulation: 23.5% of pump.fun coins were created after X or Truth Social posts, and the median post was worth only $135 of extractable value ([Szwajcok et al.](https://arxiv.org/html/2609.10246v1)).
- **Graduation predictors.** Fewer trades to reach the same curve level and ≥ 70% non-bot trading predict graduation. "Successful traders present" has only a "modest and non-monotonic effect" ([Marino et al.](https://arxiv.org/html/2602.14860v1)).

**Anecdote** (practitioner consensus; useful as hypotheses, not evidence):
- Wait for the post-migration flush before buying, and do not buy the migration candle.
- Do not chase vertical candles. Enter on pullbacks that hold a higher low with rising holders.
- Take initials at about 2x. Size small and constant.
- Avoid tokens where bundles or the top 10 holders hold a large share.
- Treat KOL calls as exit-liquidity signals.
- Copy only wallets with long, consistent histories and median holds longer than minutes.
- Leading copy-trading wallets attract followers and then dump on them; "one big win tells you nothing" (e.g. [medium/@nathan.baldwin](https://medium.com/@nathan.baldwin_31153/copy-trading-on-solana-how-to-find-alpha-wallets-without-getting-faked-out-by-bots-0bc550f07290)).

Several of these anecdotes are consistent with the data above: the migration-flush statistic, the wash-trading and graduation link, and copier underperformance.

### 5.4 Market regime
**Data:**
- The profitable-wallet share swings between 30% and 73% month to month (CoinGecko).
- The graduation rate swings from 0.5% to 2% (Dune via Cryptopolitan).
- Model AUROC collapses one fortnight later (Kamat).

**Recommendation (hypothesis to test):** a regime gate that is "on" only when:
- (a) launchpad graduations or volume over the trailing 24h are at or above the trailing 30-day median;
- (b) SOL/USD 24h change > −5%;
- (c) the bot's own rolling 20-trade paper expectancy (in R) is > 0.

When the gate is off, keep observing and paper-trading, but take no live entries. Track all three gates as features so their value can be ablated.

---

## 6. Brief claims checked (my area)
See the structured output. In short: the arithmetic claims are confirmed and the fee claims are confirmed. Two claims are incomplete: `q·(g−v) − F` must use a tail-inclusive g, and the risk table lacks numeric defaults and kill-switch and cooldown rules.

---

## 7. Risk policy spec (defaults for the $20 trial)

All values are **defaults to be versioned**. Changes require a new policy version, cannot be made while a session is running, and can never be made by the model or LLM.

| # | Control | Default | Rationale |
|---|---|---|---|
| R1 | Trading bankroll B0 | $20 USD-equivalent in the bot wallet, excluding the SOL ops reserve | brief |
| R2 | SOL ops reserve (separate, protected) | ≥ 0.015 SOL (≈ $1.80): rent for 1–2 token accounts (0.00204 SOL each) plus about 10 exit attempts at ≤ 0.0005 SOL. Entries blocked if below. | rent and fees ([Solana fees](https://solana.com/docs/core/fees)); assumption |
| R3 | Entry notional q | $2 fixed in phase 1 | $2 is the floor; sections 1.5–1.6 |
| R4 | Size ladder | $3 only after ≥ 100 live+shadow trades with lower 90% CI of net expectancy > 0, max drawdown < 25%, and the best trade < 50% of net P&L. $5 only after ≥ 200 trades meeting the same tests and equity ≥ $20. Any 10% drawdown from the high-water mark → back to $2. | 1.4, 1.6, consistency rule |
| R5 | Planned risk per trade (1R) | q × s + costs ≤ $0.55 at q = $2 (≤ 2.75% of B0); s_max = 20% | 1.2 |
| R6 | Catastrophic allowance | q + max costs reserved against the daily and kill budgets before entry | brief, 1.1 |
| R7 | Stop | Structure-based. Skip if the needed distance > s_max or > 3 × ATR(14, 1-minute). Trigger on executable quote value. | 2.2 |
| R8 | Stop slippage ceiling | Normal: quoted min-out ≤ 8% below trigger. Emergency escalation: up to 25%, then up to 50% with "exit blocked" alert. Fee ceiling 0.0005 SOL per attempt; max 5 attempts per exit. | 2.1; assumption |
| R9 | Flow and thesis stops | Exit if any of these holds: deployer or linked cluster sells > 2% of supply; pool liquidity −30% from entry; reverse quote fails twice; net SOL flow negative for 5 consecutive minutes after entry | 2.2 |
| R10 | Time stop | Exit if not ≥ +0.5R by T_flat (strategy-specific, 10–30 min). Hard T_max 120 min (phase 1). | 2.2, 3 |
| R11 | Profit taking at q = $2 | ≤ 2 exit transactions: partial ≥ 50% at ≥ +1.5R (or take initials at +100%, whichever first). Runner: breakeven+costs, then chandelier trail (k = 3 × ATR14 on 1-minute bars). | 3 |
| R12 | Cost gate | Reject if modelled round-trip cost (pool fee tier × 2 + Jupiter fee × 2 + quoted impact × 2 + fixed/q) > 5% or > 1/3 of the strategy's median target. Prefer /build to avoid Jupiter's 50 bps new-token fee if the execution research supports it. | 0.5, 1.2 |
| R13 | Positions | 1 open or unresolved | brief |
| R14 | Max entries | 3 per UTC day; 1 per mint per day; no re-entry on a stopped-out mint for 24h | Barber et al.; anti-revenge |
| R15 | Daily loss trigger | −$1.50 realized + marked → pause new entries until 00:00 UTC; exits keep running. Worst-case daily budget = $1.50 + one position principal (≤ $3.55 at q = $2). | FTMO analogue |
| R16 | Consecutive losses | 2 losses in a row → 2h cooldown; 3 → pause for the rest of the day; 5 losses in any 20 trades → pause and require review | prop practice; anecdote |
| R17 | Weekly loss trigger | −$4 (20%) from the week-start equity → pause for the rest of the ISO week; review required | Elder 6% analogue |
| R18 | Hard kill switch | Equity ≤ 70% of the high-water mark (≤ $14 from $20) → entries disabled; only the owner can re-arm, after a written review | Monte Carlo 1.6; FTMO/Topstep max loss |
| R19 | No martingale or averaging | Never add to a losing position; never increase q after a loss; never change policy mid-session | brief; Thaler & Johnson |
| R20 | Regime gate | Live entries only when the regime gate (5.4) is on; otherwise paper only | 5.4 |
| R21 | Pre-trade checklist (machine) | All must pass and be logged: identity resolved; token program/extensions on allowlist; mint and freeze authority revoked; sell route quote OK; liquidity ≥ max($15k, 1,000 × q); bundle/top-10 non-pool holders ≤ 30% (assumption, to be fitted); dev cluster holdings ≤ 5%; token age and strategy window OK; not within 20 min of migration; cost gate; regime gate; risk budget reserved | brief, 5.2 |
| R22 | Journal | Per trade: strategy ID and version, evidence snapshot hash, planned R, realized R, MAE/MFE in R, quote versus fill, fees split, exit reason, regime flags, counterfactual "no-trade" baseline | 4 |
| R23 | Review cadence | Automated daily summary; human review every 20 trades or weekly; promotion review at 50, 100 and 200 trades; post-mortem on every −2R or worse trade | 4 |
| R24 | Promotion gates (paper → live) | ≥ 100 paper or shadow trades, positive expectancy lower bound (90%) after modelled costs, paper fill model validated against shadow quotes (median absolute error < 1%), no unresolved exit-blocked incidents | brief, 1.4 |

---

## 8. Candidate strategies for paper mode

Every strategy runs alongside **S0, a random-entry control** with the same eligibility filters and the same exits. A strategy earns promotion only by beating S0 out of sample. MemeTrans used exactly this kind of random baseline. All thresholds are starting hypotheses.

### S1. Post-graduation flush and reclaim ("second leg")
- **Universe:** canonical PumpSwap pools, graduated 20–240 minutes ago. Skip the first 20 minutes because 60% of migrated tokens hit < 0.2× migration price inside that window (MemeTrans). The R21 checklist must pass.
- **Setup:**
  1. Drawdown of 40–75% from the post-migration high, then a higher low on 1-minute bars.
  2. Price reclaims the volume-weighted average price since migration.
  3. SOL-weighted net buy flow over 10 minutes > 0 and buy/sell SOL ratio ≥ 1.3.
  4. Independent new holders rising: exclude wallets with a common funder within 2 hops.
  5. No single 1-minute candle > +25% in the prior 3 minutes (no chasing).
- **Entry:** on the first 1-minute close above the reclaim level.
- **Invalidation:** below the higher low (≤ 20%), or any R9 flow stop.
- **Exits:** 50% at +1.5R or +100%; runner on a chandelier trail; T_flat 15 minutes; T_max 90 minutes.
- **Expected failure modes:**
  - The dead-cat bounce is engineered: wash buys to create the "reclaim" (17–50% of transactions can be wash; Szwajcok).
  - A second dump by the bundle cluster.
  - High fees: 1.20–1.25% pool fee per side plus 0.5% Jupiter /order per side because the token is < 24h old.

### S2. Established-token range breakout
- **Universe:** age 24h–14 days, so the Jupiter new-token fee does not apply (/order fee 10 bps), market cap ≥ 1,470 SOL (≈ $176k at the time of writing), so the pool fee is ≤ 1.15% per side; liquidity ≥ $40k.
- **Setup:** at least 2h of consolidation with a range width ≤ 35%. Breakout above the range high on 5-minute volume ≥ 2× the range median, with holder count rising over 1h.
- **Entry:** retest or hold of the breakout level within 10 minutes. Skip if price is already > 15% above the range high.
- **Invalidation:** back inside the range below its midpoint (≤ 18%).
- **Exits:** 50% at +2R; runner on a chandelier trail (ATR14 on 5-minute bars × 3); T_flat 30 minutes; T_max 4h.
- **Failure modes:** false breakouts in a weak regime; KOL-timed distribution into the breakout (Merkley reversal pattern); slower moves, so fewer runners.

### S3. Independent smart-money confluence (delayed and filtered)
- **Wallet set:** rebuilt weekly from on-chain history using Luo et al.-style criteria:
  - ≥ 50 closed trades in 30 days;
  - realized PnL t-stat > 1.645;
  - median hold ≥ 10 minutes, which excludes speed bots we cannot match;
  - no common funder with other set members;
  - not a deployer or early bundler of the tokens it trades.
- **Trigger:** ≥ 3 set wallets buy the same mint within 30 minutes, and price is < +30% above the first set-wallet buy. The R21 checklist passes.
- **Invalidation:** ≥ 2 set wallets sell, or the stop (≤ 20%).
- **Exits:** mirror the set-wallet exits or apply S1-style exits; T_max 2h.
- **Failure modes:**
  - Latency and imitation penalty (14% → 3% in Luo et al.).
  - Farmed or bait wallets that build a record and then dump on followers.
  - The wallet set decays as the regime shifts. Measure set-level hit rate weekly and drop wallets that fall below threshold.

### S4. Abstain-first "no-trade is a position" overlay (meta-strategy)
- Not an entry signal. It is a strict filter applied on top of S1–S3: skip any candidate where the R21 checklist has an unknown field, the regime gate is off, the cost gate fails, or the MemeTrans-style high-risk features are present: bundled share > 30%, early-10-buyer share elevated, few transactions with large per-transaction volume.
- Measure its value as the loss avoided versus the same strategies without the overlay. MemeTrans reports up to 56% loss reduction for a learned filter of this kind.
- **Failure mode:** over-filtering to zero trades. That is acceptable in paper mode, and an empty interval correctly means "do not trade".

### S5 (optional, research only). Bonding-curve late-stage entry
- Buy at vSol ≥ 100 SOL only when the conditional graduation probability for tokens with low trade counts and ≥ 70% non-bot flow exceeds (vSol/115)² by a margin (Marino et al.).
- Paper only, and probably negative after the 1.25% curve fee and latency. Include it to *measure* rather than to deploy, because it is close to "launch sniping", which the brief excludes.

---

## 9. Open questions and verification tasks
- Measure the real per-transaction priority fee and tip needed to land exits within 2 slots during busy periods. My $0.0125–$0.06 range is an assumption based on 0.0001–0.0005 SOL.
- Measure σ_slip, the realized slippage beyond the stop trigger, and P_cat for each strategy in shadow mode. All the Monte Carlo inputs are assumptions.
- Confirm that canonical PumpSwap pools burn LP at graduation, on-chain, for current migrations.
- Check whether MemeTrans' post-migration collapse rates (Dec 2024 to Mar 2025, mostly Raydium) still hold for 2026 PumpSwap graduates. Replicate them with our own data.
- Determine whether the 2026 rise in the profitable share reflects real conditions or survivorship and the realized-only metric. It could change the regime gate.
- Check whether /build with direct PumpSwap routing is reliable enough to avoid the 50 bps Jupiter new-token fee (execution-topic research).

## 10. Loss review (R8) and a return-based monitor

Synthetic results from `research/risk/loss_review.py`. They describe the two rules on invented return models, not the bot's performance. 20,000 paths × 100 episodes. h was chosen on seed 810 and every table below runs on the independent seed 281011. The calibration rule was registered in DECISIONS before the run.

**R8 as coded** (`core/src/risk/evaluate.ts`, R8 review): pause for review when any window of the last 20 trades since the last review, shorter prefixes included, holds 5 or more losses. It counts signs only.

Exact chance of 5 or more losses in one window of 20 independent trades, by win rate p:

| p | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 |
|---|---|---|---|---|---|
| P(review) | 99.97% | 99.41% | 94.90% | 76.25% | 37.04% |

- **Signs are not outcomes.** Take two sequences with the same signs, 16 wins and 4 losses in 20:
  - A: wins +30%, losses −2%; compounded ×61.4.
  - B: wins +1%, losses −95%; compounded ×0.0000.
  - R8 pauses neither and cannot tell them apart. The CUSUM below reaches 0.015 on A and 3.6 on B.
- **R8 pauses every profitable model tried.** In all three in-control models (S2 and S3 net of v, and 10% at +100% / 90% at −5%), 100% of paths are paused within 100 episodes. The median first pause comes at episode 9, 10 and 5. At these loss rates R8's review measures the loss rate, not whether the strategy works.

**The candidate monitor** is a CUSUM on episode net returns: S_i = max(0, S_{i−1} − z_i − κ), with κ = 0.005 and an alarm at S_i ≥ h.
- h = 7.1: the smallest value with at most 5% alarms within 100 episodes for every in-control model. The first grid (to 4.00) held none, so it was extended on the training seed before validation; DECISIONS records this.
- The binding model is S2 net (+1.75% a trade). Its path maximum has median 3.4 and 95th percentile 7.05.

| In control (validation seed) | mean | R8 paused | CUSUM alarm |
|---|---|---|---|
| S2 marginal, net | +1.75% | 100% | 4.89% (bound 5.31%) |
| S3 positive, net | +12.94% | 100% | 0.07% |
| 10% at +100%, 90% at −5% | +5.50% | 100% | 0.00% |

| Stress | mean | R8 | CUSUM |
|---|---|---|---|
| Clustered losses (S3 shape; the mean is negative, so alarms are wanted) | −3.62% | 100% | 51.9% |
| S3 with 1% at −105% | +11.77% | 100% | 0.18% |
| S3 with deviations doubled (same mean) | +12.91% | 100% | 34.6% |

**False pauses accumulate.** The 5% target is per 100 episodes, not a fixed-level test. Over a longer in-control run the share of paths falsely paused keeps growing (validation seed):

| In control | by 100 | by 250 | by 500 | by 1,000 episodes |
|---|---|---|---|---|
| S2 marginal, net | 5.05% | 22.2% | 44.0% | 71.4% |
| S3 positive, net | 0.06% | 0.18% | 0.41% | 1.02% |

So "paused" is evidence to be read against the number of episodes observed. A marginal strategy will eventually be flagged.

The CUSUM also alarms on a rise in variance at the same positive mean: 34.6% of S3 paths alarm when every deviation is doubled. It reads severe losses, whether they come from a worse mean or from a wider spread.

**Change detection.** The first 50 episodes are at the design edge (S3's shape shifted to +5%); the last 50 are shifted. Columns give alarms in the first 50, alarms in the last 50, and the median delay.

| Change | R8 | CUSUM |
|---|---|---|
| −2 points, every return lower | paused before the change on every path | 0.66% / 4.46% / 33 |
| −2 points, more losses of the same sizes | paused before the change on every path | 0.56% / 4.70% / 32 |
| −8 points (+5% → −3%, losing) | paused before the change on every path | 0.54% / 16.6% / 35 |

- κ does not rescue it. With h re-chosen by the same rule, κ = 0, −0.01 and −0.02 give h = 7.4, 8.05 and 8.8, and the −8 point detection stays at 15–16%.
- **The limit is the data, not the rule.** One episode's return has an SD of about 0.40–0.47, so the mean of 50 episodes has a standard error of about 6 points. A −8 point drop is 1.2–1.4 standard errors. No rule holding 5% false alarms on a +1.75% strategy can reliably see it within 50 episodes.

**What follows** (observation only; the supervisor's card, no rule changes):
- R8's review is close to certain for any profitable meme strategy with a 40–60% loss rate, and blind to loss size. A return-based monitor sees what R8 cannot: severe losses with few losing signs, and a negative mean.
- Within about 50 episodes the CUSUM catches catastrophic decay, not modest decay. Modest decay is G3's and the demotion e-process's job, over longer windows.
- Replacing or loosening R8 is a loosening and stays the owner's decision. STRATEGY-HEALTH-OBS records the monitor's states beside every decision so that this question can later be answered on the bot's own episodes.

## Sources (accessed 2026-10-03)
- MemeTrans, Hu et al., arXiv 2602.13480, 2026-02-13: https://arxiv.org/html/2602.13480v1
- Marino, Naviglio, Tarantelli, Lillo, arXiv 2602.14860, 2026-02-16: https://arxiv.org/html/2602.14860v1
- Szwajcok, Tsuchiya, Liu, Soska, Payer, Christin, arXiv 2609.10246, 2026-09-09: https://arxiv.org/html/2609.10246v1
- Mongardini & Mei, arXiv 2507.01963v2, 2026-01-02: https://arxiv.org/pdf/2507.01963
- Luo, Feng, Xu, Liu, WWW 2026, arXiv 2601.08641v2, 2026-01-26: https://arxiv.org/html/2601.08641v2
- Kamat, arXiv 2607.02823 v4, 2026-09-10 (single author): https://arxiv.org/abs/2607.02823
- Kamat, arXiv 2607.02795 v3, 2026-08-03 (single author): https://arxiv.org/abs/2607.02795
- Mancino, arXiv 2512.11850, 2025-12-18: https://arxiv.org/html/2512.11850v3
- CoinGecko research, 2026-05-07: https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- Crowdfund Insider, 2026-05-11: https://www.crowdfundinsider.com/2026/05/277755-solana-based-meme-coins-trading-platform-pump-fun-makes-recovery-research/
- Cointelegraph (Jan 2025 Dune data): https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data
- Decrypt: https://decrypt.co/300403/pump-fun-traders-millionaires
- crypto.news: https://crypto.news/over-60-pump-fun-traders-saw-losses-less-than-0-01-made-over-1m/
- Solidus Labs 2025 Rug Pull Report: https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance
- ForkLog on Solidus: https://forklog.com/en/report-98-of-pump-funs-memecoins-deemed-scams/
- Cryptopolitan (graduation rate), 2026-02-19 / 2026-05-05: https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/
- pump.fun fees, page dated 2026-05-20: https://pump.fun/docs/fees
- Jupiter fees: https://developers.jup.ag/docs/swap/fees ; Swap overview: https://developers.jup.ag/docs/swap/index.md
- MacLean, Thorp, Ziemba, 2010: https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf
- Kaminski & Lo, J. Financial Markets 2014: https://dspace.mit.edu/handle/1721.1/114876
- Barber, Lee, Liu, Odean, J. Financial Markets 2014: https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html
- Thaler & Johnson, Management Science 1990: https://ideas.repec.org/a/inm/ormnsc/v36y1990i6p643-660.html
- Merkley et al., Review of Accounting Studies 2024: https://ideas.repec.org/a/spr/reaccs/v29y2024i3d10.1007_s11142-024-09838-4.html
- FTMO trading objectives: https://ftmo.com/en/trading-objectives/
- Topstep help: https://intercom.help/topstep-llc/en/articles/8284197 ; TradersPost summary: https://blog.traderspost.io/article/topstep-review
- Elder 6% rule: https://www.incrediblecharts.com/trading/6_percent_rule.php
- StockCharts Chandelier Exit: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit
- SEC investor bulletin (stops): https://www.investor.gov/additional-resources/news-alerts/alerts-bulletins/investor-bulletin-stop-stop-limit-trailing-stop
- Van Tharp Institute: https://vantharp.com/Weekly_update/Weekly_273_May_31_2006.htm
- Kurnovskii blog (indicative only): https://romankurnovskii.com/en/blog/pumpfun-copy-trading-feasibility/
- Solana fees: https://solana.com/docs/core/fees
- CoinGecko simple price API (SOL $119.46 at 2026-10-03 12:06 UTC): https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd

## Fact-check

Independent re-check of the load-bearing findings against their sources (2026-10-03). Verdicts: confirmed, contradicted (with the correction), or unverifiable.

| Finding | Claim | Verdict | Note |
|---|---|---|---|
| F1 | 60.26% of 41,470 migrated memecoins (Dec 2024 to Mar 2025) fell below 0.2x their migration price within 20 minutes. 84.13% were classed high-risk. Buying at mig | **confirmed** | All numbers match in v1 (13 Feb 2026, 'MemeTrans') and v2 (21 May 2026, retitled 'MELT'). 41,470 launches; the dataset window is Dec 2024 to Mar 2025 (v2: Dec 1 2024 to Mar 1 2025). 24,988 tokens (60.26%) had min_price_ratio < 0.2 within y = 20 minutes after migration. 34,890 (84.13%) are labelled high-risk. 60.71% is the Top-100 'w.o. model' baseline: random token selection, bought at the migration price, loss averaged over 100 random sell times in the next hour. The Top-200 baseline is 64.84%. The MLP filter gives 26.64%, a 56.1% relative cut. Corrections to carry: (1) v2 drops the '56.1%' headline and reports '34 percentage points' (60.71 to 26.64). Cite the absolute figure and v2. (2) High-risk is a rule label (min_price_ratio < 0.3 OR a manipulation flag), so it is partly defined by the price collapse it is meant to predict. (3) The 60.71% is measured on a rebalanced test subsample (74% high-risk) and assumes a fill at the exact migration price, with no fees, slippage or latency. It is an upper-bound baseline, not an executable P&L. |
| F2 | 0.63% of 655,770 pump.fun launches graduated (Sep 2025). Graduation probability is about 35% at 80 SOL vSol and about 64% at 100 SOL. Buying on the curve breaks | **confirmed** | 655,770 tokens from 243,123 creators, 1 Sep to 1 Oct 2025. 4,338 graduated, about 0.63%. The paper's table gives p(grad / vSol has reached tau) = 0.354 at 80 SOL (N = 11,557) and 0.638 at 100 SOL (N = 6,417), so about 35% and 64%. Break-even is the paper's Eq. 3, p > vSol^2 / 115^2. That is about 48.4% at 80 SOL and 75.6% at 100 SOL, so both points sit below break-even. It is for naive buy-at-vSol, sell-at-graduation, ignoring the 1.25% fee and gas, and the paper says dynamic strategies could still profit. The paper says every conditional curve stays below break-even over most of the vSol range. Exception: the top-10 creators curve exceeds it, on thin data, and the p>0.3 curve approaches it near graduation. 'Dump' means a 4-sigma MAD log-return drop. 169,938 of 184,282 tokens with at least 30 swaps (92.22%) have one, and only 2.55% of those tokens graduate. It is a volatility event, not proof of a rug. |
| F3 | In 15.2M pump.fun coins, wash trading is 17% of transactions in a 1% sample and 50.31% for coins with at least 10k transactions. Wash-traded coins graduate at 2 | **confirmed** | Paper: 15,245,966 coins, 14 Jan 2024 to 14 Jan 2026. Single version, 9 Sep 2026. Matches: 50.31% wash ratio for coins above 10k tx; wash-traded coins graduate at 2.0% vs 0.90% (WT1); copycats 0.86% vs originals 9.20% (baseline 1.02%); coordinated-dump median senders 7. Scope fixes: (1) The '17% of all trading transactions' is the paper's headline over BOTH samples (1% coin sample 2.2M plus 5-day sample 1.8M, about 4M wash transactions). It is not 17% of the 1% sample alone. The paper's own totals give the 1% sample 2,221,734 / 49,970,921, about 4.4%, so the 17% denominator is not reproducible from stated counts. Treat it as an unverified headline. (2) The 50.31% rests on only 27 coins (n = 27); 21.65% for 1k to 10k tx (n = 2,295). (3) Top 1% of creator clusters = 58.57% of coins (reported as 58.6%) holds only under 3-hop clustering; 1-hop is 52.99% and 2-hop 57.47%. (4) WT1 is a conservative single-transaction buy-and-sell flag. |
| F4 | 82.8% of 707 cross-chain memecoins with more than 100% return showed artificial-growth indicators (wash trading or LP-based price inflation). 62.9% of profit-ex | **confirmed** | arXiv 2507.01963v2 (2 Jan 2026), 34,988 tokens across ETH, BSC, SOL and Base. 707 tokens (10.21%) gained more than 100% over 3 months. The abstract says 82.8% show artificial-growth evidence; body says 586 tokens = 82.89%. Correction to the parenthetical: the 82.8% is NOT only wash trading or LP-based price inflation. It combines wash trading (287 tokens, about 40.6%), LPI (40 tokens) and 'strong anomaly indicators' (412 tokens, mostly extreme ownership concentration, e.g. top-10 holders averaging 72.94% of supply). Wash plus LPI alone covers well under 82.8%. The 62.9% is correct, but it applies to wash trading or LPI specifically: 62.9% of high-return tokens that had profit extraction (pump-and-dump or rug pull) had earlier undergone wash trading or LPI. The basis is 37 of 60 affected tokens (61.67%), rising to 62.9% when the 2 newly detected rug pulls are included. The figure is 86.67% among delisted tokens (26 of 30). |
| F5 | Smart-money wallets (consistent profit, t-stat above 1.645, low volatility, long tenure) averaged 14% per trade, but copiers got about 3% after latency, slippag | **confirmed** | Paper: Luo, Feng, Xu, Tasca, WWW '26. It has three versions; the cited URL is v2, the latest is v3 (5 Feb 2026). The headline numbers match in v2 and v3: smart-money average return 14%, estimated copier return 3% (v3 words it 'per meme coin investment', v2 'per trade'). Qualifications: (1) 14% and 3% are for the paper's own LLM multi-agent selector on 6,000+ coins, not for 'smart money' in general. (2) Copier return is not realised. It comes from the Appendix A.6 execution model of bonding-curve price impact and frictions. (3) For the statistic-driven baselines, copier returns stayed NEGATIVE despite positive smart-money returns, and the multi-agent model was the only one with a positive copier return. (4) Wallet gates: t-stat > 1.645, return std < 1, mean return > 0, trade count above the 25th percentile and time since first trade above the 25th percentile of the training set. 'Low volatility' is a loose gate (std < 1). (5) Bundle bots appear in about one quarter of projects, weakly tied to lower returns. 'Sniper bots in the majority' is v2 wording; v3 says 'widespread' with minimal performance effect. |
| F6 | Influencer tweets are followed by +1.83% on day 1 and an average -19% after three months. The effect is strongest for small caps, self-described experts and lar | **confirmed** | The cited RePEc page holds only the abstract (about 36,000 tweets, 180 influencers, 1,600+ assets, through Dec 2022). It has no numbers. It does support the subgroups: self-proclaimed experts, smaller-cap assets, and experts with many followers. The numbers come from the authors' ProMarket piece and Kelley/IU and Futurity summaries. Mean one-day return after a tweet is 1.83% (1.57% over 2 days). Day 2 to 5 mean is -1.02%. Average cumulative returns ending 10, 30 and 90 days after the tweet are -2.24%, -6.53% and -18.90%, so about -19% at 3 months. They are buy-and-hold returns. Source: Merkley, Pacelli, Piorkowski and Williams, Review of Accounting Studies 29(3), 2024. Authors say small-cap tokens do worse. Source says 'more than half of the initial gains' vanish by day 5. The 30-day figure for small, lesser-known tokens is -7.9%. Cite ProMarket, not RePEc. |
| F9 | Solidus Labs: 98.6-98.7% of over 7M pump.fun tokens (Jan 2024 to Mar 2025) showed pump-and-dump or rug traits, fewer than 100k kept at least $1k liquidity, 93%  | **confirmed** | Page text matches. Jan 2024 to Mar 2025: 'over 7 million tokens deployed with at least five trades', only 97,000 keep liquidity above $1,000. The 7M is tokens with at least 5 trades, not all launches. The 98.6% is the share of those tokens that fell below $1,000 liquidity in SOL terms, excluding tokens that graduated to Raydium. The report's lead sentence says 98.7% and the closing says '98%', so 98.6 to 98.7 is an internal inconsistency. Raydium: 388,000 V4 pools examined, about 93% (361,000) show soft-rug traits. 25% of rugs were under $732, median about $2,832, largest $1.9M. Caveats: it is a vendor marketing report (Solidus sells Token Sniffer). 'Pump-and-dump' is inferred from a liquidity-below-$1k outcome, not from intent. 'Soft-rug' is defined as abrupt liquidity withdrawal. Raydium V4 AMM only. |
| F10 | PumpSwap canonical SOL pool fee per swap: 1.25% at 0-420 SOL market cap, 1.20% at 420-1,470 SOL, falling stepwise to 0.30% at 98,240 SOL or more. The bonding cu | **confirmed** | Page fetched 2026-10-03, 'Last Updated: 20 May 2026'. Matches. Bonding curve fee is 1.25% (0.300% creator + 0.95% protocol + 0% LP), same for SOL and USDC tokens. Graduation to PumpSwap costs 0.015 SOL. Canonical SOL pool tiers by market cap (price x 1B tokens): 0-420 SOL = 1.250% (0.30 creator + 0.93 protocol + 0.02 LP); 420-1470 = 1.200% (0.95 + 0.05 + 0.20); then 1470-2460 = 1.150%, 2460-3440 = 1.100%, 3440-4420 = 1.050%, 4420-9820 = 1.000%, stepping down to 93,330-98,240 = 0.325% and 98,240+ = 0.300% (0.05 + 0.05 + 0.20). Non-canonical PumpSwap pools: 0.3% (0% creator, 0.05% protocol, 0.25% LP). Extras not in the claim: USDC-paired schedules exist since 21 May 2026 (0 to 59,000 USDC = 1.25% down to 0.30% at 20M USDC+). The page says the mobile app may add up to 0.1% on some transactions. Fees exclude network and wallet fees. |
| F11 | Jupiter Swap V2 /order platform fee is 50 bps for tokens under 24h old, 10 bps for other pairs and 2 bps for SOL-stable. /build has no Jupiter platform fee. | **confirmed** | The cited URL now 308-redirects to /docs/swap/order-and-execute. Fee table for /order, platform fee in bps: new tokens within 24h of token age = 50; everything else = 10; SOL-Stable = 2. The full table also has 0 for buying JUP/JLP/jupSOL with SOL/stables, 0 for pegged assets (LST-LST, Stable-Stable) and 5 for LST-Stable. With a referral account active there is no separate platform fee. The total feeBps can exceed platformFee.feeBps (docs example: 5 bps platform + 7 bps gasless cost recoup = 12). /build: https://developers.jup.ag/docs/swap/build says 'Jupiter does not charge swap fees on /build'. Only an optional integrator platformFeeBps with feeAccount applies. /build is Metis-only routing, has no /execute, and lands via your own RPC or /submit. A Jupiter tip of at least 0.001 SOL applies on tx.jup.ag. |
| F12 | MacLean, Thorp and Ziemba: Kelly is risky short term, betting 2x Kelly gives zero growth, and errors in means matter about 20:2:1 vs errors in variances and cov | **confirmed** | Paper: MacLean, Thorp and Ziemba, 'Good and bad properties of the Kelly criterion', draft dated Jan 1, 2010. Verified by extracting the PDF text. Matches: 'the Kelly criterion can be very risky in the short term'. 'Errors in means versus errors in variances were about 20:2:1 in importance as measured by the cash equivalent value of final wealth'. 'The size of the wagers should be reduced' (exact: 'to be on the safe side, the size of the wagers should be reduced'). Three precision fixes: (1) 'Zero growth at 2x Kelly' is imprecise. The paper says the growth rate 'becomes zero plus the risk free rate' at exactly twice Kelly, in the continuous-time / diffusion approximation, i.e. zero excess growth, and it turns more negative beyond that. (2) 'Sharply reduce risk as their drawdown increases' is attributed to 'practitioners who wish to protect capital above all', not to practitioners generally. (3) The 20:2:1 is Chopra and Ziemba (1993), a mean-variance equity allocation result (the table rounds 20:10:2 to 20:2:1, varies with risk tolerance) that the paper cites. It is not original to this paper and is not memecoin-specific. |
