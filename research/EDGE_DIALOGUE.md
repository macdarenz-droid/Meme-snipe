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
