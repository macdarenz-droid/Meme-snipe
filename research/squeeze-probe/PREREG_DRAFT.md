<!-- Draft from the advisor-four-hypotheses workflow (2026-10-08). Scouted, designed and adversarially reviewed; every blocking or major issue was fixed in this text. run_now=True. The builder commits the final PREREG.md before any data pull. -->

# Squeeze probe (H1): rules fixed before any return is computed

File: `research/squeeze-probe/PREREG.md`. This is exploration, not proof. It tests the outside reviewer's H1 (2026-10-08). An adversarial review on 2026-10-08 checked this text before commit; its fixes are folded in.

- **No return computed yet.** The scout downloaded the full Binance 5-minute series and scanned it for entry conditions only. Its counts are upper bounds under slightly different rules. Stage 1 recomputes them under the rules below.
- **Kept separate.** Nothing here enters the bot, attempt 1 or any holdout.
- **New trials.** A rule changed after this file is committed is a new trial and is reported as one.
- **Stage 1** builds and freezes the event, control and arm tables, and seals the arm-A holdout. It computes no return.
- **Stage 2** is a separate script that reads only that frozen table and scores outcomes.

## Question
Perp shorts in a large Solana meme look crowded: Hyperliquid funding is unusually low and Binance open interest is unusually high. The coin's price then breaks its 6-hour high against SOL. Does a $50 spot buy held 6 hours:
1. make money in SOL after all costs, and
2. beat matched ordinary breakouts of the same coin, taken on days with neither condition?

## Prior, stated now
- **Stocks:** crowded shorts are right on average (Desai, Ramesh, Thiagarajan & Balachandran, J. Finance 57(5), 2002).
- **Crypto carry:** high carry predicts crashes (Schmeling, Schrimpf & Todorov, BIS WP 1087, 2023). H1 is the untested mirror case.
- **This repo:** 5-minute breakouts lost about −1.4% a trade and did no better than random (`docs/research/edge.md` §9.2).
- **Funding lows are mostly market-wide.** 75% of funding-trigger coin-days fall on days when 5 or more memes triggered.
- **A low is not always negative.** 15.5% of funding-low hours still have positive funding: longs still pay.
- Overall the prior is low.

## Data
Pre-wall only: nothing at or after 2026-09-21T14:00:00Z.

| Input | Source | Known from |
|---|---|---|
| Funding | Hyperliquid `fundingHistory`, hourly (`research/short-probe/fetch_hl.py`) | the row's actual `time`. 381,688 of 381,734 rows are stamped within 2 s of the hour; 46 are late. |
| Open interest | Binance USDⓈ-M archive `data.binance.vision/data/futures/um/daily/metrics/{SYM}USDT/`, `sum_open_interest` (base units), 5-minute rows | value at t = the latest row with `create_time` ≤ t − 300 s, no older than 1 h |
| Signal price | Binance 5-minute klines from the same archive. Spot coins (WIF, BOME, BONK, PNUT, PENGU, TRUMP): spot `{SYM}USDT` ÷ spot SOLUSDT of the same bar. All other coins: USDⓈ-M perp ÷ the SOLUSDT perp of the same bar. | a bar opening at o is known at T = o + 300 s |
| Execution | Solana pool state from Helius `getTransactionsForAddress` on the frozen pool | the state after the last successful pool transaction with block time ≤ the trade time that carries both vault balances |

**Funding cut.** Hyperliquid reports 0.0 after a perp is delisted. The trailing run of rows whose fundingRate is exactly 0.0, running to the end of the file, is removed. An earlier rule cut only after the last traded day. It kept 75 post-delisting zero rows that the rank rule flags as funding lows: CHILLGUY 13, ZEREBRO 13, VINE 12, MYRO 9, LAUNCHCOIN 15 and DOOD 13.

**Signal source.** Each coin's source is fixed, with no fallback. Bars before that source exists give no signal; for example, WIF has none before its spot listing on 2024-03-05.

**Changes from the reviewer's exact data.** The data forced them, and they were decided before any outcome:
- **Open interest.**
  - Hyperliquid has no free intraday OI history: its API gives current OI only.
  - The S3 archive is requester-pays: anonymous requests get 403.
  - The free stats feed is a lagged daily average that ends 2026-04-03.
  - Binance OI is free, in token units, at 5 minutes, from 2023-11 to the wall, so it is used here.
  - Hyperliquid daily OI is run as arm B.
- **Signal price.** Free 5-minute Solana pool history covers only the last 180 days, so the breakout is read from Binance prices in SOL terms. The high uses closes.
- **Execution.** The trade is priced on the Solana pool from its historical reserves, never on Binance.

## Universe (fixed now)
**Classification.** Every name in Hyperliquid meta.json (234 on 2026-10-07) is marked Solana meme yes or no, with its source (CoinGecko platform or category, or the token's mint). The table is committed in stage 1. The expected yes-set is the 24 names below. Any other yes is added before stage 1 runs.

**Names:** WIF, POPCAT, BOME, MEW, GOAT, PNUT, MOODENG, CHILLGUY, FARTCOIN, PENGU, ZEREBRO, GRIFFAIN, VINE, USELESS, kBONK, SPX, TRUMP, MELANIA, YZY, AI16Z, MYRO, LAUNCHCOIN, JELLY, DOOD.

**A coin is kept** if all of these hold:
- it has Binance OI rows overlapping its Hyperliquid funding;
- it has a Binance signal series;
- it has a constant-product execution pool whose fee can be read from the chain.

Each excluded coin is listed with its reason. Known now:
- YZY and LAUNCHCOIN have no Binance metrics.
- JELLY's Binance metrics start 2025-03-26, its Hyperliquid last traded day, so the two never overlap.
- USELESS has no funding-low hour.
- Delisted perps stay in up to the funding cut.

**The execution pool** is one per coin, by a fixed rule:
1. The coin's pool in `research/cheap-venue-probe/universe.json`, if it is Raydium AMM v4 or Raydium CPMM. This covers 14 coins: WIF, POPCAT, BOME, MEW, GOAT, PNUT, MOODENG, CHILLGUY, ZEREBRO, GRIFFAIN, VINE, USELESS, SPX and JELLY.
2. Otherwise, the deepest Raydium AMM v4 or CPMM pool paired with wrapped SOL on the first page of GeckoTerminal `/networks/solana/tokens/{mint}/pools`, with `reserve_in_usd` ≥ $250,000 on the lookup date. This rule is for kBONK, FARTCOIN, PENGU, TRUMP, MELANIA, AI16Z, MYRO and DOOD.
3. Otherwise the coin is out.

**The fee f** is read from the chain at freeze:
- AMM v4: the trade-fee fields of the pool state.
- CPMM: trade_fee_rate from its AmmConfig plus any creator fee, charged in full as an upper bound.
- A pool whose fee cannot be read is out.

Only constant-product pools are used, because there the vault balances give the exact price and impact.

## Definitions
Hours h are UTC. Every input is taken as of the decision time.
- **F at hour h:** the funding row stamped in [h, h + 1 h) is lower than at least 90% of the coin's previous 720 hourly rows, with at least 600 present. Ranks are strict: an equal value does not count as higher. The rows come from the cut series.
- **O at hour h:** OI as of h − 300 s is higher than at least 90% of the as-of OI values at the previous 720 hour marks, with at least 600 present.
- **S at hour h:** F and O together. S is evaluable when both are.
- **Breakout bar:** a completed 5-minute signal bar whose coin/SOL close is above the highest of the previous 72 closes. All 72 must be present and contiguous. Its decision time is T = open + 300 s.
- **Event:** the first breakout bar that opens in [h, h + 1 h) of an hour with S, and whose T is at or after the actual `time` of hour h's funding row.
  - At most one event per coin per UTC day.
  - None while a position in that coin is open: T must be at least the previous event's T + 6 h.
  - T + 67 s + 6 h ≤ the wall.

**Counts.** The scout's counts were reproduced by the reviewer with the corrected funding cut, counts only:
- 349 coin-days over 18 coins;
- 230 coin-days on the 13 coins with a listed constant-product pool (JELLY adds none).

Both are upper bounds before execution filters.

## Trade
The same rules apply to events, controls and arms.
- **Size:** q = 0.4193 SOL ($50 at the repo's fixed 119.26 $/SOL).
- **Entry:** the pool state at or before T + 7 s. The bot's conservative delay after a 5-minute bar is about 6.2 s (`edge.md` §8.2). Robustness line: T + 60 s.
- **Exit:** the pool state at or before entry + 6 h. No stop, no target.
- **Reserves:** x (SOL) and y (token) are the two vault balances, found by vault address (never by owner), in that transaction's `postTokenBalances`. If the latest transaction lacks either vault, page back to the latest one that has both.
- **Fills:**
  - buy: k = y·q(1 − f)/(x + q(1 − f));
  - sell: SOL_out = x'·k(1 − f)/(y' + k(1 − f)).
- **Fixed cost:** 414,009 lamports per round trip (`FIXED` in `research/lottery-probe/lottery.py`).
- **Net:** net = (SOL_out − q − fixed)/q.
- **Stress line:** net − 1 point.
- **Executable** means all of:
  - the round trip at entry, 2f + 2q/x + fixed/q, is at most 1.5%;
  - the pool has a transaction before the entry time;
  - both exits are at or before the wall.

  Dropped trades are counted by reason.

## Controls
**C1 is the decisive control: ordinary breakouts of the same coin.**
- **Candidates:** breakout bars with T′ within ±30 days of the event, on UTC days where F and O were both evaluable at all 24 hours and neither was true at any hour. The reviewer counted feasibility: all 349 events have at least 3 candidate days, and 327 have at least 10.
- **Exact match on b6,** the number of breakout bars among the previous 72: 0, 1–2, or 3+.
- **The 10 nearest** by standardized Euclidean distance on:
  - r24: the coin/SOL log return over the 24 h to T;
  - m24: the median r24 over all universe coins with data at T;
  - vol6: the standard deviation of the 72 five-minute coin/SOL log returns before T;
  - hour of day: the circular distance in hours, divided by 6.
- **Standardization** uses the standard deviations over all candidate bars of all coins.
- **Limits:**
  - Candidates must pass the same wall and executable rules.
  - At most one control per coin-day.
  - Ties are broken by SHA-256 of ("H1-v1", event id, candidate id).
  - A control may serve several events.
- **Too few controls:** an event with fewer than 3 controls is reported but left out of the lift statistic, and counted.

**C1b is descriptive only, never a verdict input.** The same matching, on days where S was false at every hour but F or O was true at some hour.

**C2 measures drift.** For each event, 5 random entry times on the same coin, uniform at 1-second resolution between the pool's first transaction and wall − 6 h − 67 s, and within ±30 days of the event. Seeded the same way, with the same trade rules.

**Balance is reported, never a reason to rerun:** the standardized mean difference of each matching variable, events against C1.

## Statistics (fixed)
For each event i:
- n_i = its net;
- c_i = the mean net of its C1 controls;
- d_i = n_i − c_i (the lift).

Reported:
- counts of events, coins and distinct days;
- mean and median of n (over all executable events and over the lift set), of d and of gross;
- win rate;
- the C2 mean and the C1b mean;
- results by year, and by halves split at the median entry date;
- the 60-second line and the stress line;
- a per-coin table;
- results by funding sign at the trigger hour (below 0, or 0 and above);
- events in the 72 h before a perp's funding cut, reported separately.

Intervals:
- a 95% day-block bootstrap, resampling UTC entry days with each event's own controls attached (10,000 resamples, seed 7);
- a day-clustered t-interval beside it.

## Verdict
There is one primary test: the reviewer's full rule with Binance OI.
1. **Unresolved:** fewer than 150 executable events with a C1 set, or fewer than 100 distinct entry days. Only counts are reported.
2. **Killed** (the reviewer's rule): mean n ≤ 0, or mean d ≤ 0.
3. **Promising:** all of the following hold.
   - The 95% lower bound of mean n is above 0.
   - The 95% lower bound of mean d is above 0.
   - Mean n and mean d are above 0 in each half.
   - The 60-second line's mean n is above 0.
   - The stress line's mean is above 0.

   Both intervals must pass (an intersection-union test), so no further correction is needed.
4. **Inconclusive:** anything else.

A promising result only justifies a forward test through the engine. Nothing here counts toward the pre-funding gate.

## Power
These figures are assumptions, not measurements.
- The σ of a 6-hour SOL return is assumed to be 6–8%, with day clustering DEFF ≈ 1.2.
- At 200 events, the SE of mean d is about 0.5–0.65 points.
- The lift detectable at 80% power is about 1.4–1.8 points.
- If the true lift equalled the round trip, it would be falsely killed about 9–16% of the time.

## Secondary arms
These are descriptive and never rescue the primary. They run in the order A, B, C, D, E, after the primary and only within the credit cap.

**Holdout seal.**
- Stage 1 builds arm A's full event list, with the same event rules.
- It sets D_split = the median of that list's distinct UTC event days.
- It commits the SHA-256 of the events on or after D_split.
- Arms A, B and C are scored only before D_split; no price on or after it is read for them.
- The sealed part is kept untouched for a later 300-trade test of the reduced rule. That test reports results with and without the coin-days already scored by the primary, D or E.

**The arms:**
- **A, reduced rule:** F plus breakout, without OI. C1 comes from days with F false at every hour; 3 controls per event.
- **B, Hyperliquid daily OI instead of Binance,** from the stats feed, to 2026-04-03.
  - The previous completed day's OI must be higher than at least 90% of the 30 days before it, with at least 25 present.
  - OI in tokens = USD value ÷ that day's typical price (o + h + l + c)/4.
  - 3 controls per event.
- **C, coin-specific funding:** F on the coin's funding minus the universe median funding in the same hour, plus O and the breakout. 3 controls per event.
- **D, spot-signal coins only:** the primary rule on the six spot coins. Full history.
- **E, one trade a day:** the first event per UTC day across all coins. Full history.

## Data checks before stage 2
No outcome is read in these checks.
1. The stage-1 table is frozen and its SHA-256 committed before any Helius price is read. It holds the events, controls, arms, pool map, fee reads, the classification table, exclusions and the sealed-holdout hash.
2. **Pool existence:** events before a pool's first transaction are non-executable.
3. **Reserve check on 200 seeded swaps:** each swap's fee-adjusted effective price must lie between its own pre- and post-vault-ratio prices, within 0.1%.
   - If more than 5% fail for a pool type, that type's pools are dropped before stage 2, and the drop is recorded.
   - Any other fix needs a committed amendment written before any outcome is read.
4. Every block time used is at or before the wall.
5. One `getTransactionsForAddress` smoke call confirms that the plan supports it and that the response carries pre and post token balances.

## Caveats (stated now)
- **Live parity.** The research machine gets HTTP 451 from both Binance futures (fapi) and Binance spot market data (api.binance.com). Whether the production host reaches either is unverified, for the signal as well as for OI.
  - **Precondition** for any forward step: one request each from the production host to Binance spot klines and futures OI.
  - **If either fails,** the forward test uses the Solana pool's own 5-minute price and Hyperliquid OI recorded from metaAndAssetCtxs.
- **Perp-proxy signal.** For coins without Binance spot, perp and spot can diverge in a squeeze. Arm D isolates the spot-signal coins.
- **Reserves.** Vault balances include fees not yet collected. Data check 3 bounds the error.
- **Survivorship.** The execution pools are today's deep pools, and the classification is made today. Delisted perps are kept.
- **Clustering.** Events concentrate in market-wide dumps. The day bootstrap handles it.
- **OI quality.**
  - Binance OI trends upward and sat in its top 10% in 16.7% of hours. It is kept, as the reviewer specified.
  - Some exchanges misquote OI (Giagkiozis & Said 2024).
- **SPX** on Solana is the Wormhole-bridged token.
- **JELLY's** delisting followed a deliberate squeeze.


## Executor notes

Model: claude-opus-5-5. The builder needs HELIUS_API_KEY in its environment only, never in a file or log.

**Step 0.** Commit and push this PREREG (corrected text) to research/squeeze-probe/PREREG.md before any data pull. A fresh-context reviewer checks the stage-1 and stage-2 code before stage 2.

**Step 0b. Smoke test.**
- heli.py has no getTransactionsForAddress method. Add one that books every call in the ledger.
- Run one smoke call: a pool address, full, desc, limit 1, blockTime lte a 2025 time, succeeded, maxSupportedTransactionVersion 1. It costs 10 credits.
- If the plan refuses the call, stop and tell the supervisor.

**Step 1. Data (free, keyless). Re-download, because the scratchpad is not shared.**
- Hyperliquid: run research/short-probe/fetch_hl.py.
- Binance archive, using the scout's scripts (scratchpad h1probe/bn_metrics.py, bn_spot.py, bn_perpk.py) copied into research/squeeze-probe/ or rewritten:
  - metrics for 18 symbols plus DOOD (DOODUSDT metrics exist from 2025-05-09, S3 listing checked 2026-10-08);
  - spot 5-minute klines for WIF, BOME, BONK, PNUT, PENGU, TRUMP and SOL (microsecond timestamps from 2025);
  - perp 5-minute klines for the rest plus the SOLUSDT perp. Add AI16Z and MYRO, which were missing from the scout's set.
- Record the SHA-256 of every file, and keep the data outside the repo.

**Step 1b. Funding cut.** Drop the trailing exact-0.0 run per file. Apply S only from the funding row's actual time.

**Step 2. Pool map.**
- 14 pools come from cheap-venue universe.json.
- 8 GeckoTerminal lookups: kBONK, FARTCOIN, PENGU, TRUMP, MELANIA, AI16Z, MYRO and DOOD. Space them at least 7 s apart, queued behind the other GeckoTerminal client. No candles come from GeckoTerminal.
- Fees and vault addresses, read by getAccountInfo:
  - AMM v4: the pool state;
  - CPMM: the pool and its AmmConfig.
  - That is about 30 calls.
- Commit the classification table of all 234 meta.json names.

**Step 3. Stage 1.**
- Build the events, C1, C1b, C2 and arms A–E from local data.
- Seal the arm-A holdout: compute D_split and commit the SHA-256 of the sealed list.
- Commit the stage-1 table's SHA-256 before Step 5.

**Step 4. Data checks.**
- Pool existence.
- The 200-swap reserve check, about 2–5k credits.

**Step 5. Stage 2 pricing.**
- One price point = getTransactionsForAddress on the pool: full, desc, limit 1, filters {blockTime: {lte: t}, status: succeeded}, maxSupportedTransactionVersion 1. Page back if a vault balance is missing.
- Primary: at most about 11.5k calls, about 115k credits.
- Arms A–C, before D_split only: about 60–100k credits.
- Hard cap: 400,000 credits (heli.py CAP). Rate at most 9 requests a second, and only after the supervisor confirms the account-wide total.
- Never request a block time after 2026-09-21T14:00:00Z.

**Step 6.** Write RESULTS.md and results.json.

**Runtime.** About 1–1.5 builder days and about 1 day of wall time. Uncertainty: the Binance download speed and the reserve check.

**Credit context.** Verified in edge.md §10.4: 10M cycle, about 2.04M spent, 4M absorption cap and 3M reserve, which leaves about 0.96M. H1 takes at most 400k.

**If H1 is not killed** (a supervisor decision):
- one request each from the production host to Binance spot klines and to futures OI;
- a free Hyperliquid metaAndAssetCtxs recorder at 1 per minute.
