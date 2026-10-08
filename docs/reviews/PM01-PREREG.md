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

## Round 5 (head `6457e652`): reviewer FAIL on 1 MAJOR, 4 MINOR; red team 0 BLOCKER, 2 MAJOR, 7 MINOR

- Both: the frozen block does not hold every affectsReturns value (and no gate thresholds), so the hash check is weaker than it reads.
- Red team R3-M2: economic boundaries come about as often as the windows last, so W_B may never complete.
- Minors: the VERIFY items are not in the start condition; field omissions (fee_recipient, create_v2_enabled, whitelist_pda); the idl-pinned citation; two ruling numberings; the per-window monthly row is outside the hash; a re-run against an absorbing kill; the interval row difference; the Rent source.

### Supervisor rulings for round 6 (8 Oct 2026, 3:07 PM)

36. **The frozen block (V-M1, R3-M1).**
    - Add an `engine` sub-object holding the values, or the sha256 of each frozen file they live in: risk config (MAXOPEN, PERTOKEN, DEPTHPCT, LOSSRUN, the live-small limit table), the M06 threshold table, features config (dump window, −4×MAD, bar completeness, freshness, M08 bar keys), the exit ladder, and the cost parameters.
    - Add a `gates` sub-object with every decision threshold: coverage 95%, effective size, side floors, n_b, B-8 ≥ 10 trades, embargo, the W_B 30 days and 300 trades, the kill subsets, and the bootstrap resamples and block rule.
    - configKey = hash(block bytes ‖ the sha256s of the referenced files). The engine's configKey must equal it, or the run refuses.
    - AC: changing any one listed value makes the run refuse.
37. **Boundaries (R3-M2).**
    - (a) The decoder-only test is mechanical. For one day after an upgrade, every swap's output is recomputed with the pinned formula from the pre-upgrade fields. If every result matches exactly and no listed economic field changed, the upgrade is decoder-only; otherwise it is economic.
    - (b) A fee-only economic change (only fee fields changed) does not end the window. Every trade in the window is costed at the higher of the old and new fee, and the window is reported as split. Every other economic class still ends the window.
    - Kill rule 4's 90-day clock does not restart with W_B; it counts from the first W_B start.
38. **r1.** Each window's run bundle records the sha256 of its monthly DECISIONS row at the window's start and refuses if the row changes. R-3 and P-3 use the higher of the two windows' figures on both sides.
39. **r2.** A recorded kill stands, unless the fix record shows the bug changed the failing statistic. Even then, the retry counts as a new trial and goes to the owner first.
40. **r3 and V-m2.** Hash `fee_recipient`, `create_v2_enabled` and `whitelist_pda`, or record for each why it is not economic.
41. **r4 and V-m3.** Write "pump_fees entry sha256 d87b5230… in idl-pinned.json".
42. **r5 and V-m4.** Use one numbering: review-file rulings are cited with a prefix (for example "R5-29"). Add round 5 at 9:47 AM and round 6 at 3:07 PM to the §13 header.
43. **r6.** State that the voided-W_R kill (lean row) and R-3/P-3 (conservative row) use different rows on purpose.
44. **r7.** List `burn_percent` as excluded, with the reason. The VERIFY source for the Rent fields is the Solana SDK `Rent` struct at a named version.
45. **V-m1.** The VERIFY items (config addresses re-derived from the IDL PDA seeds, the graduation field, the Rent fields) become start-condition item 5, so the screen cannot start with them open.

## Round 6 (head `55ad5258`): reviewer FAIL on 1 MAJOR, 3 MINOR; red team 0 BLOCKER, 1 MAJOR, 8 MINOR

- Reviewer M1: the block configKey formula conflicts with SPEC-A A-M13-02 step 2.
- Red team R4-M1: the mechanical decoder-only test checks only swap outputs.
- Minors: ARCH values left null (PERTOKEN, LOSSRUN and others); lp_withdrawable_max; thresholds missing from gates; the file-sha reading; the pending boundary; what counts as fee-only; the monthly row hash; kill versus retry; whitelist_pda; the kill-rule-4 calendar cap.

### Supervisor rulings for round 7 (8 Oct 2026, 3:13 PM)

46. **Two keys (reviewer M1).** The block hash is named `pm01FrozenKey` (the R6-36 formula). The run refuses unless (1) pm01FrozenKey recomputes from the merged block and files, and (2) the engine's A-M13-02 configKey equals the configKey recomputed by A-M13-02 from the block's values. The change-one-value AC applies to both. SPEC-A is not amended.
47. **The decoder-only test (R4-M1).** An upgrade is decoder-only only if all of the following hold over the full day:
    - (i) every AMM swap's amounts match;
    - (ii) every migration event's pool seed amounts match the pinned formula from the Global fields;
    - (iii) every bonding-curve buy and sell matches;
    - (iv) every swap's fee transfers (recipient and amount per leg) match the pre-upgrade split;
    - (v) the swap instructions' required account list, and the rent paid per buy and sell, are unchanged.
    Any failure, or any instruction that cannot be decoded, makes the upgrade economic. "The pinned formula" is the on-chain integer arithmetic (the decoder's quote function with its golden tests), not the exact-rational spot formula.
48. **Pending boundary (r3).** A boundary is pending for one day: the window's counts pause and no entries count. If the test clears it, the window continues, with that day reported. If not, it ends as economic. Nothing is voided while it is pending.
49. **Fee-only (r4).** "Fee-only" means only the numeric protocol and LP fee rates and tiers (lp_fee_basis_points, protocol_fee_basis_points, fee_basis_points, and the FeeConfig tiers and flat fees). Changes to creator or holder fees, fee_recipient(s), is_holder_reward_enabled or creator_fee_configurable end the window. "The higher of old and new" is applied per trade and per side, and to the random-entry benchmark too.
50. **Files (r1).** The run recomputes each referenced file's sha256 from disk and refuses if it differs from the sha recorded in the block; the keys use the recorded sha. If a value appears both inline and in a file, the run refuses when they disagree.
51. **Values (V-m1, V-m2, V-m3, r2).**
    - Fill the ARCH values now: PERTOKEN 1, per-token daily entries 3, LOSSRUN 5 losses then a 60-min pause, WEEKLOSS 6%, DDHALF 10% (×0.5), DDKILL 15%, FEEDAY 2,000,000 lamports, and lp_withdrawable_max 5%.
    - Add to `gates`: the R-4 stresses (2 × p95 latency, 2 × p_sw), the consistency flags (0.5×–2× trade rate, 15 pp stop share, 1.25× cost), the one-day decoder test, P-1's ≥ 100 trades, and the P-gate thresholds by reference to ARCH.
52. **Monthly figure (r5).** At the window's start, the figure (USD value, DECISIONS commit sha, row text) is copied into the run bundle. The run refuses only if the figure read at evaluation differs from the copy.
53. **Kill versus retry (r6).** The kill stands unless the failing gate, recomputed on the same window with the fix, passes. Then the window is burned, and the retry on unseen days counts as a new trial and goes to the owner first.
54. **whitelist_pda (r7).** Drop the "unless": a change to it is always economic.
55. **Kill rule 4 (r8).** "By 90 counted days, or 120 calendar days from the first W_B start, whichever comes first."

## Round 7 (head `68476fe9`): reviewer PASS (2 MINOR); red team 0 BLOCKER, 1 MAJOR, 5 MINOR

- Reviewer: m1, kill rule 4's 120 calendar days are not in the block; m2, name the branch that holds rounds 6 and 7 (`claude/supervisor-docs-2`).
- Red team:
  - R5-M1: nothing binds the gate evaluator to the hashed `gates` values.
  - r1: FeeConfig `Fees` includes creator_fee_bps.
  - r2: the pending period and the test day do not line up.
  - r3: test part 5 (per-trade accounts) and which decoder applies.
  - r4: the A-M13-02 key set against the block.
  - r5: FEEDAY is scaled in the report lines.

### Supervisor rulings for round 8 (8 Oct 2026, 3:18 PM)

56. **R5-M1.**
    - For PM-01, the gate evaluator loads every `gates.*` value from the merged block at run time; no PM-01 gate constants live in code. Each gate result records pm01FrozenKey.
    - pm01FrozenKey is compared with the value recorded in the preRegister record (A-M13-02), not only with the hash printed in the file.
    - AC: on a fixed synthetic window, changing one `gates` value (with the recorded hash updated) changes that gate's verdict; changing it without updating the hash refuses.
57. **r1.** Fee-only means changes to `lp_fee_bps` and `protocol_fee_bps` inside the FeeConfig tiers and flat fees, to `market_cap_lamports_threshold`, and to the listed Global/GlobalConfig lp and protocol rates. Any change to `creator_fee_bps` or `coin_creator_fee_basis_points` ends the window.
58. **r2.** Pending runs from the flag's slot to the end of the first full UTC day after it; then the verdict.
59. **r3.**
    - Part 5: for each trade, the accounts created and their sizes must equal what the pre-upgrade program creates from the same pre-state.
    - "Cannot be decoded" refers to the post-upgrade IDL, refreshed and pinned.
    - A decoder update mid-window must reproduce every decision on the pre-boundary data (a B-9-style check).
60. **r4.** The run refuses if any key A-M13-02 hashes is missing from the block, or present in the block but not hashed. Write down the mapping table.
61. **r5.** FEEDAY is not scaled in the report lines, the same as DEPTHPCT.
62. **Reviewer m1 and m2.** Add `killRule4MaxCalendarDays: 120` to the block. Cite `docs/reviews/PM01-PREREG.md` on `claude/supervisor-docs` for rounds 1–5 and on `claude/supervisor-docs-2` for rounds 6 and later.

## Round 8 (head `c0bdb04a`): reviewer PASS (1 MINOR); red team 0 BLOCKER, 0 MAJOR, 5 MINOR

- Block sha256 recomputed by both: `c410f1b5…86b9`, matches the file.
- Reviewer m1 = red team r2: FeeConfig also holds `stable_fee_tiers` and `exotic_flat_fees` (type `Fees`, pinned IDL); ruling 57 does not name them.
- Red team:
  - r1: preRegister is written once, but amendments fill the nulls and change pm01FrozenKey, so every run would be refused (or the check gets dropped).
  - r3: part 5 needs the pre-upgrade program itself.
  - r4: where the refreshed IDL comes from.
  - r5: kill-rule and pending_data logic is not tested against the block.

### Supervisor rulings for round 9 (8 Oct 2026, 3:23 PM)

No MAJOR is open, so these are the last text changes before merge (merge still waits on the owner's keep-or-undo answer, 3:10 PM).

63. **r1.** preRegister is append-only. Each amendment merged before the first run appends an entry with its merge sha and pm01FrozenKey; nothing is overwritten. A run compares against the latest entry and refuses if any entry is dated after the first run's start.
64. **m1 / r2.** Name `stable_fee_tiers` and `exotic_flat_fees`. They are the same `Fees` type, so the ruling 57 split applies to them: `lp_fee_bps` and `protocol_fee_bps` changes are fee-only, and a `creator_fee_bps` change ends the window. Each trade is costed at the higher of the old and new fee of the schedule it pays under, per side, as the PREREG already says for the other tiers (L221 at `c0bdb04a`). Why not the stricter reading: ending the window on fee-level changes that this costing already covers would stop the study for no proven reason.
65. **r3.** Part 5 runs the pre-upgrade program bytes (its program-data at the slot before the upgrade) on the post-upgrade pre-state in a local simulator. Pin that binary's sha256 in the boundary record. Name the simulator only after checking it exists and runs those bytes (**VERIFY**). If it cannot be run, part 5 fails and the upgrade is economic (fail closed).
66. **r4.** The refreshed IDL comes from, in order: (1) the program's on-chain IDL account read at a slot after the upgrade, if the program has one (**VERIFY**); (2) the IDL file the program's owner publishes, at a commit dated after the upgrade. Pin its sha256. A hand-edited IDL never counts. If neither exists by the end of the pending day, the upgrade is economic.
67. **r5.** Add acceptance cases: one synthetic fixture per kill rule 1–7 and one per pending_data path (side floor, n_b, the 100-trade floors), each asserting kill, pass or pending from the block's values.

## Round 9 (head `3134fd62`): reviewer PASS (0 findings); red team 0 BLOCKER, 1 MAJOR, 4 MINOR

- R7-M1: ruling 65's part 5 cannot be run: it needs every touched account's state just before each trade, and neither Old Faithful (transactions), M07 (pool state) nor standard RPC (current state only) holds it. So every upgrade would be economic, and PM-01 might never finish W_B (paralysis). The simulator and on-chain IDL VERIFYs are also missing from start-condition item 5.
- r1: "dated" entries can use free git dates. r2: trade counts read during W_B could be an unlogged first run. r3: "commit dated after the upgrade" is not proof of publication time. r4: a fixture where pending_data and a failing gate meet.

### Supervisor rulings for round 10 (8 Oct 2026, 3:28 PM)

68. **R7-M1.** Ruling 65 is replaced. Part 5 uses transaction data only. For each buy and sell on the pending day: (a) the swap instruction's account list matches the pinned pre-upgrade IDL's list for that instruction (new instructions go by part 6); (b) every account created inside the transaction (its inner create-account or ATA instructions), with size and rent lamports, is one that a rule table pinned now from the pinned IDLs allows for that instruction. Whether an account existed before is read from the transaction's own metadata (**VERIFY** which fields the archive's transaction metadata carries). The simulator stays an optional stronger check; its absence does not fail part 5. Start-condition item 5 becomes "every VERIFY in §6.2", with the full list written out.
69. **r1.** preRegister entries are ordered by their append sequence in the M13 registry, against the first-run record in the same registry; no date field is ever used.
70. **r2.** If the screen has not run, the first trade count computed during W_B is logged as the first run, which freezes the file and closes the preRegister record.
71. **r3.** "After the upgrade" for a published IDL means the first time this repo fetched that commit, recorded in the boundary record with the fetched sha; a commit first fetched after the upgrade slot counts. Commit dates are never used.
72. **r4.** Add combination fixtures: the excess test is pending_data (side floor not met) and B-2 fails with sufficient data → kill (kill rule 1); the same for W_R with R-2.

## Round 10 (head `e7a40562`): reviewer FAIL (1 MAJOR, 3 MINOR); red team 0 BLOCKER, 3 MAJOR, 5 MINOR

- Reviewer M1 = red team R8-M1: the pinned pump.json has no `*_v3` instructions, live since UPG-1 (2 Oct, venues.md L114, L136). Against it, part 6 (and 5(a)) fails on every pending day, so every upgrade is economic; and B5 itself would be economic under part 6, yet the class table still uses it as the decoder-only example.
- R8-M2: the forward windows (W_B, W_R, W_P) have no named source of full transactions with inner instructions and metadata for the pending day; start item 4 checks Old Faithful only.
- R8-M3: program-originated reserve changes (`boost_buy_and_burn`, buybacks) are not tested, so an upgrade that changes their size or rate passes as decoder-only.
- Minors: pre-funded ATAs and the rent check (r1); Token-2022 ATA base is 170 bytes (r2, reviewer m3, venues.md:145); creator-vault ATA creation from fixtures (r3); the screen after an early first run (r4); a race between the first-run record and an amendment merge (r5); sell_v2's accumulators (reviewer m1); `associated_quote_buyback_fee_recipient` (reviewer m2).

### Supervisor rulings for round 11 (8 Oct 2026, 3:34 PM)

73. **M1 / R8-M1.** Before the first run, pin post-UPG-1 IDLs for pump, PumpSwap and pump_fees through the ruling 66 / 71 source order, and add v3 rows to the rule table (a start-condition item). For each boundary, the "pre-upgrade IDL" is the latest IDL pinned before that boundary's slot. After a boundary is cleared or ruled economic, its refreshed IDL becomes the baseline for the next one, recorded in the boundary record. Part 6 stays unscoped (any new buy or sell instruction is a real economic-change candidate). Relabel B5: economic under the mechanical test (new swap instructions); it predates every PM-01 window, so it affects none. It is no longer the decoder-only example.
74. **R8-M2.** Name the source for forward windows. First choice: for the pending UTC day after any L-4 flag, the capture path writes the raw transactions it already reads for the watched programs, with inner instructions and metadata, to the recorder: no extra provider reads (**VERIFY** that the capture path carries them; add it to card Z08's acceptance as PROPOSED). Fallback: a capped sample, every swap in the universe pools that day, fetched through the rate limiter at no more than 50% of the provider's documented limit; if the cap is hit, the first N by slot, reported. If neither is in place by the first run, every forward upgrade is economic; say so in §6.2 with the expected restart rate. Start item 4 covers this source as well as Old Faithful.
75. **R8-M3.** Add part 7. Every non-user instruction on the watched programs that changes pool or curve reserves (`boost_buy_and_burn`, buybacks, fee withdrawals that move reserves) on the pending day: its amounts are recomputed from a pinned pre-upgrade rule where one exists; where none exists, its daily count and median size on universe pools must each lie within a factor of 2 of the 7 days before the boundary (daily mean count, median size). The factor 2 goes in the block now, before any data. Any difference makes the upgrade economic.
76. **r1.** For a created account: size equals the table size; lamports after creation ≥ the rent-exempt minimum; rent paid by the user = max(0, minimum − pre-balance).
77. **r2 / reviewer m3.** Token-2022 ATAs: cite venues.md:145 (170 bytes, measured); keep the per-mint VERIFY for more extensions; never code "165 plus extensions" literally.
78. **r3 / reviewer m1 / m2.** Resolve the fee-recipient, creator-vault and `associated_quote_buyback_fee_recipient` accounts, and sell_v2's `user_volume_accumulator` and `associated_user_volume_accumulator`, from golden fixtures of real transactions (including first trades in new pools), not from the IDL alone; all named in the VERIFY at L228.
79. **r4.** If the first run has already happened (L28), the screen runs as a later run against the frozen file; it can still only stop PM-01.
80. **r5.** Before writing the first-run record, the run checks that the latest preRegister entry's sha equals the current merged head of the file; otherwise it refuses.

## Round 11 (head `8397734f`): reviewer PASS (2 MINOR); red team 0 BLOCKER, 2 MAJOR, 4 MINOR

- Block sha256 `d52035bd…a92d`, recomputed by both.
- R9-M1: part 6 makes any new swap instruction economic, though the same day's data can show its amounts, fees and accounts match the old rules (B5 is that case); new-instruction upgrades are likely inside a 30–60-day W_B, so this blocks with no proven reason.
- R9-M2: part 7's raw factor-2 band fails both ways: an honest busy day falls outside it; a 1.5× change stays inside.
- Minors: the fallback sample has no data for parts 2, 3 and 7 (r1); the first-run sha check compares unlike shas (r2); start item 8 does not block (r3); the baseline after an economic ruling with no refreshed IDL is undefined (r4); reviewer m1, the fallback cap N is not in the block; reviewer m2, the restart estimate cites the wrong limit for W_B.

### Supervisor rulings for round 12 (8 Oct 2026, 3:39 PM)

81. **R9-M1.** Ruling 73's unscoped part 6 is replaced. A new swap instruction is not economic by itself: its trades are decoded with the refreshed pinned IDL and must pass parts 1–4 on the pinned pre-upgrade formula and fee split; for part 5 each of its accounts is mapped by role (same PDA seeds, or same ATA owner and mint) to the old instruction's account it replaces, and each created account must match that role's rule-table row. An unmapped role or any mismatch makes the upgrade economic. Part 6 stays only for an instruction no pinned IDL can decode. Re-check B5 under this rule and label it with the result.
82. **R9-M2.** Part 7 compares normalised ratios per universe pool: buyback lamports ÷ fees collected that day, boost burn ÷ pool swap volume. Economic only when both a two-sample KS test rejects (α = 0.01, at least 100 events per side) and the median ratio moves by more than 10%; requiring both keeps a large sample from flagging trivial differences and a small one from missing real ones. Where a rule can be pinned (for example from `buyback_basis_points`; **VERIFY**), recompute exactly instead. Fewer than 100 events: pending one more day (cumulative), then economic. Put the test, α, the minimum count and the tolerance in `gates.boundary`, replacing the factor 2.
83. **r1.** The fallback also fetches every migration of the day, a capped sample of curve trades, and every program-side reserve instruction on universe pools; the sample is stratified per hour; a part with no data makes the upgrade economic, stated.
84. **r2.** Each preRegister entry records the blob sha of PREREG.md (`git hash-object` at the integration head) and pm01FrozenKey; the first-run check compares those, never a commit sha.
85. **r3.** Start item 8 needs an explicit recorded choice in DECISIONS: capture path verified, fallback verified, or "every forward upgrade economic". The last choice decides whether PM-01 can finish, so the supervisor puts it to the owner with the expected restart rate (about 1 per 15 days, DERIVED) before the first run.
86. **r4.** With no refreshed IDL pinned, the baseline stays the previous pinned IDL; every later boundary is judged against it, new instructions per ruling 81.
87. **Reviewer m1.** Add `gates.boundary.fallbackSwapCap` (the N) to the block before the first run.
88. **Reviewer m2.** Reword: "W_B would usually restart, and kill rule 4's 120-day clock would then send PM-01 to the owner; inside W_R or W_P, R4-3's one-restart limit does".

## Round 12 (head `8d4c3e3d`): reviewer PASS (3 MINOR); red team 0 BLOCKER, 1 MAJOR, 4 MINOR

- Block sha256 `6531852e…5dc6`, recomputed by both. The reviewer accepts B5's label "not yet tested, counted economic until tested".
- R10-M1: part 7's 100-event minimum, read per pool or even pooled, will rarely be met; 0 events against 0 also fails; so honest upgrades become economic after two days.
- r1: "KS and median" misses tail changes. r2: the 7-day look-back can cross an earlier boundary. r3 = reviewer m3: no curve-trade cap in the block. r4: role mapping by seeds alone misses a change of owner program.
- Reviewer m1: testing B5 needs 10-03 data, outside the Old Faithful allow-list. m2: part 7's VERIFY is not in the start item 5 list.

### Supervisor rulings for round 13 (8 Oct 2026, 3:42 PM)

89. **R10-M1.** Part 7 pools events across universe pools: one KS test per ratio type, Bonferroni α = 0.01 ÷ the number of types. For a type below the minimum on either side: 0 against 0 passes for that type; absent before and present after is economic; otherwise compare event rates per unit of swap volume with an exact Poisson rate-ratio test at the same α. Economic only if a test rejects (with ruling 90's size rule) or an exact pinned rule fails. Put the method in `gates.boundary`. Measure each type's daily count on the B-10 days when they are read (counting events only, not a PM-01 signal) and record it in DECISIONS before the first run.
90. **r1.** Economic if KS rejects and any of the median, the mean or the 90th percentile of the ratio moves by more than 10%. Mean and p90 go in `gates.boundary`.
91. **r2.** The look-back starts at the later of (boundary − 7 days) and the previous boundary's slot plus its pending period; too few events → ruling 89's path.
92. **r3 / reviewer m3.** Add `gates.boundary.fallbackCurveTradeCap` (null until set; the start refuses while null), stratified per hour.
93. **r4.** Map by PDA seeds and deriving program id, or by ATA owner, mint and token program; anything else is unmapped, so economic.
94. **Reviewer m1.** B5 stays counted economic and is not tested: no read outside the allow-list, and it affects no window.
95. **Reviewer m2.** Add part 7's pinned-rule VERIFY as start item 5.9.

## Round 13 (head `a2d9a02f`): reviewer PASS (1 MINOR); red team 0 BLOCKER, 0 MAJOR, 3 MINOR

- Block sha256 `1ca7e8cc…b381`, recomputed by both; base merge `047cf6c5` touches no PM-01 file.
- Nothing at MAJOR remains. Reviewer m1: the Poisson path's 10% size rule is not in the block. Red team: r1, "absent before" over a short look-back flags rare, long-standing instructions; r2, reserve-changing types beyond the two listed ratios have no test; r3, whole-day denominators skew partial pending days.

### Supervisor rulings for round 14, the last text changes (8 Oct 2026, 3:45 PM)

96. **Reviewer m1.** Add `gates.boundary.part7.lowCount.sizeRule` (`{"on": "rate", "toleranceBps": 1000}`) so the evaluator applies it from the block.
97. **r1.** "Absent before" means not seen since the latest pinned IDL baseline and not in the item 5.10 B-10 counts. Only a type never seen before is new. A type seen before but rare takes the Poisson path over the longest look-back that does not cross the previous economic boundary.
98. **r2.** Every reserve-changing type with no pinned rule and no listed ratio is compared on its event rate per unit of swap volume (Poisson path) and its reserve-delta size distribution (KS plus the size rule). Items 5.9 and 5.10 list every such type found in the B-10 days.
99. **r3.** Numerator and denominator cover the same span: fees and volume over the same UTC hour as the event, or over the covered span of a capped sample.

After this push, one closure check by the reviewer and the red team; then #294 is ready, and its merge waits only on the owner's keep-or-undo answer (3:10 PM).

## Round 14 (head `fee8cf16`): reviewer PASS (no findings); red team 0 BLOCKER, 0 MAJOR, 2 MINOR

- Block sha256 `e4146b30…6d68`, recomputed by both.
- r1: hourly ratios can have a zero denominator. r2: unlisted types use raw sizes, which follow trading activity.

### Supervisor rulings for round 15 (8 Oct 2026, 3:48 PM)

100. **r1.** Events with a zero denominator go into a separate count, compared before and after by the Poisson path; they are left out of the KS sample, and their share is reported.
101. **r2.** Unlisted types' reserve deltas are normalised by the pool's swap volume or fees collected over the same span (as `ratioSpan`) before the KS test and the size rule; raw sizes only where no activity measure applies, stated per type in item 5.9.

The red team's own fixes, taken as written. After this push the reviewer checks closure, and #294 is ready; its merge waits only on the owner's keep-or-undo answer (3:10 PM).
