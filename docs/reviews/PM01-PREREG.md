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
