# D1 scoring code (tape)

This code implements `../PREREG.md` (D1, a discovery funnel) on the shared on-chain tape (`research/shared-tape/README.md`). It needs Python 3 with pandas, numpy and scipy. Where the PREREG is silent, the reading the code uses is listed in `OPEN_QUESTIONS.md`.

## Entry point
`run_d1.py`. Run every data command with `nice -n 19`. Each stage is a separate process.

```
U=$(ls -d /home/user/tape-cache/2026-09-1[01]/*-*)        # the unit directories, or use --units-file
nice -n 19 python3 run_d1.py stage1 --units $U --days 2026-09-10 2026-09-11 --out RUN   # points + features
nice -n 19 python3 run_d1.py stage2 --units $U --days 2026-09-10 2026-09-11 --out RUN   # outcomes
nice -n 19 python3 run_d1.py summary --run RUN                                          # counts and shapes only
nice -n 19 python3 run_d1.py search  --run RUN --out RUN/frozen_rules.json              # PREREG §5
nice -n 19 python3 run_d1.py validate --run VALRUN --frozen frozen_rules.json --confirm-validation-read   # §6, later
```

**Inputs.** The inputs are a list of unit directories `<cache>/<day>/<from>-<to>`, each holding `research/*.csv.zst` and `E.jsonl.zst`, and the day(s) they belong to.
- The load fails on any row at or after 2026-09-12T00:00Z.
- Schema v1 units are accepted. Features they cannot supply are NaN (`top_program`, CF).

**Outputs** (in RUN):
- `points.pkl`: every decision point with its timing and eligibility.
- `features.pkl`: the 28 features of the eligible points.
- `outcomes.pkl`: fills, net return per hold and round-trip cost.
- `manifest_stage*.json`: units, coverage, counts, the code sha256 and the input sha256.
- `search_table.csv`: every rule's fold counts, fold means and score.
- `frozen_rules.json`: at most 5 rules with their full-discovery quintile edges, or "nothing found".
- `validation_result.json`: produced by `validate` only.

**Guards.**
- `search` refuses dev runs and any day that is not a discovery day.
- `validate` refuses unless `--confirm-validation-read` is passed, and refuses when its days overlap the discovery days.
- `--dev-unknown-migration` exists only for shape checks on the few units cached now. It gives pools that migrated before the tape a pseudo migration. Its runs are marked `dev` and can never be searched or validated.

## Blindness
- **Stage 1 sees only the past.** It reads only rows at or before each decision slot.
- **Outcomes are separate.** They are computed in stage 2, a separate module and process that the feature code never imports (test `test_feature_code_never_imports_outcomes`).
- **Future-marker test.** `test_planted_future_marker` plants extreme rows of every table one slot after a decision and requires every earlier decision's features to be unchanged. The test was mutation-checked: a one-slot leak in features, clusters or holders makes it fail.

## Tests
`cd tape && python3 -m unittest -v` runs 28 tests on synthetic tables (plus one real PumpSwap sell row as a fixture). They cover:
- costs;
- pool state;
- universe and timing;
- features, hand-computed;
- the future marker;
- clusters and the fast class;
- cost basis;
- outcomes;
- the search (planted rule found, "nothing found", fold gap, edges from training only, throttle);
- validation verdicts.

## Mapping: registered item → function
| PREREG item | Function |
|---|---|
| §2 days, holdouts, windows dropped by time | `config.DISCOVERY_DAYS`, `config.WALL_EPOCH`, `load.load` (wall guard), `universe.decision_points` (`valid_15`, `valid_60`) |
| §3 universe: canonical, non-mayhem, SOL, H10 to 24 h, effective quote ≥ 50, vault ≥ 30 | `universe.migrations`, `universe.decision_points`, `pool_state.PoolBook` |
| §3 decision points every 5 min, as of the decision slot | `universe.decision_points`, `universe.Clock.decision_slot` |
| §3 $50 buy at d + 23, 15/60-min holds, costs as edge-costs.ts | `outcomes.compute_outcomes`, `costs.buy_exact_quote_in`, `costs.sell`, `costs.expected_fixed` |
| §3 one entry per pool per hour | `search.throttle` |
| §4 price path (5) | `features.price_flow_pool_protocol` |
| §4 flow (9) | `features.price_flow_pool_protocol`, `features._first_buy_flags` |
| §4 who: fast class, creator cluster | `clusters.who_shares`, `clusters.ClusterState`, `clusters.link_pairs`, `near_event_flags`, `follow_pairs` |
| §4 who: app-routed, failed buys | `features.price_flow_pool_protocol` |
| §4 holders: top-10, creator, CGO, coverage | `holders.holder_features`, `holders.Holders` |
| §4 protocol (BOOST, market cap / 420, CF), pool (3) | `features.price_flow_pool_protocol` |
| §5 folds and 60-min gaps | `search.fold_masks` |
| §5 1,568 rules per hold, quintiles from training folds | `search.all_rules`, `search.edges_of`, `search.side_mask` |
| §5 score, ≥ 30 trades a fold, cost hurdle, same sign, advance ≤ 5, frozen edges | `search.run_search`, `search.median_rt_cost` |
| §6 99.5% pool-clustered bootstrap by day, ≥ 300 trades, positive each day, lift, verdicts | `validate.judge`, `validate.cluster_bootstrap`, `validate.rule_trades` |
| §7 as-of with a future marker, fold gaps, training-only edges, code and input hashes | tests `test_planted_future_marker`, `test_fold_gap`, `test_edges_from_training_only`; `run_d1.code_hash`, `load.file_hashes` |

## Development check (2 units of 2026-09-11, v2)
- **Strict run.** 39 migrations, 17 of them mayhem. There are 0 decision points, as expected: one hour of tape cannot reach migration + 60 min.
- **Dev run.** 6,772 eligible points on 2,505 pools. All 28 features are filled, except:
  - 60-minute and since-migration returns, which one hour cannot supply;
  - the "Who" shares, NaN where no buys fall in the window.
- **Outcomes.** 6,772 entries fill; 4,160 15-minute exits fit inside the tape.
- **Not computed.** No return statistic and nothing from the primary.
