# Execution, transaction landing, MEV and costs

Research date: 2026-10-03 (UTC). SOL price used throughout: **$119.37** (Jupiter Price V3 `usdPrice` 119.376 and CoinGecko 119.35 at 2026-10-03 11:46 UTC; [Jupiter Price API](https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112), [CoinGecko](https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd)). $2 = 0.016755 SOL; $5 = 0.041887 SOL.

Evidence labels used below:
- **Doc**: official documentation or program source (date given when visible).
- **Chain**: read directly from Solana mainnet RPC by this research on 2026-10-03 (method named).
- **Live API**: a live call to a provider API on 2026-10-03.
- **Sample**: small on-chain sample taken by this research; descriptive only, not a statistic you can generalise.
- **Secondary**: news or aggregator, not primary.
- **Unverified**: could not be confirmed.

---

## 1. Summary for the builder

1. **Rent is cheaper than the brief says, and still falling.** SIMD-0437 cut `lamports_per_byte` from 6,960 to 6,333 (2026-09-03) and then to **5,080** (epoch 1033, 2026-09-11). A 165-byte SPL token account now costs **1,488,440 lamports (0.00148844 SOL, $0.178)**, not 0.00203928. A pump.fun `create_v2` coin is Token-2022 and its ATA is **170 bytes = 1,513,840 lamports ($0.181)**. Steps 3 to 5 (to 2,575, 1,322 and finally 696 lamports/byte) are expected with Agave 4.4 (November 2026). Never hardcode rent; call `getMinimumBalanceForRentExemption(size)`. (Chain + Doc)
2. **Venue fees dominate the cost of a $2 to $5 trade, not network fees.** pump.fun curve: 1.25% per side (0.95% protocol + 0.30% creator) read from the on-chain `FeeConfig`. PumpSwap canonical pools: 1.25% below 420 SOL market cap, 1.20% from 420 to 1,470 SOL, falling to 0.30% at 98,240 SOL and above. Raydium CPMM (the LaunchLab graduation target): 0.25% trade fee + 0.05% creator fee. A pump-curve round trip costs about **2.9 to 3.0% of notional**. Network costs are about 0.36% of a $2 round trip. (Chain + Doc)
3. **Jupiter Swap V2 is live at `https://api.jup.ag/swap/v2`.** `/order` + `/execute` is the managed Meta-Aggregator path (formerly Ultra, `ultra-api.jup.ag`). `/build` is the Router path (formerly Metis `/swap/v1/quote` + `/swap-instructions`). `lite-api.jup.ag` is being phased out and replaced by keyless `api.jup.ag` at 0.5 RPS. Free key: 1 RPS. `/execute` has its own bucket (keyless 20, free 50, paid 100 RPS). (Doc)
4. **The documented 50 bps new-token fee did not appear in live quotes.** The docs list 50 bps for tokens under 24 hours old. Live `/order` quotes on 2026-10-03 for 5 pump tokens created that day (2 minutes to about 5 hours old) all returned `feeBps: 10` in both directions. That is 22 keyless quotes and could change, so read `feeBps` and `platformFee` on every quote and never assume either value. (Doc vs Live API)
5. **Jupiter RTSE chose 20% slippage (2000 bps) for fresh pump tokens** in live `/order` quotes. A risk-aware bot must pass its own `slippageBps`. That sets `mode: "manual"` but does not restrict routing. (Live API + Doc)
6. **Two "fast lane" senders charge a flat 0.001 SOL ($0.119) per transaction:** Jupiter `tx.jup.ag` (mandatory tip) and Helius Sender Max. That is 6% of a $2 entry, or 12% for a round trip, so reject both for this bankroll. **Helius Sender SWQoS-only** (`?swqos_only=true`) needs only a **0.000005 SOL ($0.0006) tip** and a priority fee. It uses no credits and works on the free plan. This is the best value per dollar for landing. (Doc)
7. **Jito**: minimum tip 1,000 lamports; up to 5 transactions per bundle, all-or-nothing; default 1 request/s per IP per region. Live tip floor at 2026-10-03 11:48 UTC: p50 = 3,948 lamports, p75 = 10,229 lamports, p95 = 152,644 lamports, p99 = 1,000,000 lamports. A bundle can be "unbundled" on an uncled block, so put the tip in the same transaction as the swap. `jitodontfront…` read-only account: the block engine rejects any bundle that places your transaction anywhere but index 0. (Doc + Live API)
8. **Sandwiching is real but rarely profitable against $2 to $5 trades on pump venues.** sandwiched.me 30-day window (fetched 2026-10-03 11:51 UTC): **137,968 sandwiches, 5,769 SOL extracted, 62,461 victims, 626 attackers**. The pump bonding curve program had 18,469 sandwiches (2,118 SOL, about 0.115 SOL each) and PumpSwap had about 42,880 (1,094 SOL). Break-even math: to push a 30-virtual-SOL pump curve by 10%, an attacker must front-run about 1.46 SOL and pays about $4.37 in pump fees. Your 10% slippage on $2 exposes at most $0.20. Tight slippage is the main, free protection. Add `jitodontfront` and Helius `mev-protect=true` (both free). (Data + own calculation)
9. **Landing reality (Sample, 300 recent transactions per program, 2026-10-03 ~11:50 UTC):**
   - pump program: 51% of transactions failed, most of them bot transactions failing cheaply (`Custom 13`, about 4.3k CU).
   - Successful pump trades: priority fee p50 13,334 lamports, p75 100,000, p90 280,645. CU used p50 97,758, p90 144,120. 13% included a Jito tip.
   - PumpSwap: 34% failed, often slippage (`6040 BuySlippageBelowMinBaseAmountOut`). Successful-trade priority fee median 0, CU p50 95,999.
   - All three transaction formats (legacy, v0, **v1**) appear. v1 transactions are live on mainnet, and readers must opt in with `maxSupportedTransactionVersion: 1` or parsing fails.
10. **Libraries**:
    - `@solana/kit` 8.4.0 (2026-09-28) is the maintained SDK.
    - `@solana/web3.js` 1.x is maintenance-only (1.99.0, 2026-09-08, critical fixes only).
    - `@solana/web3.js` 3.0.0 shipped on 2026-10-01 under the `next` dist-tag. It rebuilds the class API on Kit.
    - The Dec 2024 compromise (CVE-2024-54134) hit 1.95.6 and 1.95.7 on 2024-12-03 between 15:20 and 20:25 UTC; both versions are now removed from the registry.
    - The official pump SDKs pull in web3.js v1, Anchor, bn.js, spl-token and an extra `@pump-fun/agent-payments-sdk`.
    - For a minimal-dependency bot: Kit + `@solana-program/{token,token-2022,system,compute-budget}` + instruction builders generated from the published pump IDLs with Codama (or hand-encoded and tested against the SDK math).

---

## 2. Jupiter API state (2026-10-03)

### 2.1 Paths, endpoints, naming

| Item | Current state | Evidence |
|---|---|---|
| Base URL | `https://api.jup.ag/swap/v2`; API key in `x-api-key` | [Swap index](https://developers.jup.ag/docs/swap/index.md) (Doc, fetched 2026-10-03) |
| Meta-Aggregator ("managed") | `GET /order` (quote + assembled unsigned v0 tx) + `POST /execute` (Jupiter lands it via "Jupiter Beam"). Routers compete: Metis, JupiterZ (RFQ), Dflow, OKX | [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute.md) |
| Old name | Ultra: `ultra-api.jup.ag` `/order` + `/execute`. "Request parameters and response format are identical. Update the base URL." | [Ultra to Meta-Aggregator](https://developers.jup.ag/docs/swap/migration/ultra-to-order.md) |
| Router ("Build") | `GET /build` returns raw instructions (compute-budget price, setup, swap, cleanup, other, optional tip, ALTs, `blockhashWithMetadata`). Metis only, ExactIn only. **No Jupiter platform fee.** `/build` transactions **cannot** use `/execute` | [Build](https://developers.jup.ag/docs/swap/build/index.md) |
| Old name | Metis `GET /swap/v1/quote` + `POST /swap/v1/swap-instructions`. V2 instructions **do not emit fee events**, and `routePlan` uses `bps` | [Metis to Router](https://developers.jup.ag/docs/swap/migration/metis-to-build.md) |
| Self-landing helper | `https://tx.jup.ag` JSON-RPC `sendTransaction` only. Needs an API key and **min 0.001 SOL tip** to one of 16 tip accounts. `skipPreflight` forced true, `maxRetries` must be 0, max 1,232 bytes. `swqosOnly` flag. "The Jupiter tip is flat: tipping more does not improve landing." | [Transaction Submission](https://developers.jup.ag/docs/transaction/submit.md) |
| lite-api | "`lite-api.jup.ag` will be phased out once the new API gateway is stable. The rate limit… will be reduced progressively." Keyless on `api.jup.ag` replaces it | [Portal migration](https://developers.jup.ag/docs/portal/migration.md) (Developer Platform launched 2026-04-06; grace period ended 2026-06-30) |
| Gateway regions | AWS ap-southeast-1, eu-central-1, us-east-1, sa-east-1, ap-northeast-1, us-west-2 | [Latency](https://developers.jup.ag/docs/portal/latency.md) |

### 2.2 Fees on `/order` (Doc)

From [Order & Execute → Fees](https://developers.jup.ag/docs/swap/order-and-execute.md):

| Pair | Platform fee |
|---|---|
| Buying JUP/JLP/jupSOL; LST-LST; stable-stable | 0 bps |
| SOL-stable | 2 bps |
| LST-stable | 5 bps |
| Everything else | **10 bps** |
| New tokens (within 24 hours of token age) | **50 bps** |

- Fees are collected in one mint, chosen in priority order SOL > stables > LSTs > bluechips > others. For SOL-quoted memecoin trades they are therefore taken in SOL.
- `feeBps` is the total. It can exceed `platformFee.feeBps` when gasless cost recovery is added.
- `/execute` returns `totalInputAmount`, `inputAmountResult`, `outputAmountResult` and `totalOutputAmount`, so the fee charged can be computed from these fields.
- Referral fees are 50 to 255 bps, and Jupiter takes 20% of them.

**Live check (2026-10-03, keyless `/order`)**:

| Mint | Age at quote | Direction | Route | feeBps | RTSE slippageBps | prioritizationFeeLamports | rentFeeLamports |
|---|---|---|---|---|---|---|---|
| `Gn4Txcs3…pump` | ~18 min | SOL→token, 0.016754 SOL | Pump.fun 100% | **10** | **2000** | 10,642 | 1,488,440 |
| `M91aU298…pump` | ~2 min | SOL→token | Pump.fun 100% | **10** | **2000** | 2,450 | 1,488,440 |
| `M91aU298…pump` | ~2 min | token→SOL | Pump.fun 100% | **10** | 1751 | n/a (insufficient funds) | 0 |

Notes:
- Token ages come from [Jupiter Tokens V2 search](https://api.jup.ag/tokens/v2/search?query=M91aU298tagMcYHncxdWwrfPZHs8nbiJmB6362ypump) `createdAt`.
- The 50 bps tier was **not** applied in this sample (22 quotes, 5 tokens all under 24 h old, including graduated ones in the next table: all `feeBps` 10). Either the condition has changed or it depends on something other than mint age. Status: **documented but not observed live**.
- Jupiter's `rentFeeLamports` estimate (1,488,440) is the 165-byte figure. The actual pump `create_v2` ATA is 170 bytes, 1,513,840 lamports, so the estimate is slightly low.

**Quoted round trips (Live API, keyless, buy quote then sell quote of the output about 2.2 s later; noisy because prices move between calls):**

| Token | Route | $2 round-trip quoted loss | $5 |
|---|---|---|---|
| ALON (`M91a…pump`), curve, liquidity ~$3.7k | Pump.fun | 2.77% | 2.92% |
| DARKPOOL (`fCUB…pump`), graduated, mcap ~$117k (~984 SOL, 1.20% tier) | Pump.fun Amm | 2.57% | 2.58% |
| `Gn4T…pump`, liquidity ~$94 | Pump.fun | 28.8% | n/a (400) |

The first two match the model of 2 × (venue fee + 10 bps) plus small impact. The third shows that a depth gate is mandatory.

### 2.3 Rate limits, keys, credits (Doc)

[Rate limits](https://developers.jup.ag/docs/portal/rate-limits.md), [Plans](https://developers.jup.ag/docs/portal/plans.md), [FAQ](https://developers.jup.ag/docs/portal/faq.md):

| Tier | RPS | RPM | Price/month | Credits |
|---|---|---|---|---|
| Keyless | 0.5 | 30 | $0 | n/a |
| Free (key) | 1 | 60 | $0 | unlimited (rate-limited only) |
| Developer | 10 | 600 | $25 | 25M |
| Launch | 50 | 3,000 | $100 | 100M |
| Pro | 150 | 9,000 | $500 | 500M |

- The `/swap/v2/execute` bucket is separate: keyless 20, free 50, paid 100 RPS.
- Limits use a 60-second sliding window and are scoped **per organisation, not per key**. A 429 carries no lockout.
- Execute endpoints cost 0 credits. `/order` and `/build` cost 1 credit; `/tokens/v2/search` costs 10.
- **Swap, Price and Tokens share one bucket.** At 1 RPS, every token lookup takes away from quote capacity.
- **Cheapest upgrade**: Developer at $25/month (10 RPS). Needed only if the bot depends on Jupiter for both monitoring and exits. With local venue quoting it is not needed.

### 2.4 Quote freshness, expiry, idempotency

- Aggregator routes: `lastValidBlockHeight` in `/order` is the hard expiry. RFQ (JupiterZ): `expireAt` timestamp, "typically shorter-lived". "Sign and submit immediately." ([Doc](https://developers.jup.ag/docs/swap/order-and-execute.md))
- `/execute` error `-1` means "Missing cached order (requestId not found or expired)". **The requestId lifetime (TTL) is not documented: unverified.**
- `/build` default `blockhashSlotsToExpiry` = 150, range 1 to 300 ([OpenAPI](https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml)).
- Retrying `/execute` with the same signed bytes and requestId is idempotent at the chain level, because one signature can land at most once. **Jupiter does not document whether `/execute` itself deduplicates: unverified.** Treat a timeout as "unknown" and check the signature status yourself.

### 2.5 Dynamic slippage (RTSE) and priority fees

- RTSE (Real-Time Slippage Estimator) is computed **at order time** from token-category heuristics, an EMA of slippage data, and failure-rate monitoring. It is automatic on `/order` and opt-in on `/build` (`slippageBps=rtse`). `/build` defaults to a fixed 50 bps. ([Slippage](https://developers.jup.ag/docs/swap/advanced/slippage.md))
- Live: RTSE gave **2000 bps** for fresh pump buys and 1751 bps for a sell (see 2.2). For a risk-aware bot, override `slippageBps` from your own local quote.
- `/order` optional parameters:
  - `priorityFeeLamports`, `jitoTipLamports`, `broadcastFeeType` (`maxCap` | `exactFee`), `excludeRouters` and `excludeDexes`. `dexes` is honoured only on `/build`.
  - The `/order` response exposes `signatureFeeLamports`, `prioritizationFeeLamports` ("includes priority fees and tips (Jito, Nozomi)"), `rentFeeLamports` and the payer of each.
  - Source: [OpenAPI](https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml).
- `/build` options:
  - `computeUnitPricePercentile`: `medium` = 25th, `high` = 50th (default), `veryHigh` = 75th, or 0 to 10000 bps. `mode=fast` raises the default to the 90th percentile.
  - Jupiter warns the estimate "can spike far above what is needed". Decode `setComputeUnitPrice` (discriminator 3, u64 LE micro-lamports) and clamp it.
  - CU limit: simulate with 1.4M, then use 1.2× consumed (cap 1.4M).
  - Source: [Compute units](https://developers.jup.ag/docs/swap/advanced/compute-units.md).
- `mode=fast` on `/build` (BETA): Bellman-Ford without route splitting, and a priority-fee lookup run in parallel that falls back to a **global** rather than a local-fee-market estimate. ([Reduce latency](https://developers.jup.ag/docs/swap/advanced/reduce-latency.md))

### 2.6 Gasless and fee-payer traps

- Automatic gasless sponsorship fires when the taker has **<0.01 SOL** and the trade is **~$10 or more**. It raises `feeBps`, and the signer becomes `gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB`.
- JupiterZ quotes can carry a market-maker fee payer.
- Jupiter's own deterministic opt-out is to drop any quote where `signatureFeePayer != taker`. Add this check to the signer policy. ([Gasless](https://developers.jup.ag/docs/swap/advanced/gasless.md))
- The same page lists "Other account rent (some DEXes require additional accounts of the taker, e.g. Pump.fun)". These are the volume accumulators, see section 6.

### 2.7 MEV protection on Jupiter

The current Swap V2 docs (fetched 2026-10-03) **make no explicit sandwich or MEV-protection claim** for `/order`/`/execute`. They describe Beam as "accelerated transaction sending and landing across multiple RPC providers". Any claim that Jupiter protects against MEV is **unverified** for the current version. The only explicit MEV statement is for Trigger V2: orders are "stored off-chain and private by default".

### 2.8 Trigger V2

Confirmed ([Trigger overview](https://developers.jup.ag/docs/trigger/index.md), [Best practices](https://developers.jup.ag/docs/trigger/best-practices.md), [Deposit](https://developers.jup.ag/docs/trigger/deposit.md)):
- Base URL: `https://api.jup.ag/trigger/v2`. Needs challenge-response JWT auth plus an API key. **Beta**: "behaviour, endpoints, and response formats may change".
- Order types: single, OCO, OTOCO, trailing, DCA. Triggers are **USD price only**, and output is not guaranteed.
- Each wallet has one vault, a **Privy-managed custodial account**. Deposits move funds out of your wallet.
- Minimum **10 USD** per price order (DCA: 10 USD per round, at least 2 rounds).
- Default slippage: take-profit and buy-below use RTSE; **stop-loss and buy-above use 2000 bps (20%)**.
- `expiresAt` is mandatory (no "never" option).
- Transfer-fee and transfer-hook mints are rejected unless whitelisted.
- Trigger V1 is not deprecated but gets critical-only updates. The Recurring API is unmaintained.

The brief's exclusion of Trigger V2 for the $20 trial stands.

---

## 3. Direct venue swaps

### 3.1 Program IDs and official artefacts (Doc / Chain)

| Venue | Program | Official SDK / IDL | Notes |
|---|---|---|---|
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | [pump-public-docs](https://github.com/pump-fun/pump-public-docs) (IDL refreshed 2026-09-12; last commit 2026-09-29); `@pump-fun/pump-sdk` 2.0.0 (2026-09-13) | Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`. New unified `buy_v2`/`sell_v2`/`buy_exact_quote_in_v2` (27 accounts, all mandatory). `create_v2` coins are **Token-2022** |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | same repo; `@pump-fun/pump-swap-sdk` 1.20.0 (2026-09-10) | GlobalConfig `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`; canonical pool index 0 |
| Pump fee program | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | IDL in same repo | FeeConfig PDAs: pump `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, AMM `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` (seeds `["fee_config", program]`) |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | `@raydium-io/raydium-sdk-v2` 0.2.73-alpha (2026-09-23); source not public | All new launches migrate to CPMM ([LaunchLab](https://docs.raydium.io/products/launchlab/overview.md)) |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | [raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) | [Addresses](https://docs.raydium.io/reference/program-addresses) |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (2026-09-24) | Graduates to DAMM v2 |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `@meteora-ag/cp-amm-sdk` 1.5.1 (2026-09-30) | Program ID confirmed in Jupiter's [program-id-to-label](https://api.jup.ag/swap/v1/program-id-to-label) |

### 3.2 Fee schedules

**pump.fun / PumpSwap (Chain, FeeConfig decoded 2026-10-03; matches the [fee table image](https://github.com/pump-fun/pump-public-docs/blob/main/docs/fees.png) and the [fee program doc](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md))**

- Bonding curve: protocol 95 bps + creator 30 bps = **125 bps**, with one tier for all market caps. The creator fee is charged only if `bonding_curve.creator` is set, which is always true for new curves.
- PumpSwap canonical pools (`pool.creator` = pump pool-authority PDA) are tiered by market cap in SOL, computed as `quoteReserve × baseMintSupply / baseReserve`:

| Market cap (SOL) ≥ | LP | Protocol | Creator | Total |
|---|---|---|---|---|
| 0 | 2 | 93 | 30 | **125 bps** |
| 420 | 20 | 5 | 95 | 120 |
| 1,470 | 20 | 5 | 90 | 115 |
| 2,460 | 20 | 5 | 85 | 110 |
| 3,440 | 20 | 5 | 80 | 105 |
| 4,420 | 20 | 5 | 75 | 100 |
| 9,820 | 20 | 5 | 70 | 95 |
| … | | | | 5 bps steps |
| 98,240 | 20 | 5 | 5 | **30** |

- Non-canonical PumpSwap pools use flat fees: LP 25 + protocol 5 + creator 0 = **30 bps**. Exotic quote mints pay 20/5/5.
- Fees are taken on the quote (SOL) side, rounded up per component (`ceilDiv`). See SDK `fees.ts`/`sell.ts`.
- Pump advises reading the FeeConfig and computing tiers rather than hardcoding them. "If you implement the fee logic correctly, any future change to the fee tiers structure above should not affect your code."

**Raydium (Live API 2026-10-03)**

- LaunchLab global `tradeFeeRate` = **2,500/1e6 = 0.25%** ([launch configs](https://launch-mint-v1.raydium.io/main/configs)). Default graduation `totalFundRaisingB` = 85 SOL.
- On top of that sit a **platform fee** (`PlatformConfig.fee_rate`, capped at 5% since 2026-08-26) and a **creator fee** (≤0.5%), as described in [Platform config](https://docs.raydium.io/products/launchlab/platform-config).
- Live platform list ([platforms](https://launch-mint-v1.raydium.io/main/platforms)):
  - letsbonk.fun `fee_rate` 12,500 (1.25%), so a letsbonk curve costs **1.50% per side**;
  - Raydium's own platform: 0.75% + 0.05% creator, so **1.05% per side**;
  - many others: 1.0% + 0 to 0.5% creator.
- CPMM configs ([cpmm-config](https://api-v3.raydium.io/main/cpmm-config)): index 0 `tradeFeeRate` 2,500 (0.25%) + `creatorFeeRate` 500 (0.05%). Other tiers: 0.30%, 0.5%, 1%, 1.5%, 2%, 2.5%… The creator fee is **additional** to the trade fee ([CPMM fees](https://docs.raydium.io/products/cpmm/fees.md)).

**Meteora (Doc)**

- DBC: minimum base fee 0.25%; total fee capped at **99%**. Anti-sniper fee schedulers decay over time, and a rate limiter can raise fees with buy size for up to 12 h ([DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview.md), [rate limiter](https://docs.meteora.ag/core-products/dbc/fees/rate-limiter.md)).
- DAMM v2: min 1 bps, max 99% (v0 pools 50%) ([DAMM v2 fees](https://docs.meteora.ag/core-products/damm-v2/fees/overview.md)).
- **Implication: read live pool fee state before any Meteora buy.** A DBC pool at launch can legally charge tens of percent.

### 3.3 Local quote math (exact integer forms from official SDKs)

All quantities are u64/u128 integers; `fee(x,bps) = ceil(x·bps/10_000)`.

**pump.fun bonding curve** (`@pump-fun/pump-sdk` `bondingCurve.ts`; reserves from the `BondingCurve` PDA `["bonding-curve", mint]`; initial virtual reserves 30 SOL / 1,073,000,000 tokens (6 decimals), real tokens 793,100,000):

- Buy with SOL input `A` (lamports, total including fees):
  - `totalFeeBps = protocolBps + creatorBps` (from the FeeConfig tier);
  - `netIn = floor((A − 1) · 10_000 / (10_000 + totalFeeBps))`;
  - `tokensOut = floor(netIn · vToken / (vSol + netIn))`, capped at `realTokenReserves`.
- Buy exact tokens `T`:
  - `cost = floor(T · vSol / (vToken − T)) + 1`;
  - `maxSolCost = cost + fee(cost, protocol) + fee(cost, creator)`.
- Sell `T` tokens:
  - `gross = floor(T · vSol / (vToken + T))`;
  - `net = gross − fee(gross, protocol) − fee(gross, creator)`.
- Market cap for the fee tier: `vSol · supply / vToken` (mayhem coins use their real supply; others assume 1B).
- `virtual_quote_reserves` was renamed from `virtual_sol_reserves` ([README](https://github.com/pump-fun/pump-public-docs/blob/main/README.md)).

**PumpSwap** (`@pump-fun/pump-swap-sdk` `sell.ts`/`buy.ts`):

- `effectiveQuote = poolQuoteVault.amount + Pool.virtual_quote_reserves`.
- `virtual_quote_reserves` is a **signed i128 and can be negative from 2026-09-30**. Decode it as signed; the program guarantees the sum is ≥ 0 and fits in u64 ([negative virtual reserves](https://github.com/pump-fun/pump-public-docs/blob/main/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md)).
- Use vault + `virtual_quote_reserves`; no per-pool calibration. The event's `pool_quote_token_reserves` is the vault alone, and pricing on it misprices fills by a median 4.5% (p95 30%) on 2026-10-03 data. Vault + virtual replays real swaps exactly (BT-1, 353 swaps; RES-2 `docs/research/copytrading.md`).
- Sell base `b`:
  - `quoteOut = floor(effectiveQuote · b / (baseReserve + b))`;
  - `final = quoteOut − fee(lp) − fee(protocol) − fee(creator)`, where the creator fee is 0 if `coin_creator` is the default key.
- Buy: the inverse with `ceilDiv`, fees added on the quote input.
- `buy`/`sell` take exact base amounts plus `maxQuoteIn`/`minQuoteOut`. `buy_exact_quote_in` also exists.

**Raydium CPMM**: constant product with fees on the input side by default; rates are per 1e6 ([CPMM math](https://docs.raydium.io/products/cpmm/math.md)).

**Latency and fee advantage of going direct**:
- **Fee**: saves Jupiter's platform fee (10 bps observed, 50 bps documented for new tokens) per side.
- **Latency**: removes one HTTP round trip per quote and per send. Jupiter's own server-side `totalTime` was 108 to 148 ms in the live calls, before network RTT.
- **Rate limit**: removes the 1 RPS ceiling, because exit monitoring can re-price every account update for free.
- **Control**: exact `minOut` instead of 20% RTSE, the bot's own tip and priority policy, and `closeAccount` in the same sell transaction.

Cost of going direct:
- Venue-specific account layouts change often. Pump made breaking changes on 2025-09-01, 2026-04-28 (fee recipient added) and 2026-09-30 (signed reserves).
- So pin the IDL version, run a daily canary simulation, and keep Jupiter `/build` (no platform fee) as the fallback adapter.

### 3.4 Pump account requirements that affect cost and failure

From [BUY.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md) and [Fee recipients](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_RECIPIENTS.md):
- `buy_v2`/`sell_v2` need `fee_recipient` (8 normal, or 8 reserved for mayhem coins) **and** `buyback_fee_recipient` (8). Pick randomly to spread write locks.
- `user_volume_accumulator` (`["user_volume_accumulator", user]`) is mandatory and init-if-needed, **paid by the user**.
- `sharing_config` PDA is mandatory.
- `bonding_curve` may need a small rent top-up to reach 115 bytes on old curves; `creator_vault` may need a top-up to rent-exempt.
- Pump FAQ: CU usage varies with PDA bump search and log sizes, and "it is recommended to use a static big enough CU limit like `100_000`" rather than simulating on the hot path ([FAQ](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FAQ.md)). The live sample (CU p90 about 144k) suggests 100k is too tight for bot-wrapped transactions. Calibrate for the bot's own instruction set.

---

## 4. Transaction landing

### 4.1 Fee mechanics (Doc)

From [Fee structure](https://solana.com/docs/core/fees/fee-structure):
- `total = 5,000 lamports × signatures + ceil(CU_price µL × CU_limit / 1e6)`.
- Base fee: 50% burned. Priority fee: 100% to the leader (SIMD-0096).
- **Charged even if the transaction fails.** Priority is billed on the **requested** CU limit, not CU used.
- Default limit: 200,000 CU per non-builtin instruction, max 1.4M.
- Scheduler priority = `reward·1e6/(cost+1)`, so a tight CU limit also raises priority.
- **v1 transaction format is active on mainnet** ([versioned transactions](https://solana.com/docs/core/transactions/versioned-transactions.md)):
  - 4,096-byte size, 64 inline accounts, **no ALTs**;
  - the priority fee is set as an absolute lamport total in the message config;
  - readers must opt in, or v1 transactions fail to parse.

### 4.2 Priority-fee estimation

- `getRecentPrioritizationFees` (standard RPC) returns per-slot **minimums** among transactions that lock the given writable accounts. Live on 2026-10-03:
  - global and pump-program inputs return 0 at all percentiles;
  - a pump fee-recipient account: p50 1,535 µL/CU, p90 23,541.
  - This is a weak signal.
- Helius `getPriorityFeeEstimate` costs 1 credit and accepts account keys or a serialized transaction ([Helius credits](https://www.helius.dev/docs/billing/credits.md)).
- Recommended policy: estimate from the bot's own transaction (writable accounts = curve/pool), clamp to a configured ceiling, and escalate only on exits.
- **Sample of what successful pump trades paid** (n=118 successful of 300, 2026-10-03):

| Program | Failed share | Priority fee paid, successful trades | CU consumed | Jito tip present |
|---|---|---|---|---|
| pump curve | 51% (153/300) | p25 10,000, **p50 13,334**, p75 100,000, p90 280,645, mean 108,865 lamports | p50 97,758, p90 144,120 | 15/118 |
| PumpSwap | 34% (102/300) | p50 **0**, p75 151, p90 9,601 lamports | p50 95,999, p90 126,266 | 3/136 |

Failure detail:
- On pump, 142 of 153 failures were `{"InstructionError":[1,{"Custom":13}]}`. These are cheap failures (median 4.3k CU, 233 lamports priority) from third-party bot programs, not the pump program. Only 7 were pump `6042 BuySlippageBelowMinTokensOut`.
- PumpSwap failures were mostly slippage (`6040 BuySlippageBelowMinBaseAmountOut` ×19) and wrapper errors.
- Sample script: `scratchpad/kitprobe/sample2.py`; public RPC `getSignaturesForAddress` + `getTransaction`.

### 4.3 Senders compared (cost per transaction at $119.37/SOL)

| Path | Minimum extra cost | Credits | Notes | Verdict for $2 to $5 |
|---|---|---|---|---|
| Own RPC `sendTransaction` (Helius free) | 0 | 1 | Unstaked on free plan; paid plans route through staked connections when you pay ≥ Helius "recommended" fee ([optimizing](https://www.helius.dev/docs/sending-transactions/optimizing-transactions.md)) | OK for paper and canary |
| **Helius Sender SWQoS-only** `…/fast?swqos_only=true` | **tip ≥ 5,000 lamports ($0.0006)** + must include CU price ix | **0** | Free plan; default 50 TPS; regional HTTP endpoints `slc/ewr/lon/fra/ams/sg/tyo-sender.helius-rpc.com/fast`, warm via `/ping` ([Sender](https://www.helius.dev/docs/sending-transactions/sender.md), [SWQoS-only](https://www.helius.dev/docs/sending-transactions/sender-swqos-only.md)) | **Best value** |
| Helius Sender Max | tip ≥ 1,000,000 lamports ($0.119) | 0 | All pathways (Helius, Jito, Harmonic, Rakurai…) + priority buffer. Tips between 0.000005 and 0.001 go best-effort through fewer pathways | Too expensive |
| Jupiter `tx.jup.ag` | tip ≥ 1,000,000 lamports ($0.119), flat | key | Send-only; SWQoS+Jito | Too expensive |
| Jupiter `/execute` | none beyond fees in tx (`prioritizationFeeLamports` observed 2,450 to 10,642 for buys) | 0 | Managed landing, no control of fee/tip unless `priorityFeeLamports`/`jitoTipLamports` set | OK as fallback |
| Jito `sendTransaction`/`sendBundle` | tip ≥ 1,000 lamports; live p50 ≈ 3,948 | n/a | 1 req/s/IP/region default; bundles ≤5 tx, atomic ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)) | Optional; only Jito leaders |

Helius tip accounts for Sender:
`4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE, D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ, 9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta, 5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn, 2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD, 2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ, wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF, 3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT, 4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey, 4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or`
These were extracted from the doc page on 2026-10-03; re-read them at startup and allowlist them in the signer.

Jito tip accounts (live `getTipAccounts`, 2026-10-03):
`96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5, HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe, Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY, ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49, DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh, ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt, DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL, 3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT`.

Live Jito tip floor ([tip_floor](https://bundles.jito.wtf/api/v1/bundles/tip_floor), 2026-10-03T11:48:20Z):

| Percentile | Tip |
|---|---|
| p25 | 1,149 lamports |
| p50 | 3,948 lamports |
| p75 | 10,229 lamports |
| p95 | 152,644 lamports |
| p99 | 1,000,000 lamports |
| EMA p50 | 6,977 lamports |

**Uncle bandit / unbundling** (Jito doc): bundles that land on uncled blocks can be rebroadcast without atomicity. Put the tip in the same transaction as the swap and use pre/post account checks. Never build a two-transaction "buy then tip" bundle.

**SWQoS**: stake-weighted QoS reserves leader TPU capacity for connections from staked validators. An unstaked bot reaches it only through a provider (Helius staked connections on paid plans, Sender, `tx.jup.ag` with `swqosOnly`). Free-tier answer: Sender SWQoS-only.

### 4.4 Confirmation, expiry, idempotency (Doc)

From [Confirmation & Expiration](https://solana.com/developers/guides/advanced/confirmation) and [Retrying](https://solana.com/developers/guides/advanced/retry):
- A blockhash is valid while it is within the last **151** stored blockhashes (max processing age 150). That is about 60 to 90 s, and "as quickly as one minute".
- Fetch the blockhash at `confirmed`, with `preflightCommitment` set to the same level. About 5% of `processed` blocks are never finalized, and using `finalized` costs about 13 s of validity.
- Expiry check: poll `getBlockHeight` at `confirmed`. Once it exceeds `lastValidBlockHeight`, the transaction can never land, and only then may a replacement be signed.
- Identical signed bytes produce the same signature, which the runtime processes **at most once**. So rebroadcast the same bytes every 1 to 2 s with `maxRetries: 0` until confirmed or expired; this is idempotent.
- A re-signed transaction with a new blockhash is a **new** trade, and both can land. The brief is correct; keep it.
- Durable nonces remove expiry. Avoid them for trading: a nonce transaction can land long after the decision.

Confirmation strategy for the bot:
1. Persist the signed bytes, signature and `lastValidBlockHeight` before the first send.
2. Send to Sender SWQoS-only, plus a parallel send to own RPC for path diversity. The same bytes are safe to send to several paths.
3. Run `signatureSubscribe` (WebSocket) and `getSignatureStatuses` polling (1 credit) every 400 to 800 ms.
4. On `confirmed`, reconcile the actual token and SOL balance deltas. Do not trust quoted output.
5. On expiry, make a final `getSignatureStatuses` with `searchTransactionHistory: true`, then mark it failed-expired.

Helius notes:
- Sender docs recommend `skipPreflight: true` and `maxRetries: 0`.
- WebSocket on Helius is metered at **2 credits per 0.1 MB** on all plans, so a 1M-credit free month is about 50 GB of stream. Subscribe to specific accounts, not program-wide logs.

---

## 5. MEV and sandwich risk

**Data, primary dashboard** ([sandwiched.me](https://sandwiched.me), embedded `sandwichSummary` with `period: "30D"`, `fetchedAt` 2026-10-03T11:51:12Z):

| Metric | Value |
|---|---|
| Sandwiches (30 days) | 137,968 |
| SOL extracted | 5,768.98 SOL (~$689k) |
| Attacker cost | 139.59 SOL |
| Victims | 62,461 |
| Attackers | 626 |
| Mean extraction | ~0.042 SOL per sandwich; ~0.092 SOL per victim |

By program:

| Program | Sandwiches | Revenue | Mean per sandwich |
|---|---|---|---|
| pump bonding curve | 18,469 | 2,118 SOL | ~0.115 SOL |
| PumpSwap | ~42,880 | ~1,094 SOL | |
| Meteora DAMM v2 | ~11,471 | ~204 SOL | |

The worst validator by sandwich rate showed sandwiches in 16% of its 244 blocks.

**History**:
- Helius report: one program (`vpeNALD89BZ4KxNUFjdLmFXBCwtyqBDQ85ouNoax38b`) made 1.55M sandwich attempts in 30 days (2024-12-07 to 2025-01-05), 88.9% successful, 65,880 SOL, mean 0.0425 SOL. 16 of the top 20 sandwiched tokens were pump.fun coins ([Helius MEV report](https://www.helius.dev/blog/solana-mev-report), Doc/analysis, 2025).
- Jito shut its public mempool in March 2024 (same source).
- "93% wide sandwiches" (front-run and back-run in different leaders' blocks): Secondary (Accelerate 2025 talk summary, [solanacompass](https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev)).
- May 2026 figure "77,188 sandwiches / 10,752 SOL / 203 attackers in 30 days": **Secondary/unverified** (an X post relayed by [blockchain.news](https://blockchain.news/flashnews/Solana%20MEV), 2026-05-19).

**Economics against this bot (own calculation, constant product on pump curve, attacker pays 1.25% per leg):**

To push price by `s`, an attacker must buy `Δ = V·(√(1+s) − 1)` SOL. Victim loss is at most `s·q`.

| Slippage s | V (virtual SOL) | Front-run Δ | Attacker's pump fees | Max extractable from $2 | From $5 |
|---|---|---|---|---|---|
| 3% | 30 | 0.447 SOL | $1.33 | $0.06 | $0.15 |
| 10% | 30 | 1.464 SOL | $4.37 | $0.20 | $0.50 |
| 20% | 30 | 2.863 SOL | $8.54 | $0.40 | $1.00 |

So a single $2 to $5 victim is not worth sandwiching on pump venues. The risk returns when several victims are batched into one sandwich, which wide sandwiches do. It also returns on low-fee pools (Raydium CPMM 0.30%, DAMM v2 from 1 bps), where the attacker's cost is 4 to 40 times lower.

**Protections and their cost**:

| Protection | Cost | Coverage |
|---|---|---|
| Tight `minOut` from local quote: entry 2 to 3%; exit escalation ladder with a hard emergency cap | Free | Bounds loss on every path. Cost is more `6040/6042` slippage failures, about 25k lamports each |
| `jitodontfront111111111111111111111111111111` as a read-only account in the swap instruction | Free | Jito leaders only ([Jito doc](https://docs.jito.wtf/lowlatencytxnsend/)) |
| Helius `mev-protect=true` query parameter | Free | Avoids validators statistically linked to sandwiching; works with Sender SWQoS-only ([MEV Protect](https://www.helius.dev/docs/sending-transactions/mev-protect.md)) |
| Jupiter `/order` | Platform fee | No explicit protection claim in current docs (2.7) |
| RFQ (JupiterZ) | Platform fee | Usually not available for fresh memecoins |

---

## 6. Rent and accounts

| Account | Size (bytes) | Rent now (5,080 L/byte) | USD | Recoverable? |
|---|---|---|---|---|
| Rent formula | `(128 + size) × lamports_per_byte` ([SIMD-0437 page](https://solana.com/upgrades/reduced-rent)); Rent sysvar `lamportsPerByte: "5080"` (Chain) | | | |
| SPL token ATA (legacy Tokenkeg mint, e.g. older pump coins, WSOL) | 165 | **1,488,440** | $0.178 | Yes, `closeAccount` at zero balance |
| Token-2022 ATA, pump `create_v2` coin (extension `immutableOwner`) | **170** (Chain: 5 live pump/other mints, `getAccountInfo`) | **1,513,840** | $0.181 | Yes, at zero balance with no withheld transfer fees |
| Token-2022 ATA with TransferFeeAmount etc. | 170 + extensions | `getMinimumBalanceForRentExemption` | | Withheld fees block close until harvested |
| WSOL ATA (PumpSwap, CPMM quote side) | 165 | 1,488,440 | $0.178 | Create, sync and close inside the same transaction (SDK does `createAssociatedTokenAccountIdempotent` + `syncNative` + `closeAccount`). Net 0, but the balance must be available |
| pump `user_volume_accumulator` | 137 (Chain) | **1,346,200** | $0.161 | One-time per wallet; `close_user_volume_accumulator` exists |
| PumpSwap `user_volume_accumulator` | 137 (Chain) | **1,346,200** | $0.161 | One-time per wallet; separate from the pump one |
| Older accounts | | 1,844,400 | | Created under the old rate. SIMD-0437 frees the excess only via program-specific reclaim (e.g. Raydium `CollectExcessLamports`) |

- Pump mint accounts are Token-2022 with `metadataPointer` + `tokenMetadata`, 362 to 424 bytes; paid by the creator, not the trader.
- Mint extensions affect only the **token** account size you pay for.

**Schedule**:

| Lamports per byte | Status | 165-byte ATA |
|---|---|---|
| 6,960 | Original | 2,039,280 |
| 6,333 | Live 2026-09-03 | |
| **5,080** | **Live epoch 1033, 2026-09-11** | 1,488,440 |
| 2,575 | Expected with Agave 4.4, November 2026 | 754,475 |
| 1,322 | Expected with Agave 4.4, November 2026 | 387,346 |
| 696 | Expected with Agave 4.4, November 2026 | 203,928 ($0.024) |

Sources: [Solana upgrades: reduced rent](https://solana.com/upgrades/reduced-rent) (Doc, "Partially Activated") and [Solana Compass](https://solanacompass.com/news/simd-0437-step-2-goes-live-on-solana-mainnet-rent-drops-to-5080-lamports-per-byte) (Secondary, 2026-09-12). Steps 3 to 5 have no fixed calendar ("state growth safely checks out").

**Rules**:
- Close the token ATA in the **same transaction** as the full-balance sell (`sell(amount = full balance)` then `closeAccount`). This avoids a second base fee and leaves no dust.
- If any dust remains, a `burn` followed by `close` recovers the rent. Track any stranded deposit as a separate ledger line.
- For the bankroll: one open position locks about $0.18 of ATA rent. First-ever trades also lock about $0.32 in two volume accumulators (one-time). The SOL reserve must cover ATA + WSOL float (about 0.003 SOL) + fees for several exit retries.

---

## 7. TypeScript libraries and supply chain

| Package | Version / date | Status |
|---|---|---|
| `@solana/kit` | 8.4.0 (2026-09-28) | Maintained. Tree-shakable; built-in base58/base64 codecs, transaction confirmation, `signTransaction`/`partiallySignTransaction` |
| `@solana/web3.js` 1.x | 1.99.0 (2026-09-08) | **Maintenance only**: "Version 1.x is no longer actively maintained and receives critical fixes only" (v3 README) |
| `@solana/web3.js` 3.0.0 | 2026-10-01, dist-tag `next` (`latest` still 1.99.0) | Class API rebuilt on Kit (depends on `@solana/kit ^8.3.0`). Too new to adopt for money paths |
| `@solana-program/token` / `token-2022` / `system` / `compute-budget` | 0.17.0 / 0.19.0 / 0.15.0 / 0.19.0 (2026-09-21) | Kit-native generated clients |
| `@pump-fun/pump-sdk` / `pump-swap-sdk` | 2.0.0 (2026-09-13) / 1.20.0 (2026-09-10) | Depend on web3.js v1, `@coral-xyz/anchor`, `bn.js`, `@solana/spl-token` and `@pump-fun/agent-payments-sdk` 1.0.7 |
| `codama`, `@codama/nodes-from-anchor`, `@codama/renderers-js` | 1.11.0, 1.5.6, 2.5.0 (2026-09-15) | Generate Kit-native clients from Anchor IDLs |
| `jito-ts` | 4.2.1 (last modified 2025-09-10) | Unnecessary; Jito JSON-RPC is plain HTTP |

**Incidents**:
- **CVE-2024-54134** ([GHSA-jcxm-7wvp-g6p5](https://github.com/advisories/GHSA-jcxm-7wvp-g6p5)): `@solana/web3.js` 1.95.6 and 1.95.7, published 2024-12-03 between 15:20 and 20:25 UTC. The code stole private keys from apps that "handle private keys directly, like bots". Fixed in 1.95.8; the bad versions no longer appear in `npm view versions`.
- Later npm incidents relevant to Solana bots:
  - Sept 2025: hijack of `chalk`/`debug` and 16 other packages with a wallet-address swapper ([Palo Alto Networks](https://www.paloaltonetworks.com/blog/cloud-security/npm-supply-chain-attack/)).
  - March 2026: typosquats `raydium-bs58`, `bs58-basic`, `base-x-64` that hook Base58 `decode()` to steal keys ([report](https://blog.rankiteo.com/npmsoleth1774427254-npm-solana-ethereum-cyber-attack-march-2026/), Secondary).

**Recommendation**:
- Kit + `@solana-program/*` only.
- Generate pump/PumpSwap instruction builders from the published IDLs (pinned commit) with Codama at dev time and commit the output. Use Kit's own base58 codec, never a separate `bs58`.
- Use exact version pins and a lockfile, `pnpm install --frozen-lockfile`, `ignore-scripts` for installs, and no runtime dependency on the pump SDKs (dev/test oracle only).
- Keep the signer in a separate process with a dependency set of 2 to 3 packages.
- Doc nit: Jupiter's Common Instructions page imports from `@solana-program/associated-token`, which **does not exist on npm** (404). The ATA helpers live in `@solana-program/token`.

---

## 8. Itemised round-trip cost model (entry + exit)

Assumptions:
- SOL $119.37.
- Sender SWQoS-only path: base 5,000 + priority 20,000 (between the sample p50 and p75) + tip 5,000 = **30,000 lamports ($0.0036) per transaction**.
- A failed attempt costs base + priority = **25,000 lamports ($0.0030)**; the tip transfer reverts with the transaction.
- Stressed exit: 5,000 + 150,000 + 5,000 = 160,000 lamports ($0.019).
- Impact uses the constant-product approximation `q/(V+q)` per side.
- Fees use the current on-chain tiers.

### $2 round trip (0.016755 SOL)

| Item | pump curve (fresh, V≈30 SOL) | PumpSwap (420 to 1,470 SOL tier, Q≈80 SOL) | Jupiter `/order` → pump curve (10 bps observed) | Jupiter `/order` (50 bps documented) |
|---|---|---|---|---|
| Venue fees (2 sides) | 2 × 1.25% = $0.0500 | 2 × 1.20% = $0.0480 | $0.0500 | $0.0500 |
| Jupiter platform fee | n/a | n/a | 2 × 0.10% = $0.0040 | 2 × 0.50% = $0.0200 |
| Price impact | ~0.11% = $0.0022 | ~0.04% = $0.0008 | $0.0022 | $0.0022 |
| Base + priority + tip (2 tx) | $0.0072 | $0.0072 | ~$0.0036 (Jupiter-chosen, ~15k lamports/tx est.) | ~$0.0036 |
| **Non-recoverable total** | **$0.0594 (2.97%)** | **$0.0560 (2.80%)** | **$0.060 (3.0%)** | **$0.076 (3.8%)** |
| ATA rent locked (recoverable on close) | $0.181 (Token-2022, 170 B) | $0.178 to $0.181 | $0.181 (+ Jupiter estimates 165 B) | same |
| WSOL float (in-tx, returned) | 0 (native SOL on curve) | $0.178 transient | handled by Jupiter | |
| One-time per wallet | pump UVA $0.161 | PumpSwap UVA $0.161 | as venue | |
| Each failed attempt | +$0.0030 | +$0.0030 | Jupiter decides fee; failed tx still pays | |
| Stressed exit (instead of normal) | +$0.0155 | +$0.0155 | n/a (`priorityFeeLamports` override) | |

Break-even gross move: about **+3.0%** on the pump curve, before slippage tolerance and before any failed attempts.

### $5 round trip (0.041887 SOL)

| Item | pump curve (V≈30) | PumpSwap 1.20% tier | Jupiter → pump (10 bps) | Jupiter (50 bps) |
|---|---|---|---|---|
| Venue fees | $0.1250 | $0.1200 | $0.1250 | $0.1250 |
| Jupiter fee | n/a | n/a | $0.0100 | $0.0500 |
| Impact | ~0.28% = $0.0139 | ~0.10% = $0.0052 | $0.0139 | $0.0139 |
| Network (2 tx) | $0.0072 | $0.0072 | ~$0.0036 | ~$0.0036 |
| **Non-recoverable total** | **$0.146 (2.92%)** | **$0.132 (2.65%)** | **$0.153 (3.05%)** | **$0.193 (3.85%)** |
| Rent / UVA / failure | as above | as above | as above | |

For comparison, a Raydium CPMM-graduated token (0.25% + 0.05% per side) costs about **$0.020 (1.0%)** for $2 and **$0.042 (0.85%)** for $5. The venue choice moves the break-even more than any landing choice.

**Paths to reject for this bankroll**: `tx.jup.ag` and Helius Sender Max. Their 0.001 SOL flat tip on each of 2 transactions adds **$0.239 (12% of $2; 4.8% of $5)**.

---

## 9. Brief claims checked

| Brief claim | Status | Evidence |
|---|---|---|
| Jupiter lists 50 bps platform fee for tokens <24 h old on Order & Execute | **Confirmed as documented**; **not observed** in any of 22 live keyless quotes on 5 pump.fun tokens all created on 2026-10-03 (ages 2 min to ~5 h; all returned feeBps 10) | [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute.md); Live API 2026-10-03 |
| Build path has no Jupiter platform fee | Confirmed | [Build](https://developers.jup.ag/docs/swap/build/index.md) |
| Base fee 5,000 lamports per signature | Confirmed (50% burned; priority fee 100% to leader) | [Fee structure](https://solana.com/docs/core/fees/fee-structure) |
| 165-byte token account commonly requires 0.00203928 SOL | **Outdated**: 0.00148844 SOL since 2026-09-11; pump Token-2022 ATA is 170 B = 0.00151384 | Chain `getMinimumBalanceForRentExemption`, Rent sysvar; [reduced-rent](https://solana.com/upgrades/reduced-rent) |
| Jupiter free key 1 RPS shared; `/execute` 50 RPS bucket; per organisation | Confirmed | [Rate limits](https://developers.jup.ag/docs/portal/rate-limits.md) |
| Helius free plan 1M credits, 10 RPS | Confirmed | [Helius plans](https://www.helius.dev/docs/billing/plans.md) |
| Trigger V2: Privy custodial vaults, $10 minimum, 20% default slippage stop-loss/buy-above | Confirmed (also beta; mandatory expiry; USD-price triggers) | [Trigger](https://developers.jup.ag/docs/trigger/index.md) |
| Recent-blockhash transactions expire by block height; RFQ routes have different expiry | Confirmed (`lastValidBlockHeight` vs `expireAt`) | [Confirmation](https://solana.com/developers/guides/advanced/confirmation), [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute.md) |
| Rebroadcasting same bytes differs from signing a replacement; replace only after expiry | Confirmed | same |
| Jito: tips add cost; bundles don't guarantee inclusion | Confirmed; minimum tip 1,000 lamports; unbundling risk on uncled blocks | [Jito](https://docs.jito.wtf/lowlatencytxnsend/) |
| "Two swaps can consume roughly 1% of notional before other costs" (Jupiter fee) | Correct for the Jupiter fee alone at 50 bps. **Misleading**: venue fees add 2.4 to 2.5% (pump/PumpSwap), so the realistic round trip is about 2.8 to 3.8% | Chain FeeConfig |
| Illustration "$0.02 fixed cost" | Plausible but high for network only ($0.007 for 2 tx on Sender SWQoS-only); rent float about $0.18 and first-trade accumulators about $0.32 are larger | §8 |

---

## 10. Recommendations

1. **Execution adapters**:
   - Primary: direct pump curve and PumpSwap adapters with local integer quoting, Kit plus Codama-generated builders, the on-chain FeeConfig read at startup and on change, and signed i128 `virtual_quote_reserves`.
   - Fallback: Jupiter `/build` (no platform fee) with an explicit `slippageBps` and clamped CU price.
   - Third: Jupiter `/order` only for venues without a direct adapter, with `slippageBps` overridden, `signatureFeePayer == taker` enforced, and `feeBps` read per quote.
2. **Landing**:
   - Helius Sender SWQoS-only with a 5,000-lamport tip and `mev-protect=true`, plus a parallel send of the same bytes to the RPC.
   - Persist bytes, signature and `lastValidBlockHeight` first.
   - Rebroadcast every 1 to 2 s until confirmed or block height passes `lastValidBlockHeight`.
   - Add `jitodontfront…` as a read-only account.
   - Reject any path with a fixed tip of 0.001 SOL or more.
3. **Fees**:
   - Priority-fee policy: entry fee cap of about 50k lamports total. Exit ladder: 20k → 60k → 150k → emergency cap (owner-set), each with its own slippage step.
   - Set the CU limit from offline calibration (p99 × 1.1) of the bot's own instruction set. Do not use 200k defaults or 1.4M.
4. **Venue-aware economics**: compute costs per quote. Pump/PumpSwap round trips need about +3% gross just to break even, while Raydium CPMM needs about +1%. Feed this into `v` and `F` in the brief's net-expectancy formula.
5. **Rent**:
   - Close the ATA in the sell transaction.
   - Budget about 0.005 SOL operations reserve for the first trade: ATA + 2 UVAs + WSOL float + 5 failed attempts.
   - Read rent live, because it drops again in about November 2026.
6. **Readers**: always pass `maxSupportedTransactionVersion: 1` because v1 transactions are live.
7. **Dependencies**: Kit only on the signing path. Pump SDKs only as a test oracle for quote math. No `bs58` package.
8. **Meteora DBC/DAMM v2 and LaunchLab**: allowlist only after reading live fee state. DBC anti-sniper fees can reach 99%, and LaunchLab platform fees vary from 0.1% to 1.25% or more per side.

## 11. Open questions (unverified)

- Why live `/order` quotes on minutes-old pump tokens showed 10 bps, not 50 bps. Is the condition based on mint age, Jupiter's verification, or direction?
- `/order` requestId TTL and whether `/execute` deduplicates resubmissions.
- Whether Jupiter Beam provides any sandwich protection today. Current docs are silent.
- Exact CU of a bot-built `buy_v2` + idempotent ATA create + tip + compute-budget transaction. Measure it in paper mode by simulation.
- Helius Sender SWQoS-only landing rate versus Sender Max for 5,000-lamport tips under congestion. Measure it during the canary.
- Date of SIMD-0437 steps 3 to 5 (only "Agave 4.4, November 2026" is published).
- How much of sandwiched.me's 62k victims are small trades, and whether batched wide sandwiches make $2 to $5 victims profitable.

## Fact-check

Independent re-check of the load-bearing findings against their sources (2026-10-03). Verdicts: confirmed, contradicted (with the correction), or unverifiable.

| Finding | Claim | Verdict | Note |
|---|---|---|---|
| F1 | Rent rate is now 5,080 lamports/byte (SIMD-0437 step 2, epoch 1033, 2026-09-11). A 165-byte SPL ATA costs 1,488,440 lamports (0.00148844 SOL). Steps 3 to 5 (2,5 | **confirmed** | Live mainnet RPC (2026-10-03): getMinimumBalanceForRentExemption(165)=1,488,440 lamports = (128+165) x 5,080. Block times show epoch 1033 began 2026-09-11 21:12 UTC (epoch 1028 began 2026-09-03 23:24 UTC, matching the page). Solana Compass reports SIMD-0437 step 2 live at epoch 1033 on Sept 11. Steps 3-5 are 2,575 / 1,322 / 696 and the page says 'Expected in Agave 4.4 (November 2026)'; solana.com/upgrades also lists Agave 4.4 as 'Expected November 2026'. Caveats: the cited solana.com page is stale and still lists step 2 as 'Live on Testnet'. Its own arithmetic for 165 bytes at 5,080 is also unreliable, since an LLM summary gave 1,483,840, while the correct product is 1,488,440. Solana Compass says there is no fixed schedule for steps 3-5, which activate only after state-growth checks. Treat the November date as an expectation, not a commitment. |
| F2 | pump.fun create_v2 coins are Token-2022. Trader ATAs are 170 bytes (immutableOwner extension), rent 1,513,840 lamports (0.00151384 SOL, $0.181). | **confirmed** | The cited doc (now the buy_v2 page) says create_v2 coins use Token-2022 (TokenzQd...). It does not state 170 bytes, immutableOwner or rent. On-chain check: Token-2022 trader ATAs from recent pump program trades have space 170 and lamports 1,513,840 (4 of 4 sampled). This equals 165+1+4 bytes (immutableOwner TLV) and (128+170) x 5,080. SOL is about $119.4 (CoinGecko/Jupiter), so 0.00151384 SOL is about $0.181. The dollar figure is price-dependent and moves with SOL. |
| F3 | pump.fun requires a user_volume_accumulator PDA (137 bytes) per wallet on buy, paid by the user. PumpSwap has a separate one of the same size. Each costs 1,346, | **confirmed** | Numbers are right but the cited doc is stale on cost and silent on two points. BUY.md and SELL.md say user_volume_accumulator is a 137-byte PDA 'initialized if needed, paid by user' with 'Rent ... 0.0018444 SOL'. That is the old rent rate (265 x 6,960 = 1,844,400), not today's. The README adds that the account is mandatory for all buys and sells. On-chain: 137-byte accounts owned by the Pump program (6EF8rrec...) hold 1,346,200 lamports, which equals 265 x 5,080. 137-byte accounts owned by PumpSwap (pAMMBay6...) also exist, so it is a separate account of the same size. Both decoded with the UserVolumeAccumulator discriminator from the IDL. Older accounts hold what was paid at the time (1,844,400 or 1,678,245), so the refund on close differs. @pump-fun/pump-sdk 2.0.0 IDLs for both programs contain close_user_volume_accumulator (accounts: user signer, user_volume_accumulator, event_authority, program). The cited doc does not mention PumpSwap's separate accumulator or the close instruction. Nuance: the PDA is re-created and re-paid on the next buy, and closing forfeits any accrued volume-incentive state. |
| F4 | pump bonding curve fee is 95 bps protocol + 30 bps creator = 125 bps per side. PumpSwap canonical pools charge 125 bps below 420 SOL market cap, 120 bps from 42 | **confirmed** | The cited FEE_PROGRAM_README only contains logic code and an image (fees.png). The image shows bonding curve 0.95% protocol + 0.30% creator = 1.25%, PumpSwap canonical 0-420 SOL = 1.25%, 420-1,470 SOL = 1.20%, stepping down to 0.30% at 98,240 SOL and above. I verified the same on-chain by decoding the live fee_config accounts (owner pfeeUxB6...). Pump bonding-curve FeeConfig has one tier: protocol 95 + creator 30 = 125 bps. PumpSwap FeeConfig has 25 tiers: tier 0 is lp 2 + protocol 93 + creator 30 = 125, 420 SOL is 120, 1,470 SOL is 115, and 98,240 SOL is lp 20 + protocol 5 + creator 5 = 30. flat_fees for non-canonical pools are lp 25 + protocol 5 + creator 0 = 30 bps. The cited doc does not state the flat 30 bps; the on-chain value does. Total fee on canonical pools includes the 20 bps LP fee after tier 0. Note: the newer SDK adds exoticFlatFees and stableFeeTiers for non-SOL-quote pools, which do not affect SOL pairs. |
| F7 | Jupiter limits: keyless 0.5 RPS, free key 1 RPS, Developer $25/month 10 RPS, Launch $100 50 RPS, Pro $500 150 RPS. /swap/v2/execute has a separate bucket (keyle | **confirmed** | rate-limits.md: Keyless 0.5 RPS (30/min), Free 1 (60), Developer 10 (600), Launch 50 (3,000), Pro 150 (9,000). The limiter is a 60-second sliding window. The limit is per organisation, not per API key. Swap, Price and Token requests share one bucket. /swap/v2/execute has its own bucket: Keyless 20, Free 50, Paid 100 RPS. The prices ($25 / $100 / $500 per month) are not on this page. They are on developers.jup.ag/docs/portal/plans.md: Developer $25, Launch $100, Pro $500 (annual $250 / $1,000 / $5,000). Execute calls cost 0 credits. |
| F8 | tx.jup.ag needs an API key and a minimum 0.001 SOL tip to one of 16 tip accounts; 'tipping more does not improve landing'. Helius Sender Max has the same 0.001  | **confirmed** | The Jupiter page says tx.jup.ag requires a Jupiter API key in the x-api-key header. It requires a minimum 1,000,000 lamports (0.001 SOL) to one of the 16 tip receiver accounts, and without it the tx is rejected. It says 'The Jupiter tip is flat: tipping more does not improve landing.' The Helius Sender Max 0.001 SOL minimum is not on the Jupiter page. It is confirmed on Helius's sender.md and sender-max docs ('Sender Max now uses a 0.001 SOL minimum tip'). Extra: tx.jup.ag is send-only (no blockhash, simulate or confirmation queries). swqosOnly=false routes via SWQoS + Jito; true is SWQoS only. Preflight and maxRetries are rejected (-1015). |
| F9 | Helius Sender SWQoS-only (?swqos_only=true) needs a tip of at least 0.000005 SOL plus a setComputeUnitPrice instruction. It uses 0 credits, is available on the  | **confirmed** | sender-swqos-only.md: minimum tip 0.000005 SOL. The tx must contain both the tip transfer and a ComputeBudget setComputeUnitPrice instruction, or it is rejected. No API credits; available on all plans. Seven regional endpoints: slc, ewr, lon, fra, ams, sg, tyo. mev-protect=true can be added with swqos_only. The 50 TPS default is not on the swqos-only page. It is on the parent Sender page (sender.md: '50 TPS (Default)', available on every plan including free). Nuance: tips between 0.000005 and 0.001 SOL are accepted but stay on the single SWQoS path and do not enter the priority tip buffer. Sender Max needs 0.001 SOL. |
| F10 | Jito: minimum tip 1,000 lamports; bundles hold at most 5 transactions and are all-or-nothing; default 1 req/s per IP per region. Bundles can be unbundled on unc | **contradicted** | The static claims are confirmed by docs.jito.wtf. Minimum tip is 1000 lamports. Bundles hold at most 5 transactions, run sequentially and atomically (all-or-nothing). Default limit is 1 request per second per IP per region. Uncled blocks can unbundle bundles, and the docs advise putting the tip in the same transaction. A jitodontfront* account makes the block engine reject any bundle where that tx is not at index 0. Nuance: several jitodontfront txs may sit contiguously at the front if they share a signer. The 'live tip floor' numbers are wrong. The docs page example is from 2024-09-01 (p50 10,000, p99 10,007,999 lamports). The live bundles.jito.wtf/api/v1/bundles/tip_floor endpoint on 2026-10-03 gave two different readings. At 12:33:55Z: p25 1,142, p50 12,087, p75 18,401, p95 167,680, p99 195,616, EMA p50 10,762. At 12:35:24Z: p25 2,003, p50 10,000, p75 20,776, p95 547,554, p99 909,511, EMA p50 9,717. The claimed p50 3,948, p75 10,229, p95 152,644 and p99 1,000,000 match neither reading. The p95/p99 values swung 3x to 5x between samples a minute apart. Do not hardcode percentiles. Poll the endpoint or stream. |
| F11 | Solana fee = 5,000 lamports per signature (50% burned) + ceil(CU price × CU limit / 1e6) (100% to leader). It is charged on failure and billed on the requested  | **confirmed** | Fee page: total fee = base (5,000 lamports per signature, 50% burned) + priority fee. Priority fee = ceil(compute_unit_price x compute_unit_limit / 1,000,000), and 100% goes to the validator (SIMD-0096). It is charged whether the tx succeeds or fails. It is based on the requested CU limit, not actual usage. For v1, 'the priority fee is an absolute total in lamports set directly in the message config'. The cited fee page does not say v1 is live. solana.com/upgrades/larger-transaction-sizes does: the txv1 feature gate activated on mainnet at the start of epoch 1035 on 2026-09-15 (about 01:00 UTC), 'Live on Mainnet', max size 4,096 bytes (SIMD-0296 / SIMD-0385). The v1 format does not support address lookup tables (64 inline addresses) per SIMD-0385 and the Solana dev-skill reference. Practical caveats: v1 resource limits default to zero and must be set in the message config; ComputeBudget instructions are no-ops on v1; sizes over 1,232 bytes must be sent base64; legacy and v0 still work. |
| F12 | A blockhash is valid while within the last 151 blockhashes (about 60 to 90 s). Identical signed bytes are processed at most once. Expiry is detected when block  | **contradicted** | Correct: a blockhash is valid while within the most recent 151 blockhashes (max processing age 150). Expiry is detected by polling block height until it exceeds lastValidBlockHeight. Validators track processed transactions to prevent double processing, so identical signed bytes (same signature) are processed at most once. Contradicted: the time estimate. The page says 'about 60 to 90 seconds', based on 400-600 ms slots. Current mainnet slots are faster. solana.com/upgrades lists current mainnet slot time as 300 ms with a 200 ms target. I measured about 0.27 s/slot over the last 1,900 slots, and about 0.32 s/slot averaged from epoch 1033 to 1034. So 151 blocks is roughly 40-48 s now, and about 30 s at 200 ms slots. Design retries on block height, not wall-clock. The cited URL redirects to solana.com/developers/cookbook/transactions/confirmation. |
