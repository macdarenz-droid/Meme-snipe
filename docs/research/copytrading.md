# Copy-trading whale wallets (RES-2)

Research date: 2026-10-03. Question from the owner: can Zeroed watch "smart money" wallets that trade meme tokens and
buy what they buy? Can that be a reliable entry signal with positive expectancy after costs and latency?

Everything below is recomputable:
- Test-window numbers: `python3 research/copytrading/analyze.py replay research/copytrading/derived/final_replay.json.gz`.
- The full pipeline: `analyze.py final`, which needs the raw stream.
- The rules were pre-registered in `research/copytrading/PREREG.md`, committed at 12:40 UTC (commit `13fb144`),
  before any test-window data existed.

## Bottom line

**Verdict: copying whale or smart-money wallets is not a usable entry signal for Zeroed on this evidence. Do not
build it.** The test was pre-registered and out-of-sample, on every pump.fun and PumpSwap trade from 12:37 to 15:20 UTC
on 2026-10-03.

1. **The pre-registered main test loses money.** It copied the selected wallets that hold long enough to follow (S2),
   about 2 s behind, at $5, selling when the wallet sells.
   - n = 178 copied buys from 32 leader wallets.
   - Mean net result **-11.0%** per trade (95% CI -15.9% to -5.9%). Median -9.7%. 28% of trades won.
   - Resampling whole leaders instead of single trades (trades of one wallet are not independent), the CI is -16.9%
     to -4.7%. The largest leader gave 35 of the 178 signals (20%).
2. **Nothing else made money either.** None of the 120 variants tried had a positive mean after costs, and none had a
   confidence interval above zero, by trade or by leader.
   - The variants covered 3 wallet sets, 4 delays (1, 5, 25 and 75 slots, about 0.4 s to 30 s), 4 sizes ($2, $5, $50,
     $200), 2 exits, and an optimistic 1-slot fill.
   - The best was an idealised copy of the top-PnL wallets, landing in the very next slot at $50 and mirroring their
     with its own stop and take-profit: -2.6% (CI -7.2% to +2.1%).
   - With no adverse fill at all (0% instead of 0.5% per side), still no variant has a positive mean. The best is
     -1.6% (CI -6.3% to +3.2%).
   - The frozen code had shown 4 positive cells (C0, $200, own exit E2, +17% to +19%). All 4 had CIs including 0. They
     came from one simulation error on a pool whose liquidity was pulled; see Deviations.
3. **Why it fails, from the data:**
   - **The wallets whose profits persist are too fast to copy.** The top-PnL wallets (S1) kept making money in the
     test window: 59% of them were positive, +122 SOL in total. But their median hold is 32 s. At a 2 s copy delay,
     56% of our fills cost more than 10% above the wallet's own price, and the copies lost (-6.1% mean; CI by leader
     -10.0% to +2.6%).
   - **One wallet dominates S1.** It gave 162 of the 328 S1 signals (49%), so the S1 results rest largely on that one
     wallet (36 leaders in total).
   - **The wallets slow enough to copy have no persistent edge.** Only 36% of S2 wallets (median hold 143 s) were
     profitable in the test window. Their formation-window profit did not carry over.
   - Copying random active wallets (control C0, n = 1,742) loses -9.6% at 2 s and $5 with the mirror exit.
     - With the mirror exit, S1 loses about 3.5 points less than C0 (-6.1% vs -9.6%).
     - With its own exits, S1 is about the same as C0 (-5.1% vs -5.3%).
     - S1 is still negative either way. Selecting by past PnL did not produce a copier profit.
4. **This matches the literature.** The one peer-reviewed study found that leaders make money (+14%) and plain copying
   loses; only a purpose-built filter left copiers +3%
   ([arXiv 2601.08641](https://arxiv.org/abs/2601.08641)). Our free data path is also about 0.76 s behind the block
   (median, at `confirmed`), so a same-slot copy is not possible on it.

A whale buy stays what the brief said it could only ever be: never an approval. On this evidence it is not even a useful
trigger, so Zeroed does not use it.

## A. What published evidence says

Sources are listed at the end. Vendor claims are labelled; anything not confirmed is marked
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

**Data (free, no keys).** `collect.mjs` subscribed to public RPC `logsSubscribe` (commitment `confirmed`) on the
pump.fun bonding-curve program and the PumpSwap AMM program. It decoded the trade events from the logs: wallet,
direction, SOL and token amounts, and pool reserves.
- This sees every trade on these venues, whatever the token. There is no list or ranking, so there is no survivorship.
- Collected 12:37 to about 15:27 UTC, 2026-10-03.
  - 2.71M trade events up to 15:20 on 13,975 tokens.
  - PumpSwap pools not quoted in WSOL (USDC, reversed and other pairs; 851k events) were left out.
- Getting full swap history through public RPC `getTransaction` was ruled out. One pool alone had about 2,300 swaps in a
  day, and the per-method limit is about 4 calls a second.

**Data quality checks** (all in `research/copytrading/derived/`):
- **Capture:** for 20 random PumpSwap pools and 20 bonding-curve tokens (13:00-13:50), all on-chain successful
  transactions were listed with `getSignaturesForAddress`. For the ones the stream missed, a random 80 per group were
  fetched. None of the 160 contained a trade event, so the estimated capture of trades is about 100%. The misses are
  non-trade transactions.
- **Gaps:** 7 websocket reconnects, all in the test window (14:15-15:18). The longest gap with no received data was
  1.7 s. Trades in those gaps (about 10 s in total) are missing and were not backfilled.
- **Lag of the free path:** a trade arrives a median **0.76 s** after its block time (p10 0.31 s, p90 1.24 s, p99
  6.1 s). Block time has 1 s resolution, so each value is uncertain by ±0.5 s.
- **Fill model** (`validate_fills.py`, formation data): each real buy is predicted from the pool state just before it.
  - Bonding curve: the median error is 0.00%.
  - PumpSwap prices on an **effective quote reserve = vault + `Pool.virtual_quote_reserves`**. The virtual term is a
    signed i128, often negative since 2026-09-30 (the same math as `packages/core/src/amm/pump-swap.ts`; BT-1 replays
    353 real swaps exactly with it).
    - Pricing on the vault alone (the event's `pool_quote_token_reserves`) is wrong by a median +5.5% (p95 +31%).
    - Event versions: in 504-byte BuyEvents (the exact-quote-in style, 55% of buys), `quote_amount_in` and
      `user_quote_amount_in` sit in swapped positions compared with 489-byte events. The code takes the smaller of the
      two as the net into the pool.
    - The collector did not store the virtual term, so it is recovered exactly from each trade's own amounts:
      buy `Qeff = q*B/base - q`, sell `Qeff = q*(B+base)/base`. That value is carried to the pool's next trade.
    - Predicting each swap from the previous recorded trade in the pool gives a median error of 0.000% for buys and
      sells.
    - p10 and p90 are also 0.00%. 98.6% of buys and 99.1% of sells are within 1%. The earlier tails (buys p10
      -2.3%) were the swapped event fields.
  - In stream order, 13.5% of consecutive curve trades do not chain exactly. Most likely this is order within a slot.

**Windows (pre-registered):**
- Formation F: [12:37, 14:00).
- Test T: copy signals in [14:00, 14:50), with exits allowed until 15:20.
- The analysis code was frozen at commit `a46ba8e` (12:56) before T began.

**Wallet scoring (F only):** PnL per token = realized PnL plus the remaining position, marked by selling it into the
pool at the end of F (with fees).
- **Eligible:**
  - at least 5 tokens bought;
  - at least 3 tokens closed (90% or more sold);
  - at least 0.5 SOL bought;
  - net PnL above 0;
  - at least 55% of tokens profitable.
- **Excluded:**
  - dev wallets (the wallet created a token it traded): 1,123;
  - wallets with 20% or more of first buys in the token's creation slot (bundles);
  - co-buy clusters (same-slot first buys on 3 or more tokens), keeping only the best wallet per cluster: 44 linked
    groups, which took eligible wallets from 507 to 431.
- **S1** = top 50 by PnL. **S2** = top 50 with a median hold of at least 60 s. **C0** = all 8,105 wallets with 5 or more
  tokens (control).

**Signals:** a selected wallet's first buy of a token (at least 0.05 SOL) during T. Each token is copied once per set.
This gave 328 signals for S1 (36 leaders), 178 for S2 (32 leaders) and 1,742 for C0 (523 leaders).

**Copy simulation:**
- **Entry:** our buy fills against the pool state at the end of slot `s + d`.
- **Fill price:** constant product at our real size, using the venue's fee.
  - Bonding curve: 1.25% per side.
  - PumpSwap: LP plus protocol plus creator fee, read from the event (1.2% on pump pools).
  - Plus 0.5% adverse fill per side, and 0.00026 SOL fixed cost per round trip.
- **Our own buy stays in the pool** until we sell, as a proportional footprint.
- **Exits:**
  - **E1:** mirror the wallet's first sell, `d` slots later.
  - **E2:** own exit: stop at -30%, take-profit at +50%, or time stop at 30 minutes, whichever comes first.
- **Statistics:** bootstrap 95% CIs, 10,000 resamples, seed 7. No multiple-comparison correction; none was needed,
  since no cell is positive.

### Results

**Pre-registered primary cell:** S2, 5 slots (about 2 s), $5, E1.
- n = 178 from 32 leaders; mean **-11.0%** [-15.9, -5.9]; leader-clustered CI [-16.9, -4.7].
- Median -9.7% [-11.8, -6.6].
- Win rate 28%; worst trade -101% (fixed costs on a full loss).
- Under the pre-registered rule, the verdict is **"not a usable entry signal"**.

**Main cells** ($5 and $200). All 120 cells are in `derived/final_stdout.txt` and `derived/final_results.json`.
- Delay is in slots: 1 slot is about 0.4 s, 75 slots about 30 s.
- "Paid >10% over leader" is the share of copies whose fill price was more than 10% above the leader's own fill.

| set | delay (slots) | size | exit | n | mean [95% CI] | mean CI by leader (leaders) | median [95% CI] | win | worst | paid >10% over leader |
|---|---|---|---|---|---|---|---|---|---|---|
| S2 | 1 | $5 | E1 | 178 | -9.7% [-14.5, -4.5] | [-15.2, -3.1] (32) | -8.0% [-11.1, -4.6] | 29% | -101% | 16% |
| S2 | 1 | $5 | E2 | 178 | -8.8% [-13.9, -3.4] | [-13.6, -3.6] (32) | -23.8% [-31.8, -12.8] | 31% | -100% | 16% |
| S2 | 5 | $5 | E1 | 178 | -11.0% [-15.9, -5.9] | [-16.9, -4.7] (32) | -9.7% [-11.8, -6.6] | 28% | -101% | 20% |
| S2 | 5 | $5 | E2 | 178 | -8.9% [-14.0, -3.5] | [-13.5, -4.1] (32) | -23.8% [-31.0, -12.4] | 32% | -101% | 20% |
| S2 | 25 | $5 | E1 | 178 | -12.1% [-16.8, -7.2] | [-17.4, -6.4] (32) | -10.0% [-11.9, -5.9] | 26% | -101% | 28% |
| S2 | 25 | $5 | E2 | 178 | -11.5% [-16.6, -6.1] | [-16.4, -6.1] (32) | -24.6% [-29.3, -16.1] | 29% | -101% | 28% |
| S2 | 75 | $5 | E1 | 178 | -11.9% [-16.4, -7.3] | [-16.8, -7.1] (32) | -9.2% [-11.6, -5.6] | 26% | -101% | 28% |
| S2 | 75 | $5 | E2 | 178 | -11.8% [-17.5, -5.8] | [-18.5, -4.4] (32) | -23.6% [-28.9, -12.7] | 26% | -101% | 28% |
| S2 | 1 | $200 | E1 | 178 | -9.1% [-13.8, -4.1] | [-14.5, -2.8] (32) | -7.3% [-10.3, -4.0] | 31% | -100% | 29% |
| S2 | 1 | $200 | E2 | 178 | -8.2% [-13.3, -3.0] | [-13.0, -3.1] (32) | -22.8% [-30.8, -11.9] | 31% | -100% | 29% |
| S2 | 5 | $200 | E1 | 178 | -10.5% [-15.2, -5.4] | [-16.2, -4.3] (32) | -9.0% [-11.0, -6.0] | 28% | -100% | 32% |
| S2 | 5 | $200 | E2 | 178 | -8.4% [-13.3, -3.1] | [-12.9, -3.7] (32) | -22.9% [-30.0, -11.5] | 32% | -100% | 32% |
| S2 | 25 | $200 | E1 | 178 | -11.5% [-16.1, -6.7] | [-16.8, -6.0] (32) | -9.3% [-11.1, -5.3] | 28% | -100% | 40% |
| S2 | 25 | $200 | E2 | 178 | -11.0% [-16.1, -5.7] | [-15.8, -5.8] (32) | -23.7% [-28.3, -15.3] | 29% | -100% | 40% |
| S2 | 75 | $200 | E1 | 178 | -11.3% [-15.7, -6.8] | [-16.1, -6.6] (32) | -8.5% [-10.8, -5.0] | 28% | -100% | 38% |
| S2 | 75 | $200 | E2 | 178 | -11.3% [-16.9, -5.4] | [-17.9, -4.0] (32) | -22.6% [-27.9, -11.8] | 27% | -100% | 38% |
| S1 | 1 | $5 | E1 | 328 | -4.6% [-8.9, +0.5] | [-9.6, +2.9] (36) | -11.4% [-13.8, -8.7] | 25% | -86% | 67% |
| S1 | 1 | $5 | E2 | 328 | -5.0% [-9.6, -0.2] | [-10.5, +0.7] (36) | -28.6% [-33.2, -21.1] | 36% | -82% | 67% |
| S1 | 5 | $5 | E1 | 328 | -6.1% [-9.9, -1.6] | [-10.0, +2.6] (36) | -9.0% [-11.3, -6.7] | 27% | -87% | 56% |
| S1 | 5 | $5 | E2 | 328 | -5.1% [-9.9, -0.2] | [-10.6, +0.5] (36) | -20.9% [-26.4, -17.8] | 36% | -84% | 56% |
| S1 | 25 | $5 | E1 | 328 | -4.0% [-7.7, +0.2] | [-11.1, +2.1] (36) | -4.1% [-4.8, -4.1] | 26% | -85% | 47% |
| S1 | 25 | $5 | E2 | 328 | -6.8% [-12.4, -0.9] | [-11.0, -1.4] (36) | -18.0% [-23.2, -12.3] | 27% | -85% | 47% |
| S1 | 75 | $5 | E1 | 328 | -4.3% [-7.5, -0.6] | [-11.0, -0.1] (36) | -4.1% [-4.1, -4.1] | 22% | -86% | 46% |
| S1 | 75 | $5 | E2 | 328 | -11.2% [-16.2, -6.1] | [-16.7, -6.5] (36) | -12.5% [-19.8, -5.6] | 20% | -95% | 46% |
| S1 | 1 | $200 | E1 | 328 | -4.1% [-8.3, +0.8] | [-9.0, +2.8] (36) | -10.7% [-13.2, -8.0] | 26% | -85% | 77% |
| S1 | 1 | $200 | E2 | 328 | -4.5% [-9.0, +0.2] | [-10.0, +1.0] (36) | -27.6% [-32.1, -20.2] | 36% | -81% | 77% |
| S1 | 5 | $200 | E1 | 328 | -5.6% [-9.3, -1.4] | [-9.4, +2.5] (36) | -8.3% [-10.5, -6.0] | 27% | -86% | 68% |
| S1 | 5 | $200 | E2 | 328 | -4.5% [-9.3, +0.3] | [-10.1, +0.8] (36) | -20.1% [-25.5, -17.0] | 36% | -83% | 68% |
| S1 | 25 | $200 | E1 | 328 | -3.5% [-7.1, +0.5] | [-10.5, +2.2] (36) | -3.4% [-4.1, -3.4] | 27% | -85% | 54% |
| S1 | 25 | $200 | E2 | 328 | -6.3% [-11.8, -0.4] | [-10.4, -1.1] (36) | -17.2% [-21.9, -11.6] | 27% | -85% | 54% |
| S1 | 75 | $200 | E1 | 328 | -3.8% [-6.8, -0.2] | [-10.4, +0.1] (36) | -3.4% [-3.4, -3.4] | 22% | -86% | 52% |
| S1 | 75 | $200 | E2 | 328 | -10.7% [-15.6, -5.6] | [-16.1, -6.1] (36) | -11.7% [-18.8, -4.9] | 20% | -94% | 52% |
| C0 | 1 | $5 | E1 | 1741 | -9.4% [-11.3, -7.4] | [-13.0, -6.2] (522) | -6.4% [-6.9, -5.9] | 20% | -101% | 22% |
| C0 | 1 | $5 | E2 | 1741 | -5.5% [-7.1, -3.9] | [-7.3, -3.9] (522) | -8.2% [-9.2, -6.9] | 24% | -101% | 22% |
| C0 | 5 | $5 | E1 | 1742 | -9.6% [-11.5, -7.8] | [-13.1, -6.6] (523) | -5.7% [-6.1, -5.3] | 19% | -101% | 24% |
| C0 | 5 | $5 | E2 | 1742 | -5.3% [-7.0, -3.7] | [-7.1, -3.7] (523) | -7.1% [-8.4, -6.2] | 24% | -101% | 24% |
| C0 | 25 | $5 | E1 | 1742 | -9.3% [-11.0, -7.7] | [-12.5, -6.6] (523) | -4.4% [-4.7, -4.1] | 16% | -101% | 23% |
| C0 | 25 | $5 | E2 | 1742 | -7.2% [-8.9, -5.5] | [-9.2, -5.3] (523) | -6.6% [-7.2, -5.9] | 20% | -101% | 23% |
| C0 | 75 | $5 | E1 | 1742 | -9.0% [-10.8, -6.9] | [-11.8, -6.6] (523) | -4.1% [-4.1, -4.1] | 12% | -101% | 23% |
| C0 | 75 | $5 | E2 | 1742 | -7.7% [-9.8, -5.6] | [-10.0, -5.6] (523) | -6.0% [-6.6, -5.3] | 17% | -101% | 23% |
| C0 | 1 | $200 | E1 | 1741 | -8.7% [-10.6, -6.7] | [-12.3, -5.5] (522) | -5.7% [-6.2, -5.3] | 20% | -100% | 33% |
| C0 | 1 | $200 | E2 | 1741 | -4.9% [-6.5, -3.3] | [-6.7, -3.2] (522) | -7.5% [-8.6, -6.2] | 25% | -100% | 33% |
| C0 | 5 | $200 | E1 | 1742 | -8.9% [-10.8, -7.1] | [-12.4, -5.9] (523) | -5.1% [-5.5, -4.7] | 20% | -100% | 34% |
| C0 | 5 | $200 | E2 | 1742 | -4.7% [-6.4, -3.1] | [-6.5, -3.1] (523) | -6.4% [-7.6, -5.6] | 25% | -100% | 34% |
| C0 | 25 | $200 | E1 | 1742 | -8.7% [-10.3, -7.0] | [-11.8, -5.9] (523) | -3.8% [-4.0, -3.4] | 17% | -100% | 32% |
| C0 | 25 | $200 | E2 | 1742 | -6.6% [-8.2, -4.9] | [-8.5, -4.6] (523) | -5.9% [-6.6, -5.3] | 21% | -100% | 32% |
| C0 | 75 | $200 | E1 | 1742 | -8.5% [-10.2, -6.4] | [-11.3, -6.0] (523) | -3.4% [-3.4, -3.4] | 13% | -100% | 30% |
| C0 | 75 | $200 | E2 | 1742 | -7.4% [-9.3, -5.3] | [-9.5, -5.3] (523) | -5.3% [-5.9, -4.6] | 17% | -100% | 30% |

**Leader persistence** (the leaders' own PnL in T against F; positions marked at 14:50):

| set | median hold in F | wallets active in T | share profitable in T | total PnL in F | total PnL in T |
|---|---|---|---|---|---|
| S1 (top PnL) | 32 s | 41 of 50 | 59% | +580 SOL | +122 SOL |
| S2 (copyable hold) | 143 s | 45 of 50 | 36% | +123 SOL | +8.3 SOL (median wallet -0.15 SOL) |

**Sensitivity:**
- **No adverse fill** (`ADVERSE=0 python3 analyze.py replay ...`): see `derived/final_replay_adverse0.txt`. This
  removes 0.5% per side from every cell and does not change the conclusion. Primary cell: -10.1% [-15.0, -4.9]. 0 of 120 cells have a positive mean; the best is -1.6% [-6.3, +3.2].
- **Size:** $200 results are within about 1 point of $5. At these pool sizes our own price impact is small next to the
  wallet's lead.
- **Delay:** shorter delays do not rescue the copy. Even the optimistic same-next-slot fill loses (-2.6% best case,
  S1 at $50). The lag measured on the free path (0.76 s median) makes 2 s or more the realistic case.

### Limits

- **One window, one day, one regime.** That is 2 h 43 min of data from 2026-10-03; scoring over 83 minutes is short.
  Practitioners score wallets over 30 days or more. A longer formation window could pick different wallets. It cannot
  change the mechanics measured here: the persistent wallets hold about 30 s and copiers fill late. No free path to 30
  days of wallet-level history exists (a public RPC `getTransaction` budget of about 4 per second).
- **Venues:** only the pump.fun bonding curve and PumpSwap WSOL pools. Not Raydium, Meteora or LaunchLab, and not
  other DEX legs of the same wallet.
- **No funder tracing.** Linked wallets were found only by same-slot co-buying. Linked wallets that were missed would
  make selection look better, not worse.
- **Fees:** the bonding-curve fee was assumed at 1.25% per side rather than read from each event. PumpSwap fees were
  read from events.
- **Fills:**
  - the bonding curve's real token cap near completion is not enforced;
  - order within a slot follows stream order (13.5% of consecutive curve trades do not chain exactly);
  - after a migration with no PumpSwap trade yet, an exit is valued at the last curve state.
- **Data gaps:** the public websocket is "not intended for production". There were 7 reconnects in T, with about
  10 s of trades lost in total.
- **Formation PnL** marks open positions by selling into the pool at the end of F, including the 0.5% adverse fill
  (slightly conservative).

**Deviations from PREREG.md**

Before the freeze (before 14:00, so no test data had been read):
- The PumpSwap pool state is the event's before-reserves plus the trade's own change. This replaces "the next trade's
  before-reserves". It now uses the effective quote reserve; see item 3 below.
- Review fixes, commit `a46ba8e`:
  - our own buy kept in the pool;
  - dev runs blind to data at or after 14:00;
  - 10,000 resamples for every cell;
  - no fills on a completed curve;
  - leader sells in the signal slot seen;
  - time stop anchored at our fill;
  - unsold tokens count toward hold time;
  - bundle share taken over all first buys;
  - S2's hold filter applied before cluster reduction;
  - persistence scored on T only.

After the freeze (found while checking the test results):
1. **SOL price fetch.** Jupiter returned 403 to Python's default user agent, so the first run used the fallback
   $119.38. Fixed with a browser user agent; the final run used **$119.47**. The effect is negligible.
2. **Our-footprint fix.** The frozen code subtracted our tokens from later pool states as a fixed amount. On a pool whose
   liquidity was later pulled (42 SOL down to 0.012 SOL), that went negative and produced a +37,040% trade. That one
   trade lifted 4 C0 $200 E2 cells to a positive mean (+17% to +19%, with every CI including zero).
   - Fixed with a proportional footprint, which gives about -100% on that trade, as a real holder would get.
   - The frozen-code output is kept: `derived/final_results_frozen_code.json` and `final_stdout_frozen_code.txt`.
   - Under the frozen code, 0 of 120 cells had a CI above zero, and the primary cell was the same (-11.0%).
3. **PumpSwap price model** (after the supervisor's review, which used BT-1's measurement). The first results priced
   PumpSwap on the vault reserve with a per-pool calibrated base reserve, the median of the pool's last 5 trades. No
   cell ever priced fills on the vault alone; that model was only a diagnostic in `validate_fills.py`.
   - The calibration matched spot price but put the depth on the wrong side: a scaled base instead of
     vault + virtual quote.
   - Recomputed with vault + virtual, and with the BuyEvent field fix (504-byte events swap `quote_amount_in` and
     `user_quote_amount_in`; found by the PR review):
     - every cell's mean moved by -1.3 to +1.1 points (median +0.3) from the base-calibrated run;
     - the primary cell is -11.0%, as before;
     - wallet scoring changed slightly with the corrected buy costs: 431 wallets kept after clusters instead of 455,
       and S2 has 178 signals instead of 191;
     - the conclusion is unchanged: 0 of 120 cells positive.
   - Earlier outputs are kept: `derived/final_results_basecalib.json` and `final_stdout_basecalib.txt`.
4. SOL price at the final run was $119.59 (Jupiter, read at run time).
5. **Leader-clustered bootstrap** added after the review: whole leaders are resampled, 10,000 resamples, seed 7.
   - It is reported next to the trade-level CI.
   - No cell has a leader-clustered CI above zero.

**Variants tried:** 120 pre-registered cells, plus the 0% adverse sensitivity. Development runs used only formation
data from before 14:00 (`derived/dev_*`).

## C. Verdict and what Zeroed does with it

**No copy-trading signal in Zeroed.** Do not build wallet watching as an entry trigger.
- On this evidence, the gain belongs to wallets that are faster than any copier.
- The wallets slow enough to copy did not keep their edge.
- Copying loses about 3-12% per trade on average after costs, at every delay and size tested.

**Keep, as research tooling only (no trading use):**
- `research/copytrading/collect.mjs` is a free, program-wide trade stream. It adds no product, user data or paid
  service, and is useful for future base-rate studies.
- Quotes and simulations built on PumpSwap events must price on vault + `virtual_quote_reserves`. Using the event's
  vault reserve alone misprices fills by a median 5.5%. This is recorded in `docs/research/execution.md`.

**What would reopen it.** A new pre-registered test should show a positive primary cell with a CI above zero. It would
need two things this test lacked: a formation window of weeks of wallet history, and a delay measured on Zeroed's own
data path. That history needs a paid source, which is an owner decision.
- Helius Developer is $49/month for `transactionSubscribe` with up to 50,000 addresses.
- Wallet history of that depth would also need an archival source.

Until then, all existing hard gates stand, and a whale buy is neither a trigger nor an approval.

## Sources

- Copy-trading study (WWW '26): https://arxiv.org/abs/2601.08641, https://arxiv.org/html/2601.08641
- Coordinated wallet rings: https://arxiv.org/abs/2607.02795
- Sniper and deployer data: https://pineanalytics.substack.com/p/exit-liquidity-machines
- pump.fun trader PnL: https://decrypt.co/300403/pump-fun-traders-millionaires,
  https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- Pump-and-dump share: https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance
- SHAR: https://decrypt.co/288160/solana-meme-coin-sharpei-epic-rug-pull
- LIBRA: https://blog.bubblemaps.io/the-libra-playbook-how-one-cluster-drained-87-million-in-a-single-hour/
- Wallet selection conventions: https://madeonsol.com/blog/how-to-build-solana-wallet-scoring-system,
  https://docs.nansen.ai/guides/templates/complex-use-cases/use-case-4-copytrading-top-performing-wallets,
  https://academy.nansen.ai/articles/2132837-smart-money-101 (Nansen's copy-trade study page returned 404:
  https://www.nansen.ai/research/trading-crypto-with-nansen-smart-money)
- GMGN tags (third-party summary): https://llmbase.ai/skills/gmgnai/gmgn-token/
- Solana RPC: https://solana.com/docs/rpc/websocket/logssubscribe, https://solana.com/docs/references/clusters
- Helius: https://www.helius.dev/pricing, https://www.helius.dev/docs/billing/plans-and-rate-limits,
  https://www.helius.dev/docs/rpc/websocket.md, https://www.helius.dev/docs/enhanced-websockets/transaction-subscribe,
  https://www.helius.dev/docs/webhooks/quickstart.md, https://www.helius.dev/docs/laserstream/guides/measuring-latency.md
- PumpPortal: https://pumpportal.fun/data-api/real-time
- Alchemy: https://www.alchemy.com/pricing, https://www.alchemy.com/docs/reference/compute-unit-costs
- QuickNode: https://www.quicknode.com/pricing; Shyft: https://shyft.to/solana-rpc-grpc-pricing
