# Decisions

One entry per decision: what was decided, why, and where it lives. Newest last within each section.

## Order and position lifecycle (CORE-1, `packages/core/src/lifecycle`)

- **2026-10-03 · A failed signature read is terminal only at `finalized`.** A failure read at `processed` or `confirmed` may come from a fork that is later dropped, and the original transaction could still land. Acting on it would allow a replacement, which could mean a second buy or an oversell. Waiting for `finalized` costs about 13 s. A success read counts from `confirmed`: booking a fill early is safe, because the books stay open until every other attempt is dead.
- **2026-10-03 · An attempt is dead only when it has failed at `finalized`, or when the confirmed block height has passed its `lastValidBlockHeight`.** A replacement may be signed, and the books closed, only when every other attempt is dead. Each of these events carries the block height it was read at: `sign_replacement` and `reconcile`.
- **2026-10-03 · Balances are the truth.** A fill found after a failed or expired status is booked with a critical alert. If more than one attempt landed, all are booked (`double_fill` alert). An exit that sold more than its quantity is booked, not refused (`oversold` alert).
- **2026-10-03 · A landing after an intent ended is never refused or left to a person.** This replaces an earlier choice made the same day, which the review rejected. It applies to a landing reported for a cancelled, abandoned or filled intent.
  - The landing raises `unbooked_landing` and a `reconcile_orphan` effect. Every tick repeats the effect until the wallet reconciliation books it with the book's `orphan_fill`.
  - A late buy gets its own open position, so exits can protect it at once. A late sell reduces the position it sold from.
  - New entries stay blocked until it is booked; exits are never blocked.
- **2026-10-03 · A refused reconcile is retried.** While an outcome is known but not reconciled, every tick asks for `reconcile_balances` again, so a reconcile refused because another attempt could still land is retried until it succeeds.
- **2026-10-03 · A restart while `signed` never sends the bytes.** The intent becomes `unknown` and waits for expiry, because we cannot prove whether the bytes left before the restart.

## Evidence (`packages/core/src/domain`)

- **2026-10-03 · `checkFreshness` checks age and timestamps only.** It does not reject evidence flagged `fork-suspect`, `provider-degraded`, `partial` or `estimated`, nor evidence read at `processed` commitment. The evidence-gates task must reject these: unknown or degraded evidence is a failure, never a pass. Until that gate exists, `checkFreshness` alone does not prove evidence usable.

## Ledger and storage (LEDGER-1, `packages/core/src/ledger`)

- **2026-10-03 · Outcomes live in a second file.** Labels, the experiment registry and gate results go in a scoring file (`@meme-snipe/core/ledger/scoring`), not in the ledger. The ledger's entry point never imports the scoring module, never attaches a file, keeps its connection out of reach (no property holds it) and refuses to open a scoring file. A test fails if any source outside `ledger/` and `stats/` imports the scoring store or ledger internals. Gate results count as outcomes: the worker reads them through the scoring reader, never through the engine.
- **2026-10-03 · Amounts are canonical decimal text.** A u64 token amount can pass SQLite's signed 64-bit integer, so every amount column is `TEXT` with a check (digits only, no leading zero, no sign, no decimal point) and is read back as `bigint`. Label net P&L may be negative (`net_lamports`). Return fractions and probabilities stay `REAL`: they are ratios, not money.
- **2026-10-03 · Append-only by trigger.** Every table refuses `UPDATE` and `DELETE`. State changes are new rows: intent and position events, a release or keep row per reservation, a done row per outbox item, a result row per operator command.
- **2026-10-03 · One writer by lock file.** A `<file>-writer.lock` holds the writer's pid. A live holder is refused; a dead one (crash, kill) is taken over. Risk: if the pid is reused by another process after a crash, the next open is refused (safe side); delete the lock by hand after checking. Reservation atomicity does not rely on the lock: it runs in `BEGIN IMMEDIATE` and is tested with eight processes on separate connections.
- **2026-10-03 · Times come from the caller.** The ledger never reads the clock for data rows, so a backtest on a simulated clock writes the same rows as live. Only `schema_migrations.applied_at` uses the wall clock.
- **2026-10-03 · A file is stamped with its purpose** (`live`, `paper` or `backtest`) when created, and only opens as that purpose, so a backtest can never write into a live ledger.
- **2026-10-03 · Migrations are forward-only and checked.** Versions run 1..n with no gaps, each in its own transaction, recorded with a SHA-256 of kind, version, name and SQL. A file newer than the code, or one whose applied migration differs from the code's (an edit, or the other kind of file), is refused. Schema 1 holds frozen copies of the domain's venue and status lists; a test fails when the domain lists change, so the change ships as migration 2.
- **2026-10-03 · Telegram may only pause.** The schema refuses any other command with auth level `telegram` (docs/ARCHITECTURE.md §12).
- **2026-10-03 · Node version.** `node:sqlite` is unflagged from 22.13 and the crash tests run child processes with type stripping (unflagged from 22.18). CI's `node-version: 22` resolves to 22.22 today; the root `engines` field still says `>=22.12` (supervisor-owned, raise to `>=22.18`).
