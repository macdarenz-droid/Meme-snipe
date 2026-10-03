# Shared helpers for the Zeroed host scripts. Sourced, never run. Never prints a secret value.
# shellcheck shell=bash
. /etc/zeroed/host.env
CRED_DIR=/etc/credstore.encrypted
STATE_DIR=/var/lib/zeroed-host
DEPLOY_CODE_FILE=/etc/zeroed/deploy-code
PAIR_CODE_FILE=/etc/zeroed/pair-code
API_NAMES=(HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN)

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
}

# tg METHOD [curl args...]: calls the Telegram Bot API. The token (and the chat id, from $tg_chat when
# set) go to curl on stdin (-K -), never in argv, so they do not show in the process list.
tg() {
  local method="$1"
  shift
  cred telegram_bot_token | {
    IFS= read -r token || true
    printf 'url = "%s/bot%s/%s"\n' "$ZEROED_TELEGRAM_URL" "$token" "$method"
    [ -z "${tg_chat:-}" ] || printf 'data-urlencode = "chat_id=%s"\n' "$tg_chat"
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

keys_stored() { for n in "${API_NAMES[@]}"; do [ -s "$CRED_DIR/${n,,}" ] || return 1; done; }
paired() { [ -s "$CRED_DIR/telegram_chat_id" ]; }
