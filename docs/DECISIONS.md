# Decisions

One row per decision in the table; detailed module decisions follow in sections below it. Newest last. "Owner" means the owner made it; everything else was decided from the evidence linked.

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
| 2026-10-03 | Promotion needs n ≥ max(300, n_power(σ̂)) out-of-sample holdout trades with the 95% CI above zero, plus e-process and the other gates | Owner's 300 floor; the audit showed the first estimate had 50% power | [empirical.md](research/empirical.md) Audit, [quant.md](research/quant.md) §5, §8 |
| 2026-10-03 | Dashboard is Vite + React (WEB-1), Android via Capacitor (APP-1) | Built that way; static app talking to the worker API | PR #1, `PROJECT_STATE.md` |
| 2026-10-03 | Trade-size limits move from code constants in `costs` to configuration (CFG-1) | Owner rule: limits are never constants | `CLAUDE.md`, PR #2 |
| 2026-10-03 | Historical backtest (≥ 30 days, target 60+, transaction by transaction) replaces the 7-day live wait; a 48-hour live dry run runs in parallel; the strategy is proven on the backtest holdout and the dry run must stay consistent with it (owner) | Faster proof on more data | `CLAUDE.md` pre-funding gate |
| 2026-10-03 | Backtests are blind and reproduce live: simulated clock, as-of lookups, outcomes scored in a separate stage; same engine code live and backtest; leak test and parity test required (owner) | Owner rule | `CLAUDE.md` |
| 2026-10-03 | One deterministic engine core reads only an injected Clock and Feed (ENG-1); the backtester (BT-1) is built in Wave B, before the worker, and runs the random control first | Makes leaks impossible by construction and puts the proof on the critical path | [ARCHITECTURE.md](ARCHITECTURE.md) §16, §20 |
| 2026-10-03 | Our order is inserted into the real historical trade sequence after modelled latency, after all real trades in its slot, and later trades see its impact | Conservative fills; candles cannot order barrier touches | [quant.md](research/quant.md) §7 |
| 2026-10-03 | LEDGER-1 data shape approved by the supervisor: public market data, the bot's decisions, trades, fills and labels, no personal data (supervisor) | `CLAUDE.md` stored-data ruling | [quant.md](research/quant.md) §9, [ARCHITECTURE.md](ARCHITECTURE.md) §20 |
| 2026-10-03 | Secrets never pass through chat: the bot wallet is generated on the host; API keys entered by the owner in the dashboard's protected settings, the VPS console or GitHub secrets | Keys must never reach chat, repo, logs or prompts | `AGENTS.md`, [ARCHITECTURE.md](ARCHITECTURE.md) §12.2 |
| 2026-10-03 | Zero-cost fallback for the 48 h dry run: chained GitHub Actions jobs with state carried between them, each boundary a restart drill; marked lower fidelity; the VPS run is still needed for full item 3 (supervisor) | Pre-funding work never waits on the owner's signup | [ARCHITECTURE.md](ARCHITECTURE.md) §20 OPS-1 |

## Order and position lifecycle (CORE-1, `packages/core/src/lifecycle`)

- **2026-10-03 · A failed signature read is terminal only at `finalized`.** A failure read at `processed` or `confirmed` may come from a fork that is later dropped, and the original transaction could still land. Acting on it would allow a replacement, which could mean a second buy or an oversell. Waiting for `finalized` costs about 13 s. A success read counts from `confirmed`: booking a fill early is safe, because the books stay open until every other attempt is dead.
- **2026-10-03 · An attempt is dead only when it has failed at `finalized`, or when the confirmed block height has passed its `lastValidBlockHeight`.** A replacement may be signed, and the books closed, only when every other attempt is dead. Each of these events carries the block height it was read at: `sign_replacement` and `reconcile`.
- **2026-10-03 · Balances are the truth.** A fill found after a failed or expired status is booked, and a critical alert is raised. If more than one attempt landed, all of them are booked (`double_fill` alert). A landing reported after the books closed raises `unbooked_landing` for a person to resolve, because that intent is final.
- **2026-10-03 · A restart while `signed` never sends the bytes.** The intent becomes `unknown` and waits for expiry, because we cannot prove whether the bytes left before the restart.

## Evidence (`packages/core/src/domain`)

- **2026-10-03 · `checkFreshness` checks age and timestamps only.** It does not reject evidence flagged `fork-suspect`, `provider-degraded`, `partial` or `estimated`, nor evidence read at `processed` commitment. The evidence-gates task must reject these: unknown or degraded evidence is a failure, never a pass. Until that gate exists, `checkFreshness` alone does not prove evidence usable.
