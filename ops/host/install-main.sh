#!/usr/bin/env bash
# Zeroed host installer. Built from ops/host by ops/build-install.mjs; edit the sources, not ops/install.sh.
# Run once as root on a fresh Ubuntu 24.04 LTS server (see ops/README.md). Safe to run again: the host key,
# the pairing code and stored credentials are kept.
#
#   bash install.sh                      SSH off (use the provider's web console)
#   bash install.sh --ssh-key 'ssh-ed25519 AAAA... me'   SSH on, key-only, for that key
#
# Never prints a secret. Never uses set -x.
set -euo pipefail
umask 022

REPO="${ZEROED_REPO:-macdarenz-droid/Meme-snipe}"
BRANCH="${ZEROED_BRANCH:-ccr-14987baf-i6lrsl}"
GITHUB_URL="${ZEROED_GITHUB_URL:-https://github.com}"
API_URL="${ZEROED_API_URL:-https://api.github.com}"
TELEGRAM_URL="${ZEROED_TELEGRAM_URL:-https://api.telegram.org}"
NODE_VERSION=v22.23.3
NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
NODE_URL="${ZEROED_NODE_URL:-https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz}"
WEB_FLOW_FPR=968479A1AFF927E37D1A566BB5690EEEBB952194

SSH_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
die() { printf 'Install stopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "needs Ubuntu 24.04 LTS (found ${PRETTY_NAME:-unknown})"
[ "$(uname -m)" = x86_64 ] || die "needs an x86_64 server"
if [ -n "$SSH_KEY" ]; then
  [[ "$SSH_KEY" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com)\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] || die "--ssh-key must be one public key line (ssh-ed25519 or ecdsa)"
fi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
apt-get install -y -q --no-install-recommends \
  age ca-certificates curl git gnupg jq nftables sqlite3 unattended-upgrades xz-utils >/dev/null

say "Node $NODE_VERSION"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/node.tar.xz" "$NODE_URL"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c --quiet - || die "Node download failed its SHA-256 check"
  rm -rf "/opt/node-$NODE_VERSION"
  mkdir -p "/opt/node-$NODE_VERSION"
  tar -xJf "$tmp/node.tar.xz" -C "/opt/node-$NODE_VERSION" --strip-components=1 --no-same-owner
  ln -sfn "/opt/node-$NODE_VERSION/bin/node" /usr/local/bin/node
  rm -rf "$tmp"
fi

say "Users"
getent group zeroed-signer >/dev/null || groupadd --system zeroed-signer
getent passwd zeroed-signer >/dev/null || useradd --system --gid zeroed-signer --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin zeroed-signer
getent group zeroed-worker >/dev/null || groupadd --system zeroed-worker
# The worker may reach the signer's socket through the zeroed-signer group; nothing else is in that group.
getent passwd zeroed-worker >/dev/null || useradd --system --gid zeroed-worker --groups zeroed-signer --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin zeroed-worker

say "Files"
install_file() { # path mode, content on stdin
  mkdir -p "$(dirname "$1")"
  cat > "$1.zeroed-new"
  chmod "$2" "$1.zeroed-new"
  chown root:root "$1.zeroed-new"
  mv -f "$1.zeroed-new" "$1"
}
# @@FILES@@

install -d -m 0755 -o root -g root /etc/zeroed /opt/zeroed /opt/zeroed/releases
install -d -m 0700 -o root -g root /etc/zeroed/age /etc/credstore.encrypted /var/lib/zeroed-host /var/backups/zeroed

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
[ -f /etc/zeroed/worker.env ] || install -m 0644 /dev/null /etc/zeroed/worker.env
. /usr/local/lib/zeroed/common.sh
# A one-time deploy code, unless the keys are already here (re-running the installer keeps them).
keys_stored || [ -s "$DEPLOY_CODE_FILE" ] || new_deploy_code

say "GitHub merge-signing key"
install -d -m 0700 /etc/zeroed/gnupg
GNUPGHOME=/etc/zeroed/gnupg gpg --batch --quiet --import /etc/zeroed/github-web-flow.asc 2>/dev/null
got="$(GNUPGHOME=/etc/zeroed/gnupg gpg --batch --with-colons --fingerprint 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
[ "$got" = "$WEB_FLOW_FPR" ] || die "GitHub signing key fingerprint mismatch"

say "Firewall: no inbound ports${SSH_KEY:+ except SSH (key-only)}"
# Password login is off on both paths (the drop-in also covers SSH being turned on later by hand).
install -d -m 0755 /etc/ssh/sshd_config.d
printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' 'AuthenticationMethods publickey' > /etc/ssh/sshd_config.d/10-zeroed.conf
if [ -n "$SSH_KEY" ]; then
  install -d -m 0700 /root/.ssh
  printf '%s\n' "$SSH_KEY" > /root/.ssh/authorized_keys
  chmod 0600 /root/.ssh/authorized_keys
  sed -i 's/^#SSH_RULE#//' /etc/nftables.conf
  systemctl reload ssh 2>/dev/null || true
else
  for u in ssh.socket ssh.service; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
fi
systemctl enable nftables >/dev/null 2>&1
nft -f /etc/nftables.conf

say "Security updates"
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

say "Repository"
if [ ! -d /opt/zeroed/repo/.git ]; then
  git clone --quiet --no-checkout "$GITHUB_URL/$REPO.git" /opt/zeroed/repo
fi

say "Services"
systemctl daemon-reload
systemctl enable --now zeroed-signer.service >/dev/null
systemctl enable zeroed-worker.service >/dev/null
systemctl enable --now zeroed-pair.timer zeroed-update.timer zeroed-backup.timer >/dev/null
# Installed but off: the off-server copy goes to a third party (Telegram) and waits for the owner's
# approval, switched on by a reviewed commit to ops/host-config.json (applied by zeroed-update).
# Starts once credentials exist (skipped by its ConditionPathExists until then).
systemctl start zeroed-worker.service || true

printf '\nInstalled. Next: the deploy code below goes into GitHub as the secret DEPLOY_CODE.\n\n'
if [ "${ZEROED_NO_WAIT:-}" != 1 ] && [ -t 1 ]; then
  exec /usr/local/sbin/zeroed-setup
fi
/usr/local/sbin/zeroed-status
