# Old server copy

The old 1 GB server `zeroed` is stopped, not deleted. Its ledger, saved state and journal are copied to the new 2 GB host before the old server may be deleted ("Disk cycle": never deleted). The copy goes over your own tailnet only: no new service, no cost, and no third party. On the new host it lands in a root-only folder, `/var/lib/zeroed-archive/old-server`, that the bot never reads ("Its state is never reused").

Route: supervisor rulings of 9 Oct (`docs/reviews/OPSREC.md` on `claude/supervisor-docs-3`, option F and round 2).
- The old server is first opened from a rescue disk, so none of its bot units can start when it boots.
- It then shares a copy folder with `tailscale serve`, and the new host downloads it over HTTPS on the tailnet.
- Both firewalls already allow that: inbound is HTTPS on `tailscale0` only, and root may connect out. No firewall change and no SSH.

## What was checked

- **Old server's release:** `171a61ce`, the deploy tag when the new host was installed on 8 Oct (HANDOVER, 8:48 AM). Its `ops/host-config.json` says `"worker": "stub"` (the stand-in: no provider calls, no trades). The old server may have taken a later tag before it was stopped, so step 2 reads the release from the disk before anything boots.
- **What would start at a normal boot** (`171a61ce` installer):
  - the stand-in worker and the signer;
  - the key check (30 s), the host check (2 min), the code update (2 min), the recording upload (10 min), the hourly backup and the dry-run tick.
  - The host check re-sets the Telegram webhook if it differs from the one it stored, which can take Telegram away from the new host. The code update pulls the current deploy tag.
  - So step 2 removes every `zeroed-*` start link from the rescue disk before the old system ever boots. Tailscale keeps starting, and the copy needs it.
- **Files:**
  - in `/var/lib/zeroed`: `ledger.sqlite` (with `-wal` and `-shm`), `deployer-state.json` (saved state) and `journal.jsonl`;
  - from the code at `171a61ce`: `Ledger.FILE`, `PERSIST_FILE`, `STATE_FILES.journal`, state folder `/var/lib/zeroed`.
  - The other small state files go in `rest.tar`. Recordings (`recorder/`) are not copied; their uploaded copies are in `zeroed-data`.
  - The live ledger is never opened for writing: its three files are copied as they are, and the backup is made from that copy.
- **Tailscale:**
  - `tailscale serve <absolute path>` shares a folder over HTTPS. Tailscale's HTTPS certificate is for the machine's tailnet name ([tailscale serve](https://tailscale.com/kb/1242/tailscale-serve)).
  - Both hosts run Tailscale with `--accept-dns=false` (`zeroed-tailscale`), so tailnet names do not resolve on them. The download therefore gives curl the old server's tailnet IP with `--resolve`, and TLS is still checked against the name.
  - Both machines may show the name `zeroed`. Tailscale then names one of them `zeroed-1`, so always use the name step 4 prints.
- **Rescue disk:** Vultr's ISO library has SystemRescue. **Settings → Custom ISO → ISO Library → Attach ISO and Reboot** boots it, and it does not return to the server's own system until the ISO is removed ([Vultr: troubleshoot with bootable ISOs](https://docs.vultr.com/troubleshoot-your-vps-with-bootable-isos); [Vultr: attach a custom ISO](https://docs.vultr.com/products/compute/instances/cloud-compute/management/custom-iso)). The disk is mounted with `mount /dev/vdaN /mnt` after `lsblk`.

## Steps

**1. New host: check Tailscale and Telegram.**
Log in to the new host's console (Vultr **View Console**, `linuxuser`, then `sudo -i`). Run:

```sh
tailscale status | head -5; zeroed-status | grep '^Telegram:'
```

Check: your devices are listed, and the last line says `Telegram:  paired`.
- If `tailscale` is not found or logged out, run `zeroed-tailscale` and follow "Live view" in `ops/README.md` first.

**2. Old server: open it from the rescue disk and switch the bot off.**
In Vultr, open the old server `zeroed` → **Settings** → **Custom ISO**. In **ISO Library** pick **SystemRescue**, then **Attach ISO and Reboot**. Open **View Console** and choose **Boot SystemRescue using default options**. At the rescue prompt, run `lsblk -f` and note the largest `ext4` partition (for example `vda1`). Then paste, with that name in place of `vda1`:

```sh
P=/dev/vda1; mount "$P" /mnt && rel="$(readlink /mnt/opt/zeroed/current)" && echo "release: $rel" && grep '"worker"' "/mnt$rel/ops/host-config.json"
mountpoint -q /mnt && [ -d /mnt/etc/systemd/system ] && find /mnt/etc/systemd/system -path '*.wants/zeroed-*' -print -delete && touch /mnt/root/OLD-SERVER-ONLY && sync && umount /mnt && echo DONE || echo "NOT mounted: nothing done"
```

Check:
- the first lines show the release and `"worker": "stub"`;
- a list of removed `zeroed-…` links follows. It includes at least `multi-user.target.wants/zeroed-worker.service` and `timers.target.wants/zeroed-check.timer`;
- the last line is `DONE`. If it says `NOT mounted`, the mount failed: check the partition name from `lsblk -f` and paste both lines again.

If it says `"release"`, write down the line and carry on: no bot unit starts now either way.

Then in Vultr: **Custom ISO** → **Remove ISO**. The server reboots into its own system.

- VERIFY: the exact SystemRescue name in the ISO library, that it costs nothing, and the **Remove ISO** wording. Vultr's pages show the attach button but not the remove step or any price.
- VERIFY: that `linuxuser` still logs in afterwards. Vultr warns that installing a custom ISO "disables the default user credentials" ([Vultr: attach a custom ISO](https://docs.vultr.com/products/compute/instances/cloud-compute/management/custom-iso)). Here the ISO is only booted, not installed, and the old system's own password is unchanged.
- Fallback, only if the ISO library has no SystemRescue: at the boot menu, edit the kernel line and add `systemd.mask=zeroed-worker.service systemd.mask=zeroed-signer.service systemd.mask=zeroed-check.timer systemd.mask=zeroed-update.timer systemd.mask=zeroed-record-upload.timer systemd.mask=zeroed-pair.timer systemd.mask=zeroed-dryrun-tick.timer`. After logging in, run `touch /root/OLD-SERVER-ONLY` once (step 3 needs it); step 3 then checks that no zeroed unit is active. VERIFY: that the menu can be reached on the Vultr console (Ubuntu hides it by default; hold Shift or press Esc while it starts).

**3. Old server: log in, check that the bot is off, make the copy.**
Log in on **View Console** (`linuxuser`, then `sudo -i`). Paste:

```sh
if [ -e /root/OLD-SERVER-ONLY ]; then
  systemctl list-units 'zeroed-*' --state=active --no-legend; echo "units above must be none"
  d=/root/old-copy; s="$d/live"; install -d -m 0700 "$d" "$s"; cd /var/lib/zeroed && ls -l
  cp -p ledger.sqlite* "$s/" && sqlite3 "$s/ledger.sqlite" ".backup '$d/ledger.sqlite'" && sqlite3 -readonly "$d/ledger.sqlite" 'PRAGMA integrity_check;'
  cp -p deployer-state.json journal.jsonl "$d/"
  tar -cf "$d/rest.tar" --exclude=./recorder --exclude='./ledger.sqlite*' .
  rm -rf "$s"; cd "$d" && sha256sum ledger.sqlite deployer-state.json journal.jsonl rest.tar > SHA256SUMS && sha256sum SHA256SUMS | cut -c1-12
else echo "NOT the old server: nothing done"; fi
```

Check:
- no unit is listed above "units above must be none";
- the integrity line prints `ok`, and no line says `No such file`.
- Write down the last line (12 characters).
- If a file is missing, take a photo of the `ls -l` list and stop here. VERIFY: a server that never ran a release worker has no ledger.

**4. Old server: share the folder on the tailnet.**

```sh
if [ -e /root/OLD-SERVER-ONLY ] && [ -d /root/old-copy ]; then
  tailscale serve reset; tailscale serve --bg /root/old-copy && tailscale serve status
  tailscale status --json | jq -r .Self.DNSName; tailscale ip -4
else echo "NOT the old server: nothing done"; fi
```

Check: the status names `/root/old-copy`. Write down the last two lines:
- the name (ends in `.ts.net.`; drop the final dot);
- the IP (starts with `100.`).

VERIFY: older Tailscale versions have no `--bg`. If it says unknown flag, run `tailscale version` and stop here ([tailscale serve](https://tailscale.com/kb/1242/tailscale-serve)).

**5. New host: download and check.**
Put the name and IP from step 4 in the first two lines, then paste:

```sh
OLD=zeroed.example.ts.net
IP=100.64.0.1
a=/var/lib/zeroed-archive/old-server; install -d -m 0700 /var/lib/zeroed-archive "$a"; cd "$a"
for f in SHA256SUMS ledger.sqlite deployer-state.json journal.jsonl rest.tar; do curl -fsS -m 600 --resolve "$OLD:443:$IP" -o "$f" "https://$OLD/$f" || echo "FAILED $f"; done
sha256sum -c SHA256SUMS && sqlite3 -readonly ledger.sqlite 'PRAGMA integrity_check;' && sha256sum SHA256SUMS | cut -c1-12
```

Check:
- four lines end in `OK`, the integrity line prints `ok`, and no line says `FAILED`;
- the last 12 characters are the same as step 3's.

That match means every file arrived byte for byte. VERIFY: that `tailscale serve` serves each file of the folder at `/<name>`. The docs say a folder is served as a listing with links to its files ([tailscale serve](https://tailscale.com/kb/1242/tailscale-serve)).

**6. Old server: stop sharing and power off.**

```sh
if [ -e /root/OLD-SERVER-ONLY ] && [ -d /root/old-copy ]; then tailscale serve reset; rm -rf /root/old-copy; poweroff; else echo "NOT the old server: nothing done"; fi
```

Check: Vultr shows the old server **Stopped**.

**7. New host and Telegram: check that nothing moved.**
- In Telegram, send `/status` to your bot. Check: it answers.
- On the new host, run `zeroed-status | grep '^Telegram:'`. Check: `Telegram:  paired`.
- If the bot does not answer: on the new host run `zeroed-new-deploy-code`, put the code in the `DEPLOY_CODE` secret, and run Deploy. The new host then sets the webhook again ("Live view" in `ops/README.md`).

**8. Delete the old server (your step, only after steps 5 and 7 passed).**
In Vultr, open `zeroed` → **Settings** → **Destroy**. VERIFY: the Vultr menu wording.

## After

- The copy stays only on the new host's disk until the new host has an off-server backup (an open owner wait).
- The bot never reads `/var/lib/zeroed-archive`.
