# CROWD-BREAK-SHORT: crowded longs breaking down, shorted on the perp (pre-registration)

Drafted 2026-10-09 (Melbourne) by the brainstorm partner. Agreed by the research lead ("AGREED CROWD-BREAK-SHORT, cap 0 credits, spawner lead"). Source: the coverage map's completeness critic (`research/brainstorm-loop/COVERAGE_MAP.md`, idea 1). Nothing here was computed on market data. The rules mirror `research/squeeze-probe/PREREG.md` (H1) with the sign reversed, and its H1-PERP block (`research/CONNECT_THE_DOTS.md` P1) for execution and costs. Changes after a reviewer signs it are logged as dated amendments. Chances are judgement.

## 1. Question and prior
- **Setup:** Hyperliquid funding is unusually HIGH (longs crowded and paying) and Binance open interest is unusually high. Then the coin breaks its 6-hour low against SOL.
- **Question:** does a 1x short of the coin's perp, held 6 hours and counted in SOL:
  - make money after all costs and funding, and
  - beat matched ordinary breakdowns of the same coin?
- **Who pays:** crowded leveraged longs forced out on the breakdown. They also pay us funding while we hold.
- **Prior:**
  - High carry predicts crashes (Schmeling, Schrimpf & Todorov, BIS WP 1087, 2023, as cited in the squeeze PREREG).
  - The programme's only lift whose interval cleared 0 was the mirror case: squeeze arm A, +0.39 points.
  - Short-probe S2 (short downtrends, price only) added nothing over shorting everything.
  - Chance about 2–3%.
- **Honesty note:** these coins' prices, OI and funding were already read by the short, trend and squeeze probes. This condition (funding high + OI high + breakdown) was not computed, but the data is not fresh. So a pass earns only forward paper trading and the sign check below, never a claim of proof.

## 2. Data (0 credits; pre-wall only, nothing at or after 2026-09-21T14:00Z)
- **Funding:** Hyperliquid `fundingHistory`, hourly (`research/short-probe/fetch_hl.py`), with the squeeze PREREG's funding cut. It is known from the row's actual `time`.
- **Open interest:** Binance USDⓈ-M archive `data/futures/um/daily/metrics/{SYM}USDT/`, `sum_open_interest`. The value at t is the latest row with `create_time` ≤ t − 300 s, no older than 1 h.
- **Signal price:** Binance 5-minute klines of the coin divided by SOLUSDT of the same bar, using the squeeze PREREG's fixed spot or perp source per coin. A bar opening at o is known at T = o + 300 s.
- **Execution price:** Binance USDⓈ-M 1-minute klines of the coin perp and of SOLUSDT perp. Basis to Hyperliquid is stressed on the roughly 17 days of Hyperliquid 5-minute data (H1-PERP).

## 3. Universe
- The squeeze PREREG's classified Solana-meme perp list (24 names). A coin is kept if its Binance OI overlaps its Hyperliquid funding and it has a Binance signal series and Binance perp 1-minute klines.
- No Solana pool is needed. Excluded coins are listed with their reason.
- **Gate (reads no return):**
  - at least 10 coins with at least 600 h of overlap;
  - median funding at event hours above 0;
  - an OI-only mechanism check: OI falls 5% or more by T + 6 h more often after events than after their C1 controls, with a one-sided 95% lower bound above 0.
  
  If any fails, the design closes before any price after T is read.

## 4. Definitions (hours h are UTC; every input as of the decision time)
- **F+ at hour h:** the funding row stamped in [h, h + 1 h) is higher than at least 90% of the coin's previous 720 hourly rows, with at least 600 present. Ranks are strict.
- **O at hour h:** OI as of h − 300 s is higher than at least 90% of the as-of OI at the previous 720 hour marks, with at least 600 present.
- **S+ at hour h:** F+ and O together.
- **Breakdown bar:** a completed 5-minute coin/SOL bar whose close is below the lowest of the previous 72 closes, all present and contiguous. T = open + 300 s.
- **Event:** the first breakdown bar opening in [h, h + 1 h) of an hour with S+, with T at or after hour h's funding row time.
  - At most one per coin per UTC day.
  - T must be at least the previous event's T + 6 h.
  - T + 67 s + 6 h ≤ the wall.
- **Two stages:** stage 1 freezes the event and control tables, with SHA-256, before any price after T is read.

## 5. Trade
- **Entry:** short 1x at the first 1-minute open at or after T + 7 s. Robustness lines at T + 60 s and T + 120 s.
- **Exit:** at entry + 6 h. No stop, no target. A delisted perp is marked at settlement.
- **Return in SOL:** (1 − r_meme + f − c) / (1 + r_SOL) − 1.
  - f is the actual Hyperliquid funding received or paid by the short over the hold.
  - c includes the SOL-perp round trip that keeps the USDC collateral SOL-neutral (H1-PERP's formula with the sign reversed).
- **Costs:** base 0.60%, stress at 2×, and a low line with the SOL-leg fees only.
- **Liquidation stress line:** if the 1-minute high reaches 1.714 × entry within the hold, the trade loses its whole collateral (the short-probe rule for 1x on a 3x-max perp).
- **Sizes:** $5, $20, $50 (primary), $100, $1,000 and $10,000. Impact above about $500 is unmeasured. Hyperliquid's $10 minimum order is from third-party docs (UNVERIFIED).

## 6. Controls
- **C1, decisive:** ordinary breakdowns of the same coin, with T′ within ±30 days, on UTC days where F+ and O were evaluable at all 24 hours and neither was true at any hour.
  - Exact match on b6, the number of breakdown bars among the previous 72 (0, 1–2, 3+).
  - The 10 nearest by standardised distance on r24, m24, vol6 and hour of day, as in the squeeze PREREG.
  - Ties are broken by SHA-256 of ("CBS-v1", event id, candidate id). At most one control per coin-day.
- **C2:** 5 random entries on the same coin within ±30 days, under the same rules.

## 7. Statistics and verdict (loop family, 0.005)
- d_i = n_i − mean(C1 of i).
- Intervals: a day-block bootstrap (10,000, seed 7) and a day-clustered t, both at 99.5%. Both must pass (intersection-union) for mean n and mean d.
- **Unresolved:** fewer than 150 executable events with a C1 set, or fewer than 100 distinct days.
- **Killed:** mean n ≤ 0, mean d ≤ 0, or d below the 0.60% round trip.
- **Pass:** all of these:
  - both lower bounds above 0;
  - mean n and mean d above 0 in each half (split at the median entry date);
  - the T + 60 s line's mean n above 0;
  - the 2× cost line and the liquidation line above 0.
- The owner's 300-trade proof standard is not met by these counts. Report n against it.
- **Sign check:** 2026-09-22..10-20 is read only after 10-21, as a sign check.

## 8. What a pass earns
- Forward paper recording on free Hyperliquid and Binance data, then the owner's decision.
- Live use needs the owner: perps, a non-Solana signing key and collateral, shorts. Whether this is legal for him in Australia is UNVERIFIED and needs a legal check.
