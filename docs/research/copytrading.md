# Copy-trading whale wallets (RES-2)

Research date: 2026-10-03. Question from the owner: can Zeroed watch "smart money" wallets that trade meme tokens and
buy what they buy? Can that be a reliable entry signal with positive expectancy after costs and latency?

Everything below is recomputable:
- Test-window numbers: `python3 research/copytrading/analyze.py replay research/copytrading/derived/final_replay.json.gz`.
- The full pipeline: `analyze.py final`, which needs the raw stream.
- The rules were pre-registered in `research/copytrading/PREREG.md`, committed at 12:40 UTC (commit `13fb144`),
  before any test-window data existed.

## Bottom line

<!-- RESULTS -->

## A. What published evidence says

Full notes and sources: section "Sources" below. Vendor claims are labelled; anything not confirmed is marked
unverified.

**Profitability**
- Most pump.fun wallets do not make large profits.
  - A January 2025 Dune analysis found 0.4% of 13.4M wallets realized $10k or more
    ([Decrypt](https://decrypt.co/300403/pump-fun-traders-millionaires)).
  - CoinGecko found 73% of wallets had some realized profit in April 2026, but 65% of wallets made only $1-$500
    ([CoinGecko](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)).
  - Both are realized-PnL views: bags are ignored, prices of illiquid tokens can be wrong, and bots are not filtered.
- **The only peer-reviewed copy-trading study** found ("Resisting Manipulative Bots in Meme Coin Copy Trading", WWW '26,
  [arXiv 2601.08641](https://arxiv.org/abs/2601.08641)) used 6,000 Solana meme coins.
  - Smart-money wallets averaged +14% per investment.
  - Copiers averaged +3% after bonding-curve price impact and costs, and only with the authors' own bot filter.
  - Plain copying baselines were negative.
  - Bundle bots appeared in about 25% of projects.
- No audited, independent PnL exists for users of copy-trade bots (Trojan, Axiom, BonkBot, Photon, GMGN, BullX). Every
  win-rate claim is vendor-only.

**Failure modes (with evidence)**

| Failure mode | Evidence |
|---|---|
| Copier is late and pays the leader's price impact | On a bonding curve, late entry is penalized by construction. The +14% (leader) vs +3% (filtered copier) gap above ([arXiv 2601.08641](https://arxiv.org/html/2601.08641)) |
| Snipers front-run copiers | Snipers act within 1-5 blocks. One study counted 4,600+ sniper wallets, 87% profitable, 55% out within a minute ([Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines)) |
| Coordinated wallet rings | 1,012 persistent rings (2,965 wallets) in 166k launches over 13.4 days ([arXiv 2607.02795](https://arxiv.org/abs/2607.02795)) |
| KOL promotion, then dump | SHAR: 60% of supply bought at launch across 100+ wallets, then sold for about $3.4M while 50+ influencers promoted it ([Decrypt](https://decrypt.co/288160/solana-meme-coin-sharpei-epic-rug-pull)) |
| Insider cluster drains the pool | LIBRA: linked wallets withdrew $87M in about an hour ([Bubblemaps](https://blog.bubblemaps.io/the-libra-playbook-how-one-cluster-drained-87-million-in-a-single-hour/)) |
| Wallet splitting: one person, many wallets | SHAR (100+ wallets into one); deployer-funded fresh sniper wallets (Pine) |
| Bait wallets that pump on copiers | Described as a general tactic in arXiv 2601.08641. **No named case with a loss total was found (unverified).** |
| Wash-traded PnL, survivorship in top-wallet lists (GMGN, Cielo, Birdeye, Nansen) | Lists rank by past realized PnL over rolling windows, which selects luck as well as skill. **The ranking formulas are not published (unverified).** |

**How disciplined traders pick wallets**
- Practitioner conventions, not tested rules:
  - at least 50 closed trades over 30 or more days, across 10 or more tokens;
  - a stable rolling win rate;
  - win rates above 65% treated as a wash-trade or insider flag;
  - a check that the wallet's tokens had enough liquidity to exit
    ([MadeOnSol](https://madeonsol.com/blog/how-to-build-solana-wallet-scoring-system),
    [Nansen docs](https://docs.nansen.ai/guides/templates/complex-use-cases/use-case-4-copytrading-top-performing-wallets)).
- Funder and same-block clustering is how Bubblemaps and Pine Analytics linked wallets.
- No published measurement of how fast a wallet's edge decays was found.

**Data paths to watch N wallets** (provider pages, 2026-10-03)

| Path | Cost | How | Limit |
|---|---|---|---|
| Public RPC websocket | $0 | `logsSubscribe` with `mentions`, one address per subscription | 40 connections per IP; "not intended for production" ([Solana docs](https://solana.com/docs/references/clusters)) |
| Public RPC websocket, program-wide (used here) | $0 | `logsSubscribe` on the pump.fun and PumpSwap programs; filter wallets locally | 2 subscriptions see every wallet. About 1.5 MB/s of logs (measured), so too heavy for a phone, fine for a server |
| Helius Free | $0, 1M credits | Webhooks, 1 credit per event; standard websockets at 2 credits per 0.1 MB | 25 addresses per webhook in the dashboard; API cap unverified ([Helius](https://www.helius.dev/pricing)) |
| Helius Developer | $49 | `transactionSubscribe` with up to 50,000 addresses | 10M credits |
| PumpPortal | 0.01 SOL per 10,000 events | `subscribeAccountTrade` | Needs a key and a funded wallet (at least 0.02 SOL) ([PumpPortal](https://pumpportal.fun/data-api/real-time)) |

## B. Our test on chain data

### Method

<!-- METHOD -->

### Results

<!-- TABLES -->

### Limits

<!-- LIMITS -->

## C. Verdict and what Zeroed does with it

<!-- VERDICT -->

## Sources

<!-- SOURCES -->
