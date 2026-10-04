# Dune Docs: Data Catalog

> Official documentation for building with Dune's data platform, query engine, and API.

## Data Catalog

- [Data Catalog](https://docs.dune.com/data-catalog/overview.md): Explore Dune's comprehensive blockchain data catalog — raw, decoded, and curated datasets across 100+ blockchains, accessible via the web app, API, and Datashare.
- [Data Trust & Reliability](https://docs.dune.com/data-catalog/data-quality.md): How Dune ensures complete, accurate, and reliable blockchain data through continuous automated verification across 100+ blockchains.
- [Data Freshness](https://docs.dune.com/data-catalog/data-freshness.md): Understand the frequency of updates for various data types on Dune.
- [Bring your Data](https://docs.dune.com/data-catalog/bring-your-own-data.md): Dune offers several ways to bring your data to the platform.
- [Data Catalog / EVM Networks (895 pages)](https://docs.dune.com/_llms/data-catalog/evm-networks.md): Documentation for Data Catalog / EVM Networks.

### Curated Data

- [Curated Data Overview](https://docs.dune.com/data-catalog/curated/overview.md): Pre-built, cross-chain datasets maintained by Dune — the fastest path from raw blockchain data to production analytics.

#### DEX Trades

- [DEX Data](https://docs.dune.com/data-catalog/curated/dex-trades/overview.md): Curated DEX trading data across multiple blockchain networks

##### EVM DEX

- [dex.trades](https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-trades.md): The `dex.trades` table captures detailed data on decentralized exchange (DEX) trades, recording all raw trade events across various protocols and blockchains.
- [dex_aggregator.trades](https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-aggregator-trades.md): The `dex_aggregator.trades` table captures data on actions taken on aggregators - recording all events across various aggregators and blockchains.
- [dex.sandwiched](https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-sandwiched.md): The `dex.sandwiched` table captures detailed data on the victim trades of sandwich attacks in decentralized exchanges (DEXs), recording transactions that have been sandwiched across various EVM networks.
- [dex.sandwiches](https://docs.dune.com/data-catalog/curated/dex-trades/evm/dex-sandwiches.md): The `dex.sandwiches` table captures detailed data on the outer trades of sandwich attacks in decentralized exchanges (DEXs), recording front-running and back-running trades across various EVM networks.

##### Solana DEX

- [Trading](https://docs.dune.com/data-catalog/curated/dex-trades/solana/overview.md): Analyzing trading activity across Solana's decentralized exchanges.
- [jupiter_solana.aggregator_swaps](https://docs.dune.com/data-catalog/curated/dex-trades/solana/jupiter-aggregator-trades.md): The `jupiter_solana.aggregator_swaps` table captures data on trades executed through the Jupiter aggregator on Solana.
- [dex_solana.trades](https://docs.dune.com/data-catalog/curated/dex-trades/solana/solana-dex-trades.md): The `dex_solana.trades` table captures detailed data on decentralized exchange (DEX) trades on the Solana blockchain, recording all raw trade events across various protocols.

#### Payments

- [Payments](https://docs.dune.com/data-catalog/curated/payments/overview.md): Curated datasets for exploring real onchain payment activity across card payments, agentic payments, and commerce flows.
- [Card Transactions](https://docs.dune.com/data-catalog/curated/payments/card-transactions.md): Unified crypto card activity across issuers, card programs, and chains — card spend, merchant settlement, and top-ups normalised into a shared schema.
- [Agentic Payments](https://docs.dune.com/data-catalog/curated/payments/agentic-payments.md): Machine-to-machine onchain payment activity across open HTTP 402 payment standards — x402 and MPP (onchain Tempo rails only).
- [Commerce Flows](https://docs.dune.com/data-catalog/curated/payments/commerce-flows.md): Classified stablecoin transfers for real commerce-related onchain activity — B2B, B2C, and C2B flows identified via protocol matches and behavioural heuristics across EVM chains, Tron, and Solana.

#### Token Transfers

- [Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/overview.md): Comprehensive token and asset tracking across multiple blockchain networks
- [Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/evm/token-transfers.md): Curated and enriched token transfer events across all EVM networks for fungible tokens.
- [Arc Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/arc/arc-token-transfers.md): Unified token transfer activity for native USDC and ERC-20 assets on Arc.
- [Solana Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/solana/solana-token-transfers.md): Token transfer events on the Solana blockchain.
- [Aptos Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/aptos/aptos-token-transfers.md): Curated and enriched fungible token transfer activity on the Aptos blockchain.
- [Stellar Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/stellar/stellar-token-transfers.md): Unified token transfer activity for native, issued, and contract-based assets on Stellar.
- [Sui Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/sui/sui-token-transfers.md): Curated and enriched fungible token transfer activity on the Sui blockchain.
- [XRPL Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/xrpl/xrpl-token-transfers.md): Unified token transfer activity for native XRP, issued currencies, and AMM-related token movement on XRP Ledger.
- [Tron Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/tron/tron-token-transfers.md): Curated and enriched fungible token transfer activity on the Tron blockchain.
- [Multichain Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/multichain/multichain-token-transfers.md): Unified fungible token transfer activity across EVM, Solana, Aptos, Sui, Stellar, Tron, and XRPL.

#### Stablecoins

- [Stablecoins](https://docs.dune.com/data-catalog/curated/stablecoins/overview.md): Curated stablecoin transfers and balances across EVM, Solana, Tron, and multichain views
- [Stablecoin Tokens (Multichain)](https://docs.dune.com/data-catalog/curated/stablecoins/stablecoins-multichain-tokens.md): Reference table of all tracked stablecoins across EVM, Solana, and Tron with token metadata.

##### Activity Enriched

- [Stablecoin Activity Enriched (EVM)](https://docs.dune.com/data-catalog/curated/stablecoins/activity-enriched/stablecoins-evm-activity-enriched.md): Transfer-level stablecoin activity classification across 39 supported EVM chains
- [Stablecoin Activity Enriched (Solana)](https://docs.dune.com/data-catalog/curated/stablecoins/activity-enriched/stablecoins-solana-activity-enriched.md): Transfer-level stablecoin activity classification on Solana
- [Stablecoin Activity Enriched (Tron)](https://docs.dune.com/data-catalog/curated/stablecoins/activity-enriched/stablecoins-tron-activity-enriched.md): Planned transfer-level stablecoin activity classification on Tron

##### Balances Enriched

- [Stablecoin Balances Enriched (EVM)](https://docs.dune.com/data-catalog/curated/stablecoins/balances-enriched/stablecoins-evm-balances-enriched.md): Daily stablecoin balances and circulating supply with address-type enrichment across 39 supported EVM chains.
- [Stablecoin Balances Enriched (Solana)](https://docs.dune.com/data-catalog/curated/stablecoins/balances-enriched/stablecoins-solana-balances-enriched.md): Daily stablecoin balances and circulating supply with address-type enrichment on Solana.
- [Stablecoin Balances Enriched (Tron)](https://docs.dune.com/data-catalog/curated/stablecoins/balances-enriched/stablecoins-tron-balances-enriched.md): Planned daily stablecoin balances and circulating supply with address-type enrichment on Tron.

##### Transfers

- [Stablecoin Transfers (EVM)](https://docs.dune.com/data-catalog/curated/stablecoins/transfers/stablecoins-evm-transfers.md): Stablecoin transfer events across 39 supported EVM chains
- [Stablecoin Transfers (Solana)](https://docs.dune.com/data-catalog/curated/stablecoins/transfers/stablecoins-solana-transfers.md): Stablecoin transfer events on Solana
- [Stablecoin Transfers (Tron)](https://docs.dune.com/data-catalog/curated/stablecoins/transfers/stablecoins-tron-transfers.md): Stablecoin transfer events on Tron
- [Stablecoin Transfers (Multichain)](https://docs.dune.com/data-catalog/curated/stablecoins/transfers/stablecoins-multichain-transfers.md): Unified stablecoin transfer events across EVM, Solana, and Tron in a single cross-chain view.

##### Balances

- [Stablecoin Balances (EVM)](https://docs.dune.com/data-catalog/curated/stablecoins/balances/stablecoins-evm-balances.md): Daily stablecoin balances per address across 39 supported EVM chains
- [Stablecoin Balances (Solana)](https://docs.dune.com/data-catalog/curated/stablecoins/balances/stablecoins-solana-balances.md): Daily stablecoin balances per wallet on Solana
- [Stablecoin Balances (Tron)](https://docs.dune.com/data-catalog/curated/stablecoins/balances/stablecoins-tron-balances.md): Daily stablecoin balances per wallet on Tron
- [Stablecoin Balances (Multichain)](https://docs.dune.com/data-catalog/curated/stablecoins/balances/stablecoins-multichain-balances.md): Normalized daily stablecoin balances across EVM, Solana, and Tron

#### Prices

- [Prices overview](https://docs.dune.com/data-catalog/curated/prices/overview.md): Token price data across multiple blockchains
- [Minute Prices](https://docs.dune.com/data-catalog/curated/prices/prices_minute.md): Minute-by-minute token price data across 70+ blockchains - hybrid approach combining centralized exchange and decentralized exchange data for comprehensive coverage
- [Hourly Prices](https://docs.dune.com/data-catalog/curated/prices/prices_hour.md): Hourly token price data across 70+ blockchains - hybrid approach combining centralized exchange and decentralized exchange data for comprehensive coverage
- [Daily Prices](https://docs.dune.com/data-catalog/curated/prices/prices_day.md): Daily token price data across 70+ blockchains - hybrid approach combining centralized exchange and decentralized exchange data for comprehensive coverage
- [USD Prices (Legacy)](https://docs.dune.com/data-catalog/curated/prices/prices_usd.md): Legacy price tables with limited token coverage
- [Latest Prices](https://docs.dune.com/data-catalog/curated/prices/prices_latest.md): Most recent price data for tokens across all supported blockchains

#### Token Metadata

- [Token Metadata](https://docs.dune.com/data-catalog/curated/token-metadata/overview.md): Comprehensive token metadata across blockchain networks

##### EVM

- [ERC20 Token Metadata](https://docs.dune.com/data-catalog/curated/token-metadata/evm/erc20-metadata.md): Metadata like symbol, name, decimals, and contract address for ERC20 tokens across EVM networks.

##### Solana

- [Token Metadata](https://docs.dune.com/data-catalog/curated/token-metadata/solana/token-metadata.md): Metadata for fungible tokens on the Solana blockchain.
- [Token Accounts](https://docs.dune.com/data-catalog/curated/token-metadata/solana/token-accounts.md): Information about token accounts on the Solana blockchain.

#### Balances

- [Balances](https://docs.dune.com/data-catalog/curated/balances/overview.md): Token balances for fungible tokens on EVM networks and Solana
- [EVM Latest Balances](https://docs.dune.com/data-catalog/curated/balances/evm-latest.md): Most recent balance per address and token on EVM networks.
- [EVM Daily Balance Updates](https://docs.dune.com/data-catalog/curated/balances/evm-daily-updates.md): Sparse validity-interval table for historical fungible token balances on EVM networks.
- [EVM Balance Updates](https://docs.dune.com/data-catalog/curated/balances/evm-updates.md): Per-block balance changes for fungible tokens on EVM networks.
- [solana_utils.latest_balances](https://docs.dune.com/data-catalog/curated/balances/solana-latest-balances.md): Current SOL and SPL token balances for every address on Solana.
- [solana_utils.daily_balances](https://docs.dune.com/data-catalog/curated/balances/solana-daily-balances.md): Historical daily SOL and SPL token balances for every address on Solana.

#### Labels

- [Labels Data](https://docs.dune.com/data-catalog/curated/labels/overview.md): Labels provide valuable context and clarity to blockchain addresses, enhancing the readability and understanding of blockchain transaction data.
- [labels.addresses](https://docs.dune.com/data-catalog/curated/labels/address-labels.md): Comprehensive address labeling and attribution data — maps blockchain addresses to known entities, categories, and usage metrics across all supported chains
- [labels.ens](https://docs.dune.com/data-catalog/curated/labels/ens-labels.md): Ethereum Name Service (ENS) domain resolution data — links human-readable .eth names to blockchain addresses for identity verification and aggregation
- [labels.owner_addresses](https://docs.dune.com/data-catalog/curated/labels/owner-addresses.md): Owner-to-address mapping data — associates blockchain addresses with known entities for tracking ownership, contract deployments, and operational scope
- [labels.owner_details](https://docs.dune.com/data-catalog/curated/labels/owner-details.md): Entity profile data — operational details, categories, social presence, and technical profiles for known blockchain entities
- [safe.safes_all](https://docs.dune.com/data-catalog/curated/labels/safe-safes-all.md): All Safe (formerly Gnosis Safe) multisig wallet addresses across supported chains, with creation version and creation time.

#### NFT Trades

- [NFT Data](https://docs.dune.com/data-catalog/curated/nft-trades/overview.md): Curated NFT market data across multiple blockchain networks

##### EVM NFT

- [nft.trades](https://docs.dune.com/data-catalog/curated/nft-trades/evm/nft-trades.md): NFT trade execution data across EVM chains — captures sales, bids, and listings across major marketplaces with pricing, buyer/seller details, and collection metadata
- [nft.mints](https://docs.dune.com/data-catalog/curated/nft-trades/evm/nft-mints.md): Dataset capturing NFT minting events across multiple blockchains, providing crucial insights into NFT creation and project launches.
- [nft.wash_trades](https://docs.dune.com/data-catalog/curated/nft-trades/evm/nft-wash-trades.md): Dataset for identifying and analyzing potential wash trading activities in NFT transactions across various marketplaces and blockchains
- [NFT Metadata](https://docs.dune.com/data-catalog/curated/nft-trades/evm/nft-metadata.md): Metadata for NFTs across EVM networks.
- [NFT Transfers](https://docs.dune.com/data-catalog/curated/nft-trades/evm/nft-transfers.md): NFT transfer events across EVM networks.

##### Solana NFT

- [Solana NFT Metadata](https://docs.dune.com/data-catalog/curated/nft-trades/solana/solana-nft-metadata.md): Metadata for non-fungible tokens (NFTs) on the Solana blockchain.
- [Solana NFT Transfers](https://docs.dune.com/data-catalog/curated/nft-trades/solana/solana-nft-transfers.md): NFT transfer events on the Solana blockchain.

#### Prediction Markets

- [Prediction Markets](https://docs.dune.com/data-catalog/curated/prediction-markets/overview.md): Curated prediction market datasets for Polymarket, Kalshi, and Hyperliquid HIP-4 on Dune
- [All Prediction Market Tables](https://docs.dune.com/data-catalog/curated/prediction-markets/all-tables-overview.md): Complete inventory of all prediction market tables available on Dune

##### Cross-venue

- [Cross-venue](https://docs.dune.com/data-catalog/curated/prediction-markets/prediction_markets/overview.md): Curated cross-venue prediction market dataset that unifies Polymarket and Kalshi onto a single schema.
- [prediction_markets.markets](https://docs.dune.com/data-catalog/curated/prediction-markets/prediction_markets/markets.md): Unified market dimension table across Polymarket and Kalshi, one row per binary market with normalized status, category, and resolution fields.
- [prediction_markets.trades](https://docs.dune.com/data-catalog/curated/prediction-markets/prediction_markets/trades.md): Cross-venue trade table, one row per taker fill with prices normalized to P(Yes) in [0, 1].
- [prediction_markets.ohlcv_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/prediction_markets/ohlcv_hourly.md): Cross-venue hourly OHLCV bars, one row per market-hour with Yes-side prices in probability space [0, 1], volume and trade counts.

##### Polymarket

- [Polymarket](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/overview.md): Curated Polymarket prediction market datasets on Dune
- [polymarket_polygon.market_trades](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/market_trades.md): Polymarket trade events — buy/sell orders with prices, amounts, sides, and trader addresses across the v1 and v2 exchanges.
- [polymarket_polygon.market_details](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/market_details.md): Polymarket market metadata — questions, categories, lifecycle status, resolution, and outcome tokens from on-chain and API sources.
- [polymarket_polygon.market_actions](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/market_actions.md): Polymarket position lifecycle actions — splits, merges, redemptions, and neg-risk converts with market context.
- [polymarket_polygon.ohlcv_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/ohlcv_hourly.md): Polymarket hourly OHLCV candles per outcome token — markets and Combos — with VWAP, volume, forward-fill, and exact settlement pinning.
- [polymarket_polygon.positions](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/positions.md): Polymarket positions — daily outcome token balances by wallet, priced at the day's close and settled to the exact payout once decided.
- [polymarket_polygon.market_prices_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/market_prices_hourly.md): Polymarket hourly price snapshots — outcome token prices aggregated by hour.
- [polymarket_polygon.combo_trades](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/combo_trades.md): Polymarket Combos trade fills — multi-leg parlay trades on the v3 Exchange with joint-probability prices, fees, and maker/taker addresses.
- [polymarket_polygon.combo_details](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/combo_details.md): Polymarket Combos metadata — one row per combo outcome token with expanded legs, generated names, and resolution status.
- [polymarket_polygon.combo_actions](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/combo_actions.md): Polymarket Combos lifecycle actions — splits, merges, redemptions, and combinatorial structuring primitives on the v3 stack.
- [polymarket_polygon.combo_prices_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/combo_prices_hourly.md): Polymarket Combos hourly price snapshots — combo token joint probabilities aggregated by hour.
- [polymarket_polygon.users_address_lookup](https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/users_address_lookup.md): Mapping of Polymarket proxy wallets to owner addresses, with wallet type and initial funding details.

##### Kalshi

- [Kalshi](https://docs.dune.com/data-catalog/curated/prediction-markets/kalshi/overview.md): Curated Kalshi prediction market datasets on Dune
- [kalshi.market_details](https://docs.dune.com/data-catalog/curated/prediction-markets/kalshi/market_details.md): Kalshi market reference table — one row per market with lifecycle status, settlement, strike structure, resolution rules, parlay legs, and event and series metadata.
- [kalshi.market_trades](https://docs.dune.com/data-catalog/curated/prediction-markets/kalshi/market_trades.md): Kalshi per-fill trade table — one row per fill with P(Yes), USD notional, and estimated taker and maker fees.
- [kalshi.ohlcv_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/kalshi/ohlcv_hourly.md): Kalshi hourly OHLCV candles — per-market open/high/low/close/volume with VWAP and trade count.
- [kalshi.market_report](https://docs.dune.com/data-catalog/curated/prediction-markets/kalshi/market_report.md): Kalshi market metadata — event contract details, categories, settlement rules, and current status.
- [kalshi.trade_report](https://docs.dune.com/data-catalog/curated/prediction-markets/kalshi/trade_report.md): Kalshi trade data — individual trades on event contracts with price, size, and execution details.

##### Hyperliquid HIP-4

- [Hyperliquid HIP-4](https://docs.dune.com/data-catalog/curated/prediction-markets/hip4/overview.md): Curated datasets for Hyperliquid HIP-4 outcome (prediction) markets on Dune
- [hip4_hyperliquid.market_details](https://docs.dune.com/data-catalog/curated/prediction-markets/hip4/market_details.md): Hyperliquid HIP-4 market reference table — one row per binary market with its question, sides, event grouping, strike, expiry, and settlement.
- [hip4_hyperliquid.market_trades](https://docs.dune.com/data-catalog/curated/prediction-markets/hip4/market_trades.md): Hyperliquid HIP-4 fill ledger — one row per fill leg, covering both sides of every trade plus the split, merge, negate and settlement legs.
- [hip4_hyperliquid.ohlcv_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/hip4/ohlcv_hourly.md): Hyperliquid HIP-4 hourly OHLCV candles — one series per outcome token with VWAP, volume, and trade count.
- [hip4_hyperliquid.open_interest_hourly](https://docs.dune.com/data-catalog/curated/prediction-markets/hip4/open_interest_hourly.md): Hyperliquid HIP-4 hourly open interest and traded volume per market, from first activity to settlement.
- [hip4_hyperliquid.positions_daily](https://docs.dune.com/data-catalog/curated/prediction-markets/hip4/positions_daily.md): Hyperliquid HIP-4 daily positions — end-of-day balance and value per account and outcome token.

#### RWAs

- [Real-World Assets (RWAs)](https://docs.dune.com/data-catalog/curated/rwa/overview.md): Curated real-world asset datasets on Dune — tokenized treasuries, equities, and commodities, plus synthetic RWA perpetuals
- [All RWA Tables](https://docs.dune.com/data-catalog/curated/rwa/all-tables-overview.md): Complete inventory of RWA tables on Dune, with grain and refresh cadence.

##### Registry & classification

- [rwa_multichain.tokens](https://docs.dune.com/data-catalog/curated/rwa/registry/tokens.md): Canonical registry of tokenized real-world assets across 23 chains, with a normalized token_id for cross-chain joins.
- [rwa_multichain.tokens_reference_data](https://docs.dune.com/data-catalog/curated/rwa/registry/tokens-reference-data.md): Token-grain RWA reference data — token identity with attached product classification, legal, and operational metadata.
- [rwa_multichain.product_reference_data](https://docs.dune.com/data-catalog/curated/rwa/registry/product-reference-data.md): Product-grain RWA catalog — legal wrapper, issuer, eligibility, and a deployments array of chain identities.
- [rwa_hyperliquid.markets](https://docs.dune.com/data-catalog/curated/rwa/registry/hyperliquid-markets.md): Registry of Hyperliquid HIP-3 builder-deployed perpetual markets that reference a real-world asset, classified by asset class and asset type.

##### Holders & supply

- [rwa_multichain.balances](https://docs.dune.com/data-catalog/curated/rwa/holders-supply/balances.md): Daily holder balance snapshots for tokenized real-world assets across all tracked chains, with curated USD values.
- [rwa_multichain.balances_enriched](https://docs.dune.com/data-catalog/curated/rwa/holders-supply/balances-enriched.md): Daily RWA holder balances with entity attribution — CEX, lending protocol, custodian, and treasury labels.
- [rwa_multichain.supply](https://docs.dune.com/data-catalog/curated/rwa/holders-supply/supply.md): Daily outstanding supply per RWA token per chain, with curated USD-valued AUM.
- [rwa_multichain.supply_changes](https://docs.dune.com/data-catalog/curated/rwa/holders-supply/supply-changes.md): Event-level issuance, redemption, clawback, and interest-distribution activity, isolated from peer-to-peer transfers.

##### Valuation

- [rwa_multichain.prices](https://docs.dune.com/data-catalog/curated/rwa/valuation/prices.md): Canonical RWA prices normalized to USD per on-chain token unit, with validity windows and source-mechanism metadata.
- [rwa_multichain.nav](https://docs.dune.com/data-catalog/curated/rwa/valuation/nav.md): Verified onchain value update events for tokenized real-world assets, retaining NAV, price meaning, and unit basis.
- [rwa_multichain.nav_intervals](https://docs.dune.com/data-catalog/curated/rwa/valuation/nav-intervals.md): Validity windows derived from RWA value events, retaining price meaning and unit basis for point-in-time analysis.
- [rwa_multichain.unit_conversions](https://docs.dune.com/data-catalog/curated/rwa/valuation/unit-conversions.md): Time-versioned multipliers between token, display, and share units for RWA assets on Solana Token-2022.

##### Activity & trading

- [rwa_multichain.transfers](https://docs.dune.com/data-catalog/curated/rwa/activity/transfers.md): Transfer-level movement of tokenized real-world assets across 23 chains, normalized into one cross-chain schema.
- [rwa_multichain.trades](https://docs.dune.com/data-catalog/curated/rwa/activity/trades.md): Secondary-market trades of tokenized real-world assets — DEX swaps plus RWA-native venues including Ondo Global Markets, Swarm, and Dinari.
- [rwa_hyperliquid.perp_trades](https://docs.dune.com/data-catalog/curated/rwa/activity/perp-trades.md): Taker-leg fills on RWA perpetual markets, covering Hyperliquid HIP-3 builder-deployed perps, with per-fill trader leverage and margin mode.
- [rwa_hyperliquid.perp_metrics_hourly](https://docs.dune.com/data-catalog/curated/rwa/activity/perp-metrics-hourly.md): Hourly volume, open interest, funding rate, and taker activity per RWA perpetual market on Hyperliquid HIP-3.
- [rwa_hyperliquid.perp_metrics_daily](https://docs.dune.com/data-catalog/curated/rwa/activity/perp-metrics-daily.md): Daily volume, open interest, funding rate, and taker activity per RWA perpetual market on Hyperliquid HIP-3.
- [rwa_hyperliquid.perp_positions_hourly](https://docs.dune.com/data-catalog/curated/rwa/activity/perp-positions-hourly.md): Per-account position snapshots on RWA perpetual markets, taken at each hourly funding round, with signed size, USD notional, and the funding settled on the position.

#### Perpetuals Trading

- [Perpetuals Trading](https://docs.dune.com/data-catalog/curated/perpetuals/overview.md): Curated perpetual futures data on Dune — markets, fills, hourly and daily market metrics, positions, account rollups, oracle prices, and order book snapshots
- [All Perpetuals Trading Tables](https://docs.dune.com/data-catalog/curated/perpetuals/all-tables-overview.md): Complete inventory of all perpetual futures tables available on Dune

##### Hyperliquid

- [Hyperliquid Perpetuals](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/overview.md): Venue-wide curated tables for Hyperliquid perpetual futures, covering first-party and HIP-3 builder-deployed markets in one dataset
- [hyperliquid.perp_market_details](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-market-details.md): Market dimension for Hyperliquid perpetual futures, one row per market with current registry state, margin parameters, and curated classification.
- [hyperliquid.perp_trades](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-trades.md): One row per fill leg on Hyperliquid perpetual futures, covering both sides of every match across first-party and HIP-3 builder-deployed markets.
- [hyperliquid.perp_market_metrics_hourly](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-market-metrics-hourly.md): Hourly per-market candles, volume, fees, open interest and funding for every Hyperliquid perpetual market.
- [hyperliquid.perp_market_metrics_daily](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-market-metrics-daily.md): Daily per-market OHLCV, volume, fees, liquidations, open interest and funding for every Hyperliquid perpetual market, first-party and HIP-3.
- [hyperliquid.perp_positions_hourly](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-positions-hourly.md): Per-account Hyperliquid perp position snapshots taken at each hourly funding round, with signed size, USD notional and the funding settled on the position.
- [hyperliquid.perp_accounts_daily](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-accounts-daily.md): Daily per-account rollup of Hyperliquid perpetual trading, realised PnL, fees, funding, end-of-day exposure and collateral flows.
- [hyperliquid.perp_oracle_prices](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-oracle-prices.md): Minute-cadence oracle, mark and mid prices for Hyperliquid perpetual markets, with the signed mark-oracle spread in basis points.
- [hyperliquid.perp_orderbook_1m](https://docs.dune.com/data-catalog/curated/perpetuals/hyperliquid/perp-orderbook-1m.md): One-minute L2 order book snapshots for Hyperliquid perpetual markets, with resting bids and asks aggregated by price level, best price first.

#### Lending

- [Lending](https://docs.dune.com/data-catalog/curated/lending/overview.md): Curated DeFi lending datasets across 15+ EVM chains on Dune
- [lending.supply](https://docs.dune.com/data-catalog/curated/lending/supply.md): DeFi lending supply events — deposits and withdrawals across Aave, Compound, and other lending protocols.
- [lending.borrow](https://docs.dune.com/data-catalog/curated/lending/borrow.md): DeFi borrowing events — borrows and repayments across major lending protocols with rates and collateral context.
- [lending.flashloans](https://docs.dune.com/data-catalog/curated/lending/flashloans.md): Flash loan executions across DeFi protocols — borrowed amounts, fees, and initiator details.
- [lending.info](https://docs.dune.com/data-catalog/curated/lending/info.md): DeFi lending market snapshots — supply rates, borrow rates, utilization, and total value locked by protocol and asset.

#### Vaults

- [Vaults](https://docs.dune.com/data-catalog/curated/vaults/overview.md): Vault protocol data across lending, liquid staking, and DeFi yield strategies

#### Bridges

- [Bridges](https://docs.dune.com/data-catalog/curated/bridges/overview.md): Curated cross-chain bridge datasets across 41 EVM chains on Dune
- [bridges_evms.flows](https://docs.dune.com/data-catalog/curated/bridges/flows.md): Matched cross-chain bridge flows — deposits paired with withdrawals for complete bridge transfer tracking.
- [bridges_evms.deposits](https://docs.dune.com/data-catalog/curated/bridges/deposits.md): Cross-chain bridge deposits — tokens locked or burned on the source chain for bridging to another network.
- [bridges_evms.withdrawals](https://docs.dune.com/data-catalog/curated/bridges/withdrawals.md): Cross-chain bridge withdrawals — tokens minted or released on the destination chain after bridging.

#### Staking

- [Staking](https://docs.dune.com/data-catalog/curated/staking/overview.md): Curated Ethereum staking datasets with entity identification on Dune
- [staking_ethereum.deposits](https://docs.dune.com/data-catalog/curated/staking/deposits.md): Ethereum beacon chain deposit events — validator activations with amounts, withdrawal credentials, and entity attribution.
- [staking_ethereum.flows](https://docs.dune.com/data-catalog/curated/staking/flows.md): Ethereum staking net flows — ETH movements in and out of the beacon chain by entity over time.
- [staking_ethereum.entities](https://docs.dune.com/data-catalog/curated/staking/entities.md): Ethereum staking entities — known operators, institutional stakers, and liquid staking protocols.
- [staking_ethereum.info](https://docs.dune.com/data-catalog/curated/staking/info.md): Ethereum validator snapshots — current status, balance, activation epoch, and entity attribution.

#### CEX Flows

- [CEX Flows](https://docs.dune.com/data-catalog/curated/cex-flows/overview.md): Curated centralized exchange flow datasets across 29 chains on Dune
- [cex.flows](https://docs.dune.com/data-catalog/curated/cex-flows/flows.md): Token flows to and from centralized exchanges — deposits, withdrawals, and internal transfers with exchange entity attribution.
- [cex.addresses](https://docs.dune.com/data-catalog/curated/cex-flows/addresses.md): Centralized exchange address directory — all known addresses attributed to major exchanges.
- [cex.deposit_addresses](https://docs.dune.com/data-catalog/curated/cex-flows/deposit_addresses.md): Known centralized exchange deposit addresses — identified user-facing deposit wallets by exchange.

#### Gas & Fees

- [Gas & Fees](https://docs.dune.com/data-catalog/curated/gas-fees/overview.md): Curated transaction fee datasets across 55+ EVM chains and Solana on Dune
- [gas.fees](https://docs.dune.com/data-catalog/curated/gas-fees/fees.md): Transaction-level gas fee data across EVM chains — base fee, priority fee, L1/L2 breakdowns, and gas consumption.
- [gas_solana.fees](https://docs.dune.com/data-catalog/curated/gas-fees/solana_fees.md): Solana transaction fee data — compute units, priority fees, and fee payer details per transaction.

#### Rollup Economics

- [Rollup Economics](https://docs.dune.com/data-catalog/curated/rollup-economics/overview.md): Curated rollup profitability datasets for Ethereum L2s on Dune
- [rollup_economics_ethereum.l2_revenue](https://docs.dune.com/data-catalog/curated/rollup-economics/l2_revenue.md): L2 rollup revenue — transaction fees collected from users on each rollup.
- [rollup_economics_ethereum.l1_fees](https://docs.dune.com/data-catalog/curated/rollup-economics/l1_fees.md): L2 rollup posting costs — data availability and verification fees paid to Ethereum L1 by each rollup.

#### Utilities

- [Utilities](https://docs.dune.com/data-catalog/curated/utilities/overview.md): Time-series scaffolding tables for blockchain analytics on Dune
- [utils.days](https://docs.dune.com/data-catalog/curated/utilities/days.md): Calendar date scaffold — one row per day for time-series joins and aggregation windows.

### Solana

#### Solana

- [Solana Overview](https://docs.dune.com/data-catalog/solana/overview.md): Solana raw and decoded data on Dune — transactions, blocks, instructions, account activity, rewards, and vote data for trading, compliance, wallet engineering, and research.

##### Raw

- [solana.account_activity](https://docs.dune.com/data-catalog/solana/account-activity.md): Track every SOL and SPL token balance change per account per transaction — essential for wallet activity monitoring, treasury tracking, compliance auditing, and building real-time portfolio analytics on Solana.
- [solana.blocks](https://docs.dune.com/data-catalog/solana/blocks.md): Solana block-level data including slot numbers, leader identity, rewards, and transaction counts. Blocks contain transactions which contain instructions that alter the state of the Solana blockchain. Use this data for network throughput analysis, validator performance benchmarking, and infrastructur…
- [solana.instruction_calls](https://docs.dune.com/data-catalog/solana/instruction-calls.md): Every program instruction executed on Solana with decoded arguments, inner instruction traces, and execution context. Critical for protocol analytics, smart contract auditing, cross-program invocation analysis, and DeFi flow tracing.
- [solana.rewards](https://docs.dune.com/data-catalog/solana/rewards.md): Validator and staker reward distributions on Solana — staking rewards, voting rewards, and fee distributions. Use this data for APY calculations, validator economics research, staking yield analysis, and custodial reporting.
- [solana.transactions](https://docs.dune.com/data-catalog/solana/transactions.md): Complete Solana transaction records with signatures, signers, fees, compute units, and execution status. The foundational table for on-chain analysis — from trading flow attribution and fee optimization to compliance monitoring and application usage tracking.
- [solana.vote_transactions](https://docs.dune.com/data-catalog/solana/vote-transactions.md): Solana validator consensus vote transactions — track validator participation, voting patterns, and network health. Essential for staking providers, validator operators, and researchers analyzing Solana's consensus mechanism.

##### Decoded

- [Solana Decoded Tables](https://docs.dune.com/data-catalog/solana/idl-tables.md): Decoded Solana program data using Interface Description Language (IDL) definitions — human-readable instruction and event data for DeFi protocols, NFT marketplaces, and any Solana program. The fastest path from raw bytes to actionable analytics.

##### Curated

###### DEX

- [dex_solana.trades](https://docs.dune.com/data-catalog/curated/dex-trades/solana/solana-dex-trades.md): The `dex_solana.trades` table captures detailed data on decentralized exchange (DEX) trades on the Solana blockchain, recording all raw trade events across various protocols.
- [jupiter_solana.aggregator_swaps](https://docs.dune.com/data-catalog/curated/dex-trades/solana/jupiter-aggregator-trades.md): The `jupiter_solana.aggregator_swaps` table captures data on trades executed through the Jupiter aggregator on Solana.

###### Token Transfers

- [Solana Token Transfers](https://docs.dune.com/data-catalog/curated/token-transfers/solana/solana-token-transfers.md): Token transfer events on the Solana blockchain.

###### Token Metadata

- [Token Metadata](https://docs.dune.com/data-catalog/curated/token-metadata/solana/token-metadata.md): Metadata for fungible tokens on the Solana blockchain.
- [Token Accounts](https://docs.dune.com/data-catalog/curated/token-metadata/solana/token-accounts.md): Information about token accounts on the Solana blockchain.

###### NFT

- [Solana NFT Metadata](https://docs.dune.com/data-catalog/curated/nft-trades/solana/solana-nft-metadata.md): Metadata for non-fungible tokens (NFTs) on the Solana blockchain.
- [Solana NFT Transfers](https://docs.dune.com/data-catalog/curated/nft-trades/solana/solana-nft-transfers.md): NFT transfer events on the Solana blockchain.

###### Gas & Fees

- [gas_solana.fees](https://docs.dune.com/data-catalog/curated/gas-fees/solana_fees.md): Solana transaction fee data — compute units, priority fees, and fee payer details per transaction.

### Hyperliquid

#### Hyperliquid

- [Hyperliquid](https://docs.dune.com/data-catalog/community/hyperliquid/overview.md): Raw, decoded, and curated Hyperliquid HyperCore data on Dune: trading, order book, funding, account activity, and RWA markets
- [hyperliquid.market_data](https://docs.dune.com/data-catalog/community/hyperliquid/market-data.md): Hyperliquid market data — order book snapshots, funding rates, open interest, and trade history.

### Non-EVM Networks

#### Aptos

- [Aptos data](https://docs.dune.com/data-catalog/aptos/overview.md): Aptos is a next-generation blockchain designed for scalability, security, and reliability.
- [aptos.blocks](https://docs.dune.com/data-catalog/aptos/blocks.md): Aptos block metadata — block height, timestamp, epoch, and round information.
- [aptos.events](https://docs.dune.com/data-catalog/aptos/events.md): Aptos on-chain events — emitted by Move modules during transaction execution.
- [aptos.move_modules](https://docs.dune.com/data-catalog/aptos/move_modules.md): Aptos Move module deployments — published module bytecode, package metadata, and addresses.
- [aptos.move_resources](https://docs.dune.com/data-catalog/aptos/move_resources.md): Aptos Move resource snapshots — on-chain state stored in Move structs by account.
- [aptos.move_table_items](https://docs.dune.com/data-catalog/aptos/move_table_items.md): Aptos Move table operations — key-value store changes during transaction execution.
- [aptos.signatures](https://docs.dune.com/data-catalog/aptos/signatures.md): Aptos transaction signatures — authentication data including public keys and signature schemes.
- [aptos.transactions](https://docs.dune.com/data-catalog/aptos/transactions.md): Aptos transactions — payload type, gas used, success status, and version number.
- [aptos.user_transactions](https://docs.dune.com/data-catalog/aptos/user_transactions.md): Aptos user-initiated transactions — function calls, gas details, and sender information.

#### Bitcoin

- [Bitcoin data](https://docs.dune.com/data-catalog/bitcoin/overview.md): Bitcoin is the first and most well-known blockchain.
- [bitcoin.blocks](https://docs.dune.com/data-catalog/bitcoin/blocks.md): Bitcoin block headers — height, timestamp, difficulty, nonce, Merkle root, and miner reward.
- [bitcoin.inputs](https://docs.dune.com/data-catalog/bitcoin/inputs.md): Bitcoin transaction inputs — spent UTXOs with previous transaction references and script signatures.
- [bitcoin.outputs](https://docs.dune.com/data-catalog/bitcoin/outputs.md): Bitcoin transaction outputs — created UTXOs with value, script type, and locking conditions.
- [bitcoin.transactions](https://docs.dune.com/data-catalog/bitcoin/transactions.md): Bitcoin transactions — version, locktime, size, weight, fee, and input/output counts.

#### Cardano

- [Cardano Data](https://docs.dune.com/data-catalog/cardano/overview.md): Cardano blockchain data on Dune
- [cardano.block](https://docs.dune.com/data-catalog/cardano/block.md): Description of the block table on Dune
- [cardano.transaction](https://docs.dune.com/data-catalog/cardano/transaction.md): Description of the transaction table on Dune
- [cardano.address_utxo](https://docs.dune.com/data-catalog/cardano/address_utxo.md): Description of the address_utxo table on Dune
- [cardano.tx_input](https://docs.dune.com/data-catalog/cardano/tx_input.md): Description of the tx_input table on Dune
- [cardano.epoch_stake](https://docs.dune.com/data-catalog/cardano/epoch_stake.md): Description of the epoch_stake table on Dune
- [cardano.pool_reward](https://docs.dune.com/data-catalog/cardano/pool_reward.md): Description of the pool_reward table on Dune
- [cardano.asset_mint](https://docs.dune.com/data-catalog/cardano/asset_mint.md): Description of the asset_mint table on Dune
- [cardano.asset_data](https://docs.dune.com/data-catalog/cardano/asset_data.md): Description of the asset_data table on Dune
- [cardano.transaction_scripts](https://docs.dune.com/data-catalog/cardano/transaction_scripts.md): Description of the transaction_scripts table on Dune
- [cardano.smart_contract_registry](https://docs.dune.com/data-catalog/cardano/smart_contract_registry.md): Description of the smart_contract_registry table on Dune
- [cardano.transaction_metadata](https://docs.dune.com/data-catalog/cardano/transaction_metadata.md): Description of the transaction_metadata table on Dune
- [cardano.gov_action_proposal](https://docs.dune.com/data-catalog/cardano/gov_action_proposal.md): Description of the gov_action_proposal table on Dune
- [cardano.gov_action_vote](https://docs.dune.com/data-catalog/cardano/gov_action_vote.md): Description of the gov_action_vote table on Dune
- [cardano.gov_action_proposal_status](https://docs.dune.com/data-catalog/cardano/gov_action_proposal_status.md): Description of the gov_action_proposal_status table on Dune
- [cardano.adapot](https://docs.dune.com/data-catalog/cardano/adapot.md): Description of the adapot table on Dune
- [cardano.drep_dist_enriched](https://docs.dune.com/data-catalog/cardano/drep_dist_enriched.md): Description of the drep_dist_enriched table on Dune
- [cardano.off_chain_pool_data](https://docs.dune.com/data-catalog/cardano/off_chain_pool_data.md): Description of the off_chain_pool_data table on Dune

#### Echelon

- [Echelon Data](https://docs.dune.com/data-catalog/echelon/overview.md): Echelon blockchain data on Dune
- [Blocks](https://docs.dune.com/data-catalog/echelon/blocks.md): Echelon blockchain blocks data
- [Block Events](https://docs.dune.com/data-catalog/echelon/block_events.md): Echelon blockchain block events data
- [Message Events](https://docs.dune.com/data-catalog/echelon/message_events.md): Echelon blockchain message events data
- [Transactions](https://docs.dune.com/data-catalog/echelon/transactions.md): Echelon blockchain transactions data
- [Transaction Messages](https://docs.dune.com/data-catalog/echelon/tx_messages.md): Echelon blockchain transaction messages data

#### Fuel

- [Fuel Data](https://docs.dune.com/data-catalog/fuel/overview.md): Fuel blockchain data on Dune
- [Blocks](https://docs.dune.com/data-catalog/fuel/blocks.md): Fuel blockchain blocks data
- [Transactions](https://docs.dune.com/data-catalog/fuel/transactions.md): Fuel blockchain transactions data
- [Receipts](https://docs.dune.com/data-catalog/fuel/receipts.md): Fuel blockchain receipts data

#### Initia

- [Initia Data](https://docs.dune.com/data-catalog/initia/overview.md): Initia blockchain data on Dune
- [Balances](https://docs.dune.com/data-catalog/initia/balances.md): Initia blockchain account balances data
- [Blocks](https://docs.dune.com/data-catalog/initia/blocks.md): Initia blockchain blocks data
- [Block Events](https://docs.dune.com/data-catalog/initia/block_events.md): Initia blockchain block events data
- [Bridge Transfers](https://docs.dune.com/data-catalog/initia/bridge_transfers.md): Initia blockchain cross-chain bridge transfer data
- [Message Events](https://docs.dune.com/data-catalog/initia/message_events.md): Initia blockchain message events data
- [Swaps](https://docs.dune.com/data-catalog/initia/swaps.md): Initia blockchain token swap transactions data
- [Transactions](https://docs.dune.com/data-catalog/initia/transactions.md): Initia blockchain transactions data
- [Transaction Messages](https://docs.dune.com/data-catalog/initia/tx_messages.md): Initia blockchain transaction messages data
- [Validators](https://docs.dune.com/data-catalog/initia/validators.md): Initia blockchain validators data

#### Midnight

- [Midnight Data](https://docs.dune.com/data-catalog/midnight/overview.md): Midnight blockchain data on Dune
- [Blocks](https://docs.dune.com/data-catalog/midnight/blocks.md): Midnight blockchain blocks data
- [Transactions](https://docs.dune.com/data-catalog/midnight/transactions.md): Midnight blockchain transactions data
- [Regular Transactions](https://docs.dune.com/data-catalog/midnight/regular_transactions.md): Midnight regular transaction fee and merkle details
- [Ledger Events](https://docs.dune.com/data-catalog/midnight/ledger_events.md): Midnight ledger events data
- [Contract Actions](https://docs.dune.com/data-catalog/midnight/contract_actions.md): Midnight contract actions data
- [Unshielded UTXOs](https://docs.dune.com/data-catalog/midnight/unshielded_utxos.md): Midnight unshielded UTXO data
- [cNIGHT Registrations](https://docs.dune.com/data-catalog/midnight/cnight_registrations.md): Midnight cNIGHT registration data
- [DUST Generation Info](https://docs.dune.com/data-catalog/midnight/dust_generation_info.md): Midnight DUST generation info data
- [SPO History](https://docs.dune.com/data-catalog/midnight/spo_history.md): Midnight stake pool operator history
- [SPO Identity](https://docs.dune.com/data-catalog/midnight/spo_identity.md): Midnight stake pool operator identity
- [SPO Stake History](https://docs.dune.com/data-catalog/midnight/spo_stake_history.md): Midnight stake pool stake history
- [SPO Epoch Performance](https://docs.dune.com/data-catalog/midnight/spo_epoch_performance.md): Midnight SPO epoch performance data
- [Committee Membership](https://docs.dune.com/data-catalog/midnight/committee_membership.md): Midnight committee membership data
- [Pool Metadata Cache](https://docs.dune.com/data-catalog/midnight/pool_metadata_cache.md): Midnight pool metadata cache

#### Noble

- [Noble Data](https://docs.dune.com/data-catalog/noble/overview.md): Noble blockchain data on Dune
- [Blocks](https://docs.dune.com/data-catalog/noble/blocks.md): Noble blockchain blocks data
- [Block Events](https://docs.dune.com/data-catalog/noble/block_events.md): Noble blockchain block events data
- [Bridge Transfers](https://docs.dune.com/data-catalog/noble/bridge_transfers.md): Noble blockchain cross-chain bridge transfer data
- [CCTP Transactions](https://docs.dune.com/data-catalog/noble/cctp_transactions.md): Noble blockchain Cross-Chain Transfer Protocol transactions data
- [Message Events](https://docs.dune.com/data-catalog/noble/message_events.md): Noble blockchain message events data
- [Swaps](https://docs.dune.com/data-catalog/noble/swaps.md): Noble blockchain token swap transactions data
- [Transactions](https://docs.dune.com/data-catalog/noble/transactions.md): Noble blockchain transactions data
- [Transaction Messages](https://docs.dune.com/data-catalog/noble/tx_messages.md): Noble blockchain transaction messages data
- [Validators](https://docs.dune.com/data-catalog/noble/validators.md): Noble blockchain validators data

#### Peaq

- [Peaq Overview](https://docs.dune.com/data-catalog/peaq/overview.md): Peaq blockchain data on Dune
- [peaq.evm_blocks](https://docs.dune.com/data-catalog/peaq/blocks.md): Peaq EVM-compatible block data.
- [peaq.extrinsics](https://docs.dune.com/data-catalog/peaq/extrinsics.md): Peaq extrinsics — signed and unsigned transactions.
- [peaq.events](https://docs.dune.com/data-catalog/peaq/events.md): Peaq runtime events — pallet-level events emitted during execution.
- [peaq.calls](https://docs.dune.com/data-catalog/peaq/calls.md): Peaq dispatch calls — pallet function calls within extrinsics.
- [peaq.transfers](https://docs.dune.com/data-catalog/peaq/transfers.md): Peaq native token transfers.
- [peaq.balances](https://docs.dune.com/data-catalog/peaq/balances.md): Peaq account balances.

#### NEAR

- [NEAR Data](https://docs.dune.com/data-catalog/near/overview.md): NEAR blockchain data on Dune
- [near.actions](https://docs.dune.com/data-catalog/near/actions.md): NEAR Protocol actions — function calls, transfers, and account operations.
- [near.block_chunks](https://docs.dune.com/data-catalog/near/block_chunks.md): NEAR block chunks — block data with chunk-level transaction groupings.
- [near.circulating_supply](https://docs.dune.com/data-catalog/near/circulating_supply.md): NEAR circulating supply snapshots — total and circulating NEAR over time.
- [near.ft_transfers](https://docs.dune.com/data-catalog/near/ft_transfers.md): NEAR fungible token transfers — NEP-141 token movements.
- [near.function_call](https://docs.dune.com/data-catalog/near/function_call.md): NEAR function call actions — contract method invocations with arguments.
- [near.balances](https://docs.dune.com/data-catalog/near/balances.md): NEAR account balances — native NEAR token holdings by account.
- [near.nft_transfers](https://docs.dune.com/data-catalog/near/nft_transfers.md): NEAR NFT transfers — NEP-171 non-fungible token movements.
- [near.logs](https://docs.dune.com/data-catalog/near/logs.md): NEAR execution logs — log output from smart contract execution.

#### Polkadot

- [Polkadot & Substrate Overview](https://docs.dune.com/data-catalog/substrate/overview.md): Substrate chains (e.g. Polkadot and its parachains) are on Dune.
- [polkadot.balances](https://docs.dune.com/data-catalog/substrate/balances.md): Description of Substrate balances tables on Dune.
- [polkadot.blocks](https://docs.dune.com/data-catalog/substrate/blocks.md): Description of Substrate blocks table on Dune.
- [polkadot.calls](https://docs.dune.com/data-catalog/substrate/calls.md): Description of Substrate calls tables on Dune.
- [polkadot.events](https://docs.dune.com/data-catalog/substrate/events.md): Substrate runtime events across Polkadot, Kusama, and parachain networks.
- [polkadot.extrinsics](https://docs.dune.com/data-catalog/substrate/extrinsics.md): Description of Substrate extrinsics table on Dune.
- [Materialized Views](https://docs.dune.com/data-catalog/substrate/materialized_views.md): Useful materialized views for Polkadot, Kusama & their parachains.
- [polkadot.stakings](https://docs.dune.com/data-catalog/substrate/stakings.md): Polkadot staking data — validator nominations, staking rewards, and slash events.
- [polkadot.transfers](https://docs.dune.com/data-catalog/substrate/transfers.md): Polkadot native token (DOT) transfers — sender, recipient, amount, and transfer type.
- [polkadot.traces](https://docs.dune.com/data-catalog/substrate/traces.md): Polkadot execution traces — detailed runtime execution data across pallets.

#### Starknet

- [Starknet data](https://docs.dune.com/data-catalog/starknet/overview.md): Starknet data on Dune
- [starknet.blocks](https://docs.dune.com/data-catalog/starknet/blocks.md): StarkNet block data — block numbers, timestamps, sequencer identity, and state roots.
- [starknet.transactions](https://docs.dune.com/data-catalog/starknet/transactions.md): StarkNet transaction records — invoke, deploy, and declare transactions with fees and execution status.
- [starknet.events](https://docs.dune.com/data-catalog/starknet/events.md): StarkNet contract events — event data emitted by Cairo smart contracts during execution.
- [starknet.calls](https://docs.dune.com/data-catalog/starknet/calls.md): StarkNet internal calls — function call traces within StarkNet transaction execution.

#### Flow

- [Flow Overview](https://docs.dune.com/data-catalog/flow/overview.md): Flow blockchain data on Dune - EVM and Cadence

##### EVM

###### Raw

- [flow.blocks](https://docs.dune.com/data-catalog/flow/raw/blocks.md): Flow block data — block height, timestamp, and collection guarantees.
- [flow.creation_traces](https://docs.dune.com/data-catalog/flow/raw/creation-traces.md): Flow contract deployment records — deployer and deployed contract details.
- [flow.logs](https://docs.dune.com/data-catalog/flow/raw/logs.md): Flow event logs — events emitted during Cadence smart contract execution.
- [flow.transactions](https://docs.dune.com/data-catalog/flow/raw/transactions.md): Flow transaction records — authorizers, payer, gas limit, and execution status.
- [flow.traces](https://docs.dune.com/data-catalog/flow/raw/traces.md): Flow execution traces — internal call data during transaction processing.

###### Decoded

- [Flow EVM Decoded Overview](https://docs.dune.com/data-catalog/flow/decoded/overview.md): Simplifying Flow EVM smart contract analysis through human-readable tables.
- [Flow EVM Call Tables](https://docs.dune.com/data-catalog/flow/decoded/call-tables.md): On Dune, we parse all message calls and transactions made to smart contracts on the Flow EVM network in their own tables.
- [flow.event_logs](https://docs.dune.com/data-catalog/flow/decoded/event-logs.md): Smart contract event logs on Flow — indexed topics and data fields emitted during transaction execution.
- [flow.contracts](https://docs.dune.com/data-catalog/flow/decoded/contracts.md): Verified contract registry on Flow — contract name, code, and deployment metadata.
- [flow.logs_decoded](https://docs.dune.com/data-catalog/flow/decoded/logs-decoded.md): ABI-decoded Flow event logs — parsed event names and parameters.
- [flow.traces_decoded](https://docs.dune.com/data-catalog/flow/decoded/traces-decoded.md): ABI-decoded Flow function calls — parsed function names and arguments.

###### Curated

###### DEX

- [dex.trades on flow](https://docs.dune.com/data-catalog/flow/curated-data/dex/dex-trades.md): The `dex.trades` table captures detailed data on decentralized exchange (DEX) trades, recording all raw trade events across various protocols on flow.

##### Cadence

- [flow.cadence_blocks](https://docs.dune.com/data-catalog/flow/cadence/blocks.md): Flow Cadence block data — block details specific to Flow's Cadence execution environment.
- [flow.cadence_transactions](https://docs.dune.com/data-catalog/flow/cadence/transactions.md): Flow Cadence transactions — script and transaction interactions with the Cadence runtime.
- [flow.cadence_transaction_receipts](https://docs.dune.com/data-catalog/flow/cadence/transaction-receipts.md): Flow Cadence transaction receipts — execution results, events, and status.
- [flow.cadence_events](https://docs.dune.com/data-catalog/flow/cadence/events.md): Flow Cadence events — structured events emitted by Cadence smart contracts.
- [flow.cadence_contracts](https://docs.dune.com/data-catalog/flow/cadence/contracts.md): Flow Cadence contract deployments — contract code and account bindings.
- [flow.cadence_tokens](https://docs.dune.com/data-catalog/flow/cadence/tokens.md): Flow Cadence token metadata — fungible and non-fungible token type definitions.
- [flow.cadence_token_transfers](https://docs.dune.com/data-catalog/flow/cadence/token-transfers.md): Flow Cadence token transfers — fungible and NFT movement events.
- [flow.cadence_token_collections](https://docs.dune.com/data-catalog/flow/cadence/token-collections.md): Flow Cadence NFT collections — collection metadata and token types.
- [flow.cadence_native_token_balances](https://docs.dune.com/data-catalog/flow/cadence/native-token-balances.md): Flow native FLOW token balances — account holdings over time.
- [flow.cadence_participations](https://docs.dune.com/data-catalog/flow/cadence/participations.md): Flow network participations — staking, delegation, and epoch participation records.

#### Stellar

- [Stellar Data](https://docs.dune.com/data-catalog/stellar/overview.md): Stellar blockchain data on Dune
- [EVM vs Stellar Comparison](https://docs.dune.com/data-catalog/stellar/evm_v_stellar.md): A comparison between EVM-based blockchains and Stellar
- [stellar.accounts](https://docs.dune.com/data-catalog/stellar/accounts.md): Stellar account data — public keys, sequence numbers, balances, and thresholds.
- [stellar.trust_lines](https://docs.dune.com/data-catalog/stellar/trust_lines.md): Stellar trustlines — authorized asset holdings per account.
- [stellar.ttl](https://docs.dune.com/data-catalog/stellar/ttl.md): Stellar contract data time-to-live records.
- [stellar.contract_data](https://docs.dune.com/data-catalog/stellar/contract_data.md): Stellar Soroban smart contract data entries.
- [stellar.history_ledgers](https://docs.dune.com/data-catalog/stellar/history_ledgers.md): Stellar ledger data — sequence number, transaction count, and protocol version.
- [stellar.history_transactions](https://docs.dune.com/data-catalog/stellar/history_transactions.md): Stellar transaction records — source account, fee, memo, and operation count.
- [stellar.history_operations](https://docs.dune.com/data-catalog/stellar/history_operations.md): Stellar operations — payments, offers, account changes, and other operation types.
- [stellar.history_effects](https://docs.dune.com/data-catalog/stellar/history_effects.md): Stellar operation effects — balance changes, trustline modifications, and other state changes.
- [stellar.history_trades](https://docs.dune.com/data-catalog/stellar/history_trades.md): Stellar DEX trades — orderbook-based trades on the Stellar decentralized exchange.
- [stellar.liquidity_pools](https://docs.dune.com/data-catalog/stellar/liquidity_pools.md): Stellar AMM liquidity pools — pool assets, reserves, and share supply.
- [stellar.history_contract_events](https://docs.dune.com/data-catalog/stellar/history_contract_events.md): Stellar Soroban contract events — events emitted by smart contracts.

#### Sui

- [Sui Data](https://docs.dune.com/data-catalog/sui/overview.md): Sui blockchain data on Dune
- [sui.checkpoints](https://docs.dune.com/data-catalog/sui/checkpoints.md): Sui checkpoints — finalized checkpoint data with transaction digests and timestamps.
- [sui.events](https://docs.dune.com/data-catalog/sui/events.md): Sui on-chain events — events emitted by Move packages during execution.
- [sui.move_call](https://docs.dune.com/data-catalog/sui/move_call.md): Sui Move function calls — package, module, and function invocations.
- [sui.move_package](https://docs.dune.com/data-catalog/sui/move_package.md): Sui Move package deployments — published packages and upgrade records.
- [sui.objects](https://docs.dune.com/data-catalog/sui/objects.md): Sui object data — owned and shared objects with type, version, and ownership info.
- [sui.transaction_objects](https://docs.dune.com/data-catalog/sui/transaction_objects.md): Sui transaction-object relationships — objects created, mutated, or deleted per transaction.
- [sui.transactions](https://docs.dune.com/data-catalog/sui/transactions.md): Sui transaction records — sender, gas, status, and transaction kind.
- [sui.wrapped_object](https://docs.dune.com/data-catalog/sui/wrapped_object.md): Sui wrapped object records — objects contained within other objects.

#### TON

- [TON Data](https://docs.dune.com/data-catalog/ton/overview.md): TON blockchain data on Dune
- [ton.accounts](https://docs.dune.com/data-catalog/ton/accounts.md): TON account data — wallet addresses, contract types, balances, and status.
- [ton.balances_history](https://docs.dune.com/data-catalog/ton/balances_history.md): TON account balance history — Toncoin holdings over time.
- [ton.blocks](https://docs.dune.com/data-catalog/ton/blocks.md): TON block data — workchain, shard, seqno, and global block identifiers.
- [ton.transactions](https://docs.dune.com/data-catalog/ton/transactions.md): TON transaction records — account, fees, compute phase, and action results.
- [ton.messages](https://docs.dune.com/data-catalog/ton/messages.md): TON messages — internal and external messages between accounts.
- [ton.dex_pools](https://docs.dune.com/data-catalog/ton/dex_pools.md): TON DEX liquidity pools — pool assets, reserves, and protocol.
- [ton.dex_trades](https://docs.dune.com/data-catalog/ton/dex_trades.md): TON DEX trades — swaps on DeDust, STON.fi, and other TON decentralized exchanges.
- [ton.jetton_events](https://docs.dune.com/data-catalog/ton/jetton_events.md): TON Jetton token events — transfers, mints, and burns.
- [ton.jetton_metadata](https://docs.dune.com/data-catalog/ton/jetton_metadata.md): TON Jetton token metadata — name, symbol, decimals, and master contract.
- [ton.nft_events](https://docs.dune.com/data-catalog/ton/nft_events.md): TON NFT events — transfers, sales, and ownership changes.
- [ton.jetton_metadata](https://docs.dune.com/data-catalog/ton/nft_metadata.md): TON NFT metadata — collection info, item details, and content URLs.
- [ton.prices_daily](https://docs.dune.com/data-catalog/ton/prices_daily.md): TON daily token price aggregates — historical pricing data for Toncoin and Jetton tokens.

#### THORChain

- [THORChain Data](https://docs.dune.com/data-catalog/thorchain/overview.md): THORChain blockchain data on Dune
- [thorchain.core_instantiate_events](https://docs.dune.com/data-catalog/thorchain/core_instantiate_events.md): THORChain module instantiation events.
- [thorchain.core_network_version_events](https://docs.dune.com/data-catalog/thorchain/core_network_version_events.md): THORChain network version upgrade events.
- [thorchain.core_set_mimir_events](https://docs.dune.com/data-catalog/thorchain/core_set_mimir_events.md): THORChain Mimir governance parameter change events.
- [thorchain.core_thorname_change_events](https://docs.dune.com/data-catalog/thorchain/core_thorname_change_events.md): THORChain THORName registration and update events.
- [thorchain.core_transfer_events](https://docs.dune.com/data-catalog/thorchain/core_transfer_events.md): THORChain native RUNE transfer events.
- [thorchain.core_tss_keygen_failure_events](https://docs.dune.com/data-catalog/thorchain/core_tss_keygen_failure_events.md): THORChain TSS key generation failure events.
- [thorchain.core_tss_keygen_success_events](https://docs.dune.com/data-catalog/thorchain/core_tss_keygen_success_events.md): THORChain TSS key generation success events.
- [thorchain.core_wasm_contracts_events](https://docs.dune.com/data-catalog/thorchain/core_wasm_contracts_events.md): THORChain CosmWasm contract execution events.
- [thorchain.core_block](https://docs.dune.com/data-catalog/thorchain/core_block.md): THORChain block data — block height, timestamp, and chain metadata.
- [thorchain.core_transfers](https://docs.dune.com/data-catalog/thorchain/core_transfers.md): THORChain token transfer records — RUNE and synth movements.
- [thorchain.defi_active_vault_events](https://docs.dune.com/data-catalog/thorchain/defi_active_vault_events.md): THORChain active vault rotation events.
- [thorchain.defi_add_events](https://docs.dune.com/data-catalog/thorchain/defi_add_events.md): THORChain liquidity add events — assets deposited to pools.
- [thorchain.defi_affiliate_fee_events](https://docs.dune.com/data-catalog/thorchain/defi_affiliate_fee_events.md): THORChain affiliate fee collection events.
- [thorchain.defi_asgard_fund_yggdrasil_events](https://docs.dune.com/data-catalog/thorchain/defi_asgard_fund_yggdrasil_events.md): THORChain vault funding events — Asgard to Yggdrasil transfers.
- [thorchain.defi_block_pool_depths](https://docs.dune.com/data-catalog/thorchain/defi_block_pool_depths.md): THORChain pool depth snapshots per block — asset and RUNE balances.
- [thorchain.defi_block_rewards](https://docs.dune.com/data-catalog/thorchain/defi_block_rewards.md): THORChain block reward distributions — emissions to pools and node operators.
- [thorchain.defi_bond_actions](https://docs.dune.com/data-catalog/thorchain/defi_bond_actions.md): THORChain node bond actions — bond and unbond operations.
- [thorchain.defi_bond_events](https://docs.dune.com/data-catalog/thorchain/defi_bond_events.md): THORChain bond lifecycle events — deposits, withdrawals, and slashes.
- [thorchain.defi_daily_earnings](https://docs.dune.com/data-catalog/thorchain/defi_daily_earnings.md): THORChain daily protocol earnings — fees, rewards, and revenue breakdown.
- [thorchain.defi_daily_tvl](https://docs.dune.com/data-catalog/thorchain/defi_daily_tvl.md): THORChain daily total value locked — aggregate TVL across all pools.
- [thorchain.defi_errata_events](https://docs.dune.com/data-catalog/thorchain/defi_errata_events.md): THORChain errata correction events — manual adjustments to chain state.
- [thorchain.defi_failed_deposit_messages](https://docs.dune.com/data-catalog/thorchain/defi_failed_deposit_messages.md): THORChain failed deposit attempts — rejected inbound transactions.
- [thorchain.defi_fee_events](https://docs.dune.com/data-catalog/thorchain/defi_fee_events.md): THORChain fee collection events — swap fees, network fees, and outbound fees.
- [thorchain.defi_gas_events](https://docs.dune.com/data-catalog/thorchain/defi_gas_events.md): THORChain gas reimbursement events — gas costs for outbound transactions.
- [thorchain.defi_inactive_vault_events](https://docs.dune.com/data-catalog/thorchain/defi_inactive_vault_events.md): THORChain vault deactivation events.
- [thorchain.defi_loan_open_events](https://docs.dune.com/data-catalog/thorchain/defi_loan_open_events.md): THORChain lending — loan origination events with collateral and debt details.
- [thorchain.defi_loan_repayment_events](https://docs.dune.com/data-catalog/thorchain/defi_loan_repayment_events.md): THORChain lending — loan repayment events.
- [thorchain.defi_mint_burn_events](https://docs.dune.com/data-catalog/thorchain/defi_mint_burn_events.md): THORChain synthetic asset mint and burn events.
- [thorchain.defi_outbound_events](https://docs.dune.com/data-catalog/thorchain/defi_outbound_events.md): THORChain outbound transaction events — assets sent to external chains.
- [thorchain.defi_pending_liquidity_events](https://docs.dune.com/data-catalog/thorchain/defi_pending_liquidity_events.md): THORChain pending liquidity events — asymmetric deposits awaiting pairing.
- [thorchain.defi_pool_balance_change_events](https://docs.dune.com/data-catalog/thorchain/defi_pool_balance_change_events.md): THORChain pool balance change events — triggered by swaps, adds, and withdrawals.
- [thorchain.defi_pool_block_balances](https://docs.dune.com/data-catalog/thorchain/defi_pool_block_balances.md): THORChain pool balances per block — RUNE and asset depths.
- [thorchain.defi_pool_block_fees](https://docs.dune.com/data-catalog/thorchain/defi_pool_block_fees.md): THORChain pool fees per block — swap and liquidity fees collected.
- [thorchain.defi_pool_block_statistics](https://docs.dune.com/data-catalog/thorchain/defi_pool_block_statistics.md): THORChain pool statistics per block — volume, swap count, and slip.
- [thorchain.defi_pool_events](https://docs.dune.com/data-catalog/thorchain/defi_pool_events.md): THORChain pool lifecycle events — creation, suspension, and status changes.
- [thorchain.defi_refund_events](https://docs.dune.com/data-catalog/thorchain/defi_refund_events.md): THORChain refund events — returned transactions that couldn't be processed.
- [thorchain.defi_reserve_events](https://docs.dune.com/data-catalog/thorchain/defi_reserve_events.md): THORChain reserve fund events — emissions from the protocol reserve.
- [thorchain.defi_rewards_event_entries](https://docs.dune.com/data-catalog/thorchain/defi_rewards_event_entries.md): THORChain reward distribution entries — per-pool reward allocations.
- [thorchain.defi_rewards_events](https://docs.dune.com/data-catalog/thorchain/defi_rewards_events.md): THORChain reward distribution events — block-level reward summaries.
- [thorchain.defi_rune_pool_deposit_events](https://docs.dune.com/data-catalog/thorchain/defi_rune_pool_deposit_events.md): THORChain RUNEPool deposit events.
- [thorchain.defi_rune_pool_withdraw_events](https://docs.dune.com/data-catalog/thorchain/defi_rune_pool_withdraw_events.md): THORChain RUNEPool withdrawal events.
- [thorchain.defi_scheduled_outbound_events](https://docs.dune.com/data-catalog/thorchain/defi_scheduled_outbound_events.md): THORChain scheduled outbound queue — pending external chain transactions.
- [thorchain.defi_secure_asset_deposit_events](https://docs.dune.com/data-catalog/thorchain/defi_secure_asset_deposit_events.md): THORChain secure asset deposit events.
- [thorchain.defi_secure_asset_withdraw_events](https://docs.dune.com/data-catalog/thorchain/defi_secure_asset_withdraw_events.md): THORChain secure asset withdrawal events.
- [thorchain.defi_send_messages](https://docs.dune.com/data-catalog/thorchain/defi_send_messages.md): THORChain send messages — internal transfer directives.
- [thorchain.defi_stake_events](https://docs.dune.com/data-catalog/thorchain/defi_stake_events.md): THORChain staking events (legacy) — bond operations.
- [thorchain.defi_streaming_swap_details_events](https://docs.dune.com/data-catalog/thorchain/defi_streaming_swap_details_events.md): THORChain streaming swap progress — partial fill details for large swaps.
- [thorchain.defi_switch_events](https://docs.dune.com/data-catalog/thorchain/defi_switch_events.md): THORChain BEP2/ERC20 to native RUNE switch events.
- [thorchain.defi_tcy_claim_events](https://docs.dune.com/data-catalog/thorchain/defi_tcy_claim_events.md): THORChain TCY claim events.
- [thorchain.defi_tcy_distribution_events](https://docs.dune.com/data-catalog/thorchain/defi_tcy_distribution_events.md): THORChain TCY distribution events.
- [thorchain.defi_tcy_stake_events](https://docs.dune.com/data-catalog/thorchain/defi_tcy_stake_events.md): THORChain TCY staking events.
- [thorchain.defi_tcy_unstake_events](https://docs.dune.com/data-catalog/thorchain/defi_tcy_unstake_events.md): THORChain TCY unstaking events.
- [thorchain.defi_total_block_rewards](https://docs.dune.com/data-catalog/thorchain/defi_total_block_rewards.md): THORChain total block rewards — aggregate emissions per block.
- [thorchain.defi_total_value_locked](https://docs.dune.com/data-catalog/thorchain/defi_total_value_locked.md): THORChain TVL snapshots — total value locked across all pools and features.
- [thorchain.defi_trade_account_deposit_events](https://docs.dune.com/data-catalog/thorchain/defi_trade_account_deposit_events.md): THORChain trade account deposit events.
- [thorchain.defi_trade_account_withdraw_events](https://docs.dune.com/data-catalog/thorchain/defi_trade_account_withdraw_events.md): THORChain trade account withdrawal events.
- [thorchain.defi_update_node_account_status_events](https://docs.dune.com/data-catalog/thorchain/defi_update_node_account_status_events.md): THORChain node status update events — active, standby, and disabled transitions.
- [thorchain.defi_upgrades](https://docs.dune.com/data-catalog/thorchain/defi_upgrades.md): THORChain protocol upgrade events — version changes and migration records.
- [thorchain.defi_withdraw_events](https://docs.dune.com/data-catalog/thorchain/defi_withdraw_events.md): THORChain liquidity withdrawal events — assets removed from pools.
- [thorchain.defi_swaps](https://docs.dune.com/data-catalog/thorchain/defi_swaps.md): THORChain swap records — comprehensive swap data with fees, slip, and routing.
- [thorchain.defi_daily_pool_stats](https://docs.dune.com/data-catalog/thorchain/defi_daily_pool_stats.md): THORChain daily pool statistics — volume, fees, APY, and depth by pool.
- [thorchain.defi_liquidity_actions](https://docs.dune.com/data-catalog/thorchain/defi_liquidity_actions.md): THORChain liquidity actions — adds, withdrawals, and position changes.
- [thorchain.defi_swap_events](https://docs.dune.com/data-catalog/thorchain/defi_swap_events.md): THORChain swap events — cross-chain and intra-chain asset swaps with pricing.
- [thorchain.gov_new_node_events](https://docs.dune.com/data-catalog/thorchain/gov_new_node_events.md): THORChain new node registration events.
- [thorchain.gov_set_ip_address_events](https://docs.dune.com/data-catalog/thorchain/gov_set_ip_address_events.md): THORChain node IP address configuration events.
- [thorchain.gov_set_node_keys_events](https://docs.dune.com/data-catalog/thorchain/gov_set_node_keys_events.md): THORChain node key rotation events.
- [thorchain.gov_set_node_mimir_events](https://docs.dune.com/data-catalog/thorchain/gov_set_node_mimir_events.md): THORChain node Mimir vote events — node operator governance votes.
- [thorchain.gov_set_version_events](https://docs.dune.com/data-catalog/thorchain/gov_set_version_events.md): THORChain node version declaration events.
- [thorchain.gov_slash_events](https://docs.dune.com/data-catalog/thorchain/gov_slash_events.md): THORChain slash events — validator penalties for misbehavior.
- [thorchain.gov_slash_points_events](https://docs.dune.com/data-catalog/thorchain/gov_slash_points_events.md): THORChain slash point accumulation events.
- [thorchain.gov_validator_request_leave_events](https://docs.dune.com/data-catalog/thorchain/gov_validator_request_leave_events.md): THORChain validator leave request events — nodes signaling intent to exit.

#### XRPL

- [XRPL Data](https://docs.dune.com/data-catalog/xrpl/overview.md): XRP Ledger data on Dune
- [xrpl.transactions](https://docs.dune.com/data-catalog/xrpl/transactions.md): XRP Ledger transactions — payments, offers, trust sets, and other transaction types.
- [xrpl.transactions_base](https://docs.dune.com/data-catalog/xrpl/transactions_base.md): The 'xrpl.transactions_base' table contains every validated transaction recorded on the XRP Ledger, covering payments, token operations, DEX trades, NFT activity, and more.
- [xrpl.transfers](https://docs.dune.com/data-catalog/xrpl/transfers.md): The 'xrpl.transfers' table contains all successful direct, same-asset Payment transactions on the XRP Ledger, one row per transfer.
- [xrpl.accounts](https://docs.dune.com/data-catalog/xrpl/accounts.md): The 'xrpl.accounts' table contains all XRPL accounts observed on the ledger, including creation/deletion history, current XRP balance, and identity labels.
- [xrpl.ledger](https://docs.dune.com/data-catalog/xrpl/ledger.md): XRP Ledger data — ledger index, close time, transaction count, and fees.
- [xrpl.tokens](https://docs.dune.com/data-catalog/xrpl/tokens.md): The 'xrpl.tokens' table contains all fungible tokens (IOUs) and Multi-Purpose Tokens (MPTs) issued on the XRP Ledger, one row per token.
- [xrpl.token_holders_daily](https://docs.dune.com/data-catalog/xrpl/token_holders_daily.md): The 'xrpl.token_holders_daily' table is a daily snapshot of token holder metrics for all IOU and MPT tokens on the XRP Ledger.
- [xrpl.dex_swaps](https://docs.dune.com/data-catalog/xrpl/dex_swaps.md): The 'xrpl.dex_swaps' table is a unified view of all token exchanges on the XRP Ledger DEX, combining AMM pool swaps and order-book offer executions.
- [xrpl.dex_ohlcv_daily](https://docs.dune.com/data-catalog/xrpl/dex_ohlcv_daily.md): The 'xrpl.dex_ohlcv_daily' table contains daily OHLCV price data for all trading pairs on the XRP Ledger DEX, combining CLOB and AMM activity.
- [xrpl.amm_pools](https://docs.dune.com/data-catalog/xrpl/amm_pools.md): The 'xrpl.amm_pools' table contains all Automated Market Maker (AMM) liquidity pools on the XRP Ledger, one row per pool.
- [xrpl.amm_events](https://docs.dune.com/data-catalog/xrpl/amm_events.md): The 'xrpl.amm_events' table is a unified view of all activity in XRP Ledger AMM liquidity pools, combining deposits, withdrawals, fee-setting votes, and auction-slot bids.
- [xrpl.annotations](https://docs.dune.com/data-catalog/xrpl/annotations.md): The 'xrpl.annotations' table is a lookup of labeled addresses providing human-readable names for known XRPL wallets, exchanges, and entities.
- [xrpl.aggregated_metrics_daily](https://docs.dune.com/data-catalog/xrpl/aggregated_metrics_daily.md): The 'xrpl.aggregated_metrics_daily' table contains aggregated daily metrics for XRP Ledger activity, including transaction volumes, DEX activity, and AMM statistics.

#### Tron

- [TRON Overview](https://docs.dune.com/data-catalog/tron/overview.md): TRON data on Dune
- [USDT on tron](https://docs.dune.com/data-catalog/tron/tether.md): Decoded USDT data on the Tron network.

##### Decoded

- [tron.contracts](https://docs.dune.com/data-catalog/tron/decoded/contracts.md): Verified contract registry on Tron — contract name, ABI, and deployment details.
- [Event Logs](https://docs.dune.com/data-catalog/tron/decoded/event-logs.md): Smart Contracts emit event logs when certain predefined actions are completed.
- [Decoded Tron data](https://docs.dune.com/data-catalog/tron/decoded/overview.md): Simplifying smart contract analysis through human-readable tables.

##### Raw

- [tron.blocks](https://docs.dune.com/data-catalog/tron/raw/blocks.md): Tron block data — block number, timestamp, witness address, and transaction count.
- [tron.logs](https://docs.dune.com/data-catalog/tron/raw/logs.md): Tron smart contract event logs — topics and data from TRC-20 transfers and protocol interactions.
- [tron.transactions](https://docs.dune.com/data-catalog/tron/raw/transactions.md): Tron transaction records — sender, recipient, contract calls, fees, and execution results.

##### Tokens

- [Tokens](https://docs.dune.com/data-catalog/tron/tokens/overview.md): Exploring the landscape of digital assets on the blockchain.
- [TRC1155 Transfers](https://docs.dune.com/data-catalog/tron/tokens/transfers/erc1155-transfers.md): Event logs for TRC1155 token transfers on the Tron blockchain.
- [TRC20 Transfers](https://docs.dune.com/data-catalog/tron/tokens/transfers/erc20-transfers.md): Event logs for TRC20 token transfers on the Tron blockchain.
- [TRC721 Transfers](https://docs.dune.com/data-catalog/tron/tokens/transfers/erc721-transfers.md): Event logs for TRC721 token transfers on the tron blockchain.

#### Yominet

- [Yominet Data](https://docs.dune.com/data-catalog/yominet/overview.md): Yominet blockchain data on Dune
- [Blocks](https://docs.dune.com/data-catalog/yominet/blocks.md): Yominet blockchain blocks data
- [Block Events](https://docs.dune.com/data-catalog/yominet/block_events.md): Yominet blockchain block events data
- [Message Events](https://docs.dune.com/data-catalog/yominet/message_events.md): Yominet blockchain message events data
- [Transactions](https://docs.dune.com/data-catalog/yominet/transactions.md): Yominet blockchain transactions data
- [Transaction Messages](https://docs.dune.com/data-catalog/yominet/tx_messages.md): Yominet blockchain transaction messages data

### Protocols

#### Kalshi

- [Kalshi](https://docs.dune.com/data-catalog/kalshi/overview.md): Kalshi event contracts data on Dune
- [kalshi.market_report](https://docs.dune.com/data-catalog/kalshi/market_report.md): Kalshi market metadata — event contract details, categories, settlement rules, and current status.
- [kalshi.trade_report](https://docs.dune.com/data-catalog/kalshi/trade_report.md): Kalshi trade data — individual trades on event contracts with price, size, and execution details.

#### LayerZero

- [LayerZero](https://docs.dune.com/data-catalog/layerzero/overview.md): LayerZero crosschain data on Dune
- [layerzero.messages](https://docs.dune.com/data-catalog/layerzero/messages.md): LayerZero cross-chain messages — message payloads, endpoints, and routing data.
- [layerzero.transfers](https://docs.dune.com/data-catalog/layerzero/transfers.md): LayerZero cross-chain token transfers — bridged assets with source/destination chain details.

#### Succinct

- [Succinct](https://docs.dune.com/data-catalog/succinct/overview.md): Succinct protocol data on Dune
- [succinct.bids](https://docs.dune.com/data-catalog/succinct/bids.md): Succinct prover bids — bid amounts, prover addresses, and auction outcomes.
- [succinct.requests](https://docs.dune.com/data-catalog/succinct/requests.md): Succinct proof generation requests — proof type, input parameters, and submission details.

### Partner Data

#### Flashbots

- [Flashbots Data](https://docs.dune.com/data-catalog/community/flashbots/overview.md): Flashbots data on Dune
- [dune.flashbots.dataset_mempool_dumpster](https://docs.dune.com/data-catalog/community/flashbots/mempool-dumpster.md): Flashbots mempool data — pending transactions captured from the public mempool.

#### Farcaster

- [Farcaster data from Neynar](https://docs.dune.com/data-catalog/community/farcaster/overview.md): Neynar is the development platform for web3 social protocols. Neynar makes Farcaster protocol data available on Dune.
- [dune.neynar.dataset_farcaster_casts](https://docs.dune.com/data-catalog/community/farcaster/casts.md): Farcaster casts — posts, replies, and threads across the Farcaster social protocol.
- [dune.neynar.dataset_farcaster_fids](https://docs.dune.com/data-catalog/community/farcaster/fids.md): Farcaster FIDs — unique user identifiers and registration data.
- [dune.neynar.dataset_farcaster_fnames](https://docs.dune.com/data-catalog/community/farcaster/fnames.md): Farcaster usernames — fname registrations and ownership history.
- [dune.neynar.dataset_farcaster_links](https://docs.dune.com/data-catalog/community/farcaster/links.md): Farcaster social links — follow/unfollow relationships between users.
- [dune.neynar.dataset_farcaster_profile_with_addresses](https://docs.dune.com/data-catalog/community/farcaster/profile_with_addresses.md): Farcaster profiles with verified addresses — user profiles linked to Ethereum addresses.
- [dune.neynar.dataset_farcaster_reactions](https://docs.dune.com/data-catalog/community/farcaster/reactions.md): Farcaster reactions — likes and recasts on posts.
- [dune.neynar.dataset_farcaster_signers](https://docs.dune.com/data-catalog/community/farcaster/signers.md): Farcaster signers — authorized signing keys for user accounts.
- [dune.neynar.dataset_farcaster_storage](https://docs.dune.com/data-catalog/community/farcaster/storage.md): Farcaster storage allocations — storage units purchased per user.
- [dune.neynar.dataset_farcaster_user_data](https://docs.dune.com/data-catalog/community/farcaster/user_data.md): Farcaster user data — profile fields like bio, display name, and avatar.
- [dune.neynar.dataset_farcaster_verifications](https://docs.dune.com/data-catalog/community/farcaster/verifications.md): Farcaster address verifications — Ethereum addresses verified by Farcaster users.
- [dune.neynar.dataset_farcaster_warpcast_power_users](https://docs.dune.com/data-catalog/community/farcaster/power_badge.md): Warpcast power badge holders — users with the verified power badge on Warpcast.

#### Lens

- [Lens data](https://docs.dune.com/data-catalog/community/lens/overview.md): Lens.xyz data on Dune
- [dune.lens.namespace_handle](https://docs.dune.com/data-catalog/community/lens/namespace-handle.md): Lens Protocol handles — registered usernames in the Lens namespace.
- [dune.lens.namespace_handle_link](https://docs.dune.com/data-catalog/community/lens/namespace-handle-link.md): Lens handle-to-profile links — mappings between handles and profile NFTs.
- [dune.lens.profile_follower](https://docs.dune.com/data-catalog/community/lens/profile-follower.md): Lens follower relationships — who follows whom on the Lens Protocol.
- [dune.lens.profile_follow_module](https://docs.dune.com/data-catalog/community/lens/profile-follow-module.md): Lens follow modules — follow conditions and configurations per profile.
- [dune.lens.profile_follow_module_record](https://docs.dune.com/data-catalog/community/lens/profile-follow-module-record.md): Lens follow module events — follow module activation and update records.
- [dune.lens.profile_metadata](https://docs.dune.com/data-catalog/community/lens/profile-metadata.md): Lens profile metadata — display names, bios, avatars, and profile attributes.
- [dune.lens.profile_record](https://docs.dune.com/data-catalog/community/lens/profile-record.md): Lens profile records — profile creation and ownership data.
- [dune.lens.publication_metadata](https://docs.dune.com/data-catalog/community/lens/publication-metadata.md): Lens publication metadata — content type, tags, and media attachments for posts.
- [dune.lens.publication_open_action_module](https://docs.dune.com/data-catalog/community/lens/publication-open-action-module.md): Lens open action modules — collect, tip, and custom action configurations on publications.
- [dune.lens.publication_open_action_module_acted_record](https://docs.dune.com/data-catalog/community/lens/publication-open-action-module-acted-recorded.md): Lens open action events — records of users executing actions on publications.
- [dune.lens.publication_open_action_module_multirecipient](https://docs.dune.com/data-catalog/community/lens/publication-open-action-module-acted-multirecipient.md): Lens multi-recipient action modules — revenue split configurations for publication actions.
- [dune.lens.publication_reaction](https://docs.dune.com/data-catalog/community/lens/publication-reaction.md): Lens reactions — likes, mirrors, and other reactions on publications.
- [dune.lens.publication_record](https://docs.dune.com/data-catalog/community/lens/publication-record.md): Lens publication records — posts, comments, and mirrors with content references.
- [dune.lens.publication_reference_module](https://docs.dune.com/data-catalog/community/lens/publication-reference-module.md): Lens reference modules — comment and mirror permission configurations.

#### Reservoir

- [Reservoir NFT trading data](https://docs.dune.com/data-catalog/community/reservoir/overview.md): Reservoir makes open-source NFT trading infrastructure enabling the next generation of NFT products.
- [Ask Events](https://docs.dune.com/data-catalog/community/reservoir/ask-events.md)
- [Asks](https://docs.dune.com/data-catalog/community/reservoir/asks.md)
- [Attribute Keys](https://docs.dune.com/data-catalog/community/reservoir/attribute-keys.md)
- [Attributes](https://docs.dune.com/data-catalog/community/reservoir/attributes.md)
- [Bid Events](https://docs.dune.com/data-catalog/community/reservoir/bid-events.md)
- [Bids](https://docs.dune.com/data-catalog/community/reservoir/bids.md)
- [Collection Floor Ask Events](https://docs.dune.com/data-catalog/community/reservoir/collection-floor-ask-events.md)
- [Collection Top Bid Events](https://docs.dune.com/data-catalog/community/reservoir/collection-top-bid-events.md)
- [Collections](https://docs.dune.com/data-catalog/community/reservoir/collections.md)
- [Sales](https://docs.dune.com/data-catalog/community/reservoir/sales.md)
- [Token Attributes](https://docs.dune.com/data-catalog/community/reservoir/token-attributes.md)
- [Token Floor Ask Events](https://docs.dune.com/data-catalog/community/reservoir/token-floor-ask-events.md)
- [Tokens](https://docs.dune.com/data-catalog/community/reservoir/tokens.md)

#### Snapshot

- [Snapshot Data](https://docs.dune.com/data-catalog/community/snapshot/overview.md): Snapshot data is available on Dune
- [dune.shot.dataset_proposals_view](https://docs.dune.com/data-catalog/community/snapshot/proposals.md): Snapshot governance proposals — proposal text, voting options, and results.
- [dune.shot.dataset_votes_view](https://docs.dune.com/data-catalog/community/snapshot/votes.md): Snapshot votes — individual voting records with choice, voting power, and timestamp.
- [dune.shot.dataset_users](https://docs.dune.com/data-catalog/community/snapshot/users.md): Snapshot users — governance participant profiles and activity.
- [dune.shot.dataset_spaces_view](https://docs.dune.com/data-catalog/community/snapshot/spaces.md): Snapshot governance spaces — DAO and protocol governance space metadata.
- [dune.shot.dataset_follows](https://docs.dune.com/data-catalog/community/snapshot/follows.md): Snapshot space follows — users subscribed to governance spaces.

### Dune Index

- [Dune Index](https://docs.dune.com/data-catalog/dune-index/introduction.md): The Dune Index is a comprehensive indicator of blockchain adoption across the industry.
- [Transaction Fees](https://docs.dune.com/data-catalog/dune-index/gas-fees.md): Understanding transaction fees and their relationship to transaction costs in blockchain networks
- [Net USD Transferred](https://docs.dune.com/data-catalog/dune-index/net-transfers.md): Understanding net USD transferred as a component of the Dune Index
- [Transactions](https://docs.dune.com/data-catalog/dune-index/transactions.md): Understanding transactions as a foundational component of the Dune Index
