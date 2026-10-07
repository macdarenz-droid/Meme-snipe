# Sizing loop: preserve capital until the big fish (2026-10-07)

## Question
The owner's idea is a fixed bet for losses 1–10, a smaller bet for losses 11–30 and a smaller one again for 31–60. Size is added back only after a good trade. Does this preserve capital, and what is the best honest version of it?

Data: R1/R2 trades (stop at −30%, trail after 2x) in two samples, exploration (492 trades) and validation (442). P&L is in SOL. "$" means SOL converted at the repo's rate of 119.26. Each bet uses only trades already closed when it is placed, and leak tests found no look-ahead.

## What sizing can and cannot do
- **It cannot turn a loss into a profit.** Say results do not depend on the past and the stake is set before each trade. Then expected P&L = mean return per trade × expected total stake (Thorp 2006, p. 388; Durrett v5, Thm 4.2.8). In a losing game, stopping after the big fish cannot raise expected wealth either (Durrett Thm 4.8.4). With no edge, the best stake is zero (Kelly 1956).
- **It can help us survive.** Practitioners who protect capital "sharply reduce risk as their drawdown increases" (MacLean–Thorp–Ziemba 2010). With a trailing floor (wealth ≥ α × peak), the best risk level is proportional to the surplus above the floor (Grossman–Zhou 1993, abstract only).
- **It adds edge only if good periods cluster and you can see that before the bet.** This is Thorp's blackjack case; that it is the only case is our inference. Where clustering exists, timing works: timing 65 equity factors by their own past earned 10.3% alpha (t = 4.6) over the untimed factors (Gupta & Kelly 2019).
- **Warnings.** Rules that cut risk as value falls "do worse in relatively trendless, volatile markets" (Perold–Sharpe 1988, summary page). In simulations, equity-curve filters lose money when autocorrelation is zero (Carver 2015, blog). Across 103 strategies, sizing gains found in sample mostly vanish in real time (Cederburg et al. 2020, abstract).
- **Kelly for lottery payoffs.** f* = p/0.3 − (1−p)/b. We derived this ourselves; it was not checked in a source. At b = 19 the break-even hit rate is 1.55%. A typical entry already has 108–134 positions open, so any Kelly figure must cap *total open exposure*, not each trade.

## On our real trades
**The one profitable line is an accident.** Exploration R1 pess made +3.6% per trade only because the hourly rule sold one coin near 131x. The transaction audit shows a real-time trail would have sold it at 26.65x. With that fill the line makes −0.176 per trade, and every line we could actually trade is negative.

Setup: real entry order, overlapping positions, start = 100, base bet 0.2% of the start. At that size cash never limits the uncapped rules. Ladders reset on a closed 2x. Each cell shows final equity · max drawdown · bet at the biggest winner (base = 1).

| Scheme | Exploration, hourly fill | Exploration, real-time fill | Validation |
|---|---|---|---|
| Fixed | 103.5 · 19.4% · 1 | 82.7 · 19.4% · 1 | 80.2 · 19.8% · 1 |
| Owner ladder 1/½/¼/⅛ | 99.4 · 11.7% · 0.5 | 89.0 · 11.7% · 0.5 | 90.5 · 9.5% · 0.5 |
| Owner tiers × 0.2% of equity | 98.7 · 11.1% · 0.45 | 89.4 · 11.1% · 0.45 | 90.8 · 9.2% · 0.49 |
| Floor 80% of peak, 1% of surplus | 95.6 · 13.1% · 0.39 | 87.5 · 13.1% · 0.39 | 85.7 · 14.3% · 0.88 |
| Same, open stakes ≤ surplus | 89.4 · 10.6% · 0 | 89.4 · 10.6% · 0 | 91.9 · 8.1% · 0.88 |

- **Return per unit staked never improved.** Fixed made −0.176 (exploration, real-time fill) and −0.224 (validation); the ladder made −0.194 and −0.238. The ladder lost less only because it staked about half as much. A flat bet of the same average size did about as well. The capped floor skipped 152 and 235 trades.
- **Stress test with every loss set to −100%.** Lowest equity as a share of peak (exploration / validation):
  - fixed: 0.38 / 0.18
  - ladder: 0.61 / 0.63
  - uncapped floor: 0.71 / 0.57
  - capped floor: 0.802 / 0.7999. The tiny dip below 0.80 comes from exit fees, which the cap did not count.
- **Free cash decides who catches the fish.** With 1-unit bets on a 100-unit bankroll, 167–241 positions were open at once. Fixed had no cash left when the 131x coin came.

**Serial dependence cannot be tested at this sample size.**
- After 10 straight closed losses, the win rate was 4.8% (22/459) vs 3.9% (16/408) otherwise. It was higher in 18 of 24 per-series comparisons and never significantly lower.
- The one "cluster" (p = 0.045) is two winners bought 2 hours apart. The second was bought before the first closed, so no rule could have used it.
- The tests have only a 14–22% chance of detecting a strong regime, and less than that given the overlap.
- Long dry spells are normal. At the measured 2x rate (15/934 = 1.61%), 30 trades with no 2x happen 61% of the time.

## Simulation
We ran 10,000 paths of 1,000 trades each. Outcomes are resampled from the 934 R1 pess trades, plus a big fish paying J at rate λ. Trades run one at a time, and 1 unit = 1% of the start.
- **Independent trades.**
  - Every scheme breaks even at the same λ: 1/134 (J = 30), 1/443 (J = 100) and 1/1326 (J = 300).
  - We observed one fish in 934 trades (95% CI 1/36,891 to 1/168).
  - At break-even with J = 100, the loop with real close delays cuts the chance of losing 90% from 54% to 15%. Median end: 75 vs 10.
  - When an edge exists, the loop without delays keeps only 56–63% of fixed's profit.
- **Hypothetical hot/cold world** (hot 10% of the time, 5× more winners when hot, hot spells of 30 trades). The delayed loop earns +2.9% per unit staked and breaks even at 1/503, vs 1/440 for fixed. With 2× clustering, or hot spells under 10 trades, it barely helps.
- **Trial size** (1 unit = 10% of the bankroll). 75–99% of paths lose 90% at every edge tested, with or without the loop. At $2 the real cost is higher still: the mean is about −0.244 per trade, and $20 lasts about 41 trades.
- **Withdrawn:** the earlier claim that "tiers × 1% of equity is best". It assumed no close delay and no overlap.

## Improved idea
Same goal, used as a risk layer under a strategy that has *first* passed pre-funding item 6. Until then it runs in paper only.
1. **Trailing SOL floor with an exposure cap.**
   - The floor is 80% of peak realized SOL equity and moves up after a big win.
   - Open stakes plus their exit fees stay ≤ equity − floor.
   - Per-trade stake = surplus ÷ expected open positions, about 0.5% of equity or less here.
   - It survived the 100% loss stress test.
   - Cost: the surplus can all be tied up when the fish comes. It missed the 131x.
2. **A stop switch instead of rungs.** A pre-registered monitor (SPRT or beta-binomial) compares the 2x and 10x hit rates with the backtest rate and the break-even rate. When the evidence says the edge is gone, the bot drops to paper.
3. **Minimum stake, then pause.** Below about 0.04 SOL the fixed cost is more than 1% of the stake. Stop trading rather than shrink the bet.
4. **Grow only from proof.** Size rises only as realized SOL equity grows. No boost after a win, and never above the owner's caps.
5. **Kelly as a ceiling.** Use half Kelly or less, computed from the lower confidence bound of the edge. Apply it to total open exposure, and count the jackpot at its real-time fill.
6. **Fix every parameter in advance.** Our hit-rate gate, tuned in sample, gained +0.09 per unit on exploration and nothing on validation.

**Regime test:** run it on the 30–60+ day backtest.
- Pre-register whether the share of all graduates reaching 2x over the last 24–72 h predicts the next window.
- Use block permutations that recompute the labels after each shuffle.
- Confirm on an untouched holdout before any stake change.
- Our own trades alone would need about 3,000 trades for a 48% chance of detecting a strong regime.

## Caveats
- There are only 15 wins of 2x+ and 2 of 10x+ in 934 trades, so big-fish results rest on 1–2 trades.
- Open positions are valued at cost, so drawdowns are understated.
- The $10 net returns are reused at other bet sizes.
- The opt lines were left out because they overstate fills.
- The validation results were already public, and no untouched holdout was used.
- About 160 correlated serial tests were run, so a few p < 0.05 are expected by chance.
- Grossman–Zhou and Perold–Sharpe were read from abstracts or summary pages only. Carver is a blog.
- Sources opened 2026-10-07: homepage.sns.it/marmi/esameIUE/kelly.pdf, gwern.net/doc/statistics/decision/2006-thorp.pdf, services.math.duke.edu/~rtd/PTE/PTE5_011119.pdf, stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf, ideas.repec.org/a/bla/mathfi/v3y1993i3p241-276.html, rpc.cfainstitute.org (FAJ 1988 summary), qoppac.blogspot.com/2015/11/random-data-evaluating-trading-equity.html, aqr.com (Factor-Momentum-Everywhere PDF), lehigh.edu/~xuy219/research/COWY.pdf.
- Scripts: owner_loop/owner_loop.py, kelly_theory/sim2.py, mc_regime/mc_sizing.py, editor/ed_sim.py.

## Supervisor addition: "shrink 5% after every loss" (owner's follow-up), same setup
Bet = base × 0.95^L, where L is the number of closed losses since the last closed trade of 2× or more. The floor version never goes below 30% of base. Each cell shows final equity · max drawdown · bet at the biggest winner · return per unit staked.

| Scheme | Exploration, hourly fill | Exploration, real-time fill | Validation |
|---|---|---|---|
| Fixed | 103.5 · 19.4% · 1.00 · +0.036 | 82.7 · 19.4% · 1.00 · −0.176 | 80.2 · 19.9% · 1.00 · −0.224 |
| Shrink 5%/loss, floor 30% | 100.9 · 10.2% · 0.49 · +0.017 | 90.7 · 10.2% · 0.49 · −0.185 | 90.6 · 9.5% · 0.30 · −0.241 |
| Shrink 5%/loss, no floor | 101.9 · 9.4% · 0.49 · +0.043 | 91.7 · 9.4% · 0.49 · −0.186 | 92.9 · 7.1% · 0.29 · −0.246 |
| Owner tiers 1/½/¼/⅛ | 99.6 · 11.6% · 0.50 · −0.008 | 89.2 · 11.6% · 0.50 · −0.191 | 90.7 · 9.3% · 0.50 · −0.232 |

Same picture as above. The shrinking bet about halves the drawdown, but it catches the biggest winner at half size or less, and the return per unit staked stays negative on every tradable line. The owner-tier figures differ slightly from the workflow's table because the implementation is independent; they agree within about 0.4.

## Kid summary
1. Your idea is good for one thing: it lets us keep fishing longer.
2. Less bait when nothing bites means the bait box empties slower.
3. But less bait does not make fish bite. If the lake is empty, we still lose bait, just slower.
4. In every honest test so far, our lake lost bait.
5. Our one giant fish was really a 27x fish, not 130x, once we checked how fast we could pull it in.
6. Long dry spells are normal here: 30 casts with no 2x happens about 6 times in 10.
7. We could not tell if fish come in groups. We have too few fish to know.
8. Better plan: keep 80% of our best pile safe, only fish with the rest, and stop if the fish clearly stop biting.
9. Use bigger bait only after our SOL pile has really grown.
10. First find a lake with fish (a proven edge). Then your idea keeps us alive until the big one.