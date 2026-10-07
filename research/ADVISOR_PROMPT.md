# Prompt for an outside adviser (copy everything below the line)

---

You are a senior quant researcher with experience in crypto market microstructure, Solana DEXs and statistics. Please review our research on a Solana meme-coin trading bot and advise. Be blunt. Never invent numbers, papers or APIs; label anything you are unsure of; if you think there is no edge, say so.

## Goal
A bot that is profitable over a month or over about 100 trades, in any payoff shape: a win rate above 50%, or a low win rate with rare huge winners that cover many small losses. The owner is an experienced trader, accepts losing streaks, and does not need perfection. Off limits for ethical and legal reasons: front-running or sandwiching other users, wash trading, spoofing, coordinated pumps, launching coins to dump on buyers, exploiting bugs. Everything else (shorting, leverage, other venues, other chains) is open for research.

## Setup and costs
- Engine trades canonical PumpSwap pools (pump.fun graduates). Fees by market-cap tier: 1.25% a side for young pools, falling to 0.30% a side at 98,240 SOL market cap or more. Fixed cost per round trip about 414,000 lamports (conservative: landing fees, failed exits, lost token-account rent).
- Real round trip: about 2.5–3% plus impact in young pools; about 0.66% at $100 in the best tier.
- Our landing delay is about 1–6 seconds after a signal. Same-block arbitrage is taken by a few specialised bots (73% of arbitrages land in the trigger's own block).
- Data used so far: GeckoTerminal hourly and 5-minute OHLCV (volume is in SOL), pump.fun's public API, Hyperliquid's public API, public Solana RPC. All tests use data before 2026-09-21; the window 2026-09-22 to 2026-10-20 is a sealed holdout.

## What we tested (rules fixed in advance; results after costs)
1. Graduation window (first hour after a coin moves to PumpSwap), 72 rules on 518 graduations: none positive. Copying top wallets: about −11% a trade.
2. Buying sharp 5-minute drops in 41 established coins in cheap pools: price bounces +0.1% to +0.6% on average, mostly within 5 minutes, below the 0.85–1.0% round trip. Win rate 30–37%, every month negative.
3. Daily holds (1–7 days) on 477 pump coins: all failed. "Buy after a 22%+ daily drop, hold 3 days" made +5.7% a trade (44% wins, average win +46%, average loss −26%), but on a survivor-only coin list: in a random sample, that list held only 1 of 33 coins that ever reached tradeable size; the other 32 died later. On the random sample every eligible trade lost (very few trades). A full 16,000-coin survivorship-free re-test is downloading.
4. Weekly trend and momentum on 19 large memes, priced in SOL, 2024 to 2026: all failed. The basket rose 26% against SOL until mid-2025, then fell 51%.
5. "Lottery basket": buy every fresh graduate 1 hour after graduation, hold 7–30 days with no stop. 900 random coins: win rate 2–4%, −24% to −40% a trade, 0% chance that 100 trades end positive. 29% of graduates are dust pools (almost no liquidity); about 14% show bogus pump-and-dump price prints (1,000×+ on tiny volume).
6. Structural routes: providing liquidity lost (median −2.5% to −7.4% in SOL); funding carry about −1.6% a year in SOL; arbitrage needs sub-slot speed; protocol cashback and volume rewards are inactive. Staking idle SOL (about 4.8% a year) is the only rule-based SOL growth found.
7. The owner's idea, "cut every loss, ride the rare winner": enter 1 hour after graduation, cut loss at −30%, once the price reaches 2× sell when it falls 60% from its peak; 492 random non-dust graduates (2026-07-22 to 08-20), $10 bets. With exits at the trailing level ("real-time"): +56% a trade, but all of it from one coin worth about 330×; without that trade, −11% a trade. With exits at hourly closes: +4%. Selling half at 5× and trailing the rest: +26% (real-time) and −7% (hourly). Selling everything at 5× or 10×: negative. In minute data, the big winner climbed in steady 0.1%-a-minute steps for two days on tiny volume (looks bot-driven), a single minute of 319 SOL of selling then cut it by 62%, and it traded for 15 minutes at about 39% of its peak before falling further. A fresh 900-coin validation sample (2026-08-21 to 09-06) is being tested now.
8. Short side on Hyperliquid perps (short new listings, short downtrends, long-short trend), delisted perps included: being tested now.

## What we would like from you
1. What biases or mistakes might still be in our method (survivorship, fake prints, look-ahead, stop slippage, costs, regime changes)?
2. Is "cut losses and ride rare huge winners" a sound strategy family for meme coins? How would you estimate how often the jackpots happen when only a few appear per sample (for example extreme-value methods), how many trades and months are needed before trusting it, and how to size bets for a heavily skewed payoff (risk of ruin, fractional Kelly)?
3. Which information available at the moment of entry (on-chain: liquidity, holders, creator history, buyer mix, volume pattern, bonding-curve behaviour; off-chain: social) has real evidence of separating future runners from dead coins, without overfitting?
4. Exit design: how to capture a runner in real time, detect a rug before it completes, and set take-profits without cutting off the tail.
5. "Riding bot-pumped coins": can a slow, steady, low-volume climb be detected early, and is riding it sound?
6. Short-side or other structural edges we missed, and their real-world risks (squeezes, liquidation, platform risk, legality for an Australian resident).
7. Your recommended next three tests, in order, each with a clear kill rule.

Please answer in plain English, with concrete rules we can test, and say how confident you are in each point.

---

## Follow-up 1 (2026-10-07, after your review; copy everything below the line)

---

Thank you. Here is what changed since your review, what we found, and where we would value your judgement.

**Applied (all written into the pre-registrations before any validation price was read):**
- Runner validation: a fresh random sample of 900 graduates created 2026-08-21..09-06 (seed fixed, drawn before any of its prices), disjoint from the exploration sample. Rules R1–R4 frozen; R4 is a take-profit ladder (half at 5×, fill at the level only in an hour with ≥ 20 SOL volume, rest trails 60%). 14-day holds end by 2026-09-20, before the sealed window (2026-09-22..10-20).
- Truncated holds are dropped, not closed early. Every result also reports: returns capped at 20× (statistics only), a chronological account with $10 bets at their entry hours, overlapping positions, P&L by month, worst drawdown and peak capital tied up, and counts of ≥ 10× and ≥ 50× trades. The old "0% chance" line is now "share of 10,000 resampled batches with a positive total", with the caveat that it cannot show winners the sample never had. Objective: growth in SOL.
- Jackpot capacity check on the exploration's ~330× coin (minute bars): one minute of 319 SOL selling cut it to 38.6% of peak, where it traded for 15 minutes. At that level the pool held about 519 SOL of quote. Selling a $10 position (~1.9M tokens) gives about 5.5% impact plus a 0.90% fee. A 60% trail was achievable there; a 40% trail could not fill at its level.
- Short probe: S2 (short downtrends) declared primary, judged against S0 (short everything) on the actual-funding line. Listing day = first bar with trades; liquidation of a 1× short at 1.714× entry; hourly funding weighted by price; signed turnover; trades past the wall dropped; a monthly-cohort gate for S1.
- Survivorship-free daily-drop test: the full universe needs daily prices for about 17,900 coins (about 35 hours of free calls), so it runs later. A small check on the random sample is registered.
- **Not done yet:** a transaction-ordered replay of the trailing rule. We plan to pay for a month of transaction data (about $94) only if the validation shows jackpots recurring.

**New exploration facts (not pre-registered; validation sample untouched):**
- pump.fun's `ath_market_cap` equals GeckoTerminal's maximum hourly high on all 492 coins checked. So it includes the opening spike right after migration and fake prints. The median graduate's ATH (~2.3× the migration price) is the opening spike and is never revisited. Unusable as an outcome label.
- Of 29,170 graduates created 2026-07-22..08-20, 9,663 (33%) have dust pools (LP supply < 1e12, read on chain).
- Exit variants on the exploration sample:
  - A tighter trail as the peak grows (60% below 10×, 40% to 50×, 30% above) was the only variant with a positive mean at pessimistic fills (+2.4%). Its capped-20× mean is negative.
  - Selling half at 2× and killing coins below 1.2× at hour 6 both hurt, because they cut the one winner.
  - Every positive line comes from that one coin.
- Creation-time links (Twitter/website/Telegram), repeat creators and slow graduation separate nothing at pessimistic fills. Coins with no links did worst (−32.7% vs −16.0% for 2+ links; n=73).

**New owner hypothesis, research running:** big runners are attention cascades. An influencer, Telegram call group or trend points at a coin, the crowd piles in, then one big holder sells and panic follows. We are researching:
- public signal sources: X API, public Telegram channel previews, DexScreener boosts/profiles, pump.fun comments and livestreams, GeckoTerminal trending;
- whether timestamped history exists for July–August 2026 coins;
- on-chain attention proxies: unique buyers per minute, buy acceleration;
- exits triggered by a top holder or the dev selling;
- the literature on what followers of public calls earn.
Read-only: the bot never posts, pays for promotion or joins pump groups.

**Questions:**
1. Every positive result rests on one ~330× coin in 492. Before we pay for transaction data, what minimum validation evidence would you accept? For example: at least k trades of ≥ 10×, a positive capped mean, positive months? Is there a better test for a jackpot strategy than a mean with a t-interval, such as a tail-index or peak-frequency estimate compared between exploration and validation?
2. Attention signals: the historical hype records we can reach (Telegram channels found today, comments still online) come from channels and coins that survived. How would you remove that selection bias? With the sealed window ending 2026-10-20, would you rather run one clean forward test?
3. Can following public calls ever be positive for a bot with seconds of latency, given that callers often buy first? Which leading signals would you rank first: caller wallets buying, paid DexScreener boosts, comment velocity, unique-buyer growth?
4. Exits: is a "big holder sold" trigger likely to beat a 60% price trail after costs, on constant-product pools of about 85–500 SOL depth? How would you test it without transaction-level data?
5. Research-wide selection: we have now tried many families: graduation window, copy-trading, 5-minute dip/breakout, daily holds, weekly trend, lottery basket, runner exits, short side, socials and creator cuts. How should the bar for the next confirmatory test change? Would you commit to a single test?
6. What route are we missing?
