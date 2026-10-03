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
Research finishing; build started on the parts that do not depend on it.

## Done
- Owner rules copied into `AGENTS.md`; the starting brief is `docs/ARCHITECTURE.md`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5).
- Brand files and guide (`brand/`, `docs/BRAND.md`).
- AUD funding route researched.

## Board
Builders run as separate sessions; the supervisor reviews and merges into `ccr-14987baf-i6lrsl`.

| Task | What | Session | Model | State | Estimate |
|---|---|---|---|---|---|
| CORE-1 | Domain types, order and position lifecycle | session_01SWQzPEHWtr3oCxUuGCCWxX | Opus 5.5 ultracode | fixing 3 blocking review findings (PR #3) | 30–60 m |
| CORE-2 | AMM quotes (pump curve, PumpSwap), cost model, feasible size | session_0137WgVKuV7YThAEDRTjWsJ5 | Opus 5.5 ultracode | building | 1.5–2.5 h |
| WEB-1 | Dashboard shell, two themes, motion, copy guard | session_01Ex3DnPXKguKRwSY7utcsPQ | Opus 5.5 ultracode | in review: PR #1, reviewer session_01XnyTYevtLoRFMdiwmaqqbV | 20–40 m |
| APP-1 | Android preview APK at a fixed link (Capacitor, CI build) | session_01BLFtAQaZGeQKqXMBYYdLpJ | Sonnet 5.5 | building | 1–1.5 h |
| DATA-1 | Historical on-chain data (30–60 days, transaction-level) for backtesting | session_01XHH3k24fjmkpmmt28xSaYv | Opus 5.5 ultracode | collecting | first 7 days 2–3 h; 30 days 4–8 h |
| RES-2 | Whale copy-trading study on real data (owner's idea) | session_01RXNoLW48c8Xj7FYScEujRg | Opus 5.5 ultracode | researching | 2–3 h |
| DOCS-1 | Architecture improved from research, RESEARCH.md, DECISIONS.md, build plan | session_01F8fZH2zSWeP984nqQB1HyJ | Opus 5.5 ultracode | draft PR #6, waiting on fact-checks | 15–30 m |
| STATS-1 | Labels, statistics, promotion gates | session_011t7agWEjn8osZJ4eD9FisM | Opus 5.5 ultracode | building | 2 h |
| DEC-1 | Chain decoders (pump, PumpSwap, FeeConfig, Token-2022, events, v0/v1 messages) | session_01NMd1PaTb9y2BMfW1SvbkG9 | Opus 5.5 ultracode | building | 2–3 h |
| Queued | Build plan in docs/ARCHITECTURE.md §20 (PR #6): Wave A ENG-1, CFG-1, LEDGER-1; Wave B BT-1, RISK-1, GATE-1, FEED-1, TX-1; Wave C EXIT-1, UI-2, FUND-1; Wave D BT-2, WORKER-1; Wave E OPS-1, TEST-1..3; later SIGN-1 | — | — | by dependency | about 37–47 h of build, 15–20 h wall time |

## Next
- Finish the research and a measured base-rate study of live Solana data.
- Improve `docs/ARCHITECTURE.md` in place from the findings; record decisions in `docs/DECISIONS.md`.
- Build the core engine (risk, costs, gates, exits, order lifecycle, paper fills) with tests.
- Then the paper worker on live data, then the dashboard (charts and motion as above), with a copy guard test that fails on AI wording.

## Owner setup
- Hosting approved by the owner (2026-10-03): about US$6/month, Vultr High Performance in Frankfurt; Hetzner as backup.
- API keys go into GitHub repository secrets (write-only; only this repo's workflows can read them): `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`. Never in chat or in the repo.
- Owner has Cloudflare and Telegram accounts. Vultr: account and payment now; the server itself is created when OPS-1's setup script is ready.

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
- No `main` branch exists yet, so no pull request can be opened.
