# H8 at trade size: amendment for D1, H1-CGO and the Step A count rows

Brainstorm partner, 2026-10-08 20:20 Melbourne, before any primary is scored. It comes from sweep 3 (`SWEEP_3.md`) and was checked in the code.

## Fact
- H8 (`packages/core/src/gates/hard.ts:286-315`, `policy.ts:205`) rejects a pool unless its effective quote (vault + virtual reserves), valued in USD with the hourly SOL/USD, is at least max($15,000, 1,000 × trade size).
- At $119.26 a SOL, that is about 126 SOL at $5, 168 SOL at $20 and 419 SOL at $50. A fresh graduate holds about 85 SOL.
- D1's and H1-CGO's universes start at 50 SOL of effective quote, so they include pools the bot cannot enter at any size.

## Change (reporting and what a pass earns; the frozen primaries are unchanged)
1. Every D1 rule, H1-CGO's primary and the Step A rows 1–3 are also reported on the **H8-eligible stratum** at $5, $20 and $50. The floor is computed from that hour's SOL/USD (Binance public archive, committed with its sha256).
2. A validation pass is **tradable as the bot stands** only if, at some size of $5, $20 or $50, the H8-eligible subset holds at least 300 validation trades and has a positive point mean.
3. Otherwise the result goes to the owner as: "this works only in pools below H8's floor". H8 is a risk limit, and only the owner can lower it. No forward confirmation starts until he rules.
4. New count row (free, Step A): H8-eligible pool-hours and graduates per day at $5, $20 and $50. It also shows whether the owner's target of about 2 trades a day is reachable inside H8.
