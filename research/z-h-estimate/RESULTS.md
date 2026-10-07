# Z-H credit estimate: 30 (target 60) days of history for the B-10 replay

Researcher card Z-H. Round 1: 2026-10-07 (`db3050b3`). **Round 2: 2026-10-07 UTC (8 Oct Melbourne), answering the
review and red team in `docs/reviews/ZH.md` at `9f31f1ae` and the supervisor's rulings 1–12.**

**No Helius call was made in either round.** Every figure comes from data already held, from official documentation
fetched on 2026-10-07, or from small keyless samples on the public Solana RPC (round 1: 73 + about 300 calls; round 2:
283 calls for the slot grid), each at one request every 2 s, honouring Retry-After and stopping after 3 failures.

Labels: **MEASURED** (counted from data), **DERIVED** (arithmetic on measured or documented numbers), **ASSUMED**
(judgement), **VERIFY** (not confirmed; check before relying on it).

## 0. Round-2 changes (supervisor item → section)

| Item | What changed | Section |
|---|---|---|
| 1 Per-day re-estimate | Slot grid measured per day; units with the ±1 h margin; skip rate; retry overhead and the determinism rescan from 09-21; candidate windows compared; per-day caps that sum to the global cap | §3 |
| 2 Spend-safety preconditions | "Z-H prep" code card: 13 preconditions with files and tests; the throughput measurement with its own cap | §7 |
| 3 Storage and where it runs | Sizes per day and in total with raw records for the universe; runner, store, replay streaming; owner decisions as hard preconditions | §6 |
| 4 Shared key | Every known consumer; the 7 Oct 126k; separate key or project | §8 |
| 5 Pre-window state | Per gate: state needed at window start and its source; costs; MR verdict | §5 |
| 6 Same engine code | Raw records for every canonical-pool transaction (sample 1.0 for the universe), storage re-costed | §6 |
| 7 Viewed windows | 09-21 reuse dropped; full viewed-window list; MR-01 registration timing | §2 |
| 8 Free checks | pump_fees admin transactions are NOT kept; virtual reserves ARE kept (in every swap event) | §4 |
| 9 Terms | §3.2(ii), (iv), (xi) and §6.2 quoted; the owner's question | §9 |
| 10 Old Faithful | Compared on credits, time, storage, parity, politeness and the no-bulk rule | §10 |
| 11 Minor fixes | MB per block (3.0, decompressed); 09-21 never finished; "regime B3 (regimes.json)"; PM 30.5M; cap exit code 3; MIGRATION Z-H wording (Z0D PR #286) | §3, §11, §2 |
| 12 Owner summary | Rewritten, 6 lines | end |

## 1. Bottom line

- **Not ready to spend.** No credit may be spent until all of §7's preconditions hold, among them: a strategy has
  survived Phase 0 and the owner has ruled on C-76 (Z0D `docs/blueprint/ARCH.md:458` and `:1719` on
  `claude/z0d-blueprint-docs` @ `53ab0d64`); the owner has answered the Helius terms question (§9) and decided storage
  (§6); the Z-H prep code is built and reviewed (§7); and no other Helius consumer runs during the pull (§8).
- **Recommended window: the 30 UTC days 2026-07-23 to 2026-08-21, plus a 1-day lead-in (2026-07-22).** It is the
  cheapest clean post-BOOST window, because its slots are about 420 ms, against about 267 ms by late September.
- **Credits: about 7.74M (point), 9.00M upper bound (DERIVED, §3).** **Proposed global cap: 9,000,000**, as the sum of
  per-day caps (each day's upper bound, 286,939 to 315,070). That leaves at least about 0.87M of the cycle's 10M, if
  the 7 Oct reading of about 126k used is still right (VERIFY, §8).
- **If the cap stops the pull early,** every finished day is kept, but only if the durable store of §6 exists (a
  precondition). The missing days are read after the cycle resets on 6 Nov. Without that store, credits would be lost
  to cache eviction (RT-03), which is why storage is a hard precondition.
- **Round 1 was too low:** its window (08-23 to 09-21) costs about 10.0M to 10.4M point and 12.1M upper, more than one
  cycle, because slot time fell inside it (F1/RT-01).
- **60 days** (every clean post-BOOST day, 07-24 to 09-21, plus lead-in) cost about 17.8M point and 20.7M upper: two
  cycles at least.
- **Time** is unproven. At the only measured rate (5 blocks/s on Free) the reading alone takes about 17 days; at
  25 blocks/s (half the Developer limit) about 3.3 days. The prep card's throughput measurement settles it.
- **What it proves:** robustness only (owner item 2: zero crashes, illegal states or unreconciled intents through
  the same engine). The window has been viewed by earlier studies, including MR-01's exact configurations, so it can
  never be evidence of an edge or an item-6 holdout (§2).
- **MR universe:** holder gates cannot be evaluated honestly in history for old pools, so MR entries fail closed and
  an MR B-10 would be vacuous unless a ruling says how the replay treats those gates (§5). PM-01 can be replayed.

## 2. Window, regimes and viewed windows

**Clean span.** Post-BOOST (regime B2, 2026-07-21 14:23Z) and before Zeroed's sealed holdout (MIGRATION B3,
2026-09-22 to 10-20; Z0D `B3_CONTAMINATED` 2026-09-22T00Z to 10-21T00Z, SPEC-A:2247 per the review). Every past day is
outside any future `W_R`, which comes from forward M07 data. So the clean span is 2026-07-22 to 2026-09-21.

**Regime breaks inside the clean span** (`research/historical/regimes.json`, plus the slot-time changes):

| Date (UTC) | Break | Effect on the pull or the replay |
|---|---|---|
| 2026-08-21 (epoch 1020) | Slot time target 350 ms (SIMD-0525, FACTS LD-08) | More blocks a day (§3) |
| 2026-08-28 (epoch 1024) | 300 ms | More blocks a day |
| 2026-09-09 19:30 | **Regime B3 (regimes.json)**: fee and creator-fee config changes | Fees differ before and after; read from events (§4) |
| 2026-09-12 15:24 | Regime B4 (regimes.json): BuyEvent and SellEvent grow 16 bytes | Decoders must accept the dated pre-B4 layout (`pre_layouts`) |
| 2026-09-18 (epoch 1037) | 250 ms | About 1.6× the blocks of a July day |

"Regime B3 (regimes.json)" above is not the MIGRATION B3 holdout-contamination bug. The recommended window
(07-23 to 08-21) lies wholly before regime B3 and B4 and wholly in the ~420 ms era, ending on the first 350 ms day.
Its trade events use the pre-B4 37-field `BuyEvent` / 30-field `SellEvent` layout (`regimes.json` `pre_layouts`).
That layout still carries `virtual_quote_reserves` and the fee basis points: DERIVED from the current IDL
(`rpcscan/idl/pump_amm.json`, which lists only the two holder-reward fields after them). **VERIFY** on a decoded
July unit.

**Post-BOOST: required.** PM-01 is defined on post-BOOST data only (ARCH §3.3), and R-1 asks for post-BOOST data. The
lead-in day 07-22 is after BOOST.

**Viewed windows (A12 ledger entries; every candidate window is viewed):**

| Study | Dates | Touches |
|---|---|---|
| RS-40 MR-01 1-minute screen (C-76, KILLED, owner pending) | entries 2026-07-22 to 09-21T14:00Z, discovery before 08-21, validation after (`research/mr01-screen/PREREG.md:11,19` on `ccr-7fae2302-drz4co`) | **MR-01's exact two configurations** |
| Deep-pool probe RS-01 (MR-A, MR-B, MOM-C) | 2026-07-22 to 09-21 | MR family |
| RS-31 lottery basket | 2026-07-22 to 08-20 | PM-01's universe (graduates) |
| RS-24 hour-1 runner | graduates 2026-08-21 to 09-06 | PM-01's universe |
| U1 / U1-B | walk-forward 2026-08-17 to 09-11; holdout 09-12 to 09-21 (HANDOVER:615) | graduates |
| BT-2 practice days | 2026-08-03 to 09-21 | all |
| Daily probe | 2026-06-01 to 09-20 | deep pools |
| Execution audit | coins created 2026-07-22 to 08-20 | PM-like graduates |

**MR-01 registration timing.** MR-01's two configurations first appear in this repo at `5d7260f7`
(2026-10-07T10:26Z, the Blueprint import). The deep-pool probe was pre-registered at `67290f1c` (2026-10-06T18:58Z),
with its result at `e8e45fc4` (22:04Z). `docs/research/edge.md` cited the Blueprint artifact at `3bea559c`
(18:33Z), 25 minutes before the probe's pre-registration, and the probe's MR-A equals MR-01's first configuration. So
MR-01 was probably fixed before the probe, but the artifact's own version history is **VERIFY**. Either way, RS-40 ran
MR-01's exact configurations over the whole clean span, so for MR-01 the span is in-sample on vendor bars. **B-10 on
any of these days is a robustness check (owner item 2), never evidence of an edge and never an item-6 holdout.**

**09-21 reuse dropped.** MIGRATION A02 says data collected before 2026-10-07 serves research only, never a Blueprint
gate. In any case 09-21 never finished: 56, then 66 of 79 units were cached (HANDOVER:1379, :1285, :1227), and the recommended
window does not include it.

**MIGRATION Z-H wording.** "No new download and no new credits" (MIGRATION:810 on the supervisor branch) is replaced
by the owner's 8 Oct rule in Z0D PR #286 (`docs/MIGRATION.md:823` on `claude/z0d-blueprint-docs` @ `53ab0d64`).

## 3. Credits per day (item 1)

**Method (`estimate.py` on `slot_grid.json`).**
- **Slot grid (MEASURED):** 141 points from slot 433,400,000 to 450,200,000, one every 120,000 slots. Each point has
  the block time of its first produced slot, and `getBlocks` over the next 2,000 slots gives the skip rate. 283
  keyless calls (`slot_grid.py`).
- **Units per day (DERIVED, as the planner):** every 4,500-slot unit whose time reaches
  [day − 3,600 s, day + 1 + 3,600 s) (`rpcscan/main.go:302`, margin = 2 × 4,500 × 0.4 s). Units are epoch-aligned,
  and 432,000 / 4,500 = 96, so they align to multiples of 4,500.
  - Check: the model gives **79 units for 2026-09-21, equal to the measured plan** (HANDOVER:1227).
  - Margin units are re-read by adjacent days, so they are counted per day.
- **Credits per unit:** 1 per produced block (`getBlock`) plus 1 `getBlocks`, plus 1 rescanned unit a day for the
  determinism check (`check-day.sh`).
- **Skip rate (MEASURED):** produced/planned is at least 0.990 on every grid window from July to September, and 1.000
  on most. Skipped slots barely lower the cost.
- **Retry overhead:**
  - Point: **7.6%**, MEASURED on 09-21. 66 units cost 319,730 credits (HANDOVER:1221, :1285) including retries at rps 3 and 5 on Free, against
    4,501 per unit base.
  - Upper: **25%**, ASSUMED, above the largest measured share of 18% (09-21 at rps 5, HANDOVER:1379). The pilot
    measured 12% (625 of 5,225).
  - Retries on Developer at higher rates are unmeasured. The throughput measurement (§7, P10) settles them, and the
    per-day caps bound them.
- **Upper bound (DERIVED):** every planned slot produced, plus 25% retries, plus the rescan unit. Retries above 25%
  cannot pass it: the per-day cap stops the day.

**Per regime (DERIVED from the grid):**

| Slot-time regime | Days in clean span | Measured mean slot | Units a day | Credits a day, point | Upper (max day) |
|---|---|---|---|---|---|
| 400 ms target (to 08-20) | 29 | 420.1 ms | 50–51 | 248,724 | 292,565 |
| 350 ms (08-21 to 08-27) | 7 | 368.0 ms | 55–58 | 282,318 | 331,949 |
| 300 ms (08-28 to 09-17) | 21 | 317.9 ms | 61–67 | 326,946 | 382,585 |
| 250 ms (09-18 to 09-21) | 4 | 269.2 ms | 76–79 | 383,918 | 450,100 |

**Candidate 30-day windows (2-day lead-in unless stated; all in `estimate.json` `windows_30d_leadin2`):**

| Window | Point | Upper | Note |
|---|---|---|---|
| **07-23 to 08-21, 1-day lead-in (recommended)** | **7.74M** | **9.00M** | Cheapest; one cycle |
| 07-23 to 08-21, 2-day lead-in | 7.98M | 9.28M | +1 lead-in day covers about 1% more PM mints (§5) |
| 08-02 to 08-31 | 8.48M | 9.86M | |
| 08-12 to 09-10 | 9.30M | 10.81M | Above the cycle's credits at the upper bound |
| 08-23 to 09-21 (round 1's) | 10.38M | 12.06M | Does not fit one cycle |
| 60 days 07-24 to 09-21 | 17.84M | 20.74M | Two cycles at least |

**Caps (proposed).**
- **Per-day caps:** each day's upper bound from `estimate.json`, from 286,939 to 315,070.
- **Global cap: 9,000,000.** That is the sum of the per-day caps (8,996,378), rounded.
- The prep card's throughput measurement has its own cap (§7, P10). MR-only pool-age and config lookups add at
  most about 25k (§5).
- The cycle has about 9.87M left by the 7 Oct reading. **VERIFY** before the start: the execution audit of 7 Oct
  (63,124 calls, about 63k credits at the documented 1 credit a call) may or may not be inside that reading (§8).

**Time and transfer (DERIVED).**
- Blocks to read: about 7.19M, including the rescans.
- Reading time: at 5 blocks/s (the only measured rate, Free) about **16.6 days**; at 25/s about **3.3 days**; plus
  about 45 minutes a day of QA and packaging (about 23 h).
- `RPC_CONC` defaults to 4 (`ci/rpc-day.sh:58`), so throughput is about 4 divided by the `getBlock` latency;
  25 blocks/s needs a latency of 160 ms or less (unmeasured).
- Transfer: about 3.0 MB per block, the RPC pilot's figure, decompressed (`helius.go` counts bytes after
  decompression; session_01XHH3k24fjmkpmmt28xSaYv.md:31). That gives about **21.6 TB decompressed**. The wire size with
  compression is **VERIFY**. Helius bills RPC per call, not per byte (the per-MB rates on the credits page are for
  streaming products only), so transfer is a runner and time question, not a credit one.

## 4. Free checks on the DATA-2 filter (item 8, from code)

- **pump_fees admin transactions are NOT kept.** `rpcscan/scan.go:761-780` keeps a transaction only when an
  instruction runs the pump (`6EF8…`) or PumpSwap (`pAMMBay6…`) program. Changes to the pump_fees `FeeConfig`
  (`pfeeUxB6…`, `research/edge/snapshot/fee-configs.json:4`) do not touch either, so they are dropped.
  - Swap events carry the fee basis points actually charged (`lp_fee_basis_points`, `protocol_fee_basis_points`,
    `coin_creator_fee_basis_points`; IDL `rpcscan/idl/pump_amm.json`), so realised fees are kept.
  - The tier table and its change times are lost. Gate `fee_config_known` (ARCH §8.4: "decoded and unchanged within
    the last 10 min") needs them.
  - Fix, before the pull: either add pump_fees to the filter (a scanner change, frozen afterwards; P12) or read the
    FeeConfig PDA's history with `getTransactionsForAddress` (a handful of transactions; at most about 1k credits).
- **PumpSwap `GlobalConfig` admin changes** (`disable_flags`, gate `venue_enabled`) run the PumpSwap program, so the
  transaction is kept. Whether its event becomes a row is **VERIFY**: rows keep "every event of every mint", and
  config events are not per mint. Same fix as above.
- **Virtual reserves ARE kept.** Every `BuyEvent` and `SellEvent` carries `virtual_quote_reserves` (IDL), and
  `InitBoostEvent` moves quote into it (`docs/research/historical-data.md:138`). Every canonical-pool trade is kept
  (`retention` = `canonical-all`, `:94`). So a pool's virtual reserve is known from its first in-window swap.
  Reserves in PumpSwap events are pre-swap (MIGRATION A08); round 1 wrongly said "after".
- No cached unit was available to this session (the 09-21 cache is in GitHub's Actions cache), so these checks are
  from code only. **VERIFY** on a decoded unit in P12's test.

## 5. Pre-window state per gate (item 5)

| Gate (ARCH §8.4) | State needed at window start | Source in the pull | Gap and cost |
|---|---|---|---|
| `top10_holders`, `single_holder` (hard), `creator_balance` (soft) | Every holder's balance of the mint | Movements from the first scanned block on. Lead-in days carry no movements in DATA-1 (`historical-data.md:164`), so a Z-H loader must read movements from the lead-in too | **PM:** mints created inside lead-in + window are complete. By Jupiter's off-chain `createdAt` for 518 graduates of 1–2 Oct (held data, research use only, **VERIFY**), 2.5% were created more than 24 h before graduation, 1.5% more than 48 h. So a 1-day lead-in leaves about 2.5% of PM mints unresolved, and they fail closed. **MR:** pools are at least 24 h, often months, old; their holder state cannot be rebuilt (see below) |
| `pool_age` | Pool creation time | `CreatePoolEvent` if inside lead-in + window; else one `getTransactionsForAddress` (signatures, ascending, limit 1) per pool, 10 credits | PM: in the blocks. MR: pools that reach ≥ 98,240 SOL in the window, about 100 to 2,000 (ASSUMED) → **1k to 20k credits** |
| `fee_ceiling`, creator-fee config (A08) | Fee bps in force | Every swap event | None after the pool's first in-window swap |
| `fee_config_known` | FeeConfig change history | Not kept (§4) | P12, ≤ about 1k credits |
| `venue_enabled` | GlobalConfig `disable_flags` | Kept as transactions; rows **VERIFY** (§4) | P12 |
| `min_depth`, `real_vs_effective_quote` | Vault reserves and virtual reserve | Every swap event (pre-swap reserves, virtual reserve) | None after the first in-window swap |
| `mint_authority_none`, `freeze_authority_none`, `t22_*`, `metadata_*` | Mint account state | Create transaction (raw record kept for every create) | PM: covered. MR: the mint is older than the window, so its authorities need one mint read. Today's account is look-ahead; at most a `getTransactionsForAddress` on the mint (10 credits) finds authority changes. **VERIFY** |
| `honeypot_sim` | A simulation | Not possible in history | Replay rule needed (the replay cannot simulate past state) |
| `dump_flag` | 30 min of returns | Lead-in | Covered by a 1-day lead-in |

**Why MR holders cannot be rebuilt.**
- `getTransfersByAddress` (10 credits per request of up to 100 transfers, Developer plan or higher;
  [docs](https://www.helius.dev/docs/rpc/gettransfersbyaddress)) takes an **owner wallet**, not a mint ("Pass the wallet
  owner address, not an associated token account"). It cannot list a mint's holders.
- `getTransactionsForAddress` on the mint misses plain SPL `Transfer` instructions, which do not name the mint
  account. Whether wallets and PumpSwap use `TransferChecked` is **VERIFY**, so completeness cannot be shown.
- Reading every block back to each MR pool's creation, often months, is far past any cap.
- Today's holder list (`getProgramAccounts`) is look-ahead and not allowed.

**MR verdict.** In an honest replay, MR's hard holder gates are unknown for every MR pool, so they fail closed and MR
makes zero entries. An MR B-10 would then show "no crash" on a run that never trades, which is meaningless. If the
selected strategy is MR-01, B-10 needs a supervisor or owner ruling first, for example a replay mode that records the
holder gates as "not evaluable in history" and proceeds. That mode would be a replay-only exception to fail-closed
checks, so it is not mine to decide. PM-01 can be replayed with real gates, with about 2.5% of mints failing closed.
B-10 replays "the selected configuration" (ARCH:458), so the replayed universe is that strategy's. The pull itself is
the same for both.

## 6. Storage, where it runs, and the same engine code (items 3 and 6)

**Same engine code.**
- CI scans at `-sample 0.05`. Raw records, the input to the engine's own decoder, are kept only for hash-sampled
  mints, creates and migrations (`historical-data.md:166`). The rest reach the replay as Go-decoded rows.
- Plan: keep a raw record for **every canonical-pool transaction** (successful and failed), plus every create and
  migration, so the engine's own decoder reads every swap the PM and MR strategies trade on. Canonical-pool
  membership is decided from the transaction itself (`historical-data.md:94`), so it never depends on the future.
- Curve-phase holder movements stay Go-decoded rows. They are only needed for holder rebuilding, and parity covers the
  sample. A ruling is needed if that is not acceptable (I make none).
- This is a scanner change, made before the pull and frozen (P11).

**Sizes (DERIVED, about ±2×; October activity used for July and August, which is VERIFY):**

| Part | Per day | 31 days | Basis |
|---|---|---|---|
| Rows (curve, canonical pools, movements) | 3.1 to 4.8 GB | 96 to 149 GB | `historical-data.md:165,230` |
| Raw records, every canonical-pool transaction | 14 to 40 GB | 0.43 to 1.24 TB | ≥ 9.3M canonical trades a day (2 Oct, `:94`) × 1.5 to 2 for failed transactions (recording §7 of round 1: failures 26–51% of all) × about 1 KB a record (creates: about 51k for about 50 MB, `:166`) |
| Raw records, MR universe only (if MR is selected) | 0.2 to 8 GB | 6 to 250 GB | 20 to 60 deep pools × about 7k to 90k transactions (round 1 sample) × about 1.5 for failed transactions × about 1 KB |
| **Total (raw for every canonical pool)** | **about 17 to 45 GB** | **about 0.5 to 1.4 TB** | |

**Where things run and live.**
- **Pull:** GitHub-hosted runners in this repo (public, so minutes are free): 4 CPU, 16 GB RAM, 14 GB documented SSD
  (`historical-data.md:219`). It reads one day and one unit at a time, and moves each finished unit's files off the
  runner before the next. The cache-only path cannot hold this: one day is larger than the 10 GB Actions cache (RT-03).
  Never on the 2 GB / 55 GB host (D29, CA-26).
- **Store:** releases on the private data repository (DATA-STORE #150). GitHub releases allow at most 2 GiB per asset
  and 1,000 assets per release, with no stated total-size or bandwidth limit (supervisor-verified, HANDOVER:1883).
  So a day becomes one release of about 10 to 25 assets.
  - **Hard precondition 1, owner:** DATA-STORE's three steps (the private repo, a fine-grained token, the secret and
    variable).
  - **Hard precondition 2, owner:** a DATA-PUB ruling that lets Helius-derived units, which carry raw `getBlock`
    responses, go to that private repo. DATA-PUB today allows the Actions cache only (`historical-data.md:317`), and
    the ruling depends on §9.
- **Replay:** a separate job on a GitHub-hosted runner (A-M11-01's new loader, D29: off the live host).
  - Per day it downloads one release asset at a time, checks its sha256, feeds it to the engine and deletes it. The
    engine's state carries across assets and days through a checkpoint.
  - Logs in this public repo must print aggregates only, never rows.
  - The loader must not inherit DATA-1's `finalize -lead-in-days 14` rule: 14 more days would add about 3.5M credits.

## 7. Spend-safety preconditions: card "Z-H prep" (item 2)

Built and reviewed before any spend. Each item lists the file to change and the test that must fail before and pass
after.

| # | Precondition | File | Test |
|---|---|---|---|
| P1 | **One cross-day ledger, persisted outside the Actions cache, checked before every run and fail-closed.** It stores the frozen revision, the global cap, the per-day caps and the credits booked per day, in a file on a branch of the private data repo. Before each run it also reads Helius's own count (`GET https://admin-api.helius.xyz/v0/admin/projects/{id}/usage`: `creditsUsed`, `creditsRemaining`, per-product credits; [docs](https://www.helius.dev/docs/api-reference/admin/get-project-usage)). It refuses when booked + the day's cap > the global cap, when Helius's `creditsUsed` has grown by more than the ledger booked plus a stated tolerance (another consumer, §8), or when `creditsRemaining` < the reserve. Any read or write error refuses | new `research/historical/ci/zh-ledger.sh`; `ci/rpc-day.sh:42-46`; `data-scan.yml` | `ci/test-ci.sh`: missing ledger, sum over cap, foreign use, admin API error, stale write, two runs at once → each refused |
| P2 | Scanner and rpcscan revisions frozen for the whole pull: a different revision refuses instead of re-reading (today units of another revision are re-read at full price, `rpc-day.sh:31-40`) | `ci/rpc-day.sh` | test-ci: a cached unit of another revision → exit 2, no request |
| P3 | Stop after 3 consecutive failed attempts (owner rule). Today `helius.go` retries 429, 5xx and network errors without a count until a 15-min back-off budget (`helius.go:150-200`, `-max-backoff`) | `rpcscan/helius.go` | `rpc_test.go`: a fake server failing 3 times → stop with a non-resumable code; 2 failures then success → continues |
| P4 | A separate exit when credits run out: Helius's 429 "max usage reached" body (DECISIONS HELIUS-EXHAUSTED) is not retried | `rpcscan/helius.go`, `main.go:262` | `rpc_test.go`: that body → its own exit code; a plain 429 → back-off |
| P5 | Handle JSON-RPC `-32005` (rate limit) as a rate limit that counts toward P3; today only `-32429`/`429` are (`helius.go:167`) | `rpcscan/helius.go` | `rpc_test.go`: `-32005` with HTTP 200 → back-off, counted |
| P6 | `RPC_CONC` exposed as a bounded workflow input (1–8); today it defaults to 4 and is not an input (`rpc-day.sh:58`) | `data-scan.yml`, `rpc-day.sh` | test-ci input validation |
| P7 | Exit codes as documented: the credit cap exits **3** (not 75; round 1 was wrong), back-off 75 (`main.go:259-269`, `rpc-day.sh:10-11`) | docs | existing tests |
| P8 | `HELIUS_DAYS` lists the 31 days (07-22 to 08-21) in one reviewed change (`ci/archive-limits.conf`; ARCHIVE-NODUP) | `ci/archive-limits.conf` | test-ci: an unlisted day refused (exists) |
| P9 | Per-day `max_credits` = that day's cap from `estimate.json` (≤ 1,000,000 accepted, `data-scan.yml:150`); the sum of dispatched day caps ≤ the global cap (P1) | dispatch inputs; P1 | P1's tests |
| P10 | **Throughput measurement** before the pull, approved by the owner with its own cap: one unit (4,500 slots) at `rpc_rps` 10, then 25, `RPC_CONC` 4 and 8; **cap 12,000 credits**. Reports blocks/s, retry share, latency, MB per block (wire and decompressed). Gives the real time figure and the retry overhead for §3 | dispatch only | — |
| P11 | Raw records for every canonical-pool transaction (§6); scanner revision frozen afterwards | `rpcscan/scan.go`, `scanner/` | parity on the schema-2 test unit: every canonical-pool row has its raw record |
| P12 | pump_fees FeeConfig and PumpSwap GlobalConfig changes kept (filter) or fetched (`getTransactionsForAddress`, ≤ about 1k credits) | `rpcscan/scan.go` or a fetch script | fixture with a fee-config change → a row or record exists |
| P13 | Storage per §6 (DATA-STORE + the DATA-PUB ruling); every finished day uploaded and verified before the next day starts | `data-scan.yml`, DATA-STORE scripts | upload and read-back of a fixture day |

**Cache scoping (RT-16).** This repo is public. Whether Actions caches made on the default branch can be restored by
fork pull-request workflows is **VERIFY** against GitHub's cache docs. P13 removes raw Helius data from the cache path
in any case.

## 8. Shared key (item 4)

**Consumers of `HELIUS_API_KEY` found in code:**
- workflows `data-scan.yml`, `data-helius-pilot.yml`, `dryrun-smoke.yml`, `dryrun-rehearsal.yml`, `gpa-probe.yml`,
  `owner-programs.yml`, `deploy.yml` (passes it to the server) and `secrets-check.yml`;
- scripts `packages/worker/scripts/{dryrun-smoke,live-probe,gpa-probe,funding-backfill}.ts` and
  `packages/backtest/scripts/owner-programs.ts`;
- the Zeroed worker on the server (now on the stand-in: no calls, HANDOVER:106);
- research sessions given the key in their environment, for example the execution audit on 7 Oct
  (`research/execution-audit/heli.py` reads `HELIUS_API_KEY`).

**The 126k on 7 Oct (DERIVED, VERIFY).** The plan was bought at about 6:16 AM Melbourne on 7 Oct (PROJECT_STATE:259).
The worker ran until the pause (last summary 7:31 AM) at 25k to 87k an hour (HANDOVER; PROJECT_STATE:27), which is
about 30k to 110k credits. The execution audit made 63,124 calls between about 07:49Z and after 08:30Z on 7 Oct (its
commits). It counted 10 credits a call to be safe; the documented cost is 1. Whether the 126k reading came before or
after the audit is unknown. Helius's usage endpoint (P1) gives the per-product split; only the owner's dashboard or
that endpoint can confirm it.

**Precondition:** no other Helius consumer for the whole pull. P1 enforces this by comparing Helius's own count with
the ledger.

**Separate key or project:**
- The usage endpoint counts per project ("The project ID … must match the project associated with the API key").
- The pages read show no per-key credit limit, so keys in one project share its credits.
- A separate project with its own plan would be new spending.
- **VERIFY** in the dashboard.

## 9. Helius terms (item 9)

Source: Helius Cloud Services Agreement, "Last Updated: September 28, 2026", <https://www.helius.dev/terms>
(fetched 2026-10-07):
- §3.2: Customer will not "(ii) except as otherwise permitted under Section 3.1, sell, resell, sublicense, rent,
  distribute, or provide the Services to third parties except as expressly authorized; … (iv) copy, modify, or create
  derivative works of the Services; … (xi) use or access the Services in any personal, household, or familial
  capacity, or for any purpose other than a lawful business purpose."
- §6.2: "Helius may suspend Customer's access to the Services, in whole or in part, if Customer breaches Section 3.2,
  creates a security risk, or uses the Services in a manner that materially harms the Services or others. Helius will
  provide notice before suspension when reasonably practicable."

Not confirmed:
- Whether storing blockchain data read through the Services counts as "the Services" under (ii) or (iv). That is a
  legal reading I cannot make.
- I found no clause naming bulk download or storage of chain data.

**Question for the owner (only the owner can answer):** is your use of the Helius account for this bot a "lawful
business purpose" under §3.2(xi), so that a sustained pull of about 7 million calls fits the agreement? If it does
not, or you are unsure, Helius may suspend the account (§6.2). That would also cut off every other use of the key.

## 10. Free alternative: the Old Faithful archive (item 10)

| | Helius (whole blocks) | Old Faithful archive |
|---|---|---|
| Credits | about 7.74M point, 9.00M cap | **0** |
| Same scanner and parity | Same scanner (RPC blocks re-encoded as archive nodes); parity with the archive proven on every table (pilot) | The reference itself |
| Speed limits | ≤ 25 req/s (50% of Developer); unmeasured above 5 blocks/s | `ARCHIVE_MAX_RPS` 10, `ARCHIVE_MAX_MBPS` 40, one lane (`ci/archive-limits.conf`) |
| Time | 3.3 to 16.6 days (§3) | Reads are about 600 GB per October day (`historical-data.md:86`; July days have fewer blocks). At 40 MB/s that is about 4.2 h a day, plus QA. At most one day per served 3-hourly check (`ARCHIVE_DAYS_PER_CHECK=1`), so about 5 to 7 days for 31 days if every check is served |
| Politeness | Retry-After, back-off, stop after 3 failures (P3) | Any 429 → at least 3 h back-off and the chain stops (`ARCHIVE_BACKOFF_S`); the scanner's identity is never changed (DECISIONS "No disguise") |
| Status | Owner chose it on 8 Oct ("B") | Served on 6 Oct (206 at 06:09Z, HANDOVER); owner on 6 Oct about 12:05 AM: "u can download other days for that politely" |
| Storage | §6: private releases after the DATA-PUB ruling | Same sizes. Publishing archive-derived files is designed as `data-day-*` releases, but "publishing files derived from the archive waits on Triton" (DECISIONS, pilot baseline note); **VERIFY** whether the private repo needs the same ruling |
| Rule | Owner exception given 8 Oct for Helius | "No bulk historical downloads" (carried 2026-10-06) would need **the same kind of owner exception** |

The archive route costs no credits, is not tied to the Helius terms question, and needs P2-, P11- and P12-style scanner
changes too. Its risk is availability: a 429 stops it for at least 3 hours. It should be offered to the owner as an
option.

## 11. Per-pool methods (kept from round 1, corrected)

`getTransactionsForAddress` at 0.1 credit per returned transaction (docs) is still ruled out:
- **PM:** 1,270 migrations a day × 8,000 to 42,900 successful transactions in the first 6 h × 0.1 × 30 = **30.5M to
  163M** (round 1 printed 28M: an arithmetic slip, F1).
- **MR:** about 1.2M to 28M, with no cap fixed in advance.

## 12. What is measured, derived, assumed

- **MEASURED:**
  - Helius per-call credits, limits, the usage endpoint and `getTransfersByAddress` (docs, 7 Oct);
  - slot times and skip rates for every day of the clean span (keyless grid);
  - 09-21's units and credits (HANDOVER);
  - the pilot's 3.0 MB per block and its retry share;
  - migrations a day (2 Oct) and the round-1 volume samples.
- **DERIVED:** every credit, time, transfer and storage figure.
- **ASSUMED:**
  - retries at most 25% (the upper bound);
  - October row and raw sizes for July and August (±2×);
  - 100 to 2,000 MR pools for age lookups;
  - about 1 KB per raw record.
- **VERIFY:**
  - the cycle's real use and the 126k split;
  - the Developer throughput and retry rate (P10);
  - the wire size;
  - pre-B4 events carry `virtual_quote_reserves` (decode a July unit);
  - GlobalConfig rows;
  - the plain `Transfer` vs `TransferChecked` question;
  - the createdAt source for the lead-in share;
  - the MR-01 artifact's version time;
  - the fork-PR cache restore;
  - the usage endpoint's own credit cost;
  - whether the archive-derived private store needs a Triton ruling.

## 13. Files

| File | What |
|---|---|
| `slot_grid.py`, `slot_grid.json` | Keyless slot-time and skip-rate grid (283 calls) |
| `estimate.py`, `estimate.json` | Per-day units and credits, regimes, candidate windows, caps |
| `deep_sample.py`, `deep_0915.json`, `deep_0826.json` | Round 1: deep-pool transaction counts (keyless) |
| `rec_rates.py`, `rec_summary.py`, `rec_summary_2026-10-06.json` | Round 1: young-pool rates from the 6 Oct recording |

## For the owner
- Credits: about 7.7 million (at most 9.0 million) for the 30 days 23 Jul to 21 Aug; the cap is 9.0 million of this month's 10 million. 60 days need about 18 million, so two months.
- If it stops early: days already read are kept and the rest waits for next month, but only if the storage below exists.
- Before any credit is spent: a strategy must survive Phase 0, you rule on C-76 and on Helius's "lawful business purpose" terms, you set up the private data storage, the safety code is built and reviewed, and nothing else uses the Helius key.
- It proves the bot runs without crashing on real history. It cannot prove the bot makes money, because these days were already studied.
- For the MR strategy it cannot test the holder checks on old coins, so a rule on how to treat them is needed first.
- Free option: the Old Faithful archive costs no credits and takes about a week if it is not blocked; it needs the same kind of exception to "no bulk downloads".
