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

## Configuration and policy (CFG-1, `packages/core/src/config`)

- **2026-10-03 · Code loads limits and tightens them; it never raises them.** A session starts only from a policy that is tighter than or equal to an approved baseline on every field. Baselines are a frozen list in `baselines.ts`, starting with the trial preset. Raising a limit means adding a baseline in a reviewed pull request (the owner's step); nothing at runtime can add one.
- **2026-10-03 · Every field has a direction.** `max` (a cap or trigger: may fall only), `min` (a floor: may rise only), `locked` (any change needs a new version), `free` (the label). A new field without a direction does not compile.
- **2026-10-03 · The exit path is locked.** Exit fees, the fee ceiling, min-out and the emergency rung cannot be changed by override, and validation refuses a zero fee or a zero slippage allowance on any rung. A lower number there can stop an exit landing, so it is never "tighter".
- **2026-10-03 · A saved policy is read by a strict reader.** Duplicate keys and `__proto__`, `constructor` and `prototype` keys are refused; every field is checked and covered by the hash; a field supplied through a prototype is not a field. The session copies, then validates, then locks the copy.
- **2026-10-03 · Values deferred to the cards that own them** (new policy schema version when they land): the H15 round-trip tolerance, the regime's execution-health thresholds and entry slippage (GATE-1 and RISK-1). The H13 dev-cluster cap (5%) and the H14 14-day rug look-back are in the policy now.
- **2026-10-03 · The money-literal scan reads tokens.** It knows regex literals and decodes string escapes. It flags any number of 1,000 or more in any notation, any nonzero literal in a statement with `MICRO_PER_USD` or `LAMPORTS_PER_SOL` or inside a money constructor call, numeric strings given to `BigInt`, `Number`, `parseInt` and `parseFloat`, and money constructors built from a literal, anywhere in `packages/core/src` outside `config/`. The allow-list is by exact file, declared name and value, and a test fails if an entry goes stale. Limit: an amount assembled from small numbers is not seen.
