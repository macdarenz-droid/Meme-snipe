#!/usr/bin/env bash
# End-to-end test of OPS-1a to OPS-1e on a fresh Ubuntu 24.04 systemd container, with TEST values only.
# Install → wrong deploy code → key handoff → Telegram /pair → hardening → rotation and replay → code update
# gates → backup and restore drill → restart drills → dry-run update gate and install --update → webhook
# retry and change alerts → stored-key check → re-pairing → live view → scan of every log and output for every test value and
# code. Prints PASS/FAIL lines; exits non-zero on the first failure.
# Needs: docker (daemon running), node 22, age, git, gpg, curl, jq.
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

# Known-answer vector (ops/test/derive-key-kat.py) through the real age binary: encrypt to the pinned
# recipient, decrypt with the identity derive-key.mjs makes from the code.
KAT_RECIPIENT=age1pdc533pjcgkux8lah569p90yxvmx8djw42pycdt6k943e467tqcs4c4hf0
[ "$(echo kat-ok | age -r "$KAT_RECIPIENT" | age -d -i <(echo 'correct horse battery staple zebra apple' | node "$ROOT/ops/host/files/usr/local/lib/zeroed/derive-key.mjs"))" = kat-ok ] || fail "known-answer age round trip"
[ "$(echo 'correct horse battery staple zebra apple' | node "$ROOT/ops/host/files/usr/local/lib/zeroed/derive-key.mjs" | age-keygen -y)" = "$KAT_RECIPIENT" ] || fail "known-answer recipient"
pass "derive-key known answer: the pinned recipient opens with the derived identity in real age"

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
in_c "for t in zeroed-pair zeroed-update zeroed-backup zeroed-check; do systemctl is-active \$t.timer; done" >/dev/null || fail "timers not active"
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
# A fresh server gets the watchdog in its very first Deploy run (the Cloudflare secrets already exist).
T_CF="TESTcloudflare$(rnd 12)"
printf '%s' "$T_CF" >"$STATE/cf-token"
CF_ENV=(CLOUDFLARE_API_TOKEN="$T_CF" CLOUDFLARE_ACCOUNT_ID=e2e WRANGLER="$STUBS/wrangler --config packages/ops/wrangler.toml" TELEGRAM_API="http://127.0.0.1:$PORT" CLOUDFLARE_API_URL="http://127.0.0.1:$PORT/client/v4")
publish 1001 publish-right.log "$CODE1" "${CF_ENV[@]}" || { cat "$LOGS/publish-right.log"; fail "publish (right code)"; }
grep -q '"method":"setWebhook"' "$STATE/telegram.jsonl" 2>/dev/null && fail "a webhook was set before pairing (it would block /pair)"
echo "handoff picked up in $(($(date +%s) - start)) s" >>"$LOGS/summary-times.txt"
[ ! -d "$STATE/releases/handoff" ] || fail "release not deleted after pickup"
grep -q 'handoff' "$STATE/gh-calls.log" && ! grep -q -- "$(printf '%s' "$CODE1" | cut -d' ' -f1)" "$STATE/gh-calls.log" || fail "release name reveals the code"
in_c "ls /etc/credstore.encrypted | sort | tr '\n' ' '" | grep -qx 'alchemy_api_key heartbeat_hmac_key helius_api_key jupiter_api_key telegram_bot_token telegram_webhook_secret ' || fail "credential set"
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
pass "handoff (with the watchdog, as on a fresh server): 4 keys plus the heartbeat key and webhook secret stored encrypted (0600 root), no webhook set before pairing, deploy code wiped (single use), release 'handoff' deleted, pairing code shown, worker waits for pairing"

# Replay: the same code again opens nothing, because the server no longer has it.
before="$(in_c "sha256sum /etc/credstore.encrypted/* | sha256sum")"
publish 1005 publish-replay.log "$CODE1" HELIUS_API_KEY="TESTREPLAY$(rnd 8)" PICKUP_TIMEOUT_S=20 || true
[ "$(in_c "sha256sum /etc/credstore.encrypted/* | sha256sum")" = "$before" ] || fail "a second use of the code changed the keys"
pass "replay: a second Deploy with the used code is never opened (server has no code left); keys unchanged"

# ---------- 5. Telegram /pair ----------
upd=0
send_tg() { # chat text [chat type]
  upd=$((upd + 1))
  sleep 1 # Telegram dates are whole seconds; keep each message after the code it answers
  printf '{"update_id":%s,"message":{"message_id":%s,"date":%s,"chat":{"id":%s,"type":"%s"},"text":"%s"}}\n' "$((1000 + upd))" "$upd" "$(in_c 'date +%s')" "$1" "${3:-private}" "$2" >>"$STATE/updates.jsonl"
  in_c "systemctl start zeroed-pair.service"
}
send_tg "$STRANGER" "/pair 000000"
in_c "! test -e /etc/zeroed/pair-code && ! test -e /etc/credstore.encrypted/telegram_chat_id" || fail "a wrong /pair did not invalidate the code"
tail -1 "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$STRANGER\",\"text\":\"Code not accepted" || fail "wrong /pair not answered"
send_tg "$T_CHAT" "/pair $PAIR1"
in_c "! test -e /etc/credstore.encrypted/telegram_chat_id" || fail "an invalidated code still paired"
PAIR2="$(in_c "zeroed-pair-code" | tee "$LOGS/console/pair-code.txt" | sed -n 's/.*\/pair \([0-9]\{6\}\)$/\1/p')"
[[ "$PAIR2" =~ ^[0-9]{6}$ ]] || fail "zeroed-pair-code"
send_tg "-100$STRANGER" "/pair 000000" group
in_c "test -s /etc/zeroed/pair-code" || fail "a /pair from a group burned the code"
send_tg "$T_CHAT" "/pair@Zeroed_alerts_bot $PAIR2"
[ "$(in_c "systemd-creds decrypt --name=telegram_chat_id /etc/credstore.encrypted/telegram_chat_id - | sha256sum | cut -c1-64")" = "$(printf '%s' "$T_CHAT" | sha256sum | cut -c1-64)" ] || fail "owner chat not stored"
grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Paired." "$STATE/telegram.jsonl" || fail "no Paired reply"
grep -q '"method":"setWebhook","token_ok":true,"chat_id":"","text":"","url":"https://zeroed-watchdog.e2e.workers.dev/telegram","has_secret_token":true' "$STATE/telegram.jsonl" || fail "the server did not set the watchdog webhook after pairing"
n0="$(wc -l <"$STATE/telegram.jsonl")"
send_tg "$STRANGER" "/pair $PAIR2"
[ "$(grep -vc getUpdates <(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl"))" = 0 ] || fail "server answered after pairing"
wait_for 30 "worker running after pairing" "docker exec $C systemctl is-active zeroed-worker"
in_c "journalctl -u zeroed-worker -o cat --no-pager" | grep -q 'Reconcile: 0 open intents, 5 of 5 credentials present. OK' || fail "worker did not reconcile with 5 credentials"
status paired | grep -q 'Telegram:  paired' || fail "status not paired"
pass "pairing: a group's /pair is ignored (private chats only); a stranger's wrong /pair invalidated the code (one try), the old code then failed, a new console code paired the owner chat (stored encrypted), 'Paired' sent, the server then set the watchdog webhook itself, later messages ignored, worker reconciled and runs"

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
rm -f "$STATE/cf-subdomain" # the account lost its subdomain: Deploy registers a new one
n_hook="$(grep -c '"method":"setWebhook"' "$STATE/telegram.jsonl")"
publish 1002 publish-rotate.log "$CODE2" CLOUDFLARE_API_TOKEN="$T_CF" CLOUDFLARE_ACCOUNT_ID=e2e WRANGLER="$STUBS/wrangler --config packages/ops/wrangler.toml" TELEGRAM_API="http://127.0.0.1:$PORT" CLOUDFLARE_API_URL="http://127.0.0.1:$PORT/client/v4" || { cat "$LOGS/publish-rotate.log"; fail "publish (rotation)"; }
grep -q '"method":"PUT","auth_ok":true' "$STATE/cloudflare.jsonl" && [[ "$(cat "$STATE/cf-subdomain")" =~ ^zeroed-[0-9a-f]{8}$ ]] || fail "workers.dev subdomain not registered"
grep -q "Registered the workers.dev subdomain $(cat "$STATE/cf-subdomain")" "$LOGS/publish-rotate.log" || fail "subdomain registration not reported"
[ "$(in_c "systemd-creds decrypt --name=heartbeat_hmac_key /etc/credstore.encrypted/heartbeat_hmac_key - | sha256sum | cut -c1-64")" = "$(sha256sum <"$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY" | cut -c1-64)" ] || fail "server and watchdog got different heartbeat keys"
in_c "grep -qx 'WATCHDOG_URL=https://zeroed-watchdog.e2e.workers.dev' /etc/zeroed/worker.env" || fail "watchdog address not delivered"
[ "$(sort -u "$STATE/wrangler-calls.log" | tr '\n' ' ')" = "secret put HEARTBEAT_HMAC_KEY secret put TELEGRAM_BOT_TOKEN secret put TELEGRAM_WEBHOOK_SECRET " ] || fail "watchdog secrets"
[ "$(grep -c '"method":"setWebhook","token_ok":true' "$STATE/telegram.jsonl")" -gt "$n_hook" ] || fail "the server did not set the webhook again with the new token"
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
pass "rotation: a new console code and a re-run of Deploy replaced all 4 keys, registered a workers.dev subdomain (none existed), deployed the watchdog (secrets, webhook) and gave the server its address and the same new heartbeat key; worker reconciled and restarted, owner told; a bundle with an older run number is refused"

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

# Off-server copy: the owner's backup code (shown once, never stored), then a silent Telegram document.
BCODE="$(in_c "zeroed-backup-code" | tee "$LOGS/console/backup-code.txt" | sed -n 's/^  \([a-z -]*\)$/\1/p')"
[ "$(printf '%s' "$BCODE" | wc -w)" = 6 ] || fail "zeroed-backup-code"
CODES+=("$BCODE")
in_c "! grep -rqF '$BCODE' /etc /var/lib/zeroed-host 2>/dev/null" || fail "backup code stored on the server"
sleep 1
# Off by default: nothing goes to Telegram until the owner approves (ops/host-config.json).
in_c "! systemctl is-enabled zeroed-backup-offsite.timer" >/dev/null 2>&1 || fail "off-server timer enabled without approval"
in_c "systemctl start zeroed-backup.service && systemctl start zeroed-backup-offsite.service" || fail "off-server copy (off) errored"
grep -q '"method":"sendDocument"' "$STATE/telegram.jsonl" && fail "a backup was sent before approval"
in_c "zeroed-status" | grep "off-server copy off (waits for the owner's approval)" >/dev/null || fail "status does not show the copy as off"
# Stand-in for the reviewed commit that switches it on after the owner says yes.
in_c "printf '{\"offsite_backup\": true}\n' > /opt/zeroed/current/ops/host-config.json && systemctl start zeroed-backup-offsite.service" || fail "off-server copy failed"
grep -q "\"method\":\"sendDocument\",\"token_ok\":true,\"chat_id\":\"$T_CHAT\"" "$STATE/telegram.jsonl" || fail "backup not sent to the owner chat"
printf '%s' "$BCODE" | node "$ROOT/ops/host/files/usr/local/lib/zeroed/derive-key.mjs" --backup >"$E2E/owner-backup.id"
age -d -i "$E2E/owner-backup.id" "$STATE/received-document" | tar -t | grep -q 'MANIFEST.sha256' || fail "the Telegram copy does not open with the backup code"
docker cp "$STATE/received-document" "$C:/root/received.age" >/dev/null
in_c "age -d -i /etc/zeroed/age/host.key /root/received.age >/dev/null 2>&1" && fail "the Telegram copy opens with the host key"
in_c "rm -f /root/received.age"
rm -f "$E2E/owner-backup.id"
in_c "zeroed-status" | grep 'daily copy to Telegram (zeroed-' >/dev/null || fail "status does not show the off-server copy"
in_c "stat -c %a /var/lib/zeroed-host/owner_backup_recipient" | grep -qx 644 || fail "owner recipient file mode"
pass "off-server backup: off and nothing sent until approved (ops/host-config.json); 6-word backup code shown once (only its public half kept); once on, a silent Telegram document to the owner chat that opens with the words alone and not with the host key"

# ---------- 9b. Watchdog on local wrangler (miniflare, the locked version from ops/watchdog/deploy) with the stub worker's real heartbeats ----------
WD="$E2E/watchdog"
mkdir -p "$WD"
cp -r "$ROOT/packages/ops/src" "$ROOT/packages/ops/wrangler.toml" "$WD/"
{
  printf 'HEARTBEAT_HMAC_KEY=%s\n' "$(cat "$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY")"
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$(cat "$STATE/wrangler-secrets/TELEGRAM_BOT_TOKEN")"
  printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$(cat "$STATE/wrangler-secrets/TELEGRAM_WEBHOOK_SECRET")"
  printf 'TELEGRAM_API=http://127.0.0.1:%s\nCHAIN_RPC_URL=\nHEARTBEAT_MAX_AGE_S=10\n' "$PORT"
} >"$WD/.dev.vars"
curl -s -m 2 -o /dev/null http://127.0.0.1:443/ && fail "port 443 is already in use"
(cd "$ROOT/ops/watchdog/deploy" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || fail "npm ci of the locked watchdog tooling"
(cd "$WD" && exec setsid "$ROOT/ops/watchdog/deploy/node_modules/.bin/wrangler" dev --local --ip 0.0.0.0 --port 443 --test-scheduled) >"$LOGS/wrangler-dev.log" 2>&1 &
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
wait_for 20 "worker applies the resume" "docker exec $C journalctl -u zeroed-worker -o cat --no-pager | grep -q 'Entries allowed again (pause cleared from the host)'"
wait_for 10 "resume notice" "tail -2 '$STATE/telegram.jsonl' | grep -q 'Entries allowed again'"
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -E '"method":"sendMessage"' | grep -v "\"chat_id\":\"$T_CHAT\"" | grep -q . && fail "the watchdog wrote to a chat other than the owner's"
pass "watchdog (locked wrangler dev, miniflare): signed heartbeats from the host teach it the owner chat; quiet while fresh; /pause and /status only from the owner chat and the right webhook secret; worker applied pause and later the resume; /resume refused over Telegram; stale alert once, cleared on return; resume only from the host"

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

# ---------- 10b. Update gate during a qualifying dry run, install.sh --update, worker API ----------
in_c "systemctl stop zeroed-check.timer" # the stages below run the check by hand, one run at a time
chk() { in_c "systemctl start zeroed-check.service"; }
jl() { in_c "journalctl -u $1 -o cat --no-pager"; }
in_c "mkdir -p /var/lib/zeroed-dryrun/evidence/vps-e2e && printf '{\"name\":\"e2e-q\",\"label\":\"vps\",\"commit\":\"$signed\",\"startedAt\":1}' > /var/lib/zeroed-dryrun/evidence/vps-e2e/run.json"
in_c "echo 0000000000000000000000000000000000000000 > /var/lib/zeroed-host/deployed"
upd_run || true
in_c "cat /var/lib/zeroed-host/deployed" | grep -qx 0000000000000000000000000000000000000000 || fail "deployed during an unfinished qualifying run"
jl zeroed-update | grep -q "the qualifying dry run e2e-q is active" || fail "update gate reason (unfinished run) not logged"
in_c "printf '{\"pass\":false}' > /var/lib/zeroed-dryrun/evidence/vps-e2e/report.json"
in_c "systemd-run --quiet --unit=zeroed-dryrun@e2e-unit.service sleep 300"
upd_run || true
in_c "cat /var/lib/zeroed-host/deployed" | grep -qx 0000000000000000000000000000000000000000 || fail "deployed while a zeroed-dryrun@ unit is active"
jl zeroed-update | grep -q "the qualifying dry run e2e-unit is active" || fail "update gate reason (active unit) not logged"
in_c "systemctl stop zeroed-dryrun@e2e-unit.service"
upd_run || fail "update after the dry run ended"
in_c "cat /var/lib/zeroed-host/deployed" | grep -qx "$signed" || fail "no deploy after the dry run ended"
pass "update gate: no deploy while a named dry run has no report (after a reboot drill) or while a zeroed-dryrun@ unit is active; deploys once both end"

# The release carries this branch's installer and RUN-1 units (a GitHub-signed merge of it would); its host
# files did not apply yet, so the next update run applies them.
in_c "rm -rf /opt/zeroed/releases/$signed/packages/runner/systemd && mkdir -p /opt/zeroed/releases/$signed/ops /opt/zeroed/releases/$signed/packages/runner"
docker cp "$ROOT/ops/install.sh" "$C:/opt/zeroed/releases/$signed/ops/install.sh"
docker cp "$ROOT/packages/runner/systemd" "$C:/opt/zeroed/releases/$signed/packages/runner/systemd"
in_c "rm -f /var/lib/zeroed-host/host_applied"
upd_run || { in_c "cat /var/lib/zeroed-host/host_update.log"; fail "host apply"; }
in_c "cat /var/lib/zeroed-host/host_applied" | grep -qx "$signed" || fail "host files not recorded as applied"
jl zeroed-update | grep -q "Host files from ${signed:0:12} applied." || fail "host apply not logged"
for u in $(ls "$ROOT/packages/runner/systemd"); do in_c "cmp -s /etc/systemd/system/$u /opt/zeroed/current/packages/runner/systemd/$u" || fail "RUN-1 unit $u not installed"; done
in_c "systemctl is-enabled zeroed-dryrun-tick.timer && systemctl is-active zeroed-dryrun-tick.timer && systemctl is-enabled zeroed-check.timer" >/dev/null || fail "tick or check timer not enabled"
in_c "! systemctl is-enabled zeroed-dryrun@.service 2>/dev/null | grep -q enabled" || fail "the dry-run template was enabled"
in_c "systemctl cat zeroed-dryrun@x.service" | grep -q -- '--health-addr 127.0.0.1:8788' || fail "runner unit not pointed at the worker API"
in_c "! test -e /etc/zeroed/deploy-code" || fail "--update made a deploy code"
in_c "nft list ruleset" | grep -q 'dport 22' && fail "--update opened SSH"
# SSH as the running firewall has it: kept open when it was open, kept closed when closed.
in_c "sed -i 's/^#SSH_RULE#//' /etc/nftables.conf && nft -f /etc/nftables.conf"
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-ssh-open.txt" 2>&1 || fail "install --update (SSH open)"
in_c "nft list ruleset" | grep -q 'tcp dport 22 .*accept' || fail "--update closed SSH that was open"
in_c "sed -i 's/^\(    tcp dport 22\)/#SSH_RULE#\1/' /etc/nftables.conf && nft -f /etc/nftables.conf"
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-ssh-closed.txt" 2>&1 || fail "install --update (SSH closed)"
in_c "nft list ruleset" | grep -q 'dport 22' && fail "--update opened SSH that was closed"
grep -q 'Deploy code' "$LOGS/console/update-ssh-open.txt" "$LOGS/console/update-ssh-closed.txt" && fail "--update showed a code"
in_c "nft list ruleset" | grep -q 'iifname "tailscale0" tcp dport 443 accept' || fail "tailnet HTTPS rule"
wait_for 30 "worker running after the update" "docker exec $C systemctl is-active zeroed-worker"
in_c "systemctl show -p ExecStart --value zeroed-worker" | grep -q /usr/local/lib/zeroed/worker-start || fail "worker not started by the wrapper"
pid="$(in_c "systemctl show -p MainPID --value zeroed-worker")"
in_c "tr '\0' '\n' < /proc/$pid/environ" >"$LOGS/worker-env.txt"
for want in ZEROED_MODE=paper ZEROED_RECORDER=on ZEROED_SIMULATE=on ZEROED_DRILLS=on ZEROED_HEALTH_ADDR=127.0.0.1:8788; do grep -qx "$want" "$LOGS/worker-env.txt" || fail "worker environment: $want"; done
chk
wait_for 20 "worker API up" "docker exec $C curl -fsS -m 3 http://127.0.0.1:8788/health"
in_c "curl -fsS http://127.0.0.1:8788/health" >"$LOGS/health.json"
jq -e '.mode == "paper" and .signing_key == false and (.evidence | map(.id) | index("vps-e2e") != null) and (.evidence[] | select(.id == "vps-e2e") | .finished == true and .pass == false and .name == "e2e-q")' "$LOGS/health.json" >/dev/null || fail "health API does not list the evidence on the host"
CIP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$C")"
curl -s -m 3 -o /dev/null "http://$CIP:8788/health" && fail "the worker API answered on the public interface"
in_c "zeroed-status" | grep -q 'Evidence:  /var/lib/zeroed-dryrun/evidence (1 runs)' || fail "status does not list the evidence"
pass "install.sh --update through zeroed-update: RUN-1 units from the release installed (tick timer on, template off, runner on 127.0.0.1:8788), SSH kept open or closed as it was, no code shown; worker started by the wrapper in paper with recorder, simulation and drills on; worker API on loopback only lists the evidence kept on the host"

# ---------- 10c. Telegram webhook: change alert, retry with back-off, notice after 5 failed tries ----------
in_c "systemctl stop zeroed-check.timer" # the --update runs above switched it back on
WD_URL="$(in_c "sed -n 's/^WATCHDOG_URL=//p' /etc/zeroed/worker.env")/telegram"
n0="$(wc -l <"$STATE/telegram.jsonl")"
printf '{"url":"https://evil.example/hook"}' >"$STATE/webhook.json"
touch "$STATE/fail-setWebhook"
chk
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"ALERT Zeroed host: the Telegram webhook changed (now: evil.example)" || fail "no alert on a changed webhook"
in_c "cat /var/lib/zeroed-host/webhook_tries" | grep -qx 1 || fail "first retry not counted"
due="$(in_c "echo \$((\$(cat /var/lib/zeroed-host/webhook_next) - \$(date +%s)))")"
[ "$due" -ge 50 ] && [ "$due" -le 60 ] || fail "back-off after the first failure is $due s, not 1 minute"
chk
in_c "cat /var/lib/zeroed-host/webhook_tries" | grep -qx 1 || fail "retried before the back-off ran out"
for i in 2 3 4 5; do
  in_c "echo 0 > /var/lib/zeroed-host/webhook_next"
  chk
  in_c "cat /var/lib/zeroed-host/webhook_tries" | grep -qx "$i" || fail "try $i not counted"
  if [ "$i" -lt 5 ]; then tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -q 'could not set the Telegram webhook' && fail "owner told before 5 failed tries"; fi
done
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: could not set the Telegram webhook after 5 tries")" = 1 ] || fail "no single notice after 5 failed tries"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c '"method":"setWebhook".*"failed":true')" = 5 ] || fail "not 5 failed setWebhook calls"
in_c "zeroed-status" | grep -q 'Webhook:   not set (5 failed tries; retrying)' || fail "status does not show the failing webhook"
rm -f "$STATE/fail-setWebhook"
in_c "echo 0 > /var/lib/zeroed-host/webhook_next"
chk
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not set back to the watchdog"
tail -2 "$STATE/telegram.jsonl" | grep -q 'the Telegram webhook is set again' || fail "no line when the webhook is set again"
chk
tail -1 "$STATE/telegram.jsonl" | grep -q 'CLEARED Zeroed host: the Telegram webhook is back' || fail "changed-webhook alert not cleared"
n1="$(wc -l <"$STATE/telegram.jsonl")"
chk
[ "$(wc -l <"$STATE/telegram.jsonl")" = "$n1" ] || fail "the check spoke while the webhook is right"
pass "webhook: a change by someone else alerts the owner (host only), the server sets its own back; failed sets retry after 1 min, then 2, 4, 8 (not sooner); one notice after 5 failed tries; set again and cleared once Telegram works"

# ---------- 10d. Stored-key check ----------
T_OTHER="TESTOTHER$(rnd 10)"
in_c "cp -p /etc/credstore.encrypted/jupiter_api_key /root/jup.bak"
n0="$(wc -l <"$STATE/telegram.jsonl")"
chk
[ "$(wc -l <"$STATE/telegram.jsonl")" = "$n0" ] || fail "key check alerted on good keys"
printf '%s' "$T_OTHER" | docker exec -i "$C" systemd-creds encrypt --with-key=host --name=jupiter_api_key - /etc/credstore.encrypted/jupiter_api_key
chk
tail -1 "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"ALERT Zeroed host: stored key check failed: jupiter_api_key (changed outside a key handoff)" || fail "no alert for a replaced key"
chk
[ "$(grep -c 'stored key check failed' "$STATE/telegram.jsonl")" = 1 ] || fail "key alert repeated"
in_c "zeroed-status" | grep -q 'Key check: FAILED: jupiter_api_key' || fail "status does not show the failed key"
in_c "cp -p /root/jup.bak /etc/credstore.encrypted/jupiter_api_key"
chk
tail -1 "$STATE/telegram.jsonl" | grep -q 'CLEARED Zeroed host: every stored key passes its check again' || fail "key alert not cleared"
in_c "printf 'x' | dd of=/etc/credstore.encrypted/jupiter_api_key bs=1 seek=100 conv=notrunc 2>/dev/null"
chk
tail -1 "$STATE/telegram.jsonl" | grep -q 'stored key check failed: jupiter_api_key (does not open)' || fail "no alert for a key that does not open"
in_c "mv /root/jup.bak /etc/credstore.encrypted/jupiter_api_key"
chk
tail -1 "$STATE/telegram.jsonl" | grep -q 'CLEARED Zeroed host: every stored key' || fail "key alert not cleared after restore"
pass "key check: quiet on good keys; a key re-encrypted outside the handoff and a key that does not open each alert once (names only), shown in zeroed-status, cleared once restored"

# ---------- 10e. Re-pairing a paired server ----------
T_CHAT2="5151$(rnd 2 | tr -dc 0-9)51"
chat_is() { [ "$(in_c "systemd-creds decrypt --name=telegram_chat_id /etc/credstore.encrypted/telegram_chat_id - | sha256sum | cut -c1-64")" = "$(printf '%s' "$1" | sha256sum | cut -c1-64)" ]; }
repair_code() { in_c "echo yes | zeroed-pair-code" | tee -a "$LOGS/console/repair.txt" | sed -n 's/.*\/pair \([0-9]\{6\}\)$/\1/p'; }
in_c "echo no | zeroed-pair-code" >"$LOGS/console/repair-no.txt" 2>&1 && fail "re-pair went ahead without yes"
grep -q 'Cancelled. Nothing changed.' "$LOGS/console/repair-no.txt" && in_c "! test -e /etc/zeroed/pair-code" || fail "a refused re-pair changed something"
# A wrong code: the re-pair is cancelled, the old chat stays and gets its webhook back.
RP="$(repair_code)"
[[ "$RP" =~ ^[0-9]{6}$ ]] || fail "no re-pair code"
tail -1 "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: a new Telegram pairing was started" || fail "current chat not told about the re-pair"
in_c "zeroed-status" | grep -q "new pairing pending: /pair $RP within 30 minutes" || fail "status does not show the pending re-pair"
send_tg "$T_CHAT2" "/pair 000000"
grep -q '"method":"deleteWebhook"' "$STATE/telegram.jsonl" || fail "webhook not turned off to read /pair"
chat_is "$T_CHAT" || fail "a wrong re-pair code moved the chat"
grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: a wrong pairing code was sent" "$STATE/telegram.jsonl" || fail "old chat not told about the wrong code"
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not back after a wrong re-pair code"
# Expiry after 30 minutes.
RP="$(repair_code)"
in_c "touch -d '31 minutes ago' /etc/zeroed/pair-code && systemctl start zeroed-pair.service"
in_c "! test -e /etc/zeroed/pair-code" || fail "an expired code was kept"
chat_is "$T_CHAT" || fail "expiry moved the chat"
tail -3 "$STATE/telegram.jsonl" | grep -q 'the new pairing code expired. This chat stays paired.' || fail "expiry not told"
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not back after expiry"
# Success while a dry run is active: the chat moves at once, the worker restart waits for the run.
in_c "rm -f /var/lib/zeroed-dryrun/evidence/vps-e2e/report.json"
RP="$(repair_code)"
w0="$(jl zeroed-worker | grep -c 'Stub worker up')"
send_tg "$T_CHAT2" "/pair $RP"
chat_is "$T_CHAT2" || fail "re-pair with the right code did not move the chat"
grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: a new chat was paired at the console" "$STATE/telegram.jsonl" || fail "old chat not told it was replaced"
grep -q "\"chat_id\":\"$T_CHAT2\",\"text\":\"Paired." "$STATE/telegram.jsonl" || fail "new chat not told Paired"
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not set after re-pair"
in_c "test -e /var/lib/zeroed-host/worker_restart_pending" || fail "worker restart did not wait for the dry run"
[ "$(jl zeroed-worker | grep -c 'Stub worker up')" = "$w0" ] || fail "worker restarted during the dry run"
in_c "printf '{\"pass\":false}' > /var/lib/zeroed-dryrun/evidence/vps-e2e/report.json"
n0="$(wc -l <"$STATE/telegram.jsonl")"
chk
wait_for 30 "worker restarted for the new chat" "[ \$(docker exec $C journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Stub worker up') -gt $w0 ]"
in_c "! test -e /var/lib/zeroed-host/worker_restart_pending" || fail "restart still pending"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c ALERT)" = 0 ] || fail "re-pairing raised an alert"
pass "re-pair: asks first (no = nothing changes); the current chat is told and stays paired through a wrong code and an expired code (webhook back each time); the right code moves alerts to the new chat, tells both, sets the webhook; the worker restart for the new chat waits for the dry run; no false webhook or key alert"

# ---------- 10f. Live view (Tailscale stand-in: no network in the test) ----------
docker cp "$STUBS/tailscale" "$C:/usr/local/bin/tailscale"
in_c "printf '[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/tailscaled.service && systemctl daemon-reload"
in_c "zeroed-status" | grep -q 'Live view: off' || fail "status before the live view"
in_c "zeroed-tailscale" >"$LOGS/console/tailscale.txt" 2>&1 &
TS_PID=$!
wait_for 30 "login link shown" "grep -q 'https://login.tailscale.com/a/e2e0a1b2c3d4' '$LOGS/console/tailscale.txt'"
grep -q "\"chat_id\":\"$T_CHAT2\",\"text\":\"Zeroed host: open this link and log in to Tailscale" "$STATE/telegram.jsonl" || fail "login link not sent to the paired chat"
in_c "touch /var/lib/tailscale-stub/approve"
wait "$TS_PID" || { cat "$LOGS/console/tailscale.txt"; fail "zeroed-tailscale"; }
grep -q 'Live view: https://zeroed.tail-e2e.ts.net (your tailnet only, HTTPS, Funnel off).' "$LOGS/console/tailscale.txt" || fail "live view address"
in_c "cat /var/lib/tailscale-stub/calls" >"$LOGS/tailscale-calls.txt"
grep -qx 'up --hostname=zeroed --ssh=false --accept-routes=false --accept-dns=false --timeout=15m' "$LOGS/tailscale-calls.txt" && grep -qx 'funnel --https=443 off' "$LOGS/tailscale-calls.txt" && grep -qx 'serve --bg --https=443 http://127.0.0.1:8788' "$LOGS/tailscale-calls.txt" || fail "tailscale calls"
in_c "zeroed-status" | grep -q 'Live view: https://zeroed.tail-e2e.ts.net' || fail "status after the live view"
in_c "zeroed-tailscale" | grep -q 'Live view: https://zeroed' || fail "zeroed-tailscale is not safe to repeat"
# Funnel switched on by someone: alert, turned off, then cleared; installs run the same check.
in_c "jq '.AllowFunnel = {\"zeroed.tail-e2e.ts.net:443\": true}' /var/lib/tailscale-stub/serve.json > /tmp/s && mv /tmp/s /var/lib/tailscale-stub/serve.json"
chk
tail -1 "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$T_CHAT2\",\"text\":\"ALERT Zeroed host: Tailscale Funnel was on (zeroed.tail-e2e.ts.net:443 )" || fail "no alert for Funnel on"
in_c "jq -e '(.AllowFunnel // {}) | length == 0' /var/lib/tailscale-stub/serve.json" >/dev/null || fail "Funnel not turned off"
chk
tail -1 "$STATE/telegram.jsonl" | grep -q 'CLEARED Zeroed host: Tailscale Funnel is off.' || fail "Funnel alert not cleared"
in_c "jq '.AllowFunnel = {\"zeroed.tail-e2e.ts.net:443\": true}' /var/lib/tailscale-stub/serve.json > /tmp/s && mv /tmp/s /var/lib/tailscale-stub/serve.json"
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-funnel.txt" 2>&1 || fail "install --update (Funnel on)"
in_c "jq -e '(.AllowFunnel // {}) | length == 0' /var/lib/tailscale-stub/serve.json" >/dev/null || fail "the installer's check left Funnel on"
grep -q 'ALERT Zeroed host: Tailscale Funnel was on' <(tail -3 "$STATE/telegram.jsonl") || fail "the installer's check raised no Funnel alert"
in_c "systemctl stop zeroed-check.timer"
chk
in_c "zeroed-tailscale --off" | grep -q 'Live view off' && grep -qx 'serve reset' <(in_c "cat /var/lib/tailscale-stub/calls") || fail "zeroed-tailscale --off"
pass "live view: opt-in zeroed-tailscale shows the login link on the console and sends it to the paired chat, joins as zeroed (no Tailscale SSH), Funnel off, serves HTTPS 443 to 127.0.0.1:8788 only, safe to repeat, --off stops it; Funnel switched on is alerted and turned off by the minute check and by an install; the firewall admits only tailnet HTTPS"

# ---------- 11. Secret scan ----------
in_c "journalctl --no-pager -o cat" >"$LOGS/container-journal.txt"
in_c "journalctl --no-pager -o json" >"$LOGS/container-journal.json"
docker logs "$C" >"$LOGS/container-console.txt" 2>&1
in_c "tar -c --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run/credentials --exclude=/opt/node-v22.23.3 --exclude=/usr --exclude=/opt/zeroed/repo --exclude=/opt/zeroed/releases / 2>/dev/null" >"$E2E/container-fs.tar" || true
mkdir -p "$E2E/fs" && tar -xf "$E2E/container-fs.tar" -C "$E2E/fs" 2>/dev/null || true
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) console.log(JSON.parse(l).text)' "$STATE/telegram.jsonl" >"$LOGS/telegram-texts.txt"
KEYS=("${VALUES_A[@]}" "$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM" "$T_CHAT" "$T_CHAT2" "$T_OTHER" "$T_CF" "$(cat "$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY")" "$(cat "$STATE/wrangler-secrets/TELEGRAM_WEBHOOK_SECRET")")
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
pass "secret scan: none of ${#KEYS[@]} test values (4 pairing, 4 rotation, both chat ids, the replaced key, Cloudflare token, heartbeat and webhook keys) in any log, console output, Telegram text, journal, container disk or the repo; none of ${#CODES[@]} deploy and backup codes outside the console"

echo
echo "All checks passed. Logs: $LOGS"
