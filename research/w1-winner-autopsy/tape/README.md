# W1 tape scoring code

This code implements the frozen design in `../PREREG.md` and `../AMENDMENT_1.md` to `../AMENDMENT_7.md` on the shared tape (`research/shared-tape/README.md`). `OPEN_QUESTIONS.md` lists every reading the design leaves open and the one the code takes.

It is Python 3 and uses pandas, numpy, scipy and zstandard.

## Entry point
Run everything from this directory:

```
cd research/w1-winner-autopsy/tape
python3 -m w1.run <stage> --work WORK [options]
```

| Stage | Inputs | Output | Reads P&L? |
|---|---|---|---|
| `ledger` | `--units U ...` or `--cache C --days D ...` (unit dirs `<cache>/<day>/<from>-<to>/research`) | `WORK/ledger-<day>.pkl` per day, `WORK/vocab.pkl`, `WORK/manifest.json` (unit paths, sha256 of every input file, of each ledger day and of the code; seed; per-day counts; exclusions by type over all days; cost and signer-method counts) | no |
| `counts` | `WORK` | JSON: cluster sizes, positions counted or left out, traders by class, slow traders with 20+ positions | no (development check) |
| `gate` | `--score` | §6 gate W1-0 on 09-10 and 09-11: P&L by class and size band, P&L shares by cash method, kill / "untestable on the tape's first day", hub effect | yes |
| `flippers` | `--score` | AMENDMENT_4 rows on 09-10 and 09-11 | no P&L; guarded |
| `discovery` | `--score` | §7: rank 09-10, test 09-11; lift, one-sided 95% bound, futility; top-decile mean under both cash methods | yes |
| `validation` | `--score` | §7: rank 09-07, test 09-08 and 09-09; 99.5% bound, top-decile mean, replay mean and shares; `WORK/validation.pkl` (hash recorded) | yes |
| `extract` | `--score` (ledger of 09-07..09-11, validation passed in the same WORK) | §8 `WORK/rule.json` (hash recorded) | yes |
| `ruletest` | `--rule-work AB_WORK --score` (WORK = ledger of 09-02..09-06) | §8 rule-test verdict | yes |

Rules for the stages:
- The days and the rank/test choices of every scored stage are registered in `guard.ROLES`. `--rank`, `--test` and `--days` may be omitted; any other value is refused. `ruletest` reads Step C only.
- Every scored stage first calls `guard.verify`. It checks:
  - the frozen unit plan and its sha256 (Step A: `research/shared-tape/stepa-plan.txt`, fa99c878…);
  - that each day's units equal the plan's rows exactly, with no gap;
  - that there is no development flag;
  - that the code hashes equal the current code;
  - the hashes of the ledger day files and of every input;
  - that every day of the stage is present;
  - for `extract`, the hash of validation.pkl; for `ruletest`, the hash of rule.json.
- Steps B and C run only from `research/shared-tape/stepb-plan.txt` and `stepc-plan.txt`, checked against their committed `.sha256` files.
- Until a registered gate releases Step B (`guard.STEP_B_RELEASED`), only discovery runs, and `validation`, `extract` and `ruletest` refuse (OPEN_QUESTIONS Q36).
- `ledger` refuses gaps and units that differ from a frozen plan. `--dev-allow-gaps` exists for development, and every scored stage refuses its output.
- The replay and the rule test read the ledger's own units, never the cache.
- The primary is scored only after Step A is complete and a reviewer has passed this code.
- Summaries name no address.
- Run under `nice -n 19`.

Measured on the 4-core machine at nice 19:
- About 50–65 s and about 1 GB per v2 unit (4,500 slots), so the 62 units of 09-11 take about 1 h. Day memory rises with the open positions carried; it was not measured past 2 units.

Tests (synthetic tables only):
```
python3 -m unittest discover -s tests
```

## Registered item → implementation
| Design item | Function |
|---|---|
| §2 days and windows; no row from 2026-09-12 | `load.parse_units` (refuses days outside 09-02..09-11), `load.read_table` (drops block_time ≥ 2026-09-12) |
| §2 tables S, T, W, C, G | `load.swaps`, `load.movements`, `load.sol_transfers`, `load.events`, `load.coverage` |
| §3 excluded owners (off-curve, pools, curves, BOOST, mayhem vault, buyback authority) | `ledger.Ledger._excluded`, `addr.on_curve`; listed by type in `manifest.json` / day `excluded` |
| §3 clusters (union-find over W and pump-mint T, as of the ranking day, hubs over 50 owners) | `clusters.build`; size distribution in its `info`; W absent is recorded as a limitation |
| §3 / §9.3 hub threshold effect | `clusters.hub_effect` |
| §4 cash flow, fees, tx_fee + jito_tip split over the transaction's swaps | `load.swaps` (cash), `Ledger.process_unit` (cost split) |
| AMENDMENT_1 fallback cost and its fixture | `costs.amendment_tx_cost`, `tests/test_units.py::Costs` |
| §4 end mark (PumpSwap effective reserves, fee, impact, real-vault cap; curve reserves and fee) | `venue.curve_sell`, `venue.pool_sell`, `venue.sell_vec`, `ledger.choose_state`, `Ledger.finish_day` |
| §4 day P&L = cash + end mark − start mark; positions from before the first day left out; transfers at mark | `Ledger._apply`, `Ledger._movements`, `Ledger.finish_day`, `positions.trader_positions` |
| §4 per-trade return | `positions.trader_positions` (`ret`), `positions.per_trader` |
| §5 latency class (10% near C/G, 30% after another trader's ≥1 SOL buy) | `classes.near_create_or_migration`, `classes.follows_big_buy`, `classes.classify` |
| §5 reported only: Jito-tip share, median lag | `classes.classify` (`jito_share`, `median_lag`) |
| §5 class stability day to day | `classes.stability` |
| §6 gate W1-0: class share of P&L, P&L by size band, kill below 200 slow traders with 20+ positions | `persist.gate`, `persist.gate_verdict` |
| §7 ranking: slow, 20+ positions, t-statistic, deciles | `persist.rank` |
| §7 test day: 5+ positions, traders still trading per decile | `persist.test_day_returns` |
| §7 statistic and bootstrap by trader within group (10,000, fixed seed) | `persist.groups`, `persist.lift`, `persist.bootstrap` |
| §7 discovery futility stop | `persist.discovery_verdict` |
| §7 validation (99.5% lower bound, top-decile mean > 0, replay > 0) | `persist.validation_verdict` |
| §7 replay at 23 slots, $50 (0.4193 SOL), fees, impact, fixed costs of edge-costs.ts | `replay.replay_trades`, `replay.replay_mean`, `costs.fixed_round_trip` (edge-costs fixed costs with rent by date, red team R2-12; `costs.FIXED_ROUND_TRIP` is checked against `research/edge/costs.json`) |
| §8 winners, labelled entries, matched sample (5 per entry, same 10-minute window) | `run.cmd_extract`, `rules.matched_sample` |
| §8 features as of the entry slot | `rules.MintTape.features`, `rules.MintTape.sweep_holders`, `rules.entry_features` |
| §8 tree (depth ≤ 3, leaf ≥ 5%, deterministic), best leaf, median hold | `rules.fit_tree`, `rules.best_leaf`, `rules.extract` |
| §8 rule test (D = 23 slots, $50, hold, control, 99.5% bound, ≥ 300 trades, each day positive, lift over control) | `rules.rule_fires`, `rules.control_entries`, `rules.rule_test_trades`, `rules.rule_test_verdict`, `run.cmd_ruletest` |
| AMENDMENT_2 Q2 signer SOL change, both methods reported | `costs.signer_cash`, `Ledger._signer_method`, `positions.trader_positions` (`*_alt`), `persist.method_shares`, `persist.top_decile_means` |
| AMENDMENT_2 Q22 balances per token account | `Ledger._apply` (account-level tracking) |
| AMENDMENT_2 Q14 first-day shortfall | `Ledger.finish_day` (`dirty_start_only`, `first_day`), `persist.gate_verdict` |
| AMENDMENT_2 Q20 pool-clustered, day-stratified bootstrap | `rules.pool_bootstrap`, `rules.rule_test_verdict` |
| AMENDMENT_3 Q29 cost on included rows only | `Ledger.process_unit` |
| AMENDMENT_3 Q17 winners | `persist.winners` |
| AMENDMENT_3 replay outcomes (unpaid exit −100%, no state dropped, shares) | `replay.replay_trades`, `replay.shares`, `venue.sell_detail`, `rules.replay_entry` |
| AMENDMENT_5 refused entry = no trade (share, 10% flag); rents by date; Step B/C plans and release gate; no-cap report | `replay.replay_trades`, `replay.shares`, `rules.replay_entry`, `costs.rent_candidates`, `guard.plan_units`, `guard.verify`, `positions` (`ret_nc`), `persist.top_decile_means` |
| AMENDMENT_6 top-decile mean above 0 under capped and uncapped methods | `persist.validation_verdict` (`top_mean_uncapped`), `run._persistence` |
| AMENDMENT_7 seat-cost tag (median tx_fee + tip per trade, median within-slot buy rank) | `Ledger.process_unit` (`fees`, `slot_rank`), `classes.seat_tag`, `classes.seat_summary`, `rules.SEAT_REFERENCE`, `run.cmd_gate`, `run.cmd_extract` |
| AMENDMENT_4 flipper rows | `Ledger._trips`, `flippers.*`, `run.cmd_flippers` |
| Review: guards, registered days, BOOST by transaction, missing days | `guard.verify`, `guard.check_args`, `guard.ledger_units`, `load.find_units`, `Ledger.process_unit` |
| §9.1 as-of only, planted future marker | `tests/test_leak.py` |
| §9.2 accounting fixtures (router, cluster transfers, closing sells, curve through migration) | `tests/test_ledger.py` |
| §9.3 excluded addresses by type, hub effect | `manifest.json` `excluded_by_type`, `clusters.hub_effect` (in `gate`) |
| §9.4 code, seeds and input hashes | `manifest.json` (`code`, `inputs`, `seed`, `bootstrap`) |
| §10 only truncated SHA-256 of addresses in summaries | `addr.short_hash`; summaries carry counts only |

## Blind rule
- Features are computed only from data up to each decision. Clusters use links on or before the ranking day. Classes use the day's own buys. The ranking reads the ranking day alone, and §8 features use only events with a key below the entry.
- Outcomes are computed in separate functions that the feature code never calls: `persist.test_day_returns`, `replay.*`, and `rules.rule_test_trades`.
- `tests/test_review.py` holds the tests for the amendments and the review items. Each one was checked to fail when its fix is reverted.
- `tests/test_leak.py` plants a future-only marker. It checks that ranking-day clusters, classes and the ranking, and the §8 features, do not change when the marker is present.
