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
| CORE-1 | Domain types, order and position lifecycle | session_01SWQzPEHWtr3oCxUuGCCWxX | Opus 5.5 ultracode | in review: PR #3, reviewer session_01JdWkiMz8Kgi9avfrPQWbEv | 20–40 m |
| CORE-2 | AMM quotes (pump curve, PumpSwap), cost model, feasible size | session_0137WgVKuV7YThAEDRTjWsJ5 | Opus 5.5 ultracode | building | 1.5–2.5 h |
| WEB-1 | Dashboard shell, two themes, motion, copy guard | session_01Ex3DnPXKguKRwSY7utcsPQ | Opus 5.5 ultracode | in review: PR #1, reviewer session_01XnyTYevtLoRFMdiwmaqqbV | 20–40 m |
| APP-1 | Android preview APK at a fixed link (Capacitor, CI build) | session_01BLFtAQaZGeQKqXMBYYdLpJ | Sonnet 5.5 | building | 1–1.5 h |
| RES-2 | Whale copy-trading study on real data (owner's idea) | session_01RXNoLW48c8Xj7FYScEujRg | Opus 5.5 ultracode | researching | 2–3 h |
| DOCS-1 | Architecture improved from research | — | Opus 5.5 | waiting on research | 1–1.5 h incl. review |
| Queued | Risk policy and sizing; evidence gates; exits; paper fills; stats and promotion gates; provider adapters and quota scheduler; ledger; paper worker; dashboard data screens; Deposit/Withdraw; TEST-1 market recorder and deterministic replay; TEST-2 dry-run transaction simulation; TEST-3 soak and fault injection | — | — | after DOCS-1 | 6–10 h in waves of 3–4 |

## Next
- Finish the research and a measured base-rate study of live Solana data.
- Improve `docs/ARCHITECTURE.md` in place from the findings; record decisions in `docs/DECISIONS.md`.
- Build the core engine (risk, costs, gates, exits, order lifecycle, paper fills) with tests.
- Then the paper worker on live data, then the dashboard (charts and motion as above), with a copy guard test that fails on AI wording.

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
- No `main` branch exists yet, so no pull request can be opened.
