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
# The watchdog's code comes from the commit the "deploy" tag names (the one tag.sh just moved, which the server runs
# too), checked out into a temporary worktree, never from the branch tip this job runs on.
#
# Inputs (environment): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DATA_STORE_TOKEN, DATA_REPO, WRANGLER (the locked
# wrangler binary, without --config). Runs only when CLOUDFLARE_API_TOKEN and DATA_STORE_TOKEN exist; otherwise it
# says why and changes nothing. Test knobs: REPO_ROOT (the repository to read the tag from), SKIP_TAG_FETCH=1.
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

# The deploy tag's commit, fetched fresh (tag.sh moved it through the API), into a temporary worktree.
root="${REPO_ROOT:-$(cd "$here/../.." && pwd)}"
[ "${SKIP_TAG_FETCH:-}" = 1 ] || git -C "$root" fetch --quiet origin "+refs/tags/deploy:refs/tags/deploy" || die "Could not fetch the deploy tag."
sha="$(git -C "$root" rev-parse --verify --quiet "refs/tags/deploy^{commit}")" || die "No deploy tag: the watchdog is not deployed."
src="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$src/w" >/dev/null 2>&1 || true; rm -rf "$src"' EXIT
git -C "$root" worktree add --quiet --detach "$src/w" "$sha"
config="$src/w/packages/ops/wrangler.toml"
[ -f "$config" ] || die "The deploy tag's commit has no packages/ops/wrangler.toml."

"$here/cf-subdomain.sh" >/dev/null
# The repository name is not a secret: it goes in as a plain variable, the only argument that carries a value.
out="$($WRANGLER --config "$config" deploy --var "DATA_REPO:$repo" 2>&1 || true)"
if ! printf '%s\n' "$out" | grep -qE 'https://[A-Za-z0-9.-]+\.workers\.dev'; then
  printf '%s\n' "$out" | tail -n 20 >&2
  die "Watchdog deploy failed (no workers.dev address in wrangler's output; its last lines are above)."
fi
printf '%s' "$DATA_STORE_TOKEN" | $WRANGLER --config "$config" secret put REPORTS_TOKEN >/dev/null
echo "Watchdog code deployed from ${sha:0:12} (the deploy tag); REPORTS_TOKEN set. Its other secrets are unchanged."
