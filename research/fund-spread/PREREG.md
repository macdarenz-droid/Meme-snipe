# FUND-SPREAD: a cross-venue funding gap, traded market-neutral (pre-registration)

Drafted 2026-10-08 23:54 (Melbourne) by the brainstorm partner. Agreed by the research lead ("AGREED FUND-SPREAD, cap 0 credits, spawner lead"). Source: `research/brainstorm-loop/COVERAGE_MAP.md`, idea 2. Nothing here was computed on market data. Chances are judgement.

## 1. Question
- When one venue's perp funding for a meme is persistently higher than another venue's for the same coin, does a pair beat staked SOL in SOL terms after all costs? The pair is short on the higher-funding venue and long on the lower one, 1x each, held up to 72 h.
- **Who pays:** leveraged traders on the more crowded venue, who pay more funding than the same position costs elsewhere.
- This is a carry trade, not sniping. Its capacity is small. Chance about 2%.

## 2. Venue the bot could actually use (owner and legal check)
- The data venues are Hyperliquid and Binance USDⓈ-M, because both publish free history.
- Whether the owner, an Australian retail customer, can trade Binance derivatives is UNVERIFIED. I believe Binance Australia stopped offering derivatives to retail around 2023, but I have not confirmed it.
- Whether Hyperliquid is legal for him is also UNVERIFIED.
- So a pass names the venue pair that was tested, and use needs the owner plus a legal check. If no usable pair exists for him, a pass is recorded as "not usable by this owner".

## 3. Data (0 credits; pre-wall only)
- **Step 0 (one keyless listing call):** confirm that Binance funding history exists in the public archive (`data/futures/um/monthly/fundingRate/`) and that its times match settlement times. If not, FUND-SPREAD closes as untestable.
- Hyperliquid hourly `fundingHistory` (`research/short-probe/fetch_hl.py`, with the squeeze PREREG's funding cut).
- Binance funding settlement rows, converted to a per-hour rate over each settlement interval (8 h, or 4 h or 1 h where the venue switched).
- Prices: Hyperliquid daily candles and Binance daily klines for both legs; SOLUSDT perp for the SOL leg.

## 4. Universe and gate (reads no return)
- Solana memes listed on both venues, from the squeeze PREREG's classification, with at least 180 overlapping days.
- **Gate:**
  - step 0 passes;
  - at least 10 coins;
  - at least 300 signal coin-days after a cap of one open pair per coin;
  - either leg moves 50% or more against its side within 72 h in at most 1% of all coin-day windows, measured on prices with no trade P&L.
  
  Any failure closes the design.

## 5. Signal and trade (fixed now)
- **Decision at 00:00 UTC each day:** s = mean Hyperliquid hourly funding over the trailing 24 h − the mean Binance per-hour funding over the trailing 24 h. Only rows settled before 00:00 count.
- **Enter if |s| × 72 ≥ 2 × the pair's round-trip cost.** That cost is 4 × 0.15% = 0.60% (0.05% fee + 0.10% slippage per side per venue leg, the short-probe rule), plus the SOL leg's 0.30%.
- **Positions:** short the venue with the higher funding and long the other, 1x each, at both venues' daily open.
- **Exit:** at the daily open 72 h later, or at the first 00:00 at which s changes sign, whichever comes first. One open pair per coin.
- **P&L in SOL:** the two price legs (their difference is the basis change), plus actual funding received minus paid on both legs, minus costs. Then convert to SOL with a SOL-perp leg equal to the collateral, as in the CONNECT_THE_DOTS P1 formula, paying its funding.
- **Liquidation stress:** a 1x short leg loses its collateral if its high reaches 1.714 × entry within the hold (short-probe rule).

## 6. Statistics and verdict (loop family, 0.005)
- **Primary:** mean net per pair in SOL, and its excess over staked SOL over the same hold (4.8% a year, `docs/research/edge.md` §7.2).
- Day-block bootstrap (10,000, seed 7) and day-clustered t at 99.5%. Both must show a lower bound above 0 for both quantities (intersection-union).
- **Pass also needs:** each date half positive, the 2× cost line positive, and no leg liquidated under the stress rule in more than 1% of pairs.
- **Unresolved:** fewer than 150 pairs. **Killed:** anything else short of a pass.
- **Honesty note:** Hyperliquid funding was already read by the short and squeeze probes, so a pass earns only forward paper trading.

## 7. What a pass earns
- Forward paper recording on both venues' free data, then the owner's decision, with the venue and legal checks in section 2.
