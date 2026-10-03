# Project state

## Owner goals
- An intelligent, precise, fast sniper that is above all risk aware and trades like a disciplined professional.
- Consistency. Risk aware, data aware. Research based on what actually matters in the market.
- No guessing: the bot acts only when the data proves the setup. Unknown or stale evidence means no trade.
- Bankroll $20, entries $2 default and $5 max, paper mode first.

## Phase
Research and architecture (in progress).

## Done
- Owner rules copied into `AGENTS.md`; the starting brief is `docs/ARCHITECTURE.md`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5).

## Next
- Finish the research and a measured base-rate study of live Solana data.
- Improve `docs/ARCHITECTURE.md` in place from the findings; record decisions in `docs/DECISIONS.md`.
- Build the core engine (risk, costs, gates, exits, order lifecycle, paper fills) with tests.

## Open questions
- No `main` branch exists yet, so no pull request can be opened.
