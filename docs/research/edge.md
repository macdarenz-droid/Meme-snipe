# Where an edge could clear our real costs (RES-4)

Task RES-4, 2026-10-04 (Melbourne). Owner request: raise the odds of a proven strategy honestly, never by lowering a bar. Sources: repo research (`docs/research/*.md`, own data in `research/`) and cited papers; nothing new was downloaded and no practice or holdout day was read. Anything not verified is marked.

## Owner summary

What could work: buying dips in tokens that survived their first day and still hold at least $50k of liquidity, once the selling has stopped (H1), or steady quiet buying in those tokens (H2). Studies of small coins find sharp falls tend to bounce back partly, while chasing rises tends to lose.

What is unlikely: anything in the first hour after a token moves to PumpSwap, copying wallets, and most fresh-launch setups. Our data and others' show most are planned dumps.

Costs on PumpSwap: a $2 trade must gain about 3.7–4.4% just to break even; at $20 that falls to 2.2–3.0%.

On practice days the study picks at most one idea per type, then tests it once on days no rule saw. Fresh-launch ideas probably cannot reach the 300 trades needed by 20 Oct, so they may end "not proven".

## 1. Cost math per setup

How the proof scores a trade (conservative scenario, `FILL_CONFIG` fills-2): exact CORE-2 quotes on mainnet fee configs (`packages/core/test/amm/fixtures/fee-configs.json`), at the real size; both legs' venue fees and price impact; base fee, priority fee (20,000 lamports, ladder rung 1) and the 5,000-lamport tip on each landed leg; failed attempts that land and pay (conservative: 56% land on PumpSwap, 40% on the curve, 20% of misses never reach a block); token-account rent (1,513,840 lamports) refunded only when the atomic sell-and-close lands (DECISIONS "Rent", RENT-1): 90% close success × 95% no dust = 85.5%, so 14.5% of the rent is lost on average. SOL at $119.26. Reproduce: `node --no-warnings packages/backtest/src/research/edge-costs.ts` (writes `research/edge/costs.json`; `packages/backtest/test/edge.test.ts` checks the file matches the code).

Not in the table, but charged by the backtest on top: the price moving against us while an order lands (6 slots at p90, and ×1.5 on any shortfall against the quote), and repeated exits getting 5% less each time (`exitRetryHaircutPpm`). These are not fixed costs; every 1% of adverse move adds 1% to the hurdle.

Conservative scenario: land pump-curve 40%, pumpswap 56%; 20% of misses never land; rent back with probability 85.5%. SOL $119.26.

| Setup | Size | Fee/side | Fees+impact (both legs) | Fixed (lamports) | Fixed % | Break-even move | Break-even, no rent back |
|---|---|---|---|---|---|---|---|
| pump curve (fresh) | $2 | 1.25% | 2.58% | 339,507 | 2.02% | **4.60%** | 12.32% |
| pump curve (fresh) | $5 | 1.25% | 2.74% | 339,507 | 0.81% | **3.55%** | 6.63% |
| pump curve (fresh) | $20 | 1.25% | 3.53% | 339,507 | 0.20% | **3.74%** | 4.51% |
| young PumpSwap (at migration, ~411 SOL cap) | $2 | 1.25% | 2.51% | 310,935 | 1.85% | **4.36%** | 12.08% |
| young PumpSwap (at migration, ~411 SOL cap) | $5 | 1.25% | 2.56% | 310,935 | 0.74% | **3.31%** | 6.39% |
| young PumpSwap (at migration, ~411 SOL cap) | $20 | 1.25% | 2.85% | 310,935 | 0.19% | **3.03%** | 3.80% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $2 | 0.95% | 1.89% | 310,935 | 1.85% | **3.74%** | 11.46% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $5 | 0.95% | 1.90% | 310,935 | 0.74% | **2.64%** | 5.73% |
| U1 survivor ($50k quote, ~9995 SOL cap) | $20 | 0.95% | 1.96% | 310,935 | 0.19% | **2.15%** | 2.92% |
| U1 survivor at the 1.15% tier (upper bound) | $2 | 1.15% | 2.28% | 310,935 | 1.85% | **4.14%** | 11.85% |
| U1 survivor at the 1.15% tier (upper bound) | $5 | 1.15% | 2.29% | 310,935 | 0.74% | **3.03%** | 6.12% |
| U1 survivor at the 1.15% tier (upper bound) | $20 | 1.15% | 2.35% | 310,935 | 0.19% | **2.54%** | 3.31% |

| Setup | Size | +10/−5 | +20/−10 | +30/−15 | +50/−20 |
|---|---|---|---|---|---|
| curve | $2 | 64.0% | 48.7% | 43.6% | 35.1% |
| curve | $5 | 57.0% | 45.2% | 41.2% | 33.6% |
| curve | $20 | 58.2% | 45.8% | 41.6% | 33.9% |
| young | $2 | 62.4% | 47.9% | 43.0% | 34.8% |
| young | $5 | 55.4% | 44.4% | 40.7% | 33.3% |
| young | $20 | 53.6% | 43.4% | 40.1% | 32.9% |
| u1 | $2 | 58.3% | 45.8% | 41.7% | 33.9% |
| u1 | $5 | 51.0% | 42.1% | 39.2% | 32.3% |
| u1 | $20 | 47.6% | 40.5% | 38.1% | 31.6% |
| u1-1.15 | $2 | 60.9% | 47.1% | 42.5% | 34.5% |
| u1-1.15 | $5 | 53.6% | 43.4% | 40.1% | 32.9% |
| u1-1.15 | $20 | 50.2% | 41.8% | 39.0% | 32.2% |

The second table is the break-even win rate of a bracket exit (+W / −L gross), cost included: p = (L + c) / (W + L).

What this means:
- **Rent decides small trades.** At $2, losing the rent when the close fails (14.5% of the time) costs 1.3% of the trade on average; never getting it back would cost 9.0%. RENT-1's sell-and-close is worth more than any signal at this size.
- **Larger trades halve the hurdle.** From $2 to $20 the U1 break-even falls from 3.74% to 2.15%, and young PumpSwap from 4.36% to 3.03%. That is information for the owner's later decision on limits; it changes nothing now.
- **Cheaper venues.** Our transaction builders (TX-1) support only the pump curve and canonical PumpSwap pools. Non-canonical PumpSwap pools (0.30%) are refused by H5 because their liquidity can be withdrawn; Raydium and others have no builder. So **no cheaper venue is available**; U1's lower tier (0.95% at the $50k floor, falling with market cap) is the cheapest route we have.
- **The proof's bar is higher than break-even.** §14 sizes the proof for a +5% net edge (the smallest worth trading), so a hypothesis needs roughly **break-even + 5% gross per trade**: about 8.7–9.1% on U1 and 9.4% on U2 at $2.
- **Count matters as much as edge.** The holdout is entries in [09-22, 10-20), 28 days, and needs n ≥ max(300, n_power): **at least about 11 entries a day** per universe.

## 2. Ranked hypotheses

Ranked by the strength of the prior evidence, then by whether the holdout can reach 300 trades. Grades as in `signals.md` §9 (A peer-reviewed or reproducible on Solana/pump.fun 2025–26; B reputable, other venue or older; C partial method; D unverified).

Candidate counts are estimates, not measurements (grade D): graduations are about 1,300 a day (49.7k launches × 2.6%, venues.md, measured 2026-10-03; 4.7–6.7% after BOOST per The Block, so up to ~3,300). Only 4.0% of graduates kept more than $10k of total liquidity a day later (empirical.md Q1, n = 405); a $50k quote side ($100k total) is rarer, guessed 0.5–1.5% → 6–20 new U1 pools a day, perhaps 30–150 live at once. BT-2's funnel count on practice days replaces every count here before anything is frozen.

| Rank | Hypothesis | Mechanism | Prior evidence | Entries a day (est.) | Needed edge ($2) | Exit | Holdout can reach 300? |
|---|---|---|---|---|---|---|---|
| 1 | **H1 U1 dip-reversal**: a survivor ≥ 35% below its high since migration, the last hour no longer falling, a higher low, quote vault down ≤ 10% in 60 min (it also falls on ordinary sells, not only on liquidity pulls), wash share ≤ 60% | Small, illiquid coins revert after sharp falls; a token that survived the dump window with deep liquidity has buyers who defend it | Reversal in small/illiquid coins, distance from the recent high predicts more reversal (Fičura 2023, t = −7.31 / −9.03, B); illiquid losers revert (Begušić & Kostanjčar, B); our own data: strength after migration predicts worse outcomes, weakness less bad (empirical.md Q2, own data) | 3–30 | > 3.74% to break even; ~8.7% gross to prove +5% | U1 policy exits: stop 3 × ATR(14, 5-min) and a hard stop 15% below entry, half off at +2R, flat exit 30 min, T_max 120 min | Possibly |
| 2 | **H2 U1 quiet accumulation**: net SOL inflow ≥ 1% of the reserve in 60 min from ≥ 8 buy-only wallets, wash share ≤ 40%, not chased (≤ +10% in 60 min), low turnover | Steady buying by distinct wallets without wash or chase is demand the price has not priced yet | Reversal in small coins is tied to low volume (Fičura, B); raw buyer counts are inflated by sniper rings, so only buy-only wallets count (Kamat 2607.02795, repo); no direct evidence for forward returns (gap, signals.md §9.3) | 2–20 | as H1 | as H1 | Possibly |
| 3 | **H3 U1 range breakout** (risk.md S2; BT-2's U1 placeholder): price above its 6 h range high, 15-min volume ≥ 2× the range average, holders +5%, cap ≥ 1,470 SOL | Breakouts with volume and new holders attract followers | Momentum holds only in large, liquid coins (Liu, Tsyvinski & Wu, J. Finance 2022, B; Begušić, B); for coins this small the evidence points the other way (signals.md §9.3). Kept because the plan names it and BT-2 registered it | 1–10 | as H1 | as H1 (BT-2's structure stop: 1% below the 60-min low) | Unlikely |
| 4 | **H4 U2 reclaim with our hard rejects** (risk.md S1; BT-2's U2 placeholder): ≥ 30% flush since migration, a higher low ≥ 5% above it, VWAP reclaimed, net flow > 0, every GATE-1 reject passed | Graduates that survive the first hour and reclaim their average price may carry real demand | MELT (A): concentration and fast launches mark dumps; our hard rejects remove them (H9 instant graduations: median −97% at +1 h vs −66%, empirical.md Q2). No study measures returns after 60 min (signals.md §9, gap) | 1–4 (DECISIONS funnel estimate, ±3×) | > 4.36% to break even; ~9.4% gross to prove +5% | U2 policy exits: stop 3 × ATR(14, 1-min), half off at +1.5R, flat exit 15 min, T_max 120 min | No (≤ 112 in 28 days) |
| 5 | **H5 U2 exhausted dump**: ≥ 60% below the high since migration, the first 20 curve buyers have sold ≥ 80% of what they bought, the creator holds ≤ 1% of supply, 15-min net flow ≥ 0, a higher low | Once insiders have sold, the remaining flow is not a scheduled dump | MELT (A): early buyers and bundles sell into the pool after migration; pump-and-dumps fade within an hour (Li, Shin & Wang, JFQA, B; numbers from a summary only). Nothing measures what follows. **Known weakness:** "sold" is measured from trades only; token transfers are not in the data, so an insider who moves tokens to another wallet looks like a seller and the dump may still be ahead | 0.3–2 | as H4 | as H4, hard stop 20% | No |
| 6 | **H6 = H1 only when SOL rose over 24 h** | Large memecoins track the market; a falling market adds sell pressure | Large-cap memecoins correlate with BTC at 0.78 (Krause, SSRN, D: page not opened); regime gate (§6.4) | about half of H1 | as H1 | as H1 | Less than H1 |

Excluded, with the evidence that rules them out:
- **Copy-trading / smart money (U3):** about −11% a trade, 0 of 120 variants positive (RES-2, copytrading.md).
- **Graduation to +60 min, including the +5-min momentum and BOOST windows:** 0 of 72 rules positive after costs; strength at +5 min is the most negative signal (empirical.md Q2–Q3; §3.1).
- **Bonding-curve late-stage entry (risk.md S5):** the curve is paper-only research (§3.1) and its own author expects it to be negative after the 1.25% fee and latency.
- **Holder-reward coins (post-B4) as a signal:** no evidence either way; not registered.

## 3. Pre-registration

File: `research/edge/preregistration.json`, sha256 `0841c1c6a03d3dc9fd91d2630bbe92cdc4200149e858e83be35309a9d692b8ef`. Written before any practice day was read by RES-4; a changed value is a new trial.

- **Thresholds are chosen in advance, never fitted.** f_dd ≤ −0.35 / −0.60, f_ret60 bounds and the stops follow the evidence above; f_turn60 ≤ 0.5, f_indep60 ≥ 8, f_2side60 ≤ 0.4 / 0.6, f_liqchg60 ≥ −0.10 and f_early_sold ≥ 0.80 are **round values picked before any data**, with no data behind the exact number.
- **What BT-2 must do (requirement, not built yet; given to BT-2 by the supervisor):** one run builds an SPA panel over all six hypotheses and S0 per universe; the practice days pick at most one hypothesis per universe for the holdout; BT-2 loads this file and refuses a freeze if its hash differs. The SPA family is **k = 6**; the Holm family for the holdout stays **2 (U1, U2)**. Any later variant is a 7th trial and needs a new, never-run holdout window.

- Shape: BT-2's `UniverseConfig` (window, rules, edgePpm, medianTargetBps). H1, H2, H5 and H6 use the `features` rule kind over RES-3's as-of features; H3 and H4 are BT-2's own `U1`/`U2` rules, unchanged.
- **BT-2 note:** its `FeatureRules` comment says "one or two conditions"; H1, H2, H5 and H6 have five or six. The type allows any number; BT-2 must evaluate all of them (an unknown feature fails its condition).
- Exits: the policy's per-universe exit blocks (CFG-2) copied verbatim, T_max 120 min (§9 phase-1 cap). The test fails if the policy changes without a new registration.
- U1's $50k floor comes from H8 (the policy's `u1FloorUsd` on the effective quote reserve), not from the check window's `minQuoteLamports` (100 SOL), which only schedules checks.
- Size: policy `minNotional` ($2 trial). edgePpm 50,000 is §14's +5% bar, not an estimate.
- Checks: `packages/backtest/test/edge.test.ts` (features exist and are as-of, no sample-rate-dependent count such as f_grad24 or f_dep24, exits equal the policy, the file's hash is the one above).
- No holdout day is read by anything here.

## 4. What the study will settle

- For each registered hypothesis: whether its out-of-sample mean beats costs and the random control S0 (G1 on practice days, then G2 once on the sealed holdout, Holm across universes).
- Which hypotheses cannot reach 300 trades by 2026-10-20: these end "not proven yet", not "failed"; a later, never-run window can try again at a smaller error budget (DECISIONS, attempt k ≥ 2).
- If none pass, the honest result is that no tested setup earns more than its costs at $2, and the bot keeps abstaining.

## 5. Could not verify

- Every entries-a-day figure (grade D): BT-2's funnel count on practice days decides.
- The U1 survivor rate at a $50k quote side: only the $10k total-liquidity rate is measured (4.0%, a pre-BOOST regime).
- Krause (SSRN 6292920): page returned 403; the correlation figure is from a search snippet.
- Li, Shin & Wang: figures from a search summary; the PDF was not opened.
- Fičura's sign convention for "distance from the high" was not checked in the full text.
