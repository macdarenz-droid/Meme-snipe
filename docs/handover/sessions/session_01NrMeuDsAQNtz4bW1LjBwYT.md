# Handover: session_01NrMeuDsAQNtz4bW1LjBwYT (reviewer, RISK-MARK #103)

## Role, cards and model
- Fresh-context reviewer for PR #103 RISK-MARK (risk review), on demand from the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). Review only: no code pushed, no approvals or merges.
- Model: configured `claude-opus-5-5` (the session's default effort; not read from a chip).
- I own no branches and no PRs. This notes file is my only commit.

## PRs and branches
- PR #103 RISK-MARK, branch `claude/risk-mark`. Final head `33de0f95328af23a11b197e847dec15d5d91b04d`, MERGED into `ccr-14987baf-i6lrsl` (merge b565123).
- Verdicts, all 2026-10-04 (AEDT):
  1. FAIL at 5f981b7 (12:49). B1: a stale SOL price still marked. B2: the worker wiring of slippage, exit cost and maxAge was untested.
  2. FAIL at 3118bc9 (13:22). B3: a throw on the entry path stopped the worker. B4: the head was behind its base.
  3. PASS (code) at e9d98d7 (13:56). M1: merge the newer base (DECISIONS conflict, docs only).
  4. PASS at f644ede (14:46). Delta: the stale-market worker test was replaced by a stale-SOL one. M1: merge base 1fa82fd (clean).
  5. PASS at 94221a2 (16:14). Merge check against base 8367668. M1: merge base 4016562 (clean, ops only).
- I did not review the final head 33de0f9 myself. Merge was the builder's and supervisor's step after my PASS at 94221a2 and my clean trial merge 6d168f3.
- PR #99 WORKER-1c: I did not review it. I only checked it for conflicts with #103 (see Findings). It is now MERGED (d92b73e), after #103.

## Done
- What #103 delivered:
  - `packages/core/src/exits/value.ts` `executableMark`.
  - `packages/worker/src/engine/marks.ts` (`markSettings`, `markedHistory`, `riskAccount`).
  - `packages/worker/src/engine/strategy.ts` (`#marked`, the exit logs `risk mark` and `risk tripped`, and the entry refusal `risk mark failed`).
  - Tests in `packages/worker/test/marks.test.ts` and `packages/worker/test/position-market.test.ts`.
  - Rationale in `docs/DECISIONS.md`, section "Risk marks (RISK-MARK …)".

## Work in progress
- None. Nothing is half done. My review queue is empty.

## Next steps
- None for this role.
- Optional follow-up for the next reviewer: confirm #99 as merged meets item (b) below. My check of base 5087bd4 confirms only (a) and (d).

## Findings and evidence (all re-runnable; local trial merges were never pushed)
- `pnpm check` green each round:
  - 5f981b7: 134 files / 4244 tests.
  - Trial merge c3aa3b9: 4262.
  - Trial merge 94da403: 4286.
  - Trial merge a2fa4a8: 4346.
  - Trial merge 6d168f3: 4394.
- B1 probe at 5f981b7: a SOL price 1 h old with a fresh pool gave mark 289849n instead of null. Fixed with risk's freshness rule for SOL in `markedHistory`.
- B2 at 5f981b7: four mutants survived the whole worker suite (434/434 tests passing): slippage 0, exit cost 0, maxAge 1e12, entry unmarked. Fixed: `markSettings` plus a worker test that checks the logged `risk mark` equals `executableMark`.
- B3 at 3118bc9: a throw injected in `riskAccount`'s entry branch propagated riskAccount → #evaluate → #entries → onMarket → Engine.drain → Worker.step. The loop at worker.ts ~706 logs "Engine step failed" and stops with EXIT.crash. Fixed by a try/refuse in `#evaluate`, plus a worker test using the test-only `markedHistory` seam.
- The seam is test-only. It is set in one place (worker.ts, from WorkerDeps). main.ts's `new Worker({...})` does not include it, and config or env cannot carry a function.
- Final mutant results, each killed by marks + position-market (19 tests):
  - first rung instead of last, slippage 0, cost 0, fee, tip or signatures dropped, maxAge 1e12;
  - SOL freshness dropped, market freshness dropped, future check dropped;
  - fallback rethrow, exit fallback:false, entry fallback:true, exit unmarked, mark log removed, entry catch removed, seam ignored.
  - Accepted survivor: the entry path using the unmarked account. DECISIONS discloses it; it cannot be observed at maxOpen 1.
- Market staleness at the exit cannot be tested at worker level since EXIT-1c/1d/1e, because a due exit waits for a fresh quote. Unit tests cover it.
- A stale market at entry cannot latch a trip: only `trip ` reasons on the approve path are latched (worker.ts ~527).
- Merge rule M: the marks take their market only from `#market`. A snapshot wins when it is newer by slot, then by receipt time. Only a winning pool fact is checked for POS-1 flags, and a flagged fact is no market.

## Rulings received (supervisor, applied in #103)
- N1: mark at the worst (last) ladder rung, 2,500 bps, with that rung's priority fee.
- N2: an exit-path marking failure falls back to the unmarked account (tested).
- N3: whichever of #99 and #103 merged second takes the boundary marks from the marked account, and the display mark gets a separate name.

## Open risks and known gaps
- #99 landed second. What I told the supervisor #99 must do:
  - (a) `#markAccount` uses `riskAccount` + `markSettings`. Confirmed in base worker.ts ~683.
  - (b) Record a day or week boundary mark only when every open position has a fresh, non-null mark. Otherwise a total-loss equity is frozen and the marked day and week measure is muted. NOT verified by me.
  - (c) navPeak only from a non-null NAV. Not verified.
  - (d) Rename the display `markOf`. No `markOf` is left in worker src, so it looks done.
  - (e) Tests for these. Not verified.
- Known limit, from DECISIONS: the account snapshot reaches risk about one slot after a fill, so NAV is null until then.

## How to verify
- `pnpm install --frozen-lockfile && pnpm check` (about 8–9 min here).
- Focused: `npx vitest run packages/worker/test/marks.test.ts packages/worker/test/position-market.test.ts`.

## Remaining time
- None for this role: 0 min. The review is closed.
