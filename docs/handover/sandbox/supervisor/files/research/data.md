# Real-time data feeds and latency stack

Research date: 2026-10-03. Scope: Solana data feeds for a $20, one-position, paper-first meme-token bot. Every fact links to a source. Where a page shows no date, the date given is the access date (2026-10-03). "Vendor claim" marks a number published by a company about its own product. "Measured" marks a number from my own short tests (method and limits in section 7). "Unverified" means I could not confirm it.

SOL price used for dollar conversions: **$119.36** (Jupiter Price V3, `api.jup.ag/price/v3`, fetched 2026-10-03 11:1x UTC).

---

## 0. Summary for the builder

1. **The brief's two quota claims are correct**: Helius Free is 1M credits a month at 10 RPC requests per second, and a free Jupiter key gets 1 RPS in the main bucket plus a separate 50 RPS bucket for `/execute`. The brief leaves out the limits that actually shape the design:
   - **Helius WebSockets now use up credits, at 2 credits per 0.1 MB.** The free 1M credits therefore cover only **about 50 GB of streamed data a month**.
   - Helius Free allows **5 WebSocket connections**, only **1 sendTransaction per second**, and **no `transactionSubscribe`** (that needs the $49 Developer plan or higher).
   - Jupiter's 1 RPS main bucket is shared by **`/order` quotes, Tokens and Price**. Polling for discovery takes away the quote budget that exits need.
2. **The pump.fun data stream is too large for a free plan.** I measured it at **184 transactions a second, or 49.1 MB in 3 minutes**. On Helius metering that is about **14M credits a month**, 14 times the free allowance. Discovery has to come from **PumpPortal's free `subscribeNewToken` and `subscribeMigration`**, plus Jupiter `/tokens/v2/recent`. Pulling every pump.fun log line through a metered RPC is not an option.
3. **PumpPortal's free feed is as fast as a standard RPC WebSocket, but it misses some tokens.** I compared the same signatures arriving on PumpPortal and on public-RPC `logsSubscribe` at `processed` (n=127). PumpPortal arrived **24 ms earlier at the median**; at p10 it was 160 ms earlier and at p90 140 ms later. However, **PumpPortal missed 13.6% of the successful creates** that the RPC saw, and the RPC missed 5.2% of PumpPortal's events. **Use two independent discovery feeds and remove duplicates by signature.**
4. **PumpPortal trade streams are no longer free.** They cost 0.01 SOL per 10,000 events and need an API key plus a linked wallet holding at least 0.02 SOL. At the rate I measured on 17 brand-new tokens (21 trades a second), that comes to about **1.8 SOL (~$217) a day**. This is not usable with a $20 bankroll.
5. **For the shortlist, watch account state, not every trade.** I subscribed with `accountSubscribe` to 20 new bonding-curve accounts. It cost about **70k Helius credits a month**. `logsSubscribe` on 17 new mints cost about **2.0M credits a month**, roughly 30 times more. Get trade-level detail only for the top 1 to 3 candidates and the open position.
6. **Discovery that only needs to be a few seconds fresh is fine for this strategy.** The brief rules out first-block sniping, and same-block snipes are dominated by wallets the deployer funded. Measured lags: Jupiter `/recent` p50 4.9 s, GeckoTerminal p50 67 s, and DexScreener serves cached data up to 60 s old. **Latency matters most for monitoring and exiting the open position.** Spend the first dollars there.
7. **Recommended free stack:**
   - Helius Free: RPC, Sender, priority fees, and the position WebSocket.
   - Alchemy Free: a second WebSocket provider. It has the most free bandwidth (0.0002 CU per byte, so 30M CU is about 150 GB), it is a separate failure domain, and it covers the shortlist.
   - PumpPortal free creates and migrations.
   - Jupiter free key: quotes, execution, and `/recent`.
   - Helius Parsed Streams for graduations (1 credit per event, `confirmed`).
   - DexScreener and GeckoTerminal for context only.
8. **First paid upgrade: Helius Developer at $49 a month.** It adds:
   - `transactionSubscribe` at `processed`, with up to 50,000 addresses in one filter;
   - 10M credits (about 500 GB of WebSocket data);
   - 150 WebSocket connections and 5 sendTransaction calls a second;
   - `preprocessedSubscribe` (beta, 0.1 credit per message), which shows a transaction before it executes. Watched on the open position's pool, it gives early warning of large sells or liquidity pulls.

   **Second upgrade, only if measured slippage shows that milliseconds matter: gRPC.** Options are Alchemy at $75/TB pay-as-you-go with no minimum (but no dollar hard cap), Chainstack at $98 a month flat, Shyft at $199 unmetered, or Helius LaserStream at $499.
9. **Landing cost trap:** Helius Sender Max requires a **0.001 SOL tip (~$0.12)**, which is about 6% of a $2 trade on each side. Sender's SWQOS-only mode needs **0.000005 SOL (~$0.0006)**. Default to SWQOS-only or Jupiter `/execute`, and escalate only up to a set fee ceiling.

---

## 1. Helius (primary RPC candidate)

### 1.1 Plans (pricing page and docs, accessed 2026-10-03)

| Plan | $/mo | Credits/mo | RPC RPS | DAS & Enhanced RPS | sendTransaction/s | getProgramAccounts/s | WS concurrent connections | Helius WS extensions (`transactionSubscribe`, enhanced `accountSubscribe`) | LaserStream gRPC |
|---|---|---|---|---|---|---|---|---|---|
| Free | 0 | 1M | 10 | 2 | 1 | 5 | 5 | No | Devnet only |
| Developer | 49 | 10M | 50 | 10 | 5 | 25 | 150 | Yes | Devnet only |
| Business | 499 | 100M | 200 | 50 | 50 | 50 | 250 | Yes | Mainnet + devnet |
| Professional | 999 | 200M | 500 | 100 | 100 | 75 | 1,000 | Yes | Mainnet + devnet |

- Sources: [Helius plans](https://www.helius.dev/docs/billing/plans), [Helius pricing](https://www.helius.dev/pricing), [Helius rate limits](https://www.helius.dev/docs/billing/rate-limits).
- Every plan allows **1,000 subscriptions per WebSocket connection** ([rate limits](https://www.helius.dev/docs/billing/rate-limits)).
- Extra credits cost **$5 per million** on Developer and above. sendBundle runs at 5/s on Business and above ([pricing](https://www.helius.dev/pricing)).
- Webhooks: 5 on Free, 50 on paid plans ([rate limits](https://www.helius.dev/docs/billing/rate-limits)).
- **Helius Sender** is limited to 50 TPS on every plan and uses 0 credits ([rate limits](https://www.helius.dev/docs/billing/rate-limits), [Sender](https://www.helius.dev/docs/sending-transactions/sender)).

### 1.2 Credit costs ([credits page](https://www.helius.dev/docs/billing/credits))

| Item | Credits |
|---|---|
| Standard RPC call, including `getTransaction`, `getSignaturesForAddress` and `getPriorityFeeEstimate` | 1 |
| `getProgramAccounts` (the paginated v2 call costs 1) | 10 |
| DAS (for example `getAsset`) | 10 |
| Enhanced Transactions API (legacy, in maintenance mode) | 100 |
| Webhook event | 1 |
| **WebSocket (standard and extensions)** | **2 per 0.1 MB uncompressed, plus 1 per connection opened** |
| LaserStream gRPC | 2 per 0.1 MB |
| Sender, `sendTransaction` via staked connections | 0 and 1 respectively |
| Parsed Events REST (successor to Enhanced Transactions) | 10 per request ([llms.txt](https://www.helius.dev/docs/llms.txt)) |
| Parsed Streams | 1 per delivered event ([Parsed Streams](https://www.helius.dev/docs/parsed-streams.md)) |
| `preprocessedSubscribe` (paid plans only) | 0.1 per message ([preprocessedSubscribe](https://www.helius.dev/docs/preprocessed-transactions/preprocessed-subscribe.md)) |

What this means in practice: at 20 credits per MB, the **free 1M credits cover about 50 GB a month of WebSocket data**, if nothing else uses credits. Developer's 10M covers about 500 GB. Overage works out to roughly $0.10 per GB.

### 1.3 WebSockets: "Enhanced WebSockets" has been renamed "LaserStream WebSocket"

Sources: [WebSocket docs](https://www.helius.dev/docs/rpc/websocket) and [transactionSubscribe](https://www.helius.dev/docs/enhanced-websockets/transaction-subscribe).

- Endpoints:
  - `wss://mainnet.helius-rpc.com/?api-key=…`
  - Gatekeeper beta: `wss://beta.helius-rpc.com/?api-key=…`
- The standard methods (`accountSubscribe`, `logsSubscribe`, `programSubscribe`, `signatureSubscribe`, `slotSubscribe`) work on **all plans**.
- **`transactionSubscribe` and enhanced `accountSubscribe` need Developer or higher.**
- The service runs on the same backend as LaserStream gRPC. Vendor claim: "**up to 200 ms faster** than standard Agave RPC-based WebSockets."
- Connections close after **10 minutes without activity**. Send a ping at least once a minute.
- `transactionSubscribe` filters: `accountInclude`, `accountExclude` and `accountRequired` (**up to 50,000 addresses each**), plus `vote`, `failed` and `signature`.
- Other `transactionSubscribe` options:
  - commitment: `processed`, `confirmed` or `finalized`;
  - encoding: `base58`, `base64` or `jsonParsed`;
  - `transactionDetails`: `full`, `signatures`, `accounts` or `none`;
  - `maxSupportedTransactionVersion: 1`.
- Standard `logsSubscribe` accepts **exactly one address** in `mentions` ([Solana docs](https://solana.com/docs/rpc/websocket/logssubscribe)). Watching 20 tokens therefore takes 20 subscriptions, which fits within the 1,000-per-connection limit.

### 1.4 New Helius feeds relevant to this bot

**Gatekeeper (beta)**
- What it is: an edge gateway that takes Cloudflare out of the request path. Switch by changing the URL to `beta.helius-rpc.com`. Same key, same methods, same pricing. Mainnet only. It does not carry LaserStream gRPC.
- Vendor claim: "response-time improvements range from tens to hundreds of milliseconds".
- Source: [llms.txt](https://www.helius.dev/docs/llms.txt).

**Parsed Streams (GA on all plans, including Free)**
- What it is: a WebSocket that streams **decoded** transactions. The server filters them by `programs`, `instructionNames`, `accounts.include` or `accounts.roles`.
- Delivered at **`confirmed` only**.
- Costs **1 credit per event**. Billing starts 2026-09-24, or 2026-10-01 for projects that used it earlier.
- Limits: 5 connections on Free, 10 on Developer, 50 on Business and above; 25 subscriptions per connection; 10 messages a second. If 2,048 notifications pile up in the outbound buffer, the connection is closed.
- Pump.fun and PumpSwap are both in its catalog of decoded programs.
- Sources: [Parsed Streams](https://www.helius.dev/docs/parsed-streams.md), [quickstart](https://www.helius.dev/docs/parsed-streams/quickstart.md).
- **Use:** watching graduations (the pump program's `migrate` instruction). At a few hundred events a day this costs far less than 1M credits a month. **Do not use** it for trade streams, where 1 credit per trade is much too expensive (section 7.3).

**preprocessedSubscribe (public beta, paid plans)**
- What it is: transactions **before they execute**, taken mainly from decoded shreds. Vendor claim: "~8 ms ahead of `processed`".
- Filters: `accountInclude`, `accountRequired` and `accountExclude`. Address lookup tables are resolved on the server.
- Limits: 10 connections or subscriptions per key; 0.1 credit per message.
- It is "best-effort" and carries no execution result, so a transaction it shows may still fail.
- Sources: [preprocessedSubscribe](https://www.helius.dev/docs/preprocessed-transactions/preprocessed-subscribe.md), [LaserStream overview](https://www.helius.dev/docs/laserstream.md).
- **Use:** early warning on the open position's pool, such as a deployer or large-holder sell or a liquidity removal.

**Preconfirmations (`preconfSubscribe`)**
- Professional plan or higher; 10 credits per message ([llms.txt](https://www.helius.dev/docs/llms.txt)). Not relevant to this budget.

**Shred Delivery**
- Raw shreds over UDP: $1,000 a month per IP, or $800 on the Pro plan ([LaserStream overview](https://www.helius.dev/docs/laserstream.md)). Out of budget.

### 1.5 LaserStream gRPC

Source: [LaserStream](https://www.helius.dev/docs/laserstream.md).

- **Mainnet needs Business ($499 a month) or higher.** Devnet works on every plan. Usage is metered at 2 credits per 0.1 MB.
- Wire-compatible with Yellowstone, so any Yellowstone client works.
- Can **replay up to 48 hours** (~691,200 slots) after a disconnect. The SDK reconnects automatically.
- Regions: ewr, pitt, slc, ams, fra, tyo, sgp ([measuring latency](https://www.helius.dev/docs/laserstream/guides/measuring-latency.md)).
- Helius says LaserStream gRPC at `processed` is the fastest way to receive account and program updates, because account state does not exist in shreds.
- Data add-ons for heavy users: 5 TB for $400, up to 100 TB for $6,000, Professional only ([pricing](https://www.helius.dev/pricing)).

### 1.6 getPriorityFeeEstimate

Source: [Priority fee API](https://www.helius.dev/docs/priority-fee-api).

- Costs 1 credit.
- Input: a serialized transaction (recommended) or `accountKeys`. Options: `priorityLevel`, `includeAllPriorityFeeLevels`, `lookbackSlots`, `recommended`.
- Levels and the percentile each one maps to:

| Level | Percentile |
|---|---|
| Min | lowest observed |
| Low | 25th |
| Medium | 50th (recommended) |
| High | 75th |
| VeryHigh | 95th |
| UnsafeMax | maximum observed |

- Worked example from the docs: ~40,000 micro-lamports per CU × 200k–400k CU = 0.000008–0.000016 SOL.
- Design note: ask for the estimate per transaction, using the exact accounts involved, so it reflects contention on the hot pool. Cap the result with the fee ceilings already in the brief.

### 1.7 Helius Sender

Source: [Sender](https://www.helius.dev/docs/sending-transactions/sender).

- Endpoint: `https://sender.helius-rpc.com/fast`, plus regional HTTP endpoints in SLC, Newark, London, Frankfurt, Amsterdam, Singapore and Tokyo.
- Sends each transaction over several routes at once: Helius, Jito, Harmonic and Rakurai.
- A priority fee (`setComputeUnitPrice`) is required. `skipPreflight` is optional.
- Throughput is 50 TPS by default, and it uses no credits.

| Mode | Minimum tip | Routes | Cost in USD per transaction | Share of a $2 trade per leg |
|---|---|---|---|---|
| Sender Max | **0.001 SOL** | all routes | ~$0.119 | **~6.0%** |
| SWQOS-only (`?swqos_only=true`) | **0.000005 SOL** | one route | ~$0.0006 | ~0.03% |

---

## 2. Execution-side quotas that share the same budget (Jupiter)

### 2.1 Rate limits

Sources: [Jupiter rate limits](https://developers.jup.ag/docs/portal/rate-limits), [Jupiter plans](https://developers.jup.ag/docs/portal/plans.md), [llms.txt](https://developers.jup.ag/docs/llms.txt).

| Tier | $/mo | Main bucket RPS | `/swap/v2/execute` RPS | Included credits |
|---|---|---|---|---|
| Keyless | 0 | 0.5 | 20 | n/a |
| Free (key) | 0 | 1 | 50 | unlimited |
| Developer | 25 | 10 | 100 | 25M |
| Launch | 100 | 50 | 100 | 100M |
| Pro | 500 | 150 | 100 | 500M |

- The window is a **60-second sliding window**, applied **per organisation, not per key**.
- **The main bucket is shared by Swap (`/order`, `/build`), Price and Tokens.** Firewall rules can add further limits on top.
- There is no cooldown after a 429. The headers `x-ratelimit-remaining`, `x-ratelimit-current` and `x-ratelimit-reset` are returned.
- Annual prices: Developer $250, Launch $1,000, Pro $5,000.
- Credit cost per call matters only on paid tiers: `/tokens/v2/search` 10, `/tokens/v2/tag` 50, `/tokens/v2/{category}/{interval}` 5, `/tokens/v2/recent` 1, `/order` 1, `/execute` 0.
- The API gateway runs in AWS regions ap-southeast-1, eu-central-1, us-east-1, sa-east-1, ap-northeast-1 and us-west-2 ([llms.txt](https://developers.jup.ag/docs/llms.txt)).

### 2.2 Tokens V2

Sources: [Tokens index](https://developers.jup.ag/docs/tokens/index), [Token information](https://developers.jup.ag/docs/tokens/token-information.md).

- `GET https://api.jup.ag/tokens/v2/search?query=` accepts up to **100 comma-separated mints**. A name or symbol search returns 20 results by default.
- `GET /tokens/v2/tag?query=verified|lst|stocks`.
- `GET /tokens/v2/{toporganicscore|toptraded|toptrending}/{5m|1h|6h|24h}?limit=` returns 50 by default and leaves out generic top tokens.
- `GET /tokens/v2/recent` returns **30 mints by default**. "Recent" means **the time the token's first pool was created**, not when it was minted.
- Response fields include:
  - `audit.mintAuthorityDisabled`, `audit.freezeAuthorityDisabled`, `audit.topHoldersPercentage` (0–100 scale);
  - `organicScore` (0–100) and `organicScoreLabel`;
  - `firstPool {id, createdAt}`, `holderCount`, `liquidity`, `priceBlockId`;
  - `stats5m`, `stats1h`, `stats6h` and `stats24h`, with `numOrganicBuyers`, `buyOrganicVolume` and related fields.
- Organic score is "relative, not absolute". This **confirms** the brief.

### 2.3 Metis listing rules

Source: [Market listing](https://developers.jup.ag/docs/swap/routing/amm/market-listing.md).

- New markets on eligible DEXes are routed instantly during a grace period. Eligible DEXes include Pump.fun, Pump.fun AMM, Meteora DBC, DAMM v2, DLMM, Raydium, CPMM, CLMM, LaunchLab and Moonshot.
- The grace period is measured from token age (for example, a pool created on day 30 falls outside it).
- After the grace period a market must pass one of two tests, checked every 30 minutes:
  - a $500 round trip loses less than 30%; or
  - the price impact of a $1,000 buy compared with a $500 buy is less than 20%.
- A bonding curve that has not graduated by the end of the grace period is removed from routing.
- Implication: a `NO_ROUTES_FOUND` from `/build` on a token we hold is an exit-risk signal that the data layer must surface.

---

## 3. Third-party discovery and market-data feeds

### 3.1 PumpPortal Data API

Sources: [PumpPortal real-time](https://pumpportal.fun/data-api/real-time), [fees](https://pumpportal.fun/fees). Both accessed 2026-10-03.

- Endpoint: `wss://pumpportal.fun/api/data`. The `?api-key=` parameter is required only for paid streams.

| Method | Price |
|---|---|
| `subscribeNewToken` | free |
| `subscribeMigration` | free |
| `subscribeTokenTrade` | **0.01 SOL per 10,000 events** |
| `subscribeAccountTrade` | **0.01 SOL per 10,000 events** |

- Paid streams need "a PumpPortal API key and linked wallet funded with at least 0.02 SOL".
- Venues covered: Pump.fun, PumpSwap and LetsBonk.fun.
- Rules: "**ONLY USE ONE WEBSOCKET CONNECTION AT A TIME**". Opening many connections can get you timed out. "Bans expire every hour."
- Trading fees, which are not used here: Lightning 1% and Local 0.5%.
- **Brief/task claim "free token trades and account trades": outdated.** Trades are metered.
- Fields seen in a live create event (measured): `signature`, `mint`, `traderPublicKey`, `txType`, `initialBuy`, `solAmount`, `bondingCurveKey`, `vTokensInBondingCurve`, `vSolInBondingCurve`, `marketCapSol`, `name`, `symbol`, `uri`, `is_mayhem_mode`, `pool`.
- Reliability: I found no SLA or status page. Section 7.1 has measured coverage gaps.

### 3.2 DEX Screener

Source: [DEX Screener API reference](https://docs.dexscreener.com/api/reference), accessed 2026-10-03.

| Rate limit | Endpoints |
|---|---|
| **300 rpm** | `/latest/dex/pairs/{chainId}/{pairId}`, `/latest/dex/search`, `/token-pairs/v1/{chainId}/{tokenAddress}` |
| **60 rpm** | `/token-profiles/latest/v1`, `/token-profiles/recent-updates/v1`, `/community-takeovers/latest/v1`, `/ads/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/orders/v1/{chainId}/{tokenAddress}`, `/tokens/v1/{chainId}/{tokenAddresses}`, `/metas/trending/v1`, `/metas/meta/v1/{slug}` |

- There is no public WebSocket.
- Measured: `/latest/dex/search` responses carry `cache-control: public, max-age=60` (the response had `age: 21`). **Data can be up to 60 seconds old.** That suits Home-screen context, not trading signals.

### 3.3 GeckoTerminal (CoinGecko onchain)

- The public API (`api.geckoterminal.com/api/v2`) is limited to **30 calls a minute** ([GeckoTerminal FAQ via search](https://apiguide.geckoterminal.com/faq)). The CoinGecko Demo key allows 100 calls a minute ([CoinGecko rate limits](https://docs.coingecko.com/docs/errors-and-rate-limits.md)).
- CoinGecko onchain WebSocket channels (G1 prices, G2 trades, G3 OHLCV) need the **Basic paid plan or higher** ([data delivery](https://docs.coingecko.com/docs/data-delivery-methods.md)).
- Measured on `/networks/solana/new_pools`: `cache-control: max-age=30, s-maxage=60`. The CDN copy was 50 s old.
- Measured lag: discovery p50 **67 s** behind PumpPortal (section 7.2). 39 of 60 calls failed when polling every 4 s from a shared proxy IP; the cause, probably rate limiting, is unverified.

### 3.4 Birdeye

Sources: [Birdeye pricing](https://data.birdeye.so/docs/guides/payment/pricing.md), [rate limiting](https://data.birdeye.so/docs/guides/api-access/rate-limiting/index.md), [CU cost](https://data.birdeye.so/docs/guides/what-is-compute-unit-cost.md), [package access](https://data.birdeye.so/docs/guides/data-accessibility-by-packages.md) (access table effective 26 Nov 2025).

| Package | $/mo | CU/mo | RPS | Notes |
|---|---|---|---|---|
| Standard (free) | 0 | 30,000 | 1 | — |
| Lite | 39 | 2.5M | 15 | — |
| Starter | 99 | 8M | 15 | — |
| **Premium** | **199** | 20M | 50 | **WebSockets, 500 connections** |
| Business | 499 | 60M | 100 | 2,000 connections |

- WebSocket billing is per byte:

| Subscription | CU per byte |
|---|---|
| SUBSCRIBE_TXS | 0.00015 |
| SUBSCRIBE_PRICE | 0.0015 |
| SUBSCRIBE_NEW_PAIR | 0.03 |
| SUBSCRIBE_TOKEN_NEW_LISTING | 0.04 |
| SUBSCRIBE_LARGE_TRADE_TXS | 0.005 |
| SUBSCRIBE_WALLET_TXS | 0.002 |
| SUBSCRIBE_TOKEN_STATS | 0.002 |
| SUBSCRIBE_MEME | 0.001 |

- The rate-limit page says Standard is "limited to 3 specific endpoints". The access table, however, marks many endpoints as available on Standard. **The two pages disagree**, so test with a real key.
- **The brief's caution about Birdeye is confirmed.** The free tier has no WebSocket and only 30k CU.

### 3.5 Bitquery

Source: [Bitquery pricing](https://bitquery.io/pricing).

- There is no ongoing free tier, only a 7-day trial (1,000 points, live WebSocket included).
- Personal: $29 a month billed annually, personal use only, no streaming.
- Pro: $69 a month billed annually, with 100k stream-minutes, 5 GB of stream data and 100 concurrent streams.
- Scale: $199 a month.
- Kafka and gRPC (CoreCast) appear to be Enterprise-only; that was not confirmed on a plan table.
- Vendor claim: CoreCast is "<300 ms end-to-end" ([Bitquery gRPC](https://bitquery.io/products/solana-grpc-streams)). **Not recommended here.**

---

## 4. gRPC and RPC alternatives (first paid tier with Yellowstone gRPC)

| Provider | Free tier | Cheapest way to get mainnet Yellowstone gRPC | Metering | Limits that matter | Source |
|---|---|---|---|---|---|
| **Alchemy** | 30M CU a month, 25 RPS. Solana WebSockets billed at **0.0002 CU/byte**, so about **150 GB a month** if nothing else is used | **PAYG, $75/TB, no monthly minimum.** Not on Free | Bytes. **The dashboard's dollar hard cap does not cover gRPC** | 4 regions. Vendor claim: "5–15 ms faster on average", US-East only | [pricing](https://www.alchemy.com/pricing), [WS CU](https://www.alchemy.com/docs/reference/compute-unit-costs.md), [WS billing](https://www.alchemy.com/docs/reference/solana-subscription-api-endpoints.md), [gRPC pricing](https://support.alchemy.com/articles/5952597732-how-is-solana-grpc-yellowstone-streaming-priced), [launch blog](https://www.alchemy.com/blog/introducing-alchemy-solana-grpc) |
| **Chainstack** | Developer plan: 3M RU, 25 RPS, WebSockets included | Growth $49 plus a **$49 add-on, $98 a month in total** | Unlimited events | **2 streams** (raised from 1 on 2026-06-10). Up to **200 keys** per filter list, 5 filters of each type per request. SPL Token program rejected in `account_include`. **About 100 slots (~1 min) of `from_slot` replay** | [pricing](https://chainstack.com/pricing/), [Geyser docs](https://docs.chainstack.com/docs/yellowstone-grpc-geyser-plugin.md), [changelog 2026-06-10](https://docs.chainstack.com/changelog/chainstack-updates-june-10-2026.md) |
| **Shyft** | RPC 10 RPS, API 1 RPS, no gRPC | **Build plan, $199 a month**, 10 gRPC connections | Unmetered | +$100 per 10 extra connections. About 150 slots of replay (search snippet; unverified on a docs page) | [Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing) |
| **Helius** | 1M credits (see section 1) | **Business, $499 a month** | 2 credits per 0.1 MB | 48 h replay, 7 regions | section 1.5 |
| **QuickNode** | **1-month trial** only: 10M credits, 15 RPS | Build $49 + **$499 gRPC add-on**; included from Scale ($499) | Credits | Scale: 10 streams, 10 accounts per stream | [QuickNode pricing](https://www.quicknode.com/pricing) |
| **Triton One** | None | PAYG with a **$125 minimum deposit** (valid 12 months) | $0.08/GB streaming; $10 per million calls plus $0.08/GB for RPC | Shred streaming from $450 a month | [Triton pricing](https://triton.one/pricing) |
| Solana public RPC | Free | n/a | n/a | 100 requests per 10 s per IP; 40 per 10 s for any single method; 40 concurrent connections; 100 MB per 30 s; "**not intended for production**" | [Solana clusters](https://solana.com/docs/references/clusters) |

Third-party cost comparison: an August 2026 article by RPC Fast, which sells a competing product, puts "2 streams, 500 GB a month" at **$84–$499 a month** depending on the provider ([RPC Fast, 2026-08-11](https://rpcfast.com/blog/solana-rpc-pricing)).

---

## 5. Public latency evidence (how strong it is)

| Claim | Number | Type | Source |
|---|---|---|---|
| LaserStream WebSocket vs Agave WebSocket | "up to 200 ms faster" | vendor claim | [Helius WS](https://www.helius.dev/docs/rpc/websocket) |
| preprocessedSubscribe vs `processed` | ~8 ms earlier | vendor claim | [LaserStream overview](https://www.helius.dev/docs/laserstream.md) |
| Gatekeeper vs the Cloudflare path | "tens to hundreds of ms" | vendor claim | [Helius llms.txt](https://www.helius.dev/docs/llms.txt) |
| Slot latency p90: WebSocket ~10 ms vs gRPC ~5 ms. Account latency p90: WebSocket ~374 ms vs gRPC ~215 ms | — | **secondary**: a vendor blog citing "Triton One benchmarks", no method given, 2026-06-18 | [NoLimitNodes](https://nolimitnodes.com/blog/yellowstone-grpc-providers-compared) |
| Native pubsub batches account notifications to slot boundaries, and can lag by seconds under RPC load | explanation, not measured | vendor (Triton) | [Triton Whirligig](https://blog.triton.one/whirligig-grpc-powered-solana-websocket-layer-explained/) |
| Alchemy gRPC | 5–15 ms faster on average; won 40% of comparisons in US-East | vendor claim | [Alchemy blog](https://www.alchemy.com/blog/introducing-alchemy-solana-grpc) |
| Shreder Fastlane vs LaserStream | p50 2.92 ms, p95 26.58 ms, p99 45.08 ms deltas; Frankfurt; 10k matched transactions | vendor claim; the page returned 503 when fetched | [Shreder (search snippet)](https://shreder.xyz/benchmarks/shreder-fastlane-vs-helius-laserstream/) |
| Geyser vs logsSubscribe, blockSubscribe and PumpPortal | "Geyser is consistently the front-runner"; the script exists but **no numbers are published** | vendor | [Chainstack pump.fun Geyser guide](https://docs.chainstack.com/docs/solana-listening-to-pumpfun-token-mint-using-geyser) |

Measurement-method rules, which the bot's own latency telemetry must follow:
- **Do not use `blockTime`.** It has only one-second precision, which inflates latency by up to about 1 s ([Shyft](https://docs.shyft.to/solana-yellowstone-grpc/decoding-grpc-latency), [Helius](https://www.helius.dev/docs/laserstream/guides/measuring-latency.md)).
- Compare **two parallel streams by first arrival of the same signature or slot**.
- Run the test in the same region as the endpoint.

No independent, peer-reviewed benchmark of standard WebSocket vs Enhanced WebSocket vs gRPC vs third-party feeds was found. All comparative numbers above come from vendors. **Treat them as upper bounds** and measure locally.

---

## 6. Market structure facts that set the latency need

- **Launch volume.** An academic sample (12 May – 10 Jun 2026) covered **749,816 mints over 29 days, about 25.9k a day** ([arXiv 2607.02823](https://arxiv.org/abs/2607.02823), v2 dated 2026-09-10). A vendor indexer counted August 2026 at about 37.5k launches and about 660 graduations a day, a 1.76% bond rate ([MadeOnSol, 2026-08-28](https://madeonsol.com/blog/pump-fun-deployer-stats-august-2026)). Graduation counts differ between sources: news reports say about 100 a day and a 0.2–0.26% graduation rate ([DEXTools](https://www.dextools.io/news/pump-fun-graduation-collapse-solana-fees-2026)). **Unverified; measure it with your own discovery logger.** My own measurement: **34–36 creates in 88 s and 131 in 240 s**, which is about 0.4–0.55 a second, or 35k–47k a day.
- **Same-block sniping is mostly insiders.** Over one month, 15,000+ launches had a same-block snipe by a wallet the deployer funded. 4,600+ sniper wallets took 15,000+ SOL of profit, 87% of snipes were profitable, 55% exited within 1 minute, and the strategy accounts for about 1.75% of launches ([Pine Analytics, 2025-04-21](https://pineanalytics.substack.com/p/exit-liquidity-machines); data, but from 2025). Coordinated sniper "cohorts" sit at the top of the buyer queue (median first-buyer rank of 3.55 or better; 1,012 cohorts) ([arXiv 2607.02795](https://arxiv.org/pdf/2607.02795)). **A free-tier bot cannot win that race, and shouldn't try. This supports the brief's "Avoid first-block launch sniping."**
- **Program IDs.**
  - Pump bonding curve: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
  - PumpSwap AMM: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`.
  - `migrate` is permissionless and idempotent. A curve is complete when `complete == true` and `real_token_reserves == 0`.
  - Source: [pump-public-docs](https://github.com/pump-fun/pump-public-docs).
- **Recent pump.fun interface changes that decoders must follow** ([pump-public-docs README](https://github.com/pump-fun/pump-public-docs)):
  - `buy_v2`, `sell_v2` and `buy_exact_quote_in_v2` (support for a USDC quote asset);
  - `create_v2` with `is_holder_reward`, while cashback is deprecated;
  - PumpSwap `virtual_quote_reserves`. The price must use **effective reserves = vault amount + virtual_quote_reserves**, and this value **can be negative from "September 30"**. The year is not stated; this is the newest README entry, presumably 2026.
  - Any feed that delivers raw reserves without this adjustment will misprice pools.

---

## 7. My measurements (2026-10-03, ~11:15–11:40 UTC)

Setup:
- Node 22, running in a US cloud container (Cloudflare `cf-ray … IAD`), behind an egress proxy.
- Reference RPC: `api.mainnet-beta.solana.com` (Agave pubsub), commitment `processed`.
- These are short single samples. **They show direction, not statistical proof.**
- Scripts and raw JSON: `scratchpad/research/data-measurements/`.

### 7.1 PumpPortal vs standard RPC WebSocket (new tokens)

Method: subscribe at the same time to PumpPortal (`subscribeNewToken`, `subscribeMigration`) and to public `logsSubscribe {mentions: [pump program]}`. Match by signature. Delta = PumpPortal receipt time minus RPC receipt time.

| Run | Duration | Matched | Δ min | p10 | p50 | p90 | max |
|---|---|---|---|---|---|---|---|
| 1 | 180 s | 112 | −386 ms | −149 ms | −26 ms | +94 ms | +283 ms |
| 2 | 240 s | 127 | −448 ms | −160 ms | −24 ms | +140 ms | +491 ms |

**Coverage (run 2):**
- The RPC saw 147 successful `Create`/`CreateV2` instructions. **20 of them (13.6%) never arrived on PumpPortal.**
- 7 of PumpPortal's 134 events (5.2%) were not seen on public `logsSubscribe`.
- Neither feed is complete. **Use both and remove duplicates.**

**Firehose volume (run 1):** the pump program produced 33,178 log notifications in 180 s (**184 a second**), 49.1 MB in total, averaging 1.48 KB each.
- At Helius's 20 credits per MB, that is about 471k credits a day, or **about 14.1M a month**. That is **14 times** Helius Free, and more than Developer's 10M.
- On Alchemy at 200 CU per MB it is about 9.8k CU per 3 minutes, or **about 141M CU a month**, also far above the free 30M.
- **Conclusion:** do not subscribe to the full pump-program log stream on any metered plan.

### 7.2 Polling feeds vs PumpPortal (run 2)

| Feed | Poll interval | Matched with PumpPortal | Lag p10 | p50 | p90 | Errors |
|---|---|---|---|---|---|---|
| Jupiter `/tokens/v2/recent` (keyless) | 2.5 s | 124 of 131 creates | 2.6 s | **4.9 s** | 7.2 s | 0 of 96 |
| Same, measured against `firstPool.createdAt` | — | 154 | 3.5 s | 5.5 s | 8.5 s | — |
| GeckoTerminal `/networks/solana/new_pools` | 4 s | 33 | 43.7 s | **67.4 s** | 83.1 s | 39 of 60 |

- Jupiter `/recent` returns 30 mints. At about 0.5 creates a second, that covers only about 60 s of history. **Poll it at least every 30 s or you will miss tokens.** On a free key, every poll also uses the shared main bucket.
- GeckoTerminal's new pools spanned pump-fun (79), pumpswap (5), meteora-dbc (3), meteora-damm-v2 (3) and others. **It is useful for coverage outside pump.fun, not for speed.**

### 7.3 Shortlist and position stream cost

Method: take the first 17–20 brand-new pump.fun tokens, then subscribe on the public RPC at `processed`.

| Method | Window | Messages | Average size | Data | Helius credits a month if continuous | Alchemy CU a month |
|---|---|---|---|---|---|---|
| `accountSubscribe` (base64) on 20 bonding curves | 180 s | 706 (3.9 a second; 14 of 20 active; the busiest had 505, ≈ 2.8 a second, about one per slot) | 346 B | 0.244 MB | **~70k** | ~0.7M |
| `logsSubscribe` (mentions = mint) on 17 mints | 120 s | 2,530 (21 a second; 12 of 17 active; the busiest had 1,006) | 1.84 KB | 4.64 MB | **~2.0M** | ~20M |
| Same flow through PumpPortal `subscribeTokenTrade` | — | ~1.82M events a day | — | — | — | **~1.82 SOL a day ≈ $217 a day** |
| Same flow through Helius Parsed Streams | — | ~1.82M events a day | — | — | **~55M a month** | — |

An earlier unchecked `logsSubscribe` run reported 36k messages in 180 s. That run is **excluded as unreliable**, because subscription acknowledgements were not checked.

Single-position estimate: a hot pool at about 10 transactions a second × 1.84 KB ≈ 66 MB an hour, or **about 1,320 Helius credits an hour** for logs. `accountSubscribe` on the curve or pool plus its vaults adds about 1.2 KB a second, or roughly 90 credits an hour.

---

## 8. Recommended stack

### 8.1 Free-tier-first (paper mode, and the $20 canary)

**A. Discovery of new pools and graduations: two independent feeds, de-duplicated by signature.**
- Primary: **PumpPortal** `subscribeNewToken` and `subscribeMigration` on **one** WebSocket. It is free, matches standard RPC speed (p50 −24 ms), and misses about 14% of creates.
- Second source for graduations: **Helius Parsed Streams**, filtered on the pump program's `migrate` instruction (or PumpSwap `create_pool`). It is `confirmed` only and costs 1 credit per event, so a few hundred to about 660 events a day means ≤20k credits a month.
- Second source for creates and for venues other than pump.fun: **Jupiter `/tokens/v2/recent`**, polled every 20–30 s. Its lag is 5–8 s plus the polling interval, but it covers Meteora DBC, LaunchLab and other venues and includes audit and organic fields.
- Reconcile any gap with `getSignaturesForAddress` on the pump program (1 credit), and only after a reconnect.
- Context only: DexScreener (300 rpm on pair and search endpoints, data up to 60 s cached) and GeckoTerminal (30 calls a minute, about 70 s lag). Never use them as a trigger.
- Because the brief avoids first-block entries, the 0.1–5 s discovery latency of this stack is **not the bottleneck**.

**B. Streams for a shortlist of up to 20 tokens**
- Use **`accountSubscribe` (base64, `processed`)** on each token's state accounts:
  - pump bonding curve: 1 account;
  - PumpSwap: the pool account plus its base and quote vaults (price = vault amount + `virtual_quote_reserves`).
- Measured cost is about 70k Helius credits a month for 20 tokens. Put this traffic on **Alchemy Free WebSocket**, which has the most free bandwidth and is a second failure domain, so Helius credits stay reserved for the position and exits.
- Turn on trade-level `logsSubscribe` only for the **top 1–3** candidates, with a time limit (for example 10 minutes each). At about 2M credits a month for 17 always-on tokens, trade streams for all 20 would eat the free budget.
- Pull wallet-level detail on demand with `getTransaction` (1 credit).

**C. Watching the one open position (top priority)**
- Subscribe at the same time on **Helius** (`mainnet` or Gatekeeper `beta`) and on **Alchemy or the public RPC**:
  - `accountSubscribe` on the pool or curve and its vaults;
  - `logsSubscribe` (mentions = pool);
  - `slotSubscribe` as a liveness check.
- Take the first copy of each update to arrive, de-duplicated by (slot, signature). If no slot update arrives for more than 2–3 slots, treat the feed as stale.
- Exit path:
  - quote with Jupiter `/order` (main bucket), then execute with `/execute` (separate 50 RPS bucket, 0 credits); or
  - build the transaction and send it via **Helius Sender in SWQOS-only mode** (0 credits, 50 TPS, ~$0.0006 tip).
  - Escalate to Sender Max (0.001 SOL) only within the emergency fee ceiling.
  - Remember that Helius Free allows only 1 `sendTransaction` per second; Sender is not subject to that limit.
- Confirm with `signatureSubscribe` plus `getSignatureStatuses` polling (1 credit each).

**D. Quota reservation (put in code, not just documentation)**
- Run a token-bucket scheduler per provider with four priority classes:

| Class | Covers |
|---|---|
| P0 | exits and reconciliation |
| P1 | position monitoring |
| P2 | shortlist |
| P3 | discovery |

- Discovery is shed first.
- **Jupiter free main bucket (60 per minute):** cap discovery and Tokens calls at ≤6 a minute and **keep ≥30 a minute free for `/order`** while a position is open. Read `x-ratelimit-remaining` on every response.
- **Helius 10 RPS:** reserve ≥5 RPS for P0 and P1.
- **Helius 1M credits a month** (about 33k a day):
  - position about 10k a day (≈7 hot hours);
  - shortlist ≤3k a day (if not moved to Alchemy);
  - graduations ≤1k a day;
  - RPC checks and reconciliation the rest;
  - **halt new entries at 70% of the monthly budget.**
- **Helius Free WebSocket connections (5):** one for the position, one for the shortlist or graduations, one for Parsed Streams, and two spare for reconnecting.
- **PumpPortal:** exactly 1 connection, with a backoff that respects the one-hour ban rule.

### 8.2 First paid upgrade: best value per millisecond saved

**Helius Developer, $49 a month.** Upgrade when one of these appears in shadow logs:
- the position feed is stale more than X% of the time;
- WebSocket credits used are above 70% of the budget;
- realised exit slippage is consistently worse than the quote at decision time.

What the $49 buys:
- `transactionSubscribe` at `processed`. One filter with `accountInclude` (≤50k addresses) covers the shortlist and the position, with full execution metadata and server-side `failed:false` and `vote:false`.
- LaserStream-backed WebSocket. Vendor claim: up to 200 ms faster than Agave WebSocket.
- **`preprocessedSubscribe` (beta)** on the position's pool and the deployer and top-holder wallets. It gives pre-execution sight of incoming sells or liquidity withdrawals, vendor-claimed about 8 ms before `processed`, at 0.1 credit per message.
- 10M credits (≈500 GB of WebSocket data), 50 RPS, 5 `sendTransaction` a second, and 150 WebSocket connections.

This is cheaper than any gRPC option and covers the place where latency matters (exits). The free stack stays as a fallback.

**Second upgrade: gRPC.** Do it only if A/B telemetry (a parallel-stream first-arrival test, section 5) shows the WebSocket path losing more than about 100 ms often enough to change exit fills:

| Option | Cost | Note |
|---|---|---|
| **Alchemy PAYG gRPC** | $75/TB, no minimum. A tightly filtered shortlist plus position stream (≤1–3 GB a day) costs roughly **$2–7 a month** | **No dollar hard cap on gRPC, so build a byte budget and a kill-switch into the client** |
| **Chainstack** | $98 a month flat, unlimited events | 2 streams, 200 keys per filter, but only about 1 minute of replay |
| **Shyft** | $199 a month | unmetered, 10 connections |
| **Helius Business** | $499 a month | 48 h replay. Only if the strategy proves profitable |

### 8.3 Not recommended at this budget

- **PumpPortal trade streams.** About $217 a day at the measured shortlist rate.
- **Parsed Streams for trades.** At 1 credit per event it would need about 55M credits a month.
- **Birdeye WebSockets.** $199 a month minimum.
- **Bitquery streaming.** $69 a month or more, billed annually.
- **QuickNode gRPC.** A $499 add-on.
- **Raw shreds.** $800–1,000 a month per IP.
- **Using the Solana public RPC as the primary.** The docs say it is not intended for production. It is fine as a third check while in paper mode.

---

## 9. Brief claims checked

| Brief claim | Status | Note and source |
|---|---|---|
| Helius free plan: 1M credits a month, 10 RPC requests a second | **Confirmed** | Also: DAS 2/s, `sendTransaction` 1/s, `getProgramAccounts` 5/s, 5 WebSocket connections, WebSocket metered at 2 credits per 0.1 MB, no `transactionSubscribe` ([plans](https://www.helius.dev/docs/billing/plans), [rate limits](https://www.helius.dev/docs/billing/rate-limits), [credits](https://www.helius.dev/docs/billing/credits)) |
| "Credits vary by method; this is not full-chain coverage or a latency guarantee" | **Confirmed** | Full pump-program logs alone would take about 14M credits a month (measured) |
| Jupiter free key: 1 RPS main bucket, separate 50 RPS `/execute` bucket, organisation-scoped | **Confirmed** | 60-second sliding window. Keyless gets 0.5 RPS (`/execute` 20). The main bucket includes Swap, Price and Tokens ([rate limits](https://developers.jup.ag/docs/portal/rate-limits)) |
| Jupiter Tokens V2 provides recent pools, categories and organic score; organic score is relative | **Confirmed** | `/recent` is keyed to first pool creation, 30 results by default; category intervals are 5m, 1h, 6h, 24h ([token information](https://developers.jup.ag/docs/tokens/token-information.md)) |
| Birdeye endpoint and WebSocket access depend on plan; free does not supply all feeds | **Confirmed** | Free: 30k CU, 1 RPS. WebSockets from Premium at $199 ([pricing](https://data.birdeye.so/docs/guides/payment/pricing.md)) |
| DEX Screener exposes paid boosts and profiles | **Confirmed** | Boosts, ads and orders endpoints exist, at 60 rpm ([DEX Screener API](https://docs.dexscreener.com/api/reference)) |
| Brief link "Helius WebSockets" (`/docs/rpc/websocket`) describes standard WebSockets | **Outdated wording** | The page now covers "LaserStream WebSocket". The standard methods are still available on all plans |
| Task brief: PumpPortal free WebSocket covers new tokens, migrations, token trades and account trades | **Partly outdated** | Only new tokens and migrations are free. Trades cost 0.01 SOL per 10,000 events and need a key plus a wallet with ≥0.02 SOL ([PumpPortal](https://pumpportal.fun/data-api/real-time)) |
| "Reserve provider quota and request priority for open-position monitoring and exits before discovery" | **Confirmed as necessary** | Jupiter's shared main bucket means discovery polling directly competes with exit quotes |

---

## 10. Open questions (still unverified)

1. Helius Free WebSocket latency and how often it drops connections at our message rates. It must be measured from the production host region with a parallel first-arrival test.
2. Whether Alchemy Free Solana WebSockets carry any restriction not shown on the page, such as limits on methods or connections. Not verified.
3. The cause of PumpPortal's ~14% gaps in create events: filtering such as `is_mayhem_mode` or certain `create` variants, or dropped messages. Unknown; measure over 24 hours.
4. Graduation rate and count per day. Sources disagree, ranging from about 100 to 660 a day.
5. Whether Jupiter Tokens V2 `stats5m` and organic fields are fresh enough to act on, for example how stale `priceBlockId` is compared with the current slot. Not measured.
6. The size and timing of the "September 30" PumpSwap negative virtual-reserve change. The year is not stated in the README.
7. GeckoTerminal's 65% error rate came from a shared proxy IP. The cause is unverified.
