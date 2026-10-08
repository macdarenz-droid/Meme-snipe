# Build specification - group B

Edited in Meme-snipe from 2026-10-07 (card Z0D); source commit `74e7258` of `macdarenz-droid/Snipe-solana` `main`.

Execution, landing, positions, risk, custody, books and operations for the Solana meme-coin trading bot (modules M15-M30).

- Written 2026-10-06 by the group B spec writer. Design and build specifications only; no production code. Code fragments are interface specifications in TypeScript, the language chosen in ARCH D05.
- Source of truth: `ARCH.md` (revised architecture: decision branches D01-D31, conflict map 7.2, state machines 7.3-7.7, risk policy 8, data model 15, tests 16). Where this document and `ARCH.md` disagree, `ARCH.md` wins and the disagreement is a bug in this document; every place where `ARCH.md` was ambiguous and a reading had to be chosen is listed under **Architecture clarifications** (IDs `CL-nn`) for the integrator.
- `UI.md` view models (VM-01..VM-20, plus VM-21 and the changes UC-01..UC-21 from ARCH section 19) are served by M28 from group B. The dashboard front-end tickets (UI-T01..UI-T32) already exist in `UI.md` and are not rewritten here.
- Group A modules (M01-M14) are referenced only through the interfaces in `ARCH.md` and cited by module ID and interface name. Interfaces that group B needs and that `ARCH.md` does not yet define are listed in the cross-group dependency table and in the clarifications.
- Labels follow `ARCH.md`: [XX-nn] = fact from the verified register; **DERIVED**; **PARAMETER**; **POLICY**; **ASSUMPTION**; **UNVERIFIED**; **VERIFY:** = a third-party interface detail the implementer must confirm against the named official source before coding. No ticket invents a third-party endpoint, SDK method, program ID or instruction layout; where one is needed and not in the register, the ticket says **VERIFY**.
- Nothing here implies the bot will make money. No ticket may weaken a risk control in `ARCH.md`; where a ticket chooses between two readings, it chooses the stricter one.

## Build order

### Milestones for group B

Group B work follows the gated phases of ARCH section 18. A phase's tickets start only when the previous phase's exit condition is met. **Phase 3 tickets (live path and custody) are blocked by the Phase 2 gate result (stage `paper_passed`), not by calendar time.** Effort figures are rough engineer-day estimates (ASSUMPTION A-33), labelled per ticket.

**Integration (binding).** Group B milestones are slices of the global milestones in `INTEGRATION.md` (M0-M4, M4b). The earlier MB-0..MB-3b split put the engine core (M19-M23) in Phase 2, but the Phase 1 gate runs (A-M11-02/03, gates B and R) drive the engine's own order, position, risk and ledger code (ARCH 9.2), so that core moves to M2. Phase 0 recording also needs persistence, config and logging (M24, M25, M27) and the slot clock (M15), so those move to M0.

| Milestone (global) | ARCH 18 phase | Group B tickets | Exit condition |
|---|---|---|---|
| **M0 Foundations** | 0 | B-M15-01, B-M19-01, B-M24-01, B-M24-02, B-M25-01, B-M27-01, B-M28-01, B-M30-01 | Shared packages frozen with fixture tests; CI enforces the dependency policy; `node:sqlite` VERIFY result recorded; schema (including group A tables) migrates; config bootstrap; structured logging; slot clock reads two providers |
| **M1 Recording and Phase 0 decision** | 0 | — (group A only; B tickets of M0 support it) | A-48 report accepted (A-M13-01; A-24 and A-24b parked with MR-01, C-76, card Z-H-OF round 2) |
| **M2 Research and engine core in simulation** | 1 | B-M15-03, B-M16-01, B-M16-02, B-M16-03, B-M16-05, B-M19-02, B-M19-03, B-M19-04, B-M19-05, B-M29-05, B-M20-01, B-M20-02, B-M20-03, B-M20-04, B-M21-01, B-M21-02, B-M21-03, B-M21-06, B-M22-01, B-M22-02, B-M22-05, B-M23-01, B-M23-02, B-M23-03 | Gates B and R evaluable with the engine's own code; stage `replay_passed` or stop (D08) |
| **M3 Paper** | 2 | B-M15-02, B-M20-05, B-M21-04, B-M21-05, B-M22-03, B-M23-04, B-M23-05, B-M24-03, B-M24-04, B-M25-02, B-M25-03, B-M26-01, B-M26-02, B-M26-03, B-M26-04, B-M26-05, B-M27-02, B-M28-02, B-M28-03, B-M28-04, B-M28-05 | Gates P-1..P-6, P-9 and P-10 evaluable; stage `paper_passed` or stop. **First milestone producing paper-trading results** |
| **M4 Live path → live-small** (blocked by the M3 gate result) | 3 | B-M16-04, B-M16-07, B-M16-10, B-M17-01, B-M17-02, B-M17-03, B-M17-04, B-M17-05, B-M17-06, B-M17-07, B-M17-08, B-M18-01, B-M18-02, B-M18-03, B-M18-04, B-M18-05, B-M19-06, B-M22-04, B-M22-06, B-M29-01, B-M29-02, B-M29-03, B-M29-04, B-M30-02, B-M30-03 | Gates P-7, P-8 and the go-live checklist → `live_small`; LS gates → `live`; D26 (ii) or (iii) before `live` (LS-7) |
| **M4b Raydium** (only on the D01/D18 trigger) | 3b | B-M16-09; Raydium additions in B-M17-04/05 and B-M29-02 | M01 Raydium venue spec accepted; P-6 on Raydium pools |
| **Deferred / research only** | any | B-M16-06, B-M16-08 | Built only when a research or PM-01 paper ticket needs it |

Split on 2026-10-07 (INTEGRATION "Remaining issues"): `botctl import-run` is B-M29-05 (M2; it needs only B-M24-02 and A-M13-08's spool) and the rest of `botctl` is B-M29-04 (M4); the live execution port is B-M19-06 (M4) and the simulation and paper wiring stays B-M19-03 (M2).

### Ticket dependency list (group B internal and group A tickets; integration)

| Ticket | Depends on (group B) | Depends on (group A tickets, hard) | Global milestone |
|---|---|---|---|
| B-M30-01 | — | — | M0 |
| B-M19-01 | B-M30-01 | — | M0 |
| B-M28-01 | B-M30-01 | — | M0 |
| B-M24-01 | B-M30-01 | — | M0 |
| B-M24-02 | B-M24-01, B-M19-01 | — | M0 |
| B-M24-03 | B-M24-02 | — | M3 |
| B-M24-04 | B-M24-02, B-M24-03 | — | M3 |
| B-M25-01 | B-M24-02 | — | M0 |
| B-M25-02 | B-M25-01 | — | M3 |
| B-M25-03 | B-M25-02, B-M24-04 | — | M3 |
| B-M27-01 | B-M19-01 | — | M0 |
| B-M27-02 | B-M27-01, B-M24-02 | A-M03-01, A-M14-05 | M3 |
| B-M15-01 | B-M19-01, B-M27-01 | A-M14-01, A-M14-02 | M0 |
| B-M15-02 | B-M15-01 | A-M14-02 | M3 |
| B-M15-03 | B-M15-01 | A-M14-02, A-M14-05 | M2 |
| B-M16-01 | B-M19-01 | — | M2 |
| B-M16-02 | B-M16-01 | A-M01-01 | M2 |
| B-M16-03 | B-M16-02 | A-M01-01, A-M01-03, A-M02-01, A-M02-02 | M2 |
| B-M16-05 | B-M16-03 | A-M01-03, A-M04-01 | M2 |
| B-M16-04 | B-M16-03, B-M15-02, B-M15-03, B-M22-02 | A-M01-02, A-M01-03, A-M04-02, A-M06-02 | M4 |
| B-M16-06 | B-M16-04 | A-M01-03, A-M14-03 | Deferred |
| B-M16-07 | B-M16-04 | A-M01-03, A-M14-03 | M4 |
| B-M16-08 | B-M16-03 | A-M01-03, A-M02-02 | Deferred |
| B-M16-09 | B-M16-04 | A-M01-06, A-M02-07 | M4b |
| B-M16-10 | B-M16-01, B-M16-02, B-M22-02 | — | M4 |
| B-M22-01 | B-M24-02, B-M25-01 | — | M2 |
| B-M22-02 | B-M22-01 | A-M14-02 | M2 |
| B-M22-03 | B-M22-02 | A-M02-03, A-M14-02 | M3 |
| B-M22-04 | B-M22-03, B-M16-10, B-M19-06 | — | M4 |
| B-M22-05 | B-M22-01 | — | M2 |
| B-M22-06 | B-M22-03, B-M23-01 | A-M02-03, A-M14-02 | M4 |
| B-M19-02 | B-M24-02, B-M22-01 | — | M2 |
| B-M19-03 | B-M19-02 | — | M2 |
| B-M19-04 | B-M19-03, B-M22-02 | — | M2 |
| B-M19-05 | B-M19-03 | A-M14-03 | M2 |
| B-M19-06 | B-M19-03, B-M16-04, B-M17-01, B-M18-01 | — | M4 |
| B-M18-01 | B-M19-01, B-M15-01 | A-M14-04 | M4 |
| B-M18-02 | B-M18-01 | A-M14-03, A-M14-04 | M4 |
| B-M18-03 | B-M18-01 | A-M02-03, A-M14-02 | M4 |
| B-M18-04 | B-M18-03, B-M15-01 | A-M14-02 | M4 |
| B-M18-05 | B-M18-03, B-M16-07 | A-M14-03, A-M14-04 | M4 |
| B-M17-01 | B-M30-01 | — | M4 |
| B-M17-02 | B-M17-01 | — | M4 |
| B-M17-03 | B-M17-01 | — | M4 |
| B-M17-04 | B-M17-01 | A-M02-01, A-M02-06 | M4 |
| B-M17-05 | B-M17-04 | — | M4 |
| B-M17-06 | B-M17-03, B-M17-05 | — | M4 |
| B-M17-07 | B-M17-03, B-M17-04 | — | M4 |
| B-M17-08 | B-M17-02, B-M17-06, B-M17-07 | — | M4 |
| B-M20-01 | B-M24-02, B-M19-02 | A-M05-02, A-M09-01 | M2 |
| B-M20-02 | B-M20-01 | A-M01-03, A-M04-01, A-M04-02, A-M08-02 | M2 |
| B-M20-03 | B-M20-02, B-M19-04 | A-M01-04, A-M01-05, A-M04-01, A-M06-02, A-M06-04, A-M06-06 | M2 |
| B-M20-04 | B-M20-03, B-M19-05 | A-M01-03, A-M06-05 | M2 |
| B-M20-05 | B-M20-04 | A-M02-03, A-M14-02 | M3 |
| B-M21-01 | B-M25-01, B-M24-02 | — | M2 |
| B-M21-02 | B-M21-01, B-M22-01, B-M20-01 | A-M01-03, A-M04-02, A-M06-01, A-M09-01, A-M10-03, A-M10-04 | M2 |
| B-M21-03 | B-M21-02, B-M23-03 | A-M08-02, A-M14-05 | M2 |
| B-M21-04 | B-M21-01, B-M22-03, B-M23-02 | A-M01-05, A-M02-05, A-M13-04, A-M13-07 | M3 |
| B-M21-05 | B-M21-04 | — | M3 |
| B-M21-06 | B-M21-02, B-M19-02, B-M20-01 | A-M01-03, A-M04-02, A-M06-01, A-M07-02, A-M09-01 | M2 |
| B-M23-01 | B-M24-02, B-M19-01 | A-M02-03, A-M10-02 | M2 |
| B-M23-02 | B-M23-01, B-M20-01 | — | M2 |
| B-M23-03 | B-M24-02 | A-M10-03, A-M14-03 | M2 |
| B-M23-04 | B-M23-02, B-M23-03 | — | M3 |
| B-M23-05 | B-M23-01 | A-M02-03, A-M14-02 | M3 |
| B-M26-01 | B-M24-03, B-M27-01 | — | M3 |
| B-M26-02 | B-M26-01, B-M25-02 | — | M3 |
| B-M26-03 | B-M26-02 | A-M13-06 | M3 |
| B-M26-04 | B-M26-03, B-M21-04 | A-M13-05, A-M13-06 | M3 |
| B-M26-05 | B-M26-01, B-M19-04, B-M20-05, B-M22-03 | A-M02-01 | M3 |
| B-M28-02 | B-M28-01, B-M24-02 | — | M3 |
| B-M28-03 | B-M28-01, B-M21-01, B-M22-01, B-M20-01, B-M23-03, B-M23-04, B-M26-01, B-M27-02, B-M25-01 | A-M04-01, A-M05-01, A-M06-02, A-M06-03, A-M07-03, A-M08-03, A-M09-01, A-M13-04, A-M13-06, A-M13-08, A-M14-05 | M3 |
| B-M28-04 | B-M28-02, B-M28-03 | — | M3 |
| B-M28-05 | B-M28-02, B-M26-02, B-M24-03, B-M23-04 | — | M3 |
| B-M29-01 | B-M17-08 | — | M4 |
| B-M29-02 | B-M29-01, B-M16-04, B-M18-04 (shared proof code) | A-M01-03, A-M02-02 | M4 |
| B-M29-03 | B-M29-01 | — | M4 |
| B-M29-04 | B-M29-01, B-M29-05 | — | M4 |
| B-M29-05 | B-M24-02 | A-M13-08 | M2 |
| B-M30-02 | B-M30-01, B-M17-01, B-M29-01 | — | M4 |
| B-M30-03 | B-M30-02, B-M24-04 | A-M07-03 | M4 |

### What can be built in parallel

- **Track 1, books and storage:** B-M24-01 → B-M24-02 → B-M24-03/04 → B-M25-* → B-M22-01/02/05 → B-M23-*.
- **Track 2, execution path:** B-M19-01 → B-M16-01/02/03/05 (early, M2) → B-M15-* → B-M19-02..05 (M2) → (M4) B-M16-04/07/10 and B-M18-*.
- **Track 3, custody (M4, one engineer, never mixed with engine work in the same PR):** B-M17-01..08 in order; B-M17-04 and B-M17-03 can proceed in parallel after B-M17-01.
- **Track 4, control and operator surface:** B-M27-* → B-M26-01/02 → B-M28-02..05 (B-M28-01 first, M0).
- **Track 5, positions and risk (M2, on the critical path of gates B and R):** B-M20-01..04, B-M21-01..03 and B-M21-06 in parallel once B-M19-02 and B-M22-01 exist; B-M21-04/05 and B-M20-05 in M3.
- **Track 6, safety net and delivery (M4):** B-M29-* after B-M17-08; B-M30-02/03 in parallel with B-M29.
- Tightly coupled pairs from ARCH 18 stay with one owner where possible: M16+M17+M18+M19; M20+M21; M22+M23+M24; M26+M28+M29; M17+M29 (leases and `ops.sock`).

## Tickets

### Conventions that apply to every ticket

These are part of every ticket's **Interfaces**, **Security notes** and **Definition of done** and are not repeated in each one.

1. **Units and numbers.** All on-chain quantities are `bigint` (`Lamports`, `BaseUnits`, `MicroLamportsPerCu`, `Slot`, `BlockHeight`); `Bps` is an integer `number`; `Cu` is an integer `number` ≤ 1,400,000 [LD-02]. A lint rule (ARCH 16.1) rejects `Number(...)`, `parseFloat` and arithmetic mixing `number` with identifiers ending in `Lamports`, `Base`, `Slot`, `Height`. Integer division always states its rounding (floor for outputs and minimum outputs, ceil for fees and costs, which is the conservative side).
2. **Errors.** Every fallible function returns `Result<T, { code: string; message?: string }>` (ARCH 5.0) with the codes listed in the ticket; exceptions are reserved for programmer errors and crash the process (systemd restarts it; ARCH 7.6 recovery applies).
3. **Time and randomness.** No `Date.now()` or `Math.random()`; use the injected `Clock` and `Rng` (ARCH 5.0). Random choices that need unpredictability (tip account selection) use `crypto.randomInt` from Node's built-in `crypto`, wrapped behind the `Rng` interface so tests can seed it.
4. **I/O.** All RPC and HTTP calls go through M14 `RpcGateway` (group A) with the priority class named in the ticket, except inside the signer (M17) and the sentinel (M29), which have their own minimal HTTPS clients (Node built-in `fetch`) by design. Every `getTransaction`/`getBlock` call sends `maxSupportedTransactionVersion: 1` [LD-05, EX-V04].
5. **Persistence.** Every state change of an owned record and its outbox event commit in one M24 `withTx` transaction (ARCH 7.1, M24). Async I/O never holds a transaction open across an `await`; owners use compare-and-set on `version` columns and return `E_STATE_CHANGED` on a lost race (ARCH 7.1).
6. **Logs and secrets.** Log events use M27 `log.event(level, code, fields)` with stable `code` strings; fields marked secret and URL query strings are redacted (ARCH 12.4). No private key, passphrase, API key, RPC URL with key, session ID or cookie appears in any log, metric label, error message, fixture or VM payload (brief rule 5).
7. **Fixtures.** Chain fixtures are stored raw RPC responses (public on-chain data; no secrets). Generated wallet keys in tests are created fresh per test run and never funded on mainnet. The fixture IDs named in tickets (`FX-...`) are listed in the fixture catalogue at the end of the ticket section.
8. **Common Definition of done** (in addition to each ticket's own): code reviewed by a second person; unit tests at 100% branch coverage for pure functions (ARCH 16.1); all named tests pass in CI; no new runtime dependency without an entry in `DEPENDENCIES.md` and a B-M30-01 allowlist change; every VERIFY item the ticket depends on is resolved and the resolution (source URL, date read, result) is recorded in `VERIFY.md`; metrics and log codes listed under Observability exist and are documented; no TODO that weakens a risk control.
9. **Size labels** (rough estimates, ASSUMPTION A-33): S ≈ 0.5-1 engineer-day; M ≈ 1.5-2; L ≈ 2.5-3.

---

### M15 Chain state service

#### B-M15-01 — Slot clock, highest seen slot and per-provider height readings

- **Module:** M15 · **Size:** M (rough estimate ~1.5 engineer-days) · **Phase:** 2 (read-only), 3
- **Goal:** Provide `slot()`, `blockHeight()`, `slotDurationMsEstimate()`, `highestSeenSlot()` and `heightOn(provider)` so that observation lag (ARCH 8.5) and M18's expiry proof can be computed soundly, never mixing readings from different providers.
- **Depends on:** B-M19-01 (`@bot/types`), B-M27-01 (metrics). Group A: M14 `RpcGateway.call` (with `provider` option and `contextSlot` in the result); M14 publication of every response's `(providerLabel, contextSlot)` on the event bus (new, see cross-group table and CL-01).
- **Interfaces:**

```ts
// owned by M15 (ARCH 5, M15); exact copies of the ARCH types
interface HeightReading { providerLabel: string; slot: Slot; blockHeight: BlockHeight; commitment: 'confirmed'; atMs: UnixMs }
interface SlotClock {
  slot(): Slot;                                    // last confirmed slot from the primary reading loop
  blockHeight(): BlockHeight;                      // last confirmed block height from the same reading (same provider)
  slotDurationMsEstimate(): number;                // ms per slot, from performance samples [LD-08]
  highestSeenSlot(): Slot;                         // max contextSlot over every response from any provider
  observationLagSlots(contextSlot: Slot): number;  // highestSeenSlot() − contextSlot, floored at 0, as a JS number (bounded)
  heightOn(providerLabel: string): Promise<Result<HeightReading, { code: 'E_RPC' | 'E_TIMEOUT' | 'E_PROVIDER_UNKNOWN' | 'E_PROVIDER_LAGGING' }>>;
  providerSlotLag(providerLabel: string): number | null;   // highestSeenSlot − provider's latest contextSlot
  lastReadingAgeMs(): number;                       // age of the primary HeightReading (edge case 2)
}
// consumed from M14 (new event, CL-01)
type RpcContextSlotEvent = { providerLabel: string; contextSlot: Slot; method: string; atMs: UnixMs };   // topic 'rpc.context_slot' (integration: A-M14-01 publishes exactly this shape, including `method`)
```

- **Logic:**
  1. Subscribe to `rpc.context_slot`. For each event, `highestSeen = max(highestSeen, contextSlot)` and `lastContextSlot[provider] = max(...)`. A context slot more than `max_future_slot_jump` (default 2,000) above the current `highestSeen` while at least one other provider is within 10 slots of the old value is ignored and logged `m15.slot_outlier` (protects observation lag from a broken provider).
  2. Every `height_poll_ms` (default 2,000 ms; ARCH 11.2 budgets 0.5 req/s) call the slot-and-height method on the primary read provider at `confirmed`, priority P0. **VERIFY:** that `getEpochInfo` returns `absoluteSlot` and `blockHeight` in one response (Solana RPC docs; A-36). Store as the primary `HeightReading`; `slot()` and `blockHeight()` return its values.
  3. `heightOn(p)`: one call to the same method with `provider: p`, priority P0, timeout `height_timeout_ms`. Returns the pair from that single response; never combines a slot from one provider with a height from another (ARCH M15 rule). If `providerSlotLag(p) > 10` before the call, return `E_PROVIDER_LAGGING` (ARCH 8.5 provider lag rule).
  4. Every 60 s call `getRecentPerformanceSamples` (used and read in [LD-08]; **VERIFY** the response field names `numSlots` and `samplePeriodSecs` against the Solana RPC docs) at P4 and set `slotDurationMsEstimate = 1000 × Σ samplePeriodSecs / Σ numSlots` over the returned samples. Never hard-code slot time [LD-08]; initial value before the first sample = `slot_ms_initial` (default 267, observed [LD-08]).
  5. Never use `getBlockTime` for sub-second measurements (whole seconds, A-37 VERIFY).
- **Shared resources and concurrency:** Owns `SlotClock` state (ARCH 7.2 "Recent blockhash, block height, highest seen slot": owner M15, read-only to others). Updates happen on the event loop; readers get the latest value; no locks. Idempotency: monotonic max; duplicate events are harmless.
- **Config:** `m15.height_poll_ms` (int ms, default 2,000, range 400-10,000); `m15.height_timeout_ms` (default 1,500, range 200-5,000); `m15.max_future_slot_jump` (default 2,000, range 100-100,000); `m15.slot_ms_initial` (default 267, range 100-1,000). All `affectsReturns: false`, `requiresRestart: false`. In degraded mode (M14 `degraded_reads`) the poll interval is raised to 10,000 ms (ARCH 11.2 degraded budget: heights only while attempts are unresolved; CL-02).
- **Edge cases and failure handling:**
  1. No `rpc.context_slot` events yet at start → `highestSeenSlot()` returns the primary reading's slot; observation lag of any read is then 0 or positive; M21 entries stay blocked until `trading_state = running` anyway (ARCH 7.6).
  2. Primary height call fails 3 times in a row → M14 fails over (provider option omitted) and `m15.height_failover` is logged; `slot()` keeps the last good value with its `atMs`, and consumers check its age via `lastReadingAgeMs()`.
  3. `heightOn(p)` for an unknown label → `E_PROVIDER_UNKNOWN` (programming error at the caller, alert warning).
  4. Performance samples empty → keep the previous estimate.
- **Acceptance criteria:**
  1. Given context slots 100 (provider A), 105 (B), 103 (A), when `highestSeenSlot()` is read, then it returns 105 and `providerSlotLag('A')` returns 2.
  2. Given a read with `contextSlot` 95 and highest seen 105, then `observationLagSlots(95)` returns 10.
  3. Given `heightOn('B')`, then exactly one RPC call is made with `provider = 'B'` and the returned slot and height come from that one response (asserted with a recording fake gateway).
  4. Given 30 samples totalling 6,725 slots in 1,800 s, then `slotDurationMsEstimate()` returns 267.66 ± 0.01 (DERIVED from [LD-08] figures).
- **Tests:** unit (max logic, outlier rule, lag, estimator); property (for any interleaving of events, `highestSeenSlot` is non-decreasing and ≥ every accepted context slot); integration with fixture `FX-RPC-EPOCHINFO` and `FX-RPC-PERFSAMPLES` (recorded responses); failure injection: primary provider timeouts, a provider returning a slot 1,000,000 ahead. Clarification C-61 (A10): one slot-to-time function, owned here; the 12-, 20- and 8-slot thresholds are rechecked at 400, 267 and 200 ms per slot.
- **Observability:** metrics `highest_seen_slot`, `provider_slot_lag` (provider), `slot_duration_ms_estimate`, `height_reading_age_ms`; log codes `m15.slot_outlier`, `m15.height_failover`, `m15.samples_empty`.
- **Security notes:** Reads only; no secrets. Provider labels only (never URLs) in logs and metrics (ARCH 12.4).
- **Facts used:** LD-07, LD-08, LD-09, LD-05. VERIFY: `getEpochInfo` fields (A-36), `getRecentPerformanceSamples` field names, `getBlockTime` resolution (A-37); settled by VF-12.
- **Definition of done:** Common DoD; `VERIFY.md` entries for A-36 and the performance-sample fields; M04 and M18 consume `observationLagSlots` and `heightOn` through the exported interface only.

#### B-M15-02 — Blockhash cache

- **Module:** M15 · **Size:** S (~1 engineer-day) · **Phase:** 2 (build-only), 3
- **Goal:** Always have a recent blockhash with its `lastValidBlockHeight`, fetched at `confirmed`, refreshed every 2 s, refreshed synchronously when older than 20 s, and expose a "blockhash unavailable" condition that blocks entries but never exits (ARCH M15, 8.5).
- **Depends on:** B-M15-01. Group A: M14 `RpcGateway.call`.
- **Interfaces:**

```ts
interface BlockhashInfo { blockhash: string; lastValidBlockHeight: BlockHeight; fetchedAtMs: UnixMs; commitment: 'confirmed'; providerLabel: string }
interface BlockhashCache {
  blockhash(): BlockhashInfo | null;                                         // null only before the first successful fetch
  fresh(maxAgeMs: number, o?: { allowStale: boolean }): Promise<Result<BlockhashInfo, { code: 'E_BLOCKHASH' }>>;  // refresh first if older than maxAgeMs; exits pass allowStale
  entriesAllowed(): boolean;                                                 // false when refresh has failed for ≥ refresh_fail_block_ms
}
```

- **Logic:**
  1. Every `refresh_ms` (2,000) call the latest-blockhash method at `confirmed`, priority P0 (**VERIFY:** `getLatestBlockhash` method name and response fields `blockhash` and `lastValidBlockHeight`, A-31/A-36; fetch at `confirmed` and store `lastValidBlockHeight` per [LD-07]).
  2. Keep only the newest successful result. Discard a response whose `lastValidBlockHeight` is lower than the cached one (out-of-order response).
  3. `fresh(maxAgeMs)`: if the cached value is older than `maxAgeMs` (default caller value 20,000, ARCH 8.5), perform one immediate refresh; if that fails return the cached value when it exists **and** the caller passes `{ allowStale: true }` (exits), else `E_BLOCKHASH`. Exits always pass `allowStale: true` (ARCH M15: "exits still attempt with the newest available blockhash").
  4. `entriesAllowed()` = false when no refresh has succeeded for `refresh_fail_block_ms` (30,000); M21 `preSendCheck` reads it.
  5. In degraded mode (M14) the refresh interval becomes 10,000 ms (ARCH 11.2).
- **Shared resources and concurrency:** Owner of `BlockhashCache` (ARCH 7.2). Concurrent `fresh()` callers share one in-flight refresh promise (single-flight), so a burst of exits makes one RPC call.
- **Config:** `m15.blockhash_refresh_ms` (2,000; 400-10,000); `m15.blockhash_max_age_ms` (20,000; 2,000-40,000; must be < the 150-slot validity at the current slot time, validated as `< 150 × slotDurationMsEstimate × 0.8`); `m15.blockhash_fail_block_ms` (30,000; 5,000-120,000).
- **Edge cases and failure handling:**
  1. All providers down → cached value ages; entries blocked after 30 s; exits use the newest cached value with `allowStale` and M18's expiry proof decides the outcome.
  2. Cached blockhash already past `lastValidBlockHeight` per `blockHeight()` → `fresh()` treats it as missing (an exit then gets `E_BLOCKHASH` only if no newer value can be fetched; M20 retries every 2 s per ARCH M20).
  3. Durable nonces are never used (D23).
- **Acceptance criteria:**
  1. Given a cached value 25 s old, when `fresh(20000)` is called, then exactly one refresh call is made and the new value is returned.
  2. Given 3 concurrent `fresh()` calls with a stale cache, then the gateway sees exactly one call.
  3. Given refresh failures for 31 s, then `entriesAllowed()` is false and `fresh(20000, {allowStale:true})` still returns the last value.
- **Tests:** unit (age logic, single-flight, out-of-order discard); integration with `FX-RPC-LATESTBLOCKHASH`; failure injection: 60 s of provider errors, then recovery.
- **Observability:** metrics `blockhash_age_ms`, `blockhash_refresh_failures_total`; log codes `m15.blockhash_stale`, `m15.blockhash_unavailable`.
- **Security notes:** None beyond conventions.
- **Facts used:** LD-07, LD-08, LD-10 (why no durable nonce, D23). VERIFY: `getLatestBlockhash` shape (A-31, A-36).
- **Definition of done:** Common DoD; M16 obtains blockhashes only through `fresh()`.

#### B-M15-03 — Rent oracle, priority-fee oracle and optional Jito leader share

- **Module:** M15 · **Size:** M (~1.5 engineer-days) · **Phase:** 1 (rent, for simulation builds; stub acceptable), 2, 3
- **Goal:** Supply rent-exempt minimums read from chain (never hard-coded), priority-fee estimates from Helius `getPriorityFeeEstimate` at level Medium for entries and High for exits, clamped by caps, with a configured floor fallback; optionally the share of Jito-capable stake (D02 (b) switch only).
- **Depends on:** B-M15-01. Group A: M14 `RpcGateway.call` (Helius provider label for the fee estimate).
- **Interfaces:**

```ts
interface RentOracle { rentExemptMinimum(dataBytes: number): Lamports }        // throws only if called before init; init awaits first read
interface FeeOracle {
  priorityFee(writableAccounts: Pubkey[], level: 'Low' | 'Medium' | 'High'): Promise<MicroLamportsPerCu>;  // never rejects; falls back
  lastSource(): 'helius_estimate' | 'cached' | 'floor' | 'own_landed_median';
}
interface LeaderShare { jitoLeaderShareBps(): Bps | null }                     // null when disabled (default)
```

- **Logic:**
  1. Rent: at start and hourly (P4), call `getMinimumBalanceForRentExemption` for each size in `rent_sizes` (default [0, 165, 170]) [LD-13]; for any other size compute `(128 + dataBytes) × lamports_per_byte` where `lamports_per_byte = (min(0) / 128)`, cross-checked against the 165 and 170 readings: if `rentExemptMinimum(165)` recomputed from the derived per-byte value differs from the direct reading, use the direct readings and log `m15.rent_formula_mismatch` (the formula is [LD-13]; the value changes through SIMD-0437 steps, so it is re-read hourly and never hard-coded). Expected today: 165 → 1,488,440; 170 → 1,513,840; 0 → 650,240 lamports [LD-13, LD-14].
  2. Priority fee: `priorityFee(accounts, level)` calls Helius `getPriorityFeeEstimate` (1 credit [LD-12, LD-28]) with the pool's writable accounts and the level (Medium for entries, High for exits: D15). **VERIFY** the request parameter names (`accountKeys`, `options.priorityLevel`) and the response field against the Helius priority-fee docs before coding; the method name and levels are in [LD-12]. Cache per (sorted accounts, level) for `fee_cache_ms` (10,000).
  3. Never call unfiltered `getRecentPrioritizationFees` (per-slot minimum, observed all zero [LD-11]).
  4. On error or timeout (`fee_timeout_ms` 500): return the cached value if younger than `fee_stale_ms` (60,000), else `fee_floor_micro_lamports_per_cu` (25,000, POLICY, ARCH M15). The oracle never clamps by notional (that is M21's job, ARCH M15 rule "clamped by M21's per-trade cap before use"), but it clamps to `fee_hard_max_micro_lamports_per_cu` (default 5,000,000) so a broken response cannot produce an absurd value.
  5. D15 switch (Helius credits > 80% of month, from M14 `creditUsage()`): source becomes `own_landed_median` = the 24 h median CU price of our own landed transactions (from M23 cost items), floor-clamped.
  6. `jitoLeaderShareBps()`: disabled by default (`jito_leader_share_enabled = false`). When enabled (D02 (b) switch), once per epoch-hour call `getClusterNodes` and `getVoteAccounts` at P4 and compute the activated-stake share of nodes whose self-reported client is in `jito_client_ids` (default `['JitoLabs','AgaveBam','FireBAM']`, the clients counted as bundle-capable in [LD-20]). It is informational (self-reported [LD-20]); M16 may skip a Jito tip only when the upcoming leader's client is known non-Jito, which requires a leader-schedule lookup that is **out of scope** for v1 (CL-03).
- **Shared resources and concurrency:** Owner of `RentOracle` and `FeeOracle` (ARCH 7.2). Single-flight per cache key.
- **Config:** `m15.rent_sizes` (list, default [0,165,170]); `m15.fee_cache_ms` (10,000; 1,000-60,000); `m15.fee_timeout_ms` (500; 100-3,000); `m15.fee_stale_ms` (60,000); `m15.fee_floor_micro_lamports_per_cu` (25,000; 0-1,000,000; `affectsReturns: true` because it changes cost); `m15.fee_hard_max_micro_lamports_per_cu` (5,000,000); `m15.fee_source` (enum `helius_estimate|own_landed_median`, default `helius_estimate`, `affectsReturns: true`); `m15.jito_leader_share_enabled` (bool, false).
- **Edge cases and failure handling:**
  1. Rent read fails at start → the engine refuses to build transactions that create accounts (`E_RENT_UNKNOWN` from M16) until a reading exists; simulation-only builds in M2 may use a constructor-injected stub in tests only.
  2. Helius returns 429 → M14 handles back-off; oracle falls back as in step 4; metric increments.
  3. Rent values change mid-day (SIMD-0437 step) → next hourly read picks it up; M22's exit-fee float and reservations use the current value.
- **Acceptance criteria:**
  1. Given recorded readings 650,240 / 1,488,440 / 1,513,840, then `rentExemptMinimum(137)` returns (128+137) × 5,080 = 1,346,200 (DERIVED, matches ARCH 2.1).
  2. Given the Helius call times out and the cache is 70 s old, then `priorityFee` returns 25,000 and `lastSource()` is `floor`.
  3. Given an estimate response of 10^12, then the returned value is 5,000,000.
- **Tests:** unit (formula, fallbacks, clamps); integration with `FX-RPC-RENT` and `FX-HELIUS-PRIOFEE` (recorded response; key redacted); failure injection: 429 storm, malformed JSON.
- **Observability:** metrics `rent_lamports_per_byte`, `priority_fee_estimate_micro_lamports` (level, source), `priority_fee_fallback_total` (reason); log codes `m15.rent_formula_mismatch`, `m15.fee_fallback`.
- **Security notes:** The Helius API key is added by M14 from the secret store; this module never sees it.
- **Facts used:** LD-11, LD-12, LD-13, LD-14, LD-20, LD-28, EX-13. VERIFY: Helius `getPriorityFeeEstimate` parameter and response field names.
- **Definition of done:** Common DoD; the D15 switch path is covered by a test that feeds M14 `creditUsage()` at 81%.

---

### M16 Transaction builder

Shared interface for every M16 ticket (exact copy of ARCH M16; `LandingPath` is extended by CL-04):

```ts
type SellAmount = { kind: 'full_balance' } | { kind: 'chunk'; maxBase: BaseUnits };
interface SwapBuildRequest { intentId: Id; attemptNo: number; rung: 1 | 2 | 3 | 4 | 5; side: 'buy' | 'sell'; poolId: Pubkey; venue: VenueId; mint: Pubkey;
  amountIn: bigint | null /* buys: lamports; sells: null, derived from SellAmount */; sellAmount: SellAmount | null;
  minOutBps: Bps /* slippage vs the fresh quote */; route: 'direct' | 'jupiter_build'; landing: LandingPath[];
  cuLimitOverride: Cu | null; cuPrice: MicroLamportsPerCu; tips: Array<{ path: LandingPath; lamports: Lamports }> }
interface UnsignedTx { messageBytes: Uint8Array; version: 0; lookupTables: Pubkey[]; feePayer: Pubkey;
  blockhash: string; lastValidBlockHeight: BlockHeight; cuLimit: Cu; cuPrice: MicroLamportsPerCu; tipLamports: Lamports;
  sellAmountBase: BaseUnits | null; balanceReadSlot: Slot | null; quote: Quote; minOut: bigint;
  declared: { purposeHint: 'buy' | 'exit' | 'sweep' | 'janitor'; programs: Pubkey[] } }   // informational only
interface TxBuilder {
  buildSwap(r: SwapBuildRequest): Promise<Result<UnsignedTx, { code: 'E_ROUTE' | 'E_NO_ROUTE' | 'E_ROUTE_POOL_MISMATCH' | 'E_TOO_LARGE' | 'E_QUOTE_DRIFT' | 'E_BLOCKHASH' | 'E_ZERO_BALANCE' }>>;
  buildJanitorClose(mints: Pubkey[]): Promise<Result<UnsignedTx, { code: string }>>;
  buildBurnAndClose(mint: Pubkey): Promise<Result<UnsignedTx, { code: string }>>;
  buildSweep(toColdLamports: Lamports): Promise<Result<UnsignedTx, { code: string }>>;
  buildSimulationOnly(r: { payer: Pubkey; mint: Pubkey; poolId: Pubkey; venue: VenueId; notional: Lamports; shape: 'buy' | 'buy_then_sell' }): Promise<Uint8Array>;
}
```

#### B-M16-01 — Compute-budget, tip and control-account composition; compute-unit profiles; v0 compile and size check

- **Module:** M16 · **Size:** M (~2 engineer-days) · **Phase:** 1 (needed by simulation builds), 2, 3
- **Goal:** One reviewed implementation of the parts every transaction shares: exactly one `SetComputeUnitLimit` and one `SetComputeUnitPrice` (with the anti-front-running control account as its first account), tip transfers at the end, compilation to a v0 message, and the 1,232-byte size check; plus the per-route measured compute-unit profile.
- **Depends on:** B-M19-01. Group A: none at runtime (pure functions). Library: `@solana/kit` 8.x exact-pinned [LD-36, LD-05] (message compilation and base58 only).
- **Interfaces:**

```ts
type Ix = { programId: Pubkey; accounts: Array<{ pubkey: Pubkey; isSigner: boolean; isWritable: boolean }>; data: Uint8Array };
interface TipSpec { path: LandingPath; lamports: Lamports }
interface Composition {
  computeBudgetIxs(cuLimit: Cu, cuPrice: MicroLamportsPerCu, controlAccount: Pubkey): [Ix, Ix];   // [SetComputeUnitLimit, SetComputeUnitPrice]
  tipIxs(payer: Pubkey, tips: TipSpec[], rng: Rng): Result<Ix[], { code: 'E_TIP_ACCOUNTS' | 'E_TIP_CAP' }>;
  compileV0(payer: Pubkey, ixs: Ix[], blockhash: BlockhashInfo | { replace: true }, lookupTables: Array<{ key: Pubkey; addresses: Pubkey[] }>):
    Result<{ messageBytes: Uint8Array; sizeBytes: number }, { code: 'E_TOO_LARGE' | 'E_COMPILE' }>;
}
interface CuProfiles {
  limitFor(routeKey: string, override: Cu | null): Cu;     // ceil(p99 × 1.1), default 200_000, clamped to [cu_min, 1_400_000]
  recordUsed(routeKey: string, cuUsed: number): void;      // from M18 meta.computeUnitsConsumed or simulation unitsConsumed
  bumpAfterComputeExceeded(previousLimit: Cu): Cu;         // min(ceil(previous × 1.5), 1_400_000)
}
// routeKey = `${venue}:${instructionName}:${withAtaCreate ? 'ata' : 'noata'}`
```

- **Logic:**
  1. `computeBudgetIxs`: build `SetComputeUnitLimit` (discriminator 2, u32 units) and `SetComputeUnitPrice` (discriminator 3, u64 micro-lamports per CU) for program `ComputeBudget111111111111111111111111111111` [LD-03]. **VERIFY** little-endian encoding of the integer arguments against the Compute Budget program docs. The control account (config `jitodontfront_account`) is appended as the **first** account of `SetComputeUnitPrice`, read-only, non-signer (satisfies Harmonic's first-account rule [LD-V02] and Jito's any-instruction rule [LD-16]). **VERIFY in simulation (A-16)** that the Compute Budget program accepts the extra read-only account; if it does not, the fallback is to attach it read-only to the swap instruction as a remaining account (Jito rule only) and record the decision in `VERIFY.md`. Exactly one of each compute-budget instruction per transaction; a second would fail the whole transaction with `DuplicateInstruction` [LD-03]; a unit test asserts this for every builder output.
  2. Priority fee lamports for cost accounting = `ceil(cuPrice × cuLimit / 1_000_000)` on the **requested** limit [LD-02]; exposed as a pure helper `priorityFeeLamports(cuPrice, cuLimit)` that lives in `@bot/types` `units.ts` (B-M19-01; integration: group A's A-M10-02/03 import it from there, so M10 does not depend on M16) and is used by M10/M23/M22 so the formula exists once.
  3. `tipIxs`: for each `TipSpec`, one System transfer from `payer` to one account chosen uniformly at random from the configured list for that path. Sender tip accounts: config list `sender_tip_accounts` (**VERIFY** the official Helius Sender tip-account list, A-30). Jito tip accounts: config list `jito_tip_accounts` = the 8 accounts returned by Jito `getTipAccounts` and listed in Jito's docs [LD-17]; the list is reviewed and pinned in config, never fetched at runtime, because the signer must allowlist the same destinations (B-M17-06). Minimums: Sender ≥ 5,000 lamports [LD-22]; Jito ≥ 1,000 lamports [LD-17]. Each tip ≤ `tip_cap_lamports` (10,000 per tip, ARCH 8.3) → else `E_TIP_CAP`. Tip accounts are never put in an address lookup table [LD-17]. Tips are the last instructions of the transaction.
  4. `compileV0`: compile a v0 message (D10) with the hot wallet (or the simulation payer for simulation builds) as fee payer and the given lookup tables (empty for direct adapters). `sizeBytes` is the size of the serialised transaction including one 64-byte signature and the signature count; > 1,232 bytes → `E_TOO_LARGE` [LD-06]. For `{ replace: true }` (simulation only) a placeholder blockhash is used and the caller sets `replaceRecentBlockhash` [TH-46].
  5. `CuProfiles`: keep the last `cu_window` (200) observations per route key; `p99` by nearest-rank; `limitFor = clamp(ceil(p99 × 1.1), cu_min, 1_400_000)` [LD-02 "simulate and add 10%"]; with fewer than `cu_min_samples` (20) observations use `cu_default` (200,000, ARCH 2.2 A-02). Override (after `compute_exceeded`) wins. Profiles persist in `kv_state` (B-M24-02) so restarts keep them.
- **Shared resources and concurrency:** Owns "per-route measured compute-unit profiles" (ARCH M16). Pure functions otherwise. Profile updates on the event loop.
- **Config:** `m16.jitodontfront_account` (Pubkey; validated: base58 decodes to 32 bytes and the string starts with `jitodontfront` [LD-16]); `m16.sender_tip_accounts` (list of Pubkey, non-empty, VERIFY A-30); `m16.jito_tip_accounts` (list of exactly 8 Pubkeys [LD-17]); `m16.tip_cap_lamports` (10,000; ceiling from `/etc/bot/ceilings.json`); `m16.cu_default` (200,000; 50,000-1,400,000; `affectsReturns: true`); `m16.cu_min` (50,000); `m16.cu_window` (200); `m16.cu_min_samples` (20). `requiresRestart: true` for tip-account lists (signer config must match; CL-05).
- **Edge cases and failure handling:**
  1. Tip list empty or a configured account fails base58 decode → config invalid at start (M25 → `exits_only`, ARCH M25).
  2. Override larger than 1,400,000 → clamped to 1,400,000 [LD-02].
  3. Rung-2+ transactions carry both tips (CB-23); both count against `tip_cap_lamports` separately.
- **Acceptance criteria:**
  1. Given `cuLimit` 220,000 and `cuPrice` 25,000, then `priorityFeeLamports` = 5,500 and the encoded instructions decode back to the same values.
  2. Given any builder output in the test corpus, then it contains exactly one instruction with discriminator 2 and one with discriminator 3 for the Compute Budget program, and the `SetComputeUnitPrice` first account equals the configured control account and is read-only.
  3. Given 199 recorded CU values with p99 = 180,000, then `limitFor` returns 198,000.
  4. Given tips `[{sender, 5000}, {jito_tx, 1000}]`, then the last two instructions are System transfers to one account from each configured list.
- **Tests:** unit (encoding round trip, p99, clamps, size calculation); property (random instruction lists: never two compute-budget instructions; size computation equals the serialised length); integration: simulate (unsigned, `replaceRecentBlockhash`) a PumpSwap sell built with the control account on mainnet state via B-M16-05's path, fixture `FX-SIM-CONTROL-ACCOUNT` (A-16); failure injection: oversize message.
- **Observability:** metrics `cu_used` (route), `cu_limit_requested` (route), `tx_size_bytes` (route); log codes `m16.too_large`, `m16.cu_profile_default`.
- **Security notes:** Tip destinations come only from reviewed config and must equal the signer's allowlist; a mismatch is a start-up error. Control account is read-only and non-signer.
- **Facts used:** LD-02, LD-03, LD-06, LD-16, LD-17, LD-22, LD-V02, TH-46, LD-36, LD-05. VERIFY: Compute Budget argument byte order; A-16; A-30.
- **Definition of done:** Common DoD; `VERIFY.md` records A-16 and A-30 results; the helper `priorityFeeLamports` is the only implementation of the formula in the repository (grep check in CI).

#### B-M16-02 — Temporary wSOL account and ATA composition

- **Module:** M16 · **Size:** M (~1.5 engineer-days) · **Phase:** 1, 2, 3
- **Goal:** Implement D22 option (e): every swap creates, funds, uses and closes a temporary wSOL account inside the same transaction; buys create the base-mint ATA idempotently; token ATAs are never closed in a swap transaction.
- **Depends on:** B-M16-01. Group A: M01 `isAllowedVenue`, token program per mint from M06 `TokenMetadataCache` (decimals, token program).
- **Interfaces:**

```ts
interface AtaHelper {
  deriveAta(owner: Pubkey, mint: Pubkey, tokenProgram: Pubkey): Pubkey;                       // pure PDA derivation (VERIFY seeds and ATA program id)
  createIdempotentIx(payer: Pubkey, owner: Pubkey, mint: Pubkey, tokenProgram: Pubkey): Ix;    // VERIFY instruction and account order (A-31)
}
interface WsolPlan { setup: Ix[]; teardown: Ix[]; wsolAccount: Pubkey }
interface WsolComposer {
  forBuy(owner: Pubkey, quoteLamports: Lamports): WsolPlan;    // create-idempotent wSOL ATA, System transfer quoteLamports, SyncNative; teardown CloseAccount → owner
  forSell(owner: Pubkey): WsolPlan;                             // create-idempotent wSOL ATA (receives proceeds); teardown CloseAccount → owner
}
```

- **Logic:**
  1. wSOL mint `So11111111111111111111111111111111111111112` [DA-V01] belongs to SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` [LD-V05]; base mints use their own token program (pump mints: Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` [DA-12, TH-16]).
  2. `deriveAta`: PDA of (owner, token program, mint) under the Associated Token Account program. **VERIFY** the ATA program ID and seed order against the official SPL ATA documentation before coding (not in the register); golden-test against `@solana/kit`-compatible helpers and against ATAs observed in fixture `FX-TX-PUMPSWAP-BUY`.
  3. `forBuy(owner, q)`: `[createIdempotent(wSOL ATA), SystemTransfer(owner → wSOL ATA, q), SyncNative(wSOL ATA)]`, teardown `[CloseAccount(wSOL ATA, destination = owner, authority = owner)]`. `q` = `quote.amountIn` plus the curve fee when `feeSchedule.feeOnBuy == 'added_on_top'` [EX-05]. **VERIFY** `SyncNative` and `CloseAccount` instruction encodings and that a native account closes with a non-zero balance, returning all lamports (A-34, A-36).
  4. `forSell(owner)`: `[createIdempotent(wSOL ATA)]`, teardown `[CloseAccount(wSOL ATA → owner)]`, which unwraps the proceeds and refunds the rent in the same transaction (D22).
  5. Composition order inside a swap (ARCH M16): compute budget (B-M16-01) → buys only: create-idempotent base ATA (owner = hot wallet) → wSOL setup → swap instruction → wSOL teardown → tips. Token ATAs are never closed here (CA-02); a unit test asserts no `CloseAccount` targets a non-wSOL account in any swap.
  6. Any pre-existing wSOL balance in the hot wallet's wSOL ATA (normally zero) would be swept into the proceeds by the close; M22 counts wSOL as SOL (CA-16), so this is consistent.
- **Shared resources and concurrency:** Token accounts are owned by M22 (ARCH 7.2): M16 only emits create-idempotent instructions; M22 updates its registry from confirmed transactions. No state in this ticket.
- **Config:** none beyond B-M16-01.
- **Edge cases and failure handling:**
  1. The wSOL ATA exists from a crashed earlier transaction with a balance → create-idempotent succeeds; the close returns everything to the hot wallet; reconcile counts it as SOL.
  2. A buy whose `q` would exceed the hot wallet's available balance → caught earlier by M22 reservations; the builder does not check balances.
  3. Mint's token program unknown (cache miss) → `E_ROUTE` (M06 must have screened the mint).
- **Acceptance criteria:**
  1. Given a buy of 66,666,667 lamports on PumpSwap, then the instruction sequence is CB, CB, createIdempotent(base ATA), createIdempotent(wSOL ATA), transfer 66,666,667, SyncNative, swap, CloseAccount(wSOL → owner), tip.
  2. Given any swap built, then no instruction closes a token ATA.
  3. Given a simulated buy-then-close on mainnet state (unsigned), then post-simulation the wSOL ATA does not exist and the owner's lamport change equals −(input + fees + tips + base ATA rent).
- **Tests:** unit (instruction order, PDA derivation vectors); integration (simulation on mainnet state with the simulation payer, fixture `FX-SIM-WSOL-ROUNDTRIP`; size within 1,232 bytes, A-46); failure injection: pre-existing wSOL ATA with balance.
- **Observability:** log code `m16.wsol_preexisting` when a build-time read (if one was made for diagnostics) shows a wSOL ATA present; metric `wsol_preexisting_total`.
- **Security notes:** Every close and transfer destination is the hot wallet itself (or the simulation payer in simulation builds), matching the signer's close and transfer rules (B-M17-06).
- **Facts used:** DA-V01, LD-V05, DA-12, TH-16, EX-05, LD-06, TH-46. VERIFY: ATA program ID and seeds, create-idempotent instruction (A-31), `SyncNative` (A-36), `CloseAccount` semantics (A-34), size fit (A-46).
- **Definition of done:** Common DoD; A-31, A-34, A-36, A-46 resolved in `VERIFY.md`.

#### B-M16-03 — PumpSwap direct adapter (instruction encoders and account lists)

- **Module:** M16 · **Size:** L (~3 engineer-days) · **Phase:** 1, 2, 3
- **Goal:** Encode PumpSwap `buy_exact_quote_in` (default buy), `buy` and `sell` from the pinned `pump_amm.json` IDL with exactly the documented account counts (23/23/21 [EX-10]), golden-tested against the official SDK (test-only dependency).
- **Depends on:** B-M16-02. Group A: M02 `Decoders.idlVersion(pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA)` (pinned IDL commit and hash), M02 `DecodedAccount` `pumpswap_pool` (vaults, mints, creator, `coinCreator` if decoded), M01 `Quote`, `FeeSchedule`, `minOut`.
- **Interfaces:**

```ts
interface VenueAdapter {
  venue: VenueId;
  buyIx(a: { owner: Pubkey; pool: DecodedAccount & { kind: 'pumpswap_pool' }; poolId: Pubkey; baseTokenProgram: Pubkey;
             spendableQuoteLamports: Lamports; minBaseOut: BaseUnits }): Result<Ix, { code: 'E_ROUTE' }>;
  sellIx(a: { owner: Pubkey; pool: DecodedAccount & { kind: 'pumpswap_pool' }; poolId: Pubkey; baseTokenProgram: Pubkey;
              baseIn: BaseUnits; minQuoteOut: Lamports }): Result<Ix, { code: 'E_ROUTE' }>;
  programIds(): Pubkey[];          // for UnsignedTx.declared.programs
}
```

- **Logic:**
  1. Program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; GlobalConfig `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`; fee program `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`; PumpSwap FeeConfig `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` [EX-01]. Constants live in M01's reviewed constants file (group A); this adapter imports them.
  2. Discriminators, argument order and types, and the full ordered account list (including PDAs such as event authority, coin-creator vault, protocol fee recipient and its token account, volume accumulators) are taken **only** from the pinned IDL at the commit recorded by M02. Every PDA seed comes from the IDL `pda` definitions. **VERIFY** each derived account against a recorded mainnet PumpSwap buy and sell of the same pool (fixtures `FX-TX-PUMPSWAP-BUY`, `FX-TX-PUMPSWAP-SELL`), not against memory.
  3. Buy default = `buy_exact_quote_in` (ExactIn on the quote side, matching M01's `quoteExactIn` and the notional-sized entry) with `spendable_quote_in = quote.amountIn` and the minimum base out = `M01.minOut(quote, minOutBps)`. **VERIFY** the exact argument names and whether the minimum-out argument exists in `buy_exact_quote_in` (EX-10 lists `buy(base_amount_out, max_quote_amount_in)` and that `buy_exact_quote_in` takes 23 accounts and `track_volume`; it does not name every argument). If `buy_exact_quote_in` has no minimum-output argument, use `buy` with `base_amount_out = minOut` and `max_quote_amount_in = amountIn` instead and record the choice.
  4. Sell = `sell` with base amount in = the on-chain balance (or chunk) supplied by B-M16-04 and minimum quote out = `minOut`. **VERIFY** argument names (`min_quote_amount_out` is the name the signer decodes, ARCH M17).
  5. `track_volume`: pass the value the official SDK passes for a standard trade; **VERIFY**; if it triggers `user_volume_accumulator` creation (rent paid by the user, as on the curve [EX-13]), the reservation in M22 must include that rent on the first trade (CL-06).
  6. Optional remaining account for cashback coins [EX-10] and any buyback-recipient account (open question A-10): v1 excludes cashback, mayhem and holder-reward coins by the `mayhem_or_special` screen (ARCH 8.4), so the adapter never adds optional accounts; if simulation of a normal pool fails for a missing account, the build fails `E_ROUTE` and the A-10 question is escalated, never guessed.
  7. Quote mint must be wSOL and the pool must be canonical (M01 normalised; `isCanonical = true`); otherwise `E_ROUTE`.
  8. Golden test: for 20 recorded inputs, the encoded instruction data and account metas equal the output of `@pump-fun/pump-swap-sdk` [EX-10] at a pinned version installed **only** in the test workspace (never a runtime dependency; ARCH 4.4).
- **Shared resources and concurrency:** Stateless. Reads pinned IDL files (owned by M02).
- **Config:** none (IDL commit and hash are pinned by M02; a mismatch refuses start, ARCH M02).
- **Edge cases and failure handling:**
  1. Pool decoded with `layout_extended` flag (M02) → `E_ROUTE` and alert; entries on that pool are blocked by M02's rule; exits fall to rung 4 (ARCH 8.7).
  2. Venue `disable_flags` show buy or sell disabled (M06 `venue_enabled`) → the adapter still encodes (it does not read state); the on-chain failure is classified `venue_disabled` (ARCH 7.3a).
  3. IDL commit changes upstream → no effect until M02's pinned files are deliberately updated through review; a pump interface change [EX-11] is detected by simulation failures and quarantine.
- **Acceptance criteria:**
  1. Given the pinned IDL, then buy-variant instructions carry 23 accounts and `sell` carries 21 [EX-10].
  2. Given the 20 golden vectors, then bytes and account metas equal the SDK output exactly.
  3. Given a mainnet-state simulation (unsigned, simulation payer) of a buy of 0.05 SOL followed by a sell of the received tokens, then both instructions succeed and the decoded `BuyEvent`/`SellEvent` fee bps equal M01's `feeFor` for that pool [EX-07, EX-37].
- **Tests:** unit (encoders); golden (SDK oracle); integration (simulation on 3 recorded canonical pools in different fee tiers, including one across the 420 SOL boundary, fixture `FX-POOL-TIER-420`); failure injection: non-canonical pool, USDC-quoted pool (`E_ROUTE`).
- **Observability:** metric `adapter_build_total` (venue, ix, result); log code `m16.adapter_route_error`.
- **Security notes:** The SDK is a test-only dependency installed with scripts disabled in a separate workspace (B-M30-01); the encoders are reviewed by a second person against the IDL.
- **Facts used:** EX-01, EX-07, EX-08, EX-09, EX-10, EX-11, EX-13, EX-37, DA-11, DA-14. VERIFY: argument names and minimum-output semantics of `buy_exact_quote_in` and `sell`; `track_volume`; PDA accounts against recorded transactions; A-10.
- **Definition of done:** Common DoD; golden tests pass; the instruction names and argument names used by the signer decoder (B-M17-04) are generated from the same pinned IDL.

#### B-M16-04 — `buildSwap`: balance-based sells, chunks, fresh quotes, double tips and failure codes

- **Module:** M16 · **Size:** L (~2.5 engineer-days) · **Phase:** 3 (live); used by the standalone exit path (B-M29-02)
- **Goal:** Assemble a complete unsigned v0 swap transaction for an order attempt: fresh pool read, fresh quote, sell amount from the chain balance at build time, `minOut`, compute budget, tips for every landing path, blockhash, size check, and the typed failure codes M19 acts on.
- **Depends on:** B-M16-03, B-M15-02, B-M15-03, B-M22-02. Group A: M04 `PoolTracker.freshRead(poolId, maxLagSlots)`, M01 `VenueModel.quoteExactIn`, `minOut`, `feeFor`, M06 `TokenMetadataCache` (token program).
- **Interfaces:** `TxBuilder.buildSwap` as above. Internal: `interface BalanceSource { ataBalance(mint: Pubkey): Promise<Result<{ amountBase: BaseUnits; slot: Slot }, { code: string }>> }` (M22, B-M22-02).
- **Logic:**
  1. Validate: `side == 'buy'` ⇒ `amountIn > 0` and `sellAmount == null`; `side == 'sell'` ⇒ `amountIn == null` and `sellAmount != null`; `rung ∈ 1..5`; `rung == 4` is rejected here (rung 4 uses B-M16-07). Else `E_ROUTE`.
  2. Fresh read (semantics of A-M04-02 / C-09, adopted at integration): entries call `freshRead(poolId, 8)` once (A-M04-02 already performs the one internal re-read); `E_STALE` → `E_ROUTE` with message `stale_pool` (CL-55). Exits call `freshRead(poolId, Number.POSITIVE_INFINITY)`, which never returns `E_STALE` and itself alerts when lag > 40 slots (ARCH 8.5); this ticket additionally logs `m16.exit_stale_read` when the returned lag > 40.
  3. Sells: `ataBalance(mint)` at `confirmed`, P0 (M22). `0` → `E_ZERO_BALANCE`. `full_balance` → `sellBase = balance`; `chunk` → `sellBase = min(maxBase, balance)`. Record `sellAmountBase` and `balanceReadSlot` in the `UnsignedTx` (CA-02, CA-03). The ledger's `sizeBase` is never used for the amount.
  4. Quote: `quoteExactIn(snapshot.pool, side, amountIn | sellBase)`. Entries: if the quote's implied price moved more than the intent's `maxSlippageBps` from the decision price, return `E_QUOTE_DRIFT` (M19 maps this to `abandoned (price_moved)` for entries; ARCH 7.3). `minOut = minOut(quote, minOutBps)` (floor).
  5. CU limit = `cuLimitOverride ?? CuProfiles.limitFor(routeKey, null)`. CU price = request's `cuPrice` (already clamped by M21/M20). Tips = request's `tips`: every transaction whose `landing` includes `sender` gets a Sender tip ≥ 5,000 [LD-22]; rung ≥ 2 adds a Jito tip ≥ 1,000 [LD-17] (CB-23). If `landing` contains `sender` and no Sender tip is given → `E_ROUTE` (Sender rejects transactions without a tip and a `SetComputeUnitPrice` [LD-22]).
  6. Blockhash: `BlockhashCache.fresh(20_000, { allowStale: side === 'sell' })`; failure → `E_BLOCKHASH`.
  7. Compose: B-M16-01 + B-M16-02 + B-M16-03; compile v0 with no lookup tables; size > 1,232 → `E_TOO_LARGE` (no optional accounts exist in v1 to drop; ARCH M16).
  8. Return `UnsignedTx` with `declared.purposeHint` = `'buy'` or `'exit'` (informational; the signer classifies itself, B-M17-05) and `tipLamports` = sum of tips.
  9. Chunk sizing for rung 5 and for exits whose full-size impact exceeds the rung's slippage cap is computed by M20 (B-M20-04) and passed as `chunk.maxBase`; the builder only enforces `≤ balance`. Concurrency rule (CA-03): M19 ensures concurrently outstanding chunks sum to no more than the balance read at build.
- **Shared resources and concurrency:** Reads M22's balance (owner M22) and M04's snapshot (owner M04) without holding anything across awaits. Idempotency: a build is a pure function of its inputs plus fresh reads; each attempt has its own `attemptNo`.
- **Config:** `m16.entry_fresh_lag_slots` (8; 1-12; `affectsReturns: true`); `m16.exit_alert_lag_slots` (40); `m16.blockhash_max_age_ms` (uses M15 value).
- **Edge cases and failure handling:**
  1. Dust deposit into our ATA before an exit (CA-02): the sell sells the full on-chain balance including the dust; succeeds.
  2. Balance read slot older than the latest confirmed exit of a superseding attempt: the signer's own balance check (`E_BALANCE`) catches it (B-M17-06); M19 rebuilds with a fresh read.
  3. Quote returns `E_NEGATIVE_EFFECTIVE` or `E_FEE_UNKNOWN` from M01 → entries `E_ROUTE`; exits use the last valid fee schedule plus 100 bps of extra slippage (ARCH M01 failure table) via M01's own fallback.
- **Acceptance criteria:**
  1. Given a sell intent and an on-chain balance of 1,000,123 base units while the ledger says 1,000,000, then `sellAmountBase` = 1,000,123.
  2. Given a balance of 0, then `E_ZERO_BALANCE` and no transaction is built.
  3. Given rung 2 with landing `[sender, rpc, jito_tx]`, then the transaction contains a Sender tip and a Jito tip, both last, and `tipLamports` = 6,000.
  4. Given an entry whose fresh read stays stale after one re-read (observation lag 9 slots twice; M04 returns `E_STALE`), then the builder returns `E_ROUTE` with message `stale_pool` and M19 ends the entry `abandoned` (ARCH 8.5: re-read once, then abandon; CL-55); given the same lag on an exit, the build proceeds.
- **Tests:** unit (validation matrix, chunk clamp, tip rules); integration (mainnet-state simulation, unsigned, for buy and sell with fixtures `FX-POOL-DEEP-1`, `FX-POOL-DEEP-2`); failure injection: blockhash unavailable for an entry (error) and for an exit (stale allowed); dust deposit scenario (ARCH 16.5).
- **Observability:** metrics `build_latency_ms` (route, side), `quote_drift_bps`, `build_result_total` (code); log codes `m16.build_failed`, `m16.exit_stale_read`.
- **Security notes:** The builder never chooses destinations other than the hot wallet, its own ATAs and configured tip accounts; the signer re-checks all of them.
- **Facts used:** LD-02, LD-06, LD-07, LD-17, LD-22, EX-05, EX-09. VERIFY: `getTokenAccountBalance` (A-36, via M22).
- **Definition of done:** Common DoD; the ARCH 16.5 rows "Dust deposit" and "Rung-1 exit not landed in 8 slots" pass end-to-end with B-M19-05 and B-M17-06.

#### B-M16-05 — Simulation-only builds for honeypot checks and shadow mode

- **Module:** M16 · **Size:** S (~1 engineer-day) · **Phase:** 1
- **Goal:** Provide `buildSimulationOnly` for M06's honeypot check and M12's shadow mode: unsigned transactions whose fee payer and token owner is the simulation payer (D31), in shapes `buy` and `buy_then_sell` (one combined transaction), for use with `simulateTransaction` with `sigVerify` false and `replaceRecentBlockhash` [TH-46].
- **Depends on:** B-M16-03. Group A: M04 `latest(poolId)` (pool state for the quote), M01 quote math. Consumers: M06, M12 (group A).
- **Interfaces:** `TxBuilder.buildSimulationOnly(r)` returns the serialised unsigned transaction bytes (signature slots zero-filled).
- **Logic:**
  1. `payer` must equal the configured `sim_payer_pubkey` (D31); any other value → throws a programmer error (prevents simulations with the hot wallet's state being used as evidence for paper gates).
  2. Shape `buy`: compute budget (limit = profile × 1.1 or default), wSOL buy plan for `notional`, create-idempotent base ATA for the payer, PumpSwap buy with `minBaseOut` = `minOut(quote, sim_min_out_bps)`, wSOL close. No tips (simulation never lands; tips would only distort the output check). Rationale recorded: tips are excluded from honeypot simulations because they are not part of the swap's economics (CL-07).
  3. Shape `buy_then_sell`: the same buy, then a PumpSwap sell of exactly the buy's quoted `minOut` tokens (ARCH M06: the sell never needs tokens the payer does not hold), with `minQuoteOut = 0` so the simulation reports the actual output instead of failing on slippage (the honeypot rule compares the output itself), then wSOL close.
  4. Compile with `{ replace: true }` blockhash.
  5. No balance reads and no M22 involvement (the simulation payer is not the hot wallet).
- **Shared resources and concurrency:** Stateless.
- **Config:** `m16.sim_payer_pubkey` (Pubkey, required); `m16.sim_min_out_bps` (50).
- **Edge cases and failure handling:** Payer underfunded → simulation fails in M06 with an insufficient-funds error; M06 marks `honeypot_sim = error` (its balance check, ARCH M06). Message too large → throws a typed error `E_TOO_LARGE` to the caller (M06 then reports `error`).
- **Acceptance criteria:**
  1. Given shape `buy_then_sell` for 0.05 SOL, then the transaction contains exactly one buy and one sell instruction, the sell amount equals the buy's `minOut`, and the fee payer is the simulation payer.
  2. Given the transaction simulated on mainnet state with `replaceRecentBlockhash`, then the simulation result includes the sell's SOL output (fixture `FX-SIM-ROUNDTRIP`).
- **Tests:** unit (shape assembly); integration (simulation on 3 recorded pools, `FX-SIM-ROUNDTRIP`); failure injection: hot-wallet pubkey passed as payer (programmer error).
- **Observability:** metric `sim_build_total` (shape).
- **Security notes:** The simulation payer's private key is never on the host (D31); these transactions are never signed. This code path must not be reachable from M19 (lint rule: no import of `buildSimulationOnly` from execution modules).
- **Facts used:** TH-46, EX-10, D31 (ARCH). VERIFY: inherits B-M16-02/03 items.
- **Definition of done:** Common DoD; M06 and M12 integration tests (group A) use this function.

#### B-M16-06 — Jupiter `/build` route adapter (research and paper; non-primary)

- **Module:** M16 · **Size:** M (~1.5 engineer-days) · **Phase:** research/paper only (deferred until a research or paper ticket needs Raydium or other venues before direct adapters exist)
- **Goal:** Obtain instructions and lookup tables from Jupiter `GET /swap/v2/build` (Metis, no Jupiter fee, ExactIn only [EX-25, EX-26, EX-32, EX-V03]), replace its compute-unit price with ours, apply the temporary-wSOL pattern, and refuse routes that do not touch exactly the polled pool.
- **Depends on:** B-M16-04. Group A: M14 `RpcGateway.http('jupiter', …)`, M14 address-lookup-table reads (`getMultipleAccounts` or the method that returns ALT contents; **VERIFY** the ALT account layout), M01 quote (for drift check).
- **Interfaces:** `buildSwap` with `route: 'jupiter_build'`. Internal: `interface JupiterBuildClient { build(req: { inputMint: Pubkey; outputMint: Pubkey; amount: bigint; taker: Pubkey; slippageBps: Bps; dexes: string[]; maxAccounts: number }): Promise<Result<{ instructions: Ix[]; lookupTables: Pubkey[]; expectedOut: bigint }, { code: 'E_NO_ROUTE' | 'E_RATE_LIMITED' | 'E_HTTP' }>> }`.
- **Logic:**
  1. Request parameters (from [EX-32]): `inputMint`, `outputMint`, `amount`, `taker` (required); numeric `slippageBps` (never `'rtse'`), `dexes` = the pool's venue label (**VERIFY** case-sensitive labels, A-14), `maxAccounts` (default 64, range 1-64 [EX-32]). Never `mode=fast` (BETA [EX-32]). ExactIn only [EX-V03].
  2. "No routes found" → `E_NO_ROUTE` (Metis may have dropped the market [EX-28]); M19 → direct adapter if available, else entry abandoned / exit escalates (ARCH M16).
  3. Remove Jupiter's compute-budget instructions and insert ours (B-M16-01) with our CU price [EX-32 advises validating and capping the returned price]; insert our control account and tips.
  4. Wrapping: **VERIFY** the `/build` parameter that controls SOL wrap/unwrap (A-41, name UNVERIFIED); set it so Jupiter does not wrap, and add B-M16-02's temporary wSOL plan; if the parameter cannot be confirmed, the adapter is disabled for live use and stays research-only.
  5. Route check (CB-07): every swap instruction in the response must reference the pool account M04 polls for this candidate and no other pool account of any allowlisted venue; else `E_ROUTE_POOL_MISMATCH`.
  6. Drift check: if `expectedOut` is worse than our local quote's `amountOut` by more than 30 bps → `E_QUOTE_DRIFT` (ARCH M16 rule).
  7. Compile v0 with the returned lookup tables (contents read through M14, P0 for exits, P1 for entries); size > 1,232 → `E_TOO_LARGE`.
  8. Rate limits: the call uses M14's Jupiter bucket (keyless 0.5 req/s or free key 1 req/s [EX-29, DA-30]); a 429 returns `E_RATE_LIMITED` immediately and M20 uses the direct adapter (ARCH M14 "exits never wait for Jupiter").
- **Shared resources and concurrency:** Shares the Jupiter bucket owned by M14. Stateless otherwise.
- **Config:** `m16.jupiter_dex_labels` (map VenueId → label; VERIFY A-14); `m16.jupiter_max_accounts` (64; 1-64); `m16.jupiter_drift_bps` (30; 0-200; `affectsReturns: true`); `m16.jupiter_build_enabled` (bool, default false).
- **Edge cases and failure handling:** Response with an instruction from a program not on the signer allowlist → the signer refuses (B-M17-06); the builder pre-checks and returns `E_ROUTE` to save a round trip. Response including a JupiterZ-only route is impossible on `/build` (Metis-only [EX-25]).
- **Acceptance criteria:**
  1. Given a recorded `/build` response whose swap references a different pool than the polled one, then `E_ROUTE_POOL_MISMATCH`.
  2. Given a response whose expected output is 40 bps worse than the local quote, then `E_QUOTE_DRIFT`.
  3. Given a response containing two compute-budget instructions, then the built transaction contains exactly our two.
- **Tests:** unit (response mapping with recorded fixtures `FX-JUP-BUILD-*`); contract test with the free key at ≤ 1 req/s (ARCH 16.3); failure injection: 429, "No routes found".
- **Observability:** metrics `jupiter_build_total` (result), `quote_drift_bps`; log codes `m16.jup_no_route`, `m16.jup_pool_mismatch`.
- **Security notes:** The Jupiter key is added by M14; responses are untrusted input: parse with a strict schema; never pass Jupiter-supplied destinations to the signer without the signer's own classification.
- **Facts used:** EX-25, EX-26, EX-28, EX-29, EX-32, EX-V03, DA-30, LD-06. VERIFY: A-14, A-41, ALT layout.
- **Definition of done:** Common DoD; disabled by default; enabling for live requires D01/D18 switch conditions (direct Raydium adapters are the live path, not this).

#### B-M16-07 — Rung-4 exit: Jupiter `/order` pre-built transaction intake

- **Module:** M16 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Implement the "pre-built transaction" mode required by D01 for ladder rung 4 (ARCH 8.7): request a Jupiter Meta-Aggregator `/order` transaction for selling the full on-chain balance, validate it locally, and hand it to M19 as an `UnsignedTx` that the signer classifies by its own simulation (non-decodable route) and M18 lands through `/execute` (B-M18-05).
- **Depends on:** B-M16-04. Group A: M14 `RpcGateway.http('jupiter', …)` (Jupiter `/order` shares the swap bucket; `/execute` has its own bucket [EX-29]), M22 `ataBalance` (via B-M22-02).
- **Interfaces:**

```ts
interface JupiterOrderExit {
  buildOrderExit(r: { intentId: Id; attemptNo: number; mint: Pubkey; slippageBps: Bps /* rung-4 cap 1,500 */ }):
    Promise<Result<UnsignedTx & { route: 'jupiter_order'; jupiter: { feeBps: Bps; router: string; executeContext: unknown /* opaque fields /execute needs; VERIFY */ } },
                   { code: 'E_NO_ROUTE' | 'E_RATE_LIMITED' | 'E_HTTP' | 'E_ZERO_BALANCE' | 'E_TX_VERSION' | 'E_TX_SHAPE' }>>;
}
```

- **Logic:**
  1. Read the on-chain balance (M22 `ataBalance`, P0). Zero → `E_ZERO_BALANCE`.
  2. Call `GET https://api.jup.ag/swap/v2/order` [EX-25] with input = mint, output = wSOL/SOL, amount = balance, our hot wallet as taker, and slippage = `slippageBps`. **VERIFY** the parameter names (including the taker parameter and how slippage is passed; EX-27 shows an `/order` call without a taker returns a quote only) and the response fields that carry the transaction, `feeBps` and router [EX-27], against the current Jupiter docs before coding.
  3. Parse the returned transaction: it must be a v0 transaction (`E_TX_VERSION` otherwise, CL-08) whose fee payer is the hot wallet and which requires exactly one signature (ours) (`E_TX_SHAPE` otherwise). The transaction is **not modified** (JupiterZ transactions cannot be modified [EX-25]; our control account and tips cannot be added, which is why `/order` is never on the hot path, D01).
  4. Fill `UnsignedTx`: `messageBytes` = the message; `version` 0; `lookupTables` = the message's table keys (the signer resolves them itself); `cuLimit`/`cuPrice` decoded from its compute-budget instructions when present, otherwise 0 and `0n` (cost accounting then uses transaction meta; CL-08); `tipLamports` = 0 (Jupiter-managed); `sellAmountBase` = balance; `balanceReadSlot`; `quote` = M01 local quote for the same amount (for dashboard comparison only); `minOut` = 0n (the bound is enforced by the signer's simulated classification and the rung-4 cap); `declared.purposeHint = 'exit'`.
  5. `lastValidBlockHeight`: taken from the response if Jupiter provides it (**VERIFY**); otherwise set to `M15.blockHeight() + 150 + 10` at receipt as a conservative upper bound (a blockhash is valid for 150 slots [LD-07]; the blockhash in the transaction was obtained before we received it, so its true limit cannot be later than this bound) and flag `lvbhSource = 'derived_upper_bound'` (CL-09).
  6. The Jupiter fee (`feeBps`) is shown on the dashboard (ARCH 8.7) through the attempt record.
- **Shared resources and concurrency:** Uses the Jupiter bucket (M14). While any exit attempt is building or in flight, M14 suspends Price and Tokens calls (ARCH M14); a 429 returns `E_RATE_LIMITED` immediately (no waiting) and M20 moves to rung 5.
- **Config:** `m16.jupiter_order_enabled` (bool, default true for rung 4); `m16.rung4_slippage_bps` (1,500; ceiling 2,500).
- **Edge cases and failure handling:** Legacy or v1 transaction → `E_TX_VERSION` (M20 escalates to rung 5); `/order` returns a quote without a transaction (missing taker) → `E_TX_SHAPE`; fee above the rung-4 cap → the signer refuses (B-M17-06, 2,000,000 lamports total) and M20 escalates.
- **Acceptance criteria:**
  1. Given a recorded `/order` response with a v0 transaction, then the `UnsignedTx` message bytes equal the response's message bytes byte for byte.
  2. Given a response with a legacy transaction, then `E_TX_VERSION`.
  3. Given no `lastValidBlockHeight` in the response and `blockHeight()` = 1,000, then `lastValidBlockHeight` = 1,160 and the flag is set.
- **Tests:** unit with recorded fixtures `FX-JUP-ORDER-V0`, `FX-JUP-ORDER-LEGACY`; integration: signer simulation classification of `FX-JUP-ORDER-V0` (with B-M17-05); failure injection: 429, timeout.
- **Observability:** metrics `rung4_orders_total` (result), `rung4_fee_bps`; log code `m16.rung4_order`.
- **Security notes:** The response is untrusted; parsing uses a strict schema; the signer's simulation classification (exactly one mint decreases, lamports do not fall by more than fees + tips + rent deposits) and the 2,000,000-lamport cap are the real controls [EX-25].
- **Facts used:** EX-25, EX-26, EX-27, EX-29, DA-30, LD-07. VERIFY: `/order` parameters and response fields; presence of `lastValidBlockHeight`; transaction version.
- **Definition of done:** Common DoD; the go-live checklist item 11 lists this ticket's VERIFY items as resolved.

#### B-M16-08 — Pump bonding-curve v2 adapters (research and PM-01 paper only)

- **Module:** M16 · **Size:** M (~1.5 engineer-days) · **Phase:** deferred (only if PM-01 or a curve research measurement needs shadow simulations)
- **Goal:** Encode `buy_exact_quote_in_v2(spendable_quote_in, min_tokens_out)` (27 accounts) and `sell_v2` (26 accounts) for SOL-paired curve coins [EX-10] for simulation-only builds; never used for live transactions in v1 (ARCH M16, D08: PM-01 is paper at most).
- **Depends on:** B-M16-03. Group A: M02 `pump_bonding_curve` decoded account, M01 curve quote.
- **Interfaces:** a `VenueAdapter` with `venue: 'pump_curve'`, same shape as B-M16-03 (pool argument = decoded bonding curve).
- **Logic:**
  1. Program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, Global `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, curve FeeConfig `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` [EX-01].
  2. Pass the wSOL mint as quote mint for SOL-paired coins (`BondingCurve.quote_mint == Pubkey::default()` means SOL) [DA-V01, DA-13]; v2 instructions settle in native SOL for SOL coins [EX-10], so **no temporary wSOL plan** is added for curve trades.
  3. `fee_recipient` and `buyback_fee_recipient` are chosen uniformly at random from config lists copied from pump's published recipient lists (8 each) [EX-06]; **VERIFY** the current lists before enabling.
  4. Curve fee is added on top on buys and taken from proceeds on sells [EX-05]; **VERIFY** whether `spendable_quote_in` is inclusive of fees.
  5. Refuse (`E_ROUTE`) when the decoded curve has `complete = true` [EX-03].
  6. First use creates `user_volume_accumulator` (137 bytes, rent paid by the user [EX-13]); simulation payers need that rent available.
- **Shared resources and concurrency:** Stateless.
- **Config:** `m16.pump_fee_recipients` (list of 8), `m16.pump_buyback_fee_recipients` (list of 8), `m16.pump_curve_enabled` (bool, default false).
- **Edge cases and failure handling:** Mayhem-mode or USDC-quoted coin → `E_ROUTE` (excluded by `mayhem_or_special` and `usdc_quote`, ARCH 8.4); short legacy BondingCurve accounts are handled by M02 [DA-15].
- **Acceptance criteria:** Given the pinned IDL, `buy_exact_quote_in_v2` has 27 accounts and `sell_v2` 26 [EX-10]; golden vectors equal `@pump-fun/pump-sdk` output (test-only); a simulation on a recorded incomplete curve succeeds; on a completed curve the adapter refuses.
- **Tests:** unit, golden (`FX-TX-CURVE-BUYV2`), simulation on mainnet state (unsigned).
- **Observability:** `adapter_build_total{venue="pump_curve"}`.
- **Security notes:** The signer allowlists the curve program (ARCH M17) but the live engine never builds curve trades in v1; a config validator rejects `pump_curve_enabled = true` in live modes (CL-10).
- **Facts used:** EX-01, EX-03, EX-05, EX-06, EX-10, EX-13, DA-13, DA-15, DA-V01. VERIFY: recipient lists, fee inclusivity, account derivations.
- **Definition of done:** Common DoD; disabled by default.

#### B-M16-09 — Raydium AMM v4 and CPMM direct adapters (Phase 3b, gated)

- **Module:** M16 · **Size:** L (~3 engineer-days) · **Phase:** 3b (only after the M01 Raydium venue spec is accepted)
- **Goal:** Direct sell (first) and buy adapters for Raydium AMM v4 and CPMM, encoded from Raydium's public program source [EX-36], decodable by the signer, used live only after gate P-6 passes on Raydium pools (D01, D18, CB-07).
- **Depends on:** B-M16-04. Group A: **M01 Raydium venue spec (accepted)** and M02 typed Raydium decoders (`raydium_amm_v4_pool`, `raydium_cpmm_pool`, `raydium_amm_config` replaced by typed variants).
- **Interfaces:** `VenueAdapter` for `raydium_amm_v4` and `raydium_cpmm`.
- **Logic:**
  1. Programs: AMM v4 `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`, CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` [DA-17].
  2. Every instruction name, argument and account list comes from the source files and commit named in the accepted venue spec; nothing is written from memory (**VERIFY** against the spec).
  3. Orientation: M01 normalises pools to quote = wSOL in both token orderings (CA-27); the adapter maps "buy/sell base" back to the pool's input/output vault order per the spec and golden-tests both orderings.
  4. Temporary wSOL plan as for PumpSwap; fees per AmmConfig (CPMM creator fee only when enabled [EX-22]).
  5. P-6 shadow simulation (via B-M16-05 extended to these venues) must reach the 30/100 bps error thresholds before `venue_specified` allows live.
- **Shared resources and concurrency:** Stateless.
- **Config:** `m16.raydium_enabled` (bool, default false; validator refuses `true` until the venue spec version is recorded in config).
- **Edge cases and failure handling:** Pool whose LaunchLab-bound AmmConfig fee exceeds the ceiling is rejected upstream (`fee_ceiling`, ARCH 8.4) [EX-V02].
- **Acceptance criteria:** golden tests in both token orderings against `simulateTransaction` output within 1 bp (ARCH M01 venue spec); signer decodes every instruction (B-M17-04 extension).
- **Tests:** golden fixtures `FX-RAY-AMMV4-*`, `FX-RAY-CPMM-*` in both orderings; simulation.
- **Observability:** `adapter_build_total{venue}`.
- **Security notes:** Adds programs to the signer allowlist only in the same release as the signer decoder (B-M17-04) and the sentinel path (B-M29-02).
- **Facts used:** DA-17, EX-22, EX-36, EX-V02. VERIFY: everything instruction-level, via the accepted venue spec (A-13).
- **Definition of done:** Common DoD; P-6 on Raydium pools passed and recorded.

#### B-M16-10 — Janitor close, burn-and-close and sweep builders

- **Module:** M16 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Build the three non-swap transactions: janitor closes of zero-balance token ATAs (and wSOL unwrap), burn-and-close of an unsolicited token account (operator command only), and sweeps of excess SOL to the configured cold address.
- **Depends on:** B-M16-01, B-M16-02, B-M22-02. Group A: none.
- **Interfaces:** `TxBuilder.buildJanitorClose(mints)`, `buildBurnAndClose(mint)`, `buildSweep(toColdLamports)` (ARCH M16).
- **Logic:**
  1. `buildJanitorClose(mints)`: for each mint, re-read the ATA balance (M22 `ataBalance`, P3); include a `CloseAccount(ATA → hot wallet, authority = hot wallet)` with the mint's token program **only if** the balance is exactly 0 (CA-02); skip others with reason. If the hot wallet's wSOL ATA exists (reconcile found it), add its `CloseAccount` (unwrap; CA-16). At most `janitor_max_closes` per transaction and within 1,232 bytes. Compute budget at the floor CU price (`m15.fee_floor…`) with CU limit from the janitor profile; Sender tip 5,000 lamports [LD-22]. `purposeHint = 'janitor'`. Empty set → `E_NOTHING_TO_DO`.
  2. `buildBurnAndClose(mint)`: re-read balance; `Burn(amount = balance)` then `CloseAccount → hot wallet` (**VERIFY** SPL Token / Token-2022 `Burn` encoding). Only callable from the `close_unsolicited` command path (M26 → M22); the signer independently refuses a burn for any mint it has ever signed a buy for (B-M17-06, CL-11).
  3. `buildSweep(lamports)`: one System transfer hot → `cold_wallet_pubkey` (engine config copy; must equal the signer's root-owned config value, compared at start), floor priority, Sender tip. `purposeHint = 'sweep'`. Amount computed by M22 (B-M22-04) leaving float + reservations + rent + 0.01 SOL.
- **Shared resources and concurrency:** Token accounts owned by M22; M22 calls these builders (janitor at most 1 transaction per minute, ARCH M16) and submits through M19 (purpose `janitor` / `sweep`).
- **Config:** `m16.janitor_max_closes` (8; 1-20); `m22.cold_wallet_pubkey` (Pubkey or null).
- **Edge cases and failure handling:** Balance changes between build and landing (dust arrives) → the close fails on chain (`account_state`); never counts toward cannot-sell (ARCH 7.3a); retried next minute. Cold address not configured → `buildSweep` returns `E_NO_COLD_ADDRESS`.
- **Acceptance criteria:**
  1. Given three mints with balances 0, 5, 0, then the transaction closes exactly two ATAs and reports the third as skipped.
  2. Given a sweep, then the only System transfers are to the cold address and the Sender tip account.
- **Tests:** unit (selection, size cap); simulation on mainnet state with a funded test wallet is not possible without signing — instead simulate unsigned with `sigVerify: false` against fixture accounts (`FX-SIM-JANITOR`); failure injection: dust arrives after build.
- **Observability:** metrics `janitor_closes_total` (result), `rent_refund_lamports_total`, `sweeps_total`; log codes `m16.janitor_skip`, `m16.sweep_built`.
- **Security notes:** All destinations are the hot wallet or the configured cold address; the signer enforces both independently.
- **Facts used:** LD-01, LD-14, LD-22. VERIFY: `CloseAccount` rule (A-34), `Burn` encoding.
- **Definition of done:** Common DoD; ARCH 16.5 rows "Dust deposit…" and "20 unsolicited mints…" pass with B-M22-04.

---

### M17 Signer (separate process)

The signer is a separate Node.js process run as OS user `signer` with **zero third-party runtime dependencies** (Node built-ins only; ARCH 4.4, 12.3). It may import internal packages only if those packages themselves have no third-party runtime dependencies (enforced by B-M30-01). Shared protocol types (exact copies of ARCH M17, extended per CL-15 and CL-16):

```ts
type Requester = 'engine' | 'sentinel' | 'operator_cli';                // from SO_PEERCRED, never from the request
type SignRequest = { kind: 'sign'; requestId: Id; intentId: Id; messageBytesB64: string; lookupTablesB64?: Record<Pubkey, string> /* ignored */;
  hint: 'buy' | 'exit' | 'sweep' | 'janitor'; priorAttempts?: Array<{ signature: Signature; lastValidBlockHeight: BlockHeight }> };
type SignResponse = { requestId: Id; ok: true; signature: Signature; signedTxB64: string; classification: TxClass; hintMismatch: false }
                  | { requestId: Id; ok: false; code: SignerError; message: string; hintMismatch: boolean };
type TxClass = { kind: 'buy'; mint: Pubkey; solOutLamports: Lamports; minTokenOutBase: BaseUnits }
             | { kind: 'exit'; mint: Pubkey; sellBase: BaseUnits; minSolOutLamports: Lamports | null; feeAndTipLamports: Lamports }
             | { kind: 'sweep'; lamports: Lamports } | { kind: 'janitor'; closes: Pubkey[]; burns: Pubkey[] };
type SignerError = 'E_HALTED' | 'E_POLICY_PROGRAM' | 'E_POLICY_TRANSFER' | 'E_POLICY_AUTHORITY' | 'E_POLICY_CLOSE' | 'E_POLICY_UNCLASSIFIABLE'
  | 'E_CAP_TX' | 'E_CAP_DAY' | 'E_HOTCAP' | 'E_MODE' | 'E_LOCKED' | 'E_EXITS_ONLY' | 'E_SIM_UNAVAILABLE' | 'E_SIM_FAILED'
  | 'E_DUPLICATE' | 'E_PROOF_REQUIRED' | 'E_LEASE' | 'E_ALT_UNRESOLVED' | 'E_BALANCE';
type LatchRequest = { kind: 'halt' | 'resume'; reason: string };
type StatusOfRequest = { kind: 'status_of'; intentId: Id };
type StatusOfResponse = { intentId: Id; messages: Array<{ requestId: Id; signature: Signature; messageSha256: string; classification: TxClass;
  lastValidBlockHeight: BlockHeight; signedAtMs: UnixMs }> };
type UnlockRequest = { kind: 'unlock'; passphrase: string } | { kind: 'lock' };
type LeaseRequest = { kind: 'acquire' | 'release'; scope: 'all' | Pubkey; force?: boolean };
type SignerStatus = { lock: 'locked' | 'unlocked' | 'exits_only'; latch: 'clear' | 'set'; latchSetBy: Requester | 'system' | null;
  leaseHolder: Requester | null; dayCounters: { buySolOutLamports: Lamports; buyCount: number; resetsAtMs: UnixMs };
  lastSweeps: Array<{ lamports: Lamports; signature: Signature; atMs: UnixMs }>;
  // additions (CL-15): needed by M26/M27/M29 to report signer health without guessing
  mode: 'paper' | 'live_small' | 'live'; persistence: 'ok' | 'degraded'; leases: Array<{ scope: 'all' | Pubkey; holder: Requester }> };
type StatusRequest = { kind: 'status' };                                // CL-15
type SetModeRequest = { kind: 'set_mode'; mode: 'paper' | 'live_small' | 'live' };   // CL-16: raise only by engine within ceilings; lower by anyone
```

#### B-M17-01 — Signer process, Unix sockets, peer identity and framing

- **Module:** M17 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** A minimal, single-threaded request loop listening only on two Unix sockets, deriving the requester's identity from the operating system, never from the request, with a strict wire format.
- **Depends on:** B-M30-01 (dependency policy, CI). Host layout from B-M30-02 (users `bot`, `signer`, `sentinel`; group `botops`).
- **Interfaces:**

```ts
type Frame = { lengthBE32: number; json: Uint8Array };          // u32 big-endian length prefix, then UTF-8 JSON; max 65,536 bytes
type AnyRequest = SignRequest | LatchRequest | StatusOfRequest | UnlockRequest | LeaseRequest | StatusRequest | SetModeRequest;
type ErrorResponse = { requestId: Id | null; ok: false; code: 'E_FRAME' | 'E_SCHEMA' | 'E_FORBIDDEN' | 'E_BUSY'; message: string };
interface PeerIdentity { resolve(socketPath: string, peerUid: number): Requester | null }
```

- **Logic:**
  1. Listen on `/run/signer/engine.sock` (mode 0660, group `bot`) and `/run/signer/ops.sock` (mode 0660, group `botops`, whose members are `sentinel` and the operator's login user) (ARCH 4.3). No TCP listener; the process opens no inbound network socket.
  2. On accept, read the peer's UID with `SO_PEERCRED`. **VERIFY (A-38)** that Node on the chosen LTS exposes the peer credentials of a Unix-socket connection through a built-in API. If it does not, the documented fallback is: (a) a small audited native helper inside the signer package (the one exception allowed by ARCH 4.3), or (b) socket file permissions alone carry identity (each socket accepts only its group). The choice is recorded in `VERIFY.md` and the security review.
  3. Identity mapping (config `uid_map`): `engine.sock` + UID of `bot` → `engine`; `ops.sock` + UID of `sentinel` → `sentinel`; `ops.sock` + UID of the configured operator user → `operator_cli`. Anything else → close the connection and log `signer.peer_rejected` with the UID (no other data).
  4. Permission table (requests not listed are refused with `E_FORBIDDEN`):

| Request | engine | sentinel | operator_cli |
|---|---|---|---|
| `sign` | yes | only transactions the signer classifies as `exit` or `janitor`; any other class from the sentinel → `E_FORBIDDEN` | no |
| `status`, `status_of` | yes | yes | yes |
| `halt` | yes | yes | yes |
| `resume` | only a latch set by `engine` | no | yes (any setter; D28 (a)) |
| `acquire` lease | `all` at start, non-force only | force allowed | force allowed |
| `release` lease | no | no (sentinel asks the operator) | yes (`botctl release-lease`) |
| `unlock`, `lock` | no | `lock` only | yes |
| `set_mode` | raise within ceilings; lower | lower only | lower only |

  5. Framing: u32 big-endian length, then UTF-8 JSON; frames over 65,536 bytes or malformed JSON → `E_FRAME` and connection closed. Every request is validated by a hand-written schema validator (no third-party library): unknown fields rejected, `bigint` values transported as decimal strings and parsed with `BigInt` after a regex check (`^(0|[1-9][0-9]{0,19})$`).
  6. One global FIFO queue; requests are processed one at a time in arrival order (ARCH 7.2: "signer's single-threaded request loop"). Queue depth > `max_queue` (64) → `E_BUSY` for new `sign` requests from the engine only (sentinel and operator requests are always queued, so a flood from the engine cannot block a halt or a lease).
  7. Request processing deadline: none inside the signer (the engine times out at 2 s and asks `status_of`, ARCH 7.3).
- **Shared resources and concurrency:** Owner of everything listed in ARCH 7.2 for M17. Serialisation by the single queue; durable state rules in B-M17-03.
- **Config:** in root-owned `/etc/signer/policy.json`, read-only to `signer` (ARCH M25 "the signer reads its own copy"): `uid_map` (`{ bot: uid, sentinel: uid, operator: uid }`), `socket_paths`, `max_queue` (64; 8-1,024), `max_frame_bytes` (65,536).
- **Edge cases and failure handling:**
  1. Stale socket file at start → removed and recreated with the right mode and group; if permissions cannot be set, the signer exits non-zero (systemd retries; alert via sentinel's "signer down").
  2. Client disconnects mid-request → the request still completes and its durable effects stand (a signature produced is recorded; the engine recovers it with `status_of`).
  3. A `halt` arriving while a `sign` is queued → processed in queue order; the queued buy is evaluated after the latch is set (the latch check happens at processing time).
- **Acceptance criteria:**
  1. Given a connection on `engine.sock` from a process running as `bot`, when it sends `resume` for a latch set by `sentinel`, then the response is `E_FORBIDDEN` and the latch stays set (ARCH 16.5 "Engine sends resume for a sentinel-set latch").
  2. Given a request on `engine.sock` claiming `"requester": "sentinel"`, then the field is rejected as unknown (`E_SCHEMA`) and identity remains `engine` (ARCH 16.6).
  3. Given 100 queued engine `sign` requests, when the sentinel sends `halt`, then the halt is accepted (queued, not `E_BUSY`).
- **Tests:** unit (framing, validator, permission table); integration on a test host with real users (systemd-nspawn or a CI container with three users); security fuzzing of frames (random bytes, oversize, deep JSON nesting).
- **Observability:** the signer writes its own JSON-lines log (no secrets) to journald; codes `signer.peer_rejected`, `signer.frame_error`, `signer.forbidden`, `signer.busy`; counters exposed through `status` for the engine's M27 (`signer_refusals_total` is computed engine-side from responses).
- **Security notes:** No inbound network; identity from the OS; minimal parser; the process runs with `NoNewPrivileges`, `ProtectSystem=strict`, its own state directory and no read access to `bot` files (B-M30-02).
- **Facts used:** TH-37, TH-39 (why the signer is isolated and dependency-free). VERIFY: A-38.
- **Definition of done:** Common DoD; `npm ls --prod` (or equivalent) for the signer package lists no third-party package (CI check from B-M30-01); A-38 resolved.

#### B-M17-02 — Key storage, unlock and lock, lock states and the D26 boot path

- **Module:** M17 · **Size:** M (~2 engineer-days) · **Phase:** 3
- **Goal:** Keep the hot key encrypted at rest, decrypt it into signer memory only on operator unlock, support the `locked`, `unlocked` and `exits_only` lock states, and provide the optional D26 (ii) host-bound `exits_only` auto-unlock (required before `live`, gate LS-7).
- **Depends on:** B-M17-01.
- **Interfaces:**

```ts
interface KeyFile { version: 1; kdf: { name: string; params: Record<string, number>; saltB64: string };
  aead: { name: string; nonceB64: string; ciphertextB64: string; tagB64: string }; publicKey: Pubkey }   // file mode 0400, owner signer
interface KeyStore {
  unlock(passphrase: string, mode: 'unlocked' | 'exits_only'): Result<true, { code: 'E_BAD_PASSPHRASE' | 'E_KEY_MISMATCH' | 'E_RATE_LIMITED' }>;
  lock(): void;
  state(): 'locked' | 'unlocked' | 'exits_only';
  sign(message: Uint8Array): Uint8Array;            // 64-byte Ed25519 signature; throws if locked (callers check state first)
  publicKey(): Pubkey;
}
// separate offline tool in the signer package (CL-17): signer-keytool init | rotate | verify  (run by the operator as user signer; no network)
```

- **Logic:**
  1. Key file at `/var/lib/signer/hot.key.enc`, owner `signer`, mode 0400. Contents: a 32-byte Ed25519 seed encrypted with an authenticated cipher under a key derived from the operator passphrase with a memory-hard KDF. **VERIFY (A-18)** which memory-hard KDF and AEAD are available in Node's built-in `crypto` on the chosen LTS (for example `scrypt` and an AES-GCM or ChaCha20-Poly1305 cipher) and choose parameters that take ≥ 250 ms on the host; record them in the file header. The plain Solana CLI keypair JSON is never stored on the server [TH-42].
  2. Signing: **VERIFY (A-18)** Ed25519 signing from a raw 32-byte seed through a `KeyObject` with Node built-in `crypto` (for example by wrapping the seed in the PKCS#8 DER prefix for Ed25519 or importing it as a JWK). Golden test: sign known messages with a test seed and compare to `@solana/kit` output in the test workspace.
  3. `unlock(passphrase, 'unlocked')` from `operator_cli` only: derive, decrypt, check that the derived public key equals `KeyFile.publicKey` **and** the configured `hot_wallet_pubkey` (else `E_KEY_MISMATCH`, stay locked). The passphrase string reference is dropped immediately; buffers holding the derived key and seed copies are zero-filled after the `KeyObject` is created (best effort in JavaScript; documented limitation). Failed attempts: 5 per 15 min, then `E_RATE_LIMITED` (protects against a script on a compromised operator account).
  4. `lock()`: drop the `KeyObject` reference; state `locked`; every `sign` request → `E_LOCKED`.
  5. `exits_only`: the key is loaded but only transactions classified `exit` or `janitor` are signed until a normal `unlock` (ARCH M17 lock states).
  6. D26 (ii) (config `auto_unlock_exits_only`, default `false`): at boot, a systemd unit provides a host-bound credential containing the passphrase (**VERIFY (A-39)** systemd encrypted credentials on the host's systemd version and whether the droplet offers a TPM; without a TPM the credential is only as safe as root and the provider's disk access, ARCH D26) and the signer calls `unlock(…, 'exits_only')`. Not used in live-small by default; required (or KMS, D11) before `live` (gate LS-7).
  7. Rotation (`signer-keytool rotate`): generate a new seed with `crypto.randomBytes(32)`, encrypt, write atomically, print the new public key; the operator then updates `hot_wallet_pubkey` in `/etc/signer/policy.json` and the engine config and moves funds (ARCH 12.2 rotation procedure). The tool never prints the seed.
- **Shared resources and concurrency:** The key exists only in signer memory; no other process can read it (file mode, separate user).
- **Config:** `/etc/signer/policy.json`: `hot_wallet_pubkey` (required), `auto_unlock_exits_only` (bool, false), `kdf_min_ms` (250).
- **Edge cases and failure handling:** Key file missing or unreadable → `locked` forever with status `key_unavailable`; the sentinel notifies (D27). Host swap enabled → the signer refuses to unlock and logs `signer.swap_enabled` (swap stays disabled for the signer's sake, ARCH 4.3; **VERIFY** the check method, for example reading `/proc/swaps`).
- **Acceptance criteria:**
  1. Given the wrong passphrase 5 times, then the 6th attempt within 15 min returns `E_RATE_LIMITED` without running the KDF.
  2. Given `exits_only`, when a buy is requested, then `E_EXITS_ONLY`; when an exit is requested, it is signed.
  3. Given a key file whose public key differs from `hot_wallet_pubkey`, then unlock fails with `E_KEY_MISMATCH`.
  4. Given D26 (ii) enabled, after a host reboot an exit is signed within 60 s of boot (checklist item 3b).
- **Tests:** unit (file format, KDF parameters, state machine); golden signatures; integration (reboot drill in a VM); security: memory dump of the engine process contains no key material (the engine never had it).
- **Observability:** status fields `lock`; log codes `signer.unlocked`, `signer.locked`, `signer.unlock_failed` (no passphrase, no length); the sentinel raises "signer locked with live positions" (B-M29-03).
- **Security notes:** Passphrase only over `ops.sock` from `operator_cli`; never logged or echoed (`botctl unlock` disables terminal echo, B-M29-04). Key backup: ciphertext and passphrase stored offline by the operator (checklist item 5).
- **Facts used:** TH-42, TH-43, TH-45 (alternatives in D11), TH-37. VERIFY: A-18, A-39.
- **Definition of done:** Common DoD; key-restore test on a spare machine with zero funds documented (checklist item 5).

#### B-M17-03 — Durable signer state with `fsync`, start-latched on corruption

- **Module:** M17 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Persist the latch and its setter, the signer mode, the day counters, the outstanding signed messages, the exit leases, the last sweeps and the signing log **before** any signature is returned, so that a restart can never reset a limit or forget a signature (CA-07).
- **Depends on:** B-M17-01.
- **Interfaces:**

```ts
interface SignerState {
  seq: bigint; latch: { state: 'clear' | 'set'; setBy: Requester | 'system' | null; reason: string | null; atMs: UnixMs | null };
  mode: 'paper' | 'live_small' | 'live';
  day: { utcDay: string /* YYYY-MM-DD */; buySolOutLamports: Lamports; buyCount: number };
  outstanding: Array<{ requestId: Id; intentId: Id; mint: Pubkey; kind: TxClass['kind']; signature: Signature; messageSha256: string;
                       lastValidBlockHeight: BlockHeight; signedAtMs: UnixMs; terminal: 'no' | 'landed' | 'failed' | 'expired' }>;
  leases: Array<{ scope: 'all' | Pubkey; holder: Requester; atMs: UnixMs }>;
  lastSweeps: Array<{ lamports: Lamports; signature: Signature; atMs: UnixMs }>;   // newest 20
  buyMints: Pubkey[];                                                               // every mint ever signed in a buy (CL-11)
  checksum: string;                                                                 // sha256 of the canonical JSON without this field
}
interface Durable {
  load(): { state: SignerState; recovered: boolean };          // recovered = false when the file was unreadable or failed its checksum
  commit(next: SignerState, logRecord: SigningLogRecord): Result<true, { code: 'E_FSYNC' }>;
}
type SigningLogRecord = { seq: bigint; requestId: Id; intentId: Id; requester: Requester; classification: TxClass | null; messageSha256: string;
  signature: Signature | null; decided: 'signed' | SignerError; atMs: UnixMs };     // one JSON line per decision, no secrets
```

- **Logic:**
  1. Files under `/var/lib/signer/` (owner `signer`, mode 0700 directory): `state.json` and `signing-log.ndjson`.
  2. `commit`: append the log line and `fsync` the log file; write `state.json.tmp`, `fsync` it, `rename` over `state.json`, `fsync` the directory. Only after all succeed is the signature returned to the requester (ARCH M17 persistence). Refusals are logged too (so the audit import shows them).
  3. `load` at start: parse and verify `checksum`. On any failure: start with `latch = set` (`setBy = 'system'`, clearable only from `ops.sock` by `operator_cli`), day counters at their caps for the current UTC day (`buySolOutLamports = day_cap_lamports`, `buyCount = day_cap_count`), leases empty, outstanding reconstructed from the signing log if it parses (each line independently; a corrupt line is skipped and counted), and status `persistence: 'degraded'` until the next successful commit. Alert reaches the operator through the engine (status poll) and the sentinel.
  4. Day rollover at 00:00 UTC by the signer's wall clock: counters reset, `utcDay` updated, committed.
  5. `fsync` failure (`E_FSYNC`): buys and sweeps are refused (`E_HALTED`, message `persistence`); exits and janitor transactions are still signed (they reduce risk), the log record is kept in memory and appended as soon as the file is writable; `persistence: 'degraded'`; a failed `fsync` is never ignored silently (ARCH M17).
  6. Pruning: an `outstanding` entry is removed once marked terminal and older than 24 h; the signing log is rotated daily and kept 90 days (the engine imports it into the audit log, ARCH 7.2 "imported signer logs").
- **Shared resources and concurrency:** Single writer (the signer loop). No other process writes these files.
- **Config:** `day_cap_lamports` (1,000,000,000; must be ≤ the `MAXEXP` ceiling; ARCH 8.1 `SIGNERDAY`), `day_cap_count` (40), `log_retention_days` (90).
- **Edge cases and failure handling:** Disk full → `E_FSYNC` path; clock jumps backwards across midnight → counters are not reset twice (reset only when `utcDay` strictly increases).
- **Acceptance criteria:**
  1. Given a signer killed with SIGKILL immediately after returning a signature, when restarted, then that signature is in `outstanding` and the day counters include it.
  2. Given a corrupted `state.json`, when the signer starts, then the latch is set by `system`, `buyCount` = 40 and `buySolOutLamports` = 1,000,000,000 for today, buys are refused and exits are signed (ARCH 16.5 "Signer state file corrupted").
  3. Given the state directory made read-only, when an exit is requested, then it is signed and status shows `persistence: 'degraded'`; when a buy is requested, then `E_HALTED`.
- **Tests:** unit (atomic write sequence with an injected file-system fake that fails at each step); crash tests (kill at each step, 1,000 iterations, assert invariants); property (counters never decrease within a UTC day across restarts).
- **Observability:** status `persistence`; log codes `signer.state_recovered`, `signer.fsync_failed`, `signer.day_rollover`.
- **Security notes:** The log contains public data only (signatures, hashes, amounts, mints). No key material is ever written outside the key file.
- **Facts used:** none external (design rules CA-07).
- **Definition of done:** Common DoD; crash test results attached to the PR.

#### B-M17-04 — Message parser, lookup-table resolution and instruction decoders

- **Module:** M17 · **Size:** L (~2.5 engineer-days) · **Phase:** 3 (Raydium additions in 3b)
- **Goal:** Parse every message the signer is asked to sign, resolve address lookup tables itself from its own RPC endpoints at `confirmed`, and decode instructions of the allowlisted programs, without trusting any engine-supplied data.
- **Depends on:** B-M17-01. Group A: A-M02-01 (`@bot/decoders` zero-dependency core: base58, readers, pinned IDL JSON files and their hashes; C-02) and A-M02-06 (instruction decoding contract for the signer, C-03). The signer embeds a generated discriminator table (CL-18) and imports only A-M02-01's dependency-free core; it must not carry its own second base58 implementation (integration: one reviewed implementation).
- **Interfaces:**

```ts
interface ParsedTx { version: 0; feePayer: Pubkey; numRequiredSignatures: number; recentBlockhash: string;
  keys: Array<{ pubkey: Pubkey; isSigner: boolean; isWritable: boolean; source: 'static' | 'lookup' }>;
  instructions: Array<{ programId: Pubkey; accountIdx: number[]; data: Uint8Array; decoded: DecodedIx | null }> }
type DecodedIx =
  | { program: 'compute_budget'; name: 'set_cu_limit' | 'set_cu_price'; value: bigint }
  | { program: 'system'; name: 'transfer'; from: Pubkey; to: Pubkey; lamports: Lamports }
  | { program: 'spl_token' | 'token_2022'; name: 'sync_native' | 'close_account' | 'burn' | 'approve' | 'set_authority' | 'transfer' | 'other'; accounts: Pubkey[]; amount: bigint | null }
  | { program: 'ata'; name: 'create' | 'create_idempotent'; payer: Pubkey; ata: Pubkey; owner: Pubkey; mint: Pubkey; tokenProgram: Pubkey }
  | { program: 'pumpswap'; name: 'buy' | 'buy_exact_quote_in' | 'sell'; args: Record<string, bigint | boolean>; accounts: Record<string, Pubkey> }
  | { program: 'pump_curve'; name: 'buy_v2' | 'buy_exact_quote_in_v2' | 'sell_v2'; args: Record<string, bigint | boolean>; accounts: Record<string, Pubkey> };
interface SignerParser {
  parse(messageBytes: Uint8Array): Promise<Result<ParsedTx, { code: 'E_ALT_UNRESOLVED' | 'E_POLICY_UNCLASSIFIABLE'; message: string }>>;
  isDecodable(tx: ParsedTx): boolean;      // every instruction's program is in the decodable set and every instruction decoded
}
```

- **Logic:**
  1. Wire format: parse the versioned message (version prefix, header, static keys, recent blockhash, compiled instructions, lookup table references). **VERIFY** the exact v0 wire format against the Solana versioned-transactions documentation [LD-06]; golden-test the parser against `@solana/kit` decoding of 200 fixture messages in the test workspace (kit is not a signer runtime dependency). Legacy and v1 messages → `E_POLICY_UNCLASSIFIABLE` (the engine builds v0 only, D10).
  2. Base58: the internal, reviewed implementation from A-M02-01 (no dependency) golden-tested against kit (integration: shared, not re-implemented here). The `typosquat` incidents involving base58 packages [TH-38] are a reason not to add one.
  3. Lookup tables: for each table key, fetch the account at `confirmed` from the signer's own read endpoints (Node `fetch`, HTTPS only), decode the table (**VERIFY** the address-lookup-table account layout against the Solana docs), map indexes; any failure, out-of-range index or a table owned by a program other than the lookup-table program → `E_ALT_UNRESOLVED`. The engine's `lookupTablesB64` is ignored (ARCH M17).
  4. Decoders: Compute Budget discriminators 2 and 3 [LD-03] (others are kept raw, which makes the transaction non-decodable); System transfer; SPL Token and Token-2022 instructions needed by policy (sync native, close, burn, approve, set authority, transfer variants; **VERIFY** their discriminators against the token program sources, which are public [TH-03]); ATA create and create-idempotent (**VERIFY**, A-31); PumpSwap and pump-curve instructions from the pinned IDLs (EX-10 account counts asserted).
  5. The discriminator and account-name tables for PumpSwap and the curve are generated at build time from the pinned IDL files (the same commit M02 pins) into a JSON data file inside the signer package; at start the signer recomputes its hash and compares it with `idl_table_sha256` in its policy file; mismatch → stays `locked`-equivalent for decodable routes (refuses with `E_POLICY_UNCLASSIFIABLE`) and logs `signer.idl_mismatch`.
- **Shared resources and concurrency:** Read-only RPC; ALT reads are cached per (table key, context slot) for at most 10 s (tables can be extended, never safely assumed static).
- **Config:** `/etc/signer/policy.json`: `read_endpoints` (≥ 2 labels with HTTPS URLs; keys loaded from `/etc/signer/secrets` via systemd credentials, never logged), `idl_table_sha256`, `alt_cache_ms` (10,000).
- **Edge cases and failure handling:** A lookup-table entry that resolves to a signer-sensitive account (hot wallet, a tip account) is treated exactly like a static key (policy is applied to the resolved transaction). A message with more than one required signature → `E_POLICY_UNCLASSIFIABLE` (our transactions need only the hot wallet).
- **Acceptance criteria:**
  1. Given the 200 fixture messages, then the parser's resolved keys and instruction data equal kit's for every one.
  2. Given a Jupiter route whose lookup table hides an unallowlisted program (ARCH 16.6), then after resolution the program is visible to policy and the request is refused.
  3. Given an ALT read failing on both endpoints, then `E_ALT_UNRESOLVED`.
- **Tests:** unit and golden (`FX-SIGNER-MSG-*`), property (round trip of random compiled messages), integration with recorded ALT accounts (`FX-ALT-JUP-*`), fuzzing (random bytes never crash the process; they return `E_POLICY_UNCLASSIFIABLE`).
- **Observability:** log codes `signer.alt_unresolved`, `signer.parse_failed`, `signer.idl_mismatch`.
- **Security notes:** Parsing is the signer's attack surface: bounded loops, length checks before every read, no recursion on attacker-controlled depth.
- **Facts used:** LD-03, LD-06, EX-10, TH-03, TH-38, DA-11. VERIFY: v0 wire format; ALT layout; token-program discriminators; A-31.
- **Definition of done:** Common DoD; fuzzing ran for ≥ 1 h in CI without a crash.

#### B-M17-05 — Transaction classification (decoded arguments or the signer's own simulation)

- **Module:** M17 · **Size:** L (~2.5 engineer-days) · **Phase:** 3
- **Goal:** Derive `TxClass` (`buy`, `exit`, `sweep`, `janitor`) independently of the engine: from decoded instructions and arguments for decodable transactions, and from the signer's own `simulateTransaction` on at least two independent read endpoints for non-decodable ones (Jupiter routes) (CA-05, CA-06).
- **Depends on:** B-M17-04.
- **Interfaces:**

```ts
interface Classifier {
  classify(tx: ParsedTx): Promise<Result<{ cls: TxClass; method: 'decoded' | 'simulated'; solOutUpperLamports: Lamports; rentDepositsLamports: Lamports;
                                           feeLamports: Lamports; tipLamports: Lamports },
                                         { code: 'E_POLICY_UNCLASSIFIABLE' | 'E_SIM_UNAVAILABLE' | 'E_SIM_FAILED'; message: string }>>;
}
```

- **Logic:**
  1. Fee components from decoded compute-budget instructions: `feeLamports = 5,000 × numRequiredSignatures + ceil(cuPrice × cuLimit / 1,000,000)` [LD-01, LD-02]. Tips = System transfers to configured tip accounts.
  2. **Decodable buy** (exactly one PumpSwap `buy`/`buy_exact_quote_in` or curve buy instruction, no sell): `mint` = the instruction's base mint account; maximum quote input = decoded `max_quote_amount_in` or spendable-quote argument (names from the pinned IDL); `minTokenOutBase` = decoded minimum base out (must be > 0, else `E_POLICY_UNCLASSIFIABLE`); `rentDepositsLamports` = for each `create`/`create_idempotent` whose target account does not exist at `confirmed` (signer reads it) **and is not closed later in the same transaction** (the temporary wSOL account's rent is refunded in the same transaction and nets to zero), the rent for that account's size, bounded above by `max_ata_rent_lamports` (Token-2022 accounts with extensions are larger [LD-V03]); `solOutUpperLamports = maxQuoteIn + feeLamports + tipLamports + rentDepositsLamports` (+ curve fee on top when the curve adds it [EX-05]). `TxClass.solOutLamports = solOutUpperLamports` (CL-19: the stricter, all-in reading of "SOL out").
  3. **Decodable exit** (exactly one PumpSwap `sell` or curve `sell_v2`, no buy): `mint`, `sellBase` = decoded base amount in, `minSolOutLamports` = decoded minimum quote out, `feeAndTipLamports = feeLamports + tipLamports`.
  4. **Sweep:** exactly one System transfer from the hot wallet to the configured cold address, plus compute budget and tips; nothing else.
  5. **Janitor:** only `close_account` (and `burn` followed by `close_account` on the same account), compute budget and tips; `closes` and `burns` list the accounts.
  6. Anything else that decodes fully (for example a buy and a sell in one transaction, or two swaps) → `E_POLICY_UNCLASSIFIABLE`.
  7. **Non-decodable** (Jupiter `/build` buys in research/paper only, rung-4 `/order` exits): call `simulateTransaction` (unsigned, `sigVerify: false`, no blockhash replacement, `accounts` = the hot wallet, its wSOL ATA and every hot-wallet token account touched; [TH-46]) on both configured read endpoints in parallel, plus a pre-state read of the same accounts from each endpoint. Deltas: lamports of the hot wallet + its wSOL balance; token balances per mint. Rules (ARCH M17): buy = total SOL + wSOL decrease exceeds fees + tips + rent deposits **and** exactly one token balance increases; exit = exactly one mint decreases, no other token decreases, and SOL + wSOL do not decrease by more than fees + tips + rent deposits. Otherwise `E_POLICY_UNCLASSIFIABLE`. Simulation error → `E_SIM_FAILED`.
  8. Two-endpoint rule (CL-20, the stricter reading of "the first to answer is used; any disagreement refuses"): **buys** need both endpoints to answer within `sim_timeout_ms` and agree within `sim_tolerance_lamports` (fees) on every delta; **exits** use the first answer, and if the second answers within the window and disagrees, refuse. Both endpoints failing → `E_SIM_UNAVAILABLE` (only non-decodable transactions are affected; decodable buys and exits proceed without simulation, ARCH M17 failure modes).
  9. Hint check: if the engine's `hint` differs from the derived class, the response carries `hintMismatch: true` and the request is refused: the code is that of the first failing class rule if any (so "a buy labelled exit while halted" returns `E_HALTED`, ARCH 16.5), otherwise `E_POLICY_UNCLASSIFIABLE`; the engine raises a `security` critical alert on any `hintMismatch` (ARCH M17).
- **Shared resources and concurrency:** Read-only RPC on the signer's own endpoints. Runs inside the single request loop (the loop awaits the simulation; other requests wait; halts are still processed next, B-M17-01 step 6).
- **Config:** `max_ata_rent_lamports` (default 3,000,000; must be ≥ the rent of a 170-byte account [LD-14]); `sim_timeout_ms` (800); `sim_tolerance_lamports` (10,000); `cold_wallet_pubkey`; `tip_accounts` (Sender and Jito lists, identical to B-M16-01 config).
- **Edge cases and failure handling:** Hot wallet's wSOL ATA pre-exists with a balance (crash residue) → its closing in the same transaction appears as a SOL increase, never as a buy; the rules use SOL + wSOL totals so it nets out (CA-16). A route returning a different output mint (ARCH 16.6) → two token balances change → `E_POLICY_UNCLASSIFIABLE`.
- **Acceptance criteria:**
  1. Given a decodable PumpSwap buy with `max_quote_amount_in` 66,666,667, tip 5,000, CU 200,000 at 25,000 µlamports, and a new ATA (rent 1,513,840), then `solOutLamports` = 66,666,667 + 5,000 + 5,000 + 5,000 + 1,513,840 = 68,195,507.
  2. Given a transaction containing both a buy and a sell, then `E_POLICY_UNCLASSIFIABLE`.
  3. Given a non-decodable buy where endpoint A reports a token increase and endpoint B times out, then `E_SIM_UNAVAILABLE`; for the same situation on an exit, it is classified from A.
  4. Given hint `exit` on a decodable buy while the latch is set, then the response is `E_HALTED` with `hintMismatch: true`.
- **Tests:** unit (rule matrix); integration with recorded simulation responses (`FX-SIGNER-SIM-*`); security fuzzing (ARCH 16.6 list).
- **Observability:** status counters `classified_total{method,kind}`, `hint_mismatch_total`; log code `signer.hint_mismatch`.
- **Security notes:** The engine's numbers are never used for policy; only decoded arguments, the signer's own reads and its own simulations.
- **Facts used:** LD-01, LD-02, LD-03, LD-14, LD-V03, TH-46, EX-05, EX-10, EX-25. VERIFY: simulation `accounts` option semantics and response fields against the Solana RPC docs (TH-46 confirms the option exists).
- **Definition of done:** Common DoD; every ARCH 16.6 signer case has a named test.

#### B-M17-06 — Signing policy: common rules, buy rules, exit rules and the rung-4 exception

- **Module:** M17 · **Size:** L (~2.5 engineer-days) · **Phase:** 3
- **Goal:** Enforce, inside the signer and independently of the engine, every rule of ARCH M17 "Policy for every transaction", "Buy rules", "Exit rules" and "Rung-4 exception", keyed on the signer's own classification.
- **Depends on:** B-M17-03, B-M17-05.
- **Interfaces:**

```ts
interface PolicyInput { req: SignRequest; requester: Requester; tx: ParsedTx; cls: TxClass; method: 'decoded' | 'simulated';
  solOutUpperLamports: Lamports; feeLamports: Lamports; tipLamports: Lamports; rentDepositsLamports: Lamports }
interface Policy { evaluate(p: PolicyInput): Promise<Result<true, { code: SignerError; message: string }>> }
interface SignerCaps {          // from /etc/signer/policy.json, each ≤ the matching value in the signer's copy of /etc/bot/ceilings.json
  perTxBuyCapLamports: Lamports;         // MAXPOS ceiling 350,000,000 (ARCH 8.1)
  dayCapLamports: Lamports; dayCapCount: number;          // 1,000,000,000 and 40 (SIGNERDAY)
  hotcapLamports: { live_small: Lamports; live: Lamports }; // 500,000,000 and ≤ 1,000,000,000 (HOTCAP, CL-21)
  tipCapLamports: Lamports;              // 10,000 per tip (ARCH 8.3)
  exitFeeCapLamports: Lamports;          // 5,000 + 600,000 + 2 × 10,000 = 625,000 (CL-12)
  rung4TotalCapLamports: Lamports;       // 2,000,000 (ARCH 8.3)
}
```

- **Logic (rules are evaluated in this order; the first failure is returned):**
  1. **Lock:** `locked` → `E_LOCKED`; `exits_only` and class ∉ {exit, janitor} → `E_EXITS_ONLY`.
  2. **Common rules (every class):** fee payer = `hot_wallet_pubkey` (`E_POLICY_UNCLASSIFIABLE`); every program in the allowlist {Compute Budget, System, SPL Token, Token-2022, ATA program, PumpSwap, pump curve, plus Raydium AMM v4/CPMM and the Jupiter router program only when their config flags are on} (`E_POLICY_PROGRAM`), except under the rung-4 exception (step 6); no `approve`, `set_authority` or other delegate instruction from SPL Token or Token-2022 [TH-03] (`E_POLICY_AUTHORITY`); every top-level System transfer goes to a configured tip account (each ≤ `tipCapLamports`), the hot wallet's own wSOL ATA (wrap), a hot-wallet-owned ATA, or the cold address in a sweep (`E_POLICY_TRANSFER`); `sync_native` only on the hot wallet's own wSOL ATA (`E_POLICY_TRANSFER`); `close_account`: authority (owner) and destination both = hot wallet, target = the hot wallet's wSOL ATA or one of its token ATAs, and a token-ATA close only in a `janitor` transaction (`E_POLICY_CLOSE`); ATA creation only with owner = hot wallet (`E_POLICY_AUTHORITY`); no top-level token transfer out of any hot-wallet account (`E_POLICY_TRANSFER`); `burn` only in a `janitor` transaction, only for a mint that is **not** in `buyMints` (the signer has never signed a buy for it; CL-11) (`E_POLICY_CLOSE`); wrap transfer ≤ the decoded maximum quote input (+ curve fee on top) (`E_POLICY_TRANSFER`).
  3. **Buy rules** (class `buy` only): latch set → `E_HALTED`; signer `mode` = `paper` → `E_MODE`; hot balance (SOL + its wSOL ATA, read by the signer at `confirmed` from its own endpoint immediately before signing) > `hotcap[mode]` × 110% → `E_HOTCAP`; `solOutLamports` > `perTxBuyCapLamports` + `rentDepositsLamports` + `feeLamports` + `tipLamports` (the cap applies to the swap input; rent, fees and tips are bounded separately, CL-19) or decoded maximum quote input > `perTxBuyCapLamports` → `E_CAP_TX`; day counter + `solOutLamports` > `dayCapLamports` or `buyCount + 1 > dayCapCount` → `E_CAP_DAY`; duplicate proof (B-M17-07) → `E_PROOF_REQUIRED`; for simulated buys, the output mint must increase by ≥ `minTokenOutBase` (`E_POLICY_UNCLASSIFIABLE`). Counters are incremented **at signing** for every distinct signed buy message (a signed transaction may still land), in the same commit as the signature (B-M17-03).
  4. **Exit rules** (class `exit` only; the halt latch, `HOTCAP`, mode and day caps never block an exit, CA-05): the requester must hold the lease for the mint or `all` (`E_LEASE`); `sellBase` ≤ the ATA balance read by the signer at `confirmed` (`E_BALANCE`); `feeAndTipLamports` ≤ `exitFeeCapLamports` (`E_CAP_TX`); at most 2 unexpired signed exit messages for the mint including this one (`E_DUPLICATE`, B-M17-07).
  5. **Sweep:** destination = the configured cold address only; amount ≤ hot balance − `sweep_min_leave_lamports` (the signer's own floor, CL-22) (`E_POLICY_TRANSFER`). Sweeps are allowed while the latch is set, because moving SOL to cold reduces exposure (ARCH 12.6 lists the sweep as a kill-switch path); they are refused with `E_HALTED` only while `persistence` is degraded (B-M17-03). Record in `lastSweeps`.
  6. **Rung-4 exception** (non-decodable transaction that the simulation classifies as `exit`): programs outside the allowlist are accepted only if the classification is `exit` by simulation, the position mint decreases by ≤ the on-chain balance, and the fee-like outflow ≤ `rung4TotalCapLamports` (2,000,000), where fee-like outflow = simulated network fee + every lamport increase of a System-owned account other than the hot wallet + every wSOL increase of a token account not owned by the hot wallet (conservative: anything that could be a fee or tip counts; CL-13). Otherwise `E_POLICY_PROGRAM` / `E_CAP_TX`.
  7. On success: sign, `commit` (B-M17-03), return. On refusal: `commit` the refusal log line, return the code.
- **Shared resources and concurrency:** Latch, counters, leases, outstanding messages (all signer-owned, ARCH 7.2), within the single loop.
- **Config:** as in `SignerCaps`, plus `program_allowlist` (Pubkey list; any change requires a signer restart and a code review), `sweep_min_leave_lamports` (default 10,000,000 = the 0.01 SOL buffer of ARCH 12.2; the engine leaves more).
- **Edge cases and failure handling:**
  1. Exit while the hot balance is above `HOTCAP` + 10% → signed (ARCH 16.5).
  2. Exit after auto-demotion to paper (`mode = paper`, `keep_managing`) → signed (ARCH 16.5).
  3. Exit with both simulation endpoints down on a decodable route → signed; a non-decodable exit → `E_SIM_UNAVAILABLE` (ARCH 16.5).
  4. `FEEDAY` is not a signer rule (it is entries-only in M21); the signer never refuses an exit for daily fee spend.
- **Acceptance criteria:** each of the following returns the stated code: `CloseAccount` of the wSOL ATA to another destination → `E_POLICY_CLOSE`; token-ATA close inside a swap → `E_POLICY_CLOSE`; ATA creation with another owner → `E_POLICY_AUTHORITY`; `SyncNative` on a foreign account → `E_POLICY_TRANSFER`; a decoded `max_quote_amount_in` above the cap while the hint says exit → `E_CAP_TX` (with `hintMismatch`); rung-4 fee-like outflow 2,100,000 → `E_CAP_TX`; 41st buy of the day → `E_CAP_DAY`; buy while halted → `E_HALTED`.
- **Tests:** unit for every rule; table-driven security suite from ARCH 16.6; property tests (random instruction sets drawn from a grammar that includes Approve, SetAuthority, transfers to random addresses, unknown programs: always refused); integration with B-M16 outputs (every legitimate builder output is accepted in the matching state).
- **Observability:** refusal codes in the response (engine metric `signer_refusals_total{code}`), signer log `signer.refused` with code and classification.
- **Security notes:** This is the last software control before chain. Changes require two reviewers and a passing security suite. The ceilings copy is compared with `/etc/bot/ceilings.json` at start (identical content hash) and on mismatch the signer starts latched (`system`).
- **Facts used:** LD-01, LD-02, LD-17, LD-22, TH-03, EX-25, LD-V03. VERIFY: token-program instruction set (via B-M17-04).
- **Definition of done:** Common DoD; the ARCH 16.6 signer cases and the ARCH 16.5 signer rows are all green; two-reviewer approval recorded.

#### B-M17-07 — Duplicate rules, outstanding messages, `status_of` and the signer-side expiry check

- **Module:** M17 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Prevent double buys and unbounded concurrent exits: a new, different buy message for an intent is signed only after every earlier signature of that intent is proven terminal by the signer itself, in block height; exits allow at most 2 unexpired messages per mint; identical bytes return the same signature (CA-03).
- **Depends on:** B-M17-03, B-M17-04.
- **Interfaces:** `StatusOfRequest`/`StatusOfResponse` (above). Internal:

```ts
interface TerminalCheck {
  isTerminal(sig: Signature, lastValidBlockHeight: BlockHeight): Promise<'landed' | 'failed' | 'expired' | 'unknown'>;
  currentHeight(): Promise<Result<{ slot: Slot; blockHeight: BlockHeight; endpoint: string }, { code: 'E_RPC' }>>;
}
```

- **Logic:**
  1. Identical message (same SHA-256 of the message bytes) already signed → return the stored signature and signed bytes; no counter change (Ed25519 signatures are deterministic, and the stored record is authoritative).
  2. **Buy, different message for an intent with earlier signatures** (from the signer's own `outstanding` records for that `intentId`, union the engine's `priorAttempts`): for each earlier signature not already marked terminal, call `isTerminal`. `landed`/`failed` = `getSignatureStatuses` with `searchTransactionHistory: true` returns a status at `confirmed` or higher (**VERIFY** the parameter, A-35). `expired` = on **one** of the signer's endpoints, a single reading (slot `S_h`, block height `H`) with `H > lastValidBlockHeight + 10`, followed by a `getSignatureStatuses` call with `searchTransactionHistory: true` on the same endpoint whose response context slot ≥ `S_h` returning null (ARCH M17 duplicate rules; the window is in block height, never wall-clock time). If any is `unknown` → `E_PROOF_REQUIRED`. If any is `landed` → `E_DUPLICATE` (the intent already bought).
  3. **Exit:** count `outstanding` exit messages for the mint whose `lastValidBlockHeight` ≥ the signer's current block height (`currentHeight()` from its own endpoint) and not marked terminal; if the count is already 2 → `E_DUPLICATE`. If the height read fails, treat every non-terminal exit message as unexpired (stricter).
  4. Terminal marking: the signer updates `outstanding.terminal` whenever it learns a final status (from step 2, or from the engine's `status_of` follow-ups, which carry no authority, so the signer re-checks before marking).
  5. `status_of(intentId)` returns every signed message for the intent (ARCH 7.3 signer timeout and 7.6 step 4).
- **Shared resources and concurrency:** Outstanding-message records (signer-owned). Runs inside the single loop.
- **Config:** `expiry_margin_blocks` (10; 0-150).
- **Edge cases and failure handling:** Engine crash between signing and send → the engine's recovery asks `status_of`, adopts the signature and never asks for a different buy message (ARCH 7.6 step 4); if it did, step 2 applies. A third concurrent exit while two are unexpired → `E_DUPLICATE`; M19 waits for one to expire or fail (ARCH 7.3, ≤ 2 concurrent).
- **Acceptance criteria:**
  1. Given a buy intent whose first signature is in flight (status null, height below `lastValidBlockHeight` + 10), when a different buy message for the same intent is requested, then `E_PROOF_REQUIRED`.
  2. Given the same after `H > lastValidBlockHeight + 10` and a null status with context slot ≥ `S_h`, then the new message is signed.
  3. Given a null status whose context slot is below `S_h` (lagging node), then `E_PROOF_REQUIRED` (ARCH 16.5 "lagging provider").
  4. Given two unexpired exit messages for a mint, then a third → `E_DUPLICATE`.
- **Tests:** unit with a fake RPC (lagging context slot, cross-endpoint mixing attempts, history search off); integration with recorded status responses (`FX-RPC-SIGSTATUS-*`).
- **Observability:** status counters `proof_required_total`, `duplicate_total`; log codes `signer.proof_required`, `signer.duplicate`.
- **Security notes:** Never mixes a height from one endpoint with a status from another (same rule as M18).
- **Facts used:** LD-07, LD-09. VERIFY: A-35, `getEpochInfo` fields (A-36).
- **Definition of done:** Common DoD; ARCH 16.5 "Crash after signing, before send" and "Transaction lands after being presumed expired" pass with B-M18-04.

#### B-M17-08 — Halt latch, exit leases, signer mode, status, and the signer security suite

- **Module:** M17 · **Size:** M (~2 engineer-days) · **Phase:** 3
- **Goal:** Implement the latch (D28 default (a)), the per-mint exit lease (CA-13), the signer's own mode setting, the status request, and the full signer security test suite of ARCH 16.6.
- **Depends on:** B-M17-02, B-M17-06, B-M17-07.
- **Interfaces:** `LatchRequest`, `LeaseRequest`, `SetModeRequest`, `StatusRequest`, `SignerStatus` (above).
- **Logic:**
  1. `halt` from any requester: latch `set`, `setBy` = requester, reason stored (≤ 256 chars, control characters stripped), committed. Idempotent: a second halt updates nothing but the log.
  2. `resume`: if `setBy = engine`, the engine may clear it (dashboard RESUME, A2); if `setBy ∈ {sentinel, operator_cli, system}`, only `operator_cli` on `ops.sock` may clear it (`botctl resume-latch`, D28 (a)). Any other attempt → `E_FORBIDDEN` (B-M17-01). D28 (b) (WebAuthn relayed by the engine) is **not built** in v1; its switch trigger is "the operator needs to resume from a phone without SSH" and it would add credential storage and assertion verification here (**VERIFY** WebAuthn Level 3 assertion format before building it).
  3. Leases: one lease per mint or `all`. The engine `acquire('all')` at start (non-force). The sentinel or `operator_cli` may `acquire(scope, force: true)`; the signer then refuses exit requests from the previous holder for that scope (`E_LEASE`). `release` only from `operator_cli` on `ops.sock` (`botctl release-lease`); the automatic release after a full journal import that ARCH 7.6 step 5 permits is not built in v1 (the engine prompts the operator instead; CL-23). The lease never affects buys (buys are refused anyway while the latch is set, which the sentinel sets on takeover).
  4. `set_mode`: the engine may raise the signer mode only up to `max_mode` in the signer's root-owned policy file (default `paper`; the operator sets `live_small` at go-live and `live` only after the LS gates and LS-7), so the signer signs no buy at all until the operator has changed its own file; anyone may lower the mode. The mode only affects buys (`E_MODE`).
  5. `status` returns `SignerStatus` including `persistence`, `leases` and `lastSweeps` (the sentinel uses `lastSweeps` to exclude sweeps from its balance-drop rule, CA-17).
  6. Security suite (ARCH 16.6), run in CI against the real signer binary with fake RPC endpoints: random instruction sets (Approve, SetAuthority, transfers to arbitrary addresses, unknown programs, oversize SOL out); each specific case listed in ARCH 16.6; requests on `engine.sock` claiming another identity; ALT-hidden program; output-mint swap; rung-4 overspend; a buy mislabelled as an exit.
- **Shared resources and concurrency:** Latch and leases are signer-owned; all changes go through the single loop and are committed (B-M17-03).
- **Config:** `max_mode` (`paper` | `live_small` | `live`, default `paper`, root-owned policy file; changing it requires root and a signer restart).
- **Edge cases and failure handling:** Sentinel force-acquires while the engine has an exit in flight → that in-flight message stays valid on chain (the signer cannot recall it); the sentinel's own exits are limited by the ≤ 2-message rule and the balance check, so no double sell beyond the balance is possible (ARCH 16.5 "Engine down 130 s").
- **Acceptance criteria:**
  1. Given a latch set by `sentinel`, when `operator_cli` sends `resume`, then the latch clears and the log records the setter and clearer.
  2. Given the sentinel force-acquired `all`, when the engine requests an exit, then `E_LEASE`.
  3. Given `max_mode = live_small`, when the engine sends `set_mode live`, then refused (`E_FORBIDDEN`) and the mode is unchanged; given `max_mode = paper`, `set_mode live_small` is refused too.
  4. Given the full ARCH 16.6 signer list, then every case is refused with the expected code.
- **Tests:** unit; integration (three-process test with engine, sentinel and CLI users); the security suite above.
- **Observability:** status fields; log codes `signer.latch_set`, `signer.latch_cleared`, `signer.lease_forced`, `signer.lease_released`, `signer.mode_changed`.
- **Security notes:** The engine cannot clear a latch it did not set, because identity comes from the OS (CA-07). Every latch and lease change is in the signing log, which the engine imports into the hash-chained audit log (B-M24-03).
- **Facts used:** none external beyond B-M17-01..07.
- **Definition of done:** Common DoD; P-7 drill (HALT acknowledged by all components within 2 s; CLI kill with the engine stopped blocks signing) passes with B-M26-01 and B-M29-04.

---

### M18 Sender and confirmation tracker

Shared interface (exact copy of ARCH M18; `LandingPath` extended by CL-04):

```ts
type LandingPath = 'sender' | 'jito_tx' | 'rpc' | 'jupiter_execute';   // 'jupiter_execute' only for rung 4 (CL-04)
interface SendRequest { attemptId: Id; side: 'exit' | 'entry' | 'janitor' | 'sweep'; signedTx: Uint8Array; signature: Signature;
  lastValidBlockHeight: BlockHeight; paths: LandingPath[] /* 1-3 */ }
type AttemptStatus = 'sending' | 'sent' | 'landed_processed' | 'confirmed_success' | 'confirmed_failed' | 'expired' | 'unknown';
interface AttemptResult { attemptId: Id; status: AttemptStatus; signature: Signature; slot: Slot | null; err: string | null;
  failureClass: FailureClass | null; feeLamports: Lamports | null;
  balanceDeltas: { solLamports: SignedLamports; wsolLamports: SignedLamports; token: Array<{ mint: Pubkey; deltaBase: bigint }> } | null;
  events: DecodedEvent[]; firstSentMs: UnixMs; confirmedMs: UnixMs | null; slotsToConfirm: number | null;
  expiryProof: { providers: string[]; heightSeen: BlockHeight; statusContextSlot: Slot; balanceCheckSlot: Slot | null } | null }
interface Sender { send(r: SendRequest): void; onResult(h: (r: AttemptResult) => void): () => void;
  onNotLanded(h: (e: { attemptId: Id; slotsSinceFirstSend: number }) => void): () => void }
```

#### B-M18-01 — Send scheduler and rebroadcast policy

- **Module:** M18 · **Size:** M (~2 engineer-days) · **Phase:** 3
- **Goal:** One scheduler through which every first send and every rebroadcast of every attempt passes, using M14's shared per-path, per-region token buckets, with exits strictly before entries, a rebroadcast interval that never exceeds documented limits, and back-off (never drop) on 429 (CA-11, CB-01).
- **Depends on:** B-M19-01, B-M15-01. Group A: M14 `RpcGateway.acquireSend(path, region, { side, kind })` (including a bucket for `jupiter_execute`, CL-04).
- **Interfaces:**

```ts
interface InFlight { attemptId: Id; side: SendRequest['side']; signature: Signature; signedTx: Uint8Array; lastValidBlockHeight: BlockHeight;
  paths: LandingPath[]; firstSentMs: UnixMs | null; firstSentSlot: Slot | null; lastSentMs: Record<LandingPath, UnixMs | null>; sends: number; done: boolean }
interface SendScheduler { enqueue(r: SendRequest): void; stop(attemptId: Id): void; inFlight(): ReadonlyArray<InFlight> }
interface PathClient { send(path: LandingPath, signedTx: Uint8Array): Promise<Result<{ acceptedAtMs: UnixMs }, { code: 'E_RATE_LIMITED' | 'E_HTTP' | 'E_REJECTED'; retryAfterMs?: number; message: string }>> }  // B-M18-02
```

- **Logic:**
  1. Priority order of work items: exit first sends > exit rebroadcasts > entry first sends > entry rebroadcasts > janitor and sweep (ARCH M18). Within a class, FIFO by enqueue time.
  2. For each work item, `acquireSend(path, region, …)`; if `granted = false`, re-queue with `retryAtMs`. A grant is consumed per HTTP request.
  3. Rebroadcast interval per (path, signature) = `max(1,000 ms, 2 × slotDurationMsEstimate, attemptsInFlightOnPath / pathRate)` (ARCH M18), where `pathRate` is the bucket's configured rate (M14). The same signed bytes are resent (same signature, idempotent) [LD-07].
  4. 429 → M14 empties the bucket until `Retry-After` (or 1 s) and doubles back-off on repeats; the scheduler re-queues the item; the path is never removed from the attempt (ARCH M14, M18).
  5. Paths: `sender` (keyed HTTPS global endpoint), `rpc` (`sendTransaction` on a second provider with `maxRetries: 0` [LD-07] and `skipPreflight: true` (CL-24)), `jito_tx` (rung ≥ 2 and only when the transaction carries a Jito tip), `jupiter_execute` (rung 4 only; **never rebroadcast**: Jupiter lands it [EX-25], and auto-retrying services must not be client-rebroadcast, ARCH M18).
  6. A send stops when B-M18-03 reports a final status or B-M18-04 proves expiry (`stop(attemptId)`).
  7. `onNotLanded`: when an exit attempt has no `processed` evidence `exit_supersede_slots` (8) slots after its first send (slot = M15 `highestSeenSlot` at send vs now), emit once (drives supersession in B-M19-05).
  8. Capacity (DERIVED, ARCH M18): 3 exits + 1 entry in flight at 200 ms slots = 4 attempts × 1 req/s per path against the keyed Sender bucket of 25 req/s (≤ 50% of documented, owner rule); the keyless fallback (0.5 req/s) gives each attempt one send every 8 s, which is why keyed Sender is the default.
- **Shared resources and concurrency:** Send capacity per path and region (owner M14 buckets, M18 scheduler; ARCH 7.2). The scheduler's queue is owned here; single event loop.
- **Config:** `m18.region` (default `fra`, D07; used only for bucket keys, never to pick plain-HTTP regional URLs); `m18.exit_supersede_slots` (8; 2-40; `affectsReturns: true`); `m18.min_rebroadcast_ms` (1,000; ≥ 1,000).
- **Edge cases and failure handling:** All paths refusing → keep rebroadcasting within buckets until expiry is proven (ARCH M18). Process restart → in-flight attempts are re-enqueued from `tx_attempt` rows with stored signed bytes (signed bytes are persisted by M19 before the first send, B-M19-06).
- **Acceptance criteria:**
  1. Given 3 exits and 1 entry enqueued at once with a bucket of 1 token per 25 ms, then the 3 exit first sends precede the entry's first send (ARCH 16.5 "Flatten of 3 positions plus 1 entry").
  2. Given repeated 429s on Sender, then the measured request rate never exceeds the bucket rate and Sender is still attempted after back-off.
  3. Given a rung-4 attempt, then exactly one `/execute` request is made.
- **Tests:** unit with a fake clock and fake buckets; property (random arrival orders: rate never exceeds any bucket; exits never wait behind entries); failure injection: 429 storm, path timeouts.
- **Observability:** metrics `send_bucket_wait_ms` (path), `send_429_total` (path), `attempts_total` (side, path, status), `exit_supersede_total`; log codes `m18.backoff`, `m18.not_landed`.
- **Security notes:** HTTPS only (B-M18-02); signed bytes are public data once sent; no keys in logs.
- **Facts used:** LD-07, LD-09, LD-17, LD-18, LD-22, LD-V06, EX-25, EX-29. 
- **Definition of done:** Common DoD; capacity test from ARCH 16.5 passes.

#### B-M18-02 — Landing path clients: keyed Sender (HTTPS), Jito `sendTransaction`, RPC `sendTransaction`

- **Module:** M18 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Implement `PathClient.send` for the three standard landing paths as plain JSON-RPC over HTTPS with Node's built-in `fetch` through M14 (no Jito or Helius SDK; ARCH 4.4), HTTPS only (CA-30).
- **Depends on:** B-M18-01. Group A: M14 `RpcGateway.http('helius_sender' | 'jito', …)` and `RpcGateway.call('sendTransaction', …, { role: 'send', provider })`.
- **Interfaces:** `PathClient` (B-M18-01).
- **Logic:**
  1. **Sender** (D02 default): JSON-RPC `sendTransaction` to the HTTPS global Sender endpoint with the Helius Free key and `mev-protect=true` [LD-22]. **VERIFY (A-40)** where the key and the `mev-protect` flag go (URL query or header) and the exact request parameters (encoding, any `skipPreflight` requirement) against the Helius Sender docs. Plain-HTTP regional endpoints are never used [LD-V06]; M14's config validation rejects any non-`https:` URL (CA-30). Every transaction sent through Sender carries a Sender tip ≥ 5,000 lamports and a `SetComputeUnitPrice` instruction (else Sender rejects it [LD-22]); the client asserts both by inspecting the message before sending (cheap check; prevents wasting a request).
  1b. **SWQOS-only mode (integration).** The Lean cost scenario (ARCH 2.2) assumes Sender's SWQOS-only mode with its 5,000-lamport minimum tip [LD-22]. How a request selects SWQOS-only mode (a query parameter, header or endpoint) is not in the fact register: **VERIFY (A-40)** against the Helius Sender docs before coding. Until verified, the Sender tip is the configured `m16` minimum and any rejection for an insufficient tip is `E_REJECTED` + critical alert (never silently raised).
  2. **Jito** (`jito_tx`, rung ≥ 2, or rung 1 for exits after the D09 switch): JSON-RPC `sendTransaction` to the Jito block engine (global endpoint `https://mainnet.block-engine.jito.wtf` or a regional `*.mainnet.block-engine.jito.wtf` HTTPS endpoint [LD-18]); always skip-preflight [LD-17]; 1 request per second per IP per region, 429 when exceeded [LD-18]. **VERIFY** the request path and body against the Jito low-latency-send docs. Tip is in the same transaction as the swap [LD-18]. `bundleOnly` is not used in v1 (D16 (b) switch only).
  3. **RPC** (`rpc`): `sendTransaction` on the second provider (Helius Free, 1/s on Free [LD-27]) with `maxRetries: 0` [LD-07] and `skipPreflight: true` (CL-24). A success response means "accepted", not landed [LD-09].
  4. Encoding: base64 for every path (v0 transactions under 1,232 bytes; base58 is capped at 1,232 bytes [LD-06], so base64 is used uniformly).
  5. Map responses: HTTP 429 → `E_RATE_LIMITED` with `Retry-After`; JSON-RPC error → `E_REJECTED` with the code and message (sanitised; no URL); other HTTP errors → `E_HTTP`.
- **Shared resources and concurrency:** Buckets owned by M14; this client is stateless.
- **Config:** `m18.sender_endpoint_label`, `m18.jito_endpoint_label`, `m18.rpc_send_provider_label` (labels referencing M14's endpoint registry; URLs and keys live only in M14's secret-backed config).
- **Edge cases and failure handling:** Sender rejects for a missing tip or compute-unit price → `E_REJECTED` and alert `execution` critical (a builder bug); leader not running Jito-Solana → because the same signed bytes carry the Jito tip on every path, the Jito tip is still paid (wasted) whenever such a transaction lands, through any path [LD-17]; this is a known cost of rung ≥ 2 and is included in the cost model and the float (CB-23).
- **Acceptance criteria:**
  1. Given an `http://` Sender URL in config, then config validation fails at start (CA-30).
  2. Given a recorded 429 with `Retry-After: 2`, then `E_RATE_LIMITED` with `retryAfterMs = 2000`.
  3. Given a message without a Sender tip, then the Sender client refuses locally without an HTTP request.
- **Tests:** unit with recorded HTTP fixtures (`FX-SENDER-OK`, `FX-SENDER-429`, `FX-JITO-OK`, `FX-RPC-SEND-OK`; keys redacted); integration in paper mode is impossible (no signing) — the first live use is the 0.01 SOL live-small drill (checklist item 3b).
- **Observability:** metrics `send_latency_ms` (path), `send_result_total` (path, result); log code `m18.path_rejected` (sanitised).
- **Security notes:** M14 never logs URLs (keys may be in the query); this client logs only path labels.
- **Facts used:** LD-06, LD-07, LD-09, LD-17, LD-18, LD-22, LD-27, LD-V06. VERIFY: Jito request path and body; A-40 settled by VF-14.
- **Definition of done:** Common DoD; A-40 resolved.

#### B-M18-03 — Status polling, transaction fetch, fill extraction and failure taxonomy

- **Module:** M18 · **Size:** L (~2.5 engineer-days) · **Phase:** 3
- **Goal:** Determine each attempt's status with batched `getSignatureStatuses`, fetch confirmed transactions (version 1 readers), extract fee, SOL/wSOL/token balance deltas and decoded events, and classify `confirmed_failed` results into `FailureClass` from the failing instruction index and error code (ARCH 7.3a, CA-12).
- **Depends on:** B-M18-01. Group A: A-M14-02 `RpcGateway.call`, A-M02-03 `Decoders.decodeTransactionEvents(tx: RawTransaction)`. Publishes (integration, C-01): topic `fill.events` `{ attemptId, poolId, events: DecodedEvent[], atMs }` for every confirmed own transaction, consumed by A-M01-05 (realised-fee check). In paper the same topic is published by A-M12-01 with `events = []`.
- **Interfaces:**

```ts
interface FailureClassifier { classify(tx: RawTransaction, attempt: { swapIxIndex: number; programIds: Pubkey[] }): { cls: FailureClass; rawCode: string; ixIndex: number | null } }
interface StatusTracker { poll(): Promise<void>; results(): AsyncIterable<AttemptResult> }
```

- **Logic:**
  1. Every 2 slots (by `slotDurationMsEstimate`) one batched `getSignatureStatuses` for all in-flight signatures (P0, primary provider). Signatures whose first send is > 250 slots old, and every call made during recovery, use `searchTransactionHistory: true` (**VERIFY**, A-35). An accepted send is not "landed" [LD-09, LD-31].
  2. Status `processed` → `landed_processed` (published to M19 as entry evidence `status_processed`); `confirmed`/`finalized` with `err == null` → fetch the transaction with `maxSupportedTransactionVersion: 1` [LD-05, EX-V04] at `confirmed` → `confirmed_success`; with `err != null` → fetch → `confirmed_failed` and classify.
  3. From meta: `feeLamports` = `meta.feeLamports` (base + priority; charged even on failure [LD-01]); balance deltas for the hot wallet (`postBalances − preBalances` at its index), wSOL (from token balances of the hot wallet's wSOL ATA, normally 0 net because it is closed in the same transaction) and per-mint token deltas of hot-wallet token accounts; `events` from M02; CU consumed → B-M16-01 `recordUsed`.
  4. Failure taxonomy (ARCH 7.3a), from the failing instruction index and the program error: `slippage` (the swap instruction's minimum-output/maximum-input error codes from the pinned IDL error table); `compute_exceeded` (compute budget exhausted); `insufficient_funds_fee` (fee payer cannot pay); `account_state` (ATA or wSOL account already initialised / not initialised; token-program error codes); `balance_mismatch` (sell amount above balance: the token program's insufficient-funds error on our sell); `venue_disabled` (PumpSwap disable error from the IDL error table [EX-12, TH-19]); `token_program_refusal` (frozen account, transfer-hook error, paused mint, non-transferable [TH-02, TH-08, TH-10]); `blockhash_expired` (treated as expired); anything else `unknown` with the raw code recorded. **VERIFY** every error code mapping against the pinned IDL error tables and the token-program sources; each class gets a unit test with a recorded failing transaction (or a simulated one where none was recorded, ARCH 7.3a).
  5. `slotsToConfirm` = confirmed slot − first-send slot (M15 `highestSeenSlot` at first send).
  6. Status RPC failing for an attempt → keep polling; after the attempt is past `lastValidBlockHeight` per M15, hand over to B-M18-04.
- **Shared resources and concurrency:** Owner of "Transaction signature status" (ARCH 7.2); read-only to others. Results are emitted to M19 (owner of attempt records) which persists them.
- **Config:** `m18.status_poll_slots` (2; 1-10); `m18.history_search_after_slots` (250; 50-300).
- **Edge cases and failure handling:** Transaction meta unavailable after `confirmed` (node not yet indexed) → retry fetch every 2 slots up to 30 s; then emit `confirmed_success`/`confirmed_failed` with `balanceDeltas = null` and M23 marks cost items `model` (ARCH M23 failure mode). A v1 transaction fixture must decode (ARCH M02 rule; CI hard error otherwise).
- **Acceptance criteria:**
  1. Given recorded failing transactions for each class (`FX-FAIL-SLIPPAGE`, `FX-FAIL-CU`, `FX-FAIL-FEEPAYER`, `FX-FAIL-ACCOUNTSTATE`, `FX-FAIL-BALANCE`, `FX-FAIL-VENUEDISABLED`, `FX-FAIL-FROZEN`), then each is classified into its class.
  2. Given 40 in-flight signatures, then one `getSignatureStatuses` call per poll covers all of them.
  3. Given a confirmed sell, then `balanceDeltas.token` shows the mint decreasing by the sold amount and `solLamports` equals proceeds − fees − tips.
- **Tests:** unit (classifier table); integration with recorded fixtures above and `FX-TX-V1` (version-1 transaction); failure injection: status RPC returning errors for 2 min (→ `unknown` → M19 `reconciling`).
- **Observability:** metrics `failure_class_total` (class), `slots_to_confirm` (path), `confirm_latency_ms`, `landing_rate_bps` (window); log codes `m18.failed`, `m18.unknown_error_code` (with raw code).
- **Security notes:** Raw error strings from RPC are sanitised before logging (no URLs).
- **Facts used:** LD-01, LD-05, LD-09, LD-31, EX-V04, EX-12, TH-02, TH-08, TH-10, TH-19, DA-05 (logs may truncate; events come from inner instructions via M02). VERIFY: A-35; error-code tables.
- **Definition of done:** Common DoD; every class in ARCH 7.3a has a fixture test.

#### B-M18-04 — Expiry proof

- **Module:** M18 · **Size:** M (~1.5 engineer-days) · **Phase:** 3 (shared code reused by B-M29-02)
- **Goal:** Mark an attempt `expired` only when the sound proof of ARCH M18 holds (CA-04, CB-21); anything less leaves it `unknown` so M19 reconciles.
- **Depends on:** B-M18-03, B-M15-01. Group A: M14 `RpcGateway.call(…, { provider })`; M22 balance reads via B-M22-02 for the balance branch.
- **Interfaces:**

```ts
interface ExpiryProver {
  tryProve(a: { attemptId: Id; signature: Signature; lastValidBlockHeight: BlockHeight; side: 'buy' | 'sell' | 'other'; mint: Pubkey | null;
                preAmountBase: BaseUnits | null; expectedSolOutLamports: Lamports | null }):
    Promise<{ proven: true; proof: NonNullable<AttemptResult['expiryProof']> } | { proven: false; reason: string }>;
}
```

- **Logic:** an attempt is `expired` only when **all** hold:
  1. On provider P, one `heightOn(P)` reading gives (`S_h`, `H`) with `H > lastValidBlockHeight + 10` (M15; never M15's cached height, never a height from another provider).
  2. A `getSignatureStatuses` call on the same P with `searchTransactionHistory: true` whose response context slot is ≥ `S_h` returns null at `confirmed` — **twice**, at least 2 slots apart, and both responses have context slot ≥ `S_h` (CL-25).
  3. Either the same two conditions hold on a second provider Q ≠ P, **or** a balance check at a slot ≥ `S_h` shows the attempt did not execute: buy → the token balance did not rise and SOL did not fall by the buy amount; sell → the token balance did not fall (compared with `preAmountBase` recorded at build).
  4. Any failure, timeout or a context slot below `S_h` → `proven: false`; the caller keeps the attempt `unknown` → M19 `reconciling` (ARCH 7.3).
  5. `blockhash_expired` failure class (B-M18-03) is treated as expired without this proof (the chain itself reported it).
- **Shared resources and concurrency:** Read-only RPC; results go to M19.
- **Config:** `m18.expiry_margin_blocks` (10; 0-150); `m18.second_provider_label`.
- **Edge cases and failure handling:** Lagging provider (null status from a node whose context slot is before the expiry height) → not proven; provider whose height comes from another node → impossible by construction (single response per reading); engine outage of 6 minutes with a landed exit → history search finds it → `confirmed_success` (ARCH 16.5).
- **Acceptance criteria:** the three ARCH 16.5 "Transaction lands after being presumed expired" scenarios end with no second buy or sell; given P and Q both satisfying conditions 1-2, then `proven: true` with `providers = [P, Q]`.
- **Tests:** unit with fake providers (lag, mixed heights, single null, history search off); integration with recorded responses (`FX-RPC-SIGSTATUS-NULL-LAGGING`, `FX-RPC-EPOCHINFO-B`); property (no sequence of fake responses where the transaction actually landed yields `proven: true` when the history search would have found it).
- **Observability:** metric `expiry_proofs_total` (method: `two_providers` | `balance_check` | `chain_reported`); log code `m18.expiry_not_proven` (reason).
- **Security notes:** This proof is the only guard against double execution after an assumed expiry; changes need two reviewers.
- **Facts used:** LD-07, LD-09. VERIFY: A-35, A-36.
- **Definition of done:** Common DoD; property test runs ≥ 10,000 seeded cases in CI.

#### B-M18-05 — Rung-4 landing through Jupiter `/execute`

- **Module:** M18 · **Size:** S (~1 engineer-day) · **Phase:** 3
- **Goal:** Land a signed rung-4 `/order` transaction through Jupiter `/execute` exactly once, then track it with the normal status polling and expiry proof.
- **Depends on:** B-M18-03, B-M16-07. Group A: M14 `RpcGateway.http('jupiter', …)` with the separate `/execute` bucket (20 RPS keyless, 50 free, 100 paid; 0 credits [EX-29]) and an `acquireSend('jupiter_execute', …)` bucket (CL-04).
- **Interfaces:** `PathClient.send('jupiter_execute', signedTx)`; uses `executeContext` from B-M16-07.
- **Logic:**
  1. `POST https://api.jup.ag/swap/v2/execute` [EX-25] with the signed transaction and whatever `/order` context it requires. **VERIFY** the request body fields and the response shape (including whether it returns a signature and status) against the Jupiter docs before coding.
  2. Never rebroadcast (Jupiter lands and confirms it [EX-25]); never also send the same bytes through our paths (the signer's 2-message rule would allow it, but double-path sends of a Jupiter-landed transaction are not part of the design; CL-26).
  3. Regardless of `/execute`'s answer, track the signature with B-M18-03 and resolve with B-M18-04 using the `lastValidBlockHeight` from B-M16-07 (derived upper bound if Jupiter did not return one, CL-09).
  4. Record Jupiter's fee for the dashboard (ARCH 8.7) through the attempt record (M19).
- **Shared resources and concurrency:** M14's `/execute` bucket.
- **Config:** none beyond B-M16-07.
- **Edge cases and failure handling:** `/execute` timeout → status unknown → poll → expiry proof; `/execute` returns failure but the transaction landed → polling finds it.
- **Acceptance criteria:** given a recorded `/execute` timeout followed by a landed status, then the attempt ends `confirmed_success` with exactly one `/execute` request.
- **Tests:** unit with recorded fixtures `FX-JUP-EXECUTE-OK`, `FX-JUP-EXECUTE-TIMEOUT`.
- **Observability:** `attempts_total{path="jupiter_execute"}`; log code `m18.rung4_execute`.
- **Security notes:** Untrusted response; strict schema.
- **Facts used:** EX-25, EX-29. VERIFY: `/execute` request and response fields.
- **Definition of done:** Common DoD.

---

### M19 Order manager

#### B-M19-01 — `@bot/types` package custody and freeze

- **Module:** M19 (package custodian) · **Size:** S (~1 engineer-day) · **Phase:** 0 (must be frozen before other tickets start, ARCH 18)
- **Goal:** Publish the shared types package `@bot/types` with every type of ARCH 5.0 and 5.0a, the execution contract (`ExecutionPort`, `AttemptRequest`, `AttemptHandle`, `AttemptStatus`, `AttemptResult`, `FillRecord`, `FailureClass`, `OrderIntent`, `LandingPath`, `ExitReason`, `RungParams`), versioned, with compile-time and runtime guards for units.
- **Depends on:** B-M30-01. Consumers in group A: M10, M12, M13 (ARCH 18 cross-group contracts).
- **Interfaces:** verbatim copies of ARCH 5.0, 5.0a, M18 `AttemptStatus`/`AttemptResult`, M19 `OrderIntent`/`AttemptRequest`/`AttemptHandle`/`FillRecord`, M20 `ExitReason`, plus these additions (each recorded as a clarification):

```ts
// CL-04: rung 4 lands through Jupiter /execute
type LandingPath = 'sender' | 'jito_tx' | 'rpc' | 'jupiter_execute';
// CL-27: the port must deliver results; paper (M12) emits the same events as live
type AttemptState = 'building' | 'build_failed' | 'signing' | 'sign_refused' | AttemptStatus;   // full list of ARCH 7.3
interface ExecutionPort {
  submit(a: AttemptRequest): Promise<AttemptHandle>;      // returns immediately with attemptId (ARCH M12)
  status(attemptId: Id): AttemptState;                    // ARCH: "same states as live (section 7.3)"
  onResult(h: (r: AttemptResult) => void): () => void;    // added: final and intermediate results (landed_processed, confirmed_*, expired, unknown)
  onNotLanded(h: (e: { attemptId: Id; slotsSinceFirstSend: number }) => void): () => void;   // integration (C-29): drives exit supersession in every mode
}
// Integration (C-29/CL-27 merged): this is the single ExecutionPort for live (B-M19-06, wired by B-M19-03), paper (A-M12-01) and sim (A-M11-02).
// Ports read an attempt's intent through OrderManager.intent(intentId) (B-M19-02, CL-29); AttemptRequest carries no amounts.
// CL-28: ladder parameters shared by M19 (executes attempts) and M20 (owns the ladder), so neither imports the other
interface RungParams { rung: 1 | 2 | 3 | 4 | 5; route: 'direct' | 'jupiter_order'; slippageBps: Bps; cuPriceMultiplier: 1 | 2 | 3;
  paths: LandingPath[]; tips: Array<{ path: LandingPath; lamports: Lamports }>; chunkFractionBps: Bps | null /* rung 5: 2,500 */ }
interface ExitLadder { params(rung: RungParams['rung'], feeMode: 'normal' | 'minimum'): RungParams; next(rung: RungParams['rung']): RungParams['rung'] | null }
```

- **Logic:**
  1. Package layout: `types.ts` (5.0), `contract.ts` (5.0a), `execution.ts` (this ticket's additions), `canon.ts` (integration: the one canonical-JSON serialiser, keys sorted at every level, big integers as decimal strings, no insignificant whitespace; used by every hash in both groups), `units.ts` (also holds `priorityFeeLamports`, integration) (branded helpers: `lamports(x: bigint): Lamports` etc. and decimal-string codecs `toU64Str`, `fromU64Str` with the regexes of `UI.md` conventions).
  2. Semantic versioning; any change after the freeze requires a changelog entry, a version bump and sign-off from both group leads (ARCH 18 "frozen before tickets start").
  3. ESLint rule package (shared with B-M30-01): forbid `Number()`/`parseFloat` on identifiers ending `Lamports|Base|Slot|Height` (ARCH 16.1); forbid `Date.now` and `Math.random` outside the clock and RNG modules.
  4. Contract test: the `ExitReason` union equals the VM-06 `exit_reason` enum after UC-01 (`stop | target | trailing_stop | time_stop | manual_close | flatten_all | risk_breach | halt_flatten | liquidity_collapse | authority_change | venue_disabled | sentinel_flatten | orphan_close | written_off | other`); run here and in B-M28-01.
- **Shared resources and concurrency:** None (types only).
- **Config:** none.
- **Edge cases and failure handling:** A consumer needing a new field files a change request; no local redefinitions of shared types (lint rule: duplicate type names of the package are rejected).
- **Acceptance criteria:** the package builds with no runtime dependencies (types plus tiny codecs); all ARCH 5.0a types compile; the `ExitReason` equality test passes; codecs round-trip `"18446744073709551615"` and negative values.
- **Tests:** unit (codecs), type tests (`tsd`-style compile assertions; **VERIFY** tool and licence before adding), property (codec round trip for random u64/i64/i128 strings).
- **Observability:** none.
- **Security notes:** No secrets; zero runtime dependencies so the signer may import the codecs.
- **Facts used:** none external.
- **Definition of done:** Common DoD; version 1.0.0 tagged; group A leads acknowledge CL-04, CL-27, CL-28.

#### B-M19-02 — Intent store, idempotency, PERTOKEN index and the intent state machine

- **Module:** M19 · **Size:** L (~2.5 engineer-days) · **Phase:** 2
- **Goal:** Own `order_intent` and `tx_attempt` records and every intent transition of ARCH 7.3, with idempotent `submit`, the PERTOKEN rule enforced by a unique partial index plus a position check, reservations via M22, and HALT's `cancelUnsent`.
- **Depends on:** B-M24-02, B-M22-01. Group A (integration): A-M07-02 `Recorder.append` for `order_event` and `fill` records (ARCH M07 "our own order/fill events"). Group B runtime collaborators: M21 `preSendCheck`, M20 (position states for PERTOKEN), M26 (halt state).
- **Interfaces:**

```ts
interface OrderManager {
  submit(i: Omit<OrderIntent, 'state' | 'intentId' | 'version'>): Result<{ intentId: Id }, { code: 'E_DUPLICATE' | 'E_IN_FLIGHT' | 'E_PERTOKEN' | 'E_RESERVE' | 'E_HALTED' }>;
  cancelUnsent(filter: { side?: 'buy' }): number;
  onFill(h: (f: FillRecord) => void): () => void;
  onEntryEvidence(h: (e: { positionId: Id; evidence: 'status_processed' | 'status_confirmed' | 'token_balance_increase' | 'decoded_event'; slot: Slot }) => void): () => void;
  // additions used inside group B (CL-29)
  intent(intentId: Id): OrderIntent | null;
  openIntentsFor(mint: Pubkey): OrderIntent[];
  onIntentTerminal(h: (i: OrderIntent) => void): () => void;
  // CL-44: janitor, sweep and close_unsolicited transactions use the same sign → persist → send path, stored with order_intent.purpose
  submitMaintenance(m: { kind: 'janitor' | 'sweep' | 'close_unsolicited'; unsigned: UnsignedTx; mint: Pubkey | null }): Result<{ intentId: Id }, { code: 'E_HALTED' | 'E_IN_FLIGHT' }>;
}
const TERMINAL_INTENT: ReadonlySet<OrderState> = new Set(['rejected', 'filled', 'expired_final', 'cancelled', 'abandoned', 'failed']);
```

- **Logic:**
  1. `idempotencyKey = sha256(strategyId | positionId | side | decisionSeq)` (ARCH M19); unique index. Duplicate key → return the existing `intentId` with `ok: true` (idempotent; `E_DUPLICATE` only when the same key arrives with different parameters, which indicates a bug and raises an alert).
  2. Buys: refused `E_PERTOKEN` while the mint has a position in `opening`, `open`, `partially_closed`, `closing`, `close_failed`, `stuck` or `orphan`, or any non-terminal intent (either side) including `reconciling` (CA-15). Enforced by (a) the SQLite unique partial index `order_intent(mint) WHERE side = 'buy' AND state NOT IN (terminal)` (B-M24-02) and (b) the position check against M20 in the same `withTx` transaction. Refused `E_HALTED` while trading state is not `running` (entries only).
  3. Exits: one non-terminal exit intent per position; a second exit request returns the existing intent (ARCH 7.2 "exit requests while one is in flight return the existing intent"); the reason of the existing intent is upgraded if the new reason is more urgent (`urgency: 'emergency'` wins; recorded as a position event).
  4. Transitions exactly as ARCH 7.3 (created → risk_checking → rejected | reserved → building → signing → in_flight → filled | failed | expired_final | cancelled | reconciling | abandoned). Every transition is a compare-and-set on `version` inside one `withTx` with its outbox event (ARCH 7.1).
  5. `risk_checking`: call M21 `preSendCheck(intent)`; buys may be rejected (halt, caps, staleness, `FEEDAY`); exits are never rejected here (CA-08).
  6. `reserved`: buys call M22 `reserve(intentId, amountIn + maxFees + tips + ataRent)`; `E_INSUFFICIENT`/`E_UNRECONCILED`/`E_FLOAT` → `rejected` with `E_RESERVE`. Exits draw on the exit fee float (no new reservation).
  7. `cancelUnsent({ side: 'buy' })` (HALT): buys in `created`, `risk_checking`, `reserved`, `building` → `cancelled`, reservations released; buys already `signing` wait for the signer's answer (the signer refuses buys once the latch is set); `in_flight` buys continue to resolution (ARCH 7.3 HALT row). Returns the number cancelled.
  8. Terminal transitions release reservations with actual spend (M22 `release`), publish `onIntentTerminal`, and for buys move the position per ARCH 7.4 (via M20).
  9. Paper mode uses the same machine with M12's port (ARCH 7.3 "Paper mode").
  10. `submitMaintenance`: one non-terminal maintenance intent per kind at a time (`E_IN_FLIGHT`); `sweep` refused while trading state is `halt_requested` (`E_HALTED`); janitor and `close_unsolicited` allowed in every state (they reduce risk); single attempt, no reservation (fees come from the float headroom), results booked by M23.
- **Shared resources and concurrency:** Owner of order intents and attempts (ARCH 7.2). Reservations owned by M22 (called synchronously inside the same transaction where possible; M22's reservation row and ledger update commit together).
- **Config:** none beyond M21/M22 limits.
- **Edge cases and failure handling:** Crash in any state → recovered by B-M26-05 (ARCH 7.6). Unique-index violation on insert (race) → `E_PERTOKEN`. `Recorder.append` throws `E_QUEUE_FULL` for an `order_event` or `fill` record (A-M07-01 edge case 4) → treat it as a failed record: fail closed, block new entries, alert.
- **Acceptance criteria:**
  1. Given a buy intent for mint X in `reconciling`, when another buy for X is submitted, then `E_PERTOKEN`.
  2. Given HALT with buys in `reserved` and `in_flight`, then the reserved one becomes `cancelled` with its reservation released and the in-flight one continues.
  3. Given the same `idempotencyKey` twice, then one intent exists.
- **Tests:** unit (transition table, every row of ARCH 7.3); property (random event sequences: no undefined transition; terminal states absorbing; reservations released exactly once; at most one attempt per buy intent; ARCH 16.2); integration with SQLite (index enforcement).
- **Observability:** metrics `intents_total` (side, terminal_state), `intent_state_duration_ms` (state); log codes `m19.intent_transition`, `m19.duplicate_mismatch`.
- **Security notes:** None beyond conventions.
- **Facts used:** none external.
- **Definition of done:** Common DoD; ARCH 16.2 state-machine properties pass.

#### B-M19-03 — Execution port wiring and attempt lifecycle (simulation and paper)

- **Module:** M19 · **Size:** S (~1 engineer-day) · **Phase:** 1-2 (simulation and paper; split from the original B-M19-03 on 2026-10-07, INTEGRATION "Remaining issues")
- **Goal:** The mode-independent half of the execution port: the `tx_attempt` row lifecycle, port selection by mode (M11's simulation port, M12's paper port; the live port is B-M19-06), and the mapping of every `AttemptResult` to the ARCH 7.3 transitions, so the order manager runs the same code in every mode.
- **Depends on:** B-M19-02. Group A: M11 (`SimExecutionPort`, A-M11-02) and M12 (`PaperExecutionPort`, A-M12-01) implement the same port.
- **Interfaces:** `ExecutionPort` (B-M19-01); `selectExecutionPort(mode): ExecutionPort` (NEW).
- **Logic:**
  1. `submit(AttemptRequest)`: create the `tx_attempt` row (`building`), return `{ attemptId, signature: null }` immediately; continue asynchronously in the selected port.
  2. Results from the port's `onResult` and `onNotLanded` update the attempt row and drive the intent (B-M19-04/05), with the same transitions the live port uses (ARCH 7.3).
  3. Mode selection: `backtest`/`replay` → M11's port; `paper` → M12's port. A startup assertion refuses to construct the live port while mode is `paper` unless positions opened in live are being managed with `keep_managing` (ARCH 7.7); before B-M19-06 exists, any live mode refuses to start.
- **Shared resources and concurrency:** Attempt records (owner M19).
- **Config:** none beyond the mode.
- **Edge cases and failure handling:** Engine restart with pending simulated or paper attempts → they resolve as M11/M12 define (paper: `expired`, pessimistic); the attempt row records it.
- **Acceptance criteria:**
  1. Given mode `paper`, when the engine starts, then the live port is not constructed and no signer or sender call exists.
  2. Given a paper `AttemptResult` for an entry and one for an exit, then the attempt rows and intents move through exactly the ARCH 7.3 transitions the live port would produce for the same result.
  3. Given a live mode while B-M19-06 is absent, then the engine refuses to start.
- **Tests:** unit with fake simulation and paper ports (every `AttemptStatus`); the replay-vs-paper parity test (A-M11-03).
- **Observability:** metric `attempts_total{mode,status}`.
- **Security notes:** No key, signer or sender path exists in this ticket.
- **Facts used:** none external.
- **Definition of done:** Common DoD; gate runs in M2 (A-M11-02/03) drive the order manager through this ticket.

#### B-M19-04 — Entries: single attempt, fast evidence poll and reconciliation of unknown outcomes

- **Module:** M19 · **Size:** M (~2 engineer-days) · **Phase:** 2 (paper), 3 (live)
- **Goal:** Enforce single-attempt entries, publish the first evidence that a buy landed so M20 arms protective exits at once (CA-09), and resolve `unknown` outcomes through the `reconciling` state without ever sending a second buy (CA-04).
- **Depends on:** B-M19-03, B-M22-02. Group A: none.
- **Interfaces:** `OrderManager.onEntryEvidence` (B-M19-02).
- **Logic:**
  1. A buy intent gets exactly one attempt. Attempt `expired` (proven, B-M18-04) → check the token balance first (ARCH 7.6 step 3); if unchanged → intent `expired_final` (no retry; ARCH M19); the strategy may emit a fresh signal that goes through M21 `evaluate` as a new intent.
  2. `confirmed_failed` → `failed` with the failure class (entries are single-attempt even for `slippage`; ARCH 7.3a); `compute_exceeded` on an entry also ends `failed` (the profile is bumped for the next entry) (CL-30: ARCH's "same rung again" applies to exits).
  3. Fast evidence poll while the buy is `in_flight` or `reconciling`: every `fast_poll_ms` (1,500 within the 1-2 s band) call M22 `ataBalance(mint)` at P0 (**VERIFY** `getTokenAccountBalance`, A-36). First evidence among `status_processed` (from M18), `status_confirmed`, `token_balance_increase` (balance > pre-buy balance recorded at build), or `decoded_event` → publish `onEntryEvidence` once per position.
  4. `unknown` → `reconciling`: continue status polling with history search; the fast poll continues; if the balance rises → `filled` from balance deltas, then locate the transaction by signature search (`getSignaturesForAddress` on the hot wallet [DA-08]) to fill exact costs; if expiry is proven (two providers, or one provider plus a balance check) → as `expired`.
  5. Still undetermined after 120 s → stay `reconciling`; M21 blocks new entries for this mint (PERTOKEN covers it); alert warning (ARCH 7.3).
  6. Paper: M12 emits the same evidence shapes; `token_balance_increase` is synthetic from the paper ledger.
- **Shared resources and concurrency:** Attempt and intent records (M19). Balance reads through M22 (owner).
- **Config:** `m19.fast_poll_ms` (1,500; 1,000-2,000); `m19.reconcile_alert_after_ms` (120,000).
- **Edge cases and failure handling:** Status RPC down for 2 min while the buy landed and price falls → the fast poll sees tokens within 2 s and exits are armed (ARCH 16.5 CA-09 row). Tokens appear from an unrelated transfer (dust) → still treated as evidence (conservative: arming exits on an unfilled position only produces a no-op exit, `E_ZERO_BALANCE`, or sells dust).
- **Acceptance criteria:**
  1. Given a buy that lands while `getSignatureStatuses` fails, then `onEntryEvidence('token_balance_increase')` is published within 2 s of the balance change.
  2. Given an attempt proven expired with an unchanged balance, then the intent ends `expired_final` and no second attempt exists.
  3. Given an `unknown` attempt for 130 s, then the intent is `reconciling`, the mint is blocked for new entries, and a warning alert exists.
- **Tests:** unit; integration with fake RPC (status down, balance up); failure injection rows from ARCH 16.5.
- **Observability:** metrics `entry_evidence_latency_ms` (evidence), `reconciling_intents`; log codes `m19.entry_evidence`, `m19.reconciling_long`.
- **Security notes:** None beyond conventions.
- **Facts used:** DA-08, LD-09. VERIFY: A-36.
- **Definition of done:** Common DoD.

#### B-M19-05 — Exit attempts: supersession (≤ 2 concurrent), failure-class actions and rung execution

- **Module:** M19 · **Size:** M (~2 engineer-days) · **Phase:** 2 (paper), 3 (live)
- **Goal:** Execute the exit-attempt policy of ARCH M19 and 7.3: every exit attempt sells the full on-chain balance (or a chunk); a superseding attempt at the next rung is built in parallel when the previous one has `confirmed_failed` or has not landed within 8 slots of its first send, with at most 2 concurrent exit attempts per position; failure classes decide the next action.
- **Depends on:** B-M19-03. Uses `ExitLadder` (B-M19-01 type; implemented by B-M20-04). Group A: A-M14-03 `beginExitWork(key)` / `endExitWork(key)` (C-41): called with key = exit intent ID when an exit attempt starts building and when it reaches a terminal state, so M14 reserves the Jupiter budget for exits (ARCH M14 CA-10).
- **Interfaces:** internal `ExitAttemptPolicy { onNotLanded(attemptId): void; onResult(r: AttemptResult): void }`.
- **Logic:**
  1. Exit intent created by M20 with a starting rung (1 normally; 2 for liquidity collapse, flatten, sentinel-like emergencies; ARCH 8.6). Attempt N uses `ExitLadder.params(rung, M21.exitFeeMode())`: CU price = `cuPriceMultiplier × entryCap` (or the floor in `minimum` fee mode, CA-08), slippage, paths, tips, `chunkFractionBps`.
  2. Supersession: on M18 `onNotLanded` (8 slots) or `confirmed_failed`, if fewer than 2 exit attempts of this position are unresolved, build the next attempt at `ExitLadder.next(rung)` in parallel (the earlier one stays in flight). Each sells the on-chain balance read at its own build; the loser fails as `balance_mismatch`, which is never counted toward cannot-sell (ARCH 7.3a).
  3. Failure-class actions (ARCH 7.3a): `slippage` → next rung; `compute_exceeded` → same rung, `cuLimitOverride = bumpAfterComputeExceeded(previous)` (cap 1,400,000), profile updated; `insufficient_funds_fee` → same rung at minimum priority and tips, critical alert; `account_state` → rebuild with fresh reads, alert after 2 in a row; `balance_mismatch` → re-read balance; zero → resolve as sold (`E_ZERO_BALANCE` path); `venue_disabled` → jump to rung 4; `token_program_refusal` → report to M20 cannot-sell evaluation immediately; `blockhash_expired` → as expired → new attempt at the same rung; `unknown` → next rung; M20 counts consecutive `unknown` on the swap instruction (3 → cannot-sell).
  4. Proven `expired` → new attempt at the same rung with a new blockhash (same intent) (ARCH 7.3).
  5. Chunked exits (rung 5, or when M20 decides the full-size impact exceeds the rung cap): concurrently outstanding chunks never sum above the balance read at build (CA-03); after a chunk fills with remaining balance > 0 the intent is `filled` and M20 creates the next chunk intent (`partially_closed` → `closing`, ARCH 7.4) after 4 × slot time.
  6. Sell intents end `filled` when an attempt is `confirmed_success`; the fill carries the actual SOL and token deltas.
- **Shared resources and concurrency:** Attempt records (M19); the ≤ 2 bound is mirrored by the signer's ≤ 2 unexpired messages per mint (B-M17-07).
- **Config:** `m19.max_concurrent_exit_attempts` (2; fixed, not editable above 2); `m19.chunk_delay_slots` (4).
- **Edge cases and failure handling:** A third concurrent request → not created; waits for a resolution. `FEEDAY` exceeded → `minimum` fee mode, exits still sent (ARCH 16.5 CA-08 row).
- **Acceptance criteria:**
  1. Given a rung-1 exit not landed in 8 slots during a 30% drop, then a rung-2 attempt is built and sent within 8 slots + 250 ms while rung 1 stays in flight; one fills, the other fails `balance_mismatch` (ARCH 16.5).
  2. Given `ComputeBudgetExceeded` three times on exits, then each retry raises the CU limit × 1.5; no `stuck`, no blacklist (ARCH 16.5).
  3. Given `venue_disabled`, then the next attempt is rung 4.
- **Tests:** unit (policy table); property (random result sequences: never more than 2 unresolved exit attempts per position; chunks never exceed balance); integration with fake M18 and the real signer.
- **Observability:** metrics `exit_rung_total` (rung), `exit_supersede_total`, `exit_attempts_per_position`; log codes `m19.exit_supersede`, `m19.exit_rung`.
- **Security notes:** None beyond conventions.
- **Facts used:** LD-02.
- **Definition of done:** Common DoD; ARCH 16.5 exit rows pass.

#### B-M19-06 — Live execution port: build → sign → persist → send

- **Module:** M19 · **Size:** L (~2 engineer-days) · **Phase:** 3 (live; split from the original B-M19-03 on 2026-10-07, whose simulation and paper half is now B-M19-03)
- **Goal:** Implement `ExecutionPort` for live modes: build with M16, sign through the signer socket, persist the signature and signed bytes **before** sending, send through M18, and map every signer and builder response to the ARCH 7.3 transitions, including the signer timeout path through `status_of`.
- **Depends on:** B-M19-03, B-M16-04 (and B-M16-07 for rung 4), B-M17-01 (protocol), B-M18-01. Group A: M12 implements the same port for paper.
- **Interfaces:** `ExecutionPort` (B-M19-01); signer client:

```ts
interface SignerClient {               // over /run/signer/engine.sock (identity 'engine' from SO_PEERCRED)
  sign(r: SignRequest, timeoutMs: number): Promise<Result<SignResponse & { ok: true }, { code: SignerError | 'E_TIMEOUT' | 'E_SOCKET'; message: string; hintMismatch: boolean }>>;
  statusOf(intentId: Id): Promise<Result<StatusOfResponse, { code: 'E_TIMEOUT' | 'E_SOCKET' }>>;
  status(): Promise<Result<SignerStatus, { code: 'E_TIMEOUT' | 'E_SOCKET' }>>;
  latch(r: LatchRequest): Promise<Result<true, { code: string }>>;
  lease(r: LeaseRequest): Promise<Result<true, { code: string }>>;
  setMode(r: SetModeRequest): Promise<Result<true, { code: string }>>;
}
```

- **Logic:**
  1. `submit(AttemptRequest)`: the attempt row and result handling are B-M19-03's; this port continues asynchronously from `building`.
  2. Build: `buildSwap` (rungs 1-3, 5) or `buildOrderExit` (rung 4). Map: `E_NO_ROUTE`/`E_QUOTE_DRIFT`/`E_ROUTE_POOL_MISMATCH`/`E_TOO_LARGE`/`E_ROUTE` → entry `abandoned` (reservation released), exit → next rung via B-M19-05; `E_ZERO_BALANCE` (sell) → `filled` if an earlier attempt of this intent or the sentinel journal shows the sale, otherwise `reconciling` (ARCH 7.3); `E_BLOCKHASH` → entry `abandoned`, exit retry in 2 s.
  3. Sign: `sign({ kind: 'sign', requestId, intentId, messageBytesB64, hint, priorAttempts })` with `timeoutMs = 2,000` (ARCH 7.3). Mapping: `ok` → persist `signature`, `signedTxB64`, `lastValidBlockHeight` and the signer's `classification` on the attempt row **in one committed transaction before any send** (crash safety), then `in_flight`; `E_HALTED`/`E_EXITS_ONLY`/`E_MODE`/`E_CAP_DAY`/`E_HOTCAP` (buys) → `cancelled`, reservation released; `E_LEASE` (exit) → intent parked, position stays `closing`, alert (the sentinel owns exits for this mint); `E_BALANCE` (exit) → back to `building` with a fresh balance read, counted as `balance_mismatch`; `E_DUPLICATE` (exit, 2 unexpired) → wait for B-M18 results then rebuild; `E_PROOF_REQUIRED` (buy) → `reconciling`; any other policy refusal → `abandoned` and `security` critical alert; `hintMismatch: true` → `security` critical alert in every case.
  4. Signer timeout or socket error → `statusOf(intentId)` first: if a message for this attempt's message hash exists, adopt its signature and go to `in_flight`; otherwise back to `building` (ARCH 7.3).
  5. Send: M18 `send({ attemptId, side, signedTx, signature, lastValidBlockHeight, paths })`; `paths` = rung's paths (`sender` + `rpc` at rung 1; + `jito_tx` from rung 2; `jupiter_execute` at rung 4).
  6. Results from M18 `onResult` go to B-M19-03's result handling, which updates the attempt row and drives the intent (B-M19-04/05).
  7. Paper mode never constructs this port (B-M19-03's startup assertion).
- **Shared resources and concurrency:** Attempt records (owner M19); signer state (owner M17, via protocol). The signed bytes persisted here are what M18 rebroadcasts after a restart.
- **Config:** `m19.signer_timeout_ms` (2,000; 500-10,000); `m19.signer_socket_path`.
- **Edge cases and failure handling:** Crash after signing, before send → on restart the signature is known (persisted) and the status query decides (ARCH 16.5); crash after sign returned but before persistence → `statusOf` adopts it (ARCH 7.6 step 4).
- **Acceptance criteria:**
  1. Given the signer returns a signature and the engine is killed before sending, when it restarts, then no second buy message is requested and the attempt is resolved by status query (landed or expired).
  2. Given a signer timeout and `statusOf` showing a signature for the same message hash, then the attempt adopts it without re-signing.
  3. Given `E_LEASE` on an exit, then the intent is parked and an alert is raised; no retry loop runs.
- **Tests:** unit with a fake signer and fake sender (every response code); integration with the real signer binary in CI (three users); failure injection: kill at each step (ARCH 16.5 first two rows).
- **Observability:** metrics `signer_latency_ms`, `signer_refusals_total` (code), `build_sign_segment_ms` (route; D05 trigger metric, CL-14); log codes `m19.signed`, `m19.sign_refused`, `m19.sign_timeout_adopted`.
- **Security notes:** The engine never sees key material; it only sends message bytes. `hintMismatch` is always a security alert.
- **Facts used:** LD-07 (same signed bytes rebroadcast idempotently).
- **Definition of done:** Common DoD; ARCH 16.5 rows "Crash after signing", "Crash after send", "Signer down / refuses" pass.

---

### M20 Position and exit manager

Shared interface (exact copy of ARCH M20): `ExitReason`, `ExitTrigger`, `Position`, `Mark`, `PositionManager` as in ARCH section 5 M20.

#### B-M20-01 — Position records and the position state machine

- **Module:** M20 · **Size:** M (~2 engineer-days) · **Phase:** 2
- **Goal:** Own `position` and `position_event` records and every transition of ARCH 7.4, including early arming, the audited `open_failed → open` correction, `orphan`, `stuck`, `written_off`, sentinel-managed closes, and the candidate and watchlist side effects (pin, unpin, cooldown).
- **Depends on:** B-M24-02, B-M19-02. Group A: M05 `Universe.pinForPosition(poolId)`, `unpin(poolId)`; M05 candidate transitions (`in_position` → `cooldown` on any terminal position state; write-off → `cooldown` then `blacklisted`) through an event `position.terminal` that M05 consumes (CL-31); M09 `ExitPlan`.
- **Interfaces:** `PositionManager.open(fromIntent)`; internal `transition(positionId, event, expectedVersion)`; events published: `position.opened`, `position.armed`, `position.state_changed`, `position.terminal`.
- **Logic:**
  1. `open(entryIntent)`: create `opening` with `sizeBase = 0`, `exitPlan` from the signal, `triggers` empty, `source` = mode-derived; pin the pool in M05 (ARCH 7.4 first row).
  2. Entry evidence (M19 `onEntryEvidence`) while `opening` → stay `opening`, arm stop, liquidity-collapse, authority-change and time-stop triggers (targets wait for `open`); risk flag `entry_unconfirmed` for VM-05 (UC-03).
  3. Entry intent `filled` → `open`: `entrySizeBase = sizeBase = tokenDelta`, `entryCostLamports` = all-in (SOL out of the fill including fees and tips, excluding the refundable ATA rent which M23 books as `rent_deposit`), `entryPriceSolPerToken` = volume-weighted from fills (DecimalStr, exact: `entryCostLamports / 1e9 / (sizeBase / 10^decimals)` computed with integer arithmetic to 18 decimal places, rounded half-up) (CL-32); arm all triggers.
  4. Entry intent terminal without fill → `open_failed`; book failed costs to a zero-size trade record (M23); unpin; `position.terminal` (candidate cooldown).
  5. `open_failed` + later evidence that the buy landed (reconciliation finds `ours` tokens of this mint and a signature search links them to this position's buy) → `open` at the true cost basis from that transaction; the zero-size trade record is superseded by an audit-linked correction record (never edited); re-arm; alert (CA-04, CA-15).
  6. Exit lifecycle per ARCH 7.4: `open` → `closing` (exit intent); `closing` + filled with remaining > 0 → `partially_closed` (realised partial recorded); next chunk → `closing`; filled with remaining = 0 → `closed` (journal trade via M23; unpin; janitor later; `position.terminal`); exit intent terminal without fill → `close_failed` (ladder next rung; alert after rung 2); retry timer 2 s → `closing`; cannot-sell → `stuck` (critical alert); `stuck` retry every 5 min; success → `closed`; operator `write_off_position` → `written_off` (journal with `exit_reason = written_off` and proceeds 0; M22 `written_off` list; candidate cooldown then blacklist).
  7. Reconciliation shows balance < recorded size (external transfer, burn) → stay `open` with adjusted size; alert `reconciliation` critical.
  8. `orphan`: created by M22 reconciliation for an `ours` balance with no position and no linkable `open_failed` entry: managed position at cost basis 0, risk flag `orphan`, exits armed with time stop 0 (close at the next opportunity if `pre_exit` checks pass); exit filled → `closed` with `orphan_close`. `unsolicited` and `written_off` balances never create orphans (CA-14).
  9. Sentinel takeover: positions whose mint lease is held by the sentinel are not touched; after `importSentinelFills` (B-M20-05) they move to `closed` with `sentinel_flatten`.
  10. Terminal states: `closed`, `open_failed`, `written_off`. VM-05 mapping (for M28): `stuck` → `close_failed` with `close_failed_reason`; `orphan` → `open` with flag `orphan`; `open_failed`/`written_off` are not shown in VM-05.
  11. Positions are always managed in the mode in which they were opened (`keep_managing`, ARCH 7.7).
- **Shared resources and concurrency:** Owner of position records (ARCH 7.2). M19 reports fills and evidence; M26/M28 commands call `close`/`flattenAll`/`writeOff`; M21 calls `requestHalt(flatten)` which reaches `flattenAll` via M26. CAS on `version`; the SQLite partial unique index on `position(mint)` for non-terminal states backs PERTOKEN (B-M24-02).
- **Config:** `m20.close_failed_retry_ms` (2,000); `m20.stuck_retry_ms` (300,000).
- **Edge cases and failure handling:** Fill arrives for a position already `closed` (late import) → appended as a correction fill and audited; the trade is re-derived as a correction record.
- **Acceptance criteria:**
  1. Given entry evidence before the fill, then the position is `opening` with stop and time-stop triggers armed and flag `entry_unconfirmed`.
  2. Given an `open_failed` position whose buy is later found landed, then the same `positionId` becomes `open` with the true cost basis and the zero-size trade has a superseding correction record (no orphan at cost basis 0; ARCH 16.2).
  3. Given a write-off, then the mint is in M22's `written_off` list and a later reconciliation creates no orphan.
- **Tests:** unit (every ARCH 7.4 row); property (ARCH 16.2 sequences covering CA-15); integration with SQLite indexes.
- **Observability:** metrics `positions_open`, `position_state_total` (state); log codes `m20.transition`, `m20.open_failed_relinked`, `m20.orphan_created`.
- **Security notes:** None beyond conventions.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M20-02 — Exit-quote marks and trigger evaluation (stops, targets, trailing, time)

- **Module:** M20 · **Size:** M (~2 engineer-days) · **Phase:** 2
- **Goal:** Compute `Mark`s at ≤ 1 Hz per position from the latest pool snapshot using local constant-product quotes (no extra RPC; UI Q-02), and evaluate every armed trigger on each snapshot (2 Hz for position pools) and on timers, with several stops and targets armed at once (UC-02).
- **Depends on:** B-M20-01. Group A: M04 `PoolTracker.latest(poolId)` and `pool.snapshot` events, M01 `quoteExactIn`, `feeFor`, M08 `Features.rollingMedian(poolId, 6h)`, M10 `estimateRoundTripCostBps` not needed (exit cost computed directly).
- **Interfaces:** `PositionManager.marks(): Mark[]`; internal `evaluate(position, snapshot, nowMs): ExitDecision | null` with `type ExitDecision = { reason: ExitReason; startRung: 1 | 2; urgency: 'normal' | 'emergency' }`.
- **Logic:**
  1. Mark (method `exit_quote`, D-UI-08): `q = quoteExactIn(snapshot.pool, 'sell', sizeBase)`; `exitCostEstLamports` = rung-1 network fee (5,000 + `priorityFeeLamports(entry cap price, cu limit)`) + Sender tip 5,000 + janitor close estimate (15,000, ARCH 2.4 conclusion 7) (venue fee is already inside `q.amountOut`); `exitValueEstLamports = q.amountOut − exitCostEstLamports` (floored at 0); `priceImpactExitBps = q.priceImpactBps`; `unrealizedNetLamports = exitValueEst − entryCostLamports + realizedPartialLamports`; `markSolPerToken` = `q.amountOut` per whole token (DecimalStr). Published at most once per second per position.
  2. PnL in bps for triggers = `unrealizedNetLamports × 10,000 / entryCostLamports` (integer, floor toward −∞), so stops are **after cost** (ARCH 8.6).
  3. Triggers from `ExitPlan`: stop at `stopBps` (MR −400/−500; bounds −300..−1,500); targets MR: mark ≥ `rollingMedian(pool, 6 h)` **or** PnL ≥ +600 bps (whichever first); PM: +1,500 bps; trailing (PM only): armed after +800 bps, fires at 800 bps below the high-water mark; time stop at `openedMs + timeStopMs`. All armed triggers are evaluated; the first that fires creates the exit with its reason (`stop`, `target`, `trailing_stop`, `time_stop`).
  4. High-water mark updated from marks (`highWaterSolPerToken`).
  5. Evaluation happens on every `pool.snapshot` for the position's pool and on a 1 s timer (for time stops and when snapshots stop arriving). No snapshot for the pool → `freshRead(pool, Number.POSITIVE_INFINITY)` (exit grade, C-09); failure (`E_RPC`) → keep retrying every 2 s with an alert (ARCH M20).
  6. Exits are evaluated only for mints whose exit lease the engine holds (B-M20-05).
- **Shared resources and concurrency:** Reads snapshots (owner M04); writes triggers on its own position records.
- **Config:** strategy exit parameters come from the strategy's `ExitPlan` (owned by M09, `affectsReturns: true`); `m20.mark_hz` (1); `m20.janitor_cost_estimate_lamports` (15,000).
- **Edge cases and failure handling:** Rolling median unavailable (M08 null) → that target is not armed; the +600 bps target still is; flag `target_median_unavailable`. Snapshot slot older than the last evaluated → ignored (snapshots are monotonic per M04).
- **Acceptance criteria:**
  1. Given entry cost 66,666,667 and an exit value estimate 63,666,667, then PnL = −450 bps and a −400 bps stop fires with reason `stop`.
  2. Given MR and a mark reaching the 6 h median at +250 bps, then the target fires with reason `target`.
  3. Given PM at +900 bps then falling to +50 bps from a high-water of +900 bps, then the trailing stop fires (800 bps below the high).
  4. Given 3 positions, then `marks()` emits ≤ 1 per second per position.
- **Tests:** unit (formulas with exact integers); property (stop always fires before PnL < stop − one snapshot's move; marks never negative); replay-driven integration using recorded snapshots (`FX-POOL-PATH-DUMP`).
- **Observability:** metrics `mark_age_ms`, `trigger_fired_total` (kind), `snapshot_to_trigger_ms`; log code `m20.trigger`.
- **Security notes:** None.
- **Facts used:** EX-07, EX-09 (local quote math via M01); ST-V08 (MAD rule context only).
- **Definition of done:** Common DoD; latency target "snapshot → trigger evaluation" p95 ≤ 20 ms measured (ARCH 10.2).

#### B-M20-03 — Early arming and universal protective exits

- **Module:** M20 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** Arm protective exits from the first evidence of landing (CA-09) and implement the universal exits of ARCH 8.6: liquidity collapse, authority or extension change, venue fee change or disable, and the parallel pre-exit authority re-check that can only change the reason or the rung (CA-31).
- **Depends on:** B-M20-02, B-M19-04. Group A: M06 `Screener.authorityRecheck(mint)` and events `token.authority_changed`; M06 LP-distribution re-check result on its 10-min TTL (event `pool.lp_changed { poolId, mint, maxWithdrawableBps, previousBps, atMs }` published by A-M06-04; name and payload fixed at integration, CL-33); A-M01-05 `FeeScheduleChanged` (topic `venue.fee_schedule_changed`) and `venue.status_changed`; A-M01-04 `venue.pool_quarantined`; A-M04-01 `pool.stale`; A-M06-04 `pool.lp_changed`; A-M06-06 `token.authority_changed` (integration: topic names fixed).
- **Interfaces:** subscribes to the events above; produces `ExitDecision` (B-M20-02).
- **Logic:**
  1. Liquidity collapse (start rung 2): effective quote depth falls ≥ 30% from the entry snapshot within 5 min, or below the strategy minimum (MR 300 SOL, PM 85 SOL), or real/effective quote < 0.4, or `pool.lp_changed` (`lp_withdrawable_max` change) (ARCH 8.6).
  2. Authority or extension change (`token.authority_changed`, or found by the pre-exit re-check): immediate exit, reason `authority_change` (ARCH 8.6; M06 rule).
  3. Venue fee-config change raising the fee, or disable flags set → exit if the sell path is open (rung 4 uses other routers); otherwise `stuck` with alert; reason `venue_disabled` when disabled (ARCH 8.6).
  4. Pool account closed or owner changed (M04 quarantine) → reason `liquidity_collapse`, start rung 2.
  5. Pre-exit re-check: every exit start triggers `authorityRecheck(mint)` **in parallel**; the first exit attempt is never delayed (CA-31). If the re-check finds a change, the exit's reason becomes `authority_change` and, if the cause is a frozen account path, the ladder escalates (M20-04).
  6. HALT itself triggers no exit (D24).
- **Shared resources and concurrency:** Own position triggers only; events are consumed on the loop.
- **Config:** `m20.collapse_depth_drop_bps` (3,000; `affectsReturns: true`); `m20.collapse_window_ms` (300,000); `m20.collapse_real_ratio_bps` (4,000).
- **Edge cases and failure handling:** Authority re-check RPC error → never blocks the exit; logged (M06 rule).
- **Acceptance criteria:**
  1. Given a 31% depth drop within 3 minutes of entry, then an exit starts at rung 2 with reason `liquidity_collapse`.
  2. Given `token.authority_changed` for an open position, then an exit intent exists within one event-loop turn.
  3. Given a stop exit, then the first attempt's build starts before `authorityRecheck` resolves (asserted with a delayed fake).
- **Tests:** unit; integration with recorded paths (`FX-POOL-PATH-RUG`); failure injection rows "Token freeze authority appears", "Fee config change mid-position", "Venue disables sell" (ARCH 16.5).
- **Observability:** metric `universal_exit_total` (reason); log code `m20.universal_exit`.
- **Security notes:** None.
- **Facts used:** EX-07, EX-09, EX-12, EX-V01, TH-02, TH-07, TH-19.
- **Definition of done:** Common DoD.

#### B-M20-04 — Exit escalation ladder, chunking and cannot-sell detection

- **Module:** M20 · **Size:** M (~2 engineer-days) · **Phase:** 2 (paper), 3
- **Goal:** Implement the single ladder of ARCH 8.7 (identical to D09) as the `ExitLadder` used by M19, choose start rungs and chunking, and detect cannot-sell only from the failure classes that count (ARCH 7.3a, 8.6).
- **Depends on:** B-M20-03, B-M19-05. Group A: A-M06-05 `screen(…, { purpose: 'pre_exit', withSellSim: true })` (C-43), A-M01-03 quotes. Group B: M21 `exitFeeMode()` (interface only, from `@bot/types`; B-M21-05 implements it, so this is not a build dependency).
- **Interfaces:** implements `ExitLadder` (B-M19-01).
- **Logic:**
  1. Rung table (ARCH 8.7): 1 = direct, normal slippage (MR 100 bps, PM 300 bps), priority = entry cap, paths `sender` + `rpc`, Sender tip 5,000; 2 = direct, 300 bps, 2 × entry cap, + `jito_tx`, tips 5,000 + 1,000; 3 = direct (Jupiter `/build` only if it exists and is not rate-limited — disabled in v1), 800 bps, 3 × entry cap, all paths, both tips, alert warning; 4 = Jupiter `/order` + `/execute`, 1,500 bps, Jupiter-managed fees, total cap 2,000,000 lamports (signer-checked), alert critical; 5 = chunked 25% of the on-chain balance per attempt, direct, 1,500 bps, 3 × entry cap, all paths, both tips. Hard ceiling 2,500 bps; the bot never sells with unbounded slippage.
  2. `entry cap` = min(50,000 lamports, 20 bps of the position's entry notional) expressed as a CU price for the route's CU limit; exit priority ceiling 600,000 lamports (ARCH 8.3). In `minimum` fee mode (`FEEDAY` exceeded) every rung uses the configured floor price and minimum tips, still sent, critical alert (CA-08).
  3. D09 switch: exit failure rate > 10% over 30 exits → Jito path from rung 1 (config `m20.jito_from_rung1`, set by the operator after the trigger alert; not automatic, CL-34).
  4. Chunking from the start: if M01's quote for the full balance has `priceImpactBps` > the rung's slippage cap, the exit starts chunked (25% chunks) at that rung (D09 (d)).
  5. **Real-vault sizing (supervisor rulings, Z0D rounds 3, 4 and 5; C-13, C-60 [VF-05]).** A PumpSwap sell whose output exceeds the real quote vault is refused, not clamped. Every sell attempt, at every rung and for every chunk, is sized **in output terms**: the base amount is the largest `b ≤ planned size` with `out(b) − lpFee(b) ≤ realQuoteVault × (10,000 − slippageBps) / 10,000`, where `out` and `lpFee` come from A-M01-03 on the pool state used for the quote and `slippageBps` is the rung's slippage bound (output is concave in input, so a margin taken on base units would be too small). When the quote for the planned size returns `E_EXCEEDS_REAL_VAULT`, the attempt sells that margined size and the rest stays in the position for the next attempt. `E_EXCEEDS_REAL_VAULT` is a quote-time result, not an on-chain failure class: it is **not** a cannot-sell failure and never moves a step 6 counter. If the margined size is 0, no attempt is sent, an alert (critical) is raised, and the sell is re-quoted on every new snapshot.
     - **Refusal on chain (VERIFY).** The program's error code for a sell above the real vault is not verified. A failed sell is classified in this order: `token_program_refusal` first (it counts, step 6); then `exceeds_real_vault` only when the failing instruction is the PumpSwap sell itself and the real quote vault on the last snapshot at or before the failure slot is below the attempt's gross output less the LP fee; anything else by step 6's classes. `exceeds_real_vault` does not count toward cannot-sell; once the code is verified, that code is mapped to the same class.
     - **Repeated refusals.** After 5 `exceeds_real_vault` refusals in a row on a position: alert (critical), and automatic re-sends pause until a snapshot reads the real vault above the next attempt's margined output (`out − lpFee` at the margined size).
     - **Cost.** The fees and tips spent on refused sells are booked in the stuck-cost line (M23 `CostItem.kind` `stuck_cost`, ARCH M23) for that position.
     - **Drained for good (supervisor rulings, Z0D rounds 7 and 8).** With `T_drained` = max(the strategy's time stop `T`, 24 h): if a position stays in the 5-refusal pause for longer than `T_drained`, or its margined size is 0 for longer than `T_drained`, then (1) if the margined size on the latest snapshot is above 0, one last sell at that size is sent and its **real** proceeds are booked; (2) the position is marked cannot-sell and `stuck`, the rest is valued at 0 and written off (B-M20-05, proceeds 0), so equity only ever holds amounts actually realised and the loss is booked in SOL (M22/M23); (3) its `MAXOPEN` slot is freed (M21); (4) an alert (critical) is raised. **Recovery watch:** for 7 days after `stuck`, a read-only re-quote runs every hour inside the ≤ 50% read budget (M14 P4); if the margined size rises above 0, an automatic recovery sell at that size runs (an exception to `stuck` blocking `close` and to the mint blacklist, for this position only) and its proceeds are booked through M22's ledger as realised proceeds of the written-off position, in SOL (a recovery, not a cost item; ARCH M23 cost kinds). After 7 days the watch ends.
  6. Cannot-sell (ARCH 8.6): `token_program_refusal` once; or 3 consecutive `unknown` failures on the swap instruction; or 2 consecutive failed combined sell simulations from M06 `pre_exit` screens (this ticket requests `withSellSim: true` after every failed exit attempt; the simulation never delays the next attempt, C-43); or our token account frozen (M06/M22 read). Never counted: `slippage`, `compute_exceeded`, `insufficient_funds_fee`, `account_state`, `balance_mismatch`, `venue_disabled`, `blockhash_expired`, `exceeds_real_vault` (step 5). On cannot-sell → `stuck`, mint blacklisted (M05), venue blocked for entries if venue-wide.
  7. Rung 5: 3 consecutive counting failures → cannot-sell evaluation (`stuck`).
  8. Escalation alerts: rung 3 warning, rung 4 critical, `stuck` critical.
- **Shared resources and concurrency:** Pure function of config plus per-position counters (owned here).
- **Config:** `m20.ladder` (table above; each rung's slippage `affectsReturns: true`; raising any value is A3, lowering A1, via M25/M26); `m20.slippage_hard_ceiling_bps` (2,500, ceiling file).
- **Edge cases and failure handling:** Every rung failed and venue disabled → `stuck` with alert; no infinite loop (ARCH 16.5 "Venue disables sell").
- **Acceptance criteria:**
  1. Given rung 2 for a $10 position (entry cap = min(50,000, 20 bps × 66,666,667 = 133,333) = 50,000 lamports; DERIVED), then the rung-2 priority budget is 100,000 lamports (CU price = 100,000 × 10^6 / CU limit) and tips are 6,000.
  2. Given 3 `compute_exceeded` failures, then no cannot-sell.
  3. Given one `token_program_refusal`, then `stuck` and the mint is blacklisted.
  4. Given the drained-pool fixture (17.58 SOL virtual, 0.27 SOL real quote [RS-17]) and a position whose full sell would pay out more than the real vault less the LP fee, then the first attempt sells the margined size of step 5 (never above `maxSellableBase`), the quote does not throw, no cannot-sell counter moves, the position stays open with the remainder, and a later snapshot with a refilled vault sells the rest.
  5. Given `maxSellableBase` = 0, then no attempt is sent, a critical alert is raised and the position is not marked `stuck`.
  6. Given rung 1 (100 bps) on the drained-pool fixture, then the attempt's base amount `b` satisfies `out(b) − lpFee(b) ≤ 0.99 × realQuoteVault` and `b + 1` does not, and `b` ≤ ⌊0.99 × `maxSellableBase`⌋ + 1 (output is concave in input, so the output-terms margin is never smaller than a base-terms one; ±1 base unit for the round-up of `lpFee` and the round-down of `out`).
  7. Given three failed sells in a row whose failing instruction is the PumpSwap sell and whose prior snapshot shows the real vault below the gross output less the LP fee, then they are `exceeds_real_vault`, no cannot-sell counter moves and the position is not `stuck`; given a failed sell that is a `token_program_refusal`, then it is classed so even if the vault is short, and the position is `stuck`; given a failing instruction that is not the PumpSwap sell, then it is not `exceeds_real_vault`.
  8. Given 5 `exceeds_real_vault` refusals in a row, then a critical alert is raised and no re-send happens until a snapshot shows the vault above the next margined output; and the 5 attempts' fees and tips appear as `stuck_cost` for that position.
  9. Given an MR-01 position (`T` = 30 min) in the 5-refusal pause for 23 h, then it is not yet `stuck` (`T_drained` = 24 h); after 24 h with a margined size of 1,000 base units, then one last sell of 1,000 is sent and its real proceeds are booked, the position becomes `stuck`, the rest is valued at 0 and written off, the SOL loss is booked, `MAXOPEN` frees one slot so a new entry can pass, and a critical alert is raised; with a margined size of 0, no sell is sent and the whole position is written off.
  10. Given a `stuck` position whose pool's vault refills on day 3, then the hourly re-quote finds a margined size above 0, a recovery sell runs and its proceeds are booked through M22's ledger as realised proceeds (a recovery) in SOL; given no refill within 7 days, then the re-quotes stop; given the re-quotes, then they use P4 reads only, inside the ≤ 50% budget.
- **Tests:** unit (table, classification counters, real-vault sizing on `fx/pumpswap/drained_pool.json`); property (no sequence of non-counting failures produces `stuck`); worst-case fee sum equals ARCH 8.7's ≈ 3,000,000 lamports per position (shared constant with M22's float).
- **Observability:** metrics `exit_rung_total`, `cannot_sell_total` (cause); log codes `m20.rung_escalated`, `m20.stuck`.
- **Security notes:** None.
- **Facts used:** LD-02, LD-17, LD-22, EX-25, TH-02, TH-08, TH-10, VF-05.
- **Definition of done:** Common DoD; ladder table exported; a unit test asserts the ladder's worst-case fees per position ≤ M22's configured `m22.float_per_position_lamports` (B-M22-01 reads the float from config, so B-M22-01 does not build-depend on this ticket; integration cycle break).

#### B-M20-05 — Operator actions, exit leases and sentinel fill import

- **Module:** M20 · **Size:** M (~1.5 engineer-days) · **Phase:** 2 (close, flatten, write-off), 3 (lease, import)
- **Goal:** Implement `close`, `flattenAll`, `writeOff`, lease-aware exit gating and `importSentinelFills` (ARCH 7.6 step 5, CA-13).
- **Depends on:** B-M20-04. Group B: M17 lease status via B-M19-06 `SignerClient` (live only), M22 `written_off` list, M23 journal.
- **Interfaces:** `PositionManager.close`, `flattenAll`, `writeOff`, `importSentinelFills` (ARCH M20).
- **Logic:**
  1. `close(positionId, reason, maxSlippageBps)`: allowed for non-terminal, non-`stuck` positions; creates (or returns the existing) exit intent with `maxSlippageBps` ≤ 2,500; reason `manual_close`.
  2. `flattenAll(maxSlippageBps, reason)`: every open position enters the ladder at rung 2 (ARCH 8.6); returns per-position results; positions whose lease the engine does not hold are listed with `error = 'leased_to_sentinel'`.
  3. `writeOff(positionId, actor)`: only `stuck`; → `written_off`, journal row with proceeds 0, M22 `written_off` list, candidate cooldown then blacklist (ARCH 7.4).
  4. Leases: at engine start M26 acquires `all` (non-force). Any `E_LEASE` from the signer → stop all exit work for that mint (or all), alert, wait for `release-lease`; never re-arm leased mints until released (CA-13). The engine polls `SignerClient.status()` every 5 s to learn lease changes.
  5. `importSentinelFills(file)`: read `/var/lib/sentinel/fills.ndjson` (sentinel-owned, group-readable by `bot`); each line `{ signature, mint, sellBase, solDeltaLamports, feeLamports, tipLamports, slot, atMs }`; verify each signature by fetching the transaction (version 1) and recomputing deltas (never trust the file alone); insert fills keyed by signature (unique, idempotent); positions with zero remaining balance → `closed` with `exit_reason = sentinel_flatten`. Returns the count. After a full import M26 asks the operator to run `botctl release-lease` (manual by default, CL-23).
- **Shared resources and concurrency:** Position records (M20); sentinel journal (owner M29, read-only here); fills keyed by signature prevent double import.
- **Config:** `m20.lease_poll_ms` (5,000).
- **Edge cases and failure handling:** Journal line whose transaction cannot be fetched → kept pending, retried, alert; never imported unverified. Fill for a mint with no position (sentinel sold an orphan) → booked against a recovered orphan position (`source = 'sentinel'`).
- **Acceptance criteria:**
  1. Given the sentinel flattened 2 positions while the engine was down, when the engine imports, then both positions are `closed` with `sentinel_flatten`, fills have `source = 'sentinel'`, and a second import adds nothing (ARCH 16.5 "Engine down 130 s").
  2. Given `E_LEASE` on an exit, then no further attempts for that mint are built until the lease is released.
- **Tests:** unit; integration with a recorded sentinel journal and fixture transactions (`FX-SENTINEL-JOURNAL`); takeover drill (checklist 3c) end to end with B-M29-02.
- **Observability:** metrics `sentinel_fills_imported_total`, `lease_holder` (engine/sentinel); log codes `m20.lease_lost`, `m20.sentinel_import`.
- **Security notes:** The sentinel file is treated as untrusted input; every line is verified against chain data.
- **Facts used:** LD-05, DA-08.
- **Definition of done:** Common DoD; checklist item 3c passes.

---

### M21 Risk engine

Shared interface (exact copy of ARCH M21): `RiskDecision`, `RiskEngine` (`evaluate`, `preSendCheck`, `exitFeeMode`, `onFill`, `onMark`, `onCashFlow`, `limits`, `breakers`, `requestHalt`). All percentage limits use `E` (ARCH 1.5); the binding value is always the **lower** of the percentage of `E` and the lamport ceiling from `/etc/bot/ceilings.json`. Raising any value is A3, lowering A1 (ARCH 8). No ticket in this section may loosen a value below; config validation enforces each ceiling.

#### B-M21-01 — Limit registry, binding values, breaker registry and VM-12 state

- **Module:** M21 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** One registry of every limit in ARCH 8.1-8.2 with its unit, display unit, per-mode value, ceiling, binding rule, usage, state and action on breach, and of every breaker, producing `LimitState[]` and `BreakerState[]` for VM-12.
- **Depends on:** B-M25-01, B-M24-02.
- **Interfaces:** `LimitState`, `BreakerState` (ARCH 5.0a). Internal:

```ts
interface LimitDef { limitId: string; shortCode: string; label: string; scope: LimitState['scope']; kind: string; unit: LimitState['unit'];
  displayUnit: LimitState['displayUnit']; pctOfEBps: { live_small: Bps | null; live: Bps | null }; absolute: { live_small: bigint | null; live: bigint | null };
  ceiling: bigint | null; actionOnBreach: LimitState['actionOnBreach']; editable: boolean; configKey: string }
interface LimitRegistry { binding(limitId: string, mode: Mode, E: Lamports): bigint; defs(): LimitDef[]; state(): LimitState[] }
```

- **Logic:**
  1. Definitions (values from ARCH 8.1/8.2; `E_ref` = 6,666,666,667 lamports): `MAXPOS` (min(1.0% E, 66,666,667) live-small; min(2.5% E, ceiling) live; ceiling 350,000,000; `block_entries`); `MAXRISK` (0.25% / 0.5% E; ceiling 50,000,000; `reduce_size`); `MAXRISK_PF` (0.5% / 1.5% E; ceiling 150,000,000; `reduce_size`); `DEPTHPCT` (50 bps of min(effective, real) quote; `reduce_size`); `MAXOPEN` (2 / 3; ceiling 5; `block_entries`); `MAXEXP` (2% / 7.5% E — 2% in live until D26 (ii) or (iii) is recorded in config, gate LS-7; ceiling 1,000,000,000; `block_entries`); `ENTRYRATE` (1 MR entry per 10 min; `pause_entries`); `REGIME` (`pause_entries`); `PERTOKEN` (1; ceiling 1; `block_entries`); per-token entries per UTC day (3; ceiling 5); `HOTCAP` (500,000,000 / min(15% E, 1,000,000,000); ceiling 1,500,000,000; `alert_only` here, enforced by M22 sweep, M26 promotion guard and the signer); `SIGNERDAY` (display only; enforced by the signer); `DAYLOSS` (2% / 3% E; `block_entries`); `WEEKLOSS` (6% E; `halt`); `DDHALF` (10%; `reduce_size`); `DDKILL` (15%; `demote`); `FEEDAY` (2,000,000 / 5,000,000 lamports; `block_entries`); fixed-cost burden (2% warning / 3% critical; `alert_only`, P-9 blocks promotion).
  2. Paper mode evaluates the limits of the **target live mode** (`m21.paper_limits_profile`, default `live_small`) so paper results reflect intended live sizing (gate B-7/R-5/P-4 "at intended live sizing") (CL-36).
  3. Binding = min(pct × E / 10,000, absolute, ceiling), ignoring nulls; `E` from M22 `balances().equityLamports`.
  4. State thresholds (POLICY, CL-37 as changed at integration to match the UI's C28 LimitMeter): `normal` < 70% usage, `elevated` 70-90%, `near` 90-100%, `breached` ≥ 100% (or tripped), `disabled` when the operator disabled a limit (only lowering-risk limits can be disabled; disabling a limit is A3 per UI action classes).
  5. Display units (UC-05): lamport limits in `sol` (≤ 9 decimals), bps limits in `bps` or `pct`, counts in `count`, durations in `minutes`.
  6. Breakers: `LOSSRUN`, `EXECERR`, `LANDING`, `COST`, `RECON`, `DAYLOSS`, `WEEKLOSS`, `DDKILL` with `requiresManualReset` per ARCH 8.2.
- **Shared resources and concurrency:** Owner of limit definitions and usage, breaker states (ARCH 7.2). Changes only via M26 commands (`update_limit`, `reset_breaker`) with `command_id`.
- **Config:** every limit's value is a `m21.*` key with `riskDirectionOnIncrease = increases_risk` (a larger cap, count or loss limit always allows more risk), `affectsReturns: true`, `requiresRestart: false`; ceilings from `/etc/bot/ceilings.json` (root-owned; M25).
- **Edge cases and failure handling:** `E` unavailable (unreconciled) → entries blocked (ARCH M21 failure modes); limits report `usage = null`.
- **Acceptance criteria:**
  1. Given `E` = 6,666,666,667 in live-small, then `MAXPOS` binding = 66,666,667 and `MAXRISK_PF` binding = 33,333,333.
  2. Given `E` = 20 SOL in live, then `MAXPOS` binding = min(500,000,000, 350,000,000) = 350,000,000.
  3. Given an `update_limit` above the ceiling, then validation rejects it (`E_CEILING`).
- **Tests:** unit (binding table for 5 equity levels × 2 modes); property (binding ≤ ceiling always). Clarification C-62 (A11): property test, doubling or halving SOL/USD leaves every limit unchanged.
- **Observability:** metrics `limit_usage_bps` (limit), `breaker_tripped` (breaker); log code `m21.limit_state`.
- **Security notes:** Ceilings are root-owned; the API cannot raise them (ARCH M25).
- **Facts used:** ST-38, ST-39 (sizing rationale, ARCH 3.5).
- **Definition of done:** Common DoD; VM-12 fixture produced by B-M28-03 from this registry validates.

#### B-M21-02 — `evaluate`: sizing, stressed and correlated risk, exposure and screening verdict

- **Module:** M21 · **Size:** L (~2.5 engineer-days) · **Phase:** 2
- **Goal:** The synchronous pre-trade decision (≤ 5 ms) for every `SignalProposal`, producing `RiskDecision` with every applicable check in VM-07 shape, sizing the entry to the binding limits, the stressed loss and the correlated bucket (CA-18).
- **Depends on:** B-M21-01, B-M22-01, B-M20-01. Group A: M09 `SignalProposal`, `ExitPlan`; M06 `ScreenResult` (`purpose: 'pre_entry'`), `RiskCheck`; M04 `PoolSnapshot`; M01 `Quote`; A-M10-04 `SimCore.estimateRoundTripCostBps` and `stressedGapBps(strategyId)` (C-24; replaces CL-38's `gapThroughStopP99Bps`); A-M10-03 cost constants; M13 `StrategyContext.edgeEstimate` (live sizing).
- **Interfaces:** `RiskEngine.evaluate(p, ctx): RiskDecision` (ARCH M21).
- **Logic (checks in this order; all are recorded in `checks[]`, including skipped ones with `skippedReason`; any `error` blocks the entry, VM-07 rule):**
  1. Trading state `running`, mode is `paper`/`live_small`/`live`, the strategy is enabled for the mode and its stage allows the mode (`paper_passed` or later for live; M13 stage via M26) → else `rejected`.
  2. Screen: `verdict == 'eligible'`; authority/extension checks ≤ 5 s old (ARCH 8.5; M06 re-reads at entry); every hard check passed; failed soft checks are copied as `warn`. Any hard `error` → `rejected`.
  3. Freshness: decision snapshot `observationLagSlots ≤ 12` (`stale_pool`); bar completeness is enforced by M09/M08 (no entries from incomplete bars).
  4. Fee ceiling and depth: `feeTotalBps` ≤ strategy ceiling (MR 30, PM 125); effective quote ≥ strategy minimum (MR 300 SOL, PM 85 SOL); real/effective ratio ≥ 0.5 (MR) / 0.6 (PM) (ARCH 8.4; duplicated here from M06 so a stale screen cannot pass them).
  5. Size: `n = min(requested, MAXPOS binding, DEPTHPCT × min(effective, real) quote)`; if `DDHALF` active, `n = n / 2` (floor); live mode: if `edgeEstimate.lowerCiNetBps ≤ 0` or null → `rejected` (`no_live_edge`; ARCH 3.5) — the Kelly computation itself is in the strategy's `sizing` (M09), M21 only caps.
  6. Stressed loss (ARCH 3.5): `stress = max(|stopBps|, stressedGapBps(strategyId).p99Bps)`; A-M10-04 returns the 2,000 bps prior (`source = 'prior'`) until an empirical p99 from ≥ 50 stop exits is frozen into the parameter set at `replay_passed` (`source = 'empirical'`), so this ticket never substitutes its own prior; `costBps = estimateRoundTripCostBps(snapshot, n, 'lean')`; `stressedLoss = ceil(n × (stress + costBps) / 10,000)`. If `stressedLoss > MAXRISK` → shrink `n` to fit; if `Σ stressedLoss(open) + stressedLoss(new) > MAXRISK_PF` → shrink to fit; shrinking below `min_notional_lamports` → `rejected` (CL-39).
  7. Counts and exposure: `MAXOPEN`; `MAXEXP` at entry cost (Σ entry cost of open positions + n + reservations); PERTOKEN (no non-terminal position or intent for the mint; M19 re-enforces); per-token entries today ≤ 3.
  8. Rate and regime (B-M21-03) and loss breakers (B-M21-04): any active block → `rejected` with its code.
  9. Output: `approvedNotionalLamports = n`, `stressedLossLamports`, `maxSlippageBps` = strategy entry slippage (MR 50, PM 150; ceiling 300), `maxPriorityFeeLamports = min(50,000, floor(n × 20 / 10,000))` (ARCH 1.4, 8.3), `decision = 'accepted'`.
  10. Any thrown error inside `evaluate` → `decision = 'error'` (blocks the entry; ARCH M21).
- **Shared resources and concurrency:** Reads M22 balances/reservations and M20 positions synchronously from in-memory caches; owns decision records (`signal` table, written once).
- **Config:** strategy-scoped thresholds (`m21.mr.*`, `m21.pm.*`), `m21.stress_prior_bps` (2,000), `m21.min_stop_exits_for_p99` (50), `m21.min_notional_lamports` (33,333,333 ≈ $5 at `P_SOL`; stricter-only, CL-39). All `affectsReturns: true`.
- **Edge cases and failure handling:** M10 p99 unavailable → prior; `E` not reconciled → `rejected` (`unreconciled`).
- **Acceptance criteria:**
  1. Given live-small, `E = E_ref`, stop 400 bps, prior stress 2,000 bps, cost 70 bps and a requested 66,666,667: stressed loss = ceil(66,666,667 × 2,070 / 10,000) = 13,800,001 ≤ `MAXRISK` 16,666,667, so the size passes `MAXRISK`; with one open position of stressed loss 20,000,000, `MAXRISK_PF` (33,333,333) leaves 13,333,333, so the size shrinks to floor(13,333,333 × 10,000 / 2,070) = 64,412,236 (stressed loss 13,333,333) and is accepted at that size (DERIVED; the cost bps is held fixed in this example).
  2. Given a hard screen check with status `error`, then `rejected` and the check appears in `checks[]` with status `error`.
  3. Given 200 random proposals, then `evaluate` p99 ≤ 5 ms on the target host class.
- **Tests:** unit (each check; worked examples); property (ARCH 16.2: no sequence of accepted entries exceeds `MAXOPEN`, `MAXEXP`, `MAXRISK_PF`, `ENTRYRATE`, `PERTOKEN`, `FEEDAY`); benchmark. Clarification C-71 (A23): exposure counts exit costs; size grows only from realised SOL.
- **Observability:** metrics `decisions_total` (decision, reason), `decision_latency_ms`, `stressed_risk_lamports`, `exposure_lamports`; log code `m21.decision`.
- **Security notes:** None.
- **Facts used:** ST-04, ST-38, ST-39, EX-07, EX-V01, TH-30 (rationale for thresholds via ARCH 8.4).
- **Definition of done:** Common DoD; VM-07 `risk_checks[]` fixtures from real decisions validate against `@bot/contract`.

#### B-M21-03 — Entry-rate limit, market-regime filter and freshness and clock gates

- **Module:** M21 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** Implement `ENTRYRATE` (≤ 1 MR entry per 10 min), `REGIME` (block MR entries while SOL/USD 30-min return < −3% or the watched-pool basket 30-min return < −5%; SOL/USD used only to block, D20) and the system-level entry gates (provider degraded mode, blockhash unavailable, clock offset).
- **Depends on:** B-M21-02. Group A: M08 `Features.basketReturn(30 min)`; M14 `mode()`; group B: M23 `price_reference` (SOL/USD), M15 `entriesAllowed()`, M27 `clock.ntpOffsetMs`.
- **Interfaces:** internal `EntryGates { check(strategyId: string, nowMs: UnixMs): RiskCheck[] }`.
- **Logic:**
  1. `ENTRYRATE`: count accepted MR entries (decisions with `accepted` that produced an intent) in the trailing 10 min; ≥ 1 → `pause_entries` until the window passes.
  2. `REGIME`: SOL/USD 30-min log return from M23 price references (1/min; needs ≥ 25 points in the window, else the check is `error` → blocks MR entries); basket return from M08 (null → `error`). Either below threshold → block.
  3. System gates: M14 `degraded_reads` → block (`degraded_reads`); M15 `entriesAllowed() == false` → block (`blockhash_unavailable`); `|ntpOffsetMs| > 2,000` → block, `> 500` → alert only (ARCH 8.5); all providers down → block.
- **Shared resources and concurrency:** Read-only inputs.
- **Config:** `m21.entryrate_window_ms` (600,000; `affectsReturns: true`); `m21.regime_sol_drop_bps` (300); `m21.regime_basket_drop_bps` (500); `m21.clock_block_ms` (2,000); `m21.clock_alert_ms` (500).
- **Edge cases and failure handling:** Price source missing (Jupiter and CoinGecko both failing) → regime check `error` → MR entries blocked (stricter); PM entries unaffected by the SOL/USD part (CL-40: ARCH defines REGIME for MR entries).
- **Acceptance criteria:** Given an MR entry accepted at t, then a second MR proposal at t + 9 min is rejected with `ENTRYRATE` and one at t + 10 min 1 s is not; given SOL/USD −3.2% over 30 min, MR entries are blocked; given clock offset 2.5 s, all entries are blocked (ARCH 16.5 "Clock skew 3 s").
- **Tests:** unit; property (no two accepted MR entries within 10 min).
- **Observability:** metrics `regime_blocked` (source), `entryrate_blocked_total`.
- **Security notes:** None.
- **Facts used:** DA-29, DA-27 (price sources via M23).
- **Definition of done:** Common DoD.

#### B-M21-04 — Flow-adjusted equity, loss limits, breakers and automatic halt and demotion triggers

- **Module:** M21 · **Size:** L (~2.5 engineer-days) · **Phase:** 2
- **Goal:** Compute flow-adjusted (time-weighted) equity, daily loss, weekly loss and drawdown so sweeps, refills and withdrawals are never read as gains or losses (CA-17), and run every breaker of ARCH 8.2 plus the automatic triggers L-1, L-2 and L-4.
- **Depends on:** B-M21-01, B-M22-03. Group A: A-M13-07 `sequentialMonitor(strategyId)` (L-1) and topic `research.cusum_alarm`; A-M01-05 `FeeScheduleChanged` (topic `venue.fee_schedule_changed`), A-M02-05 `decoder.unknown_layout` quarantine events (L-4 venue regime markers); A-M13-04 `flowAdjustedStep` (single formula, integration). Group B: B-M23-02 closed trades (LOSSRUN, L-1). Group B: M26 `requestHalt` handling and demotion command path.
- **Interfaces:** `RiskEngine.onFill`, `onMark`, `onCashFlow`, `requestHalt`; exported for M13 (CL-35):

```ts
interface FlowAdjustedEquity { indexNow(): { index: number; equityLamports: Lamports; atMs: UnixMs }; peakIndex(): number;
  drawdownBps(): Bps; pnlSince(tMs: UnixMs): SignedLamports /* E_now − E_t − net boundary-crossing flows in (t, now] */ }
// integration: implemented on top of A-M13-04 flowAdjustedStep; M13 receives values through EquitySeries.recordMinute (it does not recompute them)
```

- **Logic:**
  1. Equity `E` from M22 every second and on every mark/fill/flow. Flow-adjusted index (integration decision C-35/CL-35): `I_0 = 1`; at each update `I_t = I_{t−1} × (E_t − CF_t) / E_{t−1}` computed with A-M13-04's pure `flowAdjustedStep`, where `CF_t` = net cash flows since the previous update **across the boundary of `E`**: `refill` and `sweep` count only if the cold wallet is not part of `E` (`analytics.equity.includes_cold`, which must equal M22's setting); `sim_funding` is internal (the simulation payer is in `E`); `external_in`/`external_out` always count. Peak = max index; drawdown = `(I/peak − 1) × 10,000` bps. This ticket holds the **single live/paper instance**; once per minute it calls A-M13-04 `EquitySeries.recordMinute(atMs, mode, E, index, drawdownBps)` so `equity_point` stores exactly the values the breakers used.
  2. `DAYLOSS` usage = `max(0, −pnlSince(00:00 UTC))` (realised + unrealised at exit-quote marks, flow-adjusted; VM-12 definition). Breach → block entries; auto reset 00:00 UTC.
  3. `WEEKLOSS` usage = `max(0, −pnlSince(now − 7 days))` (rolling 7 × 24 h, CL-41); breach → HALT (`requestHalt('risk_engine', 'WEEKLOSS', false)`), critical; manual reset.
  4. `DDHALF`: drawdown ≥ 10% → all new sizes × 0.5; cleared when drawdown < 5%.
  5. `DDKILL` (L-2): drawdown ≥ 15% → HALT and demotion to paper (A1 by `risk_engine` through M26; cooldown 7 days; positions keep exits); manual review.
  6. `LOSSRUN`: 5 consecutive losing closed trades (net PnL < 0) → pause entries 60 min, auto.
  7. Execution errors: 3 entry failures of class `slippage`, `unknown` or `token_program_refusal` within 10 min → pause 15 min (ARCH 7.3a, 8.2).
  8. Landing breaker: landing rate (confirmed within 20 slots of first send) < 60% over the last 20 attempts → pause 15 min + alert; 3 trips in a UTC day → manual reset.
  9. Cost breaker (L-3): realised explicit cost > 1.5 × modelled over the last 50 trades (M23 `cost_model_error`) → block entries, manual.
  10. Reconciliation breaker: from M22 (SOL diff > 10,000 lamports after cash flows classified, or an `ours` token discrepancy) → block entries; auto when reconciled.
  11. L-1: subscribe to `research.cusum_alarm` (A-M13-07) and poll `sequentialMonitor` after each closed trade in `live_small` **and** `live` (C-36: the CUSUM also runs in live-small); `alarm` → demotion to paper (A1, actor `risk_engine`).
  12. L-4: `FeeScheduleChanged` (topic `venue.fee_schedule_changed`), a quarantine of an allowlisted program's discriminator, or a new mandatory account detected → demotion to paper until replay revalidates.
  13. Every trip, automatic demotion or breaker change notifies M26, which cancels pending A3 commands (CA-19).
- **Shared resources and concurrency:** Owner of the daily-loss ledger and breaker states (ARCH 7.2). Inputs arrive on the event loop.
- **Config:** thresholds per ARCH 8.2 (`m21.dayloss_pct_bps`, `m21.weekloss_pct_bps`, `m21.ddhalf_bps`, `m21.ddhalf_clear_bps`, `m21.ddkill_bps`, `m21.lossrun_n`, `m21.execerr_n`, `m21.execerr_window_ms`, `m21.landing_min_bps`, `m21.landing_window`, `m21.cost_ratio_x100`, `m21.cost_window`); all `affectsReturns: true`.
- **Edge cases and failure handling:** Rent deposits of open positions reduce `E` until refunded (conservative; counted as temporary loss, CL-42). Flow of unknown classification (`external_out`) → still excluded from PnL but raises a reconciliation alert (M22).
- **Acceptance criteria:**
  1. Given a sweep of 0.3 SOL to cold during the day, then `DAYLOSS` usage and drawdown are unchanged (ARCH 16.2 flow-adjustment property; ARCH 16.5 "Daily sweep larger than the signer day cap").
  2. Given 5 consecutive losing trades, then entries pause for 60 min and resume automatically.
  3. Given drawdown 15.1%, then HALT, demotion to paper and cancellation of any pending A3 command.
- **Tests:** unit; property (random interleavings of trades, sweeps, refills and transfers give the same drawdown and daily loss as the trades alone; ARCH 16.2); integration with M26. Clarification C-62 (A11): property test, doubling or halving SOL/USD leaves the SOL P&L, equity and every loss limit unchanged.
- **Observability:** metrics `equity_lamports`, `daily_loss_used_lamports`, `drawdown_bps`, `breaker_tripped`; log codes `m21.breaker_trip`, `m21.auto_demote`.
- **Security notes:** None.
- **Facts used:** ST-39 (de-risk on drawdown), ST-33 (why L-1 is slow; fast brakes are DAYLOSS/WEEKLOSS/DDKILL).
- **Definition of done:** Common DoD; the only flow-adjustment formula in the repository is A-M13-04's `flowAdjustedStep` (grep check); `equity_point` rows are written only through `EquitySeries.recordMinute` from this ticket (live/paper) or from imported runs (A-M13-08).

#### B-M21-05 — `preSendCheck`, `FEEDAY` (entries only), exit fee mode and the fixed-cost ceiling

- **Module:** M21 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** The last in-process check before signing: buys are checked again for halt, mode, caps, staleness and fee spend; exits are never refused for fees or caps (CA-08); expose `exitFeeMode`; enforce the fixed-cost ceiling alert and its promotion block input (CB-03).
- **Depends on:** B-M21-04. Group B: M23 daily fee spend and fixed-cost items; M26 trading state.
- **Interfaces:** `preSendCheck(i: OrderIntent): Result<true, { code: string }>`; `exitFeeMode(): 'normal' | 'minimum'`; `fixedCostBurdenBps(): Bps | null`.
- **Logic:**
  1. Exits (`side == 'sell'`): always `ok` (CA-08).
  2. Buys: trading state `running` (`E_HALTED`); mode matches the intent's mode; current binding limits still satisfied with current usage (`MAXOPEN`, `MAXEXP`, `MAXRISK_PF`, PERTOKEN) (`E_CAP`); data freshness (blockhash, degraded reads, clock) (`E_STALE`); `FEEDAY`: today's base + priority + tips of **all** our transactions (entries, exits, janitor, sweeps; stricter reading, CL-43) + this entry's maximum fee budget ≤ the mode's cap (2,000,000 live-small; 5,000,000 live) (`E_FEEDAY`).
  3. `exitFeeMode()` = `'minimum'` once today's spend exceeds `FEEDAY`; exits then use their rung's minimum priority and tips and a critical alert is raised once per day ("Fee cap exceeded, exits in minimum mode").
  4. Fixed-cost burden = monthly fixed cost (M23 active `fixed_cost_item` sum, converted to lamports at the current SOL/USD) × 10,000 / `E`. ≥ 200 bps → warning; > 300 bps in a live mode → critical alert and M26 promotion guard blocked (P-9 is evaluated by M13 with the same number).
- **Shared resources and concurrency:** Reads only.
- **Config:** `m21.feeday_live_small_lamports` (2,000,000), `m21.feeday_live_lamports` (5,000,000), `m21.fixed_cost_warn_bps` (200), `m21.fixed_cost_max_bps` (300); all ceilinged.
- **Edge cases and failure handling:** SOL/USD unknown → fixed-cost burden `null` → treated as breached for promotion (stricter) and a warning.
- **Acceptance criteria:** Given `FEEDAY` exhausted with 3 positions needing exits, then exits pass `preSendCheck`, `exitFeeMode()` = `minimum`, a critical alert exists and entries are rejected `E_FEEDAY` (ARCH 16.5 CA-08 row).
- **Tests:** unit; property ("no fee or spend cap ever rejects an exit"). Clarification C-71 (A23): entries pause when the fixed cost exceeds `k`% of the stake.
- **Observability:** metrics `fee_spend_today_lamports`, `fixed_cost_burden_bps`.
- **Security notes:** None.
- **Facts used:** LD-35, LD-V07 (fixed-cost context via ARCH 1.4).
- **Definition of done:** Common DoD.

#### B-M21-06 — Entry pipeline orchestration (proposal → screen → snapshot → quote → evaluate → record → submit → open)

- **Module:** M21 (orchestration owned by the risk engine; added at integration because no ticket owned the end-to-end entry path) · **Size:** S (~1 engineer-day) · **Phase:** 1 (sim, needed by A-M11-02), 2 (paper)
- **Goal:** Turn each `SignalProposal` into exactly one recorded `RiskDecision` and, when accepted, one buy intent and one `opening` position, in the order ARCH 4.2 and 10.1 give, in every mode (backtest, replay, paper, live) through the same code path (ARCH 9.2).
- **Depends on:** B-M21-02, B-M19-02, B-M20-01. Group A: A-M09-01 (topic `signal.proposal`), A-M06-01 (`screen(…, { purpose: 'pre_entry' })`), A-M04-02 (`freshRead`, entry grade), A-M01-03 (`quoteExactIn`, `minOut`), A-M07-02 (`Recorder.append` for the `decision` stream).
- **Interfaces:** internal `EntryPipeline { onProposal(p: SignalProposal): Promise<{ decisionId: Id; intentId: Id | null }> }`; publishes topic `risk.decision` `{ decisionId, strategyId, poolId, mint, decision: 'accepted' | 'rejected' | 'error', reasons: Array<{ code: string; message: string }>, intentId: Id | null, atMs }` (consumed by A-M05-01 step 6: `signalled` → `watched` on reject, → `in_position` on accept; by B-M28-03 for VM-07).
- **Logic:**
  1. Subscribe to `signal.proposal`. Drop a proposal when trading state is not `running` (recorded as `rejected`, reason `halted`) — HALT never blocks exits, which do not use this path.
  2. `screen(mint, poolId, { purpose: 'pre_entry' })` (A-M06-01); then `freshRead(poolId, 8)` (entry grade, C-09; `E_STALE` → decision `rejected`, reason `stale_pool`); then `quoteExactIn(snapshot.pool, 'buy', requested)` (A-M01-03).
  3. `RiskEngine.evaluate(p, { screen, snapshot, quote })` (B-M21-02). Record the decision in one transaction: the `signal` row (ARCH 15), `Recorder.append('decision', …)` (A-M07-02, so replays reproduce it), and the outbox event `risk.decision`.
  4. Accepted → `OrderManager.submit({ side: 'buy', amountIn: approvedNotionalLamports, minOutBps, maxSlippageBps, reason: 'entry', urgency: 'normal', … })` (B-M19-02); `E_PERTOKEN`/`E_RESERVE`/`E_HALTED`/`E_DUPLICATE` → decision amended by a new `risk.decision` event `rejected` with that code (append-only). Success → `PositionManager.open(intent)` (B-M20-01) in the same transaction as the intent (the position starts `opening`).
  5. Latency: steps 1-4 are timed as segment 3 of ARCH 10.1 (`decision_latency_ms`, VM-07).
- **Shared resources and concurrency:** No new state; uses the owners' interfaces. One in-flight proposal per `(strategyId, poolId)`; a second proposal for the same pair while one is being processed is recorded as `rejected` reason `in_flight`.
- **Config:** none beyond the owners' keys.
- **Edge cases and failure handling:** screen `error` → decision `error` (blocks entry, VM-07 rule); quote error (`E_FEE_UNKNOWN`, `E_NEGATIVE_EFFECTIVE`) → `rejected`; any exception → decision `error`, alert `execution` warning, never a submit.
- **Acceptance criteria:** Given a proposal for a pool with a stale snapshot (lag 11 slots), then exactly one decision `rejected` (`stale_pool`) is recorded and no intent exists; given an accepted proposal, then the `signal` row, the recorder `decision` record, one buy intent and one `opening` position exist, and A-M05-01 moves the candidate to `in_position`; given the same proposal replayed from a recorded day, then the identical decision is produced (determinism, ARCH 9.2).
- **Tests:** unit with fakes; integration with A-M11-02's simulated `ExecutionPort`; replay determinism test.
- **Observability:** metrics `entry_pipeline_ms` (segment 3), `proposals_total{decision}`; log code `m21.entry_pipeline`.
- **Security notes:** None (no key access; the signer still enforces its own buy rules).
- **Facts used:** none (orchestration only).
- **Definition of done:** Common DoD; A-M11-02 drives entries only through this pipeline.

---

### M22 Wallet, accounts and reconciliation

Shared interface (exact copy of ARCH M22): `Reservation`, `Wallet`, `ReconcileReport`; types `WalletBalances`, `CashFlow`, `TokenClass` from ARCH 5.0a.

#### B-M22-01 — SOL ledger, equity `E`, reservations and the exit fee float

- **Module:** M22 · **Size:** M (~2 engineer-days) · **Phase:** 2
- **Goal:** Maintain the per-wallet SOL and wSOL ledger (wSOL counted as SOL), compute `E` and `E_trade` exactly as ARCH 1.5 defines them, and own reservations, including the exit fee float that entries can never consume (CA-08, CA-16, CA-17).
- **Depends on:** B-M24-02, B-M25-01. Group B runtime inputs (not build dependencies): M20 marks (positions value), B-M15-03 rent. The float per position comes from config `m22.float_per_position_lamports` (floor 3,000,000); B-M20-04's DoD asserts the ladder's worst case fits it (integration: removes the cycle B-M22-01 → B-M20-04 → … → B-M22-01).
- **Interfaces:** `Wallet.reserve`, `release`, `exitFeeFloat`, `balances` (ARCH M22). Internal:

```ts
interface Equity { E(): Lamports; Etrade(): Lamports; components(): { hotSol: Lamports; hotWsol: Lamports; positions: Lamports; simPayer: Lamports; cold: Lamports | null } }
```

- **Logic:**
  1. `E` = hot SOL + hot wSOL + open positions at exit-quote value (M20 `Mark.exitValueEstLamports`) + simulation payer SOL (D31) + cold SOL if `cold_wallet_pubkey` is configured (read-only). `E_trade` = hot SOL + hot wSOL + positions (ARCH 1.5). Wallet roles for VM-04: hot = `trading`, simulation payer and cold = `reserve` with labels (UC-13).
  2. `reserve(intentId, lamports)`: unique per `intentId` (index); requires the ledger to be reconciled within the last 2 min and no reconciliation breach (`E_UNRECONCILED`); `available = sol + wsol − reserved − float`, floored at 0; the new reservation plus the float increment for the new position must fit in `available` (`E_FLOAT` if it would consume the float, `E_INSUFFICIENT` if it exceeds SOL even ignoring the float).
  3. Entry reservation amount (computed by M19 and passed in, checked here for a minimum): `amountIn + maxPriorityFee + baseFee + tips + ATA rent (rent for the base-mint ATA size at the current rate) + user_volume_accumulator rent on the first trade if the venue creates one (CL-06)`.
  4. `exitFeeFloat()` = (open positions + entries being reserved) × worst-case ladder fees per position (B-M20-04 constant, ≈ 3,000,000 lamports per position, ARCH 8.7). The float is reserved, never spent by entries; exits draw on it.
  5. `release(reservationId, actualSpent)`: idempotent on `reservationId`; records `actual_lamports`.
  6. Ledger updates come only from confirmed transactions (M18 results via M19) and reconciliation corrections (B-M22-03).
- **Shared resources and concurrency:** Owner of the SOL ledger view, reservations and the float (ARCH 7.2). Reservation row and ledger update in one `withTx`; unique index on `reservation(intent_id)`.
- **Config:** `m22.float_per_position_lamports` (derived from the ladder; floor 3,000,000; may only be raised); `m22.reconcile_max_age_ms` (120,000).
- **Edge cases and failure handling:** Hot wallet funded only with reservations, exit needs fees → the float pays (ARCH 16.5 CA-08 row). Float larger than SOL available (underfunded wallet) → entries blocked with `E_FLOAT` and an alert; exits still proceed.
- **Acceptance criteria:**
  1. Given hot SOL 0.1 SOL, 2 open positions and a float of 3,000,000 per position, when an entry asks to reserve 0.095 SOL, then `E_FLOAT` (it would cut into 9,000,000 lamports of float for 3 positions).
  2. Given two `release` calls for the same reservation, then the ledger changes once.
  3. Given a configured cold wallet holding 3 SOL, then `E` includes 3 SOL and `E_trade` does not.
- **Tests:** unit; property (reservations released exactly once; available never negative; sweeps never touch the float, ARCH 16.2).
- **Observability:** metrics `hot_balance_lamports`, `exit_fee_float_lamports`, `reserved_lamports`, `equity_lamports` (from M21), `sim_payer_balance_lamports`.
- **Security notes:** Public keys only; the cold wallet is read-only.
- **Facts used:** LD-13, LD-14, EX-13.
- **Definition of done:** Common DoD.

#### B-M22-02 — Token-account registry, token classes and fast ATA balance reads

- **Module:** M22 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** Own the ATA registry keyed by (owner, mint, token program), the `ours`/`unsolicited`/`written_off` classification (CA-14, CA-15), and the P0 `ataBalance` read used by M16 builds and M19 evidence polls.
- **Depends on:** B-M22-01. Group B: B-M16-02 `deriveAta`. Group A: M14 `RpcGateway.call`.
- **Interfaces:** `Wallet.tokenAccountFor`, `ataBalance`, `classify` (ARCH M22).
- **Logic:**
  1. `tokenAccountFor(mint, tokenProgram)` → `{ ata = deriveAta(hot, mint, tokenProgram), exists, rentLamports }` from the registry (updated only from confirmed transactions and reconciliation).
  2. `ataBalance(mint)`: one call at `confirmed`, P0. **VERIFY** `getTokenAccountBalance` (method and response fields; A-36). Account not found → `{ amountBase: 0n, slot }` (a missing ATA holds nothing).
  3. `classify(mint)`: `ours` if the registry has a fill of ours for the mint (`live`, `sentinel` or `recovered`); `written_off` if in that list; else `unsolicited`. Stored in `mint_class` with `since` and `set_by`.
- **Shared resources and concurrency:** Owner of the token-account registry and token classes (ARCH 7.2).
- **Config:** none.
- **Edge cases and failure handling:** RPC error → `Result` error; M16 exits retry; M19 evidence polls continue.
- **Acceptance criteria:** Given a mint with a live fill, then `classify` = `ours`; given an airdropped mint, `unsolicited`; given a written-off mint, `written_off`.
- **Tests:** unit; integration with `FX-RPC-TOKENBALANCE`.
- **Observability:** metric `ata_balance_latency_ms`.
- **Security notes:** None.
- **Facts used:** TH-03 (token account fields). VERIFY: A-36.
- **Definition of done:** Common DoD.

#### B-M22-03 — Reconciliation loop, cash-flow detection and orphan linking

- **Module:** M22 · **Size:** L (~2.5 engineer-days) · **Phase:** 2 (paper: ledger vs paper fills), 3 (live chain reconciliation)
- **Goal:** Every 30 s at `confirmed`, compare the ledger with the chain for SOL, wSOL and all token accounts of both token programs; classify every unexplained SOL movement as a typed cash flow; never turn unsolicited or written-off balances into positions; link `ours` balances without a position to `open_failed` entries before creating orphans (CA-14, CA-15, CA-17).
- **Depends on:** B-M22-02. Group A: M14, M02 (decode transactions found by signature search). Group B: M20 (positions), M19 (attempt terminality), signer log import (sweeps).
- **Interfaces:** `Wallet.reconcile(): Promise<ReconcileReport>`, `recordCashFlow`.
- **Logic:**
  1. Reads (P3, unmetered provider): `getBalance` of the hot wallet, the simulation payer and the cold wallet (if configured); `getTokenAccountsByOwner` of the hot wallet for SPL Token and for Token-2022 (**VERIFY** the filter parameters for both programs, A-31; ARCH 11.2 budget: 0.1 req/s).
  2. Token balances: for each mint, compare with the ledger: `ours` with a position → expected size; `ours` without a position → orphan candidate; `unsolicited` (new) → record class, info alert, never a position, never sold, never counted by the breaker; `written_off` → ignored. A non-zero wSOL balance → counted as SOL and scheduled for unwrap by the janitor.
  3. SOL: `diff = ledger − chain` after excluding attempts not yet terminal. Unexplained changes → page `getSignaturesForAddress` on the hot wallet since the last reconciled slot [DA-08], fetch each unknown transaction (version 1 [LD-05]) and classify: transfer to the configured cold address that the signer log lists → `sweep`; transfer from the cold address → `refill`; to/from the simulation payer → `sim_funding`; anything else → `external_in`/`external_out` and a `reconciliation` alert (CA-17). Cash flows are written with `source = 'chain_scan'` (or `signer_log` for sweeps) and passed to M21 `onCashFlow`.
  4. Orphans: for an `ours` balance with no position, search signatures since the last known slot to link it to an `open_failed` buy whose transaction landed → M20 reopens that position at its true cost basis; otherwise M20 creates an `orphan` (ARCH 7.4, 7.6 step 5). For positions with zero balance and no recorded exit, search the same history to find and decode the exit.
  5. Breaker: after all attempts are terminal and flows classified, `|diff| > 10,000` lamports, or an `ours` token discrepancy → M21 reconciliation breaker (block entries) and critical alert; cleared automatically when reconciled.
  6. Ledger cannot read the chain for 2 min → entries blocked (`E_UNRECONCILED`).
  7. Report persisted in `reconcile_run`; 30 s `wallet_snapshot` rows kept 30 days, daily rows 7 years.
- **Shared resources and concurrency:** Owner of reconciliation results, `cash_flow` records and token classes (ARCH 7.2). Positions are changed only through M20's interface.
- **Config:** `m22.reconcile_ms` (30,000; degraded mode 60,000); `m22.diff_tolerance_lamports` (10,000; ceiling 10,000).
- **Edge cases and failure handling:** 20 unsolicited mints airdropped → listed, no positions, no sells, no breaker, entries continue (ARCH 16.5); reconciliation shows a balance below the recorded size for an `ours` position → M20 adjusts size with a critical alert.
- **Acceptance criteria:**
  1. Given a refill of 1 SOL from the cold address, then a `refill` cash flow exists and `DAYLOSS` and drawdown are unchanged.
  2. Given an `ours` balance from an `open_failed` buy that actually landed, then the original position is reopened at the true cost basis and no orphan exists.
  3. Given an unexplained outgoing transfer of 0.05 SOL, then an `external_out` flow and a critical reconciliation alert exist.
- **Tests:** unit; integration with recorded wallet histories (`FX-WALLET-HISTORY-*`); failure injection rows CA-14, CA-15, CA-17 of ARCH 16.5.
- **Observability:** metrics `reconcile_diff_lamports`, `cash_flow_lamports_total` (kind), `unsolicited_mints`; log codes `m22.reconcile`, `m22.cash_flow`, `m22.orphan_linked`.
- **Security notes:** Third-party transactions found in history are data; nothing is executed or trusted beyond decoding.
- **Facts used:** DA-08, LD-05, DA-06 (Token-2022 accounts are not 165 bytes; filter by program, not size). VERIFY: A-31.
- **Definition of done:** Common DoD; checklist LS-5 measurable (daily reconciliation within 10,000 lamports).

#### B-M22-04 — Janitor, wSOL unwrap, sweeps and unsolicited-token closes

- **Module:** M22 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Close zero-balance ATAs to recover rent (CA-29), unwrap stray wSOL, sweep excess hot SOL to cold daily and on demand (leaving float, reservations, rent and a 0.01 SOL buffer), and execute the operator's `close_unsolicited` command.
- **Depends on:** B-M22-03, B-M16-10, B-M19-06.
- **Interfaces:** `Wallet.janitor()`, `sweepIfAboveCap()` (ARCH M22); maintenance submission through M19 (`submitMaintenance`, CL-44).
- **Logic:**
  1. Janitor (every 60 s, at most one janitor transaction per minute): candidate ATAs = registry entries with chain balance exactly 0 whose mint has no non-terminal position or intent, excluding mints in the D22 keep-open window (24 h after a close when the D22 switch is on); build with B-M16-10; submit as maintenance `janitor`; on confirmation book `rent_refund` per closed account (M23) and mark `closed_at`. Never counts toward cannot-sell.
  2. wSOL unwrap: if reconciliation found a wSOL balance, include its close in the next janitor transaction.
  3. Sweep (00:05 UTC daily and `botctl sweep`): if hot SOL + wSOL > `HOTCAP` + 0.1 SOL, amount = hot − max(`HOTCAP`, float + reservations + rent reserve + 10,000,000) (sweep down to the cap, never below the protected amounts; CL-46); build with B-M16-10; submit maintenance `sweep`; on confirmation record `cash_flow(sweep, source = 'signer_log')`. Sweeps never run while a non-terminal exit intent is waiting for fees (the float protects it anyway).
  4. `close_unsolicited(mint)` (A1 command from M26): mint must be `unsolicited`; build `buildBurnAndClose`; submit maintenance `close_unsolicited`; the signer independently refuses any mint it ever signed a buy for (CL-11).
- **Shared resources and concurrency:** Token accounts (owner M22); maintenance transactions go through M19 and the signer like any other.
- **Config:** `m22.janitor_interval_ms` (60,000); `m22.sweep_utc_time` (`00:05`); `m22.sweep_margin_lamports` (100,000,000); `m22.d22_keep_open` (bool, false).
- **Edge cases and failure handling:** Janitor close fails because dust arrived → retried next cycle; sweep fails → retried next day, alert warning.
- **Acceptance criteria:** Given a closed position whose ATA balance is 0, then within 2 minutes a janitor transaction closes it and a `rent_refund` cost item of the ATA's rent exists; given hot 1.2 SOL with `HOTCAP` 0.5 SOL, then a sweep of 0.7 SOL minus protections is built and recorded as a cash flow.
- **Tests:** unit; integration with a fake signer; failure injection "Daily sweep larger than the signer day cap" (ARCH 16.5).
- **Observability:** metrics `janitor_closes_total`, `rent_refund_lamports_total`, `sweeps_total`; log codes `m22.janitor`, `m22.sweep`.
- **Security notes:** Sweep destination is fixed in the signer's root-owned config; the engine's copy is only compared.
- **Facts used:** LD-14 (rent refundable), LD-01.
- **Definition of done:** Common DoD; checklist item 4 (test sweep of 0.001 SOL) runnable through `botctl sweep --lamports` (B-M29-04).

#### B-M22-05 — Paper ledger

- **Module:** M22 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** The `paper_ledger` source for VM-04 and for every limit in paper mode: simulated SOL and token balances driven by M12's synthetic fills, with the same reservation and float logic as live.
- **Depends on:** B-M22-01. Group A: M12 synthetic `AttemptResult` events (via the `ExecutionPort.onResult`, CL-27).
- **Interfaces:** `Wallet.balances()` with `source = 'paper_ledger'`.
- **Logic:**
  1. Starting paper equity `m22.paper_initial_lamports` (default `E_ref` = 6,666,666,667) recorded as an `external_in` flow at paper start (so the flow-adjusted index starts at 1).
  2. Synthetic fills debit/credit SOL and tokens exactly like live fills (including modelled fees, tips, rent deposits and janitor refunds).
  3. Paper `E` = paper SOL + paper positions at marks; the **real** chain `E` (simulation payer + cold if configured + hot if funded) is reported separately for the fixed-cost ceiling and P-9 (CL-45).
  4. Paper positions opened in paper are never confused with live (`mode`, `simulated` on every record).
- **Shared resources and concurrency:** Same as B-M22-01, separate rows by `mode`.
- **Config:** `m22.paper_initial_lamports`.
- **Edge cases and failure handling:** Mode change with `keep_managing`: live positions keep the chain ledger; new paper entries use the paper ledger.
- **Acceptance criteria:** Given a paper buy of 0.0667 SOL with modelled fees, then paper SOL decreases by input + fees + tips + rent and the token balance increases by the synthetic amount; VM-04 shows `source = paper_ledger` and `simulated = true`.
- **Tests:** unit; replay-vs-paper consistency test (ARCH 16.4).
- **Observability:** `equity_lamports{mode="paper"}`.
- **Security notes:** None.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M22-06 — `rebuildFromChain` after a database restore

- **Module:** M22 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** After a restore from a backup, reconstruct fills, positions and cost bases for the window since the backup's last slot from the hot wallet's signature history (CA-28), marking every rebuilt record `recovered`.
- **Depends on:** B-M22-03, B-M23-01. Group A: M02 `decodeTransactionEvents`, M14.
- **Interfaces:** `Wallet.rebuildFromChain(sinceSlot): Promise<{ fills: FillRecord[]; positions: Position[]; unresolved: Signature[] }>`.
- **Logic:**
  1. Page `getSignaturesForAddress` on the hot wallet newest-first with `before`/`until` cursors and `limit` ≤ 1,000 [DA-08] back to `sinceSlot`; fetch each transaction with version 1 [LD-05].
  2. Classify each transaction by its instructions (our PumpSwap buys/sells, janitor, sweep, transfers) and compute deltas from meta; venue fees from decoded events [EX-37].
  3. Rebuild positions per mint in slot order (buy opens, sells reduce, zero closes); cost basis from actual SOL deltas; `source = 'recovered'` on fills, positions and trades.
  4. Rebuilt records are excluded from gate statistics unless the rebuilt state reconciles exactly with chain balances at the end (M13 rule `excludeRecovered`); transactions that cannot be classified are listed in `unresolved` and alerted.
- **Shared resources and concurrency:** Runs before entries resume (ARCH 7.6 step 5); writes through M20 and M23 interfaces.
- **Config:** `m22.rebuild_page_limit` (1,000; ≤ 1,000 [DA-08]).
- **Edge cases and failure handling:** Rate-limited history → slow down, never skip pages; restart-safe (progress cursor persisted).
- **Acceptance criteria:** Restore from a 50-minute-old backup with 2 positions opened since → both reconstructed with real cost bases, marked `recovered`; no orphans at cost basis 0 (ARCH 16.5).
- **Tests:** integration with a recorded wallet history fixture `FX-WALLET-REBUILD`; failure injection: 429 mid-page.
- **Observability:** metrics `rebuild_signatures_total`, `rebuild_unresolved`; log code `m22.rebuild`.
- **Security notes:** None.
- **Facts used:** DA-08, LD-05, EX-37.
- **Definition of done:** Common DoD.

---

### M23 Cost ledger and trade journal

Shared interface (exact copy of ARCH M23): `CostItem`, `TradeRecord`, `SandwichCheck`, `Journal`.

#### B-M23-01 — Per-attempt cost items from transaction meta, instructions and events

- **Module:** M23 · **Size:** M (~1.5 engineer-days) · **Phase:** 2 (paper: `model` source), 3 (live)
- **Goal:** Book every cost of every attempt exactly once, from the best available source, including failed attempts, both tips on rung ≥ 2, janitor closes, rent deposits and rent refunds.
- **Depends on:** B-M24-02, B-M19-01. Group A: M02 decoded events (`pump_trade` fee fields, `pumpswap_buy`/`pumpswap_sell` lp/protocol/coin-creator fees [EX-37]); M10 model costs for paper. Group B: B-M16-01 `priorityFeeLamports`.
- **Interfaces:** `CostItem` (ARCH); internal `bookAttempt(r: AttemptResult, attempt: { cuLimit: Cu; cuPrice: MicroLamportsPerCu; tips: TipSpec[]; numSignatures: number; createdAccounts: Array<{ pubkey: Pubkey; rentLamports: Lamports }>; closedAccounts: Array<{ pubkey: Pubkey; rentLamports: Lamports }> }): CostItem[]`.
- **Logic:**
  1. Landed (success or failure): `network_base = 5,000 × numSignatures` [LD-01]; `priority = meta.feeLamports − network_base` (source `tx_meta`), cross-checked with `ceil(cuPrice × cuLimit / 1e6)` [LD-02]; mismatch > 0 lamports → alert `cost_model_error` (the formula or the decoded limit is wrong).
  2. Success: `tip` = sum of our tip instructions (both Sender and Jito tips on rung ≥ 2; source `instruction`); `venue_fee` = decoded event fee fields (pump: `fee` + `creator_fee` [EX-05, EX-06, EX-37]; PumpSwap: lp + protocol + coin-creator fee amounts [EX-37]); fallback the pool's fee schedule (`model`) or, for Raydium, pre/post vault deltas per the venue spec (`instruction`); `rent_deposit` for accounts created and still open after the transaction (base-mint ATA, `user_volume_accumulator`); temporary wSOL rent is created and refunded in the same transaction and books nothing.
  3. Failure on chain: `failed_tx` = `meta.feeLamports` (base + priority charged on failure [LD-01]); tips are reverted with the failed transaction (instruction atomicity; explicit for Nozomi [LD-23]) and book nothing; venue fees nothing.
  4. Expired (never landed): no cost item.
  5. Janitor: `network_base`, `priority`, `tip` as above and **one** `rent_refund` item (negative cost, `lamports < 0`) equal to the sum of the refunds of all accounts the transaction closed; the per-account detail stays in the attempt's `classification_json`, because `cost_item` is unique per `(attemptId, kind)` (ARCH 7.2, 15). Likewise `rent_deposit` is one item per attempt summing all accounts created and still open.
  6. Rung 4: Jupiter fee is booked as `venue_fee` with source `event` if decodable from the response or meta, else `model` from `feeBps` (dashboard shows it, ARCH 8.7).
  7. Paper: all items from M10's `SimFill` with source `model`.
  8. Uniqueness `(attemptId, kind)` (append-only). A later correction (for example meta that becomes available after a `model` item was booked; ARCH M23 "revisited by the reconciler") is written to the append-only `cost_item_correction` table (`cost_id`, corrected lamports, source, at) and aggregations use the newest correction; the original row is never edited (CL-66).
- **Shared resources and concurrency:** Owner of `cost_item` (append-only; ARCH 7.2).
- **Config:** none.
- **Edge cases and failure handling:** Meta unavailable → items with source `model` and a reconciler task to revisit (ARCH M23 failure modes).
- **Acceptance criteria:**
  1. Given a recorded successful rung-2 PumpSwap sell (`FX-TX-PUMPSWAP-SELL-RUNG2`), then items: network_base 5,000, priority = meta fee − 5,000, tip 6,000, venue_fee = event lp + protocol + coin-creator fee.
  2. Given a recorded failed sell (`FX-FAIL-SLIPPAGE`), then exactly one `failed_tx` item equal to meta fee and no tip item.
  3. Golden test per venue: event-reported fees reconcile to the SOL deltas (curve buy fee added on top of `sol_amount`, sell fee from proceeds [EX-05]).
- **Tests:** unit; golden on recorded transactions (`FX-TX-CURVE-*`, `FX-TX-PUMPSWAP-*`); property (costs non-negative except `rent_refund`).
- **Observability:** metrics `cost_lamports_total` (kind), `cost_model_error_bps` (kind).
- **Security notes:** None.
- **Facts used:** LD-01, LD-02, LD-23, EX-05, EX-06, EX-07, EX-37, LD-14.
- **Definition of done:** Common DoD.

#### B-M23-02 — Closed-trade records and the `net = gross − costs` invariant

- **Module:** M23 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** Produce one immutable `TradeRecord` per closed (or `open_failed`, `written_off`, `orphan`-closed) position, computed in the order ARCH M23 prescribes so `netPnl = grossPnl − totalCosts` holds exactly without double counting.
- **Depends on:** B-M23-01, B-M20-01.
- **Interfaces:** `TradeRecord` (ARCH M23); internal `closeTrade(positionId): TradeRecord`.
- **Logic:**
  1. `netPnl` = the hot wallet's actual SOL change (SOL + wSOL) over all of the position's attempts (entry, every exit attempt including failed ones) and its janitor close, from transaction meta pre/post balances, **excluding** rent deposits and refunds (reported separately). This is chain truth. Paper: the same over the paper ledger.
  2. `costs.networkBase`, `costs.priority` from meta (B-M23-01) including the janitor close; `costs.tips` (both tips on rung ≥ 2); `costs.failedTx`; `costs.venueFees` from events or model.
  3. `totalCosts` = sum of the five; `grossPnl = netPnl + totalCosts` (by construction).
  4. `implicitSlippageLamports` = (fill amounts) vs (the decision price × sizes); informational only, never subtracted again (VM-06).
  5. `exitSolPerToken`, `entrySolPerToken` = VWAP from fills; `holdMs`; `exitReason`; signatures; `solUsdAtCloseE6` and `priceSource` from the nearest `price_reference` at close (null with reason if unknown, never 0).
  6. `open_failed`: a zero-size trade with the failed costs (net = −costs). `written_off`: proceeds 0, `exit_reason = written_off`. Correction records (`supersedesTradeId`) for relinked `open_failed` positions and late sentinel imports.
  7. Labels: `shadow` for paper trades of a strategy that has not passed R (from M13 stage); `source` from fills (`live`, `paper`, `sentinel`, `recovered`).
  8. Contract test: the backend `ExitReason` union equals VM-06 `exit_reason` (UC-01).
- **Shared resources and concurrency:** Owner of `trade` (append-only).
- **Config:** none.
- **Edge cases and failure handling:** A late fill after `closed` → correction record.
- **Acceptance criteria:** For 1,000 random fill/cost sets, `net = gross − costs` exactly and costs are non-negative (ARCH 16.2 journal invariant); a rung-2 exit with both tips shows `costs.tips` = 6,000 per landed transaction.
- **Tests:** unit; property; golden from recorded transactions.
- **Observability:** metric `trades_closed_total` (mode, exit_reason).
- **Security notes:** None.
- **Facts used:** EX-05, EX-37, TH-48 (journal fields).
- **Definition of done:** Common DoD; VM-06 fixtures validate.

#### B-M23-03 — SOL/USD price references, fixed-cost items and cost aggregates

- **Module:** M23 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** Record SOL/USD every 60 s with its source label (D20), keep the operator's fixed-cost items, and compute VM-14 and VM-11 cost aggregates, the fixed-cost amortisation inputs (CB-03) and the cost-model error for L-3 and LS-2.
- **Depends on:** B-M24-02. Group A: M14 `http('jupiter' | 'coingecko', …)`; M10 `estimateRoundTripCostBps`, `fixedCostBpsPerTrade`.
- **Interfaces:** internal `PriceRef { latest(): { usdE6: bigint; atMs: UnixMs; source: string } | null; series30m(): Array<{ atMs: UnixMs; usdE6: bigint }> }`, `FixedCosts { activeMonthlyUsdE6(): bigint; items(): FixedCostItem[] }`.
- **Logic:**
  1. Every 60 s: Jupiter Price V3 `GET https://api.jup.ag/price/v3?ids=<wSOL mint>` (keyless allowed; `usdPrice` field; a missing key **or** a null value means unknown [DA-29]); on failure use CoinGecko Demo (100 calls/min; monthly allowance conflicting, so sized ≤ 2,000 calls per month: used only when Jupiter fails, and at most once per 5 min) [DA-27]. **VERIFY** the CoinGecko simple-price endpoint and parameters before coding. Store `price_reference(asset='SOL', usd_e6, source, at)`; Jupiter Price calls pause while exits are in flight (M14 rule).
  2. Fixed-cost items: from config key `m23.fixed_cost_items` (list of `{ label, monthly_usd_e6, source: manual | invoice, active_from, active_to }`), applied through `apply_config` with `riskDirectionOnIncrease = decreases_risk` (integration, stricter than CL-47's `neutral`: lowering a recorded fixed cost can unlock gate P-9 and the fixed-cost ceiling, so a decrease is A3; an increase is A1). Default item: DigitalOcean droplet $12.00 (`12000000` usd_e6) [LD-35].
  3. VM-14 aggregates for `today|d7|d30|mtd`: sums of cost items by kind, `slippage_lamports` (implicit, informational), `rent_deposits_lamports` (net, excluded from totals), `variable_lamports`, `fixed_usd_e6` prorated by days, `traded_volume_lamports`, `cost_per_trade_lamports`, `cost_bps_of_volume`, `fixed_cost_bps_of_equity_per_month` and `break_even_monthly_return_bps` (= fixed monthly ÷ `E`).
  4. Cost-model error: per closed trade, realised explicit cost vs M10's modelled cost for the same trade; rolling 50-trade ratio for L-3 (> 1.5 → block entries) and 20-trade ratio for the alert (> 1.25) and LS-2.
- **Shared resources and concurrency:** Owner of `price_reference`, `fixed_cost_item` (ARCH 7.2).
- **Config:** `m23.price_interval_ms` (60,000); `m23.coingecko_min_interval_ms` (300,000); `m23.fixed_cost_items`; `m23.reporting_currency` (default `USD`; OQ-1).
- **Edge cases and failure handling:** Both price sources down → `null` with reason; fiat fields null; regime filter blocks MR entries (B-M21-03).
- **Acceptance criteria:** Given a Jupiter response omitting the mint, then the price is recorded as unknown (not 0) and CoinGecko is tried; given 31 days of fixed item $12, then `mtd` proration is correct to the micro-dollar.
- **Tests:** unit with recorded responses (`FX-JUP-PRICE-OK`, `FX-JUP-PRICE-OMITTED`, `FX-CG-PRICE`).
- **Observability:** metrics `price_age_ms`, `price_source` (gauge label), `cost_model_ratio_x100`.
- **Security notes:** Keys via M14; no keys in config payloads (VM-15 secret fields only show `is_set`).
- **Facts used:** DA-27, DA-29, DA-30, LD-35, TH-48.
- **Definition of done:** Common DoD.

#### B-M23-04 — Journal queries, CSV export and yearly tax-style export

- **Module:** M23 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** Serve VM-06 queries (cursor paging, totals over the whole filter), the journal CSV of the current filter, and a yearly tax-style CSV export with the fields ARCH 13.3 lists (tax-ready in general terms; **not tax advice**).
- **Depends on:** B-M23-02, B-M23-03.
- **Interfaces:** `queryJournal(f: { fromMs?; toMs?; strategyId?; mint?; outcome?: 'win' | 'loss'; exitReason?: ExitReason; mode?: Mode; cursor?: string; limit: number /* ≤ 200 */ })`, `journalCsv(f)`, `yearlyExport(year: number, mode: Mode): AsyncIterable<string>`.
- **Logic:**
  1. Cursor = opaque base64 of `(closedMs, tradeId)`; totals computed over the full filter (VM-06 rule).
  2. CSV: integer lamport columns (no floats), UTC timestamps, signatures, mint, pool address (counterparty/venue), wallet public key; untrusted symbol/name escaped for CSV injection (prefix `'` to cells starting with `=`, `+`, `-`, `@`).
  3. Yearly export (TH-48: type, date and time, units, fair market value at the time with its source, cost basis, wallet addresses, the other party including a crypto-asset address; CRA: opening and closing balances and cost per asset per wallet per year): one row per fill plus per-position lots (PERTOKEN = 1 means each position is one lot; chunked exits consume it FIFO; no jurisdiction-specific method is imposed, OQ-1, CL-48); opening/closing balances per asset per wallet. Retention ≥ 7 years (CRA ≥ 6 [TH-48]).
- **Shared resources and concurrency:** Read-only queries on the reader connection.
- **Config:** `m23.export_currency` (USD default).
- **Edge cases and failure handling:** Price missing for a fill → FMV column empty with the reason column filled.
- **Acceptance criteria:** Given 1,000 trades and a filter matching 350, then pages of 200/150 and totals over all 350; a symbol `=HYPERLINK(...)` is exported escaped.
- **Tests:** unit; CSV injection tests; large export streaming test (memory bounded).
- **Observability:** metric `export_rows_total`.
- **Security notes:** Operator role only (M28); no secrets; untrusted strings escaped.
- **Facts used:** TH-48.
- **Definition of done:** Common DoD; the CSV header documents units and states "not tax advice".

#### B-M23-05 — `detectSandwich` on our own live fills

- **Module:** M23 · **Size:** S (~1 engineer-day) · **Phase:** 3
- **Goal:** For our own live fills (≤ 100 per day), read the block and decide whether same-pool transactions immediately before and after ours moved the price against us and back (CB-13), to calibrate M10's `p_sw` and feed the D16 trigger.
- **Depends on:** B-M23-01. Group A: M14 (`getBlock`, P4, unmetered provider); M02 decoders; M10 reads `sandwich_check` (CL-49).
- **Interfaces:** `Journal.detectSandwich(fill: FillRecord): Promise<SandwichCheck>` (ARCH M23).
- **Logic:**
  1. `getBlock` at `confirmed` with `maxSupportedTransactionVersion: 1` [LD-05] for the fill's slot (**VERIFY** the parameters that return full transactions in block order; blocks are about 4 MB [LD-28]).
  2. Locate our transaction's index; collect the nearest transactions before and after it in the same block that write to the same pool account (decoded with M02).
  3. `sandwiched = true` when a transaction before ours trades in the same direction as ours (moving the price against us) and a transaction after ours trades in the opposite direction, and both have the same fee payer; `false` when same-pool neighbours exist and the rule fails; `null` with reason when the block is unavailable.
  4. Budget: at most `max_checks_per_day` (100), sampled uniformly if fills exceed it; P4.
  5. D16 trigger: detected sandwiches on > 2% of our fills over 100 fills, or measured adverse execution > 25 bps on average → critical alert recommending D16 (b) (bundles for entries); no automatic switch (CL-34).
- **Shared resources and concurrency:** Owner of `sandwich_check` (append-only).
- **Config:** `m23.max_sandwich_checks_per_day` (100).
- **Edge cases and failure handling:** Block too large or provider refuses → `null` with reason; never retried more than twice.
- **Acceptance criteria:** Given a recorded sandwiched block fixture (`FX-BLOCK-SANDWICH`), then `sandwiched = true` with neighbour counts; given a clean block (`FX-BLOCK-CLEAN`), `false`.
- **Tests:** unit with recorded blocks.
- **Observability:** metrics `sandwich_checks_total` (result), `sandwich_rate_bps` (rolling 100).
- **Security notes:** Third-party data only; no action against other users (this is detection of attacks on us, never sandwiching others; brief rule 4).
- **Facts used:** LD-05, LD-15, LD-16, LD-28, ST-22, ST-V06.
- **Definition of done:** Common DoD.

---

### M24 Persistence

#### B-M24-01 — SQLite library decision, connection model, `withTx` and transactional outbox

- **Module:** M24 · **Size:** M (~1.5 engineer-days) · **Phase:** 0 (spike), 2
- **Goal:** Resolve the CA-33 library decision with evidence, then provide one writer connection, reader connections, `withTx`, and the transactional outbox that makes every money-state change and its event commit together.
- **Depends on:** B-M30-01.
- **Interfaces:**

```ts
interface Db {
  withTx<T>(fn: (tx: TxHandle) => T): T;               // synchronous body; no await inside (ARCH 7.1); throws roll back
  reader(): ReaderHandle;                                // read-only connection for API queries
  outbox: { append(tx: TxHandle, topic: string, payload: unknown): void; drain(h: (rows: OutboxRow[]) => void): void };
  integrityCheck(kind: 'quick' | 'full'): { ok: boolean; messages: string[] };
}
interface OutboxRow { seq: bigint; topic: string; payloadJson: string; createdAtMs: UnixMs; publishedAtMs: UnixMs | null }
```

- **Logic:**
  1. Spike (Phase 0, recorded in `DEPENDENCIES.md`): **VERIFY (A-45)** that the built-in `node:sqlite` on the chosen Node LTS supports explicit transactions, WAL mode and an online backup API; measure write latency p99 for a 10-row transaction on the target droplet class. If any requirement fails, the fallback is an established native SQLite binding **built from pinned source in CI** with its addon SHA-256 in the SBOM (no prebuilt download at install; install scripts disabled; ARCH 4.5, 12.3).
  2. PRAGMAs: `journal_mode=WAL`, `synchronous=FULL` (durability over speed for money tables; D06 trigger watches write p99 > 20 ms), `foreign_keys=ON`, `busy_timeout` 5,000 ms on readers.
  3. One writer connection used only from the engine's event loop (all writes serialised, ARCH 4.5); `withTx` is synchronous so no `await` can occur inside it (lint rule: no `await` in a `withTx` callback).
  4. Outbox: rows appended in the same transaction as the state change; a drain loop publishes to the in-process `EventBus` and to M28's topics after commit, then marks `published_at`; on restart unpublished rows are re-published (consumers are idempotent by entity key and `seq`). Retention 7 days.
- **Shared resources and concurrency:** Owner of the SQLite file (ARCH 7.2). Single writer; readers never write.
- **Config:** `m24.db_path` (`/var/lib/zeroed/bot.db`; was `/var/lib/bot/bot.db` (PATHS-FIX, `docs/research/DISK-BUDGET.md` §2.9: the engine's unit can write only its state folder and its `ReadWritePaths`; `packages/engine/src/paths.ts`)), `m24.synchronous` (`FULL`, not editable at runtime).
- **Edge cases and failure handling:** `SQLITE_BUSY` on the writer → impossible by design (single writer); on a reader → retry within `busy_timeout`. Write latency p99 > 20 ms for 24 h → D06 alert.
- **Acceptance criteria:** Given a crash injected between a state change and its event publish, then after restart the event is published exactly once per consumer key; `withTx` containing an `await` fails lint.
- **Tests:** unit; crash-injection (kill -9 during 10,000 transactions; verify outbox and state agree); benchmark.
- **Observability:** metrics `db_write_latency_ms`, `outbox_backlog`; log code `m24.outbox_replay`.
- **Security notes:** DB file owned by `bot`, mode 0600; not readable by `signer` or `sentinel` except the sentinel journal path is separate.
- **Facts used:** VF-08 (Node 24 ≥ 24.15.0 and `node:sqlite` status; A-45 resolved by it).
  - **Node version note (supervisor, 2026-10-08).** VF-08 names Node 24, but the repo stays on Node 22.23.3 (`.node-version`) for now, per the 2026-10-07 "Node: stay on Node 22" row in `docs/DECISIONS.md`. `node:sqlite` is used there with no `--experimental-sqlite` flag: the A-45 check (`packages/engine/test/m24/sqlite-verify.test.ts` on branch `claude/z02-persistence`, pending merge until Z02 merges) imports it directly and covers transactions, WAL and online backup on Node 22.23.x. Read VF-08's Node 24 figures as applying to the later Node card, not to this build.
- **Definition of done:** Common DoD; decision recorded with measurements.

#### B-M24-02 — Schema, migrations, append-only triggers and PERTOKEN indexes for all modules

- **Module:** M24 · **Size:** L (~2.5 engineer-days) · **Phase:** 1 (group A research tables), 2 (all)
- **Goal:** Implement every table of ARCH 15 (including those written by group A modules) with forward-only migrations, append-only enforcement, and the PERTOKEN partial unique indexes.
- **Depends on:** B-M24-01, B-M19-01.
- **Interfaces:** typed repositories per entity (`OrdersRepo`, `AttemptsRepo`, `PositionsRepo`, `FillsRepo`, `TradesRepo`, `CostItemsRepo`, `CashFlowsRepo`, `ReservationsRepo`, `TokenAccountsRepo`, `MintClassRepo`, `LimitsRepo`, `BreakerEventsRepo`, `CommandsRepo`, `AuditRepo`, `AlertsRepo`, `SessionsRepo`, `PreferencesRepo`, `ConfigVersionsRepo`, `PriceRefRepo`, `FixedCostRepo`, `SandwichRepo`, `ReconcileRepo`, `WalletSnapshotRepo`, `KvStateRepo`, plus the group A repos `RunRepo`, `TrialRegistryRepo`, `StrategyStageRepo`, `GateEvaluationRepo`, `Bar1mRepo`, `EquityPointRepo`, `ScreenResultRepo`, `CandidateRepo`, `TokenRepo`, `PoolRepo`, `QuarantineRepo`, `MetricRollupRepo`, `SignalRepo`).
- **Logic:**
  1. Tables and columns exactly as ARCH 15, plus these additions (CL-44, CL-50): `order_intent.purpose` (`trade` | `janitor` | `sweep` | `close_unsolicited`, default `trade`); `tx_attempt.signed_tx_b64`, `tx_attempt.classification_json`, `tx_attempt.lvbh_source` (`blockhash` | `derived_upper_bound`), `tx_attempt.route`, `tx_attempt.jupiter_fee_bps`; `cost_item_correction(correction_id, cost_id, lamports, source, at)` (append-only, CL-66); `kv_state(key, value_json, updated_at)` (CU profiles, cursors); `schema_migrations(version, sha256, applied_at)`; `audit_import_cursor(source, last_seq)`. Group A additions adopted at integration (C-14, C-32): `enumerated_pool(pool_id, base_mint, is_canonical, first_enumerated_at, last_refresh_at, …)`, `discovery_cursor(source, cursor, updated_at)`, `coverage_report(day_utc, json, low_coverage, manifest_sha256)` (append-only), `rpc_usage(provider, month, units_used)`, `pool.quarantined_at`, `pool.quarantine_reason`, `universe_manifest(day_utc, sha256, path)` (append-only), `shadow_result` (append-only, A-M12-02), `strategy_stage` demotion fields (`entered_by`, `reason`) (A-M13-05). Exact columns are taken from the owning A ticket at implementation; this ticket owns the migration.
  2. Money columns INTEGER (lamports fit i64); token base-unit amounts TEXT with `CHECK (amount GLOB '[0-9]*' AND length(amount) BETWEEN 1 AND 20)` (signed variants allow a leading `-`); ULID TEXT primary keys; `created_at` integer ms.
  3. Append-only tables (`fill`, `trade`, `cost_item`, `cost_item_correction`, `cash_flow`, `audit_event`, `trial_registry`, `config_version`, `screen_result`, `position_event`, `breaker_event`, `sandwich_check`, `price_reference`, `reconcile_run`, `wallet_snapshot`, `strategy_stage`, `gate_evaluation`, `equity_point`, `quarantine`, `metric_rollup_1m`): a `BEFORE UPDATE` trigger always raises `RAISE(ABORT, 'append_only')`; a `BEFORE DELETE` trigger raises the same error **unless** the row is older than that table's retention horizon from ARCH 15 (the trigger compares the row's own timestamp column with the current time computed in SQL, e.g. via `strftime`, and aborts while the row is younger than the horizon), so the retention job can remove only expired rows and nothing else can delete (CL-51). Tables with 7-year or `forever` retention therefore cannot lose rows inside their horizon.
  4. PERTOKEN: `CREATE UNIQUE INDEX … ON order_intent(mint) WHERE side = 'buy' AND state NOT IN ('rejected','filled','expired_final','cancelled','abandoned','failed')`; `CREATE UNIQUE INDEX … ON position(mint) WHERE state NOT IN ('closed','open_failed','written_off')`. Other uniques: `order_intent(idempotency_key)`, `tx_attempt(signature)`, `reservation(intent_id)`, `cost_item(attempt_id, kind)`, `alert(dedupe_key) WHERE state != 'resolved'`, `audit_event(hash)`, `trial_registry(trial_key, kind)`.
  5. Migrations: numbered, forward-only, each with its SHA-256 recorded; at engine start, before anything else, M24 takes an online backup, then applies pending migrations in one transaction; failure → rollback, `exits_only` on the unmigrated database (positions still managed) and a critical alert (CL-52).
- **Shared resources and concurrency:** Schema owned by M24; every module writes only through its repository.
- **Config:** none.
- **Edge cases and failure handling:** A migration checksum mismatch with an applied migration → start refused for entries (`exits_only`).
- **Acceptance criteria:** an `UPDATE` on `fill` aborts with `append_only`; a second non-terminal buy intent for the same mint violates the unique index; a migration failure leaves the database at the previous version.
- **Tests:** migration tests from an empty DB and from every previous version; trigger tests; index tests.
- **Observability:** log codes `m24.migration_applied`, `m24.migration_failed`.
- **Security notes:** No secrets in the database except hashed session IDs and WebAuthn public keys (M28).
- **Facts used:** none external.
- **Definition of done:** Common DoD; ERD generated into the repository docs.

#### B-M24-03 — Hash-chained audit log, external log import and `verifyChain`

- **Module:** M24 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** Append-only audit events with `hash = sha256(prev_hash || canonical_json(event))` (VM-17, UI Q-15), import of the signer's signing log and the sentinel's event log, and `verifyChain` for `POST /api/v1/audit/verify`.
- **Depends on:** B-M24-02 (canonical JSON from B-M19-01 `@bot/types`).
- **Interfaces:** `AuditRepo.append(event: Omit<AuditEvent, 'eventId' | 'prevHash' | 'hash'>): AuditEvent`; `verifyChain(): { valid: boolean; firstBadEventId: Id | null }`; `importExternal(source: 'signer' | 'sentinel', lines: Iterable<string>): { imported: number }`.
- **Logic:**
  1. Canonical JSON: use the single shared canonicaliser `canonicalJson()` in `@bot/types` `canon.ts` (B-M19-01; integration: one implementation for A-M05-03 manifests, A-M07-03 segment manifests, A-M11-05 bundles, A-M13-02 trial keys, B-M25-01 config hashes and these audit hashes): keys sorted lexicographically at every level, no insignificant whitespace, big integers as decimal strings, strings as-is (UTF-8), `null` explicit. Genesis `prev_hash` = 64 hex zeros.
  2. Appends happen only on the single writer, in the same transaction as the command's state change (M26) or auth event (M28).
  3. External import: the signer log (`/var/lib/signer/signing-log.ndjson`, exported by the signer to a `bot`-readable spool, CL-53) and the sentinel's event log are imported idempotently by `(source, seq)` with actor types `sentinel` and `cli` (UC-06); each imported line is appended as its own audit event with `target` and the original timestamp.
  4. `verifyChain` recomputes every hash in order; returns the first mismatch.
- **Shared resources and concurrency:** Audit log owner (ARCH 7.2); strict sequence by single writer.
- **Config:** none.
- **Edge cases and failure handling:** A tampered row → `valid = false` with its ID; never "repaired".
- **Acceptance criteria:** modifying any column of any audit row through a raw SQLite connection (triggers dropped in the test) makes `verifyChain` report that row.
- **Tests:** unit; property (random event sequences verify); tamper tests.
- **Observability:** metric `audit_events_total` (actor_type).
- **Security notes:** The chain detects tampering after the fact; it does not prevent a root attacker from rewriting the whole chain (documented limitation; daily off-host backups preserve earlier heads).
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M24-04 — Backups, integrity checks, disk guard and the `exits_only` database fallback

- **Module:** M24 · **Size:** M (~2 engineer-days) · **Phase:** 2, 3
- **Goal:** Hourly encrypted backups, integrity checks at start and on backups, a disk guard with a 500 MB journal reserve, and the `exits_only` path when the database cannot be trusted (ARCH M24, 7.6).
- **Depends on:** B-M24-02, B-M24-03. Group B: M26 `enterExitsOnly`, M22 chain reads, M20 re-arm.
- **Interfaces:** `Backups { runHourly(): Promise<{ path: string; sha256: string }>; newestGood(): string | null }`; `DiskGuard { freeBytes(): bigint; reserveBytes: bigint }`; `RecoveryJournal { append(rec: unknown): void }` (append-only file used only in `exits_only`).
- **Logic:**
  1. M24 backup step not built; `zeroed-backup` is the one backup owner (DISK-BUDGET §2.6): hourly, SQLite's online backup of every database under `/var/lib/zeroed`, integrity-checked, encrypted with age, newest 72 kept, and a daily copy re-encrypted to the owner's code off the server (`ops/README.md` "Backups"; PATHS-FIX ruling 22).
  2. Start: `PRAGMA integrity_check`. Corrupt → `exits_only`: open the newest backup that passes its check **read-only**, read positions from the chain (wallet token balances of `ours` mints, via M22) and from that backup, re-arm exits (M20), write fills and costs to the append-only recovery journal file `/var/lib/zeroed/recovery/recovery-<ts>.ndjson` (was `/var/lib/bot/recovery-<ts>.ndjson`; PATHS-FIX, `docs/research/DISK-BUDGET.md` §2.9: the engine's unit can write only its state folder and its `ReadWritePaths`), block entries, alert critical through the sentinel (D27). The operator then restores the backup and M22 rebuilds the window (B-M22-06).
  3. Disk guard: a 500 MB reserve file is preallocated; free space < 20% → warning, < 5% → critical and `halt_requested` (cannot record); on disk full the reserve file is deleted so journal writes for exits can continue (ARCH M24).
- **Shared resources and concurrency:** Backup runs on the writer connection's backup API without blocking the event loop longer than one step (chunked backup steps).
- **Config:** `m24.backup_keep` (48), `m24.reserve_bytes` (500 MB), `m24.disk_warn_pct` (80), `m24.disk_crit_pct` (95).
- **Edge cases and failure handling:** No good backup exists and the database is corrupt → `start_refused` (`db_corrupt`) to the sentinel, which takes over exits (ARCH 7.6).
- **Acceptance criteria:** database corrupt at start with 2 live positions → `exits_only`, exits armed within 20 s, entries blocked (ARCH 16.5); disk full → `halt_requested`, exits still journaled.
- **Tests:** corruption injection; disk-full simulation with a loopback filesystem; backup/restore round trip.
- **Observability:** metrics `disk_free_bytes`, `backup_age_s`; log codes `m24.backup`, `m24.exits_only`.
- **Security notes:** Backups encrypted at rest; the backup key is not the trading key and lives in the secret store.
- **Facts used:** none external. VERIFY: A-18.
- **Definition of done:** Common DoD; restart drill (checklist item 3) passes.

---

### M25 Config service

#### B-M25-01 — Config schema registry, ceilings file and bootstrap

- **Module:** M25 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** One schema (`ConfigFieldSchema[]`) covering every key of every module with type, unit, display unit, bounds, risk direction, `affectsReturns`, `requiresRestart`, `secret` and mode scope; the root-owned ceilings file; and the bootstrap of the first config version.
- **Depends on:** B-M24-02.
- **Interfaces:** `ConfigFieldSchema`, `Config`, `ConfigVersion` (ARCH 5.0a); `schema(): ConfigFieldSchema[]`; `current(): Readonly<Config>`.
- **Logic:**
  1. Each module exports its field definitions (the `Config` sections of these tickets and group A's); the registry merges them at build time and fails the build on duplicate keys.
  2. `affectsReturns: true` for every key that can change a backtest, replay or paper outcome (universe filters, exits, cost and fill model inputs, slippage caps, ladder, cooldown, entry rate, regime, dump window, sizing) (CA-24); a CI test lists keys without the flag for review.
  3. Ceilings: `/etc/bot/ceilings.json` (root-owned, read-only to `bot`; the signer reads its own copy) with absolute maxima (per-trade notional, open positions, daily loss, hot-wallet cap, slippage, signer day cap, tip cap, exit fee cap). Neither the API nor the engine can write it.
  4. Bootstrap: on first start, `/etc/bot/config.json` (root-owned) becomes `config_version` 1 (sha256 of canonical JSON); later versions exist only in the database (immutable rows).
  5. Secrets are never config values: secret fields carry only `is_set` (VM-15); values come from the secret store (M14 and M28 read them).
- **Shared resources and concurrency:** Owner of configuration (ARCH 7.2).
- **Config:** this ticket defines the mechanism, not values.
- **Edge cases and failure handling:** Config file invalid at first start → `start_refused` (`config_invalid`); later invalid → B-M25-03.
- **Acceptance criteria:** every key referenced in code exists in the schema (static check); `/etc/bot/ceilings.json` writable by `bot` fails the start-up permission check.
- **Tests:** unit; static key-usage test.
- **Observability:** metric `config_version_info`.
- **Security notes:** File ownership checks at start (root-owned, not writable by `bot`).
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M25-02 — Validation, diff, action-class derivation and display-unit parsing

- **Module:** M25 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** `validate(changes)` producing `ValidateResult` (errors, warnings, diff with risk direction, derived action class, `requiresFlatBook`), and `parseDisplay` that parses typed values strictly in each field's display unit and echoes the exact stored value (CA-32, UC-05).
- **Depends on:** B-M25-01.
- **Interfaces:** `validate(changes: Array<{ key: string; new: unknown }>): ValidateResult`; `parseDisplay(key, text): Result<{ stored: bigint | number | string; displayed: string; unit: string }, { code: 'E_UNIT' | 'E_PRECISION' | 'E_RANGE' }>`.
- **Logic:**
  1. Type and range checks per schema; ceilings (`E_CEILING`); cross-field rules (integration additions: `universe.screening_required = false` only while no strategy is enabled in any mode (C-44); `analytics.equity.includes_cold` must equal M22's cold-wallet setting (C-35); examples: `m15.blockhash_max_age_ms < 150 × slot time × 0.8`; tip lists equal the signer policy hash; `pump_curve_enabled` false in live; endpoint URLs `https:`/`wss:` only (M14 rule); `research.*` keys, `research.b10.assume_pass_unavailable` included, are research CLI keys and are refused in paper, live_small and live with `E_MODE_SCOPE` (C-78, SPEC-A A-M11-01 step 8)).
  2. Direction per change from `riskDirectionOnIncrease` and the sign of the change; action class: any risk increase → A3; else any neutral change → A2; else (all decreases) → A1; highest wins (VM-15 `derived_action_class`).
  3. `requiresFlatBook = any changed key has requiresRestart` (CA-32).
  4. `parseDisplay`: `sol` → decimal with ≤ 9 fractional digits → lamports exactly (`"0.30"` → `300000000`); `bps` → integer; `pct` → ≤ 2 fractional digits → bps; `count` → integer; `minutes` → integer minutes → ms. Exponents, separators and extra precision → `E_PRECISION`/`E_UNIT`. `displayed` shows the canonical display string; the preview shows "0.30 SOL = 300000000 lamports" (UC-05).
  5. Magnitude warning: a raise of more than 2× the current value adds a warning (UI "Magnitude guard").
- **Shared resources and concurrency:** Pure.
- **Config:** none.
- **Edge cases and failure handling:** `"3.0"` typed for a `sol` field whose current value is `0.30` → valid but warning "10× the current value".
- **Acceptance criteria:** `parseDisplay('MAXPOS', '0.30')` → stored 300,000,000, displayed `0.30 SOL`; `'0.3000000001'` → `E_PRECISION`; a diff raising `MAXPOS` → A3; `research.b10.assume_pass_unavailable = true` in paper mode → `E_MODE_SCOPE`, the same in live_small mode → `E_MODE_SCOPE`, and in live mode → `E_MODE_SCOPE` (C-78).
- **Tests:** unit; property (parse/format round trip for random lamport values).
- **Observability:** none.
- **Security notes:** Inputs are untrusted strings; strict regexes.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M25-03 — Apply, versioning, safe-point switching, the flat-book rule and invalid-config start

- **Module:** M25 · **Size:** S (~1 engineer-day) · **Phase:** 2
- **Goal:** `apply` (called only by M26) with optimistic concurrency, immutable versions, modules switching at a safe point between events, refusal of restart-requiring changes unless the book is flat, and the `exits_only` start on an invalid config.
- **Depends on:** B-M25-02, B-M24-04. Group B: M19/M20 for "book flat".
- **Interfaces:** `apply(expectedVersion: string, changes, by: Actor): Result<ConfigVersion, { code: 'E_VERSION' | 'E_VALIDATION' | 'E_CEILING' | 'E_BOOK_NOT_FLAT' }>`; `subscribe(h: (v: ConfigVersion) => void): () => void`.
- **Logic:**
  1. `expectedVersion` ≠ current → `E_VERSION` (HTTP 409 `config_version_mismatch`).
  2. Re-validate; any `requiresRestart` key while any position or intent is non-terminal → `E_BOOK_NOT_FLAT` (v1 refuses; it does not queue the change for later, CL-54).
  3. Write the new immutable `config_version` row; notify subscribers after commit; each module swaps its frozen snapshot between events (never mid-handler). `requiresRestart` changes take effect at the next engine restart, which the operator performs (book is flat by construction).
  4. Start with an invalid active config (fails schema or ceiling) → `exits_only` using the last valid `config_version` from the database; if none is readable → `start_refused('config_invalid')` and the sentinel takes over (ARCH M25, 7.6).
- **Shared resources and concurrency:** Owner of `config_version`; ETag semantics.
- **Config:** none.
- **Edge cases and failure handling:** `apply_config` with a `requires_restart` key while a position is open → rejected `book_not_flat` (ARCH 16.5).
- **Acceptance criteria:** as the edge case; an apply with a stale version returns `E_VERSION` and nothing changes.
- **Tests:** unit; integration with M26 command pipeline.
- **Observability:** log code `m25.applied` (version, actor, diff keys only; no secret values).
- **Security notes:** Only M26 can call `apply` (module boundary test).
- **Facts used:** none external.
- **Definition of done:** Common DoD.

---

### M26 Mode controller and command service

Shared interface (exact copy of ARCH M26): `CommandService` (`preview`, `submit`, `status`, `cancel`), `ModeController` (`state`, `halt`, `onComponentAck`, `enterExitsOnly`); types `CommandRequest`, `PreviewResponse`, `CommandStatus`, `SystemState` from ARCH 5.0a.

#### B-M26-01 — System state, trading-state machine, HALT fan-out and the engine heartbeat

- **Module:** M26 · **Size:** M (~2 engineer-days) · **Phase:** 2 (paper), 3 (signer latch, sentinel)
- **Goal:** Own `system_state` (mode, trading state, `state_version`) and every trading-state transition of ARCH 7.7, implement HALT semantics D24 with component acknowledgements within 2 s, RESUME, `exits_only`, and the engine side of the sentinel heartbeat and `start_refused` protocol.
- **Depends on:** B-M24-03, B-M27-01. Group B: B-M19-06 `SignerClient` (latch; live modes only), M19 `cancelUnsent`, M20, M21; M29 heartbeat socket (B-M29-01).
- **Interfaces:** `ModeController` (ARCH). Heartbeat messages (ARCH M29, plus CL-56):

```ts
type EngineToSentinel = { kind: 'heartbeat'; seq: number; atMs: UnixMs; tradingState: TradingState; mode: Mode; openLivePositions: number; eventLoopLagMs: number;
    positions: Array<{ mint: Pubkey; poolId: Pubkey; venue: VenueId; tokenProgram: Pubkey; sizeBase: BaseUnits }> }   // integration: CL-61 list carried here, persisted by B-M29-01
  | { kind: 'start_refused'; reason: 'idl_hash' | 'config_invalid' | 'db_corrupt' | 'other'; detail: string }
  | { kind: 'halt_notice'; haltId: Id; atMs: UnixMs }                     // CL-56: lets the sentinel acknowledge as a HALT component
  | { kind: 'critical_alert'; alertId: Id; code: string; title: string }; // M27 forwarding (D27)
type SentinelToEngine = { kind: 'ack'; seq: number } | { kind: 'halt_ack'; haltId: Id };
```

- **Logic:**
  1. `state_version` increments on every change of `system_state` (one row, CAS on version, with audit and outbox).
  2. HALT (from a command, a breaker via M21 `requestHalt`, `botctl halt` relayed by the sentinel, or the sentinel watchdog): `running → halt_requested`; fan-out: M19 `cancelUnsent({ side: 'buy' })` → ack; M20 confirms exits stay armed → ack; M21 blocks entries → ack; signer `latch({ kind: 'halt' })` (set by `engine`) → ack on success; sentinel `halt_notice` → `halt_ack`. All five within 2 s → `halted`; else `halt_partial` with the list of missing components (critical alert; UI shows CLI instructions, ARCH 12.6); a late ack moves `halt_partial → halted`. `flatten: true` additionally calls M20 `flattenAll(…, 'halt_flatten')`.
  3. RESUME (A2, via B-M26-02): allowed only from `halted`; all breakers requiring manual reset are reset; the signer latch: if `latchSetBy == 'engine'` the engine clears it; otherwise RESUME is blocked with reason `latch_requires_host_cli` until `botctl resume-latch` cleared it (D28, UC-08; VM-03 `kill.latch_clear_requires = host_cli`). Then `resume_requested`; acks within 5 s → `running`; else `halted` with an alert.
  4. `enterExitsOnly(reason)`: from `starting` (database corrupt or config invalid; 7.6 step 2) or by the operator; entries blocked everywhere; exits run; leaving it requires a restart after the operator fixed the cause (`exits_only → starting`).
  5. Any transition into `halt_requested`, any auto-demotion and any breaker trip calls B-M26-03 `cancelAllPendingA3('system')` (CA-19).
  6. Heartbeat: connect to `/run/sentinel/engine.sock`; every 2 s send `heartbeat`; missing `ack` for 10 s → alert "sentinel down" (critical). On a start refusal, send `start_refused` before exiting (ARCH M29).
  7. VM-03 fields (via M28): `kill.components[]` = M19, M20, M21, signer latch, sentinel; `kill.halted_by.type` includes `sentinel` and `cli`; `kill.latch_set_by`, `kill.latch_clear_requires`, `signer.lock`, `signer.exit_lease_holder` from `SignerClient.status()` polled every 5 s (UC-06, UC-07).
- **Shared resources and concurrency:** Owner of system mode, trading state and `state_version` (ARCH 7.2). Commands carry `expected_state_version` (409 on mismatch).
- **Config:** `m26.halt_ack_timeout_ms` (2,000; fixed by P-7); `m26.resume_ack_timeout_ms` (5,000); `m26.heartbeat_ms` (2,000); `m26.sentinel_ack_timeout_ms` (10,000).
- **Edge cases and failure handling:** HALT with one component hung → `halt_partial` + alert; the signer latch still blocks entries (ARCH 16.5). Sentinel down → halts still complete with `halt_partial` listing `sentinel` (the signer latch is the binding control).
- **Acceptance criteria:** P-7 drill: HALT acknowledged by all components within 2 s (measured and stored for VM-18); RESUME with a sentinel-set latch is refused with `latch_requires_host_cli`; after `botctl resume-latch` it succeeds.
- **Tests:** unit (state machine table 7.7); integration with the real signer and a fake sentinel; failure injection (component hung, sentinel down).
- **Observability:** metrics `trading_state` (gauge), `halt_ack_ms` (component), `sentinel_heartbeat_age_ms`; log codes `m26.halt`, `m26.halt_partial`, `m26.resume`.
- **Security notes:** HALT never requires step-up (A1); RESUME does (A2, M28).
- **Facts used:** none external.
- **Definition of done:** Common DoD; checklist item 2 drills scripted.

#### B-M26-02 — Command pipeline: preview, submit, idempotency, action classes and audit

- **Module:** M26 · **Size:** L (~2.5 engineer-days) · **Phase:** 2 (A0-A2 and A3 for limits/config), 3 (A3 mode promotion)
- **Goal:** The VM-19 command contract on the server: authoritative action classes, previews with consequences (typed and stored values), idempotency on `command_id`, `expected_state_version` conflicts, per-type validation, and an audit event for every command including rejected ones.
- **Depends on:** B-M26-01, B-M25-02. Group B: M28 provides the authenticated `Actor`, step-up verification time, client kind and dialog hash (B-M28-02).
- **Interfaces:** `CommandService` (ARCH M26); `CommandRequest`, `PreviewResponse`, `CommandStatus` (ARCH 5.0a); `type CommandContext = { actor: Actor; role: 'viewer' | 'operator'; clientKind: 'desktop' | 'mobile'; stepUpVerifiedAtMs: UnixMs | null }`.
- **Logic:**
  1. Action class per type (server-derived): `halt` A1; `resume` A2; `flatten_all` A2; `close_position` A1; `set_mode` A3 when raising (paper → live_small → live), A1 when lowering; `update_limit` A3 when raising risk, A1 when lowering; `reset_breaker` A2; `apply_config` = M25's derived class; `ack_alert`, `snooze_alert` A0; `cancel_scheduled` A1; `write_off_position` A2; `close_unsolicited` A1 (ARCH 14.3, UI action classes).
  2. Requirements: A2/A3 need `reasonText` ≥ 10 characters and a step-up verified within 5 min (A2) or a fresh assertion ≤ 60 s old (A3); A3 needs `typedConfirmation` equal to `requiredPhrase` (`LIVE-SMALL <max_trade_sol>`, `LIVE <max_trade_sol>`, `RAISE <short_code> <new_value>` in the limit's display unit, UC-05) and, for `set_mode` raises, `checklistAck` covering every VM-18 checklist item; viewer role → 403 `role`; mobile client and A2/A3 → 403 `mobile_forbidden` (UI D-UI-11).
  3. `preview`: current state, exact change, consequences (for limits/config: typed value **and** exact stored value with units, CA-32; for `flatten_all`/`close_position`: per-position estimated proceeds, impact and the `max_slippage_bps` that will apply, from M20 marks), `delayS` (60 for A3), `stateVersion`, `blockingReasons` (e.g. `book_not_flat`, `latch_requires_host_cli`, gates failing, `cooldown`, `fixed_cost_ceiling`).
  4. `submit`: same `commandId` → return the stored status (idempotent); `expectedStateVersion` ≠ current → 409 `state_changed`; class differs from the preview's (state changed it) → 403 `class_changed`; validation per type (`max_slippage_bps` ≤ 2,500; `new_value` ≤ ceiling; positions exist; etc.) → 422 with field errors; A0-A2 execute immediately (`executed` or `failed`); A3 → `scheduled` (B-M26-03).
  5. Execution routes: `halt` → B-M26-01; `resume` → B-M26-01; `flatten_all`/`close_position`/`write_off_position` → M20; `update_limit`/`reset_breaker` → M21; `apply_config` → M25 `apply`; `ack_alert`/`snooze_alert` → M27 (critical alerts are not snoozable); `close_unsolicited` → M22; `cancel_scheduled` → B-M26-03.
  6. Audit: every request (accepted, scheduled, executed, rejected, failed, cancelled) appends an audit event with actor, action, class, target, before/after, reason, `command_id`, result, `dialog_version`, `dialog_text_hash`, salted `session_ref` (VM-17).
- **Shared resources and concurrency:** Owner of `command` records; executes against owners through their interfaces.
- **Config:** `m26.a3_delay_s` (60; fixed by D-UI-13); `m26.a2_elevation_ms` (300,000); `m26.a3_assertion_max_age_ms` (60,000).
- **Edge cases and failure handling:** Duplicate submit with the same `command_id` → same result (ARCH 16.5); a submit racing a HALT → 409.
- **Acceptance criteria:** an A3 limit raise without a fresh assertion → 403 `step_up_required`; a repeated `command_id` returns the original status; every rejected command has an audit event.
- **Tests:** unit (per type); integration with M28 auth mocks; contract tests against `@bot/contract` VM-19 schemas.
- **Observability:** metrics `commands_total` (type, class, result); log code `m26.command`.
- **Security notes:** Server-side class derivation is authoritative; the UI's class is never trusted.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M26-03 — A3 scheduler: 60-second delay, re-validation at `effective_at`, cancellation

- **Module:** M26 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** Schedule A3 commands 60 s ahead, re-run the full validation at `effective_at`, apply or cancel with a reason, cancel every pending A3 command immediately on any HALT, automatic demotion or breaker trip, and handle restarts (CA-19).
- **Depends on:** B-M26-02.
- **Interfaces:** internal `Scheduler { schedule(cmd: CommandRecord, effectiveAtMs: UnixMs): void; cancel(commandId: Id, actor: Actor, reason: string): CommandStatus; cancelAllPendingA3(actor: 'system' | Actor['type'], reason: string): number; pending(): CommandRecord[] }`.
- **Logic:**
  1. Persist `effective_at` with the command; VM-03 `scheduled_change` and VM-12 `pending_change` show it with a countdown.
  2. At `effective_at`, re-run the preview validation in full: the strategy's stage and gates (M13 `evaluateGates` for promotions), cooldown and dwell, trading state (`running`, or `halted` where the command allows it), no tripped breakers, ceilings, fixed-cost burden ≤ 3% for promotions, and an unchanged `state_version` apart from changes made by the scheduled command itself. Pass → execute; fail → `cancelled` with reason code and an audit event (actor `system`).
  3. `cancelAllPendingA3` is called by B-M26-01 on any transition into `halt_requested`, by M21 on any auto-demotion or breaker trip; each cancellation is audited.
  4. Restart: re-arm persisted commands; if `effective_at` passed during downtime → cancel (risk increases need a fresh decision; ARCH M26).
  5. `cancel_scheduled` (A1) by the operator.
- **Shared resources and concurrency:** Timer on the engine's clock; commands persisted.
- **Config:** none beyond B-M26-02.
- **Edge cases and failure handling:** Scheduled promotion, then HALT/breaker/DDKILL 30 s later → cancelled immediately and audited; at T+60 nothing is applied (ARCH 16.5); gates failing at `effective_at` → cancelled with reason.
- **Acceptance criteria:** the three ARCH 16.5 A3 rows pass.
- **Tests:** unit with a fake clock; integration with M21 breaker trips.
- **Observability:** metric `a3_scheduled_total` (result); log code `m26.a3`.
- **Security notes:** The timer is server-owned; closing a browser tab neither cancels nor accelerates it (D-UI-13).
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M26-04 — Mode transitions, readiness payload, automatic demotion and the signer mode

- **Module:** M26 · **Size:** M (~2 engineer-days) · **Phase:** 2 (paper and demotion), 3 (promotions)
- **Goal:** Implement the mode machine of ARCH 7.7 with its guards, the VM-18 readiness payload, automatic demotion handling, `open_positions_policy`, and keeping the signer's own mode in step.
- **Depends on:** B-M26-03, B-M21-04. Group A: A-M13-06 `evaluateGates` and the `ExternalGateInputs` interface (C-39), A-M13-05 `Analytics.stage` and `StageMachine.onDemotion` / `onModeCommand` (resolves CL-57). Group B: `SignerClient.setMode`, `SignerClient.status`.
- **Interfaces:** `ModeController.state()`; internal `Readiness { payload(target: 'live_small' | 'live'): ReadinessVm }` producing VM-18 fields (`gates[]` from M13 `GateEvaluation`, `blocking_reasons`, `cooldown_until`, `min_dwell_until`, `caps_after_promotion` from M21 bindings for the target mode, `checklist[]` = ARCH 16.7 items 1-14 (including 3b-3d and 4b), `required_phrase`, plus `strategy_id`, `strategy_stage`, `stage_entered_at`, `trial_key` (UC-09)).
- **Logic:**
  1. Start mode: config `start_mode` (default `paper`) or the persisted mode; a live mode at start requires the persisted mode to be live **and** the signer unlocked normally; otherwise start in `paper` and positions opened in live keep being managed with real exits (`keep_managing`, which needs the signer at least in `exits_only`). **Helius guard (Z0D round 8).** While a B-10 reservation is active in the Helius account ledger, or while the engine's remaining rolling Helius headroom is below its floor (1,000,000 credits, POLICY, A-M14-05), M26 refuses every switch to paper or above (`set_mode` to `paper`, `live_small` or `live`, reason `helius_unavailable`), and at start it opens no paper session: the engine starts with entries blocked and the reason recorded. Exits of open positions are never blocked by this guard.
  2. `paper → live_small` (A3, +60 s): the active strategy's stage is `paper_passed`; VM-18 gates P-1..P-9 pass (P-7 drill within 7 days, P-8 checklist + phrase + step-up + delay); no cooldown; signer unlocked; hot wallet ≤ `HOTCAP`; fixed-cost burden ≤ 3%; at most 1 strategy live (ARCH 8.1 "Strategies live at once"; internal short code `MAXSTRAT`, CL-64). Re-checked at `effective_at`. On apply: `SignerClient.setMode('live_small')` (the signer refuses unless its own `max_mode` allows it), M21 loads live-small limits, VM-03 `live_caps` populated.
  3. `live_small → live` (A3): gates LS-1..LS-7 (LS-7: D26 (ii) or (iii) in place, or `MAXEXP` stays 2%).
  4. Lowering (A1, immediate): `set_mode` down; `SignerClient.setMode(lower)` first (fail-safe order), then engine mode; `open_positions_policy` = `keep_managing` (default) or `flatten` (M20 `flattenAll`).
  5. Automatic demotion (from M21: L-1, L-2/DDKILL, L-4): mode → `paper` immediately, actor `risk_engine`, `cooldown_until = now + 7 days`, the strategy's stage drops to `replay_passed` (M13), pending A3 commands cancelled, positions `keep_managing`.
  6. VM-18 `blocking_reasons` include every failing guard with a code.
  7. **`ExternalGateInputs` adapter (integration, C-39).** This ticket implements A-M13-06's `ExternalGateInputs` by aggregating: `drills()` from the drill records of B-M26-01 (halt acknowledgement times) and B-M29-04 (`botctl` kill drill); `checklist()` from this ticket's checklist; `paperLedgerUnexplainedDiffs()` from B-M22-05; `fixedMonthlyLamports()` from B-M23-03 and `equityLamports()` = the **real chain `E`** from B-M22-01 (CL-45); `realisedVsModelledCost()` from B-M23-03 step 4; `landing()` from B-M18-03 statistics; `reconciliation()` from B-M22-03; `signerUnlockOption()` from config of D26 (B-M17-02). Any unavailable source returns `null`/throws `input_unavailable` so the gate fails (A-M13-06 rule). The adapter is injected into M13 at engine start, so group A has no build dependency on group B for it. Owner items 3 and 5 (2026-10-07, C-49): the adapter also supplies the dry-run uptime and drill records (P-5) and the failure-injection results of the build being promoted (P-10); A-M13-06 adds the matching `ExternalGateInputs` fields, and a missing input fails the gate. **Producers (supervisor ruling, Z0D round 3; C-49):** this ticket produces only P-5 `dryRun` and P-10 `faultInjection`. `dryRun(buildSha, configKey)` comes from this ticket's dry-run block records: **every** block declared is recorded here (declaration time, `buildSha`, `configKey`, block start and end, final status `passed`, `failed` or `aborted`) before it starts, append-only, with uptime from B-M26-01 health and drills from the B-M26-01 and B-M29-04 drill records inside each block, and every block of every build in the promoted build's lineage, whatever its `configKey`, is returned (Z0D round 8). `engineHelius(fromMs, toMs)` comes from A-M14-05's Helius account ledger: for each minute it reports whether the engine's Helius allocation was 0 or below its floor, and whether a B-10 reservation was active (Z0D round 9; without it every P gate fails closed and M3 cannot exit). `faultInjection(buildSha, configKey)` returns **every** section 16.5 failure-injection run of every build in the promoted build's lineage, whatever its `configKey`, append-only (fault-injection failures are engine bugs, not configuration bugs; Z0D round 7). Fix records `{ failureId, fixCommitSha }` are appended by the operator when a fix lands, and this ticket fills their checks from the build's provenance and the integration branch's history (B-M30-01): a fix record is valid only if its fix commit is not in the failing build (not an ancestor of its `buildSha`), names the `failureId` in its commit message, adds a test that cites the `failureId` and links two CI runs of it: one on the fix commit's parent, where it fails, and one on the fix commit, where it passes, was merged to the integration branch (ARCH 3.4) through a reviewed PR, and is an ancestor of the promoted `buildSha` (`inPromotedBuild`, from the build's provenance) (Z0D round 7). A-M13-06 fails P-5 or P-10 if any block or run of the promoted build failed, or if an earlier build's failure is not cleared (rounds 4 and 5). B-9 `replayDeterminism` and B-10 `historyReplay` are **not** produced here: the adapter wraps A-M13-06's M2 bundle-backed implementation (A-M11-01's 10-replay run record; card Z-H's report) unchanged. P-6 `shadowCoverage` passes A-M12-02 `p6Stats` through unchanged.
  8. Stage changes: promotions call `StageMachine.onModeCommand`; automatic demotions call `StageMachine.onDemotion({ strategyId, reason: 'L-1' | 'L-2' | 'L-4' | 'operator' })` (DDKILL = L-2).
- **Shared resources and concurrency:** System mode (owner M26); strategy stage (owner M13, changed through its API); signer mode (owner M17, via protocol).
- **Config:** `m26.start_mode` (`paper`); `m26.cooldown_after_demotion_ms` (7 days).
- **Edge cases and failure handling:** Signer refuses `set_mode` (its `max_mode` is lower) → promotion fails with reason `signer_mode_refused` and nothing changes.
- **Acceptance criteria:** given an active B-10 reservation, then `set_mode('paper')` is refused with `helius_unavailable` and a restart opens no paper session; given engine Helius headroom of 999,999 credits, then the same; given headroom back at 1,000,000, then the switch is allowed (if every other guard holds). With any P gate failing, the promotion is rejected at submit and again at `effective_at`; an auto-demotion sets the signer to `paper` before the engine mode changes; exits of live positions continue to be signed after demotion (ARCH 16.5 CA-05 row). Producers (C-49): given a declared 48 h block with one restart drill and one disconnect drill, then `dryRun` returns that block with its `buildSha`, `configKey` and declaration time; given a block recorded only after it started, or two shorter blocks, then `dryRun` reports them as such and P-5 fails; given a failed block followed by a passing one, then `dryRun` returns both; given two fault-injection runs of one build, then `faultInjection` returns both; given a `W_P` in which the engine always had Helius above its floor and no reservation was active, then `engineHelius` returns 0 and 0 minutes; given a 10-minute engine Helius outage in `W_P`, then it returns `minutesWithoutHelius` = 10; given a failure-injection run of build X and a promotion of build Y of the same `configKey`, then `faultInjection(Y, configKey)` returns X's run as well as Y's, and P-10 fails while Y has no run of its own; given a failed run on X and a later rebuild Y, then the failed run is still returned; given the M2 bundle-backed `replayDeterminism` and `historyReplay`, then the adapter returns exactly their values (no second source).
- **Tests:** unit (guards); integration with fake M13 evaluations and the real signer.
- **Observability:** metrics `mode` (gauge), `promotions_total` (result), `demotions_total` (cause).
- **Security notes:** Promotions require the signer's independent consent (`max_mode` in a root-owned file), so a compromised engine alone cannot enable live buys or raise the live level.
- **Facts used:** ST-24, ST-33 (why demotion is automatic and immediate, via ARCH 3.4).
- **Definition of done:** Common DoD.

#### B-M26-05 — Restart recovery coordinator (ARCH 7.6)

- **Module:** M26 · **Size:** M (~2 engineer-days) · **Phase:** 2, 3
- **Goal:** Orchestrate the nine recovery steps of ARCH 7.6 at every engine start so that on-chain state is the source of truth, no attempt is double-executed, exits are re-armed within 20 s, and entries resume only when every condition holds (CL-58: ARCH lists the steps but no owner; M26 owns `starting`, so it coordinates).
- **Depends on:** B-M26-01, B-M19-04, B-M20-05, B-M22-03. Group A: M02 IDL hash check at start (start refusal).
- **Interfaces:** internal `Recovery { run(): Promise<{ entriesAllowed: boolean; reasons: string[]; report: RestartReport }> }`; `RestartReport = { downtimeMs: number; positions: Array<{ positionId: Id; pnlChangeLamports: SignedLamports }>; sentinelActions: number; resolvedAttempts: number }`.
- **Logic:**
  1. `trading_state = starting`; the signer latch remains as persisted.
  2. M24 integrity check and migrations; load config (M25); load positions, non-terminal intents and attempts. Database corrupt → `exits_only` (B-M24-04); config invalid → `exits_only` (B-M25-03); IDL hash mismatch or a failed constants self-check (A-M01-01 / A-M02-01 PDA and discriminator re-derivation, reported as `start_refused` reason `other` with the failing constant) or anything that prevents `exits_only` → `start_refused` to the sentinel, exit (systemd restart limit stops a loop); the out-of-band notifier fires in every case.
  3. Attempts with signatures in `in_flight`/`unknown`: `getSignatureStatuses` with `searchTransactionHistory: true`, then the transaction (version 1); resolve or keep checking until expiry is proven (B-M18-04); check balances before marking expired.
  4. Intents in `signing` without a stored signature: `statusOf(intentId)`; adopt or mark the attempt `build_failed` and the intent `cancelled` (entries) / re-queue (exits).
  5. Import the sentinel fill journal if present (B-M20-05); reconcile (B-M22-03); link or create orphans; after a database restore run `rebuildFromChain` (B-M22-06).
  6. Acquire the exit lease `all` (non-force); re-arm exits for every open position whose mint lease the engine holds (target ≤ 20 s after start); exits are allowed during `starting` and `exits_only`.
  7. Re-arm scheduled commands; cancel A3 commands whose `effective_at` passed (B-M26-03).
  8. Entries resume (`running`) only if: reconciliation diff ≤ 10,000 lamports after flows are classified, no `reconciling` intent older than 120 s, the previous trading state was `running`, no breaker tripped, the engine holds the exit lease, and the signer is unlocked normally; otherwise `halted` with reason `restart_unreconciled`.
  9. Restart report alert: each open position's PnL change over the downtime and any sentinel actions.
- **Shared resources and concurrency:** Runs before any other engine loop work; owners perform their own changes through their interfaces.
- **Config:** `m26.rearm_target_ms` (20,000; alert if exceeded).
- **Edge cases and failure handling:** Signer locked at start with live positions → exits cannot be signed; the sentinel's notifier is the alert path (D26, D27); the engine stays `starting`/`halted` and re-checks every 10 s.
- **Acceptance criteria:** restart drill (checklist 3): kill the engine with an open paper position; recovery completes and re-arms exits within 20 s; the ARCH 16.5 crash rows end in their documented states.
- **Tests:** integration (crash at each step); failure injection rows of ARCH 16.5 for restarts.
- **Observability:** metric `recovery_duration_ms`, `rearm_ms`; log code `m26.recovery_step`.
- **Security notes:** None beyond conventions.
- **Facts used:** LD-05, DA-08.
- **Definition of done:** Common DoD.

---

### M27 Observability and alerts

#### B-M27-01 — Metrics registry, rollups, loopback `/metrics` and structured logs with redaction

- **Module:** M27 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** In-process metrics (counters, gauges, histograms) at 1 s resolution for 24 h with 1-minute rollups for 1 year in SQLite, a loopback-only text `/metrics` endpoint, and JSON-lines logs with schema-based redaction (ARCH 13.1, 13.2, 12.4).
- **Depends on:** B-M19-01.
- **Interfaces:** `metric.counter(name, labels)`, `metric.gauge(name, labels)`, `metric.histogram(name, buckets)`, `log.event(level, code, fields)` (ARCH M27).
- **Logic:**
  1. Every metric named in this document and ARCH 13.1 is registered with its labels; label values are bounded (pool and mint labels only for watched pools and open positions; cardinality cap 5,000 series, excess dropped with a counter).
  2. 1 s ring buffers for 24 h; 1-minute rollups (`count, sum, p50, p95, p99`) written to `metric_rollup_1m` (append-only, 1 year).
  3. `/metrics` on `127.0.0.1` only (no third-party monitoring SaaS; UI rule).
  4. Logs: JSON lines with `ts` (RFC 3339 UTC ms), `level`, `module`, `code`, `run_id`, `mode`, correlation IDs, typed fields with units in names; each `code` has a field schema; fields marked `secret` and any string containing a URL query parameter named like a key (`api-key`, `api_key`, `key`, `token`) are replaced with `[redacted]`; untrusted token strings length-limited (symbol 32, name 64 bytes) and escaped. Retention 14 days, rotated and compressed; error and above copied into the alert store.
  5. Log sink full → drop debug, keep warn and above (ARCH M27).
- **Shared resources and concurrency:** Owner of the metric registry and log sink.
- **Config:** `m27.series_cap` (5,000), `m27.log_retention_days` (14).
- **Edge cases and failure handling:** Metric write on a hot path never blocks (in-memory increments only).
- **Acceptance criteria:** a log event with a field containing `https://x?api-key=abc` is written as `[redacted]`; `/metrics` is unreachable from the tailnet address.
- **Tests:** unit (redaction fuzz with random URLs and secret-shaped strings); secret scan of logs produced by the full test suite (ARCH 16.6).
- **Observability:** self-metrics `metrics_series`, `log_dropped_total`.
- **Security notes:** Redaction is defence in depth; modules must not pass secrets to logs in the first place.
- **Facts used:** LD-V06 (why URLs may carry keys; ARCH 12.4).
- **Definition of done:** Common DoD.

#### B-M27-02 — Alert rules, lifecycle, health aggregation (VM-13) and out-of-band forwarding

- **Module:** M27 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** Implement every alert of ARCH 13.4 with dedupe keys and lifecycle (open, acknowledged, snoozed, resolved), storm aggregation, `HealthSnapshot` for VM-13 (including `safety[]`, UC-17), and forwarding of every critical alert to the sentinel's notifier (D27).
- **Depends on:** B-M27-01, B-M24-02. Group A: M14 `health()`, `creditUsage()`; M03 `health()`; group B: M18 tx stats, M26 heartbeat channel.
- **Interfaces:** `alerts.raise({ dedupeKey, severity, category, title, body, entity })`, `health(): HealthSnapshot` (ARCH 5.0a).
- **Logic:**
  1. Rules table = ARCH 13.4 (each with condition, severity and category: `risk`, `execution`, `health`, `cost`, `config`, `security`, `mode`, `reconciliation`); `title`/`body` composed server-side with no secrets.
  2. Dedupe by `dedupeKey` (unique while not resolved); `occurrences` incremented; storms (> 20 alerts per minute) aggregated by key.
  3. Critical alerts: not snoozable (VM-16 `snoozable = false`), and forwarded over the heartbeat socket as `critical_alert` (B-M26-01) to the sentinel's notifier; in-app delivery is never the only channel for a critical alert.
  4. Health: `overall` = worst of providers, streams, tx window and safety; `tx.landing_definition` = "confirmed within 20 slots of first send"; `safety[]` = `sentinel_heartbeat` (age), `notifier_last_test` (from sentinel status), `watcher_last_poll` (from sentinel status), `signer_lock`, `exit_lease`; `rpc[].projected_month_end_bps` from M14's burn-rate projection (UC-17).
  4b. Decision-branch switch triggers (integration, coverage of ARCH 6 "switch when" conditions; each is an `info` alert for the operator, never an automatic switch, CL-34): D01 `/build` "No routes found" on > 5% of paper exit attempts in 7 days (B-M16-06 metric, when `/build` is enabled); D05 build + sign segment p95 > 30 ms (`build_sign_segment_ms`, CL-14) or event-loop lag p99 > 50 ms; D06 SQLite write p99 > 20 ms or database > 20 GB (B-M24-01 metrics); D07 memory > 75% or CPU > 70% sustained over 24 h; D09 and D16 triggers raised by B-M20-04 and B-M23-05. Thresholds are config keys with the ARCH 6 values as defaults.
  5. Unexpected egress alert: reads the host firewall's log counter exposed by B-M30-02 (file or journald field) (**VERIFY** the mechanism on the host).
- **Shared resources and concurrency:** Owner of alert records and dedupe keys.
- **Config:** `m27.storm_threshold_per_min` (20).
- **Edge cases and failure handling:** Sentinel unreachable → critical alerts still recorded in-app and "sentinel down" raised; the operator-side watcher notices the sentinel status endpoint failing (D27).
- **Acceptance criteria:** every ARCH 13.4 alert has a unit test that triggers it; a critical alert produces exactly one `critical_alert` message to the sentinel.
- **Tests:** unit; integration with a fake sentinel.
- **Observability:** metrics `alerts_open` (severity), `alerts_forwarded_total`.
- **Security notes:** Alert bodies sent out of band contain codes only when the D27 channel is a third party (B-M29-03 enforces).
- **Facts used:** none external.
- **Definition of done:** Common DoD.

---

### M28 Dashboard API gateway

#### B-M28-01 — `@bot/contract`: zod schemas for VM-01..VM-21 with the ARCH section 19 changes

- **Module:** M28 (package owner) · **Size:** M (~2 engineer-days) · **Phase:** 0 (frozen before UI and backend tickets start)
- **Goal:** One shared package with the zod schemas of every view model exactly as `UI.md` defines them, updated with UC-01..UC-21 and bumped `schema_version`s, imported by the SPA (UI-T08) and the server, with fixtures and contract tests.
- **Depends on:** B-M30-01. Consumers: SPA (UI-T08 and later), M13 (fixtures for VM-09/VM-18/VM-21).
- **Interfaces:** `export const VM01Envelope, VM02Session, …, VM21Runs: z.ZodType`; `export const SCHEMA_VERSIONS: Record<'VM-01' | … | 'VM-21', number>`; shared scalars `U64Str`, `I64Str`, `LamportsStr`, `I128Str`, `DecimalStr`, `Pubkey`, `Signature`, `Id`, `Mode`, `Commitment`, `Severity`, `ActionClass`, `UntrustedString(maxBytes)`.
- **Logic:**
  1. Encode the `UI.md` conventions verbatim (regexes for `U64Str` `^(0|[1-9][0-9]{0,19})$` with ≤ 18446744073709551615, `I64Str`, `I128Str`, `DecimalStr` without exponent; base58 lengths; ULID 26 chars; nullable fields only where documented, each with its `*_unavailable_reason` sibling or documented meaning).
  2. Apply section 19 of ARCH: UC-01 (VM-06 `exit_reason` enum, `source`, `shadow`), UC-02 (VM-05 `stops[]`, `targets[]` arrays with item type `price | pnl_pct | trailing | time`), UC-03 (`entry_unconfirmed` risk flag code documented), UC-04 (VM-12 `action_on_breach` extended), UC-05 (`display_unit`, `limit_value_display`), UC-06 (`sentinel`, `cli` actor types in VM-03 and VM-17), UC-07 (VM-03 `trading_state` adds `exits_only`; `kill.latch_set_by`, `kill.latch_clear_requires`, `signer.lock`, `signer.exit_lease_holder`), UC-09 (VM-18 unit `ratio`, top-level `strategy_id`, `strategy_stage`, `stage_entered_at`, `trial_key`), UC-12 (VM-21 Imported runs; `sim_clock` always null on the live host), UC-13 (VM-04 `token_class`, `role = reserve` wallets), UC-14 (VM-19 types `write_off_position`, `close_unsolicited`; blocking reason `book_not_flat`), UC-17 (VM-13 `safety[]`, `rpc[].projected_month_end_bps`), UC-18 (no 15 s resolution). Each changed VM's `schema_version` is incremented; unchanged VMs keep version 1.
  3. VM-01 `vm` enum extends to `VM-21`.
  4. Fixtures per VM: happy path, empty, null fields, maximum-length untrusted strings, u64 maximum values (`"18446744073709551615"`), negative PnL, simulated and live (UI conventions); fixture public keys and signatures are randomly generated test values, never real wallets.
  5. Contract tests: every fixture parses; every projection output (B-M28-03) parses; the backend `ExitReason` union equals VM-06 `exit_reason` (UC-01, CB-11); BigInt round trip.
- **Shared resources and concurrency:** Package versioning (semver); changes need both the UI and backend leads' sign-off.
- **Config:** none.
- **Edge cases and failure handling:** A field present in `UI.md` but impossible to serve → not dropped silently: documented as always-null with a reason code and raised as a UI change request.
- **Acceptance criteria:** the SPA's UI-T08 suite and the backend's projection tests both import the same package version; `VM-05` fixture with a single `stop` object (old shape) fails validation at the new version.
- **Tests:** unit (schemas), property (random valid payloads round-trip), fixture suite.
- **Observability:** none.
- **Security notes:** `UntrustedString` enforces byte limits (symbol 32, name 64).
- **Facts used:** VF-16 (package versions and licences); otherwise none from the register (UI conventions cite UI-F30/UI-F31 in `UI.md`). VERIFY: the zod version and licence pinned by UI-T01 (the UI document lists a version; confirm at build time).
- **Definition of done:** Common DoD; package tagged and consumed by UI-T08.

#### B-M28-02 — HTTP server, network exposure, passkey authentication, sessions, CSRF and step-up

- **Module:** M28 · **Size:** L (~3 engineer-days) · **Phase:** 2 (login, sessions), 3 (step-up for A2/A3 live)
- **Goal:** Serve the API and the SPA's static files on loopback only, reachable over the tailnet (D19), with WebAuthn passkey login, `__Host-` session cookies, CSRF defences, Host allowlist, CSP, timeouts, roles, rate limits, mobile restrictions and auditing (ARCH 12.5; `UI.md` authentication controls).
- **Depends on:** B-M28-01, B-M24-02. Group B: B-M24-03 (audit), B-M26-02 (commands).
- **Interfaces:** REST endpoints `POST /api/v1/auth/webauthn/login/options`, `…/login/verify`, `…/step-up/options`, `…/step-up/verify`, `POST /api/v1/auth/logout`, `GET /api/v1/me`, `GET|PUT /api/v1/me/preferences` (ARCH 14.3; VM-02); internal `AuthContext { actor: Actor; role; clientKind; sessionRef: string; elevatedUntilMs: UnixMs | null; lastAssertionAtMs: UnixMs | null }`.
- **Logic:**
  1. Bind to `127.0.0.1` only (never `0.0.0.0`; D19). Exposure over the tailnet uses Tailscale's own local forwarding of a loopback port or an equivalent tailnet-only listener (**VERIFY** the Tailscale mechanism and Personal-plan terms, A-28, UI-F41; CL-59); fallback SSH port-forward (D-UI-09 option C). HTTPS on the tailnet name where available; HTTP/2 when TLS is used (one SSE stream per browser, UI D-UI-10).
  2. WebAuthn: **VERIFY** and select a WebAuthn server library (ARCH 12.3 lists it as VERIFY) or implement assertion verification with Node built-in `crypto` (W3C WebAuthn Level 3 per `UI.md` UI-F40); credentials stored in `webauthn_credential` (public key, counter). First-passkey enrollment: `botctl enroll-passkey` prints a single-use enrollment token valid 10 minutes, consumed by a registration endpoint that exists only while a valid token exists (CL-60).
  3. Sessions: `__Host-` cookie, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`; session ID rotated at login and step-up; stored hashed; idle 30 min, absolute 8 h; `session_ref` in audit = salted hash.
  4. CSRF: synchronizer token (`X-CSRF-Token`) on every non-GET plus `Sec-Fetch-Site: same-origin` required; Host header allowlist (tailnet name, `localhost:<port>`) on every request (DNS rebinding); `Idempotency-Key` required on commands.
  5. Headers: CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` (UI); no source maps served.
  6. Roles: `viewer` (read-only; never receives `csrf_token` for commands) and `operator`. Step-up: A2 requires elevation within 5 min; A3 requires an assertion ≤ 60 s old (B-M26-02).
  7. Client kind: declared at login by the mobile route (`/m`); mobile sessions may subscribe only to `digest`, `alerts`, `positions`, `system` and are refused A2/A3 commands (`403 mobile_forbidden`). Limitation recorded: the client kind is self-declared; the binding protection for A2/A3 is the passkey step-up, not the client kind (CL-63).
  8. Rate limits: login 5 attempts per 15 min per IP with exponential back-off; commands 30 per minute per session; `POST /api/v1/ui-diagnostics` 10 per minute.
  9. Audit: login, failed login, step-up, logout, every command (VM-17).
- **Shared resources and concurrency:** Owner of sessions, WebAuthn credentials, CSRF tokens (ARCH M28).
- **Config:** `m28.bind_port`, `m28.allowed_hosts` (list), `m28.idle_ms` (1,800,000), `m28.absolute_ms` (28,800,000), `m28.login_rate` (5 per 15 min).
- **Edge cases and failure handling:** Browser without WebAuthn → login impossible; recovery is `botctl enroll-passkey` on the host (UI-T09 edge case).
- **Acceptance criteria:** a request with Host `evil.example` → 403; a non-GET without CSRF token → 403 `csrf`; a viewer posting a command → 403 `role`; after 30 idle minutes the session is invalid; a public-interface port scan finds nothing (checklist item 8).
- **Tests:** ARCH 16.6 dashboard list (CSRF, Host header, CSP, session fixation, step-up expiry, mobile forbidden actions, XSS through maximum-length untrusted names using UI fixtures); unit; integration with a virtual authenticator if available (UI U-07) or mocked assertions.
- **Observability:** metrics `logins_total` (result), `http_requests_total` (route, status); log codes `m28.login`, `m28.csrf_reject`, `m28.host_reject`.
- **Security notes:** No keys, seeds or RPC credentials ever reach the browser; the dashboard has no signing or key export feature.
- **Facts used:** TH-49 (alternatives considered in `UI.md`, not used). VERIFY: A-28, WebAuthn library, Tailscale forwarding.
- **Definition of done:** Common DoD; security review signed off before Phase 3.

#### B-M28-03 — VM projection layer (VM-02..VM-21)

- **Module:** M28 · **Size:** L (~3 engineer-days) · **Phase:** 2
- **Goal:** One projection function per VM converting internal camelCase records into the snake_case VM payloads, applying unit conventions, dropping internal-only fields, and computing every derived field in ARCH 14.4 (CB-12).
- **Depends on:** B-M28-01, B-M21-01, B-M22-01, B-M20-01, B-M23-03, B-M23-04, B-M26-01, B-M27-02, B-M25-01 (integration: producing tickets named). Group A: A-M04-01, A-M05-01, A-M06-02 (`TokenMetadataCache`), A-M06-03, A-M08-03 (`bar_1m`), A-M09-01 (strategies), A-M13-04 (`PerfStats`, series), A-M13-06 (`GateEvaluation`), A-M13-08 (runs), A-M14-05 (health), A-M07-03 (coverage gaps). Each VM's projection can be built against fixtures first; its contract test against the producer waits for that producer.
- **Interfaces:** `type Projection<V> = (sources: ProjectionSources, args?: Record<string, string>) => Result<V, { code: 'vm_unavailable'; vm: string; reason: string }>`; one per VM.
- **Logic (derivations from ARCH 14.4; everything else is copied):**
  1. VM-03: `kill.components[]` = M19, M20, M21, signer latch, sentinel; `trading_state` includes `exits_only`; signer fields from M17 status via M26; `sim_clock = null`; `live_caps` from M21 bindings (null when not live).
  2. VM-04: `sol_lamports` includes wSOL; `reserved_lamports` includes the exit fee float; `available_lamports` = sol − reserved floored at 0; `equity_lamports` = `E`; simulation payer and cold wallet with `role = reserve`; `tokens[].token_class`; `reconcile_diff_lamports` = ledger − chain after flows; symbols from M06 `TokenMetadataCache` (untrusted, length-limited).
  3. VM-05: from M20 `Position` and `Mark`; `stops[]`/`targets[]` from `triggers`; `mark_method = exit_quote`; `unrealized_pnl_net_lamports` = exit_value_est − entry_cost + realized_partial; `entry_fees.*` from M23; state mapping (`stuck` → `close_failed` + reason; `orphan` → `open` + flag `orphan`; `opening` with armed exits → flag `entry_unconfirmed`); `open_failed`/`written_off` excluded.
  4. VM-06: invariant check per row (`net = gross − costs`; a violating row → 503 for the page and a critical alert, never served wrong); extended `exit_reason`; `source`, `shadow`.
  5. VM-07: every applicable check including skipped; `severity` dropped and failed soft checks shown as `warn`; `quote_age_ms` = observation lag slots × measured slot duration.
  6. VM-08: `holders_top[]` from M06 owner resolution; pools from M04.
  7. VM-09: from `PerfStats` (CI methods bootstrap 95% and Wilson 95%); drawdowns flow-adjusted.
  8. VM-10: `equity`/`drawdown` from `equity_point`; `price_ohlc` 1m/5m/1h/1d aggregated from `bar_1m` (no 15 s); `gaps[]` from M07 coverage; values as JSON numbers with an assertion `|v| < 2^53`.
  9. VM-11: fixed costs prorated from VM-14 items; `equity_change_bps` flow-adjusted.
  10. VM-12: `daily_loss.used_lamports` per M21's definition; `action_on_breach` extended enum; `display_unit`, `limit_value_display`.
  11. VM-13: from M27 `health()`; `tx.landing_definition` = "confirmed within 20 slots of first send"; `safety[]`.
  12. VM-14: janitor closes and rung-2+ double tips included; `break_even_monthly_return_bps` = fixed monthly ÷ `E`.
  13. VM-15: secrets show `is_set` only; VM-16 critical alerts `snoozable = false`; VM-17 actor types include `sentinel` and `cli`; VM-18 from B-M26-04; VM-19 from M26; VM-20 aggregates M26, M22, M13, M20, M21, M27, M18; VM-21 from imported runs (M13).
  14. Every money VM carries `mode` and `simulated`; nulls carry reasons; big integers as decimal strings.
  15. Projection failure for a VM → that topic emits nothing and its REST endpoint returns 503 `vm_unavailable` with `vm` and reason; the engine keeps trading (ARCH M28).
- **Shared resources and concurrency:** Read-only access to owners' in-memory views and the reader DB connection.
- **Config:** none.
- **Edge cases and failure handling:** A source module temporarily unavailable → fields null with reason codes, never 0 (UI convention 6).
- **Acceptance criteria:** every projection's output validates against `@bot/contract` for every fixture scenario; the VM-06 invariant violation test returns 503 and raises an alert.
- **Tests:** fixture-driven contract tests per VM; property tests with random internal records.
- **Observability:** metrics `projection_errors_total` (vm), `projection_ms` (vm).
- **Security notes:** Untrusted strings are length-limited server-side; endpoint labels only, never URLs.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M28-04 — SSE stream: envelopes, topics, replay buffer, heartbeat, coalescing

- **Module:** M28 · **Size:** M (~1.5 engineer-days) · **Phase:** 2
- **Goal:** `GET /api/v1/stream?topics=…` delivering VM-01 envelopes over Server-Sent Events with per-connection `seq`, a 120 s replay buffer keyed by `Last-Event-ID`, heartbeats every 2 s, `ui_supported` negotiation, coalescing and client shedding (ARCH 14.2; UI D-UI-10).
- **Depends on:** B-M28-02, B-M28-03.
- **Interfaces:** `text/event-stream`; each event `id: <seq>`, `event: <kind>`, `data: <VM-01 envelope>`; topics `session`, `system`, `balances`, `positions`, `journal`, `signals`, `token:{mint}`, `series:{series}`, `pnl_summary`, `risk`, `health`, `config`, `alerts`, `audit`, `commands`, `digest`, `runs`.
- **Logic:**
  1. On connect: authenticate (cookie), validate topics (`token:{mint}` mint must be base58 32-44 chars), send `ui_supported` and initial `snapshot`s; incompatible versions → `incompatible` event.
  2. `seq` monotonic per connection lineage; replay of the last 120 s when `Last-Event-ID` is within the buffer, otherwise `event: reset`.
  3. Heartbeat every 2 s with `server_time`, `state_version`, `topics`.
  4. Coalescing: marks ≤ 1 Hz per position; signals ≤ 10 events/s; health and digest every 2 s; series tails ≤ 1 point per 5 s.
  5. Envelope `clock` always `wall`; `mode` and `run_id` from M26.
  6. Mobile sessions: only `digest`, `alerts`, `positions`, `system`.
  7. More than 4 concurrent SSE clients → shed the oldest (ARCH M28); events sourced from the M24 outbox after commit.
- **Shared resources and concurrency:** SSE connection state and the replay buffer (owner M28).
- **Config:** `m28.replay_ms` (120,000); `m28.max_sse_clients` (4).
- **Edge cases and failure handling:** Slow client (send buffer full for 10 s) → disconnect; the UI reconnects with `Last-Event-ID`.
- **Acceptance criteria:** UI-T08 acceptance 1 (seq gap → refetch) and 2 (no heartbeat → disconnected) pass against the real server; server SSE emit lag p95 ≤ 20 ms (ARCH 10.3).
- **Tests:** integration with an SSE client; load test 50 events/s.
- **Observability:** metrics `sse_clients`, `sse_emit_lag_ms`, `sse_replays_total`, `sse_resets_total`.
- **Security notes:** Session checked on connect and every 60 s; a revoked session closes the stream.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

#### B-M28-05 — REST endpoints, search, journal CSV, audit verify, runs and diagnostics

- **Module:** M28 · **Size:** M (~2 engineer-days) · **Phase:** 2
- **Goal:** Every REST endpoint of ARCH 14.3 with the common error format and status codes, plus static SPA serving.
- **Depends on:** B-M28-02, B-M26-02, B-M24-03, B-M23-04.
- **Interfaces:** ARCH 14.3 table (base `/api/v1`): `/vm/{vm}`, `/digest`, `/system`, `/balances`, `/positions`, `/journal`, `/journal.csv`, `/journal/export.csv`, `/search`, `/signals`, `/tokens/{mint}`, `/performance`, `/series`, `/pnl-summary`, `/risk`, `/health`, `/costs`, `/config`, `/config/validate`, `/alerts`, `/audit`, `/audit/verify`, `/mode/readiness`, `/commands/preview`, `/commands`, `/commands/{id}`, `/commands/{id}/cancel`, `/runs`, `/runs/{run_id}`, `/ui-diagnostics`. Error body `{ error: { code, message, vm, field_errors, retry_after_ms } }`; codes 200, 400, 401, 403 (`step_up_required` | `role` | `mobile_forbidden` | `csrf` | `class_changed`), 404, 409 (`state_changed` | `config_version_mismatch`), 422, 429, 503 (`vm_unavailable`).
- **Logic:**
  1. Query parameters validated with zod (cursor opaque, `limit` ≤ 200, mints base58).
  2. `/search?q=`: exact base58 match first (mint, signature, position or trade ID), then symbol matches listing **every** mint with that symbol (never auto-picking; UI-T12).
  3. `/journal.csv` and `/journal/export.csv`: operator role; streamed (B-M23-04).
  4. `/audit/verify`: returns `{ valid, first_bad_event_id }` from M24 `verifyChain`.
  5. `/performance` cached 60 s, invalidated on trade close.
  6. `/runs`: read-only list of imported runs (VM-21); there is **no** endpoint that starts a run (CA-26, D29).
  7. `/ui-diagnostics`: accepts VM ID, field path and issue code only; strings > 64 chars truncated; no PII or secrets stored.
  8. Static files: the SPA build served from a read-only directory with the CSP of B-M28-02.
- **Shared resources and concurrency:** Read-only queries; commands delegate to M26.
- **Config:** none beyond B-M28-02.
- **Edge cases and failure handling:** A VM projection failing → 503 for that endpoint only.
- **Acceptance criteria:** every endpoint has a contract test against `@bot/contract`; a symbol search matching 3 mints returns 3; `POST /api/v1/runs` returns 404/405.
- **Tests:** integration per endpoint; fuzzing of query parameters.
- **Observability:** `http_requests_total` (route, status), `http_latency_ms` (route).
- **Security notes:** Operator-only endpoints enforce role; no endpoint returns secrets or URLs.
- **Facts used:** none external.
- **Definition of done:** Common DoD; UI fixture suite runs against the real server (UI-T08 DoD).

---

### M29 Kill sentinel, standalone exit, notifier and ops CLI (separate process)

#### B-M29-01 — Sentinel process, heartbeat server, watchdog latch and balance-drop latch

- **Module:** M29 · **Size:** M (~2 engineer-days) · **Phase:** 3 (the `import-run` spool ticket B-M29-05 is Phase 1)
- **Goal:** An independent process (user `sentinel`) that watches the engine's heartbeat, sets the signer latch when the engine is silent for 10 s, keeps its own cache of live positions, and latches on an unexplained hot-wallet balance drop (CA-01, CA-17).
- **Depends on:** B-M17-08 (signer protocol on `ops.sock`). Uses the heartbeat protocol of B-M26-01.
- **Interfaces:** server socket `/run/sentinel/engine.sock` (mode 0660, group `bot`); messages `EngineToSentinel`/`SentinelToEngine` (B-M26-01) with the heartbeat extended by `positions: Array<{ mint: Pubkey; poolId: Pubkey; venue: VenueId; tokenProgram: Pubkey; sizeBase: BaseUnits }>` (CL-61); state file `/var/lib/sentinel/state.json` (fsync'd).
- **Logic:**
  1. Accept heartbeats; reply `ack`; persist the last `positions` list and `mode` (so a crash-looping engine still leaves the sentinel a list).
  2. Heartbeat missing 10 s → `latch({ kind: 'halt', reason: 'sentinel_watchdog' })` on the signer (identity `sentinel`), notify (B-M29-03). The latch can then be cleared only by `botctl resume-latch` (D28).
  3. Live positions exist when the cached list has live-mode positions **or** the hot wallet holds tokens of mints in the cached list (read by the sentinel itself).
  4. Takeover trigger evaluation (B-M29-02): no healthy heartbeat for 120 s **and** live positions **and** signer `unlocked` (or `exits_only`), or a `start_refused` message → immediate takeover.
  5. Balance-drop latch: every 60 s read the hot wallet's SOL (own endpoint, Chainstack per ARCH 11.2); a drop larger than the signer day cap (1,000,000,000) over the window, **after excluding** sweeps listed in the signer's `lastSweeps`, → latch + notify (CA-17).
  6. Signer locked while live positions exist (checked every 60 s and immediately at sentinel start, covering host reboots) → notify (D26, D27).
  7. A healthy heartbeat = `tradingState` not `stopped`, `eventLoopLagMs` < 1,000.
- **Shared resources and concurrency:** Owner of watchdog state (ARCH 7.2); signer state changed only through its protocol.
- **Config:** `/etc/sentinel/config.json` (root-owned): `heartbeat_timeout_ms` (10,000), `takeover_after_ms` (120,000, POLICY), `balance_check_ms` (60,000), `read_endpoints` (2 labels; keys via systemd credentials), `hot_wallet_pubkey`, `day_cap_lamports`.
- **Edge cases and failure handling:** Sentinel restarts → reloads cached positions; systemd restarts it; the engine alerts on missing acks; the operator-side watcher alarms if `/status` stops answering.
- **Acceptance criteria:** "Sentinel kills engine heartbeat" (ARCH 16.5): latch set; entries refused by the signer even if the engine resumes without a command; daily sweep larger than the signer day cap → no latch (ARCH 16.5).
- **Tests:** integration with a fake engine and the real signer; failure injection (engine hang, engine crash loop, sweep).
- **Observability:** sentinel JSON logs (journald) with codes `sentinel.heartbeat_lost`, `sentinel.latched`, `sentinel.balance_drop`; status endpoint fields (B-M29-03).
- **Security notes:** Runs as `sentinel`; no access to the hot key; its only powers are latch, lease and the standalone exit path through the signer's policy.
- **Facts used:** none external.
- **Definition of done:** Common DoD; checklist item 2 sentinel watchdog drill passes.

#### B-M29-02 — Takeover and the standalone exit path

- **Module:** M29 · **Size:** L (~3 engineer-days) · **Phase:** 3 (Raydium additions in 3b)
- **Goal:** When the engine is down (or refused to start) with live positions, force-acquire the exit lease, stop the engine unit, and flatten every live position through a minimal standalone exit path that does not depend on the engine, its database, Jupiter, M04, M14 or M15 (CA-13).
- **Depends on:** B-M29-01, B-M16-04 (direct adapter and temporary-wSOL composition as a dependency-light package), B-M18-04 (shared expiry-proof package). Group A: M01 quote math and M02 decoders as **pinned copies** with their own hash check (ARCH M29).
- **Interfaces:** internal `Takeover { start(reason: 'heartbeat_timeout' | 'start_refused' | 'operator_flatten'): Promise<void>; status(): { running: boolean; positions: number; done: number } }`; fill journal `/var/lib/sentinel/fills.ndjson` lines `{ signature, mint, sellBase, solDeltaLamports, feeLamports, tipLamports, slot, atMs }` (fsync'd).
- **Logic:**
  1. `lease({ kind: 'acquire', scope: 'all', force: true })` on the signer; stop the engine unit with `systemctl stop engine` through a sudoers or polkit rule that allows exactly that command for user `sentinel` (**VERIFY** the mechanism on the host, A-39); notify "takeover started".
  2. For each cached live position with an on-chain balance > 0: read pool state and vaults with `getMultipleAccounts` from its own endpoints (**VERIFY** the 100-account limit, A-06), decode with its pinned M02 copy, quote with its pinned M01 copy, read the ATA balance, fetch a blockhash (`getLatestBlockhash`, VERIFY), build a direct-adapter sell with the temporary-wSOL composition starting at **rung 2** (300 bps slippage, 2 × the configured entry cap priority, Sender + Jito tips), sign through `ops.sock` (identity `sentinel`, lease held).
  3. Send loop: 1 send per second per path (Sender keyed HTTPS and one RPC send path); same rebroadcast-by-signature rule; status polling; the same expiry proof as M18 (shared package). Escalate 2 → 3 (800 bps) → 5 (25% chunks, 1,500 bps); rung 4 (Jupiter `/order`) is used **only** if the sentinel's IDL copy fails its hash check, classified by the signer's simulation (ARCH M29).
  4. Every confirmed sale appended to the fill journal (with fsync) before moving on; never more than 2 unexpired exit messages per mint (signer-enforced).
  5. `botctl flatten --max-slippage-bps n` with the engine heartbeat missing > 10 s runs the same path (`operator_flatten`) capped at `n` (≤ 2,500).
  6. Finish: notify "takeover finished" with counts; the engine imports the journal at recovery (B-M20-05); the lease is released only by `botctl release-lease`.
- **Shared resources and concurrency:** Exit lease (owner M17); the sentinel fill journal (owner M29); the engine is stopped first so the two cannot both manage exits.
- **Config:** `/etc/sentinel/config.json`: `send_endpoints` (Sender label, RPC label), `entry_cap_priority_lamports` (50,000), `tip_accounts` (identical to the signer's), `pinned_idl_sha256`.
- **Edge cases and failure handling:** Signer locked → takeover impossible; notify "signer locked with live positions" (residual risk stated in D26); a position the engine sold just before dying → `E_ZERO_BALANCE` → skipped; journal write failure → stop sending new attempts, notify critical.
- **Acceptance criteria:** takeover drill (checklist 3c): engine stopped with an open position → after 120 s the sentinel takes the lease and flattens through the standalone path; the restarted engine gets `E_LEASE`, imports the journal, resumes exits only after `release-lease`; no double sell (ARCH 16.5 "Engine down 130 s"). IDL hash mismatch with live positions → immediate takeover (ARCH 16.5).
- **Tests:** integration on mainnet state with simulation only (no signing) for builds; full drill in live-small with 0.01 SOL (checklist 3b/3c); failure injection (engine restarts mid-takeover: it is stopped and cannot sign exits because of the lease).
- **Observability:** journald logs `sentinel.takeover_start`, `sentinel.exit_sent`, `sentinel.exit_filled`, `sentinel.takeover_done`; status endpoint `takeover`.
- **Security notes:** Minimal dependency set: internal packages plus `@solana/kit` only (ARCH 12.3); dependency tree reviewed separately; never runs third-party bot code.
- **Facts used:** LD-07, LD-17, LD-22, EX-25. VERIFY: A-06, A-39, `getLatestBlockhash` (A-31).
- **Definition of done:** Common DoD; drill recorded with timestamps for the go-live checklist.

#### B-M29-03 — Out-of-band notifier, tailnet status endpoint and the operator-side watcher

- **Module:** M29 · **Size:** M (~1.5 engineer-days) · **Phase:** 3
- **Goal:** Deliver critical events without the engine (D27): the sentinel's notifier, a tailnet-only `GET /status` endpoint, and a small watcher script on the operator's machine that alarms locally, including when the host stops answering.
- **Depends on:** B-M29-01.
- **Interfaces:** `GET /status` → `{ engine: 'up' | 'down' | 'start_refused'; signer_lock: 'locked' | 'unlocked' | 'exits_only'; latch: 'clear' | 'set'; live_positions: number; last_heartbeat_at: string | null; takeover: 'idle' | 'running' | 'done' }` (ARCH M29); `Notifier { send(event: { code: string; severity: 'critical' | 'warning' | 'info'; atMs: UnixMs }): void }`.
- **Logic:**
  1. Events: engine heartbeat lost; engine start refused; `exits_only` entered; signer locked with live positions; takeover started/finished; any critical alert forwarded by M27; weekly test message (ARCH M29).
  2. Channel (a), default: the watcher on the operator's machine polls `GET /status` over the tailnet every 60 s and raises a local desktop notification and sound when the host does not answer for 3 polls, the engine is down, the signer is locked with live positions, or a takeover is running. No third-party service. Its gap is stated: if the operator's machine is off or asleep, nobody is told (D27). **VERIFY** the notification command on the operator's OS.
  3. Channel (b), optional: a self-hosted push server reached over the tailnet (software and phone app UNVERIFIED; new dependency review required).
  4. Channel (c), only with the operator's explicit recorded consent (config flag with a timestamp and a consent text hash): message bodies contain codes only, no wallet addresses, amounts or token names.
  5. `/status` listens on a separate port bound to the tailnet interface only (tailnet ACL to the operator's devices; **VERIFY** binding method), no authentication beyond the tailnet (read-only, no secrets, no amounts).
  6. Notification drill (checklist 3d): stop the engine, refuse a start, cut the host's network; each event reaches the operator within 5 minutes.
- **Shared resources and concurrency:** Notifier config (owner M29).
- **Config:** `/etc/sentinel/config.json`: `status_bind`, `notify_channels` (`watcher` default; `push`; `third_party` with consent record), `weekly_test_utc`.
- **Edge cases and failure handling:** Status endpoint unreachable because the host is down → the watcher alarms after 3 polls.
- **Acceptance criteria:** checklist item 3d passes for the chosen channels; a third-party channel cannot be enabled without the consent record (validator refuses).
- **Tests:** integration (watcher against a fake status server: down, slow, takeover); drill.
- **Observability:** status fields `notifier_last_success_at`, `watcher_last_poll_at` (the watcher calls `GET /status?watcher=1` so the sentinel records the poll time) feeding VM-13 `safety[]`.
- **Security notes:** No personal data leaves the host by default; third-party messages are codes only (D27, brief rule 6).
- **Facts used:** none external (vendor claims for Tailscale are in `UI.md` UI-F41, A-28).
- **Definition of done:** Common DoD; go-live checklist items 3d and 14 recorded.

#### B-M29-04 — `botctl` operator CLI

- **Module:** M29 · **Size:** M (~1.25 engineer-days) · **Phase:** 3 (`import-run` was split out as B-M29-05 on 2026-10-07)
- **Goal:** The host CLI run by the operator's own login user over SSH on the tailnet: `status`, `halt`, `flatten`, `unlock`, `lock`, `resume-latch`, `release-lease`, `sweep`, plus `enroll-passkey` (CL-60); `import-run` is B-M29-05 and ships in the same `botctl` binary.
- **Depends on:** B-M29-01, B-M29-05 (the `botctl` binary and its config). Group A: none.
- **Interfaces:** command lines (ARCH M29): `botctl status`; `botctl halt --reason <text>`; `botctl flatten --max-slippage-bps <n>`; `botctl unlock [--exits-only]`; `botctl lock`; `botctl resume-latch --reason <text>`; `botctl release-lease`; `botctl sweep [--lamports <n>]`; `botctl enroll-passkey`.
- **Logic:**
  1. `status`: signer `status` (ops.sock) + sentinel status + engine trading state (from the sentinel's last heartbeat).
  2. `halt`: signer `latch(halt)` directly (identity `operator_cli`) and a halt request to the engine relayed by the sentinel; works with the engine hung or dead (ARCH 12.6).
  3. `flatten`: asks the engine (via the sentinel's socket) to flatten; if the engine heartbeat is missing > 10 s, the sentinel takes the lease and runs the standalone path (B-M29-02).
  4. `unlock`: reads the passphrase with terminal echo disabled, sends it to the signer over `ops.sock`, zero-fills the buffer; never logged or echoed; `--exits-only` loads the key in `exits_only`.
  5. `resume-latch`: clears a latch set by the sentinel, the CLI or `system` (D28 (a)); prints that the dashboard RESUME (A2) is still required; the signer log entry is imported into the audit log.
  6. `release-lease`: returns exits to the engine after a takeover, only after confirming the sentinel journal was imported (prompts if not).
  7. `import-run`: see B-M29-05.
  8. `sweep [--lamports n]`: asks the engine to sweep (or a test sweep of `n` lamports, checklist item 4).
  9. `enroll-passkey`: asks M28 (through a local admin file in the spool) for a single-use enrollment token, valid 10 minutes, printed once.
- **Shared resources and concurrency:** Uses the owners' protocols only.
- **Config:** `/etc/botctl/config.json` (socket paths).
- **Edge cases and failure handling:** Sentinel down → `halt` still sets the signer latch directly; `flatten` reports that the standalone path is unavailable.
- **Acceptance criteria:** CLI kill with the engine stopped blocks signing (P-7); `resume-latch` from a non-operator user is refused by the signer (identity from `SO_PEERCRED`).
- **Tests:** integration on the three-user test host; passphrase never appears in process arguments (`ps`), shell history or logs.
- **Observability:** each command logs `botctl.<command>` (no secrets) to journald and appears in the signer/sentinel logs imported into audit.
- **Security notes:** The passphrase is never passed as a command-line argument.
- **Facts used:** none external.
- **Definition of done:** Common DoD; out-of-band instructions in `UI.md` U-14 match these commands exactly (ARCH 12.6).


#### B-M29-05 — `botctl import-run`

- **Module:** M29 · **Size:** S (~0.25 engineer-days) · **Phase:** 1 (split from B-M29-04 on 2026-10-07, INTEGRATION "Remaining issues")
- **Goal:** The one `botctl` subcommand gate runs need in M2: hand a signed run bundle from the research machine to the engine's import job.
- **Depends on:** B-M24-02. Group A: A-M13-08 (`importRunBundle`, run by the engine's import job, CL-62 = C-38).
- **Interfaces:** `botctl import-run <bundle>`; `/etc/botctl/config.json` (spool path).
- **Logic:**
  1. Copy the bundle into the import spool `/var/lib/zeroed-spool/` (owner `bot`, group `zeroed-spool` = {operator, `bot`}, mode 2730: members may write and enter but not list; `botctl import-run` writes the bundle 0640; was `/var/lib/bot/import-spool/` with group `botops` (PATHS-FIX, `docs/research/DISK-BUDGET.md` §2.9: the engine's unit can write only its state folder and its `ReadWritePaths`; `packages/engine/src/paths.ts`). Not `botops`: that group reaches the signer's ops socket (`/run/signer/ops.sock`, B-M17-01 logic 1), so the engine must never join it); the engine's single-writer import job runs M13 `importRunBundle` (signature against the root-owned research public key, manifest hashes against the host index) and writes the result file the CLI waits for (CL-62). No computation of runs happens on the host (CA-26).
  2. Print the result (imported, or the refusal code) and exit non-zero on refusal.
- **Shared resources and concurrency:** The spool directory; the engine's import job is the only writer to `bot.db` (ARCH 4.5).
- **Config:** `/etc/botctl/config.json` (spool path, result timeout).
- **Edge cases and failure handling:** Engine down → the bundle waits in the spool; the CLI times out with a clear message and the bundle is imported at the next start. A tampered bundle → the import job refuses with `E_SIGNATURE`.
- **Acceptance criteria:** Given a valid bundle, then it appears in VM-21 after import; given a bundle with one changed byte, then it is refused and nothing is written; `botctl` never writes `bot.db` directly.
- **Tests:** integration with the engine's import job on a test host.
- **Observability:** logs `botctl.import_run` (no secrets).
- **Security notes:** The research key is not the trading key; a forged bundle is still checked against host manifests (A-M13-08).
- **Facts used:** none external.
- **Definition of done:** Common DoD; A-M11-05 bundles import on a clean host test.
---

### M30 Build, deploy and supply chain

#### B-M30-01 — Monorepo, dependency policy and CI

- **Module:** M30 · **Size:** M (~1.5 engineer-days) · **Phase:** 0
- **Goal:** A monorepo whose CI enforces the dependency policy of ARCH 12.3 from day one.
- **Depends on:** —
- **Interfaces:** packages: `@bot/types`, `@bot/contract`, `@bot/engine`, `@bot/signer`, `@bot/sentinel`, `@bot/botctl`, `@bot/venue` (M01/M02 shared, group A), `@bot/exitpath` (B-M16 adapter subset + B-M18-04 proof, shared by engine and sentinel), `@bot/research` (off-host), `@bot/dashboard` (SPA).
- **Logic:**
  1. Exact version pins; committed lockfile with integrity hashes; CI fails on lockfile drift without a review label.
  2. Installs with lifecycle scripts disabled (**VERIFY** the package manager's flag, e.g. `--ignore-scripts`) in a CI container holding no secrets [TH-39].
  3. Allowlist of package names (`DEPENDENCIES.md` with purpose, licence, reviewer); typosquat check against names targeted in campaigns (bs58, raydium, dexscreener variants) [TH-38]; new versions adopted only after 14 days and a changelog/diff review (security fixes may skip after review) [TH-37, TH-40].
  4. Zero-dependency checks: `@bot/signer` and `@bot/types` have no third-party runtime dependencies; `@bot/sentinel` depends only on internal packages and `@solana/kit`.
  5. `npm audit` (or equivalent) on every run; SBOM generated per release; secrets scan of the repository, fixtures and test logs.
  6. Lint rules from B-M19-01; `@solana/web3.js` v1 banned in engine and signer [LD-05, LD-36]; no third-party bot repositories [TH-41].
- **Shared resources and concurrency:** Owner of lockfile and CI configuration.
- **Config:** CI settings only.
- **Edge cases and failure handling:** A new install script appears in a dependency → CI fails.
- **Acceptance criteria:** adding a package with an install script fails CI; adding `@solana/web3.js` to the engine fails CI; the signer's production dependency list is empty.
- **Tests:** CI self-tests with deliberately bad commits.
- **Observability:** CI reports.
- **Security notes:** The research bundle signing key and any provider keys never enter CI.
- **Facts used:** TH-37, TH-38, TH-39, TH-40, TH-41, LD-05, LD-36, VF-16.
- **Definition of done:** Common DoD; policy documented in `DEPENDENCIES.md`.

#### B-M30-02 — Host provisioning, systemd hardening, firewall and egress allowlist

- **Module:** M30 · **Size:** L (~2.5 engineer-days) · **Phase:** 3 (a no-key Phase 0-2 host uses the same base without the signer)
- **Goal:** Provision the droplet (D07) with separate users, hardened systemd units with OOM protection and restart limits, swap disabled, no public listening ports, an egress allowlist, NTP, and the single sudoers/polkit rule for the sentinel.
- **Depends on:** B-M30-01, B-M17-01, B-M29-01.
- **Interfaces:** provisioning script and unit files (`engine.service`, `signer.service`, `sentinel.service`, optional `signer-exits-only-unlock.service` for D26 (ii)).
- **Logic:**
  1. Users `bot`, `signer`, `sentinel`, and `zeroed-pull` (the market-data pull account: group `zeroed-pull`, shell `/usr/sbin/nologin`, sftp only through an sshd `Match User` block with `ChrootDirectory /srv/zeroed_pull` and `ForceCommand internal-sftp -u 0027`, key in root-owned `/etc/zeroed/pull-keys/`; PATHS-FIX rulings 9, 16); group `botops` = {`sentinel`, operator}; groups `zeroed-pull` = {`zeroed-pull`, `bot`} and `zeroed-spool` = {operator, `bot`}; `/var/lib/zeroed-md` 2750 and `receipts/` 2770 group `zeroed-pull`, `/var/lib/zeroed-spool` 2730 group `zeroed-spool`, made by the installer (one `StateDirectoryMode` per unit); directories with owners and modes per ARCH 4.3/12 (`/var/lib/signer` 0700 `signer`; `/var/lib/sentinel`; `/var/lib/zeroed` 0700 `bot` (the engine unit's `StateDirectory`; was `/var/lib/bot`, PATHS-FIX, `docs/research/DISK-BUDGET.md` §2.9: the engine's unit can write only its state folder and its `ReadWritePaths`); `/var/lib/zeroed-usage` 2770 `bot`, group `zeroed-sentinel` (provider usage ledger, PATHS-FIX ruling 21); `/etc/bot/ceilings.json` root 0444; `/etc/bot/secrets.env` root 0400 delivered by systemd credentials, **VERIFY** the systemd version's support, A-39).
  2. Units: `OOMScoreAdjust` signer −900, sentinel −600, engine −500 (**VERIFY** directive and range, A-39); restart limits so a start-refusing engine does not crash-loop forever (**VERIFY** `StartLimitBurst`/`StartLimitIntervalSec` semantics); `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, per-unit `ReadWritePaths`; memory alert at 75% of RAM.
  3. Swap disabled (or encrypted) for the signer's sake; boot check.
  4. Firewall: no public listening ports (SSH only on the tailnet); egress allowlist to the configured RPC, landing, Jupiter, PumpPortal, DexScreener, RugCheck, CoinGecko hostnames (and Birdeye only if D17 (e)), the D27 target if any, and the tailnet; log and alert any other outbound connection (unexpected SMTP or Telegram egress is a known exfiltration path [TH-38]); **VERIFY** the mechanism for hostname-based allowlisting on the host firewall.
  5. Sudoers or polkit rule allowing user `sentinel` exactly `systemctl stop engine` (**VERIFY**, A-39).
  6. Time sync service with offset exported for M27/M21 (clock rules, ARCH 8.5).
  7. Disk ≥ 50 GB confirmed before ordering (A-27); the $12 droplet's disk size is UNVERIFIED.
- **Shared resources and concurrency:** Host configuration owned by M30.
- **Config:** provisioning variables (region `fra`, D07).
- **Edge cases and failure handling:** OOM pressure → the kernel kills the engine before the sentinel and signer (ARCH 4.3).
- **Acceptance criteria:** external port scan of the VPS address finds no open port (checklist item 8); a test connection to a non-allowlisted host is blocked and alerted; `systemctl stop signer` by `sentinel` is refused while `systemctl stop engine` succeeds.
- **Tests:** provisioning test in a throwaway VM; checklist items 6-9 scripted.
- **Observability:** firewall log counter exported for M27.
- **Security notes:** No public listeners; SSH keys only; tailnet ACLs restrict to the operator's devices.
- **Facts used:** LD-35 (droplet sizes), LD-34 (region rationale), TH-38. VERIFY: A-27, A-39.
- **Definition of done:** Common DoD; go-live checklist items 6-9 pass.

#### B-M30-03 — Releases, reproducible deploys, backup and segment pulls

- **Module:** M30 · **Size:** S (~1 engineer-day) · **Phase:** 3
- **Goal:** Reproducible builds with SBOM and native-addon hash checks at deploy, a deploy procedure with rollback, and the operator-side pull scripts for backups and market-data segments.
- **Depends on:** B-M30-02, B-M24-04. Group A: A-M07-03 (`md-pull` and receipts).
- **Interfaces:** `deploy.sh <release>`; `pull-backups.sh`; `pull-segments.sh` (operator machine, over the tailnet).
- **Logic:**
  1. Release artifact built in CI from a tagged commit with the pinned Node version; SBOM attached; any native addon's SHA-256 must equal the SBOM entry or the deploy is refused (CA-33).
  2. Deploy only when the book is flat or in paper (engine restart); the signer is redeployed only with an operator present (it starts locked).
  3. Backups: pull daily copies over the tailnet, verify SHA-256 against the backup manifest, keep 90 days of dailies and all month-ends (ARCH 15).
  4. Segments: the pull, SHA-256 verification and the "verified" receipt format are A-M07-03's (`md-pull`); this ticket only schedules A-M07-03's script on the operator machine alongside `pull-backups.sh` and alerts when no verified receipt arrived for 48 h (integration: no second segment-pull implementation). M07 deletes host segments older than 30 days only after a verified receipt (ARCH M07).
- **Shared resources and concurrency:** Release artifacts.
- **Config:** pull destinations on the operator's machine.
- **Edge cases and failure handling:** Verification mismatch → the host copy is kept and an alert is raised.
- **Acceptance criteria:** a tampered addon fails deploy; a corrupted pulled segment is not marked verified.
- **Tests:** scripted in CI against a test host.
- **Observability:** pull logs; M27 alert on stale backups (`backup_age_s`).
- **Security notes:** Backups are encrypted at rest (B-M24-04); pull scripts never handle the backup key.
- **Facts used:** none external.
- **Definition of done:** Common DoD.

---

### Fixture catalogue (shared by group B tickets)

All fixtures are stored raw responses or recorded public on-chain data (no secrets; keys and URLs redacted). Generated test keys are never funded on mainnet. "Recorded" means captured read-only from mainnet RPC with `maxSupportedTransactionVersion: 1` [LD-05].

| Fixture | Content | Used by |
|---|---|---|
| `FX-RPC-EPOCHINFO`, `FX-RPC-EPOCHINFO-B` | slot-and-height responses from two providers | B-M15-01, B-M18-04 |
| `FX-RPC-PERFSAMPLES` | `getRecentPerformanceSamples` response | B-M15-01 |
| `FX-RPC-LATESTBLOCKHASH` | latest-blockhash response | B-M15-02 |
| `FX-RPC-RENT` | rent minimums for 0, 165, 170 bytes (650,240 / 1,488,440 / 1,513,840 [LD-13]) | B-M15-03 |
| `FX-HELIUS-PRIOFEE` | `getPriorityFeeEstimate` response (key redacted) | B-M15-03 |
| `FX-SIM-CONTROL-ACCOUNT` | unsigned simulation of a sell with the control account on `SetComputeUnitPrice` | B-M16-01 (A-16) |
| `FX-SIM-WSOL-ROUNDTRIP`, `FX-SIM-ROUNDTRIP`, `FX-SIM-JANITOR` | unsigned simulations with the simulation payer | B-M16-02, -05, -10 |
| `FX-TX-PUMPSWAP-BUY`, `FX-TX-PUMPSWAP-SELL`, `FX-TX-PUMPSWAP-SELL-RUNG2`, `FX-TX-PUMPSWAP-*` | recorded PumpSwap transactions incl. Buy/SellEvents [EX-37] | B-M16-03, B-M18-03, B-M23-01 |
| `FX-POOL-TIER-420`, `FX-POOL-DEEP-1`, `FX-POOL-DEEP-2` | pool and vault accounts across the 420 SOL tier boundary and two deep pools [EX-07] | B-M16-03, B-M16-04 |
| `FX-TX-CURVE-BUYV2`, `FX-TX-CURVE-*` | curve v2 transactions with TradeEvents | B-M16-08, B-M23-01 |
| `FX-JUP-BUILD-*`, `FX-JUP-ORDER-V0`, `FX-JUP-ORDER-LEGACY`, `FX-JUP-EXECUTE-OK`, `FX-JUP-EXECUTE-TIMEOUT`, `FX-JUP-PRICE-OK`, `FX-JUP-PRICE-OMITTED` | Jupiter responses (key redacted) | B-M16-06/07, B-M18-05, B-M23-03 |
| `FX-CG-PRICE` | CoinGecko simple price response | B-M23-03 |
| `FX-RAY-AMMV4-*`, `FX-RAY-CPMM-*` | Raydium pools and swaps in both token orderings | B-M16-09 (Phase 3b) |
| `FX-SIGNER-MSG-*` | 200 compiled v0 messages (ours and Jupiter) | B-M17-04 |
| `FX-ALT-JUP-*` | lookup-table accounts referenced by Jupiter routes | B-M17-04 |
| `FX-SIGNER-SIM-*` | simulation responses with pre/post account states | B-M17-05 |
| `FX-RPC-SIGSTATUS-*`, `FX-RPC-SIGSTATUS-NULL-LAGGING` | signature status responses incl. a null with a lagging context slot | B-M17-07, B-M18-04 |
| `FX-SENDER-OK`, `FX-SENDER-429`, `FX-JITO-OK`, `FX-RPC-SEND-OK` | landing-path responses | B-M18-02 |
| `FX-FAIL-SLIPPAGE`, `FX-FAIL-CU`, `FX-FAIL-FEEPAYER`, `FX-FAIL-ACCOUNTSTATE`, `FX-FAIL-BALANCE`, `FX-FAIL-VENUEDISABLED`, `FX-FAIL-FROZEN` | one failing transaction per failure class (recorded, or simulated where none was recorded; ARCH 7.3a) | B-M18-03, B-M23-01 |
| `FX-TX-V1` | a version-1 transaction [EX-V04] | B-M18-03 |
| `FX-RPC-TOKENBALANCE` | token-account balance response | B-M22-02 |
| `FX-WALLET-HISTORY-*`, `FX-WALLET-REBUILD` | a test wallet's signature history and transactions (sweeps, refills, unsolicited airdrops, an `open_failed` buy that landed) | B-M22-03, B-M22-06 |
| `FX-POOL-PATH-DUMP`, `FX-POOL-PATH-RUG` | recorded snapshot paths with a dump and an LP/authority change | B-M20-02, B-M20-03 |
| `FX-SENTINEL-JOURNAL` | a sentinel fill journal with matching recorded transactions | B-M20-05 |
| `FX-BLOCK-SANDWICH`, `FX-BLOCK-CLEAN` | recorded blocks with and without a same-pool sandwich around a fill | B-M23-05 |

## Architecture clarifications

Ambiguities in `ARCH.md` that a ticket had to resolve, with the reading chosen (always the safer or stricter one) and where it applies. The integrator reconciled these with group A and with `ARCH.md`: rows marked **Integration** record the binding outcome (ARCH section 5.0b lists every adopted interface change); rows without that mark were checked against `ARCH.md` and adopted as written.

| ID | Ambiguity in ARCH | Resolution in this spec | Tickets |
|---|---|---|---|
| CL-01 | M15 `highestSeenSlot()` is "max contextSlot over every response from any provider", but only M14 sees every response and M14's interface has no hook | M14 publishes `rpc.context_slot { providerLabel, contextSlot, method, atMs }` on the event bus for every response with a context slot (new M14 obligation) **Integration:** adopted; A-M14-01 publishes this exact shape (C-05 updated to include `method`). | B-M15-01 |
| CL-02 | Degraded-mode budget (11.2) lists height readings "only while attempts are unresolved" | M15 polls heights every 10 s in degraded mode; M18 still calls `heightOn` on demand for expiry proofs | B-M15-01 |
| CL-03 | D02 (b) mentions skipping Jito tips on non-Jito leaders via M15 | `jitoLeaderShareBps` is informational only; per-leader tip skipping (needs a leader schedule) is out of scope in v1; tips are always included on rung ≥ 2 | B-M15-03 |
| CL-04 | Rung 4 lands via Jupiter `/execute`, but `LandingPath` has only `sender`, `jito_tx`, `rpc` | Add `'jupiter_execute'` to `LandingPath` in `@bot/types`; M14 provides a send bucket for it (Jupiter's separate `/execute` limits [EX-29]); never rebroadcast **Integration:** adopted; A-M14-04 adds the `jupiter_execute` bucket (≤ 50% of Jupiter `/execute` limits [EX-29], owner rule; was 80%); ARCH M18 `LandingPath` amended (5.0b). | B-M19-01, B-M18-01, B-M18-05 |
| CL-05 | Tip accounts must be on the signer's allowlist, but ARCH does not say where M16 gets them | Tip-account lists are reviewed config (never fetched at runtime), `requiresRestart`, and must hash-match the signer's policy file | B-M16-01, B-M17-06 |
| CL-06 | PumpSwap `track_volume` may create a `user_volume_accumulator` like the curve's (rent paid by the user [EX-13]); ARCH reservation formula omits it | VERIFY; if it does, the first-trade reservation includes that rent | B-M16-03, B-M22-01 |
| CL-07 | Honeypot simulation transaction content beyond "buy then sell" | Simulation-only builds carry no tips (tips do not affect sellability and would distort the output check); `minQuoteOut = 0` on the simulated sell so the output is observed | B-M16-05 |
| CL-08 | Rung-4 `/order` transactions are pre-built and `UnsignedTx.version` is `0` | Only v0 is accepted (else escalate to rung 5); `cuLimit`/`cuPrice` decoded when present, else 0 and costs come from meta | B-M16-07 |
| CL-09 | Expiry proof needs `lastValidBlockHeight`; Jupiter's response field is not in the register | Use Jupiter's value if provided (VERIFY), else a conservative upper bound `blockHeight at receipt + 150 + 10` [LD-07] | B-M16-07, B-M18-05 |
| CL-10 | Curve adapters are "research and PM only" | Config validation refuses `pump_curve_enabled = true` in live modes | B-M16-08 |
| CL-11 | Signer may `Burn` only for mints "the engine has marked unsolicited and the operator confirmed", which the signer cannot verify | Signer additionally refuses a burn for any mint present in its own persisted `buyMints` list (every mint it has ever signed a buy for), so a buggy or compromised engine cannot burn position tokens | B-M16-10, B-M17-03, B-M17-06, B-M22-04 |
| CL-12 | Exit fee caps are per rung (8.3), but the signer cannot trust the engine's rung | Signer enforces an absolute exit cap = base 5,000 + priority ceiling 600,000 + 2 × tip cap 10,000 = 625,000 lamports (2,000,000 for rung-4 simulated exits); the engine enforces per-rung values | B-M17-06 |
| CL-13 | Rung-4 check "total fees + Jupiter fee + tips ≤ 2,000,000" from a simulation that cannot separate Jupiter's fee | Fee-like outflow = simulated network fee + every lamport increase of a System-owned non-hot account + every wSOL increase of a token account not owned by the hot wallet; ambiguous outflows count as fees (refusal is the safe direction; the ladder moves to rung 5) | B-M17-06 |
| CL-14 | The signer must read balances itself at `confirmed` (exits: ATA balance; buys: hot balance for `HOTCAP`), but section 10 targets a 2 ms sign step and D05 triggers on build + sign p95 > 30 ms | The signer's RPC reads are required by policy and are kept; the D05 trigger metric `build_sign_segment_ms` excludes the signer's network reads (the signer reports its own CPU time in the response metadata), so a network round trip cannot trigger a language switch | B-M17-06, B-M19-06 |
| CL-15 | `SignerStatus` is defined but no request returns it; it lacks mode, persistence health and per-mint leases needed by M26/M27/M29 | Add `StatusRequest` and fields `mode`, `persistence`, `leases[]` **Integration:** adopted into ARCH M17 (5.0b). | B-M17-01, B-M17-03, B-M17-08 |
| CL-16 | "The mode is raised by the engine within the signer's ceilings file and lowered by anyone" has no protocol message | Add `SetModeRequest`; the engine can raise the signer mode only up to `max_mode` in the signer's root-owned policy (default `paper`, set by the operator at each promotion) **Integration:** adopted into ARCH M17 (5.0b). | B-M17-08, B-M26-04 |
| CL-17 | Key generation and rotation (12.2) have no tool | An offline `signer-keytool` (init, rotate, verify) in the signer package, run as user `signer`, never prints the seed | B-M17-02 |
| CL-18 | M02 decoders are "consumed by the signer" but the signer must have zero third-party runtime dependencies | The signer embeds a build-time-generated discriminator/account-name table from the same pinned IDL commit, hash-checked at start; M02 must keep that table derivable from its pinned files | B-M17-04 |
| CL-19 | "SOL out" for the per-transaction buy cap is "the hot wallet's total lamport decrease", which would make a maximum-size buy fail by the ATA rent | The cap applies to the decoded swap input (≤ `MAXPOS` ceiling); rent deposits, fees and tips are bounded separately; the day cap counts the all-in upper bound (stricter) | B-M17-05, B-M17-06 |
| CL-20 | "At least two endpoints … the first to answer is used; any disagreement … refuses" is internally ambiguous | Buys (non-decodable): both must answer within 800 ms and agree; exits: first answer used, refused if the second answers in the window and disagrees; both down → `E_SIM_UNAVAILABLE` | B-M17-05 |
| CL-21 | Signer refuses buys when "pre-trade hot balance > `HOTCAP` + 10%", but `HOTCAP` in live depends on `E`, which the signer does not know | Signer policy holds absolute per-mode `HOTCAP` values (500,000,000 live-small; ≤ 1,000,000,000 live), each ≤ the ceiling | B-M17-06 |
| CL-22 | Whether sweeps are allowed while the latch is set | Allowed (ARCH 12.6 lists the sweep as a kill-switch path); refused only while signer persistence is degraded; the signer keeps its own minimum-leave floor | B-M17-03, B-M17-06 |
| CL-23 | 7.6 step 5 allows automatic lease release "when the journal is fully imported and the sentinel has finished" | v1 keeps the release manual (`botctl release-lease`), prompted by the engine after import; automatic release is a later option | B-M17-08, B-M20-05 |
| CL-24 | Preflight setting for the RPC send path is unspecified | `skipPreflight: true` (preflight defaults to `finalized` commitment [LD-09] and would delay or reject valid exits); the signer and on-chain bounds are the validation | B-M18-01, B-M18-02 |
| CL-25 | Expiry proof requires null twice ≥ 2 slots apart; it does not say both must meet the context-slot condition | Both null responses must have context slot ≥ `S_h` | B-M18-04 |
| CL-26 | Rung 4 could also be sent through our own paths | Not done: Jupiter lands `/order` transactions; one `/execute` per attempt | B-M18-05 |
| CL-27 | `ExecutionPort` has no result callback, and "same states as live" includes building/signing states | `ExecutionPort.onResult` added; `status()` returns the full 7.3 attempt state list (`AttemptState`); M12 (group A) must implement both **Integration:** merged with C-29: one `ExecutionPort { submit; status(): AttemptState; onResult; onNotLanded }` in `@bot/types` (B-M19-01); intents read via `OrderManager.intent` (CL-29). A-M11-02 and A-M12-01 implement it. | B-M19-01, B-M22-05 |
| CL-28 | M19 executes exit attempts but M20 owns the ladder | `RungParams`/`ExitLadder` types live in `@bot/types`; M20 implements, M19 consumes **Integration:** adopted (ARCH 5.0b). | B-M19-01, B-M19-05, B-M20-04 |
| CL-29 | Other group B modules need intent lookups | `OrderManager.intent`, `openIntentsFor`, `onIntentTerminal` added **Integration:** adopted (ARCH 5.0b); also satisfies C-29. | B-M19-02 |
| CL-30 | 7.3a `compute_exceeded` says "same rung again" without distinguishing entries | Entries remain single-attempt (`failed`; profile bumped for the next entry); "same rung again" applies to exits | B-M19-04 |
| CL-31 | 7.5 candidate transitions on terminal positions need a signal from M20 to M05 | M20 publishes `position.terminal`; M05 (group A) consumes it **Integration:** adopted; A-M05-01 consumes `position.terminal`. | B-M20-01 |
| CL-32 | Precision of `entry_price_sol_per_token` | Exact integer arithmetic to 18 decimal places, rounded half-up, as a DecimalStr | B-M20-01 |
| CL-33 | LP-distribution change "triggers the liquidity-collapse exit" (8.4) but M06's interface publishes only `token.authority_changed` | M06 (group A) also publishes `token.lp_changed` when the `lp_withdrawable_max` re-check changes **Integration (changed):** the event is A-M06-04's `pool.lp_changed { poolId, mint, maxWithdrawableBps, previousBps, atMs }` (keyed by pool, because LP withdrawability is a pool property); B-M20-03 subscribes to it. `token.lp_changed` is not used. | B-M20-03 |
| CL-34 | D09, D16 switch triggers could be read as automatic | The engine detects the trigger and raises an alert; the operator applies the switch as a config change (A3 when it raises cost or risk) | B-M20-04, B-M23-05 |
| CL-35 | Flow-adjusted equity is computed by M21 (breakers) and recorded by M13 (`equity_point`) | One implementation (`FlowAdjustedEquity` in M21); M13 records its values **Integration (changed):** one formula, A-M13-04's pure `flowAdjustedStep` with A's E-boundary rule (C-35); one live/paper instance in B-M21-04, which writes `equity_point` through `EquitySeries.recordMinute`; M13 never recomputes the live index. | B-M21-04 |
| CL-36 | Which limits apply in paper mode | Paper evaluates the target live mode's limits (`paper_limits_profile`, default `live_small`), so paper results reflect intended live sizing | B-M21-01 |
| CL-37 | VM-12 `state` thresholds (`elevated`, `near`) are not defined | POLICY: elevated ≥ 50%, near ≥ 80%, breached ≥ 100% of the binding value **Integration (changed):** thresholds aligned with the UI C28 LimitMeter: elevated ≥ 70%, near ≥ 90%, breached ≥ 100% (server-computed; the UI only displays VM-12 `state`). | B-M21-01 |
| CL-38 | M10 owns the stressed gap-through-stop p99 but `SimCore` exposes no accessor | M10 (group A) adds `gapThroughStopP99Bps(strategyId): { p99Bps: Bps \| null; stopExits: number }`; M21 uses the 20% prior until ≥ 50 stop exits **Integration (changed):** use A-M10-04's `stressedGapBps(strategyId): { p99Bps; samples; source: 'prior' \| 'empirical' }` (C-24); M10 owns the prior and the freeze at `replay_passed`; `gapThroughStopP99Bps` is not added. | B-M21-02 |
| CL-39 | Shrinking to fit `MAXRISK`/`MAXRISK_PF` can produce tiny sizes where fixed lamport costs dominate (ARCH 2.4 conclusion 8) | New stricter-only POLICY `min_notional_lamports` (default 33,333,333 ≈ $5 at `P_SOL`): smaller results are rejected, never sent | B-M21-02 |
| CL-40 | `REGIME` is defined for MR entries | Applied to MR entries only; PM-01 (paper at most) is unaffected by the SOL/USD part | B-M21-03 |
| CL-41 | `WEEKLOSS` window (calendar week or rolling) is not defined | Rolling 7 × 24 h (never resets early) | B-M21-04 |
| CL-42 | ATA rent deposits reduce `E` while positions are open | Kept in `E` as defined (conservative: temporarily counts as loss in `DAYLOSS`); rent refunds raise `E` back | B-M21-04 |
| CL-43 | `FEEDAY` counts "base + priority + tips per UTC day" without saying which transactions | All of our transactions (entries, exits, janitor, sweeps) count toward the cap; the cap blocks only entries | B-M21-05 |
| CL-44 | Janitor, sweep and `close_unsolicited` transactions need the sign/send path, but `OrderIntent` has only buy/sell | `order_intent.purpose` column and `OrderManager.submitMaintenance` **Integration:** adopted (ARCH 5.0b). | B-M19-02, B-M22-04, B-M24-02 |
| CL-45 | In paper mode `E` is ambiguous (paper ledger vs real wallets), but P-9 compares fixed cost with real `E` | Paper sizing, limits and drawdown use paper `E`; the fixed-cost ceiling and P-9 use the real chain `E` (simulation payer + cold + hot) | B-M22-05 |
| CL-46 | Sweep amount ("excess above cap") | Sweep down to `HOTCAP`, never below float + reservations + rent reserve + 0.01 SOL | B-M22-04 |
| CL-47 | VM-14 `fixed_items[]` have no command to edit them | Fixed-cost items are a config key changed through `apply_config` (versioned, audited) **Integration (changed):** fixed-cost items use `riskDirectionOnIncrease = decreases_risk`, so lowering one is A3 (it can unlock P-9). | B-M23-03 |
| CL-48 | Cost-basis method for the tax-style export | No jurisdiction method imposed (OQ-1): each position is one lot (PERTOKEN = 1); chunked exits consume it FIFO; the export says "not tax advice" | B-M23-04 |
| CL-49 | M23 results "calibrate M10's `p_sw`" without an interface | M10 (group A) reads the `sandwich_check` table (≥ 100 rows before replacing the prior) **Integration:** A-M10-05 reads `sandwich_check` (B-M23-05). | B-M23-05 |
| CL-50 | Columns needed by tickets but absent from ARCH 15 | `order_intent.purpose`; `tx_attempt.signed_tx_b64`, `classification_json`, `lvbh_source`, `route`, `jupiter_fee_bps`; tables `cost_item_correction`, `kv_state`, `schema_migrations`, `audit_import_cursor` | B-M24-02 |
| CL-51 | Append-only tables also have retention periods | UPDATE always aborts; DELETE aborts unless the row is older than the table's retention horizon | B-M24-02 |
| CL-52 | Migration failure behaviour | Backup first, migrate in one transaction; failure → rollback and `exits_only` on the unmigrated database | B-M24-02 |
| CL-53 | Signer and sentinel logs are "imported" into the audit log, but the engine cannot read signer files | The signer appends its log lines to a spool file readable by group `bot`; the engine imports idempotently by `(source, seq)` | B-M24-03 |
| CL-54 | "It may be scheduled to apply when the book is flat" for `requiresRestart` changes | v1 refuses (`book_not_flat`); the operator re-applies when flat | B-M25-03 |
| CL-55 | `buildSwap` has no `E_STALE` code although a stale fresh read must abandon entries | Re-read once; still stale → `E_ROUTE` with message `stale_pool`; M19 → `abandoned` | B-M16-04 |
| CL-56 | `kill.components[]` includes the sentinel, but the heartbeat protocol has no halt acknowledgement; M27 must forward critical alerts to the sentinel | Heartbeat socket adds `halt_notice`/`halt_ack` and `critical_alert` messages **Integration:** adopted into ARCH M29 (5.0b). | B-M26-01, B-M27-02 |
| CL-57 | Demotion drops the strategy stage (owned by M13), but M13's interface has no stage-change call | M13 (group A) adds a stage-change method for demotions (actor and reason recorded, append-only) **Integration:** resolved by A-M13-05 `StageMachine.onDemotion` / `onModeCommand`; B-M26-04 calls them. | B-M26-04 |
| CL-58 | ARCH 7.6 recovery steps have no owner | M26 (owner of `starting`) coordinates them through each owner's interface | B-M26-05 |
| CL-59 | "Bind to 127.0.0.1 and reach it over a tailnet" needs a forwarding mechanism | Use Tailscale's local forwarding of a loopback port or a tailnet-only listener (VERIFY); never bind `0.0.0.0` | B-M28-02 |
| CL-60 | No way to enroll the first passkey or recover from a lost one | `botctl enroll-passkey` issues a single-use 10-minute token on the host | B-M28-02, B-M29-04 |
| CL-61 | The sentinel must flatten "live positions" without the engine's database | The heartbeat carries the live positions list (`mint`, `poolId`, `venue`, `tokenProgram`, `sizeBase`), persisted by the sentinel; on takeover it sells only cached mints with an on-chain balance **Integration:** the heartbeat type in B-M26-01 now carries `positions[]`. | B-M29-01, B-M29-02 |
| CL-62 | `botctl import-run` "writes into `bot.db`", but the engine is the single writer and the CLI runs as the operator user | The CLI drops the bundle into an import spool; the engine's import job (single writer) runs M13 `importRunBundle` and writes a result the CLI waits for **Integration:** consistent with C-38; A-M13-08 owns `importRunBundle` in the engine. | B-M29-05 (split from B-M29-04, 2026-10-07) |
| CL-63 | `client_kind = mobile` restrictions rely on a client declaration | Recorded limitation: client kind is self-declared; the binding protection for A2/A3 is the passkey step-up | B-M28-02 |
| CL-64 | "Strategies live at once" has no short code | Internal short code `MAXSTRAT` | B-M26-04 |
| CL-65 | ARCH 18 puts M16 build-only work in Phase 2, but M06 (Phase 1) needs `buildSimulationOnly` | B-M16-01/02/03/05 and the rent oracle are pulled into Phase 1 (no key, simulation only) **Integration:** adopted and extended: the whole engine core moves to global milestone M2 (`INTEGRATION.md`); ARCH 18 amended. | Build order |
| CL-66 | `cost_item` is unique per `(attempt_id, kind)` and append-only, yet ARCH M23 says `model` items are "revisited by the reconciler", and a janitor closes several accounts in one attempt | One item per kind per attempt (sums); corrections go to an append-only `cost_item_correction` table, newest correction wins in aggregates | B-M23-01, B-M24-02 |

### Cross-group interfaces required from group A

Rewritten at integration with producing **ticket IDs** (the "Depends on (group A tickets, hard)" column of the dependency list above is authoritative for build order).

| Group B ticket | Producing group A ticket(s) | Interface (as settled at integration; ARCH 5.0b) |
|---|---|---|
| B-M15-01 | A-M14-01, A-M14-02 | `RpcGateway.call(…, { provider })`; topic `rpc.context_slot { providerLabel, contextSlot, method, atMs }` (C-05 = CL-01) |
| B-M15-03 | A-M14-02, A-M14-05 | `RpcGateway.call` to the Helius provider; `creditUsage()` for the D15 switch |
| B-M16-02, B-M16-03, B-M16-04, B-M16-05 | A-M01-01, A-M01-02, A-M01-03 | constants file; `VenueModel.quoteExactIn`, `minOut`, `feeFor`, `effectiveQuote` |
| B-M16-03, B-M17-04, B-M29-02 | A-M02-01, A-M02-02, A-M02-06 | `@bot/decoders` zero-dependency core, `decodeAccount`, `decodeInstruction`, pinned IDL files (C-02, C-03, CL-18) |
| B-M16-04, B-M20-02, B-M21-02, B-M21-06 | A-M04-01, A-M04-02 | `PoolTracker.freshRead` (finite = entry grade, `Infinity` = exit grade; C-09), `latest`, `history`, `lagNow`, `pool.snapshot` / `pool.stale` |
| B-M16-04, B-M28-03 | A-M06-02 | `TokenMetadataCache` (token program, decimals, symbols) |
| (consumers of B-M16-05) | A-M06-05, A-M12-02, A-M01-06 | `TxBuilder.buildSimulationOnly` is provided by group B to them |
| B-M18-01, B-M18-02, B-M18-05 | A-M14-03, A-M14-04 | `acquireSend(path, region, { side: 'exit' \| 'entry' \| 'janitor' \| 'sweep', kind })` → `{ granted, retryAtMs, grantId? }`, including the `jupiter_execute` bucket (C-42, CL-04); `sendGrantId` on send requests |
| B-M18-03, B-M20-05, B-M22-03, B-M22-06, B-M23-01, B-M23-05 | A-M02-03 | `decodeTransactionEvents(RawTransaction)` |
| A-M01-05 (consumer) | — (B-M18-03 and A-M12-01 produce) | topic `fill.events { attemptId, poolId, events, atMs }` |
| A-M10-*, A-M11-02, A-M12-01, A-M13-* (consumers) | — (B-M19-01 produces) | `@bot/types` with the single `ExecutionPort { submit, status(): AttemptState, onResult, onNotLanded }` (C-29 = CL-27), `priorityFeeLamports` helper |
| B-M19-02, B-M21-06 | A-M07-02 | `Recorder.append` for `order_event`, `fill`, `decision` |
| B-M19-05 | A-M14-03 | `beginExitWork(key)` / `endExitWork(key)` (C-41) |
| B-M20-01 | A-M05-02, A-M09-01 | `Universe.pinForPosition`, `unpin`; `ExitPlan`; A-M05-01 consumes `position.terminal` (CL-31) and `risk.decision` (B-M21-06) |
| B-M20-02 | A-M08-02 | `Features.rollingMedian(poolId, 6 h)` |
| B-M20-03 | A-M06-02, A-M06-04, A-M06-06, A-M01-04, A-M01-05 | `Screener.authorityRecheck`, `token.authority_changed`, `pool.lp_changed` (CL-33 changed), `venue.status_changed`, `venue.pool_quarantined`, `FeeScheduleChanged` on topic `venue.fee_schedule_changed` |
| B-M20-04 | A-M06-05 | `screen(…, { purpose: 'pre_exit', withSellSim: true })` (C-43) |
| B-M21-02, B-M21-06 | A-M09-01, A-M06-01 | `SignalProposal` (topic `signal.proposal`), `ExitPlan`, `Strategy.sizing`; `ScreenResult`, `RiskCheck` (soft fails as `warn`) |
| B-M21-02, B-M23-01, B-M23-03 | A-M10-02, A-M10-03, A-M10-04 | `SimCore.estimateRoundTripCostBps`, `fixedCostBpsPerTrade`, `stressedGapBps` (C-24; replaces CL-38) |
| B-M21-03 | A-M08-02, A-M14-05 | `Features.basketReturn(30 min)` (null → block MR, C-21); `mode()` |
| B-M21-04 | A-M13-04, A-M13-07, A-M01-05, A-M02-05 | `flowAdjustedStep`, `EquitySeries.recordMinute` (C-35 = CL-35 changed); `sequentialMonitor`, `research.cusum_alarm` (C-36); `venue.fee_schedule_changed`; `decoder.unknown_layout` |
| B-M23-05 → A-M10-05 | (B produces) | `sandwich_check` table read by A-M10-05 for `p_sw` (CL-49) |
| B-M24-02 | A-M01-02, A-M03-*, A-M05-*, A-M06-*, A-M07-03, A-M08-03, A-M12-02, A-M13-* (writers) | ARCH 15 tables plus C-14 / C-32 additions |
| B-M30-03 | A-M07-03 | `md-pull` tool and `PullReceipt` format (canonical JSON for all groups lives in `@bot/types` `canon.ts`, B-M19-01) |
| B-M26-03, B-M26-04 | A-M13-05, A-M13-06 | `evaluateGates`, `stage`, `StageMachine.onModeCommand` / `onDemotion` (CL-57), `ExternalGateInputs` implemented by B-M26-04 (C-39) |
| B-M27-02 | A-M14-05, A-M03-01 | `health()`, `creditUsage()`, discovery `health()` |
| B-M28-03 | A-M04-01, A-M05-01, A-M06-02, A-M06-03, A-M07-03, A-M08-03, A-M09-01, A-M13-04, A-M13-06, A-M13-08, A-M14-05 | projection sources for VM-04..VM-18, VM-21 |
| B-M29-05 | A-M13-08 | `importRunBundle` (run by the engine's import job, CL-62 = C-38) |

## Unverified items affecting this group

Every item below must be resolved (source URL, date read, result) in `VERIFY.md` before the ticket that depends on it is marked done; go-live checklist item 11 requires all live-path items resolved. Nothing here is presented as fact.

| Item | Status | Affects | How to resolve |
|---|---|---|---|
| A-06 `getMultipleAccounts` 100-account limit and provider caps | VERIFY | B-M29-02 (sentinel reads) | Solana and provider docs |
| A-09 PumpSwap sell output above the real quote vault balance | UNVERIFIED [EX-V01] | B-M16-03, B-M20-03 (real/effective ratio exits) | Simulate sells near the boundary |
| A-10 PumpSwap buy/sell needing buyback-recipient accounts | UNVERIFIED (excluded claim) | B-M16-03, B-M17-04 | Pinned IDL + simulation + SDK oracle |
| A-11 PumpSwap buyback carved out of the protocol fee | UNVERIFIED (excluded claim) | B-M23-01 fee reconciliation | Decode live SellEvents and balance deltas |
| A-13 Raydium reserve formulas, fee fields, withdraw denominator | UNVERIFIED | B-M16-09 (Phase 3b only) | M01 Raydium venue spec |
| A-14 Jupiter DEX labels and router program ID | VERIFY | B-M16-06, B-M17-06 allowlist | Jupiter docs |
| A-16 Compute Budget program accepting an extra read-only account | VERIFY | B-M16-01 | Mainnet-state simulation |
| A-18 Node LTS: built-in Ed25519 from a raw seed, memory-hard KDF and AEAD in `crypto` | VERIFY | B-M17-02, B-M24-04 | Node docs; prototype |
| A-27 Droplet disk size | UNVERIFIED | B-M30-02 | Pricing page before ordering |
| A-28 Tailscale Personal plan terms and forwarding mechanism | Vendor claim | B-M28-02, B-M29-03 | Vendor docs at deployment |
| A-30 Helius Sender tip-account list | VERIFY | B-M16-01, B-M17-06, B-M18-02 | Helius docs |
| A-31 `getLatestBlockhash`, `getSignatureStatuses` history search, `getTokenAccountsByOwner` filters, ATA create-idempotent, ATA program ID and seeds | VERIFY | B-M15-02, B-M16-02, B-M17-04, B-M22-03, B-M29-02 | Solana RPC and SPL docs |
| A-34 SPL Token `CloseAccount` rules (non-native at zero balance; native with any balance) | VERIFY | B-M16-02, B-M16-10 | SPL Token docs and source |
| A-35 `getSignatureStatuses` without history search covers only the recent cache | VERIFY | B-M17-07, B-M18-03, B-M18-04 | Solana RPC docs |
| A-36 `getEpochInfo` fields, `getTokenAccountBalance`, `SyncNative` name | VERIFY | B-M15-01, B-M16-02, B-M19-04, B-M22-02 | Solana RPC and SPL docs |
| A-37 `getBlockTime` whole-second resolution | VERIFY | B-M15-01 (only explains slot-based latency) | Solana RPC docs |
| A-38 `SO_PEERCRED` (or equivalent) in Node without third-party code | VERIFY | B-M17-01 | Node docs; prototype; fallback documented |
| A-39 systemd `OOMScoreAdjust`, restart limits, encrypted credentials; droplet TPM; sudoers/polkit rule | VERIFY | B-M17-02, B-M29-02, B-M30-02 | Host systemd version; provider docs |
| A-40 Where a keyed Sender request carries its key and the `mev-protect` flag; per-region counting on the global endpoint | VERIFY | B-M18-02 | Helius docs |
| A-41 Jupiter `/build` wrap/unwrap parameter | VERIFY | B-M16-06 (disabled until resolved) | Jupiter docs |
| A-45 `node:sqlite` transactions, WAL, online backup | VERIFY | B-M24-01 | Node docs; prototype |
| A-46 PumpSwap swaps with temporary-wSOL instructions fit 1,232 bytes | VERIFY | B-M16-02, B-M16-04 | Build and simulate |
| A-47 Operator response time to out-of-band alerts | ASSUMPTION (operator sets it) | B-M29-03, D26 residual-loss statement | Notification drill |
| Jupiter `/order` parameters (taker, slippage) and response fields; `/execute` body and response; presence of `lastValidBlockHeight` | VERIFY (only `/order` + `/execute` existence and fees are in the register [EX-25, EX-26, EX-27, EX-29]) | B-M16-07, B-M18-05 | Jupiter docs |
| Jito `sendTransaction` request path and body | VERIFY (endpoints and limits in [LD-17, LD-18]) | B-M18-02 | Jito low-latency-send docs |
| Helius `getPriorityFeeEstimate` request and response field names | VERIFY (method and levels in [LD-12]) | B-M15-03 | Helius docs |
| `getRecentPerformanceSamples` field names | VERIFY (method used in [LD-08]) | B-M15-01 | Solana RPC docs |
| Compute Budget instruction byte order (little-endian integers) | VERIFY (discriminators and types in [LD-03]) | B-M16-01, B-M17-04 | Solana docs |
| v0 message wire format and address-lookup-table account layout | VERIFY | B-M17-04 | Solana versioned-transaction docs |
| SPL Token / Token-2022 instruction discriminators (`SyncNative`, `CloseAccount`, `Burn`, `Approve`, `SetAuthority`, transfers) | VERIFY | B-M16-02, B-M16-10, B-M17-04 | Token program sources |
| PumpSwap `buy_exact_quote_in`/`sell` argument names, minimum-output semantics and `track_volume` behaviour | VERIFY (account counts in [EX-10]) | B-M16-03, B-M17-04/05 | Pinned IDL + recorded transactions + SDK oracle |
| Pump curve fee-recipient lists and whether `spendable_quote_in` includes fees | VERIFY | B-M16-08 | pump docs (FEE_RECIPIENTS.md [EX-06]) |
| Simulation `accounts` option semantics for pre/post state | VERIFY (option exists [TH-46]) | B-M17-05 | Solana RPC docs |
| `getBlock` parameters for full transactions in block order | VERIFY | B-M23-05 | Solana RPC docs |
| CoinGecko simple-price endpoint and parameters | VERIFY (plan limits in [DA-27]) | B-M23-03 | CoinGecko docs |
| WebAuthn server library choice (or built-in verification) and Level 3 assertion format | VERIFY | B-M28-02 | Library docs; W3C spec |
| zod version and licence for `@bot/contract` | VERIFY | B-M28-01 | npm registry |
| Package-manager flag for disabling lifecycle scripts; host firewall hostname allowlisting method | VERIFY | B-M30-01, B-M30-02 | Package-manager and firewall docs |
| Operator OS notification command for the watcher; sentinel status binding to the tailnet interface | VERIFY | B-M29-03 | OS and Tailscale docs |
| Effectiveness of `jitodontfront` / `mev-protect` on small swaps | UNVERIFIED [LD-16, LD-22] | B-M16-01, B-M23-05 (measured by `detectSandwich`) | Post-trade sandwich detection |
| Landing rate and confirm latency from Frankfurt | UNVERIFIED (excluded claims) | B-M18-01..03 targets, gate LS-4 | Live-small measurement |
| Self-hosted push software for D27 (b) | UNVERIFIED | B-M29-03 option (b) | Dependency review if chosen |
| Any edge for MR-01 | Negative sub-hour proxy evidence; MR-01's 15 s signal untested (A-23) | Whether any M4 ticket is ever built | Gates B, R and P |
