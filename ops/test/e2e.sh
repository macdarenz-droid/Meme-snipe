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
# A Telegram chat id: 15 digits, the most Telegram's ids allow (they stay below 2^53), so about 46 random
# bits. A chance match in the scanned files (about 10^8 positions) is about 1 in a million.
chat_id() { printf '%s%014d' "$1" "$(($(od -An -N6 -tu8 /dev/urandom | tr -d ' ') % 100000000000000))"; }
wait_for() { # seconds description command
  local end=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$end" ]; do
    if bash -c "$3" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "$2 (timed out after $1 s)"
}

cleanup() {
  local rc=$?
  # On a failure, what the worker was doing: its last invocation's journal, restarts and state (TEST values only).
  if [ "$rc" != 0 ] && [ -n "${LOGS:-}" ] && docker inspect "$C" >/dev/null 2>&1; then
    { docker exec "$C" systemctl show -p ActiveState -p SubState -p NRestarts -p InvocationID -p MainPID -p ExecMainStatus zeroed-worker
      docker exec "$C" bash -c 'journalctl -o short-iso-precise --no-pager _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value zeroed-worker) | tail -n 200'
      echo '--- all invocations, last 100 lines'
      docker exec "$C" journalctl -u zeroed-worker -o short-iso-precise --no-pager | tail -n 100
    } >"$LOGS/failure-worker.txt" 2>&1 || true
  fi
  [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null || true
  [ -n "${WD_PID:-}" ] && kill -- "-$WD_PID" 2>/dev/null || true # wrangler, its node and workerd children
  [ "$KEEP" = --keep ] && { echo "Kept container $C and $E2E"; return; }
  docker rm -f "$C" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Test values: random each run, clearly marked TEST, never real.
set_values() { # suffix
  # Every test secret carries 128 random bits (32 hex), so it can never occur by chance in a scanned file.
  T_HELIUS="TESTHELIUS$1$(rnd 16)"
  T_ALCHEMY="TESTALCHEMY$1$(rnd 16)"
  T_JUPITER="TESTJUPITER$1$(rnd 16)"
  T_TELEGRAM="99$(rnd 3 | tr -dc 0-9 | head -c 6)0:TESTtelegram$1$(rnd 16)"
}
set_values A
VALUES_A=("$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM")
T_CHAT="$(chat_id 4)" # was 4242<0-4 digits>42: as short as 424242, which occurs in miniflare's minified assets
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
signed2="" # an older GitHub-signed merge: SWITCH-1's broken-release update case deploys "it"
unsigned=""
# The whole first-parent history, newest first, until all three are found: every merge since 5 Oct is
# GitHub-signed, so the newest unsigned commit lies further back than any fixed window (it was 54 back on 8 Oct).
for c in $(git -C "$BARE" rev-list --first-parent "$BRANCH"); do
  if git -C "$BARE" verify-commit --raw "$c" 2>&1 | grep -q 'VALIDSIG .* 968479A1AFF927E37D1A566BB5690EEEBB952194$'; then
    if [ -z "$signed" ]; then signed="$c"; elif [ -z "$signed2" ]; then signed2="$c"; fi
  else
    [ -n "$unsigned" ] || unsigned="$c"
  fi
  [ -n "$signed" ] && [ -n "$signed2" ] && [ -n "$unsigned" ] && break
done
[ -n "$signed" ] && [ -n "$signed2" ] && [ -n "$unsigned" ] || fail "test repo needs two GitHub-signed and an unsigned commit on $BRANCH"
git -C "$BARE" tag -f deploy "$signed" >/dev/null
mkdir -p "$STATE/checks"
# The server also needs a green e2e on the newest commit at or before the deployed one that touched the
# ops end-to-end paths (logic.sh e2e_commit, OPS-GATE): mark those green.
e2e_of() { (. "$ROOT/ops/host/files/usr/local/lib/zeroed/logic.sh" && e2e_commit "$BARE" "$1"); }
# A test commit that is its own e2e commit gets its checks file in its own case below: written here, the
# update timer would deploy it before the gate cases run.
for c in "$signed" "$signed2" "$unsigned"; do
  e="$(e2e_of "$c")"
  [ -n "$e" ] || fail "no commit at or before ${c:0:12} touched the ops end-to-end paths"
  case "$e" in "$signed" | "$signed2" | "$unsigned") ;; *) echo success >"$STATE/checks/$e" ;; esac
done
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
git -C "$ROOT" merge-base --is-ancestor "$pin" HEAD || fail "pin is not in this branch's history"
docker cp "$ROOT/ops/install.sh" "$C:/root/i"
in_c "cd /root && echo '$hash  i' | sha256sum -c" >"$LOGS/console/hash-check.txt" 2>&1 || fail "hash check in the container"
pass "README line: ${#line} ASCII characters, pinned to ${pin:0:12} which holds install.sh with the same SHA-256; checked in the container"
# D07 preflight (Z00), through the same file: a full install on a host below 1.5 GiB of RAM or
# with a /var/lib filesystem under 40 GB stops before it changes anything. This container has the runner's RAM and disk,
# so the small host is staged with mounts inside it (a 1 GB server's /proc/meminfo, a 25.6 GB tmpfs on /var/lib),
# never with an option or variable of the installer: it has none.
in_c "awk '\$1 == \"MemTotal:\" { \$2 = 1004316 } { print }' /proc/meminfo > /root/meminfo-1gb"
in_c "mount --bind /root/meminfo-1gb /proc/meminfo"
rc=0; in_c "ZEROED_NO_WAIT=1 bash /root/i" >"$LOGS/console/install-d07-ram.txt" 2>&1 || rc=$?
in_c "umount /proc/meminfo"
[ "$rc" = 1 ] && grep -qF "Install stopped: this server is below the bot's host minimum (docs/blueprint/ARCH.md D07): it has 0.96 GiB of RAM; the bot needs a 2 GB server (at least 1.5 GiB reported). Use the 2 GB Vultr server" "$LOGS/console/install-d07-ram.txt" || { cat "$LOGS/console/install-d07-ram.txt"; fail "D07: a 1 GB server was not refused (exit $rc)"; }
in_c "mount -t tmpfs -o size=25000000k zeroed-e2e-small /var/lib"
rc=0; in_c "ZEROED_NO_WAIT=1 bash /root/i" >"$LOGS/console/install-d07-disk.txt" 2>&1 || rc=$?
in_c "umount /var/lib"
[ "$rc" = 1 ] && grep -qF "Install stopped: this server is below the bot's host minimum (docs/blueprint/ARCH.md D07): the disk that holds /var/lib is 25.6 GB; the bot needs at least 40 GB." "$LOGS/console/install-d07-disk.txt" || { cat "$LOGS/console/install-d07-disk.txt"; fail "D07: a 25 GB disk was not refused (exit $rc)"; }
grep -q '^==>' "$LOGS/console/install-d07-ram.txt" "$LOGS/console/install-d07-disk.txt" && fail "D07: a refused install started a step"
in_c "! test -e /etc/zeroed && ! test -e /var/lib/zeroed-host && ! test -e /usr/local/bin/node && ! getent passwd zeroed-worker >/dev/null && ! grep -q 'MemTotal: *1004316 ' /proc/meminfo && test -d /var/lib/dpkg" || fail "D07: a refused install changed the server, or the staged mounts stayed"
pass "D07 preflight: a 1 GB server and a 25.6 GB disk are refused with the reason, before any change"
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
# PATHS-FIX: the engine's folders outside its state, the pull account and its chroot, and the systemd it runs under.
in_c "systemctl --version | head -1" >"$LOGS/systemd-version.txt"
[ "$(in_c "stat -c '%a %U %G %n' /var/lib/zeroed-md /var/lib/zeroed-md/receipts /var/lib/zeroed-spool /var/lib/zeroed-usage /srv/zeroed_pull")" = "$(printf '%s\n' \
  '2750 zeroed-worker zeroed-pull /var/lib/zeroed-md' '2770 zeroed-worker zeroed-pull /var/lib/zeroed-md/receipts' \
  '2730 zeroed-worker zeroed-spool /var/lib/zeroed-spool' '2770 zeroed-worker zeroed-sentinel /var/lib/zeroed-usage' '755 root root /srv/zeroed_pull')" ] || fail "PATHS-FIX: folder owner, group or mode"
in_c "id -nG zeroed-worker | tr ' ' '\n' | grep -qx zeroed-pull && id -nG zeroed-worker | tr ' ' '\n' | grep -qx zeroed-spool && ! id -nG zeroed-worker | tr ' ' '\n' | grep -qx botops" || fail "PATHS-FIX: worker groups"
[ "$(in_c "getent passwd zeroed-pull | cut -d: -f7")" = /usr/sbin/nologin ] || fail "PATHS-FIX: the pull account has a shell"
in_c "systemctl is-active srv-zeroed_pull-md.mount srv-zeroed_pull-md-receipts.mount" >/dev/null || fail "PATHS-FIX: chroot binds not mounted"
# Ruling 20: receipts/ is its own 64 MiB ext4 with 32,768 inodes, root-only image outside every bot path.
in_c "systemctl is-active zeroed-receipts-fs.service" >/dev/null || fail "PATHS-FIX: receipts filesystem not started"
[ "$(in_c "findmnt -no FSTYPE /var/lib/zeroed-md/receipts")" = ext4 ] || fail "PATHS-FIX: receipts/ is not its own filesystem"
[ "$(in_c "df --output=itotal /var/lib/zeroed-md/receipts | tail -1 | tr -d ' '")" = 32768 ] || fail "PATHS-FIX: receipts inode count"
[ "$(in_c "stat -c '%a %U %s' /var/lib/zeroed-receipts/receipts.img")" = "600 root 67108864" ] || fail "PATHS-FIX: receipts image owner, mode or size"
in_c "! touch /srv/zeroed_pull/md/x 2>/dev/null && touch /srv/zeroed_pull/md/receipts/x && test -e /var/lib/zeroed-md/receipts/x && rm /var/lib/zeroed-md/receipts/x" || fail "PATHS-FIX: md must be read-only and receipts writable through the chroot"
in_c "sshd -t && sshd -T -C user=zeroed-pull,host=h,addr=127.0.0.1" >"$LOGS/sshd-pull.txt" || fail "PATHS-FIX: sshd refuses its settings"
for l in 'chrootdirectory /srv/zeroed_pull' 'forcecommand internal-sftp -u 0027' 'authorizedkeysfile /etc/zeroed/pull-keys/%u' 'allowtcpforwarding no' 'permittty no' 'passwordauthentication no'; do
  grep -qx "$l" "$LOGS/sshd-pull.txt" || fail "PATHS-FIX: pull account sshd setting missing: $l"
done
in_c "sshd -T -C user=root,host=h,addr=127.0.0.1" | grep -qx 'chrootdirectory none' || fail "PATHS-FIX: the pull account's Match block reaches other users"
in_c "! systemctl is-active ssh.service ssh.socket" >/dev/null || fail "PATHS-FIX: SSH must stay off on a default install"
pass "PATHS-FIX: md 2750 and receipts 2770 (group zeroed-pull; receipts its own 64 MiB ext4 with 32,768 inodes), spool 2730 (group zeroed-spool), worker in both and not botops; pull account sftp-only and chrooted with md read-only and receipts writable; SSH still off; $(cat "$LOGS/systemd-version.txt")"

# ---------- 3. Deploy with a wrong code fails cleanly ----------
publish() { # issued log code [extra env...]
  local issued="$1" log="$2" code="$3"
  shift 3
  env -i PATH="$STUBS:$PATH" HOME="$E2E" STATE="$STATE" GH_REPO="$REPO" GITHUB_SHA="$signed" ISSUED="$issued" DEPLOY_CODE="$code" \
    HELIUS_API_KEY="$T_HELIUS" ALCHEMY_API_KEY="$T_ALCHEMY" JUPITER_API_KEY="$T_JUPITER" TELEGRAM_BOT_TOKEN="$T_TELEGRAM" \
    PICKUP_TIMEOUT_S=240 PICKUP_POLL_S=2 PICKUP_GRACE_S=2 "$@" \
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
T_CF="TESTcloudflare$(rnd 16)"
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
  in_c "systemctl reset-failed zeroed-pair.service 2>/dev/null; systemctl start zeroed-pair.service"
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
# HEAP-GUARD: the running worker has its explicit heap limit and fatal-error report flags, and worker-start made the
# report directory inside the unit's sandbox (ProtectSystem=strict, PrivateTmp): it exists and the worker owns it.
in_c "tr '\\0' ' ' < /proc/\$(systemctl show -p MainPID --value zeroed-worker)/cmdline" | grep -q -- '--max-old-space-size=560 --report-on-fatalerror --report-compact --report-directory=/var/lib/zeroed/reports' || fail "worker runs without its heap limit and report flags"
in_c "stat -c %U /var/lib/zeroed/reports" | grep -qx zeroed-worker || fail "worker's report directory missing or not the worker's"
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
# Deploy returns once the server has downloaded the bundle; the server then stores the keys, restarts the worker
# (reconcile first), tells the owner and sets the webhook. Wait for those ends, not for Deploy's return.
wait_for 120 "the server finished the rotation" "grep -q 'keys replaced (issue 1002)' '$STATE/telegram.jsonl' && [ \$(grep -c '\"method\":\"setWebhook\",\"token_ok\":true' '$STATE/telegram.jsonl') -gt $n_hook ] && [ \$(docker exec $C journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents, 5 of 5') -gt $r0 ]"
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
upd_run() { in_c "systemctl reset-failed zeroed-update.service 2>/dev/null; systemctl start zeroed-update.service" 2>/dev/null; }
current() { in_c "readlink /opt/zeroed/current 2>/dev/null || true"; }
echo failure >"$STATE/checks/$signed"
upd_run || true
[ -z "$(current)" ] || fail "deployed with a failed check"
echo pending >"$STATE/checks/$signed"
upd_run || true
[ -z "$(current)" ] || fail "deployed with a pending check"
echo success >"$STATE/checks/$signed"
e2e_signed="$(e2e_of "$signed")"
if [ "$e2e_signed" != "$signed" ]; then
  # A green merge that left ops alone still waits on the red end-to-end of the ops change before it.
  echo failure >"$STATE/checks/$e2e_signed"
  upd_run || true
  [ -z "$(current)" ] || fail "deployed with the ops end-to-end of ${e2e_signed:0:12} red"
  echo success >"$STATE/checks/$e2e_signed"
fi
in_c "echo 2 > /var/lib/zeroed/open_intents"
upd_run || true
[ -z "$(current)" ] || fail "deployed with open intents"
in_c "echo 0 > /var/lib/zeroed/open_intents"
upd_run || fail "update failed on a green, GitHub-signed commit"
[ "$(current)" = "/opt/zeroed/releases/$signed" ] || fail "current release not switched"
in_c "journalctl -u zeroed-update -o cat --no-pager" >"$LOGS/update-journal.txt"
grep -q 'its checks are red' "$LOGS/update-journal.txt" && grep -q 'its checks are pending' "$LOGS/update-journal.txt" && grep -q 'open intents (2)' "$LOGS/update-journal.txt" || fail "update reasons not logged"
[ "$e2e_signed" = "$signed" ] || grep -q "its checks are red: the ops end-to-end of ${e2e_signed:0:12}" "$LOGS/update-journal.txt" || fail "the red ops end-to-end was not logged"
git -C "$BARE" tag -f deploy "$unsigned" >/dev/null && git -C "$BARE" update-server-info
echo success >"$STATE/checks/$unsigned"
upd_run && fail "an unsigned commit was deployed"
[ "$(current)" = "/opt/zeroed/releases/$signed" ] || fail "current moved to an unsigned commit"
in_c "journalctl -u zeroed-update -o cat --no-pager" >"$LOGS/update-journal.txt"
grep -qF "Refused deploy tag ${unsigned:0:12}: not signed by GitHub's merge key." "$LOGS/update-journal.txt" || fail "the unsigned commit was not refused for its signature"
git -C "$BARE" tag -f deploy "$signed" >/dev/null && git -C "$BARE" update-server-info
pass "update: waits on failed and pending checks, on a red ops end-to-end at ${e2e_signed:0:12} and on open intents; deploys the green GitHub-signed merge ${signed:0:12} with reconcile first; refuses unsigned ${unsigned:0:12}"

# ---------- 9. Backup and restore drill ----------
# PATHS-FIX ruling 24: the provider usage ledger (its own shared folder) is in every backup and the drill checks it.
in_c "sqlite3 /var/lib/zeroed-usage/rpc-usage.db 'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(x); INSERT INTO reservations VALUES (1);' >/dev/null" || fail "PATHS-FIX: test usage ledger"
in_c "systemctl start zeroed-backup.service" || fail "backup failed"
bk="$(in_c "ls -1 /var/backups/zeroed/ | tail -1")"
[[ "$bk" =~ ^zeroed-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]] || fail "no backup file"
in_c "zeroed-restore-drill /etc/zeroed/age/host.key" >"$LOGS/drill-host.txt" 2>&1 || { cat "$LOGS/drill-host.txt"; fail "drill"; }
in_c "cp /var/backups/zeroed/$bk /root/tampered.age && printf 'x' | dd of=/root/tampered.age bs=1 seek=200 conv=notrunc 2>/dev/null"
in_c "zeroed-restore-drill /etc/zeroed/age/host.key /root/tampered.age" >"$LOGS/drill-tampered.txt" 2>&1 && fail "tampered backup passed"
in_c "rm -f /root/tampered.age"
grep -q '^PASS' "$LOGS/drill-host.txt" && grep -q 'host_events' "$LOGS/drill-host.txt" && grep -q '^FAIL' "$LOGS/drill-tampered.txt" || fail "drill output"
grep -q 'zeroed-usage/rpc-usage.db reservations: ' "$LOGS/drill-host.txt" || fail "PATHS-FIX: the usage ledger is not in the backup"
in_c "rm -f /var/lib/zeroed-usage/rpc-usage.db*"
in_c "systemctl is-enabled zeroed-backup.timer && systemctl show -p TimersCalendar --value zeroed-backup.timer" | grep -q 'OnCalendar=\*-\*-\* \*:00:00' || fail "backup timer is not hourly"
pass "backup: hourly timer, $bk encrypted (with the usage ledger); restore drill PASS into a scratch directory, FAIL on a tampered file"

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
  # RECORD-UPLOAD (9c): the private data repository and GitHub's API and upload hosts, all the fake's.
  printf 'DATA_REPO=e2e-owner/zeroed-data\nREPORTS_TOKEN=github_pat_TEST%s\nGITHUB_API=http://127.0.0.1:%s\nGITHUB_UPLOADS=http://127.0.0.1:%s\n' "$(rnd 16)" "$PORT" "$PORT"
} >"$WD/.dev.vars"
curl -s -m 2 -o /dev/null http://127.0.0.1:443/ && fail "port 443 is already in use"
(cd "$ROOT/ops/watchdog/deploy" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || fail "npm ci of the locked watchdog tooling"
(cd "$WD" && exec setsid "$ROOT/ops/watchdog/deploy/node_modules/.bin/wrangler" dev --local --ip 0.0.0.0 --port 443 --test-scheduled) >"$LOGS/wrangler-dev.log" 2>&1 &
WD_PID=$!
wait_for 120 "wrangler dev up" "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:443/heartbeat | grep -q 401"
# The local watchdog speaks plain http, which only the host's stand-in accepts (the release's worker requires an https
# WATCHDOG_URL): the host sections run the stand-in, whatever the test release's host-config says. Section 10b2 runs
# the release's own worker (SWITCH-1).
in_c "jq '.worker = \"stub\"' /opt/zeroed/current/ops/host-config.json > /tmp/hc && cat /tmp/hc > /opt/zeroed/current/ops/host-config.json"
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

# ---------- 9c. Recording upload (RECORD-UPLOAD) through the real watchdog to the fake private data repository ----------
# Two boots as the recorder leaves them, their files a day old: the older one ended (uploaded, then its frames and releases
# deleted); the other is the newest folder while the worker runs (its id is the newest; uploaded, nothing deleted), and
# one of its files holds a credential-shaped value (kept on the server, alerted, cleared once it is gone). Earlier
# sections' real worker boots stay as they are (changed minutes ago, so not touched); every check names these two.
DATA="$STATE/data-repo"
# Section 8 applied the deployed release's host files (right for a release); put this branch's back, as 10b does.
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-branch-files-9c.txt" 2>&1 || { cat "$LOGS/console/update-branch-files-9c.txt"; fail "install --update (this branch's host files, 9c)"; }
for f in usr/local/sbin/zeroed-check usr/local/lib/zeroed/logic.sh usr/local/lib/zeroed/record-upload.mjs usr/local/sbin/zeroed-record-upload etc/systemd/system/zeroed-record-upload@.service; do
  docker exec -i "$C" cmp -s "/$f" - <"$ROOT/ops/host/files/$f" || fail "test setup: this branch's /$f not in place"
done
in_c "jq '.record_upload = true | .record_upload_delete_local = true' /opt/zeroed/current/ops/host-config.json > /tmp/hc && cat /tmp/hc > /opt/zeroed/current/ops/host-config.json"
in_c "install -d -o zeroed-worker -g zeroed-worker -m 0700 /var/lib/zeroed/recorder"
fixture="$(docker exec -i "$C" runuser -u zeroed-worker -- /usr/local/bin/node --input-type=module - <<'NODE'
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
const root = '/var/lib/zeroed/recorder';
const now = Date.now();
const day = new Date(now - 86_400_000).toISOString().slice(0, 10);
const out = { day, boots: {} };
for (const [h, pid, plant] of [[30, 4101, false], [-1, 4102, true]]) {
  const boot = `${(now - h * 3_600_000).toString(36)}-${pid}`;
  const dir = join(root, boot);
  mkdirSync(join(dir, 'days', day), { recursive: true });
  const files = ['delays-000', 'frames-000', 'raw-000', 'releases-000'].map((t) => {
    const text = plant && t === 'releases-000' ? '{"u":"https://rpc.e2e.test/?api-key=E2EPLANTED"}\n' : `{"boot":"${boot}","t":"${t}"}\n`.repeat(2000);
    const b = zstdCompressSync(Buffer.from(text));
    const path = `days/${day}/${t}.jsonl.zst`;
    writeFileSync(join(dir, path), b);
    return { path, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ schema: 2, source: 'live-recorder', boot, window: { from: day }, attachments: [], days: [{ day, files }] })}\n`);
  out.boots[boot] = files;
}
const t = (now - 3_600_000) / 1000;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    utimesSync(join(d, e.name), t, t);
  }
  utimesSync(d, t, t);
};
for (const boot of Object.keys(out.boots)) walk(join(root, boot));
console.log(JSON.stringify(out));
NODE
)" || fail "recording fixture"
RDAY="$(printf '%s' "$fixture" | jq -r .day)"
OLD="$(printf '%s' "$fixture" | jq -r '.boots | keys[] | select(endswith("-4101"))')"
NEW="$(printf '%s' "$fixture" | jq -r '.boots | keys[] | select(endswith("-4102"))')"
sha_of() { printf '%s' "$fixture" | jq -r --arg b "$1" --arg p "days/$RDAY/$2.jsonl.zst" '.boots[$b][] | select(.path == $p) | .sha256'; }
in_c "systemctl is-active zeroed-worker" >/dev/null || fail "the worker must run for the newest-boot case"
# Telegram lines from here on (zeroed-check's timer may raise the alert before the explicit runs below do).
n0="$(wc -l <"$STATE/telegram.jsonl")"
in_c "systemctl start zeroed-record-upload@all.service" || { in_c "journalctl -u zeroed-record-upload@all -o cat --no-pager | tail -30"; fail "recording upload run"; }
in_c "journalctl -u zeroed-record-upload@all -o cat --no-pager" >"$LOGS/record-upload-1.txt"
grep -q "Recording upload: .* kept, 0 failed\.$" "$LOGS/record-upload-1.txt" || { cat "$LOGS/record-upload-1.txt"; fail "recording upload summary"; }
# What the day's release holds: the ended boot's frames, releases and manifest, the newest boot's clean files, the day's
# index; never raw or delays, never the planted file. Every asset's bytes are the local file's (sha256).
# (A run near UTC midnight may also send that day's journal: left out here.)
names="$(jq -r --arg t "rec-$RDAY" '.assets[] | select(.tag == $t) | .name | select(startswith("journal-") | not)' "$DATA/state.json" | sort | tr '\n' ' ')"
want="$(printf '%s\n' index-1.json "$NEW.frames-000.jsonl.zst" "$OLD.frames-000.jsonl.zst" "$OLD.manifest.json" "$OLD.releases-000.jsonl.zst" | sort | tr '\n' ' ')"
[ "$names" = "$want" ] || fail "data repository assets: $names (want $want)"
for b in "$OLD" "$NEW"; do for t in frames-000 releases-000; do
  want="$(sha_of "$b" "$t")"
  got="$(jq -r --arg n "$b.$t.jsonl.zst" '.assets[] | select(.name == $n) | .sha256' "$DATA/state.json")"
  [ "$b/$t" = "$NEW/releases-000" ] && { [ -z "$got" ] || fail "the planted file was uploaded"; continue; }
  [ -n "$want" ] && [ "$got" = "$want" ] || fail "$b.$t: uploaded bytes differ from the recording"
done; done
jq -e --arg t "rec-$RDAY" 'select(.call == "create-release") | select(.tag_name == $t and .prerelease == true and .make_latest == "false")' "$DATA/calls.jsonl" >/dev/null || fail "release rec-$RDAY not a prerelease kept from latest"
# FixedLengthStream in the real Worker runtime: every upload carried its exact Content-Length, none was chunked.
jq -s -e 'map(select(.call == "upload")) | length > 0 and all(.chunked == false and .length != null and (.length | tonumber) == .bytes)' "$DATA/calls.jsonl" >/dev/null || fail "an upload was chunked or had no Content-Length"
idx="$(jq -r --arg t "rec-$RDAY" '.assets[] | select(.tag == $t and .name == "index-1.json") | .id' "$DATA/state.json")"
head -1 "$DATA/assets/$idx" | jq -e --arg d "$RDAY" '.kind == "zeroed-record-index" and .day == $d and (.files | map(select(.boot != null)) | length) == 4' >/dev/null || fail "day index"
tail -1 "$DATA/assets/$idx" | grep -Eq '^hmac-sha256=[0-9a-f]{64}$' || fail "day index HMAC line"
# On the server: the ended boot's frames and releases are gone, its raw, delays and manifest stay; the newest boot keeps all.
in_c "cd /var/lib/zeroed/recorder/$OLD && [ ! -e days/$RDAY/frames-000.jsonl.zst ] && [ ! -e days/$RDAY/releases-000.jsonl.zst ] && [ -e days/$RDAY/raw-000.jsonl.zst ] && [ -e days/$RDAY/delays-000.jsonl.zst ] && [ -e manifest.json ]" || fail "ended boot: wrong files deleted or kept"
in_c "cd /var/lib/zeroed/recorder/$NEW && for t in frames-000 releases-000 raw-000 delays-000; do [ -e days/$RDAY/\$t.jsonl.zst ] || exit 1; done" || fail "newest boot lost a file"
# Who ran it: the worker's user with no capability; its state is its own.
[ "$(in_c "systemctl show -p User --value zeroed-record-upload@all.service")" = zeroed-worker ] || fail "uploader user"
[ -z "$(in_c "systemctl show -p CapabilityBoundingSet --value zeroed-record-upload@all.service")" ] || fail "uploader holds a capability"
# What it can reach: never the signer's folders, and of the worker's state only the recorder and the journal.
in_c "systemctl show -p InaccessiblePaths --value zeroed-record-upload@all.service" | grep -q '/run/zeroed-signer' || fail "uploader can reach the signer's socket folder"
in_c "systemctl show -p InaccessiblePaths --value zeroed-record-upload@all.service" | grep -q '/var/lib/zeroed-signer' || fail "uploader can reach the signer's state"
in_c "systemctl show -p TemporaryFileSystem --value zeroed-record-upload@all.service" | grep -q '/var/lib/zeroed:ro' || fail "uploader sees the worker's whole state folder"
[ "$(in_c "stat -c '%U %a' /var/lib/zeroed-record-upload/state.json")" = "zeroed-worker 600" ] || fail "uploader state owner or mode"
# The kept file: alerted from the status file by zeroed-check, once, to the owner chat; cleared once it is gone.
in_c "zeroed-check" >/dev/null 2>&1 || true
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"ALERT Zeroed host: 1 recording file(s) kept on the server, not uploaded: $NEW/days/$RDAY/releases-000.jsonl.zst (holds a credential-shaped value)" || fail "kept-file alert"
in_c "zeroed-check" >/dev/null 2>&1 || true
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c 'recording file(s) kept')" = 1 ] || fail "kept-file alert repeated"
in_c "rm /var/lib/zeroed/recorder/$NEW/days/$RDAY/releases-000.jsonl.zst"
u0="$(grep -cE "\"call\":\"upload\",\"tag\":\"rec-$RDAY\",\"name\":\"($OLD|$NEW)\." "$DATA/calls.jsonl")"
in_c "zeroed-record-upload --day $RDAY" >"$LOGS/record-upload-2.txt" 2>&1 || { cat "$LOGS/record-upload-2.txt"; fail "zeroed-record-upload --day"; }
[ "$(grep -cE "\"call\":\"upload\",\"tag\":\"rec-$RDAY\",\"name\":\"($OLD|$NEW)\." "$DATA/calls.jsonl")" = "$u0" ] || fail "a second run uploaded again"
in_c "zeroed-check" >/dev/null 2>&1 || true
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -q 'CLEARED Zeroed host: no recording file is kept back from upload.' || fail "kept-file alert not cleared"
in_c "zeroed-record-upload --day 2026-02-30" >/dev/null 2>&1 && fail "a day that does not exist was accepted"
# Back as it was for the later sections: switch off, no recordings, no uploader state.
in_c "jq 'del(.record_upload, .record_upload_delete_local)' /opt/zeroed/current/ops/host-config.json > /tmp/hc && cat /tmp/hc > /opt/zeroed/current/ops/host-config.json"
in_c "rm -rf /var/lib/zeroed/recorder/$OLD /var/lib/zeroed/recorder/$NEW /var/lib/zeroed-record-upload/state.json /var/lib/zeroed-record-upload/status.json /var/lib/zeroed-record-upload/tmp"
in_c "zeroed-check" >/dev/null 2>&1 || true
pass "recording upload (locked wrangler dev): an ended boot's frames, releases and manifest uploaded byte for byte through the signed watchdog route with a fixed Content-Length, then its frames and releases deleted (raw, delays, manifest kept); the newest boot while the worker runs uploaded and untouched; a credential-shaped file kept, alerted once and cleared; a day prerelease never latest; signed day index; as the worker's user with no capability; a second run sends nothing"

# ---------- 10. Restart and crash drills ----------
# RC-R2-3 on real systemd: the release deployed in section 8 is on probation. A planned restart never counts; the
# kill -9 below raises NRestarts and the probation sees it. There is no earlier release here, so it alerts and drops.
in_c "test -s /var/lib/zeroed-host/probation" || fail "no probation after the switch in section 8"
r0="$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents'")"
nrp="$(in_c "systemctl show -p NRestarts --value zeroed-worker")"
in_c "systemctl restart zeroed-worker"
wait_for 30 "worker back after a planned restart" "docker exec $C systemctl is-active zeroed-worker"
# OPS-CLEAN round 5: the re-pair and pending-restart paths use try-restart; neither it nor a restart is automatic, so
# neither raises NRestarts, the count the probation reads.
in_c "systemctl try-restart zeroed-worker"
wait_for 30 "worker back after a planned try-restart" "docker exec $C systemctl is-active zeroed-worker"
nr0="$(in_c "systemctl show -p NRestarts --value zeroed-worker")"
[ "$nr0" = "$nrp" ] || fail "a planned restart or try-restart raised NRestarts ($nrp -> $nr0)"
upd_run || fail "zeroed-update after a planned restart"
in_c "test -s /var/lib/zeroed-host/probation" || fail "a planned restart ended the probation"
in_c "cat /var/lib/zeroed-host/deployed" | grep -qx "$signed" || fail "a planned restart moved the deployed record"
in_c "kill -9 \$(systemctl show -p MainPID --value zeroed-worker)"
wait_for 30 "worker back after kill -9" "docker exec $C systemctl is-active zeroed-worker"
[ "$(in_c "systemctl show -p NRestarts --value zeroed-worker")" -gt "$nr0" ] || fail "kill -9 did not raise NRestarts"
upd_run && fail "zeroed-update did not see the kill -9 during the probation"
in_c "journalctl -u zeroed-update -o cat --no-pager" | grep -q "did not stay up after the switch (it restarted 1 time(s) within .* of the switch (probation 120 min)), and there is no earlier release to go back to" || fail "probation rollback with no earlier release not alerted"
in_c "test ! -e /var/lib/zeroed-host/probation" || fail "the probation was not dropped"
in_c "cat /var/lib/zeroed-host/deployed" | grep -qx "$signed" || fail "the deployed record moved with no earlier release"
pass "probation (RC-R2-3) on real systemd: a planned restart or try-restart leaves it (NRestarts unchanged); kill -9 raises NRestarts, the next zeroed-update sees it, alerts that there is no earlier release and drops it"
sleep 2
r1="$(in_c "journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Reconcile: 0 open intents'")"
[ "$r1" -ge $((r0 + 2)) ] || fail "reconcile did not run before each start ($r0 -> $r1)"
in_c "systemctl restart zeroed-signer && systemctl is-active zeroed-signer" >/dev/null || fail "signer restart"
pass "drills: restart and kill -9 both brought the worker back with reconcile first ($r0 -> $r1 reconciles)"

# ---------- 10b. Update gate during a qualifying dry run, install.sh --update, worker API ----------
# has PATTERN: grep -q that reads all its input first, so an early match never breaks the pipe (pipefail).
has() { local all; all="$(cat)"; grep -q "$@" <<<"$all"; }
in_c "systemctl stop zeroed-check.timer" # the stages below run the check by hand, one run at a time
chk() { in_c "systemctl reset-failed zeroed-check.service 2>/dev/null; systemctl start zeroed-check.service"; } # reset-failed: many runs in seconds would hit the start limit
jl() { in_c "journalctl -u $1 -o cat --no-pager"; }
in_c "mkdir -p /var/lib/zeroed-dryrun/evidence/vps-e2e && printf '{\"name\":\"e2e-q\",\"label\":\"vps\",\"commit\":\"$signed\",\"startedAt\":1}' > /var/lib/zeroed-dryrun/evidence/vps-e2e/run.json"
in_c "echo 0000000000000000000000000000000000000000 > /var/lib/zeroed-host/deployed"
upd_run || true
in_c "cat /var/lib/zeroed-host/deployed" | has -x 0000000000000000000000000000000000000000 || fail "deployed during an unfinished qualifying run"
jl zeroed-update | has "the qualifying dry run e2e-q is active" || fail "update gate reason (unfinished run) not logged"
in_c "printf '{\"pass\":false}' > /var/lib/zeroed-dryrun/evidence/vps-e2e/report.json"
# A stand-in for a running dry run: a unit file for this one instance in /run, which wins over RUN-1's
# zeroed-dryrun@.service template when the deployed release already installed it.
in_c "printf '[Service]\nExecStart=/bin/sleep 300\n' > /run/systemd/system/zeroed-dryrun@e2e-unit.service && systemctl daemon-reload && systemctl start zeroed-dryrun@e2e-unit.service"
upd_run || true
in_c "cat /var/lib/zeroed-host/deployed" | has -x 0000000000000000000000000000000000000000 || fail "deployed while a zeroed-dryrun@ unit is active"
jl zeroed-update | has "the qualifying dry run e2e-unit is active" || fail "update gate reason (active unit) not logged"
in_c "systemctl stop zeroed-dryrun@e2e-unit.service && rm /run/systemd/system/zeroed-dryrun@e2e-unit.service && systemctl daemon-reload"
upd_run || fail "update after the dry run ended"
in_c "cat /var/lib/zeroed-host/deployed" | has -x "$signed" || fail "no deploy after the dry run ended"
pass "update gate: no deploy while a named dry run has no report (after a reboot drill) or while a zeroed-dryrun@ unit is active; deploys once both end"

# The deploy above applied the signed release's own host files (correct: release and host files go
# together). Once that release carries an older ops/ (an earlier PR's), they are older than this branch's, so
# put this branch's host files back, as the merge of this branch would, before testing its update path.
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-branch-files.txt" 2>&1 || { cat "$LOGS/console/update-branch-files.txt"; fail "install --update (this branch's host files)"; }
docker exec -i "$C" cmp -s /usr/local/sbin/zeroed-update - <"$ROOT/ops/host/files/usr/local/sbin/zeroed-update" || fail "test setup: this branch's zeroed-update not in place"
# A newer release whose host files fail to apply: nothing switches, the worker is not restarted, the owner
# is told once, and the next run tries again under the same gates.
in_c "echo 0000000000000000000000000000000000000000 > /var/lib/zeroed-host/deployed"
in_c "mkdir -p /opt/zeroed/releases/$signed/ops && printf '#!/usr/bin/env bash\n# --update) UPDATE=1\nexit 1\n' > /opt/zeroed/releases/$signed/ops/install.sh"
w0="$(jl zeroed-worker | grep -c 'Started zeroed-worker.service')"
n0="$(wc -l <"$STATE/telegram.jsonl")"
upd_run && fail "update reported success with failing host files"
upd_run && fail "update reported success with failing host files (second run)"
in_c "cat /var/lib/zeroed-host/deployed" | has -x 0000000000000000000000000000000000000000 || fail "switched to a release whose host files failed"
[ "$(jl zeroed-worker | grep -c 'Started zeroed-worker.service')" = "$w0" ] || fail "worker restarted on failed host files"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c 'failed to apply, so the server stays on the release it runs')" = 1 ] || fail "no single alert for failed host files"
jl zeroed-update | has 'still on the old release, trying again next run' || fail "failed apply not logged"
# All or nothing: a release whose installer changes host files (two scripts, a new unit, RUN-1's units) and
# then fails on its firewall must leave every host-managed path, the unit states and the ruleset exactly as
# they were.
sed -e 's/^# Console: where setup stands/# Changed by the e2e. Console: where setup stands/' \
    -e 's/^# Starts the worker for zeroed-worker.service/# Changed by the e2e. Starts the worker for zeroed-worker.service/' \
    -e 's/^    ct state invalid drop$/    this is not nftables/' \
    -e "s|^install -d -m 0755 -o root -g root /etc/zeroed /opt/zeroed /opt/zeroed/releases$|install_file /etc/systemd/system/zeroed-e2e-new.timer 0644 <<'__E2E__'@NL@[Timer]@NL@OnCalendar=daily@NL@__E2E__@NL@\\0|" \
    "$ROOT/ops/install.sh" | sed 's/@NL@/\n/g' >"$E2E/broken-install.sh"
grep -q 'this is not nftables' "$E2E/broken-install.sh" && grep -q 'zeroed-e2e-new.timer' "$E2E/broken-install.sh" && [ "$(grep -c 'Changed by the e2e' "$E2E/broken-install.sh")" = 2 ] || fail "test setup: broken installer"
docker cp "$E2E/broken-install.sh" "$C:/opt/zeroed/releases/$signed/ops/install.sh"
manifest() {
  in_c "for p in \$(grep -o '^install_file [^ ]*' /opt/zeroed/releases/$signed/ops/install.sh | cut -d' ' -f2) /etc/zeroed/host.env /etc/zeroed/worker.env /etc/ssh/sshd_config.d/10-zeroed.conf /var/lib/zeroed-host/release-units \$(ls -d /etc/systemd/system/zeroed-* /etc/systemd/system/*.wants/zeroed-* 2>/dev/null); do if [ -e \$p ]; then printf '%s %s\n' \$p \$(sha256sum < \$p | cut -c1-64); else printf '%s absent\n' \$p; fi; done | sort -u; nft list ruleset | sha256sum; systemctl list-unit-files 'zeroed-*' --no-legend | sort"
}
manifest >"$LOGS/manifest-before.txt"
grep -q '^/etc/systemd/system/zeroed-e2e-new.timer absent$' "$LOGS/manifest-before.txt" || fail "test setup: manifest"
upd_run && fail "update reported success with a broken firewall"
manifest >"$LOGS/manifest-after.txt"
diff -u "$LOGS/manifest-before.txt" "$LOGS/manifest-after.txt" >"$LOGS/manifest-diff.txt" || { cat "$LOGS/manifest-diff.txt"; fail "a failed update left host files changed"; }
in_c "find / -xdev -name '*.zeroed-old' 2>/dev/null" | has . && fail "backups left behind after a roll-back"
in_c "cat /var/lib/zeroed-host/host_update.log" | has 'Update failed; every host file is back as it was' || fail "roll-back not reported"
in_c "cat /var/lib/zeroed-host/deployed" | has -x 0000000000000000000000000000000000000000 || fail "switched after a rolled-back update"
[ "$(jl zeroed-worker | grep -c 'Started zeroed-worker.service')" = "$w0" ] || fail "worker restarted after a rolled-back update"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c 'failed to apply')" = 1 ] || fail "the failure episode alerted more than once"
# The release carries this branch's installer and RUN-1 units (a GitHub-signed merge of it would): the next
# run applies them, then switches.
in_c "rm -rf /opt/zeroed/releases/$signed/packages/runner/systemd && mkdir -p /opt/zeroed/releases/$signed/packages/runner"
docker cp "$ROOT/ops/install.sh" "$C:/opt/zeroed/releases/$signed/ops/install.sh"
docker cp "$ROOT/packages/runner/systemd" "$C:/opt/zeroed/releases/$signed/packages/runner/systemd"
# HOST-CAPS: eight older releases pile up beside the current one; the deploy that follows leaves at most 5 (the current
# release, the previous one, the deploy tag's commit and the 3 newest others), and the oldest go.
in_c "for i in 1 2 3 4 5 6 7 8; do h=\$(printf '%040x' \$i); mkdir -p /opt/zeroed/releases/\$h && touch -d \"\$i days ago\" /opt/zeroed/releases/\$h; done"
upd_run || { in_c "cat /var/lib/zeroed-host/host_update.log"; fail "host apply"; }
in_c "cat /var/lib/zeroed-host/deployed" | has -x "$signed" || fail "not switched after the host files applied"
in_c "ls -1d /opt/zeroed/releases/*/ | wc -l" | has -x '[1-5]' || fail "old releases were not pruned (HOST-CAPS: at most 5 stay)"
in_c "test -d /opt/zeroed/releases/$signed && test -d /opt/zeroed/releases/\$(printf '%040x' 1) && test ! -e /opt/zeroed/releases/\$(printf '%040x' 5) && test ! -e /opt/zeroed/releases/\$(printf '%040x' 8)" || fail "the wrong releases were pruned (HOST-CAPS)"
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | has 'CLEARED Zeroed host: the host files of' || fail "failed-apply alert not cleared"
jl zeroed-update | has "Host files from ${signed:0:12} applied." || fail "host apply not logged"
for u in $(ls "$ROOT/packages/runner/systemd"); do in_c "cmp -s /etc/systemd/system/$u /opt/zeroed/current/packages/runner/systemd/$u" || fail "RUN-1 unit $u not installed"; done
in_c "systemctl is-enabled zeroed-dryrun-tick.timer && systemctl is-active zeroed-dryrun-tick.timer && systemctl is-enabled zeroed-check.timer" >/dev/null || fail "tick or check timer not enabled"
in_c "! systemctl is-enabled zeroed-dryrun@.service 2>/dev/null | grep -q enabled" || fail "the dry-run template was enabled"
in_c "apt-config dump" | has 'Unattended-Upgrade::Origins-Pattern:: "origin=Tailscale,label=Tailscale,codename=${distro_codename}";' || fail "Tailscale origin not in unattended-upgrades"
in_c "systemctl cat zeroed-dryrun@x.service" | has -- '--evidence-root /var/lib/zeroed-dryrun/evidence' || fail "runner unit not installed from the release"
in_c "! test -e /etc/zeroed/deploy-code" || fail "--update made a deploy code"
in_c "nft list ruleset" | has 'dport 22' && fail "--update opened SSH"
# SSH as the running firewall has it: kept open when it was open, kept closed when closed.
in_c "sed -i 's/^#SSH_RULE#//' /etc/nftables.conf && nft -f /etc/nftables.conf"
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-ssh-open.txt" 2>&1 || fail "install --update (SSH open)"
in_c "nft list ruleset" | has 'tcp dport 22 .*accept' || fail "--update closed SSH that was open"
in_c "sed -i 's/^\(    tcp dport 22\)/#SSH_RULE#\1/' /etc/nftables.conf && nft -f /etc/nftables.conf"
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-ssh-closed.txt" 2>&1 || fail "install --update (SSH closed)"
in_c "nft list ruleset" | has 'dport 22' && fail "--update opened SSH that was closed"
grep -q 'Deploy code' "$LOGS/console/update-ssh-open.txt" "$LOGS/console/update-ssh-closed.txt" && fail "--update showed a code"
# D07 on an update (Z00): a running server below the minimum only gets a warning, and the update goes through.
in_c "mount --bind /root/meminfo-1gb /proc/meminfo"
rc=0; in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-d07.txt" 2>&1 || rc=$?
in_c "umount /proc/meminfo"
[ "$rc" = 0 ] && grep -qF "Warning: this server is below the bot's host minimum (D07): it has 0.96 GiB of RAM; the bot needs a 2 GB server (at least 1.5 GiB reported)." "$LOGS/console/update-d07.txt" && grep -q '^==> Updated: ' "$LOGS/console/update-d07.txt" || { cat "$LOGS/console/update-d07.txt"; fail "D07: --update on a small server did not warn and go through (exit $rc)"; }
pass "D07 preflight: --update on a server below the minimum warns and updates"
in_c "nft list ruleset" | has 'iifname "tailscale0" tcp dport 443 accept' || fail "tailnet HTTPS rule"
wait_for 30 "worker running after the update" "docker exec $C systemctl is-active zeroed-worker"
in_c "systemctl show -p ExecStart --value zeroed-worker" | has /usr/local/lib/zeroed/worker-start || fail "worker not started by the wrapper"
# The worker the release's host-config names: its own (SWITCH-1, "worker": "release") or the host's stand-in.
cmd="$(in_c "tr '\\0' ' ' < /proc/\$(systemctl show -p MainPID --value zeroed-worker)/cmdline")"
if in_c "jq -e '.worker == \"release\"' /opt/zeroed/current/ops/host-config.json" >/dev/null 2>&1; then
  has /opt/zeroed/current/packages/worker/src/main.ts <<<"$cmd" || fail "the release says worker: release, but its worker does not run"
  STANDIN=0
else
  has /opt/zeroed/stub/worker.mjs <<<"$cmd" || fail "the release's worker ran without the host-config switch"
  STANDIN=1
fi
pid="$(in_c "systemctl show -p MainPID --value zeroed-worker")"
in_c "tr '\0' '\n' < /proc/$pid/environ" >"$LOGS/worker-env.txt"
for want in ZEROED_MODE=paper ZEROED_RECORDER=on ZEROED_SIMULATE=on ZEROED_DRILLS=on ZEROED_HEALTH_ADDR=127.0.0.1:8787 ZEROED_API_ADDR=127.0.0.1:8788; do grep -qx "$want" "$LOGS/worker-env.txt" || fail "worker environment: $want"; done
chk
CIP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$C")"
if [ "$STANDIN" = 1 ]; then
  # The stand-in's API lists the evidence kept on the host (the release's worker: section 10b2).
  wait_for 20 "worker API up" "docker exec $C curl -fsS -m 3 http://127.0.0.1:8788/health"
  in_c "curl -fsS http://127.0.0.1:8788/health" >"$LOGS/health.json"
  jq -e '.mode == "paper" and .signing_key == false and (.evidence | map(.id) | index("vps-e2e") != null) and (.evidence[] | select(.id == "vps-e2e") | .finished == true and .pass == false and .name == "e2e-q")' "$LOGS/health.json" >/dev/null || fail "health API does not list the evidence on the host"
  curl -s -m 3 -o /dev/null "http://$CIP:8788/health" && fail "the worker API answered on the public interface"
fi
in_c "zeroed-status" | has 'Evidence:  /var/lib/zeroed-dryrun/evidence (1 runs)' || fail "status does not list the evidence"
pass "install.sh --update through zeroed-update: failing host files keep the old release and the worker (one alert, cleared later); an installer that fails after writing files (bad firewall) is rolled back to byte-identical host files, units and ruleset; RUN-1 units from the release installed (tick timer on, template off), SSH kept open or closed as it was, no code shown; worker started by the wrapper in paper with recorder, simulation and drills on, health on 127.0.0.1:8787 and API on 127.0.0.1:8788, the stand-in until the release switches to its own worker; worker API on loopback only lists the evidence kept on the host"

# ---------- 10b2. The release's own worker (SWITCH-1) ----------
# reset-failed first: this test restarts the worker more often than its unit's start limit (10 in 10 minutes) allows.
wrestart() { in_c "systemctl reset-failed zeroed-worker 2>/dev/null; ${1:+$1 && }systemctl restart zeroed-worker"; }
orig="$(current)"
rel="$orig"
if [ "$STANDIN" = 1 ]; then
  # This test release is from before the switch: the same code with "worker": "release", as a release of its own.
  rel="$orig-switch"
  in_c "cp -a '$orig' '$rel' && jq '.worker = \"release\"' '$rel/ops/host-config.json' > /tmp/hc && mv /tmp/hc '$rel/ops/host-config.json'"
fi
# PRACTICE-ON: the signed release under test can predate this commit's worker and host-config. The release tried
# here takes both from this commit (git archive: tracked files only), so its worker runs the S0 shakedown that its
# host-config's "shakedown" block sets.
prac="$orig-practice"
in_c "rm -rf '$prac' && cp -a '$rel' '$prac' && rm -rf '$prac/packages'"
git -C "$ROOT" archive HEAD packages ops/host-config.json | docker exec -i "$C" tar -x -C "$prac" || fail "this commit's worker could not be added to the test release"
rel="$prac"
# PAUSE (owner, 2026-10-07): while this commit's host-config runs the stand-in ("worker": "stub"), the release's own
# worker is still tested here, with "release" in this test copy only, so every fix keeps its end-to-end proof. The
# paused value itself is pinned by ops-files.test.ts and host-logic.test.ts; any other value fails here.
case "$(in_c "jq -r '.worker' '$rel/ops/host-config.json'")" in
  release) ;;
  stub) in_c "jq '.worker = \"release\"' '$rel/ops/host-config.json' > /tmp/hc && mv /tmp/hc '$rel/ops/host-config.json'" ;;
  *) fail "this commit's host-config names neither the release's worker nor the stand-in" ;;
esac
in_c "jq -e '.worker == \"release\" and (.shakedown | type) == \"object\"' '$rel/ops/host-config.json'" >/dev/null || fail "this commit's host-config does not run the release's worker with shakedown settings"
# No node_modules: the worker runs on Node 22's type stripping with no runtime dependency.
in_c "find '$rel' -name node_modules | grep -q ." && fail "the release carries node_modules"
in_c "/usr/local/bin/node --version" | has -x 'v22\.[0-9]*\.[0-9]*' || fail "host node is not Node 22"
# The release's worker takes only an https watchdog address: the one the handoff delivered (unreachable from the test
# server, so its heartbeats fail, which it logs and survives). The trial reads the same environment file. Section 9b's
# plain-http address comes back at the end.
wd0="$(in_c "sed -n 's/^WATCHDOG_URL=//p' /etc/zeroed/worker.env")"
in_c "sed -i 's#^WATCHDOG_URL=.*#WATCHDOG_URL=https://zeroed-watchdog.e2e.workers.dev#' /etc/zeroed/worker.env"
# A trial start beside the running worker (zeroed-update runs it before switching): this release's worker starts.
pid0="$(in_c "systemctl show -p MainPID --value zeroed-worker")"
in_c "/usr/local/lib/zeroed/worker-smoke '$rel'" >"$LOGS/smoke-good.txt" 2>&1 || { cat "$LOGS/smoke-good.txt"; fail "worker-smoke refused a release whose worker starts"; }
[ "$(in_c "systemctl show -p MainPID --value zeroed-worker")" = "$pid0" ] || fail "the trial start touched the running worker"
in_c "! ss -ltn | grep -q ':879[78] ' && ! pgrep -u zeroed-worker -f -- '$rel/packages/worker/src/main.ts'" || fail "the trial worker was left running"
in_c "! systemctl list-units --all --plain --no-legend 'zeroed-worker-smoke*' | grep -q ." || fail "the trial left a unit behind"
in_c "journalctl -o cat --no-pager -u zeroed-worker-smoke.service | tail -20" >"$LOGS/smoke-unit.txt"
wrestart "ln -sfn '$rel' /opt/zeroed/current.new && mv -Tf /opt/zeroed/current.new /opt/zeroed/current"
wait_for 60 "the release's worker running" "docker exec $C systemctl is-active zeroed-worker"
in_c "tr '\\0' ' ' < /proc/\$(systemctl show -p MainPID --value zeroed-worker)/cmdline" | has '^/usr/local/bin/node --no-warnings --max-old-space-size=560 --report-on-fatalerror --report-compact --report-directory=/var/lib/zeroed/reports /opt/zeroed/current/packages/worker/src/main.ts $' || fail "zeroed-worker does not run the release's main.ts under the host's node"
inv() { in_c "journalctl -o cat --no-pager _SYSTEMD_INVOCATION_ID=\$(systemctl show -p InvocationID --value zeroed-worker)"; }
relname="$(basename "$rel")"
# The start line of this invocation (the unit's journal also holds earlier runs of the same release, whose start line
# would match at once while this one is still starting), then its health route answering with that same boot.
up="Worker up: boot [^,]*, release ${relname:0:12}, recorder on, simulation on"
wait_for 180 "the worker's start line" "docker exec $C bash -c 'journalctl -o cat --no-pager _SYSTEMD_INVOCATION_ID=\$(systemctl show -p InvocationID --value zeroed-worker)' | grep -q '$up'"
inv >"$LOGS/worker-real.txt"
boot_up="$(grep -o "$up" "$LOGS/worker-real.txt" | tail -1 | sed 's/^Worker up: boot \([^,]*\),.*/\1/')"
[ -n "$boot_up" ] || fail "no start line in this invocation's journal"
wait_for 30 "health answering for boot $boot_up" "docker exec $C curl -fsS -m 2 http://127.0.0.1:8787/health | jq -e --arg b '$boot_up' '.boot == \$b' >/dev/null"
grep -q 'Reconcile: done, open intents written.' "$LOGS/worker-real.txt" || fail "the reconcile before the start did not finish"
in_c "systemctl show -p ExecStartPre --value zeroed-worker" | has 'code=exited ; status=0 }' || fail "the --reconcile ExecStartPre did not exit 0"
[ "$(in_c "systemctl show -p OOMScoreAdjust --value zeroed-worker")" = -500 ] && in_c "grep -qx -- '-500' /proc/\$(systemctl show -p MainPID --value zeroed-worker)/oom_score_adj" || fail "the worker is not the last the kernel takes under memory pressure"
# Keys come from the unit's systemd credentials, as boot/environment.ts reads them.
grep -q 'Credentials present: 3 of 3 provider keys; heartbeat key present.' "$LOGS/worker-real.txt" || fail "the worker did not read its 3 provider keys and the heartbeat key from credentials"
in_c "tail -n 200 /var/lib/zeroed/journal.jsonl | jq -c 'select(.kind == \"start\")' | tail -1" >"$LOGS/worker-start-record.json"
jq -e --arg r "$relname" '.mode == "paper" and .recorder == true and .simulation == true and .git_sha == $r' "$LOGS/worker-start-record.json" >/dev/null || fail "the start record is not paper with recorder and simulation on: $(cat "$LOGS/worker-start-record.json")"
# Drills on: the drill endpoint exists (403 without the boot's token; 404 when drills are off).
code="$(in_c "curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' http://127.0.0.1:8787/drill/drop-feed")"
[ "$code" = 403 ] || fail "the drill endpoint is not on (HTTP $code, want 403; 404 is drills off, 000 is not listening)"
in_c "curl -fsS -m 3 http://127.0.0.1:8787/health" >"$LOGS/health-real.json" || fail "health does not answer on 127.0.0.1:8787"
jq -e '.mode == "paper" and .signing_key == false and .reconciled == true' "$LOGS/health-real.json" >/dev/null || fail "health is not paper, reconciled, without a signing key"
# PRACTICE-ON: the S0 shakedown with S0's diagnostic set, from the release's host-config, in the worker's environment,
# /health and start line; journaled as not qualifying, with the paper edge.
parts='["regime-volume","regime-survival","exec-health","h14-creates-coverage"]'
jq -e --argjson p "$parts" '.entry_rule == "S0" and .s0_diagnostic == $p' "$LOGS/health-real.json" >/dev/null || fail "health does not show the S0 shakedown with its diagnostic set: $(jq -c '{entry_rule, s0_diagnostic}' "$LOGS/health-real.json")"
edge="$(jq -r '.shakedown.ZEROED_PAPER_EDGE_PPM' "$ROOT/ops/host-config.json")"
jq -e --argjson p "$parts" --arg e "$edge" '.entry_rule == "S0" and .qualifying == false and (.paper_edge_ppm | tostring) == $e and .s0_diagnostic == $p' "$LOGS/worker-start-record.json" >/dev/null || fail "the start record is not the non-qualifying S0 shakedown with its edge and set: $(cat "$LOGS/worker-start-record.json")"
in_c "tr '\\0' '\\n' < /proc/\$(systemctl show -p MainPID --value zeroed-worker)/environ" >"$LOGS/worker-real-env.txt"
jq -r '.shakedown | to_entries[] | "\(.key)=\(.value)"' "$ROOT/ops/host-config.json" | while IFS= read -r want; do grep -qxF -- "$want" "$LOGS/worker-real-env.txt" || { echo "missing $want"; exit 1; }; done || fail "the worker's environment lacks a shakedown setting"
grep -qx 'ZEROED_MODE=paper' "$LOGS/worker-real-env.txt" || fail "the shakedown settings moved the worker out of paper"
in_c "curl -fsS -m 3 http://127.0.0.1:8788/api/v1/paper/status" >"$LOGS/api-real.json" || fail "the API does not answer on 127.0.0.1:8788"
jq -e '.mode == "paper" and .data.mode == "paper"' "$LOGS/api-real.json" >/dev/null || fail "the API status is not paper"
for port in 8787 8788; do curl -s -m 3 -o /dev/null "http://$CIP:$port/" && fail "the worker answered on the public interface ($port)"; done
for v in "$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM"; do grep -qF -- "$v" "$LOGS/health-real.json" "$LOGS/api-real.json" "$LOGS/worker-real.txt" && fail "a key value is in the worker's output"; done
# No provider is reachable from the test server: the worker runs degraded (entries halted), it does not crash-loop.
r0="$(in_c "systemctl show -p NRestarts --value zeroed-worker")"
sleep 30
[ "$(in_c "systemctl show -p NRestarts --value zeroed-worker")" = "$r0" ] && in_c "systemctl is-active zeroed-worker" >/dev/null || fail "the worker restarted without its providers"
in_c "curl -fsS -m 3 http://127.0.0.1:8787/health" | jq -e '.entries_halted == true and (.halt_reasons | length > 0)' >/dev/null || fail "without providers the worker is not degraded with entries halted"
# A restart comes back clean, reconciling first.
boot0="$(jq -r .boot "$LOGS/health-real.json")"
wrestart
wait_for 60 "the worker back after a restart" "docker exec $C curl -fsS -m 2 http://127.0.0.1:8787/health | jq -e '.boot != \"$boot0\" and .reconciled == true' >/dev/null"
inv | has 'Reconcile: done, open intents written.' || fail "the restart did not reconcile first"
# Any mode but paper is refused: the wrapper sets paper over the environment file, and the worker itself refuses live.
wrestart "echo ZEROED_MODE=live >> /etc/zeroed/worker.env"
wait_for 60 "the worker after a live setting" "docker exec $C systemctl is-active zeroed-worker"
in_c "tr '\\0' '\\n' < /proc/\$(systemctl show -p MainPID --value zeroed-worker)/environ" | has -x 'ZEROED_MODE=paper' || fail "the environment file switched the worker out of paper"
in_c "sed -i '/^ZEROED_MODE=live\$/d' /etc/zeroed/worker.env"
rc=0; in_c "cd /opt/zeroed/current && runuser -u zeroed-worker -- env -i PATH=/usr/bin:/bin ZEROED_MODE=live ZEROED_STATE_DIR=/tmp /usr/local/bin/node --no-warnings packages/worker/src/main.ts" >"$LOGS/worker-live.txt" 2>&1 || rc=$?
[ "$rc" = 2 ] && grep -q 'refused: ZEROED_MODE must be paper' "$LOGS/worker-live.txt" || fail "the worker did not refuse live (exit $rc)"
in_c "zeroed-status" | has "Worker:    active (the release's worker, ${relname:0:12})" || fail "zeroed-status does not say which worker runs"
# A release whose worker cannot start is never switched to: a syntax error, a missing file, a refused config.
broken() { # NAME: a copy of this release with the switch on, to break
  in_c "rm -rf '/opt/zeroed/releases/$1' && cp -a '$rel' '/opt/zeroed/releases/$1'"
}
broken smoke-syntax && in_c "printf 'const = ;\n' >> /opt/zeroed/releases/smoke-syntax/packages/worker/src/run/api.ts"
broken smoke-missing && in_c "rm /opt/zeroed/releases/smoke-missing/packages/worker/src/run/config.ts"
broken smoke-config && in_c "echo '{not json' > /opt/zeroed/releases/smoke-config/packages/runner/qualifying-run.json"
# PRACTICE-ON: the shakedown in a release that names a qualifying run (the worker refuses S0 there), and a shakedown
# block that names a setting outside the allowed five.
broken smoke-qualifying && in_c "echo '{\"run\": \"e2e-q1\"}' > /opt/zeroed/releases/smoke-qualifying/packages/runner/qualifying-run.json"
broken smoke-shakedown && in_c "jq '.shakedown.ZEROED_MODE = \"live\"' /opt/zeroed/releases/smoke-shakedown/ops/host-config.json > /tmp/hc && mv /tmp/hc /opt/zeroed/releases/smoke-shakedown/ops/host-config.json"
# A worker that answers, then dies 15 s later: the trial's hold catches it.
broken smoke-dies && in_c "sed -i '1i if (!process.argv.includes(\"--reconcile\")) setTimeout(() => process.exit(1), 15_000);' /opt/zeroed/releases/smoke-dies/packages/worker/src/main.ts"
for b in smoke-syntax smoke-missing smoke-config smoke-qualifying smoke-shakedown smoke-dies; do
  rc=0; in_c "/usr/local/lib/zeroed/worker-smoke /opt/zeroed/releases/$b" >"$LOGS/$b.txt" 2>&1 || rc=$?
  [ "$rc" = 1 ] && [ "$(wc -l < "$LOGS/$b.txt")" = 1 ] || { cat "$LOGS/$b.txt"; fail "worker-smoke passed a broken release ($b, exit $rc)"; }
done
grep -q 'exited 1' "$LOGS/smoke-syntax.txt" && grep -q 'exited 1' "$LOGS/smoke-missing.txt" && grep -q 'exited 2' "$LOGS/smoke-config.txt" && grep -q 'exited 1 within 30 s of answering' "$LOGS/smoke-dies.txt" || fail "worker-smoke reasons: $(cat "$LOGS"/smoke-*.txt)"
grep -q 'exited 2: refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run' "$LOGS/smoke-qualifying.txt" && grep -q 'its host-config shakedown settings are refused: .*ZEROED_MODE is not a shakedown setting' "$LOGS/smoke-shakedown.txt" || fail "worker-smoke shakedown reasons: $(cat "$LOGS/smoke-qualifying.txt" "$LOGS/smoke-shakedown.txt")"
in_c "rm -rf /opt/zeroed/releases/smoke-missing /opt/zeroed/releases/smoke-config /opt/zeroed/releases/smoke-qualifying /opt/zeroed/releases/smoke-shakedown /opt/zeroed/releases/smoke-dies && mv /opt/zeroed/releases/smoke-syntax '/opt/zeroed/releases/$signed2'"
# Through zeroed-update: a green, GitHub-signed release with that broken worker stays undeployed; one alert.
pid0="$(in_c "systemctl show -p MainPID --value zeroed-worker")"
n0="$(wc -l < "$STATE/telegram.jsonl")"
echo success >"$STATE/checks/$signed2"
git -C "$BARE" tag -f deploy "$signed2" >/dev/null && git -C "$BARE" update-server-info
upd_run && fail "zeroed-update deployed a release whose worker does not start"
[ "$(current)" = "$rel" ] || fail "current moved to a release whose worker does not start"
[ "$(in_c "systemctl show -p MainPID --value zeroed-worker")" = "$pid0" ] || fail "the running worker was stopped for a release whose worker does not start"
in_c "cat /var/lib/zeroed-host/deployed" | has -x "$signed" || fail "the deployed record moved"
upd_run && fail "zeroed-update deployed a release whose worker does not start (second run)"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c "did not start in a trial")" = 1 ] || fail "not exactly one alert for a release whose worker does not start"
# A release whose worker passes the trial but dies under the unit (here: only once it has its credentials) is switched
# to, does not stay up, and the server goes back to the release it ran: current, deployed record, worker; one alert;
# that commit is not tried again.
in_c "rm -rf '/opt/zeroed/releases/$signed2'"
broken "$signed2" && in_c "sed -i '1i if (process.env.CREDENTIALS_DIRECTORY \&\& !process.argv.includes(\"--reconcile\")) setTimeout(() => process.exit(1), 15_000);' '/opt/zeroed/releases/$signed2/packages/worker/src/main.ts'"
in_c "/usr/local/lib/zeroed/worker-smoke '/opt/zeroed/releases/$signed2'" >"$LOGS/smoke-unit-dies.txt" 2>&1 || { cat "$LOGS/smoke-unit-dies.txt"; fail "the trial refused a worker that dies only under the unit"; }
n0="$(wc -l < "$STATE/telegram.jsonl")"
in_c "systemctl reset-failed zeroed-worker"
upd_run && fail "zeroed-update reported success for a release whose worker did not stay up"
[ "$(current)" = "$rel" ] || fail "current did not go back to the release that ran"
in_c "cat /var/lib/zeroed-host/deployed" | has -x "$signed" || fail "the deployed record did not go back"
in_c "cat /var/lib/zeroed-host/failed_release" | has -x "$signed2" || fail "the failed release is not recorded"
wait_for 90 "the old release's worker back" "docker exec $C curl -fsS -m 2 http://127.0.0.1:8787/health | jq -e '.git_sha == \"$relname\"' >/dev/null"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c "did not stay up after the switch")" = 1 ] || fail "not exactly one alert for a worker that did not stay up"
pid0="$(in_c "systemctl show -p MainPID --value zeroed-worker")"
upd_run || fail "zeroed-update on a release it already rolled back"
[ "$(current)" = "$rel" ] && [ "$(in_c "systemctl show -p MainPID --value zeroed-worker")" = "$pid0" ] || fail "a rolled-back release was tried again"
git -C "$BARE" tag -f deploy "$signed" >/dev/null && git -C "$BARE" update-server-info
in_c "rm -rf '/opt/zeroed/releases/$signed2'"
upd_run || fail "zeroed-update after the deploy tag came back"
[ "$(current)" = "$rel" ] || fail "current moved after the deploy tag came back"
# Back to the stand-in and the local watchdog for the sections that follow.
wrestart "sed -i 's#^WATCHDOG_URL=.*#WATCHDOG_URL=$wd0#' /etc/zeroed/worker.env && ln -sfn '$orig' /opt/zeroed/current.new && mv -Tf /opt/zeroed/current.new /opt/zeroed/current"
# This invocation's journal only: an earlier run of the stand-in logged the same line (as in 10b2's start-line wait).
wait_for 60 "the stand-in back" "docker exec $C bash -c 'journalctl -o cat --no-pager _SYSTEMD_INVOCATION_ID=\$(systemctl show -p InvocationID --value zeroed-worker)' | grep -q 'Stub worker up'"
pass "release's worker (SWITCH-1): zeroed-worker runs the release's main.ts under the host's Node 22 with no node_modules; --reconcile first (exit 0); start line and journal say paper with recorder, simulation and drills on; PRACTICE-ON: the release's shakedown settings reach it, /health and the start line show S0 with its diagnostic set, not qualifying, with the paper edge; 3 keys read from systemd credentials and none in its output; health on 127.0.0.1:8787 and API on 127.0.0.1:8788, loopback only; without providers it runs degraded, entries halted, no restarts; a restart comes back reconciled; live is refused; zeroed-status names the worker; worker-smoke passes it beside the running worker in the unit's sandbox and memory cap, and refuses a syntax error, a missing file, a refused config, the shakedown in a release with a qualifying run, a shakedown setting outside the five and a worker that dies after answering; zeroed-update keeps a green signed release whose worker cannot start off current, keeps the worker running and alerts once; a release whose worker passes the trial but dies under the unit is rolled back (current, deployed record, worker), alerted once and not tried again"

# ---------- 10c. Telegram webhook: change alert, retry with back-off, notice after 5 failed tries ----------
in_c "systemctl stop zeroed-check.timer" # the --update runs above switched it back on
WD_URL="$(in_c "sed -n 's/^WATCHDOG_URL=//p' /etc/zeroed/worker.env")/telegram"
n0="$(wc -l <"$STATE/telegram.jsonl")"
printf '{"url":"https://evil.example/hook"}' >"$STATE/webhook.json"
touch "$STATE/fail-setWebhook"
chk
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | has "\"chat_id\":\"$T_CHAT\",\"text\":\"ALERT Zeroed host: the Telegram webhook changed (now: evil.example)" || fail "no alert on a changed webhook"
in_c "cat /var/lib/zeroed-host/webhook_tries" | has -x 1 || fail "first retry not counted"
due="$(in_c "echo \$((\$(cat /var/lib/zeroed-host/webhook_next) - \$(date +%s)))")"
[ "$due" -ge 50 ] && [ "$due" -le 60 ] || fail "back-off after the first failure is $due s, not 1 minute"
chk
in_c "cat /var/lib/zeroed-host/webhook_tries" | has -x 1 || fail "retried before the back-off ran out"
for i in 2 3 4 5; do
  in_c "echo 0 > /var/lib/zeroed-host/webhook_next"
  chk
  in_c "cat /var/lib/zeroed-host/webhook_tries" | has -x "$i" || fail "try $i not counted"
  if [ "$i" -lt 5 ]; then tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | has 'could not set the Telegram webhook' && fail "owner told before 5 failed tries"; fi
done
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: could not set the Telegram webhook after 5 tries")" = 1 ] || fail "no single notice after 5 failed tries"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c '"method":"setWebhook".*"failed":true')" = 5 ] || fail "not 5 failed setWebhook calls"
in_c "zeroed-status" | has 'Webhook:   not set (5 failed tries; retrying)' || fail "status does not show the failing webhook"
rm -f "$STATE/fail-setWebhook"
in_c "echo 0 > /var/lib/zeroed-host/webhook_next"
chk
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not set back to the watchdog"
tail -2 "$STATE/telegram.jsonl" | has 'the Telegram webhook is set again' || fail "no line when the webhook is set again"
chk
tail -1 "$STATE/telegram.jsonl" | has 'CLEARED Zeroed host: the Telegram webhook is back' || fail "changed-webhook alert not cleared"
n1="$(wc -l <"$STATE/telegram.jsonl")"
chk
[ "$(wc -l <"$STATE/telegram.jsonl")" = "$n1" ] || fail "the check spoke while the webhook is right"
pass "webhook: a change by someone else alerts the owner (host only), the server sets its own back; failed sets retry after 1 min, then 2, 4, 8 (not sooner); one notice after 5 failed tries; set again and cleared once Telegram works"

# ---------- 10d. Stored-key check ----------
T_OTHER="TESTOTHER$(rnd 16)"
in_c "cp -p /etc/credstore.encrypted/jupiter_api_key /root/jup.bak"
n0="$(wc -l <"$STATE/telegram.jsonl")"
chk
[ "$(wc -l <"$STATE/telegram.jsonl")" = "$n0" ] || fail "key check alerted on good keys"
printf '%s' "$T_OTHER" | docker exec -i "$C" systemd-creds encrypt --with-key=host --name=jupiter_api_key - /etc/credstore.encrypted/jupiter_api_key
chk
tail -1 "$STATE/telegram.jsonl" | has "\"chat_id\":\"$T_CHAT\",\"text\":\"ALERT Zeroed host: stored key check failed: jupiter_api_key (changed outside a key handoff)" || fail "no alert for a replaced key"
chk
[ "$(grep -c 'stored key check failed' "$STATE/telegram.jsonl")" = 1 ] || fail "key alert repeated"
in_c "zeroed-status" | has 'Key check: FAILED: jupiter_api_key' || fail "status does not show the failed key"
in_c "cp -p /root/jup.bak /etc/credstore.encrypted/jupiter_api_key"
chk
tail -1 "$STATE/telegram.jsonl" | has 'CLEARED Zeroed host: every stored key passes its check again' || fail "key alert not cleared"
# Change byte 100 to a different character (writing a fixed one does nothing when it is already there).
in_c "f=/etc/credstore.encrypted/jupiter_api_key; b=\$(dd if=\$f bs=1 skip=100 count=1 2>/dev/null); [ \"\$b\" = A ] && c=B || c=A; printf '%s' \$c | dd of=\$f bs=1 seek=100 conv=notrunc 2>/dev/null; ! cmp -s \$f /root/jup.bak"
chk
tail -1 "$STATE/telegram.jsonl" | has 'stored key check failed: jupiter_api_key (does not open)' || fail "no alert for a key that does not open"
in_c "mv /root/jup.bak /etc/credstore.encrypted/jupiter_api_key"
chk
tail -1 "$STATE/telegram.jsonl" | has 'CLEARED Zeroed host: every stored key' || fail "key alert not cleared after restore"
pass "key check: quiet on good keys; a key re-encrypted outside the handoff and a key that does not open each alert once (names only), shown in zeroed-status, cleared once restored"

# ---------- 10e. Re-pairing a paired server ----------
T_CHAT2="$(chat_id 5)"
chat_is() { [ "$(in_c "systemd-creds decrypt --name=telegram_chat_id /etc/credstore.encrypted/telegram_chat_id - | sha256sum | cut -c1-64")" = "$(printf '%s' "$1" | sha256sum | cut -c1-64)" ]; }
repair_code() { in_c "echo yes | zeroed-pair-code" | tee -a "$LOGS/console/repair.txt" | sed -n 's/.*\/pair \([0-9]\{6\}\)$/\1/p'; }
in_c "echo no | zeroed-pair-code" >"$LOGS/console/repair-no.txt" 2>&1 && fail "re-pair went ahead without yes"
grep -q 'Cancelled. Nothing changed.' "$LOGS/console/repair-no.txt" && in_c "! test -e /etc/zeroed/pair-code" || fail "a refused re-pair changed something"
# A wrong code: the re-pair is cancelled, the old chat stays and gets its webhook back.
RP="$(repair_code)"
[[ "$RP" =~ ^[0-9]{6}$ ]] || fail "no re-pair code"
tail -1 "$STATE/telegram.jsonl" | has "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: a new Telegram pairing was started" || fail "current chat not told about the re-pair"
in_c "zeroed-status" | has "new pairing pending: /pair $RP within 30 minutes" || fail "status does not show the pending re-pair"
send_tg "$T_CHAT2" "/pair 000000"
grep -q '"method":"deleteWebhook"' "$STATE/telegram.jsonl" || fail "webhook not turned off to read /pair"
chat_is "$T_CHAT" || fail "a wrong re-pair code moved the chat"
grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: a wrong pairing code was sent" "$STATE/telegram.jsonl" || fail "old chat not told about the wrong code"
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not back after a wrong re-pair code"
# Expiry after 30 minutes.
RP="$(repair_code)"
in_c "touch -d '31 minutes ago' /etc/zeroed/pair-code && systemctl reset-failed zeroed-pair.service 2>/dev/null; systemctl start zeroed-pair.service"
in_c "! test -e /etc/zeroed/pair-code" || fail "an expired code was kept"
chat_is "$T_CHAT" || fail "expiry moved the chat"
tail -3 "$STATE/telegram.jsonl" | has 'the new pairing code expired. This chat stays paired.' || fail "expiry not told"
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not back after expiry"
# Success while a dry run is active: the chat moves at once, the worker restart waits for the run.
in_c "rm -f /var/lib/zeroed-dryrun/evidence/vps-e2e/report.json"
RP="$(repair_code)"
w0="$(jl zeroed-worker | grep -c 'Started zeroed-worker.service')"
send_tg "$T_CHAT2" "/pair $RP"
chat_is "$T_CHAT2" || fail "re-pair with the right code did not move the chat"
grep -q "\"chat_id\":\"$T_CHAT\",\"text\":\"Zeroed host: a new chat was paired at the console" "$STATE/telegram.jsonl" || fail "old chat not told it was replaced"
grep -q "\"chat_id\":\"$T_CHAT2\",\"text\":\"Paired." "$STATE/telegram.jsonl" || fail "new chat not told Paired"
jq -e --arg u "$WD_URL" '.url == $u' "$STATE/webhook.json" >/dev/null || fail "webhook not set after re-pair"
in_c "test -e /var/lib/zeroed-host/worker_restart_pending" || fail "worker restart did not wait for the dry run"
[ "$(jl zeroed-worker | grep -c 'Started zeroed-worker.service')" = "$w0" ] || fail "worker restarted during the dry run"
in_c "printf '{\"pass\":false}' > /var/lib/zeroed-dryrun/evidence/vps-e2e/report.json"
n0="$(wc -l <"$STATE/telegram.jsonl")"
chk
wait_for 30 "worker restarted for the new chat" "[ \$(docker exec $C journalctl -u zeroed-worker -o cat --no-pager | grep -c 'Started zeroed-worker.service') -gt $w0 ]"
in_c "! test -e /var/lib/zeroed-host/worker_restart_pending" || fail "restart still pending"
[ "$(tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -c ALERT)" = 0 ] || fail "re-pairing raised an alert"
pass "re-pair: asks first (no = nothing changes); the current chat is told and stays paired through a wrong code and an expired code (webhook back each time); the right code moves alerts to the new chat, tells both, sets the webhook; the worker restart for the new chat waits for the dry run; no false webhook or key alert"

# ---------- 10f. Live view (Tailscale stand-in: no network in the test) ----------
docker cp "$STUBS/tailscale" "$C:/usr/local/bin/tailscale"
in_c "printf '[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/tailscaled.service && systemctl daemon-reload"
in_c "zeroed-status" | has 'Live view: off' || fail "status before the live view"
in_c "zeroed-tailscale" >"$LOGS/console/tailscale.txt" 2>&1 &
TS_PID=$!
wait_for 30 "login link shown" "grep -q 'https://login.tailscale.com/a/e2e0a1b2c3d4' '$LOGS/console/tailscale.txt'"
grep -q "\"chat_id\":\"$T_CHAT2\",\"text\":\"Zeroed host: open this link and log in to Tailscale" "$STATE/telegram.jsonl" || fail "login link not sent to the paired chat"
in_c "touch /var/lib/tailscale-stub/approve"
wait "$TS_PID" || { cat "$LOGS/console/tailscale.txt"; fail "zeroed-tailscale"; }
grep -q 'Live view: https://zeroed.tail-e2e.ts.net (your tailnet only, HTTPS, Funnel off).' "$LOGS/console/tailscale.txt" || fail "live view address"
in_c "cat /var/lib/tailscale-stub/calls" >"$LOGS/tailscale-calls.txt"
grep -qx 'up --hostname=zeroed --ssh=false --accept-routes=false --accept-dns=false --timeout=15m' "$LOGS/tailscale-calls.txt" && grep -qx 'serve --bg --https=443 http://127.0.0.1:8788' "$LOGS/tailscale-calls.txt" || fail "tailscale calls"
# OPS-1h: no funnel command (it would wait forever for a Funnel capability this tailnet does not have).
! grep -q '^funnel' "$LOGS/tailscale-calls.txt" || fail "zeroed-tailscale ran a funnel command"
in_c "zeroed-status" | has 'Live view: https://zeroed.tail-e2e.ts.net' || fail "status after the live view"
in_c "zeroed-tailscale" | has 'Live view: https://zeroed' || fail "zeroed-tailscale is not safe to repeat"
# Funnel switched on by someone: alert, turned off, then cleared; installs run the same check.
in_c "jq '.AllowFunnel = {\"zeroed.tail-e2e.ts.net:443\": true}' /var/lib/tailscale-stub/serve.json > /tmp/s && mv /tmp/s /var/lib/tailscale-stub/serve.json"
chk
tail -1 "$STATE/telegram.jsonl" | has "\"chat_id\":\"$T_CHAT2\",\"text\":\"ALERT Zeroed host: Tailscale Funnel was on (zeroed.tail-e2e.ts.net:443)" || fail "no alert for Funnel on"
in_c "jq -e '(.AllowFunnel // {}) | length == 0' /var/lib/tailscale-stub/serve.json" >/dev/null || fail "Funnel not turned off"
chk
tail -1 "$STATE/telegram.jsonl" | has 'CLEARED Zeroed host: Tailscale Funnel is off.' || fail "Funnel alert not cleared"
in_c "jq '.AllowFunnel = {\"zeroed.tail-e2e.ts.net:443\": true}' /var/lib/tailscale-stub/serve.json > /tmp/s && mv /tmp/s /var/lib/tailscale-stub/serve.json"
in_c "ZEROED_NO_WAIT=1 bash /root/i --update" >"$LOGS/console/update-funnel.txt" 2>&1 || fail "install --update (Funnel on)"
in_c "jq -e '(.AllowFunnel // {}) | length == 0' /var/lib/tailscale-stub/serve.json" >/dev/null || fail "the installer's check left Funnel on"
grep -q 'ALERT Zeroed host: Tailscale Funnel was on' <(tail -3 "$STATE/telegram.jsonl") || fail "the installer's check raised no Funnel alert"
in_c "systemctl stop zeroed-check.timer"
chk
# OPS-1h review: Funnel that cannot be turned off (an error here) takes the whole serve config down, with an alert.
in_c "zeroed-tailscale" | has 'Live view: https://zeroed' || fail "zeroed-tailscale before the Funnel-off failure"
in_c "jq '.AllowFunnel = {\"zeroed.tail-e2e.ts.net:443\": true}' /var/lib/tailscale-stub/serve.json > /tmp/s && mv /tmp/s /var/lib/tailscale-stub/serve.json"
in_c "touch /var/lib/tailscale-stub/funnel-fail"
chk
in_c "! test -e /var/lib/tailscale-stub/serve.json && ! test -e /var/lib/zeroed-host/live_view" || fail "Funnel that could not be turned off left the API published"
grep -q 'Tailscale Funnel could not be turned off, so the live view was taken down' <(tail -3 "$STATE/telegram.jsonl") || fail "no alert when Funnel could not be turned off"
in_c "rm -f /var/lib/tailscale-stub/funnel-fail"
chk
in_c "zeroed-tailscale" | has 'Live view: https://zeroed' || fail "zeroed-tailscale after the Funnel-off failure"
in_c "zeroed-tailscale --off" | has 'Live view off' && grep -qx 'serve reset' <(in_c "cat /var/lib/tailscale-stub/calls") || fail "zeroed-tailscale --off"
# A serve result other than exactly the worker API (here: Funnel on as well) is taken down by the script.
in_c "touch /var/lib/tailscale-stub/bad-serve"
in_c "zeroed-tailscale" >"$LOGS/console/tailscale-bad.txt" 2>&1 && fail "zeroed-tailscale accepted a serve with Funnel on"
grep -q 'so it was turned off again. Nothing is published.' "$LOGS/console/tailscale-bad.txt" || fail "bad serve not explained"
in_c "! test -e /var/lib/tailscale-stub/serve.json" || fail "bad serve left published"
in_c "rm -f /var/lib/tailscale-stub/bad-serve"
in_c "zeroed-status" | has 'Live view: off' || fail "status after a refused serve"
# OPS-1h: a tailnet without HTTPS Certificates (or MagicDNS) is named with where to turn it on, on the console and in
# the chat, and the script ends at once (exit 1); it never reaches the serve that would wait unseen for the owner.
in_c "touch /var/lib/tailscale-stub/no-https"
n0="$(wc -l < "$STATE/telegram.jsonl")"
rc=0; timeout 60 docker exec "$C" bash -c "zeroed-tailscale" >"$LOGS/console/tailscale-no-https.txt" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$LOGS/console/tailscale-no-https.txt"; fail "zeroed-tailscale without HTTPS: exit $rc, expected 1 (124 = it hung)"; }
grep -qx 'Stopped: the live view needs HTTPS Certificates on your tailnet. Open https://login.tailscale.com/admin/dns, turn on HTTPS Certificates, then run zeroed-tailscale again.' "$LOGS/console/tailscale-no-https.txt" || fail "HTTPS step not named"
tail -n +"$((n0 + 1))" "$STATE/telegram.jsonl" | grep -q "\"chat_id\":\"$T_CHAT2\",\"text\":\"Zeroed host: the live view needs HTTPS Certificates on your tailnet." || fail "HTTPS step not sent to the paired chat"
in_c "tail -1 /var/lib/tailscale-stub/calls" | grep -qx 'status --json' || fail "zeroed-tailscale called tailscale after finding HTTPS off"
in_c "! test -e /var/lib/tailscale-stub/serve.json && ! test -e /var/lib/zeroed-host/live_view" || fail "published without HTTPS"
in_c "touch /var/lib/tailscale-stub/no-magicdns"
rc=0; timeout 60 docker exec "$C" bash -c "zeroed-tailscale" >"$LOGS/console/tailscale-no-dns.txt" 2>&1 || rc=$?
[ "$rc" = 1 ] && grep -q '^Stopped: the live view needs MagicDNS and HTTPS Certificates on your tailnet. Open https://login.tailscale.com/admin/dns' "$LOGS/console/tailscale-no-dns.txt" || fail "MagicDNS step not named (exit $rc)"
in_c "rm -f /var/lib/tailscale-stub/no-https /var/lib/tailscale-stub/no-magicdns"
# A tailscale call that never answers ends with a Stopped line within its limit, and whatever it printed is shown.
in_c "touch /var/lib/tailscale-stub/serve-hang"
rc=0; timeout 60 docker exec "$C" bash -c "ZEROED_TS_WAIT=5 zeroed-tailscale" >"$LOGS/console/tailscale-hang.txt" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$LOGS/console/tailscale-hang.txt"; fail "a hanging tailscale serve: exit $rc, expected 1 (124 = it hung)"; }
grep -qx "Stopped: 'tailscale serve' did not finish within 5s." "$LOGS/console/tailscale-hang.txt" && grep -q 'https://login.tailscale.com/f/serve?node=e2e' "$LOGS/console/tailscale-hang.txt" && grep -qx 'Stopped: tailscale serve did not finish. Nothing is published.' "$LOGS/console/tailscale-hang.txt" || { cat "$LOGS/console/tailscale-hang.txt"; fail "hanging serve not explained"; }
in_c "! test -e /var/lib/tailscale-stub/serve.json && ! test -e /var/lib/zeroed-host/live_view" || fail "published after a hanging serve"
in_c "rm -f /var/lib/tailscale-stub/serve-hang"
in_c "zeroed-tailscale" | has 'Live view: https://zeroed' || fail "zeroed-tailscale after HTTPS was turned on"
in_c "test -s /var/lib/zeroed-host/live_view" || fail "live view state not written"
# A serve the owner set up by hand (no live_view state file): running zeroed-tailscale again takes it over cleanly.
in_c "zeroed-tailscale --off" >/dev/null
in_c "tailscale serve --bg --https=443 http://127.0.0.1:8788 && ! test -e /var/lib/zeroed-host/live_view"
rc=0; timeout 60 docker exec "$C" bash -c "zeroed-tailscale" >"$LOGS/console/tailscale-over-hand.txt" 2>&1 || rc=$?
[ "$rc" = 0 ] && grep -q 'Live view: https://zeroed.tail-e2e.ts.net' "$LOGS/console/tailscale-over-hand.txt" || { cat "$LOGS/console/tailscale-over-hand.txt"; fail "zeroed-tailscale over a hand-made serve (exit $rc)"; }
in_c "grep -qx zeroed.tail-e2e.ts.net /var/lib/zeroed-host/live_view" || fail "live view state not written over a hand-made serve"
# A hand-made serve that publishes more than the worker API (here an extra path) is never adopted: serve keeps the
# extra handler, the exact check refuses it, and everything is taken down.
in_c "zeroed-tailscale --off" >/dev/null
in_c "printf '%s\n' '{\"TCP\":{\"443\":{\"HTTPS\":true}},\"Web\":{\"zeroed.tail-e2e.ts.net:443\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:8788\"},\"/admin\":{\"Proxy\":\"http://127.0.0.1:9000\"}}}}}' > /var/lib/tailscale-stub/serve.json"
rc=0; timeout 60 docker exec "$C" bash -c "zeroed-tailscale" >"$LOGS/console/tailscale-over-extra.txt" 2>&1 || rc=$?
[ "$rc" = 1 ] && grep -q 'so it was turned off again. Nothing is published.' "$LOGS/console/tailscale-over-extra.txt" || { cat "$LOGS/console/tailscale-over-extra.txt"; fail "a hand-made serve with an extra path was adopted (exit $rc)"; }
in_c "! test -e /var/lib/tailscale-stub/serve.json && ! test -e /var/lib/zeroed-host/live_view" || fail "a hand-made serve with an extra path stayed published"
in_c "zeroed-tailscale" | has 'Live view: https://zeroed' || fail "zeroed-tailscale after refusing a hand-made serve"
in_c "zeroed-tailscale --off" | has 'Live view off' || fail "zeroed-tailscale --off (after OPS-1h)"
pass "live view: opt-in zeroed-tailscale shows the login link on the console and sends it to the paired chat, joins as zeroed (no Tailscale SSH), Funnel off, serves HTTPS 443 to 127.0.0.1:8788 only, safe to repeat, --off stops it, a serve that is not exactly the worker API is taken down by the script; a tailnet without HTTPS Certificates or MagicDNS is named with where to turn it on (console and chat, exit 1, no hang), no funnel command is run (it waits forever without Funnel), a hand-made serve is taken over only when it is exactly the worker API, Funnel that cannot be turned off takes the serve down, and a tailscale call that hangs ends with a Stopped line within its limit; Funnel switched on is alerted and turned off by the minute check and by an install; the firewall admits only tailnet HTTPS"

# ---------- 11. Secret scan ----------
in_c "journalctl --no-pager -o cat" >"$LOGS/container-journal.txt"
in_c "journalctl --no-pager -o json" >"$LOGS/container-journal.json"
docker logs "$C" >"$LOGS/container-console.txt" 2>&1
in_c "tar -c --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run/credentials --exclude=/opt/node-v22.23.3 --exclude=/usr --exclude=/opt/zeroed/repo --exclude=/opt/zeroed/releases / 2>/dev/null" >"$E2E/container-fs.tar" || true
mkdir -p "$E2E/fs" && tar -xf "$E2E/container-fs.tar" -C "$E2E/fs" 2>/dev/null || true
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) console.log(JSON.parse(l).text)' "$STATE/telegram.jsonl" >"$LOGS/telegram-texts.txt"
KEYS=("${VALUES_A[@]}" "$T_HELIUS" "$T_ALCHEMY" "$T_JUPITER" "$T_TELEGRAM" "$T_CHAT" "$T_CHAT2" "$T_OTHER" "$T_CF" "$(cat "$STATE/wrangler-secrets/HEARTBEAT_HMAC_KEY")" "$(cat "$STATE/wrangler-secrets/TELEGRAM_WEBHOOK_SECRET")")
scan_hits() { # values-array-name paths... : prints each value found (by hash) and then the number found
  local hits=0 v
  local -n vals="$1"
  shift
  for v in "${vals[@]}"; do
    if grep -rlaF -- "$v" "$@" 2>/dev/null | grep -q .; then
      echo "  value #$(printf '%s' "$v" | sha256sum | cut -c1-8) found in: $(grep -rlaF -- "$v" "$@" | head -3 | tr '\n' ' ')" >&2
      hits=$((hits + 1))
    fi
  done
  echo "$hits"
}
scan() { # label values-array-name paths...
  local label="$1" hits
  shift
  hits="$(scan_hits "$@")"
  [ "$hits" = 0 ] || fail "secret scan ($label): $hits value(s) found"
}
# The scan itself: real-format values planted in vendored code (node_modules, minified, no newline) and on
# the container disk must be found.
PROBE_TOKEN="7$(chat_id 1 | cut -c1-9):AA$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" # Telegram bot token shape
PROBE_UUID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)$/\1-\2-\3-\4-\5/')" # Helius key shape
PROBES=("$PROBE_TOKEN" "$PROBE_UUID")
PROBE_FILE="$ROOT/ops/watchdog/deploy/node_modules/zeroed-scan-probe/index.min.js"
mkdir -p "$(dirname "$PROBE_FILE")" "$E2E/fs/var/log"
printf 'var a="%s",b={k:"%s"};' "$PROBE_TOKEN" "$PROBE_UUID" >"$PROBE_FILE"
printf 'x %s\n' "$PROBE_UUID" >"$E2E/fs/var/log/zeroed-scan-probe.log"
printf 'x %s\n' "$PROBE_TOKEN" >>"$E2E/fs/var/log/zeroed-scan-probe.log"
probe_repo="$(scan_hits PROBES "$ROOT/ops" 2>/dev/null)"
probe_fs="$(scan_hits PROBES "$E2E/fs" 2>/dev/null)"
rm -rf "$(dirname "$PROBE_FILE")" "$E2E/fs/var/log/zeroed-scan-probe.log"
[ "$probe_repo" = 2 ] && [ "$probe_fs" = 2 ] || fail "secret scan missed planted real-format values (repo incl. node_modules: $probe_repo of 2, disk: $probe_fs of 2)"
[ "$(scan_hits PROBES "$ROOT/ops" "$E2E/fs" 2>/dev/null)" = 0 ] || fail "scan probe not removed"
# Keys and the chat id: nowhere, console included.
scan "keys in logs and console" KEYS "$LOGS" "$STATE/gh-calls.log"
scan "keys on the container disk (not /run/credentials)" KEYS "$E2E/fs"
scan "keys in the repo" KEYS "$ROOT/ops" "$ROOT/packages/ops" "$ROOT/.github"
# Deploy codes: shown on the console by design (the owner reads them there), nowhere else.
NONCONSOLE=("$LOGS"/*.txt "$LOGS"/*.json "$LOGS"/*.log)
scan "deploy codes outside the console" CODES "${NONCONSOLE[@]}" "$STATE/gh-calls.log" "$E2E/fs" "$ROOT/ops" "$ROOT/.github"
pass "secret scan: catches planted Telegram-token and UUID-shaped values in node_modules and on disk; none of ${#KEYS[@]} test values (128-bit secrets, 15-digit chat ids) (4 pairing, 4 rotation, both chat ids, the replaced key, Cloudflare token, heartbeat and webhook keys) in any log, console output, Telegram text, journal, container disk or the repo; none of ${#CODES[@]} deploy and backup codes outside the console"

echo
echo "All checks passed. Logs: $LOGS"
