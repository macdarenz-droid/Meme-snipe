# RED TEAM A report

**Verdict: RED TEAM A: 2 CRITICAL, 4 HIGH, 3 MEDIUM, 1 LOW.**

- **Scope:** commit 959d801, the path feed → canonical/live-feed → facts producer → H1–H17 → strategy `#evaluate`.
- **Branch:** `claude/redteam-a`. No product code was changed.
- **How the probes work:** every probe asserts the correct (fail-closed, or same-as-backtest) outcome, so it **fails on 959d801**. Each one was run and fails on its stated assertion, not on setup.
- **Run:** `npx vitest run packages/worker/test/redteam packages/core/test/redteam` gives 10 failing and 3 passing. The 3 that pass are the on-time controls.

## CRITICAL

### RT-A1: a late confirmed pool log loses its swap from the as-of store with no gap (H11 fail-open; live ≠ backtest)

- **Code:**
  - `worker/src/providers/live-feed.ts:255`: a late frame is released out of order.
  - `core/src/facts/feed.ts`: the producer sees the event before the engine does.
  - `core/src/engine/engine.ts:165`: the engine refuses the event as `out_of_order`, together with every fact the producer wrote at its moment.
- **Scenario:**
  1. A pool-watch log (confirmed) arrives after the processed tip has passed its slot by `horizonSlots` (2).
  2. The producer takes the swap into its candle book. The engine refuses both the swap and the candles fact written for it.
  3. No gap is marked on `trades:<pool>`.
  4. Until the next swap on that pool, the store's candles miss the trade but read complete, current and gap-free.
  5. The raw swap event never reaches the store at all, so H5's tail tape misses it for good.
- **Test:** `worker/test/redteam/late-log-spike.test.ts`, "late: H11 must not pass on candles that miss the spike". A late +78% buy lets H11 pass; the same buy on time gives H11 `candle-spike` (control passes).
- **Prevalence:** measured on public mainnet RPC with `late-measure.mjs`: slotSubscribe tip vs confirmed `logsSubscribe` on PumpSwap.
  - 60 s: 102 of 42,594 notifications (0.24%) were at or past the horizon.
  - 230 s: 925 of 136,948 (0.68%), lag up to 6 slots.
  - Helius may differ. This corrects my interim message, which guessed "most swaps"; the `parsed-streams.ts` comment I cited is about another product.
- **Fix (smallest):** never release a late `logs` frame out of order.
  - Place it off-chain, as `lookup` already is (live-feed.ts:213).
  - Also emit `logs:truncated:<via>` with `txSlot` for it, as a `lost` echo does. TRADE-GAP-HEAL then heals it in chain order, or the gap stands.
  - Also count `status().late` in the summary, so its live rate is known.

### RT-A4: a heal clears the sticky `partial` flag of a late-opened candle book (H11 fail-open; narrow trigger)

- **Code:**
  - `core/src/facts/producer.ts:1529`: `#bookTake` sets `book.partial = true` only after its swap loop, so the marks taken inside the loop record `partial: false`.
  - `producer.ts:928`: `#heal` restores `book.partial = m.partial`.
- **Scenario:**
  1. A late migration arrives with more than 64 kept swaps; the oldest are let go.
  2. A late cut log at the last kept swap's slot heals from that mark.
  3. Result: the candles are no longer partial and the stream reads gap-free, with 2 swaps missing. H11 ok.
- **Test:** `core/test/redteam/heal-clears-sticky-partial.test.ts`, "candles with swaps let go past the cap stay partial after a heal of a hole at the last kept swap's slot".
- **Realism:** rare. It needs a late migration with more than 64 kept swaps, plus a late cut log at exactly that slot.
- **Fix:** set `book.partial = true` before the loop in `#bookTake`, or keep a separate lost flag that a heal never resets.

## HIGH

### RT-A2: H5's curve-tail half judges the whole curve in the backtest and about one trade live

- **Code:**
  - `core/src/gates/hard.ts:29` with `tails.ts` `checkCurveTails`: no curve event is a pass.
  - `worker/src/main.ts:50`: production runs with `tradeStreams: false`, so `run/sources.ts:316` does not watch the pump program.
  - `backtest/src/sim/facts.ts:527`: the backtest releases every tailed curve trade.
- **Effect:** a non-zero curve tail on any early curve trade makes the backtest refuse the coin; live passes it. This is a live-only pass, and it is not listed in §16.3.
- **Test:** `worker/test/redteam/curve-tail-parity.test.ts`, "live store … must give the same verdict".
- **Prevalence:** unknown. The one real completing buy checked (slot 453,857,383) has a zero tail.
- **Fix:** judge the curve half on the same evidence in both modes (the completing buy only, which live always has), or refuse live as `not-covered` without the curve tape. Record the choice.

### RT-A7: failed curve transactions hide the completing buy for good (coin blocked all window)

- **Code:**
  - `worker/src/run/worker.ts:1832`: `#rereadMigration` asks for the newest 6 curve signatures, with no `before` and no paging.
  - `worker.ts:1399`: `#readCompletion` asks for `before: migration, limit 5`.
  - Failed signatures still use up the limit.
- **Tests:** `worker/test/redteam/reread-curve-page.test.ts`, 2 tests. All 5 tries read the same page of failed signatures; H16 missing curve/migration stays for the whole window.
- **Fix:**
  - Once the migration signature is known, read with `before: <migration>`.
  - Page past failed signatures within the reserve.

### RT-A8: a cut creates log refused by the day's cap (or after 5 failed tries) is never asked again in the process

- **Code:** `worker.ts:1569` drops it before remembering it, and `worker.ts:1580` makes no further ask.
- **Effect:** `lostCreate` refuses H14 for every coin until the hole leaves the 14-day look-back, or until the process happens to restart.
- **Test:** `worker/test/redteam/cut-create-lost-for-good.test.ts`.
- **Note:** DECISIONS documents "past the cap it stays". It is flagged because the blast radius is every coin, and FACTS-REREAD already resumes on the next day.
- **Fix:** park refused or spent holes, and re-ask them (`#readLostCreates`) at the first step of each new UTC day.

### RT-A5: a hole released before a late-opened book never heals (good coin blocked)

- **Code:** `producer.ts:844–848`. `#holeHeal` adds the signature to `#holeSigs`, then returns because there is no book yet. The fetched swap is then dropped from both the candles and the chain (`#swap` lines 754–758), and the gap stays.
- **Test:** `core/test/redteam/late-book-hole-never-heals.test.ts`.
- **Realism:** likely whenever a migration lands late. It fails closed.
- **Fix:** when a book opens late, start heals for holes among the kept swaps, or record this as an accepted veto in §16.3.

## MEDIUM

### RT-A9: Helius credits leak across midnight UTC through the fills' budget

- **Code:** `worker/src/persist/state.ts:530`. `DailyBudget.refund` credits the day of the refund, not the day of the reserve.
- **Callers:** `worker.ts:1344`, `worker.ts:1389`, `seed-start.ts:64`, `sources.ts:164`, `sources.ts:246`.
- **Effect:** the new day spent 23,000 against its 20,000 cap. This is the same bug FACTS-REREAD fixed for its own budget only (`rereadRefund`).
- **Test:** `worker/test/redteam/fill-refund-midnight.test.ts`.
- **Fix:** `spend` returns its day, and `refund(n, day)` does nothing for a day that has passed.

### RT-A3: a late creates log is lost from the deployer index with no hole (H14 fail-open in mechanism)

- **Code:** `strategy.ts:1017` feeds the index only from engine-accepted events, so a late log is refused (live-feed.ts:255, engine.ts:165).
- **Effect:**
  - The creator's create is missing from the index.
  - `lostCreate` is null and creates coverage reads covered.
  - So H14's serial-deployer and prior-rug rules count without it. The same holds for a late cut log's hole.
- **Test:** `worker/test/redteam/late-create-log.test.ts`.
- **Ranked MEDIUM, not CRITICAL:** measured 0 late of 160 processed creates-authority notifications in 300 s on public RPC. The fix for RT-A1 covers this too.

## LOW

### RT-A6: a swap with an unusable timestamp is skipped from the candles without a `partial` flag

- **Code:** `producer.ts:765`, and the same skip in `#bookTake` and the heal's replay.
- **Test:** `core/test/redteam/unstamped-swap-skipped.test.ts`.
- **Realism:** not reachable on mainnet; only a decoder bug or a corrupted record could trigger it.
- **Fix:** set `partial` at all three sites.

## Notes (not reproduced, or fail-closed)

- **Other one-shot writes on a late event:** `#stale` puts its flag once, and insiders writes are de-duplicated. Both can also be refused on a late event. The pool-fact case is bounded by `maxStateSlotLag` = 2. Not probed.
- **Hole slot:** `logs:truncated` and `undecodable` holes use `e.moment.slot`, not `txSlot`. For a late echo this is the later open slot, so no heal happens. That fails closed.
- **Re-read credits:** `fetchTx` is counted as 1 re-read credit, but the fetcher retries up to 3 more times, so real spend may be up to 4×.
- **Restarts:** a restored candidate keeps its `lastReason`, so an identical refusal after a restart writes no record and `stage1Missing` may not fire. Not shown.
- **Checked clean:** regime hysteresis, migration fact values (live CreatePoolEvent vs backtest migration event: equal on the real fixture), H8 with signed virtual reserves (fails closed), UTC day handling in every counter (no Melbourne mix-up), tradeRepeatTag collisions, and CappedMap early eviction (fails closed).

# Round 2 (S1's request, same commit 959d801)

**Verdict: 1 CRITICAL (latent: off in today's config), 2 HIGH, 3 MEDIUM, 1 LOW.**

`npx vitest run packages/core/test/redteam2 packages/worker/test/redteam2 packages/worker/test/redteam3` gives 8 failing. Each fails on its stated assertion, not on setup.

## CRITICAL (latent)

### R2-1: after a restart seeded from the deployer store alone, H14's rug half reads as covered across the downtime

- **Code:** `worker/src/run/worker.ts:2478-2481`.
  - Only `coverage:creates:gap` gets the downtime gap.
  - The saved `coverage:rugs:*` starts go into the seed history with no gap.
  - `createsCoverage` (`deployer-index.ts:439`) then treats the new start as continuous.
  - The persist path (`loadState`) gaps both streams, as DECISIONS ("The rug half after a restart") requires.
- **Effect:** H14 skips the on-demand rug check (RUG-1c) and counts only labels, which missed every trade during the downtime. The attacker did not run a full H14 verdict end to end.
- **Test:** `worker/test/redteam3/rugs-coverage-store-restart.test.ts`. It fails with `{"covered":true,…}`.
- **Realism:** it needs `tradeStreams` on (off in `main.ts` today) and a boot without a usable state file (version change, corruption, or a kill before the first save).
- **Fix:** on the store path, add an open gap for every started watch on both streams.

## HIGH

### R2-2: the on-demand rug check counts a rug from before the 14-day look-back (live ≠ backtest)

- **Code:** `core/src/gates/deployer-check.ts:145` returns every `rug`, whatever its date. `hard.ts:551` adds these unfiltered, while the stream labels are filtered by `knownAtMs >= now - lookback`.
- **Why live and backtest differ:** live has no rugs stream, so every live H14 uses the check. The backtest uses the stream.
- **Test:** `worker/test/redteam2/rug-check-before-lookback.test.ts`. Live gives `prior-rug`; the backtest path gives no reason.
- **Fix:** keep a checked rug only when `label.atMs >= now - lookback`.

### R2-3: non-SOL-quoted graduates enter the regime's SOL survival series

- **Code:** `core/src/facts/producer.ts:647-689`, `#resolve` at `:1696`, and `regime.ts:96`.
  - The quote mint is never checked.
  - A USDC pool's raw reserve is compared with the 30 SOL floor.
- **Test:** `worker/test/redteam3/graduates-quote-mint.test.ts`.
- **Effect:** the survival share moves with the USDC/SOL mix of graduates, not with SOL survival. Live and the backtest share the producer, so both are equally wrong.
- **Fix:** keep the quote mint, and skip survival for pools that are not WSOL.

## MEDIUM

### R2-4: H15 accepts a simulation of any chain slot

- **Code:** `hard.ts:568` with the offchain freshness rule, which checks only the 2 s receipt age.
- **Test:** `core/test/redteam2/h15-sim-slot-unbound.test.ts`. A sim 5,000 slots behind the tip passes.
- **Why not CRITICAL:** live is guarded only by the reader's `minContextSlot` (`sim/roundtrip.ts:41`), not by the gate.
- **Fix:** refuse a sim whose slot is missing, or more than `maxStateSlotLag` behind the tip or behind the pool fact's slot.

### R2-5: the H16 cross-check passes when no source reported one of the two authorities

- **Code:** `hard.ts:592`.
- **Test:** `core/test/redteam2/h16-xcheck-partial-field.test.ts`, 2 tests (mint authority and freeze authority).
- **Note:** H2 and H3 still check our own read, so this loses only the independent check.
- **Fix:** require at least one non-null source for each field.

### R2-6: a restored graduates series is dated "now"

- **Code:** `producer.ts:1711` and `:1764`, with `regime.ts:179`.
- **Effect:** after a 20 h outage, the "last 24 h" survival share was judged from 4 h of data and passed instead of being unknown.
- **Test:** `worker/test/redteam2/graduates-restore-hole.test.ts`.
- **Fix:** date the fact at what the series has actually observed, and make survival unknown over an unobserved stretch.

## LOW

### R2-7: the serial-deployer count misses creates whose block time is ahead of the local clock

- **Code:** `deployer-index.ts:211` and `hard.ts:518`. The live `observe` path does not clamp the block time.
- **Test:** `worker/test/redteam2/serial-chain-ahead.test.ts`.
- **Fix:** clamp `createdAtMs` to the event's receipt time in `observe`, as `seed` and `fill` already do.

## Notes (checked; fail-closed or correct)

- **Mint and H4/H17:** `decodeMint`, the Token-2022 extension allowlist (transfer hook, fee, permanent delegate and unknown types are all blocked) and `checkShape` hold. I could not verify offline that the extension numbering matches token-2022.
- **H12/H13:** the supply read order, exact-sum completeness, holder classification and delegates hold.
- **H5:** the canonical pool rule (index 0, creator PDA, and the account at the derived address) holds.
- **S0 waivers:** none leaks into a normal run. The config refuses the diagnostic outside S0 or a qualifying run. One cosmetic issue: a "create expired" reject line can carry the previous candidate's stale S0 tag.
- **Regime:** the hysteresis follows §6.4. Volume uses complete UTC days only. SOL change needs exact hourly points.
- **Decoder:**
  - Unknown PumpSwap events stale the chain on the logs path and taint heals.
  - A shrunk layout throws, so the log or transaction becomes undecodable.
  - Negative i128 virtual reserves give a partial book or a chain mismatch.
  - Create, Complete, migration and CreatePool tails are never checked. That is safe only while pump appends fields.
- **Restored candidates:** gates and spend are judged again after a restart, and migration, completion and create are re-fetched. The SAVE-ASOF clamp of `migratedAtMs` can open the entry window a few seconds early under host-clock skew (LOW, not probed).
