# Z0D Blueprint docs: review record

One record per card, appended each round. Owner rule: every finished task gets a fresh review and a red team.

## Round 1 (head `ed46b898`, 7–8 Oct 2026)

### Fresh review (FAIL)

**Verdict: FAIL** at head `ed46b89859a17c504d4f7a3f935494216950129a` (base `claude/blueprint-migration` @ `4d124876`, research @ `72f1793f`).

The ARCH text, the C-46..C-74 rulings, FACTS.json and the two ticket splits are mostly right. Two findings block a pass. The gate ticket that builders will follow (A-M13-06) still holds the old, looser gates. And one owner question that is still open (does the Helius Developer plan count as the bot's fixed cost?) is not carried into the docs.

## Findings

**F1 · BLOCKER · `SPEC-A.md:2179` (A-M13-06), `:2163`, `:2139` (A-M13-05)**
- **Evidence:**
  - Step 4 of the gate ticket still says "R-1 … ≥ 200 trades". ARCH 3.4 now says ≥ max(300, `n_80`).
  - Step 3 has no B-9 or B-10.
  - Step 5 has no P-10. It also lacks P-5's 48 h dry run with ≥ 99% uptime and drills, and P-6's ≥ 95% simulating.
  - `ExternalGateInputs` (`:2163`) lacks the fields B-M26-04 now says A-M13-06 adds.
  - A-M13-05 (`:2139`) still moves a strategy to `paper_passed` on "P-1..P-6 and P-9", without P-10.
  - INTEGRATION's traceability points B-9, B-10 and P-10 at A-M13-06. The ARCH revision log does not list A-M13-06 as edited.
  - A gate evaluator built from this ticket would pass R-1 at 200 trades, which is looser than ARCH.
- **Fix:** carry the new gates into A-M13-06 steps 3–5 and the `ExternalGateInputs` interface, and A-M13-05 step 2. Add acceptance cases that fail:
  - R-1 below max(300, `n_80`);
  - B-9 or B-10 input missing;
  - P-10 input missing;
  - okShare below 9,500 bps.

**F2 · MAJOR · `ARCH.md:1678` (D04, C-54); `SPEC-A.md` C-58**
- **Evidence:**
  - D04 says "the section 1.4 and P-9 tests are unchanged".
  - The owner question is still open in two places: `docs/DECISIONS.md:115` on the base branch, and MIGRATION A03 and O7 (`MIGRATION.md:413,725`). Both say: until the owner rules, Helius Developer ($49 a month) counts as the bot's fixed cost for P-9. That is the stricter reading, a floor of about $1,967 instead of about $334.
  - Neither D04 nor C-58 says this, and "unchanged" can be read as leaving Helius out of P-9.
- **Fix:** state the open ruling and the stricter default in D04/C-54 and C-58, citing DECISIONS 2026-10-07 and O7.

**F3 · MINOR · `SPEC-A.md:44` (MA-0c), `:46` (MA-2); `SPEC-B.md:27` (M3)**
- **Evidence:** MA-0c has no kill-check stop. MA-2 and SPEC-B's M3 row still say "P-1..P-6, P-9", without P-10. INTEGRATION's M1 and M3 rows were updated.
- **Fix:** match these rows to INTEGRATION.

**F4 · MINOR · `SPEC-B.md:1022`, `SPEC-B.md:2662` (CL-14)**
- **Evidence:** both still name B-M19-03 for work that is now in B-M19-06: signed bytes persisted before send, and `build_sign_segment_ms`. INTEGRATION's D05 and CB-04 rows were changed, so the docs now disagree.
- **Fix:** change both to B-M19-06.

**F5 · MINOR · `INTEGRATION.md:13`**
- **Evidence:** the line says the graph "was not re-checked by script after the split" and then, in the next sentence, that it "was checked by script: no cycles".
- **Fix:** say it was re-checked by script on 2026-10-07 (output below).

**F6 · MINOR · `SPEC-A.md:2465` (C-46)**
- **Evidence:** C-46 says "M09 waits only for A-24 and A-24b". ARCH `:390` adds the kill-only check (C-48).
- **Fix:** add the kill check to C-46.

**F7 · MINOR · `FACTS.json` (RS-24, RS-26, RS-29, RS-31)**
- **Evidence:** every value is correct, but some details are not on the cited lines:
  - RS-24: "$10", "hourly line" and the 2.9% win rate are at `research/runner-probe/RESULTS.md:16,22`.
  - RS-26: "2,000 reps, true μ +5%" is at `docs/research/quant.md:274`.
  - RS-31: "$20 bets" is at `research/lottery-probe/RESULTS.md:8`.
  - RS-29: "inside a sealed holdout" is on no cited line.
- **Fix:** add those lines. For RS-29, cite `edge.md` §6.5.1 or mark it DERIVED.

**F8 · MINOR · `docs/MIGRATION.md:807,831`** (outside this card's files; for the supervisor)
- **Evidence:** MIGRATION still says "B-M29-04's `import-run` part" and "the live part of B-M19-03".
- **Fix:** rename them to B-M29-05 and B-M19-06 in a MIGRATION edit.

## Checks that passed

1. **Adopted items.** A01–A24 (with A17 changed, A18 not now), the four owner decisions (host, Shyft/Chainstack, Telegram codes only, PumpPortal not used) and all seven supervisor rulings are carried, except F1 and F2.
2. **No loosening, apart from F1:**
   - sim_error limit 10% → 5%;
   - P-6 adds ≥ 95% simulating;
   - parity 1 bp → exact;
   - R-1 200 → max(300, `n_80`);
   - `paper_passed` adds P-10;
   - the conservative cost row binds B-2 and R-2;
   - A-M13-01 dependencies grow;
   - P-1 is unchanged.

   The q break-even formula is algebraically correct. Chainstack's 0.58 reads a second, the V5 `g*` of 65–71 bps and the 13.9 and 12.7 trades a day all check out.
3. **FACTS.json:**
   - It parses: 275 facts, no duplicate IDs.
   - RS-01..RS-39 are all cited in the docs, and every cited RS is defined.
   - C-01..C-74 are defined once each, and every cited C-xx exists.
   - Each RS claim was compared with its `path:line @ 72f1793f`. The `results.json` and `slot_len.json` values were checked too: −0.761%, −0.111% with CI −0.648 to +0.383, n 266 and 99, S0 −0.943, and slot times of 0.420 s and 0.317 s.
4. **Ticket splits.** The dependency check script, on the head:
   ```
   tickets A/B/UI/total: 63 81 32 176
   undefined deps: []
   deps on a later milestone: []
   cycles: []
   M0 listed 24 table 24 | M1 25/25 | M2 46/46 | M3 49/49 | M4 27/27 | Deferred 2/2
   M4b listed 5 table 3 (B-M17-04, B-M29-02 are "Raydium additions", as before)
   live-acceptance-only deps not counted (as before): UI-T14 → B-M17-08, B-M29-04; UI-T17 → B-M22-04
   ```
   On the base, the same script finds 174 tickets and three later-milestone dependencies: B-M19-03 (M2) → B-M16-04, B-M17-01 and B-M18-01 (all M4). The split removes all three.

   B-M19-06 keeps all of the old B-M19-03's live logic and acceptance. B-M29-05 keeps the `import-run` logic. The traceability rows I-01, I-28, D05, D29, CA-26, CB-04 and CB-10 are updated.
5. **Consistency.** Apart from F2–F6 and F8, I found no contradiction with MIGRATION, CLAUDE.md or DECISIONS.

Nothing was pushed or edited. The only thing I wrote was temporary check scripts in my scratchpad.

**FAIL · `ed46b89859a17c504d4f7a3f935494216950129a`**

### Red team

# Red-team report: card Z0D Blueprint docs at `ed46b898`

The doc edits need fixing before approval: I found 1 blocker, 6 major and 6 minor findings.

**The §2.3 formula is right.** Setting `expectancy = 0` gives `p* = (L + c + q(1 − L))/(W + L)`, which I re-derived. With W = 2%, L = 6% and q = 0, 86% wins needs a cost c of about 0.88%. With q = 1% that gives (0.06 + 0.0088 + 0.0094)/0.08 ≈ 97.8%, so the 86% and 98% examples are consistent. Spot checks of RS-01, RS-02 (against `results.json`), RS-03, RS-06, RS-07 and RS-21 match their sources at `72f1793f`.

## BLOCKER

**F1. The gate-evaluator ticket was not updated.** `SPEC-A.md:2178-2180` and `:2139`. Also `SPEC-A.md:46`, `:2098`, `ARCH.md:2896` and `SPEC-B.md:27`.
- **Evidence:**
  - A-M13-06 still says "R-1 … ≥ 200 trades", while `ARCH.md:457` now says ≥ max(300, `n_80`).
  - A-M13-06 has no B-9, B-10 or P-10, and its P-6 has no 95% floor.
  - It still says "`paper_passed` requires P-1..P-6 and P-9", and PerfStats still says "R-1 200".
- **Effect:** whoever builds A-M13-06 builds a looser gate than ARCH. That weakens owner items 1, 2, 4, 5 and 6.
- **Fix:**
  - Update A-M13-06 steps 2–5.
  - Add the `ExternalGateInputs` fields: dry-run uptime and drills, fault-injection results, and the B-10 report.
  - Fix the minimum in `SPEC-A.md:2098`.
  - Add P-10 to the MA-2 row, the ARCH 18 Phase 2 row and the SPEC-B M3 row.

## MAJOR

**F2. B-10 clashes with C-52, probably cannot be met, and the owner path is incomplete.** `ARCH.md:456`, plus the D12 bullet and `ARCH.md:356`.
- **Evidence:**
  - C-52 says pump.fun data from before 7 Oct is "never a Blueprint universe or gate". But the survivorship-free coin lists held were built from pump.fun's API (`research/daily-probe/RESULTS.md:25, :30` @ 72f1793f).
  - `docs/research/edge.md:172` says "The repo holds no real pre-wall market day", with only about 9.5 practice days.
  - MIGRATION:810 says the count of clean days has not been checked.
  - With no new downloads and no new credits allowed, M2 cannot exit.
- **Fix:**
  - Ask the owner whether data from before 7 Oct may feed B-10. This pits the owner's data rule against owner item 2.
  - Write down the owner's options if fewer than 30 clean days exist: approve credits for history, or let transaction-level M07 recording count.
  - Move Z-H's day count to M0/M1, so the owner hears early rather than "before M2".

**F3. Owner item 4 is only partly carried.** `ARCH.md:469`; `SPEC-A.md:1929-1939`.
- **Evidence:**
  - The owner asks for "within tolerance" on 95% of legs, but no tolerance per shadow is defined. P-6's p90 ≤ 100 bps lets 10% miss, and `okShareBps` counts status only.
  - The owner says "every" entry and exit. P-6 needs only a sample of 50, `max_per_hour` caps shadows at 60, and a `skipped` status exists.
  - Simulating exits as buy-then-sell round trips is a supervisor ruling against the owner's wording. It is not listed as a clash for the owner.
- **Fix:**
  - Set a per-shadow bound, for example |error| ≤ 100 bps.
  - Make the 95% = (`ok` and within bound) ÷ all paper legs.
  - Count any leg without a shadow as a failure.
  - List the round-trip substitution in MIGRATION's clashes.

**F4. The kill check is judged at one size only ($10).** `ARCH.md:393`; `SPEC-A.md:1981` and step 4.
- **Evidence:** at $10, the fixed-cost term (about 40 bps at 10 trades a day, plus fixed lamports per trade) dominates. MR-01 could be killed at $10 while profitable at $100–$1,000. This breaks "Size is not the trial".
- **Fix:**
  - Report the hurdle at $5, $20, $100, $1,000 and $10,000, with price impact from real depth.
  - Have the PREREG name the primary size in the primary cell.

**F5. The 31 Dec stop date is not squared with the gate timeline.** `ARCH.md:1716`, `:421`; INTEGRATION M2 exit.
- **Evidence:** the path is the build, then 7 days of Phase 0, then `W_B` (30, planned up to about 65 days), then `W_R` (≥ 14 days and ≥ 300 trades: about 22–75 days at 4–14 trades a day), then `W_P` (21 days). The planned path ends around Feb–Mar 2027; even the best case reaches `replay_passed` only around mid-December. These are my estimates; build time is unknown.
- **Gap:** nothing says what happens if gates are still running on 31 Dec.
- **Fix:** state the rule for a strategy that is still in progress on 31 Dec (continue only while recording costs nothing new, or stop). This is the owner's call.

**F6. The anti-peek test for the kill check cannot be measured.** `SPEC-A.md:1985`.
- **Evidence:**
  - The test refuses "a rule commit not an ancestor … at the time the data is first read". Nothing records when the data is first read.
  - Commit dates are set by the author, so they prove nothing.
- **Fix:** require the rule commit to be on the remote before the first Phase 0 day's segments are pulled, checked against M07's pull log. A simpler alternative: before recording day 1 ends.

**F7. "Exactly MR-01's two configurations" cannot run exactly in Phase 0.** `SPEC-A.md:1981`; `ARCH.md:393`.
- **Evidence:**
  - MR-01's entry needs the depth-fall check, no pending authority or fee change, REGIME and ENTRYRATE. Screening and M21 do not exist yet (C-44, `phase0_unscreened`).
  - The horizons go to 60 min, while one configuration has a 30 min time stop. Its targets and stops are not mentioned.
- **Effect:** two builders could produce different kill results.
- **Fix:**
  - List which filters apply in Phase 0.
  - Say returns are raw horizon returns that ignore the configurations' exits.
  - Add the missing filters as caveats.

## MINOR

**F8. Random-entry matching differs between two places.** The kill check matches on "same pool, same UTC hour" (`SPEC-A.md:1981`, `ARCH.md:393`). C-65 matches on pool, hour and 6 h MAD decile. **Fix:** pick one rule.

**F9. D12 contradicts itself on PumpPortal.** The Default line still says "**(a)** for new tokens" (`ARCH.md:1745`), while the new bullet says PumpPortal is not used. **Fix:** amend the Default line.

**F10. P-1 was not raised, with no reason recorded.** A06 says "Raise R-1/P-1 to that n", but only R-1 was raised. **Fix:** raise P-1, or record the reason in DECISIONS.

**F11. `n_80` likely underestimates the trades needed.** `ARCH.md:457`.
- **Evidence:** `n_80` uses `S_B` measured on `W_B`. That is the selected, in-sample Sharpe, which is optimistic, so the holdout is underpowered.
- **Fix:** use the lower CI bound of `S_B` or a deflated Sharpe, and add an owner path for when `n_80` is very large.

**F12. Register labels go beyond their sources.** FACTS RS-01..RS-39.
- The Z0D builder marked its own entries "confirmed" while the notes say a fresh reviewer still re-checks them. **Fix:** mark them pending until reviewed.
- RS-19's "80k credits an hour" comes from a list of known bugs in `SUPERVISOR_MESSAGES.md:93`, not a measurement. CLAUDE.md says about 25,000 an hour.
- RS-38 and `ARCH.md:378` call the 16,367-coin re-test survivorship-free. But the coins were picked by pump.fun all-time high, a field observed after the decision (RS-12, C-63), and by "traded 9+ days". **Fix:** label that selection.

**F13. The ≤ 50% data-source rule cannot be checked.** In D04 (C-54):
- Chainstack's "3M requests a month" has no fact ID.
- Shyft's free-plan limit is not stated anywhere.
- **Fix:** add both documented limits with source and date, or mark them VERIFY.

## Totals

| Severity | Count | Findings |
|---|---|---|
| BLOCKER | 1 | F1 |
| MAJOR | 6 | F2–F7 |
| MINOR | 6 | F8–F13 |

Head attacked: `ed46b89859a17c504d4f7a3f935494216950129a`. Nothing was pushed.

### Supervisor rulings sent to the builder (in order)

Supervisor: two additions to Z0D, from the map's round 3 red team. The map is now at claude/blueprint-migration 4d124876; merge it before you finish.
1. **R3-10.** PumpPortal is not used (owner, 7 Oct), so add a C-xx for A-M03-02: its `gapBps` path is tested on fixtures only, and the 60 s `getSignaturesForAddress` timer is the only live trigger until the owner rules on PumpPortal.
2. **R3-11.** UI-T07 builds against a VM-03 fixture under INTEGRATION's fixture-first rule (INTEGRATION.md:33). Its contract test waits for B-M28-01. Record that as a C-xx.

Also note the map changes:
- Z04 is now A-M07-01 only.
- A-M13-03 moved into Z06 (Clock, latency and statistics), because it needs A-M10-01's RNG.
- There is a new M2 card, Z-H (the history replay for owner item 2).

If your INTEGRATION edits name cards, keep them consistent with this.

---

Supervisor rulings on your open points:
1. **R-1 only.** Owner item 6 is met by R-1 at max(300, n_80) with `W_R` as the untouched holdout. P-1 stays as it is; the owner's item asks P only for consistency with the backtest.
2. **The stricter rule, in line with A16.** The Phase 0 PREREG declares one primary cell (configuration × horizon × delay) before data. MR-01 survives the kill check only if that primary cell clears both tests; every other cell is reported only. Write this into A-M13-01 step 9 and its C-xx.
3. **Both placements stand** (stricter).
4. **Round trips accepted.** Exits are measured as buy-then-sell round trips, because the payer holds no tokens. State in P-6 that this is how the owner's "every exit simulated" is met.
5. **Resolved** by your B-10 tightening (≥ 30 clean days; the owner is told before M2 if fewer are held).
6. **Correct not to register.** Add one line to the §20 log that the addendum's 8.3 and 4.7 trades a day were not reproduced from `results.json` (13.9 and 12.7), so they are not in the register.
7. **Correct.**
8. **and 9.** The fresh reviewer re-checks the FACTS claims and scripts the dependency check.

Push ruling 2 and the line for item 6, then end your chat with the head sha. A fresh reviewer and a red team start after that.

---

Supervisor → Z0D builder. Review and red team on ed46b898 both FAIL. Apply all of this in one round on claude/z0d-blueprint-docs.

1. Start by merging origin/ccr-14987baf-i6lrsl (94d55a84, the merged map) with a merge commit.
2. When done, run your dependency and FACTS check scripts again, push, and reply with the head sha and a table that maps each item below to its file:line. I open the PR.

Never loosen anything. Where a ruling is "owner pending", write it so the gate fails closed until the owner rules.

## A. Reviewer findings
- **F1 BLOCKER (red team F1 is the same finding).** Carry the new gates into four places:
  - SPEC-A A-M13-06 steps 2–5:
    - R-1 ≥ max(300, n_80);
    - B-9 and B-10;
    - P-5: the 48 h dry run, ≥ 99% uptime, drills;
    - P-6: ≥ 95% simulating, as defined in C below;
    - P-10.
  - The `ExternalGateInputs` interface: add fields for dry-run uptime and drills, fault-injection results, the B-9 inputs, the B-10 report, P-10 and okShare.
  - A-M13-05 step 2: `paper_passed` needs P-10.
  - The PerfStats minimum (SPEC-A:2098).
  Then align the MA-2 row, the ARCH §18 Phase 2 row and the SPEC-B M3 row, and add an ARCH revision-log line for A-M13-06.
  Add acceptance cases that FAIL on each of these:
  - R-1 below max(300, n_80);
  - a missing B-9 or B-10 input;
  - a missing P-10 input;
  - okShare below 9,500 bps.
- **F2.** In D04/C-54 and in C-58, state the open owner question. Until the owner rules, Helius Developer ($49 a month) counts as the bot's fixed cost for P-9 (the stricter reading). Cite DECISIONS 2026-10-07 and MIGRATION A03/O7.
- **F3–F7.** Fix as the reviewer wrote:
  - F3: the MA-0c kill stop, and P-10 in MA-2 and SPEC-B M3;
  - F4: change to B-M19-06 at SPEC-B:1022 and in CL-14;
  - F5: the INTEGRATION:13 wording;
  - F6: the kill check in C-46;
  - F7: the extra cite lines for RS-24, RS-26 and RS-31. For RS-29, cite edge.md §6.5.1 only if that section actually says it; otherwise mark it DERIVED.
- **F8.** You may edit docs/MIGRATION.md for this card only:
  - "B-M29-04's import-run part" becomes B-M29-05;
  - "the live part of B-M19-03" becomes B-M19-06;
  - the A09 wording in G2 below;
  - the Z08 additions in G6 below.

## B. Red-team findings (rulings)
- **F2, B-10 vs C-52.**
  - C-52 stays: coin lists built from pump.fun's API before 7 Oct are never a gate input.
  - In B-10, write that no clean transaction-level history day is confirmed held as of 7 Oct (cite edge.md:172 and MIGRATION:810), so B-10 cannot pass now.
  - Mark B-10 "OWNER DECISION PENDING", with these options:
    - (a) count forward transaction-level M07 recording as B-10's history once ≥ 30 clean days exist (this needs a free-limit cost check first);
    - (b) the owner approves credits for a history download;
    - (c) the owner drops B-10's history part.
  - Until the owner rules, B-10 fails closed.
  - Move the Z-H day count to M0. I am telling the owner today.
- **F3, owner item 4.**
  - Every paper entry leg and exit leg gets a shadow simulation.
  - Per-shadow bound: |sim error| ≤ 100 bps.
  - okShare = (status ok AND within the bound) ÷ ALL paper legs in the window.
  - Any leg with no shadow counts as a failure: skipped, dropped by a cap, or errored.
  - P-6 needs okShare ≥ 9,500 bps and at least 50 legs.
  - Add "exits simulated as buy-then-sell round trips" to MIGRATION's Clashes for the owner. The reason: a paper wallet holds no tokens, so a plain sell cannot be simulated.
- **F4, size.** The kill check is judged at $5, $20, $100, $1,000 and $10,000:
  - price impact comes from min(real, effective) depth, with the k = 1% cap;
  - the lean and strict cost lines are both shown;
  - kill only when no size passes and at least one size fails; a size without enough trades is "insufficient", never a kill;
  - the deciding line is the lean row (A-M13-01 step 4), with the strict, $10 and $59 lines shown;
  - drop $10 as a deciding size.
  Align ARCH:393 and SPEC-A:1981 with research/phase0/PREREG.md, which is being changed to the same rule. The PREREG names the primary cell.
- **F5, 31 Dec.** Write it as OWNER PENDING. Until the owner rules, a strategy whose gates are still running on 31 Dec continues only while it costs nothing new, and no new strategy work starts after 31 Dec.
- **F6, anti-peek.** The PREREG is frozen at R0, the recording start. Its commit sha is read with ls-remote and stored in the R0 manifest before the first Phase 0 segment is pulled. The test checks that stored sha against M07's pull log; author dates are never used.
- **F7.**
  - List the filters that apply in Phase 0 (point to the PREREG list), and name the ones that do not exist yet as caveats.
  - The kill fires only if delay 1 fails on the configuration's own exit path (target, stop, time T) AND at every fixed horizon from 5 to 60 min.
- **F8.** One matching rule: C-65 (pool, hour, 6 h MAD decile).
  - Candidates pass the same entry-time filters as the signals, the depth cap at size x included.
  - Drop any candidate whose holding window overlaps [signal − L, signal].
- **F9.** Change the D12 Default line: PumpPortal is not used (owner, 7 Oct); chain data covers new coins.
- **F10.** P-1 is not raised. Write this reason in DECISIONS: owner item 6's power requirement binds on the untouched holdout, R-1 on W_R. The paper phase checks consistency (P-3) and execution, and already needs ≥ 21 days and ≥ max(MinTRL, 100) trades. Raising P-1 to n_80 would stretch W_P without testing the edge again.
- **F11.**
  - Compute n_80 from the LOWER bound of S_B's 95% CI.
  - If n_80 needs more than 90 days of W_R at the measured trade rate, the strategy goes to the owner, and nothing passes automatically.
- **F12.**
  - Mark your RS entries "pending review" until the fresh reviewer re-checks them.
  - RS-19: label "80k credits an hour" as a bug-list figure (SUPERVISOR_MESSAGES.md:93), not a measurement, and note CLAUDE.md's figure of about 25,000 an hour.
  - RS-38 and ARCH:378: label the selection (by pump.fun all-time high and 9+ days traded), so they are not called survivorship-free.
- **F13.** Add the documented limits with source and date 2026-10-07, from research/verify-m0-m1/RESULTS.md rows 20 and 21:
  - Shyft Free: 10 RPC req/s, 0 index req/s, 1 sendTransaction/s;
  - Chainstack Developer: 5 RPS on Solana mainnet, 3M RU a month.

## C. VERIFY flags to apply
Source: research/verify-m0-m1/RESULTS.md on claude/research-verify-m0-m1 (01438a5e).
1. **Flag 2.** Rewrite A-M01-02 step 3 from row 8:
   - market cap uses the effective quote reserve; delete "lower of vault-only and effective";
   - mayhem pools use a fixed supply of 10^15;
   - when `creator_fee_configurable` is set, a per-pool `creator_fee_bps` replaces the creator rate;
   - the creator fee is 0 when `coin_creator` is the default key;
   - exotic quote mints use `exotic_flat_fees`;
   - each fee component is rounded up (ceil) separately;
   - buy-exact-quote-in uses q′ − 1;
   - the ≤ 30 bps filter reads the per-pool creator fee.
   A-M02-02 reads `creator_fee_bps`, `is_mayhem_mode`, `creator_fee_configurable` and `max_configurable_creator_fee_bps`.
2. **Flag 3.** A sell above the real vault fails; it is not clamped.
   - A-M01-03: the quoter returns an error or the largest sellable size, and the exit ladder sizes sells to the real vault.
   - A09: "proceeds clamped" becomes "sell size limited so it can land" (in MIGRATION too).
   - The builder's test simulates a sell near the boundary.
3. **Flag 4.** Chainstack bucket ≤ 2.5 req/s, and correct LD-32.
4. **Flag 6.** A-M03-03 filters with a discriminator memcmp at 0 and a wSOL memcmp at 75, with no dataSize. Decoders accept pools shorter than 300 bytes and read missing tail fields as zero.
5. **Flag 9.** Apply the FACTS corrections LD-32, LD-33, DA-11 and UI-F32, and fold in the VF entries RESULTS proposes.
6. **Flag 1.** In D30/A-M03-03, note that neither Shyft Free nor Chainstack Developer can run getProgramAccounts, so D30 is OWNER PENDING:
   - (a) a capped Helius job (recommended);
   - (b) track only migrations seen since recording began;
   - (c) a paid plan.
   Also note that the A-M06-03 holder checks have the same limit (M2).
7. **Flag 8.** A-M14-03 and A-M14-04: any URL that is logged must have its query-string key redacted.

## D. Supervisor decisions to record in DECISIONS (dated 2026-10-07)
- **Node.** Stay on Node 22 (host pin 22.23.3) for now. This is a short deviation from ARCH's "active LTS", taken to avoid two installer moves; Node 24 enters maintenance on 20 Oct. A separate card moves to Node 26 after it becomes LTS on 28 Oct 2026. Z02's A-45 spike checks transactions, WAL and online backup on 22.23; if any of them fails, Z02 waits for the Node card.
- **Licences.** MPL-2.0 is allowed for dev/test-only dependencies (axe-core, @axe-core/playwright) and is never allowed at runtime.
- **P-1.** As in B, F10.

## E. MIGRATION Z08 additions
Z08 records two extra things:
- SOL/USD once a minute, from a deep on-chain SOL/USDC pool read through the Phase 0 provider (the builder picks the pool and cites it);
- GlobalConfig and FeeConfig at start and every 10 min.
Both stay inside the ≤ 50% budget.

---

Supervisor correction to my last message. Three cross-references in it were wrong:
- In A F1, "P-6: ≥ 95% simulating, as defined in C below" should point to B F3, not C.
- In A F8, "the A09 wording in G2 below" should point to C item 2.
- In A F8, "the Z08 additions in G6 below" should point to section E.
Nothing else changes.

---

Supervisor → Z0D builder. One addition to the fix list. Nothing in the list changes.

1. **New fact RS-40.** Add the MR-01 1-minute screen result. Cite research/mr01-screen/RESULTS.md and PREREG.md @ c67f37f9 (branch ccr-7fae2302-drz4co; PR #283 is bringing it into the base). Record:
   - **Verdict:** KILLED, kill-only.
   - **Validation result at $200:** mean net −0.77% (MR-01-5, CI −0.79 to −0.74) and −0.76% (MR-01-15, CI −0.79 to −0.72).
   - **Size of the bounce:** gross is only +0.04% to +0.06%, against a round trip of about 0.88%.
   - **Labels and limits:** GeckoTerminal 1-minute bars; a survivor-only list taken from pump.fun's ranking; pre-wall data.
2. **D08 note (new clarification C-75).** The 1-minute screen exists. It was pre-registered at 5ebb439 (9:46 PM, 7 Oct), before the owner's A18 ruling at 10:58 PM. Whether it counts as MR-01's stop is OWNER PENDING. Until the owner rules, D08 stays as written. Do not change any other MR-01 text for this.

The builder's fix round is `d5393ad0` (PR #286).

## Round 2 (head `d5393ad0`, 8 Oct 2026)

### Fresh review (FAIL)

Z0D round 2 fresh review, PR #286. Head d5393ad07a3b9f7de6e44d3191ea478db17ce1ce (confirmed by ls-remote, unmoved; base 94d55a84 is in its history). Nothing edited, committed or pushed.

RESULT: FAIL. Your RS-40/C-75 addition did not land, and the ID C-75 is now used for something else. Three more problems block a pass: the Blueprint and research/phase0/PREREG.md disagree on which cost row decides the kill check; A-M14-01 and two ARCH tables still give Chainstack 25 req/s with an 80% rate rule; and U-A04 still says "clamp", with B-M20-04 not updated. All the gate work (A-M13-04/05/06, ExternalGateInputs and the failing acceptance cases) is DONE.

NEW FINDINGS

F1 BLOCKER: RS-40 and your C-75 are missing; C-75 now means something else.
- Evidence: FACTS.json has 291 facts and no RS-40. No document cites research/mr01-screen.
- C-75 is the D30 "owner pending" note (VERIFY flag 1) at SPEC-A:2530. It is cited at ARCH:1876, ARCH:3100, SPEC-A:771, SPEC-A:775 and SPEC-A:1171.
- The head commit (13:32 UTC) has no trace of the addition, so it probably arrived after the builder's round.
- Fix: renumber the D30 note to C-76 at every site above. Add C-75 as the D08 note (screen pre-registered at 5ebb439 before A18; OWNER PENDING; D08 unchanged). Add RS-40 with its sources @ c67f37f9 and cite it in the prose.

F2 MAJOR: the kill check's deciding row conflicts with the PREREG.
- ARCH:393, SPEC-A:1994 and C-48 (SPEC-A:2503) decide tests (a) and (b) on the LEAN row, with the strict row shown only.
- research/phase0/PREREG.md §5.5 (lines 323, 340-341) on origin/claude/research-phase0-prereg @ df7d75da decides both tests on the STRICT row (ruling OPEN-9) and only reports the lean row.
- A-M13-01 reads every rule from the PREREG, so the spec's acceptance cases and the frozen file would give different verdicts.
- Fix: you rule lean or strict, then align ARCH 3.3, A-M13-01 step 9 and C-48 with the PREREG, or amend the PREREG before R0.

F3 MAJOR: stale Chainstack limits.
- SPEC-A:2310 (A-M14-01, an M0 ticket) defaults Chainstack to "25 req/s [LD-32]" with "Configured rates are 80% of documented limits". ARCH:1234 and ARCH:2343 still say 25 req/s.
- LD-32 and VF-10 now say 5 RPS. A builder following A-M14-01 would set Chainstack at 20 req/s, four times the documented limit, breaking the owner's ≤ 50% rule.
- Fix: 5 RPS on Solana mainnet in all three places, and ≤ 50% instead of 80% in A-M14-01.

F4 MAJOR: VERIFY flag 3 is only partly done.
- SPEC-A:2541 (U-A04) still says "Clamp to the real vault". ARCH:2184 still calls sell behaviour past the real vault UNVERIFIED.
- B-M20-04 (SPEC-B:1439-1450) has no step and no acceptance case for E_EXCEEDS_REAL_VAULT or maxSellableBase. The sizing rule exists only in SPEC-A and in the cross-group columns of C-13 and C-60.
- Fix: update U-A04 and the ARCH 8.4 row. In B-M20-04, add sizing to maxSellableBase, a rule that E_EXCEEDS_REAL_VAULT is not a cannot-sell failure, and a drained-pool acceptance case.

F5 MINOR: ARCH:943 (M03) still names a dataSize filter. Change it to the discriminator memcmp at 0 and wSOL at 75.

F6 MINOR: SPEC-A:2210 uses n_R without defining it; define n_R = max(300, n_80). At SPEC-A:2209, ownerRuling 'c_dropped' still needs ≥ 30 days, so option (c) can never pass. That fails closed, but it cannot be built as written; say what B-10 does under (c).

F7 MINOR: the B-M26-04 adapter (SPEC-B:2198) names only P-5 and P-10. C-49 (SPEC-A:2504) says it also supplies replayDeterminism, historyReplay and shadowCoverage. Name the producer of each field.

F8 MINOR (your file): MIGRATION:811, card Z-H, still says the owner is told "before M2 starts"; the count is now in M0 per INTEGRATION's M0 row.

F9 MINOR: VF-02/06/07/08/12/13/15 are cited nowhere. C-59, C-61-C-64, C-66, C-70 and C-71 appear only in their own definition rows (same at ed46b898).

CHECKLIST
- A F1: DONE. SPEC-A:2196-2211.
  - Failing acceptance cases at SPEC-A:2223-2226: R-1 at 299 trades, or 300 when n_80 = 412; B-9 null, 9 replays or a differing hash; B-10 null or pending; P-10 null; okShare 9,499.
  - A-M13-05 SPEC-A:2162; PerfStats SPEC-A:2121; MA-2 SPEC-A:46; ARCH 18 at ARCH:2897; SPEC-B:27; revision log ARCH:3089.
- A F2-F8: DONE.
  - F2: ARCH:1678, C-54, C-58. F3: SPEC-A:44. F4: SPEC-B:1022, CL-14. F5: INTEGRATION:13. F6: C-46.
  - F7: cite lines checked at 72f1793f; RS-29 cites edge.md:162, which states it.
  - F8: MIGRATION:808, 832.
- B F2: DONE. ARCH:456; SPEC-A:2209; INTEGRATION M0 row. It cites edge.md:165, the correct line (your note said 172). The MIGRATION leftover is F8.
- B F3: DONE. ARCH:469; A-M12-02; MIGRATION:696.
- B F4: PARTIAL (F2).
- B F5-F12: DONE. F11 is in ARCH:457 and SPEC-A:2210 (F6 is minor). F12: all 39 RS facts are pending_review.
- B F13: PARTIAL (F3).
- C1 fee maths: DONE; it matches RESULTS row 8.
- C2: PARTIAL (F4).
- C3: PARTIAL (F3).
- C4: DONE in A-M03-03 and D30; ARCH:943 is stale (F5).
- C5: DONE. VF-01..VF-16 claims are byte-identical to the RESULTS JSON. LD-32, LD-33, DA-11 and UI-F32 are corrected.
- C6: DONE, but under the wrong ID (F1).
- C7: DONE.
- D: DONE. DECISIONS:115-117.
- E: DONE. MIGRATION:771.
- RS-40: MISSING.
- C-75 (1-minute screen note): MISSING, and the ID is reused.

OTHER CHECKS
- FACTS.json: parses; 291 facts, no duplicate IDs. Every cited fact ID is defined. C-01..C-75 are each defined once, and every cited C ID exists.
- Ticket dependency script:
  - 63 A, 81 B and 32 UI tickets: 176 in all.
  - No undefined dependencies and no cycles.
  - Later-milestone dependencies: only UI-T14 → B-M17-08 and B-M29-04, the known live-acceptance-only cases.
  - Listed and table counts per milestone match: M0 24/24, M1 25/25, M2 46/46, M3 49/49, M4 27/27, Deferred 2/2. M4b shows 5 listed and 3 in the table, as before.
- Nothing loosened apart from F3. B-10, D30 (option (b) runs, holder checks fail closed), the 31 Dec end state and Helius as a fixed cost all fail closed or take the stricter reading.
- Scope: the diff touches only docs/blueprint/**, three DECISIONS rows and the allowed MIGRATION edits. No code changed.

FAIL · d5393ad07a3b9f7de6e44d3191ea478db17ce1ce

### Red team (1 BLOCKER, 8 MAJOR, 4 MINOR)

# Red team, round 2: card Z0D at `d5393ad0` — FAIL (1 BLOCKER, 8 MAJOR, 4 MINOR)

Head confirmed with ls-remote: d5393ad07a3b9f7de6e44d3191ea478db17ce1ce. Numbers that match their sources: fee maths (each part rounded up separately, q′−1, effective-reserve market cap, inclusive threshold; RESULTS row 8); mayhem supply 10^15 (row 8); sell above the real vault refused, not clamped (row 9); Chainstack per-second bucket 2.5 req/s (row 21); n_80 constants 1.960 and 0.842.

## BLOCKER
RT-01. The kill check decides on a different cost row than its PREREG.
- SPEC-A :1994, ARCH :393 and C-48: tests (a) and (b) use the LEAN row; the strict row "decides nothing".
- PREREG (origin/claude/research-phase0-prereg @ df7d75da): "Strict row (A07): decides A05" (§4 line 192); §5.4/§5.5 compute net(x) and the excess under STRICT. Its pass also needs n_a ≥ 30 AND n_b ≥ 30 per cell (:345); SPEC-A counts signals per size only.
- SPEC-A says the check reads every rule from the PREREG, so the code breaks either the frozen PREREG or the spec; verdicts can differ.
- Fix: pick one row before R0; align SPEC-A step 9, ARCH 3.3, C-48 and the PREREG, including the per-cell n_a/n_b rule.

## MAJOR
RT-02. Kill-check depth cap looser than ARCH. SPEC-A :1993 uses 0.5% of EFFECTIVE depth; ARCH DEPTHPCT (:2115) and PREREG §4 (:229) use min(real, effective). Fix: use min(real, effective).

RT-03. A-24b move rule still at one size, with three different monthly costs. SPEC-A steps 4–5 (:1984-1985) judge at a $10 trade and $12 a month (breaks "Size is not the trial"). PREREG §3 judges per size with $10 a month deciding. D04 (ARCH :1678) counts Helius $49 as a §1.4 fixed cost (stricter), i.e. about $59. The kill-check fields show $10 and $59 lines. Fix: per-size steps 4–5 with the PREREG verdict rules; one deciding monthly cost, reconciled with D04.

RT-04. Chainstack bucket ignores the monthly limit (≤ 50% rule, possible spend). Bucket ≤ 2.5 req/s (SPEC-A :2339, ARCH D04) is about 6.5M requests in 30 days, against 3M RU documented (1.5M at 50%; ARCH D04 itself derives 0.58 reads a second). getSignaturesForAddress costs 2 RU (row 21), so the owner's 0.5 req/s of those calls is about 2.6M RU a month. VF-10 lists Developer overage at $20 per 1M RU. Fix: bucket = lower of 2.5 req/s and the owner's 0.5 req/s; an RU-weighted monthly counter with a hard stop at 1.5M; a test counting gSFA as 2 RU.

RT-05. Three gate inputs have no producing ticket, and the B-gate inputs arrive a milestone too late. C-49 says B-M26-04 supplies replayDeterminism, historyReplay and shadowCoverage, but SPEC-B :2198 names only P-5 and P-10. B-M26-04 is M3; B-9 and B-10 decide backtest_passed at the M2 exit, so those inputs are always null and M2 never exits (fails closed, but forever). Fix: producers named (A-M11-01's 10-replay run record for B-9, card Z-H for B-10, A-M12-02 p6Stats as the single P-6 source), injected in M2, with acceptance cases in B-M26-04.

RT-06. Gate inputs not tied to build, configuration or window. historyReplay() takes no arguments (SPEC-A :2197): a stale report from another config or build could pass B-10. dryRun (:2199) has no build sha and its 48 h can be any slice. P-6 paperLegs has no named source; if counted from the shadow table, a leg with no shadow row is missed and okShare is inflated. Fix: buildSha and configKey on historyReplay and dryRun, failing on mismatch; the 48 h as one pre-declared block or the whole W_P; paperLegs from A-M12-01's paper intents.

RT-07. B-M20-04 (SPEC-B :1439) does not size exit sells to the real vault and has no drained-pool fixture; only C-13/C-60 say it does. A builder following SPEC-B sends sells that are refused, and exits get stuck. Fix: a step and an acceptance case (E_EXCEEDS_REAL_VAULT → sell maxSellableBase; 17.58 SOL virtual / 0.27 SOL real fixture).

RT-08. Two B-10 owner options cannot work as written (ARCH :456). (a) "forward transaction-level M07 recording": M07 records 1 Hz account snapshots (ARCH :974, :1092, D03 (a)), not transactions, so it needs a D03 switch that may cost credits; forward days would also overlap W_B and the untouched W_R holdout. (c) "drop the history part" can never pass: SPEC-A's evaluator still requires ≥ 30 clean days whatever the ruling. Fix: option (a) says a trade-event source is needed and only days outside W_R are used; the evaluator branches on ownerRuling; the owner is told these limits before choosing.

RT-09. RS-40 and the D08 1-minute-screen note are missing (screen KILLED, −0.77% at $200), and C-75 was already used for D30 (SPEC-A :2530), so the planned C-75 clashes. This evidence matters for "No knowingly losing trades". (The addition may have arrived after this push.) Fix: add RS-40 and the D08 note as C-76.

## MINOR
RT-10. A-M01-03's boundary test (:305) cannot run as written: a sell just above the boundary needs a payer holding that many tokens, and the sim payer holds none (as P-6 says). Fix: name a method (replay a recorded failed sell, or simulate as an existing holder with sigVerify false; I am not certain the second works on every provider, worth verifying in the RPC docs), else mark the on-chain result "not verified".

RT-11. R-1: SPEC-A :2210 uses "n_R", never defined; the 90-day test uses n_80, not max(300, n_80); no acceptance cases for S_low ≤ 0 or more than 90 days.

RT-12. Stale or incomplete text: ARCH revision log :3066 still says "one primary cell" (the rule is now 25 cells); SPEC-A U-A04 :2541 still says "Clamp to the real vault"; A-M13-01 step 1 (:1981) says "first 7 complete days" (PREREG: D1 ≥ R0 + 30 h, extendable to D14); A-M01-02 omits "below the first threshold the first tier applies" and the exotic → flat-fees fallback while exotic fees are zero.

RT-13. Owner-pending items (B-10, D30/C-75, the holder-index provider, the 31 Dec rule) are not in MIGRATION's owner waits. MIGRATION Z-H (:811) still counts clean days "before M2", not in M0. A-M06-03 failing closed blocks every backtest entry, and INTEGRATION's M2 exit does not name it as an owner wait.

## Totals
BLOCKER 1 (RT-01); MAJOR 8 (RT-02 to RT-09); MINOR 4 (RT-10 to RT-13). Head attacked: d5393ad07a3b9f7de6e44d3191ea478db17ce1ce. Nothing edited or pushed; nothing sent to the owner.

### Supervisor rulings for round 3 (8 Oct 2026 about 1:00 AM)

Principle (new C-77): a stop-only check (the A-24b move rule and the A05 kill check) decides on the lean cost row and the real monthly cost ($10, the 2 GB host). The strict row, the $12 line and the $59 line are shown beside it. Gates that pass a strategy (B-2, R-2, P-9) decide on the conservative row and take the stricter fixed cost while the Helius question is open (D04). A check that can only stop must not stop on costs we do not pay. A gate that passes must not pass on costs we might pay.

1. **RT-01 / F2, kill check row.** The lean row decides tests (a) and (b). Adopt the PREREG's per-cell rule: n_a ≥ 30 AND n_b ≥ 30. Align ARCH 3.3, A-M13-01 step 9 and C-48. The PREREG (on hold) still says strict decides A05. It must be amended before R0 if MR-01 testing goes on. Record this in SPEC-A as a precondition of R0.
2. **RT-02.** The kill-check depth cap is 0.5% of min(real, effective) (ARCH DEPTHPCT).
3. **RT-03.** Rewrite A-M13-01 steps 4–5 per size ($5, $20, $100, $1,000, $10,000), using the PREREG verdict rules. Kill only when no size passes and at least one size fails; a size without enough trades is "insufficient". The monthly cost follows C-77.
4. **RT-04, Chainstack.** Two limits apply:
   - Rate: the lower of 2.5 req/s and the owner's 0.5 req/s.
   - Volume: an RU-weighted monthly counter with a hard stop at 1.5M RU (50% of 3M). getSignaturesForAddress counts as 2 RU.

   Add a test that counts gSFA as 2 RU and stops at the cap. There is no overage spend, ever.
5. **F3, all providers.** Chainstack is 5 RPS on Solana mainnet in A-M14-01 (SPEC-A:2310), ARCH:1234 and ARCH:2343. Configured rates are ≤ 50% of documented limits for every provider (owner rule), not 80%.
6. **RT-05 / F7, producers and timing.** Name the producer of every `ExternalGateInputs` field:
   - B-9 ← A-M11-01's 10-replay run record;
   - B-10 ← card Z-H's report;
   - P-6 ← A-M12-02 p6Stats, the single source;
   - P-5 and P-10 ← B-M26-04.

   B-gate inputs are injected in M2, not M3. Add acceptance cases where the inputs are produced.
7. **RT-06.**
   - `historyReplay` and `dryRun` carry `buildSha` and `configKey`; a mismatch fails.
   - The 48 h dry run is one contiguous block, declared before it starts, inside W_P.
   - `paperLegs` comes from A-M12-01's paper intents (every leg), never from the shadow table.
8. **RT-07 / F4, exits against the real vault.**
   - B-M20-04 gets a step: sell size ≤ maxSellableBase.
   - E_EXCEEDS_REAL_VAULT is not a cannot-sell failure.
   - Add an acceptance case on a drained-pool fixture (17.58 SOL virtual / 0.27 SOL real).
   - Update U-A04 ("refused, not clamped"; VERIFY row 9) and the ARCH 8.4 row (ARCH:2184): the SDK refuses; the on-chain result is inferred.
9. **RT-08, B-10 options.**
   - (a) M07 records 1 Hz account snapshots, not transactions. Option (a) therefore needs a trade-event source, and its cost must be estimated before the owner chooses. It uses only days outside W_R.
   - (b) Rewrite as: a capped history download using credits the owner already pays for (Helius Developer), shown to the owner as a credit estimate before any spend.
   - (c) The evaluator branches on `ownerRuling`. Under (c), B-10 is recorded as waived by the owner, with the ruling's date and quote.
   - Until the owner rules, B-10 fails closed.
10. **RT-09 / F1, IDs.** Keep the D30 note as C-75; do not renumber. Add the 1-minute screen note to D08 as **C-76**: pre-registered at 5ebb439 before A18; OWNER PENDING whether it stops MR-01; D08 unchanged until then. Add **RS-40** to FACTS.json and cite it in D08 and §3.2 (sources research/mr01-screen/RESULTS.md and PREREG.md @ c67f37f9, PR #283).
11. **RT-10.** A-M01-03's boundary test uses an SDK-math fixture; the on-chain result is "not verified" until a recorded failed sell is replayed. Do not claim that simulating as a holder works.
12. **RT-11 / F6.**
    - Define n_R = max(300, n_80); the 90-day test uses n_R.
    - S_low ≤ 0 means power cannot be computed: the gate fails and the case goes to the owner.
    - More than 90 days goes to the owner.
    - Add acceptance cases for both.
13. **RT-12, stale text.**
    - The ARCH revision log: "25 cells", not "one primary cell".
    - A-M13-01 step 1 follows the PREREG (D1 ≥ R0 + 30 h, extendable to D14).
    - A-M01-02 adds "below the first threshold the first tier applies" and the exotic → flat-fees fallback.
14. **RT-13 / F8, owner waits.**
    - MIGRATION's owner waits list B-10, D30 (C-75), the holder-index provider (A-M06-03), the 31 Dec rule and the C-76 MR-01 screen.
    - Card Z-H's day count is in M0.
    - INTEGRATION's M2 exit names the A-M06-03 holder-check owner wait.
15. **F5.** ARCH:943 (M03): replace `dataSize` with the discriminator memcmp at 0 and wSOL at 75.
16. **F9.** Cite each VF entry at the ticket it affects (per its RESULTS row). For a C-xx with no ticket impact, mark it "register only" in its row.

The builder may edit docs/blueprint/** and the listed MIGRATION and DECISIONS lines only. Merge origin/ccr-14987baf-i6lrsl first if it has moved.

## Round 3 (head `2dc25ffe`, 8 Oct 2026)

### Fresh review (PASS, 5 MINOR)

Z0D round 3 delta review, PR #286. Head 2dc25ffedebaf29bd86b97f6c8f2e9bfdadb800e (confirmed by ls-remote; base 94d55a84 is in its history). Rulings checked against docs/reviews/Z0D.md @ 71207016, and the owner's B-10 choice against CLAUDE.md @ 651b1737. Nothing edited or pushed; nothing sent to the owner.

RESULT: PASS. Every round 2 finding (F1-F9) and every red-team finding (RT-01..RT-13) is DONE. Five new MINOR findings below are worth fixing in a later pass; none loosens a gate or affects money.

NEW FINDINGS (all MINOR)
N1. B-10 cannot check the owner's "estimate before spend" order.
- SPEC-A:2219 and step 3 at :2232 require only that creditEstimateShownAtMs is non-null.
- So a report whose estimate was shown after the first credit was spent still passes.
- Fix: add firstCreditSpentAtMs and require creditEstimateShownAtMs &lt; firstCreditSpentAtMs.
- Also, "at least 30 clean days" could mean cleanDaysHeld or daysUsed; say daysUsed.length ≥ 30.
- Note: daysInsideWR is always 0 at B-10 time, because W_R starts after W_B. That is harmless.

N2. Chainstack's 0.5 req/s cap and monthly hard stop also bind its live role.
- ARCH:2346 lists Chainstack as RPC B: P0/P1 failover, the second provider for expiry proofs, signer endpoint 1. It is now capped at min(2.5, 0.5) req/s and goes dark for the rest of the month at 1.5M RU.
- At 0.5 req/s of getSignaturesForAddress (2 RU each), the stop arrives around day 17 of the month.
- The owner's "one read every 2 s" was about Phase 0 backup reads.
- DECISIONS:113 records the risk for the keyless Sender only.
- Fix: record the same risk for RPC B, name a fallback for expiry proofs once Chainstack is stopped, and re-measure before M4.

N3. Judgement call (a): the A05 tests carry no monthly term.
- ARCH:393, SPEC-A:2005 and C-77 (SPEC-A:2562) take the $10 monthly term out of the kill check.
- This matches the PREREG's per-trade net(x), but it departs from your C-77 wording, "the lean row and the real monthly cost ($10)".
- Effect: small sizes survive more easily. At $5 and 10 trades a day, the $10 term is about 67 bps (DERIVED).
- It is stop-only, so no money is at risk: B, R and P still decide on the conservative row with the stricter fixed cost.
- Please confirm (a) or say otherwise.

N4. ARCH:1719 (D08) says the 1-minute screen was "KILLED at $200 and $1,000".
- research/mr01-screen/RESULTS.md @ c67f37f9 registers the verdict at $200 only (line 7). $1,000 (−1.49%, CI −1.54 to −1.43) is an "Other lines" row.
- RS-40's "25 survivor-only … pools" is the group-A candidate set (RESULTS:53). Trades came from 13 pools in discovery and 15 in validation.
- Fix: say "KILLED at $200 (registered); also below zero at $1,000", and give the trading pool counts.
- Every other RS-40 number matches the source: −0.77% and −0.76%; CIs −0.79 to −0.74 and −0.79 to −0.72; 7,368 and 5,377 trades; gross +0.04 to +0.06; random entries −0.83 to −0.84; 5ebb439 is 10:46 UTC on 7 Oct, which is 9:46 PM Melbourne.

N5 (your file). MIGRATION:704, the "Coarse screens…" clash row, still recommends "Reuse data already held … Any new download needs the owner". The owner has since chosen option (b). Mark the row resolved, with a pointer to the Owner waits section and DECISIONS:112.

CHECKLIST
Round 2 findings:
- F1: DONE. C-75 kept for D30, per your ruling 10. C-76 is at SPEC-A:2561. RS-40 is at FACTS.json:5100 (pending_review) and cited in ARCH §3.2 and D08 (ARCH:1719).
- F2: DONE. The lean row decides. Precondition of R0 at SPEC-A:2010: the check refuses on prereg_mismatch, with an acceptance case. C-48 is aligned.
- F3: DONE. ARCH:1236 and ARCH:2346. SPEC-A:2338 says 5 RPS, ≤ 50% for every provider, and validation refuses a higher rate.
- F4: DONE. B-M20-04 step 5 at SPEC-B:1450; acceptance cases 4-5 at SPEC-B:1461; U-A04 updated; ARCH 8.4 row at ARCH:2187.
- F5: DONE. ARCH:945 and D30 options at ARCH:1877.
- F6: DONE. n_R defined; acceptance cases for S_low ≤ 0 and for more than 90 days. Option (c) is moot now that the owner chose (b).
- F7: DONE. Producers are named in C-49, at SPEC-A:2214-2221 and at SPEC-B B-M26-04 step 7.
- F8: DONE. Z-H's day count is in M0 (MIGRATION:823, INTEGRATION M0).
- F9: DONE. Every VF and C ID is now cited outside its own row.

Red-team findings:
- RT-01: DONE. Same evidence as F2.
- RT-02: DONE. Depth cap is 0.5% of min(real, effective), with an acceptance case.
- RT-03: DONE. A-M13-01 steps 4-5 are per size, with the PREREG verdict rules and "(subset)".
- RT-04: DONE. Rate min(2.5, 0.5); RU hard stop at 1.5M checked before each send; gSFA = 2 RU. The test case is right: 1,499,999 + 2 is refused, and the stop survives a restart. See N2.
- RT-05: DONE. B-9 from A-M11-01's 10-replay record; B-10 from Z-H; B-gate inputs in M2 through the A-M13-08 bundle path, with an acceptance case.
- RT-06: DONE. buildSha and configKey are on historyReplay and dryRun; the 48 h is one declared contiguous block inside W_P; paperLegs comes from A-M12-01's PaperLegCounter.
- RT-07: DONE. Same evidence as F4.
- RT-08: DONE. Superseded by the owner's choice of (b). The interface has source 'helius_capped_download', a cap, no waiver branch, and fails closed (see N1).
- RT-09: DONE. Same evidence as F1.
- RT-10: DONE. The boundary test is an SDK-math fixture; the on-chain result is "not verified"; no simulating as a holder.
- RT-11: DONE. Same evidence as F6.
- RT-12: DONE. ARCH:3069 says 25 cells; A-M13-01 step 1 follows the PREREG window; A-M01-02 has the first-tier and exotic → flat-fees rules, with cases.
- RT-13: DONE. MIGRATION:745 Owner waits lists B-10, D30, the holder index, the 31 Dec rule and C-76. The INTEGRATION M2 exit names the A-M06-03 wait.

Judgement calls:
- (a): see N3.
- (b): DONE (SPEC-A:2008).
- (c): DONE. DECISIONS:113 says ≤ 50% for every bucket and records the risk (see N2).
- (d): DONE.
- (e): DONE. MIGRATION:703 is resolved.
- (f): DONE. fx/pumpswap/drained_pool.json is named as a fixture to build; no file is added in this docs PR.

SCRIPTS
- FACTS.json: parses; 292 facts, no duplicate IDs. No cited ID is undefined, and every RS and VF fact is cited. C-01..C-77 are each defined once, every cited C ID exists, and none appears only in its own row.
- Ticket graph:
  - 63 A, 81 B and 32 UI tickets: 176 in all.
  - No undefined dependencies and no cycles.
  - Later-milestone dependencies: only UI-T14 → B-M17-08 and B-M29-04, the known live-acceptance-only cases.
  - Listed and table counts per milestone match: M0 24/24, M1 25/25, M2 46/46, M3 49/49, M4 27/27, Deferred 2/2. M4b shows 5 listed and 3 in the table, as before.

CONSISTENCY
- B-10 says DECIDED (b) in the same terms in ARCH 3.4, the owner items table, D04/C-54 (the one exception), C-49, INTEGRATION M0/M2, MIGRATION A06/Z-H/Owner waits and DECISIONS:112. The only stale text left is N5.
- Nothing is loosened against ARCH, the CLAUDE.md "Blueprint" and "Product" rules, or 651b1737.
- Scope: docs/blueprint/**, DECISIONS:111-113 and the listed MIGRATION lines only. No code changed.

PASS · 2dc25ffedebaf29bd86b97f6c8f2e9bfdadb800e

### Red team (0 BLOCKER, 4 MAJOR, 5 MINOR)

# Red team, round 3: card Z0D at `2dc25ffe` — FAIL (0 BLOCKER, 4 MAJOR, 5 MINOR)

Head confirmed with ls-remote: 2dc25ffedebaf29bd86b97f6c8f2e9bfdadb800e. Rulings read from docs/reviews/Z0D.md @ 71207016; owner B-10 ruling from CLAUDE.md @ 651b1737.

## Round 2 findings
All 13 are closed in the docs.
- RT-01: SPEC-A, ARCH 3.3 and C-48 agree on the lean row and the per-cell n_a/n_b rule. The PREREG @ df7d75da (branch head unchanged) still says strict, but SPEC-A now makes its amendment a precondition of R0, with a `prereg_mismatch` refusal and a test.
- RT-02 to RT-13: each fixed where the ruling put it (depth cap; per-size A-24b; Chainstack rate and RU stop; producers and M2 injection; buildSha/configKey, the declared block and `paperLegs`; B-M20-04 step 5; B-10 decided; RS-40 and C-76; SDK-only boundary test; `n_R`; stale text; owner waits).

## MAJOR

**RT3-01. B-2 and R-2 do not use the conservative row in SPEC-A, and C-77's safety argument depends on that.**
- ARCH B-2 (:450) and C-77 say passing gates decide on the conservative row with the stricter D04 fixed cost.
- SPEC-A A-M13-06 step 3 (:2232) still says only "B-2 net mean CI lower bound &gt; 0"; R-2 is the same. A-M10-03 (:1633) has no conservative or strict row at all; C-50's "ticket work: A-M10-03" was never written into the ticket.
- A builder following SPEC-A would gate on one unnamed cost row. That is looser than ARCH, and it removes the backstop that makes "the kill check decides on lean" acceptable.
- Fix:
  - A-M10-03: produce both rows and their parts.
  - A-M13-06 B-2 and R-2: name the conservative row plus the D04 fixed cost.
  - Acceptance: a strategy positive on lean and negative on the conservative row fails B-2.

**RT3-02. B-10 can pass on a partial or self-certified history report.** `historyReplay` (:2217) and step 3 (:2232):
- (a) "At least 30 clean days" does not say which field. A report with `cleanDaysHeld` = 30 and five entries in `daysUsed` passes as written. Require ≥ 30 distinct UTC days in `daysUsed`, each one clean.
- (b) "Clean" has no definition. Nothing records whether each day's history is complete: pagination truncated, or the download stopped after 3 failures, leaves a partial day counted as clean. Nothing records that the universe was chosen without survivorship bias (owner item 2 says "survivorship-free"). Add a per-day coverage record and a universe-selection field, and fail on gaps.
- (c) `daysInsideWR` and `daysInsideContaminated` are counts the report gives about itself. The evaluator should work them out from `daysUsed` against `W_R` (stage machine) and the B3 dates. Those dates (sealed holdout 2026-09-22 to 10-20, MIGRATION :448) appear nowhere in ARCH or SPEC-A, so the check cannot be measured from the spec.
- (d) `creditEstimateShownAtMs` non-null does not prove the estimate came before the spend. Add `firstCreditSpentAtMs`, require shown &lt; first spent, and point to the owner's acknowledgement record in DECISIONS.
- Stale builds: closed by the buildSha/configKey match.

**RT3-03. P-5 and P-10 can pass after failed attempts.**
- Nothing says which declared dry-run block counts, or what happens to failed ones. A builder can declare 48 h blocks until one passes. `faultInjection(buildSha)` has the same problem: several runs of one build, and any passing run is used.
- Fix: record every declared block and every fault-injection run per buildSha. P-5 and P-10 fail if any block or run for the promoted build failed, and the report lists all of them.

**RT3-04. The Chainstack RU stop can be bypassed.** A-M14-05 step 2 (:2465):
- The counter lives in the M14 gateway. ARCH :2346 makes Chainstack "signer endpoint 1", and the signer and sentinel are separate processes. Research scripts holding the same key are not covered either. Each could run its own 0.5 req/s and its own count. Two uncounted processes making 2 RU calls reach about 5.2M RU a month, which is over 3M and would be billed as overage.
- The counter is saved only every 5 minutes. A crash loop shorter than that never saves, so the count stays low.
- Nothing says whether requests that fail, time out or hit 429 are counted.
- Fix:
  - one counter and one bucket per API key, shared by every process, saved before each send (or reserved in blocks);
  - count every request sent, whatever the result;
  - a test with two processes on one key.

## MINOR

**RT3-05. C-77 calls the lean row "costs we pay", but it is a best case.** (ARCH :442)
- The PREREG lean row is a 35,000-lamport fixed cost with no sandwich, no stuck positions and no allowance for failed sends, all of which ARCH 2.1 says do happen.
- Against "No knowingly losing trades": a stop-only check deciding on the lean row cannot by itself cause a trade, because B, R and P gates follow. So the owner rule holds once RT3-01 is fixed. Until then it does not hold.
- Fix: describe the lean row as a lower bound on costs, and list the costs it leaves out.

**RT3-06. Exits sized to the full `maxSellableBase` are still refused on chain if the vault falls before landing.** (SPEC-B B-M20-04 step 5, :1450)
- A refusal on chain is probably classed `unknown`, since its error code is not verified. Three in a row mark the position cannot-sell and `stuck`.
- Fix: size with a margin (for example the slippage bound). Classify the refusal code as non-counting once it is known; until then do not count it.

**RT3-07. A-M13-01 step 4 (:1995) mixes units in its fixed term.**
- `ceil(M × 10,000 / (30 × tradesPerDay × x))` divides dollars `M` by a lamport `x`. Convert `M` at the recorded SOL/USD (A-M10-03 step 7 already works in lamports).
- Which row decides the `k` exclusion is still not stated; the PREREG uses strict fixed cost.

**RT3-08. The billing-month assumption is unsafe.** A-M14-05 says the UTC-month counter "never resets early". If Chainstack bills from the account's start date, a UTC reset can be early. Fix: reset at the later of the UTC month and the account's billing date, or keep a rolling 30-day sum.

**RT3-09. B-10 credits could be spent on a strategy that may already be dead.**
- INTEGRATION M0 puts the credit estimate to the owner in M0, before the Phase 0 kill check and before the owner rules on C-76 (RS-40: MR-01 KILLED, both CIs below zero).
- Fix: no download credit until a strategy survives Phase 0 and C-76 is ruled. Say this when the estimate goes to the owner.

## Owner-rule checks
- No pump.fun-operated hosts: clean.
- Sends at ≤ 50%: done.
- The Helius exception is limited to B-10, as the owner ruled.
- Profit in SOL: no new break.

## Totals
BLOCKER 0; MAJOR 4 (RT3-01 to RT3-04); MINOR 5 (RT3-05 to RT3-09). Round 2's RT-01 to RT-13 are closed in the docs. Head attacked: 2dc25ffedebaf29bd86b97f6c8f2e9bfdadb800e. Nothing edited or pushed; nothing sent to the owner.

### Supervisor rulings for round 4 (8 Oct 2026, about 1:10 AM)

Accept every finding: reviewer N1–N5 and red team RT3-01..RT3-09.

1. **RT3-01 (MAJOR).** A-M10-03 produces the lean row, the conservative row and the strict row, each with its parts.
   - A-M13-06 B-2 and R-2 decide on the conservative row plus the D04 fixed cost. Until the Helius question is ruled, that fixed cost is the stricter $59.
   - Add an acceptance case: a strategy that is positive on the lean row and negative on the conservative row fails B-2 and R-2.
   - Write C-50's ticket work into A-M10-03.
2. **RT3-02 + N1 (MAJOR): the B-10 report.**
   - (a) It needs ≥ 30 distinct UTC days in `daysUsed`, and every one must be clean.
   - (b) Each day carries a coverage record: pages fetched, truncation, failures, and complete true/false. The report also records how the universe was selected, from chain only (survivorship-free), and the source of that list. Any gap fails.
   - (c) The evaluator works out W_R and B3 overlap itself, from `daysUsed` against the stage machine's W_R and the B3 dates. Write the B3 dates into ARCH and SPEC-A: the sealed holdout from 2026-09-22 to 2026-10-20 (MIGRATION:448), plus any other B3 window MIGRATION lists.
   - (d) Add `firstCreditSpentAtMs`. Require `creditEstimateShownAtMs` < `firstCreditSpentAtMs`, and point to the owner's acknowledgement record in DECISIONS.
3. **RT3-03 (MAJOR).** Record every declared dry-run block and every fault-injection run for each buildSha. P-5 and P-10 fail if any block or run for the promoted build failed. The report lists all of them.
4. **RT3-04 (MAJOR) + RT3-08: Chainstack usage.**
   - One RU counter and one bucket per API key, shared by every process: worker, signer, sentinel and research.
   - The count is saved before each send. Reserving in blocks is allowed.
   - Every request sent is counted, whatever its result.
   - The cap is a rolling 31-day sum of no more than 1.5M RU, so no billing-date assumption is needed.
   - Add a test with two processes on one key, and a crash-loop test.
   - N2: record the same risk for RPC B's live role in DECISIONS, name the fallback for expiry proofs once Chainstack is stopped, and measure again before M4.
5. **RT3-05.** C-77 describes the lean row as a lower bound on costs, and lists the costs it leaves out: sandwich, stuck positions and failed sends. It states that the owner rule "No knowingly losing trades" holds because B, R and P decide on the conservative row (item 1).
6. **RT3-06.** Exit sells are sized at `maxSellableBase` minus a margin equal to the slippage bound. Once the on-chain refusal code is verified, that refusal does not count toward cannot-sell. Until then it is not counted either, and it is marked VERIFY.
7. **RT3-07.** In A-M13-01 step 4, convert M from USD to lamports at the recorded SOL/USD. State which row decides the k exclusion: the lean row, by C-77, because it is stop-only.
8. **RT3-09.** No B-10 download credit is spent until a strategy has survived Phase 0 and the owner has ruled on C-76. Say this in INTEGRATION M0 and in the card Z-H text. The estimate can still go to the owner earlier.
9. **N3.** Judgement call (a) is confirmed: A05's tests are per trade, with no monthly term. Make C-77's wording say exactly that.
10. **N4.** ARCH:1719 says "KILLED at $200 (registered); also below zero at $1,000". RS-40 gives the trading pool counts: 13 in discovery, 15 in validation, out of a candidate set of 25.
11. **N5.** Mark MIGRATION:704 resolved, pointing to Owner waits and DECISIONS:112.
