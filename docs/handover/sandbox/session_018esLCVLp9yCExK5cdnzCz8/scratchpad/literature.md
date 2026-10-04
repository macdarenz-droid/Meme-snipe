# RES-3 literature pass: as-of signals for pump.fun graduates (U2) and PumpSwap survivors (U1)

Date: 2026-10-03. Scope: new or stronger sources beyond what `docs/RESEARCH.md` and `docs/research/*.md` already cite.
Already cited in the repo (not repeated as new, only confirmed or contradicted here): MELT/MemeTrans 2602.13480, Marino et al. 2602.14860,
Li et al. 2608.20271, Chen et al. 2603.24625 (SolRugDetector), Szwajcok et al. 2609.10246, Kamat 2607.02795 / 2607.02823 / 2609.18975,
Luo et al. 2601.08641, SolRPDS 2504.07132, Mongardini 2507.01963 / 2601.22185, Mancino 2512.11850, Cernera et al. 2206.08202,
Mazorra et al. 2201.07220, Solidus Labs 2025 rug-pull report, CoinGecko trader-profit pages, Barber et al. 2014.

Main finding in one line: **no published study measures forward returns for either U2 (60–240 min after migration) or U1
(canonical PumpSwap pools aged 24 h–14 d with ≥ $50k liquidity).** Every memecoin paper I found labels outcomes at or before
1 h after migration, or labels graduation itself. For U1/U2 we have to use evidence from nearby settings (small illiquid
coins, pump-and-dump episodes, DEX wash trading) and our own backtest.

## 1. Evidence table

Grades: A = peer-reviewed or reproducible with public data and code, on Solana/pump.fun 2025–2026; B = reputable on-chain
study or preprint with a clear method, or A-quality but older or another chain; C = blog/dashboard with partial method;
D = anecdote/marketing/unverifiable. "Opened" = I read the primary page (abstract, HTML or PDF) myself.

| # | Claim | Predictor | Direction & size | Population / period | Source | Grade |
|---|---|---|---|---|---|---|
| 1 | No post-1 h outcome is studied in the main pump.fun dataset | n/a (gap) | MELT labels risk on min price in the **first 20 min** after migration (high risk = min ratio < 0.3); features use only the first hour; no 6 h/24 h/7 d returns reported | 41,470 migrated pump.fun coins, 2024-12-01 to 2025-03-01 | [MELT v2, arXiv 2602.13480](https://arxiv.org/html/2602.13480v2) (opened) | A (old regime, pre-PumpSwap BOOST) |
| 2 | Concentration at migration marks dumps (confirms repo) | first-10/20 buyer share; bundle-adjusted concentration; launch duration; buyer count | High-risk coins: first 10 / 20 buyers hold **17 / 19 pp more**; bundle tracing raises measured concentration by **24 pp** (high risk) vs **6 pp** (low risk); shorter launch, fewer buyers, bigger average buys | same as #1 | [MELT v2](https://arxiv.org/html/2602.13480v2) (opened) | A |
| 3 | Pump-and-dump episodes reverse fast and almost fully | price/volume spike, pre-pump run-up | Reversal starts ~**70 s** after the pump; after **1 h most of the effect is gone**; run-ups before the pump suggest insider buying | Telegram-coordinated pumps on CEX coins, 2018 | [Li, Shin, Wang, JFQA (published)](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/abs/cryptocurrency-pumpanddump-schemes/97149DCD519BAF838F269F98DC76D682) (only search summary and listing seen; numbers not checked in text) | B (other venue, older) |
| 4 | Small, illiquid coins reverse week to week; large liquid coins trend | past 1-week return; distance from 1-week high; volume | Weekly reversal only in small/illiquid coins (**t = −7.31**); momentum in large/liquid (t = 2.33). Distance from 1-week high predicts returns **negatively for small/illiquid (t = −9.03)**, positively for large (t = 4.93). Reversal driven mainly by low volume | CEX-listed coins (sample size and period not stated in the abstract) | [Fičura 2023, FFA Working Paper 5:003](https://ideas.repec.org/p/prg/jnlwps/v5y2023id5.003.html) (abstract opened; sign convention of "distance" not checked in the full text) | B |
| 5 | Momentum lives in liquid coins; illiquid coins mean-revert | 14-day-ish past return × liquidity | Strong momentum in the most liquid coins; illiquid coins show reversal; long-only "illiquid losers + liquid winners" beat cap-weighted | CEX coins, to 2019 | [Begušić & Kostanjčar, arXiv 1904.00890](https://arxiv.org/abs/1904.00890) (abstract opened) | B (older, preprint) |
| 6 | Market, size and momentum explain crypto cross-section | size, momentum | Three factors price nine long-short strategies | CEX coins, 2014–2018 | [Liu, Tsyvinski, Wu, J. Finance 77(2) 2022](https://www.nber.org/papers/w25882) (abstract opened) | B (peer-reviewed, older, not DEX) |
| 7 | Most suspected pump-and-dumps die on day 0 | time since pool start; LP removal | Of 2,063,519 tokens launched in 2024, 873,957 (42.5%) on a DEX, **74,037 (3.59%) suspected P&D**; ~**94%** of those pools rugged by the pool creator; duration **median 0 days**, mean 6.23 days, 1% > 123 days. Criteria: creator removed ≥ 65% of pool liquidity (≥ $1k), pool inactive, > 100 txs before | all chains, 2024; no Solana split | [Chainalysis 2025 market-manipulation post](https://www.chainalysis.com/blog/crypto-market-manipulation-wash-trading-pump-and-dump-2025/) (opened) | B |
| 8 | Wash trading is common on DEXes and detectable from trades alone | self-trades, two-account round trips | ~**$159M** wash volume; **> 30%** of traded tokens hit; ~10% of EtherDelta tokens mostly wash traded | IDEX, EtherDelta (Ethereum), to 2020 | [Victor & Weintraud, WWW '21, arXiv 2102.07001](https://arxiv.org/abs/2102.07001) (opened) | B (peer-reviewed, other chain) |
| 9 | About half of new DEX tokens are scams | token/pool behaviour | ~10,000 scam tokens ≈ half of Uniswap listings; ≥ $16M taken from 39,762 victims | Uniswap V2, 2020–2021 | [Xia et al., arXiv 2109.00229](https://arxiv.org/abs/2109.00229) (abstract opened; peer-reviewed venue not confirmed on the page) | B |
| 10 | Wash-trading upper bound on DEXes 2024 | address heuristics | $704M (heuristic 1) to $2.57B combined upper bound | EVM + others, 2024 | [Chainalysis](https://www.chainalysis.com/blog/crypto-market-manipulation-wash-trading-pump-and-dump-2025/) (opened) | B |
| 11 | Persistent wallet "informativeness" exists on a public-ledger venue | wallet's past post-trade markouts | Rank correlation **0.52** across 10-day windows; adding top wallets lifts 1-second return R² by 13.2% (t = 9.2) | 147,113 wallets, $84.3B taker notional; venue not named in abstract (order-book DEX) | [Zhai, arXiv 2608.04373](https://arxiv.org/abs/2608.04373) (abstract opened) | B (other venue; horizon is seconds) |
| 12 | A paper-traded Solana memecoin bot's edge is fragile | hour of day; filter stack | 190 trades, mean +0.62%/trade, but **removing the top 3 trades (1.6%) makes it unprofitable**; worst-hour effect −11.6% vs +1.8%, **p = 0.56** (not significant). Of rejected tokens followed ≥ 6 h, **56.25%** hit a 50% drawdown | Solana DEX, 2026-03-29 to 04-12, paper fills vs aggregator quotes | [Kamat, arXiv 2606.08232](https://arxiv.org/abs/2606.08232) (PDF read in part; data on Zenodo 10.5281/zenodo.20043301) | C (single author, small n, paper fills) |
| 13 | Filter rules for rejecting DEX tokens: claimed net positive, but one tier failed validation | liquidity, age, holder-concentration filters | Save-to-miss ratio 3.7:1 by measured drawdown; "early-death" tier reached "gone" at **48.9% vs 57.6%** for other rejects (that is, no better than the rest) | Solana DEX, 2026-04-10 to 04-23, 2,402 rejection events | [Kamat, arXiv 2607.02830](https://arxiv.org/abs/2607.02830) (abstract opened) | C |
| 14 | pump.fun lifespans are short, but the measure misses PumpSwap | days to last curve trade | 68.67% die the same day; 80.37% within 0–1 day; 4.55% trade 90+ days. Graduates are **understated** (post-graduation trades not counted) | 18.67M pump.fun tokens, 2024-01-14 to 2026-06-18, Dune | [CoinGecko Research](https://www.coingecko.com/research/publications/average-lifespan-of-pumpfun-tokens) (opened) | C |
| 15 | Launch regime moves graduation rates 8× within weeks | platform incentive change (BOOST) | Graduation ~0.8% (June 2026 average), 2.5% the week before BOOST, 4.7% four-day average after, **6.7%** peak day | pump.fun, June–July 2026 | [The Block, 2026-07-29](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives) (opened) | C |
| 16 | Labelled snapshot data with forward **max** returns at 1 h/6 h/24 h/3 d exists | ~80 features incl. momentum trajectory, holder structure, LP burn | Author reports the momentum-trajectory group gave the largest gain, **ΔAUC +0.0095** (tiny) | ~44k snapshots of fresh pump.fun graduates and GMGN-trending tokens, 2026-06-10 to 06-30 | [ian05012/solana-memecoin-dataset (GitHub)](https://github.com/ian05012/solana-memecoin-dataset) (README opened) | C (labels are max return, not realisable; GMGN-selected) |
| 17 | Concentration and volatility mark fragile large memecoins | top-100 holder share, HHI, volatility | Top-100 wallets hold ~98% (TRUMP, LIBRA); framework flags > 80% holder share plus volatility spikes; no out-of-sample return test | large-cap memecoins, 2023–2025 | [Xiang et al., arXiv 2512.00377](https://arxiv.org/html/2512.00377v2) (opened) | B (descriptive, other population) |
| 18 | Large memecoins as a group lost ~79% in 2025–26 and track BTC | market regime | Equal-weight top-10 memecoins −78.74% (Jan 2025–Feb 2026), correlation with BTC 0.78 | top-10 memecoins | [Krause, SSRN 6292920](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6292920) (SSRN returned 403; numbers from a search snippet only) | D until opened |
| 19 | Rug detection on Ethereum with behaviour + contract features | contract, tx anomalies, liquidity moves | MLP accuracy 0.927, F1 0.787, AUC 0.952 | Ethereum; dataset size not given in abstract | [Song, Wang, Li, arXiv 2608.01609](https://arxiv.org/abs/2608.01609) (abstract opened) | C for us (other chain; no PumpSwap relevance beyond feature ideas) |

## 2. Candidate as-of features suggested by the evidence

"Trades-only" = computable from on-chain trade events (slot, user, SOL/token amounts, reserves, fees) plus mint creation
data, with no off-chain feed. Every feature must be computed from events at or before the decision slot.

### U2: graduates aged 60–240 min after migration
1. **Size of the run-up and the drop since migration** (peak-to-now drawdown, return since migration, return over the last
   15–30 min). Evidence points to reversal, not momentum, in this kind of token: pumps fade within the hour (#3, B), small
   illiquid coins reverse and a big gap from the recent high predicts more downside (#4, B). Repo study: price above
   migration at +5 min → median −97% at 1 h. Trades-only: **yes**.
2. **Holder concentration at migration, adjusted for bundles** (share held by the first 10/20 buyers; same-transaction
   multi-buyer bundles). Strongest source: MELT (#2, A). Trades-only: **yes** (bundles = several buyer accounts in one
   transaction or slot; creator from mint creation).
3. **Launch tempo**: curve duration, buyer count and average buy size up to migration (#2, A; Marino, already in the repo).
   Trades-only: **yes**.
4. **Insider exit so far**: share of the early-buyer and creator-cluster supply already sold by the decision time. Inferred
   from MELT's mechanism (early buyers sell into the pool after migration) (#2, A). Measured directly: none. Trades-only:
   **yes**, if the cluster comes from same-slot/same-transaction buys; funder links need transfer data, so **no** for those.
5. **Wash/round-trip share of recent volume** (same wallet buys and sells within N slots; two-wallet loops). #8 (B) and
   Szwajcok (repo). Trades-only: **yes**.
6. **Remaining pool depth** (SOL reserve now, compared with the reserve at migration). #7, #14 and repo figures show
   liquidity collapses within the first day. Trades-only: **yes** (reserves).
7. **Regime**: graduations per hour and launches per hour, SOL trend. #15 shows the rate moves 8× after a platform change.
   Trades-only: launch and graduation counts **yes** (from mint creation and migrate events); SOL trend needs a price
   feed or the SOL/USDC pool, **yes** if we index that pool too.

### U1: canonical PumpSwap SOL pools aged 24 h–14 d with liquidity ≥ $50k
1. **Gap from the 1-week (or since-launch) high and the 1-week return**: in small illiquid coins a deep gap predicts more
   downside and weekly returns reverse (#4, B; #5, B). Trades-only: **yes**.
2. **Volume relative to depth (turnover) and its trend**: per #4, reversal in small coins is driven by low volume.
   Trades-only: **yes**.
3. **Net flow from independent wallets**: net SOL bought by wallets that are not in creator/bundle/sniper clusters and are
   not round-tripping. Direct evidence for forward returns: none; only the wallet-persistence result (#11, B, seconds
   horizon) and the copy-trading decay already in the repo. Trades-only: **yes** for trade-based clusters.
4. **Distinct buyer growth after removing wash and sniper cohorts** (new unique buyers per hour). Repo (Kamat 2607.02795):
   raw buyer counts are inflated +16.1% by sniper rings. Trades-only: **yes**.
5. **Holder concentration of the current float** (top-10 share excluding the pool account). #17 (B, large coins), #2 (A, at
   migration). Trades-only: **partly**. Balances can be rebuilt from trades only if every transfer is also tracked;
   transfers are not trade events, so **no** for an exact figure.
6. **Pool age and survival so far**: Chainalysis' median P&D life is 0 days (#7, B), so a pool still deep at 24 h has
   already passed the main rug window. That says nothing about its forward return. Trades-only: **yes**.
7. **Regime** (as for U2) plus SOL trend; large memecoins track BTC (#18, D until opened). Trades-only: **yes** with a
   SOL/USDC pool indexed.

## 3. Contradictions and gaps

- **Gap (largest):** no study reports forward returns at 1–4 h after migration or for 1–14-day-old PumpSwap pools.
  MELT, Li et al. and Chen et al. all stop at ≤ 1 h or at a rug label. U1 and U2 have to be tested on our own blind backtest.
- **Momentum vs reversal:** crypto factor papers (#6, #5) find momentum, but only in large and liquid coins. A $50k pool is
  tiny by those standards, so the evidence that applies (#4, #5) predicts **reversal**. This agrees with the repo's own
  result (+5 min strength → worse 1 h outcome). Treat "buy strength" rules as unsupported for both U1 and U2.
- **Wash trading and success:** Szwajcok (repo) finds wash-traded coins graduate more often (2.0% vs 0.90%); Marino (repo)
  finds bot activity lowers graduation odds. These measure different things (wash loops vs any bot), so they are not a
  direct contradiction. Neither measures returns after migration.
- **Base rates move:** graduation went from 0.63% (Sep 2025, Marino) to 0.198% (May–Jun 2026, Kamat, a lower bound) to a
  4.7–6.7% peak after BOOST (Jul 2026, #15). Confirms the repo rule that a platform change is a regime break. Any U2 model
  trained on pre-BOOST graduates is out of date.
- **Predictors decay:** Kamat's 0.859 → 0.464 AUROC collapse (repo) is consistent with the fragile edge in #12 (the result
  flips when 3 trades are dropped) and the failed filter tier in #13. No source shows a stable as-of edge after costs.
- **LP pulls:** Chainalysis and Solidus rug definitions centre on the creator pulling liquidity. On canonical PumpSwap pools
  the migration liquidity is not held by the creator (see `docs/research/venues.md`), so the rug path is dumping supply into
  the pool, not removing LP. Rug base rates from LP-pull studies (#7, SolRPDS, Solidus) therefore **do not transfer**
  one-to-one to U1/U2.
- **Labels that cannot be traded:** the GitHub dataset (#16) uses forward **max** return, which overstates what any exit
  rule can capture. Do not reuse its labels.

## 4. Could not verify

- "15,548 graduates; 43.8% still had $5k liquidity at 30 min, 19.7% at 24 h; median liquidity $8,448 at +5 min →
  $2,888 at +24 h": appeared in a search-engine summary with no traceable source. The Kamat Zenodo record it seemed to
  point to (RED-PUMP-2026-v1) says it has **no** post-migration liquidity data. **Unverified. Do not cite.**
- Galaxy Research memecoin report (median Solana memecoin hold time ~100 s, down from ~300 s; 13M of 32M Solana tokens from
  pump.fun): seen only in news summaries; the Cointelegraph page returned 410 and I found no primary Galaxy page.
- Krause, SSRN 6292920 (#18): SSRN returned 403; numbers come from a search snippet only.
- Li, Shin, Wang JFQA (#3): the 70 s / 1 h figures come from a search summary of the published paper; I did not open the PDF.
- Gerzon et al., "Quantifying the Threat of Sandwiching MEV on Jito" (IMC 2025) and the Helius Solana MEV report: found
  but not opened. They are about execution cost, not predictors.
- Nansen, Flipside, Kaiko, Blockworks Research: no public study of post-graduation returns found (Blockworks metrics are
  paywalled).
- Xia et al. (#9): I did not confirm the peer-reviewed venue from the arXiv page.
