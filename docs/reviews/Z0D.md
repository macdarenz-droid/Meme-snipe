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

## Round 4 (head `17ff525b`, 8 Oct 2026)

### Fresh review (PASS, 1 MINOR)

Z0D round 4 delta review, PR #286. Head 17ff525bf0c96675f76643645a58414e28c0aa0f (confirmed by ls-remote; base 94d55a84 is in its history). Spec: docs/reviews/Z0D.md @ 60d95d22, items 1-11. Nothing edited or pushed; nothing sent to the owner.

RESULT: PASS. All 11 items are DONE, and the builder's choices (i)-(iv) are applied as you accepted them. One new MINOR wording slip, plus one note for M4.

NEW
R4-1 MINOR: one sentence still describes the old monthly stop.
- ARCH:1680 (D04) says "At the hard stop Chainstack takes no more requests that month".
- The cap is now a rolling 31-day sum: SPEC-A A-M14-05 step 2, ARCH:1236, ARCH:2346 and DECISIONS:114.
- Fix: "…until the rolling 31-day sum falls below the cap".

Note (no finding): under (iii), live entries are blocked whenever RPC B is stopped. At the full 0.5 req/s of 2-RU calls, the cap arrives at about day 17 of each rolling window (DERIVED: 1.5M ÷ 86,400 ≈ 17.4). That could block entries for about half of each window. It is fail-safe and already listed for re-measuring before M4 (DECISIONS:114). The M4 measurement should look at RPC B's real live usage, so that "Discipline, not paralysis" is not broken in practice.

ITEMS
1. RT3-01: DONE.
   - A-M10-03 step 9 (SPEC-A:1663) gives three rows with their parts in CostRows. Conservative = strict + 0.145 rent prior + dust prior, per choice (i).
   - Strict reproduces PREREG §4's 174,740 lamports (case at SPEC-A:1675). Property case: lean ≤ strict ≤ conservative.
   - B-2 and R-2 decide on the conservative row plus $59, in step 3/4 of A-M13-06 and at ARCH:450.
   - Acceptance case: positive on lean, negative on conservative → B-2 and R-2 fail (SPEC-A:2261).
2. RT3-02 + N1: DONE.
   - (a) ≥ 30 distinct clean UTC days, with a case for 30 entries on 29 days.
   - (b) Per-day coverage {pagesFetched, truncated, failures, complete}, plus universe {chain_only, survivorshipFree, listSource, listSha256}; any gap fails.
   - (c) The evaluator computes W_R overlap from A-M13-05 and B3 overlap from the fixed window 2026-09-22T00:00Z to 2026-10-21T00:00Z.
     - That window covers every B3 use MIGRATION:448 lists: the empirical backfill of 10-01 to 10-02, the 10-03 sample, PR #267's 22 Sep-2 Oct study, and 5 Oct.
     - Its end at 10-21 makes it stricter than edge.md's [09-22, 10-20).
     - The dates are in both ARCH:458 and SPEC-A step 3; there is a case for 2026-10-05.
   - (d) firstCreditSpentAtMs and ownerAckDecisionRef added; shown &lt; first spend is required, with cases.
3. RT3-03: DONE.
   - The interface returns every dry-run block and every fault-injection run per build.
   - Any failed or aborted block fails P-5; any failed run fails P-10.
   - The GateResult lists all of them (SPEC-A step 5; ARCH:470, 475; SPEC-B B-M26-04 step 7, append-only, with cases).
4. RT3-04 + RT3-08 + N2: DONE.
   - One ledger and one bucket per key across worker, signer, sentinel and research. It is one SQLite file on the host, and an off-host process uses reserved blocks or another key, per choice (ii).
   - The count is saved before each send, with blocks of ≤ 1,000 RU that count as spent if a crash leaves them unused. Every request is counted, whatever its result.
   - The cap is a rolling 31-day sum of 1.5M RU.
   - Tests cover two processes on one key, timeouts and 429s counted, and a 100-restart crash loop.
   - The RPC B risk and fallback are recorded at DECISIONS:114 and ARCH D04: Helius alone, `unknown` is never presumed expired, signer endpoint 2, entries blocked, exits continue (choice (iii)). Re-measured before M4.
5. RT3-05: DONE. C-77 (SPEC-A:2585, ARCH:442) calls the lean row a lower bound, names what it leaves out (sandwich, stuck positions, failed sends), and states that the owner rule holds because B, R and P decide first.
6. RT3-06: DONE.
   - B-M20-04 step 5 (SPEC-B:1450) sizes to maxSellableBase × (10,000 − slippageBps)/10,000. The case checks 990,000 at 100 bps.
   - An on-chain vault refusal is classed exceeds_real_vault from pool state at the failure slot, marked VERIFY, and is not counted toward cannot-sell (choice (iv)). It is added to step 6's "never counted" list, with a case.
7. RT3-07: DONE.
   - Step 4: M_lamports = ceil(M_usd ÷ solUsd × 10⁹) at D1's recorded SOL/USD.
   - The k exclusion uses the lean row in steps 5 and 9 (fixedShareBps('lean')), with strict shown beside it.
8. RT3-09: DONE. No download credit is spent until a strategy has survived Phase 0 and the owner has ruled on C-76; the estimate may go to the owner earlier. This is in INTEGRATION M0, MIGRATION card Z-H (:823), the Owner waits B-10 row (:751) and ARCH B-10.
9. N3: DONE. C-77 says the A05 tests are per trade with no monthly term; the $10, $12 and $59 lines decide nothing.
10. N4: DONE.
    - ARCH:361 and :1719 say "KILLED at $200 (registered); also below zero at $1,000 (−1.49%, not a registered verdict)", with 13 and 15 trading pools out of 25.
    - RS-40's claim and C-76 match.
    - The new cite lines RESULTS.md:22-26 and 51-53 @ c67f37f9 hold the $1,000 row and the pool counts.
11. N5: DONE. MIGRATION:704 is marked resolved, pointing to Owner waits and the DECISIONS 2026-10-08 row.

SCRIPTS
- FACTS.json: parses; 292 facts, no duplicate IDs. No cited ID is undefined; every RS and VF fact is cited. C-01..C-77 are each defined once; none is undefined or cited only in its own row.
- Ticket graph:
  - 63 A, 81 B and 32 UI tickets: 176 in all.
  - No undefined dependencies and no cycles.
  - Later-milestone dependencies: only UI-T14 → B-M17-08 and B-M29-04, the known live-acceptance-only cases.
  - Listed and table counts per milestone match: M0 24/24, M1 25/25, M2 46/46, M3 49/49, M4 27/27, Deferred 2/2. M4b shows 5 listed and 3 in the table, as before.

CONSISTENCY AND SCOPE
- Every change tightens or adds a check; nothing is loosened against ARCH, CLAUDE.md "Blueprint"/"Product" or 651b1737.
- ARCH, SPEC-A, SPEC-B, INTEGRATION, MIGRATION and DECISIONS agree, apart from R4-1.
- The diff touches docs/blueprint/**, DECISIONS:113-114 and the listed MIGRATION lines only. No code changed.

PASS · 17ff525bf0c96675f76643645a58414e28c0aa0f

### Red team (0 BLOCKER, 5 MAJOR, 2 MINOR)

# Red team, round 4: card Z0D at `17ff525b` — FAIL (0 BLOCKER, 5 MAJOR, 2 MINOR)

Head confirmed with ls-remote: 17ff525bf0c96675f76643645a58414e28c0aa0f. Rulings read from docs/reviews/Z0D.md @ 60d95d22.

## Round 3 findings
- **Closed:** RT3-05 (C-77 wording), RT3-07 (lamports conversion; lean row decides `k`), RT3-08 for Chainstack (the rolling 31-day sum ≤ 1.5M means no 31-day billing month can exceed it), RT3-09 (no download credit before Phase 0 and the C-76 ruling).
- **Partly closed:**
  - RT3-01: closed for B-2 and R-2; other gates are still open (R4-01).
  - RT3-02: closed in the evaluator; the spend cap is still open (R4-02, R4-06).
  - RT3-03: closed within one build; a new build bypasses it (R4-04).
  - RT3-04: closed on the host; other keys and off-host use are still open (R4-03).
  - RT3-06: the margin and the classification have new holes (R4-05).

## MAJOR

**R4-01. Gates other than B-2 and R-2 still have no cost row.**
- C-77 and ARCH 3.4 say a gate that passes a strategy decides on the conservative row. SPEC-A :2247 applies it only to B-2 and R-2.
- These name no row: B-6 (t ≥ 3), B-8 (positive mean in the final 20% and in every week), R-3 (≥ 50% of the W_B estimate), R-4 (point estimate &gt; 0 under stress), P-2 and P-3.
- A builder can compute them on the lean row or the default model, which is looser than ARCH.
- Fix: one rule in A-M13-06: every return-based B, R and P gate uses the conservative row plus the D04 fixed cost. Add one acceptance case for B-8 and one for R-4.

**R4-02. The owner's Helius cap for B-10 is not enforced before spending, and the report states its own cap.**
- A-M14-05 has a hard stop only for Chainstack. Helius counters are saved every 5 minutes, assume the UTC month, and only alert at 80% (`rpc.burn.alert_bps`). A looping paginated download, or a crash loop, could overspend before any check runs. The live bot shares the owner's Developer key (DECISIONS O7 row).
- The B-10 evaluator compares `creditsSpent` with `creditCap`, and both come from the report. Nothing ties `creditCap` to the cap the owner acknowledged.
- Fix:
  - a Helius credit ledger like Chainstack's: saved before each send, every request counted, hard stop at the owner-acknowledged cap for the B-10 job;
  - the evaluator reads the cap and the acknowledgement date from the DECISIONS row named by `ownerAckDecisionRef`, not from the report.

**R4-03. The Chainstack ledger can be bypassed with a second key or from off the host.**
- SPEC-A :2483 says a process on another machine either uses a block reserved in the host ledger "or it uses a different key".
- Chainstack's 3M RU appears to be a limit for the whole plan, not each key. I am not certain; worth checking in Chainstack's limits page. If so, a second key has its own ledger and can push the account into billed overage.
- How an off-host process reserves a block is not defined. The host has no open inbound ports (Tailscale only).
- Fix:
  - one ledger per Chainstack account, not per key;
  - research off the host uses a different provider, or a reservation path that is spelled out;
  - verify per-key versus per-account against the docs (VF-10) before M1.

**R4-04. A new buildSha resets the P-5 and P-10 failure history.**
- "Every block or run for the promoted build" is keyed by buildSha. A trivial rebuild (a comment, a version bump) gets a new sha with a clean history. A flaky failure-injection case or a failed dry-run block simply disappears.
- Fix:
  - keep every block and run per `configKey` across all builds, and list them all in the `GateResult`;
  - a failure on an earlier build passes only if the promoted build contains a recorded fix commit that names the failure;
  - a failure-injection case that failed on an earlier build must pass 3 runs in a row on the promoted build.

**R4-05. The exit margin is not safe, and the refusal classification can retry forever.** (SPEC-B :1450)
- The margin is taken on base units: `maxSellableBase × (1 − slippage)`. Output is concave in input, so cutting base by s% cuts quote output by **less** than s%. The guard on the vault is in output terms.
  - Fix: size the base so that `out(base) − lp ≤ (real vault) × (1 − slippage)`.
- A sell is classed `exceeds_real_vault` (non-counting) from "pool state at the failure slot". That state can include later transactions in the slot. The order against `token_program_refusal` is not stated.
  - In a drained pool, where rugs happen, a real token-level refusal could be classed as a vault refusal every time. The position would never become `stuck`, and exits would retry forever, paying fees and tips on each try.
  - Fix:
    - check `token_program_refusal` first;
    - class `exceeds_real_vault` only when the failing instruction is the PumpSwap sell itself;
    - after N consecutive refusals of this kind (say 5), raise a critical alert and pause automatic re-sends until the vault reads above the margined output;
    - count the fees spent on refused sells in the stuck-cost line.

## MINOR

**R4-06. B-10 fields that state themselves cannot be checked.**
- `universe.survivorshipFree`, `coverage.complete/truncated/failures`, and `crashes`, `illegalStates` and `unreconciledIntents` are all values the report asserts.
- Fix:
  - take crash, illegal-state and intent counts from the engine's own run record (the same producer as B-9);
  - check `listSha256` against a list written by the download job before the replay;
  - keep the download job's per-page log, with hashes, as the coverage evidence.

**R4-07. The shared ledger file crosses the signer's security boundary.** (SPEC-A :2483)
- `/data/rpc-usage.db` is written by the worker, the signer and the sentinel. ARCH keeps the signer under a separate user with root-owned files.
- A compromised engine can fill the ledger and cut off the signer's Chainstack endpoint. The signer still has endpoint 2, so the impact is small. But the file must be writable across users, which weakens the separation.
- Fix: the signer gets its own reserved block, written by a privileged allocator, or uses a provider that is not counted against the engine; state the file permissions.

## Totals
BLOCKER 0; MAJOR 5 (R4-01 to R4-05); MINOR 2 (R4-06, R4-07). Head attacked: 17ff525bf0c96675f76643645a58414e28c0aa0f. Nothing edited or pushed; nothing sent to the owner.

### Supervisor rulings for round 5 (8 Oct 2026, about 1:15 AM)

Accept every finding: reviewer R4-1 and red team R4-01..R4-07.

1. **R4-01.** A-M13-06 gets one rule: every return-based B, R and P gate (B-2, B-6, B-8, R-2, R-3, R-4, P-2, P-3 and any other return-based one) decides on the conservative row plus the D04 fixed cost. Add acceptance cases for B-8 and R-4.
2. **R4-02.**
   - A Helius credit ledger like Chainstack's: saved before each send, every request counted whatever the result.
   - The B-10 download job has a hard stop at the owner-acknowledged cap.
   - The evaluator reads the cap and the acknowledgement date from the DECISIONS row named by `ownerAckDecisionRef`, never from the report.
   - The live bot's Helius use is counted in the same ledger, so the job can never push the account past the plan.
3. **R4-03.**
   - One Chainstack ledger per account, not per key.
   - Off-host research never uses Chainstack; it uses a different provider under its own ≤ 50% limiter.
   - Mark VERIFY that the 3M RU limit is per account or per key (VF-10). Confirm it from Chainstack's limits page before M1.
4. **R4-04.**
   - Dry-run blocks and fault-injection runs are kept per `configKey` across all builds and listed in the `GateResult`.
   - A failure on an earlier build counts as cleared only if the promoted build holds a recorded fix commit that names the failure.
   - A fault-injection case that failed before must then pass 3 runs in a row on the promoted build.
   - A dry-run block that failed before needs a fresh full 48 h block on the promoted build, which is already required.
5. **R4-05.**
   - Size the exit in output terms: out(base) − lp ≤ realVault × (10,000 − slippageBps)/10,000.
   - Check `token_program_refusal` first. Class a failure `exceeds_real_vault` only when the failing instruction is the PumpSwap sell itself.
   - After 5 such refusals in a row: raise a critical alert, and pause automatic re-sends until the vault reads above the margined output.
   - The fees and tips spent on refused sells count in the stuck-cost line.
   - Add acceptance cases.
6. **R4-06.**
   - Crash, illegal-state and unreconciled-intent counts come from the engine's own run record, the same producer as B-9.
   - `listSha256` is checked against the list file the download job writes before the replay.
   - The download job's per-page log, with page hashes, is the coverage evidence.
7. **R4-07.**
   - The signer never writes the engine's ledger.
   - It gets its own fixed reserved Chainstack block from a root-owned allocator at boot, and the engine cannot consume that block.
   - State the owner and mode of each file.
8. **R4-1.** D04 (ARCH:1680) says "…until the rolling 31-day sum falls below the cap".

Also merge `origin/ccr-14987baf-i6lrsl` (now `d901c5c1`) with a merge commit before pushing.

## Rounds 5 and 6 (head `53ab0d64`, 8 Oct 2026)

Round 6 (supervisor message to the builder): per-account caps split into fixed allocations; the Helius account cap defaults to 5M per rolling 31 days; B10-ACK may set acctCap up to 9.5M inside its window; the job may run off the host.

### Fresh review (FAIL on R6-1 only)

Z0D rounds 5 and 6 delta review, PR #286. Head 53ab0d6465ac172e332351e3d89cd8c1e38e61f4 (confirmed by ls-remote; base d901c5c1 merged with a merge commit, and research/verify-m0-m1/RESULTS.md is identical to the base). Spec: docs/reviews/Z0D.md @ 88c62219 for round 5 (items 1-8), plus your round 6 message. Nothing edited or pushed; nothing sent to the owner.

RESULT: FAIL, on one item only. You asked me to check that the risk of choice (b) is recorded, and it is not. Everything else in rounds 5 and 6 is DONE. The fix is one or two lines; nothing else needs a further round.

NEW FINDINGS
R6-1 MAJOR (your check on choice (b)): the risk of a 31-day engine Helius outage is not recorded.
- The behaviour is specified in SPEC-A A-M14-05 step 2 and the case at SPEC-A:2507: engine allocation = max(0, 5M − 50k − the job's credits still inside the rolling 31 days). After an 8.6M job, the engine's Helius allocation is therefore 0 for up to 31 days after the window.
- No risk line says so. DECISIONS:114 and ARCH D04 say only "the engine (the rest, shrinking during the job window)".
- What the engine loses during that time:
  - Helius as RPC C: P0/P1 failover, and the single expiry-proof provider while Chainstack is stopped (ARCH D04);
  - getPriorityFeeEstimate (ARCH:1285, D15), which falls back to the floor.
- It is fail-safe: entries are blocked if both RPC B and RPC C are out. It also lands in M2, before any live trading, unless the job is late.
- Fix: one risk sentence in DECISIONS:114 and ARCH D04: "after the job window the engine's Helius allocation can be 0 for up to 31 days; meanwhile RPC C failover, Helius expiry proofs and fee estimates are unavailable to the engine (fee estimates use the floor); the job is scheduled so this ends before any M4 live step, and this is measured again before M4."

R6-2 MINOR: MIGRATION's Owner waits B-10 row (:751) and card Z-H (:823) do not name the B10-ACK row the owner's acknowledgement must produce. Its format is `B10-ACK cap= ackAt= from= to= [acctCap≤9.5M]` (SPEC-A A-M13-06 step 3). Until that row exists, the job's allocation is 0. Fix: add the row name and its format to both places, so the owner step is exact.

Note (no finding): acctCap up to 9.5M is 95% of the plan's volume. That is above the 50% default, but it applies only inside the window and only by the owner's own B10-ACK row. This matches CLAUDE.md "History for the past-data test" (the cap the owner has seen). The ≤ 50% rate buckets are unchanged.

ROUND 5 ITEMS
1. R4-01: DONE. A-M13-06 step 1 sets one rule: every return-based gate (B-2, B-6, B-8, R-2, R-3, R-4, P-2, P-2b, P-3, others) decides on the conservative row plus the D04 fixed cost. Cases for B-8 and R-4 at SPEC-A:2268.
2. R4-02: DONE.
   - Helius is counted per account with a ledger saved before each send, and every request is counted.
   - The B-10 job has its own allocation and hard stop.
   - The evaluator reads cap, ackAt and the window from the DECISIONS row at a commit, checked against that commit's blob hash, never from the report. There is a case for a report that claims a larger cap.
   - Engine use is in the same account allocation scheme.
3. R4-03: DONE. One Chainstack ledger per account; off-host research never uses Chainstack; per-account vs per-key allowance marked VERIFY before M1 (D04, A-M14-05). There is a case for two keys on one account.
4. R4-04: DONE.
   - Blocks and runs are kept per configKey across builds.
   - fixes[] entries are tied to the promoted build by ancestry.
   - A previously failed fault case needs 3 passing runs in a row; a failed dry-run block needs a fix plus a fresh 48 h block.
   - Covered in ARCH P-5/P-10 (:470, :475), SPEC-A step 5 with cases at :2277, and SPEC-B B-M26-04 step 7 with cases.
5. R4-05: DONE (SPEC-B:1450-1453 with cases 4, 6, 7 and 8).
   - Sizing is in output terms: out(b) − lpFee(b) ≤ realVault × (10,000 − slippageBps)/10,000.
   - token_program_refusal is checked first; exceeds_real_vault applies only when the failing instruction is the PumpSwap sell.
   - After 5 refusals in a row: a critical alert and paused re-sends.
   - Fees spent on refused sells are booked in stuck_cost.
6. R4-06: DONE. Crash, illegal-state and unreconciled-intent counts come from replayRunId (the A-M11-01 run record). listSha256 is checked against listFile, which must be written before the replay. Coverage is recomputed from pageLog. Each has a case.
7. R4-07: DONE.
   - The signer never writes the engine ledger and draws on its own block from root-owned /etc/bot/rpc-allocation.json (0644).
   - File owners and modes: engine /data/rpc-usage.db bot:sentinel 0660; signer /var/lib/signer/rpc-usage.json signer 0600; job /data/b10-usage.db bot 0600.
   - There is a case for the engine trying to write the signer's file.
8. R4-1: DONE. D04 says "until the rolling 31-day sum falls below the cap".

ROUND 6 ITEMS
- Fixed allocations per account cap, each with its own ledger: DONE. Helius: signer 50k (POLICY, VERIFY before M4), the job, and the engine; Chainstack: signer 50k RU and the engine. Allocations that add up to more than the cap refuse at start with E_ALLOCATION_EXCEEDS_CAP (case included).
- B-10 job allocation 0 until a B10-ACK row exists: DONE (case: first request refused before it is sent).
- Helius account cap 5M per rolling 31 days by default: DONE (A-M14-05; config rpc.helius.rolling_31d_credit_cap).
- acctCap up to 9.5M only inside the window: DONE (case: 9.5M − 50k − 8.6M = 850k inside the window).
- The job runs on or off the host under its own ledger: DONE (A-M14-05; the job uses the M14 ledger code).
- (a) from= and to= in B10-ACK: DONE (A-M13-06 step 3).
- (b) Job credits stay in the rolling sum, so the engine allocation can be 0: behaviour DONE; risk record MISSING (R6-1).
- (c) acctCap above 9.5M refused: DONE (case: 9.6M refused, default applies).

SCRIPTS
- FACTS.json: parses; 292 facts, no duplicate IDs. No cited ID is undefined; every RS and VF fact is cited. C-01..C-77 are each defined once; none is undefined or cited only in its own row.
- Ticket graph:
  - 63 A, 81 B and 32 UI tickets: 176 in all.
  - No undefined dependencies and no cycles.
  - Later-milestone dependencies: only UI-T14 → B-M17-08 and B-M29-04, the known live-acceptance-only cases.
  - Listed and table counts per milestone match: M0 24/24, M1 25/25, M2 46/46, M3 49/49, M4 27/27, Deferred 2/2. M4b shows 5 listed and 3 in the table, as before.

CONSISTENCY AND SCOPE
- ARCH D04, the 11.1 tables, SPEC-A A-M14-01/02/05 and A-M13-06, SPEC-B B-M20-04 and B-M26-04, MIGRATION:703 and DECISIONS:113-114 agree on per-account ledgers, signer blocks, allocations and caps.
- Nothing is loosened; every change tightens or is owner-gated (acctCap).
- The diff touches docs/blueprint/**, DECISIONS:113-114 and MIGRATION:703, plus the base merge. No code changed.

FAIL · 53ab0d6465ac172e332351e3d89cd8c1e38e61f4 (only R6-1 blocks; with that risk line added, this round passes)

### Red team (0 BLOCKER, 5 MAJOR, 3 MINOR)

# Red team, rounds 5 and 6: card Z0D at `53ab0d64` — FAIL (0 BLOCKER, 5 MAJOR, 3 MINOR)

Head confirmed with ls-remote: 53ab0d6465ac172e332351e3d89cd8c1e38e61f4. Rulings read from docs/reviews/Z0D.md @ 88c62219, plus the round 6 rows in ARCH, SPEC-A A-M14-05 and DECISIONS.

## Round 4 findings
- **Closed:** R4-01 (A-M13-06 step 1: every return-based gate, P included, on the conservative row plus $59; cases for B-8 and R-4), R4-03 (one ledger per account, VERIFY before M1; off-host research never uses Chainstack), R4-06, R4-07.
- **Closed, with residuals:**
  - R4-02: new holes in the allocation scheme (R5-01 to R5-04).
  - R4-04: fix records are weak (R5-07).
  - R4-05: sizing and classification order are now correct, but a drained pool can be held forever (R5-05).
- **Exit sizing checked.**
  - Correct direction. The SDK refuses when vault &lt; out − lp, and the constraint `out(b) − lpFee(b) ≤ V × (1 − s)` stays inside that.
  - Protocol and creator fees also leave the vault, which is why the rule uses out − lp. That is right.
  - The concavity argument for b ≤ 0.99 × maxSellableBase holds.
  - The classification order is safe: token_program_refusal first; the PumpSwap sell instruction only; the snapshot at or before the failure slot.

## MAJOR

**R5-01. A change of Helius cap at the window edge lets the account go over the plan.** (A-M14-05 allocations; D04)
- Each allocation's ledger enforces only its own rolling sum. The engine's allocation shrinks when the B-10 window opens, but credits the engine has already spent are not taken off the job's allocation.
- Example with the stated values:
  - The engine spends up to 4.95M in the 31 days before `from`.
  - The window opens with acctCap 9.5M, and the job spends its 8.6M cap in the first days.
  - One rolling 31-day window then holds about 13.55M, over Developer's 10M.
- Whether Helius bills overage or only throttles is not in the register; worth checking. Either way, "≤ the plan, no overage" is broken. The "allocations ≤ cap at start" check compares allocations, not amounts already spent.
- The reverse also hurts. After `to` the cap falls back to 5M while the job's 8.6M is still inside the rolling sum. The engine's allocation is then max(0, …) = 0 for up to 31 days: a Helius blackout for priority fees, failover and expiry proofs.
- Fix:
  - one account-level rolling ledger as well, checked before every send by every allocation;
  - the job's usable cap = min(row cap, acctCap − signer − the engine's actual rolling spend at window start);
  - state the blackout after the window and its effect (RPC C failover), or size the window so the engine keeps a floor.

**R5-02. The job's ledger can be duplicated or lost.**
- Two runs at once (on and off the host, or two off-host restarts) each open "its own ledger", so the allocation is spent twice.
- An off-host ledger that is lost restarts at 0 and can spend the whole allocation again.
- The engine's formula subtracts "the job's credits still inside the rolling 31-day sum", but the host cannot see an off-host ledger. That number is undefined.
- Fix:
  - one consumption ledger per `B10-ACK` id, holding an exclusive lease;
  - a second instance refuses to start;
  - the ledger is checkpointed off the job machine;
  - a missing or unreadable ledger counts as the full allocation spent;
  - until the job reports its final total, the host assumes the job has spent its full cap.

**R5-03. Where the B10-ACK row comes from, and whether it can change, is not pinned for spending.**
- The evaluator pins `&lt;commitSha&gt;:&lt;id&gt;` with a blob hash, but only after the fact.
- The job's runtime allocation is "0 until an owner B10-ACK row exists in DECISIONS.md". It is not said which checkout or commit is read, or whether the commit must be on main.
- Agents write DECISIONS.md, so an agent-written row (or a later edit to `cap`, `acctCap` or `to`) can enable or raise spending. A row on an unmerged branch also counts.
- Fix:
  - B10-ACK rows are append-only, with an immutable id; any change is a new id;
  - the row must be on origin/main and quote the owner's message and time word for word;
  - the job pins the ack id, commit and blob hash at start, and stops if any of them changes;
  - the evaluator requires the same pinned ack.

**R5-04. Rate limits are not split between processes.** Owner rule: ≤ 50% of documented limits.
- Credits are split into allocations, but request rates are not.
- The engine (≤ 5 req/s), the signer and the B-10 job (off host, "its own ≤ 50% limiter") all hit the same Helius account. Each one at 50% puts the total above 50% of the documented rate.
- Fix: split the account's 50% rate budget between engine, signer and job in `/etc/bot/rpc-allocation.json`, the same way as credits. Every limiter reads its share from there.

**R5-05. A drained position can stay open forever.** (SPEC-B B-M20-04 step 5)
- If the real vault stays below the margined output, or the margined size is 0, re-sends pause "until a snapshot reads the vault above". `exceeds_real_vault` never counts toward cannot-sell.
- A pool drained for good (the usual end of a rug) therefore leaves a position that is never `stuck`, never written off and never closed.
- It keeps holding MAXOPEN and exposure, which can block every new entry. Its loss is never booked in SOL.
- Fix: after the 5-refusal pause plus a time limit T (for example the strategy's time stop), or with the margined size at 0 for T, mark it cannot-sell and `stuck`. Value it at the most the vault can pay (often 0), book the loss, and free the slot.

## MINOR

**R5-06. The Helius plan is contradictory.** A-M14-01 defaults still say "Helius Free (1M credits/month…)". A-M14-05 caps Helius at 5M as "50% of Developer's 10M", and validation refuses any cap above 50% of the documented allowance. A builder following A-M14-01 gets a refusal or the wrong plan. Fix: one plan in both places (Developer, the key the bot shares per DECISIONS O7).

**R5-07. Fix records and the configKey history are weak.**
- An operator can add `{ failureId, fixCommitSha }` for any ancestor commit. Nothing checks that the commit is later than the failure, cites the failureId, or was reviewed.
- Failures are kept per configKey. A new configKey restarts B and R, so the cost of dodging is high. But fault-injection failures are engine bugs, not config bugs.
- Fix:
  - require the fix commit to be after the failure, to name the failureId in its message, and to be merged to main through review;
  - keep the P-10 history by build lineage, across configKeys.
- Test 6 asserts b ≤ ⌊0.99 × maxSellableBase⌋. Because lp is rounded up and out is rounded down, this can miss by 1 unit; allow ±1.

**R5-08. Window and storage details are missing.**
- `from` and `to` are UTC dates, but it is not said whether each end is included. The window has no maximum length, so a long window keeps acctCap at 9.5M for months.
- The job may need 95–255 GB off the host, and nothing says this costs $0 (owner rule: no new spend).
- Fix: [from, to) in UTC, a maximum length (for example 14 days), and the named $0 storage location.

## Totals
BLOCKER 0; MAJOR 5 (R5-01 to R5-05); MINOR 3 (R5-06 to R5-08). R5-01 becomes a BLOCKER if Helius bills overage automatically on Developer. Head attacked: 53ab0d6465ac172e332351e3d89cd8c1e38e61f4. Nothing edited or pushed; nothing sent to the owner.

### Supervisor rulings for round 7 (8 Oct 2026, about 1:30 AM)

Round 6's allocation scheme is too easy to get wrong, so round 7 makes it simpler. Accept the reviewer's R6-1 and R6-2 and the red team's R5-01..R5-08, with these rulings.

1. **The B-10 job runs alone on Helius (R5-01, R5-02, R5-04, R6-1).** During the job window [from, to), in UTC:
   - The engine and the signer use no Helius at all. Their Helius allocation is 0, and they run on Shyft and Chainstack.
   - The window is allowed only while no live or paper session depends on Helius. In practice that means M2, before any M3 paper session.
   - Before the job starts, a check reads the account's rolling 31-day Helius spend from the single account-level ledger. Every consumer checks that same ledger before every send. The job's usable cap is min(row cap, acctCap − that rolling spend).
   - The account's 50% rate budget is split in `/etc/bot/rpc-allocation.json`, the same way as credits. During the window the job holds the whole Helius rate share; outside it, the job holds none.
   - After the window, the engine's Helius allocation can be 0 for up to 31 days. Record that risk in DECISIONS:114 and in ARCH D04, in the reviewer's words (R6-1): RPC C failover, Helius expiry proofs and fee estimates are unavailable to the engine, and fees fall back to the floor. Also record that the job is scheduled so this ends before any M3 paper or M4 live step, and that this is measured again before M4.
2. **One job instance (R5-02).**
   - There is one consumption ledger per B10-ACK id, holding an exclusive lease. A second instance refuses to start.
   - The ledger is checkpointed off the job machine after every page. A missing or unreadable ledger counts as the full allocation spent.
   - Until the job reports its final total, the host assumes the full cap has been spent.
3. **The B10-ACK row (R5-03, R6-2).**
   - Rows are append-only, with an immutable id. Any change is a new id.
   - The row must be on `origin/ccr-14987baf-i6lrsl`, the integration branch, and must quote the owner's message and time word for word. The supervisor writes it only from an owner message.
   - The job pins the ack id, the commit and the blob hash at start, and stops if any of them changes. The evaluator requires the same pinned ack.
   - Name the row and its format (`B10-ACK id= cap= acctCap≤9.5M ackAt= from= to=`) in MIGRATION's Owner waits row for B-10 (:751) and in card Z-H (:823).
   - The window [from, to) is in UTC, with a maximum length of 14 days.
4. **Drained positions (R5-05).** If a position stays in the 5-refusal pause for longer than the strategy's time stop T, or if its margined size is 0 for longer than T:
   - mark it cannot-sell and `stuck`;
   - value it at the most the vault can pay (often 0);
   - book the loss in SOL;
   - free its MAXOPEN slot;
   - raise a critical alert.

   Add a case for this.
5. **R5-06.** One Helius plan everywhere: the Developer plan. The bot shares the key under DECISIONS O7. Fix the A-M14-01 defaults to match.
6. **R5-07.**
   - A fix record needs a fix commit that comes after the failure, names the failureId in its message, and was merged to the integration branch through review.
   - P-10's failure history is kept per build lineage, across configKeys.
   - Test 6 allows ±1 base unit.
7. **R5-08.** The storage for the job must be named as a $0 location. That is a precondition from the Z-H research (docs/reviews/ZH.md item 3) and a hard precondition before any spend.

Before pushing, read the whole allocation and B-10 text once more with one question in mind: "how could this spend more than the owner acknowledged, or more than the plan?" Fix anything you find, and list it in your reply.

## Round 7 (head `281dc041`, 8 Oct 2026)

### Fresh review (FAIL on R7-1)

Z0D round 7 delta review, PR #286. Head 281dc0414aa82ef2d563ea27faf9f439709c015b (confirmed by ls-remote; base d901c5c1 is in its history). Spec: docs/reviews/Z0D.md @ d19cbb90, rulings for round 7, items 1-7, plus your conditions on choices (a)-(c). Nothing edited or pushed; nothing sent to the owner.

RESULT: FAIL, on the condition you set for choice (a). It is not written down. One more item is only partly done. The rest is DONE.

NEW FINDINGS
R7-1 MAJOR (your condition on (a)): the precondition for `botctl b10-reserve` is not written down.
- SPEC-A:2494 (A-M14-05) says only "the operator reserves on the host (a new `botctl b10-reserve &lt;ackId&gt;` subcommand, over the tailnet)".
- No document says this needs either (i) the owner to run it on the host, or (ii) a tailnet path for the job machine that the owner sets up. Nor does any document make that a precondition before any spend.
- This matters because the same section runs the job on GitHub-hosted runners (docs/reviews/ZH.md round 2 item 3). A runner reaches the tailnet only with a Tailscale auth key or OAuth client, which is an owner-only secret (AGENTS "Only the owner").
- The precondition is missing from: A-M14-05's storage-precondition bullet, ARCH D04, DECISIONS:114, MIGRATION Owner waits B-10 (:751) and card Z-H (:823).
- Fix: in each of those places add "Reservation precondition (before any credit): either the owner runs `botctl b10-reserve` on the host, or the owner sets up a tailnet path for the job machine; until one exists the job refuses to start."
- Also add a case: "given no reservation record (reserve not run), the job refuses to start". The existing case refuses only without a pinned row.

R7-2 MINOR (item 5, PARTIAL): "Helius Free" is still named as the bot's plan in ARCH.
- ARCH:1234: the M14 provider table row "Helius Free | 10 req/s, sendTransaction 1/s, 1M credits/month".
- ARCH:1657: the D02 default, "Sender endpoint with the Helius Free key".
- These now contradict "Helius Developer everywhere", ARCH 11.1 RPC C (:2347) and A-M14-01 (SPEC-A:2363).
- Fix: change both to Helius Developer, the owner's key under O7: 10M credits a month, 50 req/s, sendTransaction 5/s [LD-27], with the bot's 5M rolling cap.
- The other "Helius Free" mentions are fine as they are: the D04 option list (:1674), the worst-case budget derivations (:976, :993, :1667-1668), and VF-11's documented gPA fact (:1879, SPEC-A:772). Those are historical or conservative.

ITEMS
1. B-10 job alone on Helius: DONE (SPEC-A A-M14-05 step 2 bullets; ARCH D04; DECISIONS:114).
   - One account-level ledger is checked before every send.
   - During [from, to) the engine and the signer are at 0 credits and 0 req/s and run on Shyft and Chainstack.
   - A window opens only with no paper or live session; the job refuses to start if the mode is paper or above.
   - U = min(row cap, acctCap − S), with S read from the account ledger.
   - Rate shares are in /etc/bot/rpc-allocation.json: the job holds ≤ 25 req/s inside the window and 0 outside.
   - The post-window risk is recorded in the reviewer's words in DECISIONS:114 and ARCH D04, including "ends before any M3 paper or M4 live step" and "measured again before M4".
   - Cases cover U = 8.3M, S = 9.6M refused, and an engine request refused inside the window.
2. One job instance: DONE. One ledger per ack id under an exclusive lease, with a second-instance refusal; a checkpoint off the machine after every page; a missing ledger counts as the whole U spent. The host counts all of U for 31 days whatever the job reports, which is stricter than "until the final total". Cases included.
3. The B10-ACK row: DONE.
   - Append-only with an immutable id, on origin/ccr-14987baf-i6lrsl, quoting the owner word for word, written by the supervisor only from an owner message.
   - Id, commit and blob are pinned by the job, which stops on a change; the evaluator requires the same pin.
   - The format `B10-ACK id= cap= acctCap≤9.5M ackAt= from= to=` is named at MIGRATION:751 and :823.
   - [from, to) is in UTC, at most 14 days.
   - Cases are in A-M13-06 and A-M14-05.
4. Drained positions: DONE (SPEC-B B-M20-04 step 5 "Drained for good", case 9). After more than T in the pause, or at margined size 0: stuck, valued at what the vault pays, loss booked in SOL, MAXOPEN slot freed, critical alert.
5. Helius Developer everywhere: PARTIAL. A-M14-01 (SPEC-A:2363) and ARCH 11.1 RPC C are fixed; ARCH:1234 and :1657 are not (R7-2).
6. R5-07: DONE.
   - A fix record is valid only if it is not in the failing build, names the failureId, was merged to the integration branch through a reviewed PR, and is in the promoted build.
   - P-10 history is kept per build lineage across configKeys (SPEC-A step 5; SPEC-B B-M26-04).
   - Test 6 allows ±1.
   - Cases included.
7. $0 storage: DONE. "A named $0 location, decided by the owner (DATA-PUB and DATA-STORE), before any credit" is in A-M14-05, D04, DECISIONS:114, and MIGRATION :751 and :823.

BUILDER SELF-CHECK FIXES
- Reservation only at or after `from`: DONE.
- All of U counted for 31 days: DONE.
- Only one active window: DONE.
Each has a case in A-M14-05.

CHOICES
- (a) b10-reserve over the tailnet: written in the spec, but your condition is MISSING (R7-1).
- (b) Rate shares outside the window: DONE (the job has 0 req/s outside; engine 5 req/s, signer 2 req/s, and shares over 25 req/s refuse).
- (c) acctCap required: DONE (acctCap is mandatory in the row format at A-M13-06 step 3, MIGRATION and DECISIONS).

SCRIPTS
- FACTS.json: parses; 292 facts, no duplicate IDs. No cited ID is undefined; every RS and VF fact is cited. C-01..C-77 are each defined once; none is undefined or cited only in its own row.
- Ticket graph:
  - 63 A, 81 B and 32 UI tickets: 176 in all.
  - No undefined dependencies and no cycles.
  - Later-milestone dependencies: only UI-T14 → B-M17-08 and B-M29-04, the known live-acceptance-only cases.
  - Listed and table counts per milestone match: M0 24/24, M1 25/25, M2 46/46, M3 49/49, M4 27/27, Deferred 2/2. M4b shows 5 listed and 3 in the table, as before.

SPEND CHECK ("how could this spend more than the owner acknowledged, or more than the plan?")
- Every path I traced is bounded.
- The job is capped by U, which is reserved on the host and counted in full for 31 days.
- The engine and the signer are at 0 inside the window; the account cap is 9.5M at most; the job stops at `to`; one window at a time; one instance per ack.
- The only open gap is R7-1: how the off-host job reaches the host to reserve is undefined. That fails safe, because the job refuses to start without a reservation record, but it is not written down as an owner precondition.

SCOPE
- docs/blueprint/**, DECISIONS:114, and MIGRATION:751 and :823. No code changed.

FAIL · 281dc0414aa82ef2d563ea27faf9f439709c015b (R7-1 blocks; R7-2 is minor; with both fixed, this round passes)

### Red team (0 BLOCKER, 4 MAJOR, 4 MINOR)

# Red team, round 7: card Z0D at `281dc041` — FAIL (0 BLOCKER, 4 MAJOR, 4 MINOR)

Head confirmed with ls-remote: 281dc0414aa82ef2d563ea27faf9f439709c015b. Rulings read from docs/reviews/Z0D.md @ d19cbb90.

## Round 5 findings
- **Closed:**
  - R5-01: the overage arithmetic works now. U = min(cap, acctCap − S) is reserved in full, and every consumer checks the account ledger. So any rolling 31-day window that contains the reservation is ≤ acctCap, and any later window is ≤ 5M. A billing month (≤ 31 days) sits inside one of those windows.
  - R5-03, R5-04, R5-06, R5-08 (as a precondition).
  - R5-07, apart from a residual (R7-06).
- **Partly closed:**
  - R5-02: closed in principle, but where the lease and checkpoint live is not defined (R7-04).
  - R5-05: write-off added, but its accounting is inconsistent (R7-03).

## MAJOR

**R7-01. The account ledger sees only the bot's own Helius use, but the account is the owner's.**
- DECISIONS O7 and D04 say the bot shares the owner's Developer key and plan. Anything else on that account (the owner's other apps, the stopped Zeroed worker if it is restarted, tools) never appears in S.
- So U = min(cap, acctCap − S) can be too large, and the account can pass 10M (overage, or throttling) even though every bot ledger is right.
- Fix:
  - before reserving, read the account's real usage from Helius (dashboard or usage endpoint; whether an API exists is VERIFY) and take S = max(ledger, Helius-reported);
  - or have the owner confirm in the B10-ACK row that nothing else uses the account during the window and the 31 days before it;
  - simplest: a separate Helius key or account for the bot is out (new spend), so keep the confirmation.

**R7-02. Paper and live sessions are blocked only when the job starts, not during the window or after it.**
- A-M14-05: "the job refuses to start if the engine's system mode is paper or above". Nothing stops M26 from switching to paper after the job has started.
- Nothing stops M26 during the up-to-31-day blackout after the window either ("scheduled so", not enforced).
- A paper session in that state runs with no Helius: fee estimates fall to the floor (D15), and there is no RPC C failover.
- Paper fills' modelled priority fees then come out too low, so P-2, P-3 and P-6 are judged on costs below real ones. That is a looser gate.
- Fix:
  - M26 refuses any change to paper or above while a B-10 reservation is active, or while the engine's Helius allocation is below what it needs (rolling sum ≥ 5M − signer − a floor);
  - P gates fail any window in which the engine had no Helius;
  - add an acceptance case for each.

**R7-03. The drained-position write-off books SOL inconsistently and can write off too soon.** (SPEC-B B-M20-04 step 5, B-M20-05)
- **Two valuations clash.** The new rule values a stuck position at "the most the vault can pay (often 0)". B-M20-05 `writeOff` records "proceeds 0". When the vault can pay something, the books show value X and then 0. And `close` is not allowed for `stuck`, so X can never be realised; it is a phantom asset in SOL.
  - Fix: before marking `stuck`, send one last sell of the margined size if it is &gt; 0, and book its real proceeds. Then value the remainder at 0 and write it off. Equity only ever holds amounts that were realised.
- **T is too short.** T is the strategy's time stop, 30 min for MR-01. A vault that refills after a burst of buying would already be written off. `stuck` blocks `close`, and the mint is blacklisted, so recovered value is lost for good.
  - Fix: after `stuck`, re-quote at low frequency (for example hourly for 7 days, read-only, inside the ≤ 50% budget). If the margined size becomes &gt; 0, an operator or automatic recovery sell runs and books the proceeds as a recovery.
  - Or use a longer T for drained pools, for example max(T, 24 h). This only affects when the slot is freed, so it costs entries, not money.
- The slot release and the SOL booking themselves are correct.

**R7-04. The off-host job's lease and checkpoint are undefined, so "one instance" and the cap cannot be measured.**
- The job may run on GitHub-hosted runners. "A second instance on any machine refuses to start" needs a lease service, which is not named. Neither is the checkpoint store ("the store card Z-H prep names").
- Checkpointing after every page means a runner that dies mid-page restarts from the last checkpoint and can spend one page beyond U. That is over the owner's row cap, though still under the plan.
- The job needs the owner's Helius key as an Actions secret: a new place for the key, and keys belong to the owner. Its URLs must be redacted under the same rule as A-M14-03.
- Fix:
  - name the lease store and the checkpoint store;
  - reserve each page's credits in the remote ledger before fetching it, so the ledger is written ahead, not after;
  - the owner places the key, recorded in DECISIONS;
  - the redaction rule applies to the job's logs.

## MINOR

**R7-05. The signer's 50k block has no renewal rule in the rolling ledger.**
- The block is one account-ledger entry written at boot. After 31 days it drops out of the rolling sum, while the signer's own counter (its file) may keep going or reset.
- A boot every day would re-reserve 50k each time.
- Fix: renew the block as one standing rolling entry, and keep the signer's counter rolling over 31 days.

**R7-06. Fix records can still be thin.**
- A reviewed PR whose message names the failureId but only changes a comment is valid.
- P-5 history is still kept per configKey, while P-10 is now per build lineage. A dry-run failure (uptime, crash) is an engine bug too.
- Fix: a valid fix also needs a test that fails before and passes after, citing the failureId; key P-5 history by build lineage as well.

**R7-07. The authority branch is hard-coded.**
- `origin/ccr-14987baf-i6lrsl` is named as the branch the B10-ACK row and fix records must be on. It is a session branch, not main.
- Fix: say "the repo's integration branch (today `ccr-14987baf-i6lrsl`; main after the cut-over)", in one place that is referenced elsewhere.

**R7-08. A partial download wastes credits.**
- If S is large, U can fall below the job's estimate (about 7.7M). The job then stops at U with fewer than 30 complete days, and B-10 fails after the credits are spent.
- Fix: do not start unless U ≥ the estimate plus a margin; otherwise tell the owner and wait.

## Totals
BLOCKER 0; MAJOR 4 (R7-01 to R7-04); MINOR 4 (R7-05 to R7-08). Head attacked: 281dc0414aa82ef2d563ea27faf9f439709c015b. Nothing edited or pushed; nothing sent to the owner.

### Supervisor rulings for round 8 (8 Oct 2026, about 1:35 AM)

I accept every finding: the reviewer's R7-1 and R7-2, and the red team's R7-01..R7-08.

1. **R7-1.** Add this sentence to A-M14-05's precondition bullet, ARCH D04, DECISIONS:114, MIGRATION:751 and MIGRATION:823: "Reservation precondition (before any credit): either the owner runs `botctl b10-reserve` on the host, or the owner sets up a tailnet path for the job machine; until one exists the job refuses to start." Add a case: with no reservation record, the job refuses to start.
2. **R7-2.** In ARCH:1234 and ARCH:1657, name Helius Developer: the owner's key under O7, 10M credits a month, 50 req/s, sendTransaction 5/s [LD-27], and the bot's 5M rolling cap.
3. **R7-01, owner-side use.** The B10-ACK row gains two fields, and both are required:
   - `exclusive=yes`: the owner confirms that nothing else uses the Helius account during the window or in the 31 days before it.
   - `dashUsed=<credits>`: the account's rolling usage, read by the owner from the Helius dashboard, with its date.

   S is the larger of the bot's ledger and `dashUsed`. Whether Helius offers a usage API is VERIFY; if it does, it replaces `dashUsed`.
4. **R7-02, no paper or live trading near the job.**
   - M26 refuses any switch to paper or above while a B-10 reservation is active.
   - It also refuses while the engine's Helius allocation is below what it needs. Name the floor.
   - A P gate fails any window in which the engine had no Helius.
   - Add a case for each.
5. **R7-03, drained positions.**
   - Before marking a position `stuck`, send one last sell at the margined size if that size is above 0, and book its real proceeds.
   - Value the rest at 0 and write it off. Equity only ever holds amounts actually realised.
   - For drained pools, T = max(the strategy's T, 24 h).
   - After `stuck`, run a read-only re-quote every hour for 7 days, inside the ≤ 50% budget. If the margined size rises above 0, an automatic recovery sell runs and its proceeds are booked as a recovery in SOL.
   - Add cases.
6. **R7-04, how the job runs.** Name the lease store and the checkpoint store:
   - Single instance: a GitHub Actions `concurrency` group for the job, plus a lease file in the private repo `macdarenz-droid/zeroed-data`, updated by compare-and-swap. A second instance refuses to start.
   - The ledger is written ahead: credits are reserved in chunks of at most 10,000 in the remote ledger before the pages are fetched. At most one chunk can be lost, and it counts as spent. So spend is never above U.
   - The owner places the Helius key as an Actions secret. Record this as an owner step in DECISIONS and in the Owner waits list.
   - The redaction rule of A-M14-03 applies to the job's logs.
7. **R7-05, the signer's block.** It is one standing rolling entry, renewed in place, never added again at each boot. The signer's counter rolls over 31 days.
8. **R7-06, valid fixes.** A valid fix also needs a test that fails before the fix and passes after it, citing the failureId. P-5 history is kept per build lineage, like P-10.
9. **R7-07, the integration branch.** Define it once: "the repo's integration branch (today `ccr-14987baf-i6lrsl`; `main` after the cut-over)". Refer to that definition everywhere else.
10. **R7-08, no partial runs.** The job does not start unless U is at least the estimate plus 10%. Otherwise it reports to the owner and waits.

Before pushing, run the self-check again ("how could this spend more than the owner acknowledged, or more than the plan, or loosen a gate?"), and list what you fix.
