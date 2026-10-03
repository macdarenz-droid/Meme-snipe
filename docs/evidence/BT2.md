# BT-2 evidence

Historical backtest and strategy study (ARCHITECTURE §20 BT-2, pre-funding items 2 and 6). This page says how the evidence is produced and lists the runs. Each run's JSON file in `docs/evidence/bt2/` carries the exact commit, the dataset hash (sha256 of `manifest.json`), the study hash and the configuration ids.

## Commands

```
node packages/backtest/src/study/cli.ts day   --dataset <dir> --sol-usd <file> [--days 2026-09-01] [--seeds 5] [--replays 10]
node packages/backtest/src/study/cli.ts trial --dataset <dir> --sol-usd <file>
node packages/backtest/src/study/cli.ts study --dataset <dir> --sol-usd <file> --registry docs/evidence/bt2/registry.json [--run-holdout]
```

All three accept `--insiders <file>`, a funding supplement (FACTS-1).

- **day:** the strategies and S0 through the whole engine on the given days, then the engine evidence:
  - 0 crashes, illegal states and unreconciled intents;
  - identical replays;
  - the leak test;
  - `ledger:replay` on the run's ledger;
  - counts and the reject mix.

  On a holdout day (2026-09-22 to 2026-10-01) entries are off and only engine validity is reported.
- **trial:** the practice days present that have their 14-day look-back. The output is a trial in progress, not a verdict.
- **study:** the whole window (2026-08-03 to 2026-10-01, lead-in from 2026-07-20). It runs:
  - walk-forward with purge and embargo, reported per regime, and S0;
  - G1;
  - holdout registration;
  - the sealed holdout, only with `--run-holdout`, and once ever;
  - G2;
  - G0.

## What a result can say today

- **H13** rejects every candidate until FACTS-1's funding supplement exists, because DATA-1 does not record funding. A study without it reports "not proven".
- **Raw-derived facts** (mint authorities and extensions, holders) exist for the 5% raw sample only. The other candidates are rejected as missing until the supervisor rules how state reads are treated in the backtest.
- **The conservative scenario** recovers no token-account rent: about 9% of a $2 trade (raised with the supervisor).
- **Live-only vetoes** are absent in the backtest (§16.3): H15 simulation, H16 cross-checks, Jupiter routes and fees, execution health. G3 caps the live veto share at 10%, which bounds the bias at 5 points.

## Runs

| Date | Kind | Days | Commit | Result |
| --- | --- | --- | --- | --- |
| — | — | — | — | waiting for the first published data day |
