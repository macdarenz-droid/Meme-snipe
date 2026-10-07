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
