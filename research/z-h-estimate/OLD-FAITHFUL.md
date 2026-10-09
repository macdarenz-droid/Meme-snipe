# Z-H history from Old Faithful, in batches (card Z-H-OF)

Card Z-H-OF, docs only. Round 1 written 2026-10-07 UTC (8 Oct about 7:30 AM Melbourne); **round 2** applies the
supervisor's rulings in `docs/reviews/ZHOF.md` on `claude/supervisor-docs` @ `f9cccd40` (review FAIL, red team 8 MAJOR), with the round 2 addendum (items 14–17) @ `c2f8f899` and round 3 (items 18–20 @ `623974a5`, 21–27 @ `70d6069f`, 28–32 @ `e57fc720`) and round 4 (items 33–40 @ `b2b558be`) and the final push (items 41–44 @ `4a4fe1bb`),
and the owner's answers of 8 Oct about 7:42 AM. It turns the owner's decision of 8 Oct about 7:25 AM, **"Old faithful but
by batch to avoid blockage"** (`CLAUDE.md` "History for the past-data test" on `claude/supervisor-docs`), into a batch
plan for gate B-10's history replay. It replaces route "B", the capped Helius download of PR #289 (Z0D-2).

**No archive request, workflow dispatch, download or code change was made for this card.** Research reads were single
requests to public documentation pages (§1). Labels as in `RESULTS.md`: **MEASURED**, **DERIVED**, **ASSUMED**,
**VERIFY**. `RESULTS` means `research/z-h-estimate/RESULTS.md` @ `c6c8496f`; `HANDOVER` means `HANDOVER.md` on
`claude/supervisor-docs` @ `7ddbba12`. Every OF item in §5 is a **requirement** for a code card, with the test cases that
card must carry; nothing here is built.

## 0. Bottom line

- **0 Helius credits.** B-10 reads the Old Faithful archive (`https://files.old-faithful.net`, `scanner/archive.go:23`)
  through the existing scanner and day pipeline. No `B10-ACK`, no Helius reservation, no exclusivity, **no paper
  blackout** (paper delay 0).
- **Limits.** Triton documents **no** limit for `files.old-faithful.net` (§1), so the scanner's caps stay: **10
  requests/s and 40 MB/s** (`ci/archive-limits.conf:5-6`), one lane, one unit × 4 connections (`:7-8`).
- **Days: 30 days; 31 with the 07-22 lead-in**, 2026-07-22 (lead-in) and 07-23 to 08-21, oldest first, from **one allow-list** that every entry
  point enforces (§2, OF-2). Days 08-22 to 09-20 (the 60-day target) are an **owner question** (asked about 7:45 AM) and
  are not queued unless the owner says yes. **30 decision days leave no spare: if one day fails QA, B-10 cannot pass**
  until that day is read again under the same batch rules.
- **Batches.** One UTC day per batch, one at a time. Nothing goes to the archive, not even the 64-byte probe, while a
  back-off is running or the chain is not armed. Any 429, 403 or 503 stops the chain for at least 3 h; 3 failures counted
  from the last re-arm stop it until a reviewed re-arm (§2).
- **Time (DERIVED; VERIFY on batch 1):** about 3.5 h a July batch; **about 7.75 days for the 31 batches (30 days; 31 with the 07-22 lead-in) at best, about 11.6 if
  each batch waits one extra 3-hour check, about 15.5 if it waits two.** A block like 4 Oct's (more than 6 h) stops the
  chain after about 6 to 9 h, until it is re-armed (§2).
- **Storage (owner: "Store them"):** private `zeroed-data` only, never this repository or anywhere public; publishing
  stays off because Triton has not replied. Full range **about 0.1 to 1.4 TB** for the 31 read days (30 days; 31 with the 07-22 lead-in). **Batches 1 and 2 (07-22
  and 07-23) keep raw records for every canonical pool (K2)**, so both sizes are measured on two days; before batch 3
  the retention is chosen and recorded with the numbers and the first-day bias (an OF-3 step): K3 (PM-01's universe) if
  its projection over the 31 read days is under the owner's 0.5 TB, otherwise stop and ask the owner; the two days are then trimmed
  into new `-k3` releases (§3). After every batch, the stored total plus the remaining days × the largest day so far
  must stay ≤ 0.5 TB, or the chain stops and the owner is asked. The days may wait unused in the store until a strategy reaches gate B, and under A17 (C-56) they may never be used.
- **Held** by a fail-closed arm value in `archive-limits.conf`, set only by the last reviewed change after OF-3 to OF-7.
  **#214 merges with or after OF-2**, with its test-ci updated in that change (§4).
- **#214 vs the 09-21 Helius cache: option (a)** (§4).
- **No Phase 0 precondition for the download** (0 credits). B-10 itself runs only once a strategy reaches gate B. The days may wait unused in the store until a strategy reaches gate B, and under A17 (C-56) they may never be used.

## 1. The archive's documented limits and terms

Each source was read once on **2026-10-07 UTC (8 Oct Melbourne)** with a single request; the sourcing-data page was read
a second time for the exact quote.

| Source | What it says | Limit for `files.old-faithful.net`? |
|---|---|---|
| <https://docs.old-faithful.net> | "Triton provides a full copy of this ledger at https://files.old-faithful.net that you can download"; "stored in Amsterdam, download using servers nearby for best throughput". No terms, licence or limit; no link to one | **None documented** |
| <https://docs.old-faithful.net/running-old-faithful/sourcing-data.md> | "This archive is currently completely free to use, and is a great way to get started with Old Faithful." No limit or licence | None documented |
| <https://docs.triton.one/core-features/ratelimits.md> | "1200 requests per 10 seconds" per IP for most methods on the shared RPC service; after a 429, pause all requests from that IP for 10 s. No page date | Applies to Triton's **RPC nodes**; the page never names Old Faithful or `files.old-faithful.net`, so it is **not** a documented archive limit |
| <https://docs.triton.one/project-yellowstone/old-faithful-historical-archive.md> | "Old Faithful is automatically integrated into your Triton One subscription." Nothing on the public file host | None |
| <https://docs.triton.one/chains/solana/old-faithful-historical-archive-1.md> | "It is currently available for use via a separate, dedicated path." Nothing on the public file host | None |
| <https://triton.one/policies> | Lists a Privacy Policy, Cookie Policy, Terms of Use and California Privacy Policy; the fetched page held only the Privacy Policy text | The Terms of Use text was **not found** (`https://triton.one/terms-of-use` answered 404; no further URLs were guessed) |
| `docs/research/historical-data.md:32`, `:49` (2026-10-03) | "No usage terms published"; "Old Faithful's host terms (none published)" | Same finding, 4 days earlier |

**Caps (owner rule: ≤ 50% of the documented limit).** No limit is documented, so the scanner's caps stay:
**`ARCHIVE_MAX_RPS=10`** and **`ARCHIVE_MAX_MBPS=40`** (`ci/archive-limits.conf:5-6`), `ARCHIVE_PARALLEL=1`,
`ARCHIVE_DL=4` (`:7-8`). For context only (not documented limits):
- MEASURED by us on 2026-10-03: the archive answered 429 "after ~0.6 TB in an hour from one machine"
  (`historical-data.md:87`), about 167 MB/s. 40 MB/s is 24% of that (DERIVED).
- At 40 MB/s with 16 MiB chunks (`scanner/scan.go:257`) the scanner starts about 2.4 requests/s (DERIVED), under the
  10/s cap. If Triton's RPC figure (120 req/s) did apply, 10/s would be 8% of it.
- A rate or bucket that Triton publishes or sends replaces these numbers in `archive-limits.conf` (`:2`).

**Before #214 (history).** The scanner was above the request cap: `scanner/archive.go:73` was `newLimiter(40)` and
`polite.go:25` allowed 80 MB/s, so `archive-check` dispatched nothing (fail closed, then `ci/archive-check.sh:110-114`).
PR #214 sets `reqLimiter` to 10/s and the byte cap to 40 MB/s, and makes any 429, 403 or 503 stop the run (§4); OF-2
moved the request-cap hold before the probe (hold 4, §2).

**Terms and the owner's answers (8 Oct about 7:42 AM).**
- No Triton clause on storing, redistributing or deriving works from archive data was found (table above).
- **Triton: "No reply"** to the owner's 4 Oct email (`docs/DECISIONS.md:425`). So whether a private store needs
  Triton's permission stays **unanswered**.
- **Storage: "Store them".** Archive-derived day files go only to the private `zeroed-data` repository, never to this
  repository or anywhere public. **Publishing stays off until Triton answers** (`docs/DECISIONS.md:448`: "Publishing
  files derived from the archive waits on Triton").
- `docs/DECISIONS.md:416` says "Triton's terms bar getting around a block … and bar a blocked user from seeking other
  Triton access without Triton's OK". No source for that text is recorded in this repo, and the Terms of Use page was
  not found: **VERIFY**. The rule binds us anyway (owner, `CLAUDE.md` "never get around a block"; DECISIONS "No
  disguise", `:455`).
- **Today's pipeline publishes publicly** in three places on the archive path: `publish-day.sh:87` (release
  `data-day-DAY`, `--repo "$GITHUB_REPOSITORY"`), `publish-volume.sh:45` (release `data-volume-DAY`, same repo) and the
  Actions artifact `day-DAY` with 14-day retention (`data-scan.yml:436-442`). OF-4 makes all three private or drops
  them before batch 1.

## 2. The batch plan

**Batch unit: one UTC day.** It is the pipeline's existing unit: `scan-day.sh` scans one day (`:2`), `check-day.sh`
runs strict QA, decoder parity and a determinism rescan on it, and it is stored as one day release. Inside a day the
scanner works in 4,500-slot units, written atomically, so a stopped day resumes without re-reading finished units
(`historical-data.md:73-81`). A July day reads in about 2.5 h, inside one job's 300-min budget (`data-scan.yml:23-24`).

**Days: one allow-list, 30 days; 31 with the 07-22 lead-in** (owner exception "30 days … for these days only"; supervisor ruling 1).
- `archive-limits.conf` holds `ARCHIVE_DAYS`: 2026-07-22 (lead-in, post-BOOST: B2 is 07-21 14:23Z) and 07-23 to 08-21,
  queued oldest first, so the lead-in is held before the first window day and a replay can follow chain order. The
  archive held every epoch from 980 to 1047 on 2026-10-03 (`historical-data.md:227`), which covers them.
- Every entry point refuses a day outside the list or in `HELIUS_DAYS` before any request: the data-scan plan job
  (today it checks only the day format and the 2026-10-02 boundary, `data-scan.yml:156-162`), `scan-day.sh`,
  `check-day.sh` and `archive-check.sh`. A manual dispatch of a holdout day, or of a day before 07-22, fails in the plan
  job (OF-2).
- 08-22 to 09-20 (which would give 60 decision days) are added to the list only by a reviewed change after the owner
  says yes to 60 days. Never: 2026-09-21 (`HELIUS_DAYS`, `archive-limits.conf:15`; ARCHIVE-NODUP), 2026-09-22 to 10-20
  (`B3_CONTAMINATED`, SPEC-A A-M13-06), any day before 07-22 (pre-BOOST), and any day in `W_R` (no past day can be in
  `W_R`, which comes from forward M07 data, RESULTS §2 line 89).
- 30 decision days are exactly B-10's minimum: there is no spare day. **A day is never read again whole** (round 3
  item 23). After a QA failure the owner is told first; then only the units QA names are read again, under the same
  batch rules. If that does not fix it, the day counts as missing, B-10 is short, and the owner is asked about a spare
  day (a new day needs the owner's OK).
- **Day order under OF-6** (round 3 item 24): day D+1 is dispatched only after day D's units are stored (as a release,
  or held in the store as a failed day's units), because D+1 takes D's forward-margin units from the store.
- Today's queue must go: `archive-check.sh:104-108` queues 09-21 back to 07-20, then the holdout days 10-01 back to 09-22.

**Which strategy is replayed.** MR-01 is parked (C-76, owner 2026-10-08); B-10 replays the stage's strategy (PM-01
today, or a future strategy through the M09 slot). If none has reached gate B, the pull may still run (0 credits, no
Phase 0 precondition), and its days wait in the private store; B-10 stays pending until then.

**One batch at a time.** One archive lane: the `data-scan` concurrency group with `max-parallel: 1`
(`data-scan.yml:113-114`); `archive-check` makes no request while any archive-lane run is active or queued
(`archive-check.sh:57-69`); `ARCHIVE_DAYS_PER_CHECK=1` (`archive-limits.conf:10`). **Dispatch race (OF-2):** a queued
check can run before the run it just dispatched is listed. So archive-check writes a **dispatch marker** before it
exits: an Actions cache entry with key `archive-dispatch-<UTC time>-<check run id>` in this repository (it holds only a
timestamp and the dispatched day, nothing archive-derived). A later check lists keys with that prefix and holds while a
marker is younger than **15 min** (TTL; at least 10 min, round 3 item 25) and the data-scan run it names is not yet
listed. **Only real markers count** (round 4 item 38): a marker counts only if it was saved on the default-branch ref
(listed with `--ref refs/heads/<default branch>`) and its run id is an archive-check run on that branch; any other
entry with the prefix is ignored. Listing cache keys from the script (for example `gh cache list --key archive-dispatch-`) is **VERIFY** against
the gh version on the runner; if the list cannot be read, the check holds (fail closed).

**Holds before any request (OF-2), in this order; each one sends nothing, not even the 64-byte probe:**
1. not armed: `ARCHIVE_ARM` in `archive-limits.conf` is empty or differs from the pinned `B10-PULL` id; or no retention
   value for the day (below);
2. a back-off is running: less than `ARCHIVE_BACKOFF_S` (3 h) since the last exit 4 or the last non-206 check. Today the
   probe goes out without reading the persisted back-off, so after a 429 a request could go out about 1 h later (red
   team 1);
3. the 3-failure stop is active (below);
4. the scanner's request cap is above `ARCHIVE_MAX_RPS` (`archive-check.sh:110-114`, which today runs after the probe);
5. an archive-lane run is active or queued, or a dispatch marker is fresh;
6. less than 60 min since the last archive-lane run ended;
7. the queue is empty: every allow-listed day is read done (OF-5), read from `zeroed-data`, failing closed if it cannot
   be read; and no day after 07-23 is dispatched before the retention record exists.

**One source of truth for arm, stop, storage and retention** (round 3 item 28; round 4 items 35, 37; final push item
41). `archive-limits.conf` holds `ARCHIVE_ARM`, `ARCHIVE_REARM_AT` and `ARCHIVE_RETENTION`, each set in the same reviewed
change as its DECISIONS record. The storage stop is not a config value, because CI cannot write a reviewed change: it is
an append-only **`storage-stop` marker** (a release or asset) in `zeroed-data`, written by OF-4 when the projection is
above 0.5 TB, and cleared only by a reviewed change with the owner's OK. archive-check, the data-scan plan job,
`scan-day.sh` **and `check-day.sh`** all refuse before any request when the chain is unarmed, when the 3-failure stop is
active, when the `storage-stop` marker is present or `zeroed-data` cannot be read, or when the day has no retention
value: `ARCHIVE_RETENTION` unset allows only 07-22
(K2, measurement day 1); the arming change sets `K2`, which allows 07-22 and 07-23 only (the two measurement days); the
change before batch 3 sets `K3`. `scan-day.sh` passes `ARCHIVE_RETENTION` to the scanner explicitly, and `check-day.sh`
passes the **day's recorded retention** (from its units) to the determinism rescan; nothing else picks the retention. A
unit read again after a QA failure also uses the day's recorded retention (round 4 item 39), never the current
`ARCHIVE_RETENTION`. So a manual dispatch cannot read the archive unarmed, after a stop, or with an unrecorded retention.

Only then: one 64-byte range GET with the scanner's own User-Agent (`archive-check.sh:71-98`), and a dispatch of the
next day only on a 206 of at most 64 bytes. Chained runs never resume after a block (`scan-day.sh:146-148`, exit 4).

**Stop rules** (owner, `CLAUDE.md` 8 Oct):
- Any 429, 403 or 503 stops the scanner at once, never retried (PR #214 `isBlocked`), and holds a back-off of at least
  3 h (`ARCHIVE_BACKOFF_S=10800`, `archive-limits.conf:9`); the run exits 4, not resumable (`scan-day.sh:146-148`;
  `check-day.sh:83-86` for the determinism rescan).
- **3 failures stop the chain.** A failure is a batch that ends blocked (exit 4) or fails any other way (exit other than
  0 and 75), a second exit 75 on the same day, or a check answered with anything but a 206. Each failure leaves a
  **countable** record: a non-served check ends with a distinct conclusion or run title (today it exits 0 and looks like
  a quiet check, red team 10). The count starts from **`ARCHIVE_REARM_AT`**, a UTC timestamp in `archive-limits.conf`;
  failures before it do not count. After 3 failures with no successful batch between them, archive-check sends nothing
  and dispatches nothing. The supervisor reports it to the owner. If the history cannot be read, the check refuses
  (fail closed).
- Never get around a block: no other agent, host, address, proxy, client or Triton service (`archive-check.sh:19-22`,
  DECISIONS `:428`, "No disguise" `:455`).
- No identity change: the User-Agent stays `zeroed-historical-scanner/2 (research backtest; +https://github.com/macdarenz-droid/Meme-snipe)`
  (`scanner/archive.go:84`), and `archive-check` refuses to run if it is not found (`archive-check.sh:46-50`).

**How a stopped chain resumes.**
- After a block (fewer than 3 failures): nothing is sent until the back-off has passed (hold 2); then the next served
  check redispatches the same day, which sleeps out any persisted back-off (`polite.go:131-148`, `scan-day.sh:118`) and
  resumes from its finished units.
- After 3 failures: only by a reviewed change from the supervisor that moves `ARCHIVE_REARM_AT` forward (with the reason
  and the owner's message in HANDOVER), and never before the last back-off has ended. Nothing re-arms automatically.

**One cancelled or timed-out check stops the chain** (OF-2 round 4, ruling 40): its probe step ends without success,
which counts as a failure, and with no back-off annotation it reads as `end=hold`, which holds until a reviewed
re-arm. Whether `always()` steps still run after a job-level timeout is **VERIFY**; the chain fails closed either way.

**A failed day's reasons are kept, privately** (OF-3 ruling 24): the scanner's output and the trim, unitlog,
finalize and QA output go to `logs/` inside the day's progress directory, never to the public log, and are saved with
the progress in the sealed cache (OF-2 ruling 44). When the job fails, or the full save is skipped or fails, they are
also sealed and saved alone as a `-logs` entry (OF-3 rulings 25, 27 and 29). That entry is sealed as type `logs`, which
a resume (it opens type `progress` only) refuses, and with no picked progress the restore key ends `-fresh`, which no
saved key starts with, so a re-run never restores it (OF-3 ruling 28). After a failure they are read by opening that
cache (`ci/cache-crypt.sh open SEALED DEST PREFIX logs`) with the store token; nothing about them is published.
In the CI scripts a line may name the log directories only to assign them under `$out` or `$RUNNER_TEMP`, mkdir or rm
them, redirect output into them, mv `migrations.list` out of them, or echo them to the step summary, and `eval` is
refused (OF-3 ruling 30, replacing OF-2 ruling 63's deny-list); a `logs` part after any spelling of `$out` or `$RUNNER_TEMP`
(plain, braced, quoted) counts, and read commands on `$out` itself or after a `cd` into it are refused (OF-2 ruling 67), as is a read command
with a `logs` path part whatever variable comes before it (OF-2 ruling 70).

**Arm checklist (the arming change, OF-2 rounds 3–4).** The supervisor puts each item to the owner, with a
recommendation, before `ARCHIVE_ARM` is set:
1. `research/historical/ci/unguarded-refs.sh` (read only): the branches and tags whose `data-scan.yml` or
   `archive-check.yml` can read the archive without `archive-guard.sh` (today the tag `preview`, 13cdf32; `deploy`
   moves forward with each deploy). No agent deletes or moves a branch or tag: each one goes to the owner (ruling 37).
2. Every old run of `data-scan.yml` or `archive-check.yml` from a commit without `archive-guard.sh` whose re-run window
   is still open (GitHub allows a re-run for a limited time after a run; the exact window is **VERIFY** in GitHub's
   docs at arm time). A re-run of one stops the chain (ruling 21); deleting runs is hard to undo, so the owner decides
   "delete them, or wait for the window to close". The guard lists only runs created since the earlier of 35 days ago
   and `ARCHIVE_REARM_AT`, plus every queued, in-progress, waiting, requested or pending run (round 6, ruling 43:
   GitHub allows a re-run only within 30 days of the run, per GitHub Docs "Re-running workflows and jobs", **VERIFY**
   the page and wording at arm time). The runs are read page by page from the runs API (round 7, ruling 49), so no
   500-run cap applies (a capped list would have tripped about 62 days after the first archive check, or two months
   after a re-arm). GitHub returns at most 1,000 results for one filtered search and paging then simply stops (REST
   "List workflow runs for a workflow", VERIFY), so the window is read in 7-day created slices, and a slice or status
   query that reports 1,000 or more runs, or returns fewer rows than it reports, fails closed (rulings 55 and 61); such
   a trip goes to the owner, since deleting runs is hard to undo. The guard logs the runner's gh version. The archive
   workflows run on the pinned `ubuntu-24.04` image (ruling 59).
3. The repository's Actions log retention (ruling 28; the back-off annotations and the run history the guard reads
   must outlive the window it reads). Read through the API if the arming session can (read only,
   `repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention`, **VERIFY** the endpoint and the permission it
   needs); otherwise one line for the owner: "Settings → Actions → General → Artifact and log retention: what number of
   days is set?". The value goes in DECISIONS.
4. Which YAML parser the runner has for the permissions check (python3's `yaml`, else `yq`; **VERIFY** on the runner
   image). The guard logs the parser and its version ("permissions: parsed with ..."); a parser that does not refuse a
   repeated key, or no parser, fails arming closed (OF-2 round 4, ruling 33).
5. The progress cache (round 6, rulings 44 and 44a). In this public repository a fork's pull_request workflow can
   restore the base branch's caches, so the scan's progress is saved only sealed (`ci/cache-crypt.sh`: AES-256-CTR
   then HMAC-SHA256, keys derived from `DATA_STORE_TOKEN`, entries named with the key id); arming refuses a progress
   cache saved or restored from any other path. Owner steps: (a) Settings → Actions → General → "Fork pull request
   workflows": require approval for all outside collaborators (defence in depth); (b) do not rotate
   `DATA_STORE_TOKEN` while the download runs: a progress sealed with the old token is refused, nothing is read, and
   the day waits for a decision instead of starting fresh. The MAC binds the entry's source and day (ruling 50), and
   the AES key reaches openssl only on a file descriptor (ruling 52). Helius assets are sealed the same way, and
   data-keep refreshes only sealed entries (ruling 51), so the unsealed `data-rpc-*` entries saved before this change
   (09-21's included) expire after 7 days unused. Arming holds while any unsealed `data-scan-*` or `data-rpc-*` entry
   remains; whether to delete one or wait for it to expire is the owner's decision.
6. The `-k3` releases of the two measurement days (OF-6 ruling 12). After batches 1 and 2 are stored at K2 and the
   reviewed change sets `ARCHIVE_RETENTION` to K3, and before batch 3, `data-scan.yml` runs in mode `k3` once for
   07-22, then once for 07-23 (07-23 waits for `data-day-2026-07-22-k3`). Nothing is read from the archive:
   `ci/k3-fetch.sh` brings the K2 day back from `zeroed-data`, `margin-fetch.sh` replaces the units it took with the
   day before's K3 copies and writes `prev-day.txt`, `trim-day.sh --qa` trims it with QA, the list must equal the stored
   one, and `publish-day.sh --k3` stores and reads back `data-day-DAY-k3` with its `readback-ok` marker. Batch 3
   (07-24) takes its margin only from `data-day-2026-07-23-k3` (ruling 6), so it cannot start before.

**Reads, and the one allowed second read (DERIVED).**
- Each day's unit plan carries two units of margin on each side (`scanner/main.go:310`, 3,600 s), about 1.9 units each
  side in July. Today the adjacent day reads the same margin units again, a second archive read of about 4% of a day.
  **OF-6 requires that a unit already stored for the adjacent day is taken from the store, not read again.** With the
  days oldest first, each batch then reads its forward margin only (about 4% more); 07-22 also reads its backward margin.
- The determinism rescan reads one unit of the day again (`check-day.sh:59-78`), about 2% of a day (1 of about 46 units,
  DERIVED from 86,400 / 0.4201 / 4,500). **It is the one allowed second read of a unit.**

**Expected time (DERIVED; VERIFY on batch 1).**

| Days | Mean slot (RESULTS §3 table, lines 171-174) | Blocks a day | Read a day at 1.65 MB a block | With margin and rescan (+6%) | Reading at 40 MB/s |
|---|---|---|---|---|---|
| 07-22 to 08-20 (30) | 420.1 ms | about 205,700 | about 339 GB | about 359 GB | about 2.5 h |
| 08-21 (1) | 368.0 ms (the 350 ms target era from epoch 1020) | about 234,800 | about 387 GB | about 410 GB | about 2.85 h |

- 1.65 MB a block is the October figure (`historical-data.md:85`); July blocks may differ (**VERIFY**: batch 1's
  `statBytes`). Skips lower the count by at most 1% (RESULTS §3 line 155).
- Per batch: about 15 min setup and restore (ASSUMED, RESULTS line 232), the reading above, and at most 45 min of QA,
  packaging and storing (`data-scan.yml:23-24`): **about 3.5 h for a July batch, about 3.85 h for 08-21.**
- Cadence (DERIVED): checks run every 3 h (`archive-check.yml:14`). A batch longer than 3 h makes the next check find
  the lane busy, so at best one batch per 6 h, 31 batches (30 days; 31 with the 07-22 lead-in): **31 × 6 h = 7.75 days**. If each batch waits one extra check (a check
  dropped by GitHub, as on 6 Oct, HANDOVER:1350, or the 60-min pause not yet passed): 31 × 9 h ≈ **11.6 days**; two
  extra: 31 × 12 h = **15.5 days**.
- **Long block.** On 4 Oct the archive answered 429 to our scanner from 8:43 AM to at least 3:19 PM, more than 6 h
  (`docs/DECISIONS.md:415`). A block like that gives failure 1 (the batch, exit 4), failure 2 at the first probe after
  the 3-h back-off and failure 3 at the next, so the chain stops after about 6 to 9 h and waits for a reviewed re-arm.
- Reading total for the 31 read days (30 days; 31 with the 07-22 lead-in): about 10.6 TB of day blocks, about 11.2 TB with margins and rescans (DERIVED).

## 3. Storage per batch

**What B-10 needs** (RESULTS §5, §6): rows for every bonding-curve and canonical-pool trade, every event, holder
movements, the raw records the engine's own decoder reads for the replayed strategy's trades, and every create and
migration raw record. Today's retention already keeps every curve and canonical-pool trade and every event
(`historical-data.md:94`), creates and migrations raw (`:166`), and raw records for a 5% hash sample.

| Option | Per day | 31 read days | Note |
|---|---|---|---|
| K1 today's units (rows + 5% sampled raw + creates and migrations) | 6.4 to 8.5 GB (`historical-data.md:230`) | 0.20 to 0.26 TB | The engine's decoder sees raw records only for sampled mints |
| **K3: K1 + raw records for PM-01's universe** (chosen for batches 2 onward if it fits, below) | K1 + PM-01 raw (not estimated: **VERIFY**, measured on batch 1) | between K1 and K2 | Raw records for the canonical pools of mints that migrate inside the lead-in or window, from migration to the end of PM-01's holding horizon, taken from the pinned migration list (below) |
| K2 RESULTS P11: raw for **every** canonical-pool transaction | about 17 to 45 GB (RESULTS:348) | 0.53 to 1.40 TB | **Batch 1 only**, to measure both sizes; not kept for the 31 read days (30 days; 31 with the 07-22 lead-in; above the owner's approved size) |

- **Full range for the 31 read days (30 days; 31 with the 07-22 lead-in): about 0.1 to 1.4 TB.** Low end: K1's 0.20 TB with July activity at half of October's
  (the sizes come from October activity, ±2×, RESULTS line 341, so July is **VERIFY**). High end: K2's 1.40 TB, the
  upper bound for K3. MR-01 is parked (C-76), so MR's universe (RESULTS:347) is not kept.
- **Owner's approved size: about 0.2 to 0.5 TB** ("Store them").
- **Retention decided from measurement (addendum item 17; round 3 items 29, 30, 32).**
  - Batches 1 and 2 (07-22 and 07-23) keep K2 raw, tagged so both PM-01's subset and the full set are measured on each
    day. Two days, because day 1 under-measures PM-01: its pools carry no positions over from migrations before the
    lead-in (the first-day bias).
  - Before batch 3, as an OF-3 step, the supervisor records in DECISIONS the measured sizes of both days, both
    projections over the 31 read days, the first-day bias and the choice: **K3 if PM-01's projection over the 31 read days is under 0.5 TB, otherwise the
    chain stops and the owner is asked.** The same reviewed change sets `ARCHIVE_RETENTION`. Until that record exists,
    no day after 07-23 is dispatched.
  - Day releases are never edited (`publish-day.sh:8-10`). So the two K2 days are trimmed into **new** release tags,
    `data-day-2026-07-22-k3` and `data-day-2026-07-23-k3`. The K2 releases stay in `zeroed-data`, private, as the
    measurement record.
  - **Two "done" predicates** (round 4 item 33). **Read done**: a `data-day-D` or `data-day-D-k3` release exists in
    `zeroed-data`; it drives archive-check's queue, data-scan's skip step and D+1 ordering, so 07-22 is never read
    twice. **B-10 done**: the `-k3` release for 07-22 and 07-23 and the plain release for every other day; it drives
    only the `B10-PULL` row and the evaluator. A K2 release is read done but never B-10 done.
  - The trim tool re-runs finalize, strict QA and parity on the trimmed units and rewrites `SHA256SUMS-DAY` and the
    per-unit log, with no archive read. **Determinism evidence by proof plus hashes** (round 4 item 36): the K2
    measurement release keeps the determinism rescan unit's file hashes, which equal the day's own unit (`check-day.sh:94-98`
    checks this byte for byte); the trim is a deterministic function of the unit's bytes and the pinned migration list (trimming the
    same unit twice with the same list gives identical bytes, tested); so the trimmed unit's K3 bytes equal what a trimmed rescan would give. No rescan unit
    is stored or trimmed.
- **The PM-01 universe is a pinned input** (final push item 42; OF-3 rulings 2, 4 and 5, `docs/reviews/OF3.md`). **Every
  day is read at K2 and trimmed to K3 before it is stored** (no K2 bytes are stored after batches 1 and 2). D's list is
  built from the days before D (the day before's pinned list, whose windows reach D) plus D's own migrations read from
  D's K2 units, each listed pool kept from its migration to **migration + 300 min** (PM-01 PREREG §3, PM01-P5 at
  `c0bdb04a`: last entry at +120 min, time stop 120 min, 60 min for the exit ladder). Its sha256 is recorded in each
  unit's stats and in the per-unit log. The trim takes this list as an input, never a list rebuilt from other data, and
  the determinism proof and test-ci use the same list; before a unit's K2 raw is deleted, its K2 file hashes go into
  the per-unit log, and the determinism rescan reads the unit at K2 and is compared with them. D+1 is dispatched only
  after D is stored (read done, OF-5), and its list takes D's as the prior. The units are read newest first, so the trim
  runs after the whole day, not per unit, and `scan-day.sh` checks the full K2 day's disk peak
  (`ARCHIVE_K2_PEAK_BYTES`, 55 GB) before any archive read; if batch 1 shows a K2 day does not fit, the chain stops
  before batch 3.
- **One scanner revision, two retention values** (round 3 item 27). Retention is a value recorded per unit, not code:
  today's units already record `retention` per unit, and "finalize refuses mixing" (`docs/research/historical-data.md:94`).
  So one frozen scanner revision (OF-3) covers K2 and K3, and finalize refuses a day whose units mix them; the trimmed
  `-k3` days carry K3 in every unit.
- **Storage stop after every batch** (round 3 item 22, OF-4): the stored total (the K2 measurement releases included)
  plus the remaining allow-listed days × the largest K3 day stored so far must stay ≤ 0.5 TB; otherwise OF-4 writes the
  append-only `storage-stop` marker in `zeroed-data`, the chain stops and the owner is asked. For batches 1 and 2, the per-day figure is the
  **measured PM-01 subset of the K2 days** (round 4 item 40), since no K3 day exists yet.
  **As built (OF-4):** `ci/storage-check.sh` runs after each stored day. It sums every release in `zeroed-data`, counts
  the allow-listed days with no `data-day-D` or `data-day-D-k3` release, and takes the largest stored day as the per-day
  figure, a K2 release (it carries `pm01-subset-DAY.txt`) counting as that measured subset. The cap is
  `ARCHIVE_STORE_CAP_BYTES` (5 × 10^11 bytes; the decimal reading is the stricter one). Above it, the script writes the
  published `storage-stop` release, never edits or deletes it, and exits 3, so the batch fails and nothing chains.
  A store it cannot read, or no per-day figure, fails closed without a marker.
- **As built (OF-5):** "read done" is read only from `zeroed-data`, failing closed when it cannot be read: the
  queue and the guard (`ag_read_done`) and the skip step (`publish-day.sh --check`) count a `data-day-D` or
  `data-day-D-k3` release only when it is complete (every asset uploaded and named as its `SHA256SUMS-D` lists; both
  judge it with `ci/release-state.sh`, ruling 3, as does `assemble.sh --download`, which takes only such days, ruling 4) and carries its `readback-ok-D` marker (OF-5 ruling 1): stored after every other asset
  was read back, naming the tag and the sha256 of the stored `SHA256SUMS-D`, and itself read back. A release without it
  (its read-back never passed) stops the chain for review and is never read again automatically. "B-10 done" is
  `archive-guard.sh b10-done`: a marked release whose recorded retention is B-10's (ruling 2: every unit line of
  `units-D.log` K3 with the sha256 of `list-D.txt` from its `SHA256SUMS-D`), whatever the tag name; it is for the
  `B10-PULL` row and the evaluator only.
  The scan job's clean `prior` step (`ci/prior-fetch.sh`) downloads `list-<D-1>.txt` and `SHA256SUMS-<D-1>` from D-1's
  release in the store and hands them to the scan and the trim; `archive-guard.sh prior` checks the sha256.
- **As built (OF-6, `docs/reviews/OF6.md`):** each day release carries `margin-D.tar`, the units that reach the next
  day (last block time at or after the next midnight minus 2 h), in its SHA256SUMS and read back. Before day D+1's scan, a
  clean store step (`ci/margin-fetch.sh`) takes those units from D's release into D+1's progress and lists them in
  `from-store.txt`. The scanner skips them (their stats.json is there), the trim passes them through untouched and the
  per-unit log marks them `from EPOCH/RANGE TAG`. Because D's list is built from all of D's units, the forward margin
  included, a coin migrating in D's forward margin keeps every raw record D+1's list keeps (scanner test
  `TestMarginMigrationKeptForNextDay`). The determinism rescan reads exactly one unit, never a taken or re-read one.
  After a counted scan failure, the guard pass flags the day: a fresh whole-day read of it is refused. Only a pinned
  QA-REREAD row (id, day, units, toldAt, written after the owner is told) lets `scan-day.sh` read the named units again,
  with `zeroed-scan run -units`, at the day's recorded retention; the per-unit log marks them `reread EPOCH/RANGE ID`.
  The trimmed day is stored as `data-day-D-k3` only through `publish-day.sh --k3` (the same read-back and
  `readback-ok-D` marker, so its first `-k3` release is done); test-ci refuses any other `data-day-*` release create
  without the marker (ruling 5).
  Round 2 (rulings 6–9): the margin comes only from a done release whose units carry the day's own retention, so a
  K3 day after a K2 day waits for `data-day-<D-1>-k3`; B-10 done accepts a taken unit with the day before's list sha256;
  the margin tar may hold only regular files and directories; and the scanner refuses a planned unit that the day
  before stored but this day did not take (`-stored`, `-taken`), so a drift between the two time estimates never
  reads a unit twice.
  Only the head of `ARCHIVE_DAYS` whose day before the store does not hold is exempt from the prior list, the margin
  and `-stored`; the clean margin step records it in `prev-day.txt` (ruling 11).
- **K2 progress is not stored in `zeroed-data`** (OF-4, deciding OF-3 ruling 7). A K2 day's progress (about 45 GB)
  does not fit the Actions cache. Putting partial K2 units in the private store would add a second store path for
  unfinished data, with its own read-back and clean-up, for two measurement days. Instead, a K2 day that cannot finish
  in one job holds the chain for a decision, as OF-3 ruling 7 already does.
- The days may wait unused in the store until a strategy reaches gate B, and under A17 (C-56) they may never be used.
- A future slot strategy that needs raw records for other
  pools reads those days again from the archive: 0 credits, only time, under the same batch rules, and only with the
  owner's OK as a new download.

**Where it is kept.** Day releases in the **private** data repository `macdarenz-droid/zeroed-data` (DATA-STORE #150),
never in this public repository or anywhere public (owner: "Store them"; Triton: "No reply"). Each release keeps its
tar parts under 2 GiB (`historical-data.md:222`), its QA report, manifest, parity report, `SHA256SUMS-DAY` and the
per-unit log of §6. Nothing goes to the 2 GB host (D29).

**What is deleted after each batch.**
- The runner's units, QA dataset and rescan: the runner is discarded; packaging already deletes units as it tars them
  (`tar --remove-files`, `historical-data.md:220`).
- The day's Actions progress-cache entry, once the stored release has been read back and its sha256 sums match (OF-4;
  today it is left to least-recently-used eviction, `historical-data.md:221`).
- The archive's CAR bytes are never stored: they are streamed and decoded (`historical-data.md:58`); only small
  per-epoch boundary files are cached.
- Nothing is deleted from the store until B-10 has passed and its evidence is bundled: the replay reads it.

**GitHub size question.**
- Release limits: under 2 GiB a file, at most 1,000 assets a release, "no limit on the total size of a release, nor
  bandwidth usage" (GitHub "About releases", quoted in RESULTS:378-380, fetched 2026-10-07).
- Acceptable Use §9 "Excessive Bandwidth Use" lets GitHub throttle, suspend the account, or delete a repository after
  notice (RESULTS:381-386). No threshold is published; the owner accepted it for about 0.2 to 0.5 TB ("Store them").
  Whether a private repository's release assets count against an account storage quota is **VERIFY**.

## 4. #214 and the 09-21 Helius progress cache

**Facts.**
- PR #214 (ARCHIVE-SAFE B): open, head `e48d71df`, base `ccr-14987baf-i6lrsl` at the stale `efa3b006`, last updated
  2026-10-05 13:05Z (read through the GitHub API on 2026-10-07). It sets `reqLimiter` to 10/s, `maxAllowedMBps` to 40,
  `-max-mbps` default 40, and stops on any 429, 403 or 503. Data PASS at `e48d71df` (HANDOVER:1346).
- It changes the scanner tree, so the scanner revision (`ci/scanner-rev.sh:10`) and the rpcscan revision
  (`ci/rpcscan-rev.sh:9`) both change. `scan-day.sh:104-116` and the RPC path rescan every cached unit of another
  revision, so the about 66 cached 09-21 Helius units (RESULTS §2 line 136; HANDOVER:1295 notes a later run restarted
  from 0, so the exact count is VERIFY from the cache entry) become useless.
- 09-21 is a Helius day (`HELIUS_DAYS="2026-09-21"`, `archive-limits.conf:15`); 13 of its 79 units are unread.
- **#214's own test-ci expects a dispatch of `days=2026-09-20`**, and the queue then reaches the holdout days 10-01 to
  09-22 (`archive-check.sh:104-108`). So #214 merges **with or after** OF-2, and its test-ci is updated in that change to
  the allow-list's first day (07-22) behind the arm hold.

**Options.**

| | (a) Merge #214, drop the 09-21 Helius cache | (b) Keep the cache valid by changing how the revision is computed | (c) Finish 09-21 on Helius first |
|---|---|---|---|
| Credits | 0 | 0 | About 58,500 to 79,000 (DERIVED: 13 units × 4,501 = 58,513 base; with the determinism rescan unit and 25% retries, 14 × 4,501 × 1.25 = 78,768; RESULTS §3 lines 153-160) |
| Owner approval | None | None | **Needed**: the owner's 8 Oct rule says no Helius credit is spent on this history ("Helius headroom stays unused … with no exception") |
| Risk | 09-21 is lost as a Helius day; it is outside the B-10 list anyway | The revision is the guarantee that "a day never mixes revisions" (`scan-day.sh:104-106`). Excluding `archive.go`/`polite.go` from it needs a proof that they never change a row, its own review, and a precedent | Spends credits for a day B-10 does not use; delays #214 and the whole archive route |
| 09-21 later | Not read from the archive while it is in `HELIUS_DAYS` | Kept | Complete on Helius |

**Recommendation: (a).** 09-21 is outside the allow-list (30 days; 31 with the 07-22 lead-in); it is incomplete (about 66 of 79); MIGRATION A02
(`docs/MIGRATION.md:412`) bars data collected before 2026-10-07 from any Blueprint gate; (b) weakens a correctness
guarantee to save a research day; (c) spends credits the owner's 8 Oct rule withholds. Under (a) the DATA-KEEP refresh of
the 09-21 entry (HANDOVER:627) stops, and the entry expires.

**Owner rule "no duplicate days between archive and Helius"** (HANDOVER:1349, 6 Oct about 12:12 AM). Under (a) it holds:
09-21 stays in `HELIUS_DAYS` and outside `ARCHIVE_DAYS`, so every entry point refuses it (OF-2), and no B-10 day is a
Helius day.

## 5. Requirements for the code cards (OF-1 to OF-7)

Each OF item is merged by its own reviewed code card with its files and the tests listed (each fails before and passes
after). Kept from the Z-H prep list: P2 (as OF-3), P11 (K3), P12, P13 and P14 (as OF-4), P15; **P21 and the
account-ledger rules stay**, because they cover every Helius workflow. **No batch is dispatched while `ARCHIVE_ARM` is
unset; only the last reviewed change, after OF-1 to OF-7 have merged, sets it.**

| # | Requirement | Files | Tests the card must carry |
|---|---|---|---|
| OF-1 | **#214 merged with or after OF-2**: base merge onto the integration head, fresh data review, CI green on the exact head; its test-ci updated in the same change (no dispatch of 2026-09-20; the first dispatch is 07-22, and only when armed) | `scanner/archive.go`, `polite.go`, `main.go`, `polite_test.go`, `ci/test-ci.sh` | #214's Go tests; test-ci: armed and served → `days=2026-07-22`; unarmed → no request |
| OF-2 | **Allow-list, arm, retention, holds, failure count, order.** `archive-limits.conf` holds `ARCHIVE_DAYS` (07-22..08-21), `ARCHIVE_ARM`, `ARCHIVE_REARM_AT` and `ARCHIVE_RETENTION`, each set in the same reviewed change as its DECISIONS record. The plan job, `scan-day.sh`, `check-day.sh` and `archive-check.sh` refuse any day outside `ARCHIVE_DAYS` or in `HELIUS_DAYS`; the plan job, `scan-day.sh`, `check-day.sh` and archive-check also refuse, before any request, when unarmed, when the 3-failure stop is active, when the `storage-stop` marker is present in `zeroed-data` or the store cannot be read, or when the day has no retention value (§2); `scan-day.sh` passes `ARCHIVE_RETENTION` to the scanner explicitly, `check-day.sh` and any unit re-read pass the day's recorded retention. archive-check applies holds 1–7 of §2 before any request; writes the dispatch marker (Actions cache key `archive-dispatch-<UTC time>-<run id>`, TTL 15 min; only markers on the default-branch ref whose run id is an archive-check run on that branch count); ends a non-served check with a distinct, countable conclusion or title; counts failures from `ARCHIVE_REARM_AT`; allows at most one resumable restart per day; dispatches day D+1 only after day D is read done (OF-5) or its units are held in the store as a failed day's units. **Round 4 (OF-2 rulings 21–30, `docs/reviews/OF2.md`):** runs are read by `updatedAt`; a re-run (attempt > 1) of a commit without `archive-guard.sh`, a completed archive check from another branch, or a data-scan run from another branch whose scan job started or whose commit lacks the guard stops the chain; a scan job whose only failed steps are its guard steps is not a failure; the guard before QA skips the other-run and 60-min checks; `data-scan volume` runs are neither busy nor the lane's end; finalize, QA and the determinism rescan write their output next to the dataset, and the public log and summary carry only pass or fail, durations, unit counts and sizes; the back-off annotation is the one annotation of its own step, and a counted probe failure with none reads as `end=hold`; arming parses every archive-path workflow's permissions (explicit top-level `contents: read`, no `write-all`, no job with `contents: write` in any form, no repeated key); a Retry-After is trimmed before its strict parse; `unguarded-refs.sh` also lists branches with an unguarded `archive-check.yml`; red team (rulings 36–42): the scanner's output (plan and per-unit counts) goes to a private log next to the data, and arming refuses any `zeroed-scan` or QA call in `ci/*.sh` or a workflow `run:` block that prints to the job log (no subcommand is allowed to); archive workflows allow only `contents: read` and `actions: read` (`actions: write` only for archive-check's dispatch and data-scan's continue job), every other scope absent or `none`, and an upload-artifact only for `resume-` in the scan job; `unguarded-refs.sh` walks tags too; an off-branch archive check counts only if its commit lacks the guard or its probe ran; the volume-title skip holds only for a default-branch run of a guarded commit; the runs are read in 7-day created slices and per status, each failing closed when it reaches GitHub's 1,000-result search limit or returns fewer rows than it reports (rulings 49, 55, 61, 64), and in-progress and queued runs are listed on their own | `ci/archive-limits.conf`, `ci/archive-check.sh`, `ci/scan-day.sh`, `ci/check-day.sh`, `data-scan.yml` (plan job, `continue`) | test-ci: a holdout day (09-25), a day before 07-22 (07-21) and 09-21 refused by each of the four entry points, including a manual dispatch; **an unarmed manual dispatch refused; a manual dispatch after 3 failures refused; 07-23 with no retention value refused; 07-24 with `K2` refused**; a block 61 min ago → no request; a non-206 check 2 h ago → no request; armed with a different id → no request; two checks back to back → one dispatch; a marker 14 min old whose run is not listed → no request, 16 min old → the check proceeds; a marker on another ref, or whose run id is not an archive-check run on the default branch → ignored; the `storage-stop` marker present → a manual dispatch refused at the plan job, and refused by `scan-day.sh` and `check-day.sh`; `zeroed-data` unreadable → refused; `check-day.sh` unarmed, stopped or with no retention → refused; a K2 day's rescan runs with K2; a unit re-read on a K2 day uses K2 after `ARCHIVE_RETENTION` became K3; an unreadable cache list → no request; 3 failures after `ARCHIVE_REARM_AT` → no request; the same 3 failures before a later `ARCHIVE_REARM_AT` → a request; a second exit 75 on a day → counted; day D not stored → D+1 not dispatched |
| OF-3 | **Scanner revision frozen** for every batch from batch 1 (P2 for the archive path), with P11 (K2 and K3 as a per-unit recorded `retention` value, as today, `historical-data.md:94`) and P12 (fee-config history) inside it; **every day read at K2 and trimmed to K3 before storing, D's list = the days before D + D's own migrations from its K2 units, horizon migration + 300 min (PM-01 PREREG §3), K2 hashes in the per-unit log before the K2 raw is deleted, the K2 day's disk peak checked before any archive read (OF-3 rulings 2–5)**; a cached unit of another revision is refused, not re-read. **Retention step before batch 3:** batches 1 and 2 run with K2; the supervisor records both days' measured K2 and PM-01 sizes, both projections over the 31 read days (30 days; 31 with the 07-22 lead-in), the first-day bias and the choice (K3 if PM-01's projection is under 0.5 TB, otherwise stop and ask the owner) in DECISIONS, and sets `ARCHIVE_RETENTION` in the same change. **Trim tool:** writes `data-day-<day>-k3` as new releases (the K2 releases stay private as the measurement record, with the rescan unit's file hashes); re-runs finalize, strict QA and parity on the trimmed units; rewrites `SHA256SUMS-DAY` and the per-unit log; no archive read. Determinism of the trimmed day is shown by proof (§3): equal K2 bytes plus a deterministic trim give equal K3 bytes. **K3 scan and trim both take the pinned PM-01 migration list**, whose sha256 is in each unit's stats and the per-unit log; D+1's list is built only after D is read done. **Round 2 (OF-3 rulings 8, 9, 12–17):** a day after the first allow-listed day is refused (exit 2) before the disk guard, the back-off and any scanner call unless its verified prior list is present (OF-5); a restored day already trimmed (every unit K3, `units.log` present, `zeroed-scan unitlog -check` passing, `expect_units` met) is read done: `scan-day.sh` exits 0 with no request, `trim-day.sh` does nothing, check-day runs; `unitlog -check` requires exactly one k2 line per file of each K3 unit, each non-canonical file equal to its K2 hash, and no k2 line for a K2 or unknown unit; the k2 lines are sorted with `LC_ALL=C` by path; while the K2 day is read, free space on the scan volume below the largest unit so far + `ARCHIVE_TRIM_HEADROOM_BYTES` (5 GB) stops the scan between units and fails the day (exit 1, not resumable; the chain holds, OF-3 ruling 20); per unit the trim fsyncs its k2 lines to `units.log.partial` before the K2 copy is deleted and resumes from `units.k3`, that file and the kept list, and fails the day (exit 1, not resumable, ruling 20) once `ARCHIVE_TRIM_BUDGET_S` (1800 s, VERIFY on batch 1) is spent. **Round 3 (OF-3 rulings 18, 20–22):** both trim calls take `${ARCHIVE_PRIOR_LIST:--}` and `ARCHIVE_PRIOR_SUMS`, the inputs scan-day checks; a unit's k2 lines go to a temp file, then are appended and synced, a torn last line is dropped on resume, and the K2 copy is deleted only when the partial log holds one k2 line per `.zst` file of the unit; a restored trimmed day's list must match every unit's `migration_list_sha256` before it is copied; the K3 canonical file keeps every transaction with a pool instruction that writes a pool reserve account, read from the pinned AMM IDL (buy, sell, buy_exact_quote_in, deposit, withdraw, create_pool, init_boost, boost_buy_and_burn; the pinned IDL has no buyback instruction). **Batch 1 records the free disk on the `$RUNNER_TEMP` volume (VERIFY, ruling 17)** next to the K2 peak | `ci/scan-day.sh`, `scanner/`, a trim tool | test-ci: a unit of another revision → exit 2, no archive request; batch 3 with no retention record → no request; **a trimmed K2 unit equals a fresh K3 scan of the same unit with the same pinned migration list, byte for byte; trimming twice gives identical bytes** (final push item 43); a unit whose stats carry another list sha256 than the per-unit log is refused; the K2 release lists the rescan unit's hashes, equal to the day's unit; the trim makes no network request; finalize refuses a day mixing retention values |
| OF-4 | **Nothing public; storage stop after every batch.** `publish-day.sh` and `publish-volume.sh` write to `zeroed-data` (private), never to `GITHUB_REPOSITORY`; the `day-DAY` artifact is dropped or kept in the Actions cache only; the day release carries the per-unit log; the progress-cache entry is deleted only after every sha256 is read back; **after every batch** the stored total (K2 measurement releases included) plus the remaining allow-listed days × the largest K3 day so far must stay ≤ 0.5 TB, otherwise OF-4 writes the append-only `storage-stop` marker in `zeroed-data` (cleared only by a reviewed change with the owner's OK), the chain stops and the owner is asked; for batches 1 and 2 the per-day figure is the measured PM-01 subset of the K2 days. **The marker's form (OF-2 round 2, ruling 7): a published tag `storage-stop` in `zeroed-data`** (a published release with that tag; a draft release has no tag and does not count), which `archive-guard.sh` reads through `git/matching-refs/tags/storage-stop`. **K2 progress (OF-3 ruling 7):** a K2 day's progress (about 45 GB) does not fit the 10 GB Actions cache, so the continue job refuses the chained restart when the progress entry is missing or short of the day's finished units (`expect_units`); the day counts as failed and the chain holds for a decision. OF-4 decides whether K2 progress goes to private `zeroed-data` | `ci/publish-day.sh`, `ci/publish-volume.sh`, `data-scan.yml`, DATA-STORE scripts | test-ci: no archive-path step writes a release or an artifact to `GITHUB_REPOSITORY`; a read-back mismatch keeps the cache entry and fails the batch; after batch 5, a stored total plus 26 × the largest day of 0.51 TB → the `storage-stop` marker written and no further dispatch, 0.49 TB → dispatch; after batch 1, the projection uses the K2 day's PM-01 subset, not its K2 size; **the stop from both sides**: the tag OF-4 writes is the one `archive-guard.sh` refuses on (a draft release does not count) |
| OF-5 | **Completion from the private store, two predicates.** Today archive-check's queue and data-scan's skip step (`archive-check.sh:121`, `data-scan.yml:191-204`) read this repository. Both read `zeroed-data` instead and fail closed if it cannot be read. **Read done** (a `data-day-D` or `data-day-D-k3` release) drives the queue, the skip step and D+1 ordering. **B-10 done** (the `-k3` release for 07-22 and 07-23, the plain release for other days) drives only the `B10-PULL` row and the evaluator. **Prior list (OF-3 ruling 11):** every stored day, K2 or K3, carries its pinned `list-D.txt` (the K2 days write it with `trim-day.sh --list-only`); OF-5 hands day D the stored `list-<D-1>.txt` and that day's `SHA256SUMS` (`ARCHIVE_PRIOR_LIST`, `ARCHIVE_PRIOR_SUMS`), and `archive-guard.sh prior` refuses a list of another name or whose sha256 is not the stored one; until OF-5 wires the prior list, only 07-22 can be read; batch 2 (07-23) waits for OF-5 (OF-3 ruling 19) | `ci/archive-check.sh`, `ci/publish-day.sh --check`, `data-scan.yml` | test-ci: a day stored in `zeroed-data` is skipped; `zeroed-data` unreadable → no request and no dispatch; a day released only in this repository is not counted as done; **the K2 release `data-day-2026-07-22` is never B-10 done**, `data-day-2026-07-22-k3` is; **after batch 1's K2 release, the next served check dispatches 07-23, not 07-22; after both K2 releases with no retention record, it dispatches nothing** |
| OF-6 | **No second read of a margin unit; no whole-day re-read.** A unit already stored for the adjacent day is taken from the store, not read from the archive, so D+1 waits until D's units are stored (OF-2); the determinism rescan unit is the only routine second read. After a QA failure, only the units QA names are read again, with the day's recorded retention, and only after the owner is told; otherwise the day counts as missing and the owner is asked about a spare day | `ci/scan-day.sh`, `scanner/` (unit plan), `ci/check-day.sh` | test-ci: day D+1 after day D reads none of D's forward-margin units from the archive; the rescan reads exactly one unit; a QA failure naming 2 units re-reads exactly those 2 and only with the owner-told record present; a whole-day re-read of a failed day is refused |
| OF-7 | **Records before batch 1:** the Triton answer ("No reply") and the owner's "Store them" in DECISIONS (done in this PR); the `B10-PULL` row pinned by the supervisor (`B10-PULL id=… source=old-faithful scannerRev=<OF-3 revision> days=2026-07-22..2026-08-21 pinnedAt=…`); after the trim, its day releases for 07-22 and 07-23 are the `-k3` tags. **The row states (OF-3 ruling 10):** `data-day-2026-07-22-k3` lacks the pools migrated on 07-21 from 19:00 UTC (their 300 min windows reach into 07-22, but 07-21 is not read), so 07-22 is lead-in only | `docs/DECISIONS.md` | the evaluator and the research CLI refuse a run without the row (SPEC-A A-M11-01 step 8) |

**Not chosen for B-10 (owner, 8 Oct):** P3–P10 and P16 (Helius retry, exit, throughput and chain rules), P17–P20 (the
`B10-ACK` guards, the `b10-helius` environment, the P10 calibration), the `B10-ACK` rows, `botctl b10-reserve`, and the
B-10 window on Helius in A-M14-05. They are kept in the specs for the record, marked "not chosen".

## 6. Coverage evidence for B-10

A day is clean when, recomputed from its per-unit log in the store: every 4,500-slot unit the planner names for the
day is present with the pinned revision; finalize's parent chain is intact (`historical-data.md:83`); strict QA,
decoder parity and the determinism rescan pass (`check-day.sh:45-99`); and every file's sha256 matches
`SHA256SUMS-DAY`. These checks already run for every archive day; OF-4 adds the per-unit log to the stored release.

## 7. Owner answers and open owner question

1. Triton: "No reply" (8 Oct about 7:42 AM). Publishing stays off.
2. Storage: "Store them" (8 Oct about 7:42 AM), in the private `zeroed-data` repository only; about 0.2 to 0.5 TB, with
   the storage check after every batch (§3).
3. **Open (asked about 7:45 AM):** continue to 60 days (08-22 to 09-20) after the first 30? Until the owner says yes,
   those days are not in `ARCHIVE_DAYS`.
4. Owner step (no question): the DATA-STORE steps (the private repository, a fine-grained token, the secret and
   variable), if not already done.
