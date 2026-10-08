# FUND-SPREAD: results

Run 2026-10-09 (Melbourne) on branch `ccr-7fae2302-drz4co`, PREREG frozen at c898f8df. Paper research only.

## Verdict: CLOSED at the gate (PREREG §4)
The design closed before any trade return was computed. `score.py score` never ran. Two of the four gate items failed:

| Gate item (§4) | Needed | Found | Result |
|---|---|---|---|
| Step 0: Binance funding in the public archive, times on settlement times | exists | 23 symbols; `calc_time` at most 47 ms past the hour, 0 rows off the 1 h, 4 h or 8 h grid | pass |
| Coins with at least 180 overlapping days | ≥ 10 | 20 | pass |
| Signal coin-days after the one-pair cap (executable) | ≥ 300 | **27** | **fail** |
| Coin-day windows where either venue moves ±50% within 72 h | ≤ 1% | **2.96%** (382 of 12,916) | **fail** |

- Excluded coins: USELESS (12 overlapping days), JELLY (0), YZY and LAUNCHCOIN (no Binance funding or klines).
- Entries per coin: ZEREBRO 7, kBONK 6, WIF 3, VINE 3, FARTCOIN 2, MELANIA 2, AI16Z 1, DOOD 1, GRIFFAIN 1, TRUMP 1, and 0 for the other 10.

## In plain words
- The idea was to collect the gap when one exchange's funding is much higher than the other's for the same coin.
- That gap almost never got big enough to pay for the trade. Across about 2.5 years and 20 coins, it crossed the cost line only 27 times, and the test needed at least 300.
- The coins also jump or crash 50% within three days about 3% of the time. That is too often for a trade meant to be "safe" carry: the limit was 1%.
- No return was ever looked at. There is nothing to trade here.

## Data (free, keyless, pre-wall only)
- Binance USDⓈ-M funding settlements and daily klines from data.binance.vision (`fetch_fs.py`). The SHA-256 of all 1,161 zips is in `bnfs_manifest.json` (file SHA-256 `26cb6f7c…`).
- Hyperliquid hourly `fundingHistory` and daily candles (`research/short-probe/fetch_hl.py`), with the squeeze funding cut. A daily candle counts only if it closed before 2026-09-21T14:00Z. The Hyperliquid file set hash is `208dd07f…` (SHA-256 over sorted names and file hashes; the files are kept outside the repo).
- Gate output: `gate.json`.

## Choices fixed before any return (also in `score.py`'s docstring)
- **s is evaluable** only with at least 23 Hyperliquid rows and at least 16 h of Binance settlements stamped in [D − 24 h, D).
- **Tail check** counts a window if either venue's high reaches 1.5× the day's open or its low reaches 0.5× within 72 h. A pair always holds one short leg and one long leg on the coin, so both directions count.
- **Gate entries** count only pairs whose price bars exist at entry and exit. This reads no return.

## Review
- One fresh review (opus) found 2 blocking and 2 should-fix items in the scorer. All were fixed in 22518e7 before the gate ran:
  - the funding settlement window;
  - the per-capital SOL-leg line must also pass;
  - funding coverage;
  - gate executability.
- Because the gate closed, none of the scoring-stage fixes affected the outcome.

## Not done
- The sign check (2026-09-22..10-20, after 10-21) has nothing to check, because the design closed.
- The venue and legal checks in §2 are not needed.
