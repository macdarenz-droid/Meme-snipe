# MR-01 1-minute screen: result

Run 2026-10-08 (Melbourne) with `screen.py` at commit `e2793f0`. The rules are in `PREREG.md`, which was pushed at `5ebb439` before any return was computed. Its amendments came from a fresh-context code review and were recorded at `1d1cf22`, also before the run. This is a kill-only screen, not proof.

## Verdict (as registered)
**KILLED.** At $200 in validation (2026-08-21 to the wall, 2026-09-21T14:00Z), the 95% CI upper bound is below zero for both configurations, MR-01-5 and MR-01-15. It is far below zero, with no line near it.

## Main numbers ($200 a trade, net in SOL as % of the trade, canonical PumpSwap pools in the 0.30% tier)

| Config | Period | Trades | Days | Pools | Mean gross | Mean net | Median net | Win rate | 95% CI of mean net (day bootstrap) | Random entry net | Dip − random |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MR-01-5 (5 min, z ≤ −3, stop 4%, 30 min) | discovery | 11,392 | 30 | 13 | +0.05 | −0.75 | −0.82 | 10% | −0.78 to −0.73 | −0.83 | +0.07 |
| MR-01-5 | **validation** | 7,368 | 32 | 15 | +0.04 | **−0.77** | −0.84 | 10% | **−0.79 to −0.74** | −0.83 | +0.06 |
| MR-01-15 (15 min, z ≤ −3, stop 5%, 60 min) | discovery | 8,375 | 30 | 13 | +0.06 | −0.76 | −0.83 | 9% | −0.78 to −0.73 | −0.85 | +0.09 |
| MR-01-15 | **validation** | 5,377 | 32 | 15 | +0.06 | **−0.76** | −0.85 | 9% | **−0.79 to −0.72** | −0.84 | +0.08 |

At $200 a round trip costs about 0.88% (2 × 0.30% fee, about 0.26% price impact on the conservative depth model, and 0.02% fixed). The average bounce before costs is +0.04% to +0.06%.

## Other lines (validation; mean net and 95% CI)

| Line | MR-01-5 $200 | MR-01-15 $200 | MR-01-5 $1,000 | MR-01-15 $1,000 |
|---|---|---|---|---|
| Main | −0.77 (−0.79 to −0.74) | −0.76 (−0.79 to −0.72) | −1.49 (−1.54 to −1.44) | −1.49 (−1.54 to −1.43) |
| Cost stress (+1 point) | −1.77 (−1.79 to −1.74) | −1.76 (−1.79 to −1.72) | −2.49 | −2.49 |
| Delayed entry (one minute later) | −0.78 (−0.81 to −0.75) | −0.77 (−0.80 to −0.73) | −1.50 | −1.50 |
| Delayed + stress | −1.78 | −1.77 | −2.50 | −2.50 |
| Pessimistic stop fill (min of level and close) | −0.79 (−0.83 to −0.76) | −0.78 (−0.81 to −0.74) | −1.52 | −1.51 |

Discovery shows the same picture on every line. The full table is `results.json`, where keys look like `config|size|period|line`.

The registered verdict uses the main line. That line fills stops at the stop level, which is the optimistic fill. In this data a stop can never gap past its level, because GeckoTerminal's open is always the previous close: this held for 99.9% or more of minutes in every pool (`coverage.open_eq_prev_close`). Filling at the lower of the level and the close is pessimistic, and it costs only about 0.02 points more.

## Diagnostics (not used for the verdict; `diag.py`, `diag.json`)
These checks test whether the kill comes from a quirk of the 1-minute adaptation.
- **Instant exits.** In 63% of MR-01-5 trades and 68% of MR-01-15 trades, the 6 h median was already at or below the entry price. Following the spec, these trades exit at the next minute's open for zero gross and pay the full cost.
  - The other trades still lose. Their validation mean gross is +0.12% (MR-01-5) and +0.18% (MR-01-15), and their mean net is −0.69% and −0.63%.
- **Size of the drop.** The median triggering drop is only 0.8% (5 min) and 1.2% (15 min). Many minutes in these pools have no trade, and those count as zero returns, which makes the MAD scale small. As a result, z ≤ −3 often fires on small moves.
  - Bigger drops bounce more, but no drop bucket beats costs in either period. Even drops of 8% or more average −0.30% (MR-01-5) and −0.60% (MR-01-15) net in validation, on 207 and 401 trades.
  - No confidence intervals were computed for these subsets, so treat them only as a description.
- **Random entry.** Entries matched by pool and hour of day lose −0.83% to −0.85%, which is about the cost alone. The dip lines beat random by only +0.05 to +0.09 points, much less than the round-trip cost.

## Filters not applied (from OHLCV they cannot be computed)
The following would only remove trades: a depth fall of more than 10% over L, a pending authority or fee change, token-safety checks, REGIME, and ENTRYRATE. The universal exits (section 8.6) were not modelled. A filter could save MR-01 only if it selected trades with a gross bounce near +0.9% or more. The best subset seen here, 8%+ drops in MR-01-5 validation, reached only +0.50% gross.

## Caveats
- **Survivor-only coins.** The coin list keeps only coins still worth about $81k or more in October 2026, which favours buying dips. A kill on this list is therefore strong evidence. The result could be worse on the full universe, but it is unlikely to be better.
- **Data.** These are 1-minute aggregator candles, not the spec's 15 s pool snapshots.
  - A 15 s bot could buy a little lower inside the signal minute. However, the delayed line shows that one minute of delay costs only about 0.01 points, so timing inside the minute is unlikely to make up a gap of about 0.8 points.
  - Minutes with no trade are filled flat. The pools trade in 11% to 100% of eligible minutes (`coverage.traded_share_eligible`).
- **Costs.** The fee tier comes from the 2026-10-03 snapshot and is assumed unchanged since July. Depth uses the migration constant product with no LP growth, which overstates price impact, mostly at $1,000.
  - Even with zero price impact, the cost at $200 would be about 0.62%, against a gross of about +0.05%.
- **Sample.**
  - 22 of the 25 group-A pools had eligible days; 13 traded in discovery and 15 in validation.
  - There are 32 validation days, so the bootstrap is somewhat liberal, but every upper bound is at least 0.7 points below zero.
  - Trades overlap heavily within a pool-day, so the trade counts overstate how independent the evidence is. The CIs are clustered by day for this reason.
  - Three pools (Ducknana, Pistacio, XTAL) never qualified.
- **Data hashes and re-download.** Per-pool data hashes are in `results.json` under `manifest`. Raw candles are not committed; `fetch.py` downloads them again from GeckoTerminal (keyless).

## Plain words
We tested the bot's first planned strategy, buying a sharp dip in a big coin and selling when it bounces back, on 1-minute prices from July to September. After a dip the price does bounce slightly, by about 0.05% on average. One round trip costs about 0.9% at $200. The strategy therefore lost money in every version we tried: both settings, both time periods, both trade sizes, with late entry and with worse fills. The coin list included only coins that survived, which makes dip-buying look better than it really is, and the strategy still lost. MR-01 as written is ruled out. It does not need the 15 s recorder test.
