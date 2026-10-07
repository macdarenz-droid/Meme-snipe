# Blueprint addendum from the research

Changes to the Solana Meme Bot Blueprint that the research supports. The Blueprint stays the design authority; each item is a proposal for the migration map and tickets.
- **Evidence:** all on branch `ccr-7fae2302-drz4co`; Zeroed code is cited as `origin/ccr-14987baf-i6lrsl:<path>`.
- **Priority:** P0 changes a Phase 0 build or decision. P1 lands before its Phase 1 ticket. P2 (PM-01, live-only or non-core) waits under the bot-first rule (CLAUDE.md).
- **Labels:** "derived" = arithmetic on cited numbers; "reviewer n" = the outside reviewer's answers to `research/ADVISOR_PROMPT.md` (not in the repo).
- **Provisional:** execution-audit figures (commit 305ae388, run in progress).
- **Adopting** an item adds register facts (ID, path, sha) and a C-xx per ruling.

## Summary

| ID | Kind | P | Anchor | Change |
|---|---|---|---|---|
| A01 | correct | P0 | D07; §18 | Choose the M07 host and start recording (owner) |
| A02 | add | P0 | D12; U-A11 | No pump.fun calls; backfill on; terms register |
| A03 | correct | P0 | D30; D04 | Credit budget from the real pool count; bot services only |
| A04 | correct | P0 | §3.2–3.3; A-23 | Cite the negative sub-hour proxy evidence |
| A05 | correct | P0 | A-M13-01; C-26 | Kill-only conditional bounce check (owner) |
| A06 | correct | P0 | Pre-funding gate; §16.4 | Map owner items to gates; list clashes |
| A07 | correct | P1 | §2.1–2.3 | Conservative cost row; q; minimum notional |
| A08 | tool | P1 | M01; M06 | Per-pool fees; quote goldens; reserve timing |
| A09 | confirm | P1 | §8.4; §8.6 | Drained-pool fixture; replace H8 |
| A10 | correct | P1 | A-M10-01 | One slot-to-time function |
| A11 | confirm | P1 | §8.1 | SOL-only limit property test |
| A12 | add | P1 | §3.4; M11 | Study hygiene; viewed-data ledger |
| A13 | correct | P1 | A-M11-04 | Realistic vendor-bar line beside CS-1 |
| A14 | add | P1 | B-2; R-2 | Clustered intervals; matched-random gate |
| A15 | tool | P1 | M10 | Swap replayer validates fills |
| A16 | tool | P1 | A-M13-06; L-4 | PREREG template; B1–B5 boundaries |
| A17 | add | P1 | D08 | End state with no edge; SOL baselines (owner) |
| A18 | add | P2 | CS-1 | Optional early coarse screen (owner) |
| A19 | correct | P2 | D08 | PM-01 screened only on swap or 1 Hz data |
| A20 | confirm | P2 | §3.2 | Families already tested |
| A21 | add | P2 | C-24; M08 | PM-01 gap prior; protocol-trade tags |
| A22 | add | P2 | MinTRL | Skewed-strategy reporting |
| A23 | add | P2 | D21 | Sizing additions |
| A24 | add | P2 | §3.3; §8.6 | Forward-test protocols |

## Items

### A01 Recording host (P0; owner decides)
**Change:**
- Gate windows count from the first recorded day; live-small comes at least about 65 days later (§3.4).
- Owner picks: (a) resize the host (new spend); (b) the operator's machine at $0 (allowed for Phases 0–2; D07, §18); (c) recorder only on the host, memory-capped, rotation sized to 25 GB.
- Recommendation: (c) if it fits with headroom, else (b). Start M07 the day the owner decides.

**Evidence:**
- The host has 1 GB of memory and 25 GB of disk, and the old worker ran out of V8 memory on it (`research/SUPERVISOR_MESSAGES.md:63`; `research/hype/RESEARCH.md:118`).
- Clean windows come only from recording started now (`docs/research/edge.md:165`).

**Acceptance:** owner ruling recorded as a C-xx; the disk-budget test uses the real disk.

**Caveat:** (c) needs the owner to lift "nothing runs except the stand-in" (`SUPERVISOR_MESSAGES.md:102`). Recorder volume (A-48) is unmeasured.

### A02 Data sources and terms (P0)
**Change:**
- No pump.fun frontend calls in bot or research code. Data collected before 2026-10-07 may serve research, never Blueprint universes or gates.
- Turn D12's chain backfill on by default.
- Keep a dated terms register:
  - GeckoTerminal/CoinGecko: keyless terms bar storage and scheduled polling (partly unverified); owner decides.
  - DexScreener: allowed on 2026-10-07; an earlier read got HTTP 403.
  - Helius §3.2(xi): open.
- U-A11 is answered only on keys; message shapes and the ban signal stay open.

**Evidence:**
- Copied browser headers stopped 2026-10-07; collected data kept (`research/hype/RESEARCH.md:141-147`).
- PumpPortal missed 13.6% of creates (`docs/research/data.md:16`), and the key is only for paid streams (`data.md:225`).
- Terms readings: `docs/research/historical-data.md:35-36`; `research/hype/RESEARCH.md:45`; `research/hype/test1/PREREG.md:17`.

**Acceptance:** a CI grep fails on pump.fun frontend hosts (pinned docs and SDK test oracles excepted).

**Caveat:** these are readings of the terms, not legal advice.

### A03 Credits and fixed costs (P0)
**Change:**
- Size D30's budget from the first enumeration count, not A-43's 50,000.
- Read all vaults daily (unmetered provider), and every 6 h only pools near the tier threshold.
- Add an M14 burn-rate test.
- VM-14 charges only services the bot uses; the bot stays on D04's free tiers. Helius Developer (US$49 a month) is a D29 research cost unless the owner moves the bot onto it.

**Evidence:**
- 85,111 graduates were created 06-01 to 09-21 (`research/daily-probe/RESULTS.md:25`); Zeroed burned about 80k credits an hour with zero trades (`SUPERVISOR_MESSAGES.md:93`).
- $49 + $12 needs equity of at least $2,033 (D04), above C-01's $1,000.

**Acceptance:** Phase 0 reports the count and the budget. The burn test fails on the zero-trade pattern.

**Caveat:** the all-time pool count is unmeasured (possibly several hundred thousand); whether dead pools stay enumerable is unverified.

### A04 MR-01 evidence (P0, text)
**Change:**
- Replace "No evidence in the register covers sub-hour horizons" (and A-23) with "negative sub-hour proxy evidence; MR-01's 15 s signal untested".
- MR-01 stays first, as the cheapest to kill. M09 waits only for A-24/A-24b.
- A D08 C-xx says the proxy is not CS-1.
- No low-volume config (6–7 trades a period, `RESULTS.md:17`). "Drops from one large sale" becomes an open point beside C-22 (needs D03; `docs/research/edge.md:172`).

**Evidence** (`research/deep-pool-probe/RESULTS.md:8-26`, `results.json`):
- Primary group, $200: MR-A validation −0.76% (CI −1.15 to −0.35, n=266). Dip rules beat random by +0.2 to +0.5 points.
- Group A (0.30% tier, a subgroup), $50: MR-A validation −0.11% (CI −0.65 to +0.38, n=99); best gross +0.63%, below lean V5 g* of 65–71 bps.
- At 66,666,667 lamports, swapping only the fixed cost: about −0.63% (conservative row), −0.07% (lean) (derived).

**Acceptance:** §3.2, §3.3 and A-23 cite register facts.

**Caveat:**
- The proxy used 5-minute bars, a 3-day SD and fixed targets, with no depth-fall or REGIME filter.
- The survivor list held 1 of 33 random coins that reached group-C size (`research/daily-probe/RESULTS.md:28`); the true result is likely worse.

### A05 Phase 0 conditional check (P0; owner decides)
**Change:**
- Amends C-26 and the owner's move rule; A-24b stays unconditional.
- On the Phase 0 week's 15 s M07 bars, run exactly the two registered MR-01 configs, with no selection.
- Measure forward return 5–60 min after each signal at 0/1/2-bar delays, and its excess over same-pool, same-hour random entries.
- Kill MR-01 unless (a) the raw return beats the conservative hurdle (A07) and (b) the excess is above zero.
- The check can never pass a config. The week stays outside W_B.

**Evidence:**
- The excess alone flatters: group A validation at $200, gross +0.63%, net −0.17%, random entries −0.94% (`results.json`).
- The bounce falls in the first 5 minutes (`RESULTS.md:25`).
- Fixed configs remove C-26's selection risk.

**Acceptance:** rule committed before data; output by horizon and delay, with A14 intervals.

**Caveat:** a week gives few signals, so the intervals are wide.

### A06 Owner pre-funding map (P0, doc)
**Change:** list each clash with a recommendation (`SUPERVISOR_MESSAGES.md:43`).
- **Item 1** asks for 10 identical replays; §16.4 states no count. Use 10.
- **Item 2** wants a historical transaction-level backtest; gate B uses forward M07 snapshots (D17). Owner decides; A15 could serve.
- **Item 4** wants ≥ 95% of transactions to simulate; P-6 checks fill error only. Add it.
- **Item 6** wants 300 out-of-sample trades at 80% power. Raise R-1/P-1 to that n.
- **Blindness:** add a planted-marker leak test; make parity exact (§16.4 allows tolerance).
- **Timeline:** plan W_B for up to about 65 days.

**Evidence:**
- The proxy made about 8.3 trades a day (discovery) and 4.7 (validation) (`results.json`). B-1 needs 10.
- Item 6 implies a Sharpe of about 0.162 at n=300 (derived). The 0.183 at `docs/research/edge.md:128` uses attempt 1's z.

**Acceptance:** clashes listed in `docs/MIGRATION.md`; the leak test fails on a leaking module.

**Caveat:** the timeline lengthens.

### A07 Conservative cost row (P1)
**Change:**
- Build it from pessimistic Blueprint parameters: C-27's all-unknown prior, D15 High, janitor-failure and dust rates.
- Show 414,009 lamports only as a sensitivity line.
- B-2 must pass under this row until each parameter is measured.
- Add q to §2.3: p* = (L + c + q(1 − L))/(W + L).
- Do not trade if the fixed cost exceeds k% of the stake, with k fixed in advance.

**Evidence:**
- 414,009 = 53% rent, 32% failed exits and closes, 14% landed fees, under Zeroed's design (`docs/research/edge.md:145-157`).
- At 66,666,667 lamports that is 0.62% of the trade (derived).
- A +2/−6 bracket needs 86% wins, or 98% if 1% of trades go to zero (`edge.md:274`).

**Acceptance:** M10 carries both rows, and reports show both.

**Caveat:** no row is measured; this only tightens.

### A08 Quote fixtures (P1)
**Change:**
- M01 reads each pool's creator fee from chain at decision time, for the quote and for the ≤ 30 bps filter.
- Import the CORE-2 goldens (313 curve swaps, 353 PumpSwap) under no-bugs-migrate.
- Encode the reserve timing: effective = vault + virtual (i128). PumpSwap events are pre-swap; pump `TradeEvent` is post-trade.
- Fix `docs/research/quant.md:54,352` (wrongly says post-trade).

**Evidence:**
- 8 of 19 audited pools logged 95 bps where the tier table gives 125; the creator split is inferred (`research/execution-audit/audit_results.json`).
- The goldens reproduce exactly (`docs/research/venues.md:94,146`). Reserves are pre-swap (`research/tail-proof/README.md:11`).

**Acceptance:** a fixture fails a quote that uses the tier table alone or the vault alone.

**Caveat:** the sample is selected, and it matters mostly for PM-01 pools.

### A09 Drained-pool fixture (P1)
**Change:**
- Keep the guards (ratio ≥ 0.5/0.6, DEPTHPCT, collapse below 0.4, sell clamp).
- Add a fixture (17.58 SOL virtual, 0.27 SOL real): entry rejected, collapse exit fires, proceeds clamped.
- H8 is replace (`SUPERVISOR_MESSAGES.md:89-98`).

**Evidence:**
- H8 adds virtual quote (`origin/ccr-14987baf-i6lrsl:packages/core/src/gates/hard.ts:311-313`); fixture values are one pool read (`docs/research/edge.md:225`).
- 3 of 19 audited pools were below 0.4 at hour 1; the jackpot pool (0.369) would have been rejected.

**Acceptance:** fixture green in M06 and M20.

**Caveat:** A-09 is unverified.

### A10 Slot-to-time (P1, before A-M10-01)
**Change:**
- Replace `slotMsAssumed` with one function: M15 samples live (`slot_ms_initial` stays), per-day block-time anchors in history.
- Recheck the 12-, 20- and 8-slot thresholds at 400, 267 and 200 ms.

**Evidence:**
- Slots fell from about 0.42 s (late July) to 0.316 s (early September) (`research/launch-probe/derived/slot_len.json`), about 4–7% above the LD-08 targets.
- `SLOT_MS = 400` sits in four Zeroed source files and two tests, e.g. `packages/worker/src/run/config.ts:84` and `packages/backtest/src/sim/world.ts:61`.

**Acceptance:**
- Slots convert within ±1 s of `getBlockTime` anchors on two dates with different slot lengths; no other slot constant exists.

**Caveat:** block time has 1 s resolution.

### A11 SOL-only limits (P1)
**Change:**
- Mark Zeroed's micro-USD risk core (#197) replace. Property test: doubling or halving SOL/USD leaves limits and SOL P&L unchanged. Live entries and stake are the owner's.

**Evidence:**
- Trial policy: usd('20'), 3 entries a day (`origin/ccr-14987baf-i6lrsl:packages/core/src/config/policy.ts:190-191`).
- That gives 84 trades in 28 days (`docs/research/edge.md:164`).

**Acceptance:** property test green.

**Caveat:** USD bills still convert at the live rate.

### A12 Historical studies (P1)
**Change:**
- Exclude only at entry time (entry plus maximum hold ends before the wall). Dead pools keep their last close; missing histories are reported, never called truncated.
- Never use `ath_market_cap` or any field observed after the decision; as-of LP reads are fine.
- Fresh-graduate studies count dust (first bar < 2.41e-8 SOL, or any pre-entry bar < 1.76e-8) and start-missing exclusions (first open outside 0.5–10× of 4.108e-7 SOL), with a −100% sensitivity line.
- Treat B2–B4 as regime breaks.
- M13 logs every window viewed. No affects_returns parameter may come from one without a re-test, and none of H8/H9/H11.

**Evidence:**
- Dust was 267 of 900 and start-missing 127 of 900 (`research/lottery-probe/RESULTS.md:3`).
- ATH equals the maximum hourly high on 492 of 492 coins (`research/brainstorm/RESULTS.md:32`).
- B2–B4 changed trade economics (`docs/research/venues.md:160-162`).
- Contamination: `docs/research/edge.md:162`; one window was viewed more than 200 times (`research/hype/RESEARCH.md:154`).
- Reviewer points 2 and 4.

**Acceptance:** exclusion table in every report; a lint flags viewed-window overlaps.

**Caveat:** forward M07 data avoids most of this.

### A13 Vendor bars (P1)
**Change:**
- CS-1 still decides on the optimistic line (C-30).
- A-M11-04 adds a realistic line (entry at the first traded close within 3 bars, stops at min(stop, close), fee from the signal bar); optimistic pass with realistic kill = "fragile".
- Never treat an unfinished bar's volume as known (reviewer point 1).

**Evidence:**
- Opens equal the prior close, and bars are missing when nothing traded (`research/deep-pool-probe/PREREG.md:41-47`).
- MR-A validation falls from −0.76% to −0.92% on the realistic line (`RESULTS.md:21`).

**Acceptance:** a synthetic vendor series test shows both lines.

**Caveat:** applies to vendor bars only.

### A14 Gate statistics (P1)
**Change:**
- Use the more conservative of the stationary bootstrap and a calendar-day cluster t-interval; report DEFF.
- Beside B-2/R-2, require the lower bound of (rule − matched random) to be above zero, with 10 random entries per trade matched on pool, hour and 6 h MAD decile.

**Evidence:**
- A block bootstrap covered a nominal 99% about 86% of the time (`research/daily-probe/PREREG.md:36`).
- Survivor bias lifts rule − random (`PREREG.md:37`); dip rules beat random and still lost (`research/deep-pool-probe/RESULTS.md:24`).

**Acceptance:** coverage is within ±2 points of 95% on day-correlated simulations.

**Caveat:** this only tightens.

### A15 Swap replayer (P1)
**Change:**
- Use `research/execution-audit` to validate M10's fill and stop-gap models and M07 snapshot fills. Latency comes from the bot's own measurements. Bulk use needs owner credit approval and §3.2(xi).

**Evidence:**
- 20 trades replayed with 0 reserve mismatches (`research/execution-audit/PREREG.md:18-66`; `audit_results.json`).
- 487,050 ledger credits at a conservative 10 per call (`heli.py:18`).
- A `getBlock` pull runs about 250k credits a day (`docs/research/historical-data.md:319`).

**Acceptance:** a golden replay reproduces `audit_results.json`. Cost per pool-day is measured first.

**Caveat:** the replay is counterfactual, and the code is Python.

### A16 Registration and regimes (P1)
**Change:**
- M13 records copy the research PREREG: pushed before data (ls-remote check), wall, stress costs, seeds, random benchmark, realistic line, amendments only before the first run, fresh reviewer.
- Multi-config research screens declare a primary (reviewer point 10); gate B is unchanged (B-3, B-6 are stricter). L-4 gets B1–B5.

**Evidence:**
- `research/deep-pool-probe/PREREG.md:1-48`; `docs/research/venues.md:155-165`.
- B5's tail changes no money: 1,188/1,188 exact in one 38-minute window (`research/tail-proof/README.md:5-26`).

**Acceptance:** an unknown event length demotes the venue.

**Caveat:** the tools must be ported.

### A17 End state with no edge (P1; owner decides)
**Change:**
- If MR-01 and PM-01 both fail, D08 applies a stop date and spend cap; then the bot only records and paper-trades, asking no deposit.
- PerfStats shows hold-SOL and JitoSOL baselines; actual staking is the owner's call.

**Evidence:**
- Judged 75–85% chance of no edge, 3–8% of passing (`docs/research/edge.md:116-117`).
- JitoSOL about 4.8% a year (`edge.md:224`); holding SOL beat every timing rule (`research/trend-probe/RESULTS.md:12-22`).

**Acceptance:** D08 holds the owner's values.

**Caveat:** the percentages are judgement.

### A18 Optional early CS-1 (P2; owner decides)
**Change:**
- Run A-M11-04 from `research/mr01-screen/MR01_SPEC.md` (2cf0c0f7): both configs, REGIME (C-21: null blocks); state gaps (no depth-fall check, 1-minute bars).
- D30 pools, an unviewed window, ≤ 2,000 calls a month. Blocked on the owner's terms ruling and a Demo key; off M09's critical path.

**Evidence:** 60 days of minute bars is about 87 calls a pool (derived).

**Acceptance:** the PREREG is pushed first.

**Caveat:** a pass proves nothing.

### A19 PM-01 screen (P2)
**Change:** screen PM-01 only on swap-level data (A15) or 1 Hz M07 data. Otherwise D08 stands.

**Evidence:**
- Hourly bars err both ways: a stop at 0.72× on hourly bars was 1.48× in real time, and the jackpot was about 130× on hourly bars against 26.65× real-time (`audit_results.json`).
- The hour-1 runner lost 22.4% (`research/runner-probe/RESULTS.md:20`).

**Acceptance:** the PREREG names the data.

**Caveat:** no tested rule matches PM-01.

### A20 Families already tested (P2)
**Change:** document them in §3.2.
- **Not supported:** graduation window (0/72), copy-trading (−11.0%), lottery, runner, weekly trend, short side, LP, carry.
- **Ruled out by analysis:** curve intensity, BOOST window, atomic arbitrage.
- **Open:** daily holds (re-test running).
- **Parked:** DLMM maker.

**Evidence:** `docs/research/empirical.md:8`; `research/*-probe/RESULTS.md`; `docs/research/copytrading.md:14-50`; `docs/research/edge.md:175-176,236-238`.

**Acceptance:** each family is listed with its universe and window.

**Caveat:** the market regime may change.

### A21 PM-01 exits and event data (P2)
**Change:**
- Raise PM-01's stressedGapBps prior to about 8,270 bps; MR keeps 2,000 until C-24's 50 stop exits replace it.
- Add a directional R-4 stress (f_fail = base × g(next-N-second return), g fixed) and a jackpot fixture on post-crash reserves.
- In event data, drop BOOST and mayhem-agent trades from demand features; price each mayhem trade from its own logged state.

**Evidence:**
- Stops filled at 0.655–0.808×, one at 0.173×; a trail at 0.022× (`audit_results.json`).
- The jackpot sold at about 36.2% of peak by the minute-bar bound (`research/runner-probe/PREREG.md:39`), against 26.9% in the swap replay.
- A 0.023 SOL agent sell moved virtual SOL by 11.79 SOL (`docs/research/edge.md:239`).

**Acceptance:** M10 holds a prior per strategy.

**Caveat:** 20 selected trades.

### A22 Skewed-strategy reporting (P2)
**Change:**
- Gate on a mean capped at +19. Report bins (≤ stop, small loss, 0–2×, 2–10×, 10–50×, ≥ 50×), the loss bill, sensitivities and week-clustered intervals.
- No tail-index fits, no bootstrapping a lone extreme, skew floored at 0; the top 1% of trades supplies at most 50% of P&L.

**Evidence:**
- Runner bins (`research/runner-probe/RESULTS.md:20-47`); t-interval coverage 0.802 at n=300 (`docs/research/quant.md:282`); cap (`quant.md:390`; `docs/research/edge.md:292`).

**Acceptance:** VM-09 has these fields.

**Caveat:** a cap can hide a real tail edge.

### A23 Sizing (P2)
**Change:**
- Exposure counts exit costs; pause when the fixed cost exceeds k% of the stake; grow only from realised SOL; the owner sets live values.

**Evidence:** no sizing rule improved return per unit staked (`research/sizing/RESULTS.md:8-51`).

**Acceptance:** an M21 property test.

**Caveat:** sizing cannot create an edge.

### A24 Forward-test protocols (P2)
**Change:**
- Attention stays out of entry rules until a forward test passes (frozen roster, receipt times, deletions kept, outages logged, matched controls, positive net SOL).
- Test order: funded buyers, then caller wallets, then the first boost, then comments.
- A holder-sale exit needs frozen holder sets, verified sales, and paired tests against the trail and a size-only control.

**Evidence:**
- Paid profiles netted −31.7% against +27.9% (`research/hype/RESEARCH.md:24-39`); Test 3's placebo is undefined (`RESEARCH.md:94-127`); reviewer points 7–9.

**Acceptance:** a PREREG and its result come before any adoption.

**Caveat:** trade capture writes 2.2 GB a day.

**Not adopted:** Holm at gate B (redundant); owner pick journal (reviewer point 11), parked until asked.

## Still running

| Run | State | Updates |
|---|---|---|
| Execution audit (305ae388) | 20 trades; plan 1 + 9 + 30 (`PREREG.md:55`) | A08, A09, A15, A19, A21 |
| D-REV3 re-test, survivorship-free | 16,367 coins downloading | A20 |
| Hype Test 1 | registered (2349dfe2) | A24 |
| Cheap-venue probe | PREREG only | A18, D18 |
| Launch probe | PREREG only | A10, A21 |

None of these enters the register before its RESULTS.md and a fresh review.

## Kid summary

- We tested many ideas on past data. None has passed after costs yet.
- The idea closest to the main plan lost a little.
- The bot must record fresh data first. You pick where it runs.
- Fix bugs first: clock speed, fake depth, dollars in place of SOL.
- Tests are stricter: safe costs, random-buy checks, honest error bars.
- The bot never calls pump.fun's website.
- If nothing passes, it asks for no money.
- Some tests are still running.

## Note to the Blueprint supervisor

Please adopt `research/BLUEPRINT_ADDENDUM.md` item by item.
- Give each item a row in `docs/MIGRATION.md`: keep, adapt, replace or reject, with your reason.
- Open tickets in priority order: P0 now, P1 before the matching Phase 1 ticket, P2 after the bot-first gate.
- Turn evidence into register facts with paths and shas, and record each ruling as a C-xx.
- Send A01, A05, A06, A17 and A18 to the owner as decisions, each with your recommendation.
- Results from unfinished runs enter only after their RESULTS.md and a fresh review.
- Never loosen a gate. Keep lamport units.
- Record any item you reject in HANDOVER, with the reason.