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
