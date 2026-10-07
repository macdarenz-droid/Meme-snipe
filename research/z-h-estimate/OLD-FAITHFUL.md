# Z-H history from Old Faithful, in batches (card Z-H-OF)

Card Z-H-OF, docs only. Written 2026-10-07 UTC (8 Oct about 7:30 AM Melbourne). It turns the owner's decision of
8 Oct about 7:25 AM, **"Old faithful but by batch to avoid blockage"** (`CLAUDE.md` "History for the past-data test" on
`claude/supervisor-docs` @ `ee65f311`), into a batch plan for gate B-10's history replay. It replaces route "B", the
capped Helius download of PR #289 (Z0D-2).

**No archive request, workflow dispatch, download or code change was made for this card.** Research reads were single
requests to public documentation pages (§1). Labels as in `RESULTS.md`: **MEASURED**, **DERIVED**, **ASSUMED**,
**VERIFY**. `RESULTS` means `research/z-h-estimate/RESULTS.md` @ `c6c8496f`; `HANDOVER` means `HANDOVER.md` on
`claude/supervisor-docs` @ `7ddbba12`.

## 0. Bottom line

- **0 Helius credits.** B-10 reads the Old Faithful archive (`https://files.old-faithful.net`, `scanner/archive.go:23`)
  through the scanner and day pipeline that already exist (`data-scan.yml`, `ci/scan-day.sh`, `ci/check-day.sh`).
  No `B10-ACK`, no Helius reservation, no 31-day exclusivity and **no paper blackout** (paper delay 0).
- **Limits.** Triton documents **no** rate or bandwidth limit for `files.old-faithful.net` (§1). So the scanner's caps
  stay: **10 requests/s and 40 MB/s** (`ci/archive-limits.conf:5-6`), one lane, one unit × 4 connections (`:7-8`).
- **Batch = one UTC day.** One batch at a time, dispatched only by a served 64-byte `archive-check` (every 3 h), at
  least 60 min after the previous batch ended. Any 429, 403 or 503 stops the chain for at least 3 h; 3 failures stop it
  until the owner is told and the supervisor re-arms it (§2).
- **Days.** 2026-07-22 (lead-in) then 07-23 to 08-21: 31 days, oldest first. Then, for the 60-day target, 08-22 to
  09-20 (60 decision days). Never 2026-09-21 (a Helius day, ARCHIVE-NODUP), never 09-22 or later (`B3_CONTAMINATED`).
- **Time (DERIVED, VERIFY on batch 1):** about 2.4 h of reading per July day at 40 MB/s, about 3.4 to 3.8 h per batch
  with setup and QA; one batch per about 6 h if every check runs, so **about 8 days for the 31, about 12 to 16 if
  GitHub drops scheduled checks**; about 15 to 30 days for all 61.
- **Storage:** about 6.4 to 8.5 GB a day with today's retention, so **about 0.20 to 0.26 TB for 31 days**, plus the
  strategy-scoped raw records B-10 needs (PM-01's universe, since MR-01 is parked (C-76); size VERIFY). This replaces the 0.5 to 1.4 TB of
  RESULTS §6, which kept raw records of every canonical-pool transaction (§3).
- **Held** until #214, the batch scheduler and the private store have merged, the scanner revision is frozen and the
  Triton terms check is recorded (§5). **#214 must not merge before the scheduler**: alone, its first served check
  would dispatch 2026-09-20 and then the holdout days (§4).
- **#214 vs the 09-21 Helius cache: option (a)** (merge #214, drop the cache; 09-21 stays a Helius day and is not read
  from the archive) (§4).

## 1. The archive's documented limits and terms (VERIFY item 1)

Each source was read once on **2026-10-07 UTC (8 Oct Melbourne)** with a single request.

| Source | What it says | Limit for `files.old-faithful.net`? |
|---|---|---|
| <https://docs.old-faithful.net> | "Triton provides a full copy of this ledger at https://files.old-faithful.net that you can download"; "stored in Amsterdam, download using servers nearby for best throughput". No terms, licence or limit; no link to one | **None documented** |
| <https://docs.old-faithful.net/running-old-faithful/sourcing-data.md> | The Triton copy (OF1) "is currently free". No limit or licence | None documented |
| <https://docs.triton.one/core-features/ratelimits.md> | "1200 requests per 10 seconds" per IP for most methods on the shared RPC service; after a 429, pause all requests from that IP for 10 s. No page date | Applies to Triton's **RPC nodes**; the page never names Old Faithful or `files.old-faithful.net`, so it is **not** a documented archive limit |
| <https://docs.triton.one/project-yellowstone/old-faithful-historical-archive.md>, <https://docs.triton.one/chains/solana/old-faithful-historical-archive-1.md> | Old Faithful via a Triton subscription; "a separate, dedicated path". Nothing on the public file host | None |
| <https://triton.one/policies> | Lists a Privacy Policy, Cookie Policy, Terms of Use and California Privacy Policy; the fetched page held only the Privacy Policy text | The Terms of Use text was **not found** (`https://triton.one/terms-of-use` answered 404; no further URLs were guessed) |
| `docs/research/historical-data.md:32`, `:49` (2026-10-03) | "No usage terms published"; "Old Faithful's host terms (none published)" | Same finding, 4 days earlier |

**Caps (owner rule: ≤ 50% of the documented limit).** No limit is documented, so the scanner's caps stay, as the card
says: **`ARCHIVE_MAX_RPS=10`** and **`ARCHIVE_MAX_MBPS=40`** (`ci/archive-limits.conf:5-6`), `ARCHIVE_PARALLEL=1`,
`ARCHIVE_DL=4` (`:7-8`). For context only (not documented limits):
- MEASURED by us on 2026-10-03: the archive answered 429 "after ~0.6 TB in an hour from one machine"
  (`historical-data.md:87`), about 167 MB/s. 40 MB/s is 24% of that (DERIVED).
- At 40 MB/s with 16 MiB chunks (`scanner/scan.go:257`) the scanner starts about 2.4 requests/s (DERIVED), under the
  10/s cap. If Triton's RPC figure (120 req/s) did apply, 10/s would be 8% of it.
- A rate or bucket that Triton publishes or sends replaces these numbers in `archive-limits.conf` (`:2`).

**Today's code is above the request cap.** `scanner/archive.go:73` is `newLimiter(40)` and `polite.go:25` allows
80 MB/s; `archive-check` therefore dispatches nothing (fail closed, `ci/archive-check.sh:110-114`). PR #214 sets 10/s and
40 MB/s and makes any 429, 403 or 503 stop the run (§4).

**Terms: storing archive-derived data privately.**
- No Triton clause on storing, redistributing or deriving works from archive data was found (table above). Whether a
  private store needs Triton's permission is **unclear**: it cannot be settled from published text.
- `docs/DECISIONS.md:415` says "Triton's terms bar getting around a block … and bar a blocked user from seeking other
  Triton access without Triton's OK". No source for that text is recorded in this repo, and I could not find the Terms of
  Use page: **VERIFY**. The rule binds us anyway (owner, `CLAUDE.md` "never get around a block"; DECISIONS "No
  disguise", `:454`).
- `docs/DECISIONS.md:447`: "Publishing files derived from the archive waits on Triton." The owner emailed Triton on
  4 Oct (`:424`); no reply is recorded in this repo.
- **Today's pipeline publishes to this public repository**: `publish-day.sh:87` creates release `data-day-DAY` with
  `--repo "$GITHUB_REPOSITORY"`. That would publish archive-derived files, so it must be redirected to the private
  store before the first batch (§5, OF-4).
- Safest option taken: archive-derived files go only to the private data repository, never to a public release or log,
  until Triton's answer is recorded. The owner is asked whether Triton replied (§7).

## 2. The batch plan

**Batch unit: one UTC day.** It is the pipeline's existing unit: `scan-day.sh` scans one day (`:2`), `check-day.sh`
runs strict QA, decoder parity and a determinism rescan on it, and it is stored as one day release. Inside a day the
scanner works in 4,500-slot units, written atomically, so a stopped day resumes without re-reading finished units
(`historical-data.md:73-81`). A smaller batch (part of a day) gains nothing: one July day reads in about 2.4 h, inside
one job's 300-min budget (`data-scan.yml:23-24`).

**One batch at a time.** One archive lane: the `data-scan` concurrency group with `max-parallel: 1`
(`data-scan.yml:113-114`), and `archive-check` makes no request while any archive-lane run is active or queued
(`archive-check.sh:57-69`). `ARCHIVE_DAYS_PER_CHECK=1` (`archive-limits.conf:10`).

**What triggers the next batch.** Only a served `archive-check`: its cron is `41 */3 * * *` (`archive-check.yml:14`);
it makes one 64-byte range GET with the scanner's own User-Agent and dispatches the next day only on a 206 of at most
64 bytes (`archive-check.sh:71-98`). Chained runs never resume after a block (`scan-day.sh:146-148`, exit 4).

**Pause between batches (new, OF-2).** `archive-check` dispatches only if the last archive-lane run ended at least
**60 min** earlier. In practice the pause is longer: a batch of about 3.4 to 3.8 h spans one 3-hour check, so the next
served check comes about 2 to 2.6 h after it ends (DERIVED).

**Stop rules** (owner, `CLAUDE.md` 8 Oct):
- Any 429, 403 or 503 from the archive stops the scanner at once, never retried (PR #214 `isBlocked`), and holds a
  back-off of at least 3 h (`ARCHIVE_BACKOFF_S=10800`, `archive-limits.conf:9`); the run exits 4, not resumable
  (`scan-day.sh:146-148`; `check-day.sh:83-86` for the determinism rescan).
- **3 failures stop the chain (new, OF-2).** A failure is a batch that ends blocked (exit 4) or fails any other way
  (exit other than 0 and 75), or a check answered with anything but a 206. After 3 failures with no successful batch
  between them, `archive-check` makes no request and dispatches nothing. The supervisor reports it to the owner. The
  failure count is read from the runs themselves, not from a cache; if it cannot be read, the check refuses (fail
  closed).
- A day that needs a second resumable job (exit 75, budget spent) is resumed once; a second exit 75 on the same day
  counts as a failure (new, OF-2; today `MAX_CHAIN` is 12, `data-scan.yml:504`).
- Never get around a block: no other agent, host, address, proxy, client or Triton service (`archive-check.sh:19-22`,
  DECISIONS `:427`, "No disguise" `:454`).
- No identity change: the User-Agent stays `zeroed-historical-scanner/2 (research backtest; +https://github.com/macdarenz-droid/Meme-snipe)`
  (`scanner/archive.go:84`), and `archive-check` refuses to run if it is not found (`archive-check.sh:46-50`).

**How a stopped chain resumes.**
- After a block (fewer than 3 failures): the persisted back-off (at least 3 h) is slept out first by any later run
  (`polite.go:131-148`, `scan-day.sh:118`); the next served check redispatches the same day, which resumes from its
  finished units.
- After 3 failures: only by a reviewed change from the supervisor that re-arms the chain (it records the reason and
  the owner's message in HANDOVER), and never before the last back-off has ended. Nothing re-arms it automatically.

**Which strategy is replayed.** MR-01 is parked (C-76, owner 2026-10-08); B-10 replays the stage's strategy (PM-01
today, or a future strategy through the M09 slot). If none has reached gate B, the pull may still run, and its days wait
in the private store; B-10 stays pending until then.

**Day order** (clean span 2026-07-22 to 09-21, RESULTS §2 lines 87-89; window RESULTS §1 lines 53-55):
1. **B-10 window, oldest first:** 2026-07-22 (lead-in, post-BOOST: B2 is 07-21 14:23Z) then 07-23 to 08-21. 31 days.
   The archive held every epoch from 980 to 1047 on 2026-10-03 (`historical-data.md:227`), which covers them.
   Oldest first, so the lead-in is held before the first window day and a replay can follow chain order.
2. **60-day target:** 08-22 to 09-20, oldest first, only after the 31 have passed QA. With 07-23..08-21 that makes
   exactly 60 decision days (DERIVED: 9 + 31 + 20).
3. **Never:** 2026-09-21 (`HELIUS_DAYS`, `archive-limits.conf:15`; ARCHIVE-NODUP), 2026-09-22 to 10-20 (`B3_CONTAMINATED`,
   SPEC-A A-M13-06), any day before 07-22 (pre-BOOST), and any day in `W_R`. No past day can be in `W_R`, which comes
   from forward M07 data (RESULTS §2 line 89).
4. Today's queue must change: `archive-check.sh:104-108` queues 09-21 back to 07-20, then the holdout days 10-01 back to
   09-22. OF-2 replaces it with the list above, read from one reviewed file.

**Expected time (DERIVED; VERIFY on batch 1).**

| Days | Mean slot (RESULTS §3 table, lines 171-174) | Blocks a day | Read a day at 1.65 MB a block | Reading at 40 MB/s |
|---|---|---|---|---|
| 07-22 to 08-20 (30) | 420.1 ms | about 205,700 | about 339 GB | about 2.4 h |
| 08-21 to 08-27 (7) | 368.0 ms | about 234,800 | about 387 GB | about 2.7 h |
| 08-28 to 09-17 (21) | 317.9 ms | about 271,800 | about 448 GB | about 3.1 h |
| 09-18 to 09-20 (3) | 269.2 ms | about 321,000 | about 530 GB | about 3.7 h |

- 1.65 MB a block is the October figure (`historical-data.md:85`); July blocks may differ (**VERIFY**: batch 1's
  `statBytes`). Skips lower the count by at most 1% (RESULTS §3 line 155).
- Per batch: about 15 min setup and restore (ASSUMED, RESULTS line 232), the reading above, and at most 45 min of
  QA, packaging and storing (`data-scan.yml:23-24`): **about 3.4 h for a July day, up to about 4.7 h for a 250 ms day.**
- Cadence: a batch longer than 3 h makes the next check find the lane busy, so at best one batch per 6 h (DERIVED).
- **31 days: about 7.75 days at best.** GitHub drops scheduled runs under load (HANDOVER:1350: "the cron
  checks at 03:41Z and 09:41Z never ran"); if every other check is dropped, about 12 to 16 days. Each block adds at
  least 3 h, and 3 failures stop the chain until re-armed.
- **All 61 days: about 15 days at best, about 30 with dropped checks** (DERIVED).
- Reading total: about 10.6 TB for the 31 days and about 23.9 TB for all 61 (DERIVED from the table).

## 3. Storage per batch

**What B-10 needs** (RESULTS §5, §6): rows for every bonding-curve and canonical-pool trade, every event, holder
movements, the raw records the engine's own decoder reads for the strategy's trades, and every create and migration
raw record. Today's retention already keeps every curve and canonical-pool trade and every event
(`historical-data.md:94`), creates and migrations raw (`:166`), and raw records for a 5% hash sample.

| Option | Per day | 31 days | Note |
|---|---|---|---|
| K1 today's units (rows + 5% sampled raw + creates and migrations) | 6.4 to 8.5 GB (`historical-data.md:230`, ±50%) | **0.20 to 0.26 TB** | The engine's decoder sees raw records only for sampled mints |
| K2 RESULTS P11: raw for **every** canonical-pool transaction | about 17 to 45 GB (RESULTS:348) | 0.5 to 1.4 TB | RESULTS §6 |
| **K3 (recommended): K1 + raw records for the replayed strategy's universe only** | PM-01: raw records for the canonical pools of mints that migrate inside the lead-in or window, from migration to the end of PM-01's holding horizon; not estimated (**VERIFY**), K2 is its upper bound | PM-01: between K1 and K2 | MR-01 is parked (C-76, owner 2026-10-08), so its universe (RESULTS:347: 0.2 to 8 GB a day) is not kept |

- K3 keeps what the B-10 replay needs: the engine's own decoder reads every swap of the strategy's universe, and the
  rest stays rows. With MR-01 parked (C-76), the replayed strategy today is PM-01. K3 must be in the frozen scanner
  revision before batch 1: changing retention later means reading the same days again, which the owner's "never
  download a day twice" forbids (`archive-limits.conf:11-12`).
- **Risk:** a future strategy entering through the M09 slot whose universe lies outside PM-01's (for example a revised
  MR version on old deep pools) would find only rows and sampled raw records for these days. Its B-10 replay would then
  need either K2 now (0.5 to 1.4 TB) or a second read of the same days, which needs the owner. The supervisor decides
  K3 or K2 before OF-3 freezes the revision.
- Sizes come from October activity (±2×, RESULTS line 341); July is VERIFY on batch 1.

**Where it is kept.** Day releases in the **private** data repository `macdarenz-droid/zeroed-data` (DATA-STORE #150),
never in this public repository (§1). Each release keeps its tar parts under 2 GiB (`historical-data.md:222`), its QA
report, manifest, parity report and `SHA256SUMS-DAY`, plus the per-unit log of §6 (OF-4). Nothing goes to the 2 GB
host (D29).

**What is deleted after each batch.**
- The runner's units, QA dataset and rescan: the runner is discarded; packaging already deletes units as it tars them
  (`tar --remove-files`, `historical-data.md:220`).
- The day's Actions progress-cache entry, once the stored release has been read back and its sha256 sums match (new,
  OF-4; today it is left to least-recently-used eviction, `historical-data.md:221`). This keeps the 10 GB repository
  cache free for the next day.
- The archive's CAR bytes are never stored: they are streamed and decoded (`historical-data.md:58`); only small
  per-epoch boundary files are cached.
- Nothing is deleted from the store until B-10 has passed and its evidence is bundled: the replay reads it.

**GitHub size question.**
- Release limits: under 2 GiB a file, at most 1,000 assets a release, "no limit on the total size of a release, nor
  bandwidth usage" (GitHub "About releases", quoted in RESULTS:378-380, fetched 2026-10-07).
- Acceptable Use §9 "Excessive Bandwidth Use" lets GitHub throttle, suspend the account, or delete a repository after
  notice (RESULTS:381-386). No threshold is published. At about 0.2 to 0.5 TB this is smaller than the 0.5 to 1.4 TB
  RESULTS weighed, but whether it counts as "significantly excessive" is **not confirmed**. The account at risk also
  hosts this project. The owner accepts or avoids this risk (§7).
- Whether a private repository's release assets count against an account storage quota is **VERIFY** (not checked).

## 4. #214 and the 09-21 Helius progress cache

**Facts.**
- PR #214 (ARCHIVE-SAFE B): open, head `e48d71df`, base `ccr-14987baf-i6lrsl` at the stale `efa3b006`, last updated
  2026-10-05 13:05Z (read through the GitHub API on 2026-10-07). It sets `reqLimiter` to 10/s, `maxAllowedMBps` to 40,
  `-max-mbps` default 40, and stops on any 429, 403 or 503 (`scanner/archive.go`, `polite.go`, `main.go`). Data PASS at
  `e48d71df` (HANDOVER:1346).
- It changes the scanner tree, so the scanner revision (`ci/scanner-rev.sh:10`, the git tree of `research/historical/scanner`)
  and the rpcscan revision (`ci/rpcscan-rev.sh:9`, which embeds it) both change. `scan-day.sh:104-116` and the RPC path
  rescan every cached unit of another revision, so the about 66 cached 09-21 Helius units (RESULTS §2 line 136; HANDOVER:1295 notes a later run restarted from
  0, so the exact count is VERIFY from the cache entry) become useless.
- 09-21 is a Helius day (`HELIUS_DAYS="2026-09-21"`, `archive-limits.conf:15`); 13 of its 79 units are unread.
- **#214's own test shows the risk of merging it alone:** with the cap at 10/s, a served check dispatches
  `days=2026-09-20` (#214 `test-ci.sh`), and the queue then reaches the holdout days 10-01 to 09-22
  (`archive-check.sh:104-108`). So #214 merges **after or with** OF-2's queue change, never before it.

**Options.**

| | (a) Merge #214, drop the 09-21 Helius cache | (b) Keep the cache valid by changing how the revision is computed | (c) Finish 09-21 on Helius first |
|---|---|---|---|
| Credits | 0 | 0 | About 58,500 to 79,000 (DERIVED: 13 units × 4,501 = 58,513 base; with the determinism rescan unit and 25% retries, 14 × 4,501 × 1.25 = 78,768; RESULTS §3 lines 153-160) |
| Owner approval | None | None | **Needed**: the owner's 8 Oct rule says no Helius credit is spent on this history ("Helius headroom stays unused … with no exception") |
| Risk | 09-21 is lost as a Helius day; it is outside the B-10 window anyway | The revision is the guarantee that "a day never mixes revisions" (`scan-day.sh:104-106`). Excluding `archive.go`/`polite.go` from it needs a proof that they never change a row, its own review, and a precedent for future exclusions | Spends credits for a day B-10 does not use; delays #214 and the whole archive route until the run finishes |
| 09-21 later | Not read from the archive while it is in `HELIUS_DAYS`. If it is ever wanted, one reviewed change removes it from `HELIUS_DAYS` and drops the partial Helius units first, so the day never mixes sources and is read once from one source | Kept | Complete on Helius |

**Recommendation: (a).** 09-21 is not in the B-10 window (07-22..08-21) nor needed for the 60-day target (08-22..09-20
gives 60); it is incomplete (66 of 79); MIGRATION A02 (`docs/MIGRATION.md:412`) bars data collected before 2026-10-07
from any Blueprint gate, so the cached units could serve research only; (b) weakens a correctness guarantee to save a
research day; (c) spends credits the owner's 8 Oct rule withholds. Under (a) the DATA-KEEP refresh of the 09-21 entry
(HANDOVER:627) stops, and the entry expires.

**Owner rule "no duplicate days between archive and Helius"** (HANDOVER:1349, 6 Oct about 12:12 AM). Under (a) it holds: 09-21
stays in `HELIUS_DAYS`, so `archive-check`, `scan-day.sh` and `check-day.sh` refuse it (`archive-check.sh:119`,
`scan-day.sh:69-71`, `check-day.sh:22-24`), and no B-10 day is a Helius day. B-10 now reads no Helius day at all.

## 5. Prep list for the Old Faithful route (replaces P10 and P17–P20 for B-10)

Each item merges with its file and a test that fails before and passes after. Kept from the Z-H prep list: P2, P11,
P12, P13, P14 (as adapted below), P15; **P21 and the account-ledger rules stay**, because they cover every Helius
workflow, not only B-10.

| # | Item | Files | Test |
|---|---|---|---|
| OF-1 | **#214 merged**: base merge onto the integration head, fresh data review, CI green on the exact head; merges after OF-2 (or in the same merge window, OF-2 first) | `scanner/archive.go`, `polite.go`, `main.go`, `polite_test.go`, `ci/test-ci.sh` | #214's tests (`TestPlain503And403StopLikeA429`, `TestRequestCapIsTenPerSecond`, `TestMaxMbpsRange`) |
| OF-2 | **Batch scheduler**: the queue becomes one reviewed list (07-22..08-21, then 08-22..09-20), never `HELIUS_DAYS` or days ≥ 2026-09-22; dispatch only ≥ 60 min after the last archive-lane run ended; 3 failures stop the chain (read from the runs, fail closed); at most one resumable restart per day | `ci/archive-check.sh`, `ci/archive-limits.conf`, `data-scan.yml` (`continue`) | test-ci: a holdout day or 09-21 never queued; a run ended 59 min ago → no request; 3 failures → no request; a 4th check after a success → dispatch; a second exit 75 on a day → failure |
| OF-3 | **Scanner revision frozen** for every batch (P2 for the archive path): a day whose cached units carry another revision is refused, not rescanned, once batch 1 has run; P11 (K3 retention, §3) and P12 (fee-config history) are in that revision | `ci/scan-day.sh`, `scanner/` | test-ci: a unit of another revision → exit 2, no archive request |
| OF-4 | **Private store per batch** (P13, P14 adapted): `publish-day.sh` writes to `zeroed-data`, never to this public repository; the day release carries the per-unit log (unit range, revision, file sha256, blocks, bytes, CID checks); the progress-cache entry is deleted only after read-back of every sha256 | `ci/publish-day.sh`, `data-scan.yml`, DATA-STORE scripts | test-ci: publish to `GITHUB_REPOSITORY` refused; a read-back mismatch keeps the cache entry and fails the batch |
| OF-5 | **Triton terms check recorded**: the owner's answer on Triton's reply (§7) and the Terms of Use text, or a recorded "not found", in DECISIONS before batch 1 | `docs/DECISIONS.md` | supervisor check before the `B10-PULL` row is pinned |
| OF-6 | **`B10-PULL` row pinned** by the supervisor (SPEC-A A-M13-06): id, `source=old-faithful`, the frozen revision, the day list | `docs/DECISIONS.md` | the evaluator and the research CLI refuse a run without it (A-M11-01 step 8) |

**Not chosen for B-10 (owner, 8 Oct):** P3–P10 and P16 (Helius retry, exit and throughput rules for the Helius pull),
P17–P20 (the `B10-ACK` guards, the `b10-helius` environment, the P10 calibration), the `B10-ACK` rows, `botctl
b10-reserve`, and the B-10 window on Helius in A-M14-05. They are kept in the specs for the record, marked "not chosen".

## 6. Coverage evidence for B-10

A day is clean when, recomputed from its per-unit log in the store: every 4,500-slot unit the planner names for the
day is present with the pinned revision; finalize's parent chain is intact (`historical-data.md:83`); strict QA,
decoder parity and the determinism rescan pass (`check-day.sh:45-99`); and every file's sha256 matches
`SHA256SUMS-DAY`. These checks already run for every archive day; OF-4 adds the per-unit log to the stored release.

## 7. Questions only the owner can answer

1. Has Triton answered your 4 Oct email, and if so, what did it allow (rate, publishing or storing derived files)?
2. Do you accept keeping about 0.2 to 0.5 TB of archive-derived day files in the private `zeroed-data` repository,
   knowing GitHub publishes no size threshold and may throttle or suspend an account it finds "significantly
   excessive"?
3. Owner step (no question): the DATA-STORE steps (the private repository, a fine-grained token, the secret and
   variable), if not already done.
