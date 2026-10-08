# Cheap-venue probe: result

Run 2026-10-07 on the code at commit `553d3e6` (rules in `PREREG.md`, pushed in `6033cd0` before any candle was downloaded; amendments recorded before the run). Exploration, not proof. A fresh-context review of the code before the run found no look-ahead, cost or join error; its one cost finding (Raydium CPMM creator fee) was fixed as a pre-run amendment.

## Verdict (as registered)
All five configurations: **not supported**. Cheaper pools do not rescue the 5-minute dip or breakout rules: on large memes in their cheapest deep pools the bounce itself almost disappears.

## Universe
46 Solana meme coins, each in its lowest-fee SOL pool with ≥ $250k liquidity and a verified static fee ≤ 0.30% (`universe.json`): 36 Raydium AMM v4 at 0.25%, 6 Raydium CPMM at 0.30% (0.25% + 0.05% creator fee, charged as an upper bound), 1 Raydium CLMM at 0.25%, 3 Orca Whirlpools (Bonk 0.05%, Fartcoin 0.16%, PENGU 0.30%). Includes WIF, POPCAT, BOME, MEW, GOAT, FWOG, MOODENG, PNUT, CHILLGUY, SPX, USELESS and others. 32 tokens excluded as not memes, each with a reason (`exclusions.json`); 70 candidates had no qualifying pool, mostly because their only deep pools are Meteora (fee not verifiable, excluded by PREREG). None of the 41 deep-pool (PumpSwap) coins has a qualifying cheap pool.

## Numbers ($200 a trade, registered execution, % of the trade, in SOL)

| Rule | Period | Trades | Mean gross | Mean cost | Mean net | 95% CI of net | 99% lower | Win rate | Matched random net | Rule − random (95% CI) | Stress net |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MR-A (5-min drop ≥ 3σ, +6/−4, 30 min) | discovery | 885 | +0.07 | 0.62 | −0.55 | −0.63 to −0.48 | −0.65 | 19% | −0.64 | +0.09 (+0.01 to +0.17) | −1.55 |
| MR-A | validation | 931 | +0.06 | 0.62 | −0.57 | −0.69 to −0.44 | −0.72 | 25% | −0.64 | +0.07 (−0.05 to +0.20) | −1.57 |
| MR-B (15-min drop ≥ 3σ, +8/−5, 60 min) | discovery | 688 | +0.03 | 0.62 | −0.59 | −0.72 to −0.46 | −0.76 | 25% | −0.64 | +0.05 (−0.09 to +0.18) | −1.59 |
| MR-B | validation | 785 | +0.05 | 0.62 | −0.57 | −0.77 to −0.39 | −0.83 | 28% | −0.64 | +0.06 (−0.14 to +0.25) | −1.57 |
| MOM-C (60-min rise ≥ 3σ on 2× volume, +8/−4, 120 min) | discovery | 506 | +0.16 | 0.61 | −0.45 | −0.72 to −0.19 | −0.80 | 30% | −0.58 | +0.13 (−0.15 to +0.39) | −1.45 |
| MOM-C | validation | 528 | +0.03 | 0.61 | −0.59 | −0.84 to −0.34 | −0.91 | 28% | −0.59 | +0.00 (−0.26 to +0.26) | −1.59 |
| MR-A-LV | validation | 16 | −0.31 | 0.60 | −0.92 | −1.54 to −0.45 | −1.79 | 0% | −0.49 | −0.43 | −1.92 |
| MR-B-LV | validation | 23 | +0.03 | 0.54 | −0.51 | −1.22 to +0.46 | −1.39 | 22% | −0.63 | +0.12 | −1.51 |

Discovery 2026-07-22 to 08-20 (30 trading days), validation 08-21 to the wall 2026-09-21T14:00Z (32 days). CIs are day-block bootstraps; t-intervals are in `results.json`.

- **$1,000:** every rule worse, validation net −0.91% to −1.33% (cost about 0.94–1.04%).
- **Realistic line** (entry after the next traded bar, stops fill at the worse of stop and close): every rule worse; MR-A validation −0.64%, MR-B −0.69%, MOM-C −0.78%, and rule − random turns to about zero or negative.
- **By fee tier** (descriptive only, not tested, validation MR-A): Bonk and Fartcoin (0.05–0.16%), 45 trades: gross +0.09%, net −0.37%. Even the cheapest seats lose, because the gross bounce is about zero. One post-hoc cell (MOM-C in the eight 0.30% pools, 84 trades, net +0.19%) is the kind of slice that appears by chance among many; it was not a registered test and its discovery counterpart was not checked for it.

## What it means
- The cost workaround works on paper: a round trip here is about 0.6% at $200 instead of 0.85–1.0% in PumpSwap. But the bounce shrinks even more. After a 3σ drop, large memes in deep pools recover only about +0.03% to +0.07% on average (versus +0.1% to +0.6% in the pump.fun coins), so cheaper fees still leave each trade about −0.55% net.
- Dip-buying beats a random entry in the same pool and hour by only about +0.05 to +0.09 points, which is not significant in validation and gone with a realistic delay. Breakouts do no better than random.
- To break even at $200 the rules would need about +0.6% gross per trade, about ten times what they got. No fee level available on Solana closes that gap.

## Caveats
- Survivorship: the list is coins alive and deep on 2026-10-07; coins that died between July and now are missing. That bias favours dip-buying, so the null is stronger, not weaker.
- Liquidity and fees are today's snapshot, not July's. Impact for concentrated pools (Raydium CLMM, Orca) uses a full-range constant-product approximation; near-price depth was not measured. Modelled impact at $200 is about 0.05% for the median pool (0.003% to 0.30% across pools), so an error here is far smaller than the 0.6-point gap.
- The CPMM creator fee is charged on all 6 CPMM pools as an upper bound (adds 0.10 points per round trip there; it does not change the verdict).
- Meteora pools are excluded (dynamic fees, not verifiable), so coins whose only deep pool is on Meteora are absent.
- 5-minute OHLCV from a public aggregator, not transaction-level fills; a few pools are sparse or young (bar counts in the `manifest` of `results.json`).
- Raw candles are not committed; `fetch.py` re-downloads them, and `results.json` holds each pool's SHA-256.

## Plain words
Paying lower fees does not fix it. On the big, cheap-to-trade meme coins, a sharp 5-minute drop is followed by almost no bounce at all, about 0.05%, while even the cheapest trade costs about 0.6%. Buying spikes is no better. Every rule lost money in both halves of the test, at $200 and at $1,000. Short-term (5-minute) dip or breakout trading on Solana memes does not work at any fee level we can get.

Files: `PREREG.md`, `fetch.py`, `probe.py`, `universe.json`, `exclusions.json`, `seeds.json`, `results.json` (all lines, both sizes, both execution lines, $200 registered trades, manifest).
