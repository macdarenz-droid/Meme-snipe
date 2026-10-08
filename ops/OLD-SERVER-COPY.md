# Old server copy

The old 1 GB server `zeroed` is stopped, not deleted. Its ledger, saved state and journal are copied to the new 2 GB host before the old server may be deleted ("Disk cycle": never deleted). The copy goes over your own tailnet only: no new service, no cost, and no third party. On the new host it lands in a root-only folder, `/var/lib/zeroed-archive/old-server`, that the bot never reads ("Its state is never reused").

Route: supervisor ruling, 9 Oct (`docs/reviews/OPSREC.md` on `claude/supervisor-docs-3`, option F). The old server shares the folder with `tailscale serve`, and the new host downloads it over HTTPS on the tailnet. Both firewalls already allow that: inbound is HTTPS on `tailscale0` only, and root may connect out. No firewall change, no SSH and no Taildrop (Taildrop is in alpha).

## What was checked

- **Old server's release:** `171a61ce`, the deploy tag when the new host was installed on 8 Oct (HANDOVER, 8:48 AM). Its `ops/host-config.json` says `"worker": "stub"` (the stand-in: no provider calls, no trades) and `"record_upload": true`. VERIFY: the old server may have taken a later tag before it was stopped. Step 2 shows the release it runs.
- **What starts at boot:**
  - the stand-in worker and the signer;
  - timers: key check `zeroed-pair` (30 s), host check `zeroed-check` (2 min), code update `zeroed-update` (2 min), recording upload `zeroed-record-upload` (10 min), hourly backup, daily off-server copy (off), and the dry-run tick.
  - The host check re-sets the Telegram webhook if it differs from the one it stored, which can take Telegram away from the new host. The code update would pull the current deploy tag. So step 2 stops every timer first. VERIFY: whether the host check fires in the first 2 minutes before step 2 is done. If Telegram stops answering on the new host after this, run Deploy again (it re-sets the webhook from the new host).
- **Files:**
  - in `/var/lib/zeroed`: `ledger.sqlite` (with `-wal`/`-shm` while open), `deployer-state.json` (saved state) and `journal.jsonl`;
  - from the code at `171a61ce`: `Ledger.FILE`, `PERSIST_FILE`, `STATE_FILES.journal`, state folder `/var/lib/zeroed`.
  - The other small state files go in `rest.tar`. Recordings (`recorder/`) are not copied; their uploaded copies are in `zeroed-data`.
- **Tailscale:** `tailscale serve <absolute path>` shares a folder over HTTPS with a certificate Tailscale provides (Tailscale docs, "tailscale serve"). The old server is on your tailnet (live view, key expiry off since 4 Oct). VERIFY: whether the new host is on the tailnet yet. Its setup screen said "live view off".

## Steps

Log in to each console as usual: Vultr **View Console**, `linuxuser`, then `sudo -i`. Paste each block as one piece.

**1. New host: join the tailnet (skip if done).**
Run `tailscale status`.
- If it shows your devices, go to step 2.
- If it says the command is not found or logged out, run `zeroed-tailscale` and follow "Live view" in `ops/README.md`.

Check: `tailscale status` lists your phone.

**2. Old server: start it and stop the bot at once.**
In Vultr, open the old server `zeroed`, press **Start**, open **View Console** and log in. Then paste:

```sh
systemctl stop 'zeroed-*.timer' 'zeroed-record-upload@*' zeroed-update zeroed-check zeroed-pair zeroed-worker zeroed-signer
systemctl list-units 'zeroed-*' --state=active --no-legend; readlink /opt/zeroed/current
```

Check: the list is empty, and the last line ends in the release folder (`171a61ce…` or later; note it).

**3. Old server: make the copy.**

```sh
d=/root/old-copy; install -d -m 0700 "$d"; cd /var/lib/zeroed && ls -l
sqlite3 ledger.sqlite ".backup '$d/ledger.sqlite'" && sqlite3 "$d/ledger.sqlite" 'PRAGMA integrity_check;'
cp -p deployer-state.json journal.jsonl "$d/"
tar -cf "$d/rest.tar" --exclude=./recorder --exclude='./ledger.sqlite*' .
cd "$d" && sha256sum ledger.sqlite deployer-state.json journal.jsonl rest.tar > SHA256SUMS && sha256sum SHA256SUMS | cut -c1-12
```

Check: the integrity line prints `ok`, and no line says `No such file`. Write down the last line (12 characters).
- If a file is missing, take a photo of the `ls -l` list and stop here. VERIFY: a server that never ran a release worker has no ledger.

**4. Old server: share the folder on the tailnet.**

```sh
tailscale serve reset; tailscale serve --bg /root/old-copy && tailscale serve status; tailscale status --json | jq -r .Self.DNSName
```

Check: the status names `/root/old-copy`. The last line is the old server's address (ends in `.ts.net.`); write it down without the final dot.
- VERIFY: older Tailscale versions have no `--bg`. If it says unknown flag, run `tailscale version` and stop here.

**5. New host: download and check.**
Replace `OLD` with the address from step 4, then paste:

```sh
OLD=zeroed.example.ts.net
a=/var/lib/zeroed-archive/old-server; install -d -m 0700 /var/lib/zeroed-archive "$a"; cd "$a"
for f in SHA256SUMS ledger.sqlite deployer-state.json journal.jsonl rest.tar; do curl -fsS -m 600 -o "$f" "https://$OLD/$f" || echo "FAILED $f"; done
sha256sum -c SHA256SUMS && sqlite3 ledger.sqlite 'PRAGMA integrity_check;' && sha256sum SHA256SUMS | cut -c1-12
```

Check:
- four lines end in `OK`, the integrity line prints `ok`, and no line says `FAILED`;
- the last 12 characters are the same as step 3's.

That match means every file arrived byte for byte. VERIFY: that `tailscale serve` serves each file at `/<name>` (the docs say a folder is served as a listing with links).

**6. Old server: stop sharing and power off.**

```sh
tailscale serve reset; rm -rf /root/old-copy; poweroff
```

Check: Vultr shows the old server **Stopped**.

**7. Delete the old server (your step, only after step 5 passed).**
In Vultr, open `zeroed` → **Settings** → **Destroy**. VERIFY: the Vultr menu wording.

## After

- The copy stays only on the new host's disk until the new host has an off-server backup (an open owner wait).
- The bot never reads `/var/lib/zeroed-archive`.
