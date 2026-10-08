# Step A count rows: tape code

Implements `../STEP_A_COUNT_ROWS.md` with `../COUNT_ROWS_AMENDMENT_1.md`, `../COUNT_ROWS_AMENDMENT_2.md` `_4` to `_6`, and the count-row parts of `../H8_AMENDMENT.md` and `../H8_AMENDMENT_2.md` (all frozen). The code reads flows, counts and timing, and computes no strategy return or outcome. Under the amendment's Q14 rule, rows may read as-of price levels and as-of past returns. After a decision or event point, they read flows only, never a price. The registered thresholds run only with `--decide`, after Step A is complete and a reviewer has passed this code.

## Run
```
nice -n 19 python3 run_step_a.py --unit <cache>/<day>/<from>-<to> [--unit ...] --out OUTDIR \
    [--sol-usd FOLDER] [--boot 10000] [--decide] [--plan FILE]
nice -n 19 python3 -m unittest -v        # from this folder
```
- `--unit`: a unit directory (`<day>/<from>-<to>`, or its `research/` folder), repeated. The day comes from the path. Windows must lie inside contiguous loaded units.
- `--sol-usd`: a folder of Binance `SOLUSDT-1m-<day>.zip` files with `SHA256SUMS`. The default is the committed `research/brainstorm-loop/sol-usd/`. Every loaded tape day's file is checked against `SHA256SUMS`, and the run stops with an error on a missing day or a mismatch (`load_sol_usd_dir`). The shas go into the summary. Row 6 and the H8 rows read this input. The code makes no network request.
- `--decide` stops with an error unless the loaded units equal the plan rows for 09-11 and 09-10 exactly, with contiguous slots. The plan is `--plan`, by default `research/shared-tape/stepa-plan.txt`, and its sha256 goes into the summary (`tapeio.check_plan`).
- DEV-ZERO's events per day list every loaded day, with 0 for a day that has no events. Row 6 reports `None` (not `False`) for "not separable" when any day lacks a SOL/USD price. Gate 3 counts only the creator's swaps inside the pool's window (end of BOOST or m + 5 min, up to hour 72 or the end of the tape).
- Needs pandas, numpy, zstandard. Two units of 09-11 take about 7 minutes with the H8 rows and about 3 GB of RAM.

## Outputs (in OUTDIR)
- `stepa_summary.json`: one block per row (`1_dev_zero` … `6_round_usd`). It also gives the loader counts: swaps, BOOST rows excluded, first-time buys, and rows labelled as fake demand. With `--decide`, a `decision` block is added: each row's own thresholds (`own_thresholds`; DEV-ZERO's arms in the frozen order, each only after the earlier ones pass), the `PAYER_MASS.md` bar per row as defined by `../COUNT_ROWS_AMENDMENT_7.md` (`payer.py`: computed for SEAT-DRIFT; DEV-ZERO and REBUY-ANCHOR stay "not computed" pending `../CODE_REDTEAM.md` R1-17, so they never earn), and the result per row. `--decide` refuses any `--boot` other than 10,000.
- One CSV per row:
  - `stepa_dev_zero.csv`: events and controls per arm, with the drop reason.
  - `stepa_rebuy_exits.csv`: per exit, proceeds, exit VWAP, gain and readable.
  - `stepa_rebuy_points.csv`: per decision point, mid, RB, net rebuy flow, past return, drawdown, age and depth.
  - `stepa_rebuy_pairs.csv`: per (ex-holder, point), below the sale price and rebuy within 2 h.
  - `stepa_seat_drift.csv`: per graduate, N_m and the two windows.
  - `stepa_age_gate.csv`: one step per coin, age and class.
  - `stepa_two_sided_labels.csv`: rule, mint, owner.
  - `stepa_round_usd.csv`.
  - `stepa_h8_pool_hours.csv`, `stepa_h8_graduates.csv`: H8 eligibility per pool-hour and per graduate, with the failing check per size.
  - `stepa_slicer_events.csv`, `stepa_slicer_low_b_placebo.csv`, `stepa_slicer_controls.csv`, `stepa_mig_seat.csv`, `stepa_mayhem_snap_down_steps.csv`.
- The summary adds `8_slicer_ride`, `9_mig_seat` and `10_mayhem_snap`.
- The summary also carries `h8_stratum_rows_1_3` (rows 1–3 recomputed per size) and `7_h8_capacity` (per day).

## Files
- `tapeio.py`: the loader.
  - Joins S_curve and S_amm into one swap table, with `owner` = `user_token_owner`.
  - Reads BOOST, create, migration and pool-create events from E, and T/W links, CF and B.
  - Checks that windows are covered by contiguous loaded units.
- `rows.py`: rows 1 and 3–6 and their helpers.
- `h8.py`: rows 1–3 on the H8-eligible stratum and the H8 capacity count row (`../H8_AMENDMENT.md`, `../H8_AMENDMENT_2.md`). Each point is checked under its universe tag (U2, U1, not tradable), with H6, dust at migration and H11, at $5 (the trial line) through $10,000; the capacity row also counts canonical pools whose creator fee is 0.
- `slicer.py`: the slicer-ride count rows (`../COUNT_ROWS_AMENDMENT_4.md`). Counts only; when every row passes, the counts go to the owner and no PREREG is written.
- `migseat.py`: the MIG-SEAT rows G1–G8 with the kill row, and the MAYHEM-SNAP rows (a)–(e) (`../COUNT_ROWS_AMENDMENT_5.md`, `_6.md`).
- `rebuy.py`: row 2. It uses H1-CGO's ledger (`research/h1-cgo/tape/h1cgo/ledger.py`), loaded read-only.
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
| Shared: 95% bounds (A1 Q1: pool-clustered, stratified by day) | `boot_lb_clustered` |
| 2 Cost ledger with exit price and realised gain (A1) | `rebuy.ledger_exits` (H1-CGO `Ledger`) |
| 2 Decision points m + 1 h … m + 12 h, as-of mid, RB, net rebuy flow (A1 Q15) | `rebuy.rebuy_anchor` |
| 2 Odds of a rebuy below vs above the sale price; gain vs loss sellers (≥ 1.5, LB > 1) | `rebuy.odds_ratio`, `rebuy.summarise` |
| 2 Share of gain ex-holders who rebuy within 2 h once below the sale price, by exit size | `rebuy.summarise` (`a2_...`) |
| 2 Materiality: top-quintile RB vs ±10 points of median, within day × drawdown tercile (≥ 3.4%, LB > 0) | `rebuy.materiality_sets`, `rebuy.stratum_diff` |
| 2 ≥ 80% of proceeds readable; ≥ 30 top-quintile decisions a day; R² < 0.3 | `rebuy.summarise`, `rebuy.rebuy_decide` |
| 3 SEAT-DRIFT: N_m in [m − 90 s, m + 90 s] with G1-CAP's definitions | `seat_drift` |
| 3 Lone/busy = bottom/top tercile of N_m per day (A1 Q9); a value equal to a cut goes to the lower bin, with ties reported (A2) | `assign_terciles`, `seat_drift` |
| 3 Busy minus lone first-time buyer SOL in (m + 60 min + 23 slots, m + 120 min] and in [m + 40, m + 60 min] | `seat_drift`, `seat_drift_decide` |
| 4 AGE-GATE: round ages 5, 10, 15, 30, 60 min (from create and from migration) vs placebo ages ±3, 4, 5, 7, 11 min, by W1 class | `age_gate`, `w1_fast_class` |
| 5 Two-sided clusters, hub-cap-50 and hub-keyed rules side by side: share of volume, size distribution | `cluster_maps`, `two_sided_clusters` |
| 5 Used as a label to exclude fake demand; only clusters of 2–50 owners, with the share before and after the cap (A1 Q13) | `two_sided_clusters`, `fake_demand_set`, `prepare` (`fake`) |
| 6 SOL/USD from 1-minute closes with sha256 (A1) | `run_step_a.read_sol_usd`, `px_range` |
| 6 Round-USD: SOL levels equal to $50k and $100k per day; bunching; placebos within 10% dropped; 420 within 5% flag | `round_usd`, `placebo_grid`, `mcap_segments`, `log_ratio` |
| H8: floor max($15,000, 1,000 × size) at the hour's SOL/USD | `h8.hourly_px`, `h8.eligible` |
| H8 item 1: rows 1–3 on the H8-eligible stratum at $5, $20, $50 | `h8.dev_zero_stratum`, `h8.rebuy_stratum`, `h8.seat_drift_stratum` |
| H8 item 4: H8-eligible pool-hours and graduates per day | `h8.h8_capacity` |
| H8_AMENDMENT_2: universe-tagged floors, H6, dust, H11, sizes $5–$10,000, creator-fee-0 pools | `h8.universe`, `h8.floor_usd`, `h8.GateCtx.check`, `h8.h8_capacity` |
| Amendment 4: slicer event, exclusions, rows (a)–(i), dispersed control, low-B placebo | `slicer.find_events`, `slicer.measure`, `slicer.dispersed_controls`, `slicer.slicer_rows` |
| Amendment 5: MIG-SEAT G1–G8 and the kill row, by gradual/instant arm | `migseat.graduations`, `migseat.w_group`, `migseat.mig_seat`, `migseat.arm_rows` |
| Amendments 5–6: MAYHEM-SNAP (a)–(e), placebos, the re-price rule invariants, `prereg_may_be_written` | `migseat.reprice_steps`, `migseat.mayhem_snap`, `migseat.non_agent_sell_placebo` |
| 6 Gate 3 descriptive split: focused vs spread creators, with CF collections | `gate3_split` |

Choices the frozen text leaves open are in `OPEN_QUESTIONS.md` (Q1–Q22, each marked with the amendment's ruling), each with the conservative reading the code uses.
