# Strategy intake

How a strategy from the owner's own research becomes a strategy the bot can switch on. Written for card Z-STRAT (owner, 2026-10-08 about 7:27 AM, `CLAUDE.md` "Strategy slots" on `claude/supervisor-docs`).

Sources, read at `ccr-14987baf-i6lrsl` @ `106d14ec`: `docs/blueprint/SPEC-A.md` A-M09-01 (runtime host), A-M13-02 (pre-registration), A-M13-05 (stages), A-M13-06 (gates), A-M08-02 (features); `docs/blueprint/ARCH.md` 3.4 (gates and windows), 5.0a (`StrategyContext`, `Mode`), M09, 15 (`strategy` table), 16.4 (known-answer tests); `docs/blueprint/SPEC-B.md` B-M21-02, B-M24-02, B-M25-01, B-M25-02, B-M26-02, B-M26-04; `docs/blueprint/UI.md` action classes, S-10, S-13, VM-03 `strategies[]`; `docs/blueprint/INTEGRATION.md`. Owner rules: `CLAUDE.md` "Strategy slots", "MR-01 parked", "No knowingly losing trades", "Discipline, not paralysis", "Size is not the trial", "Profit is counted in SOL", and "No deposit before proof" item 6.

Where the SPEC is silent or unclear, the point is marked **SPEC SILENT** with the safest reading proposed; the list is in "Open points". Nothing here adds a number the sources do not hold.

## 1. Handover

What the owner gives the supervisor when a piece of research looks usable. Plain words are enough; the agents turn it into the exact form.

**The rules**
- Which coins or pools it looks at (for example: fee tier, pool depth, pool age, how long after launch).
- When it buys: the exact signal, written so two people would pick the same moments.
- How it sells: stop loss, target, trailing stop, time limit.
- How much it buys per trade, or the rule for it.
- Anything it must never do (for example: never in the first hour after launch).

**The evidence**
- What data the idea came from: which days, which coins, which source.
- What results were seen: number of trades, average result per trade after costs, in SOL if possible.
- What was tried and dropped while finding it (every version tested counts; see section 2).

**What the bot can see.** A strategy sees only what the bot records: 15-second price bars per pool (open, high, low, close in SOL, pool depth, depth change, net buy or sell flow; ARCH M08 `Bar`) and the feature list in A-M08-02 (robust z-score, rolling median, MAD scale, dump flag, basket return), plus its own open position. A rule that needs something else (holder counts, wallets, social data, another venue) needs a new features ticket first. That is a new task, so it goes to the owner for approval (`CLAUDE.md` "Focused queue") before the strategy can be built.

**The data the idea came from cannot prove it.** A strategy is tested on data it was not tuned on (`CLAUDE.md` "MR-01 parked"; ARCH D08: no further search on the same data). The owner's own data shapes the rules; the gates run on days recorded after the rules are fixed (section 5).

## 2. Pre-registration

Turning the handover into a pre-registration (PREREG): the rules written down and pushed before any test data is seen. This is owner item 6 ("rules fixed in advance") and SPEC-A A-M13-02.

**Document.** One file per strategy version, `research/<id>/PREREG.md` (PROPOSED path; the on-hold Phase 0 file `research/phase0/PREREG.md` on `claude/research-phase0-prereg` @ `df7d75da` is the format example). Discipline from MIGRATION A16: pushed before the data exists and checked with `git ls-remote`; a stated data wall; stress costs; seeds; a random-entry benchmark; a realistic cost line; amendments only before the first run; a fresh reviewer.

**What it fixes**

| Item | What is written | Source |
|---|---|---|
| Identity | `strategyId`, `strategyVersion`, `params` (numbers and strings only) | A-M09-01 `Strategy` |
| Universe | `feeCeilingBps`, `minDepthLamports`, `minAgeMs` | A-M09-01 `register(…, meta.universe)` |
| Entry rule | The exact signal on complete 15 s bars and A-M08-02 features | A-M09-01 step 3; A-M08-02 |
| Exit plan | `stopBps` (negative), `targetBps`, `trailingBps`, `targetPriceSolPerToken`, `timeStopMs` (> 0), `maxExitSlippageBps`; the universal exits of ARCH 8.6 apply on top | A-M09-01 `ExitPlan`, step 4 |
| Size | The `sizing` rule; the risk engine (M21) caps it. Live sizing uses `kellyFractionLowerBound`, which is 0 without an edge estimate | A-M09-01 step 6; ARCH 3.5, D21 |
| Configurations | The full set to test. The budget is set by MinBTL: 2 configurations on a 30-day `W_B` at an assumed best annualised Sharpe of 2; a third is refused (`E_BUDGET`) | A-M13-02 step 4; ARCH 3.4 table |
| Settings that change results | Every config key with `affectsReturns = true` is part of `configKey`; a later change is a new trial | A-M13-02 steps 1–3; B-M25-01 step 2 |
| Costs | In SOL (lamports). Pass decisions use the conservative cost row with the stricter fixed cost ($59 a month while D04 is open) | ARCH 3.4 "Cost row" (C-77); `CLAUDE.md` "Profit is counted in SOL" |
| Sizes | Results shown at $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and price impact apart | `CLAUDE.md` "Size is not the trial"; MIGRATION Z09 |
| Holdout | `W_R` (≥ 14 days after `W_B`) is the untouched holdout; B-8 also needs the last 20% of `W_B` positive | ARCH 3.4 R-1, B-8; owner item 6 |
| Kill rules | The gate failures of section 7, written out, plus any stricter stop the owner wants | A-M13-05 step 3 |

**Registration.** `TrialIdentity.preRegister({ strategyId, strategyVersion, configs, config, costModelVersion, fillModelVersion, atMs })` records the set and returns the `configKeys` (A-M13-02). The strategy's stage becomes `research` (A-M13-05 step 1). `W_B` begins only after this (C-26).

**Optional early stop.** A coarse screen on vendor price bars (gate CS-1) can stop a strategy whose every configuration loses with a 95% CI upper bound below zero. It can never pass one (ARCH 3.4 "Coarse screens can only kill").

## 3. Plugin contract

What a strategy plugin is, from SPEC-A A-M09-01 and ARCH M09 and 5.0a.

**Shape**

```ts
interface Strategy { id: string; version: string; params: Readonly<Record<string, number | string>>;
  onBar(ctx: StrategyContext, bar: Bar): SignalProposal[]; sizing(ctx: StrategyContext, p: SignalProposal): Lamports }
```

**May read** only its arguments: `ctx.clock`, `ctx.rng` (seeded per run), `ctx.mode`, `ctx.runId`, `ctx.config` (a frozen snapshot), `ctx.features` (behind a recording proxy), `ctx.position(poolId)`, `ctx.edgeEstimate` (null outside live modes), and the `Bar` (ARCH 5.0a `StrategyContext`; A-M09-01 step 2). Imports: only `@bot/types` and the features API (A-M09-01 security notes).

**Must return** zero or more `SignalProposal`s with `side = 'buy'`, the bar's own `poolId` and `mint`, `exitPlan.stopBps < 0`, `timeStopMs > 0`, at most one per pool per bar (A-M09-01 step 4). The host fills `candidateId`, `decisionSlot`, `decisionMs`, `featuresHash` and `requestedNotionalLamports`; an invalid proposal is dropped and counted (`proposal_dropped_total{reason}`).

**Identity.** `paramsHash = sha256(canonical JSON of params)`. Registering the same `(id, version)` with other params is refused with `E_PARAMS_CHANGED`: any change is a new version and new trials (A-M09-01 step 1; ARCH 3.4). Stored in the `strategy` table (`strategy_id` + `version`, `params_hash`, `enabled_modes`; ARCH 15).

**Must never**
- send anything, read keys or touch the wallet: plugins only propose; M21 decides, M20 owns positions, the signer is a separate process;
- do I/O, read `Date` or call `Math.random` (lint rule, A-M09-01 security notes);
- look ahead: only complete bars reach entries (step 3), the features proxy records every call, and the leak and lookahead tests catch future reads (ARCH 16.4);
- mutate its inputs (frozen; a mutation counts as a throw, edge case 2);
- throw: a throw disables the strategy for the run with a critical alert; open positions keep their exit plans (step 7).

**Switch.** `strategy.<id>.enabled_modes` (a list of `Mode`: `backtest`, `replay`, `paper`, `live_small`, `live`); `strategy.<id>.params.*` (`affectsReturns` yes) (A-M09-01 config). The host also checks the stage against the mode (step 5): paper runs any enabled strategy, live-small needs stage `live_small` or `live`, live needs `live`, backtest and replay run only the strategy under test. M26 is authoritative; this check is defence in depth.

## 4. Template plugin

A known-answer example that every new strategy is copied from, and that the tests use to prove the host works. Two templates, both from ARCH 16.4 and A-M09-01 "Tests":

| Template | What it does | Known answer the tests check |
|---|---|---|
| `random-buy` | On each complete bar of an in-universe pool, buys when `ctx.rng` draws below a fixed probability in `params`; fixed exit plan and size | Same bars and seed twice → byte-identical proposals and `featuresHash`; over enough trades the after-cost mean per trade is negative, about −`g*` (ARCH 16.4) |
| `lookahead-cheat` | Reads one bar ahead (test only) | Detected by the no-lookahead test (ARCH 16.4); never registered outside tests |

A small hand-computed fixture pins the exact answer: for a fixed seed and a short bar series, the test lists the bars where `random-buy` proposes and the full `SignalProposal` of each (PROPOSED: a fixture of 20 bars in the test file, hand-checked; the SPEC fixes no size).

**The template is a losing strategy by design.** Under "No knowingly losing trades" it may run in `backtest` and `replay` only. Config validation refuses `paper`, `live_small` and `live` in its `enabled_modes`, the same way A-M09-03 forbids live modes for PM-01 (**SPEC SILENT** on the template's modes; this is the safest reading).

## 5. Gates

In order. Every gate is evaluated by M13 (A-M13-06) and enforced by M26; windows are self-recorded, disjoint and in time order; a gate counts only data after the stage's `stage_entered_at` that no earlier gate used (A-M13-05 step 5). All numbers below are ARCH 3.4's.

1. **Gate B (backtest), on `W_B`: ≥ 30 days** of bars recorded after the PREREG (plan for up to about 65 days at a few trades a day). B-1 ≥ 300 closed trades; B-2 net mean per trade > 0 with bootstrap 95% CI lower bound > 0, on the conservative cost row; B-3 Deflated Sharpe ≥ 0.95; B-4 rank stability (≤ 3 trials) or PBO ≤ 0.05; B-5 trials within the MinBTL budget; B-6 t ≥ 3.0; B-7 max drawdown ≤ 20% of `E`; B-8 positive in the final 20% and in each calendar week; B-9 10 replays byte-identical (owner item 1); B-10 transaction-level history replay with zero crashes, illegal states or unreconciled intents (owner item 2; can fail the stage, never pass it alone). One configuration is selected here. Pass → `backtest_passed`.
2. **Gate R (replay), on `W_R`: ≥ 14 days** after `W_B`, the selected configuration only, frozen before `W_R` starts. R-1 ≥ max(300, `n_80`) trades (80% power from the lower bound of `W_B`'s Sharpe interval; above 90 days goes to the owner); R-2 CI lower bound > 0; R-3 mean ≥ 50% of `W_B`'s; R-4 still > 0 with doubled latency and doubled sandwich probability; R-5 drawdown ≤ 15% of `E`; R-6 crash-day review. This is owner item 6's untouched holdout. Pass → `replay_passed`.
3. **Gate P (paper), on `W_P`: ≥ 21 days** after `replay_passed`. P-1 trade count (≥ max(MinTRL, 100)); P-2 CI lower bound > 0; P-2b fixed cost covered; P-3 not below the replay CI lower bound; P-4 drawdown ≤ 10% of `E`; P-5 data and uptime, with the 48 h dry run (owner item 3); P-6 shadow simulation, `okShare` ≥ 95% (owner item 4); P-9 fixed cost ≤ 3% of `E`; P-10 fault injection (owner item 5). Pass → `paper_passed`. P-7 (kill drill) and P-8 (checklist, phrase, step-up, delay) are checked at the promotion command.

The earliest live-small date is at least about 65 days after recording starts (ARCH 3.4).

## 6. Switch

**Paper first.** A strategy can be switched on in paper once its PREREG is registered (`CLAUDE.md` "Strategy slots"). Paper trades before `replay_passed` are labelled `shadow` and count for no gate (ARCH 3.4). The switch is a config change of `strategy.<id>.enabled_modes` on S-10, applied through M25 and M26.

**Action class of the switch** (UI action classes; B-M25-02 step 2; B-M26-02 step 1):

| Change | Class | Friction |
|---|---|---|
| Switch off in any mode | A1 ("disable a strategy") | One confirmation, immediate |
| Switch on in paper | A2 (**SPEC SILENT**; proposed as a neutral change) | Confirmation, reason ≥ 10 characters, step-up within 5 min |
| Switch on in `live_small` or `live` | A3 ("enable a strategy in a live mode") | Server readiness gates, typed phrase, fresh step-up ≤ 60 s, reason, **60-second cancellable delay**, audit |

**Live only after the gates.** Live needs all of: the strategy's stage `paper_passed` or later (B-M21-02 step 1; B-M26-04 step 2), the system promoted to live-small by the A3 `set_mode` flow with P-1..P-9 passing and no cooldown, the signer's own `max_mode` raised on the host, and at most 1 strategy live at once (ARCH 8.1 "Strategies live at once", short code `MAXSTRAT`, CL-64; B-M26-04 step 2). A3 actions are not offered on the phone view and the server refuses them from mobile sessions (UI D-UI-11). Raising money from paper to live stays the owner's alone (AGENTS.md "Only the owner").

**Several strategies.** In paper, strategy 1 and strategy 2 can both be on. In live, one at a time (`MAXSTRAT`).

## 7. Failure

- **Gate fails with enough data** (every count and duration met, a statistical gate fails) → stage `failed`. The strategy stops; no further search on the same data (A-M13-05 step 3; D08). It is switched off in every mode, and it is not paper-traded (`CLAUDE.md` "No knowingly losing trades").
- **Not enough data yet** → stays, `pending_data`. Never a pass (A-M13-06). If its limits block every coin for hours, that is a defect to measure ("Discipline, not paralysis"), never a reason to loosen a gate.
- **A revised idea** → a new version or id, a new PREREG, new days. The failed version keeps its record (as MR-01 does, C-76).
- **Coded error** → a throw disables it for the run, with a critical alert; open positions keep their exits (A-M09-01 step 7).
- **After going live** → L-1 to L-4 demote it to paper automatically (A1), with a 7-day cooldown before a fresh `W_P` (A-M13-05 step 4).
- **End date.** A strategy the owner brings through the slot may continue after 31 Dec 2026 within what the owner already pays; strategies the agents start stop by 31 Dec (supervisor ruling, card Z-H-OF round 2 item 14; ARCH D08; open for the owner to overrule).

## 8. Owner checklist

1. Write your rules in plain words: which coins, when to buy, when to sell, how much.
2. Say which data you used and what results you saw.
3. List every version you tried, kept or dropped.
4. Send it to the supervisor. Agents write the PREREG; you read it and say yes.
5. The PREREG is pushed before any test day is recorded. Nothing in it changes after that.
6. Agents build the plugin from the template. A reviewer checks it matches your rules.
7. Switch it on in paper (S-10). Those trades are practice only and prove nothing yet.
8. Wait for gate B (at least 30 days), then R (at least 14 days), then P (at least 21 days).
9. If any gate fails, the strategy stops. Bring a new version, not a tweak of this one.
10. If all pass, live is your choice, on the desktop dashboard: type the phrase, sign in fresh, wait 60 seconds. You can cancel in that minute.

## Card Z-STRAT

### Scope

A-M09-01 runtime host; the two template plugins of section 4; this document. Not in scope: A-M13-02, A-M13-05, A-M13-06 (built in M2 per INTEGRATION); the S-10 and S-13 screens (UI tickets); any real strategy.

### Dependencies

| Need | From | Until it exists |
|---|---|---|
| `Config`, `ConfigFieldSchema` with `affectsReturns`, the frozen config snapshot; schema entries for `strategy.<id>.enabled_modes`, `strategy.<id>.params.*`, `strategy.runtime.onbar_warn_ms` | Z02, B-M25-01 | Blocking. The host reads config only through the B-M25-01 `Config` type |
| Validation of `enabled_modes` (template live/paper refusal; action class of list changes) | Z02 or M3, B-M25-02 (Phase 2 in SPEC-B) | Z-STRAT ships the rule as a pure validator with tests; wiring into B-M25-02 waits for that ticket (**SPEC SILENT** on which ticket owns it; proposed: B-M25-02 cross-key rules) |
| `strategy` table (`strategy_id` + `version`, `params_hash`, `enabled_modes`) | Z02, B-M24-02 | Blocking for persistence; the registry can be tested in memory first |
| `Features` (A-M08-02) | Z09 | A fake that implements the A-M08-02 `Features` type exactly (all six methods, including `dumpFlagState`), so swapping in the real one is type-checked |
| `Bar`, `isComplete` (A-M08-01) | Z09 | Fixture bars of the ARCH 5.0a `Bar` type |
| `position(poolId)` (M20), `candidate(poolId)` (M05), stage (A-M13-05), edge estimate (A-M13-04), `signal` stream (M07), critical alert | M2 tickets | Fakes behind their published types |
| `canonicalJson()` | Z01, B-M19-01 (`@bot/types` `canon.ts`, merged #287) | Available |
| Lint and dependency policy | Z01, B-M30-01 | Available; add the plugin import rule |

### Acceptance criteria

| # | Criterion | SPEC ticket |
|---|---|---|
| AC-1 | A plugin that throws on its 3rd bar is disabled, a critical alert is raised, and no proposal from it appears afterwards; its open positions keep their exit plans | A-M09-01 AC 1, step 7 |
| AC-2 | An incomplete bar gives no proposal | A-M09-01 AC 2, step 3 |
| AC-3 | The same bars and seed twice give byte-identical proposals, `featuresHash` included | A-M09-01 AC 3; owner item 1 |
| AC-4 | Stage `paper_passed` in mode `live_small` gives no proposal; paper runs any enabled strategy; backtest and replay run only the strategy under test | A-M09-01 AC 4, step 5 |
| AC-5 | Same `(id, version)` with other params → `E_PARAMS_CHANGED`; `paramsHash` = sha256 of canonical JSON, stable under key order | A-M09-01 step 1 |
| AC-6 | A proposal for another pool → dropped `E_POOL_MISMATCH`, counted; `side`, `stopBps < 0`, `timeStopMs > 0` and one-per-pool-per-bar enforced with a drop reason | A-M09-01 step 4, edge case 1 |
| AC-7 | A plugin that mutates its context is treated as a throw | A-M09-01 edge case 2 |
| AC-8 | Ten slow calls (over `onbar_warn_ms`) in 1 h → warning alert, not disabled | A-M09-01 edge case 3 |
| AC-9 | `kellyFractionLowerBound` returns 0 when either input is null or the lower bound ≤ 0 | A-M09-01 step 6 |
| AC-10 | `status()` gives VM-03 `strategies[]` fields (`strategyId`, `version`, `paramsHash`, `enabled`, `disabledReason`, `modes`) through M28's projection test double | A-M09-01 DoD; UI VM-03 |
| AC-11 | `random-buy` passes the hand-computed fixture and shows a negative after-cost mean per trade on a fixture day; `lookahead-cheat` is caught by the no-lookahead test | A-M09-01 tests; ARCH 16.4 |
| AC-12 | A plugin importing anything but `@bot/types` and the features API, or using `Date` or `Math.random`, fails lint | A-M09-01 security notes; B-M30-01 |
| AC-13 | The template's `enabled_modes` containing `paper`, `live_small` or `live` fails validation | PROPOSED (section 4; mirrors A-M09-03) |
| AC-14 | `enabled_modes` containing `paper` for an `(id, version, paramsHash)` with no PREREG registration fails validation | PROPOSED (open point 1) |
| AC-15 | Adding `live_small` or `live` to `enabled_modes` derives A3; removing any mode derives A1; adding `paper` derives A2 | UI action classes; PROPOSED for paper and for list semantics (open point 2) |

### Tests

| Test | Covers |
|---|---|
| Unit: throwing fake plugin | AC-1 |
| Unit: incomplete bar | AC-2 |
| Determinism: two runs, byte compare of proposals | AC-3 |
| Unit table: mode × stage → emit or not | AC-4 |
| Unit and property: registry identity, key-order permutation | AC-5 |
| Unit: each invalid proposal shape → its drop reason and counter | AC-6 |
| Unit: frozen-context mutation | AC-7 |
| Unit with a fake clock: slow-call warning | AC-8 |
| Unit: Kelly helper inputs (null, ≤ 0, positive) | AC-9 |
| Contract: `status()` against the M28 projection double | AC-10 |
| Known-answer: `random-buy` fixture and fixture day; `lookahead-cheat` | AC-11 |
| Lint fixture: a bad plugin file must fail the lint run | AC-12 |
| Validator unit: template modes; PREREG presence; action class per list change | AC-13 to AC-15 |
| Metrics: `signals_total{strategy}`, `proposal_dropped_total{reason}`, `strategy_onbar_ms{strategy}`; log `M09.strategy_disabled` | A-M09-01 observability |

Every bug-fix test must fail before and pass after (AGENTS.md "Builders"). MIGRATION row A-M09-01 marks `core/src/engine/engine.ts:17-40` and `core/test/purity.test.ts` as adapt; under "No bugs migrate" the B1 and B5 probes named there must be tests in Z-STRAT.

## Open points

1. **Paper switch before PREREG (SPEC SILENT).** A-M09-01 step 5 lets paper run any enabled strategy; the owner's rule needs the rules written down first. Proposed: validation refuses `paper` unless a PREREG registration exists for that `(id, version, paramsHash)` (AC-14). Needs a lookup into A-M13-02 from M25 validation.
2. **Action class of a list key (SPEC SILENT).** B-M25-02 derives direction from `riskDirectionOnIncrease`, which fits numbers, not a list of modes. Proposed: adding `live_small` or `live` → A3 (UI lists "enable a strategy in a live mode" as A3); removing → A1 (UI "disable a strategy"); adding `paper` → A2 (not listed in UI; neutral is the safer reading than A1).
3. **Code change without a version change (SPEC SILENT).** `E_PARAMS_CHANGED` catches new params under the same version, not new code. Proposed: a CI check that pins each `id@version` to a hash of its plugin source, so a logic change without a new version fails CI.
4. **Template modes (SPEC SILENT).** Proposed: `backtest` and `replay` only (AC-13).
5. **Owner's evidence and the windows.** Gate B uses only days recorded after the PREREG (C-26). The owner's research data may serve a CS-1 kill-only screen, never a pass. Confirmed reading, no change proposed.
6. **Inputs beyond bars and A-M08-02 features.** Any such input is a new features ticket and a new task under "Focused queue". Not part of Z-STRAT.
7. **Two strategies on one coin in paper.** The open-buy index allows one open buy per mint (SPEC-B B-M24-02 PERTOKEN). SPEC does not say which strategy wins when both propose the same pool in the same bar. Proposed: the risk engine (M21) rejects the second with its normal per-token reason; Z-STRAT adds nothing.
8. **Owner-strategy end date.** Rests on a supervisor ruling (card Z-H-OF item 14) listed for the owner to overrule.
