# Phase 0 PREREG: review record

## Round 1 (head `cdd62617`, 7–8 Oct 2026)

### Fresh review (FAIL)

**Review of `research/phase0/PREREG.md` on `claude/research-phase0-prereg` at `cdd62617`**

**FAIL.** There are two MAJOR findings and eight MINOR ones. All can be fixed in one amendment before R0. I did not edit or push anything.

### Numbers recomputed (all correct)
- **Sizes:** USD ÷ 150 × 1e9 gives 33,333,333 / 133,333,333 / 666,666,667 / 6,666,666,667 / 66,666,666,667.
- **Priority cap:** 20 bps of $5 is 66,667 lamports, so the cap is min(50,000, that) = 50,000 at every size. This matches ARCH §1.4 and A-M10-03 step 2.
- **Conservative row:**
  - Per leg: 5,000 + 50,000 + 5,000 = 60,000.
  - Failed overhead: 0.25 × 55,000 = 13,750 per leg.
  - Janitor: 15,000.
  - Rung-2: P = 1 − 0.8 × 0.95 = 0.24, and 0.24 × 51,000 = 12,240.
  - Lost rent: 0.145 × 1,513,840 = 219,506.8, rounded up to 219,507. The 14.5% traces to `docs/research/edge.md:17`.
  - Total: 394,247.
- **k cap:** 1.18% at $5 (too small), 0.30% at $20 (passes).
- **Lean line:** 35,000. **Stress line:** 200,000 priority plus a 1,000,000 tip per leg.
- **Monthly term** at $59, 10 trades a day, $10 size: ceil(196.67) = 197 bps. The $49 figure matches LD-27.
- **Other constants:** bars (1,500 / 2,000), features (5,000, 6 h, 30 min, 3), `lowCoverage` above 5%, C-15 age rule, bootstrap rule (C-34), A-48 at 3–5× and 0.31–0.52 GB a day, and the M1 bar of 95% for 48 h all match their sources.
- The `RESULTS.md:25` quote is correct.

### The three flagged readings
1. **Depth cap checked per signal at entry:** correct, because ARCH §8.1 `DEPTHPCT` is a per-entry check. The depth it uses is wrong; see F1.
2. **OPEN-11 applied per size:** correct, because the depth cap makes n differ by size.
3. **Killed only when no size passes and at least one fails; "insufficient" otherwise:** correct. It cannot pass anything. It matches A-M13-01's "no decision" pattern and OPEN-11. OPEN-9's wording ("killed unless the cell clears…") read alone would kill when every size is insufficient; the file's reading is the one consistent with OPEN-11. The kill-only property holds.

### Findings

**F1 · MAJOR · lines 156, 232**
- **Evidence:** The depth cap is set at "0.5% of its pool's effective quote". ARCH §8.1 `DEPTHPCT` (ARCH:2047) says "≤ 0.5% of min(effective quote, real quote)", and MIGRATION Z09 also uses min(real, effective). With real/effective ≥ 0.5, the file's cap can be up to 2× too loose, so it keeps signals the live bot would refuse. That is lenient towards survival.
- **Fix:** Use 0.5% of min(real, effective) at entry, and cite ARCH §8.1 `DEPTHPCT`.

**F2 · MAJOR · lines 156, 215**
- **Evidence:** Random entries are not depth-capped, but each is charged costs on its own entry state. Shallow-pool random entries carry large impact, which pushes their mean `net(x)` down and pushes `e(x)` up. That biases test (b) towards "pass", against MR-01 being killed.
- **Fix:** Draw random candidates only where `x` is within the same `DEPTHPCT` cap at that size. If a signal ends up with no capped candidates, apply the existing shortfall rule. An alternative is to charge the random entries the signal's own costs; either way, pick one now.

**F3 · MINOR · lines 255, 258**
- **Evidence:** The cluster t-interval and DEFF have no fixed variance estimator, so the intervals are a free choice. The intervals do not decide the verdict, which is why this is MINOR.
- **Fix:** Fix the formula now, for example `Var_cl = D/(D−1) · Σ_d n_d²(m_d − m)² / n²`, with the t-quantile at `D − 1` degrees of freedom and `DEFF = Var_cl / (s²/n)`.

**F4 · MINOR · line 187**
- **Evidence:** The repeat block is not fully defined. It does not say whether a signal dropped later (by `no_entry_price`, the depth cap or REGIME) still blocks the pool for `T`. It also does not say whether the block runs from the signal bar or from `t_e`, or whether it is per delay or per size. Each choice changes n.
- **Fix:** Apply the block on the signal set after conditions 1–5, the same set for every delay and size, and start it at the signal bar close.

**F5 · MINOR · lines 210, 268**
- **Evidence:** "Horizon past the wall" does not say whether a signal is dropped for that horizon only, or whenever `t_e + 60 min` passes the wall. This changes n at the primary 30-min cell.
- **Fix:** Drop per horizon, or drop if `t_e + 60 min` is past the wall. Choose one and state it.

**F6 · MINOR · lines 180–183**
- **Evidence:** The file calls once-a-minute SOL/USD recording "a Z08 item", but MIGRATION Z08 (line 769) and the A-M07 tickets do not list it. Also, "a UTC day without it" does not cover a partial gap within a day.
- **Fix:** Have the supervisor add a SOL/USD stream to a recorder card. Apply the basket-only flag per signal: whenever either end of the 30-min SOL/USD return is missing, that signal is flagged.

**F7 · MINOR · line 212**
- **Evidence:** When the random-entry window is widened to ±1 h and then ±3 h, the file does not say whether the pool and MAD-decile match is kept.
- **Fix:** State that pool and decile stay matched and only the hour widens.

**F8 · MINOR · line 81**
- **Evidence:** A-24b requires windows "inside one pool's eligible time". That condition depends on what happens after the window starts. It drops windows where depth collapses, which are the big moves. A12 allows exclusions at the start only.
- **Fix:** Check eligibility at the window start only. The pool's last price carries on if it dies (A12).

**F9 · MINOR · lines 124–128**
- **Evidence:** Two cost points are undefined:
  - how to build the pool state when depth is min(real, effective);
  - how fees and impact are split out of A-M10-03's exact round trip.
- **Fix:** Fees plus impact = `x − out` from the step 1 round trip, quoted on min(real, effective). Keep the spot price fixed: scale B with Q. Fix the display split rule.

**F10 · MINOR · lines 76, 88–94**
- **Evidence:** A-M13-01 step 5 and MA-0c say the move rule is "POLICY, decided by the product owner… does not decide automatically". The file states its verdicts as final.
- **Fix:** Say that the A-24 and A-24b verdicts go to the owner for sign-off. A05's kill already has the owner's agreement (MIGRATION:785).

### Other checks
- Every parameter, window and statistic is fixed, apart from F3–F5, F7 and F9.
- The primary cell is MR-01-A × 30 min × 1-bar delay, judged per size.
- I found no future-data leak into a decision. The day-wide MAD decile cut and same-hour random entries are used only for the benchmark, not for decisions.
- The A12 exclusion table, viewed-window ledger and −100% line are all present.
- The A14 matching (10 entries on pool, hour and 6 h MAD decile) and the conservative-of-two interval rule are correctly stated.

**Verdict: FAIL** at head `cdd62617e13f83635918aee61a51bad74f8ffd23`.

### Red team

**Red team report: `research/phase0/PREREG.md` at `cdd62617e13f83635918aee61a51bad74f8ffd23`** (re-checked with `ls-remote`; I edited and pushed nothing).

I recomputed the cost arithmetic and it is right. The five size conversions are correct. The fixed total of 394,247 is correct (120,000 + 27,500 + 15,000 + 12,240 + 219,507). Failed overhead is 13,750, rung 2 is 12,240, the janitor is 15,000, lost rent is 219,507, and the k-cap shares are 1.18% at $5 and 0.30% at $20. The problems are in the rules, not the sums.

My pool examples assume one pool: 30 bps fee per side, about 1,400 SOL real depth and 1,500 SOL effective. They are approximate.

### BLOCKER

**RT-01 · L86–100, L94 · The move rule can wrongly kill MR-01: one $10 size, the strict cost row, and $59 a month.**
- **Evidence:**
  - A-M13-01 step 4 says "lean landing". The PREREG judges on the strict row instead and cites A07, but A07 binds B-2, not A-24b.
  - At $10 and 10 trades a day, the $59 term is ceil(393,333,333 × 10⁴ / (30 × 10 × 66,666,667)) = 197 bps. ARCH's $12 gives 40 bps.
  - Example pool: strict cost ≈ 121 bps, so the hurdle ≈ 318 bps. The spec's lean hurdle ≈ 67 + 40 = 107 bps.
  - The same pool at $100: about 96 bps.
  - So the kill depends on the one size where fixed costs dominate, which breaks "Size is not the trial". $10 is not even in the §4 sweep.
  - A-M13-01 step 5 also says the report "does not decide automatically".
- **Fix:**
  - Judge the move rule at every non-excluded size in the sweep, and show the lean, strict, $10 and $59 lines.
  - Pass at any size that clears it; kill only when every size fails.
  - Fix the "median-depth state" window now.

**RT-02 · L344–348, L280 · Rules can still change after data exists.**
- **Evidence:**
  - Amendments are allowed until the first run, which is after the wall. Only the OPEN rulings must land before R0.
  - The VIEWED ledger guards D1 onward only. Day 0 (R0 to D1) is unguarded.
  - "Ops checks" allow coverage counts, which show the eligible pool counts. Someone could amend the universe or cost rules after seeing A-24's answer.
- **Fix:**
  - Freeze the file at R0. Any later change is a new trial.
  - Bring day 0 under the ledger.
  - Ban manifest `a24` fields from ops checks.

### MAJOR

**RT-03 · L207–215 · The matched random entries flatter MR-01.**
- **Evidence:**
  - Candidates come from the same clock hour, including bars before the signal. Those entries ride the very drop that made the signal, so their mean return falls and the excess `e` rises.
  - Random entries also skip the filters the signals face: REGIME, depth fall, real/effective, fee-config change and the depth cap at size x.
  - So random entries can sit in basket crashes or shallow states (higher impact), while signals cannot.
- **Fix:**
  - Drop any candidate whose holding window overlaps [signal − L, signal].
  - Make candidates pass the same entry-time filters, the depth cap included.

**RT-04 · L273 · Dead and evicted pools keep their last price.**
- **Evidence:**
  - ARCH §9.3(7) and (10) say: worst depth-implied exit, or −100% with no data.
  - The PREREG makes −100% a sensitivity line only.
  - Eviction tails are capped at 30 pools (`tail_capacity`) and stop in degraded reads (A-M05-02 steps 5–6). A rug that empties a pool can therefore count at its pre-rug price.
- **Fix:** In the deciding line, use the §9.3(7) pessimistic close for a pool with no data. Count the cases.

**RT-05 · L173, L81 · "Eligible at that moment" has no defined source.**
- **Evidence:**
  - The manifest is written at the end of the day and stores only `firstEligibleAtMs` and `lastEligibleAtMs` (A-M05-03).
  - A pool eligible from 01:00 to 03:00 and again from 20:00 to 22:00 would look eligible all day, including stretches with depth under 300 SOL or a low real/effective ratio.
- **Fix:** Recompute eligibility at each bar from recorded state as of that bar (fee, depth, age, ratio, watched). Never use the manifest's first and last times.

**RT-06 · L33 · Backup-provider days are not excluded.**
- **Evidence:**
  - A-M07-03 takes `expected` from M04's schedule, and A-M08-01 sets `expected = 15 s / interval`.
  - A 0.5 Hz Chainstack day can therefore show full coverage, with complete bars and no `lowCoverage` flag.
  - The brief says backup days do not count, but the PREREG never says so. Days that mix the two sources are not handled.
- **Fix:**
  - Any pool-time not read through Shyft at 1 Hz is excluded.
  - A day with more than 5% such time counts as a low-coverage day.

**RT-07 · L132–145, L194 · The "conservative" row leaves out Blueprint priors, which can let MR-01 survive wrongly.**
- **Evidence:**
  - Sandwich odds: `pSw` is 0.10 on entry and exit, filling at `minOut` (§9.3(5); A-M10-01). That is about 15 bps per round trip (0.1 × 50 + 0.1 × 100).
  - Cannot-sell: C-27's all-`unknown` failure mix with `fFail` 0.2 gives 3 unknown failures in a row about 0.8% of the time if attempts are independent. Treated as a total loss, that is about 80 bps. I am not certain how M10 values a `stuck` position, so this is worth verifying.
  - Entry price: the PREREG takes the last snapshot, not the worse of the two bracketing snapshots (§9.3(2)).
  - The sandwich and cannot-sell priors are what A07 calls "pessimistic Blueprint parameters".
- **Fix:** Add the `pSw` term and a cannot-sell term to the row (state the M10 valuation), and use worse-of-bracketing entry prices.

**RT-08 · L142, L147 · The lost-rent rate is a Zeroed modelled number, not a Blueprint parameter.**
- **Evidence:**
  - A-M10-03 step 8 says rent is capital, not cost.
  - The 0.145 rate comes from Zeroed's model for fresh pump tokens, with the ATA closed inside the sell. MR-01 trades deep pools that are at least 24 h old, and sells the full balance.
  - It adds 33 bps at $10 and 16 bps at $20, and feeds the RT-01 kill.
- **Fix:** Keep 0.145 only in the 414,009 sensitivity line. Alternatively, derive a dust rate from the Blueprint design and mark it unmeasured. Either way, keep it out of the move rule.

**RT-09 · L222–228 · One fixed 30-min cell can kill MR-01 without testing its real exit.**
- **Evidence:**
  - MR-01 exits on reversion to the 6 h median or +6%, a stop, or time T (ARCH §3.3).
  - A fixed 30-min forward return holds through any later fade.
  - The cell is the one where the cited research says the bounce is already gone (delay 1). For a kill-only check, that biases the result toward a kill.
- **Fix:** Kill only if delay 1 fails at every horizon from 5 to 60 min. Alternatively, add the config's own exit path (target, stop, T) as the primary.

### MINOR

- **RT-10 · L156 · Depth cap uses the wrong depth.** It uses effective quote only; ARCH §8.1 `DEPTHPCT` uses min(effective, real). Fix: use the min.
- **RT-11 · L125 · Wording is backwards.** "never shallower than the truth" should read "never deeper".
- **RT-12 · L178–183 · The SOL/USD source is not backed.** The claim that it is "a Z08 item" has no backing: Z07, Z08 and Z10 do not list SOL/USD, and MIGRATION L476 puts the reference in group B. Partial-day gaps and which sample counts as "30 min ago" are also undefined. Fix: name the card, and define partial-day handling and the sample rule.
- **RT-13 · L187 · Repeat block is unclear.** It does not say whether the T-block starts from a raw signal or a kept one, or whether it is per delay. Fix: fix both now.
- **RT-14 · L194, L201 · Entry and net rules are loose.**
  - With delay 0, entry is at the signal bar's own close (the low).
  - The "next bar" fallback enters late but keeps `t_e`.
  - `net` is additive, not the exact `quoteExactIn` round trip.
  - Fix: define the exact formula and make the fallback move `t_e`.
- **RT-15 · L152 · Stress line is underpriced.** Failed overhead and the rung-2 term must be recomputed at 200,000 priority (overhead becomes 51,250 per leg). The text says "unchanged".
- **RT-16 · L212, L240 · The two tests use different samples.** Signals with no random candidate leave test (b) only. Fix: state the n for (b) and its floor of 30.
- **RT-17 · L242 · A pass can rest on a few pools.** At $1,000 and $10,000, a pass may come from a small set of the deepest pools. Fix: report it as "pass (subset)" and carry that subset into `W_B`.
- **RT-18 · L30, L35 · D1 can start too early.** D1 can begin less than 24 h after R0, which lowers A-24 counts on a decision day. Fix: D1 starts at or after R0 + 30 h, or warm-up days are left out of the decision.
- **RT-19 · L174 · Quiet pools cannot fire.** Deep pools that rarely trade can have MAD = 0, so `robustZ` is null and they never signal. Fix: count these apart from other null features.
- **RT-20 · L176 · Fee-config check may be impossible.** `fee_config_known` needs a recorded FeeConfig history, and none is named. Fix: state the fallback.
- **RT-21 · L33, L196 · Gap into an excluded day.** No rule covers a horizon that runs into a low-coverage day.

The plan does not touch pump.fun hosts, keeps profit in lamports, stays within the ≤ 50% read rule, keeps the "insufficient" result as no-kill, and fixes seeds and RNG. All of these comply.

**Count:** 2 BLOCKER, 7 MAJOR, 12 MINOR. **Head attacked:** `cdd62617e13f83635918aee61a51bad74f8ffd23`.

### Outcome
The fix round was pushed at `ad0511b2`, with the C-65 cite at `df7d75da`, on `claude/research-phase0-prereg`. The supervisor accepted the researcher's seven readings. The work is on hold: the owner decides whether the MR-01 1-minute screen (`research/mr01-screen` @ `c67f37f9`) stops MR-01.
