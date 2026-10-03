#!/usr/bin/env bash
# End-to-end test of OPS-1 on a fresh Ubuntu 24.04 systemd container, with TEST values only.
# Install → pairing via Deploy's publish script → hardening → rejects → rotation → code update → backup and
# restore drill → watchdog (local wrangler/miniflare) → restart drills → scan of every log and output for
# every test value. Prints PASS/FAIL lines; exits non-zero on the first failure.
# Needs: docker (daemon running), node 22, age, git, gpg, curl. Run as root (wrangler dev listens on :443).
#   bash ops/test/e2e.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STUBS="$ROOT/ops/test/stubs"
E2E="${E2E_DIR:-$(mktemp -d)}"
STATE="$E2E/state"
LOGS="$E2E/logs"
mkdir -p "$STATE/releases" "$LOGS"
C=zeroed-e2e
PORT=8787
REPO=macdarenz-droid/Meme-snipe
BRANCH=ccr-14987baf-i6lrsl
WRANGLER_VERSION=4.141.0
KEEP="${1:-}"

pass() { printf 'PASS  %s\n' "$*" | tee -a "$LOGS/summary.txt"; }
fail() { printf 'FAIL  %s\n' "$*" | tee -a "$LOGS/summary.txt"; exit 1; }
in_c() { docker exec "$C" bash -c "$1"; }
rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
wait_for() { # seconds description command
  local end=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$end" ]; do
    if bash -c "$3" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "$2 (timed out after $1 s)"
}

cleanup() {
  [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null || true
  [ -n "${WD_PID:-}" ] && kill -- "-$WD_PID" 2>/dev/null || true # wrangler, its node and workerd children
  [ "$KEEP" = --keep ] && { echo "Kept container $C and $E2E"; return; }
  docker rm -f "$C" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Test values: random each run, clearly marked TEST, never real.
set_values() { # suffix
  T_HELIUS="TESTHELIUS$1$(rnd 12)"
  T_ALCHEMY="TESTALCHEMY$1$(rnd 12)"
  T_JUPITER="TESTJUPITER$1$(rnd 12)"
  T_TELEGRAM="99$(rnd 3 | tr -dc 0-9 | head -c 6)0:TESTtelegram$1$(rnd 10)"
  T_CHAT="4242$(rnd 2 | tr -dc 0-9)42"
}
set_values A
VALUES_A=("$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM" "$T_CHAT")
T_CF="TESTcloudflare$(rnd 12)"
echo "Working in $E2E"

# ---------- 1. Fake GitHub (releases, API, dumb-HTTP git) and Telegram ----------
GW="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
BASE="http://$GW:$PORT"
BARE="$E2E/git/$REPO.git"
mkdir -p "$(dirname "$BARE")"
git -C "$ROOT" fetch -q origin "$BRANCH"
git clone -q --bare --no-local "$ROOT" "$BARE"
git -C "$BARE" fetch -q "$ROOT" "+refs/remotes/origin/$BRANCH:refs/heads/$BRANCH"
export GNUPGHOME="$E2E/gnupg"
mkdir -p -m 0700 "$GNUPGHOME"
gpg --batch --quiet --import "$ROOT/ops/host/files/etc/zeroed/github-web-flow.asc" 2>/dev/null
signed=""
unsigned=""
for c in $(git -C "$BARE" rev-list --first-parent --max-count=50 "$BRANCH"); do
  if git -C "$BARE" verify-commit --raw "$c" 2>&1 | grep -q 'VALIDSIG .* 968479A1AFF927E37D1A566BB5690EEEBB952194$'; then
    [ -n "$signed" ] || signed="$c"
  else
    [ -n "$unsigned" ] || unsigned="$c"
  fi
done
[ -n "$signed" ] && [ -n "$unsigned" ] || fail "test repo needs a GitHub-signed and an unsigned commit on $BRANCH"
git -C "$BARE" tag -f deploy "$signed" >/dev/null
git -C "$BARE" update-server-info
printf '%s' "$T_TELEGRAM" >"$STATE/telegram-token"
STATE="$STATE" GIT_ROOT="$E2E/git" PORT="$PORT" node "$ROOT/ops/test/fake-services.mjs" >"$LOGS/fake-services.log" 2>&1 &
FAKE_PID=$!
sleep 1
kill -0 "$FAKE_PID" 2>/dev/null || fail "fake services did not start (port $PORT busy?)"
wait_for 15 "fake services up" "curl -s -o /dev/null http://127.0.0.1:$PORT/"
pass "fake GitHub and Telegram up at $BASE"

# ---------- 2. Fresh server, owner's install line ----------
docker image inspect zeroed-e2e-host >/dev/null 2>&1 || docker build -q -t zeroed-e2e-host -f "$ROOT/ops/test/host.Dockerfile" "$ROOT/ops/test" >/dev/null
docker rm -f "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw zeroed-e2e-host >/dev/null
wait_for 60 "systemd up in the container" "docker exec $C systemctl is-system-running | grep -Eq 'running|degraded'"
# Docker starts containers with private mount propagation; systemd on a real server has / shared, which
# it needs to hand credentials to services. Restore that.
in_c "mount --make-rshared /"
# A sandbox that intercepts HTTPS with its own CA (E2E_EXTRA_CA) needs it trusted inside the test server.
if [ -n "${E2E_EXTRA_CA:-}" ]; then
  docker cp "$E2E_EXTRA_CA" "$C:/usr/local/share/ca-certificates/e2e-extra.crt"
  in_c "update-ca-certificates >/dev/null 2>&1"
fi
docker cp "$ROOT/ops/install.sh" "$C:/root/install.sh"
hash="$(sed -n 's/^SHA-256 of `install\.sh`: `\([0-9a-f]\{64\}\)`$/\1/p' "$ROOT/ops/README.md")"
in_c "cd /root && echo '$hash  install.sh' | sha256sum -c -" >"$LOGS/hash-check.log" 2>&1 || fail "install.sh does not match the README hash"
pin="$(sed -n 's#.*raw\.githubusercontent\.com/macdarenz-droid/Meme-snipe/\([0-9a-f]\{40\}\)/ops/install\.sh.*#\1#p' "$ROOT/ops/README.md")"
[ -n "$pin" ] || fail "README install line has no pinned commit"
[ "$(git -C "$ROOT" show "$pin:ops/install.sh" | sha256sum | cut -c1-64)" = "$hash" ] || fail "the pinned commit ${pin:0:12} does not hold this install.sh (re-pin the README)"
pass "install.sh matches the SHA-256 in ops/README.md, and the pinned commit ${pin:0:12} holds the same file"
docker exec -e ZEROED_GITHUB_URL="$BASE" -e ZEROED_API_URL="$BASE" -e ZEROED_TELEGRAM_URL="$BASE" "$C" bash /root/install.sh >"$LOGS/install.log" 2>&1 || { tail -20 "$LOGS/install.log"; fail "install.sh"; }
HOST_KEY="$(sed -n 's/^  Host public key:  \(age1[a-z0-9]*\)$/\1/p' "$LOGS/install.log")"
CODE="$(sed -n 's/^  Pairing code:     \([A-Z0-9-]*\)$/\1/p' "$LOGS/install.log")"
[[ "$HOST_KEY" =~ ^age1[a-z0-9]{58}$ ]] && [[ "$CODE" =~ ^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$ ]] || fail "installer did not print a host key and pairing code"
pass "install finished; printed host public key and pairing code only"

# Before pairing.
in_c "systemctl is-active zeroed-signer" >/dev/null || fail "signer not running"
in_c "! systemctl is-active zeroed-worker" >/dev/null || fail "worker started without keys"
in_c "for t in zeroed-pair zeroed-update zeroed-backup; do systemctl is-active \$t.timer; done" >/dev/null || fail "timers not active"
in_c "stat -c '%a %U' /etc/zeroed/age/host.key" | grep -qx '400 root' || fail "host key is not root-only 0400"
in_c "nft list ruleset" >"$LOGS/nft.txt"
grep -q 'hook input priority filter; policy drop;' "$LOGS/nft.txt" && ! grep -q 'dport 22' "$LOGS/nft.txt" || fail "inbound not closed"
in_c "! systemctl is-active ssh.service ssh.socket" >/dev/null 2>&1 || true
in_c "systemctl is-enabled unattended-upgrades && grep -q 'Unattended-Upgrade \"1\"' /etc/apt/apt.conf.d/20auto-upgrades" >/dev/null || fail "unattended security updates not on"
pass "before pairing: signer up, worker waiting for keys, timers on, host key 0400 root, inbound policy drop with no SSH, unattended upgrades on"

# ---------- 3. Pairing: Deploy's publish script with TEST secrets ----------
publish() { # issued log [extra env...]
  local issued="$1" log="$2"
  shift 2
  env -i PATH="$STUBS:$PATH" HOME="$E2E" STATE="$STATE" GH_REPO="$REPO" GITHUB_SHA="$signed" ISSUED="$issued" \
    HOST_PUBLIC_KEY="$HOST_KEY" PAIRING_CODE="$CODE" \
    HELIUS_API_KEY="$T_HELIUS" ALCHEMY_API_KEY="$T_ALCHEMY" JUPITER_API_KEY="$T_JUPITER" \
    TELEGRAM_BOT_TOKEN="$T_TELEGRAM" TELEGRAM_CHAT_ID="$T_CHAT" \
    PICKUP_TIMEOUT_S=150 PICKUP_POLL_S=2 PICKUP_GRACE_S=2 "$@" \
    bash "$ROOT/ops/deploy/publish.sh" >"$LOGS/$log" 2>&1
}
start=$(date +%s)
publish 1001 publish-pair.log || { cat "$LOGS/publish-pair.log"; fail "publish (pairing)"; }
echo "pairing picked up in $(($(date +%s) - start)) s" >>"$LOGS/summary-times.txt"
grep -q 'The host downloaded the bundle' "$LOGS/publish-pair.log" || fail "workflow did not see the pickup"
[ ! -d "$STATE/releases/pair-$CODE" ] || fail "release not deleted after pickup"
wait_for 60 "Telegram confirmation" "grep -q 'keys stored (6 values, issue 1001)' '$STATE/telegram.jsonl'"
grep 'keys stored' "$STATE/telegram.jsonl" | tail -1 | grep -q "\"token_ok\":true,\"chat_id\":\"$T_CHAT\"" || fail "confirmation not sent with the stored token to the owner chat"
in_c "systemctl is-active zeroed-worker" >/dev/null || fail "worker not running after pairing"
in_c "ls /etc/credstore.encrypted | sort | tr '\n' ' '" | grep -qx 'alchemy_api_key heartbeat_hmac_key helius_api_key jupiter_api_key telegram_bot_token telegram_chat_id ' || fail "credential set"
in_c "stat -c '%a %U' /etc/credstore.encrypted/* | sort -u" | grep -qx '600 root' || fail "credentials not 0600 root"
in_c "journalctl -u zeroed-worker -o cat --no-pager" | grep -q 'Reconcile: 0 open intents, 6 of 6 credentials present. OK' || fail "worker did not reconcile with 6 credentials"
for pair in "helius_api_key:$T_HELIUS" "telegram_chat_id:$T_CHAT"; do
  want="$(printf '%s' "${pair#*:}" | sha256sum | cut -c1-64)"
  got="$(in_c "systemd-creds decrypt --name=${pair%%:*} /etc/credstore.encrypted/${pair%%:*} - | sha256sum | cut -c1-64")"
  [ "$want" = "$got" ] || fail "${pair%%:*} does not hold the published value"
done
pass "pairing: host picked up the bundle, stored 6 encrypted credentials (0600 root), worker reconciled and runs, Telegram confirmed to the owner chat, release deleted"

# ---------- 4. Hardening ----------
in_c "systemd-analyze security --no-pager zeroed-signer.service zeroed-worker.service" >"$LOGS/systemd-analyze.txt" 2>&1 || true
in_c "systemctl show zeroed-signer -p User -p PrivateNetwork -p RestrictAddressFamilies -p IPAddressDeny -p MemoryDenyWriteExecute -p NoNewPrivileges -p ProtectSystem -p CapabilityBoundingSet" >"$LOGS/signer-props.txt"
for want in 'User=zeroed-signer' 'PrivateNetwork=yes' 'RestrictAddressFamilies=AF_UNIX' 'MemoryDenyWriteExecute=yes' 'NoNewPrivileges=yes' 'ProtectSystem=strict' 'CapabilityBoundingSet='; do
  grep -qx "$want" "$LOGS/signer-props.txt" || fail "signer: $want"
done
grep -q '^IPAddressDeny=.*0.0.0.0/0' "$LOGS/signer-props.txt" || grep -q '^IPAddressDeny=.*any' "$LOGS/signer-props.txt" || fail "signer: IPAddressDeny"
spid="$(in_c "systemctl show -p MainPID --value zeroed-signer")"
in_c "awk 'NR>2 {print \$1}' /proc/$spid/net/dev" | tr -d ' ' | grep -qx 'lo:' || fail "signer sees a network interface besides lo"
in_c "systemctl show zeroed-worker -p User -p NoNewPrivileges -p ProtectSystem -p RestrictAddressFamilies -p CapabilityBoundingSet -p ProtectHome -p PrivateTmp" >"$LOGS/worker-props.txt"
for want in 'User=zeroed-worker' 'NoNewPrivileges=yes' 'ProtectSystem=strict' 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' 'CapabilityBoundingSet=' 'ProtectHome=yes' 'PrivateTmp=yes'; do
  grep -qx "$want" "$LOGS/worker-props.txt" || fail "worker: $want"
done
in_c "setpriv --reuid zeroed-worker --regid zeroed-worker --init-groups curl -sS -m 5 -o /dev/null $BASE/" 2>/dev/null && fail "worker uid reached a non-443 port"
in_c "curl -sS -m 5 -o /dev/null $BASE/" || fail "root could not reach the fake service (test setup)"
in_c "setpriv --reuid zeroed-worker --regid zeroed-worker --init-groups node -e \"require('net').connect('/run/zeroed-signer/signer.sock').on('data',d=>{process.stdout.write(d);process.exit(0)}).write('status\\\\n')\"" | grep -q '"status":"not-ready"' || fail "worker cannot reach the signer socket"
in_c "! setpriv --reuid nobody --regid nogroup --clear-groups test -w /run/zeroed-signer/signer.sock" || fail "signer socket reachable by other users"
pass "hardening: signer no network (only lo, AF_UNIX, IPAddressDeny, MDWE, jitless), worker sandboxed, worker uid limited to 443/53 out, signer socket only for the worker group"

# ---------- 5. Rejects: wrong key, wrong author, replay ----------
other="$(age-keygen 2>/dev/null | sed -n 's/^# public key: //p')"
creds_sum() { in_c "sha256sum /etc/credstore.encrypted/* | sha256sum | cut -c1-64"; }
before="$(creds_sum)"
inject() { # recipient author issued code
  mkdir -p "$STATE/releases/pair-$CODE"
  printf 'ZEROED_BUNDLE=1\nPAIRING_CODE=%s\nISSUED=%s\nHELIUS_API_KEY=TESTEVIL\nALCHEMY_API_KEY=TESTEVIL\nJUPITER_API_KEY=TESTEVIL\nTELEGRAM_BOT_TOKEN=1:TESTEVIL\nTELEGRAM_CHAT_ID=1\nHEARTBEAT_HMAC_KEY=TESTEVIL\n' "$4" "$3" | age -r "$1" -o "$STATE/releases/pair-$CODE/secrets.age"
  printf '{"author":"%s","download_count":0}' "$2" >"$STATE/releases/pair-$CODE/meta.json"
}
inject "$other" 'github-actions[bot]' 2000 "$CODE"
in_c "systemctl start zeroed-pair.service" 2>/dev/null && fail "bundle for another key was accepted"
inject "$HOST_KEY" 'someone' 2000 "$CODE"
in_c "systemctl start zeroed-pair.service" || fail "pair service errored on a foreign release"
inject "$HOST_KEY" 'github-actions[bot]' 2000 "AAAA-BBBB-CCCC"
in_c "systemctl start zeroed-pair.service" 2>/dev/null && fail "bundle with another pairing code was accepted"
inject "$HOST_KEY" 'github-actions[bot]' 1000 "$CODE"
in_c "systemctl start zeroed-pair.service" || fail "pair service errored on an old bundle"
rm -rf "$STATE/releases/pair-$CODE"
[ "$(creds_sum)" = "$before" ] || fail "a rejected bundle changed the credentials"
in_c "journalctl -u zeroed-pair -o cat --no-pager" >"$LOGS/pair-journal.txt"
grep -q "not made for this host's key" "$LOGS/pair-journal.txt" && grep -q 'not published by the repository' "$LOGS/pair-journal.txt" && grep -q 'pairing code inside does not match' "$LOGS/pair-journal.txt" || fail "reject reasons not logged"
pass "rejects: another host's key, a release not made by the workflow, another pairing code and an older issue number all leave the credentials unchanged"

# ---------- 6. Rotation (re-run Deploy, with the watchdog path) ----------
set_values B
printf '%s' "$T_TELEGRAM" >"$STATE/telegram-token" # the owner rotated the bot token at BotFather
OWNER_KEY_FILE="$E2E/owner-backup.txt"
age-keygen -o "$OWNER_KEY_FILE" 2>/dev/null
OWNER_PUB="$(age-keygen -y "$OWNER_KEY_FILE")"
publish 1002 publish-rotate.log BACKUP_RECIPIENT="$OWNER_PUB" CLOUDFLARE_API_TOKEN="$T_CF" WRANGLER="$STUBS/wrangler --config packages/ops/wrangler.toml" TELEGRAM_API="http://127.0.0.1:$PORT" || { cat "$LOGS/publish-rotate.log"; fail "publish (rotation)"; }
wait_for 90 "rotation confirmation" "grep -q 'issue 1002' '$STATE/telegram.jsonl'"
grep 'issue 1002' "$STATE/telegram.jsonl" | tail -1 | grep -q '"token_ok":true' || fail "rotation confirmation not sent with the new token"
for pair in "helius_api_key:$T_HELIUS" "alchemy_api_key:$T_ALCHEMY" "jupiter_api_key:$T_JUPITER" "telegram_bot_token:$T_TELEGRAM" "telegram_chat_id:$T_CHAT" "heartbeat_hmac_key:$(cat "$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY")"; do
  want="$(printf '%s' "${pair#*:}" | sha256sum | cut -c1-64)"
  got="$(in_c "systemd-creds decrypt --name=${pair%%:*} /etc/credstore.encrypted/${pair%%:*} - | sha256sum | cut -c1-64")"
  [ "$want" = "$got" ] || fail "rotation: ${pair%%:*} not replaced"
done
grep -q '"method":"setWebhook","token_ok":true' "$STATE/telegram.jsonl" && grep -q '"has_secret_token":true' "$STATE/telegram.jsonl" || fail "webhook not set with a secret token"
[ "$(sort "$STATE/wrangler-calls.log" | tr '\n' ' ')" = "secret put HEARTBEAT_HMAC_KEY secret put OWNER_CHAT_ID secret put TELEGRAM_BOT_TOKEN secret put TELEGRAM_WEBHOOK_SECRET " ] || fail "watchdog secrets"
[ "$(cmp -s "$STATE/wrangler-secrets/TELEGRAM_BOT_TOKEN" <(printf '%s' "$T_TELEGRAM") && echo same)" = same ] || fail "watchdog got a different bot token"
in_c "grep -c . /etc/zeroed/backup-recipients" | grep -qx 2 || fail "owner backup key not added"
in_c "grep -qx 'WATCHDOG_URL=https://zeroed-watchdog.e2e.workers.dev' /etc/zeroed/worker.env" || fail "watchdog address not delivered"
[ "$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents, 6 of 6'")" -ge 2 ] || fail "worker did not reconcile again after rotation"
pass "rotation: re-running Deploy replaced all 6 values (heartbeat key too), redeployed the watchdog secrets and webhook, added the owner backup key, worker reconciled and restarted"

# ---------- 7. Code update by signed tag ----------
in_c "systemctl start zeroed-update.service" || fail "update service failed on a GitHub-signed commit"
[ "$(in_c "readlink /opt/zeroed/current")" = "/opt/zeroed/releases/$signed" ] || fail "current release not switched"
in_c "test -f /opt/zeroed/current/ops/install.sh || test -f /opt/zeroed/current/package.json" || fail "release tree empty"
git -C "$BARE" tag -f deploy "$unsigned" >/dev/null
git -C "$BARE" update-server-info
in_c "systemctl start zeroed-update.service" 2>/dev/null && fail "an unsigned commit was deployed"
[ "$(in_c "readlink /opt/zeroed/current")" = "/opt/zeroed/releases/$signed" ] || fail "current moved to an unsigned commit"
in_c "journalctl -u zeroed-update -o cat --no-pager" | grep -q "not signed by GitHub's merge key" || fail "refusal not logged"
git -C "$BARE" tag -f deploy "$signed" >/dev/null
git -C "$BARE" update-server-info
pass "update: GitHub-signed merge ${signed:0:12} deployed with reconcile-first restart; unsigned ${unsigned:0:12} refused and current kept"

# ---------- 8. Backup and restore drill ----------
in_c "systemctl start zeroed-backup.service" || fail "backup failed"
bk="$(in_c "ls -1 /var/backups/zeroed/ | tail -1")"
[[ "$bk" =~ ^zeroed-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]] || fail "no backup file"
in_c "zeroed-restore-drill /etc/zeroed/age/host.key" >"$LOGS/drill-host.txt" 2>&1 || { cat "$LOGS/drill-host.txt"; fail "drill with the host key"; }
docker cp "$OWNER_KEY_FILE" "$C:/root/owner-backup.txt" >/dev/null
in_c "zeroed-restore-drill /root/owner-backup.txt /var/backups/zeroed/$bk" >"$LOGS/drill-owner.txt" 2>&1 || { cat "$LOGS/drill-owner.txt"; fail "drill with the owner key"; }
in_c "cp /var/backups/zeroed/$bk /root/tampered.age && printf 'x' | dd of=/root/tampered.age bs=1 seek=200 conv=notrunc 2>/dev/null"
in_c "zeroed-restore-drill /root/owner-backup.txt /root/tampered.age" >"$LOGS/drill-tampered.txt" 2>&1 && fail "tampered backup passed"
in_c "rm -f /root/owner-backup.txt /root/tampered.age"
grep -q '^PASS' "$LOGS/drill-owner.txt" && grep -q 'host_events' "$LOGS/drill-owner.txt" && grep -q '^FAIL' "$LOGS/drill-tampered.txt" || fail "drill output"
in_c "systemctl is-enabled zeroed-backup.timer && systemctl show -p TimersCalendar --value zeroed-backup.timer" | grep -q 'OnCalendar=\*-\*-\* \*:00:00' || fail "backup timer is not hourly"
pass "backup: hourly timer, $bk encrypted to host and owner keys; restore drill PASS with either key, FAIL on a tampered file"

# ---------- 9. Watchdog on local wrangler (miniflare) with the stub worker's real heartbeats ----------
WD="$E2E/watchdog"
mkdir -p "$WD"
cp -r "$ROOT/packages/ops/src" "$ROOT/packages/ops/wrangler.toml" "$WD/"
{
  printf 'HEARTBEAT_HMAC_KEY=%s\n' "$(cat "$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY")"
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$(cat "$STATE/wrangler-secrets/TELEGRAM_BOT_TOKEN")"
  printf 'OWNER_CHAT_ID=%s\n' "$(cat "$STATE/wrangler-secrets/OWNER_CHAT_ID")"
  printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$(cat "$STATE/wrangler-secrets/TELEGRAM_WEBHOOK_SECRET")"
  printf 'TELEGRAM_API=http://127.0.0.1:%s\nCHAIN_RPC_URL=\nHEARTBEAT_MAX_AGE_S=10\n' "$PORT"
} >"$WD/.dev.vars"
curl -s -m 2 -o /dev/null http://127.0.0.1:443/ && fail "port 443 is already in use"
(cd "$WD" && exec setsid npx --yes "wrangler@$WRANGLER_VERSION" dev --local --ip 0.0.0.0 --port 443 --test-scheduled) >"$LOGS/wrangler-dev.log" 2>&1 &
WD_PID=$!
wait_for 120 "wrangler dev up" "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:443/heartbeat | grep -q 401"
in_c "printf 'WATCHDOG_URL=http://$GW:443\nZEROED_HEARTBEAT_MS=3000\n' > /etc/zeroed/worker.env && systemctl restart zeroed-worker"
sched() { curl -s "http://127.0.0.1:443/__scheduled?cron=*+*+*+*+*" >/dev/null; }
hook() { # chat text [secret]
  curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:443/telegram -H 'content-type: application/json' \
    -H "x-telegram-bot-api-secret-token: ${3:-$(cat "$STATE/wrangler-secrets/TELEGRAM_WEBHOOK_SECRET")}" \
    -d "{\"message\":{\"chat\":{\"id\":$1},\"text\":\"$2\"}}"
}
sleep 8
n0="$(wc -l <"$STATE/telegram.jsonl")"
sched
sleep 1
[ "$(wc -l <"$STATE/telegram.jsonl")" = "$n0" ] || fail "watchdog alerted while heartbeats are fresh"
[ "$(hook 777 /pause)" = 200 ] && [ "$(wc -l <"$STATE/telegram.jsonl")" = "$n0" ] || fail "stranger's /pause got an answer"
[ "$(hook "$T_CHAT" /pause wrong-secret)" = 401 ] || fail "webhook accepted a wrong secret"
hook "$T_CHAT" /pause >/dev/null
wait_for 20 "worker applies /pause" "docker exec $C journalctl -u zeroed-worker -o cat --no-pager | grep -q 'Entries paused by the owner'"
hook "$T_CHAT" /status >/dev/null
sleep 1
tail -1 "$STATE/telegram.jsonl" | grep -q 'Entries: paused' || fail "/status reply"
tail -1 "$STATE/telegram.jsonl" | grep -q '(stub worker)' || fail "/status shows the heartbeat"
hook "$T_CHAT" /resume >/dev/null
sleep 1
tail -1 "$STATE/telegram.jsonl" | grep -q 'Commands: /pause, /status' || fail "/resume over Telegram was not refused"
in_c "systemctl stop zeroed-worker"
sleep 13
sched
wait_for 10 "stale-heartbeat alert" "tail -3 '$STATE/telegram.jsonl' | grep -q 'ALERT No heartbeat'"
sched
sleep 1
[ "$(grep -c 'ALERT No heartbeat' "$STATE/telegram.jsonl")" = 1 ] || fail "alert repeated within 5 minutes"
in_c "systemctl start zeroed-worker"
sleep 6
sched
wait_for 10 "cleared line" "tail -3 '$STATE/telegram.jsonl' | grep -q 'CLEARED No heartbeat'"
in_c "zeroed-resume" | grep -q 'Entries allowed again' || fail "zeroed-resume"
wait_for 10 "resume notice" "tail -2 '$STATE/telegram.jsonl' | grep -q 'Entries allowed again'"
grep -E '"method":"sendMessage"' "$STATE/telegram.jsonl" | grep -v -e "\"chat_id\":\"$T_CHAT\"" -e "\"chat_id\":\"${VALUES_A[4]}\"" | grep -q . && fail "a message went to a chat other than the owner's"
pass "watchdog (wrangler $WRANGLER_VERSION dev, miniflare): signed heartbeats from the host; quiet while fresh; /pause and /status only from the owner chat and the right webhook secret; worker applied pause; /resume refused over Telegram; stale alert once, cleared on return; resume only from the host"

# ---------- 10. Restart and crash drills ----------
r0="$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents'")"
in_c "systemctl restart zeroed-worker"
in_c "kill -9 \$(systemctl show -p MainPID --value zeroed-worker)"
wait_for 30 "worker back after kill -9" "docker exec $C systemctl is-active zeroed-worker"
sleep 2
r1="$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents'")"
[ "$r1" -ge $((r0 + 2)) ] || fail "reconcile did not run before each start ($r0 -> $r1)"
in_c "systemctl restart zeroed-signer && systemctl is-active zeroed-signer" >/dev/null || fail "signer restart"
pass "drills: restart and kill -9 both brought the worker back with reconcile first ($r0 -> $r1 reconciles)"

# ---------- 11. Secret scan ----------
in_c "journalctl --no-pager -o cat" >"$LOGS/container-journal.txt"
in_c "journalctl --no-pager -o json" >"$LOGS/container-journal.json"
docker logs "$C" >"$LOGS/container-console.txt" 2>&1
in_c "tar -c --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run/credentials --exclude=/opt/node-v22.23.3 --exclude=/usr --exclude=/opt/zeroed/repo --exclude=/opt/zeroed/releases / 2>/dev/null" >"$E2E/container-fs.tar" || true
mkdir -p "$E2E/fs" && tar -xf "$E2E/container-fs.tar" -C "$E2E/fs" 2>/dev/null || true
HMACS=("$(cat "$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY")" "$(cat "$STATE/wrangler-secrets/TELEGRAM_WEBHOOK_SECRET")")
ALL=("${VALUES_A[@]}" "$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM" "$T_CHAT" "$T_CF" "${HMACS[@]}")
scan() { # label paths...
  local label="$1" hits=0
  shift
  for v in "${ALL[@]}"; do
    # Chat ids are short digit strings; match them only as whole JSON/text tokens.
    if grep -rlaF -- "$v" "$@" 2>/dev/null | grep -q .; then
      echo "  value #$(printf '%s' "$v" | sha256sum | cut -c1-8) found in: $(grep -rlaF -- "$v" "$@" | head -3 | tr '\n' ' ')" >>"$LOGS/../scan-hits.txt"
      hits=$((hits + 1))
    fi
  done
  [ "$hits" = 0 ] || { cat "$LOGS/../scan-hits.txt"; fail "secret scan ($label): $hits value(s) found"; }
}
# Telegram's side naturally knows the chat id; what matters is that no value is in a message text.
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) console.log(JSON.parse(l).text)' "$STATE/telegram.jsonl" >"$LOGS/telegram-texts.txt"
scan "logs and outputs" "$LOGS" "$STATE/gh-calls.log" "$STATE/wrangler-calls.log"
scan "container disk (not /run/credentials)" "$E2E/fs"
scan "repository tree" "$ROOT/ops" "$ROOT/packages/ops" "$ROOT/.github"
pass "secret scan: none of ${#ALL[@]} test values (5 pairing, 5 rotation, Cloudflare token, heartbeat and webhook keys) in any log, output, Telegram text, journal, container disk or the repo"

echo
echo "All checks passed. Logs: $LOGS"
