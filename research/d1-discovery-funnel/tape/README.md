# D1 scoring code (tape)

This code implements `../PREREG.md` (D1, a discovery funnel) on the shared on-chain tape (`research/shared-tape/README.md`). It needs Python 3 with pandas, numpy and scipy. Where the PREREG is silent, the reading the code uses is listed in `OPEN_QUESTIONS.md`.

## Entry point
`run_d1.py`. Run every data command with `nice -n 19`. Each stage is a separate process.

```
U=$(ls -d /home/user/tape-cache/2026-09-1[01]/*-*)        # the unit directories, or use --units-file
nice -n 19 python3 run_d1.py stage1 --units $U --days 2026-09-10 2026-09-11 --out RUN   # points + features
nice -n 19 python3 run_d1.py stage2 --out RUN          # outcomes; reads exactly stage 1's units and re-checks their sha256
nice -n 19 python3 run_d1.py summary --run RUN                                          # counts and shapes only
nice -n 19 python3 run_d1.py summary --run RUN                  # + H8 count row
nice -n 19 python3 run_d1.py search  --run RUN --out RUN/frozen_rules.json   # PREREG §5
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
- **Step A plan.**
  - stage1 refuses a Step A plan whose sha256 is not `config.STEPA_PLAN_SHA256`.
  - stage1 records in the manifest whether the units equal the plan rows day by day, with no gaps (`stepa.plan_check`).
  - `search` refuses unless that check says complete.
- **Input hashes.**
  - `--no-hash` is refused on non-dev runs.
  - stage2 refuses when the unit files differ from stage 1's hashes.
  - `search` and `validate` refuse when hashes are skipped, when the two stages read different units, or when either stage ran on other code.
  - `validate` also refuses frozen rules made by other code.
- **H8 stratum.** `--solusd` defaults to `research/brainstorm-loop/sol-usd`. Each needed day is checked against `SHA256SUMS`, and a missing day or a mismatch is refused. `validate` refuses frozen rules made before the H8 amendment (`run_d1.FROZEN_AMENDMENTS`).
- `search` refuses dev runs and any day that is not a discovery day.
- `search` and `validate` refuse while a frozen ruling in `run_d1.REQUIRED_RULINGS` is missing from `FROZEN_AMENDMENTS`: both are now implemented, so the guard (red team R2-9) is satisfied.
- `validate` refuses unless `--confirm-validation-read` is passed, and refuses when its days overlap the discovery days.
- `validate` refuses unless the run read exactly the Step B days and every unit of the registered Step B plan (`config.STEPB_PLAN_SHA256`), with no gap (red team R2-1).
- `--dev-unknown-migration` exists only for shape checks on the few units cached now. It gives pools that migrated before the tape a pseudo migration. Its runs are marked `dev` and can never be searched or validated.

## Blindness
- **Stage 1 sees only the past.** It reads only rows at or before each decision slot.
- **Outcomes are separate.** They are computed in stage 2, a separate module and process that the feature code never imports (test `test_feature_code_never_imports_outcomes`).
- **Future-marker test.** `test_planted_future_marker` plants extreme rows of every table one slot after a decision and requires every earlier decision's features to be unchanged. The test was mutation-checked: a one-slot leak in features, clusters or holders makes it fail.

## Tests
`cd tape && python3 -m unittest -v` runs 64 tests on synthetic tables (plus one real PumpSwap sell row as a fixture). They cover:
- costs;
- pool state;
- universe and timing;
- features, hand-computed;
- the future marker;
- clusters and the fast class;
- cost basis;
- outcomes;
- the search (planted rule found, "nothing found", fold gap, edges from training only, throttle);
- validation verdicts;
- the amendments (rent by date band, binary and degenerate features, cost screen, H8 stratum and count row, AMENDMENT_3 ranking, H8_AMENDMENT_2 universe floors and bot gates);
- BOOST flagging;
- the guards (dev runs, partial days, overlapping days, plan sha, incomplete plan, input hashes, code sha).

Every review and amendment fix was mutation-checked: undoing it makes a test fail.

## Mapping: registered item → function
| PREREG item | Function |
|---|---|
| §2 days, holdouts, windows dropped by time | `config.DISCOVERY_DAYS`, `config.WALL_EPOCH`, `load.load` (wall guard), `universe.decision_points` (`valid_15`, `valid_60`) |
| §3 universe: canonical, non-mayhem, SOL, H10 to 24 h, effective quote ≥ 50, vault ≥ 30 | `universe.migrations`, `universe.decision_points`, `pool_state.PoolBook` |
| §3 decision points every 5 min, as of the decision slot | `universe.decision_points`, `universe.Clock.decision_slot` |
| §3 $50 buy at d + 23, 15/60-min holds, costs as edge-costs.ts; rent by account size and date (AMENDMENT_1 item 11, AMENDMENT_2) | `outcomes.compute_outcomes`, `costs.buy_exact_quote_in`, `costs.sell`, `costs.expected_fixed`, `costs.rent_for`, `costs.fixed_for` |
| §3 one entry per pool per hour | `search.throttle` |
| §4 price path (5) | `features.price_flow_pool_protocol` |
| §4 flow (9) | `features.price_flow_pool_protocol`, `features._first_buy_flags` |
| §4 who: fast class, creator cluster | `clusters.who_shares`, `clusters.ClusterState`, `clusters.link_pairs`, `near_event_flags`, `follow_pairs` |
| §4 who: app-routed, failed buys | `features.price_flow_pool_protocol` |
| §4 holders: top-10, creator, CGO, coverage | `holders.holder_features`, `holders.Holders` |
| §4 protocol (BOOST, market cap / 420, CF), pool (3) | `features.price_flow_pool_protocol` |
| §5 folds and 60-min gaps | `search.fold_masks` |
| §5 1,568 rules per hold, quintiles from training folds; binary and degenerate features (AMENDMENT_1 item 23) | `search.all_rules`, `search.edges_of`, `search.side_mask` |
| §5 score, ≥ 30 trades a fold, net mean > 0 in every fold (AMENDMENT_1 item 24), advance ≤ 5, frozen edges | `search.run_search` |
| Step A complete and inputs pinned (review fixes) | `stepa.plan_check`, `run_d1.search_guard`, `run_d1.validate_guard`, `run_d1.stage2` |
| AMENDMENT_3: rank rules whose $5 H8-tradable subset holds in every fold first | `search.run_search` (`h8_first`, `h8_s5_*_f<j>`) |
| H8_AMENDMENT_2: universe tag and floor, dust, H6, H9, H11, H12, H13, H17 as of d; tradable at $5 only; count row sizes to $10,000 and creator-fee-0 pools | `gates.universe_tag`, `gates.floor_for`, `gates.gate_frame`, `holders.gate_h12`, `holders.gate_h13`, `holders.insider_sets`, `h8.add_h8`, `h8.h8_counts`, `h8.pool_days`, `validate.h8_report` |
| AMENDMENT_4/5: H13 by a tape proxy (creation slot .. +2 by curve user, W/T links to the dev as of d, hub cap 50), results labelled "H8-tradable by tape proxy for H13"; universe-exit secondary dropped | `holders.h13_proxy_sets`, `holders.LinkIndex`, `config.H13_PROXY_LABEL` (search table, frozen rules, count row, `validate.h8_report`) |
| H8_AMENDMENT: H8-eligible stratum at $5/$20/$50 (search table, validation), "tradable as the bot stands", count row | `h8.add_h8`, `h8.price_asof`, `h8.h8_counts`, `search.run_search` (`h8_s*` columns), `validate.h8_report`, `outcomes._sized` |
| BOOST and protocol swaps flagged and left out of flow (OPEN_QUESTIONS #21) | `load.load` (`boost`, `protocol`, `signature`), `pool_state.flow_rows` |
| §6 99.5% pool-clustered bootstrap by day, ≥ 300 trades, positive each day, lift, verdicts | `validate.judge`, `validate.cluster_bootstrap`, `validate.rule_trades` |
| §7 as-of with a future marker, fold gaps, training-only edges, code and input hashes | tests `test_planted_future_marker`, `test_fold_gap`, `test_edges_from_training_only`; `run_d1.code_hash`, `load.file_hashes` |
