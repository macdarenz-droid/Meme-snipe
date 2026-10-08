# Step A count rows: tape code

Implements `../STEP_A_COUNT_ROWS.md` (frozen). The code reads flows, counts and timing only, and computes no strategy return, outcome or price change. Row 6 reads market-cap levels, as Design A's frozen gate 2 defines them; it never reads a change. The registered thresholds run only with `--decide`, after Step A is complete and a reviewer has passed this code.

## Run
```
nice -n 19 python3 run_step_a.py --unit <cache>/<day>/<from>-<to> [--unit ...] --out OUTDIR \
    [--sol-usd sol_usd.csv] [--boot 10000] [--decide] [--plan FILE]
nice -n 19 python3 -m unittest -v        # from this folder
```
- `--unit`: a unit directory (`<day>/<from>-<to>`, or its `research/` folder), repeated. The day comes from the path. Windows must lie inside contiguous loaded units.
- `--sol-usd`: CSV `day,sol_usd`, one reading per tape day. Take the values from the Binance public archive. The code makes no network request, so row 6 reports "needs SOL/USD" until the file is supplied.
- `--decide` stops with an error unless the loaded units equal the plan rows for 09-11 and 09-10 exactly, with contiguous slots. The plan is `--plan`, by default `research/shared-tape/stepa-plan.txt`, and its sha256 goes into the summary (`tapeio.check_plan`).
- DEV-ZERO's events per day list every loaded day, with 0 for a day that has no events. Row 6 reports `None` (not `False`) for "not separable" when any day lacks a SOL/USD price. Gate 3 counts only the creator's swaps inside the pool's window (end of BOOST or m + 5 min, up to hour 72 or the end of the tape).
- Needs pandas, numpy, zstandard. Two units of 09-11 take about 3.5 minutes and about 3 GB of RAM.

## Outputs (in OUTDIR)
- `stepa_summary.json`: one block per row (`1_dev_zero` … `6_round_usd`). It also gives the loader counts: swaps, BOOST rows excluded, first-time buys, and rows labelled as fake demand. With `--decide`, a `decision` block is added.
- One CSV per row:
  - `stepa_dev_zero.csv`: events and controls per arm, with the drop reason.
  - `stepa_rebuy_exits.csv`.
  - `stepa_seat_drift.csv`: per graduate, N_m and the two windows.
  - `stepa_age_gate.csv`: one step per coin, age and class.
  - `stepa_two_sided_labels.csv`: rule, mint, owner.
  - `stepa_round_usd.csv`.

## Files
- `tapeio.py`: the loader.
  - Joins S_curve and S_amm into one swap table, with `owner` = `user_token_owner`.
  - Reads BOOST, create, migration and pool-create events from E, and T/W links, CF and B.
  - Checks that windows are covered by contiguous loaded units.
- `rows.py`: the rows and their helpers.
- `run_step_a.py`: the entry point.
- `test_rows.py`: unit tests on synthetic units written to a temporary folder.

## Mapping: registered item → function (`rows.py`)
| Item | Function |
|---|---|
| Shared: BOOST and protocol rows excluded | `tapeio.swaps_from` (`excluded`) |
| Shared: first-time buyer | `first_time_flags`, `history_on_tape` |
| Shared: effective quote (vault + signed `virtual_quote_reserves`) | `eff_quote` |
| Shared: canonical non-mayhem SOL graduate pools | `eligible_pools` |
| Shared: creator group (T/W union-find, as of the slot, hub cap 50) | `creator_group` |
| 1 DEV-ZERO: crossings below 5% (placebo 4.2%), zero flag (control: near-full exits, dropped if the dev sells again), below 3% (placebo 2.4%), ≥ 60 min after migration | `dev_zero` |
| 1 Row: excess first-time buyer SOL in (e + 23 slots, e + 15 min] minus existing holders' selling, without BOOST, protocol or creator-group rows | `dev_zero` (`net`), summary `median_net_excess` |
| 1 Thresholds: median ≥ 3.4% with 95% LB > 0; ≥ 50% after 23 slots; ≥ 11 events a day | `dev_zero` summary, `dev_zero_decide` |
| 2 REBUY-ANCHOR: ex-holder exits, rebuy within 2 h by exit size, share of proceeds readable | `rebuy_anchor` |
| 2 Odds ratios, predicted rebuy SOL, top-quintile decisions, R² | not computed: blocked by the no-price/no-return rule (OPEN_QUESTIONS Q14, Q15); listed in the summary |
| 3 SEAT-DRIFT: N_m in [m − 90 s, m + 90 s] with G1-CAP's definitions | `seat_drift` |
| 3 Busy minus lone first-time buyer SOL in (m + 60 min + 23 slots, m + 120 min] and in [m + 40, m + 60 min] | `seat_drift`, `seat_drift_decide` |
| 4 AGE-GATE: round ages 5, 10, 15, 30, 60 min (from create and from migration) vs placebo ages ±3, 4, 5, 7, 11 min, by W1 class | `age_gate`, `w1_fast_class` |
| 5 Two-sided clusters, hub-cap-50 and hub-keyed rules side by side: share of volume, size distribution | `cluster_maps`, `two_sided_clusters` |
| 5 Used as a label to exclude fake demand from first-time-buyer counts | `fake_demand_set`, `prepare` (`fake`) |
| 6 Round-USD: SOL levels equal to $50k and $100k per day; bunching; placebos within 10% dropped; 420 within 5% flag | `round_usd`, `placebo_grid`, `mcap_segments`, `log_ratio` |
| 6 Gate 3 descriptive split: focused vs spread creators, with CF collections | `gate3_split` |

Choices the frozen text leaves open are in `OPEN_QUESTIONS.md` (Q1–Q21), each with the conservative reading the code uses.
