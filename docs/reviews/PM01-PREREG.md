# PM-01 PREREG (PR #294) review log

## Round 1: researcher's proposals (head `0415011e`)

Prediction stated by the researcher: a loss (neighbouring tests −10.6% and −22.4%; hurdle about 4.4–5.1% at $5–$20). PM-01 is tested only to confirm or refute it, and never traded unless it passes.

### Supervisor rulings (8 Oct 2026, 9:26 AM)

1. **P1 (blocking): accepted, as a PM-01-only rule fixed in the PREREG.** The M08 dump-flag baseline for PM-01 runs from migration to now − 30 min and needs at least 10 min of data; the dump rule itself is unchanged; the first valid entry is migration + 40 min. Other strategies keep the 6 h baseline. The report counts how many entries relied on a baseline shorter than 6 h, and gives the result with and without them. Reason: as specified, no pool younger than 120 min can have a valid decision, so PM-01 could never enter; "Discipline, not paralysis" calls that a defect to fix, and a fail-closed `insufficient` stays for anything under 10 min.
2. **P2: accepted.** Random-entry matching for PM-01 uses MAD measured since migration and L = 60 s, fixed in the PREREG.
3. **P3: accepted.** The gates decide at $5 with E_bt = 20 SOL on the live-small profile. $20, $100, $1,000 and $10,000 are reported lines with scaled E_bt and ceilings, never gate inputs, with gross return, fixed costs, percentage fees and price impact shown apart ("Size is not the trial").
4. **P4: accepted.** A market boundary that changes trade economics ends the window; a decoder-only boundary is reported and the window continues. The doc lists which boundary types fall in each class.
5. **P5: accepted as the proposal for the OF-3 step.** K3 keeps migration to migration + 300 min. The supervisor records it in DECISIONS with the measured sizes before batch 3, together with the retention choice.
6. **Kill-only screen on the B-10 days:** not added. It is a new task, so it is put to the owner. Until the owner answers, the PREREG mentions it only as an option.

Next: the researcher applies 1–5, marks P1–P5 as ruled in DECISIONS (not proposals), and reports the new head. Then a fresh reviewer and a red team.

## Round 2 (head `19c0a712`, researcher `session_015oSGiMB1sKnM13Di7CE8np`)

P1–P5 were applied. The researcher's points and the supervisor rulings (8 Oct 2026, 9:30 AM):
1. **"With and without" is always empty**, since every PM-01 entry is in a pool younger than 120 min. Replaced with a split at the baseline: at least 60 min (entry at migration + 90 min or later) against under 60 min. Both lines are reported, and the gates use all entries.
2. **The 50% coverage rule is kept over the new span:** accepted, as the stricter choice.
3. **B1 counts as economic:** accepted.
4. **An economic boundary inside W_R or W_P** ends that window and voids W_B's selection. A new W_B selection runs on data after the boundary and counts as a new trial.
5. **Kill-only screen** (owner, about 9:28 AM, "Ok"): a fixed section, written before any B-10 day is looked at. It states the kill rule on 07-22..08-21, the minimum trade count, the cost model and the size ($5), and that the screen can never pass PM-01.

## Round 3 (head `32fdea71`): kill-only screen §6.4 added

The researcher's choices and the supervisor rulings (8 Oct 2026, 9:32 AM):
- (a) **100 closed trades per config:** accepted.
- (b) **Kill per config:** a config whose 95% upper bound is below 0 with ≥ 100 trades is dropped, and PM-01 stops when both are dropped. A drop never adds, tunes or promotes anything, and both configs still count in the trial budget.
- (c) **The screen stays optimistic.** Per trade, it uses the lower of the day's chain-read fee and the current fee schedule; the lean row stays otherwise.
- (d) **A W_B rerun after a boundary may need more than 30 days:** accepted, and stated in the doc.

## Round 3 red team (head `c7a5007d`): 0 BLOCKER, 11 MAJOR, 8 MINOR

Red team `session_016GhUshWTj7tPMTadZoSCnF`, about 9:36 AM. The full report is in its transcript. In short:
- M1: W_B's end and its 80% selection point depend on each other.
- M2: W_R and W_P have no no-peek rule, so a P4 restart can re-roll a failing holdout.
- M3: with one config, B-4 is undefined.
- M4: the assumed-pass inputs make the screen pessimistic.
- M5: the bar construction from transaction-level state is unspecified.
- M6: the §12 "First run" values can be settled after the screen.
- M7: B-6's t is unspecified, and the iid t overstates confidence.
- M8: the 300-trade floors can be met by a few correlated days.
- M9: the random-entry benchmark's makeup is free.
- M10: the boundary list misses the bonding-curve side.
- M11: the monthly cost is fixed in SOL at $150.
- m1: B-7 and R-5 are inert at E_bt 20 SOL. m2: W_P sizing. m3: coverage depends on the recorder's own list. m4: the universe day assignment and ix_index. m5: RNG draw order. m6: the screen runs once. m7: recovered trades, the B-8 week, and the denominator. m8: a dangling CLAUDE.md citation, and the dump_flag fire rate under P1.
Held for the reviewer's report, so both go in one push.

**Time correction (9:39 AM).** The ruling times were first written as estimates (9:30, 9:42 and 9:46), and some were later than the real time. They are now the commit times of this file (9:26, 9:30 and 9:32, Melbourne). The owner's "Ok" to the screen was at 9:28 AM (checked with `date`).

## Round 3 reviewer (head `c7a5007d`): FAIL on 1 BLOCKER, 6 MAJOR, 6 MINOR

Reviewer `session_013E5iKPuZrpnyNX74jpF6ui`, about 9:38 AM. The citations and arithmetic check out, and the rounds 1–3 rulings are applied.
- B1: dropping a config breaks B-3, B-4 and B-5 (B-4 passes on its own in M13; the dropped config has no W_B trial for the DSR).
- M1: the W_B end rule is circular.
- M2: "optimistic" is not proven for assumed-pass holder checks.
- M3: the screen's bars are undefined.
- M4: the screen's bootstrap block length.
- M5: the monthly cost conversion rate is free.
- M6: kill rule 1 kills on engineering failures (B-9, B-10).
- m1–m6: the embargo reason; W_R's start; lamport and SOL columns per size, with sandwich and stuck terms as their own lines; fee_config_known until P12; pulling or measuring is not looking; the citation branch.

### Supervisor rulings for round 4 (8 Oct 2026, 9:40 AM)

These answer the red team (R) and the reviewer (V) together.
1. **One-config W_B (V-B1, R-M3).**
   - The dropped config keeps running in W_B as a count-only gate trial. It is registered for B-3 and B-5 with its real Sharpe, never selectable and never traded, so the DSR uses N = 2.
   - B-4 with one candidate is recorded as `B-4_single_candidate` and replaced by a stricter check fixed now: the surviving config's mean (conservative row) is above 0 in each half of W_B, by whole UTC days. It is never vacuous.
   - M13 must not call rankStability with fewer than 2 configs. Add this as an acceptance case for A-M13-06.
2. **W_B end (V-M1, R-M1).** W_B ends at the first UTC midnight with ≥ 30 counted days and ≥ 300 closed trades for every config in it (the count-only one included), after purge and embargo. `low_coverage` days do not count toward the 30. The selection runs once, after W_B ends, on floor(0.8 × days). B-4's halves are the halves of the whole W_B by whole UTC days.
3. **W_R and W_P peeking and restarts (R-M2).** Accepted, (a) to (e):
   - (a) No return is computed in W_R or W_P until the window ends, and each is evaluated once.
   - (b) A boundary comes only from L-4's automatic flag, logged before any return of that window is computed.
   - (c) A voided W_R keeps its pre-boundary segment as a kill-only check.
   - (d) At most one restart; a second goes to the owner.
   - (e) Each voided W_R is counted in the report and in the B-3 registry.
4. **The screen's direction (R-M4, V-M2).** Drop the "optimistic" sentence and state both directions. A config is killed only when the upper bound is below 0 on all trades AND on the trades whose exit was not cannot-sell, liquidity-collapse or no_data. Report the share of assumed-pass entries, and holder concentration where the archive can compute it.
5. **Bars (R-M5, V-M3).** Use 1 Hz as-of states (the last state with block time ≤ each second) and compute high and close from those samples only, as M07 does. observedAtMs comes from block time. A bar is missing only where archive units or blocks are missing, never because no trade happened.
6. **Block length for the kill (V-M4).** For each interval type, take the b/2, b or 2b run with the highest upper bound, then the higher of the two intervals' upper bounds.
7. **First-run values (R-M6).** The screen refuses to start until every §12 "First run" row is fixed, amended in and merged, and the merged sha is read back. The run checks the hash of the frozen parameter set.
8. **B-6 (R-M7).** B-6 uses the t from the calendar-day cluster standard error. Report both t values.
9. **Effective size (R-M8).** B-1 and R-1 also need ≥ 20 distinct UTC days with ≥ 1 trade, and no single day holding more than 10% of the window's trades; otherwise the window keeps running. Report n/DEFF.
10. **Random benchmark (R-M9).** Accepted, (a) to (c): "window" means the gate window; the excess is reported for random entries before and after the signal, and the gate uses the lower of the two lower bounds; if n_b < 0.8 n, the excess test fails closed.
11. **Boundary list (R-M10).** Name the watched programs and config accounts: the pump bonding curve and its global config, the pump AMM and its global and fee configs, and the fee program. Any change to migration or graduation parameters is economic.
12. **Monthly cost (V-M5, R-M11).** Converted at the window's recorded SOL/USD per day (M23), as SPEC-A A-M13-04 step 7 says. $150 is for the §5.4 illustration only.
13. **Kill rule 1 (V-M6).** It covers B-2, B-3, B-5, B-6, B-7, B-8, the B-4 substitute and the excess test. B-9 and B-10 failures block the stage until a fix and a re-run, and never kill.
14. **R-m1.** State that B-7 and R-5 at % of E are inert at E_bt 20 SOL, and add a binding bar: max drawdown ≤ 20 × the $5 notional.
15. **R-m2.** W_P uses E_bt = 20 SOL of paper equity.
16. **R-m3.** The coverage list comes from an independent chain read of the migration program's signatures (within the rate limits). Report skipped days with their migration counts.
17. **R-m4, m5, m6, m7.** As the red team wrote:
    - a trade belongs to its decision day, and each pool is counted once; add `inner_ix_index`; the universe sha256 goes in the B10-PULL row before the screen;
    - fixed draw order and one stream per purpose;
    - the screen runs exactly once and is never rerun or extended;
    - report with `recovered` included; the B-8 week starts Mon 00:00Z, with the partial-week rule stated; the denominator is stated.
18. **R-m8 and V-m6.** Cite the owner's message (8 Oct 2026, 9:28 AM, "Ok") and the DECISIONS row, not CLAUDE.md on another branch. Report the dump_flag fire rate under P1.
19. **V-m1 to m5.** As the reviewer wrote:
    - the embargo reason;
    - W_R starts at the midnight W_B ends;
    - lamport and SOL columns per size, marked DERIVED, with sandwich and stuck terms as their own lines;
    - fee_config_known and venue_enabled stay fail-closed until P12, so the screen is pending_data until then and a key-on run is only logged;
    - pulling and measuring the days is not looking at them, and no PM-01 signal or return is computed before the merge sha is recorded.
20. **Times.** Cite the ruling times as corrected above (9:26, 9:30, 9:32 and 9:40 AM), or the section of this file.

## Round 4 (heads `7bc7815d`, then `79f8c6a5`)

Rulings 1–20 were applied. The researcher's gap choices were accepted (8 Oct 2026, 9:44 AM):
- (a) the kill subset needs ≥ 100 trades, or it is pending_data;
- (b) a partial edge week is checked as it is, and a week with no trades is reported only;
- (c) the denominator is the notional, 33,333,333 lamports (0.0333 SOL), fixed in lamports;
- (d) W_B's end also needs the effective-size rule for every config;
- (e) a trade with no candidate on one side is left out of that side, and the 0.8n rule applies overall;
- (g) the drawdown bar is 666,666,660 lamports, beside the % of E limits.
- (f) Principle: a failed engineering, determinism or data-integrity check never kills, and blocks until fixed and re-run; a failed evidence check (returns, risk, statistics) can kill. R-6 (correlated crash-day loss ≤ MAXRISK_PF) is an evidence check, so it stays in kill rule 2.
Delta review: `session_013E5iKPuZrpnyNX74jpF6ui`. Red team round 2: `session_016GhUshWTj7tPMTadZoSCnF`.

## Round 4 delta review (head `79f8c6a5`): FAIL on 0 BLOCKER, 3 MAJOR, 3 MINOR

Reviewer, about 9:46 AM. Rulings 1–20 are applied, and the lamport table and citations hold.
- M1: the kill-only check on a voided W_R uses the conservative row; C-77 says a stop-only check uses the lean row.
- M2: the excess test can kill PM-01 for lack of before-signal data. There is no per-side floor.
- M3: "runs once" plus pending_data until P12 can throw the screen away.
- m1: `d` as calendar or counted days. m2: which §12 rows the start condition requires. m3: drop the CLAUDE.md citation.
Held for red team round 2, so both go in one push.

## Round 4 red team (head `79f8c6a5`): 0 BLOCKER, 5 MAJOR, 8 MINOR

All 19 round 1 findings are closed.
- R2-M1: a fix-and-re-run after an engineering failure can change returns already seen.
- R2-M2: the monthly cost can change after returns are seen.
- R2-M3: the configs are not isolated (shared risk slots).
- R2-M4: the frozen-parameter hash has nothing to compare against.
- R2-M5: the before-signal side is thin, and it has no floor.
- n1–n8: a stale PM01-P2 row; the P12 start condition; kill rule 4 and the effective size; the voided-W_R interval; the as-of tie-break and skipped slots; pinned program IDs and the economic fields hashed; P-9's implied bankroll; RNG ties between configs, and B-8 thin weeks.

### Supervisor rulings for round 5 (8 Oct 2026, 9:47 AM)

21. **Voided-W_R kill (V-M1, R-n4).** It uses the lean row without the monthly share, and the §6.4 kill-side interval (the highest upper bound over block lengths and interval types). Cite this ruling.
22. **Benchmark sides (V-M2, R2-M5).** Each side needs n_side ≥ 0.5 n and ≥ 20 day clusters. Below that, the excess test is `pending_data`: it never passes and never triggers kill rule 1, and the owner is told the counts. A side that is computed with enough trades and a lower bound ≤ 0 still kills. Say it in §9 and kill rule 1.
23. **Screen start (V-M3, V-m2, R-n2).** "P12 done" is part of the start condition. List which §12 rows the start check requires and what "fixed" means for each. The honeypot_sim/holder row is not in the screen's start condition, because the screen uses assumed-pass.
24. **Days (V-m1).** Boundaries use calendar days; the counts use counted days only. Say where low_coverage days fall in the 80/20 split and the halves.
25. **Citation (V-m3).** Drop the CLAUDE.md clause; cite the DECISIONS row and the owner's "Ok" at 9:28 AM.
26. **Re-runs after a fix (R2-M1).**
    - A re-run must reproduce every decision of the evaluated window except the trades the fix record names, each with its reason.
    - If any return in a window already evaluated changes, that window is burned: the result counts as a new trial (B-3, B-5), and the gates run again only on unseen days.
    - "Engineering check" means exactly B-9, B-10 and the M07 coverage and QA checks. Every other failed check is evidence.
27. **Monthly figure (R2-M2).** The monthly USD figure is frozen for each window at the window's start and written in DECISIONS with the window dates. A later ruling applies only to windows that start after it.
28. **Isolated configs (R2-M3).** Each config, the count-only one included, runs in its own engine instance with its own E_bt = 20 SOL and its own risk state. A test asserts A's trade list is identical whether B runs or not.
29. **Frozen parameters (R2-M4).** Before the first run, add a fenced JSON block holding every affectsReturns value for A and B: §4.6, the frozen fill, cost and feature versions, the §12 numbers, the seeds, and the per-window monthly figure. Record its sha256 in §12. The run recomputes that sha256 and the configKey from the block in the merged file, and refuses on any mismatch.
30. **R-n1.** Update the DECISIONS row PM01-P2 to "gate window, W_B or W_R".
31. **R-n3.** Kill rule 4: "B-1, including effective size, not met by 90 counted days" goes to the owner, with a recommendation to stop.
32. **R-n5.** The as-of sample is the last state by (slot, tx_index, inner_ix_index) with block time ≤ s. A skipped leader slot is not a missing block. Say that observedAtMs from block time gives zero observation lag, which is favourable to PM-01.
33. **R-n6.** Pin the program IDs and config account addresses from the pinned IDLs in this repo. L-4 hashes only the listed economic fields. If a field list cannot be confirmed from the pinned IDLs, mark it VERIFY with its source.
34. **R-n7.** Report the bankroll P-9 implies as PM-01's capital requirement (DERIVED, approximate).
35. **R-n8.** The RNG sort key includes the config id. B-8 checks a week only when it holds ≥ 10 trades; a smaller edge week is merged into the next one.
