# Step A count rows from sweeps 1–2, and a Design A amendment

Drafted 2026-10-08 19:30 Melbourne by the brainstorm partner. Every row below reads flows, counts and timing on the Step A days. **None reads a strategy return**, so they sit outside the loop family. An idea earns its own pre-registration only if its row clears the threshold given. Each threshold is fixed now, before any Step A row is read. Chances are judgement.

## 1. DEV-ZERO: the creator's exit releases screen-filtered buyers (about 0.15%)
- Event: in a canonical non-mayhem SOL pool at least 60 minutes after migration, a sell by the creator (`creator` / `coin_creator`, which matches H12) that crosses their share below 5% of supply. Placebo cutoff: 4.2%. Then, in a fixed order, the zero flag (control: near-full exits that leave 0–10%) and below 3% (placebo 2.4%).
- Excluded: dev "exits" made by token transfer, and near-full controls where the dev sells again inside the window.
- Row: excess first-time buyer SOL in (event + 23 slots, event + 15 min] against the controls, minus excess selling by existing holders. Exclude BOOST, protocol and creator-group rows.
- **Earns a PREREG if:** at the median event the net excess is at least 3.4% of effective quote, with a 95% lower bound above 0; at least 50% of it lands after 23 slots; and there are at least 11 eligible events a day.

## 2. REBUY-ANCHOR: wallets that sold at a profit buy back below their sale price (about 0.3%)
- Uses H1-CGO's per-(mint, owner) cost ledger, with exit price, realised gain and a signer-equals-owner flag.
- Rows:
  - the odds of a rebuy when the price is below the ex-holder's sale price versus above it;
  - the same odds for gain-sellers versus loss-sellers;
  - the share of gain ex-holders who rebuy within 2 hours once the price is below their sale price, by exit size.
- **Earns a PREREG if:**
  - both odds ratios are at least 1.5, with 95% lower bounds above 1;
  - predicted net rebuy SOL over 2 h (P90 against the median of the rebuy-pressure measure) is at least 3.4% of effective quote;
  - at least 80% of proceeds can be read;
  - at least 30 decisions a day sit in the top quintile;
  - its R² on past returns, drawdown, age and depth is below 0.3.
- Counter-evidence to keep in view: 0 of 35 large unabsorbed sales recovered within the hour (`research/absorption-probe/RESULTS.md`).

## 3. SEAT-DRIFT: graduates from crowded minutes found late (about 0.15%)
- State: N_m, the count of other migrations in [m − 90 s, m + 90 s], frozen with G1-CAP's definitions (G1 amendment 2).
- Row: first-time buyer SOL in (m + 60 min + 23 slots, m + 120 min], busy-minute graduates minus lone ones; and the same difference in [m + 40, m + 60 min].
- **Earns a PREREG if:** the first difference is at least 3.4% of effective quote at the median, with a 95% lower bound above 0, and the second is not negative.

## 4. AGE-GATE: coin-age thresholds in tools (about 0.1%)
- Row: first-time buyer SOL around round coin ages (5, 10, 15, 30, 60 min after create or migration) against local placebo ages at ±3, 4, 5, 7 and 11 minutes, split by buyer class (W1).
- No pre-positioned trade is ever built from this: buying ahead of users' standing auto-buy presets would front-run pending orders, which the owner's rules forbid.
- **Earns a note in the bot's exit-hazard list if** a step is found (a negative step is expected). It never earns a trade.

## 5. Two-sided cluster detector (MM-FLOOR, WASH-ECHO)
- Row: clusters that both buy and sell the same mint within short windows, using the hub-cap-50 rule and a hub-keyed rule side by side. Report the share of volume and the size distribution.
- Used only as a label: to exclude fake demand from the other designs' "first-time buyer" counts. It never earns a trade.

## 6. Design A amendment (round 8 proposal): the round-USD check
- At the repo's $119.26 a SOL, 420 SOL is about $50,089, and the 340–1,300 SOL placebo grid contains $100k (about 838.5 SOL).
- For each tape day, read SOL/USD from the Binance public archive (no credits). Report bunching at the SOL levels equal to $50k and $100k that day.
- Drop placebo cutoffs within 10% of those levels.
- If 420 SOL lies within 5% of a round USD level on every tape day, A's effect is recorded as "not separable from a USD level", whatever the gates show.
- Gate 3 adds a descriptive split: creators focused on one coin versus spread over several (same creator-group definition), fed by tape v2's CF table of creator-fee collections.
