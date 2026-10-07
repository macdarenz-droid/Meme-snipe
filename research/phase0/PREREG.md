# Phase 0 study: rules fixed before any data

Pre-registration for the M1 study A-M13-01 (A-24, A-24b, A-48) and the A05 kill-only check. Written and pushed on 2026-10-07, before the M07 recorder has written a single snapshot. The supervisor confirms the push time with `git ls-remote` before recording starts (A16).

Changing any rule after the first run is a new trial and must be reported as one. Changes before the first run follow "Amendments" at the end.

## Sources

Every number below cites one of these:
- `docs/blueprint/SPEC-A.md`: A-M13-01 (the study), A-M05-03 (manifest), A-M05-01 (prefilters), A-M07-03 (coverage), A-M08-01/02 (bars, features), A-M10-01 (parameter set `prior-2026-10`), A-M10-03 (cost model), A-M13-03 (statistics), clarifications C-15, C-20, C-26, C-27, C-34.
- `docs/blueprint/ARCH.md`: §1.5 (`P_SOL`), §2.1–2.4 (costs), §3.2–3.4 (MR-01, gates, windows), §8.1 (`REGIME`, `ENTRYRATE`), §8.4 (filters), §18 Phase 0, M07 budget.
- `docs/blueprint/INTEGRATION.md`: M1 exit.
- `docs/MIGRATION.md`, "Research addendum": A01, A02, A05, A07, A12, A14, A16; "M1 Recording" (Z09, disk rule).
- `research/BLUEPRINT_ADDENDUM.md` at `72f1793f` (branch `ccr-7fae2302-drz4co`).
- `CLAUDE.md`: "Size is not the trial", "Profit is counted in SOL", "No knowingly losing trades", "Discipline, not paralysis".

Labels: **DERIVED** = arithmetic on cited numbers. **OPEN-n** = a point the spec left open, ruled by the supervisor before data; the rulings are listed under "Amendments".

## 1. Data

- **Source.** Only our own M07 recording on the 2 GB Vultr host (CLAUDE.md "Host"; A01), from its first recorded day. Reads go through Shyft free, with Chainstack free as backup (CLAUDE.md "Data source"; MIGRATION "Phase 0 read provider").
- **Not used.** No historical download (A06 item 2 keeps the history replay for gate B only; this study needs none). No pump.fun-operated host of any kind (A02). No PumpPortal (CLAUDE.md "Data source"). No vendor OHLCV (A18 "not now"). No data collected before 2026-10-07, from Zeroed or any research branch (A02).
- **Streams read:** `pool_snapshot*` (with `poll_counts`), `universe_manifest`, `coverage`, and recorder disk and size metrics. Bars and features are rebuilt from these by A-M08-01 and A-M08-02 replay, never taken from a live process.
- **Venue.** PumpSwap canonical pools only. Raydium is not recorded in Phase 0 (ARCH §3.3, D18), so this study cannot count Raydium pools.

### Days, window and wall

All days are UTC days, because the manifest and coverage report close at 00:00 UTC (A-M05-03, A-M07-03).
- **R0** = the UTC moment the recorder writes its first snapshot on the 2 GB host.
- **D1** = the first full UTC day after R0. Day `Dn` = D1 + (n − 1) days.
- **Phase 0 window** = D1 to D7, the first 7 complete recorded days (A-M13-01 step 1; ARCH §3.2 "first week of M07 data").
- **Wall** = 00:00 UTC at the end of D7. No bar, snapshot or manifest after the wall is read by this study.
- **Low-coverage days** (`lowCoverage = true`, gap time > 5% of watched pool-time, A-M07-03) are shown but left out of every decision (A-M13-01 step 1).
- **Extension (ruling OPEN-1).** A-M13-01 says fewer than 7 complete days gives `insufficient_days` and no decision, but not whether the window may grow. Rule: if D1–D7 hold fewer than 7 days with good coverage, the window grows one whole day at a time until it holds 7 good days, up to D14. The wall moves to the end of the last added day. Past D14 the report is `insufficient_days`.
- **Warm-up.** Features need 6 h of bars (A-M08-02). Pools first enumerated count as old enough only 24 h after first enumeration, unless the migration slot is known from the chain backfill (C-15, A-M05-01, A02). Both are rules of the bot, so they are kept; early-day counts may be low, and the report says so.
- **After the window.** These days are never part of `W_B` (C-26; A05). `W_B` starts only after MR-01's two configurations are registered in M13 (A-M13-02), and after the wall.

### Record when recording starts

The supervisor fills these in this file in one commit when the recorder starts. Filling them is a record, not a rule change.

| Item | Value |
|---|---|
| R0 (UTC) | to be recorded |
| D1 (UTC date) | to be recorded |
| Wall (UTC) | to be recorded (00:00 UTC after D7) |
| Recorder commit sha | to be recorded |
| This PREREG's commit sha and `ls-remote` time | to be recorded |

## 2. Frozen settings

These `affectsReturns` keys stay at their spec defaults for the whole study (A-M08-01, A-M08-02, A-M05-01, ARCH §3.3, §8.4):

| Key | Value | Source |
|---|---|---|
| Bar length | 15 s | A-M08-01 |
| `bars.close_grace_ms` | 1,500 | A-M08-01 |
| `bars.incomplete_missing_bps` | 2,000 (bar complete if missing ≤ 20%) | A-M08-01 |
| `features.robust_z_scaling` | `sqrt_time` (C-20: fixed at pre-registration; supervisor ruling OPEN-2) | A-M08-02, C-20 |
| `features.min_coverage_bps` | 5,000 | A-M08-02 |
| `features.median_window_ms` | 21,600,000 (6 h) | A-M08-02 |
| `features.dump_window_ms` | 1,800,000 (30 min) | A-M08-02 |
| `features.basket_min_pools` | 3 | A-M08-02 |
| MR universe prefilter | fee ≤ 30 bps per side; effective quote ≥ 300 SOL; age ≥ 24 h | ARCH §3.3, §8.4; A-M05-01 |
| `real_vs_effective_quote` | ≥ 0.5 (applied in this study; see §5.1) | ARCH §8.4 |
| Cost parameter set | `prior-2026-10` plus the conservative row in §4 | A-M10-01, A07 |

Screening (M06) does not exist in Phase 0, so every pool is `phase0_unscreened` and every count is an upper bound (C-44, A-M05-03).

## 3. A-24 and A-24b (as SPEC-A A-M13-01 defines them)

### A-24: eligible pools per day

Per day, from the manifest (A-M05-03): `a24.eligibleCount` (upper bound), `canonicalityUnknownCount` (listed apart, not eligible; C-04), `maxSimultaneous`, `enumerationCoverage`, `lowCoverage`, and `crossCheck.poolsOnlyInVendor`.

**Universe rule (ARCH §18; INTEGRATION M1 exit):** stop MR-01 if fewer than 10 eligible pools on more than half of the decision days. The Phase 3b (Raydium) escape exists in the spec, but this study cannot measure Raydium, so a failed rule goes to the owner as "stop MR-01, or fund the Raydium spec (M4b) to measure it".

### A-24b: typical moves against the cost hurdle

- From complete 15 s bars of eligible pools only.
- Non-overlapping windows at 5, 15, 30 and 60 min, each window inside one pool's eligible time and before the wall.
- Absolute log move in bps: `|ln(close_end / close_start)| × 10,000`.
- Per horizon: pooled median, p75, p90; per-pool medians; pools contributing; windows.
- **Unconditional only.** No signal, entry rule or strategy return is computed in A-24b (C-26). The A05 check in §5 is the only conditional work, and it runs only the two registered configs.

**Hurdle (A-M13-01 step 4):** `g*` at $10 notional (66,666,667 lamports at `P_SOL` $150, ARCH §1.5) with lean landing on each eligible pool's median-depth state. Report the median pool's `g*`, plus the fixed monthly term at 1, 2, 5, 10 and 20 trades a day.

**Move rule (A-M13-01 step 5):** proceed only if, for at least one horizon in 5–60 min, the pooled median absolute move exceeds `g*` (median pool) + the fixed monthly term at 10 trades a day.

Two hurdle lines are shown for the move rule:
1. the spec's lean `g*`;
2. the conservative row of §4 (A07).

The move rule is judged on the conservative row (A07: "B-2 must pass under it until each parameter is measured"). The lean line is shown for reference.

**Fixed monthly cost `M` (ruling OPEN-3).** ARCH uses $12. The report shows two lines instead:
- `M` = $10 (the Vultr host; CLAUDE.md "Host");
- `M` = $10 + $49 = $59 (the host plus Helius Developer, $49 a month per FACTS LD-27). This line counts while the owner's O7 ruling is open (A03).

The decision uses the higher line ($59), because it is stricter. `M` is converted to lamports at `P_SOL` $150 (ARCH §1.5).

## 4. Costs: conservative row and size sweep

All money is in lamports; profit is counted in SOL (CLAUDE.md). USD labels are for reading only.

### Sizes

| Label | Lamports (at `P_SOL` $150, ARCH §1.5) |
|---|---|
| $5 | 33,333,333 |
| $20 | 133,333,333 |
| $100 | 666,666,667 |
| $1,000 | 6,666,666,667 |
| $10,000 | 66,666,666,667 |

DERIVED: USD ÷ 150 × 1e9, rounded to the nearest lamport.

**Ruling OPEN-4.** The sizes are fixed in lamports as above, at `P_SOL` $150 (ARCH §1.5), so the study never depends on a SOL/USD feed. The dollar labels are approximate. The recorded SOL/USD of D1 is added to the report as a note.

### The four cost parts

For each trade at size `x` (CLAUDE.md "Size is not the trial"; MIGRATION Z09), the report shows these parts apart, in lamports and in bps of `x`:
1. **Gross:** `x × r`, where `r` is the raw spot return (§5.3).
2. **Percentage fees:** venue fee on both sides, from the pool's fee tier at entry under the conservative tier and rounding rule (A-M10-03; U-A03). Creator fee is read per pool from chain (A08).
3. **Impact:** constant-product impact on both sides, on the same entry state (A-M10-03 step 1, ARCH §2.1). The depth used is **min(real quote, effective quote)** (MIGRATION Z09), which is never shallower than the truth.
4. **Fixed:** per round trip, from the conservative row below.

`net = gross − fees − impact − fixed`.

### Conservative row (A07)

Built from Blueprint parameters, pessimistic where the Blueprint gives a range. All figures are per round trip.

| Part | Value | Source |
|---|---|---|
| Base fee | 5,000 per leg | LD-01; ARCH §2.1 |
| Priority fee | 50,000 per leg. Rule: D15 "High", assumed to hit the entry cap min(50,000, 20 bps of `x`). The cap is 50,000 at every size here. | D15; ARCH §1.4, §8.3; A-M10-03 step 2 |
| Tip | 5,000 per leg (Sender, lean) | LD-22; ARCH §2.2 |
| Failed overhead | 0.20 / 0.80 × 55,000 = 13,750 per leg | `fFail` 0.20 (A-M10-01); ARCH §2.1 |
| Janitor close | 5,000 + 5,000 + 5,000 = 15,000 | A-M10-03 step 4; A-M10-01 |
| Rung-2 expectation | (1 − 0.8 × 0.95) × (1,000 + 50,000) = 12,240 | A-M10-03 step 5; `fExp` 0.05 |
| Lost rent | 0.145 × 1,513,840 = 219,507 (rounded up) | ATA rent LD-14; rate: see OPEN-5 |
| **Fixed total** | **394,247** | DERIVED: 2 × 60,000 + 2 × 13,750 + 15,000 + 12,240 + 219,507 |

Failure class mix: 100% `unknown` (C-27). It does not change this forward-return study, which models no cannot-sell path; it is recorded so the row matches A07.

**Ruling OPEN-5, unmeasured.** A07 asks for "janitor-failure and dust rates", but the Blueprint gives no number. The lost-rent probability is 0.145, the rate behind Zeroed's 414,009 figure ("about 53% is modelled lost rent (14.5% of 1,513,840)", `docs/research/edge.md` §6.4 on `ccr-7fae2302-drz4co`). It already covers dust and failed closes. It is not measured: only a measured value may replace it, and only before data or as a new trial.

**Other lines shown beside the row** (none decides anything):
- **Lean line:** ARCH Table 2-A inputs (35,000 lamports fixed per round trip).
- **Sensitivity line:** 414,009 lamports fixed (A07: "only as a sensitivity line").
- **Stress line** (A16 "stress costs"): premium landing, ARCH §2.2 (CU price 1,000,000 µlamports, tip 1,000,000 per leg), with the rest of the row unchanged.

**Fixed-cost cap `k` (A07, A23).** A size is "too small" when `fixed / x > k`. **Ruling OPEN-6: `k` = 1%.** With the row above, $5 is too small (394,247 / 33,333,333 = 1.18%, DERIVED), and $20 and above pass (0.30% at $20). A too-small size is excluded from the A05 decision (§5.5) and is still shown in every table, marked "excluded (k)".

**Depth cap.** ARCH §2.4 (8) caps live entries at 0.5% of effective depth. At each size, a signal whose `x` is more than 0.5% of its pool's effective quote at entry is excluded from that size's A05 test. The check is made at entry time (A12). The count is shown per size, marked "excluded (depth)". Matched random entries (§5.4) are a benchmark: they are not dropped by this cap.

**Fixed monthly term.** `ceil(M × 10,000 / (30 × tradesPerDay × x))` bps (A-M10-03 step 7). It is shown at 1, 2, 5, 10, 20 trades a day and at the observed signal rate, with `M` from OPEN-3. It is not part of the A05 decision; it is part of the A-24b move rule.

## 5. A05: kill-only check of MR-01

The owner adopted this on 2026-10-07 ("Do all whats recommended"; MIGRATION A05). It can only stop MR-01. It can never pass a config. Its days stay outside `W_B`.

### 5.1 The two registered configurations, and nothing else

From ARCH §3.3. No other values are run.

| Config | Lookback `L` | `z_entry` | Stop `a` | Time stop `T` |
|---|---|---|---|---|
| MR-01-A | 5 min | 3.0 | 4% | 30 min |
| MR-01-B | 15 min | 3.0 | 5% | 60 min |

**Signal** (ARCH §3.3, A-M08-02), at the close of a complete 15 s bar of a pool that is eligible at that moment:
1. `robustZ(pool, L) ≤ −3.0`, with the scale = MAD/0.67449 of 15 s returns over 6 h, and `sqrt_time` scaling.
2. Effective depth has not fallen more than 10% over `L` (`depthLamportsClose` now vs `L` ago).
3. No fee-config change in the last 10 min (ARCH §8.4 `fee_config_known`).
4. Real/effective quote ≥ 0.5 (ARCH §8.4).
5. `REGIME` is clear: the basket 30-min return (`basketReturn`, watched pools) is not below −5%, and a null basket counts as blocked (ARCH §8.1; C-21); **and** the SOL/USD 30-min return is not below −3% (ARCH §8.1, D20).

**Ruling OPEN-7.** `REGIME` is applied in full. The recorder stores SOL/USD once a minute from Jupiter Price V3 (D20; ARCH M23 "Fiat"; within the ≤ 50% read rule; a Z08 item). On a UTC day without it:
- that day's signals are flagged `regime_basket_only`;
- the primary line uses the basket leg alone for that day;
- the report carries a caveat with the count of flagged signals.

Not applied, because Phase 0 has no M06 or M21: authority checks, holder checks, honeypot simulation and the soft dump flag. The report shows how many signals carried a dump flag.

**Repeats (ruling OPEN-8).** ARCH does not say how signals from one pool are counted while a position would still be open. Rule: after a signal, the same config ignores that pool for `T` (30 or 60 min), as a real position would block it. `ENTRYRATE` (≤ 1 MR entry per 10 min, all pools; ARCH §8.1) is **not** applied to the primary line, because it is a risk limit and it would cut a small sample further. An `ENTRYRATE`-thinned line (first signal in time wins; ties by pool id) is shown beside it.

The stop `a` and the median target are not used: this check measures fixed-horizon forward returns, as A05 defines it, not the config's exit path.

### 5.2 Delays and horizons

- **Delays:** 0, 1 and 2 bars. Entry time `t_e` = the close of the signal bar plus `d` × 15 s.
- **Entry price:** the spot price (effective reserves, A-M01-03) of the last snapshot in the entry bar. If that bar has no snapshot, use the next bar; if neither has one, the signal is dropped for that delay with reason `no_entry_price`. This is decided at entry time (A12).
- **Horizons:** 5, 15, 30 and 60 min after `t_e` (A05 "5–60 minutes"; the same set as A-24b).
- **Exit price:** spot at the last snapshot at or before `t_e + h`.

### 5.3 Returns

- **Raw return** `r = P(t_e + h) / P(t_e) − 1`, in bps.
- **Net per trade** at size `x`: `net = x × r − fees − impact − fixed`, in lamports, with the parts from §4.
- **Hurdle** `g*_cons(x)` = (fees + impact + fixed) / `x`, on the signal's own entry state. So "raw beats the hurdle" means mean `r` > mean `g*_cons`, which is the same as mean `net` > 0.

### 5.4 Matched random entries (A14)

For each kept signal: 10 random entries.
- **Pool:** the same pool.
- **Time:** the same UTC day and clock hour.
- **Volatility:** the same 6 h MAD decile. Deciles are cut over all eligible, complete pool-bars of that UTC day.
- **Candidates:** complete bars with non-null features where the pool is eligible, `t_e + 60 min` ends before the wall, and the bar is not the signal bar.
- **Draws:** 10 without replacement if there are at least 10 candidates, else with replacement.
- **Too few candidates:** with 0 candidates, widen to the same day ±1 h, then ±3 h. Still none: the signal stays in the raw-return test and is left out of the excess test, and is counted.
- The same delay, horizon and price rules as the signal apply.
- **Raw excess** `e = r − mean(r of its 10 random entries)`. It is shown in every cell.
- **Excess at size `x`** (ruling OPEN-9, test (b)) `e(x) = net(x) − mean(net(x) of its 10 random entries)`. Each random entry is charged the same per-size costs (§4) on its own entry state. It is shown in lamports and in bps of `x`.
- **Seeds:** the draw uses the A-M10-01 RNG with seed 1. Seeds 2–10 are run as a sensitivity range; only seed 1 decides.

### 5.5 Kill rule

Fixed now; it does not move after a look. Supervisor rulings of 2026-10-07 (before data): the PREREG declares **one** primary cell; MR-01 survives only if that cell clears both tests; every other cell is reported only.

- **Primary cell (ruling OPEN-9):**

  | Part | Value | Reason |
  |---|---|---|
  | Configuration | MR-01-A (`L` 5 min, `z` 3.0, `a` 4%, `T` 30 min) | The research behind A05 found most of the bounce falls in the first 5 minutes (`research/deep-pool-probe/RESULTS.md:25` on `ccr-7fae2302-drz4co`, cited in A05). The 5-min lookback is the config aimed at that. Its 30-min repeat block (§5.1) also lets more signals into one week than MR-01-B's 60 min |
  | Horizon | 30 min | MR-01-A's own time stop `T`, the longest it would hold. A 5-min horizon would pick the best-looking slice after the fact; `T` is fixed by ARCH §3.3 |
  | Delay | 1 bar (15 s) | A decision made at a bar close cannot fill at that same close (A-M08-01 closes bars 1.5 s after the end). Delay 0 is optimistic. The same research found a one-bar delay (5-min bars there) removed most of the bounce, so delay 1 is the honest test |

- **Sizes** (CLAUDE.md "Size is not the trial"): all five declared sizes, $5, $20, $100, $1,000 and $10,000 (§4).
  - A size flagged too small by the `k` cap is excluded as a whole. With the row in §4, that is $5.
  - At each remaining size, signals beyond the pool's 0.5% depth cap are excluded at entry (§4).
- **The two tests,** at the primary cell, for each remaining size `x`:
  - (a) mean `net(x)` > 0 under the conservative row: the raw return beats the conservative hurdle;
  - (b) mean `e(x)` > 0: the excess over matched random entries, with the same per-size costs (§5.4).
- **Verdict per size:**
  - **pass** if both tests hold;
  - **fail** if either does not;
  - **excluded** if the size is too small (`k`);
  - **insufficient** if fewer than 30 signals are left after the depth cap. This is ruling OPEN-11 and the C-34 minimum for an interval.
- **MR-01 verdict:**
  - **Survives** if one or more sizes pass.
  - **Killed** if no size passes and one or more sizes fail. Both configurations are killed together.
  - **Insufficient** if no size passes or fails. A05 then neither kills nor passes MR-01, and the A-24 and A-24b rules still apply in full.
- **Point estimates decide** (A05 as adopted). The intervals of §6 are reported beside them. A05's own caveat is that a week gives wide intervals.
- **Reported only:** MR-01-B, every other delay and horizon, the raw excess `e`, and the lean, 414,009 and stress lines. None of them can kill or save MR-01.
- **Recording the result.** A kill is recorded in `docs/DECISIONS.md` with this file's sha. MR-01 then stops (INTEGRATION M1; MIGRATION "M1 exit"). Survival only means MR-01 may go on to `W_B` and its gates.

## 6. Statistics (A14, A12, A-M13-03)

### Intervals

Each mean (`net` at each size and cost line, `r`, `e`) gets a two-sided 95% interval. The reported interval is the **more conservative** of two, meaning the one with the lower lower bound:
1. **Stationary bootstrap** (A-M13-03 step 1): 10,000 resamples, trades in entry-time order, mean block `b = max(1, round(n^(1/3)))`, the most conservative of `b/2`, `b`, `2b`, RNG seed 1.
2. **Calendar-day cluster t-interval:** UTC entry-day means weighted by trade count, `D − 1` degrees of freedom.

Also reported:
- **DEFF** = cluster variance of the mean ÷ IID variance of the mean;
- effective `n = n / DEFF`;
- `n` and `D` (days).

No interval is reported with `n < 30`; the cell says "n < 30" (C-34).

### Exclusion table (A12)

Every output has one. Rows:
- signals seen;
- dropped at entry time, by reason: not eligible, incomplete bar, null feature, depth fall, fee-config change, real/effective, `REGIME`, repeat within `T`, `no_entry_price`, horizon past the wall;
- random-entry shortfall (widened, or none);
- horizon crossing a coverage gap.

Exclusions happen only at entry time (A12).
- A pool that stops producing data keeps its last price (A12 "dead pools keep their last close").
- A horizon that crosses a recorder coverage gap uses the last price before `t_e + h`, and the trade stays in.
- A sensitivity line sets those trades to −100%.

### Viewed-window ledger (A12)

`research/phase0/VIEWED.md` is append-only. Each row: UTC time, session, days touched, streams, purpose, commit sha.
- Before the first run, nobody reads a price, bar, return or feature from D1 onward.
- Ops checks of recorder health (coverage counts, disk, sizes, credit use) are allowed. They are logged as "ops, no prices".
- After the first run, D1 to the wall are "viewed" for MR-01: no `affectsReturns` value may later be chosen from them without a re-test on unviewed days (A12).

## 7. A-48: recorder volume and coverage

Per day and per stream (A-M13-01 step 6; ARCH M07):
- compressed bytes, the codec, and the compression ratio (raw estimated from decoded size);
- snapshots, watched pools, and pool-seconds;
- coverage: expected vs recorded polls, gap time by reason, and `lowCoverage`;
- reads per provider per day against 50% of each provider's documented limit (CLAUDE.md "Carried from the Blueprint build"; MIGRATION "Phase 0 read provider").

Projection:
- a 30-day disk projection against the 55 GB disk (A01; MIGRATION Z08) and against the recorder's halt cap (MIGRATION "Recording disk rule");
- the ARCH assumption of a 3–5× zstd ratio and 0.31–0.52 GB a day (A-48) set against the measured values.

**M1 coverage bar:** 48 h unattended with snapshot coverage ≥ 95% of watched pool-minutes (MA-0b; INTEGRATION M1).

## 8. Outputs

The report is written to `docs/phase0/report-<D1>.md` plus CSVs (A-M13-01). It must be byte-for-byte reproducible from the same inputs and code sha (A-M13-01 acceptance).

**Tables**
- **T1** A-24 per day: eligible (upper bound), canonicality unknown, max simultaneous, enumeration coverage, low coverage, pools only in vendor.
- **T2** A-24 decision: days with ≥ 10, decision days, rule met.
- **T3** A-24b per horizon: pooled median, p75, p90; pools; windows. Plus per-pool medians (CSV).
- **T4** Hurdle: median pool `g*` (lean and conservative) at $10; fixed monthly term at 1, 2, 5, 10, 20 trades a day for each `M` line; move-rule verdict per horizon.
- **T5** Conservative row, lean line, 414,009 line and stress line, part by part, in lamports.
- **T6** A05 counts per config: signals, kept, dropped by reason; dump-flag count; signals per day.
- **T7** A05 raw return per config × delay (0, 1, 2) × horizon (5, 15, 30, 60): n, mean, median, interval, DEFF, effective n.
- **T8** A05 excess `e`: same grid as T7, plus the seed 2–10 range.
- **T9** Size sweep per config × delay × horizon × size: mean gross, fees, impact, fixed, net, in lamports and in bps of `x`; interval of net; "excluded (k)" flag; count "excluded (depth)". One block each for the conservative, lean, 414,009 and stress lines.
- **T10** A05 at the primary cell: per size, tests (a) and (b), n after the depth cap, and the verdict (pass, fail, excluded, insufficient); then MR-01's verdict. The same two tests for every other cell, marked "reported only".
- **T11** `ENTRYRATE`-thinned line: T7 and T9 at the primary cell.
- **T12** A-48 per stream and day; disk projection; provider reads against limits.
- **T13** Exclusion table (A12), for A-24b and for A05.
- **T14** Coverage per day, and the days used.

**Figures** (one per item; each also as CSV)
- **F1** Eligible pools per day, with the 10-pool line.
- **F2** A-24b absolute move distribution per horizon, with both hurdle lines.
- **F3** A05 mean raw return and its interval by horizon, one panel per delay, per config, with the mean conservative hurdle.
- **F4** A05 mean excess and its interval by horizon, one panel per delay, per config, with zero.
- **F5** Net per trade by size (log scale of `x`) at the primary cell, the four parts stacked.
- **F6** Bytes per day per stream, and the disk projection.

**Caveats** (A-M13-01 step 7, plus this study):
- the counts are pre-screening upper bounds;
- enumeration coverage;
- A-24b says nothing about whether drops revert [ST-04];
- no sub-hour Solana-DEX evidence exists for MR (ARCH §3.2);
- a week gives few signals (A05);
- the M06/M21 checks that are missing;
- the `REGIME` leg used (OPEN-7);
- the lost-rent rate is not measured (OPEN-5).

## 9. Review and run

- A fresh reviewer, who did not write this file, checks it against the cited lines before the first run (A16).
- The study code (A-M13-01) is reviewed and red-teamed before it reads any recorded day (CLAUDE.md "Carried from the Blueprint build").
- The first run happens once, after the wall, on the commit named in the run record. Any rerun reproduces it byte for byte. A changed result needs a new trial entry.

## 10. Amendments

- Allowed only before the first run (A16).
- Each amendment is dated, says what changed and why, and is checked by a fresh reviewer before it lands.
- After the first run nothing here changes; a new idea is a new trial with its own PREREG and unviewed days.
- Filling in the "Record when recording starts" table is not an amendment.
- Ruling an OPEN point is an amendment. Each ruling is written into this file before R0.

### 2026-10-07: supervisor rulings on the open points (before R0, no data recorded)

Rulings by the supervisor (session_01UQmXJHSgmb2Tj7PK7VDKRz) on head `1b933ef6`, applied in the next commit. A fresh reviewer checks them before R0.

| # | Point | Ruling |
|---|---|---|
| OPEN-1 | Window when coverage is low | Accepted: grow day by day to 7 good days, up to D14; else `insufficient_days` |
| OPEN-2 | `features.robust_z_scaling` (C-20) | Accepted: `sqrt_time` |
| OPEN-3 | Fixed monthly cost `M` | Accepted: two lines, $10 and $59 ($10 + Helius Developer $49, LD-27, while O7 is open); decide on the higher |
| OPEN-4 | Sizes | Accepted: lamports at `P_SOL` $150; dollar labels approximate |
| OPEN-5 | Lost-rent rate | Accepted: 0.145, marked unmeasured |
| OPEN-6 | Fixed-cost cap `k` | Accepted: 1% |
| OPEN-7 | `REGIME` | Changed: applied in full, with SOL/USD recorded once a minute (D20, Jupiter Price V3, Z08). A day without it: signals flagged, basket leg only, caveat |
| OPEN-8 | Repeats and `ENTRYRATE` | Accepted |
| OPEN-9 | Primary cell | Changed on size: MR-01-A × 30 min × delay 1 bar, at all five sizes. Too-small (`k`) sizes and signals beyond the depth cap are excluded. MR-01 is killed unless the cell clears both tests at one or more remaining sizes. Per size: pass, fail or excluded. Test (b) uses the same per-size costs |
| OPEN-10 | One config fails | Closed: only the primary cell decides |
| OPEN-11 | Fewer than 30 signals | Accepted: "insufficient" |

My reading, for the reviewer to check:
- The depth cap is applied per signal at entry, because pool depth varies by signal.
- A size with fewer than 30 signals left after the cap is "insufficient" (OPEN-11 applied per size).
- MR-01 is killed when no size passes and at least one size fails. It is "insufficient" when no size passes or fails.

No open points remain.
