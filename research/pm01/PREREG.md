# PM-01 pre-registration: rules fixed before any data is looked at

PM-01 is the Blueprint's second strategy track and, with MR-01 parked (C-76), the only one the agents run (ARCH §3.2, §3.3, D08). This file fixes every rule, parameter, cost, window, test and kill rule **before** any PM-01 signal or return is computed on any data. It follows the research PREREG discipline of A16 (SPEC-A A-M13-02, C-67), the historical-study rules of A12 (C-63) and the gate statistics of A14 (C-65).

Written from documents only. No market data was read, no provider was called and nothing was downloaded. Every number below is either copied from a cited Blueprint document, derived from those documents (marked DERIVED), or fixed here as a choice with its reason (marked CHOICE). Numbers that need data are named in §12 with the way each is fixed before the first run; none is guessed.

## 1. What earlier evidence predicts

The evidence predicts that PM-01 **loses money**. PM-01 is therefore tested only to confirm or refute it. It is never traded in any mode, paper included, unless it passes every gate below ("No knowingly losing trades").

| Evidence | What it says | Source |
|---|---|---|
| Hour-1 runner | Buying every graduate at 60 min after migration lost 22.4% a trade (median −11.1%, 442 usable coins, created 2026-08-21 to 09-06) | RS-24; `docs/MIGRATION.md` "Research carried in" |
| Relaxed U2 | Zeroed's U2 rules (graduates 60–240 min) lost 10.6% a $2 trade (95% CI −15.3% to −5.5%, 109 trades). Its days (22 Sep–2 Oct) are inside the B3 contaminated window | PR #267; MIGRATION B3 |
| Overlap | PM-01's window (20–120 min) overlaps U2's (60–240 min) at 60–120 min | MIGRATION "Owner summary checked" |
| Graduation window | 0 of 72 rules positive after costs, including +5 min momentum (holdout-window data) | RS-29 |
| Post-migration collapse | About 73% of migrated coins fell below 40% of the migration price within 20 min (pre-BOOST data) | ST-10 |
| Manipulation | 82.8% of coins that gained > 100% showed manipulation; wash volume in thin pools | ST-19, ST-21 |
| Costs | Fresh-graduation strategies need about 2.7–4.3% gross a trade on the lean row (ARCH §2.4 item 2). On the binding conservative row the hurdle is higher (§5 below: about 4.4–5.1% at $5–$20 before the monthly cost) | ARCH §2.1–2.4; A-M10-03 |

What is **not** known: PM-01's own rule (a 15 s breakout above the post-migration high with depth rising) has never been tested on any data. Its neighbours lost, so the prior is a loss, not a proof of one. This file exists so the test can refute PM-01 cleanly or, if the data says otherwise, show it with evidence that cannot have been tuned.

## 2. Identity and registration

- `strategyId = pm01`, `strategyVersion = 1.0.0`.
- Exactly **2 configurations** (§4.6). That is the MinBTL budget for a 30-day `W_B` at an assumed best annualised Sharpe of 2 (ARCH §3.4 table; A-M13-02 step 4). No other configuration may be added.
- **Pushed before data.** This file is pushed and its commit is read back with `git ls-remote` before any PM-01 signal or return is computed. The PR's merge commit on the integration branch (`ccr-14987baf-i6lrsl`, ARCH §3.4) is the registered version; its sha is quoted in the `preRegister` record (A-M13-02) and in every run bundle.
- **"First run"** = the first computation of any PM-01 signal, trade or return on any data. Signal counts produced by tests on synthetic fixtures are not a run.
- **Amendments** are allowed only before the first run, each as a dated commit to this file, pushed and checked with `git ls-remote`, reviewed by a fresh reviewer who did not write it (A16). After the first run nothing here changes; any change is `pm01` version 2 under a new PREREG, tested only on days no earlier `pm01` run has seen.
- Seeds (CHOICE; A-M10-01 RNG): bootstrap seed `1347235889` (the bytes "PM01" read as a big-endian integer); random-entry seed `1347235890`. Changing a seed is a new trial.

## 3. Universe: a pinned, reproducible list

**Data source.** Gates B and R read only self-recorded M07 data at 1 Hz, built into complete 15 s bars by M08 (A19, C-68; ARCH §3.4 "Survivorship and look-ahead"). Vendor bars, hourly bars and any data collected before 2026-10-07 are not used (C-52, A02). The B-10 history days (§6.3) are read only for B-10's crash counts.

**List for UTC day D** (one file per day, written by the recorder side before any PM-01 run reads day D):

1. Every `CompletePumpAmmMigrationEvent` decoded from chain data (A-M03-02; the migration is verified on chain, never taken from a third-party feed) whose block time is in `[D 00:00Z − 120 min, D+1 00:00Z)`. This covers every pool whose entry window overlaps day D.
2. Kept only if: the pool is a canonical PumpSwap pool (`pool.creator` equals the pump pool-authority PDA for the base mint, ARCH §8.4 `pool_canonical`); the quote mint is wSOL. Nothing else filters the list: dead, rugged, drained and never-traded pools stay in it (survivorship-free).
3. File `pm01-universe-D.csv`, UTF-8, LF line ends, no BOM, no trailing spaces, header line exactly:
   `slot,tx_index,ix_index,signature,block_time_utc,base_mint,pool,quote_mint`
   one row per migration, `block_time_utc` as `YYYY-MM-DDTHH:MM:SSZ`, addresses and signature in base58, rows sorted by `(slot, tx_index, ix_index)` ascending.
4. Its sha256 over the exact file bytes is recorded in the day's M07 manifest (A-M05-03) and in every run that reads day D. A run refuses a day whose file hash differs from the manifest.

**For the B-10 history pull.** The Old Faithful pinned migration list for day D (`research/z-h-estimate/OLD-FAITHFUL.md` §2, "The PM-01 universe is a pinned input") must be a superset of `pm01-universe-D.csv`. The replay derives the day's list from it with rules 1–3 above, so the result is deterministic and its sha256 is checkable. K3 retention for each listed pool runs from the migration slot to **migration + 300 min** (§12, proposal PM01-P5): last entry before migration + 120 min, time stop 120 min, plus 60 min for the exit ladder. A position still open when the pool's data ends is closed by the pessimistic `no_data` rule (ARCH §9.3), never dropped.

## 4. Rules (no free parameter left)

### 4.1 Bars and prices
- Spot price of a pool at a snapshot = effective quote reserve ÷ base reserve (effective quote = vault balance + `virtual_quote_reserves`, signed i128, EX-09), in SOL per token, exact rationals; doubles only inside features (A-M08-02).
- 15 s bars from M08 (A-M08-01). A bar is complete when ≤ 20% of its expected snapshots are missing (ARCH §8.5). Bar `high` = highest snapshot price in the bar; `close` = last snapshot price.
- Bar 0 is the first complete 15 s bar that **starts** at or after the migration's block time.

### 4.2 Eligibility at a decision (all at the decision snapshot; any check that cannot be computed fails closed)
- `pool_age`: decision time in `[migration + 20 min, migration + 120 min)` (ARCH §8.4).
- Hard checks of ARCH §8.4 as M06 implements them, at their PM thresholds: `min_depth` effective quote ≥ 85 SOL (85,000,000,000 lamports); `real_vs_effective_quote` ≥ 0.6; `fee_ceiling` ≤ 125 bps per side; `top10_holders` ≤ 35%; `single_holder` ≤ 10%; `lp_withdrawable_max`; `pool_canonical`; `venue_enabled`; `fee_config_known`; `mint_*` and `t22_*` checks; `metadata_matches_mint`; `mayhem_or_special`; `usdc_quote`; `honeypot_sim`; `dump_flag` (hard for PM). Soft checks (`metadata_mutable`, `creator_balance`, `insider_network`) are logged and change nothing in PM-01's decision.
- **`dump_flag` needs a PM baseline.** As written, M08's `dumpFlagState` uses returns from `now − 6 h` to `now − 30 min` and needs 50% coverage (A-M08-02 step 5, `features.min_coverage_bps`). A pool at most 120 min old can never reach that, so every PM-01 decision would be `insufficient` → `error` → no entry. This file therefore registers the PM baseline in proposal PM01-P1 (§12): returns from bar 0 to `now − 30 min`, with the 50% coverage rule over that span and a span of at least 10 min. So the first decision with a valid flag is at migration + 40 min. The 30-min dump window and the −4 × MAD rule are unchanged (no loosening of a hard check). **If the supervisor rules otherwise, this section is amended before the first run.**
- Data freshness guards of ARCH §8.5 (observation lag ≤ 12 slots at decision, ≤ 8 at build).
- Every 15 s bar from bar 0 to the decision bar is complete. One incomplete bar means the post-migration high is unknown, so no decision is made in that pool (fail closed; counted as `start_missing` or `gap`, §8.3).

### 4.3 Signal (evaluated at the close of each complete bar `t` inside the window)
- Post-migration high `H(t)` = highest bar `high` over bars 0 … t−1.
- **Breakout:** `close(t) > H(t)` (strict; the close, not the high, so the move must hold to the bar's end).
- **Depth rising:** effective quote at `close(t)` > effective quote at `close(t − 4)` (strict; 4 bars = 60 s; CHOICE: the shortest look-back that spans more than one minute of 1 Hz snapshots). In a constant-product pool buying raises both price and effective quote, so this mostly holds on a breakout; it rejects breakouts made while liquidity is being withdrawn. Stated so nobody reads it as an independent filter.
- **One entry per pool** (CHOICE): only the first signal in each pool is taken, whether or not it fills. Reason: one decision per coin keeps trades independent of each other's exits and stops re-entry after a stop in a dumping pool.

### 4.4 Entry and execution
- Decision at the close of bar `t`. The order goes through the engine's own order, position and risk code (ARCH §9.2) and is filled by the M10 fill model of the frozen `fillModelVersion`, with its latency model. This file adds no fill rule; no fill may use a price observed before the decision.
- Entry slippage bound 150 bps; exit slippage bound 300 bps (ARCH §8.3 PM). Exits use the escalation ladder (ARCH §8.7).
- Size: §5.

### 4.5 Exits (all armed at once from the first evidence the buy landed; ARCH §8.6)
| Exit | Rule |
|---|---|
| Fixed stop | Mark (exit-quote value, net of estimated exit costs) ≤ −`stopBps` (§4.6) |
| Trailing stop | After the mark first reaches +800 bps, exit when it falls 800 bps below its high-water mark |
| Target | Mark ≥ +1,500 bps |
| Time stop | 120 min after entry |
| Universal exits | Liquidity collapse, authority or extension change, venue fee-config change or venue disabled, cannot-sell detection, as ARCH §8.6 |

### 4.6 The two configurations
| Key (`strategy.pm01.params.*`, `affectsReturns` = true) | Config A (declared primary) | Config B |
|---|---|---|
| `stopBps` | 800 | 1,500 |
| `trailArmBps`, `trailBps` | 800, 800 | 800, 800 |
| `targetBps` | 1,500 | 1,500 |
| `timeStopMs` | 7,200,000 | 7,200,000 |
| `entryFromMs`, `entryToMs` (after migration) | 1,200,000, 7,200,000 | same |
| `minEffQuoteLamports`, `minRealRatioBps` | 85,000,000,000, 6,000 | same |
| `depthRisingBars` | 4 | 4 |
| `maxEntriesPerPool` | 1 | 1 |
| `entrySlippageBps`, `exitSlippageBps` | 150, 300 | same |
| `fixedCostCapBps` (`k`, conservative row) | 200 | 200 |

The two differ only in the stop (CHOICE, made without data): A matches the trailing distance (800 bps), B matches the target distance and ARCH's upper stop bound (1,500 bps; bounds 300–1,500, ARCH §8.6). ARCH fixes every other value. Every other `affectsReturns` key (engine risk config, `features.*`, cost and fill model versions) is frozen in the `configKey` (A-M13-02).

**Fixed-cost cap `k` = 200 bps on the conservative row** (ARCH §2.3, A-M10-03 `fixedShareBps`; CHOICE). Reason: PM-01's venue fee alone is about 250 bps a round trip, so fixed costs above 2% would make the fee-plus-fixed hurdle far above any move the earlier evidence has shown. At 1% (MR's value) every $5 trade would be refused (conservative fixed share about 1.23%, §5), and under today's risk ceilings no size above about $8.5 can be held (§5.2). So 1% would leave PM-01 untestable at any size the engine allows.

## 5. Sizes and costs

### 5.1 Sizes, fixed in lamports
Sizes are fixed in lamports, so SOL/USD never moves a result ("Profit is counted in SOL"). The dollar labels hold at `P_SOL` = $150 only (ARCH §1.5, a parameter, not a price).

| Label | Lamports | Role |
|---|---|---|
| $5 | 33,333,333 | **Gate size** (B, R, P decide here) |
| $20 | 133,333,333 | Reported line |
| $100 | 666,666,667 | Reported line |
| $1,000 | 6,666,666,667 | Reported line |
| $10,000 | 66,666,666,667 | Reported line |

### 5.2 Why $5 decides (DERIVED from ARCH §8.1 and A21; approximate, verify in the A-M10-03 implementation)
- A21 sets PM-01's stressed gap prior at about 8,270 bps. `MAXRISK` prices a trade at notional × 82.7% plus its round-trip cost, and its hard ceiling is 50,000,000 lamports (ARCH §8.1, §3.5). That caps a PM-01 trade at about **57,000,000 lamports (about $8.5)** at the minimum eligible depth. $20 and above cannot be held under today's ceilings.
- At $5 the stressed risk plus conservative round-trip cost is about 29,200,000 lamports, inside the ceiling.
- **Engine equity for every gate run** (CHOICE): `E_bt` = 20,000,000,000 lamports (20 SOL) with the **live-small** limit profile (the stricter one). Then `MAXRISK` = 0.25% `E` = 50,000,000; `MAXRISK_PF` = 100,000,000 (two $5 positions fit, `MAXOPEN` = 2); `MAXPOS` = min(1% `E`, 66,666,667) admits $5; `MAXEXP` = 2% `E` = 400,000,000. So percentage limits never shrink the $5 size, and count limits (`MAXOPEN`, `PERTOKEN`, per-token daily entries, `LOSSRUN`, `DAYLOSS`) work as in the engine. `REGIME` and `ENTRYRATE` are MR-only (ARCH §8.1).
- **Reported lines** ($20 to $10,000) run the same rules with `E_bt` = 600 × size and every lamport ceiling scaled by size ÷ $5 (proposal PM01-P3). They are never gate inputs. For each, the report states the ceilings and equity that size would need; raising any ceiling is the owner's alone.
- `DEPTHPCT` (≤ 0.5% of min(real, effective) quote) is never scaled: it is market depth, not a limit. A size above it is **refused, not shrunk**, in every line, so each line's trade count shows plainly how many pools could take that size.

### 5.3 Cost rows (A-M10-03, C-50, C-77)
Every trade is costed on three rows, each in lamports, with its parts shown apart:

| Part | What it holds |
|---|---|
| Gross | Pool price move from entry fill to exit fill, before any cost |
| Percentage | Venue fees on both sides, read from chain per trade (tier and creator fee per pool, A08); sandwich expectation (strict and conservative rows) |
| Impact | Exact constant-product round trip on the pre-trade pool state, both sides charged, sells sized to the real vault (ARCH §2.1; VF-05) |
| Fixed | Base, priority and tip per leg; failed-attempt overhead; janitor close; rung-2 expectation; plus, in the conservative row, unrecovered rent and dust priors; stuck term (`fFail³ × out`) in strict and conservative |
| Monthly | $59 a month (D04, Helius Developer counted until the owner rules, C-77) amortised per trade at the window's measured trade rate |

**Binding:** the conservative row plus the $59 monthly share decides every return-based gate (B-2, B-6, B-8, R-2, R-3, R-4, P-2, P-2b, P-3; SPEC-A A-M13-06 step 1). The lean and strict rows and the 414,009-lamport line are shown and decide nothing.

### 5.4 What the costs look like before any data (DERIVED; ARCH §2.1 formulas and A-M10-03 parameters at 1.25% per side; illustrations only, not inputs)

Round-trip break-even gross move `g*` in bps of notional. Fixed lamports per round trip: lean about 51,440; conservative about 409,247 (strict 174,740 + 0.145 × 1,513,840 unrecovered rent + 15,000 dust; approximate, the A-M10-03 code fixes the exact values).

| Size | Fits `DEPTHPCT` at Q 85 / 200 SOL | Fees | Impact at Q 85 | Fixed (cons.) | Sandwich + stuck (cons.) | `g*` lean at Q 85 | `g*` conservative at Q 85 |
|---|---|---|---|---|---|---|---|
| $5 | yes / yes | 248 | 8 | 123 | 44 + 78 | 279 | **514** |
| $20 | yes / yes | 248 | 31 | 31 | 44 + 78 | 291 | 444 |
| $100 | no / no | 248 | 153 | 6 | 44 + 77 | 414 | 546 |
| $1,000 | no / no | 248 | 1,341 | 0.6 | 40 + 68 | 1,843 | 1,972 |
| $10,000 | no / no | 248 | 6,077 | 0.1 | 26 + 31 | 16,140 | 16,289 |

The $59 monthly cost adds, per trade (DERIVED: 393,333,333 lamports ÷ (30 × trades a day × notional)):

| Size | 1 trade a day | 2 a day | 5 a day |
|---|---|---|---|
| $5 | 3,933 bps | 1,967 | 787 |
| $20 | 983 | 492 | 197 |
| $100 | 197 | 98 | 39 |
| $1,000 | 20 | 10 | 4 |

Plain reading: at $5, PM-01 needs an average gross gain of roughly 5% a trade plus the monthly share (about 8% more at 5 trades a day) to break even. Above about $38 (0.255 SOL, the `DEPTHPCT` cap at the minimum depth) the pool is too thin to take the trade at all; at $1,000 and $10,000 impact alone is 13% and 61%. So PM-01 could only ever profit at small sizes, in a band capped by pool depth, and the earlier evidence says it does not profit there either.

## 6. Windows: walk-forward and the untouched holdout

### 6.1 Days that may never be used
- The B3 contaminated window, **2026-09-22T00:00Z to 2026-10-21T00:00Z** (MIGRATION B3; SPEC-A A-M13-06).
- The Helius day 2026-09-21 (`HELIUS_DAYS`).
- Any day used by the Phase 0 study week (A-M13-01 step 8, C-26), if one runs.
- Any day of an earlier PM-01 window, and any window logged as viewed in the M13 viewed-window ledger (A12, C-63).

### 6.2 Forward windows (all self-recorded, in time order, disjoint)
| Window | Starts | Ends | Use |
|---|---|---|---|
| `W_B` selection | 00:00Z of the latest of: 2026-10-21; the first UTC day after this PREREG is merged and `preRegister` is recorded; the first UTC day after any Phase 0 study week; the first UTC day whose M07 manifest passes coverage for PM-01's universe (§8.3) | At 80% of `W_B` (whole UTC days, rounded down) | Run both configs; select one (§7.2) |
| `W_B` final 20% | After the selection part | `W_B` end | B-8's untouched part of `W_B` |
| `W_R` | 00:00Z of the first UTC day after `W_B` ends | When both hold: ≥ 14 days and ≥ `n_R` closed trades (§7.3) | Gate R: the untouched out-of-sample holdout (owner item 6) |
| `W_P` | After `replay_passed` | ≥ 21 days and P-1's trade count | Paper dry run (§10) |

- `W_B` is at least 30 days. It ends at the first UTC midnight at which it has ≥ 30 days and ≥ 300 closed trades of the selected config, and B-5 is recomputed for its real length (ARCH §3.4 B-1). Trade **counts** may be read while `W_B` runs, to say when it will end; **no return** is computed on any `W_B` day until `W_B` has ended.
- **Embargo and purge** (ARCH §3.4 out-of-sample protocol): a trade whose holding period crosses a segment boundary (selection | final 20%, `W_B` | `W_R`) is dropped from both sides and counted. Entries in the first 300 min after a boundary are not taken (300 min = the longest hold, §3).
- **Regime breaks** (A12, A16): any venue upgrade or fee-config change inside a window that L-4 would flag is a hard boundary; trades crossing it are dropped and each side is reported. Whether a window continues across it is proposal PM01-P4.
- **Dates today.** The recorder is not running yet (server paused), so no calendar date can be named. Each window's start and end are written to `docs/DECISIONS.md` on the day they are fixed by the rules above, and A-M13-05 refuses any overlap (`E_WINDOW_OVERLAP`).
- **Calendar.** With `W_B` starting no earlier than 2026-10-21, `W_B` + `W_R` end no earlier than 2026-12-04, and later if trades come slowly. If PM-01's gates are still running on 31 Dec 2026, the OWNER PENDING clause of C-56 applies (ARCH D08).

### 6.3 B-10 history days
B-10 replays the selected config transaction by transaction on the Old Faithful days (2026-07-23 to 08-21 with lead-in 07-22; ARCH §3.4 B-10) with the replay key on. Those runs count **only** crashes, illegal states and unreconciled intents; none of their trades enter any return statistic (C-78). They are not a walk-forward fold and they decide nothing about profit. They lie before regime boundaries B3 (2026-09-09) and B4 (2026-09-12), which does not matter for crash counts.

## 7. Primary metric, tests and sample size

### 7.1 Primary metric
Mean net return per trade **in SOL**: (SOL received − SOL spent − every cost on the conservative row − the trade's $59 monthly share) ÷ SOL spent, all in lamports, at the $5 gate size, for the selected config. Trades are `ok` closed trades; `shadow` and `recovered` are excluded (A-M13-06 step 1).

### 7.2 Selection in `W_B`
- Each config's mean (§7.1) on the selection part. The higher one is selected; a tie selects Config A.
- B-4 (N ≤ 3 trials): the config with the higher mean on the first half of `W_B` must also have the higher mean on the second half (ARCH §3.4).
- The selected config's `configKey` is frozen at that point. `W_R` runs only that config.

### 7.3 Tests (none loosened; the stricter of this file and the Blueprint holds)
- **Interval (A14, C-65):** the more conservative (lower lower bound) of (a) the stationary bootstrap 95% CI of the mean, 10,000 resamples, mean block `b = max(1, round(n^(1/3)))`, the most conservative of `b/2`, `b` and `2b` (A-M13-03 step 1), and (b) a calendar-day cluster t-interval at 95%. DEFF (same-day design effect) is reported.
- **Gate B on `W_B`:** B-1 ≥ 300 closed trades; B-2 lower bound > 0; B-3 DSR ≥ 0.95 over every trial on overlapping data; B-4 as §7.2; B-5 trials ≤ MinBTL budget; B-6 t ≥ 3.0; B-7 max drawdown ≤ 20% of `E_bt`; B-8 positive mean in the final 20% and in every calendar week of `W_B`; B-9 10 identical replays; B-10 (§6.3). Beside B-2: the lower bound of (rule − matched random) > 0 (§9).
- **Gate R on `W_R`:** R-1 ≥ 14 days and ≥ `n_R` = max(300, `n_80`) trades; R-2 lower bound > 0, and (rule − matched random) lower bound > 0; R-3 mean ≥ 50% of the `W_B` point estimate; R-4 point estimate > 0 with 2 × p95 latency and 2 × `p_sw`, and A21's directional stress; R-5 max drawdown ≤ 15% of `E_bt`; R-6 crash-day report.
- **Power (owner item 6):** `n_80 = ⌈DEFF × ((1.960 + 0.842) / S_low)²⌉`, `S_low` the lower bound of the selected config's per-trade net Sharpe 95% interval on `W_B` (A-M13-06 step 4). It cannot be computed before `W_B`. For orientation only (DEFF = 1): `S_low` 0.05 → 3,141 trades; 0.10 → 786; 0.20 → 197 (DERIVED). If `S_low` ≤ 0, R-1 fails and the case goes to the owner; if `n_R` needs more than 90 days of `W_R` at `W_B`'s trade rate, it goes to the owner and nothing passes.
- **≥ 300 out-of-sample trades** in `W_R`, whatever `n_80` says (R-1).

### 7.4 Reported beside the tests (decide nothing)
Lean and strict rows; the 414,009 line; the five sizes; a delayed-entry line (one more 15 s bar of delay); A22's skew reporting (outcome bins ≤ stop, small loss, 0–2×, 2–10×, 10–50×, ≥ 50×; the loss bill; week-clustered intervals; the top 1% of trades' share of P&L; A22's capped mean, whose unit A-M13-04 fixes; with a +1,500 bps target it should rarely bind); hold-SOL and JitoSOL baselines (C-56).

## 8. Study hygiene (A12, C-63)

### 8.1 Exclusions at entry time only
A pool is excluded only for a reason known at the decision. No field observed after the decision is ever used (no all-time high, no later market cap, no later holder count).

### 8.2 Dead pools stay
A position whose pool stops producing data is closed by the `no_data` rule (ARCH §9.3), never dropped.

### 8.3 Exclusion table in every report
Per window: migrations listed; pools with `start_missing` (no complete bar 0); pools with a `gap` before a decision; pools refused by each hard check; signals refused by `DEPTHPCT` per size; signals refused by `k`; trades purged at boundaries. Two sensitivity lines: every trade whose data stopped while open taken at −100%; and every `start_missing` or `gap` pool that reached the depth floor treated as a −100% trade. **Coverage rule for `W_B`:** a UTC day counts only if its M07 manifest shows complete bars from bar 0 for ≥ 95% of that day's listed pools (CHOICE; below that, the day is `low_coverage` and skipped, never filled).

### 8.4 Viewed-window ledger
Every computation of a PM-01 signal or return on any day is logged in M13's viewed-window ledger with the days it read. No `affectsReturns` value may come from a viewed window without a re-test on unseen days; none comes from the H8, H9 or H11 studies.

## 9. Random-entry benchmark (A-M13-06, C-65)

- For each PM-01 trade, 10 random entries in the **same pool** and the **same UTC hour**, drawn with the random-entry seed, from complete 15 s bar closes inside that pool's PM window where every entry-time filter of §4.2 passes (the size's `DEPTHPCT` and `k` included) but the breakout and depth-rising conditions are not required. Each random entry runs the same config's exits and costs.
- C-65's third key, the 6 h MAD decile, cannot exist for a pool at most 120 min old, and C-65's overlap rule uses MR's lookback `L`. The PM reading is proposal PM01-P2: MAD of 15 s returns from bar 0 to the candidate bar, deciles over all candidate bars of the same window; `L` = 60 s (the depth-rising look-back), so a candidate whose holding period overlaps `[signal − 60 s, signal]` is dropped.
- Fewer than 10 candidates: all are used. None: the trade counts in §7 but not in the excess test; `n_b` (trades with at least one random entry) is reported.
- Excess per trade = trade net return − mean net return of its random entries, on the conservative row. Test: §7.3's interval on the excess, lower bound > 0, beside B-2 and R-2.

## 10. Live dry run: what counts as consistent

PM-01 can reach paper at most (`enabled_modes` ⊆ {backtest, replay, paper}; A-M09-03). Before `replay_passed` it makes no paper trade at all, not even shadow (MIGRATION "Clashes", line on shadow trades).

In `W_P`, at the $5 gate size with the same `E_bt` profile scaled to the paper wallet's `E`:

- **Binding (Blueprint):** P-1 to P-6, P-9 and P-10, owner items 3 and 4 inside them. **Consistency with the backtest is P-3:** the paper mean is not below `W_R`'s 95% interval lower bound (§7.3's interval).
- **Consistency flags** (CHOICE; decide no pass, but each one blocks promotion until the supervisor records an evidence-based explanation in `docs/DECISIONS.md`): (a) paper mean above `W_R`'s interval upper bound (a result better than the replay suggests a model or data fault, never luck to bank); (b) paper trades a day outside 0.5× to 2× of `W_R`'s rate; (c) the share of stop exits more than 15 percentage points from `W_R`'s share; (d) realised explicit cost above 1.25 × modelled over the window (LS-2's ratio).

## 11. Kill rules: what stops PM-01 for good

PM-01 stage → `failed` (absorbing; A-M13-05 step 3) when any of these happens. After that, PM-01 version 1 is never re-run on the same days, never traded and never shadowed; a revised rule enters only as a new version through the M09 slot, pre-registered and tested on days no PM-01 run has seen (D08).

1. Gate B evaluated with sufficient data (B-1 met, ≥ 30 days) and any of B-2 to B-10 fails, or the matched-random excess lower bound is ≤ 0.
2. Gate R evaluated with sufficient data and any of R-2 to R-6 fails, or the excess lower bound is ≤ 0.
3. R-1 power: `S_low` ≤ 0 on `W_B`. The Blueprint sends this to the owner; this file's recommendation is stop.
4. `W_B` reaches 90 days with fewer than 300 closed trades (CHOICE, mirroring R-1's 90-day rule): B-1 cannot be met in a usable time; the case goes to the owner with the recommendation stop.
5. Gate P fails P-2, P-2b, P-3 or P-4 with sufficient data.
6. The C-56 end state: if PM-01 has not passed by 31 Dec 2026, the OWNER PENDING clause applies; no new PM work starts after that date.
7. A venue change (L-4 kind) that changes PM-01's trade economics in the middle of `W_R`, if the supervisor rules (PM01-P4) that the windows cannot continue across it.

A gate that is only `pending_data` never kills and never passes.

## 12. Numbers that need data or a ruling, fixed before the first run

| # | Number | How it is fixed | Before |
|---|---|---|---|
| PM01-P1 | PM `dump_flag` baseline (start, coverage, minimum span) | Supervisor ruling (proposal in §4.2), then an M08 change with its `affectsReturns` key | First run |
| PM01-P2 | Random-entry matching for PM (MAD look-back, `L`) | Supervisor ruling (proposal in §9) | First run |
| PM01-P3 | Ceilings and `E_bt` for the reported sizes | Supervisor ruling (proposal in §5.2) | First run |
| PM01-P4 | Whether a window continues across a market boundary | Supervisor ruling | First run |
| PM01-P5 | K3 retention horizon (migration + 300 min) | Supervisor ruling, recorded with the OF-3 retention choice | Batch 3 of the Old Faithful pull |
| — | Exact stressed gap prior (A21 says "about 8,270") | A-M10-04 freezes it in the parameter set; §5.2 is recomputed and amended if it changes the $5 verdict | First run |
| — | Exact cost-row lamports (rent account size, janitor priority) | A-M10-03 code and golden tests; §5.4 is illustration only | First run |
| — | A21 directional stress (`g`, `N`) | A-M10-04 / A-M11-03 tickets; recorded here by amendment | First run |
| — | `n_80`, DEFF, `S_low` | Computed on `W_B` by A-M13-06 | Start of `W_R` |
| — | PM-01's trade rate | Counted while `W_B` runs (counts only, §6.2) | — |
| — | Window dates | Fixed by §6.2's rules and written to DECISIONS on the day | Each window's start |
| — | `honeypot_sim` and holder state in recorded `W_B` data | If the engine cannot supply them from M07 records, every entry fails closed; that is a defect to fix in the data path, never a check to skip ("Discipline, not paralysis") | First run |
