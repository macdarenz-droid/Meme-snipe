# H1-CGO scoring on the shared tape

This code scores the frozen design in `../PREREG.md` on the shared on-chain tape (`research/shared-tape/README.md`). Where the prereg is silent, the reading used is in `OPEN_QUESTIONS.md`; `../AMENDMENT_1.md` confirms those readings, `../AMENDMENT_2.md` sets the rent by date, and `../AMENDMENT_3.md` adds the D60 arm and the H8 stratum (`research/brainstorm-loop/H8_AMENDMENT.md`); `../AMENDMENT_4.md` adds H8's dust check and the committed SOL/USD input. Python 3 with pandas, numpy and zstandard. No network, no git.

## Entry point
`run.py`, one stage per call. Each stage reads the files the previous stage wrote to `--out`. Run every data command with `nice -n 19`. A unit is `/home/user/tape-cache/<day>/<from>-<to>` (the `research/` subfolder is optional).

| Stage | Inputs | Outputs | Reads forward prices |
|---|---|---|---|
| `features --units U… --decision-days D… [--creation-days D…]` | tape units (E, B, T_coverage, S_curve, S_amm, T) | `features.csv`: one row per decision point, with the as-of features, eligibility and time schedule. `universe.csv`. `features_meta.json`: counts, contiguous intervals, sha256 of every input and source file. | no |
| `gate0 [--sol-usd DIR]` | `features.csv`, the committed SOL/USD folder (default `research/brainstorm-loop/sol-usd/`, checked against its SHA256SUMS) | `gate0.json`: §5 (a), (b), (c), the verdict, and the H8 count row. Discovery days only. | no |
| `outcomes --units U… [--counts-only]` | `features.csv` and the pools' S_amm rows | `outcomes.csv`: per eligible, in-time point and per (hold, size), the price, fees, impact, fixed costs, gross, net and status. `flows.csv`: next-hour sells and net SOL flow, for the D60 gate. | yes (separate stage) |
| `freeze` | gate0 passed, `features.csv`, `outcomes.csv`, `flows.csv` | `frozen.json`: §6 breakpoints, §7 sign, lifts, futility and verdict; the D60 gate rows and D60's P20; hashes. Discovery days only. | yes |
| `score --frozen FROZEN [--sol-usd DIR]` | a validation `--out` dir, the committed `frozen.json`, the committed SOL/USD folder (checked against its SHA256SUMS) | `primary.json` (§8, plus `h8_stratum` and `d60_arm`) and `secondary.json` (§10). Validation days only; refuses if discovery closed H1-CGO. | yes |

The order:
1. Discovery: `features` (decision days 2026-09-10 and 2026-09-11), then `gate0`, `outcomes`, `freeze`.
2. Commit `frozen.json`, the code and the hashes (§9.4).
3. Validation: `features` (decision days 2026-09-07 to 2026-09-09), then `outcomes`, then `score`.

The code refuses any unit dated 2026-09-12 or later, and any run that mixes discovery and validation days.

**Completeness (Step A guard).** `features` loads the committed unit plan (`--plan`, default `research/shared-tape/stepa-plan.txt`, one `DAY EPOCH FROM TO` line per unit). For every day used (decision and creation days), it requires exactly that day's planned units, contiguous from the day's first FROM to its last TO, each with its tables on disk. It refuses units from any other day. `gate0`, `outcomes`, `freeze` and `score` repeat the check from `features_meta.json` (unit records, plan sha256).
- `outcomes` also requires the same units, with the same sha256, as `features`, and `Book` refuses any slot outside the loaded range.
- `score` requires the decision days to be exactly 2026-09-07, 09-08 and 09-09, and the code hash to equal `frozen.json`'s.
- `gate0` stops with a message when there are no decision points.

Example (development, counts only):
```
nice -n 19 python3 run.py features --units /home/user/tape-cache/2026-09-11/446274000-446278499 \
  /home/user/tape-cache/2026-09-11/446278500-446282999 --decision-days 2026-09-11 --out /tmp/h1   # now refused: 09-11 is incomplete (Step A guard)
```

Tests: `cd research/h1-cgo/tape && python3 -m unittest` runs 100 tests on synthetic tables, the repo's mainnet golden quotes and `research/edge/costs.json`.

## Look-ahead
- `h1cgo/features.py` builds one stream per coin. `MintStream.advance(d)` applies exactly the rows with slot ≤ d, and every feature reads only what has been applied:
  - holdings;
  - pool state;
  - past mids;
  - unresolved marks;
  - protocol owners;
  - the canonical-pool check.
- The decision schedule needs only the migration time and block times.
- `features.py` never imports `outcomes.py` or `stats.py`; a test checks this.
- Tests (§9.1):
  - the features at every decision point equal the features computed on the tape cut at that decision slot;
  - a planted future marker one slot after a decision changes nothing at or before it, and is seen at the next decision. The marker is a huge buy, a movement and an `unresolved` mark.
- Drop by time (§2) comes from block times alone (`schedule_windows`), before any price is read.

## Registered item → code
| Prereg | Implemented by |
|---|---|
| §2 days, wall, drop by time | `constants.DISCOVERY_DAYS/VALIDATION_DAYS/WALL_DAY`, `tapeio.parse_unit`, `features.schedule_windows` (`in_time_<hold>`), `run.py` day checks |
| §3 universe (C row on a tape day, canonical SOL pool, not mayhem or cashback) | `features.build_universe`, plus the canonical/WSOL check in `MintStream.advance` (`bad_pool`) |
| §3 decision points (whole UTC hours, migration + 60 min to + 24 h) | `features.decision_points`, `Clock.last_before` |
| §3 eligibility (effective quote ≥ 50 SOL, vault ≥ 30 SOL) | `features.compute_features` (`ok_liquidity`), `pumpswap.amm_post_state` |
| §3 one entry per mint per UTC day | `stats.first_per_mint_day`, `stats.entries` |
| §4 average cost (buy, sell, transfer, unknown) | `ledger.Ledger`; tape rows to ledger: `features.build_streams`, `MintStream._apply` |
| §4 excluded holders, including BOOST burns | `MintStream.excluded` (bonding curve, pool, burn, protocol), `constants.BURN_OWNERS/PROTOCOL_OWNERS`, `features.boost_keys` (v3 `protocol` flag or a BoostBuyAndBurnEvent match) |
| §4 coverage ≥ 90%, RP, P, CGO | `MintStream.snapshot`, `compute_features` (`ok_coverage`, `eligible`) |
| §5 gate (a), (b), (c) | `stats.gate0`, `stats.r2` |
| §6 breakpoints P20 and P80 | `stats.breakpoints` |
| §6 entry ($50, D = 23, worse of slot start and end, fee tier) and exit (60 min + D) | `outcomes.price_trade`, `outcomes.Book.start/end`, `pumpswap.buy_exact_quote_in/sell/pool_fees` |
| §6 costs (fees and impact on both legs, fixed costs as edge-costs; rent per AMENDMENT_2, at the entry slot) | `pumpswap.expected_fixed(rent)`, `pumpswap.token_account_rent`, `outcomes.run`, `outcomes.price_trade` |
| §7 lift, sign, futility | `stats.sign_and_futility` |
| §8 primary, bootstrap (10,000, fixed seed, 99.5% and 95%), pass conditions, verdicts | `stats.primary`, `stats.cluster_bootstrap`, `stats.interval` |
| §9.1 as-of test with a planted future marker | `tests/test_features.py` (`AsOf`) |
| §9.2 cost-basis fixtures | `tests/test_ledger.py` |
| §9.3 coverage counts, excluded accounts by type | `features.csv` columns `coverage`, `known_tokens`, `unknown_tokens`, `excl_curve/pool/burn/protocol`, `owner_checks`, `owner_mismatch`, `overdraw_events`; universe counts in `features_meta.json` |
| §9.4 code, seed and input hashes | `tapeio.code_hash`, `tapeio.input_hashes`, `constants.BOOT_SEED`; written to `features_meta.json` and `frozen.json` |
| §10 secondary (holds 15 min and 4 h, quintiles, sizes, post-migration CGO) | `outcomes.run` plan, `stats.secondary`, `MintStream.snapshot` (`cgo_post`) |
| A3: D60 (habits, due supply, traceable float, controls) | `habits.events_from/round_trips/Habits/d60`, `MintStream.snapshot` (`d60`, `vol_1h`, `volume_1h`) |
| A3: D60 gate rows (Step A) and the arm | `outcomes.flows`, `stats.d60_gate`, `stats.d60_arm`, `stats.spearman/partial_spearman/cluster_bootstrap_stat` |
| H8_AMENDMENT 1–4, H8_AMENDMENT_2 and AMENDMENT_4: H8 stratum with the dust check, tradable flag, count row, committed SOL/USD | `h8.SolUsd/eligible/flags/count_rows/load_committed`, `stats.h8_stratum`, `features.build_universe` (`quote_at_migration`) |
| H8_AMENDMENT_2: universe tag by age, H6, H11, $5-only tradable, count sizes to $10,000, creator-fee-0 pools | `h8.universe_tag/floor_micro_usd/tradable`, `MintStream._candle/h11`, `features.lp_events_of`, `stats.h8_stratum`; tests in `tests/test_h8_amendment2.py` |
| Tests for the amendments | `tests/test_amendment3.py`, `tests/test_cli.py` |

## Checks on real data (2 units of 2026-09-11, counts only)
- Universe: 1,061 created; 21 kept; 414 mayhem, 98 cashback, 74 not SOL, 454 not migrated in the units.
- Decision points: 0, because 2 units cover about an hour and the first decision is at migration + 60 min.
- Pool-state chain: 0 mismatches in 50,224 consecutive trade pairs.
- Fee tiers: 49,673 of 49,673 matched.
- Holder ledger: coverage 1.0 on all 21 coins; 79 owner-balance mismatches in 47,201 checks.
- Run time: about 14 s for the 2 units.
- No return, lift, test statistic or interval was computed or printed on real data.
