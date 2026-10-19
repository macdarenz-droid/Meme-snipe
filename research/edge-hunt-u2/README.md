# EDGE-HUNT-U2

Does the bot's U2 rule set (graduates aged 60–240 min), or the owner's relaxed version (H8 floor $5k, H11 without the +5-min check), make money per trade after the bot's real costs at $2? And do H4 (reclaim) or H5 (exhausted dump) make money? The answer and numbers are in [report.md](report.md).

## Files

| File | What it does |
|---|---|
| `preregistration.json` | Trials, split, fills, costs, selection and verdict rules, committed (d328705) before any result. One amendment, before results, recorded in the file |
| `fetch_migrations.mjs` | Every successful pump.fun migration in the window from the public keyless RPC (`getSignaturesForAddress` on the migration account, then `getTransaction`), fetched in a seeded random order |
| `h9_created.mjs` | Creation time of each non-dust graduate (oldest signature touching the mint before its migration), for H9 |
| `fetch_ohlcv.mjs` | 1-minute candles from migration to +361 min from GeckoTerminal's free API, for non-dust graduates that pass H9 |
| `simulate.py` | The bot's U2 gates, entry rules and U2 exits, as of each minute, with next-bar fills and the bot's costs |
| `analyze.py` | n, win rate, mean and median net return, 95% CIs (coin bootstrap, day-block bootstrap), deflated Sharpe, PBO |
| `manifest.json` | sha256 of every input file and output; the raw data is not committed (size) |
| `results/` | Tables and per-trial JSON |

Reproduce: `node fetch_migrations.mjs DATA 2026-09-22T00:00:00Z 2026-10-06T05:30:00Z 1`, `node h9_created.mjs DATA --follow`, `node fetch_ohlcv.mjs DATA 2050`, then `python3 -I simulate.py DATA sim.json` and `python3 -I analyze.py DATA sim.json out.md out.json`; the holdout run is `simulate.py DATA hold.json --holdout <trial>`. Fetch `solusd_hour.json` from GeckoTerminal pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2` (hour, limit 1000). Python standard library and Node 18+ only.
