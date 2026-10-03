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
- **2026-10-03 · A late landing reported on a dropped fork is cleared only with finalized proof.** The book's `orphan_cleared` event lifts the entry hold, with an alert, only when all of these hold:
  - balances are unchanged at `finalized`;
  - a `finalized` status read for the signature either failed, or, with a history search, found nothing once the *finalized* block height is past the attempt's last valid height.
  The finalized height matters, because a landing just before expiry is not finalized yet. Without this proof the hold stays, which fails safe. Without the event at all, a fork-dropped report would block entries forever and stop unattended paper runs.
- **2026-10-03 · A restart while `signed` never sends the bytes.** The intent becomes `unknown` and waits for expiry, because we cannot prove whether the bytes left before the restart.

## Evidence (`packages/core/src/domain`)

- **2026-10-03 · `checkFreshness` checks age and timestamps only.** It does not reject evidence flagged `fork-suspect`, `provider-degraded`, `partial` or `estimated`, nor evidence read at `processed` commitment. The evidence-gates task must reject these: unknown or degraded evidence is a failure, never a pass. Until that gate exists, `checkFreshness` alone does not prove evidence usable.
