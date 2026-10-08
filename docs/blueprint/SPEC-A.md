# Build specification - group A

Edited in Meme-snipe from 2026-10-07 (card Z0D); source commit `74e7258` of `macdarenz-droid/Snipe-solana` `main`.

Market data, screening, strategy, simulation, research analytics and the RPC gateway (modules M01-M14) for the Solana meme-coin trading bot.

- Author role: spec writer, module group A. Written 2026-10-06 against `ARCH.md` (the revised architecture, source of truth) and the view-model contract in `UI.md`. Design and build specifications only; no production code. Code fragments are interface specifications in TypeScript syntax (D05), not implementations.
- Group B (M15-M30) is specified elsewhere. This document cites group B only by module ID and interface name. The dashboard front-end tickets (UI-T01..UI-T32 in `UI.md`) are not repeated.
- Nothing here implies the bot will make money. The evidence in the register does not show an after-cost edge for any retail-latency meme-coin strategy (ARCH section 0). Several tickets exist only so that a strategy can **fail** cheaply and honestly before any real funds are at risk.

Labels (same meaning as in ARCH):

| Label | Meaning |
|---|---|
| [XX-nn] | A fact from the verified register. |
| **DERIVED** | Arithmetic on cited facts, done here. |
| **POLICY** | A design choice (threshold, default). Not evidence. |
| **ASSUMPTION** | Believed, not verified; impact stated. |
| **UNVERIFIED** | Not confirmed from the register. |
| **VERIFY against <source> before implementing** | A third-party interface detail the engineer must confirm from the named official source before writing code. This document never invents it. |

Conventions for every ticket:

- **Size** is a rough estimate (ASSUMPTION A-33): S ≤ 1 engineer-day, M = 1.5-2 days, L = 2.5-3 days.
- All on-chain quantities are `bigint` (`Lamports`, `BaseUnits`, `Slot`, ...), never JS `number` (ARCH 5.0). Integer bps are `number`. Durations end in `Ms`.
- No module calls `Date.now()` or `Math.random()`; it uses the injected `Clock` and a seeded `Rng` (ARCH 5.0).
- No network I/O except through M14 (`RpcGateway.call` / `RpcGateway.http`) or a transport the module declares (M03's PumpPortal socket, M04's optional WebSocket seam). Endpoint URLs and keys come only from M14's validated provider registry.
- Every error is a typed `{ code: string }`. Every log line goes through M27 `log.event(level, code, fields)` with schema redaction; metric registration goes through M27 `metric.*` (group B).
- Persistence goes through M24 repositories (group B owns the schema). Where a group A ticket needs a table or column that ARCH section 15 does not list, it is logged in "Architecture clarifications" for M24.
- "Fixture" means a stored raw RPC or HTTP response of public on-chain or public API data (no secrets), kept under `fixtures/` with the date it was captured and its source method. Fixture names are given as `fx/<area>/<name>`.

## Build order

### Milestones for group A

Phases follow ARCH section 18 (CB-14). A later milestone starts only when the earlier exit condition is met. Phase 3 work is blocked by a **gate result**, not by the calendar.

**Integration (binding).** The MA milestones below are kept for traceability; the build order that binds both groups is the global milestone plan in `INTEGRATION.md`. Mapping: MA-0a → M0; MA-0b and MA-0c → M1; MA-1 → M2 (together with the group B engine core B-M19/M20/M21/M22/M23 tickets that A-M11-02/03 drive); MA-2 → M3 (first paper-trading results); MA-3 → M4; MA-3b → M4b. The phase-0 tickets need group B's M0 foundations (B-M30-01, B-M19-01, B-M24-01/02, B-M25-01, B-M27-01, B-M15-01) first.

| Milestone | ARCH phase | Tickets | Exit condition |
|---|---|---|---|
| MA-0a Foundations | 0 | A-M14-01, A-M14-02, A-M02-01, A-M02-02, A-M02-03, A-M01-01, A-M10-01, A-M07-01, A-M13-03 (pure statistics may start on day 1) | Read path talks to two free providers; PumpSwap pool, fee-config and mint accounts decode from fixtures; constants re-derive their PDAs |
| MA-0b Recording | 0 | A-M14-03, A-M14-05, A-M02-04, A-M02-05, A-M01-02, A-M01-03, A-M01-04, A-M01-05, A-M03-01, A-M03-02, A-M03-04, A-M04-01, A-M04-02, A-M04-03, A-M05-01, A-M05-02, A-M05-03, A-M07-02, A-M07-03, A-M08-01, A-M08-02, A-M08-03, A-M10-03 | The recorder runs 48 h unattended with snapshot coverage ≥ 95% of watched pool-minutes, the first daily universe manifest is written, and the first migrations-only coverage result is recorded (D30 parked) |
| MA-0c Phase 0 decision | 0 | A-M13-01 | The A-48 report (disk and compression) is accepted by the product owner; A-24 and A-24b are parked with MR-01 (A-M13-01 "Parked parts"). MR-01 is already parked (C-76), so MA-0c unblocks no MR-01 ticket; the conditions below apply to a revised MR version entering through the strategy slot. **Stop MR-01** if fewer than 10 eligible pools on more than half of the days (and Phase 3b is not justified), if typical moves do not exceed the hurdle (ARCH 18), or if the kill-only check kills it (A-M13-01 step 9, C-48) |
| MA-1 Research | 1 | A-M13-02, A-M13-05, A-M09-01, A-M09-02 (unblocked by MA-0c), A-M09-03 (optional, PM track), A-M06-01..A-M06-06, A-M10-02, A-M10-04, A-M10-05, A-M11-01..A-M11-05, A-M13-04, A-M13-06, A-M13-08 | Strategy stage `replay_passed` (gates B on `W_B`, R on `W_R`), or the strategy is `failed` per D08 and work stops |
| MA-2 Paper | 2 | A-M12-01, A-M12-02, A-M02-06, A-M13-07 | Stage `paper_passed` (P-1..P-6, P-9, P-10), or stop |
| MA-3 Live path | 3 | A-M14-04 | Group B's live path passes P-7, P-8 and the go-live checklist |
| MA-3b Raydium (only on the D01 trigger) | 3b | A-M01-06, A-M02-07 | Raydium venue spec accepted; P-6 on Raydium pools (group B) |

### Ticket dependency list

"A" dependencies are tickets in this group. "B" dependencies are group B modules and the interface used (frozen contracts per ARCH 18). The column "B tickets, hard" was added at integration: it lists the group B tickets that must be merged before the ticket can be accepted (every ticket also needs B-M30-01 CI and B-M19-01 `@bot/types`). Interfaces listed only in the module column are runtime consumers or producers, not build dependencies.

| Ticket | Size | Phase | Depends on (A) | Depends on (B: module · interface) | Depends on (B tickets, hard; integration) | Global milestone |
|---|---|---|---|---|---|---|
| A-M01-01 | S | 0 | A-M02-01 | — | B-M19-01, B-M30-01 | M0 |
| A-M01-02 | M | 0 | A-M01-01, A-M02-02, A-M14-02 | M24 · repositories; M27 · alerts | B-M19-01, B-M24-02, B-M27-01, B-M30-01 | M1 |
| A-M01-03 | M | 0 | A-M01-02 | — | B-M19-01, B-M30-01 | M1 |
| A-M01-04 | S | 0 | A-M01-03, A-M02-03, A-M14-02 | — | B-M19-01, B-M30-01 | M1 |
| A-M01-05 | S | 0 | A-M01-02, A-M02-03 | M21 · `RiskEngine` (consumer of venue status); M23 · fill events topic | B-M19-01, B-M27-01, B-M30-01 | M1 |
| A-M01-06 | M | 3b | A-M01-03, A-M02-02 | M16 · `TxBuilder.buildSimulationOnly` (for golden simulation) | B-M16-05, B-M19-01, B-M30-01 | M4b |
| A-M02-01 | S | 0 | — | M26 · start-refusal path; M29 · `start_refused` protocol | B-M19-01, B-M30-01 | M0 |
| A-M02-02 | M | 0 | A-M02-01 | — | B-M19-01, B-M30-01 | M0 |
| A-M02-03 | M | 0 | A-M02-01 | — | B-M19-01, B-M30-01 | M0 |
| A-M02-04 | S | 0 | A-M02-03 | — | B-M19-01, B-M30-01 | M1 |
| A-M02-05 | S | 0 | A-M02-02, A-M02-03 | M24 · `quarantine` table | B-M19-01, B-M24-02, B-M27-01, B-M30-01 | M1 |
| A-M02-06 | S | 2 | A-M02-01 | M17 · classification (consumer) | B-M19-01, B-M30-01 | M3 |
| A-M02-07 | S | 3b | A-M01-06 | — | B-M19-01, B-M30-01 | M4b |
| A-M03-01 | M | 0 | A-M14-01 | M27 · metrics, alerts | B-M19-01, B-M27-01, B-M30-01 | M1 |
| A-M03-02 | M | 0 | A-M03-01, A-M02-03, A-M01-04, A-M14-02 | — | B-M19-01, B-M24-02, B-M30-01 | M1 |
| A-M03-03 | M | 0 | A-M01-01, A-M02-02, A-M14-02 | — | B-M19-01, B-M24-02, B-M30-01 | parked (D30, C-76; card Z-H-OF round 3) |
| A-M03-04 | S | 0 | A-M03-02, A-M14-03 | — | B-M19-01, B-M30-01 | M1 |
| A-M04-01 | M | 0 | A-M14-02, A-M02-02, A-M01-03, A-M01-04 | M15 · `ChainState.highestSeenSlot` | B-M15-01, B-M19-01, B-M30-01 | M1 |
| A-M04-02 | M | 0 | A-M04-01 | M15 · `ChainState.highestSeenSlot`, `slotDurationMsEstimate` | B-M15-01, B-M19-01, B-M30-01 | M1 |
| A-M04-03 | S | 0 | A-M04-01 | — | B-M19-01, B-M30-01 | M1 |
| A-M05-01 | M | 0 | A-M03-02, A-M04-02, A-M01-02 | M24 · `candidate` table; M22 · `written_off`/`unsolicited` lists | B-M19-01, B-M24-02, B-M25-01, B-M30-01 | M1 |
| A-M05-02 | M | 0 | A-M05-01, A-M04-01, A-M14-05 | M20 · caller of `pinForPosition`/`unpin` | B-M19-01, B-M30-01 | M1 |
| A-M05-03 | S | 0 | A-M05-02, A-M07-02 | — | B-M19-01, B-M30-01 | M1 |
| A-M06-01 | M | 1 | A-M05-01, A-M14-02 | M25 · `Config`; M24 · `screen_result` table | B-M19-01, B-M24-02, B-M25-01, B-M30-01 | M2 |
| A-M06-02 | M | 1 | A-M06-01, A-M02-02 | M24 · `token` table | B-M19-01, B-M24-02, B-M30-01 | M2 |
| A-M06-03 | M | 1 | A-M06-01, A-M02-02 | — | B-M19-01, B-M30-01 | M2 |
| A-M06-04 | M | 1 | A-M06-01, A-M01-05, A-M04-02, A-M08-02 | — | B-M19-01, B-M30-01 | M2 |
| A-M06-05 | M | 1 | A-M06-01, A-M10-03 | M16 · `TxBuilder.buildSimulationOnly`; M22 · `recordCashFlow` (`sim_funding` kind only, read side) | B-M15-03, B-M16-05, B-M19-01, B-M30-01 | M2 |
| A-M06-06 | S | 1 | A-M06-01, A-M14-03 | M20 · consumer of `token.authority_changed` | B-M19-01, B-M30-01 | M2 |
| A-M07-01 | M | 0 | — | — | B-M19-01, B-M30-01 | M0 |
| A-M07-02 | M | 0 | A-M07-01 | — | B-M19-01, B-M30-01 | M1 |
| A-M07-03 | S | 0 | A-M07-02 | M27 · alerts | B-M19-01, B-M27-01, B-M30-01 | M1 |
| A-M08-01 | M | 0 | A-M04-01, A-M01-03 | — | B-M19-01, B-M30-01 | M1 |
| A-M08-02 | M | 0 | A-M08-01 | — | B-M19-01, B-M30-01 | M1 |
| A-M08-03 | S | 0 | A-M08-01 | M24 · `bar_1m` table; M28 · VM-10 projection (consumer) | B-M19-01, B-M24-02, B-M30-01 | M1 |
| A-M09-01 | M | 1 | A-M08-02 | M20 · position lookup; M21 · consumer of `SignalProposal`; M25 · `Config` | B-M19-01, B-M25-01, B-M30-01 | M2 |
| A-M09-02 | S | 1 (blocked) | A-M09-01, A-M13-01, A-M13-02 | — | B-M19-01, B-M30-01 | M2 |
| A-M09-03 | S | 1 (blocked) | A-M09-01, A-M13-02, A-M03-02 | — | B-M19-01, B-M30-01 | M2 |
| A-M10-01 | S | 0 | — | — | B-M19-01, B-M30-01 | M0 |
| A-M10-02 | L | 1 | A-M10-01, A-M01-03 | M18 · `LandingPath`, `FailureClass` types (`@bot/types`) | B-M19-01, B-M30-01 | M2 |
| A-M10-03 | M | 0 | A-M10-01, A-M01-03 | M15 · `priorityFee`, `rentExemptMinimum` (engine-side use only) | B-M19-01, B-M30-01 | M1 |
| A-M10-04 | M | 1 | A-M10-02 | — | B-M19-01, B-M30-01 | M2 |
| A-M10-05 | M | 1 | A-M10-02, A-M10-04 | M23 · `SandwichCheck` results; M18 · attempt results | B-M19-01, B-M30-01 | M2 |
| A-M11-01 | M | 1 | A-M07-02, A-M10-01 | — | B-M19-01, B-M30-01 | M2 |
| A-M11-02 | M | 1 | A-M11-01, A-M08-02, A-M09-01, A-M10-04, A-M05-03 | M19 · `OrderManager`; M20 · `PositionManager`; M21 · `RiskEngine`; M22 · sim ledger; M23 · `TradeRecord` | B-M19-01, B-M19-02, B-M19-05, B-M20-01, B-M20-02, B-M20-04, B-M21-02, B-M21-03, B-M21-06, B-M22-05, B-M23-02, B-M30-01 | M2 |
| A-M11-03 | M | 1 | A-M11-02 | same as A-M11-02 | B-M19-01, B-M19-02, B-M19-05, B-M20-01, B-M20-02, B-M20-04, B-M21-02, B-M21-03, B-M21-06, B-M22-05, B-M23-02, B-M30-01 | M2 |
| A-M11-04 | S | 1 | A-M11-01, A-M10-03, A-M14-03 | — | B-M19-01, B-M30-01 | M2 |
| A-M11-05 | M | 1 | A-M11-02, A-M07-03 | M29 · `botctl import-run` (consumer) | B-M19-01, B-M30-01 | M2 |
| A-M12-01 | M | 2 | A-M10-04, A-M04-02 | M19 · `ExecutionPort`, `AttemptRequest`, `OrderIntent` read; M22 · paper `ataBalance` | B-M19-01, B-M19-02, B-M22-05, B-M30-01 | M3 |
| A-M12-02 | M | 2 | A-M12-01, A-M06-05 | M16 · `TxBuilder.buildSimulationOnly`; M24 · shadow results table | B-M16-05, B-M19-01, B-M24-02, B-M30-01 | M3 |
| A-M13-01 | M | 0 | A-M05-03, A-M08-01, A-M07-03, A-M10-03, A-M10-01, A-M13-03 | — | B-M19-01, B-M30-01 | M1 |
| A-M13-02 | S | 1 | A-M07-03 | M25 · `ConfigFieldSchema.affectsReturns`; M24 · `trial_registry` | B-M19-01, B-M24-02, B-M25-01, B-M30-01 | M2 |
| A-M13-03 | L | 0-1 | A-M10-01 | — | B-M19-01, B-M30-01 | M0 |
| A-M13-04 | M | 1 | A-M13-03 | M22 · `balances()`, cash-flow topic; M23 · `TradeRecord`, fixed-cost items, SOL/USD | B-M19-01, B-M24-02, B-M30-01 | M2 |
| A-M13-05 | M | 1 | A-M13-02 | M24 · `strategy_stage`; M26 · demotion events | B-M19-01, B-M24-02, B-M30-01 | M2 |
| A-M13-06 | M | 1 | A-M13-03, A-M13-04, A-M13-05, A-M13-08 | M26 · drill/checklist/cooldown inputs; M22 · reconciliation; M18 · landing stats; M23 · realised costs; M28 · VM-18 schema | B-M19-01, B-M30-01 | M2 |
| A-M13-07 | S | 2 | A-M13-03, A-M13-05 | M21/M26 · demotion on alarm | B-M19-01, B-M30-01 | M3 |
| A-M13-08 | S | 1 | A-M11-05, A-M13-02 | M29 · `botctl import-run`; M28 · VM-21 schema | B-M19-01, B-M24-02, B-M30-01 | M2 |
| A-M14-01 | M | 0 | — | M25 · `Config`; secret store per ARCH 12.4 | B-M19-01, B-M25-01, B-M27-01, B-M30-01 | M0 |
| A-M14-02 | M | 0 | A-M14-01 | M15 · subscriber of `rpc.context_slot` | B-M19-01, B-M30-01 | M0 |
| A-M14-03 | S | 0 | A-M14-01, A-M14-02 | — | B-M19-01, B-M30-01 | M1 |
| A-M14-04 | S | 3 | A-M14-01 | M18 · send scheduler (consumer) | B-M19-01, B-M30-01 | M4 |
| A-M14-05 | S | 0 | A-M14-02 | M27 · alerts; M28 · VM-13 projection | B-M19-01, B-M27-01, B-M30-01 | M1 |

### What can be built in parallel

With two to three engineers on group A:

- **Track 1 (I/O and venue):** A-M14-01 → A-M14-02 → (A-M14-03, A-M14-05) and, in parallel after A-M02-01, A-M02-02/03 → A-M01-01..05 → A-M04-01/02/03.
- **Track 2 (data capture):** A-M07-01/02/03 can start on day 1 against synthetic envelopes; A-M03-01..04 start once A-M14-01/02 exist; A-M05-01..03 and A-M08-01..03 follow A-M04-01.
- **Track 3 (pure research maths):** A-M13-03 (statistics library) and A-M10-01/A-M10-03 depend on nothing that does I/O and can be built and unit-tested from day 1. A-M13-02 and A-M13-05 follow.
- **Phase 1** splits cleanly: screening (A-M06-*) in one track; simulation and research drivers (A-M10-02/04/05, A-M11-*) in another; gates and stages (A-M13-04/05/06/08) in a third.
- **Hard serialisations:** A-M09-02 (MR-01) cannot be written before A-M13-01 is accepted (ARCH 3.2, 3.3). A-M11-02/03 need group B tickets B-M19-02, B-M19-05, B-M20-01, B-M20-02, B-M20-04, B-M21-02, B-M21-03, B-M21-06, B-M22-05 and B-M23-02 (global milestone M2), because backtests drive the engine's own order, position and risk code (ARCH 9.2); until those exist, A-M11-02 is built against B's frozen interfaces with test doubles and the gate runs wait for the real modules. A-M12-01 needs B-M19-01, B-M19-02 and B-M22-05.

## Tickets

### M01 Venue registry and quote model

#### A-M01-01 — Constants registry and PDA derivation

- **Module:** M01 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day, rough estimate)
- **Goal:** One reviewed source file holding every program ID, mint and PDA the system uses, with tests that re-derive every PDA from its seeds, so a mistyped address cannot reach a transaction or a filter.
- **Depends on:** A-M02-01 (base58 codec). B: none.
- **Interfaces:**

```ts
// package @bot/venue/constants (no runtime dependencies other than the base58 codec of A-M02-01 and @solana/kit for PDA derivation; clarification C-45)
export const PROGRAMS: Readonly<{
  pumpCurve: Pubkey;        // 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P  [EX-01]
  pumpSwap: Pubkey;         // pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA  [EX-01]
  pumpFees: Pubkey;         // pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ  [EX-01]
  raydiumAmmV4: Pubkey;     // 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 [DA-17]
  raydiumCpmm: Pubkey;      // CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C [DA-17]
  raydiumClmm: Pubkey;      // CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK [DA-17]
  raydiumLaunchLab: Pubkey; // LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj [DA-17]
  meteoraDbc: Pubkey;       // dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN [EX-19]
  meteoraDammV2: Pubkey;    // cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG [EX-21]
  meteoraDlmm: Pubkey;      // LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo [EX-21]
  orcaWhirlpools: Pubkey;   // whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc [EX-23]
  splToken: Pubkey;         // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA [LD-V05]
  token2022: Pubkey;        // TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb [DA-12]
  computeBudget: Pubkey;    // ComputeBudget111111111111111111111111111111 [LD-03]
}>;
export const MINTS: Readonly<{ wsol: Pubkey /* So11111111111111111111111111111111111111112 [DA-V01] */ }>;
export const ACCOUNTS: Readonly<{
  pumpGlobal: Pubkey;            // 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf, seeds ["global"] under pumpCurve [EX-01]
  pumpSwapGlobalConfig: Pubkey;  // ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw, seeds ["global_config"] under pumpSwap [EX-01]
  feeConfigCurve: Pubkey;        // 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt, seeds ["fee_config", pumpCurve] under pumpFees [EX-01]
  feeConfigPumpSwap: Pubkey;     // 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx, seeds ["fee_config", pumpSwap] under pumpFees [EX-01]
  migrationWithdrawAuthority: Pubkey; // 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg [EX-03]
}>;
export function pumpPoolAuthorityPda(baseMint: Pubkey): Pubkey;   // seeds: VERIFY (see Logic step 3)
export function deriveAndCheckAll(): Result<true, { code: 'E_CONSTANT_MISMATCH'; name: string; expected: Pubkey; derived: Pubkey }>;
```

- **Logic:**
  1. Store every constant above as a literal with its fact ID in a comment. No other file may contain a base58 program ID literal (a lint rule enforces it; allow-list only this file and test fixtures).
  2. `deriveAndCheckAll()` derives the four PDAs with the seeds given in [EX-01] through `@solana/kit`'s program-derived-address helper (VERIFY the exact function name and signature in `@solana/kit` 8.x [LD-36] before implementing) and compares each with the literal. Expected bumps per [EX-01] note: 255, 255, 253, 255 (asserted in tests, not used at runtime).
  3. `pumpPoolAuthorityPda(baseMint)`: the canonical-pool rule is `pool.creator == pumpPoolAuthorityPda(baseMint)` [EX-08], but the seeds are **not** in the register. VERIFY against the pinned `pump.json` IDL (PDA seed definitions) and `PUMP_SWAP_README.md` in pump-public-docs before implementing. Until verified, the function throws `E_UNVERIFIED_SEEDS` and every pool's `isCanonical` is `null`, which the screener treats as `error` (reject) (clarification C-04).
  4. The engine calls `deriveAndCheckAll()` at startup; on mismatch it refuses to start trading (same handling as an IDL hash mismatch, A-M02-01).
- **Shared resources and concurrency:** none (pure, immutable constants). No idempotency concern.
- **Config:** none. Constants are code, changed only by a reviewed commit (ARCH M01).
- **Edge cases and failure handling:**
  1. PDA derivation helper unavailable or changed in a kit upgrade → test fails in CI; no deploy.
  2. A derived PDA differs from the literal → `E_CONSTANT_MISMATCH`, engine start refused, alert `config` critical via M27.
  3. Seeds for the pool-authority PDA still unverified at Phase 0 → canonicality `null`; the A-24 count (A-M13-01) reports these pools separately as "canonicality unknown" and does not count them as eligible.
- **Acceptance criteria:**
  - Given the constants file, when `deriveAndCheckAll()` runs, then it returns `ok` and the four derived PDAs equal the literals, with bumps 255, 255, 253, 255.
  - Given a recorded canonical PumpSwap pool fixture (for example pool `9jkXWMyt...` from [EX-09]) and the verified seeds, when `pumpPoolAuthorityPda(pool.baseMint)` runs, then it equals `pool.creator`; for a recorded non-canonical pool it differs.
  - Given any source file other than the constants file containing a 32-44 character base58 literal matching a known program ID, when lint runs, then CI fails.
- **Tests:** unit (all derivations; bumps); negative test with one seed byte changed; integration: canonical vs non-canonical pool fixtures. Fixtures: `fx/pumpswap/pool_canonical_9jkXWMyt.json`, `fx/pumpswap/pool_noncanonical.json` (getAccountInfo base64 at confirmed).
- **Observability:** log event `M01.constants_checked` (ok/mismatch, name). No metrics.
- **Security notes:** an attacker-controlled address in this file would redirect swaps; changes require code review, and the signer (M17) keeps its own allowlist, so this file is not the only line of defence.
- **Facts used:** EX-01, EX-03, EX-08, EX-19, EX-21, EX-23, DA-12, DA-17, DA-V01, LD-03, LD-V05, LD-36, VF-01.
- **Definition of done:** constants merged with fact comments; derivation tests green; lint rule active in CI; `pumpPoolAuthorityPda` seeds either verified (with the source commit recorded in the file header) or the function still throws and the gap is listed in "Unverified items".

#### A-M01-02 — Venue config cache and fee-schedule selection

- **Module:** M01 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Read, decode and version the fee configuration and global flags of every allowlisted venue, and select the fee schedule for a given pool state conservatively.
- **Depends on:** A-M01-01, A-M02-02 (fee-config and global-config decoders), A-M14-02 (reads). B: M24 repositories (persist schedule versions), M27 alerts.
- **Interfaces (ARCH M01 types, plus additions marked NEW and logged in clarification C-01):**

```ts
type VenueId = 'pump_curve' | 'pumpswap' | 'raydium_amm_v4' | 'raydium_cpmm';
interface FeeSchedule { lpBps: Bps; protocolBps: Bps; creatorBps: Bps; totalBps: Bps;
  feeOnBuy: 'added_on_top' | 'from_input'; sourceAccount: Pubkey; asOfSlot: Slot; configHash: string }
interface VenueConfigCacheEntry {                                     // NEW (internal record of the owned cache)
  venue: VenueId; account: Pubkey; version: number; configHash: string /* sha256 of raw account data */;
  decoded: DecodedAccount /* 'pump_fee_config' | 'pumpswap_global_config' | 'pump_global' */;
  asOfSlot: Slot; readAtMs: UnixMs; changedAtMs: UnixMs }
interface VenueModel {   // fee part of ARCH VenueModel
  feeFor(p: CpPoolState): Result<FeeSchedule, { code: 'E_FEE_UNKNOWN' | 'E_CONFIG_STALE' }>;
  marketCapLamports(p: CpPoolState): Lamports;   // quote × supply / base [EX-07]
}
interface VenueConfigCache {                                           // NEW
  refresh(): Promise<void>;                                            // called by the M01 timer
  entry(account: Pubkey): VenueConfigCacheEntry | null;
  candidateTiers(p: CpPoolState): FeeSchedule[];                       // every tier the conservative rule considered (used by A-M01-05)
}
```

- **Logic:**
  1. Every `fee_config.refresh_ms` (default 60 s) issue one `getMultipleAccounts` at `confirmed`, priority P3, for: `feeConfigCurve`, `feeConfigPumpSwap`, `pumpSwapGlobalConfig`, `pumpGlobal` [EX-01]. Decode with A-M02-02. Compute `configHash = sha256(raw data)`.
  2. If `configHash` differs from the stored entry: increment `version`, set `changedAtMs = now`, persist the new decoded config, publish `venue.fee_schedule_changed` (A-M01-05 handles consequences).
  3. `feeFor(p)`:
     - `pump_curve`: the curve FeeConfig has one tier for all market caps (0 / 95 / 30 bps on 2026-10-06 [EX-05]); return it with `feeOnBuy = 'added_on_top'` (fee added on top of the SOL amount on buys, taken from proceeds on sells [EX-05]). The buyback share is carved out of the protocol fee, not added [EX-06]; it does not change `totalBps`.
     - `pumpswap`, `isCanonical === true`: tiered by market cap [EX-07]. Market cap (lamports) = `floor(effectiveQuote × supply / baseReserve)` with `effectiveQuote` = vault + `virtual_quote_reserves` and `supply` = the mint supply, or a fixed 1,000,000,000,000,000 base units when `Pool.is_mayhem_mode` is set [VF-04] (settled 2026-10-07; the earlier "lower of vault-only and effective" rule of C-10 is withdrawn, because a quote on the vault alone fails A08's fixture). A tier applies when market cap ≥ its threshold (inclusive); below the first threshold the first tier applies [VF-04]. Creator fee: 0 when `Pool.coin_creator` is the default key; when `GlobalConfig.creator_fee_configurable` is true and `Pool.creator_fee_bps > 0`, the per-pool `creator_fee_bps` replaces the schedule's creator rate (lp and protocol rates unchanged) [VF-04]. Quote mints other than the SOL-like ones and USDC use `exotic_flat_fees`, or `flat_fees` while every `exotic_flat_fees` rate is zero [VF-04] (and are rejected by orientation anyway). Each fee component (lp, protocol, creator) is rounded up (`ceil`) separately [VF-04]. The ≤ 30 bps per-side filter (ARCH 8.4) reads this per-pool total, creator fee included (A08).
     - `pumpswap`, `isCanonical === false`: `flat_fees` (25 / 5 / 0 bps on 2026-10-06 [EX-08]).
     - `pumpswap`, `isCanonical === null` (seeds unverified, A-M01-01): `E_FEE_UNKNOWN`.
     - Raydium venues: `E_FEE_UNKNOWN` until the Raydium venue spec (A-M01-06) is accepted.
     - Pools of USDC-quoted coins use `stable_fee_tiers` [EX-07]; they are rejected by orientation (A-M01-04) before reaching here; if reached, `E_FEE_UNKNOWN`.
  4. `feeOnBuy` for PumpSwap is `'added_on_top'`: buy fees are added on top of the pre-fee quote input and sell fees are taken from the gross output [VF-04]. Buy exact quote in: `q′ = floor(quote × 10,000 / (10,000 + totalBps))`, reduced while `q′` plus its fees exceeds `quote`, and the swap input is `q′ − 1` [VF-04]. `@pump-fun/pump-swap-sdk` [EX-10] stays a test oracle only (never a runtime dependency, ARCH 4.4); the 353 PumpSwap goldens (A08) are the on-chain check (clarification C-11).
  5. Tier choice for a trade (used by A-M01-03): compute the schedule at the pre-trade market cap and at the post-trade market cap (after applying the trade to the reserves); use the more expensive (ARCH M01 failure table "Pool at a tier boundary").
  6. `E_CONFIG_STALE` when the newest successful read is older than `fee_config.max_age_ms` (default 600 s, matching the `fee_config_known` check's 10-minute rule in ARCH 8.4).
- **Shared resources and concurrency:** M01 exclusively owns `VenueConfigCache` (ARCH M01). Single writer: the M01 refresh timer on the event loop; readers get immutable entry objects (copy-on-write: a refresh builds a new entry and swaps the reference). Idempotency: entries keyed by `(account, configHash)`; re-reading identical data never bumps `version`.
- **Config:**

| Key | Type / unit | Default | Range / validation | affectsReturns |
|---|---|---|---|---|
| `venue.fee_config.refresh_ms` | duration_ms | 60,000 | 10,000-300,000 | no |
| `venue.fee_config.max_age_ms` | duration_ms | 600,000 | ≥ 2 × refresh_ms, ≤ 600,000 | no |

- **Edge cases and failure handling:**
  1. Decode fails or layout unknown → venue `unquotable` (A-M01-05), alert `config` critical; `feeFor` returns `E_FEE_UNKNOWN` for that venue.
  2. Account missing or owner not `pumpFees` / expected program → treated as decode failure.
  3. RPC failure on refresh → keep last entry; after `max_age_ms` `feeFor` returns `E_CONFIG_STALE` (blocks entries via M21; exits use the last valid schedule plus extra slippage per A-M01-05).
  4. `baseReserve = 0` → market cap undefined → `E_FEE_UNKNOWN` (pool also fails depth checks).
  5. Tier list unsorted or with duplicate thresholds after decode → sort by threshold ascending; duplicates with different fees → `E_FEE_UNKNOWN` and alert (layout misread).
  6. The admin changes tiers (`upsert_fee_tiers`, `update_fee_config` [EX-12, TH-19]) → handled by step 2 and A-M01-05.
- **Acceptance criteria:**
  - Given the recorded PumpSwap FeeConfig fixture of 2026-10-06, when decoded, then 25 tiers are present, the first is 2/93/30 below 420 SOL and the last is 20/5/5 at ≥ 98,240 SOL [EX-07], and `flat_fees` = 25/5/0 [EX-08].
  - Given a canonical pool whose pre-trade market cap is 419.999 SOL and whose post-trade market cap is 420.001 SOL (step 5), then the trade is charged 2/93/30 (the more expensive tier).
  - Given a canonical pool whose market cap is below the first tier's threshold, then the first tier applies; given a canonical pool with an exotic quote mint and `exotic_flat_fees` all zero, then `flat_fees` apply; with a non-zero `exotic_flat_fees`, those apply [VF-04].
  - Given a pool exactly at a threshold, then the result is the more expensive of the two adjacent tiers.
  - Given the curve FeeConfig fixture, then `feeFor` returns 0/95/30, `feeOnBuy = 'added_on_top'`.
  - Given no successful refresh for 601 s, then `feeFor` returns `E_CONFIG_STALE`.
- **Tests:** unit for every tier threshold ±1 lamport of market cap (both sides of 420, 1,470, 2,460, 3,440, 4,420, 9,820, 14,740 ... 98,240 SOL [EX-07]); property test: for canonical pools `feeFor(...).totalBps` is non-increasing in market cap (ARCH 16.2); integration with fixtures `fx/pumpfees/fee_config_pumpswap_2026-10-06.json`, `fx/pumpfees/fee_config_curve_2026-10-06.json`, `fx/pumpswap/global_config_2026-10-06.json`, `fx/pump/global_2026-10-06.json`; failure injection: RPC timeouts for 11 minutes → `E_CONFIG_STALE`. Clarification C-59 (A08): the creator fee is read per pool from chain at decision time; the CORE-2 goldens are imported (card Z07).
- **Observability:** metrics `venue_config_age_ms` (venue), `venue_config_version` (venue); log events `M01.fee_config_refreshed`, `M01.fee_config_changed` (old/new hash, version), `M01.fee_config_decode_failed`.
- **Security notes:** fee configs are attacker-irrelevant but admin-controlled [EX-12]; the model never trusts a cached value older than 10 minutes for entries. Raw account data is validated for owner and length before decoding.
- **Facts used:** EX-01, EX-05, EX-06, EX-07, EX-08, EX-09, EX-10, EX-12, TH-19, VF-04.
- **Definition of done:** cache, refresh timer and `feeFor` merged; tier tests and the property test green; the two VERIFY items (market-cap input, `feeOnBuy` for PumpSwap) resolved with the doc section and commit cited in code comments, or left conservative as above and listed as unverified.

#### A-M01-03 — Constant-product quote math and `minOut`

- **Module:** M01 · **Phase:** 0 · **Size:** M (≈ 2 engineer-days)
- **Goal:** Exact, integer, conservative ExactIn quotes for PumpSwap pools (and the pump curve for research), used identically by the screener, simulator, risk engine, builder, exits and sentinel.
- **Depends on:** A-M01-02. B: none (consumers M16, M20, M21, M23, M29 use it through the frozen `VenueModel`).
- **Interfaces (ARCH M01, unchanged):**

```ts
interface CpPoolState { venue: VenueId; poolId: Pubkey; baseMint: Pubkey; quoteMint: Pubkey;
  baseReserve: BaseUnits; quoteReserveReal: Lamports; quoteReserveVirtual: bigint /* i128 */;
  baseMintSupply: BaseUnits; isCanonical: boolean | null; curveComplete: boolean | null;
  asOfSlot: Slot; commitment: Commitment; observedAtMs: UnixMs }
interface Quote { side: 'buy' | 'sell'; amountIn: bigint; amountOut: bigint; venueFeeLamports: Lamports;
  priceImpactBps: Bps; spotBeforeSolPerToken: DecimalStr; feeSchedule: FeeSchedule; poolAsOfSlot: Slot }
interface VenueModel {
  effectiveQuote(p: CpPoolState): Lamports;                       // real + virtual; throws { code: 'E_NEGATIVE_EFFECTIVE' } if < 0
  marketCapLamports(p: CpPoolState): Lamports;
  feeFor(p: CpPoolState): Result<FeeSchedule, { code: 'E_FEE_UNKNOWN' | 'E_CONFIG_STALE' }>;
  quoteExactIn(p: CpPoolState, side: 'buy' | 'sell', amountIn: bigint): Result<Quote, { code: string }>;
  minOut(q: Quote, slippageBps: Bps): bigint;                     // floor(amountOut × (10_000 − slippageBps) / 10_000)
  isAllowedVenue(programId: Pubkey): VenueId | null;
}
// quoteExactIn error codes: 'E_FEE_UNKNOWN' | 'E_CONFIG_STALE' | 'E_NEGATIVE_EFFECTIVE' | 'E_ZERO_RESERVE' | 'E_ZERO_INPUT'
//                           | 'E_CURVE_COMPLETE' | 'E_VENUE_NOT_SPECIFIED' | 'E_OVERFLOW' | 'E_DECIMALS_UNKNOWN'
```

- **Logic:**
  1. `effectiveQuote(p) = quoteReserveReal + quoteReserveVirtual` (i128 arithmetic in bigint). Negative → throw `E_NEGATIVE_EFFECTIVE` (violates the documented guarantee [EX-09, DA-14]). For the pump curve `quoteReserveVirtual` = virtual − real SOL (30 SOL at creation [EX-02]).
  2. Buy, quote `Q = effectiveQuote`, base `B = baseReserve` [EX-09: base side uses the raw vault balance]:
     - Net input `x_net` from the input and the fee schedule. For `feeOnBuy = 'added_on_top'` (pump curve [EX-05]) the caller's `amountIn` is the total spend including fee, and `x_net` is the largest integer with `x_net + fee(x_net) ≤ amountIn`, where `fee(x) = ceil(x × totalBps / 10_000)` (rounding direction VERIFY against pump-public-docs `instructions/BUY.md`; the ceil choice is conservative for us). For `'from_input'` the fee is taken from `amountIn` before the curve (formula and rounding VERIFY per A-M01-02 step 4).
     - `tokens_out = floor(B × x_net / (Q + x_net))` (constant product [EX-02, EX-09]; ARCH 2.1).
     - `venueFeeLamports = amountIn − x_net`.
  3. Sell, input `t` base units: `quote_gross = floor(Q × t / (B + t))`; fee from proceeds `fee = ceil(quote_gross × totalBps / 10_000)` [EX-05 for the curve; PumpSwap placement VERIFY]; `amountOut = quote_gross − fee`; `venueFeeLamports = fee`.
  4. The fee schedule is chosen by the pre/post-trade conservative rule (A-M01-02 step 5); a second pass recomputes with the more expensive schedule if the post-trade tier differs.
  5. `spotBeforeSolPerToken` = `(Q / 10^9) / (B / 10^decimals)` as an exact rational rendered as `DecimalStr` with 24 fractional digits, truncated toward zero (decimals from the mint via M06 `TokenMetadataCache` or A-M02-02's mint decoder; pump mints use 6 [DA-12]). If decimals are unknown, `quoteExactIn` returns `E_DECIMALS_UNKNOWN` (never a guessed price; VM convention: an unknown value is never coerced).
  6. `priceImpactBps`: buys `ceil((avgPrice / spot − 1) × 10_000)` with `avgPrice = x_net / tokens_out`; sells `ceil((1 − avgPrice / spot) × 10_000)` with `avgPrice = quote_gross / t`; computed in rational bigint arithmetic. Fees are excluded from impact (they are in `venueFeeLamports`).
  7. Pump curve: `E_CURVE_COMPLETE` when `curveComplete = true` (trading moves to PumpSwap after migration [EX-03, EX-04]). A buy is capped so that real tokens never go below 0: if `tokens_out > realTokenReserves`, the quote is computed for the remaining real tokens only and `amountIn` is reduced accordingly (the buy that completes the curve [EX-03]); this is research-only behaviour.
  8. `minOut(q, s)`: `s` must be an integer 0-10,000; result `floor(q.amountOut × (10_000 − s) / 10_000)`; invalid `s` throws `E_INVALID_SLIPPAGE`.
  9. `isAllowedVenue`: maps `PROGRAMS.pumpCurve` → `pump_curve`, `PROGRAMS.pumpSwap` → `pumpswap`, and the Raydium AMM v4 / CPMM IDs → their `VenueId` (these still fail with `E_VENUE_NOT_SPECIFIED` in `quoteExactIn` until A-M01-06 is accepted, D18); anything else → `null`.
  10. All arithmetic is bigint; any intermediate product above 2^128 is rejected with `E_OVERFLOW` (defensive; not reachable with u64 reserves and i128 virtual).
- **Shared resources and concurrency:** pure functions; read-only access to the `VenueConfigCache` snapshot passed in through `feeFor`. Deterministic for identical inputs.
- **Config:** none (fee schedules come from chain; slippage values are supplied by callers from M21/M20 policy).
- **Edge cases and failure handling:**
  1. `amountIn = 0` → `E_ZERO_INPUT`. `B = 0` or `Q = 0` → `E_ZERO_RESERVE`.
  2. `x_net` rounds to 0 after fees (dust) → `E_ZERO_INPUT`.
  3. `tokens_out = 0` → quote returned with `amountOut = 0`; callers must treat as unusable (M21 rejects).
  4. Negative virtual reserves with non-negative sum (allowed since 30 September [EX-09, DA-14]) → normal quote.
  5. Effective quote larger than the real vault (virtual positive, ≈ 17.58 SOL at migration [EX-V01]): the quote is computed on effective reserves as the program prices; a sell whose output exceeds what the real vault can pay is **refused** by the program, not clamped: the official SDK throws when `real_quote_vault < gross_out − lp_fee` [VF-05] (settled 2026-10-07; C-13 as amended). `quoteExactIn` for such a sell returns `E_EXCEEDS_REAL_VAULT` together with `maxSellableBase`, the largest input that can land; the exit ladder (B-M20-04) sizes every sell to the real vault so it can land. M06's `real_vs_effective_quote` check rejects such pools for entries anyway. The boundary test runs on an SDK-math fixture (the official SDK's refusal rule [VF-05] reproduced on the drained-pool state); the on-chain result is **not verified** until a recorded failed sell is replayed, because the program source is not public and the simulation payer holds no position tokens. No test may rely on simulating a sell as a holder.
- **Acceptance criteria:**
  - Given the pump Global constants (virtual token 1,073,000,000,000,000; virtual SOL 30,000,000,000; real token 793,100,000,000,000; supply 1,000,000,000,000,000 [EX-02]), when a buy sequence sells all real tokens, then the curve completes with about 85.005 SOL real (DERIVED [EX-03]) within 1 lamport per step of an independent rational computation.
  - Given ≥ 20 recorded PumpSwap pool states with a recorded swap in the next slot, when `quoteExactIn` is computed for that swap's input on the pre-trade state, then `amountOut` matches the swap's decoded event output within 1 bp (ARCH M01; requires the VERIFY items resolved).
  - Given any `q` and `s` in 0..10,000, then `minOut(q, s) ≤ q.amountOut`.
  - Given a pool with `quoteReserveVirtual` negative and a non-negative sum, then the quote succeeds; with a negative sum it throws `E_NEGATIVE_EFFECTIVE`.
  - Given the drained-pool state (17.58 SOL virtual, 0.27 SOL real [RS-17]) and a sell whose gross output less the LP fee exceeds the real vault, then `quoteExactIn` returns `E_EXCEEDS_REAL_VAULT` with `maxSellableBase`, and a sell of `maxSellableBase` quotes normally (C-13 as amended, [VF-05]).
  - Given a mayhem pool, then the tier uses a supply of 10^15; given `creator_fee_configurable` with `creator_fee_bps` = 50, then the creator rate is 50 bps; given `coin_creator` = the default key, then the creator fee is 0 [VF-04].
- **Tests:** unit vectors (ARCH 16.1); property-based (ARCH 16.2): `k` after a swap excluding fee extraction ≥ `k` before; buy then sell of the received tokens with no other flow returns ≤ input; output monotonic in input; `minOut ≤ amountOut`; integration: `fx/pumpswap/swaps_20_pool_states.json` (pool state at slot S−1 plus the BuyEvent/SellEvent at slot S [EX-37]), `fx/pump/trade_events_curve.json`; golden comparison with `@pump-fun/pump-swap-sdk` quote functions in tests only. Clarification C-59 (A08): quotes use the per-pool creator fee; reserve timing (PumpSwap events pre-swap, pump `TradeEvent` post-trade) is tested on the CORE-2 goldens.
- **Observability:** metric `quote_compute_us` (histogram, venue); log event `M01.sell_exceeds_real_vault` (pool, slot, `maxSellableBase`).
- **Security notes:** quote math is the basis of every on-chain bound (`minOut`); a rounding error in our favour would weaken the slippage protection, so every rounding is in the direction that makes our bound stricter. No floating point anywhere in this ticket.
- **Facts used:** EX-02, EX-03, EX-04, EX-05, EX-07, EX-09, EX-10, EX-37, EX-V01, DA-12, DA-14, VF-04, VF-05.
- **Definition of done:** functions merged with 100% branch coverage; property tests green with ≥ 10,000 cases each; the 1 bp golden test green on recorded PumpSwap swaps (or, until the PumpSwap fee placement is verified, the venue is marked `unquotable` for live use and the gap is listed).

#### A-M01-04 — Pool orientation normalisation and spot-vs-swap check

- **Module:** M01 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Guarantee that every `CpPoolState` has `quoteMint = wSOL` and `baseMint = token`, reject non-SOL pools, and detect a wrong orientation from live swap evidence (CA-27).
- **Depends on:** A-M01-03, A-M02-03 (event decoding), A-M14-02 (reads). B: none.
- **Interfaces:**

```ts
type NormaliseError = { code: 'E_NOT_SOL_QUOTED' | 'E_VENUE_NOT_SPECIFIED' | 'E_LAYOUT'; detail: string };
function normalisePool(venue: VenueId, decodedPool: DecodedAccount, vaults: { baseVault: DecodedAccount; quoteVault: DecodedAccount },
  mint: { supplyBase: BaseUnits } , ctx: { asOfSlot: Slot; commitment: Commitment; observedAtMs: UnixMs }): Result<CpPoolState, NormaliseError>;   // NEW (internal to M01; used by M03, M04)
interface OrientationGuard {                                                                          // NEW
  checkAgainstEvent(p: CpPoolState, e: Extract<DecodedEvent, { kind: 'pumpswap_buy' | 'pumpswap_sell' }>):
    { status: 'pass' | 'fail' | 'not_evaluable'; observedBps: number | null; reason: string };
  quarantined(poolId: Pubkey): boolean;
}
// publishes 'venue.pool_quarantined' { poolId, reason: 'orientation' | 'negative_effective' | 'owner_changed', atMs }
```

- **Logic:**
  1. PumpSwap: decoded pool has `baseMint`, `quoteMint`. If `quoteMint == MINTS.wsol` → base reserve = base vault token amount, real quote = quote vault token amount (the vault's `amount` field [EX-09]). If `baseMint == MINTS.wsol` and `quoteMint != wsol` → swap the roles (reserves follow the mints, not the field names). If neither is wSOL → `E_NOT_SOL_QUOTED` (USDC-paired coins and others [EX-10, DA-13]).
  2. The vault accounts must be token accounts whose `mint` equals the expected mint and whose `owner` equals the pool's authority as stored in the pool account (VERIFY the field that names the vault owner in the pinned IDL); otherwise `E_LAYOUT`.
  3. Raydium venues: `E_VENUE_NOT_SPECIFIED` until A-M01-06; the venue spec defines the mapping for both token orderings (ARCH M01).
  4. Spot-vs-swap check (ARCH M01 failure table, 1% tolerance): every `orientation.check_interval_ms` (default 600 s) per watched pool at P3, fetch the latest `orientation.sample_signatures` (default 5) signatures for the pool address (`getSignaturesForAddress`, limit 5, confirmed [DA-08]) and the transactions (`getTransaction`, `maxSupportedTransactionVersion: 1` [LD-05]); decode PumpSwap `BuyEvent` / `SellEvent` (A-M02-03). Our own fills (published by M18/M23 on topic `fill.events`) are checked the same way.
  5. Comparison for one event: if the pinned IDL's `BuyEvent`/`SellEvent` carries the pool's reserves after the trade (VERIFY field names in `pump_amm.json`), compute the event-implied spot from those reserves and compare with our normalised spot at the snapshot with the same slot, if any; otherwise compute our modelled average execution price for the event's exact input on our snapshot at slot `S−1` or the nearest earlier snapshot no more than `orientation.max_slot_gap` (default 2) slots older; if no such snapshot exists → `not_evaluable`. `observedBps = |event_price / model_price − 1| × 10_000`. `fail` when > 100 bps.
  6. One `fail` → quarantine the pool: publish `venue.pool_quarantined`; M05 moves the candidate to `blacklisted` pending review; M20 (group B) marks positions in it for exit through the ladder; alert `config` critical (ARCH M01).
- **Shared resources and concurrency:** the quarantine set is owned by M01 (in memory, persisted through M24 as a `pool` flag; see clarifications). Single writer (event loop). Idempotency: quarantine keyed by `poolId`; repeated failures do not re-publish within 1 h.
- **Config:** `venue.orientation.check_interval_ms` (duration_ms, 600,000, range 60,000-3,600,000); `venue.orientation.sample_signatures` (int, 5, 1-20); `venue.orientation.max_slot_gap` (int slots, 2, 0-10); `venue.orientation.tolerance_bps` (bps, 100, 10-500; affectsReturns: false; risk direction: increasing it increases risk).
- **Edge cases and failure handling:**
  1. Pool with no recent swaps → `not_evaluable`; no action (common for quiet pools).
  2. Event decoding gap (truncated logs, no self-CPI) → `not_evaluable`, counted in `decode_gap`.
  3. Large trades with big impact: handled by comparing to the modelled average price, not to spot.
  4. Failed transactions (`meta.err != null`) are skipped (no events used).
  5. RPC failure → retry at next interval; no quarantine without evidence.
- **Acceptance criteria:**
  - Given a fixture pool with `quoteMint = wSOL`, when normalised, then `baseMint` is the token and reserves map to the matching vaults.
  - Given a synthetic pool with the two mints swapped, when normalised, then the resulting `CpPoolState` equals the correctly ordered one.
  - Given a USDC-quoted pool fixture, then `E_NOT_SOL_QUOTED`.
  - Given a recorded swap and a snapshot one slot earlier, when the model is deliberately fed inverted reserves, then the check returns `fail` and the pool is quarantined; with correct reserves it returns `pass` with `observedBps ≤ 100`.
- **Tests:** unit (all branches); integration fixtures `fx/pumpswap/pool_and_vaults_canonical.json`, `fx/pumpswap/usdc_pool.json` (if one is found on chain; otherwise a synthetic account built from the IDL), `fx/pumpswap/recent_swaps_with_preceding_snapshot.json`; failure injection: inverted reserves → quarantine within one check interval.
- **Observability:** metrics `orientation_checks_total` (status), `pools_quarantined_total` (reason); log events `M01.orientation_fail` (pool, observedBps, slot), `M01.pool_quarantined`.
- **Security notes:** a wrong orientation would invert every bound and price; quarantine is fail-closed for entries and moves positions to exit.
- **Facts used:** EX-09, EX-10, EX-37, DA-08, DA-13, LD-05, VF-06.
- **Definition of done:** normalisation used by M03 and M04 paths; orientation guard running on watched pools; tests green; the event reserve-field VERIFY resolved or the modelled-price fallback documented as the active method.

#### A-M01-05 — Venue status: fee-schedule changes, unquotable venues, realised-fee mismatches

- **Module:** M01 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Turn venue-configuration events into one venue status that M06, M20 and M21 read, implementing the M01 failure table.
- **Depends on:** A-M01-02, A-M02-03. B (integration): topic `fill.events { attemptId, poolId, events: DecodedEvent[], atMs }` is produced by B-M18-03 (live) and A-M12-01 (paper, `events = []`); consumers of this ticket's events are B-M20-03 and B-M21-04 (`venue.status_changed`, `venue.fee_schedule_changed`; ARCH's event name `FeeScheduleChanged` is the payload type on that topic).
- **Interfaces:**

```ts
interface VenueStatus {                                                         // NEW
  venue: VenueId; quotable: boolean; enabledBuy: boolean | null; enabledSell: boolean | null;
  reason: 'ok' | 'decode_failed' | 'config_stale' | 'fee_mismatch' | 'disabled_flag' | 'venue_not_specified';
  lastScheduleChangeAtMs: UnixMs | null; lastScheduleChangeDirection: 'raised' | 'lowered' | 'mixed' | null;
  extraExitSlippageBps: Bps;                                                     // 100 when unquotable (ARCH M01), else 0
  feeMismatches24h: number; asOfMs: UnixMs }
interface VenueStatusService {                                                  // NEW
  status(venue: VenueId): VenueStatus;
  onFillEvent(e: DecodedEvent, expected: { poolId: Pubkey; candidates: FeeSchedule[] }): void;   // fed from topic 'fill.events'
}
// publishes 'venue.status_changed' (VenueStatus) and 'venue.fee_schedule_changed' { venue, oldHash, newHash, direction, atMs }
```

- **Logic:**
  1. Decode failure of a fee config or global config → `quotable = false`, `reason = decode_failed`, `extraExitSlippageBps = 100`; alert `config` critical (ARCH M01).
  2. Config older than `max_age_ms` → `quotable = false`, `reason = config_stale`.
  3. Schedule hash change → publish `venue.fee_schedule_changed` with `direction` (`raised` if any tier's `totalBps` rose and none fell; `lowered` if the reverse; else `mixed`); alert warning (ARCH 13.4). M21 applies gate L-4 (demotion) and M20 re-evaluates exits (ARCH 8.6 "Venue fee-config change"). M06's `fee_config_known` fails for 10 minutes after any change.
  4. PumpSwap `GlobalConfig.disable_flags` (A-M02-02): bits for buy and sell set → `enabledBuy`/`enabledSell = false`, `reason = disabled_flag` [EX-12, TH-19]. The README says the field is "currently not used" while documenting `disable()` [TH-19, TH-V04]; the flag is still honoured. Bit positions: VERIFY against `pump_amm.json` / `PUMP_SWAP_README.md`; until verified, `enabledBuy`/`enabledSell` are `null` and M06's `venue_enabled` check returns `error` (reject entries) unless `disable_flags == 0` (all clear, observed on 2026-10-06 [EX-12 note]), in which case both are `true`.
  5. Realised-fee check: for each decoded own fill event (PumpSwap `lp_fee_basis_points`, `protocol_fee_basis_points`, `coin_creator_fee_basis_points` [EX-37]; curve `fee_basis_points`, `creator_fee_basis_points` [EX-37]), sum the bps and compare with every schedule in `candidates` (A-M01-02 `candidateTiers`). If the realised total differs from all of them by > 1 bp → count a mismatch and alert `reconciliation` (ARCH M01). Three mismatches for a venue within 24 h → `quotable = false`, `reason = fee_mismatch`.
  6. Raydium venues: `quotable = false`, `reason = venue_not_specified` until A-M01-06.
  7. Status recovers to `ok` automatically when the condition clears, except `fee_mismatch`, which needs an operator config change (`venue.fee_mismatch_ack` list, A3 because it increases risk) after review.
- **Shared resources and concurrency:** M01 owns the status map; single writer; consumers read snapshots. Publishing is idempotent per `(venue, reason, configHash)`.
- **Config:** `venue.fee_mismatch.tolerance_bps` (bps, 1, 0-10; increases risk on increase); `venue.fee_mismatch.max_per_24h` (count, 3, 1-10); `venue.fee_mismatch_ack` (list of `{venue, ackedAtMs}`; risk direction increases_risk).
- **Edge cases and failure handling:**
  1. Mayhem-mode trades with 0/0 fees [EX-05] → excluded from the mismatch count; the curve `TradeEvent` flag `mayhem_mode` [EX-37] identifies them on the curve, and PumpSwap fills of such coins should not occur because `mayhem_or_special` rejects them (a PumpSwap fill that matches no tier is still counted).
  2. Event without fee fields (decode gap) → not counted.
  3. Fee change mid-position → status change published; exits continue with the new schedule (ARCH 16.5).
- **Acceptance criteria:**
  - Given a fee-config fixture followed by a modified copy with one tier raised, when refreshed, then exactly one `venue.fee_schedule_changed` with `direction = raised` is published and `fee_config_known` is failing for 10 minutes.
  - Given three own-fill events within 24 h whose fee bps match no candidate tier, then the venue becomes unquotable and stays so until acknowledged.
  - Given `disable_flags = 0`, then `enabledBuy = enabledSell = true` even before the bit positions are verified.
- **Tests:** unit for each transition; integration with `fx/pumpswap/buy_events_tier_420.json` (2/93/30 then 20/5/95 [EX-07]); failure injection: decode error on a fee config → unquotable, `extraExitSlippageBps = 100`.
- **Observability:** metrics `venue_quotable` (venue, gauge 0/1), `fee_mismatch_total` (venue); log events `M01.venue_status_changed`, `M01.fee_mismatch`.
- **Security notes:** an admin can disable trading or change fees [EX-12, TH-V04]; this ticket makes those visible and fail-closed for entries; it never blocks exits (exits use the last valid schedule plus extra slippage).
- **Facts used:** EX-05, EX-07, EX-11, EX-12, EX-37, TH-19, TH-V04.
- **Definition of done:** status service live; all transitions tested; alert routing confirmed with M27 test doubles; the disable-flag bit VERIFY resolved or the `== 0` rule documented as active.

#### A-M01-06 — Raydium venue spec (gated, Phase 3b)

- **Module:** M01 (with M02, M16, M17, M29 consumers) · **Phase:** 3b, only when the D01 trigger fires (A-24 shows fewer than 10 eligible PumpSwap pools on more than half of the days) · **Size:** M (≈ 2 engineer-days)
- **Goal:** Produce the written, reviewed Raydium AMM v4 and CPMM venue spec that ARCH M01 (CB-07) requires before any Raydium pool is used in replay, paper or live, and implement its quote side.
- **Depends on:** A-M01-03, A-M02-02. B: M16 `TxBuilder.buildSimulationOnly` (for golden simulations), M17 and M29 (consumers).
- **Interfaces:** the spec document `docs/venues/raydium.md` plus, after acceptance, `VenueId` values `raydium_amm_v4` and `raydium_cpmm` become quotable through the unchanged `VenueModel`. Typed decoder variants replace the `fields: Record<string, unknown>` placeholder in A-M02-07.
- **Logic (contents the spec must contain; nothing below may be filled from memory):**
  1. Source files and commit: account layouts of AMM v4, CPMM pool state and CPMM `AmmConfig`, taken from Raydium's canonical SDK-bundled IDL or public program source [EX-36]. VERIFY against the raydium-io repositories and Raydium's program-address docs [DA-17]; record repository, path and commit hash.
  2. Reserve formula per venue: which vault balances and state fields make up tradable reserves (A-13 UNVERIFIED).
  3. Fee fields: CPMM `AmmConfig` trade fee and creator fee and the pool's creator-fee-enabled flag [EX-22]; AMM v4 0.25% [EX-22]. Universe filter remains total trade + creator fee ≤ 30 bps (ARCH 3.3).
  4. Fee extraction from a fill: pre/post vault deltas (M02 has no Raydium events).
  5. LP withdraw denominator for `lp_withdrawable_max` (ARCH 8.4, CA-20): pinned from program source and tested against a simulated withdraw. Burn & Earn escrow for CPMM counts as escrow [TH-20]; AMM v4 has no Burn & Earn [TH-20].
  6. Orientation: both token orderings mapped, golden-tested.
  7. Golden tests: ≥ 20 recorded pools per venue in both orderings, local quotes vs `simulateTransaction` output within 1 bp [TH-46].
  8. Acceptance: reviewed and signed off by the product owner; `venue_specified` (M06) becomes true for these venues in research/replay/paper; live additionally needs group B's direct sell adapters and gate P-6 on Raydium pools (D18).
- **Shared resources and concurrency:** none at runtime beyond A-M01-03.
- **Config:** `venue.raydium.enabled_stages` (list of `research|replay|paper|live`, default `[]`; adding any value is increases_risk; `live` additionally requires group B's adapter flag).
- **Edge cases and failure handling:** 1. Repository IDL lags the on-chain IDL (as for LaunchLab [EX-36]) → the spec uses the on-chain IDL where they differ and records the diff. 2. A venue whose fee configuration cannot be decoded with certainty stays research-only. 3. LaunchLab-graduated CPMM pools on `AmmConfig` index 3 (4%+ [EX-17, EX-V02]) are excluded by the fee ceiling.
- **Acceptance criteria:** Given the accepted spec, when the golden tests run, then local quotes match simulation within 1 bp for both orderings on both venues; given a pool not covered by the spec, then M06 rejects it with `venue_not_specified`.
- **Tests:** golden fixtures `fx/raydium/ammv4_pools_both_orders.json`, `fx/raydium/cpmm_pools_both_orders.json`, `fx/raydium/ammconfig_all.json`; simulated withdraw test for the LP denominator.
- **Observability:** as A-M01-03 with `venue` label values for Raydium.
- **Security notes:** no Raydium transaction is decodable by the signer until group B adds it; this ticket does not change signer policy.
- **Facts used:** EX-17, EX-22, EX-36, EX-V02, DA-17, TH-20, TH-46.
- **Definition of done:** spec merged and signed off; quote math for both venues merged behind `venue.raydium.enabled_stages`; golden tests green.

### M02 IDL decoders

M02 is imported by the engine, the signer (M17) and the sentinel (M29). The signer must have **zero third-party runtime dependencies** (ARCH 4.3, 12.3), so the M02 package (`@bot/decoders`) is written with Node built-ins only: its own base58 codec, little-endian readers and SHA-256 from `node:crypto`. It must not import `@solana/kit` (clarification C-02).

#### A-M02-01 — Pinned IDL loader, hash verification and zero-dependency codec core

- **Module:** M02 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Load the pinned pump and PumpSwap IDLs, verify their hashes at startup, and provide the codec primitives every decoder uses.
- **Depends on:** none. B: M26 (engine bootstrap acts on a refusal), M29 (`start_refused` protocol; the sentinel runs its own copy of this check).
- **Interfaces:**

```ts
interface PinnedIdl { program: Pubkey; file: string; commit: string; sha256: string;   // pinned in source
  accounts: Map<string /* discriminator hex */, IdlTypeDef>; events: Map<string, IdlTypeDef>; instructions: Map<string, IdlInstrDef> }
interface Decoders { idlVersion(program: Pubkey): { commit: string; sha256: string }; /* ... rest in A-M02-02/03/06 */ }
function verifyPinnedIdls(dir: string): Result<PinnedIdl[], { code: 'E_IDL_HASH' | 'E_IDL_MISSING' | 'E_IDL_PARSE'; file: string; expected?: string; actual?: string }>;
// codec core (exported for M17 and M29 too)
const base58: { encode(b: Uint8Array): string; decode(s: string): Uint8Array /* throws E_BASE58 */ };
class Reader { constructor(b: Uint8Array); u8(): number; u16(): number; u32(): number; u64(): bigint; i64(): bigint; u128(): bigint; i128(): bigint;
  bool(): boolean; pubkey(): Pubkey; bytes(n: number): Uint8Array; remaining(): number }   // throws { code: 'E_SHORT' } past the end
```

- **Logic:**
  1. Pinned inputs: `pump.json` and `pump_amm.json` from pump-public-docs at a pinned commit (the 2026-09-29 commit was current [EX-01, DA-11]; record the full commit SHA when vendoring, because the register could not confirm it [DA-11 note]). The pump fees IDL (`pump_fees.json`) is pinned too, because fee configs are owned by the fees program [EX-01, EX-12].
  2. Expected SHA-256 values live in a source constant reviewed with the vendored files. At startup `verifyPinnedIdls` hashes each file; any mismatch returns `E_IDL_HASH`. The engine bootstrap (M26, group B) then reports `start_refused` with reason `idl_hash` to the sentinel and exits (ARCH M02, 7.6); this ticket only returns the result and logs it.
  3. Discriminators are read from the IDL JSON (accounts, events, instructions). They are never recomputed from names: the register confirms the IDL `TradeEvent` discriminator `[189,219,127,211,78,230,97,238]` [DA-16]; the hashing convention behind it is not in the register.
  4. IDL type definitions (structs, options, vecs, enums, i128) are compiled once into reader plans. Unsupported IDL constructs → `E_IDL_PARSE` at startup (fail closed).
  5. Base58 implemented in-house (no dependency); `decode` rejects non-alphabet characters and lengths that do not yield 32 bytes for `pubkey()` callers.
- **Shared resources and concurrency:** M02 exclusively owns the decoder registry (ARCH M02); built once at startup, immutable afterwards.
- **Config:** `decoders.idl_dir` (string path, default `/opt/bot/idl`; root-owned, read-only); no runtime-tunable values.
- **Edge cases and failure handling:** 1. File missing → `E_IDL_MISSING` (start refused). 2. IDL contains an account or event twice with different discriminators → `E_IDL_PARSE`. 3. Hash verified but IDL lacks a type the decoders need (for example `CompletePumpAmmMigrationEvent`) → `E_IDL_PARSE`.
- **Acceptance criteria:**
  - Given the vendored IDLs, when `verifyPinnedIdls` runs, then it returns three `PinnedIdl` entries and the pump `TradeEvent` discriminator equals `[189,219,127,211,78,230,97,238]` [DA-16].
  - Given one byte of `pump_amm.json` changed, then `E_IDL_HASH` with expected and actual hashes.
  - Given the package, when its `package.json` dependencies are inspected in CI, then there are none outside Node built-ins.
- **Tests:** unit (base58 round-trip property test over random 32-byte arrays; Reader bounds); integration with the vendored IDLs; failure injection: tampered file.
- **Observability:** log events `M02.idl_verified` (program, commit, sha256), `M02.idl_hash_mismatch` (critical).
- **Security notes:** the IDLs define what the signer considers decodable; tampering is detected by hash. Base58 decoding of untrusted strings is bounds-checked.
- **Facts used:** EX-01, EX-11, EX-12, DA-11, DA-16, VF-02.
- **Definition of done:** package builds with zero dependencies; startup check wired into a test harness that simulates the M26 refusal path.

#### A-M02-02 — Account decoders

- **Module:** M02 · **Phase:** 0 · **Size:** M (≈ 2 engineer-days)
- **Goal:** Decode every account group A and the signer need: pump bonding curve, PumpSwap pool, fee configs, PumpSwap global config, pump global, SPL/Token-2022 mints and token accounts.
- **Depends on:** A-M02-01. B: none.
- **Interfaces (ARCH `DecodedAccount`, extended with three NEW variants logged in C-03):**

```ts
type DecodedAccount =
  | { kind: 'pump_bonding_curve'; virtualQuote: Lamports; virtualToken: BaseUnits; realQuote: Lamports; realToken: BaseUnits;
      complete: boolean; quoteMint: Pubkey; creator: Pubkey }
  | { kind: 'pumpswap_pool'; baseMint: Pubkey; quoteMint: Pubkey; creator: Pubkey; virtualQuoteReserves: bigint /* i128 */;
      baseVault: Pubkey; quoteVault: Pubkey; lpMint: Pubkey; lpSupply: bigint }
  | { kind: 'pump_fee_config'; tiers: Array<{ thresholdLamports: Lamports; lpBps: Bps; protocolBps: Bps; creatorBps: Bps }>;
      flat: { lpBps: Bps; protocolBps: Bps; creatorBps: Bps } }
  | { kind: 'spl_token_account'; mint: Pubkey; owner: Pubkey; amount: BaseUnits; delegate: Pubkey | null; state: 'initialized' | 'frozen' }
  | { kind: 'pumpswap_global_config'; disableFlags: number; raw: Record<string, unknown> }      // NEW
  | { kind: 'pump_global'; raw: Record<string, unknown> }                                       // NEW (research: curve params [EX-02])
  | { kind: 'spl_mint'; tokenProgram: 'spl_token' | 'token_2022'; mintAuthority: Pubkey | null; supply: BaseUnits;
      decimals: number; isInitialized: boolean; freezeAuthority: Pubkey | null; extensionBytes: number }   // NEW
  | { kind: 'raydium_cpmm_pool' | 'raydium_amm_v4_pool' | 'raydium_amm_config'; fields: Record<string, unknown> }   // placeholder until A-M02-07
  | { kind: 'unknown'; owner: Pubkey; discriminatorHex: string };
interface Decoders { decodeAccount(owner: Pubkey, data: Uint8Array): DecodedAccount; /* + flags below via a side channel */ }
type DecodeFlags = { layoutExtended: boolean; shortLegacy: boolean };   // returned by decodeAccountWithFlags (NEW), logged by callers
```

- **Logic:**
  1. Dispatch on `owner`: pump program, PumpSwap program, pump fees program → Anchor-style 8-byte discriminator lookup from the pinned IDL; SPL Token / Token-2022 → length-based (mint base 82 bytes [TH-01]; token account base 165 bytes [LD-14]); anything else → `unknown`.
  2. `pump_bonding_curve`: fields per the pinned IDL (the IDL names them `virtual_quote_reserves` / `real_quote_reserves` after the rename from `*_sol_*` [DA-13]). **Short legacy accounts:** missing trailing fields decode as 0 / false / `Pubkey::default()` [DA-15, DA-V01]; `shortLegacy = true`. `quote_mint == Pubkey::default()` (all zeros) means SOL [DA-V01]; M02 returns the raw value and M01 interprets it.
  3. `pumpswap_pool`: `virtual_quote_reserves` is i128 and may be negative [EX-09, DA-14]. `lp_supply` is returned as stored; callers must not use it for ownership shares [TH-18]. Also decoded (settled 2026-10-07 [VF-03]): `coin_creator`, `is_mayhem_mode`, `creator_fee_bps` (u64), `can_edit_creator_fee`; and from `pumpswap_global_config`: `creator_fee_configurable` and `max_configurable_creator_fee_bps` (A-M01-02 step 3 needs them). **Short pools:** pool accounts shorter than 300 bytes exist (legacy pools not yet extended); they decode, and every missing tail field reads as zero [VF-03].
  4. `pump_fee_config`: market-cap tiers and flat fees [EX-07, EX-08]; stable tiers [EX-07] decoded into `raw` only (USDC pools are excluded).
  5. SPL mint: field order per [TH-01] (`mint_authority: COption<Pubkey>`, `supply: u64`, `decimals: u8`, `is_initialized: bool`, `freeze_authority: COption<Pubkey>`); the `COption` encoding (tag width) VERIFY against `solana-program/token` `interface/src/state.rs` before implementing. Token-2022 mints: same 82-byte base; `extensionBytes = data.length − 82` (extension parsing is done from `jsonParsed` in M06, not here).
  6. SPL token account: `mint`, `owner`, `amount`, `delegate` (COption) and `state` [TH-03]; byte offsets VERIFY against the same `state.rs`. Token-2022 accounts may be longer (extensions [LD-14, LD-V03]); only the base is decoded.
  7. Longer-than-expected Anchor accounts: decode the known prefix, set `layoutExtended = true`; callers alert (ARCH M02 failure table). Shorter than the minimum for non-legacy types → `unknown` with the discriminator, except PumpSwap pools, which are legacy-tolerant as step 3 says.
- **Shared resources and concurrency:** pure; registry read-only.
- **Config:** none.
- **Edge cases and failure handling:** 1. Discriminator not in the IDL on an allowlisted program → `unknown` (A-M02-05 quarantines). 2. Data length below 8 → `unknown` with empty discriminator. 3. i128 virtual reserves with the high bit set → negative bigint. 4. Token account `state` byte value not in {initialized, frozen} (for example uninitialized) → `unknown`.
- **Acceptance criteria:**
  - Given a PumpSwap pool account of 243 bytes (legacy, not extended), then it decodes with `virtual_quote_reserves`, `creator_fee_bps` and the later flags read as zero (`shortLegacy = true`) [VF-03].
  - Given fixtures of pools `9jkXWMyt...` and `CHtrRatG...`, when decoded, then `virtualQuoteReserves` equal 17,584,326,063 and 17,584,505,288 lamports respectively [EX-09].
  - Given the FeeConfig fixtures, then 25 PumpSwap tiers and one curve tier decode as in A-M01-02.
  - Given a short legacy `BondingCurve` fixture, then missing fields are 0/false/default and `shortLegacy = true` [DA-15].
  - Given a fresh pump mint fixture (Token-2022, decimals 6, supply 1,000,000,000,000,000, null authorities [TH-V01]), then `spl_mint` decodes with those values.
- **Tests:** unit per variant; property test: decoding never throws on random bytes (returns `unknown`); integration fixtures `fx/pumpswap/pool_canonical_9jkXWMyt.json`, `fx/pumpswap/pool_canonical_CHtrRatG.json`, `fx/pump/bonding_curve_short_legacy.json`, `fx/pump/bonding_curve_current.json`, `fx/token2022/pump_mint_fresh.json`, `fx/spl/token_account_frozen.json`.
- **Observability:** metric `decode_accounts_total` (kind, result); log `M02.layout_extended` (program, discriminator, length).
- **Security notes:** all reads are bounds-checked; no `eval`/dynamic code from IDL contents; account owner is always checked before dispatch so a forged account under another program cannot be decoded as a pool.
- **Facts used:** EX-07, EX-08, EX-09, DA-13, DA-14, DA-15, DA-V01, TH-01, TH-03, TH-18, TH-V01, LD-14, LD-V03, VF-03, VF-07.
- **Definition of done:** all variants decode their fixtures; fuzz test green; VERIFY items for SPL layouts resolved with the source commit cited.

#### A-M02-03 — Transaction reader and self-CPI event decoder (v0 and v1)

- **Module:** M02 · **Phase:** 0 · **Size:** M (≈ 2 engineer-days)
- **Goal:** Extract pump and PumpSwap events from fetched transactions, including version-1 transactions, primarily from self-CPI inner instructions.
- **Depends on:** A-M02-01. B: none (M17, M18, M22, M23, M29 consume `decodeTransactionEvents`).
- **Interfaces (ARCH `DecodedEvent` and `Decoders`, unchanged):**

```ts
type DecodedEvent =
  | { kind: 'pump_trade'; mint: Pubkey; isBuy: boolean; solAmount: Lamports; tokenAmount: BaseUnits; feeBps: Bps; fee: Lamports;
      creatorFeeBps: Bps; creatorFee: Lamports; quoteMint: Pubkey | null; slot: Slot; signature: Signature }
  | { kind: 'pump_complete'; mint: Pubkey; slot: Slot; signature: Signature }
  | { kind: 'pump_migration'; mint: Pubkey; pool: Pubkey; baseAmount: BaseUnits; solAmount: Lamports; poolMigrationFee: Lamports; slot: Slot; signature: Signature }
  | { kind: 'pumpswap_buy' | 'pumpswap_sell'; pool: Pubkey; baseAmount: BaseUnits; quoteAmount: Lamports; lpFeeBps: Bps;
      protocolFeeBps: Bps; coinCreatorFeeBps: Bps; virtualQuoteReserves: bigint; slot: Slot; signature: Signature }
  | { kind: 'pumpswap_init_boost'; pool: Pubkey; virtualQuoteReserves: bigint; slot: Slot; signature: Signature }
  | { kind: 'unknown_event'; programId: Pubkey; discriminatorHex: string; signature: Signature };
interface Decoders { decodeTransactionEvents(tx: RawTransaction): DecodedEvent[] }
```

- **Logic:**
  1. Resolve the full account list: `message.accountKeys` followed by `loadedAddresses.writable` then `loadedAddresses.readonly` (v0 lookup tables); v1 transactions have no lookup tables and up to 64 inline addresses [LD-04]. Every fetch that produced `tx` must have used `maxSupportedTransactionVersion: 1` [LD-05, EX-V04] (enforced in M14; asserted here by `tx.version` being one of `'legacy' | 0 | 1`).
  2. If `meta.err != null` → return `[]` (events of failed transactions are never used; failure classification is M18's job).
  3. For each inner instruction whose program is `pumpCurve` or `pumpSwap` and whose data starts with the 8-byte Anchor event-CPI prefix `0xe445a52e51cb9a1d` [DA-16]: read the next 8 bytes as the event discriminator, look it up in that program's IDL events, decode the payload. Accept it only if the parent top-level instruction (index in `innerInstructions[].index`) invoked the **same** program (self-CPI). The self-CPI emission of pump events is an inference from Dune's model [DA-16]; the guarded log fallback (A-M02-04) covers the case where it is wrong.
  4. Map IDL events: `TradeEvent` → `pump_trade` (fields `sol_amount`, `token_amount`, `is_buy`, `fee_basis_points`, `fee`, `creator_fee_basis_points`, `creator_fee`, `quote_mint` [EX-37, DA-13]); `CompleteEvent` → `pump_complete`; `CompletePumpAmmMigrationEvent` → `pump_migration` [EX-03, DA-11]; PumpSwap `BuyEvent`/`SellEvent` → `pumpswap_buy`/`pumpswap_sell` with lp/protocol/coin-creator fee bps and `virtual_quote_reserves` [EX-37]; `InitBoostEvent` → `pumpswap_init_boost` [EX-V01]. Exact IDL field names: VERIFY against the pinned IDLs (the register lists the fields, not every spelling).
  5. A discriminator after the prefix that is not in the IDL → `unknown_event` (A-M02-05 quarantines).
  6. `slot` and `signature` come from the `RawTransaction`.
- **Shared resources and concurrency:** pure.
- **Config:** none.
- **Edge cases and failure handling:** 1. A transaction with both a curve completion and a migration in one slot or one transaction [EX-V06] → both events returned in instruction order. 2. Migration lagging completion by 10 slots [EX-04] → events in separate transactions; no special handling here. 3. Mayhem trades with zero fee fields [EX-05] → decoded as-is. 4. Inner instruction from the pump program without the prefix (a normal CPI) → ignored. 5. `innerInstructions` missing (provider returned none) → no events from this path; A-M02-04 may run.
- **Acceptance criteria:**
  - Given ≥ 10 recorded curve TradeEvents [EX-37], when decoded, then fees match the event fields and `fee_basis_points = 95`, `creator_fee_basis_points = 30` on non-mayhem trades [EX-05].
  - Given the recorded migration transactions (normal, 10-slot lag [EX-04], and the create-buy-complete single transaction [EX-V06]), then `pump_complete` and `pump_migration` are returned with 206,900,000,000,000 base units and about 84.99 SOL [EX-03].
  - Given a v1 transaction fixture [EX-V04], then decoding succeeds (and a reader configured for version 0 fails in CI, ARCH M02).
  - Given an inner instruction with the prefix under a different program than its parent, then it is ignored.
- **Tests:** integration fixtures `fx/pump/trade_events_curve.json`, `fx/pump/trade_mayhem_zero_fee.json`, `fx/pump/complete_and_migration_same_slot.json`, `fx/pump/migration_lagged_10_slots.json`, `fx/pump/create_buy_complete_single_tx.json`, `fx/pumpswap/buy_sell_events_tier_420.json`, `fx/pumpswap/init_boost_event.json`, `fx/tx/v1_transaction.json`; property test: never throws on random inner-instruction data.
- **Observability:** metrics `decode_events_total` (kind), `decode_gap_total` (reason: `no_inner`, `truncated`, `unknown_disc`); log `M02.unknown_event` (program, discriminator, signature; once per discriminator per hour).
- **Security notes:** events are trusted only from successful transactions and only from self-CPI of the program, so a third program cannot inject fake fills into our ledger.
- **Facts used:** EX-03, EX-04, EX-05, EX-37, EX-V01, EX-V04, EX-V06, DA-11, DA-13, DA-16, LD-04, LD-05, VF-06.
- **Definition of done:** decoder merged; all fixtures green; consumers' contract tests (M18/M23 test doubles) use these fixtures.

#### A-M02-04 — Guarded `Program data:` log fallback

- **Module:** M02 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Decode events from `Program data:` log lines only when no self-CPI event exists for a known swap instruction and the logs are complete; never guess.
- **Depends on:** A-M02-03. B: none.
- **Interfaces:** internal to `decodeTransactionEvents`; returns the same `DecodedEvent` union with an internal provenance tag `source: 'self_cpi' | 'log'` carried in a parallel array (`decodeTransactionEventsWithProvenance`, NEW, used by tests and metrics).
- **Logic:**
  1. Trigger: the transaction contains a top-level or inner instruction of a known swap type (A-M02-06 instruction decoders) for pump or PumpSwap, and step 3 of A-M02-03 found no event for it.
  2. If any log line equals the truncation marker `Log truncated` → no event; increment `decode_gap_total{reason="truncated"}` [DA-05] (logs are capped at 10,000 bytes).
  3. Parse logs as a stack using `Program <id> invoke [n]` / `Program <id> success|failed` lines; attribute each `Program data: <base64>` line to the program on top of the stack. Only lines attributed to `pumpCurve` / `pumpSwap` are considered.
  4. Base64-decode; the first 8 bytes must be an event discriminator from that program's IDL; decode the payload with the same plan as A-M02-03. Unknown discriminator → `unknown_event`.
  5. Whether pump emits events this way is UNVERIFIED (excluded claim); the fallback exists only so that a wrong inference about self-CPI does not silently lose fills.
- **Shared resources and concurrency:** pure.
- **Config:** `decoders.log_fallback_enabled` (bool, default true; affectsReturns false).
- **Edge cases and failure handling:** 1. Logs `null` → no event, gap `no_logs`. 2. Malformed base64 → skip line, gap `bad_log`. 3. Both self-CPI and log events present → only self-CPI used (no duplicates).
- **Acceptance criteria:** Given a fixture whose inner instructions were stripped but whose logs contain the event, then exactly one event is produced with `source = 'log'`; given the same with `Log truncated` present, then none and a `truncated` gap.
- **Tests:** unit for the log stack parser (nested invokes); fixtures `fx/tx/swap_logs_only.json` (synthetic from a real transaction with inner instructions removed), `fx/tx/swap_logs_truncated.json`.
- **Observability:** `decode_events_total{source}`; `decode_gap_total{reason}`.
- **Security notes:** log text is attacker-influenced only by the executing programs; attribution by invocation stack prevents another program's `Program data:` from being read as a pump event.
- **Facts used:** DA-05, DA-16.
- **Definition of done:** fallback merged behind the flag; tests green; provenance visible in metrics.

#### A-M02-05 — Quarantine of unknown discriminators and layouts

- **Module:** M02 · **Phase:** 0 · **Size:** S (≈ 0.5 engineer-day)
- **Goal:** Record unknown account or event layouts from allowlisted programs, alert once, and block entries on affected pools until a human reviews (ARCH M02 failure table).
- **Depends on:** A-M02-02, A-M02-03. B: M24 `quarantine` table repository; M27 alerts.
- **Interfaces:**

```ts
interface Quarantine {                                                              // NEW (M02 owns the quarantine writer)
  record(e: { programId: Pubkey; discriminatorHex: string; rawB64: string; signature: Signature | null; poolId: Pubkey | null }): void;
  isReviewed(programId: Pubkey, discriminatorHex: string): boolean;               // from config list
}
// publishes 'decoder.unknown_layout' { programId, discriminatorHex, poolId | null, firstSeenAtMs }
```

- **Logic:** 1. On `unknown`/`unknown_event` from an allowlisted program, write one `quarantine` row per `(programId, discriminatorHex)` (first raw sample kept, count incremented in memory and flushed every minute). 2. Raise alert `config` warning once per discriminator. 3. Publish `decoder.unknown_layout` with the pool if known; M05 blocks entries on that pool (`blacklisted` with reason `unknown_layout`) and M20 flags positions (ARCH M02). 4. Unblocking requires the discriminator to be added to `decoders.reviewed_discriminators` via an `apply_config` command (risk direction `increases_risk`, so A3 per M25/M26).
- **Shared resources and concurrency:** `quarantine` table (append-only, M24); M02 is the only writer. Idempotent on `(program_id, discriminator)`.
- **Config:** `decoders.reviewed_discriminators` (list of `{programId, discriminatorHex, note}`, default empty; increases_risk).
- **Edge cases and failure handling:** 1. Burst of unknown events (program upgrade, interface churn [EX-11]) → one alert per discriminator, counts aggregated. 2. Database write failure → in-memory record and retry; never blocks decoding.
- **Acceptance criteria:** Given 100 transactions with the same unknown discriminator, then one `quarantine` row, one alert, one `decoder.unknown_layout` event per affected pool.
- **Tests:** unit; integration with M24 test double; fixture `fx/pumpswap/unknown_event_synthetic.json`.
- **Observability:** `quarantine_records_total` (program); log `M02.quarantined`.
- **Security notes:** raw bytes stored base64 and never rendered unescaped; size-capped at 10 KB per sample.
- **Facts used:** EX-11.
- **Definition of done:** writer merged; event consumed by M05 (A-M05-01) in an integration test.

#### A-M02-06 — Instruction decoders for signer classification

- **Module:** M02 · **Phase:** 2 (needed by M17 in Phase 3; by M16 golden tests in Phase 2) · **Size:** S (≈ 1 engineer-day)
- **Goal:** Decode PumpSwap and pump-curve swap instructions (arguments and named accounts) from the pinned IDLs, so the signer can classify transactions from decoded arguments rather than the engine's hint (ARCH M17, CA-05).
- **Depends on:** A-M02-01. B: M17 (consumer), M16 (encoder golden tests use these decoders as a cross-check).
- **Interfaces:**

```ts
type DecodedInstruction =                                                          // NEW (logged C-03)
  | { kind: 'pumpswap_buy'; args: { baseAmountOut: BaseUnits; maxQuoteAmountIn: Lamports; trackVolume: unknown }; accounts: Record<string, Pubkey> }
  | { kind: 'pumpswap_buy_exact_quote_in'; args: Record<string, bigint | boolean | unknown>; accounts: Record<string, Pubkey> }
  | { kind: 'pumpswap_sell'; args: { baseAmountIn: BaseUnits; minQuoteAmountOut: Lamports }; accounts: Record<string, Pubkey> }
  | { kind: 'pump_buy_v2' | 'pump_sell_v2' | 'pump_buy_exact_quote_in_v2'; args: Record<string, bigint | boolean | unknown>; accounts: Record<string, Pubkey> }
  | { kind: 'other_known'; program: Pubkey; name: string; args: Record<string, unknown>; accounts: Record<string, Pubkey> }
  | { kind: 'unknown_instruction'; program: Pubkey; discriminatorHex: string };
interface Decoders { decodeInstruction(programId: Pubkey, data: Uint8Array, accounts: Pubkey[]): DecodedInstruction }
```

- **Logic:** 1. Match the 8-byte instruction discriminator from the IDL. 2. Map accounts by IDL order to names; account counts must equal the IDL's (PumpSwap `buy` and `buy_exact_quote_in` 23, `sell` 21; curve `buy_v2` 27, `sell_v2` 26, `buy_exact_quote_in_v2` 27 [EX-10]); PumpSwap buy may carry an optional remaining account for cashback coins [EX-10] — extra trailing accounts beyond the IDL count are returned under `accounts.remaining_<n>` and flagged; the signer decides policy. 3. Argument names: the register gives `base_amount_out, max_quote_amount_in` (PumpSwap buy), `spendable_quote_in, min_tokens_out` (curve buy_exact_quote_in_v2), `amount, min_sol_output` (legacy sell) [EX-10]; all others VERIFY against the pinned IDLs and use the IDL's spelling. 4. Discriminator not found → `unknown_instruction`.
- **Shared resources and concurrency:** pure.
- **Config:** none.
- **Edge cases and failure handling:** account count below the IDL's → `unknown_instruction` (malformed); `track_volume` type per IDL (OptionBool or bool; decoded as given).
- **Acceptance criteria:** Given instruction bytes produced by `@pump-fun/pump-swap-sdk` and `@pump-fun/pump-sdk` in tests [EX-10], when decoded, then args and account names round-trip exactly.
- **Tests:** golden against SDK output (SDK in devDependencies only); fuzz: random data never throws.
- **Observability:** `decode_instructions_total` (kind).
- **Security notes:** this decoder is a security boundary for the signer; 100% branch coverage required; any change needs review by the M17 owner.
- **Facts used:** EX-10.
- **Definition of done:** merged with golden tests; M17's owner signs off the interface.

#### A-M02-07 — Raydium typed decoders (gated, Phase 3b)

- **Module:** M02 · **Phase:** 3b · **Size:** S (≈ 1 engineer-day)
- **Goal:** Replace the Raydium `fields: Record<string, unknown>` placeholder with typed variants defined by the accepted Raydium venue spec.
- **Depends on:** A-M01-06. B: M17, M29 (consumers once Raydium adapters exist).
- **Interfaces:** new `DecodedAccount` variants `raydium_amm_v4_pool`, `raydium_cpmm_pool`, `raydium_amm_config` with typed fields exactly as named in the venue spec (no field invented here).
- **Logic:** 1. Layouts from the source files and commit named in the spec [EX-36]. 2. Diff of repository IDL versus on-chain IDL recorded; on-chain wins where they differ [EX-36]. 3. Both token orderings tested.
- **Shared resources and concurrency:** pure.
- **Config:** none.
- **Edge cases and failure handling:** layout mismatch on a live account → `unknown` + quarantine (A-M02-05).
- **Acceptance criteria:** Given the spec's golden fixtures, when decoded, then every field equals the spec's expected values.
- **Tests:** fixtures from A-M01-06.
- **Observability:** as A-M02-02.
- **Security notes:** as A-M02-06 if the signer uses these decoders.
- **Facts used:** EX-36.
- **Definition of done:** variants merged; placeholder removed; spec owner sign-off.

### M03 Discovery ingest and enumeration

#### A-M03-01 — PumpPortal stream client (new tokens and migrations)

- **Module:** M03 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** One resilient WebSocket to PumpPortal's free data stream for new-token and migration notices, deduplicated, with lag and gap metrics, never opening a socket per token.
- **Depends on:** A-M14-01 (endpoint validation and secret store). B: M27 metrics and alerts.
- **Interfaces (ARCH M03):**

```ts
interface PoolDiscovered { discoveryId: Id; venue: VenueId; poolId: Pubkey; baseMint: Pubkey; quoteMint: Pubkey;
  source: 'pumpportal' | 'dexscreener' | 'chain_backfill' | 'chain_enumeration'; sourceCommitment: Commitment | 'unknown';
  seenAtMs: UnixMs; slot: Slot | null; verifiedOnChain: boolean }
interface MigrationObserved { mint: Pubkey; pool: Pubkey; slot: Slot; signature: Signature; source: string; verifiedOnChain: boolean }
interface DiscoveryIngest { start(): void; stop(): void; health(): SourceHealth[]; /* enumerateEstablishedPools in A-M03-03 */ }
interface PumpPortalNotice {                                                     // NEW (internal)
  kind: 'new_token' | 'migration'; mint: Pubkey; pool: Pubkey | null; signature: Signature | null; slot: Slot | null;
  receivedAtMs: UnixMs; rawB64: string /* size-capped, for M07 */ }
// publishes 'discovery.pumpportal_notice' (PumpPortalNotice; processed commitment, unverified)
```

- **Logic:**
  1. Endpoint: `wss://pumpportal.fun/api/data` with an `api-key` query parameter [DA-01], validated as `wss:` by M14 (CA-30). Whether the two free subscriptions need a key is not stated in the register: VERIFY against https://pumpportal.fun/data-api/real-time before implementing; if a key is needed, it comes from M14's secret store and the URL is never logged.
  2. After connect, send `subscribeNewToken` and `subscribeMigration` (free [DA-01]). The JSON message shape of each subscription and of each notice: VERIFY against the same page. Paid methods (`subscribeTokenTrade`, `subscribeAccountTrade`, 0.01 SOL per 10,000 messages [DA-01]) are never sent; a config validation error rejects any attempt to enable them.
  3. Exactly one socket; never one per token [DA-02]. Outgoing subscription messages are rate-limited to ≤ `pumpportal.max_sub_msgs_per_s` (default 10, hard cap 200 [DA-02]).
  4. Notices are at `processed` commitment [DA-03] and are **early warnings only** (D14): they are written to M07 and published as `discovery.pumpportal_notice`; they influence no decision until verified on chain by A-M03-02.
  5. Dedupe key `(signature, mint)` for notices, 24 h TTL (ARCH M03 owned state). New-token notices are recorded but not verified on chain (no v1 consumer; ≈ 42,000 launches in one day were reported [ST-05], so verifying each would waste the read budget). They are labelled `verifiedOnChain = false` permanently and may be used only by research measurements (SN-R).
  6. Reconnect: exponential backoff 1 s → 60 s with full jitter (seeded `Rng`); after reconnect, call A-M03-02 `backfillSince(lastSeenSlot)` (ARCH M03 failure table). Disconnects during server rebalancing are expected [DA-03].
  7. Ban handling: on a server message or close code that indicates a ban (exact signal VERIFY on the PumpPortal FAQ [DA-02]; until known, treat ≥ 3 forced closes within 60 s as a suspected ban), stop connecting for 1 h (bans expire hourly [DA-02]), rely on backfill polling every 60 s (A-M03-02), alert warning.
  8. Health (`SourceHealth`): `lagMs` = (receipt time − time of the notice's slot estimated as `(highestSeenSlot − slot) × slotDurationMsEstimate`), or `null` when the notice carries no slot; `reconnects1h`; status `down` when no message for `pumpportal.silence_alert_ms` (default 300 s) while migrations are visible in backfill.
- **Shared resources and concurrency:** M03 owns source connection state and the dedupe set (ARCH 7.2). Single socket handler on the event loop; notices processed in arrival order. Idempotency by dedupe key.
- **Config:**

| Key | Type / unit | Default | Range / validation |
|---|---|---|---|
| `discovery.pumpportal.enabled` | bool | true | — |
| `discovery.pumpportal.max_sub_msgs_per_s` | count per s | 10 | 1-200 [DA-02] |
| `discovery.pumpportal.backoff_max_ms` | duration_ms | 60,000 | 5,000-300,000 |
| `discovery.pumpportal.silence_alert_ms` | duration_ms | 300,000 | 60,000-3,600,000 |
| `discovery.pumpportal.paid_methods` | list | [] | must be empty (validation error otherwise; cost control) |

- **Edge cases and failure handling:**
  1. Malformed JSON or oversize message (> 64 KB) → dropped, counted, connection kept.
  2. Notice with a mint that is not valid base58 of 32 bytes → dropped (`invalid_notice`).
  3. Disconnect storm → backoff, backfill, no duplicate discoveries (dedupe) (ARCH 16.5).
  4. PumpPortal disabling access (its terms reserve the right [DA-03]) → `down`; D12 switch trigger evaluated by the operator (A-M03-02 gap metric).
- **Acceptance criteria:**
  - Given a mock server that closes the socket 10 times in 60 s, then the client never holds more than one socket, backoff grows to 60 s, and every reconnect triggers exactly one backfill call.
  - Given the same migration notice twice, then one `discovery.pumpportal_notice`.
  - Given config with a paid method listed, then validation fails.
- **Tests:** unit (backoff schedule with seeded RNG, dedupe TTL); integration with a local mock WebSocket server replaying recorded notices `fx/pumpportal/notices_sample.ndjson` (captured shape after the VERIFY step); failure injection: ban signal → 1 h pause.
- **Observability:** metrics `stream_lag_ms{source="pumpportal"}`, `stream_reconnects_total{source}`, `pumpportal_notices_total{kind}`, `pumpportal_dropped_total{reason}`; log events `M03.pp_connected`, `M03.pp_disconnected` (code), `M03.pp_ban_suspected`.
- **Security notes:** notice content is untrusted; it is validated and size-capped and never reaches a decision before on-chain verification. The API key (if any) never appears in logs or VMs (ARCH 12.4).
- **Facts used:** DA-01, DA-02, DA-03, ST-05.
- **Definition of done:** client running in the Phase 0 recorder; VERIFY items for message shapes resolved and the fixture captured; metrics visible in VM-13 `streams[]` via M28.

#### A-M03-02 — Migration backfill and on-chain verification

- **Module:** M03 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Find every pump-to-PumpSwap migration from the chain, verify each pool before use, and measure PumpPortal's coverage against it.
- **Depends on:** A-M03-01, A-M02-03 (migration event decoding), A-M01-04 (normalisation, canonical check), A-M14-02. B: none.
- **Interfaces:**

```ts
interface MigrationBackfill {                                                         // NEW (internal to M03)
  backfillSince(fromSlot: Slot | null): Promise<Result<{ found: number; newestSlot: Slot }, { code: 'E_RPC' }>>;
  verifyPool(pool: Pubkey, mint: Pubkey): Promise<Result<CpPoolState, { code: 'E_NOT_FOUND' | 'E_NOT_CANONICAL' | 'E_NOT_SOL_QUOTED' | 'E_RPC' }>>;
  coverage(windowMs: number): { chainMigrations: number; seenByPumpPortal: number; gapBps: number };
}
// publishes 'discovery.migration' (MigrationObserved, verifiedOnChain = true) and 'discovery.pool' (PoolDiscovered)
```

- **Logic:**
  1. Every `discovery.backfill.interval_ms` (default 60 s) and on every PumpPortal reconnect: `getSignaturesForAddress` on `ACCOUNTS.migrationWithdrawAuthority` [EX-03] at `confirmed`, newest first, `until` = the newest signature already processed, `limit` 1,000 (range 1-1,000 [DA-08]); page with `before` until reaching `until`. P4 priority on the unmetered provider (A-M14-02).
  2. Skip signatures whose `err` is non-null (failed transactions touching the withdraw authority are common: 71 of 150 in one sample [EX-04]).
  3. Fetch each remaining transaction with `getTransaction` (`maxSupportedTransactionVersion: 1` [LD-05]) and decode with A-M02-03. Each `pump_migration` event is recorded (M07 stream `discovery`) as a `MigrationObserved` with `verifiedOnChain = false`; it is published on `discovery.migration` only after step 4 succeeds.
  4. Verify: read the pool account and its two vaults (`getMultipleAccounts`, confirmed), normalise (A-M01-04), require `isCanonical === true` (pool created by `migrate` [EX-04, EX-08]) and `quoteMint = wSOL`. On success publish `discovery.migration` and `discovery.pool` (`source: 'chain_backfill'`, `verifiedOnChain: true`). On `E_NOT_SOL_QUOTED` (for example a migration whose `sol_amount` was 91,220,809, possibly a non-SOL quote [EX-03]) drop with reason. A PumpPortal migration notice for the same `(mint, pool)` triggers the same verification immediately instead of waiting for the timer.
  5. Migration timing: migration usually lands in the completing buy's slot but can lag by about 10 slots [EX-04]; a curve can complete in its creation transaction [EX-V06]. No timing assumption is made; the event is the source.
  6. Coverage (D12 switch trigger): over a rolling 7 days, `gapBps = 10_000 × (chainMigrations − seenByPumpPortal) / chainMigrations`; > 100 bps (1%) raises a warning that the D12 switch condition is met.
- **Shared resources and concurrency:** cursor (`newest processed signature`) persisted via M24 (single row); one backfill run at a time (a run in progress makes a second trigger a no-op). Idempotency: `(signature, mint)` dedupe shared with A-M03-01.
- **Config:** `discovery.backfill.interval_ms` (duration_ms, 60,000, 15,000-600,000); `discovery.backfill.max_pages_per_run` (count, 20, 1-100; prevents a runaway after long downtime, remaining pages next run).
- **Edge cases and failure handling:**
  1. Engine down for days → run pages up to the cap each minute until caught up; manifests record reduced coverage for those days.
  2. Transaction fetch returns `-32015` (version not supported) → configuration bug; alert critical (M14 must always send version 1 [EX-V04]).
  3. Pool account not yet visible at `confirmed` when the notice arrives → retry 3 times at 2 s intervals, then defer to the next backfill.
  4. Migration of a mayhem or special coin → published; M06's `mayhem_or_special` rejects it later.
- **Acceptance criteria:**
  - Given recorded withdraw-authority signatures with 71 failed out of 150, when backfill runs, then only successful ones are fetched and every migration fixture is published once with `verifiedOnChain = true`.
  - Given a PumpPortal outage of 1 h, when it ends, then backfill finds every migration in that hour and the 7-day `gapBps` reflects the outage.
- **Tests:** integration fixtures `fx/pump/withdraw_authority_signatures_150.json`, `fx/pump/migration_txs_sample.json`, `fx/pumpswap/migrated_pool_and_vaults.json`; failure injection: provider 429 mid-page → run resumes next interval without duplicates.
- **Observability:** metrics `migrations_seen_total{source}`, `migration_backfill_lag_slots`, `pumpportal_migration_gap_bps`; log events `M03.migration_verified`, `M03.migration_rejected` (reason).
- **Security notes:** only on-chain-verified canonical pools enter the universe; a spoofed notice cannot create a candidate.
- **Facts used:** EX-03, EX-04, EX-08, EX-V04, EX-V06, DA-08, LD-05.
- **Definition of done:** backfill and verification in the Phase 0 recorder; coverage metric in the daily manifest.

#### A-M03-03 — Established-pool enumeration (D30) (PARKED)

**Parked (supervisor ruling, card Z-H-OF round 2, 2026-10-08, after MR-01 was parked, C-76).** D30 exists for MR's universe. This ticket is not built, no Helius job runs for it, and the owner's D30 question (C-75 (a)–(c)) is withdrawn. It stays on file for a revised MR version entering through the M09 slot, and is unparked only with that version's ticket.

- **Module:** M03 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** List the established PumpSwap pools MR-01 could trade (fee ≤ 30 bps per side, depth ≥ 300 SOL), daily, with a recorded coverage level; this produces the A-24 count, the first Phase 0 deliverable.
- **Depends on:** A-M01-01 (canonical PDA), A-M02-02 (pool and token-account decoders), A-M14-02. B: none.
- **Interfaces (ARCH M03):**

```ts
interface DiscoveryIngest {
  enumerateEstablishedPools(venue: 'pumpswap' | 'raydium_amm_v4' | 'raydium_cpmm'):
    Promise<Result<{ pools: PoolDiscovered[]; asOfSlot: Slot; coverage: 'full' | 'migrations_since_start' }, { code: 'E_GPA_UNSUPPORTED' | 'E_RPC' }>>;
}
interface EnumeratedPool { poolId: Pubkey; baseMint: Pubkey; isCanonical: boolean | null; firstEnumeratedAtMs: UnixMs;
  lastRefresh: { quoteReal: Lamports; quoteVirtual: bigint; baseReserve: BaseUnits; supply: BaseUnits | null; marketCapLamports: Lamports | null; asOfSlot: Slot } | null }   // NEW (persisted)
```

- **Logic:**
  1. Once per UTC day (`discovery.enumeration.hour_utc`, default 01:00) call `getProgramAccounts` on `PROGRAMS.pumpSwap` with `encoding: 'base64'` (set explicitly [DA-06]) and filters `memcmp { offset: 0, bytes: <Pool discriminator> }` and `memcmp { offset: 75, bytes: <wSOL> }`, with **no `dataSize` filter**, because legacy pools shorter than 300 bytes exist (≤ 4 filters, memcmp data ≤ 128 bytes [DA-06]; offsets settled 2026-10-07 [VF-03]). A `dataSlice` of offset 11, length 192 covers `creator` through `pool_quote_token_account` where the provider supports it. **Provider (D30 OWNER PENDING, C-75):** neither approved Phase 0 provider can run this call: Shyft Free allows 0 index requests a second and Chainstack Developer serves `getProgramAccounts` on paid plans only [VF-09, VF-10]; Helius Free can (5 a second; `getProgramAccounts` 10 credits, `getProgramAccountsV2` 1 credit per page of up to 10,000 [VF-11]). Until the owner rules, step 5's fallback runs and every manifest carries `coverage: 'migrations_since_start'`. Priority P4.
  2. Decode every result (A-M02-02); compute `isCanonical` (A-M01-01). Keep canonical pools only. Persist each pool's `firstEnumeratedAtMs` the first time it appears (used for the age rule in A-M05-01).
  3. Every `discovery.enumeration.refresh_ms` (default 6 h): read both vaults of every kept pool with `getMultipleAccounts` in batches of ≤ 90 accounts (A-06 VERIFY of the 100-account cap) at P4; compute `quoteReal`, `baseReserve`; for pools whose effective quote (real + virtual from the daily read) is ≥ `prefilter_min_quote_lamports` (default 300 SOL), also read the mint supply (batched) and compute market cap [EX-07].
  4. Candidate output: pools with market cap ≥ 98,240 SOL (the 0.30% tier [EX-07]) **and** effective depth ≥ 300 SOL (ARCH 3.3) are returned as `PoolDiscovered` (`source: 'chain_enumeration'`, `verifiedOnChain: true`). The fee tier is re-checked against the live FeeConfig by M05/M06 (the threshold may change [EX-12]).
  5. Fallback (D30 (b); the only path while D30 is owner pending, C-75): if no approved provider can serve the call, or every provider returns an error (`E_GPA_UNSUPPORTED`), return the set of migrated pools seen by A-M03-02 since recording started with `coverage: 'migrations_since_start'` and alert warning (survivorship coverage reduced; shown with every gate evaluation, ARCH M03).
  6. Raydium venues: return `E_GPA_UNSUPPORTED` with a `venue_not_specified` log until A-M01-06 defines the filters (D30).
- **Shared resources and concurrency:** M03 owns the enumerated-pool records (persisted via M24, see clarification C-14). One enumeration at a time; the 6-hourly refresh skips if the daily call is running. Idempotency: keyed by `poolId`.
- **Config:**

| Key | Type / unit | Default | Range |
|---|---|---|---|
| `discovery.enumeration.hour_utc` | int (hour) | 1 | 0-23 |
| `discovery.enumeration.refresh_ms` | duration_ms | 21,600,000 | 3,600,000-86,400,000 |
| `discovery.enumeration.prefilter_min_quote_lamports` | lamports | 300,000,000,000 | ≥ 0 (affectsReturns: yes, universe) |
| `discovery.enumeration.min_market_cap_lamports` | lamports | 98,240,000,000,000 | ≥ 0 (affectsReturns: yes) |
| `discovery.enumeration.max_response_bytes` | bytes | 100,000,000 | ≤ 100 MB (public RPC caps 100 MB per 30 s [DA-09]; provider caps VERIFY) |

- **Edge cases and failure handling:**
  1. Response too large or timed out → retry with `dataSlice` if supported (fetch the fields' byte range only; VERIFY), else fall back as step 5.
  2. Pool count far above the 50,000 budgeting assumption (A-43) → log the count; refresh cadence is stretched so P4 traffic stays ≤ 0.1 req/s.
  3. A pool disappears between enumerations (closed) → kept in history with `lastRefresh = null`; never deleted (survivorship [ST-26]).
- **Acceptance criteria:**
  - Given a mock provider returning a fixture of N pool accounts (mixed canonical, non-canonical, USDC-quoted), then only canonical wSOL-quoted pools are kept and those above both thresholds are returned.
  - Given every provider returning a method-not-allowed error, then the result has `coverage = 'migrations_since_start'` and an alert is raised.
  - Given 50,000 pools, then one refresh uses ≤ 1,112 `getMultipleAccounts` calls (DERIVED: 100,000 vault accounts ÷ 90) plus mint reads for pools above the prefilter.
- **Tests:** integration fixtures `fx/pumpswap/gpa_sample_pools.json` (a few hundred real pool accounts), `fx/pumpswap/vaults_batch.json`; failure injection: gPA unsupported on all providers; response size over cap.
- **Observability:** metrics `enumeration_pools_total{canonical}`, `enumeration_candidates_total`, `enumeration_duration_ms`, `rpc_credits_used{provider}` (via M14); log `M03.enumeration_done` (count, coverage, asOfSlot), `M03.enumeration_fallback`.
- **Security notes:** account data is validated by owner and decoded length before use.
- **Facts used:** EX-04, EX-07, EX-08, EX-12, DA-06, DA-09, DA-21, LD-28, ST-26, VF-01, VF-03, VF-11.
- **Definition of done:** first daily enumeration recorded in Phase 0 with its coverage value in the universe manifest; VERIFY items A-42 resolved (offsets and provider support) or fallback documented as active.

#### A-M03-04 — DexScreener coverage cross-check

- **Module:** M03 · **Phase:** 0 · **Size:** S (≈ 0.5 engineer-day)
- **Goal:** Check our pool coverage against a second source so coverage is measured, not assumed [ST-25]; never used for trading decisions. **Pointed at migrations (card Z-H-OF round 3):** with D30's enumeration (A-M03-03) parked, the cross-check runs on the pools of the migrations A-M03-02 recorded; the enumeration form returns only with D30.
- **Depends on:** A-M03-02 (migrations; was A-M03-03, parked), A-M14-03 (DexScreener client). B: none.
- **Interfaces:** `crossCheck(mints: Pubkey[]): Promise<{ checkedMints: number; poolsOnlyInVendor: Array<{ mint: Pubkey; pairAddress: Pubkey; dexId: string }>; asOfMs: UnixMs }>` (NEW, internal; result written into the daily manifest by A-M05-03).
- **Logic:** 1. Daily, take the base mints of the pools migrated in the last 24 h (A-M03-02; with D30 unparked, also the enumerated candidate pools) and call `/tokens/v1/{chainId}/{tokenAddresses}` with ≤ 30 addresses per call (300 requests/min [DA-26]). The `chainId` value for Solana and the response field names (pair address, DEX id, quote token): VERIFY against DexScreener's OpenAPI spec [DA-26]. 2. Report every pair the vendor lists for those mints with a PumpSwap DEX id that our enumeration did not return (possible coverage gap: a migration we missed, or with D30 unparked an enumeration gap). 3. Results go to the manifest only; vendor data never adds a pool to the universe (pools come only from chain reads).
- **Shared resources and concurrency:** none beyond M14's DexScreener bucket.
- **Config:** `discovery.dexscreener.enabled` (bool, true); `discovery.dexscreener.max_calls_per_day` (count, 500, 0-5,000).
- **Edge cases and failure handling:** 429 or licence revoked [DA-26] → skip, manifest records `cross_check: unavailable`; alert if unavailable > 1 h only while the check is running (ARCH M03).
- **Acceptance criteria:** Given a vendor fixture listing one PumpSwap pair not among the pools of our recorded migrations, then the manifest lists it under `poolsOnlyInVendor`.
- **Tests:** fixture `fx/dexscreener/tokens_v1_sample.json` (captured after VERIFY).
- **Observability:** `dexscreener_calls_total{status}`; log `M03.coverage_cross_check`.
- **Security notes:** vendor data is untrusted and stored privately only (A-32: terms for storing data are an open question; never redistributed).
- **Facts used:** DA-26, ST-25, VF-15.
- **Definition of done:** daily cross-check in the manifest; VERIFY for chain id and fields resolved.

### M04 Pool state tracker

#### A-M04-01 — Batched pool poller and snapshot ring buffer

- **Module:** M04 · **Phase:** 0 · **Size:** M (≈ 2 engineer-days)
- **Goal:** Poll every watched pool's state account and two vaults at `confirmed` (1 Hz candidates, 2 Hz pools with open positions), produce `PoolSnapshot`s with observation lag in slots, and keep 2 h of history per pool.
- **Depends on:** A-M14-02, A-M02-02, A-M01-03, A-M01-04. B: M15 `ChainState.highestSeenSlot()` (fed by M14's context-slot events, clarification C-05).
- **Interfaces (ARCH M04, with NEW additions logged in C-06):**

```ts
interface PoolSnapshot { pool: CpPoolState; effectiveQuoteLamports: Lamports; spotSolPerToken: DecimalStr;
  feeTotalBps: Bps; providerLabel: string; providerSlot: Slot; readLatencyMs: number; observationLagSlots: number;
  rawHash: string /* NEW: sha256 of the three raw account datas, for change-only recording (M07) */ }
interface PoolTracker {
  watch(poolId: Pubkey, priority: 'position' | 'candidate' | 'tail' /* 'tail' NEW */): void;
  unwatch(poolId: Pubkey): void;
  latest(poolId: Pubkey): PoolSnapshot | null;
  history(poolId: Pubkey, fromMs: UnixMs, toMs: UnixMs): ReadonlyArray<PoolSnapshot>;   // NEW (ring buffer read; M12 bracketing, M08)
  lagNow(s: PoolSnapshot): number;                                                       // NEW: highestSeenSlot() now − s.providerSlot
  // freshRead in A-M04-02
}
// publishes 'pool.snapshot' (every snapshot of a position pool, i.e. 2 Hz; ≤ 1 Hz for candidate pools; clarification C-12), 'pool.closed' { poolId, reason }
```

- **Logic:**
  1. Account set per pool: pool state, base vault, quote vault (3 accounts). Batches of ≤ `pool_tracker.max_accounts_per_call` (default 90; the 100 cap is VERIFY A-06) via `getMultipleAccounts` (`commitment: 'confirmed'`, `encoding: 'base64'`).
  2. Schedules: candidate pools every 1,000 ms at P2; position pools every 500 ms at **P1** (so they keep failing over in `degraded_reads`, clarification C-07); tail pools every 10,000 ms at P4 (ARCH M05 eviction tail). Batches are packed by priority class; a pool appears in exactly one class (position > candidate > tail).
  3. Mint supply for market cap: read every `pool_tracker.supply_refresh_ms` (default 60 s) per pool in batched mint reads at P2 (supply changes rarely, for example boost burns [EX-V01]); the snapshot carries the last supply.
  4. Per response: `providerSlot = context.slot`; for each pool whose three accounts are present: decode (A-M02-02), normalise (A-M01-04) → `CpPoolState` (`commitment: 'confirmed'`, `observedAtMs = clock.nowMs()`), `effectiveQuoteLamports` (A-M01-03), `spotSolPerToken`, `feeTotalBps = feeFor(...).totalBps` or **10,000 when the fee is unknown** (conservative sentinel, clarification C-08), `observationLagSlots = M15.highestSeenSlot() − providerSlot` at receipt.
  5. Monotonic rule (ARCH 7.2): if `providerSlot <` the latest stored snapshot's slot for that pool, discard (out-of-order from a lagging provider). If `observationLagSlots > pool_tracker.max_provider_lag_slots` (default 10) for a non-exit read, discard and report the provider's lag to M14 health (ARCH M04 failure table, 8.5).
  6. Ring buffer: last 2 h per pool (≈ 7,200 snapshots at 1 Hz, 14,400 at 2 Hz) in compact form; `history()` returns a read-only slice.
  7. Pool account missing, or owner not `PROGRAMS.pumpSwap`, or a vault's mint/owner changed → publish `pool.closed` (reason `closed` / `owner_changed`) and `venue.pool_quarantined` through M01; M20 treats it as `liquidity_collapse` (ARCH M04).
  8. Every snapshot is passed to M07 (`append`, stream `pool_snapshot`) with `rawHash`; M07 decides whether it changed.
- **Shared resources and concurrency:** M04 exclusively owns the ring buffers, freshness state and per-read provider slot (ARCH M04). All mutation on the event loop; a poll cycle never overlaps itself per class (a slow batch makes the next tick skip with `poll_skipped_total`). Snapshot identity `(poolId, providerSlot)`.
- **Config:**

| Key | Type / unit | Default | Range |
|---|---|---|---|
| `pool_tracker.candidate_interval_ms` | duration_ms | 1,000 | 500-5,000 |
| `pool_tracker.position_interval_ms` | duration_ms | 500 | 250-1,000 (must be < candidate interval) |
| `pool_tracker.tail_interval_ms` | duration_ms | 10,000 | 5,000-60,000 |
| `pool_tracker.max_accounts_per_call` | count | 90 | 1-100 (A-06 VERIFY) |
| `pool_tracker.supply_refresh_ms` | duration_ms | 60,000 | 10,000-600,000 |
| `pool_tracker.max_provider_lag_slots` | slots | 10 | 2-50 |
| `pool_tracker.history_ms` | duration_ms | 7,200,000 | 600,000-14,400,000 (memory) |

The candidate interval and the watchlist cap are linked: M05 derives `max_watched` from `max_accounts_per_call ÷ 3` per candidate interval (A-M05-02).

- **Edge cases and failure handling:**
  1. Primary 429 or error → M14 fails over within the same second (ARCH M04).
  2. All providers failing → no snapshots; staleness handled by A-M04-02; never fabricate a snapshot.
  3. One of the three accounts missing in a response → pool skipped this cycle, `partial_read_total`.
  4. Fee unknown → snapshot published with `feeTotalBps = 10,000` (fails every fee ceiling).
  5. Event-loop lag delays a tick → tick runs once (no burst catch-up).
- **Acceptance criteria:**
  - Given 30 candidate pools and 3 position pools, then calls per second are ≤ 1 (candidates, 90 accounts) + 2 (positions at 2 Hz, 9 accounts) + supply reads, matching ARCH 11.2.
  - Given a provider response with an older `context.slot` than the stored snapshot, then it is discarded and no `pool.snapshot` is published.
  - Given a pool account that returns `null`, then `pool.closed` is published within one cycle.
- **Tests:** unit (batch packing, monotonic rule); integration with a mock RPC replaying `fx/pumpswap/gma_cycle_sequence.json` (30 pools, 120 cycles, including an out-of-order response); failure injection: provider timeout, all-down, account closed.
- **Observability:** metrics `observation_lag_slots{pool,provider}`, `pool_snapshot_age_ms{pool}`, `poll_batch_latency_ms{provider}`, `poll_skipped_total{class}`, `partial_read_total`, `snapshot_out_of_order_total`; log `M04.pool_closed`.
- **Security notes:** values come from untrusted RPC responses; a lagging or malicious provider is limited by the monotonic and lag rules, and decisions use `confirmed` data only (D14).
- **Facts used:** EX-07, EX-09, EX-V01, LD-08, LD-09, TH-47, VF-11.
- **Definition of done:** poller in the Phase 0 recorder; 48 h soak test with coverage ≥ 95%; metrics in VM-13 via M28.

#### A-M04-02 — `freshRead`, observation lag and staleness

- **Module:** M04 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Provide the single freshness rule (observation lag in slots) with the stage thresholds of ARCH 8.5: decision ≤ 12 slots, build ≤ 8 slots, exits never blocked.
- **Depends on:** A-M04-01. B: M15 `highestSeenSlot()`, `slotDurationMsEstimate()`; consumers M19, M20, M21.
- **Interfaces (ARCH M04):**

```ts
interface PoolTracker {
  freshRead(poolId: Pubkey, maxLagSlots: number): Promise<Result<PoolSnapshot, { code: 'E_STALE' | 'E_RPC' }>>;
}
// publishes 'pool.stale' { poolId, lagSlots, sinceMs } when lagNow(latest) > 12, and 'pool.fresh' when it recovers
```

- **Logic:**
  1. `maxLagSlots` semantics (clarification C-09): a finite value (8 for builds, ARCH 8.3) means "entry-grade read": one `getMultipleAccounts` at P1 for the pool's 3 accounts; if `lagNow > maxLagSlots`, re-read **once** on the next provider; if still above → `E_STALE` (ARCH 8.5 "re-read once; if still stale, entry abandoned"). `maxLagSlots = Number.POSITIVE_INFINITY` means "exit-grade read": P0, may use any reachable provider, never returns `E_STALE`; it returns the freshest of up to 2 attempts and, if `lagNow > pool_tracker.exit_lag_alert_slots` (default 40), raises an alert while still returning the snapshot (ARCH 8.3, 8.5: exits never blocked).
  2. A successful fresh read updates the ring buffer and `latest()` under the monotonic rule.
  3. `E_RPC` only when every attempt failed; exits then fall back to `latest()` (M20's responsibility) and retry every 2 s (ARCH M20).
  4. Staleness monitor every 500 ms: for each watched pool, `lagNow(latest)` > `pool_tracker.stale_lag_slots` (default 12) → `pool.stale` (once per episode); M21 rejects entries with `stale_pool`; M05 moves the candidate to `stale` after 30 s (ARCH 7.5).
  5. Lag is converted to milliseconds only for display: `lagSlots × slotDurationMsEstimate()` (VM-07 `quote_age_ms`, VM-13).
- **Shared resources and concurrency:** same ownership as A-M04-01. Concurrent `freshRead` calls for the same pool coalesce into one in-flight request (keyed by `poolId` and grade); results shared.
- **Config:** `pool_tracker.stale_lag_slots` (slots, 12, 4-50; increases_risk on increase); `pool_tracker.build_lag_slots` (slots, 8, 2-20; increases_risk on increase; exported for M19's builder call); `pool_tracker.exit_lag_alert_slots` (slots, 40, 12-400).
- **Edge cases and failure handling:**
  1. `highestSeenSlot` itself stale (M15 down) → lag computed against M15's last value; M15's own failure handling blocks entries (ARCH M15).
  2. All providers lagging equally (cluster stall) → lag small, reads succeed; the slot clock is the arbiter.
  3. Coalesced exit and entry reads → the exit-grade read wins (P0) and both callers receive its result; the entry caller still applies its own threshold.
- **Acceptance criteria:**
  - Given a provider 11 slots behind and another 2 slots behind, when `freshRead(pool, 8)` runs, then the second read is used and returned.
  - Given every provider 20 slots behind, then `freshRead(pool, 8)` → `E_STALE` and `freshRead(pool, Infinity)` → `ok` with an alert logged.
  - Given no successful poll for 13 slots, then exactly one `pool.stale` is published.
- **Tests:** unit with a fake `ChainState` and fake gateway; property test: `freshRead(_, Infinity)` never returns `E_STALE`; failure injection: provider lag sweep 0-60 slots.
- **Observability:** metrics `fresh_read_latency_ms{grade}`, `fresh_read_stale_total`, `exit_read_lag_slots`; log `M04.pool_stale`, `M04.exit_read_lagging` (warning).
- **Security notes:** none beyond A-M04-01.
- **Facts used:** LD-08, LD-09.
- **Definition of done:** M19/M20/M21 contract tests (group B test doubles) pass against the semantics above.

#### A-M04-03 — Transport seam for the D03 switch

- **Module:** M04 · **Phase:** 0 · **Size:** S (≈ 0.5 engineer-day)
- **Goal:** Isolate the polling transport behind an interface so the D03 switch (WebSocket `accountSubscribe` for open-position pools, or streaming) and the 7-day slot-level recording trial need no rewrite of M04, M07 or M08.
- **Depends on:** A-M04-01. B: none.
- **Interfaces:** `interface PoolSource { kind: 'poll' | 'account_subscribe'; start(pools: Pubkey[][]): void; stop(): void; onAccounts(h: (r: { accounts: Array<Uint8Array | null>; contextSlot: Slot; providerLabel: string; latencyMs: number }) => void): () => void }` (NEW, internal).
- **Logic:** 1. Default and only enabled implementation: `poll` (D03 default (a)). 2. `account_subscribe` implementation is a stub that refuses to start unless `pool_tracker.subscribe.enabled = true`, and its method names, message shape and per-message metering (2 credits per 0.1 MB on Helius [LD-V01]) are VERIFY items against Helius and Solana WebSocket docs (A-31). 3. Both sources produce the same `onAccounts` records so snapshots, lag and recording are identical; with subscription, each update carries its own context slot.
- **Shared resources and concurrency:** none new.
- **Config:** `pool_tracker.subscribe.enabled` (bool, false; enabling requires the D03 trigger evidence; risk neutral; cost: Helius credits).
- **Edge cases and failure handling:** subscription disconnect → fall back to polling for those pools immediately.
- **Acceptance criteria:** Given the poll source replaced by a scripted fake source, then M04 snapshots and M07 records are byte-identical to a poll run with the same inputs.
- **Tests:** unit with fake sources.
- **Observability:** `pool_source_kind` gauge.
- **Security notes:** none.
- **Facts used:** LD-V01, VF-12.
- **Definition of done:** seam merged; poll path unchanged; stub refuses to start by default.

### M05 Universe and watchlist manager

#### A-M05-01 — Candidate state machine, prefilters, blacklist and cooldown

- **Module:** M05 · **Phase:** 0 (prefilter and manifest only; screening states activate in Phase 1 with M06) · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Implement the token-candidate state machine of ARCH 7.5 exactly, with the cheap prefilters, blacklist and cooldowns.
- **Depends on:** A-M03-02 (migrations only; A-M03-03 is parked with D30, card Z-H-OF round 3), A-M04-02, A-M01-02. B: M24 `candidate` table; M22 `written_off`/`unsolicited` mint lists (read); M20 position terminal events (topic).
- **Interfaces (ARCH M05):**

```ts
interface CandidateRecord { candidateId: Id; mint: Pubkey; poolId: Pubkey; venue: VenueId; state: CandidateState;
  firstSeenAtMs: UnixMs; lastScreen: ScreenResult | null; cooldownUntilMs: UnixMs | null; reasons: string[] }
interface Universe {
  onDiscovery(e: PoolDiscovered): void;
  blacklist(mint: Pubkey, reason: string, untilMs: UnixMs | null /* null = permanent */): void;   // ARCH 7.2 (requested by M06, M02, M20)
  candidate(poolId: Pubkey): CandidateRecord | null;                                              // NEW read accessor
  // pinForPosition / unpin / watchlist / postEvictionTail / manifest in A-M05-02, A-M05-03
}
// publishes 'universe.candidate_state' { candidateId, poolId, mint, from, to, reason, atMs }
```

- **Logic (transitions from ARCH 7.5; every transition persisted with reason):**
  1. `PoolDiscovered` with `verifiedOnChain = true` → `discovered` (unverified discoveries are ignored).
  2. Prefilter (cheap, no extra RPC beyond the snapshot M04 already has):
     - venue allowlisted and `venue_specified` (PumpSwap yes; Raydium only after A-M01-06) (ARCH 8.4);
     - fee per side ≤ the strategy's ceiling (MR 30 bps, PM 125 bps) from `feeFor` on the latest snapshot;
     - effective depth ≥ the strategy minimum (MR 300 SOL, PM 85 SOL);
     - pool age ≥ minimum. **Age rule (clarification C-15):** age is proven only by (a) the pool's migration event slot time from A-M03-02, or (b) `firstEnumeratedAtMs` from A-M03-03 (the pool existed then; (b) is unavailable while D30 is parked, card Z-H-OF round 3, so only (a) proves age). `ageMs = now − min(knownMigrationMs, firstEnumeratedAtMs)`; unknown → fails the prefilter. On the first day of recording, enumerated pools therefore qualify for MR only 24 h after first enumeration (conservative);
     - not blacklisted; normalised with `quoteMint = wSOL`.
     Fail → `prefiltered_out` with reasons; re-evaluated on the next discovery or every 6 h (ARCH 7.5).
  3. Pass → `screening` (Phase 1+: M06 `screen(purpose: 'universe')`). Phase 0 behaviour: with `universe.screening_required = false`, the candidate goes straight to `eligible` with reason `phase0_unscreened`. Validation: `screening_required = false` is accepted only while no strategy is enabled in any mode (so it can never feed a trade) (clarification C-44).
  4. Screen verdict `rejected` with soft reasons only → `rejected`, retry after 6 h; hard fail (authority, extension, honeypot, LP) → `blacklisted` (24 h for honeypot, permanent for authority/extension) (ARCH 7.5).
  5. `eligible` → `watched` when A-M05-02 grants a slot; else stays `eligible` (queue by depth).
  6. `watched` → `signalled` on a strategy proposal (M09 event); `signalled` → `watched` on M21 reject; → `in_position` on M21 accept.
  7. `in_position` → `cooldown` (30 min per mint, POLICY) on **any** terminal position state (`closed`, `open_failed`, `written_off`) from M20; a `written_off` position then leads to `blacklisted` (CA-15).
  8. `cooldown` → `watched` after the timer if a re-screen is still eligible, else `evicted`.
  9. `watched` → `stale` when M04 data has been stale > 30 s; `stale` → `watched` on fresh data.
  10. `watched` → `rejected`/`blacklisted` on a failed re-screen; → `evicted` on budget eviction (A-M05-02).
  11. Any state → `blacklisted` on `token.authority_changed` (M06), `decoder.unknown_layout` for the pool (A-M02-05, reason `unknown_layout`, until reviewed), or `venue.pool_quarantined` (A-M01-04).
  12. Mints on M22's `unsolicited` or `written_off` lists never become candidates for new entries (`written_off` → blacklisted).
  13. Screening backlog > 100 → drop the oldest unscreened candidates with reason `backlog` (ARCH M05).
- **Shared resources and concurrency:** M05 owns candidate state per mint and pool, cooldowns and the blacklist (ARCH 7.2). Writes in one SQLite transaction with the outbox event (M24 rule). Transitions use a compare-and-set on the record's `version` (ARCH 7.1); stale requests get `E_STATE_CHANGED`. Idempotency: one candidate per `(mint, poolId)`.
- **Config:**

| Key | Type / unit | Default | Range | affectsReturns |
|---|---|---|---|---|
| `universe.screening_required` | bool | true | false only with no enabled strategy | no |
| `universe.cooldown_ms` | duration_ms | 1,800,000 | 0-86,400,000 | yes |
| `universe.prefilter_retry_ms` | duration_ms | 21,600,000 | 600,000-86,400,000 | yes |
| `universe.stale_to_state_ms` | duration_ms | 30,000 | 5,000-600,000 | no |
| `universe.screen_backlog_max` | count | 100 | 10-1,000 | no |
| `strategy.<id>.universe.*` (fee ceiling bps, min depth lamports, min age ms) | per strategy | MR: 30 / 300 SOL / 24 h; PM: 125 / 85 SOL / 20 min after migration | ceilings per ARCH 8.4 | yes |

- **Edge cases and failure handling:**
  1. Same pool discovered by several sources → one candidate (idempotent).
  2. Event for an unknown candidate (for example M20 terminal for a mint never seen) → log and create no candidate.
  3. Database write failure → transition not applied; event retried; M24's halt rule applies if the disk is full.
- **Acceptance criteria:**
  - Given a random sequence of events (property test), then no undefined transition occurs, a position ending `open_failed` or `written_off` always moves its candidate to `cooldown`, and a written-off mint is blacklisted (ARCH 16.2).
  - (Only with D30 unparked.) Given a pool first enumerated 23 h ago with no known migration, then it fails the MR age prefilter; at 24 h it passes. With D30 parked, a pool with no known migration has no age proof and fails the MR age prefilter.
  - Given `screening_required = false` and an enabled strategy, then config validation rejects it.
- **Tests:** unit per transition; property-based state-machine test; integration with M04/M03 fixtures; failure injection: backlog of 150.
- **Observability:** metrics `candidates{state}` (gauge), `candidate_transitions_total{from,to}`, `blacklist_size`; log `M05.transition` (debug), `M05.blacklisted` (info).
- **Security notes:** token symbols are never used as identity (`identity_by_mint`, ARCH 8.4); everything keys by mint.
- **Facts used:** TH-15, TH-30, ST-10.
- **Definition of done:** state machine merged with the property test; Phase 0 mode documented; consumes M20/M06 events through test doubles.

#### A-M05-02 — Watchlist allocation, pinning, eviction and eviction tail

- **Module:** M05 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Keep the polled set within M04's budget, always watch pools with open positions, and keep recording evicted pools for a tail period so replays are not survivorship-biased (CA-25).
- **Depends on:** A-M05-01, A-M04-01, A-M14-05 (degraded mode). B: M20 calls `pinForPosition`/`unpin`.
- **Interfaces (ARCH M05):**

```ts
interface Universe {
  pinForPosition(poolId: Pubkey): void;        // open positions are always watched and never evicted
  unpin(poolId: Pubkey): void;
  watchlist(): ReadonlyArray<{ poolId: Pubkey; priority: number }>;
  postEvictionTail(): ReadonlyArray<{ poolId: Pubkey; untilMs: UnixMs; reason: string }>;
}
```

- **Logic:**
  1. `max_watched` (POLICY 30) = `floor(pool_tracker.max_accounts_per_call / 3)` per candidate polling interval (DERIVED: 90 ÷ 3 = 30, ARCH M04 budget); config may lower it, never raise it above the derived value.
  2. Pinned pools (open positions) are always watched at priority `position` (M04 `watch(pool, 'position')`), do not count against `max_watched`, and are never evicted (ARCH M05). `pinForPosition` is idempotent; `unpin` only demotes the pool to candidate priority (it may then be evicted normally).
  3. Fill free slots from `eligible` candidates ordered by effective depth (descending), then by first-seen time.
  4. Eviction order when over budget: lowest priority first — `stale` pools, then lowest depth; never pinned (ARCH M05).
  5. Eviction tail: an evicted pool keeps being polled at 0.1 Hz (M04 `watch(pool, 'tail')`) until `max holding period of any enabled strategy + 1 h` (ARCH M05, CA-25); up to `universe.tail_max_pools` (default 30); oldest tail entries end first if the cap is hit, with reason `tail_capacity` recorded in the manifest.
  6. Degraded reads (M14 `mode() = 'degraded_reads'`): shrink the watchlist to pinned pools only; candidates are unwatched with reason `degraded`; tail polling stops (P4 is suspended) and the gap is recorded (ARCH 11.2).
- **Shared resources and concurrency:** watchlist slots owned by M05; M20 requests via `pinForPosition` (set semantics, ARCH 7.2). Recomputed on every candidate transition and every 10 s; single writer.
- **Config:** `universe.max_watched` (count, 30, 1 to derived max); `universe.tail_max_pools` (count, 30, 0-60); `universe.tail_extra_ms` (duration_ms, 3,600,000, ≥ 3,600,000; affectsReturns: no).
- **Edge cases and failure handling:** 1. More pinned pools than `max_watched` (cannot happen with `MAXOPEN` ≤ 5) → all pinned watched anyway; candidates reduced to fit the account budget. 2. `unpin` for an unknown pool → no-op with log. 3. Restart → pins re-established from M20's open positions before candidates (recovery order, ARCH 7.6 step 6).
- **Acceptance criteria:**
  - Given 40 eligible candidates and 2 pinned pools, then 30 candidates + 2 pinned are watched and the 10 lowest-depth candidates wait.
  - Given eviction of a watched pool, then it is polled at 0.1 Hz for at least max-hold + 1 h and appears in `postEvictionTail()`.
  - Given `degraded_reads`, then only pinned pools remain watched within one recompute.
- **Tests:** unit; property test: a pinned pool is never evicted under any event sequence; integration with A-M04-01's mock RPC.
- **Observability:** metrics `watchlist_size{priority}`, `evictions_total{reason}`, `tail_pools`; log `M05.evicted`, `M05.watchlist_shrunk_degraded`.
- **Security notes:** none.
- **Facts used:** ST-26.
- **Definition of done:** watchlist live in Phase 0; tail visible in the manifest.

#### A-M05-03 — Daily universe manifest and the A-24 count

- **Module:** M05 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Write, at 00:00 UTC, the record of every pool eligible during the day (with why) and every pool evicted (with why), plus the A-24 count and coverage, so every replay builds the universe-at-the-time from it (ARCH 3.4).
- **Depends on:** A-M05-02, A-M07-02. B: none.
- **Interfaces (ARCH M05):**

```ts
interface Universe {
  manifest(dayUtc: string): { eligible: Array<{ poolId: Pubkey; reason: string }>; evicted: Array<{ poolId: Pubkey; atMs: UnixMs; reason: string }> };
}
interface UniverseManifestFile {                                                      // NEW (file schema, written through M07)
  manifestVersion: 1; dayUtc: string; generatedAtMs: UnixMs; enumerationCoverage: 'full' | 'migrations_since_start' | 'none';
  eligible: Array<{ poolId: Pubkey; mint: Pubkey; venue: VenueId; firstEligibleAtMs: UnixMs; lastEligibleAtMs: UnixMs;
    reason: string /* e.g. "fee=30bps;depth=1412SOL;age>=24h;screen=eligible@<slot>|phase0_unscreened" */ }>;
  evicted: Array<{ poolId: Pubkey; atMs: UnixMs; reason: string; tailUntilMs: UnixMs | null }>;
  a24: { eligibleCount: number; canonicalityUnknownCount: number; maxSimultaneous: number };
  crossCheck: { poolsOnlyInVendor: number; status: 'ok' | 'unavailable' } ;
  sha256: string /* of the canonical JSON without this field */ }
```

- **Logic:** 1. During the day, track per pool the first and last time it was `eligible` or `watched` and every eviction. 2. At 00:00 UTC (wall clock; sim clock in research), write the file via M07 stream `universe_manifest` and hash it; M07 puts the hash into the day's `CoverageReport.universeManifestSha256`. 3. `a24.eligibleCount` = distinct pools eligible at any time that day; `maxSimultaneous` = the peak concurrent count. In Phase 0 eligibility is prefilter-only (`phase0_unscreened`), so the count is an **upper bound** and is labelled as such. 4. `enumerationCoverage` from A-M03-03 (while D30 is parked, card Z-H-OF round 3, it is `migrations_since_start`); `crossCheck` from A-M03-04.
- **Shared resources and concurrency:** M05 owns the manifest content; M07 owns the file. Written once per day; regeneration for a past day is forbidden (immutable once hashed).
- **Config:** none.
- **Edge cases and failure handling:** engine down at midnight → on restart, write the missed day's manifest from persisted transitions with `generatedAtMs` later than the day end and a `late: true` flag; days with missing data are marked low coverage by M07.
- **Acceptance criteria:** Given a scripted day with 12 pools eligible at different times and 3 evictions, then the manifest lists exactly those with reasons, and its SHA-256 equals the value in the day's `CoverageReport`.
- **Tests:** unit; golden-file test of the canonical JSON; integration with M07 rotation at a mocked midnight.
- **Observability:** metric `universe_eligible_count` (daily gauge); log `M05.manifest_written` (day, count, sha256).
- **Security notes:** none.
- **Facts used:** ST-24, ST-26.
- **Definition of done:** manifests produced daily in Phase 0 and consumed by A-M13-01.

### M06 Token screener

#### A-M06-01 — Check framework, result cache and screening purposes

- **Module:** M06 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** One typed framework that runs every check of ARCH 8.4 for a `(mint, pool)` and purpose, caches each input with its TTL, and applies the default-reject rule.
- **Depends on:** A-M05-01, A-M14-02. B: M25 `Config`; M24 `screen_result` table; M21 (final verdict owner) and M28 (VM-07/VM-08 projection) consume `ScreenResult`.
- **Interfaces (ARCH M06):**

```ts
type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped' | 'error';
interface RiskCheck { checkId: string; label: string; status: CheckStatus; observed: DecimalStr | null; threshold: DecimalStr | null;
  unit: 'lamports' | 'base_units' | 'bps' | 'ms' | 'count' | 'slot' | 'bool' | 'usd_e6' | 'sol_per_token';
  comparator: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq' | 'is_true' | 'is_false'; message: string; skippedReason: string | null;
  severity: 'hard' | 'soft' }
interface ScreenResult { mint: Pubkey; poolId: Pubkey; tokenProgram: 'spl_token' | 'token_2022' | 'unknown';
  checks: RiskCheck[]; verdict: 'eligible' | 'rejected'; asOfSlot: Slot; asOfMs: UnixMs }
interface Screener {
  screen(mint: Pubkey, poolId: Pubkey, opts: { purpose: 'universe' | 'pre_entry' | 'pre_exit'; withSellSim?: boolean /* NEW, C-43 */ }): Promise<ScreenResult>;
  authorityRecheck(mint: Pubkey): Promise<Result<{ changed: boolean; check: RiskCheck[] }, { code: string }>>;
}
interface CheckProvider { checkIds: string[]; inputs: Array<'mint' | 'holders' | 'lp' | 'pool' | 'simulation' | 'vendor'>;
  run(ctx: ScreenCtx): Promise<RiskCheck[]> }                                         // NEW (internal plug-in shape for A-M06-02..06)
```

- **Logic:**
  1. Registry of `CheckProvider`s (A-M06-02..06). `screen()` runs all providers whose checks apply to the candidate's strategy (VM-07 rule: every applicable check present, including skipped ones with a reason).
  2. Input cache TTLs (ARCH M06): authorities and extensions 10 min while watched; holders 5 min; LP state and LP distribution 10 min (re-read on that TTL while a position is open, CA-20); simulation 10 min; vendor 30 min. Purpose overrides: `pre_entry` forces a fresh mint read (authority/extension input must be ≤ 5 s old at entry, ARCH 8.5) and uses cached values for the rest within TTL; `pre_exit` re-reads authorities and extensions only and **runs in parallel** with the exit (the caller never awaits it before sending, CA-31); when the caller passes `withSellSim: true` (NEW optional field of `opts`, clarification C-43; used by M20 after a failed exit attempt), it also runs the combined round-trip simulation of A-M06-05, still without delaying any exit.
  3. Verdict: `rejected` if any `hard` check has status `fail` or `error` (an `error` is a fail, VM-07 rule); otherwise `eligible`. `soft` failures stay `fail` internally (M28 projects them as `warn`, CB-24) and may reduce size in M21.
  4. Every result is persisted (`screen_result`, purpose, checks JSON) and sent to M07 (stream `screen`).
  5. `pre_exit` results never block or delay an exit: they can only publish `token.authority_changed` (A-M06-06), which may change an exit's reason or escalate its rung (CA-31).
- **Shared resources and concurrency:** M06 owns the `ScreenResult` cache and `TokenMetadataCache` (ARCH M06). Concurrent `screen` calls for the same `(mint, pool, purpose)` coalesce. Results keyed `(mint, poolId, asOfSlot)`; append-only persistence.
- **Config:** `screener.ttl.authorities_ms` (600,000; 60,000-600,000), `screener.ttl.holders_ms` (300,000), `screener.ttl.lp_ms` (600,000), `screener.ttl.simulation_ms` (600,000), `screener.ttl.vendor_ms` (1,800,000), `screener.entry_authority_max_age_ms` (5,000; 1,000-5,000; increasing it increases risk). All TTL keys `affectsReturns: true`.
- **Edge cases and failure handling:** 1. RPC error on a hard check input → that check `error` → rejected for entries; for `pre_exit`, errors only log (ARCH M06). 2. Provider throws → its checks `error` with message; others still run. 3. Unknown check ID in config → validation error.
- **Acceptance criteria:**
  - Given a hard check provider returning `error`, then the verdict is `rejected` and the check appears with status `error`.
  - Given `purpose: 'pre_entry'` with a 6 s old cached mint read, then the mint is re-read before the verdict.
  - Given `purpose: 'pre_exit'`, then `screen` resolves without the caller awaiting it in the exit path (contract test with an M20 test double that measures that the exit send is not delayed).
- **Tests:** unit for verdict rules and TTL logic with a fake clock; integration with providers' fixtures; property test: verdict is `eligible` only if no hard check is `fail`/`error`.
- **Observability:** metrics `screen_duration_ms{purpose}`, `screen_verdict_total{verdict,check_id}`; log `M06.screen` (summary per verdict, debug).
- **Security notes:** token strings are untrusted (length-limited 32/64 bytes, never rendered by M06).
- **Facts used:** TH-46, TH-47.
- **Definition of done:** framework merged; providers plug in; VM-07 shape fixture tests pass (with M28's projection test double).

#### A-M06-02 — Mint, Token-2022 extension and metadata checks; `TokenMetadataCache`

- **Module:** M06 · **Phase:** 1 · **Size:** M (≈ 2 engineer-days)
- **Goal:** Read the mint with `jsonParsed`, run every authority, extension and metadata check of ARCH 8.4, and maintain the token metadata cache that feeds VM-04/05/06/07/08.
- **Depends on:** A-M06-01, A-M02-02. B: M24 `token` table.
- **Interfaces:**

```ts
interface TokenMetadata {                                                            // the TokenMetadataCache record (CB-12)
  mint: Pubkey; tokenProgram: 'spl_token' | 'token_2022' | 'unknown'; decimals: number | null; supplyBase: BaseUnits | null;
  symbol: string | null /* untrusted, ≤ 32 bytes */; name: string | null /* untrusted, ≤ 64 bytes */;
  metadataUpdateAuthority: Pubkey | null; mintAuthority: Pubkey | null; freezeAuthority: Pubkey | null;
  extensions: string[]; symbolCollisionCount: number; firstSeenAtMs: UnixMs; refreshedAtMs: UnixMs }
interface TokenMetadataCache { get(mint: Pubkey): TokenMetadata | null; refresh(mint: Pubkey): Promise<Result<TokenMetadata, { code: string }>> }   // NEW accessor
```

- **Logic:**
  1. `getAccountInfo(mint, { encoding: 'jsonParsed', commitment: 'confirmed' })` (Agave's decoder maps every Token-2022 extension and returns `UnparseableExtension` for unknown ones [TH-28]; deployed RPC nodes may run older versions [TH-28 note]). Exact jsonParsed field names for extensions: VERIFY against the Agave `parse_token_extension.rs` source [TH-28] and a captured response.
  2. Checks (IDs from ARCH 8.4; all `hard` unless stated):
     - `mint_owner_program`: owner is SPL Token or Token-2022 [TH-01, DA-12].
     - `freeze_authority_none`: null [TH-01, TH-02].
     - `mint_authority_none`: null; curve-phase pump mints with the Pump `mint-authority` PDA are allowed only for research strategies [TH-16]. Fresh pump mints were observed with null authorities [TH-V01].
     - `t22_extension_allowlist`: only `MetadataPointer` and `TokenMetadata` on the mint (and `ImmutableOwner` on accounts); `MintCloseAuthority` allowed with a soft flag (mint close requires zero supply [TH-11]) [TH-04, TH-16].
     - `t22_permanent_delegate` [TH-06], `t22_transfer_fee` (any `TransferFeeConfig`, including zero fee with a live authority; fees up to 100% with a 2-epoch delay [TH-07]), `t22_transfer_hook` [TH-08], `t22_default_frozen` [TH-09], `t22_pausable` [TH-10], `t22_nontransferable` [TH-04], `t22_confidential` (any `ConfidentialTransfer*` / `ConfidentialMintBurn`) [TH-04], `t22_permissioned_burn` [TH-05, TH-V05], `t22_scaled_or_interest` (`ScaledUiAmount`, `InterestBearingConfig`) [TH-12]: all must be absent.
     - `t22_unparseable`: no `UnparseableExtension` [TH-28] (fails closed for extensions the node does not know).
     - `metadata_matches_mint`: Token-2022 `TokenMetadata.mint == mint` (anti-spoofing [TH-14]); for SPL Token mints with Metaplex metadata, the metadata account's `mint == mint` (Metaplex program `metaqbxx...` [TH-13]; PDA derivation for the metadata account: VERIFY against `mpl-token-metadata` source before implementing). If the `MetadataPointer` points to an account other than the mint itself, read it and apply the same rule (pump mints point to the mint itself [TH-16]).
     - `metadata_mutable` (soft): update authority null [TH-13, TH-14, TH-22].
     - `mayhem_or_special`: exclude coins flagged mayhem mode, holder-rewards or cashback (ARCH 8.4; semantics UNVERIFIED, A-12). Source: the flags carried by `CreateEvent` (`is_mayhem_mode`, `is_holder_reward` [DA-12]) when recorded, or by the bonding-curve / pool account if the pinned IDL has such fields (VERIFY in `pump.json`/`pump_amm.json`). If no source can determine the flags for this mint → status `error` → reject (clarification C-16). This is deliberately conservative: established pools whose creation event was not recorded can only pass if an account-level field answers the question.
     - `usdc_quote`: quote mint is wSOL (from M01 normalisation) [EX-10, DA-13].
     - `identity_by_mint` (design rule): always `pass` with `observed = symbol_collision_count` so VM-07 shows it; identity is the mint everywhere [TH-15].
  3. `TokenMetadataCache`: from the same read plus the metadata source; `symbol`/`name` truncated to 32/64 bytes at the byte boundary of a whole UTF-8 character; control characters removed; `symbolCollisionCount` = number of other mints in the `token` table with the same normalised symbol. Persist to `token` (ARCH 15).
  4. `authorityRecheck(mint)` (used by A-M06-06 and `pre_exit`): re-read and compare authorities, extension set and transfer-fee config with the cached ones; `changed = true` on any difference.
- **Shared resources and concurrency:** owns `TokenMetadataCache` (single writer, coalesced refresh per mint).
- **Config:** `screener.t22.allow_mint_close_authority_soft` (bool, true); `screener.mayhem.require_determination` (bool, true; setting false increases risk and is A3).
- **Edge cases and failure handling:** 1. Mint account missing → all mint checks `error`. 2. jsonParsed returns raw bytes (node cannot parse) → `t22_unparseable` fail. 3. Metadata name/symbol containing invalid UTF-8 → replaced characters; stored escaped. 4. Supply above 2^63 → stored as decimal string (ARCH 15).
- **Acceptance criteria:**
  - Given the fresh pump mint fixture (Token-2022, null authorities, only `metadataPointer` + `tokenMetadata` [TH-V01]), then every mint check passes except those requiring flags that cannot be determined, which are `error`.
  - Given synthetic jsonParsed fixtures for each forbidden extension, then the matching check fails and the verdict is `rejected`.
  - Given a `TokenMetadata.mint` different from the mint, then `metadata_matches_mint` fails.
- **Tests:** unit per check; fixtures `fx/token2022/pump_mint_fresh_jsonparsed.json`, `fx/token2022/ext_<name>.json` (one per forbidden extension, from devnet or synthetic per the extension docs), `fx/token2022/unparseable.json`, `fx/spl/mint_with_freeze_authority.json`; property test for the UTF-8 truncation.
- **Observability:** `screen_verdict_total{check_id}`; log `M06.metadata_refreshed`.
- **Security notes:** names and symbols are attacker-controlled (XSS, spoofing); stored length-limited and escaped; never used as identity.
- **Facts used:** TH-01, TH-02, TH-04, TH-05, TH-06, TH-07, TH-08, TH-09, TH-10, TH-11, TH-12, TH-13, TH-14, TH-15, TH-16, TH-22, TH-28, TH-V01, TH-V05, DA-12, DA-13, EX-10.
- **Definition of done:** all checks merged with fixtures; VERIFY items (jsonParsed field names, Metaplex PDA, mayhem flag source) resolved or left fail-closed and listed.

#### A-M06-03 — Holder concentration checks

- **Module:** M06 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Measure owner-level concentration from the 20 largest token accounts and resolve owners, excluding pool and program accounts.
- **Depends on:** A-M06-01, A-M02-02. B: none (VM-08 `holders_top[]` is projected by M28 from this result).
- **Interfaces:** `HolderSnapshot { mint: Pubkey; supplyBase: BaseUnits; holders: Array<{ tokenAccount: Pubkey; owner: Pubkey; amountBase: BaseUnits; pctBps: number; excluded: null | 'pool_vault' | 'bonding_curve' | 'burn' | 'program_owned' }>; asOfSlot: Slot }` (NEW, internal; cached 5 min).
- **Logic:**
  1. `getTokenLargestAccounts(mint)` returns up to 20 token accounts with amounts, **not owners** [DA-07]; resolve owners with one `getMultipleAccounts` on those 20 accounts (decode A-M02-02).
  2. Exclusions: the pool's base vault; the bonding-curve token account (for curve tokens); known burn/incinerator addresses (list in config, VERIFY each address before adding); owners that are off-curve PDAs of allowlisted programs (pool authorities). Aggregate the remaining amounts per owner.
  3. Checks: `top10_holders` (hard): top 10 owners hold ≤ 35% of supply (POLICY; RugCheck flags > 50% warn, > 70% danger [TH-22]; bundled accounts held 36.5% of supply at migration in MELT [ST-09]); `single_holder` (hard): no single non-program owner > 10% (POLICY) [TH-22]; `creator_balance` (soft): the creator holds ≤ 5% (creator from the pool's coin-creator field or the curve's `creator`; field name VERIFY in the pinned IDL).
  4. Since only 20 accounts are visible, `observed` values are lower bounds of concentration beyond the top 20; the message says so.
  5. Provider limit (2026-10-07, C-75): `getTokenLargestAccounts` and `getTokenAccountsByOwner` are index calls that Shyft Free (0 index requests a second) and Chainstack Developer (paid plans or dedicated nodes only) cannot serve [VF-09, VF-10]. Before this ticket runs in M2 the owner must rule on a provider for index calls, as for D30; until then the checks return `error` (fail closed).
- **Shared resources and concurrency:** cache owned by M06.
- **Config:** `screener.holders.top10_max_bps` (bps, 3,500, 500-10,000; increases_risk on increase; affectsReturns yes); `screener.holders.single_max_bps` (1,000); `screener.holders.creator_max_bps` (500); `screener.holders.burn_addresses` (list, default empty until verified).
- **Edge cases and failure handling:** 1. Public-style 429 on `getTokenLargestAccounts` (observed on the public RPC [LD-26]) → retry on another provider; all fail → checks `error`. 2. Supply 0 → `error`. 3. Owner account not a token account (closed between calls) → re-read once, else `error`.
- **Acceptance criteria:** Given a fixture where one owner holds 3 of the top 20 accounts totalling 12%, then `single_holder` fails with observed 1,200 bps; given the pool vault holding 60%, then it is excluded and not counted.
- **Tests:** unit; fixtures `fx/holders/largest_accounts_sample.json`, `fx/holders/owners_batch.json`.
- **Observability:** `holder_checks_total{status}`.
- **Security notes:** holder data from untrusted RPC; owner resolution is by on-chain account data only.
- **Facts used:** DA-07, TH-22, ST-09, LD-26.
- **Definition of done:** checks merged; VM-08 projection contract test passes.

#### A-M06-04 — Pool and venue checks, including `lp_withdrawable_max`

- **Module:** M06 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Implement the pool-level checks of ARCH 8.4 with the program's own withdrawal accounting.
- **Depends on:** A-M06-01, A-M01-05, A-M04-02, A-M08-02 (A-M03-03 removed: parked with D30, card Z-H-OF round 3; `pool_age` uses A-M05-01's proof rule). B: none.
- **Interfaces:** `CheckProvider` implementations; LP distribution snapshot `{ lpMint: Pubkey; lpMintSupply: BaseUnits; holders: Array<{ owner: Pubkey; amount: BaseUnits; escrow: boolean }>; maxWithdrawableBps: number; asOfSlot: Slot }` (NEW, cached 10 min).
- **Logic (check IDs from ARCH 8.4):**
  1. `pool_canonical` (hard): `isCanonical === true` (A-M01-01) [EX-08, TH-18]; `null` → `error`.
  2. `lp_withdrawable_max` (hard): largest share of reserves any single non-escrow holder could withdraw ≤ 5% (POLICY, CA-20). PumpSwap canonical: LP burned at migration [TH-17]; read the LP mint (`jsonParsed`) and `getTokenLargestAccounts(lpMint)` + owners; escrow = accounts owned by the pool program's PDAs; every other holder is non-escrow. Denominator: the program's withdraw computation is not in the register: VERIFY against `PUMP_SWAP_README.md` / pinned IDL; until verified, use the **current LP mint supply** (after burns), which gives the largest possible share and is conservative; never `Pool::lp_supply` (it excludes burns and lock-ups [TH-18]). Third-party lockers are not decoded and are treated as non-escrow (conservative; ARCH 8.4 treats lockers as unlocked at their unlock time). Raydium: per the venue spec only (A-M01-06; CPMM Burn & Earn escrow counts as escrow [TH-20]).
  3. `fee_ceiling` (hard): per-side `totalBps` (A-M01-02 `feeFor`) ≤ the strategy ceiling (MR 30, PM 125).
  4. `min_depth` (hard): effective quote ≥ strategy minimum (MR 300 SOL, PM 85 SOL).
  5. `real_vs_effective_quote` (hard): `quoteReserveReal / effectiveQuote ≥ 0.5` (MR) or `0.6` (PM) [EX-09, EX-V01]; observed in bps.
  6. `pool_age` (hard): MR ≥ 24 h by the proof rule of A-M05-01; PM 20-120 min after the verified migration event [TH-30, ST-10].
  7. `venue_enabled` (hard): A-M01-05 `enabledBuy && enabledSell` (null → `error`) [EX-12, TH-19].
  8. `fee_config_known` (hard): venue quotable and no schedule change in the last 10 min (A-M01-05).
  9. `venue_specified` (hard): PumpSwap yes; Raydium only after A-M01-06; for live, group B's direct sell adapter flag must also be true (read from config `venue.<id>.live_adapter_ready`, owned by B).
  10. `dump_flag`: soft for MR, hard for PM; from M08 `dumpFlagState(pool)` (−4 × MAD rule in the last 30 min [ST-V08]; clarification C-18): `dump` → fail; `insufficient` → `error` for PM, `skipped` with reason for MR.
- **Shared resources and concurrency:** caches owned by M06; LP snapshot re-read every 10 min while a position is open; a change in `maxWithdrawableBps` above threshold publishes `pool.lp_changed { poolId, mint, maxWithdrawableBps, previousBps, atMs }` (consumer B-M20-03 treats it as liquidity collapse, ARCH 8.6; integration fixed this name, CL-33).
- **Config:** `screener.lp.max_withdrawable_bps` (bps, 500, 0-2,000; increases_risk; affectsReturns yes); per-strategy ceilings as in A-M05-01; `screener.real_vs_effective.mr_min_bps` (5,000), `pm_min_bps` (6,000).
- **Edge cases and failure handling:** 1. LP mint supply 0 (fully burned) → `maxWithdrawableBps = 0`, pass. 2. Holder outside escrow with any amount and supply > 0 → share computed; > threshold → fail. 3. LP mint unreadable → `error`.
- **Acceptance criteria:** Given a canonical pool fixture with all LP burned, then `lp_withdrawable_max` passes with observed 0; given a synthetic LP holder at 6% of current supply, then it fails; given `real/effective = 0.49` on an MR candidate, then `real_vs_effective_quote` fails.
- **Tests:** unit per check; fixtures `fx/pumpswap/lp_mint_burned.json`, `fx/pumpswap/lp_largest_accounts.json`; property: `fee_ceiling` passes iff `totalBps ≤ ceiling`.
- **Observability:** `screen_verdict_total{check_id}`; log `M06.lp_changed`.
- **Security notes:** creator-held LP is a known rug path [TH-18]; the check fails closed whenever the denominator or holder set is uncertain.
- **Facts used:** EX-08, EX-09, EX-12, EX-V01, TH-17, TH-18, TH-19, TH-20, TH-30, ST-10, ST-V08, VF-05.
- **Definition of done:** checks merged; denominator VERIFY resolved or the conservative rule documented as active.

#### A-M06-05 — Honeypot round-trip simulation with the simulation payer (D31)

- **Module:** M06 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Prove, before any entry, that a buy of the intended size can be sold back in the same transaction at roughly the modelled cost, using the dedicated simulation payer whose key is never on the host.
- **Depends on:** A-M06-01, A-M10-03 (modelled round-trip cost). B: M16 `TxBuilder.buildSimulationOnly({ payer, mint, poolId, venue, notional, shape: 'buy_then_sell' })`; M22 (the payer's SOL counts in `E`; funding is a `sim_funding` cash flow).
- **Interfaces:** check `honeypot_sim`; `SimPayerStatus { pubkey: Pubkey; balanceLamports: Lamports; requiredLamports: Lamports; ok: boolean; checkedAtMs: UnixMs }` (NEW; exposed to M12 and M28 VM-13 via M27 health).
- **Logic:**
  1. Payer balance check at start and every 10 min: `required = notional_max + 2 × ATA rent + 10,000,000 lamports` (0.01 SOL, POLICY; ARCH M06), with ATA rent from M15 `rentExemptMinimum(<ATA size>)` (Token-2022 ATA 170 bytes with ImmutableOwner [LD-14]; larger for extension mints [LD-V03], which are rejected anyway). Below → `ok = false`, alert `sim_payer_underfunded` (warning), and `honeypot_sim` returns `error` (blocks entries, never exits); paper mode reports the reason instead of silently rejecting everything (CB-02).
  2. Build: M16 `buildSimulationOnly` returns an unsigned message: buy ExactIn for the intended notional, then sell ExactIn of the buy's quoted `minOut` tokens (so the sell never needs tokens the payer does not hold) (ARCH M06).
  3. `simulateTransaction` with `sigVerify: false`, `replaceRecentBlockhash: true`, `commitment: 'confirmed'`, `innerInstructions: true`, and `accounts` = payer, the payer's token ATA and the temporary wSOL account, base64 [TH-46]. Exact config field names: VERIFY against the Solana `simulateTransaction` RPC docs [TH-46].
  4. Outcome: `err` present → map the failing instruction index to buy or sell using A-M02-06 on the message's instructions. Sell-leg failure → `fail`, publish `blacklist(mint, 'honeypot_sell_sim', now + 24 h)` (ARCH M06, 7.5). Buy-leg failure (slippage, account state) → `error` (not proof of a honeypot; no blacklist).
  5. Success → round-trip return: `retained = payerLamportsPost + ataLamportsPost (refundable rent) + wsolLamportsPost`; `pre` = the payer balance read in the same `getMultipleAccounts` cycle just before simulating; `loss = pre − retained (+ fee if the simulated post balances exclude the fee; VERIFY)`; `ratioBps = 10,000 × (notional − loss) / notional`. Pass iff `ratioBps ≥ 10,000 − modelled round-trip cost bps (A-M10-03) − 100` (ARCH 8.4). Observed and threshold are reported in bps.
  6. Cache 10 min per `(mint, pool, notional bucket)`; `pre_entry` uses cache if fresh; M20's cannot-sell rule (2 consecutive failed combined sell simulations, ARCH 8.6) consumes the results of `pre_exit` screens requested with `withSellSim: true` (C-43); those simulations bypass the 10-minute cache.
- **Shared resources and concurrency:** the simulation payer's on-chain balance is read-only for M06; funding is an operator action. Simulations are P3 on the unmetered provider; at most `screener.sim.max_concurrent` (default 2).
- **Config:** `screener.sim.payer_pubkey` (Pubkey, required; validation: must not equal the hot wallet); `screener.sim.buffer_lamports` (10,000,000); `screener.sim.tolerance_bps` (100, 0-500; increases_risk); `screener.sim.max_concurrent` (2, 1-4).
- **Edge cases and failure handling:** 1. Simulation RPC error → `error`. 2. Simulation succeeds but the token ATA shows a non-zero token balance after the sell (fee-on-transfer or partial) → `fail` (the round trip did not sell everything bought minus the planned remainder; VERIFY expected remainder = bought − minOut). 3. Payer key accidentally present on host (config equals hot wallet) → validation error. 4. Venue paused → both legs fail → `error` plus A-M01-05 status.
- **Acceptance criteria:** Given a mainnet simulation of a liquid canonical pool at 0.07 SOL notional, then the check passes with `ratioBps` within 50 bps of the model; given a synthetic transfer-hook token on devnet (or a mocked simulation result with a sell-leg error), then `fail` and a 24 h blacklist; given an underfunded payer, then `error` with reason `sim_payer_underfunded`.
- **Tests:** integration on mainnet state, read-only, unsigned [TH-46] (`fx/sim/roundtrip_ok.json`, `fx/sim/sell_leg_error.json` as recorded responses); unit for ratio math; failure injection: payer balance below requirement.
- **Observability:** metrics `sim_payer_balance_lamports`, `honeypot_sim_total{status}`, `honeypot_ratio_bps` (histogram); alert `sim_payer_underfunded`.
- **Security notes:** the payer's private key never exists on the host (D31); simulation is unsigned; nothing here can move funds.
- **Facts used:** TH-46, LD-13, LD-14, LD-V03.
- **Definition of done:** check live in research/paper; P-6 (A-M12-02) reuses the same payer path.

#### A-M06-06 — Vendor soft checks and authority re-check publishing

- **Module:** M06 · **Phase:** 1 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Add cached, asynchronous vendor cross-checks that can never accept a token on their own, and publish authority changes for open positions.
- **Depends on:** A-M06-01, A-M14-03. B: M20 consumes `token.authority_changed`.
- **Interfaces:** checks `insider_network` (soft), `rugcheck_risks` (soft), `jupiter_audit` (soft); event `token.authority_changed { mint, changes: RiskCheck[], detectedAtMs }`.
- **Logic:**
  1. RugCheck public `GET /v1/tokens/{id}/report/summary` (no security requirement; fields `score`, `score_normalised`, `risks[]`, `lpLockedPct`, `tokenProgram` [TH-21]) and `GET /v1/tokens/{id}/insiders/graph` [TH-V03] (response shape VERIFY against the RugCheck swagger). Rate: header `x-rate-limit-limit: 15` with an undocumented window [TH-21]; M14 budgets it as 15 per minute. Cached 30 min.
  2. Jupiter Tokens API v2 audit fields (`isSus`, `mintAuthorityDisabled`, `freezeAuthorityDisabled`, `topHoldersPercentage`, all conditional [TH-27]); path and key requirement VERIFY against Jupiter docs [TH-27]; shares Jupiter's bucket and is suspended while exits are in flight (A-M14-03).
  3. Soft-check semantics: vendor flags are never the only reason to accept (D13); when vendor data and on-chain reads disagree, the chain wins (example: GoPlus `closable` vs the Token-2022 processor [TH-11]). Unavailable vendor → `skipped` with reason (ARCH M06 failure table). No accuracy benchmark exists for these flags (excluded claim A-26).
  4. While a position is open: run `authorityRecheck` every `screener.ttl.authorities_ms` and on every `pre_exit`; on `changed = true` publish `token.authority_changed` and blacklist the mint permanently (ARCH 7.5) → M20 immediate exit (ARCH 8.6).
- **Shared resources and concurrency:** vendor caches owned by M06; vendor calls P4.
- **Config:** `screener.vendor.rugcheck.enabled` (true); `screener.vendor.jupiter_audit.enabled` (true); `screener.vendor.max_calls_per_min.rugcheck` (15, 1-15).
- **Edge cases and failure handling:** 429 → `skipped`; malformed JSON → `skipped`; vendor says "danger" while all hard checks pass → soft `fail` (may reduce size in M21), never a hard reject unless the operator configures it.
- **Acceptance criteria:** Given RugCheck returning 429, then the check is `skipped` and the verdict unchanged; given an authority change during an open position (fixture pair before/after), then exactly one `token.authority_changed` is published within one re-check interval.
- **Tests:** fixtures `fx/rugcheck/summary_sample.json`, `fx/rugcheck/insiders_graph_sample.json` (captured after VERIFY), `fx/jupiter/tokens_v2_audit.json`; failure injection: vendor down.
- **Observability:** `vendor_calls_total{vendor,status}`; log `M06.authority_changed` (critical alert raised by M20/M27).
- **Security notes:** vendor responses are untrusted JSON (size-capped 256 KB, schema-validated); no personal data is sent (mint addresses only).
- **Facts used:** TH-11, TH-21, TH-22, TH-27, TH-V03.
- **Definition of done:** soft checks merged and visible in VM-07 as `warn`/`skipped`; authority re-check event consumed by an M20 test double.

### M07 Market data recorder

#### A-M07-01 — Recorder queue and change-only delta encoding

- **Module:** M07 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Accept records from every producer without ever blocking them, write pool snapshots only when the pool's state changed, and record exactly what was dropped and why.
- **Depends on:** none (payload types from A-M04-01 at integration). B: M19/M23 append order and fill events (consumers of `Recorder.append`).
- **Interfaces (ARCH M07, plus NEW stream catalogue):**

```ts
interface RecordEnvelope { stream: string; seq: bigint; recvMs: UnixMs; slot: Slot | null; commitment: Commitment | null; source: string; payload: unknown }
interface Recorder { append(e: Omit<RecordEnvelope, 'seq'>): void /* non-blocking, bounded queue; seq assigned by M07 */;
  rotate(): Promise<SegmentManifest>; coverage(dayUtc: string): CoverageReport }
type StreamName = 'order_event' | 'fill' | 'universe_manifest' | 'coverage' | 'venue_config' | 'pool_snapshot_position'
  | 'decision' | 'signal' | 'screen' | 'pool_snapshot' | 'poll_counts' | 'discovery' | 'pumpportal_notice' | 'pool_snapshot_tail';   // NEW, in drop-priority order (first = never dropped)
```

- **Logic:**
  1. `append` validates the envelope (stream known, payload JSON-serialisable with bigints as decimal strings), assigns a per-stream monotonic `seq` (bigint; continued after restart from the last manifest's `lastSeq + 1`), and pushes to a bounded queue (`recorder.queue_max`, default 50,000 records, ARCH M07). It never awaits I/O.
  2. Pool snapshots (stream chosen by M04 priority class): keep, per pool, the last written `rawHash` and decoded fields. If `rawHash` is unchanged since the last written record → do not write; increment the per-pool per-minute counters `{ successfulPolls, changedPolls, failedPolls }`. If changed → write a **delta** against the last written state (only changed fields), except the first record for a pool in each hourly segment, which is a full keyframe so every segment decodes on its own.
  3. Every minute, write one `poll_counts` record per watched pool `{ poolId, minuteStartMs, successfulPolls, changedPolls, failedPolls, priorityClass }`; replays use it to know whether "no record" meant "unchanged" or "not observed" (A-M08-01, A-M11-03).
  4. Backpressure: when the queue is full, drop from the lowest-priority stream first (end of the `StreamName` list), never `order_event`, `fill`, `universe_manifest`, `coverage` or `venue_config`; record a gap `{ fromMs, toMs, reason: 'backpressure' }` on each affected stream; alert warning (ARCH M07).
  5. Payload size cap 64 KB per record (`pumpportal_notice` raw capped earlier by M03).
- **Shared resources and concurrency:** M07 owns segments and manifests (ARCH 7.2: single writer queue, `(stream, seq)` identity). The queue is drained by one writer loop.
- **Config:** `recorder.queue_max` (count, 50,000, 1,000-500,000); `recorder.record_max_bytes` (bytes, 65,536).
- **Edge cases and failure handling:** 1. Unserialisable payload → rejected with `E_PAYLOAD` (producer bug), counted. 2. Clock going backwards (NTP step) → `recvMs` recorded as is; `seq` remains the ordering key. 3. Restart → keyframes re-emitted for every pool on first change.
- **Acceptance criteria:**
  - Given a pool polled 3,600 times in an hour with 40 state changes, then 40 snapshot records (1 keyframe + 39 deltas) and 60 `poll_counts` records are written.
  - Given a full queue with mixed streams, then no `order_event` or `fill` record is ever dropped and every dropped stream has a `backpressure` gap.
- **Tests:** unit (delta encode/decode round trip; property test: decoding the keyframe and deltas reproduces every written state exactly); failure injection: producer flood at 10× capacity.
- **Observability:** metrics `recorder_queue_depth`, `recorder_records_total{stream,written}`, `recorder_dropped_total{stream}`, `recorder_gap_seconds_total{stream}`; log `M07.backpressure` (warning).
- **Security notes:** payloads must contain no secrets (M27 redaction schema applied to envelope fields); untrusted strings stored as JSON strings only.
- **Facts used:** none (internal design; budget figures from ARCH M07 are DERIVED there).
- **Definition of done:** queue and encoder merged; round-trip property test green.

#### A-M07-02 — Segment writer, manifests and crash recovery

- **Module:** M07 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Write hourly compressed NDJSON segments with a manifest per segment (records, slot range, SHA-256, gaps), recoverable after a crash.
- **Depends on:** A-M07-01. B: none.
- **Interfaces (ARCH M07, manifest extended with NEW fields `codec`, `firstSeq`, `lastSeq`, `hourUtc`, `keyframes`):**

```ts
interface SegmentManifest { path: string; stream: string; firstSlot: Slot | null; lastSlot: Slot | null; records: number; bytes: number;
  sha256: string; gaps: Array<{ fromMs: UnixMs; toMs: UnixMs; reason: string }>;
  codec: 'zstd' | 'gzip'; firstSeq: bigint; lastSeq: bigint; hourUtc: string; keyframes: number }
```

- **Logic:**
  1. Path `/var/lib/zeroed-md/YYYY-MM-DD/HH/<stream>.ndjson.zst` (ARCH 4.5; was `/data/md` (PATHS-FIX, `docs/research/DISK-BUDGET.md` §2.9: the engine's unit can write only its state folder and its `ReadWritePaths`; `packages/engine/src/paths.ts`)). Codec: zstd through Node's built-in `node:zlib` if the chosen LTS provides it (VERIFY against the Node docs for that LTS, together with A-18); otherwise gzip from `node:zlib` with extension `.ndjson.gz` (clarification C-17). No third-party compression library (dependency policy, ARCH 12.3). `codec` is recorded in every manifest.
  2. Flush a complete compressed frame (zstd frame or gzip member) every `recorder.flush_ms` (default 10 s) and `fsync`, so a crash loses at most that interval.
  3. Rotate at each UTC hour boundary (and on demand via `rotate()`): flush, `fsync`, compute SHA-256 of the file, write `<stream>.manifest.json` atomically (temp file, `fsync`, rename, `fsync` directory), append the manifest to the day's index `/var/lib/zeroed-md/YYYY-MM-DD/index.json` (PATHS-FIX ruling 21).
  4. Startup recovery: for each segment without a manifest, decode frame by frame, truncate after the last complete frame, write the manifest with a gap `{ fromMs: lastRecordMs, toMs: restartMs, reason: 'crash' }`.
  5. Downtime between the last segment and the start of recording is a gap `reason: 'process_down'` on every stream.
- **Shared resources and concurrency:** file system under `/var/lib/zeroed-md` owned by M07 (user `bot`, group `zeroed-pull`, mode 2750 made by the installer; M07 creates folders 0750 and files 0640 so the pull group can read them under the unit's `UMask=0077`); one writer. Manifests are immutable after writing.
- **Config:** `recorder.data_dir` (string, `/var/lib/zeroed-md`); `recorder.flush_ms` (duration_ms, 10,000, 1,000-60,000); `recorder.codec_preference` (`zstd` | `gzip`, `zstd`).
- **Edge cases and failure handling:** 1. `fsync` failure → alert critical; stop market-data streams (journal writes in SQLite have priority, ARCH M07). 2. Disk full mid-write → same, plus the A-M07-03 thresholds. 3. Hour rotation during a burst → records carry their `recvMs`; a record belongs to the segment open when it was dequeued, and the manifest's slot range reflects actual content.
- **Acceptance criteria:**
  - Given `kill -9` of the engine mid-hour, when it restarts, then the partial segment decodes up to its last flushed frame, gets a manifest with a `crash` gap, and no record is duplicated across the restart.
  - Given any segment and its manifest, then `sha256(file) == manifest.sha256` and `records` equals the decoded line count.
- **Tests:** integration on a temp directory; failure injection: kill during write, disk-full simulation (small tmpfs), fsync error injection.
- **Observability:** metrics `recorder_segment_bytes{stream}`, `recorder_rotate_ms`; log `M07.segment_rotated` (stream, records, sha256), `M07.crash_recovered`.
- **Security notes:** segment files readable by the `bot` user and the operator's pull account only; no secrets inside.
- **Facts used:** VF-08 (zstd availability on Node 24; the gzip fallback stays).
- **Definition of done:** 48 h soak in Phase 0 with zero manifest mismatches; codec VERIFY recorded in `DEPENDENCIES.md`.

#### A-M07-03 — Coverage reports, disk management and verified-pull deletion

- **Module:** M07 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Produce the daily `CoverageReport` that gates rely on, and delete host segments only after the operator's machine has verified them by SHA-256.
- **Depends on:** A-M07-02. B: M27 alerts.
- **Interfaces (ARCH 5.0a `CoverageReport`; NEW receipt format and pull tool):**

```ts
interface CoverageReport { dayUtc: string; streams: Array<{ stream: string; expected: number; recorded: number; gaps: Array<{ fromMs: UnixMs; toMs: UnixMs; reason: string }> }>;
  universeManifestSha256: string; lowCoverage: boolean }
interface PullReceipt { path: string; sha256: string; verifiedAtMs: UnixMs; verifier: string /* operator machine label */; signatureB64: string /* Ed25519, research key */ }   // NEW
// operator-side CLI (part of this ticket): `md-pull --host <tailnet-name> --since <day>` → downloads, verifies, writes receipts
```

- **Logic:**
  1. At 00:00 UTC, after the universe manifest (A-M05-03): for `pool_snapshot*` streams, `expected` = scheduled polls for every watched pool-second of the day (from M04's schedule history), `recorded` = successful polls (from `poll_counts`); gaps merged from manifests (`backpressure`, `crash`, `process_down`, `degraded`). `lowCoverage = true` when the gap time exceeds 5% of watched pool-time (ARCH M07). Written as stream `coverage` and kept in SQLite through M24 for M13 (clarification C-14 lists the table need).
  2. Disk monitor every 60 s on the filesystem holding `recorder.data_dir`: > 80% → delete the oldest segments **that have a valid `PullReceipt` whose `sha256` equals the manifest's**; > 95% → stop all M07 streams except `universe_manifest` and `coverage`, alert critical (trading continues; journal writes have priority) (ARCH M07). Segments older than `recorder.retention_days` (30) are deleted only with a valid receipt; without one they are kept and an alert raised daily.
  3. Shared helper package `@bot/canon` (created here, Node built-ins only): `canonicalJson(v)` (rules in A-M11-05 step 1) and Ed25519 `sign`/`verify` with the research key; reused by A-M11-05 bundles and A-M13-02 keys.
  4. Receipts: the operator-side `md-pull` tool (shipped in this ticket; uses only OpenSSH `sftp` and Node built-ins) downloads day directories over the tailnet, recomputes SHA-256 for every segment, and for each match writes a `PullReceipt` signed with the research Ed25519 key (the same key M11 uses for run bundles; Ed25519 support in Node's built-in `crypto` is VERIFY item A-18), then uploads receipts to `/var/lib/zeroed-md/receipts/` (2770, group `zeroed-pull`, the only folder the pull account may write; the pull account `zeroed-pull` is sftp only, chrooted to `/srv/zeroed_pull`, with `md` bound read-only and `md/receipts` read-write; anything there that is not a valid receipt is deleted and alerted on, PATHS-FIX ruling 17). M07 verifies each receipt with the research public key from the root-owned config before honouring it.
  5. The operator's copy is never deleted by the tool while any day belongs to an open evaluation window (`W_B`, `W_R`) recorded in M13's stage records (the tool reads them from an exported windows file).
- **Shared resources and concurrency:** receipts directory written by the operator's account, read by M07; deletion only by M07.
- **Config:** `recorder.retention_days` (int days, 30, 7-365); `recorder.disk_warn_pct` (80); `recorder.disk_stop_pct` (95); `recorder.research_pubkey` (from root-owned config, read-only).
- **Edge cases and failure handling:** 1. Invalid or forged receipt → ignored, alert `security` warning. 2. Disk > 95% with no receipts → recording stops; nothing is deleted without a receipt. 3. Coverage computation for a day with no watched pools → `expected = 0`, `lowCoverage = true` (cannot support a gate).
- **Acceptance criteria:**
  - Given a day with a 2 h outage of polling, then `lowCoverage = true` (2 h > 5% of 24 h).
  - Given disk at 81% and two old segments, one with a valid receipt, then only that one is deleted.
  - Given a receipt signed with a different key, then the segment is not deleted.
- **Tests:** unit for coverage arithmetic; integration with a temp filesystem; security test: forged receipt.
- **Observability:** metrics `disk_free_bytes{mount="/data"}`, `md_receipts_total{valid}`, `coverage_gap_bps{day}`; alerts "Disk" (ARCH 13.4).
- **Security notes:** deletion is guarded by a signature from a key not on the host, so a host compromise cannot fake a verified pull (it could still delete files directly, which this does not claim to prevent).
- **Facts used:** none (internal).
- **Definition of done:** coverage report daily in Phase 0; `md-pull` used at least once end-to-end before Phase 0 exits.

### M08 Feature and bar engine

#### A-M08-01 — 15-second bar builder

- **Module:** M08 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Deterministically turn pool snapshots into 15 s bars (prices from effective reserves, depth, net quote flow, completeness), identically in live, paper, backtest and replay.
- **Depends on:** A-M04-01, A-M01-03. B: none.
- **Interfaces (ARCH M08):**

```ts
interface Bar { poolId: Pubkey; startMs: UnixMs; durationMs: 15_000 | 60_000;
  open: DecimalStr; high: DecimalStr; low: DecimalStr; close: DecimalStr;          // SOL per whole token, from effective reserves
  depthLamportsClose: Lamports; depthChangeBps: Bps; netQuoteFlowLamports: SignedLamports;
  snapshots: number; missing: number }
interface BarEngine {                                                                 // NEW (owner-side API)
  onSnapshot(s: PoolSnapshot, expectedIntervalMs: number): void;     // live (M04 topic) or replay feed
  onPollCounts(r: { poolId: Pubkey; minuteStartMs: UnixMs; successfulPolls: number }): void;   // replay of unchanged polls
  closeDue(nowMs: UnixMs): Bar[];                                       // driven by the injected Clock
  isComplete(b: Bar): boolean;                                          // missing / expected ≤ 20%
}
// publishes 'bar.closed' (Bar)
```

- **Logic:**
  1. Bars align to multiples of 15,000 ms of `observedAtMs` (the snapshot's receipt time on the wall or sim clock).
  2. Price per snapshot = `spotSolPerToken` from M04 (effective quote / base, decimals applied; A-M01-03). OHLC compared as exact rationals (bigint numerator/denominator), rendered as `DecimalStr` with 24 fractional digits truncated.
  3. `depthLamportsClose` = effective quote at the last snapshot; `depthChangeBps` = `round_toward_zero((close_depth / open_depth − 1) × 10,000)`; `netQuoteFlowLamports` = sum of changes in **real** quote vault balance between consecutive snapshots, starting from the previous bar's last snapshot (real SOL in or out; virtual changes such as boost [EX-V01] are excluded) (clarification C-19). Gross volume is not derivable from snapshots (ARCH M08 note).
  4. `snapshots` = successful polls in the bar (live: snapshots received; replay: from `poll_counts`, distributing a minute's count to its four bars by recorded timestamps of changed snapshots, and evenly for unchanged polls; the replay rule is fixed and tested so live and replay agree within ±1). `expected = durationMs / expectedIntervalMs` (15 at 1 Hz, 30 at 2 Hz). `missing = max(0, expected − snapshots)`.
  5. A bar with zero snapshots is not emitted (gap); features see the gap. `isComplete` = `missing / expected ≤ 0.2`; strategies must not emit entries on incomplete bars (ARCH M08), enforced again in M09.
  6. Bars close when the clock passes `startMs + 15,000 + bars.close_grace_ms` (default 1,500 ms) so a late snapshot of the bar is still included; deterministic in replay because the sim clock drives `closeDue`.
- **Shared resources and concurrency:** M08 owns rolling windows per pool (ARCH 7.2). Single-threaded; no I/O.
- **Config:** `bars.close_grace_ms` (duration_ms, 1,500, 0-5,000; affectsReturns yes); `bars.incomplete_missing_bps` (bps, 2,000, 0-5,000; affectsReturns yes; increasing it increases risk).
- **Edge cases and failure handling:** 1. Snapshot older than the current open bar (late beyond grace) → dropped and counted. 2. Pool quarantined → bars stop. 3. Price decimals unknown → no bar (cannot render whole-token price), counted as `bar_skipped{reason="decimals"}`.
- **Acceptance criteria:**
  - Given a recorded hour of snapshots, then bars built live and bars rebuilt in replay from the recorded deltas plus `poll_counts` are identical in OHLC, depth and flow, and differ in `snapshots` by at most 1 per bar.
  - Given a bar with 11 of 15 snapshots, then `missing = 4` and `isComplete = false` (26.7% > 20%).
- **Tests:** unit; property test: high ≥ max(open, close) and low ≤ min(open, close); golden replay-vs-live test on `fx/md/one_hour_pool_snapshot_segment.ndjson.gz` with its `poll_counts`.
- **Observability:** metrics `bar_missing_ratio{pool}`, `bars_closed_total{complete}`; log none per bar (too noisy).
- **Security notes:** none.
- **Facts used:** EX-09, EX-V01.
- **Definition of done:** bar engine used in the Phase 0 recorder and by A-M13-01's study; live/replay equality test green.

#### A-M08-02 — Features: robust z-score, rolling median, MAD scale, dump flag, basket return

- **Module:** M08 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** The exact feature functions MR-01, PM-01, the screener and the risk engine's regime filter use.
- **Depends on:** A-M08-01. B: M21 consumes `basketReturn` (REGIME filter, ARCH 8.1).
- **Interfaces (ARCH M08, plus one NEW tri-state accessor):**

```ts
interface Features { robustZ(poolId: Pubkey, lookbackMs: number): number | null; rollingMedian(poolId: Pubkey, windowMs: number): DecimalStr | null;
  madScale(poolId: Pubkey, windowMs: number): number | null; dumpFlag(poolId: Pubkey): boolean /* −4 × MAD rule [ST-V08] */;
  basketReturn(windowMs: number): number | null;
  dumpFlagState(poolId: Pubkey): 'dump' | 'clear' | 'insufficient' }                 // NEW (clarification C-18)
```

- **Logic (all from **complete** 15 s bars; log returns use the bar close price converted to a double only for features, never for accounting):**
  1. 15 s log returns `r_i = ln(close_i / close_{i−1})` for consecutive bars; a gap (missing bar) breaks the chain (the return across a gap is not used).
  2. `madScale(pool, W)` = `MAD(r over the last W) / 0.67449` (the Gaussian-consistent scale used by the dump detector [ST-V08]); `null` when fewer than `features.min_coverage_bps` (default 5,000 = 50%) of the expected returns in W exist, or MAD = 0.
  3. `robustZ(pool, L)` = `ln(close_now / close_{now−L}) / (madScale(pool, 6 h) × s)` where `s = sqrt(L / 15 s)` when `features.robust_z_scaling = 'sqrt_time'` (default) or `s = 1` when `'none'`. ARCH 3.3 defines the scale as MAD/0.67449 of the 15 s returns over 6 h but does not say whether the L-period return is rescaled; the choice changes which events trigger entries, so it is an `affectsReturns` config key that must be fixed **before** MR-01's configurations are pre-registered (clarification C-20). `null` if either endpoint bar is missing or the scale is null.
  4. `rollingMedian(pool, W)` = median of complete bar closes in W (exact rational median of `DecimalStr`s; for an even count the lower middle element, to stay exact and deterministic).
  5. `dumpFlagState(pool)`: baseline = 15 s returns from `now − 6 h` to `now − 30 min`; σ = MAD/0.67449 of the baseline; `dump` if any return in the last 30 min is below `−4 × σ` [ST-V08]; `insufficient` if σ is null; else `clear`. `dumpFlag()` returns `dumpFlagState() === 'dump'`.
  6. `basketReturn(W)`: equal-weight mean of `ln(close_now / close_{now−W})` over all **watched** pools (not tail pools) with complete bars at both ends; `null` if fewer than `features.basket_min_pools` (default 3) qualify. The risk engine should treat `null` as "regime unknown → block MR entries" (recommendation to M21, clarification C-21).
  7. Determinism: identical inputs give bit-identical doubles (no parallel reductions; fixed iteration order by bar time).
- **Shared resources and concurrency:** M08 owns rolling windows; pure computations over them.
- **Config:** `features.robust_z_scaling` (`sqrt_time` | `none`, default `sqrt_time`; affectsReturns yes; must be frozen at pre-registration); `features.min_coverage_bps` (5,000; affectsReturns yes); `features.basket_min_pools` (3, 1-30; affectsReturns yes); `features.median_window_ms` (21,600,000); `features.dump_window_ms` (1,800,000).
- **Edge cases and failure handling:** 1. Price of 0 (cannot occur with positive reserves) → feature `null`. 2. Very sparse pools → `null` features → strategies emit nothing. 3. A pool re-watched after eviction → windows restart from available bars.
- **Acceptance criteria:**
  - Given a synthetic series with a −5σ 15 s return 10 minutes ago, then `dumpFlagState = 'dump'`; 31 minutes ago → `clear`.
  - Given a pool with 40% of expected returns in the 6 h window, then `madScale = null` and `robustZ = null`.
  - Given 2 qualifying pools, then `basketReturn = null`.
- **Tests:** unit with hand-computed vectors; property: `robustZ` sign equals the sign of the L-period return; determinism test (two runs, bitwise equal); replay of `fx/md/one_day_bars.ndjson.gz`.
- **Observability:** metrics `features_null_total{feature}`, `dump_flags_active`; log none.
- **Security notes:** none.
- **Facts used:** ST-V08, ST-04.
- **Definition of done:** features merged; the scaling choice recorded in the MR-01 pre-registration (A-M09-02).

#### A-M08-03 — `bar_1m` persistence and OHLC aggregation for VM-10

- **Module:** M08 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Persist 1-minute bars for 90 days and serve 1m/5m/1h/1d OHLC to the dashboard (15 s bars are never served, CB-15).
- **Depends on:** A-M08-01. B: M24 `bar_1m` table (ARCH 15); M28 VM-10 projection (consumer).
- **Interfaces:**

```ts
interface BarStore {                                                                  // NEW
  ohlc(poolId: Pubkey, resolution: '1m' | '5m' | '1h' | '1d', fromMs: UnixMs, toMs: UnixMs):
    { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; gaps: Array<{ fromMs: number; toMs: number; reason: string }> };   // display-only numbers (UI convention 3)
}
```

- **Logic:** 1. Build 60 s bars from the same snapshots as A-M08-01 (`durationMs: 60_000`). 2. Once per minute write all closed 1-minute bars in one SQLite transaction: `(pool_id, minute, open, high, low, close, close_depth_lamports, snapshots)` (ARCH 15). 3. Aggregation for 5m/1h/1d on read: open of first, close of last, max/min; gaps from missing minutes and M07 coverage gaps. 4. Prices converted to doubles only in the response (VM-10 exception: display-only, `|v| < 2^53` asserted). 5. Daily purge of rows older than 90 days (POLICY).
- **Shared resources and concurrency:** M08 is the only writer of `bar_1m`; readers via M28.
- **Config:** `bars.bar_1m_retention_days` (90, 7-365).
- **Edge cases and failure handling:** DB write failure → retry next minute (bars kept in memory up to 10 minutes), then dropped with an M07-style gap.
- **Acceptance criteria:** Given 60 consecutive 1m bars, then the 1h aggregate equals the open of the first, the close of the last and the max/min of all.
- **Tests:** unit for aggregation; integration with M24 test database.
- **Observability:** `bar_1m_rows_written_total`; `bar_1m_purged_total`.
- **Security notes:** none.
- **Facts used:** none (internal).
- **Definition of done:** VM-10 `price_ohlc` contract test (with M28 test double) passes for all four resolutions.

### M09 Strategy runtime

#### A-M09-01 — Strategy runtime host

- **Module:** M09 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Host pre-registered strategy plugins, run them identically in every mode, and turn their output into `SignalProposal`s with an exit plan, while isolating failures and enforcing purity.
- **Depends on:** A-M08-02. B: M20 (position lookup for `ctx.position`), M21 (consumer of `signal.proposal`), M25 (`Config`), M13 via A-M13-05 (stage) and A-M13-04 (edge estimate) at integration.
- **Interfaces (ARCH M09 and 5.0a, plus NEW runtime API):**

```ts
interface SignalProposal { candidateId: Id; strategyId: string; strategyVersion: string; mint: Pubkey; poolId: Pubkey;
  side: 'buy'; score: DecimalStr; scoreUnit: 'zscore' | 'probability_bps'; decisionSlot: Slot; decisionMs: UnixMs;
  requestedNotionalLamports: Lamports; expectedEntrySolPerToken: DecimalStr; exitPlan: ExitPlan; featuresHash: string }
interface ExitPlan { stopBps: Bps /* negative, e.g. −400 */; targetBps: Bps | null; trailingBps: Bps | null;
  targetPriceSolPerToken: DecimalStr | null; timeStopMs: number; maxExitSlippageBps: Bps }
interface Strategy { id: string; version: string; params: Readonly<Record<string, number | string>>;
  onBar(ctx: StrategyContext, bar: Bar): SignalProposal[]; sizing(ctx: StrategyContext, p: SignalProposal): Lamports }
interface StrategyRuntime {                                                             // NEW
  register(s: Strategy, meta: { enabledModes: Mode[]; universe: { feeCeilingBps: Bps; minDepthLamports: Lamports; minAgeMs: number } }): void;
  onBarClosed(b: Bar): void;                                    // from 'bar.closed'
  status(): Array<{ strategyId: string; version: string; paramsHash: string; enabled: boolean; disabledReason: string | null; modes: Mode[] }>;   // VM-03 strategies[]
}
function kellyFractionLowerBound(e: { lowerCiNetBps: number | null; varianceBps2: number | null }): number;   // NEW helper; 0 when lower ≤ 0 or unknown
// publishes 'signal.proposal' (SignalProposal)
```

- **Logic:**
  1. Registry: `(id, version, paramsHash = sha256(canonical JSON of params))`; registering the same `(id, version)` with different params is refused (`E_PARAMS_CHANGED`: a new version is required, so trial identity holds, ARCH 3.4).
  2. On each closed bar of a watched pool, for each enabled strategy whose universe includes the pool: build a `StrategyContext` (`clock`, a per-run seeded `rng`, `mode`, `runId`, frozen `config` snapshot, `features` wrapped in a recording proxy, `position(poolId)` from M20, `edgeEstimate` from M13 in live modes only, else `{ lowerCiNetBps: null, varianceBps2: null }`).
  3. Drop the bar for entries if `!isComplete(bar)` (ARCH M08 rule, enforced here too). Call `onBar` inside try/catch with a time measurement.
  4. For each returned proposal: verify `side = 'buy'`, `poolId` and `mint` match the bar's pool, `exitPlan.stopBps < 0`, `timeStopMs > 0`, at most one proposal per pool per bar; fill `candidateId` (M05 `candidate(poolId)`), `decisionSlot` (the providerSlot of the bar's last snapshot), `decisionMs = clock.nowMs()`, `featuresHash` = SHA-256 of the canonical JSON of every feature call (name, arguments, result) the plugin made for this bar (recorded by the proxy); `requestedNotionalLamports = sizing(ctx, p)`. Invalid proposals are dropped with reason and counted.
  5. Mode and stage gate (defence in depth; M26 is authoritative): in `live_small` emit only for strategies whose M13 stage is `live_small` or `live`; in `live` only `live`; in `paper` any enabled strategy (trades before `replay_passed` are labelled `shadow` downstream, ARCH 3.4); in backtest/replay (M11) the strategy under test only.
  6. `kellyFractionLowerBound`: `max(0, lowerCiNetBps / varianceBps2)` using the continuous-time approximation (ASSUMPTION; not in the register; verify against the Kelly references [ST-38] before live sizing is enabled). Live sizing per D21 = `0.1 × fraction × E`, capped by M21 (ARCH 3.5). Returns 0 when inputs are null, so live sizing cannot run without an edge estimate.
  7. Plugin throws → strategy disabled for the run (`enabled = false`, `disabledReason`), alert critical, no further entries; open positions keep their exit plans (M20 owns them) (ARCH M09).
  8. Each accepted proposal is published and recorded (M07 stream `signal`); M05 moves the candidate to `signalled`.
- **Shared resources and concurrency:** M09 owns the strategy registry and per-strategy internal state (ARCH M09). Runs synchronously on the event loop per bar; plugins get frozen inputs.
- **Config:** `strategy.<id>.enabled_modes` (list of Mode; adding `live_small`/`live` is A3); `strategy.<id>.params.*` (affectsReturns yes); `strategy.runtime.onbar_warn_ms` (duration_ms, 50, 5-1,000).
- **Edge cases and failure handling:** 1. Plugin returns a proposal for another pool → dropped (`E_POOL_MISMATCH`), counted, warning. 2. Plugin mutates the context (frozen objects throw) → treated as a throw. 3. Plugin exceeding `onbar_warn_ms` repeatedly (10 times in 1 h) → warning alert; not disabled (time is measured, not enforced). 4. Strategy stage changes while a bar is processed → the stage read at the start of processing applies.
- **Acceptance criteria:**
  - Given a plugin that throws on its 3rd bar, then it is disabled, a critical alert is raised, and no proposal from it appears afterwards.
  - Given an incomplete bar, then no proposal is emitted.
  - Given the same recorded bars and seed twice, then the emitted proposals (including `featuresHash`) are byte-identical.
  - Given a strategy whose stage is `paper_passed` while the mode is `live_small`, then no proposal is emitted.
- **Tests:** unit with fake strategies (random-buy known-answer strategy, throwing strategy, lookahead-cheating strategy for the M11 no-lookahead test, ARCH 16.4); determinism test.
- **Observability:** metrics `signals_total{strategy}`, `proposal_dropped_total{reason}`, `strategy_onbar_ms{strategy}` (histogram); log `M09.strategy_disabled` (critical).
- **Security notes:** strategy packages may import only `@bot/types` and the features API (lint rule: no I/O modules, no `Date`, no `Math.random`).
- **Facts used:** ST-38, ST-39.
- **Definition of done:** runtime merged; VM-03 `strategies[]` fields available through M28's projection test double.

#### A-M09-02 — MR-01 strategy plugin (BLOCKED: MR-01 parked, owner 2026-10-08, C-76)

**Parked (C-76; owner, 2026-10-08 about 7:31 AM: "I see. Sure insert mr 01 as my future strategy").** This ticket is not built: no plugin, no PREREG, no trades in any mode. It stays on file as MR-01's record. A revised MR version enters only through the M09 strategy slot under a new id or version, as its own ticket, pre-registered and tested on data it was not tuned on (ARCH D08); until then MA-0c cannot unblock this ticket.

- **Module:** M09 · **Phase:** 1 · **Size:** S (≈ 1 engineer-day once unblocked)
- **Status:** **Blocked.** ARCH 3.2-3.3 makes the A-24 count and the A-24b move-size study (A-M13-01) a precondition for writing this ticket. This entry fixes only what ARCH already fixes; the full Logic, thresholds beyond those below, and acceptance tests are completed after MA-0c and reviewed before any code is written.
- **Goal:** Implement MR-01, short-horizon mean reversion on deep, low-fee PumpSwap pools, exactly as pre-registered, so that its two configurations can be evaluated by gates B and R and can fail honestly.
- **Depends on:** A-M09-01, A-M13-01 (accepted report), A-M13-02 (pre-registration). B: M21 (applies `ENTRYRATE`, `REGIME`, sizing caps).
- **Interfaces:** `Strategy` (A-M09-01) with `id = 'mr01'`, `scoreUnit = 'zscore'`.
- **Logic (fixed by ARCH; may not change without a new strategy version and new trials; the remaining steps are written when the ticket is unblocked):**
  1. Universe: PumpSwap canonical pools with per-side fee ≤ 30 bps (market cap ≥ 98,240 SOL [EX-07]), effective depth ≥ 300 SOL, pool age ≥ 24 h, all M06 checks pass; Raydium only after A-M01-06 and D18's stage rules.
  2. Data: 15 s bars from 1 Hz confirmed snapshots.
  3. Signal: robust z of the log return over `L` with scale MAD/0.67449 of 15 s returns over the previous 6 h (A-M08-02, with `features.robust_z_scaling` frozen at pre-registration, C-20); entry when `z ≤ −z_entry`, depth has not fallen by more than 10% over `L`, no authority or fee-config change pending.
  4. Exits: two targets, whichever first: reversion to the 6 h rolling median price, or +600 bps; stop at −`a`; time stop `T`; every universal exit (ARCH 8.6). Exit slippage normal 100 bps; entry slippage 50 bps (ARCH 8.3).
  5. Exactly **2** pre-registered configurations for a 30-day `W_B` (MinBTL budget, ARCH 3.4): (`L`, `z_entry`, `a`, `T`) ∈ {(5 min, 3.0, 400 bps, 30 min), (15 min, 3.0, 500 bps, 60 min)}.
- **Open points the unblocked ticket must settle before pre-registration (logged as C-22):** whether the median target is fixed at entry (`ExitPlan.targetPriceSolPerToken` = median at decision; the conservative default) or re-evaluated each bar; and whether an entry is skipped when the median is not above the expected entry price plus round-trip cost (default: skip, otherwise the "target" would book a loss).
- **Shared resources and concurrency:** per-strategy state only.
- **Config:** `strategy.mr01.params.*` (the two configurations; affectsReturns yes); no other keys.
- **Edge cases and failure handling:** to be enumerated when unblocked; at minimum: null features → no proposal; dump flag active (soft for MR) → proposal still allowed but M21 may reduce size.
- **Acceptance criteria (minimum):** Given the recorded fixture day, when run in replay with seed 1, then proposals are deterministic and every proposal satisfies the five fixed rules above.
- **Tests:** to be written with the ticket; must include the random-strategy and lookahead known-answer tests of ARCH 16.4.
- **Observability:** as A-M09-01 with `strategy="mr01"`.
- **Security notes:** none beyond A-M09-01.
- **Facts used:** EX-07, ST-04, ST-27, ST-28, ST-31, ST-V08.
- **Definition of done:** ticket completed and reviewed after MA-0c; plugin merged; configurations registered via A-M13-02 **before** `W_B` data begins (C-26).

#### A-M09-03 — PM-01 strategy plugin (BLOCKED; paper at most)

- **Module:** M09 · **Phase:** 1 (second track; only if the product owner keeps PM-01, OQ-7) · **Size:** S (≈ 0.5 engineer-day once unblocked)
- **Status:** Blocked until post-BOOST data (after 2026-07-21 [ST-06]) has been recorded for `W_B` and the product owner confirms the track. PM-01 may reach paper at most (ARCH 3.2).
- **Goal:** Implement PM-01 as specified in ARCH 3.3 for replay and paper evaluation only.
- **Depends on:** A-M09-01, A-M13-02, A-M03-02. B: M21.
- **Logic (fixed by ARCH; the remaining steps are written when unblocked):** canonical PumpSwap pools only; entry window 20-120 minutes after the verified `CompletePumpAmmMigrationEvent` [EX-03, DA-11]; effective depth ≥ 85 SOL with real/effective ≥ 0.6 [EX-V01]; holder and insider checks; 15 s bar breakout above the post-migration high with depth rising; fee tier 1.25% while market cap < 420 SOL [EX-07] (hurdle about 3%); exits: fixed stop and trailing stop at once (800 bps trailing after +800 bps), target +1,500 bps, time stop 120 min, slippage 150/300 bps (ARCH 8.3, 8.6); `dump_flag` is a hard check for PM.
- **Interfaces:** `Strategy` (A-M09-01) with `id = 'pm01'`, `scoreUnit = 'zscore'`; reads the verified migration slot from A-M03-02's `discovery.migration` events.
- **Shared resources and concurrency:** per-strategy state only (post-migration high per pool).
- **Config:** `strategy.pm01.params.*` (affectsReturns yes); `strategy.pm01.enabled_modes` may contain only `backtest`, `replay` and `paper` (validation).
- **Edge cases and failure handling (minimum):** migration slot not verified on chain → no proposal; dump flag `insufficient` → no proposal (hard check for PM, C-18); pool older than 120 minutes since migration → no proposal.
- **Acceptance criteria (minimum):** Given config with `live_small` in `enabled_modes`, then validation fails; given a recorded post-BOOST migration day, when replayed with a fixed seed, then proposals are deterministic and every proposal lies inside the 20-120 minute window.
- **Tests:** written with the unblocked ticket; must include the known-answer tests of ARCH 16.4.
- **Observability:** as A-M09-01 with `strategy="pm01"`.
- **Security notes:** none beyond A-M09-01.
- **Facts used:** EX-03, EX-07, EX-V01, DA-11, ST-06, ST-10.
- **Definition of done:** as A-M09-02; `enabled_modes` validation forbids `live_small` and `live` for PM-01.

### M10 Simulation core

#### A-M10-01 — Model parameter sets, versioning, RNG and latency model

- **Module:** M10 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Make every simulated number reproducible and attributable: a deterministic RNG, versioned parameter sets, and the latency model with its documented prior.
- **Depends on:** none. B: none.
- **Interfaces:**

```ts
interface Rng { nextU32(): number; nextFloat(): number /* [0,1) */; seed: number }      // ARCH 5.0a
function createRng(seed: number): Rng;                                                  // NEW: algorithm fixed and documented (golden sequence test)
interface SimParamSet {                                                                 // NEW (file sim-params/<name>.json; canonical JSON)
  name: string; createdAtMs: UnixMs; provenance: string;
  latency: { kind: 'lognormal_prior'; medianMs: number; p95Ms: number } | { kind: 'empirical'; samplesMs: number[]; source: string; n: number };
  fFailEntry: number; fFailExit: number; fExp: number;                                  // probabilities in [0,1)
  failureClassMix: Partial<Record<FailureClass, number>>;                              // sums to 1
  pSwEntry: number; pSwExit: number;                                                    // sandwich probabilities
  gapThroughStopP99Bps: number; gapSamples: number;                                     // A-M10-04
  slotMsAssumed: number;                                                                // for slot-denominated timing in research
  cost: { cuLimit: Cu; leanCuPriceMicroLamports: bigint; senderTipLamports: Lamports; jitoTipLamports: Lamports;
          premiumTipLamports: Lamports; premiumCuPriceMicroLamports: bigint; janitorPriorityLamports: Lamports } }
interface ModelVersions { fillModelVersion: string; costModelVersion: string }           // 'fill-<semver>-<sha256(params)[0..12]>'
interface LatencyModel { sampleMs(rng: Rng, multiplier: number): number }
```

- **Logic:**
  1. RNG: a fixed, documented 32-bit generator (POLICY: choose one well-known small PRNG with a published reference sequence, and pin it with a golden test of its first 1,000 outputs for seed 1). No other randomness source is allowed in simulation code.
  2. Default parameter set `prior-2026-10` = ARCH priors: latency lognormal with median 1,500 ms and p95 5,000 ms (ASSUMPTION A-04) → μ = ln 1,500, σ = (ln 5,000 − ln 1,500) / 1.6449 ≈ 0.732 (DERIVED); `fFailEntry = fFailExit = 0.20`, `fExp = 0.05` (A-03); `failureClassMix = { unknown: 1.0 }` (pessimistic choice for the prior, clarification C-27); `pSwEntry = pSwExit = 0.10` (A-03; applying it to exits too is C-25); `gapThroughStopP99Bps = 2,000`, `gapSamples = 0` (prior 20%, ARCH 3.5); cost block: CU limit 200,000, lean CU price 25,000 µlamports/CU, Sender tip 5,000, Jito tip 1,000, premium tip 1,000,000 and 1,000,000 µlamports/CU (ARCH 2.2 scenarios), janitor priority 5,000 lamports.
  3. Versions: `fillModelVersion` and `costModelVersion` combine a code semver (bumped on any formula change) and the SHA-256 of the canonical parameter set. Both enter every trial key (A-M13-02).
  4. The active set is chosen by `sim.param_set` (affectsReturns yes). A change is an `apply_config` command: risk direction `increases_risk` when the new set is less pessimistic on any of latency, failure, expiry or sandwich parameters (A3), else A1 (decided by A-M10-05's comparison report).
  5. Latency sampling: lognormal via Box-Muller from two `nextFloat()` draws; empirical: uniform draw from `samplesMs`. Result × `multiplier` (R-4 uses 2, ARCH 3.4).
- **Shared resources and concurrency:** parameter set files are read-only after creation; M10 owns them (ARCH M10).
- **Config:** `sim.param_set` (string, `prior-2026-10`; affectsReturns yes); `sim.latency_multiplier` (decimal, 1.0, 1.0-10.0; only values ≥ 1 allowed in gate runs).
- **Edge cases and failure handling:** missing or invalid parameter file → engine/CLI start refused for simulation modes (`E_SIM_PARAMS`); probabilities outside [0,1) or a class mix not summing to 1 ± 1e-9 → invalid.
- **Acceptance criteria:**
  - Given seed 1, then the first 1,000 RNG outputs equal the golden list.
  - Given 100,000 latency samples from the prior with seed 7, then the sample median is within 2% of 1,500 ms and the 95th percentile within 3% of 5,000 ms.
  - Given two parameter files differing in one value, then their `fillModelVersion`s differ.
- **Tests:** unit; statistical test with fixed seeds; schema validation of parameter files. Clarification C-61 (A10): the latency model uses B-M15-01's single slot-to-time function, with per-day block-time anchors in history.
- **Observability:** log `M10.param_set_loaded` (name, versions).
- **Security notes:** none.
- **Facts used:** none in the register (all values are ARCH ASSUMPTIONs A-03/A-04 and POLICY).
- **Definition of done:** RNG, parameter schema, prior set and versions merged; used by A-M10-02/03.

#### A-M10-02 — Fill, failure and sandwich model

- **Module:** M10 · **Phase:** 1 · **Size:** L (≈ 2.5 engineer-days)
- **Goal:** The single implementation of a simulated attempt's outcome, used by backtest, replay (M11) and paper (M12), with the anti-optimism rules of ARCH 9.3.
- **Depends on:** A-M10-01, A-M01-03. B: `LandingPath` (M18) and `FailureClass` (5.0a) types from `@bot/types`.
- **Interfaces (ARCH M10):**

```ts
interface FillModelInput { decisionMs: UnixMs; side: 'buy' | 'sell'; amountIn: bigint; minOut: bigint; poolId: Pubkey;
  snapshotsAfter: (tMs: UnixMs) => [PoolSnapshot | null, PoolSnapshot | null];
  landing: 'lean' | 'premium'; rung: 1 | 2 | 3 | 4 | 5; cuLimit: Cu; cuPrice: MicroLamportsPerCu;
  tips: Array<{ path: LandingPath; lamports: Lamports }> }
interface SimFill { outcome: 'filled' | 'failed_onchain' | 'expired' | 'no_data'; failureClass: FailureClass | null;
  landedMs: UnixMs | null; landedSlot: Slot | null; amountOut: bigint; venueFeeLamports: Lamports; baseFeeLamports: Lamports;
  priorityFeeLamports: Lamports; tipLamports: Lamports; sandwiched: boolean; modelVersion: string }
interface SimCore { fill(i: FillModelInput, rng: Rng, opts?: { latencyMultiplier?: number; pSwMultiplier?: number; fixedLatencyMs?: number }): SimFill }   // opts NEW (R-4 multipliers; fixedLatencyMs for bar-level backtests)
```

- **Logic (draw order fixed for determinism: outcome, latency, sandwich):**
  1. `u = rng.nextFloat()`. `fFail` = entry or exit value by side (`buy` = entry). If `u < fExp` → `expired`: no fees (ARCH 9.3(4)), `landedMs = null`.
  2. Latency `L = latency.sampleMs(rng, multiplier)`, or `L = opts.fixedLatencyMs` when given (bar-level backtests fill at the next bar's open, A-M11-02; the latency draw is then skipped, which keeps the draw sequence fixed per mode); `tFill = decisionMs + L`.
  3. Bracketing snapshots `[before, after] = snapshotsAfter(tFill)` where `before` is the latest snapshot at or before `tFill` and `after` the first after it. If `after` is null and no snapshot exists within 5 s after `tFill` → outcome `expired` **with** the fees of one failed attempt (base + priority) charged (pessimistic, ARCH M10 failure mode).
  4. If `fExp ≤ u < fExp + fFail` → `failed_onchain`, class drawn from `failureClassMix`; pays base fee (5,000 lamports per signature, 1 signature [LD-01]) + priority fee `ceil(cuPrice × cuLimit / 1,000,000)` on the **requested** limit [LD-02]; tips are not charged (an in-transaction tip reverts with the transaction, ARCH 2.1; explicit for Nozomi [LD-23]); `amountOut = 0`.
  5. Otherwise compute `quoteExactIn` (A-M01-03) on each existing bracketing snapshot; take the **worse** for our side (smaller `amountOut`) (ARCH 9.3(2)). If that `amountOut < minOut` → `failed_onchain` class `slippage` with fees as step 4.
  6. Sandwich: with probability `pSw × pSwMultiplier` (entry or exit by side; R-4 doubles it), set `amountOut = minOut` and `sandwiched = true` (ARCH 9.3(5); sandwiching of memecoin flow with high slippage tolerance is documented [ST-22, ST-V06, LD-15]). If `minOut` is above the model output this step does not improve the fill (never better than the model).
  7. Success: `outcome = 'filled'`, fees = venue fee from the quote, base fee, priority fee, `tipLamports = Σ tips` (rung ≥ 2 carries both a Sender and a Jito tip, CB-23; the caller passes them); `landedMs = tFill`; `landedSlot = after.providerSlot` if present else `before.providerSlot + ceil((tFill − before.observedAtMs) / slotMsAssumed)`.
  8. `modelVersion = fillModelVersion` of the active parameter set.
  9. Paper and replay never fill on stale data: a bracketing snapshot whose observation lag (recorded) exceeds 12 slots is treated as missing (ARCH 9.3(7)).
- **Shared resources and concurrency:** pure given the RNG; callers own their RNG stream (one per run).
- **Config:** uses `sim.param_set`; no extra keys.
- **Edge cases and failure handling:** 1. Both snapshots exist but disagree wildly (a pool event between them) → still the worse one. 2. `minOut = 0` passed by mistake → `E_INVALID_ARG` (simulation must not model unbounded slippage; the live system never sends it, ARCH 8.7). 3. `amountIn` exceeding what the pool can provide (sell larger than reserves) → quote error → `failed_onchain` class `slippage`.
- **Acceptance criteria:**
  - Given a fixed seed and inputs, then `fill` is deterministic.
  - Given 100,000 draws with the prior, then the fractions of `expired` and `failed_onchain` are within 0.5 percentage points of 5% and 20%, and sandwiched fills are within 0.5 points of 10% of filled entries.
  - Given bracketing snapshots where `after` is worse, then the fill uses `after`; given no snapshot within 5 s, then `expired` with fees charged.
  - Property: `amountOut ≤` the model's best bracketing quote output, always.
- **Tests:** unit; property tests (never better than the best bracketing quote; fees non-negative; failed outcomes never charge tips); statistical tests with seeds.
- **Observability:** in research runs, counters per outcome in the run report; in paper, metrics `sim_fill_total{outcome,side}`.
- **Security notes:** none.
- **Facts used:** LD-01, LD-02, LD-15, LD-23, ST-22, ST-V06.
- **Definition of done:** model merged; used by A-M11-02/03 and A-M12-01; R-4 multipliers wired.

#### A-M10-03 — Cost model and fixed-cost amortisation

- **Module:** M10 · **Phase:** 0 (pure; needed by the Phase 0 study) · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Pre-trade all-in round-trip cost and the per-trade share of fixed monthly cost, consistent with ARCH section 2 and reproducing its tables.
- **Depends on:** A-M10-01, A-M01-03. B: `priorityFeeLamports` from `@bot/types` (B-M19-01; the single implementation of `ceil(cuPrice × cuLimit / 1,000,000)`, integration); at runtime in the engine M15 `priorityFee(...)` and `rentExemptMinimum(...)` (B-M15-03, injected; research uses recorded values); M23 and M21 are consumers.
- **Interfaces (ARCH M10):**

```ts
interface SimCore {
  estimateRoundTripCostBps(pool: PoolSnapshot, notional: Lamports, landing: 'lean' | 'premium'): Bps;   // includes janitor close and rung-2+ double tips
  fixedCostBpsPerTrade(fixedMonthlyLamports: Lamports, tradesPerDay: number, notional: Lamports): Bps;   // section 2.4, conclusion 9
}
interface CostBreakdown {                                                                 // NEW (returned by estimateRoundTripCostDetailed, for VM-07 and A-M13-01)
  row: 'lean' | 'strict' | 'conservative';
  venueFeesLamports: Lamports; impactLamports: Lamports; legFixedLamports: Lamports; failedOverheadLamports: Lamports;
  janitorLamports: Lamports; rung2ExpectedLamports: Lamports; sandwichLamports: Lamports; stuckLamports: Lamports;
  lostRentLamports: Lamports; dustLamports: Lamports; gStarBps: Bps;
  assumptions: { cuPriceMicroLamports: bigint; tipLamports: Lamports; fFail: number; pSw: number; lostRentRate: number } }
interface CostRows { lean: CostBreakdown; strict: CostBreakdown; conservative: CostBreakdown }   // NEW (C-50, C-77): costRows(pool, notional): CostRows
```

- **Logic:**
  1. Exact round trip on the **same** pre-trade pool state (entry impact is charged on both sides and never assumed to reverse, ARCH 2.1 and 9.3(6)): buy `notional` with `quoteExactIn` → `T` tokens; sell `T` with `quoteExactIn` on the original state → `out`. Venue fees and impact come out of this exact computation (fees per the conservative tier rule).
  2. Per-leg fixed `F_leg = base + priority + tip`: base 5,000 lamports [LD-01]; priority `ceil(cuPrice × cuLimit / 1,000,000)` on the requested limit [LD-02], where in the engine `cuPrice` = M15 `priorityFee(..., 'Medium')` clamped to the entry cap `min(50,000 lamports, 20 bps of notional)` (ARCH 1.4, 8.3), and in research it is the parameter set's lean or premium value; tip = Sender 5,000 [LD-22] (lean) or 1,000,000 (premium [LD-22, LD-23, LD-24, LD-31]).
  3. Failed overhead per leg `= fFail / (1 − fFail) × (base + priority)` (ARCH 2.1).
  4. Janitor close: `5,000 + janitorPriority + Sender tip` (the rent refund is not a cost, ARCH 2.1) — included unless `opts.includeJanitor = false`.
  5. Rung-2+ expectation: `P(exit needs rung ≥ 2) × (Jito tip 1,000 [LD-17] + (2× − 1×) entry priority cap)`, with `P = 1 − (1 − fFailExit)(1 − fExp)` (DERIVED from the parameter set) — included unless `opts.includeRung2 = false`.
  6. `F = 2 × F_leg + 2 × failed overhead + janitor + rung2`. `g* = (notional + F) / out − 1`; return `ceil(g* × 10,000)` (equivalent to ARCH's factorised formula, computed exactly).
  7. `fixedCostBpsPerTrade = ceil(fixedMonthlyLamports × 10,000 / (30 × tradesPerDay × notional))`; `tradesPerDay ≤ 0` or `notional = 0` → throws `{ code: 'E_INVALID_ARG' }` (clarification C-28). Fixed monthly lamports come from M23's fixed-cost items converted at the live SOL/USD price (gates P-2b, LS-3b).
  8. Rent locked in an ATA is capital, not cost (ARCH 2.1); it is reported in `CostBreakdown` only as an assumption note, except in the conservative row's unrecovered-rent prior (step 9).
  9. **Three cost rows (C-50 ticket work; C-77; supervisor ruling, Z0D round 4).** `costRows(pool, notional)` returns all three, each with its parts:
     - **lean**: steps 1-6 with lean landing (ARCH Table 2-A inputs); no sandwich, stuck, unrecovered-rent or dust term. It is a **lower bound** on costs and decides only stop-only checks (A-M13-01 steps 4-5 and 9).
     - **strict**: the pessimistic Blueprint parameters, as `research/phase0/PREREG.md` §4 builds them: priority at D15's High level on every leg, taken at the entry cap `min(50,000 lamports, 20 bps of notional)`; Sender tip 5,000; failed overhead at `fFail` 0.20 with C-27's all-`unknown` mix; janitor; rung-2 expectation; sandwich expectation `pSw × (entry slippage bound × notional + exit slippage bound × out)` with `pSw` 0.10 (C-25) and the strategy's slippage bounds; stuck term `fFail³ × out` (3 consecutive `unknown` failures mark cannot-sell, ARCH 8.6), the stuck position valued at a total loss.
     - **conservative** (binding for B-2 and R-2 until each parameter is measured, ARCH 2.3): strict plus unrecovered rent at a prior rate of 0.145 × the round trip's rent-exempt deposits (the rate behind Zeroed's 414,009 figure, RS-06; unmeasured) plus a dust-deposit prior of one extra janitor close per round trip. Both priors are POLICY; a measured value replaces only its own parameter (C-50).
     - The 414,009-lamport sensitivity line is reported beside the rows and is never a gate input. `fixedShareBps(row)` = the row's fixed lamports (both legs, failed overhead, janitor, rung-2, plus unrecovered rent in the conservative row) ÷ notional, for the `k`% fixed-cost cap fixed in each PREREG (ARCH 2.3).
- **Shared resources and concurrency:** pure.
- **Config:** none beyond `sim.param_set`.
- **Edge cases and failure handling:** `out = 0` (dust or empty pool) → return `10,000 × 100` (an effectively infinite cost) and log; never 0.
- **Acceptance criteria:**
  - Given ARCH Table 2-A inputs for V3, V4, V5 (PumpSwap, lean, `P_SOL` $150, $5/$10/$25/$50, `fFail` 0.2, janitor and rung-2 terms disabled), then results equal the table values within ±2 bps (rounding differences from the factorised approximation).
  - Given $12/month at $150/SOL (80,000,000 lamports), 10 trades/day and $10 notional (66,666,667 lamports), then `fixedCostBpsPerTrade` = 40 (ARCH 2.4 table).
  - Given premium landing at $5 on V5, then the fixed part alone is ≈ 754 bps (ARCH 2.4 conclusion 1).
  - Given the PREREG §4 inputs (base 5,000, priority 50,000 and tip 5,000 per leg, `fFail` 0.20, janitor 15,000, `fExp` 0.05), then the strict row's fixed part is 174,740 lamports (DERIVED: 2 × 60,000 + 2 × 13,750 + 15,000 + 12,240).
  - Property: for every pool state and notional, lean ≤ strict ≤ conservative in total cost and in `gStarBps`.
- **Tests:** unit; golden table test; property: cost non-decreasing in `cuPrice` and tip; monotonic in notional beyond the fixed-cost region.
- **Observability:** VM-07 `expected_cost_bps` is this value (via M21/M28); metric `cost_model_bps` (histogram).
- **Security notes:** none.
- **Facts used:** LD-01, LD-02, LD-17, LD-22, LD-23, LD-24, LD-31, EX-07, VF-04.
- **Definition of done:** merged with the golden tests; used by A-M13-01, A-M06-05, M21, M23.

#### A-M10-04 — Gap-through-stop distribution, `no_data` close rule and simulated attempt timing

- **Module:** M10 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** The exit-side simulation rules: positions whose pool loses data are closed pessimistically and never dropped; stops gap; the stressed loss used by `MAXRISK` comes from measured gaps; simulated attempts expose the same slot timing that drives live exit supersession.
- **Depends on:** A-M10-02. B: consumer B-M21-02 uses `stressedGapBps` (integration: replaces CL-38's `gapThroughStopP99Bps`); M19 consumes the simulated "not landed" timing through the sim `ExecutionPort` (A-M11-02, A-M12-01).
- **Interfaces:**

```ts
interface SimCore {
  stressedGapBps(strategyId: string): { p99Bps: Bps; samples: number; source: 'prior' | 'empirical' };          // NEW (clarification C-24)
  noDataClose(i: { positionSizeBase: BaseUnits; poolId: Pubkey; lastDataMs: UnixMs; timeStopAtMs: UnixMs;
    recentSnapshots: PoolSnapshot[] /* the 5 min before data stopped */; firstSnapshotAfterGap: PoolSnapshot | null }): { proceedsLamports: Lamports; flag: 'no_data' };   // NEW
  notLandedSchedule(latencyMs: number, slotMs: number, supersedeSlots: number): { notLandedAtMs: UnixMs | null };   // NEW helper for sim ExecutionPorts
}
```

- **Logic:**
  1. `no_data` (CA-25): a simulated position whose pool has no snapshot for longer than the stale threshold (12 slots) is valued at the **worse** of (a) the sell quote of the full position on the snapshot with the lowest effective depth in the 5 minutes before data stopped, and (b) the normal exit fill on the first snapshot after data returns, if it returns before the strategy's time stop; if no data returns by the time stop, proceeds are 0 (−100%). The trade is flagged `no_data` and counted in the run's `low_coverage` statistics (ARCH M10, 9.3(7)) (clarification C-23).
  2. Stops gap: a stop fills at the first snapshot after the trigger, not at the stop price (ARCH 9.3(8)); this is a property of M20's sim-driven evaluation; M10's role is the fill itself (A-M10-02).
  3. Gap-through-stop: from replay trades with `exitReason = stop`, the realised loss in bps of entry cost (positive number); `p99Bps` over at least 50 such exits, else the prior 2,000 bps (ARCH 3.5). The distribution is frozen into the parameter set at the transition to `replay_passed` (from `W_R` stop exits) and used unchanged during `W_P` and live sizing, so trial identity does not drift (C-24). `stressed_loss = notional × max(stop distance, p99)` is computed by M21.
  4. `notLandedSchedule`: if `latencyMs > supersedeSlots × slotMs` (8 slots, ARCH 7.3), the sim port emits a "not landed" event at `first send + supersedeSlots × slotMs`, so M19's supersession logic runs unchanged in simulation; `slotMs` comes from recorded slot timing (replay) or the parameter set (backtest).
- **Shared resources and concurrency:** pure given inputs.
- **Config:** `sim.gap.min_samples` (count, 50, 50-1,000; lowering it below 50 is forbidden); `sim.no_data.stale_slots` (12, aligned with ARCH 8.5).
- **Edge cases and failure handling:** 1. No snapshots at all in the 5 minutes before the gap → (a) is 0 proceeds. 2. Position partly closed before the gap → applies to the remaining size.
- **Acceptance criteria:**
  - Given a replay where a position's pool is evicted before its tail begins, then the trade is closed by the rule above, flagged `no_data`, and never dropped (ARCH 16.4).
  - Given 49 stop exits, then `source = 'prior'` and `p99Bps = 2,000`; with 50, `source = 'empirical'`.
- **Tests:** unit; the research-hygiene test of ARCH 16.4 (evicted-pool trade closed by `no_data`).
- **Observability:** run report counts `no_data_trades`; metric `stressed_gap_p99_bps{strategy}`.
- **Security notes:** none.
- **Facts used:** ST-04, ST-26.
- **Definition of done:** merged; used in A-M11-02/03; M21 contract test for `stressedGapBps` passes.

#### A-M10-05 — Calibration pipeline (sandwich rate, failure mix, latency)

- **Module:** M10 · **Phase:** 1 (code) / 3 (data) · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Replace priors with measured values from our own live-small data, without ever tuning the model to make a strategy pass (ARCH 9.3(11)).
- **Depends on:** A-M10-02, A-M10-04. B: M23 `SandwichCheck` results (CB-13); M18 attempt results (`AttemptResult` with `failureClass`, slots to confirm); M19 decision-to-confirmed timing.
- **Interfaces:** `proposeParamSet(input: { sandwichChecks: SandwichCheck[]; attempts: Array<{ side: 'entry' | 'exit'; status: AttemptStatus; failureClass: FailureClass | null; decisionToConfirmedMs: number | null }>; base: SimParamSet }): { proposal: SimParamSet; comparison: Array<{ field: string; old: string; new: string; direction: 'more_pessimistic' | 'less_pessimistic' | 'same' }>; riskDirection: 'increases_risk' | 'decreases_risk' | 'neutral' }` (NEW; runs in the research CLI or as an operator-triggered job; produces a file, never activates it).
- **Logic:**
  1. Sandwich rate: once ≥ 100 non-null `SandwichCheck`s exist (ARCH M10, CB-13), `pSw = ` the **upper** bound of the 95% Wilson interval of `sandwiched = true` among non-null checks (conservative reading of "replaced by the rate measured", clarification C-25); applied to entries and exits.
  2. Failure model: with ≥ 100 live attempts per side, `fFail` and `failureClassMix` from `confirmed_failed` attempts by class; `fExp` from proven `expired` attempts; same upper-bound rule for each probability.
  3. Latency: once ≥ 100 live entries have a decision-to-confirmed time, `latency = { kind: 'empirical', samplesMs, n }` (ARCH 9.3(1)); paper measurements are not used for landing latency.
  4. Output: a new parameter set file plus a comparison report; activation is an `apply_config` of `sim.param_set` (A-M10-01 step 4). Any activation changes `fillModelVersion`, so later gate evaluations need new trials (A-M13-02).
  5. Separation: the job reads only attempts and sandwich checks, never strategy PnL, so it cannot optimise for a pass. Decisions tagged `replayAssumed` (C-78, A-M11-01 step 8), their attempts and anything else from a run with the replay key on are never calibration inputs; a tagged record in the input is skipped and counted.
- **Shared resources and concurrency:** reads M23/M18 records (read-only); writes a new file only.
- **Config:** `sim.calibration.min_samples` (count, 100, ≥ 100).
- **Edge cases and failure handling:** fewer than the minimum samples → field unchanged with reason; `null` sandwich checks excluded and counted.
- **Acceptance criteria:** Given 100 checks with 3 sandwiched, then `pSw` equals the Wilson 95% upper bound of 3/100 (hand-computed in the test); given a proposal lowering `pSw`, then `riskDirection = 'increases_risk'`; given 100 attempts of which 10 belong to decisions tagged `replayAssumed`, then the proposal is computed from the other 90 (below the minimum, so the field stays unchanged) and the 10 are reported as skipped.
- **Tests:** unit; reproducibility (same input → same file hash). Clarification C-66 (A15): the research swap replayer validates the fill and stop-gap models; bulk use waits for the owner's credit approval.
- **Observability:** log `M10.param_set_proposed` (name, riskDirection).
- **Security notes:** parameter files are code-reviewed artefacts; the engine loads only files listed in config.
- **Facts used:** ST-22, ST-V06, LD-15.
- **Definition of done:** pipeline merged; first use expected in live-small (Phase 3).

### M11 Backtest and replay drivers

M11 runs on the operator's own machine (or another research machine), never on the live host (D29). Its only path into the live system is a signed run bundle imported with `botctl import-run` (M29) and evaluated by M13.

#### A-M11-01 — Research CLI, dataset loaders and simulated clock

- **Module:** M11 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** A deterministic research runner that loads only manifest-verified M07 data, drives a simulated clock, and records every run.
- **Depends on:** A-M07-02 (segment and manifest format), A-M10-01 (RNG, parameter sets). B: none for this ticket.
- **Interfaces (ARCH M11):**

```ts
interface RunSpec { mode: 'backtest' | 'replay' | 'coarse_screen'; strategyId: string; trialKey: string; datasets: string[] /* manifest sha256 */;
  fromMs: UnixMs; toMs: UnixMs; seed: number; speedX: number | 'max'; latencyInjection?: { multiplier: number }; pSwMultiplier?: number;
  b10PullId?: string /* NEW (C-78; C-79 replaced b10AckId): a pinned B10-PULL row; every manifest in `datasets` must appear in its unitLog or card Z-H report (step 8) */;
  assumePassUnavailable?: boolean /* NEW (C-78): the replay key's only source; default false; part of trialKey, not of configKey */ }
type ReplayUnavailable = { kind: 'replay_unavailable'; input: 'honeypot_sim' | 'holders_pre_window' }   // NEW (C-78): only the B-10 replay input provider returns it
interface RunStatus { runId: Id; state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; simTimeMs: UnixMs; progressBps: Bps; trades: number; error: string | null }
interface Runner { start(spec: RunSpec): Id; pause(runId: Id): void; resume(runId: Id): void; cancel(runId: Id): void; status(runId: Id): RunStatus }
interface SimClock extends Clock { kind: 'sim'; advanceTo(ms: UnixMs): void }                      // NEW
interface RecordedDataSource {                                                                     // NEW (data-source adapter, ARCH 9.2)
  open(datasets: string[], fromMs: UnixMs, toMs: UnixMs): Result<void, { code: 'E_MANIFEST' | 'E_MISSING' | 'E_CODEC' }>;
  next(): RecordEnvelope | null;                       // merged across streams in (recvMs, stream priority, seq) order
  universe(dayUtc: string): UniverseManifestFile | null;
  coverage(dayUtc: string): CoverageReport | null }
```

- **Logic:**
  1. Before a run starts, every segment in `datasets` is re-hashed and compared with its manifest; any mismatch or missing file → run `failed` before starting (ARCH M11).
  2. Decode keyframes and deltas back into full snapshots (A-M07-01 round trip); `poll_counts` feed the bar engine's completeness (A-M08-01).
  3. The simulated clock advances to each record's `recvMs`; all engine code receives the `SimClock` (no wall time anywhere, ARCH 5.0).
  4. Run registry (local SQLite on the research machine): `run_id`, mode, dataset manifest hashes, trial key, git commit, seed, status, progress (ARCH M11), the full `RunSpec` (replay key and `b10PullId` included), and per-strategy entry counts, entry days, and exit counts by cause (exit rule, risk engine, run-end close) (read by B-10, A-M13-06 step 3). `run_id` is a ULID generated from the sim-independent wall clock of the research machine (identity only, never used in computation).
  5. Coverage: if gaps exceed 5% of the window (from the days' `CoverageReport`s), the run is marked `low_coverage` and is excluded from gate evaluation (ARCH M11); it can still complete for diagnostics.
  6. `speedX: 'max'` runs as fast as possible; numeric values throttle for live-like debugging only (results are identical).
  7. **B-9 producer (supervisor ruling, Z0D round 3).** `research replay-check <runId>` replays the evaluated run 10 times (same `RunSpec`, seed and build) and writes one 10-replay run record `{ runId, buildSha, configKey, assumePassUnavailable, replays, decisionLogSha256[10], identical }` to the run registry (the replays use the same `RunSpec`, the replay key included); A-M11-05 carries it in the run bundle, and A-M13-06 reads it as `replayDeterminism` in M2. It is the only source of B-9, and B-9 reads only a record with `assumePassUnavailable = false` (C-78).
  8. **Inputs that cannot exist in history (supervisor rulings, 2026-10-08, Z0D-2 rounds 1 and 2; C-78; ARCH 9.2).** A **B-10 run** (the one definition; C-79, owner 2026-10-08 about 7:25 AM: the history comes from the Old Faithful archive) is a run with `mode = 'replay'` and `b10PullId` naming a pinned `B10-PULL` row (A-M13-06 step 3), where every manifest in `datasets` appears in that pull's `unitLog` or in card Z-H's report for that pull; a run citing a `B10-ACK` row (the Helius route, not chosen) is never a B-10 run; the CLI checks this before the run starts and fails it otherwise (`E_NOT_B10`). In a B-10 run only, the replay input provider returns `ReplayUnavailable` for `honeypot_sim` and for holder state from before the window, never a made-up value. The replay key `research.b10.assume_pass_unavailable` has **one source**, `RunSpec.assumePassUnavailable` (default false): no environment variable, flag or config file sets or overrides it. With it true, the gate treats `ReplayUnavailable` as "assumed pass, flagged", and the decision carries `replayAssumed` (the inputs it covered) in the decision log and the journal; with it false the value fails the gate, as in every other mode. The CLI refuses the key in any run that is not a B-10 run (`E_CONFIG_SCOPE`), and the engine's config validation refuses `research.*` keys in paper, live_small and live (SPEC-B B-M25-02). The key is part of `RunSpec` and of `trialKey` (A-M13-02 step 3) but not of `configKey`: a key-on B-10 run keeps the stage's frozen `configKey`, gets its own trial key, is never a registered trial (A-M13-02 step 5), and the key's value is written to the run record. **A run with the key on is excluded as a whole** from every B, R and P statistic (A-M13-06 step 1), as a `low_coverage` run is, except B-10's crash, illegal-state and unreconciled-intent counts; B-9 is read only from runs with the key off (step 7). `fee_config_known` and `venue_enabled` are never covered: they stay fail-closed until card Z-H prep's P12 is done. The engine code is identical in every mode; only the input provider and the `RunSpec` differ.
- **Shared resources and concurrency:** the research machine's local files; one run per process (parallel runs use separate processes with separate RNG seeds).
- **Config (research CLI):** `research.data_dir`, `research.registry_path`, `research.max_parallel_runs` (1-8); `research.b10.assume_pass_unavailable` (boolean, default false; valid only in a B-10 run; its only source is `RunSpec.assumePassUnavailable`, step 8; C-78).
- **Edge cases and failure handling:** 1. A day in the window without a universe manifest → that day contributes no entries (no universe) and the run is `low_coverage`. 2. Codec unsupported (zstd absent on the research machine) → `E_CODEC`, run fails with a clear message.
- **Acceptance criteria:**
  - Given the same `RunSpec` and seed twice, then byte-identical journals and run reports (ARCH 16.4); given the same run 10 times, then 10 identical decision logs (owner item 1, gate B-9, C-49).
  - Given one tampered segment, then the run fails before starting with `E_MANIFEST`.
  - Given `replay-check` on a run, then the 10-replay run record holds 10 hashes, the run's `buildSha` and `configKey`, and `identical = true`; given a module that reads wall time, then the hashes differ and `identical = false`.
  - Leak test (owner, "Backtests are blind and reproduce live"; C-49): given a recorded dataset with a future-only marker planted after a chosen simulated time, when any module (strategy, risk, screener, features, simulation) reads it before that time, then the run fails and names the module; a run that never reads it early passes. The test fails on a deliberately leaking module.
  - Replay mode (C-78): given `research.b10.assume_pass_unavailable = true` in the engine config in paper mode, in live_small mode and in live mode, then config validation refuses it each time and the engine does not start with it (B-M25-02); given `assumePassUnavailable = true` in a research run that is not a B-10 run (a backtest, a `W_R` replay, a replay without `b10PullId`, or one citing a `B10-ACK` row, with or without `test=p10`), then the run fails before starting with `E_CONFIG_SCOPE`.
  - Given a pinned `b10PullId` and `datasets` with one manifest that is in neither that pull's `unitLog` nor its card Z-H report (for example a `W_R` recording), then the run fails before starting with `E_NOT_B10`; given every manifest listed there, then it starts as a B-10 run; given a `B10-ACK` id in place of a `B10-PULL` id, then it fails with `E_NOT_B10`.
  - Given an environment variable or CLI flag naming the replay key set to true while `RunSpec.assumePassUnavailable` is false or absent, then the key is off, gates fail on `ReplayUnavailable`, and the run record shows false.
  - Given a B-10 run with the key, then a candidate whose `honeypot_sim` input is `ReplayUnavailable` passes that gate with `replayAssumed = ['honeypot_sim']` in its decision record, and a candidate in a pool created before the window (for example a migration in the lead-in's first hours, or a revised MR version's old pool) whose pre-window holder state is unavailable passes with `replayAssumed` naming `holders_pre_window`; given the same run without the key, then those gates fail and no entry is made; given `fee_config_known` or `venue_enabled` unavailable, then the gate fails with or without the key.
  - Given a paper, live_small or live run in which `honeypot_sim` cannot be computed, then the gate fails hard as today (ARCH 8.4, `honeypot_sim`), and no non-replay input provider (paper, live_small, live) ever returns `ReplayUnavailable`.
  - Given the same B-10 run with the key on and off, then `buildSha` and `configKey` are the same, the two `trialKey`s differ, and each run record shows the key's value; given `replay-check` on the key-on run, then its 10-replay record carries `assumePassUnavailable = true`.
- **Tests:** integration on a recorded test day `fx/md/test_day/` (all streams, manifests, coverage, universe manifest).
- **Observability:** run report (JSON) with counts, coverage, warnings; CLI logs to stderr; no metrics service.
- **Security notes:** the research machine never holds the trading key; it holds the research signing key (A-M11-05), which must be kept offline from the host.
- **Facts used:** none in the register (internal).
- **Definition of done:** CLI loads a recorded day end-to-end and reproduces bars identical to the live ones (A-M08-01 test).

#### A-M11-02 — Bar-level backtest driver (`W_B`)

- **Module:** M11 · **Phase:** 1 · **Size:** M (≈ 2 engineer-days)
- **Goal:** Evaluate the pre-registered configurations on `W_B` by driving the engine's own strategy, risk, order, position and journal code on 15 s bars with pessimistic bar-level fills.
- **Depends on:** A-M11-01, A-M08-02, A-M09-01, A-M10-04, A-M05-03. B (tickets, integration): B-M19-02 and B-M19-05 (`OrderManager` with an injected `ExecutionPort`, exit supersession), B-M20-01, B-M20-02, B-M20-04 (`PositionManager`, marks, ladder), B-M21-02, B-M21-03 and B-M21-06 (`RiskEngine.evaluate`, regime, entry pipeline), B-M22-05 (sim ledger: `WalletBalances.source = 'sim_ledger'`, same code as the paper ledger), B-M23-02 (`TradeRecord`). Until B's modules exist, development uses test doubles of the frozen interfaces; gate runs wait for the real ones (ARCH 9.2: identical code paths).
- **Interfaces:**

```ts
// Integration: ExecutionPort is the single @bot/types definition (B-M19-01):
//   { submit(a): Promise<AttemptHandle>; status(attemptId): AttemptState; onResult(h); onNotLanded(h) }
// AttemptState = 'building' | 'build_failed' | 'signing' | 'sign_refused' | AttemptStatus (the sim port never reports
// 'signing'/'sign_refused'; it reports 'building' only between submit and the simulated send).
interface SimExecutionPort extends ExecutionPort {}                                    // M11-owned implementation; intent read via OrderManager.intent(intentId) (B-M19-02)
interface BacktestResult { runId: Id; trades: TradeRecord[]; returnsPerDay: Array<{ dayUtc: string; netLamports: SignedLamports; netBpsOfE: number }>;
  returnsPerTrade: number[] /* net bps of entry cost */; perConfig: Record<string, { returnsPerDay: number[] }> /* for CSCV / rank stability */;
  noDataTrades: number; lowCoverage: boolean }
```

- **Logic:**
  1. Universe per day = that day's universe manifest (`eligible` with first/last eligible times); a pool is tradable only inside its eligible interval (no survivorship look-ahead, ARCH 3.4). Screen results come from the recorded `screen` stream as of that time; a candidate without a recorded `eligible` screen at that time is not tradable.
  2. Bars from A-M08-01 on recorded snapshots; features only from closed bars (no lookahead, ARCH M11).
  3. Proposals from M09 → the entry pipeline B-M21-06 (screen from the recorded stream, recorded snapshot, quote, M21 `evaluate`, decision record) → M19 `submit` → `SimExecutionPort`.
  4. Entry fill: at the **next bar's open**, i.e. the first snapshot of the next bar, via `SimCore.fill` with `opts.fixedLatencyMs` = time to the next bar's start and `snapshotsAfter` returning that bar's first snapshot, plus failure and sandwich draws (A-M10-02).
  5. Exits: M20 evaluates on bars; if a bar's range touches both the stop and a target, the **stop fills first** (pessimistic intrabar ordering, ARCH M11); a stop fills at the next bar's open state (gap, ARCH 9.3(8)); time stops at the first bar after expiry; universal exits from recorded events (fee-config change, authority change in the recorded screen stream, pool quarantine).
  6. Positions whose pools lose data → `noDataClose` (A-M10-04), never dropped.
  7. Both pre-registered configurations run on the same data with the same seed per configuration; per-day returns per configuration are kept for B-4 (CSCV with ≥ 4 trials, rank stability with ≤ 3, ARCH 3.4).
  8. Daily returns are flow-free (sim ledger has no cash flows) and computed against the simulated `E` at the start of each day; the per-trade series is net bps of entry cost.
- **Shared resources and concurrency:** the sim ledger and journal live in a per-run in-memory or temp SQLite database; nothing touches `bot.db`.
- **Config:** inherits the strategy's frozen config; the run refuses to start if the active config's `affectsReturns` values differ from those in the trial (A-M13-02 `configKey`).
- **Edge cases and failure handling:** 1. Engine-code exception during a run → run `failed` with the stack trace in the report, no partial bundle. 2. A day marked `low_coverage` inside the window → run `low_coverage` (excluded from gates).
- **Acceptance criteria:**
  - Given the known-answer random-entry strategy on a recorded week, then its mean net per trade is negative and within the bootstrap CI of `−g*` (ARCH 16.4).
  - Given a strategy with one-bar lookahead, then the no-lookahead test detects it (proposals reference a bar not yet closed) and the run fails.
  - Given a bar where both stop and target are touched, then the trade exits at the stop path.
- **Tests:** known-answer strategies; determinism; research-hygiene tests (evicted-pool `no_data`, ARCH 16.4); integration with B test doubles, then with real B modules.
- **Observability:** run report: trades, win/loss, costs by kind, `no_data` count, coverage.
- **Security notes:** none (off-host, no keys).
- **Facts used:** ST-26, ST-37.
- **Definition of done:** a `W_B`-shaped run on recorded data produces a `BacktestResult` and a bundle (A-M11-05) that M13 can evaluate.

#### A-M11-03 — Snapshot replay driver (`W_R`) with latency injection

- **Module:** M11 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Replay the selected configuration on `W_R` at snapshot level with sampled latency, the full exit ladder, and the stress settings gate R-4 requires, plus the crash-day report for R-6.
- **Depends on:** A-M11-02. B: as A-M11-02.
- **Interfaces:** `RunSpec` with `mode: 'replay'`, `latencyInjection.multiplier`, `pSwMultiplier`; `CrashDayReport { days: Array<{ dayUtc: string; trigger: 'basket' | 'sol_usd' | 'multi_signal'; minBasketReturn30m: number | null; minSolUsdReturn30m: number | null; simultaneousSignalsMax: number; correlatedLossLamports: SignedLamports; maxRiskPfLamports: Lamports; withinLimit: boolean }>; solUsdAvailable: boolean }` (NEW).
- **Logic:**
  1. Feed recorded snapshots through a recorded `PoolTracker` (A-M04 semantics: `latest`, `history`, `freshRead` returning the latest recorded snapshot at sim time with its recorded observation lag; lag > 8 at build → entry abandoned, as live).
  2. Every attempt resolves through `SimCore.fill` with sampled latency (× `multiplier`) and `pSwMultiplier`; exits supersede after 8 slots via `notLandedSchedule` and climb the ladder through M19/M20's own code (ARCH 8.7).
  3. Gate R-4 runs: the same replay with `multiplier = 2 × (measured p95 decision-to-confirmed ÷ prior p95)` — when no measured p95 exists yet, multiplier 2 on the prior — and `pSwMultiplier = 2` (ARCH 3.4).
  4. Crash-day report (R-6): days in `W_R` on which the watched basket's 30-min return fell below −5% or SOL/USD's 30-min return below −3% (the `REGIME` thresholds, ARCH 8.1), and days with ≥ 2 simultaneous signals; for each, the correlated loss of positions open together versus `MAXRISK_PF`. SOL/USD history comes from an export of the host's `price_reference` table (M23); if unavailable, `solUsdAvailable = false` and R-6 reports `pending-data` for SOL-based days.
  5. Output as A-M11-02 plus `CrashDayReport` and the empirical stop-gap samples (for A-M10-04's freeze at `replay_passed`).
- **Shared resources and concurrency:** as A-M11-02.
- **Config:** `research.replay.r4_latency_multiplier_min` (2.0, ≥ 2.0).
- **Edge cases and failure handling:** recorded `degraded_reads` periods → candidates absent (as live); positions continue on recorded position-pool snapshots.
- **Acceptance criteria:** Given a recorded day, then replay in `replay` mode reproduces the paper (live dry-run) decisions of that day exactly, and with the same bracketing snapshots and draws the same fill amounts exactly (parity, owner "Backtests are blind and reproduce live"; this replaces the earlier 1 bp tolerance; ARCH 16.4, C-49). Given owner item 2's required check (gate B-10, card Z-H; history source DECIDED by the owner on 2026-10-08: the capped Helius download, ARCH 3.4), when the selected configuration is replayed transaction by transaction on clean history, then the report lists the days used and counts crashes, illegal states and unreconciled intents; any non-zero count, fewer than 30 clean days, a day inside `W_R` or a holdout-contaminated window, or no report fails the stage.
- **Tests:** replay-vs-paper equivalence on a recorded paper day (Phase 2); R-4 stress run reproducibility; crash-day detection on a synthetic −6% basket day.
- **Observability:** run report including R-4 and R-6 sections.
- **Security notes:** none.
- **Facts used:** ST-22, ST-V06.
- **Definition of done:** R-gate inputs (net mean CI, R-3 ratio, R-4 stressed point estimate, R-5 drawdown, R-6 report) produced in one bundle per evaluation.

#### A-M11-04 — Coarse-screen driver on vendor OHLCV (kill-only)

- **Module:** M11 · **Phase:** 1 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Optionally kill MR-01 early on vendor minute bars (gate CS-1) before the `W_B` window is spent; never pass a gate.
- **Depends on:** A-M11-01, A-M10-03, A-M14-03 (CoinGecko client, used from the research process). B: none.
- **Interfaces:** `RunSpec` with `mode: 'coarse_screen'`; dataset = a vendor-OHLCV manifest `{ vendor: 'coingecko' | 'birdeye'; pools: Pubkey[]; fromMs; toMs; fetchedAtMs; sha256 }` (NEW).
- **Logic:**
  1. CoinGecko on-chain pool OHLCV (Demo): minute timeframe, ≤ 1,000 results per call, ≤ 6-month range per call, `include_empty_intervals=true` to keep gaps explicit, cached 60 s on Demo [DA-28]; API key header `x-cg-demo-api-key` [DA-27]; 100 calls/min [DA-27]; budget ≤ 2,000 calls per month because the monthly allowance is conflicting (ARCH M11, M14). Exact path, the Solana network identifier and the timeframe/aggregate parameter names: VERIFY against docs.coingecko.com before implementing. Historical depth on Demo is not stated [DA-28]; the loader records the range actually returned.
  2. Optional D17 (e): Birdeye OHLCV V3 15 s bars (retention 3 months, ≤ 5,000 records per call [DA-25]); only if the operator buys one month of Lite ($39 [DA-22]); VERIFY that OHLCV V3 is on Lite and its CU cost; respect the 5× monthly CU suspension rule [DA-V07].
  3. Pool list: the current enumeration (survivorship-biased by construction; the run is labelled `coarse_screen` and cannot pass anything, ARCH 3.4).
  4. Fills: no reserves exist in OHLCV, so impact cannot be modelled; the screen charges venue fees from the current fee tier, per-leg fixed costs and failed overhead (A-M10-03 without impact) and fills at the next bar's open. Ignoring impact makes the screen **optimistic**, which is the right bias for a kill-only test: if the strategy loses even without impact, the kill is credible (clarification C-30).
  5. The strategy runs on 60 s bars (`Bar.durationMs = 60_000`) with its registered parameters; features scale by bar duration (A-M08-02 `sqrt_time`).
  6. The run is registered in the trial registry as kind `coarse_screen` (transparency) and does **not** count toward the gate trial budget (ARCH 3.4).
- **Shared resources and concurrency:** M14's CoinGecko bucket in the research process.
- **Config:** `research.coarse.max_calls_per_month` (2,000, ≤ 2,000); `research.coarse.vendor` (`coingecko` | `birdeye`).
- **Edge cases and failure handling:** missing intervals → bars marked incomplete (no entries); 429 → back off per M14; a pool with no vendor data → excluded and counted.
- **Acceptance criteria:** Given a vendor dataset, then the bundle's `run.mode = 'coarse_screen'`, and M13 refuses to use it for any gate other than CS-1.
- **Tests:** loader on captured responses `fx/coingecko/ohlcv_minute_sample.json` (after VERIFY); CS-1 evaluation on a synthetic losing strategy. Clarification C-64 (A13): a realistic line beside the optimistic one; optimistic pass with realistic kill is labelled `fragile`.
- **Observability:** run report with call counts against the monthly budget.
- **Security notes:** the Demo key is a secret in the research machine's secret store; only pool addresses are sent.
- **Facts used:** DA-22, DA-25, DA-27, DA-28, DA-V07.
- **Definition of done:** a coarse screen can be run and imported; M13 labels it correctly.

#### A-M11-05 — Run bundles: build, sign and verify

- **Module:** M11 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Package each completed run as a canonical, signed bundle that the host can verify without trusting the research machine's transport.
- **Depends on:** A-M11-02, A-M07-03 (shared `@bot/canon` package: canonical JSON and Ed25519 research-key sign/verify). B: M29 `botctl import-run` (consumer), M13 import (A-M13-08).
- **Interfaces (ARCH M11):**

```ts
interface RunBundle { bundleVersion: 1; run: RunSpec & { runId: Id; gitCommit: string; completedAtMs: UnixMs };
  journal: TradeRecord[] /* mode backtest|replay|coarse_screen, simulated = true */; trial: { trialKey: string; returnsPerDay: number[]; returnsPerTrade: number[] };
  manifests: SegmentManifest[]; coverage: CoverageReport[]; signature: string /* Ed25519 over the canonical JSON, research key */ }
function canonicalJson(v: unknown): Uint8Array;                                            // from @bot/canon (created in A-M07-03; also used by A-M13-02)
function signBundle(b: Omit<RunBundle, 'signature'>, key: KeyObject): RunBundle;          // NEW
function verifyBundle(b: RunBundle, researchPublicKey: KeyObject): Result<true, { code: 'E_SIGNATURE' | 'E_SCHEMA' | 'E_SIZE' }>;   // NEW
```

- **Logic:**
  1. Canonical JSON: object keys sorted by Unicode code point, no insignificant whitespace, bigints as decimal strings, numbers in JavaScript's shortest round-trip form, `NaN`/`Infinity` forbidden (`E_SCHEMA`), strings NFC-normalised. The same function is used for trial keys (A-M13-02) and receipts (A-M07-03).
  2. Sign the canonical bytes of the bundle without `signature` using the research Ed25519 key with Node's built-in `crypto` (Ed25519 support on the chosen LTS is VERIFY item A-18); the key lives only on the research machine.
  3. Bundle extras for gates: B-4 per-configuration daily returns, R-4 stress results, R-6 crash-day report and stop-gap samples go in an `extensions` object (schema versioned; NEW, clarification C-31).
  4. Size cap 50 MB (POLICY); larger → `E_SIZE` (split the window).
  5. `verifyBundle` is pure and shared with the host-side import.
- **Shared resources and concurrency:** none.
- **Config:** `research.signing_key_path` (research machine only); host side: research public key in the root-owned config (M29/M25).
- **Edge cases and failure handling:** key missing → run completes but no bundle (`E_NO_KEY`); a bundle modified after signing → `E_SIGNATURE`.
- **Acceptance criteria:** Given a bundle, when any byte of the journal changes, then verification fails; given two runs with identical inputs, then identical canonical bytes (signature differs only if the key differs).
- **Tests:** unit for canonical JSON (key order, bigint, NFC); sign/verify round trip; tamper tests.
- **Observability:** CLI output with bundle SHA-256.
- **Security notes:** the research key is not the trading key and cannot move funds; compromise of it allows forged research results, which M13 still checks against host manifests (A-M13-08).
- **Facts used:** none in the register (Ed25519 availability is A-18 VERIFY).
- **Definition of done:** bundles produced by A-M11-02/03/04 verify on a clean host test.

### M12 Paper execution adapter

#### A-M12-01 — Paper `ExecutionPort`

- **Module:** M12 · **Phase:** 2 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Stand in for M16-M18 in paper mode so M19-M23 run unchanged on live data, with fills that are never better than the bracketing live snapshots.
- **Depends on:** A-M10-04, A-M04-02. B (tickets): B-M19-01 (`ExecutionPort`, `AttemptRequest`, `AttemptHandle`), B-M19-02 (`OrderManager.intent(intentId)`, clarification C-29), B-M22-05 (paper ledger `ataBalance(mint)`) for sell amounts.
- **Interfaces (ARCH M12 / M19):**

```ts
// Integration: the single ExecutionPort of @bot/types (B-M19-01), merged from C-29 and CL-27:
interface ExecutionPort {
  submit(a: AttemptRequest): Promise<AttemptHandle>;     // returns immediately with attemptId (signature null in paper)
  status(attemptId: Id): AttemptState;                   // AttemptState = 'building' | 'build_failed' | 'signing' | 'sign_refused' | AttemptStatus; paper skips 'signing' and 'landed_processed'
  onResult(h: (r: AttemptResult) => void): () => void;
  onNotLanded(h: (e: { attemptId: Id; slotsSinceFirstSend: number }) => void): () => void;
}
interface PaperExecutionPort extends ExecutionPort {}                                    // M12-owned implementation
// Also publishes topic 'fill.events' { attemptId, poolId, events: [], atMs } for each simulated fill (paper has no decoded events), so A-M01-05 sees the same topic in every mode.
// P-6 leg count (supervisor ruling, Z0D round 3): the only source of P-6's paperLegs.
interface PaperLegCounter { paperLegs(fromMs: UnixMs, toMs: UnixMs): { entryLegs: number; exitLegs: number; attemptIds: Id[] } }   // NEW
```

- **Logic:**
  1. `submit`: read the intent (side, pool, amount or sell-all, `minOutBps`, rung, landing) from M19; for sells, amount = the paper ledger balance of the mint at submit time (M22 paper `ataBalance`), mirroring the live "sell the on-chain balance" rule (CA-02). Compute `minOut` from a quote on M04's `latest()` snapshot and `minOutBps`.
  2. Draw latency from M10 (paper run RNG seeded per `run_id`); state `sending` → `sent` immediately; schedule resolution on the **wall** clock at `submit time + latency`.
  3. At resolution, bracketing snapshots from M04 `history()`: the latest at or before the fill time and the first after it (wait up to 5 s for the latter). If no fresh data (observation lag > 12 slots, or nothing within 5 s) → `expired` (pessimistic; never fill on stale data, ARCH M12).
  4. Apply `SimCore.fill` (A-M10-02) and, for exits, `notLandedSchedule` so M19's supersession and ladder run as live.
  5. Emit `AttemptResult` with `signature = null`, `failureClass`, `feeLamports` (base + priority), `balanceDeltas` computed from the fill, `events = []`, `expiryProof = null`; status `confirmed_success`, `confirmed_failed` or `expired`.
  6. Paper trades of a strategy whose stage is below `replay_passed` are labelled `shadow` downstream (M23 label, ARCH 3.4); M12 passes the strategy stage through unchanged.
- **Shared resources and concurrency:** M12 owns pending simulated attempts and their resolution timers (ARCH M12); timers are persisted only in memory — on restart, pending paper attempts resolve as `expired` (pessimistic) and are recorded so.
- **Config:** inherits `sim.param_set`; `paper.max_wait_after_ms` (5,000).
- **Edge cases and failure handling:** 1. Engine restart with pending paper attempts → resolved `expired`. 2. Pool quarantined between submit and resolution → `expired`. 3. Paper ledger balance 0 on a sell → `E_ZERO_BALANCE` path (as live, ARCH 7.3).
- **Acceptance criteria:**
  - Given a paper buy whose bracketing snapshots are 1 s and 2 s after the fill time, then the fill uses the worse of the two.
  - Given all providers down at resolution time, then the attempt is `expired` and no fill is recorded.
  - Given an exit with sampled latency above 8 slots, then M19 receives `onNotLanded` and builds a superseding attempt.
  - Given 10 paper attempts in a window (6 entry legs, 4 exit legs, including an `expired` one), then `paperLegs` returns 6 and 4 with all 10 attempt ids, whether or not A-M12-02 wrote a shadow row for them.
- **Tests:** integration with M04 recorded history and M19/M22 test doubles; replay-vs-paper equivalence (A-M11-03).
- **Observability:** metrics `paper_attempts_total{status}`, `paper_fill_latency_ms`; VM-13 `tx.*` paper values are labelled `simulated`.
- **Security notes:** paper mode loads no key (ARCH 12.2); this adapter cannot send anything.
- **Facts used:** none beyond A-M10-02's.
- **Definition of done:** paper mode runs end-to-end with group B modules; P-gate statistics computed from its journal.

#### A-M12-02 — Shadow simulations for gate P-6

- **Module:** M12 · **Phase:** 2 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Measure the fill model's error against real program execution: for paper buys and round trips, build the real transaction and `simulateTransaction` it with the simulation payer, never signing or sending.
- **Depends on:** A-M12-01, A-M06-05 (payer path and status). B: M16 `TxBuilder.buildSimulationOnly`; M24 table for shadow results (clarification C-32).
- **Interfaces:** `ShadowResult { shadowId: Id; attemptId: Id; kind: 'buy' | 'round_trip'; poolId: Pubkey; notionalLamports: Lamports; modelOut: bigint; simulatedOut: bigint | null; errorBps: number | null; contextSlot: Slot | null; status: 'ok' | 'sim_error' | 'payer_underfunded' | 'skipped'; atMs: UnixMs }` (NEW); `p6Stats(windowFromMs): { buys: number; roundTrips: number; paperLegs: number; okWithinBound: number; medianAbsErrorBps: number | null; p90AbsErrorBps: number | null; okShareBps: number | null }` (NEW, consumed by A-M13-06; `okShareBps` = 10,000 × `okWithinBound` ÷ `paperLegs`, owner item 4).
- **Logic:**
  1. For every paper **entry leg** (each buy attempt; no sampling): `buildSimulationOnly({ payer: simPayer, mint, poolId, venue, notional, shape: 'buy' })`, `simulateTransaction` (A-M06-05 settings [TH-46]); `simulatedOut` = the token balance increase of the payer's ATA in the post-simulation account data.
  2. For every paper **exit leg** (each sell attempt; no sampling): simulate the combined buy-then-sell round trip of the same size (`shape: 'buy_then_sell'`) — the payer holds none of the paper tokens, so a standalone sell cannot be simulated (ARCH M12); `simulatedOut` = lamports returned (as A-M06-05).
  3. `modelOut` = M01 `quoteExactIn` (same direction and amount) on the M04 snapshot whose `providerSlot` is closest at or before the simulation's context slot (same-state comparison isolates model error from latency); `errorBps = 10,000 × |simulatedOut − modelOut| / modelOut`.
  4. Never sign or send (ARCH M12). Payer underfunded → `payer_underfunded`, shadow off, P-6 shows `pending-data` with the reason.
  5. P-6 (owner item 4; ARCH 3.4, C-49): ≥ 50 buys and ≥ 50 round trips with median absolute error ≤ 30 bps and p90 ≤ 100 bps; **and** `okShareBps` ≥ 9,500 over at least 50 paper legs, where `okWithinBound` counts shadows with status `ok` and |`errorBps`| ≤ 100, and `paperLegs` counts **every** paper entry and exit leg in the window, read from A-M12-01's `paperLegs` (its paper attempts), never from the shadow table. A leg with no shadow (skipped, dropped by the hourly cap, `payer_underfunded`, `sim_error`) counts as a failure. `p6Stats` provides the numbers.
- **Shared resources and concurrency:** simulations at P3 on the unmetered provider, at most 1 in flight for shadows (they are not latency-sensitive).
- **Config:** `paper.shadow.enabled` (true); `paper.shadow.max_per_hour` (60, 1-600).
- **Edge cases and failure handling:** simulation error → `sim_error` (counted, excluded from the error statistics, reported separately, and counted as a failed leg in `okShareBps`); a leg the hourly cap drops → recorded as `skipped` and counted as failed, so the cap can only make P-6 harder.
- **Acceptance criteria:** Given 50 recorded paper buys with their snapshots and simulation responses, then `p6Stats` reproduces hand-computed median and p90 errors; given 100 paper legs of which 94 have `ok` shadows within 100 bps, 3 are `sim_error`, 2 were dropped by the cap and 1 is `ok` at 140 bps, then `okShareBps` = 9,400 and P-6 fails; given 49 legs all `ok`, then P-6 is `pending_data`; given 100 paper attempts in A-M12-01 of which 8 have no shadow row at all, then `paperLegs` = 100 and those 8 count as failed.
- **Tests:** unit for error statistics; integration on mainnet state, read-only and unsigned (fixtures `fx/sim/shadow_buy.json`, `fx/sim/shadow_roundtrip.json`).
- **Observability:** metrics `shadow_sims_total{kind,status}`, `shadow_error_bps` (histogram).
- **Security notes:** as A-M06-05: unsigned, payer key offline.
- **Facts used:** TH-46.
- **Definition of done:** P-6 values visible in VM-18 through A-M13-06.

### M13 Research analytics, trial registry and strategy stages

#### A-M13-01 — Phase 0 measurement study (A-24, A-24b, A-48)

**Parked parts (supervisor ruling, card Z-H-OF round 2, 2026-10-08; MR-01 parked, C-76).** Steps 2–5 (A-24, the universe count, and A-24b, the move-size study and its rule) and step 9 (the kill-only check) exist for MR-01. A-24b is parked: it was the precondition for writing MR-01's ticket. A-24 is not used by another gate or study; it is kept only as optional evidence for a revised MR version (and needs D30, which is parked). Neither runs now. Steps 6–8 (A-48 compression, the 30-day disk projection, caveats, the study-week exclusion from `W_B`) still run, and MA-0c reads only them. **PM-01 has no Phase 0 check** (round 3 item 26): nothing in this study tests PM-01, so its first evidence is gate B on `W_B`.

- **Module:** M13 (research CLI subcommand `phase0-report`) · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Measure, before any strategy code exists, whether MR-01 has a universe and moves large enough to clear its costs; this report can stop the project's main strategy cheaply (ARCH 18, CB-14).
- **Depends on:** A-M05-03 (manifests), A-M08-01 (bars), A-M07-03 (coverage), A-M10-03 (hurdle, conservative row), A-M10-01 (seeded RNG for the kill check's random entries), A-M13-03 (intervals). B: none.
- **Interfaces:** `phase0Report(input: { datasets: string[]; days: string[] }): Phase0Report` written as `docs/phase0/report-<date>.md` plus CSVs; NEW type:

```ts
interface Phase0Report {
  a24: Array<{ dayUtc: string; eligibleUpperBound: number; canonicalityUnknown: number; maxSimultaneous: number; coverage: 'full' | 'migrations_since_start' | 'none'; lowCoverage: boolean }>;
  a24Decision: { daysWithAtLeast10: number; totalDays: number; meetsUniverseRule: boolean };
  a24b: Array<{ sizeLamports: Lamports | null;                  // null = every eligible pool; else the step 4 pool set at that size
    horizonMin: 5 | 15 | 30 | 60; pooledAbsLogMoveBps: { median: number; p75: number; p90: number }; poolsContributing: number; windows: number }>;
  hurdle: { solUsd: number; bySize: Array<{ sizeLamports: Lamports; poolsInSet: number;   // C-77: lean row and $10 decide
    gStarBpsMedianPoolLean: number; gStarBpsMedianPoolStrict: number;
    fixedTermBps: Record<'usd10' | 'usd12' | 'usd59', Record<'1' | '2' | '5' | '10' | '20', number>> }> };
  a24bDecision: { bySize: Array<{ sizeLamports: Lamports; status: 'pass' | 'fail' | 'insufficient' | 'excluded'; horizonsAboveHurdle: number[] }>;
    verdict: 'proceed' | 'stop' | 'insufficient' };
  a48: Array<{ stream: string; bytesPerDayCompressed: number; codec: 'zstd' | 'gzip'; ratio: number | null }>;
  diskProjection30dBytes: number; caveats: string[];
  killCheck: {                                                    // C-48 (owner, 2026-10-07): kill-only, never passes
    prereg: { path: 'research/phase0/PREREG.md'; commitSha: string; r0ManifestSha: string; shaPrecedesFirstPull: boolean };
    primary: { configKey: string; delayBars: 1 };                  // named in the PREREG before R0
    bySize: Array<{ sizeLamports: Lamports; status: 'pass' | 'fail' | 'insufficient' | 'excluded_k';
      signals: number; excludedDepth: number;
      cells: Array<{ path: 'exit_path' | 5 | 15 | 30 | 60; delayBars: 0 | 1 | 2;
        nA: number; nB: number; verdict: 'pass' | 'fail' | 'insufficient';   // n_a, n_b ≥ 30 each to pass or fail
        meanNetLeanLamports: SignedLamports; meanNetStrictLamports: SignedLamports; meanExcessLeanLamports: SignedLamports;
        ci95NetLean: [SignedLamports, SignedLamports]; ci95ExcessLean: [SignedLamports, SignedLamports];
        fixedMonthlyTermBps: { usd10: number; usd59: number }; decides: boolean }> }>;
    killMr01: boolean; verdict: 'survives' | 'killed' | 'insufficient'; filtersMissing: string[] } }
```

- **Logic:**
  1. Window (as `research/phase0/PREREG.md` §1 defines it): D1 is the first full UTC day that starts at or after R0 + 30 h (6 h of feature warm-up plus 24 h of pool age, C-15); the window is D1 to D7. If D1-D7 hold fewer than 7 good days, the window grows one whole day at a time until it holds 7, up to D14; past D14 the report is `insufficient_days`. Days with `lowCoverage` are listed and excluded from the decision but shown.
  2. A-24 (universe): per day, the manifest's `a24.eligibleCount` (an upper bound in Phase 0, because screening is not built yet: `phase0_unscreened`), canonicality-unknown pools listed separately, enumeration coverage. Universe rule (ARCH 18): **stop MR-01** if fewer than 10 eligible pools on more than half of the days, unless Phase 3b (Raydium) is justified by the D01 trigger.
  3. A-24b (moves): from complete 15 s bars of eligible pools, non-overlapping windows at horizons 5, 15, 30 and 60 minutes; absolute log moves in bps, pooled median/p75/p90 and per-pool medians. **Unconditional only**: no signal, entry rule or strategy return is computed for A-24b (computing conditional returns here would spend the data on parameter selection) (clarification C-26). The one exception is the kill-only check in step 9, which C-48 adds and which selects nothing.
  4. Hurdle per size (DERIVED with A-M10-03; C-77): at each size of step 9 ($5, $20, $100, $1,000 and $10,000, lamports at `P_SOL` $150), `g*(x)` on the **lean** row, on each pool's median-depth state (its snapshot whose min(real, effective) quote is the median over its eligible snapshots on the good days; lower middle for an even count). At size `x` only pools whose median-depth state passes the depth cap (0.5% of min(real, effective) quote, ARCH `DEPTHPCT`) are in the pool set; the median pool is the one whose `g*(x)` is the median (lower middle), and the step 3 moves at size `x` come from the same pool set. The fixed monthly term `ceil(M_lamports × 10,000 / (30 × tradesPerDay × x))` bps, with `M` converted from USD to lamports at the recorded SOL/USD of D1 (`M_lamports = ceil(M_usd ÷ solUsd × 10⁹)`; `hurdle.solUsd`, supervisor ruling, Z0D round 4), is shown at 1, 2, 5, 10 and 20 trades a day for `M` = $10 (the real monthly cost, the 2 GB host; it decides), $12 (ARCH 2.4) and $59 (Helius Developer counted, D04); the strict row is shown beside the lean row. Neither the strict row nor the $12 or $59 line decides (C-77).
  5. Move rule per size (POLICY; the owner signs the verdict off, MA-0c): a size **passes** if, for at least one horizon in 5-60 minutes, the pooled **median** absolute move exceeds `g*(x)` (median pool, lean row) + the $10 fixed term at 10 trades a day; it **fails** if it has at least 30 windows at some horizon and passes at none; it is **insufficient** if it has fewer than 30 windows at every horizon; it is **excluded** if the size is too small by `k` (lean-row fixed share, C-77) or no pool passes the depth cap. The move rule says **stop** only when no size passes and at least one size fails; `proceed` when a size passes; otherwise `insufficient`. A size whose result rests on fewer than 10 distinct pools is labelled "(subset)" (PREREG §3). The report states the rule and the numbers; it does not decide automatically.
  6. A-48: compressed bytes per day per stream and the observed compression ratio (raw estimated from decoded size), and a 30-day disk projection against the 50 GB minimum (ARCH M07, A-27).
  7. Caveats section lists: pre-screening upper bound; enumeration coverage; that A-24b says nothing about whether drops revert (insider dumps often do not [ST-04]); that the only sub-hour evidence for MR is a negative proxy on 5-minute vendor bars and MR-01's 15 s signal is untested (ARCH 3.2, C-46); and that one week gives few signals, so the kill check's intervals are wide.
  8. The study week's data is **excluded** from `W_B` (C-26): `W_B` begins after the configurations of the stage's strategy (PM-01, or a strategy entering through the M09 slot) are pre-registered (A-M13-02; card Z-H-OF round 2 addendum item 16, since MR-01 is parked, C-76).
  9. **Kill-only conditional check (C-48; owner, 2026-10-07; supervisor rulings 2026-10-07). Not run: MR-01 is parked (C-76, owner 2026-10-08), so there is nothing for it to stop; the step stays specified for a revised MR version entering through the strategy slot, under that version's own PREREG.** It can only stop MR-01: it never passes a configuration, never feeds a gate and never moves a parameter.
     - **Anti-peek.** Every rule below is in `research/phase0/PREREG.md`, which names the primary configuration. The PREREG is frozen at R0 (the recorder's first snapshot): its commit sha is read with `git ls-remote` and stored in the R0 manifest before the first Phase 0 segment is pulled. The check compares that stored sha with M07's pull log (A-M07-03) and refuses to run if the sha was not stored before the first pull. Author dates are never used.
     - **Filters.** Signals pass the entry-time filters that exist in Phase 0, as the PREREG lists them (universe prefilter, real/effective ≥ 0.5, depth fall ≤ 10% over `L`, fee-config change, `REGIME`, the repeat block). Filters that do not exist yet (M06 authority, holder and honeypot-simulation checks; M21 limits) are listed in `filtersMissing` and as caveats.
     - **What is measured.** At the primary configuration and a delay of 1 bar (15 s): the configuration's own exit path (target, stop `a`, time stop `T`) and fixed horizons 5, 15, 30 and 60 min. Delays 0 and 2 and the other configuration are reported only.
     - **Sizes.** $5, $20, $100, $1,000 and $10,000 (lamports at `P_SOL` $150, ARCH 1.5). Impact on min(real, effective) quote depth. A size whose fixed cost on the **lean** row exceeds `k` = 1% of the stake is `excluded_k` (ARCH 2.3; A-M10-03 `fixedShareBps('lean')`); the lean row decides this exclusion because the check is stop-only (C-77), and the strict row's share is shown beside it. A signal whose size is above 0.5% of its pool's min(real, effective) quote depth at entry (ARCH 8.1 `DEPTHPCT`) is excluded at entry for that size.
     - **Tests, per cell** (path × size, 25 cells at delay 1). (a) mean net per trade > 0 on the **lean** cost row (the per-trade costs of step 4, at each size), with `n_a` = signals left after the depth cap; (b) mean excess over matched random entries > 0, with the same per-size costs, with `n_b` = signals in (a) that have at least one matched random entry. The strict (conservative) row, the $12 line and the $10 and $59 fixed-monthly lines are shown beside them and decide nothing: the tests are per trade and carry no monthly term (C-77). $10 is not a deciding size.
     - **Cell verdict** (PREREG §5.5). `pass` if both tests hold with `n_a` ≥ 30 **and** `n_b` ≥ 30; `fail` if either test fails with both counts ≥ 30; `insufficient` if either count is below 30, never a kill.
     - **Matching (C-65).** 10 random entries per signal in the same pool, the same UTC hour and the same 6 h MAD decile (A-M10-01 RNG, seed fixed in the PREREG). Candidates pass the same entry-time filters as the signals, the depth cap at the size included. A candidate whose holding window overlaps [signal − `L`, signal] is dropped.
     - **Verdict per size.** `pass` if any of its cells passes (the exit path or any one horizon); `fail` only if delay 1 fails, as a cell verdict, on the exit path **and** at every horizon from 5 to 60 min; otherwise `insufficient` (C-34), which is never a kill; `excluded_k` as above.
     - **MR-01 verdict.** `killed` only when no size passes and at least one size fails; `survives` when a size passes; otherwise `insufficient` (the A-24 and A-24b rules still apply in full). A kill is recorded in `docs/DECISIONS.md` with the PREREG's sha.
     - **Precondition of R0 (C-77; supervisor ruling, Z0D round 3). Lapsed while MR-01 is parked (C-76, owner 2026-10-08): the PREREG stays on hold, is not amended, and R0 does not wait for it; a revised MR version brings its own PREREG.** `research/phase0/PREREG.md` @ `df7d75da` (on hold) still says the strict row decides A05 (§4 "Strict row (A07): decides A05", §5.3-§5.5). If MR-01 testing goes on, the PREREG is amended before R0 to the lean row and to this step's cell, size and verdict rules. The check reads the PREREG's deciding row and refuses to run (`prereg_mismatch`) if it is not the lean row.
- **Shared resources and concurrency:** reads pulled segments on the research machine only.
- **Config:** CLI flags `--days`, `--notional-lamports`, `--fixed-monthly-usd`, `--sol-usd`; the kill check reads every rule from the PREREG, never from flags.
- **Edge cases and failure handling:** fewer than 7 good days by D14 → report produced with `insufficient_days` and no decision; enumeration fell back to migrations → caveat and the universe count is labelled lower-coverage.
- **Acceptance criteria:**
  - Given the recorded week, then the report is reproducible byte-for-byte from the same inputs and contains both decision fields and the kill check.
  - Given synthetic data with 5 eligible pools per day, then `meetsUniverseRule = false`.
  - Given synthetic bars where, at every size with ≥ 30 signals, delay 1 fails on the exit path and at every horizon, then `killMr01 = true`.
  - Given synthetic bars where the exit path fails but the 15-min horizon passes both tests at $100, then the size passes and MR-01 survives.
  - Given fewer than 30 signals at every size, then the verdict is `insufficient` and `killMr01 = false`.
  - Given a cell where test (a) fails with `n_a` = 40 but only 25 signals have a matched random entry (`n_b` = 25), then that cell is `insufficient`, not `fail`.
  - Given a signal whose size is 0.4% of effective quote depth but 0.6% of the real quote, then it is excluded at that size.
  - Given a PREREG whose deciding row for A05 is the strict row, then the kill check refuses to run with `prereg_mismatch`.
  - Given moves that beat the hurdle at $100 but fail at $5 and $10,000 (each with ≥ 30 windows), then the move rule is `proceed`; given every judged size failing, it is `stop`; given a strict-row hurdle above the move but a lean-row hurdle below it, then the size passes.
  - Given good days D1-D5 and low-coverage days D6-D7 and D8-D9 good, then the window is D1-D9; given fewer than 7 good days by D14, then `insufficient_days`.
  - Given a PREREG sha that the R0 manifest does not hold, or that was stored after the first pull in M07's pull log, then the kill check refuses to run.
  - Given a random candidate whose holding window overlaps [signal − `L`, signal], then it is dropped.
- **Tests:** unit for horizon windowing and quantiles; golden report on a synthetic dataset.
- **Observability:** report only.
- **Security notes:** none.
- **Facts used:** EX-07, ST-04, ST-27.
- **Definition of done:** report reviewed and signed off by the product owner; decision recorded in the project log; A-M09-02 unblocked or MR-01 stopped (by the universe rule, the move rule or the kill check).

#### A-M13-02 — Trial registry, configuration key, trial key and pre-registration

- **Module:** M13 · **Phase:** 1 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Make every evaluated configuration count against the multiple-testing budget, and make it impossible to evaluate a gate on a configuration other than the one registered (CA-24).
- **Depends on:** A-M07-03 (shared `@bot/canon` package: `canonicalJson`). B: M25 `ConfigFieldSchema.affectsReturns`; M24 `trial_registry` table.
- **Interfaces (ARCH M13, plus NEW):**

```ts
interface Analytics {
  trialKey(strategyId: string, params: Record<string, unknown>, config: Config, costModelVersion: string, fillModelVersion: string, datasetHashes: string[], assumePassUnavailable?: boolean /* C-78 */): string;
  registerTrial(t: { strategyId: string; trialKey: string; kind: 'coarse_screen' | 'gate'; datasetHashes: string[]; returnsPerDay: number[]; returnsPerTrade: number[]; runId: Id }): Result<void, { code: 'E_REPLAY_ASSUMED' }>;   // the replay key is read from the run's RunSpec in the run registry (C-78)
}
interface TrialIdentity {                                                                   // NEW (clarification C-33)
  configKey(strategyId: string, strategyVersion: string, params: Record<string, unknown>, config: Config, costModelVersion: string, fillModelVersion: string): string;
  preRegister(p: { strategyId: string; strategyVersion: string; configs: Array<Record<string, unknown>>; config: Config;
    costModelVersion: string; fillModelVersion: string; atMs: UnixMs }): Result<{ configKeys: string[] }, { code: 'E_ALREADY_REGISTERED' | 'E_BUDGET' }>;
}
```

- **Logic:**
  1. `affectsReturnsSubset(config)` = every key whose schema has `affectsReturns = true` (M25), sorted, with values canonicalised (bigints as strings).
  2. `configKey = sha256(canonicalJson({ strategyId, strategyVersion, params, affectsReturns: subset, costModelVersion, fillModelVersion }))`.
  3. `trialKey = sha256(canonicalJson({ configKey, datasetHashes: sorted }))`, with `assumePassUnavailable: true` added to the hashed object only when a B-10 run's replay key is on (C-78; A-M11-01 step 8), so a key-off trial key is unchanged and a key-on run never shares one. The ARCH signature is kept; `trialKey` identifies an evaluation on specific data, `configKey` identifies the configuration across stages (clarification C-33).
  4. `preRegister`: records the strategy's configuration set **before** `W_B` data begins (C-26); refuses if the set size exceeds the MinBTL budget for the planned `W_B` length and an assumed best annualised Sharpe of 2 (ARCH 3.4 table: 2 configurations at 30 days) (`E_BUDGET`).
  5. `registerTrial`: append-only row, unique `(trial_key, kind)`; `coarse_screen` trials are stored but excluded from gate budgets (ARCH 3.4); `registerTrial` reads the replay key from the `RunSpec` that the run registry holds for `runId` (never from the caller) and returns `E_REPLAY_ASSUMED` for a run with the key on, writing nothing (C-78).
  6. Mismatch rule: an evaluation whose live or bundle `configKey` differs from the stage's frozen `configKey` is rejected `E_TRIAL_MISMATCH` (A-M13-06).
- **Shared resources and concurrency:** M13 owns `trial_registry` (append-only, ARCH 7.2); writes in one transaction.
- **Config:** none.
- **Edge cases and failure handling:** M25 schema missing `affectsReturns` on a key → treated as `true` (conservative: more changes count as new trials); NaN/Infinity in params → `E_SCHEMA`.
- **Acceptance criteria:** Given two configs differing only in a key with `affectsReturns = false`, then equal `configKey`s; differing in an `affectsReturns = true` key or the fill-model version, then different keys; given three configurations for a 30-day `W_B`, then `preRegister` → `E_BUDGET`; given a `registerTrial` call whose `runId` names a run whose `RunSpec` has `assumePassUnavailable = true`, then it returns `E_REPLAY_ASSUMED` and no `trial_registry` row is written.
- **Tests:** unit; property: key stability under key-order permutation of input objects. Clarification C-63 (A12): exclusions at entry time only, no field observed after the decision; regime boundaries B2-B4 as breaks; viewed-window ledger.
- **Observability:** log `M13.trial_registered`, `M13.preregistered`.
- **Security notes:** registry rows are immutable (M24 triggers reject UPDATE/DELETE).
- **Facts used:** ST-29, ST-31, ST-34.
- **Definition of done:** keys used by A-M11-*, A-M13-05/06/08.

#### A-M13-03 — Statistics library

- **Module:** M13 · **Phase:** 0-1 (pure; can start on day 1) · **Size:** L (≈ 2.5 engineer-days)
- **Goal:** Correct, tested implementations of every statistic the gates use.
- **Depends on:** A-M10-01 (RNG only). B: none.
- **Interfaces:**

```ts
interface Stats {                                                                          // NEW (package @bot/stats; pure)
  mean(x: number[]): number; skew(x: number[]): number | null; kurtosisNonExcess(x: number[]): number | null;   // null if n < 30 [ST-32]
  stationaryBootstrapMeanCi(x: number[], o: { resamples: 10_000; level: 0.95; rng: Rng; meanBlock?: number }): { low: number; high: number; meanBlockUsed: number };
  wilson(k: number, n: number, level: 0.95): { low: number; high: number };
  tStatMean(x: number[]): number | null;
  loSharpeSe(sr: number, t: number): number;                                               // sqrt((1 + sr²/2)/T) [ST-33]
  psr(sr: number, srRef: number, n: number, skew: number, kurt: number): number;
  dsr(sr: number, trialSrs: number[], n: number, skew: number, kurt: number): number;     // [ST-29]
  minTrl(sr: number, srRef: number, skew: number, kurt: number, alpha: 0.05): number;      // [ST-32]
  minBtlYears(nTrials: number, eMaxAnnualSharpe: number): number;                          // expression from ARCH 3.4 (UNVERIFIED, A-44)
  maxTrialsForWindow(windowYears: number, eMaxAnnualSharpe: number): number;
  cscvPbo(dailyReturnsByConfig: number[][], partitions: 16): number;                       // [ST-30]; requires ≥ 4 configs
  rankStability(dailyReturnsByConfig: number[][]): { selectedFirstHalf: number; stillBestSecondHalf: boolean };
  studentizedTsBootstrapSharpeDiff(a: number[], b: number[], o: { resamples: number; rng: Rng }): { low: number; high: number };   // [ST-36]
  nonInferiorityLowerBound(live: number[], paper: number[], o: { level: 0.95; rng: Rng }): number;   // one-sided lower bound of (mean live − mean paper)
  normInv(p: number): number;
}
```

- **Logic:**
  1. Stationary bootstrap [ST-35] with 10,000 resamples (POLICY, ARCH 3.4) and a seeded RNG; mean block length POLICY `b = max(1, round(n^(1/3)))`, and the reported interval is the **most conservative** (lowest lower bound) of runs at `b/2`, `b` and `2b` (clarification C-34).
  2. MinTRL (observations) = `1 + (1 − skew·sr + (kurt − 1)/4 · sr²) · (Z_{1−α} / (sr − srRef))²` with non-excess kurtosis [ST-32]; moments need ≥ 30 observations [ST-32].
  3. Lo's IID standard error `sqrt((1 + SR²/2)/T)` [ST-33], shown only as a lower bound on uncertainty (serial correlation can overstate Sharpe by up to 65% [ST-33]).
  4. PSR/DSR: DSR is a PSR whose threshold is the expected maximum Sharpe under the null, rising with the number of trials and the variance of trial Sharpe ratios, and using sample length, skew and kurtosis [ST-29]. The exact formulas are not in the register: VERIFY against the paper PDF (Bailey & López de Prado 2014, [ST-29]) before implementing, and test against the paper's worked example (N = 46 giving 0.9505 [ST-29 note]; the other inputs of that example must be read from the paper, since the register marks them unverified). With one trial the threshold is `srRef = 0`.
  5. MinBTL: ARCH 3.4 quotes `MinBTL ≈ [(1 − γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e))]² / E[max_N]²`, γ ≈ 0.5772; this expression is UNVERIFIED (A-44) and must be confirmed against the paper [ST-31] before merging. Tests reproduce the register's examples (45 configurations at 5 years and 7 at 2 years with E[max] = 1 [ST-31]; ARCH DERIVED 5.00 and 1.92 years) and the ARCH 3.4 budget table (14/30/60/91 days × Sharpe 2/3/5). N = 1 → 0 years (no multiple-testing penalty).
  6. CSCV/PBO [ST-30]: split the daily return matrix into 16 equal row blocks, evaluate all C(16, 8) = 12,870 train/test combinations, choose the best in-sample configuration, compute its out-of-sample relative rank ω, logit `λ = ln(ω/(1 − ω))`; PBO = fraction of combinations with `λ ≤ 0`. Only with ≥ 4 configurations (ARCH 3.4 B-4).
  7. Rank stability (B-4 with ≤ 3 trials): the configuration with the higher mean on the first half of `W_B` must also have the higher mean on the second half.
  8. t-statistic of the mean (B-6 threshold 3.0 [ST-34]).
  9. Studentized time-series bootstrap for Sharpe differences [ST-36] (Jobson-Korkie/Memmel is invalid under heavy tails [ST-36]); used for reporting comparisons.
  10. Non-inferiority (LS-3): independent stationary bootstraps of live and paper per-trade returns; one-sided 95% lower bound of `mean(live) − mean(paper)`; the test **rejects** "live ≤ paper − δ" when that bound > −δ, with δ = 50% of the paper mean (ARCH 3.4). Resampling the paper side too is the conservative reading (C-34).
  11. `normInv`: a published high-precision approximation of the inverse normal CDF (POLICY; tested against tabulated values, for example 1.6448536 at 0.95).
- **Shared resources and concurrency:** pure.
- **Config:** none (resample counts are POLICY constants; changing them is a code change).
- **Edge cases and failure handling:** empty or constant series → `null` statistics (never 0 or Infinity); NaN inputs → throw `E_INPUT`.
- **Acceptance criteria:** MinTRL reproduces ARCH's table (1,085 / 273 / 70 trades at per-trade Sharpe 0.05 / 0.10 / 0.20 with skew 0, kurtosis 3) within ±1 trade; the MinBTL tests in step 5 pass; Wilson matches published reference values; PBO on a synthetic matrix where one configuration dominates both halves → PBO near 0, and on pure noise → near 0.5.
- **Tests:** unit with hand-computed values (ARCH 16.4); property tests (CI contains the mean of a large-n normal sample at the nominal rate within ±1 point over 1,000 seeded repetitions).
- **Observability:** none (library).
- **Security notes:** none.
- **Facts used:** ST-29, ST-30, ST-31, ST-32, ST-33, ST-34, ST-35, ST-36, VF-13.
- **Definition of done:** library merged with the reproduction tests; the two VERIFY items (DSR formula, MinBTL expression) resolved with the paper page cited in code comments.

#### A-M13-04 — Performance statistics, `equity_point` and flow-adjusted drawdown

- **Module:** M13 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Produce `PerfStats` (VM-09), the equity and drawdown series (VM-10), PnL periods (VM-11) and the monthly-net-after-fixed figure (gates P-2b, LS-3b), with every money statistic flow-adjusted.
- **Depends on:** A-M13-03. B (tickets): B-M24-02 (`equity_point` table). Runtime sources (not build dependencies): B-M22-01 `balances()` and the cash-flow topic; B-M23-02 `TradeRecord`s; B-M23-03 fixed-cost items and SOL/USD (`price_reference`); B-M21-04 calls `recordMinute`.
- **Interfaces (ARCH M13 `PerfStats`; NEW accessors):**

```ts
interface Analytics { perf(filter: { strategyId?: string; mode?: Mode; fromMs?: UnixMs; toMs?: UnixMs; excludeShadow?: boolean; excludeRecovered?: boolean }): PerfStats }
// Integration (C-35 = CL-35): the one flow-adjustment formula, pure and exported for B-M21-04 and for imported-run series:
function flowAdjustedStep(prev: { index: number; equityLamports: Lamports }, equityLamports: Lamports, flows: CashFlow[], includesCold: boolean): { index: number; crossingFlowLamports: SignedLamports } | { gap: 'zero_equity' };
interface EquitySeries {                                                                   // NEW
  recordMinute(atMs: UnixMs, mode: Mode, equityLamports: Lamports, index: number, drawdownBps: Bps): void;   // writes equity_point; called by B-M21-04 (live/paper), the single live instance (integration, replaces onMinute)
  series(kind: 'equity' | 'drawdown' | 'pnl_per_trade' | 'pnl_daily', q: { mode: Mode; strategyId?: string; fromMs: UnixMs; toMs: UnixMs; resolution: 'trade' | '1m' | '5m' | '1h' | '1d' }):
    { t: number[]; v: number[]; gaps: Array<{ fromMs: number; toMs: number; reason: string }>; baseline: number | null; simulated: boolean };
  pnlPeriods(mode: Mode): Record<'today_utc' | 'd7' | 'd30' | 'since_live_start' | 'all', { netPnlLamports: SignedLamports; tradeCount: number; winRateBps: number | null; equityChangeBps: number | null }>;
}
```

- **Logic:**
  1. Trades come from M23 `trade` rows filtered by mode, strategy and window; `shadow` and `recovered` rows excluded on request (gate use always excludes them, CA-22, CA-28).
  2. PerfStats fields per ARCH: counts; `winRateBps`; `winRateCi` Wilson 95% (POLICY); gross, costs, net; `expectancyNetLamports` and `expectancyNetBps` (mean net per trade, bps of entry cost); `expectancyCi` stationary bootstrap 95% with 10,000 resamples (computed when n ≥ 30, else `null`, clarification C-34); averages; `profitFactor` = sum of wins / |sum of losses| as `DecimalStr`, `null` without losses; `skew`, `kurtosis`, `minTrlTrades` null below 30 trades [ST-32]; `dsr` and `pbo` from the latest gate evaluation; `sampleSufficient = tradeCount ≥ minTradesRequired`, `minTradesRequired = max(MinTRL, stage minimum)` (B-1 300, R-1 max(300, `n_80`) per A-M13-06 step 4, P-1 100, LS-1 100); `edgeStatus = 'positive'` only when `expectancyCi.lowLamports > 0`, `'negative'` when `highLamports < 0`, else `'unproven'` (VM-09 rule).
  3. Flow adjustment (CA-17; clarification C-35): each minute, `r_t = (E_t − CF_t) / E_{t−1} − 1`, where `CF_t` is the net external cash flow in the minute **across the boundary of `E`**: `refill` counts only if the cold wallet is not part of `E`; `sweep` counts (as an outflow) only if the cold wallet is not part of `E`; `sim_funding` is internal (the simulation payer is part of `E`, ARCH 1.5); `external_in`/`external_out` always count. Index `I_t = I_{t−1} × (1 + r_t)`, `I_0 = 1`. This step is the exported pure `flowAdjustedStep`; in live and paper the running instance is B-M21-04 (per second, for the breakers), which writes each minute's values through `recordMinute`, so VM-10 and the breakers can never disagree (integration). `drawdownBps = floor((I_t / max_{s≤t} I_s − 1) × 10,000)` (≤ 0). Written to `equity_point (minute, mode, equity_lamports, flow_adjusted_index, drawdown_bps)` (ARCH 15).
  4. Max drawdown in PerfStats: from `equity_point` in live/paper; from the run's simulated equity series for imported runs. `maxDrawdownLamports` = peak-to-trough of `E` scaled by the index (flow-free).
  5. `monthlyNetAfterFixedUsdE6`: trades per day = trades / window days; `point = mean_net × tradesPerDay × 30 − fixedMonthlyLamports`, `ciLow = expectancyCi.low × tradesPerDay × 30 − fixedMonthlyLamports`, converted to micro-USD at the current SOL/USD (M23); `null` if the price or CI is unknown (never 0).
  6. Series for VM-10: `equity` (marked `E`), `drawdown` (flow-adjusted), `pnl_per_trade`, `pnl_daily`; gaps where `equity_point` rows are missing.
- **Shared resources and concurrency:** M13 owns `equity_point` (append-only) and computed metric snapshots (ARCH 7.2). Minute writer on the event loop; `perf` cached 60 s and invalidated on trade close (VM-09 freshness).
- **Config:** `analytics.equity.includes_cold` (bool; must equal M22's setting; validation cross-check).
- **Edge cases and failure handling:** `E_{t−1} = 0` → `r_t` undefined → index carried, gap recorded; a minute with no equity reading (engine down) → gap; trades with `no_data` flags included (pessimistic) and counted.
- **Acceptance criteria:**
  - Given random interleavings of trades, sweeps, refills and external transfers, then drawdown and daily loss equal those of the trades alone (ARCH 16.2).
  - Given 29 trades, then moments, MinTRL and the expectancy CI are null and `edgeStatus = 'unproven'`.
  - Given a CI lower bound of +1 lamport, then `positive`.
- **Tests:** property test for flow invariance; unit for each field; VM-09/VM-10 contract fixtures with M28's schema (test double). Clarification C-70 (A22): a mean capped at +19, outcome bins, the loss bill, week-clustered intervals, and the top 1% of trades supplying at most 50% of P&L.
- **Observability:** metrics `equity_lamports`, `drawdown_bps` (current), `perf_compute_ms`.
- **Security notes:** none.
- **Facts used:** ST-26, ST-32, ST-33, ST-35, ST-39.
- **Definition of done:** VM-09/VM-10/VM-11 sources live in paper mode.

#### A-M13-05 — Strategy stage machine and evaluation windows

- **Module:** M13 · **Phase:** 1 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Track each strategy's evidence stage separately from the system mode, with disjoint, time-ordered windows, so no data is used by two gates (CA-22).
- **Depends on:** A-M13-02. B: M24 `strategy_stage` table; M26 (executes `set_mode` promotions and auto-demotions; publishes them); M28 (VM-18 top-level fields).
- **Interfaces (ARCH M13):**

```ts
interface Analytics {
  stage(strategyId: string): { stage: StrategyStage; enteredAtMs: UnixMs; trialKey: string; windowsUsed: Array<{ gate: string; fromMs: UnixMs; toMs: UnixMs }> };
}
interface StageMachine {                                                                     // NEW
  onGateEvaluation(e: GateEvaluation): void;                         // auto transitions for backtest/replay/paper
  onModeCommand(e: { strategyId: string; to: 'live_small' | 'live'; atMs: UnixMs; commandId: Id }): void;   // from M26
  onDemotion(e: { strategyId: string; reason: 'L-1' | 'L-2' | 'L-4' | 'operator'; atMs: UnixMs }): void;
  archive(strategyId: string, actor: Actor): void;
  cooldownUntil(strategyId: string): UnixMs | null; minDwellUntil(strategyId: string): UnixMs | null;
  windowsFile(): string;                                             // export for md-pull (A-M07-03 step 5)
}
```

- **Logic:**
  1. Stages (ARCH 3.4): `research` (entered at pre-registration) → optional `coarse_screened` (a CS-1 evaluation that did not kill) → `backtest_passed` → `replay_passed` → `paper_passed` → `live_small` → `live`; plus `failed` and `archived`. Each record: stage, `stage_entered_at`, frozen strategy version, frozen `configKey`, the passing evaluation's `trialKey`, windows used, entered by (append-only).
  2. Automatic transitions on an all-pass evaluation: → `backtest_passed`, → `replay_passed`, → `paper_passed` (P-1..P-6, P-9 and P-10; P-7/P-8 are evaluated at the promotion command, ARCH 3.4). `backtest_passed` needs B-1..B-10, including B-9 and B-10 (C-49). Promotions to `live_small` and `live` happen only on M26's executed A3 command.
  3. Failure: a B, R or P evaluation with **sufficient data** (every count/duration gate met) and any statistical gate failing → `failed` (D08: stop; do not search further on the same data). Insufficient data → stays, `pending_data`.
  4. Demotion (L-1, L-2, L-4 or operator) → stage drops to `replay_passed`, `cooldown_until = now + 7 days`; a fresh `W_P` starts after the cooldown (ARCH 3.4, 7.7).
  5. Windows: `W_B` ≥ 30 days, `W_R` ≥ 14 days after `W_B`, `W_P` ≥ 21 days after `replay_passed`, `W_LS` ≥ 14 days after promotion (ARCH 3.4). Every evaluation window must start at or after the current `stage_entered_at` and must not overlap any window already used by an earlier gate of the same strategy (`E_WINDOW_OVERLAP`). `min_dwell_until = stage_entered_at + the stage's minimum window`.
  6. `windowsFile()` lists the date ranges of open and used windows so the operator's `md-pull` never deletes those days (A-M07-03).
- **Shared resources and concurrency:** M13 owns `strategy_stage` (append-only; key `(strategy_id, stage_entered_at)`, ARCH 7.2); single writer; demotion events processed in arrival order; a promotion command arriving after a demotion is rejected by M26's re-validation (CA-19).
- **Config:** `stages.cooldown_ms` (604,800,000; ≥ that value, lowering is forbidden); minimum window lengths as POLICY constants (raising allowed by config, lowering forbidden).
- **Edge cases and failure handling:** restart → stages loaded from the table; clock skew → windows use the sim or wall clock of the data, never "now" for past data.
- **Acceptance criteria:** Given an evaluation whose window overlaps `W_B`, then `E_WINDOW_OVERLAP`; given an auto-demotion, then the stage is `replay_passed`, `cooldown_until` = now + 7 days, and a later P evaluation using pre-demotion paper trades is rejected.
- **Tests:** property-based state-machine test (terminal `failed`/`archived` absorbing; windows never overlap); unit for dwell and cooldown. Clarification C-63 (A12): windows record the viewed-window ledger; dust and start-missing counts carry a −100% line.
- **Observability:** metric `strategy_stage{strategy}` (enum gauge); log `M13.stage_changed` (from, to, reason).
- **Security notes:** stage records are immutable history; a stage can only be raised by evidence or by an A3 command.
- **Facts used:** ST-24, ST-37.
- **Definition of done:** stage machine merged; VM-18 top-level fields (`strategy_id`, `strategy_stage`, `stage_entered_at`, `trial_key`; UC-09) available to M28.

#### A-M13-06 — Gate evaluation (CS, B, R, P, LS)

- **Module:** M13 · **Phase:** 1 (CS, B, R), 2 (P), 3 (LS) · **Size:** M (≈ 2 engineer-days)
- **Goal:** Evaluate every promotion gate of ARCH 3.4 exactly, returning the `GateEvaluation` that VM-18 shows and M26 enforces; insufficient data is `pending-data`, never `pass`.
- **Depends on:** A-M13-03, A-M13-04, A-M13-05, A-M13-08. B: none at build time (the `ExternalGateInputs` implementation is B-M26-04's adapter, injected at engine start; until it exists every external input is unavailable and its gate fails `input_unavailable`). **B-gate inputs come in M2, not M3** (supervisor ruling, Z0D round 3): this ticket ships an M2 implementation of `replayDeterminism` and `historyReplay` that reads only bundles imported by A-M13-08 (A-M11-01's 10-replay run record in the A-M11-05 bundle; card Z-H's report), so B-9 and B-10 can be decided at the M2 exit; B-M26-04's M3 adapter wraps the same implementation for those two fields and adds `dryRun` and `faultInjection`. Runtime sources behind the adapter: M26 (drill records for P-7, checklist and phrase for P-8, cooldown); M22 (paper-ledger differences for P-5, reconciliation for LS-5, `E` for P-9); M23 (fixed-cost items, realised vs modelled costs for LS-2); M18 (landing statistics for LS-4); M17 via M26 (signer lock-mode capability for LS-7); M07 coverage; M28 (VM-18 schema).
- **Interfaces (ARCH 5.0a `GateResult`, `GateEvaluation`; ARCH M13 `evaluateGates`):**

```ts
interface Analytics { evaluateGates(strategyId: string, target: 'backtest_passed' | 'replay_passed' | 'paper_passed' | 'live_small' | 'live'): GateEvaluation }
interface ExternalGateInputs {                                                              // NEW (implemented by B-M26-04's adapter and injected at engine start; clarification C-39)
  drills(): { haltAckMsMax: number | null; cliKillBlocksSigning: boolean | null; lastDrillAtMs: UnixMs | null };          // P-7
  checklist(): { allTicked: boolean; items: Array<{ itemId: string; ticked: boolean }> };                                 // P-8 (phrase, step-up and delay are M26's)
  paperLedgerUnexplainedDiffs(fromMs: UnixMs, toMs: UnixMs): number;                                                      // P-5
  fixedMonthlyLamports(): Lamports | null; equityLamports(): Lamports;                                                     // P-9, P-2b, LS-3b
  realisedVsModelledCost(fromMs: UnixMs, toMs: UnixMs): { realisedLamports: Lamports; modelledLamports: Lamports; trades: number };   // LS-2
  landing(fromMs: UnixMs, toMs: UnixMs): { sent: number; confirmedWithin20Slots: number };                                 // LS-4
  reconciliation(fromMs: UnixMs, toMs: UnixMs): { maxDailyDiffLamports: SignedLamports; unexplainedOursBalances: number }; // LS-5
  signerUnlockOption(): 'manual' | 'host_bound_exits_only' | 'kms';                                                         // LS-7
  // Owner pre-funding items (2026-10-07, C-49). Each returns null when unavailable; null fails its gate with input_unavailable.
  // Producers (supervisor ruling, Z0D round 3): one producer per field, never a second source.
  replayDeterminism(runId: Id): { runId: Id; buildSha: string; configKey: string; assumePassUnavailable: boolean; replays: number;
    decisionLogSha256: string[]; identical: boolean } | null;                       // B-9 (item 1) ← A-M11-01's 10-replay run record, via the A-M11-05 bundle (M2)
  historyReplay(buildSha: string, configKey: string): { buildSha: string; configKey: string;
    source: 'old_faithful_archive';                          // owner, 2026-10-08 about 7:25 AM: "Old faithful but by batch to avoid blockage"; the Helius download (b) and options (a), (c) not chosen (C-79)
    pullRef: { pullId: string; commitSha: string; blobSha: string } | null;   // the pinned B10-PULL row; source, frozen scanner revision and day list are read from it, never from this report
    scannerRevision: string;                                 // the frozen archive scanner revision every unit of every day carries
    daysUsed: Array<{ dayUtc: string; coverage: { unitsPlanned: number; unitsRead: number; parentChainIntact: boolean; qaStrict: boolean;
      parity: boolean; determinism: boolean; failures: number; complete: boolean } }>;
    unitLog: { path: string; sha256: string };             // the pull's per-unit log in the private store (unit range, revision, file sha256, blocks, bytes, CID checks): the coverage evidence
    universe: { selection: 'chain_only'; survivorshipFree: boolean; listSource: string; listSha256: string;
      listFile: { path: string; sha256: string; writtenAtMs: UnixMs } };   // written by the pull job before the replay
    replayRunId: Id } | null;                               // crashes, illegal states, unreconciled intents come from this A-M11-01 run record, not from the report; it must be a completed, non-low_coverage B-10 run under the same pull, key on, covering daysUsed, with ≥ 1 entry and ≥ 1 exit per strategy (step 3)
    // B-10 (item 2) ← card Z-H's report, via A-M13-08 import (M2)
  dryRun(buildSha: string, configKey: string): { buildSha: string; configKey: string;   // every block of every build in the promoted build's lineage, any configKey, none omitted
    blocks: Array<{ blockId: Id; buildSha: string; blockDeclaredAtMs: UnixMs; blockFromMs: UnixMs; blockToMs: UnixMs; status: 'running' | 'passed' | 'failed' | 'aborted';
      fullWorkerHours: number; uptimeBps: number; restartDrills: number; disconnectDrills: number; decisionsWithoutReasons: number }>;
    fixes: Array<{ failureId: Id; fixCommitSha: string; inPromotedBuild: boolean; notInFailingBuild: boolean; namesFailureId: boolean; failingThenPassingTest: boolean; ciRunOnParentFails: string | null; ciRunOnFixPasses: string | null; mergedViaReviewedPr: boolean }> } | null;   // P-5 (item 3) ← B-M26-04 (M3)
  engineHelius(fromMs: UnixMs, toMs: UnixMs): { minutesWithoutHelius: number; b10ReservationActiveMinutes: number /* [not chosen, C-79]: no B-10 Helius reservation exists, so always 0 */ } | null;   // every P gate (Z0D round 8) ← A-M14-05 ledger, via B-M26-04 (M3)
  shadowCoverage(fromMs: UnixMs, toMs: UnixMs): { paperLegs: number; okWithinBound: number; okShareBps: number } | null;  // P-6 (item 4) ← A-M12-02 p6Stats only (paperLegs from A-M12-01's paper attempts)
  faultInjection(buildSha: string, configKey: string): { buildSha: string; configKey: string;   // every run of every build in the promoted build's lineage, any configKey, none omitted
    runs: Array<{ runId: Id; buildSha: string; atMs: UnixMs; cases: Array<{ caseId: 'timeout' | 'stale_feed' | 'rate_limit' | 'restart_mid_trade'; pass: boolean }> }>;
    fixes: Array<{ failureId: Id; fixCommitSha: string; inPromotedBuild: boolean; notInFailingBuild: boolean; namesFailureId: boolean; failingThenPassingTest: boolean; ciRunOnParentFails: string | null; ciRunOnFixPasses: string | null; mergedViaReviewedPr: boolean }> } | null;   // P-10 (item 5) ← B-M26-04 (M3)
}
```

- **Logic (one `GateResult` per gate; units per UC-09; dimensionless values use unit `ratio` with a `DecimalStr`):**
  1. Common: data window per A-M13-05; trades exclude `shadow` and `recovered`; `configKey` must equal the stage's frozen key (`E_TRIAL_MISMATCH` → all gates fail with that blocking reason); B and R only from imported bundles (A-M13-08), never from runs on the host; `coarse_screen` runs only for CS-1. **Cost row for return-based gates (C-77; supervisor ruling, Z0D round 5).** Every gate computed from trade returns, in B, R and P (B-2, B-6, B-8, R-2, R-3, R-4, P-2, P-2b, P-3 and any other return-based one), uses net returns on the **conservative** cost row (A-M10-03 step 9) plus the D04 fixed cost amortised per trade at the window's trade rate (`fixedCostBpsPerTrade`; $59 a month, Helius Developer counted, until the owner rules on D04). No return-based gate is computed on the lean row or the default model. In P, the paper fills' modelled costs use the same row. **Key-on runs (C-78).** A run with the replay key on (A-M11-01 step 8) is excluded as a whole from every statistic of gates B, R and P, as a `low_coverage` run is: trade counts, returns, confidence intervals, drawdowns, power, the trial returns behind B-3..B-5, and B-9. Any decision tagged `replayAssumed` found elsewhere, and the trades that follow it, are excluded too. B-10 reads only the key-on run record's crash, illegal-state and unreconciled-intent counts. B-9 is read only from a 10-replay record with `assumePassUnavailable = false`.
  2. CS-1 (kill-only): if, for every pre-registered configuration, the bootstrap 95% CI upper bound of after-cost mean per trade is < 0 → strategy `failed`; otherwise nothing changes (passing proves nothing).
  3. B-1 ≥ 300 closed trades in `W_B` for the selected configuration; B-2 net mean CI lower bound > 0 on the **conservative** cost row (A-M10-03 step 9) with the D04 fixed cost amortised per trade at the `W_B` trade rate (`fixedCostBpsPerTrade`; $59 a month, Helius Developer counted, until the owner rules on D04) (C-77); B-3 DSR ≥ 0.95 given all `gate` trials on data overlapping `W_B` (across all strategies, conservative; clarification C-40); B-4 PBO ≤ 0.05 via CSCV (16 partitions, daily matrices) when trials ≥ 4, else rank stability; B-5 trials ≤ `maxTrialsForWindow(W_B length, observed best in-sample annualised Sharpe)`; B-6 t ≥ 3.0 [ST-34]; B-7 max drawdown at intended live sizing ≤ 20% of `E`; B-8 positive mean in the final untouched 20% of `W_B` and in each calendar week of `W_B`; B-9 (owner item 1) `replayDeterminism` shows 10 replays with identical decision-log hashes (fewer than 10, any mismatch or null → fail); B-10 (owner item 2, **DECIDED**: owner, 2026-10-08 about 7:25 AM: "Old faithful but by batch to avoid blockage", which replaces the owner's 12:50 AM choice "B" (the capped Helius download, not chosen; C-79); Meme-snipe `CLAUDE.md` "History for the past-data test"; ARCH 3.4) `historyReplay(buildSha, configKey)` of the evaluated build and the stage's frozen `configKey` (a different `buildSha` or `configKey` in the report → fail `E_TRIAL_MISMATCH`). Until card Z-H's report on the Old Faithful pull exists the input is null and B-10 fails closed with `pending:B-10`, so `backtest_passed` cannot be reached. With the report: `source` = `old_faithful_archive` (any other source fails); `pullRef` names the **pinned** `B10-PULL` row of Meme-snipe `docs/DECISIONS.md`: its id, the commit and the file's blob hash, the same pin the pull job took at its first batch; the commit must be on the integration branch (ARCH 3.4), and the bundle carries the file so the hash is checked; `B10-PULL` rows are append-only with an immutable id (any change is a new id), written by the supervisor only, quoting the owner's 8 Oct decision and its time word for word, and the row must contain `B10-PULL id=<immutable id> source=old-faithful scannerRev=<revision> days=<UTC date>..<UTC date>[,<UTC date>..<UTC date>] pinnedAt=<ISO-8601 UTC>`; the evaluator reads the source, the revision and the day list **from that row only**, never from the report; `scannerRevision` equals the row's `scannerRev`; at least 30 **distinct** UTC days in `daysUsed`, every one inside the row's day list and clean, where clean means `coverage.complete` = true with `unitsRead` = `unitsPlanned`, `parentChainIntact`, `qaStrict`, `parity` and `determinism` all true and `failures` = 0 (any gap fails), and each day's coverage is recomputed from `unitLog` (its sha256 must match; every unit of a used day present with the row's revision and a file hash that matches the day's `SHA256SUMS`) rather than taken from the report; no day in `daysUsed` is a Helius day (Meme-snipe `research/historical/ci/archive-limits.conf` `HELIUS_DAYS`; owner, 6 Oct: no duplicate days between archive and Helius); `universe.selection` = `chain_only` with `survivorshipFree` = true and a named list source, and `universe.listSha256` equals the sha256 of `universe.listFile`, which the pull job wrote before the replay started (`writtenAtMs` < the replay run's start); no day in `daysUsed` overlaps `W_R` (read from the A-M13-05 stage machine) or the B3 windows, which the evaluator computes itself from `daysUsed` (never from counts in the report): `B3_CONTAMINATED` = 2026-09-22T00:00Z to 2026-10-21T00:00Z, Zeroed's sealed holdout of 2026-09-22 to 2026-10-20, which contains every other B3 use Meme-snipe `docs/MIGRATION.md` lists (the `empirical.md` backfill and live sample of 2026-10-01 to 10-03, PR #267's 22 Sep-2 Oct study, the 5 Oct live data); and zero crashes, illegal states and unreconciled intents as read from the A-M11-01 run record `replayRunId` (its `buildSha` and `configKey` must match), never from the report. **The replay run must be a real B-10 run (Z0D-2 round 3; C-78, C-79).** B-10 reads `replayRunId` only if that run is: `completed` and not `low_coverage` (else `E_B10_RUN_INCOMPLETE` or `E_B10_LOW_COVERAGE`); a B-10 run by the one definition of A-M11-01 step 8, with `b10PullId` equal to `pullRef.pullId` and every dataset manifest in that pull's `unitLog` or report (else `E_B10_NOT_B10_RUN`); run with the replay key on (else `E_B10_KEY_OFF`); and with datasets covering every day in `daysUsed` (else `E_B10_DAY_MISSING`). The run record must also show, for each replayed strategy, at least one entry and at least one exit made by the strategy's exit rules or the risk engine (a close at the run's end never counts), and entries on at least `B10_MIN_ENTRY_DAYS` = 3 distinct UTC days (POLICY: a strategy that trades on fewer days could never reach R-1's 300 trades, so B-10 would prove nothing about it); a strategy that falls short fails B-10 with `E_B10_NO_TRADES`, and the result names the strategy. Anything else fails. No branch waives B-10 (option (c) was not chosen). **Which strategies B-10 replays (C-76, owner 2026-10-08: MR-01 parked).** The per-strategy entry, exit and entry-day rules apply to the strategies registered for the evaluated run, i.e. the stage's strategy with its frozen `configKey` (today PM-01, or a future strategy entering through the M09 slot); MR-01 is never replayed while it is parked. **The run must name its strategy (card Z-H-OF round 2):** the run record lists the strategies replayed; if it names none, or names a strategy other than the stage's selected configuration, B-10 fails with `E_B10_STRATEGY_MISMATCH`. If no strategy has reached gate B, there is no evaluated build and `configKey`, so no B-10 run starts and B-10 stays `pending:B-10` (fail closed); the archive pull may still run and its days wait in the private store for the first strategy that reaches gate B. **Not chosen (owner, 2026-10-08 about 7:25 AM; C-79):** the Helius report fields (`creditEstimateShownAtMs`, `firstCreditSpentAtMs`, `ownerAckDecisionRef`, `creditsSpent`, `pageLog`) and the `B10-ACK` row; a report or run that cites a `B10-ACK` row (with or without `test=p10`) fails B-10 with `E_B10_NOT_B10_RUN`.
  4. R-1 ≥ 14 days post-BOOST snapshot data after `W_B` and ≥ `n_R` trades [ST-06] (owner item 6, C-49), where `n_R = max(300, n_80)` and `n_80 = ⌈DEFF × ((1.960 + 0.842) / S_low)²⌉`, `S_low` is the **lower** bound of the 95% interval (A-M13-03) of the selected configuration's per-trade net Sharpe on `W_B`, and DEFF is the same-day design effect; if `S_low ≤ 0`, power cannot be computed: R-1 fails with `owner_review:R-1_power` and the case goes to the owner; if `n_R / (W_B trades per day)` exceeds 90 days of `W_R`, R-1 fails with `owner_review:R-1_length`, the case goes to the owner and nothing passes automatically; R-2 CI lower bound > 0 on the same conservative row and D04 fixed cost as B-2 (C-77); R-3 replay mean ≥ 50% of the `W_B` point estimate; R-4 point estimate > 0 under 2× latency and 2× `p_sw`; R-5 max drawdown ≤ 15% of `E`; R-6 crash-day report: correlated loss on each listed day ≤ `MAXRISK_PF` (pending-data if SOL/USD history is unavailable for SOL-triggered days).
  5. **No Helius, no P gate (Z0D round 8).** If `engineHelius` over `W_P` is null, or shows any minute in which the engine's Helius allocation was 0 or below its floor (A-M14-05), or any minute with a B-10 reservation active ([not chosen, C-79]: none can occur on the archive route), every P gate fails with `helius_unavailable` (paper fills with fee estimates at the floor would understate costs). P-1 ≥ 21 days and ≥ max(MinTRL from observed paper skew/kurtosis, 100) trades, all after `stage_entered_at`, ≥ 30 observations before moments; P-2 net mean CI lower bound > 0; P-2b monthly net after fixed cost: point > 0 and CI lower bound > 0 (A-M13-04); P-3 paper mean not below the replay 95% CI lower bound; P-4 max drawdown ≤ 10% of `E`; P-5 market-data availability ≥ 99% of minutes (M07 coverage) and zero unexplained paper-ledger differences, and owner item 3 from `dryRun(buildSha, configKey)` of the build and `configKey` being promoted (a mismatch fails), which lists **every** block declared for that build: P-5 fails if any block of the promoted build has status `failed` or `aborted` (supervisor ruling, Z0D round 4); blocks are kept per the promoted build's lineage, across `configKey`s (every ancestor build of the promoted build; Z0D rounds 5 and 8), and a `failed` or `aborted` block of an earlier build counts as cleared only if `fixes` holds a valid fix record naming that block (a fix record is valid only if its fix commit is not in the failing build (not an ancestor of its `buildSha`), names the `failureId` in its commit message, adds a test that cites the `failureId` and links two CI runs of it: one on the fix commit's parent, where it fails, and one on the fix commit, where it passes, was merged to the integration branch (ARCH 3.4) through a reviewed PR, and is an ancestor of the promoted `buildSha` (`inPromotedBuild`, from the build's provenance)); P-5 is `pending_data` while a block of the promoted build is `running`, and otherwise needs one contiguous block of ≥ 48 full-worker hours, declared before it starts (`blockDeclaredAtMs` ≤ `blockFromMs`) and lying wholly inside `W_P`, `uptimeBps` ≥ 9,900 over that block, ≥ 1 restart drill and ≥ 1 disconnect drill inside it, `decisionsWithoutReasons` = 0; the `GateResult` lists every block; P-6 from A-M12-02 (≥ 50 buys and ≥ 50 round trips; median ≤ 30 bps; p90 ≤ 100 bps) and owner item 4 from `shadowCoverage` (A-M12-02 `p6Stats`, the single P-6 source): `okShareBps` ≥ 9,500 over ≥ 50 paper legs, `paperLegs` counted from A-M12-01's paper attempts (every leg), never from the shadow table, and every leg without a shadow counted as failed; P-7 drills within 7 days (HALT acknowledged within 2 s; CLI kill with the engine stopped blocks signing); P-8 checklist ticked (phrase, step-up and 60 s delay are enforced by M26 at submission); P-9 fixed monthly ≤ 3% of `E`; P-10 (owner item 5) `faultInjection(buildSha)` for the exact build being promoted: at least one run, and **every** run of the promoted build with all four cases passing; one failed run of the promoted build fails P-10 (supervisor ruling, Z0D round 4). Runs are kept per **build lineage** (every build that is an ancestor of the promoted build, across `configKey`s; Z0D round 7): a case that failed on an earlier build counts as cleared only if `fixes` holds a valid fix record for that failure (a fix record is valid only if its fix commit is not in the failing build (not an ancestor of its `buildSha`), names the `failureId` in its commit message, adds a test that cites the `failureId` and links two CI runs of it: one on the fix commit's parent, where it fails, and one on the fix commit, where it passes, was merged to the integration branch (ARCH 3.4) through a reviewed PR, and is an ancestor of the promoted `buildSha` (`inPromotedBuild`, from the build's provenance)) **and** the last 3 runs of the promoted build pass that case in a row. The `GateResult` lists every block and run of the `configKey`, on every build. `paper_passed` requires P-1..P-6, P-9 and P-10 (ARCH 3.4).
  6. LS-1 ≥ max(MinTRL from live moments, 100) live round trips and ≥ 14 days; LS-2 realised explicit cost per trade ≤ 1.25 × modelled; LS-3 live CI lower bound > 0 **and** non-inferiority rejects "live ≤ paper − δ" at 5% (δ = 50% of paper mean); LS-3b as P-2b on live data; LS-4 landing (confirmed within 20 slots of first send) ≥ 85%; LS-5 every daily reconciliation within 10,000 lamports and no unexplained `ours` balances; LS-6 live-small max drawdown ≤ 6% of `E` (flow-adjusted); LS-7 signer option (ii) or (iii), or `MAXEXP` in live capped at the live-small value (ARCH D26).
  7. Pending-data: any gate whose minimum sample or duration is unmet → `pass = false`, `actualValue` as far as known, blocking reason `pending_data:<gateId>`; never `pass` (ARCH M13 failure modes).
  8. `GateEvaluation` persisted (`gate_evaluation`, append-only) with windows; `evidenceRoute` = an in-app route (for example `/performance?strategy_id=mr01&mode=paper&from=…&to=…`).
- **Shared resources and concurrency:** M13 owns `gate_evaluation` (append-only); evaluations are read-only over other modules' data; M26 re-runs the evaluation at `effective_at` (CA-19).
- **Config:** gate thresholds are POLICY constants in code (they are risk controls; raising them via config is allowed, lowering is not, so no config key can weaken a gate).
- **Edge cases and failure handling:** an external input unavailable (B module down) → that gate `pass = false` with reason `input_unavailable`; never defaulted to pass.
- **Acceptance criteria:**
  - Given an evaluation with overlapping windows, shadow trades or a `configKey` mismatch, then it is rejected (ARCH 16.4).
  - Given a coarse-screen bundle, then it can affect only CS-1.
  - Given 99 paper trades with an excellent CI, then P-1 is `pending_data` and `allPass = false`.
  - Given synthetic inputs exactly at each threshold, then each gate's comparator (`gte`/`gt`/`lte`/`lt`) behaves as specified in ARCH 3.4.
  - Given a configuration whose net mean CI lower bound is above 0 on the lean row but below 0 on the conservative row with the $59 fixed cost, then B-2 and R-2 fail.
  - Given inputs in which trades following decisions tagged `replayAssumed` (C-78) alone lift the net mean CI lower bound above 0, then B-2 and R-2 fail, because those trades are not counted; given a paper window whose mean is above the replay 95% CI lower bound only because tagged trades were counted in the replay CI, then P-3 is computed without them; given 300 trades of which 1 is tagged, then B-1 counts 299 and fails; given a bundle from a run with the replay key on, then none of its trades counts in B-1..B-8, R or P; given a `replayDeterminism` record with `assumePassUnavailable = true`, then B-9 fails.
  - Given a `historyReplay` report whose `source` is not `old_faithful_archive`, or that cites a `B10-ACK` row (with or without `test=p10`), then B-10 fails (C-79).
  - Given an otherwise passing B-10 report whose `replayRunId` names a run that lists no strategy, or lists MR-01 (parked) or any strategy other than the stage's selected configuration, then B-10 fails with `E_B10_STRATEGY_MISMATCH`; given the stage's PM-01 configuration alone, then that check passes.
  - Given an otherwise passing B-10 report whose `replayRunId` names (a) a run with the replay key off, (b) a `low_coverage` run, (c) a run that is not `completed`, (d) a B-10 run under a different `b10PullId` from `pullRef.pullId`, (e) a replay whose datasets include a `W_R` recording, (f) a run whose datasets miss one day of `daysUsed`, or (g) a run with zero entries or zero exits for one replayed strategy, then B-10 fails with, in turn, `E_B10_KEY_OFF`, `E_B10_LOW_COVERAGE`, `E_B10_RUN_INCOMPLETE`, `E_B10_NOT_B10_RUN`, `E_B10_NOT_B10_RUN`, `E_B10_DAY_MISSING` and `E_B10_NO_TRADES` (naming the strategy); given a key-off replay in which every entry failed closed (zero entries, zero crashes), then B-10 fails with `E_B10_KEY_OFF`; given a strategy whose only exit is the close at the run's end, then B-10 fails with `E_B10_NO_TRADES`; given a strategy with entries on 2 distinct days, then B-10 fails with `E_B10_NO_TRADES`.
  - Given a final 20% of `W_B` whose mean is positive on the lean row but negative on the conservative row with the $59 fixed cost, then B-8 fails; given a stressed replay (2× latency, 2× `p_sw`) whose point estimate is positive on the lean row but negative on the conservative row, then R-4 fails.
  - Given R-1 inputs with 299 trades, or with 300 trades when `n_80` = 412 (`n_R` = 412), then R-1 fails.
  - Given `S_low` = 0 or below, then R-1 fails with `owner_review:R-1_power`; given `n_R` that needs 91 days of `W_R` at the `W_B` trade rate, then R-1 fails with `owner_review:R-1_length`; neither ever passes.
  - Given a `historyReplay` report with 30 clean days of which one is 2026-10-05 (inside `B3_CONTAMINATED`), or inside `W_R`, or 2026-09-21 (a Helius day), or outside the pinned row's day list, then B-10 fails; given `pullRef` null, pointing to a row with no `B10-PULL` entry, to a commit not on the integration branch, to a pin (id, commit, blob hash) that differs from the pull job's, or to a row without the owner's quoted decision, then B-10 fails; given a `scannerRevision` that differs from the row's `scannerRev`, or one unit of a used day carrying another revision, then B-10 fails; given a report whose own fields claim a longer day list than the DECISIONS row, then the row's list is used; given a run record with 1 crash while the report says 0, then B-10 fails; given a `listSha256` that differs from the list file's hash, or a list file written after the replay started, or a `unitLog` whose hash differs, which misses a unit of a used day, or whose file hash differs from the day's `SHA256SUMS`, then B-10 fails; given 30 entries in `daysUsed` covering only 29 distinct UTC days, or one day with `unitsRead` < `unitsPlanned`, `parentChainIntact`, `qaStrict`, `parity` or `determinism` false, or `failures` = 1, or `universe.survivorshipFree` = false, then B-10 fails; given 30 distinct clean days outside both windows and outside `HELIUS_DAYS`, inside the row's day list, and zero crashes, illegal states and unreconciled intents, then B-10 passes (it still cannot pass the stage alone).
  - Given `historyReplay` or `dryRun` whose `buildSha` or `configKey` differs from the evaluated one, then B-10 or P-5 fails with `E_TRIAL_MISMATCH`.
  - Given a dry run of 48 h made of two 24 h blocks, or one 48 h block declared after it started, or one that starts before `W_P`, then P-5 fails.
  - Given the M2 build with no B-M26-04 adapter, then `replayDeterminism` and `historyReplay` are still read from imported bundles and B-9 and B-10 are evaluated (not `input_unavailable`).
  - Given `replayDeterminism` null, 9 replays or one differing hash, then B-9 fails; given `historyReplay` null (no card Z-H report yet), then B-10 fails and `backtest_passed` is not reached.
  - Given `faultInjection` null, a different `buildSha` or one failing case, then P-10 fails and `paper_passed` is not reached; given two runs of the promoted build, one failing and a later one passing, then P-10 fails.
  - Given a `stale_feed` case that failed on build X of the same `configKey`, a promoted build Y with no fix record naming it, then P-10 fails; with a fix record in Y but only 2 passing runs of Y in a row, then P-10 fails; with the fix and 3 passing runs in a row, then that failure is cleared. Given a failed dry-run block on build X and no fix record in Y, then P-5 fails even with a passing 48 h block on Y. Given a fix record whose commit is already in the failing build, or whose message does not name the `failureId`, or that reached the integration branch without a reviewed PR, or that adds no test citing the `failureId`, or whose two linked CI runs are missing or do not show the test failing on the fix commit's parent and passing on the fix commit, then the failure is not cleared. Given a dry-run block that failed on build X under `configKey` K1 and a promoted descendant build Y under K2, then P-5 still lists that block. Given a fault-injection failure on build X under `configKey` K1 and a promoted descendant build Y under K2, then that failure is still listed and must be cleared.
  - Given a `W_P` with one minute in which the engine's Helius allocation was 0, or with a B-10 reservation active ([not chosen, C-79]), then every P gate fails with `helius_unavailable`; given `engineHelius` null, then every P gate fails.
  - Given two declared blocks for the promoted build, the first `failed` and the second a passing 48 h block, then P-5 fails and both blocks are listed.
  - Given `okShareBps` = 9,499 over 200 legs, then P-6 fails; given `dryRun` with 47 hours or `uptimeBps` = 9,899, then P-5 fails.
- **Tests:** unit per gate at, just above and just below each threshold; integration with imported fixture bundles; VM-18 contract fixtures (M28 test double).
- **Observability:** metrics `gate_pass{strategy,gate}`; log `M13.gate_evaluation` (summary).
- **Security notes:** the server is authoritative for gates (VM-18); the UI never computes them.
- **Facts used:** ST-06, ST-29, ST-30, ST-31, ST-32, ST-34, ST-35, ST-36, ST-37, TH-46.
- **Definition of done:** CS/B/R gates live in Phase 1; P gates in Phase 2; LS gates in Phase 3; all with threshold tests.

#### A-M13-07 — CUSUM sequential monitor (gate L-1)

- **Module:** M13 · **Phase:** 2 (built), used from live-small · **Size:** S (≈ 1 engineer-day)
- **Goal:** Detect, with a known false-alarm rate, a fall of a live strategy's mean per-trade return to zero, and demote it automatically.
- **Depends on:** A-M13-03, A-M13-05. B: consumer B-M21-04 (subscribes to `research.cusum_alarm` in `live_small` and `live`) and B-M26-04 (A1 demotion, `StageMachine.onDemotion`).
- **Interfaces (ARCH M13):** `sequentialMonitor(strategyId): { cusum: number; threshold: number; alarm: boolean; expectedDelayTrades: number | null }`; NEW event `research.cusum_alarm { strategyId, cusum, threshold, trades, atMs }`.
- **Logic:**
  1. At promotion to `live_small`, freeze `μ_paper` and `σ_paper` from `W_P` per-trade net returns (excluding shadow/recovered).
  2. `S_n = max(0, S_{n−1} + (μ_paper − x_n)/σ_paper − k)`, `k = μ_paper / (2σ_paper)` (ARCH 3.4).
  3. Threshold `h` by simulation: 10,000 seeded runs of in-control sequences drawn by resampling the standardised paper returns; bisection on `h` until the mean run length to a false alarm is 500 trades ± 10% (in-control ARL 500, POLICY).
  4. Expected detection delay: the same simulation with returns shifted so the mean is 0; published with the gate (VM-18). At per-trade Sharpe near 0.1 the delay is hundreds of trades; the fast brakes remain `DAYLOSS`, `WEEKLOSS` and `DDKILL` (ARCH 3.4 L-1).
  5. Runs in `live_small` and `live` (applying it in live-small too is the conservative reading; clarification C-36). Alarm → publish `research.cusum_alarm`; M21/M26 demote to paper (A1, actor `risk_engine`), which also cancels pending A3 commands and starts the 7-day cooldown.
- **Shared resources and concurrency:** monitor state per strategy owned by M13, persisted on each trade close; restart reloads it.
- **Config:** `analytics.cusum.target_arl_trades` (500, 200-2,000; raising it lowers sensitivity and increases risk).
- **Edge cases and failure handling:** `σ_paper = 0` or `μ_paper ≤ 0` → the strategy could not have passed P gates; monitor refuses to start and blocks promotion (`E_MONITOR`).
- **Acceptance criteria:** In simulation, the in-control run length is within 10% of 500 trades (ARCH 16.4); a synthetic sequence with mean 0 triggers an alarm and exactly one `research.cusum_alarm`.
- **Tests:** seeded simulation tests; restart persistence test.
- **Observability:** metrics `cusum_value{strategy}`, `cusum_threshold{strategy}`; alert via M21 on demotion.
- **Security notes:** none.
- **Facts used:** ST-33, ST-39.
- **Definition of done:** monitor wired to M21/M26 test doubles; L-1 values appear in VM-18.

#### A-M13-08 — Run-bundle import and the VM-21 source

- **Module:** M13 · **Phase:** 1 · **Size:** S (≈ 0.5 engineer-day)
- **Goal:** Accept research results onto the host only as verified bundles over data the host itself recorded, and list them read-only (VM-21).
- **Depends on:** A-M11-05, A-M13-02. B: M29 `botctl import-run` (delivers the bundle to the engine; clarification C-38); M24 `run`, `trade`, `trial_registry`; M28 VM-21 schema.
- **Interfaces (ARCH M13):** `importRunBundle(b: RunBundle): Result<{ runId: Id }, { code: 'E_SIGNATURE' | 'E_MANIFEST' | 'E_TRIAL_MISMATCH' }>`; NEW `importedRuns(): Array<{ runId: Id; mode: 'backtest' | 'replay' | 'coarse_screen'; strategyId: string; trialKey: string; fromMs: UnixMs; toMs: UnixMs; importedAtMs: UnixMs; bundleSignatureOk: boolean; tradesCount: number; lowCoverage: boolean; gateIdsEvaluated: string[] }>`.
- **Logic:**
  1. `verifyBundle` with the research public key from the root-owned config (`E_SIGNATURE`).
  2. Every manifest SHA-256 in the bundle must exist in the host's own manifest index (`/var/lib/zeroed-md/*/index.json`; M07 keeps manifests and indexes permanently even after segment deletion, clarification C-37) (`E_MANIFEST`).
  3. Recompute `configKey`/`trialKey` from the strategy's pre-registration, the bundle's model versions and dataset hashes; mismatch → `E_TRIAL_MISMATCH`.
  4. In one SQLite transaction: insert the `run` row (mode, strategy, trial key, dataset hashes, git commit, seed, `bundle_sha256`, `bundle_signature_ok`, `imported_at`), the journal rows (`trade` with `mode` backtest/replay/coarse_screen, `simulated = true`) and the trial row (`registerTrial`). Idempotent on `bundle_sha256` (re-import returns the existing `runId`).
  5. Every import and refusal is audited (M24 audit via M26's writer, actor `cli`).
  6. There is no endpoint that starts a run on the host (CA-26); `import-run` performs no computation beyond verification and inserts.
- **Shared resources and concurrency:** writes through the engine's single SQLite writer (clarification C-38).
- **Config:** `research.public_key` (root-owned file, read-only to the engine).
- **Edge cases and failure handling:** bundle larger than 50 MB → refused before parsing; malformed JSON → `E_SIGNATURE` (cannot verify).
- **Acceptance criteria:** Given a valid bundle, then one `run`, N `trade` and one `trial_registry` row appear and VM-21 lists it; given the same bundle with one manifest hash unknown to the host, then `E_MANIFEST` and nothing is written.
- **Tests:** integration with fixture bundles (`fx/bundles/valid.json`, `fx/bundles/tampered.json`, `fx/bundles/foreign_manifest.json`).
- **Observability:** log `M13.bundle_imported` / `M13.bundle_refused` (code); metric `bundles_imported_total{result}`.
- **Security notes:** a forged bundle needs both the research key and data whose manifests the host recorded; neither is enough alone.
- **Facts used:** none in the register (internal).
- **Definition of done:** import path exercised end-to-end with M29's `botctl import-run` in a staging environment.

### M14 RPC gateway and rate limiter

#### A-M14-01 — Provider registry, endpoint validation and JSON-RPC client

- **Module:** M14 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Every outbound RPC call goes through one client that validates endpoints, never exposes URLs or keys, injects the required version parameter, and reports the context slot of every response.
- **Depends on:** none. B: M25 `Config` (provider entries); the secret store of ARCH 12.4 (`/etc/bot/secrets.env`, loaded by systemd); M15 subscribes to `rpc.context_slot` (clarification C-05); M27 logging and redaction.
- **Interfaces (ARCH M14):**

```ts
interface RpcGateway {
  call<T>(method: string, params: unknown[], o: { priority: 0 | 1 | 2 | 3 | 4; role: 'read' | 'send'; commitment?: Commitment; timeoutMs: number; provider?: string }):
    Promise<Result<{ value: T; providerLabel: string; latencyMs: number; contextSlot: Slot | null }, RpcError>>;
}
type RpcError = { code: 'E_RATE_LIMITED' | 'E_TIMEOUT' | 'E_HTTP' | 'E_RPC' | 'E_ALL_PROVIDERS_DOWN'; retryAfterMs?: number; message: string };
interface ProviderConfig {                                                                 // NEW (config schema)
  label: string; transport: 'https' | 'wss'; urlSecretRef: string /* name of the secret holding the full URL incl. any key */;
  roles: Array<'read' | 'send' | 'stream'>; unmeteredPrimary: boolean; failoverOrder: number;
  limits: { rps: number; sendRps?: number; heavyRps?: number };
  metering: { unit: 'credits' | 'requests'; monthlyAllowance: number; methodCost: Record<string, number> } | null;
  allowInLivePaths: boolean }
// publishes 'rpc.context_slot' { providerLabel, contextSlot, method, atMs } for every response that carries one (integration: `method` added to match B-M15-01 / CL-01)
```

- **Logic:**
  1. Validation at load (CA-30): every URL's scheme is `https:` or `wss:`, otherwise `E_CONFIG`; the plain-HTTP regional Sender endpoints [LD-V06] are therefore unusable; the public mainnet endpoint ("not intended for production applications" [LD-26, DA-09]) may be configured only with `allowInLivePaths = false`, and the engine never routes a call to such a provider (it exists for research processes only); at least two read providers with distinct labels (needed by M18's expiry proofs and M17's two endpoints); exactly one `unmeteredPrimary`; every URL host must appear in the host egress allowlist file maintained by M30 (cross-check, warning if absent).
  2. URLs are read from the secret store by reference and kept only in memory; logs, metrics, errors and VMs carry `label` only (ARCH 12.4, VM convention 11). Error messages from providers are truncated to 200 characters and scrubbed of any substring matching the URL or `api-key` query parameters (M27 redaction).
  3. JSON-RPC 2.0 POST with Node's built-in `fetch`; timeout via `AbortController`; response size cap `rpc.max_response_bytes` (default 50 MB; enumeration calls may pass a higher cap, A-M03-03).
  4. Parameter rules: `getTransaction` and `getBlock` always get `maxSupportedTransactionVersion: 1` (version 0 or omission fails on v1 transactions with `-32015` [LD-05, EX-V04]); `getProgramAccounts`, `getMultipleAccounts`, `getAccountInfo` must name an encoding (the default is a deprecated binary encoding [DA-06]); every read must pass `commitment` explicitly (a missing value is rejected as a programming error, `E_RPC` with message `missing_commitment`), because RPC defaults are typically `finalized` [TH-47, LD-09] and decisions use `confirmed` (D14).
  5. Error mapping: HTTP 429 → `E_RATE_LIMITED` with `retryAfterMs` from `Retry-After` (honoured [LD-26]); other HTTP status → `E_HTTP`; JSON-RPC error object → `E_RPC` (code kept, message scrubbed); timeout → `E_TIMEOUT`.
  6. `contextSlot` = `result.context.slot` when present; publish `rpc.context_slot` so M15's `highestSeenSlot()` sees every provider's slot (ARCH M15).
- **Shared resources and concurrency:** M14 owns provider health and buckets (ARCH 7.2); this ticket adds only the stateless client. Request IDs are for metrics only.
- **Config:** `rpc.providers` (list of `ProviderConfig`); `rpc.max_response_bytes` (bytes, 52,428,800); defaults per ARCH 11.1: Shyft Free (unmetered primary, 10 RPC req/s, 0 index req/s, 1 `sendTransaction`/s [VF-09]), Chainstack Developer (5 RPS on Solana mainnet, 3M request units a month, archive-scope calls such as `getSignaturesForAddress` 2 RU [VF-10]; LD-32's 25 req/s is the global plan figure), Helius Developer, the owner's plan whose key the bot shares (Meme-snipe `docs/DECISIONS.md` O7; 10M credits/month, 50 req/s, `sendTransaction` 5/s [LD-27]; method costs: standard 1, `getProgramAccounts` 10, `getPriorityFeeEstimate` 1 [LD-28]). Configured rates are **≤ 50% of documented limits for every provider** (owner rule; it replaces the earlier 80%): Shyft standard ≤ 5 req/s and no index bucket; Chainstack the lower of 2.5 req/s and the owner's one read every 2 s (0.5 req/s), with the per-account RU ledger and its rolling 31-day hard stop (A-M14-05); Helius per `/etc/bot/rpc-allocation.json` (engine 5 req/s and `sendTransaction` 0.5/s outside a B-10 window, 0 inside it; A-M14-05), all well inside 50% of Developer's documented limits. Validation refuses a configured rate above 50% of the documented one.
- **Edge cases and failure handling:** 1. Secret missing → provider disabled, alert; fewer than two read providers remaining → engine refuses live modes. 2. Response not JSON → `E_HTTP`. 3. Response larger than the cap → aborted, `E_HTTP` with reason `too_large`.
- **Acceptance criteria:**
  - Given a provider URL starting with `http://`, then config validation fails (`E_CONFIG`).
  - Given any `getTransaction` call by any module, then the outgoing request contains `maxSupportedTransactionVersion: 1`.
  - Given a provider error message containing the URL, then logs show `[redacted]`.
  - Given a 429 with `Retry-After: 3`, then `E_RATE_LIMITED` with `retryAfterMs = 3000`.
- **Tests:** unit with a mock HTTP server; secrets-scan test on captured logs; config validation tests.
- **Observability:** metrics `rpc_requests_total{provider,method,status}`, `rpc_latency_ms{provider,method}`; log `M14.provider_disabled`.
- **Security notes:** the only module allowed to open RPC connections; keys never leave memory; no third-party HTTP client (Node `fetch`).
- **Facts used:** LD-05, LD-09, LD-26, LD-27, LD-28, LD-32, LD-33, LD-V06, DA-06, DA-09, EX-V04, TH-47, VF-09, VF-10.
- **Definition of done:** client merged; all Phase 0 reads go through it; secrets scan clean.

#### A-M14-02 — Read rate limiting, priorities, pinning and failover

- **Module:** M14 · **Phase:** 0 · **Size:** M (≈ 1.5 engineer-days)
- **Goal:** Keep every provider inside its limits while guaranteeing that exit-critical reads get capacity first and heavy traffic never burns metered allowances.
- **Depends on:** A-M14-01. B: none (all B modules are callers).
- **Interfaces:** `RpcGateway.call` (A-M14-01), plus `RpcGateway.mode(): 'normal' | 'degraded_reads'` (A-M14-05).
- **Logic:**
  1. Token bucket per `(provider, method class)`, classes `standard`, `heavy` (`getProgramAccounts`, `getBlock`), `send` (`sendTransaction`), `fee` (`getPriorityFeeEstimate`); capacity = configured rps (≤ 50% of documented, owner rule), burst 1 s.
  2. Priorities (ARCH M14): P0 send/confirm/exit reads; P1 entry reads (and position-pool polling, C-07); P2 candidate pool polling; P3 screening; P4 discovery, vendor and dashboard extras. 20% of each bucket is reserved for P0; P0 may use the whole bucket, others only 80%. Waiting requests are served highest priority first, FIFO within a class; a request that cannot get a token before its `timeoutMs` returns `E_RATE_LIMITED`.
  3. Pinning: P2, P3 and P4 go only to the unmetered primary; P0 and P1 go to the primary first, then fail over in `failoverOrder` (ARCH M14 rules).
  4. Failover for reads: on `E_RATE_LIMITED`, `E_TIMEOUT`, HTTP 5xx or network errors, retry on the next eligible provider while time remains. No failover when `o.provider` is set (M18's expiry proof must use one provider, ARCH M18) or when `role = 'send'` (M18 decides paths).
  5. 429 handling: pause that `(provider, method class)` until `Retry-After` (or 1 s if absent), doubling on consecutive 429s up to 60 s [LD-26].
  6. Metered protection: if A-M14-05 marks a metered provider "projected > 80%", P1-P4 skip it (ARCH M14 rules).
  7. In `degraded_reads`, P2-P4 requests fail immediately with `E_RATE_LIMITED` (`message: 'degraded'`); P0/P1 may fail over to metered providers (ARCH 11.2).
  8. All eligible providers failing → `E_ALL_PROVIDERS_DOWN` (ARCH M14 failure mode).
- **Shared resources and concurrency:** M14 exclusively owns the buckets (ARCH 7.2); FIFO per priority class; all on the event loop.
- **Config:** per-provider `limits` (A-M14-01), each at ≤ 50% of the documented limit (owner rule). Documented limits read 2026-10-07 (`research/verify-m0-m1/RESULTS.md` rows 20 and 21 @ 01438a5e): Shyft Free 10 RPC req/s, 0 index req/s, 1 sendTransaction/s [VF-09] → standard bucket ≤ 5 req/s, no index bucket; Chainstack Developer 5 RPS on Solana mainnet and 3M request units a month [VF-10] → bucket = the lower of 2.5 req/s and the owner's backup rate of one read every 2 s (0.5 req/s), plus the per-account RU ledger and rolling 31-day hard stop of A-M14-05; the bucket too is one per account, shared by the worker and the sentinel (the signer uses its own reserved block); `rpc.p0_reserve_bps` (2,000, 1,000-5,000); `rpc.default_timeout_ms` per priority (P0 2,000; P1 3,000; P2 5,000; P3 10,000; P4 30,000).
- **Edge cases and failure handling:** a provider returning success with a slot far behind → accepted here (M04/M15 apply slot-lag rules); a burst from enumeration → queued at P4 without starving P0.
- **Acceptance criteria:**
  - Given saturated P2 traffic, then a P0 call is served within one token interval.
  - Given the primary returning 429 for 5 s, then P1 calls succeed on the secondary and P2 calls wait or time out on the primary only.
  - Given `o.provider = 'chainstack'`, then no other provider is used even if it fails.
  - Property: over any 1 s window, requests sent to a provider never exceed its configured rate plus burst.
  - Given a Chainstack config of 2.5 req/s, then the bucket runs at 0.5 req/s (the lower of the two limits); given any provider configured above 50% of its documented limit, then validation refuses the config.
- **Tests:** unit with a fake clock; property test for rate compliance; failure injection: primary 429 storm, all-down.
- **Observability:** metrics `rpc_queue_depth{provider,priority}`, `rpc_wait_ms{priority}`, `rpc_failover_total{from,to}`, `rpc_429_total{provider}`.
- **Security notes:** none beyond A-M14-01.
- **Facts used:** LD-26, LD-27, LD-32, LD-33, VF-09, VF-10.
- **Definition of done:** Phase 0 recorder runs 48 h with zero provider 429 storms beyond brief bursts; metrics in VM-13.

#### A-M14-03 — Service HTTP clients and the Jupiter exit budget

- **Module:** M14 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** One limited, key-safe client per third-party HTTP service, and a hard rule that exits never wait for Jupiter (CA-10).
- **Depends on:** A-M14-01, A-M14-02. B: M19/M20 call the exit-work markers.
- **Interfaces (ARCH M14, plus NEW markers):**

```ts
interface RpcGateway {
  http<T>(service: 'jupiter' | 'dexscreener' | 'rugcheck' | 'coingecko' | 'birdeye' | 'helius_sender' | 'jito', req: HttpReq,
    o: { priority: 0 | 1 | 2 | 3 | 4; timeoutMs: number; sendGrantId?: string }): Promise<Result<T, RpcError>>;
  beginExitWork(key: Id): void;      // NEW (clarification C-41): an exit attempt is building or in flight
  endExitWork(key: Id): void;        // NEW
}
```

- **Logic:**
  1. Base URLs per service from config (HTTPS only). Keys from the secret store, added as headers by M14 only: Jupiter `x-api-key` (keyless allowed at 0.5 req/s [EX-29, DA-29]); CoinGecko Demo `x-cg-demo-api-key` [DA-27]; Birdeye `X-API-KEY` [TH-26] (only if D17 (e) is taken); RugCheck public GETs need no key [TH-21]; DexScreener none [DA-26]; Jito none [LD-18]; Helius Sender takes its key as the `api-key` URL query parameter [VF-14] (settled 2026-10-07). Callers never pass secret headers (`HttpReq.headers` must not contain known secret names; validation). **Any URL that is logged, put in an error message or exported has every key-bearing query parameter (`api-key` and any configured secret name) replaced with `[redacted]`** first; a test logs a keyed Sender URL and finds no key in any log line.
  2. Limits (≤ 50% of documented, owner rule; it replaces the earlier POLICY 80%): Jupiter one shared bucket for Swap, Price and Tokens, 60 s sliding window per organisation: free key 1 req/s → 30 per 60 s; keyless 0.5 req/s → 15 per 60 s [EX-29, DA-30]; `/swap/v2/execute` has its own bucket (20 keyless, 50 free documented → 10 / 25) [EX-29]; honour `x-ratelimit-remaining`, `x-ratelimit-current`, `x-ratelimit-reset` when present (only on 200 and 429 responses [DA-30]). DexScreener 300/min for pairs/tokens/search and 60/min for profiles and similar [DA-26, VF-15] → 150 and 30. RugCheck: header limit 15 with an undocumented window [TH-21] → treated as 15/min, configured 7/min. CoinGecko Demo 100/min [DA-27] → 50/min, plus a monthly cap of 2,000 calls (ARCH M14). Birdeye per plan [DA-22] (off by default).
  3. `helius_sender` and `jito` requests require `sendGrantId` from `acquireSend` (A-M14-04); they bypass the read buckets so a send is never counted twice.
  4. Jupiter exit budget (CA-10): while any exit work is open (`beginExitWork` without `endExitWork`, with a 120 s safety expiry per key), Price V3 and Tokens calls are refused immediately (`E_RATE_LIMITED`, message `exit_reserved`); callers use cached values. A Jupiter 429 on an exit request returns `E_RATE_LIMITED` immediately without waiting, so M20 uses the direct adapter (ARCH M14, D09).
  5. Response size cap 5 MB; JSON parsing errors → `E_HTTP`.
- **Shared resources and concurrency:** service buckets owned by M14.
- **Config:** `services.<name>.base_url`, `services.<name>.limit_per_min`, `services.jupiter.keyed` (bool), `services.coingecko.monthly_cap` (2,000, ≤ 2,000).
- **Edge cases and failure handling:** DexScreener licence revoked [DA-26] or RugCheck access blocked → `E_HTTP`, callers degrade to `skipped`; CoinGecko monthly cap reached → `E_RATE_LIMITED` until the next month.
- **Acceptance criteria:**
  - Given an exit marked in flight, then a Price V3 call returns `exit_reserved` immediately.
  - Given a Jupiter 429 on an exit request, then the call returns within 5 ms with `E_RATE_LIMITED`.
  - Given 51 CoinGecko calls in a minute with a limit of 50/min, then the 51st waits for the window; with the monthly cap reached, all are refused.
- **Tests:** unit with fake clock and mock servers; header-injection test (secrets never in logs).
- **Observability:** metrics `http_requests_total{service,status}`, `jupiter_exit_reserved_total`, `service_budget_remaining{service}`.
- **Security notes:** every response is untrusted JSON; callers validate schemas; only public identifiers (mints, pools) are ever sent; URLs are redacted before logging (step 1).
- **Facts used:** EX-29, DA-22, DA-26, DA-27, DA-29, DA-30, TH-21, TH-26, LD-18, VF-14, VF-15.
- **Definition of done:** all service calls in group A use these clients; VERIFY A-40 resolved before Phase 3.

#### A-M14-04 — Send token buckets (`acquireSend`)

- **Module:** M14 · **Phase:** 3 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Shared per-path, per-region send buckets below documented limits, granting exits before entries, so a flatten never trips a landing service's rate limit (CA-11, CB-01).
- **Depends on:** A-M14-01. B: consumers B-M18-01 (send scheduler, the only caller) and B-M18-05; M29's standalone path does **not** use M14 (it has its own 1 send/s loop, ARCH M29).
- **Interfaces (ARCH M14; `side` extended, clarification C-42):**

```ts
interface RpcGateway {
  acquireSend(path: LandingPath, region: string, o: { side: 'exit' | 'entry' | 'janitor' | 'sweep'; kind: 'first' | 'rebroadcast' }):
    Promise<{ granted: boolean; retryAtMs: UnixMs | null; grantId?: string }>;   // grantId present iff granted
}
// LandingPath = 'sender' | 'jito_tx' | 'rpc' | 'jupiter_execute' (@bot/types, B-M19-01; CL-04 adopted at integration)
```

- **Logic:**
  1. Buckets (≤ 50% of documented, owner rule; it replaces the earlier POLICY 80%): keyed Sender on the HTTPS global endpoint 25 req/s (50 req/s per key per region documented [LD-22, VF-14]; whether the global endpoint's limit is counted per region is VERIFY A-40, so the bucket assumes the stricter single-region reading); keyless Sender 0.5 req/s per region (1 req/s per egress IP per region, rejected 429s count [LD-V06]); Jito 0.5 req/s per region (1 req/s per IP per region [LD-18]); Helius `sendTransaction` 0.5 req/s (1/s on Free [LD-27]); `jupiter_execute` (rung-4 landing through Jupiter `/execute`, B-M18-05; integration, CL-04) at 50% of the documented `/execute` limit (20 keyless, 50 free key [EX-29] → 10 / 25), never rebroadcast; **VERIFY** whether that limit is per second or per 60 s window against Jupiter's rate-limit page before setting the bucket (A-M14-03 states the Jupiter windows as 60 s; B-M18-05 states requests per second). Region for the global Sender endpoint and for Jupiter is the literal `global`.
  2. Grant order: exit first sends > exit rebroadcasts > entry first sends > entry rebroadcasts > janitor and sweep (ARCH M14, M18). Non-blocking: a call is granted if a token is available **and** no higher-order class has registered demand in the last 100 ms; otherwise `granted = false` with `retryAtMs` = the next time a token frees up for this class (demand is registered by the denied call).
  3. 429 from a send path (seen by `http()`/`call()`) empties that bucket until `Retry-After` (or 1 s), doubling on repeats up to 30 s; the path is never removed from an attempt (M18 rule).
  4. `grantId` is single-use and must accompany the send request (A-M14-03 step 3).
  5. Send URLs that carry a key (keyed Sender's `api-key` query parameter [VF-14]) are redacted before any log, error or metric label (A-M14-03 step 1).
- **Shared resources and concurrency:** M14 owns send buckets (ARCH 7.2); M18's scheduler is the only consumer.
- **Config:** `send.buckets` (list of `{ path, region, rps }`, each ≤ 50% of its documented limit; validation refuses higher values).
- **Edge cases and failure handling:** keyed Sender disabled (no key) → keyless bucket used and an alert raised, because a flatten of 3 positions would exceed it (ARCH D02).
- **Acceptance criteria:** Given 3 exits and 1 entry in flight at 200 ms slots, then no bucket's rate is exceeded, no path is dropped on 429, and every exit first send is granted before the entry's (ARCH 16.5).
- **Tests:** simulation with a fake clock; property: grants never exceed the configured rate.
- **Observability:** metrics `send_bucket_wait_ms{path}`, `send_429_total{path}`, `send_grants_total{path,side,kind}`.
- **Security notes:** none.
- **Facts used:** LD-18, LD-22, LD-27, LD-V06, VF-14.
- **Definition of done:** M18's capacity test passes against these buckets.

#### A-M14-05 — Health, credit accounting, burn-rate projection and degraded mode

- **Module:** M14 · **Phase:** 0 · **Size:** S (≈ 1 engineer-day)
- **Goal:** Report provider health for VM-13, project monthly use of metered allowances before they run out, and switch to `degraded_reads` when the unmetered primary fails (CB-05).
- **Depends on:** A-M14-02. B: M27 (alerts), M28 (VM-13 `rpc[]` projection), M05 and M21 subscribe to `rpc.mode`, M15 (`highestSeenSlot` for slot lag).
- **Interfaces (ARCH M14 and 5.0a `ProviderHealth`):**

```ts
interface RpcGateway {
  health(): ProviderHealth[];
  creditUsage(): Array<{ provider: string; usedThisMonth: number; monthlyAllowance: number; projectedMonthEnd: number }>;
  mode(): 'normal' | 'degraded_reads';
}
// publishes 'rpc.mode' { mode, since, reason } and 'rpc.provider_status' (ProviderHealth)
```

- **Logic:**
  1. Health per provider over rolling windows: latency p50/p95/p99 (60 s), `errorRateBps` (5 min), `requestsPerMin`, `slot` (highest context slot from this provider), `slotLag = highestSeenSlot − slot`, `lastOkAtMs`; status `down` if no success for 10 s while requests were attempted or 5 consecutive failures; `degraded` if error rate > 200 bps, slot lag > 10 [ARCH 8.5], or a 429 in the last 60 s; else `ok`.
  2. Usage counters per metered provider and month: credits by method cost (Helius: standard 1, `getProgramAccounts` 10, priority-fee estimate 1, `sendTransaction` 1 [LD-28]) or request units (Chainstack: 1 RU a call, 2 RU for archive-scope calls, `getSignaturesForAddress` always 2 [VF-10]). Counters of other metered providers are persisted every 5 minutes (table need logged in C-14) so restarts do not reset them; their billing month is assumed to be the UTC calendar month (UNVERIFIED per provider; the projection is conservative because counters never reset early). **Metered-provider ledgers and allocations (supervisor rulings, Z0D rounds 3 to 8).** Chainstack (RU) and Helius (credits) are counted **per provider account**, not per key (whether Chainstack's 3M RU is per account or per key is **VERIFY** against Chainstack's limits page before M1, VF-10; per account is the stricter reading either way). The plan is Helius **Developer** everywhere (10M credits a month, 50 req/s, `sendTransaction` 5/s [LD-27]; the bot shares the owner's key, Meme-snipe `docs/DECISIONS.md` O7).
     - **One account-level ledger per provider, checked before every send by every consumer.** On the host, `/var/lib/zeroed-usage/rpc-usage.db` (SQLite, WAL, an exclusive transaction per reservation; owner `bot`, group `zeroed-sentinel` (this spec's `sentinel` group on the host), mode 0660 set explicitly on the database and its `-wal`/`-shm` files because the engine's unit keeps `UMask=0077`; the folder is 2770 setgid, made by the installer, outside the engine's 0700 state folder because the sentinel writes it too; PATHS-FIX ruling 21, DECISIONS "PATHS-FIX round 2"). Before every send, every consumer checks that the account's rolling 31-day sum plus the request stays within the account cap in force and within its own allocation; the request is written before it is sent (or drawn from a block of at most 1,000 units written before the block's first send; a block left unused at a crash counts as spent), and **every request sent is counted**, whatever its result (success, error, timeout, HTTP 429): Chainstack 1 RU a call, 2 RU for archive-scope calls, `getSignaturesForAddress` always 2 [VF-10]; Helius by method cost [LD-28].
     - **The signer's block.** The signer never writes the account ledger. The root-owned allocator keeps its block (50,000 units per provider, POLICY) as **one standing rolling entry**, renewed in place and never added again at a boot; the signer counts its own use against the block in `/var/lib/signer/rpc-usage.json` (owner `signer`, mode 0600, Node built-ins only) as a rolling 31-day sum; the engine cannot consume the block.
     - **Account caps, as rolling 31-day sums** (no billing-date assumption): Chainstack ≤ 1.5M RU (50% of the documented 3M a month); Helius 5M credits by default (50% of Developer's 10M). A pinned `B10-ACK` row (**[not chosen, owner 2026-10-08; C-79]**: none is pinned, so the cap stays at 5M) sets `acctCap` (at most 9,500,000, 95% of the plan) for its own window only. No overage is ever spent. **Until card Z-H prep P21 lands** (Z0D-2 round 9), that holds only for spend recorded in the account ledger: this repository's existing Helius workflows reserve nothing in it. Autoscaling stays off (Helius docs "Autoscaling": Developer's default limit is 0), so exhausting the account stops Helius with a 429 "max usage reached" (Meme-snipe `docs/DECISIONS.md` HELIUS-EXHAUSTED) rather than billing more, and that stop would also halt the signer's and the engine's Helius use. **P21:** every workflow that reads a `HELIUS*` secret reserves its maximum credits in the account ledger before its first request, so the reservation counts in S, or it is removed. The reservation is written by compare-and-swap to `zeroed-data` (`helius/<runId>/reservation.json`) before the first request; the host counts it into S, in full for 31 days whatever the run reports, and a run whose reservation the host has not yet counted refuses to send (Z0D-2 final push). The owner confirms in the Helius dashboard that autoscaling is off (limit 0) and keeps it off; Meme-snipe `docs/DECISIONS.md` records it from the owner's message before any B-10 pin and before M2's first Helius use; P18 fails any Helius workflow that has no credit cap and no reservation step. P21 lands before the Blueprint engine's first Helius use (M2) and before any B-10 pin. Supervisor rule (recorded in HANDOVER by the supervisor): until P21 lands, no Helius workflow is dispatched without the supervisor first recording its maximum credits in HANDOVER.
     - **Allocations, credits and rate.** `/etc/bot/rpc-allocation.json` (owner `root`, mode 0644, read-only to every service) splits each account's credit cap **and** its 50%-of-documented rate budget between consumers, and every limiter reads its share from there; the shares never add up to more than the cap or the 50% rate budget, and at start every process refuses to run otherwise (`E_ALLOCATION_EXCEEDS_CAP`). Chainstack: signer 50,000 RU and the engine (worker and sentinel) the rest of the credits; rate as A-M14-02. Helius **outside a B-10 window**: signer 50,000 credits and 2 req/s; engine the rest of the 5M default and 5 req/s, `sendTransaction` 0.5/s; the B-10 job 0 credits and 0 req/s. Signer values are VERIFY by measurement before M4. **Engine Helius floor:** 1,000,000 credits of remaining rolling headroom (POLICY: the engine's whole Helius use was sized to fit Helius Free's 1M a month, ARCH D03, 11.2); below it M26 refuses paper or above (B-M26-04).
     - **Helius B-10 route: not chosen (owner, 2026-10-08 about 7:25 AM: "Old faithful but by batch to avoid blockage"; C-79).** Gate B-10's history comes from the Old Faithful archive at 0 Helius credits, in batches (Meme-snipe `research/z-h-estimate/OLD-FAITHFUL.md`; A-M13-06 step 3). The bullets and acceptance criteria marked **[not chosen]** (the B-10 window on Helius, the job instance and lease, P10 and its calibration, the storage precondition of the Helius job, the time after the window, `B10-ACK` rows and their `acctCap`, `botctl b10-reserve`, the `b10-helius` environment and `HELIUS_B10_KEY`, P17–P20) are kept for the record and are not built: no `B10-ACK` row is pinned, `acctCap` stays at the 5M default, no Helius reservation is made for history, and the engine never loses its Helius allocation to B-10. **Still in force for every Helius consumer:** the one account-level ledger checked before every send, the signer's block, the rolling 31-day account caps, the allocations, the four ledger counts, and Z-H prep P21 (every workflow that reads a `HELIUS*` secret reserves its maximum credits in the account ledger before its first request, or is removed).
     - **[not chosen, owner 2026-10-08; C-79]** **B-10 window: the job runs alone on Helius** (supervisor rulings, Z0D rounds 7 and 8). During the window `[from, to)` (UTC, at most 14 days) of the pinned `B10-ACK` row, the engine's and the signer's Helius allocations are 0 credits and 0 req/s, and they run on Shyft and Chainstack; the job holds the whole Helius rate share (≤ 25 req/s, 50% of Developer's 50). A window may open only while no paper or live session depends on Helius: in practice in M2, before any M3 paper session; the job refuses to start if the engine's system mode is paper or above or a paper session is open, and M26 refuses any switch to paper or above while a B-10 reservation is active (B-M26-04). The job sends only inside `[from, to)` and stops at `to`. Before it starts, and only at or after `from` (when the engine's and the signer's Helius allocations are already 0, so the spend cannot grow between the read and the reservation), the operator reserves on the host (a new `botctl b10-reserve <ackId>` subcommand, which also publishes the reservation record, with `U`, S, the cited estimate and the pinned ack, to the job's lease file `b10/<ackId>/lease.json` in `macdarenz-droid/zeroed-data`, where an off-host job reads it) its usable cap `U = min(row cap, acctCap − S)`, as one entry in the account ledger, where **S** = max(the account ledger's rolling 31-day Helius spend, the signer's block included; the row's `dashUsed` **plus the account ledger's spend since the date of that reading**; Z0D round 9), where `dashUsed` is the account's credit-cycle usage the owner read from the Helius dashboard on a stated date, summed over every project on the account, with the cycle's start date as the dashboard shows it (`cycleStart`), which must be no more than 2 days before the reservation, else the reservation is refused). The row's `exclusive=yes` is the owner's confirmation that nothing outside the bot's own spend ledger uses the Helius account, in any of its projects, during the window or the 31 days before it (Z0D-2); without it the reservation is refused. The Helius admin usage endpoint exists (RESULTS §7.2); whether its reading may replace `dashUsed` is **VERIFY** (it reports per project, and its cost per call is unconfirmed). `U` ≤ 0 refuses. **No partial runs:** the reservation record carries the credit estimate the owner saw, cited by file path and commit sha (today `research/z-h-estimate/RESULTS.md`; an operator-typed number is refused), and the job does not start unless `U` ≥ 1.1 × that estimate; otherwise it reports to the owner and waits. The job refuses to start without a reservation record for its ack id. The host counts all of `U` as spent for the whole rolling 31 days after the reservation; a lower final total from the job never frees credits (a misreport cannot cause an overspend). At most one B-10 window is active at a time: a second reservation while another window is open is refused.
     - **[not chosen, owner 2026-10-08; C-79]** **One job instance, ledger written ahead.** The job runs as a GitHub Actions workflow with a `concurrency` group per `B10-ACK` id, and holds the lease file `b10/<ackId>/lease.json` in the private repository `macdarenz-droid/zeroed-data` (which also carries the reservation record that `botctl b10-reserve` published), taken by compare-and-swap; the lease has a TTL of 15 minutes (POLICY) and is renewed by compare-and-swap with every chunk; a stale lease (past its TTL) can be taken over only by compare-and-swap, and a second live instance refuses to start. A takeover does not reset spend: the new holder continues from the written-ahead ledger, so spend stays bounded by `U` (Z0D round 9). Its consumption ledger, per `B10-ACK` id, lives in the same repository and is **written ahead**: credits are reserved there in chunks of at most 10,000 before the pages they pay for are fetched, and the job never fetches past its reserved chunks. At most one chunk can be lost in a crash, and a lost or unreadable chunk counts as spent, so the job's spend never exceeds `U`; a missing or unreadable ledger counts as the whole `U` spent. The job stops at `U` even if the account has room left, and stops if the pinned ack (id, commit, blob hash) changes. The owner places the Helius key as the secret `HELIUS_B10_KEY` of a protected Actions environment `b10-helius` (names POLICY) that only the B-10 job's workflow may use (an owner step, Meme-snipe `docs/DECISIONS.md` 2026-10-08 and `docs/MIGRATION.md` Owner waits). **Environment lock (owner step; Z0D-2 rounds 3 to 5).** The owner sets `b10-helius`'s deployment branches to "Selected branches and tags" with one branch rule, the repository's default branch, and no tag rule; no required reviewer (the chained restarts would stall on an owner click); and disallows administrator bypass of the environment. **Default-branch ruleset (required owner step in both key modes; Z0D-2 rounds 4 and 5).** The repository's `default_branch` as the GitHub API reports it (on 2026-10-08 `ccr-14987baf-i6lrsl`, which the API reported unprotected; never assume "main") gets a ruleset that requires a pull request, requires the `check` status check tied to the GitHub Actions app (integration id 15368: the `check` run on `c74ba7ea` reports `app.slug` `github-actions`, `app.id` 15368, read through `GET /repos/macdarenz-droid/Meme-snipe/commits/c74ba7ea…/check-runs` on 2026-10-08; REST "Rules for repositories" gives a required status check an optional `integration_id`, "the optional integration ID that this status check must originate from"), blocks direct pushes, force pushes (non-fast-forward) and deletion, and has no bypass actors. **Key modes (Z0D-2 round 5).** The job's token cannot read two settings: a ruleset's `bypass_actors` (returned only to a caller with write access to the ruleset) and whether administrators may bypass the environment (the REST environment schema has no such field). A one-off human reading would not hold for the window, because either setting can change during it. So **window-only key mode is the expected path.** The mode is set only by the field `keyMode=window-only` in the pinned `B10-ACK` row, written by the supervisor only from an owner message, and copied into the pin marker; P19 requires the row and the marker to agree. No dispatch input, repository or environment variable, or flag selects or overrides the mode; a dispatch input naming it makes the job refuse. In window-only mode the owner places `HELIUS_B10_KEY` in `b10-helius` only when the window starts and deletes it when the window ends (owner steps). A row without `keyMode` is in standing mode, where the key may stay in the environment; standing mode needs P19 to read both settings, which the job's token cannot do today, so a standing-mode job refuses. **Environment check (card Z-H prep P19).** The B-10 job's first step, and P10's, reads through the GitHub API and, in either mode, refuses to start unless: `deployment_branch_policy` is non-null with `protected_branches` false and `custom_branch_policies` true; the branch-policies listing shows `total_count` 1, one policy of type `branch` whose name equals the repository's `default_branch`; the active rules for that branch (`GET /repos/{owner}/{repo}/rules/branches/{branch}`) include `pull_request`, `required_status_checks` naming `check` with `integration_id` 15368, `non_fast_forward` and `deletion`; and the row's and the marker's `keyMode` agree; and **the guarding files are unchanged (Z0D-2 round 7)**: at job start and at every chained restart, P19 hashes the default branch's copies of the B-10 workflow, the whole `.github/actions/p17-guard/` folder, all of `tools/policy/**` (the P18 policy code) and `.github/workflows/ci.yml`; the list of guarding paths is itself fixed in `tools/policy/**`, so it is hashed too; the guard action and the P17 and P18 checks use Node built-ins only, with no dependencies, so no lockfile or helper outside the hashed set can change them (Z0D-2 round 8); and refuses unless each matches the hash the supervisor pinned in the pin marker, computed at pin time from the reviewed default-branch commit. Anything unreadable among these refuses, with one exception: the REST page does not show whether "Get rules for a branch" returns `integration_id` (**VERIFY** by a first run); if it is not returned, standing mode refuses and window-only mode records it as "unverified, window-only" (never skipped silently), like the two bypass settings. In standing mode it also requires `bypass_actors` empty and administrator bypass off, both read, and refuses otherwise. In window-only mode it records those two items (and an unreturned `integration_id`) as "unverified, window-only" in the job report and continues. **Window close (Z0D-2 rounds 5 to 7; not a job step).** **Closing readings:** when the job stops (at `U` or on any exit, resumable or not), it takes a usage reading through the admin endpoint, and the supervisor takes another at `to` (or `botctl` does, on the host), before `closed.json` can be written; a gap above the tolerance at either reading, against the ledger's billed counts, is reported to the owner, and `closed.json` is not written until the owner has seen it. After `to`, the supervisor asks the owner to delete `HELIUS_B10_KEY` from `b10-helius` and, if a per-window Helius key was used, to revoke it in Helius. When the owner confirms, the supervisor writes an append-only `b10/<ackId>/closed.json` to `zeroed-data` that quotes the owner's message and its time. P17 unblocks for that ack only when `closed.json` exists **and** the first credit-cycle reset strictly after the later of `to` and the job's last request (its stop reading) has passed (Z0D-2 round 8), so a window that crosses a reset stays blocked until the following one. **Reset date (Z0D-2 round 8):** when the admin endpoint is used, the reset is taken from its own cycle fields; otherwise it falls on the same day of the month as the row's `cycleStart`, moved back to the month's last day when that day does not exist (for example a `cycleStart` on the 31st resets on 30 Nov and 28 or 29 Feb), and on that no-endpoint path P17 adds one extra day after the computed reset as a margin for time zones. The owner's ack message copies `cycleStart` exactly as the Helius dashboard shows it; a job crash does not matter, because the close never depends on the job. No scheduled workflow and no extra token are added. Listing the environment's secret names (`GET /repos/{owner}/{repo}/environments/b10-helius/secrets`, "Environments" (read)) stays an optional check for a token that can read it: the job's `GITHUB_TOKEN` cannot, because the workflow `permissions` keys include no `environments` (reviewer, round 5). **Preferred:** the owner creates a dedicated Helius API key for each window and revokes it in Helius after `to`, so a leftover secret is dead. Helius's authentication guide says to "use different API keys for development, staging, and production environments" (https://www.helius.dev/docs/api-reference/authentication, read 2026-10-08), so one account can hold several keys; the guide says nothing about deleting or revoking a key, so revoking one key on its own is **VERIFY** in the Helius dashboard, and if it cannot be done, the leftover-secret check above is the only guard. **Sources** (GitHub Docs, read 2026-10-08): the "Deployments and environments" reference (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments: options "No restriction", "Protected branches only" and "Selected branches and tags"; deployment branches and tags are "available for all public repositories"; administrators can bypass protection rules by default, and this can be disallowed); REST "Deployment environments" (`GET /repos/{owner}/{repo}/environments/{environment_name}`, fields `deployment_branch_policy` with `protected_branches` and `custom_branch_policies`, and `protection_rules`; no administrator-bypass field); REST "Deployment branch policies" (`GET …/environments/{environment_name}/deployment-branch-policies`, fields `total_count`, `branch_policies[].name` and `.type`, usable only when `custom_branch_policies` is true); REST "Rules for repositories": "Get rules for a branch" returns the active rules that apply to the branch, so rulesets in "evaluate" or "disabled" are not returned, and "Get a repository ruleset" returns `bypass_actors` only if the caller has write access to the ruleset; and "Permissions required for fine-grained personal access tokens": environment GETs under "Actions" (read), environment secrets under "Environments" (read), `rules/branches/{branch}` and `rulesets/{ruleset_id}` under "Metadata" (read); whether the job's `GITHUB_TOKEN` reads them all is **VERIFY** by a first run, and a read failure refuses. **Closed VERIFY items (Z0D-2 round 3, closed in round 5):** (a) with "No restriction", a job on any branch that names the environment gets its secrets: the reference page says environment secrets are available only to jobs that reference the environment, and that "No restriction" puts no limit on which branch can deploy, so together they show it (reviewer, round 3); (b) deployment branch rules and the administrator-bypass setting are available here: this repository is public (GitHub API, 2026-10-08), and the reference page makes deployment branches available for all public repositories. **P18 (CI policy check).** It fails if any workflow other than the B-10 job references `HELIUS_B10_KEY` or the environment `b10-helius`. It also checks the B-10 workflow file itself: its `on:` is exactly `workflow_dispatch` (the chained restarts included), it has no `workflow_call` and no input that names the key mode, and it checks out only the default-branch sha it runs on; any other workflow that calls it (`uses:` of that file) fails P18. **Secret routes (Z0D-2 round 5):** P18 fails on `toJSON(secrets)`, on any dynamic `secrets[...]`, on `secrets: inherit`, and on any `HELIUS*` secret in a workflow-level or job-level `env:`; a `HELIUS*` secret may appear only in the `env:` or `with:` of a step that comes after the P17 guard step in the same job. **Guards that cannot be skipped (Z0D-2 rounds 6 and 7):** the P17 guard is a fixed local action, `uses: ./.github/actions/p17-guard`, on a step with no `if:`; P18 fails if the guard step has any `if:`, if the guard is an inline `run:` instead of that action, or if the guard's behaviour tests fail (Z0D-2 round 8): P18 runs them on every change and they cover refuse while an ack is active (through its marker, through its lease only, and through its pinned row only), refuse when `zeroed-data` cannot be read, refuse when the integration branch cannot be read, refuse on a missing marker, allow only after `closed.json` and the reset of the window close, and refuse for a window that crosses a reset with `closed.json` after that reset until the following reset (Z0D-2 rounds 8 and 9); **pinned actions (Z0D-2 round 9):** P18 requires every `uses:` in the hashed workflows and in the guard action to be pinned to a full 40-character commit sha, local `./` actions exempt because they are hashed; a change to the action without a change to its test in the same commit stays only as an extra signal; P18 also fails if the P17 guard step or its job has `continue-on-error`, and if any step holding a `HELIUS*` secret has an `if:` that uses `always()`, `failure()` or `cancelled()`. **P17 (Z0D-2 rounds 2 to 5).** Every other workflow that reads a Helius secret runs the P17 guard first and refuses while any B-10 ack is **active**. An ack is active if any one of these shows it: its pin marker in `zeroed-data`, from its pin until its window ends; its lease; or a pinned `B10-ACK` row in `docs/DECISIONS.md` at the integration branch head whose window has not ended. It also stays active after `to` until its `closed.json` exists and the first credit-cycle reset strictly after the later of `to` and the job's last request has passed (window close, above). If `zeroed-data` or the integration branch cannot be read, P17 refuses; a missing lease never means inactive. **Pin marker (Z0D-2 rounds 4 and 5).** Order: the supervisor pins the DECISIONS row first, then writes `b10/<ackId>/pin.json` (ackId, `test`, `keyMode`, the window, and the sha256 of each guarding file at the reviewed default-branch commit) to `zeroed-data`; **supervisor rule:** from the pin until P17 unblocks for that ack (after `closed.json` and the reset above; Z0D-2 round 8), no PR that touches `.github/**` or `tools/policy/**` is merged (recorded in HANDOVER by the supervisor). The ruleset rule "require workflows to pass before merging" would add a further guard; GitHub's changelog of 2023-10-11 (https://github.blog/changelog/2023-10-11-requiring-workflows-with-repository-rules-is-generally-available/) describes it as organization-wide rules for GitHub Enterprise Cloud, so for this repository it is **VERIFY** and optional, used only if available; the `dashUsed` the reservation relies on is read after the marker (the fresh reading at reservation, or on the no-endpoint path an owner reading on the reservation's UTC day, below). Markers are append-only: never edited or deleted (a change is a new ack). If a marker is missing while a lease or a pinned row for that ack exists, and that ack has no `closed.json`, P17 refuses and alerts the owner. `botctl b10-reserve` refuses if the marker is missing or does not match the DECISIONS row. Outside use before the pin is caught by the `dashUsed` gap check below; A-M14-03's redaction rule applies to the job's logs (no key-bearing URL is ever logged).
     - **[not chosen, owner 2026-10-08; C-79]** **P10 throughput-test ack (card Z-H prep, RESULTS §7.3 @ `c74ba7ea`; Z0D-2).** A `B10-ACK` row may carry `test=p10`. Such a row has `to` = `from` + 1 day, a `cap` no higher than the P10 cap cited from RESULTS §7.3 (432,000), and the same `acctCap`, `exclusive=yes` and `dashUsed` rules as any row. It is reserved with its own `botctl b10-reserve <ackId>` as its own entry. Because its cap is the limiter's attempt bound, not an estimate, `U` must equal the row cap, else the reservation is refused (this replaces the 1.1 × estimate rule for that row only). Its credit, like any download credit, waits for a strategy to survive Phase 0 and for the owner's C-76 ruling (ARCH 3.4): the supervisor writes no `test=p10` row before both. The P10 job runs one full job plus **at most 1 chained restart** (chain limit 1; P16's uncapped chain does not apply), at one setting (`rpc_rps`, `RPC_CONC`) and with the scanner and rpcscan revisions frozen by P2, and its effective rate is measured from the first job's start to the second job's end. Everything else above applies unchanged: the job runs alone on Helius in that window, one window at a time, one instance, ledger written ahead, and the whole `U` counts in S for the 31 days after its reservation, so a main reservation within those 31 days gets a smaller `U` (RESULTS §7.3). Its blocks count only as a test: they never enter the main ack's `pageLog`, and a `historyReplay` report citing a `test=p10` row fails B-10 (A-M13-06).
     - **[not chosen, owner 2026-10-08; C-79]** **P10 pass, verified by botctl (Z0D-2 round 2).** `botctl b10-reserve` accepts for a main ack only a P10 report that the P10 job wrote itself to `b10/<p10AckId>/p10-report.json` in `zeroed-data`, naming the `test=p10` ackId it ran under, its setting (`rpc_rps`, `RPC_CONC`) and the frozen scanner and rpcscan revisions. botctl checks that this ack is pinned and was reserved in the account ledger; that its window has closed; that its job ledger and lease exist in `zeroed-data` with a ledger total ≤ its `U`; and that the effective rate, which botctl recomputes from the job's own timestamps (first job's start to the restart's end) counting **only blocks fetched from Helius under this ack** (never a cached or earlier-scan unit), is ≥ 8 blocks/s, with blocks fetched ≤ the attempts in the ack's ledger, and that the report records the account's usage change over the window against each of the four ledger counts, with that billed-count result pinned with the P10 row, with retries ≤ 25% of attempts from the job's own attempt log. The main ack must name the same setting and the same frozen revisions, and the main job refuses to run with any other. A report that fails any check is refused, and the main ack is not reserved.
     - **Ledger counts (Z0D-2 rounds 4 and 5; the P10 calibration and the main-pull stop are not chosen, owner 2026-10-08, C-79).** The account ledger and each job ledger keep four counts: **attempts** (every request sent, whatever its result; every spend cap uses this count), **successful results**, **error or 429 responses**, and **client-side timeouts**. Whether Helius bills 429s, errors and timed-out requests is **VERIFY**: Helius docs "Credits" (https://www.helius.dev/docs/billing/credits, read 2026-10-08) list failed `getTransactionsForAddress` responses as free and say nothing general about 429s, errors or timeouts. Until P10 settles it, **billable responses** means successful results only: a lower bound on what Helius bills, so the outside-use checks (the gap check, the fresh reading at reservation and the in-window check) can only refuse on the difference, never hide use. Timeouts are not billable until measured, which is also the lower-bound choice. **P10 settles it.** The P10 report measures the account's usage change over its window against each count; that result is recorded and pinned with the P10 row, and decides which counts the main pull's checks treat as billed; the main ack is refused until it exists. **Calibration rule (Z0D-2 round 6).** A category (error or 429 responses, or timeouts) counts as billed only if P10's usage change minus its successful results is at least that category's count minus the tolerance, and the amount still unexplained after adding it is within the tolerance (`b10.outside_use_tolerance_credits`, 10,000); applied to the possible sets of categories (none, either, both), the result names the one set whose counts, added to successful results, match the usage change within the tolerance. If no set matches, or more than one does, the result is "inconclusive" and the lower bound (successful results only) stays. The main pull stops (non-resumable, reported to the owner) if its non-success share of attempts rises more than 5 percentage points (POLICY) above P10's measured share. **Why a wrong calibration cannot cause overage.** Every spend cap counts attempts, so the job's real billed use is at most its attempts, at most `U`; outside use that the in-window check misses fits inside the gap between treated-billed and actually-billed requests, plus the tolerance. So account usage stays ≤ S + U + 2 × tolerance (one for the reservation's gap check, one for the in-window check) ≤ `acctCap` + 20,000 ≤ 9,520,000, below the plan's 10M: a wrong calibration can hide outside use, never cause overage. **Scope of the bound (Z0D-2 round 7).** On the endpoint path it holds up to the last usage reading plus one reading interval. Use between readings, or after the job stops, is covered only by `exclusive=yes`, while P17 blocks this repository's own Helius workflows until the first credit-cycle reset strictly after the later of `to` and the job's last request has passed (window close, above). On the no-endpoint path the bound rests on `exclusive=yes` alone. Whether the Helius Developer plan bills overage or stops at its limit is **VERIFY**: Helius docs "Autoscaling" (https://www.helius.dev/docs/billing/autoscaling, read 2026-10-08) say autoscaling is off by default on Developer (limit 0) and extra credits cost $5 per million when it is on, but do not say in so many words what happens when credits run out; Zeroed's record of Helius refusing for used-up credits (Meme-snipe `docs/DECISIONS.md` HELIUS-EXHAUSTED) suggests a hard stop while autoscaling stays off. The owner keeps autoscaling off. P10's own requests are in the ledger's sent counts, so they are never outside use: inside P10's window the in-window check compares usage growth with P10's attempts, because billed 429s must not stop the test that settles billing. This is **explicitly accepted** (Z0D-2 round 6): the outside use it could hide is at most P10's non-success count, ≤ 25% of its at most 432,000 attempts, about 108,000, inside the 500,000 headroom between `acctCap` (9.5M) and the plan's 10M; the P10 report states the actual figure. **Use outside the ledger (Z0D-2 round 2).** The bot's own spend ledger is the account ledger. The signer's own file `/var/lib/signer/rpc-usage.json` is part of it through its standing 50,000-credit entry in the account ledger, so the signer's use within that block is not use outside the ledger. The reservation is refused if the row's `dashUsed` is above the ledger's sum of **requests actually sent** (not reserved `U` or unused reservations) from the row's `cycleStart` to the reading's date, plus `b10.outside_use_tolerance_credits` (POLICY, 10,000): the gap would be use outside the ledger in the current credit cycle ("requests actually sent" here means the counts treated as billed: successful results only until the P10 result is pinned). **Fresh reading at reservation (Z0D-2 round 4).** `botctl b10-reserve` also takes a fresh usage reading through the admin endpoint at the moment of reservation, runs the same gap check against requests sent up to that moment, and refuses on a gap; that reading is the in-window baseline. If the endpoint cannot be used (cost, or it reports per project and a project is unlisted), the owner's `dashUsed` must be read on the same UTC day as the reservation and after the pin marker was written, so P17 was already blocking; otherwise the reservation is refused. On that no-endpoint path the owner's project list is the only source of projects, and use in an unlisted project cannot be detected. Outside use in the previous credit cycle that is still inside the 31-day ledger window is covered only by `exclusive=yes`; this is not looser than before (F3). `exclusive=yes` covers every project on the Helius account. If the usage reading is per project (**VERIFY**; the admin endpoint is per project, RESULTS §7.2), the owner lists every project of the account in the ack message, `dashUsed` is their sum, and the in-window check reads each one. Inside the window, the job reads the Helius admin usage endpoint (RESULTS §7.2) for every listed project every 10 chunks (POLICY), each call written ahead in its ledger, and stops (non-resumable, reported to the owner) if the account's usage has grown since the baseline (the reservation's fresh reading) by more than the job's ledger spend since then, plus the other allocations in force (0 inside the window), plus the tolerance. The endpoint reports the credit cycle, not a rolling 31 days, so only growth is compared. **At a credit-cycle reset** (the next reset follows from `cycleStart`): the job takes a reading just before the reset time (in the last chunk before it), compares it as above, and only then re-takes the baseline after the reset. The report states the **remaining exposure**: outside use between the last reading before the reset and the reset itself, at most one reading interval of 10 chunks (≤ 100,000 credits), is not caught. Its cost per call is **VERIFY** (RESULTS §7.2 budgets 100 credits for these calls inside `U`). If the measured cost would take the calls over a 14-day window above that budget, the in-window check is not run, the report says so, and exclusivity inside the window rests on the owner's `exclusive=yes` alone.
     - **[not chosen, owner 2026-10-08; C-79]** **Storage precondition.** The job may run off the host (GitHub-hosted runners, `docs/reviews/ZH.md` round 2 item 3), since it needs about 0.5–1.4 TB, far more than the host's 55 GB disk (RESULTS §6). **Credit and time figures are cited, never retyped** (Z0D-2): `research/z-h-estimate/RESULTS.md` and `research/z-h-estimate/estimate.json` @ `c74ba7ea` (PR #288), §1, §3 and §7.3: for the 30-day window the estimate shown to the owner is 7,762,033 and the row cap 9,022,478; P10 (the throughput test) is separate, 432,000 under its own `B10-ACK` with `from=D to=D+1`; total exposure 9,454,478. A 31-day pull inside a 14-day window needs an effective 5.94 blocks/s (job restarts, setup, saves and QA counted), so the main ack's reservation is refused until a P10 report shows an **effective rate ≥ 8 blocks/s with retries ≤ 25% of attempts** over a full job and a restart (RESULTS §7.3; supervisor ruling), verified by `botctl b10-reserve` as in "P10 pass" below; otherwise there is no pull. Its storage must be a named $0 location, decided by the owner (DATA-PUB and DATA-STORE), before any credit is spent: a hard precondition. Reservation precondition (before any credit): either the owner runs `botctl b10-reserve` on the host, or the owner sets up a tailnet path for the job machine; until one exists the job refuses to start. The owner also places the Helius key as `HELIUS_B10_KEY` in the protected environment `b10-helius` before any run.
     - **[not chosen, owner 2026-10-08; C-79]** **After the window** the job's spend stays inside the rolling 31-day sum, so the engine's Helius allocation (5M default − signer block − that spend) can be 0 for up to 31 days. Meanwhile RPC C failover, Helius expiry proofs and fee estimates are unavailable to the engine (fees fall back to the floor, D15); the window is scheduled so this ends before any M3 paper or M4 live step, and this is measured again before M4 (Meme-snipe `docs/DECISIONS.md` 2026-10-08). M26 refuses paper or above until the engine's headroom is back above its floor, and a P gate fails any window in which the engine had no Helius (A-M13-06).
     - **Off-host research never uses Chainstack.** It uses a different provider under its own ≤ 50% limiter.
  3. Projection: `projected = used + rate_last_24h × hours_left_in_month`; alert warning when `projected ≥ 80%` of the allowance (ARCH 13.4 "Provider burn rate"); from then on P1-P4 traffic leaves that provider (A-M14-02 step 6).
  4. Degraded mode: if the unmetered primary has had no successful response for 60 s while requests were attempted, or answered only with 429s for 60 s → `degraded_reads` (publish `rpc.mode`, alert warning); return to `normal` after 60 s of continuous success. While degraded, M05 shrinks the watchlist to positions, P2-P4 stop, entries are blocked by M21 (ARCH 11.2).
  5. `E_ALL_PROVIDERS_DOWN` for 10 s → overall health `down`, alert critical (ARCH 13.4).
- **Shared resources and concurrency:** owned by M14; counters written by the gateway only.
- **Config:** `rpc.health.down_after_ms` (10,000), `rpc.degraded.enter_after_ms` (60,000), `rpc.degraded.exit_after_ms` (60,000), `rpc.burn.alert_bps` (8,000, 5,000-9,500); `rpc.chainstack.rolling_31d_ru_cap` (1,500,000) and `rpc.helius.rolling_31d_credit_cap` (5,000,000 default; raised only by a `B10-ACK` `acctCap`, which is not chosen (owner 2026-10-08; C-79), so it stays 5,000,000, ≤ 9,500,000, inside the job window), both per account, validation refusing values above 50% of the documented monthly allowance; `rpc.reserve_block_units` (≤ 1,000); the signer's blocks come only from `/etc/bot/rpc-allocation.json`, never from engine config.
- **Edge cases and failure handling:** clock jump at month end → counters keyed by UTC month string; a provider without metering → `monthlyAllowance` null in VM-13.
- **Acceptance criteria:** Given the primary down for 61 s, then `mode() = 'degraded_reads'`, and, in the degraded-load model of ARCH 11.2 (≈ 1.2 req/s), the metered providers' projections stay under 80% for a 1 h outage (ARCH 16.5 "Shyft down for 1 h").
  - Given a signer block of 50,000 RU, then the engine ledger's Chainstack cap is 1,450,000; given 724,999 `getSignaturesForAddress` calls and 1 `getMultipleAccounts` call in the last 31 days, then the engine ledger reads 1,449,999 RU; the next `getSignaturesForAddress` (2 RU) is refused before it is sent, and no engine-side process sends to Chainstack until the rolling sum falls; the signer can still use its own block; given a restart after the stop, the ledger keeps the stop.
  - Given two keys of the same Chainstack account, then both count in the one account ledger.
  - **[not chosen, owner 2026-10-08; C-79]** Given Helius shares of 4.9M (engine), 50,000 (signer) and 100,000 (B-10 job) against the default 5M cap, or rate shares adding up to more than 25 req/s, then every process refuses to start with `E_ALLOCATION_EXCEEDS_CAP`.
  - **[not chosen, owner 2026-10-08; C-79]** Given no pinned `B10-ACK` row, then the B-10 job's allocation is 0 and it refuses to start.
  - **[not chosen, owner 2026-10-08; C-79]** Given a pinned row with `cap=9022478` (the row cap cited from RESULTS §1 @ `c74ba7ea`), `acctCap=9500000` and S = 1,200,000 at reservation, then `U` = min(9,022,478, 9,500,000 − 1,200,000) = 8,300,000; inside the window the engine's and the signer's Helius allocations are 0 and an engine request to Helius is refused before it is sent; given the job at 8,300,000, then its next request is refused even though the account cap has room.
  - **[not chosen, owner 2026-10-08; C-79]** Given S = 9,600,000 at reservation, then `U` ≤ 0 and the reservation is refused.
  - **[not chosen, owner 2026-10-08; C-79]** Given a reservation attempted before `from`, or while another ack's window is open, then it is refused; given the job reporting a final total of 7,000,000 against `U` = 8,300,000, then the account ledger still counts 8,300,000 for 31 days.
  - **[not chosen, owner 2026-10-08; C-79]** Given the window over, then the account cap is back to 5M and an engine Helius request is refused while the rolling sum (the job's reserved `U` included) is at or above 5M − the signer's block.
  - **[not chosen, owner 2026-10-08; C-79]** Given the engine in paper mode or a paper session open, then the job refuses to start; given `to` − `from` above 14 days, then the row is refused.
  - **[not chosen, owner 2026-10-08; C-79]** Given a job that crashes holding the lease, then a new instance cannot take it before the 15-minute TTL passes, takes it after by compare-and-swap only (two racing takers: one wins, one refuses), continues from the written-ahead ledger, and the total spend stays ≤ `U`.
  - **[not chosen, owner 2026-10-08; C-79]** Given a second job instance for the same ack id, then it refuses to start (Actions `concurrency` group and the `zeroed-data` lease, compare-and-swap); given the job's remote ledger missing at restart, then the whole `U` counts as spent and the job does not resume; given a crash after a 10,000-credit chunk was reserved and before its pages were fetched, then that chunk counts as spent and the job's total never exceeds `U`.
  - **[not chosen, owner 2026-10-08; C-79]** Given no reservation record for the ack id (`botctl b10-reserve` not run), then the job refuses to start; given `botctl b10-reserve` run on the host, then the record appears in `b10/<ackId>/lease.json` in `zeroed-data` and an off-host job reads `U` from it; given that file's record differing from the host ledger's reservation, then the job refuses to start.
  - **[not chosen, owner 2026-10-08; C-79]** Given a row without `exclusive=yes`, then the reservation is refused; given the ledger's requests actually sent from `cycleStart` to the date of the row's `dashUsed=3000000` summing to 2,995,000 (a gap of 5,000, within the tolerance), a rolling 31-day ledger spend of 3,195,000 at reservation and 200,000 more in the ledger since the reading, then S = max(3,195,000, 3,000,000 + 200,000) = 3,200,000 and `U` = min(9,022,478, 9,500,000 − 3,200,000) = 6,300,000; given requests actually sent in that period summing to 2,980,000 (a gap of 20,000), then the reservation is refused as use outside the ledger; given 2,980,000 sent plus a 50,000 unused reservation in the ledger, then the gap is still 20,000 (reservations do not count) and the reservation is refused; given a `dashUsed` that is the sum of two listed projects, then the gap is computed on that sum.
  - **[not chosen, owner 2026-10-08; C-79]** Given a `dashUsed` dated 3 days before the reservation, then the reservation is refused; given an estimate typed by the operator with no cited file and sha, then the reservation is refused.
  - **[not chosen, owner 2026-10-08; C-79]** Given `U` = 8,000,000 and the cited estimate 7,762,033 (1.1 × estimate = 8,538,236.3), then the job does not start and reports to the owner. Given that estimate and `cap=9022478`: S = 961,763 gives `U` = 8,538,237 and the job may start; S = 961,764 gives `U` = 8,538,236 and it does not; S ≤ 477,522 gives the full cap (RESULTS §1).
  - **[not chosen, owner 2026-10-08; C-79]** Given a `test=p10` row with `cap=432000`, `from=D`, `to=D+1` and S = 100,000, then `U` = 432,000 is reserved as its own entry in the account ledger; given S = 9,100,000, then `U` = 400,000 < the row cap and the reservation is refused; given a `test=p10` row whose `to` is later than `from` + 1 d, or whose `cap` is above the P10 cap cited from RESULTS §7.3, then the row is refused.
  - **[not chosen, owner 2026-10-08; C-79]** Given a P10 reservation of 432,000 on day D, 100,000 of other spend in the account ledger, and the main row (`cap=9022478`) reserved on D+10, then P10's 432,000 still counts in S: S = 532,000 and `U` = min(9,022,478, 8,968,000) = 8,968,000 (the job may start, but below the full cap); given the same main reservation 32 days after P10's, then S = 100,000 and `U` = 9,022,478.
  - **[not chosen, owner 2026-10-08; C-79]** Given no P10 report, or no billed-count result pinned with the P10 row; a report naming no ack; a report naming a non-test ack; a report naming a `test=p10` ack that was never reserved or whose window is still open; a report whose ack has no job ledger or lease in `zeroed-data`, or a ledger total above its `U`; a report whose stated rate passes but whose job timestamps give an effective rate below 8 blocks/s; a report whose rate passes only because it counts a cached or earlier-scan unit, or whose blocks fetched exceed the attempts in the ack's ledger; or retries above 25%: then `botctl b10-reserve` refuses the main ack. Given a passing report and a main ack whose setting (`rpc_rps`, `RPC_CONC`) or frozen scanner or rpcscan revision differs from the report's, then the main ack is refused. Given a passing report and the same setting and revisions, then the main reservation proceeds under the rules above.
  - **[not chosen, owner 2026-10-08; C-79]** Given a P10 job that reaches a resumable stop after its one chained restart, then it is not re-dispatched (chain limit 1), and its effective rate is measured from the first job's start to the second job's end.
  - **[not chosen, owner 2026-10-08; C-79]** Given, inside the window, the usage endpoint showing growth of 1,250,000 since the first reading while the job's ledger shows 1,200,000 spent since then, then the job stops and reports to the owner; given growth of 1,205,000, then it continues; given a measured endpoint cost that would exceed its 100-credit budget over the window, then the in-window check is off and the report says so; given a credit-cycle reset inside the window, then a reading is taken in the last chunk before the reset and compared before the baseline is re-taken, and the report states the remaining exposure of at most 10 chunks.
  - **[not chosen, owner 2026-10-08; C-79]** Given a workflow other than the B-10 job that references `HELIUS_B10_KEY` or the environment `b10-helius`, then the CI policy check fails; given a non-test or `test=p10` row pinned and its window not yet ended, then any other workflow that reads a Helius secret refuses to run; given `zeroed-data` unreadable, then it refuses too. Given `b10-helius` set to "No restriction" or "Protected branches only", or to selected branches with any rule other than the single default-branch rule, then the B-10 job's (and P10's) first step refuses to start; given branch rules lacking any of `pull_request`, `required_status_checks` naming `check`, `non_fast_forward` or `deletion`, or rules that cannot be read, then it refuses in either key mode; given a `check` requirement with an `integration_id` other than 15368, then it refuses in either mode; given rules that do not return `integration_id`, then standing mode refuses and window-only mode records it as "unverified, window-only" and continues.
  - **[not chosen, owner 2026-10-08; C-79]** Key modes (Z0D-2 round 5): given a pinned row and marker with `keyMode=window-only` and every readable check passing, then P19 records `bypass_actors` and administrator bypass as "unverified, window-only" in the job report and the job continues; given a row without `keyMode` (standing mode) and those two settings unreadable, then P19 refuses; given a row with `keyMode=window-only` and a marker without it (or the reverse), then P19 refuses; given a dispatch input, variable or flag that names a key mode, then the job refuses.
  - **[not chosen, owner 2026-10-08; C-79]** Window close: given the window ended and no `b10/<ackId>/closed.json`, then P17 keeps refusing other Helius workflows, whether or not the job crashed; given `closed.json` quoting the owner's message that the key was deleted (and the per-window key revoked) but the window's credit cycle not yet reset, then a Helius workflow is still refused; given `closed.json` and the first credit-cycle reset strictly after the later of `to` and the job's last request passed, then P17 unblocks for that ack; given a window from 30 Nov to 14 Dec with a `cycleStart` on the 1st (so a reset on 1 Dec inside the window) and `closed.json` written on 15 Dec, then P17 still refuses until the reset on 1 Jan (plus one day on the no-endpoint path); given a `cycleStart` on the 31st, then the computed resets fall on 30 Nov, 31 Dec and 28 Feb (29 Feb in a leap year); given the endpoint's cycle fields, then they replace the computed date; given a stop reading whose growth since the baseline exceeds the ledger's billed counts by more than the tolerance, then the gap is reported to the owner and `closed.json` is not written before the owner has seen it; given an ack with `closed.json` whose marker is later missing, then the missing-marker rule does not apply to it; given an optional secret list that still shows `HELIUS_B10_KEY` after `to`, then the owner is alerted.
  - **[not chosen, owner 2026-10-08; C-79]** Given a pin marker deleted while the pinned DECISIONS row's window is still open, then P17 refuses and alerts the owner; given a pin marker deleted while the ack's lease exists, then P17 refuses and alerts the owner.
  - **[not chosen, owner 2026-10-08; C-79]** Given no `b10/<ackId>/pin.json` marker, or one whose ackId, `test` or window differs from the DECISIONS row, then `botctl b10-reserve` refuses; given `zeroed-data` unreadable, then P17 refuses every Helius workflow and `botctl b10-reserve` refuses; given a pin marker written and no lease yet, then P17 refuses.
  - **[not chosen, owner 2026-10-08; C-79]** Given outside use between the owner's `dashUsed` reading and the reservation (the fresh reading at reservation exceeds requests sent up to then plus the tolerance), then the reservation is refused; given the endpoint unusable and a `dashUsed` read on an earlier UTC day, or before the pin marker was written, then the reservation is refused.
  - **[partly not chosen, owner 2026-10-08; C-79: the clauses on the B-10 workflow, the P17 guard and P19 are not built; the clauses on `toJSON(secrets)`, dynamic `secrets[...]`, `secrets: inherit`, a `HELIUS*` secret in workflow- or job-level `env:`, `if: always()`, `failure()` or `cancelled()` on a step holding a `HELIUS*` secret, full-sha pinning of `uses:`, and P21's credit cap and reservation step stay in force for every workflow that reads a `HELIUS*` secret]** Given the B-10 workflow with `on:` including `schedule`, `pull_request_target`, `workflow_run`, `issue_comment` or `workflow_call`, or a checkout of a ref other than the default-branch sha it runs on, or another workflow with `uses:` of the B-10 workflow file, then P18 fails; given a workflow that reads `secrets.HELIUS_API_KEY` with no P17 guard step before it, then P18 fails; given a workflow using `toJSON(secrets)`, a dynamic `secrets[...]`, `secrets: inherit`, or a `HELIUS*` secret in a workflow-level or job-level `env:`, then P18 fails for each; given a `HELIUS*` secret in the `env:` of a step after the P17 guard step in the same job, then P18 passes; given `continue-on-error` on the P17 guard step, or on its job, then P18 fails for each; given the guard step with any `if:`, or a guard written as an inline `run:` (for example ending in `|| true`), then P18 fails for each; given a guard that allows a run while an ack is active, or when `zeroed-data` is unreadable, or with a marker missing, or after `closed.json` but before the reset, then its behaviour tests fail and P18 fails; given a trivial edit to the test beside a weakened guard, then the behaviour tests still fail and P18 fails; given a guard that allows a run when the ack is shown only by its lease, or only by its pinned row, or when the integration branch is unreadable, or for a window that crossed a reset with `closed.json` written after that reset and before the following one, then its behaviour tests fail and P18 fails; given a `uses: actions/checkout@v4` (a tag) or a 7-character short sha in the B-10 workflow, `ci.yml` or the guard action, then P18 fails, and given the same pinned to a full 40-character sha, or a local `./` action, then it passes; given a workflow that reads a `HELIUS*` secret with no credit cap and no step reserving its maximum credits in the account ledger, then P18 fails (P21); given a default-branch `ci.yml` (or B-10 workflow, guard action or policy code) whose sha256 differs from the hash in the pin marker, at job start or at a chained restart, then P19 refuses; given a step holding a `HELIUS*` secret with `if: always()`, `if: failure()` or `if: cancelled()` (alone or inside a larger expression), then P18 fails for each.
  - **[not chosen, owner 2026-10-08; C-79]** Given, in the main window before any P10 result is pinned, 1,000 attempts with 750 successful results, 200 429s and 50 timeouts, then billable responses are 750 (successful results only) and a usage growth of 1,000 since the baseline counts as 250 of outside use (refused above the tolerance), while the spend caps count 1,000; given no pinned P10 billed-count result, then the main ack is refused; given a pinned P10 result that shows 429s billed, then the main pull's checks treat successful results plus 429s as billed; given P10's own window with 432,000 attempts of which 100,000 were errors or 429s, then the in-window check treats all 432,000 as P10's own and the report states the 100,000 that this could hide.
  - **[not chosen, owner 2026-10-08; C-79]** Calibration (Z0D-2 round 6): given P10 with 300,000 successful results, 100,000 429s, 32,000 timeouts and a usage change of 405,000, then 429s count as billed and timeouts do not (105,000 left after successes; with 429s 5,000 unexplained, within 10,000; with timeouts alone 73,000, with both −27,000, with none 105,000, all outside it); given the same counts and a usage change of 360,000, then no set matches (60,000 left: none 60,000, 429s −40,000, timeouts 28,000, both −72,000), so the result is "inconclusive" and the main pull counts successful results only; given P10's measured non-success share of 20% and the main pull's share reaching 25.1%, then the main pull stops and reports to the owner; at 24.9% it continues.
  - **[not chosen, owner 2026-10-08; C-79]** Given a wrong calibration that treats 429s as billed when Helius does not bill them, and S = 477,522 with `U` = 9,022,478, then account usage is still at most S + U + 20,000 = 9,520,000, below 10M.
  - Given the signer restarted 10 times in one day, then its block in the account ledger is still one 50,000 entry.
  - Given a job log line with the Helius key in a URL, then the key is replaced with `[redacted]`.
  - **[not chosen, owner 2026-10-08; C-79]** Given the pinned row's blob hash changing on the integration branch during the job, then the job stops before its next page.
  - **[not chosen, owner 2026-10-08; C-79]** Given a pinned row with `acctCap=9600000`, then validation refuses it (above 95% of the plan).
  - Given the engine process trying to write the signer's ledger file, then the write fails (file owner `signer`, mode 0600).
  - Given two processes on one key, each trying 0.5 req/s of `getSignaturesForAddress`, then together they never exceed the one bucket's rate and the ledger counts both; given requests that time out or return 429, then each is counted.
  - Crash loop: given a process killed right after each send and restarted 100 times, then the ledger holds every sent request (or its reserved block), and no restart lowers the count.
- **Tests:** unit with fake clock; failure injection: primary outage 1 h; projection arithmetic.
- **Observability:** metrics `rpc_projected_month_end_bps{provider}`, `rpc_credits_used{provider}`, `provider_slot_lag{provider}`, `rpc_mode`; VM-13 `rpc[]` fields.
- **Security notes:** none.
- **Facts used:** LD-27, LD-28, LD-32, LD-33, VF-10.
- **Definition of done:** VM-13 `rpc[]` and the degraded-mode drill pass in Phase 0.

## Architecture clarifications

Each item is an ambiguity in `ARCH.md` (or a gap between modules) and the reading this spec chose. The rule was: choose the safest reading, never weaken a risk control, and log it here for the integrator. "B action" means group B or the integrator must adopt or reject it. Integration outcomes are marked **Integration** in the last column; items without that mark were checked and need no group B action beyond what the row says (ARCH section 5.0b lists every interface change adopted).

| ID | Where | Ambiguity or gap | Resolution in this spec | B action |
|---|---|---|---|---|
| C-01 | M01 | ARCH defines `VenueModel` only; config caching, venue status, normalisation and the orientation guard need public surfaces. | Added `VenueConfigCache`, `VenueStatusService` (`status`, `onFillEvent`), `normalisePool`, `OrientationGuard`, and events `venue.status_changed`, `venue.fee_schedule_changed`, `venue.pool_quarantined`. M01 consumes a topic `fill.events` carrying decoded own-fill events with their `poolId`. | M18/M23 publish `fill.events`; M20/M21 subscribe to the venue events; add these names to the frozen contracts. **Integration:** adopted; `fill.events` produced by B-M18-03 and A-M12-01; events listed in ARCH 5.0b. |
| C-02 | M02 | M02 is consumed by the signer, which must have zero third-party runtime dependencies (ARCH 4.3, 12.3), but nothing said M02 must comply. | `@bot/decoders` uses Node built-ins only (own base58, readers, `node:crypto`); it must not import `@solana/kit`. | M17/M30 dependency checks include this package. **Integration:** adopted; B-M17-04 imports A-M02-01's core (no second base58). |
| C-03 | M02 | `DecodedAccount` lacks global-config, pump-global and mint variants; the signer needs instruction decoding (ARCH M17 "from the decoded instructions") but `Decoders` has no such method. | Added variants `pumpswap_global_config`, `pump_global`, `spl_mint`; `decodeAccountWithFlags`; `DecodedInstruction` and `decodeInstruction`. | M17 adopts `decodeInstruction`; integrator updates 5.0a. **Integration:** adopted into ARCH 5.0b; B-M17-04 consumes A-M02-06. |
| C-04 | M01 | Canonical pools are defined by `pool.creator == pumpPoolAuthorityPda(baseMint)` [EX-08], but the PDA seeds are not in the register. | Seeds are a VERIFY item; until verified `isCanonical = null` → `pool_canonical` = `error` → reject; `feeFor` → `E_FEE_UNKNOWN`. The A-24 count lists such pools separately. | None. |
| C-05 | M14/M15 | M15 owns `highestSeenSlot()` = max context slot "over every response from any provider", but responses arrive at M14. | M14 publishes `rpc.context_slot { providerLabel, contextSlot, atMs }` for every response that has one. | M15 subscribes and maintains `highestSeenSlot`. **Integration (changed):** payload includes `method` (`{ providerLabel, contextSlot, method, atMs }`, CL-01); A-M14-01 updated. |
| C-06 | M04 | M05's eviction tail needs a 0.1 Hz watch class; M12 and M08 need snapshot history; consumers must recompute lag at use time (ARCH 8.5 defines lag "at the time of use"); M07 needs a change detector. | Added `watch(pool, 'tail')`, `history()`, `lagNow()`, `PoolSnapshot.rawHash`. | M19/M20/M21 use `lagNow()` when checking the 12/8-slot thresholds. **Integration:** adopted (ARCH 5.0b); B-M19/B-M20/B-M21 use `lagNow()`. |
| C-07 | M04/M14 | ARCH lists "P2 pool polling", but degraded mode must keep polling position pools while P2 stops (ARCH 11.2). | Position-pool polling runs at P1; candidates at P2; tail at P4. | None. |
| C-08 | M04 | `PoolSnapshot.feeTotalBps` is a non-null `Bps`, but the fee can be unknown. | Unknown fee → 10,000 bps sentinel (fails every fee ceiling). | M21/M28 treat 10,000 as "unknown" in displays. **Integration:** adopted; B-M28-03 renders 10,000 as unknown. |
| C-09 | M04 | `freshRead(poolId, maxLagSlots)` must serve builds (≤ 8 slots, abandon if stale) and exits (never blocked, alert > 40) with one signature. | Finite `maxLagSlots` = entry grade (P1, one re-read, then `E_STALE`); `Number.POSITIVE_INFINITY` = exit grade (P0, never `E_STALE`, alert when lag > 40). | M19 passes 8 for entry builds; M20 passes `Infinity` for exits. **Integration:** adopted as binding; B-M16-04 step 2 and B-M20-02 step 5 changed to these semantics (CL-55 consistent). |
| C-10 | M01 | The fee program's market-cap input (vault only or effective reserves) and tier-boundary inclusivity are not in the register. | Use the lower of the two market caps and, at an exact threshold, the more expensive adjacent tier; also the more expensive of pre- and post-trade tiers. The realised-fee mismatch check compares against every tier considered, so conservatism does not trigger false mismatches. **Settled 2026-10-07 [VF-04]:** the program uses the effective quote reserve (mayhem pools a fixed 10^15 supply) and an inclusive threshold, so the lower-of-two rule is withdrawn (A-M01-02 step 3); the pre/post-trade rule stays. | None. |
| C-11 | M01 | Whether PumpSwap takes its fee from the quote input or adds it on top, and the rounding directions, are not in the register. | VERIFY against `PUMP_SWAP_README.md` with the official SDK as a test oracle; until the 1 bp golden test passes, PumpSwap is not quotable for live use. All rounding is in the direction that tightens our bounds. **Settled 2026-10-07 [VF-04]:** fees are added on top for buys and taken from output for sells; each component is `ceil`ed separately; buy-exact-quote-in uses `q′ − 1` (A-M01-02 step 4). The golden test still gates live use. | None. |
| C-12 | M04 | M04's interface comment says `pool.snapshot` "≤ 1 Hz per pool", while ARCH 8.6 evaluates exits on every snapshot at 2 Hz. | Every snapshot of a position pool is published (2 Hz); candidates ≤ 1 Hz. | M20 handles 2 Hz. |
| C-13 | M01 | Behaviour when a sell's computed output exceeds the real quote vault is UNVERIFIED [EX-V01]. | ~~Sell quotes are clamped to the real vault balance.~~ **Settled 2026-10-07 [VF-05]:** such a sell is refused, not clamped. The quoter returns `E_EXCEEDS_REAL_VAULT` with the largest sellable size, and exits size sells to the real vault so they can land (A-M01-03 edge case 5); `real_vs_effective_quote` rejects such pools for entries. A-M01-03's boundary test uses an SDK-math fixture; the on-chain result is not verified until a recorded failed sell is replayed. | B-M20-04 sizes exit sells to the real vault. |
| C-14 | M24 schema | Group A needs persistence not listed in ARCH 15. | New tables or columns needed: `enumerated_pool` (pool_id, base_mint, is_canonical, first_enumerated_at, last refresh fields), `discovery_cursor` (backfill cursor), `coverage_report` (day, json, low_coverage, manifest sha256), `rpc_usage` (provider, month, units used), `pool.quarantined_at/reason`, `universe_manifest` (day, sha256, path). | M24 adds them to the schema and migrations. **Integration:** adopted in B-M24-02. |
| C-15 | M05/M06 | ARCH requires pool age ≥ 24 h for MR but does not say how age is known for pools found by enumeration. | Age is proven only by a verified migration event time or by the pool's first enumeration time; unknown age fails. Enumerated pools qualify 24 h after first being seen. | None. |
| C-16 | M06 | `mayhem_or_special` must exclude mayhem, holder-rewards and cashback coins, but where those flags live for established pools is unverified (A-12). | Sources: recorded `CreateEvent` flags [DA-12] or an account-level field in the pinned IDL (VERIFY); if undeterminable → `error` → reject. This may shrink the MR universe; A-M13-01 reports how many pools it excludes. | Product owner reviews the impact after Phase 0. |
| C-17 | M07 | ARCH specifies zstd segments and forbids third-party native downloads; Node built-in zstd availability is unverified. | Use built-in zstd if the chosen LTS has it (VERIFY), else built-in gzip with `.ndjson.gz`; every manifest records `codec`. | M30 records the result in `DEPENDENCIES.md`. |
| C-18 | M08 | `dumpFlag()` returns a boolean, so "not enough data" would read as "no dump" (unsafe for PM, where the check is hard). | Added `dumpFlagState(): 'dump' \| 'clear' \| 'insufficient'`; M06 uses it (`insufficient` → `error` for PM, `skipped` for MR). | None. |
| C-19 | M08 | `netQuoteFlowLamports` "from reserve deltas" does not say real or effective reserves. | Real quote vault deltas (actual SOL in or out); virtual changes such as boost are excluded. | None. |
| C-20 | M08/M09 | MR-01's robust z divides an L-period return by the 15 s MAD scale; ARCH does not say whether the scale is time-scaled. | `features.robust_z_scaling` (`sqrt_time` default, or `none`), `affectsReturns`, frozen at pre-registration. | Strategy owner confirms at MR-01 pre-registration. |
| C-21 | M08/M21 | `basketReturn` may be null (too few pools); ARCH's REGIME filter does not say what null means. | M08 returns null below 3 qualifying pools; recommended M21 behaviour: null → regime unknown → block MR entries. | M21 adopts or documents an alternative that does not weaken REGIME. **Integration:** adopted; B-M21-03 already blocks MR on null. |
| C-22 | M09 | MR-01's median target ("reversion to the 6 h rolling median") may be static or re-evaluated; a median at or below the entry price would book a loss as a "target". | Decided in the unblocked MR-01 ticket before pre-registration; defaults: target fixed at entry (`targetPriceSolPerToken`), and skip entries whose median is not above expected entry price plus round-trip cost. | M20 supports a static price target (already in `ExitTrigger`). **Integration:** B-M20-02 supports static price targets (ExitPlan); decided in A-M09-02. **Open point beside it (2026-10-07, C-47):** drops caused by one large sale. |
| C-23 | M10 | The `no_data` rule's "worse of (a) and (b)" reads two ways. | Value = the worse of the lowest-depth exit in the 5 minutes before data stopped and the normal exit on data's return before the time stop; −100% if data never returns before the time stop. | None. |
| C-24 | M10/M21 | M10 owns the gap-through-stop distribution, but no method exposes it, and updating it mid-window would change trial identity. | Added `stressedGapBps(strategyId)`; the empirical p99 (≥ 50 stop exits) is frozen into the parameter set at `replay_passed` from `W_R`; prior 2,000 bps before that. "Gap-through-stop" is read as the realised loss on stop exits. | M21 calls `stressedGapBps` for `MAXRISK`. **Integration:** adopted as binding; CL-38 withdrawn; B-M21-02 changed. |
| C-25 | M10 | ARCH gives a `p_sw` prior for entries only and says it is "replaced by the rate measured". | The same probability is applied to exits (sandwiching can hit sells); calibration uses the upper 95% Wilson bound of the measured rate, not the point estimate. | None. |
| C-26 | M13/M09 | ARCH says `W_B` starts at "the first recorded days" and that gates use only data after `stage_entered_at`; the Phase 0 study uses the first week to decide whether MR-01 is written. | The study is descriptive (unconditional moves only); the configurations of the stage's strategy (PM-01, or a strategy entering through the M09 slot; MR-01 is parked, C-76) are pre-registered (stage `research`) before `W_B` data begins (card Z-H-OF round 2 addendum item 16); the study week is excluded from `W_B`. This delays live-small by about one week. | Integrator confirms the timeline in ARCH 3.4. |
| C-27 | M10 | No prior for the on-chain failure class mix. | Prior mix = 100% `unknown` (most pessimistic: repeated unknowns count toward cannot-sell). | None. |
| C-28 | M10 | `fixedCostBpsPerTrade` returns `Bps` but is undefined at zero trades per day. | Throws `E_INVALID_ARG` for `tradesPerDay ≤ 0` or zero notional. | Callers handle it (M23, M13). |
| C-29 | M11/M12/M19 | `ExecutionPort` has only `submit`/`status`; results and "not landed" events flow through M18's `onResult`/`onNotLanded` in live, and `AttemptRequest` carries no amounts. | Sim and paper ports also expose `onResult` and `onNotLanded`, and read the attempt's `OrderIntent` from M19. | M19 adds both subscriptions to `ExecutionPort` and an `intent(intentId)` read accessor. **Integration:** merged with CL-27; single `ExecutionPort` with `status(): AttemptState`, `onResult`, `onNotLanded` in B-M19-01; `OrderManager.intent` in B-M19-02. |
| C-30 | M11 | Coarse screens have no reserves, so impact cannot be modelled. | Impact is ignored (optimistic), which is the right bias for a kill-only test. | None. |
| C-31 | M11/M13 | `RunBundle` has no place for B-4 per-configuration matrices, R-4 stress results, R-6 crash days or stop-gap samples. | Added a versioned `extensions` object. | M28 VM-21 may display `gate_ids_evaluated` from it. **Integration:** adopted; VM-21 shows `gate_ids_evaluated`. |
| C-32 | M12/M24 | P-6 needs stored shadow simulation results. | New `shadow_result` table (append-only). | M24 adds it. **Integration:** adopted in B-M24-02. |
| C-33 | M13 | `trialKey` includes dataset hashes, so the "frozen trial key" of a stage can never equal the key of a later window's evaluation. | `configKey` (without datasets) identifies a configuration across stages and is frozen; `trialKey` (with datasets) identifies one evaluation. Mismatch checks compare `configKey`. | M26/M28 show `trial_key` of the passing evaluation; VM-18 unchanged. **Integration:** adopted; VM-18 `trial_key` is the passing evaluation's. |
| C-34 | M13 | Stationary-bootstrap block length, the minimum sample for an expectancy CI, and how to treat the paper mean in LS-3 are unspecified. | Block length `max(1, round(n^(1/3)))` with the most conservative of `b/2`, `b`, `2b`; CI only when n ≥ 30; LS-3 non-inferiority bootstraps both live and paper samples. | None. |
| C-35 | M13 | "Flow-adjusted" returns are required but no formula is given; whether sweeps and refills cross the boundary of `E` depends on whether the cold wallet is in `E`. | `r_t = (E_t − CF_t)/E_{t−1} − 1` with `CF_t` = flows crossing the `E` boundary (rules per flow kind in A-M13-04). | M22 exposes whether the cold balance is in `E`; M21 uses the same rule for `DAYLOSS`/`DDKILL`. **Integration (binding):** this formula is the only one (pure `flowAdjustedStep`); B-M21-04 holds the live instance and calls `recordMinute`; CL-35 changed. |
| C-36 | M13 | L-1 is listed under "Live (continuous)". | The CUSUM also runs in live-small (more conservative). | M21/M26 accept demotion from live-small on alarm. **Integration:** adopted; B-M21-04 step 11 subscribes in `live_small` and `live`. |
| C-37 | M07/M13 | Bundle import checks manifests against the host index, but segments are deleted after 30 days. | Segment files are deleted; manifests and day indexes are kept permanently. | None. |
| C-38 | M13/M29 | `botctl import-run` "writes the run ... into `bot.db`", but the engine is the single SQLite writer (ARCH 4.5). | The bundle is handed to the engine (for example through a local admin request) and inserted by M13 in the engine; direct DB writes by `botctl` are only allowed while the engine is stopped. | M29 chooses the delivery mechanism. **Integration:** consistent with CL-62 (spool + engine import job). |
| C-39 | M13 | Several gates (P-5, P-7, P-8, P-9, LS-2, LS-4, LS-5, LS-7) need data owned by group B. | Defined `ExternalGateInputs`; any unavailable input fails its gate with `input_unavailable`. | Group B implements it. **Integration:** implemented by B-M26-04 step 7 (adapter injected at start). |
| C-40 | M13 | "DSR given all trials in the registry" and "B-5 counts every gate trial whose datasets overlap `W_B`" could be per strategy or global. | Count trials across all strategies on overlapping data (stricter). | None. |
| C-41 | M14 | The Jupiter exit budget applies "while any exit attempt is building or in flight", but M14 cannot see M19/M20 state. | Added `beginExitWork(key)` / `endExitWork(key)` with a 120 s safety expiry. | M19/M20 call them around exit attempts. **Integration:** adopted; B-M19-05 calls both. |
| C-42 | M14/M18 | `acquireSend`'s `side` is `'exit' \| 'entry'`, but M18 also sends janitor and sweep transactions with the lowest priority. | `side` extended with `'janitor' \| 'sweep'`. | M18 uses the extended union. **Integration:** adopted; ARCH M14 signature amended (5.0b); `grantId` added. |
| C-43 | M06/M20 | `pre_exit` re-checks authorities only, but cannot-sell detection needs "2 consecutive failed combined sell simulations". | `screen(..., { purpose: 'pre_exit', withSellSim: true })` runs an uncached round-trip simulation without delaying the exit. | M20 requests it after a failed exit attempt. **Integration:** adopted; B-M20-04 requests it. |
| C-44 | M05 | Phase 0 records a universe before M06 exists. | `universe.screening_required = false` labels pools `phase0_unscreened`; validation allows it only while no strategy is enabled; A-24 is reported as an upper bound. | M25 adds the cross-key validation. **Integration:** adopted; B-M25-02 cross-key rule. |
| C-45 | M01 | PDA derivation needs an on-curve check that Node built-ins do not obviously provide. | M01 (engine and sentinel only, not the signer) may use `@solana/kit`'s PDA helper (VERIFY the function in kit 8.x). | M29 confirms the sentinel's dependency set includes kit (ARCH 12.3 already allows it). **Integration:** accepted; VERIFY item stays open (A-M01-01). |
| C-46 | M09/M13, ARCH 3.2, 3.3, A-23, D08 | Addendum A04 (adopted). ARCH said no evidence covered sub-hour horizons; the repo's research now holds a negative sub-hour proxy [RS-01..RS-05]. | ARCH 3.2, 3.3 and A-23 say "negative sub-hour proxy evidence; MR-01's 15 s signal untested". The proxy is not CS-1 (D08): it neither stops MR-01 nor uses up CS-1. No low-volume configuration is pre-registered (6-7 trades a period [RS-04]). MR-01 stays first; M09 waits only for the Phase 0 report: A-24, A-24b and the kill-only check (C-48, A-M13-01 step 9), any of which can stop MR-01. | None. |
| C-47 | M08/M09, beside C-22 | Addendum A04 (adopted). Whether a drop made by one large sale reverts differently from a broad drop is unknown (`docs/research/edge.md:172` @ 72f1793f). | Open point. Measuring it needs trade-level data (D03). Until then no feature, filter or configuration selects on it. | None. |
| C-48 | M13/M09, amends C-26 | Addendum A05 (owner, 2026-10-07: "Do all whats recommended"); supervisor rulings of 2026-10-07 on the map's red-team findings (sizes, filters, matching, anti-peek). C-26 allowed only unconditional moves in the Phase 0 week. | A-M13-01 step 9, rules frozen in `research/phase0/PREREG.md` at R0 (its sha stored in the R0 manifest before the first pull; checked against M07's pull log, never author dates). At the primary configuration the PREREG names and a 1-bar delay: the configuration's own exit path and horizons 5-60 min, at $5, $20, $100, $1,000 and $10,000 (impact on min(real, effective) depth; `k` = 1% cap; depth cap 0.5% of min(real, effective) quote, ARCH `DEPTHPCT`). Tests per cell (25 cells): lean-row net > 0 and excess over matched random entries (C-65) > 0, the lean row deciding (C-77); the strict row and the $10/$12/$59 lines are shown only. A cell passes or fails only with `n_a` ≥ 30 **and** `n_b` ≥ 30 (PREREG §5.5), else `insufficient`, never a kill. A size fails only if the exit path and every horizon fail. MR-01 is killed only when no size passes and one or more fail. Precondition of R0: the PREREG @ `df7d75da` (strict row decides) is amended to the lean row and these rules before R0, or the check refuses to run. Missing Phase 0 filters are caveats. Kill-only; the week stays outside `W_B`. Evidence: the excess alone flatters [RS-02]; the bounce is in the first 5 minutes [RS-03]. | None. |
| C-49 | M11/M12/M13, ARCH 3.4, 16.4 | Addendum A06 (owner items; item 2 owner's choice "both", 2026-10-07); supervisor and red-team rulings of 2026-10-07. The Blueprint's gates did not carry the owner's pre-funding items 1-6, the planted-marker leak test or exact parity. | ARCH 3.4 maps each item to a gate: B-9 (10 identical replays); B-10 (transaction-level replay of ≥ 30 clean history days; **DECIDED** by the owner on 2026-10-08, option (b): a capped 30-day download on the Helius Developer plan, no credit spent before the owner sees the estimate and cap, ≤ 50% of limits, days outside B3 and `W_R` only, no pump.fun host; B-10 fails closed until card Z-H's report exists); R-1 (≥ `n_R` = max(300, `n_80`) trades in the `W_R` holdout, `n_80` from the lower bound of `S_B`'s 95% interval, to the owner above 90 days); P-5 (48 h dry run, ≥ 99% uptime, drills); P-6 (`okShare` ≥ 9,500 bps over every paper leg, a leg without a shadow counted as failed); P-10 (fault injection on the promoted build); plus 16.4 exact parity and the leak test. A-M13-06 evaluates all of them, with `ExternalGateInputs` fields for each. P-1 is not raised (reason in Meme-snipe `docs/DECISIONS.md`). Every change only tightens. | Producers (supervisor ruling, Z0D round 3): B-9 `replayDeterminism` ← A-M11-01's 10-replay run record; B-10 `historyReplay` ← card Z-H's report; P-6 `shadowCoverage` ← A-M12-02 `p6Stats` only; P-5 `dryRun` and P-10 `faultInjection` ← B-M26-04. B-gate inputs are injected in M2 by A-M13-06's bundle-backed implementation (A-M13-08); B-M26-04's M3 adapter wraps it. `historyReplay` and `dryRun` carry `buildSha` and `configKey`; a mismatch fails. A null input fails its gate. |
| C-50 | M10, ARCH 2.3 | Addendum A07 (adopted). The break-even formula ignored trades that go to zero, and only one cost row existed. | ARCH 2.3: `p* = (L + c + q(1 − L))/(W + L)` [RS-07]; a binding conservative cost row from pessimistic Blueprint parameters until each is measured; Zeroed's 414,009 lamports [RS-06] only as a sensitivity line; no entry when the fixed cost exceeds `k`% of the stake, `k` fixed in the PREREG. Ticket work: A-M10-03 (card Z09). | None. |
| C-51 | M13, ARCH 3.2 | Addendum A20 (adopted). Families already tested were not documented. | ARCH 3.2 lists each family with its universe, window and result [RS-24, RS-29..RS-39]; none can pass a gate. | None. |
| C-52 | M03, D12, B-M30-01 | Addendum A02 (adopted, widened); owner, 2026-10-07: PumpPortal not used for now. | D12: chain backfill (A-M03-02) on by default; no request to any pump.fun-operated host (CI check in B-M30-01); A-M03-01 built but not run against PumpPortal; pump.fun data collected before 2026-10-07 serves research only [RS-21]. Terms register: Meme-snipe `docs/DECISIONS.md`. U-A11 stays open on message shapes and the ban signal. | B-M30-01 carries the CI check. |
| C-53 | M07/M30, D07 | Addendum A01 (resolved by the owner, 2026-10-07: "Lets use the 2gb"). | D07: the `vc2-1c-2gb` host, fresh install, old state not reused. A-M07-03's disk budget is sized for 55 GB and the installer checks the real disk. | B-M30-02's preflight (pulled into M0 by Meme-snipe's card Z00). |
| C-54 | M14, D04 | Owner, 2026-10-07: Phase 0 read provider. | D04: Shyft free plan (documented 10 RPC req/s, 0 index req/s, 1 sendTransaction/s [VF-09]); Chainstack Developer as backup at one read every 2 s (documented 5 RPS on Solana mainnet, 3M RU a month [VF-10]; bucket ≤ 2.5 req/s); Helius headroom unused, with **one exception** (owner, 2026-10-08, "B"; Meme-snipe `CLAUDE.md` "History for the past-data test"): B-10's capped 30-day history download (card Z-H) runs on Helius Developer within the estimate and cap the owner has seen. Every bucket at ≤ 50% of the documented limit. **Open owner question** (Meme-snipe `docs/DECISIONS.md` 2026-10-07; `docs/MIGRATION.md` A03 and O7): whether Helius Developer ($49 a month) is the bot's fixed cost. Until the owner rules it counts for P-9 (the stricter reading). | None. |
| C-55 | M29, D27 | Owner, 2026-10-07: consent to D27 (c). | D27: Telegram is the consented third-party channel, codes only (no coin names, amounts or wallet addresses); consent record in Meme-snipe `docs/DECISIONS.md`. | B-M29-03's validator reads that record. |
| C-56 | M13/M26, D08 | Addendum A17 (adopted, changed; values from the owner, 2026-10-07). | D08 (re-keyed, supervisor ruling, card Z-H-OF round 2 addendum item 14, 2026-10-08): If PM-01 fails and no owner-brought slot strategy is in its gates, the stop applies on 31 Dec 2026. Strategies the agents start through the M09 slot stop by 31 Dec either way. PM-01, if still in its gates on 31 Dec, follows the OWNER PENDING clause (round 4 item 34; parked MR-01 counts as failed; the spend cap is what the owner already pays). A strategy the owner brings through the M09 slot may continue after 31 Dec within that same spend (the owner's 8 Oct "Strategy slots" instruction). The owner's stop date and spend cap are not weakened. Acceptance: given PM-01 failed and no other strategy in its gates, then the stop applies on 31 Dec 2026 to agent-started strategy work; given PM-01 failed and an agent-started revised MR version in its gates, then the stop still applies on 31 Dec 2026 (round 3 item 31); given PM-01 still in its gates on 31 Dec 2026, then it follows the OWNER PENDING clause below (it continues only while it costs nothing new) (round 4 item 34); given an owner-brought slot strategy still in its gates, then it continues within the same spend and nothing new is spent. As first written (the trigger is replaced above; the rest stands): if MR-01 and PM-01 both fail, strategy work stops by 31 Dec 2026 with a spend cap of what the owner already pays; the bot then records only and paper-trades no failed rule. **OWNER PENDING** on a strategy still in its gates on 31 Dec: until the owner rules, it continues only while it costs nothing new, and no new strategy work starts after 31 Dec. VM-09 shows hold-SOL and JitoSOL baselines [RS-22, RS-23]. | B-M28-03 projects the baselines into VM-09. |
| C-57 | M11, D08, D17 | Addendum A18 (owner, 2026-10-07: not now). | No early CS-1 on CoinGecko minute bars for now; A-M11-04 stays optional and unrun. | None. |
| C-58 | M03/M14, D30, D04 | Addendum A03 (adopted). | D30's budget comes from the first enumeration count, not A-43's 50,000; vaults read daily on an unmetered provider and every 6 h only near a tier threshold; a burn-rate test fails on the zero-trade pattern [RS-19]. Whether Helius Developer ($49 a month) is the bot's fixed cost is an **open owner question** (Meme-snipe `docs/DECISIONS.md` 2026-10-07; `docs/MIGRATION.md` A03 and O7); until the owner rules it counts for P-9. Ticket work: A-M03-03, A-M14-05 (card Z08). | None. |
| C-59 | M01 | Addendum A08 (adopted). | The creator fee is read per pool from chain at decision time (quote and ≤ 30 bps filter); the CORE-2 goldens are imported under Meme-snipe's migration Rules; reserve timing: PumpSwap events are pre-swap, pump `TradeEvent` post-trade [RS-16]. Ticket work: A-M01-02/03 (card Z07). | None. |
| C-60 | M01/M06, ARCH 8.4 | Addendum A09 (adopted); VERIFY flag 3 (2026-10-07). | ARCH 8.4's guards stay (real/effective ratio ≥ 0.5 MR / 0.6 PM, `DEPTHPCT`, collapse below 0.4). A sell above the real vault is refused by the official SDK, not clamped [VF-05]; the on-chain result is inferred, not verified (C-13 as amended). A drained-pool fixture (17.58 SOL virtual, 0.27 SOL real [RS-17]): entry rejected, collapse exit fires, sell size limited so it can land. Ticket work: A-M01-03 (card Z07), A-M06-04, B-M20-04 step 5 (M2). | B-M20 runs the same fixture and sizes exit sells to the real vault. |
| C-61 | M10/M15 | Addendum A10 (adopted). Slot length is not constant [RS-10]. | One slot-to-time function: live sampling (`slot_ms_initial` stays), per-day block-time anchors in history; the 12-, 20- and 8-slot thresholds are rechecked at 400, 267 and 200 ms. Ticket work: B-M15-01 and A-M10-01 (card Z06). | B-M15-01 owns the function. |
| C-62 | M21 | Addendum A11 (adopted). | Property test: doubling or halving SOL/USD leaves every limit and the SOL P&L unchanged [RS-18]. Live entries and stake are the owner's. | B-M21 (M2). |
| C-63 | M13 | Addendum A12 (adopted). | Exclusions at entry time only; no field observed after the decision (for example `ath_market_cap` [RS-12]); dust and start-missing counts with a −100% line [RS-11]; regime boundaries B2-B4 as breaks [RS-14]; a viewed-window ledger [RS-13]. Ticket work: A-M13-02, A-M13-05 (M2). | None. |
| C-64 | M11 | Addendum A13 (adopted). C-30 makes coarse screens optimistic. | CS-1 still decides on the optimistic line; A-M11-04 adds a realistic line [RS-08]; optimistic pass with realistic kill = "fragile"; an unfinished bar's volume is never known. | None. |
| C-65 | M13 | Addendum A14 (adopted); supervisor ruling of 2026-10-07 on one matching rule. | Intervals: the more conservative of the stationary bootstrap and a calendar-day cluster t-interval, with DEFF [RS-09]. Beside B-2 and R-2, the lower bound of (rule − matched random) above zero. **One matching rule** everywhere (gates and the A-M13-01 kill check): 10 random entries per trade in the same pool, hour and 6 h MAD decile; candidates pass the same entry-time filters as the signals, the depth cap at the trade's size included; a candidate whose holding window overlaps [signal − `L`, signal] is dropped. Ticket work: A-M13-03 (card Z06, with A-M10-01's RNG), A-M13-06 (M2). | None. |
| C-66 | M10 | Addendum A15 (adopted, gated). | The research swap replayer validates M10's fill and stop-gap models; it stays a research tool. Bulk use waits for the owner's credit approval and the Helius §3.2(xi) answer. Its evidence enters the register only after its RESULTS.md and a fresh review. Ticket work: A-M10-05 (M2). | None. |
| C-67 | M13/M01/M02 | Addendum A16 (adopted). | Research PREREG discipline in M13 records; a declared primary for multi-config screens; L-4 gets the B1-B5 boundaries [RS-14, RS-15]; an unknown event length demotes the venue. Ticket work: A-M13-02, A-M01-05, A-M02-05 (M2). | None. |
| C-68 | M11, D08 | Addendum A19 (adopted). | PM-01 is screened only on swap-level or 1 Hz M07 data [RS-24]. | None. |
| C-69 | M10/M11, PM-01 only | Addendum A21 (adopted). | PM-01's `stressedGapBps` prior about 8,270 bps (MR keeps 2,000 until C-24's 50 stop exits); a directional R-4 stress; a jackpot fixture on post-crash reserves; BOOST and mayhem-agent trades out of demand features [RS-25]. The execution-audit figures behind 8,270 enter the register only after that run's RESULTS.md and review. Ticket work: A-M10-04, A-M11-03 (M2). | None. |
| C-70 | M13, VM-09 | Addendum A22 (adopted). | Gate on a mean capped at +19 (20× proceeds); outcome bins, the loss bill, week-clustered intervals; no tail-index fits; the top 1% of trades supplies at most 50% of P&L [RS-26]. Ticket work: A-M13-04 (M2/M3). | B-M28-03 projects the fields into VM-09. |
| C-71 | M21 | Addendum A23 (adopted). | Exposure counts exit costs; pause when the fixed cost exceeds `k`% of the stake; grow only from realised SOL; live values are the owner's [RS-27]. | B-M21 property test (M2). |
| C-72 | Research lane | Addendum A24 (adopted). | Attention signals stay out of entry rules until a forward test passes, in the order funded buyers, caller wallets, first boost, comments [RS-28]. | None. |
| C-73 | M03, D12 | Map round 3 red team R3-10 (2026-10-07). PumpPortal is not used (owner, 2026-10-07), so A-M03-01 sends no notices and A-M03-02's PumpPortal trigger and `gapBps` comparison have no live input. | A-M03-02's `coverage()`/`gapBps` path and its reconnect trigger are tested on recorded fixtures only. The 60 s `getSignaturesForAddress` timer (`discovery.backfill.interval_ms`) is the only live trigger until the owner rules on PumpPortal. The 7-day `gapBps` is reported as not applicable, never as 0, and D12's switch trigger is not evaluated. | None. |
| C-74 | UI-T07, B-M28-01 | Map round 3 red team R3-11 (2026-10-07). UI-T07 (M0) needs VM-03, which B-M28-01 serves. | UI-T07 builds against a VM-03 fixture under INTEGRATION's fixture-first rule (critical-path note after the milestone table; "Remaining issues", dashboard row); its contract test waits for B-M28-01 and must pass against it before UI-T07 counts as done. | B-M28-01 publishes the VM-03 fixture with `@bot/contract`. |
| C-75 | M03/M06/M14, D30 | VERIFY flag 1 (2026-10-07). Neither approved Phase 0 provider can run `getProgramAccounts`: Shyft Free allows 0 index requests a second; Chainstack Developer serves it on paid plans only [VF-09, VF-10]. The same limit hits the holder index calls of A-M06-03 (M2). | **D30 parked and this question withdrawn** (supervisor ruling, card Z-H-OF round 2, 2026-10-08: D30 serves MR's universe, and MR-01 is parked, C-76; A-M03-03 is not built and no Helius job runs). The holder-index limit on A-M06-03 below still stands. Before that: D30 was **OWNER PENDING**, options: (a) a capped Helius job (recommended: about 150-300 credits a month at A-43's assumed 50,000 pools [VF-11], a fix with its own small cap); (b) track only migrations seen since recording began (reduced coverage, in every manifest); (c) a paid plan (new spend). Until the owner rules, A-M03-03 runs (b) and A-M06-03's checks fail closed. | None. |
| C-76 | M09/M13, D08, ARCH 3.2 | Research after A18 (RS-40). A kill-only screen of MR-01's two configurations on 1-minute vendor candles, pre-registered at `5ebb439` (before the owner's A18 ruling of 2026-10-07) and run on 2026-10-08, returned KILLED at $200 (the registered size): −0.77% and −0.76% a trade in validation, 95% CIs below zero; also below zero at $1,000 (−1.49%, an "Other lines" row, not the registered verdict). Trades came from 13 pools in discovery and 15 in validation, out of a candidate set of 25 (`research/mr01-screen/RESULTS.md` @ `c67f37f9`, PR #283). | **Ruled (owner, 2026-10-08 about 7:31 AM: "I see. Sure insert mr 01 as my future strategy"): MR-01 is parked.** MR-01 stops as a current strategy: no plugin build (A-M09-02 stays blocked), no PREREG, no Phase 0 kill check of it, and no trades in any mode. It is kept on file as a future, switched-off candidate; a revised version enters through the M09 strategy slot under a new id or version, pre-registered and tested on data it was not tuned on (D08). ARCH 3.2 and D08 cite it [RS-40]. It is a coarse screen on data without reserves, so it could only stop, never pass (ARCH 3.4). No Phase 0 check of MR-01 runs (A-M13-01 step 9 not run), and no MR-01 trade can happen in any mode. The owner wait in Meme-snipe `docs/MIGRATION.md` is resolved. | None. |
| C-77 | M13, ARCH 3.3, 3.4 | Supervisor ruling, Z0D round 3 (2026-10-08). Stop-only checks and passing gates used different cost rows and monthly costs ($10, $12, $59), and the PREREG disagreed with SPEC-A on the deciding row. | A stop-only check (the A-24b move rule, A-M13-01 step 5, and the A05 kill check, step 9) decides on the **lean** cost row, which is a **lower bound** on costs: it leaves out the sandwich expectation, stuck positions (cannot-sell valued at a total loss) and the overhead of failed sends, all of which ARCH 2.1 says happen (A-M10-03 step 9). The A-24b move rule adds the real monthly cost, $10 (the 2 GB host), converted at the recorded SOL/USD. The A05 kill-check tests are **per trade with no monthly term**; the $10, $12 and $59 lines are shown beside them and decide nothing (supervisor, judgement call (a) confirmed in Z0D round 4). The `k` exclusion in A-M13-01 uses the lean row too. A gate that passes a strategy decides on the conservative row (B-2, R-2; A-M10-03 step 9) and takes the stricter fixed cost while the Helius question is open (D04): $59 a month, for B-2, R-2, P-9, P-2b and LS-3b. The owner rule "No knowingly losing trades" holds because no trade can follow a stop-only check alone: B, R and P decide on the conservative row before any paper or live trade. A check that can only stop must not stop on costs we do not pay; a gate that passes must not pass on costs we might pay. | None. |
| C-78 | M11/M13, M25, ARCH 3.4 B-10, 9.2 | Supervisor ruling, 2026-10-08 (`docs/reviews/ZH.md`, "Supervisor rulings for round 3", item 2, on `claude/supervisor-docs`; Z-H red team R2-04, reviewer N2). `honeypot_sim` and holder state from before the window cannot exist in history, so fail-closed every MR-01 and PM-01 entry in a B-10 replay is refused and B-10 proves nothing (`research/z-h-estimate/RESULTS.md` @ `c74ba7ea` §1, §5). | A B-10 run is `replay` mode with `b10PullId` naming a pinned `B10-PULL` row (C-79 replaced `b10AckId` and the `B10-ACK` row), where every dataset manifest appears in that pull's `unitLog` or card Z-H report, checked by the CLI. In a B-10 run only, the replay input provider returns a typed `replay_unavailable` for those inputs; the research-only key `research.b10.assume_pass_unavailable`, whose one source is `RunSpec`, treats it as "assumed pass, flagged"; config validation refuses the key in paper, live_small and live; every decision taken under it is tagged `replayAssumed`; the key is in `RunSpec` and `trialKey`, not `configKey`; a key-on run is excluded as a whole from every B, R and P statistic except B-10's crash, illegal-state and unreconciled-intent counts, and B-9 is read only from key-off runs (Z0D-2 round 2); the engine code is unchanged (only the input provider and `RunSpec` differ); `fee_config_known` and `venue_enabled` stay fail-closed until card Z-H prep P12. A-M10-05, A-M11-01 step 8, A-M13-06 step 1. | B-M25-02 refuses `research.*` keys in paper, live_small and live (adopted in SPEC-B B-M25-02). **Integration** |
| C-79 | M11/M13/M14, ARCH 3.4 B-10, 9.2, D04 | Owner, 2026-10-08 about 7:25 AM: "Old faithful but by batch to avoid blockage" (Meme-snipe `CLAUDE.md` "History for the past-data test"), replacing the owner's 12:50 AM choice "B" (card Z-H-OF; `research/z-h-estimate/OLD-FAITHFUL.md`). | B-10's history comes from the Old Faithful archive, one UTC day per batch, one batch at a time, at the scanner's caps (10 requests/s, 40 MB/s; Triton documents no limit for `files.old-faithful.net`), with any 429, 403 or 503 stopping the chain for at least 3 h and 3 failures stopping it until re-armed; 0 Helius credits. `historyReplay.source` is `old_faithful_archive`; the report cites a pinned `B10-PULL` row (source, frozen scanner revision, day list) and a per-unit log as coverage evidence; a B-10 run names `b10PullId`. The Helius B-10 machinery (`B10-ACK` rows, `acctCap`, the B-10 window on Helius, P10, P17–P20, the `b10-helius` environment, `botctl b10-reserve`) is not chosen and not built; the Helius account ledger, the caps, the allocations and P21 stay for every Helius consumer. No gate is loosened: B-10 still needs ≥ 30 clean distinct days outside `W_R` and `B3_CONTAMINATED`, from the engine's own key-on run record. A-M11-01 step 8, A-M13-06 step 3, A-M14-05. | Integration: no `ExternalGateInputs` producer changes (card Z-H's report via A-M13-08). **Integration** |

## Unverified items affecting this group

None of these may be filled from memory. Each blocks or constrains the named tickets until it is confirmed from the named official source; until then the tickets fail closed as described.

| ID | Item | Tickets affected | Behaviour until verified | Resolve against |
|---|---|---|---|---|
| U-A01 | Seeds of the pump pool-authority PDA used for the canonical-pool rule [EX-08] | A-M01-01, A-M03-03, A-M06-04 | `isCanonical = null` → pools rejected (C-04) | Pinned `pump.json`/`pump_amm.json` PDA seeds; `PUMP_SWAP_README.md` |
| U-A02 | `@solana/kit` 8.x program-derived-address helper (name, signature) | A-M01-01 | No PDA derivation; CI test fails | `@solana/kit` docs for the pinned version [LD-36] |
| U-A03 | PumpSwap fee placement (input vs on top), rounding, fee-program market-cap input (vault vs effective), threshold inclusivity | A-M01-02, A-M01-03, A-M10-03 | Conservative tier and rounding rules; PumpSwap not quotable for live until the 1 bp golden test passes (C-10, C-11) | `FEE_PROGRAM_README.md`, `PUMP_SWAP_README.md`; SDK as test oracle |
| U-A04 | PumpSwap sells whose computed output exceeds the real quote vault (A-09, [EX-V01]) | A-M01-03, A-M06-04, B-M20-04 | **Settled in the SDK, 2026-10-07 [VF-05]: refused, not clamped** (VERIFY row 9). `quoteExactIn` returns `E_EXCEEDS_REAL_VAULT` with `maxSellableBase`; exits size every sell to it (B-M20-04); `real_vs_effective_quote` gate (C-13). The on-chain result is inferred from the SDK, not verified | Replay of a recorded failed sell; pump docs |
| U-A05 | Whether PumpSwap `BuyEvent`/`SellEvent` carry post-trade pool reserves, and exact field names beyond those in [EX-37] | A-M01-04, A-M02-03 | Orientation check uses the slot-matched modelled-price fallback | Pinned `pump_amm.json` |
| U-A06 | PumpSwap `GlobalConfig.disable_flags` bit layout; README says the field is unused while documenting `disable()` [TH-19, TH-V04] | A-M01-05, A-M06-04 | Only `disable_flags == 0` counts as enabled; anything else → `error` | Pinned IDL and README |
| U-A07 | Pump events emitted by self-CPI (an inference [DA-16]) and/or as `Program data:` logs (excluded claim) | A-M02-03, A-M02-04 | Self-CPI primary; guarded log fallback; truncated logs give no event | Recorded transactions; pump docs |
| U-A08 | SPL Token / Token-2022 base layouts: byte offsets and `COption` encoding | A-M02-02 | Decoder not merged until verified | `solana-program/token` `interface/src/state.rs` [TH-01, TH-03] |
| U-A09 | Full commit SHA of the pinned pump-public-docs IDLs (the register could not confirm it [DA-11]) | A-M02-01 | Vendored files hashed; commit recorded when vendoring | GitHub repository history |
| U-A10 | IDL argument and field names not listed in [EX-10, EX-37] | A-M02-03, A-M02-06 | Use the pinned IDL's spelling; golden tests against the SDKs | Pinned IDLs |
| U-A11 | PumpPortal: whether the free subscriptions need an API key; subscription and notice message shapes; the ban signal [DA-01, DA-02] | A-M03-01 | Client not enabled until verified; backfill covers migrations | pumpportal.fun data API and FAQ pages |
| U-A12 | Provider support for `getProgramAccounts` on PumpSwap, `dataSlice`, response caps; PumpSwap pool account size and quote-mint offset; Helius `getProgramAccountsV2` parameters [DA-21]; real pool count (A-42, A-43) | A-M03-03 | Fallback to migration tracking with reduced coverage | Provider docs; pinned IDL; first enumeration |
| U-A13 | Maximum accounts per `getMultipleAccounts` (100 per a reviewer; provider caps) (A-06) | A-M03-03, A-M04-01 | Batches of ≤ 90 | Solana RPC docs; provider docs |
| U-A14 | DexScreener `chainId` value for Solana and response field names [DA-26]; terms for private storage (A-32) | A-M03-04 | Cross-check disabled until verified; data never redistributed | DexScreener OpenAPI spec and terms |
| U-A15 | `jsonParsed` field names for Token-2022 extensions; deployed RPC version lag [TH-28] | A-M06-02 | Unknown or unparseable → `t22_unparseable` fail | Agave `parse_token_extension.rs`; captured responses |
| U-A16 | Metaplex metadata account derivation [TH-13] | A-M06-02 | SPL Token mints without verifiable metadata → `metadata_matches_mint` `error` | `mpl-token-metadata` source |
| U-A17 | Where mayhem, holder-rewards and cashback flags live for established pools (A-12) | A-M06-02 | Undeterminable → reject (C-16) | Pinned IDLs; pump docs |
| U-A18 | Burn / incinerator addresses to exclude from holder counts | A-M06-03 | No exclusions (concentration over-stated, conservative) | Official program docs for each address |
| U-A19 | PumpSwap LP withdraw denominator | A-M06-04 | Current LP mint supply (largest share, conservative) | Pinned IDL; README; simulated withdraw |
| U-A20 | `simulateTransaction` config field names; whether post-simulation balances already deduct the fee; expected token remainder after the round trip [TH-46] | A-M06-05, A-M12-02 | Fee added to the loss if not deducted; remainder rule tested on recorded simulations | Solana RPC docs; recorded responses |
| U-A21 | RugCheck `insiders/graph` response shape and rate window (A-25, [TH-21, TH-V03]); Jupiter Tokens API v2 path and key requirement [TH-27] | A-M06-06 | Soft checks `skipped` until verified | RugCheck swagger; Jupiter docs |
| U-A22 | Node LTS: built-in zstd in `node:zlib`, Ed25519 in `crypto`, `node:sqlite` features (A-18, A-45) | A-M07-02, A-M07-03, A-M11-05, A-M13-08 | gzip fallback (C-17); no bundle signing without Ed25519 | Node docs for the chosen LTS |
| U-A23 | CoinGecko on-chain OHLCV path, Solana network id, timeframe parameters, Demo history depth, monthly allowance conflict [DA-27, DA-28] | A-M11-04, A-M14-03 | Budget ≤ 2,000 calls/month; coarse screen optional | docs.coingecko.com |
| U-A24 | Birdeye OHLCV V3 on Lite and its CU cost [DA-23, DA-24] | A-M11-04 (optional D17 (e)) | Not used unless verified and purchased | Birdeye docs |
| U-A25 | Exact MinBTL expression (A-44) and DSR formula [ST-29, ST-31]; continuous-time Kelly approximation | A-M13-03, A-M13-02, A-M09-01 | Tests against the register's examples; live sizing returns 0 until verified | The papers' PDFs |
| U-A26 | Helius Sender key placement and whether the global endpoint's 50 req/s is per region (A-40) | A-M14-03, A-M14-04 | Single-region reading (stricter); key never logged | Helius Sender docs |
| U-A27 | Provider billing month boundaries; Shyft Free fair-use limits (A-07) | A-M14-05, A-M14-02 | UTC calendar month; monitor 429s | Provider terms |
| U-A28 | WebSocket `accountSubscribe` method details and per-message metering (A-31, [LD-V01]) | A-M04-03 | Subscription stub refuses to start | Solana WebSocket docs; Helius docs |
| U-A29 | Pool coin-creator field name for `creator_balance` | A-M06-03 | Soft check `skipped` | Pinned `pump_amm.json` |
| U-A30 | ARCH assumptions that drive group A outputs: simulation priors (A-03, A-04), universe size (A-24), move sizes (A-24b), compression ratio (A-48), and the absence of any evidence of an edge (A-23) | A-M10-*, A-M13-01, A-M09-02 | Measured in Phase 0 and live-small; priors are pessimistic | Own measurements |
| U-A31 | Post-BOOST migration dynamics (A-22, [ST-06]) | A-M09-03 | PM-01 stays blocked and paper-only | Own recorded data |
