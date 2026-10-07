# Strategy intake

How a strategy from the owner's own research becomes a strategy the bot can switch on. Written for card Z-STRAT (owner, 2026-10-08 about 7:27 AM, `CLAUDE.md` "Strategy slots" on `claude/supervisor-docs`).

Sources, read at `ccr-14987baf-i6lrsl` @ `106d14ec`: `docs/blueprint/SPEC-A.md` A-M09-01 (runtime host), A-M13-02 (pre-registration), A-M13-05 (stages), A-M13-06 (gates), A-M08-02 (features); `docs/blueprint/ARCH.md` 3.4 (gates and windows), 5.0a (`StrategyContext`, `Mode`), M09, 15 (`strategy` table), 16.4 (known-answer tests); `docs/blueprint/SPEC-B.md` B-M21-02, B-M24-02, B-M25-01, B-M25-02, B-M26-02, B-M26-04; `docs/blueprint/UI.md` action classes, S-10, S-13, VM-03 `strategies[]`; `docs/blueprint/INTEGRATION.md`. Owner rules: `CLAUDE.md` "Strategy slots", "MR-01 parked", "No knowingly losing trades", "Discipline, not paralysis", "Size is not the trial", "Profit is counted in SOL", and "No deposit before proof" item 6.

Where the SPEC is silent or unclear, the point is marked **SPEC SILENT** with the safest reading; the supervisor's rulings on those points are in "Rulings", and the points still open are in "Open points". Nothing here adds a number the sources do not hold.

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
- What results were seen: number of trades, average result per trade after costs, in SOL if possible. The average after costs must be above zero; a reviewer refuses a PREREG whose own evidence shows a loss ("No knowingly losing trades"; round 2 ruling 13).
- What was tried and dropped while finding it (every version tested counts; see section 2).

**What the bot can see.** A strategy sees only what the bot records: 15-second price bars per pool (open, high, low, close in SOL, pool depth, depth change, net buy or sell flow; ARCH M08 `Bar`) and the feature list in A-M08-02 (robust z-score, rolling median, MAD scale, dump flag, basket return), plus its own open position. A rule that needs something else (holder counts, wallets, social data, another venue) needs a new features ticket first. That is a new task: the supervisor puts a features card to the owner for approval (`CLAUDE.md` "Focused queue"; ruling 7) before the strategy can be built.

**Who started it.** Every PREREG and strategy row carries `origin`: `owner` or `agent` (round 2 ruling 9). `owner` is set only with a cited owner message, and the reviewer checks the citation. Starting an `agent` strategy is a new task that needs the owner's OK (`CLAUDE.md` "Focused queue"). An `agent` strategy stops at 2026-12-31T23:59:59 Australia/Melbourne: the host emits nothing after that moment and the validator refuses switching it on (ARCH D08, C-56 as re-keyed by card Z-H-OF item 14).

**The data the idea came from cannot prove it.** A strategy is tested on data it was not tuned on (`CLAUDE.md` "MR-01 parked"; ARCH D08: no further search on the same data). The owner's own data shapes the rules; the gates run on days recorded after the rules are fixed (section 5).

## 2. Pre-registration

Turning the handover into a pre-registration (PREREG): the rules written down and pushed before any test data is seen. This is owner item 6 ("rules fixed in advance") and SPEC-A A-M13-02.

**Document.** One file per strategy version, `research/<id>/PREREG.md` (PROPOSED path; the on-hold Phase 0 file `research/phase0/PREREG.md` on `claude/research-phase0-prereg` @ `df7d75da` is the format example). Discipline from MIGRATION A16: pushed before the data exists and checked with `git ls-remote`; a stated data wall; stress costs; seeds; a random-entry benchmark; a realistic cost line; amendments only before the first run; a fresh reviewer.

**What it fixes**

| Item | What is written | Source |
|---|---|---|
| Identity | `strategyId`, `strategyVersion`, `params` (numbers and strings only), `origin` (`owner` with the cited owner message, or `agent`) | A-M09-01 `Strategy`; round 2 ruling 9 |
| Universe | `feeCeilingBps`, `minDepthLamports`, `minAgeMs` | A-M09-01 `register(…, meta.universe)` |
| Entry rule | The exact signal on complete 15 s bars and A-M08-02 features | A-M09-01 step 3; A-M08-02 |
| Exit plan | `stopBps` (negative), `targetBps`, `trailingBps`, `targetPriceSolPerToken`, `timeStopMs` (> 0), `maxExitSlippageBps`; the universal exits of ARCH 8.6 apply on top | A-M09-01 `ExitPlan`, step 4 |
| Size | The `sizing` rule; the risk engine (M21) caps it. Live sizing uses `kellyFractionLowerBound`, which is 0 without an edge estimate | A-M09-01 step 6; ARCH 3.5, D21 |
| Configurations | The full set to test. The budget is set by MinBTL: 2 configurations on a 30-day `W_B` at an assumed best annualised Sharpe of 2; a third is refused (`E_BUDGET`) | A-M13-02 step 4; ARCH 3.4 table |
| Settings that change results | Every config key with `affectsReturns = true` is part of `configKey`; a later change is a new trial. `configKey` also hashes the features implementation (the features package and the host and shared helpers a plugin calls): a change in the middle of a window resets that window through `E_TRIAL_MISMATCH`, and the reset is recorded | A-M13-02 steps 1–3, 6; B-M25-01 step 2; round 2 ruling 5 (an amendment to A-M13-02 step 2) |
| Costs | In SOL (lamports). Pass decisions use the conservative cost row with the stricter fixed cost ($59 a month while D04 is open) | ARCH 3.4 "Cost row" (C-77); `CLAUDE.md` "Profit is counted in SOL" |
| Sizes | Results shown at $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and price impact apart | `CLAUDE.md` "Size is not the trial"; MIGRATION Z09 |
| Selected configuration | From `backtest_passed` on, only the configuration selected at gate B (its frozen `configKey`) may run in paper and live | A-M13-05 step 1; round 2 ruling 11 |
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

**May read** only its arguments: `ctx.clock`, `ctx.rng` (seeded per run), `ctx.mode`, `ctx.runId`, `ctx.config` (a frozen snapshot), `ctx.features` (behind a recording proxy), `ctx.position(poolId)`, `ctx.edgeEstimate` (outside live modes the object `{ lowerCiNetBps: null, varianceBps2: null }`), and the `Bar` (ARCH 5.0a `StrategyContext`; A-M09-01 step 2). Imports: only `@bot/types` and the features API (A-M09-01 security notes).

**Must return** zero or more `SignalProposal`s with `side = 'buy'`, the bar's own `poolId` and `mint`, `exitPlan.stopBps < 0`, `timeStopMs > 0`, at most one per pool per bar (A-M09-01 step 4). The host fills `candidateId`, `decisionSlot`, `decisionMs`, `featuresHash` and `requestedNotionalLamports`; an invalid proposal is dropped and counted (`proposal_dropped_total{reason}`).

**Identity.** `paramsHash = sha256(canonical JSON of params)`. Registering the same `(id, version)` with other params is refused with `E_PARAMS_CHANGED`: any change is a new version and new trials (A-M09-01 step 1; ARCH 3.4). Params belong to the version: the validator refuses any change to `strategy.<id>.params.*` of a registered version (`E_PARAMS_CHANGED` at validate time), and the host re-checks `paramsHash` against the registry on every config swap and disables the strategy on a mismatch (round 2 ruling 3). Config is authoritative; the `strategy` table (`strategy_id` + `version`, `params_hash`, `enabled_modes`; ARCH 15) is a projection rebuilt from config at start (round 2 ruling 10).

**Code pin.** An append-only pin file maps each `id@version` to a hash of its plugin source. CI fails a plugin change under an unchanged pin, and compares the file with the base branch: an existing entry may never change or disappear (round 1 ruling 3; round 2 ruling 4). PROPOSED path: `packages/strategies/PINS.json`.

**Fresh instance.** The host builds a fresh plugin instance for every run, so no plugin state carries from one run to the next (round 2 ruling 13).

**Must never**
- send anything, read keys or touch the wallet: plugins only propose; M21 decides, M20 owns positions, the signer is a separate process;
- do I/O, read `Date` or call `Math.random` (lint rule, A-M09-01 security notes). The lint is an allow-list: it bans `fetch`, `process` (and so `process.env`), `globalThis`, `eval`, `new Function`, `require`, dynamic `import()`, computed access to `globalThis`, `setTimeout`, `performance.now()`, `WebSocket` and `crypto`, with one failing fixture per name (round 2 ruling 6; the names are the red team's list). A `vm` context is optional and is not a security boundary;
- look ahead: only complete bars reach entries (step 3), the features proxy records every call, and the leak and lookahead tests catch future reads (ARCH 16.4);
- mutate its inputs (frozen; a mutation counts as a throw, edge case 2);
- throw: a throw disables the strategy for the run with a critical alert; open positions keep their exit plans (step 7).

**Switch.** `strategy.<id>.enabled_modes` (a list of `Mode`: `backtest`, `replay`, `paper`, `live_small`, `live`); `strategy.<id>.params.*` (`affectsReturns` yes) (A-M09-01 config). The host also checks the stage against the mode (step 5): paper runs any enabled strategy, live-small needs stage `live_small` or `live`, live needs `live`, backtest and replay run only the strategy under test. M26 is authoritative; this check is defence in depth.

**Staging rules** (round 2 rulings 1, 2, 11). The switch key stays SPEC's `strategy.<id>.enabled_modes`, which names no version, so the host and the validator bind it to the stage record:
- In `paper`, `live_small` or `live`, the host emits only when the running `(version, paramsHash)` equals the stage record's frozen version and `configKey`. Otherwise it disables the strategy with `E_VERSION_NOT_STAGED` (PROPOSED code, named by the ruling) and a critical alert, and the validator refuses `paper` and live modes on the same mismatch.
- A new version starts its own stage at pre-registration, with its own PREREG. That stage is SPEC's `research` (A-M13-05 step 1; supervisor, 8 Oct). Example: while X@1 is `live_small`, X@2 is in `research` and cannot emit in paper or live until it has its own PREREG and stage; a rollback to X@1 runs only if X@1's stage record still matches.
- At stage `failed` or `archived` the host emits nothing in any mode, and the validator refuses every mode. The move to `failed` removes every mode from `enabled_modes` as an audited A1 action (actor `system`).

## 4. Template plugin

A known-answer example that every new strategy is copied from, and that the tests use to prove the host works. Two templates, both from ARCH 16.4 and A-M09-01 "Tests":

| Template | What it does | Known answer the tests check |
|---|---|---|
| `random-buy` | On each complete bar of an in-universe pool, buys when `ctx.rng` draws below a fixed probability in `params`; fixed exit plan and size | Same bars and seed twice → byte-identical proposals and `featuresHash`; over enough trades the after-cost mean per trade is negative, about −`g*` (ARCH 16.4) |
| `lookahead-cheat` | Reads one bar ahead (test only) | Detected by the no-lookahead test (ARCH 16.4); never registered outside tests |

Z-STRAT checks only the fixture answer. The after-cost loss of `random-buy` and the detection of `lookahead-cheat` are checked by A-M11-02's acceptance criteria (SPEC-A:1829-1830), which use these two plugins.

A small hand-computed fixture pins the exact answer: for a fixed seed and a short bar series, the test lists the bars where `random-buy` proposes and the full `SignalProposal` of each (PROPOSED: a fixture of 20 bars in the test file, hand-checked; the SPEC fixes no size).

**The template is a losing strategy by design.** Under "No knowingly losing trades" it may run in `backtest` and `replay` only. Config validation refuses `paper`, `live_small` and `live` in its `enabled_modes`, the same way A-M09-03 forbids live modes for PM-01 (**SPEC SILENT** on the template's modes; ruling 4).

## 5. Gates

In order. Every gate is evaluated by M13 (A-M13-06) and enforced by M26; windows are self-recorded, disjoint and in time order; a gate counts only data after the stage's `stage_entered_at` that no earlier gate used (A-M13-05 step 5). All numbers below are ARCH 3.4's.

1. **Gate B (backtest), on `W_B`: ≥ 30 days** of bars recorded after the PREREG (plan for up to about 65 days at a few trades a day). B-1 ≥ 300 closed trades; B-2 net mean per trade > 0 with bootstrap 95% CI lower bound > 0, on the conservative cost row; B-3 Deflated Sharpe ≥ 0.95; B-4 rank stability (≤ 3 trials) or PBO ≤ 0.05; B-5 trials within the MinBTL budget; B-6 t ≥ 3.0; B-7 max drawdown ≤ 20% of `E`; B-8 positive in the final 20% and in each calendar week; B-9 10 replays byte-identical (owner item 1); B-10 transaction-level history replay with zero crashes, illegal states or unreconciled intents (owner item 2; can fail the stage, never pass it alone). One configuration is selected here. Pass → `backtest_passed`.
2. **Gate R (replay), on `W_R`: ≥ 14 days** after `W_B`, the selected configuration only, frozen before `W_R` starts. R-1 ≥ max(300, `n_80`) trades (80% power from the lower bound of `W_B`'s Sharpe interval; above 90 days goes to the owner); R-2 CI lower bound > 0; R-3 mean ≥ 50% of `W_B`'s; R-4 still > 0 with doubled latency and doubled sandwich probability; R-5 drawdown ≤ 15% of `E`; R-6 crash-day review. This is owner item 6's untouched holdout. Pass → `replay_passed`.
3. **Gate P (paper), on `W_P`: ≥ 21 days** after `replay_passed`. P-1 trade count (≥ max(MinTRL, 100)); P-2 CI lower bound > 0; P-2b fixed cost covered; P-3 not below the replay CI lower bound; P-4 drawdown ≤ 10% of `E`; P-5 data and uptime, with the 48 h dry run (owner item 3); P-6 shadow simulation, `okShare` ≥ 95% (owner item 4); P-9 fixed cost ≤ 3% of `E`; P-10 fault injection (owner item 5). Pass → `paper_passed`. P-7 (kill drill) and P-8 (checklist, phrase, step-up, delay) are checked at the promotion command.

The earliest live-small date is at least about 65 days after recording starts (ARCH 3.4).

## 6. Switch

**Paper first.** A strategy can be switched on in paper once its PREREG is registered (`CLAUDE.md` "Strategy slots"); without one, validation refuses `paper` (ruling 1). Paper trades before `replay_passed` are labelled `shadow` and count for no gate (ARCH 3.4). The switch is a config change of `strategy.<id>.enabled_modes`, applied through M25 and M26 (the S-10 path). The owner gets a switch per strategy and per mode on a strategies screen (card Z-STRAT-UI below; ruling 8).

**Action class of the switch** (UI action classes; B-M25-02 step 2; B-M26-02 step 1):

| Change | Class | Friction |
|---|---|---|
| Switch off in any mode | A1 ("disable a strategy") | One confirmation, immediate |
| Switch on in paper | A2 (**SPEC SILENT**; ruling 2) | Confirmation, reason ≥ 10 characters, step-up if `elevated_until` has passed (UI action classes; the 5-minute elevation is PROPOSED, UI.md S-00 step-up) |
| Switch on in `live_small` or `live` | A3 ("enable a strategy in a live mode") | Server readiness gates, typed phrase `ENABLE <id>@<version> LIVE-SMALL` (or `… LIVE`; round 2 ruling 8), fresh step-up ≤ 60 s, reason, **60-second cancellable delay**, audit |

**Who derives the class** (round 2 ruling 8). B-M25-02 derives a class per key from `riskDirectionOnIncrease`, which has no meaning for a list. The server's class for a diff is therefore the higher of M25's derived class and the `enabled_modes` validator's class, so a neutral direction on the list key can never turn a live switch into A2. M26 enforces the result (B-M26-02 step 2).

**Start and bootstrap** (round 2 ruling 7). The first config (`/etc/bot/config.json`, B-M25-01 step 4) and every later start run the full cross-key validator, with the PREREG snapshot and the stages. A violation gives `start_refused` or `exits_only` (B-M25-03). Bootstrap refuses `live_small` and `live` in any `enabled_modes`; only an A3 action can add them.

**Live only after the gates.** Live needs all of: the strategy's stage `paper_passed` or later (B-M21-02 step 1; B-M26-04 step 2), the system promoted to live-small by the A3 `set_mode` flow with P-1..P-9 passing and no cooldown, the signer's own `max_mode` raised on the host, and at most 1 strategy live at once (ARCH 8.1 "Strategies live at once", short code `MAXSTRAT`, CL-64; B-M26-04 step 2). A3 actions are not offered on the phone view and the server refuses them from mobile sessions (UI D-UI-11). Raising money from paper to live stays the owner's alone (AGENTS.md "Only the owner").

**Several strategies.** In paper, strategy 1 and strategy 2 can both be on. In live, one at a time (`MAXSTRAT`).

**Paper strategies while the system is live-small** (round 2 ruling 12). SPEC answers this: A-M09-01 step 5 emits in system mode `live_small` only for strategies whose stage is `live_small` or `live`, and B-M26-04 step 2 names one active strategy for the promotion. So while the system is live-small, a strategy that is on only in paper makes no proposals, and its `W_P` gets no new trades. The supervisor confirmed SPEC stands. Keeping it running as a paper shadow (no real orders) would need a change to A-M09-01 step 5; it is PROPOSED in "Open points", to be decided when a second strategy reaches paper.

## 7. Failure

- **Gate fails with enough data** (every count and duration met, a statistical gate fails) → stage `failed`. The strategy stops; no further search on the same data (A-M13-05 step 3; D08). The move to `failed` removes every mode from `enabled_modes` as an audited A1 action; from then on the host emits nothing in any mode and the validator refuses every mode (round 2 ruling 2). It is not paper-traded (`CLAUDE.md` "No knowingly losing trades"). The same holds at `archived`.
- **Not enough data yet** → stays, `pending_data`. Never a pass (A-M13-06). If its limits block every coin for hours, that is a defect to measure ("Discipline, not paralysis"), never a reason to loosen a gate.
- **A revised idea** → a new version or id, a new PREREG, new days. The failed version keeps its record (as MR-01 does, C-76).
- **Coded error** → a throw disables it for the run, with a critical alert; open positions keep their exits (A-M09-01 step 7).
- **After going live** → L-1, L-2 and L-4 (or the operator) demote it to paper automatically (A1); its stage drops to `replay_passed`, with a 7-day cooldown before a fresh `W_P` (A-M13-05 step 4; B-M26-04 step 5). L-3 only blocks new entries (ARCH 3.4).
- **End date.** A strategy the owner brings through the slot (`origin = owner`) may continue after 31 Dec 2026 within what the owner already pays; an `origin = agent` strategy stops at 2026-12-31T23:59:59 Australia/Melbourne, enforced by the host and the validator (section 1; card Z-H-OF round 2 item 14; ARCH D08; open for the owner to overrule).

## 8. Owner checklist

1. Write your rules in plain words: which coins, when to buy, when to sell, how much.
2. If your rule needs data the bot does not record yet (holders, wallets, social), say so. The supervisor asks you to approve a card that adds it first.
3. Say which data you used and what results you saw. The average result after costs must be above zero, or the PREREG is refused.
4. List every version you tried, kept or dropped.
5. Send it to the supervisor. Agents write the PREREG; you read it and say yes. Agents may only start a strategy of their own if you say yes first, and theirs stop on 31 Dec 2026.
6. The PREREG is pushed before any test day is recorded. Nothing in it changes after that.
7. Agents build the plugin from the template. A reviewer checks it matches your rules.
8. Switch it on in paper on the strategies screen. They are marked shadow and do not count for any gate yet.
9. Wait for gate B (at least 30 days), then R (at least 14 days), then P (at least 21 days).
10. If any gate fails, the strategy stops. Bring a new version, not a tweak of this one.
11. If all pass, live is your choice, on the desktop dashboard: type the phrase, sign in fresh, wait 60 seconds. You can cancel in that minute.
12. Live also needs: the go-live checklist and the kill drill (P-7, P-8), the signer's top mode raised on the server, only one strategy live at a time, and the wallet funded, which only you do.

## Card Z-STRAT

### Scope

A-M09-01 runtime host; the two template plugins of section 4; the pure `enabled_modes` validator (rulings 1, 2, 4, 5; round 2 rulings 1–3, 7–9, 11); the staging, params, origin and fresh-instance rules in the host (round 2 rulings 1–3, 9, 13); the append-only source-pin CI check (ruling 3; round 2 ruling 4); the globals allow-list lint (round 2 ruling 6); this document. Not in scope: A-M13-02, A-M13-05, A-M13-06 (built in M2 per INTEGRATION); the strategies screen (card Z-STRAT-UI below); any real strategy.

### Dependencies

| Need | From | Until it exists |
|---|---|---|
| `Config`, `ConfigFieldSchema` with `affectsReturns`, the frozen config snapshot; schema entries for `strategy.<id>.enabled_modes`, `strategy.<id>.params.*`, `strategy.runtime.onbar_warn_ms` | Z02, B-M25-01 | Blocking. The host reads config only through the B-M25-01 `Config` type |
| Wiring of the `enabled_modes` validator into M25 validation | B-M25-02 cross-key rules (ruling 5; Phase 2 in SPEC-B) | Z-STRAT ships the validator as a pure function with tests; B-M25-02 calls it |
| PREREG lookup for the validator: `preRegistered(strategyId, strategyVersion, paramsHash): boolean` | A-M13-02 (M2) | **NEW, PROPOSED name** (ruling 1; A-M13-02 has `preRegister` but no read). B-M25-02 is pure, so M25 passes the validator a read-only snapshot of the registered `(strategyId, strategyVersion, paramsHash)` set taken at validation time, never a live database call. Until A-M13-02 exists, tests use a fake set behind the same type |
| `strategy` table (`strategy_id` + `version`, `params_hash`, `enabled_modes`) | Z02, B-M24-02 | Blocking for persistence; the registry can be tested in memory first |
| `Features` (A-M08-02) | Z09 | A fake that implements the A-M08-02 `Features` type exactly (all six methods, including `dumpFlagState`), so swapping in the real one is type-checked |
| `Bar`, `isComplete` (A-M08-01) | Z09 | Fixture bars of the ARCH 5.0a `Bar` type |
| `position(poolId)` (M20), `candidate(poolId)` (M05), stage (A-M13-05), edge estimate (A-M13-04), `signal` stream (M07), critical alert | M2 tickets | Fakes behind their published types |
| The after-cost and look-ahead known-answer checks on the two template plugins | A-M11-02 (M2; SPEC-A:1829-1830) | Not tested in Z-STRAT; Z-STRAT supplies the plugins |
| `canonicalJson()` | Z01, B-M19-01 (`@bot/types` `canon.ts`, merged #287) | Available |
| Lint and dependency policy | Z01, B-M30-01 | Available; add the plugin import rule and the source-pin check |

### Acceptance criteria

| # | Criterion | Source |
|---|---|---|
| AC-1 | A plugin that throws on its 3rd bar is disabled, a critical alert is raised, and no proposal from it appears afterwards; its open positions keep their exit plans | A-M09-01 AC 1, step 7 |
| AC-2 | An incomplete bar gives no proposal | A-M09-01 AC 2, step 3 |
| AC-3 | The same bars and seed twice give byte-identical proposals, `featuresHash` included | A-M09-01 AC 3; owner item 1 |
| AC-4 | Stage `paper_passed` in mode `live_small` gives no proposal; paper runs any enabled strategy; backtest and replay run only the strategy under test | A-M09-01 AC 4, step 5 |
| AC-5 | Same `(id, version)` with other params → `E_PARAMS_CHANGED`; `paramsHash` = sha256 of canonical JSON, stable under key order | A-M09-01 step 1 |
| AC-6 | A proposal for another pool → dropped `E_POOL_MISMATCH`, counted; `side`, `stopBps < 0`, `timeStopMs > 0` and one-per-pool-per-bar enforced with a drop reason | A-M09-01 step 4, edge case 1 |
| AC-7 | A plugin that mutates its context is treated as a throw | A-M09-01 edge case 2 |
| AC-8 | Ten slow calls (over `onbar_warn_ms`) in 1 h → warning alert, not disabled | A-M09-01 edge case 3 |
| AC-9 | `kellyFractionLowerBound` returns 0 when either input is null, the lower bound ≤ 0, or `varianceBps2` ≤ 0 (no division by zero) | A-M09-01 step 6; reviewer m8 |
| AC-10 | `status()` gives `strategyId`, `version`, `paramsHash`, `enabled`, `disabledReason` and `modes`, and M28's projection test double maps them to VM-03 `strategies[]` (`strategy_id`, `enabled`, `modes`). VM-03 `name` has no source in `status()`; it is listed in Z-STRAT-UI's contract gap | A-M09-01 `status()`, DoD; UI VM-03; reviewer m5 |
| AC-11 | `random-buy` gives exactly the proposals of the hand-computed fixture, deterministically. The after-cost check (negative mean, within the CI of −`g*`) and the look-ahead detection are A-M11-02's criteria and are not tested here | A-M09-01 tests (fake strategies); A-M11-02 acceptance criteria (SPEC-A:1829-1830); reviewer M2 |
| AC-12 | A plugin importing anything but `@bot/types` and the features API fails lint; so does each of `Date`, `Math.random`, `fetch`, `process`, `globalThis`, `eval`, `new Function`, `require`, dynamic `import()`, computed `globalThis` access, `setTimeout`, `performance.now()`, `WebSocket` and `crypto`, with one failing fixture per name | A-M09-01 security notes; B-M30-01; round 2 ruling 6 |
| AC-13 | The template's `enabled_modes` containing `paper`, `live_small` or `live` fails validation | Ruling 4; mirrors A-M09-03 |
| AC-14 | `enabled_modes` containing `paper` for an `(id, version, paramsHash)` not in the registered set fails validation, with a reason naming the missing PREREG; the same `paper` passes once the set holds it | Ruling 1 |
| AC-15 | Adding `live_small` or `live` derives A3; adding `paper` derives A2; removing any mode derives A1; a diff with several changes takes the highest class. Integration on B-M25-02 and B-M26-02: with the list key's M25 direction set to neutral, adding `live_small` still previews A3 with `delayS` 60 and the phrase `ENABLE <id>@<version> LIVE-SMALL`; the same request from a mobile session gets 403 `mobile_forbidden` | Ruling 2; B-M25-02 step 2; round 2 ruling 8 |
| AC-16 | Changing a plugin's source without changing its version fails CI; a new version with a new pin passes; an existing pin entry changed to a new hash fails; a removed pin entry fails (compared with the base branch) | Ruling 3; round 2 ruling 4 |
| AC-17 | Upgrade: while X@1 is `live_small`, running X@2 emits nothing in paper or live, is disabled with `E_VERSION_NOT_STAGED` and a critical alert, and the validator refuses `paper` and live modes for it; X@2 with its own PREREG starts at stage `research` | Round 2 ruling 1 |
| AC-18 | Rollback: switching back to X@1 emits only if X@1's `(version, paramsHash)` equals its stage record's frozen version and `configKey`; otherwise `E_VERSION_NOT_STAGED` | Round 2 ruling 1 |
| AC-19 | At stage `failed` or `archived`, the host emits nothing in any mode; the validator refuses every mode; the move to `failed` removes every mode as one audited A1 action | Round 2 ruling 2 |
| AC-20 | A change to `strategy.<id>.params.*` of a registered version is refused at validate time with `E_PARAMS_CHANGED`; a config swap that changes `paramsHash` disables the strategy with a critical alert | Round 2 ruling 3 |
| AC-21 | Two runs differing only in the features implementation hash have different `configKey`s; a change in the middle of a window gives `E_TRIAL_MISMATCH` and a recorded window reset | Round 2 ruling 5 (amends A-M13-02 step 2) |
| AC-22 | A bootstrap config holding `live_small` or `live` in any `enabled_modes` is refused; a start whose config breaks any cross-key rule (template in paper, paper without PREREG, mode at `failed`) gives `start_refused` or `exits_only` | Round 2 ruling 7; B-M25-01 step 4; B-M25-03 |
| AC-23 | An `origin = agent` strategy emits nothing after 2026-12-31T23:59:59 Australia/Melbourne (fake clock one second before and after), and the validator refuses switching it on after that; `origin = owner` without a cited owner message fails validation | Round 2 ruling 9 |
| AC-24 | From `backtest_passed` on, a configuration other than the selected `configKey` is refused in paper and live | Round 2 ruling 11 |
| AC-25 | Two runs of the same plugin share no state: a plugin that counts bars in a field starts from zero in each run | Round 2 ruling 13 |
| AC-26 | After a restart the `strategy` table equals the projection of the current config; a row edited directly in the table is overwritten at start | Round 2 ruling 10 |
| AC-27 | B1 (MIGRATION B1; old `worker/src/engine/strategy.ts:1749` dates pool updates from a block-time anchor with `SLOT_MS = 400`): the host and plugins never turn slots into time with a constant. `decisionSlot` is the providerSlot of the bar's last snapshot, `decisionMs` is `ctx.clock.nowMs()`, and bar times come from the bars, which are dated by the one slot-to-time function (B-M15-01 with A10). A fixture whose measured slot time is not 400 ms gives the measured times. The fail-before test runs the same fixture through the old dating path and shows its 400 ms times differ | MIGRATION row A-M09-01 and B1; round 2 ruling 16 (reviewer M3) |
| AC-28 | B5 (MIGRATION B5; old `ZEROED_PAPER_EDGE_PPM`, parsed in `worker/src/run/config.ts:114-166`, let the cost gate `core/src/costs/index.ts:340-348` admit entries): no config key can set an edge in any mode. The only edge input is `ctx.edgeEstimate` from M13; with it null, `kellyFractionLowerBound` is 0 and a paper proposal is never sized above the PREREG's fixed notional. The validator refuses an edge-setting key in every mode. The fail-before test feeds `ZEROED_PAPER_EDGE_PPM=178092` to the old `parseConfig` and cost gate and shows an entry admitted that is refused at 0 | MIGRATION row A-M09-01 and B5; round 2 ruling 16 (reviewer M3) |
| AC-29 | On the live host, `backtest` and `replay` in any `enabled_modes` are refused by the validator; they run only on the research host (UC-12) | Round 2 ruling 19 (reviewer m6) |
| AC-30 | `live_small` or `live` in `enabled_modes` for a strategy below stage `paper_passed` is refused by the validator; the host also emits nothing for it (A-M09-01 step 5) | Round 2 ruling 20 (reviewer m7); B-M21-02 step 1 |

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
| Unit: Kelly helper inputs (null, lower bound ≤ 0, `varianceBps2` = 0 and < 0, positive) | AC-9 |
| Contract: `status()` against the M28 projection double | AC-10 |
| Known-answer: `random-buy` hand-computed fixture | AC-11 |
| Lint fixtures: one bad plugin file per banned name, each must fail the lint run | AC-12 |
| Validator unit table: template modes; registered set present or absent; class per added or removed mode; mixed diff | AC-13 to AC-15 |
| Integration with B-M25-02 and B-M26-02 doubles: neutral list direction still gives A3, `delayS` 60, phrase; mobile 403 | AC-15 |
| CI fixtures against a base pin file: edited source under an unchanged pin; changed hash for an existing entry; removed entry; new version with a new pin | AC-16 |
| Host unit: upgrade and rollback against a fake stage record | AC-17, AC-18 |
| Host and validator unit: `failed` and `archived` stages; audited A1 removal | AC-19 |
| Validator and host unit: params change; config swap with a new `paramsHash` | AC-20 |
| Trial identity unit: features hash in `configKey`; mid-window change | AC-21 |
| Start-up unit: bootstrap and restart with bad configs | AC-22 |
| Host and validator unit with a fake clock: the agent stop moment; `owner` origin without citation | AC-23 |
| Validator unit: other `configKey` after `backtest_passed` | AC-24 |
| Host unit: stateful plugin across two runs | AC-25 |
| Start-up unit: table projection after a direct edit | AC-26 |
| Fail-before pair: measured slot time fixture through the old `strategy.ts` dating path (fails) and the new host (passes) | AC-27 |
| Fail-before pair: `ZEROED_PAPER_EDGE_PPM=178092` through the old `parseConfig` and cost gate (entry admitted) and through the new validator and host (refused; size never above fixed notional) | AC-28 |
| Validator unit: `backtest` and `replay` on the live host | AC-29 |
| Validator and host unit: live modes at `research`, `backtest_passed` and `replay_passed` | AC-30 |
| Metrics: `signals_total{strategy}`, `proposal_dropped_total{reason}`, `strategy_onbar_ms{strategy}`; log `M09.strategy_disabled` | A-M09-01 observability |

Every bug-fix test must fail before and pass after (AGENTS.md "Builders"). MIGRATION row A-M09-01 marks `core/src/engine/engine.ts:17-40` and `core/test/purity.test.ts` as adapt; under "No bugs migrate" its B1 and B5 probes are AC-27 and AC-28.

## Card Z-STRAT-UI

The owner's switch button (owner, 2026-10-08: "Like a switch button where this logic turns on strat 1 Then strat 2 turns on"; ruling 8). A follow-up UI card after Z05, not part of Z-STRAT. The card name, the screen number and the route are PROPOSED; UI.md has no strategies screen today.

**Goal.** A strategies screen (PROPOSED S-16, route `/strategies`) that lists every strategy from VM-03 `strategies[]`, with one on/off control per mode (`paper`, `live_small`, `live`; backtest and replay are research-host modes and get no control, UC-12).

**Behaviour.**
- The control is not the C10 Switch: UI.md C10 is "Never used for money-affecting toggles that need confirmation; those open a dialog". It is a button that shows the mode's state (on or off) and opens the UI-T13 command flow; nothing applies on click. The flow writes `strategy.<id>.enabled_modes` through the S-10 config path (`config/validate`, PROPOSED in UI.md S-10, then `apply_config`, B-M25-02 and B-M26-02). The class is the server's `derived_action_class` under ruling 2: off A1, paper on A2, live on A3 (typed phrase, fresh step-up, reason, 60-second cancellable delay).
- A strategy with no PREREG shows its paper switch disabled, with the reason as text next to it. The server's validation refusal stays authoritative.
- The template plugin shows its paper and live switches disabled, with its reason (ruling 4).
- A strategy at stage `failed` or `archived` shows every switch disabled, with the stage as the reason (round 2 rulings 2 and 14).
- Live switches are disabled, with the reasons, while the strategy's stage is below `paper_passed` or another strategy is live (`MAXSTRAT`).
- No optimistic UI: a switch shows `pending` until VM-03 reports the new `modes` (UI command lifecycle step 4).
- The phone view shows the list read-only. A2 and A3 are not rendered on mobile (D-UI-11).
- Labels are short and plain ("Paper", "Live-small", "Live", "No PREREG"), and pass the no-AI-wording guard.

**Depends on.** Z05 (UI-T04 primitives, UI-T07 dialogs); UI-T09 (step-up); UI-T13 (command framework); UI-T26 (S-10 config path); backend B-M25-02, B-M26-02, and A-M09-01 `status()` through M28.

**Contract gap (PROPOSED).** VM-03 `strategies[]` holds only `strategy_id`, `name`, `enabled` and `modes`. To show the disabled switch and its reason before a click, the screen needs per strategy: whether a PREREG is registered, the stage, and per-mode blocking reasons. VM-03 `name` also has no source today: A-M09-01 `status()` returns no name. Proposed: add `prereg_registered: boolean`, `stage: StrategyStage` and `mode_blocking_reasons: { mode, code, message }[]` to `strategies[]`, with `name` taken from the PREREG's strategy name, projected by M28 (B-M28-03). This changes a contract, so a reviewer of `@bot/contract` must pass it.

**Acceptance criteria.**
1. Given two strategies with PREREGs, when the operator switches strategy 1 on in paper, then the A2 dialog opens; after confirmation exactly one `apply_config` is sent with `enabled_modes` containing `paper`, and the switch shows `on` only after VM-03 reports it.
2. Given a strategy with no PREREG, then its paper switch is disabled and shows the reason; and if a crafted request is sent anyway, the server's refusal is shown verbatim.
3. Given a strategy at stage `paper_passed`, when the operator switches it on in `live_small`, then the A3 dialog asks for the typed phrase, a fresh step-up and a reason, and the switch shows the 60-second countdown with Cancel (A1).
4. Given a strategy that is on in paper, when the operator switches it off, then the A1 confirmation applies it at once.
5. Given another strategy already live, then every other strategy's live switches are disabled with the `MAXSTRAT` reason.
6. Given the template plugin, then its paper and live switches are disabled and cannot be turned on.
7. Given a mobile session, then no switch can be operated.
8. Given an A3 live switch, then the typed phrase is `ENABLE <id>@<version> LIVE-SMALL` (or `… LIVE`), case-sensitive (round 2 ruling 8).
9. Given a strategy at stage `failed` or `archived`, then every switch is disabled with the stage as the reason (round 2 ruling 14).
10. Given a strategy below `paper_passed`, then its live switches are disabled with the stage as the reason, and a crafted request is refused by the server (round 2 ruling 20).

**Tests.** Unit (switch state from VM-03 fields; mapping each disabled reason to text); component (the control's states `on`, `off`, `pending`, `failed`, and that a click opens the dialog and applies nothing); e2e with the M28 double (criteria 1 to 10, including the server-refusal path); contract test for the new `strategies[]` fields; accessibility (each switch labelled by strategy and mode, its reason linked by `aria-describedby`); the no-AI-wording guard.

## Rulings

Supervisor rulings on the eight questions of the first draft (session `session_01UQmXJHSgmb2Tj7PK7VDKRz`, 2026-10-08 about 9:23 AM Melbourne time; recorded in `docs/reviews/STRATEGY-INTAKE.md` on `claude/supervisor-docs`):

1. Paper is refused unless a PREREG exists for `(id, version, paramsHash)`; the lookup is named under "Dependencies" (AC-14).
2. Adding `live_small` or `live` is A3, adding `paper` is A2, removing any mode is A1 (AC-15).
3. A CI check pins `id@version` to a hash of the plugin source (AC-16).
4. The template runs in backtest and replay only (AC-13).
5. The validator is wired in B-M25-02's cross-key rules; Z-STRAT ships it as a pure validator.
6. When two strategies propose the same pool, M21's per-token rule rejects the second; Z-STRAT adds nothing.
7. New inputs are not added now. When the owner brings a strategy that needs them, the supervisor puts a features card to the owner (section 1; checklist item 2).
8. The owner's switch button is required: card Z-STRAT-UI.

Round 2, after the round 1 red team at `a889f73b` (red team `session_01HECcHHGsHibzJQLqXnMmYz`; supervisor rulings 8 Oct about 9:35 AM Melbourne time, in the same review file at `30bafe16`):

1. B1: a version runs in paper or live only when it matches the stage's frozen version and `configKey` (`E_VERSION_NOT_STAGED`); a new version starts its own stage (section 3 "Staging rules"; AC-17, AC-18).
2. B2: nothing is emitted and every mode is refused at `failed` or `archived`; the move to `failed` removes every mode as an audited A1 action (AC-19).
3. B3: params are bound to the version and refused in config; the host re-checks `paramsHash` on every swap (AC-20).
4. M1: the pin file is append-only, compared with the base (AC-16).
5. M2: a features-implementation hash in `configKey` (AC-21).
6. M3: the globals allow-list lint (AC-12).
7. M4: the full validator at bootstrap and every start; bootstrap refuses live modes (AC-22).
8. M5: the class is the higher of the two derivations; the A3 phrase is `ENABLE <id>@<version> LIVE-SMALL` or `LIVE` (AC-15).
9. M6: `origin` owner or agent; agent strategies stop at 2026-12-31T23:59:59 Australia/Melbourne and need the owner's OK to start (AC-23).
10. m1: config is authoritative; the table is a projection (AC-26).
11. m2: only the selected `configKey` after `backtest_passed` (AC-24).
12. m3: SPEC stands; a paper-only strategy pauses while the system is live-small. The paper shadow stays PROPOSED in "Open points", to be decided when a second strategy reaches paper (supervisor, 8 Oct). B1's `registered` is SPEC's `research`; no new stage (supervisor, 8 Oct).

Round 2, reviewer round 1 at `a889f73b` (FAIL on 4 MAJOR, 11 MINOR; reviewer `session_011iA9FMWTMikWUyoerDHrq2`; supervisor rulings 14–22, 8 Oct about 9:38 AM):

14. M1: covered by round 2 ruling 2; the disabled reason is on Z-STRAT-UI (its criterion 9).
15. M2: AC-11 is the hand-computed fixture only; the after-cost and look-ahead checks are A-M11-02's (SPEC-A:1829-1830), listed under Dependencies.
16. M3: B1 and B5 are AC-27 and AC-28, each with a fail-before test. The ruling numbered them AC-17 and AC-18 against `a889f73b`; those numbers were already taken by round 2 ruling 1, so they follow the existing list.
17. M4: no C10; the control shows on or off and opens the UI-T13 dialog.
18. m1: the L-3 wording (section 7). m2: the `edgeEstimate` object (section 3). m3: the A2 step-up window marked PROPOSED (section 6). m4: `config/validate` marked PROPOSED. m5: VM-03 `name` in the contract gap (AC-10). m8: `varianceBps2` ≤ 0 → 0 (AC-9). m11: the ruling time is about 9:23 AM.
19. m6: `backtest` and `replay` refused on the live host (AC-29).
20. m7: live modes refused below `paper_passed` (AC-30; Z-STRAT-UI criterion 10).
21. m9: "They are marked shadow and do not count for any gate yet." (checklist item 8).
22. m10: checklist item 12 lists what live also needs.
13. m4: the evidence must show a positive after-cost result; a fresh plugin instance per run (AC-25).

## Open points

1. **Owner's evidence and the windows.** Gate B uses only days recorded after the PREREG (C-26). The owner's research data may serve a CS-1 kill-only screen, never a pass. This is a confirmed reading; no change is proposed.
2. **Owner-strategy end date.** It rests on a supervisor ruling (card Z-H-OF item 14) that is listed for the owner to overrule.
3. **VM-03 contract change** for Z-STRAT-UI (above). It needs a contract reviewer.
4. **`preRegistered` read on A-M13-02** (PROPOSED name). It needs adding to that ticket when it is carded.
5. **Paper shadow under live-small (PROPOSED, round 2 ruling 12).** SPEC stands: a paper-only strategy pauses while the system is live-small (A-M09-01 step 5; supervisor, 8 Oct). A paper shadow with no real orders, so its `W_P` continues, is to be decided when a second strategy reaches paper; no amendment now.
6. **SPEC amendments these rulings imply.** A-M13-02 step 2 (features hash in `configKey`); A-M09-01 (staging, params and origin checks, `E_VERSION_NOT_STAGED`); B-M25-02 (class as the higher of two derivations, the new cross-key rules); B-M25-01 and B-M25-03 (validator at bootstrap and start); ARCH 15 `strategy` table (`origin` column). Each needs its ticket text updated when it is carded.
