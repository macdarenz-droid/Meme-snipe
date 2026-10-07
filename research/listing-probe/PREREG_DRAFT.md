<!-- Draft from the advisor-four-hypotheses workflow (2026-10-08). Scouted, designed and adversarially reviewed; every blocking or major issue was fixed in this text. run_now=False. The builder commits the final PREREG.md before any data pull. -->

# Listing probe (H4-TS): rules fixed before any return is computed

File: `research/listing-probe/PREREG.md`. This is the outside reviewer's H4 (2026-10-08) in its trading-start form, as an exploration and **a kill test only**. An adversarial review on 2026-10-08 checked this text before commit; its fixes are folded in.

**Status: deferred.** Run only if a builder would otherwise be idle with no core card. Even a pass cannot reach the gate:
- there are about 73 verified events in 33 months, and about 0.6 a month in 2026;
- the reviewer's rough check finds at least 9 of the 17 Binance and OKX events fail the 30-day rule on pool creation dates;
- so the sample would be mostly Kraken.

If it is ever run, the free stage 1 comes first. If stage 1 finds fewer than 40 executable events or fewer than 25 distinct days, the verdict is **unresolved** and no credits are spent.

- **Stage 1** freezes the event list: times and identities only. It uses free, keyless calls.
- **Stage 2** is a separate script that scores outcomes.

## Question
An already-tradable Solana meme gets its first spot market on a big retail venue. Does a $50 buy in its Solana pool shortly after trading starts, held 6 hours:
- make money in SOL after costs, and
- beat the same coin at ordinary times?

## What a kill means
The reviewer's H4 is the listing **announcement** as a collector receives it (H4-ANN). Free, exact announcement times exist historically only for Binance, which gives 6 events.

This test uses the **trading start** (H4-TS), which comes 3–4.4 h after the announcement on Binance.
- A kill of H4-TS says nothing about H4-ANN.
- H4-ANN stays **unresolved**, whatever H4-TS shows. The report must say so.

## Prior
- **Ante 2019 (BRL WP 3):** +5.7% abnormal return on listing day, positive on only a few exchanges.
- **Ante & Meyer 2020 (BRL WP 5):** +4.97% over the 3 days before listing, and nothing significant after day 0.
- **Li, Luo, Wang & Wei (AFT 2025):** +6% the day before Binance announcements.
- **The Tie (13 Jul 2026, industry research):** gains come before day 0 and mean-revert.
- All of these use daily data. The prior is low.

## Event
Venues and event time E:

| Venue | E |
|---|---|
| Binance | the first 1-minute kline (or first aggTrade) of the new spot pair in the data.binance.vision archive. The announcement-body time is recorded too, and any gap over 5 min is listed. |
| Coinbase | the first trade on the product's trades endpoint |
| OKX | max(`listTime`, the first 1-minute candle) when that history is available; otherwise `listTime`, flagged. Whether listTime marks a call auction is unverified. |
| Upbit | the start of the coin's first 1-minute candle on any market, plus 60 s as a bound |
| Kraken | the first trade on its Trades endpoint. Also reported as its own group. |

Robinhood and Bybit are out: no exact times are available from here.

Event rules:
- **Event:** the pair (coin, venue), for the coin's first spot market on that venue, from 2024-01-01 to the wall, with E + 64 s + 6 h ≤ 2026-09-21T14:00Z.
- **Not events:** perps, extra quote pairs, margin and Earn additions, and roadmap mentions.
- **Prior perp:** each row records whether a Binance or OKX perp of the coin existed before E.
- **Already tradable:** the execution pool's first transaction is at least 30 days before E.
- **Chain identity:** the venue's page or API, or a contemporary news article, must name the Solana token. Otherwise the event is excluded and listed. Unverified symbols now: FIGHT, WAR, BASED and AVA.
- **One position per coin:** a later event of the same coin whose E falls before the open position's exit is marked **covered**. It is not traded, but it is counted and listed. Verified cases, all of which also fail the 30-day rule:
  - OKX PNUT 2024-11-11 09:40 against the Binance open at 10:00;
  - PENGU 13:00 against 14:00 on 2024-12-17;
  - TRUMP 04:00 against 08:30 on 2025-01-19.

## Execution pool
The first rule that applies:
1. the coin's pool in `research/cheap-venue-probe/universe.json`, if it is Raydium AMM v4 or CPMM;
2. its PumpSwap pool in the deep-pool eligible list;
3. the deepest Raydium AMM v4, CPMM or PumpSwap pool paired with wrapped SOL on GeckoTerminal, with a reserve of at least $250,000;
4. otherwise the event is out.

The fee is read from the pool state or its config.

## Trade
- **Size:** q = 0.4193 SOL.
- **Entry:** the pool state at or before E + 10 s. Robustness line: E + 64 s.
- **Exit:** at or before entry + 6 h.
- **Fills:** constant product.
- **Fixed cost:** 414,009 lamports.
- **Stress line:** −1 point.
- **Executable:** the round trip at entry is at most 1.5%.

## Controls
**C1: the same coin at ordinary times**
- The same clock time on days −30 to −8 and +8 to +30 around E.
- Days within ±7 days of any listing of that coin on a frozen venue (spot, or a known perp) are excluded.
- 10 days are drawn, using SHA-256 of ("H4-v1", event id, day).
- If fewer than 5 days are available, the event is left out of the lift statistic and counted.

**Diagnostic: profit before entry**
- Primary: the pool price change from E − 24 h to entry.
- Arm A: the pool price change from E − 3 days to the announcement.

## Statistics and verdict
There is one primary test: the H4-TS arm over all frozen venues. For each event:
- n = its net;
- d = n − the mean of its C1 nets.

Intervals: a 95% day-block bootstrap (10,000 resamples, seed 7), with a day-clustered t-interval beside it.

Verdicts:
- **Unresolved:** fewer than 40 executable, non-covered events, or fewer than 25 distinct days.
- **Killed:** mean n ≤ 0, or mean d ≤ 0.
  - If the pre-entry move is positive on average while the post-entry gross is no larger than the round trip, the report states that the profit happened before entry.
- **Promising:** all of the following hold.
  - The 95% lower bounds of mean n and mean d are both above 0.
  - The E + 64 s line's mean n is above 0.
  - The stress line's mean is above 0.

  Even then it cannot reach the gate.
- **Inconclusive:** anything else.

Reported alongside:
- results by venue;
- results without Kraken;
- each coin's first listing on any frozen venue;
- prior perp yes or no;
- results by year;
- covered events;
- arm A (H4-ANN, 6 Binance events, descriptive).

## Power
These figures are assumptions.
- The σ of a 6-hour return is assumed to be 10–15%.
- With 40–60 executable events and DEFF ≈ 1.3, the SE of the mean is about 1.5–2.7 points.
- Only effects of about 4–7 points can be detected.

## Caveats
- **Survivorship.** OKX, Upbit and Kraken drop delisted markets, and the coin list comes from today's category. This favours H4, so a kill is robust and a pass is suspect.
- **Clustering.** 24 of the 73 events fall in Dec 2024 to Jan 2025.
- **Trading start is not the news.**
- **Pool choice.** The pool that orders were routed to at the time may differ from the frozen pool.


## Executor notes

Deferred: run_now is false.

**When to start.** Only when a builder is idle with no core card, and after H1's pricing and H3's stage 1.

**Model.** claude-opus-5-5. HELIUS_API_KEY comes from the environment only.

**Step 0.** Commit the PREREG.

**Step 1. Free stage 1, no credits.**
- Binance:
  - CMS list and detail, about 35 calls;
  - data.binance.vision spot 1-minute klines, or aggTrades, for the first day of each pair, to get E.
- Coinbase: products and trades, about 20 calls.
- Kraken: AssetPairs and Trades?since=0, about 50 calls, 1.5 s apart.
- Upbit: market list and minute candles, about 60 calls.
- OKX: instruments, plus 1-minute history candles where available.
- CoinGecko: 2 calls.
- Identity checks: venue pages and news.
- GeckoTerminal: at most 40 pool lookups, 7 s apart, queued.
- Fee reads by getAccountInfo.
- Apply the 30-day and covered rules.
- If there are fewer than 40 executable events or fewer than 25 days, write RESULTS.md as unresolved and stop.

**Step 2. Pricing, only if stage 1 passes.**
- getTransactionsForAddress on the pool: full, desc, limit 1, blockTime lte t, succeeded. Run one smoke call first.
- 4 points per event plus 20 control points: about 240 credits per event.
- Cap: 40,000 credits. Never request times after the wall.

**Runtime.** About 0.5 day for stage 1. If it passes, about 15 minutes of Helius time and a few minutes of analysis.
