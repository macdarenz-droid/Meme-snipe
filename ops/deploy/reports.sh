#!/usr/bin/env bash
# Deploy workflow, daily summary (OPS-SUMMARY). Deploys the watchdog's code and sets its one reports secret,
# REPORTS_TOKEN, from the repository secret DATA_STORE_TOKEN (fine-grained, the private reports repository only).
# The private repository's name goes in as the plain variable DATA_REPO. Needs no DEPLOY_CODE and no console step.
#
# It sets exactly one secret and never sets, reads or rotates any other: HEARTBEAT_HMAC_KEY, TELEGRAM_BOT_TOKEN and
# TELEGRAM_WEBHOOK_SECRET stay as the key handoff set them ("Secrets are never deleted by a deployment",
# https://developers.cloudflare.com/workers/wrangler/commands/workers/ under deploy --keep-vars). The token reaches
# wrangler only on stdin, never as an argument; nothing here prints a value (no set -x).
#
# Inputs (environment): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DATA_STORE_TOKEN, DATA_REPO, WRANGLER.
# Runs only when CLOUDFLARE_API_TOKEN and DATA_STORE_TOKEN exist; otherwise it says why and changes nothing.
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${DATA_STORE_TOKEN:-}" ]; then
  echo "No CLOUDFLARE_API_TOKEN or DATA_STORE_TOKEN secret: the daily summary is not set up."
  exit 0
fi
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is missing."
[ -n "${WRANGLER:-}" ] || die "WRANGLER is not set."
[[ "${DATA_STORE_TOKEN}" =~ ^[A-Za-z0-9_]{20,255}$ ]] || die "DATA_STORE_TOKEN has characters a GitHub token does not have."
repo="${DATA_REPO:-}"
[[ "$repo" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]] || die "The repository variable DATA_REPO must be owner/name (Settings > Secrets and variables > Actions > Variables)."
# Fail closed here too: never this public code repository, compared case-insensitively. The watchdog checks again
# (private, and the same name) before every write.
this="${GITHUB_REPOSITORY:-macdarenz-droid/Meme-snipe}"
if [ "${repo,,}" = "${this,,}" ] || [ "${repo,,}" = "macdarenz-droid/meme-snipe" ]; then
  die "DATA_REPO must be the private reports repository, never this one."
fi

"$here/cf-subdomain.sh" >/dev/null
# The repository name is not a secret: it goes in as a plain variable, the only argument that carries a value.
out="$($WRANGLER deploy --var "DATA_REPO:$repo" 2>&1 || true)"
if ! printf '%s\n' "$out" | grep -qE 'https://[A-Za-z0-9.-]+\.workers\.dev'; then
  printf '%s\n' "$out" | tail -n 20 >&2
  die "Watchdog deploy failed (no workers.dev address in wrangler's output; its last lines are above)."
fi
printf '%s' "$DATA_STORE_TOKEN" | $WRANGLER secret put REPORTS_TOKEN >/dev/null
echo "Watchdog code deployed; REPORTS_TOKEN set. Its other secrets are unchanged."
