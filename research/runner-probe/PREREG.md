# Runner probe: cut every loss, ride the rare big winner (owner's concept, 2026-10-07)

Exploration, not proof. Owner: "bet on that luck ... a fix cutloss for every loss ... when it finds the lucky coin it covers all those losses". Owner's business rules waived; ethics and law kept.

## What was explored first (already seen; not evidence)
On the lottery probe's 900-coin sample (created 2026-07-22 to 08-20): 492 usable coins, 24 rule variants × 2 execution modes (`runner.py` GRID). Every positive mean rested on one coin (about 130× with hourly-close exits, about 330× with real-time exits); without that single trade every variant lost 7–25% a trade. That sample chose the three configurations below and cannot confirm them.

## Validation (fixed before any of its prices was read)
- Coins: `validation_sample.json`, 900 random SOL-quoted graduates created 2026-08-21 to 09-06 (seed 20261009), disjoint from the exploration sample. Hourly OHLCV in SOL from GeckoTerminal, bars ending by the wall (2026-09-21T14:00Z).
- Usable coins: the lottery probe's amended rules (dust pools out, migration hour found, tradeable at hour 1, no bar below the depth floor before entry).
- Entry at the close of hour 1 after migration. Max hold 14 days.
- **R1**: cut loss at −30%; once the close reaches 2× entry, sell when the close falls 40% below its peak close.
- **R2**: cut loss at −30%; arm at 2×; trail 60%.
- **R3**: no cut loss; arm at 2×; trail 40% (shows what the cut loss is worth).
- Execution, two lines each: **hourly** (a cut loss fills at the lower of its level and that hour's close; a trailing exit fills at that hour's close) and **real-time** (fills at the level, a trailing exit only where that hour traded at least 20 SOL, otherwise at the close). Costs as in the lottery probe at $3, $10 and $50.

## What will be reported and judged
Per configuration and line: trades, win rate, mean and median per trade, the best trade, the mean without the best trade, the number of trades returning 10× or more and 50× or more, and P(100 trades end positive).
A configuration is **supported** only if, at $10 on the hourly line (the conservative one), the mean per trade is > 0 in validation, and the real-time line's mean is also > 0. Because the payoff rests on rare winners, a single month cannot give a meaningful confidence interval; "supported" means only that the lucky tail showed up again, never that it is proven. The mean without the best trade is reported next to every result.
