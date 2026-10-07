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
