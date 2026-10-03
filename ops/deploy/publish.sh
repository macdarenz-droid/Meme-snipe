#!/usr/bin/env bash
# Deploy workflow, secret handoff. Encrypts the repository secrets to the host's age public key, publishes
# the ciphertext as the single asset of a short-lived prerelease tagged pair-<pairing code>, waits until the
# host has downloaded it (or 15 minutes), then deletes the release and its tag.
#
# Inputs (environment): HOST_PUBLIC_KEY, PAIRING_CODE, ISSUED (run id, increasing), GH_REPO, GITHUB_SHA,
# the secrets HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID,
# optional BACKUP_RECIPIENT, CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) and WRANGLER for the watchdog.
# Test knobs: PICKUP_TIMEOUT_S, PICKUP_POLL_S, PICKUP_GRACE_S, TELEGRAM_API.
#
# Never prints or stores a value: no set -x, values only travel through pipes and the process environment,
# the plaintext bundle is never a file, and generated values are masked in the log first.
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${ISSUED:?}"
NAMES=(HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID)
VALUE_RE='^[A-Za-z0-9._:/+=@-]{1,512}$'

[[ "${HOST_PUBLIC_KEY:-}" =~ ^age1[a-z0-9]{58}$ ]] || die "Host public key: paste the age1... line the installer printed."
[[ "${PAIRING_CODE:-}" =~ ^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$ ]] || die "Pairing code: paste the XXXX-XXXX-XXXX code the installer printed."
[[ "$ISSUED" =~ ^[0-9]{1,20}$ ]] || die "ISSUED must be a number."
[ -z "${BACKUP_RECIPIENT:-}" ] || [[ "$BACKUP_RECIPIENT" =~ ^age1[a-z0-9]{58}$ ]] || die "Backup key: must be an age1... public key."

missing=()
for n in "${NAMES[@]}"; do
  val="${!n:-}"
  if [ -z "$val" ]; then missing+=("$n"); continue; fi
  [[ "$val" =~ $VALUE_RE ]] || die "$n has characters the host does not accept."
done
[ "${#missing[@]}" -eq 0 ] || die "Missing repository secrets: ${missing[*]}"

# A fresh heartbeat key on every run (rotation replaces it too).
# Repository secrets are masked by GitHub already; this one is new, so mask it before anything can print it.
# (A workflow command line is consumed by the runner and never shown in the log.)
HEARTBEAT_HMAC_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[ "${GITHUB_ACTIONS:-}" != true ] || echo "::add-mask::$HEARTBEAT_HMAC_KEY"

# Watchdog first (deploy, then its secrets, then the Telegram webhook), so the host never signs with a key
# the watchdog does not know for longer than one heartbeat.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  [ -n "${WRANGLER:-}" ] || die "WRANGLER is not set."
  url="$($WRANGLER deploy 2>&1 | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1 || true)"
  [ -n "$url" ] || die "Watchdog deploy failed (no workers.dev address in wrangler's output)."
  WATCHDOG_URL="$url"
  hook_secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "${GITHUB_ACTIONS:-}" != true ] || echo "::add-mask::$hook_secret"
  printf '%s' "$HEARTBEAT_HMAC_KEY" | $WRANGLER secret put HEARTBEAT_HMAC_KEY >/dev/null
  printf '%s' "$TELEGRAM_BOT_TOKEN" | $WRANGLER secret put TELEGRAM_BOT_TOKEN >/dev/null
  printf '%s' "$TELEGRAM_CHAT_ID" | $WRANGLER secret put OWNER_CHAT_ID >/dev/null
  printf '%s' "$hook_secret" | $WRANGLER secret put TELEGRAM_WEBHOOK_SECRET >/dev/null
  # Token on stdin (-K -), never in argv or the log.
  printf 'url = "%s/bot%s/setWebhook"\ndata-urlencode = "secret_token=%s"\n' "${TELEGRAM_API:-https://api.telegram.org}" "$TELEGRAM_BOT_TOKEN" "$hook_secret" |
    curl -fsS -m 20 -o /dev/null -K - --data-urlencode "url=$WATCHDOG_URL/telegram" --data-urlencode 'allowed_updates=["message"]' ||
    die "Telegram webhook could not be set."
  unset hook_secret
  echo "Watchdog deployed at $WATCHDOG_URL; secrets and the Telegram webhook replaced."
else
  echo "::warning::CLOUDFLARE_API_TOKEN is not set: the watchdog was not deployed, so the host sends no heartbeats yet."
  WATCHDOG_URL=""
fi

tag="pair-$PAIRING_CODE"
bundle="$(mktemp -d)/secrets.age"
{
  printf 'ZEROED_BUNDLE=1\n'
  printf 'PAIRING_CODE=%s\n' "$PAIRING_CODE"
  printf 'ISSUED=%s\n' "$ISSUED"
  for n in "${NAMES[@]}"; do printf '%s=%s\n' "$n" "${!n}"; done
  printf 'HEARTBEAT_HMAC_KEY=%s\n' "$HEARTBEAT_HMAC_KEY"
  printf 'BACKUP_RECIPIENT=%s\n' "${BACKUP_RECIPIENT:-}"
  printf 'WATCHDOG_URL=%s\n' "${WATCHDOG_URL:-}"
} | age -r "$HOST_PUBLIC_KEY" -o "$bundle"
unset HEARTBEAT_HMAC_KEY

# One bundle per pairing code: an older one (an earlier run) is replaced.
gh release delete "$tag" --yes --cleanup-tag >/dev/null 2>&1 || true
gh release create "$tag" "$bundle" --prerelease --target "$GITHUB_SHA" --title "Host pairing $PAIRING_CODE" \
  --notes "Encrypted to the host's key; only that host can open it. Deleted after pickup or 15 minutes." >/dev/null
rm -f "$bundle"
echo "Published the encrypted bundle as $tag. Waiting for the host to pick it up."

timeout_s="${PICKUP_TIMEOUT_S:-900}"
poll_s="${PICKUP_POLL_S:-15}"
grace_s="${PICKUP_GRACE_S:-60}"
start="$(date +%s)"
picked=no
while [ $(($(date +%s) - start)) -lt "$timeout_s" ]; do
  count="$(gh api "repos/$GH_REPO/releases/tags/$tag" --jq '[.assets[] | select(.name == "secrets.age") | .download_count][0] // 0' 2>/dev/null || echo 0)"
  if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -ge 1 ]; then picked=yes; break; fi
  sleep "$poll_s"
done
[ "$picked" = no ] || sleep "$grace_s"
gh release delete "$tag" --yes --cleanup-tag >/dev/null
if [ "$picked" = yes ]; then
  echo "The host downloaded the bundle; release $tag deleted. The host confirms in Telegram."
else
  echo "No pickup within $((timeout_s / 60)) minutes; release $tag deleted. Check the host is running, then run Deploy again."
  exit 1
fi
