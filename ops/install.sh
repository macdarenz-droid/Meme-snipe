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
install_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'__ZEROED_FILE__'
// Zeroed: security updates every day, unattended. No automatic reboot (a reboot mid-trade is worse than a
// pending kernel update); /status and the journal show when one is needed.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
__ZEROED_FILE__
install_file /etc/apt/apt.conf.d/52zeroed-unattended-upgrades 0644 <<'__ZEROED_FILE__'
// Zeroed: security origin only (Ubuntu's default list), never reboot on its own.
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
        "${distro_id}ESMApps:${distro_codename}-apps-security";
        "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
__ZEROED_FILE__
install_file /etc/nftables.conf 0644 <<'__ZEROED_FILE__'
#!/usr/sbin/nft -f
# Zeroed host firewall. No inbound ports (SSH only when the installer was given a key).
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
ReadWritePaths=/var/backups/zeroed /var/lib/zeroed
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
install_file /etc/systemd/system/zeroed-pair.service 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: fetch keys published by the Deploy workflow
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zeroed-pair
UMask=0077
PrivateTmp=yes
NoNewPrivileges=yes
ProtectHome=yes
__ZEROED_FILE__
install_file /etc/systemd/system/zeroed-pair.timer 0644 <<'__ZEROED_FILE__'
[Unit]
Description=Zeroed: check for keys from the Deploy workflow every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
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
# Starts only after the Deploy workflow delivered the keys.
ConditionPathExists=/etc/credstore.encrypted/helius_api_key
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
User=zeroed-worker
Group=zeroed-worker
SupplementaryGroups=zeroed-signer
EnvironmentFile=/etc/zeroed/worker.env
Environment=NODE_ENV=production
# Reconcile first: every start and restart settles open intents against the chain before trading.
ExecStartPre=/usr/local/bin/node /opt/zeroed/stub/worker.mjs --reconcile
ExecStart=/usr/local/bin/node /opt/zeroed/stub/worker.mjs
Restart=always
RestartSec=5
TimeoutStopSec=30
LoadCredentialEncrypted=helius_api_key:/etc/credstore.encrypted/helius_api_key
LoadCredentialEncrypted=alchemy_api_key:/etc/credstore.encrypted/alchemy_api_key
LoadCredentialEncrypted=jupiter_api_key:/etc/credstore.encrypted/jupiter_api_key
LoadCredentialEncrypted=telegram_bot_token:/etc/credstore.encrypted/telegram_bot_token
LoadCredentialEncrypted=telegram_chat_id:/etc/credstore.encrypted/telegram_chat_id
LoadCredentialEncrypted=heartbeat_hmac_key:/etc/credstore.encrypted/heartbeat_hmac_key
StateDirectory=zeroed
StateDirectoryMode=0700
UMask=0077
MemoryMax=800M
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

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
=L/8U
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
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const credDir = process.env.CREDENTIALS_DIRECTORY ?? '';
const stateDir = process.env.STATE_DIRECTORY ?? '/var/lib/zeroed';
const watchdog = (process.env.WATCHDOG_URL ?? '').replace(/\/$/, '');
const intervalMs = Number(process.env.ZEROED_HEARTBEAT_MS ?? 20_000);
const NAMES = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id', 'heartbeat_hmac_key'];

const loaded = credDir ? NAMES.filter((n) => existsSync(join(credDir, n))) : [];
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
  event('reconcile', `stub: 0 open intents, ${ok ? 'ok' : 'credentials missing'}`);
  console.log(`Reconcile: 0 open intents, ${loaded.length} of ${NAMES.length} credentials present. ${ok ? 'OK' : 'Refusing to start.'}`);
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
let paused = false;
const key = loaded.includes('heartbeat_hmac_key') ? readFileSync(join(credDir, 'heartbeat_hmac_key'), 'utf8') : '';

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
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
  try {
    const res = await fetch(`${watchdog}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${sig}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const reply = await res.json().catch(() => ({}));
    if (res.ok && reply.paused === true && !paused) {
      paused = true;
      event('pause', 'owner /pause via watchdog');
      console.log('Entries paused by the owner (watchdog). Exits keep running.');
    }
    if (!res.ok) console.log(`Heartbeat refused: HTTP ${res.status}`);
  } catch (e) {
    console.log(`Heartbeat failed: ${e.name}`);
  }
}

const bootId = `${Date.now().toString(36)}-${process.pid}`;
console.log(`Stub worker up: ${loaded.length} of ${NAMES.length} credentials, release ${gitSha.slice(0, 12)}, watchdog ${watchdog ? 'set' : 'not set'}.`);
event('start', gitSha);
await beat();
const timer = setInterval(() => void beat(), intervalMs);
const stop = () => {
  clearInterval(timer);
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
CRED_DIR=/etc/credstore.encrypted
STATE_DIR=/var/lib/zeroed-host

log() { printf '%s\n' "$*"; }

# cred NAME: prints the decrypted credential to stdout (for a pipe or $(...), never to a terminal or log).
cred() {
  systemd-creds decrypt --name="$1" "$CRED_DIR/$1" -
}

# notify TEXT: sends TEXT to the owner's Telegram chat. The token goes to curl on stdin (-K -), never in
# argv, so it does not show in the process list. Returns non-zero on failure; callers decide.
notify() {
  [ -s "$CRED_DIR/telegram_bot_token" ] && [ -s "$CRED_DIR/telegram_chat_id" ] || return 1
  local token chat
  token="$(cred telegram_bot_token)" || return 1
  chat="$(cred telegram_chat_id)" || return 1
  printf 'url = "%s/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\n' "$ZEROED_TELEGRAM_URL" "$token" "$chat" |
    curl -fsS -m 15 -o /dev/null -K - --data-urlencode "text=$1"
}
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-backup 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Hourly encrypted backup of every SQLite file under /var/lib/zeroed. Each file is copied with SQLite's
# online backup (consistent under WAL), checked, listed in a manifest with its SHA-256, packed and
# encrypted with age to /etc/zeroed/backup-recipients (the host key, plus the owner's key once the
# Deploy workflow delivered one). Keeps the newest 72 locally.
set -euo pipefail
umask 077

SRC="${ZEROED_BACKUP_SRC:-/var/lib/zeroed}"
OUT="${ZEROED_BACKUP_OUT:-/var/backups/zeroed}"
RECIPIENTS="${ZEROED_BACKUP_RECIPIENTS:-/etc/zeroed/backup-recipients}"
KEEP="${ZEROED_BACKUP_KEEP:-72}"

[ -s "$RECIPIENTS" ] || { echo "No backup recipients yet (keys not delivered); nothing backed up."; exit 0; }
mapfile -t dbs < <(cd "$SRC" && find . -type f \( -name '*.sqlite' -o -name '*.db' \) | sed 's#^\./##' | LC_ALL=C sort)
[ "${#dbs[@]}" -gt 0 ] || { echo "No SQLite files yet; nothing backed up."; exit 0; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/snap"
for rel in "${dbs[@]}"; do
  mkdir -p "$work/snap/$(dirname "$rel")"
  sqlite3 "$SRC/$rel" ".timeout 10000" ".backup '$work/snap/$rel'"
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
install_file /usr/local/sbin/zeroed-pair 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Picks up the keys the Deploy workflow published for this host, stores them as encrypted systemd
# credentials, restarts the worker (reconcile first) and confirms in Telegram. Runs every minute from
# zeroed-pair.timer; does nothing while no bundle is published. Re-running Deploy (rotation) publishes a
# newer bundle, which replaces every value. Never prints a value; never set -x.
set -euo pipefail
umask 077
. /usr/local/lib/zeroed/common.sh

TAG="pair-$PAIRING_CODE"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Is a bundle published? (404 until Deploy runs; quiet then.)
code="$(curl -sS -L -m 30 -o "$WORK/bundle.age" -w '%{http_code}' \
  "$ZEROED_GITHUB_URL/$ZEROED_REPO/releases/download/$TAG/secrets.age" || true)"
[ "$code" = 200 ] || exit 0

# 2. Only a release made by this repository's own workflow counts (only GitHub Actions can create it).
author="$(curl -fsS -m 30 -H 'Accept: application/vnd.github+json' \
  "$ZEROED_API_URL/repos/$ZEROED_REPO/releases/tags/$TAG" | jq -r '.author.login // empty')"
if [ "$author" != "github-actions[bot]" ]; then
  log "Ignored $TAG: not published by the repository's workflow."
  exit 0
fi

# 3. Decrypt straight into memory (process substitution is a pipe; nothing touches disk).
declare -A v=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  k="${line%%=*}"
  val="${line#*=}"
  [[ "$k" =~ ^[A-Z][A-Z0-9_]{0,40}$ ]] || { log "Rejected bundle: bad line."; exit 1; }
  [[ "$val" =~ ^[A-Za-z0-9._:/+=@-]{0,512}$ ]] || { log "Rejected bundle: bad value for $k."; exit 1; }
  v[$k]="$val"
done < <(age -d -i /etc/zeroed/age/host.key "$WORK/bundle.age" 2>/dev/null || echo "DECRYPT_FAILED=1")
rm -f "$WORK/bundle.age"

if [ -n "${v[DECRYPT_FAILED]:-}" ] || [ "${v[ZEROED_BUNDLE]:-}" != 1 ]; then
  log "Rejected $TAG: it was not made for this host's key."
  exit 1
fi
if [ "${v[PAIRING_CODE]:-}" != "$PAIRING_CODE" ]; then
  log "Rejected $TAG: pairing code inside does not match this host."
  exit 1
fi
issued="${v[ISSUED]:-}"
[[ "$issued" =~ ^[0-9]{1,20}$ ]] || { log "Rejected $TAG: no issue number."; exit 1; }
last="$(cat "$STATE_DIR/last_issued" 2>/dev/null || echo 0)"
if [ "$issued" -le "$last" ]; then
  exit 0 # Already applied (or an older bundle): nothing to do.
fi

# 4. Store every value as an encrypted credential (stdin only; the value is never an argument).
names=(HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID HEARTBEAT_HMAC_KEY)
for k in "${names[@]}"; do
  [ -n "${v[$k]:-}" ] || { log "Rejected $TAG: $k is missing."; exit 1; }
done
for k in "${names[@]}"; do
  n="${k,,}"
  printf '%s' "${v[$k]}" | systemd-creds encrypt --with-key=host --name="$n" - "$CRED_DIR/$n.new"
  chmod 0600 "$CRED_DIR/$n.new"
done
for k in "${names[@]}"; do
  n="${k,,}"
  mv -f "$CRED_DIR/$n.new" "$CRED_DIR/$n"
done

# 5. Non-secret settings.
watchdog="${v[WATCHDOG_URL]:-}"
[ -z "$watchdog" ] || [[ "$watchdog" =~ ^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/-]*)?$ ]] || { log "Rejected $TAG: bad WATCHDOG_URL."; exit 1; }
printf 'WATCHDOG_URL=%s\n' "$watchdog" > /etc/zeroed/worker.env.new
chmod 0644 /etc/zeroed/worker.env.new
mv -f /etc/zeroed/worker.env.new /etc/zeroed/worker.env
{
  age-keygen -y /etc/zeroed/age/host.key
  recipient="${v[BACKUP_RECIPIENT]:-}"
  if [[ "$recipient" =~ ^age1[a-z0-9]{58}$ ]]; then printf '%s\n' "$recipient"; fi
} > /etc/zeroed/backup-recipients.new
chmod 0644 /etc/zeroed/backup-recipients.new
mv -f /etc/zeroed/backup-recipients.new /etc/zeroed/backup-recipients
owner_backup=no
[ "$(wc -l < /etc/zeroed/backup-recipients)" -ge 2 ] && owner_backup=yes

v=()
printf '%s\n' "$issued" > "$STATE_DIR/last_issued"

# 6. Restart the worker; its ExecStartPre reconciles before it trades.
systemctl daemon-reload
if systemctl restart zeroed-worker.service; then worker=running; else worker="failed to start"; fi
log "Stored ${#names[@]} credentials from $TAG (issue $issued). Worker: $worker."
if notify "Zeroed host: keys stored (${#names[@]} values, issue $issued). Worker $worker. Owner backup key: $owner_backup."; then
  log "Telegram confirmation sent."
else
  log "Telegram confirmation failed."
fi
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
  if [ -f "$SRC/$rel" ]; then
    live="$(sqlite3 -readonly "$SRC/$rel" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;" 2>/dev/null || true)"
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
const sig = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
const res = await fetch(`${process.env.WATCHDOG_URL}/resume`, { method: "POST", headers: { "content-type": "application/json", "x-zeroed-signature": `t=${t},v1=${sig}` }, body });
console.log(res.ok ? "Entries allowed again." : `Watchdog refused: HTTP ${res.status}`);
process.exit(res.ok ? 0 : 1);
'
__ZEROED_FILE__
install_file /usr/local/sbin/zeroed-update 0755 <<'__ZEROED_FILE__'
#!/usr/bin/env bash
# Code updates by the same pull path: fetch the "deploy" tag, accept its commit only if GitHub signed it
# (the merge-commit key pinned at install) and it is on the integration branch, then switch to it and
# restart the worker (reconcile first). Runs every 5 minutes from zeroed-update.timer.
set -euo pipefail
. /usr/local/lib/zeroed/common.sh

REPO_DIR=/opt/zeroed/repo
git -C "$REPO_DIR" fetch --quiet --force --no-tags origin \
  "+refs/tags/deploy:refs/tags/deploy" "+refs/heads/$ZEROED_BRANCH:refs/remotes/origin/$ZEROED_BRANCH" 2>/dev/null || exit 0
commit="$(git -C "$REPO_DIR" rev-parse --verify --quiet 'refs/tags/deploy^{commit}')" || exit 0
current="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
[ "$commit" != "$current" ] || exit 0

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

dest="/opt/zeroed/releases/$commit"
if [ ! -d "$dest" ]; then
  mkdir -p "$dest.new"
  git -C "$REPO_DIR" archive "$commit" | tar -x -C "$dest.new" --no-same-owner
  mv "$dest.new" "$dest"
fi
ln -sfn "$dest" /opt/zeroed/current.new
mv -Tf /opt/zeroed/current.new /opt/zeroed/current
printf '%s\n' "$commit" > "$STATE_DIR/deployed"

# Restart with reconcile first (ExecStartPre). Before pairing the worker is not started at all.
worker="not started (no keys yet)"
if [ -s "$CRED_DIR/helius_api_key" ]; then
  if systemctl restart zeroed-worker.service; then worker=restarted; else worker="failed to start"; fi
fi
log "Deployed ${commit:0:12}. Worker: $worker."
notify "Zeroed host: deployed ${commit:0:12}. Worker $worker." || true
__ZEROED_FILE__

install -d -m 0755 -o root -g root /etc/zeroed /opt/zeroed /opt/zeroed/releases
install -d -m 0700 -o root -g root /etc/zeroed/age /etc/credstore.encrypted /var/lib/zeroed-host /var/backups/zeroed

say "Host key"
if [ ! -s /etc/zeroed/age/host.key ]; then
  age-keygen -o /etc/zeroed/age/host.key.new 2>/dev/null
  chmod 0400 /etc/zeroed/age/host.key.new
  mv /etc/zeroed/age/host.key.new /etc/zeroed/age/host.key
fi
chmod 0400 /etc/zeroed/age/host.key
HOST_PUBLIC_KEY="$(age-keygen -y /etc/zeroed/age/host.key)"
# systemd's own host key for encrypted credentials (root-only, created once).
[ -s /var/lib/systemd/credential.secret ] || systemd-creds setup >/dev/null

if [ -s /etc/zeroed/host.env ] && grep -q '^PAIRING_CODE=' /etc/zeroed/host.env; then
  PAIRING_CODE="$(sed -n 's/^PAIRING_CODE=//p' /etc/zeroed/host.env)"
else
  raw="$(LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 12 || true)"
  PAIRING_CODE="${raw:0:4}-${raw:4:4}-${raw:8:4}"
fi
cat > /etc/zeroed/host.env.new <<EOF
ZEROED_REPO=$REPO
ZEROED_BRANCH=$BRANCH
ZEROED_GITHUB_URL=$GITHUB_URL
ZEROED_API_URL=$API_URL
ZEROED_TELEGRAM_URL=$TELEGRAM_URL
WEB_FLOW_FPR=$WEB_FLOW_FPR
PAIRING_CODE=$PAIRING_CODE
EOF
chmod 0644 /etc/zeroed/host.env.new
mv /etc/zeroed/host.env.new /etc/zeroed/host.env
[ -f /etc/zeroed/worker.env ] || install -m 0644 /dev/null /etc/zeroed/worker.env

say "GitHub merge-signing key"
install -d -m 0700 /etc/zeroed/gnupg
GNUPGHOME=/etc/zeroed/gnupg gpg --batch --quiet --import /etc/zeroed/github-web-flow.asc 2>/dev/null
got="$(GNUPGHOME=/etc/zeroed/gnupg gpg --batch --with-colons --fingerprint 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
[ "$got" = "$WEB_FLOW_FPR" ] || die "GitHub signing key fingerprint mismatch"

say "Firewall: no inbound ports${SSH_KEY:+ except SSH (key-only)}"
if [ -n "$SSH_KEY" ]; then
  install -d -m 0700 /root/.ssh
  printf '%s\n' "$SSH_KEY" > /root/.ssh/authorized_keys
  chmod 0600 /root/.ssh/authorized_keys
  install -d -m 0755 /etc/ssh/sshd_config.d
  printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' 'AuthenticationMethods publickey' > /etc/ssh/sshd_config.d/10-zeroed.conf
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
# Starts once credentials exist (skipped by its ConditionPathExists until then).
systemctl start zeroed-worker.service || true

cat <<EOF

Zeroed host installed.

  Host public key:  $HOST_PUBLIC_KEY
  Pairing code:     $PAIRING_CODE

Next: in GitHub, run the "Deploy" workflow and paste these two values into its form.
Both are safe to share; neither is a secret. The host picks up its keys within a minute
and confirms in Telegram.
EOF
