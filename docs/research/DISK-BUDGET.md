# Disk budget: the 2 GB Vultr host

Research, docs only. Base `ccr-14987baf-i6lrsl` @ `1e4df569` (Merge #301, Z02). Written 8 Oct 2026, about 11:55 PM Melbourne time.
No server was contacted. Every number is either cited from the repo, measured in this container (marked **measured**), derived from cited inputs (marked **derived**), or **UNVERIFIED** with a range. The first 48 h of Phase 0 recording must replace the estimates (ARCH M07, `docs/blueprint/ARCH.md:1076`).

Owner rules this budget serves:
- "Disk cycle" (`CLAUDE.md:79`): a day of trading can never fill the disk. The ledger, saved state and journal are never deleted.
- "Recordings upload approved" and "Recording uploads are for study only" (`CLAUDE.md:78`, `CLAUDE.md:80`): a recording is deleted only after its uploaded copy is checked by sha256 read-back; uploads stop at production level, but the local auto-delete stays.
- "Carried from the Blueprint build" (`CLAUDE.md:108`).

## 1. Summary

- **The biggest risk is the hourly backup, not the recorder.** `zeroed-backup` keeps 72 copies (`ops/host/files/usr/local/sbin/zeroed-backup:12`). Each copy is a plain tar of every SQLite file, encrypted with age and **not compressed** (`:31`). So the backups take about 72 × the ledger's size. The ledger's `metric_rollup_1m` table alone may grow to 4 GiB (`packages/engine/src/m27/config.ts:21`). At that size the backups would need about 300 GB. On the current keep rules the disk fills in **about 8–17 days at design rates, and about 2 days in the worst case** (derived; §4).
- **Today the Blueprint ledger is not backed up.** M24's default database path is `/var/lib/bot/bot.db` (`packages/engine/src/m24/config.ts:9`). The M27 log folder is `/var/lib/bot/log` (`packages/engine/src/m27/config.ts:19`). The M07 recorder writes to `/data/md` (`docs/blueprint/SPEC-A.md` A-M07-02). The host backs up only `/var/lib/zeroed` (`zeroed-backup:9`). The worker unit runs with `ProtectSystem=strict` and `StateDirectory=zeroed` (`ops/host/files/etc/systemd/system/zeroed-worker.service:32,44`), so it cannot write to `/var/lib/bot` or `/data` at all. Once these paths are aligned, the 72× backup multiplier applies. Recommendation R1 must land **before** the paths are aligned.
- **Usable space: about 51 GB for the worker's user** (estimate; §3).
- **Steady state on the current rules: it does not reach one.** The backup term outgrows the disk (§4).
- **Steady state with the recommendations: about 15–27 GB in year 1** (derived; §5). That leaves about 24–36 GB free.
- **Fill date if nothing is pruned: about day 7–10 after the Blueprint engine and recorder start at design rates, and about day 2–3 in the worst case.** Without the backups it is about day 50–107, or day 16 in the worst case. Nothing runs yet (`ops/host-config.json` has `"worker": "stub"`). Counted from today (8 Oct 2026), that is about 15–18 Oct at design rates and 10–11 Oct in the worst case. The real date counts from the start day, which is not set.

## 2. Every grower

Units: GB = 10^9 bytes, GiB = 2^30 bytes. "Design rate" means the spec's rate. "Worst" means the largest that the code's caps allow, or the spec's worst case.

### 2.1 Fixed or nearly fixed

| Item | Where | Size now | Keep / prune rule | Steady | Worst |
|---|---|---|---|---|---|
| Ubuntu 24.04 base, packages | `/` | UNVERIFIED, 2.5–4 GB | apt `AutocleanInterval 7`, `Remove-Unused-Dependencies true` (`ops/host/files/etc/apt/apt.conf.d/20auto-upgrades`, `52zeroed-unattended-upgrades`) | 2.5–4 GB | 4 GB |
| Old kernels (no auto reboot, `Automatic-Reboot "false"`) | `/boot`, `/usr/lib/modules` | UNVERIFIED, about 0.3 GB per kernel | Ubuntu removes unused kernels on upgrade; the running one stays until a reboot | 0.6–1 GB | about 1.5 GB if reboots are rare |
| apt cache | `/var/cache/apt` | UNVERIFIED | autoclean every 7 days removes only obsolete .debs | 0.1–0.5 GB | 0.5 GB |
| Node v22.23.3 | `/opt/node-v22.23.3` (`ops/host/install-main.sh:35,197-201`) | UNVERIFIED, about 0.2 GB unpacked | replaced on a version change (old folder removed, `:197`) | 0.2 GB | 0.2 GB |
| journald | `/var/log/journal` | — | `SystemMaxUse=500M`, `SystemKeepFree=2G` (`ops/host/files/etc/systemd/journald.conf.d/zeroed-journal.conf`) | ≤ 0.5 GB | 0.5 GB (0.524 GB) |
| Tailscale (opt-in) | `/usr` | UNVERIFIED, about 0.05–0.1 GB | apt | 0.1 GB | 0.1 GB |
| Worker crash reports | `/var/lib/zeroed/reports` | small | newest 5 (`ops/host/files/usr/local/lib/zeroed/worker-start`, "Only the newest 5") | < 10 MB | < 50 MB (UNVERIFIED report size) |

### 2.2 Code and releases

| Item | Rate | Keep / prune rule | Steady | Worst |
|---|---|---|---|---|
| **Release folders** `/opt/zeroed/releases/<sha>`: a `git archive` of the deploy commit (`zeroed-update:379-382`); **no node_modules** (no `pnpm`/`npm` install anywhere in `ops/host`, checked by grep) | One folder per deploy. **Measured**: `git archive 1e4df569` unpacks to 82 MB on disk (79.0 MB apparent, 2,552 files). The task brief's "about 68 MB" (`logic.sh:228`) is out of date. The archive grew from 41.2 MB at `1ffb8ec6` (3 Oct) to 79.0 MB at `1e4df569` (8 Oct), **about 7.5 MB a day** (measured; extrapolating it is an estimate). By folder: `research/` 25.6 MB, `docs/` 20.1 MB, `apps/` 14.1 MB, `packages/` 14.0 MB (measured). | `prunable_releases` (`ops/host/files/usr/local/lib/zeroed/logic.sh:224-239`): it keeps current, previous, the deploy tag's commit, and the 3 newest others. That is **5 folders** (6 when the tag is not current). No age rule. | 5 × 82 MB = **0.41 GB** now | 6 folders; if repo growth stays linear: 6 × (82 + 7.5 × days) MB, which is **about +16 GB a year** (estimate) |
| **Git clone** `/opt/zeroed/repo` (`zeroed-update:18,309`): a full-history fetch of one branch and the tag; no `gc` or depth limit is set | GitHub reports the repo at 118,594 KB (all refs; GitHub API, 8 Oct), created 3 Oct, so about 20 MB a day at most (UNVERIFIED; only one branch is fetched) | none (git's auto-gc only packs; it never drops history) | 0.05–0.12 GB now | +2–7 GB a year (UNVERIFIED) |

### 2.3 Blueprint recorder (M07; Z04 queue → A-M07-02 segments)

- **Z04** (`claude/z04-recorder-queue` @ `9bd1ba4c`, not on base) is an in-memory bounded queue: 50,000 records and 64 MiB (`packages/engine/src/recorder/queue.ts:128-129` on that branch). It writes **nothing to disk** itself. The disk output comes from the A-M07-02 segment writer, which is not built yet (Z08, `docs/MIGRATION.md:785`).
- Design rate (`docs/blueprint/ARCH.md:1076`, CB-26, DERIVED worst case): 30 pools × 1 Hz × about 600 B gives about 1.56 GB a day raw. About 20% is added for 2 Hz position pools and eviction tails, about 1.87 GB a day. zstd at an **assumed** 3–5× gives **0.31–0.52 GB a day** (the spec's own figure; ASSUMPTION). Change-only deltas should be smaller (A-M07-01 step 2).
- `poll_counts`: 30 pools × 1,440 minutes a day × about 120 B is about 5 MB a day raw (derived; the 120 B is UNVERIFIED).
- Keep rule (spec only; not built): segments stay 30 days on the host, then are deleted **only with a valid `PullReceipt`** (A-M07-03 step 2; `ARCH.md:1077,1078`). Above 80% disk, receipted segments are deleted oldest first. Above 95%, every stream stops except `universe_manifest` and `coverage`.
- Per year: 113–190 GB at the design rate, so retention is mandatory.

| | Per day | 30-day steady | Worst |
|---|---|---|---|
| Design (zstd 3–5×) | 0.31–0.52 GB | **9.3–15.6 GB** | — |
| No compression gain (gzip fallback poor, or every poll changes, UNVERIFIED) | up to 1.87 GB | 56 GB (over the disk) | the 80%/95% thresholds decide. Without receipts nothing is deleted and recording stops at 95%. |

Note: the old Zeroed recorder measured 4.5–7 GB a day (`HANDOVER.md:1050`; `PROJECT_STATE.md:90`). That was a different design (frames of every candidate). It does not predict M07's rate, but it shows that a spec estimate can be 20–30× low (`HANDOVER.md:1050`, "the old 0.15–0.25 GB/day estimate was 20–30× low").

### 2.4 Old Zeroed recorder and the upload (present on the host, idle today)

| Item | Rate | Keep rule | Steady | Worst |
|---|---|---|---|---|
| `/var/lib/zeroed/recorder` (`packages/worker/src/run/recorder.ts`) | 4.5–7 GB a day measured on the 1 GB host (`HANDOVER.md:1050`). It runs only when `ops/host-config.json` says `"worker": "release"`; today it says `"stub"`, and "No bugs migrate" bars the Zeroed worker (`CLAUDE.md`, Blueprint section) | RECORD-BUDGET: a cap of 8 GiB (`ZEROED_RECORDER_MAX_BYTES`) and a free floor of 3 GiB, pruning back to 3.5 GiB free (`packages/worker/src/run/recorder-budget.ts:23-28`), every 60 s (`:30`) | 0 now; 8.6 GB if run | 8.6 GB (cap), plus the running boot's plain `.jsonl` files, which are never pruned (`:13`) |
| Upload state `/var/lib/zeroed-record-upload` | small | `state.json` pruned of finished boots (`ops/host/files/usr/local/lib/zeroed/record-upload.mjs:704-708`); `delete after upload` on (`ops/host-config.json` `record_upload_delete_local: true`) | < 10 MB (UNVERIFIED) | < 50 MB |
| Zeroed `journal.jsonl` | only while the Zeroed worker runs | never deleted (owner, "Disk cycle") | 0 now | grows without a cap; not sized here because the Zeroed worker is barred |

### 2.5 SQLite ledger (M24; Z02 merged in #301)

Retention per table: ARCH 15 (`docs/blueprint/ARCH.md:2675-2718`), implemented in `packages/engine/src/m24/schema.ts` and deleted by `deleteExpired` (`packages/engine/src/m24/retention.ts:23-42`). Who calls `deleteExpired`, and how often, is not on base (UNVERIFIED). Until a scheduler runs it, **nothing in the ledger expires**.

| Table | Rate (derived; inputs UNVERIFIED unless cited) | Retention (`schema.ts` line) | Steady | Worst |
|---|---|---|---|---|
| `metric_rollup_1m` | 87 B a row, measured (`schema.ts:356-357`), so one series every minute is about 125 kB a day (`schema.ts:358`). The catalog has 139 metrics: 3 labelled by pool, 68 with no labels, and the rest with labels such as provider or stream (`packages/engine/src/m27/catalog.ts`, counted). Aggregate series: UNVERIFIED, 150–1,000, so **19–125 MB a day**. Pool series: about 120 (3 metrics × 30 pools, × providers), about 15 MB a day. The Z02 builder's figure of about 9.1 GB a year (per-pool series kept 1 year) matches about 200 series × 125 kB × 365 (derived); that figure was not found in the repo's text. | aggregate 366 days, pool 7 days (`schema.ts:366`; `docs/DECISIONS.md:128`). The byte cap `m27.rollup_max_bytes` defaults to 4 GiB, settable from 64 MiB to 16 GiB (`m27/config.ts:21`). At the cap, pool rows go first, then aggregate rows (`repos.ts:222`). | aggregate rows reach the 4 GiB cap in 34–229 days (derived), so **4.3 GB** | 4.3 GB at the default; 17.2 GB if raised to the 16 GiB maximum. With all 5,000 series (`m27.series_cap`, `config.ts:9`) it fills at about 0.6 GB a day (`DECISIONS.md:128`). |
| `bar_1m` | 30 pools × 1,440 a day × about 150 B, about 6.5 MB a day | 90 days (`schema.ts:346`) | 0.6 GB | about 1 GB with eviction tails |
| `screen_result` | about 1,000 screens a day (the old worker saw 1,086, `HANDOVER.md:1048`) × about 2 KB `checks_json`, about 2 MB a day | 1 year (`schema.ts:135`) | 0.73 GB | 2–3 GB if checks are larger (UNVERIFIED) |
| `wallet_snapshot` (30 s rows) | 2,880 a day × about 300 B, about 0.9 MB a day | 30 days, daily rows 2,557 days (`schema.ts:264`) | 26 MB | — |
| `candidate`, `signal`, `alert`, `reconcile_run`, `sandwich_check`, `quarantine` | ≤ 1–2 MB a day together (UNVERIFIED) | 1 year (`schema.ts:142,151,268,232,314,354`) | ≤ 0.7 GB | — |
| Trades, fills, orders, audit, equity (`equity_point` 1 a minute per mode, about 0.2 MB a day) | small (≤ 20 trades a day, `ARCH.md:324`) | 7 years (Y7) | < 0.1 GB a year | — |
| `outbox` | UNVERIFIED | 7 days (`schema.ts:370`) | UNVERIFIED, likely < 50 MB | — |
| WAL, indexes, free pages | SQLite overhead; indexes UNVERIFIED, +20–50% | `VACUUM` is not run anywhere on base (grep), so deleted pages are reused, not returned | +20–50% | — |

**Ledger total, derived:** growth of about **35–75 MB a day** at design rates (rollups dominate), and about 0.6 GB a day in the worst case (all 5,000 series). Steady state in year 1: **about 6–8 GB** (4.3 GB rollups plus 1.5–3 GB of other tables plus overhead). If `m27.rollup_max_bytes` is raised to 16 GiB, the worst is about 20 GB. ARCH D06 names "database > 20 GB" as a switch trigger (`ARCH.md:1700`).

### 2.6 Hourly backups

| Item | Rate | Keep rule | Steady | Worst |
|---|---|---|---|---|
| `/var/backups/zeroed/zeroed-*.tar.age` (`zeroed-backup`; `zeroed-backup.timer` `OnCalendar=hourly`) | 24 a day × the size of every `*.sqlite`/`*.db` under `/var/lib/zeroed`. tar + age, **no compression** (`zeroed-backup:31`) | the newest **72** (`ZEROED_BACKUP_KEEP`, `zeroed-backup:12,33`). ARCH says 48 (`ARCH.md:1077`, `:2718`). | **72 × ledger**: at a 6–8 GB ledger, **430–580 GB** | — |
| Working copy | each run makes a full snapshot in a private `/tmp` (`zeroed-backup:18-23`, `PrivateTmp=yes`) on the root disk | removed at exit | 0 | **1 × ledger** at run time, on top of the above |
| Off-site copy | daily over Telegram, only under 49 MB (`zeroed-backup-offsite:25`); `offsite_backup: false` | — | 0 local | — |

At the ledger's design growth, 72 copies pass the free space when the ledger reaches about 0.4–0.5 GB. That happens around day 5–14 (derived, §4).

### 2.7 Logs (M27)

| Item | Rate | Keep rule | Steady | Worst |
|---|---|---|---|---|
| JSON-lines logs, `m27.log_dir` default `/var/lib/bot/log` (`m27/config.ts:19`) | UNVERIFIED, 0.05–0.25 GB a day. Debug and info lines stop at `m27.log_max_bytes_per_day` 256 MiB, but warn and above are **always kept** (`config.ts:15-16`), so the per-day figure is not a hard cap. | `m27.log_retention_days` 14 (`config.ts:11`); ARCH: 14 days of logs (`ARCH.md:1077`) | 0.7–3.5 GB | 14 × 268 MB = **3.8 GB**, plus warn floods (no cap) |

### 2.8 Other writers under /var/lib/zeroed* and /opt/zeroed

- `/var/lib/zeroed-host` (update journal, owner backup recipient, release-units; `zeroed-update`, `install-main.sh`): small.
- `/var/lib/zeroed-index`, `/var/lib/zeroed-dryrun/evidence` (`ops/host/files/usr/local/lib/zeroed/common.sh:11-12`): dry-run evidence. Size UNVERIFIED; no prune rule found on base.
- `/var/lib/zeroed/open_intents`, `open_positions`, `refused.json`: bytes.
- `/var/lib/zeroed-signer`: stand-in; small.
- `/opt/zeroed/stub`, `/opt/zeroed/current*`: symlinks and two small files.

## 3. Usable space

- Disk: 55 GB SSD (`docs/blueprint/ARCH.md:1711`). Whether Vultr's "55 GB" means 10^9 or 2^30 bytes is UNVERIFIED. 55 × 10^9 bytes is used here, the smaller of the two.
- Filesystem: ext4 metadata (inode tables, journal) takes about 1.5–2%, so the filesystem size is about 54 GB (estimate; the installer's D07 note says it is "smaller than 55 GB, not measured", `ops/host/install-main.sh:57-58`; floor 40 GB by size, `:61`).
- ext4 reserves 5% for root by default (UNVERIFIED on Vultr's image), so `bavail` for the worker's user is about **51 GB**. RECORD-BUDGET reads `bavail` (`recorder-budget.ts:81-84`), so its floor counts from this figure. `zeroed-backup` runs as root and may eat into the reserve.
- Fixed items (§2.1–2.2): **about 4.5–5.8 GB**, which leaves **about 45–47 GB** for growers.

## 4. Fill dates (derived model)

Day 0 is the day the Blueprint engine (ledger, logs, backups of it) and the M07 recorder start on the host. Inputs per day:

| Scenario | Recorder | Logs | Ledger growth | Releases + repo |
|---|---|---|---|---|
| Design low | 0.31 GB | 0.05 GB | 35 MB | 42 MB |
| Design high | 0.52 GB | 0.256 GB | 75 MB | 58 MB |
| Worst | 1.87 GB | 0.256 GB | 600 MB | 58 MB |

| Scenario | Nothing pruned, no backups | Nothing pruned, hourly backups never deleted (about 12 × r × d² GB) | **Current keep rules** (recorder 30 d, logs 14 d, backups 72, rollups ≤ 4 GiB, 5 releases) |
|---|---|---|---|
| Design low | day 107 | day 10 | day 17 |
| Design high | day 50 | day 7 | day 8–9 |
| Worst | day 16 | day 2 | day 2 |

Model (hourly steps; a reviewer can rerun it from this line): `used = F + (R + G + rel + repo) × d + L(d) + backups(d)`, with `L(d) = r × d` and `backups = Σ L` over the kept copies.

Before day 0 (today): the stand-in writes almost nothing, and only the fixed items count.

## 5. Recommendations

Each item names the owner rule it serves, the exact change, and where. None of them deletes the ledger, saved state or journal ("Disk cycle", `CLAUDE.md:79`). Backups are copies, so removing old backup files does not touch the ledger.

| # | Change | Where | Effect |
|---|---|---|---|
| R1 | **Bound the backups by bytes and compress them.** Pipe through `zstd` before `age`, add `ZEROED_BACKUP_MAX_BYTES` (proposed 6 GB), keep the newest 24 hourly plus one a day for 7 days within that budget, and alert when even the newest copy exceeds the budget. Change ARCH's "48 hourly" (`ARCH.md:1077`, `:2718`) to that budget. **This must land before R2.** | `ops/host/files/usr/local/sbin/zeroed-backup:12,31,33`; ARCH M07 "Disk" and §15 "Files" | Backups go from 72 × ledger to ≤ 6 GB |
| R2 | **Align every Blueprint path under the worker's StateDirectory** so the unit can write them and the backup sees the ledger: `m24` database `/var/lib/zeroed/bot.db`, `m27.log_dir` `/var/lib/zeroed/log`, `recorder.data_dir` `/var/lib/zeroed/md`. Today the unit (`ProtectSystem=strict`) cannot write `/var/lib/bot` or `/data`, and the ledger would never be backed up. | `packages/engine/src/m24/config.ts:9`, `packages/engine/src/m27/config.ts:19`; SPEC-A A-M07-02 `recorder.data_dir`; ARCH §15 "Files" | Ledger backed up; writes allowed |
| R3 | **Keep the metric rollups out of the hourly backup**, in their own file (for example `/var/lib/zeroed/metrics.db`) that `zeroed-backup` skips. They are observability, not money, and can be rebuilt. Lower `m27.rollup_max_bytes` from 4 GiB to **1 GiB** for this host, and record the deviation in `DECISIONS.md`. | `packages/engine/src/m27/config.ts:21` default; a skip list in `zeroed-backup:15`; ARCH §15 | Backed-up ledger stays about 1.5–3 GB in year 1, not 6–8 GB |
| R4 | **Recorder: bytes, not percentages, and receipts from the approved upload.** Count an upload to zeroed-data whose sha256 read-back matches as a valid `PullReceipt` (owner, `CLAUDE.md:78`). Delete verified segments after **7 days** on the host, not 30. Use RECORD-BUDGET's figures: a cap of `recorder.max_bytes` 8 GiB, and a free floor of 3 GiB that deletes oldest first even without a receipt, with each loss logged (the owner's "auto delete", `HANDOVER.md:1054`). Keep 95% → stop streams as a last guard. 80% of 51 GB is 41 GB, too late once backups and logs are counted. | SPEC-A A-M07-03 step 2 and config; ARCH M07 "Disk" and "Failure modes" (`ARCH.md:1077-1078`) | Recorder ≤ 3.6 GB at design rate, ≤ 8.6 GB worst |
| R5 | **Releases: one spare instead of three, and only runtime files.** `prunable_releases` keeps current, previous, the tag's commit and **1** newest other. `git archive` takes only what the host runs (proposed: `ops/`, `packages/`, root `package.json`, `pnpm-lock.yaml` and `tsconfig*`). The builder must check what `worker_entry` and `apply_host` read. `research/` and `docs/` (46 MB, 55% today) are left out. | `ops/host/files/usr/local/lib/zeroed/logic.sh:236` (`-gt 3` → `-gt 1`); `zeroed-update:381` (path list after `$commit`); `DECISIONS.md` HOST-CAPS | About 4 × 36 MB = 0.15 GB, growing far more slowly |
| R6 | **Git clone: shallow.** `fetch --depth=1` for the tag and branch, plus `git gc --prune=now` after a switch. `verify-commit` needs only the commit object. The builder must check that no step reads history. | `zeroed-update:309` | Repo ≈ one tree, about 50 MB, flat |
| R7 | **Logs: a hard daily cap for every level.** `m27.log_max_bytes_per_day` 256 → 128 MiB. Above twice that, warn lines are sampled with a dropped count (error and above always kept). Retention stays at 14 days (ARCH). | `packages/engine/src/m27/config.ts:15-16`; B-M27-01 | ≤ 1.9 GB |
| R8 | **Run retention.** A daily `deleteExpired` over `retentionTables()` must be scheduled. On base, nothing calls it on a schedule (UNVERIFIED; no caller found). | the M24/M27 owner card; `packages/engine/src/m24/retention.ts` | Ledger tables follow ARCH 15 |
| R9 | **One host disk alert:** `zeroed-check` raises an alert when `/var/lib` free space is under 10 GB, and a critical alert under the 3 GiB floor. Its `/status` shows bytes for recorder, ledger, backups, logs and releases. | `ops/host/files/usr/local/sbin/zeroed-check` | Early warning, not a crash |
| R10 | **Measure in Phase 0** (48 h): recorder bytes a day per stream, ledger growth a day per table, backup size compressed, log bytes a day. Replace this file's estimates with the measured numbers. | ARCH M07 "Budget"; MA-0b exit | Removes the UNVERIFIED rows |

### Budget with R1–R9 (year 1, derived)

| Item | Steady | Worst |
|---|---|---|
| Fixed (OS, kernels, apt, Node, journald, Tailscale) | 4.0–5.8 GB | 6.3 GB |
| Releases (4 × runtime-only) + shallow repo | 0.2 GB | 0.5 GB |
| Recorder (7 days after verified upload; cap 8 GiB) | 2.2–3.6 GB | 8.6 GB |
| Ledger without rollups | 1.5–3 GB | 4 GB |
| Metric rollups (1 GiB cap) | 1.1 GB | 1.1 GB |
| Backups (byte budget) | 2–6 GB | 6 GB |
| Logs (128 MiB × 14) | 0.7–1.9 GB | 1.9 GB |
| Free floor (RECORD-BUDGET) | 3.2 GB | 3.2 GB |
| **Total** | **about 15–27 GB** | **about 32 GB** |

Against about 51 GB usable, the worst case leaves about 19 GB free, and no single grower can fill the disk in a day: the largest daily writer, the recorder, is capped in bytes and checked every 60 s.

## 6. Open points

- Vultr's "55 GB" unit, the real `df` figures and the 5% reserve: one `df -B1 /var/lib` on the host settles all three. That is an owner console step, or it can be read from the installer's D07 log line.
- M07's real compression ratio and change rate: Phase 0 (R10).
- The aggregate series count of M27 at runtime.
- Whether anything on the host needs repo history (R6) or `docs/`/`research/` (R5).
