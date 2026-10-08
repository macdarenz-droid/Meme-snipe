# Idea sweep 2 (2026-10-08)

Lenses: threshold-triggered tools, other bots' habits, cross-coin state, other launchpads, gaps in the research programme. Two skeptics (economics and evidence; truth and owner rules) judged every idea, then one synthesis. Run 18:13–19:22 Melbourne, 8 agents. No market data was read. Every chance is judgement.

Honest summary: nothing beat sweep 1's best (G1-HC, about 2%). The best new idea, G1-CAP (about 0.5%), is another filter on G1. The sweep's value is three corrections, checked by the partner at 19:25:
- BOOST's `min_base_amount_burned` caps the price BOOST will pay; it is not a floor. IDL args `quote_amount_in`, `min_base_amount_burned` were checked in tapedec/idl/pump_amm.json; the program code was not read.
- Design A's 420 SOL is about $50k at $119.26 a SOL, so it may be read as a round USD level.
- Tape v2 S rows carry `tx_fee`, `cu`, `jito_tip`, `top_program` and `cu_price`, and v2 has a CF table of creator-fee collections. Only the v1 units stored before 2026-10-08 07:30Z lack them (research/shared-tape/README.md lines 33–35 and 67–72).

## All ideas and the skeptics' votes
| Id | Idea | Skeptics keeping it | Skeptics' chances (econ+evidence / truth+rules) |
|---|---|---|---|
| s2-thresholds-1 | DEV-ZERO: the creator's full exit flips terminals' 'dev holding' / 'dev sold' screens; buy after the exit, sell into the buyers it releases | 2 of 2 | 0.2% / 0.2% |
| s2-thresholds-2 | USD-STEP: SOL-pushed crossings of round USD market caps (the pool is flat in SOL; only its dollar label crosses) | 0 of 2 | 0.03% / 0.05% |
| s2-thresholds-3 | AGE-GATE: deterministic age thresholds in terminal filters and auto-buy presets (with a free holder-milestone arm) | 2 of 2 | 0.05% / 0.1% |
| s2-bot-habits-4 | CLOCK-CROWD: be holding before bots whose buy rule is a coin-age timer | 0 of 2 | 0.05% / 0.05% |
| s2-bot-habits-5 | MM-FLOOR: ride a capacity-backed keep-alive market-making bot's bid | 1 of 2 | 0.1% / 0.15% |
| s2-bot-habits-6 | WASH-ECHO: buy after a volume bot's sell leg, sell into its next buy leg | 1 of 2 | 0.1% / 0.1% |
| s2-cross-coin-7 | G1-CAP: G1 only when few rival curves and graduates split the opening demand | 2 of 2 | 0.4% / 0.7% |
| s2-cross-coin-8 | SEAT-DRIFT: busy-minute graduates' delayed discovery, entered at +60 min | 1 of 2 | 0.15% / 0.4% |
| s2-cross-coin-9 | A-FOCUS: Design A only where the creator's capital is not spread across other coins near the step | 0 of 2 | 0.15% / 0.1% |
| s2-other-launchpads-10 | FARM-CURVE: sell DBC farm-curve inventory to the completion buyer before migration | 1 of 2 | 0.1% / 0.2% |
| s2-other-launchpads-11 | CLONE-BET: a DBC clone farm's ticker choices as a costly bet on the pump original's search flow | 0 of 2 | 0.05% / 0.05% |
| s2-gaps-12 | REBUY-ANCHOR: wallets that sold a young coin at a profit buy it back below their sale price (young pools, hours 1-12, 2 h hold) | 2 of 2 | 0.4% / 0.4% |
| s2-gaps-13 | USDC-SEG: the G1/BOOST seat in the USDC-quoted segment, where the competition may be thinner | 0 of 2 | 0.15% / 0.05% |

## Synthesis (verbatim)


All chances below are my judgement. "Verified" means I read it in the repo today, at the path given. Terminal and app behaviour that I could not check is marked UNVERIFIED.

## 1. Survivors (ranked)

### 1. G1-CAP: G1 only when few other curves and graduates compete for the opening buyers
- **Votes:** 2 of 2 judges kept it.
- **Who pays:**
  - BOOST, about 17.58 SOL of buying per graduate.
  - The opening buyers at migration. When many curves complete together, their money is spread over more coins.
- **Why it is new:** it restores the demand half of G1-XB. AMENDMENT_1's Feature R covers only supply (verified, `research/g1-boost-inventory/AMENDMENT_1.md`).
- **Size of the effect (arithmetic):** on about 85 SOL of effective quote, each SOL of net buying moves the price about 2.36%. So a difference of 2–4 SOL in net opening flow is worth about 5–9%.
- **State, frozen before Step A:**
  - N(t) counts other coins that are SOL-quoted, not mayhem, and not from the coin's creator cluster. It includes curves with at least 68.0 real SOL that have not completed, plus migrations in [t−90 s, t].
  - λ is the trailing-hour mean of N on a 10 s grid. Z = N − λ, read at t0+D−1.
  - New exclusion: coins whose normalised symbol or name matches another coin in the window (theme waves).
- **Gate (reads no returns):**
  - (a) G1-0 passes.
  - (b) |ρ(Z, λ)| ≤ 0.3, and the IQR of Z is at least 1.
  - (c) Net opening flow falls as Z rises. Net flow is first-time buys minus pre-migration holders' sells in [m, m+D], leaving out BOOST and protocol rows. Required: ρ ≤ −0.10, with a pool-clustered one-sided 95% upper bound below 0.
  - (c2) W1 fast-class buy SOL must also fall as Z rises. If it does not, close: the snipers buy every migration at once and are not being split.
  - (d) The low-Z half has at least 50 catchable triggers a day.
  - Descriptive row, with the sign fixed in advance: BOOST quote still unspent at m+D, by Z tercile.
- **Primary test:** G1's frozen rule, on validation triggers with Z at or below the discovery median. That median is committed before any validation day is read.
  - $50 is the primary size. $5, $20, $100 and $1,000 are reported with costs split out. $10,000 is infeasible: only about 8.5 SOL is left on the curve at 90%.
  - Pass needs all of: 99.5% lower bound above 0, at least 300 trades, each day above 0, and lift above 0 over both G1 and G1's S0. Then a forward confirmation.
- **Kill:**
  - any gate item fails;
  - ρ comes out positive (the sign is never flipped);
  - G1 fails futility and G1-CAP's own one-sided 95% upper bound is below 0;
  - on validation, the lower bound is ≤ 0, the lift is ≤ 0, or any day is ≤ 0.
  - Fewer than 300 trades means unresolved, and forward days are named first.
- **Frequency:** about half of G1's catchable triggers, so at least 50 a day if G1-0 passes. Probably needs forward days to reach 300.
- **Owner flags:**
  - Same as G1: the curve leg is paper-only and sits inside H10's excluded window.
  - Correction to the proposer: no extra live feed is needed. G1 already has to watch every curve to find its 90% triggers. This is reasoning, not a measurement.
  - Counts as one member of the loop family.
- **Chance:** about 0.5%, moving with G1's own prior.

### 2. REBUY-ANCHOR: wallets that sold at a profit buy back below their sale price
- **Votes:** 2 of 2 judges kept it.
- **Who pays:** gain-sellers who rebuy below their sale price. This is the repurchase effect (Strahilevitz, Odean & Barber, JMR 48 (2011) S102–S120). The evidence is from stocks, and only the abstract was read.
- **Gate (Step A, flows only, outside the family):**
  - (a) Odds of a rebuy below the sale price versus above: at least 1.5, with a 95% lower bound above 1. The gain-seller versus loss-seller odds ratio also needs a lower bound above 1.
  - (a2) New: the share of gain ex-holders who rebuy within 2 h once below their sale price, split by exit size. This tests the absorption probe's 0-of-35 result directly.
  - (b) Net materiality: predicted rebuy SOL minus continued selling over 2 h, P90 against median RB, within drawdown terciles. It must be at least 3.4% of effective quote.
  - (c) Coverage: at least 80% of proceeds have a SOL reading no older than 2 h. SOL counts as missing where signer ≠ owner.
  - (d) At least 30 decisions a day at RB ≥ P80.
  - (e) R² of RB on past returns, drawdown, age and depth below 0.3 (tightened from 0.5).
- **Primary test:**
  - Decisions every hour from m+60 min to m+12 h. Entry $50 at the decision + 23 slots; exit 2 h later.
  - Control: same day and 12-h block, same terciles of drawdown, age and depth, with RB below the median.
  - Price-path placebo (new): RB rebuilt from the same pool's sale prices, but using loss-sellers or non-exiters as the wallets. The lift must beat it.
  - Pass needs 99.5% lower bounds above 0 for both net and lift, at least 300 trades, each day above 0, then a forward confirmation.
- **Kill:** any gate item fails, or discovery futility fails. Fewer than 300 trades means unresolved.
- **Frequency:** UNVERIFIED; my guess is 10–60 a day. Forward days are likely needed.
- **Owner flags:**
  - It anticipates likely buys by wallets we can identify, though no pending order exists (the same class as H1-CGO).
  - The owner must raise `maxEntriesPerDay: 3` and `maxOpen: 1` (verified, `packages/core/src/config/policy.ts:191`).
  - Before registering, confirm the live recorder keeps the owner_token and signer_sol columns.
- **Counter-evidence:** none of the 35 large one-wallet sales in survivor pools at least 24 h old came back within the hour (verified, `research/absorption-probe/RESULTS.md:42`). That is a different population, but it is a warning.
- **Chance:** about 0.3%.

### 3. DEV-ZERO: buy after the creator's exit, sell into the buyers it releases
- **Votes:** 2 of 2 judges kept it.
- **Who pays:** screen users whose dev-holding filter keeps them out until the creator's share falls. Those terminal filters are UNVERIFIED.
- **Fixes folded in:**
  - "Dev" means CreateEvent `creator` / `coin_creator`, which matches H12 (verified, `packages/core/src/gates/hard.ts:426,432`). CreateEvent `user` is the secondary definition.
  - Arm order, frozen before Step A: the ≤5% crossing first (the only cutoff with any source, a third-party one, tested against a 4.2% placebo), then the zero flag (against near-full exits), then ≤3% (against 2.4%).
  - The sign is fixed as positive in advance; a negative step is only recorded as an exit hazard.
  - Near-full-exit controls are dropped where the dev sells again inside the window.
  - Second control: full exits by top-10 holders who are not the dev.
  - "Released buyers" are measured with sweep 1's APP-TOLL×F1×CS1 classifier.
  - Ceiling: only the excess first-time buy SOL after entry counts, in (sale+23 slots, +15 min]. After subtracting excess holder selling, including automated dev-sell exits, it must be at least 3.4% of effective quote at the median event.
  - At least 11 eligible events a day on Step A.
  - It uses sweep 1's single creator-group definition.
- **Primary test:** $50 at the event + 23 slots, canonical non-mayhem pools at least 60 min after migration, exit at +15 min. Pass needs a 99.5% lower bound above 0, a lift lower bound above 0 and at least the median round trip, at least 300 trades, each day above 0, then a forward confirmation.
- **Kill:** any gate item fails; full exits draw no more buyers than the controls; fewer than 300 trades means unresolved.
- **Frequency:** UNVERIFIED.
- **Owner flags:** none new. H12 (4000 bps) and H13 (1500 bps) never block a dev at zero (verified, `policy.ts:226,229`). Report the share H12 already rejected while the dev held 40% or more.
- **Chance:** about 0.15%.

### 4. SEAT-DRIFT: graduates from busy minutes, entered at +60 min (shares #1's frozen state)
- **Votes:** 1 of 2 kept it. The other judge said merge it into G1-CAP but keep it as a separate trade arm.
- **Who pays:** late discoverers of graduates that migrated in a crowded minute, if their attention is delayed rather than lost.
- **State:** its own count, N_m over [m−90 s, m+90 s], frozen in the same document as G1-CAP's Z.
- **Gate (absolute flows replace the share test, which (b) could pass on its own):**
  - Busy-minus-lone first-time buy SOL in (m+60 min+23 slots, m+120 min] must be at least 3.4% of effective quote at the median.
  - The busy-minus-lone difference in [m+40, m+60 min] must not be negative.
  - Descriptive: a drift line for all graduates, beside the lone control.
- **Trade:** $50 at m+60 min + 23 slots on the canonical builder; hold 60 min.
- **Why it matters:** it is the only crowding arm the bot can run live under the current rules (H10 is 60 min; verified, `policy.ts:221`).
- **Owner flags:** the entry limits must be raised, as for #2. Separate loop-family member.
- **Chance:** about 0.15%.

## 2. Dropped, with reason
- **USD-STEP:** a SOL move of 0.3% or more crosses only pools sitting just below a round level, and it would need extra buying of at least 3.4% of quote. Whether displays reprice a pool that has no trade is UNVERIFIED. Correction to the proposer: the core does have hourly SOL/USD for H8 and the regime gate (`packages/core/src/facts/kinds.ts:33`), though no minute feed. Its item (f) moves to Design A.
- **CLOCK-CROWD:** a duplicate of AGE-GATE. Its own trade lands ahead of terminal auto-buy presets, which are standing orders held for users, so it breaks the owner's "no front-running pending orders" rule.
- **AGE-GATE** (2 of 2 kept, but ranked fifth): runs only as count rows in the shared Step A pass.
  - Local placebos at a*±3, 4, 5, 7 and 11 min; a split by buyer type; ages from block_time.
  - The pre-position arm is removed.
  - The only source found points to maximum-age filters, so a negative step is expected and is recorded as an exit hazard.
  - It gets its own pre-registration only if the human buying after +23 slots is at least 3.4% of quote.
- **MM-FLOOR:** buying after D's band buy and selling at D's upper band pays D's own push plus the toll, inside a band only about 2× the toll. If D is skilled, this is copy-trading (dead); if D is paid keep-alive, it is usually creator support (an ethics question). Count row only.
- **WASH-ECHO:** the same two-sided cluster object as MM-FLOOR. Volume services mostly trade small or atomic legs (safety.md:136 cites MemeTrans: 21.4% of transactions are same-transaction washes), and the hub-cap-50 clustering misses wallets funded in a fan-out from one hub. Count row only.
- **A-FOCUS:** a state split of Design A whose "spread" group is probably small; it overlaps the dead creator-history signal and carries CREATOR-BUY's ethics question. Correction to the proposer: the core does have `deployer-index.ts` and H13 `devCluster` (`hard.ts:471`).
- **FARM-CURVE:** too many owner approvals at once: a new venue, builder and signer program; an exception to hard rejects (a loosening only the owner can make); off-tape credits or a new provider. Selling to buyers who are then drained by a rug farm is an ethics problem, capacity is $5–$20, and the config was decoded from memory, not the IDL.
- **CLONE-BET:** the only evidence goes against it. The 2.5% BORDR pool is a DAMM v2 pool, above PumpSwap's 1.25% top fee, so it is not a pump graduate's pool, and JUP is a major. Clones probably lag public trending lists.
- **USDC-SEG:** the premise that fast bots are shut out has no support. The one USDC migration checked ran no InitBoost (venues.md F5). The 3.0% non-SOL share also includes token-quoted coins. Live use would reverse venues.md:371 ("reject USDC/stock-quoted coins").
- **Holdout note:** the FARM-CURVE and CLONE-BET metadata reads from 09-19..21 (U1-B) and 10-07/08 (sealed window) must be logged in DECISIONS.md as viewed.

## 3. Amendments to freeze before Step A is read
1. **Fix G1 AMENDMENT_1 line 34 and the brief.** In `boost_buy_and_burn(quote_amount_in, min_base_amount_burned)` (IDL argument names verified; program code not read), the minimum is a price **cap**, not a floor: BOOST refuses to pay more than quote ÷ min_base. The risk for G1: if early buyers push the price above the cap, BOOST stops buying exactly when G1 wants to sell to it. Descriptive rows to add:
   - the share of BOOST slices with a non-zero cap;
   - slices that failed on slippage (F rows: `err_class`, `limit_arg`);
   - BOOST quote left unspent, capped against uncapped.
   
   The tape's S_amm has `min_base_amount_out` and `limit_quote`, and BOOST slices produce BuyEvent rows (verified, `research/historical/scanner/scan.go:44-52,985-986`). Whether that field carries `min_base_amount_burned` is UNVERIFIED.
2. **G1 amendment 2:** G1-CAP's Z (one family member) and SEAT-DRIFT (its own member), in one frozen document.
3. **G1-0 descriptive stratum:** USDC-quoted and token-quoted curves counted separately: triggers, InitBoost share, BOOST unspent after m+D, and distinct buyers.
4. **Design A, round-USD check:**
   - At $119.26, 420 SOL = $50,089. The 340–1,300 SOL placebo grid spans $40.5k–$155k and contains $100k (about 838.5 SOL).
   - For each tape day, read SOL/USD from the Binance archive. Report bunching at the SOL levels equal to $50k and $100k that day, and drop placebos within 10% of those levels.
   - If 420 SOL is within 5% of a round USD level on every tape day, record A's effect as "not separable from a USD level".
   - SOL/USD on 09-02..09-11 is UNVERIFIED (it is not in the repo).
5. **Design A Gate 3:** add A-FOCUS's focused-versus-spread split as a descriptive row. Use the single creator-group definition. Decoder v2's CF table of creator-fee collections can feed it (README:34).
   - Correction to the brief: v2 S rows do carry `top_program` and `cu_price` (along with tx_fee, cu and jito_tip). Only the four v1 units of 09-11 lack them (README:66-72).
6. **W1:** count rows for one two-sided cluster detector (MM-FLOOR plus WASH-ECHO), with a hub-keyed cluster rule beside the hub-cap-50 rule. W1's ranking is unchanged. Export the fast-class label for G1-CAP (c2) and for REBUY's exclusions.
7. **H1-CGO:** build the per-(mint, owner) cost ledger once, with ex-holder fields (exit VWAP, realised gain, signer_sol with a signer = owner flag), so REBUY-ANCHOR can use it.

## 4. Honest line
No. Nothing in sweep 2 beats G1-HC (about 2% by sweep 1's judgement, AMENDMENT_1:6). Its best idea, G1-CAP (about 0.5%), is a filter on the same G1 trade. The sweep's main value is three corrections:
- BOOST's limit is a price cap, not a floor.
- Design A's 420 SOL level may really be a $50k label.
- The tape does keep the swap limit fields.