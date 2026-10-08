#!/usr/bin/env bash
# Zeroed host installer. Built from ops/host by ops/build-install.mjs; edit the sources, not ops/install.sh.
# Run once as root on a fresh Ubuntu 24.04 LTS server (see ops/README.md). Safe to run again: the host key,
# the pairing code and stored credentials are kept.
#
#   bash install.sh                      SSH off (use the provider's web console)
#   bash install.sh --ssh-key 'ssh-ed25519 AAAA... me'   SSH on, key-only, for that key
#   bash install.sh --update             run by zeroed-update after each deploy: host files and units only;
#                                        keeps SSH as it is, shows no code and starts no setup screen
#
# Never prints a secret. Never uses set -x.
set -euo pipefail
umask 022

SSH_KEY=""
UPDATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
# An update keeps the addresses this host was installed with.
if [ "$UPDATE" = 1 ]; then
  [ -f /etc/zeroed/host.env ] || { echo "Install stopped: --update needs an installed host" >&2; exit 1; }
  . /etc/zeroed/host.env
fi

REPO="${ZEROED_REPO:-macdarenz-droid/Meme-snipe}"
BRANCH="${ZEROED_BRANCH:-ccr-14987baf-i6lrsl}"
GITHUB_URL="${ZEROED_GITHUB_URL:-https://github.com}"
API_URL="${ZEROED_API_URL:-https://api.github.com}"
TELEGRAM_URL="${ZEROED_TELEGRAM_URL:-https://api.telegram.org}"
NODE_VERSION=v22.23.3
NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
NODE_URL="${ZEROED_NODE_URL:-https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz}"
WEB_FLOW_FPR=968479A1AFF927E37D1A566BB5690EEEBB952194

say() { printf '==> %s\n' "$*"; }
die() { printf 'Install stopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "needs Ubuntu 24.04 LTS (found ${PRETTY_NAME:-unknown})"
[ "$(uname -m)" = x86_64 ] || die "needs an x86_64 server"
[ "$UPDATE" = 0 ] || [ -z "$SSH_KEY" ] || die "--update keeps SSH as it is; --ssh-key needs a full install"
if [ -n "$SSH_KEY" ]; then
  [[ "$SSH_KEY" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com)\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] || die "--ssh-key must be one public key line (ssh-ed25519 or ecdsa)"
fi

# D07 preflight (docs/blueprint/ARCH.md D07 and M07): the bot's host is a 2 GB server, which the OS reports as
# about 1.9 GiB (not measured), with a 55 GB disk. Both are read from the host itself (/proc/meminfo,
# and df on the filesystem that holds /var/lib); no option or variable changes them. The RAM floor is 1.5 GiB: it
# refuses the 1 GB server (about 0.96 GiB) by a wide margin, no Vultr plan sits between 1 GB and 2 GB, and the
# 2 GB server's exact MemTotal is not measured (a crash-dump reservation could lower it). The filesystem floor is
# 40 GB by size (docs/DECISIONS.md): it refuses the 25 GB server (about 23 GB) widely, while the 55 GB disk's
# filesystem, smaller than the disk and not measured, keeps a margin. Size, so a host holding data passes a re-run. A full install refuses a host below either, before it changes
# anything; an update only warns, so zeroed-update never rolls a running server back over it.
D07_MEM_MIN_KB=1572864   # 1.5 GiB in kB
D07_DISK_MIN_KB=39062500 # 40 GB (40 × 10^9 bytes) in kB
d07_shortfalls() { # MemTotal kB, size kB of the filesystem holding /var/lib: one line per shortfall
  if ! [[ "$1" =~ ^[0-9]{1,12}$ ]]; then echo "its RAM could not be read from /proc/meminfo"
  elif [ "$1" -lt "$D07_MEM_MIN_KB" ]; then
    awk -v k="$1" 'BEGIN { printf "it has %.2f GiB of RAM; the bot needs a 2 GB server (at least 1.5 GiB reported)\n", k / 1048576 }'
  fi
  if ! [[ "$2" =~ ^[0-9]{1,15}$ ]]; then echo "the size of the disk that holds /var/lib could not be read"
  elif [ "$2" -lt "$D07_DISK_MIN_KB" ]; then
    awk -v k="$2" 'BEGIN { printf "the disk that holds /var/lib is %.1f GB; the bot needs at least 40 GB\n", k * 1024 / 1e9 }'
  fi
}
d07_short="$(d07_shortfalls "$(awk '$1 == "MemTotal:" { print $2; exit }' /proc/meminfo 2>/dev/null || true)" \
  "$(df -P -k /var/lib 2>/dev/null | awk 'NR == 2 { print $2 }' || true)")"
if [ -n "$d07_short" ]; then
  if [ "$UPDATE" = 1 ]; then
    while IFS= read -r line; do printf 'Warning: this server is below the bot'\''s host minimum (D07): %s.\n' "$line" >&2; done <<< "$d07_short"
  else
    die "this server is below the bot's host minimum (docs/blueprint/ARCH.md D07): ${d07_short//$'\n'/; }. Use the 2 GB Vultr server (vc2-1c-2gb, 55 GB SSD)."
  fi
fi

# An update is all or nothing. Before it changes a host path it keeps the old file (*.zeroed-old) or notes
# that the path is new, and before it stops a unit it notes whether that unit was enabled and running, all in
# a journal on disk. If any later step fails (Node, the firewall, the signing key, a package, a unit), the
# EXIT trap puts every file back, removes the new ones, reloads systemd, restores each unit's state and
# re-applies the old firewall, so the release that keeps running also keeps its own host files. An update
# killed half-way leaves the journal behind, and the next update rolls it back first. On success the old
# copies and the journal are deleted. Known limit: packages apt added for a missing package stay.
JOURNAL=/var/lib/zeroed-host/update-journal
MANAGED_ROOT="" # only the tests point this elsewhere
# managed PATH: true for the paths this installer manages. Roll-back touches nothing else, whatever the
# journal says.
managed() {
  local p="${1#"$MANAGED_ROOT"}"
  [ "$p" != "$1" ] || [ -z "$MANAGED_ROOT" ] || return 1
  case "$p" in */../* | */./* | *//* | */.. | */.) return 1 ;; esac
  # Key material is never the installer's to roll back (an update never writes it): the host's age key, the
  # GitHub merge-key keyring, the one-time codes and where backups are encrypted to.
  case "$p" in
    /etc/zeroed/age | /etc/zeroed/age/* | /etc/zeroed/gnupg | /etc/zeroed/gnupg/*) return 1 ;;
    /etc/zeroed/deploy-code* | /etc/zeroed/pair-code* | /etc/zeroed/backup-recipients* | /var/lib/zeroed-host/owner_backup_recipient*) return 1 ;;
  esac
  case "$p" in
    /usr/local/sbin/zeroed-* | /usr/local/lib/zeroed/* | /usr/local/share/zeroed/* | /usr/local/bin/node) return 0 ;;
    /etc/systemd/system/zeroed-* | /etc/zeroed/* | /etc/nftables.conf | /etc/apt/apt.conf.d/* | /etc/ssh/sshd_config.d/*) return 0 ;;
    /etc/systemd/system/srv-zeroed_pull-*.mount) return 0 ;;
    /etc/systemd/journald.conf.d/zeroed-*) return 0 ;;
    /var/lib/zeroed-host/* | /opt/zeroed/*) return 0 ;;
  esac
  return 1
}
journal() { printf '%s\n' "$*" >> "$JOURNAL"; sync "$JOURNAL" 2>/dev/null || sync; }
keep_old() { # path
  [ "$UPDATE" = 1 ] || return 0
  if grep -qxF -e "backed $1" -e "created $1" "$JOURNAL" 2>/dev/null; then return 0; fi
  if [ -e "$1" ] || [ -L "$1" ]; then
    cp -a "$1" "$1.zeroed-old"
    journal "backed $1"
  else
    journal "created $1"
  fi
}
keep_unit() { # unit: its enabled and running state, before it is stopped
  [ "$UPDATE" = 1 ] || return 0
  journal "unit $1 $(systemctl is-enabled --quiet "$1" 2>/dev/null && echo 1 || echo 0) $(systemctl is-active --quiet "$1" 2>/dev/null && echo 1 || echo 0)"
}
roll_back() {
  local kind p en act b=0 c=0
  set +e
  [ -s "$JOURNAL" ] || return 0
  while read -r kind p _; do
    [ "$kind" = created ] || [ "$kind" = backed ] || [ "$kind" = unit ] || { printf 'Roll-back: skipped an unknown journal line.\n' >&2; continue; }
    [ "$kind" = unit ] || managed "$p" || printf 'Roll-back: skipped %s (not a path this installer manages).\n' "$p" >&2
  done < "$JOURNAL"
  while read -r kind p _; do
    [ "$kind" = created ] && managed "$p" || continue
    case "$p" in /etc/systemd/system/*) systemctl disable --now "$(basename "$p")" >/dev/null 2>&1 ;; esac
    rm -f "$p"
    c=$((c + 1))
  done < "$JOURNAL"
  while read -r kind p _; do
    [ "$kind" = backed ] && managed "$p" || continue
    [ ! -e "$p.zeroed-old" ] && [ ! -L "$p.zeroed-old" ] || mv -f "$p.zeroed-old" "$p"
    b=$((b + 1))
  done < "$JOURNAL"
  systemctl daemon-reload
  systemctl restart systemd-journald >/dev/null 2>&1 || true
  while read -r kind p en act; do
    [ "$kind" = unit ] && [[ "$p" =~ ^zeroed-[A-Za-z0-9@._-]+$ ]] || continue
    [ "$en" != 1 ] || systemctl enable "$p" >/dev/null 2>&1
    [ "$act" != 1 ] || systemctl start "$p" >/dev/null 2>&1
  done < "$JOURNAL"
  nft -f /etc/nftables.conf
  rm -f "$JOURNAL"
  printf 'Update failed; every host file is back as it was (%s restored, %s removed).\n' "$b" "$c" >&2
}
on_exit() {
  local rc=$? kind p
  [ "$UPDATE" = 1 ] || return 0
  if [ "$rc" != 0 ]; then
    roll_back
  elif [ -e "$JOURNAL" ]; then
    while read -r kind p _; do [ "$kind" != backed ] || rm -f "$p.zeroed-old"; done < "$JOURNAL"
    rm -f "$JOURNAL"
  fi
}
if [ "$UPDATE" = 0 ] && [ -e "$JOURNAL" ]; then
  # A full install replaces everything anyway: a journal left by an interrupted update must never roll a
  # later update back over this install. Drop it and the old copies it lists.
  while read -r kind p _; do [ "$kind" = backed ] && managed "$p" && rm -f "$p.zeroed-old"; done < "$JOURNAL" || true
  rm -f "$JOURNAL"
fi
if [ "$UPDATE" = 1 ]; then
  # An update killed half-way (power loss, OOM) left its journal: put that one back before starting.
  if [ -s "$JOURNAL" ]; then
    say "A previous update did not finish; putting its host files back first"
    roll_back 2>&1 | sed 's/^Update failed; /Previous update: /'
    set -e
  fi
  rm -f "$JOURNAL"
  trap on_exit EXIT
fi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
PACKAGES=(age ca-certificates curl e2fsprogs git gnupg jq nftables sqlite3 unattended-upgrades xz-utils)
# An update only touches apt when a package is missing (and waits for unattended-upgrades' lock).
if [ "$UPDATE" = 0 ] || ! dpkg -s "${PACKAGES[@]}" >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null
  apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends "${PACKAGES[@]}" >/dev/null
fi

say "Node $NODE_VERSION"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/node.tar.xz" "$NODE_URL"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c --quiet - || die "Node download failed its SHA-256 check"
  rm -rf "/opt/node-$NODE_VERSION"
  mkdir -p "/opt/node-$NODE_VERSION"
  tar -xJf "$tmp/node.tar.xz" -C "/opt/node-$NODE_VERSION" --strip-components=1 --no-same-owner
  keep_old /usr/local/bin/node # the symlink itself; both /opt/node-* folders stay
  ln -sfn "/opt/node-$NODE_VERSION/bin/node" /usr/local/bin/node
  rm -rf "$tmp"
fi

say "Users"
getent group zeroed-signer >/dev/null || groupadd --system zeroed-signer
getent passwd zeroed-signer >/dev/null || useradd --system --gid zeroed-signer --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin zeroed-signer
getent group zeroed-worker >/dev/null || groupadd --system zeroed-worker
# The worker may reach the signer's socket through the zeroed-signer group; nothing else is in that group.
getent passwd zeroed-worker >/dev/null || useradd --system --gid zeroed-worker --groups zeroed-signer --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin zeroed-worker
# PATHS-FIX: the worker reads pull receipts through zeroed-pull and import bundles through zeroed-spool (never botops,
# which reaches the signer's ops socket). zeroed-pull is also the market-data pull account: sftp only, chrooted, no shell.
getent group zeroed-pull >/dev/null || groupadd --system zeroed-pull
getent group zeroed-spool >/dev/null || groupadd --system zeroed-spool
# PATHS-FIX ruling 21: the provider usage ledger is written by the engine and the sentinel; the sentinel joins this group.
getent group zeroed-sentinel >/dev/null || groupadd --system zeroed-sentinel
getent passwd zeroed-pull >/dev/null || useradd --system --gid zeroed-pull --no-create-home --home-dir / --shell /usr/sbin/nologin zeroed-pull
usermod -aG zeroed-pull,zeroed-spool zeroed-worker

say "Files"
# The SSH state of the running firewall, read before nftables.conf is replaced (an update keeps it).
SSH_WAS_OPEN=0
[ "$UPDATE" = 0 ] || ! nft list ruleset 2>/dev/null | grep -Eq 'tcp dport 22 .*accept' || SSH_WAS_OPEN=1
CHANGED=()
install_file() { # path mode, content on stdin
  mkdir -p "$(dirname "$1")"
  cat > "$1.zeroed-new"
  cmp -s "$1.zeroed-new" "$1" 2>/dev/null || { CHANGED+=("$1"); keep_old "$1"; }
  chmod "$2" "$1.zeroed-new"
  chown root:root "$1.zeroed-new"
  mv -f "$1.zeroed-new" "$1"
}
install_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'__ZEROED_FILE__'
// Zeroed: security updates every day, unattended. No automatic reboot (a reboot mid-trade is worse than a
// pending kernel update); /status and the journal show when one is needed.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
__ZEROED_FILE__
install_file /etc/apt/apt.conf.d/52zeroed-unattended-upgrades 0644 <<'__ZEROED_FILE__'
// Zeroed: security origin only (Ubuntu's default list), never reboot on its own.
// Plus Tailscale's own repository (live view, opt-in; its key is pinned by zeroed-tailscale): it publishes
// fixes there, not in Ubuntu's security pocket. Matches nothing until Tailscale is installed.
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
        "${distro_id}ESMApps:${distro_codename}-apps-security";
        "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Origins-Pattern {
        "origin=Tailscale,label=Tailscale,codename=${distro_codename}";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
__ZEROED_FILE__
install_file /etc/nftables.conf 0644 <<'__ZEROED_FILE__'
#!/usr/sbin/nft -f
# Zeroed host firewall. No inbound ports on the public interface (SSH only when the installer was given a key).
# Outbound: the worker may use HTTPS and DNS only; the signer has no network at all.
flush ruleset

table inet zeroed {
  chain input {
    type filter hook input priority filter; policy drop;
    iif lo accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto { icmp, ipv6-icmp } limit rate 10/second accept
#SSH_RULE#    tcp dport 22 ct state new limit rate 6/minute accept
    # Live view (opt-in, zeroed-tailscale): HTTPS from the owner's tailnet only. Matches nothing until
    # Tailscale is installed; the public interface stays closed.
    iifname "tailscale0" tcp dport 443 accept
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
  }

  chain output {
    type filter hook output priority filter; policy accept;
    oif lo accept
    meta skuid "zeroed-signer" drop
    meta skuid "zeroed-worker" tcp dport 443 accept
    meta skuid "zeroed-worker" udp dport 53 accept
    meta skuid "zeroed-worker" tcp dport 53 accept
    meta skuid "zeroed-worker" drop
  }
}
__ZEROED_FILE__
install_file /etc/ssh/sshd_config.d/20-zeroed-pull.conf 0644 <<'__ZEROED_FILE__'
# PATHS-FIX (DISK-BUDGET.md §2.9; rulings 9, 12, 14, 16): the market-data pull account. sftp only, chrooted to a
# root-owned folder holding a read-only bind of /var/lib/zeroed-md with a writable receipts/ bind; no shell, no
# forwarding. Its key is read from /etc/zeroed/pull-keys/zeroed-pull (root-owned). None is installed, so the account
# cannot log in until the operator's key is put there. SSH itself stays as the installer left it (off unless
# --ssh-key).
Match User zeroed-pull
    ChrootDirectory /srv/zeroed_pull
    ForceCommand internal-sftp -u 0027
    AuthorizedKeysFile /etc/zeroed/pull-keys/%u
    AllowTcpForwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    PermitTunnel no
    X11Forwarding no
    PermitTTY no
# Ends the Match block. Ubuntu includes this folder at the top of sshd_config, and no later line may become the pull
# account's only. OpenSSH 9.6 (Ubuntu 24.04) already ends it with the file (checked with sshd -T); this keeps it so.
Match all
__ZEROED_FILE__
install_file /etc/systemd/journald.conf.d/zeroed-journal.conf 0644 <<'__ZEROED_FILE__'
# HOST-CAPS: the system journal never takes the room the worker's state, ledger and journal need. At most 500 MB,
# and it leaves at least 2 GB free (systemd's defaults on a 25 GB disk are 2.5 GB and 15%).
[Journal]
SystemMaxUse=500M
SystemKeepFree=2G
__ZEROED_FILE__
install_file /etc/systemd/system/srv-zeroed_pull-md-receipts.mount 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: pull receipts, the one folder the pull account may write (PATHS-FIX)
Documentation=https://github.com/macdarenz-droid/Meme-snipe/blob/ccr-14987baf-i6lrsl/ops/README.md
Requires=srv-zeroed_pull-md.mount zeroed-receipts-fs.service
After=srv-zeroed_pull-md.mount zeroed-receipts-fs.service
Before=ssh.service ssh.socket

[Mount]
What=/var/lib/zeroed-md/receipts
Where=/srv/zeroed_pull/md/receipts
Type=none
Options=bind,rw,nodev,nosuid,noexec

[Install]
WantedBy=multi-user.target
__ZEROED_FILE__
install_file /etc/systemd/system/srv-zeroed_pull-md.mount 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: market data, read-only, inside the pull account's sftp chroot (PATHS-FIX)
Documentation=https://github.com/macdarenz-droid/Meme-snipe/blob/ccr-14987baf-i6lrsl/ops/README.md
# Mounted before SSH can let the pull account in, so it never sees an empty folder.
After=zeroed-receipts-fs.service
Before=ssh.service ssh.socket

[Mount]
What=/var/lib/zeroed-md
Where=/srv/zeroed_pull/md
Type=none
Options=bind,ro,nodev,nosuid,noexec

[Install]
WantedBy=multi-user.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-backup-offsite.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: daily off-server copy of the newest backup (silent Telegram document)
After=network-online.target zeroed-backup.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zeroed-backup-offsite
UMask=0077
PrivateTmp=yes
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/zeroed-host /run
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-backup-offsite.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: daily off-server backup copy

[Timer]
# 17:20 UTC is 03:20 Melbourne (AEST) or 04:20 (AEDT): after the hourly backup, in the quiet hours.
OnCalendar=*-*-* 17:20:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-backup.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: encrypted backup of the SQLite files

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zeroed-backup
UMask=0077
Nice=10
IOSchedulingClass=idle
PrivateTmp=yes
PrivateNetwork=yes
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/backups/zeroed /var/lib/zeroed /var/lib/zeroed-usage
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-backup.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: hourly encrypted backup

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=60s

[Install]
WantedBy=timers.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-check.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: stored-key check, Telegram webhook retry and change check, evidence index
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zeroed-check
UMask=0077
PrivateTmp=yes
NoNewPrivileges=yes
ProtectHome=yes
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-check.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: host checks every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-pair.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: receive keys from the Deploy workflow, then pair the owner's Telegram chat
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zeroed-pair
ExecStart=/usr/local/sbin/zeroed-telegram-pair
UMask=0077
PrivateTmp=yes
NoNewPrivileges=yes
ProtectHome=yes
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-pair.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: check for keys and Telegram pairing every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-receipts-fs.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: the pull receipts' own fixed-size filesystem (PATHS-FIX ruling 20)
Documentation=https://github.com/macdarenz-droid/Meme-snipe/blob/ccr-14987baf-i6lrsl/ops/README.md
After=local-fs.target
# Mounted before the chroot's binds and SSH, so the pull account only ever writes into the small filesystem.
Before=srv-zeroed_pull-md.mount srv-zeroed_pull-md-receipts.mount ssh.service ssh.socket

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/zeroed/receipts-fs start
ExecStop=/usr/local/lib/zeroed/receipts-fs stop

[Install]
WantedBy=multi-user.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-record-upload.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: hourly upload of sealed recordings

[Timer]
# 10 minutes after boot or after the timer is switched on, then an hour after each run ends.
OnBootSec=10min
OnActiveSec=10min
OnUnitInactiveSec=1h
Unit=zeroed-record-upload@all.service

[Install]
WantedBy=timers.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-record-upload@.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: upload sealed recordings to the private data repository (%i)
Documentation=https://github.com/macdarenz-droid/Meme-snipe/blob/ccr-14987baf-i6lrsl/ops/README.md
After=network-online.target
Wants=network-online.target
ConditionPathExists=/var/lib/zeroed/recorder

[Service]
Type=oneshot
# The worker's own user: it already holds every credential read here and owns the recorder, so no capability is needed.
# That user is in the zeroed-signer group (/etc/group), which systemd applies here too, so the signer's folders are made
# inaccessible below.
User=zeroed-worker
Group=zeroed-worker
EnvironmentFile=/etc/zeroed/worker.env
# %i is "all" (the timer) or one UTC day (zeroed-record-upload --day). One run at a time, the hourly one or a manual one.
ExecStart=/usr/bin/flock /var/lib/zeroed-record-upload/run.lock /usr/local/bin/node --max-old-space-size=48 /usr/local/lib/zeroed/record-upload.mjs --scope %i
# A oneshot's default 90 s would stop the first run (days of backlog at 2 MB/s).
TimeoutStartSec=12h
ImportCredential=heartbeat_hmac_key
ImportCredential=helius_api_key
ImportCredential=alchemy_api_key
ImportCredential=jupiter_api_key
ImportCredential=telegram_bot_token
ImportCredential=telegram_chat_id
StateDirectory=zeroed-record-upload
StateDirectoryMode=0700
# Of the worker's state only the recorder (read and delete) and the journal (read) are visible: an empty read-only
# /var/lib/zeroed with those two bound in, so the ledger and the rest of the worker's state are out of reach.
TemporaryFileSystem=/var/lib/zeroed:ro
BindPaths=/var/lib/zeroed/recorder
BindReadOnlyPaths=-/var/lib/zeroed/journal.jsonl
InaccessiblePaths=-/run/zeroed-signer -/var/lib/zeroed-signer
UMask=0077
Nice=19
IOSchedulingClass=idle
CPUQuota=25%
MemoryMax=96M
OOMScoreAdjust=1000
TasksMax=32
LimitCORE=0
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
KeyringMode=private
DevicePolicy=closed
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount @debug @cpu-emulation @obsolete
SystemCallErrorNumber=EPERM
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-signer.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed signer (no network, Unix socket only)
Documentation=https://github.com/macdarenz-droid/Meme-snipe/blob/ccr-14987baf-i6lrsl/ops/README.md

[Service]
Type=simple
User=zeroed-signer
Group=zeroed-signer
# Stub until SIGN-1: answers "not ready" on the socket and holds no key.
ExecStart=/usr/local/bin/node --jitless /opt/zeroed/stub/signer.mjs
Restart=always
RestartSec=2
RuntimeDirectory=zeroed-signer
RuntimeDirectoryMode=0750
StateDirectory=zeroed-signer
StateDirectoryMode=0700
UMask=0007
MemoryMax=200M
TasksMax=32
LimitCORE=0
# Hardening (ARCHITECTURE.md 12.1): no network of any kind, Unix socket only.
PrivateNetwork=yes
IPAddressDeny=any
RestrictAddressFamilies=AF_UNIX
MemoryDenyWriteExecute=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RemoveIPC=yes
LockPersonality=yes
KeyringMode=private
DevicePolicy=closed
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount @debug @cpu-emulation @obsolete
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-update.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: deploy the commit the deploy tag points to, after checking GitHub's signature
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zeroed-update
UMask=0022
PrivateTmp=yes
NoNewPrivileges=yes
ProtectHome=yes
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-update.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: check for a new deploy tag every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-worker.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed worker
Documentation=https://github.com/macdarenz-droid/Meme-snipe/blob/ccr-14987baf-i6lrsl/ops/README.md
After=network-online.target zeroed-signer.service
Wants=network-online.target
# Starts only after the keys arrived and the owner's Telegram chat is paired.
ConditionPathExists=/etc/credstore.encrypted/helius_api_key
ConditionPathExists=/etc/credstore.encrypted/telegram_chat_id
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
User=zeroed-worker
Group=zeroed-worker
SupplementaryGroups=zeroed-signer
# PATHS-FIX: read the pull account's receipts (zeroed-pull) and the operator's import bundles (zeroed-spool). Never
# botops: that group reaches the signer's ops socket (DISK-BUDGET.md ruling 15).
SupplementaryGroups=zeroed-pull zeroed-spool
EnvironmentFile=/etc/zeroed/worker.env
Environment=NODE_ENV=production
# Reconcile first: every start and restart settles open intents against the chain before trading.
ExecStartPre=/usr/local/lib/zeroed/worker-start --reconcile
ExecStart=/usr/local/lib/zeroed/worker-start
Restart=always
RestartSec=5
TimeoutStopSec=30
LoadCredentialEncrypted=helius_api_key:/etc/credstore.encrypted/helius_api_key
LoadCredentialEncrypted=alchemy_api_key:/etc/credstore.encrypted/alchemy_api_key
LoadCredentialEncrypted=jupiter_api_key:/etc/credstore.encrypted/jupiter_api_key
LoadCredentialEncrypted=telegram_bot_token:/etc/credstore.encrypted/telegram_bot_token
LoadCredentialEncrypted=telegram_chat_id:/etc/credstore.encrypted/telegram_chat_id
# Optional: present once Deploy delivered the watchdog (ImportCredential does not fail when it is missing).
ImportCredential=heartbeat_hmac_key
StateDirectory=zeroed
StateDirectoryMode=0700
# PATHS-FIX: one StateDirectoryMode per unit, so the market-data folder (2750, group zeroed-pull) and the import spool
# (2730, group zeroed-spool) are made by the installer with their own group and mode, and listed here; so is the
# provider usage ledger's folder (2770, group zeroed-sentinel), which the sentinel writes too (ruling 21).
ReadWritePaths=/var/lib/zeroed-md /var/lib/zeroed-spool /var/lib/zeroed-usage
UMask=0077
MemoryMax=800M
# The worker owns exits: under memory pressure the kernel takes anything else first (worker-smoke's trial is +1000).
OOMScoreAdjust=-500
TasksMax=256
LimitCORE=0
# Hardening (ARCHITECTURE.md 12.1). MemoryDenyWriteExecute is off here only: V8's JIT needs it.
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RemoveIPC=yes
LockPersonality=yes
KeyringMode=private
DevicePolicy=closed
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount @debug @cpu-emulation @obsolete
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
__ZEROED_FILE__
install_file /etc/zeroed/github-web-flow.asc 0644 <<'__ZEROED_FILE__'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGWmxXYBEACyN+4viFQM6QQoKr0A2W0rGdMobTJwOZso2QPpewbyBsuL3rNW
5OmHrWwXAhPKNqUIyOzdq8MoSxoTTuqLksoahixEL/X2nyhOBxR9GkYz/oI9R3nY
cLRaFQoSJoVfOt61opkLUzbWAehpbgT8EKln8JsENq0+0nDlWQi0h2Q9oGmqlgVz
skwmVZ8Leyv4Mg7hN6swyZ7moZfkkpD5+U7Z2XVurCzkSSfg4zb2lMRLJos2eCAc
749ECsX0t7OBftF+YqgjIXixXsm2RrUqvU47OkOtZeAhvAYenbC3pr9Fha5NxoBU
Ea+11MK9W6OcRhwvxVCUrMUR6FTSZyC//VpXTTtrRlOqpU5wGMbP3zpn9geqOXCl
8rF7+1gAPG/o+QFQTBsVEruwi4JWogiQuQyOwAIlFe/7dvaxWZGpv/yW2+L3guL7
xaHKFVGsayhlitQQ5Xa+P1iSgKSXDyReCbWotfqAempPySI25LHh3ScXI6NgdHSr
SBaFojwAfgxbPTEQ6adIsKHCQofrnLrNa3UOeGDGiOOK0aYV3jiEDGAouatkNf2q
85Eosj1f9laCqAH3YLJD7dcSne1iChK5qRTByMvIyeSD0NbNnVMFOGpXySyWtKb2
ldpu8AWBQJsJs9FmYBcWAGBA2pp+IxaCn6rBIHIsUVFRN8OVZKsEsBkWywARAQAB
tBtHaXRIdWIgPG5vcmVwbHlAZ2l0aHViLmNvbT6JAk4EEwEKADgWIQSWhHmhr/kn
430aVmu1aQ7uu5UhlAUCZabFdgIbAwULCQgHAgYVCgkICwIEFgIDAQIeAQIXgAAK
CRC1aQ7uu5UhlIMuEAClvVwC+Neoiq0AdixJZsagKHpx1QrMJWrtMRi4eXVTTaeX
+P1unhC/AmSO4Xxd3uRoejHvfWh4F0gitUJ8XKgiejnmuGcq7Dbt5OoO1JuXGlW2
BQ+MiGoYVw2B0sOhWDNrIBWOO/WL4LykcGnAtrRXwoS0Wx4MCydztXQY5lcnCWaW
8rvu7WmduoOikH4HI97rqN5896dc4iBKSx8LZf+46DRCCD/5SfACplBz4hs5zen8
TL8zd+zxjFrXbzota0jSDEGK9WGO4z55S2xScC6zv6v3Bj1OR8Bs5aodGtmamHZ7
sE9w0RJoCfNx+9cR/rE82SrOaBpVU7urLe4lg7zaaNhqDdNV8ymuXGmIJarDgrme
iB5bHS+dLFzLUkTgot4RFlPa9bFiJuJN6Tc9tMu5RJQ9l/zKmxDHIKWsAle5R65u
zEq04LugTQBdEorGxfQCsF2ga9ncKTDMiAThWTvZpOP3NJ/athZRmOBpG4B9iR6r
pRU8F/+MokG4fIMwnvtOhWQFiEzdTkJ7U5JAkPtTAmT3/mznwtPEU7DrFWSGAdqg
IMOlxNCBeGvjwLR0qGH7cB9qHDGNoDLkjaUFpu5tPv4/ivkQaHlHJxjT0ILM6jet
CAzKpKh48rm65tmrJX6KVpj0r2kKMscFf7s7XaPlCNCFds/YA+0puPbzJKWKfIh1
BBIWCgAdFiEEoEI+wF2ruxs8z3uU00lNAblm+BwFAmW96NkACgkQ00lNAblm+Bzz
HwD/QEVq8zm+zC4AiMR/W58PrVdtRV4r9KiSmObSsBYYpXQA/RDPyWpvUpfr8Yy4
Q4AKwOyMLnn6aO8AHiIF//KuNjYKiQIzBBIBCgAdFiEEZ7TldZn8chcMjPruxwkL
Gl9XzcUFAmXBqt4ACgkQxwkLGl9XzcVS/Q/9G17iSI7Z4F8o2orb1n/NOMluj1HF
qYHho0wBM+SohDLIWl3qC+XiIxUKV9P9vSsBIEcywWab9CqvJkqhshNU9PkYUNhl
wuBOxz13atc+clRDlOS0N6uSd8fYCXAp2rZnc5TH4W9SHGKMtBPQVgUeHTnsAtoH
26dOhVXH6alcgJAI0YSHyaWiEJZYV15KjQY8aEiMHSne1moRWWP3TKV+1iUQV1Wp
GjhVb0Ng/bKGgQPbDbEe8o5x+EZ/VaGfZmUL6iQeVzZFE8OkQhDf2mQIc5uEo6Cy
x7sWVzCQiVDu6UgzQluOpCZcwQYIc5h+y/AHyO2RUnKtnZgRmqCeN2n424FrvTuJ
IzYhU+KzfWJwvfFPbSSQkJsIGS9UmsWzaBmZpxzjzdCyLsEj2XPO8dMDtO1MF0d8
llp6imJKoKTgKGp/hX59AUNWWTxJR3zoyhPg/k0PMIa7QviIiVY5m4rEhmwW+4Hy
qA91PRKtWdHw3rFmJzPikDGgvXej8tvZqnf6V4jovSBNtX0eigKY8Tt+Sc+oZID6
iTnNxjsX3CLkIRr4clL+T49SFLIVbE0nb50OsEBtN8MGcfMkvC2Opd43bzhYoxeq
muRE66nCnYk5G8gwxbVrTvqWr8qf1v70WEE/vZ4maGzd2+HFlp7ymP200eatFTvA
H42te4UcRKv32lCIewQQFgoAIxYhBHbm1jtgAB37oIB5YQN6KGaRFosPBQJmOKfE
BYMB4TOAAAoJEAN6KGaRFosPhksA/RfzH6HNVtnPNRNSagUi3zipNcgqypgjbIVF
3AD6misfAP92LhaRp1swJNRqAERtn7yN09cF/UOP1IbsCHyIJKJ+BYkCMwQQAQgA
HRYhBMoLlzNPlEnrWv/LkyQL1U0ZTjFhBQJmQQ2xAAoJECQL1U0ZTjFh5yQP/jM3
7VeGGG1ybvCOo4of3GzxUsEbDUxaqXpJji/Ed55WK5MlQz6Rk5J7g6cgc51Md53t
GrBxcR1DfXaidsynAgrqsjivrKhc6V/MOZRCk4Scl4n+JZIqYFcPqu3jHNmZaeKS
oMrWfxEU+sV2GQzc+iiO9DJ5GrCaT5l1khhxxHAwY8/Ix0YAyRLAMA1LPft7hL19
ur6oTT+kJuDaRQfyzpNuNZmaxPURgsjQeOKL9R0Aoli0uQV7O5GzbopP6/6oMlnM
3Xs6S5lGBnvw6XIlh4uypfYTV601BwyPpl4Zsx9jwZnsfQ/DMNisOxVo/r4PUiRX
q7QB1TnH4gLRuMCjKFnGnLpYaxmJAnhLNKRMUDOVU1qcHknSkrAkQbwkGzDJ34zQ
Bg0aC60YOPq0Z0ArCO+YjBX5q/1mf4lmocAD5ilK0Eda5g+bmV7A6MzQWoid3XWR
PtclpMDm/7z66F2jpsnCfda5XJ8CFCjghJW6MXbKtBvRwXDbNEyi85vYp1b2zjwG
ouzk5fxEsSkFj59/H2WRHeSdI7rNKzgB7n5NpX0bf5IoxPjKAufgtKvTJ7Y0/i8r
TE1Q6eYh0+7hQVhc3g990GFjzJy36aDX4JszQ8+nmbGstAXFPz8zbLDexVH2Iq3w
3gt3sHOuaQ/35eHIhpaVckiq3ttYM7eJ8DCrlBaiiHUEEBYIAB0WIQQbvcI9GFMl
XWQV0uyBTt+FGqs3DgUCZlOh9AAKCRCBTt+FGqs3DjmpAP9nC9yhP3JkW5P4cXlT
Qs4seZyBGQwWWK3uFwN5LUcwcwD/bDxxLLMl/IH51fELhltG6P8duPN0iSlwEIQA
25VUGgWIngQQFgoARhYhBHPK8ul/nZuxrBUfw8cfsX+5XBCcBQJmdxstKBSAAAAA
AA0AEnJlbUBnbnVwZy5vcmfliLDmraTkuIDmuLjvvIjvvIkACgkQxx+xf7lcEJy4
dQEA6UM1N4h+hSlWbxstcOfPvyiWP2S2pio+R8Wwcr9UQ+YBAMCM1yRgXMo5XttO
yYVMvGP7649g/8VpRKFeCBJz/KcNiQIzBBABCgAdFiEEZtEwSCtfIGmBpmuDb5h8
zyJNILkFAmaFqgoACgkQb5h8zyJNILnSRQ//adui9kuSWDrs/9/LD8NAG6p9YB3F
ypIOtOz5cMf79L6G4RZL4EpLSH3wsE02fIeR+ZCjFpbRGBd3fZp2OnR7pIquPn56
MSp7RbGEHn+7f/s6/aieeIne5j3iSEpn2NITAQTBM6yYY7lU28vF85/1z6SCXGtX
TXNvFpe95XQPMx54k9B9u2VwkuuVp0YSeQiDVlAbbPEqVQ79NBsnRE4Hu8MMKDMq
JaL2OimNArK0HPDTVPBwQvnjPMd1FnV+aIVV6OdPD+06EJN4D9feAirc+neHQx8o
VvcYywiUx/4V0FSkRgaVjyPQKJ9mXI8FeXYRH99buMWRAyz+5jfIPsKUG9DvjhFZ
KUHETIgG0ZdzEqptkErmKvvmvallW0D0YRT0+UoPanit1JIbxdYU5pdkvIEaP/6Y
43hiAZDOMRg0KsYQaXVfS/ywbFzrDyV252JJYIx4wmfKTiFooTTKQp94HLWp8UFU
/4S4eUrIet4fPGDtK2VJMDWeHxg0sZ7gOp2M5qOBLBAjaDvyjNRzGgmRh6YfMPyY
f1oav79CaUrRg7zXFkQe7kixxqZ1lxRQIc7nlS8Sg51PORO4tRJxLPJm7cYsSUNF
1mUBEpITrduTy041746mXywJ1yWZPhhY+XhOs3KFjLGHxo8K9/IzijFGqekSFaAb
vyqsskA2ZkYfMOSIdQQQFgoAHRYhBJHhSFM6jKKNT7UFQxPWNlsEJ4RZBQJmvW40
AAoJEBPWNlsEJ4RZ674BAP4N9sbqchv46GhSpgYEfbJm30mA8Gi0YOcWsZBurWWX
AP9oHU2lhFXK+c5cSmaNEdEacEcgoBqggEJYu08YeyvLDYh1BBAWCgAdFiEEkeFI
UzqMoo1PtQVDE9Y2WwQnhFkFAmcF36UACgkQE9Y2WwQnhFnYUQD/X5giMxsJ/yPk
EgfsObdn0S4ymLb3nujkzS+edqRo8aYBAN7Mod1UINlN4zS/mAxSReEanuCXOWPJ
/MlrVvbQ1u0IiQI5BBABCAAjFiEEju40q4vAly12QM4P+OkEthLvh7cFAmcSY5oF
gwBi4IAACgkQ+OkEthLvh7echw/6A5BBsWrfDsMdUZQu/Vmg7Scxqe24g54oL3hq
xT4pGX0cgqutOEo17xCLrpT+5uCFsLgfeTAloI3kQPJJiZXjpiFWjhN+w+HSOgQd
CGzkWzrLq+oxVnlv+QEchl6rsZJcTCJ9c5jrLunrMiMjiepqL+Li4rFlsZhEwW8o
fkhZOjvpKlBB4d3zgbo5DCI9vaxW+uWuNpeEaaUEpcRDRjLGXjbesaGI/KcZ81Mb
b3em8qVWzhEA/llCvTcrnLSiE4+SX7Z8iqXoakKsitp3sJr+aoyxKGWoUt/25rcu
yu9jyUsoeZ5sFnRj4PKFeHmKoGiYS+tuMMvNLiBpcdLlJ9s5EbiJELkW9KuiIin7
vnVnPHbOsn6xQlHZ3izqrh+DudfLjvMGuzHgflf4X9j9ptmCGHRFDDvJX10kDVRh
fhKU8KLgEeEbRo7QtDaOZiCQesBp81HiZjZA94TGFhIa5go5Cd1xL4q9Yca81omL
NpvMHj9h97zB+NWvq41pfnEWxEdlBC1zvIMTMnozpLwnw4mXi1j58zrpQA9H4EP6
k39Ww2gRjkjE/m3rXmI8IdM8awh+69lYd8OzRVK+ufar2qBJwQAJlVyXV6CelPkU
ZOFWTaVd0B3IMyGIuIfJjmOse/sAXpf8D9dTd2uAZ492WaralBOnVwMUV4lW1NQJ
LZn016mJATMEEAEIAB0WIQQdbxe34f+NixeFzQnd994vUmTbXwUCZ4gIpgAKCRDd
994vUmTbX+8WB/9RsKSaHtrpRu8et3r/NUMuw7y3w7ANU8ZkzhrxG0YXkUpSwo/E
UU4SsqSNGP47Fvk8POYrplqhfFJsaUSKJmI8Pa6t2dzXZR+f6xLqRckNgqHpAkh+
JnjvKlsyi1ypVLPKwiaxr4lpB16Zk9/b3H6tMk2n0tsHpIuX87Uh9rLXxXOqycHl
Gu7zs9fw5wk4xUqOEgbJHgB8SddrAQqgyUaFKvUlvvNwQe5oq/2VlG5Yc9eSEMhb
f7e1ctRAMxi0VAVrflFU/vJ3EtZXFBYHJoyYsxLtutUfOfq5v2Yq8F2YIDD4WBhb
agGH5rALkKiZZavIE3HfbPyjAzhcxhvw17MXiQEzBBABCAAdFiEEHW8Xt+H/jYsX
hc0J3ffeL1Jk218FAmeICLgACgkQ3ffeL1Jk218O3gf8CmwI+KtRVVktw7Pp6n6j
72JK7tDtUn1T6AvzeNj17rJUf/uy8K9j920DlkMgKVXI0n38DWmE65Gsmkmjhch1
93kVC54LQgknCrO2pgKmpRCvOU72wPsum6IKKZH+oYX+HjX0wXjkbBT+KMR+6mCL
zc2lLlG4jXwEVt+iIXEc97AxB4B9Ld0jxyK9GokRgnhxjS3N8O6Ic2D1w2kGZZge
nL2TNJZb8rQ/kpayc6jTBn+/vJyRFfo0yC1e1unCbwAh6nCfeb42gpz6+M5yc/Yc
uPAFBgYOGl6g61P2Gt2LuXfcmiM5pKeio8cGMJdpcVwBZdGqrSVMF3L3FmL+t+3L
Toi1BBATCgAdFiEEd33GRMPNVnFlz36pccq6tQy1i40FAmeYRBkACgkQccq6tQy1
i40b/wH/Wsajp3q9wJ9NxOFiUOaysQz2veqQS5YD8jfoAh6fjTnpIYXP4yJxLKz+
lljZ2AiAw8gShrOCrddDzqu+rl3R7wH+N1gM8njUUXkC6RjO4Qun6EpgjHiz6Q/P
+Or1SxijPMmMvjSqO35WbOxnoIZV5dvrO3xpPkNuOyJSjZ/EWzxj74kBMwQQAQgA
HRYhBG0UpeAzrh0u3hLezHCVkRCKSe+SBQJnoYLJAAoJEHCVkRCKSe+SnAcH/RvW
N6jRs2ZBMYWrm8znwKRCl5dSieMrahOtgeDAr//horEdhw9bARs1r1FbInzAbU6y
KsrssqWxyV7XYwZ7PXpTR99RvPFZ/ZSJGYr8xGxqPCUxiq/Vt5i6H1sbBLyMA9PM
VToNpTVZEHLRRUd2dlF+C3GZ2tDV4+QXFlCmyPSLERZM1JeJz95v6KQSTkDl0J3/
SuDg5S8W+4MG0Zfs19k9GkJLQ8QUbGYLJ6B5whjd4NzVP0y6+Nlq3GoaTgx6fx2N
wLtUrUSN+D7sYk6qYZRUu9ByLAMMxyYjAFsiq9Zy8vfAQoT6cCYNWekZwJlzutvX
fwK+cATSQbY4Zc+QrWSIkwQQFgoAOxYhBNgSqwxyUmdyTZettq9s2QhABnJfBQJn
yY4YAwUBeBmGPFtePl0rW0AuXWdpdGh1YlwuY29tPiQAAAoJEK9s2QhABnJfCFwB
AMZlRL1+JA3LUWdwIgCvUkGVnV11fb++JLrMmcwskHDGAP9bERiFBINdfwrRKnfL
YrhRDwVAkAcqfeo8dOr9oNWJDIiTBBAWCgA7FiEEk5UUp8o9DMKmCYKWNijRvOy8
YzcFAmfJmKcDBQF4GYY8W14+XStbQC5dZ2l0aHViXC5jb20+JAAACgkQNijRvOy8
YzcosgEAxDIrXODRm0ftDZv/et2gkMGu56nsoljY781kaY/OArgBAMb/tpW2apQL
+a2eoo0uD0qcls6Fs/PiuIfwn+nvbJYBiHUEEBYKAB0WIQSq8YdI67tofSjbLaj4
quUmq+/J/wUCZ+4yUQAKCRD4quUmq+/J/yUEAQDGtK5WqJKVmgcLdOKv2osHB7aw
JhIQMr691R5uKUiUgwEAm8c4BZzo/CIymDslzsThkTiEZYHgJluhICCFi9apFQmJ
AjMEEAEIAB0WIQR99EpAq/xhP9T0nMIT5JjOAQrG/QUCZ+7JxQAKCRAT5JjOAQrG
/VI5D/45UDcQidN5clCaF2POhfkgqGmzUYtyh3kWFQCo4trV1JPomfjrhLGGQ8p8
A3SgBPT0lUkFCdDUAUX5zmDZ8VhjqsSSAL2xKLTWK7BCI3wOVkXhMceh3k3byWin
uCDZTurt1wXhPe5x606MfXFe2E87Yei9ZxOR/FfMvMaBjNLBcGxISCTaW8qmFGfd
HbHLJihP+l1jyywYq5UbX0AmVEDVnmnjNzwgoGEmoTO3WbdclDYOW0ik48T3h2OM
OKdps/cAN/uraI5MkPcoYlRghiTTPc+Bc6i3aXNfelAt/IqK9YcnlwovkfzJwxJk
lP1BHYdxt7uQXfwEmQCkPPZDJ+/u+CmCKXtlx/xIjUJQRiP7QjM10dCgfU1asuO4
6az0n8Ehsiep9IvrEE7DsoX9AXUQ/gZ/DNv+H5KbyjJsV7ciqcaHpWvPU+tmvQL7
Y5avXlbQ+fQUuoltguGacUdiHy/k+vX9RroyIafM+BTSTfu6tNW9XA3VpKRsSBHI
m9IMS+oKIh6EmxOG7+wk4UqxHGuRJYXCP3m5SNWjWHn8GJpw8ISvBeESWgkJFGIj
kOCy0qlq02utTga9woqnJV2hNBhvJfdc+utoc0PrRs1HeBHQvjFQInp3RFKZmkJn
K8EhGaT9b8GLExaHr1ykF+oWsr6S4Q1C+nEFk1LYM6TjJ3SQe4h1BBAWCgAdFiEE
s2xJE1+ws4qj3y0DFCrt97kun/kFAmiNRbUACgkQFCrt97kun/mNSQEAxtILpQs5
P5MzZDl1vbdCLnVIcNxNyxg0L8XnWky5QoIBAIPOIdpAvpvJ6ckIm9DKdvNPbHkS
/tTtFgxpvqhlimQMiQIzBBABCgAdFiEEM5ySE38tXW4ram6YJAu0xCe8MnoFAmid
yCAACgkQJAu0xCe8MnpubQ/+Mec/n6Z778kjIJqiWRhnF6hbblFv48BrkA4ZurHp
GnTEeM6GgE2Oklks6VF71Xbdk8mopEHzIa/shV9B9WU2aH7TVW+q1a8rs+ePHA/z
aaNoRgrKJ3xB6rf32fM8/xCSqu7JqhmxV9piia905UElyDhsVzczXsw/ipxosCHe
p8jV0jqcl0Gu2T8zAHE9E9C6VFtz3N9beixDajZ89vCy4bf6YBlZw/FbfDA9qLVR
4sVZhhDdvHw8OLc3if63ycvzkkU8vMF8XW4N1Y4cXc9cV4fRP6qoEe7yDwyZFuXQ
flukdOK2pzhKgm5Uhx37TsdmhQ5aJHMEPINa5BvIn1iyUXxnz51h5Esq2QgDOMDS
mRFO0slAl5sDXUTBiz43MIyVfhEvZp0ujTDprLDhKppzMzPY9cuBFD+cyVJgL7TT
aexl+DkCcSoijKYHaMzwm4VsSFiXHnWcqpGq+dzO1BWf9HN9bMiW9de6cfH+vn8c
iyV4BYPxEe3l5erwI4X0sA3AvNenKawneVcIbtfxhrGDCYJot4hcr58EwUocF0xl
PK1IB17uvwVktSjHWOANA7ln5k26HkmoqU8aXT7RBb/Xrc7evlrujOTazRcSgePU
OPQ3gofa1N9gKQiKv+1FZp9ikxvAsfq/q6CUXlUKmrhN5J4uf+h9/HLZNRwahllF
1lyJAjMEEAEKAB0WIQQznJITfy1dbitqbpgkC7TEJ7wyegUCaJ3IKQAKCRAkC7TE
J7wyehOED/9zqY+asn3PZXgWivsYBxwM4syoGS6g7dnVWRSE0WW7I2qDkuoTgBCQ
kjVBbVQcv52I0I3jNCntY0ixVFIFg43UMCazPkF+0kaZNvuPpwffVFa7MZWm2hcO
Ywc4ezYtTf///ARsIBXoxvbbjfHfICLGuqFjbZOxhHH6j801ea23fmcvYrzvW3Wr
1Cu09SfqCwNU/ESjxaRU//5LM82/oDzrAO4oQNCsCn4uKot5sHmVi+263QJzwvad
Q+IwMRV8G64eleapT6BMMWgmtimgQR7oQJulsVWMLajjpGTA12BAunU4uy9mjyqm
weo1KeMb5Gn4L3ok7k4lps/16jeQvtqpZaLQ2Gi2H6+7kyxDacj7AFGCobxk3N3J
QUhrv6hqcVmOkiAlKYmC5JpJ0Ub5A0VUWSU/zus2jcbmbqfrOPJA4Wx2h/BhUIDL
CZRF0hZ+vV3qsr14ZQ18XrpTtgKKts/jwZ2Lo4gbX73EDn6obQ3kYyi1rc7ft2uK
7O/QObbFT5/ROJopZvCSNtj5l4tL0Ri0c3VgMlw2ErisfvilfaBplXgTNgbHVUfk
H5OjOF5AmLHvOeWUNoGXteOWdN4DiJQTeboZPcAmIs87+cT+hjYf+s/Oh4oTmFn2
olgRVsKbTbbB4lusRdJDB0+Xb6UuERz5KfoUe/uBgHDaI2n6ng/bT4kCMwQQAQoA
HRYhBDOckhN/LV1uK2pumCQLtMQnvDJ6BQJoncg5AAoJECQLtMQnvDJ6d1wP/2pA
gMm9smTGIpIBHVEXyn+jbnEJ0QFriD9EkIMKGthhPkY23E6esoMkAb2CcXivgK7P
Hn1PvNeM0kvfLPuHklFNPs3aZG5LZRoIVqBbYiMY2NjwB4RUTSkGZIWslQjOSG/J
H39oeKbaWBZ41JHOahzgxGuPi5tZkulHsYi6WLuEoPmRuAKNcETrQMCNV0eiW4y+
o7bXP0pilECU1VrUnuF6Pe16gD5gH/Ed2P8WJIBZoOy40h970OaqCTvB9iKrFwqp
Gh+AqUxoi4iL4ZreAbimJvja2b7NlUc6SQtEIMXWXyQ+2SAvukjfVeelRfdVJLZd
OIfzm+1gHdDv3wRvqnJ9mEHrT50uM38KE0znds4LAHu9IGsJaL4YmtPbXMRZMIe2
41UorhuadYFnq+5kH6fYPVqCAck5ojxYV/rckJRBbxmSbRXeApD4mNoC+hVbRjI4
GTm5N8bTadfZunukIvpSsUN+vNlXZxYvibv+/caIf12sBFeAhq8+SeSoQbHzvlLo
AMnLo/ahscAR+OqtN03ZBeECDC8G3mgwMIaVUJ4aL/Sj2WdwSnbSL94rRv3B5m0k
CL4QNFVwRZibq0EW7+EHzp2kGzO8zg71zdk8xr9kLmlePxL2c5weiZ2NO8Vj1wn3
QsOBoV2kYlHy/o9GtGfZhwnFsWIhZwmOxXlUJyFdiHUEEBYKAB0WIQTwO4cjeNm4
3J2p6/IVpQGo70EfYgUCaLTVwgAKCRAVpQGo70EfYnBwAQCOvEo38pYZ+R2xFrlo
RoSwKn0nqESNnyXVYsZ+R2JylwD8CCErYCVaLMHuRoqQU5VpWeduZnslcGJTwgmV
nQrmagSIkwQQFgoAOxYhBNgSqwxyUmdyTZettq9s2QhABnJfBQJpHmA9AwUBeBmG
PFtePl0rW0AuXWdpdGh1YlwuY29tPiQAAAoJEK9s2QhABnJfaFwA/1wWk3b/UIhj
442YEdtAKzQKSBMB6p/umOLz3e60uvxcAQC4Kv9Wm6SypQQwRVwoUQqBnEHmSdW3
fPYgv+WTymD9AYh1BBAWCgAdFiEEuAGsVDy1srv5QH2y7d8fX++VQWgFAmkeZtgA
CgkQ7d8fX++VQWhdGwD/exbthYNlz8Ml8rA51xowM4goOdz8tTr36l1BqXZI4IcB
AIKL8RR1y7GJisYKUxGPVCKRus1YYQFwYs/48qlfg40GiHUEEBYKAB0WIQR7EO9d
aaWnC3Plk0jEtuR2HsQctAUCaUwjmQAKCRDEtuR2HsQctOX+AQCa0wzgLSrm0rX3
WNG6tX64CUYv1d/8RZo1R0up9SPFQQEAh5++nci6h+pBgemhwKgqmKOr1feJhdbg
SQRu7jo0QQuIeAQwFgoAIBYhBHsQ711ppacLc+WTSMS25HYexBy0BQJpTCUHAh0A
AAoJEMS25HYexBy0pjsA/RUUNgNov6t7OZYe0IlebBCxSQi3W7Vhev3mulO+3cKA
AQCvbtAcVgcHMNnpSzvVt0AA2H99Ga4TptBYVvx+aJKlB4h1BBAWCgAdFiEEHB8m
twym/z0i8f1Itn8Ap3fBaWgFAmlZG0QACgkQtn8Ap3fBaWjoxQD9FriqGQRwRd4+
YUttmZokPSyQCo1KcqqbTbrK06mwbuUA/3VgD03jK63Wu32inJMpCkaB3XfWd5jt
5Tl5YkQQcJAKiHUEEBYKAB0WIQTUsOCTvlRmKeksZrYs188IMp19UAUCaVmUzgAK
CRAs188IMp19UC/pAQD/8PWHT221F/GMYBp+k66Ky+PXG46+ZzFLwD27OdJlKAEA
owwz01M9kDm79H7JrCMJk5Tf0Tt7RTGAWfAAaC/nFQKIdQQQFgoAHRYhBHsQ711p
pacLc+WTSMS25HYexBy0BQJpc1UKAAoJEMS25HYexBy0v+gBAMBYR1xRZ03crdZo
TDKc9k9DvUqMZlSjTQTUmMaYrEjMAQDZ/uwXLvWJ0t+EyLvU92s4AKcRU7A54IZi
NIOUWKPjBIh4BDAWCgAgFiEEexDvXWmlpwtz5ZNIxLbkdh7EHLQFAmlzVZoCHQAA
CgkQxLbkdh7EHLSMKwD/QEmEyZ9sofWanJQFFpbVGeiS2pHUUwH8FflfY5xnIKMB
AL9MzEvu1aCV+J5LWkzCg370hj2DSjDcf36dyT+wlWgDiHUEEBYKAB0WIQQxBfhD
flc6+63tvuOz+vkMt8BT4wUCaYnUngAKCRCz+vkMt8BT494uAP9uYlctKJduD1KP
BJAZTWOChyDrkyI4dVhnqRHrpoTv9QD/dF4JKQX2SzJH7QkWWaUcdIEKjFIUC+pr
sU7Gb9nbqwGJAjMEEAEIAB0WIQQr38T2JmT3XQr2vi32FweSdt+/vQUCaracXAAK
CRD2FweSdt+/vTggD/97Y2dqGGvAVziLH9twvtFNw9UGrGdDmp6ROd/fiXAypXfr
8Es/uQtuoYbAwT6Rr24gkvwOPrkDHcx9YjYRs8IsnHg2Lr62HA2b+C1R+WUYRvk/
N6t0aMzjrefsJnzdZTHABgQPMk1HBZDoe0Yx4l2Cbzfbo5k4Eu7hRqEwj3mi6vEa
2FM3xgJz51qGZEij0wEiw8omvOVzNh4RhgNSkblrXBH/H9+zz4MJs0+Gth7/d6Ib
Uhy+ho8cm/7YUaOqFIjINMOp/hDeEriMSeahQJxCUDVRa8keuGLsbFbLQRrzSL1i
f+PbNbL/hVny6qX/mLJp/qnspF76foZhvEEy2gfu0m/YAL/CMja1sm6fWvejPWLw
FLJGIN1nXAYMxKKDJ3HaAj61yOLoG3ComyhUrc7Snerar9zRHpsgGS3xEbWPoGIQ
MigVw9J4w9ZojKxfk8uSTTXlQXc9rFsD8R5j6evOfXRh85gISw8tdFaVNqCduGkE
ZMjvIHWgplmFcJ8BZo4akvt/HaLYJwAgIWH1+AQN+HZv2a7gtELz8lE+F/OrPmTQ
HDNM6whghlYN6W4UgDHWIp6wxzMEUquU+V9G+laaJzME9kOWld4ZG3X7AQXxeR89
lcnp5rt1PyuXxKOJzNUpywDkgQhX4PrrzsNTRszGRbj0uY4fqM5QVXafORhX7w==
=L/8U
-----END PGP PUBLIC KEY BLOCK-----
__ZEROED_FILE__
install_file /etc/zeroed/tailscale-archive.asc 0644 <<'__ZEROED_FILE__'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF5UmbgBEADAA5mxC8EoWEf53RVdlhQJbNnQW7fctUA5yNcGUbGGGTk6XFqO
nlek0Us0FAl5KVBgcS0Bj+VSwKVI/wx91tnAWI36CHeMyPTawdT4FTcS2jZMHbcN
UMqM1mcGs3wEQmKz795lfy2cQdVktc886aAF8hy1GmZDSs2zcGMvq5KCNPuX3DD5
INPumZqRTjwSwlGptUZrJpKWH4KvuGr5PSy/NzC8uSCuhLbFJc1Q6dQGKlQxwh+q
AF4uQ1+bdy92GHiFsCMi7q43hiBg5J9r55M/skboXkNBlS6kFviP+PADHNZe5Vw0
0ERtD/HzYb3cH5YneZuYXvnJq2/XjaN6OwkQXuqQpusB5fhIyLXE5ZqNlwBzX71S
779tIyjShpPXf1HEVxNO8TdVncx/7Zx/FSdwUJm4PMYQmnwBIyKlYWlV2AGgfxFk
mt2VexyS5s4YA1POuyiwW0iH1Ppp9X14KtOfNimBa0yEzgW3CHTEg55MNZup6k2Q
mRGtRjeqM5cjrq/Ix15hISmgbZogPRkhz/tcalK38WWAR4h3N8eIoPasLr9i9OVe
8aqsyXefCrziaiJczA0kCqhoryUUtceMgvaHl+lIPwyW0XWwj+0q45qzjLvKet+V
Q8oKLT1nMr/whgeSJi99f/jE4sWIbHZ0wwR02ZCikKnS05arl3v+hiBKPQARAQAB
tERUYWlsc2NhbGUgSW5jLiAoUGFja2FnZSByZXBvc2l0b3J5IHNpZ25pbmcga2V5
KSA8aW5mb0B0YWlsc2NhbGUuY29tPokCTgQTAQgAOBYhBCWWqZ6qszghiTwKeUWM
qDKVf1hoBQJeVJm4AhsDBQsJCAcCBhUKCQgLAgQWAgMBAh4BAheAAAoJEEWMqDKV
f1hoWHEP/1DYd9WZrodyV5zy1izvj0FXtUReJi374gDn3cHrG6uYtXcE9HWZhxQD
6nDgYuey5sBhLvPQiE/sl5GYXNw/O95XVk8HS54BHCCYq1GeYkZaiCGLGFBA08JK
7PZItGsfdJHwHfhSMtGPS7Cpmylje9gh8ic56NAhC7c5tGTlD69Y8zGHjnRQC6Hg
wF34jdp8JTQpSctpmiOxOXN+eH8N59zb0k30CUym1Am438AR0PI6RBTnubBH+Xsc
eQhLJnmJ1bM6GP4agXw5T1G/qp95gjIddHXzOkEvrpVfJFCtp91VIlBwycspKYVp
1IKAdPM6CVf/YoDkawwm4y4OcmvNarA5dhWBG0Xqse4v1dlYbiHIFcDzXuMyrHYs
D2Wg8Hx8TD64uBHY0fp24nweCLnaZCckVUsnYjb0A494lgwveswbZeZ6JC5SbDKH
Tc2SE4jq+fsEEJsqsdHIC04d+pMXI95HinJHU1SLBTeKLvEF8Zuk7RTJyaUTjs7h
Ne+xWDmRjjR/D/GXBxNrM9mEq6Jvp/ilYTdWwAyrSmTdotHb+NWjAGpJWj5AZCH9
HeBr2mtVhvTu3KtCQmGpRiR18zMbmemRXUh+IX5hpWGzynhtnSt7vXOvhJdqqc1D
VennRMQZMb09wJjPcvLIApUMl69r29XmyB59NM3UggK/UCJrpYfmuQINBF5UmbgB
EADTSKKyeF3XWDxm3x67MOv1Zm3ocoe5xGDRApPkgqEMA+7/mjVlahNXqA8btmwM
z1BH5+trjOUoohFqhr9FPPLuKaS/pE7BBP38KzeA4KcTiEq5FQ4JzZAIRGyhsAr+
6bxcKV/tZirqOBQFC7bH2UAHH7uIKHDUbBIDFHjnmdIzJ5MBPMgqvSPZvcKWm40g
W+LWMGoSMH1Uxd+BvW74509eezL8p3ts42txVNvWMSKDkpiCRMBhfcf5c+YFXWbu
r5qus2mnVw0hIyYTUdRZIkOcYBalBjewVmGuSIISnUv76vHz133i0zh4JcXHUDqc
yLBUgVWckqci32ahy3jc4MdilPeAnjJQcpJVBtMUNTZ4KM7UxLmOa5hYwvooliFJ
wUFPB+1ZwN8d+Ly12gRKf8qA/iL8M5H4nQrML2dRJ8NKzP2U73Fw+n6S1ngrDX8k
TPhQBq4EDjDyX7SW3Liemj5BCuWJAo53/2cL9P9I5Nu3i2pLJOHzjBSXxWaMMmti
kopArlSMWMdsGgb0xYX+aSV7xW+tefYZJY1AFJ1x2ZgfIc+4zyuXnHYA2jVYLAfF
pApqwwn8JaTJWNhny/OtAss7XV/WuTEOMWXaTO9nyNmHla9KjxlBkDJG9sCcgYMg
aCAnoLRUABCWatxPly9ZlVbIPPzBAr8VN/TEUbceAH0nIwARAQABiQI2BBgBCAAg
FiEEJZapnqqzOCGJPAp5RYyoMpV/WGgFAl5UmbgCGwwACgkQRYyoMpV/WGji9w/8
Di9yLnnudvRnGLXGDDF2DbQUiwlNeJtHPHH4B9kKRKJDH1Rt5426Lw8vAumDpBlR
EeuT6/YQU+LSapWoDzNcmDLzoFP7RSQaB9aL/nJXv+VjlsVH/crpSTTgGDs8qGsL
O3Y2U1Gjo5uMBoOfXwS8o1VWO/5eUwS0KH7hpbOuZcf9U9l1VD2YpGfnMwX1rnre
INJqseQAUL3oyNl76gRzyuyQ4AIA06r40hZDgybH0ADN1JtfVk8z4ofo/GcfoXqm
hifWJa2SwwHeijhdN1T/kG0FZFHs1DBuBYJG3iJ3/bMeL15j1OjncIYIYccdoEUd
uHnp4+ZYj5kND0DFziTvOC4WyPpv3BlBVariPzEnEqnhjx5RYwMabtTXoYJwUkxX
2gAjKqh2tXissChdwDGRNASSDrChHLkQewx+SxT5kDaOhB84ZDnp+urn9A+clLkN
lZMsMQUObaRW68uybSbZSmIWFVM1GovRMgrPG3T6PAykQhFyE/kMFrv5KpPh7jDj
5JwzQkxLkFMcZDdS43VymKEggxqtM6scIRU55i059fLPAVXJG5in1WhMNsmt49lb
KqB6je3plIWOLSPuCJ/kR9xdFp7Qk88GCXEd0+4z/vFn4hoOr85NXFtxhS8k9GfJ
mM/ZfUq7YmHR+Rswe0zrrCwTDdePjGMo9cHpd39jCvc=
=AIVM
-----END PGP PUBLIC KEY BLOCK-----
__ZEROED_FILE__
install_file /opt/zeroed/stub/signer.mjs 0644 <<'__ZEROED_FILE__'
// Stand-in for the signer until SIGN-1 lands. Holds no key. Listens only on a Unix socket in its runtime
// directory (the unit has no network at all) and answers every request with "not ready".
import { chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const path = join(process.env.RUNTIME_DIRECTORY ?? '/run/zeroed-signer', 'signer.sock');
rmSync(path, { force: true });
const server = createServer((sock) => {
  sock.setTimeout(5000, () => sock.destroy());
  sock.on('error', () => {});
  sock.once('data', () => sock.end(JSON.stringify({ status: 'not-ready', reason: 'no key until SIGN-1' }) + '\n'));
});
server.listen(path, () => {
  chmodSync(path, 0o660);
  console.log('Stub signer listening on its Unix socket (no key, not ready).');
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
__ZEROED_FILE__
install_file /opt/zeroed/stub/worker.mjs 0644 <<'__ZEROED_FILE__'
// Stand-in for the worker until WORKER-1 lands. It exercises everything the host gives the real worker:
// encrypted credentials (it counts them, never prints them), the state directory with a SQLite ledger
// (so the hourly backup has real data), the signer socket, and the HMAC-signed heartbeat to the watchdog.
// `--reconcile` is the ExecStartPre step: the real worker settles open intents against the chain there.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const credDir = process.env.CREDENTIALS_DIRECTORY ?? '';
const stateDir = process.env.STATE_DIRECTORY ?? '/var/lib/zeroed';
const watchdog = (process.env.WATCHDOG_URL ?? '').replace(/\/$/, '');
const intervalMs = Number(process.env.ZEROED_HEARTBEAT_MS ?? 20_000);
const NAMES = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id'];

const loaded = credDir ? NAMES.filter((n) => existsSync(join(credDir, n))) : [];
// RC-FIXES-2b: whether a ledger was here before this process (a release worker may have traded on it).
const hadLedger = existsSync(join(stateDir, 'ledger.sqlite'));
const db = new DatabaseSync(join(stateDir, 'ledger.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
db.exec('CREATE TABLE IF NOT EXISTS host_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)');
const record = db.prepare('INSERT INTO host_events (ts, kind, detail) VALUES (?, ?, ?)');
const event = (kind, detail = null) => record.run(new Date().toISOString(), kind, detail);

let gitSha = 'none';
try {
  gitSha = basename(readlinkSync('/opt/zeroed/current'));
} catch {}

if (process.argv.includes('--reconcile')) {
  const ok = loaded.length === NAMES.length;
  // Contract with the host's update check: the number of open intents (and open positions) after reconcile. RC-FIXES-2b
  // (red team C R3-5): the stand-in settles nothing, so it never writes 0 over a count a release worker left. A count
  // that is missing is 0 only on a host where no ledger existed before this process (nothing ever traded), else unknown.
  const count = (f) => {
    const p = join(stateDir, f);
    if (!existsSync(p)) writeFileSync(p, hadLedger ? 'unknown\n' : '0\n');
    return readFileSync(p, 'utf8').trim();
  };
  const intents = count('open_intents');
  const positions = count('open_positions');
  event('reconcile', `stub: ${intents} open intents, ${positions} open positions, ${ok ? 'ok' : 'credentials missing'}`);
  console.log(`Reconcile: ${intents} open intents, ${loaded.length} of ${NAMES.length} credentials present. ${ok ? 'OK' : 'Refusing to start.'}`);
  db.close();
  process.exit(ok ? 0 : 1);
}

function signerStatus() {
  return new Promise((resolve) => {
    const sock = connect('/run/zeroed-signer/signer.sock');
    let buf = '';
    const done = (s) => {
      sock.destroy();
      resolve(s);
    };
    sock.setTimeout(2000, () => done('timeout'));
    sock.on('error', () => done('unreachable'));
    sock.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        try {
          done(JSON.parse(buf).status);
        } catch {
          done('bad reply');
        }
      }
    });
    sock.on('connect', () => sock.write('status\n'));
  });
}

let seq = 0;
const ownerChat = loaded.includes('telegram_chat_id') ? readFileSync(join(credDir, 'telegram_chat_id'), 'utf8').trim() : null;
let paused = false;
// The heartbeat key arrives with the watchdog (OPS-1b); until then no heartbeat is sent.
const key = credDir && existsSync(join(credDir, 'heartbeat_hmac_key')) ? readFileSync(join(credDir, 'heartbeat_hmac_key'), 'utf8') : '';

async function beat() {
  seq += 1;
  const signer = await signerStatus();
  event('heartbeat', `seq ${seq}, signer ${signer}`);
  if (!watchdog || !key) return;
  const body = JSON.stringify({
    seq,
    ts: Date.now(),
    boot: bootId,
    git_sha: gitSha,
    policy_version: 'stub',
    stub: true,
    last_processed_slot: null,
    feed_ages_ms: {},
    open_position: null,
    unresolved_intents: { count: 0, oldest_age_s: null },
    signer,
    lease_epoch: null,
    sol_reserve: null,
    paused,
    owner_chat_id: ownerChat,
  });
  const t = Math.floor(Date.now() / 1000);
  // Signed text: timestamp, method, path, body (the watchdog refuses a signature on any other route).
  const sig = createHmac('sha256', key).update(`${t}\nPOST\n/heartbeat\n${body}`).digest('hex');
  try {
    const res = await fetch(`${watchdog}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${sig}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const reply = await res.json().catch(() => ({}));
    // Worker contract (ops/README.md): apply the watchdog's flag both ways, so the state and the message agree.
    if (res.ok && typeof reply.paused === 'boolean' && reply.paused !== paused) {
      paused = reply.paused;
      event(paused ? 'pause' : 'resume', paused ? 'owner /pause via watchdog' : 'cleared from the host');
      console.log(paused ? 'Entries paused by the owner (watchdog). Exits keep running.' : 'Entries allowed again (pause cleared from the host).');
    }
    if (!res.ok) console.log(`Heartbeat refused: HTTP ${res.status}`);
  } catch (e) {
    console.log(`Heartbeat failed: ${e.name}`);
  }
}

const bootId = `${Date.now().toString(36)}-${process.pid}`;

// The worker API (ZEROED_API_ADDR), loopback only (ARCHITECTURE.md 12.4); `tailscale serve` publishes it to the
// owner's tailnet. Its /health lists the dry-run evidence kept on the host (`evidence`; zeroed-check writes the index).
const healthAddr = process.env.ZEROED_API_ADDR ?? '';
let server = null;
if (healthAddr) {
  const m = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(healthAddr);
  if (!m) {
    console.log('Refused: the worker API must bind loopback only.');
    process.exit(2);
  }
  const evidence = () => {
    try {
      const list = JSON.parse(readFileSync('/var/lib/zeroed-index/evidence.json', 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"not found"}');
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ stub: true, mode: 'paper', boot: bootId, seq, git_sha: gitSha, paused, signing_key: false, evidence: evidence() }));
  });
  server.listen(Number(m[2]), m[1].replace(/[[\]]/g, ''));
}
console.log(`Stub worker up: ${loaded.length} of ${NAMES.length} credentials, release ${gitSha.slice(0, 12)}, watchdog ${watchdog ? 'set' : 'not set'}.`);
event('start', gitSha);
await beat();
const timer = setInterval(() => void beat(), intervalMs);
const stop = () => {
  clearInterval(timer);
  server?.close();
  event('stop');
  db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/common.sh 0644 <<'__ZEROED_FILE__'
# Shared helpers for the Zeroed host scripts. Sourced, never run. Never prints a secret value.
# shellcheck shell=bash
. /etc/zeroed/host.env
. /usr/local/lib/zeroed/logic.sh
CRED_DIR=/etc/credstore.encrypted
STATE_DIR=/var/lib/zeroed-host
DEPLOY_CODE_FILE=/etc/zeroed/deploy-code
PAIR_CODE_FILE=/etc/zeroed/pair-code
API_NAMES=(HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN)
# Dry-run evidence stays on the host (RUN-1 writes it); the index of it is world-readable for the worker API.
EVIDENCE_ROOT=/var/lib/zeroed-dryrun/evidence
EVIDENCE_INDEX=/var/lib/zeroed-index/evidence.json

log() { printf '%s\n' "$*"; }

# One host script at a time (the setup screen and the timers call the same scripts).
lock() { exec 9>/run/zeroed-host.lock; flock -w 60 9; }

# cred NAME: prints the decrypted credential to stdout (for a pipe or $(...), never to a terminal or log).
cred() { systemd-creds decrypt --name="$1" "$CRED_DIR/$1" -; }

# store_cred NAME: encrypts stdin into the credential NAME (the value is never an argument).
store_cred() {
  systemd-creds encrypt --with-key=host --name="$1" - "$CRED_DIR/$1.new"
  chmod 0600 "$CRED_DIR/$1.new"
  mv -f "$CRED_DIR/$1.new" "$CRED_DIR/$1"
  record_cred "$1"
}

# record_cred NAME: remembers the SHA-256 of the stored ciphertext (never of the value), so zeroed-check can
# tell a credential changed outside the handoff or pairing from one stored by them.
record_cred() {
  install -d -m 0700 "$STATE_DIR/cred_sha"
  sha256sum "$CRED_DIR/$1" | cut -c1-64 > "$STATE_DIR/cred_sha/$1"
}

# tg METHOD [curl args...]: calls the Telegram Bot API. The token (and the chat id, from $tg_chat when
# set) go to curl on stdin (-K -), never in argv, so they do not show in the process list.
tg() {
  local method="$1"
  shift
  cred telegram_bot_token | {
    IFS= read -r token || true
    printf 'url = "%s/bot%s/%s"\n' "$ZEROED_TELEGRAM_URL" "$token" "$method"
    # $tg_field: data-urlencode (default) or form (for a multipart upload such as sendDocument).
    [ -z "${tg_chat:-}" ] || printf '%s = "chat_id=%s"\n' "${tg_field:-data-urlencode}" "$tg_chat"
  } | curl -fsS -m 30 -K - "$@"
}

# send_to CHAT TEXT: one message to one chat.
send_to() {
  local tg_chat="$1"
  tg sendMessage -o /dev/null --data-urlencode "text=$2"
}

# notify TEXT: sends TEXT to the paired owner chat. Returns non-zero if not paired or on failure.
notify() {
  [ -s "$CRED_DIR/telegram_chat_id" ] || return 1
  local chat
  chat="$(cred telegram_chat_id)" || return 1
  send_to "$chat" "$1"
}

# alert KEY TEXT: tells the owner once per episode (until alert_clear KEY). Kept pending when Telegram cannot
# be reached, so the next run tries again; the journal always has the line.
alert() {
  install -d -m 0700 "$STATE_DIR/alerts"
  [ ! -e "$STATE_DIR/alerts/$1" ] || return 0
  log "$2"
  if notify "$2"; then : > "$STATE_DIR/alerts/$1"; else log "Could not send that alert to Telegram; trying again next run."; fi
}

# alert_clear KEY TEXT: sends TEXT once if KEY was alerted, and closes the episode.
alert_clear() {
  [ -e "$STATE_DIR/alerts/$1" ] || return 0
  log "$2"
  notify "$2" || true
  rm -f "$STATE_DIR/alerts/$1"
}

new_pair_code() {
  local n
  n="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  printf '%06d\n' $((n % 1000000)) > "$PAIR_CODE_FILE.new"
  chmod 0400 "$PAIR_CODE_FILE.new"
  mv -f "$PAIR_CODE_FILE.new" "$PAIR_CODE_FILE"
}

new_deploy_code() {
  /usr/local/bin/node -e '
    const { randomInt } = require("node:crypto");
    const words = require("node:fs").readFileSync("/usr/local/share/zeroed/eff_large_wordlist.txt", "utf8").trim().split("\n");
    if (words.length !== 7776) process.exit(1);
    console.log(Array.from({ length: 6 }, () => words[randomInt(words.length)]).join(" "));
  ' > "$DEPLOY_CODE_FILE.new"
  chmod 0400 "$DEPLOY_CODE_FILE.new"
  mv -f "$DEPLOY_CODE_FILE.new" "$DEPLOY_CODE_FILE"
  rm -f "$STATE_DIR/handoff_status"
}

# set_webhook: points the bot's webhook at the watchdog (its /pause and /status), once paired. Needs the
# watchdog address and the webhook secret from the last handoff; the secret goes to curl on stdin.
set_webhook() {
  paired && [ -s "$CRED_DIR/telegram_webhook_secret" ] || return 0
  local url
  url="$(sed -n 's/^WATCHDOG_URL=//p' /etc/zeroed/worker.env 2>/dev/null || true)"
  [ -n "$url" ] || return 0
  cred telegram_webhook_secret | {
    IFS= read -r secret || true
    cred telegram_bot_token | { IFS= read -r token || true; printf 'url = "%s/bot%s/setWebhook"\ndata-urlencode = "secret_token=%s"\n' "$ZEROED_TELEGRAM_URL" "$token" "$secret"; }
  } | curl -fsS -m 30 -o /dev/null -K - --data-urlencode "url=$url/telegram" --data-urlencode 'allowed_updates=["message"]'
}

# webhook_info: Telegram's getWebhookInfo reply (JSON) on stdout.
webhook_info() { tg_chat="" tg getWebhookInfo 2>/dev/null || echo '{"ok":false}'; }

# webhook_try: one try to set the webhook. On success it records what Telegram now reports as the expected
# fingerprint; on failure it schedules the next try with back-off (zeroed-check runs it when due) and tells
# the owner after WEBHOOK_MAX_TRIES failed tries in a row.
webhook_try() {
  local tries now
  if set_webhook 2>/dev/null; then
    webhook_info | webhook_fp > "$STATE_DIR/webhook_expected"
    if [ -e "$STATE_DIR/webhook_tries" ]; then log "Telegram webhook set after $(cat "$STATE_DIR/webhook_tries") failed tries."; fi
    rm -f "$STATE_DIR/webhook_tries" "$STATE_DIR/webhook_next"
    alert_clear webhook-failed "Zeroed host: the Telegram webhook is set again; /pause and /status work."
    return 0
  fi
  tries=$(($(cat "$STATE_DIR/webhook_tries" 2>/dev/null || echo 0) + 1))
  now="$(date +%s)"
  printf '%s
' "$tries" > "$STATE_DIR/webhook_tries"
  printf '%s
' "$((now + $(backoff_s "$tries")))" > "$STATE_DIR/webhook_next"
  log "Could not set the Telegram webhook for the watchdog (try $tries); next try in $(backoff_s "$tries") s."
  if [ "$tries" -ge "$WEBHOOK_MAX_TRIES" ]; then
    alert webhook-failed "Zeroed host: could not set the Telegram webhook after $tries tries, so /pause and /status do not reach the watchdog. Alerts still come here. The server keeps trying every $(($(backoff_s "$tries") / 60)) min."
  fi
  return 1
}

# webhook_off: turns the webhook off on purpose (pairing reads messages with getUpdates), so the change
# check expects no webhook until it is set again.
webhook_off() {
  tg_chat="" tg deleteWebhook -o /dev/null 2>/dev/null || return 1
  printf 'none\n' > "$STATE_DIR/webhook_expected"
}

# worker_busy: true while a qualifying dry run is active, the worker reports open intents (or cannot say), or zeroed-update
# is holding a new release's start ($STATE_DIR/holding, OPS-CLEAN m4: a restart then would fail a good release's hold).
worker_busy() {
  [ ! -e "$STATE_DIR/holding" ] || return 0
  [ -z "$(qualifying_run "$EVIDENCE_ROOT" "$(systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend 2>/dev/null || true)")" ] || return 0
  systemctl is-active --quiet zeroed-worker.service || return 1
  [ "$(cat /var/lib/zeroed/open_intents 2>/dev/null || echo unknown)" != 0 ]
}

keys_stored() { for n in "${API_NAMES[@]}"; do [ -s "$CRED_DIR/${n,,}" ] || return 1; done; }
paired() { [ -s "$CRED_DIR/telegram_chat_id" ]; }
# worker_ready: the worker may start: every key stored and the owner's chat paired (its unit's ConditionPathExists, and more).
worker_ready() { keys_stored && paired; }
# restart_for_chat: the worker reads the chat at start, so a re-paired chat restarts it now, or at the next safe moment
# (pending_restart, from zeroed-check) while it is busy.
restart_for_chat() {
  if worker_busy; then
    : > "$STATE_DIR/worker_restart_pending"
    log "Worker restart for the new chat waits for the dry run to end, open intents to settle and any held start to pass."
  else
    systemctl try-restart zeroed-worker.service || true
  fi
}
# pending_restart: a worker restart that waited for a safe moment.
pending_restart() {
  if [ -e "$STATE_DIR/worker_restart_pending" ] && ! worker_busy; then
    rm -f "$STATE_DIR/worker_restart_pending"
    systemctl try-restart zeroed-worker.service || true
    log "Restarted the worker (a restart for a new chat or new keys waited for a safe moment)."
  fi
}
# start_worker: starts the worker, or, while a switched release has never run under the hold (switch_unheld, OPS-CLEAN
# M1), starts zeroed-update for its held first start. --no-block: the caller may hold the host lock.
start_worker() {
  if [ -s "$STATE_DIR/switch_unheld" ]; then systemctl start --no-block zeroed-update.service; else systemctl start zeroed-worker.service; fi
}
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/derive-key.mjs 0644 <<'__ZEROED_FILE__'
// Derives the one-time age identity for the Deploy handoff from the deploy code (6 words), read on stdin;
// with --backup, the owner's backup identity from the backup code instead.
// Prints AGE-SECRET-KEY-1... on stdout. The workflow encrypts to its public half (age-keygen -y); the host
// decrypts with it. Same idea as age's passphrase mode (scrypt, age's own work factor logN 18, r 8, p 1),
// which age 1.1.1 can only read from a terminal. The code is normalised (lowercase, single spaces), so
// stray spaces or capitals in the GitHub secret do not matter.
import { scryptSync } from 'node:crypto';

let input = '';
for await (const c of process.stdin) input += c;
const code = input.trim().toLowerCase().split(/\s+/).join(' ');
if (!/^[a-z-]+( [a-z-]+){5}$/.test(code)) {
  console.error('Deploy code must be 6 words.');
  process.exit(2);
}
// Domain separation by purpose: the deploy code (default) and the owner's backup code never share a key.
const SALTS = { deploy: 'zeroed-deploy-handoff-v1', backup: 'zeroed-backup-v1' };
const purpose = process.argv[2] === '--backup' ? 'backup' : 'deploy';
const key = scryptSync(code, SALTS[purpose], 32, { N: 2 ** 18, r: 8, p: 1, maxmem: 320 * 1024 * 1024 });
// RFC 7748 clamp, so the stored scalar is exactly the one X25519 uses (X25519 clamps on use anyway, so this
// changes the encoded identity, never the key pair it stands for).
key[0] &= 248;
key[31] &= 127;
key[31] |= 64;

// Bech32 (BIP 173), as age uses for identities.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (values) => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk;
};
const hrp = 'age-secret-key-';
const words = [];
let acc = 0;
let bits = 0;
for (const b of key) {
  acc = (acc << 8) | b;
  bits += 8;
  while (bits >= 5) {
    bits -= 5;
    words.push((acc >>> bits) & 31);
  }
}
if (bits > 0) words.push((acc << (5 - bits)) & 31);
const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
const mod = polymod(hrpExpand.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
process.stdout.write((hrp + '1' + words.concat(checksum).map((d) => CHARSET[d]).join('')).toUpperCase() + '\n');
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/logic.sh 0644 <<'__ZEROED_FILE__'
# Pure decision helpers for the Zeroed host scripts: no side effects, no host paths read unless passed in,
# so packages/ops/test/host-logic.test.ts runs them anywhere. Sourced, never run. Never prints a secret value.
# shellcheck shell=bash

PAIR_CODE_TTL_S=1800       # a pairing code works for 30 minutes
WEBHOOK_MAX_TRIES=5        # the owner is told after this many failed tries in a row
WORKER_API_ADDR=127.0.0.1:8788 # the worker API, loopback only; tailscale serve publishes it to the tailnet
WORKER_HEALTH_ADDR=127.0.0.1:8787 # the worker's health route for the runner (RUN-1's default), never published
TABLETOP_API_ADDR=127.0.0.1:8789 # reserved for RUN-1d's zeroed-worker-tabletop (never published)
SMOKE_HEALTH_ADDR=127.0.0.1:8797 # worker-smoke's trial start of a new release (never published)
SMOKE_API_ADDR=127.0.0.1:8798
SMOKE_MEMORY_MAX=280M # the trial's memory cap beside the live worker (up to 800M): set for the 1 GB server and kept on the 2 GB one while only the stand-in runs (Z10 sizes the recorder's unit from measurement)
SMOKE_HOLD_S=30 # after its first health answer, the trial worker must still run and answer this long
SWITCH_HOLD_S=30 # after a switch, the new worker must run this long with no restart and health answering
PROBATION_S=7200 # RC-R2-3: after a switch, any automatic restart of the worker within this window rolls it back
RELEASE_UNIT_RE='^zeroed-(dryrun[a-z0-9-]*@?|worker-tabletop)\.(service|timer)$' # units taken from the release

# backoff_s TRIES: seconds to wait after TRIES failed tries in a row (1 min, doubling, at most 30 min).
backoff_s() {
  local n="$1" s=60
  while [ "$n" -gt 1 ] && [ "$s" -lt 1800 ]; do s=$((s * 2)); n=$((n - 1)); done
  [ "$s" -le 1800 ] || s=1800
  printf '%s\n' "$s"
}

# pair_code_expired ISSUED NOW: true once a code issued at ISSUED (epoch s) is older than the TTL.
pair_code_expired() { [ $(($2 - $1)) -gt "$PAIR_CODE_TTL_S" ]; }

# webhook_fp: reads Telegram's getWebhookInfo reply on stdin and prints "none" (no webhook) or the SHA-256 of
# what defines where updates go (url, certificate, connections, update types). The IP address and error
# fields are left out: Telegram changes them on its own.
webhook_fp() {
  local fp
  fp="$(jq -r 'if .ok != true then "error"
    elif ((.result.url // "") == "") then "none"
    else [.result.url, (.result.has_custom_certificate // false), (.result.max_connections // 40), ((.result.allowed_updates // []) | sort)] | tojson end')" || fp=error
  case "$fp" in
    none | error) printf '%s\n' "$fp" ;;
    *) printf '%s' "$fp" | sha256sum | cut -c1-64 ;;
  esac
}

# webhook_host: prints the host of the webhook URL in a getWebhookInfo reply on stdin, or "none".
webhook_host() { jq -r '(.result.url // "") | if . == "" then "none" else (sub("^[a-z]+://"; "") | sub("[/?#].*$"; "")) end'; }

# qualifying_run EVIDENCE_ROOT UNITS: prints the name of an active qualifying dry run, or nothing. UNITS is
# the output of `systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend`. A run
# is also active while EVIDENCE_ROOT/<id>/run.json names it and it has no report.json yet (RUN-1's
# "unfinished" rule): that covers the minutes after a reboot drill before the runner resumes.
qualifying_run() {
  local unit d name
  unit="$(printf '%s\n' "$2" | sed -n 's/^\(●[[:space:]]*\)\{0,1\}zeroed-dryrun@\([^[:space:]]*\)\.service.*/\2/p' | head -1)"
  if [ -n "$unit" ]; then printf '%s\n' "$unit"; return 0; fi
  for d in "$1"/*/; do
    [ -f "$d/run.json" ] && [ ! -e "$d/report.json" ] || continue
    name="$(jq -r '.name // empty | strings' "$d/run.json" 2>/dev/null || true)"
    if [ -n "$name" ]; then printf '%s\n' "$name"; return 0; fi
  done
  return 0
}

# evidence_index EVIDENCE_ROOT: prints a JSON list of the dry runs kept on the host (newest first): id,
# name, label, commit, started, finished, pass, aborted and the evidence path. Read by the worker's health API.
evidence_index() {
  local d id
  for d in "$1"/*/; do
    [ -f "$d/run.json" ] || continue
    id="$(basename "$d")"
    [[ "$id" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || continue
    jq -c --arg id "$id" --arg path "${d%/}" \
      --argjson finished "$([ -f "$d/report.json" ] && echo true || echo false)" \
      --argjson report "$(jq -c '{pass: (.pass | if type == "boolean" then . else null end)}' "$d/report.json" 2>/dev/null || echo '{"pass":null}')" \
      --arg aborted "$(head -c 200 "$d/ABORTED" 2>/dev/null | tr -d '\n' || true)" \
      '{id: $id, name: (.name // null), label: (.label // null), commit: (.commit // null),
        started: (.startedAt // null), finished: $finished, pass: (if $finished then $report.pass else null end),
        aborted: (if $aborted == "" then null else $aborted end), path: $path}' "$d/run.json" 2>/dev/null || true
  done | jq -s 'sort_by(.started // 0, .id) | reverse'
}

# serve_ok: reads `tailscale serve status --json` on stdin; true only when HTTPS 443 proxies to the worker API
# on loopback and Funnel is off everywhere.
serve_ok() {
  # Exactly one thing published (OPS-1h review): HTTPS on 443, one host, its "/" proxied to the worker API and
  # nothing else (no other path, port, host, TCP forward or service), and Funnel on for nothing. A serve made by hand
  # is adopted only in this shape.
  jq -e --arg target "http://$WORKER_API_ADDR" '
    type == "object"
    and ((keys - ["TCP", "Web", "AllowFunnel"]) == [])
    and .TCP == {"443": {"HTTPS": true}}
    and ((.Web // {}) | length == 1)
    and ((.Web // {}) | to_entries[0] | (.key | endswith(":443")) and .value == {"Handlers": {"/": {"Proxy": $target}}})
    and ((.AllowFunnel // {}) | to_entries | all(.value != true))' >/dev/null 2>&1
}

# unit_sandbox UNIT_FILE: the unit's [Service] settings that make its sandbox, limits and environment, one per line, for
# worker-smoke's trial: everything except its identity and groups, credentials, state directory, the live folders it may
# write (ReadWritePaths: PATHS-FIX's market data and import spool, which the trial, running as the worker's user, must
# never write beside the live worker; it writes only its own temporary folder), restarts, start and stop commands, its
# memory limit and its OOM score (the trial sets its own user, cap, OOM score and stop timeout).
unit_sandbox() {
  sed -n '/^\[Service\]/,/^\[/p' "$1" | grep -E '^[A-Z][A-Za-z]*=' |
    grep -Ev '^(Type|User|Group|SupplementaryGroups|Environment|EnvironmentFile|ExecStart|ExecStartPre|ExecStop|Restart|RestartSec|TimeoutStopSec|LoadCredential|LoadCredentialEncrypted|ImportCredential|SetCredential|StateDirectory|StateDirectoryMode|ReadWritePaths|MemoryMax|OOMScoreAdjust)=' || true
}

# funnel_ports: reads `tailscale serve status --json` on stdin and prints each "host:port" that Funnel makes
# public (none on a correct host: the app cannot tell a public Funnel address from a tailnet one).
funnel_ports() { jq -r '(.AllowFunnel // {}) | to_entries[] | select(.value == true) | .key' 2>/dev/null || true; }

# worker_entry RELEASE_DIR: the program the worker unit runs. The release's own worker (WORKER-1) only when the
# release's ops/host-config.json says "worker": "release" (a reviewed commit) and the file exists; the host's stand-in
# when it says "worker": "stub", or when no release is deployed yet (RELEASE_DIR does not exist and is not a link: a
# first install). Switching the host to the real worker is a decision, not a side effect of a merge. RC-M4: anything
# else is refused, never run as the stand-in (which passes worker-smoke and update health, so the host would look
# healthy with no trading worker): a host-config missing or unreadable, a "worker" value missing or unknown, or
# "release" without its main.ts. A refusal says why on stderr and returns 1: worker-start and worker-smoke then fail,
# loudly.
STUB_ENTRY=/opt/zeroed/stub/worker.mjs # the host's stand-in worker
worker_entry() {
  # Nothing there at all (not even a dangling link: that is a release gone missing, refused below).
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    printf '%s\n' "$STUB_ENTRY"
    return 0
  fi
  local w
  if ! w="$(jq -er 'if type == "object" then (.worker // "(missing)") | if type == "string" then . else "(not a string)" end else error("not an object") end' "$1/ops/host-config.json" 2>/dev/null)"; then
    echo "refused: $1/ops/host-config.json is missing or cannot be read, so the worker to run is unknown" >&2
    return 1
  fi
  case "$w" in
    release)
      if [ -f "$1/packages/worker/src/main.ts" ]; then
        printf '%s\n' "$1/packages/worker/src/main.ts"
      else
        echo "refused: host-config says \"worker\": \"release\" but $1/packages/worker/src/main.ts is missing" >&2
        return 1
      fi
      ;;
    stub) printf '%s\n' "$STUB_ENTRY" ;;
    *)
      echo "refused: host-config \"worker\" is $(printf '%s' "$w" | tr -c 'A-Za-z0-9()_. -' '?' | cut -c1-40), not \"release\" or \"stub\"" >&2
      return 1
      ;;
  esac
}

# worker_refused FILE STATUS: why the worker refused to start, or nothing (RC-FIXES-2b, #280's contract). FILE is the
# worker's <state>/refused.json ({reason, atMs, commit}); STATUS is the unit's ExecMainStatus, where 78 is a refusal.
# One line, at most 200 characters, never the separator "|".
worker_refused() {
  local r
  if [ -e "$1" ]; then
    r="$(jq -r '"\(.reason // "no reason given") (commit \((.commit // "?") | tostring | .[0:12]))"' "$1" 2>/dev/null)" || r="refused.json cannot be read"
    [ -n "$r" ] || r="refused.json cannot be read"
  elif [ "$2" = 78 ]; then
    r="exit 78 with no refused.json"
  else
    return 0
  fi
  printf '%s\n' "$r" | tr -d '\r|' | tr '\n' ' ' | cut -c1-200 | sed 's/ *$//'
}

# The only worker settings a release's ops/host-config.json may give (PRACTICE-ON): the S0 shakedown's, in its
# "shakedown" block. Mode, recorder, simulation, drills and addresses stay with worker-start; live is never one of them.
SHAKEDOWN_NAMES='ZEROED_STRATEGY ZEROED_S0_DIAGNOSTIC ZEROED_PAPER_EDGE_PPM ZEROED_STANDINS ZEROED_WALLET'

# worker_shakedown RELEASE_DIR: the release's shakedown settings, one NAME=value per line; nothing when it has no
# "shakedown" block. Fails (jq says why on stderr) when the block is not an object, names anything outside
# SHAKEDOWN_NAMES, or holds a value that is not a string of 1 to 400 letters, digits and commas. The worker judges each
# value itself and refuses with exit 2 (S0 and its settings in a release with a qualifying run, among others).
worker_shakedown() {
  jq -r --arg names "$SHAKEDOWN_NAMES" '($names | split(" ")) as $ok | (.shakedown // {}) as $s
    | if ($s | type) != "object" then error("the shakedown block is not an object") else $s | to_entries[]
      | if (.key | IN($ok[]) | not) then error("\(.key) is not a shakedown setting")
        elif (.value | type) != "string" or (.value | test("\\A[A-Za-z0-9,]{1,400}\\z") | not) then error("\(.key) is not 1 to 400 letters, digits and commas")
        else "\(.key)=\(.value)" end end' "$1/ops/host-config.json"
}

# ssh_open: reads `nft list ruleset` on stdin; true when the live firewall lets SSH in.
ssh_open() { grep -Eq 'tcp dport 22 .*accept'; }

# ---------- Deploy gate (OPS-GATE): what "green" means, shared by the server (zeroed-update) and the Deploy
# workflow (ops/deploy/tag.sh), so the two always agree. ----------
# Only GitHub Actions' own check runs count; the Deploy job's run (zeroed-deploy) never does, and neither does the
# scheduled advisory report (zeroed-advisories, .github/workflows/audit-schedule.yml): it runs daily on the newest
# commit of the default branch, so a failed, cancelled or still-running report would otherwise hold back a commit
# that nothing in its own diff broke (Z01 supervisor ruling 3.4). tools/policy refuses that job name in any other
# workflow (E_AUDIT_JOB_NAME), so no other run can borrow it.
DEPLOY_CHECK_APP=github-actions
DEPLOY_SELF_JOB=zeroed-deploy
DEPLOY_AUDIT_JOB=zeroed-advisories
# The paths whose change runs the ops end-to-end (.github/workflows/ops-e2e.yml `paths`; a test keeps them equal).
E2E_PATHS=(ops packages/ops .github/workflows/deploy.yml .github/workflows/ops-e2e.yml)

# commit_verdict NAME: reads a commit's check-runs reply (GitHub API) on stdin and prints one line, "green" or
# "red|pending|none: <why>". Green needs a successful run named NAME from GitHub Actions on that commit, every
# other GitHub Actions run finished and none failed (the Deploy job and the advisory report aside). A run from
# another app, or an all-skipped set, never makes
# it green; a listing GitHub cut short (more runs than returned) is "none".
commit_verdict() {
  jq -r --arg name "$1" --arg app "$DEPLOY_CHECK_APP" --arg self "$DEPLOY_SELF_JOB" --arg audit "$DEPLOY_AUDIT_JOB" '
    [(.check_runs // [])[] | select((.app.slug // "") == $app and .name != $self and .name != $audit)] as $r
    | ([$r[] | select(.name == $name)] | sort_by(.completed_at // .started_at // "") | last) as $n
    | if (.total_count // 0) > ((.check_runs // []) | length) then "none: more check runs than GitHub listed"
      elif any($r[]; .status != "completed") then "pending: \([$r[] | select(.status != "completed") | .name] | unique | join(", ")) still running"
      elif any($r[]; (.conclusion // "") as $c | ($c != "success" and $c != "neutral" and $c != "skipped")) then "red: \([$r[] | select(.conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped") | .name] | unique | join(", ")) failed"
      elif $n == null then "none: no \($name) run from GitHub Actions"
      elif $n.conclusion != "success" then "red: \($name) was \($n.conclusion), not success"
      else "green" end' 2>/dev/null || echo "none: unreadable check runs"
}

# e2e_commit REPO REF: the newest commit on REF's first-parent history (at most 500 back) whose change to its
# first parent touches E2E_PATHS: the commit whose ops end-to-end decides whether REF may deploy. Prints nothing
# when none is found.
e2e_commit() {
  local c
  for c in $(git -C "$1" rev-list --first-parent --max-count=500 "$2"); do
    if git -C "$1" rev-parse --verify --quiet "$c^1" >/dev/null; then
      git -C "$1" diff --quiet "$c^1" "$c" -- "${E2E_PATHS[@]}" || { printf '%s\n' "$c"; return 0; }
    elif [ -n "$(git -C "$1" ls-tree -r --name-only "$c" -- "${E2E_PATHS[@]}")" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
}

# prunable_releases ROOT CURRENT PREV TAG_COMMIT: release folders under ROOT that may go (HOST-CAPS), one per line.
# Kept: the current release, the one before it (the roll-back target), the deploy tag's commit, the 3 newest others
# and anything that is not a 40-hex commit folder (half-written *.new and strays are never listed). No age rule.
# Fails closed: when CURRENT is not a folder under ROOT, nothing goes.
# Each release is a full copy of the repository (about 68 MB), and every update adds one.
prunable_releases() {
  local root="${1%/}" cur="$2" prev="$3" tag="$4" d i=0
  [ -n "$cur" ] && [ -d "$cur" ] && [ "$(dirname "$cur")" = "$root" ] || return 0
  while IFS= read -r d; do
    [[ "${d##*/}" =~ ^[0-9a-f]{40}$ ]] || continue
    [ "$d" != "$cur" ] && [ "$d" != "$prev" ] && [ "$d" != "$root/$tag" ] || continue
    i=$((i + 1))
    [ "$i" -gt 3 ] || continue
    printf '%s\n' "$d"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d ! -name '*.new' -printf '%T@ %p\n' 2>/dev/null | LC_ALL=C sort -rn | cut -d' ' -f2-)
}

# PATHS-FIX ruling 23: the pull account's own filesystem and its two chroot binds.
PULL_MOUNT_UNITS=(zeroed-receipts-fs.service srv-zeroed_pull-md.mount srv-zeroed_pull-md-receipts.mount)

# pull_mount_alerts UNIT...: reads `systemctl is-active UNIT...` on stdin (one state per line, in the same order) and
# prints "on|pull-mounts|TEXT" naming each unit that is not active, or "off|pull-mounts|TEXT" when all are. A missing
# line counts as not active.
pull_mount_alerts() {
  local u s down=()
  for u in "$@"; do
    IFS= read -r s || s=unknown
    [ "$s" = active ] || down+=("$u ${s:-unknown}")
  done
  if [ "${#down[@]}" -gt 0 ]; then
    printf 'on|pull-mounts|ALERT Zeroed host: the market-data pull folders are not all mounted (%s). Pulls and receipts stop until they are.\n' "$(IFS=,; printf '%s' "${down[*]}" | sed 's/,/, /g')"
  else
    printf 'off|pull-mounts|CLEARED Zeroed host: the market-data pull folders are mounted again.\n'
  fi
}

# recorder_first_seen NOW RECORDER STAMP: the time RECORDER was first seen, kept in STAMP (written once, by
# zeroed-check). Prints it, or nothing while RECORDER does not exist (STAMP is then removed, so a folder that comes
# back starts a new hold). A STAMP that is not a time is written again; if that write fails nothing is printed. The
# folder's own mtime is never used: it moves whenever a boot folder is added or removed.
recorder_first_seen() {
  if [ ! -e "$2" ]; then rm -f "$3"; return 0; fi
  local t
  t="$(head -c 32 "$3" 2>/dev/null || true)"
  if ! [[ "$t" =~ ^[0-9]{1,12}$ ]]; then
    t="$1"
    # Ruling 13: a stamp that could not be written is never trusted; nothing is printed, which counts as old (alert).
    { printf '%s\n' "$t" > "$3.new" && mv -f "$3.new" "$3"; } 2>/dev/null || { rm -f "$3.new" 2>/dev/null; return 0; }
  fi
  printf '%s\n' "$t"
}

# record_alerts NOW: reads the recording uploader's status.json (RECORD-UPLOAD; it runs as the worker's user, so its
# alerts are raised here) on stdin and prints one "on|KEY|TEXT" or "off|KEY|TEXT" line per alert: 3 failed runs in a
# row, recordings waiting longer than a day, files kept back from upload, no status for 3 hours. {"enabled":false}
# (the switch is off) clears them all. RC-M5: with the switch on, a status with no report time (none written: '{}', the
# uploader never ran) raises the no-report alert and leaves the others as they are; it never clears them. Input that
# is not JSON prints nothing, so every alert keeps its state. REC-UPLOAD-QUIET: with RECORDER given (zeroed-check passes
# the upload unit's ConditionPathExists path) and nothing there, the unit is skipped and never writes a status, so the
# status is read as {"enabled":false}: every alert is cleared, none raised. Once RECORDER exists, the above applies,
# except that the no-report alert waits until 70 minutes after SEEN, the time zeroed-check first saw RECORDER
# (recorder_first_seen; the upload timer's first run is 10 minutes after boot or switch-on, the next an hour after a
# run ends): until then it prints nothing, so no alert changes. No SEEN, or a SEEN in the future, counts as old.
record_alerts() {
  local status young=false
  status="$(cat)"
  if [ -n "${2:-}" ] && [ ! -e "$2" ]; then status='{"enabled":false}'; fi
  if [ -n "${2:-}" ] && [ -e "$2" ] && [[ "${3:-}" =~ ^[0-9]{1,12}$ ]] && [ "$1" -ge "$3" ] && [ $(($1 - $3)) -lt 4200 ]; then young=true; fi
  printf '%s' "$status" | jq -r --argjson now "$1" --argjson young "$young" '
    def clean: tostring | gsub("[\r\n|]"; " ") | .[0:300];
    if .enabled != false and (.at | type) != "number" then
      if $young then empty else
      "on|record-upload-stale|ALERT Zeroed host: the recording upload is on but has never reported (no status written). Recordings may be deleted at the disk cap without being uploaded." end
    else
    (.enabled != false) as $on
    | (((.failed_runs // 0) - (if .running == true then 1 else 0 end))) as $failed
    | (.kept // []) as $kept
    | [
        (if $on and $failed >= 3
         then "on|record-upload-failed|ALERT Zeroed host: the recording upload failed \($failed) runs in a row (last: \(.last_error // "unknown" | clean)). Recordings stay on the server until it works again."
         else "off|record-upload-failed|CLEARED Zeroed host: the recording upload works again." end),
        (if $on and (.backlog_age_s // 0) > 86400
         then "on|record-upload-backlog|ALERT Zeroed host: recordings older than a day are still waiting to upload (\(.pending // 0) files). Their disk space is not freed until they are up."
         else "off|record-upload-backlog|CLEARED Zeroed host: no recording waits longer than a day to upload." end),
        (if $on and ($kept | length) > 0
         then "on|record-upload-kept|ALERT Zeroed host: \($kept | length) recording file(s) kept on the server, not uploaded: \([$kept[0:5][] | "\(.key // "?") (\(.why // "?"))"] | join(", ") | clean)."
         else "off|record-upload-kept|CLEARED Zeroed host: no recording file is kept back from upload." end),
        (if $on and ($now - (.at / 1000)) > 10800
         then "on|record-upload-stale|ALERT Zeroed host: the recording upload has not reported for over 3 hours."
         else "off|record-upload-stale|CLEARED Zeroed host: the recording upload reports again." end)
      ] | .[] end' 2>/dev/null || true
}
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/receipts-fs 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# PATHS-FIX ruling 20: the pull receipts live on their own small filesystem, so the pull account can never fill the
# host's disk or run it out of inodes: a 64 MiB ext4 image with 1 KiB blocks and 32,768 inodes, loop-mounted at
# /var/lib/zeroed-md/receipts. Measured: 32,757 receipt files fit, then every write fails with "No space left on
# device" (fails closed: a segment without a receipt is only kept longer). The image is preallocated: it always
# takes 64 MiB of the server's disk, counted in the disk budget. At the recorder's 30-day retention that is
# room for about 45 streams an hour (the stream count is UNVERIFIED). The image is root-only and outside every bot path.
# Run by zeroed-receipts-fs.service: "start" checks, makes (once) and mounts it; "stop" unmounts it.
set -euo pipefail
IMG_DIR=/var/lib/zeroed-receipts
IMG="$IMG_DIR/receipts.img"
MNT=/var/lib/zeroed-md/receipts
SIZE=64M
INODES=32768

case "${1:-}" in
  start)
    mountpoint -q "$MNT" && exit 0
    install -d -m 0700 -o root -g root "$IMG_DIR"
    if [ ! -s "$IMG" ]; then
      # Ruling 26: the whole 64 MiB is allocated now (fallocate, and mkfs without discard, which would free it again),
      # so the image always takes exactly its budgeted space and can never fail later for lack of disk.
      fallocate -l "$SIZE" "$IMG.new"
      mkfs.ext4 -q -F -E nodiscard -b 1024 -I 256 -N "$INODES" -m 0 -L zreceipts "$IMG.new"
      chmod 0600 "$IMG.new"
      mv -f "$IMG.new" "$IMG"
    fi
    # Repairs what is safe to repair; anything worse stops here and the mount stays off (zeroed-check alerts).
    rc=0; e2fsck -p "$IMG" >/dev/null || rc=$?
    [ "$rc" -le 1 ] || { echo "receipts filesystem needs a manual check (e2fsck exit $rc)"; exit 1; }
    install -d -m 2770 -o zeroed-worker -g zeroed-pull "$MNT"
    mount -o loop,nodev,nosuid,noexec "$IMG" "$MNT"
    chown zeroed-worker:zeroed-pull "$MNT"
    chmod 2770 "$MNT"
    rmdir "$MNT/lost+found" 2>/dev/null || true
    ;;
  stop)
    if mountpoint -q "$MNT"; then umount "$MNT"; fi
    ;;
  *) echo "Usage: receipts-fs start|stop" >&2; exit 2 ;;
esac
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/record-upload.mjs 0644 <<'__ZEROED_FILE__'
// RECORD-UPLOAD (owner, 2026-10-06: "Approve upload"; "Okay yes delete after upload"). Uploads the recorder's sealed files
// (public market data and the bot's own decisions; never keys, tokens, wallet or personal data) through the watchdog's
// signed POST /record to GitHub Release assets in the private data repository, one prerelease per UTC day (rec-YYYY-MM-DD,
// overflow rec-YYYY-MM-DD.N past 900 assets), and deletes a local frames or releases file only after its uploaded copy
// is read back with the same sha256 and size and the day's signed index lists it.
//   What goes: per boot, frames-NNN and releases-NNN (.jsonl.zst, listed with sha256 in the boot's manifest),
//   and once the boot has ended its manifest.json, its saved-state attachment and its packed gaps; per ended UTC day, that day's
//   journal lines (journal-YYYY-MM-DD.jsonl.zst) and index-N.json. Never raw, delays or plain .jsonl files.
//   What is deleted (only with "record_upload_delete_local": true): frames and releases files of ended boots, each
//   checked again just before (see deleteFile). Never a manifest, a saved state, the journal, raw or delays files.
// Runs as the worker's user (zeroed-record-upload@.service: no capabilities, the recorder its only writable data path),
// one file at a time, oldest first, at 2 MB/s. Node built-ins only; curl sends the body with its headers on stdin.
//   node record-upload.mjs --scope all|YYYY-MM-DD
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';

/** The worker's redaction patterns, kept identical to packages/worker/src/run/redact.ts (a test compares them). */
export const PATTERNS = [
  /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token)=)[^&\s"'\\]+/gi,
  /(\.alchemy\.com\/v2\/)[^\s"'\\/?#]+/gi,
  /(\/bot)\d+:[A-Za-z0-9_-]+/g,
];
const MARK = '[redacted]';
/** The credentials the worker holds, so the only ones its recordings could carry. */
export const CREDENTIALS = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id', 'heartbeat_hmac_key'];

export const DEFAULTS = {
  root: '/var/lib/zeroed/recorder',
  journal: '/var/lib/zeroed/journal.jsonl',
  stateDir: '/var/lib/zeroed-record-upload',
  hostConfig: '/opt/zeroed/current/ops/host-config.json',
};
/** A boot (or an open boot's file) unchanged this long counts as settled. */
export const QUIET_MS = 15 * 60_000;
/** The watchdog's body cap (the free plan allows 100 MB). */
export const MAX_BYTES = 95_000_000;
/** GitHub allows 1000 assets per release; past this many the day moves to its next overflow release. */
export const RELEASE_ASSETS = 900;
/** GitHub's secondary limit is 500 content writes an hour; a run stays well under it. */
export const MAX_UPLOADS_PER_RUN = 300;
/** A day's journal is uploaded once the day has ended and this much more has passed. */
const JOURNAL_GRACE_MS = 10 * 60_000;
const STOP_AFTER_FAILURES = 3;
const TAKEN = 'a different file has this name in the data repository';
const BOOT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATA_RE = /^days\/(\d{4}-\d{2}-\d{2})\/((?:frames|releases)-\d{3}\.jsonl\.zst)$/;
const ATTACHMENTS = new Set(['deployer-state.json', 'deployer-state.json.zst']);
// RC-H3: the recorder's packed stream-gap chunks (gaps-NNN.jsonl.zst) go up with the manifest, like the saved state.
const GAPS_ATTACHMENT = /^gaps-\d{3,6}\.jsonl\.zst$/;
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isBytes = (n) => Number.isSafeInteger(n) && n > 0;
/** True for "no such file": RECORD-BUDGET deletes recordings on its own schedule, so any file may vanish mid-run. */
const isGone = (e) => e?.code === 'ENOENT';
/** Recorder files (not the uploader's own journal and index copies): one that vanishes is reported once. */
const RECORDER_KINDS = new Set(['data', 'manifest', 'attachment']);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayEnd = (day) => Date.parse(`${day}T00:00:00Z`) + 86_400_000;

/** The boot's start time from its id (`<ms in base 36>-<pid>`), or null. */
export const bootTime = (boot) => {
  const m = /^([0-9a-z]{1,12})-\d{1,10}$/.exec(boot);
  const t = m ? parseInt(m[1], 36) : Number.NaN;
  return t > 1.5e12 && t < 4.1e12 ? t : null;
};

export const hashFile = async (path) => {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const c of createReadStream(path)) {
    h.update(c);
    bytes += c.length;
  }
  return { sha256: h.digest('hex'), bytes };
};

/** A reason (never the value) when the text holds a stored credential or a credential-shaped value not already redacted. */
export const hitIn = (text, values) => {
  for (const v of values) if (text.includes(v)) return 'a stored credential';
  for (const p of PATTERNS) for (const m of text.matchAll(p)) if (m[0].slice(m[1].length) !== MARK) return 'a credential-shaped value';
  return null;
};

const CARRY_MAX = 8 * 1024 * 1024;

/**
 * Streams the file (decompressed when .zst) through hitIn. Pieces end at a newline or a double quote, which no pattern
 * match and no credential value contains, so a split never hides one; memory stays flat. Null when clean.
 */
export const scanFile = async (path, values) => {
  const cuts = values.some((v) => v.includes('"')) ? ['\n'] : ['\n', '"'];
  const src = createReadStream(path);
  const dec = path.endsWith('.zst') ? createZstdDecompress() : null;
  // Not pipeline(): it may close the decompressor before its last output is read. A read error ends the loop below.
  if (dec) src.on('error', (e) => dec.destroy(e));
  const stream = dec ? src.pipe(dec) : src;
  const td = new TextDecoder('utf-8');
  let carry = '';
  let hit = null;
  try {
    for await (const chunk of stream) {
      const text = carry + td.decode(chunk, { stream: true });
      const cut = Math.max(...cuts.map((c) => text.lastIndexOf(c)));
      if (cut === -1) {
        carry = text;
        if (carry.length > CARRY_MAX) return 'a run of text too long to check';
        continue;
      }
      hit = hitIn(text.slice(0, cut + 1), values);
      if (hit) return hit;
      carry = text.slice(cut + 1);
    }
    return hitIn(carry + td.decode(), values);
  } finally {
    src.destroy();
    dec?.destroy();
  }
};

/** Written to a temporary file, flushed to disk, renamed over the old one, and the folder flushed too. */
export const writeAtomic = (path, text) => {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const d = openSync(dirname(path), 'r');
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
};

const freshState = () => ({ v: 1, files: {}, shared: {}, shared_done: {}, done_boots: {}, releases: {}, journal: { offset: 0, days: {}, pending: null }, index: {}, failed_runs: 0 });
/** A day's file records move out of state.json into their own file once the day is finished and this much older. */
export const ARCHIVE_AFTER_MS = 2 * 86_400_000;

/** The saved state; a missing or unreadable one starts fresh (GitHub is the record: names that exist are matched again). */
export const loadState = (dir) => {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    if (s && s.v === 1 && typeof s.files === 'object') return { ...freshState(), ...s, journal: { ...freshState().journal, ...s.journal } };
  } catch {}
  return freshState();
};

/** The boot of the journal's last start line, read back from the end in pieces (the journal is never read whole). */
export const lastStartBoot = (path) => {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    let pos = fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    while (pos > 0) {
      const n = Math.min(1 << 20, pos);
      pos -= n;
      const b = Buffer.alloc(n);
      readSync(fd, b, 0, n, pos);
      tail = Buffer.concat([b, tail]);
      const first = pos === 0 ? 0 : tail.indexOf(0x0a) + 1;
      if (first === 0 && pos > 0) continue;
      const lines = tail.subarray(first).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!/"kind"\s*:\s*"start"/.test(lines[i])) continue;
        try {
          const j = JSON.parse(lines[i]);
          if (j.kind === 'start' && typeof j.boot === 'string') return j.boot;
        } catch {}
      }
      tail = tail.subarray(0, first);
    }
    return null;
  } finally {
    closeSync(fd);
  }
};

/** True unless systemd says the worker is inactive or failed (no answer counts as running). */
export const systemWorkerActive = () =>
  new Promise((resolve) => {
    execFile('systemctl', ['is-active', 'zeroed-worker.service'], { timeout: 30_000 }, (_e, out) => {
      const s = String(out ?? '').trim();
      resolve(!(s === 'inactive' || s === 'failed'));
    });
  });

/** Walks a boot folder: settled when no plain .jsonl, no .tmp and no link is in it and nothing changed for QUIET_MS. */
export const settled = (dir, now) => {
  let newest = 0;
  const walk = (d) => {
    const st = lstatSync(d);
    newest = Math.max(newest, st.mtimeMs);
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) return 'a link';
      if (name.endsWith('.jsonl') || name.endsWith('.tmp')) return 'an open file';
      if (s.isDirectory()) {
        const w = walk(p);
        if (w) return w;
      } else {
        newest = Math.max(newest, s.mtimeMs);
      }
    }
    return null;
  };
  const why = walk(dir);
  if (why) return why;
  return now - newest < QUIET_MS ? 'changed in the last 15 minutes' : null;
};

/**
 * The recorder's boot folders, oldest first, each with its manifest and whether it is open: the running boot (the
 * journal's last start), the newest folder while the worker runs, and any folder not settled. An open boot's sealed
 * files are uploaded (they never change once sealed), but nothing in it is ever deleted.
 */
export const readBoots = async (cfg, now, workerActive, skip = new Set()) => {
  if (!existsSync(cfg.root)) return [];
  const boots = [];
  for (const name of readdirSync(cfg.root)) {
    if (!BOOT_RE.test(name) || name === 'saved-state' || skip.has(name)) continue;
    const dir = join(cfg.root, name);
    let manifest = null;
    let mtime = 0;
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      const mp = join(dir, 'manifest.json');
      const st = lstatSync(mp);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
      manifest = JSON.parse(readFileSync(mp, 'utf8'));
    } catch {
      continue;
    }
    if (manifest?.boot !== name || manifest.source !== 'live-recorder' || !Array.isArray(manifest.days)) continue;
    boots.push({ boot: name, dir, manifest, time: bootTime(name) ?? mtime });
  }
  boots.sort((a, b) => a.time - b.time || (a.boot < b.boot ? -1 : 1));
  const running = await runningBoots(cfg, boots, workerActive);
  for (const b of boots) {
    let why;
    try {
      why = running.has(b.boot) ? 'the running boot' : settled(b.dir, now);
    } catch (e) {
      if (!isGone(e)) throw e;
      // A file went while the folder was walked: open for this run (its sealed files still go up, nothing is deleted).
      why = 'a file went while it was listed';
    }
    b.open = why !== null;
    b.why = why;
  }
  return boots;
};

/** The boots that may still be written: the journal's last start, and the newest folder while the worker is up. */
const runningBoots = async (cfg, boots, workerActive) => {
  const out = new Set();
  const started = lastStartBoot(cfg.journal);
  if (started) out.add(started);
  if (boots.length > 0 && (await workerActive())) out.add(boots[boots.length - 1].boot);
  return out;
};

const firstDay = (b) => {
  const days = b.manifest.days.map((d) => d.day).filter((d) => typeof d === 'string' && DAY_RE.test(d)).sort();
  const t = bootTime(b.boot);
  return days[0] ?? (t === null ? null : dayOf(t));
};

/** What one boot contributes: its listed frames and releases files; once ended, its manifest, saved-state attachment and packed gaps. */
export const itemsOf = (b) => {
  const items = [];
  for (const d of b.manifest.days) {
    for (const f of Array.isArray(d?.files) ? d.files : []) {
      const m = DATA_RE.exec(f?.path ?? '');
      if (!m || m[1] !== d.day || !isSha(f.sha256) || !isBytes(f.bytes)) continue;
      items.push({ key: `${b.boot}/${f.path}`, kind: 'data', boot: b.boot, day: d.day, path: join(b.dir, f.path), rel: f.path, file: m[2], size: f.bytes, sha256: f.sha256, open: b.open });
    }
  }
  const day = firstDay(b);
  if (!b.open && day !== null) {
    items.push({ key: `${b.boot}/manifest.json`, kind: 'manifest', boot: b.boot, day, path: join(b.dir, 'manifest.json'), rel: 'manifest.json', file: 'manifest.json', size: null, sha256: null, open: false });
    for (const a of Array.isArray(b.manifest.attachments) ? b.manifest.attachments : []) {
      if (!(ATTACHMENTS.has(a?.file) || GAPS_ATTACHMENT.test(a?.file ?? '')) || !isSha(a.sha256) || !isBytes(a.bytes)) continue;
      items.push({ key: `${b.boot}/${a.file}`, kind: 'attachment', boot: b.boot, day, path: join(b.dir, a.file), rel: a.file, file: a.file, size: a.bytes, sha256: a.sha256, open: false });
    }
  }
  return items;
};

/**
 * A journal line as uploaded: a refused Telegram command's own text (typed by a person, so possibly personal) is replaced
 * with "[redacted]"; an unreadable line naming a refused command is left out. Every other line goes byte for byte.
 */
export const scrubJournalLine = (line) => {
  if (!line.includes('command_refused')) return line;
  try {
    const j = JSON.parse(line.toString('utf8'));
    if (j?.action !== 'command_refused' || !Array.isArray(j.reasons)) return line;
    j.reasons = j.reasons.map((r) => (typeof r === 'string' && /^command [\s\S]* refused$/.test(r) ? 'command [redacted] refused' : r));
    return Buffer.from(`${JSON.stringify(j)}\n`);
  } catch {
    return Buffer.alloc(0);
  }
};

/** The signed header for one request: the watchdog checks "t\nRECORD\n/record\n<header>" with the heartbeat key. */
export const signHeader = (key, fields, nowS) => {
  const text = JSON.stringify({ v: 1, op: fields.op, t: nowS, nonce: randomBytes(16).toString('hex'), day: fields.day, release: fields.release, boot: fields.boot, file: fields.file, size: fields.size, sha256: fields.sha256, ...(fields.op === 'check' ? { asset_id: fields.asset_id } : {}) });
  const sig = createHmac('sha256', key).update(`${nowS}\nRECORD\n/record\n${text}`).digest('hex');
  return { text, signature: `t=${nowS},v1=${sig}` };
};

/** The index's last line: an HMAC with the heartbeat key over "RECORD-INDEX\n<body>". */
export const signIndex = (key, body) => `${body}\nhmac-sha256=${createHmac('sha256', key).update(`RECORD-INDEX\n${body}`).digest('hex')}\n`;

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The real transport: curl for an upload (config and headers on stdin, never in argv), fetch for a read-back. */
export const watchdogTransport = (url, curl = 'curl') => ({
  put: (h, path, size) =>
    new Promise((resolve) => {
      const conf = [
        `url = ${quote(`${url}/record`)}`, 'request = "POST"', `upload-file = ${quote(path)}`,
        `header = ${quote(`x-zeroed-record: ${h.text}`)}`, `header = ${quote(`x-zeroed-signature: ${h.signature}`)}`,
        'header = "content-type: application/octet-stream"', 'header = "expect:"', 'limit-rate = 2M', 'connect-timeout = 30',
        `max-time = ${Math.ceil(size / 2_000_000) + 300}`, 'silent', 'show-error', 'write-out = "\\n%{http_code}"',
      ].join('\n');
      const c = spawn(curl, ['-K', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (err += d));
      c.on('error', () => resolve({ status: 0, json: null, error: 'curl did not start' }));
      c.on('close', (code) => {
        const nl = out.lastIndexOf('\n');
        const status = Number(out.slice(nl + 1));
        let json = null;
        try {
          json = JSON.parse(out.slice(0, nl));
        } catch {}
        resolve({ status: Number.isInteger(status) ? status : 0, json, ...(code === 0 ? {} : { error: `curl exit ${code}: ${err.trim().slice(0, 200)}` }) });
      });
      c.stdin.end(`${conf}\n`);
    }),
  check: async (h) => {
    try {
      const res = await fetch(`${url}/record`, { method: 'POST', headers: { 'x-zeroed-record': h.text, 'x-zeroed-signature': h.signature }, signal: AbortSignal.timeout(60_000) });
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch {
      return { status: 0, json: null, error: 'the watchdog did not answer' };
    }
  },
});

export class Uploader {
  /**
   * cfg: { root, journal, stateDir, key, values, deleteLocal, scope ('all' | day) }.
   * deps: { transport: { put, check }, workerActive: () => Promise<boolean>, now: () => ms, log }.
   */
  constructor(cfg, deps) {
    this.cfg = cfg;
    this.d = deps;
    this.state = loadState(cfg.stateDir);
    this.kept = [];
    this.failures = 0;
    this.inARow = 0;
    this.uploads = 0;
    this.counts = { uploaded: 0, verified: 0, deleted: 0, freed_bytes: 0, vanished: 0 };
    this.vanishedFiles = [];
    this.bootItems = new Map();
    this.lastError = null;
    this.stopped = false;
    this.lastStatus = 0;
    mkdirSync(join(cfg.stateDir, 'tmp'), { recursive: true });
  }

  save() {
    writeAtomic(join(this.cfg.stateDir, 'state.json'), `${JSON.stringify(this.state)}\n`);
  }

  status(extra) {
    writeAtomic(join(this.cfg.stateDir, 'status.json'), `${JSON.stringify({ v: 1, at: this.d.now(), scope: this.cfg.scope, delete_local: this.cfg.deleteLocal, failed_runs: this.state.failed_runs, ...this.counts, vanished_files: this.vanishedFiles, kept: this.kept, last_error: this.lastError, ...extra })}\n`);
  }

  /** The status file, at most once a minute during a run, so a long first run never looks stalled. */
  tick() {
    if (this.d.now() - this.lastStatus < 60_000) return;
    this.lastStatus = this.d.now();
    this.status({ running: true });
  }

  fail(what) {
    this.failures++;
    this.inARow++;
    this.lastError = what;
    this.d.log(`Not uploaded: ${what}.`);
    if (this.inARow >= STOP_AFTER_FAILURES) this.stopped = true;
  }

  keep(key, why) {
    this.kept.push({ key, why });
    this.d.log(`Kept on the server, not uploaded: ${key} (${why}).`);
  }

  /**
   * A listed file that is no longer on the server (deleted before it was sent): skipped, counted and reported, never a
   * failure, and the run goes on. A recorder file is marked in the state so it is reported once and not tried again; an
   * asset sent earlier but not yet confirmed is still read back on later runs.
   */
  vanish(it) {
    const files = this.state.files;
    if (files[it.key]?.vanished_at) return;
    if (RECORDER_KINDS.has(it.kind)) {
      files[it.key] = { ...(files[it.key] ?? { day: it.day, boot: it.boot, path: it.rel }), vanished_at: this.d.now(), listed: { sha256: it.sha256, bytes: it.size } };
      this.save();
    }
    this.counts.vanished++;
    this.vanishedFiles.push(it.key);
    this.d.log(`Vanished before upload: ${it.key}.`);
  }

  release(day) {
    const r = (this.state.releases[day] ??= { n: 0, count: 0 });
    if (r.count >= RELEASE_ASSETS && r.n < 99) {
      r.n++;
      r.count = 0;
    }
    return r.n === 0 ? `rec-${day}` : `rec-${day}.${r.n}`;
  }

  /** Reads an asset back by id through the watchdog; true only for exactly these bytes, finished, under this name. */
  async verify(rec, it) {
    const h = signHeader(this.cfg.key, { op: 'check', day: it.day, release: rec.release, boot: it.boot, file: it.file, size: rec.size, sha256: rec.sha256, asset_id: rec.asset_id }, Math.floor(this.d.now() / 1000));
    const r = await this.d.transport.check(h);
    const j = r.json ?? {};
    return r.status === 200 && j.ok === true && j.match === true && j.asset_id === rec.asset_id && j.size === rec.size && j.digest === `sha256:${rec.sha256}` && j.state === 'uploaded';
  }

  /** One file: checked, scanned, hashed again, sent, read back. The state is saved after every step that changes it. */
  async upload(it) {
    const files = this.state.files;
    const rec = files[it.key];
    if (rec?.verified || rec?.deleted_at) return;
    if (rec?.asset_id) {
      // Sent before but not confirmed (no digest yet, or the read-back did not answer): read it back again.
      if (await this.verify(rec, it)) {
        rec.verified = true;
        this.counts.verified++;
        this.inARow = 0;
        this.save();
        return;
      }
    }
    if (rec?.vanished_at || this.uploads >= MAX_UPLOADS_PER_RUN) return;
    if (it.kind === 'manifest' && !this.manifestFinal(it.boot)) return;
    try {
      await this.send(it);
    } catch (e) {
      if (!isGone(e)) throw e;
      this.vanish(it);
    }
  }

  /**
   * A boot's manifest goes up once, and its copy can never be replaced: only after every frames and releases file it
   * lists is confirmed upstream or recorded as vanished, so the copy is final (RECORD-BUDGET's notes included).
   */
  manifestFinal(boot) {
    const b = this.bootItems.get(boot) ?? [];
    return b.every((i) => i.kind !== 'data' || this.state.files[i.key]?.verified === true || this.state.files[i.key]?.vanished_at !== undefined);
  }

  /** upload()'s checks and sends; a file that vanishes at any step throws ENOENT, which upload() reports. */
  async send(it) {
    const files = this.state.files;
    const rec = files[it.key];
    const st = lstatSync(it.path);
    if (!st.isFile()) return this.keep(it.key, 'not a plain file');
    if (it.open && this.d.now() - st.mtimeMs < QUIET_MS) return;
    if (st.size > MAX_BYTES) return this.keep(it.key, 'over 95 MB');
    if (it.sha256 !== null && st.size !== it.size) return this.keep(it.key, 'size differs from its manifest');
    const before = await hashFile(it.path);
    if (it.sha256 !== null && (before.sha256 !== it.sha256 || before.bytes !== it.size)) return this.keep(it.key, 'bytes differ from its manifest');
    let hit;
    try {
      hit = await scanFile(it.path, this.cfg.values);
    } catch (e) {
      if (isGone(e)) throw e;
      hit = 'unreadable text';
    }
    if (hit) return this.keep(it.key, `holds ${hit}`);
    // Hashed again just before sending: the watchdog keeps the asset only if GitHub's digest equals this.
    const h0 = await hashFile(it.path);
    if (h0.sha256 !== before.sha256 || h0.bytes !== before.bytes) return this.fail(`${it.key}: changed while it was checked`);
    const sref = this.state.shared[h0.sha256];
    const shared = it.kind === 'attachment' ? (files[sref] ?? this.state.shared_done[h0.sha256]) : undefined;
    if (shared?.verified) {
      // The same saved state is already up (an earlier boot restored the same bytes): listed, never sent twice.
      files[it.key] = { day: it.day, boot: it.boot, path: it.rel, release: shared.release, asset: shared.asset, asset_id: shared.asset_id, size: shared.size, sha256: shared.sha256, verified: true, ref: sref };
      this.save();
      return;
    }
    const release = rec?.release ?? this.release(it.day);
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = signHeader(this.cfg.key, { op: 'put', day: it.day, release, boot: it.boot, file: it.file, size: h0.bytes, sha256: h0.sha256 }, Math.floor(this.d.now() / 1000));
      this.uploads++;
      const r = await this.d.transport.put(h, it.path, h0.bytes);
      const j = r.json ?? {};
      if (r.status === 200 && j.ok === true && Number.isSafeInteger(j.asset_id)) {
        const next = { day: it.day, boot: it.boot, path: it.rel, release, asset: j.name, asset_id: j.asset_id, size: h0.bytes, sha256: h0.sha256, verified: false };
        files[it.key] = next;
        const r0 = (this.state.releases[it.day] ??= { n: 0, count: 0 });
        if (!j.existed && release === (r0.n === 0 ? `rec-${it.day}` : `rec-${it.day}.${r0.n}`)) r0.count++;
        this.counts.uploaded++;
        this.save();
        // Never the upload's reply: a fresh read-back by id decides.
        if (await this.verify(next, it)) {
          next.verified = true;
          this.counts.verified++;
          if (it.kind === 'attachment') this.state.shared[h0.sha256] ??= it.key;
          this.inARow = 0;
          this.save();
        } else {
          this.fail(`${it.key}: uploaded, but the read-back did not confirm it`);
        }
        return;
      }
      if (r.status === 503 && j.retry === true) continue;
      if (r.status === 409 && j.error === 'replayed request') continue;
      if (r.status === 409) return this.keep(it.key, TAKEN);
      if (Number.isSafeInteger(j.asset_id)) {
        files[it.key] = { day: it.day, boot: it.boot, path: it.rel, release, asset: j.name ?? null, asset_id: j.asset_id, size: h0.bytes, sha256: h0.sha256, verified: false };
        this.save();
      }
      // curl could not read a file deleted while it was sent: that is a vanish, not a failure.
      if (!existsSync(it.path)) return this.vanish(it);
      return this.fail(`${it.key}: HTTP ${r.status}${typeof j.error === 'string' ? ` (${j.error})` : ''}${r.error ? ` (${r.error})` : ''}`);
    }
    this.fail(`${it.key}: the watchdog asked to send again three times`);
  }

  /**
   * Each ended UTC day's journal lines as journal-YYYY-MM-DD.jsonl.zst, read forward from the saved offset. A line goes
   * to the later of its own day and the day being collected, so every line is sent exactly once, in order.
   */
  async journalDays() {
    const j = this.state.journal;
    const path = this.cfg.journal;
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < j.offset) {
      this.d.log('The journal is shorter than the saved offset; reading it again from the start (days already up are skipped).');
      j.offset = 0;
      j.pending = null;
    }
    while (!this.stopped && this.uploads < MAX_UPLOADS_PER_RUN) {
      const group = j.pending && existsSync(this.journalTmp(j.pending.day)) ? j.pending : await this.collectDay(j.offset);
      if (group === null) return;
      if (!j.days[group.day]) {
        j.pending = group;
        this.save();
        const it = { key: `journal/${group.day}`, kind: 'journal', boot: null, day: group.day, path: this.journalTmp(group.day), rel: `journal-${group.day}.jsonl.zst`, file: `journal-${group.day}.jsonl.zst`, size: group.size, sha256: group.sha256, open: false };
        await this.upload(it);
        if (!this.state.files[it.key]?.verified) return;
        j.days[group.day] = true;
      }
      j.offset = group.end;
      j.pending = null;
      rmSync(this.journalTmp(group.day), { force: true });
      this.save();
    }
  }

  journalTmp(day) {
    return join(this.cfg.stateDir, 'tmp', `journal-${day}.jsonl.zst`);
  }

  /** The first ended day from offset on, compressed to the temporary folder; null when the day there has not ended. */
  async collectDay(offset) {
    const now = this.d.now();
    const lines = createReadStream(this.cfg.journal, { start: offset });
    let pos = offset;
    let rest = Buffer.alloc(0);
    let day = null;
    let end = null;
    const self = this;
    const isDone = (d) => d !== null && now >= dayEnd(d) + JOURNAL_GRACE_MS;
    async function* group() {
      for await (const chunk of lines) {
        let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let i;
        while ((i = buf.indexOf(0x0a)) !== -1) {
          const line = buf.subarray(0, i + 1);
          const m = /"ts":"(\d{4}-\d{2}-\d{2})T/.exec(line.subarray(0, 200).toString('latin1'));
          const lineDay = m ? m[1] : day;
          const d = day === null ? lineDay : lineDay !== null && lineDay > day ? lineDay : day;
          if (day !== null && d !== day) {
            end = pos;
            return;
          }
          if (day === null && d !== null) {
            day = d;
            if (!isDone(day)) return;
          }
          yield scrubJournalLine(line);
          pos += line.length;
          buf = buf.subarray(i + 1);
        }
        rest = Buffer.from(buf);
      }
      // End of the file: the day is complete only once it has ended (a torn last line is never sent).
      if (day !== null && isDone(day)) end = pos;
    }
    const tmp = join(self.cfg.stateDir, 'tmp', 'journal.part');
    await pipeline(group, createZstdCompress(), createWriteStream(tmp, { mode: 0o600 }));
    lines.destroy();
    if (day === null || end === null || !isDone(day) || end === offset) {
      rmSync(tmp, { force: true });
      return null;
    }
    renameSync(tmp, this.journalTmp(day));
    const h = await hashFile(this.journalTmp(day));
    return { day, end, sha256: h.sha256, size: h.bytes };
  }

  /** index-N.json for a day once its uploaded set changed: every confirmed file with its asset and sha256, and the boots' manifests. */
  async index(day) {
    const st = (this.state.index[day] ??= { n: 0, hash: null, verified: false, keys: [], pending: null });
    const { entries, vanished, hash } = this.indexContent(day);
    if (entries.length === 0 && vanished.length === 0) return;
    if (st.pending === null && st.verified && st.hash === hash) return;
    // A number taken by another index (the state file was lost and numbering restarted) moves on to the next one.
    for (let tries = 0; tries < 20 && !this.stopped; tries++) {
      if ((await this.indexOnce(day, st, entries, vanished, hash)) !== 'taken') return;
    }
  }

  /** What the day's index lists: its archived records (a finished day, see prune) and those still in the state. */
  dayRecords(day) {
    const out = new Map();
    // Read whenever the file is there, not only by the flag: a day's archived records are never left out of its index.
    if (this.state.index[day]?.archived || existsSync(this.archivePath(day))) {
      const a = JSON.parse(readFileSync(this.archivePath(day), 'utf8'));
      for (const [key, r] of Object.entries(a.files)) out.set(key, r);
    }
    for (const [key, r] of Object.entries(this.state.files)) if (r.day === day && !key.startsWith('index/')) out.set(key, r);
    return out;
  }

  archivePath(day) {
    return join(this.cfg.stateDir, 'days', `${day}.json`);
  }

  indexContent(day) {
    const sorted = [...this.dayRecords(day)].sort(([a], [b]) => (a < b ? -1 : 1));
    const entries = sorted
      .filter(([, r]) => r.verified)
      .map(([key, r]) => ({ key, boot: r.boot, path: r.path, release: r.release, asset: r.asset, asset_id: r.asset_id, size: r.size, sha256: r.sha256 }));
    // Files gone from the server before they were sent (RECORD-BUDGET): named here, since the boot's manifest still lists them.
    const vanished = sorted
      .filter(([, r]) => !r.verified && r.vanished_at !== undefined)
      .map(([key, r]) => ({ key, boot: r.boot, path: r.path, sha256: r.listed?.sha256 ?? null, bytes: r.listed?.bytes ?? null, at: new Date(r.vanished_at).toISOString() }));
    // Without vanished files the hash is the one earlier versions saved, so no day is indexed again for nothing.
    const hash = createHash('sha256').update(JSON.stringify(vanished.length === 0 ? entries : { files: entries, vanished })).digest('hex');
    return { entries, vanished, hash };
  }

  /**
   * Nothing left to do for this record: confirmed upstream and, for a frames or releases file, no longer on the server
   * (deleted here, or by RECORD-BUDGET after it went up); or vanished before upload. With deletes off a frames or releases
   * file stays and so never finishes: switching deletes on later still finds every one.
   */
  finished(r) {
    if (r === undefined) return false;
    if (!r.verified) return r.vanished_at !== undefined && !r.asset_id;
    if (!DATA_RE.test(r.path ?? '') || r.deleted_at !== undefined) return true;
    try {
      lstatSync(join(this.cfg.root, r.boot, r.path));
      return false;
    } catch (e) {
      return isGone(e);
    }
  }

  /** A boot that can add no more records: marked done, or its folder is gone. */
  bootDone(boot, cache) {
    if (boot === null) return true;
    if (!cache.has(boot)) cache.set(boot, this.state.done_boots[boot] !== undefined || !existsSync(join(this.cfg.root, boot)));
    return cache.get(boot);
  }

  /**
   * Keeps state.json small (it is read whole under a 48 MB heap): a boot whose every item is finished is marked done and
   * never listed again; a day whose records are all finished, whose boots are all done, whose standing index lists exactly
   * them, and which ended ARCHIVE_AFTER_MS ago moves to days/<day>.json, read again only if that day ever gets a new record.
   */
  prune(boots) {
    const now = this.d.now();
    for (const b of boots) {
      const its = this.bootItems.get(b.boot) ?? [];
      if (!b.open && its.some((i) => i.kind === 'manifest') && its.every((i) => this.finished(this.state.files[i.key]))) this.state.done_boots[b.boot] = now;
    }
    const byDay = new Map();
    for (const [key, r] of Object.entries(this.state.files)) {
      if (key.startsWith('index/')) continue;
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push([key, r]);
    }
    const cache = new Map();
    for (const [day, recs] of byDay) {
      if (now < dayEnd(day) + ARCHIVE_AFTER_MS) continue;
      const st = this.state.index[day];
      if (!st?.verified || st.pending !== null) continue;
      if (!recs.every(([, r]) => this.finished(r) && this.bootDone(r.boot ?? null, cache))) continue;
      if (st.hash !== this.indexContent(day).hash) continue;
      mkdirSync(join(this.cfg.stateDir, 'days'), { recursive: true });
      // dayRecords holds the archive's records plus these, so the file only ever grows.
      const all = Object.fromEntries(this.dayRecords(day));
      if (existsSync(this.archivePath(day)) && Object.keys(JSON.parse(readFileSync(this.archivePath(day), 'utf8')).files).some((k) => !(k in all))) continue;
      writeAtomic(this.archivePath(day), `${JSON.stringify({ v: 1, day, files: all })}\n`);
      for (const [key, r] of recs) {
        const sha = r.sha256;
        if (sha && this.state.shared[sha] === key) {
          this.state.shared_done[sha] = { ...r, key };
          delete this.state.shared[sha];
        }
        delete this.state.files[key];
      }
      st.archived = true;
      st.keys = [];
    }
  }

  /** One try at the day's next index-N: 'taken' when GitHub already holds other bytes under that name. */
  async indexOnce(day, st, entries, vanished, hash) {
    if (st.pending === null || !existsSync(this.indexTmp(day, st.pending.n))) {
      const n = st.n + 1;
      const boots = {};
      for (const e of entries) {
        if (e.boot === null || boots[e.boot]) continue;
        try {
          boots[e.boot] = JSON.parse(readFileSync(join(this.cfg.root, e.boot, 'manifest.json'), 'utf8'));
        } catch {
          boots[e.boot] = null;
        }
      }
      const body = JSON.stringify({ v: 1, kind: 'zeroed-record-index', day, n, created: new Date(this.d.now()).toISOString(), files: entries, vanished, boots });
      writeAtomic(this.indexTmp(day, n), signIndex(this.cfg.key, body));
      const h = await hashFile(this.indexTmp(day, n));
      st.pending = { n, hash, keys: entries.map((e) => e.key), sha256: h.sha256, size: h.bytes };
      this.save();
    }
    const p = st.pending;
    const key = `index/${day}/${p.n}`;
    await this.upload({ key, kind: 'index', boot: null, day, path: this.indexTmp(day, p.n), rel: `index-${p.n}.json`, file: `index-${p.n}.json`, size: p.size, sha256: p.sha256, open: false });
    const rec = this.state.files[key];
    if (!rec?.verified) {
      const at = this.kept.findIndex((k) => k.key === key && k.why === TAKEN);
      if (at === -1) return 'not up';
      this.kept.splice(at, 1);
      this.d.log(`index-${p.n}.json for ${day} is taken by another index; trying index-${p.n + 1}.json.`);
      rmSync(this.indexTmp(day, p.n), { force: true });
      st.n = p.n;
      st.pending = null;
      this.save();
      return 'taken';
    }
    // The index is a file of its own, never an entry of another index.
    delete this.state.files[key];
    // An archived day stays archived: its file still holds records this index listed.
    this.state.index[day] = { n: p.n, hash: p.hash, verified: true, keys: p.keys, pending: null, ...(st.archived ? { archived: true } : {}), release: rec.release, asset: rec.asset, asset_id: rec.asset_id, size: rec.size, sha256: rec.sha256 };
    rmSync(this.indexTmp(day, p.n), { force: true });
    this.save();
    return 'up';
  }

  indexTmp(day, n) {
    return join(this.cfg.stateDir, 'tmp', `index-${day}-${n}.json`);
  }

  /** The day's newest index, read back now: it must still be there before anything it lists is deleted. */
  async indexStands(day) {
    const s = this.state.index[day];
    if (!s?.verified) return false;
    return this.verify(s, { day, boot: null, file: `index-${s.n}.json` });
  }

  /**
   * Deletes one frames or releases file of an ended boot, only when all hold: (1) listed with this sha256 and size in its
   * boot's manifest, read again now, and the file hashes to it now; (2) its boot is not running, checked again now; (3) a
   * plain file whose real path is inside the recorder folder; (4) GitHub's asset, read back now, has digest
   * sha256:<local>, the same size and state "uploaded"; (5) the day's signed index lists it and still stands; (6) the
   * delete is in the state file before the file goes. Anything else keeps the file.
   */
  async deleteFile(it, running) {
    const rec = this.state.files[it.key];
    if (!rec?.verified || rec.deleted_at || it.kind !== 'data') return;
    const m = DATA_RE.exec(it.rel);
    if (!m || running.has(it.boot)) return;
    if (!this.state.index[it.day]?.keys.includes(it.key)) return;
    try {
      // The recorder folder itself must be a real folder at its own path: nothing outside it is ever deleted.
      if (lstatSync(this.cfg.root).isSymbolicLink()) return;
      const root = realpathSync(this.cfg.root);
      const path = join(root, it.boot, it.rel);
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || realpathSync(path) !== path || !path.startsWith(`${root}/`)) return;
      const man = JSON.parse(readFileSync(join(root, it.boot, 'manifest.json'), 'utf8'));
      const listed = (man.days ?? []).find((d) => d?.day === m[1])?.files?.find((f) => f?.path === it.rel);
      if (!listed || listed.sha256 !== rec.sha256 || listed.bytes !== rec.size || rec.sha256 !== it.sha256) return;
      const h = await hashFile(path);
      if (h.sha256 !== rec.sha256 || h.bytes !== rec.size) return;
      if (!(await this.verify(rec, it))) return;
      rec.deleting = this.d.now();
      this.save();
      unlinkSync(path);
      rec.deleted_at = this.d.now();
      delete rec.deleting;
      this.counts.deleted++;
      this.counts.freed_bytes += h.bytes;
      this.save();
    } catch (e) {
      this.d.log(`Kept ${it.key}: ${e instanceof Error ? e.code ?? 'error' : 'error'} while checking it.`);
    }
  }

  async run() {
    const now = this.d.now();
    this.state.failed_runs++;
    this.save();
    this.status({ running: true });
    try {
      const names = new Set(existsSync(this.cfg.root) ? readdirSync(this.cfg.root) : []);
      for (const b of Object.keys(this.state.done_boots)) if (!names.has(b)) delete this.state.done_boots[b];
      // A done boot has nothing left to send or delete: never read again, so a run's work stays bounded.
      const boots = await readBoots(this.cfg, now, this.d.workerActive, new Set(Object.keys(this.state.done_boots)));
      const items = boots.flatMap(itemsOf);
      for (const i of items) this.bootItems.set(i.boot, [...(this.bootItems.get(i.boot) ?? []), i]);
      const days = [...new Set(items.map((i) => i.day))].sort().filter((d) => this.cfg.scope === 'all' || d === this.cfg.scope);
      // Manifests last: each waits until every file it lists is settled upstream (manifestFinal).
      for (const last of [false, true]) {
        for (const day of days) {
          if (this.stopped) break;
          for (const it of items.filter((i) => i.day === day && (i.kind === 'manifest') === last)) {
            if (this.stopped) break;
            await this.upload(it);
            this.tick();
          }
        }
      }
      if (!this.stopped) await this.journalDays();
      const touched = [...new Set(Object.values(this.state.files).map((r) => r.day))].sort().filter((d) => this.cfg.scope === 'all' || d === this.cfg.scope);
      for (const day of touched) if (!this.stopped) await this.index(day);
      if (this.cfg.deleteLocal && !this.stopped) {
        // The running set is read again now, not taken from the start of the run.
        const fresh = await readBoots(this.cfg, this.d.now(), this.d.workerActive, new Set(Object.keys(this.state.done_boots)));
        const running = new Set(fresh.filter((b) => b.open).map((b) => b.boot));
        for (const day of days) {
          const mine = items.filter((i) => i.day === day && i.kind === 'data' && this.state.files[i.key]?.verified && !this.state.files[i.key]?.deleted_at);
          if (mine.length === 0 || !(await this.indexStands(day))) continue;
          for (const it of mine) await this.deleteFile(it, running);
        }
      }
      // Each waiting file's age, read once; one deleted meanwhile is left out.
      const pending = items
        .filter((i) => !this.state.files[i.key]?.verified && !this.state.files[i.key]?.deleted_at && !this.state.files[i.key]?.vanished_at && !this.kept.some((k) => k.key === i.key) && existsSync(i.path))
        .map((i) => {
          try {
            return statSync(i.path).mtimeMs;
          } catch (e) {
            if (isGone(e)) return null;
            throw e;
          }
        })
        .filter((t) => t !== null);
      const oldest = pending.reduce((m, t) => Math.min(m, t), this.journalBacklogFrom());
      this.prune(boots);
      if (this.failures === 0) this.state.failed_runs = 0;
      this.save();
      this.status({ running: false, ok: this.failures === 0, pending: pending.length, backlog_age_s: Number.isFinite(oldest) ? Math.max(0, Math.round((this.d.now() - oldest) / 1000)) : 0 });
      this.d.log(`Recording upload: ${this.counts.uploaded} sent, ${this.counts.verified} confirmed, ${this.counts.deleted} deleted (${this.counts.freed_bytes} bytes), ${this.counts.vanished} vanished before upload, ${pending.length} waiting, ${this.kept.length} kept, ${this.failures} failed.`);
      return this.failures === 0 ? 0 : 1;
    } catch (e) {
      this.lastError = e instanceof Error ? `${e.name}: ${e.code ?? e.message.slice(0, 120)}` : 'error';
      this.status({ running: false, ok: false });
      this.d.log(`Recording upload stopped: ${this.lastError}.`);
      return 1;
    }
  }

  /** When the oldest ended day still waiting in the journal ended (Infinity when none waits). */
  journalBacklogFrom() {
    const j = this.state.journal;
    if (!existsSync(this.cfg.journal) || statSync(this.cfg.journal).size <= j.offset) return Number.POSITIVE_INFINITY;
    const first = j.pending?.day ?? null;
    if (first !== null) return dayEnd(first);
    try {
      const b = Buffer.alloc(200);
      const fd = openSync(this.cfg.journal, 'r');
      try {
        readSync(fd, b, 0, 200, j.offset);
      } finally {
        closeSync(fd);
      }
      const m = /"ts":"(\d{4}-\d{2}-\d{2})T/.exec(b.toString('latin1'));
      return m && this.d.now() >= dayEnd(m[1]) ? dayEnd(m[1]) : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

/** Credentials from systemd's credentials folder (trimmed as the worker reads them); values under 8 characters are not scanned for, as the worker does not redact them. */
export const readCredentials = (dir) => {
  const read = (n) => {
    try {
      const v = readFileSync(join(dir, n), 'utf8').trim();
      return v === '' ? null : v;
    } catch {
      return null;
    }
  };
  const key = dir ? read('heartbeat_hmac_key') : null;
  const values = dir ? CREDENTIALS.map(read).filter((v) => v !== null && v.length >= 8) : [];
  return { key, values: [...new Set(values)].sort((a, b) => b.length - a.length) };
};

const main = async () => {
  const i = process.argv.indexOf('--scope');
  const scope = i === -1 ? 'all' : process.argv[i + 1];
  if (scope !== 'all' && !(DAY_RE.test(scope ?? '') && dayOf(Date.parse(`${scope}T00:00:00Z`)) === scope)) {
    console.log('Usage: record-upload.mjs --scope all|YYYY-MM-DD');
    return 2;
  }
  const cfg = { ...DEFAULTS, scope };
  let hc = {};
  try {
    hc = JSON.parse(readFileSync(cfg.hostConfig, 'utf8'));
  } catch {}
  if (hc.record_upload !== true) {
    console.log('Recording upload is off (ops/host-config.json "record_upload").');
    // The unit's state folder (systemd makes it); never created here.
    if (existsSync(cfg.stateDir)) writeAtomic(join(cfg.stateDir, 'status.json'), `${JSON.stringify({ v: 1, at: Date.now(), enabled: false })}\n`);
    return 0;
  }
  const { key, values } = readCredentials(process.env.CREDENTIALS_DIRECTORY);
  const url = process.env.WATCHDOG_URL ?? '';
  const up = new Uploader(
    { ...cfg, key: key ?? '', values, deleteLocal: hc.record_upload_delete_local === true },
    { transport: watchdogTransport(url.replace(/\/+$/, '')), workerActive: systemWorkerActive, now: Date.now, log: (s) => console.log(s) },
  );
  if (!key || !/^https?:\/\/[^\s"]+$/.test(url)) {
    up.state.failed_runs++;
    up.save();
    up.lastError = !key ? 'no heartbeat key' : 'no watchdog address';
    up.status({ running: false, ok: false });
    console.log(`Recording upload cannot run: ${up.lastError}.`);
    return 1;
  }
  return up.run();
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.log(`Recording upload failed: ${e instanceof Error ? e.name : 'error'}.`);
      process.exit(1);
    },
  );
}
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/worker-smoke 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# worker-smoke RELEASE_DIR: can this release's own worker start and stay up? zeroed-update runs it before it switches to
# a new release (SWITCH-1), so a release whose worker cannot start never becomes current and the running worker is
# never stopped for it. The trial runs beside the running worker and touches none of its state or ports:
#   - as transient systemd units under the worker unit's own sandbox: every hardening, limit and environment setting of
#     zeroed-worker.service is read from the installed unit and applied, with the worker's user, its environment file,
#     memory capped at SMOKE_MEMORY_MAX and the first to go under memory pressure (OOMScoreAdjust=1000), since the host
#     has 1 GB and the live worker keeps running;
#   - no credentials (provider keys are not needed to start; a worker without providers runs degraded, entries halted),
#     a scratch state directory as the only writable path, health and API on the SMOKE_* loopback ports;
#   - --reconcile (the unit's ExecStartPre) must exit 0; then the worker must answer its health route in paper mode
#     within 90 s, and still be running and answering after a further SMOKE_HOLD_S. It is then stopped.
# Prints one line saying why when it fails; exit 0 when the worker starts and stays up, 1 when it does not. A release
# still on the host's stand-in has no worker of its own to try and passes.
set -euo pipefail
. /usr/local/lib/zeroed/logic.sh
dir="${1:?usage: worker-smoke RELEASE_DIR}"
entry="$(worker_entry "$dir")"
[ "$entry" != /opt/zeroed/stub/worker.mjs ] || exit 0

UNIT_FILE=/etc/systemd/system/zeroed-worker.service
TRIAL=zeroed-worker-smoke
# A trial left by an earlier run that was cut off is cleared first (the unit names are fixed).
systemctl stop "$TRIAL.service" "$TRIAL-reconcile.service" >/dev/null 2>&1 || true
systemctl reset-failed "$TRIAL.service" "$TRIAL-reconcile.service" >/dev/null 2>&1 || true
install -d -m 0711 -o root -g root /var/lib/zeroed-smoke
tmp="$(mktemp -d /var/lib/zeroed-smoke/run.XXXXXX)"
chown zeroed-worker:zeroed-worker "$tmp"
install -d -m 0700 -o zeroed-worker -g zeroed-worker "$tmp/state"
cleanup() {
  systemctl stop "$TRIAL.service" "$TRIAL-reconcile.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$TRIAL.service" "$TRIAL-reconcile.service" >/dev/null 2>&1 || true
  # Its listening sockets close a moment after it exits: leave the trial ports free for the next trial.
  for _ in $(seq 1 30); do ss -Hltn "( sport = :${SMOKE_HEALTH_ADDR##*:} or sport = :${SMOKE_API_ADDR##*:} )" 2>/dev/null | grep -q . || break; sleep 1; done
  rm -rf "$tmp"
}
trap cleanup EXIT

# The release's S0 shakedown settings, as worker-start gives them (PRACTICE-ON): a release whose worker refuses them
# never becomes current.
shakedown=()
settings="$(worker_shakedown "$dir" 2>"$tmp/shakedown.err")" || { echo "its host-config shakedown settings are refused: $(tr -cd '[:print:]' <"$tmp/shakedown.err" | cut -c1-160)"; exit 1; }
while IFS= read -r line; do [ -z "$line" ] || shakedown+=(--setenv="$line"); done <<<"$settings"

# The worker unit's sandbox, limits and environment settings (unit_sandbox), applied to the trial.
props=()
while IFS= read -r line; do
  props+=(-p "$line")
done < <(unit_sandbox "$UNIT_FILE")
[ "${#props[@]}" -gt 40 ] || { echo "the worker unit's sandbox could not be read from $UNIT_FILE"; exit 1; }

# trial UNIT LOG MODE: the release's worker as a transient unit with that sandbox, the worker's environment file, the
# RUN-1 environment and shakedown settings (worker-start) on the trial's state directory and ports, and the memory cap.
# MODE "reconcile" runs its --reconcile and waits for it (at most 120 s); "run" starts it and returns.
trial() {
  local unit="$1" log="$2" opts=() args=()
  if [ "$3" = reconcile ]; then opts=(--wait -p RuntimeMaxSec=120); args=(--reconcile); fi
  systemd-run --quiet --unit="$unit" "${opts[@]}" "${props[@]}" \
    -p User=zeroed-worker -p Group=zeroed-worker -p MemoryMax="$SMOKE_MEMORY_MAX" -p OOMScoreAdjust=1000 -p TimeoutStopSec=30 \
    -p EnvironmentFile=-/etc/zeroed/worker.env -p WorkingDirectory="$dir" -p ReadWritePaths="$tmp" \
    -p StandardOutput=append:"$log" -p StandardError=append:"$log" "${shakedown[@]}" \
    --setenv=NODE_ENV=production --setenv=ZEROED_MODE=paper --setenv=ZEROED_RECORDER=on --setenv=ZEROED_SIMULATE=on \
    --setenv=ZEROED_DRILLS=on --setenv=ZEROED_STATE_DIR="$tmp/state" --setenv=ZEROED_GIT_SHA="$(basename "$dir")" \
    --setenv=ZEROED_HEALTH_ADDR="$SMOKE_HEALTH_ADDR" --setenv=ZEROED_API_ADDR="$SMOKE_API_ADDR" \
    /usr/local/bin/node --no-warnings "$entry" "${args[@]}"
}
# why LOG: the line that says what went wrong (an error or a refusal), else the last line; one line, printable.
why() {
  { grep -m1 -E '(^|[^A-Za-z])([A-Za-z]*Error|refused)([^A-Za-z]|$)' "$1" || tail -n 1 "$1"; } 2>/dev/null | tr -cd '[:print:]' | cut -c1-200
}
status() { systemctl show -p ExecMainStatus --value "$1.service" 2>/dev/null || echo '?'; }
healthy() { curl -fsS -m 2 "http://$SMOKE_HEALTH_ADDR/health" 2>/dev/null | jq -e '.mode == "paper"' >/dev/null 2>&1; }

: >"$tmp/reconcile.log"
if ! trial "$TRIAL-reconcile" "$tmp/reconcile.log" reconcile >"$tmp/systemd-run.log" 2>&1; then
  [ -s "$tmp/reconcile.log" ] || cp "$tmp/systemd-run.log" "$tmp/reconcile.log"
  echo "its reconcile exited $(status "$TRIAL-reconcile"): $(why "$tmp/reconcile.log")"
  exit 1
fi
: >"$tmp/start.log"
trial "$TRIAL" "$tmp/start.log" run >"$tmp/systemd-run.log" 2>&1 || { echo "it could not be started: $(why "$tmp/systemd-run.log")"; exit 1; }
up=0
for _ in $(seq 1 90); do
  systemctl is-active --quiet "$TRIAL.service" || { echo "it exited $(status "$TRIAL"): $(why "$tmp/start.log")"; exit 1; }
  if healthy; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || { echo "its health route did not answer within 90 s: $(why "$tmp/start.log")"; exit 1; }
# Answering once is not staying up: it must still run and answer after the hold.
for _ in $(seq 1 "$SMOKE_HOLD_S"); do
  systemctl is-active --quiet "$TRIAL.service" || { echo "it exited $(status "$TRIAL") within ${SMOKE_HOLD_S} s of answering: $(why "$tmp/start.log")"; exit 1; }
  sleep 1
done
healthy || { echo "its health route stopped answering within ${SMOKE_HOLD_S} s: $(why "$tmp/start.log")"; exit 1; }
exit 0
__ZEROED_FILE__
install_file /usr/local/lib/zeroed/worker-start 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Starts the worker for zeroed-worker.service (ExecStartPre with --reconcile, then ExecStart) with the RUN-1
# environment (ARCHITECTURE.md 12.4): paper mode, recorder and simulation on from the first minute, the drill
# endpoint on, the health route for the runner and the worker API both on loopback only (tailscale serve
# publishes the API to the tailnet, 17). The release's worker (WORKER-1) runs only once the release's
# ops/host-config.json says "worker": "release"; the host's stand-in only on "stub" (anything else is refused: RC-M4). The release's worker also takes the
# S0 shakedown settings of that file's "shakedown" block (PRACTICE-ON). Live is never set here or in any environment
# file: the worker refuses any mode but paper.
set -euo pipefail
. /usr/local/lib/zeroed/logic.sh
entry="$(worker_entry /opt/zeroed/current)"
if [ "$entry" != /opt/zeroed/stub/worker.mjs ]; then
  # The release's S0 shakedown settings (PRACTICE-ON, its host-config "shakedown" block): public values only, judged
  # again by the worker. A block that cannot be read is refused like any refused setting (exit 2).
  settings="$(worker_shakedown /opt/zeroed/current)" || { echo "refused: the release's host-config shakedown settings" >&2; exit 2; }
  while IFS= read -r line; do [ -z "$line" ] || export "$line"; done <<<"$settings"
fi
export ZEROED_MODE=paper ZEROED_RECORDER=on ZEROED_SIMULATE=on ZEROED_DRILLS=on
export ZEROED_HEALTH_ADDR="$WORKER_HEALTH_ADDR" ZEROED_API_ADDR="$WORKER_API_ADDR"
# HEAP-GUARD: V8's default heap limit follows the machine's RAM (about half of it: roughly 500 MB on the 1 GB host), not
# the unit's MemoryMax=800M, and a heap past it aborts with no handler ("no clean stop"). 560 MB of old space, plus the
# young generation (up to 48 MB) and the measured native overhead (RSS less heap: 127 MB at a 100k-mint boot, 147 MB at
# 1M), stays under 800M. A fatal error writes a compact report into the state dir (StateDirectory: writable under
# ProtectSystem=strict), which the next start's reconcile reads to name the death.
reports="${STATE_DIRECTORY:-/var/lib/zeroed}/reports"
mkdir -p "$reports"
# Only the newest 5 reports are kept: a restart loop would otherwise write one every few minutes. The newest (the last
# death's) is the one the reconcile reads. Safe with no report at all (nullglob).
shopt -s nullglob
old=("$reports"/report.*.json)
shopt -u nullglob
if [ "${#old[@]}" -gt 5 ]; then
  mapfile -t old < <(ls -1t -- "${old[@]}")
  rm -f -- "${old[@]:5}"
fi
heap=(--max-old-space-size=560 --report-on-fatalerror --report-compact "--report-directory=$reports")
if [ "$entry" != /opt/zeroed/stub/worker.mjs ]; then
  cd /opt/zeroed/current
  exec /usr/local/bin/node --no-warnings "${heap[@]}" "$entry" "$@"
fi
exec /usr/local/bin/node "${heap[@]}" "$entry" "$@"
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-backup 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Hourly encrypted backup of every SQLite file under /var/lib/zeroed, and (PATHS-FIX ruling 24) of the provider usage
# ledger's folder /var/lib/zeroed-usage, stored in the bundle under zeroed-usage/. Each file is copied with SQLite's
# online backup (consistent under WAL), checked, listed in a manifest with its SHA-256, packed and
# encrypted with age to /etc/zeroed/backup-recipients (the host key, plus the owner's key once the
# Deploy workflow delivered one). Keeps the newest 72 locally.
set -euo pipefail
umask 077

SRC="${ZEROED_BACKUP_SRC:-/var/lib/zeroed}"
USAGE_SRC="${ZEROED_BACKUP_USAGE_SRC:-/var/lib/zeroed-usage}"
OUT="${ZEROED_BACKUP_OUT:-/var/backups/zeroed}"
RECIPIENTS="${ZEROED_BACKUP_RECIPIENTS:-/etc/zeroed/backup-recipients}"
KEEP="${ZEROED_BACKUP_KEEP:-72}"

[ -s "$RECIPIENTS" ] || { echo "No backup recipients yet (keys not delivered); nothing backed up."; exit 0; }
# Each entry is "source|path in the bundle"; the usage ledger's files go under zeroed-usage/.
list() { # root prefix
  [ -d "$1" ] || return 0
  (cd "$1" && find . -type f \( -name '*.sqlite' -o -name '*.db' \) | sed 's#^\./##' | LC_ALL=C sort) | while IFS= read -r f; do printf '%s|%s\n' "$1/$f" "$2$f"; done
}
mapfile -t entries < <(list "$SRC" ''; list "$USAGE_SRC" 'zeroed-usage/')
[ "${#entries[@]}" -gt 0 ] || { echo "No SQLite files yet; nothing backed up."; exit 0; }
dbs=()

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/snap"
for e in "${entries[@]}"; do
  src="${e%%|*}"
  rel="${e#*|}"
  dbs+=("$rel")
  mkdir -p "$work/snap/$(dirname "$rel")"
  sqlite3 "$src" ".timeout 10000" ".backup '$work/snap/$rel'"
  check="$(sqlite3 "$work/snap/$rel" 'PRAGMA integrity_check;')"
  [ "$check" = ok ] || { echo "Backup copy of $rel failed its integrity check."; exit 1; }
done
(cd "$work/snap" && sha256sum -- "${dbs[@]}") > "$work/snap/MANIFEST.sha256"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
tar -C "$work/snap" -c . | age -R "$RECIPIENTS" -o "$OUT/zeroed-$ts.tar.age.new"
mv -f "$OUT/zeroed-$ts.tar.age.new" "$OUT/zeroed-$ts.tar.age"
ls -1 "$OUT"/zeroed-*.tar.age | LC_ALL=C sort -r | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "Backup zeroed-$ts.tar.age: ${#dbs[@]} file(s), $(wc -l < "$RECIPIENTS") recipient(s)."
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-backup-code 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Console, once: makes the owner's 6-word backup code and shows it one time. Only its public half (an age
# recipient) is kept here, in /etc/zeroed/backup-recipients; the words themselves are never stored, so
# write them down and keep them safe. Backups (and the daily copy sent to Telegram) can then be opened
# anywhere with the words: node derive-key.mjs --backup, then age -d.
set -euo pipefail
umask 022
. /usr/local/lib/zeroed/common.sh
lock
code="$(/usr/local/bin/node -e '
  const { randomInt } = require("node:crypto");
  const words = require("node:fs").readFileSync("/usr/local/share/zeroed/eff_large_wordlist.txt", "utf8").trim().split("\n");
  if (words.length !== 7776) process.exit(1);
  console.log(Array.from({ length: 6 }, () => words[randomInt(words.length)]).join(" "));
')"
recipient="$(printf '%s' "$code" | /usr/local/bin/node /usr/local/lib/zeroed/derive-key.mjs --backup | age-keygen -y)"
{
  age-keygen -y /etc/zeroed/age/host.key
  printf '%s\n' "$recipient"
} > /etc/zeroed/backup-recipients.new
chmod 0644 /etc/zeroed/backup-recipients.new
mv -f /etc/zeroed/backup-recipients.new /etc/zeroed/backup-recipients
printf '%s\n' "$recipient" > "$STATE_DIR/owner_backup_recipient"
log "Backup code (shown once, not stored here; write it down):"
log ""
log "  $code"
log ""
log "From the next backup on, backups open with these words. Run this again to replace the code."
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-backup-offsite 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Daily off-server copy of the newest backup, sent as a silent Telegram document to the paired chat (free;
# Telegram takes files up to 50 MB). Off unless ops/host-config.json in the deployed release says
# "offsite_backup": true: sending data to a third party needs the owner's approval (CLAUDE.md), and
# switching it on is a reviewed commit. The copy is re-encrypted to the owner's backup code only, so
# nothing on this server (the host key included) can open it. Runs from zeroed-backup-offsite.timer.
set -euo pipefail
umask 077
. /usr/local/lib/zeroed/common.sh
OUT="${ZEROED_BACKUP_OUT:-/var/backups/zeroed}"
enabled="$(jq -r '.offsite_backup == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)"
[ "$enabled" = true ] || { log "Off-server copy is off (ops/host-config.json; needs the owner's approval)."; exit 0; }
owner="$(cat "$STATE_DIR/owner_backup_recipient" 2>/dev/null || true)"
[[ "$owner" =~ ^age1[a-z0-9]{58}$ ]] || { log "No backup code yet (zeroed-backup-code): no off-server copy."; exit 0; }
paired || { log "Telegram not paired: no off-server copy."; exit 0; }
newest="$(ls -1 "$OUT"/zeroed-*.tar.age 2>/dev/null | LC_ALL=C sort -r | head -n 1 || true)"
[ -n "$newest" ] || { log "No backup yet."; exit 0; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
copy="$work/$(basename "$newest")"
# Owner only: open with the host key, encrypt again to the owner's recipient alone (plaintext only in a pipe).
age -d -i /etc/zeroed/age/host.key "$newest" | age -r "$owner" -o "$copy"
size="$(stat -c %s "$copy")"
[ "$size" -le 49000000 ] || { log "Backup is $size bytes, over Telegram's 50 MB: not sent."; notify "Zeroed server: backup too large for the Telegram copy ($size bytes)." || true; exit 1; }
chat="$(cred telegram_chat_id)"
tg_chat="$chat" tg_field=form tg sendDocument -o /dev/null -F "document=@$copy" -F "disable_notification=true" \
  -F "caption=Zeroed backup $(basename "$newest" .tar.age). Opens only with your backup code." 2>/dev/null ||
  { log "Sending the off-server copy failed."; exit 1; }
printf '%s\n' "$(basename "$newest")" > "$STATE_DIR/last_offsite"
log "Sent $(basename "$newest") ($size bytes, owner key only) to the paired Telegram chat."
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-check 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Every minute (zeroed-check.timer), once the keys are here:
#  1. Stored keys: each credential must decrypt and match the ciphertext the handoff or pairing stored.
#     A key that fails (missing, does not open, changed outside those paths) is an alert.
#  2. Webhook: a failed set is tried again with back-off (1, 2, 4, 8 min, then every 30); after 5 failed
#     tries the owner is told. While paired, the webhook Telegram reports must match the one this server
#     set; a change (another URL, or none) is an alert, and the server sets its own again.
#  3. A worker restart that waits for the dry run to end (re-pairing) runs once nothing is in flight.
#  4. The index of the dry-run evidence kept on the host, for the worker API.
#  0. Tailscale Funnel must be off (the live view is tailnet only); on is an alert and it is turned off.
#  5. The recording upload's alerts (failed runs, a backlog over a day, files kept back, no report for 3 hours).
#  6. A standing alert while the bot sits on the stand-in after a rollback.
#  7. A worker that refused to start on lost or corrupt state (its refused.json, or exit 78), with the reason.
#  8. A worker unit that systemd stopped restarting (failed).
# Alerts go to the paired chat once per episode, with a "cleared" line after. Never prints a value.
set -euo pipefail
umask 077
. /usr/local/lib/zeroed/common.sh
lock

# 4 first: it needs no keys.
install -d -m 0755 "$(dirname "$EVIDENCE_INDEX")"
(umask 022; evidence_index "$EVIDENCE_ROOT" > "$EVIDENCE_INDEX.new" 2>/dev/null && mv -f "$EVIDENCE_INDEX.new" "$EVIDENCE_INDEX") || rm -f "$EVIDENCE_INDEX.new"

# 5. Recording upload (RECORD-UPLOAD): its alerts, from the status file the uploader writes (it runs as the worker's
# user and cannot reach Telegram's token or this folder). The switch off clears them, and so does a host with no recorder
# folder yet (the upload unit's ConditionPathExists: it is skipped and never writes a status); "never reported" waits
# 70 minutes from when this check first saw that folder.
if [ "$(jq -r '.record_upload == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)" = true ]; then
  rec="$(cat /var/lib/zeroed-record-upload/status.json 2>/dev/null || echo '{}')"
else
  rec='{"enabled":false}'
fi
now="$(date +%s)"
seen="$(recorder_first_seen "$now" /var/lib/zeroed/recorder "$STATE_DIR/recorder_first_seen")"
while IFS='|' read -r what key text; do
  if [ "$what" = on ]; then alert "$key" "$text"; else alert_clear "$key" "$text"; fi
done < <(printf '%s' "$rec" | record_alerts "$now" /var/lib/zeroed/recorder "$seen")
# PATHS-FIX ruling 23: the pull account's filesystem and binds; one alert while any is down, a CLEARED line after.
while IFS='|' read -r what key text; do
  if [ "$what" = on ]; then alert "$key" "$text"; else alert_clear "$key" "$text"; fi
done < <(systemctl is-active "${PULL_MOUNT_UNITS[@]}" 2>/dev/null | pull_mount_alerts "${PULL_MOUNT_UNITS[@]}")

# 6. RC-FIXES-2b (red team C R3-6): the bot never sits on the stand-in silently after a rollback. While a rollback put
# it there and the stand-in still runs, one standing alert; cleared once a release worker runs again.
if [ -s "$STATE_DIR/standin_after_rollback" ] && [ "$(worker_entry /opt/zeroed/current 2>/dev/null || true)" = "$STUB_ENTRY" ]; then
  alert standin "ALERT Zeroed host: the bot is on the stand-in worker after a rollback ($(head -c 200 "$STATE_DIR/standin_after_rollback" | tr -d '\n')): no trading and no exits until a new release deploys."
else
  rm -f "$STATE_DIR/standin_after_rollback"
  alert_clear standin "CLEARED Zeroed host: a release worker runs again."
fi

# 7. RC-FIXES-2b (#280's contract): a worker that refused to start on lost or corrupt state, by name and reason.
refused="$(worker_refused /var/lib/zeroed/refused.json "$(systemctl show -p ExecMainStatus --value zeroed-worker.service 2>/dev/null || true)")"
if [ -n "$refused" ]; then
  alert worker-refused "ALERT Zeroed host: the worker refused to start: $refused. It stays stopped until the state is looked at."
else
  alert_clear worker-refused "CLEARED Zeroed host: the worker no longer refuses to start."
fi

# 0. Funnel: the worker API must stay on the tailnet. Funnel on for any port is an alert, and it is turned off. Each
# tailscale call is bounded, so the minute check never hangs on it.
if command -v tailscale >/dev/null 2>&1; then
  public="$(timeout 30 tailscale serve status --json 2>/dev/null | funnel_ports)"
  if [ -n "$public" ]; then
    alert funnel-on "ALERT Zeroed host: Tailscale Funnel was on ($(printf '%s' "$public" | tr '\n' ' ')), which makes the worker API public. Turning it off."
    off=1
    for hp in $public; do timeout 30 tailscale funnel --https="${hp##*:}" off >/dev/null 2>&1 || off=0; done
    if [ "$off" = 0 ]; then
      # Funnel could not be turned off (an error or no answer in time): take the whole serve config down, so the API
      # never stays public with only an alert. zeroed-tailscale publishes it again.
      if timeout 30 tailscale serve reset >/dev/null 2>&1; then
        rm -f "$STATE_DIR/live_view"
        msg="ALERT Zeroed host: Tailscale Funnel could not be turned off, so the live view was taken down. Run zeroed-tailscale to publish it again."
        log "$msg"
        notify "$msg" || log "Could not send that alert to Telegram."
      else
        # Neither worked: the API may still be public, which needs the owner.
        msg="ALERT Zeroed host: Tailscale Funnel could not be turned off and the live view could not be taken down, so the worker API may be public. Run zeroed-tailscale --off on the server console."
        log "$msg"
        notify "$msg" || log "Could not send that alert to Telegram."
      fi
    fi
  else
    alert_clear funnel-on "CLEARED Zeroed host: Tailscale Funnel is off."
  fi
fi

keys_stored || exit 0

# 1. Stored keys.
names=(helius_api_key alchemy_api_key jupiter_api_key telegram_bot_token)
paired && names+=(telegram_chat_id)
for n in heartbeat_hmac_key telegram_webhook_secret; do [ ! -e "$CRED_DIR/$n" ] && [ ! -e "$STATE_DIR/cred_sha/$n" ] || names+=("$n"); done
bad=()
for n in "${names[@]}"; do
  why=""
  if [ ! -s "$CRED_DIR/$n" ]; then
    why=missing
  elif ! systemd-creds decrypt --name="$n" "$CRED_DIR/$n" - >/dev/null 2>&1; then
    why="does not open"
  elif [ ! -s "$STATE_DIR/cred_sha/$n" ]; then
    record_cred "$n" # stored before this check existed: its current ciphertext is the reference
  elif [ "$(sha256sum "$CRED_DIR/$n" | cut -c1-64)" != "$(cat "$STATE_DIR/cred_sha/$n")" ]; then
    why="changed outside a key handoff"
  fi
  [ -z "$why" ] || bad+=("$n ($why)")
done
if [ "${#bad[@]}" -gt 0 ]; then
  printf '%s\n' "${bad[@]}" > "$STATE_DIR/key_check"
  alert key-mismatch "ALERT Zeroed host: stored key check failed: ${bad[*]}. Replace the keys: zeroed-new-deploy-code at the console, then Deploy."
else
  rm -f "$STATE_DIR/key_check"
  alert_clear key-mismatch "CLEARED Zeroed host: every stored key passes its check again."
fi

paired || exit 0

# 8. RC-FIXES-2b: a worker unit that failed for good (systemd gave up restarting it), with how it last ended.
if [ -z "$refused" ] && systemctl is-failed --quiet zeroed-worker.service 2>/dev/null; then
  alert worker-failed "ALERT Zeroed host: the worker has stopped for good ($(systemctl show -p Result --value zeroed-worker.service 2>/dev/null || echo unknown), exit $(systemctl show -p ExecMainStatus --value zeroed-worker.service 2>/dev/null || echo unknown)). Nothing trades and no exit runs."
else
  alert_clear worker-failed "CLEARED Zeroed host: the worker runs again."
fi

# 2. Webhook: a pending set, when due.
if [ -e "$STATE_DIR/webhook_tries" ]; then
  if [ "$(date +%s)" -ge "$(cat "$STATE_DIR/webhook_next" 2>/dev/null || echo 0)" ]; then webhook_try || true; fi
  webhook_pending=true
else
  webhook_pending=false
fi

# 2. Webhook: what Telegram reports must be what this server set. Skipped while a set is pending (the
# failed-tries notice covers that) and while re-pairing (the webhook is off on purpose then).
if [ "$webhook_pending" = false ] && [ ! -s "$PAIR_CODE_FILE" ] && [ ! -s "$STATE_DIR/webhook_expected" ]; then
  # Paired before this check existed: set it once, which also records what to expect.
  webhook_try || true
elif [ "$webhook_pending" = false ] && [ ! -s "$PAIR_CODE_FILE" ]; then
  info="$(webhook_info)"
  now_fp="$(printf '%s' "$info" | webhook_fp)"
  if [ "$now_fp" != error ]; then
    if [ "$now_fp" != "$(cat "$STATE_DIR/webhook_expected")" ]; then
      alert webhook-changed "ALERT Zeroed host: the Telegram webhook changed (now: $(printf '%s' "$info" | webhook_host)). Only this server sets it. If you did not change it, rotate the bot token at BotFather and run Deploy. Setting it back now."
      webhook_try || true
    else
      alert_clear webhook-changed "CLEARED Zeroed host: the Telegram webhook is back to the one this server set."
    fi
  fi
fi

# 3. A worker restart that waited for a safe moment.
pending_restart
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-new-deploy-code 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Console only: makes a new one-time deploy code, for rotating the keys. Put it in the DEPLOY_CODE secret
# in GitHub, then run Deploy; every key is replaced and the worker restarts after reconciling.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh
lock
new_deploy_code
log "Deploy code:  $(cat "$DEPLOY_CODE_FILE")"
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-pair 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Receives the keys from the Deploy workflow. While a deploy code is pending (/etc/zeroed/deploy-code), it
# looks for the release asset "handoff/bundle.age", opens it with the age identity derived from the code,
# stores each value as an encrypted systemd credential and wipes the code: one use only. A wrong code
# changes nothing and keeps the code, so the owner can fix the DEPLOY_CODE secret and run Deploy again.
# Runs every minute from zeroed-pair.timer, and every few seconds from the setup screen. Never prints a
# value; never set -x.
set -euo pipefail
umask 077
. /usr/local/lib/zeroed/common.sh
lock

[ -s "$DEPLOY_CODE_FILE" ] || exit 0 # No code pending: nothing can be received (and a replay cannot open).
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

code="$(curl -sS -L -m 30 -o "$WORK/bundle.age" -w '%{http_code}' \
  "$ZEROED_GITHUB_URL/$ZEROED_REPO/releases/download/handoff/bundle.age" || true)"
[ "$code" = 200 ] || exit 0
digest="$(sha256sum "$WORK/bundle.age" | cut -c1-64)"
seen() { [ "$(cat "$STATE_DIR/last_bundle" 2>/dev/null || true)" = "$digest" ]; }
note() { seen || log "$1"; printf '%s\n' "$digest" > "$STATE_DIR/last_bundle"; printf '%s\n' "$2" > "$STATE_DIR/handoff_status"; }

# Only a release made by this repository's own workflow counts.
author="$(curl -fsS -m 30 -H 'Accept: application/vnd.github+json' \
  "$ZEROED_API_URL/repos/$ZEROED_REPO/releases/tags/handoff" | jq -r '.author.login // empty' || true)"
if [ "$author" != "github-actions[bot]" ]; then
  note "Ignored the handoff release: not published by the repository's workflow." "ignored"
  exit 0
fi

# Decrypt straight into memory: the identity and the plaintext only ever pass through pipes.
declare -A v=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  k="${line%%=*}"
  val="${line#*=}"
  [[ "$k" =~ ^[A-Z][A-Z0-9_]{0,40}$ ]] || { note "Rejected the handoff: bad line." "rejected"; exit 0; }
  [[ "$val" =~ ^[A-Za-z0-9._:/+=@-]{0,512}$ ]] || { note "Rejected the handoff: bad value for $k." "rejected"; exit 0; }
  v[$k]="$val"
done < <(age -d -i <(/usr/local/bin/node /usr/local/lib/zeroed/derive-key.mjs < "$DEPLOY_CODE_FILE") "$WORK/bundle.age" 2>/dev/null || echo "DECRYPT_FAILED=1")
rm -f "$WORK/bundle.age"

if [ -n "${v[DECRYPT_FAILED]:-}" ] || [ "${v[ZEROED_BUNDLE]:-}" != 1 ]; then
  note "The handoff does not open with this server's deploy code. Check the DEPLOY_CODE secret in GitHub matches the code on this screen, then run Deploy again." "wrong code"
  exit 0
fi
issued="${v[ISSUED]:-}"
[[ "$issued" =~ ^[0-9]{1,20}$ ]] || { note "Rejected the handoff: no issue number." "rejected"; exit 0; }
if [ "$issued" -le "$(cat "$STATE_DIR/last_issued" 2>/dev/null || echo 0)" ]; then
  note "Ignored an older handoff (issue $issued)." "replay refused"
  exit 0
fi
for k in "${API_NAMES[@]}"; do
  [ -n "${v[$k]:-}" ] || { note "Rejected the handoff: $k is missing." "rejected"; exit 0; }
done

for k in "${API_NAMES[@]}"; do printf '%s' "${v[$k]}" | store_cred "${k,,}"; done
# Watchdog (when Deploy had the Cloudflare secrets): its address and the heartbeat key.
watchdog="${v[WATCHDOG_URL]:-}"
if [ -n "$watchdog" ] && [[ "$watchdog" =~ ^https://[A-Za-z0-9.-]+\.workers\.dev$ ]] && [ -n "${v[HEARTBEAT_HMAC_KEY]:-}" ]; then
  printf '%s' "${v[HEARTBEAT_HMAC_KEY]}" | store_cred heartbeat_hmac_key
  [ -z "${v[TELEGRAM_WEBHOOK_SECRET]:-}" ] || printf '%s' "${v[TELEGRAM_WEBHOOK_SECRET]}" | store_cred telegram_webhook_secret
  printf 'WATCHDOG_URL=%s\n' "$watchdog" > /etc/zeroed/worker.env.new
  chmod 0644 /etc/zeroed/worker.env.new
  mv -f /etc/zeroed/worker.env.new /etc/zeroed/worker.env
fi
v=()
printf '%s\n' "$issued" > "$STATE_DIR/last_issued"
printf '%s\n' "$digest" > "$STATE_DIR/last_bundle"
# Single use: the code is gone, so neither this bundle nor a copy of it can be opened here again.
shred -u "$DEPLOY_CODE_FILE" 2>/dev/null || rm -f "$DEPLOY_CODE_FILE"
printf 'keys stored\n' > "$STATE_DIR/handoff_status"
log "Stored ${#API_NAMES[@]} keys from the handoff (issue $issued); deploy code used up."

if paired; then
  # Rotation: restart the worker (reconcile first) and tell the owner.
  # During a held start (OPS-CLEAN round 4) the restart waits for it (pending_restart, zeroed-check); a release never
  # started under the hold (switch_unheld) gets its held first start from zeroed-update (OPS-CLEAN M1).
  if [ -e "$STATE_DIR/holding" ]; then
    : > "$STATE_DIR/worker_restart_pending"
    w="restarts once the held start of the new release is over"
  elif [ -s "$STATE_DIR/switch_unheld" ]; then
    systemctl start --no-block zeroed-update.service || true
    w="starting under the hold"
  elif systemctl restart zeroed-worker.service; then w=restarted; else w="failed to start"; fi
  notify "Zeroed server: keys replaced (issue $issued). Worker $w." || true
  webhook_try || true
else
  [ -s "$PAIR_CODE_FILE" ] || new_pair_code
fi
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-pair-code 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Console only: makes a new Telegram pairing code (the old one stops working) and shows it. The code works
# once, for 30 minutes. On a paired server it asks first; the current chat stays paired until the new /pair
# succeeds.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh
[ -s "$CRED_DIR/telegram_bot_token" ] || { log "Keys not received yet: run Deploy first."; exit 1; }
if paired; then
  printf 'This server is paired with a Telegram chat. Pair a different chat? Alerts stay with the current chat until the new /pair succeeds.\nType yes to continue: '
  answer=""
  IFS= read -r answer || true
  [ "$answer" = yes ] || { log "Cancelled. Nothing changed."; exit 1; }
fi
lock
new_pair_code
if paired; then
  notify "Zeroed host: a new Telegram pairing was started at the server console. This chat stays paired until it succeeds; the code expires in 30 minutes." || true
fi
log "Send this to your bot in Telegram:  /pair $(cat "$PAIR_CODE_FILE")"
log "One try only, within 30 minutes; a wrong or late code needs a new one from here."
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-record-upload 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# RECORD-UPLOAD at the console: one run now, for every recording (no argument) or one UTC day (--day YYYY-MM-DD), in
# the same sandbox as the hourly run (zeroed-record-upload@<scope>.service, as the worker's user, after any run in
# progress). It uploads only while ops/host-config.json says "record_upload": true. Its last lines are shown.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh
usage() { log "Usage: zeroed-record-upload [--day YYYY-MM-DD]"; exit 2; }
scope=all
case "${1:-}" in
  '') ;;
  --day)
    day="${2:-}"
    [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [ "$(date -u -d "$day" +%F 2>/dev/null || true)" = "$day" ] || usage
    scope="$day"
    ;;
  *) usage ;;
esac
unit="zeroed-record-upload@$scope.service"
since="$(date -u '+%Y-%m-%d %H:%M:%S')"
rc=0
systemctl start "$unit" || rc=$?
journalctl -u "$unit" --since "$since UTC" -o cat --no-pager 2>/dev/null | tail -n 40 || true
exit "$rc"
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-restore-drill 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Restore drill: decrypts a backup with the given age identity into a scratch directory (never over the
# live files), checks every file against the manifest, runs SQLite's integrity check, and compares the
# tables with the live database. Prints PASS or FAIL; exits non-zero on FAIL.
#   zeroed-restore-drill IDENTITY_FILE [BACKUP_FILE]    (default: the newest backup)
set -euo pipefail
umask 077

SRC="${ZEROED_BACKUP_SRC:-/var/lib/zeroed}"
USAGE_SRC="${ZEROED_BACKUP_USAGE_SRC:-/var/lib/zeroed-usage}"
OUT="${ZEROED_BACKUP_OUT:-/var/backups/zeroed}"
identity="${1:?usage: zeroed-restore-drill IDENTITY_FILE [BACKUP_FILE]}"
backup="${2:-$(ls -1 "$OUT"/zeroed-*.tar.age 2>/dev/null | LC_ALL=C sort -r | head -n 1)}"
[ -n "$backup" ] && [ -f "$backup" ] || { echo "FAIL: no backup found"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

age -d -i "$identity" "$backup" 2>/dev/null | tar -x -C "$work" --no-same-owner 2>/dev/null || fail "cannot decrypt or unpack $(basename "$backup")"
[ -f "$work/MANIFEST.sha256" ] || fail "manifest missing"
(cd "$work" && sha256sum --quiet -c MANIFEST.sha256) >/dev/null 2>&1 || fail "a file does not match the manifest"

files=0
while read -r _ rel; do
  files=$((files + 1))
  [ "$(sqlite3 "$work/$rel" 'PRAGMA integrity_check;')" = ok ] || fail "$rel failed the integrity check"
  tables="$(sqlite3 "$work/$rel" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;")"
  for t in $tables; do
    printf '  %s %s: %s rows\n' "$rel" "$t" "$(sqlite3 "$work/$rel" "SELECT count(*) FROM \"$t\";")"
  done
  # The usage ledger's files are stored under zeroed-usage/ (PATHS-FIX ruling 24).
  case "$rel" in zeroed-usage/*) livef="$USAGE_SRC/${rel#zeroed-usage/}" ;; *) livef="$SRC/$rel" ;; esac
  if [ -f "$livef" ]; then
    live="$(sqlite3 -readonly "$livef" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;" 2>/dev/null || true)"
    [ "$live" = "$tables" ] || fail "$rel tables differ from the live database"
  fi
done < "$work/MANIFEST.sha256"
[ "$files" -gt 0 ] || fail "backup holds no files"
echo "PASS: $(basename "$backup"), $files file(s) restored to a scratch directory and verified."
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-resume 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Clears an owner /pause at the watchdog. Run as root at the host console; the request is signed with the
# heartbeat key (read from its credential and passed on stdin, never as an argument).
set -euo pipefail
. /usr/local/lib/zeroed/common.sh
. /etc/zeroed/worker.env
[ -n "${WATCHDOG_URL:-}" ] || { log "No watchdog configured."; exit 1; }
cred heartbeat_hmac_key | WATCHDOG_URL="$WATCHDOG_URL" /usr/local/bin/node --input-type=module -e '
import { createHmac } from "node:crypto";
let key = "";
for await (const c of process.stdin) key += c;
const body = "{}";
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", key).update(`${t}\nPOST\n/resume\n${body}`).digest("hex");
const res = await fetch(`${process.env.WATCHDOG_URL}/resume`, { method: "POST", headers: { "content-type": "application/json", "x-zeroed-signature": `t=${t},v1=${sig}` }, body });
console.log(res.ok ? "Entries allowed again." : `Watchdog refused: HTTP ${res.status}`);
process.exit(res.ok ? 0 : 1);
'
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-setup 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Console: the setup screen. Shows the deploy code, waits for the keys, then shows the Telegram pairing
# code and waits for /pair. Ctrl+C at any time is safe: the timers keep going and zeroed-status shows
# where things stand.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh
shown=""
while :; do
  /usr/local/sbin/zeroed-pair 2>/dev/null || true
  /usr/local/sbin/zeroed-telegram-pair 2>/dev/null || true
  state="$(/usr/local/sbin/zeroed-status 2>/dev/null || true)"
  if [ "$state" != "$shown" ]; then
    clear 2>/dev/null || true
    printf '%s\n\n(Waiting. Ctrl+C is safe; zeroed-status shows this again.)\n' "$state"
    shown="$state"
  fi
  if paired && keys_stored && [ ! -s "$DEPLOY_CODE_FILE" ]; then
    printf '\nSetup finished. The server is running.\n'
    exit 0
  fi
  sleep 5
done
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-status 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Console: where setup stands, and what to do next. Prints codes the owner needs, never a key.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh
step=""
if [ -s "$DEPLOY_CODE_FILE" ]; then
  log "Keys:      waiting for Deploy ($(cat "$STATE_DIR/handoff_status" 2>/dev/null || echo 'nothing published yet'))"
  log ""
  log "  Deploy code:  $(cat "$DEPLOY_CODE_FILE")"
  log ""
  step="In GitHub: Settings > Secrets and variables > Actions > New repository secret, name DEPLOY_CODE, value: the 6 words above. Then Actions > Deploy > Run workflow."
elif keys_stored; then
  log "Keys:      stored (${#API_NAMES[@]})"
else
  log "Keys:      none, and no deploy code pending: run zeroed-new-deploy-code"
fi
if paired; then
  log "Telegram:  paired"
  if [ -s "$PAIR_CODE_FILE" ]; then
    log "           new pairing pending: /pair $(cat "$PAIR_CODE_FILE") within 30 minutes (this chat stays paired until then)"
  fi
elif [ -s "$PAIR_CODE_FILE" ]; then
  log "Telegram:  waiting for /pair"
  log ""
  log "  Send this to your bot in Telegram:  /pair $(cat "$PAIR_CODE_FILE")"
  log ""
  [ -n "$step" ] || step="One try only, within 30 minutes. A wrong or late code needs a new one: zeroed-pair-code"
elif keys_stored; then
  log "Telegram:  not paired; run zeroed-pair-code"
fi
if [ "$(jq -r '.offsite_backup == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)" != true ]; then
  log "Backups:   hourly here; off-server copy off (waits for the owner's approval)"
elif [ -s "$STATE_DIR/owner_backup_recipient" ]; then
  log "Backups:   hourly here; daily copy to Telegram ($(cat "$STATE_DIR/last_offsite" 2>/dev/null || echo 'none sent yet'))"
else
  log "Backups:   hourly here; run zeroed-backup-code once for the off-server copy"
fi
if [ -s "$STATE_DIR/key_check" ]; then
  log "Key check: FAILED: $(tr '\n' ' ' < "$STATE_DIR/key_check")"
elif keys_stored; then
  log "Key check: passed"
fi
if [ -e "$STATE_DIR/webhook_tries" ]; then
  log "Webhook:   not set ($(cat "$STATE_DIR/webhook_tries") failed tries; retrying)"
fi
# Which worker runs: the release's own (SWITCH-1) or the host's stand-in, from the running process itself.
wpid="$(systemctl show -p MainPID --value zeroed-worker.service 2>/dev/null || echo 0)"
wkind=""
if [ "${wpid:-0}" != 0 ] && [ -r "/proc/$wpid/cmdline" ]; then
  case "$(tr '\0' ' ' < "/proc/$wpid/cmdline")" in
    *packages/worker/src/main.ts*) wkind=" (the release's worker, $(basename "$(readlink -f /opt/zeroed/current)" | cut -c1-12))" ;;
    *stub/worker.mjs*) wkind=" (the host's stand-in)" ;;
  esac
fi
log "Worker:    $(systemctl is-active zeroed-worker.service 2>/dev/null || true)$wkind"
# RC-FIXES-2b (#280's contract): a refusal to start, with its reason.
refused="$(worker_refused /var/lib/zeroed/refused.json "$(systemctl show -p ExecMainStatus --value zeroed-worker.service 2>/dev/null || true)")"
[ -z "$refused" ] || log "Refused:   $refused"
log "Signer:    $(systemctl is-active zeroed-signer.service 2>/dev/null || true)"
log "Release:   $(cut -c1-12 "$STATE_DIR/deployed" 2>/dev/null || echo 'none yet')"
run="$(qualifying_run "$EVIDENCE_ROOT" "$(systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend 2>/dev/null || true)")"
log "Dry run:   ${run:+$run active (updates wait)}${run:-none active}"
log "Evidence:  $EVIDENCE_ROOT ($(jq 'length' "$EVIDENCE_INDEX" 2>/dev/null || echo 0) runs)"
log "Live view: $(if [ -s "$STATE_DIR/live_view" ]; then echo "https://$(cat "$STATE_DIR/live_view")"; else echo 'off (zeroed-tailscale turns it on)'; fi)"
[ -z "$step" ] || { log ""; log "$step"; }
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-tailscale 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Console, opt-in: the live view (ARCHITECTURE.md 17). Installs Tailscale from its signed apt repository
# (key pinned by fingerprint), joins this server to the owner's tailnet as "zeroed", and publishes the worker
# API (loopback 127.0.0.1:8788) to the tailnet only, over HTTPS, with Funnel off. No public port opens.
#   zeroed-tailscale         set up (again): safe to repeat
#   zeroed-tailscale --off   stop publishing the worker API (Tailscale stays installed)
# The login link is shown here and sent to the paired Telegram chat, so it can be opened on the phone. So is anything
# the owner must turn on in the Tailscale admin console first (MagicDNS, HTTPS Certificates): every tailscale call is
# bounded in time and nothing it asks the owner to do is hidden.
set -euo pipefail
umask 022
. /usr/local/lib/zeroed/common.sh
TS_FPR=2596A99EAAB33821893C0A79458CA832957F5868
KEYRING=/usr/share/keyrings/tailscale-archive-keyring.gpg
TS_WAIT="${ZEROED_TS_WAIT:-60}"
TS_DNS_PAGE=https://login.tailscale.com/admin/dns

# Every tailscale call runs under a time limit, so a step waiting on something the owner cannot see ends with a
# "Stopped:" line instead of a silent hang. The login runs the binary itself: it has its own --timeout=15m and runs in
# the background, where it must stay one process the script can kill.
tailscale() {
  local rc=0
  timeout "$TS_WAIT" "$(type -P tailscale)" "$@" || rc=$?
  if [ "$rc" = 124 ]; then
    log "Stopped: 'tailscale ${1:-}' did not finish within ${TS_WAIT}s." >&2
  fi
  return "$rc"
}

if [ "${1:-}" = --off ]; then
  type -P tailscale >/dev/null || { log "Tailscale is not installed; nothing to turn off."; exit 0; }
  tailscale serve reset
  rm -f "$STATE_DIR/live_view"
  log "Live view off: the worker API is no longer published to the tailnet."
  exit 0
fi
[ $# = 0 ] || { log "Usage: zeroed-tailscale [--off]"; exit 2; }

if ! type -P tailscale >/dev/null; then
  log "Installing Tailscale from pkgs.tailscale.com"
  got="$(gpg --show-keys --with-colons /etc/zeroed/tailscale-archive.asc 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
  [ "$got" = "$TS_FPR" ] || { log "Stopped: the Tailscale signing key does not match its pinned fingerprint."; exit 1; }
  gpg --batch --yes --dearmor -o "$KEYRING.new" /etc/zeroed/tailscale-archive.asc
  chmod 0644 "$KEYRING.new"
  mv -f "$KEYRING.new" "$KEYRING"
  printf 'deb [signed-by=%s] https://pkgs.tailscale.com/stable/ubuntu noble main\n' "$KEYRING" > /etc/apt/sources.list.d/tailscale.list
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null
  apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends tailscale >/dev/null
fi
systemctl enable --now tailscaled >/dev/null

state() { tailscale status --json 2>/dev/null | jq -r '.BackendState // "NoState"'; }
if [ "$(state)" != Running ]; then
  out="$(mktemp)"
  trap 'rm -f "$out"; [ -z "${up_pid:-}" ] || kill "$up_pid" 2>/dev/null || true' EXIT
  # No Tailscale SSH, no routes or DNS taken from the tailnet: the server only offers the one HTTPS page.
  command tailscale up --hostname=zeroed --ssh=false --accept-routes=false --accept-dns=false --timeout=15m >"$out" 2>&1 &
  up_pid=$!
  url=""
  for _ in $(seq 1 60); do
    url="$(grep -Eo 'https://login\.tailscale\.com/[A-Za-z0-9/._-]+' "$out" | head -1 || true)"
    [ -z "$url" ] && [ "$(state)" != Running ] || break
    sleep 1
  done
  if [ -n "$url" ]; then
    log ""
    log "  Open this link and log in to Tailscale:  $url"
    log ""
    notify "Zeroed host: open this link and log in to Tailscale to add the server to your tailnet: $url" && log "(The link was also sent to your Telegram chat.)" || true
  fi
  wait "$up_pid" || { log "Stopped: Tailscale login did not finish ($(tail -1 "$out"))."; exit 1; }
  up_pid=""
fi

# The intended target is checked before anything is published: the worker API on loopback, nothing else.
[[ "$WORKER_API_ADDR" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]] || { log "Stopped: the worker API address is not loopback."; exit 1; }

# tailscale serve needs MagicDNS and HTTPS Certificates on the tailnet. Without them it prints a link to turn HTTPS on
# and waits for the owner (its "https" node capability); so both are checked first and named here. A serve the owner
# set up by hand is fine: serving the same target again changes nothing, and the checks below still run.
st="$(tailscale status --json)" || { log "Stopped: could not read Tailscale's status."; exit 1; }
need=()
jq -e '.CurrentTailnet.MagicDNSEnabled == true' <<<"$st" >/dev/null || need+=("MagicDNS")
jq -e '((.Self.CapMap // {}) | has("https")) and ((.CertDomains // []) | length > 0)' <<<"$st" >/dev/null || need+=("HTTPS Certificates")
if [ "${#need[@]}" -gt 0 ]; then
  what="${need[0]}${need[1]:+ and ${need[1]}}"
  msg="the live view needs $what on your tailnet. Open $TS_DNS_PAGE, turn on $what, then run zeroed-tailscale again."
  log "Stopped: $msg"
  notify "Zeroed host: $msg" && log "(This was also sent to your Telegram chat.)" || true
  exit 1
fi

# No funnel command here, not even to turn Funnel off: that command first waits for the tailnet's Funnel capability,
# and the wait never ends on a tailnet without Funnel. serve --https=443 itself clears Funnel for that port, and the
# check below confirms it is off.
served="$(mktemp)"
trap 'rm -f "$served" "${out:-}"' EXIT
if ! tailscale serve --bg --https=443 "http://$WORKER_API_ADDR" >"$served" 2>&1; then
  # Whatever tailscale printed (an error, or a link to act on) is shown, never dropped.
  cat "$served"
  tailscale serve reset >/dev/null 2>&1 || true
  rm -f "$STATE_DIR/live_view"
  log "Stopped: tailscale serve did not finish. Nothing is published."
  exit 1
fi
if ! tailscale serve status --json | serve_ok; then
  cat "$served"
  # Anything else than exactly that (another target, another port, Funnel on) is taken down at once.
  # serve reset clears the whole serve config, Funnel included.
  tailscale serve reset >/dev/null 2>&1 || true
  rm -f "$STATE_DIR/live_view"
  log "Stopped: tailscale serve did not publish only the worker API with Funnel off, so it was turned off again. Nothing is published."
  exit 1
fi
name="$(tailscale status --json | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
printf '%s\n' "${name:-unknown}" > "$STATE_DIR/live_view"
log "Live view: https://$name (your tailnet only, HTTPS, Funnel off)."
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-telegram-pair 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Locks the server to the owner's Telegram chat. While a pairing code is pending, reads the bot's messages
# (getUpdates). "/pair <code>" with the right code stores that chat id (encrypted, root-only) and replies
# "Paired". A wrong code invalidates the pending code: a new one comes only from the console
# (zeroed-pair-code). A code expires after 30 minutes. Every other message is ignored.
# Re-pairing (a code made on an already-paired server): the current chat stays paired, and keeps getting
# alerts, until the new /pair succeeds; a wrong code or an expired one leaves it paired. Never prints a value;
# never set -x.
set -euo pipefail
umask 077
. /usr/local/lib/zeroed/common.sh
lock

[ -s "$CRED_DIR/telegram_bot_token" ] || exit 0
was_paired=false
if paired; then
  was_paired=true
  # Paired and no code pending: nothing to read (the watchdog's webhook gets the messages).
  [ -s "$PAIR_CODE_FILE" ] || exit 0
fi

# A re-pair ends (success, wrong code or expiry): the webhook comes back.
repair_done() {
  [ "$was_paired" = true ] || return 0
  webhook_try || true
}

issued_at="$(stat -c %Y "$PAIR_CODE_FILE" 2>/dev/null || echo 0)"
if [ -s "$PAIR_CODE_FILE" ] && pair_code_expired "$issued_at" "$(date +%s)"; then
  rm -f "$PAIR_CODE_FILE"
  log "The Telegram pairing code expired (30 minutes). Run zeroed-pair-code for a new one."
  if [ "$was_paired" = true ]; then
    notify "Zeroed host: the new pairing code expired. This chat stays paired." || true
    repair_done
  fi
  exit 0
fi

# Until paired, read every message, so one sent while no code was pending never counts against a later code.
offset="$(cat "$STATE_DIR/tg_offset" 2>/dev/null || echo 0)"
get_updates() { tg getUpdates --data-urlencode "offset=$offset" --data-urlencode 'timeout=0' --data-urlencode 'allowed_updates=["message"]'; }
if ! updates="$(get_updates 2>/dev/null)"; then
  # Re-pairing while the watchdog's webhook is set: Telegram refuses getUpdates then. Turn it off for
  # pairing; it is set again as soon as the pairing ends.
  webhook_off && log "Turned off the Telegram webhook while pairing; it comes back once pairing ends." || true
  updates="$(get_updates)" || { log "Telegram getUpdates failed."; exit 0; }
fi
want="$(cat "$PAIR_CODE_FILE" 2>/dev/null || true)"
while IFS=$'\t' read -r id date chat kind text; do
  [ -n "$id" ] || continue
  printf '%s\n' "$((id + 1))" > "$STATE_DIR/tg_offset"
  [ -s "$PAIR_CODE_FILE" ] || continue
  # Only messages sent after this code was made count.
  [[ "$date" =~ ^[0-9]+$ ]] && [ "$date" -ge "$issued_at" ] || continue
  [[ "$text" =~ ^/pair(@[A-Za-z0-9_]+)?([[:space:]]+(.*))?$ ]] || continue
  got="$(printf '%s' "${BASH_REMATCH[3]:-}" | tr -d '[:space:]')"
  # Private chats only: a group or channel can never become the owner's chat.
  [ "$kind" = private ] && [[ "$chat" =~ ^[0-9]{1,20}$ ]] || continue
  if [ "$got" = "$want" ]; then
    if [ "$was_paired" = true ]; then
      notify "Zeroed host: a new chat was paired at the console. Alerts go there from now on." || true
    fi
    printf '%s' "$chat" | store_cred telegram_chat_id
    rm -f "$PAIR_CODE_FILE"
    log "Paired with the owner's Telegram chat."
    notify "Paired. Zeroed alerts come to this chat only." || true
    webhook_try || true
    if [ "$was_paired" = false ]; then
      start_worker || true
    else
      restart_for_chat
    fi
  else
    rm -f "$PAIR_CODE_FILE"
    log "Wrong pairing code sent in Telegram; that code no longer works. Run zeroed-pair-code for a new one."
    send_to "$chat" "Code not accepted. Get a new one at the server console." || true
    if [ "$was_paired" = true ]; then
      notify "Zeroed host: a wrong pairing code was sent, so the new pairing was cancelled. This chat stays paired." || true
      repair_done
    fi
  fi
done < <(printf '%s' "$updates" | jq -r '.result[]? | [(.update_id | tostring), ((.message.date // 0) | tostring), ((.message.chat.id // "-") | tostring), ((.message.chat.type // "-") | tostring), ((.message.text // "-") | gsub("[\t\n]"; " "))] | @tsv')
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-update 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Code updates by the same pull path: fetch the "deploy" tag and accept its commit only if
#  1. GitHub signed it (the merge-commit key pinned at install, i.e. a pull-request merge),
#  2. it is on the integration branch,
#  3. its checks are green (public GitHub API; logic.sh deploy gate): GitHub Actions' `check` passed on it and no
#     other GitHub Actions run failed, and the ops end-to-end (`e2e`) passed on the newest commit at or before it
#     that touched the e2e paths, and
#  4. no qualifying dry run is active (its unit, or an unfinished named run in the evidence), and
#  5. the worker reports no open intent (it writes /var/lib/zeroed/open_intents after each reconcile).
# Then apply the new release's host files (install.sh --update: scripts, units, RUN-1's units), and only once
# that succeeded switch to it and restart the worker, which reconciles before it trades. A failed apply keeps
# the old release running and is tried again next run, under the same gates. Runs every 5 minutes.
# Residual risk (DECISIONS.md): write access to the repository is the ability to deploy; the signer
# (SIGN-1) is the separate guard on funds.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh

REPO_DIR=/opt/zeroed/repo

# apply_host COMMIT DIR: the new release's installer in update mode (its RUN-1 units read from DIR), so host
# changes arrive with the code and nobody pastes the install line again. Releases from before --update
# existed are skipped.
apply_host() {
  local c="$1" installer="$2/ops/install.sh"
  if ! grep -q -- '--update) UPDATE=1' "$installer" 2>/dev/null; then
    # OPS-CLEAN round 4 (accepted, DECISIONS): a release from before --update has no host files to apply this way.
    log "Host files from ${c:0:12} not applied: its installer has no --update."
    return 0
  fi
  if ZEROED_RELEASE_DIR="$2" bash "$installer" --update > "$STATE_DIR/host_update.log" 2>&1; then
    log "Host files from ${c:0:12} applied."
    alert_clear host-apply "CLEARED Zeroed host: the host files of ${c:0:12} applied."
  else
    log "Host files from ${c:0:12} failed to apply (see $STATE_DIR/host_update.log); still on the old release, trying again next run."
    alert host-apply "ALERT Zeroed host: the host files of ${c:0:12} failed to apply, so the server stays on the release it runs. It tries again every 5 minutes."
    return 1
  fi
}

# answers SHA: the worker's health route says paper and names release SHA (its git_sha, the release folder's name), so
# an answer from the worker that ran before the switch never counts. The release's worker serves it on
# WORKER_HEALTH_ADDR; the host's stand-in on the API address.
answers() {
  local a
  for a in "$WORKER_HEALTH_ADDR" "$WORKER_API_ADDR"; do
    curl -fsS -m 2 "http://$a/health" 2>/dev/null | jq -e --arg sha "$1" '.mode == "paper" and .git_sha == $sha' >/dev/null 2>&1 && return 0
  done
  return 1
}

# holds: the restarted worker answers its health route in paper, as the new commit, within 60 s, then runs
# SWITCH_HOLD_S more with no restart and still answering as it. Prints why when it does not.
holds() {
  local up=0 n0
  for _ in $(seq 1 60); do
    if systemctl is-active --quiet zeroed-worker.service && answers "$commit"; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || { echo "its health route did not answer as ${commit:0:12} within 60 s"; return 1; }
  n0="$(systemctl show -p NRestarts --value zeroed-worker.service)"
  sleep "$SWITCH_HOLD_S"
  systemctl is-active --quiet zeroed-worker.service && [ "$(systemctl show -p NRestarts --value zeroed-worker.service)" = "$n0" ] ||
    { echo "it stopped or restarted within ${SWITCH_HOLD_S} s of answering"; return 1; }
  answers "$commit" || { echo "its health route stopped answering as ${commit:0:12} within ${SWITCH_HOLD_S} s"; return 1; }
}

# rollback WHY: the new release's worker did not stay up. Back to the release that ran before (its host files too),
# its commit as deployed, its worker restarted; the new commit is not tried again; one alert.
rollback() {
  local why="$1" note="" pc pprev pcur pstart pbase pdue
  # RC-R2-3: the failed release's probation ends here (the restarts were its own).
  rm -f "$STATE_DIR/probation"
  alert_clear worker-probation "CLEARED Zeroed host: the probation of ${commit:0:12} has ended."
  # RC-FIXES-2b (red team C R3-6): every rollback is told, also a second one in a row; the key is cleared first.
  rm -f "$STATE_DIR/alerts/worker-switch"
  if [ -z "$prev" ] || [ ! -d "$prev" ] || [ "$prev" = "$dest" ]; then
    rm -f "$STATE_DIR/probation.prev"
    alert worker-switch "ALERT Zeroed host: the worker of ${commit:0:12} did not stay up after the switch ($why), and there is no earlier release to go back to."
    exit 1
  fi
  case "$(worker_entry "$prev" 2>/dev/null || echo refused)" in
    "$STUB_ENTRY")
      note=" The bot is now paused on the stand-in worker: $(basename "$prev" | cut -c1-12) replaced ${commit:0:12}, and the next deploy needs a new commit."
      # RC-FIXES-2b (red team C R3-6): zeroed-check keeps a standing alert while the bot sits on the stand-in after this.
      printf '%s\n' "${commit:0:12} rolled back to $(basename "$prev" | cut -c1-12)" > "$STATE_DIR/standin_after_rollback" ;;
    refused) note=" The release before, $(basename "$prev" | cut -c1-12), names no worker the host can run, so the worker will not start: the bot is stopped." ;;
  esac
  printf '%s\n' "$commit" > "$STATE_DIR/failed_release"
  # OPS-CLEAN round 5: resumable. rollback_due stays until the target's worker is restarted and the owner told; a run
  # killed before that finishes it next time (probation_check). The deployed record moves before current, so no kill
  # point leaves current on the target with the record on the failed release (realign_current would undo it).
  printf '%s|%s|%s|%s\n' "$commit" "$prev" "$current" "${why//|/ }" > "$STATE_DIR/rollback_due"
  printf '%s\n' "$current" > "$STATE_DIR/deployed"
  ln -sfn "$prev" /opt/zeroed/current.new
  mv -Tf /opt/zeroed/current.new /opt/zeroed/current
  apply_host "${current:-$(basename "$prev")}" "$prev" || true
  systemctl reset-failed zeroed-worker.service >/dev/null 2>&1 || true
  systemctl restart zeroed-worker.service || true
  # RC-FIXES-2b (red team C R3-4): the release gone back to keeps the probation it had before the failed switch, from a
  # new restart baseline (the failed release's restarts are not its own).
  if [ -s "$STATE_DIR/probation.prev" ] && [ "$(cut -d'|' -f1 "$STATE_DIR/probation.prev")" = "$current" ]; then
    IFS='|' read -r pc pprev pcur pstart pbase pdue < "$STATE_DIR/probation.prev" || true
    printf '%s|%s|%s|%s|%s|%s\n' "$pc" "$pprev" "$pcur" "$pstart" "$(systemctl show -p NRestarts --value zeroed-worker.service 2>/dev/null || echo 0)" "$pdue" > "$STATE_DIR/probation"
  fi
  rm -f "$STATE_DIR/probation.prev"
  log "The worker of ${commit:0:12} did not stay up after the switch ($why); back on $(basename "$prev" | cut -c1-12)."
  alert worker-switch "ALERT Zeroed host: the worker of ${commit:0:12} did not stay up after the switch ($why), so the server went back to $(basename "$prev" | cut -c1-12). ${commit:0:12} is not tried again; a newer deploy is.$note"
  rm -f "$STATE_DIR/rollback_due"
  exit 1
}

# RC-R2-3: probation. A release can pass the trial start and the switch hold, then crash at minute 10, and one restart
# every 10 minutes never reaches the unit's start limit. For PROBATION_S after a switch, every run checks the unit's
# automatic restarts (NRestarts, which a planned `systemctl restart` never raises) against the count right after the
# hold. Any increase makes a rollback due, to the release that ran before, with one alert, as a failed hold does
# (DECISIONS 2026-10-07, RC-R2-3):
#   - during a qualifying dry run (its drills restart the worker on purpose) an increase is an alert, never a rollback;
#   - a due rollback waits, like the forward switch, while the worker reports open intents or open positions (or a count
#     cannot be read), and while a qualifying dry run is active: one alert, checked again every run, also past the
#     window, and done once nothing is open;
#   - when the release before runs the host's stand-in, the alert says the bot is now paused on it.
# The probation ends with the window (unless a rollback is due), or when another release is deployed.
probation_check() {
  local f="$STATE_DIR/probation" pc pprev pcur pstart pbase pdue now n open pos why note="" refused
  # OPS-CLEAN round 5: a rollback a killed run left half done is finished first (rollback() is safe to run again).
  if [ -s "$STATE_DIR/rollback_due" ]; then
    IFS='|' read -r pc pprev pcur why < "$STATE_DIR/rollback_due" || true
    log "Finishing the rollback of ${pc:0:12} to $(basename "$pprev" | cut -c1-12), which a stopped run left half done."
    commit="$pc" prev="$pprev" current="$pcur" dest="/opt/zeroed/releases/$pc"
    rollback "$why"
  fi
  [ -s "$f" ] || return 0
  IFS='|' read -r pc pprev pcur pstart pbase pdue < "$f" || true
  now="$(date +%s)"
  if [ "$pc" != "$(cat "$STATE_DIR/deployed" 2>/dev/null || true)" ] || ! [[ "$pstart" =~ ^[0-9]+$ ]] || ! [[ "$pbase" =~ ^[0-9]+$ ]]; then
    rm -f "$f"
    alert_clear worker-probation "CLEARED Zeroed host: the probation of ${pc:0:12} has ended."
    return 0
  fi
  # RC-FIXES-2b (#280's contract): a worker that refused to start on lost or corrupt state is never rolled back (older
  # code would start on the very state it refused). The probation holds, with one alert naming the reason, until the
  # refusal is gone.
  refused="$(worker_refused /var/lib/zeroed/refused.json "$(systemctl show -p ExecMainStatus --value zeroed-worker.service 2>/dev/null || true)")"
  if [ -n "$refused" ]; then
    alert worker-refused "ALERT Zeroed host: the worker of ${pc:0:12} refused to start: $refused. It is not rolled back (older code would start on the state it refused); the state needs the owner."
    return 0
  fi
  if [ -z "$pdue" ]; then
    if [ $((now - pstart)) -ge "$PROBATION_S" ]; then
      rm -f "$f"
      log "The worker of ${pc:0:12} stayed up through its probation."
      # RC-FIXES-2b (red team C R3-3): the probation alert's episode ends with it.
      alert_clear worker-probation "CLEARED Zeroed host: the probation of ${pc:0:12} has ended."
      return 0
    fi
    n="$(systemctl show -p NRestarts --value zeroed-worker.service 2>/dev/null || true)"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
      alert worker-probation "ALERT Zeroed host: the worker's restart count cannot be read during the probation of ${pc:0:12}."
      return 0
    fi
    [ "$n" -gt "$pbase" ] || return 0
    if [ -n "$(active_run)" ]; then
      alert worker-probation "ALERT Zeroed host: the worker of ${pc:0:12} restarted $((n - pbase)) time(s) within $(((now - pstart) / 60)) min of its switch, during a qualifying dry run, so it is not rolled back."
      return 0
    fi
    pdue="it restarted $((n - pbase)) time(s) within $(((now - pstart) / 60)) min of the switch (probation $((PROBATION_S / 60)) min)"
    printf '%s|%s|%s|%s|%s|%s\n' "$pc" "$pprev" "$pcur" "$pstart" "$pbase" "${pdue//|/ }" > "$f"
  fi
  # With no earlier release there is nothing to go back to and nothing moves: alert and drop at once (rollback()).
  if [ -z "$pprev" ] || [ ! -d "$pprev" ]; then
    rm -f "$f"
    commit="$pc" prev="" current="$pcur" dest="/opt/zeroed/releases/$pc"
    rollback "$pdue"
  fi
  # RC-FIXES-2b: a qualifying dry run that started while the rollback waited holds it too (never inside a run).
  if [ -n "$(active_run)" ]; then
    alert worker-probation-held "ALERT Zeroed host: rollback held: a qualifying dry run is active. The worker of ${pc:0:12} did not stay up ($pdue); it goes back once the run has ended and nothing is open."
    return 0
  fi
  # Open intents, and open positions (RC-FIXES-2b: a held position must not pass to older code or the stand-in); a
  # count that cannot be read holds.
  open="$(cat /var/lib/zeroed/open_intents 2>/dev/null || echo unknown)"
  pos="$(cat /var/lib/zeroed/open_positions 2>/dev/null || echo unknown)"
  if [ "$open" != 0 ] || [ "$pos" != 0 ]; then
    # OPS-CLEAN round 6 (DECISIONS): a dead worker's counts are its last; only the owner clears them, after checking.
    note=""
    systemctl is-active --quiet zeroed-worker.service ||
      note=" The worker is not running, so these counts are its last (/var/lib/zeroed/open_intents, /var/lib/zeroed/open_positions); check the positions before clearing them. Newer deploys wait until then."
    alert worker-probation-held "ALERT Zeroed host: rollback held: $open open intents, $pos open positions. The worker of ${pc:0:12} did not stay up ($pdue); it goes back once nothing is open.$note"
    return 0
  fi
  why="$pdue"
  rm -f "$f"
  alert_clear worker-probation-held "CLEARED Zeroed host: nothing is open; the rollback of ${pc:0:12} goes ahead."
  commit="$pc" prev="$pprev" current="$pcur" dest="/opt/zeroed/releases/$pc"
  rollback "$why"
}

# due_rollback WHY (RC-FIXES-2b, red team C R3-2): the new release did not start or hold. Its rollback is recorded as due
# and goes through probation_check's gate (no qualifying run, nothing open): done now, or held with one alert and done
# by a later run.
due_rollback() {
  printf '%s|%s|%s|%s|%s|%s\n' "$commit" "$prev" "$current" "$(date +%s)" 0 "${1//|/ }" > "$STATE_DIR/probation"
  rm -f "$STATE_DIR/switch_unheld" "$STATE_DIR/holding"
  probation_check
  exit 1
}

# held_restart: the switched release's worker started under the hold (SWITCH-1): restart (reconcile first), hold, then
# the probation baseline (RC-R2-3, the restart count right after the hold). A failure makes the rollback due. Needs
# commit, prev, current and dest.
# While it runs, $STATE_DIR/holding makes worker_busy true, so a re-pair or zeroed-check's pending restart waits instead
# of restarting the worker mid-hold (OPS-CLEAN m4); the restart they owe runs after (pending_restart).
held_restart() {
  : > "$STATE_DIR/holding"
  # OPS-CLEAN round 4: released only once holding is down, so no re-pair or check slips in between.
  flock -u 9 2>/dev/null || true
  systemctl reset-failed zeroed-worker.service >/dev/null 2>&1 || true
  systemctl restart zeroed-worker.service || due_rollback "it failed to start"
  if ! why="$(holds)"; then due_rollback "$why"; fi
  printf '%s|%s|%s|%s|%s\n' "$commit" "$prev" "$current" "$(date +%s)" "$(systemctl show -p NRestarts --value zeroed-worker.service 2>/dev/null || echo 0)" > "$STATE_DIR/probation"
  rm -f "$STATE_DIR/switch_unheld" "$STATE_DIR/holding" "$STATE_DIR/probation.prev" "$STATE_DIR/standin_after_rollback"
  alert_clear worker-switch "CLEARED Zeroed host: the worker of ${commit:0:12} is up."
}

active_run() { qualifying_run "$EVIDENCE_ROOT" "$(systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend 2>/dev/null || true)"; }

# realign_current (OPS-CLEAN round 4): current and the deployed record name the same release. A run killed between moving
# current and writing deployed leaves current on another release folder (releases/<commit>, 40 hex); current goes back to
# the deployed release, the one the record and any rollback target are built on, and the next switch is made again from
# there. A folder placed by hand under another name (the ops end-to-end's test copies) is not a release and is left as is.
realign_current() {
  local d c
  d="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
  c="$(basename "$(readlink -f /opt/zeroed/current 2>/dev/null || true)")"
  [[ "$c" =~ ^[0-9a-f]{40}$ ]] || return 0
  [ -n "$d" ] && [ "$c" != "$d" ] && [ -d "/opt/zeroed/releases/$d" ] || return 0
  ln -sfn "/opt/zeroed/releases/$d" /opt/zeroed/current.new
  mv -Tf /opt/zeroed/current.new /opt/zeroed/current
  log "Put current back to the deployed release ${d:0:12} (it pointed at ${c:0:12})."
  if systemctl is-active --quiet zeroed-worker.service; then realigned_active=1; fi
  # OPS-CLEAN round 5: a worker already running (started by a reboot) runs the other release; it comes back to the
  # deployed one through a held start (unheld_start), which waits for open intents and dry runs like any. With no marker,
  # the deployed release is the last one that ran, so it is its own rollback target: a failed hold of it alerts that there
  # is no earlier release, and a later switch still goes back to it. An existing marker is kept (OPS-CLEAN round 6): it
  # holds the real target, and unheld_start rewrites it for the deployed release.
  if systemctl is-active --quiet zeroed-worker.service && [ ! -s "$STATE_DIR/switch_unheld" ]; then
    printf '%s|%s|%s\n' "$d" "/opt/zeroed/releases/$d" "$d" > "$STATE_DIR/switch_unheld"
  fi
}

# OPS-CLEAN M1: a release switched to while the worker could not start (keys or pairing missing) left switch_unheld
# (commit|prev|current). Its first start is held like any switch, as soon as the worker can start: zeroed-telegram-pair,
# zeroed-pair and the installer start this unit instead of the worker while the marker exists. A worker that systemd
# started on its own meanwhile (a reboot) is restarted under the hold, once no dry run is active and no intent is open.
# The check runs under the host lock (a busy lock leaves it to the next run); the hold itself does not.
unheld_start() {
  [ -s "$STATE_DIR/switch_unheld" ] && worker_ready || return 0
  lock || return 0
  realign_current
  if [ ! -s "$STATE_DIR/switch_unheld" ] || ! worker_ready; then flock -u 9 2>/dev/null || true; return 0; fi
  IFS='|' read -r commit prev current < "$STATE_DIR/switch_unheld" || true
  local deployed
  deployed="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
  if [ "$commit" != "$deployed" ]; then
    # Written for a switch that never became deployed (a crash before the record moved). If the deployed release is the
    # one that ran, nothing is unheld, unless realign_current just took current back from under a running worker: then
    # the deployed release gets a held restart, as its own rollback target. Otherwise the deployed release never
    # started, with the same release to go back to. Either way the held start follows in this call.
    if [ "$deployed" = "$current" ]; then
      if [ -n "${realigned_active:-}" ]; then
        printf '%s|%s|%s\n' "$deployed" "/opt/zeroed/releases/$deployed" "$deployed" > "$STATE_DIR/switch_unheld"
      else
        rm -f "$STATE_DIR/switch_unheld"
      fi
    else
      printf '%s|%s|%s\n' "$deployed" "$prev" "$current" > "$STATE_DIR/switch_unheld"
    fi
    if [ ! -s "$STATE_DIR/switch_unheld" ]; then flock -u 9 2>/dev/null || true; return 0; fi
    IFS='|' read -r commit prev current < "$STATE_DIR/switch_unheld" || true
  fi
  if systemctl is-active --quiet zeroed-worker.service && { [ -n "$(active_run)" ] || [ "$(cat /var/lib/zeroed/open_intents 2>/dev/null || echo unknown)" != 0 ]; }; then
    flock -u 9 2>/dev/null || true
    # Once per run: the check on the way out would say it again.
    [ -n "${held_wait_logged:-}" ] || log "Waiting on the first held start of ${commit:0:12}: a qualifying dry run is active or the worker has open intents."
    held_wait_logged=1
  else
    dest="/opt/zeroed/releases/$commit"
    held_restart
    log "Started ${commit:0:12} under the hold. Worker: restarted and up."
    notify "Zeroed host: started ${commit:0:12}. Worker restarted and up." || true
  fi
}
# OPS-CLEAN m3: a /pair while this run is active starts this unit, which systemd merges into the run, so every run that
# ends well checks the marker once more on its way out: the held start then comes in the same run, not 5 minutes later.
at_exit() {
  local rc=$?
  trap - EXIT
  [ "$rc" = 0 ] || exit "$rc"
  [ -n "${lock_busy:-}" ] || unheld_start
}

# A holding mark is only ever left by a run that died mid-hold (one zeroed-update runs at a time).
rm -f "$STATE_DIR/holding"
# The probation first, whether GitHub answers or not.
probation_check
unheld_start
trap at_exit EXIT
git -C "$REPO_DIR" fetch --quiet --force --no-tags origin \
  "+refs/tags/deploy:refs/tags/deploy" "+refs/heads/$ZEROED_BRANCH:refs/remotes/origin/$ZEROED_BRANCH" 2>/dev/null || exit 0
commit="$(git -C "$REPO_DIR" rev-parse --verify --quiet 'refs/tags/deploy^{commit}')" || exit 0
current="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
[ "$commit" != "$current" ] || exit 0
# A release that was switched to and rolled back (its worker did not stay up) is not tried again; a newer deploy is.
[ "$commit" != "$(cat "$STATE_DIR/failed_release" 2>/dev/null || true)" ] || exit 0

# GitHub signs every merge it makes with its web-flow key; nothing else is accepted.
status="$(GNUPGHOME=/etc/zeroed/gnupg git -C "$REPO_DIR" verify-commit --raw "$commit" 2>&1 || true)"
signer="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $NF; exit }')"
if [ "$signer" != "$WEB_FLOW_FPR" ] || ! printf '%s\n' "$status" | grep -q '^\[GNUPG:\] GOODSIG '; then
  log "Refused deploy tag ${commit:0:12}: not signed by GitHub's merge key."
  notify "Zeroed host: refused update ${commit:0:12} (signature check failed)." || true
  exit 1
fi
if ! git -C "$REPO_DIR" merge-base --is-ancestor "$commit" "refs/remotes/origin/$ZEROED_BRANCH"; then
  log "Refused deploy tag ${commit:0:12}: not on $ZEROED_BRANCH."
  notify "Zeroed host: refused update ${commit:0:12} (not on $ZEROED_BRANCH)." || true
  exit 1
fi

check_runs() { curl -fsS -m 30 -H 'Accept: application/vnd.github+json' "$ZEROED_API_URL/repos/$ZEROED_REPO/commits/$1/check-runs?per_page=100" || true; }
# The same gate as the Deploy workflow (ops/deploy/tag.sh): named runs from GitHub Actions, never "any green run".
verdict="$(check_runs "$commit" | commit_verdict check)"
if [ "$verdict" = green ]; then
  e2e="$(e2e_commit "$REPO_DIR" "$commit")"
  if [ -z "$e2e" ]; then
    verdict="none: no commit at or before it touched the ops end-to-end paths"
  else
    v="$(check_runs "$e2e" | commit_verdict e2e)"
    [ "$v" = green ] || verdict="${v%%:*}: the ops end-to-end of ${e2e:0:12}: ${v#*: }"
  fi
fi
if [ "$verdict" != green ]; then
  log "Waiting on ${commit:0:12}: its checks are $verdict."
  exit 0
fi

# No deploy while a qualifying dry run is active: one run, one commit (RUN-1's one_commit check).
run="$(active_run)"
if [ -n "$run" ]; then
  log "Waiting on ${commit:0:12}: the qualifying dry run $run is active."
  exit 0
fi

# OPS-CLEAN round 5: a rollback that is due (held by an open intent, position or dry run) goes first; a switch now would
# make the failed release the next one's rollback target. probation_check has already told the owner.
if [ -s "$STATE_DIR/probation" ] && [ -n "$(cut -d'|' -f6 "$STATE_DIR/probation")" ]; then
  log "Waiting on ${commit:0:12}: the rollback of $(cut -c1-12 "$STATE_DIR/probation") is due."
  exit 0
fi

# OPS-CLEAN m2: a running worker that could not start again (a key or the pairing gone) is never left running the old
# release under a new deployed record.
if systemctl is-active --quiet zeroed-worker.service && ! worker_ready; then
  log "Waiting on ${commit:0:12}: the worker runs but a key or the pairing is missing."
  alert worker-unready "ALERT Zeroed host: the worker runs but a key or the Telegram pairing is missing, so update ${commit:0:12} waits. It tries again every 5 minutes."
  exit 0
fi
alert_clear worker-unready "CLEARED Zeroed host: the keys and the pairing are back; updates go ahead."

if systemctl is-active --quiet zeroed-worker.service; then
  open="$(cat /var/lib/zeroed/open_intents 2>/dev/null || echo unknown)"
  if [ "$open" != 0 ]; then
    log "Waiting on ${commit:0:12}: the worker has open intents ($open)."
    exit 0
  fi
fi

dest="/opt/zeroed/releases/$commit"
if [ ! -d "$dest" ]; then
  mkdir -p "$dest.new"
  git -C "$REPO_DIR" archive "$commit" | tar -x -C "$dest.new" --no-same-owner
  mv "$dest.new" "$dest"
fi
# RC-FIXES-2b (red team C R3-1): onto the host's stand-in from a worker that is not, never while a position is open (the
# stand-in runs no exits and reports none): it waits while the worker reports open positions, or the count cannot be
# read, like the intents above.
if [ "$(worker_entry "$dest" 2>/dev/null || true)" = "$STUB_ENTRY" ] && [ "$(worker_entry /opt/zeroed/current 2>/dev/null || true)" != "$STUB_ENTRY" ]; then
  pos="$(cat /var/lib/zeroed/open_positions 2>/dev/null || echo unknown)"
  if [ "$pos" != 0 ]; then
    log "Waiting on ${commit:0:12}: it runs the stand-in, and the worker has open positions ($pos)."
    exit 0
  fi
fi
# The release's own worker must start before anything changes (SWITCH-1): a trial start beside the running worker
# (worker-smoke). If it cannot start, nothing switches, the running worker is untouched, and the owner gets one alert.
if ! why="$(/usr/local/lib/zeroed/worker-smoke "$dest" 2>&1)"; then
  log "The worker of ${commit:0:12} did not start in a trial ($why); still on the old release, trying again next run."
  alert worker-smoke "ALERT Zeroed host: the worker of ${commit:0:12} did not start in a trial ($why), so the server stays on the release it runs. It tries again every 5 minutes."
  exit 1
fi
alert_clear worker-smoke "CLEARED Zeroed host: the worker of ${commit:0:12} starts."
# Host files first: on failure nothing switches and the worker keeps running the release it has.
apply_host "$commit" "$dest" || exit 1
# OPS-CLEAN M1: the host lock from here to the start decision, so a /pair (zeroed-telegram-pair holds the same lock)
# lands wholly before it (the worker can start: held restart below) or wholly after it (it finds switch_unheld and
# starts this unit). Not held earlier: install.sh --update above runs zeroed-check, which takes the lock too.
# OPS-CLEAN m2: a busy lock (a pairing or a check holding it past 60 s) is not a failure: the running release's host files
# go back (best effort, the new ones were applied above) and the next run tries again.
if ! lock; then
  log "Waiting on ${commit:0:12}: the host lock is busy."
  apply_host "${current:-none}" "$(readlink -f /opt/zeroed/current 2>/dev/null || true)" || true
  lock_busy=1
  exit 0
fi
realign_current
# The rollback target is the deployed release (OPS-CLEAN round 4: not whatever release folder current points at, which a
# killed run can leave elsewhere); a folder placed by hand under another name is what runs, and stays the target. A
# release switched to but never started (switch_unheld) is not one: the release that ran before it stays.
prev="/opt/zeroed/releases/$current"
if [ -L /opt/zeroed/current ] && ! [[ "$(basename "$(readlink -f /opt/zeroed/current)")" =~ ^[0-9a-f]{40}$ ]]; then prev="$(readlink -f /opt/zeroed/current)"; fi
if [ -s "$STATE_DIR/switch_unheld" ]; then IFS='|' read -r _ prev current < "$STATE_DIR/switch_unheld" || true; fi
# No deployed release yet (a first deploy): nothing to go back to. Only a real release folder is a rollback target.
{ [ -n "$current" ] && [ -d "$prev" ] && [ ! -L "$prev" ]; } || prev=""
# OPS-CLEAN m1 and round 4: the marker goes down before current moves, whether or not the worker can start now, so no
# crash or reboot between the switch and its hold leaves the release unheld; held_restart removes it. A marker for a
# commit that never became deployed is dropped or rewritten by the next run (unheld_start).
printf '%s|%s|%s\n' "$commit" "$prev" "$current" > "$STATE_DIR/switch_unheld"
# RC-R2-3: a new switch ends the probation of the release before it; RC-FIXES-2b (R3-4): kept aside, so a rollback to
# that release puts it back.
if [ -s "$STATE_DIR/probation" ]; then mv -f "$STATE_DIR/probation" "$STATE_DIR/probation.prev"; else rm -f "$STATE_DIR/probation.prev"; fi
ln -sfn "$dest" /opt/zeroed/current.new
mv -Tf /opt/zeroed/current.new /opt/zeroed/current
printf '%s\n' "$commit" > "$STATE_DIR/deployed"

# Repository switches, applied with each reviewed release (ops/host-config.json).
if [ "$(jq -r '.offsite_backup == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)" = true ]; then
  systemctl enable --now zeroed-backup-offsite.timer >/dev/null 2>&1 || true
else
  systemctl disable --now zeroed-backup-offsite.timer >/dev/null 2>&1 || true
fi
# RECORD-UPLOAD (owner, 2026-10-06 "Approve upload"): sealed recordings to the private data repository, hourly.
if [ "$(jq -r '.record_upload == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)" = true ]; then
  systemctl enable --now zeroed-record-upload.timer >/dev/null 2>&1 || true
else
  systemctl disable --now zeroed-record-upload.timer >/dev/null 2>&1 || true
fi

# Restart with reconcile first (ExecStartPre). Before the keys and the pairing the worker is not started at all: its unit
# would skip the start (ConditionPathExists), the hold would wait for nothing and roll a good release back (OPS-CLEAN,
# 8 Oct). switch_unheld then marks the release, and its first start is held once the worker can start (above). After a
# restart the new worker must stay up, or the server goes back to the release it ran (SWITCH-1).
worker="not started (no keys yet)"
if keys_stored && ! paired; then worker="not started (not paired yet)"; fi
if worker_ready; then
  held_restart
  worker="restarted and up"
else
  flock -u 9 2>/dev/null || true
fi
# HOST-CAPS: old releases go once the new one runs; it, the one before it (the roll-back target) and the 3 newest stay.
# Never during a switch (a rollback exits above); an unreadable current prunes nothing (logic.sh).
# One name per line, never word-split or globbed (prunable_releases lists only 40-hex release folders).
while IFS= read -r old; do
  [ -n "$old" ] && rm -rf -- "$old" && log "Removed the old release $(basename "$old" | cut -c1-12) (HOST-CAPS)."
done < <(prunable_releases /opt/zeroed/releases "$(readlink -f /opt/zeroed/current 2>/dev/null || true)" "$prev" "$commit")
log "Deployed ${commit:0:12}. Worker: $worker."
notify "Zeroed host: deployed ${commit:0:12}. Worker $worker." || true
__ZEROED_FILE__
install_file /usr/local/share/zeroed/eff_large_wordlist.txt 0644 <<'__ZEROED_FILE__'
abacus
abdomen
abdominal
abide
abiding
ability
ablaze
able
abnormal
abrasion
abrasive
abreast
abridge
abroad
abruptly
absence
absentee
absently
absinthe
absolute
absolve
abstain
abstract
absurd
accent
acclaim
acclimate
accompany
account
accuracy
accurate
accustom
acetone
achiness
aching
acid
acorn
acquaint
acquire
acre
acrobat
acronym
acting
action
activate
activator
active
activism
activist
activity
actress
acts
acutely
acuteness
aeration
aerobics
aerosol
aerospace
afar
affair
affected
affecting
affection
affidavit
affiliate
affirm
affix
afflicted
affluent
afford
affront
aflame
afloat
aflutter
afoot
afraid
afterglow
afterlife
aftermath
aftermost
afternoon
aged
ageless
agency
agenda
agent
aggregate
aghast
agile
agility
aging
agnostic
agonize
agonizing
agony
agreeable
agreeably
agreed
agreeing
agreement
aground
ahead
ahoy
aide
aids
aim
ajar
alabaster
alarm
albatross
album
alfalfa
algebra
algorithm
alias
alibi
alienable
alienate
aliens
alike
alive
alkaline
alkalize
almanac
almighty
almost
aloe
aloft
aloha
alone
alongside
aloof
alphabet
alright
although
altitude
alto
aluminum
alumni
always
amaretto
amaze
amazingly
amber
ambiance
ambiguity
ambiguous
ambition
ambitious
ambulance
ambush
amendable
amendment
amends
amenity
amiable
amicably
amid
amigo
amino
amiss
ammonia
ammonium
amnesty
amniotic
among
amount
amperage
ample
amplifier
amplify
amply
amuck
amulet
amusable
amused
amusement
amuser
amusing
anaconda
anaerobic
anagram
anatomist
anatomy
anchor
anchovy
ancient
android
anemia
anemic
aneurism
anew
angelfish
angelic
anger
angled
angler
angles
angling
angrily
angriness
anguished
angular
animal
animate
animating
animation
animator
anime
animosity
ankle
annex
annotate
announcer
annoying
annually
annuity
anointer
another
answering
antacid
antarctic
anteater
antelope
antennae
anthem
anthill
anthology
antibody
antics
antidote
antihero
antiquely
antiques
antiquity
antirust
antitoxic
antitrust
antiviral
antivirus
antler
antonym
antsy
anvil
anybody
anyhow
anymore
anyone
anyplace
anything
anytime
anyway
anywhere
aorta
apache
apostle
appealing
appear
appease
appeasing
appendage
appendix
appetite
appetizer
applaud
applause
apple
appliance
applicant
applied
apply
appointee
appraisal
appraiser
apprehend
approach
approval
approve
apricot
april
apron
aptitude
aptly
aqua
aqueduct
arbitrary
arbitrate
ardently
area
arena
arguable
arguably
argue
arise
armadillo
armband
armchair
armed
armful
armhole
arming
armless
armoire
armored
armory
armrest
army
aroma
arose
around
arousal
arrange
array
arrest
arrival
arrive
arrogance
arrogant
arson
art
ascend
ascension
ascent
ascertain
ashamed
ashen
ashes
ashy
aside
askew
asleep
asparagus
aspect
aspirate
aspire
aspirin
astonish
astound
astride
astrology
astronaut
astronomy
astute
atlantic
atlas
atom
atonable
atop
atrium
atrocious
atrophy
attach
attain
attempt
attendant
attendee
attention
attentive
attest
attic
attire
attitude
attractor
attribute
atypical
auction
audacious
audacity
audible
audibly
audience
audio
audition
augmented
august
authentic
author
autism
autistic
autograph
automaker
automated
automatic
autopilot
available
avalanche
avatar
avenge
avenging
avenue
average
aversion
avert
aviation
aviator
avid
avoid
await
awaken
award
aware
awhile
awkward
awning
awoke
awry
axis
babble
babbling
babied
baboon
backache
backboard
backboned
backdrop
backed
backer
backfield
backfire
backhand
backing
backlands
backlash
backless
backlight
backlit
backlog
backpack
backpedal
backrest
backroom
backshift
backside
backslid
backspace
backspin
backstab
backstage
backtalk
backtrack
backup
backward
backwash
backwater
backyard
bacon
bacteria
bacterium
badass
badge
badland
badly
badness
baffle
baffling
bagel
bagful
baggage
bagged
baggie
bagginess
bagging
baggy
bagpipe
baguette
baked
bakery
bakeshop
baking
balance
balancing
balcony
balmy
balsamic
bamboo
banana
banish
banister
banjo
bankable
bankbook
banked
banker
banking
banknote
bankroll
banner
bannister
banshee
banter
barbecue
barbed
barbell
barber
barcode
barge
bargraph
barista
baritone
barley
barmaid
barman
barn
barometer
barrack
barracuda
barrel
barrette
barricade
barrier
barstool
bartender
barterer
bash
basically
basics
basil
basin
basis
basket
batboy
batch
bath
baton
bats
battalion
battered
battering
battery
batting
battle
bauble
bazooka
blabber
bladder
blade
blah
blame
blaming
blanching
blandness
blank
blaspheme
blasphemy
blast
blatancy
blatantly
blazer
blazing
bleach
bleak
bleep
blemish
blend
bless
blighted
blimp
bling
blinked
blinker
blinking
blinks
blip
blissful
blitz
blizzard
bloated
bloating
blob
blog
bloomers
blooming
blooper
blot
blouse
blubber
bluff
bluish
blunderer
blunt
blurb
blurred
blurry
blurt
blush
blustery
boaster
boastful
boasting
boat
bobbed
bobbing
bobble
bobcat
bobsled
bobtail
bodacious
body
bogged
boggle
bogus
boil
bok
bolster
bolt
bonanza
bonded
bonding
bondless
boned
bonehead
boneless
bonelike
boney
bonfire
bonnet
bonsai
bonus
bony
boogeyman
boogieman
book
boondocks
booted
booth
bootie
booting
bootlace
bootleg
boots
boozy
borax
boring
borough
borrower
borrowing
boss
botanical
botanist
botany
botch
both
bottle
bottling
bottom
bounce
bouncing
bouncy
bounding
boundless
bountiful
bovine
boxcar
boxer
boxing
boxlike
boxy
breach
breath
breeches
breeching
breeder
breeding
breeze
breezy
brethren
brewery
brewing
briar
bribe
brick
bride
bridged
brigade
bright
brilliant
brim
bring
brink
brisket
briskly
briskness
bristle
brittle
broadband
broadcast
broaden
broadly
broadness
broadside
broadways
broiler
broiling
broken
broker
bronchial
bronco
bronze
bronzing
brook
broom
brought
browbeat
brownnose
browse
browsing
bruising
brunch
brunette
brunt
brush
brussels
brute
brutishly
bubble
bubbling
bubbly
buccaneer
bucked
bucket
buckle
buckshot
buckskin
bucktooth
buckwheat
buddhism
buddhist
budding
buddy
budget
buffalo
buffed
buffer
buffing
buffoon
buggy
bulb
bulge
bulginess
bulgur
bulk
bulldog
bulldozer
bullfight
bullfrog
bullhorn
bullion
bullish
bullpen
bullring
bullseye
bullwhip
bully
bunch
bundle
bungee
bunion
bunkbed
bunkhouse
bunkmate
bunny
bunt
busboy
bush
busily
busload
bust
busybody
buzz
cabana
cabbage
cabbie
cabdriver
cable
caboose
cache
cackle
cacti
cactus
caddie
caddy
cadet
cadillac
cadmium
cage
cahoots
cake
calamari
calamity
calcium
calculate
calculus
caliber
calibrate
calm
caloric
calorie
calzone
camcorder
cameo
camera
camisole
camper
campfire
camping
campsite
campus
canal
canary
cancel
candied
candle
candy
cane
canine
canister
cannabis
canned
canning
cannon
cannot
canola
canon
canopener
canopy
canteen
canyon
capable
capably
capacity
cape
capillary
capital
capitol
capped
capricorn
capsize
capsule
caption
captivate
captive
captivity
capture
caramel
carat
caravan
carbon
cardboard
carded
cardiac
cardigan
cardinal
cardstock
carefully
caregiver
careless
caress
caretaker
cargo
caring
carless
carload
carmaker
carnage
carnation
carnival
carnivore
carol
carpenter
carpentry
carpool
carport
carried
carrot
carrousel
carry
cartel
cartload
carton
cartoon
cartridge
cartwheel
carve
carving
carwash
cascade
case
cash
casing
casino
casket
cassette
casually
casualty
catacomb
catalog
catalyst
catalyze
catapult
cataract
catatonic
catcall
catchable
catcher
catching
catchy
caterer
catering
catfight
catfish
cathedral
cathouse
catlike
catnap
catnip
catsup
cattail
cattishly
cattle
catty
catwalk
caucasian
caucus
causal
causation
cause
causing
cauterize
caution
cautious
cavalier
cavalry
caviar
cavity
cedar
celery
celestial
celibacy
celibate
celtic
cement
census
ceramics
ceremony
certainly
certainty
certified
certify
cesarean
cesspool
chafe
chaffing
chain
chair
chalice
challenge
chamber
chamomile
champion
chance
change
channel
chant
chaos
chaperone
chaplain
chapped
chaps
chapter
character
charbroil
charcoal
charger
charging
chariot
charity
charm
charred
charter
charting
chase
chasing
chaste
chastise
chastity
chatroom
chatter
chatting
chatty
cheating
cheddar
cheek
cheer
cheese
cheesy
chef
chemicals
chemist
chemo
cherisher
cherub
chess
chest
chevron
chevy
chewable
chewer
chewing
chewy
chief
chihuahua
childcare
childhood
childish
childless
childlike
chili
chill
chimp
chip
chirping
chirpy
chitchat
chivalry
chive
chloride
chlorine
choice
chokehold
choking
chomp
chooser
choosing
choosy
chop
chosen
chowder
chowtime
chrome
chubby
chuck
chug
chummy
chump
chunk
churn
chute
cider
cilantro
cinch
cinema
cinnamon
circle
circling
circular
circulate
circus
citable
citadel
citation
citizen
citric
citrus
city
civic
civil
clad
claim
clambake
clammy
clamor
clamp
clamshell
clang
clanking
clapped
clapper
clapping
clarify
clarinet
clarity
clash
clasp
class
clatter
clause
clavicle
claw
clay
clean
clear
cleat
cleaver
cleft
clench
clergyman
clerical
clerk
clever
clicker
client
climate
climatic
cling
clinic
clinking
clip
clique
cloak
clobber
clock
clone
cloning
closable
closure
clothes
clothing
cloud
clover
clubbed
clubbing
clubhouse
clump
clumsily
clumsy
clunky
clustered
clutch
clutter
coach
coagulant
coastal
coaster
coasting
coastland
coastline
coat
coauthor
cobalt
cobbler
cobweb
cocoa
coconut
cod
coeditor
coerce
coexist
coffee
cofounder
cognition
cognitive
cogwheel
coherence
coherent
cohesive
coil
coke
cola
cold
coleslaw
coliseum
collage
collapse
collar
collected
collector
collide
collie
collision
colonial
colonist
colonize
colony
colossal
colt
coma
come
comfort
comfy
comic
coming
comma
commence
commend
comment
commerce
commode
commodity
commodore
common
commotion
commute
commuting
compacted
compacter
compactly
compactor
companion
company
compare
compel
compile
comply
component
composed
composer
composite
compost
composure
compound
compress
comprised
computer
computing
comrade
concave
conceal
conceded
concept
concerned
concert
conch
concierge
concise
conclude
concrete
concur
condense
condiment
condition
condone
conducive
conductor
conduit
cone
confess
confetti
confidant
confident
confider
confiding
configure
confined
confining
confirm
conflict
conform
confound
confront
confused
confusing
confusion
congenial
congested
congrats
congress
conical
conjoined
conjure
conjuror
connected
connector
consensus
consent
console
consoling
consonant
constable
constant
constrain
constrict
construct
consult
consumer
consuming
contact
container
contempt
contend
contented
contently
contents
contest
context
contort
contour
contrite
control
contusion
convene
convent
copartner
cope
copied
copier
copilot
coping
copious
copper
copy
coral
cork
cornball
cornbread
corncob
cornea
corned
corner
cornfield
cornflake
cornhusk
cornmeal
cornstalk
corny
coronary
coroner
corporal
corporate
corral
correct
corridor
corrode
corroding
corrosive
corsage
corset
cortex
cosigner
cosmetics
cosmic
cosmos
cosponsor
cost
cottage
cotton
couch
cough
could
countable
countdown
counting
countless
country
county
courier
covenant
cover
coveted
coveting
coyness
cozily
coziness
cozy
crabbing
crabgrass
crablike
crabmeat
cradle
cradling
crafter
craftily
craftsman
craftwork
crafty
cramp
cranberry
crane
cranial
cranium
crank
crate
crave
craving
crawfish
crawlers
crawling
crayfish
crayon
crazed
crazily
craziness
crazy
creamed
creamer
creamlike
crease
creasing
creatable
create
creation
creative
creature
credible
credibly
credit
creed
creme
creole
crepe
crept
crescent
crested
cresting
crestless
crevice
crewless
crewman
crewmate
crib
cricket
cried
crier
crimp
crimson
cringe
cringing
crinkle
crinkly
crisped
crisping
crisply
crispness
crispy
criteria
critter
croak
crock
crook
croon
crop
cross
crouch
crouton
crowbar
crowd
crown
crucial
crudely
crudeness
cruelly
cruelness
cruelty
crumb
crummiest
crummy
crumpet
crumpled
cruncher
crunching
crunchy
crusader
crushable
crushed
crusher
crushing
crust
crux
crying
cryptic
crystal
cubbyhole
cube
cubical
cubicle
cucumber
cuddle
cuddly
cufflink
culinary
culminate
culpable
culprit
cultivate
cultural
culture
cupbearer
cupcake
cupid
cupped
cupping
curable
curator
curdle
cure
curfew
curing
curled
curler
curliness
curling
curly
curry
curse
cursive
cursor
curtain
curtly
curtsy
curvature
curve
curvy
cushy
cusp
cussed
custard
custodian
custody
customary
customer
customize
customs
cut
cycle
cyclic
cycling
cyclist
cylinder
cymbal
cytoplasm
cytoplast
dab
dad
daffodil
dagger
daily
daintily
dainty
dairy
daisy
dallying
dance
dancing
dandelion
dander
dandruff
dandy
danger
dangle
dangling
daredevil
dares
daringly
darkened
darkening
darkish
darkness
darkroom
darling
darn
dart
darwinism
dash
dastardly
data
datebook
dating
daughter
daunting
dawdler
dawn
daybed
daybreak
daycare
daydream
daylight
daylong
dayroom
daytime
dazzler
dazzling
deacon
deafening
deafness
dealer
dealing
dealmaker
dealt
dean
debatable
debate
debating
debit
debrief
debtless
debtor
debug
debunk
decade
decaf
decal
decathlon
decay
deceased
deceit
deceiver
deceiving
december
decency
decent
deception
deceptive
decibel
decidable
decimal
decimeter
decipher
deck
declared
decline
decode
decompose
decorated
decorator
decoy
decrease
decree
dedicate
dedicator
deduce
deduct
deed
deem
deepen
deeply
deepness
deface
defacing
defame
default
defeat
defection
defective
defendant
defender
defense
defensive
deferral
deferred
defiance
defiant
defile
defiling
define
definite
deflate
deflation
deflator
deflected
deflector
defog
deforest
defraud
defrost
deftly
defuse
defy
degraded
degrading
degrease
degree
dehydrate
deity
dejected
delay
delegate
delegator
delete
deletion
delicacy
delicate
delicious
delighted
delirious
delirium
deliverer
delivery
delouse
delta
deluge
delusion
deluxe
demanding
demeaning
demeanor
demise
democracy
democrat
demote
demotion
demystify
denatured
deniable
denial
denim
denote
dense
density
dental
dentist
denture
deny
deodorant
deodorize
departed
departure
depict
deplete
depletion
deplored
deploy
deport
depose
depraved
depravity
deprecate
depress
deprive
depth
deputize
deputy
derail
deranged
derby
derived
desecrate
deserve
deserving
designate
designed
designer
designing
deskbound
desktop
deskwork
desolate
despair
despise
despite
destiny
destitute
destruct
detached
detail
detection
detective
detector
detention
detergent
detest
detonate
detonator
detoxify
detract
deuce
devalue
deviancy
deviant
deviate
deviation
deviator
device
devious
devotedly
devotee
devotion
devourer
devouring
devoutly
dexterity
dexterous
diabetes
diabetic
diabolic
diagnoses
diagnosis
diagram
dial
diameter
diaper
diaphragm
diary
dice
dicing
dictate
dictation
dictator
difficult
diffused
diffuser
diffusion
diffusive
dig
dilation
diligence
diligent
dill
dilute
dime
diminish
dimly
dimmed
dimmer
dimness
dimple
diner
dingbat
dinghy
dinginess
dingo
dingy
dining
dinner
diocese
dioxide
diploma
dipped
dipper
dipping
directed
direction
directive
directly
directory
direness
dirtiness
disabled
disagree
disallow
disarm
disarray
disaster
disband
disbelief
disburse
discard
discern
discharge
disclose
discolor
discount
discourse
discover
discuss
disdain
disengage
disfigure
disgrace
dish
disinfect
disjoin
disk
dislike
disliking
dislocate
dislodge
disloyal
dismantle
dismay
dismiss
dismount
disobey
disorder
disown
disparate
disparity
dispatch
dispense
dispersal
dispersed
disperser
displace
display
displease
disposal
dispose
disprove
dispute
disregard
disrupt
dissuade
distance
distant
distaste
distill
distinct
distort
distract
distress
district
distrust
ditch
ditto
ditzy
dividable
divided
dividend
dividers
dividing
divinely
diving
divinity
divisible
divisibly
division
divisive
divorcee
dizziness
dizzy
doable
docile
dock
doctrine
document
dodge
dodgy
doily
doing
dole
dollar
dollhouse
dollop
dolly
dolphin
domain
domelike
domestic
dominion
dominoes
donated
donation
donator
donor
donut
doodle
doorbell
doorframe
doorknob
doorman
doormat
doornail
doorpost
doorstep
doorstop
doorway
doozy
dork
dormitory
dorsal
dosage
dose
dotted
doubling
douche
dove
down
dowry
doze
drab
dragging
dragonfly
dragonish
dragster
drainable
drainage
drained
drainer
drainpipe
dramatic
dramatize
drank
drapery
drastic
draw
dreaded
dreadful
dreadlock
dreamboat
dreamily
dreamland
dreamless
dreamlike
dreamt
dreamy
drearily
dreary
drench
dress
drew
dribble
dried
drier
drift
driller
drilling
drinkable
drinking
dripping
drippy
drivable
driven
driver
driveway
driving
drizzle
drizzly
drone
drool
droop
drop-down
dropbox
dropkick
droplet
dropout
dropper
drove
drown
drowsily
drudge
drum
dry
dubbed
dubiously
duchess
duckbill
ducking
duckling
ducktail
ducky
duct
dude
duffel
dugout
duh
duke
duller
dullness
duly
dumping
dumpling
dumpster
duo
dupe
duplex
duplicate
duplicity
durable
durably
duration
duress
during
dusk
dust
dutiful
duty
duvet
dwarf
dweeb
dwelled
dweller
dwelling
dwindle
dwindling
dynamic
dynamite
dynasty
dyslexia
dyslexic
each
eagle
earache
eardrum
earflap
earful
earlobe
early
earmark
earmuff
earphone
earpiece
earplugs
earring
earshot
earthen
earthlike
earthling
earthly
earthworm
earthy
earwig
easeful
easel
easiest
easily
easiness
easing
eastbound
eastcoast
easter
eastward
eatable
eaten
eatery
eating
eats
ebay
ebony
ebook
ecard
eccentric
echo
eclair
eclipse
ecologist
ecology
economic
economist
economy
ecosphere
ecosystem
edge
edginess
edging
edgy
edition
editor
educated
education
educator
eel
effective
effects
efficient
effort
eggbeater
egging
eggnog
eggplant
eggshell
egomaniac
egotism
egotistic
either
eject
elaborate
elastic
elated
elbow
eldercare
elderly
eldest
electable
election
elective
elephant
elevate
elevating
elevation
elevator
eleven
elf
eligible
eligibly
eliminate
elite
elitism
elixir
elk
ellipse
elliptic
elm
elongated
elope
eloquence
eloquent
elsewhere
elude
elusive
elves
email
embargo
embark
embassy
embattled
embellish
ember
embezzle
emblaze
emblem
embody
embolism
emboss
embroider
emcee
emerald
emergency
emission
emit
emote
emoticon
emotion
empathic
empathy
emperor
emphases
emphasis
emphasize
emphatic
empirical
employed
employee
employer
emporium
empower
emptier
emptiness
empty
emu
enable
enactment
enamel
enchanted
enchilada
encircle
enclose
enclosure
encode
encore
encounter
encourage
encroach
encrust
encrypt
endanger
endeared
endearing
ended
ending
endless
endnote
endocrine
endorphin
endorse
endowment
endpoint
endurable
endurance
enduring
energetic
energize
energy
enforced
enforcer
engaged
engaging
engine
engorge
engraved
engraver
engraving
engross
engulf
enhance
enigmatic
enjoyable
enjoyably
enjoyer
enjoying
enjoyment
enlarged
enlarging
enlighten
enlisted
enquirer
enrage
enrich
enroll
enslave
ensnare
ensure
entail
entangled
entering
entertain
enticing
entire
entitle
entity
entomb
entourage
entrap
entree
entrench
entrust
entryway
entwine
enunciate
envelope
enviable
enviably
envious
envision
envoy
envy
enzyme
epic
epidemic
epidermal
epidermis
epidural
epilepsy
epileptic
epilogue
epiphany
episode
equal
equate
equation
equator
equinox
equipment
equity
equivocal
eradicate
erasable
erased
eraser
erasure
ergonomic
errand
errant
erratic
error
erupt
escalate
escalator
escapable
escapade
escapist
escargot
eskimo
esophagus
espionage
espresso
esquire
essay
essence
essential
establish
estate
esteemed
estimate
estimator
estranged
estrogen
etching
eternal
eternity
ethanol
ether
ethically
ethics
euphemism
evacuate
evacuee
evade
evaluate
evaluator
evaporate
evasion
evasive
even
everglade
evergreen
everybody
everyday
everyone
evict
evidence
evident
evil
evoke
evolution
evolve
exact
exalted
example
excavate
excavator
exceeding
exception
excess
exchange
excitable
exciting
exclaim
exclude
excluding
exclusion
exclusive
excretion
excretory
excursion
excusable
excusably
excuse
exemplary
exemplify
exemption
exerciser
exert
exes
exfoliate
exhale
exhaust
exhume
exile
existing
exit
exodus
exonerate
exorcism
exorcist
expand
expanse
expansion
expansive
expectant
expedited
expediter
expel
expend
expenses
expensive
expert
expire
expiring
explain
expletive
explicit
explode
exploit
explore
exploring
exponent
exporter
exposable
expose
exposure
express
expulsion
exquisite
extended
extending
extent
extenuate
exterior
external
extinct
extortion
extradite
extras
extrovert
extrude
extruding
exuberant
fable
fabric
fabulous
facebook
facecloth
facedown
faceless
facelift
faceplate
faceted
facial
facility
facing
facsimile
faction
factoid
factor
factsheet
factual
faculty
fade
fading
failing
falcon
fall
false
falsify
fame
familiar
family
famine
famished
fanatic
fancied
fanciness
fancy
fanfare
fang
fanning
fantasize
fantastic
fantasy
fascism
fastball
faster
fasting
fastness
faucet
favorable
favorably
favored
favoring
favorite
fax
feast
federal
fedora
feeble
feed
feel
feisty
feline
felt-tip
feminine
feminism
feminist
feminize
femur
fence
fencing
fender
ferment
fernlike
ferocious
ferocity
ferret
ferris
ferry
fervor
fester
festival
festive
festivity
fetal
fetch
fever
fiber
fiction
fiddle
fiddling
fidelity
fidgeting
fidgety
fifteen
fifth
fiftieth
fifty
figment
figure
figurine
filing
filled
filler
filling
film
filter
filth
filtrate
finale
finalist
finalize
finally
finance
financial
finch
fineness
finer
finicky
finished
finisher
finishing
finite
finless
finlike
fiscally
fit
five
flaccid
flagman
flagpole
flagship
flagstick
flagstone
flail
flakily
flaky
flame
flammable
flanked
flanking
flannels
flap
flaring
flashback
flashbulb
flashcard
flashily
flashing
flashy
flask
flatbed
flatfoot
flatly
flatness
flatten
flattered
flatterer
flattery
flattop
flatware
flatworm
flavored
flavorful
flavoring
flaxseed
fled
fleshed
fleshy
flick
flier
flight
flinch
fling
flint
flip
flirt
float
flock
flogging
flop
floral
florist
floss
flounder
flyable
flyaway
flyer
flying
flyover
flypaper
foam
foe
fog
foil
folic
folk
follicle
follow
fondling
fondly
fondness
fondue
font
food
fool
footage
football
footbath
footboard
footer
footgear
foothill
foothold
footing
footless
footman
footnote
footpad
footpath
footprint
footrest
footsie
footsore
footwear
footwork
fossil
foster
founder
founding
fountain
fox
foyer
fraction
fracture
fragile
fragility
fragment
fragrance
fragrant
frail
frame
framing
frantic
fraternal
frayed
fraying
frays
freckled
freckles
freebase
freebee
freebie
freedom
freefall
freehand
freeing
freeload
freely
freemason
freeness
freestyle
freeware
freeway
freewill
freezable
freezing
freight
french
frenzied
frenzy
frequency
frequent
fresh
fretful
fretted
friction
friday
fridge
fried
friend
frighten
frightful
frigidity
frigidly
frill
fringe
frisbee
frisk
fritter
frivolous
frolic
from
front
frostbite
frosted
frostily
frosting
frostlike
frosty
froth
frown
frozen
fructose
frugality
frugally
fruit
frustrate
frying
gab
gaffe
gag
gainfully
gaining
gains
gala
gallantly
galleria
gallery
galley
gallon
gallows
gallstone
galore
galvanize
gambling
game
gaming
gamma
gander
gangly
gangrene
gangway
gap
garage
garbage
garden
gargle
garland
garlic
garment
garnet
garnish
garter
gas
gatherer
gathering
gating
gauging
gauntlet
gauze
gave
gawk
gazing
gear
gecko
geek
geiger
gem
gender
generic
generous
genetics
genre
gentile
gentleman
gently
gents
geography
geologic
geologist
geology
geometric
geometry
geranium
gerbil
geriatric
germicide
germinate
germless
germproof
gestate
gestation
gesture
getaway
getting
getup
giant
gibberish
giblet
giddily
giddiness
giddy
gift
gigabyte
gigahertz
gigantic
giggle
giggling
giggly
gigolo
gilled
gills
gimmick
girdle
giveaway
given
giver
giving
gizmo
gizzard
glacial
glacier
glade
gladiator
gladly
glamorous
glamour
glance
glancing
glandular
glare
glaring
glass
glaucoma
glazing
gleaming
gleeful
glider
gliding
glimmer
glimpse
glisten
glitch
glitter
glitzy
gloater
gloating
gloomily
gloomy
glorified
glorifier
glorify
glorious
glory
gloss
glove
glowing
glowworm
glucose
glue
gluten
glutinous
glutton
gnarly
gnat
goal
goatskin
goes
goggles
going
goldfish
goldmine
goldsmith
golf
goliath
gonad
gondola
gone
gong
good
gooey
goofball
goofiness
goofy
google
goon
gopher
gore
gorged
gorgeous
gory
gosling
gossip
gothic
gotten
gout
gown
grab
graceful
graceless
gracious
gradation
graded
grader
gradient
grading
gradually
graduate
graffiti
grafted
grafting
grain
granddad
grandkid
grandly
grandma
grandpa
grandson
granite
granny
granola
grant
granular
grape
graph
grapple
grappling
grasp
grass
gratified
gratify
grating
gratitude
gratuity
gravel
graveness
graves
graveyard
gravitate
gravity
gravy
gray
grazing
greasily
greedily
greedless
greedy
green
greeter
greeting
grew
greyhound
grid
grief
grievance
grieving
grievous
grill
grimace
grimacing
grime
griminess
grimy
grinch
grinning
grip
gristle
grit
groggily
groggy
groin
groom
groove
grooving
groovy
grope
ground
grouped
grout
grove
grower
growing
growl
grub
grudge
grudging
grueling
gruffly
grumble
grumbling
grumbly
grumpily
grunge
grunt
guacamole
guidable
guidance
guide
guiding
guileless
guise
gulf
gullible
gully
gulp
gumball
gumdrop
gumminess
gumming
gummy
gurgle
gurgling
guru
gush
gusto
gusty
gutless
guts
gutter
guy
guzzler
gyration
habitable
habitant
habitat
habitual
hacked
hacker
hacking
hacksaw
had
haggler
haiku
half
halogen
halt
halved
halves
hamburger
hamlet
hammock
hamper
hamster
hamstring
handbag
handball
handbook
handbrake
handcart
handclap
handclasp
handcraft
handcuff
handed
handful
handgrip
handgun
handheld
handiness
handiwork
handlebar
handled
handler
handling
handmade
handoff
handpick
handprint
handrail
handsaw
handset
handsfree
handshake
handstand
handwash
handwork
handwoven
handwrite
handyman
hangnail
hangout
hangover
hangup
hankering
hankie
hanky
haphazard
happening
happier
happiest
happily
happiness
happy
harbor
hardcopy
hardcore
hardcover
harddisk
hardened
hardener
hardening
hardhat
hardhead
hardiness
hardly
hardness
hardship
hardware
hardwired
hardwood
hardy
harmful
harmless
harmonica
harmonics
harmonize
harmony
harness
harpist
harsh
harvest
hash
hassle
haste
hastily
hastiness
hasty
hatbox
hatchback
hatchery
hatchet
hatching
hatchling
hate
hatless
hatred
haunt
haven
hazard
hazelnut
hazily
haziness
hazing
hazy
headache
headband
headboard
headcount
headdress
headed
header
headfirst
headgear
heading
headlamp
headless
headlock
headphone
headpiece
headrest
headroom
headscarf
headset
headsman
headstand
headstone
headway
headwear
heap
heat
heave
heavily
heaviness
heaving
hedge
hedging
heftiness
hefty
helium
helmet
helper
helpful
helping
helpless
helpline
hemlock
hemstitch
hence
henchman
henna
herald
herbal
herbicide
herbs
heritage
hermit
heroics
heroism
herring
herself
hertz
hesitancy
hesitant
hesitate
hexagon
hexagram
hubcap
huddle
huddling
huff
hug
hula
hulk
hull
human
humble
humbling
humbly
humid
humiliate
humility
humming
hummus
humongous
humorist
humorless
humorous
humpback
humped
humvee
hunchback
hundredth
hunger
hungrily
hungry
hunk
hunter
hunting
huntress
huntsman
hurdle
hurled
hurler
hurling
hurray
hurricane
hurried
hurry
hurt
husband
hush
husked
huskiness
hut
hybrid
hydrant
hydrated
hydration
hydrogen
hydroxide
hyperlink
hypertext
hyphen
hypnoses
hypnosis
hypnotic
hypnotism
hypnotist
hypnotize
hypocrisy
hypocrite
ibuprofen
ice
iciness
icing
icky
icon
icy
idealism
idealist
idealize
ideally
idealness
identical
identify
identity
ideology
idiocy
idiom
idly
igloo
ignition
ignore
iguana
illicitly
illusion
illusive
image
imaginary
imagines
imaging
imbecile
imitate
imitation
immature
immerse
immersion
imminent
immobile
immodest
immorally
immortal
immovable
immovably
immunity
immunize
impaired
impale
impart
impatient
impeach
impeding
impending
imperfect
imperial
impish
implant
implement
implicate
implicit
implode
implosion
implosive
imply
impolite
important
importer
impose
imposing
impotence
impotency
impotent
impound
imprecise
imprint
imprison
impromptu
improper
improve
improving
improvise
imprudent
impulse
impulsive
impure
impurity
iodine
iodize
ion
ipad
iphone
ipod
irate
irk
iron
irregular
irrigate
irritable
irritably
irritant
irritate
islamic
islamist
isolated
isolating
isolation
isotope
issue
issuing
italicize
italics
item
itinerary
itunes
ivory
ivy
jab
jackal
jacket
jackknife
jackpot
jailbird
jailbreak
jailer
jailhouse
jalapeno
jam
janitor
january
jargon
jarring
jasmine
jaundice
jaunt
java
jawed
jawless
jawline
jaws
jaybird
jaywalker
jazz
jeep
jeeringly
jellied
jelly
jersey
jester
jet
jiffy
jigsaw
jimmy
jingle
jingling
jinx
jitters
jittery
job
jockey
jockstrap
jogger
jogging
john
joining
jokester
jokingly
jolliness
jolly
jolt
jot
jovial
joyfully
joylessly
joyous
joyride
joystick
jubilance
jubilant
judge
judgingly
judicial
judiciary
judo
juggle
juggling
jugular
juice
juiciness
juicy
jujitsu
jukebox
july
jumble
jumbo
jump
junction
juncture
june
junior
juniper
junkie
junkman
junkyard
jurist
juror
jury
justice
justifier
justify
justly
justness
juvenile
kabob
kangaroo
karaoke
karate
karma
kebab
keenly
keenness
keep
keg
kelp
kennel
kept
kerchief
kerosene
kettle
kick
kiln
kilobyte
kilogram
kilometer
kilowatt
kilt
kimono
kindle
kindling
kindly
kindness
kindred
kinetic
kinfolk
king
kinship
kinsman
kinswoman
kissable
kisser
kissing
kitchen
kite
kitten
kitty
kiwi
kleenex
knapsack
knee
knelt
knickers
knoll
koala
kooky
kosher
krypton
kudos
kung
labored
laborer
laboring
laborious
labrador
ladder
ladies
ladle
ladybug
ladylike
lagged
lagging
lagoon
lair
lake
lance
landed
landfall
landfill
landing
landlady
landless
landline
landlord
landmark
landmass
landmine
landowner
landscape
landside
landslide
language
lankiness
lanky
lantern
lapdog
lapel
lapped
lapping
laptop
lard
large
lark
lash
lasso
last
latch
late
lather
latitude
latrine
latter
latticed
launch
launder
laundry
laurel
lavender
lavish
laxative
lazily
laziness
lazy
lecturer
left
legacy
legal
legend
legged
leggings
legible
legibly
legislate
lego
legroom
legume
legwarmer
legwork
lemon
lend
length
lens
lent
leotard
lesser
letdown
lethargic
lethargy
letter
lettuce
level
leverage
levers
levitate
levitator
liability
liable
liberty
librarian
library
licking
licorice
lid
life
lifter
lifting
liftoff
ligament
likely
likeness
likewise
liking
lilac
lilly
lily
limb
limeade
limelight
limes
limit
limping
limpness
line
lingo
linguini
linguist
lining
linked
linoleum
linseed
lint
lion
lip
liquefy
liqueur
liquid
lisp
list
litigate
litigator
litmus
litter
little
livable
lived
lively
liver
livestock
lividly
living
lizard
lubricant
lubricate
lucid
luckily
luckiness
luckless
lucrative
ludicrous
lugged
lukewarm
lullaby
lumber
luminance
luminous
lumpiness
lumping
lumpish
lunacy
lunar
lunchbox
luncheon
lunchroom
lunchtime
lung
lurch
lure
luridness
lurk
lushly
lushness
luster
lustfully
lustily
lustiness
lustrous
lusty
luxurious
luxury
lying
lyrically
lyricism
lyricist
lyrics
macarena
macaroni
macaw
mace
machine
machinist
magazine
magenta
maggot
magical
magician
magma
magnesium
magnetic
magnetism
magnetize
magnifier
magnify
magnitude
magnolia
mahogany
maimed
majestic
majesty
majorette
majority
makeover
maker
makeshift
making
malformed
malt
mama
mammal
mammary
mammogram
manager
managing
manatee
mandarin
mandate
mandatory
mandolin
manger
mangle
mango
mangy
manhandle
manhole
manhood
manhunt
manicotti
manicure
manifesto
manila
mankind
manlike
manliness
manly
manmade
manned
mannish
manor
manpower
mantis
mantra
manual
many
map
marathon
marauding
marbled
marbles
marbling
march
mardi
margarine
margarita
margin
marigold
marina
marine
marital
maritime
marlin
marmalade
maroon
married
marrow
marry
marshland
marshy
marsupial
marvelous
marxism
mascot
masculine
mashed
mashing
massager
masses
massive
mastiff
matador
matchbook
matchbox
matcher
matching
matchless
material
maternal
maternity
math
mating
matriarch
matrimony
matrix
matron
matted
matter
maturely
maturing
maturity
mauve
maverick
maximize
maximum
maybe
mayday
mayflower
moaner
moaning
mobile
mobility
mobilize
mobster
mocha
mocker
mockup
modified
modify
modular
modulator
module
moisten
moistness
moisture
molar
molasses
mold
molecular
molecule
molehill
mollusk
mom
monastery
monday
monetary
monetize
moneybags
moneyless
moneywise
mongoose
mongrel
monitor
monkhood
monogamy
monogram
monologue
monopoly
monorail
monotone
monotype
monoxide
monsieur
monsoon
monstrous
monthly
monument
moocher
moodiness
moody
mooing
moonbeam
mooned
moonlight
moonlike
moonlit
moonrise
moonscape
moonshine
moonstone
moonwalk
mop
morale
morality
morally
morbidity
morbidly
morphine
morphing
morse
mortality
mortally
mortician
mortified
mortify
mortuary
mosaic
mossy
most
mothball
mothproof
motion
motivate
motivator
motive
motocross
motor
motto
mountable
mountain
mounted
mounting
mourner
mournful
mouse
mousiness
moustache
mousy
mouth
movable
move
movie
moving
mower
mowing
much
muck
mud
mug
mulberry
mulch
mule
mulled
mullets
multiple
multiply
multitask
multitude
mumble
mumbling
mumbo
mummified
mummify
mummy
mumps
munchkin
mundane
municipal
muppet
mural
murkiness
murky
murmuring
muscular
museum
mushily
mushiness
mushroom
mushy
music
musket
muskiness
musky
mustang
mustard
muster
mustiness
musty
mutable
mutate
mutation
mute
mutilated
mutilator
mutiny
mutt
mutual
muzzle
myself
myspace
mystified
mystify
myth
nacho
nag
nail
name
naming
nanny
nanometer
nape
napkin
napped
napping
nappy
narrow
nastily
nastiness
national
native
nativity
natural
nature
naturist
nautical
navigate
navigator
navy
nearby
nearest
nearly
nearness
neatly
neatness
nebula
nebulizer
nectar
negate
negation
negative
neglector
negligee
negligent
negotiate
nemeses
nemesis
neon
nephew
nerd
nervous
nervy
nest
net
neurology
neuron
neurosis
neurotic
neuter
neutron
never
next
nibble
nickname
nicotine
niece
nifty
nimble
nimbly
nineteen
ninetieth
ninja
nintendo
ninth
nuclear
nuclei
nucleus
nugget
nullify
number
numbing
numbly
numbness
numeral
numerate
numerator
numeric
numerous
nuptials
nursery
nursing
nurture
nutcase
nutlike
nutmeg
nutrient
nutshell
nuttiness
nutty
nuzzle
nylon
oaf
oak
oasis
oat
obedience
obedient
obituary
object
obligate
obliged
oblivion
oblivious
oblong
obnoxious
oboe
obscure
obscurity
observant
observer
observing
obsessed
obsession
obsessive
obsolete
obstacle
obstinate
obstruct
obtain
obtrusive
obtuse
obvious
occultist
occupancy
occupant
occupier
occupy
ocean
ocelot
octagon
octane
october
octopus
ogle
oil
oink
ointment
okay
old
olive
olympics
omega
omen
ominous
omission
omit
omnivore
onboard
oncoming
ongoing
onion
online
onlooker
only
onscreen
onset
onshore
onslaught
onstage
onto
onward
onyx
oops
ooze
oozy
opacity
opal
open
operable
operate
operating
operation
operative
operator
opium
opossum
opponent
oppose
opposing
opposite
oppressed
oppressor
opt
opulently
osmosis
other
otter
ouch
ought
ounce
outage
outback
outbid
outboard
outbound
outbreak
outburst
outcast
outclass
outcome
outdated
outdoors
outer
outfield
outfit
outflank
outgoing
outgrow
outhouse
outing
outlast
outlet
outline
outlook
outlying
outmatch
outmost
outnumber
outplayed
outpost
outpour
output
outrage
outrank
outreach
outright
outscore
outsell
outshine
outshoot
outsider
outskirts
outsmart
outsource
outspoken
outtakes
outthink
outward
outweigh
outwit
oval
ovary
oven
overact
overall
overarch
overbid
overbill
overbite
overblown
overboard
overbook
overbuilt
overcast
overcoat
overcome
overcook
overcrowd
overdraft
overdrawn
overdress
overdrive
overdue
overeager
overeater
overexert
overfed
overfeed
overfill
overflow
overfull
overgrown
overhand
overhang
overhaul
overhead
overhear
overheat
overhung
overjoyed
overkill
overlabor
overlaid
overlap
overlay
overload
overlook
overlord
overlying
overnight
overpass
overpay
overplant
overplay
overpower
overprice
overrate
overreach
overreact
override
overripe
overrule
overrun
overshoot
overshot
oversight
oversized
oversleep
oversold
overspend
overstate
overstay
overstep
overstock
overstuff
oversweet
overtake
overthrow
overtime
overtly
overtone
overture
overturn
overuse
overvalue
overview
overwrite
owl
oxford
oxidant
oxidation
oxidize
oxidizing
oxygen
oxymoron
oyster
ozone
paced
pacemaker
pacific
pacifier
pacifism
pacifist
pacify
padded
padding
paddle
paddling
padlock
pagan
pager
paging
pajamas
palace
palatable
palm
palpable
palpitate
paltry
pampered
pamperer
pampers
pamphlet
panama
pancake
pancreas
panda
pandemic
pang
panhandle
panic
panning
panorama
panoramic
panther
pantomime
pantry
pants
pantyhose
paparazzi
papaya
paper
paprika
papyrus
parabola
parachute
parade
paradox
paragraph
parakeet
paralegal
paralyses
paralysis
paralyze
paramedic
parameter
paramount
parasail
parasite
parasitic
parcel
parched
parchment
pardon
parish
parka
parking
parkway
parlor
parmesan
parole
parrot
parsley
parsnip
partake
parted
parting
partition
partly
partner
partridge
party
passable
passably
passage
passcode
passenger
passerby
passing
passion
passive
passivism
passover
passport
password
pasta
pasted
pastel
pastime
pastor
pastrami
pasture
pasty
patchwork
patchy
paternal
paternity
path
patience
patient
patio
patriarch
patriot
patrol
patronage
patronize
pauper
pavement
paver
pavestone
pavilion
paving
pawing
payable
payback
paycheck
payday
payee
payer
paying
payment
payphone
payroll
pebble
pebbly
pecan
pectin
peculiar
peddling
pediatric
pedicure
pedigree
pedometer
pegboard
pelican
pellet
pelt
pelvis
penalize
penalty
pencil
pendant
pending
penholder
penknife
pennant
penniless
penny
penpal
pension
pentagon
pentagram
pep
perceive
percent
perch
percolate
perennial
perfected
perfectly
perfume
periscope
perish
perjurer
perjury
perkiness
perky
perm
peroxide
perpetual
perplexed
persecute
persevere
persuaded
persuader
pesky
peso
pessimism
pessimist
pester
pesticide
petal
petite
petition
petri
petroleum
petted
petticoat
pettiness
petty
petunia
phantom
phobia
phoenix
phonebook
phoney
phonics
phoniness
phony
phosphate
photo
phrase
phrasing
placard
placate
placidly
plank
planner
plant
plasma
plaster
plastic
plated
platform
plating
platinum
platonic
platter
platypus
plausible
plausibly
playable
playback
player
playful
playgroup
playhouse
playing
playlist
playmaker
playmate
playoff
playpen
playroom
playset
plaything
playtime
plaza
pleading
pleat
pledge
plentiful
plenty
plethora
plexiglas
pliable
plod
plop
plot
plow
ploy
pluck
plug
plunder
plunging
plural
plus
plutonium
plywood
poach
pod
poem
poet
pogo
pointed
pointer
pointing
pointless
pointy
poise
poison
poker
poking
polar
police
policy
polio
polish
politely
polka
polo
polyester
polygon
polygraph
polymer
poncho
pond
pony
popcorn
pope
poplar
popper
poppy
popsicle
populace
popular
populate
porcupine
pork
porous
porridge
portable
portal
portfolio
porthole
portion
portly
portside
poser
posh
posing
possible
possibly
possum
postage
postal
postbox
postcard
posted
poster
posting
postnasal
posture
postwar
pouch
pounce
pouncing
pound
pouring
pout
powdered
powdering
powdery
power
powwow
pox
praising
prance
prancing
pranker
prankish
prankster
prayer
praying
preacher
preaching
preachy
preamble
precinct
precise
precision
precook
precut
predator
predefine
predict
preface
prefix
preflight
preformed
pregame
pregnancy
pregnant
preheated
prelaunch
prelaw
prelude
premiere
premises
premium
prenatal
preoccupy
preorder
prepaid
prepay
preplan
preppy
preschool
prescribe
preseason
preset
preshow
president
presoak
press
presume
presuming
preteen
pretended
pretender
pretense
pretext
pretty
pretzel
prevail
prevalent
prevent
preview
previous
prewar
prewashed
prideful
pried
primal
primarily
primary
primate
primer
primp
princess
print
prior
prism
prison
prissy
pristine
privacy
private
privatize
prize
proactive
probable
probably
probation
probe
probing
probiotic
problem
procedure
process
proclaim
procreate
procurer
prodigal
prodigy
produce
product
profane
profanity
professed
professor
profile
profound
profusely
progeny
prognosis
program
progress
projector
prologue
prolonged
promenade
prominent
promoter
promotion
prompter
promptly
prone
prong
pronounce
pronto
proofing
proofread
proofs
propeller
properly
property
proponent
proposal
propose
props
prorate
protector
protegee
proton
prototype
protozoan
protract
protrude
proud
provable
proved
proven
provided
provider
providing
province
proving
provoke
provoking
provolone
prowess
prowler
prowling
proximity
proxy
prozac
prude
prudishly
prune
pruning
pry
psychic
public
publisher
pucker
pueblo
pug
pull
pulmonary
pulp
pulsate
pulse
pulverize
puma
pumice
pummel
punch
punctual
punctuate
punctured
pungent
punisher
punk
pupil
puppet
puppy
purchase
pureblood
purebred
purely
pureness
purgatory
purge
purging
purifier
purify
purist
puritan
purity
purple
purplish
purposely
purr
purse
pursuable
pursuant
pursuit
purveyor
pushcart
pushchair
pusher
pushiness
pushing
pushover
pushpin
pushup
pushy
putdown
putt
puzzle
puzzling
pyramid
pyromania
python
quack
quadrant
quail
quaintly
quake
quaking
qualified
qualifier
qualify
quality
qualm
quantum
quarrel
quarry
quartered
quarterly
quarters
quartet
quench
query
quicken
quickly
quickness
quicksand
quickstep
quiet
quill
quilt
quintet
quintuple
quirk
quit
quiver
quizzical
quotable
quotation
quote
rabid
race
racing
racism
rack
racoon
radar
radial
radiance
radiantly
radiated
radiation
radiator
radio
radish
raffle
raft
rage
ragged
raging
ragweed
raider
railcar
railing
railroad
railway
raisin
rake
raking
rally
ramble
rambling
ramp
ramrod
ranch
rancidity
random
ranged
ranger
ranging
ranked
ranking
ransack
ranting
rants
rare
rarity
rascal
rash
rasping
ravage
raven
ravine
raving
ravioli
ravishing
reabsorb
reach
reacquire
reaction
reactive
reactor
reaffirm
ream
reanalyze
reappear
reapply
reappoint
reapprove
rearrange
rearview
reason
reassign
reassure
reattach
reawake
rebalance
rebate
rebel
rebirth
reboot
reborn
rebound
rebuff
rebuild
rebuilt
reburial
rebuttal
recall
recant
recapture
recast
recede
recent
recess
recharger
recipient
recital
recite
reckless
reclaim
recliner
reclining
recluse
reclusive
recognize
recoil
recollect
recolor
reconcile
reconfirm
reconvene
recopy
record
recount
recoup
recovery
recreate
rectal
rectangle
rectified
rectify
recycled
recycler
recycling
reemerge
reenact
reenter
reentry
reexamine
referable
referee
reference
refill
refinance
refined
refinery
refining
refinish
reflected
reflector
reflex
reflux
refocus
refold
reforest
reformat
reformed
reformer
reformist
refract
refrain
refreeze
refresh
refried
refueling
refund
refurbish
refurnish
refusal
refuse
refusing
refutable
refute
regain
regalia
regally
reggae
regime
region
register
registrar
registry
regress
regretful
regroup
regular
regulate
regulator
rehab
reheat
rehire
rehydrate
reimburse
reissue
reiterate
rejoice
rejoicing
rejoin
rekindle
relapse
relapsing
relatable
related
relation
relative
relax
relay
relearn
release
relenting
reliable
reliably
reliance
reliant
relic
relieve
relieving
relight
relish
relive
reload
relocate
relock
reluctant
rely
remake
remark
remarry
rematch
remedial
remedy
remember
reminder
remindful
remission
remix
remnant
remodeler
remold
remorse
remote
removable
removal
removed
remover
removing
rename
renderer
rendering
rendition
renegade
renewable
renewably
renewal
renewed
renounce
renovate
renovator
rentable
rental
rented
renter
reoccupy
reoccur
reopen
reorder
repackage
repacking
repaint
repair
repave
repaying
repayment
repeal
repeated
repeater
repent
rephrase
replace
replay
replica
reply
reporter
repose
repossess
repost
repressed
reprimand
reprint
reprise
reproach
reprocess
reproduce
reprogram
reps
reptile
reptilian
repugnant
repulsion
repulsive
repurpose
reputable
reputably
request
require
requisite
reroute
rerun
resale
resample
rescuer
reseal
research
reselect
reseller
resemble
resend
resent
reset
reshape
reshoot
reshuffle
residence
residency
resident
residual
residue
resigned
resilient
resistant
resisting
resize
resolute
resolved
resonant
resonate
resort
resource
respect
resubmit
result
resume
resupply
resurface
resurrect
retail
retainer
retaining
retake
retaliate
retention
rethink
retinal
retired
retiree
retiring
retold
retool
retorted
retouch
retrace
retract
retrain
retread
retreat
retrial
retrieval
retriever
retry
return
retying
retype
reunion
reunite
reusable
reuse
reveal
reveler
revenge
revenue
reverb
revered
reverence
reverend
reversal
reverse
reversing
reversion
revert
revisable
revise
revision
revisit
revivable
revival
reviver
reviving
revocable
revoke
revolt
revolver
revolving
reward
rewash
rewind
rewire
reword
rework
rewrap
rewrite
rhyme
ribbon
ribcage
rice
riches
richly
richness
rickety
ricotta
riddance
ridden
ride
riding
rifling
rift
rigging
rigid
rigor
rimless
rimmed
rind
rink
rinse
rinsing
riot
ripcord
ripeness
ripening
ripping
ripple
rippling
riptide
rise
rising
risk
risotto
ritalin
ritzy
rival
riverbank
riverbed
riverboat
riverside
riveter
riveting
roamer
roaming
roast
robbing
robe
robin
robotics
robust
rockband
rocker
rocket
rockfish
rockiness
rocking
rocklike
rockslide
rockstar
rocky
rogue
roman
romp
rope
roping
roster
rosy
rotten
rotting
rotunda
roulette
rounding
roundish
roundness
roundup
roundworm
routine
routing
rover
roving
royal
rubbed
rubber
rubbing
rubble
rubdown
ruby
ruckus
rudder
rug
ruined
rule
rumble
rumbling
rummage
rumor
runaround
rundown
runner
running
runny
runt
runway
rupture
rural
ruse
rush
rust
rut
sabbath
sabotage
sacrament
sacred
sacrifice
sadden
saddlebag
saddled
saddling
sadly
sadness
safari
safeguard
safehouse
safely
safeness
saffron
saga
sage
sagging
saggy
said
saint
sake
salad
salami
salaried
salary
saline
salon
saloon
salsa
salt
salutary
salute
salvage
salvaging
salvation
same
sample
sampling
sanction
sanctity
sanctuary
sandal
sandbag
sandbank
sandbar
sandblast
sandbox
sanded
sandfish
sanding
sandlot
sandpaper
sandpit
sandstone
sandstorm
sandworm
sandy
sanitary
sanitizer
sank
santa
sapling
sappiness
sappy
sarcasm
sarcastic
sardine
sash
sasquatch
sassy
satchel
satiable
satin
satirical
satisfied
satisfy
saturate
saturday
sauciness
saucy
sauna
savage
savanna
saved
savings
savior
savor
saxophone
say
scabbed
scabby
scalded
scalding
scale
scaling
scallion
scallop
scalping
scam
scandal
scanner
scanning
scant
scapegoat
scarce
scarcity
scarecrow
scared
scarf
scarily
scariness
scarring
scary
scavenger
scenic
schedule
schematic
scheme
scheming
schilling
schnapps
scholar
science
scientist
scion
scoff
scolding
scone
scoop
scooter
scope
scorch
scorebook
scorecard
scored
scoreless
scorer
scoring
scorn
scorpion
scotch
scoundrel
scoured
scouring
scouting
scouts
scowling
scrabble
scraggly
scrambled
scrambler
scrap
scratch
scrawny
screen
scribble
scribe
scribing
scrimmage
script
scroll
scrooge
scrounger
scrubbed
scrubber
scruffy
scrunch
scrutiny
scuba
scuff
sculptor
sculpture
scurvy
scuttle
secluded
secluding
seclusion
second
secrecy
secret
sectional
sector
secular
securely
security
sedan
sedate
sedation
sedative
sediment
seduce
seducing
segment
seismic
seizing
seldom
selected
selection
selective
selector
self
seltzer
semantic
semester
semicolon
semifinal
seminar
semisoft
semisweet
senate
senator
send
senior
senorita
sensation
sensitive
sensitize
sensually
sensuous
sepia
september
septic
septum
sequel
sequence
sequester
series
sermon
serotonin
serpent
serrated
serve
service
serving
sesame
sessions
setback
setting
settle
settling
setup
sevenfold
seventeen
seventh
seventy
severity
shabby
shack
shaded
shadily
shadiness
shading
shadow
shady
shaft
shakable
shakily
shakiness
shaking
shaky
shale
shallot
shallow
shame
shampoo
shamrock
shank
shanty
shape
shaping
share
sharpener
sharper
sharpie
sharply
sharpness
shawl
sheath
shed
sheep
sheet
shelf
shell
shelter
shelve
shelving
sherry
shield
shifter
shifting
shiftless
shifty
shimmer
shimmy
shindig
shine
shingle
shininess
shining
shiny
ship
shirt
shivering
shock
shone
shoplift
shopper
shopping
shoptalk
shore
shortage
shortcake
shortcut
shorten
shorter
shorthand
shortlist
shortly
shortness
shorts
shortwave
shorty
shout
shove
showbiz
showcase
showdown
shower
showgirl
showing
showman
shown
showoff
showpiece
showplace
showroom
showy
shrank
shrapnel
shredder
shredding
shrewdly
shriek
shrill
shrimp
shrine
shrink
shrivel
shrouded
shrubbery
shrubs
shrug
shrunk
shucking
shudder
shuffle
shuffling
shun
shush
shut
shy
siamese
siberian
sibling
siding
sierra
siesta
sift
sighing
silenced
silencer
silent
silica
silicon
silk
silliness
silly
silo
silt
silver
similarly
simile
simmering
simple
simplify
simply
sincere
sincerity
singer
singing
single
singular
sinister
sinless
sinner
sinuous
sip
siren
sister
sitcom
sitter
sitting
situated
situation
sixfold
sixteen
sixth
sixties
sixtieth
sixtyfold
sizable
sizably
size
sizing
sizzle
sizzling
skater
skating
skedaddle
skeletal
skeleton
skeptic
sketch
skewed
skewer
skid
skied
skier
skies
skiing
skilled
skillet
skillful
skimmed
skimmer
skimming
skimpily
skincare
skinhead
skinless
skinning
skinny
skintight
skipper
skipping
skirmish
skirt
skittle
skydiver
skylight
skyline
skype
skyrocket
skyward
slab
slacked
slacker
slacking
slackness
slacks
slain
slam
slander
slang
slapping
slapstick
slashed
slashing
slate
slather
slaw
sled
sleek
sleep
sleet
sleeve
slept
sliceable
sliced
slicer
slicing
slick
slider
slideshow
sliding
slighted
slighting
slightly
slimness
slimy
slinging
slingshot
slinky
slip
slit
sliver
slobbery
slogan
sloped
sloping
sloppily
sloppy
slot
slouching
slouchy
sludge
slug
slum
slurp
slush
sly
small
smartly
smartness
smasher
smashing
smashup
smell
smelting
smile
smilingly
smirk
smite
smith
smitten
smock
smog
smoked
smokeless
smokiness
smoking
smoky
smolder
smooth
smother
smudge
smudgy
smuggler
smuggling
smugly
smugness
snack
snagged
snaking
snap
snare
snarl
snazzy
sneak
sneer
sneeze
sneezing
snide
sniff
snippet
snipping
snitch
snooper
snooze
snore
snoring
snorkel
snort
snout
snowbird
snowboard
snowbound
snowcap
snowdrift
snowdrop
snowfall
snowfield
snowflake
snowiness
snowless
snowman
snowplow
snowshoe
snowstorm
snowsuit
snowy
snub
snuff
snuggle
snugly
snugness
speak
spearfish
spearhead
spearman
spearmint
species
specimen
specked
speckled
specks
spectacle
spectator
spectrum
speculate
speech
speed
spellbind
speller
spelling
spendable
spender
spending
spent
spew
sphere
spherical
sphinx
spider
spied
spiffy
spill
spilt
spinach
spinal
spindle
spinner
spinning
spinout
spinster
spiny
spiral
spirited
spiritism
spirits
spiritual
splashed
splashing
splashy
splatter
spleen
splendid
splendor
splice
splicing
splinter
splotchy
splurge
spoilage
spoiled
spoiler
spoiling
spoils
spoken
spokesman
sponge
spongy
sponsor
spoof
spookily
spooky
spool
spoon
spore
sporting
sports
sporty
spotless
spotlight
spotted
spotter
spotting
spotty
spousal
spouse
spout
sprain
sprang
sprawl
spray
spree
sprig
spring
sprinkled
sprinkler
sprint
sprite
sprout
spruce
sprung
spry
spud
spur
sputter
spyglass
squabble
squad
squall
squander
squash
squatted
squatter
squatting
squeak
squealer
squealing
squeamish
squeegee
squeeze
squeezing
squid
squiggle
squiggly
squint
squire
squirt
squishier
squishy
stability
stabilize
stable
stack
stadium
staff
stage
staging
stagnant
stagnate
stainable
stained
staining
stainless
stalemate
staleness
stalling
stallion
stamina
stammer
stamp
stand
stank
staple
stapling
starboard
starch
stardom
stardust
starfish
stargazer
staring
stark
starless
starlet
starlight
starlit
starring
starry
starship
starter
starting
startle
startling
startup
starved
starving
stash
state
static
statistic
statue
stature
status
statute
statutory
staunch
stays
steadfast
steadier
steadily
steadying
steam
steed
steep
steerable
steering
steersman
stegosaur
stellar
stem
stench
stencil
step
stereo
sterile
sterility
sterilize
sterling
sternness
sternum
stew
stick
stiffen
stiffly
stiffness
stifle
stifling
stillness
stilt
stimulant
stimulate
stimuli
stimulus
stinger
stingily
stinging
stingray
stingy
stinking
stinky
stipend
stipulate
stir
stitch
stock
stoic
stoke
stole
stomp
stonewall
stoneware
stonework
stoning
stony
stood
stooge
stool
stoop
stoplight
stoppable
stoppage
stopped
stopper
stopping
stopwatch
storable
storage
storeroom
storewide
storm
stout
stove
stowaway
stowing
straddle
straggler
strained
strainer
straining
strangely
stranger
strangle
strategic
strategy
stratus
straw
stray
streak
stream
street
strength
strenuous
strep
stress
stretch
strewn
stricken
strict
stride
strife
strike
striking
strive
striving
strobe
strode
stroller
strongbox
strongly
strongman
struck
structure
strudel
struggle
strum
strung
strut
stubbed
stubble
stubbly
stubborn
stucco
stuck
student
studied
studio
study
stuffed
stuffing
stuffy
stumble
stumbling
stump
stung
stunned
stunner
stunning
stunt
stupor
sturdily
sturdy
styling
stylishly
stylist
stylized
stylus
suave
subarctic
subatomic
subdivide
subdued
subduing
subfloor
subgroup
subheader
subject
sublease
sublet
sublevel
sublime
submarine
submerge
submersed
submitter
subpanel
subpar
subplot
subprime
subscribe
subscript
subsector
subside
subsiding
subsidize
subsidy
subsoil
subsonic
substance
subsystem
subtext
subtitle
subtly
subtotal
subtract
subtype
suburb
subway
subwoofer
subzero
succulent
such
suction
sudden
sudoku
suds
sufferer
suffering
suffice
suffix
suffocate
suffrage
sugar
suggest
suing
suitable
suitably
suitcase
suitor
sulfate
sulfide
sulfite
sulfur
sulk
sullen
sulphate
sulphuric
sultry
superbowl
superglue
superhero
superior
superjet
superman
supermom
supernova
supervise
supper
supplier
supply
support
supremacy
supreme
surcharge
surely
sureness
surface
surfacing
surfboard
surfer
surgery
surgical
surging
surname
surpass
surplus
surprise
surreal
surrender
surrogate
surround
survey
survival
survive
surviving
survivor
sushi
suspect
suspend
suspense
sustained
sustainer
swab
swaddling
swagger
swampland
swan
swapping
swarm
sway
swear
sweat
sweep
swell
swept
swerve
swifter
swiftly
swiftness
swimmable
swimmer
swimming
swimsuit
swimwear
swinger
swinging
swipe
swirl
switch
swivel
swizzle
swooned
swoop
swoosh
swore
sworn
swung
sycamore
sympathy
symphonic
symphony
symptom
synapse
syndrome
synergy
synopses
synopsis
synthesis
synthetic
syrup
system
t-shirt
tabasco
tabby
tableful
tables
tablet
tableware
tabloid
tackiness
tacking
tackle
tackling
tacky
taco
tactful
tactical
tactics
tactile
tactless
tadpole
taekwondo
tag
tainted
take
taking
talcum
talisman
tall
talon
tamale
tameness
tamer
tamper
tank
tanned
tannery
tanning
tantrum
tapeless
tapered
tapering
tapestry
tapioca
tapping
taps
tarantula
target
tarmac
tarnish
tarot
tartar
tartly
tartness
task
tassel
taste
tastiness
tasting
tasty
tattered
tattle
tattling
tattoo
taunt
tavern
thank
that
thaw
theater
theatrics
thee
theft
theme
theology
theorize
thermal
thermos
thesaurus
these
thesis
thespian
thicken
thicket
thickness
thieving
thievish
thigh
thimble
thing
think
thinly
thinner
thinness
thinning
thirstily
thirsting
thirsty
thirteen
thirty
thong
thorn
those
thousand
thrash
thread
threaten
threefold
thrift
thrill
thrive
thriving
throat
throbbing
throng
throttle
throwaway
throwback
thrower
throwing
thud
thumb
thumping
thursday
thus
thwarting
thyself
tiara
tibia
tidal
tidbit
tidiness
tidings
tidy
tiger
tighten
tightly
tightness
tightrope
tightwad
tigress
tile
tiling
till
tilt
timid
timing
timothy
tinderbox
tinfoil
tingle
tingling
tingly
tinker
tinkling
tinsel
tinsmith
tint
tinwork
tiny
tipoff
tipped
tipper
tipping
tiptoeing
tiptop
tiring
tissue
trace
tracing
track
traction
tractor
trade
trading
tradition
traffic
tragedy
trailing
trailside
train
traitor
trance
tranquil
transfer
transform
translate
transpire
transport
transpose
trapdoor
trapeze
trapezoid
trapped
trapper
trapping
traps
trash
travel
traverse
travesty
tray
treachery
treading
treadmill
treason
treat
treble
tree
trekker
tremble
trembling
tremor
trench
trend
trespass
triage
trial
triangle
tribesman
tribunal
tribune
tributary
tribute
triceps
trickery
trickily
tricking
trickle
trickster
tricky
tricolor
tricycle
trident
tried
trifle
trifocals
trillion
trilogy
trimester
trimmer
trimming
trimness
trinity
trio
tripod
tripping
triumph
trivial
trodden
trolling
trombone
trophy
tropical
tropics
trouble
troubling
trough
trousers
trout
trowel
truce
truck
truffle
trump
trunks
trustable
trustee
trustful
trusting
trustless
truth
try
tubby
tubeless
tubular
tucking
tuesday
tug
tuition
tulip
tumble
tumbling
tummy
turban
turbine
turbofan
turbojet
turbulent
turf
turkey
turmoil
turret
turtle
tusk
tutor
tutu
tux
tweak
tweed
tweet
tweezers
twelve
twentieth
twenty
twerp
twice
twiddle
twiddling
twig
twilight
twine
twins
twirl
twistable
twisted
twister
twisting
twisty
twitch
twitter
tycoon
tying
tyke
udder
ultimate
ultimatum
ultra
umbilical
umbrella
umpire
unabashed
unable
unadorned
unadvised
unafraid
unaired
unaligned
unaltered
unarmored
unashamed
unaudited
unawake
unaware
unbaked
unbalance
unbeaten
unbend
unbent
unbiased
unbitten
unblended
unblessed
unblock
unbolted
unbounded
unboxed
unbraided
unbridle
unbroken
unbuckled
unbundle
unburned
unbutton
uncanny
uncapped
uncaring
uncertain
unchain
unchanged
uncharted
uncheck
uncivil
unclad
unclaimed
unclamped
unclasp
uncle
unclip
uncloak
unclog
unclothed
uncoated
uncoiled
uncolored
uncombed
uncommon
uncooked
uncork
uncorrupt
uncounted
uncouple
uncouth
uncover
uncross
uncrown
uncrushed
uncured
uncurious
uncurled
uncut
undamaged
undated
undaunted
undead
undecided
undefined
underage
underarm
undercoat
undercook
undercut
underdog
underdone
underfed
underfeed
underfoot
undergo
undergrad
underhand
underline
underling
undermine
undermost
underpaid
underpass
underpay
underrate
undertake
undertone
undertook
undertow
underuse
underwear
underwent
underwire
undesired
undiluted
undivided
undocked
undoing
undone
undrafted
undress
undrilled
undusted
undying
unearned
unearth
unease
uneasily
uneasy
uneatable
uneaten
unedited
unelected
unending
unengaged
unenvied
unequal
unethical
uneven
unexpired
unexposed
unfailing
unfair
unfasten
unfazed
unfeeling
unfiled
unfilled
unfitted
unfitting
unfixable
unfixed
unflawed
unfocused
unfold
unfounded
unframed
unfreeze
unfrosted
unfrozen
unfunded
unglazed
ungloved
unglue
ungodly
ungraded
ungreased
unguarded
unguided
unhappily
unhappy
unharmed
unhealthy
unheard
unhearing
unheated
unhelpful
unhidden
unhinge
unhitched
unholy
unhook
unicorn
unicycle
unified
unifier
uniformed
uniformly
unify
unimpeded
uninjured
uninstall
uninsured
uninvited
union
uniquely
unisexual
unison
unissued
unit
universal
universe
unjustly
unkempt
unkind
unknotted
unknowing
unknown
unlaced
unlatch
unlawful
unleaded
unlearned
unleash
unless
unleveled
unlighted
unlikable
unlimited
unlined
unlinked
unlisted
unlit
unlivable
unloaded
unloader
unlocked
unlocking
unlovable
unloved
unlovely
unloving
unluckily
unlucky
unmade
unmanaged
unmanned
unmapped
unmarked
unmasked
unmasking
unmatched
unmindful
unmixable
unmixed
unmolded
unmoral
unmovable
unmoved
unmoving
unnamable
unnamed
unnatural
unneeded
unnerve
unnerving
unnoticed
unopened
unopposed
unpack
unpadded
unpaid
unpainted
unpaired
unpaved
unpeeled
unpicked
unpiloted
unpinned
unplanned
unplanted
unpleased
unpledged
unplowed
unplug
unpopular
unproven
unquote
unranked
unrated
unraveled
unreached
unread
unreal
unreeling
unrefined
unrelated
unrented
unrest
unretired
unrevised
unrigged
unripe
unrivaled
unroasted
unrobed
unroll
unruffled
unruly
unrushed
unsaddle
unsafe
unsaid
unsalted
unsaved
unsavory
unscathed
unscented
unscrew
unsealed
unseated
unsecured
unseeing
unseemly
unseen
unselect
unselfish
unsent
unsettled
unshackle
unshaken
unshaved
unshaven
unsheathe
unshipped
unsightly
unsigned
unskilled
unsliced
unsmooth
unsnap
unsocial
unsoiled
unsold
unsolved
unsorted
unspoiled
unspoken
unstable
unstaffed
unstamped
unsteady
unsterile
unstirred
unstitch
unstopped
unstuck
unstuffed
unstylish
unsubtle
unsubtly
unsuited
unsure
unsworn
untagged
untainted
untaken
untamed
untangled
untapped
untaxed
unthawed
unthread
untidy
untie
until
untimed
untimely
untitled
untoasted
untold
untouched
untracked
untrained
untreated
untried
untrimmed
untrue
untruth
unturned
untwist
untying
unusable
unused
unusual
unvalued
unvaried
unvarying
unveiled
unveiling
unvented
unviable
unvisited
unvocal
unwanted
unwarlike
unwary
unwashed
unwatched
unweave
unwed
unwelcome
unwell
unwieldy
unwilling
unwind
unwired
unwitting
unwomanly
unworldly
unworn
unworried
unworthy
unwound
unwoven
unwrapped
unwritten
unzip
upbeat
upchuck
upcoming
upcountry
update
upfront
upgrade
upheaval
upheld
uphill
uphold
uplifted
uplifting
upload
upon
upper
upright
uprising
upriver
uproar
uproot
upscale
upside
upstage
upstairs
upstart
upstate
upstream
upstroke
upswing
uptake
uptight
uptown
upturned
upward
upwind
uranium
urban
urchin
urethane
urgency
urgent
urging
urologist
urology
usable
usage
useable
used
uselessly
user
usher
usual
utensil
utility
utilize
utmost
utopia
utter
vacancy
vacant
vacate
vacation
vagabond
vagrancy
vagrantly
vaguely
vagueness
valiant
valid
valium
valley
valuables
value
vanilla
vanish
vanity
vanquish
vantage
vaporizer
variable
variably
varied
variety
various
varmint
varnish
varsity
varying
vascular
vaseline
vastly
vastness
veal
vegan
veggie
vehicular
velcro
velocity
velvet
vendetta
vending
vendor
veneering
vengeful
venomous
ventricle
venture
venue
venus
verbalize
verbally
verbose
verdict
verify
verse
version
versus
vertebrae
vertical
vertigo
very
vessel
vest
veteran
veto
vexingly
viability
viable
vibes
vice
vicinity
victory
video
viewable
viewer
viewing
viewless
viewpoint
vigorous
village
villain
vindicate
vineyard
vintage
violate
violation
violator
violet
violin
viper
viral
virtual
virtuous
virus
visa
viscosity
viscous
viselike
visible
visibly
vision
visiting
visitor
visor
vista
vitality
vitalize
vitally
vitamins
vivacious
vividly
vividness
vixen
vocalist
vocalize
vocally
vocation
voice
voicing
void
volatile
volley
voltage
volumes
voter
voting
voucher
vowed
vowel
voyage
wackiness
wad
wafer
waffle
waged
wager
wages
waggle
wagon
wake
waking
walk
walmart
walnut
walrus
waltz
wand
wannabe
wanted
wanting
wasabi
washable
washbasin
washboard
washbowl
washcloth
washday
washed
washer
washhouse
washing
washout
washroom
washstand
washtub
wasp
wasting
watch
water
waviness
waving
wavy
whacking
whacky
wham
wharf
wheat
whenever
whiff
whimsical
whinny
whiny
whisking
whoever
whole
whomever
whoopee
whooping
whoops
why
wick
widely
widen
widget
widow
width
wieldable
wielder
wife
wifi
wikipedia
wildcard
wildcat
wilder
wildfire
wildfowl
wildland
wildlife
wildly
wildness
willed
willfully
willing
willow
willpower
wilt
wimp
wince
wincing
wind
wing
winking
winner
winnings
winter
wipe
wired
wireless
wiring
wiry
wisdom
wise
wish
wisplike
wispy
wistful
wizard
wobble
wobbling
wobbly
wok
wolf
wolverine
womanhood
womankind
womanless
womanlike
womanly
womb
woof
wooing
wool
woozy
word
work
worried
worrier
worrisome
worry
worsening
worshiper
worst
wound
woven
wow
wrangle
wrath
wreath
wreckage
wrecker
wrecking
wrench
wriggle
wriggly
wrinkle
wrinkly
wrist
writing
written
wrongdoer
wronged
wrongful
wrongly
wrongness
wrought
xbox
xerox
yahoo
yam
yanking
yapping
yard
yarn
yeah
yearbook
yearling
yearly
yearning
yeast
yelling
yelp
yen
yesterday
yiddish
yield
yin
yippee
yo-yo
yodel
yoga
yogurt
yonder
yoyo
yummy
zap
zealous
zebra
zen
zeppelin
zero
zestfully
zesty
zigzagged
zipfile
zipping
zippy
zips
zit
zodiac
zombie
zone
zoning
zookeeper
zoologist
zoology
zoom
__ZEROED_FILE__

install -d -m 0755 -o root -g root /etc/zeroed /opt/zeroed /opt/zeroed/releases
install -d -m 0700 -o root -g root /etc/zeroed/age /etc/credstore.encrypted /var/lib/zeroed-host /var/backups/zeroed
# Dry-run evidence stays on the host (RUN-1 writes it there); its index is readable by the worker API.
install -d -m 0700 -o root -g root /var/lib/zeroed-dryrun /var/lib/zeroed-dryrun/evidence
install -d -m 0755 -o root -g root /var/lib/zeroed-index
# PATHS-FIX: the engine's two folders outside its 0700 state (one StateDirectoryMode per unit, so they are made here).
# Market data: readable by the pull group, setgid so new files keep that group; receipts/ is the only folder the pull
# account writes. Import spool: its group may write and enter but not list. The pull account's chroot is root-owned
# 0755 (sshd requires it); md and md/receipts in it are bind mounts, never touched while mounted.
install -d -m 2750 -o zeroed-worker -g zeroed-pull /var/lib/zeroed-md
install -d -m 2770 -o zeroed-worker -g zeroed-pull /var/lib/zeroed-md/receipts
install -d -m 2730 -o zeroed-worker -g zeroed-spool /var/lib/zeroed-spool
install -d -m 2770 -o zeroed-worker -g zeroed-sentinel /var/lib/zeroed-usage
install -d -m 0755 -o root -g root /srv/zeroed_pull /etc/zeroed/pull-keys
mountpoint -q /srv/zeroed_pull/md || install -d -m 0755 -o root -g root /srv/zeroed_pull/md

say "Host key"
# The host's own age key: backups are encrypted to it (the owner's key can be added later).
if [ ! -s /etc/zeroed/age/host.key ]; then
  age-keygen -o /etc/zeroed/age/host.key.new 2>/dev/null
  chmod 0400 /etc/zeroed/age/host.key.new
  mv /etc/zeroed/age/host.key.new /etc/zeroed/age/host.key
fi
chmod 0400 /etc/zeroed/age/host.key
[ -s /etc/zeroed/backup-recipients ] || { age-keygen -y /etc/zeroed/age/host.key > /etc/zeroed/backup-recipients; chmod 0644 /etc/zeroed/backup-recipients; }
# systemd's own host key for encrypted credentials (root-only, created once).
[ -s /var/lib/systemd/credential.secret ] || systemd-creds setup >/dev/null

keep_old /etc/zeroed/host.env
cat > /etc/zeroed/host.env.new <<EOF
ZEROED_REPO=$REPO
ZEROED_BRANCH=$BRANCH
ZEROED_GITHUB_URL=$GITHUB_URL
ZEROED_API_URL=$API_URL
ZEROED_TELEGRAM_URL=$TELEGRAM_URL
WEB_FLOW_FPR=$WEB_FLOW_FPR
EOF
chmod 0644 /etc/zeroed/host.env.new
mv /etc/zeroed/host.env.new /etc/zeroed/host.env
[ -f /etc/zeroed/worker.env ] || { keep_old /etc/zeroed/worker.env; install -m 0644 /dev/null /etc/zeroed/worker.env; }
. /usr/local/lib/zeroed/common.sh
# A one-time deploy code, unless the keys are already here (re-running the installer keeps them).
[ "$UPDATE" = 1 ] || keys_stored || [ -s "$DEPLOY_CODE_FILE" ] || new_deploy_code

say "GitHub merge-signing key"
install -d -m 0700 /etc/zeroed/gnupg
GNUPGHOME=/etc/zeroed/gnupg gpg --batch --quiet --import /etc/zeroed/github-web-flow.asc 2>/dev/null
got="$(GNUPGHOME=/etc/zeroed/gnupg gpg --batch --with-colons --fingerprint 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
[ "$got" = "$WEB_FLOW_FPR" ] || die "GitHub signing key fingerprint mismatch"

say "Firewall: no inbound ports${SSH_KEY:+ except SSH (key-only)}"
# Password login is off on both paths (the drop-in also covers SSH being turned on later by hand).
install -d -m 0755 /etc/ssh/sshd_config.d
keep_old /etc/ssh/sshd_config.d/10-zeroed.conf
printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' 'AuthenticationMethods publickey' > /etc/ssh/sshd_config.d/10-zeroed.conf
if [ "$UPDATE" = 1 ]; then
  # SSH stays exactly as it was: open (key-only) only if the running firewall already let it in.
  [ "$SSH_WAS_OPEN" = 0 ] || sed -i 's/^#SSH_RULE#//' /etc/nftables.conf
elif [ -n "$SSH_KEY" ]; then
  install -d -m 0700 /root/.ssh
  printf '%s\n' "$SSH_KEY" > /root/.ssh/authorized_keys
  chmod 0600 /root/.ssh/authorized_keys
  sed -i 's/^#SSH_RULE#//' /etc/nftables.conf
  systemctl reload ssh 2>/dev/null || true
else
  for u in ssh.socket ssh.service; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
fi
# PATHS-FIX: the pull account's Match block (sshd_config.d/20-zeroed-pull.conf) is checked whenever sshd is installed,
# and applied at once to a running SSH; a broken file stops the install before SSH ever reads it.
if [ -x /usr/sbin/sshd ]; then
  install -d -m 0755 /run/sshd
  /usr/sbin/sshd -t || die "sshd refuses the SSH settings"
  systemctl try-reload-or-restart ssh.service >/dev/null 2>&1 || true
fi
systemctl enable nftables >/dev/null 2>&1
nft -f /etc/nftables.conf
# The ruleset flush also drops Tailscale's own rules; its daemon puts them back on restart (live view, opt-in).
if systemctl is-active --quiet tailscaled 2>/dev/null; then systemctl restart tailscaled || true; fi

say "Security updates"
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

say "Repository"
if [ ! -d /opt/zeroed/repo/.git ]; then
  git clone --quiet --no-checkout "$GITHUB_URL/$REPO.git" /opt/zeroed/repo
fi

say "Dry-run units"
# RUN-1's units come with the deployed release (packages/runner/systemd), so the runner's owner changes them
# by merge alone. Only zeroed-dryrun* and zeroed-worker-tabletop are taken (none enabled but the tick timer);
# units a newer release dropped are removed.
# zeroed-update points ZEROED_RELEASE_DIR at the release it is about to switch to.
RELEASE_UNITS="${ZEROED_RELEASE_DIR:-/opt/zeroed/current}/packages/runner/systemd"
new_units=()
if [ -d "$RELEASE_UNITS" ]; then
  for f in "$RELEASE_UNITS"/*; do
    n="$(basename "$f")"
    [[ "$n" =~ $RELEASE_UNIT_RE ]] || continue
    install_file "/etc/systemd/system/$n" 0644 < "$f"
    new_units+=("$n")
  done
fi
for n in $(cat /var/lib/zeroed-host/release-units 2>/dev/null || true); do
  [[ " ${new_units[*]} " == *" $n "* ]] && continue
  keep_unit "$n"
  keep_old "/etc/systemd/system/$n"
  systemctl disable --now "$n" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$n"
done
keep_old /var/lib/zeroed-host/release-units
printf '%s\n' "${new_units[@]}" > /var/lib/zeroed-host/release-units

say "Services"
systemctl daemon-reload
# HOST-CAPS: journald reads its size limits only when it starts.
[[ " ${CHANGED[*]} " != *" /etc/systemd/journald.conf.d/zeroed-journal.conf "* ]] || systemctl restart systemd-journald
# PATHS-FIX: the receipts' own small filesystem (ruling 20), then the chroot's binds, all before SSH.
systemctl enable --now zeroed-receipts-fs.service srv-zeroed_pull-md.mount srv-zeroed_pull-md-receipts.mount >/dev/null
systemctl enable --now zeroed-signer.service >/dev/null
systemctl enable zeroed-worker.service >/dev/null
systemctl enable --now zeroed-pair.timer zeroed-update.timer zeroed-backup.timer zeroed-check.timer >/dev/null
# The dry run starts only when a merged release asks for one by name (packages/runner/qualifying-run.json).
if [ -e /etc/systemd/system/zeroed-dryrun-tick.timer ]; then systemctl enable --now zeroed-dryrun-tick.timer >/dev/null; fi
# Installed but off: the off-server copy goes to a third party (Telegram) and waits for the owner's
# approval, switched on by a reviewed commit to ops/host-config.json (applied by zeroed-update).
# Host checks once now (Funnel, keys, webhook, evidence index); the timer repeats them every minute.
/usr/local/sbin/zeroed-check || true
if [ "$UPDATE" = 1 ]; then
  # zeroed-update restarts the worker next (reconcile first); the signer only when its own files changed.
  for f in "${CHANGED[@]}"; do
    case "$f" in /etc/systemd/system/zeroed-signer.service | /opt/zeroed/stub/signer.mjs) systemctl try-restart zeroed-signer.service || true; break ;; esac
  done
  say "Updated: ${#CHANGED[@]} host files changed"
  exit 0
fi
# Starts once credentials exist (skipped by its ConditionPathExists until then); a release never started under the
# hold gets its held first start from zeroed-update instead (start_worker, OPS-CLEAN M1). A running worker whose
# start files changed restarts (reconcile first) unless a dry run or an open intent is in the way.
if systemctl is-active --quiet zeroed-worker.service; then
  for f in "${CHANGED[@]}"; do
    case "$f" in /etc/systemd/system/zeroed-worker.service | /usr/local/lib/zeroed/worker-start | /opt/zeroed/stub/worker.mjs)
      worker_busy || systemctl restart zeroed-worker.service || true
      break ;;
    esac
  done
fi
start_worker || true

printf '\nInstalled. Next: the deploy code below goes into GitHub as the secret DEPLOY_CODE.\n\n'
if [ "${ZEROED_NO_WAIT:-}" != 1 ] && [ -t 1 ]; then
  exec /usr/local/sbin/zeroed-setup
fi
/usr/local/sbin/zeroed-status
