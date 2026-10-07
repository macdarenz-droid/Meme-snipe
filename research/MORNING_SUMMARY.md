# Morning summary: overnight research (Thursday 2026-10-08, Melbourne)

Written at 07:40 AEDT, and refreshed if anything finishes before you read it. The full ranking is in `IDEA_BOARD.md`. Every number below comes from a RESULTS file on this branch.

## The short answer
- **We have not found a rule that makes money yet.** Every idea finished overnight lost money after fees, or had too few trades to judge.
- **Nothing was lost.** Every test ran on past data on paper. No deposit was made and no trade was sent.

## Real good news (only true things)
1. **The "no" answers are firm, so we can stop guessing.** The paid-ad test was big enough to spot a 15-point gain with over 99% chance, and it found none. These ideas are closed for good, not "maybe".
2. **The stop-loss really protects the money.** Without the stop, paid-ad coins lost 14.7 points more a trade. This is a fix for the bot's exits, not a source of profit.
3. **One faint clue.** In the squeeze test, a simpler version (very low funding plus a breakout) picked slightly better moments than ordinary breakouts: +0.39 points, with an interval just above zero. It still lost 0.24% a trade after costs. It is a clue, not money, and it was one of five side checks.
4. **We know the one cause behind every loss.** Public charts and social signals add only about a tenth of what fees take, and meme prices drift down. Ideas built only on public price and social data are therefore ruled out.
5. **Helius may have cost far less than we counted.** Our counters charged 10 credits a call. The Helius docs page we read on 7 Oct says 1 for the call types behind most of that count (the audit and launch tests). Your dashboard settles it (see "What I need from you").

## Overnight scoreboard

| Test | Result | When it ran (Melbourne) |
|---|---|---|
| Squeeze: buy when short sellers look trapped | **Killed.** Lost 0.71% a trade over 238 trades (registered version unresolved: a data check failed on tiny trades) | Thu 03:33 → 06:28 (about 2 h 55 m) |
| Paid ads: buy coins that paid DexScreener | **Killed.** Paid coins lost 27.1% a trade, unpaid 22.3%; random groups did as badly as paid ones | Wed 20:19 → Thu 07:32 (about 11 h 13 m, mostly downloads) |
| Absorption: buy after new buyers soak up a big seller | **Too rare to judge.** 5 tradable cases found; about 30 are needed. Needs live recording going forward | Ended Thu 04:42 |
| Connect the dots: 14 mixes of all ideas | **None points to an edge.** 3 mixes earned a fair test, each about a 3–5% chance (my judgement) | Ended Thu 04:48 |
| Liquidation: buy the drop when one wallet dumps several coins | **Still running** (downloading 5-minute prices for 163 pools) | Started Thu 03:33 |
| Long-hold re-test on an unbiased coin list | **Still downloading:** about 1,650 of 16,367 coins (10%), roughly 45 h left at the free rate (estimate) | Running since Wed |

## All ideas, highest chance first
Chance is my judgement, not a measured number.

| # | Idea | Chance | Where it stands |
|---|---|---|---|
| 1 | Absorption entry (new buyers soak up a big seller) | low, about 10% | Too rare in history; needs live recording |
| 2 | Audience gains (a meme's usual buyers just won elsewhere) | low, about 5–10% | Needs about 15–17M credits; I recommend no |
| 3 | First listing on a new exchange | very low to low | Too few events |
| 4 | Community crossing (new buyers from separate wallet groups) | very low to low | Waits on the shared tape (your decision) |
| 5 | Wallet liquidation (forced dumping across coins) | very low to low | Running |
| 6 | Buybacks paid from real revenue | very low | Ready; starts after liquidation's download |
| 7 | Holding-reward expiry (short) | very low | Dropped: too few events |
| 8 | Failed transactions as hidden demand | very low | Waits on the shared tape |
| 9 | SOLMEMES text features | very low | Waits on the shared tape |
| 10 | Theme leader | very low | Live recording only |

Already tested and lost: dip-buying, breakouts, launch sniping (all 40 versions), the runner, lottery baskets, hot-market timing, bet sizing, shorting, daily and weekly holds, copy-trading, social links, creator history, paid ads, squeeze.

## Rules written down before the results (so we cannot fool ourselves)
- **D-SPLIT (a crash from holders cashing out vs insiders leaving):** the only mix that can still be tested properly on past data. It runs when the unbiased download ends, plus a small Helius check of who sold.
- **Squeeze traded on perps:** now only a "watch it live" idea, because its rules were written after the spot test had already read prices.
- **Absorption, second step:** waits on absorption, which is too rare.
- **Sealed test window (22 Sep–20 Oct, opens after 21 Oct):** no idea has earned it yet, so it stays sealed.

## Update 09:40: your answers
- **Helius price settled.** Your dashboard rose 549,779 credits while our tests made about 241,000 calls. That fits 1 credit for normal calls and about 10 for each large history call (10 per 100 transactions returned). Our counters booked about 3.3M for these tests, about 6 times the real spend. About 9.3M credits are left this month.
- **Shared tape: approved.** A builder session is building it and will run one small first step (Phase 0), then stop for a check.

## What I need from you (only you can do these)
1. **Helius dashboard:** open it and tell me the "used" credits number. That settles 1 vs 10 credits a call.
2. **Shared tape, yes or no:** a step-by-step download of on-chain trades for research only, kept private and outside the repo. It costs about 2.4–2.9M credits if a block read costs 1 credit, and it is cancelled if it costs 10. Three ideas need it (#4, #8, #9). Your 6 Oct rule says "no bulk historical downloads", so it needs your OK, and you would read the dashboard once before and once after its first small step.
3. **Audience gains:** it needs about 15–17M credits, more than a whole month's plan. I recommend no.

## In kid words
1. We tried lots of ways to catch a winning coin. All of them lost after fees, or were too rare to count.
2. We lost no money, because it was all practice on old data.
3. Now we know why they lose: what everyone can see is too weak to beat the fees.
4. The ideas still left look at who is buying and selling, not just the price chart.
5. Two tests are still running; I will add their answers here when they finish.
