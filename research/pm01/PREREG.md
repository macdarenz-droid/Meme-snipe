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
- **"First run"** = the first computation of any PM-01 signal, trade or return on any data. If the screen (§6.4) has not run, the first trade count computed during `W_B` is logged as the first run, in the M13 registry; that freezes this file and closes the `preRegister` record (R10-70). Signal counts produced by tests on synthetic fixtures are not a run. Pulling the B-10 days, checking them (QA, parity) and measuring their storage (pool counts, bytes) is not looking at them: no PM-01 signal, trade or return is computed on any pulled day before this file's merge sha is recorded (R4-19).
- **Amendments** are allowed only before the first run, each as a dated commit to this file, pushed and checked with `git ls-remote`, reviewed by a fresh reviewer who did not write it (A16). After the first run nothing here changes; any change is `pm01` version 2 under a new PREREG, tested only on days no earlier `pm01` run has seen.
- Seeds (CHOICE; A-M10-01 RNG): bootstrap seed `1347235889` (the bytes "PM01" read as a big-endian integer); random-entry seed `1347235890`. Changing a seed is a new trial. Draw order is fixed (R4-17): one RNG stream per purpose (bootstrap, random entries), each seeded once; trades are iterated by `(config id, entry slot, tx_index, inner_ix_index)` ascending (config id `A` before `B`; R5-35), and random-entry candidates of a trade by bar close time ascending, so the bootstrap and the random entries replay bit for bit.

## 3. Universe: a pinned, reproducible list

**Data source.** Gates B and R read only self-recorded M07 data at 1 Hz, built into complete 15 s bars by M08 (A19, C-68; ARCH §3.4 "Survivorship and look-ahead"). Vendor bars, hourly bars and any data collected before 2026-10-07 are not used (C-52, A02). The B-10 history days (§6.3) are read only for B-10's crash counts and the kill-only screen (§6.4), which can stop PM-01 and never pass it.

**List for UTC day D** (one file per day, written by the recorder side before any PM-01 run reads day D):

1. Every `CompletePumpAmmMigrationEvent` decoded from chain data (A-M03-02; the migration is verified on chain, never taken from a third-party feed) whose block time is in `[D 00:00Z − 120 min, D+1 00:00Z)`. This covers every pool whose entry window overlaps day D. A pool can therefore be listed on two days; a trade belongs to the UTC day of its decision, and each pool is counted once (R4-17).
2. Kept only if: the pool is a canonical PumpSwap pool (`pool.creator` equals the pump pool-authority PDA for the base mint, ARCH §8.4 `pool_canonical`); the quote mint is wSOL. Nothing else filters the list: dead, rugged, drained and never-traded pools stay in it (survivorship-free).
3. File `pm01-universe-D.csv`, UTF-8, LF line ends, no BOM, no trailing spaces, header line exactly:
   `slot,tx_index,ix_index,inner_ix_index,signature,block_time_utc,base_mint,pool,quote_mint`
   one row per migration, `block_time_utc` as `YYYY-MM-DDTHH:MM:SSZ`, addresses and signature in base58, rows sorted by `(slot, tx_index, ix_index, inner_ix_index)` ascending. `ix_index` is the outer instruction's index in the transaction; `inner_ix_index` is the index of the event's inner (`emit_cpi`) instruction under it.
4. Its sha256 over the exact file bytes is recorded in the day's M07 manifest (A-M05-03) and in every run that reads day D. A run refuses a day whose file hash differs from the manifest.

**For the B-10 history pull.** The Old Faithful pinned migration list for day D (`research/z-h-estimate/OLD-FAITHFUL.md` §2, "The PM-01 universe is a pinned input") must be a superset of `pm01-universe-D.csv`. The replay derives the day's list from it with rules 1–3 above, so the result is deterministic and its sha256 is checkable. No M07 manifest exists for history days, so each day's sha256 is recorded in the `B10-PULL` row of `docs/DECISIONS.md` before the screen (§6.4) runs. K3 retention for each listed pool runs from the migration slot to **migration + 300 min** (PM01-P5, accepted as the proposal for the OF-3 step, §13; the supervisor records it in DECISIONS with the measured sizes before batch 3): last entry before migration + 120 min, time stop 120 min, plus 60 min for the exit ladder. A position still open when the pool's data ends is closed by the pessimistic `no_data` rule (ARCH §9.3), never dropped.

## 4. Rules (no free parameter left)

### 4.1 Bars and prices
- Spot price of a pool at a snapshot = effective quote reserve ÷ base reserve (effective quote = vault balance + `virtual_quote_reserves`, signed i128, EX-09), in SOL per token, exact rationals; doubles only inside features (A-M08-02).
- 15 s bars from M08 (A-M08-01). A bar is complete when ≤ 20% of its expected snapshots are missing (ARCH §8.5). Bar `high` = highest snapshot price in the bar; `close` = last snapshot price.
- Bar 0 is the first complete 15 s bar that **starts** at or after the migration's block time.

### 4.2 Eligibility at a decision (all at the decision snapshot; any check that cannot be computed fails closed)
- `pool_age`: decision time in `[migration + 20 min, migration + 120 min)` (ARCH §8.4).
- Hard checks of ARCH §8.4 as M06 implements them, at their PM thresholds: `min_depth` effective quote ≥ 85 SOL (85,000,000,000 lamports); `real_vs_effective_quote` ≥ 0.6; `fee_ceiling` ≤ 125 bps per side; `top10_holders` ≤ 35%; `single_holder` ≤ 10%; `lp_withdrawable_max`; `pool_canonical`; `venue_enabled`; `fee_config_known`; `mint_*` and `t22_*` checks; `metadata_matches_mint`; `mayhem_or_special`; `usdc_quote`; `honeypot_sim`; `dump_flag` (hard for PM). Soft checks (`metadata_mutable`, `creator_balance`, `insider_network`) are logged and change nothing in PM-01's decision.
- **`dump_flag` PM-01 baseline (ruled, PM01-P1, §13).** As written, M08's `dumpFlagState` uses returns from `now − 6 h` to `now − 30 min` and needs 50% coverage (A-M08-02 step 5, `features.min_coverage_bps`). A pool at most 120 min old can never reach that, so every PM-01 decision would be `insufficient` → `error` → no entry. For **PM-01 only**, the baseline runs from migration (bar 0) to `now − 30 min` and needs at least 10 min of data (40 complete 15 s bars); the 50% coverage rule still applies over that span. Under 10 min stays `insufficient` (fail closed). So the first valid entry is at migration + 40 min; `entryFromMs` stays 1,200,000, and decisions from 20 to 40 min fail closed on this check. The 30-min dump window and the −4 × MAD rule are unchanged (no loosening of a hard check). Every other strategy keeps the 6 h baseline. The report splits entries at the baseline: at least 60 min of baseline (entry at migration + 90 min or later) against under 60 min, and gives both lines (§7.4). The gates use all entries.
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
Sizes are fixed in lamports, so SOL/USD never moves a result ("Profit is counted in SOL"). The dollar labels hold at `P_SOL` = $150 only (ARCH §1.5, a parameter, not a price). $150 is used only for these labels and the §5.4 illustration; the monthly cost is converted at recorded rates (§5.3).

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
- **Reported lines** ($20, $100, $1,000 and $10,000) run the same rules with `E_bt` = 600 × size and every lamport ceiling scaled by size ÷ $5 (ruled, PM01-P3, §13). They are reported only, never gate inputs, and never a change to the bot's ceilings. Each line shows gross return, fixed costs, percentage fees and price impact apart (§5.3). For each, the report states the ceilings and equity that size would need; raising any ceiling is the owner's alone.
- `FEEDAY` (2,000,000 lamports a day on the live-small profile) is never scaled either, in any reported line, the same as `DEPTHPCT` (R8-61).
- `DEPTHPCT` (≤ 0.5% of min(real, effective) quote) is never scaled: it is market depth, not a limit. A size above it is **refused, not shrunk**, in every line, so each line's trade count shows plainly how many pools could take that size.

### 5.3 Cost rows (A-M10-03, C-50, C-77)
Every trade is costed on three rows, each in lamports, with its parts shown apart:

| Part | What it holds |
|---|---|
| Gross | Pool price move from entry fill to exit fill, before any cost |
| Percentage | Venue fees on both sides, read from chain per trade (tier and creator fee per pool, A08) |
| Sandwich | Sandwich expectation (strict and conservative rows), its own line |
| Impact | Exact constant-product round trip on the pre-trade pool state, both sides charged, sells sized to the real vault (ARCH §2.1; VF-05) |
| Fixed | Base, priority and tip per leg; failed-attempt overhead; janitor close; rung-2 expectation; plus, in the conservative row, unrecovered rent and dust priors |
| Stuck | Stuck term (`fFail³ × out`), strict and conservative rows, its own line |
| Monthly | $59 a month (D04, Helius Developer counted until the owner rules, C-77) amortised per trade at the window's measured trade rate, converted to lamports at the window's recorded SOL/USD for each day (M23; SPEC-A A-M13-04 step 7; R4-12), never at $150. The monthly USD figure is frozen for each window at the window's start and written in `docs/DECISIONS.md` with the window dates; a later ruling on it applies only to windows that start after it (R5-27). At the window's start the figure is copied into the run bundle (USD value, the DECISIONS commit sha, the row text); the run refuses only if the figure read at evaluation differs from the copy (R6-38, R7-52). R-3 and P-3 compare two windows with the higher of the two windows' figures on both sides (R6-38) |

**Binding:** the conservative row plus the $59 monthly share decides every return-based gate (B-2, B-6, B-8, R-2, R-3, R-4, P-2, P-2b, P-3; SPEC-A A-M13-06 step 1). The lean and strict rows and the 414,009-lamport line are shown and decide nothing.

### 5.4 What the costs look like before any data (DERIVED; ARCH §2.1 formulas and A-M10-03 parameters at 1.25% per side; illustrations only, not inputs)

Round-trip break-even gross move `g*` in bps of notional. Fixed lamports per round trip: lean about 51,440; conservative about 409,247 (strict 174,740 + 0.145 × 1,513,840 unrecovered rent + 15,000 dust; approximate, the A-M10-03 code fixes the exact values).

| Size | Fits `DEPTHPCT` at Q 85 / 200 SOL | Fees | Impact at Q 85 | Fixed (cons.) | Sandwich (cons.) | Stuck (cons.) | `g*` lean at Q 85 | `g*` conservative at Q 85 |
|---|---|---|---|---|---|---|---|---|
| $5 | yes / yes | 248 | 8 | 123 | 44 | 78 | 279 | **514** |
| $20 | yes / yes | 248 | 31 | 31 | 44 | 78 | 291 | 444 |
| $100 | no / no | 248 | 153 | 6 | 44 | 77 | 414 | 546 |
| $1,000 | no / no | 248 | 1,341 | 0.6 | 40 | 68 | 1,843 | 1,972 |
| $10,000 | no / no | 248 | 6,077 | 0.1 | 26 | 31 | 16,140 | 16,289 |

The same break-even moves in lamports and SOL (DERIVED: `g*` × the size's lamports, rounded down; illustrations only):

| Size | Lamports | `g*` lean (lamports) | `g*` lean (SOL) | `g*` conservative (lamports) | `g*` conservative (SOL) |
|---|---|---|---|---|---|
| $5 | 33,333,333 | 929,999 | 0.00093 | 1,713,333 | 0.00171 |
| $20 | 133,333,333 | 3,879,999 | 0.00388 | 5,919,999 | 0.00592 |
| $100 | 666,666,667 | 27,600,000 | 0.0276 | 36,400,000 | 0.0364 |
| $1,000 | 6,666,666,667 | 1,228,666,666 | 1.2287 | 1,314,666,666 | 1.3147 |
| $10,000 | 66,666,666,667 | 107,600,000,000 | 107.6 | 108,593,333,333 | 108.59 |

The $59 monthly cost adds, per trade (DERIVED at the $150 illustration rate only: 393,333,333 lamports ÷ (30 × trades a day × notional); a real run converts at the recorded daily SOL/USD, §5.3):

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
| `W_B` selection | 00:00Z of the latest of: 2026-10-21; the first UTC day after this PREREG is merged and `preRegister` is recorded; the first UTC day after any Phase 0 study week; the first UTC day whose M07 manifest passes coverage for PM-01's universe (§8.3) | After the first floor(0.8 × `d`) UTC days of `W_B`, `d` = `W_B`'s length in **calendar** UTC days, fixed once `W_B` has ended (R5-24) | Run both configs; select one, once, after `W_B` ends (§7.2) |
| `W_B` final 20% | After the selection part | `W_B` end | B-8's untouched part of `W_B` |
| `W_R` | The UTC midnight at which `W_B` ends (no gap day) | When all hold: ≥ 14 days, ≥ `n_R` closed trades and the effective-size rule (§7.3) | Gate R: the untouched out-of-sample holdout (owner item 6) |
| `W_P` | After `replay_passed` | ≥ 21 days and P-1's trade count | Paper dry run (§10) |

- **Days** (R5-24): split points and boundaries (the 80/20 split, B-4's halves, B-8's weeks) are set in calendar UTC days; every count (the 30 days, the 20-day effective-size rule) uses counted days only. A `low_coverage` day stays where it falls on the calendar, inside the selection part, the final 20% or a half, and adds no day and no trade to it.
- `W_B` ends at the first UTC midnight at which it has ≥ 30 counted days, and ≥ 300 closed trades and the effective-size rule of §7.3 for **every** config in it (the count-only config of §6.4 included), after purge and embargo (R4-2). `low_coverage` days (§8.3) are not counted days. B-5 is recomputed for its real length (ARCH §3.4 B-1). Trade **counts** may be read while `W_B` runs, to say when it will end; **no return** is computed on any `W_B` day until `W_B` has ended. The selection then runs once.
- **No peeking in `W_R` and `W_P`** (R4-3): no return is computed on any `W_R` or `W_P` day until that window has ended, and each window is evaluated once. Counts may be read to say when it will end.
- **Embargo and purge** (ARCH §3.4 out-of-sample protocol): a trade whose holding period crosses a segment boundary (selection | final 20%, `W_B` | `W_R`) is dropped from both sides and counted. Entries in the first 300 min after a boundary are not taken. The longest hold is about 180 min (120-min time stop plus 60 min for the exit ladder); 300 min is the K3 horizon from migration (§3), kept because it is the stricter of the two.
- **Regime breaks** (A12, A16; ruled, PM01-P4, §13): any venue upgrade or fee-config change inside a window that L-4 would flag is a hard boundary; trades crossing it are dropped and each side is reported. **Watched programs and accounts** (R4-11; pinned, R5-33): see the table below. L-4 hashes only the listed economic fields of each config account, plus each program's upgrade (its program-data account), so a change to an admin key or a bump does not end a window. A boundary comes **only** from L-4's automatic flag (the slot plus the changed program or config account hash), logged before any return of that window is computed; nobody may declare one afterwards (R4-3). What happens next depends on its class:

  | Class | Kinds of change | Effect on the window | Known boundaries (`docs/research/venues.md` §2.7) |
  |---|---|---|---|
  | Economic | Any fee change; a change to the reserves or pricing maths; any change to migration or graduation parameters; a new mandatory account or an instruction that changes cost; a change in who is paid a fee; a `disable_flags` change; a rent-per-byte change | Ends the window it falls in, except a fee-only change (below); counts restart after it, with the 300-min embargo above. Inside `W_R` or `W_P` it also voids `W_B`'s selection (see below) | B1 (adds `virtual_quote_reserves`, which §4.1's price reads: reserves maths; "none seen" in 3–6 blocks is not proof), B2 (BOOST: liquidity held back and bought-and-burned), B3 (fee and creator-fee config), B4 (holder rewards: who is paid the creator fee), B5 (new pump `sell_v3` and `buy_exact_quote_in_v3`; counted economic, not tested, R13-94) |
  | Decoder-only | Layout-only changes (event or account bytes added or moved, same economics) | Reported; the window continues | None of B1–B5 |

  | Program or account | Address | Economic fields hashed by L-4 | Source |
  |---|---|---|---|
  | pump (bonding curve) program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | program upgrade | pinned IDL `research/historical/rpcscan/idl/pump.json` (sha256 `ffe966c4…`), `packages/core/test/chain/fixtures/idl-pinned.json` |
  | pump `Global` | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` | `initial_virtual_token_reserves`, `initial_virtual_sol_reserves`, `initial_real_token_reserves`, `token_total_supply`, `fee_basis_points`, `fee_recipient`, `create_v2_enabled`, `whitelist_pda`, `enable_migrate`, `pool_migration_fee`, `creator_fee_basis_points`, `fee_recipients`, `reserved_fee_recipient`, `reserved_fee_recipients`, `mayhem_mode_enabled`, `is_cashback_enabled`, `buyback_fee_recipients`, `buyback_basis_points`, `initial_virtual_quote_reserves`, `whitelisted_quote_mints`, `creator_fee_configurable`, `max_configurable_creator_fee_bps`, `is_holder_reward_enabled` | field names from the pinned `pump.json` type `Global`; address from `packages/core/src/chain/programs.ts` (`PUMP_GLOBAL`) |
  | pump AMM (PumpSwap) program | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | program upgrade | pinned IDL `research/historical/rpcscan/idl/pump_amm.json` (sha256 `20914338…`) |
  | pump AMM `GlobalConfig` | `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` | `lp_fee_basis_points`, `protocol_fee_basis_points`, `disable_flags`, `protocol_fee_recipients`, `coin_creator_fee_basis_points`, `whitelist_pda`, `reserved_fee_recipient`, `reserved_fee_recipients`, `mayhem_mode_enabled`, `is_cashback_enabled`, `buyback_fee_recipients`, `buyback_basis_points`, `boost_enabled`, `creator_fee_configurable`, `max_configurable_creator_fee_bps` | field names from the pinned `pump_amm.json` type `GlobalConfig`; address from `programs.ts` (`PUMP_AMM_GLOBAL_CONFIG`) |
  | fee program (`pump_fees`) | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | program upgrade | pump_fees entry sha256 `d87b5230…` in `packages/core/test/chain/fixtures/idl-pinned.json` (R6-41) |
  | pump `FeeConfig` (owned by the fee program) | `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` | `flat_fees`, `fee_tiers`, `stable_fee_tiers`, `exotic_flat_fees` | field names from the pinned IDLs' type `FeeConfig`; address from `programs.ts` (`PUMP_FEE_CONFIG`) |
  | pump AMM `FeeConfig` (owned by the fee program) | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | as the row above | address from `programs.ts` (`PUMP_AMM_FEE_CONFIG`) |
  | Rent sysvar | `SysvarRent111111111111111111111111111111111` | `lamports_per_byte_year`, `exemption_threshold` (`burn_percent` excluded: it sets how much collected rent is burned rather than paid to validators, which changes nothing the bot pays or gets back; R6-44) | **VERIFY**: not in the pinned IDLs; the address appears in `packages/worker/src/run/live-sim.ts`. Source for the fields: the Solana SDK `Rent` struct (`solana_program::rent::Rent`) in the `solana-program` 1.18 release line; the exact patch version is pinned and recorded here when the check is done (R6-44) |

  **Fields added in round 6** (R6-40): `fee_recipient` is hashed because it decides who is paid the protocol fee (a "who is paid a fee" change). `create_v2_enabled` is hashed because it decides whether new coins are created as Token-2022 mints (`docs/research/venues.md` F7), which changes the universe and the mint checks PM-01 runs. `whitelist_pda` (in both `Global` and `GlobalConfig`) is hashed, and a change to it is always economic (R7-54): the repo does not document what the whitelist controls.

  **VERIFY items.** (1) The two config addresses come from `programs.ts`, not from the IDL files: the pinned IDLs give program IDs and field layouts only. Before the first run, each address is re-derived from its PDA seeds in the pinned IDL, and the result is recorded here. (2) No IDL field is named for the graduation threshold. Graduation follows from the bonding curve's reserves (`initial_real_token_reserves` above). If the pinned IDL shows another field that sets it, that field is added by amendment before the first run. (3) Rent sysvar fields, as in its row.

  **Decoder-only test, mechanical** (R6-37a, R7-47): an upgrade is decoder-only only if no listed economic field changed and all of these hold over the full UTC day after it, recomputed from the pre-upgrade fields:
  1. every AMM swap's amounts match;
  2. every migration event's pool seed amounts match the pinned formula from the `Global` fields;
  3. every bonding-curve buy and sell matches;
  4. every swap's fee transfers (recipient and amount, per leg) match the pre-upgrade split;
  5. accounts and rent, from transaction data only (R10-68, replacing R9-65): for each buy and sell on that day, (a) the swap instruction's account list matches the pinned pre-upgrade IDL's list for that instruction; and (b) every account created inside the swap instruction (its inner create-account or associated-token-account instructions), with its size and rent lamports, is one the rule table below allows for that instruction. Whether an account existed before the trade is read from the transaction's own metadata (**VERIFY**: which fields the Old Faithful transaction metadata carries for this). Accounts that the user's own other instructions in the same transaction create are not checked. A local simulator running the pre-upgrade program bytes stays an optional stronger check; its absence does not fail part 5.
  6. new swap instructions (R12-81, replacing R11-73's unscoped part 6). A buy or sell instruction the pinned pre-upgrade IDL does not have is not economic by itself. Its trades are decoded with the refreshed pinned IDL and must pass parts 1–4 on the pinned pre-upgrade formula and fee split. For part 5, each of its accounts is mapped by role to the old instruction's account it replaces: by the same PDA seeds and the same deriving program id, or by the same ATA owner, mint and token program; anything else is unmapped (R13-93), and each account it creates must match that role's rule-table row. An unmapped role or any mismatch makes the upgrade economic. Only an instruction that no pinned IDL can decode is economic on sight.
  7. program-side reserve changes (R11-75, R12-82, R13-89 to R13-91): every non-user instruction on the watched programs that changes pool or curve reserves on that day (`boost_buy_and_burn`, buybacks, fee withdrawals or sweeps that move reserves) has its amounts recomputed exactly from a pinned pre-upgrade rule where one can be pinned (for example from `buyback_basis_points`; **VERIFY**, start item 5.9). For each instruction type where none can, a normalised ratio is computed per event: buyback lamports ÷ fees collected in that pool that day, and boost burn ÷ the pool's swap volume. Events are pooled across universe pools, one sample per ratio type:
     - **Look-back** (R13-91): from the later of (boundary − 7 days) and the previous boundary's slot plus its pending period, to the boundary.
     - **Test** (R13-89, R13-90): one two-sample Kolmogorov–Smirnov test per ratio type, at a Bonferroni α = 0.01 ÷ the number of ratio types. A type is economic only if its test rejects **and** the median, the mean or the 90th percentile of its ratio moves by more than 10%. Requiring both keeps a large sample from flagging a trivial difference and a small one from missing a real one.
     - **Too few events** (fewer than 100 on either side, after the one extra pending day with cumulative counts): 0 events against 0 passes for that type; absent before and present after is economic; otherwise the event rates per unit of swap volume are compared with an exact Poisson rate-ratio test at the same α, and a rejection, with the same 10% size rule on the rate, is economic.
     - The upgrade is economic only if a test rejects under these rules, or an exact pinned rule fails. Method and thresholds are in `gates.boundary`.
     - **Event counts measured beforehand** (R13-89): when the B-10 days are read, each ratio type's daily event count on them is counted (events only, not a PM-01 signal) and recorded in `docs/DECISIONS.md` before the first run (start item 5.10).

  **Which IDL is "pre-upgrade"** (R11-73). Before the first run, post-UPG-1 IDLs for pump, PumpSwap and pump_fees are pinned through the source order below (R9-66, R10-71), and the rule table gets their v3 rows; this is start-condition item 5.6 (§6.4). For each boundary, the pre-upgrade IDL is the latest IDL pinned before that boundary's slot. Once a boundary is cleared or ruled economic, its refreshed IDL becomes the baseline for the next boundary, recorded in the boundary record. If no refreshed IDL was pinned, the baseline stays the previous pinned IDL; every later boundary is judged against it, with new instructions handled by part 6 (R12-86).

  **Transaction source for the pending day** (R11-74). For the B-10 days, Old Faithful. For the forward windows (`W_B`, `W_R`, `W_P`), first choice: for the pending UTC day after any L-4 flag, the capture path writes the raw transactions it already reads for the watched programs, with inner instructions and metadata, to the recorder, with no extra provider reads (**VERIFY** that the capture path carries them; proposed for card Z08's acceptance). Fallback: fetched through the rate limiter at no more than 50% of the provider's documented limit, (i) the swaps in the universe pools that day, up to `gates.boundary.fallbackSwapCap` (the N; R12-87), (ii) every migration of the day, (iii) curve trades, up to `gates.boundary.fallbackCurveTradeCap` (R13-92), and (iv) every program-side reserve instruction on universe pools (R12-83). Samples are stratified per UTC hour; where a cap binds, the first trades by slot within each hour are used and the shortfall is reported. A test part with no data makes the upgrade economic, and the report says which part. If neither source is in place by the first run, every forward upgrade is economic. Expected restart rate in that case (DERIVED, approximate): the watched programs had program upgrades on 6 dates from 2026-07-01 to 10-02 (B1, B3, B4, 09-15, 09-23, B5; `docs/research/venues.md` §2.7), about one every 15 days, so `W_B` would usually restart, and kill rule 4's 120-day clock would then send PM-01 to the owner; inside `W_R` or `W_P`, R4-3's one-restart limit does (R12-88).

  **Rule table for part 5(b)** (pinned now from the pinned IDLs, `pump_amm.json` sha256 `20914338…` and `pump.json` sha256 `ffe966c4…`; R10-68). For each created account (R11-76): its size equals the table size; its lamports after creation are at least the rent-exempt minimum for that size under the Rent sysvar in effect; and the rent the user paid equals max(0, minimum − the account's balance before the trade), so a pre-funded address passes. v3 rows are added when the post-UPG-1 IDLs are pinned (start-condition item 5.6).

  | Instruction | Accounts it may create | Size (bytes) |
  |---|---|---|
  | pump AMM `buy`, `buy_exact_quote_in` | `user_base_token_account`, `user_quote_token_account` (associated token accounts); `user_volume_accumulator` | token accounts: 165 for SPL Token, 170 for a Token-2022 ATA (measured, `docs/research/venues.md`:145; **VERIFY** per mint for any further extensions); `user_volume_accumulator`: 137 (`docs/research/venues.md` §2.3 and :145) |
  | pump AMM `sell` | `user_quote_token_account` (associated token account) | 165 |
  | pump `buy`, `buy_exact_sol_in` | `associated_user` (associated token account); `user_volume_accumulator` | as above |
  | pump `buy_v2`, `buy_exact_quote_in_v2` | `associated_base_user`, `associated_quote_user` (associated token accounts); `user_volume_accumulator`, `associated_user_volume_accumulator` | as above |
  | pump `sell`, `sell_v2` | `associated_quote_user` (v2 only) | 165 |
  | pump `sell_v3`, `buy_exact_quote_in_v3` | added from the pinned post-UPG-1 IDL (start-condition item 5.6) | — |

  **VERIFY** (R11-78): whether a swap itself can create any of these: `protocol_fee_recipient_token_account` and `coin_creator_vault_ata` (AMM); `associated_quote_fee_recipient`, `associated_quote_buyback_fee_recipient` and `associated_creator_vault` (curve v2); and, for `sell_v2`, `user_volume_accumulator` and `associated_user_volume_accumulator`. Each is resolved from golden fixtures of real transactions, including first trades in new pools, not from the IDL alone. Until then they are not in the table, so a swap that creates one fails part 5 (fail closed).

  "The pinned formula" is the on-chain integer arithmetic: the decoder's quote function with its golden tests, not the exact-rational spot price of §4.1. Any failure, or any instruction that cannot be decoded, makes the upgrade economic. "Cannot be decoded" is judged against the post-upgrade IDL, refreshed and pinned (R8-59). The refreshed IDL comes from, in this order (R9-66, R10-71): (1) the program's on-chain IDL account, read at a slot after the upgrade, if the program has one (**VERIFY**: whether these programs keep an on-chain IDL account); (2) the IDL file the program's owner publishes, at a commit this repo first fetched after the upgrade slot; the first fetch time and the fetched commit sha are recorded in the boundary record. Commit dates are never used. Its sha256 is pinned in the boundary record. A hand-edited IDL never counts. If neither exists by the end of the pending period, the upgrade is economic. If the decoder is updated in the middle of a window, the updated decoder must reproduce every decision on the pre-boundary data, as a B-9-style check, before it is used.

  **Pending boundary** (R7-48, R8-58): the boundary is pending from the flag's slot to the end of the first full UTC day after it; the test runs on that full day, and the verdict follows it. While it is pending, the window's counts pause and no entry counts; nothing is voided. If the test clears it, the window continues and the pending period is reported. If not, the boundary is economic from its slot.

  **Fee-only change** (R6-37b, R7-49): an economic change where only these changed does not end the window (R8-57): `lp_fee_bps` and `protocol_fee_bps` inside any `FeeConfig` `Fees` entry: `flat_fees`, `fee_tiers`, `stable_fee_tiers` and `exotic_flat_fees` (R9-64); `market_cap_lamports_threshold` of the tiers; and the `GlobalConfig` `lp_fee_basis_points` and `protocol_fee_basis_points` and the `Global` `fee_basis_points`. Every trade in the window, before and after the change, is costed per trade and per side at the higher of the old and new fee of the schedule that trade pays under (flat, tiered, stable or exotic; R9-64); the random-entry benchmark is costed the same way; the window is reported split at the change. A change to `creator_fee_bps` (in any `FeeConfig` `Fees` entry, `stable_fee_tiers` and `exotic_flat_fees` included) or `coin_creator_fee_basis_points`, to any other creator or holder fee, to `fee_recipient` or any fee-recipient list, to `is_holder_reward_enabled` or to `creator_fee_configurable` ends the window, as does every other economic change. B5 stays counted economic and is **not tested** (R13-94): testing it would need reads outside the B-10 allow-list, and it affects no window, since it predates every PM-01 window. For the record, the evidence points to decoder-only: on SOL markets, quotes, accounts, fees and rent were unchanged, the quote goldens reproduce exactly, and the v3 instructions were seen only on token-quoted curves (`docs/research/venues.md` §2.7). B1–B5 all lie before 2026-10-21, so none falls inside `W_B` or `W_R`; they show how a new boundary is classed.

  **Economic boundary inside `W_R` or `W_P`** (supervisor, 8 Oct 9:30 AM; §13): that window ends and `W_B`'s selection is void, because it was made in the old regime. A new `W_B` selection runs on data after the boundary (after the embargo), then a new `W_R` and `W_P` follow in order. Limits (R4-3): a voided `W_R` keeps its pre-boundary segment as a kill-only check (kill rule 2: with ≥ 100 closed trades and the upper bound below 0, PM-01 stops; the check uses the lean row without the monthly share and the §6.4 kill-side interval, the highest upper bound over block lengths and interval types, because a stop-only check uses the lean row, C-77; R5-21. R-3 and P-3 use the conservative row; the difference is on purpose: a check that can only stop uses the lean row, a check that can pass uses the binding row; R6-43); at most one restart is allowed, and a second boundary that would restart goes to the owner; each voided `W_R` is counted in the report and in the B-3 trial registry. Each config run in the new `W_B` counts as a new trial in the trial budget (B-3 DSR, B-5 MinBTL), so B-5 is checked against the total trial count. **A `W_B` rerun after a boundary may need more than 30 days** to pass B-5. Inside `W_B`, an economic boundary ends `W_B` and it restarts after the boundary; no return has been computed yet (§6.2), so no selection is voided.
- **Dates today.** The recorder is not running yet (server paused), so no calendar date can be named. Each window's start and end are written to `docs/DECISIONS.md` on the day they are fixed by the rules above, and A-M13-05 refuses any overlap (`E_WINDOW_OVERLAP`).
- **Calendar.** With `W_B` starting no earlier than 2026-10-21, `W_B` + `W_R` end no earlier than 2026-12-04, and later if trades come slowly. If PM-01's gates are still running on 31 Dec 2026, the OWNER PENDING clause of C-56 applies (ARCH D08).

### 6.3 B-10 history days
B-10 replays the selected config transaction by transaction on the Old Faithful days (2026-07-23 to 08-21 with lead-in 07-22; ARCH §3.4 B-10) with the replay key on. Those runs count **only** crashes, illegal states and unreconciled intents; none of their trades enter any return statistic (C-78). They are not a walk-forward fold and decide nothing about profit, except the kill-only screen of §6.4, which can only stop PM-01. They lie before regime boundaries B3 (2026-09-09) and B4 (2026-09-12), which does not matter for crash counts.

### 6.4 Kill-only screen on the B-10 days (owner, 8 Oct 2026, 9:28 AM; fixed before any B-10 day is looked at)

The owner approved a one-time screen of PM-01's rules on the B-10 days that can stop PM-01 and can never pass it (owner's message, 8 Oct 2026, 9:28 AM, "Ok"; recorded in `docs/DECISIONS.md`, "PM-01 pre-registration"). Its rule is fixed here, before any of those days is read.

- **Start condition** (R4-7; R5-23 and R5-29). The screen refuses to start until all of these hold:
  1. Card Z-H prep **P12** is done (fee-config history kept or fetched), so `fee_config_known` and `venue_enabled` can be computed.
  2. Each §12 row the screen needs is fixed, as the "Fixed means" column of §12 says: PM01-P1 (the M08 change merged with its `affectsReturns` key), the exact stressed gap prior, the exact cost-row lamports, and A21's directional stress (`g`, `N`). The `honeypot_sim` and holder-state row is **not** required, because the screen uses assumed-pass for those inputs.
  3. The frozen-parameter block (§12) has no `null` value, this file is merged with it, and the merge sha is read back.
  4. The run recomputes the block's sha256 and the `configKey` from the merged file and refuses on any mismatch.
  5. Every VERIFY in §6.2 is closed and amended in (R6-45, R10-68):
     1. the config account addresses, re-derived from the pinned IDLs' PDA seeds;
     2. the graduation field;
     3. the Rent fields, with the pinned SDK patch version;
     4. which fields the Old Faithful transaction metadata, and the forward-window source (capture path or capped sample, R11-74), carry for "existed before" (part 5);
     5. Token-2022 token-account sizes per mint (part 5 rule table);
     6. whether the fee-recipient, buyback, creator-vault and `sell_v2` accumulator accounts can be created by a swap, from golden fixtures (part 5 rule table, R11-78); the post-UPG-1 IDLs for pump, PumpSwap and pump_fees pinned, with the v3 rows in the rule table (R11-73);
     7. whether these programs keep an on-chain IDL account (refreshed IDL source 1);
     8. an explicit choice recorded in `docs/DECISIONS.md` for the forward-window source (R12-85): capture path verified, fallback verified, or "every forward upgrade economic". The last choice decides whether PM-01 can finish, so the supervisor puts it to the owner, with the expected restart rate (about 1 per 15 days, DERIVED), before the first run;
     9. each exact pinned rule part 7 uses (for example from `buyback_basis_points`), or a record that none can be pinned for that instruction type (R13-95);
     10. each part 7 ratio type's daily event count on the B-10 days, recorded in `docs/DECISIONS.md` (R13-89).

     The optional simulator of part 5 is not a start condition.
- **After an early first run** (R11-79): if the first run has already happened through `W_B` (§2), the screen runs as a later run against the frozen file. It can still only stop PM-01.
- **Runs once** (R4-17). The screen runs exactly once, on the days that are clean in the `B10-PULL` row when all 30 decision days are done or declared missing. It is never rerun and never extended to 2026-08-22..09-20.
- **Data.** The B-10 days read from the Old Faithful archive (Triton) at 0 Helius credits and no new provider: 2026-07-22 to 2026-08-21, with 07-22 as lead-in only. Entries count only for decisions on 2026-07-23 to 2026-08-21 (UTC). The universe is §3's rules 1–3 applied to the pinned Old Faithful migration list, with each day's sha256 in the `B10-PULL` row (§3).
- **Bars** (R4-5). From the transaction-level replay, the pool state is sampled at 1 Hz as of block time: the sample for each second `s` is the last state, ordered by `(slot, tx_index, inner_ix_index)`, whose block time is ≤ `s` (R5-32). A skipped leader slot is not a missing block. `observedAtMs` is taken from block time, which gives zero observation lag; that is favourable to PM-01, and the report says so. Bar `high` and `close` come from those 1 Hz samples only, as M07 does live, never from states inside a second. A sample, and so a bar, is missing only where archive units or blocks are missing, never because no trade happened in it. Pools with missing bars are `start_missing` or `gap`, as in §8.3.
- **Rules.** Configs A and B exactly as §4. The M10 fill model, at the frozen `fillModelVersion`, uses the engine's own order, position and risk code with `E_bt` = 20 SOL on the live-small profile. Size is $5 (33,333,333 lamports; PM01-P3), never scaled. Each config runs isolated (§7.2).
- **Inputs that history cannot supply, both directions** (R4-4). `honeypot_sim` and holder state before the window are `replay_unavailable` and, with the replay-only key on, assumed to pass (C-78). This works both ways. It lets in trades the live bot would refuse, and those are plausibly worse (honeypots, concentrated holders who dump), which pushes the screen toward a kill. Other parts of the screen (the cost model below) push away from one. So the net direction is not known, and the kill rule below guards against the first effect.
- **Fail-closed until P12** (R4-19). `fee_config_known` and `venue_enabled` stay fail-closed in key-on runs until card Z-H prep P12 (fee-config history kept or fetched) is done (ARCH §3.4 B-10, C-78). Until then every screen entry fails closed, and the screen's result is `pending_data`. A key-on run cannot be registered as a trial (`registerTrial` returns `E_REPLAY_ASSUMED`), so the viewed-window ledger entry (§8.4) is its only record.
- **Cost model.** The **lean** row of §5.3: venue fees on both sides, per trade and per side, at the **lower** of the rate read from chain for that trade on that day and the rate the current fee schedule would charge the same trade. The current schedule is the venue's fee config read from chain when the screen runs, and its account data hash is recorded in the report; impact by the exact constant-product round trip; base and priority fees per leg. There is no sandwich term, no stuck term, no rent or dust prior and no monthly share. On the same fills the lean row costs no more than the binding conservative row with the monthly share.
- **Metric.** §7.1's mean net return per trade in SOL, at $5, but on the lean row. Interval (R4-6): for each of §7.3's two interval types, take the run with the **highest** upper bound (for the bootstrap, of the `b/2`, `b` and `2b` runs); then take the higher of the two intervals' 95% upper bounds.
- **Minimum count.** A config's result counts only with **at least 100 closed `ok` trades** on the entry days (CHOICE: about 3 a day over 30 days; fewer trades give an interval too wide to call a loss). Below that, the config's screen result is `pending_data`.
- **Kill rule, per config** (supervisor, 8 Oct 9:32 AM; R4-4). A config is **dropped** only when both hold: (a) on all its closed trades (at least 100), the upper bound above is **below 0**; and (b) on its closed trades whose exit was not cannot-sell, liquidity collapse or `no_data`, the upper bound computed the same way is also **below 0**, with at least 100 such trades (CHOICE: the same floor as (a); with fewer, the config is not dropped and its result is `pending_data`). PM-01 version 1 stops for good (§11 kill rule 7) when both configs are dropped. In plain words, a config is dropped when it clearly loses money on the cheapest costs, even after leaving out the trades that look like honeypots or rugs.
- **A dropped config** (R4-1). It is never selectable and never traded in `W_B`, `W_R` or `W_P`. It still runs in `W_B` as a **count-only gate trial**, registered for B-3 and B-5 with its real `W_B` Sharpe, so the DSR uses N = 2. B-4 then has a single candidate and is recorded as `B-4_single_candidate`, replaced by the stricter check in §7.2.
- **What it can never do.** It never passes, adds, selects, tunes or promotes anything; dropping only removes an option. A config that is not dropped (upper bound ≥ 0, or `pending_data`) goes on to `W_B` unchanged, and nothing about it is judged from these days. Both configs count in the trial budget (B-3, B-5), dropped or not. No `affectsReturns` value may come from these days (§8.4). Their trades never enter any gate statistic (C-78).
- **Regime.** These days lie after B1 and B2 and before B3 and B4 (§6.2 table). Fees are the lower of that day's and today's (Cost model above), so a change in fees cannot make the screen kill. The owner's approval takes a clear loss there as enough to drop a config. The report states the regime beside the result.
- **Report.** Per config: closed trades; the §8.3 exclusion table; the lean, strict and conservative rows (lean decides), each cost part shown apart; both intervals for all trades and for the subset of (b); the share of entries that relied on an assumed-pass input; holder concentration (`top10_holders`, `single_holder`) wherever the archive can compute it, with the share of entries where it can; the `dump_flag` fire rate.
- **First run.** The screen is PM-01's first run (§2). This file is frozen, and its merge sha recorded, before the screen reads any B-10 day. Each screen computation is logged in the viewed-window ledger (§8.4).

## 7. Primary metric, tests and sample size

### 7.1 Primary metric
Mean net return per trade **in SOL**: (SOL received − SOL spent − every cost on the conservative row − the trade's monthly share) ÷ the trade's notional, 33,333,333 lamports (0.0333 SOL, which was $5 at $150; fixed in lamports so the SOL accounting does not move with SOL/USD; R4-17), all in lamports, at the $5 gate size, for the selected config. "SOL spent" is the notional paid into the pool; costs are counted once, in the cost row. Trades are `ok` closed trades; `shadow` and `recovered` are excluded (A-M13-06 step 1). The metric is also reported with `recovered` trades included (decides nothing).

### 7.2 Selection in `W_B`
- The selection runs once, after `W_B` has ended (R4-2). Each selectable config's mean (§7.1) on the selection part (§6.2); the higher one is selected; a tie selects Config A.
- B-4 (N ≤ 3 trials): the config with the higher mean on the first half of `W_B` must also have the higher mean on the second half (ARCH §3.4). The halves are of the whole `W_B`, by calendar UTC days (the first floor(`d`/2) days, then the rest; `low_coverage` days stay where they fall, §6.2).
- **One selectable config** (a config dropped by §6.4; R4-1): B-4 is recorded as `B-4_single_candidate` and replaced by a stricter check fixed now: the surviving config's §7.1 mean (conservative row) is above 0 in each half of `W_B`, halves as above. It is never vacuous. The dropped config runs count-only (§6.4), so B-3's DSR uses N = 2. Acceptance case for A-M13-06: M13 never calls `rankStability` with fewer than 2 configs.
- The selected config's `configKey` is frozen at that point. `W_R` runs only that config.
- **Isolated configs** (R5-28): in every run (the screen, `W_B`, `W_R`, `W_P`), each config, the count-only one included, runs in its own engine instance with its own `E_bt` = 20 SOL and its own risk state (slots, exposure, loss counters). Nothing is shared. Acceptance test: config A's trade list is identical whether config B runs or not, and the same for B.

### 7.3 Tests (none loosened; the stricter of this file and the Blueprint holds)
- **Interval (A14, C-65):** the more conservative (lower lower bound) of (a) the stationary bootstrap 95% CI of the mean, 10,000 resamples, mean block `b = max(1, round(n^(1/3)))`, the most conservative of `b/2`, `b` and `2b` (A-M13-03 step 1), and (b) a calendar-day cluster t-interval at 95%. DEFF (same-day design effect) is reported.
- **Effective size** (R4-9): B-1 and R-1 also need ≥ 20 distinct UTC days with ≥ 1 closed trade, and no single day holding more than 10% of the window's trades; otherwise the window keeps running. `n`/DEFF is reported.
- **t-statistic** (R4-8): B-6 uses the t from the calendar-day cluster standard error (the same clusters as the interval). The iid t is reported beside it and decides nothing.
- **Drawdown bar** (R4-14): at `E_bt` = 20 SOL, a drawdown limit in % of `E` is inert (20% is 4 SOL, about 120 full $5 losses). B-7 and R-5 therefore also need max drawdown ≤ 20 × the $5 notional (666,666,660 lamports); the % of `E` limits stay as well.
- **Gate B on `W_B`:** B-1 ≥ 300 closed trades (and effective size); B-2 lower bound > 0; B-3 DSR ≥ 0.95 over every trial on overlapping data; B-4 as §7.2; B-5 trials ≤ MinBTL budget; B-6 cluster t ≥ 3.0; B-7 max drawdown ≤ 20% of `E_bt` and ≤ 20 × notional; B-8 positive mean in the final 20% and in every calendar week of `W_B` (weeks start Monday 00:00Z; a week is checked only when it holds ≥ 10 closed trades; an edge week with fewer is merged into the next week, or the previous one at `W_B`'s end; any other week with fewer than 10 is reported and not checked; R5-35); B-9 10 identical replays; B-10 (§6.3). Beside B-2: the lower bound of (rule − matched random) > 0 (§9).
- **Gate R on `W_R`:** R-1 ≥ 14 days, ≥ `n_R` = max(300, `n_80`) trades and effective size; R-2 lower bound > 0, and (rule − matched random) lower bound > 0; R-3 mean ≥ 50% of the `W_B` point estimate; R-4 point estimate > 0 with 2 × p95 latency and 2 × `p_sw`, and A21's directional stress; R-5 max drawdown ≤ 15% of `E_bt` and ≤ 20 × notional; R-6 crash-day report (ARCH §3.4: the replay of every `W_R` day on which SOL or the meme basket fell by more than the regime threshold, or with ≥ 2 simultaneous signals, is reviewed, and correlated loss on those days ≤ `MAXRISK_PF`).
- **Power (owner item 6):** `n_80 = ⌈DEFF × ((1.960 + 0.842) / S_low)²⌉`, `S_low` the lower bound of the selected config's per-trade net Sharpe 95% interval on `W_B` (A-M13-06 step 4). It cannot be computed before `W_B`. For orientation only (DEFF = 1): `S_low` 0.05 → 3,141 trades; 0.10 → 786; 0.20 → 197 (DERIVED). If `S_low` ≤ 0, R-1 fails and the case goes to the owner; if `n_R` needs more than 90 days of `W_R` at `W_B`'s trade rate, it goes to the owner and nothing passes.
- **≥ 300 out-of-sample trades** in `W_R`, whatever `n_80` says (R-1).

### 7.4 Reported beside the tests (decide nothing)
Lean and strict rows; the 414,009 line; the five sizes; the baseline split of PM01-P1: count and primary metric for entries with at least 60 min of `dump_flag` baseline (entry at migration + 90 min or later) and for entries with under 60 min (the gates use all entries); the `dump_flag` fire rate under P1 (R4-18); a delayed-entry line (one more 15 s bar of delay); A22's skew reporting (outcome bins ≤ stop, small loss, 0–2×, 2–10×, 10–50×, ≥ 50×; the loss bill; week-clustered intervals; the top 1% of trades' share of P&L; A22's capped mean, whose unit A-M13-04 fixes; with a +1,500 bps target it should rarely bind); hold-SOL and JitoSOL baselines (C-56).

## 8. Study hygiene (A12, C-63)

### 8.1 Exclusions at entry time only
A pool is excluded only for a reason known at the decision. No field observed after the decision is ever used (no all-time high, no later market cap, no later holder count).

### 8.2 Dead pools stay
A position whose pool stops producing data is closed by the `no_data` rule (ARCH §9.3), never dropped.

### 8.3 Exclusion table in every report
Per window: migrations listed; pools with `start_missing` (no complete bar 0); pools with a `gap` before a decision; pools refused by each hard check; signals refused by `DEPTHPCT` per size; signals refused by `k`; trades purged at boundaries. Two sensitivity lines: every trade whose data stopped while open taken at −100%; and every `start_missing` or `gap` pool that reached the depth floor treated as a −100% trade. **Coverage rule for `W_B`:** a UTC day counts only if its M07 manifest shows complete bars from bar 0 for ≥ 95% of that day's listed pools (CHOICE; below that, the day is `low_coverage` and skipped, never filled). The list coverage is measured against comes from an independent chain read of the migration program's signatures, within the rate limits, not from the recorder's own list (R4-16). Skipped days are reported with their migration counts.

### 8.4 Viewed-window ledger
Every computation of a PM-01 signal or return on any day is logged in M13's viewed-window ledger with the days it read. No `affectsReturns` value may come from a viewed window without a re-test on unseen days; none comes from the H8, H9 or H11 studies.

## 9. Random-entry benchmark (A-M13-06, C-65)

- For each PM-01 trade, 10 random entries in the **same pool** and the **same UTC hour**, drawn with the random-entry seed, from complete 15 s bar closes inside that pool's PM window where every entry-time filter of §4.2 passes (the size's `DEPTHPCT` and `k` included) but the breakout and depth-rising conditions are not required. Each random entry runs the same config's exits and costs.
- C-65's third key, the 6 h MAD decile, cannot exist for a pool at most 120 min old, and C-65's overlap rule uses MR's lookback `L`. The PM reading (ruled, PM01-P2, §13): MAD of 15 s returns since migration (bar 0) to the candidate bar, deciles over all candidate bars of the same gate window (`W_B` or `W_R`; R4-10); `L` = 60 s (the depth-rising look-back), so a candidate whose holding period overlaps `[signal − 60 s, signal]` is dropped.
- Fewer than 10 candidates: all are used. None: the trade counts in §7 but not in the excess test; `n_b` (trades with at least one random entry) and `n_b`/`n` are reported. If `n_b` < 0.8 × `n`, the excess test fails closed (R4-10): it is `pending_data`, never passes and never triggers a kill.
- Excess per trade = trade net return − mean net return of its random entries, on the conservative row. It is computed twice: with random entries before the signal only, and with random entries after the signal only. Test: §7.3's interval on each; the gate uses the **lower** of the two lower bounds, which must be > 0, beside B-2 and R-2. A trade with no candidate on one side is left out of that side's excess.
- **Side floors** (R5-22): each side needs `n_side` ≥ 0.5 × `n` trades and ≥ 20 calendar-day clusters. Below that, the excess test is `pending_data`: it never passes and never triggers kill rule 1 or 2, and the owner is told the counts. A side computed with enough trades whose lower bound is ≤ 0 still fails the test, and that can kill.

## 10. Live dry run: what counts as consistent

PM-01 can reach paper at most (`enabled_modes` ⊆ {backtest, replay, paper}; A-M09-03). Before `replay_passed` it makes no paper trade at all, not even shadow (MIGRATION "Clashes", line on shadow trades).

In `W_P`, at the $5 gate size with `E_bt` = 20 SOL of paper equity on the live-small profile (R4-15), so the ceilings are the same as in the gate runs:

- **Capital requirement** (R5-34; DERIVED, approximate): P-9 requires the fixed monthly cost to be ≤ 3% of `E` (ARCH §3.4). At $59 a month that implies a bankroll of at least about $1,967 (59 ÷ 0.03), about 13.1 SOL at the $150 illustration rate; the report converts it at the window's recorded SOL/USD. This is PM-01's capital requirement for live use, beside the $5 trade size, and is reported with `W_P`'s result. Raising any limit stays the owner's.
- **Binding (Blueprint):** P-1 to P-6, P-9 and P-10, owner items 3 and 4 inside them. **Consistency with the backtest is P-3:** the paper mean is not below `W_R`'s 95% interval lower bound (§7.3's interval).
- **Consistency flags** (CHOICE; decide no pass, but each one blocks promotion until the supervisor records an evidence-based explanation in `docs/DECISIONS.md`): (a) paper mean above `W_R`'s interval upper bound (a result better than the replay suggests a model or data fault, never luck to bank); (b) paper trades a day outside 0.5× to 2× of `W_R`'s rate; (c) the share of stop exits more than 15 percentage points from `W_R`'s share; (d) realised explicit cost above 1.25 × modelled over the window (LS-2's ratio).

## 11. Kill rules: what stops PM-01 for good

PM-01 stage → `failed` (absorbing; A-M13-05 step 3) when any of these happens. After that, PM-01 version 1 is never re-run on the same days, never traded and never shadowed; a revised rule enters only as a new version through the M09 slot, pre-registered and tested on days no PM-01 run has seen (D08).

1. Gate B evaluated with sufficient data (B-1 met, ≥ 30 counted days) and any of B-2, B-3, B-5, B-6, B-7, B-8, B-4 (or its single-candidate substitute, §7.2) or the excess test fails (R4-13). An excess test that is `pending_data` (§9 side floors or the 0.8 `n` rule) never triggers this rule (R5-22).
2. Gate R evaluated with sufficient data and any of R-2 to R-6 fails, or the excess test fails; or a voided `W_R`'s pre-boundary segment has ≥ 100 closed trades and its upper bound is below 0, on the lean row without the monthly share and the §6.4 kill-side interval (§6.2; R5-21).
3. R-1 power: `S_low` ≤ 0 on `W_B`. The Blueprint sends this to the owner; this file's recommendation is stop.
4. B-1, including effective size (§7.3), not met by 90 counted days, or by 120 calendar days from the first `W_B` start, whichever comes first; the clock does not restart when `W_B` restarts (R5-31, R6-37, R7-55): B-1 cannot be met in a usable time; the case goes to the owner with the recommendation stop.
5. Gate P fails P-2, P-2b, P-3 or P-4 with sufficient data.
6. The C-56 end state: if PM-01 has not passed by 31 Dec 2026, the OWNER PENDING clause applies; no new PM work starts after that date.
7. The kill-only screen on the B-10 days drops both configs (§6.4).

Which failures can kill (R4-13; supervisor, 8 Oct 2026): a failed **evidence** check (returns, risk, statistics) can kill; a failed **engineering, determinism or data-integrity** check never kills, and blocks the stage until a fix record and a re-run exist. "Engineering check" means exactly B-9 (10 identical replays), B-10 (crashes, illegal states, unreconciled intents) and the M07 coverage and QA checks (R5-26); every other failed check is evidence. Engineering checks never kill.

**Re-runs after a fix** (R5-26): a re-run must reproduce every decision of the evaluated window except the trades the fix record names, each with its reason. If any return in a window already evaluated changes, that window is burned: the result counts as a new trial (B-3, B-5), and the gates run again only on unseen days. A recorded kill stands, unless the failing gate, recomputed on the same window with the fix, passes. Then the window is burned, and a retry on unseen days counts as a new trial and goes to the owner first (R6-39, R7-53). R-6 is an evidence check: by ARCH §3.4 it tests that correlated loss on crash days stays within `MAXRISK_PF`, a risk limit, so it stays in kill rule 2.

An economic boundary inside `W_B`, `W_R` or `W_P` is not by itself a kill: it ends that window, and inside `W_R` or `W_P` it also voids `W_B`'s selection, under the limits of §6.2 (PM01-P4).

A gate that is only `pending_data` never kills and never passes.

**Acceptance cases for these rules** (R9-67): one synthetic fixture per kill rule 1–7, and one per `pending_data` path (the benchmark side floors, the `n_b` < 0.8 `n` rule, and each 100-trade floor: screen, screen subset, voided `W_R`). Each fixture asserts kill, pass or `pending_data` as computed from the block's `gates` values, not from constants in the test. Combination fixtures (R10-72): the excess test is `pending_data` (a side floor not met) and B-2 fails with sufficient data → kill (kill rule 1); the same in `W_R`, with R-2 failing → kill (kill rule 2).

## 12. Numbers that need data or a ruling, fixed before the first run

"Fixed" means for each row (R5-23): the value is written into this file and into the frozen-parameter block below by an amendment, from the merged code or ticket named in the row, with that commit's sha; for PM01-P1, the M08 change is merged with its `affectsReturns` key.

| # | Number | How it is fixed | Before |
|---|---|---|---|
| PM01-P1 | PM `dump_flag` baseline (start, coverage, minimum span) | Ruled (§13). Still needs the M08 change, with its own `affectsReturns` key | First run |
| PM01-P2 | Random-entry matching for PM (MAD look-back, `L`) | Ruled (§13) | — |
| PM01-P3 | Ceilings and `E_bt` for the reported sizes | Ruled (§13) | — |
| PM01-P4 | Whether a window continues across a market boundary | Ruled (§13); classes in §6.2 | — |
| PM01-P5 | K3 retention horizon (migration + 300 min) | Accepted as the proposal for the OF-3 step (§13); the supervisor records it with the measured sizes | Batch 3 of the Old Faithful pull |
| — | Exact stressed gap prior (A21 says "about 8,270") | A-M10-04 freezes it in the parameter set; §5.2 is recomputed and amended if it changes the $5 verdict | First run |
| — | Exact cost-row lamports (rent account size, janitor priority) | A-M10-03 code and golden tests; §5.4 is illustration only | First run |
| — | A21 directional stress (`g`, `N`) | A-M10-04 / A-M11-03 tickets; recorded here by amendment | First run |
| — | `n_80`, DEFF, `S_low` | Computed on `W_B` by A-M13-06 | Start of `W_R` |
| — | PM-01's trade rate | Counted while `W_B` runs (counts only, §6.2) | — |
| — | Window dates | Fixed by §6.2's rules and written to DECISIONS on the day | Each window's start |
| — | `honeypot_sim` and holder state in recorded `W_B` data (not required for the screen, which uses assumed-pass) | If the engine cannot supply them from M07 records, every entry fails closed; that is a defect to fix in the data path, never a check to skip ("Discipline, not paralysis") | First run |

### Frozen-parameter block (R5-29, R6-36, R7-46, R7-50, R7-51)

Every `affectsReturns` value for configs A and B: §4.6, the gate size and equity, the PM-01 `dump_flag` baseline, the random-entry rules, the seeds, the screen floor, the frozen fill, cost and feature versions, the §12 numbers, and the monthly figure at registration. The `engine` sub-object holds the risk config (live-small limits, `MAXOPEN`, `PERTOKEN`, `DEPTHPCT`, `LOSSRUN`), the M06 thresholds, the features config (bar size and completeness, dump window, −4 × MAD, freshness, M08 bar keys), the exit ladder and the cost parameters, each as values or as the path and sha256 of the frozen file that holds them. The `gates` sub-object holds every decision threshold of §6–§11. The values written here are copied from this file and ARCH (§8.1 and §8.2 limits, §8.4 `lp_withdrawable_max`, §3.4 P gates; R7-51); the `null` ones are filled from the frozen code before the first run. Lamport values are strings (exact integers). `null` marks a value still to be fixed; the screen and every gate run refuse to start while any value is `null` (§6.4). Each window's frozen monthly figure is written in `docs/DECISIONS.md` at the window's start (§5.3).

The hash is the sha256 of the bytes between the opening ```` ```json ```` line and the closing ```` ``` ```` line, exclusive, UTF-8 with LF line ends. At this commit it is `1ca7e8cc16ec573372782ff470b0857bf0263b31a7c1397cbf297007dbccb381`. Each amendment recomputes and rewrites it. Two keys (R7-46; SPEC-A is not amended):
- **`pm01FrozenKey`** = sha256 of the block bytes followed by, for each referenced file in the order it appears in the block, an LF and that file's recorded sha256 in lowercase hex (the R6-36 formula).
- **`configKey`** is the engine's own A-M13-02 key, as SPEC-A step 2 defines it.

The run refuses unless (1) `pm01FrozenKey` recomputes from the block in the merged file, and (2) the engine's `configKey` equals the `configKey` that A-M13-02 recomputes from the block's values. Files (R7-50): the run recomputes each referenced file's sha256 from disk and refuses if it differs from the sha256 recorded in the block; both keys use the recorded sha256. If a value appears both inline in the block and in a referenced file, the run refuses when they disagree. Acceptance case, for both keys: changing any one listed value, in the block or in a referenced file, makes the run refuse.

**Gate values come from the block** (R8-56). For PM-01 the gate evaluator loads every `gates.*` value from the block in the merged file at run time; no PM-01 gate constant lives in code. Each gate result records `pm01FrozenKey`. `pm01FrozenKey` is compared with the value recorded with the `preRegister` record (A-M13-02), not only with the hash printed here. That record is append-only (R9-63): registration writes the first entry, and each amendment merged before the first run appends an entry with the blob sha of this file (`git hash-object research/pm01/PREREG.md` at the integration head) and `pm01FrozenKey`; nothing is overwritten (R12-84). Entries are ordered by their append sequence in the M13 registry, and compared against the first-run record in the same registry; no date field is ever used (R10-69). A run compares against the latest entry, and refuses if any entry was appended after the first-run record. Before writing the first-run record, the run checks that the latest entry's blob sha and `pm01FrozenKey` equal those of this file at the current integration head; otherwise it refuses. A commit sha is never compared (R11-80, R12-84). Acceptance case: on a fixed synthetic window, changing one `gates` value with the recorded hash updated changes that gate's verdict; changing it without updating the hash makes the run refuse.

**Key mapping** (R8-60). The run refuses if any key A-M13-02 hashes into `configKey` is missing from the block, or if a block value that is an `affectsReturns` config key is not in A-M13-02's hashed set.

| A-M13-02 `configKey` input (SPEC-A step 2) | Block field |
|---|---|
| `strategyId` | `strategyId` |
| `strategyVersion` | `strategyVersion` |
| `params` | `configs.A` or `configs.B` (one key per config) |
| `affectsReturns` subset (every M25 key with `affectsReturns = true`) | `engine.risk`, `engine.m06Thresholds`, `engine.features`, `engine.exitLadder`, `engine.costParams`, `dumpFlagPm01`, `gateSizeLamports`, `eBtLamports`, `riskProfile`, `stressedGapPriorBps`, `costRowLamports`, `a21DirectionalStress`, `featuresVersion` |
| `costModelVersion` | `costModelVersion` |
| `fillModelVersion` | `fillModelVersion` |
| Not in `configKey`; covered by `pm01FrozenKey` only | `gates`, `seeds`, `randomEntry`, `screen`, `monthlyUsdAtRegistration` (study and gate settings, not engine config) |

The block names fields by group. The M25 schema gives the exact config key names; before the first run, each M25 key with `affectsReturns = true` is matched one to one to a block value, and the run's check above is what enforces it.

```json
{
 "strategyId": "pm01",
 "strategyVersion": "1.0.0",
 "configs": {
  "A": {
   "stopBps": 800,
   "trailArmBps": 800,
   "trailBps": 800,
   "targetBps": 1500,
   "timeStopMs": 7200000,
   "entryFromMs": 1200000,
   "entryToMs": 7200000,
   "minEffQuoteLamports": "85000000000",
   "minRealRatioBps": 6000,
   "depthRisingBars": 4,
   "maxEntriesPerPool": 1,
   "entrySlippageBps": 150,
   "exitSlippageBps": 300,
   "fixedCostCapBps": 200
  },
  "B": {
   "stopBps": 1500,
   "trailArmBps": 800,
   "trailBps": 800,
   "targetBps": 1500,
   "timeStopMs": 7200000,
   "entryFromMs": 1200000,
   "entryToMs": 7200000,
   "minEffQuoteLamports": "85000000000",
   "minRealRatioBps": 6000,
   "depthRisingBars": 4,
   "maxEntriesPerPool": 1,
   "entrySlippageBps": 150,
   "exitSlippageBps": 300,
   "fixedCostCapBps": 200
  }
 },
 "gateSizeLamports": "33333333",
 "eBtLamports": "20000000000",
 "riskProfile": "live_small",
 "dumpFlagPm01": {
  "baselineFrom": "migration",
  "baselineToBeforeNowMs": 1800000,
  "minBaselineMs": 600000,
  "minCoverageBps": 5000
 },
 "randomEntry": {
  "perTrade": 10,
  "madSince": "migration",
  "lookbackMs": 60000
 },
 "seeds": {
  "bootstrap": 1347235889,
  "randomEntry": 1347235890
 },
 "screen": {
  "minClosedTrades": 100
 },
 "fillModelVersion": null,
 "costModelVersion": null,
 "featuresVersion": null,
 "stressedGapPriorBps": null,
 "costRowLamports": null,
 "a21DirectionalStress": {
  "g": null,
  "N": null
 },
 "monthlyUsdAtRegistration": 59,
 "engine": {
  "note": "values, or the sha256 of the frozen file they live in; null = not yet fixed",
  "risk": {
   "profile": "live_small",
   "MAXRISK_bpsOfE": 25,
   "MAXRISK_capLamports": "50000000",
   "MAXRISK_PF_lamports": "100000000",
   "MAXOPEN": 2,
   "MAXPOS_bpsOfE": 100,
   "MAXPOS_capLamports": "66666667",
   "MAXEXP_bpsOfE": 200,
   "DEPTHPCT_bps": 50,
   "PERTOKEN": 1,
   "LOSSRUN": {
    "losses": 5,
    "pauseMs": 3600000
   },
   "DAYLOSS_bpsOfE": 200,
   "limitTableFile": null,
   "limitTableSha256": null,
   "perTokenDailyEntries": 3,
   "WEEKLOSS_bpsOfE": 600,
   "DDHALF": {
    "drawdownBps": 1000,
    "sizeMultiplier": 0.5,
    "resetBelowBps": 500
   },
   "DDKILL_bpsOfE": 1500,
   "FEEDAY_lamports": "2000000"
  },
  "m06Thresholds": {
   "minEffQuoteLamports": "85000000000",
   "realVsEffectiveBps": 6000,
   "feeCeilingBpsPerSide": 125,
   "top10HoldersBps": 3500,
   "singleHolderBps": 1000,
   "tableFile": null,
   "tableSha256": null,
   "lpWithdrawableMaxBps": 500
  },
  "features": {
   "barMs": 15000,
   "barMaxMissingBps": 2000,
   "dumpWindowMs": 1800000,
   "dumpMadMultiple": -4,
   "freshnessDecisionSlots": 12,
   "freshnessBuildSlots": 8,
   "m08BarKeys": null,
   "file": null,
   "sha256": null
  },
  "exitLadder": {
   "file": null,
   "sha256": null
  },
  "costParams": {
   "file": null,
   "sha256": null
  }
 },
 "gates": {
  "interval": {
   "level": 0.95,
   "bootstrapResamples": 10000,
   "blockRule": "max(1, round(n^(1/3)))",
   "blockSweep": [
    "b/2",
    "b",
    "2b"
   ],
   "passSide": "lowest lower bound of bootstrap and day-cluster t",
   "killSide": "highest upper bound over block lengths and interval types"
  },
  "coverageDayBps": 9500,
  "effectiveSize": {
   "minDaysWithTrade": 20,
   "maxDayShareBps": 1000
  },
  "embargoMs": 18000000,
  "wB": {
   "minCountedDays": 30,
   "minClosedTradesPerConfig": 300,
   "selectionShareBps": 8000,
   "b8MinWeekTrades": 10,
   "killRule4MaxCountedDays": 90,
   "killRule4MaxCalendarDays": 120
  },
  "wR": {
   "minDays": 14,
   "minTrades": 300,
   "maxDays": 90,
   "maxRestarts": 1
  },
  "wP": {
   "minDays": 21,
   "P1MinTrades": 100,
   "pGates": "ARCH §3.4 P-1 to P-10, as written there",
   "consistencyFlags": {
    "tradeRateRange": [
     0.5,
     2
    ],
    "stopShareMaxPp": 15,
    "costRatioMax": 1.25
   }
  },
  "thresholds": {
   "B2LowerBoundGt": 0,
   "B3Dsr": 0.95,
   "B6ClusterT": 3.0,
   "B7MaxDrawdownBpsOfE": 2000,
   "R5MaxDrawdownBpsOfE": 1500,
   "maxDrawdownLamports": "666666660",
   "R3ShareOfWbBps": 5000,
   "powerZ": [
    1.96,
    0.842
   ],
   "R4Stress": {
    "latencyP95Multiple": 2,
    "pSwMultiple": 2
   }
  },
  "benchmark": {
   "perTrade": 10,
   "nbMinShareBps": 8000,
   "sideMinShareBps": 5000,
   "sideMinDayClusters": 20
  },
  "screenKill": {
   "minClosedTrades": 100,
   "subsetMinClosedTrades": 100,
   "subsetExcludesExits": [
    "cannot_sell",
    "liquidity_collapse",
    "no_data"
   ],
   "row": "lean"
  },
  "voidedWrKill": {
   "minClosedTrades": 100,
   "row": "lean_without_monthly"
  },
  "boundary": {
   "decoderTestDays": 1,
   "pendingDays": 1,
   "fallbackSwapCap": null,
   "part7": {
    "pooling": "all universe pools, one sample per ratio type",
    "ratioTypes": [
     "buyback_lamports_per_fees_collected",
     "boost_burn_per_swap_volume"
    ],
    "lookback": "later of (boundary - 7 days) and (previous boundary slot + its pending period)",
    "lookbackDays": 7,
    "test": "ks_two_sample",
    "familyAlpha": 0.01,
    "alphaCorrection": "bonferroni_by_ratio_type",
    "minEventsPerSide": 100,
    "extraPendingDays": 1,
    "sizeRule": {
     "anyOf": [
      "median",
      "mean",
      "p90"
     ],
     "toleranceBps": 1000
    },
    "lowCount": {
     "zeroVsZero": "pass",
     "absentBeforePresentAfter": "economic",
     "otherwise": "exact_poisson_rate_ratio_per_swap_volume"
    }
   },
   "fallbackCurveTradeCap": null
  }
 }
}
```

## 13. Rulings

Supervisor rulings in `docs/reviews/PM01-PREREG.md`, rounds 1–5 on branch `claude/supervisor-docs` and rounds 6 and later on branch `claude/supervisor-docs-2` (R8-62), applied here before the first run. One numbering (R6-42): each ruling is cited by its round and its number in that file, for example R5-29. Times are Melbourne, 8 Oct 2026, as corrected in that file: round 1 at 9:26 AM, round 2 at 9:30 AM, round 3 at 9:32 AM, round 4 at 9:40 AM, round 5 at 9:47 AM, round 6 at 3:07 PM, round 7 at 3:13 PM, round 8 at 3:18 PM, round 9 at 3:23 PM, round 10 at 3:28 PM, round 11 at 3:34 PM, round 12 at 3:39 PM and round 13 at 3:42 PM. The owner's "Ok" to the kill-only screen was at 9:28 AM.

**Round 1 (9:26 AM).** R1-1 PM01-P1 accepted, PM-01 only (§4.2). R1-2 PM01-P2 accepted (§9). R1-3 PM01-P3 accepted (§5.2). R1-4 PM01-P4 accepted (§6.2). R1-5 PM01-P5 accepted as the OF-3 proposal (§3). R1-6 the kill-only screen put to the owner; approved at 9:28 AM (§6.4).

**Round 2 (9:30 AM).** R2-1 the baseline split at 60 min (§4.2, §7.4). R2-2 the 50% coverage rule kept (§4.2). R2-3 B1 economic (§6.2). R2-4 an economic boundary in `W_R` or `W_P` voids `W_B`'s selection, as a new trial (§6.2). R2-5 the kill-only screen as a fixed section (§6.4).

**Round 3 (9:32 AM).** R3-a 100 closed trades per config. R3-b kill per config; both dropped stops PM-01; both count in the trial budget. R3-c fees at the lower of the day's and the current schedule. R3-d a `W_B` rerun may need more than 30 days (§6.2, §6.4).

**Round 4 (9:40 AM).** R4-1 count-only dropped config and `B-4_single_candidate` (§6.4, §7.2). R4-2 `W_B` end (§6.2). R4-3 no peeking in `W_R` and `W_P`; boundaries from L-4 only; one restart (§6.2). R4-4 kill on all trades and the subset (§6.4). R4-5 1 Hz as-of bars (§6.4). R4-6 kill-side block length (§6.4). R4-7 start condition (§6.4). R4-8 cluster t (§7.3). R4-9 effective size (§7.3). R4-10 benchmark before and after (§9). R4-11 watched programs (§6.2). R4-12 monthly cost at recorded rates (§5.3). R4-13 which failures kill (§11). R4-14 drawdown bar (§7.3). R4-15 `W_P` at 20 SOL (§10). R4-16 independent coverage list (§8.3). R4-17 decision day, `inner_ix_index`, draw order, runs once, `recovered`, B-8 weeks, denominator (§2, §3, §6.4, §7.1, §7.3). R4-18 citation and `dump_flag` fire rate (§6.4, §7.4). R4-19 embargo reason, `W_R` start, lamport columns, P12, pulling is not looking (§2, §5.4, §6.2, §6.4). R4-20 times (this section). Gap choices accepted at 9:44 AM: the subset floor, the weeks, the notional denominator, effective size at `W_B`'s end, the one-side benchmark rule, the drawdown bar; R-6 is an evidence check (§11).

**Round 5 (9:47 AM).** R5-21 voided-`W_R` kill on the lean row (§6.2, §11). R5-22 benchmark side floors (§9, §11). R5-23 screen start with P12 and the listed rows (§6.4, §12). R5-24 calendar and counted days (§6.2, §7.2). R5-25 citation (§6.4). R5-26 re-runs and "engineering" (§11). R5-27 monthly figure per window (§5.3). R5-28 isolated configs (§7.2). R5-29 frozen-parameter block (§12). R5-30 the PM01-P2 DECISIONS row. R5-31 kill rule 4 (§11). R5-32 as-of tie-break (§6.4). R5-33 pinned programs (§6.2). R5-34 P-9's bankroll (§10). R5-35 RNG key and B-8 weeks (§2, §7.3).

**Round 6 (3:07 PM).** R6-36 `engine` and `gates` in the block; `configKey` over the block and file hashes; the change-one-value acceptance case (§12). R6-37 the mechanical decoder-only test, fee-only changes continue the window at the higher fee, kill rule 4's clock from the first `W_B` start (§6.2, §11). R6-38 the monthly row's sha256 per window; R-3 and P-3 at the higher figure (§5.3). R6-39 a recorded kill stands (§11). R6-40 `fee_recipient`, `create_v2_enabled`, `whitelist_pda` hashed (§6.2). R6-41 the pump_fees citation (§6.2). R6-42 one numbering (this section). R6-43 the row difference is on purpose (§6.2). R6-44 `burn_percent` excluded; the Rent source (§6.2). R6-45 VERIFY items as start-condition item 5 (§6.4).

**Round 7 (3:13 PM).** R7-46 two keys, `pm01FrozenKey` and the engine's A-M13-02 `configKey`; the acceptance case on both (§12). R7-47 the decoder-only test over AMM swaps, migration seeds, curve trades, fee legs, accounts and rent, with on-chain integer arithmetic (§6.2). R7-48 a pending boundary pauses counts for one day, nothing voided (§6.2). R7-49 fee-only means the numeric protocol and LP rates and tiers only; the higher fee per trade and side, benchmark included (§6.2). R7-50 file sha256s recomputed from disk; inline and file must agree (§12). R7-51 the ARCH values and the added gate thresholds in the block (§12). R7-52 the monthly figure copied into the run bundle (§5.3). R7-53 a kill stands unless the failing gate, recomputed with the fix on the same window, passes (§11). R7-54 `whitelist_pda` always economic (§6.2). R7-55 kill rule 4 at 90 counted or 120 calendar days (§11).

**Round 8 (3:18 PM).** R8-56 the PM-01 gate evaluator loads every `gates.*` value from the merged block; each gate result records `pm01FrozenKey`, compared with the `preRegister` record; the synthetic-window acceptance case (§12). R8-57 fee-only fields named, creator fee changes end the window (§6.2). R8-58 pending from the flag's slot to the end of the first full UTC day (§6.2). R8-59 part 5 per trade, decoding against the refreshed post-upgrade IDL, a decoder update reproduces every pre-boundary decision (§6.2). R8-60 key mapping table; refuse on any mismatch (§12). R8-61 `FEEDAY` not scaled (§5.2). R8-62 `killRule4MaxCalendarDays` in the block; both branches cited (§12, this section).

**Round 9 (3:23 PM).** R9-63 the `preRegister` record is append-only, one entry per amendment merged before the first run; a run compares against the latest and refuses if any entry is dated after the first run's start (§12; ordering by append sequence, R10-69). R9-64 `stable_fee_tiers` and `exotic_flat_fees` named, same split; costing at the higher fee of the schedule the trade pays under (§6.2). R9-65 part 5 runs the pre-upgrade program bytes in a local simulator, binary sha256 pinned, simulator VERIFY, fail closed (§6.2). R9-66 refreshed IDL sources in order, sha256 pinned, no hand-edited IDL, none by the end of the pending period means economic (§6.2). R9-67 one acceptance fixture per kill rule and per `pending_data` path (§11).

**Round 10 (3:28 PM).** R10-68 replaces R9-65: part 5 from transaction data only (account lists against the pinned pre-upgrade IDL, created accounts against a pinned rule table), new swap instructions economic as part 6, the simulator optional; start-condition item 5 lists every VERIFY (§6.2, §6.4). R10-69 `preRegister` entries ordered by append sequence, never by date (§12). R10-70 without the screen, the first `W_B` trade count is the first run (§2). R10-71 a published IDL counts as post-upgrade by this repo's first fetch, never by commit date (§6.2). R10-72 combination fixtures: excess `pending_data` with B-2 or R-2 failing → kill (§11).

**Round 11 (3:34 PM).** R11-73 post-UPG-1 IDLs pinned before the first run with v3 rows; the pre-upgrade IDL per boundary is the latest pinned before its slot; part 6 unscoped; B5 relabelled economic (§6.2). R11-74 the forward-window transaction source (capture path, else a capped sample), otherwise every forward upgrade is economic, with the expected restart rate (§6.2, §6.4). R11-75 part 7 for program-side reserve changes, factor 2 in the block (§6.2, §12). R11-76 created-account size, lamports and rent paid (§6.2). R11-77 Token-2022 ATAs 170 bytes, per-mint VERIFY (§6.2). R11-78 fee, buyback, creator-vault and `sell_v2` accumulator accounts resolved from golden fixtures (§6.2). R11-79 the screen after an early first run is a later, stop-only run (§6.4). R11-80 the first-run record checks the latest `preRegister` sha against the merged head (§12).

**Round 12 (3:39 PM).** R12-81 replaces R11-73's unscoped part 6: a new swap instruction is tested by decoding and role mapping, and is economic only on a mismatch or if no pinned IDL decodes it; B5 re-checked: not yet tested, counted economic until then (§6.2). R12-82 part 7 on normalised ratios, KS test at α 0.01 with ≥ 100 events per side and a > 10% median move, in the block (§6.2, §12). R12-83 the fallback also fetches migrations, curve trades and program-side reserve instructions, stratified per hour (§6.2). R12-84 `preRegister` entries carry the file's blob sha (§12). R12-85 start item 8 is a recorded choice, the last option put to the owner (§6.4). R12-86 without a refreshed IDL the previous one stays the baseline (§6.2). R12-87 `fallbackSwapCap` in the block (§12). R12-88 restart wording (§6.2).

**Round 13 (3:42 PM).** R13-89 part 7 pools events across universe pools, one KS test per ratio type at a Bonferroni α, low-count path with an exact Poisson rate-ratio test; daily event counts on the B-10 days recorded before the first run (§6.2, §6.4, §12). R13-90 the size rule covers the median, mean and p90 (§6.2, §12). R13-91 look-back from the later of boundary − 7 days and the previous boundary's pending end (§6.2). R13-92 `fallbackCurveTradeCap` in the block (§6.2, §12). R13-93 role mapping by PDA seeds and deriving program, or ATA owner, mint and token program (§6.2). R13-94 B5 counted economic and not tested (§6.2). R13-95 part 7's pinned rules as start item 5.9 (§6.4).
