#!/usr/bin/env bash
# Makes sure the Cloudflare account has a workers.dev subdomain and prints it. Registers one ("zeroed-"
# plus random hex) only when Cloudflare clearly says there is none: a successful read with no subdomain,
# or its "no subdomain" error (code 10007). Any other read (5xx, 429, network error, a token without
# access) stops the run, and an existing subdomain is never renamed. The token goes to curl on stdin.
# Inputs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; test knob CLOUDFLARE_API_URL.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
api="${CLOUDFLARE_API_URL:-https://api.cloudflare.com/client/v4}/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain"
die() { printf '%s\n' "$*" >&2; exit 1; }
cf() { # METHOD [JSON] -> body, then the HTTP status on the last line
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -m 30 -K - -X "$1" -H 'content-type: application/json' ${2:+--data "$2"} -w '\n%{http_code}' "$api" 2>/dev/null || printf '\n000'
}
errors() { printf '%s' "$1" | jq -r '[.errors[]? | "\(.code) \(.message)"] | join("; ")' 2>/dev/null || true; }

reply="$(cf GET)"
status="${reply##*$'\n'}"
body="${reply%$'\n'*}"
ok="$(printf '%s' "$body" | jq -r '.success // false' 2>/dev/null || echo false)"
if [ "$status" = 200 ] && [ "$ok" = true ]; then
  sub="$(printf '%s' "$body" | jq -r '.result.subdomain // empty')"
  [ -z "$sub" ] || { printf '%s\n' "$sub"; exit 0; }
elif [ "$status" = 404 ] && printf '%s' "$body" | jq -e '[.errors[]?.code] | index(10007)' >/dev/null 2>&1; then
  : # No subdomain yet.
else
  case "$status" in
    401 | 403) die "Cloudflare refused to read the workers.dev subdomain (HTTP $status: $(errors "$body")). The token needs Account > Workers Scripts > Edit." ;;
    *) die "Could not read the workers.dev subdomain (HTTP $status: $(errors "$body")); nothing was changed. Run Deploy again later." ;;
  esac
fi

for _ in 1 2 3; do
  try="zeroed-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  reply="$(cf PUT "{\"subdomain\":\"$try\"}")"
  status="${reply##*$'\n'}"
  body="${reply%$'\n'*}"
  if [ "$status" = 200 ] && [ "$(printf '%s' "$body" | jq -r '.success // false' 2>/dev/null)" = true ]; then
    echo "Registered the workers.dev subdomain $try." >&2
    printf '%s\n' "$try"
    exit 0
  fi
  case "$status" in
    401 | 403) die "The Cloudflare token cannot register a workers.dev subdomain (HTTP $status: $(errors "$body")). It needs Account > Workers Scripts > Edit." ;;
  esac
  echo "Registering $try failed (HTTP $status: $(errors "$body"))." >&2
done
die "Could not register a workers.dev subdomain."
