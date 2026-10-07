# Cheap-venue probe: rules fixed before any return is computed

Exploration, not proof (owner question 2026-10-07: "Quick dips and breakouts (5-minute) lost after fees - can we work around it?"). Written and pushed before any 5-minute candle was downloaded or any return computed. Nothing here enters the bot, the registered attempt 1 or any holdout. Changing a rule after this commit is a new trial and must be reported as one.

## Question
The deep-pool probe (`research/deep-pool-probe/`) found a small bounce after sharp 5-minute drops in established pump.fun coins (about +0.1% to +0.6% gross), smaller than the 0.85–1.0% round trip in PumpSwap's 0.30–0.55% tiers. Do the same rules beat all costs, in SOL, on large Solana meme coins traded in their cheapest deep pools (fee tier ≤ 0.30% on Raydium or Orca), where a round trip costs about 0.3–0.65%?

## Universe (fixed now; built before any 5-minute bar is downloaded)
1. Candidate tokens: the non-SOL side of every pool in GeckoTerminal's public listings `/networks/solana/dexes/{dex}/pools` for dex ids `raydium`, `raydium-clmm`, `orca`, `meteora`, `meteora-damm-v2`, sorted by 24 h volume and by 24 h transactions, pages 1–10 each (fetched 2026-10-07), that is paired with wrapped SOL and has `reserve_in_usd` ≥ $250,000; plus the 41 coins of the deep-pool probe's primary group (seeds). For each candidate, GeckoTerminal token info and its first page of pools (`/tokens/{mint}/pools`).
2. Pools considered: paired with wrapped SOL (profit is counted in SOL and the bot holds SOL; a USDC pool would add a SOL→USDC swap), `reserve_in_usd` ≥ $250,000 on 2026-10-07, on Raydium AMM v4, Raydium CPMM, Raydium CLMM or Orca Whirlpool, with a **static, verified** fee ≤ 0.30%:
   - Raydium: `feeRate` from `api-v3.raydium.io/pools/info/ids`.
   - Orca Whirlpool: `fee_rate` read on chain (u16 at byte 45 of the pool account, hundredths of a basis point; layout checked on 2026-10-07 against the WIF/SOL 0.04% and 1% pools). A pool whose fee-tier seed (bytes 43–44) differs from its tick spacing is an adaptive-fee pool and is excluded.
   - Meteora (DLMM and DAMM): excluded. DLMM adds a variable fee that rises with volatility, so the fee paid on a dip is not the base tier and cannot be known from candles; Meteora's fee APIs returned 404 on 2026-10-07, so no static fee could be verified. A rule that counted only the base fee would understate costs exactly when the rules trade.
3. Meme filter: a token is excluded if it is a stablecoin, a liquid-staking or wrapped asset, a tokenized stock or real-world asset, or a protocol/utility token (exchange, DeFi, infrastructure, launchpad, wallet or governance token). The judgement uses the token's GeckoTerminal name, symbol, categories and description only, never prices, and each exclusion is written with its reason into `universe.json` before any 5-minute bar is downloaded.
4. One pool per token: the lowest fee among its qualifying pools; ties go to the larger `reserve_in_usd`.
5. Known biases, stated now: the list holds coins alive and deep **today** (survivorship, which favours dip-buying, so a null is stronger than a positive); liquidity is today's, not July's; coins that died or were delisted are included only where they still appear (the 41 deep-pool seeds and any delisted coin still listed); a pool created after a decision date simply has no bars then.

## Data (pre-wall only)
GeckoTerminal public API (keyless, about 6.5 s between calls), pool OHLCV `minute`, aggregate 5, priced in SOL (`currency=token`, the meme side as `token`), `before_timestamp` at the wall. Only bars that END at or before 2026-09-21T14:00:00Z are used. GeckoTerminal omits no-trade bars and sets each open to the previous close; missing bars mean no trades (close carried, volume 0), carried to the last bar ending at or before the wall. Downloads stay outside the repo; per-pool SHA-256 hashes go into `results.json`.

## Period
Decisions from 2026-07-22T00:00Z (3-day look-back from 2026-07-19). **Discovery: 2026-07-22 to 2026-08-20** (entries before 2026-08-21T00:00Z). **Validation: 2026-08-21T00:00Z to the wall.** A trade belongs to the period of its entry bar; it must exit at or before the wall.

## Rules (copied unchanged from the deep-pool probe, five configurations)
Entry at the open of the bar after the signal bar. One open position per pool, at most one entry per pool per UTC day. Inside a bar the stop is checked before the target; a bar that opens beyond the stop fills at its open; the target fills at its level. Time exit at the close of the last bar.
- MR-A: 5-min log return ≤ −3 × the standard deviation of 5-min log returns over the previous 3 days (at least 500 bars). Target +6%, stop −4%, time 30 min.
- MR-A-LV: MR-A, and the signal bar's volume ≤ 2 × the median 5-min volume of the previous 3 days.
- MR-B: 15-min log return (3 bars) ≤ −3 × the standard deviation of overlapping 15-min log returns over the previous 3 days. Target +8%, stop −5%, time 60 min.
- MR-B-LV: MR-B, and the 3 bars' volume ≤ 2 × the median 3-bar volume of the previous 3 days.
- MOM-C: 60-min log return (12 bars) ≥ +3 × the standard deviation of overlapping 60-min log returns over the previous 3 days, and its volume ≥ 2 × the median 12-bar volume. Target +8%, stop −4%, time 120 min.
- A signal bar must have volume > 0.

Execution delay, copied unchanged from the deep-pool amendment, reported beside every result as the **realistic** line (not used by the verdict): entry at the close of the first bar with volume among the 3 bars after the signal bar (else no trade), holding window after it; a stop fills at the lower of the stop level and that bar's close; the 500-bar minimum counts only bars with volume.

## Random-entry benchmark (matched by pool and hour)
For each rule trade, 10 random entries (seeds 0–9, SHA-256 of seed, pool and trade time) in the **same pool**, at a uniformly drawn 5-minute bar inside the **same UTC hour of day**, on a uniformly drawn other UTC day of the same period on which the pool has the 3-day look-back; same exits, same costs, same execution line. Rule minus random, per trade: the trade's net minus the mean net of its matched random entries.

## Costs per round trip, as a fraction of the trade, in SOL
At trade size Q = $200 (primary) and $1,000, q = Q / 119.26 SOL (the repo's SOL price, as in the deep-pool and lottery probes):
- Venue fee: 2 × the pool's fee tier.
- Price impact: 2 × Q / R, with R = `reserve_in_usd` / 2 (the SOL side of a constant-product pool, today's depth). For Raydium AMM v4 and CPMM this is the constant-product impact. **For concentrated-liquidity pools (Raydium CLMM, Orca Whirlpool) depth near the price is approximated** by a full-range constant-product pool of the same total value; real near-price depth can be larger (liquidity in range) or smaller (out of range) and was not measured as of each trade.
- Network and fixed costs: `FIXED` from `research/lottery-probe/lottery.py` = 414,009 lamports per round trip, charged as FIXED / q.
- net = gross − 2 × fee − 2 × Q / R − FIXED / q (additive, as in the deep-pool probe).
- **Stress line**: net − 1 percentage point per round trip.

## Statistics and verdict (fixed)
Per configuration, period, execution line and size: trades, pools, days, mean and median net, win rate, mean gross, mean stress, 95% and 99% intervals of the mean by day-block bootstrap (5,000 resamples of UTC days, seed 7), a day-cluster t-interval beside it, the matched-random mean, and rule minus random with its 95% day-block bootstrap interval.

A configuration is **promising** only if, at $200 on the registered execution line, **all** hold:
1. validation mean net > 0 and its 99% bootstrap lower bound > 0;
2. validation rule minus random: 95% bootstrap lower bound > 0;
3. discovery mean net > 0;
4. validation stress mean > 0.

Otherwise **not supported**. Five configurations are tested; the 99% bound is the multiple-testing guard. Even "promising" is only a reason to register a proper test on a never-run window with dead coins included, never a reason to trade.
