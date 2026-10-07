# Z-H credit estimate: 30 (target 60) days of history for the B-10 replay

Researcher card Z-H, 2026-10-07 (UTC). **No Helius call was made.** Every figure below comes from data already held,
from Helius's and Solana's official documentation (fetched 2026-10-07), or from a small keyless sample taken through
the public Solana RPC (73 + about 300 requests at 1 request every 2 s, no key, no credits).

Labels: **MEASURED** (counted from data), **DERIVED** (arithmetic on measured or documented numbers), **ASSUMED**
(judgement), **VERIFY** (not confirmed here; check before relying on it). The window rules come from CLAUDE.md
"History for the past-data test" on `origin/claude/supervisor-docs` at `651b1737`.

## 1. Recommendation

| Item | Choice |
|---|---|
| Method | Whole blocks: `getBlocks` + `getBlock` (1 credit each), read by the existing, reviewed and parity-tested DATA-2 pipeline (`research/historical/rpcscan`, `ci/rpc-day.sh`, its `-max-credits` hard stop). |
| Window | 30 scored UTC days **2026-08-23 to 2026-09-21**, plus a 6-hour lead-in (2026-08-22 18:00Z). Second 30 days for the 60-day target: **2026-07-24 to 2026-08-22**, only in the next credit cycle (after 6 Nov). |
| Universe | Both universes from the same blocks: every canonical PumpSwap pool and every migration in the window, so the MR and PM questions need no second download. |
| Credits, 30 days | **About 7.7M** (range 7.4M to 8.5M). |
| Credits, 60 days | About 15.4M (range 14.8M to 16.9M): more than one cycle's 10M. |
| Hard cap | **8,600,000 credits** for the 30-day pull (client-side count, reserved before each request). |
| Time | About 86 h of reading at 25 requests/s (half the Developer limit), about 4.5 to 6 calendar days with packaging and chained jobs. |

Why whole blocks and not per-pool history: per-pool methods are billed per transaction, and the transaction counts
are extremely heavy-tailed (section 5). Whole blocks cost a fixed, already measured amount per chain day whatever
the activity, so the cap can be set in advance and a day's cost cannot run away. Whole blocks also give every field
B-10 needs, including transfers for holder checks and fee-config changes, which per-pool history does not.

## 2. What B-10 / Z-H needs

Sources read: `docs/blueprint/ARCH.md` §3.3–3.4 (line 370: gates use M07 data "or another dataset that carries
historical reserves"), D03, D17, M07; `docs/blueprint/SPEC-A.md` A-M10-05, A-M11-01; `docs/MIGRATION.md` card Z-H
(line 810), A06 (line 416), B3 (line 448), the pre-funding table (line 686), all on `origin/claude/supervisor-docs`.

Z-H's acceptance is the owner's rule: at least 30 days (target 60) of survivorship-free on-chain history, replayed
transaction by transaction through the same engine code, with zero crashes, illegal states or unreconciled intents.
The data must therefore let the engine rebuild every pool's state at every swap without any vendor list.

| Need | Source in the chain | Why |
|---|---|---|
| PumpSwap `BuyEvent` / `SellEvent` per swap: slot, block time, transaction index, inner-instruction order, signature, pool, user, base and quote amounts, pool reserves after the swap, LP, protocol and coin-creator fees; after B4 the 16 extra holder-reward bytes | PumpSwap program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (inner event instructions) | Reserves at every swap (ARCH line 370); ordering by (slot, tx index, inner order) reproduced reserves with 0 mismatches in the execution audit (`research/execution-audit/RESULTS.md` on `ccr-7fae2302-drz4co`) |
| `CreatePoolEvent` and pump's `CompletePumpAmmMigrationEvent` | PumpSwap and pump programs | Universe from chain data (survivorship-free); PM-01's clock starts at migration (ARCH §3.3) |
| Effective reserves (vault + signed `virtual_quote_reserves`) | Pool account state, changed by its own transactions | DECISIONS 2026-10-03 prices PumpSwap on vault + virtual reserves. **VERIFY** that every change to the virtual reserve is visible in transactions of the window (whole blocks contain them; per-pool history may not) |
| Fee tiers and their changes (B3: 2026-09-09 19:30Z), `GlobalConfig.disable_flags` | pump_fees and PumpSwap admin transactions | Fees by market cap (MR ≤ 30 bps tier, PM 1.25% tier); fees change without notice. **VERIFY** that the DATA-2 filter keeps pump_fees transactions; it filters on the pump and PumpSwap programs |
| Token movements of each traded mint | SPL Token / Token-2022 transfers | Holder checks (`top10_holders`, `single_holder`, `creator_balance`, ARCH §8.4). DATA-1 keeps them as movement rows (about 2.1M rows, about 100 MB a day, `docs/research/historical-data.md` line 165) |
| Slot and block time of every block | Block header | The simulated clock with the measured slot time (bug B1: never 400 ms) |
| Failed transactions | Optional | Not needed for reserves; useful only for A-M10-05's landing and sandwich calibration |

## 3. Clean window

| Span | Status | Reason |
|---|---|---|
| Before 2026-07-21 14:23Z | Not used | Before BOOST (B2). PM-01 is post-BOOST only (ARCH §3.3); R-1 asks for post-BOOST data |
| 2026-07-22 to 2026-09-21 | **Clean (62 UTC days)** | Post-BOOST; before Zeroed's sealed holdout |
| 2026-09-22 to 2026-10-20 | Excluded | Zeroed's sealed holdout, used in parts (H8, H9, H11 study 10-01 23:00Z to 10-03; PR #267 22 Sep to 2 Oct; the 5 Oct data study; MIGRATION B3). Zeroed's own docs disagree on its edges (10-02 to 10-19); excluding the whole span covers both readings. The 2026-10-02 upgrade (UPG-1) is also a regime break inside it |
| From the start of Phase 0 recording | Excluded | That is forward M07 data: `W_B`, then `W_R` (ARCH §3.4). No past day can be in a future `W_R` |

- **Post-BOOST: yes, required.** PM-01 is defined on post-BOOST data only, BOOST changed migration dynamics (ARCH
  [ST-06]), and one rule for both universes avoids mixing regimes in one replay. For MR's deep pools BOOST matters
  less, but nothing is gained by going earlier.
- **Regime breaks inside the window:** B3 (2026-09-09 19:30Z, creator-fee and quote-control config) and B4
  (2026-09-12 15:24Z, trade events grow 16 bytes). Only about 9.4 days of clean history are post-B4. So the engine's
  decoders must accept the dated pre-B4 layout before slot 446,462,733 (PumpSwap) / 446,462,760 (pump), as DATA-1's
  QA already does, and results are reported per regime (ARCHITECTURE §13.2 on the supervisor branch, line 442).
- **30 days:** 2026-08-23 to 2026-09-21 (the newest 30 clean days: closest to today's fees and layouts, all 9.4
  post-B4 days included). Lead-in: 6 h before (MR-01's robust scale uses the previous 6 h, ARCH §3.3); pool age
  (MR ≥ 24 h) comes from each pool's `CreatePoolEvent`, found in the blocks or, for older pools, by one
  signatures-only `getTransactionsForAddress` call (10 credits) per pool.
- **60 days:** add 2026-07-24 to 2026-08-22 (lead-in 2026-07-23 18:00Z): post-BOOST by 2.4 days.
- **Already held:** 2026-09-21 was read over Helius (BT-2e, `HELIUS_DAYS`); its units live only in the Actions cache,
  kept by DATA-KEEP. If still valid it saves about 0.25M credits. **VERIFY** it before the pull.
- **Viewed-window caveat (needs a supervisor ruling, not a blocker for item 2).** The whole clean span was already
  looked at for MR-like rules: the deep-pool probe ran MR-A (5-min drop ≥ 3σ, +6/−4, 30 min) and MR-B on vendor 5-min
  bars over 2026-07-22 to 09-21 (`research/deep-pool-probe` on `ccr-7fae2302-drz4co`), which are close to MR-01's
  two pre-registered configurations; the daily probe and BT-2 practice days also used it. No Blueprint threshold was
  set from it, so it is not B3-style contamination. But it cannot be an untouched holdout for owner item 6; it serves
  item 2 (robustness on transaction-level history) and must go into A12's viewed-window ledger.

## 4. Universe (survivorship-free, from chain data only)

Both universes come from the blocks themselves: every `CreatePoolEvent`, every `CompletePumpAmmMigrationEvent`, and
every swap's reserves. Nothing is read from pump.fun or any pump.fun-operated host. A pool that died stays in the
data because its last swaps and its silence are in the blocks. Optional second-source coverage check (ARCH [ST-25]):
one `getProgramAccountsV2` listing of PumpSwap pool accounts (1 credit per page of up to 10,000 accounts; about
50 to 100 credits, **VERIFY** the pool count); it lists accounts alive today, so it checks completeness, not history.

| Universe | Size | Label |
|---|---|---|
| (i) MR family: canonical PumpSwap pools in the ≤ 30 bps tier (market cap ≥ 98,240 SOL), age ≥ 24 h, depth ≥ 300 SOL (ARCH §3.3, §8.4) | About 18.5 pools a day: the 25 pools whose best group in the deep-pool probe was A (≥ 98,240 SOL) had 1,149 eligible pool-days over 62 days (with group B: 41 pools, 1,929 pool-days, about 31 a day) | MEASURED on a survivor-only list (pump.fun API, coins worth ≥ about $81k on 2026-10-06). Two biases pull opposite ways: `eligible_days` counts a pool's days in any group, so it overstates A-tier days, while the survivor list misses pools that were deep and later died. The true count is ASSUMED 1× to 2× (**VERIFY**: the blocks themselves give the exact count) |
| (ii) PM-01: canonical pools in their first hours after migration (entry 20 to 120 min) | About 1,270 migrations a day | MEASURED on 14.4 h of 2026-10-02 (`docs/research/historical-data.md` line 94). The 6 Oct recording shows 11 to 17 pools under 20 min old at a time in full-watch samples, which DERIVES to about 800 to 1,200 a day |

## 5. Volume

### MR pools (keyless public RPC sample)
`deep_sample.py` (rate limiter: 1 request every 2 s, half the stricter of the documented 40 per 10 s and the measured
10 per 10 s for `getSignaturesForAddress`; Retry-After honoured; stop after 3 failures). Pools: the group-A pools
with the most eligible days (survivor-biased list, used only to measure volume, never as a universe).

| Day | Pool | Successful tx | Failed tx | Note |
|---|---|---|---|---|
| 2026-09-15 | TBB | 3,372 | 2,132 | complete |
| 2026-09-15 | NORMIE | 116 | 44 | complete |
| 2026-09-15 | BOBO | 710 | 201 | complete |
| 2026-09-15 | Cupsey | 6,819 | 7,219 | complete |
| 2026-09-15 | Clash | 327 | 223 | complete |
| 2026-09-15 | CLAW | 23,637 | 13,681 | complete |
| 2026-08-26 | KET | 75,847 in 20.2 h | 44,153 | 120-page safety cap hit; about 90k a day if uniform |
| 2026-08-26 | ANSEM | 91,573 in the last 2.7 h | 28,421 | cap hit; about 820k a day if uniform (weak extrapolation) |
| 2026-08-26 | MANIFEST | 39,914 | 16,825 | complete |

MEASURED: successful transactions per deep pool-day range from about 100 to at least 90,000, with one pool near
100,000 in under 3 hours. Median about 6,800. Failures are 26% to 51% of all transactions. The run of 26 Aug stopped on
a connection reset at the 4th pool (no retry, by design). Files: `deep_0915.json`, `deep_0826.json`.

### PM pools (6 Oct server recording, private repo `zeroed-data`, release `rec-2026-10-06`)
`rec_rates.py` + `rec_summary.py`: 10 frames files spread over the day (557 s in total, 256 pool observations), unique
signatures per pool from the worker's per-pool log subscriptions, failures removed. Ages from the worker's own
`migratedAtMs`. The 6 Oct data lies in the holdout window; it is used here only to count transactions for a cost
estimate, never for a threshold, a gate or a return.

| Pool age | Successful tx/s: median (p25 to p90) | Mean | Successful tx per pool in the band (mean / median) |
|---|---|---|---|
| 0 to 20 min | 5.1 (0.95 to 54) | 19.1 | 23,000 / 6,200 |
| 20 to 60 min | 0.27 (0.07 to 12) | 5.5 | 13,200 / 640 |
| 1 to 2 h | 0.07 (0.02 to 1.2) | 1.0 | 3,700 / 260 |
| 2 to 6 h | 0.07 (0.02 to 0.56) | 0.21 | 3,000 / 960 |
| **First 6 h** | | | **about 42,900 / 8,000** |

MEASURED: all pools under 4 h old together carried 200 to 360 successful transactions a second in the five samples
where the worker watched every pool. Cross-check: the archive count for 2026-10-02 was about 20.3M PumpSwap trades a
day (about 235 a second), canonical pools at least 46% of them. The recording counts every transaction that mentions
the pool (a swap or not), on another day, so the two agree only within about a factor of 1.5; both show that young
pools carry most of PumpSwap's traffic. The samples are short (about 1 minute each); the means rest on a few very
busy pools.

## 6. Cost

### Per-call credits (Helius official docs, fetched 2026-10-07)
Sources: [Credits](https://www.helius.dev/docs/billing/credits) ("Standard Credits", "Historical Data Credits"),
[Rate limits](https://www.helius.dev/docs/billing/rate-limits), [getTransactionsForAddress](https://www.helius.dev/docs/rpc/gettransactionsforaddress),
[getProgramAccountsV2 reference](https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2), [Parsed Events](https://www.helius.dev/docs/parsed-events).
These pages may change after today; re-read them before the pull (**VERIFY** at start).

| Method | Credits (docs) | Rate limit, Developer (docs) | Gives B-10's fields? | Cost for this job |
|---|---|---|---|---|
| `getBlock`, `getBlocks` | 1 each ("Historical data queries … cost 1 credit each") | RPC 50 req/s; batches of at most 10 items for historical methods | **Yes, everything** (DATA-2 pilot: parity with the archive on every table) | Fixed per chain day, about 255k |
| `getSignaturesForAddress` + `getTransaction` | 1 + 1 per transaction | RPC 50 req/s; `getTransaction` batches of up to 100 | Per pool only; no transfers of other accounts | About 1 credit per transaction (each batch item is assumed billed, **VERIFY**): about 10× `getTransactionsForAddress` |
| `getTransactionsForAddress` (full) | "10 credits per 100 returned transactions, rounded up; 10-credit minimum"; signatures only: 10 flat; failed responses free | RPC 50 req/s; no batching; one address per request | Per pool; `status: succeeded` filter; up to 1,000 full transactions per call; Helius-exclusive | About 0.1 credit per successful transaction |
| Enhanced Transactions | 100 per call ("Legacy … maintenance mode") | DAS & Enhanced 10 req/s | Helius's own parsing, not our decoders | Ruled out |
| Parsed Events | 10 per request | DAS & Enhanced 10 req/s | Helius's IDL decoding, no parity with our decoders; items per request not stated (**VERIFY**) | Ruled out |
| `getProgramAccounts` / `getProgramAccountsV2` | 10 / 1 per request (V2 pages up to 10,000 accounts) | gPA 25/s | Today's accounts only, no history | Coverage check only, about 100 credits |
| Archive pricing | None separate: historical calls are 1 credit; exceptions listed above | | | |

### Credits by method and universe (30 scored days + 6 h lead-in = 30.25 days)

**Whole blocks (recommended).** Blocks per day in the window: slot time 0.329 to 0.344 s (MEASURED from block times:
slot 440,727,311 at 2026-08-21 and slots 443,677,006 (2026-09-02) and 447,380,932 (2026-09-16)), so about 251k to
263k slots a day. The DATA-2 pilot MEASURED about 250k credits a day plus up to 18k for planner margin units (1 credit
per produced block; `docs/research/historical-data.md` line 320; `docs/DECISIONS.md` line 475 on the supervisor branch).

| Window | Point | Range | How |
|---|---|---|---|
| 30 days (30.25) | **7.71M** | 7.41M to 8.50M | DERIVED: 30.25 × 255k (range 245k to 281k a day, i.e. skipped slots to slot rate plus full margin) |
| 60 days (60.25) | 15.36M | 14.76M to 16.93M | same |
| Saving if the 09-21 cache is valid | −0.25M | | VERIFY |

This covers both universes at once.

**Per-pool `getTransactionsForAddress` (not recommended).**

| Universe | 30 days | How |
|---|---|---|
| (ii) PM, first 6 h of every migration | **28M to 163M** | DERIVED: 1,270 a day × 8,000 to 42,900 successful tx × 0.1 credit × 30. Lower bound check: ≥ 9.3M canonical-pool trades a day (2 Oct) × 0.1 = ≥ 0.93M a day. Does not fit 10M |
| (i) MR, deep pools only | **about 3.1M, range 1.2M to 28M** | DERIVED: pool-days = 30 × 18.5 to 40 pools × 1 to 1.5 (near-threshold pools and eviction tails, ASSUMED); successful tx per pool-day 6,800 (median) to 150,000 (mean incl. the extrapolated pool) × 0.1; plus about 0.77M for a 1-in-10 block sample to discover the universe from chain data (a slot-hash sample, independent of outcomes, with a stated detection floor). Point: 1,125 pool-days × 2,060 credits (mean without the extrapolated pool) + 0.77M |

The MR-only route is cheaper at the point estimate but its upper range is above the whole-block cost, it cannot be
capped without leaving gaps in busy pools, it lacks transfers for holder checks unless each mint's history is also
pulled, and it would not serve PM-01. Whole blocks are the cheapest method that gives every field for both universes
within a cap fixed in advance.

### Fit with the Developer plan
- Cycle 6 Oct to 6 Nov 2026: 10M credits; about 126k used on 7 Oct (`PROJECT_STATE.md` line 39, supervisor branch).
  Remaining about 9.87M (**VERIFY** on the Helius dashboard before the start; only the owner can see it).
- 30 days at the cap: 8.6M, leaving about 1.27M for everything else this cycle. The live worker is off and Phase 0
  reads from Shyft (CLAUDE.md), so nothing else is expected to use Helius; if anything does, the reserve covers it.
- 60 days do not fit one cycle (about 15.4M). The second 30 days fit the next cycle (from 6 Nov) under the same cap,
  with no new spending. Buying extra credits would be new spending and is not proposed.

### Time, transfer and storage at ≤ 50% of the documented limit
- Rate: 25 requests a second (half of Developer's 50 RPC req/s), each batch item counted as one request
  (conservative; whether Helius counts a batch as one request is **VERIFY**).
- Reading: 255k / 25 ≈ 10,200 s ≈ 2.8 h per chain day → **about 86 h for 30 days** (171 h for 60). With QA,
  packaging and 6-hour job chaining (about 45 min a day, from the DATA-2 design), about **4.5 to 6 calendar days**.
  25 blocks/s on Developer is unmeasured (the pilot measured 5/s on Free, 429s at 8/s): **VERIFY** with the first
  1,000 blocks.
- Transfer: about 1.65 MB per block (MEASURED, October) → about 420 GB a day, about 12.7 TB for 30 days, 41 MB/s
  sustained. Helius bills RPC per call, not per byte (data-streaming products are the per-MB ones), but the runner's
  network and whether responses are compressed are **VERIFY**.
- Storage: decoded units about 6.4 to 8.5 GB a day (±50%), so about 190 to 255 GB for 30 days; rows only (curve,
  canonical pools, movements) about 3.1 to 4.8 GB a day, about 95 to 145 GB. This does not fit the 10 GB Actions cache.
  It needs the private-repository releases proposed in DATA-STORE (#150), which wait on owner steps. Nothing large is
  committed here; every file in this folder is under 25 KB.

## 7. Cap and stop rule (proposed)

1. **Hard cap 8,600,000 credits** for the 30-day pull, counted by `-max-credits` (each HTTP attempt reserves a credit
   before it is sent; nothing goes past the cap; exit 75).
2. **Per-day cap 290,000.** A chain day that reaches it stops the run for review (expected 245k to 281k).
3. **Order newest first** (2026-09-21 back to 2026-08-23, then the lead-in), so a stop keeps a contiguous span with
   every post-B4 day. Reuse the cached 2026-09-21 if its checksums pass.
4. **Rate ≤ 25 req/s, one lane.** On a 429 honour Retry-After and back off; stop after 3 failures in a row. A 429 "max
   usage reached" stops at once (credits gone; HELIUS-EXHAUSTED).
5. **Fewer than 30 clean days at the cap:** stop and tell the owner; never run a shorter check (MIGRATION card Z-H).
6. **Before the start:** the owner's dashboard shows ≤ 1.2M used this cycle; no other Helius consumer is running;
   storage (DATA-STORE) is in place; the Helius §3.2(xi) question (open, PROJECT_STATE line 47) is settled or the
   owner accepts it as is.

## 8. What is measured, derived, assumed

- MEASURED: Helius per-call credits and rate limits (docs, 7 Oct); slot times in the window; the DATA-2 pilot's
  credits per chain day and bytes per block; migrations per day (2 Oct); per-pool transaction rates of young pools
  (6 Oct, short samples) and of 9 deep pool-days (keyless sample); the survivor-list count of deep pools.
- DERIVED: every credit total, time and storage figure above.
- ASSUMED: the true deep-pool count is 1× to 2× the survivor list; 1× to 1.5× extra pool-days for near-threshold
  pools and eviction tails; a 6-hour lead-in is enough; each `getTransaction` batch item is billed.
- VERIFY before any spend: the Helius pages above unchanged; the cycle's credits used; 25 blocks/s sustainable on
  Developer; whether a batch counts as one request; the 09-21 cache; that the DATA-2 filter keeps pump_fees admin
  transactions and every virtual-reserve change; the PumpSwap pool count for the coverage check.
- Not checked: Helius's terms on storing derived files (§3.2(xi), open with the owner).

## 9. Files

| File | What |
|---|---|
| `deep_sample.py` | Keyless public-RPC sampler (rate-limited, stops after 3 failures) |
| `deep_0915.json`, `deep_0826.json` | Its outputs (9 pool-days) |
| `rec_rates.py`, `rec_summary.py` | Per-pool rates from the 6 Oct recording (GitHub release downloads only) |
| `rec_summary_2026-10-06.json` | Their output |

## For the owner
- Credits: about 7.7 million Helius credits for 30 days of history (between 7.4 and 8.5 million); 60 days would need about 15.4 million, so the second 30 days wait for next month's credits.
- Cap: a hard stop at 8.6 million credits, which leaves about 1.3 million of this month's 10 million; no new spending.
- Time: about 3.6 days of non-stop reading at half Helius's speed limit, about 4.5 to 6 days in all.
