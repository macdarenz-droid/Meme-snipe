# Decisions

One row per decision. Newest decisions are added at the bottom. "Owner" means the owner made it; everything else was decided from the evidence linked.

| Date | Decision | Why | Evidence |
| --- | --- | --- | --- |
| 2026-10-03 | Name Zeroed; "Slot" logo (owner) | Owner choice after logo research | [BRAND.md](BRAND.md), [brand.md](research/brand.md) |
| 2026-10-03 | Two themes only, Paper and Silent Black; first open follows the device (owner) | Owner choice | [ARCHITECTURE.md](ARCHITECTURE.md) §17 |
| 2026-10-03 | No AI wording in the UI, enforced by a build-failing guard test (owner) | Owner rule | `CLAUDE.md` |
| 2026-10-03 | Trades only when data proves the setup; missing, stale or unproven evidence means no trade (owner) | Owner rule | `CLAUDE.md` |
| 2026-10-03 | Bankroll, trade sizes, loss limits and position count are configuration; only the owner raises them (owner) | Capital will scale after proof | `CLAUDE.md` |
| 2026-10-03 | Six-check pre-funding gate before any deposit (owner) | Owner rule | `CLAUDE.md`, [ARCHITECTURE.md](ARCHITECTURE.md) §15 |
| 2026-10-03 | Deposit and Withdraw offer Independent Reserve and Kraken; the bot only sends to the owner's saved wallet (owner) | Stripe does not serve Australia | [funding.md](research/funding.md) §1, §6 |
| 2026-10-03 | Dashboard wishes: P&L calendar, trade history, profit charts, motion and blurred backdrops (owner) | Owner request | `PROJECT_STATE.md` |
| 2026-10-03 | Reports to the owner give times in Melbourne time (owner) | Owner rule | `CLAUDE.md` |
| 2026-10-03 | Paper mode only; no entries from launch through migration + 60 min | 0 of 72 graduation rules positive after costs; median −93% at 1 h | [empirical.md](research/empirical.md) |
| 2026-10-03 | Paper universes: U1 survivors (24 h–14 d, ≥ $50k liquidity), U2 post-graduation reclaim (60–240 min), U3 smart money after RES-2; each against a random control S0 | Selected after the dump window, cheaper fee tiers, recommended by the study and audit | [empirical.md](research/empirical.md) "Implications", [risk.md](research/risk.md) §8 |
| 2026-10-03 | Venue allowlist: PumpSwap canonical SOL pools only; curve recorded but not traded; LaunchLab and Meteora blocked until per-pool fee decoding | Liquidity, documented IDL, fees in events; other venues have variable or extreme fees | [venues.md](research/venues.md) §4.3 |
| 2026-10-03 | Reject mayhem-mode, USDC-quoted and non-canonical pools in the first release | Doubled supply and agent trades; second quote risk; withdrawable LP | [venues.md](research/venues.md) §9, [safety.md](research/safety.md) §2.1 |
| 2026-10-03 | Price PumpSwap on vault + signed `virtual_quote_reserves`; read fees from FeeConfig, never hard-code | Negative virtual reserves from 2026-09-30; fees change without notice | [venues.md](research/venues.md) §2.6, [execution.md](research/execution.md) §3.2 |
| 2026-10-03 | Ranked hard rejects H1–H16 incl. dust pools, instant graduations, holder ≥ 40%, pump chasing | Measured negative outcomes and safety research | [ARCHITECTURE.md](ARCHITECTURE.md) §7, [empirical.md](research/empirical.md), [safety.md](research/safety.md) §9 |
| 2026-10-03 | Token-2022 extensions handled by allowlist; unknown types reject | Several extensions can make a token unsellable | [safety.md](research/safety.md) §1.3 |
| 2026-10-03 | Expected net uses a tail-inclusive gross edge; cost gate at 5% or one third of the target | Stops do not cap memecoin losses | [risk.md](research/risk.md) §1.1, R12 |
| 2026-10-03 | Risk defaults as fractions of the bankroll: 1R ≤ 2.75%, daily trigger 7.5%, weekly 20%, kill at 70% of high-water mark, 3 live entries a day, 1 position | Monte Carlo ruin analysis; prop-firm practice | [risk.md](research/risk.md) §1.6, §7 |
| 2026-10-03 | Trading day for limits and the P&L calendar is Melbourne time | The owner's day | `CLAUDE.md` |
| 2026-10-03 | Exits trigger on executable liquidation value; flow, thesis and time stops; bounded escalation ladder; "exit blocked" shown honestly | Gaps and blocked exits dominate losses | [risk.md](research/risk.md) §2–3, [execution.md](research/execution.md) §10 |
| 2026-10-03 | Data stack: PumpPortal + RPC logs + Parsed Streams for discovery; Alchemy for the shortlist; two providers for the position; quota scheduler with P0–P3 | Free tiers cannot carry the full stream; exits come first | [data.md](research/data.md) §8 |
| 2026-10-03 | Direct pump/PumpSwap adapters first, Jupiter `/build` then `/order` as fallbacks; always set our own slippage; read `feeBps` per quote | Lower fees and latency; RTSE chose 20%; live fee differed from docs | [execution.md](research/execution.md) §2, §10 |
| 2026-10-03 | Land with Helius Sender SWQoS-only; reject 0.001 SOL fast lanes | 6% of a $2 leg | [execution.md](research/execution.md) §4.3 |
| 2026-10-03 | Read rent live; close the token account in the sell transaction | Rent fell with SIMD-0437 and will fall again | [execution.md](research/execution.md) §6 |
| 2026-10-03 | `@solana/kit` + Codama builders; no `@solana/web3.js`; signer has zero npm dependencies | Supply-chain attacks on key-holding bots | [execution.md](research/execution.md) §7, [security.md](research/security.md) §3 |
| 2026-10-03 | SQLite WAL (`node:sqlite`) instead of Postgres for the single worker | Free hosted Postgres sleeps or expires; no second writer | [security.md](research/security.md) §4.3 |
| 2026-10-03 | Host on a Frankfurt VPS (~$6/month), pending owner approval of the spend | Leader slots concentrate in Frankfurt | [security.md](research/security.md) §4 |
| 2026-10-03 | Local signer in an isolated process with a default-deny policy; no paid custody at this size; AWS KMS above ~$500 | Custody engines cannot check lookup-table addresses; per-signature fees exceed the edge | [security.md](research/security.md) §1–2 |
| 2026-10-03 | Cloudflare cron watchdog with Durable Object heartbeat; Telegram limited to `/pause` and `/status` | Separate failure domain at $0; low-trust channels can only make things safer | [security.md](research/security.md) §5 |
| 2026-10-03 | Labels: execution-aware triple barrier replayed per slot; validation: purged walk-forward, untouched holdout, experiment registry | Candle fills and multiple testing create false edges | [quant.md](research/quant.md) §1–2 |
| 2026-10-03 | Promotion needs n ≥ max(300, n_power(σ̂)) shadow trades with the 95% CI above zero, plus e-process and the other gates | Owner's 300 floor; the audit showed the first estimate had 50% power | [empirical.md](research/empirical.md) Audit, [quant.md](research/quant.md) §5, §8 |
| 2026-10-03 | Dashboard is Vite + React (WEB-1), Android via Capacitor (APP-1) | Built that way; static app talking to the worker API | PR #1, `PROJECT_STATE.md` |
| 2026-10-03 | Trade-size limits move from code constants in `costs` to configuration (CFG-1) | Owner rule: limits are never constants | `CLAUDE.md`, PR #2 |
