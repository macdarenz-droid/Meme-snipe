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

# worker_busy: true while a qualifying dry run is active or the worker reports open intents (or cannot say),
# whether the worker is active or not (logic.sh intents_hold).
worker_busy() {
  [ -z "$(qualifying_run "$EVIDENCE_ROOT" "$(systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend 2>/dev/null || true)")" ] || return 0
  intents_hold "$(systemctl is-active zeroed-worker.service 2>/dev/null || true)" /var/lib/zeroed
}

keys_stored() { for n in "${API_NAMES[@]}"; do [ -s "$CRED_DIR/${n,,}" ] || return 1; done; }
paired() { [ -s "$CRED_DIR/telegram_chat_id" ]; }
