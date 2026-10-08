# G1 scoring code (shared tape)

Code for the frozen design in `../PREREG.md`, `../AMENDMENT_1.md`, `../AMENDMENT_2.md`, `../AMENDMENT_3.md`, `../AMENDMENT_4.md`, `../AMENDMENT_5.md` and `../AMENDMENT_6.md`. It reads the shared tape (`research/shared-tape/README.md`) and nothing else. Where the design is silent, the most conservative reading is used and listed in `OPEN_QUESTIONS.md` (OQ-n in the code).

## Entry point

`g1.py` (Python 3; pandas, numpy, scipy, zstandard). Run every data command with `nice -n 19`.

| Command | Reads | Writes | Returns read? |
|---|---|---|---|
| `g1.py checks --units U... --out DIR` | tape | `checks.json` (§7 checks 2–5: reserves before/after, fee-tier market cap, 85.005 SOL target and migration fee, token programs, sha256 of every input table and code file, seeds) | no |
| `g1.py decide --units U... --out DIR [--no-links]` | tape, only as of each decision | `decisions.csv`, `decisions_summary.json`: universe, triggers (90%, 80%, 95%), S0, non-SOL strata, entry and exit-B slots, drop-by-time, features R and Z | no |
| `g1.py gate --units U... --out DIR --days D...` | tape, `decisions.csv` | `gate.json` (G1-0, descriptive BOOST rows, strata, G1-HC and G1-CAP gates), `graduates.csv`, `triggers.csv`, `flows.csv`, `boost_slices.csv` | no (timing, holdings, flows) |
| `g1.py freeze --out DIR` | `decisions.csv` (discovery) | `frozen.json`: discovery medians of R and Z | no |
| `g1.py outcome --units U... --out DIR --allow-returns [--counts-only]` | tape, `decisions.csv` | `trades.csv` (or, with `--counts-only`, `trades_counts.csv` and `outcome_counts.json` without any return column) | **yes** |
| `g1.py score --out DIR --role discovery\|validation --frozen FILE --allow-scoring` | `trades.csv`, `decisions.csv`, `frozen.json` | `score_<role>.json` | **yes** |

`U` is a unit directory (`/home/user/tape-cache/<day>/<from>-<to>` or its `research/` folder) or a cache root (`/home/user/tape-cache`, `/home/user/tape-cache/<day>`); `--days` keeps only those days. Units of v1 and v2 schema both load (G1 reads no v2-only column). Overlapping units are refused. Contiguous units form one covered run of slots; a decision needs its trigger and its whole window inside one run.

Example (discovery, Step A):
```
cd research/g1-boost-inventory/tape
nice -n 19 python3 g1.py checks --units /home/user/tape-cache --days 2026-09-10 2026-09-11 --out out/A
nice -n 19 python3 g1.py decide --units /home/user/tape-cache --days 2026-09-10 2026-09-11 --out out/A
nice -n 19 python3 g1.py gate   --units /home/user/tape-cache --days 2026-09-10 2026-09-11 --out out/A
nice -n 19 python3 g1.py freeze --out out/A
```

## Guards
- `find_units` refuses unless each day's units equal the rows of the frozen Step A plan (`research/shared-tape/stepa-plan.txt`, sha256 checked) with no gap. `--dev-subset` (development only) accepts part of a day; `freeze`, `score` and `outcome` with returns refuse a manifest made that way.
- `decide` writes `manifest.json` (plan sha, units, sha256 of every input table, code hash of `g1.py`, `g1lib/*.py` and `fixed_costs.*`, decisions sha). `gate`, `freeze`, `outcome` and `score` refuse unless their units, inputs, code and files match it. `freeze` copies the hashes into `frozen.json` and needs exactly 09-10 and 09-11. `score` refuses unless the code hash equals frozen.json's and the role's decisions and trades cover exactly its days (validation 09-07, 09-08, 09-09; discovery 09-10, 09-11), and the validation verdict needs all three days present with a mean above 0.

## Order of work
1. A reviewer passes this code. Until then only `checks`, `decide`, `gate` and `outcome --counts-only` run on real data, and no return is printed.
2. Step A complete (both discovery days, every unit): `checks`, `decide`, `gate`. If G1-0 kills, G1 closes with no return read; the amendment arms close on their own gate failures.
3. `freeze`; commit the code, `frozen.json`, the seeds (`params.py`) and `checks.json`'s hashes before any validation day is read (§7 check 5; amendment arms).
4. `outcome --allow-returns` and `score --role discovery` (§8 futility; the primary there is information only).
5. Only if Step B is released for G1: `decide`, `outcome`, `score --role validation` on 09-07, 09-08, 09-09, with `--frozen` from step 3.

Enforced in code (red team R2-6): `gate` records gate.json's sha in the manifest; `freeze` refuses without that gate.json from whole days and copies its passes into frozen.json; `score` refuses unless G1-0 passed; `score --role discovery` records score_discovery.json's sha; `score --role validation` refuses without that file beside `--frozen`, and an arm whose own gate failed or that discovery futility closed gets the verdict "closed: ..." (`score.closures`). G1-0 failing closes every arm (pending a ruling, see CODE_REDTEAM.md).

The gate's per-day counts assume whole days: run it once every unit of a day is present (`decisions_summary.json` lists the units read).

## Blind rule
- Stage 1 (`decide.py`, `features.py`) reads rows at or before the decision slot only: the trigger scans trades in order; flags use the create row and trades up to t0; R and Z replay holdings, links and buys up to t0 + D − 1. `timing()` reads only block times and coverage to apply the drop-by-time rule.
- Fills and returns live in `outcome.py`, which stage 1 never imports. `gate.py` and `flows.py` read the market after the decision but compute no fill or return.
- `tests/test_pipeline.py::test_planted_future_marker` plants a SOL link, a mayhem-flagged trade by a new holder and a token transfer one slot after the decision and requires every decision and feature to be unchanged, and the same rows at the decision slot to change them. Two deliberate leaks (holdings replayed one slot late; links read without their slot) both fail it.

## Tests
`cd research/g1-boost-inventory/tape && python3 -m unittest discover -s tests` (synthetic tables only; about 3 s). Each review fix was checked by reverting it: the matching test fails.

## Files
- `g1.py`: command line.
- `g1lib/params.py`: every registered constant and seed.
- `g1lib/load.py`: units, covered runs, tables, address interning; PumpSwap after-states.
- `g1lib/decide.py`: universe, triggers, S0, strata, timing.
- `g1lib/features.py`, `holdings.py`, `graph.py`: R and its four groups, N, λ, Z, theme waves, clusters.
- `g1lib/market.py`, `quotes.py`, `costs.py`, `outcome.py`: slot-boundary states, exact quotes (ported from `packages/core/src/amm`), fixed costs and rent, fills and returns.
- `g1lib/flows.py`, `gate.py`: flows in [m, m + D], W1's fast class, G1-0 and the amendment gates.
- `g1lib/stats.py`, `score.py`: bootstrap, verdicts, futility, frozen medians, secondary summary.
- `g1lib/checks.py`: §7 checks 2–5.
- `fixed_costs.ts` → `fixed_costs.json`: the fixed-cost terms read from `packages/backtest/src/research/edge-costs.ts` (`node --no-warnings fixed_costs.ts > fixed_costs.json`).

## Registered item → implementation

| Registered item | Implementation |
|---|---|
| PREREG §2 data: S, G, C from the tape only; days by role | `load.load`, `load.find_units` (`--days`) |
| §2 drop by time (entry + 30 min + D past the last slot read) | `decide.timing` (`dropped_by_time`); `outcome.run` skips them |
| §2 fees from each trade's own fee fields | `market.Market.curve_fees`, `Market.pool_fees` |
| §3 universe: SOL quote, not mayhem, not cashback, flags from create or trade rows, unreadable excluded | `decide.flags_asof` |
| §3 one trade per mint; one completion | `decide.decisions` (first trigger per mint), `market.Market.completion_slot` |
| §4 progress = virtual_sol − 30 SOL; target 85.005 SOL; trigger 90% | `params.TARGET_LAMPORTS`, `params.trigger_lamports`, `decide.real_progress`, `decide.find_trigger` |
| §4 D = 23 slots | `params.D` |
| §4 entry at t0 + D, worse of slot start/end, own impact, neighbouring fees; no entry if complete before | `outcome.entry_fill`, `outcome.simulate` (`miss`), `quotes.curve_buy_exact_quote_in`, `quotes.worse_buy` |
| §4 exit A at m + D on the canonical pool, effective quote, tier fee, vault cap | `outcome.pool_exit`, `quotes.pool_sell`, `market.Market.pool_state` |
| §4 exit B 30 min after entry on the curve | `decide.timing` (`exitB_slot`), `outcome.curve_exit` |
| §4 size $50 = 0.4193 SOL | `params.spend_lamports(50)` = 419,252,054 lamports |
| §4 costs: venue fees, impact, fixed costs as edge-costs.ts, Token-2022 rent check | `costs.expected_fixed`, `costs.token_account_rent`, `costs.rent_log`, `fixed_costs.json` |
| §5 S0 control: uniform 50–80% progress, one per mint, fixed seed, same delay/exits/costs | `decide.s0_progress`, `decide.decisions` (kind `S0`), `outcome.run` |
| §6 G1-0 (a) triggers a day; (b) slots t0 → m, median and share > D; (c) BOOST timing, share after m + D, share with BOOST; kills (exactly half of graduates below 25% kills) | `gate.g1_0`, `gate.boost_rows`, `gate.boost_share_kills`, `gate.graduates`; `tests/test_review.py::BoostShareRule` |
| §7 check 1 as-of with planted future marker | `tests/test_pipeline.py::test_planted_future_marker` |
| §7 check 2 curve reserves after, pool reserves before | `checks.check2_reserves`; `tests/test_quotes.py::TapeFixtures` |
| §7 check 3 fee-tier market cap | `checks.check3_tier` (empirical; program not read, OQ-16) |
| §7 check 4 target and migration fee | `checks.check4_target` |
| §7 check 5 code, seeds, input hashes | `checks.input_hashes`, `checks.code_hashes`, `params.S0_SEED`, `params.BOOTSTRAP_SEED` |
| §8 futility on discovery (one-sided 95% upper bound < 0) | `stats.futility`, `score.judge(role="discovery")` |
| §9 primary: mean net return per filled trade in SOL, fixed costs included | `outcome.simulate` (`ret`), `stats.primary` |
| §9 pool-clustered bootstrap stratified by day, 10,000, fixed seed, 99.5% and 95% | `stats.cluster_bootstrap_means`, `stats.interval` |
| §9 pass: lower bound > 0, ≥ 300 trades, mean > 0 each day, lift over S0 > 0; unresolved / not supported | `stats.primary` |
| §10 exits m + 8, m + 45, m + 2D, m + 150, m + 750 | `params.SECONDARY_EXITS`, `outcome.run` |
| §10 triggers 80% and 95% | `params.SECONDARY_TRIGGERS`, `decide.decisions` (kinds `G1@80`, `G1@95`) |
| §10 sizes $5…$10,000 with gross, fixed, fees, impact; infeasible sizes | `outcome.run`, `outcome.simulate` (`gross_ret`, `fixed_pct`, `fees_pct`, `impact_pct`, `miss = entry-exceeds-reserves`), `score.secondary` |
| §10 decomposition: curve leg, migration step, window | `outcome.decompose` |
| §10 flows in [m, m + D]: BOOST quote, sniper buys, pre-migration holders' sells | `flows.migration_flows` (`boost_sol_in_window`, `fast_buy_sol`, `pre_holder_sell_sol`) |
| §10 share of exit B and its mean | `score.secondary` |
| A1 feature R as of t0 + D − 1, base = holders except the curve, curves created on the tape | `features.FeatureContext.feature_r`, `holdings.replay` |
| A1 group 1 creator funding cluster (T and W links, hubs > 50) | `graph.LinkGraph.cluster` |
| A1 group 2 first buy within 10 slots of create | `features.feature_r` (`book.first_buy`) |
| A1 group 3 average cost ≤ half the curve price at t0 (H1-CGO §4) | `holdings.Book`, `features.feature_r` |
| A1 group 4 ≥ 5 buys, ≥ 10% within 2 slots of create or migration | `features.FeatureContext.serial` |
| A1 arm: R below the frozen discovery median | `score.freeze`, `score.arms` |
| A1 gates (a) ρ ≥ 0.2 with lower bound > 0; (b) coverage ≥ 90%, dropped pre-tape curves; (c) ≥ 100 filtered catchable a day; (d) ρ with age, terciles | `gate.hc_gate`, `flows.migration_flows` (`share_pre_sold`) |
| A1 judgement: §9 on the subset plus lift over G1; futility rule | `score.judge` |
| A1/A2 descriptive BOOST rows: unspent at m + D, + 150, + 300 (capped/uncapped), slices with trades between, non-BOOST buy SOL in [m, m + D], non-zero `min_base_amount_burned`, quote ÷ base, slippage failures | `gate.boost_rows`, `gate.g1_0` (`desc_*`), `flows.migration_flows` (`non_boost_buy_sol`) |
| A2 N, λ (trailing hour, 10-s grid), Z, creator cluster, theme waves | `features.FeatureContext.feature_z`, `FeatureContext._rivals` |
| A2 gates (a)–(d) incl. net opening flow and W1 fast class | `gate.cap_gate`, `flows.migration_flows`, `flows.FastClass` |
| A2 arm: Z at or below the frozen median; judgement with lifts over G1 and S0 | `score.freeze`, `score.arms`, `score.judge` |
| A2 §3 quote-mint strata (triggers, InitBoost share, BOOST unspent after m + D, distinct buyers) | `decide.quote_target`, `gate.strata_rows` |
| A3 OQ-14 cap headroom per BOOST slice, by slice order and slot after m (descriptive) | `gate.cap_headroom`, `gate.headroom_summary` |
| A3 OQ-6 rent by date: 6,960 / 6,333 / 5,080 lamports per byte | `params.RENT_LAMPORTS_PER_BYTE`, `costs.token_account_rent` |
| A3 OQ-16 fallback tier at effective quote × base_supply ÷ base | `market.fallback_tier`, `Market.pool_fees` |
| Review 1: plan, units, manifest and score guards | `guard.load_plan`, `guard.check_units`, `guard.verify`, `guard.check_score`, `load.find_units`; `tests/test_review.py::Guards` |
| Review 2: Z rows by slot at or before the cutoff | `features.FeatureContext.feature_z`; `tests/test_pipeline.py::test_z_counts_rows_by_slot` |
| Review 3: all validation days present, each mean > 0 | `stats.primary(required_days=…)`; `tests/test_review.py::RequiredDays` |
| A4: count gates A1 (c), A2 (d): pooled count reaches the threshold and each day at least 40% of it (OQ-27) | `gate.count_gate`, `gate.hc_gate`, `gate.cap_gate`, `params.COUNT_GATE_DAY_FLOOR`; `tests/test_review.py::PerDayMinimum` |
| Partial days give no verdict | `g1.strip_verdict`; `tests/test_review.py::PartialDays` |
| Review 5: catchable excludes dropped-by-time | `gate.g1_0`; `tests/test_pipeline.py::test_gate` |
| Review 6: BOOST and buyback rows without the protocol column | `market.Market.__init__` (`is_boost`, `is_buyback`, `is_protocol`), `flows.migration_flows`; `tests/test_pipeline.py::test_gate` |
| A5: G1-0 kills on pooled Step A events; no day alone may kill (counts ≥ 40% a day, time and share at full threshold each day) | `gate.g1_0_kills`, `gate._time_share_kills`; `tests/test_review.py::G10PooledAndDays` |
| A6: PostCompleteBuyEvent count ("not checkable" until the decoder's pump IDL has the v3 items); opening reserves vs a plain migrate deposit; catchable share as a post-v3 upper bound; v3 completer pool part per graduation; BOOST accounting row per slice | `gate.v3_rows`, `gate.decoder_has_v3`, `gate.v3_pool_part`, `gate.g1_0` (`catchable_share_upper_bound_for_post_v3`), `gate.cap_headroom` (`boost_slices.csv`); `tests/test_amendment6.py` |
