# Edge dialogue: research lead and brainstorm partner (living document)

Started 2026-10-08 (Melbourne) at the owner's request: "You 2 talk or brainstorm each other. Discuss how can we come up with a profiting edge." Each turn is appended below, newest last. Chances are judgement, not measurements.

## Round 1, partner (first draft from an in-chat helper, moved here so the owner can read it)

**Blunt read**
- We tested many signals but one seat: the late taker paying the toll on every trade. The maker seat, which flips the toll's sign, was judged (edge §7.4, §8.2) but never measured.
- We model protocol rules as costs, not as incentives that move other traders. The creator's PumpSwap share jumps from 30 to 95 bps at a 420 SOL cap (`research/edge/snapshot/fee-configs.json`), and graduates open at about 411 SOL (partner's arithmetic, `pump-global.json`).
- The 300-trade gate fights the economics: frequent rules carry about a tenth of the toll, and big-edge events are "too rare". We should favour mechanisms that fire on many coins every day.
- All outcomes come from one meme bear phase (§8.1). The negative drift may belong to that regime (judgement).

**Angles**

| Angle | Chance (judgement) | Who pays us | Cheapest test | Kill |
|---|---|---|---|---|
| A. Creator-fee step at 420 SOL: an active creator earns 3× more per SOL of volume above it, so is paid to lift and defend the level | about 5–8% | the creator, from expected fees | (i) FeeConfig history: when the step began; (ii) hourly bars: time spent just above vs below 420, fee-sweeping vs idle creators, against placebo levels; (iii) tape: net creator-linked buying within ±5% of the step | no excess mass, or no net creator buying, before any return is read; survivors must beat the ~3.5% young-pool toll at $50 against idle-creator matches |
| B. Seller urgency and routing: forced stop-loss bursts (many unlinked wallets, default fees, one app, few slots) overshoot and revert | about 4–6% | retail stop-losses dumping into thin pools | tape: tag sells by fee and tip per SOL, terminal fee recipient and wallet links; forced-type bursts minus price-matched others | fewer than 30 forced-type bursts where the toll is 1% or less, or a lift below the median round trip |
| C. Maker seat, measured: a resting bid (one-sided Meteora DLMM liquidity) skips the ~0.9% toll, earns the fee and fills inside the drop | about 5% | impatient sellers | re-run the deep-pool dip data as resting bids (trade-through fills, entry at the limit, fee credited, same exits); a pass earns a tape test on the ~15 coins with DLMM pools | mean net 0 or less, or collapse fills erase the median; a new venue needs the owner |
| D. USD-anchor lag: memes trade only in SOL, but traders watch dollar caps | about 2% | slow, dollar-minded holders | Binance SOLUSDT minutes vs our deep-pool SOL bars, distributed lags, day-clustered, sign fixed on one half | response at the 95th-percentile SOL move under the ~0.7–0.9% round trip, or a sign flip |

Question: do the tape's days fall after B3 (09-09 19:30Z), possibly when the 420 SOL step began?

## Round 2, research lead

**Answer.** The tape's Step A days (09-10 and 09-11) fall after B3; Step B (09-07..09-09) straddles it. When the 420 SOL step began is unknown. The 10-03 snapshot (`amm.fee_tiers`) shows the creator at 30 bps and the protocol at 93 below 420 SOL, and the creator at 95 and the protocol at 5 from 420 SOL. The total stays about 1.2%, but the creator's share triples. Its start date needs the FeeConfig account's history.

**Critique**
- **A (strongest: it names a paid, price-blind buyer).**
  - Defending 420 costs the creator inventory risk on a falling coin, and most creators sell instead.
  - Bunching also comes from the 411 open and from drift through the level, so the placebo levels must sit at the same distance from 411.
  - Even with a defended floor, the ~3.5% young-pool toll is the barrier. The tradable form is "buy near 420 with a stop just under it", and it needs the defence to be visible on chain before entry.
  - Run (i) and (ii) first.
- **B.** Close to our deep-pool dip test (bounce +0.1–0.6% vs a 0.85–1.0% toll). The burst type must add at least about 0.5 points. Tape only, so it runs after Step A.
- **C (cheapest to falsify).** Doubts: adverse selection (a resting bid fills exactly when price trades through), a taker exit unless it is also a resting ask, unverified DLMM fees and depth, and only ~15 coins. Test: limit fills on 5-minute lows (fill only if the low is below the limit by at least one bin step), entry fee credited, taker exit; a second line with a maker exit.
- **D.** A fine free side check; low prior.

**Added for challenge**
- **E. Toll-to-volatility screen.** Is there any coin set (for example past the 98,240 SOL tier at 0.30%, or along the creator-fee ladder) where the bounce clears the toll? Probably not; one table from existing results settles it.
- **Regime.** Can older Binance archive data (2024–2026, listed memes) read the regime without spending the sealed holdout?

**Proposal to converge:** C first (free, existing data), then A(i)+(ii), D as a side run, and B after the tape's Step A. For each: the exact primary statistic, the data file, the kill rule and what a pass earns, all frozen before anything is computed.

## Round 3, partner

**Two corrections to round 1 (checked in repo files; no outcomes read)**
- **Graduates open near 326 SOL, not 411.** 411 SOL is the bonding curve's last price (`pump-global.json`). The PumpSwap pool opens lower: the median `mig_price_sol` × 1e9 is 325.8 SOL over 518 coins (`research/empirical/results/backfill_tokens.csv`), with about 67.4 SOL in the pool. So the 420 SOL step sits about 29% above the open, not 2%. This assumes FeeConfig's "market cap" means price × 1B supply, which I have not verified in the program code.
- **"About 15 DLMM coins" was a misread.** `research/squeeze-probe/SCOUT.md` says 15 Hyperliquid meme perps are in the cheap-venue universe. Only TRUMP, MELANIA and YZY trade mainly on Meteora DLMM, and those pools are against USDC. Nothing in the repo shows a DLMM SOL pool for the 41 deep-pool coins.
- **Side finding for the bot (a hazard, not an edge):** above 420 SOL, a creator who trades with themselves pays 1.20% and gets back 0.95%, a net cost of 0.25% per SOL of volume; below 420 the net cost is 0.95%. Fake volume becomes about 4× cheaper above the step, so volume-based filters should not trust volume that jumps just after a coin crosses 420. This is arithmetic from `fee-configs.json`; I have not measured whether creators actually do it.

**Kept: A (creator step), sharpened.** Chance about 4% (judgement).
- *Gate 1, free:* the FeeConfig (`5PHirr8…`) signature history gives the step's start date. A start date inside the tape's window allows a before/after test; one outside it allows only a cross-section.
- *Primary statistic:* time-weighted share of pool time with market cap in [420, 441) divided by the share in [399, 420), as a log ratio, minus the median of the same log ratio at 20 placebo cutoffs on a log grid from 340 to 1,300 SOL (each more than 10% away from 420 and 1,470). Pools are pump.fun graduates in hours 0–72 after migration. Interval: pool-clustered bootstrap.
- *Data:* the shared tape's Step A swaps (09-10, 09-11), with market cap computed from pool reserves at each swap. No new download.
- *Kill:* 95% lower bound ≤ 0, or fewer than 200 pools that ever trade within ±5% of 420.
- *A pass earns* only a frozen return test (enter on the first cross from below, stop at 399, compared with crosses at the placebo levels). That return test joins the k = 12 family; the gate does not.

**Kept: C (maker seat), with a venue gate first.** Chance about 3% (judgement; lower than before because no venue is known yet).
- *Gate 0, free reads:* count the 41 deep-pool coins that have a Meteora DLMM SOL pool with at least 50 SOL on the bid side. Fewer than 10 coins closes C before any bar is fetched.
- *Primary statistic:* validation-period mean net return per filled bid, in SOL, at $50. The bid sits at the prior 5-minute close × (1 − 3σ), using MR-A's σ. It fills only if the bar's low is at least 0.5% under the bid (judgement standing in for bin step plus fee). Fill price is the bid, with no maker fee credited. The exit is MR-A's (+6/−4/30 min) as a taker on PumpSwap.
- *Data:* GeckoTerminal 5-minute bars via `deep-pool-probe/fetch.py`. Raw candles are not in this container, so this is a re-download and needs the lead's OK.
- *Kill:* mean net ≤ 0, or a lift over S0 below +0.45 points (half the toll).
- *A pass earns* a forward paper log of resting bids. It never trades live.

**Parked: B.** It needs the tape's Step B and adds about 0.5 points at best (judgement). It keeps round 1's kill rule.

**Dropped:**
- *D:* profit is counted in SOL, so a dollar-anchor lag is a weak driver, and its prior is about 2%.
- *E:* it is already answered. The deep-pool 0.30% tier was the closest case at −0.17% (CI −0.71 to +0.32), and anything picked from viewed results is in-sample.
- *Regime from Binance memes:* hot-market timing already failed, and listed memes are not pump.fun pools. Low value.

**Question for the lead:** do you agree that the mechanism gates (A's bunching, C's venue count) stay outside the k = 12 family, with only their later return tests counted?
