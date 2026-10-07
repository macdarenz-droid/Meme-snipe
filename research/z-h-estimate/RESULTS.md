# Z-H credit estimate: 30 (target 60) days of history for the B-10 replay

**Route not chosen (owner, 2026-10-08 about 7:25 AM: "Old faithful but by batch to avoid blockage").** B-10's history now comes from the Old Faithful archive at 0 Helius credits; the batch plan is [`OLD-FAITHFUL.md`](OLD-FAITHFUL.md) (card Z-H-OF). This file is kept as the record of the Helius route; its credit figures, P10 and the paper blackout no longer apply.

Researcher card Z-H. Round 1: `db3050b3`. Round 2: `e6860267`. Round 3: `23eb1d6f` (review PASS). **Round 4 (final
pass): 2026-10-07 UTC (8 Oct Melbourne)**, answering the round-3 red team (R3-01 to R3-04) and reviewer M1–M3 as
relayed by the supervisor (§0). Round 3 answered the round-2 review and red team, and the supervisor's round-3 rulings 1–9, in `docs/reviews/ZH.md` at
`17faca6c`, against the spend rules of A-M14-05 in Z0D PR #286 at `e28dfab4`.

**No Helius call was made in any round.** Every figure comes from data already held, from official documentation
fetched on 2026-10-07, or from small keyless samples on the public Solana RPC (round 1: 73 + about 300 calls; round 2:
283 calls for the slot grid; round 3: none). Each sample ran at one request every 2 s, honoured Retry-After and stopped
after 3 failures.

Labels: **MEASURED** (counted from data), **DERIVED** (arithmetic on measured or documented numbers), **ASSUMED**
(judgement), **VERIFY** (not confirmed; check before relying on it). HANDOVER and PROJECT_STATE citations are pinned to
`2b736a3c`.

## 0. Round-4 changes (supervisor item → section)

| Item | What changed | Section |
|---|---|---|
| R3-01 Effective rate | The reading rate is now modelled with the job's duty cycle (300-min budget, 355-min timeout, setup, save, chain gap, the unit cut at each budget end, 45 min of QA a day). The 14-day minimum is **5.94 blocks/s effective, about 7.15 raw**. P10 is now one full 300-min job plus one chained restart at one setting (`rpc_rps` 12, `RPC_CONC` 8). It passes only with an effective rate ≥ 8 blocks/s and retries ≤ 25%. **P10 cap 432,000.** New P16: an uncapped auto-chain inside the window | §1, §3, §7.3, §7.4 |
| R3-02 Exclusivity wording | "nothing outside the bot's own spend ledger uses the Helius account" | §1, §7.1, §8, end |
| R3-03 M2 cost of the blackout | No RPC C failover, no Helius expiry proofs and no fee estimates while the engine has no Helius; W_B can get gaps if Shyft fails | §10 |
| R3-04 #214 | Old Faithful also needs PR #214 first; it is open and unmerged | §10 |
| M1–M3 | Summary lines 2 and 6; GitHub storage risk in line 2; "engine use as else" closed by the supervisor's reading (a) | §8, §12, end |

## 0a. Round-3 changes (kept for the record)

| Item | What changed | Section |
|---|---|---|
| 1 Fit with A-M14-05 | §7 rewritten as the Z-H prep implementation of A-M14-05 (no second ledger); 14-day window; S conditions and the case between them; second window about 31 days later; P10 a pass/fail gate (≥ 8 blocks/s, retries ≤ 25%) with its own `B10-ACK` and allocation | §7, §3 |
| 2 Replay mode | Both MR and PM need it (`honeypot_sim` blocks PM too); the supervisor's pending ruling recorded | §5, §1 |
| 3 Storage | P14: per-unit upload, then day-level finalize and QA from the store; runner disk; GitHub terms quoted, with what is and is not confirmed | §6, §7 |
| 4 Paper blackout | About 31 days without engine Helius after each reservation; "leaves about 0.87M" and "the rest waits for next month" corrected; paper delay per option | §1, §3, §10 |
| 5 Old-format days | Stated; the cost of adding the newest clean days | §2, §3 |
| 6 Extras | P12, MR lookups and usage reads inside `U`; P10 under its own allocation; one total exposure | §3, §7 |
| 7 Minors | HANDOVER pinned to `2b736a3c` (M1); the 63k audit in S (M3); the rescan unit carries retries (M4); storage, time and "a month's credits" in the summary (R2-06) | §3, §8, end |
| 8 Options | Helius pull, Old Faithful, and dropping the history part, side by side, each with what it proves | §10 |
| 9 Owner summary | Rewritten, 8 lines, no recommendation | end |

## 1. Bottom line

- **Not ready to spend.** A-M14-05 and the rulings allow no credit before all of these hold:
  - a strategy has survived Phase 0, and the owner has ruled on C-76 (Z0D ARCH:458, :1719 @ `53ab0d64`);
  - the owner has answered the Helius terms question (§9) and decided storage (§6);
  - the replay-mode ruling exists (§5): without it, both MR and PM make zero entries and B-10 proves nothing;
  - the Z-H prep code is built and reviewed (§7), and P10 has passed;
  - the owner's steps in §7 are done.
- **Earliest start: about 8 Nov 2026.** A-M14-05's `exclusive=yes` means nothing outside the bot's own spend ledger uses the Helius account during
  the window or in the 31 days before it (wording of the supervisor's round-4 ruling). Helius was used outside the bot's ledger on 7 Oct (the old worker and the
  execution audit, §8), so 31 days run to about 7 Nov, and only if nothing outside the bot's own spend ledger uses the key until then. In practice
  the start is later: Phase 0 survival, C-76 and M2 come first.
- **Recommended window: the 30 UTC days 2026-07-23 to 08-21, plus a 1-day lead-in (07-22).** It is the cheapest clean
  post-BOOST window, because its slots are about 420 ms. These are **old-format days** (pre-B3 fees, pre-B4 event
  layout, about 420 ms slots); today's format is covered by the forward M07 recording, not by B-10 (§2).
- **Credits (one `B10-ACK` window):**
  - estimate shown to the owner **7,762,033** (7,735,933 for the days + 26,100 extras);
  - row cap **9,022,478** (8,996,378 upper for the days + 26,100 extras);
  - P10 separately: **432,000** under its own `B10-ACK` (round 4: a full job plus a restart);
  - **total exposure 9,454,478** (§3).
- **The S condition.** `U = min(row cap, 9.5M − S)`, where S is the account's rolling 31-day Helius spend at reservation.
  - S ≤ **961,763**: the job may start (U ≥ 1.1 × estimate);
  - S ≤ **477,522**: it gets the full row cap;
  - S in between: it starts, but `U` is below the upper bound, so it may stop before the 31st day. The finished days
    are kept (P14), and the rest needs a new `B10-ACK` about 31 days later;
  - S > 961,763: it does not start.
- **Paper blackout.** After the reservation, the whole `U` counts for 31 days, so the engine has no Helius allocation
  and M26 refuses paper (A-M14-05 "After the window"). Paper (M3) can start no earlier than 31 days after the
  reservation. If M2 is still running for those 31 days, that costs nothing extra; if the pull is the last thing before
  M3, it costs up to 31 days. Each further window adds up to 31 more (§10).
- **Time.** The window is at most 14 days. Counting the job's duty cycle (setup, save, chain gaps, units cut at each
  300-min budget, QA), the pull must achieve at least **5.94 blocks/s effective**, which is about **7.15 blocks/s raw**
  (§3). Measured so far: 3 to 5 blocks/s raw on Free. At 5 raw the effective rate is about 4.2, which takes about
  20 days and does not fit. **P10 must show an effective rate ≥ 8 blocks/s over a full job and a restart, with retries
  ≤ 25%, or there is no pull** (§7.3). That needs about 9 blocks/s raw, which puts the pull at about 11.6 days.
- **Storage:** about 0.5 to 1.4 TB in private releases. GitHub's acceptable-use terms reserve the right to throttle or
  delete repositories with "significantly excessive" bandwidth; whether this pull qualifies is not confirmed (§6).
- **60 days** (07-24 to 09-21 + lead-in) cost about 17.8M point, 20.7M upper. That is at least 3 windows (each
  `U` ≤ 9.5M − S and ≤ 14 days), so the engine has no Helius for about 93 days.
- **What it proves:** robustness only. Owner item 2 asks for zero crashes, illegal states or unreconciled intents on
  real history, through the same engine. These days have been viewed before, including MR-01's exact configurations,
  so the replay is never evidence of an edge and never an item-6 holdout (§2). Under the replay-mode ruling (§5), the
  gates that cannot be rebuilt are assumed to pass, and those decisions are tagged.

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
**So B-10 on it runs old-format days only:** today's format (post-B4 events, the current fees, about 267 ms slots) is
covered by the forward M07 recording (gate B, A06 "both"), not by B-10. Adding the 4 newest clean days is costed in §3;
it does not fit the same window.
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
| U1 / U1-B | walk-forward 2026-08-17 to 09-11; holdout 09-12 to 09-21 (HANDOVER:625 @ `2b736a3c`) | graduates |
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
gate. In any case 09-21 never finished: 56, then 66 of 79 units were cached (HANDOVER:1389, :1295, :1237 @ `2b736a3c`), and the recommended
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
  - Check: the model gives **79 units for 2026-09-21, equal to the measured plan** (HANDOVER:1237 @ `2b736a3c`).
  - Margin units are re-read by adjacent days, so they are counted per day.
- **Credits per unit:** 1 per produced block (`getBlock`) plus 1 `getBlocks`, plus 1 rescanned unit a day for the
  determinism check (`check-day.sh`).
- **Skip rate (MEASURED):** produced/planned is at least 0.990 on every grid window from July to September, and 1.000
  on most. Skipped slots barely lower the cost.
- **Retry overhead:**
  - Point: **7.6%**, MEASURED on 09-21. 66 units cost 319,730 credits (HANDOVER:1231, :1295 @ `2b736a3c`) including retries at rps 3 and 5 on Free, against
    4,501 per unit base.
  - Upper: **25%**, ASSUMED, above the largest measured share of 18% (09-21 at rps 5, HANDOVER:1389 @ `2b736a3c`). The pilot
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
| **07-23 to 08-21, 1-day lead-in (recommended)** | **7.74M** | **9.00M** | Cheapest; fits one window if S ≤ 477,522 (§7) |
| 07-23 to 08-21, 2-day lead-in | 7.98M | 9.28M | +1 lead-in day covers about 1% more PM mints (§5) |
| 08-02 to 08-31 | 8.48M | 9.86M | Upper above the 9.5M account cap |
| 08-12 to 09-10 | 9.30M | 10.81M | Does not fit one window |
| 08-23 to 09-21 (round 1's) | 10.38M | 12.06M | Does not fit one window |
| 60 days 07-24 to 09-21 | 17.84M | 20.74M | At least 3 windows, each ≤ 14 days and `U` ≤ 9.5M − S |
| 26 old days (07-27 to 08-21) + the 4 newest clean days (09-18 to 09-21), one lead-in day before each | 8.60M | 10.00M | Covers post-B4 format and 250 ms slots; does **not** fit one window (1.1 × 8.6M needs S ≤ 42k; the upper bound is above 9.5M) |
| The 4 newest clean days alone, + lead-in 09-17 | 1.86M | 2.16M | As a second window: about 31 more days without engine Helius |

**Caps and total exposure (proposed; `estimate.json` `spend_rules`).**
- **Per-day caps:** each day's upper bound, from 286,939 to 315,070. Every day's upper bound includes the
  determinism rescan unit, and that unit carries the same 25% retry allowance as the others: (units + 1) × 4,501 × 1.25.
- **Extras inside `U`** (supervisor item 6), 26,100 in total:
  - P12, FeeConfig and GlobalConfig history: 1,000;
  - MR pool-age and mint lookups, only if MR is the selected strategy: 25,000;
  - admin usage-endpoint reads: 100 (their credit cost is **VERIFY**; budgeted at 1 a call).
- **Row cap (`cap=` in the `B10-ACK`): 9,022,478** = 8,996,378 + 26,100.
- **Estimate shown to the owner (cited by file and sha in the reservation): 7,762,033** = 7,735,933 + 26,100.
- **P10 throughput test: 432,000**, under its own `B10-ACK` (§7.3): its rate limit (12 req/s) × 2 × 300 min.
- **Total exposure: 9,454,478.** P10's 432,000 is in S at the main reservation if it falls within the 31 days
  before it, so it counts inside the S limits below.
- **S conditions** (A-M14-05: `U = min(row cap, acctCap − S)`, `acctCap` ≤ 9,500,000; start only if
  `U` ≥ 1.1 × the estimate):
  - start possible: S ≤ 9,500,000 − ⌈1.1 × 7,762,033⌉ = **961,763**;
  - full row cap: S ≤ 9,500,000 − 9,022,478 = **477,522**.
- **What S holds:**
  - the signer's standing block of 50,000, if it is installed by then;
  - P10's 432,000, if P10 ran within the 31 days before;
  - the engine's own Helius use in the 31 days before, which is unestimated: ARCH sizes the engine's whole Helius use
    to fit Helius Free's 1M a month (D03, §11.2), which alone could exceed both limits;
  - or the owner's `dashUsed` reading plus spend since, whichever is larger.
- **With P10 inside the 31 days before** (signer 50,000 + P10 432,000 = 482,000):
  - the engine may use at most about **0.48M** in those 31 days for the job to start;
  - the full row cap is **out of reach**, since 482,000 > 477,522. The job would start with `U` just under the upper
    bound.
- **With P10 more than 31 days before:** at most about **0.91M** for the job to start, and about **0.43M** for the
  full cap. That costs about 31 more days of calendar time.
- Run M1 and M2 mainly on Shyft and Chainstack (A-M14-02).
- **Between the two limits,** the job starts with `U` below the upper bound. If production and retries run high, it
  stops at `U` with fewer than 31 days read:
  - the finished days stay in the store (P14);
  - B-10 stays failed;
  - the rest needs a new `B10-ACK` about 31 days later, when the first `U` leaves the rolling sum. It is never "next
    month" by calendar.
- **Round 2's "leaves at least about 0.87M of the cycle's 10M" was wrong.** Under A-M14-05, the account cap is rolling
  31-day, the engine's allocation after the window is 5M − the signer's block − `U` (below 0), and nothing is left for
  the engine for 31 days. The 63k from the 7 Oct audit (§8) matters only through `dashUsed` and the 31-day exclusivity.

**Time and transfer (DERIVED; `estimate.json` `effective_rate`).**
- Blocks to read: about 7.19M, including the rescans.
- **Duty-cycle model.** A data-scan job's `rpc-day.sh` reads for at most 300 min inside a 355-min job timeout
  (`data-scan.yml:23-24, 174, 317`). Per job I assume (ASSUMED; P10 measures them):
  - setup 15 min;
  - save 10 min;
  - 5 min to the next chained job;
  - half a unit lost when the budget cuts a unit (it is re-read by the next job, so those credits are also spent
    twice; covered by the retry allowance);
  - 45 min of QA, packaging and determinism per day.
- **Effective rate needed to finish 31 days inside 14 days: 5.94 blocks/s**, which is about **7.15 blocks/s raw**.

| Raw blocks/s | Jobs | Days end to end | Effective blocks/s (pull) | Effective blocks/s (P10's two jobs, no QA) |
|---|---|---|---|---|
| 5 (measured on Free) | 93 | 19.9 (does not fit) | 4.19 | 4.43 |
| 8 | 62 | 12.8 | 6.52 | 7.16 |
| 9 | 62 | 11.6 | 7.18 | 8.07 |
| 10 | 62 | 10.7 | 7.80 | 8.98 |
| 12 | 62 | 9.3 | 8.98 | 10.80 |
| 25 | 31 | 4.9 | 16.83 | 22.61 |

- P10's pass mark (≥ 8 effective over two jobs) means about 9 raw, which puts the pull at about 11.6 days: about 2.4
  days of margin inside the 14.
- **Jobs and chaining.** About 62 jobs. `MAX_CHAIN` is 12 chained runs (`data-scan.yml:504, 527`), so today's
  workflow would need at least 5 hand re-dispatches, each a gap the model does not count. P16 replaces this with an
  auto-chain bounded only by `to` and `U`.
- `RPC_CONC` defaults to 4 (`ci/rpc-day.sh:58`), so throughput is about 4 divided by the `getBlock` latency: 8 blocks/s
  needs 500 ms or less at 4, or 1 s or less at 8.
- Transfer: about 3.0 MB per block, the RPC pilot's figure, decompressed (`helius.go` counts bytes after decompression;
  session_01XHH3k24fjmkpmmt28xSaYv.md:31). That gives about **21.6 TB decompressed**, and the wire size is
  **VERIFY**. Helius bills RPC per call, not per byte, so transfer is a runner and time question, not a credit one.

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
| `top10_holders`, `single_holder` (hard), `creator_balance` (soft) | Every holder's balance of the mint | Movements from the first scanned block on (state before it: `replay_unavailable`, §5 ruling). Lead-in days carry no movements in DATA-1 (`historical-data.md:164`), so a Z-H loader must read movements from the lead-in too | **PM:** mints created inside lead-in + window are complete. By Jupiter's off-chain `createdAt` for 518 graduates of 1–2 Oct (held data, research use only, **VERIFY**), 2.5% were created more than 24 h before graduation, 1.5% more than 48 h. So a 1-day lead-in leaves about 2.5% of PM mints unresolved, and they fail closed. **MR:** pools are at least 24 h, often months, old; their holder state cannot be rebuilt (see below) |
| `pool_age` | Pool creation time | `CreatePoolEvent` if inside lead-in + window; else one `getTransactionsForAddress` (signatures, ascending, limit 1) per pool, 10 credits | PM: in the blocks. MR: pools that reach ≥ 98,240 SOL in the window, about 100 to 2,000 (ASSUMED) → **1k to 20k credits** |
| `fee_ceiling`, creator-fee config (A08) | Fee bps in force | Every swap event | None after the pool's first in-window swap |
| `fee_config_known` | FeeConfig change history | Not kept (§4) | P12, ≤ about 1k credits |
| `venue_enabled` | GlobalConfig `disable_flags` | Kept as transactions; rows **VERIFY** (§4) | P12 |
| `min_depth`, `real_vs_effective_quote` | Vault reserves and virtual reserve | Every swap event (pre-swap reserves, virtual reserve) | None after the first in-window swap |
| `mint_authority_none`, `freeze_authority_none`, `t22_*`, `metadata_*` | Mint account state | Create transaction (raw record kept for every create) | PM: covered. MR: the mint is older than the window, so its authorities need one mint read. Today's account is look-ahead; at most a `getTransactionsForAddress` on the mint (10 credits) finds authority changes. **VERIFY** |
| `honeypot_sim` (hard, every candidate) | A simulation against past state | Not possible in history | `replay_unavailable` under the pending replay-mode ruling (below); without it every PM and MR entry fails closed |
| `dump_flag` | 30 min of returns | Lead-in | Covered by a 1-day lead-in |

**Why MR holders cannot be rebuilt.**
- `getTransfersByAddress` (10 credits per request of up to 100 transfers, Developer plan or higher;
  [docs](https://www.helius.dev/docs/rpc/gettransfersbyaddress)) takes an **owner wallet**, not a mint ("Pass the wallet
  owner address, not an associated token account"). It cannot list a mint's holders.
- `getTransactionsForAddress` on the mint misses plain SPL `Transfer` instructions, which do not name the mint
  account. Whether wallets and PumpSwap use `TransferChecked` is **VERIFY**, so completeness cannot be shown.
- Reading every block back to each MR pool's creation, often months, is far past any cap.
- Today's holder list (`getProgramAccounts`) is look-ahead and not allowed.

**Verdict: both universes need a replay-mode ruling (round 2 was wrong about PM).**
- `honeypot_sim` is a **hard** gate for every candidate (ARCH §8.4; Z0D ARCH:2197 on #286), and its `error` blocks
  entries. A buy-then-sell simulation against past state is impossible in history.
- So in an honest replay, **PM-01 also fails closed on every entry**, just like MR-01 on its holder gates. A B-10 run
  of either would show "no crash" on a run that never trades, which proves nothing.
- Round 2's "PM-01 can be replayed with real gates" contradicted its own gate table and is withdrawn.

**The supervisor's ruling (8 Oct 2026 about 1:55 AM, round 3 item 2), recorded here as PENDING a Z0D spec change the
supervisor will raise:**
1. In a B-10 run only, a gate whose input cannot exist in history (`honeypot_sim`, and holder state from before the
   window) receives a typed `replay_unavailable` value from the replay input provider.
2. A config key, valid only in replay mode with a B-10 trial key, treats that value as "assumed pass, flagged".
3. Config validation refuses that key in paper and live mode, and a test proves it.
4. Every decision taken under the key is tagged and excluded from every edge statistic (B, R and P).
5. The engine code stays the same; only the input provider and the config differ.
6. `fee_config_known` and `venue_enabled` stay fail-closed until P12 is done.

**What this means per strategy.**
- **PM-01:** `honeypot_sim` comes as `replay_unavailable`. Holders are rebuilt from movements for mints created inside
  the lead-in and window; about 2.5% (created earlier, **VERIFY**) get `replay_unavailable` holder state too.
- **MR-01:** `honeypot_sim` comes as `replay_unavailable`, and holder state comes as `replay_unavailable` for every
  pool, since all are older than the window. MR's holder gates are therefore never exercised against real values.
- The pull is the same for both. B-10 replays "the selected configuration" (ARCH:458), so the replayed universe is that
  strategy's.

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
- **Pull:** GitHub-hosted runners in this repo (public, so minutes are free).
  - Runner: 4 CPU, 16 GB RAM, and a documented 14 GB SSD (`historical-data.md:219`).
  - Real free space on `/mnt` is logged, not documented. `ci/check-day.sh:38` and `package-day.sh:27` write it to each
    run's summary, which this session cannot read.
  - Indirect evidence: `ci/disk-guard.sh` refuses a scan with less than 24 GB free, and the 09-21 Helius runs got past
    it and read units. So at least 24 GB was free on those runners (DERIVED; the exact figure is **VERIFY** from the
    run summaries).
  - A day at 17 to 45 GB does not fit, so the existing whole-day-on-disk pipeline cannot be used as is. **P14** below
    replaces it.
  - Never on the 2 GB / 55 GB host (D29, CA-26).
- **P14, per-unit upload, then day-level finalize and QA from the store:**
  - Each unit (4,500 slots; about 0.3 to 0.9 GB with raw records) is packed after it is read and uploaded as one asset
    (under 2 GiB) to the day's release in the store. Its sha256 is read back, then its raw records are deleted locally.
  - Rows and events (3.1 to 4.8 GB a day) stay on the runner for the day's finalize and strict QA, which need only
    rows.
  - Decoder parity, which needs the raw records, streams them back from the store one unit at a time.
  - The determinism rescan compares one re-read unit with its uploaded copy.
  - A failed upload or read-back stops the job before the next unit (fail closed). The unit's credits are already in
    the written-ahead ledger, so nothing is spent twice.
  - About 51 units a day, so about 52 assets per day release, well under 1,000.
- **Store:** releases on a private data repository (DATA-STORE #150).
  - **Hard precondition 1, owner:** DATA-STORE's three steps (the private repo, a fine-grained token, the secret and
    variable).
  - **Hard precondition 2, owner:** a DATA-PUB ruling that lets Helius-derived units, which carry raw `getBlock`
    responses, go to that private repo. DATA-PUB today allows the Actions cache only (`historical-data.md:317`), and
    the ruling depends on §9.
- **GitHub terms (fetched 2026-10-07):**
  - "About releases": "Up to 1000 release assets may be associated with a single release. Each file included in a
    release must be under 2 GiB. There is no limit on the total size of a release, nor bandwidth usage."
    (<https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>)
  - Acceptable Use Policies, §9 "Excessive Bandwidth Use": "If we determine your bandwidth usage to be significantly
    excessive in relation to other users of similar features, we reserve the right to suspend your Account, throttle
    your file hosting, or otherwise limit your activity … We also reserve the right—after providing advance notice—to
    delete repositories that we determine to be placing undue strain on our infrastructure."
  - §4 also bars "excessive automated bulk activity".
    (<https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies>)
  - **Confirmed:** no stated size or bandwidth cap for releases.
  - **Not confirmed:** whether storing 0.5 to 1.4 TB, mostly raw Helius responses, and downloading it again for the
    replay counts as "significantly excessive". GitHub publishes no threshold.
  - The downside named in the policy is throttling, suspension of the **account** (the owner's account also hosts this
    project), or deletion of the repository after notice.
  - This is a risk for the owner to accept or avoid; I cannot settle it. It also bears on the Helius §3.2(ii)/(iv)
    question in §9.
- **Replay:** a separate job on a GitHub-hosted runner (A-M11-01's new loader, D29: off the live host).
  - Per day it downloads one release asset at a time, checks its sha256, feeds it to the engine and deletes it. The
    engine's state carries across assets and days through a checkpoint.
  - Logs in this public repo must print aggregates only, never rows.
  - The loader must not inherit DATA-1's `finalize -lead-in-days 14` rule: 14 more days would add about 3.5M credits.

## 7. Card "Z-H prep": the implementation of A-M14-05, plus additions (items 1, 2, 3, 6)

Spend control is **A-M14-05 as written on PR #286 at `e28dfab4`** (SPEC-A, A-M14-05 step 2, "B-10 window" and "One job
instance, ledger written ahead"). This card builds that design for the Z-H job and adds nothing that competes with it.
**There is no second ledger:** round 2's P1, a per-run ledger with its own usage tolerance, is withdrawn.

### 7.1 Owner steps (all before any credit)
1. Rule on C-76, after a strategy has survived Phase 0.
2. Answer the Helius terms question (§9).
3. Do the DATA-STORE steps, and give the DATA-PUB ruling (§6).
4. Place the Helius key as an Actions secret of the job's repository.
5. Run `botctl b10-reserve <ackId>` on the host, or set up a tailnet path for the job machine. It must run at or after
   the window's `from`, with a `dashUsed` reading no more than 2 days old (A-M14-05; the review cited 3, but the spec
   text says 2).
6. Send the message from which the supervisor writes the pinned `B10-ACK` row:
   `B10-ACK id=<id> cap=9022478 acctCap=<≤ 9500000> exclusive=yes dashUsed=<credits>@<UTC date> ackAt=<ISO UTC> from=<UTC date> to=<UTC date ≤ from + 14 d>`.
   `exclusive=yes` is the owner confirming that nothing outside the bot's own spend ledger uses the Helius account in the 31 days before `from` or
   during the window (§8).
7. The same as 4 to 6 for P10's own window (§7.3, `cap=432000`), before the main one.

### 7.2 What A-M14-05 already fixes (the Z-H job must implement these exactly)
- **Window `[from, to)` of at most 14 days.** The job sends only inside it and stops at `to`. A 31-day pull must
  therefore reach at least 5.94 blocks/s effective (about 7.15 raw, §3).
- **`U = min(cap, acctCap − S)`, reserved as one entry.** S = max(the account ledger's rolling 31-day spend, the
  signer's block included; `dashUsed` + the ledger's spend since that reading). The job starts only if
  `U` ≥ 1.1 × the cited estimate.
  - With the estimate 7,762,033 and `cap` 9,022,478: S ≤ 961,763 to start; S ≤ 477,522 for the full cap.
  - With S in between, the job starts and may stop short; the rest needs a new `B10-ACK` about 31 days later (§3).
- **All of `U` counts as spent for 31 days.** After the window the engine's Helius allocation is 0 until `U` leaves the
  rolling sum (about 31 days after the reservation). M26 refuses paper meanwhile, and a P gate fails any minute without
  engine Helius (A-M13-06).
- **One instance, ledger written ahead:**
  - the lease `b10/<ackId>/lease.json` in `zeroed-data`, taken by compare-and-swap, with a 15-minute TTL;
  - credits reserved in chunks of at most 10,000 before the pages are fetched;
  - a lost chunk counts as spent, and a missing ledger counts as all of `U` spent;
  - the job stops at `U`, and also if the pinned ack changes.
- **The estimate is cited by file and sha:** this file, at the commit the owner saw. An operator-typed number is
  refused.
- **The admin usage endpoint exists.** A-M14-05 says "Whether Helius offers a usage API is VERIFY; if it does, that
  reading replaces `dashUsed`". It does:
  - `GET https://admin-api.helius.xyz/v0/admin/projects/{id}/usage`, which returns `creditsUsed`, `creditsRemaining`
    and per-product credits for the current credit cycle, authenticated with the project's key
    ([docs](https://www.helius.dev/docs/api-reference/admin/get-project-usage));
  - it reports the **credit cycle**, not a rolling 31 days, so it can replace `dashUsed` only as an upper bound on
    the cycle's use. Mapping it to S is a spec decision for Z0D;
  - its own credit cost is **VERIFY**, and is budgeted inside `U` at 100.

### 7.3 P10: throughput gate, with its own window (round 4)
- **Purpose:** prove that the pull fits a 14-day window, with real job overheads, before any large spend.
- **Run:** one full data-scan job (300-min `rpc-day` budget) plus one chained restart, at **one setting**:
  `rpc_rps` 12, `RPC_CONC` 8, on window days (07-22 onward).
  - It reports raw blocks/s, the **effective rate** (blocks read ÷ wall time from the first job's start to the second
    job's end, setup, save and the chain gap included), retry share, latency, the time lost to the budget cut and the
    restart, and MB per block on the wire and decompressed.
- **Pass mark:** effective rate **≥ 8 blocks/s** and retries **≤ 25%** of attempts. **Otherwise there is no pull**
  (supervisor ruling).
  - 8 effective in P10 corresponds to about 9 raw, which is about 7.2 effective in the pull with QA: about 21% above
    the 5.94 minimum.
  - At this setting the highest possible P10 effective rate is about 10.8 (`estimate.json`).
- **Credit cap: 432,000** = 12 req/s × 2 × 300 min × 60 s. Every attempt costs a credit, retries included, and the
  limiter caps attempts. A setting of 10 req/s would cap at 360,000, but could reach only about 9.0 effective, too
  close to the pass mark.
- **Its own allocation:**
  - a pinned row `B10-ACK id=<id-P10> cap=432000 acctCap=9500000 exclusive=yes dashUsed=…@… ackAt=… from=D to=D+1`;
  - its own `botctl b10-reserve` (two jobs fit in one day);
  - the same 31-day exclusivity, so P10 too can run no earlier than about 8 Nov.
  - The units it reads count only as a test: they are not the main ack's `pageLog`, and they are read again in the
    main window.
- **Consequence for S (new in round 4).** P10's 432,000 stays in S for 31 days. If the main reservation follows
  within 31 days, the start limit leaves the engine about 0.48M, and the full cap is out of reach (§3). Waiting 31 days
  after P10 avoids that, at a cost of about 31 days.
- **Alternative for the supervisor:** run P10 as the first full job and restart of the main window, with a stop rule
  if it fails.
  - Benefits: no second ack, no second exclusivity wait, no 432,000 in S, and its blocks count towards the 31 days.
  - Cost: a failure would end a window whose whole `U` counts for 31 days.

### 7.4 Additions (each with file and test that fails before and passes after)

| # | Addition | File | Test |
|---|---|---|---|
| P2 | Scanner and rpcscan revisions frozen for the pull: a different revision refuses instead of re-reading at full price (`rpc-day.sh:31-40`) | `ci/rpc-day.sh` | test-ci: a cached unit of another revision → exit 2, no request |
| P3 | Stop after 3 consecutive failed attempts (owner rule). Today `helius.go` retries 429, 5xx and network errors without a count until a 15-min back-off budget (`helius.go:150-200`) | `rpcscan/helius.go` | `rpc_test.go`: 3 failures → non-resumable stop; 2 then success → continues |
| P4 | A separate exit for Helius's 429 "max usage reached" (DECISIONS HELIUS-EXHAUSTED), not retried | `rpcscan/helius.go`, `main.go:262` | `rpc_test.go`: that body → its own code; a plain 429 → back-off |
| P5 | JSON-RPC `-32005` treated as a rate limit, counted toward P3 (today only `-32429`/`429`, `helius.go:167`) | `rpcscan/helius.go` | `rpc_test.go`: `-32005` with HTTP 200 → back-off, counted |
| P6 | `RPC_CONC` exposed as a bounded workflow input (1–8; default 4 today, `rpc-day.sh:58`) | `data-scan.yml`, `rpc-day.sh` | test-ci input validation |
| P7 | Exit codes as documented: the credit cap exits **3**, back-off 75 (`main.go:259-269`) | docs | existing tests |
| P8 | `HELIUS_DAYS` lists the 31 days (07-22 to 08-21) in one reviewed change (ARCHIVE-NODUP) | `ci/archive-limits.conf` | test-ci: an unlisted day refused (exists) |
| P9 | The per-day `max_credits` (that day's upper bound, `estimate.json`) is drawn from the job's written-ahead ledger. The day caps plus the extras sum to the row cap 9,022,478 | dispatch; A-M14-05 job | A-M14-05's tests |
| P10 | Throughput gate (§7.3) | dispatch | pass mark checked in the report |
| P11 | Raw records for every canonical-pool transaction (§6); revision frozen afterwards | `rpcscan/scan.go`, `scanner/` | parity on the schema-2 test unit: every canonical-pool row has its raw record |
| P12 | pump_fees FeeConfig and PumpSwap GlobalConfig changes kept (filter) or fetched (`getTransactionsForAddress`, ≤ 1,000 inside `U`) | `rpcscan/scan.go` or a fetch script | fixture with a fee-config change → a row or record exists |
| P13 | Storage per §6 (DATA-STORE + the DATA-PUB ruling) | DATA-STORE scripts | upload and read-back of a fixture day |
| P14 | Per-unit upload, then day-level finalize, QA and parity from the store (§6) | `ci/rpc-day.sh`, `ci/check-day.sh`, `ci/package-day.sh`, `data-scan.yml` | test-ci: a fixture day with `FAKE_AVAIL` below one day's size completes; an upload or read-back failure stops before the next unit |
| P16 | **Uncapped auto-chain inside the window.** In the Z-H job, the `continue` step re-dispatches after every resumable stop (time budget, back-off) with no `MAX_CHAIN` limit, while the time is before `to`, the written-ahead ledger has room under `U`, and the pinned ack is unchanged. It stops on a non-resumable exit, at `to`, at `U`, or on an ack change. No hand re-dispatch | `data-scan.yml` (`continue` job, `:495-533`) | test-ci: 70 resumable stops inside the window → 70 re-dispatches; a stop at or after `to`, with the ledger at `U`, or with a changed ack → no re-dispatch |
| P15 | The replay-mode input provider and config key of §5 (pending the Z0D spec change): `replay_unavailable` → "assumed pass, flagged" only with a B-10 trial key; refused in paper and live | A-M11-01 loader, M25 config | config validation refuses the key in paper and live; every tagged decision is excluded from B, R and P statistics |

**Cache scoping (RT-16).** This repo is public. Whether Actions caches made on the default branch can be restored by
fork pull-request workflows is **VERIFY**. P13 and P14 keep raw Helius data out of the cache path.

## 8. Shared key (item 4)

**Consumers of `HELIUS_API_KEY` found in code:**
- workflows `data-scan.yml`, `data-helius-pilot.yml`, `dryrun-smoke.yml`, `dryrun-rehearsal.yml`, `gpa-probe.yml`,
  `owner-programs.yml`, `deploy.yml` (passes it to the server) and `secrets-check.yml`;
- scripts `packages/worker/scripts/{dryrun-smoke,live-probe,gpa-probe,funding-backfill}.ts` and
  `packages/backtest/scripts/owner-programs.ts`;
- the Zeroed worker on the server (now on the stand-in: no calls, HANDOVER:116 @ `2b736a3c`);
- research sessions given the key in their environment, for example the execution audit on 7 Oct
  (`research/execution-audit/heli.py` reads `HELIUS_API_KEY`).

**The 126k on 7 Oct (DERIVED, VERIFY).** The plan was bought at about 6:16 AM Melbourne on 7 Oct (PROJECT_STATE:259 @ `2b736a3c`).
The worker ran until the pause (last summary 7:31 AM) at 25k to 87k an hour (HANDOVER @ `2b736a3c`; PROJECT_STATE:27), which is
about 30k to 110k credits. The execution audit made 63,124 calls between about 07:49Z and after 08:30Z on 7 Oct (its
commits). It counted 10 credits a call to be safe; the documented cost is 1. Whether the 126k reading came before or
after the audit is unknown. Helius's usage endpoint (§7.2) gives the per-product split; only the owner's dashboard or
that endpoint can confirm it.

**Precondition (A-M14-05 `exclusive=yes`):** the owner confirms that nothing outside the bot's own spend ledger uses the Helius account in the
31 days before `from` or during the window (the supervisor's round-4 wording, to be carried into the Z0D spec).
- Every consumer above outside that ledger (CI workflows, scripts, research sessions) must stay off the key for that
  time.
- Use on 7 Oct (the old worker and the audit, both outside the new ledger) puts the earliest `from` at about 8 Nov.
- **Closed (supervisor's reading (a), round 4):** the engine's own ledgered Helius use in M1 and M2 is not "else". It
  is allowed, and it counts in S (§3).

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

## 10. Options side by side (item 8)

No recommendation (the supervisor adds it). "Paper delay" means extra days before M3 paper can start, caused by this
option alone, assuming everything else is ready.

| | (b) Helius pull (the owner's 8 Oct choice) | Old Faithful archive | (c) Drop the history part |
|---|---|---|---|
| Credits | Estimate 7.76M; row cap 9.02M; plus P10 432,000 under its own ack: exposure 9.45M of the account's 9.5M rolling cap. 60 days: about 17.8M point, 20.7M upper, at least 3 windows | **0** | 0 |
| Earliest start | About 8 Nov (31-day exclusivity after the 7 Oct use), and only after Phase 0 survival, C-76, the terms answer, storage, the replay-mode ruling, the prep code and P10 | Only after **PR #214** (ARCHIVE-SAFE B: scanner caps 10 req/s and 40 MB/s, every 503 stops). On 2026-10-07 it is **open and unmerged**: head `e48d71df`, base `ccr-14987baf-i6lrsl` at the stale `efa3b006`, last updated 2026-10-05, titled "DO NOT MERGE before the 09-21 chain ends" (read through the GitHub API). It moves the scanner revision, so it must merge before P2 freezes it. Then the scanner changes (P2, P11, P12, P14), storage and the owner's exception | — |
| Time | P10 must show ≥ 8 blocks/s effective (about 9 raw), which gives about 11.6 days end to end inside a 14-day window. At the measured 5 raw (4.2 effective) it takes about 20 days and does not fit | Reads about 600 GB per October day (`historical-data.md:86`; fewer blocks in July) at ≤ 40 MB/s (`ARCHIVE_MAX_MBPS`), about 4.2 h a day + QA; at most one day per served 3-hourly check. About 5 to 7 days for 31 days if every check is served | — |
| Paper delay | **Up to 31 days** per window: the engine has no Helius for 31 days after each reservation (A-M14-05). 0 if M2 still has 31 days to run after the reservation. 60 days: up to about 93. **Cost during M2 even when paper is not delayed:** with no Helius, the engine has no RPC C failover, no Helius expiry proofs and no fee estimates (fees fall back to the floor, D15). If Shyft fails, only Chainstack (0.5 req/s) remains, so the M07 recording, and hence `W_B`, can get gaps | **0** (no Helius use) | **Blocked**: Z0D says "No branch waives B-10 (option (c) was not chosen)" (SPEC-A A-M13-06 on #286), so `backtest_passed`, and hence paper, cannot be reached unless the owner changes item 2 |
| Storage | 0.5 to 1.4 TB in private releases (§6); GitHub's "significantly excessive" clause unconfirmed | The same sizes and the same GitHub question. Publishing archive-derived files "waits on Triton" (DECISIONS, pilot baseline note); whether a private store needs Triton's answer is **VERIFY** | None |
| Terms and politeness | Helius §3.2(xi) "lawful business purpose" question (§9); stop after 3 failures (P3); ≤ 25 req/s | Triton's terms bar getting around a block; `ARCHIVE_MAX_RPS` 10, one lane; any 429 → at least 3 h back-off and the chain stops; the scanner's identity never changed (DECISIONS "No disguise"). It served on 6 Oct (HANDOVER @ `2b736a3c`), but blocked the scanner for hours on 4 Oct | — |
| Rule exception needed | Given on 8 Oct ("B") | "No bulk historical downloads" (carried 2026-10-06) needs **the same kind of owner exception** as Helius got. The owner said on 6 Oct "u can download other days for that politely", before that rule | The owner must change pre-funding item 2 |
| Same engine, parity | Same scanner; RPC blocks re-encoded as archive nodes; parity with the archive proven on every table (pilot) | The reference itself | — |
| What it proves | Zero crashes, illegal states and unreconciled intents through the same engine on 30 real old-format days, with the replay-mode gates assumed-and-flagged (§5). Not an edge, not a holdout, not today's format | The same as (b) | Nothing about history. Gate B still runs on forward M07 bars, so the bot is still tested on recorded data, but not transaction by transaction |
| What it does not prove | Profit; behaviour under today's fees, layout and 267 ms slots (the forward recording covers those); `honeypot_sim` and old holder gates | The same | Owner item 2 |

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
  - job overheads of 15 min setup, 10 min save, 5 min chain gap and 45 min QA a day (P10 measures them);
  - October row and raw sizes for July and August (±2×);
  - 100 to 2,000 MR pools for age lookups;
  - about 1 KB per raw record.
- **Closed in round 4:** the engine's ledgered use is not "else" under `exclusive=yes` (supervisor's reading (a)).
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
  - the usage endpoint's own credit cost, and how its credit-cycle figure maps to the rolling-31-day S;
  - whether the archive-derived private store needs a Triton ruling;
  - the runners' real free space on `/mnt` (logged in run summaries);
  - whether 0.5 to 1.4 TB in private releases is "significantly excessive" under GitHub's acceptable-use terms;
  - the engine's Helius use in M1 and M2 (it decides S).

## 13. Files

| File | What |
|---|---|
| `slot_grid.py`, `slot_grid.json` | Keyless slot-time and skip-rate grid (283 calls) |
| `estimate.py`, `estimate.json` | Per-day units and credits, regimes, candidate windows, caps, the mixed and newest-days options, `spend_rules` (extras, row cap, S limits, minimum blocks/s) |
| `deep_sample.py`, `deep_0915.json`, `deep_0826.json` | Round 1: deep-pool transaction counts (keyless) |
| `rec_rates.py`, `rec_summary.py`, `rec_summary_2026-10-06.json` | Round 1: young-pool rates from the 6 Oct recording |

## For the owner
- History test costs about 7.8 million Helius credits (about 9.0 million at most) of a month's 10 million, for 30 older days (23 Jul–21 Aug), plus up to 432,000 for a speed test first; 60 days needs at least 3 rounds.
- Before any credit: a strategy survives Phase 0; you rule on C-76 and Helius's "lawful business purpose" question; a rule for checks history can't rebuild is agreed; you set up private storage (0.5–1.4 TB, which GitHub may throttle or suspend at that size); the safety code passes; nothing outside the bot's own spend ledger uses the Helius account for 31 days. So about 8 Nov at the earliest.
- After the download the bot has no Helius for 31 days: paper trading can start up to 31 days later (about 93 days for 60 days), and meanwhile the bot loses its Helius backup reads and fee estimates.
- Speed is unproven: the real reading rate, after job restarts and checks, must be at least 6 blocks a second; the speed test must show 8 or there is no download. At the 5 a second seen so far it would take about 20 days, too long for the 14-day window.
- The speed test's 432,000 stays counted for 31 days, so you choose: start the download soon after it, with less room, so it may stop early; or wait about a month more (to about early December) for full room.
- If it stops early, the days read are kept and the rest waits about 31 days for another round.
- It proves only that the bot doesn't crash on real history, not that it makes money. Checks history can't rebuild (honeypot test, old holders) would be assumed to pass and flagged, under a rule that is still pending.
- Free option: the Old Faithful archive: 0 credits, about a week if not blocked, no Helius gap. It needs a pending scanner fix (PR #214), the same storage, and an exception to "no bulk downloads".
- Or drop the history test: no cost, but your item 2 then fails, and paper can't start unless you change that rule.
