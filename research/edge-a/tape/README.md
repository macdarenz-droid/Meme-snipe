# Design A on the shared tape

Scoring code for Design A (the 420 SOL creator-fee step), as frozen in `research/EDGE_DIALOGUE.md` ("## Agreed designs", Design A) with `research/brainstorm-loop/A_AMENDMENTS_ROUND7.md`. Readings where the design is silent are in `OPEN_QUESTIONS.md`.

## Entry point
`run_a.py`. Python 3 with pandas, numpy and zstandard. Run every data command with `nice -n 19`.

```
# check mode: counts and shapes only, no gate statistic
nice -n 19 python3 run_a.py --days 2026-09-10 2026-09-11 --cache /home/user/tape-cache --out OUT
nice -n 19 python3 run_a.py --days 2026-09-11 --units /home/user/tape-cache/2026-09-11/446265000-446269499 ... --out OUT

# scoring: only after Step A is complete and a reviewer has passed this code
nice -n 19 python3 run_a.py ... --score-primary --confirm REVIEW-PASSED-AND-STEP-A-COMPLETE
```

**Inputs**
- Unit directories (`<day>/<from>-<to>` or its `research/`), or `--cache` with `--days`. The tables read are `B`, `E` (migration, CreatePool, BOOST events) and `S_amm`. These columns exist in schema v1 and v2.
- `--days`: every unit must be from one of them. A day on or after 2026-09-12, or any row at or after 2026-09-12T00:00Z, raises `WallError`.
- The steps (A, B, C) come from `--days` (`load.STEP_DAYS`), and the count rule uses them.
- `--plan`: the planned units (default `/home/user/tape-work/plan.txt`). `--score-primary` refuses `--units` and `--max-units`, and needs the days to be exactly Step A, A+B or A+B+C, each day fully covered with the planned contiguous units (`load.scoring_steps`, `load.check_days_complete`). It also refuses A+B (or A+B+C) when an earlier step already met the count rule, since the gates are scored once, at that step (`run_a.earlier_step_met`), and any `--n-boot` other than the registered 10,000.
- `--fee-config`: the FeeConfig tiers (default `research/edge/snapshot/fee-configs.json`), used for the supply-rule check.

**Outputs** (in `--out`)
- `summary.json`: units, schema, covered segments, pools migrated and eligible, exclusions by reason, BOOST-window rule counts, the count rule and its next step, the supply-rule check, the cutoffs, and cross events per cutoff.
- `pools.csv`: one row per migrated pool: eligibility, reason, window `lo`/`hi`, swaps, seconds in the window, count-rule flag. Check mode writes no band times.
- `entries.csv`: causal cross events (first cross from below per pool and cutoff), for the later return test.
- With `--score-primary` only: `gates.json` (count rule, Gate 2 and Gate 3 with point, 95% interval and pass, and the decision) and `features.npz` (per-pool band seconds and creator net SOL).

## Design to code
| Registered item | Where |
|---|---|
| Market cap = effective quote (vault + signed `virtual_quote_reserves`) × supply ÷ base reserve (amendment a) | `features.market_cap_sol` |
| Which supply the tier rule uses (amendment a): live `base_supply`, checked against charged creator fees where live and fixed supply pick different tiers | `features.supply_rule_tally`, `run_a.supply_verified`; scoring refuses below 99.9% |
| Pools: canonical PumpSwap SOL pools of pump.fun graduates, not mayhem | `features.pool_table`, swap checks in `run_a.build` |
| Hours 0–72 after migration | `features.pool_table` (`hi`), `features.clip_to_window`, `features.in_window` |
| BOOST window excluded: migration to the end of the last `BoostBuyAndBurnEvent`, else first 5 minutes (amendment b) | `features.pool_table` (`lo`), `features.clip_to_window`, `features.in_window` |
| Each swap's market cap holds until the next swap or hour 72 | `features.timeline`, `features.clip_to_window` |
| Count rule: 200 pools trading within ±5% of 420; else Step B, then Step C; else unresolved (amendment c: unchanged) | `features.count_rule_pools`, `gates.count_rule`, `load.STEP_DAYS`, `load.scoring_steps`, `load.check_days_complete` |
| 20 placebo cutoffs on a log grid 340–1,300, > 10% from 420 and 1,470 | `features.placebo_grid`, `features.cutoffs` |
| Gate 2: log(time in [c, 1.05c) ÷ time in [0.95c, c)) at 420 minus the placebo median | `features.band_seconds`, `gates.gate2_stat` |
| Gate 3: coin_creator (signer or token owner) net SOL bought per hour in [399, 441) minus the placebo median | `features.creator_net`, `features.band_seconds`, `gates.gate3_stat` |
| Pool-clustered bootstrap; both gates need a 95% lower bound > 0, else A closes and no return is read | `gates.pool_bootstrap`, `gates.score_gates` |
| Return test (`../AMENDMENT_2.md` Q9): entry at the cross + 23 slots, stop under 0.95 L or 60 min, $50 primary and $5, costs in SOL, 99.58% pool-clustered bootstrap by day | `features.cross_events` (causal entries); `outcomes.score_return_test`, run by `run_a` only when both gates pass and count row 6 (Q11, `gates.score_gates`) does not mark the result not separable |
| Q5 registered: 10,000 resamples, seed 20261009 for both gates | `gates.DEFAULT_B`, `gates.DEFAULT_SEED` |
| No row from 2026-09-12 | `load.check_day`, `load._guard_times`, `load.select_units` |

## Look-ahead
- Gates read no returns.
- `features.py` and `gates.py` never import `outcomes.py`, and a test checks this.
- Cross events use only the crossing row. A test plants a future-only marker and checks that every event up to that time is unchanged.

## Tests
`cd research/edge-a/tape && python3 -m unittest`. There are 27 tests on synthetic units. They cover:
- band seconds, the BOOST window, exclusions and the count rule;
- gaps, the 72-hour clip, the wall and look-ahead;
- gate values, and -inf placebos counted as +inf;
- the bootstrap and the supply check where tiers differ;
- the step map, day coverage against the plan, and the CLI scoring guards (one look at the gates, 10,000 resamples).

Mutation checks were run on band width, the 5-minute window, the window edge, the interval value, placebo handling, the BOOST end and the creator match. Each mutation fails a test.

## Development run (2 units, counts only)
Units 2026-09-11 446265000–446273999, both v2, about 1 hour of tape:
- 52 pools migrated and 29 were eligible. Excluded: 17 mayhem, 4 with no known BOOST end, 2 with a non-SOL quote.
- 6 pools met the count rule. The status is "short: add Step A days", because one partial day completes no step.
- Supply-rule check: on the 5,565 rows where live and fixed supply pick different tiers, live supply was right on 100% and fixed on 0%.
- The run took 9 s.
