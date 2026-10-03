# Zeroed server

How the server is installed, gets its keys, pairs with Telegram, updates and is backed up (ARCHITECTURE.md §12, OPS-1a and OPS-1b). Nobody copies a key by hand. The only things typed by hand are a 6-word code and a 6-digit code.

Server: Vultr High Performance, Frankfurt, 1 vCPU / 1 GB, image **Ubuntu 24.04 LTS x64**. Ubuntu 24.04 gets standard security updates until 2029; Debian 12 left regular security support in June 2026.

## Setup (about 3 minutes)

1. **Log in.** In Vultr, open the server's Overview page and copy the root password. Open **View Console**. At `login:` type `root` and press Enter. At `Password:` use the console's control bar → Clipboard → Paste, then press Enter.
2. **Install.** Paste this one line the same way (Clipboard → Paste), then press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/macdarenz-droid/Meme-snipe/b1a9afc86796561c695f90feeb166c89d8890325/ops/install.sh -o i && echo '328c53f347feb0ce4a80adfd4c27142234a9fca72f6818ef76f38ddc430ceca7  i' | sha256sum -c && bash i
```

   The line checks the file against its SHA-256 before anything runs; a changed file stops at `sha256sum -c`. After about two minutes the screen shows a **deploy code** of 6 words.
3. **Keys.** In GitHub: Settings → Secrets and variables → Actions → New repository secret. Name `DEPLOY_CODE`, value: the 6 words, with spaces between them. Then Actions → **Deploy** → Run workflow.
4. **Telegram.** Within a minute the console shows a 6-digit pairing code. Send `/pair` and the code to the bot in Telegram, for example `/pair 123456`. The bot answers "Paired" and the console says "Setup finished".

The console screen can be left at any time (Ctrl+C); setup carries on in the background. `zeroed-status` shows where it stands and the codes again.

SHA-256 of `install.sh`: `328c53f347feb0ce4a80adfd4c27142234a9fca72f6818ef76f38ddc430ceca7`

After any change to `ops/install.sh`, the commit in the line must move to one that holds the new file (`ops/test/e2e.sh` fails otherwise).

## What the installer does

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

Each code has one try: any wrong `/pair` cancels it. A new code comes only from the console: `zeroed-pair-code`.

## Rotation

Run `zeroed-new-deploy-code` on the console and put the new 6 words in `DEPLOY_CODE`. Change the API keys in GitHub if needed, then run Deploy. Every key is replaced, the worker restarts after reconciling, and Telegram confirms.

## Code updates

Every Deploy run also moves the tag `deploy` to the newest commit on `ccr-14987baf-i6lrsl` that GitHub signed, which is a pull-request merge (`ops/deploy/tag.sh`). Every 5 minutes the server (`zeroed-update`) switches to it only when all of these hold:
- the commit carries GitHub's merge signature (fingerprint `968479A1AFF927E37D1A566BB5690EEEBB952194`, pinned at install);
- it is on the branch;
- every check run on it finished green (public API);
- the worker reports no open intent (`/var/lib/zeroed/open_intents`).

The worker reconciles before every start. Residual risk: write access to the repository is the ability to deploy; the signer (SIGN-1) is the separate guard on funds.

## Backups

Every hour `zeroed-backup` copies each SQLite file under `/var/lib/zeroed` with SQLite's online backup and checks it. It writes a SHA-256 manifest and encrypts the bundle with age to the host key and, once set, to the owner's backup code. The newest 72 stay in `/var/backups/zeroed`.

**Off-server copy (free, no R2): off until the owner approves.** Sending backups to Telegram is sending data to a third party, which needs the owner's approval (CLAUDE.md). The timer is installed but disabled, and `zeroed-backup-offsite` refuses to send while `ops/host-config.json` says `"offsite_backup": false` (the default). Switching it on is a reviewed commit that sets it to `true`; the next code update (`zeroed-update`) applies it.

Once on: run `zeroed-backup-code` once at the console. It shows a 6-word backup code one time; write it down. Only its public half (an age recipient, derived with the same scrypt step as the deploy code but a different salt) stays on the server. Every day at about 03:20 Melbourne time the newest backup is re-encrypted to that recipient alone, so nothing on the server, the host key included, can open the copy. It is then sent as a silent Telegram document to the paired chat (bots may send up to 50 MB).

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
- signer unreachable.

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

If the chat is re-paired later (`zeroed-pair-code`), the server turns the webhook off to read `/pair` and sets it again as soon as the pairing succeeds.

A server installed from an earlier line (before this fix) has its webhook off after pairing. To turn it on: paste the current install line (keys and pairing are kept), run `zeroed-new-deploy-code`, put the code in `DEPLOY_CODE`, and run Deploy; the server sets the webhook after that handoff.

## Worker contract (for WORKER-1)

- Write the number of open intents to `$STATE_DIRECTORY/open_intents` after every reconcile and intent change. The server only updates code while it reads `0`.
- Send the heartbeat fields in `packages/ops/src/watchdog/logic.ts` (`Heartbeat`), including `owner_chat_id` from the `telegram_chat_id` credential, signed over `t\nPOST\n/heartbeat\nbody`.
- Apply the watchdog's `paused` reply both ways: pause stops new entries, never exits; `false` allows entries again. The state and the log must agree.

## Test it

`bash ops/test/e2e.sh` runs on a fresh Ubuntu 24.04 systemd container with test values only:
- the README line, the install, and a wrong code;
- the handoff, a replay, and Telegram pairing;
- hardening, rotation, the code-update gates, backup and restore, and restart drills.

It ends with a scan of every log and output for every test value and code. The `ops-e2e` workflow runs it on every change to `ops/`.
