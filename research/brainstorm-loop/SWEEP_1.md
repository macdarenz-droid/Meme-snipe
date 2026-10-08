# Idea sweep 1 (2026-10-08)

Owner, 2026-10-08 about 4:42 PM: "Create new idea, mix ideas, research, reasoning, put urself on a shoes of a winner ... We take whats true".
Method: five generators (winner seats, rule-made flows, mix and invert our results, transferable anomalies, what only the tape can see), three skeptics (economics, evidence and duplicates, truth and owner rules) judging every idea, one synthesis. Run 16:43–18:10 Melbourne, 9 agents. No market data was read; only repo files and public sources. Every chance is judgement.

## All ideas and the skeptics' votes
| Id | Idea | Skeptics keeping it | Skeptics' chances (econ / evidence / truth) |
|---|---|---|---|
| winner-seats-1 | CS1: absorb copy-sell cascades (buy after a leader's copy-traders dump) | 1 of 3 | 0.7% / 1% / 1.5% |
| winner-seats-2 | G1-E: BOOST surplus, entered only where little inventory is ready to sell into BOOST (G1 × H1-CGO) | 2 of 3 | 1% / 2% / 2% |
| winner-seats-3 | WC-420: wash carry above 420 SOL (hold the coin while wash traders pay the pool) | 2 of 3 | 0.3% / 1% / 1% |
| rule-flows-4 | MAYHEM-24: buy surviving mayhem coins right after the protocol agent stops and its leftover supply is burned | 3 of 3 | 1% / 1.5% / 1.5% |
| rule-flows-5 | QUOTE-PARENT: buy a pump coin when new coins start using it as their quote currency | 3 of 3 | 0.5% / 0.5% / 1% |
| rule-flows-6 | METAORDER-END: buy right after a scheduled DCA/TWAP seller's last slice | 1 of 3 | 0.2% / 0.5% / 0.5% |
| rule-flows-7 | AGE-24 FEE STEP: Jupiter's swap fee on a token drops from 50 to 10 bps when the token turns 24 h old | 0 of 3 | 0.1% / 0.3% / 0.2% |
| mix-invert-8 | FEE-RECYCLE: buy just before creators who habitually spend their claimed creator fees on their own coin | 2 of 3 | 0.8% / 1% / 1% |
| mix-invert-9 | BOOST-RESIDUAL: buy after the opening sellers are spent, while a large share of the protocol's BOOST budget is still to be spent; sell when it ends | 2 of 3 | 1.5% / 1% / 2% |
| mix-invert-10 | G1-XB: run G1 only when slow holders hold the curve and opening demand is not split (an exit-liquidity balance filter) | 1 of 3 | 1.5% / 1.5% / 1.5% |
| literature-11 | INSIDER-BUY: the creator's wallet group buys its own coin in the open market after migration, as an opportunistic purchase | 2 of 3 | 0.5% / 1.5% / 1% |
| literature-12 | STALE-QUOTE LAG: sharp moves of large Solana memes reach thin single-venue PumpSwap pools minutes late | 2 of 3 | 0.2% / 0.5% / 1% |
| literature-13 | FLUSH-BUY: buy listed Solana memes after a forced long-liquidation flush (open interest and price fall in the same 5 minutes) | 3 of 3 | 1% / 1.5% / 1.5% |
| tape-eyes-14 | APP-TOLL: a retail-app buying wave into a clean float | 3 of 3 | 0.7% / 1.5% / 1.5% |
| tape-eyes-15 | CTO-EVENT: pump's admin approval of a community takeover, traded as a slow public event | 2 of 3 | 0.2% / 0.5% / 0.5% |
| tape-eyes-16 | TAPE-EXEC: slice large exits into arbitrage refill, set tolerance from measured sandwiching, map per-pool tolls (execution, not an edge) | 0 of 3 | 0% / 0% / 0.5% |

## Synthesis (verbatim)


Every chance figure below is my judgement, not a measurement. Taken together, I put the chance that at least one survivor passes at about 5%. The survivors are correlated, so that is not the sum of their chances. The most likely outcome is that most of them close at their counts gates.

**Checked by me on `origin/ccr-7fae2302-drz4co`.** Two of these settle conflicts between the skeptics.
- **Phase 0 status.** `research/shared-tape/PHASE0.md` says Phase 0 is done (one unit of 09-11, 2026-10-08) and Step A has not started. The APP-TOLL skeptic who said "Phase 0 not run" was reading a stale version. Any new S column can still land before Step A.
- **Fee claims are not on the tape.** `research/historical/scanner/sample.go` puts `CollectCoinCreatorFeeEvent` and `CollectCreatorFeeEvent` in `dropEvents`. `research/shared-tape/tapedec/sample.go` is a symlink to that file. So claims are dropped from E. The skeptic who said "probably already in E" is wrong.
- **CTO events are kept.** `AdminCtoPoolEvent` is not in the drop list, so E keeps it.
- **BOOST may carry a price floor.** `boost_buy_and_burn` takes `quote_amount_in` and `min_base_amount_burned` (tapedec `idl/pump_amm.json`). Whether BOOST really ignores price depends on what the keeper sets. That is UNVERIFIED.
- **Owner ruling on P2.** The owner closed P2 with "P2 No" (brainstorm-loop LOG, 2026-10-08 17:15). Whether that rules out perps in general is unknown.

## 1. Truths from the winner's seat

- **The people who win here are fast, early, or know more.** Top-PnL wallets have a median hold of 32 s (copytrading.md). 73% of arbitrages land in the same block (edge.md 7.4). Launch sniping 0.7 s to 3 min after creation lost 7.1%, and the fastest entries lost most. A bot that lands about 23 slots late cannot sit in those seats. Any edge it gets must play out over minutes to hours, and come from data that is not a public price.
- **A single-venue constant-product pool does not bounce back by itself.** Price impact stays until new buyers arrive.
  - None of 35 large sales that nobody absorbed came back within the hour (absorption RESULTS).
  - Maker fills lost 1.41% each.
  - Dips bounced 0.05 to 0.5 points against a 0.85–1% toll.
  - So "buy after forced selling" needs a buyer we can identify who arrives later. Knowing who the seller was is not enough.
- **Public signals are worth about a tenth of the toll, and memes drift down against SOL.** Buying every graduate lost about 24% a trade. Buy-everything daily lost about 9% a week. Any hold must beat that drift. The payer has to be forced or blind to price, not just paying attention.
- **The toll sets the bar.** A young-pool $50 round trip costs about 3.5%. To beat twice the toll, a mechanism has to move the price by about 7%. Arithmetic like this already killed WC-420 and STALE-QUOTE on paper.
- **BOOST is the only scheduled buyer we know of that ignores price.** It spends about 17.58 SOL, fee-free, over about 100–280 s on each standard SOL graduate (venues.md F5). The caveat about a price floor is above. Everyone holding pre-migration inventory races to sell into it. The winning seat is to hold inventory where few others are ready to sell. Capacity is a few SOL a coin, so $10,000 cannot be filled.
- **Cheap signals are weak evidence.** Above 420 SOL cap, a creator's wash costs about 0.25% net, so volume and "dev bought" there cost little to fake. The 300-trade proof also needs about 11 entries a day. Three Step B days need at least 100 a day. Most ideas will end UNRESOLVED on the tape, so forward days must be named in advance.

## 2. Survivors (ranked)

### 1. G1-HC: G1 filtered by holder makeup (G1-E and G1-XB merged into one family member)

**Who pays.** BOOST's buy-and-burn and the opening buyers pay, as in G1. G1 only fires on curves where little pre-migration supply is ready to sell into them. "Ready to sell" means:
- fast wallets (W1 class);
- the creator's funding group;
- wallets that bought in the first 10 slots;
- holders whose cost is at most half the migration price.

**The feature.** Pick one before G1's futility step:
- The primary filter is the sell-ready share of curve-held tokens, measured at the entry slot t0+D−1, not at t0.
- Φ = 17.58 ÷ S_ready is reported as a secondary only. The economics skeptic showed it mostly measures how much early supply has already changed hands.

**Gate (Step A, no returns read).** Freeze it in a dated amendment before G1's futility step reads any return. Otherwise this idea is forward-only.
- (a) G1-0 passes as registered.
- (b) Mechanism: Spearman ρ between the filter at entry and the share of pre-migration holders' tokens sold in [m, m+D]. Need ρ ≥ 0.2 with a one-sided 95% lower bound above 0.
- (c) Coverage: at least 90% of curve tokens can be traced to wallets with full history. Report:
  - the triggers dropped because the curve was created before the tape;
  - their time to graduate;
  - the T coverage limit for mints that do not end in "pump".
- (d) At least 100 filtered catchable triggers a day, or forward days named in advance for 300 trades.
- (e) Read `min_base_amount_burned` on BOOST rows and report the share of slices with a non-zero floor. If slices have a floor, restate the idea before any return is read. It is UNVERIFIED that the tape keeps this argument.
- (f) Report the filter's correlation with time-to-90%, and tercile counts.

**Primary test.**
- Data: G1's frozen statistics on the filtered subset, on Step B if released, otherwise named forward-recorder days.
- Entry: on the curve at the first trade reaching 90% (76.50 SOL), plus 23 slots.
- Exit: sell on the canonical pool at m+23. If there is no migration within 30 minutes, sell on the curve.
- Costs in SOL: curve fee 1.25%, the pool's fee tier, impact on effective reserves capped by the real vault, and 414,009 lamports a round trip.
- Controls: unfiltered G1 (lift above 0), plus G1's S0.
- Statistics: pool-clustered bootstrap stratified by day, at 99.5%. At least 300 trades, positive on each day.
- Sizes $5 to $1,000. $10,000 is reported as infeasible (about 8.5 SOL is left on the curve at 90%).

**Kill.** Any of these closes it:
- G1-0 fails, or any gate item fails;
- G1 fails futility and the subset's own one-sided 95% upper bound is below 0;
- the net lower bound is ≤ 0, or the lift over G1 is ≤ 0.

Fewer than 300 trades means unresolved.

**Frequency.** About half of G1's catchable triggers. G1-0 has not measured these yet.

**Owner flags.**
- The curve is paper-only, and the trade sits inside H10's excluded window.
- Synthetic migration: our signer refuses v3, so the bot can never be the completer. Forward checks drop pools opened by a v3 overflow buy (`PostCompleteBuyEvent`). Every tape day predates it.

**Chance.** About 2%. It moves closely with G1's own prior.

**Also folded in: BOOST-RESIDUAL as descriptive rows in G1-0(c), at no cost.**
- The BOOST budget left at the first "openers spent" slot plus 23. "Spent" is measured over all wallets that held at m.
- The share of BOOST slices bracketed by non-BOOST owners.
- The non-BOOST buys inside our 23-slot window.
- It gets its own PREREG only if the median unspent share is at least 30% and bracketing is at most 50%.

### 2. APP-TOLL: a retail-app buying wave into a clean float

**Who pays.** Later buyers in a retail-app wave pay. They come with app fees, preset sizes and wide slippage, and they arrive over minutes. Their buying meets a float no longer held by mechanical sellers: the creator group, bundlers, and wallets that bought within 2 slots of create or migration.

**Time-critical.** The supervisor must decide on three new S columns before Step A runs:
- `top_program`;
- the largest small transfer from the signer to an address that is not a protocol address (amount and recipient);
- the compute-unit price.

Step A deletes each unit's spool after decoding it, and a later re-read costs about 0.27M credits a day. The columns hold public chain data only, so the supervisor can approve the data shape. Without the columns, G0 is frozen on the residual method alone.

**Gate (Step A, no forward price).**
- G0, the classifier: on repeat buys, the signer's lamport residual shows a separate mode in [0.4%, 1.3%] holding at least 15% of them. Preset-size buys land in that band at least twice as often as other buys. Copy-trade buys (same mint 1–3 slots after a leader) are split out first.
- G1, count: at least 30 clean-float onsets a day.
- G2, not momentum: R² below 0.3 against past 5-, 15- and 60-minute returns, volatility, volume and buy count.
- Timing (discovery-only, kill-only): at least 50% of the wave's later buy SOL lands after t+23.
- Only coins created on tape days are used, with day 1 as burn-in for "first-time" buyers.

**Primary test.**
- Entry: $50 at t+23 through the canonical PumpSwap builder, with a tight minOut.
- Exit: at t+15 minutes.
- Costs in SOL: fees from each trade's own fields, impact on effective reserves capped by the real vault, and edge-costs.ts fixed costs.
- Control 1: momentum-matched windows. This is the primary lift.
- Control 2: onsets whose float is not clean.
- Pass needs all of:
  - net lower bound above 0;
  - lift at least the median $50 round trip;
  - at least 300 trades;
  - positive on each day;
  - clean float beats dirty float.
- Sizes $5 to $10,000.

**Kill.** Any gate fails; or discovery futility; or net ≤ 0; or lift below the round trip; or clean does not beat dirty.

**Frequency.** 20–300 a day (estimate).

**Owner flags.** More than 3 entries a day. The live stream cost is not measured and may be above the 10M plan.

**Chance.** About 1%. It is close to the dead momentum and attention family.

### 3. MAYHEM-24: buy surviving mayhem coins after the T+24h burn

**Who pays.** Buyers who rely on screens (top-holder share, single-holder danger, market-cap limits) are kept out by the agent vault until the burn. They are allowed to buy after it, not required to. Halving the supply also halves the displayed market cap, which can push the coin below minimum-cap screens.

**Gates, cheapest kill first (no returns read).**
- G2 live: check 20 or more live mayhem coins at 0 credits, at no more than 50% of documented limits. Read the RugCheck single-holder flag and DexScreener market cap and FDV at T+23h and T+25h. Kill if fewer than 50% flip. Add a downward placebo: coins whose displayed cap falls below common minimum screens.
- G0 counts:
  - First confirm the burn shows up in T on the first unit. T keeps burns only outside pump instructions and for "pump"-suffix mints, and the mayhem program is not decoded.
  - If burn coverage is under 90%, make capped signature reads.
  - Join the mayhem flag from C or curve rows, since S_amm has no mayhem column.
  - Measure mayhem graduation and 24-hour survival before spending the decoding builder-day.
  - Count coins alive at T+24h with at least 10 SOL in the real vault, split by curve and pool. Drop any coin with an `UpdateMayhemVirtualParamsEvent` or agent-vault trade after the burn.
  - Kill if fewer than 11 a day, or if the burn-time spread (IQR) is above 2 h.
  - Step A alone gives only about one day of T+24h coins, so plan G0 on more days.
- G1, flow: a difference-in-differences of first-time buyers and gross buy count in [24h, 26h] against [22h, 24h], mayhem coins minus age-matched coins. The lower bound must be above 0. Add a size ceiling: the implied price push must be at least 2× the $20 round trip.

**Primary test (forward paper, at least 300 events).**
- Entry: the first swap at least 23 slots after the burn.
- Exit: entry + 2 h, or the −20% stop.
- Costs: the real fee tier (market cap on real supply), real-depth impact, and 414,009 lamports.
- Control: non-mayhem coins at the same age and depth. This also absorbs AGE-24.
- Statistics: intersection-union test at 99.58%.

**Kill.** Any gate fails; or net ≤ 0; or lift below the $20 round trip. Fewer than 300 events means unresolved.

**Frequency.** 12–36 a day (estimate).

**Owner flags.**
- A core change: H5, H17, fees.ts and the builders, with the 8 reserved mayhem fee recipients and golden transactions, reviewed by the supervisor and the risk reviewer.
- It reverses the 10-03 DECISION, so the owner must be told.
- Candidates still on the curve are paper-only.
- It anticipates other traders' rules, so the owner should confirm.
- The recorder must keep mayhem coins and their burns.

**Chance.** About 1%.

### 4. CREATOR-BUY: the creator group's own open-market buying (INSIDER-BUY and FEE-RECYCLE merged)

**Who pays.** Holders who sell into the creator group's opportunistic buying after migration, and later attention buyers if the creator promotes. In the fee-funded arm, the creator's own buy lands after ours (trigger (a) only).

**Data.**
- Claims are not on the tape (checked above).
- Before Step A, either:
  - extract the two collect events in a tapedec-only file (0 credits, scanner unchanged), or
  - spend capped Helius reads (at most 100k credits).
- Since 10-02, a claim is `sweep_creator_fee` plus collect in one transaction. Accrual is the creator vault plus the unswept pool tail.

**Shared Stage 0 (counts and flows only).**
- Count creator-group net buys more than 60 minutes after migration and after the last BOOST. Group wallets by union-find on T and W links on or before the decision slot, with a hub cap of 50. Split by funding: claimed fees within 1,500 slots, or fresh SOL.
- At least 15 a day.
- Bait test (discovery-only, kill-only): the group's position falls back below its pre-event level within 4 h in at most 50% of events. Exclude wash-shaped buys.
- At least 50% of independent buy SOL lands after +23 slots.
- Report the share that is "linkage-limited": W keeps transfers of at least 0.05 SOL only, and CEX funding breaks links.
- Recycler persistence of at least 50% from one day to the next.

**Primary test.**
- Entry: decision + 23 slots, $50.
- Exit: +4 h.
- Costs: in SOL, as edge-costs.ts charges them.
- Control: up to 5 matched pools with no group buying in the last 6 h.
- Both net and lift lower bounds must be above 0.
- The recycler list is rebuilt rolling and as-of on forward weeks, never frozen from September.
- Forward days are named in advance if Step B cannot reach 300.

**Kill.** Any gate fails; or futility; or net ≤ 0; or lift ≤ 0.

**Frequency.** 15–150 a day for the fresh-SOL arm (estimate). The fee arm is unknown.

**Owner flags.** An ethics ruling is needed before any return is read, because the bot trades beside an insider's public buys. Price the live stream first.

**Chance.** About 1%. Without insider-trading law, baiting is cheap, and the launch dev-buy (F2) lost 4.7%.

### 5. FLUSH-BUY: buy after a forced long-liquidation flush (only if the owner allows a venue)

**Who pays.** Liquidated longs on Binance perps, sold by the engine at any price. Spot follows through arbitrage.

**First step.** Ask the owner once whether "P2 No" rules out perps, and whether a Raydium builder could ever be allowed. If both are ruled out, close it unrun, because a pass could not be used on the bot.

**Gate (Binance archive 2023-11-01 to 2024-12-31, 0 credits).**
- Items (a) to (e) as proposed.
- Open interest is read as-of: the row must be at least 300 s old (squeeze PREREG rule).
- At least 100 independent event-days after a cap of 5 coins per day.
- Confirm the archive start on one file.
- Drop funding-time bars.
- Log every look at windows already viewed.

**Primary test.**
- Validation 2025-01-01 to 2025-09-18.
- Entry: the first 1-minute open after confirmation plus the execution delay.
- Exit: +60 min.
- Costs: the perp round trip, plus the SOL-hedge round trip, plus funding. Stress lines at 2× and at the 95th-percentile crash-day spread.
- Control: same-coin, same-day drops with open interest flat or rising.
- Pass needs at least 300 events, net and lift lower bounds above 0, and a lift at least the round trip.

**Kill.** Any gate fails, or futility, or net ≤ 0, or lift ≤ 0.

**Frequency.** 5–20 a day, heavily clustered.

**Owner flags.** A derivatives or new-venue decision. Australian legality is unconfirmed. A pass yields only a venue proposal.

**Chance.** About 1%. Lower still that it is ever usable on the bot.

## 3. Dropped, with reason

- **CS1.** It duplicates parked design B, and the lead had already dropped "copy-sell overshoot". 0 of 35 unabsorbed sales recovered, and few cascades happen after 60 minutes. Kept only as a free count line in F1's graph gate.
- **G1-E and G1-XB.** Merged into G1-HC.
- **WC-420.**
  - Gate (c)'s arithmetic is wrong: 2× the full round trip needs about 5% accrual per 12 h, which is V/Q of about 24–35 per 12 h.
  - Qualifying pools sit about 600× above median turnover.
  - The payer is probably the dumper, so it reduces to the dead volume family.
  - Kept as a hazard count in Design A's tape pass.
- **QUOTE-PARENT.** Forward-only with no history, and an estimated 0–5 signals a day. The recorder fields would be a new task needing the owner's approval. Revisit if adoption shows at least 11 a day for 14 days.
- **METAORDER-END.** S has no `top_program`, the Jupiter DCA program ID is unverified, fewer than 5 a day is expected, and an AMM has no resilience. Kept only as a seller-type label in S3/ABS-S1.
- **AGE-24.** 0 of 3 skeptics kept it.
  - S has no `top_program`.
  - The fee step applies to `/order` swaps only.
  - The incentive is symmetric and below a round trip.
  - MAYHEM-24's same-age control already covers it.
- **FEE-RECYCLE.** Merged into CREATOR-BUY.
- **BOOST-RESIDUAL.** Folded into G1-0(c) as descriptive rows. It gets its own PREREG only if those rows pass.
- **STALE-QUOTE LAG.**
  - It is a public price signal.
  - The ceiling arithmetic (index +2σ at 15 min, times β ≤ 1, against 2× a 2.5–3.5% round trip) likely fails.
  - Validation needs a bulk fetch the owner's rule forbids, or forward days.
  - Run its ceiling gate on the bars already held only if there is spare capacity.
- **CTO-EVENT.** Probably fewer than 2 eligible events a day. Approval lags the revival it certifies, and paid promotion lost. Kept as a free count from E on Step A.
- **TAPE-EXEC.** It is not an edge and saves about nothing at $5–$100. Parked to exits stream 4 until a strategy passes at $1,000 or more. Tolerance changes are owner risk limits.

## 4. Mixes worth a later look

- **G1-HC × BOOST-RESIDUAL:** one BOOST inventory study, with curve inventory sold into BOOST plus a pool entry after the openers are spent. Both read the same G1-0 rows. Only if the median unspent budget is at least 30% and bracketing is at most 50%.
- **CREATOR-BUY × Design A × D-SPLIT:** one creator-group netting rule, frozen once. It would feed the buy arm, Design A's gate 3 (defence at 420) and D-SPLIT's "insiders leaving" arm. Three ideas would then not fork the group definition.
- **APP-TOLL × F1 × CS1:** one wallet-role classifier built once on Step A, covering copy followers from F1's graph, app-fee buyers from G0, and fast wallets from W1. APP-TOLL leaves out copy buys, and the CS1 cascade count comes along for free.

Files I relied on, on `origin/ccr-7fae2302-drz4co` unless a branch is named:
- research/shared-tape/PHASE0.md
- research/historical/scanner/sample.go (lines 47–51)
- research/shared-tape/tapedec/sample.go (symlink to the scanner file)
- research/shared-tape/tapedec/idl/pump_amm.json (boost_buy_and_burn args)
- research/shared-tape/tapedec/extras.go
- research/brainstorm-loop/LOG.md
- research/g1-boost-inventory/PREREG.md, on origin/ccr-4d892c1c-tvjf5l