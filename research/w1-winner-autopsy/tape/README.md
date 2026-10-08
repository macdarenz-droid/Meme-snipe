# W1 tape scoring code

This code implements the frozen design in `../PREREG.md` and `../AMENDMENT_1.md` on the shared tape (`research/shared-tape/README.md`). `OPEN_QUESTIONS.md` lists every reading the design leaves open and the one the code takes.

It is Python 3 and uses pandas, numpy, scipy and zstandard.

## Entry point
Run everything from this directory:

```
cd research/w1-winner-autopsy/tape
python3 -m w1.run <stage> --work WORK [options]
```

| Stage | Inputs | Output | Reads P&L? |
|---|---|---|---|
| `ledger` | `--units U ...` (unit dirs `<cache>/<day>/<from>-<to>/research`) or `--cache C --days D ...` | `WORK/ledger-<day>.pkl` per day, `WORK/vocab.pkl`, `WORK/manifest.json` (units, sha256 of every input file and of the code, seed, per-day counts, exclusions by type, cost sources, gaps) | no |
| `counts` | `WORK` | JSON on stdout: cluster sizes, positions (counted or left out), traders by class, slow traders with 20+ positions, class stability | no (development check) |
| `gate` | `--days 2026-09-10 2026-09-11 --score` | §6 gate W1-0: P&L share by class and by size band, the kill verdict, the hub-threshold effect | yes |
| `discovery` | `--rank 2026-09-10 --test 2026-09-11 --score` | §7 discovery: lift, one-sided 95% upper bound, futility stop, decile report | yes |
| `validation` | `--rank 2026-09-07 --test 2026-09-08 2026-09-09 --score` (needs the test days' units in `--cache`) | §7 validation verdict (99.5% bound, top-decile mean, replay mean); `WORK/validation.pkl` | yes |
| `extract` | `--rank 2026-09-07 --days 2026-09-07 … 2026-09-11 --score`, after a validation pass | §8 rule (`WORK/rule.json`): tree, leaf path, hold | yes |
| `ruletest` | `--rule WORK/rule.json --days <untouched days> --score` | §8 rule-test verdict | yes |

Notes on running the stages:
- `ledger` needs every unit of a day, in one run, in slot order. Days run in calendar order. A position carries from one day to the next only across contiguous slots; a gap makes carried positions unknown.
- Steps keep their own work directories: Step A is 09-10 and 09-11, and Step B is 09-07 to 09-09.
- Every stage marked "yes" refuses to run without `--score`. The primary is scored only after Step A is complete and a reviewer has passed this code.
- Summaries contain no address. Internal ids index `vocab.pkl`, which stays in WORK (`w1.addr.short_hash` gives the committed form).
- Run every data command under `nice -n 19`.

Measured on the 4-core machine at nice 19:
- About 35 s and about 1 GB per v2 unit (4,500 slots). A whole day of about 48 units takes about 25–30 min. Day memory rises with the open positions carried; it was not measured past 2 units.

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
| §7 replay at 23 slots, $50 (0.4193 SOL), fees, impact, fixed costs of edge-costs.ts | `replay.replay_trades`, `replay.replay_mean`, `costs.FIXED_ROUND_TRIP` (checked against `research/edge/costs.json`) |
| §8 winners, labelled entries, matched sample (5 per entry, same 10-minute window) | `run.cmd_extract`, `rules.matched_sample` |
| §8 features as of the entry slot | `rules.MintTape.features`, `rules.MintTape.sweep_holders`, `rules.entry_features` |
| §8 tree (depth ≤ 3, leaf ≥ 5%, deterministic), best leaf, median hold | `rules.fit_tree`, `rules.best_leaf`, `rules.extract` |
| §8 rule test (D = 23 slots, $50, hold, control, 99.5% bound, ≥ 300 trades, each day positive, lift over control) | `rules.rule_fires`, `rules.control_entries`, `rules.rule_test_trades`, `rules.rule_test_verdict`, `run.cmd_ruletest` |
| §9.1 as-of only, planted future marker | `tests/test_leak.py` |
| §9.2 accounting fixtures (router, cluster transfers, closing sells, curve through migration) | `tests/test_ledger.py` |
| §9.3 excluded addresses by type, hub effect | `manifest.json` `excluded_by_type`, `clusters.hub_effect` (in `gate`) |
| §9.4 code, seeds and input hashes | `manifest.json` (`code`, `inputs`, `seed`, `bootstrap`) |
| §10 only truncated SHA-256 of addresses in summaries | `addr.short_hash`; summaries carry counts only |

## Blind rule
- Features are computed only from data up to each decision. Clusters use links on or before the ranking day. Classes use the day's own buys. The ranking reads the ranking day alone, and §8 features use only events with a key below the entry.
- Outcomes are computed in separate functions that the feature code never calls: `persist.test_day_returns`, `replay.*`, and `rules.rule_test_trades`.
- `tests/test_leak.py` plants a future-only marker. It checks that ranking-day clusters, classes and the ranking, and the §8 features, do not change when the marker is present.
