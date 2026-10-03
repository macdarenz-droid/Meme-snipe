# Project state

## Owner goals
- An intelligent, precise, fast sniper that is above all risk aware and trades like a disciplined professional.
- Consistency. Risk aware, data aware. Research based on what actually matters in the market.
- No guessing: the bot acts only when the data proves the setup. Unknown or stale evidence means no trade.
- Bankroll $20, entries $2 default and $5 max, paper mode first. This is the trial setting only: capital and trade size are configuration and will scale once the bot proves itself.
- Easy deposit and withdraw in AUD. Stripe's onramp does not serve Australia (US and EU only). Deposit and Withdraw screens offer two exchanges to choose from, Independent Reserve and Kraken, with steps and costs; the bot only sends to the owner's saved wallet. Banxa in-app buying is possible later if a business (ABN) is registered.
- Dashboard: P&L calendar, trade history with full details, profit charts and the other visuals needed to see what the bot is doing. Smooth UI: motion, transitions, blurred backdrops behind opened panels.
- Two themes only: Paper (light) and Silent Black (dark); first open follows the device, then the owner's choice is remembered.
- UI words read as written by a person: no AI wording anywhere (see `AGENTS.md`).
- App name: Zeroed. Logo: "Slot" (a solid zero with a Z cut into it), files in `brand/`, rules in `docs/BRAND.md`.

## Phase
Build wave 1 in review; historical data collection running; the whale test result is due about 03:05 Melbourne time (AEDT from 4 Oct).

## Done
- Owner rules in `AGENTS.md` and `CLAUDE.md`; the starting brief and the research in `docs/`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5); CI on every PR.
- Brand files and guide (`brand/`, `docs/BRAND.md`).
- Merged: WEB-1 (PR #1), CORE-2 (PR #2), CORE-1 (PR #3), APP-1 (PR #5), DOCS-1 (PR #6: architecture, RESEARCH.md, DECISIONS.md, build plan), CORE-1b (PR #7).
- Android preview APK at a fixed link: https://github.com/macdarenz-droid/Meme-snipe/releases/download/preview/zeroed-preview.apk (sample data only). Real backtest results will show in its Backtest view once BT-1 publishes its first report (UI-2 loads it from the `backtest` release).
- All four API keys checked from CI: they work.

## Board
Builders run as separate sessions; a fresh reviewer session checks each PR; the supervisor merges into `ccr-14987baf-i6lrsl` when review passed and CI is green on a head with the latest base.

| Task | What | Session | Model | State | Estimate |
|---|---|---|---|---|---|
| DOCS-1b | Pre-seal counts limited to candidates and entries; TEST-3 measures the veto gap | session_01F8fZH2zSWeP984nqQB1HyJ | Opus 5.5 ultracode | PR #15 in review (session_01GrWm1qi75dgDuChcakeCNK) | 15–20 m |
| ENG-1 | Engine core: clock, feed, as-of store, leak and shift tests | session_015eEk2vjphRpvRDPMhLAfQp | Opus 5.5 ultracode | PR #10 changes: no ledger imports from the engine, balance-reconcile share, runtime trap | 45–60 m |
| LEDGER-1 | SQLite ledger, outbox, atomic reservations, label isolation | session_01HjeNL7DBQbW9j2xhUU8UST | Opus 5.5 ultracode | PR #9 passed review; CI caught a writer-lock race (0 of 6 writers), builder fixing | 30–45 m |
| STATS-1 | Labels, statistics, promotion gates | session_011t7agWEjn8osZJ4eD9FisM | Opus 5.5 ultracode | PR #8 G2 per §14 done (2968674); 6 review items and pre-seal counts in progress | 1.5–2 h |
| DEC-1 | Chain decoders (pump, PumpSwap, FeeConfig, Token-2022, events, v0/v1 messages) | session_01NMd1PaTb9y2BMfW1SvbkG9 | Opus 5.5 ultracode | PR #11 changes: 3 test gaps, type fix | 45–60 m |
| CFG-1 | Versioned policy, session lock, tighten-only overrides | session_018SmN7MjYc6frMdaZWkwk4p | Opus 5.5 ultracode | PR #13 changes: 8 review items | 1–1.5 h |
| CORE-2b | Typed no-quote reasons, coin guard, v2 vault accounting | session_0137WgVKuV7YThAEDRTjWsJ5 | Opus 5.5 ultracode | PR #14 building (golden vector search) | 30–60 m |
| APP-1b | Android preview hardening | session_01BLFtAQaZGeQKqXMBYYdLpJ | Sonnet 5.5 | PR #12 re-review at 08f8278 (session_01KwWEL3iaG8MxZYYx19a1m9) | 20–30 m |
| DATA-1 | Historical on-chain data (30–60 days, transaction-level) for backtesting | session_01XHH3k24fjmkpmmt28xSaYv | Opus 5.5 ultracode | collecting | first 7 days 2–3 h; 30 days 4–8 h |
| RES-2 | Whale copy-trading study on real data (owner's idea) | session_01RXNoLW48c8Xj7FYScEujRg | Opus 5.5 ultracode | PR #4, pre-registered forward test running | result about 03:05 AEDT |
| OPS-1 | Host installer, encrypted secret handoff, watchdog, alerts, backups | session_01Euok5FXtBGZBrweohP3K93 | Opus 5.5 ultracode | building | 2–2.5 h |
| UI-2 | Dashboard data screens: funnel, journal, position, P&L calendar, history, charts | session_01FPiuFckRHx143gk9g7A1re | Opus 5.5 ultracode | building | 2–3 h |
| FUND-1 | Deposit and Withdraw screens, two exchanges | session_01S7paz3YTUxTPdwVF54HgXA | Sonnet 5.5 medium | building | 1–1.5 h |
| LEDGER-REPLAY | Rebuild positions and P&L from the ledger alone and match the live state (pre-funding check) | — | Opus 5.5 ultracode | queued with BT-1 | 1 h |
| Queued | Build plan in docs/ARCHITECTURE.md §20 (PR #6): Wave B RISK-1 (after CFG-1), GATE-1 (after DEC-1, CFG-1, ENG-1), BT-1 (after ENG-1, DEC-1, LEDGER-1, DATA-1 format), FEED-1, TX-1 (after DEC-1); Wave C EXIT-1; Wave D BT-2, WORKER-1, RUN-1; Wave E TEST-1..3; later SIGN-1 | — | — | by dependency | about 37–47 h of build, 15–20 h wall time |

## Owner setup
- Hosting approved by the owner (2026-10-03): about US$6/month, Vultr High Performance in Frankfurt; Hetzner as backup. The server is created only when OPS-1's setup script is ready.
- API keys are in GitHub repository secrets and verified: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` (bot @Zeroed_alerts_bot). Never in chat or in the repo.
- Vultr payment: the card was declined by the bank (overseas USD charge). Owner to allow online/overseas payments for the card or use PayPal. Not blocking until OPS-1.
- Domain: none owned, none needed now (watchdog on `workers.dev`, dry run headless). Buying one later is a paid service, so the owner decides when the dashboard goes online.
- Telegram bot display name: change with /setname in BotFather (optional).

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
