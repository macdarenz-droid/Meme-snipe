# Zeroed host

How the VPS is installed, gets its keys, updates, is watched and backed up (ARCHITECTURE.md §12, OPS-1). Nobody copies a key by hand: the host makes its own key pair, GitHub encrypts the repository secrets to it, and only the host can open them.

## Server

Vultr High Performance, Frankfurt, 1 vCPU / 1 GB AMD (`vhp-1c-1gb-amd`, about US$6/month), image **Ubuntu 24.04 LTS x64**. Ubuntu 24.04 gets standard security updates until 2029; Debian 12 left regular security support in June 2026. Hetzner CX23 (Nuremberg) is the backup with the same image.

## Install (once, in the Vultr web console)

Log in as root in the server's web console and paste this one line:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/macdarenz-droid/Meme-snipe/2521856cdbe4c762d7f92761f891b8c936a5ded8/ops/install.sh && echo 'cc3cc4b08d44589ae24e0619aa9eff351309c106bfd3d9255c1abe44dfd01a5b  install.sh' | sha256sum -c - && bash install.sh
```

SHA-256 of `install.sh`: `cc3cc4b08d44589ae24e0619aa9eff351309c106bfd3d9255c1abe44dfd01a5b`

The hash is checked before anything runs; a changed file stops at `sha256sum -c`. After any change to `ops/install.sh`, the commit in the link must be moved to one that holds the new file (`ops/test/e2e.sh` fails otherwise). The installer:

- installs `age`, `git`, `jq`, `nftables`, `sqlite3`, `unattended-upgrades` from Ubuntu, and Node 22.23.3 from nodejs.org (checked against its pinned SHA-256);
- creates the `zeroed-worker` and `zeroed-signer` users and their systemd units with the §12.1 hardening (the signer has no network at all; the worker may only use HTTPS and DNS);
- turns on unattended security updates;
- closes every inbound port and turns SSH off (`bash install.sh --ssh-key 'ssh-ed25519 AAAA…'` keeps SSH on, key-only, for that key);
- makes the host's age key pair (private half `/etc/zeroed/age/host.key`, root-only) and prints only the **host public key** and a **pairing code**.

Running it again is safe: the key, the pairing code and stored credentials are kept.

## Keys (Deploy workflow)

1. In Telegram, send any message to the bot (so it may write to you).
2. In GitHub: Actions → **Deploy** → Run workflow, on the default branch. Paste the host public key and the pairing code from the console. Optionally paste your own backup public key (below).
3. Within a minute the host confirms in Telegram: "keys stored (6 values) … Worker running".

What happens: the workflow encrypts `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and a fresh heartbeat key to the host's public key (`ops/deploy/publish.sh`) and publishes the ciphertext as the only asset of a prerelease tagged `pair-<pairing code>`. The host (`zeroed-pair`, every minute) downloads it, accepts it only if the release was made by this repository's workflow, the pairing code inside matches and its issue number is newer than the last one applied, then stores each value as an encrypted systemd credential (`/etc/credstore.encrypted`, readable by the worker's unit only) and restarts the worker. The workflow deletes the release after the host downloaded it, or after 15 minutes.

Trade-off, recorded in DECISIONS.md: the ciphertext is public for up to 15 minutes; only the host's private key opens it.

**Rotation:** change the secret in GitHub, run Deploy again with the same host key and pairing code. Every value is replaced (the heartbeat key too), and the worker restarts after reconciling.

## Code updates

Every Deploy run also moves the tag `deploy` to the newest commit on `ccr-14987baf-i6lrsl` that GitHub signed, which is a pull-request merge (`ops/deploy/tag.sh`). Commits pushed straight to the branch are never deployed. The host (`zeroed-update`, every 5 minutes) fetches the tag, checks the commit's signature against GitHub's merge key pinned at install (fingerprint `968479A1AFF927E37D1A566BB5690EEEBB952194`) and that it is on the branch, switches `/opt/zeroed/current` to it and restarts the worker; the worker's first step on every start is reconcile.

## Watchdog

`packages/ops` is a Cloudflare Worker on its free `workers.dev` address: a cron every minute and one Durable Object holding the last heartbeat, active alerts, the pause flag and the lease. The worker posts an HMAC-signed heartbeat (`x-zeroed-signature: t=…,v1=…`) every 20 s. Checks: heartbeat older than 90 s, slot lag against a different RPC, on-chain position versus reported, stop breached with no exit attempt in 60 s, unresolved intents past blockhash expiry, SOL reserve below the floor, signer unreachable. Alerts go to Telegram once, repeat every 5 minutes while active, and send a "cleared" line.

Telegram commands: only `/pause` and `/status`, only from `TELEGRAM_CHAT_ID`. `/pause` stops new entries and never stops exits; it can only be cleared from the host (`zeroed-resume`, signed with the heartbeat key). Until WORKER-1 lands, a stub worker (`/opt/zeroed/stub/worker.mjs`) sends the heartbeats.

The Deploy workflow deploys the watchdog and sets its secrets and the Telegram webhook when `CLOUDFLARE_API_TOKEN` exists; without it, it skips the watchdog with a warning.

## Backups

Every hour `zeroed-backup` copies each SQLite file under `/var/lib/zeroed` with SQLite's online backup, checks it, writes a SHA-256 manifest and encrypts the bundle with age to the host key and, once given, your backup key. The newest 72 stay in `/var/backups/zeroed`.

Restore drill (never touches the live files): `zeroed-restore-drill /etc/zeroed/age/host.key` or, with your own key on another machine, `zeroed-restore-drill your-key.txt zeroed-….tar.age`. It prints PASS after the manifest, the integrity check and the table list all match.

To restore for real: `systemctl stop zeroed-worker`, decrypt and unpack the bundle into `/var/lib/zeroed`, `chown -R zeroed-worker: /var/lib/zeroed`, `systemctl start zeroed-worker` (it reconciles first).

## Owner steps left

| Step | Where | Scope |
| --- | --- | --- |
| Create the server (above) and paste the install line | Vultr | Ubuntu 24.04 LTS x64, Frankfurt, High Performance 1 vCPU / 1 GB |
| Add secret `TELEGRAM_CHAT_ID` | GitHub → Settings → Secrets and variables → Actions | Your Telegram user id: message @userinfobot in Telegram, it replies with it |
| Add secret `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → template "Edit Cloudflare Workers" | Account resources: only your account. Zone resources: none needed |
| Add secret `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages (right column) | Not secret, but kept with the token |
| Pick a workers.dev subdomain once | Cloudflare → Workers & Pages | Free |
| Optional: backup key | On your own computer: `age-keygen -o zeroed-backup.txt`; keep that file offline; paste its `age1…` public key into Deploy | Without it, backups open only with the host key |

## Test it

`bash ops/test/e2e.sh` installs from scratch into a fresh Ubuntu 24.04 systemd container with test secrets only, runs Deploy's publish script against a local stand-in for GitHub and Telegram, rotates, checks hardening, backup and restore, and finally scans every log and output for the test values.
