# PM-01 PREREG (PR #294) review log

## Round 1: researcher's proposals (head `0415011e`)

Prediction stated by the researcher: a loss (neighbouring tests −10.6% and −22.4%; hurdle about 4.4–5.1% at $5–$20). PM-01 is tested only to confirm or refute it, and never traded unless it passes.

### Supervisor rulings (8 Oct 2026, about 9:30 AM)

1. **P1 (blocking): accepted, as a PM-01-only rule fixed in the PREREG.** The M08 dump-flag baseline for PM-01 runs from migration to now − 30 min and needs at least 10 min of data; the dump rule itself is unchanged; the first valid entry is migration + 40 min. Other strategies keep the 6 h baseline. The report counts how many entries relied on a baseline shorter than 6 h, and gives the result with and without them. Reason: as specified, no pool younger than 120 min can have a valid decision, so PM-01 could never enter; "Discipline, not paralysis" calls that a defect to fix, and a fail-closed `insufficient` stays for anything under 10 min.
2. **P2: accepted.** Random-entry matching for PM-01 uses MAD measured since migration and L = 60 s, fixed in the PREREG.
3. **P3: accepted.** The gates decide at $5 with E_bt = 20 SOL on the live-small profile. $20, $100, $1,000 and $10,000 are reported lines with scaled E_bt and ceilings, never gate inputs, with gross return, fixed costs, percentage fees and price impact shown apart ("Size is not the trial").
4. **P4: accepted.** A market boundary that changes trade economics ends the window; a decoder-only boundary is reported and the window continues. The doc lists which boundary types fall in each class.
5. **P5: accepted as the proposal for the OF-3 step.** K3 keeps migration to migration + 300 min. The supervisor records it in DECISIONS with the measured sizes before batch 3, together with the retention choice.
6. **Kill-only screen on the B-10 days:** not added. It is a new task, so it is put to the owner. Until the owner answers, the PREREG mentions it only as an option.

Next: the researcher applies 1–5, marks P1–P5 as ruled in DECISIONS (not proposals), and reports the new head. Then a fresh reviewer and a red team.

## Round 2 (head `19c0a712`, researcher `session_015oSGiMB1sKnM13Di7CE8np`)

P1–P5 were applied. The researcher's points and the supervisor rulings (8 Oct 2026, about 9:42 AM):
1. **"With and without" is always empty**, since every PM-01 entry is in a pool younger than 120 min. Replaced with a split at the baseline: at least 60 min (entry at migration + 90 min or later) against under 60 min. Both lines are reported, and the gates use all entries.
2. **The 50% coverage rule is kept over the new span:** accepted, as the stricter choice.
3. **B1 counts as economic:** accepted.
4. **An economic boundary inside W_R or W_P** ends that window and voids W_B's selection. A new W_B selection runs on data after the boundary and counts as a new trial.
5. **Kill-only screen** (owner, about 9:28 AM, "Ok"): a fixed section, written before any B-10 day is looked at. It states the kill rule on 07-22..08-21, the minimum trade count, the cost model and the size ($5), and that the screen can never pass PM-01.

## Round 3 (head `32fdea71`): kill-only screen §6.4 added

The researcher's choices and the supervisor rulings (8 Oct 2026, about 9:46 AM):
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
