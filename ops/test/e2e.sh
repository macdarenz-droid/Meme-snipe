#!/usr/bin/env bash
# End-to-end test of OPS-1a on a fresh Ubuntu 24.04 systemd container, with TEST values only.
# Install → wrong deploy code → key handoff → Telegram /pair → hardening → rotation and replay → code update
# gates → backup and restore drill → restart drills → scan of every log and output for every test value and
# code. Prints PASS/FAIL lines; exits non-zero on the first failure.
# Needs: docker (daemon running), node 22, age, git, gpg, curl.
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
}
set_values A
VALUES_A=("$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM")
T_CHAT="4242$(rnd 2 | tr -dc 0-9)42"
STRANGER="7$(rnd 2 | tr -dc 0-9)7"
CODES=()
echo "Working in $E2E"
mkdir -p "$LOGS/console"

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
mkdir -p "$STATE/checks"
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
line="$(sed -n '/^curl -fsSL/p' "$ROOT/ops/README.md")"
[ -n "$line" ] && [ "${#line}" -le 240 ] && ! printf '%s' "$line" | LC_ALL=C grep -q '[^ -~]' || fail "README install line missing, over 240 characters or not plain ASCII"
hash="$(printf '%s' "$line" | sed -n "s/.*echo '\([0-9a-f]\{64\}\)  i'.*/\1/p")"
pin="$(printf '%s' "$line" | sed -n 's#.*raw\.githubusercontent\.com/macdarenz-droid/Meme-snipe/\([0-9a-f]\{40\}\)/ops/install\.sh.*#\1#p')"
[ "$(sha256sum < "$ROOT/ops/install.sh" | cut -c1-64)" = "$hash" ] || fail "install.sh does not match the hash in the README line"
[ -n "$pin" ] && [ "$(git -C "$ROOT" show "$pin:ops/install.sh" | sha256sum | cut -c1-64)" = "$hash" ] || fail "the pinned commit ${pin:0:12} does not hold this install.sh (re-pin the README)"
docker cp "$ROOT/ops/install.sh" "$C:/root/i"
in_c "cd /root && echo '$hash  i' | sha256sum -c" >"$LOGS/console/hash-check.txt" 2>&1 || fail "hash check in the container"
pass "README line: ${#line} ASCII characters, pinned to ${pin:0:12} which holds install.sh with the same SHA-256; checked in the container"
docker exec -e ZEROED_NO_WAIT=1 -e ZEROED_GITHUB_URL="$BASE" -e ZEROED_API_URL="$BASE" -e ZEROED_TELEGRAM_URL="$BASE" "$C" bash /root/i >"$LOGS/console/install.txt" 2>&1 || { tail -20 "$LOGS/console/install.txt"; fail "install"; }
CODE1="$(sed -n 's/^  Deploy code:  \([a-z -]*\)$/\1/p' "$LOGS/console/install.txt")"
[ "$(printf '%s' "$CODE1" | wc -w)" = 6 ] || fail "installer did not show a 6-word deploy code"
CODES+=("$CODE1")
for w in $CODE1; do grep -qx -- "$w" "$ROOT/ops/host/files/usr/local/share/zeroed/eff_large_wordlist.txt" || fail "code word not from the EFF list"; done
in_c "systemctl is-active zeroed-signer" >/dev/null || fail "signer not running"
in_c "! systemctl is-active zeroed-worker" >/dev/null || fail "worker started without keys"
in_c "for t in zeroed-pair zeroed-update zeroed-backup; do systemctl is-active \$t.timer; done" >/dev/null || fail "timers not active"
in_c "stat -c '%a %U' /etc/zeroed/deploy-code /etc/zeroed/age/host.key" | sort -u | grep -qx '400 root' || fail "deploy code and host key are not root-only 0400"
in_c "nft list ruleset" >"$LOGS/nft.txt"
grep -q 'hook input priority filter; policy drop;' "$LOGS/nft.txt" && ! grep -q 'dport 22' "$LOGS/nft.txt" || fail "inbound not closed"
in_c "systemctl is-enabled unattended-upgrades && grep -q 'Unattended-Upgrade \"1\"' /etc/apt/apt.conf.d/20auto-upgrades" >/dev/null || fail "unattended security updates not on"
pass "install: 6-word EFF deploy code shown (root-only 0400 on disk), signer up, worker waiting, timers on, inbound policy drop with no SSH, unattended upgrades on"

# ---------- 3. Deploy with a wrong code fails cleanly ----------
publish() { # issued log code [extra env...]
  local issued="$1" log="$2" code="$3"
  shift 3
  env -i PATH="$STUBS:$PATH" HOME="$E2E" STATE="$STATE" GH_REPO="$REPO" GITHUB_SHA="$signed" ISSUED="$issued" DEPLOY_CODE="$code" \
    HELIUS_API_KEY="$T_HELIUS" ALCHEMY_API_KEY="$T_ALCHEMY" JUPITER_API_KEY="$T_JUPITER" TELEGRAM_BOT_TOKEN="$T_TELEGRAM" \
    PICKUP_TIMEOUT_S=150 PICKUP_POLL_S=2 PICKUP_GRACE_S=2 "$@" \
    bash "$ROOT/ops/deploy/publish.sh" >"$LOGS/$log" 2>&1
}
status() { in_c "zeroed-status" >"$LOGS/console/status-$1.txt" 2>&1; cat "$LOGS/console/status-$1.txt"; }
WRONG="$(shuf -n 6 "$ROOT/ops/host/files/usr/local/share/zeroed/eff_large_wordlist.txt" | tr '\n' ' ' | sed 's/ $//')"
CODES+=("$WRONG")
publish 1000 publish-wrong.log "$WRONG" || { cat "$LOGS/publish-wrong.log"; fail "publish (wrong code)"; }
status wrong | grep -q 'waiting for Deploy (wrong code)' || fail "status does not show the wrong code"
in_c "test -s /etc/zeroed/deploy-code && ! ls /etc/credstore.encrypted/* 2>/dev/null" >/dev/null || fail "a wrong code changed something"
in_c "journalctl -u zeroed-pair -o cat --no-pager" | grep -q 'does not open with this server' || fail "wrong code not explained"
pass "wrong code: the server downloaded the bundle, could not open it, stored nothing, kept its code and says to check DEPLOY_CODE"

# ---------- 4. Deploy with the right code ----------
start=$(date +%s)
publish 1001 publish-right.log "$CODE1" || { cat "$LOGS/publish-right.log"; fail "publish (right code)"; }
echo "handoff picked up in $(($(date +%s) - start)) s" >>"$LOGS/summary-times.txt"
[ ! -d "$STATE/releases/handoff" ] || fail "release not deleted after pickup"
grep -q 'handoff' "$STATE/gh-calls.log" && ! grep -q -- "$(printf '%s' "$CODE1" | cut -d' ' -f1)" "$STATE/gh-calls.log" || fail "release name reveals the code"
in_c "ls /etc/credstore.encrypted | sort | tr '\n' ' '" | grep -qx 'alchemy_api_key helius_api_key jupiter_api_key telegram_bot_token ' || fail "credential set"
in_c "stat -c '%a %U' /etc/credstore.encrypted/* | sort -u" | grep -qx '600 root' || fail "credentials not 0600 root"
in_c "! test -e /etc/zeroed/deploy-code" || fail "deploy code not wiped"
for pair in "helius_api_key:$T_HELIUS" "telegram_bot_token:$T_TELEGRAM"; do
  want="$(printf '%s' "${pair#*:}" | sha256sum | cut -c1-64)"
  got="$(in_c "systemd-creds decrypt --name=${pair%%:*} /etc/credstore.encrypted/${pair%%:*} - | sha256sum | cut -c1-64")"
  [ "$want" = "$got" ] || fail "${pair%%:*} does not hold the published value"
done
PAIR1="$(status keys | sed -n 's/.*\/pair \([0-9]\{6\}\)$/\1/p')"
[[ "$PAIR1" =~ ^[0-9]{6}$ ]] || fail "no Telegram pairing code shown after the keys arrived"
in_c "! systemctl is-active zeroed-worker" >/dev/null || fail "worker started before pairing"
pass "handoff: 4 keys stored encrypted (0600 root), deploy code wiped (single use), release 'handoff' deleted, pairing code shown, worker waits for pairing"

# Replay: the same code again opens nothing, because the server no longer has it.
before="$(in_c "sha256sum /etc/credstore.encrypted/* | sha256sum")"
publish 1005 publish-replay.log "$CODE1" HELIUS_API_KEY="TESTREPLAY$(rnd 8)" PICKUP_TIMEOUT_S=20 || true
[ "$(in_c "sha256sum /etc/credstore.encrypted/* | sha256sum")" = "$before" ] || fail "a second use of the code changed the keys"
pass "replay: a second Deploy with the used code is never opened (server has no code left); keys unchanged"

# ---------- 5. Telegram /pair ----------
upd=0
send_tg() { # chat text
  upd=$((upd + 1))
  printf '{"update_id":%s,"message":{"message_id":%s,"chat":{"id":%s,"type":"private"},"text":"%s"}}\n' "$((1000 + upd))" "$upd" "$1" "$2" >>"$STATE/updates.jsonl"
  in_c "systemctl start zeroed-pair.service"
}
send_tg "$STRANGER" "/pair 000000"
in_c "! test -e /etc/zeroed/pair-code && ! test -e /etc/credstore.encrypted/telegram_chat_id" || fail "a wrong /pair did not invalidate the code"
tail -1 "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$STRANGER\",\"text\":\"Code not accepted" || fail "wrong /pair not answered"
send_tg "$T_CHAT" "/pair $PAIR1"
in_c "! test -e /etc/credstore.encrypted/telegram_chat_id" || fail "an invalidated code still paired"
PAIR2="$(in_c "zeroed-pair-code" | tee "$LOGS/console/pair-code.txt" | sed -n 's/.*\/pair \([0-9]\{6\}\)$/\1/p')"
[[ "$PAIR2" =~ ^[0-9]{6}$ ]] || fail "zeroed-pair-code"
send_tg "$T_CHAT" "/pair@Zeroed_alerts_bot $PAIR2"
[ "$(in_c "systemd-creds decrypt --name=telegram_chat_id /etc/credstore.encrypted/telegram_chat_id - | sha256sum | cut -c1-64")" = "$(printf '%s' "$T_CHAT" | sha256sum | cut -c1-64)" ] || fail "owner chat not stored"
grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Paired." "$STATE/telegram.jsonl" || fail "no Paired reply"
n0="$(wc -l <"$STATE/telegram.jsonl")"
send_tg "$STRANGER" "/pair $PAIR2"
[ "$(grep -vc getUpdates <(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl"))" = 0 ] || fail "server answered after pairing"
wait_for 30 "worker running after pairing" "docker exec $C systemctl is-active zeroed-worker"
in_c "journalctl -u zeroed-worker -o cat --no-pager" | grep -q 'Reconcile: 0 open intents, 5 of 5 credentials present. OK' || fail "worker did not reconcile with 5 credentials"
status paired | grep -q 'Telegram:  paired' || fail "status not paired"
pass "pairing: a stranger's wrong /pair invalidated the code (one try), the old code then failed, a new console code paired the owner chat (stored encrypted), 'Paired' sent, later messages ignored, worker reconciled and runs"

# ---------- 6. Hardening ----------
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

# ---------- 7. Rotation and an older bundle ----------
set_values B
printf '%s' "$T_TELEGRAM" >"$STATE/telegram-token" # the owner rotated the bot token at BotFather
CODE2="$(in_c "zeroed-new-deploy-code" | tee "$LOGS/console/new-code.txt" | sed -n 's/^Deploy code:  \([a-z -]*\)$/\1/p')"
[ "$(printf '%s' "$CODE2" | wc -w)" = 6 ] || fail "zeroed-new-deploy-code"
CODES+=("$CODE2")
r0="$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents, 5 of 5'")"
publish 1002 publish-rotate.log "$CODE2" || { cat "$LOGS/publish-rotate.log"; fail "publish (rotation)"; }
for pair in "helius_api_key:$T_HELIUS" "alchemy_api_key:$T_ALCHEMY" "jupiter_api_key:$T_JUPITER" "telegram_bot_token:$T_TELEGRAM"; do
  want="$(printf '%s' "${pair#*:}" | sha256sum | cut -c1-64)"
  got="$(in_c "systemd-creds decrypt --name=${pair%%:*} /etc/credstore.encrypted/${pair%%:*} - | sha256sum | cut -c1-64")"
  [ "$want" = "$got" ] || fail "rotation: ${pair%%:*} not replaced"
done
grep -q "\"token_ok\":true,\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed server: keys replaced (issue 1002). Worker restarted." "$STATE/telegram.jsonl" || fail "rotation not confirmed to the owner with the new token"
[ "$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents, 5 of 5'")" -gt "$r0" ] || fail "worker did not reconcile after rotation"
CODE3="$(in_c "zeroed-new-deploy-code" | sed -n 's/^Deploy code:  \([a-z -]*\)$/\1/p')"
CODES+=("$CODE3")
before="$(in_c "sha256sum /etc/credstore.encrypted/* | sha256sum")"
publish 1001 publish-older.log "$CODE3" HELIUS_API_KEY="TESTOLDER$(rnd 8)" || true
[ "$(in_c "sha256sum /etc/credstore.encrypted/* | sha256sum")" = "$before" ] || fail "an older issue number replaced keys"
in_c "cat /var/lib/zeroed-host/handoff_status" | grep -qx 'replay refused' || fail "older bundle not refused"
in_c "rm -f /etc/zeroed/deploy-code"
pass "rotation: a new console code and a re-run of Deploy replaced all 4 keys, worker reconciled and restarted, owner told; a bundle with an older run number is refused"

# ---------- 8. Code update gates ----------
upd_run() { in_c "systemctl start zeroed-update.service" 2>/dev/null; }
current() { in_c "readlink /opt/zeroed/current 2>/dev/null || true"; }
echo failure >"$STATE/checks/$signed"
upd_run || true
[ -z "$(current)" ] || fail "deployed with a failed check"
echo pending >"$STATE/checks/$signed"
upd_run || true
[ -z "$(current)" ] || fail "deployed with a pending check"
echo success >"$STATE/checks/$signed"
in_c "echo 2 > /var/lib/zeroed/open_intents"
upd_run || true
[ -z "$(current)" ] || fail "deployed with open intents"
in_c "echo 0 > /var/lib/zeroed/open_intents"
upd_run || fail "update failed on a green, GitHub-signed commit"
[ "$(current)" = "/opt/zeroed/releases/$signed" ] || fail "current release not switched"
in_c "journalctl -u zeroed-update -o cat --no-pager" >"$LOGS/update-journal.txt"
grep -q 'its checks are red' "$LOGS/update-journal.txt" && grep -q 'its checks are pending' "$LOGS/update-journal.txt" && grep -q 'open intents (2)' "$LOGS/update-journal.txt" || fail "update reasons not logged"
git -C "$BARE" tag -f deploy "$unsigned" >/dev/null && git -C "$BARE" update-server-info
echo success >"$STATE/checks/$unsigned"
upd_run && fail "an unsigned commit was deployed"
[ "$(current)" = "/opt/zeroed/releases/$signed" ] || fail "current moved to an unsigned commit"
git -C "$BARE" tag -f deploy "$signed" >/dev/null && git -C "$BARE" update-server-info
pass "update: waits on failed and pending checks and on open intents; deploys the green GitHub-signed merge ${signed:0:12} with reconcile first; refuses unsigned ${unsigned:0:12}"

# ---------- 9. Backup and restore drill ----------
in_c "systemctl start zeroed-backup.service" || fail "backup failed"
bk="$(in_c "ls -1 /var/backups/zeroed/ | tail -1")"
[[ "$bk" =~ ^zeroed-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]] || fail "no backup file"
in_c "zeroed-restore-drill /etc/zeroed/age/host.key" >"$LOGS/drill-host.txt" 2>&1 || { cat "$LOGS/drill-host.txt"; fail "drill"; }
in_c "cp /var/backups/zeroed/$bk /root/tampered.age && printf 'x' | dd of=/root/tampered.age bs=1 seek=200 conv=notrunc 2>/dev/null"
in_c "zeroed-restore-drill /etc/zeroed/age/host.key /root/tampered.age" >"$LOGS/drill-tampered.txt" 2>&1 && fail "tampered backup passed"
in_c "rm -f /root/tampered.age"
grep -q '^PASS' "$LOGS/drill-host.txt" && grep -q 'host_events' "$LOGS/drill-host.txt" && grep -q '^FAIL' "$LOGS/drill-tampered.txt" || fail "drill output"
in_c "systemctl is-enabled zeroed-backup.timer && systemctl show -p TimersCalendar --value zeroed-backup.timer" | grep -q 'OnCalendar=\*-\*-\* \*:00:00' || fail "backup timer is not hourly"
pass "backup: hourly timer, $bk encrypted; restore drill PASS into a scratch directory, FAIL on a tampered file"

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
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) console.log(JSON.parse(l).text)' "$STATE/telegram.jsonl" >"$LOGS/telegram-texts.txt"
KEYS=("${VALUES_A[@]}" "$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM" "$T_CHAT")
scan() { # label values-array-name paths...
  local label="$1" hits=0 v
  local -n vals="$2"
  shift 2
  for v in "${vals[@]}"; do
    if grep -rlaF -- "$v" "$@" 2>/dev/null | grep -q .; then
      echo "  value #$(printf '%s' "$v" | sha256sum | cut -c1-8) found in: $(grep -rlaF -- "$v" "$@" | head -3 | tr '\n' ' ')"
      hits=$((hits + 1))
    fi
  done
  [ "$hits" = 0 ] || fail "secret scan ($label): $hits value(s) found"
}
# Keys and the chat id: nowhere, console included.
scan "keys in logs and console" KEYS "$LOGS" "$STATE/gh-calls.log"
scan "keys on the container disk (not /run/credentials)" KEYS "$E2E/fs"
scan "keys in the repo" KEYS "$ROOT/ops" "$ROOT/packages/ops" "$ROOT/.github"
# Deploy codes: shown on the console by design (the owner reads them there), nowhere else.
NONCONSOLE=("$LOGS"/*.txt "$LOGS"/*.json "$LOGS"/*.log)
scan "deploy codes outside the console" CODES "${NONCONSOLE[@]}" "$STATE/gh-calls.log" "$E2E/fs" "$ROOT/ops" "$ROOT/.github"
pass "secret scan: none of ${#KEYS[@]} test values (4 pairing, 4 rotation, the chat id) in any log, console output, Telegram text, journal, container disk or the repo; none of ${#CODES[@]} deploy codes outside the console"

echo
echo "All checks passed. Logs: $LOGS"
