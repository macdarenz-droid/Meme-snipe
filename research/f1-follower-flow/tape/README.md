# F1 counts gate: tape code

Implements `../GATE.md` (frozen) as counts only. It reads no price, return or outcome. The kill rules run only with `--decide`, and only after Step A (09-11 and 09-10) is complete and a reviewer has passed this code.

## Run
```
nice -n 19 python3 f1_counts.py --unit <cache>/2026-09-11/<from>-<to> [--unit ...] --out OUTDIR [--boot 10000] [--decide --min-buys N] [--plan FILE]
nice -n 19 python3 -m unittest -v        # from this folder
```
- `--unit`: a unit directory (`<day>/<from>-<to>`, or its `research/` folder), repeated. The day comes from the path. Units of 09-11 are day 1 and units of 09-10 are day 2; no other day is read.
- `--decide` requires both of these, and stops with an error otherwise:
  - `--min-buys N`, the minimum used buys per leader, picked by the lead (there is no default);
  - loaded units that equal the plan rows for 09-11 and 09-10 exactly, with contiguous slots. The plan is `--plan`, by default `research/shared-tape/stepa-plan.txt`, and its sha256 goes into the summary.
- Needs pandas, numpy, zstandard.

## Outputs (in OUTDIR)
- `f1_summary.json`: counts per step (candidates, buys used, drops by reason, followed leaders, persistent leaders, persistent-leader buys on day 2, follower SOL and the part landing after 23 slots). With `--decide`, also `decision.kills` and `decision.f1_closes`.
- `f1_events_day1.csv`, `f1_events_day2.csv`: one row per leader buy (follow count, follower SOL, late SOL, placebo owner, slot and follow count, or the drop reason).
- `f1_leaders_day1.csv`, `f1_leaders_day2.csv`: per leader, mean follow, mean placebo, difference, one-sided 99.5% lower bound, followed flag.

## Mapping: GATE.md item → function
| GATE.md item | Function |
|---|---|
| Data: S (curve and PumpSwap) with `owner` (= `user_token_owner`) | `load_units`, `normalise_swaps` |
| Leader candidate (≥ 10 buys on distinct mints on 09-11) | `leader_candidates` |
| Follower buy (same mint, ≤ 600 slots after, not the leader, not linked) | `follow_stats` |
| Linked (T or W transfer of the mint or of SOL between them) | `build_links`, `linked` |
| Follow count (distinct follower owners) | `follow_stats` |
| Placebo (seeded random non-candidate buy of the same mint within ±1,800 slots; dropped if none) | `event_table` |
| Statistic 1: followed leaders on day 1 (bootstrap over its buys, one-sided 99.5% bound > 0) | `leader_test` on `event_table(day 1)` |
| Statistic 2: persistence on day 2 | `run` (`leader_test` on day 2 for day-1 followed leaders) |
| Statistic 3: share of follower SOL after 23 slots (day-2 events of persistent leaders) | `follow_stats` (late volume), `run` (`late_share`) |
| Kill rules (20 leaders; half persist; 50% after 23 slots; 15 buys a day) | `decide` (only with `--decide`) |
| Complete Step A days for the decision | `check_plan` |

Choices the gate leaves open are in `OPEN_QUESTIONS.md`, each with the conservative reading the code uses.
