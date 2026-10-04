# Handover: session_01XHH3k24fjmkpmmt28xSaYv (historical data builder)

Written 2026-10-04 ~08:20 UTC (6:20 PM Melbourne).

## Role, cards and model
- Builder for historical data. Cards: DATA-1, DATA-1c, DATA-2 (history over Helius RPC), BT-2e (practice days over Helius), ARCHIVE-CHECK, DATA-4 (credit ledger) and DATA-5 (design only).
- Branch: `claude/data-historical`. The base and integration branch is `ccr-14987baf-i6lrsl`.
- Model: claude-opus-5-5, auto mode.

## PRs and branches
| PR | Branch | Head | State | Review |
|---|---|---|---|---|
| #111 | claude/data-historical | merged | merged | DATA-2 review passed (archive scanner tree unchanged, 64e1335c) |
| #119 | claude/data-historical | a26c2c5, merge 3f14e0f | merged | BT-2e data review passed |
| **#127** | claude/data-historical | **e5552a4** | **open draft** | Not reviewed yet. With reviewer 01DKMn (supervisor, 08:03 UTC). |

Earlier DATA-1 PRs (#16 and later) are merged. Their history is in `docs/DECISIONS.md` and `docs/research/historical-data.md`.

## Done (on the base branch)
- **Archive scanner**, `research/historical/scanner/`:
  - Old Faithful CAR reader, scan, finalize, QA.
  - Revision tree 64e1335c (the archive revision).
- **RPC scanner**, `research/historical/rpcscan/`:
  - Symlinks every scanner .go file except main.go. The IDL JSON files are byte-identical copies, because go:embed refuses symlinks; test-ci checks this.
  - RPC transactions are encoded as archive nodes, so the same decoder runs on them.
  - Commands: `rpc-run`, `rpc-unit`, `pilot`, `digest`.
  - Revision string is `<scanner tree>+rpc<rpcscan tree>-go1.24.7` (`ci/rpcscan-rev.sh`).
- **Pilot**, run 37181739639:
  - Parity on every table; raw was explained in 126 blocks under the exact Agave log-cut rule (`agaveLogCut`, 10,000 bytes).
  - 5,225 credits (625 of them 429 retries), 5.0 blocks/s on the free plan.
  - A full day is about 250k credits, about 3.0 MB per block.
  - Baseline: `research/historical/pilot/baseline-1046-452277000-452281499.json.zst`.
- **data-scan.yml `source: helius`** (BT-2e):
  - Inputs `max_credits` (1 to 1M) and `rpc_rps` (1 to 50, default 5).
  - Helper scripts `ci/rpc-day.sh` and `ci/check-day.sh` (helius rescan).
  - Progress is cached under `data-rpc-DAY`.
- **ARCHIVE-CHECK**, `ci/archive-check.sh` and `.github/workflows/archive-check.yml`:
  - cron `41 */3 * * *`, one request each time: a 64-byte range GET with the scanner's User-Agent, body cut after 65 bytes.
  - Only a 206 of at most 64 bytes with curl exit 0 counts as served. Then it dispatches the next 8 unpublished days (pre-holdout days 09-21 back to 07-20, then the holdout 10-01 back to 09-22).

## Work in progress
### DATA-4, PR #127 at e5552a4 (complete; review pending)
- **`research/historical/ci/rpc-ledger.sh`**: `ledger.json` on release `helius-ledger`. Commands:
  - `init PERIOD LIMIT WORKER_BUDGET USED [DAY=N...]`
  - `reserve ID DAY DAY_CAP RUN_BUDGET OUT` books min(run budget, what is left of the day's cap, limit − worker − used − outstanding). Exit 3 when nothing is left; exit 1 on any ledger problem.
  - `settle ID WORK_DIR` books the final usage. A started spend with no final usage file books the whole reservation.
  - `show`, `unlock`.
  - Writers take `ledger.lock`, uploaded without `--clobber` (GitHub refuses a duplicate name). Any ledger failure fails closed.
- **rpcscan**: usage files carry `"final"`, written only at a clean exit.
- **rpc-day.sh and check-day.sh**: spend only the reservation and write `rpc-started-*` markers first. `rpc-credits.sh` is removed.
- **Workflows**:
  - data-scan (helius) and data-helius-pilot gain Reserve and Settle steps (Settle runs `always()`), each in a clean shell without the Helius key.
  - New `helius-ledger.yml` with init, show and unlock.
- **Docs**: `docs/research/historical-data.md` ("Credit ledger (DATA-4)") and a `docs/DECISIONS.md` row.
- **Evidence**:
  - test-ci: 121 pass.
  - The new test-ci run against the old scripts: 24 fail.
  - The Go test doesn't compile against the old `writeUsage`.
  - All 11 mutants of rpc-ledger.sh are killed (three survived the first round and got new tests).

### Running: 09-21 practice day over Helius
- Run **37185822426** (data-scan, source helius, day 2026-09-21, max_credits 270000, rpc_rps 5) on base 3f14e0f, using the old per-day credit total (pre-DATA-4).
- Scan job 111387393524 started its scan step at 07:28 UTC. Budget 300 min, so the step ends about 12:28 UTC. It then chains (exit 75 means resumable), about 3 chained runs in all, roughly 14 h of reading. Expected finish is late 2026-10-04 or early 10-05 UTC.
- Scheduled self-reminder `trig_01QiK9Jk2vujMAgopD8jNHFn` fires at 12:38 UTC to read the end. If this session stays paused, delete it or let it fire unread.
- When the chain finishes, a new session should:
  1. Read each run's "credits spent" / "credits for" summary lines and add them up as the 09-21 spend. Also read QA, parity, determinism and the publish of `data-day-2026-09-21`.
  2. Merge DATA-4 #127 only after the chain is fully finished: no run active or queued. Two reasons:
     - merged mid-chain, the next run fails closed because no ledger exists yet;
     - the rpcscan tree changed, so units already read would be read again.
  3. Run `helius-ledger.yml` with action `init`:
     - period: a label for the plan month;
     - limit: 1000000;
     - worker_budget: min(700000, 8600 × days left in the period + 150000);
     - used: the higher of the owner's Helius dashboard number and the fallback below;
     - days: `2026-09-21=<09-21 spend>`.
  4. Only then dispatch another helius day. 09-20 is next, and only with the supervisor's OK ("never dispatch a second day without my OK").

### Fallback "used" for ledger init (supervisor asked; no owner step needed)
- **Every Helius spend from Actions I could account for**, read-only from run logs and artifacts by a helper:
  - pilot 37181739639: 5,225, measured (429 retries included);
  - dryrun-rehearsal 37142749019, 37146252249 and 37148935094: 184.46, 4,255.16 and 4,190.89, from each run's `state/credits.json` (the worker's own metering, not Helius billing); 37145058769 spent 0;
  - gpa-probe 37149567929: 30, with at most 10 more for a refused call;
  - secrets-check 37125253258 and 37128492119: 2;
  - dryrun-smoke 37138505875: at most 12.
- data-scan runs before the helius source used no key. owner-programs has no runs. deploy only passes the key to the server, so that spend is the worker's.
- **Total: 13,888 measured, 13,910 with the upper bounds.**
- **Fallback used** = 13,910 + the 09-21 total + the live worker since its first deploy (Deploy 37138596675, finished 2026-10-03 17:07 UTC) at its budgeted 8,600 a day, rounded up to whole days. Add a 20% margin on all of that for spend that is not logged (Helius may bill differently from our metering).
- Init takes the higher of this and the owner's dashboard number.

### DATA-5, design (research done, write-up not done)
- **Problem**:
  - The regime gate reads curve volume of day D−3 (`packages/core/src/gates/regime.ts` volumeCondition; `config/policy.ts` volumeLagDays 3, window 365, percentile 25).
  - Live, the worker reads the `data-volume-DAY` releases (`packages/worker/src/facts/volume-hours.ts`).
  - Days on or after 2026-10-02 are refused by data-scan.yml (`REGIME_BOUNDARY_DAY`) and by publish-day.sh. So from about 2026-10-05, D−3 is 10-02 or later, there is no release, the volume condition is unknown and the gate is off. No trades until this is fixed.
- **Metric**, `research/historical/scanner/volume.go`: hourly lamports, buys plus sells, quote side. Covers pump curve trades quoted in SOL (empty quote mint, the system program or WSOL) plus canonical PumpSwap pools with a WSOL quote. An uncovered hour is unknown.
- **B5 (2026-10-02 ~20:00 UTC)**: an undocumented upgrade. Trade events gained 8 bytes and there are new event discriminators. The scanner keeps the tail (`events.go` `tail`) and finalize locates the first post-upgrade event. `regimes.json` has B5 with no slots yet. DECISIONS treats B5 as a decoder boundary, not a market boundary, so the volume series may continue across it.
- **Options found** (official pages, 2026-10-04):
  - **A. Old Faithful plus an upgrade-aware decoder.** Free and exact. The archive lags 0.4–1.9 days, which fits D−3. Blocked while Triton blocks us (ARCHIVE-CHECK watches). Work:
    - add B5 slots and the new layouts to `regimes.json` and the QA pre/post layouts;
    - allow volume-only publication (`data-volume-DAY`) for days on or after 10-02 while day files stay refused.
  - **B. Full blocks over a paid RPC with our decoder.** Exact; the cost is money.
    - Helius: about 250k credits a day, only about 4 days a month on the free plan; Developer is $49 for 10M.
    - Alchemy getBlock: 40 CU per block, about $4.5 a day, about $136 a month.
    - QuickNode: 30 credits, about $90–110 a month (plan price unverified).
    - Triton: priced by requests plus bandwidth, probably bandwidth-heavy (unverified).
  - **C. The live worker records hourly volume from its own streams.** The worker's `tradeStreams` (whole-program logsSubscribe on pump and PumpSwap) is off: "paid stream", 2 credits per 100 kB. Risks:
    - logs truncated at 10 kB;
    - processed commitment;
    - reconnect gaps;
    - 10-02 and 10-03 need a backfill;
    - the source differs from the backtest series, a parity risk.
  - **D. Dune.** Spellbook's `pumpdotfun_solana_base_trades` reads raw TradeEvent bytes at a fixed offset, so the +8 bytes don't break it, and filters on tx success. PumpSwap comes from IDL-decoded tables plus token transfers. Refresh is about 3 h. No free API: Analyst plan $75 a month. Definition risks:
    - USDC-quoted curves may be included;
    - PumpSwap amounts come from transfers, not event quote amounts.
  - **E. Bitquery.** Pro $69 a month holds 30 days of trades. The free trial has no archive.
  - **F. Others.** BigQuery's public Solana dataset is community-maintained and has stalled for days (2025-03/04, 2025-11), so it can't be relied on. Flipside's free tier is gone (sold to SonarX in 2026-05). DefiLlama is daily, in USD, and derived from Dune and Allium.
  - **G. On-chain GlobalVolumeAccumulator** (pump-public-docs IDL): daily, 30 slots inside an admin-set window, probably buys only, possibly frozen since 2025-11 ("Immutable global volume accumulator"). Not usable.
- **Recommendation (my draft; not yet sent to the supervisor):**
  - A is the default: free, exact, and the same series as the backtest.
  - Since A is blocked for an unknown time and the gate is off without D−3 volume, the one owner choice is to fund B: a paid RPC for D−3 full days only. Alchemy pay-as-you-go is about $136 a month; Helius Developer covers about 40 days of 250k for $49 plus overage.
  - Whichever source is chosen, add upgrade-aware decoding (B5 layouts in `regimes.json`) and volume-only publication for days on or after 10-02, with the existing coverage rule: an uncovered hour is unknown.
  - D (Dune $75) is a cheaper fallback only after its definition is checked against our decoder on overlapping days.
- **Next for DATA-5**:
  - write this into `docs/research/historical-data.md` as a "Regime volume after 2 Oct (DATA-5)" section;
  - send the summary and the single money choice to the supervisor.

## Rulings and decisions received
- Helius free plan only; no paid month (owner).
- One practice day at a time: 09-21, then 09-20, then 09-19 if credits allow. Each cap is the free credits left minus the worker's share. Never a second day without the supervisor's OK.
- No access to Old Faithful except ARCHIVE-CHECK (one 64-byte request every 3 h, real User-Agent, nothing that gets around the block).
- Helius key from secrets only, never logged; no raw Helius responses in artifacts or releases.
- DATA-4 merge order: after 09-21 finishes, then init (supervisor, 08:03 UTC). For init `used`: the higher of the owner's dashboard number and the fallback.
- 2026-10-02 is a regime-boundary day: never scanned for publication. B5 is a decoder boundary.

## Open risks and known gaps
- **Regime gate** is off from about 10-05 unless DATA-5 delivers D−3 volume. This is the highest-impact gap.
- **The ledger trusts the worker's budget.** If the worker overspends, history can still push the account over; the worker's 70% halt is the backstop.
- **A stale `ledger.lock`** (job killed while holding it) blocks every helius job until `helius-ledger.yml unlock`.
- **The Helius reset date** is only on the owner's dashboard. A new period needs a manual ledger replacement, because init never overwrites.
- **The 09-21 chain** runs on the pre-DATA-4 per-day total. Its spend must be entered at init.
- **ARCHIVE-CHECK** had not yet fired by 07:32 UTC (cron `41 */3`). Reminder `trig_01W4gKmNHMbURTkaqVKs5r8Y` was armed for 09:58 UTC to read the first result.

## How to verify
- `bash research/historical/ci/test-ci.sh` (121 pass on e5552a4; takes about 1–2 min).
- `cd research/historical/rpcscan && go vet ./... && go test ./...` (Go 1.24.7).
- The scanner revision must stay 64e1335c: `research/historical/ci/rpcscan-rev.sh`.

## Remaining time (estimate)
- DATA-4: review and fixes, 1–3 h. Merge waits on the 09-21 chain, about 6–18 h from now; uncertain because it depends on 429s and the number of chained runs.
- DATA-5 write-up: about 1 h.
- An implementation for option A or B: about 1–2 days, uncertain (the B5 layouts must first be confirmed from data).
