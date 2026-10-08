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
# @@FILES@@

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
