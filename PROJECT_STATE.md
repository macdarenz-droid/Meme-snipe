# Project state

## Owner goals
- An intelligent, precise, fast sniper that is above all risk aware and trades like a disciplined professional.
- Consistency. Risk aware, data aware. Research based on what actually matters in the market.
- No guessing: the bot acts only when the data proves the setup. Unknown or stale evidence means no trade.
- Bankroll $20, entries $2 default and $5 max, paper mode first.
- Easy deposit and withdraw in AUD. Stripe's onramp does not serve Australia (US and EU only). Deposit and Withdraw screens offer two exchanges to choose from, Independent Reserve and Kraken, with steps and costs; the bot only sends to the owner's saved wallet. Banxa in-app buying is possible later if a business (ABN) is registered.
- Dashboard: P&L calendar, trade history with full details, profit charts and the other visuals needed to see what the bot is doing. Smooth UI: motion, transitions, blurred backdrops behind opened panels.
- UI words read as written by a person: no AI wording anywhere (see `AGENTS.md`).
- App name: Zeroed. Logo: "Split" (a solid zero cut by a Z), files in `brand/`, rules in `docs/BRAND.md`.

## Phase
Research and architecture (in progress).

## Done
- Owner rules copied into `AGENTS.md`; the starting brief is `docs/ARCHITECTURE.md`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5).
- Brand files and guide (`brand/`, `docs/BRAND.md`).
- AUD funding route researched.

## Next
- Finish the research and a measured base-rate study of live Solana data.
- Improve `docs/ARCHITECTURE.md` in place from the findings; record decisions in `docs/DECISIONS.md`.
- Build the core engine (risk, costs, gates, exits, order lifecycle, paper fills) with tests.
- Then the paper worker on live data, then the dashboard (charts and motion as above), with a copy guard test that fails on AI wording.

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
- No `main` branch exists yet, so no pull request can be opened.
