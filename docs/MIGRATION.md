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

## Rules

Owner, 2026-10-07: "no bugs migrate". These bind every migration ticket.

1. **Nothing is copied in bulk.** A Zeroed module enters the Blueprint build only after this map marks it keep or adapt, and only when all three hold:
   - it passes the Blueprint module's acceptance tests;
   - every known bug that touches it (table below) has a test that fails on the old Zeroed code and passes on the migrated code;
   - a fresh reviewer passes it.
2. **Known bugs are closed or left behind.** A migrated module carries each fix with its fail-before test, or the bug stays behind with the code that does not migrate.
3. **Clean server state.**
   - The host, keys, Tailscale and the deploy gate are reused.
   - The old worker's saved state, ledgers and caches are not reused. The 2 GB host starts from a fresh install.
   - Nothing runs on the server except the stand-in until the Blueprint's paper gates pass. The one exception the owner agreed (Clashes, Process): the Blueprint's keyless recorder once M1 is reviewed, and its paper engine once M3 starts, each through the deploy gate. No Zeroed worker and nothing that trades.
4. **Research upgrades.** The verified addendum `research/BLUEPRINT_ADDENDUM.md` on `ccr-7fae2302-drz4co` is adopted item by item into this map and the tickets, each with its acceptance check. Each rejected item gets its reason in `docs/DECISIONS.md`. Until it lands, the input is `research/SUPERVISOR_MESSAGES.md` on that branch.

### Bugs left behind

| Bug | Evidence | Blueprint modules it touches | Detail in |
|---|---|---|---|
| Restart loop and V8 out-of-memory on the 1 GB host | `HANDOVER.md` "HANDOVER TO THE BLUEPRINT SUPERVISOR" §5.1: 34 unplanned restarts on 6 Oct, nearly all HeapOutOfMemory | M30 and D07 (host size), M07 (recorder memory and disk bounds), M04 (pool state), M24 (state saves), M27 (memory metrics) | Operations |
| Helius credits burned at about 80k an hour with zero trades | §5.2: 305,033 credits in 3 h 31 min on `3ee09a5a` | M14 (A-M14-02 budgets, A-M14-05 credit accounting, burn-rate projection, degraded mode), M04 (polling), M05 (watchlist size) | Known bugs, Data and strategy |
| `SLOT_MS = 400` hard-coded | `packages/worker/src/engine/strategy.ts:1749`, `packages/worker/src/run/config.ts:84`, `packages/worker/src/run/coverage-journal.ts:5`, `packages/backtest/src/sim/world.ts:61`; tests `packages/backtest/test/study-world.ts:21`, `packages/worker/test/read-coherent.test.ts:40`. The owner reports 250 ms slots; the source is checked under Known bugs. | M15 (B-M15-01 slot clock), M10 (latency model), M11 (backtest clock) | Known bugs, Data and strategy |
| H8 counts post-BOOST virtual quote as depth | `packages/core/src/gates/hard.ts:311` adds `virtualQuoteReserves` to the quote vault | M06 (hard filters, ARCH 8.4), M01 (quote model) | Known bugs, Data and strategy |
| Risk limits in micro-USD, not lamports | #197 SOL-BOOKS (open, not merged); risk core in `packages/core/src/risk` | M21, M23 | Known bugs, Money |
| The watchdog cannot sell (no exit takeover) | §5.8: no signer and no key in the watchdog; `/pause` stops entries only | M29 (kill sentinel and standalone exit), D26, D28 | Operations |
| Red team C critical findings | `claude/redteam-c` @ `5fb491f0` `docs/redteam-c/REPORT.md`; fixes #271, #274 and #279 merged into `cd4d7a64` but not deployed; #280 and #281 still open | M14 (reconnect storm, credit counting), M24 (crash-safe state), M30 (rollback and probation) | Operations |
| Fake 17.8% paper edge | `ops/host-config.json` shakedown block `ZEROED_PAPER_EDGE_PPM: "178092"`, used by the S0 diagnostic; #268 resumes the worker with it | M09, M12, M13: an edge comes only from gated evidence, never from config | Known bugs, Data and strategy |
| Holdout contamination | `docs/research/edge.md` §6.5.1 on `ccr-7fae2302-drz4co`: the study behind the H8, H9 and H11 thresholds used data inside the sealed holdout [22 Sep, 20 Oct) | M13 (trial registry and holdout), M06 (thresholds), D17 | Known bugs, Data and strategy |

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

Work built for the Blueprint in `macdarenz-droid/Snipe-solana` before the move. Every card there passed a fresh spec review and a red team. Its `main` is at `74e7258`.

| Card | State there | Blueprint tickets | What it holds |
|---|---|---|---|
| C01 | merged, #1 (`060aca1`) | B-M30-01, B-M19-01 | npm-workspaces monorepo; dependency policy tool (exact pins, `DEPENDENCIES.md` allowlist, 14-day age, no install scripts, import-graph checks); ESLint; `node:test` at 100% coverage; guard and check workflows; `@bot/types` 1.0.0 frozen (tag not pushed: the session's git proxy refuses tag pushes) |
| C11 | merged, #2 (`74e7258`) | C11 (fixtures) | mainnet fixtures for decoder, quote and poller tests |
| C12 | merged, #3 (`a99487d`) | C12 (server install) | install scripts and systemd units for the dedicated `vc2-1c-2gb` host the owner created on 6 Oct (D07 owner decision); preflight refuses below 1.9 GiB RAM or 50 GB free disk |
| C02 | open, #5, waiting for the owner's approval | B-M24-01, B-M24-02, B-M25-01, B-M27-01, B-M28-01 | `node:sqlite` persistence, schema and migrations, config, metrics, `@bot/contract` (zod 4.6.5) |
| C03 | open, #6, waiting for the owner's approval | A-M14-01, A-M14-02, A-M02-01, A-M02-02, A-M02-03, A-M01-01 | provider registry, rate-limited read gateway, pinned IDLs and decoders, PDA helpers (`@solana/kit` 8.3.0); supervisor rulings in that PR's SPEC-A (A-M02-03 direct invoker by `stackHeight`; A-M01-01 async PDA helpers; A-M14-02 byte budget), not yet in `docs/blueprint/SPEC-A.md` |
| C05 | open, #7, waiting for the owner's approval | UI-T01..UI-T06 | dashboard design system (React 19.3, Radix UI, TanStack, Lucide, self-hosted fonts; Playwright, axe-core) |

Decision (supervisor): Snipe-solana stops being a build home. #5, #6 and #7 are not merged there, because nothing there runs on the server. Each card's code is ported into this repo as a ticket of its milestone wherever the module rows above find no better Zeroed code, and its tests are re-run on the ported commit (evidence counts only for the commit it ran on). The Snipe-solana repo stays as a read-only record.

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

| Clash | Blueprint build (Snipe-solana) | This repo | Recommendation |
|---|---|---|---|
| Merge approval | The owner approves each batch; this session's safety check refused approvals the supervisor recorded on its own (AGENTS.md there, 2026-10-07). | The supervisor merges after a fresh review passes and every check is green (AGENTS.md "Supervisor"). | Keep this repo's rule, with the red team added: the supervisor merges after a fresh review, a red team and green checks. If the safety check refuses a merge, the supervisor asks the owner once for that merge. |
| Batch size | At most three cards at a time; no new card until the current ones are reviewed, red-teamed and merged (owner, 2026-10-06). | One fix task at a time, the owner picks (owner, 2026-10-06 about 8:55 PM). | Build cards for new Blueprint modules run in batches of at most three, in separate packages. Fixes to code the server runs stay one at a time. |
| Parallel work | Helpers ran inside the supervisor's chat. | One visible session per task; no hidden agents in the supervisor's chat (owner, 2026-10-03). | This repo's rule; already followed for this map. |
| Server before the paper gates | The Blueprint's M1 exit needs its keyless recorder to run 48 h on the server, and M3's paper gates (P-1 needs at least 21 days of paper) need the paper engine on live data (`docs/blueprint/INTEGRATION.md` milestones). | Owner, 7 Oct: nothing runs on the server except the stand-in until the Blueprint's paper gates pass. | Read as: no Zeroed worker and nothing that trades until the gates allow it. The Blueprint's keyless recorder runs on the server once M1 is reviewed, and the paper engine once M3 starts, each through the deploy gate. **Owner agreed, 7 Oct ("Ok").** |
| Models | Lighter steps on `claude-sonnet-5`. | Lighter steps on `claude-sonnet-5-5` at medium effort (owner, 2026-10-04). | This repo's rule. |

## Ticket order

_Filled by the supervisor._
