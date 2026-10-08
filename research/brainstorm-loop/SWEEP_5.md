# Idea sweep 5 (2026-10-08): widened scope

Scope set by the owner at 21:55: research is no longer limited by his product rules. Lenses: perpetual futures (Hyperliquid and others), speed seats, other venues and launchpads, young pools and large sizes, and drift-hedged designs. Kept out: anything illegal or manipulative, real money, and dishonest testing. Two skeptics, then one synthesis. Run 21:56–23:20 Melbourne, 8 agents. No market data was read. Every chance is judgement. (The ids below are sweep 5's; the script printed them with the sweep-2 prefix.)

Honest summary: even with the owner's rules lifted, nothing beats W1 (about 5%), D1 (about 2–4%) or G1-HC (about 2%). The perp ideas failed on cost arithmetic, or because the flow is visible to faster traders. The best survivor is a mid-speed seat at pool open (MIG-SEAT, about 0.5%). It would cost about US$509 a month in infrastructure, which the proposer read from the Helius pricing page and the synthesis did not re-check.

What matters for G1, checked in the synthesis:
- pump-public-docs added SYNTHETIC_MIGRATION.md on 2026-10-07. A curve-crossing buy now completes the curve and buys into the new pool in one step. The date it went live on mainnet is UNVERIFIED.
- The tape decoder's pump IDL lacks `buy_v3` and `PostCompleteBuyEvent`.
- Flag for the supervisor: the 16,367-coin survivorship-free list was built from the pump.fun API, which is now off limits.

## All ideas and the skeptics' votes
| Id | Idea | Skeptics keeping it | Skeptics' chances (econ+evidence / truth+law) |
|---|---|---|---|
| s5-perps-1 | FUND-CLOCK: take the paying side's flow across a Binance funding settlement, on Hyperliquid, without paying the lump | 1 of 2 | 0.1% / 0.5% |
| s5-perps-2 | XMARGIN-VICTIM: buy a meme perp flushed by another coin's crash (cross-margin contagion), sector-hedged | 1 of 2 | 0.1% / 0.3% |
| s5-perps-3 | TWAP-RIDE: ride the remaining slices of a public Hyperliquid TWAP on a meme perp | 1 of 2 | 0.05% / 0.2% |
| s5-speed-4 | MIG-SEAT: buy a new canonical PumpSwap pool in its first blocks (landing by s0+2) with a mid-speed seat, then sell into BOOST and later buyers at +60 s | 2 of 2 | 0.4% / 1% |
| s5-speed-5 | MAYHEM-SNAP: back-run the mayhem program's synthetic re-prices on mayhem-mode bonding curves | 2 of 2 | 0.15% / 0.3% |
| s5-speed-6 | PAIR-RESIDUE: atomic arbitrage between two PumpSwap pools of the same coin, taking only the gaps the same-block bots leave open | 0 of 2 | 0.03% / 0.05% |
| s5-venues-7 | FEE-CLIFF: hold before a launch pool's scheduled anti-sniper fee reaches its floor, then sell to the buyers who waited (Meteora DBC curves are primary; DAMM v2 and migration-time fee drops are secondary arms) | 1 of 2 | 0.1% / 0.5% |
| s5-size-and-young-8 | SYN-COMPLETE: be the synthetic-migration completer at size (an uncapped seat in the pool before it opens), then sell into BOOST | 1 of 2 | 0.4% / 0.4% |
| s5-hedged-9 | SHORT-PAYS: beta-hedged short of the perps where shorts pay longs (exit-liquidity continuation) | 1 of 2 | 0.2% / 1% |
| s5-hedged-10 | BETA-STRIP: hedge the common part of a spot hold's drift with a short Solana-meme perp (a free gate that can close the hedge-the-drift lens) | 0 of 2 | 0.03% / 0.1% |

## Synthesis (verbatim)


I checked these facts myself today, read-only:
- **H8 floor and trial limits.** `hard.ts:285-315`, `policy.ts:190-205`.
- **Pump instructions.** The tapedec pump IDL shows that `migrate_v2` has only the signer `user`, and `set_mayhem_virtual_params` has the signer `sol_vault_authority` and takes no arguments.
- **Event fields.** `UpdateMayhemVirtualParamsEvent` and `BoostBuyAndBurnEvent` have the fields the proposers listed.
- **The decoder misses v3.** The tapedec IDL has no `buy_v3`, `buy_exact_quote_in_v3` or `PostCompleteBuyEvent`.
- **The scanner keeps the mayhem event.** `research/historical/scanner/sample.go` does not drop `UpdateMayhemVirtualParamsEvent`.
- **Synthetic migration rules.** pump-public-docs `SYNTHETIC_MIGRATION.md` says the crossing buy has no maximum size, the pool part is priced on the reserves the migration would deposit, each part pays the curve fee schedule, every later curve trade fails with `BondingCurveComplete`, and mayhem coins are excluded. The page does not mention BOOST.
- **Its date.** The page was added in commit `2026-10-07T20:11Z`. The date it went live on mainnet is UNVERIFIED.

Every chance below is judgement.

## 1. Survivors

### 1. MIG-SEAT, Arm A: pool-open seat (about 0.5%)
- **Who pays:** BOOST (about 17.58 SOL, fee-free, timed by pump) and the buyers ranked behind us in the first minute. Rivals for the same SOL: snipers ranked ahead of us, the creator group, and curve holders (about 793M tokens).
- **Gate:** step A days, counts only, 0 credits. Rows G1–G7 as proposed, with these fixes folded in:
  - G2 seat toll = `jito_tip + tx_fee`, run on v2/v3 units only, with coverage reported. The scanner stores `meta.fee` as `tx_fee` (`scan.go:728`). From memory, not re-checked: Solana's `meta.fee` already includes the priority fee, so adding `cu_price×cu` counts it twice.
  - New kill row: if at least 2/3 of first-minute non-linked buy SOL lands in s0..s0+1 (ahead of us), close.
  - s0 is the slot of the transaction that emits `CreatePoolEvent`. Slot times are measured per day, never assumed.
  - The gradual (non-instant) group is frozen now as the primary. Instant launches are a separate arm.
  - G8 cannot run on the current decoder: it would read zero by construction. It needs the v3 IDL items first.
- **Primary:** step B days.
  - Fill at the worse of the start and end state of slot s0+2, or behind the k-th non-linked buy, where k is the rank a p75 tip buys. Use the worse of the two.
  - Exit at +60 s.
  - $100 is the primary size, with the seat cost charged at both 3 and 20 trades a day. Also reported: $5, $20, $50 and $1,000. $10,000 is infeasible.
  - Controls: an entry at s0+23 (today's speed), and a random slot in the first 5 minutes.
  - Pass: 99.5% lower bounds of net and of lift above 0, at least 300 trades, every day above 0.
  - Regime risk: the tape days predate synthetic migration, and a v3 completer can now take the pool's first price. So the forward confirmation must be on post-v3 days and is the binding test.
  - Then a rank probe. Its no-op transactions must write-lock the pool and vault accounts, so they queue behind the pool's buyers.
- **Kill:** any gate row fails; any lower bound or day at or below 0; fewer than 80% of probes land by s0+2.
- **Frequency:** G7 needs at least 100 eligible graduations a day (UNVERIFIED).
- **Owner flags:**
  - H8, H10 and the "not a first-block sniper" rule.
  - Trial limits: the seat needs about 20 trades a day at $100 or more.
  - Helius Business at about US$499 a month. This is the proposer's reading of the pricing page; I did not re-open it.
  - A tip route in the signer, and probe SOL.
  - An ethics ruling on instant launches.
  - Australian legality: UNVERIFIED.
  - The sealed-window +100.8% and +27.6% figures are never used and must be logged in DECISIONS.md as viewed.

### 2. SYN-COMPLETE: completer seat, Arm B of the migration-seat family, its own family member (about 0.3%)
- **Who pays:** BOOST and the opening buyers. We are the one buyer who holds pool inventory before the pool exists. Today's 23-slot bot can attempt it; it needs no seat.
- **Gate:**
  - G0: synthetic migration is live and dated (program upgrade slot, plus a `PostCompleteBuyEvent` on the first named forward day). If not, close.
  - G1, tape, kill-only:
    - (a) median N is at least −16 SOL;
    - (b) at least 10% of curves stay incomplete 23 or more slots after their first print at or above 97%;
    - (c) the winner's-curse gap is no worse than −5 SOL.
  - G2, forward:
    - InitBoost appears on at least 80% of synthetic migrations, and whether BOOST is a fixed amount or a share is recorded;
    - at least 11 catchable curves a day (this count binds);
    - kill if other completers' median pool part is already $500 or more (the seat is raced);
    - a forward winner's-curse row.
  - G3: payer mass, N at least N*.
  - Before freezing, one step A unit checks how effective quote moves on each BOOST slice. If it does not move as modelled, N* is recomputed.
- **Primary:** forward days named in advance.
  - Insertion replay: the real completer is removed (two arms for what it does instead), and every later swap is re-run under its own limits.
  - Entry at the worse of the landing slot's start and end state, with spend capped at the frozen size.
  - Fees by the curve schedule on each part, including the buyback fee.
  - Exit at the last BOOST slice +23 slots, capped at migration +300 s.
  - $500 is the primary. $1,000 and up are upper bounds only, because the replay holds other holders' selling fixed while our size lifts the opening price.
  - Control: a curve-only buy of the same SOL.
  - Pass as in Arm A.
- **Kill:** G0–G3 fail, or any lower bound or day at or below 0. Fewer than 300 fills is unresolved.
- **Frequency:** unmeasured (judgement 13–330 a day).
- **Owner flags:**
  - `buy_v3` in the signer.
  - The curve run live, plus H8 and H10.
  - Sizes from $308 up.
  - Jito `bundleOnly`.
  - The sniper rule.
  - An ethics ruling on completing curves. Only curves at 97% or more; size is never used to complete a curve early.
  - Any gain from BOOST scaling with our pool part is reported but never used without a ruling.
  - Australian legality: UNVERIFIED.

### 3. MAYHEM-SNAP (about 0.2%)
- **Who pays:** the curve's real SOL, through the mayhem program's synthetic re-prices. This only pays if those re-prices revert.
- **Gate:**
  - Gate 0 runs in MAYHEM-24's G0 pass: count `UpdateMayhemVirtualParamsEvent` rows per mint, split by whether they sit inside an agent trade or stand alone. Fewer than 1 an hour: close.
  - The instruction takes no arguments, so the program computes the new reserves itself. Write down that update rule from the events first. If it is deterministic, test the mechanical rule, not a statistical bounce.
  - Gate (b) is tied to the cost: after a qualifying down step, the median up step must be at least 5% (the repo's $20 curve round trip plus 2 points).
  - Placebo: down steps caused by non-agent sells of similar size.
  - Gate (c) fixes the entry latency before any return is read. If no seat is needed, the primary enters at s+23.
  - G1 and H1-CGO already exclude mayhem coins (checked in both PREREGs), so reading the step sizes on step A unblinds neither.
- **Primary:** step B or forward days. $20 is the primary size, the exit is capped by real SOL, and the pass rule is the same as above.
- **Kill:** gates (a), (b), (d) or (e) fail, or any lower bound or day at or below 0.
- **Frequency:** unknown; gate (e) needs at least 100 qualifying steps a day.
- **Owner flags:**
  - Mayhem coins (H5 rejects them).
  - Live curve trading.
  - Entry limits.
  - An ethics and legal ruling on whether a re-price is a fault, before primary days are named.

### 4. SHORT-PAYS (about 0.2%; $0 and Hyperliquid data, not tape)
- **Who pays:** holders exiting through perp shorts without regard to price. Prior: one Robot Wealth blog post, frictionless and untested.
- **Gate:** as proposed, with these fixes:
  - Spearman of the funding rank against the trailing-return rank at most 0.3, or funding residualised on trailing returns.
  - Delisted perps kept until delisting, at their final settlement price.
  - The "60% of months positive" ruling is made before the freeze.
- **Primary:**
  - Lift over a trend-matched control (same 28-day return rank, F24 at or above 0).
  - The USD long-short spread plus an explicit SOL-perp leg. The raw (1+r)/(1+r_SOL) figure has a SOL short built in and is a secondary line only.
  - Validation is split at the Sep 2025 publication. If only the earlier half is positive, record decay and kill.
  - A 1.5x liquidation line is reported beside 1.714x.
- **Kill:** futility first. If discovery's spread net of funding is under about 1% per 3 days (the fee load), close before validation. Then the rules as written.
- **Frequency:** about 5–15 positions a day (UNVERIFIED).
- **Owner flags:**
  - Hyperliquid and derivatives (the owner earlier said no to Hyperliquid).
  - Shorts, USDC and a bridge.
  - An EVM agent key in the signer.
  - Basket limits and a $10 minimum order.
  - Australian legality: UNVERIFIED.
- It contradicts H1-PERP's funding-low breakout result. Report both; rescue neither.

## 2. Dropped
- **FUND-CLOCK.** The prize is at most the lump minus the avoider's own fees (about 0–0.06% at |f| = 0.10%), against our 0.39% round trip. It only works at about |f| ≥ 0.5%, where events are probably under 300 and Hyperliquid's own funding on the same side eats the gain. It is also scored on the wrong venue. A free count in the Binance archive could reopen it.
- **XMARGIN-VICTIM.** Hyperliquid's public feeds name the liquidated accounts (the economics judge's reading of the docs), so bots can tell the flush is forced and absorb it before an entry 5 minutes plus 7 s later. It also detects on Binance and trades on Hyperliquid (Jaccard 0.19), and it needs a true lift of about 1.2%.
- **TWAP-RIDE.** There is no free all-user history, and forward-only collection takes months. Activations are public. Riding a committed order needs an ethics ruling and legal advice first. Parked.
- **PAIR-RESIDUE.** It duplicates the dead atomic-arbitrage idea. Arbitrage two or more slots late held about 0.05% of the value (edge.md:236), which cannot cover the roughly 0.142 SOL a day the seat costs. The quirk mechanism cannot be tested, because negative virtual reserves start after every tape day.
- **FEE-CLIFF.** The eligible fee schedules leave buyers only about 0.4 points to save at T, so held-back demand comes in during the decay, not at T. The tape has no Meteora DBC rows. Decision: no rushed DBC decoder before step B/C. The proposer's config, DefiLlama and Alpha Vault reads must still be logged in DECISIONS.md as viewed.
- **BETA-STRIP.** Nobody pays: a hedge cannot create lift, and no host has lift to hedge. The 16,367-coin list was built from the pump.fun API, which is now off limits. That needs a supervisor ruling for every idea that uses it.

## 3. Amendments to freeze before the tape is read
- **G1:**
  - **Decoder.** The v3 decode gap (top of this report) means the forward rule that drops v3-opened pools (SWEEP_1:96) can never fire. Add the v3 items from pump-public-docs before any forward day is decoded. Add a unit check that flags pools whose opening reserves differ from the plain migrate deposit when no `PostCompleteBuyEvent` is present.
  - **Regime.** G1-0's catchable share on the pre-v3 tape days is an upper bound for forward days. Re-count it on post-v3 days before any forward return is read. The v3 completer is a new rival seller into the same BOOST flow.
  - **BOOST accounting row (descriptive).** Use `virtual_quote_reserves`, `real_quote_reserves_after` and `boost_vault_remaining` per slice. G1's exit is priced on vault plus signed virtual reserves.
  - **One pass.** Run MIG-SEAT's G1–G7 and MAYHEM-SNAP's gate 0 in the same step A pass (same creator-group set, same E rows, 0 credits).
- **W1:** a descriptive, never-classifying tag for the fast class: median (`jito_tip` + `tx_fee`) per trade and median within-slot rank. Any rule taken from fast winners then carries the cost of the seat it needs.
- **Design A and H1-CGO:** nothing from this sweep.

## 4. Honest line
No. The best survivor, the MIG-SEAT pool seat at about 0.5%, is below G1-HC (about 2%), D1 (about 2–4%) and W1 (about 5%). The widened scope's perps ideas failed on cost arithmetic or on how visible the flow is to other traders. The sweep's real output is checked protocol facts (synthetic migration and the decoder gap) that change how G1 must read forward days.