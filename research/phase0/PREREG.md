# Phase 0 study: rules fixed before any data

Pre-registration for the M1 study A-M13-01 (A-24, A-24b, A-48) and the A05 kill-only check. First pushed on 2026-10-07, before the M07 recorder had written a single snapshot. Amended before R0, as §10 records.

**Freeze (RT-02).**
- This file is frozen at R0, the moment recording starts.
- Its commit sha is read with `git ls-remote` and stored in the R0 manifest before the first segment is pulled.
- Any later change is a new trial with a new trial key (A-M13-02).

**Kill-only.** Nothing here can pass MR-01. Where a rule has a choice, it takes the one that does not kill a strategy without clear evidence. The full gates B, R and P still judge on the strict row (A07).

## Sources

Every number below cites one of these:
- `docs/blueprint/SPEC-A.md`:
  - A-M13-01 (the study), A-M05-03 (manifest), A-M05-01 (prefilters), A-M07-03 (coverage);
  - A-M08-01/02 (bars, features), A-M10-01 (parameter set `prior-2026-10`), A-M10-02 (fill model), A-M10-03 (cost model), A-M13-03 (statistics);
  - clarifications C-15, C-20, C-22, C-23, C-26, C-27, C-34.
- `docs/blueprint/ARCH.md`:
  - §1.5 (`P_SOL`), §2.1–2.4 (costs), §3.2–3.4 (MR-01, gates, windows);
  - §7.3a (failure classes), §8.1 (`DEPTHPCT`, `REGIME`, `ENTRYRATE`), §8.3 (slippage), §8.4 (filters), §8.6 (cannot-sell);
  - §9.3 (fill rules), §18 Phase 0, M07 budget.
- `docs/blueprint/INTEGRATION.md`: M1 exit.
- `docs/MIGRATION.md`:
  - "Research addendum": A01, A02, A05, A07, A12, A14, A16;
  - "M1 Recording": Z08, Z09 and the disk rule.
- `research/BLUEPRINT_ADDENDUM.md` at `72f1793f` (branch `ccr-7fae2302-drz4co`).
- `CLAUDE.md`: "Size is not the trial", "Profit is counted in SOL", "No knowingly losing trades", "Discipline, not paralysis".

Labels:
- **DERIVED** = arithmetic on cited numbers.
- **VERIFY** = a value the Blueprint does not confirm; it is used in the pessimistic direction.
- **OPEN-n, F-n, RT-n** = supervisor rulings, listed in §10.

## 1. Data

- **Source.** Only our own M07 recording on the 2 GB Vultr host (CLAUDE.md "Host"; A01), from its first recorded day.
  - Reads go through Shyft free (CLAUDE.md "Data source"; MIGRATION "Phase 0 read provider").
  - **RT-06.** Any pool-time not read through Shyft at 1 Hz is excluded. That includes time on the Chainstack backup at one read every 2 s. A UTC day where such time is more than 5% of watched pool-time counts as a low-coverage day.
- **Not used:**
  - no historical download (A06 item 2 keeps the history replay for gate B only);
  - no pump.fun-operated host of any kind (A02);
  - no PumpPortal (CLAUDE.md "Data source");
  - no vendor OHLCV (A18 "not now");
  - no data collected before 2026-10-07, from Zeroed or any research branch (A02).
- **Streams read:**
  - `pool_snapshot*` (with `poll_counts`), `universe_manifest` and `coverage`;
  - the Z08 config records: GlobalConfig and FeeConfig at start and every 10 min (RT-20);
  - the Z08 SOL/USD series: once a minute, from a deep on-chain SOL/USDC pool read through the Phase 0 provider (F6; MIGRATION Z08);
  - recorder disk and size metrics.

  Bars and features are rebuilt from these by A-M08-01 and A-M08-02 replay, never taken from a live process.
- **Venue.** PumpSwap canonical pools only. Raydium is not recorded in Phase 0 (ARCH §3.3, D18), so this study cannot count Raydium pools.

### Days, window and wall

All days are UTC days, because the manifest and coverage report close at 00:00 UTC (A-M05-03, A-M07-03).
- **R0** = the UTC moment the recorder writes its first snapshot on the 2 GB host.
- **D1 (RT-18)** = the first full UTC day that starts at or after R0 + 30 h. The 30 h cover 6 h of feature warm-up (A-M08-02) plus 24 h of pool age (C-15). Day `Dn` = D1 + (n − 1) days.
- **Day 0** = R0 to the start of D1. It is not in the study, but it comes under the viewed-window ledger (§6; RT-02).
- **Phase 0 window** = D1 to D7, the first 7 complete recorded days (A-M13-01 step 1; ARCH §3.2).
- **Wall** = 00:00 UTC at the end of D7. Nothing after the wall is read by this study.
- **Low-coverage days** are shown but left out of every decision (A-M13-01 step 1). A day is low-coverage if `lowCoverage = true` (gap time > 5% of watched pool-time, A-M07-03) or under RT-06.
- **Extension (OPEN-1).** If D1–D7 hold fewer than 7 good days, the window grows one whole day at a time until it holds 7, up to D14. The wall moves to the end of the last added day. Past D14 the report is `insufficient_days`.
- **After the window.** These days are never part of `W_B` (C-26; A05). `W_B` starts only after MR-01's two configurations are registered in M13 (A-M13-02), and after the wall.

### Record when recording starts

The supervisor fills these in when the recorder starts. Filling them is a record, not a rule change.

| Item | Value |
|---|---|
| R0 (UTC) | to be recorded |
| D1 (UTC date, ≥ R0 + 30 h) | to be recorded |
| Wall (UTC) | to be recorded (00:00 UTC after D7) |
| Recorder commit sha | to be recorded |
| This PREREG's sha from `ls-remote`, as stored in the R0 manifest | to be recorded |

## 2. Frozen settings

These `affectsReturns` keys stay at their spec values for the whole study (A-M08-01, A-M08-02, A-M05-01, ARCH §3.3, §8.4):

| Key | Value | Source |
|---|---|---|
| Bar length | 15 s | A-M08-01 |
| `bars.close_grace_ms` | 1,500 | A-M08-01 |
| `bars.incomplete_missing_bps` | 2,000 (bar complete if missing ≤ 20%) | A-M08-01 |
| `features.robust_z_scaling` | `sqrt_time` | A-M08-02, C-20; OPEN-2 |
| `features.min_coverage_bps` | 5,000 | A-M08-02 |
| `features.median_window_ms` | 21,600,000 (6 h) | A-M08-02 |
| `features.dump_window_ms` | 1,800,000 (30 min) | A-M08-02 |
| `features.basket_min_pools` | 3 | A-M08-02 |
| MR eligibility | fee ≤ 30 bps per side; effective quote ≥ 300 SOL; age ≥ 24 h (C-15); real/effective quote ≥ 0.5; watched | ARCH §3.3, §8.4; A-M05-01 |
| Cost parameter set | `prior-2026-10` plus the strict row of §4 | A-M10-01, A07 |

**Eligibility per bar (RT-05).**
- Eligibility is recomputed at every bar, from recorded state as of that bar: fee tier, depth, age, real/effective ratio and watched status.
- The manifest's first and last eligible times are never used for A-24b or A05.
- The A-24 count stays the manifest field, as the spec defines it (§3).

Screening (M06) does not exist in Phase 0, so every pool is `phase0_unscreened`, and every count is an upper bound (C-44, A-M05-03).

## 3. A-24 and A-24b (as SPEC-A A-M13-01 defines them)

### A-24: eligible pools per day

Per day, from the manifest (A-M05-03):
- `a24.eligibleCount` (an upper bound);
- `canonicalityUnknownCount` (listed apart, not eligible; C-04);
- `maxSimultaneous`, `enumerationCoverage`, `lowCoverage` and `crossCheck.poolsOnlyInVendor`.

The per-bar count of RT-05 is shown beside it.

**Universe rule (ARCH §18; INTEGRATION M1 exit):** stop MR-01 if fewer than 10 eligible pools on more than half of the decision days. The spec also allows a Phase 3b (Raydium) escape, but this study cannot measure Raydium. A failed rule is therefore put to the owner as "stop MR-01, or fund the Raydium spec (M4b) to measure it".

### A-24b: typical moves against the cost hurdle

**Windows (F8):**
- Built from complete 15 s bars.
- Non-overlapping windows at 5, 15, 30 and 60 min.
- A pool must be eligible at the window **start** only.
- Every window ends before the wall, inside good days, and crosses no coverage gap.

**Dead pools (F8, RT-04):**
- A pool that dies or is evicted inside a window closes at the §9.3(7) pessimistic close, with the reading in C-23: the worse of the lowest-depth exit in the 5 min before data stopped and the price when data returns; −100% if data never returns before the window ends.
- These windows are counted, not dropped.
- A last-price line is shown as a sensitivity line.

**Move:** absolute log move in bps, `|ln(P_end / P_start)| × 10,000`. Per horizon: pooled median, p75 and p90; per-pool medians; pools contributing; windows.

**Unconditional only.** A-24b computes no signal, entry rule or strategy return (C-26). The A05 check in §5 is the only conditional work.

**Hurdle per size (RT-01):**
- **Sizes.** The hurdle is computed at each size of §4.
- **Median-depth state.** Each pool's median-depth state is its snapshot whose min(real, effective) quote is the median over all its eligible snapshots on the good days of the window. With an even count, the lower middle is used.
- **Pool set.** At size `x`, only pools whose median-depth state passes the depth cap at `x` (§4) are used.
- **Median pool.** Among those pools, the one whose `g*(x)` is the median (lower middle).
- **Moves.** At size `x`, the pooled moves come from the same set of pools.

**Deciding line (RT-01; A-M13-01 steps 4–5):** the lean row of §4, plus the fixed monthly term at 10 trades a day with `M` = $10. My reading of RT-01, since it makes the lean row deciding and puts the $10 and $59 lines beside it, is that the $10 term decides, as the lower of the two real costs. The reviewer should confirm this (see §10).

**Shown beside it:** the strict row of §4, the $10 line and the $59 line (OPEN-3, LD-27).

**Move rule:**
- **Size verdict:**
  - **pass** if, for at least one horizon in 5–60 min, the pooled median absolute move exceeds the deciding line;
  - **fail** if it has at least 30 windows at some horizon and passes at none;
  - **insufficient** if it has fewer than 30 windows at every horizon;
  - **excluded** if it is too small by `k`, or no pool passes the depth cap.
- **Verdict:** the move rule fails only when no size passes and at least one size fails.
- **Subset (RT-17):** a size whose result rests on fewer than 10 distinct pools is labelled "(subset)", and that pool subset is carried into `W_B`.

**Sign-off (F10).** The A-24 and A-24b verdicts go to the owner for sign-off (A-M13-01 step 5; MA-0c). The report states them; it does not decide them.

## 4. Costs and the size sweep

All money is in lamports; profit is counted in SOL (CLAUDE.md). USD labels are approximate (OPEN-4).

### Sizes

| Label | Lamports (at `P_SOL` $150, ARCH §1.5) |
|---|---|
| $5 | 33,333,333 |
| $20 | 133,333,333 |
| $100 | 666,666,667 |
| $1,000 | 6,666,666,667 |
| $10,000 | 66,666,666,667 |

DERIVED: USD ÷ 150 × 1e9, rounded to the nearest lamport. The recorded SOL/USD of D1 is added to the report as a note.

### Quote state (F9, RT-11)

- **Depth.** Every quote runs on the pool state with its quote reserve set to `Q' = min(real quote, effective quote)`. The base reserve is scaled the same way, `B' = B × Q' / Q_eff`, so the spot price stays where it was.
- **Bias.** This depth is never deeper than the truth.
- **Fee tier.** The tier comes from the unscaled state, under the conservative tier and rounding rule (A-M10-03, U-A03, EX-07). The creator fee is read per pool from chain (A08).
- **Bracketing (RT-07; ARCH §9.3(2); A-M10-02 step 5).** A fill at time `t` is quoted on each of the two bracketing snapshots: the last at or before `t`, and the first after `t` within 5 s. The worse one for our side is used, in every line.

### Per-trade money (RT-14, F9)

For a trade of `x` lamports:
1. **Buy.** `T = quoteExactIn(buy, x)` on the entry state.
2. **Sell.** `out = quoteExactIn(sell, T)` on the exit state. For the hurdle, the exit state is the same as the entry state (A-M10-03 step 1).
3. **Net.** `net = out − x − fixed − sandwich − stuck`.

The parts are shown apart, in lamports and in bps of `x` (CLAUDE.md "Size is not the trial"; MIGRATION Z09):
- **gross** = `x × r`, with `r` the spot ratio of the chosen exit state over the chosen entry state, minus 1;
- **fees + impact** = `x × (1 + r) − out`. Split rule (F9): **impact** = `x × (1 + r) − out_nofee`, where `out_nofee` is the same round trip with every fee set to 0; **fees** = `out_nofee − out`;
- **fixed**, **sandwich** and **stuck** from the rows below.

**Hurdle** `g*(x)` = (`x − out_same_state` + fixed + sandwich + stuck) / `x`, on the entry state.

### Strict row (A07): decides A05

Built from Blueprint parameters, taking the pessimistic end where the Blueprint gives a range. Lost rent is not in this row (RT-08): rent is capital (A-M10-03 step 8).

| Part | Value | Source |
|---|---|---|
| Base fee | 5,000 per leg | LD-01; ARCH §2.1 |
| Priority fee | 50,000 per leg. D15 "High", taken at the entry cap min(50,000, 20 bps of `x`), which is 50,000 at every size here | D15; ARCH §1.4, §8.3; A-M10-03 step 2 |
| Tip | 5,000 per leg (Sender, lean) | LD-22; ARCH §2.2 |
| Failed overhead | 0.20 / 0.80 × 55,000 = 13,750 per leg | `fFail` 0.20 (A-M10-01); ARCH §2.1 |
| Janitor close | 5,000 + 5,000 + 5,000 = 15,000 | A-M10-03 step 4; A-M10-01 |
| Rung-2 expectation | (1 − 0.8 × 0.95) × (1,000 + 50,000) = 12,240 | A-M10-03 step 5; `fExp` 0.05 |
| **Fixed total** | **174,740** | DERIVED: 2 × 60,000 + 2 × 13,750 + 15,000 + 12,240 |
| Sandwich (RT-07) | 0.10 × 50 bps × `x` + 0.10 × 100 bps × `out`, taken as an expected value with no random draw. With probability 0.10 per leg the fill is at `minOut`; the MR slippage bounds are 50 bps on entry and 100 bps on a normal exit | `pSw` 0.10 (A-M10-01; C-25); ARCH §9.3(5), §8.3 |
| Stuck (RT-07) | 0.008 × `out`. Under C-27 every failure is `unknown`, and 3 `unknown` swap failures in a row mark cannot-sell (ARCH §8.6, §7.3a). P = 0.20³ = 0.008, assuming independent attempts (VERIFY). The stuck position is valued at a total loss, because SPEC-A does not state how M10 values a stuck position (VERIFY) | ARCH §8.6; C-27; A-M10-01 |

### Other lines (shown only; they decide nothing in A05)

- **Lean row:** ARCH Table 2-A inputs, 35,000 lamports fixed, with no sandwich and no stuck term. This row decides the A-24b move rule (§3).
- **Stress row (A16; RT-15):** premium landing, ARCH §2.2.
  - Priority 200,000 and tip 1,000,000 per leg.
  - Failed overhead 0.25 × 205,000 = 51,250 per leg.
  - Rung-2 0.24 × (1,000 + 200,000) = 48,240.
  - Janitor 15,000.
  - Fixed total 2,575,740 (DERIVED), plus the strict sandwich and stuck terms.
- **Lost-rent line (RT-08):** the strict row plus 0.145 × 1,513,840 = 219,507 lamports of lost rent, for a fixed total of 394,247.
  - The 0.145 is the rate behind Zeroed's 414,009 figure: `docs/research/edge.md` §6.4 on `ccr-7fae2302-drz4co` reads "about 53% is modelled lost rent (14.5% of 1,513,840)".
  - The rate is unmeasured (OPEN-5).
- **414,009 line:** 414,009 lamports fixed (A07: "only as a sensitivity line").
- **Last-price line (RT-04):** dead or no-data exits use the last recorded price instead of the pessimistic close.

### Caps

- **`k` (A07, A23; OPEN-6).** A size is too small when strict fixed / `x` > 1%.
  - At $5 the strict fixed cost is 174,740 / 33,333,333 = 0.52% (DERIVED), so **no size is too small** under the strict row.
  - A too-small size is excluded from the decisions and still shown, marked "excluded (k)".
- **Depth cap (F1; ARCH §8.1 `DEPTHPCT`).**
  - A signal or random entry is excluded at size `x` when `x` > 0.5% of min(real, effective) quote at entry. The check is made at entry time (A12).
  - The count is shown per size, marked "excluded (depth)".
- **Fixed monthly term:** `ceil(M × 10,000 / (30 × tradesPerDay × x))` bps (A-M10-03 step 7).
  - It is shown at 1, 2, 5, 10 and 20 trades a day, and at the observed signal rate.
  - Two lines: `M` = $10 (66,666,667 lamports) and `M` = $59 (393,333,333 lamports; LD-27; OPEN-3), DERIVED at `P_SOL` $150.
  - It is part of the A-24b move rule (§3), not of A05.

## 5. A05: kill-only check of MR-01

The owner adopted this on 2026-10-07 ("Do all whats recommended"; MIGRATION A05). It can only stop MR-01, never pass a config, and its days stay outside `W_B`. The owner has already agreed to its kill (F10).

### 5.1 Configurations and signals

From ARCH §3.3. No other values are run.

| Config | Lookback `L` | `z_entry` | Stop `a` | Time stop `T` |
|---|---|---|---|---|
| MR-01-A | 5 min | 3.0 | 4% | 30 min |
| MR-01-B | 15 min | 3.0 | 5% | 60 min |

**Signal** (ARCH §3.3, A-M08-02). It fires at the close of a complete 15 s bar of a pool that is eligible at that bar (RT-05):
1. `robustZ(pool, L) ≤ −3.0`, with the scale = MAD/0.67449 of 15 s returns over 6 h, and `sqrt_time` scaling.
2. Effective depth has not fallen more than 10% over `L`.
3. Fee config is known and unchanged (ARCH §8.4 `fee_config_known`; RT-20).
   - The signal uses the latest GlobalConfig and FeeConfig record as of its bar.
   - With no record, the signal is excluded and counted.
   - A change between the latest two records within the last 10 min blocks it.
4. Real/effective quote ≥ 0.5 (ARCH §8.4).
5. `REGIME` is clear (ARCH §8.1; C-21; OPEN-7; F6). Both legs must hold:
   - the basket 30-min return (`basketReturn`, watched pools) is not below −5%, and a null basket counts as blocked;
   - the SOL/USD 30-min return is not below −3%.

   Rules for the SOL/USD leg:
   - The "30 min ago" sample is the latest one at or before `t − 30 min`, and it must be no older than 2 min.
   - If either end is missing, that signal uses the basket leg alone and is flagged `regime_basket_only`. The report counts these signals in a caveat.

**Null features (RT-19).** Pools with MAD = 0 are counted separately from other null features.

**Not applied,** because Phase 0 has no M06 or M21: authority checks, holder checks, honeypot simulation and the soft dump flag. The report counts the signals that carried a dump flag.

**Repeat block (OPEN-8; F4):**
- After a signal, the same config ignores that pool for `T`, starting at the close of the signal bar.
- The block is applied to the signal set after conditions 1–5.
- The result is one signal set, used for every delay and every size.
- `ENTRYRATE` (≤ 1 MR entry per 10 min, ARCH §8.1) is not applied to the primary line. An `ENTRYRATE`-thinned line is shown (first signal in time wins; ties by pool id).

### 5.2 Entry, exits and the common window

**Delays.** 0, 1 and 2 bars. The fill time `t_e` is the close of the signal bar plus `d` × 15 s.
- **Fallback (RT-14).** If the bar ending at `t_e` has no snapshot, `t_e` moves to the close of the next bar. If that bar has none either, the signal is dropped for that delay (`no_entry_price`).
- **Delay 0** is reported and never decides (RT-14).

**Common window (F5).** A signal is dropped if any part of `[t_e, t_e + H]` passes the wall, enters a low-coverage day, or crosses a recorded coverage gap. `H` is the longest hold: 60 min, or `T` if longer. So `H` = 60 min for both configs. The rule applies at every delay, so every horizon has the same `n`.

**Paths:** each kept signal is followed along five paths.
- **Fixed horizons:** exit at `t_e + h`, for `h` in 5, 15, 30 and 60 min.
- **Own exit path (RT-09):** the config's target, stop and time stop (ARCH §3.3).
  - **Target:** the lower of the 6 h rolling median at the signal bar (fixed at entry, C-22) and `entry × 1.06`.
  - **No target above entry:** if the median is not above the entry price, the signal is left out of this path only, and counted (the C-22 default).
  - **Stop:** at `entry × (1 − a)`.
  - **Trigger fills:** a target or stop that triggers on a snapshot fills at the first snapshot after the trigger (ARCH §9.3(8)), on the worse of the two (§4, bracketing).
  - **Time stop:** at `t_e + T`.

**Dead pools (RT-04).** A pool with no data before its exit closes at the §9.3(7) pessimistic close (C-23) and is counted. The last-price line is shown beside it.

### 5.3 Returns

For each path:
- **Raw return** `r`, as in §4.
- **Net** at size `x`, under each cost line of §4.
- **Hurdle:** "raw beats the hurdle" means mean `net(x)` > 0 under the strict row.

### 5.4 Matched random entries (A14; F2, F7)

For each kept signal and each size, there are 10 random entries.

**Candidates.** A candidate entry bar must:
- be in the same pool, on the same UTC day and in the same clock hour;
- be in the same 6 h MAD decile, with deciles cut over that day's eligible complete pool-bars. The supervisor cited C-65 for this matching; I could not find C-65 in `docs/blueprint` at `94d55a84` (VERIFY the citation);
- be complete, with non-null features, and the pool eligible (RT-05);
- pass the same entry-time filters as a signal: depth fall, fee-config, real/effective, `REGIME` and the depth cap at size `x`;
- pass the common-window rule (F5);
- not be the signal bar;
- have a holding window `[t_e', t_e' + H]` that does not overlap `[signal − L, signal]`.

**Draws.**
- 10 draws without replacement if there are at least 10 candidates; otherwise with replacement.
- With 0 candidates, only the hour widens: first to the same day ±1 h, then ±3 h. Pool and decile stay matched (F7).
- Still none: the signal stays in test (a), is left out of test (b), and is counted.

**Paths.** Each random entry uses the same delay, path and price rules as its signal. On the own exit path, it uses its own median target, with the same C-22 rule.

**Excess.**
- Raw excess: `e = r − mean(r of its random entries)`.
- Per size: `e(x) = net(x) − mean(net(x) of its random entries)`, under the strict row (OPEN-9).

**Seeds.** The A-M10-01 RNG with seed 1 decides. Seeds 2–10 are shown as a sensitivity range.

### 5.5 Kill rule

Supervisor rulings OPEN-9, RT-01, RT-09 and RT-16. Fixed now; it does not move after a look.

**Primary configuration and delay:** MR-01-A at delay 1 bar.

| Part | Value | Reason |
|---|---|---|
| Configuration | MR-01-A (`L` 5 min, `z` 3.0, `a` 4%, `T` 30 min) | The research behind A05 found most of the bounce in the first 5 minutes (`research/deep-pool-probe/RESULTS.md:25` on `ccr-7fae2302-drz4co`). The 5-min lookback is aimed at that, and its 30-min repeat block lets more signals into one week than MR-01-B's 60 min |
| Delay | 1 bar (15 s) | A decision at a bar close cannot fill at that same close (A-M08-01 closes bars 1.5 s late). The same research found a one-bar delay removed most of the bounce, so delay 0 would flatter |

**Cells:** each of MR-01-A's five paths (own exit path; 5, 15, 30 and 60 min) at each of the five sizes, all at delay 1.

**The two tests,** in each cell:
- (a) mean `net(x)` > 0 under the strict row, with `n_a` = signals left after the depth cap;
- (b) mean `e(x)` > 0, with `n_b` = signals in (a) that have at least one matched random entry.

**Cell verdict:**
- **pass:** both tests hold, with `n_a` ≥ 30 and `n_b` ≥ 30 (RT-16; C-34);
- **fail:** either test fails, with both counts ≥ 30;
- **insufficient:** either count is below 30. This is never a kill;
- **excluded:** the size is too small by `k`.

**MR-01 verdict (RT-09):**
- **Survives** if any cell passes.
- **Killed** only if no cell passes and at least one cell fails. This means delay 1 has failed both on MR-01-A's own exit path and at every fixed horizon from 5 to 60 min, at every size that could be judged. Both configurations are killed together.
- **Insufficient** if no cell passes or fails. A05 then neither kills nor passes MR-01; the A-24 and A-24b rules still apply in full.

**Subset (RT-17).** A cell resting on fewer than 10 distinct pools is labelled "(subset)". If MR-01 survives on such a cell, that pool subset is carried into `W_B`.

**Point estimates decide** (A05 as adopted). The intervals of §6 are reported beside them.

**Reported only:**
- MR-01-B;
- delays 0 and 2;
- the raw excess `e`;
- the lean, stress, lost-rent, 414,009 and last-price lines;
- the `ENTRYRATE` line;
- seeds 2–10.

**Recording the result.** A kill is recorded in `docs/DECISIONS.md` with this file's sha, and MR-01 then stops (INTEGRATION M1; MIGRATION "M1 exit"). Survival only means MR-01 may go on to `W_B` and its gates.

## 6. Statistics (A14, A12, A-M13-03)

### Intervals

Each mean gets a two-sided 95% interval: `net(x)` in every line, `r`, `e` and `e(x)`. The interval reported is the more conservative of two, meaning the one with the lower lower bound.

1. **Stationary bootstrap** (A-M13-03 step 1):
   - 10,000 resamples;
   - trades in entry-time order;
   - mean block `b = max(1, round(n^(1/3)))`, taking the most conservative of `b/2`, `b` and `2b`;
   - RNG seed 1.
2. **Calendar-day cluster t-interval (F3).**
   - Notation: `D` = UTC entry days, `n_d` = trades on day `d`, `n` = all trades, `m_d` = day `d`'s mean, `m` = the overall mean.
   - Variance: `Var_cl = D / (D − 1) × Σ_d n_d² (m_d − m)² / n²`.
   - Interval: `m ± t_{0.975, D−1} × sqrt(Var_cl)`.
   - Design effect: `DEFF = Var_cl / (s² / n)`, with `s²` the trade-level sample variance. Effective `n` = `n / DEFF`.

Every cell also shows `n`, `D`, DEFF and effective `n`. With `n` < 30 no interval is shown (C-34).

### Exclusion table (A12)

Every output has one. Rows:
- signals seen;
- dropped at entry, by reason: not eligible, incomplete bar, null feature (MAD = 0 apart, RT-19), depth fall, no config record, fee-config change, real/effective, `REGIME`, repeat block, `no_entry_price`, common window (wall, low-coverage day, gap), depth cap (per size);
- `regime_basket_only` flags;
- C-22 skips on the own exit path;
- random-entry shortfall (widened, or none);
- pessimistic closes (no data).

Exclusions happen only at entry, by these rules (A12).

### Viewed-window ledger (A12; RT-02)

`research/phase0/VIEWED.md` is append-only. Each row records: UTC time, session, days touched, streams, purpose and commit sha.
- From R0 onward, Day 0 included, nobody reads a price, bar, return or feature before the first run.
- Ops checks of recorder health are allowed and are logged as "ops, no prices": coverage counts, disk, sizes and credit use. They never read the manifest's `a24` fields or any eligible-pool count (RT-02).
- After the first run, Day 0 through the wall are "viewed" for MR-01. No `affectsReturns` value may later be chosen from them without a re-test on unviewed days.

## 7. A-48: recorder volume and coverage

Per day and per stream (A-M13-01 step 6; ARCH M07):
- compressed bytes, codec, and compression ratio (raw estimated from decoded size);
- snapshots, watched pools and pool-seconds;
- coverage: expected vs recorded polls, gap time by reason, `lowCoverage`, and RT-06 time (not Shyft at 1 Hz);
- reads per provider per day against 50% of each provider's documented limit (CLAUDE.md "Carried from the Blueprint build"; MIGRATION "Phase 0 read provider").

Disk:
- a 30-day disk projection against the 55 GB disk (A01; Z08) and the recorder's halt cap (MIGRATION "Recording disk rule");
- the measured values set against ARCH's assumed 3–5× zstd ratio and 0.31–0.52 GB a day (A-48).

**M1 coverage bar:** 48 h unattended with snapshot coverage ≥ 95% of watched pool-minutes (MA-0b; INTEGRATION M1).

## 8. Outputs

Written to `docs/phase0/report-<D1>.md` plus CSVs (A-M13-01). The report must be byte-for-byte reproducible from the same inputs and code sha.

**Tables**
- **T1** A-24 per day: manifest count (an upper bound) and the per-bar count, canonicality unknown, max simultaneous, enumeration coverage, low coverage, pools only in vendor.
- **T2** A-24 decision: days with ≥ 10 pools, decision days, rule met. For owner sign-off.
- **T3** A-24b per horizon and size: pooled median, p75 and p90; pools; windows; pessimistic closes. Plus per-pool medians (CSV).
- **T4** A-24b hurdle per size: median pool `g*` under the lean row (deciding) and the strict row; the monthly term at 1, 2, 5, 10 and 20 trades a day for `M` = $10 and $59; verdict per size and overall; "(subset)" labels. For owner sign-off.
- **T5** The cost rows (strict, lean, stress, lost-rent, 414,009), part by part, in lamports.
- **T6** A05 counts per config: signals, kept, dropped by reason; dump flags; MAD = 0; `regime_basket_only`; signals per day.
- **T7** A05 raw return per config × delay (0, 1, 2) × path (exit path, 5, 15, 30, 60): `n`, mean, median, interval, DEFF, effective `n`.
- **T8** A05 raw excess `e`: same grid as T7, with the seed 2–10 range.
- **T9** Size sweep per config × delay × path × size, for each cost line: mean gross, fees, impact, fixed, sandwich, stuck and net, in lamports and in bps of `x`; the interval of net; mean `e(x)` and its interval; `n_a`, `n_b`; "excluded (k)" and "excluded (depth)" counts.
- **T10** A05 decision: the 25 cells (5 paths × 5 sizes) of MR-01-A at delay 1, each with tests (a) and (b), `n_a`, `n_b`, its verdict and any "(subset)" label; then MR-01's verdict.
- **T11** `ENTRYRATE`-thinned line: T7 and T9 for MR-01-A at delay 1.
- **T12** A-48 per stream and day; disk projection; provider reads against limits.
- **T13** Exclusion tables (A12), for A-24b and for A05.
- **T14** Coverage per day (including RT-06 time) and the days used.

**Figures** (each also as CSV)
- **F1** Eligible pools per day, with the 10-pool line.
- **F2** A-24b absolute move distribution per horizon, with the deciding and strict hurdles at each size.
- **F3** A05 mean raw return and its interval by path, one panel per delay, per config.
- **F4** A05 mean `e(x)` and its interval by path, one panel per size, MR-01-A at delay 1, with zero.
- **F5** Net per trade by size (log scale of `x`) for MR-01-A at delay 1, own exit path, with the parts stacked.
- **F6** Bytes per day per stream, and the disk projection.

**Caveats** (A-M13-01 step 7, plus this study):
- counts are pre-screening upper bounds;
- enumeration coverage;
- A-24b says nothing about whether drops revert [ST-04];
- no sub-hour Solana-DEX evidence exists for MR (ARCH §3.2);
- a week gives few signals (A05);
- the missing M06 and M21 checks;
- the `regime_basket_only` count;
- the VERIFY items: the stuck probability and its valuation, and the C-65 citation;
- the lost-rent rate is unmeasured.

## 9. Review and run

- A fresh reviewer, who did not write this file, checks it against the cited lines before R0 (A16).
- The study code (A-M13-01) is reviewed and red-teamed before it reads any recorded day (CLAUDE.md "Carried from the Blueprint build").
- The first run happens once, after the wall, on the commit named in the run record. Any rerun reproduces it byte for byte. A changed result needs a new trial entry.

## 10. Amendments

- Allowed only before R0 (A16; RT-02). After R0 the file is frozen, and a change is a new trial with a new trial key.
- Each amendment is dated, says what changed and why, and is checked by a fresh reviewer.
- Filling in the "Record when recording starts" table is not an amendment.

### 2026-10-07 (1): supervisor rulings on the open points

Rulings by the supervisor (session_01UQmXJHSgmb2Tj7PK7VDKRz) on head `1b933ef6`, applied in `cdd62617`.

| # | Point | Ruling |
|---|---|---|
| OPEN-1 | Window when coverage is low | Grow day by day to 7 good days, up to D14; else `insufficient_days` |
| OPEN-2 | `features.robust_z_scaling` (C-20) | `sqrt_time` |
| OPEN-3 | Fixed monthly cost `M` | Two lines: $10, and $59 ($10 + Helius Developer $49, LD-27, while O7 is open). Since changed for A-24b by RT-01 (amendment 2) |
| OPEN-4 | Sizes | Lamports at `P_SOL` $150; dollar labels approximate |
| OPEN-5 | Lost-rent rate | 0.145, unmeasured. Since moved to a sensitivity line by RT-08 (amendment 2) |
| OPEN-6 | Fixed-cost cap `k` | 1% |
| OPEN-7 | `REGIME` | Applied in full, with recorded SOL/USD. Since detailed by F6 (amendment 2) |
| OPEN-8 | Repeats and `ENTRYRATE` | Accepted. Since detailed by F4 (amendment 2) |
| OPEN-9 | Primary cell | MR-01-A × 30 min × delay 1 at all five sizes. Since widened to five paths by RT-09 (amendment 2) |
| OPEN-10 | One config fails | Closed: only the primary cell decides |
| OPEN-11 | Fewer than 30 signals | "Insufficient" |

### 2026-10-07 (2): review and red-team fixes on `cdd62617`

The review and the red team both failed `cdd62617` on its rules; its arithmetic was right. The supervisor's fixes are applied here, before R0, with no data recorded.

Summary:
- **Reviewer, F1–F10:** depth cap; random-entry filters and matching; cluster variance; repeat block; common window; SOL/USD; widening; A-24b windows; quote state and split rule; owner sign-off.
- **Red team, RT-01 to RT-20:**
  - **RT-01** move rule per size, with the lean row deciding;
  - **RT-02** freeze at R0;
  - **RT-04** pessimistic close;
  - **RT-05** eligibility per bar;
  - **RT-06** Shyft at 1 Hz only;
  - **RT-07** sandwich, stuck and bracketing;
  - **RT-08** lost rent as a sensitivity line only;
  - **RT-09** survival on the own exit path or any horizon;
  - **RT-11** wording;
  - **RT-14** exact round trip; delay 0 never decides; fallback moves `t_e`;
  - **RT-15** stress row recomputed;
  - **RT-16** `n_b` and its floor;
  - **RT-17** subset;
  - **RT-18** D1 ≥ R0 + 30 h;
  - **RT-19** MAD = 0 counted apart;
  - **RT-20** config records.

The map from each item to its section is in the supervisor reply for this commit.

**My readings, for the reviewer to check:**
- **Move rule (RT-01).** The deciding line is the lean row plus the monthly term at 10 trades a day with `M` = $10. The $59 line and the strict row are shown beside it. This replaces OPEN-3's "decide on the higher" for A-24b.
- **Stuck term (RT-07).** P = 0.20³ = 0.008, from ARCH §8.6's three `unknown` failures in a row under C-27, assuming independent attempts (VERIFY). The position is valued at a total loss, because SPEC-A does not say how M10 values a stuck position (VERIFY).
- **Sandwich term (RT-07).** It is an expected value: 0.10 × the MR entry bound (50 bps) on the buy and 0.10 × the normal exit bound (100 bps) on the sell (ARCH §8.3). There is no random draw, so the run stays deterministic.
- **Bracketing (RT-07).** It applies to exit fills as well as entries, as ARCH §9.3(2) says "for our side".
- **`k` cap.** With lost rent out of the strict row, the fixed cost at $5 is 0.52%, so $5 is no longer too small.
- **C-65 (F2).** It is not in `docs/blueprint` at `94d55a84`. The matching rule itself is A14's.
