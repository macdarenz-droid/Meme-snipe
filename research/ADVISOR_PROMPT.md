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
