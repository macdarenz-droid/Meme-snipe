# Coverage map of the research programme (2026-10-08)

Made at the end of sweep 5 by two agents (a mapper and a completeness critic), 23:24–23:52 Melbourne. They read the repo only; no market data. Every chance is judgement. Part 1 is the map, verbatim. Part 2 is the critic, verbatim. The critic corrects the map where they differ.

## Part 1: map

**Research coverage map: Solana memecoin bot (8 Oct 2026)**

This covers 80 idea rows. Similar ideas are merged where all their axes match. Sources are cited per row.

Where the files are:
- Most research files are `research/*` and `docs/research/*` on `origin/ccr-7fae2302-drz4co` (head ccae5e27).
- `SWEEP_*`, `LOG.md`, `STEP_A_COUNT_ROWS.md` and `COUNT_ROWS_AMENDMENT_4.md` are under `research/brainstorm-loop/` on `origin/ccr-4d892c1c-tvjf5l` (head cc76bd43).
- `docs/blueprint/ARCH.md` and `HANDOVER.md` were read from the checked-out HEAD, not from the research branches.

**Codes used in the table**
- **Horizon (Hz):** SB same block, s seconds, m minutes, h hours, d days, w weeks.
- **Venue:** PC pump curve; YP young PumpSwap pool (under about 1 day old, or below the bot's H8 liquidity floor); DP deep PumpSwap pool; OD other Solana DEX or launchpad (Raydium, Orca, Meteora); CEX exchange spot; PERP perpetual futures.
- **Info (information source):** P price/volume only; A social/attention; W wallet identity and flows from the tape; R protocol rules and scheduled flows; X cross-venue; O off-chain.
- **Dir (direction):** L long, S short, N market-neutral, LP liquidity provision.
- **Lever (which term of the identity the idea targets):** I information lift, D drift, F flow captured from forced or price-blind payers, T toll. "exit" means the idea only changes payoff shape.
- **Status:** K killed with numbers; U unresolved after data; W waiting on data or designed; T untestable; D dropped on reasoning only (owner closures included); M measured baseline.
- **Size:** the size tested or designed; n/s means not stated.

| # | Idea | Hz | Venue | Size | Info | Dir | Lever | Payer | Status (key numbers) | Source |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Graduation-window rules (72 variants: entry +1/5/15/60 min; price, volume, socials, graduation-time filters) | m,h | YP | $2 | P,A | L | I | none found | K: 0/72 >0; best -6.6%/trade, tightest -7.4% (CI -9.2..-5.4) | `docs/research/empirical.md` |
| 2 | Copy smart-money wallets (RES-2, 120 variants) | s,m | PC,YP | $2-$200 | W | L | I | later buyers (hoped) | K: -11.0% (CI -15.9..-5.9); 0/120 >0 | `docs/research/copytrading.md` |
| 3 | Launch sniping on curve 0.7 s-3 min after create (40 pairs; F1 early buyers, F2 dev buy) | s,m | PC | $10 | P,W | L | I | later curve buyers | K: L480_T1 -7.1% (CI -8.7..-5.8); 40/40 <0 | `launch-probe/RESULTS.md` |
| 4 | Runner R1-R4: cut loss, ride the giant (entry hour 1) | h,d,w | YP | $3-$50 | P | L | D | none (tail bet) | K: R1 -22.4%/trade; 0 trades >=50x in 442 | `runner-probe/RESULTS.md` |
| 5 | Lottery basket of fresh graduates, hold 7-30 d | w | YP | $20 | P | L | D | none | K: -23.5% to -39.5%/trade; LB-SLOW n=48 insufficient | `lottery-probe/RESULTS.md` |
| 6 | Paid DexScreener attention at entry (hype Test 1) | h,d | YP | $10 | A,O | L | I | attention buyers (hoped) | K: paid -27.1% vs unpaid -22.3% (98.33% CI of gap -11.5..+2.8) | `hype/test1/RESULTS.md` |
| 7 | Socials, creator history, graduation speed, exit variants (exploration, 492 coins) | h,d,w | YP | $10 | A,W | L | I | none | K (exploratory): no group >0 capped; all positives = one ~330x coin | `brainstorm/RESULTS.md` |
| 8 | Hot-market timing (HOT = share of recent graduates reaching 2x) | h,d | YP | $50 | P | L | I | none | K (exploratory): hot -17.1% vs -27.3% capped; top decile -21.4% | `regime-probe/RESULTS.md` |
| 9 | Loss-shrinking bet ladder / trailing SOL floor | h,d,w | YP | 0.2% units | P | L | none | none | K: return per unit staked unchanged (-0.176 vs -0.194); risk layer only | `sizing/RESULTS.md` |
| 10 | Real-time swap-level trails and stops vs hourly exits | s,m,h | YP | $10 | P | L | exit | none | K as edge: RT trail sold jackpot at 26.7x vs 131.9x hourly; RT stops 0.59x vs 0.45x | `execution-audit/RESULTS.md` |
| 11 | Deep-pool 5/15-min dips and momentum (MR-A, MR-B, MR-LV, MOM-C; Design E toll/vol screen) | m,h | DP | $50-$500 | P | L | I | impatient sellers (hoped) | K: val -0.76%/-1.03%; lift +0.2..+0.5 pts; 0.30% tier -0.17% (CI -0.71..+0.32); MOM-C -1.68%; LV 6-7 trades | `deep-pool-probe/RESULTS.md; EDGE_DIALOGUE R3` |
| 12 | 5-min dips/breakouts in cheapest Raydium/Orca pools (46 memes) | m,h | OD | $200-$1k | P | L | I,T | impatient sellers (hoped) | K: -0.55% to -0.59%; lift +0.00..+0.13 | `cheap-venue-probe/RESULTS.md` |
| 13 | Blueprint MR-01, 1-min dips, 0.30% tier | m,h | DP | $200-$1k | P | L | I | impatient sellers (hoped) | K: -0.77% (CI -0.79..-0.74) | `mr01-screen/RESULTS.md` |
| 14 | Maker seat: resting bid 3 sigma under (Design C, DLMM proxied by PumpSwap lows) | m | DP | $50 | P | L | T,F | impatient sellers | K: -1.41%/fill (99.58% CI -2.68..-0.42); lift -0.43 | `maker-probe/RESULTS.md` |
| 15 | Daily/weekly D-REV1, W-REV, W-MOM, TREND (survivor list) | d,w | DP | $200 | P | L | I | none | K: val -1.5%, -14.0%, -15.8%, -12.9% | `daily-probe/RESULTS.md` |
| 16 | D-REV3: buy after >=22% daily fall, hold 3 d | d | DP | $200 | P | L | I | panic sellers (hoped) | U: +6.7%/+3.6% on survivor list (CI -25.6..+24.5); random sample 1 trade -72%; survivorship-free re-run downloading | `daily-probe/RESULTS.md` |
| 17 | Weekly TSM/XS momentum and reversal, 19 large memes (perp closes as spot proxy) | w | PERP | n/s | P | L | I,D | none | K: val -1.10% to -1.89%/week; holding SOL beat all | `trend-probe/RESULTS.md` |
| 18 | Hyperliquid shorts: S1 new listings, S2 downtrends, S3 long-short trend | w | PERP | 1x equal notional | P | S,N | D | longs (hoped) | K: S2-S0 -0.26%/wk (CI -0.85..+0.32); S3 -0.58%/wk; S1 withheld (disc. -7.8%) | `short-probe/RESULTS.md` |
| 19 | Squeeze H1/H1-T2: crowded perp shorts + breakout, buy spot pool 6 h (arms A-E) | h | OD | $50 | X,P | L | F | crowded shorts | K: T2 -0.71% (99.58% -1.68..+0.39), lift +0.32 ns; arm A lift +0.39 but net -0.24%; registered primary U (data check) | `squeeze-probe/RESULTS.md` |
| 20 | Relaxed U2 rules (PR #267) | m,h | YP | n/s | P | L | I | none | K: -10.6% (CI -15.3..-5.5); UNVERIFIED here | `SUPERVISOR_MESSAGES.md:170` (PR not on these branches) |
| 21 | Absorption: buy after independent buyers absorb one large seller | m,h | DP | $50 | W,P | L | F | large impatient seller | U: 44 large sales, 8 absorptions, 5 tradable (30 needed); ~6.6M credits; 0/35 unabsorbed recovered in 1 h | `absorption-probe/RESULTS.md` |
| 22 | Multi-token liquidation H3 (wallet dumps >=3 coins in 10 min) | m | DP,OD | $50 | W | L | F | forced seller | U: <=2 events in 1,336 of 195,486 bars; full list ~29M credits | `liquidation-probe/RESULTS.md` |
| 23 | Passive LP on canonical PumpSwap (+ DLMM by reasoning) | d,w | DP | n/s | P | LP | T | takers | K: median -2.5% to -7.4% in SOL; fee yield ~1.9%/yr | `edge.md 7.4` |
| 24 | Funding carry: spot meme + short perp | w | PERP | n/s | X | N | F | perp longs paying funding | K: +4.7%/yr USD, -1.6%/yr in SOL; 2 liquidated at 1x | `edge.md 7.4` |
| 25 | Atomic cross-pool arbitrage (+ PAIR-RESIDUE, sweep 5) | SB | YP,DP,OD | n/s | X | N | F,T | stale quotes | K: 73% same block, 22% next; >=2 slots late ~0.05% of value; PAIR-RESIDUE D | `edge.md 7.4; SWEEP_5` |
| 26 | Stake idle SOL (JitoSOL / native) | w | n/a (staking) | $500-$5k | R | L | D | issuance, MEV tips | M: +4.8%/yr in SOL; baseline, not a meme edge | `edge.md 7.2` |
| 27 | Cashback coins and PUMP volume incentives | m,h,d | YP,DP | n/s | R | L | T | protocol | D (on-chain counts): 29 pools, ~0.09% of trades; accumulators pay 0 | `edge.md 7.4` |
| 28 | Protocol flows: BOOST window, Mayhem agent, PUMP buyback, holder rewards (RES-6/7) | s,m | PC,YP | n/s | R | L | F | protocol buyer | D: BOOST taken within seconds, bot ~23 slots late; mayhem prices synthetic; buyback ~0.005% | `edge.md 6.6, 7.4` |
| 29 | Other closed routes: curve intensity, event-clock U2, LST band, creator-fee seats, cranks, front-page, retail defaults, DCA, unlocks | mixed | mixed | n/s | mixed | mixed | mixed | various | D: in-sample/no fees, too few trades, out of reach, or statistical | `edge.md 6.6, 7.4` |
| 30 | Buy speed (leader shreds, co-location) | SB | PC,YP,DP | US$1.4-3.4k/mo (UNVERIFIED) | X,P | N,L | T | slower bots | D: cost; bounce fades over minutes | `edge.md 8.2` |
| 31 | Toll engineering: Jito bundleOnly, keep token accounts, larger size, 0.30% tier, TAPE-EXEC | m,h | YP,DP | $2-$1k | R | L | T | n/a | D (arithmetic): bundleOnly ~0.8% of $2; rent 0.05-0.13 pts at $20-50; no edge alone | `edge.md 6.4, 7.2; SWEEP_1` |
| 32 | Attempt 1 H1-H6: U1 dip-reversal, quiet accumulation, breakout; U2 reclaim, exhausted dump; H1 if SOL up | m,h | DP,YP | $2 | P,W,X | L | I | none named | W: registered, never scored (no pre-wall market day) | `edge.md 2-3; edge/preregistration.json` |
| 33 | PM-01: 15 s breakout above post-migration high, depth rising, 20-120 min | m,h | YP | n/s | P | L | I | momentum followers | W: PREREG predicts a loss; kill-only B-10 screen pending | `docs/blueprint/ARCH.md:395; HANDOVER.md:160` |
| 34 | Owner's own picks, forward test | h,d | YP | n/s | O | L | I | crowd | D: owner declined | `edge.md 10.3; IDEA_BOARD #11` |
| 35 | Audience gains: cohort's outside gains predict next 6 h buying | h | YP,DP | $50 | W | L | F | lottery-minded buyers | W: est. 15-17M credits at 10/call (recount suggests less, UNVERIFIED); tape approved | `audience-gains/PREREG_DRAFT.md` |
| 36 | Community crossing among early buyers | h | YP | $50 | W | L | I | later buyers | W: shared tape | `community-probe/PREREG_DRAFT.md` |
| 37 | Failed slippage buys as hidden demand | m | YP,DP | $50 | W | L | I | later buyers | W: shared tape | `failed-tx-probe/PREREG_DRAFT.md` |
| 38 | SOLMEMES creation-time text replication | m,h | YP | $50 | A | L | I | later buyers | W: shared tape; HF dataset unusable | `solmemes-replication/PREREG_DRAFT.md` |
| 39 | Revenue-funded Tokenized-Agent buybacks (+ regular-gap arm; XFEE-BUYBACK) | d | DP,YP | n/s | R,W | L | F | protocol buyback | W: deferred (GeckoTerminal load); XFEE-BUYBACK D (1 coin) | `buyback-probe/PREREG_DRAFT.md; EDGE_DIALOGUE R5; SWEEP_3` |
| 40 | First spot listing on a big CEX (H4-TS; RES-6 announcements) | h | DP,OD | $50 | O | L | F | new venue buyers | T: ~73 events in 33 months | `listing-probe/PREREG_DRAFT.md; edge.md 6.6` |
| 41 | Theme leader when a theme goes viral (H2) | m,h | DP,OD | n/s | O,A | L | I | clone buyers | W: forward-only | `theme-leader/FORWARD_DESIGN.md` |
| 42 | Holding-incentive expiry short (TRUMP perp) | d | PERP | n/s | O,R | S | F | incentive holders | T: 2-3 clean pre-wall events | `audience-gains/SCOUT_SIX.md; SHARED_TAPE_PLAN.md` |
| 43 | Design A: creator fee step at 420 SOL (+ round-USD check, A-FOCUS) | m,h | YP | $50 | R,W | L | F | creator defending level | W: gate 1 read (step since 2025-09-02); gates 2-3 on Step A; A-FOCUS D | `EDGE_DIALOGUE Agreed designs; STEP_A_COUNT_ROWS 6; SWEEP_2` |
| 44 | Design B: forced stop-loss bursts overshoot (+ CS1 copy-sell cascades) | m | YP,DP | $50 | W | L | F | retail stop-losses | D: parked for Step B; CS1 dropped as duplicate | `EDGE_DIALOGUE R1-R3; SWEEP_1` |
| 45 | Cross-venue lag: USD-anchor lag (Design D), STALE-QUOTE LAG, USD-STEP | m,h | DP,YP | n/s | X | L | I | slow dollar-minded holders | D: profit in SOL; ceiling arithmetic fails | `EDGE_DIALOGUE R1, R3; SWEEP_1; SWEEP_2` |
| 46 | P2: PumpSwap non-arb flow predicts Hyperliquid perps | m,h | PERP | n/s | W,X | L,S | I | slow perp traders | D: owner "P2 No" (scope widened 21:55, not re-opened) | `LOG.md 17:15` |
| 47 | F1 follower flow: buy after a followed wallet, sell to slower followers | s,m | PC,YP | n/s | W | L | F | copy/alert followers | W: counts gate; owner ethics ruling first | `f1-follower-flow/GATE.md` |
| 48 | W1 winner autopsy (slow wallets' persistent profits) | m,h | PC,YP | $50 replay | W | L | I | finds the seat | W: Step A | `w1-winner-autopsy/PREREG.md` |
| 49 | D1 discovery funnel, 28 features (+ D1-H8) | m,h | YP,DP | $5-$50 | P,W,R | L | I | found by data | W: Step A | `d1-discovery-funnel/PREREG.md, AMENDMENT_3` |
| 50 | H1-CGO capital-gains overhang (+ D60 due supply) | h | YP | $50 | W | L | F | disposition-prone holders | W: Step A/B | `h1-cgo/PREREG.md; SWEEP_3` |
| 51 | G1: curve inventory into migration, sell to BOOST and snipers (Blueprint GR) | s,m | PC,YP | $50 ($5-$1k) | R,P | L | F | BOOST, opening snipers | W: Step A | `g1-boost-inventory/PREREG.md` |
| 52 | G1 filters: G1-HC/G1-E/G1-XB (holder makeup), G1-CAP (rival curves), USDC-SEG | s,m | PC,YP | $50 | R,W | L | F | BOOST, snipers | W: Step A; USDC-SEG D | `g1-boost-inventory/AMENDMENT_1-2; SWEEP_1-2` |
| 53 | BOOST-RESIDUAL: pool entry after openers are spent | s,m | YP | n/s | R,W | L | F | BOOST | W: descriptive rows in G1-0 | `SWEEP_1 2.1` |
| 54 | MIG-SEAT: land by pool slot s0+2, sell at +60 s | SB,s | YP | $100 ($5-$1k) | R,W | L | F | BOOST, later buyers | W: Step A gate; ~US$509/mo infra (UNVERIFIED) | `SWEEP_5 1.1` |
| 55 | SYN-COMPLETE: be the synthetic-migration completer | s,m | PC,YP | $500 ($1k+) | R | L | F | BOOST, opening buyers | W: needs synthetic migration live; forward only | `SWEEP_5 1.2` |
| 56 | MAYHEM-24: buy surviving mayhem coins after T+24 h burn | h | PC,YP | $20 | R,A | L | F | screen-bound buyers | W: counts only | `SWEEP_1 2.3` |
| 57 | MAYHEM-SNAP: back-run mayhem synthetic re-prices (Design G revived) | s,m | PC | $20 | R | L | F | curve SOL via re-prices | W: gate 0 counts; owner question open | `SWEEP_5 1.3; EDGE_DIALOGUE R4-R5; LOG 23:24` |
| 58 | APP-TOLL: retail-app buying wave into a clean float | m | YP | $50 ($5-$10k) | W | L | F | late app buyers | W: Step A | `SWEEP_1 2.2` |
| 59 | CREATOR-BUY (INSIDER-BUY, FEE-RECYCLE) + claim-outcome reject table (CLAIM-LEAD) | h | YP,DP | $50 | W,R | L | F | sellers into creator buying | W: ethics ruling first | `SWEEP_1 2.4; SWEEP_3 1.3` |
| 60 | DEV-ZERO: creator full exit flips "dev sold" screens | m | YP,DP | $50 | W,A | L | F | screen-filtered buyers | W: count row | `STEP_A_COUNT_ROWS 1` |
| 61 | REBUY-ANCHOR: profit-sellers rebuy below sale price | h | YP | $50 | W | L | F | repurchasing ex-holders | W: count row | `STEP_A_COUNT_ROWS 2` |
| 62 | SEAT-DRIFT: busy-minute graduates found late (+60 min) | h | YP | $50 | R,W | L | F | late discoverers | W: count row | `STEP_A_COUNT_ROWS 3` |
| 63 | SLICE-RIDE (ACCUM-RIDE, SLICER-RIDE): ride a wallet's unfinished slices | m | DP,YP | $50 ($5 today) | W | L | F | slicer's later slices | W: count rows; owner "Yes" 21:53 | `COUNT_ROWS_AMENDMENT_4; SWEEP_4` |
| 64 | Tool thresholds: AGE-GATE, CLOCK-CROWD, AGE-24 Jupiter fee step | m,h | PC,YP,DP | n/s | A,R | L | F | tool-driven buyers | D/count row: exit hazard only; CLOCK-CROWD front-runs presets | `SWEEP_1-2; STEP_A_COUNT_ROWS 4` |
| 65 | Other bots' habits: MM-FLOOR, WASH-ECHO, WC-420, FLIP-BUYER, METAORDER-END | m,h | YP,DP | n/s | W | L,LP | F | other bots | D: labels/count rows only; WC-420 arithmetic fails | `SWEEP_1-3` |
| 66 | QUOTE-PARENT / PARENT-FILL / CHILD-TOLL: pump-coin-quoted children | h | PC,DP | n/s | R | L | F | child curve buyers | D: not live (Global has no max_curve_depth) | `SWEEP_1; SWEEP_3` |
| 67 | CTO-EVENT: admin community-takeover approval | h,d | YP,DP | n/s | R | L | I | late revival buyers | W: count row | `SWEEP_1` |
| 68 | Meteora DBC/DAMM launchpads: FARM-CURVE, CLONE-BET, FEE-CLIFF | m | OD | $5-$20 | R,A | L | F | completion/late buyers | D: no DBC rows; approvals; ethics | `SWEEP_2; SWEEP_5` |
| 69 | FLUSH-BUY: buy after forced long-liquidation flush | m,h | PERP,OD | n/s | X | L | F | liquidated longs | D: owner "no hyperliquid"; not re-run | `SWEEP_1 2.5; LOG 18:16` |
| 70 | Sweep-5 perp ideas: FUND-CLOCK, XMARGIN-VICTIM, TWAP-RIDE, BETA-STRIP | m,h,d | PERP | n/s | X,R,W | L,S,N | F | funding payers, liquidated, TWAP | D: cost arithmetic, visibility, no history | `SWEEP_5 2` |
| 71 | SHORT-PAYS: beta-hedged short where shorts pay longs | d | PERP | $10 min order | X | N | F | holders exiting via shorts | W: $0 Hyperliquid data | `SWEEP_5 1.4` |
| 72 | H1-PERP (C1/P1): squeeze traded on the perp | h | PERP | $5-$10k | X,P | L | F | crowded shorts | W: exploratory (after T2 read prices); not run | `CONNECT_THE_DOTS P1; IDEA_BOARD` |
| 73 | D-SPLIT (P2): liquidated, not dying | d | DP | $5-$10k | W,P | L | F | holders cashing out | W: survivorship-free download + Helius | `daily-probe/PREREG.md; CONNECT_THE_DOTS P2` |
| 74 | ABS-S1 (P3): cleared overhang, absorbed | m,h | DP | $5-$1k | W | L | F | exited seller | W: needs absorption to pass | `CONNECT_THE_DOTS P3` |
| 75 | Connect-the-dots stacks: A-FULL, A-TAILSAFE, A-ABS, Chain 1, Chain 4 | h,d,w | YP,DP | n/s | P,A,W | L | I | none | D: stacked losers still lose | `CONNECT_THE_DOTS 2, 5` |
| 76 | Connect-the-dots spot chains: Chain 2 (squeeze + spot breadth), lonely crowded short | h | OD | n/s | W,X | L | F | crowded shorts | D: spends arm A's sealed half; duplicate; look-ahead calm cut | `CONNECT_THE_DOTS 2, 5` |
| 77 | Connect-the-dots perp chains: Chain 3 (perp short), C2 seller fate, C3 on-chain heat basket, C4 exchange-deposit lead | m,h,d | PERP | n/s | W,X,O | L,S | F,I | forced sellers, depositors | D: rare; move spent by +1 h; heat lags price; nothing measured | `CONNECT_THE_DOTS 2, 5` |
| 78 | Hype tests 2-6: volume exits, big-holder-sell exits, second-wave crowd, live panel, X mentions | m,h,d | YP | $10 | P,W,A,O | L | I,exit | crowd | W: not run (Test 2 absent; Test 3 needs data; X paid) | `hype/RESEARCH.md` |
| 79 | Attention dead ends: Telegram calls, VIP tiers, KOL copy, trending lists, SOCIAL-CLAIM | m,h | PC,YP | n/s | A,O | L | I | none | D: banned, lagging, manipulation | `hype/RESEARCH.md; SWEEP_3` |
| 80 | Filters, not edges: LAUNCHER-ID, H8 virtual-depth fix, PAYER-MASS, H8-SETTLE, DIP-POWDER, COST-DEFENDER | n/a | n/a | n/a | n/a | n/a | none | none | Screens/labels; no alpha | `SWEEP_3-4; edge.md 7.3` |

**Status tally:** 32 waiting, 22 killed (including the execution audit, row 10), 19 dropped (including row 64, "dropped/count row"), 3 unresolved, 2 untestable, 1 measured baseline, 1 filters row.

**Lever tally:**
- Only 4 flow-lever ideas were ever return-tested: rows 14, 19, 24 and 25. All four lost.
- 33 flow-lever ideas are designs only. Most wait on shared-tape Step A, which `shared-tape/stepa-0910-progress.md` shows at 2 of 61 units stored for 09-10 (as of 10:36Z).

## Coverage map (horizon × venue × information × direction)

How the map was built:
- Each row's axes were expanded as a full cross-product, so ideas with several axes overstate their coverage a little.
- Rows 26, 29, 31 and 80 have no usable axes and are left out.
- Each cell shows four characters in the order **L, S, N, LP**.
- Each character is the best level reached in that cell:
  - **R**: a return or outcome was computed on market data.
  - **C**: data was read, but only counts, no returns.
  - **Z**: reasoning or design only.
  - **.**: untouched.

Totals: 864 cells. 124 touched (36 R, 12 C, 76 Z). **740 untouched.**

| Venue | Hz | P | A | W | R | X | O |
|---|---|---|---|---|---|---|---|
| PC | SB | Z.Z. | .... | .... | .... | Z.Z. | .... |
| PC | s | R... | .... | R... | C... | .... | .... |
| PC | m | R... | Z... | R... | C... | .... | Z... |
| PC | h | .... | Z... | Z... | Z... | .... | Z... |
| PC | d | .... | .... | .... | .... | .... | .... |
| PC | w | .... | .... | .... | .... | .... | .... |
| YP | SB | Z.Z. | .... | Z... | Z... | Z.R. | .... |
| YP | s | R... | .... | R... | C... | .... | .... |
| YP | m | R... | R... | R..Z | C... | Z... | Z... |
| YP | h | R... | R... | R..Z | C... | Z... | R... |
| YP | d | R... | R... | R... | C... | .... | R... |
| YP | w | R... | R... | R... | .... | .... | .... |
| DP | SB | Z.Z. | .... | .... | .... | Z.R. | .... |
| DP | s | .... | .... | .... | .... | .... | .... |
| DP | m | R... | Z... | C..Z | C... | Z... | Z... |
| DP | h | R... | Z... | C..Z | C... | Z... | Z... |
| DP | d | R..R | Z... | Z... | C... | .... | .... |
| DP | w | R..R | Z... | Z... | .... | .... | .... |
| OD | SB | .... | .... | .... | .... | ..R. | .... |
| OD | s | .... | .... | .... | .... | .... | .... |
| OD | m | R... | Z... | C... | Z... | Z... | Z... |
| OD | h | R... | Z... | Z... | .... | R... | Z... |
| OD | d | .... | .... | .... | .... | .... | .... |
| OD | w | .... | .... | .... | .... | .... | .... |
| CEX | all six | .... | .... | .... | .... | .... | .... |
| PERP | SB | .... | .... | .... | .... | .... | .... |
| PERP | s | .... | .... | .... | .... | .... | .... |
| PERP | m | .... | .... | ZZZ. | ZZZ. | ZZZ. | ZZ.. |
| PERP | h | Z... | .... | ZZZ. | ZZZ. | ZZZ. | ZZ.. |
| PERP | d | .... | .... | ZZZ. | ZZZ. | ZZZ. | ZZ.. |
| PERP | w | RRR. | .... | .... | .... | ..R. | .... |

### Cells no idea has touched (740)

1. **CEX spot as the traded venue: all 144 cells.** CEX data appears only as a signal: Binance open interest in row 19, SOLUSDT in row 45, listing events in row 40.
2. **Short on any spot venue (PC, YP, DP, OD, CEX): all 180 cells.** The repo documents no borrow or short instrument for these coins. Whether one exists is UNVERIFIED.
3. **Short on PERP: 23 cells.** Untouched are:
   - SB and s, with every information source;
   - m, h and d with P or A;
   - w with A, W, R, X or O.
   The only data-touched short cell is PERP/w/P (row 18).
4. **Market-neutral: 198 of 216 cells.** The only touched neutral cells are:
   - SB/X on YP, DP and OD (arbitrage, R);
   - SB/P on PC, YP and DP, plus PC SB/X (speed, Z);
   - PERP m/h/d with W, R or X (Z);
   - PERP w with P or X (R).

   Never touched:
   - neutral trades with A or O information, anywhere;
   - PERP neutral at SB, s, or with P at m/h/d (for example pairs or relative value between meme perps);
   - every spot-venue neutral cell at s through w;
   - every CEX neutral cell.
5. **Liquidity provision: 210 of 216 cells.**
   - PC (the curve is protocol-owned, so LP is structurally not possible there), OD, CEX and PERP: all untouched. Meteora DLMM, Raydium CLMM and DAMM v2 LP appear only as reasoning inside rows 14 and 23.
   - YP: only W at m/h (Z).
   - DP: only P at d/w (R) and W at m/h (Z).
   - So LP at SB or s (just-in-time style) and LP conditioned on R, X, A or O information are untouched everywhere.
6. **Long-side holes:**
   - **DP:** the whole s horizon (all six sources); A, W and R at SB; X at s, d and w; R at w; O at SB, s, d and w.
   - **YP:** A at SB and s; R at w; X at s, d and w; O at SB, s and w.
   - **PC:** d and w entirely; X at s through w; A and O at SB and s; P at h; W and R at SB.
   - **OD:** the whole SB, s, d and w horizons, with every source; R at h. Listed Solana memes have only m/h price tests and the h squeeze test.
   - **PERP:** the whole SB and s horizons; A at every horizon; P at m and d; W, R, X and O at w.

### Cells touched only by reasoning, never by data (76)

1. **PERP at m, h and d (34 cells).**
   - Long: W, R, X and O, plus P at h. Rows 46, 69, 70, 72, 77.
   - Short: W, R, X and O. Rows 42, 46, 70, 77.
   - Neutral: W, R and X. Rows 70, 71.

   Every perp idea except the weekly price tests (rows 17, 18, 24) is untested.
2. **Same-block seat (12 cells).**
   - PC, YP and DP SB with P (L and N) and X (L; also N on PC). Row 30.
   - YP SB with W and R, long. Row 54.
3. **Curve at hours and minutes (6 cells).** PC long with A at m/h, W at h, R at h, and O at m/h. Rows 48, 56, 64, 66, 79.
4. **Young pools (5 cells).**
   - YP long with X at m/h, and with O at m. Rows 45, 78, 79.
   - YP LP with W at m/h. Row 65.
5. **Deep pools (12 cells).**
   - DP long with A at m/h/d/w; W at d/w; X at m/h; O at m/h. Rows 40, 41, 45, 60, 64, 73, 75.
   - DP LP with W at m/h. Row 65.
6. **Other DEX (7 cells).** OD long with A at m/h, W at h, R at m, X at m, and O at m/h. Rows 40, 41, 68, 69, 76.

### Cross-cutting gaps

- **Protocol-rule information (R) has never been return-tested in any cell.** Its best level is counts only (rows 27, 28). Staking (row 26) is left off the map.
- **Off-chain information (O)** has a return test only via hype Test 1, on YP at h/d.
- **Wallet information (W)** has return tests only on PC and YP (rows 2, 3, 7). On DP it has counts only (rows 21, 22, both too rare).
- **Size:** no return test at $10k or more. The largest tested size is $1,000 (rows 12, 13). The $10k designs (rows 58, 72, 73) have not been run.

## Part 2: completeness critic

**Completeness critique of the research coverage map (8 Oct 2026)**

Branch heads have moved since the map was written. Research is now `df2b24b0` (map said `ccae5e27`). Brainstorm is now `e0e348e5` (map said `cc76bd43`). Every chance below is my judgement, not a measurement.

## 1. Map check: fixes

**Status fixes**
- **Row 57 (MAYHEM-SNAP).** It is no longer "owner question open". The owner ruled at 23:29: "test first", and he approves bot use only on results. A PREREG may be written if count rows (a)–(e) pass. The legal check still applies before any real use (`research/brainstorm-loop/COUNT_ROWS_AMENDMENT_6.md`; LOG 23:29).
- **Rows 46 (P2) and 69 (FLUSH-BUY).** The owner closed them at 17:15 ("P2 No") and 18:16 ("no hyperliquid"). His 21:55 ruling widened the scope to any angle, including Hyperliquid (LOG.md). `research/IDEA_BOARD.md` already reopened H1-PERP on that ruling. So both rows should read "closed under a ruling that was later widened; the lead can reopen them", not a hard drop.
- **Row 72 (H1-PERP).** Should read "reopened for research (IDEA_BOARD); exploratory; not run" (`squeeze-probe/PREREG.md` item 23).
- **Row 44 (Design B).** It is parked for Step B (EDGE_DIALOGUE round 3, "Parked: B"), so W, not D. Only CS1 is D.

**Placement fixes**
- **"Protocol-rule information (R) was never return-tested" is too strong.** Row 1's grid entered at mig+1m and mig+5m, inside BOOST's 100–280 s window. `edge.md:75` says 0 of 72 rules were positive, "including the +5-min momentum and BOOST windows". So the YP/m/R long cell has an indirect kill. Flow-lever ideas that were return-tested become 5, not 4.
- **"CEX: all 144 cells untouched" overstates the gap.**
  - Rows 12, 17 and 19 trade large memes whose prices are tied to CEX books by arbitrage.
  - Row 17 uses perp closes as a stand-in for spot (`trend-probe/PREREG.md:9`).
  - The gross results therefore carry over to CEX at m/h/w with P, and at h with X. Only the toll differs.
  - The owner's exchanges are Kraken and Independent Reserve. Whether their toll beats Raydium's 0.25% is UNVERIFIED.
- **Spot shorts (180 cells) are covered by other cells, not missing.** For a listed meme, a spot short has the same economics as a perp short. For pump coins no instrument is known (UNVERIFIED).

**Omissions to add**
- risk.md §8 **S5, bonding-curve late-stage entry.** Dropped on reasoning at `edge.md:76`. It is G1's ancestor.
- **"Riding bot-pumped coins"** (a slow, steady, low-volume climb). Asked at `ADVISOR_PROMPT.md:31`. I found no design or answer in any research file. Untouched: YP/DP, h–d, P/W, long. It also raises an ethics question.
- **Sweep 3's own lens drops, about 11 names:** FEE-SHARE-JOIN, CTO-DIVIDEND, DISTRIBUTE-CRANK, BUYBACK-CLOCK, REWARD-RECYCLE, POOL-GIFT, DIVIDEND-INIT, G1-HR, charity coins, and the FOOTPRINT and BOOST-STUCK variants (`SWEEP_3.md` §2).
- **EDGE_DIALOGUE round 3 drops:** "regime from Binance memes"; the 1,470+ SOL fee-ladder steps; placebo-level crosses used as a momentum entry.
- **GR-R, MG-R and SN-R** (`docs/blueprint/ARCH.md:397`). These are measurements, not edges, but they feed G1 and MIG-SEAT.

**Data claims in the task**
- **The tape is not free for 09-02..09-11.** Only Step A (09-10 and 09-11; 123 units in `stepa-plan.txt`) is approved and running. Day 09-10 had 2 of 61 units stored at 10:36Z. Step B (about 0.8M credits) and Step C (about 1.3M credits) open only if a registered gate passes (`SHARED_TAPE_PLAN.md:74-76,86`).
- **The tape decodes only pump-curve and PumpSwap trades** (`shared-tape/README.md`). Every OD and CEX cell is outside it.
- **GeckoTerminal bars are not in the repo.** The RESULTS files say "Raw candles are not committed", so they need a free re-download. 5-minute pool history reaches back only 180 days (`squeeze-probe/PREREG.md:45`).
- **What the free perp data covers:**
  - Binance's public archive has 5-minute OI, plus account, top-trader and taker long/short ratios, for 20 Solana memes from 2023-11.
  - Hyperliquid's 5-minute candles reach back only about 17 days. Its minute-level OI history is in a requester-pays bucket (`squeeze-probe/SCOUT.md`).
  - Binance's live API returns HTTP 451 from the research hosts.
- **Perps are cheaper, but not by much.**
  - A realistic Hyperliquid meme round trip is 12–35 bps (`edge.md` §10.5).
  - The repo's conservative perp rule charges 0.60% for the meme leg plus the SOL leg (`CONNECT_THE_DOTS.md` P1). That is about Raydium's round trip at $200.
  - So the advantage is 1–3×, not 10×. Impact above about $500 is unmeasured.

## 2. Ranking of the untouched and reasoning-only cells

**What the killed tests teach**
- **Toll:** a public price signal adds +0.05 to +0.5 points. The cheapest Solana DEX seat costs 0.5–0.66% (`edge.md` §8.3). So every DEX cell with P or A information is dead.
- **Drift:** memes fall against SOL, but the sign changes with the regime (trend probe: +2.33% a week in discovery, −0.91% a week in validation).
- **No bounce in single-venue AMM pools:** maker seats and LPs suffer adverse selection.
- **Speed:** SB and s seats belong to faster bots.

| Rank | Cell (venue/Hz/info/dir) | Why it ranks here | Chance |
|---|---|---|---|
| 1 | PERP / h / X / S | A forced payer, a funding carry and drift together. It mirrors the programme's only lift whose CI cleared 0: squeeze arm A, +0.39 pts (95% +0.01 to +0.77) | 2–3% |
| 2 | PERP / h–d / X,R / N | A named payer (funding); neutral to drift. But the carry is thin and one leg can be liquidated | about 2% |
| 3 | PERP / m / X / L | A forced payer and many events. But the bounce may be spent in 5 minutes, and Hyperliquid liquidations are public | about 1.5% |
| 4 | PERP / h / X,P / L (H1-PERP) | Real lift, but T2's gross was −0.11% and the test has little power | 1–2% |
| 5 | PERP / w / X / S (crowding basket) | Free data. Short-probe S2 (price only) added no lift | about 1% |
| 6 | PERP / m–h / W / L,S (C4, P2) | Real information, but no free data for mints that are not pump coins | about 1% |
| 7 | PERP / m–h / P / N (pairs, lead-lag) | Large samples, but a public price signal raced by high-frequency firms | under 1% |
| 8 | YP/DP / m–h / X,O / L | A public signal against a 0.6–3.5% toll | under 0.5% |
| 9 | CEX (any cell) | Covered by the PERP and OD cells; no toll edge for an Australian account (UNVERIFIED) | under 0.5% |
| 10 | LP (JIT, or rule-conditioned) | BOOST and mayhem trades pay the LP no fee (`edge.md` §7.2). JIT needs other people's pending orders, which is an ethics problem | about 0 |
| 11 | SB, s, PC at d/w, DP at s | Speed seats are taken; curve coins drift down | about 0 |

## 3. Proposals for the top three cells

### Idea 1: CROWD-BREAK-SHORT (PERP / h / X / S)
- **Who pays:** crowded leveraged longs (high funding, high OI) who are forced out on a breakdown. They also pay us funding while we hold (`short-probe/PREREG.md` item 3).
- **Data (0 credits):**
  - Hyperliquid hourly funding (`short-probe/fetch_hl.py`).
  - Binance perp 5-minute OI and 1- and 5-minute klines from data.binance.vision, 2023-11 to the wall.
  - The SOL perp for the SOL leg.
  - The squeeze stage-1 coin list and its funding-cut rules.
- **Rule:** the exact mirror of `squeeze-probe/PREREG.md`, fixed now.
  - Funding is above 90% of the previous 720 hourly rows.
  - OI is above 90% of the previous 720 hour marks, read as of h − 300 s.
  - Breakdown: a completed 5-minute coin/SOL close below the lowest of the previous 72 closes.
  - At most one event per coin per UTC day, and at least 6 h between events.
  - Short 1x at the first 1-minute open at or after T + 7 s. Exit at +6 h, with no stop.
  - Return in SOL with the SOL leg, as in CONNECT_THE_DOTS P1.
- **Gate (reads no strategy return):**
  - At least 600 h of data overlap per coin, and at least 10 coins.
  - At least 150 executable events on at least 100 days.
  - OI falls 5% or more by T + 6 h more often than in matched ordinary breakdowns (one-sided 95% lower bound above 0). This reads OI only, never price.
  - Median funding at events is above 0.
- **Primary test:**
  - Mean net and lift over matched ordinary breakdowns (squeeze C1 method).
  - Day-block bootstrap and day-clustered t at 99.5%.
  - The repo's 0.60% perp cost is the primary; the realistic Hyperliquid line is shown beside it.
  - A 1.714× liquidation stress line is shown, as in the short probe.
- **Kill:** any gate item fails; mean net ≤ 0; lift ≤ 0 or below the round trip; either date half ≤ 0; the T + 60 s line ≤ 0.
- **Honesty note:** these prices were already viewed by the short, trend and squeeze probes, though this condition was not. So a pass earns only forward paper trading and a sign check on 09-22..10-20 after 10-21.
- **Frequency:** UNVERIFIED. The long-side analog had at most 349 coin-days in about 2.8 years, about 2–3 a week.
- **Chance:** 2–3%.

### Idea 2: FUND-SPREAD (PERP / h–d / X,R / N)
- **Who pays:** leveraged traders on the more crowded venue, who pay more funding than on the other venue for the same coin.
- **Data:**
  - Hyperliquid hourly funding (free).
  - Binance funding history from data.binance.vision. Whether these files exist is UNVERIFIED; step 0 is one keyless listing call.
  - Basis measured on daily closes (Hyperliquid daily candles against Binance klines).
- **Rule:**
  - At 00:00 UTC, compute s = the trailing 24-h mean funding gap (Hyperliquid minus Binance).
  - If |s| × 72 h is at least 2 × the four-leg toll, short the venue with higher funding and long the other, 1x each.
  - Exit at 72 h or when s changes sign. Add a SOL leg.
- **Gate (reads no strategy return):**
  - The Binance files exist and their times match settlement times.
  - At least 10 coins with at least 180 overlapping days.
  - At least 300 signal coin-days after a cap of one per coin per 3 days.
  - Either leg moves 50% or more within 72 h in at most 1% of windows.
- **Primary test:** mean net in SOL, and its excess over staked SOL (4.8% a year, `edge.md` §7.2). 99.5% day-block bootstrap; both must be above 0.
- **Kill:** step 0 fails; net ≤ 0 or no better than staking; any leg liquidated; either half ≤ 0.
- **Frequency:** daily decisions across 10–20 coins (UNVERIFIED).
- **Chance:** about 2%. Capacity is small. It is a carry trade, not meme sniping.

### Idea 3: FLUSH-PERP (PERP / m / X / L)
- **Who pays:** liquidated or forced longs who sell at any price.
- **Data (0 credits):** Binance 5-minute OI and taker long/short ratio, and 1-minute klines, 2023-11 to the wall. Hyperliquid funding for the carry.
- **Event:**
  - A coin/SOL 5-minute return of −3σ or worse (σ by MR-A's rule) together with an OI change of −2% or worse.
  - Decision time T = the OI row's time + 300 s (the repo's as-of rule).
  - Buy 1x at the first open at or after T + 7 s. Exit at +60 min. At most 5 coins a day.
- **Control:** drops of the same size where OI was flat or rising, matched like squeeze C1.
- **Gate (reads no returns):**
  - At least 100 independent event-days after the cap.
  - No coin above 30% of events.
  - Flushes and controls each make up at least 20% of qualifying drops.
  - Taker-sell share is higher in flush bars than in control bars (one-sided 95% lower bound above 0). That the column measures what its name says is UNVERIFIED.
- **Primary test:** validation 2025-01-01 to 2025-09-18 (SWEEP_1's FLUSH-BUY split). Mean net and lift at 99.5%, at least 300 events, both halves above 0, and lift at least the round trip.
- **Kill:** any failure of the above. If only the optimistic T + 0 line passes, record "needs speed we lack" and close.
- **Frequency:** 5–20 a day, clustered (UNVERIFIED).
- **Chance:** about 1.5%. The main risk is that the deep-pool bounce came mostly within 5 minutes, and our entry lands 5 minutes late.

All three share one venue, one regime and the same open question on Australian legality. The chance that at least one passes is about 4–6%, not the sum.

## 4. How exhaustive is the search?

After five sweeps, the idea search is close to complete, but the testing is not. The map holds well over 100 named ideas. Each sweep's best new idea has been weaker: about 2%, then 0.5%, then a filter, then 0.2%, then 0.5%. Most of the 740 empty cells are empty for structural reasons: no short instrument, no venue, or speed. The one live empty region is perps at minutes to days, which the 21:55 ruling reopened. What is thin is evidence. All 22 kills were long trades, nearly all on DEX prices. No return test has yet used the shared tape's wallet, failed-transaction or protocol rows, and that is where the best open bets sit.

The most informative single test is W1 on Step A, then Step B. It asks whether any class of traders no faster than the bot earns profits that last from day to day, and it costs nothing beyond the tape already being pulled. A yes shows a seat worth studying. A no is the strongest evidence that no edge exists at the bot's speed, and it makes most open flow designs much less likely.

The search should stop if three things happen together:
- W1 finds no slow class that persists: the upper bound of the next-day excess return is below the median round trip.
- Step A fails both G1-0 and D1's screen.
- Idea 1 is killed.

Then idea generation should stop. Only registered tests would finish. The bot would keep recording, stay in paper, and report "no edge found". That is the A17 end state already set in CLAUDE.md, due by 31 Dec 2026. More sweeps would not change this; only new data or a new venue could.