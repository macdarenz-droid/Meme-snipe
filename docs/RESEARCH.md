# Research

One short summary per topic, with the key numbers. The full reports, with sources, are in `docs/research/`. All research dated 2026-10-03; SOL about $119.

## Empirical study of pump.fun graduations ([empirical.md](research/empirical.md))
Our own survivorship-free study: 518 graduations in a 12-hour window plus about 1 hour live, raw data and scripts in `research/empirical/`.
- 72 entry and exit rules tested after costs on 361 standard graduations: **0 positive, 65 with the 95% CI entirely below zero**. Tightest estimate −7.4% per trade (CI −9.2% to −5.4%).
- Median price from migration: +101% at 5 min, −80% at 15 min, −93% at 1 h. 71–76% lost ≥ 80% within 1 h; 92–93% a day later. Median pool liquidity $16.1k at migration, $225 a day later.
- 76% graduated within 5 minutes of creation (instant, bundled launches, dev holding ~79%). 21.6% were dust pools (< 5 SOL).
- Negative signals: price above migration price at +5 min (median −97% at 1 h vs −67%), instant graduation. "Less bad" signals all still lost money.
- Audit: conclusion holds under every perturbation; the sample-size estimate was at 50% power, so roughly double it for 80%; fixed costs were optimistic for early entries.

## Venues and lifecycle ([venues.md](research/venues.md))
- pump.fun is ~70–80% of launchpad volume ($177.5M/day curve); PumpSwap $321M/day. ~49.7k launches and ~2.6% graduation in the last 24 h (measured).
- Fees: curve 1.25% per side; canonical PumpSwap 1.25% below 420 SOL market cap, 1.20% to 1,470 SOL, down to 0.30% at 98,240 SOL; non-canonical 0.30%. Graduation is at ~411 SOL (~$49k).
- 2026 changes: Token-2022 mints (`create_v2`), USDC-quoted coins, BOOST (17.6 SOL buy-and-burn in the first 5 min after migration), mayhem mode, holder rewards, signed negative `virtual_quote_reserves` from 2026-09-30.
- Allowlist PumpSwap canonical SOL pools first; curve paper only; LaunchLab and Meteora only after per-pool fee decoding.
- Regime gate inputs: own launch and graduation counts, graduate survival, DefiLlama volume, SOL trend.

## Data feeds ([data.md](research/data.md))
- Helius Free: 1M credits, 10 RPS, WebSockets metered (2 credits per 0.1 MB, ~50 GB/month), 5 connections, no `transactionSubscribe`. Jupiter free key: 1 RPS shared by quotes, Tokens and Price; `/execute` 50 RPS separate.
- Full pump log stream: 184 tx/s, ~14M credits/month: not affordable. PumpPortal trade streams ~$217/day: not affordable.
- PumpPortal free creates and migrations: as fast as RPC (p50 24 ms earlier) but missed 13.6% of creates, so run two discovery feeds.
- `accountSubscribe` on 20 curves ≈ 70k credits/month vs 2M for logs. Discovery latency of seconds is fine; spend on exit monitoring.
- First upgrade: Helius Developer $49/month, only on measured need.

## Execution and costs ([execution.md](research/execution.md))
- Rent fell (SIMD-0437): 165-byte account 1,488,440 lamports; Token-2022 pump ATA 1,513,840; more cuts expected Nov 2026.
- Round trip: ~2.97% on the curve, ~2.80% on a 1.20% PumpSwap pool at $2. Break-even gross move ~+3%.
- Jupiter Swap V2: `/order`+`/execute` (managed) and `/build` (no platform fee). Documented 50 bps for young tokens; live quotes all showed 10 bps. RTSE picked 20% slippage: always override.
- Landing: Helius Sender SWQoS-only (5,000-lamport tip) is best value; 0.001 SOL fast lanes cost 6% of a $2 leg. Rebroadcast the same bytes until expiry; replace only after.
- Sandwiching a single $2–$5 pump trade costs the attacker more than it gains; tight min-out is the main defence.
- Libraries: `@solana/kit` + Codama builders; no `@solana/web3.js`.

## Token safety ([safety.md](research/safety.md))
- Most checks are local and deterministic: mint program, authorities, Token-2022 extension allowlist, canonical pool, LP state.
- New pump mints have null authorities; the main risk is economic (pump-and-dump 78.9% of rugs, liquidity pulls 20.4%, freeze 0.6%).
- Holder concentration must exclude the curve ATA, pool vaults, the mayhem vault, lockers and burns. RugCheck's single-holder flag misfires on mayhem tokens.
- Simulated sells prove "sellable now", not later. Ranked hard gates H1–H12 and soft features.

## Risk management ([risk.md](research/risk.md))
- A $2 trade with a 15% stop loses about $0.58 (2.9% of $20) per losing trade; the 2% rule is impossible at $2, so portfolio limits do the work.
- Monte Carlo: with a near-zero edge, $5 sizing gives a 35.5% chance of halving the bankroll; daily stop + kill switch cut it to 5.2%.
- Kelly is unusable before hundreds of trades. Copy trading kept ~3% of leaders' 14% per trade.
- Policy R1–R24 with defaults; candidate paper strategies S0 (random control) to S5.

## Quant methodology ([quant.md](research/quant.md))
- Execution-aware triple-barrier labels on executable value replayed per slot; wick-versus-close fills alone flipped one rule from −20.5% to +0.5%.
- Purged, embargoed, cluster-grouped walk-forward with one untouched holdout; experiment registry for deflated Sharpe and PBO.
- Detecting +5% per trade at 80% power needs ~258 trades (σ 0.32) with quant.md's one-sided test; the architecture's gate uses the owner's two-sided 95% CI (~321 for independent trades) and sets the final n by simulating its full rule (`ARCHITECTURE.md` §14). Runner strategies need thousands. The live account cannot supply that many trades; the proof comes from the historical backtest holdout, checked with an anytime-valid betting test.
- Predictors decay within weeks (AUROC 0.86 → 0.46) and do not transfer across venues. Gates G0–G4 and automatic demotion.

## Security and hosting ([security.md](research/security.md))
- Local Ed25519 signer with zero npm dependencies, no network, encrypted systemd credential; default-deny policy that never trusts lookup-table addresses in user positions.
- Supply chain is the likeliest key loss (2024 web3.js backdoor targeted bots): exact pins, 7-day release age, no build scripts.
- Frankfurt VPS ~$6/month; SQLite WAL instead of Postgres; Cloudflare cron watchdog and Durable Object heartbeat (free); Tunnel + Access + passkey step-up.

## Funding from Australia ([funding.md](research/funding.md))
- Stripe's onramp is US/EU only. Use an Australian exchange: Independent Reserve (about A$0.27 in fees on A$20) or Kraken (free AUD withdrawals, 0.005 SOL withdrawal fee).
- In-app widgets (Banxa, MoonPay, Transak) need a registered business. Deposit shows the bot address; Withdraw sends only to the owner's saved wallet.
- Every swap is a CGT event; keep records for 5 years.

## Brand ([brand.md](research/brand.md))
- Premium marks are one solid idea carried by negative space, one colour first, depth only on the app icon. Led to the "Slot" mark (`docs/BRAND.md`).

## Still open
- RES-2 whale copy-trading study: results pending.
- Every report now ends with an independent "Fact-check" section (59 claims confirmed, 11 contradicted). The corrections are applied in `docs/ARCHITECTURE.md` and listed below.

## Fact-check corrections (2026-10-03)
- Venues: a transaction that mentions the migration authority is a migration only if it carries `CompletePumpAmmMigrationEvent` (~70% do). Never read the creator fee from `Global`. A fresh graduate holds ~67.4 SOL real plus ~17.6 SOL virtual quote reserve (BOOST).
- Data: DexScreener `tokens/v1` is 300/min, not 60. DexScreener has a WebSocket, but only for profiles and boosts. LaserStream runs in 9 regions, not 7.
- Execution: the Jito tip-floor figures were wrong and the percentiles move 3–5× within a minute, so read them live. A blockhash now lives ~40–48 s (slots ~0.27–0.32 s), not 60–90 s.
- Safety: a PermanentDelegate can be revoked (by the current delegate). LaunchLab now splits migrated LP two ways. GoPlus returns `{authority, status}` objects; only three fields have `_upgradable`; missing keys, not nulls.
- Risk: MELT's 60.71% loss is a no-fee, rebalanced-sample upper bound (v2 reports a 34-point cut). The "17% wash trades" headline is not reproducible from the paper's own counts. The "82.8% manipulated" figure mixes wash trading, LP inflation and concentration.
- Quant: MELT's best AUPRC is 0.5827 (ensemble). Conformal risk control does not bound loss among accepted trades; use conformal selection for that. The AUROC 0.86 → 0.46 drop partly reflects unreliable labels.
- Security: `blockExoticSubdeps` is opt-in on pnpm 10 (default true only from v11), so it must be set explicitly.
