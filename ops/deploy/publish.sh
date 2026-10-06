#!/usr/bin/env bash
# Deploy workflow, key handoff. Encrypts the four API keys to the one-time age identity derived from the
# server's deploy code (the DEPLOY_CODE secret; ops/host/files/usr/local/lib/zeroed/derive-key.mjs), and
# publishes the ciphertext as the only asset of the prerelease "handoff" (a fixed name that reveals
# nothing). Waits until the server downloaded it, or 15 minutes, then deletes the release and its tag.
#
# Inputs (environment): DEPLOY_CODE, ISSUED (run id, increasing), GH_REPO, GITHUB_SHA and the secrets
# HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN. With CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID (and WRANGLER, the locked tool from ops/watchdog/deploy) it also deploys the
# watchdog, sets its secrets, and hands its address, a fresh heartbeat key and the webhook secret to the
# server in the same bundle (the server sets the Telegram webhook once paired).
# Key rotation never cuts off the server (KEY-ROTATE-SAFE, packages/ops/src/watchdog/keyring.ts): the new heartbeat
# key and webhook secret go only into the watchdog's slot that is not active (GET /slot), and the active one is never
# touched. The watchdog switches when the server first uses the new key, so a bundle the server never opens (no pickup,
# a stale or wrong DEPLOY_CODE) changes nothing it relies on.
# Test knobs: PICKUP_TIMEOUT_S, PICKUP_POLL_S, PICKUP_GRACE_S, TELEGRAM_API, CLOUDFLARE_API_URL, WATCHDOG_PROBE_URL, SLOT_POLL_S.
# Owner override (repository variable): FORCE_KEY_ROTATE=yes rotates even while an offer is pending.
#
# Never prints or stores a value: no set -x; the code, the derived identity and the plaintext only pass
# through pipes and the process environment; only the ciphertext is ever a file.
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${ISSUED:?}"
NAMES=(HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN)
VALUE_RE='^[A-Za-z0-9._:/+=@-]{1,512}$'

if [ -z "${DEPLOY_CODE:-}" ]; then
  echo "No DEPLOY_CODE secret: code update only, no keys sent."
  exit 0
fi
[[ "$ISSUED" =~ ^[0-9]{1,20}$ ]] || die "ISSUED must be a number."
missing=()
for n in "${NAMES[@]}"; do
  val="${!n:-}"
  if [ -z "$val" ]; then missing+=("$n"); continue; fi
  [[ "$val" =~ $VALUE_RE ]] || die "$n has characters the server does not accept."
done
[ "${#missing[@]}" -eq 0 ] || die "Missing repository secrets: ${missing[*]}"

recipient="$(printf '%s' "$DEPLOY_CODE" | node "$here/../host/files/usr/local/lib/zeroed/derive-key.mjs" | age-keygen -y)" ||
  die "DEPLOY_CODE must be the 6 words the server shows."
[[ "$recipient" =~ ^age1[a-z0-9]{58}$ ]] || die "Could not derive the handoff key."

# Watchdog: only together with a key handoff, so the server and the watchdog always get the same new key.
WATCHDOG_URL=""
HEARTBEAT_HMAC_KEY=""
WEBHOOK_SECRET=""
rotate=no
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is missing."
  [ -n "${WRANGLER:-}" ] || die "WRANGLER is not set."
  # Repository secrets are masked by GitHub already; these two are new, so mask them first. (A workflow
  # command line is consumed by the runner and never shown in the log.)
  HEARTBEAT_HMAC_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  hook_secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::add-mask::$HEARTBEAT_HMAC_KEY"; echo "::add-mask::$hook_secret"; fi
  # The account needs a workers.dev subdomain once (registered only if Cloudflare clearly has none).
  "$here/cf-subdomain.sh" >/dev/null
  out="$($WRANGLER deploy 2>&1 || true)"
  WATCHDOG_URL="$(printf '%s\n' "$out" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1 || true)"
  if [ -z "$WATCHDOG_URL" ]; then
    # Wrangler's output holds no secret (the token is only in its environment); its tail says what failed.
    printf '%s\n' "$out" | tail -n 20 >&2
    die "Watchdog deploy failed (no workers.dev address in wrangler's output; its last lines are above)."
  fi
  # The slots in use. No answer (or not the new code) stops here, before any secret or bundle changes.
  # A new version can take a few seconds to serve everywhere, so it is asked up to 6 times, 10 s apart.
  hb_active=""
  wh_active=""
  pending=""
  for _ in 1 2 3 4 5 6; do
    slots="$(curl -sS -m 30 -X GET "${WATCHDOG_PROBE_URL:-$WATCHDOG_URL}/slot" 2>/dev/null || true)"
    hb_active="$(printf '%s' "$slots" | jq -r '.heartbeat // empty' 2>/dev/null || true)"
    wh_active="$(printf '%s' "$slots" | jq -r '.webhook // empty' 2>/dev/null || true)"
    pending="$(printf '%s' "$slots" | jq -r 'if (.pending | type) == "boolean" then .pending else empty end' 2>/dev/null || true)"
    [[ "$hb_active" =~ ^(legacy|A|B)$ && "$wh_active" =~ ^(legacy|A|B)$ && "$pending" =~ ^(true|false)$ ]] && break
    sleep "${SLOT_POLL_S:-10}"
  done
  [[ "$hb_active" =~ ^(legacy|A|B)$ && "$wh_active" =~ ^(legacy|A|B)$ && "$pending" =~ ^(true|false)$ ]] || die "The watchdog did not say which key slot is active (GET /slot); nothing was rotated."
  printf '%s' "$TELEGRAM_BOT_TOKEN" | $WRANGLER secret put TELEGRAM_BOT_TOKEN >/dev/null
  if [ "$pending" = true ] && [ "${FORCE_KEY_ROTATE:-}" != yes ]; then
    # A key on offer may already be on the server (a fresh server waiting for /pair, or a run the server picked up
    # but has not restarted for yet). Replacing it would cut the server off, so nothing is rotated: the bundle goes
    # without watchdog keys and the server keeps the ones it has. The owner's override: FORCE_KEY_ROTATE=yes.
    msg="Key rotation refused: an offer is still waiting for the server; nothing rotated. The API keys are still handed over. To rotate anyway, set the repository variable FORCE_KEY_ROTATE to yes, run Deploy, then delete the variable: left set, every later Deploy overwrites a pending key the server may hold and can cut it off (ops/README.md, Watchdog)."
    echo "::warning::$msg"
    [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '**%s**\n' "$msg" >>"$GITHUB_STEP_SUMMARY"
    rotate=no
  else
    other() { if [ "$1" = A ]; then echo B; else echo A; fi; }
    hb_slot="$(other "$hb_active")"
    wh_slot="$(other "$wh_active")"
    [ "$pending" = false ] || echo "::warning::FORCE_KEY_ROTATE=yes: the key still on offer is replaced. Delete the variable now: left set, every later Deploy overwrites a pending key the server may hold and can cut it off."
    printf '%s' "$HEARTBEAT_HMAC_KEY" | $WRANGLER secret put "HEARTBEAT_HMAC_KEY_$hb_slot" >/dev/null
    printf '%s' "$hook_secret" | $WRANGLER secret put "TELEGRAM_WEBHOOK_SECRET_$wh_slot" >/dev/null
    echo "New heartbeat key in slot $hb_slot and webhook secret in slot $wh_slot (active: $hb_active, $wh_active); the watchdog switches when the server uses them."
    rotate=yes
  fi
  # The Telegram webhook is set by the server, not here: it reads /pair through getUpdates first, which
  # Telegram refuses while a webhook is set. The secret travels to it in the encrypted bundle.
  WEBHOOK_SECRET="$hook_secret"
  echo "Watchdog deployed at $WATCHDOG_URL. The server sets the Telegram webhook once paired."
else
  echo "No CLOUDFLARE_API_TOKEN secret: the watchdog is not deployed."
fi

bundle="$(mktemp -d)/bundle.age"
{
  printf 'ZEROED_BUNDLE=1\n'
  printf 'ISSUED=%s\n' "$ISSUED"
  for n in "${NAMES[@]}"; do printf '%s=%s\n' "$n" "${!n}"; done
  if [ -n "$WATCHDOG_URL" ] && [ "$rotate" = yes ]; then
    printf 'WATCHDOG_URL=%s\n' "$WATCHDOG_URL"
    printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$WEBHOOK_SECRET"
    printf 'HEARTBEAT_HMAC_KEY=%s\n' "$HEARTBEAT_HMAC_KEY"
  fi
} | age -r "$recipient" -o "$bundle"
unset HEARTBEAT_HMAC_KEY WEBHOOK_SECRET

gh release delete handoff --yes --cleanup-tag >/dev/null 2>&1 || true
gh release create handoff "$bundle" --prerelease --target "$GITHUB_SHA" --title "Key handoff" \
  --notes "Encrypted for one server's one-time deploy code. Deleted after pickup or 15 minutes." >/dev/null
rm -f "$bundle"
echo "Published the encrypted keys. Waiting for the server to pick them up."

timeout_s="${PICKUP_TIMEOUT_S:-900}"
poll_s="${PICKUP_POLL_S:-15}"
grace_s="${PICKUP_GRACE_S:-60}"
start="$(date +%s)"
picked=no
while [ $(($(date +%s) - start)) -lt "$timeout_s" ]; do
  count="$(gh api "repos/$GH_REPO/releases/tags/handoff" --jq '[.assets[] | select(.name == "bundle.age") | .download_count][0] // 0' 2>/dev/null || echo 0)"
  if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -ge 1 ]; then picked=yes; break; fi
  sleep "$poll_s"
done
[ "$picked" = no ] || sleep "$grace_s"
gh release delete handoff --yes --cleanup-tag >/dev/null
if [ "$picked" = yes ]; then
  # The server cannot report back here, so say only what is known.
  echo "The server downloaded the encrypted keys; the release is deleted. Look at the server console:"
  echo "  - it shows a 6-digit pairing code: the code matched and the keys are stored;"
  echo "  - it says the handoff \"does not open\": DEPLOY_CODE does not match; fix the secret and run Deploy again."
else
  echo "No pickup within $((timeout_s / 60)) minutes; the release is deleted. Check the server shows a deploy code, then run Deploy again."
  exit 1
fi
