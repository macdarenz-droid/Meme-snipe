# Connect the dots: every idea combined

2026-10-08 (Melbourne). Designs only; no download or outcome computed. Numbers cite files; "judgement" marks opinion. Branch `ccr-7fae2302-drz4co` at `a7600c87`.

**Bottom line.** No combination points to an edge. Three earn a cheap, fair test; the judges give each about 3–5%, and each will most likely end "killed" or "unresolved".

## 1. What we combined and how

We mixed every idea on `research/IDEA_BOARD.md` with 11 probes' results four ways: (A) stack the runner's loss-reducers; (B) chain information sources so each covers another's weakness; (C) on-chain information traded on Hyperliquid perps; (D) interactions in rare events.

The limit: public signals add about a tenth of the toll and drift is negative (`docs/research/edge.md` §10.1), so stacking them cannot flip a loss. Only new information (who sold, bought or was forced to trade), a cheaper venue or a longer horizon could.

Three judges scored each 0–10; a checker verified files, chose survivors.

## 2. All combinations, judges' mean scores

Survivors in bold; lower overfit is better. Score = mean of the other four columns and (10 − overfit), my arithmetic.

| # | Combination | Evid. | New | Testable | Toll | Overfit | Score |
|---|---|---|---|---|---|---|---|
| 1 | A-FULL: hybrid stop, hot gate, paid reject | 2.0 | 1.7 | 5.0 | 1.0 | 8.3 | 2.27 |
| 2 | A-TAILSAFE: hybrid stop, hot gate | 2.0 | 1.7 | 5.3 | 1.0 | 6.3 | 2.73 |
| 3 | A-ABS: absorption, hybrid exit | 1.0 | 2.7 | 2.7 | 2.3 | 4.7 | 2.80 |
| 4 | Chain 1: absorption, unpaid | 1.3 | 4.3 | 3.0 | 2.3 | 5.7 | 3.07 |
| 5 | Chain 2: squeeze, spot breadth | 1.3 | 5.3 | 4.0 | 3.0 | 5.3 | 3.67 |
| 6 | Chain 3: unabsorbed seller, perp short | 1.0 | 5.7 | 2.7 | 3.0 | 5.0 | 3.47 |
| 7 | Chain 4: unpaid, hot, Test 1 coins | 2.0 | 1.3 | 5.3 | 1.0 | 7.0 | 2.53 |
| 8 | **C1: squeeze on the perp** | 1.7 | 4.7 | 6.7 | 4.0 | 4.0 | **4.60** |
| 9 | C2: seller fate on the perp | 1.0 | 6.3 | 2.7 | 2.3 | 5.0 | 3.47 |
| 10 | C3: on-chain heat, perp basket | 1.3 | 5.3 | 3.0 | 3.0 | 6.0 | 3.33 |
| 11 | C4: exchange-deposit lead | 0.3 | 8.0 | 1.3 | 2.7 | 4.7 | 3.53 |
| 12 | Lonely crowded short | 1.3 | 3.3 | 5.0 | 2.3 | 6.3 | 3.13 |
| 13 | **Cleared overhang, absorbed** | 1.0 | 5.3 | 3.0 | 2.3 | 5.7 | **3.20** |
| 14 | **Liquidated, not dying** | 2.0 | 5.7 | 4.7 | 3.7 | 6.0 | **4.00** |

Survival rests on blindness, a fair sample and error cost, not the score; hence #13 survives and #5, #6, #9, #11 do not (§5).

## 3. Survivors

### S1. Squeeze on the perp
**Mechanism.** Forced short covering, traded where it happens at a lower toll; no new signal.

**Evidence.**
- 238 frozen events on 195 days over 13 coins (squeeze `PREREG.md` item 19).
- The spot primary is UNRESOLVED because the reserve check failed 10 of 191 (item 20).
- Analog breakouts added +0.13 / +0.00 over random (`research/cheap-venue-probe/RESULTS.md` lines 19–20).
- Prior: crowded shorts are usually right (Desai 2002, PREREG).

**Toll.**
- Meme perp 0.12–0.35% plus 0.09% in SOL-leg fees; slippage unmeasured (edge §10.5).
- Under the repo's perp rule (0.05% fee + 0.10% slippage a side, `research/short-probe/PREREG.md` line 18), both legs cost 0.60%, $0.30 at $50. That is close to spot's 0.65% (§6.4).
- The detectable lift is 1.4–1.8 points (PREREG, Power), at least 10× the analog's.

### S2. Liquidated, not dying
**Mechanism.** A crash from holders cashing out should recover; one from insiders leaving should not.

**Evidence** (`research/daily-probe/RESULTS.md`).
- D-REV3: +6.7% (n 187) and +3.6% (n 93), CI −25.6 to +24.5, median −11.2.
- Only 1 of 33 random coins that reached size is on the survivor list, and the one random-sample trade lost 72%.
- Seller identity has never been examined.

**Toll.**
- 0.75–2.18% at $50 (§6.4), $0.38–1.09.
- With 3-day drift (S0 −2.3% / −5.1%), the hurdle is about 3–7 points.
- The gate needs a true mean of +8% to +16% (`research/hype/RESEARCH.md` line 39).

### S3. Cleared overhang, absorbed
**Mechanism.** A fully exited seller has nothing left to sell; broad independent buying argues against an informed seller (`research/absorption-probe/HYPOTHESIS.md`).

**Evidence.**
- No outcome yet.
- 0 of 20 full-exit sellers moved the price 3% (`research/squeeze-probe/SCOUT.md` line 138).
- A 10% extraction takes a constant-product price to 0.81x, so entry follows a +23% rebound: momentum-like, and momentum lost to random (−1.68% vs −1.29%, `research/deep-pool-probe/RESULTS.md` line 16).

**Toll.**
- At most 1.5% ($0.75).
- A 14-day hold faces −11.3% per 7 days of drift (daily RESULTS).
- SE about 9 points at 30 events: only lifts near 25 points are visible (arithmetic).

## 4. Frozen pre-registrations

### P1. H1-PERP (new trial; amendment to `research/squeeze-probe/PREREG.md`)
- **When:** commit and log the hash before H1-T2 reads any pool price and before any post-T Binance bar is used for a return. If not, the trial is exploratory and only forward data counts.
- **Data:**
  - frozen `stage1.json` (SHA-256 `7d1a0abd…`);
  - Binance USDⓈ-M 1-minute klines (free archive) for the 13 coins and SOLUSDT;
  - Hyperliquid hourly funding (`research/short-probe/fetch_hl.py`).
- **Universe:** the 13 stage-1 coins (`datachecks.json`); missing perp data means non-executable, counted; the 7 no-pool coins (item 2) are descriptive only.
- **Signal:** the frozen events exactly: F, O and the breakout at T = bar open + 300 s, with as-of funding and OI (items 4–8).
- **Controls:** frozen C1 lists (10, item 9) and C2 (5 random); entry data alone decides executability.
- **Entry:** the first 1-minute open at or after T + 7 s (T + 120 s line), 1x long. **Exit:** at entry + 6 h, no stop. Delisted perps are marked at settlement.
- **Return in SOL:** (1 + r_meme + f − c)/(1 + r_SOL) − 1. c includes the SOL-perp round trip that keeps the USDC collateral SOL-neutral; f is actual funding on both legs.
- **Costs:** base 0.60%, stress 2×, a low line with SOL-leg fees only, and a basis stress measured on the ~17 days of Hyperliquid 5-minute data (SCOUT line 7).
- **Sizes:** $5, $20, **$50**, $100, $1,000, $10,000. Impact above about $500 is unmeasured (judgement).
- **Statistics:** d_i = n_i − mean(C1). Day-block bootstrap (10,000, seed 7) and day-clustered t; both must pass (item 18), at 99.58%. Primary: mean n and mean d, intersection-union.
- **Verdict:**
  - Unresolved: fewer than 150 events or 100 days.
  - Killed: mean n ≤ 0 (all executable), mean d ≤ 0, or d below 0.60%.
  - Promising: both lower bounds above 0, positive in each half, and the 120 s and stress lines positive.
- **Sample:**
  - all frozen events, with 07-22..09-21 also shown alone (already viewed);
  - arm A's 749 sealed events are not read beyond primary events;
  - 2026-09-22..10-20 only after 10-21, as a sign check (about 7 events: 238 over ~34 months).
- **A pass earns** only a paper recorder and an owner decision on perps (edge §10.5: derivatives, Australian legality).

### P2. D-SPLIT (in `research/daily-probe/PREREG.md`)
- **When:** before the full survivorship-free re-run is scored and before any Helius read. The 65-coin partial check read no seller data (RESULTS lines 32–38).
- **Data:**
  - the registered survivorship-free universe (16,367 + 481);
  - Helius `getTransactionsForAddress` over each signal pool's D−1, plus its last transaction by the end of D−2;
  - liquidation `stage1.py` seller tests (F11–F17);
  - a capped 20-signal pilot first (edge §10.4).
- **Eligibility:** as the daily PREREG; any list filter using life after D−1 ("traded 9+ days", RESULTS line 30) gets a counted bias line.
- **Signal** (data before D 00:00 UTC):
  1. r1 ≤ −0.25 (log).
  2. At least 50% of D−1's gross sell SOL comes from clean full exits (at most 10% left, F13; proceeds, F12). Not counted as clean: the creator (F17), creation-slot buyers, wallets funded one hop from the creator (`funding.py`), bots (F15) and wallets under 7 days old (F16). Transfers count as "unknown", in the denominator only.
  3. √(x_eff·y) at the end of D−1 is at least 0.80 × its value at the end of D−2 (swaps never lower it). This is the editor's fix: a plain 80% reserve test would reject every fall beyond about 36%.
  4. Calm: the median eligible r1 is above its trailing 60-day 33rd percentile.
- **Controls:** the volatility-matched S0 (amendment 2); "dying" signals (failing test 2 through insiders, or test 3); non-calm signals.
- **Entry:** the pool state at D 00:10 UTC, constant-product fill. **Exit:** the D+2 close.
- **Costs:** the daily formula plus the exact-exit line (amendment 3), stress −1 point, in SOL.
- **Sizes:** $5, $20, **$50**, $200, $1,000, $10,000.
- **Statistics:** 3-day batch t (amendment 1) and a day-block bootstrap, the wider, at 99.58%. Primary: Δ = mean(net − S0vm) over the combo minus the same over D-REV signals failing test 2 or 3, intersection-union with combo net > 0.
- **Verdict:**
  - Unresolved: fewer than 100 signals or 30 days, or any coin above 30%.
  - Killed: net ≤ 0, Δ ≤ 0, or Δ below the median $50 round trip (`research/SHARED_TAPE_PLAN.md` line 183).
- **Sample:**
  - June–September on the survivorship-free list (the split is blind there);
  - confirmation by forward paper or a blind 2026-04-11..05-31 fetch (that range is leaving the 180-day reach);
  - not the sealed window (1–7 A+B signals a month);
  - Test 1 coins are too few (3 of 900 random coins were ever eligible), descriptive only.

### P3. ABS-S1 (fixed-sequence secondary in absorption's PREREG, not yet written)
- **When:** before `outcome.py` runs; tested at absorption's alpha only if absorption's primary (A beats B, A net > 0) rejects, otherwise descriptive.
- **Data:** absorption's frozen tables (`events.py` A and C; B from `assemble.py`, 3 per A), 2026-07-22 to the wall. The PREREG must name the coin list behind `screen.py`'s `gt_daily`, which is not recorded; survivorship-free preferred.
- **Signal** (as of the A trigger):
  1. Group A under the frozen constants: AGE_MIN 24 h, COST_MAX 1.5%, EXTRACT 10% within 300 s, recovery within 3,600 s, 5 or more groups at MIN_BUY 0.1 SOL, MAX_SHARE 0.40, RES_KEEP 0.80.
  2. The seller fully exits (F13) with proceeds (F12), and is not the creator, a bot, or under 7 days old. Later transfers never relabel.
  3. The real quote vault is at least 0.80 × its pre-sale level (edge §7.3).
  4. m60 (F20) is above its trailing 30-day 33rd percentile.
- **Controls:** B is also matched on the rebound from the low.
- **Entry:** absorption's frozen swap-level entry (LAT 2–10 slots), $50. **Exit:** frozen R1 (`outcome.py`).
- **Costs:** real reserves plus 414,009 lamports, in SOL.
- **Sizes:** $5, $20, **$50**, $200, $1,000.
- **Statistics:** `stats.py` day-cluster t and day bootstrap, the wider. Primary: Λ = mean(n − b̄) over the combo minus the same over A events that pass tests 3–4 but fail test 2, intersection-union with combo net > 0.
- **Verdict:**
  - Unresolved: fewer than 30 events (N_MIN) or 15 days, or any coin above 30%.
  - Killed: net ≤ 0, Λ ≤ 0, or Λ below the median $50 round trip.
  - Descriptive only: k ≥ 2, cost ≤ 1%, hot strata, PAID, real-time stop.
- **Sample:**
  - absorption's windows (identity never viewed);
  - confirmation on Test 1 coins outside its scan after Test 1 reports (likely few: 33 of 588 graduates ever reached 9,820 SOL), or forward paper;
  - never the sealed window.

### Family-wide error control
- **Membership:** add a "Reviewer family" section to `research/IDEA_BOARD.md`. It is missing; P6 requires it (`SHARED_TAPE_PLAN.md` lines 44–48). k = 12: P6's ten members plus P1 and P2.
- **Level:** each primary is tested at 0.05/12 = 0.0042 (99.58%), with 95% shown beside it. Weighted Bonferroni; Holm only after all 12 report; no alpha is passed on from a failed member.
- **Squeeze:** H1's slot ends UNRESOLVED; H1-T2 and stage-1 screens only release data; its 95% "promising" rule tightens to 99.58%.
- **Secondaries:** P3 is the only fixed-sequence one; subsets, sizes, venues and lines never pass.
- **Trial log:** every look, including the 200+ on 07-22..09-21, is logged for PBO and DSR (`docs/ARCHITECTURE.md` line 445).
- **Proof:** n ≥ max(300, n_power at 0.0042); a pass earns forward paper only.
- **Core holdout:** a separate budget, opened once after 10-21 after a G1 pass, one configuration per universe at α 0.04 (ARCHITECTURE lines 406, 427, 429). No survivor qualifies.
- **Odds (judgement, assuming independence):** about 1.3% or less that luck alone passes any of the three (3 × 0.0042); about 9–14% that at least one is real (1 − 0.97³ to 1 − 0.95³).

## 5. Rejected, with reasons
- **A-FULL:** every part was found on windows viewed 200+ times (the paid cut was one of about 24); the hot gap fell from +18.1 to +2.5 (`research/regime-probe/RESULTS.md` line 15); even the optimistic line lost 7.9% (`research/runner-probe/RESULTS.md` line 27); the upside rests on 1 giant in 934 (`research/sizing/RESULTS.md`), which G1's concentration checks reject. The hybrid stop belongs in core exits as a y_severe fix, not an edge.
- **A-TAILSAFE:** same ceiling; "giants cluster when hot" rests on one coin (top hot decile: no 5x in 91).
- **A-ABS:** the exit change is cosmetic; deep-pool stop gaps cost about 0.02 points (`research/mr01-screen/RESULTS.md`).
- **Chain 1:** the paid split is in-sample on hour-1 coins; on older coins it means "ever promoted" and halves a rare group.
- **Chain 2:** on exchange-priced coins breadth counts arbitrage bots (edge §7.4); it would spend arm A's sealed half.
- **Chain 3:** only MYRO overlaps; the move is spent by +1 h (judgement); drops bounce +0.03 to +0.07 (cheap-venue RESULTS).
- **Chain 4:** HOT is day-level on exploration days; UNPAID is already Test 1's primary.
- **C2:** rare sales; bounce below a toll paid twice; many forks.
- **C3:** the basket path is known (trend probe); heat likely lags price (Li et al. 2023); credit price unresolved.
- **C4:** nothing measured; needs citable exchange labels; whale-alert bots share the lead. Scouting only.
- **Lonely crowded short:** duplicates squeeze arm C (PREREG line 195); its calm cut is look-ahead; at most 58 events.

## 6. Kid summary
1. We mixed all our ideas 14 ways to find a money-maker.
2. Most mixes stack things that already lost, and stacked losers still lose.
3. Three use new clues: who must buy, who sold everything, who caused a crash.
4. Each has a small chance (about 3–5 in 100). None is tested yet.
5. We wrote the rules first, so we cannot fool ourselves later.
6. A fail is dropped. A pass is only watched with pretend money.
7. Even a winner takes years to prove at a few trades a month.
8. The bot keeps waiting and spends nothing until something is proven.