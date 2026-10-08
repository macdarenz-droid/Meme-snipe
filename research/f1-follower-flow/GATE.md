# F1: follower flow (counts gate only)

Drafted 2026-10-08 (Melbourne) by the brainstorm partner. The research lead ruled in round 9 that F1 runs as a counts gate only. No return test may be written or run until the owner has cleared the ethics question below. Tape only, 0 credits. Nothing here was computed on market data.

## Question
Do some wallets' buys reliably bring more buying from other wallets, and does most of that follower buying land after our 23-slot landing delay? If not, F1 closes for good: the followers are faster than the bot.

## Ethics check before any return test (owner)
F1 would buy after a public wallet buys and sell to that wallet's slower followers. That is not front-running a pending order, because the leader's buy has already landed and is public. But it sits close to the "paid callers" seat that `docs/research/edge.md` §10.2 closes. Only the owner can clear it.

## Data
- Shared tape S (curve and PumpSwap swaps, with `owner`), discovery days only: Step A (2026-09-11, 09-10). No validation day is read for F1.

## Definitions (fixed now)
- Leader candidate: an owner with at least 10 buys on distinct mints on day 1 (09-11).
- Follower buy: a buy of the same mint, within 600 slots after the leader's buy, by an owner that is neither the leader nor linked to it. Two owners are linked if a T or W transfer of the mint or of SOL ran between them on the tape.
- Follow count: distinct follower owners in that window.
- Placebo: for each leader buy, a buy of the same mint by a random non-candidate owner, drawn (seeded, committed) from buys within ±1,800 slots of the leader's buy, with its follow count measured the same way. This matches the coin's local activity, which a fixed earlier window would not. A leader buy with no such buy in reach is dropped.

## Gate statistics (no returns: counts and timing only)
1. Followed leaders. A leader counts as followed if its mean follow count beats its placebo mean, with a one-sided 99.5% lower bound above 0 (bootstrap over its buys). This is ranked on day 1 only.
2. Persistence. For day-1 followed leaders, the same comparison on day 2 (09-10).
3. Timing. For day-2 events of persistent leaders, the share of follower SOL volume landing more than 23 slots after the leader's buy.

## Kill (F1 closes for good)
Any one of:
- fewer than 20 leaders followed on day 1;
- fewer than half of those still followed on day 2;
- under 50% of follower volume lands after 23 slots;
- fewer than 15 persistent-leader buys a day, since a later test could not reach 300 trades in a reasonable span.

## If the gate passes
Report the counts to the lead and the owner. A return test is written only after the owner's ethics ruling, then frozen and run on untouched days.
