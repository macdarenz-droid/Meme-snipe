# G1 amendment 2: BOOST's price cap, the G1-CAP arm, quote-mint strata

Drafted 2026-10-08 19:30 Melbourne by the brainstorm partner, from idea sweep 2 (`research/brainstorm-loop/SWEEP_2.md`). It must be frozen before any Step A row is read for G1. G1's own primary is unchanged.

## 1. Correction to amendment 1 (BOOST limit)
- `boost_buy_and_burn` takes `quote_amount_in` and `min_base_amount_burned` (checked in `research/shared-tape/tapedec/idl/pump_amm.json`; the program code was not read).
- A minimum number of tokens for a fixed amount of SOL is a **price cap**: BOOST refuses to pay more than `quote_amount_in ÷ min_base_amount_burned`. Amendment 1 called it a floor; that was wrong.
- The risk for G1: if early buyers push the price above the cap, BOOST stops buying at exactly the moment G1 wants to sell to it.
- Amendment 1's gate (c) needs at least 25% of BOOST quote spent after m + D on most graduates. That already kills G1 if caps stop BOOST early. No new gate is added.
- Descriptive rows added to G1-0(c):
  - the share of BOOST slices with a non-zero cap, read from the S_amm limit field if it carries the argument (UNVERIFIED; otherwise "unknown");
  - BOOST slices that failed on slippage (F rows with `err_class` = slippage and the BOOST instruction);
  - BOOST quote left unspent at m + D, m + 150 and m + 300 slots, split by capped and uncapped.

## 2. G1-CAP: G1 only when few rivals split the opening buyers (its own loop-family member)
- Who pays: as G1. When many curves complete together, the opening buyers' money is spread over more coins. On about 85 SOL of effective quote, each SOL of net buying moves the price about 2.4% (arithmetic). Chance about 0.5% (judgement).
- **State, as of t0 + D − 1:**
  - N(t) = other SOL-quoted, non-mayhem coins, not in the coin's creator cluster (amendment 1's definition). It counts curves holding at least 68.0 real SOL that have not completed, plus migrations in [t − 90 s, t].
  - λ = the trailing-hour mean of N on a 10-second grid. Z = N − λ.
  - Coins whose normalised name or symbol matches another coin in the window are excluded (theme waves).
- **Gate additions (Step A; no returns read):**
  - (a) G1-0 passes.
  - (b) |Spearman ρ(Z, λ)| ≤ 0.3, and the IQR of Z is at least 1.
  - (c) Net opening flow falls as Z rises. Net flow = first-time buys minus pre-migration holders' sells in [m, m + D], without BOOST or protocol rows. Need ρ ≤ −0.10, with a pool-clustered one-sided 95% upper bound below 0. The sign is fixed now and is never flipped.
  - (c2) Buying by W1's fast class in [m, m + D] must also fall as Z rises. Otherwise G1-CAP closes, because the snipers buy every migration and are not being split.
  - (d) At least 50 catchable triggers a day with Z at or below the median.
- **Arm:** G1's frozen rule on triggers with Z at or below the discovery median. That median is committed before any validation day is read.
- **Judgement:** G1 §9 on the subset, plus a point lift above 0 over both unfiltered G1 and G1's S0. Fewer than 300 trades is unresolved; forward days are then named before any is read.
- **Futility:** as amendment 1 (G1-CAP closes with G1 unless its own one-sided 95% upper bound on discovery is above 0).

## 3. Quote-mint strata (descriptive only)
- USDC-quoted and token-quoted curves are counted separately from SOL curves in G1-0: triggers, share with InitBoost, BOOST quote unspent after m + D, and distinct buyers in [m, m + D].
- They are never traded under G1. The bot rejects non-SOL quotes.
