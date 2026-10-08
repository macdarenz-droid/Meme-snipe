# Disk budget: the 2 GB Vultr host

Research, docs only. Base `ccr-14987baf-i6lrsl` @ `1e4df569` (Merge #301, Z02). Round 1 written 8 Oct 2026, about 11:55 PM Melbourne time; round 2 applies the supervisor's rulings 1–6 in `docs/reviews/DISKBUDGET.md` (on `claude/supervisor-docs-3` @ `caa6cc6c`), 9 Oct 2026.
No server was contacted. Every number is either cited from the repo, measured in this container (marked **measured**), derived from cited inputs (marked **derived**), or **UNVERIFIED** with a range. The first 48 h of Phase 0 recording must replace the estimates (ARCH M07, `docs/blueprint/ARCH.md:1076`).

Owner rules this budget serves:
- "Disk cycle" (`CLAUDE.md:79`): a day of trading can never fill the disk. The ledger, saved state and journal are never deleted.
- "Recordings upload approved" and "Recording uploads are for study only" (`CLAUDE.md:78`, `CLAUDE.md:80`): for the Zeroed recorder, a recording is deleted only after its uploaded copy is checked by sha256 read-back; uploads stop at production level, but the local auto-delete stays. For the Blueprint recorder (M07), deletion needs the signed `PullReceipt` (A-M07-03); a sha256 read-back is not a receipt (supervisor ruling 2).
- "Carried from the Blueprint build" (`CLAUDE.md:108`).

## 1. Summary

- **The biggest risk is the hourly backup, not the recorder.** `zeroed-backup` keeps 72 copies (`ops/host/files/usr/local/sbin/zeroed-backup:12`). Each copy is a plain tar of every SQLite file, encrypted with age and **not compressed** (`:31`). So the backups take about 72 × the ledger's size. The ledger's `metric_rollup_1m` table alone may grow to 4 GiB (`packages/engine/src/m27/config.ts:21`). At that size the backups would need about 300 GB. On the current keep rules the disk fills about **day 8–17 after start at design rates, and about day 2 in the worst case** (derived; §4).
- **The Blueprint cannot write where its defaults point, and its ledger is not backed up** (confirmed by the round 1 review). Its write paths (§2.9) are under `/var/lib/bot`, `/data/md` and `/data/backups`. The worker unit has `StateDirectory=zeroed` and `ProtectSystem=strict` with no `ReadWritePaths` (`ops/host/files/etc/systemd/system/zeroed-worker.service:32,44`). The host backs up only `/var/lib/zeroed` (`zeroed-backup:9`). §2.9 gives card PATHS-FIX its path list. R1 must land before PATHS-FIX.
- **Two backup owners exist on paper:** M24's own hourly backup (SPEC-B, `docs/blueprint/SPEC-B.md:2031`, keep 48, `/data/backups`) and the host's `zeroed-backup` (keep 72). This budget names `zeroed-backup` as the one owner (§2.6) and counts the backups once.
- **Usable space: about 51 GB for the worker's user** (estimate; §3).
- **Steady state on the current rules: none is reached.** The backup term outgrows the disk (§4).
- **Steady state with the recommendations: about 23–42 GB at the end of year 1** (derived; §5), against about 51 GB. The worst case (every item at its worst at once) is about 75 GB, **over** the usable space. It depends mostly on the ledger's size times the 31-copy backup floor (ruling 3). A Phase 0 measurement of the ledger and of backup compression (R10) decides whether R3's split is enough.
- **Fill date if nothing is pruned (days from the start of the Blueprint engine and recorder): about day 7–10 at design rates, about day 2 in the worst case.** Without the backups it is about day 44–94, or day 16 in the worst case. Nothing runs yet (`ops/host-config.json` has `"worker": "stub"`), and no start day is set.

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
- Design rate (`docs/blueprint/ARCH.md:1076`, CB-26, DERIVED worst case): 30 pools × 1 Hz × about 600 B gives about 1.56 GB a day raw. zstd at an **assumed** 3–5× on that raw 1.56 GB basis gives **0.31–0.52 GB a day** (the spec's own figure; ASSUMPTION). With the spec's +20% for 2 Hz position pools and eviction tails (1.87 GB a day raw), the same ratio gives **0.37–0.62 GB a day** (derived). This budget uses the 1.87 GB basis. Change-only deltas should be smaller (A-M07-01 step 2).
- `poll_counts`: 30 pools × 1,440 minutes a day × about 120 B is about 5 MB a day raw (derived; the 120 B is UNVERIFIED).
- Keep rule (spec only; not built): segments stay 30 days on the host, then are deleted **only with a valid `PullReceipt`** (A-M07-03 step 2; `ARCH.md:1077,1078`). Above 80% disk, receipted segments are deleted oldest first. Above 95%, every stream stops except `universe_manifest` and `coverage`.
- Per year: 135–226 GB at the design rate (1.87 GB basis), so retention is mandatory.

| | Per day | 30-day steady | Worst |
|---|---|---|---|
| Design (zstd 3–5×, 1.87 GB raw basis) | 0.37–0.62 GB | **11.1–18.7 GB** | — |
| No compression gain (gzip fallback poor, or every poll changes, UNVERIFIED) | up to 1.87 GB | 56 GB (over the disk) | the 80%/95% thresholds decide. Without receipts nothing is deleted and recording stops at 95%. |

Note: the old Zeroed recorder measured 4.5–7 GB a day (`HANDOVER.md:1050`; `PROJECT_STATE.md:90`). That was a different design (frames of every candidate). It does not predict M07's rate, but it shows that a spec estimate can be 20–30× low (`HANDOVER.md:1050`, "the old 0.15–0.25 GB/day estimate was 20–30× low").

### 2.4 Old Zeroed recorder and the upload (present on the host, idle today)

| Item | Rate | Keep rule | Steady | Worst |
|---|---|---|---|---|
| `/var/lib/zeroed/recorder` (`packages/worker/src/run/recorder.ts`) | 4.5–7 GB a day measured on the 1 GB host (`HANDOVER.md:1050`). It runs only when `ops/host-config.json` says `"worker": "release"`; today it says `"stub"`, and "No bugs migrate" bars the Zeroed worker (`CLAUDE.md`, Blueprint section) | RECORD-BUDGET: a cap of 8 GiB (`ZEROED_RECORDER_MAX_BYTES`) and a free floor of 3 GiB, pruning back to 3.5 GiB free (`packages/worker/src/run/recorder-budget.ts:23-28`), every 60 s (`:30`) | 0 now; 8.6 GB if run | 8.6 GB (cap), plus the running boot's plain `.jsonl` files, which are never pruned (`:13`) |
| Upload state `/var/lib/zeroed-record-upload` | small | `state.json` pruned of finished boots (`ops/host/files/usr/local/lib/zeroed/record-upload.mjs:704-708`); `delete after upload` on (`ops/host-config.json` `record_upload_delete_local: true`) | < 10 MB (UNVERIFIED) | < 50 MB |
| Zeroed `journal.jsonl` | only while the Zeroed worker runs | never deleted (owner, "Disk cycle") | 0 now | grows without a cap; not sized here because the Zeroed worker is barred |

### 2.5 SQLite ledger (M24; Z02 merged in #301)

Retention per table: ARCH 15 (`docs/blueprint/ARCH.md:2675-2718`), implemented in `packages/engine/src/m24/schema.ts` and deleted by `deleteExpired` (`packages/engine/src/m24/retention.ts:23-42`). On base, nothing outside the tests calls `deleteExpired` (checked by grep over `packages` and `apps`). Until a scheduler runs it, **nothing in the ledger expires**.

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

### 2.6 Hourly backups (one owner: `zeroed-backup`)

**Two owners exist on paper.** M24's spec has the engine back itself up hourly (`docs/blueprint/SPEC-B.md:2031`: online backup, `quick_check`, AEAD with a key from the secret store, `/data/backups/bot-YYYYMMDD-HH.db.enc`, keep 48). The host's `zeroed-backup` already does the same for every SQLite file under `/var/lib/zeroed` (keep 72). Run both, and the backups are counted twice.

**Owner named: `zeroed-backup`** (supervisor ruling 4 asks for one, with the reason). Reasons:
- It is built and in use, with a restore drill (`ops/host/files/usr/local/sbin/zeroed-restore-drill`).
- It encrypts to the owner's key as well as the host key (`zeroed-backup:3-5`), so the owner can open a copy off the host.
- It runs as root, outside the engine's user. A faulty or compromised engine cannot delete or rewrite its own backups.
- It needs none of M24's open VERIFY items (AEAD in Node's built-in `crypto`, A-18; the key in the secret store).

The cost: SPEC-B's start recovery opens "the newest backup that passes its check" (`SPEC-B.md:2032`). With `zeroed-backup` as the owner, the engine user cannot decrypt an age file encrypted to the host key. Either the recovery reads a copy that a root helper decrypts, or the operator restores. This is an open point for the B-M24 spec (§6). The M24 hourly step (SPEC-B step 1) is then not built, or is switched off on this host. Either way it is budgeted at 0.

| Item | Rate | Keep rule | Steady | Worst |
|---|---|---|---|---|
| `/var/backups/zeroed/zeroed-*.tar.age` (`zeroed-backup`; `zeroed-backup.timer` `OnCalendar=hourly`) | 24 a day × the size of every `*.sqlite`/`*.db` under `/var/lib/zeroed`. tar + age, **no compression** (`zeroed-backup:31`) | today: the newest **72** (`ZEROED_BACKUP_KEEP`, `zeroed-backup:12,33`). ARCH and SPEC-B say 48 (`ARCH.md:1077`, `:2718`; `SPEC-B.md:2031`). | **72 × ledger**: at a 6–8 GB ledger, **430–580 GB** | — |
| Working copy | each run makes a full snapshot in a private `/tmp` (`zeroed-backup:18-23`, `PrivateTmp=yes`) on the root disk | removed at exit | 0 | **1 × ledger** at run time, on top of the above |
| Off-site copy | daily over Telegram, only under 49 MB (`zeroed-backup-offsite:25`); `offsite_backup: false` | — | 0 local | — |
| M24's own backups (`/data/backups`) | — | not built; budgeted at 0 (owner above) | 0 | 0 |
| M24 pre-migration backup (`packages/engine/src/m24/migrate.ts:86,135-137`; `SPEC-B.md:1992`) | one online copy at each engine start that applies migrations, written to `<backupPath>.tmp`, checked, then renamed over the previous copy | overwritten at the next migrating start; 1 copy. `backupPath` has no default on base (grep), so PATHS-FIX names it (§2.9). It must sit **outside** `zeroed-backup`'s glob (`*.sqlite`, `*.db`, `zeroed-backup:15`), or it is copied 31 times. | **1 × ledger** (`bot.db`) | 2 × ledger while a migrating start writes `.tmp` beside the old copy |

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

### 2.9 Every Blueprint write path, and where it must go (for card PATHS-FIX)

Supervisor ruling 4 and ruling 6. The unit can write only `/var/lib/zeroed` (`StateDirectory=zeroed`, `zeroed-worker.service:32`, under `ProtectSystem=strict`, `:44`, with no `ReadWritePaths`). The engine's paths:

| Writer | Default today | Source | Proposed path | Backed up by `zeroed-backup`? | Budget row |
|---|---|---|---|---|---|
| M24 ledger | `/var/lib/bot/bot.db` | `packages/engine/src/m24/config.ts:9`; `SPEC-B.md:1971` | `/var/lib/zeroed/bot.db` | yes (matches `*.db`, `zeroed-backup:15`) | §2.5 |
| M24 writer lock | `<db>-writer.lock`, beside the database | `packages/engine/src/m24/db.ts:219-225` | moves with the db: `/var/lib/zeroed/bot.db-writer.lock` (derived from the db path, so no separate setting) | no (not matched by the glob) | bytes |
| M24 pre-migration backup | no default (`backupPath`, `packages/engine/src/m24/migrate.ts:86`) | `migrate.ts:135-137`; `SPEC-B.md:1992` | `/var/lib/zeroed/premigrate/bot.premigrate` (the extension keeps it out of the `*.db`/`*.sqlite` glob) | no, by design | 1 × ledger (§2.6) |
| M24 first-start marker | `/var/lib/bot-init/first-start` | `packages/engine/src/m24/db.ts:79` | `/var/lib/zeroed/init/first-start` | no (not SQLite) | bytes |
| M24 recovery journal (`exits_only`) | `/var/lib/bot/recovery-<ts>.ndjson` | `SPEC-B.md:2032` | `/var/lib/zeroed/recovery/recovery-<ts>.ndjson` | no; never deleted (owner, "Disk cycle", journal) | small; only in `exits_only` |
| M24 backups | `/data/backups/bot-YYYYMMDD-HH.db.enc` | `SPEC-B.md:2031`; `ARCH.md:2718` | none: `zeroed-backup` is the one owner (§2.6) | — | 0 |
| M24 disk-guard reserve file (500 MB) | not named in the spec | `SPEC-B.md:2033` | `/var/lib/zeroed/reserve` | no | 0.5 GB, fixed |
| M27 logs | `/var/lib/bot/log` | `packages/engine/src/m27/config.ts:19` | `/var/lib/zeroed/log` | no | §2.7 |
| M07 segments, manifests, day index | `/data/md`, `/data/md/YYYY-MM-DD/HH/<stream>.ndjson.zst`, `/data/md/YYYY-MM-DD/index.json` | SPEC-A A-M07-02 (`SPEC-A.md:1305,1307,1310`) | `/var/lib/zeroed-md`, created by the installer (not a `StateDirectory`; see the note below the table): owner `zeroed-worker`, group `zeroed-pull`, mode **2750** (setgid, so every new folder and file takes the group `zeroed-pull`). The recorder sets explicit modes on what it creates, **0750** for folders and **0640** for files (`chmod` after create), because the unit's `UMask=0077` (`zeroed-worker.service:34`) stays and would otherwise make them 0700/0600, unreadable to the pull group (supervisor ruling 12). | no (not SQLite; pulled by `md-pull`) | §2.3 |
| M07 receipts | `/data/md/receipts/` | `SPEC-A.md:1340` | `/var/lib/zeroed-md/receipts/`, installer-made: owner `zeroed-worker`, group `zeroed-pull`, mode **2770** (the only folder the pull group may write). The pull account's `sftp-server` runs with `-u 0027` (an `sshd_config` `Match User` block, `ForceCommand internal-sftp -u 0027`), so receipts land as 0640, group `zeroed-pull` (setgid). The worker reads them as a member of `zeroed-pull` (`SupplementaryGroups=zeroed-pull` added beside `zeroed-signer`, `zeroed-worker.service:16`). Group write does not let the worker forge a receipt: a receipt counts only with a valid Ed25519 signature from the research key (`SPEC-A.md:1340`). A receipt the worker cannot read counts as no receipt, so nothing is deleted (fails closed) (supervisor ruling 14). | no | bytes |
| M13 import spool | `/var/lib/bot/import-spool/` | `SPEC-B.md:2539` | `/var/lib/zeroed-spool`, installer-made: owner `zeroed-worker`, group **`zeroed-spool`** (a dedicated group whose members are the operator account and `zeroed-worker`, nothing else), mode **2730**: members may write and enter but not list; setgid keeps the group (supervisor rulings 13, 15). **How the worker reads a bundle:** `botctl import-run` writes it with mode 0640 (an explicit `chmod`, whatever the operator's umask). The worker reads it through group `zeroed-spool` (`SupplementaryGroups=zeroed-spool`), and as the folder's owner it can list and remove finished bundles. **The worker never joins `botops`.** `botops` reaches the signer's ops socket (`/run/signer/ops.sock`; `SPEC-B.md:667-668`), so membership would give the engine sentinel or operator identity there. PATHS-FIX changes SPEC-B:2539's "group `botops`" to `zeroed-spool`, with this reason. Content trust comes from the bundle's signature, not from the file mode. | no | UNVERIFIED, one bundle at a time |
| `md-pull` read access to segments | the operator's `md-pull` reads `/data/md` over `sftp` and writes receipts to `/data/md/receipts/` | `SPEC-A.md:1333,1340` | a dedicated pull account (proposed `zeroed-pull`, group `zeroed-pull` only), **sftp only**. Its `sshd_config` `Match User zeroed-pull` block sets `ForceCommand internal-sftp -u 0027`, `ChrootDirectory /srv/zeroed-pull`, `AllowTcpForwarding no`, `X11Forwarding no` and `PermitTTY no`, and the account's shell is `/usr/sbin/nologin`. sshd requires every component of the chroot path to be root-owned and not writable by group or others (sshd_config(5), `ChrootDirectory`). So `/srv/zeroed-pull` is `root:root` 0755, and `/var/lib/zeroed-md` is bind-mounted into it at `/srv/zeroed-pull/md` (the 2750/0640 modes above still apply). The account reads segments and writes only `md/receipts/`; it never sees the worker's 0700 state folder. PATHS-FIX adds this account to B-M30-02's host user list (`SPEC-B.md:2584`) (supervisor rulings 9, 12, 14, 16). | no | §2.3 |
| M14 provider usage ledger | `/data/rpc-usage.db` | `SPEC-A.md:2513` | `/var/lib/zeroed/rpc-usage.db`, or a shared directory if the sentinel must write it (owner `bot`, group `sentinel`, mode 0660 as specified) | yes, if under `/var/lib/zeroed` | small |
| Signer, sentinel | `/var/lib/signer/…`, `/var/lib/sentinel/…`, `/run/signer`, `/run/sentinel` | `SPEC-B.md:723,772,2012,1489,2440`; `ARCH.md:630,1628` | own units, own `StateDirectory`/`RuntimeDirectory` (the host already has `zeroed-signer`, `StateDirectory=zeroed-signer`) | out of scope for the engine unit; the signer's key material is never in the backup (`ARCH.md:2718`) | small |
| Config (read-only) | `/etc/bot/*.json`, `/etc/bot/secrets.env`, `/opt/bot/idl` | `SPEC-B.md:331,2058,2584`; `SPEC-A.md:464` | read, not written; the host's `/etc/zeroed` | — | — |

**One mode per unit** (supervisor ruling 11). systemd applies one `StateDirectoryMode` to every `StateDirectory` a unit lists (systemd.exec), with the unit's user as owner. So separate modes and groups cannot come from extra `StateDirectory` entries. The unit keeps `StateDirectory=zeroed` at 0700 (`zeroed-worker.service:32-33`). The installer creates `/var/lib/zeroed-md` (with `receipts/`) and `/var/lib/zeroed-spool` with the explicit owner, group and mode above (`install -d -o … -g … -m …`) and the groups `zeroed-pull` and `zeroed-spool`. The unit lists them in `ReadWritePaths=` (needed under `ProtectSystem=strict`). PATHS-FIX checks this behaviour on the host's systemd version and records it: Ubuntu 24.04 ships systemd 255 (UNVERIFIED in this repo).

PATHS-FIX's test (ruling 6): every configured write path above that belongs to the engine unit resolves inside the unit's `StateDirectory` (`/var/lib/zeroed`) or one of its `ReadWritePaths` (`/var/lib/zeroed-md`, `/var/lib/zeroed-spool`). The test fails on today's defaults (the ledger, init marker, recovery journal, logs, segments, receipts, import spool and provider usage ledger rows). The pre-migration backup path and the writer lock follow from the ledger's path and are tested the same way. A second test checks the installer's owner, group and mode for the two folders.

## 3. Usable space

- Disk: 55 GB SSD (`docs/blueprint/ARCH.md:1711`). Whether Vultr's "55 GB" means 10^9 or 2^30 bytes is UNVERIFIED. 55 × 10^9 bytes is used here, the smaller of the two.
- Filesystem: ext4 metadata (inode tables, journal) takes about 1.5–2%, so the filesystem size is about 54 GB (estimate; the installer's D07 note says it is "smaller than 55 GB, not measured", `ops/host/install-main.sh:57-58`; floor 40 GB by size, `:61`).
- ext4 reserves 5% for root by default (UNVERIFIED on Vultr's image), so `bavail` for the worker's user is about **51 GB**. RECORD-BUDGET reads `bavail` (`recorder-budget.ts:81-84`), so its floor counts from this figure. `zeroed-backup` runs as root and may eat into the reserve.
- Fixed items: §2.1 sums to **4.0–6.3 GB** (worst 6.8 GB). §2.2's code today is **0.46–0.53 GB**. Together that is **4.5–6.8 GB** (worst 7.4 GB), which leaves **about 44–47 GB** for growers. The model in §4 uses these same figures.

## 4. Fill dates (derived model)

Day 0 is the day the Blueprint engine (ledger, logs, backups of it) and the M07 recorder start on the host. No start day is set, so dates are given only as days from start. Inputs per day:

| Scenario | Fixed at day 0 | Recorder (1.87 GB raw basis) | Logs | Ledger growth | Releases + repo |
|---|---|---|---|---|---|
| Design low | 4.46 GB | 0.37 GB | 0.05 GB | 35 MB | 42 MB |
| Design high | 6.83 GB | 0.62 GB | 0.256 GB | 75 MB | 58 MB |
| Worst | 7.35 GB | 1.87 GB | 0.256 GB | 600 MB | 58 MB |

| Scenario | Nothing pruned, no backups | Nothing pruned, hourly backups never deleted (about 12 × r × d² GB) | **Current keep rules** (recorder 30 d, logs 14 d, backups 72, rollups ≤ 4 GiB, 5 releases) |
|---|---|---|---|
| Design low | day 94 | day 10 | day 17 |
| Design high | day 44 | day 6–7 | day 8 |
| Worst | day 16 | day 2 | day 2 |

Model (hourly steps; a reviewer can rerun it from this line): `used = F + (R + G + rel + repo) × d + L(d) + backups(d)`, with `L(d) = r × d` and `backups = Σ L` over the kept copies; the disk is full when `used` reaches 51.3 GB. Under the current keep rules, the recorder stops growing at day 30, logs at day 14, and L at 6 GB.

Before day 0 (today): the stand-in writes almost nothing, and only the fixed items count.

## 5. Recommendations

Each item names the owner rule or ruling it serves, the exact change, and where. None of them deletes the ledger, saved state or journal ("Disk cycle", `CLAUDE.md:79`). Backups are copies, so removing old backup files beyond the copy floor does not touch the ledger.

| # | Change | Where | Effect |
|---|---|---|---|
| R1 | **Backups: a copy floor first, then a byte budget.** Keep at least the newest 24 hourly copies and 7 daily copies (one per UTC day). The byte budget never cuts these (supervisor ruling 3). Above the floor, delete the oldest copies beyond the budget (proposed `ZEROED_BACKUP_MAX_BYTES`, 6 GB, for copies above the floor). When the floor alone exceeds the budget, raise an alert and shed the other growers (recorder cap down, then logs, R9), **never backups**. Pipe through `zstd` before `age` (the installer must add the `zstd` package if the image lacks it, UNVERIFIED). Compression is **not** counted in this budget until measured (R10). Change ARCH's and SPEC-B's "48 hourly" (`ARCH.md:1077`, `:2718`; `SPEC-B.md:2031`) to this rule. **This must land before PATHS-FIX (R2).** | `ops/host/files/usr/local/sbin/zeroed-backup:12,31,33`; ARCH M07 "Disk" and §15 "Files"; SPEC-B B-M24 backups | Backups = 31 × the backed-up file, bounded only by the size of that file (R3) |
| R2 | **Card PATHS-FIX** (supervisor ruling 6): move every engine write path in §2.9 under `/var/lib/zeroed`. Change SPEC-A's `/data/md` and SPEC-B's paths in the same PR, with the reason. Add a test that every configured write path sits inside the unit's `StateDirectory` or `ReadWritePaths`; it fails on today's defaults. `zeroed-backup` is the one backup owner (§2.6); M24's `/data/backups` step is not built. | §2.9's "Source" column; `packages/engine/src/m24/config.ts:9`, `m24/db.ts:79`, `m27/config.ts:19`; SPEC-A A-M07-02/03; SPEC-B B-M24 | The engine can write; the ledger is backed up once |
| R3 | **Keep the hourly backup small: back up the ledger, not the bulk tables.** The 31-copy floor makes every byte of the backed-up file count 31 times. Keep the money and control tables (orders, attempts, fills, positions, trades, cash flows, costs, audit, commands, config, limits, alerts, candidates, signals, wallet snapshots, equity) in `bot.db`. Move the bulk tables to their own files: `metric_rollup_1m` to `metrics.db`, not backed up; `bar_1m`, `screen_result` and `quarantine` to `market.db`, with one daily copy (keep 2), which is an open point because it sits below the ruling-3 floor (§6). `zeroed-backup` skips these by name. Losing `metrics.db` on a restore loses dashboard metric history only; whether it can be rebuilt is not claimed. Lower `m27.rollup_max_bytes` from 4 GiB to **1 GiB** for this host, and record the deviation in `DECISIONS.md`. This changes ARCH §15 and D06 (one file), so it needs a spec ruling. **Cross-file atomicity (for that ruling):** the SQLite docs say that with `ATTACH` in WAL mode, transactions stay atomic within each database file only; a host crash mid-`COMMIT` can leave some attached files changed and others not (https://www.sqlite.org/lang_attach.html, read 9 Oct 2026). So no write may need `bot.db` and `market.db` to change together. Each moved table must be written in its own transaction, and readers must accept that `market.db` can lag `bot.db` after a crash. | `packages/engine/src/m24/schema.ts` (file per table); `m27/config.ts:21`; a skip list in `zeroed-backup:15`; ARCH §15, D06 | The hourly file stays about 0.2–0.5 GB in year 1 (estimate), not 6–8 GB |
| R4 | **Recorder: bytes, receipts, fail closed** (supervisor ruling 2). Keep the Blueprint's signed `PullReceipt` (`ARCH.md:1078`; `SPEC-A.md:1340`): nothing is deleted without a verified receipt, and a sha256 read-back is not a receipt. Delete receipted segments after **7 days** on the host, not 30. Add a byte cap `recorder.max_bytes` (8 GiB) and the 3 GiB free floor of RECORD-BUDGET. At the cap or the floor with no receipted segment left to delete, raise an alert and **pause the recorder** (except `universe_manifest` and `coverage`, as at 95% today). Trading continues. Replace the 80%/95% percentages with these byte figures: 80% of 51 GB is 41 GB, too late once backups and logs are counted. Any receiptless deletion is an open point for an owner or spec decision, never a default (§6). | SPEC-A A-M07-03 step 2 and config; ARCH M07 "Disk" and "Failure modes" (`ARCH.md:1077-1078`) | Recorder ≤ 2.6–4.3 GB at design rate, ≤ 8.6 GB worst |
| R5 | **Releases: one spare instead of three, and only runtime files.** `prunable_releases` keeps current, previous, the tag's commit and **1** newest other. `git archive` takes only what the host runs (proposed: `ops/`, `packages/`, root `package.json`, `pnpm-lock.yaml` and `tsconfig*`). The builder must check what `worker_entry` and `apply_host` read. `research/` and `docs/` are 45.7 MB today: 58% of the 79.0 MB apparent size, or 56% of the 82 MB on disk (measured). | `ops/host/files/usr/local/lib/zeroed/logic.sh:236` (`-gt 3` → `-gt 1`); `zeroed-update:381` (path list after `$commit`); `DECISIONS.md` HOST-CAPS | About 4 × 36 MB = 0.15 GB, growing far more slowly |
| R6 | **Git clone: keep full history; at most a plain `git gc` after a switch** (supervisor ruling 1). No shallow fetch: `zeroed-update:325` (`merge-base --is-ancestor` against the branch) needs the branch's history, and that check is never loosened. A plain `git gc` only repacks reachable objects, so the check keeps working. The clone keeps growing at the repo's rate (+2–7 GB a year, UNVERIFIED), and this budget carries that. | `zeroed-update` after the switch | Repo packed; growth stays |
| R7 | **Logs: a lower daily cap, and a spec change for warn floods.** `m27.log_max_bytes_per_day` 256 → 128 MiB (a default inside its configured range, `config.ts:15`). Sampling warn lines above twice the cap, with a dropped count (error and above always kept), **changes B-M27-01's rule that warn and above are always kept** (`config.ts:16`). It needs a spec change and a `DECISIONS.md` entry before any build. Retention stays at 14 days (ARCH). | `packages/engine/src/m27/config.ts:15-16`; B-M27-01; `docs/DECISIONS.md` | ≤ 1.9 GB if the spec change lands; warn floods are uncapped until then |
| R8 | **Run retention.** A daily `deleteExpired` over `retentionTables()` must be scheduled. On base, nothing outside the tests calls it (checked by grep). | the M24/M27 owner card; `packages/engine/src/m24/retention.ts` | Ledger tables follow ARCH 15 |
| R9 | **One host disk alert and the shed order:** `zeroed-check` raises an alert when `/var/lib` free space is under 10 GB, and a critical alert under the 3 GiB floor. Its `/status` shows bytes for recorder, ledger files, backups, logs and releases. At overflow the shed order is: recorder (pause, R4), then logs (debug and info off), then old releases beyond current and previous. Backups and the ledger are never shed (ruling 3; "Disk cycle"). **Last fail-closed step** (supervisor ruling 7): if free space still falls to the critical line, the M24 disk guard (`SPEC-B.md:2027,2033,2035`: the 500 MB reserve file, `m24.disk_crit_pct` 95) blocks new entries (`halt_requested`) and raises a critical alert. On disk full it deletes only its own reserve file, so exit journal writes continue. Nothing protected (ledger, backups, journal, saved state) is deleted. | `ops/host/files/usr/local/sbin/zeroed-check`; SPEC-B B-M24 disk guard | Early warning, and a fixed order instead of a crash |
| R10 | **Measure in Phase 0** (48 h): recorder bytes a day per stream, growth a day per ledger table, backup size with and without zstd, log bytes a day. Replace this file's estimates with the measured numbers, and decide R3's open point from them. | ARCH M07 "Budget"; MA-0b exit | Removes the UNVERIFIED rows |

### Budget with R1–R10 (end of year 1, derived)

| Item | Steady | Worst |
|---|---|---|
| Fixed (§2.1: OS, kernels, apt, Node, journald, Tailscale) | 4.0–6.3 GB | 6.8 GB |
| Releases (4 × runtime-only) + git clone with history (R6) | 0.2–2.6 GB | 7.3 GB |
| M24 disk-guard reserve file (`SPEC-B.md:2033`) | 0.5 GB | 0.5 GB |
| Recorder (7 days after receipt; cap 8 GiB) | 2.6–4.3 GB | 8.6 GB |
| `bot.db`, the hourly-backed ledger (R3) | 0.2–0.5 GB | 1 GB |
| `market.db` (`bar_1m`, `screen_result`, `quarantine`), if R3 is ruled | 1.3–2.0 GB | 4 GB |
| `metrics.db` (1 GiB cap), if R3 is ruled | 1.1 GB | 1.1 GB |
| Backups of `bot.db`: floor 31 × file, compression not counted | 6.2–15.5 GB | 31 GB |
| Backups of `market.db`: 2 daily (open point), if R3 is ruled | 2.6–4.0 GB | 8 GB |
| M24 pre-migration backup (1 × `bot.db`) | 0.2–0.5 GB | 2 GB (2 × during a migrating start) |
| Logs (128 MiB × 14) | 0.7–1.9 GB | 1.9 GB |
| Free floor (RECORD-BUDGET) | 3.2 GB | 3.2 GB |
| **Total** | **about 23–42 GB** | **about 75 GB** |

Against about 51 GB usable: the steady range fits, with about 9–28 GB free. The worst case is about 24 GB over. It assumes every item at its worst at once, at the end of year 1, with no compression credit. 31 GB of the 75 comes from the backup floor on a 1 GB `bot.db`. Inside a day nothing can fill the disk: the recorder is capped in bytes and checked every 60 s, and the shed order (R9) handles the slower growers. Over months, the backup floor times the ledger's size is the limit. R10's measurement of the real `bot.db` size and zstd ratio decides whether R3 is enough. **Recommended default until then: the 7 daily copies live off the host** (the hourly 24 stay), which takes 7 × `bot.db` out of the worst case. This waits on the owner's open "off-server backup" answer (HANDOVER owner waits), so it is not applied yet (supervisor ruling 7). If the disk still runs short, the last step is the M24 disk guard (R9): entries stop and a critical alert goes out; nothing protected is deleted.

## 6. Open points

- Vultr's "55 GB" unit, the real `df` figures and the 5% reserve: one `df -B1 /var/lib` on the host settles all three. That is an owner console step, or it can be read from the installer's D07 log line.
- M07's real compression ratio and change rate: Phase 0 (R10).
- The aggregate series count of M27 at runtime.
- Whether anything on the host needs `docs/` or `research/` (R5).
- **Receiptless deletion of recorder segments** (ruling 2): not a default. If the owner's approved upload to zeroed-data (`CLAUDE.md:78`) should count as a pull, that is an owner or spec decision on A-M07-03. Until then the recorder pauses at its cap.
- **B-M24 start recovery with `zeroed-backup` as the owner** (§2.6): the engine user cannot decrypt the host's age files. Options are a root helper that decrypts the newest good copy read-only for the engine, or operator restore. This needs a spec ruling.
- **R3's split and `market.db`'s backup** (2 daily copies, below ruling 3's floor): needs a ruling. The alternative is to keep `bar_1m` and `screen_result` in the hourly file, which adds about 1.3–2 GB × 31 to the backups.
- **The backup floor at worst size**: if R10 measures `bot.db` above about 0.5 GB uncompressed, 31 copies pass 15 GB. The recommended default is to keep the 7 daily copies off the host (as ARCH plans: "daily copies are pulled", `SPEC-B.md:2031`). It waits on the owner's open "off-server backup" answer (HANDOVER owner waits). Until then the last fail-closed step is the M24 disk guard: it blocks entries and raises a critical alert (R9).

## 7. Round 2 changes (supervisor rulings, `docs/reviews/DISKBUDGET.md` @ `caa6cc6c`)

1. R6: the shallow fetch is dropped. `zeroed-update:325` is kept as is; only a plain `git gc` stays.
2. R4: the signed `PullReceipt` is kept. There is no receiptless deletion by default; at the cap the host alerts and pauses the recorder. Receiptless deletion is listed as an open point.
3. R1: the copy floor (24 hourly + 7 daily) is never cut by the budget. At overflow the host alerts and sheds other growers (R9), never backups.
4. R2: §2.9 lists every Blueprint write path. `zeroed-backup` is named as the one backup owner, with the reason (§2.6). Backups are budgeted once.
5. MINORs:
   - Round 1's "with recommendations" table summed to 24.8 GB at the top of its range, not 27. The table is recomputed in §5.
   - The recorder now states its basis: the spec's 0.31–0.52 GB a day is on the raw 1.56 GB basis; the budget uses the 1.87 GB basis (0.37–0.62).
   - The fixed items are aligned across §2.1, §3, §4 and §5.
   - Fill dates are given only as days from start.
   - R3's "can be rebuilt" claim is dropped.
   - R7's warn sampling is marked as a spec change that needs a `DECISIONS.md` entry. R5 now says 56–58%.
6. PATHS-FIX: the exact path list is in §2.9, and the test rule is in R2.

## 8. Round 3 changes (supervisor rulings 7–10, `docs/reviews/DISKBUDGET.md` @ `630d67fc`)

7. The last fail-closed step is named in R9, §5 and §6: the M24 disk guard blocks entries and raises a critical alert, and nothing protected is deleted. Keeping the daily copies off the host is the recommended default, pending the owner's off-server backup answer.
8. The M24 pre-migration backup is added to §2.6, §2.9 and the §5 budget: outside the backup glob, 1 × ledger (2 × during a migrating start). The writer lock moves with the database.
9. The import spool and the `md-pull` read access each get their own directories and modes in §2.9; PATHS-FIX builds them.
10. R3 gains the cross-file atomicity point, citing the SQLite docs. The `market.db` and `metrics.db` rows are labelled "if R3 is ruled".

## 9. Round 4 changes (supervisor rulings 11–14, `docs/reviews/DISKBUDGET.md` @ `e4bea4e4`)

11. One `StateDirectoryMode` per unit: the md and spool folders are made by the installer with explicit owner, group and mode, and are listed in `ReadWritePaths`. PATHS-FIX checks this on the host's systemd version.
12. The md folder is 2750, setgid to `zeroed-pull`. The recorder sets 0750 folders and 0640 files; `UMask=0077` stays.
13. The spool is 2730 (its group was changed in round 5, ruling 15). `botctl import-run` writes 0640.
14. The pull account's `internal-sftp -u 0027` makes receipts 0640, group `zeroed-pull`; the worker reads them through `SupplementaryGroups=zeroed-pull`. An unreadable receipt counts as none, so the check fails closed.

## 10. Round 5 changes (supervisor rulings 15–16, `docs/reviews/DISKBUDGET.md` @ `cf42508c`)

15. The spool's group is now a dedicated `zeroed-spool` (the operator account and `zeroed-worker`): folder 2730, owner `zeroed-worker`, made by the installer; `botctl` writes 0640. The worker never joins `botops`, which reaches the signer's ops socket. PATHS-FIX changes SPEC-B:2539, with the reason.
16. The pull account is sftp only: a `Match User` block with `ForceCommand internal-sftp -u 0027`, no shell, no forwarding and no TTY, and `ChrootDirectory /srv/zeroed-pull` (root-owned 0755) with the md folder bind-mounted inside. PATHS-FIX adds the account to B-M30-02's user list (SPEC-B:2584).
