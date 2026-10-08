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

## Round 4, research lead

**Your question: yes.** The mechanism gates (A's bunching, C's venue count) read no returns, so they stay outside the k = 12 family. Only the return tests they release are counted, at 99.58%.

**A: agreed, with three changes.**
1. **Gate 1:** I will read the FeeConfig signature history myself now (a few Helius calls) and append the step's start date here.
2. **Make it about the creator.** Bunching alone can come from any trader. Add a co-gate on the same Step A swaps: net creator-wallet buying (the coin's creator as signer or owner) while the cap is within [399, 441), minus the same quantity at the placebo cutoffs. Both gates must pass, with a 95% lower bound above 0. Otherwise A closes before any return is read.
3. **Selection.** Only coins that reach about 400 SOL count, which is about 23% above a ~326 SOL open. State the expected number of such pools in two days before the tape is read. If it is under 200, A needs Step B's days, and the kill rule should say so up front rather than end as "too few".

**C: agreed as written.** Gate 0 (DLMM SOL pools with at least 50 SOL on the bid, for the 41 coins) uses free pool-list reads. I will run it. The bar re-download is approved only if Gate 0 passes.

**Your hazard finding is useful.** Fake volume costs about 4× less above 420. I will log it for the bot's volume filters.

**Two new angles in your spirit (rule-made, price-blind flows). Check them against the repo and say keep or drop:**
- **F. Protocol buybacks with a known rhythm.** The tape schema has a `buyback` fee part and a buyback authority (`GmFrDZT2…`). If a protocol buys a token on a fixed schedule or by a fixed rule, its timing is known in advance. Is that flow big enough relative to the pool, and is the pool cheap enough to trade?
- **G. Mayhem mode.** The tape schema flags `mayhem` coins. If a program trades those coins for a fixed time and then stops or unwinds, the end time is a known event. I have not verified how mayhem works; please check the repo first. If it is a scheduled, price-blind flow, what is the trade?

**Order:** A's Gate 1 (me, now), C's Gate 0 (me, now), then A's gates on Step A when the tape has it. Reply with F and G and any final changes; then we freeze "## Agreed designs".

## Round 5, partner

**A: I accept all three changes.**
- **Co-gate:** creator net buying uses the pool's `coin_creator` as signer or token owner. Wallets linked to the creator do not count; that keeps the gate strict and needs no linking rule.
- **Count rule, fixed now:**
  - `research/empirical/backfill/migrations.jsonl` holds 718 graduations in about 12 hours (10-01 23Z to 10-02 10Z). That is roughly 1,400 a day, but it is one window of about 12 hours, and September's rate may differ.
  - I did not compute how many reach 400 SOL, because that is an outcome.
  - Rule: if Step A gives fewer than 200 pools that trade within ±5% of 420, A waits for Step B's days, then Step C's. If there are still fewer than 200 after all tape days, A closes as unresolved. The 200 bar is never lowered.

**F (protocol buybacks with a known rhythm): drop as a new angle; it is idea 6.**
- `GmFrDZT2…` is the Tokenized-Agent buyback authority, already pre-registered in `research/buyback-probe/PREREG_DRAFT.md`. That draft says "no buyback schedule is assumed", and nothing in the repo shows a fixed rhythm.
- The `buyback_fee` in swaps is a share taken out of the protocol and creator fees, not an extra flow. `packages/backtest/test/pool-state.test.ts` books retained = protocol + creator − buyback.
- Idea 6 counts coins with as little as 1 SOL of buybacks in 7 days, which is small next to the pool.
- **Cheap add to idea 6's Stage 0** (counts only, no returns): the spread of the gaps between buybacks for each coin. If a coin's gaps are regular (coefficient of variation under 0.3, my judgement), a timing arm can be registered later.
- **Line to watch:** buying ahead of a public, rule-based buyback is not trading on anyone's private order (judgement). It sits close to the off-limits "front-running" label, though, so the owner should confirm it before any arm is built.

**G (mayhem mode): drop for now.**
- **What the repo knows:**
  - Mayhem is only a flag (`is_mayhem_mode`, `mayhem_mode_enabled` in `idl-pinned.json`).
  - Holder counts exclude a "mayhem vault" (`strategy/study.ts:800`).
  - The engine refuses to price mayhem coins (`core/src/amm/fees.ts:87`), and hard gate H5 rejects them.
  - No end time or schedule field is present in the pinned IDL.
- **Why that blocks it:**
  - I cannot verify how mayhem trades without pump.fun's docs, which are off limits.
  - The engine would need a new pricing model before any paper trade.
- **What reopens it:** a source we may read (for example pump's public IDL repository on GitHub) that shows a fixed end time.

**C:** unchanged.

**Question for the lead:** if you accept this round, shall I write "## Agreed designs" (A with its two gates and the count rule, and C with Gate 0), or do you want Gate 1's start date in it first?

## Lead's gate results (2026-10-08, no returns read)

**A, Gate 1: the 420 SOL creator step has been in force since 2025-09-02 at the latest.** I read every transaction of the FeeConfig admin (`FFWtrEQ4…`, a Squads vault; 6,490 signatures back to 2025-02-19). Eight touched the PumpSwap FeeConfig (`5PHirr8…`):
- 2025-08-28: UpdateAdmin.
- 2025-09-02 14:55Z: UpdateFeeConfig, then UpsertFeeTiers twice. This is the last change to the regular fee tiers.
- 2026-05-15: ExtendFeeConfig, UpdateStableFeeConfig and UpsertStableFeeTiers (stable tiers only).
- 2026-09-09 19:32Z: InitializeQuoteControl and SetQuoteControlAdmin. This is B3, and it did not change the tiers.

So the tape's days all carry today's tiers, and A can only be a cross-section, not a before/after. The step is about 13 months old and public, which lowers my prior a little. Caveat: I did not decode the 2025-09-02 arguments; this rests on no later UpsertFeeTiers plus the 10-03 snapshot.

**C, Gate 0: passes, barely.** DexScreener today lists a Meteora DLMM SOL pool for 23 of the 41 deep-pool coins. 12 hold at least 50 SOL on the SOL side, which in DLMM sits below the price as bids (rule: fewer than 10 closes C). Caveats: this is today's list, not history (survivorship); DexScreener's quote liquidity is the whole SOL side, not depth near the price; DLMM fee settings are not read yet. Raw replies are in the session scratch directory.

## Agreed designs

Frozen 2026-10-08 by the lead and the partner, before any return in either design is computed. Changes after this point are logged as amendments with a reason, never edited in place. The mechanism gates read no returns and sit outside the k = 12 family. Each return test counts in the family at 0.05/12 (99.58% intervals, with 95% shown beside them). Chances are judgement.

### Design A: creator fee step at 420 SOL (cross-section only)
- **Gate 1 result:** the step has been in force since 2025-09-02 at the latest (lead's read above), so there is no before/after comparison. Chance about 3%, lowered because the step is 13 months old and public.
- **Data:** the shared tape's swaps, with market cap = pool SOL reserve ÷ pool token reserve × 1B. Whether the fee program uses this same formula is unverified, and a mismatch is recorded as a limitation.
- **Pools:** canonical PumpSwap SOL pools of pump.fun graduates, not mayhem, in hours 0–72 after migration. Each swap's market cap holds until the next swap, or until hour 72.
- **Count rule:**
  - At least 200 pools must trade within ±5% of 420. If Step A falls short, Step B's days are added, then Step C's.
  - Still under 200 after all tape days means A closes as unresolved. The 200 bar is never lowered.
- **Gate 2 (bunching):** time-weighted share of pool time in [420, 441) ÷ the share in [399, 420), as a log ratio, minus the median of the same log ratio at 20 placebo cutoffs on a log grid from 340 to 1,300 SOL. Each placebo is more than 10% away from 420 and from 1,470. Interval: pool-clustered bootstrap.
- **Gate 3 (creator):**
  - Measure the coin creator's net SOL buying per hour inside [399, 441), counting only the pool's `coin_creator` as signer or token owner, with no linked wallets.
  - Subtract the median of the same measure in the ±5% bands around each placebo cutoff. Interval: pool-clustered bootstrap.
- **Rule:** both gates need a 95% lower bound above 0. Otherwise A closes and no return is read.
- **A pass earns** a return test, written and frozen here before it runs:
  - Entry on the first cross of 420 from below. The stop sits under 399.
  - The control is crosses at the placebo levels.
  - Costs in SOL at $50, with the young-pool toll (about 3.5%).
  - The test counts in the family.

### Design C: maker seat (resting bid) on the 12 Gate 0 coins
- **Gate 0 result:** passed with 12 of 41 coins. Each has a DLMM SOL pool holding at least 50 SOL on the SOL side (DexScreener, read 2026-10-08).
- **Gate 0 caveats:**
  - The list is today's, so it carries survivorship.
  - Liquidity is the whole SOL side, not depth near the price.
  - DLMM fee settings are unread.
  - The 12 mints are committed to `research/deep-pool-probe/` before any bar is downloaded.
- **Data:** GeckoTerminal 5-minute bars via `research/deep-pool-probe/fetch.py` (re-download approved). The study uses the deep-pool PREREG's dates, its wall (2026-09-21T14:00Z) and its discovery/validation split.
- **Proxy assumption:** a DLMM bid fills when arbitrage moves the DLMM pool in line with PumpSwap, so a PumpSwap low that trades through the bid stands in for a fill.
- **Rule:**
  - The bid is the previous bar's close × exp(−3σ), with σ as in MR-A (3 days, at least 500 bars with volume). It is renewed every bar.
  - A bid fills if the bar's low is at or under bid × 0.995, at the bid price.
  - One open position per pool, and at most one fill per pool per UTC day.
  - Exits are +6% / −4% / 30 min from the bid, as a PumpSwap taker. A stop fills at the lower of the stop level and that bar's close, and that includes the fill bar itself.
- **Costs:**
  - Entry: no fee and no impact, with the DLMM fee not credited.
  - Exit: the coin's PumpSwap tier fee plus impact from the deep-pool depth model, plus 0.001 SOL priority fee.
  - Size: $50, everything counted in SOL.
- **Primary statistic:** mean net return per fill in the validation period, judged by a day-bootstrap 99.58% interval.
- **Pass** (all three needed):
  - the lower bound is above 0;
  - the point lift over S0 is at least +0.45 points (S0: deep-pool random-bar taker entries with the same exits and costs, on the 12 coins);
  - there are at least 30 validation fills.
- **Outcomes short of a pass:**
  - Fewer than 30 fills means unresolved.
  - Anything else means not supported.
- **Secondary (not judged):** MR-A as a taker on the same bars, to show what the maker seat adds.
- **A pass earns** a forward paper log of resting bids, never live trading. Even a pass is far below the 300-trade funding gate.

### Further angles
None strong enough to add. The ones I considered:
- **Fee-claim timing by creators:** it predicts selling. That makes it a reject filter for the bot, not an edge.
- **The 1,470+ SOL creator-fee ladder steps:** each step is only 5 bps.
- **Placebo-level crosses as a momentum entry:** momentum already lost to random entries (deep-pool MOM-C).

## Round 6, partner 2 (owner's "Research brainstorming loop" session, summary; full text in that session)
- Correction to A: since BOOST (2026-07-21) a graduate prices on effective reserves (about 67.4 real + 17.6 virtual SOL), so it opens near 411 SOL cap, about 2% under 420, not 29%. A must use the effective quote and the supply after burns, and must exclude the BOOST buy-and-burn window.
- G1 "be the inventory the BOOST buys" (about 4–7%): buy on the bonding curve at 90% progress, hold through migration, sell after the landing delay to the protocol's fixed BOOST buy and to the opening snipers. Gate G1-0 (no returns): curves reaching 90% per day, time from 90% to migration, and BOOST timing.
- H1-CGO (about 2–4%): holders' cost basis and capital-gains overhang from the tape.

## Round 7, lead
- A amendments accepted (effective quote, supply after burns checked against the tier rule, BOOST window excluded).
- G1 AGREED (cap 0 credits, tape only, the lead spawns the worker). G1-0 and discovery run on Step A; validation runs on Step B, which G1-0 passing releases under the tape plan; intervals are clustered by day and pool, at 99.5% with a 300-trade floor. The partner drafts `research/g1-boost-inventory/PREREG.md` before any tape day exists.
- H1-CGO kept as a later tape design.
