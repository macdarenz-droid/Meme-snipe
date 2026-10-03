#!/usr/bin/env bash
# Deploy workflow, key handoff. Encrypts the four API keys to the one-time age identity derived from the
# server's deploy code (the DEPLOY_CODE secret; ops/host/files/usr/local/lib/zeroed/derive-key.mjs), and
# publishes the ciphertext as the only asset of the prerelease "handoff" (a fixed name that reveals
# nothing). Waits until the server downloaded it, or 15 minutes, then deletes the release and its tag.
#
# Inputs (environment): DEPLOY_CODE, ISSUED (run id, increasing), GH_REPO, GITHUB_SHA and the secrets
# HELIUS_API_KEY ALCHEMY_API_KEY JUPITER_API_KEY TELEGRAM_BOT_TOKEN.
# Test knobs: PICKUP_TIMEOUT_S, PICKUP_POLL_S, PICKUP_GRACE_S.
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

bundle="$(mktemp -d)/bundle.age"
{
  printf 'ZEROED_BUNDLE=1\n'
  printf 'ISSUED=%s\n' "$ISSUED"
  for n in "${NAMES[@]}"; do printf '%s=%s\n' "$n" "${!n}"; done
} | age -r "$recipient" -o "$bundle"

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
