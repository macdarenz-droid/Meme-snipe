# Migration map

How Zeroed moves into the Blueprint (owner decision, 2026-10-07; `CLAUDE.md` "Blueprint"). Analysis only: this document moves, deletes or changes no code. No Zeroed code is deleted before this map marks it **replace** and its replacement passes the same tests and replays (`CLAUDE.md` "Paper and backtest removal").

- Zeroed base: `ccr-14987baf-i6lrsl` at `cd4d7a64`.
- Blueprint: `docs/blueprint/` (ARCH, SPEC-A, SPEC-B, UI, INTEGRATION, FACTS), copied from `macdarenz-droid/Snipe-solana` `main` at `74e7258`.

## Verdicts

| Verdict | Meaning |
|---|---|
| keep | Meets the Blueprint spec as it is. The row cites the tests that prove it and the run that passed them. |
| adapt | Worth keeping, with gaps. The row lists each gap against a Blueprint ticket or section. |
| replace | Kept only until its replacement passes the same tests and replays. The row says why. |
| missing | Nothing in Zeroed covers it. |

## Summary

_Filled by the supervisor._

## Group A modules

_Filled by MIGRATION-A._

## Group B modules

_Filled by MIGRATION-B._

## Market and strategy decisions

D01, D03, D04, D08, D12, D13, D14, D17, D18, D29, D30.

_Filled by MIGRATION-A._

## Execution and operations decisions

D02, D05, D06, D07, D09, D10, D11, D15, D16, D19, D20, D21, D22, D23, D24, D25, D26, D27, D28, D31.

_Filled by MIGRATION-B._

## Zeroed assets

### Data and strategy

ENG-1 (#10), DEC-1 (#11), FEED-1 (#21), GATE-1 (#22), BT-1 (#24).

_Filled by MIGRATION-A._

### Money and operations

LEDGER-1 (#9), RISK-1 (#18), TX-1 (#20), EXIT-1 (#33), the ops installer, the update gate, the watchdog.

_Filled by MIGRATION-B._

## Snipe-solana work

_Filled by the supervisor._

## Research carried in

_Filled by MIGRATION-A._

## Known bugs

### Data and strategy

`SLOT_MS = 400`, H8 depth, holdout contamination.

_Filled by MIGRATION-A._

### Money

Risk core in micro-USD (#197).

_Filled by MIGRATION-B._

## Operations

_Filled by MIGRATION-B._

## Clashes for the owner

### Data and strategy

_Filled by MIGRATION-A._

### Money and operations

_Filled by MIGRATION-B._

### Process

_Filled by the supervisor._

## Ticket order

_Filled by the supervisor._
