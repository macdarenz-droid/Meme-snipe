# Regime probe: does a "hot meme market" signal pick better times to buy? (pre-registered 2026-10-08)

Owner, 8 Oct: "Have we studied where the bot only finds big fish? It trades once or twice a week but is active 24/7 ... it just looks for the right time ... $50 per trade doesn't hurt." Exploratory: both samples below were already used for the runner tests, so this is a new hypothesis on viewed data, never a verdict that can fund anything.

## Data
- Usable coins of `../lottery-probe/sample.json` (created 2026-07-22..08-20) and `../runner-probe/validation_sample.json` (created 2026-08-21..09-06), loaded with `runner.coins()` (dust, start-missing and no-entry excluded as registered).
- Hourly GeckoTerminal bars ending by the wall.
- Entry = the close of hour 1 after migration (`ts[1] + 3600`). The entry-time cutoff applies as in the runner validation.

## Outcome per entry
- R1 on the hourly line (stop −30%, arm 2×, trail 40%, 14-day hold) at **$50**, net in SOL terms (`lottery.net`).
- Also reported: capped at +19, and the indicators net ≥ +1 (2× proceeds) and net ≥ +4 (5× proceeds).

## Signal (known at entry time only)
**HOT(t)** = among the sampled coins whose entry was in [t − 72 h, t − 24 h], the share whose maximum hourly close (volume > 0) within 24 h after their own entry reached ≥ 2× their entry price. Every input has finished by t. Entries with fewer than 15 coins in the window get no signal and are excluded and counted.

The live bot would see all graduates, about 1,300 a day, not about 30 sampled ones. So this signal is noisier than a live one and would understate a real effect.

## Tests
- **Primary:** the difference in mean capped net between entries with HOT above and at-or-below the median HOT of all signalled entries (pooled, both samples). 95% CI from a bootstrap that resamples entry days. The median threshold is in-sample, and this is stated.
- **Secondary:**
  - Spearman correlation of HOT with capped net, with the same day-clustered CI;
  - the top-decile-HOT "rare trader": trades per week, mean net, capped mean, ≥ 2× and ≥ 5× counts;
  - each sample separately.
- **Reading:** "worth a forward test" only if the primary CI lower bound is > 0 AND the top-decile capped mean is > 0. Otherwise "no usable timing signal in this data". Neither reading is evidence for real money.
