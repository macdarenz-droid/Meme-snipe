# Where an edge could clear our real costs (RES-4)

Task RES-4, 2026-10-04 (Melbourne). Owner request: raise the odds of a proven strategy honestly, never by lowering a bar. Sources: repo research (`docs/research/*.md`, own data in `research/`) and cited papers; nothing new was downloaded and no practice or holdout day was read. Anything not verified is marked.

## Owner summary

What could work: buying dips in tokens that survived their first day and still hold at least $50k of liquidity, once the selling has stopped (H1), or steady quiet buying in those tokens (H2). Studies of small coins find sharp falls tend to bounce back partly, while chasing rises tends to lose.

What is unlikely: anything in the first hour after a token moves to PumpSwap, copying wallets, and most fresh-launch setups. Our data and others' show most are planned dumps.

Costs on PumpSwap: a $2 trade must gain about 4.4–5.0% just to break even; at $20 that falls to 2.2–3.1%.

On practice days the study picks at most one idea per type, then tests it once on days no rule saw. Fresh-launch ideas probably cannot reach the 300 trades needed by 20 Oct, so they may end "not proven".

## 1. Cost math per setup

How the outcome stage scores a trade (conservative scenario, `FILL_CONFIG` fills-2): exact CORE-2 quotes on mainnet fee configs (`research/edge/snapshot/fee-configs.json`, shared with CORE-2's tests), at the real size; both legs' venue fees and price impact; base fee, priority fee (20,000 lamports) and the 5,000-lamport tip on each landed leg; no failed entries on a filled trade; failed exit attempts on the ladder, each failing with 1 − 56% = 44% and paying base + the third rung's priority (155,000 lamports), expected 0.77 failures; token-account rent (1,513,840 lamports) refunded only when the atomic sell-and-close lands with no dust (DECISIONS "Rent", RENT-1): 90% × 95% = 85.5%, so 14.5% of the rent is lost on average, and a close that fails without dust (9.5%) pays one more failed attempt. SOL at $119.26. Reproduce: `node --no-warnings packages/backtest/src/research/edge-costs.ts` (writes `research/edge/costs.json`; `packages/backtest/test/edge.test.ts` checks the file matches the code).

Not in the table, but charged by the backtest on top: the price moving against us while an order lands (6 slots at p90, and ×1.5 on any shortfall against the quote), and repeated exits getting 5% less each time (`exitRetryHaircutPpm`). These are not fixed costs; every 1% of adverse move adds 1% to the hurdle.

Conservative scenario, PumpSwap: an exit attempt fails 44% of the time and each failure pays 155,000 lamports (0.7728 expected); rent back 85.5%; a close that fails without dust pays one more failed attempt. SOL $119.26.

| Setup | Size | Fee/side | Fees+impact (both legs) | Fixed (lamports) | Fixed % | Break-even move | Break-even, no rent back |
|---|---|---|---|---|---|---|---|
| young PumpSwap (at migration, ~411 SOL cap) | $2 | 1.25% | 2.51% | 414,009 | 2.47% | **4.98%** | 12.69% |
| young PumpSwap (at migration, ~411 SOL cap) | $5 | 1.25% | 2.56% | 414,009 | 0.99% | **3.55%** | 6.64% |
| young PumpSwap (at migration, ~411 SOL cap) | $20 | 1.25% | 2.85% | 414,009 | 0.25% | **3.09%** | 3.87% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $2 | 0.95% | 1.89% | 414,009 | 2.47% | **4.36%** | 12.08% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $5 | 0.95% | 1.90% | 414,009 | 0.99% | **2.89%** | 5.98% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $20 | 0.95% | 1.96% | 414,009 | 0.25% | **2.21%** | 2.98% |
| U1 survivor at the 1.15% tier (upper bound) | $2 | 1.15% | 2.28% | 414,009 | 2.47% | **4.75%** | 12.47% |
| U1 survivor at the 1.15% tier (upper bound) | $5 | 1.15% | 2.29% | 414,009 | 0.99% | **3.28%** | 6.37% |
| U1 survivor at the 1.15% tier (upper bound) | $20 | 1.15% | 2.35% | 414,009 | 0.25% | **2.60%** | 3.37% |

| Setup | Size | +10/−5 | +20/−10 | +30/−15 | +50/−20 |
|---|---|---|---|---|---|
| young | $2 | 66.5% | 49.9% | 44.4% | 35.7% |
| young | $5 | 57.0% | 45.2% | 41.2% | 33.6% |
| young | $20 | 54.0% | 43.6% | 40.2% | 33.0% |
| u1 | $2 | 62.4% | 47.9% | 43.0% | 34.8% |
| u1 | $5 | 52.6% | 43.0% | 39.8% | 32.7% |
| u1 | $20 | 48.0% | 40.7% | 38.2% | 31.7% |
| u1-1.15 | $2 | 65.0% | 49.2% | 43.9% | 35.4% |
| u1-1.15 | $5 | 55.2% | 44.3% | 40.6% | 33.3% |
| u1-1.15 | $20 | 50.7% | 42.0% | 39.1% | 32.3% |

As the outcome stage scores a trade (`outcome.ts` with RENT-1, #114: the same constants, derived from the same configuration; a parity test checks the two agree); the backtest's congestion, landing-tail and ladder costs are higher. A parity test checks that the outcome stage's mean loss on a still pool equals this cost math. The pump curve is not in the table: the proof's fills land on PumpSwap only, and the curve is paper-only research (§3.1); on the curve, fees are the same 1.25% per side but landing is worse (40% conservative).

The second table is the break-even win rate of a bracket exit (+W / −L gross), cost included: p = (L + c) / (W + L).

What this means:
- **Rent decides small trades.** At $2, losing the rent when the close fails (14.5% of the time) costs 1.3% of the trade on average; never getting it back would cost 9.0%. RENT-1's sell-and-close is worth more than any signal at this size.
- **Larger trades halve the hurdle.** From $2 to $20 the U1 break-even falls from 4.36% to 2.21%, and young PumpSwap from 4.98% to 3.09%. That is information for the owner's later decision on limits; it changes nothing now.
- **Cheaper venues.** Our transaction builders (TX-1) support only the pump curve (paper-only) and canonical PumpSwap pools. Non-canonical PumpSwap pools (0.30%) are refused by H5 because their liquidity can be withdrawn; Raydium and others have no builder. So **no cheaper venue is available**; U1's lower tier (0.95% at the $50k floor, falling with market cap) is the cheapest route we have.
- **The proof's bar is higher than break-even.** §14 sizes the proof for a +5% net edge (the smallest worth trading), so a hypothesis needs roughly **break-even + 5% gross per trade**: about 9.4–9.8% on U1 and 10.0% on U2 at $2.
- **Count matters as much as edge.** The holdout is entries in [09-22, 10-20), 28 days, and needs n ≥ max(300, n_power): **at least about 11 entries a day** per universe.

## 2. Ranked hypotheses

Ranked by the strength of the prior evidence, then by whether the holdout can reach 300 trades. Grades as in `signals.md` §9 (A peer-reviewed or reproducible on Solana/pump.fun 2025–26; B reputable, other venue or older; C partial method; D unverified).

Candidate counts are estimates, not measurements (grade D): graduations are about 1,300 a day (49.7k launches × 2.6%, venues.md, measured 2026-10-03; 4.7–6.7% after BOOST per The Block, so up to ~3,300). Only 4.0% of graduates kept more than $10k of total liquidity a day later (empirical.md Q1, n = 405); a $50k quote side ($100k total) is rarer, guessed 0.5–1.5% → 6–20 new U1 pools a day, perhaps 30–150 live at once. BT-2's funnel count on practice days replaces every count here before anything is frozen.

| Rank | Hypothesis | Mechanism | Prior evidence | Entries a day (est.) | Needed edge ($2) | Exit | Holdout can reach 300? |
|---|---|---|---|---|---|---|---|
| 1 | **H1 U1 dip-reversal**: a survivor ≥ 35% below its high since migration, the last hour no longer falling, a higher low, quote vault down ≤ 10% in 60 min (it also falls on ordinary sells, not only on liquidity pulls), wash share ≤ 60% | Small, illiquid coins revert after sharp falls; a token that survived the dump window with deep liquidity has buyers who defend it | Reversal in small/illiquid coins, distance from the recent high predicts more reversal (Fičura 2023, t = −7.31 / −9.03, B); illiquid losers revert (Begušić & Kostanjčar, B); our own data: strength after migration predicts worse outcomes, weakness less bad (empirical.md Q2, own data) | 3–30 | > 4.98% to break even; ~10.0% gross to prove +5% | U1 policy exits: stop 3 × ATR(14, 5-min) and a hard stop 15% below entry, half off at +2R, flat exit 30 min, T_max 120 min | Possibly |
| 2 | **H2 U1 quiet accumulation**: net SOL inflow ≥ 1% of the reserve in 60 min from ≥ 8 buy-only wallets (not checked for a shared funder), wash share ≤ 40%, not chased (≤ +10% in 60 min), low turnover | Steady buying by distinct wallets without wash or chase is demand the price has not priced yet | Reversal in small coins is tied to low volume (Fičura, B); raw buyer counts are inflated by sniper rings, so only buy-only wallets count (Kamat 2607.02795, repo); no direct evidence for forward returns (gap, signals.md §9.3) | 2–20 | as H1 | as H1 | Possibly |
| 3 | **H3 U1 range breakout** (risk.md S2; BT-2's U1 placeholder): price above its 6 h range high, 15-min volume ≥ 2× the range average, distinct owners with a positive balance +5% (owners, not token accounts; definition in §3), cap ≥ 1,470 SOL | Breakouts with volume and new holders attract followers | Momentum holds only in large, liquid coins (Liu, Tsyvinski & Wu, J. Finance 2022, B; Begušić, B); for coins this small the evidence points the other way (signals.md §9.3). Kept because the plan names it and BT-2 registered it | 1–10 | as H1 | as H1 (BT-2's structure stop: 1% below the 60-min low) | Unlikely |
| 4 | **H4 U2 reclaim with our hard rejects** (risk.md S1; BT-2's U2 placeholder): ≥ 30% flush since migration, a higher low ≥ 5% above it, VWAP reclaimed, non-creator-user flow > 0 (swaps not from the creator's exact address; a creator-funded wallet still counts, since funding links are not in the data), every GATE-1 reject passed | Graduates that survive the first hour and reclaim their average price may carry real demand | MELT (A): concentration and fast launches mark dumps; our hard rejects remove them (H9 instant graduations: median −97% at +1 h vs −66%, empirical.md Q2). No study measures returns after 60 min (signals.md §9, gap) | 1–4 (DECISIONS funnel estimate, ±3×) | > 4.36% to break even; ~9.4% gross to prove +5% | U2 policy exits: stop 3 × ATR(14, 1-min), half off at +1.5R, flat exit 15 min, T_max 120 min | No (≤ 112 in 28 days) |
| 5 | **H5 U2 exhausted dump**: ≥ 60% below the high since migration, the first 20 curve buyers have sold ≥ 80% of what they bought, the creator holds ≤ 1% of supply, 15-min net flow ≥ 0, a higher low | Once insiders have sold, the remaining flow is not a scheduled dump | MELT (A): early buyers and bundles sell into the pool after migration; pump-and-dumps fade within an hour (Li, Shin & Wang, JFQA, B; numbers from a summary only). Nothing measures what follows. **Known weakness:** "sold" is measured from trades only; token transfers are not in the data, so an insider who moves tokens to another wallet looks like a seller and the dump may still be ahead | 0.3–2 | as H4 | as H4, hard stop 20% | No |
| 6 | **H6 = H1 only when SOL rose over 24 h** | Large memecoins track the market; a falling market adds sell pressure | Large-cap memecoins correlate with BTC at 0.78 (Krause, SSRN, D: page not opened); regime gate (§6.4) | about half of H1 | as H1 | as H1 | Less than H1 |

Excluded, with the evidence that rules them out:
- **Copy-trading / smart money (U3):** about −11% a trade, 0 of 120 variants positive (RES-2, copytrading.md).
- **Graduation to +60 min, including the +5-min momentum and BOOST windows:** 0 of 72 rules positive after costs; strength at +5 min is the most negative signal (empirical.md Q2–Q3; §3.1).
- **Bonding-curve late-stage entry (risk.md S5):** the curve is paper-only research (§3.1) and its own author expects it to be negative after the 1.25% fee and latency.
- **Holder-reward coins (post-B4) as a signal:** no evidence either way; not registered.

## 3. Pre-registration

File: `research/edge/preregistration.json`, sha256 `43c7bc8a8971ea90118daec5d6f6c763ef42a0457abee8ec4583d980fcecdc6c`. Written before any practice day was read by RES-4; a changed value is a new trial.

- **Thresholds are chosen in advance, never fitted.** f_dd ≤ −0.35 / −0.60, f_ret60 bounds and the stops follow the evidence above; f_turn60 ≤ 0.5, f_indep60 ≥ 8, f_2side60 ≤ 0.4 / 0.6, f_liqchg60 ≥ −0.10 and f_early_sold ≥ 0.80 are **round values picked before any data**, with no data behind the exact number.
- **What BT-2 must do (requirement, not built yet; given to BT-2 by the supervisor):** one run builds an SPA panel over all six hypotheses and S0 per universe; the practice days pick at most one hypothesis per universe for the holdout; BT-2 loads this file and refuses a freeze if its hash differs. The SPA family is **k = 6**; the Holm family for the holdout stays **2 (U1, U2)**. Any later variant is a 7th trial and needs a new, never-run holdout window.

- Shape: BT-2's `UniverseConfig` (window, rules, edgePpm, medianTargetBps). H1, H2, H5 and H6 use the `features` rule kind over RES-3's as-of features; H3 and H4 are BT-2's own `U1`/`U2` rules, unchanged.
- **BT-2 note:** its `FeatureRules` comment says "one or two conditions"; H1, H2, H5 and H6 have five or six. The type allows any number; BT-2 must evaluate all of them (an unknown feature fails its condition).
- **Definitions** (in the file's `definitions`, fixed before any data after an external audit): H3's holder growth counts distinct owners with a positive balance, never token accounts (one owner splitting into three accounts would otherwise fake 5% growth), with H12's exclusions and the same data coverage at both timestamps, else unknown and failed. H4's flow is **non-creator-user flow**: swaps not from the creator's exact address; a creator-funded wallet still counts, so it is not "independent" buying. H2's buy-only wallets are not checked for shared funders.
- Exits: the policy's per-universe exit blocks (CFG-2) copied verbatim, T_max 120 min (§9 phase-1 cap). The test fails if the policy changes without a new registration.
- U1's $50k floor comes from H8 (the policy's `u1FloorUsd` on the effective quote reserve), not from the check window's `minQuoteLamports` (100 SOL), which only schedules checks.
- Size: policy `minNotional` ($2 trial). edgePpm 50,000 is §14's +5% bar, not an estimate.
- Checks: `packages/backtest/test/edge.test.ts` (features exist and are as-of, no sample-rate-dependent count such as f_grad24 or f_dep24, exits equal the policy, the file's hash is the one above).
- No holdout day is read by anything here.

## 4. What the study will settle

- For each registered hypothesis: whether it beats costs and S0 on practice days (G1, SPA over all six, k = 6). The one hypothesis per universe that SPA picks then gets G2 once on the sealed holdout (Holm across U1 and U2).
- Which hypotheses cannot reach 300 trades by 2026-10-20: these end "not proven yet", not "failed"; a later, never-run window can try again at a smaller error budget (DECISIONS, attempt k ≥ 2).
- If none pass, the honest result is that no tested setup earns more than its costs at $2, and the bot keeps abstaining.

## 5. Could not verify

- Every entries-a-day figure (grade D): BT-2's funnel count on practice days decides.
- The U1 survivor rate at a $50k quote side: only the $10k total-liquidity rate is measured (4.0%, a pre-BOOST regime).
- Krause (SSRN 6292920): page returned 403; the correlation figure is from a search snippet.
- Li, Shin & Wang: figures from a search summary; the PDF was not opened.
- Fičura's sign convention for "distance from the high" was not checked in the full text.

## 6. Strategy search beyond the six (RES-6, 2026-10-06)

Owner request (6 Oct): find any rule, inside or outside the current plan, that could make the bot win or be profitable. **Research only.** Nothing here is registered, nothing changes attempt 1 (H1–H6, §3), and no statistic was computed on market data at or after the holdout wall (2026-09-21T14:00Z). Method: five researchers (repo evidence, the design-blueprint artifact "Solana Meme Bot Blueprint", literature 2018–2026, market structure, statistics), one synthesis, and three critics who tried to refute every candidate (execution cost, evidence, owner rules). Labels: VERIFIED (source opened or code run), REPORTED (secondary source), UNVERIFIED. Every chance figure below is judgement, not a measurement.

### 6.1 Bottom line

- No verified source shows a long-only bot that pays taker costs making money in meme tokens: not the repo, not the blueprint, not the literature. The money goes to insiders and bundlers, co-located searchers, the protocol and creators (fees) and liquidity makers. The repo's own tests agree: 0 of 72 graduation rules, 0 of 120 copy-trading variants.
- The most likely outcome (judgement, about 75–85%) is that a small, free-data, non-insider bot has no edge. In that case staying in paper is the correct result, not a failure.
- One seat has a plausible loser on the other side: impatient sellers who pay for immediacy. To clear costs it needs the cheapest pools (0.30% tier), trades of $20–50 rather than $2, and costs measured in the dry run rather than assumed. Even then the critics put the chance of passing the gate at about 3–8%.
- The first job is clean data and measured costs, not more ideas.

### 6.2 "Win with high probability" is the wrong target

- On a price with no drift, the chance of hitting +W before −L is L/(W+L). Every bracket's gross expectancy is zero and its net is minus the cost. A high win rate is free to manufacture (wide stop, tight target) and says nothing about profit.
- Break-even win rate with cost c: p* = (L + c)/(W + L). Each 1% chance of a total loss (rug, blocked exit) adds about (100 − L)/(W + L) points. Example, 0.30%-tier pool at $50 (c 0.75%): a +2/−6 bracket needs 84.4% wins against 75% by pure chance; with 4% total losses it needs more than 100%, so it cannot work.
- Profit comes only from the signal's conditional drift. Exits change the spread of outcomes, not the sign. Scaling out does not add expectancy, and each extra exit leg costs 149,777 lamports (0.89% of a $2 trade, 0.09% at $20).

### 6.3 What the proof really measures

- The gate is a test of per-trade net Sharpe S = μ/σ: a pass at 80% power needs √(n/DEFF) · S ≥ z_α + z_β, where DEFF = 1 + (m − 1)ρ for m trades a day with same-day correlation ρ. Attempt 1 (0.02 per universe): z = 3.168. Attempt 2 (0.0025 per universe, Holm of 2): 3.865, or 3.649 if one universe.
- The gross per-trade Sharpe a signal must have is κ = S_req + c/σ. **Cost relative to volatility decides, not cost alone.** At n = 300, DEFF 1 (S_req 0.183; arithmetic, σ for deep pools assumed):

| Setup | Break-even c | Needed gross κ |
|---|---|---|
| Young pool, $2 (σ 0.32) | 4.98% | 0.34 |
| Young pool, $20 (σ 0.32) | 3.09% | 0.28 |
| 0.30% tier, $2 (σ 4%) | 3.07% | 0.95, hopeless |
| 0.30% tier, $20 (σ 4% / 6%) | 0.87% | 0.40 / 0.33 |
| 0.30% tier, $50 (σ 4% / 6%) | 0.75% | 0.37 / 0.31 |

- For scale: the best of 72 pure-noise variants over 100 trades shows about 0.24 by luck ([quant.md](quant.md)). A needed κ of 0.28–0.40 is very high. The best diversified portfolio in the main reversal paper reaches a gross daily Sharpe of about 0.30, and its long leg alone about 0.12 (Bianchi, Babiak & Dickerson, Table 3, read by the evidence critic).
- At σ 0.32 and n = 300 the true net mean needed is about 5.4–5.9%, so n_power at the +5% target is about 340–410 and U1 needs about 12–15 entries a day over 28 days, not 11.
- Register targetMean at each strategy's realistic edge, never the +5% default. For a low-σ strategy the default drops n_power to the 300 floor while the real power at μ 0.5% is about 28%. A lower target only tightens, and DECISIONS allows it (target ≤ +5 points).

### 6.4 Break-even by fee tier and size

Repo cost code, conservative scenario, read-only re-run (`packages/backtest/src/research/edge-costs.ts`), SOL $119.26. Round-trip move needed, % of the amount paid in:

| Setup | $2 | $5 | $20 | $50 |
|---|---|---|---|---|
| Young pool, 1.25% | 4.98 | 3.55 | 3.09 | 3.51 |
| U1 ($50k quote), 0.95% | 4.36 | 2.89 | 2.21 | 2.18 |
| 0.55% tier (about 700 SOL quote) | 3.57 | — | 1.39 | 1.31 |
| 1,500 SOL pool, 0.30% | 3.07 | 1.59 | 0.87 | 0.75 |
| Raydium v4 0.25% (estimate; no builder) | 2.95 | 1.48 | 0.77 | 0.65 |

- The young pool gets worse at $50 because impact grows on about 85 SOL of depth.
- Of the 414,009-lamport fixed cost, about 53% is modelled lost rent (14.5% of 1,513,840) and about 32% failed exit attempts (0.7728 × 155,000). Only 14% is fees on transactions that land. These are conservative assumptions, and only a measured value may replace one. The dry run sends nothing, so landing can be measured only by an owner-authorised canary or by observing landings on chain.
- Keeping token accounts open saves only the lost-rent share: about 0.13 points at $20 and 0.05 at $50 (1.3 points at $2). It also conflicts with ARCHITECTURE §5.3 (close in the same transaction as the full sell).
- The 0.30% tier needs a market cap of at least 98,240 SOL (about $11.7M). On the migration constant product that is about 1,314 SOL of quote, so tier and depth are close to the same filter. How many such canonical pools exist is unknown.

### 6.5 Findings that need a ruling

1. **Holdout contamination (VERIFIED by date).** empirical.md's backfill window (2026-10-01T23:00Z to 10-02T11:00Z) and its live sample (10-03) lie inside the sealed window [09-22, 10-20). H8, H9 and H11 take their thresholds from that study. H9 applies to every universe (`packages/core/src/gates/hard.ts` lines 318–327), so U1, U2 and S0 are touched, not only U2. The supervisor should record this in DECISIONS and rule before any look: disclose it, or exclude entries from 2026-10-01T23:00Z to 10-03T23:59Z from G2 scoring (that only tightens).
2. **Migration-price reference (UNVERIFIED, needs a mainnet fixture).** `research/empirical/backfill_migrations.mjs` (lines 37–49) prices the migration from the real WSOL vault only (`migPriceSol = sol / tok` from postTokenBalances). Since BOOST, a fresh pool prices on effective reserves (about 67.4 real + 17.6 virtual SOL; [venues.md](venues.md) F4–F5). If so, the study's reference sits about 26% below the executable price, and "above the migration price at +5 min" (H11) may not mean in code what it meant in the study. Figures re-derived from that holdout-dated data must not shape any design.
3. **The proof cannot be reached by most strategies under today's settings (VERIFIED).** The trial policy allows 1 open position, 3 entries a day and 1 per token a day (`packages/core/src/config/policy.ts` lines 190–191). Attempt 2's window is fixed at 28 days (DECISIONS, "Attempt 2 is registered now as a rule"). 3 a day × 28 days = 84 trades, under 300. Any strategy needs at least about 11–15 entries a day. Entries per day and trade size are owner settings, and the window length is a supervisor rule. All must be set before registration, never after a look.
4. **Data.** The repo holds no real pre-wall market day. Practice days with today's fees and layouts run only from B4 (2026-09-12) to the wall, about 9.5 days, which is under SPA's 10-day minimum and none of them is published. The free source of fresh, never-run windows is the live recorder capturing the target universe from now on, within free Helius credits (the live worker already uses about 408k of 1M a month); a larger scope needs the owner's approval of a paid plan.
5. **Economics at trial size.** About $6 a month of server cost is about 30% of a $20 bankroll every month. The trial can prove a rule, but it cannot be profitable overall at that size.

### 6.6 Candidates after critique

| Candidate | Verdict | Why | Needs |
|---|---|---|---|
| **MR-LV**: buy sharp, low-volume drops in canonical PumpSwap SOL pools in the 0.30% tier, not caused by one top-1% sell or the creator; time stop near the reversion half-life; $20–50; ≤ 1 entry per token a day | Keep, but only for a zero-alpha Phase 0 | For: daily and weekly reversal in illiquid coins, concentrated in low-volume selling (Bianchi, Babiak & Dickerson 2022; Zaremba et al. 2021; Fičura 2023). Against: the long-only leg earns about 0.57–0.72% a day gross at CEX daily closes, below this venue's 0.75–0.87% round trip; part of a close-to-close reversal is bid-ask bounce, which an AMM taker cannot capture; no sub-hour Solana DEX evidence either way; large memes show momentum rather than reversal (Liu, Tsyvinski & Wu 2022); on Uniswap, large sells were followed by more falling (Ante 2022); the effect is fading (Fieberg, Liedtke & Zaremba 2024). Practical: probably few pools; flow is split across venues and only PumpSwap is decoded; H9 may reject most of the universe; "funder cluster" filters cannot be built (no funding links or transfers in DATA-1) and must fail closed. Use σ ≥ 5–6% as the base case. | Owner: size and bankroll. Supervisor: attempt-2 window. Data. Chance about 3–8% |
| **Attempt 1 as registered** (H1–H6) | Keep | It must be scored before attempt 2 can be registered (DECISIONS). U2 cannot reach 300 trades (≤ 112), so it ends "not proven". Spending α 0.04 leaves 0.01 for every later attempt. | Owner's data decision. Chance about 2–5% |
| **Maker dip-buying** with Meteora DLMM limit orders (earn the fee instead of paying it) | Park | Fills come mostly from arbitrageurs after the canonical pool has already moved (loss-versus-rebalancing, Milionis et al.); bin-array rent was reported at about 0.075 SOL, a large share of a $20 trade (Meteora docs FAQ, figure probably from before the rent cut); no decoder, builder or fill model; Meteora is not on the signer allowlist (owner approval). | Owner: venue and signer. Chance about 1–5% |
| **BOOST window**: buy right after migration and sell while the scheduled buy-and-burn runs | Drop | It is public protocol flow, so not front-running a user, but the repo lands through SWQoS-only with a conservative entry delay of about 23 slots (about 9 s), inside the window already measured as negative. It conflicts with H10 and "not a first-block sniper". | — |
| **Curve intensity** (Marino, Naviglio, Tarantelli & Lillo 2026) | Drop | In-sample, no fees, exit assumed at the graduation price (impossible against bundled completions); graduation predictors decay (AUROC 0.86 to 0.46); curve fills are research-only. | — |
| **Event-clock U2** (decide after BOOST ends) | Drop as a strategy | Too few trades; "early buyers sold" is blind to transfers. Record f_boost_done and f_since_boost as as-of features; only allowed as an extra gate on top of the 60-minute floor. | — |
| **Listing announcements** | Drop | Far under 300 events; no free feed; the canonical pool is repriced by arbitrage first; part of the move leaks before the announcement (REPORTED). | — |

Also ruled out by the market-structure pass: passive LP on meme pools (the LP share on canonical PumpSwap is small and value falls with √(price ratio)), cross-pool arbitrage (a latency race, REPORTED about $1.58 per arbitrage in 2024), perp shorts (derivatives and cross-chain; owner decision; only anecdotal evidence), holder-reward carry, copy-trading (about −11% a trade, RES-2). Benchmark: staked SOL earns about 6–7% a year (REPORTED), the honest baseline any strategy must beat in SOL. Proof reports should show it beside the strategy.

### 6.7 What raises the odds for any strategy

1. Data exists (owner: a paid month of about US$94, or time with the recorder running).
2. Size in cheap, quiet markets (owner setting): in the 0.30% tier, $2 to $20 cuts the needed κ from 0.95 to about 0.40. In young pools it only moves 0.34 to 0.28.
3. Fee tier: 0.30% instead of 0.95% at $20 cuts break-even from 2.21% to 0.87%.
4. Measured costs: replace the modelled lost rent and failed exits only with dry-run or canary measurements, registered and frozen before any look.
5. Independent breadth: ≤ 1 entry per token a day and a cap per creator. DEFF 2 to 1 lowers the needed S from 0.259 to 0.183. Deep memes share sector moves, so expect DEFF above 1.
6. Exit near the reversion half-life. No scaling out below about $20. Never a tight target with a wide stop.
7. Simulate stop gaps: the exit ladder allows minOut 8% below the trigger (attempts 1–2) and 25% (attempts 3–4), and the conservative model fails 44% of attempts, so a 4–5% stop is a trigger, not a realised loss.
8. Check that the fill model ties landing and minOut rejects to price direction (dip buys land on continued falls; stops fail in crowded dumps). If it does not, add a stress case.
9. Stricter gates from the blueprint (they only tighten): t ≥ 3, positive in every calendar week, still positive at 2× latency, monthly fixed cost covered, CUSUM demotion when live.

### 6.8 Proposed order (no alpha spent before step 4)

1. Supervisor: record the contamination (6.5.1); check the migration-price reference against a mainnet fixture (6.5.2); start recording the 0.30% and 0.55% tier canonical pools (public market data only) within free credits.
2. Owner: the data decision, and the trade size and entries per day the proof will be registered at.
3. Phase 0 on same-regime pre-wall days and recorder days, with no signal tested: eligible pools per day after H9, the canonical pool's share of each token's volume, unconditional absolute moves at 5, 15, 30 and 60 min, σ, ρ, time from dip to reversion against the 23-slot entry delay, and the stop-gap distribution. Kill MR-LV if fewer than 10 pools qualify on most days, or if a typical 30–60 min move is not several times break-even.
4. Score attempt 1 as registered. If Phase 0 passed, register MR-LV as attempt 2 (at most 2 configurations fixed from the mechanism, targetMean at the realistic edge, breadth caps) on a never-run window, after the supervisor has ruled that its trades per day can reach n inside that window.
5. If everything fails its fixed kill test: the bot stays in paper, the report says no edge was found, and no new trial opens without new data or a new mechanism.

### 6.9 Sources and limits

Opened by a researcher or critic: Bianchi, Babiak & Dickerson, J. Banking & Finance 142 (2022), [working paper](https://www.riksbank.se/globalassets/media/rapporter/working-papers/2022/no.-413-trading-volume-and-liquidity-provision-in-cryptocurreny-markets.pdf) (cost wording differs between its text, 30/40 bps, and Table 5, 20/30 bps); Zaremba et al., IRFA 78 (2021), doi:10.1016/j.irfa.2021.101908; Fičura, [FFA WP 5:003](https://ideas.repec.org/p/prg/jnlwps/v5y2023id5.003.html) (2023; sign convention not confirmed in the full text); Fieberg, Liedtke & Zaremba, IRFA 94 (2024), doi:10.1016/j.irfa.2024.103218; Liu, Tsyvinski & Wu, J. Finance (2022), [NBER w25882](https://www.nber.org/papers/w25882); Ante, [BRL WP 26](https://www.blockchainresearchlab.org/wp-content/uploads/2020/05/BRL-Working-Paper-26-Liquidity-shocks-token-returns-and-market-capitalization-in-DeFi-markets.pdf) (2022) and [BRL WP 3](https://www.blockchainresearchlab.org/wp-content/uploads/2019/10/Exploring-Market-Reactions-to-Exchange-Listings-of-Cryptocurrencies-BRL-working-paper3.pdf) (2019); Caporale & Plastun, J. Economic Studies 46(5) (2019); Marino, Naviglio, Tarantelli & Lillo, [arXiv 2602.14860](https://arxiv.org/abs/2602.14860) (2026); Milionis, Moallemi, Roughgarden & Zhang, [arXiv 2208.06046](https://arxiv.org/abs/2208.06046); Meteora DLMM [limit orders](https://docs.meteora.ag/core-products/dlmm/limit-order.md); [pump.fun fees](https://pump.fun/docs/fees); the pump_amm IDL in pump-fun/pump-public-docs. REPORTED only: Nagel, RFS 25(7) (2012); insider trading before Coinbase listings (Félez-Viñas, Johnson & Putniņš, via Decrypt); staking yield; the arbitrage profit figure.

Limits: the Kamat graduation paper is cited in the repo as arXiv 2607.02795 and was found in this search as 2607.02823; check which is right before citing it again. The deep-pool σ (4–8% per trade) and every pool count and trades-per-day figure are assumptions until Phase 0 measures them. No market data was downloaded and nothing at or after the wall was read for a new statistic.

### 6.10 First real-data check of MR-LV's family (2026-10-07)

Pre-registered (`research/deep-pool-probe/PREREG.md`, pushed before any return) and run on free pre-wall 5-minute prices for 41 established pump.fun coins in canonical PumpSwap pools at the 0.30%–0.55% fee tiers (2026-07-22 to the wall). **All five rules: not supported.** Sharp drops are followed by a small bounce (dip rules beat random entry by about +0.2 to +0.5 points), but the bounce, about +0.1% to +0.6% gross, is smaller than the 0.85–1.0% round trip in the cheapest pools, at $50, $200 and $500. Most of it happens in the first 5 minutes, so a slow bot captures less. Momentum after volume spikes does worse than random. The coin list favours dip-buying (survivors only), so the true result is likely worse. Details: `research/deep-pool-probe/RESULTS.md`.

## 7. Routes that pay by rule, not by prediction (RES-7, 2026-10-07)

Owner request (7 Oct): "Think outside the box. Find every maze route ... not statistics." Five researchers each took one route (protocol payouts, atomic arbitrage, carry, being the house, forced or price-blind flows), read the pump and pump_amm IDLs (pump-public-docs `cb188ce`) and live mainnet accounts, and two critics re-checked every claim on chain. No strategy return was computed on data at or after the wall; reading today's protocol state was allowed.

### 7.1 Bottom line

No route turns $500–$5,000 into meaningful income without price risk. Every route that pays well either holds the meme coin (LP, holder rewards, BOOST) or needs speed, venues or leverage the bot does not have (arbitrage, perp carry). The only money that reaches the bot by rule is staking yield on idle SOL.

### 7.2 What survived

| Route | Mechanism (VERIFIED unless marked) | Size | Needs |
|---|---|---|---|
| **Stake idle SOL** (JitoSOL or a native stake account) | Issuance plus MEV tips paid to stakers by protocol rule: pool rate grew +0.0172% per 1.342-day epoch, about 4.8% a year (5.7% over the last 12 months), counted in SOL. A SOL→JitoSOL→SOL round trip on Jupiter costs about 0.005%. | Small but certain: about 0.2–2.4 SOL a year on $500–$5,000. $0 before funding. | Owner: a new asset and a signer route. Exit is a DEX sale: the pool's instant-withdraw reserve held only 0.438 SOL when read, so keep the trading float in SOL. |
| **Protocol-flow hygiene** (defensive) | BOOST buys carry `user` = PDA(["boost_vault", pool]) and zero fees; Mayhem agent trades carry `user` = the whitelisted mayhem vault and zero fees. After BOOST, a pool keeps `virtual_quote_reserves` ≈ 17.58 SOL while the real vault can drain (one pool read: 17.58 virtual, 0.27 real). | No income; prevents false demand and false depth. | Supervisor (core stream 2). See 7.3. |
| **All-or-nothing entries** (Jito `bundleOnly`) | A transaction that would fail is dropped instead of landing and paying fees. | About 0.8% of a $2 trade; negligible at $500+. | Owner (Jito tip accounts in the signer). Entries only: a dropped stop exit costs time in a crash. |

### 7.3 A risk found on the way (for the supervisor)

H8 values liquidity as `quoteVault + virtualQuoteReserves` (`packages/core/src/gates/hard.ts` line 311). After BOOST, about 17.58 SOL of that is virtual: it sets the price but cannot be sold into (`pump-swap.ts` refuses a sell larger than the real vault). So H8, and any collapse label built on effective reserves, can count about 17.6 SOL (about $2,100) of depth that is not there. A drained pool can look alive to a label. Suggested ruling: use the real vault for "can exit" and "collapse", and effective reserves only for price and impact, with a replay fixture of a drained post-BOOST pool as the test.

### 7.4 Dead ends, with the reason

- **Volume incentives (PUMP per SOL of volume):** both GlobalVolumeAccumulators are zeroed; pays 0 today. Farming them would be wash trading anyway.
- **Cashback coins** (legacy pools where the creator fee goes back to the trader, net 0.25% a side above 420 SOL cap): the mechanism works, but no new coin can be cashback (`create_v2`), only 29 pools sit at ≥ 420 SOL cap, they carried about 0.09% of PumpSwap trades in pre-wall samples, every sampled trade already collected the cashback, and the bot rejects them on purpose (H17).
- **Atomic cross-pool arbitrage:** cannot lose per attempt, but in pre-wall blocks 73% of arbitrages landed in the same block as the trade that opened the gap and 22% in the next; trades two or more slots late held about 0.05% of the value. The bot lands about 23 slots late, so its prize is crumbs.
- **Funding carry** (spot meme plus a short perp): about +4.7% a year median in dollars over 18 Hyperliquid meme perps, two liquidated even at 1x, and about −1.6% a year median once made flat in SOL. Also derivatives and cross-chain (owner rules).
- **Being the LP:** any wallet can deposit into a canonical PumpSwap pool (20 bps LP fee above 420 SOL cap, 2 bps below), but on pre-wall daily data across about 250 established coins the median LP result was −2.5% to −7.4% in SOL; today's median volume earns an LP about 1.9% a year, below staking. Meteora DLMM: high fees, but concentrated positions turn into the dying token bin by bin; the only net study (Uniswap v3) shows impermanent loss above fees.
- **BOOST, the Mayhem agent, the PUMP buyback:** all public and rule-bound, but BOOST is taken by snipers within seconds and conflicts with H10, Mayhem prices are synthetic (a 0.023 SOL agent sell moved virtual SOL from 43.80 to 32.01), and each buyback buy moves PUMP about 0.005%.
- **Holder rewards:** paid by one off-chain operator key on its own choice of wallets; a sliver on top of a directional position.
- **LST arbitrage band, creator-fee seats, cranks, front-page attention, retail-bot defaults, DCA orders, unlocks:** closed, out of reach without launching coins or acting on users' orders, or statistical after all.

### 7.5 What this changes

Nothing replaces a proven price rule. Staking and all-or-nothing entries only stop the bot losing SOL to idleness and fees; the hygiene work stops false signals. Evidence files are in the RES-7 session scratchpad and were not committed (raw RPC reads).

## 8. Longer horizons, speed and costs (RES-8, 2026-10-07)

Owner, 7 Oct: "So ur giving up?" and "How do we solve this? Speed ... Costs ...". Both are answered with pre-registered tests on pre-wall data and a research pass with critics; nothing here is registered for the bot.

### 8.1 Longer horizons (removes speed and cost, exposes direction)
- **Daily probe** (`research/daily-probe/RESULTS.md`): five rules on 477 pump.fun coins, holds of 1–7 days: all **not supported**. Costs stop mattering at this horizon; the problem is that coins fall (buy-everything lost about 9% a week in 2026-08-16 to 09-20, even on a survivor-only list). D-REV3 (buy after a 22%+ daily fall, hold 3 days) was positive in both periods (+6.7%, +3.6%) but rests on a few big winners (median −11%), loses in the larger coins, and is the kind of result survivor bias creates: unproven until a survivorship-free re-test.
- **Trend probe** (`research/trend-probe/RESULTS.md`): weekly time-series and cross-sectional momentum on 19 large memes in SOL, 2024 to the wall: all **not supported**. A basket of large memes rose 26% against SOL to mid-2025 and fell 51% after; every timing rule did worse than holding SOL.

### 8.2 Speed: do not buy it
- The money that needs speed is same-block arbitrage (about 99% of arbitrage value lands in the same block as its trigger; a few bots hold most of it). Competing needs leader shreds and co-located bare metal, an UNVERIFIED estimate of US$1,400–3,400 a month.
- The bounce after a sharp drop fades over minutes, not seconds; the bot already enters 1–6 s after a 5-minute bar (base case 3–12 slots at about 0.27 s; the conservative case is about 6.2 s, not 9 s). Cutting that gains almost nothing, and a subscription adds cost per trade ($49 a month is about 0.27% of each $200 trade at 90 trades a month).
- Pre-positioning instead of racing: a resting Meteora DLMM limit bid fills in the drop's own block, but only about 15 of 40 deep-pool coins have such a pool, fills that come through arbitrage save nothing, and adverse selection (it fills first on collapses) works against it. Research-only; it needs the owner (new venue and signer program) before any build.

### 8.3 Costs: the venue fee is the floor
Measured round trip (pool depths read on chain for 474 canonical pools on 2026-10-06): best PumpSwap seat about 0.66% at $100, 0.87% at $500. Cheaper seats exist only for older, larger pump coins on other venues (Raydium AMM v4 0.25%: about 0.51–0.65%; Fartcoin's Orca 0.16% pool: about 0.33–0.40%), which need the owner, and no bounce has been measured there. Real depth is 1.0–1.6× the repo's constant-product model (impact slightly overstated outside the 0.30% tier). Fixed costs (rent, failed exits) decide results only at $2–$20.

### 8.4 A correctness risk for the supervisor
Slot time is hard-coded as 400 ms (`packages/worker/src/engine/strategy.ts` line 1749, `packages/backtest/src/sim/world.ts` line 61, `packages/backtest/test/study-world.ts` line 21). Solana slots have run at 250 ms since epoch 1037 (2026-09-18) and 200 ms is scheduled from epoch 1052 (about 2026-10-08, UNVERIFIED estimate); the pre-wall data spans 400, 350, 300 and 250 ms. Pool updates dated from a slot anchor can be off by up to about 22.5 s (30 s at 200 ms). Suggested fix: derive slot duration from consecutive block-time anchors in the event stream, the same function live and in the backtest, with a test that fails before and passes after.

### 8.5 Where this leaves the search
Every horizon tested so far loses after costs in SOL: minutes (the bounce is smaller than the fee), days and weeks (memes drift down against SOL). The open threads are D-REV3 on a survivorship-free coin list (needs the dead coins' prices: the paid history month, or about 85,000 free calls), and the registered attempt 1.

## 9. "Not perfect, but profitable at the end of the month" (RES-9, 2026-10-07)

Owner, 7 Oct: profitable over a month or over 100 trades, either with a win rate above 50% or with a low win rate and big winners.

### 9.1 What "profitable over 100 trades" needs
Every test above already scored the average net profit per trade after costs; none demanded perfection. A rule fails when its average is negative. The shape of the exits sets the win rate, not the profit: on a price with no drift, a +1/−3 bracket wins about 59% of the time on the 41 deep pools and still loses about 1.2% a trade (RES-9 evidence pass, pre-wall data). The break-even win rate is p* = (L + c + q(1 − L))/(W + L) with q the share of total losses: a +2/−6 bracket at $200 in a deep pool needs 86% wins, 98% if 1% of trades go to zero. A big-winner shape at a 5% win rate needs an average winner of about +1,770%.

### 9.2 Scorecard of every rule tested, in those terms ($200, after costs; `research/scorecard.json`)

| Rule | Win rate | Avg win | Avg loss | Per trade | Months in profit | P(100 trades end positive) |
|---|---|---|---|---|---|---|
| 5-minute dip-buys (all versions) | 30–37% | +2.2 to +2.8% | −2.2 to −3.3% | −0.7 to −1.2% | 0 of 3 | 0–2% |
| 5-minute breakout | 24–28% | +5.0% | −3.9% | −1.4% | 0 of 3 | 0% |
| Daily: buy after a 22%+ fall, hold 3 days (survivor list) | 44% | +45.6% | −26.0% | +5.7% | 2 of 4 | 68% |
| Daily: buy weekly top gainers, hold 7 days (survivor list) | 32% | +64.7% | −29.5% | +0.7% | 2 of 4 | 44% |
| Daily: buy everything (survivor list) | 29% | +13.1% | −8.7% | −2.3% | 0 of 4 | 9% |
| Lottery basket of fresh graduates, hold 7–30 days ($20, random sample) | 2–4% | +15 to +119% | −25 to −41% | −24 to −40% | — | 0% |
| Weekly trend on 19 large memes (in SOL) | 35–48% of weeks | | | −0.2 to −1.9% a week | | |

### 9.3 The one apparent winner was survivor bias
The daily dip rule's +5.7% came from a list that holds only coins still alive on 2026-10-06. A random sample showed that list contains 1 of 33 coins that ever reached the size the rule trades; the other 32 later died. On the random sample the few eligible trades all lost. A full re-test on 16,367 coins (dead ones included) is downloading in random order (`research/daily-probe/RESULTS.md`).

### 9.4 Settings that would block these shapes anyway (owner rules, for the record)
The trial policy allows 1 open position and 3 entries a day and caps the stop at 20%; R8 pauses after 5 losses in any 20 trades (58% of 20-trade windows at a 75% win rate, 99% at 50%); the proof gates cap the share of trades losing 50% or more and the share of profit from the top 1% of trades, which a no-stop big-winner basket fails by design. Only the owner can change these.
