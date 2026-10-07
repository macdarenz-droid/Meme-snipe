# Deep-pool probe: result

Run 2026-10-07 on commit `0cbf0f5`'s code (rules in `PREREG.md`, fixed and pushed before any return was computed; amendments recorded before the run). Exploration, not proof.

## Verdict (as registered)
All five configurations: **not supported**. No rule beats its costs in the primary group (A + B: 41 established pump.fun coins in canonical PumpSwap SOL pools at ≥ 49,120 SOL market cap, decisions 2026-07-22 to the wall 2026-09-21T14:00Z).

## Numbers ($200 a trade, primary group, % of the trade, in SOL)

| Rule | Period | Trades | Mean gross | Mean net | 95% CI of net (day bootstrap) | Win rate | Random entry (S0) net |
|---|---|---|---|---|---|---|---|
| MR-A (5-min drop ≥ 3σ, +6/−4, 30 min) | discovery | 569 | +0.13 | −0.86 | −1.10 to −0.62 | 29% | −1.04 |
| MR-A | validation | 266 | +0.35 | −0.76 | −1.15 to −0.35 | 30% | −1.20 |
| MR-B (15-min drop ≥ 3σ, +8/−5, 60 min) | discovery | 439 | +0.45 | −0.55 | −0.84 to −0.24 | 39% | −1.07 |
| MR-B | validation | 208 | +0.09 | −1.03 | −1.53 to −0.51 | 32% | −1.24 |
| MOM-C (60-min rise ≥ 3σ on 2× volume, +8/−4, 120 min) | validation | 128 | −0.61 | −1.68 | −2.32 to −1.06 | 23% | −1.29 |
| MR-A-LV, MR-B-LV (low-volume drops) | each period | 6–7 | — | — | too few trades to say anything | — | — |

- Closest case: MR-A in the 0.30% tier only (group A), validation: gross +0.63%, net −0.17% (95% CI −0.71 to +0.32), 99 trades. Not significant, and the realistic line (entry after the next traded bar) falls to −0.68%.
- $50 and $500: the same picture (MR-A validation net −0.64% at $50, −1.14% at $500; bigger trades pay more price impact on the conservative depth model).
- Realistic line (delayed entry, stops fill at the worse of stop and close, fee at the signal price): every rule worse; MR-A validation −0.92%, MOM-C −2.81%.

## What it means
- There is a small, real-looking bounce after sharp drops: the dip rules beat random entry by about +0.2 to +0.5 points (registered), while momentum does worse than random. But the bounce (about +0.1% to +0.6% gross) is smaller than the cost of a round trip in the cheapest pools (about 0.85–1.0%), at every size tested.
- Most of the bounce happens within the first 5 minutes: delaying the entry by one traded bar removes most of it. A slow bot would capture even less.
- The coin list favours dip-buying (it only holds coins still worth about $81k or more today), so the true result is likely worse. A null under that bias is strong.

## Limits
- 5-minute OHLCV from a public aggregator, not transaction-level fills; price impact from a conservative depth model (no LP growth), which overstates impact at $500.
- Fee tiers from the 2026-10-03 snapshot, assumed unchanged since July.
- Group C (smaller coins) was not downloaded (rate limit); only the A + B result is reported.
- 21 validation days; the bootstrap is slightly liberal at that count (a t-interval is reported beside it in `results.json`).

Files: `results.json` (all lines, groups A, B and A + B, with per-pool data hashes in `manifest`), `eligible.json` (163 pools that qualified on at least one day; 41 in A + B). Raw candles are not committed; `fetch.py` re-downloads them.
