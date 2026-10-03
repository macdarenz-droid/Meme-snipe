# Project state

## Owner goals
- An intelligent, precise, fast sniper that is above all risk aware and trades like a disciplined professional.
- Consistency. Risk aware, data aware. Research based on what actually matters in the market.
- No guessing: the bot acts only when the data proves the setup. Unknown or stale evidence means no trade.
- Bankroll $20, entries $2 default and $5 max, paper mode first.
- Easy deposit and withdraw in AUD (route under research).
- Dashboard: P&L calendar, trade history with full details, profit charts and the other visuals needed to see what the bot is doing. Smooth UI: motion, transitions, blurred backdrops behind opened panels.
- UI words read as written by a person: no AI wording anywhere (see `AGENTS.md`).
- App name: Zeroed (owner, 2026-10-03). Logo: concepts A–F shown, not chosen yet.

## Phase
Research and architecture (in progress).

## Done
- Owner rules copied into `AGENTS.md`; the starting brief is `docs/ARCHITECTURE.md`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5).

## Next
- Finish the research and a measured base-rate study of live Solana data.
- Improve `docs/ARCHITECTURE.md` in place from the findings; record decisions in `docs/DECISIONS.md`.
- Build the core engine (risk, costs, gates, exits, order lifecycle, paper fills) with tests.
- Then the paper worker on live data, then the dashboard (charts and motion as above), with a copy guard test that fails on AI wording.

## Open questions
- No `main` branch exists yet, so no pull request can be opened.
