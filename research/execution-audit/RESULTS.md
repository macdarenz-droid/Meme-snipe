# Execution audit: results (method fixed in PREREG.md before any result)

Exploration coins only. Validation coins were never read. Code: `heli.py` (read-only RPC, decoding), `audit.py`
(replay, `python3 audit.py report` regenerates `tables.md`). Per-trade numbers: `audit_results.json`; full
tables: `tables.md`.

## What was done
- 40 coins replayed from PumpSwap swap events on their canonical pool: the jackpot (A), winners 1–9 (B), and
  the 30 random stop-outs (C). B-winner8 and C-stop12 are the same coin, so the C averages count it once.
- Ordering: (slot, `transactionIndex`, inner-instruction order). The reserves carried from swap to swap matched
  the next event's logged pre-swap reserves on every real-time path (0 mismatches). This needed one fix during
  the run: one buy layout logs `quote_amount` differently, so the pool's quote delta is taken from
  `quote_amount_in_with_lp_fee` / `quote_amount_out_without_lp_fee` (checked against the next event).
- Range fix during the run: for thin pools the fetch first ended 15 min after the last hourly exit bar. When a
  trigger or exit swap lay past that, the range was widened to entry + 15 days (6 coins re-run).
- Credits: 631,350 counted (63,135 calls × 10) plus 1 uncounted diagnostic call (10). Cap 1,500,000. Nothing
  was skipped for credits.

## Per trade: multiples of the $10 stake, before network cost (−0.005 for it)
Hourly replay = sell at the first swap after the exit bar's end, plus L slots. Real-time = swap-level trigger, plus L slots.

| trade | rule | hourly model | hourly replay L=1/5/25/150 | real-time L=1/5/25/150 |
|---|---|---|---|---|
| A jackpot | R1 | 130.75 | 131.9 / 131.9 / 131.7 / 241.8 | 26.7 / 26.7 / 28.0 / 35.6 |
| A jackpot | R2 | 23.27 | 23.8 / 23.8 / 23.8 / 23.8 | 26.7 / 26.7 / 28.0 / 35.6 |
| winner2 | R1 | 4.97 | 5.13 / 5.12 / 5.12 / 4.89 | 21.7 / 21.5 / 24.4 / 28.9 |
| winner4 | R1 / R2 | 4.04 / 7.26 | 4.11 / 7.26 (L=1) | 3.84 / 5.48 (L=1) |
| winner7 | R1 / R2 | 3.78 / 3.95 | 3.80 / 4.06 | 1.38 / 0.87 |
| winner9 | R1 / R2 | 3.22 | 3.19 | 1.69 / 1.47 |
| winners 3, 5, 6, 8 (stops) | R1 | 0.44–0.68 | 0.45–1.15 | 0.67–0.79 |

All 40 trades are in `tables.md`.

Averages (before network cost):

| set | rule | n | hourly model | hourly replay L=1 | real-time L=1 |
|---|---|---|---|---|---|
| B winners 2–9 | R1 | 8 | 2.31 | 2.40 | 3.92 (1.39 without winner2) |
| B winners 2–9 | R2 | 8 | 2.74 | 2.83 | 4.49 (1.52 without winner2) |
| C stop-outs | R1 | 28 | 0.43 | 0.45 | 0.59 |
| C stop-outs | R2 | 28 | 0.43 | 0.45 | 0.57 |

## Findings
1. **The hourly model is executable and slightly conservative.** Selling at the first swap after the exit bar
   (L ≤ 25 slots) lands within about ±3% of the model on every trail exit, and at or above the model on stops.
   For the jackpot, R1's hourly exit really returns about 131.9× (model 130.75×). At L = 150 (~60 s) one swing
   gave 241.8×; that is luck from a minute-scale bounce, not a capturable edge.
2. **The "real-time" line is not an optimistic bound.** A swap-level trail fires on spikes that last seconds.
   The jackpot reached 100× entry for about 6 seconds (15 slots) and then crashed in one swap to 27.5×. Both
   the 40% and the 60% real-time trails fire there and return about 26.7× (27% of the peak position value),
   against 131.9× for hourly R1. The earlier note's real-time R2 estimate (~340×, ~36% of peak at the later
   crash) cannot happen, because a real-time 60% trail would already have exited at the first spike. The same
   pattern cuts winners 7 and 9 to about half. Winner2 goes the other way (21.7× vs 5.1×).
3. **Stops: the hourly fill min(level, close) is conservative.** Real-time stops fill at about 0.62–0.69× on
   most coins, beating the hourly fill on deep gaps (e.g. C-stop5: 0.67× vs 0.01×). But 4 of 26 real-time
   stops still fill at 0.03–0.23×, because a single swap (a rug) jumps from above the level to near zero.
   No latency can avoid that.
4. **Entry cost (D): `lottery.net()` charges about the right amount.** Replay tokens per SOL vs the model:
   0.96–1.02 on 39 coins (median ≈ 1.00). The real pool fee is often 95 bps (or 25 bps on two coins) where the
   model charges 125. Our average fill sits 0.1–5% above the hourly close, which roughly offsets that.

## Uncertainties and data problems (flagged)
- **GeckoTerminal artifacts.** On winner1 the 151× "peak close" appears in no swap on that pool: the on-chain
  maximum is 1.22× entry, and the model's trail at 1.01× matches the replay. On C-stop6 the pool had one swap
  in 15 days after entry, at 0.99×; GeckoTerminal's stop does not show in the swaps, and entry P_e is 0.675× the
  hourly close. Neither has a real-time trigger. Selling into the last reserves returns about 0.95× / 0.96×.
  I can't explain where GeckoTerminal's prices came from. Other targets could carry such artifacts too.
- Counterfactual replay: our own buy and sell are not fed into history, and other traders' reactions are unknown.
- Latency in slots stands in for detection plus landing time. Results at L = 150 swing with minute-scale bounces.
- Only the canonical PumpSwap pool is replayed; other pools of the same mint and arbitrage are ignored.
- 9 winners and 28 stop-outs are small samples. Averages are dominated by single coins (winner2, the jackpot).
- C-stop6's table row shows "model 0.00 ()" because no exit swap exists (a display gap, not a result).

## Plain words
Selling at the hourly close is real: the hourly model's numbers, including the ~130× jackpot under R1, could
have been executed, give or take a few percent. Watching every trade and selling on a 40% or 60% drop is not
safer or better. It sold the jackpot at about 27× on a six-second spike, and halved two other winners. It does
cut the losses on stop-outs (about 0.6× instead of 0.45×). Real rugs still go to near zero either way.
