# Red team C: stays up, stays honest (commit 959d801)

**Verdict: NOT READY.** 6 CRITICAL, 4 HIGH, 5 MEDIUM, each with a probe that fails on 959d80178b72faf59e6421b4350041a5425eec08. No product code was changed. Probes (they fail on purpose, so this branch is not for merge):
- `packages/worker/test/redteam-c/*.test.ts`
- `packages/ops/test/redteam-c/*.test.ts`

Run them with `npx vitest run packages/worker/test/redteam-c packages/ops/test/redteam-c`. On 959d801: 20 tests, 20 failing.

## CRITICAL
| # | Finding | Where | Probe (file › test) | Smallest fix |
|---|---|---|---|---|
| C1 | **Restore after host loss clears the kill switch.** The hourly backup keeps only `*.sqlite`/`*.db`. After a restore, control.json (R10 kill latch, R9 weekly latch, pause), account.json (R11 count, NAV peak, paper wallet), exits.json (saved stops), credits, fill and fetch budgets all read as defaults. Only a missing ledger counts as a cold start, so the worker trades again. | `ops/host/files/usr/local/sbin/zeroed-backup:15`; `run/state.ts:55-58`; `worker.ts:762` | `ops/redteam-c/backup-coverage.test.ts` › backs up every bot-state file…; `worker/redteam-c/state-backup-restore.test.ts` › a latched kill switch survives the restore… (`started=true, killTrippedAtMs=null`) | Back up the whole state dir except journal.jsonl and recorder/. Refuse to start, or start latched and paused, when the ledger has trades but control.json or account.json is missing. Add a restore drill that checks the latches. |
| C2 | **Failed credit save crashes the worker in a loop.** `CreditBook`'s 1 s timer calls `#save`, and `atomicWrite` throws inside the timer (disk full, EACCES). The throw is uncaught, so `fatal` exits the worker. It repeats after every restart until systemd's StartLimit stops the unit, and open positions go unwatched. | `run/sources.ts:62-74` | `providers.test.ts` › a credits.json write that fails … does not crash the process | Wrap `#save` and `flush()` in try/catch: stay dirty, log one line, retry. |
| C3 | **Reconnect storm, no backoff.** `onopen` resets the backoff, so a server that accepts and then closes is reconnected every 1 s forever. Each Helius reconnect costs a connection credit plus a backfill per watch, and Helius has no halt. Probe: 601 opens and 1,798 credits in 10 min with 2 watches, about 259k/day; about 230 pools pushes it toward the 10 req/s ceiling, against a 1M/month plan. | `providers/socket.ts:115` | `providers.test.ts` › open-then-close retried with growing waits (601 > 30); › Helius stream … keeps its credit spend bounded | Reset backoff only after the link has stayed healthy (idleMs, or the first message after subscribe). A close soon after open counts as a failure. |
| C4 | **Re-read budget under-counted (bounded).** Each re-read books 1 credit, but TxFetcher (retries 3) spends up to 4 Helius credits plus Alchemy CU. | `worker.ts:1826`, `run/sources.ts:304`, `providers/tx-fetcher.ts:58-80` | `providers.test.ts` › a migration re-read … spends at most the 1 credit it books (4 vs 1) | Book `(retries+1)*cost` and refund the unused credits, or use a no-retry fetch for budgeted callers. |
| C5 | **Watchdog SOL reserve floor never fires.** The worker sends lamports as a string; the watchdog checks only finite numbers, and in SOL. | `watchdog/logic.ts:163`; `worker.ts:2674`; `runner/src/contract.ts:110` | `ops/redteam-c/watchdog-gates.test.ts` › alerts when … 0.01 SOL; › alerts at 0 lamports | Parse as a BigInt and compare with floor×1e9. A value that cannot be parsed raises an alert. |
| C6 | **Per-coin owner list grows until the coin's reads fail for good.** FactReaders `#owners` remembers every holder owner ever seen and puts them all in the next bank. Past 100 addresses, every batch for that coin is refused ("107 accounts do not fit one bank") for the life of the process, so the candidate is never judged again (a missed trade). Rated CRITICAL here as permanent loss of a gate input; HIGH if read only as growth. | `facts/readers.ts:533-583` | `worker/redteam-c/mem-owners.test.ts` › … keeps getting its accounts bank (rounds 3-7 refused) | Bank only the owners of the current `listed` set plus the scan's off-curve owners; keep the rest as a capped classification cache, not bank members. |

## HIGH
| # | Finding | Where | Probe | Fix |
|---|---|---|---|---|
| H1 | **Entry dispatched before the recorder has flushed its inputs.** The journal is fsynced, but the release and frame lines stay in `Recorder.#buffer` until after `drain()`. A kill there (restart drills) leaves a boot whose recording replays short of the journaled entry, so TEST-1 parity fails the session. Live, a buy would go out without its evidence on disk. | `worker.ts:862-874`, `2014-2021` | `entry-evidence.test.ts` › a kill right after the entry is dispatched … | Flush the recorder before `journalBeforeDispatch`. A flush error sets `#recorderFault`. |
| H2 | **Credit month wiped by a clock off by a month.** One boot with the clock a month off saves `{}`, and the Alchemy 70% halt restarts from zero. | `run/sources.ts:46-49` | `state-credits.test.ts` (2 tests) | Never replace a later saved month; keep the larger count. |
| H3 | **Recorder keeps every coverage gap of the boot.** It also rewrites them all into manifest.json at every seal, prune and attach. 200k gaps: 77 MB manifest and a 3.3 s synchronous block per rewrite, plus the heap the list holds. Not measured: the real daily gap rate. | `run/recorder.ts:85,151,246` | `mem-recorder-gaps.test.ts` | Cap the in-memory list (count, plus the first and last N); stream the full list to a gaps.jsonl table. |
| H4 | **Stuck-intent alert blind.** Intent start times are recorded only for entries and only in memory, so after a restart, or for exits, `oldest_age_s` is null and the watchdog never alerts. `last_exit_attempt_ts` is always null. | `worker.ts:2205,2881`; `desk.ts:397`; `watchdog/logic.ts:160` | `watchdog-gates.test.ts` › alerts on unresolved intents whose age … | The watchdog alerts on `count>0 && age==null`. Record exit intents too, and take restored intents' times from the ledger. |

## MEDIUM
- **M1. Daily scan cap re-granted after restarts.** A scan is granted even when its count could not be saved, so a restart on the same UTC day grants the cap again. `facts/readers.ts:726-751`. Probe: `providers.test.ts` › a scan whose count was not written … Fix: `#takeScan` refuses when the save fails.
- **M2. R10 NAV peak dropped on a clock step back.** A step back of 1 s drops the peak, so the kill line is measured from opening equity (fails open). `run/account.ts` `fact()`. Probe: `state-navpeak.test.ts`. **Needs a ruling:** `account-marks.test.ts:94` asserts the drop on purpose.
- **M3. Clock far ahead locks the fill budget.** One boot with the clock in the future holds the fill budget at 0 until that date: no trades, no alert. The same pattern is in fetch-caps (`worker.ts:1620`), deployer-checks:172 and readers:362. `persist/state.ts:510`. Probe: `state-budget-future.test.ts`.
- **M4. Release can silently run the stand-in.** `worker_entry` returns the stub when the config says release but main.ts is missing, or when host-config cannot be parsed. Smoke and update health both accept it. `logic.sh:110`. Probes: `host-gates.test.ts` (2).
- **M5. Silent uploader goes unnoticed.** An uploader that never wrote status.json clears every record alert, while the record budget deletes un-uploaded files at the cap. `zeroed-check:25`, `logic.sh:199`, `zeroed-update:122` (`|| true`). Probe: `host-gates.test.ts` › raises an alert when the switch is on and the uploader never wrote a status.

## Notes (no failing probe)
- **429 handling:** `Scheduler.penalize()` fills only the current 1 s window, so there is no longer backoff at provider level. Helius credit exhaustion over WebSocket is unverified, and probably shows up as C3.
- **Credit month fixed at process start:** early halt across a month edge (fails closed). Boot `fetchTx(sig,'restore')` is under no daily cap (bounded by StartLimit).
- **Kills and fsync:**
  - A crash or stop timeout exits without `credits.flush()` (up to 1 s of spend lost).
  - No directory fsync after rename anywhere.
  - volume-store, deployer-checks and readers scans rename without fsync (fails safe).
- **Ops:**
  - The rollback `apply_host … || true` can leave old code under new units.
  - A first-deploy rollback marks the release deployed.
  - A GitHub fetch failure in `zeroed-update` exits 0 silently.
  - `planAlerts` marks an alert sent when Telegram failed.
  - `publish.sh:56` `wrangler deploy || true` judges success by finding a URL in the output.
  - The stub reports 0 open positions even with paper positions in the ledger (relevant during the current pause).
  - The unit has no growing restart backoff; after StartLimit it stays failed, covered only by the 90 s heartbeat alert.
- **Replay and leak:**
  - No future leak and no nondeterminism found.
  - The backtest leak plant (`backtest/src/proofs.ts:47`, `cli.ts:165`) is narrower than core's and plants on keys no gate reads.
  - Core's leak test does not plant pool, candles, LP, insiders, graduates or curve volume.
  - The parity CLI does not pin `git_sha` or the RUG_CONFIG version.
  - `liveOnlyVetoes` is never filled from the live journal (BT-HEAL-MODEL still open).
  - A kill between `.zst` rename and plain-file removal in `sealFile` leaves both files ("release k is missing" in a parity run before the next boot's recovery).
- **Memory:** CappedMaps, the TxFetcher (50k small entries), the WS hold total (24k × ~2.1 KB ≈ 50 MB), PRE_READ 64×64, rereads and the shed keys are bounded. Per-mint plain maps (facts/source.ts `#lastAt`, `#survivalDone`, `#historyDone`, `#stage3`, `#scanTurn`; readers `#layout`, `#mintProgram`; deployer-checks `#cache`; worker `#intentAt`, `#rugVias`, `#createVias`) are never pruned. They grow only per candidate or pool, so this is LOW: a few MB over weeks. A full-worker heap load probe against the 560 MB limit was not built in this pass.
- **Checked and holding:**
  - Melbourne day and DST maths (23 h and 25 h days).
  - Atomic writes and refusal on corrupt state.
  - Journal torn-tail handling.
  - Ledger `synchronous=FULL`.
  - Credits charged at grant (failed calls count).
  - Daily budget files count as spent when unreadable.
  - Uploader delete and upload checks.

# Round 2 (same commit 959d801)

**Verdict: NOT READY.** 2 new CRITICAL and 4 new HIGH. The 21 future-leak probes all pass (no leak), and the 80 kill points in the middle of an exit (40 crash points × 2 price paths) are all clean.

## CRITICAL
| # | Finding | Where | Probe | Smallest fix |
|---|---|---|---|---|
| R2-C1 | **Heap: every batch re-read of a candidate is kept whole in the store until the candidate retires.** Only `read:accounts` and `mintKey` collapse to the newest value; holders, holders-all, sim, `worker:fees` and gates holders/sim/lp/soft/xcheck keep one entry per read. Worst case is 240 candidates read once a minute. Heap after GC: 34 → 87 → 174 → 294 MB at h1 to h4, with RSS 468 MB at h4. A longer run reached 349 MB heap and 639 MB RSS at h8, still rising, against 560 MB heap and 800M MemoryMax. | `run/store-rules.ts:44,88` | `heap-growth.test.ts` › CRITICAL: a candidate's re-read facts keep a bounded series… | Add those keys to newest-only `READS`, after proving each reader looks them up only as of now; otherwise give them a short retention. |
| R2-C2 | **0-byte or missing `ledger.sqlite` silently drops an open position.** The cold-start marker is written only when the file does not exist, and `openLedger` turns an empty file into a fresh database. The boot finds no positions, while `account.json` still holds the trade, and no stop protects the held tokens. | `worker.ts:762-763`; core `ledger.ts:768` | `r2-corrupt-state.test.ts` › ledger.sqlite zero length / missing | Treat 0 bytes as missing. If the ledger is empty while account, exits or paper hold trades, refuse to start. |

## HIGH
- **R2-H1. Missing control, account or paper file resets state.**
  - **What resets:**
    - missing `control.json`: the kill latch is lost;
    - missing `account.json`: the NAV peak, the day and week marks and today's entries reset, the setup rent is paid again, and the wallet is rebuilt from $20 at today's SOL price;
    - missing or emptied `paper.json`: paid fees are refunded (+30,000 lamports).
  - **Root cause:** shared with round 1's C1. A missing file reads as its default while the ledger proves the folder is not fresh.
  - **Fix:** one start-time check.
  - **Where:** `worker.ts:765`, `state.ts:53`, `account.ts:181-204`, `paper-world.ts:161`.
  - **Probe:** `r2-corrupt-state.test.ts` (18 failures out of 85 damages; the table is in `r2-corrupt-table.json`).
- **R2-H2. A release that crashes at minute 10 stays deployed.**
  - **Why no gate catches it:**
    - `holds()` watches only 30 s (`logic.sh:14`);
    - one restart per 600 s never reaches StartLimitBurst, and there is no `OnFailure=`;
    - `zeroed-check` has no worker check;
    - the watchdog ignores `restarts_24h` and `last_exit`.
  - **Probe:** `ops/redteam-c/r2-late-crash.test.ts`. Observed: `{"deployed":"still B","unitFailed":false,"watchdogAlerts":[],"restarts":12}`.
  - **Fix:**
    - a probation window of about 2 h with an NRestarts baseline, then rollback;
    - a watchdog alert on unplanned restarts of 2 or more, or on `last_exit` crash or oom.
- **R2-H3. The worker's per-mint pool maps are never deleted.**
  - **Maps:** `#pools`, `#poolReleasedAt`, `#fees`, `#carries` and `#snapshots` (`worker.ts:532-539,858,1230-1233,1487-1490`).
  - **Probe:** `heap-growth.test.ts` › HIGH: per-mint pool maps… Observed: 719 entries at 120 live candidates.
  - **Fix:** delete on retire unless held.
- **R2-H4. Coverage facts and pool coverage keys never go away.**
  - **In memory:** `#coverageFacts` is never pruned in memory (`strategy.ts:625,967,1335`).
  - **In the store:** the `coverage:trades:<pool>:start|gap|resume` keys never retire, because retirement matches a key's last segment (`core/src/engine/asof.ts:188`).
  - **Probe:** `heap-growth.test.ts` › HIGH: coverage facts… Observed: 2637 > 530, with 7,316 facts after 30 h.
  - **Cost:** R2-H3 and R2-H4 together cost about 3.6 KB per pool, about 5 MB a day.

## MEDIUM
- **`account.json` check covers 4 fields** (`account.ts:151`).
  - A missing `setup` pays the rent twice.
  - An emptied `trades` debits the entry twice.
- **Heal tapes have no total cap across pools** (`producer.ts:136,548`). Not measured.
- **About 1.3 KB per create stays past the 13 h window** (likely `#createSig` and `#symbols` at a 60k cap). A plateau was not proven; the projected size at the caps is about 78 MB.

## Heap budget (worst case)
- **Day 1, R2-C1 not counted:** about 200 MB. Base 68 MB, create caps about 78 MB, holds about 20 MB, TxFetcher and tombstones about 30 MB (estimated).
- **With R2-C1's worst case:** about 490 MB, plus about 5 MB a day from R2-H3 and R2-H4. Heal tapes are not counted.

## Leak probes (all PASS)
- **Files:**
  - `core/test/redteam-c/leak-facts.test.ts`: pool, LP, mint, candles, preReads, bookPending, insiders, graduates, curve volume, SOL/USD, and 2 controls that fail when a leak is put in on purpose.
  - `worker/test/redteam-c/leak-reread.test.ts`.
  - `worker/test/redteam-c/leak-livefeed.test.ts`: shed, standIn, shedKeys, late echo.
  - `backtest/test/redteam-c/leak-fills.test.ts`: the World's fills, with a control.
- **Notes (not leaks):**
  - Account reads answered ahead of their release slot are accepted (`producer.ts` around 1227 and 1338). Optional: clamp reads more than N slots ahead.
  - `world.ts:186` `hasRows()` peeks at whether more data exists; only the drop reason changes, never a decision.
  - FACTS-REREAD is a live-vs-backtest timing difference, not a leak.
- **Not planted:**
  - holders through the producer;
  - `#completionWaits` while a chain is mid-read;
  - a direct watch on the World's inputs, which needs a `wrapRunner` hook.

## Branch note
`pnpm typecheck` fails in packages/ops on this branch only, because of the probe files under `packages/ops/test/redteam-c` (rootDir). At 959d801 alone, ops typechecks clean.

# Round 3: re-verification on the fix heads

**Method.** Every round 1–2 probe runs on each head in its own worktree, with this branch's redteam-c tests copied in. The baseline is 959d801: 90 tests pass and 42 fail, every failure a reported finding.

The first pass ran the three heads in parallel. There, r2-exit-crash failed on #274 and #277 and the corruption counts varied. Run alone, r2-exit-crash passes on both heads and the corruption counts are 18 failing on every head. The parallel failures came from worker harnesses sharing ports, not from the heads.

| Finding | Owner head | Result |
|---|---|---|
| C5 reserve floor | #271 5d5aefa | **closed** (watchdog-gates: 0.01 SOL and 0 lamports pass) |
| H3 recorder gaps | #271 | **closed** (mem-recorder-gaps passes) |
| H4 stuck-intent alert | #271 | **closed** |
| M1 scan cap re-granted when its count is not saved (readers `#takeScan`/`#saveScans`) | #271 (S1's list) | **OPEN** on #271 and #274. providers.test.ts › a scan whose count was not written … fails with `expected 2 to be 1`. #271 changed only the future-dated case (`farAhead`); a failed save still grants the scan. |
| M3 future-dated budget files | #271 | **closed** (state-budget-future passes) |
| M4 worker_entry stub fallback | #271 | **closed** (host-gates, 2 tests) |
| M5 uploader never wrote a status | #271 | **closed** |
| R2-3 crash at minute 10 stays deployed | #271 | **closed** (r2-late-crash passes) |
| RC-1 reconnect storm | #274 9930916 | **closed** (2 tests) |
| RC-2 re-read charged 1, spends up to 4 | #274 | **closed by a different fix.** The worker now charges the fetcher's real spend, capped at FETCH_TX_CREDITS (worker.ts reread paths, `spent` callback), so the budget is never under-charged. My probe asserted the other fix (one call), so it still fails by design and is superseded. The head's own facts-reread "budget edge" tests pass (22/22). |
| RC-3 credits.json save crash | #274 | **closed** |
| Owners bank (C6) | #274 | **closed** (mem-owners passes) |
| H2 credit month wipe | #274 | **closed** (state-credits, 2 tests) |
| R2-C1 re-read series heap | #277 b550541 | **closed** (heap-growth CRITICAL passes) |
| R2-H3 per-mint pool maps | #277 | **closed** |
| R2-H4 coverage facts and keys | #277 | **closed** |
| C1, H1, R2-1, R2-2, R2-4 | PR B claude/rc-state | **not verifiable**: the branch is not pushed. state-backup-restore, entry-evidence and r2-corrupt-state (18/85) still fail on every head, as expected. |
| M2 NAV peak (SOL-BOOKS) | — | still fails on every head (not in these batches) |
| Regressions | all | **none**. All 21 leak probes and both exit-crash probes pass on every head. |

# Round 3: resume path (Deploy 1 on the stand-in, then Deploy 2 = #268)

**Verdict: the resume is safe to run only with the conditions below. 2 HIGH, 2 MEDIUM, 2 LOW.**

**Probe:** `packages/ops/test/redteam-c/r3-resume-sequence.test.ts` (1 sanity test passes, 6 probes fail). It runs the real `zeroed-update`, `logic.sh`, `alert`/`alert_clear` and the stand-in `worker.mjs`, with the files taken from:
- e4a8c05 (integration with #271 merged) for Deploy 1, host-config `"stub"`;
- #268 at 25c4d9b for Deploy 2, host-config `"release"`.

All lines below are in `ops/host/files/...` at e4a8c05.

## HIGH
- **R3-6: a second failed deploy is silent on the stand-in.**
  - **Code:** `alert worker-switch` (`zeroed-update:83`) is sent once per key until cleared (`common.sh:66-71`). The only `alert_clear worker-switch` is `:246`, after a successful hold.
  - **Scenario:** D2 rolls back to D1, the stand-in. The fix D3 then also fails its hold. No alert and no "deployed" message are sent, and the stand-in's heartbeat raises no watchdog alert. The bot sits on the stand-in and nobody is told.
  - **Probe:** R3-6.
  - **Fix:** key the alert per commit, or clear the key before raising a new rollback alert.
- **R3-1: a probation rollback lands on the stand-in with an open paper position.**
  - **Code:** `zeroed-update:125-138` checks only `open_intents`.
  - **Scenario:**
    - The release holds an open position, so its entry is settled and `open_intents` reads 0.
    - One restart within 2 h triggers the rollback to D1, the stand-in.
    - The stand-in manages no exits and reports `open_position:null`, and the watchdog cannot see paper positions.
    - The position has no stop until the next release deploys.
  - **Probe:** R3-1. It reports `current: 'D1 (stand-in)'`, and no alert names the position.
  - **Fix:** the worker writes an `open_positions` count. A rollback or switch onto the stand-in is held while that count is above 0 or unreadable, using the existing "rollback held" alert.

## MEDIUM
- **R3-2: rollback after a failed hold or start skips the intents check.** `zeroed-update:241-242` rolls onto the stand-in with no open-intent check, while probation does check.
  - **Probe:** R3-2.
  - **Fix:** `rollback()` holds the same way probation does when the target runs the stand-in.
- **R3-5: the stand-in's reconcile always writes `open_intents` = 0.** `stub/worker.mjs:33` overwrites the release's count, which opens every later gate over a ledger the stand-in never settled.
  - **Probe:** R3-5.
  - **Fix:** keep an existing count, or write `unknown`.

## LOW
- **R3-3: the `worker-probation` key is never cleared** (`zeroed-update:114,119`), so later probation alerts are suppressed for good.
- **R3-4: a failed newer deploy deletes the older release's probation** (`:70`, `:218`). This is the residual known in DECISIONS RC-R2-3.

## Conditions and notes
- **Order:** Deploy 1 must be confirmed deployed (Telegram "deployed e4a8c056d530") before #268 is tagged.
  - If the tag jumps straight to a commit with both, the old `zeroed-update` switches to the release worker with no probation.
  - In order, Deploy 2 runs under Deploy 1's script, and its rollback target has the same logic.
- **Conflict:** the #268/#271 conflict cannot resolve wrongly in silence. A wrong side fails `host-logic.test.ts` in CI, and `tag.sh` skips the red commit.
- **Checked, holding:**
  - Helius stays bounded in restart storms (saved daily seed and fill budgets; smoke runs without keys).
  - The stand-in's writes to `ledger.sqlite` are harmless.
  - Watchdog/uploader skew is low risk: `reports.sh` deploys the watchdog from the tag before the switch; if it fails, the failed-runs alert fires after 3 runs.
  - Disk retention is unchanged.
- **Not run:** `ops/test/e2e.sh` (no Docker daemon). Whether a manual `systemctl restart` resets NRestarts on real systemd is unverified.
