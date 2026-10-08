# Portfolio-liquidation probe (H3): results

Rules: `PREREG.md`. It was committed before any data pull (c02cfbc), and its pre-data fixes F23–F25 were committed before any bar was downloaded. Run 2026-10-08, 03:38–16:13 Melbourne time. Stage 1 only: the count gate failed, so no return was computed and stage 2 did not run.

## Verdict
**Unresolved: too rare at an affordable cost.**

- Stage 1 stopped at its registered 200,000-credit cap after 1,336 of 195,486 candidate bars, processed in seeded random order.
- The cap came before the 2,000-bar early check.
- Those 1,336 bars hold at most 2 H3-shaped sales. That count is before the wallet-age, creator and hold-time exclusions, which can only lower it.
- The gate needs at least 100 events with controls over at least 30 days. Even an exact upper bound of 2 is far below that, so no possible exclusion result could change the verdict.

## Counts (`stage1_table.json`, SHA-256 in `stage1_table.json.sha256`)
| | Count |
|---|---|
| Candidate bars, screen ≥ 1% (F23) | 195,486 (PumpSwap 159,390; Raydium 36,096) |
| Bars processed (seeded prefix) | 1,336 (PumpSwap 1,102; Raydium 234), 80 of 83 pools |
| Pool transactions read | 1,845,033 (median 41 per bar, 90th percentile 3,552, max 53,194) |
| Large sales (own reserve drop ≥ 3%) | 123 (PumpSwap 113, Raydium 10) |
| by drop: 3–5% / 5–10% / ≥ 10% | 76 / 41 / 6 |
| Partial (not a full exit, or no SOL/stable proceeds) | 57 |
| Bots (> 50 transactions in the 10-minute window) | 5 |
| Full exits with proceeds | 61 (PumpSwap 54, Raydium 7), 21 coins, 35 UTC days |
| k = 0 (single-coin, the control pool) | 58 |
| k = 1 (two-coin) | 1 |
| **k ≥ 2 (H3-shaped)** | **2**: k = 2 and k = 6, both PumpSwap, both on 2026-08-18 UTC (04:31 and 20:49), 3.5% and 4.0% drops |

- **Share of full exits that are H3-shaped:** 2/61 = 3.3% (Wilson 95% interval 0.9–11.2%). The scout found 2 of 20 among small full exits.
- **Events per bar:** 2/1,336 (95% interval 0.04–0.54%). Over all 195,486 candidate bars that projects to about 80–1,060 H3-shaped sales before exclusions.
- **Cost of the full list:** about 29 million credits at the measured 150 credits per bar, more than 100 times the probe's cap.
- **Early-check formula, as a diagnostic only:** c̄ = 149.7 credits per bar. The affordable bars B are the 1,336 already processed, so P = 2 × 1,336 / 1,336 = 2, against a threshold of 100.
- **Not reached, so not reported:** controls matched (none, with 0 eligible events), the gate's day and coin spread, and returns.

## What went differently from the plan (all disclosed; none can change the verdict)
1. **Cost per bar was about 150 credits, not the 10–30 assumed.** A few bars carry most of the transactions: the top 5% of bars hold 64% of them, with up to 53,194 pool transactions in 5 minutes, mostly bot traffic. So the stage-1 cap ran out before the 2,000-bar early check. Skipping busy bars after seeing this would have been a new trial, so the run continued as registered until the cap.
2. **The exclusion checks never ran.** My code scheduled them for the 2,000-bar mark, which the cap pre-empted. The 61 full exits are therefore grouped "unchecked: credit cap", and the 2 H3-shaped sales are an upper bound on events. I did not spend credits beyond the stage-1 cap to finish the checks: they cannot raise the count, and the gate fails at any count of 2 or less. Hold-time validation (F19) also never ran, so that rule is undecided.
3. **The disk filled at bar 1,320.** The raw-response cache reached 30 GB and the crash left the credit ledger file empty. The ledger was rebuilt as (19,308 cached responses + 5 failed writes) × 10 + 1,000 credits of margin for retries, giving 194,130. The run then resumed from its saved state to the 200,000 cap.
   - The code now refuses an empty or missing ledger when responses are cached, and writes the ledger and state with fsync before replacing them.
   - Credits used: 200,000 booked by this probe's ledger, which counts 10 per call, retries and the smoke test included. Helius's own metering (10 per 100 full transactions) should be about the same or lower. Worth checking against the account dashboard.
4. **The bar screen was changed before any download (F23).** A fresh-context review found that the registered 3% screen on bar lows leaks look-ahead, because bar lows are trade prints. The screen became 1% on prints, with the 3% own-reserve test still deciding. This raised the candidate list to 195,486 bars.
5. **The eligible pool list was regenerated (F1).** It is identical to the committed `eligible.json`: 163 pools (A 25, B 16, C 122), the same pools and the same day counts. Its SHA-256 is 33585687…f672119; the file itself stays outside the repo. Bars: 83 files, with hashes in `bars_sha256.json`.

## Caveats
- **Sample size.** This is a seeded random 0.68% of the candidate bars, so the rate estimates are wide (see the intervals above).
- **Classifier limits** (literal readings of F12 and F14):
  - A transfer out followed by closing the token account counts as a full exit with "proceeds", because the rent refund passes the proceeds test.
  - Removing LP tokens counts as an "other full exit".
  - Spam transfers count toward the bot rule.
  - Raydium prices ignore fees accrued in the vaults.
  - A buy that moved the price by more than about 1% just before a 3% sale can hide that sale from the 1% screen (F23).
- **The registered caveats still apply:** a wallet is not an owner, informed sellers, survivorship of the pools, and multi-hop or RFQ misclassification.
- **Review.** A fresh-context reviewer checked the stage-1 classifier before the gate, and every finding was fixed. There was no stage-2 analysis to review.

## Plain-words summary
The idea was this: when one wallet dumps three different coins within 10 minutes, it may be forced to sell, so the third coin might bounce back. We looked for these sales on 83 deep pools, using Helius transaction data.

The answer: they almost never happen where the price really drops. In 1,336 randomly chosen sharp-drop moments we found 61 wallets that sold out completely into a 3% or larger drop. Only 2 of them had sold two or more other coins just before, and both were on the same day.

Getting the 100 such cases a fair test needs would cost about 100 times our credit budget. So the idea is **not tested and not tradable as designed: too rare to measure at an affordable cost**. Nothing here goes into the bot.

## Files
- `PREREG.md` — rules, with pre-data fixes F1–F25.
- `fetch.py` — GeckoTerminal downloads.
- `hel.py` — read-only Helius client with credit ledger.
- `stage1.py` — screen, classifier, gate.
- `report.py` — counts from the table.
- `bars_sha256.json`, `stage1_table.json` and its `.sha256` — the frozen stage-1 table, which holds every processed bar and every large sale with its raw evidence.
