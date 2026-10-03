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
