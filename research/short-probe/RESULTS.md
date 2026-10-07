# Short-side probe: results (run 2026-10-07)

Run exactly as pre-registered (`PREREG.md` with all amendments, last one at 9383d15), `python3 -I short.py run <hl> <out>` on Hyperliquid daily candles and actual hourly funding for every non-major perp. Liquidation at 1.714× entry is **an assumed stress level**, not exact venue mechanics. Returns are in USD; SOL terms beside them.

## Verdicts

| Rule | Verdict |
|---|---|
| **S2 short downtrends (primary)**, weekly, judged against S0 | **not supported** |
| S3 | not supported |
| S1-30, S1-60 short new listings | **withheld (funding missing)**: rule 3 of the amendments |

## Primary: S2 vs S0 (weekly, actual funding, base costs)

| | Discovery | Validation |
|---|---|---|
| S2 mean a week | +0.26% (95% −2.8% … +3.3%), n=79 | **−0.01%** (95% −2.5% … +2.5%), n=62, 47% of months positive |
| S0 short everything | −0.09% | +0.26% (95% −2.2% … +2.7%) |
| **S2 − S0** | +0.35% (95% −0.25% … +0.95%) | **−0.26%** (95% −0.85% … +0.32%) |

S2 earned nothing beyond shorting everything, so it is no signal. SOL-terms means are positive (+1.8% a week in validation, S0 +2.1%). That is SOL's own fall over the period, not the rule.

S3 lost in validation (−0.58% a week, 95% −1.1% … −0.07%; 27% of months positive).

## S1: short at listing (secondary)

| | Discovery (n=185) | Validation (n=32) |
|---|---|---|
| S1-30 mean a trade | −7.8% (95% −16.2% … +0.7%), 45 liquidated | +15.0% (95% −6.5% … +36.5%), 6 liquidated |
| S1-60 mean a trade | −10.4% (95% −20.4% … −0.5%), 61 liquidated | +11.4% (95% −13.7% … +36.5%), 8 liquidated |

**Withheld** because 11 (S1-30) and 13 (S1-60) trades lack full funding. All of them are listings of May 2023: the coin's funding file starts in early June 2023, which is short of a full 30-day hold. The rule stays withheld as registered.

It could not pass anyway. Its discovery mean is negative, and its validation 95% lower bound is below zero; both are independent of those funding rows. Their funding would have to add about +130% a trade to lift the discovery mean above zero, while 30 days of typical funding is a few percent. No rescue sweeps were run.

## Plain words

Shorting meme perps on Hyperliquid did not make money beyond the market's own drift. Shorting new listings won often but lost big when a coin squeezed (about 1 in 4 discovery trades hit the assumed liquidation), and its result flips sign between periods.
