# Lottery-basket probe: result

Run 2026-10-07 on commit `f5e925f` (rules in `PREREG.md` plus the pre-run amendments). Exploration, not proof. 900 random pump.fun graduates created 2026-07-22 to 08-20 (dead coins included); 506 usable, 267 dust pools (rejected, as the bot's H8 does), 127 with a first price far from the migration price (mostly pump-and-dump prints), 0 with no data.

## Verdict (as registered)
LB-1H and LB-24H: **not supported** at every hold. LB-SLOW: **insufficient** (48 trades).

## Numbers ($20 bets, in SOL, after costs)

| Line | Trades | Win rate | Mean | Median | Avg win | Avg loss | Biggest winner | P(100 trades end positive) |
|---|---|---|---|---|---|---|---|---|
| LB-1H, hold 7 days | 492 | 4.3% | −32.6% | −15.4% | +119% | −39% | 11.1× | 0% |
| LB-1H, hold 30 days | 487 | 1.6% | −39.5% | −21.4% | +70% | −41% | 6.3× | 0% |
| LB-24H, hold 7 days | 343 | 4.4% | −23.5% | −11.0% | +15% | −25% | 1.6× | 0% |
| LB-24H, hold 30 days | 337 | 3.6% | −28.5% | −14.1% | +5% | −30% | 1.2× | 0% |
| LB-SLOW, hold 7 days | 48 | 6.2% | −45.1% | −65.6% | +241% | −64% | 8.0× | 0% |

Worst case with every excluded coin booked as a total loss: −44% to −52% a trade. Re-scored with the 127 odd-start coins put back in: worse (LB-1H 7 days −37.5%).

## What it means
- The big-winner shape needs rare huge winners to pay for everything else. In a random month of graduates (after dust pools are removed) the biggest 7-day winner was 11×, and only about 2–4% of bets won at all. The average loser gives back about 40%. That is far from enough: at a 4% win rate the average winner would need to be about +900% to break even.
- The 127 coins with an odd first price are pump-and-dumps: price 1,000×+ the migration price on a few thousand dollars of volume, then the floor within one to three hours.

## Limits
Hourly OHLCV from a public aggregator; the graduate list came from pump.fun's search API (completeness not independently verified); one month, one regime.
