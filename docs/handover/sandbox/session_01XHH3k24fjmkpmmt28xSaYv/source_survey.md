# Source survey, pump.fun + PumpSwap history (tested 2026-10-03, ~13:20 UTC)
Programs: pump.fun 6EF8rrec...wF6P, PumpSwap pAMMBay6...EfEA. No accounts, keys or sign-ups used. Current slot at test: 452,944,793 (epoch 1048).
NOTE: effective slot time is ~0.3 s, not 0.4 s. 30 days is about 8.6M slots, not 6.48M (slot 446,464,793 was 2026-09-12, only 21 days back).

## 1. Public Solana RPC (no account)
- api.mainnet-beta.solana.com. getSlot, getSignaturesForAddress(6EF8..., limit 1000, 4 pages via before), getBlock, getTransaction (maxSupportedTransactionVersion 1), getFirstAvailableBlock.
- Headers (free tier): x-ratelimit-method-limit 150 (getSlot) but 10 on getSignaturesForAddress/getTransaction and 6 on getBlock; rps-limit 250; conn-limit 40; connrate 40; endpoint-limit unlimited.
- getFirstAvailableBlock = 0. getBlock worked at slots 439,984,793 (2026-08-18), 437,975,993 (08-08), 423,007,193 (2026-05-29), 392,237,993 (2026-01-09). History at least 9 months, probably full (Bigtable-backed).
- getTransaction worked for sigs at 2026-09-12 (2xujT76G...) and 2026-08-18 (5rsad8wP...): full tx with logMessages (9 and 33) and innerInstructions (the 08-18 one has 1), so Anchor events (Program data logs) are available.
- Completeness: yes, every tx, but getSignaturesForAddress on pump.fun returns 1000 sigs per ~9 slots (~3 s of activity, includes failed txs). Paging back 30 days = millions of calls: infeasible. Only practical use: getBlock per slot (about 1,100 txs/block incl. votes excluded? sample showed 1081-1104 sigs) at 6 req/10s limit = far too slow for bulk. Good for spot verification only.
- Cost: free. Terms: public endpoints are rate limited and "not for production" per https://solana.com/docs/references/clusters (not fetched/verified here). Account needed: no.
- publicnode https://solana-rpc.publicnode.com: getFirstAvailableBlock = 452,650,914 (about 1 day: slot 452,651,140 = 2026-10-02T15:xx UTC via getBlockTime 1790955026). getBlock 439,984,793 -> error -32001 "cleaned up". Useless for history.

## 2. GeckoTerminal API v2 (no key; ~12 requests, 4.5 s spacing, no 429, no x-ratelimit headers returned)
- /networks/solana/dexes page 1: both `pumpswap` and `pump-fun` ids exist (page 2 = 400).
- Pool tested: PumpSwap 6bwtyB2RqdfHnDedrnRZvW4xrLsWQZe2XM2U2qB4iw1z (GOIF/SOL, created 2026-10-01).
- ohlcv/minute?limit=1000: 1000 one-minute candles (only minutes with trades). /trades: max 300 trades, covering ~last 1 hour for a busy pool (10:03 to 10:49 UTC); per-trade tx_hash, block_number, amounts, USD price. No paging for trades.
- before_timestamp depth (tested on Raydium SOL/USDC pool 58oQChx4...): 30 d and 90 d back OK for minute candles. 400 d back = HTTP 401: "You can only access data from the past 180 days with Public API ... upgrade to the Analyst plan" (same for hour). So 180 days limit.
- Completeness: candles only (OHLCV, per pool, 1000 per call, so ~17 h of 1-min per call for an active pool); NOT every trade. pump.fun bonding-curve dex listed, but curve-phase candle coverage not tested.
- Cost: free tier; paid beyond 180 days. Terms: https://www.coingecko.com/en/api_terms (fetched): no re-distribution/syndication, caching discouraged (24 h refresh), no storing/deriving Data beyond what is expressly permitted, delete data on termination, "Powered by CoinGecko" attribution. So building a persistent historical dataset from it conflicts with the terms. Free public limit documented as ~30 calls/min (not verified here).
- Account: no for 180 days; Analyst plan needed beyond.

## 3. DexScreener public API (no key)
- /latest/dex/pairs/solana/{pool}: 200, snapshot only (txns m5/h1/h6/h24 counts, volume, liquidity, price, pairCreatedAt). /token-pairs/v1/solana/{mint}: 200 snapshot.
- /latest/dex/pairs/.../candles and /latest/dex/trades/...: 404 (do not exist). Docs https://docs.dexscreener.com/api/reference list no candle or trade endpoint. No history. Docs rate limits: 60 rpm (profiles/boosts/metas), 300 rpm for pairs (from memory; page excerpt only showed 60). No x-ratelimit headers seen.
- Terms: https://dexscreener.com/terms-and-privacy returned 403 to the fetcher; not verified. Account: no.

## 4. Jupiter (lite-api.jup.ag, keyless)
- /price/v3?ids=SOL: 200 current price only. /swap/v1/quote: 200 live quote. /price/v3/history: returned same current-price payload (ignores path; no history endpoint). No history on any tested endpoint.
- Docs https://developers.jup.ag/docs/api-setup: keyless api.jup.ag 0.5 RPS; free key 1 rps (needs account). lite-api limits not documented there. No terms link found. Not useful for history.

## 5. Google BigQuery public Solana dataset
- Docs https://docs.cloud.google.com/blockchain-analytics/docs/supported-datasets list "Solana Blockchain" as community-maintained, but the page gives no tables, freshness or inner-instruction detail. I could NOT verify tables/freshness/logs from this machine.
- `bq show bigquery-public-data:crypto_solana_mainnet_us` -> "Authorization error" (needs Google Cloud credentials + project). Querying always needs a Google Cloud project (account, billing for >1 TB/month free tier). From memory (unverified): dataset has blocks, transactions (with logs), instructions (incl. inner), token_transfers, accounts; freshness varies.

## 6. Open datasets (APIs, no key). Candidates, newest and most relevant first
| Dataset | Covers | Granularity | Licence | Size | Sept 2026? |
|---|---|---|---|---|---|
| HF cryptodata/pumpfun-dataset-light | pump.fun curve only, 2026-07-20..08-02 | every TradeEvent (41.0M swaps, 432,846 mints), 46 cols, reserves, fees, quality flags; "complete capture not independently established" | CC-BY-4.0 | 9.97 GB, 14 daily parquet | no |
| Zenodo 22306254 | pump.fun curve, 2026-04-28..05-29 | 20.7M trades + features, SQLite | CC-BY-4.0 | 23.97 GB | no |
| HF DataStore/pumpswap-amm-historical-data-sample | PumpSwap, 72 slots on 2026-06-10 | 6,000 rows decoded (instruction+event+reserves) | CC-BY-SA-4.0 | tiny sample (full set sold at datastore.sh) | no |
| Zenodo 22708412 PumpSwap Historic Data | same sample | same | CC-BY-4.0 | 14 MB | no |
| HF biznus1/pumpswap-historical-trades | PumpSwap, 120 days over 5 periods (Aug 2025, Jan 2026 ...), 245.9M trades | per swap, parquet | license other, PAID via Gumroad; free sample 1 h on 2025-08-13 | n/a | no |
| HF loopholetape/pumpfun-launches | launches + outcomes 2026-08-31..09-26 (859,208 launches) | per launch, NOT trades; legacy rows miss ~48% of buys | CC-BY-4.0 | 114 MB | partly (Sep 1-26), launch-level only |
| HF Slinky21/Pumpfun_v2_dataset | pump.fun create/trade/swap/graduate/txmeta, Aug 10..Sep 18 2026 (488 files) | event files from a live collector, completeness unknown | none stated | ~240 MB (swap 185 MB) | partly (to 09-18); licence missing = do not rely |
| HF Tr4m0ryp/trenches-pumpfun-forward-2026-08 | 2026-08-06..08-13, 75 s polls | observation snapshots, not trades | PolyForm Noncommercial | small | no |
| Zenodo 23018519 RED-PUMP-2026-v1 | 860,213 launches May-Jun 2026 | labels | CC-BY-4.0 | 348 MB | no |
| Zenodo 22967373 RED-REJECT-2026-v2 | 2026-04-11..07-16 | filter rejections + samples | CC-BY-4.0 | 144 MB | no |
| MELT (github.com/git-disl/MELT; arXiv 2601.22185 per search) | 41k+ launches, 200M+ txs, pre-migration curve + post-migration Raydium (not PumpSwap) | tx-level records, 122 features | CC BY-NC 4.0 (non-commercial) | >1 TB raw; parsed zips on Google Drive | time range not stated in README; no Sept 2026 |
| SolRPDS (HF DeFiLab/SolRPDS, arXiv 2504.07132) | rug pulls 2021 .. Nov 2024 | per-pool labels | CC-BY-4.0 | small CSV/JSON | no |
| MemeChain (Zenodo 18246856), Midsummer Meme's Dream (17830944) | ~35k tokens, 4 chains, 3-month snapshot to late 2025 | token-level | CC-BY-4.0 | 709 MB / 26 MB | no |
- Searches run: HF pump.fun/pumpfun/pumpswap/solana/SolRPDS; Zenodo pump.fun, solana meme, pumpswap, solana rug pull, SolRPDS (0 hits), MELT (no relevant hit). MELT found only via web search, its time range NOT verified.
- Nothing found covers PumpSwap trades for September 2026. Only partly-useful: cryptodata (curve, to 2026-08-02) and Slinky21 (to 09-18, unlicensed, unverified completeness).

## 7. Old Faithful (Triton), https://files.old-faithful.net
- HEAD https://files.old-faithful.net/{E}/epoch-{E}.car: 200 for 1030 (789.3 GB), 1036 (984.3 GB), 1040 (721.8 GB), 1044 (843.8 GB), 1046 (744.9 GB), 1047 (867.8 GB). 1048: 404 (epoch still running, started 2026-10-02 ~21:49 UTC... slot 1048*432000+5 had blocktime 2026-10-02T21:49:59Z). Epochs 1030-1047 not individually probed except those listed (1031-35, 1037-39, 1041-43, 1045 untested).
- Epoch dates (getBlockTime of first slots): 1030 = 2026-09-07 03:12 UTC; 1036 = 09-16 15:03; 1040 = 09-22 05:09; 1048 = 10-02 21:49. About 1.4 days per epoch, ~0.7-1 TB each (whole archive range = about 15 TB for 30 days: heavy).
- Docs: https://docs.old-faithful.net : "Triton provides a full copy of this ledger at https://files.old-faithful.net that you can download", stored in Amsterdam. No pricing, terms or usage limits stated on the page. Repo https://github.com/rpcpool/yellowstone-faithful README: project in RFC stage, also via Filecoin. Repo licence not verified (GitHub API blocked here). No account needed. Terms of the file host: not found (unverified).
- Practical: 30 days = ~21 epochs = ~17 TB download plus a CAR parser (faithful-cli / Jetstream). Ranged HTTP reads of single blocks may be possible with faithful-cli (not tested).

## Needs an account (owner would have to create)
- Google Cloud project for BigQuery (not usable here).
- GeckoTerminal/CoinGecko Analyst plan for > 180 days.
- Jupiter api key (free tier, 1 rps) , Helius/Triton/other RPC or Yellowstone gRPC (not tested).
- datastore.sh and Gumroad (paid full PumpSwap sets).

## Could not verify
BigQuery table list/freshness/logs; DexScreener ToS (403); GeckoTerminal exact rate-limit numbers (no headers); Solana public RPC ToS page; Old Faithful host terms and repo licence; MELT date range; completeness of any third-party dump.
