# Zeroed server

How the server is installed, gets its keys, pairs with Telegram, updates and is backed up (ARCHITECTURE.md §12, OPS-1a to OPS-1e). Nobody copies a key by hand. The only things typed by hand are a 6-word code and a 6-digit code.

Server: Vultr Shared CPU `vc2-1c-2gb`, Frankfurt, 1 vCPU / 2 GB (the OS reports about 1.9 GiB, not measured) / 55 GB SSD, image **Ubuntu 24.04 LTS x64** (`docs/blueprint/ARCH.md` D07). The older 1 GB server `zeroed` is not used for the bot. Ubuntu 24.04 gets standard security updates until 2029; Debian 12 left regular security support in June 2026.

## Setup (about 3 minutes)

1. **Log in.** In Vultr, open the server's Overview page and copy its password. Open **View Console**. Vultr's Ubuntu 24.04 image logs in as `linuxuser`, not `root`: at `login:` type `linuxuser` and press Enter. At `Password:` use the console's control bar → Clipboard → Paste, then press Enter. Then type `sudo -i` and press Enter (if it asks for a password, paste the same one). The prompt now ends in `#`. Without `sudo -i` the install stops with "Install stopped: run as root".
2. **Install.** Paste this one line the same way (Clipboard → Paste), then press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/macdarenz-droid/Meme-snipe/669943689dc9b13c6d5b07dc8a89aff438441f79/ops/install.sh -o i && echo 'cec041150b29c37c3f4da4aacbab05a040fadb25a3c272bd7a7c904e1a04f433  i' | sha256sum -c && bash i
```

   The line checks the file against its SHA-256 before anything runs; a changed file stops at `sha256sum -c`. After about two minutes the screen shows a **deploy code** of 6 words.
3. **Keys.** In GitHub: Settings → Secrets and variables → Actions → New repository secret. Name `DEPLOY_CODE`, value: the 6 words, with spaces between them. Then Actions → **Deploy** → Run workflow.
4. **Telegram.** Within a minute the console shows a 6-digit pairing code. Send `/pair` and the code to the bot in Telegram, for example `/pair 123456`. The bot answers "Paired" and the console says "Setup finished".

The console screen can be left at any time (Ctrl+C); setup carries on in the background.

### Console access

The installer turns SSH off (unless it ran with `--ssh-key`), so the way in after install is Vultr's **View Console**, logged in as in step 1 (`linuxuser`, then `sudo -i`). There, `zeroed-status` shows where setup stands, and shows the deploy code and the pairing code again while they are still waiting to be used.

SHA-256 of `install.sh`: `cec041150b29c37c3f4da4aacbab05a040fadb25a3c272bd7a7c904e1a04f433`

After any change to `ops/install.sh`, the commit in the line must move to one that holds the new file (`ops/test/e2e.sh` fails otherwise).

## What the installer does

- Checks the host first (D07): a server with under 1.5 GiB of RAM (`MemTotal` in `/proc/meminfo`; a 1 GB server has about 0.96 GiB) or whose filesystem for `/var/lib` is under 40 GB by size (a 25 GB server has about 23 GB; the 55 GB disk's filesystem is smaller than 55 GB, not measured) is refused before anything changes, with the reason. `--update` only warns, so a running server keeps its updates. No option skips the check.
- Installs `age`, `git`, `jq`, `nftables`, `sqlite3` and `unattended-upgrades` from Ubuntu, and Node 22.23.3 from nodejs.org (checked against its pinned SHA-256).
- Creates the `zeroed-worker` and `zeroed-signer` users and their systemd units with the §12.1 hardening. The signer has no network at all; the worker may only use HTTPS and DNS.
- Turns on unattended security updates (no automatic reboot).
- Closes every inbound port and turns SSH off. `bash i --ssh-key 'ssh-ed25519 AAAA…'` keeps SSH on, key-only, for that key; passwords are never allowed.
- Makes the one-time deploy code (6 words from the EFF large wordlist, about 77 bits, stored root-only) and the host's own age key for backups.

Running it again is safe: keys, codes and stored credentials are kept.

## Key handoff

The Deploy workflow (`ops/deploy/publish.sh`) turns `DEPLOY_CODE` into an age key with scrypt (`derive-key.mjs`, age's own work factor), encrypts `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY` and `TELEGRAM_BOT_TOKEN` to it, and publishes the ciphertext as the only asset of the prerelease `handoff`. The name reveals nothing about the code.

The server (`zeroed-pair`, every minute) downloads it and accepts it only if all of these hold:
- the release was made by this repository's workflow;
- it opens with the server's code;
- its run number is newer than the last one applied.

It then stores each value as an encrypted systemd credential (`/etc/credstore.encrypted`, readable only by the worker's unit) and **wipes the code**, so it cannot be used twice. The workflow deletes the release once the server downloaded it, or after 15 minutes.

A wrong code changes nothing. The console says to check `DEPLOY_CODE`, and the code stays valid for another try.

Age's own passphrase mode reads only from a terminal, so a workflow cannot use it. The key is derived the same way instead: scrypt, logN 18.

## Telegram pairing

After the keys arrive, the server shows a 6-digit pairing code (`zeroed-telegram-pair`, which reads the bot's messages). `/pair <code>` with the right code stores that chat's id, encrypted and root-only, and replies "Paired". From then on, alerts go only to that chat.

Each code has one try and works for 30 minutes: any wrong `/pair` cancels it, and a late one finds it expired. A new code comes only from the console: `zeroed-pair-code`.

**Pairing a different chat** (the server is already paired): run `zeroed-pair-code` and type `yes` when it asks. The current chat is told and stays paired, with every alert, until the new `/pair` succeeds. Then alerts move to the new chat and both chats are told. A wrong code or the 30 minutes running out cancels it, and the current chat stays paired. While the code is pending the webhook is off (Telegram allows only one reader); it is set again when the pairing ends either way. The worker reads the chat at start, so it restarts for the new chat at once, or, during a qualifying dry run or with open intents, as soon as neither holds (`zeroed-check`).

## Rotation

Run `zeroed-new-deploy-code` on the console and put the new 6 words in `DEPLOY_CODE`. Change the API keys in GitHub if needed, then run Deploy. Every key is replaced, the worker restarts after reconciling, and Telegram confirms.

## Code updates

Every Deploy run also moves the tag `deploy` to the newest commit on `ccr-14987baf-i6lrsl` that GitHub signed, which is a pull-request merge (`ops/deploy/tag.sh`). Every 5 minutes the server (`zeroed-update`) switches to it only when all of these hold:
- the commit carries GitHub's merge signature (fingerprint `968479A1AFF927E37D1A566BB5690EEEBB952194`, pinned at install);
- it is on the branch;
- GitHub Actions' `check` passed on it, and every other GitHub Actions run on it finished green (public API; runs from other apps do not count, and none at all means wait). The Deploy job's own run (`zeroed-deploy`) and the daily advisory report (`zeroed-advisories`, `.github/workflows/audit-schedule.yml`) never count, whatever their state: the report runs on the default branch's newest commit, so it must not hold that commit back (Z01 ruling 3.4);
- `e2e` passed on the newest commit at or before it that changed the ops end-to-end paths (`ops/`, `packages/ops/`, the Deploy and ops e2e workflows), since a merge that leaves ops alone runs no e2e of its own;
- no qualifying dry run is active: no `zeroed-dryrun@…` unit is running, and no named run in the evidence directory is missing its `report.json` (this covers the minutes after a reboot drill before the runner resumes);
- the worker reports no open intent (`/var/lib/zeroed/open_intents`).

First it tries the new release's worker (`/usr/local/lib/zeroed/worker-smoke`). The trial runs beside the running worker as transient units, under the worker unit's own sandbox and environment file. It has a scratch state directory as its only writable path, its own loopback ports (127.0.0.1:8797 and 8798), and memory capped at 280M (set for the 1 GB server and kept on the 2 GB one while only the stand-in runs; the Blueprint recorder, Z10, sizes its own unit from measurement). Its `--reconcile` must exit 0. It must then answer its health route in paper mode within 90 seconds, and still be running and answering 30 seconds later. If it does not (a file that does not strip or load, a missing file, a refused config, a worker that dies), nothing changes: current stays, the running worker keeps running, and one Telegram alert says why. It is tried again every 5 minutes. Until every key is stored and the chat is paired, a switch starts no worker (the unit would skip the start) and marks the release in `/var/lib/zeroed-host/switch_unheld`; the pairing, a key handoff or the installer then runs `zeroed-update`, which gives that first start the same hold and probation, and a rollback goes back to the last release that ran. A running worker that could not start again (a key or the pairing missing) holds the switch back, with one alert. The switch and its start decision take the host lock; if it stays busy for 60 seconds, the running release's host files go back and the next run tries again. During a hold, the worker restart for a re-pairing or a key handoff waits until the hold is over. A rollback cut off part-way (a reboot, a killed run) is finished by the next run, and no newer release is switched to while a rollback is due. After the switch, the new worker must answer within 60 seconds and then run 30 seconds without a restart. If it does not, the server goes back to the release it ran: current, the deployed record, its host files and its worker. That commit is not tried again (a newer deploy is), and one alert says why. Then it runs the new release's own installer as `install.sh --update`, so changes to host scripts and units arrive with the code; the install line is pasted only once. Only when that succeeds does it switch and restart the worker. The update is all or nothing: it keeps each host file it changes (the Node link included) and notes each unit it stops. If any step fails, it puts every file back, removes new ones, reloads systemd, restarts what was running and re-applies the old firewall. An update cut off half-way is rolled back by the next one first. Packages apt added stay installed. A failure keeps the running release and worker as they are, alerts once, and is tried again every 5 minutes under the same gates. An update keeps SSH exactly as the running firewall has it, makes no code and shows nothing on the console. It also installs RUN-1's units from the release (`packages/runner/systemd/zeroed-dryrun*` and `zeroed-worker-tabletop.service`, the host-loss tabletop worker on 127.0.0.1:8789, which is never published), enables only `zeroed-dryrun-tick.timer`, and removes units a newer release dropped. The worker reconciles before every start. Residual risk: write access to the repository is the ability to deploy; the signer (SIGN-1) is the separate guard on funds.

## Backups

Every hour `zeroed-backup` copies each SQLite file under `/var/lib/zeroed` and under `/var/lib/zeroed-usage` (the provider usage ledger, stored as `zeroed-usage/` in the bundle) with SQLite's online backup and checks it. It writes a SHA-256 manifest and encrypts the bundle with age to the host key and, once set, to the owner's backup code. The newest 72 stay in `/var/backups/zeroed`.

**Off-server copy (free, no R2): on.** The owner approved it on 9 Oct ("Yes", about 12:54 AM; CLAUDE.md "Off-server backup"), because sending backups to Telegram sends data to a third party. `ops/host-config.json` says `"offsite_backup": true`. Each code update (`zeroed-update`) turns `zeroed-backup-offsite.timer` on while it says `true`, and off if it is ever set back to `false`. `zeroed-backup-offsite` sends nothing until the owner's backup code exists and Telegram is paired.

**Owner step, once, after the deploy that carries this switch:**
1. On the server console (`linuxuser`, then `sudo -i`), run `zeroed-backup-code`.
2. It shows 6 words one time. Write them down and keep them safe; without them no copy can be opened.
3. Check: `zeroed-status` shows `Backups:   hourly here; daily copy to Telegram (none sent yet)`. The first copy arrives at the next 17:20 UTC (04:20 Melbourne in daylight time, 03:20 otherwise), up to 5 minutes later.

How it works: only the code's public half (an age recipient, derived with the same scrypt step as the deploy code but a different salt) stays on the server. Every day at 17:20 UTC the newest backup is re-encrypted to that recipient alone, so nothing on the server, the host key included, can open the copy. It is then sent as a silent Telegram document to the paired chat (bots may send up to 50 MB).

To open a copy anywhere with Node and age: `node derive-key.mjs --backup` (type the 6 words, press Enter) `> id.txt`, then `age -d -i id.txt zeroed-….tar.age | tar -x`.

`zeroed-restore-drill /etc/zeroed/age/host.key` (or the identity made from the words) restores the newest backup into a scratch directory. It prints PASS once the manifest, the integrity check and the tables all match, and never touches the live files.

To restore for real:
1. `systemctl stop zeroed-worker`
2. Decrypt and unpack the bundle into `/var/lib/zeroed`.
3. `chown -R zeroed-worker: /var/lib/zeroed`
4. `systemctl start zeroed-worker` (it reconciles first).

## Watchdog (OPS-1b)

`packages/ops` is a Cloudflare Worker on the free `workers.dev` address (Workers Free, cron triggers, SQLite-backed Durable Objects; no paid feature and no domain). It has a cron every minute and one Durable Object holding:
- the last heartbeat;
- the active alerts;
- the pause flag;
- the lease (with a fencing epoch).

The worker posts an HMAC-signed heartbeat every 20 s. The header is `x-zeroed-signature: t=…,v1=…`, and the HMAC covers the timestamp, method, path and body, so a signature is valid for one route only. Heartbeats must be later in time than the last one; `/resume` is single use. If the server's clock steps back (for example after an NTP correction), its heartbeats get HTTP 409 until its time passes the last accepted one; that shows as a stale-heartbeat alert and clears on its own. That heartbeat also carries the paired Telegram chat, which is the only place the watchdog learns it.

Checks:
- heartbeat older than 90 s;
- slot lag against a different RPC;
- on-chain position versus reported;
- stop breached with no exit attempt in 60 s;
- unresolved intents past blockhash expiry;
- SOL reserve below the floor;
- signer unreachable;
- daily summary not written (below).

Alerts go to Telegram once, repeat every 5 minutes during the first hour and hourly after that, and always send a "cleared" line. Chain lookups are bounded (5 s), so a hung RPC never delays the heartbeat check.

Telegram commands: only `/pause` and `/status`, only from the paired chat, only with the webhook secret. `/pause` stops new entries and never stops exits. It is cleared only from the console (`zeroed-resume`, signed with the heartbeat key).

The Deploy workflow deploys it only together with a key handoff, so the server and the watchdog always get the same fresh heartbeat key. If the account has no workers.dev subdomain yet, Deploy registers one (`zeroed-` plus random hex) through the Cloudflare API. That needs Account → Workers Scripts → Edit, which the "Edit Cloudflare Workers" template includes. The steps:
- wrangler 4.141.0 from `ops/watchdog/deploy`, locked by its `package-lock.json`, installed with `npm ci --ignore-scripts`;
- it discovers the Worker's address from wrangler's output and sends it to the server in the encrypted bundle;
- it sets the Worker's secrets, and sends the webhook secret to the server in the bundle. The server sets the Telegram webhook itself once paired, because Telegram refuses the `getUpdates` that `/pair` relies on while a webhook is set.

To turn it on, after `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are in GitHub (on a new server, the first setup already covers it):
1. Paste the install line above again on the console. This updates the server's scripts and keeps everything.
2. Run `zeroed-new-deploy-code`.
3. Put the 6 words in `DEPLOY_CODE`.
4. Run Deploy.

If the chat is re-paired later (`zeroed-pair-code`), the server turns the webhook off to read `/pair` and sets it again as soon as the pairing ends.

A failed webhook set is tried again after 1, 2, 4 and 8 minutes, then every 30 minutes. After 5 failed tries in a row the owner gets one notice in the paired chat (alerts still arrive; only `/pause` and `/status` are cut off), and a line when it works again.

## Daily summary (OPS-SUMMARY)

Each day the worker sends a summary of what it did to a private GitHub repository the supervisor can read. It covers:
- decision counts, and refusals by reason;
- halts and alerts by code;
- each paper trade and the day's paper P&L;
- the worker's commit and entry rule.

It never holds a key, token, address, host name, chat id, wallet or personal data. The worker posts it signed to the watchdog on the Melbourne half-hours (about a minute after :00 and :30), just after Melbourne midnight, and about 3 minutes after each start unless a post was taken in the 10 minutes before. The watchdog checks it again and writes `reports/<day>.json` and `reports/latest.json`. Before every write the watchdog checks that the repository is private and is not this one. If that check or the write fails, nothing is written and Telegram gets a "Daily summary not written" alert, repeated and cleared like every watchdog alert. Trading and recording never wait on it. No new secret goes on the server, and nothing is typed at the console.

Owner steps, once:
1. Open github.com/new. Owner `macdarenz-droid`, name `zeroed-data`, select **Private**, tick **Add a README file**, then **Create repository**. (This is the same repository DATA-STORE uses.)
2. Open github.com/settings/personal-access-tokens/new.
   - Token name: `zeroed-data`. Expiration: 90 days.
   - Repository access: **Only select repositories**, then `zeroed-data`.
   - Permissions: **Contents: Read and write**.
   - Select **Generate token** and copy the token.
3. In this repository, open Settings → Secrets and variables → Actions.
   - **New repository secret**: name `DATA_STORE_TOKEN`, value: the token.
   - Then the **Variables** tab → **New repository variable**: name `DATA_REPO`, value `macdarenz-droid/zeroed-data`.
4. Open github.com/settings/installations → **Claude** → **Configure**. Under Repository access add `zeroed-data`, then **Save**, so agents can read `reports/`.
5. Actions → **Deploy** → **Run workflow**.

If DATA-STORE's steps are already done, only steps 4 and 5 remain. When the token expires, the watchdog alerts "Daily summary not written: repository check HTTP 401". To fix it, make a new token as in step 2, replace `DATA_STORE_TOKEN`, and run Deploy.

The Deploy step (`ops/deploy/reports.sh`) runs only when `CLOUDFLARE_API_TOKEN` and `DATA_STORE_TOKEN` exist, and only after the deploy tag moved. It deploys the watchdog's code from the commit the deploy tag names (the one the server runs), with `DATA_REPO`, and sets one secret, `REPORTS_TOKEN`, from stdin. It never touches the heartbeat key or any other secret, which a deploy keeps. It also refuses this repository's own name.

## Recording upload (RECORD-UPLOAD)

The owner approved it on 6 Oct ("Approve upload"; "Okay yes delete after upload"). The server's recordings go to the same private repository as the daily summary (`DATA_REPO`), so cloud agents can study and replay them. They hold public market data and the bot's own decisions, never a key, token, wallet or personal data. It is on in `ops/host-config.json` (`"record_upload": true`, `"record_upload_delete_local": true`). `zeroed-update` turns `zeroed-record-upload.timer` on or off with each release. The timer runs 10 minutes after boot or switch-on, then an hour after each run ends.

- **What goes up:** from each boot folder in `/var/lib/zeroed/recorder`, the `frames-NNN` and `releases-NNN` files (`.jsonl.zst`, listed with their sha256 in the boot's manifest), once each is 15 minutes old. Once the boot has ended, its `manifest.json` and its saved state go too; a saved state already up is listed, never sent twice. For each ended UTC day: that day's journal lines (`journal-YYYY-MM-DD.jsonl.zst`) and a signed `index-N.json`. `raw-NNN`, `delays-NNN` and plain `.jsonl` files never go.
- **Where:** GitHub Release assets, one prerelease per UTC day (`rec-YYYY-MM-DD`, never "latest"; past 900 assets `rec-YYYY-MM-DD.1`, `.2`, ...). Asset names are `<boot>.<file>`; day files keep their own name.
- **How:** one file at a time, oldest first, at 2 MB/s. The file is checked against its manifest, scanned (below) and hashed again, then curl sends it to the watchdog's `POST /record`, its headers on stdin. The header is signed with the heartbeat key over `t\nRECORD\n/record\n<header>` and carries a one-use nonce. The watchdog checks the signature, the file allowlist and that the repository is private and not this one. It pipes the body to GitHub with a fixed length and reads the asset back by id. It keeps the asset only if GitHub's digest is `sha256:<the signed hash>` with the same size. A name that exists with the same bytes counts as up. An unfinished upload is removed and sent again. Other bytes under the name are never replaced. Then the host reads the asset back once more (`op: check`) before counting it.
- **Bounded state:** `state.json` is read whole under a 48 MB heap, so it holds only unfinished work. A boot whose files are all confirmed upstream and gone from the server (or vanished) is marked done and never read again. A day whose records are all finished, whose standing index lists exactly them, and which ended 2 days ago moves to `days/<day>.json` in the state folder; it is read again only if that day ever gets a new record, and the next index then lists the archived files too. With deletes off, frames and releases files stay on the server and are never archived.
- **A file deleted meanwhile:** RECORD-BUDGET deletes old recordings on its own schedule, so a listed file may be gone by the time it is checked, hashed or sent. It is skipped, logged once as "Vanished before upload", counted in the status file (`vanished`, `vanished_files`), and the run goes on; it is not a failure and raises no alert. A boot folder where a file went while it was listed counts as open for that run, so nothing in it is deleted until it has been quiet for 15 minutes again.
- **Index:** `index-N.json` lists each confirmed file of the day (boot, path, release, asset, asset id, size, sha256), each recorder file that vanished before upload (`vanished`: key, boot, path, listed sha256 and bytes, when), and the boots' manifests. The index, not a manifest copy, says what is upstream: a boot's manifest goes up only once every file it lists is confirmed or vanished, and a file kept back holds it. The uploaded journal slices carry `command [redacted] refused` instead of a refused command's typed text. Its last line is `hmac-sha256=<hex>` over `RECORD-INDEX\n<body>`, with the heartbeat key. A changed set is a new N, never a replacement; the newest N wins. A number already taken upstream (after a lost state file) moves on to the next one. Download a day by verifying every file's sha256 against it.
- **Redaction scan:** each file is read decompressed through the worker's own redaction patterns (`packages/worker/src/run/redact.ts`, kept equal by a test) and the credentials the worker holds. A hit (`[redacted]` alone is not one) keeps the file on the server, unchanged, and alerts naming the file, never the value.
- **Delete after upload:** only a frames or releases file of an ended boot (not the journal's last start, not the newest folder while the worker runs, no plain `.jsonl` and nothing changed for 15 minutes). All of these must hold, checked just before the delete:
  1. It is listed with this sha256 and size in its manifest, and it hashes to that now.
  2. It is a plain file whose real path is inside the recorder folder.
  3. GitHub's asset, read back now, has the same digest and size and is finished.
  4. The day's signed index lists it and still stands.
  5. The delete is written to the state file before the file goes.

  Anything else keeps it. Manifests, saved states, the journal, raw and delays files are never deleted. A running boot's files are uploaded but never deleted: the worker re-reads its own boot folder on every file it seals.
- **Sandbox:** `zeroed-record-upload@.service` runs as `zeroed-worker` with no capability. That user already holds every credential it reads and owns the recorder. It is in the signer's group, so the signer's `/run/zeroed-signer` and `/var/lib/zeroed-signer` are made inaccessible to the unit. Of the worker's `/var/lib/zeroed` it sees only the recorder (read and delete) and `journal.jsonl` (read): an empty read-only `/var/lib/zeroed` with those two bound in, so the ledger and the rest of the worker's state are out of reach. Its only writable data paths are the recorder and its own `/var/lib/zeroed-record-upload` (state, lock, status, finished days), at `Nice=19`, idle I/O, `CPUQuota=25%` and `MemoryMax=96M`.
- **Alerts:** `zeroed-check` raises them from the uploader's status file, once each with a CLEARED line: 3 failed runs in a row, recordings waiting longer than a day, files kept back, no report for 3 hours.  None is raised while `/var/lib/zeroed/recorder` does not exist (the upload unit is skipped then), and "never reported" waits 70 minutes from when `zeroed-check` first saw that folder (a stamp in its state folder, removed when the folder goes).
- **By hand:** `zeroed-record-upload` runs once now; `zeroed-record-upload --day YYYY-MM-DD` runs for one UTC day. Either way it runs in the same sandbox, after any run in progress.

The token (`DATA_STORE_TOKEN`, deployed as `REPORTS_TOKEN`) already has **Contents: Read and write** on the data repository. That is what creating releases and uploading, reading and deleting their assets needs, so nothing changes for the owner.

## Engine folders and market-data pull account (PATHS-FIX)

The engine writes only inside what its unit allows under `ProtectSystem=strict` (`packages/engine/src/paths.ts`; a test checks it against `zeroed-worker.service`):
- `/var/lib/zeroed` (`StateDirectory`, 0700): ledger `bot.db`, logs, recovery journal, first-start marker, disk reserve, provider usage.
- `/var/lib/zeroed-md` (2750, group `zeroed-pull`) with `receipts/` (2770): market-data segments and pull receipts.
- `/var/lib/zeroed-spool` (2730, group `zeroed-spool`): import bundles.
- `/var/lib/zeroed-usage` (2770, group `zeroed-sentinel`): the provider usage ledger, which the sentinel writes too.

The installer makes the last two folders itself, because systemd gives one unit only one `StateDirectoryMode` (systemd.exec). The worker reads through the groups `zeroed-pull` and `zeroed-spool`, never `botops`. Anything in `receipts/` that is not a valid receipt is deleted, with an alert (`packages/engine/src/m07/receipts.ts`).

The pull account `zeroed-pull` has no shell. It is sftp only (`/etc/ssh/sshd_config.d/20-zeroed-pull.conf`) and chrooted to `/srv/zeroed_pull`, where `md` is `/var/lib/zeroed-md` bound read-only and `md/receipts` is bound read-write (`srv-zeroed_pull-*.mount`, mounted before SSH). `receipts/` is its own 64 MiB filesystem with 32,768 inodes (`zeroed-receipts-fs.service`; image `/var/lib/zeroed-receipts/receipts.img`, root-only), so the pull account can never fill the server's disk; a full one refuses new receipts. `zeroed-check` alerts once while that filesystem or either bind is not mounted, with a CLEARED line after.

Two things are needed before it can be used, and both are left for later:
- **SSH:** it stays off unless the server was installed with `--ssh-key`.
- **The operator's key:** none is installed. It goes in `/etc/zeroed/pull-keys/zeroed-pull`.

systemd: Ubuntu 24.04.5 ships systemd 255 (255.4-1ubuntu8.17 where this was built). VERIFY on the server with `systemctl --version`; the ops end-to-end records the version it ran on in its summary.

## Host checks

`zeroed-check` runs every minute and alerts the paired chat once per problem, with a CLEARED line when it ends:
- **Stored keys:** every credential must decrypt and match the ciphertext the key handoff or pairing stored. The check keeps the SHA-256 of the encrypted file, never of a value. A key that is missing, does not open, or changed outside those paths is an alert, naming the key only. To fix it: `zeroed-new-deploy-code`, then Deploy.
- **Webhook:** what Telegram reports (address, certificate, connections, update types) must match what this server set. Any other webhook, or none, is an alert naming only the host, and the server sets its own back. If you did not change it, rotate the bot token at BotFather and run Deploy. While a pairing code is pending the webhook is off on purpose, so that is not an alert.
- **Funnel:** Tailscale Funnel must be off on every port. The app cannot tell a public Funnel address from a tailnet one. Funnel found on is an alert, and the check turns it off. Every install and update runs the same check.
- It also writes the evidence index for the worker API and runs a worker restart that was waiting for a safe moment.

`zeroed-status` shows the key check, a failing webhook, the active dry run, the evidence and the live view.

## Dry run

The worker unit starts `/usr/local/lib/zeroed/worker-start`, for both the reconcile step and the run. The wrapper sets `ZEROED_MODE=paper`, `ZEROED_RECORDER=on`, `ZEROED_SIMULATE=on` and `ZEROED_DRILLS=on`, the health route for the runner on `ZEROED_HEALTH_ADDR=127.0.0.1:8787` and the worker API on `ZEROED_API_ADDR=127.0.0.1:8788`. It runs the release's own worker (`packages/worker/src/main.ts`, under the host's Node 22 with no `node_modules`) when the release's `ops/host-config.json` says `"worker": "release"`, which it does since SWITCH-1. A release without that switch, or without the file, runs the host's stand-in. The release's worker also gets the S0 shakedown settings of that file's `"shakedown"` block (PRACTICE-ON): `ZEROED_STRATEGY`, `ZEROED_S0_DIAGNOSTIC`, `ZEROED_PAPER_EDGE_PPM`, `ZEROED_STANDINS` and `ZEROED_WALLET`, public values only and nothing else; a block with any other name, or a value that is not letters, digits and commas, stops the start (exit 2), and `worker-smoke` tries a new release with the same settings, so a release whose worker refuses them (S0 in a release that names a qualifying run, for one) never becomes current. **Rule (supervisor, 2026-10-04): the commit that adds `packages/runner/qualifying-run.json` must remove the `"shakedown"` block.** If it does not, `worker-smoke` refuses that release and the host stays on the release before it, the safe side. Live is never set there or in any environment file, and the worker refuses any mode but paper.

Evidence stays on the host in `/var/lib/zeroed-dryrun/evidence/<run id>/` (root only), written by `zeroed-dryrun@<name>`. Nothing uploads it; the way into the repository waits for the owner's decision. `zeroed-check` writes its index (id, name, label, commit, start, finished, pass, aborted reason, path) to `/var/lib/zeroed-index/evidence.json`. The worker API's `GET /health` lists it as `evidence`, and `zeroed-status` counts the runs. The restore drill for host-loss drills is `zeroed-restore-drill /etc/zeroed/age/host.key`. The reboot drill unit `zeroed-dryrun-reboot.service` arrives with RUN-1's units.

## Online

The app shows the server as Online when the worker API answers it with data that passes the app's checks. That needs:
1. The release's own worker running. `zeroed-status` shows `Worker: active (the release's worker, <commit>)`. `(the host's stand-in)` means the server still runs a release from before the switch; the next code update moves it.
2. The live view on (below), and the phone in the same tailnet.
3. In the app, the server address set to the live view address.

With no provider reachable, or keys missing, the worker still answers: it runs degraded, entries are halted, and the app shows why.

## Live view

The worker API listens on 127.0.0.1:8788 only. `zeroed-tailscale` publishes it to your own tailnet over HTTPS at `https://zeroed.<your tailnet>.ts.net`, with Funnel off. No public port opens: the firewall accepts HTTPS only on the `tailscale0` interface. It uses Tailscale Personal, which is free.

Owner steps, once:
1. Make a free Tailscale account at tailscale.com and install the Tailscale app on your phone. Log in to the app with that account.
2. In the Tailscale admin console, open **DNS** (https://login.tailscale.com/admin/dns). Turn on **MagicDNS**, then under **HTTPS Certificates** select **Enable HTTPS**.
3. On the server console, run `zeroed-tailscale`. It installs Tailscale (its package key is checked against a pinned fingerprint), then shows a login link. The link is also sent to your Telegram chat.
4. Open the link on your phone and log in with the same account. The console then shows `Live view: https://zeroed.….ts.net`.

If step 2 was skipped, the console shows `Stopped: the live view needs MagicDNS and HTTPS Certificates on your tailnet …` (or only the one that is missing) and the same line goes to your Telegram chat. Turn it on as in step 2, then run `zeroed-tailscale` again; the login is kept. A Tailscale command that does not answer within 60 seconds stops the script with a `Stopped:` line instead of leaving it waiting.

The command is safe to run again. It checks that the target is the loopback worker API before publishing, and after publishing it checks that Tailscale serves exactly that, with Funnel off. Anything else is taken down at once and nothing stays published. `zeroed-tailscale --off` stops publishing the API and leaves Tailscale installed. Tailscale updates come from its own repository through unattended-upgrades, like Ubuntu's security updates, with no automatic reboot.

A server installed from an earlier line (before this fix) has its webhook off after pairing. To turn it on: paste the current install line (keys and pairing are kept), run `zeroed-new-deploy-code`, put the code in `DEPLOY_CODE`, and run Deploy; the server sets the webhook after that handoff.

## Worker contract (for WORKER-1)

- Serve the API on `ZEROED_API_ADDR` (`127.0.0.1:8788` on the host, loopback only; the health route for the runner stays on `ZEROED_HEALTH_ADDR`, `127.0.0.1:8787`). The API serves the app's paths (`/api/v1/<mode>/…`, ARCHITECTURE.md §12.4); a mode the worker does not run answers with `data: null` and a reason, and the app shows "Not running". Dry-run evidence stays in `/var/lib/zeroed-index/evidence.json`, which `zeroed-status` reads.
- Write the number of open intents to `$STATE_DIRECTORY/open_intents` after every reconcile and intent change. The server only updates code while it reads `0`.
- Write the number of open positions to `$STATE_DIRECTORY/open_positions` with it (RC-FIXES-2b). A probation rollback (`zeroed-update`) waits while either reads anything but `0`; the host's stand-in writes neither count, so a rollback onto it with a release before waits.
- Send the heartbeat fields in `packages/ops/src/watchdog/logic.ts` (`Heartbeat`), including `owner_chat_id` from the `telegram_chat_id` credential, signed over `t\nPOST\n/heartbeat\nbody`.
- Apply the watchdog's `paused` reply both ways: pause stops new entries, never exits; `false` allows entries again. The state and the log must agree.
- Post the daily summary (`packages/ops/src/watchdog/summary.ts` shape) to `/summary` on the Melbourne wall-clock slots of `ZEROED_SUMMARY_MS` (default 30 minutes, so :00 and :30, about a minute after), just after Melbourne midnight, and about 3 minutes after each reconciled start unless the last accepted post (`last_posted_ms` in `summary.json`) was under 10 minutes before, signed over `t\nPOST\n/summary\nbody` with a signature time newer than the last one. Never wait on it.

## Test it

`bash ops/test/e2e.sh` runs on a fresh Ubuntu 24.04 systemd container with test values only:
- the README line, the D07 preflight (a 1 GB server and a 25.6 GB disk refused before any change, an update on one only warned), the install, and a wrong code;
- the handoff, a replay, and Telegram pairing;
- hardening, rotation, the code-update gates, backup and restore, and restart drills;
- the dry-run update gate, `install.sh --update` through `zeroed-update` (with SSH kept open or closed), the worker wrapper and the worker API's evidence list;
- webhook change alerts, retries with back-off and the notice after 5 failed tries; the stored-key check;
- re-pairing (refused, wrong code, expiry, success during a dry run) and the live view with a Tailscale stand-in.
- the release's own worker (SWITCH-1): it runs on the host's Node 22 with keys from systemd credentials, reconciles first, serves health and the API on loopback, runs degraded without providers, restarts clean and refuses live. A release whose worker cannot start (a syntax error, a missing file, a refused config) is never switched to.

It ends with a scan of every log and output for every test value and code. The `ops-e2e` workflow runs it on every change to `ops/`.
