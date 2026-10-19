# EDGE-HUNT-U1: do the pre-registered U1 rules make money after real costs?

Research agent EDGE-HUNT-U1, 2026-10-06/07 (Melbourne). Paper research only: no bot key, no live code changed.
The answer and its numbers are in [REPORT.md](REPORT.md). This file says how to reproduce it.

## Question

Coins 1–14 days after their pump.fun graduation whose PumpSwap pool holds at least 100 SOL (U1). Does H1 dip-reversal,
H2 quiet accumulation, H3 range breakout or H6 dip-reversal-with-SOL-up (`research/edge/preregistration.json`, thresholds
unchanged) make money per trade after the bot's real costs at $2, counted in SOL?

## Data (free, keyless)

| Step | Script | Source | What |
|---|---|---|---|
| 1 | `01_migration_sigs.mjs` | public RPC `api.mainnet-beta.solana.com` | every signature on the pump.fun migration account `39azUYF…` from 2026-08-01 to the wall; only signatures before the wall are stored |
| 2 | `02_migrations.mjs 0.08` | public RPC | the successful migrations whose sha256(signature) falls below 0.08: a uniform 8% random sample of all graduations, chosen without looking at the coin (survivorship-free) |
| 2b | `02b_redecode.mjs` | public RPC | re-decodes 292 migrations where the first decode picked a trader's account (the migration transaction also carried buys); the pool is the owner holding the most of the coin |
| 3 | `03_activity.mjs` | public RPC | newest 1,000 signatures of each sampled pool: how busy it was in days 1–14 |
| 3b | `03_sol_usd.mjs` | GeckoTerminal | SOL/USD hourly (Raydium SOL/USDC) |
| 4 | `04_bars.mjs` | GeckoTerminal | hourly bars of each pool (U1 screen), then 5-minute bars over the hours it could be in U1 |
| 5 | `05_signals.py` | — | as-of signals every 5 minutes |
| 6 | `06_minute.mjs` | GeckoTerminal | 1-minute bars for each candidate entry, entry to +130 min |
| 7 | `07_sim.py` | — | trades with the bot's exits and costs |
| 8 | `08_report.py` | — | per-trial table, cluster bootstrap CI, deflated Sharpe, PBO |

Universe notes (all decided before any trade result, from counts only):
- 317 sampled migrations created USDC-quoted pools (no WSOL in the pool): outside U1, which is SOL-quoted.
- 1,677 created pools holding under 1 SOL (median about 0.2 SOL) next to about 207M tokens. To reach 100 SOL of quote
  their price would have to rise roughly 200,000-fold; the three busy ones spot-checked on GeckoTerminal hold $2–25
  today. They are treated as outside U1 (step 4 needs more than 1 SOL at migration).
- Busy-first and busy-only (step 4, `BUSY_ONLY`): after the first 408 pools, every pool with U1 hours and tradeable bars
  was "busy" (more than 1,000 signatures after day 14). From then on only busy pools were priced, plus a fixed audit
  subset (sha256 fraction < 0.008, 385 pools). Result of the audit: of 354 quiet audit pools, 4 had a U1 hour and none
  produced a single signal (too few trades for a 14-bar ATR). So skipping quiet pools lost no measurable trade.
- GeckoTerminal returned 404 for 7 pools (not indexed); they are missing.

Large files stay out of git (`data/` is a link to scratch space); `manifest.json` lists every data file with its
sha256 and size so a rerun can be compared byte for byte. GeckoTerminal results can change if it re-indexes, so a
rerun may differ slightly; the manifest pins what this report used.

## Holdout wall

The repo's research wall (`research/signals/window.json`, start of Melbourne day 2026-09-22) is respected: no bar that
ends after 2026-09-21T14:00Z is stored (every fetch passes `before_timestamp` below the wall and filters bar ends).
Step 1 pages through newer migration signatures (the RPC returns newest first) without storing them; no price or
outcome after the wall is read.

Inside the readable window this study keeps its own holdout: entries on Melbourne days 2026-09-12 to 09-21 (10 of 35
days, 28.6%). The screen uses 2026-08-17 to 09-11. `trials.json` (committed at 2e83460 before any screen result) fixes
the trials, the selection rule and the holdout verdict.

## Rules on candles (exploratory)

The pre-registered rules use transaction-level features (RES-3 tracker). Here they are measured on GeckoTerminal
candles, so this is an **exploratory screen**:

| Feature | Candle version | Exact? |
|---|---|---|
| f_dd | close / highest high since migration − 1 | yes (a candle high is the highest trade) |
| f_ret60 | close now / close as of 60 min ago − 1 | yes, to the 5-min grid |
| f_hl | low of the last 30 min (incl. the price 30 min ago) > low of the 30 min before | yes, to the grid |
| f_liqchg60 | √(p / p60) − 1 (constant-product quote reserve) | proxy (ignores fee growth and deposits) |
| f_net60 (H2) | 1 − √(p60 / p) (net SOL into a constant-product pool) | proxy |
| f_turn60 (H2) | SOL volume 60 min / quote proxy | proxy |
| f_sol24 (H6) | ln(SOL/USD now / 24 h ago), hourly closes | yes, to the hour |
| H3 range, volume, cap | 5-min highs, SOL volume, price × 1e9 | yes, to the grid |
| f_2side60 (H1, H2), f_indep60 (H2), holder growth (H3) | **not observable: left out**, so these rules are looser than registered | — |

The quote reserve is √(k·p) with k from the migration reserves; U1 needs ≥ 100 SOL. Universe B adds the bot's own U1
floor (H8, policy `u1FloorUsd` $50k of quote), which is what the bot would actually be allowed to trade.

Entries follow BT-2's code (`origin/claude/backtest-2`, `study.ts`): a feature rule's stop is 15% below the spot, H3's
is 1% below the 60-min low, and core `checkStopDistance` refuses the entry when the stop is more than 20% away or more
than 3 × ATR(14, 5-min bars, contiguous run, Wilder, as core `atr()`). Bars exist only where trades happened, as in the
worker. Risk sizing checks (`evaluateEntry`) are not run; size is always $2.

## Fills and costs

- Entry fills at the close of the next 1-minute bar after the signal (never the signal's wick).
- Exits are judged at each 1-minute bar end with core `decideExit`'s U1 block: price stop (bar low at or below the stop,
  filled at the lower of the stop and the next bar's open), negative flow (5 contiguous minutes each closing lower),
  time-flat (0.5 R not reached by 30 min, on closes), T_max 120 min, take-profit on closes (2 R or 10% of cost basis:
  half off, one partial at $2), then break-even and a trail of peak − 3 × ATR. Exits fill at the next bar's open.
- Costs: PumpSwap fee by market-cap tier on both legs (fee-configs snapshot of 2026-10-03), constant-product price impact
  at the real size, and edge.md's fixed costs: 414,009 lamports a position (network fees, expected failed exit
  attempts, expected rent loss), 149,784 more for each extra exit transaction. $2 is converted at that hour's SOL/USD;
  every result is in SOL.
- Not modelled: deployer-sell, quote failures and no-route exits; the 6-slot landing drift (the 1-minute fill delay is
  far longer); fee configs before the 2026-09-09 change (B3) are taken equal to the snapshot.

## Reproduce

```
cd research/edge-hunt-u1
node 01_migration_sigs.mjs 2026-07-19T00:00:00Z   # stopped once it passed 2026-08-01
node 02_migrations.mjs 0.08 && node 02b_redecode.mjs && node 03_activity.mjs && node 03_sol_usd.mjs && node 04_bars.mjs
python3 05_signals.py
python3 07_sim.py need --period screen --rules H1,H2,H3,H6,S0 && node 06_minute.mjs
python3 07_sim.py run --period screen --rules H1,H2,H3,H6,S0 --universe AB   # repeat with node 06_minute.mjs need_missing.json until 0 missing
python3 08_report.py screen && python3 09_cost_diag.py screen && python3 10_manifest.py
```
