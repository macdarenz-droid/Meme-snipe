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

## Amendment before any validation price was read (2026-10-07, owner brainstorm: take profit at 5×, 6×, 7× ...)
Take-profit ladders were explored on the exploration sample (`runner.py ladders`; a take-profit fills at its level, never above, only in an hour with at least 20 SOL of volume). Selling everything at 5× or 10× lost in every version (it caps the rare winner that pays for the losses); partial ladders sat between full exits and pure trailing. One ladder is added to the validation:
- **R4**: cut loss at −30% until the first take-profit; sell half at 5× (level fill, volume rule above); the rest arms at 2× and trails 60% below its peak close.
Same execution lines, costs, report and support rule as R1–R3.

Execution check on the exploration sample's biggest winner (minute bars, one call): it climbed in steady 0.1%-a-minute steps on about 0.2–0.9 SOL a minute, then a single minute with 319 SOL of selling cut it to 38.6% of its peak, where it traded for 15 minutes before falling further. A real-time trailing exit at 60% would have sold near that level (about 340× entry); a 40% trail could not have filled at its level. The real-time line is therefore close to achievable for a 60% trail and optimistic for a 40% trail.

## Amendment after an outside review, before any validation price was read (2026-10-07)
- **Truncated holds (code fix).** A trade whose full 14-day hold would run past the data window is now left out (time-only); before, it was closed early at the window's end. Validation entries (2026-08-21 to 09-06 creations) with 14-day holds end by 2026-09-20, before the sealed window; none of the 30-day outcomes the reviewer worried about are used.
- **Reported beside every result (report-only, no verdict):** returns capped at 20× for statistics only (exits stay uncapped); a chronological account with fixed $10 bets placed at their entry hours, overlapping positions, P&L by settlement month, worst drawdown and peak capital tied up; counts of trades returning 10× and 50× or more. "P(100 trades end positive)" is reported as the share of 10,000 resampled batches with a positive total, which cannot show winners the sample never contained.
- **Objective:** growth in SOL (the owner's original measure); USD shown alongside where it differs.
- **Jackpot capacity check (exploration coin).** At about 38.6% of its peak close the canonical pool held about 519 SOL of quote (constant-product estimate from the price; LP is burned, so depth cannot be lower). Selling the whole position from a $10 entry (about 1.9M tokens) into it returns about 27.5 SOL against a marked 29.1 SOL, about 5.5% impact, before the 0.90% fee at that market cap. The real-time line's capture of that coin was achievable; a transaction-level replay is still the proper test.

## Amendment after the second outside review, before any validation price was read (2026-10-07)
Only file counts and each series' window end (all at the wall) had been looked at in the validation folder.
- **One primary rule.** The primary test is **R1 on the hourly line at $10**, judged in SOL by the support rule above (hourly mean > 0 and real-time mean > 0). R1 is the first rule listed and the best on the conservative line in exploration (hourly +3.6%, real-time +28.5% a trade at $10, both resting on one coin). Choosing it from exploration is allowed because the validation sample is fresh. R2, R3 and R4 are secondary diagnostics. A failed primary with a passing secondary is a new hypothesis for new data, never a pass.
- **The hourly line is the execution model.** It decides only at each hourly close with data known then, and sells at that close (GeckoTerminal opens equal the previous close). R4's 20-SOL condition there uses only the finished hour. It is a rule on known data, not proof that a fill at 5× was available. The **real-time line is an optimistic bound**, not an execution model: it uses the unfinished hour's high and that hour's final volume. It can only block a pass, never create one. Residual limit of the hourly line: a stop that gaps intra-hour is filled at min(level, close), which is better than a real fill after a crash-and-recover hour. A transaction-ordered replay is the proper test.
- **Entry-time cutoff.** An entry is eligible only if entry time + 14 days ends by the last full bar before the wall. The code now applies this explicitly and reports the excluded count (expected 0, since the latest creation is 09-06). Coins without data, dust pools (first bar opens below 2.41e-8 SOL, an entry-time price rule), start-missing and no-entry coins are counted and reported, never dropped silently. A dead pool stays in with its last close carried; LP is burned, so its depth cannot be pulled.
- **Corrected jackpot figure.** At 38.6% of the peak close, with about 5.5% average impact and the 0.90% fee, the proceeds are 0.386 × 0.945 × 0.991 ≈ 36.2% of the peak position value. That is about 9.6% below an ideal fill at 40% of peak, not "at the trail level". A 40% trail on that one-minute crash would have filled near the same post-crash price.
- **Cap definition.** "Capped at 20×" caps the net return at +1900%, i.e. gross proceeds of 20× the stake (statistics only).
- **Added report (report-only, no verdict):**
  - realised net-return bins (≤ −30%, −30%..0, 0..+100%, 2×–10×, 10×–50×, 50×+ proceeds) with counts and summed contributions;
  - the loss bill of all trades under 10× proceeds;
  - exact binomial intervals for the share of 10× and 50× trades (they assume independence, which correlated launches violate);
  - sensitivity of the mean to: dropping the best trade, halving its payout, making every non-winner 5 points worse, and losing every second 10× winner in time order;
  - entry-week totals, the number of weeks with a 10× winner, and an approximate interval across weekly means.
  - The resampled-batch share stays as registered; it duplicates the sample's extremes and is no evidence about unseen winners.
- **Facts from the exploration notes that the validation does not use:** the 33% dust share in `../brainstorm/RESULTS.md` used LP supply read today. It is descriptive only and was not checked against reserves.
