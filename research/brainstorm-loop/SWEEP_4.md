# Idea sweep 4 (2026-10-08): only pools the bot can enter under H8

Lenses: who trades in H8-eligible pools, lifecycle events of surviving coins, the best designs moved inside H8, and size economics. Two skeptics, then one synthesis. Run 20:35–21:46 Melbourne, 7 agents. No market data was read. Every chance is judgement. (The ids below were printed with the sweep-2 prefix by the script; they are sweep 4's.)

Honest summary: nothing beats W1 (about 5%), D1 (about 2–4%) or G1-HC (about 2%). The only new mechanism, riding a wallet's unfinished slices (about 0.2%), needs the owner's ruling on front-running first.

The sweep corrected the H8 amendment. The partner checked this at 21:47 in `packages/core/src/gates/hard.ts:284-292` and `config/policy.ts:186-205`:
- H8's floor depends on the strategy's universe tag. In U1 (Zeroed's 1–14-day universe) it is at least $50k at any size up to $50, about 419 SOL. Elsewhere it is max($15k, 1,000 × size).
- The trial policy allows at most $5 a trade, 1 open position, 3 entries a day and 1 per mint a day.

## All ideas and the skeptics' votes
| Id | Idea | Skeptics keeping it | Skeptics' chances (econ+evidence / truth+rules) |
|---|---|---|---|
| s4-deep-pool-flows-1 | SLICER-RIDE: ride an identified wallet's unfinished buy in U1 pools | 1 of 2 | 0.15% / 0.1% |
| s4-deep-pool-flows-2 | DIP-POWDER: buy U1 dips only where averaging-down holders hold idle SOL | 0 of 2 | 0.03% / 0.02% |
| s4-lifecycle-events-3 | ACCUM-RIDE: ride a budgeted single-wallet buy metaorder in an H8-eligible pool (lens item: large holder entries) | 1 of 2 | 0.2% / 0.1% |
| s4-lifecycle-events-4 | COST-DEFENDER: buy when the price returns to a finished, still-budgeted accumulator's own cost (lens item: large holder entries, second act) | 0 of 2 | 0.02% / 0.01% |
| s4-mix-best-5 | SLICE-RIDE: ride an identified slicer's remaining buys in pools the bot can enter (G1's 'sell to a buyer with a known budget', moved into H8) | 0 of 2 | 0.1% / 0.1% |
| s4-mix-best-6 | D1-H8: the discovery funnel searched only where the bot can trade, with exits the bot can run (a version of D1; must freeze before D1's search reads Step A) | 0 of 2 | 0.3% / 0.4% |
| s4-size-economics-7 | H8-SETTLE (a test, not a new edge): the deep-pool bounce at its cheapest size | 0 of 2 | 0% / 0% |
| s4-size-economics-8 | PAYER-MASS (a screen for every open flow design inside H8, not a new edge) | 0 of 2 | 0% / 0% |

## Synthesis (verbatim)


I checked these facts in the code for this report:
- **U1 floor.** U1's floor is $50k at every size up to $50 (`policy.ts:205` `u1FloorUsd`; `hard.ts:285-292` `liquidityFloor`).
- **Universes.** U1 covers pools 1 to 14 days old and U2 covers 60 to 240 min (`backtest/.../config.ts:149-159`). Pools aged 4 to 24 h are in neither.
- **H11.** The chase check runs only under U2 (`hard.ts:354`).
- **H6.** Any outstanding LP gets the pool rejected (`hard.ts:263-271`).
- **Trial limits.** maxNotional is $5, with 1 open position, 3 entries a day and 1 per mint a day (`policy.ts:190-191`).
- **Exits.** U1 and U2 have different exit settings (`policy.ts:241-262`).
- **Front-running ban.** ARCH.md:86 and C-04 (ARCH.md:99) forbid front-running other users.
- **Large sales.** 35 of 43 large sales never recovered within the hour. The "0 of 35" figure holds by construction (absorption RESULTS:41-43).

**Correction to the brief.** The 126 and 168 SOL floors apply only in U2. In U1, $5, $20 and $50 all need about 419 SOL of effective quote at SOL $119.26. Break-even there is 2.89%, 2.21% and 2.18% (edge.md table, line 150). That makes $50 the cheapest size, but $5 is the only size allowed today.

## 1. Survivors

### 1. SLICE-RIDE (merged): ACCUM-RIDE's design, plus parts of SLICER-RIDE and SLICE-RIDE. Chance about 0.2% (judgement)

**Who pays**
- One non-creator wallet buying a coin in slices. Its later slices fill above our entry.
- In a burned-LP constant-product pool, no LP re-prices for that flow.
- Rivals that eat into the gain: holders selling into the buying, back-runners, and arbitrage to other venues. 23 of 41 deep coins had a DLMM pool (lead's read).

**Universe**
- U1 is the primary: pools 1 to 14 days old, $50k floor.
- U2 (60 to 240 min, with H11's chase check) is a separate stratum.
- Pools aged 4 to 24 h are a count only.
- All of H1–H17 apply as of the decision slot t.

**Event, frozen before Step A**
- Owner X with signer = owner, and X is not a PDA.
- X makes its 3rd buy within 30 min, spread over at least 3 slots and at least 60 s.
- X's cumulative buys are at least 1% of the effective quote Q.
- X's dry powder B (signer_sol_post after its last slice) is at least 2.2% of Q.
- X has not sold the mint in the prior 24 h of read data.

**Excluded from trading (their shares are reported)**
- The creator group (LAUNCHER-ID dev set) and protocol rows (BOOST, buyback authority, mayhem vault).
- Two-sided clusters and W1's fast class.
- Slices routed through Jupiter or a terminal (top_program or an app-fee transfer). On the v1 units of 09-11, which lack top_program, this falls back to the signer test.
- Regular cadence (interval CV ≤ 0.2 or size CV ≤ 0.1). SLICE-RIDE's TWAP-shaped trigger becomes this exclusion.
- SOL-pure wallets, where the next slice's pre-balance equals the last slice's post-balance exactly. These look most like standing orders, so they are excluded by default as the safest option.
- SLICER-RIDE's arm B (fresh wallets funded from one hub) is dropped completely.

**Gate (counts only; no price and no pool net flow is read)**
- (a) **Budget realisation:** X's own net buy in (t+23 slots, t+60 min] is at least 50% of B in at least 50% of events. The pool-clustered one-sided 95% lower bound must be above 40%.
- (b) **Materiality:** X's median continuation is at least 2·X*/Q at the pool's universe floor. In U1 at $50 that is about 2.2% of Q (about 9 SOL), with a lower bound of at least 1.1%. Where the O table shows another venue, combined depth is used.
- (c) **Specificity:** compared with a dispersed-flow control, the ratio of medians is at least 2 and its lower bound is above 1. The control is the same 1% of Q in 30 min from at least 3 unlinked wallets with at most 1 buy each, matched on age and Q terciles and the 2-h block.
- (d) **Exhausted-buyer placebo:** wallets with B under 0.5% of Q at the same slice count show at most half of (b).
- (e) **Not momentum:** R² of the event on past 5, 15 and 60-min returns, 15-min volatility, volume and buy count is at most 0.3.
- (f) **Competition, two parts:**
  - fast-class buy SOL in [t, t+23 slots] is at most 25% of B;
  - at most 50% of non-X buy SOL landing 1 to 22 slots after X's slices is sold back before X's last slice.
- (g) **Bait:** at most 50% of slicers sell at least 50% of their buys within 4 h of the end.
- (h) **Stability:** (a)'s share on 09-11 is within 15 points of 09-10.
- (i) **Count, at $5 in U1 after all exclusions:**
  - at least 11 a day: Step B is used, if it is released;
  - 3 to 11 a day: forward days are named before any is read;
  - under 3 a day: closed as untestable.
- **Descriptive rows, no alpha spent:**
  - COST-DEFENDER: the share of finished accumulators that buy at least 1% of Q within 2 h of the price touching their cost band.
  - DIP-POWDER: the share of holders who add within 60 min of falling 20% below their cost, read from H1-CGO's ledger.

**Owner ruling.** After the counts pass and before any return is read, the owner rules whether this counts as "front-running other users" (ARCH.md:86). If he says yes, it closes unrun.

**Primary test**
- Sizes:
  - $50 is the research primary.
  - $5 is reported as the line the bot can trade today, and $20 is reported too.
  - $100 is reported on the stratum of about 838 SOL or more.
  - $1,000 and $10,000 are infeasible under H8.
- Entry at t + 23 slots, at the worse of the slot's start and end state.
- Exit, then + 23 slots, at the first of:
  - X silent for more than max(3× its median gap, 120 s);
  - X's first sell or outbound transfer of the mint;
  - X's SOL below one median slice;
  - 60 min;
  - the policy stop or T_max of 120 min.
- Costs are charged as edge-costs.ts does, in SOL.
- Controls: the exhausted-buyer points give the lift; matched no-episode points are secondary.
- Pass needs all of these, from a pool-clustered, day-stratified bootstrap:
  - the 99.5% lower bound of mean net is above 0;
  - the 99.5% lower bound of the lift is above 0;
  - at least 300 trades;
  - every day above 0.
- It is one loop-family member at 0.005. A pass is followed by a confirmation on never-touched forward days.

**Kill**
- Any gate row fails, or the owner rules it front-running.
- Futility on Step A: the one-sided 95% upper bound of net is below 0. This is read only after the gate and the ruling.
- On validation: the lower bound is at or below 0, the lift is at or below 0, or any day is at or below 0.
- Fewer than 300 trades means unresolved. The sign is never flipped.

**Frequency.** UNVERIFIED; nothing has counted it. Live, the 3-a-day limit means at least 100 days for 300 trades.

**Owner flags**
- The ethics ruling.
- $20 and $50 are research-only until the owner raises maxNotional.
- The live per-swap stream (owner and signer SOL for 30 to 150 U1 pools) has no measured cost. Measure it before naming forward days.

### 2. D1-H8, as D1's amendment 3 (not a new family member). Adds about 0.3% (judgement) to D1's chance of finding a rule the bot can trade

**Who pays.** The rules are found by the data. Each advanced rule's hypothesised payer is written into the commit that freezes it.

**Freeze.** It must be frozen before D1 reads any Step A row. Otherwise it becomes forward-only.

**Universe and gates.** H8 is checked under the tag the bot would apply:
- U2 (60 to 240 min): max($15k, 1,000× size), plus H11's spike and chase checks;
- U1 (1 to 14 days): the $50k floor;
- 4 to 24 h: count only.

As of each decision it also applies H6, H9, H11, H12, H13, H17 and the dust-at-migration check.

**Trade and exits**
- $5 at the decision + 23 slots, taking the first qualifying point per pool per UTC day.
- Exit arm 1 uses the exits of the pool's universe:
  - U1: 5-min ATR, T_flat 30 min, half off at +2R;
  - U2: 1-min ATR, T_flat 15 min, half off at +1.5R;
  - T_max is 120 min in both.
- Exit arm 2 is a fixed 60-minute hold.

**Budget and count kill**
- D1 and D1-H8 share D1's budget of 5 advancing rules, with H8-tradable rules ranked first, so the family's false-pass chance stays where D1 has it.
- Count kill, from D1's "at least 30 trades per fold": at least 150 eligible first-points per fold (my arithmetic: 30 ÷ 0.2 for a quintile rule).

**Pass and kill.** Both are D1's. On top of that come the R14 check, the bot-limits subset, size lines with costs split out, and a forward confirmation.

**Owner flags**
- Which R14 definition applies: evaluate.ts:581 against analysis.ts:433, while settings.ts:37 passes 10,000 bps.
- The strategy-slot universe tag.
- Holds over 120 min need the owner.

**Frequency.** UNVERIFIED; the H8 count row decides it.

## 2. Dropped, with reason
- **DIP-POWDER:** the trigger is a price-only 3σ dip, a dead family. The measured deep-pool gross is +0.09 to +0.39%, against a U1 round trip of 2.18–2.89%. Its habit label cannot be learned from one labelling day, and its coverage gate would likely fail. It survives only as the descriptive row above.
- **COST-DEFENDER:** there is no source that meme whales defend their cost. It is doubly rare, the trigger is a price touch, and idle SOL goes stale. It survives only as the descriptive row above.
- **SLICER-RIDE arm B:** hub-funded fresh wallets are coordinated buying (C-04, and the no-insider and no-bundle rules).
- **SLICER-RIDE and SLICE-RIDE as separate members:** same mechanism as survivor 1, so they were merged into it. SLICE-RIDE's +11% take-profit was dropped: it needs a custom exit hook and is rarely reached within 30 min.
- **H8-SETTLE:** not an edge. Deep-pool bounces are already dead, and its 23-slot test can only kill them again. Its arithmetic is kept as documentation.
- **PAYER-MASS:** not an edge. It becomes a screen (section 3).

## 3. Amendments worth freezing before the tape is read

**H8_AMENDMENT items 1–2 (this affects D1, H1-CGO amendment 3 and Step A rows 1–3)**
- The floor must be the floor of the pool's universe:
  - U1: $50k up to $50, and $100k at $100;
  - U2: max($15k, 1,000× size), plus the chase check;
  - 4 to 24 h: "not tradable without a new tag". The tag is a supervisor change; any floor below $50k for pools 1 day or older needs the owner.
- H6 also applies.
- H1-CGO's decision points run from +60 min to +24 h (PREREG:21), so its stratum the bot can trade today is only the U2 window with the chase check.

**H8_AMENDMENT item 4 (count row)**
- Add sizes $100, $157, $200, $500, $1,000 and $10,000.
- Count canonical pools whose creator fee is 0.
- Compute each count on its universe floor.
- Record H8-SETTLE's s* and power arithmetic in edge.md §8.3 as settled. No test.

**PAYER-MASS as the materiality bar for every flow design** (APP-TOLL, FEE-RECYCLE, CREATOR-BUY, F1 and survivor 1)
- Before any return is read, the median payer-attributed net SOL in the frozen hold window must be at least X* = Q(√(1+c)−1).
- At least 11 events a day must reach 2X*.
- At U1's floor, X* is about 6.0 SOL at $5, 4.6 SOL at $20 and 4.55 SOL at $50. So U1 flow designs should be sized at $50, not $20.
- This is a necessary condition only. It assumes full capture, no other sellers and a single venue.
- Users' standing orders are never counted as payers.

**W1.** Optionally freeze an H8 companion arm before W1's extraction runs, using the universe floor. It is one extra family test, run only if W1's validation passes.

**G1 and Design A**
- G1: no change from this sweep.
- Design A: confirmed below H8 at every size. The 420 SOL step is about 86 SOL of effective quote (arithmetic).

## 4. Honest line
No. Nothing in this sweep beats the best so far: W1 about 5%, D1 about 2–4%, G1-HC about 2%. The only new mechanism, the merged slicer ride, is about 0.2%, and it needs the owner's ethics ruling first. The sweep's real value is two corrections: the U1 $50k floor and the payer-mass bar. Both lower the open designs' chances of being tradable as the bot stands. All chances are judgement.