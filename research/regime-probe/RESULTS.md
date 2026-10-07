# Regime probe: result (run 2026-10-08, exploratory)

Run as pre-registered (`PREREG.md`, pushed at 39912bd before any computation) with `python3 -I regime.py <exploration hourly> <validation hourly> <out>`. Full numbers: `results.json`.

**Reading (as registered): no usable timing signal in this data.**

| | Entries | Mean capped net ($50, R1 hourly) | Mean net |
|---|---|---|---|
| All signalled entries | 910 | −22.2% | −11.9% |
| HOT above median (median share = 5.3%) | 453 | −17.1% | +3.6% (one jackpot) |
| HOT at or below median | 457 | −27.3% | −27.3% |
| **Difference (primary)** | | **+10.2 pts, 95% CI +1.3 to +21.4** (day bootstrap) | |
| Top-decile HOT ("rare trader", ≥ 11.1%) | 91 on 11 days | **−21.4%, CI −29.4 to −12.2** | −21.4%; 3 trades ≥ 2×, 0 ≥ 5× |

- **The two samples disagree.** By sample, the difference is +18.1 points in exploration and only +2.5 points in validation.
- **The rank correlation is not significant.** Spearman ρ = 0.063 (95% CI −0.014 to +0.133).

## What it means
- Buying graduates in "hotter" stretches lost less: −17% instead of −27% a trade capped. But both halves still lose badly.
- The most selective version, buying only in the hottest tenth of moments, did **not** do better. It lost about 21% a trade and caught no 5× coin. It also ran about 14 trades a week in this sample, not 1–2: the trades cluster on 11 days.
- The gain is almost all in the exploration half, which contains the one jackpot. In the validation half it nearly vanishes.
- The threshold is in-sample, both samples were viewed before, and several readings were reported. So the +10-point difference is a hint at most, not a tradable rule.

## Limits
- The signal uses about 30 sampled graduates a day. A live bot sees about 1,300, so a real effect could be somewhat larger than shown.
- Only 46 days of entries and one market regime (July–September 2026).
