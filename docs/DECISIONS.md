# Decisions

One entry per decision: what was decided, why, and where it lives. Newest last within each section.

## Order and position lifecycle (CORE-1, `packages/core/src/lifecycle`)

- **2026-10-03 · A failed signature read is terminal only at `finalized`.** A failure read at `processed` or `confirmed` may come from a fork that is later dropped, and the original transaction could still land. Acting on it would allow a replacement, which could mean a second buy or an oversell. Waiting for `finalized` costs about 13 s. A success read counts from `confirmed`: booking a fill early is safe, because the books stay open until every other attempt is dead.
- **2026-10-03 · An attempt is dead only when it has failed at `finalized`, or when the confirmed block height has passed its `lastValidBlockHeight`.** A replacement may be signed, and the books closed, only when every other attempt is dead. Each of these events carries the block height it was read at: `sign_replacement` and `reconcile`.
- **2026-10-03 · Balances are the truth.** A fill found after a failed or expired status is booked, and a critical alert is raised. If more than one attempt landed, all of them are booked (`double_fill` alert). A landing reported after the books closed raises `unbooked_landing` for a person to resolve, because that intent is final.
- **2026-10-03 · A restart while `signed` never sends the bytes.** The intent becomes `unknown` and waits for expiry, because we cannot prove whether the bytes left before the restart.

## Evidence (`packages/core/src/domain`)

- **2026-10-03 · `checkFreshness` checks age and timestamps only.** It does not reject evidence flagged `fork-suspect`, `provider-degraded`, `partial` or `estimated`, nor evidence read at `processed` commitment. The evidence-gates task must reject these: unknown or degraded evidence is a failure, never a pass. Until that gate exists, `checkFreshness` alone does not prove evidence usable.
