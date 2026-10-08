# Design A on the shared tape

Scoring code for Design A (the 420 SOL creator-fee step), as frozen in `research/EDGE_DIALOGUE.md` ("## Agreed designs", Design A) with `research/brainstorm-loop/A_AMENDMENTS_ROUND7.md`. Readings where the design is silent are in `OPEN_QUESTIONS.md`.

## Entry point
`run_a.py`. Python 3 with pandas, numpy and zstandard. Run every data command with `nice -n 19`.

```
# check mode: counts and shapes only, no gate statistic
nice -n 19 python3 run_a.py --days 2026-09-10 2026-09-11 --steps A --cache /home/user/tape-cache --out OUT
nice -n 19 python3 run_a.py --days 2026-09-11 --units /home/user/tape-cache/2026-09-11/446265000-446269499 ... --out OUT

# scoring: only after Step A is complete and a reviewer has passed this code
nice -n 19 python3 run_a.py ... --score-primary --confirm REVIEW-PASSED-AND-STEP-A-COMPLETE
```

**Inputs**
- Unit directories (`<day>/<from>-<to>` or its `research/`), or `--cache` with `--days`. The tables read are `B`, `E` (migration, CreatePool, BOOST events) and `S_amm`. These columns exist in schema v1 and v2.
- `--days`: every unit must be from one of them. A day on or after 2026-09-12, or any row at or after 2026-09-12T00:00Z, raises `WallError`.
- `--steps`: the tape steps the days complete (A, B, C), used by the count rule.
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
| Which supply the tier rule uses (amendment a): live `base_supply`, checked against charged creator fees | `features.supply_rule_tally`, `run_a.summary` (`supply_rule_check`); scoring refuses below 99% |
| Pools: canonical PumpSwap SOL pools of pump.fun graduates, not mayhem | `features.pool_table`, swap checks in `run_a.build` |
| Hours 0–72 after migration | `features.pool_table` (`hi`), `features.clip_to_window`, `features.in_window` |
| BOOST window excluded: migration to the end of the last `BoostBuyAndBurnEvent`, else first 5 minutes (amendment b) | `features.pool_table` (`lo`), `features.clip_to_window`, `features.in_window` |
| Each swap's market cap holds until the next swap or hour 72 | `features.timeline`, `features.clip_to_window` |
| Count rule: 200 pools trading within ±5% of 420; else Step B, then Step C; else unresolved (amendment c: unchanged) | `features.count_rule_pools`, `gates.count_rule` |
| 20 placebo cutoffs on a log grid 340–1,300, > 10% from 420 and 1,470 | `features.placebo_grid`, `features.cutoffs` |
| Gate 2: log(time in [c, 1.05c) ÷ time in [0.95c, c)) at 420 minus the placebo median | `features.band_seconds`, `gates.gate2_stat` |
| Gate 3: coin_creator (signer or token owner) net SOL bought per hour in [399, 441) minus the placebo median | `features.creator_net`, `features.band_seconds`, `gates.gate3_stat` |
| Pool-clustered bootstrap; both gates need a 95% lower bound > 0, else A closes and no return is read | `gates.pool_bootstrap`, `gates.score_gates` |
| Return test entry: first cross of 420 from below, stop under 399, placebo crosses as control | `features.cross_events` (causal); outcome stage `outcomes.score_return_test` is not implemented (not frozen) |
| No row from 2026-09-12 | `load.check_day`, `load._guard_times`, `load.select_units` |

## Look-ahead
- Gates read no returns.
- `features.py` and `gates.py` never import `outcomes.py`, and a test checks this.
- Cross events use only the crossing row. A test plants a future-only marker and checks that every event up to that time is unchanged.

## Tests
`cd research/edge-a/tape && python3 -m unittest`. There are 21 tests on synthetic units: band seconds, the BOOST window, exclusions, the count rule, gaps, the 72-hour clip, the wall, look-ahead, gate values, the bootstrap and the CLI guard. Mutation checks were run on band width, the 5-minute window, the window edge, the interval value, placebo handling, the BOOST end and the creator match. Each mutation fails a test.

## Development run (2 units, counts only)
Units 2026-09-11 446265000–446273999, both v2, about 1 hour of tape:
- 52 pools migrated and 29 were eligible. Excluded: 17 mayhem, 4 with no known BOOST end, 2 with a non-SOL quote.
- 6 pools met the count rule, so the status is "short", which is expected on 1 hour of tape.
- The supply-rule check agreed on 100% of 527,943 rows.
- The run took 9 s.
