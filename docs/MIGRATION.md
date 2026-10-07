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

No group A ticket meets its Blueprint acceptance criteria as Zeroed stands, so no row is **keep**. Under the owner's "no bugs migrate" rule (Rules above), **adapt** means the Zeroed code can be brought to pass the Blueprint ticket's acceptance tests and the fail-before test of every bug in its last column; where it cannot without a rewrite, the row is **replace**. Count over 63 tickets: 0 keep, 33 adapt, 7 replace, 23 missing. Bug codes: B1–B5 are in "Known bugs, Data and strategy"; OOM and RTC are the restart loop and red team C rows of "Bugs left behind". Paths are under `packages/`. The reusable parts were run focused at base `5d7260f` with `pnpm vitest run`; every file passed, and the counts are in "Zeroed assets". Those runs prove Zeroed's own spec, not the Blueprint criteria.

### M01 Venue and quotes

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M01-01 Constants, PDAs | `core/src/chain/programs.ts:6-19`, `chain/pump.ts:83`, `chain/pump-amm.ts:82-96`, `core/src/tx/programs.ts:5` | adapt | Pump, PumpSwap, fee, Global, FeeConfig, SPL, Token-2022 and wSOL IDs exist. Canonical pool PDA tested (`core/test/chain/accounts.test.ts:149-180`). Gaps: no Raydium, Meteora or Orca IDs; the withdraw authority sits in `worker/src/run/sources.ts:29`, outside one constants file; no startup re-derivation or `E_CONSTANT_MISMATCH`; bumps not asserted. | — |
| A-M01-02 Fee schedule cache | `core/src/chain/fees.ts:23-66`, `core/src/amm/fees.ts:22-41`, `amm/pump-swap.ts:52-62` | adapt | FeeConfig decode and tier pick tested (`accounts.test.ts:128-137`). Gaps: no `VenueConfigCache` (hash, slot, version), no `E_CONFIG_STALE`; at a tier boundary `>=` takes the cheaper tier (`amm/fees.ts:29`), not the dearer one (ARCH M01 failure table); tier picked from effective quote only (`pump-swap.ts:58`); no `feeOnBuy`. | — |
| A-M01-03 Quote math, `minOut` | `core/src/amm/pump-swap.ts`, `amm/pump-curve.ts`, `core/src/exits/value.ts:36-38` | adapt | All bigint. Golden tests match 353 PumpSwap and 313 curve mainnet events to the unit (`core/test/amm/golden.test.ts`), better than 1 bp. Gaps: different `Quote` shape (no `priceImpactBps`, no `spotBeforeSolPerToken`); returns `no-liquidity` where the ticket throws `E_NEGATIVE_EFFECTIVE` (`pump-swap.ts:89`); `minOut` lives in exits, not `VenueModel`. | B2: `quoteReserve` returns 0.27 SOL, not 17.85, on a drained post-BOOST pool |
| A-M01-04 Orientation guard | `worker/src/run/snapshot.ts:30-74`, `chain/pump-amm.ts:92-96` | adapt | Vault mint and owner checked (`snapshot.ts:49`). Gaps: no 1% spot-vs-swap check, no quarantine event; base-is-wSOL pools rejected, not normalised; canonical check by creator only at `snapshot.ts:60`. | — |
| A-M01-05 Venue status | `chain/pump-amm.ts:43` (decoded only) | missing | `disableFlags` is decoded and never read. No realised-fee mismatch counter, no `unquotable` state. | — |
| A-M01-06 Raydium spec | none | missing | Gated, Phase 3b. | — |

### M02 Decoders

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M02-01 Pinned IDLs, codec | `core/src/chain/base58.ts`, `bytes.ts`, `schema.ts`; `core/test/chain/idl.test.ts:46` | adapt | IDL commit `cb188ce` pinned and checked field by field; own base58; core has no runtime dependencies. Gaps: hash checked in tests only; no runtime `verifyPinnedIdls`, no `E_IDL_HASH`, no `start_refused`. | — |
| A-M02-02 Account decoders | `chain/pump.ts`, `pump-amm.ts`, `fees.ts`, `token.ts` | adapt | Signed i128 `virtual_quote_reserves` tested (`accounts.test.ts:197`); unknown trailing bytes flagged (`schema.ts:93-104`). Gaps: short legacy fields come back absent, not default (`schema.ts:100`; `accounts.test.ts:51` asserts the opposite of DA-15); a bad discriminator throws (`schema.ts:114-117`) instead of returning `unknown`. | — |
| A-M02-03 Tx reader, events | `chain/message.ts:55-139`, `chain/transaction.ts:47-65`, `chain/events.ts:10` | adapt | Legacy, v0 and v1 fixtures pass (`core/test/chain/message.test.ts:17`); failed transactions yield no events. Gaps: parent instruction not checked to be the same program (`transaction.ts:54-62`); missing inner instructions throw (`transaction.ts:49`). | — |
| A-M02-04 Log fallback | `chain/transaction.ts:82-114`, `worker/src/run/pool-watch.ts:108-109` | adapt | Truncation flag exists (`transaction.ts:88`). Gap: live pool trades use logs as the primary source (`decodeLogs: true`), the reverse of the ticket; no `decode_gap` metric. | — |
| A-M02-05 Quarantine | `worker/src/providers/canonical.ts:309`, `core/src/facts/producer.ts:891` | missing | Unknown events only taint a heal (fails closed). No quarantine table or once-per-discriminator alert. | — |
| A-M02-06 Instruction decoders | `core/src/tx/venues.ts:40-45` (encoders) | missing | Zeroed encodes swaps; nothing decodes them for a signer. | — |
| A-M02-07 Raydium decoders | none | missing | Gated, Phase 3b. | — |

### M03 Discovery

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M03-01 PumpPortal client | `worker/src/providers/pumpportal.ts:14-64`, `providers/socket.ts:190` | adapt | One socket, only the two free subscriptions, 1 h stop after 3 failed opens (`pumpportal.ts:17`); tested in `worker/test/providers.test.ts`. Gaps: backoff 5 s→300 s with no jitter (ticket: 1 s→60 s with jitter); no backfill on reconnect; no lag metric. | RTC (reconnect burn): a mock that closes the socket 10 times in 60 s sees ≤ 1 backfill per reconnect and no credit spend above budget |
| A-M03-02 Migration backfill | `worker/src/run/sources.ts:428-437`, `providers/solana-ws.ts:7-10` | adapt | `logsSubscribe` on the withdraw authority at processed, confirmed fetches, 100-signature backfill on reconnect. Gaps: no 60 s `getSignaturesForAddress` cursor; no `verifyPool` (canonical, wSOL-quoted) before publish; no PumpPortal `gapBps`. | — |
| A-M03-03 Pool enumeration (D30) | `worker/scripts/gpa-probe.ts:1-7` | missing | The probe scans token accounts by mint for holders, not PumpSwap pools. | — |
| A-M03-04 DexScreener check | none | missing | No DexScreener client. | — |

### M04 Pool state

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M04-01 Batched poller | `worker/src/run/pool-watch.ts:100-116`, `core/src/facts/producer.ts` | replace | Incompatible design: state is built from a confirmed `logsSubscribe` per pool on metered Helius (`pool-watch.ts:108-111`), not 1 Hz `getMultipleAccounts` batches of ≤ 90 on an unmetered provider (ARCH M04, D03). No 2 h ring buffer. The snapshot decode (`run/snapshot.ts`) is reusable. | B4, OOM: credits per hour for 30 watched pools stay under the M14 budget; memory stays bounded over a replayed day |
| A-M04-02 `freshRead`, lag | `worker/src/run/watch.ts:146-172` | adapt | `minContextSlot` floor, stale-bank refusal, monotonic banks. Gaps: held positions only; no 12/8-slot grades, no `E_STALE`, no `pool.stale`. | B1: lag in ms uses the measured slot time (250 ms anchors give 25 s for 100 slots, not 40 s) |
| A-M04-03 Transport seam | `worker/src/providers/solana-ws.ts:249` | missing | No `PoolSource` seam. `accountSubscribe` exists at processed, which D14 forbids for decisions. | — |

### M05 Universe

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M05-01 Candidate states | `worker/src/engine/strategy.ts:1080,1392` | missing | No candidate state machine, cooldown, blacklist or `written_off` list; universe rules live inside the U2 strategy and the hard rejects. | — |
| A-M05-02 Watchlist, tails | `worker/src/run/watch.ts`, `run/pool-watch.ts`, `run/settings.ts:55` | replace | Per-pool log streams (`pool-watch.ts`) cannot meet a watchlist budget derived from M04 polling without a rewrite. Positions are watched at P1 (pinning in effect). Gaps: no `max_watched` from M04's budget; tail cap 3 (`maxTails: 3`) not 30 at 0.1 Hz; no `postEvictionTail()`. | B4: watchlist size is derived from the credit budget; a rejected pool whose reject cannot change is not watched |
| A-M05-03 Universe manifest | none | missing | No daily manifest, no A-24 count. Zeroed's history has no survivorship gap because it keeps every trade (`docs/ARCHITECTURE.md:183`), but §3.4 needs the manifest for recorded data. | — |

### M06 Screener

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M06-01 Check framework | `core/src/gates/hard.ts:613-641`, `gates/staged.ts`, `gates/reasons.ts`, `gates/evidence.ts` | adapt | Unknown input already rejects through H16, matching "error = fail". Gaps: lists failures only, not the full `RiskCheck[]` with pass, skipped and severity; no TTL cache; no `pre_entry`/`pre_exit` purposes. | — |
| A-M06-02 Mint, Token-2022 | H1–H4, H17 in `gates/hard.ts`; `core/src/chain/token.ts` | adapt | Authorities and extensions covered; unknown extensions reject. Stricter than Blueprint on MintCloseAuthority. Gaps: no `metadata_matches_mint`, no `TokenMetadataCache`, no symbol collision count. | — |
| A-M06-03 Holders | H12 in `gates/hard.ts:383-450`, `gates/holders.ts` | adapt | Top-10 30% (Blueprint 35%, so stricter), single holder 10%. Gaps: no soft `creator_balance` check. Not verified: top-20 plus owner resolution. | — |
| A-M06-04 Pool and venue | H5, H6, H8, H10 in `gates/hard.ts:210-315`; `core/src/config/policy.ts:205-221` | adapt | Canonical pool and LP withdrawal covered. Gaps: no per-side `fee_ceiling` (MR 30 bps); `min_depth` in micro-USD and counts virtual SOL (B2 below); no `real_vs_effective_quote`; pool age is 60 min (H10) or 60–240 min (U2), not MR ≥ 24 h or PM 20–120 min; no `dump_flag`. | B2: real vault below the floor, real + virtual above it → reject. B3: thresholds not set from holdout-window data |
| A-M06-05 Honeypot sim | H15 `gates/hard.ts:560-578`, `worker/src/sim/roundtrip.ts`, `worker/src/dryrun/standin.ts` | adapt | One unsigned buy-then-sell transaction, loss from balances. Gaps: stand-in payer, not the D31 payer with a balance check; tolerance about 16 lamports (`core/src/costs/index.ts:20`), not model + 100 bps; no 24 h blacklist; the backtest skips it (`hard.ts:564-566`). | — |
| A-M06-06 Vendor checks | H16 `gates/hard.ts:585-599` | adapt | Vendor disagreement is a **hard** reject; Blueprint makes vendor checks soft and lets the chain win (D13). No `token.authority_changed` re-check while a position is open. | — |

### M07 Recorder

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M07-01 Queue, deltas | `worker/src/run/recorder.ts:1-14` | replace | A synchronous raw-frame writer cannot pass the bounded-queue and change-only tests without a rewrite. It records every raw frame and transaction, more than change-only snapshots. Gaps: synchronous `appendFileSync`, not a bounded queue; no delta encoding, no `backpressure` gaps. | OOM: queue bounded at 50,000 records; overflow drops low-priority streams, never orders or fills |
| A-M07-02 Segments, manifests | `worker/src/run/recorder.ts:340-350` | adapt | Seals at next start, zstd, sha256 per sealed file. Gaps: one manifest per boot, not per segment; no slot range per segment. | OOM, RTC: a kill mid-segment leaves no partial manifest and no duplicate records |
| A-M07-03 Coverage, disk | `worker/src/run/recorder-budget.ts:1-4` | adapt | Conflict: the budget pass deletes sealed recordings "whether or not they were uploaded" (`recorder-budget.ts:1-2`); Blueprint deletes only after a verified pull. No daily `CoverageReport` or `lowCoverage`. | B1: gap length uses the measured slot time (`coverage-journal.ts:5`). Deletion only after a verified pull |

### M08 Bars and features

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M08-01 15 s bars | `core/src/gates/facts.ts:102-114`, `core/src/facts/producer.ts` | replace | Zeroed builds 1-minute trade candles for H11 only, with no depth, net flow or completeness count. Blueprint needs 15 s bars from effective-reserve snapshots. | — |
| A-M08-02 Features | none | missing | No robust z-score, rolling median, MAD, dump flag or basket return. | — |
| A-M08-03 `bar_1m` | none | missing | No bar table. | — |

### M09 Strategy runtime

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M09-01 Runtime host | `core/src/engine/engine.ts:17-40`, `core/test/purity.test.ts` | adapt | Pure as-of strategy interface, seeded RNG, logged decisions. Gaps: no registry with id, version and parameter hash; a throwing strategy is not caught and disabled; no `SignalProposal` or `ExitPlan`; no stage-versus-mode check. | B1: pool updates dated from measured slot time (`strategy.ts:1749`). B5: no config key can inject an edge |
| A-M09-02 MR-01 plugin | none | missing | Zeroed has U1, U2 and S0 only (`backtest/src/strategy/config.ts`). | — |
| A-M09-03 PM-01 plugin | none | missing | PM-01's 20–60 min entries also clash with Zeroed's H10 (no entry before migration + 60 min, `core/src/config/policy.ts:221`). | — |

### M10 Simulation core

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M10-01 Params, RNG, latency | `core/src/engine/random.ts`, `core/src/stats/rng.ts`, `core/src/config/fills.ts:71-106` | adapt | Seeded RNG, versioned fill config (`fills-3`). Gaps: version is a hand-set string, not a hash; latency in slots, not the lognormal prior (1.5 s median, 5 s p95). | B1: latency drawn in ms or measured slots, not 400 ms slots |
| A-M10-02 Fill, failure, sandwich | `core/src/fills/model.ts`, `backtest/src/sim/world.ts` | adapt | Our order goes after every real trade in its slot (conservative). Gaps: **no sandwich model**; no "worse of two bracketing snapshots" rule; sim time dated with `SLOT_MS = 400` (`world.ts:61`, B1). | B1: simulated landing dated with measured slot time (`world.ts:61`, `market.ts:420`) |
| A-M10-03 Cost model | `core/src/costs/index.ts`, `backtest/src/economics.ts:65-70` | adapt | Round-trip cost in lamports is exact. Gaps: fixed cost in micro-USD (`hostingMicro`), not `fixedCostBpsPerTrade` in lamports; no janitor close or rung-2 double tip; no Table 2-A golden test. | — |
| A-M10-04 Gap, `no_data` | `core/src/fills/index.ts` (`blockedExitValue`) | missing | No `no_data` close rule, no empirical p99 gap-through-stop with a 2,000 bps prior. | B1: not-landed timing in measured slots |
| A-M10-05 Calibration | none | missing | Fill values are provisional; no calibration pipeline. | — |

### M11 Backtest and replay

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M11-01 CLI, loaders, clock | `backtest/src/cli.ts`, `backtest/src/dataset/dataset.ts:50-71`, `core/src/engine/clock.ts`, `engine/asof.ts` | adapt | Simulated clock, as-of lookups and dataset hash checks exist. Gaps: reads the chain archive, not M07 segments (§3.4 allows a dataset that carries reserves, ARCH line 370); no `RunSpec` registry. | B1: `study-world.ts:21` and `proofs.ts:190` take the measured slot time |
| A-M11-02 Bar backtest (`W_B`) | `backtest/src/run.ts`, `backtest/src/strategy/s0.ts`, `core/src/engine/proofs.ts` | adapt | Runs transaction by transaction (finer than bars), with a random-entry control and leak and shift proofs. Gaps: no known-answer check, no `W_B` pre-registered flow. | B3: a `W_B` that overlaps a used window is refused |
| A-M11-03 Replay, latency | `worker/src/run/parity.ts`, `core/src/config/fills.ts:105-106` | adapt | Live-versus-replay decision parity exists. Gaps: no R-4 stress (2 × p95 latency, double sandwich), no R-6 crash-day report. | — |
| A-M11-04 Coarse screen | none | missing | None in code. The research probes on 5-minute vendor bars play this role on paper (see "Research carried in"). | — |
| A-M11-05 Run bundles | none | missing | No signed bundles (no Ed25519 in code). | — |

### M12 Paper adapter

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M12-01 Paper `ExecutionPort` | `worker/src/run/paper-world.ts:1-8` | replace | A different port and fill rule; it cannot pass the `ExecutionPort` tests without a rewrite. It fills at the landing slot on the latest pool fact, not the worse of two bracketing snapshots. Implements Zeroed's `EffectRunner`, not `ExecutionPort` (no `onNotLanded`). | B5: paper entries never sized from a config edge |
| A-M12-02 Shadow sims (P-6) | `worker/src/dryrun/simulate.ts`, `dryrun/report.ts`, `run/live-sim.ts` | adapt | Simulates every paper entry and exit against mainnet and never sends (`worker/test/dryrun-nosend.test.ts`). Gaps: stand-in payer, not D31; sells simulated alone, not as round trips; no median and p90 bps statistics. | — |

### M13 Research analytics

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M13-01 Phase 0 study | `backtest/src/research/*` | missing | No A-24, A-24b or A-48 study. | — |
| A-M13-02 Trial registry | `backtest/src/holdout.ts:90-97`, `backtest/src/strategy/preregistration.ts`, `core/src/stats/trials.ts` | adapt | Config hash and pre-registration exist. Gaps: no append-only `trial_registry`, no `affectsReturns` split, no MinBTL budget or `E_TRIAL_MISMATCH`. | B3: threshold-source windows are registered as used |
| A-M13-03 Statistics | `core/src/stats/*` | adapt | DSR (`stats/sharpe.ts:101`), PBO/CSCV (`stats/pbo.ts:57`), stationary bootstrap inside SPA only (`stats/spa.ts:134`); 206 statistics tests pass. Gaps: no MinTRL, MinBTL, t ≥ 3 gate, rank-stability check, non-inferiority, or 10,000-resample stationary mean CI (Zeroed: day-block, 2,000 resamples, `stats/bootstrap.ts:63`); PBO accepts N ≥ 2, Blueprint needs N ≥ 4. | — |
| A-M13-04 Perf stats, equity | `core/src/risk/evaluate.ts:44-106`, `core/src/risk/types.ts:96-275` | replace | Wrong units: flow-adjusted equity and drawdown are in `MicroUsd` (`risk/types.ts:96,103`); Blueprint needs lamports and `equity_point` rows. | B5: `edgeEstimate` comes only from M13 lower CI, never from config |
| A-M13-05 Stage machine | `core/src/stats/holdout.ts:47` | missing | No per-strategy stage, `stage_entered_at`, `E_WINDOW_OVERLAP` or shadow labels. | B3: `E_WINDOW_OVERLAP` on an overlap with a used window |
| A-M13-06 Gate evaluation | `core/src/stats/gates.ts` | replace | A different gate system (G0–G5, Holm, S0 comparison), not CS, B, R, P and LS. Parts can be reused. | B3: as A-M13-05 |
| A-M13-07 CUSUM (L-1) | `core/src/stats/eprocess.ts:90-121` | missing | Zeroed demotes with a betting e-process; no CUSUM in code. | — |
| A-M13-08 Bundle import | none | missing | No import path. | — |

### M14 RPC gateway

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason | Known bugs (fail-before test) |
|---|---|---|---|---|
| A-M14-01 Providers, client | `worker/src/providers/http.ts:53-107`, `providers/endpoints.ts`, `providers/solana-http.ts:52-113` | adapt | Keys scrubbed; `maxSupportedTransactionVersion: 1` sent (`solana-http.ts:66`). Gaps: Helius and Alchemy hard-coded; no https/wss validation; a 429 carries no `retryAfterMs`; `getAccountInfo` at processed (`solana-http.ts:91`). | RTC: a 429 carries `retryAfterMs`; credit counting survives an unreadable credits file without halting for the month |
| A-M14-02 Limits, failover | `worker/src/scheduler/scheduler.ts:171-251`, `scheduler/limits.ts:9-75` | adapt | Priority floors, lowest-first shedding, P0 never shed (`worker/test/scheduler.test.ts`). Blocking gaps: limits at 100% of the documented rate (Helius 10/s `limits.ts:11`, Alchemy 25/s `:31`, Jupiter 60/min `:57`) against the 50% owner rule; a 429 does not honour `Retry-After`, back off or stop after 3 failures (`scheduler.ts:247-251`); no unmetered pinning. | B4: buckets at ≤ 50%; 3 failures stop the provider-method |
| A-M14-03 Service clients | `worker/src/providers/jupiter.ts:68-104`, `scheduler/limits.ts:54-75` | adapt | Jupiter remaining-header honoured; 30/min kept for exits while a position is open. Gaps: no `beginExitWork`; RugCheck at 1 per 4.5 s is about 89% of its observed 15 header; no DexScreener or CoinGecko client. | — |
| A-M14-04 Send buckets | `core/src/tx/landing.ts` | missing | A landing plan, no `acquireSend` buckets. | — |
| A-M14-05 Health, burn rate | `worker/src/scheduler/scheduler.ts:147-150,237-244`, `run/sources.ts` (`CreditBook`) | adapt | Monthly credits persisted; non-P0 halts at 70% (`limits.ts:15`); exhausted-credit 429 handled (`worker/test/helius-exhausted.test.ts`). Gaps: no month-end projection, no `degraded_reads`. Not verified: the comment at `sources.ts:408` says the live Helius scheduler "has no halt". | B4: an 80k-credits-an-hour rate raises the projected-overrun alert and enters degraded mode before the budget is spent |

## Group B modules

_Filled by MIGRATION-B._

## Market and strategy decisions

D01, D03, D04, D08, D12, D13, D14, D17, D18, D29, D30.

| Blueprint item | Zeroed files | Verdict | Evidence, gaps or reason |
|---|---|---|---|
| D01 Direct adapters | `core/src/tx/venues.ts:1-6`, `core/test/tx/golden.test.ts`; Jupiter `/swap/v2/order` and `/build` in `worker/src/providers/jupiter.ts:68-78` | adapt | Same default (a): direct PumpSwap and curve builders, byte-matched to mainnet swaps. Jupiter is used for quotes only. Gaps: no rung-4 Jupiter exit route, no instruction decoding for the signer (A-M02-06). |
| D03 Market-data transport | `worker/src/run/pool-watch.ts:104-111`, `worker/src/providers/solana-ws.ts` | replace | Zeroed uses option (b): a `logsSubscribe` per pool on metered Helius. Blueprint default (a) polls `getMultipleAccounts` at 1 Hz on an unmetered provider. Zeroed's trade-level data is richer (D03's own switch trigger allows it once a strategy needs every trade), but its Helius use is the cost problem the owner named (about 25,000 credits an hour, `CLAUDE.md` S2 item 21). |
| D04 RPC providers | `worker/src/scheduler/limits.ts:9-35` | adapt | Zeroed: Helius Free and Alchemy Free only. Blueprint: Helius, Shyft, Chainstack, Alchemy free tiers. The owner already holds Helius Developer (`CLAUDE.md` "No extra data spend"), which D04 allows only above about $2,033 equity. See clashes. |
| D08 Strategy family | `backtest/src/strategy/config.ts`, `worker/src/engine/strategy.ts:1`, `docs/ARCHITECTURE.md:53-55` | replace | Zeroed tests U1, U2 and the S0 control; U3 is excluded. Blueprint runs MR-01 first and PM-01 second. Neither MR-01 nor PM-01 exists in Zeroed (A-M09-02/03 missing). The research below shows close versions of both lost. |
| D12 Discovery source | `worker/src/providers/pumpportal.ts`, `worker/src/run/sources.ts:428-437` | adapt | Same default (a) for new tokens and migrations (PumpPortal, one socket, plus chain backfill). Missing: DexScreener and D30 enumeration. |
| D13 Token-safety source | `core/src/gates/hard.ts:585-599`, `worker/src/scheduler/limits.ts:66-75` | adapt | Own RPC checks plus RugCheck, GoPlus and Jupiter audit. Conflict: Zeroed makes vendor disagreement a hard reject (H16); D13 makes vendors soft and lets the program source win. Zeroed's rule is stricter, so it only tightens. |
| D14 Commitment | `worker/src/run/pool-watch.ts:105-110`, `worker/src/run/sources.ts:531`, `worker/src/providers/solana-http.ts:91` | adapt | Pool trades at confirmed (matches). Create and migration notices at processed with confirmed fetches (matches the early-warning rule). Gap: `getAccountInfo` reads at processed. |
| D17 History for research | `docs/DECISIONS.md:95-96`, `backtest/src/dataset/*` | adapt | Zeroed's DATA-1 keeps every curve and canonical-pool trade from the chain archive for 2026-07-20 to 10-01 plus holdout days. That is not a D17 option, but it carries reserves, so §3.4 (ARCH line 370) lets it serve gates. Blockers: holdout contamination (B3) and the owner rule "no bulk historical downloads" for any new days. |
| D18 Venue universe | `core/src/tx/venues.ts:1-6` | adapt | PumpSwap canonical pools in every stage (matches). No Raydium, which D18 gates anyway. Zeroed also builds curve trades; Blueprint keeps the curve to research. |
| D29 Where research runs | `docs/DECISIONS.md:83` | adapt | Matches (a): Zeroed backtests run on GitHub, never on the VPS. Missing: signed run bundles and import (A-M11-05, A-M13-08). |
| D30 Pool enumeration | `worker/scripts/gpa-probe.ts:1-7` | missing | No PumpSwap `getProgramAccounts` enumeration; the probe scans token accounts for holders. |

## Execution and operations decisions

D02, D05, D06, D07, D09, D10, D11, D15, D16, D19, D20, D21, D22, D23, D24, D25, D26, D27, D28, D31.

_Filled by MIGRATION-B._

## Zeroed assets

### Data and strategy

ENG-1 (#10), DEC-1 (#11), FEED-1 (#21), GATE-1 (#22), BT-1 (#24).

Read from the merged code at base `5d7260f`. Test runs: `pnpm install --frozen-lockfile`, then `pnpm vitest run <files>` per row; all passed. The runs prove each card's own spec and the reusable parts named, not the Blueprint tickets.

| Zeroed asset | Zeroed files | Blueprint target | Verdict | Evidence, gaps or reason | Focused run |
|---|---|---|---|---|---|
| ENG-1 (#10) Clock, Feed, as-of | `core/src/engine/{clock,feed,asof,random,proofs,engine,runner}.ts` | §5.0 rules (injected clock, seeded RNG, no `Date.now`), A-M09-01, A-M11-01 | adapt | Keep as the deterministic core: purity guard, as-of store, 10 identical replays (`core/test/engine.test.ts:319`), planted-marker leak test (`:364-375`). The Blueprint has no leak or shift test (SPEC-A has no such criterion), so these proofs fill an owner rule. Gaps: event order is per transaction, the Blueprint feeds 1 Hz snapshots and bars; `shiftTest` defaults to 400 ms per slot (`engine/proofs.ts:190`); reconcile limits sized on 400 ms slots (`engine/runner.ts:23`). | `core/test/engine.test.ts`, `core/test/purity.test.ts`: 2 files, 60 tests passed |
| DEC-1 (#11) Chain decoders | `core/src/chain/**` | M02 (A-M02-01..04), M01 constants | adapt | Mainnet golden vectors, v0 and v1 messages, signed i128 virtual reserves, pinned IDL `cb188ce`. Gaps per M02 rows: no runtime IDL hash, no quarantine, throws on unknown discriminators, short legacy fields absent instead of default, no instruction decoders. The quote math beside it (CORE-2, `core/src/amm/**`) is the strongest part of Zeroed for A-M01-03. | `core/test/chain`: 13 files, 732 passed. `core/test/amm`: 2 files, 693 passed |
| FEED-1 (#21) Providers, scheduler | `worker/src/providers/**`, `worker/src/scheduler/**` | M03, M04, M14 | adapt (M04 transport: replace) | One PumpPortal socket, P0–P3 scheduler with shedding, persisted credits, honest `user-agent` (`worker/src/facts/readers.ts:1148`), no pump.fun request anywhere (grep of `packages/*/src` and scripts). Gaps: limits at 100% of documented rates (`scheduler/limits.ts:11,31,57`) against the 50% owner rule; no `Retry-After` or 3-failure stop; metered per-pool streams instead of unmetered polling (D03). | `worker/test/{providers,scheduler,feed,streams,fault-injection}.test.ts`: 5 files, 84 passed |
| GATE-1 (#22) Evidence gates | `core/src/gates/**` | M06 (A-M06-01..06), ARCH §8.4 | adapt | Fails closed on unknown input (H16); holders exclude vaults, lockers, burns; typed reasons. Gaps: H8 counts virtual SOL as depth and measures it in micro-USD (B2); no MR or PM fee ceiling, real/effective ratio or pool age; vendor checks hard instead of soft; H8, H9 and H11 thresholds come from holdout-dated data (B3). | `core/test/gates`: 17 files, 704 passed |
| BT-1 (#24) Backtester, fill model | `backtest/**`, `core/src/fills/**` | M10 (A-M10-01..04), M11 (A-M11-01..03) | adapt | Strength: transaction-level replay of a survivorship-free archive, our order after every real trade in its slot, seeded landing failures, base, conservative and optimistic scenarios. Gaps: no sandwich model, no `no_data` close rule, no signed bundles; simulated time uses `SLOT_MS = 400` (`backtest/src/sim/world.ts:61`) and `lag * 400` (`backtest/src/sim/market.ts:420`); its sealed holdout is a different design from B-8 (last 20% of `W_B`). | `backtest/test/{replay,parity,run,tape}.test.ts`, `core/test/fills`: 6 files, 506 passed |

Also run, for M13: `core/test/stats-{math,gates,simulation,g2,labeller}.test.ts`, 5 files, 206 passed.

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

Addendum: `research/BLUEPRINT_ADDENDUM.md` is not on `ccr-7fae2302-drz4co` at `7b162ed8` (checked before this push), so nothing from it is adopted here; the input stays `research/SUPERVISOR_MESSAGES.md` (Rules, item 4).

Source: branch `ccr-7fae2302-drz4co` (read at tip `1baca138`), cited as `R:<path>:<line>`; PR #267 head `2c85293f`, cited as `PR267:<path>:<line>`. Nothing here was re-run.

### Owner summary checked

| Owner's line | Finding |
|---|---|
| MR-A and MR-B made −0.76% and −1.03% a trade in 0.30–0.55% pools | Confirmed (`R:research/deep-pool-probe/RESULTS.md:13,15`). Correction: those two CIs do **not** cross zero; both are wholly below it (−1.15 to −0.35; −1.53 to −0.51). The later copy of the message says so (`R:research/SUPERVISOR_MESSAGES.md:151`); the earlier copy is wrong (`:69`). |
| −0.17% and −0.40% in the 0.30% tier, CIs crossing zero | Confirmed. MR-A −0.17%, CI −0.71 to +0.32, 99 trades (`RESULTS.md:19`). MR-B −0.40%, CI −1.17 to +0.51, 73 trades, only in `R:research/deep-pool-probe/results.json` (`results["MR-B"]["$200\|A\|val"]`), not in `RESULTS.md`. |
| MR-01's 15 s signal is untested | Confirmed: the probe used 5-minute aggregator bars (`RESULTS.md:29`). |
| PM-01 overlaps U2 at 60–120 min | A statement only (`SUPERVISOR_MESSAGES.md:70,152`), no analysis on the branch. It follows from the definitions: U2 is 60–240 min (`docs/ARCHITECTURE.md:54`), PM-01 is 20–120 min (ARCH §3.3). |
| Relaxed U2 lost 10.6% (PR #267) | Confirmed in PR #267: −10.6% a $2 trade, CI −15.3% to −5.5%, 109 trades, 19% wins, on 22 Sep–2 Oct graduates (`PR267:research/edge-hunt-u2/report.md:9,26`). Those dates lie inside Zeroed's sealed holdout (B3). |
| Buying every graduate at hour 1 lost 22.4% | Confirmed with a nuance: rule R1 on 442 usable graduates (457 of 900 excluded), mean −22.4%, median −11.1% (`R:research/runner-probe/RESULTS.md:9-14,20-21`). |
| Hourly bars hid a one-swap crash; real-time trail sold at about 27×, not 130× | Confirmed on a partial run: real-time trail 27.48×, fill 26.65×, peak 100.4×, hourly fill 131.9× (`R:research/execution-audit/audit_results.json:27-28,35,101`; `R:research/runner-probe/RESULTS.md:63`). |
| Sizing is a floor-based risk layer for after an edge passes | Confirmed (`R:research/sizing/RESULTS.md:54-59`). |
| Short side not supported | Confirmed (`R:research/short-probe/RESULTS.md:9-11`). |
| Attention is used only as a reject rule | A plan, not a result: nothing is tested yet (`R:research/hype/RESEARCH.md:5`); a worse result would be kept only as a possible reject rule (`:79`). |

### Finished research

| Research | What it tested | Result | Meaning for MR-01, PM-01 and gates |
|---|---|---|---|
| Deep-pool probe | 5 pre-registered rules on 41 established coins in canonical PumpSwap SOL pools at ≥ 49,120 SOL cap (0.30–0.55% fee), 2026-07-22 to the wall 2026-09-21T14:00Z, 5-minute aggregator bars, $200 primary, 21 validation days (`RESULTS.md:6,10-20,29-32`) | All 5 not supported. Validation net per trade: MR-A −0.76%, MR-B −1.03%, MOM-C −1.68%, all CIs below zero (`:13-16`). 0.30% tier MR-A −0.17%, CI crosses zero; on the delayed-entry line −0.68% (`:19`). Gross bounce +0.1% to +0.6% against 0.85–1.0% round trip; most of it in the first 5 minutes (`:24-25`). Survivor-only coin list, so the true result is likely worse (`:26`). | MR-A and MR-B copy MR-01's two configurations (5 min, 3σ, −4%, 30 min; 15 min, 3σ, −5%, 60 min; ARCH §3.3). On vendor bars this is what CS-1 measures; ARCH M11 lets a coarser bar size reject. In the 0.30–0.55% group it would meet CS-1's stop rule; in MR-01's own ≤ 30 bps tier it would not (both CIs cross zero: MR-A 99 trades, MR-B 73). MR-01 is not killed, but its point estimate is negative. |
| Runner probe | Hour-1 entry after migration, held up to 14 days, −30% stop, trail after 2×; 900 coins created 2026-08-21 to 09-06, 442 usable; $10 in SOL (`R:research/runner-probe/RESULTS.md:9-14`) | Mean −22.4%, median −11.1%, win rate 2.9%; real-time optimistic line −7.9%; weekly 95% CI −26.1% to −8.7% from 4 weeks; shelved (`:20-27,46,62`). | Graduates bought at 60 min lose. PM-01's window (20–120 min) overlaps; PM-01's rule (breakout above the post-migration high, rising depth) is different and untested. |
| EDGE-HUNT-U2 (PR #267, open) | The owner's relaxed U2 rules on every PumpSwap graduate, 22 Sep–2 Oct, $2 trades (`PR267:research/edge-hunt-u2/report.md:9`) | −10.6% a trade, CI −15.3% to −5.5%, 109 trades (`:9,26`). | Evidence against the U2 family and the PM-01 overlap (60–120 min). Uses holdout-window days. |
| Execution audit (partial) | Runner exits replayed swap by swap from PumpSwap events, exploration coins only (`R:research/execution-audit/PREREG.md:1-4`); 72 targets (`R:research/SUPERVISOR_MESSAGES.md:154`) | 4 of 72 done: hourly fill 131.9× became a real-time 26.65× fill (`audit_results.json:35,101`). | Bar-level backtests can overstate exits. Supports Blueprint's stop-first intrabar rule and gate R (snapshot replay) and Zeroed's transaction-level backtest; a 5-minute coarse screen can only kill. |
| Sizing | R1/R2 trades (492 exploration, 442 validation) in SOL, plus a 10,000-path simulation (`R:research/sizing/RESULTS.md:6,43`) | Sizing cannot turn a loss into a profit (`:9`); the one positive line came from the 131× hourly fill and is −0.176 on the real-time fill (`:16`). Proposed: a trailing floor at 80% of peak, stakes capped at the surplus, only after pre-funding item 6 passes (`:54-59`). | A later overlay for §3.5 sizing (live only). It does not change any gate. |
| Short probe | Hyperliquid daily candles with funding (`R:research/short-probe/RESULTS.md:3`) | Not supported: S2 −0.26% a week, CI −0.85 to +0.32; S3 −0.58%, CI −1.1 to −0.07; S1 withheld for missing funding data (`:9-11,19,23`). | None; perps are outside the Blueprint (ARCH §1.2). |
| Hype note | Coins created 2026-07-22 to 08-20; 492 exploration coins (`R:research/hype/RESEARCH.md:5`) | Untested. Paid DexScreener profiles: mean −31.7% against +27.9% for the rest (`:30`). The note's own odds that attention helps: under 10% (`:159`). | At most a reject rule (an M06 soft check) after a validation test. Data source issue: see the pump.fun clash. |

### Probes still running

| Probe | Status | Evidence |
|---|---|---|
| Cheap-venue dip probe | Pre-registered and coded; no data and no returns committed | Commits `6033cd0c` (pre-registration) and `28ddd35a` ("synthetic candles only; no return computed"); no RESULTS file |
| Launch-delay probe | Collecting data; no returns | Commits `d7a1a02d` to `d5017ce2` ("listing and budget plan (no returns)"); `research/launch-probe/derived/` has listing, plan, samples and slot length only |
| Hype Test 1 | Pre-registered and coded; no data or results committed; result expected about the evening of 2026-10-08 | Commits `2349dfe2`, `473ccf95`, `6310b7f0`; `R:research/hype/RESEARCH.md:74` |
| Execution audit | Partial. 4 of 72 targets at `3b17c8bb` (`R:research/SUPERVISOR_MESSAGES.md:154`); the later snapshot `305ae388` holds 20 trades in `audit_results.json` (count only, not read) | Commits `3b17c8bb`, `305ae388` ("run in progress") |
| MR-01 1-minute screen (new) | Pre-registered as a kill-only screen and coded; no returns | Commits `2cf0c0f7` (Blueprint spec extract), `5ebb439e` (`research/mr01-screen/PREREG.md`), `7b162ed8` ("no returns computed yet"). This is CS-1 for MR-01 (A-M11-04); its result can only stop MR-01. |

Git shows only that none is finished. Whether any process is still running cannot be checked from the repo.

### What it means

- **MR-01:** the 5-minute proxies lose; in MR-01's own tier the result is negative but not significant. The 15 s signal and the "reversion to 6 h median" exit are untested. The bounce fades within 5 minutes (`RESULTS.md:25`), so 1 Hz polling may already be too slow. Phase 0 (A-24, A-24b) is still the first gate; the deep-pool probe is a strong prior that it fails.
- **PM-01:** no direct test. Its neighbours (relaxed U2, hour-1 runner) lost 10.6% and 22.4%. D08 already holds PM-01 to replay until B and R pass on post-BOOST data.
- **Gates:** nothing here passes any gate; vendor-bar and partial results can only kill. Every study used pre-wall or holdout-window data, so none can serve as a Blueprint `W_B` holdout.

## Known bugs

### Data and strategy

`SLOT_MS = 400`, H8 depth, holdout contamination.

| Bug | Where (file:line) | Blueprint carrier | Test that fails before the fix |
|---|---|---|---|
| B1. Slot time hard-coded at 400 ms | Six `SLOT_MS = 400` sites: `worker/src/run/config.ts:84` (timing guard, used at `worker/src/main.ts:52`, `worker/src/run/worker.ts:758`); `worker/src/engine/strategy.ts:1749` (dates pool updates from a block-time anchor, `:1774`); `worker/src/run/coverage-journal.ts:5` (gap lengths, `:62`); `backtest/src/sim/world.ts:61` (simulated landing times, `:96,177,196,257`); tests `backtest/test/study-world.ts:21` and `worker/test/read-coherent.test.ts:40`. Also: `backtest/src/sim/market.ts:420` (`lag * 400`), `core/src/engine/proofs.ts:190` (`msPerSlot = 400` default), `core/src/engine/runner.ts:23` (reconcile limits sized on 400 ms), `worker/src/run/settings.ts:50-52` (`maxSlotMs: 500`, comment says a 350 ms target), `backtest/src/research/outcome.ts:103` (1 s per slot, a conservative bound). | Live: M15 slot clock with the measured slot duration (I-08, group B) and M04 observation lag in slots (A-M04-02). Simulation: A-M10-04 attempt timing and A-M11-01 simulated clock. ARCH §1.5: "Never hard-coded". | Feed the strategy a block-time anchor at slot S and a pool update at slot S + 100 with consecutive anchors 250 ms apart; expect the update dated anchor + 25,000 ms. Today `#sampleAt` gives anchor + 40,000 ms (15 s late; up to 22.5 s at the 150-slot cap). Same shape for `World`: a landing 23 slots after decision must be dated with the measured slot time, not 9.2 s. |
| B2. H8 counts post-BOOST virtual SOL as depth | `core/src/gates/hard.ts:311` (`effective = quoteVault + virtualQuoteReserves`), valued in micro-USD at `:313-315`; `core/src/exits/value.ts:42-43` (`quoteReserve`, "SOL that can leave the market", is the effective reserve). No real-versus-effective check exists anywhere (grep). Only a sell above the real vault is refused (`core/src/amm/pump-swap.ts:157`). | A-M06-04 `min_depth` plus `real_vs_effective_quote` (≥ 0.5 MR, ≥ 0.6 PM, ARCH §8.4) in lamports; M21 `DEPTHPCT` on min(effective, real) (ARCH §8.1, group B). Price and impact stay on effective reserves (ARCH §2.1). | A pool whose real vault alone is below the floor and whose real + 17.58 SOL virtual is above it (the post-BOOST case, `R:docs/research/edge.md:225,230`) must reject. Today H8 passes it. A second case: `quoteReserve` on a drained pool (0.27 SOL real, 17.58 virtual) must return 0.27 SOL. |
| B3. Holdout contamination | Sealed holdout from 2026-09-22 to 10-20 (`core/src/config/research.ts:71`). H8, H9 and H11 thresholds cite `docs/research/empirical.md` (`docs/ARCHITECTURE.md:206-209`), whose backfill is 2026-10-01T23:00Z to 10-02T11:00Z (`empirical.md:35`) and live sample 2026-10-03 (`:53`), both inside the window. H9 applies to every universe (`hard.ts:320-328`). Found by `R:docs/research/edge.md:162` (§6.5.1; the base branch's `edge.md` has no §6). Further uses of holdout-window days: PR #267's relaxed-U2 study (22 Sep–2 Oct, `PR267:research/edge-hunt-u2/report.md:9`) and the ordered study of the 5 Oct live data (`CLAUDE.md` "Data study"). Zeroed's own docs disagree on the window: `docs/ARCHITECTURE.md:171` puts the holdout at 10-02 to 10-19. Not verified: whether the sealed ledger was ever opened. | A-M13-05 stage machine (`E_WINDOW_OVERLAP`) and A-M13-02 trial registry: every window used to set a threshold is registered as used, and a gate window that overlaps it is refused. Blueprint B-8's holdout is the last 20% of `W_B` on self-recorded data, so Zeroed's sealed holdout does not carry over. | Register the `empirical.md` windows as used; a holdout scoring call with entries from 2026-10-01T23:00Z to 10-03T23:59Z must refuse or exclude them. Today the holdout config has no record of threshold-source windows, so it accepts them. |
| B4. Helius credits burned at about 80k an hour with zero trades | `HANDOVER.md:281-284` (§5.2): boot `3ee09a5a` used 305,033 credits in 3 h 31 min (about 87k an hour; earlier boots 49–62k). The code's monthly budget is still the free plan's 1M (`worker/src/scheduler/limits.ts:15`), so it would run out in about half a day and halt entries. Causes in code: a confirmed `logsSubscribe` per watched pool on metered Helius (`worker/src/run/pool-watch.ts:108-111`), P3 candidates watched past any chance of entry, rates at 100% of the provider limit (`limits.ts:11`). Usage cut still open (#250). | A-M14-02 (buckets ≤ 50%, unmetered pinning), A-M14-05 (burn-rate projection, `degraded_reads`), A-M04-01 (1 Hz polling on an unmetered provider), A-M05-02 (watchlist cap from the budget). | Replay a recorded hour of the 7 Oct candidate flow through M04, M05 and M14 with the credit meter on: projected month-end use must stay ≤ 80% of the configured plan and the projection alert must fire before 80% is used. On Zeroed's feed the same hour costs about 87k credits (HANDOVER figure), above a 1M-a-month pace of about 1.4k an hour. |
| B5. Fake 17.8% paper edge | `ops/host-config.json:9` (`ZEROED_PAPER_EDGE_PPM: "178092"`, shakedown block) at the base; parsed in `worker/src/run/config.ts:114-166` (paper and S0 only); used by the cost gate `core/src/costs/index.ts:340-348`, which admits an entry only when `edgePpm` exceeds cost. The value is the smallest edge that lets a first S0 trade pass (`docs/DECISIONS.md:1782-1787`), not a measured edge. #268 at `25c4d9bf` removes it from `ops/host-config.json` (checked: no `EDGE` key there), but the code path stays. | M09 `sizing` and `StrategyContext.edgeEstimate`: an edge comes only from M13's lower CI bound (ARCH §3.5, §5.0a); A-M12-01 paper; A-M13-04. | Config validation (B-M25 schema) must reject any key that sets an edge, in every mode; and a paper entry with no M13 edge estimate must not size above fixed notional. Today `parseConfig` accepts `ZEROED_PAPER_EDGE_PPM=178092` in paper S0 and the cost gate then admits entries it would refuse at 0 (#268's own control: `HANDOVER.md:632`). |

Slot time check for B1: the owner's 250 ms is confirmed. `docs/blueprint/FACTS.json:987` (LD-08, verification confirmed): 250 ms target since epoch 1037 (2026-09-18), about 266–267 ms measured on 2026-10-06, 200 ms scheduled at epoch 1052. Zeroed's own measurement agrees: mean 267 ms on 2026-10-04 (`docs/RESEARCH.md:74`). The fix measures the slot time; it must not hard-code 250 ms either.

### Money

Risk core in micro-USD (#197).

_Filled by MIGRATION-B._

## Operations

_Filled by MIGRATION-B._

## Clashes for the owner

### Data and strategy

Owner rules are quoted from `CLAUDE.md`. Where the owner rule and the Blueprint differ, the owner rule stands until the owner decides (`CLAUDE.md` "Blueprint"). Each recommendation takes the stricter side unless it says otherwise.

#### Pre-funding gate

| Owner item (`CLAUDE.md` "No deposit before proof") | Blueprint (ARCH §3.4) | Conflict | Recommendation |
|---|---|---|---|
| 1. 10 replays give identical decision logs | Determinism is a module rule (§5.0; bit-identical features, SPEC-A line 1409), but no gate counts replays | Missing in the Blueprint | Add to A-M11 acceptance; Zeroed's test exists (`core/test/engine.test.ts:319`). |
| 2. ≥ 30 days (target 60) of survivorship-free history, transaction by transaction, same engine | `W_B` ≥ 30 days of self-recorded M07 data, 15 s bars (B-1..B-8); a reserves-carrying dataset is allowed (line 370). Earliest live-small about 65 days after recording starts (line 384) | Bar level against transaction level; self-recording means waiting, which the owner replaced with history on 2026-10-03 | Keep both: Blueprint B gates, run at transaction level where history exists. Zeroed's archive may serve `W_B` only for days that are not holdout-contaminated (B3). New history downloads are limited by the carried rule "no bulk historical downloads" (see below). |
| 3. Live dry run ≥ 48 h, ≥ 99% uptime, restart and disconnect drills | `W_P` ≥ 21 days; P-5 ≥ 99% market-data availability; P-7 kill drill | The Blueprint is longer; it measures data availability, not process uptime | Keep both measures; the Blueprint's 21 days covers the 48 h. |
| 4. ≥ 95% of paper legs simulate successfully, amounts within tolerance | P-6: ≥ 50 buys and ≥ 50 round trips, median error ≤ 30 bps, p90 ≤ 100 bps; sells only as round trips | No success-rate floor in the Blueprint | Add "≥ 95% simulate successfully" to P-6. |
| 5. Fault injection: timeouts, stale feeds, rate limits, mid-trade restarts | P-7 kill drill; ARCH §16.5 failure-injection tests, which are build tests, not a promotion gate | Not a gate in the Blueprint | Make the owner's cases a P gate item, run on the build that is promoted. |
| 6. Fixed rules, walk-forward, untouched holdout with ≥ 300 out-of-sample trades, 95% CI above zero, 80% power; dry run consistent | B-1 ≥ 300 trades across `W_B` (selection included); B-8 only "positive" in the last 20% of `W_B`, no count or CI; R ≥ 200 trades; P-3 consistency | The Blueprint's holdout is smaller and has no CI or power test | Require ≥ 300 holdout trades with CI lower bound > 0 and 80% power on top of B-1..B-8. In practice this means a longer `W_B` or counting R and P trades as the holdout. |

#### Other clashes

| Blueprint item | Owner rule | Conflict | Recommendation |
|---|---|---|---|
| Trade count: MR universe unknown (A-24), `ENTRYRATE` ≤ 1 MR entry per 10 min (§8.1), "most likely outcome … the paper-trading gate fails" (§0) | "Trade more, from evidence": about two paper trades a day | The Blueprint may trade near zero (default-reject, tiny universe). Also at 2 trades a day and $10, fixed cost alone adds 200 bps a trade (§2.4 table) | Use the owner's target as a Phase 0 measure (signals per day per A-24/A-24b). Never loosen to reach it without B and R evidence; this agrees with the owner's own "never loosened blindly". The deep-pool proxy made about 12 trades a day (266 in 21 days, `R:research/deep-pool-probe/RESULTS.md:13`) and lost, so frequency is not the blocker. |
| Shadow paper trades of a strategy before `replay_passed` (§3.4 line 372); D08 sends effort to PM-01 if MR-01 fails | "No knowingly losing trades … not even as practice" | MR-01's closest proxies lost (CIs below zero outside its tier, negative point estimates inside it); PM-01's neighbours lost 10.6% and 22.4% | No shadow paper trades for MR-01 or PM-01. Both may run only in backtest and replay with their pre-registered configurations; paper only after `replay_passed`. Register the deep-pool probe as MR-01's coarse screen (CS-1) with the owner's ruling. |
| Sizes: C-01 capital < $1,000; tables at $5–$50 (§2.2); `MAXPOS` ceiling 0.35 SOL (§8.1) | "Size is not the trial": report $5, $20, $100, $1,000, $10,000 with gross, fixed, percentage fees and impact from real depth shown apart | Blueprint stops at $50 and caps capital | Keep the ceilings as config (the owner raises them). Add a size sweep to A-M10-03 / A-M13-04 reports with the four cost parts apart and impact on min(real, effective) depth. Note: at $10,000 (about 67 SOL at $150) the 0.5% `DEPTHPCT` cap needs about 13,300 SOL of quote; how many pools have that is not verified. |
| MR-01 universe: ≤ 30 bps, ≥ 300 SOL depth, age ≥ 24 h (cap ≥ 98,240 SOL on PumpSwap) | Zeroed's U2 (graduates 60–240 min) is the live strategy | Disjoint universes. U1 (24 h–14 d, $50k, fee ≤ 1.15%) is the nearest but wider and USD-based | The Blueprint universe replaces U2 under the Blueprint ruling; U2's own research is negative (PR #267). Keep Zeroed's stricter holder and authority rules inside M06. |
| PM-01 entries 20–120 min after migration | Zeroed H10: no entry before migration + 60 min (`core/src/config/policy.ts:221`), Zeroed's §3.1 (`docs/ARCHITECTURE.md:208`) | H10 is Zeroed design, not an owner rule; listed because it removes half of PM-01's window | Keep H10 for any PM-01 test until replay on post-BOOST data shows otherwise. |
| Phase 0 recording (30 pools at 1 Hz, daily `getProgramAccounts`, vault reads every 6 h, eviction tails) and new providers (Shyft, Chainstack, DexScreener, CoinGecko) | "No extra data spend before the bot can trade"; only the owner approves new providers (`AGENTS.md`) | The Blueprint needs recording before any trade; that is the spend the owner paused | Run Phase 0 only on free, unmetered quota with a hard cap. New providers need the owner's approval, even free ones. Do not use the Helius Developer headroom. |
| M14 send buckets at 80% of documented limits (ARCH M14 line 1191, I-04) | Carried rule: every external read at ≤ 50% of the documented limit; honour `Retry-After`; stop after 3 failures | 80% > 50%. Zeroed today runs at 100% (`worker/src/scheduler/limits.ts:11,31,57`) | Set every M14 bucket to ≤ 50%. Shyft's 10 req/s gives 5 req/s, still above M04's need (30 pools × 3 accounts at ≤ 90 per call is about 1–2 calls a second). Sends are group B's call; reads are A-M14-02. |
| Coarse screens on CoinGecko or Birdeye; history kept only from self-recording (D17) | Carried rule: "no bulk historical downloads; fetch only the minimum sample a test needs"; and pre-funding item 2 asks for 30–60 days of history | Two owner-side rules pull apart; the Blueprint sides with the carried rule | Reuse data already held (DATA-1 days that are not contaminated, research data). Any new download needs the owner. |
| `REGIME` blocks MR entries when SOL/USD falls > 3% in 30 min (§8.1); P-2b converts fixed cost at SOL/USD | "Profit is counted in SOL … a SOL/USD move alone must never … trip a limit" | `REGIME` is listed as a limit and trips on SOL/USD | It only blocks entries (tightens), so keep it, but put it to the owner. Use the SOL-denominated basket return as the main test. The P-2b conversion is fine (the server bill is in USD). Zeroed's own H8 floor and risk book are in micro-USD and break this rule today (`hard.ts:315`, `core/src/risk/types.ts:96`). |
| Leak test and live-replay parity | "Backtests are blind and reproduce live": a planted-marker leak test and a parity test are required | SPEC-A has no leak or parity criterion (no match for "leak" or "parity") | Add both to A-M11 acceptance. Carry Zeroed's proofs (`core/test/engine.test.ts:364-375`, `worker/test/parity.test.ts`). |
| pump.fun Terms §21(h) | Make no new pump.fun requests (`R:research/SUPERVISOR_MESSAGES.md:82`) | No module in M01–M14 calls a pump.fun-run server. To confirm: A-M03-01 uses PumpPortal (`wss://pumpportal.fun`), a third party; whether pump.fun's Terms reach it is not verified. A-M02-01 pins IDLs from GitHub `pump-fun/pump-public-docs`, and A-M02-06 tests use `@pump-fun` SDK packages from npm: not pump.fun requests, but a new dependency needs the supervisor. Whether §21(h) covers a bot trading pump programs on chain is not verified; the Terms text is not in the repo and I made no request. Zeroed's code makes no pump.fun request and sends an honest `user-agent` (grep). Hype Test 1's universe and callouts came from scripted pump.fun access with forged Origin and Referer headers (`R:research/hype/TEST1_DESIGN.md:70`). | Keep the rule: no pump.fun-run endpoint in any module. Put PumpPortal and on-chain trading under §21(h) to the owner. Use no hype Test 1 result in a gate until the owner rules on that data. |
| Helius §3.2(xi) (lawful business purpose only) | Open with the owner (`HANDOVER.md:555`; `R:research/SUPERVISOR_MESSAGES.md:83`) | D04 uses Helius Free (priority fees, Sender, D30's 10-credit `getProgramAccounts`, metered fallback). Zeroed runs every stream on Helius | Spend nothing new on Helius until the owner answers. Build M14 so Helius can be dropped (Shyft, Chainstack, Alchemy for reads). Sender is group B's. |
| D04 default: free tiers only; Helius Developer only when equity ≥ about $2,033 | The owner already holds Helius Developer (`CLAUDE.md` "No extra data spend") | The owner's purchase is outside D04's trigger | The owner's decision stands; record it in D04. Its headroom stays unused until the bot can buy without a blocker. |

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
