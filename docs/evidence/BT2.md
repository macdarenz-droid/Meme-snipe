# BT-2 evidence

Historical backtest and strategy study (ARCHITECTURE §20 BT-2, pre-funding items 2 and 6). This page says how the evidence is produced and lists the runs. Each run's JSON file in `docs/evidence/bt2/` carries the exact commit, the dataset hash (sha256 of `manifest.json`), the study hash and the configuration ids.

## Commands

```
node packages/backtest/src/study/cli.ts day   --dataset <dir> --sol-usd <file> [--days 2026-09-01] [--seeds 5] [--replays 10]
node packages/backtest/src/study/cli.ts trial --dataset <dir> --sol-usd <file>
node packages/backtest/src/study/cli.ts early --dataset <dir> --sol-usd <file> --days 2026-09-21[,2026-09-20] [--seeds 5]
node packages/backtest/src/study/cli.ts study --dataset <dir> --sol-usd <file> [--trials <file>] [--run-holdout]
```

All three accept `--insiders <file>`, a funding supplement (FACTS-1).

`study` writes the holdout plan, the attempt, each G1 result and every run through the one holdout registry (`research/holdout/registry.json`, kept on the `holdout-registry` branch; every write is a pushed commit), so it needs a clean tree. `--trials` is the experiment registry (default `docs/evidence/bt2/trials.json`).

- **day:** the strategies and S0 through the whole engine on the given days, then the engine evidence:
  - 0 crashes, illegal states and unreconciled intents;
  - identical replays;
  - the leak test;
  - `ledger:replay` on the run's ledger;
  - counts and the reject mix.

  On a holdout day (2026-09-22 to 2026-10-20: entries to the cutoff E = 2026-10-20T00:00Z, then one observation day) entries are off and only engine validity is reported.
- Every run counts the funnel gate by gate, by universe: adverse rejects apart from missing evidence ("not covered").
- **early (BT-2e):** an early look on one or two free practice days, labelled "early look, not proof". It runs U2 only: BT-2's U2, plus RES-4's U2 hypotheses once pinned (or `--preregistration <file> --preregistration-sha256 <hex>` for this look only), each on its own run, with S0 beside them. Per day it reports:
  - the funnel gate by gate;
  - trades per day;
  - win rate with its Clopper-Pearson 95% interval;
  - mean net after costs with a trade-bootstrap 95% interval (which ignores clustering);
  - median net, profit factor, worst trade and longest losing streak.

  It refuses holdout days and writes nothing to the holdout registry. No configuration is chosen or frozen from it.
- **trial:** the practice days present that have their 14-day look-back. The output is a trial in progress, not a verdict.
- **study:** the practice days (2026-08-03 to 2026-09-21, lead-in from 2026-07-20), and the holdout days only with `--run-holdout`. It runs:
  - walk-forward with purge and embargo, reported per regime, and S0;
  - G1;
  - holdout registration;
  - the sealed holdout, only with `--run-holdout`, and once ever (attempt 1, family α 0.04);
  - G2, opening a seal only after that universe's G1 passed;
  - G0.

## What a result can say today

- **H13** rejects every candidate until FACTS-1's funding supplement exists, because DATA-1 does not record funding. A study without it reports "not proven".
- **Raw-derived facts** (mint authorities and extensions, holders) exist for the 5% raw sample only. The other candidates are rejected as missing until the supervisor rules how state reads are treated in the backtest.
- **The conservative scenario** returns the token-account rent only when the final sell lands (fills-2); every G1 and G2 report carries a "no rent recovery" sensitivity line.
- **Live-only vetoes** are absent in the backtest (§16.3): H15 simulation, H16 cross-checks, Jupiter routes and fees, execution health. G3 caps the live veto share at 10%, which bounds the bias at 5 points.

## Runs

| Date | Kind | Days | Commit | Result |
| --- | --- | --- | --- | --- |
| — | — | — | — | waiting for the first published data day |
