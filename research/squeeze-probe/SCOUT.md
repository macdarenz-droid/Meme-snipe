## H1-squeeze: testable-now

H1 (squeeze) can be tested now on free data, but only in a changed form. The reviewer's exact version, with Hyperliquid open interest in token units at hourly or finer resolution, needs paid or login-gated data, or recording from today onward. No trading return was computed. Only feasibility checks and counts were run.

What exists:
(a) Hyperliquid open interest (OI) history.
- The public info API gives only the current OI (metaAndAssetCtxs, in coin units). candleSnapshot and fundingHistory carry no OI. 5-minute candles reach back only about 17 days.
- The full minute-level history is in s3://hyperliquid-archive/asset_ctxs. It is requester-pays, so anonymous requests are refused (verified: 403 "Anonymous users cannot invoke requests against Requester Pays buckets"). Using it needs an AWS account with billing, which is an owner action.
- Free, keyless and new to this repo: the Hyperliquid stats backend JSON (https://d2v1fiwobg9w6.cloudfront.net/open_interest). It holds a daily OI per coin in USD for 229 perps, 2023-06-13 to 2026-04-03, with no gaps on traded days. Its source code computes the value as the daily average OI times the daily average oracle price. The file was regenerated on 2026-10-07, yet its data stops on 2026-04-03.
- Dune has hourly OI from 2025-09-27 (needs an account). Allium (from 2025-05-09) and Hydromancer (from 2025-08-01) need keys. Coinalyze needs a free key but keeps only 1,500–2,000 intraday points.
- The best free substitute: Binance's public archive, data.binance.vision, which is keyless. It has 5-minute OI in token units, plus account, top-trader and taker long/short ratios. It covers 20 of the Solana memes from their Binance listing (2023-11 for 1000BONK) to the wall, including delisted ones. About 3.87M rows were downloaded, 97.7% complete.
- Binance's live futures API returns HTTP 451 (restricted location) from this machine.

(b) Funding.
- The local hourly files cover 229 perps from their first traded day to 2026-09-21T13Z, with about 99.8% of hours present and gaps of at most 8 hours.
- The rate is per hour: the most common value is 1.25e-5 = 0.01%/8h ÷ 8, matching the docs.
- Delisted perps keep reporting 0.0 funding after delisting. Those rows must be cut.

(c) Spot.
- 19 Hyperliquid meme perps are Solana tokens with deep pools. 15 of them are in cheap-venue-probe/universe.json. TRUMP, MELANIA and YZY trade mainly in Meteora DLMM pools against USDC.
- GeckoTerminal's free API refuses data older than 180 days. The 401 message says: "You can only access data from the past 180 days with Public API". Free 5-minute Solana pool history therefore starts about 2026-04-10. Its bars are sparse: about 20% of 5-minute slots are missing even in deep pools.
- Binance spot 5-minute candles are free for the full history, but only for WIF, BOME, BONK, PNUT, PENGU and TRUMP.

(d) Counts (no outcomes).
- Funding in the lowest 10%, strict rank rule: 3,940 coin-days. Only 805 distinct calendar days, so events cluster heavily across coins.
- Jointly with Binance OI in its top 10%: 713 coin-days.
- Adding a 5-minute breakout in SOL terms: 349 coin-days. Too few for the gate's 300 out-of-sample trades.
- The reduced rule, funding plus breakout without OI: 2,045 coin-days. Enough for a gate-grade test.

The Hyperliquid-OI and Binance-OI versions pick largely different event days (Jaccard 0.19). The OI source must be fixed before any outcome is seen.

**Events (no outcomes):** These are entry-condition counts only: no price after entry was read and no return was computed. All are upper bounds before execution filters (pool depth at the time, delay, $50 size).
- Universe: 19 Solana-meme Hyperliquid perps (18 with Binance OI). Funding comes from the local hourly files; delisted perps are cut at their last traded day.
- Trigger rule: funding below at least 90% of the coin's previous 720 h (strict ranks, because the baseline value creates heavy ties).
- One entry per coin per UTC day.

1. Funding only: 3,940 coin-days, but only 805 distinct days. 75% of coin-days fall on days with 5 or more coins triggered, so the effective sample is closer to the number of days.
2. Funding + Hyperliquid daily OI in its top 10% (to 2026-04-03): 558 coin-days. With a breakout added: 286.
3. Funding + Binance 5-minute OI in its top 10% (Nov 2023 to the wall): 713 coin-days. With a breakout added: 349 coin-days on 254 distinct days, about 130 a year.
4. Reduced rule, funding + breakout without OI: 2,045 coin-days (635 distinct days). On the 6 coins with free Binance spot history: 1,026.
5. Inside the free GeckoTerminal Solana window (2026-04-10 to the wall): funding + breakout 348; full joint rule 66.

Implications:
- The full joint rule cannot reach the gate's 300 out-of-sample trades on history. Even a 50/50 discovery/holdout split leaves about 175, and clustering cuts the effective number further.
- Recorded forward at about 150 joint events a year, it would need about 2 years.
- The reduced funding + breakout rule can reach 300 out-of-sample trades on history.

Method: python3 -I counts.py and joint_bn.py over local funding, the free Hyperliquid stats OI JSON and the Binance archive. The breakout check uses Binance spot (6 coins) or Binance perp closes as a proxy (12 coins), in SOL terms via SOLUSDT.

**Cost and time:** Free route ($0, no keys):
- Already done in this session, about 75 minutes:
  - Binance archive: 13,773 OI files, plus spot and perp 5-minute candles (459 MB compact, in scratchpad h1probe/bnm, bns, bnp).
  - Hyperliquid daily OI JSON (13 MB).
  - All counts.
- Still needed:
  - GeckoTerminal 5-minute bars for the 14 live Solana pools, 2026-04-10 to the wall. About 35–50 calls per pool, about 500–700 calls, about 60–80 minutes at a 7 s pace. It must be scheduled with the other GeckoTerminal download, and done soon: the 180-day window loses one day of history every day.
  - Building the pre-registered test (frozen definitions, matched ordinary-breakout control, SOL costs, actual delay): about 1–2 builder days. The outcome run itself takes minutes.

Paid or login routes (owner action):
- Hyperliquid S3 asset_ctxs, minute-level OI back to 2023-05-20: needs an AWS account with billing. The requester pays transfer plus request fees; total size is unverified and likely a few GB, so likely a few dollars (estimate, unverified). Updates after 2026-04 are unverified.
- Dune: hourly OI from 2025-09-27. Needs an account; free-tier credits unverified.
- Allium (from 2025-05-09) and Hydromancer (from 2025-08-01): need keys; Allium's pricing is unverified and Hydromancer's free tier is only on request. Both need owner approval.
- Coinalyze: free key, but it keeps only about 2,000 intraday points, so it is useless for history.

Forward route for the exact spec: record Hyperliquid metaAndAssetCtxs every minute starting now. It is free and reachable. About 2 years to reach 300 joint out-of-sample trades.

- Source: Desai, H., Ramesh, K., Thiagarajan, S. R., Balachandran, B. V. (2002). An Investigation of the Informational Role of Short Interest in the Nasdaq Market. Journal of Finance 57(5): 2263-2287.. On Nasdaq stocks from 1988 to 1994, heavily shorted firms earned −0.76% to −1.13% a month in abnormal returns, and more short interest meant more bearish results. Crowded shorts are on average right, so a squeeze is the exception, not the base case. This is a low prior for H1's long-into-crowded-shorts idea. (Web search on 2026-10-07: IDEAS/RePEc (ideas.repec.org/a/bla/jfinan/v57y2002i5p2263-2287.html), SSRN ab_id=232908 and Kellogg pages. The abstract findings are quoted from those results; the full text was not opened.)
- Source: Schmeling, M., Schrimpf, A., Todorov, K. (2023). Crypto carry. BIS Working Papers No 1087.. Crypto futures carry can reach 60% a year, driven by trend-chasing smaller investors and scarce arbitrage capital. "A high crypto carry predicts future price crashes", meaning crowded leveraged longs get flushed. H1 is the untested mirror case: deeply negative carry followed by a squeeze up. The paper is about majors, not memes. (Fetched https://www.bis.org/publ/work1087.htm on 2026-10-07 (abstract).)
- Source: Giagkiozis, I., Said, E. (2024). Reconciling Open Interest with Traded Volume in Perpetual Swaps. Ledger 9; arXiv 2310.14973.. Open interest in Bitcoin perpetual swaps is systematically misquoted by some of the largest derivatives exchanges, from wholly implausible values to delayed liquidation messages. The exchanges are not named in the abstract. Any OI-based signal, including Binance's archive, carries a data-quality risk. (Fetched https://arxiv.org/abs/2310.14973 on 2026-10-07 (abstract).)
- Source: JELLYJELLY incident on Hyperliquid, 26 March 2025 (The Block: 'Hyperliquid delists JELLYJELLY memecoin amid whale manipulation fiasco'; Arkham research note).. A deliberately engineered squeeze on a thin Hyperliquid meme perp pushed a liquidated short onto the HLP vault. Hyperliquid then delisted the perp and closed positions at a price it set. Thin meme perps can be squeezed on purpose and delisted abruptly, so funding and OI extremes on small perps may reflect manipulation, not natural crowding. (Web search results only, 2026-10-07 (article not opened). Consistent with the local candles: JELLY's last traded day on Hyperliquid is 2025-03-26.)

## H2-theme: forward-only

H2 (theme leader) can only be tested honestly going forward. A historical test would need us to pick, today, which themes, which source accounts and which events count, already knowing which themes boomed in 2024-26. The data that would let us avoid that is either missing or damaged.

The cited paper is real: Li, Shin, Sun and Wang, "The Dark Side of Decentralized Finance: Evidence from Meme Tokens", Preliminary Draft dated 12 July 2023, SSRN 4228920. I opened the full PDF. It studies 311,354 BSC meme tokens from 12 Sep 2020 to 31 Dec 2021, using daily end-of-day prices only.
- **Co-movement.** Tokens in the same keyword "style" move together on the same day. The coefficient is 0.101-0.106 and adjusted R2 is 0.003-0.010, so this is a same-day correlation, not a forecast.
- **Issuance.** Past 14-day style returns predict more new tokens, more style volume and more rug pulls.
- **Musk's 27 DogeCoin tweets (Jul 2020-Dec 2022).** In a daily difference-in-differences, doge-named tokens rose more than other meme tokens: price about +10%, volume +40%, issuance +20% (introduction) or +30% (section 6) relative on the first day.
- **What it does not do.** It never compares an established leader with its clones, has no intraday timing and no costs, and does not test whether anyone could trade on it.

The reviewer's summary is accurate in direction but adds the leader idea, which the paper does not test.

Historical blockers:
1. **No complete, timestamped list of catalysts.**
   - Famous events (Moo Deng, Pnut, Chill Guy) would be picked from memory because their coins rose. They also created new themes with no leader before the event.
   - The free Musk archive (Zenodo 14836471) has damaged tweet IDs: 46,058 of 60,567 are in scientific notation, so exact times are lost. It has no reposts and ends 2025-01-24.
   - The full X archive is pay-per-use and needs the owner's account. Wikipedia data is hourly only, and its API refused this machine. Google Trends has no history.
2. **Clone-launch bursts are not an independent trigger.** The paper shows new-token issuance follows past style returns, so a burst signal would really be the price move we already tested.
3. **Buyer share needs paid or credit-based data.** It needs every swap across leader and peers, including pump.fun clones. Dune's API needs a paid plan or trial; Helius uses credits and has no key in this session. GeckoTerminal gives volume only, for 180 days.

Leaders can be fixed using only data from before each event, from CoinMarketCap's weekly historical snapshots (free; checked for 2024-05-05).

There is also too little data:
- A frozen 6-theme keyword list finds only 20 non-reply Musk posts in the 15 months to Jan 2025, about 16 a year, with false positives ("Penguin" audiobooks, DOGE the government department).
- The strongest example (the Pnut squirrel posts on 2-3 Nov 2024) concerns a token created on 31 Oct 2024. It would fail any "established leader" rule.

A paid historical pilot (X archive plus Helius) is possible as exploration. It cannot reach the 300-trade gate and must not count toward it.

Forward collector design (minimal cost):
- **Frozen before the first event, with a committed hash:**
  - a theme list taken from CoinGecko's meme theme categories, with keyword rules for token names and catalyst text;
  - a roster per theme: the leader is the most-traded token aged 90 days or more with a deep SOL pool at freeze; peers are all other matching tokens, plus every new token created after the freeze whose name matches (they count in the theme total). The roster is re-frozen monthly and applies only to later events.
- **Catalyst feeds:**
  - Google Trends trending RSS (free; checked, 10 items with publish time and traffic band), polled every 2 minutes;
  - the worker's existing free pump.fun new-token feed, recorded as a confound monitor, not a trigger;
  - X posts from a fixed account list only if the owner approves pay-per-use ($0.005 a post read).
  - Crypto-context terms are excluded so the coin's own pump cannot trigger an event.
- **Timestamps:** source publish time, our receipt time and the slot time of every swap.
- **Buyer share:** the leader's buy volume in SOL as a share of the theme's buys over [receipt, +15 min], against the median for the same 15-minute window over the previous 7 days.
- **Entry and exit:** paper entry at the first swap after the decision, plus the real delay; fixed 6-hour exit; costs in SOL.
- **Controls:**
  - the peer basket at the same times;
  - the leader at matched non-event times, drawn from a seeded list committed in advance;
  - catalysts that failed the share filter, scored the same way;
  - placebo trending terms matched to a random leader.
- **Phases:** outcomes are scored in a separate stage. Phase A counts events only for 4 weeks to measure the event rate. The scoring sample size is fixed after that.

**Events (no outcomes):** No prices or outcomes were used. Catalyst counts come from the Musk archive (Zenodo 14836471): with a 6-theme keyword list frozen before counting, Nov 2023 to 24 Jan 2025 (15 months) gives 56 matching posts including replies and 20 non-reply posts. That is at most about 16 a year from Musk, before removing false positives and before the share filter. The paper's own catalyst set was 27 Musk DogeCoin tweets in about 29.5 months, about 11 a year. Of 46 deep-pool Solana memes, only 2 themes (dog, cat) have two or more established tokens by name. Power arithmetic: at about 16 eligible catalysts a year, the gate's 300 out-of-sample trades would take about 19 years. Finishing in one year needs 25 or more eligible entries a month after the share filter, which no source checked here is shown to supply. The forward catalyst rate from Google Trends RSS is unknown: one snapshot had 10 items, and the daily rate was not measured. Phase A of the collector exists to count it.

**Cost and time:** This study: about 15 external calls, none to GeckoTerminal, no pump.fun and no Helius; nothing written to the repo. Scratch files are in /tmp/claude-0/-home-user-Meme-snipe/b87ffbbf-f1e1-5a15-b7d3-6a3e38afe9c2/scratchpad/h2/.
- **Forward collector build:** about 1-2 days if it reuses the worker's PumpPortal new-token feed and logsSubscribe, plus a Google Trends RSS poller and the frozen roster job.
- **Running cost:** $0 for the free feeds, plus the existing Helius plan for roster-pool logs (credit use per websocket message unverified). X is optional at $0.005 per post read and needs the owner's account and approval of the spend.
- **Phase A:** 4 weeks, counting events only.
- **Phase B:** 300/r months, where r is eligible entries a month. At a Musk-only rate that is about 19 years; it needs r of 25 or more to finish within a year.
- **Paid historical pilot (exploration only, does not count toward the gate):** X full-archive post reads at $0.005 a post for a fixed account list, Helius credits for swaps at each event (not estimated), CoinMarketCap weekly snapshots free. Owner approval is needed for X.

- Source: Li, T., Shin, D., Sun, C., Wang, B. (2023). 'The Dark Side of Decentralized Finance: Evidence from Meme Tokens.' Preliminary Draft, 12 July 2023; SSRN abstract 4228920. PDF: https://chuyi-sun.github.io/repo/papers/meme_token.pdf. On BSC from Sep 2020 to Dec 2021, using daily data, same-keyword meme tokens move together on the same day (coefficient about 0.10, R2 about 0.3-1%). Issuance, volume and rug pulls follow past 14-day style returns. After 27 Musk DogeCoin tweets, doge-named tokens rose about 10% in price and 40% in volume relative to other meme tokens on day 1, and issuance rose 20% or 30% (the paper gives both). There is no leader-versus-clone comparison, no intraday timing, no costs and no tradable return. Most tokens die within 2-3 days. (Full PDF opened and read on 2026-10-07 (sections 3-6, Tables 2 and 4). The SSRN landing page returned 403; the SSRN listing was seen in a web-search result only. No journal version was found in one search (unverified).)
- Source: Mongardini, A. M., Mei, A. 'A Midsummer Meme's Dream: Investigating Market Manipulations in the Meme Coin Ecosystem.' arXiv 2507.01963. 82.8% of meme tokens that rose more than 100% show signs of artificial growth (wash trading, pool-based price inflation). For H2, this means a buyer-share signal can be faked by wash buying. (Listed by the arXiv API query on 2026-10-07; the figure comes from search snippets and the repo's research/hype/RESEARCH.md. I did not open the full text.)
- Source: Barber, B., Odean, T. (2008), attention-driven buying (cited in Li et al. 2023, p.5). As cited by Li et al.: models of attention-driven trading predict negative abnormal returns after intense buying. Li et al. add that in meme tokens attention is mostly absorbed by new token supply. (Only the citation inside the Li et al. PDF was read; the original was not opened (unverified).)

## H3-liquidation: testable-now

H3 (buy the third coin after one wallet dumps three coins within 10 minutes) can be measured now on historical data. It needs the project's existing Helius key and credits; this session has neither, so a session that holds the key must run the pilot. The cheap tool is Helius getTransactionsForAddress (gTFA). Its docs, read 2026-10-07, say 10 credits per 100 full transactions, with unlimited mainnet history. Per candidate drop, the lookback and holding-time checks cost about 20-40 credits.

Two problems decide whether the test is worth running.

(1) Events with a real price drop look rare, and nothing in the repo lets us estimate their number. The absorption probe has committed only HYPOTHESIS.md, with no event table on any remote branch or on this machine. In my small public-RPC probe (11 pools, 330 sampled pool transactions), 20 wallets sold 90% or more of a coin. Only 2 of those 20 had sold 2 or more other coins in the previous 10 minutes, and both moved the price by less than 0.02%. None of the 20 caused a drop of 3% or more; the largest was 2.02%. On GeckoTerminal 5-minute bars, the deep cheap-venue pools showed 0 bars a day with a 3% or larger intrabar drop; small pools such as CRIME showed about 7 a day. The pilot must measure the real frequency first.

(2) The cited analogue is weaker than the reviewer suggests. Coval and Stafford (JFE 2007) work on quarterly holdings. Their reversal (+7.7% over months 4-12) needs widespread forced selling, meaning 15% or more of a stock's owners were funds selling because of investor outflows. Isolated distressed selling, which is what one wallet is, gave only -2.5% with small economic magnitude. On Uniswap, Ante (2022) found that large sells are followed by further falls (continuation, not recovery), with part of the move happening before the trade. So the prior for a 30-minute rebound is low.

The design below defines the event, the decisive single-coin control, how events are found and what each costs, all fixed before any return is computed. I computed no return or outcome. The repo is unchanged.

**Events (no outcomes):** No event count can be derived from committed data; the pilot must measure it. A rough upper bound, counted without any outcome:

(a) Candidate drops: in 9 of 11 measured pools, 5-minute bars with a 3% or larger drop happened 0-0.3 times a day. CRIME had about 7 a day. The 11 pools together had about 7.8 a day, about 90% of them from CRIME.

(b) Share of drop-causing sellers that fit H3: unknown. The only measurement is among small full exits (2 of 20, CI 1-32%), and no H3-shaped sale moved the price by 3% or more (0 of 20).

If drop sellers were H3-shaped as often as small sellers, which is an untested assumption, the 11 pools would give at most about 0.8 events a day, mostly in one coin. Extrapolating to the 46 cheap-venue pools (plus PumpSwap deep pools) gives perhaps 1-4 a day at most, and plausibly far fewer. 90 days of history would then hold at most a few hundred events, clustered in a few small coins, and fewer after one entry per coin per day and the hold-time, creator and bot exclusions.

Pilot method, fixed before any outcome is computed:
1. Screen 5-minute bars of the frozen universe for drops of at least D%. D is frozen in advance, for example 3%.
2. For each drop, find the causing sale or sales with gTFA on the pool over that bar.
3. For the seller, run gTFA over the 600 seconds before the sale and classify: H3 event (3 or more exits of 90% or more paid in SOL or stables) or single-coin control.
4. Report counts per group, per coin and per day, with no price after the event.

If fewer than about 100 H3 events remain after exclusions, the test is 'unresolved', not run.

**Cost and time:** This session cost: about 480 cached public RPC calls (plus about 30 test calls and uncounted retries after 429s), 14 GeckoTerminal calls (3 got 429), 0 Helius and 0 Hyperliquid calls.

Pilot, historical (needs the Helius key; this session has none):
- Candidate screen: GeckoTerminal 5-minute bars, about 9 calls per pool per 30 days. That is about 415 calls for the 46 cheap-venue pools, about 50 minutes at a 7-second pace. GeckoTerminal is shared with another running download, so this must be scheduled with it.
- Per candidate drop: gTFA on the pool for the bar (about 10 credits; 11-40 transactions at 128-474 an hour). Then gTFA on the seller over [t-600, t], full mode, tokenAccounts=balanceChanged, status=succeeded, v1 included: 10 credits whenever the wallet has 100 or fewer transactions in the window (19 of 20 probe wallets had 13 or fewer). Then a hold-time check with gTFA in signatures mode with tokenTransfer {mint, direction: in}, sortOrder asc, limit 1: a flat 10. The tokenTransfer filter on swap buys is still to be verified in the pilot.
- Total per candidate: about 30 credits, the same under heli.py's 10-per-call convention. With getSignaturesForAddress plus getTransaction instead, it is (1+k) calls with k 0-13 (37 or more for a bot): 1-14 credits at doc prices, 10-140 at the ledger convention.
- Optional diagnostics, only on H3 events and a matched control sample: Wallet API Funding Source (100 credits) to find clusters, and Historical Balance (100 credits per token) to audit the 90%-of-holdings figure.
- Outcome stage, a separate later step after the PREREG is frozen: gTFA on the pool for 60 minutes after entry, 10-50 credits per event or control.
- For 1,000 candidate drops: about 40,000-90,000 credits. Scanning full pool histories instead would be about 3.6M transactions per 30 days for 46 pools at about 110 an hour each: about 360,000 credits with gTFA, against 3.6M with getTransaction at doc prices or 36M at the ledger convention. Either way it fits well inside the absorption probe's 4M cap.

Calendar: about 1 day of agent work for the pilot counts, plus the GeckoTerminal screen time. If the count is enough, add 1-2 days for the PREREG and outcome stage. Running it forward (live) at the rates seen would take months to reach 100 events.

- Source: Coval, J. and Stafford, E. (2007), 'Asset fire sales (and purchases) in equity markets', Journal of Financial Economics 86(2), 479-512 (NBER WP 11357, May 2005). US mutual funds, 1980-2003, from quarterly Spectrum holdings plus CRSP flows. A forced sale is a decrease in holdings while the fund has outflows of more than 5%. A fire-sale stock has PRESSURE of -15% or below: net forced sellers make up at least 15% of the stock's fund owners. Its abnormal return is -10.1% in the event quarter (t=-11.52), followed by a +7.74% rebound over months 4-12 (t=4.43). Isolated distressed selling (-15% < PRESSURE < 0) gives only -2.52% with small economic magnitude. Widespread selling by funds not forced to sell reverses much less. Relevance: the effect needs many sellers who are verifiably forced, and it plays out over quarters. H3 has one wallet whose forced-ness is only inferred, over 30 minutes, which is closest to their weak 'isolated' case. (Read the NBER working-paper PDF text (pdftotext, lines 350-500), the NBER page https://www.nber.org/papers/w11357 and RePEc https://ideas.repec.org/a/eee/jfinec/v86y2007i2p479-512.html, 2026-10-07)
- Source: Ante, L. (2022), 'Liquidity shocks, token returns and market capitalization in decentralized finance (DeFi) markets', Blockchain Research Lab Working Paper No. 26 (published 6 Aug 2022). 2.77M swaps of 14 tokens on Uniswap v2/v3 and SushiSwap. Larger sell orders are followed by negative future returns. For unusually large sells (top 1%) the market reaction is -7.4 times the economic value of the trade, and much of the abnormal return happens before the event (arbitrage or MEV front-running). This is direct DEX evidence for continuation, not reversal, after large sells. It is the prior H3's single-coin control must beat. (Downloaded the PDF from https://www.blockchainresearchlab.org/wp-content/uploads/2020/05/BRL-Working-Paper-26-Liquidity-shocks-token-returns-and-market-capitalization-in-DeFi-markets.pdf and read the abstract, 2026-10-07; also cited in docs/research/edge.md line 172)
- Source: Alexander, G., Cici, G. and Gibson, S. (2007), 'Does motivation matter when assessing trade performance? An analysis of mutual funds', Review of Financial Studies 20(1), 125-150. Trades made for liquidity reasons and trades made on valuation views perform differently. Purchases made during heavy outflows are valuation-driven and beat the market; purchases forced by inflows do not. This supports H3's identification idea that liquidity-motivated trades carry less information, but at fund and quarterly scale. (Only the bibliographic data and a summary from search results (RePEc https://ideas.repec.org/a/oup/rfinst/v20y2007i1p125-150.html, UMN experts page). Full text not read.)

## H4-listing: testable-with-paid-data

H4 (first spot listing of an already-tradable Solana meme on a new big retail venue) can be checked historically for its two kill conditions: is the move already over before an executable entry, and are post-arrival net returns negative? It can never reach the pre-funding gate. That gate needs at least 300 out-of-sample trades. The whole qualifying population from Jan 2024 to Oct 2026 is about 77 verified events, and the 2026 rate is about 0.6 a month.

Literature: the reviewer's claim checks out. Effects do differ by exchange: Ante 2019 found a day-0 abnormal return of 5.7% and up to 25.5% on a few exchanges, with negative results on others. But every study I opened uses DAILY prices, samples from 2017-2021, ICO tokens or altcoins, with no Solana or DEX memes. Each also documents gains before the event: 4.97% over the 3 days before listing in Ante and Meyer 2020, and 6% on the day before the announcement in Li et al. An industry study from 2026 (The Tie) found the gains concentrate before day 0 and mean-revert within two weeks, and that 2024-25 listings had smaller effects. So no study measures what a bot could capture after it receives the announcement.

Data:
- **Binance:** the only venue with a free, complete announcement history with millisecond timestamps. It is the CMS API (verified). It has 6 Solana-meme spot events in 2024-26, all older than 180 days.
- **Other venues, trading-start times (free, exact):**
  - Coinbase: first trade from the trades endpoint (delisted products are kept).
  - Kraken: first trade from the trades endpoint.
  - Upbit: candles back to 2017.
  - OKX: instrument `listTime`.
- **Other venues, announcement times (blocked or partial):**
  - Upbit notices: Cloudflare 403 from here.
  - Bybit: geo-blocked 403 here (the API is documented).
  - OKX announcements API: only back to 2025-06, and filtered to the US/AUS region from here.
  - Coinbase, Kraken and Robinhood: X posts only (X API is paid).
- **GeckoTerminal free 1-minute bars:** only the last 180 days (verified HTTP 401 for WIF on 2024-03-05). Inside that window bars exist around 3 Upbit events. Coverage depends on the pool: USELESS had 716 of 720 minutes in ±6 h; WIF's Raydium v4 pool had 548 of 720, with a 50-minute gap.

An honest test needs:
- announcement times outside Binance (paid X/news archive, or manual minute-level collection);
- transaction-level pool replay around each event (Helius credits the owner already has; no key in this session) instead of 1-minute bars.

Bounding the receipt+6 s entry with 1-minute bars:
- **Time t:** t = publish time (Binance ms, or minute ±60 s elsewhere) + receipt latency + 6 s.
- **Fill range:** the long fill lies in [min(low of bar B0, close of bar B-1), max(high of B0, close of B-1)], where B0 is the bar containing t. Widen to bar B+1 for minute-level announcement times and for the 60-second robustness entry.
- **Conservative line:** use the upper bound plus fee and own price impact. If the band is wider than the effect, the result is inconclusive and needs tx-level replay.
- **Receipt latency:** cannot be known historically. It must be measured forward by the live collector and applied as a distribution. Binance's API is free for this; Tree of Alpha's free API keeps only about 6 days, so it can benchmark receipt times forward only.

No trading return or outcome was computed. Only timestamps, bar counts and event counts. Scratch data is in /tmp/claude-0/-home-user-Meme-snipe/b87ffbbf-f1e1-5a15-b7d3-6a3e38afe9c2/scratchpad/h4/ (raw/ for venue JSON, gt/ for GeckoTerminal bars, and binance48_2024on.json). It is outside the repo and nothing was committed.

**Events (no outcomes):** Counted without any outcome: event times and listing dates only. One event is (Solana meme, venue): the coin's first spot listing on that venue, 2024-01-01 to 2026-10-07. Perps, extra quote pairs and Earn/Margin additions are excluded.

**Verified: 73 events.**
- Binance 6, from the complete announcement API.
- OKX 11, live instruments only.
- Coinbase 12, delisted products included.
- Upbit 8, live markets only.
- Kraken 36, live and cancel_only pairs.

**By year:** 2024 has 31, 2025 has 37, and 2026 to date has 5.
- 24 of the 73 fall in Dec 2024 to Jan 2025.
- 10 of the 73 have the same coin listing on another of these venues within 2 days, so they are not independent.

**Additional sources:**
- Robinhood, news-verified: 4 (WIF, PENGU, PNUT, POPCAT), giving 77.
- Unverified chain identity: 5 (Kraken FIGHT, WAR, BASED, AVA; Coinbase FIGHT).
- Not counted: Bybit (blocked from here), Robinhood's TRUMP and other dates, and delisted markets on OKX, Upbit and Kraken. My guess is that these would bring the total to about 100-130, but this is unverified.

**Other cuts:**
- Without Kraken, which lists late: 37 events, or 41 with Robinhood.
- Each coin's first listing on any of these venues: 40 coins, 39 if BONK (already on Coinbase and Kraken in Dec 2023) is excluded.

**Usable now:**
- Inside GeckoTerminal's free 180-day window: 3 events (Upbit WIF, SPX, USELESS), plus Kraken AVA if its chain is confirmed. None of them has a free exact announcement time.
- With free millisecond announcement times: 6 (all Binance), all outside the free bar window.

**Method:** for each venue, I listed spot markets or announcements and matched symbols against CoinGecko's solana-meme-coins category (top 500 by today's market cap, keyless, 2 calls) plus the repo's cheap-venue universe. I removed collisions by hand (DOGE, ADA, MASK, PEPE, BABYDOGE, SC, CAT, DOG, NEIRO, CHEEMS and others). The listing date is the first trade (Coinbase, Kraken, Upbit), the listTime (OKX) or the announcement (Binance).

**Survivorship:** the symbol list is today's, so meme coins that died and were delisted are under-counted.

**Power:** at the 2026 rate (about 0.6 verified events a month), 300 out-of-sample trades cannot be reached historically or forward.

**Cost and time:** **This probe:** about 1.5 h. Calls made:
- GeckoTerminal: 5 (cap was 60).
- Binance CMS: 35.
- OKX: 9.
- Coinbase: 16.
- Kraken: 47.
- Upbit: about 60.
- CoinGecko: 2.
- Tree of Alpha: 2.
- Web search/fetch: about 15.

All were free. No Helius, no pump.fun, no commits.

**Full kill test (estimate, uncertainty stated):**
1. **Event list with spot/perp/extra-pair split and delayed rows (about 1 agent-day):**
   - Binance is free and essentially done.
   - Coinbase, Kraken, Upbit and OKX trading-start times are free.
   - Announcement times outside Binance need either a paid X API (current price unverified) or manual minute-level collection from X and news. That is roughly 10-20 min per event, about 15-25 agent-hours for about 70 events.
   - Bybit needs a call from a location Bybit serves.
2. **Prices:**
   - The free GeckoTerminal tier covers only 3-4 events.
   - The rest need either the GeckoTerminal Analyst plan (a paid plan the owner would have to approve; price unverified) or Helius tx-level replay of each event's main pools from 1 h before to 6 h after, using the owner's existing credits.
   - Credits per event are unverified, because top memes at peak can have tens of thousands of swaps per hour. Run a 2-event pilot first to measure, under a cap set in advance (e.g. 1M, against about 3M kept in reserve).
3. **Analysis:** about 0.5 day.

**Total:** about 2-3 agent-days plus credits. The result can only be a kill or keep-exploring decision. It cannot be gate-level proof.

- Source: Ante, L. (2019). Market Reaction to Exchange Listings of Cryptocurrencies. Blockchain Research Lab Working Paper No. 3, 8 Sep 2019. https://www.blockchainresearchlab.org/wp-content/uploads/2019/10/Exploring-Market-Reactions-to-Exchange-Listings-of-Cryptocurrencies-BRL-working-paper3.pdf. This is the closest match to the reviewer's claim that effects vary by exchange.
- **Sample:** 327 listings of 180 cryptocurrencies on 22 exchanges, assets already trading at least 31 days, daily CoinMarketCap closes. Events came from the @cryptoeventbot exchange-API Telegram bot and block.cc. The event day is the listing day; announcements fell at t=-1, t=0 or elsewhere depending on the exchange.
- **Results:** abnormal return 5.7% on day 0 and 9.2% over (-3,+3). Only a few exchanges are significantly positive (up to 25.5% on day 0); others are null or significantly negative, which the paper reads as informed trading or manipulation.
- **Limits:** working paper, pre-2020 tokens, daily resolution, so the measured move includes everything before a bot could react. (Opened the BRL page (abstract) and downloaded the PDF with pdftotext on 2026-10-07. Sample and data section read.)
- Source: Ante, L. & Meyer, A. (2020). Cross-listings of Blockchain-based Tokens issued through Initial Coin Offerings: Do Liquidity and specific Cryptocurrency Exchanges matter? BRL Working Paper No. 5, 10 Feb 2020. https://www.blockchainresearchlab.org/wp-content/uploads/2020/02/BRL-Working-Paper-5.pdf. - **Sample:** 250 cross-listings of 135 ICO tokens on 22 exchanges, daily CoinMarketCap closes.
- **Results:** 6.51% on the listing day and 9.97% over (-3,+3). CAAR of 4.97% over the 3 pre-listing days and 2.66% over (-3,-2), read as leakage or informed trading. No significant positive effect after day 0; the authors say buyers 'should refrain from a hasty purchase but wait at least for three days'.
- **Per exchange:** Binance (33 events) (-3,+3) 20.3% but (+2,+3) -6.8%. Upbit (12 events) (-3,+3) 1.4%, not significant, with t+1 at -3.3%, significant. Coinbase (5 events) -2.5%. (PDF fetched and extracted with pdftotext on 2026-10-07. Abstract, methods, Table 2 rows and discussion read.)
- Source: Benedetti, H. & Nikbakht, E. (2021). Returns and network growth of digital tokens after cross-listings. Journal of Corporate Finance 66, 101853. doi:10.1016/j.jcorpfin.2020.101853. Abstract only: 3,625 tokens across 108 marketplaces (a search snippet said 113). Token prices rise about 16% (crypto-market adjusted) in the two weeks around a token's FIRST cross-listing, and daily network growth triples on the listing day. Returns are higher when the cross-listing reduces market segmentation. Daily data and an older sample, not memes. (Abstract and DOI opened on https://investigadores.uandes.cl/en/publications/returns-and-network-growth-of-digital-tokens-after-cross-listings/ on 2026-10-07. SSRN returned 403, so the full text was not read.)
- Source: Li, J., Luo, M., Wang, M. & Wei, Z. Cryptocurrency (Exchange) Listings. SSRN 4715718; extended abstract in AFT 2025, LIPIcs vol. 354, art. 11, doi:10.4230/LIPIcs.AFT.2025.11. - **Sample:** all Coinbase and Binance listings 2017-2021, daily CoinMarketCap data. Day 0 is the announcement day.
- **Results:** mean day-0 return 32.8% (Coinbase) and 22.7% (Binance); medians 18.4% and 10.1%; the day before the announcement already +3.3% and +6%. Day-0 returns do not revert over 5-180 days. More regulated exchanges show higher listing returns (index over 80 exchanges).
- **Limits:** daily resolution, so the day-0 return includes moves before and right after the announcement. (AFT extended abstract PDF extracted on 2026-10-07. The full-paper version (Loyola conference PDF, J_Li.pdf, footer 'ssrn.com/abstract=4715718') extracted and the sample and Table 3 text read.)
- Source: Moss, J. (The Tie), 'What Does an Exchange Listing Actually Deliver in 2026?', 13 Jul 2026 (industry research, not peer-reviewed). https://www.thetie.io/insights/what-does-an-exchange-listing-actually-deliver-in-2026. - **Sample:** 1,844 listing events on Binance, Coinbase, OKX, Bybit and Kraken (Upbit and Bithumb tiered), Jan 2023 to Jun 2026, daily CCData. Day 0 is the first trade.
- **Results:** gains are front-loaded before day 0. Post-listing drift is short-lived and largely mean-reverts within two weeks. The 2024-25 cohorts are weaker than 2023. First-listing tokens show the steepest post-listing decline. No exchange consistently delivers better price outcomes. Kraken is a later-stage lister, and Upbit lists hours before trading. (WebFetch summary of the page on 2026-10-07. Tables not inspected, so the numbers depend on the fetch summary.)
- Source: Wu Blockchain, 'Investigation report: Is There Insider Trading in Binance and Coinbase's New Listing', 22 Mar 2022. https://wublock.substack.com/p/investigation-reportis-there-insider. Journalism using hourly prices over the 7 days before announcements (Nov 2017 to Feb 2022). Median run-up before the announcement was +22.6% for Coinbase (118 coins) and +5.1% for Binance (167), against flat BTC. This is evidence of leakage before the public signal. (WebFetch summary on 2026-10-07.)
- Source: Four Pillars, 'The dying Upbit listing pump' (https://research.4pillars.io/en/data/content/the-dying-upbit-listing-pump). Unverified. The title suggests Upbit listing pumps are fading. (Found in search. Two fetch attempts returned HTTP 429; not read.)

