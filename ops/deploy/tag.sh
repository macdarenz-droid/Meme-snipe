#!/usr/bin/env bash
# Deploy workflow, code update. Moves the "deploy" tag to the newest commit on the integration branch
# (first-parent history of GITHUB_SHA) that
#   - GitHub itself signed (a pull-request merge, signed with GitHub's web-flow key), and
#   - passes the deploy gate (logic.sh): GitHub Actions' `check` passed on it and no other GitHub Actions run
#     failed, and the ops end-to-end (`e2e`) passed on the newest commit at or before it that touched the e2e paths.
# Every newer commit it passes over is logged with the reason: unsigned, red, pending or no checks. The
# server runs the same gate, from the same file, before it switches (ops/host/files/usr/local/sbin/zeroed-update).
# Inputs: GH_REPO, GITHUB_SHA, INTEGRATION_BRANCH; run from a full-history checkout.
# Test knobs: SIGNING_KEY_FILE, SIGNING_FPR (a fixture key instead of GitHub's).
set -euo pipefail
: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${INTEGRATION_BRANCH:?}"
here="$(cd "$(dirname "$0")" && pwd)"
FPR="${SIGNING_FPR:-968479A1AFF927E37D1A566BB5690EEEBB952194}"
KEY_FILE="${SIGNING_KEY_FILE:-$here/../host/files/etc/zeroed/github-web-flow.asc}"
# The deploy gate the server uses too (commit_verdict, e2e_commit; the Deploy job's own run is never counted).
# shellcheck source=../host/files/usr/local/lib/zeroed/logic.sh
. "$here/../host/files/usr/local/lib/zeroed/logic.sh"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
gpg --batch --quiet --import "$KEY_FILE" 2>/dev/null

signed_by_github() {
  local status signer
  status="$(git verify-commit --raw "$1" 2>&1 || true)"
  signer="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $NF; exit }')"
  [ "$signer" = "$FPR" ] && printf '%s\n' "$status" | grep -q '^\[GNUPG:\] GOODSIG '
}

check_runs() { gh api "repos/$GH_REPO/commits/$1/check-runs?per_page=100" 2>/dev/null || true; }

# checks SHA: "green", or "red|pending|none: <why>" (the server's gate, word for word).
checks() {
  local v e2e
  v="$(check_runs "$1" | commit_verdict check)"
  [ "$v" = green ] || { printf '%s\n' "$v"; return; }
  e2e="$(e2e_commit . "$1")"
  [ -n "$e2e" ] || { echo "none: no commit at or before it touched the ops end-to-end paths"; return; }
  v="$(check_runs "$e2e" | commit_verdict e2e)"
  [ "$v" = green ] && echo green || printf '%s\n' "${v%%:*}: the ops end-to-end of ${e2e:0:12}: ${v#*: }"
}

git fetch --quiet origin "+refs/heads/$INTEGRATION_BRANCH:refs/remotes/origin/$INTEGRATION_BRANCH"
git merge-base --is-ancestor "$GITHUB_SHA" "refs/remotes/origin/$INTEGRATION_BRANCH" || {
  echo "Not deployable: run Deploy from $INTEGRATION_BRANCH." >&2
  exit 1
}
target=""
for c in $(git rev-list --first-parent --max-count=200 "$GITHUB_SHA"); do
  if ! signed_by_github "$c"; then
    echo "Skipped ${c:0:12}: not signed by GitHub (a direct push, not a pull-request merge)."
    continue
  fi
  v="$(checks "$c")"
  case "$v" in
    green) target="$c"; break ;;
    red*) echo "Skipped ${c:0:12}: a check failed (${v#red: })." ;;
    pending*) echo "Skipped ${c:0:12}: checks still running (${v#pending: })." ;;
    *) echo "Skipped ${c:0:12}: no check runs reported (${v#none: })." ;;
  esac
done
[ -n "$target" ] || { echo "Not deployable: no GitHub-signed merge with all checks green in the last 200 commits on $INTEGRATION_BRANCH." >&2; exit 1; }

if out="$(gh api "repos/$GH_REPO/git/ref/tags/deploy" --jq .object.sha 2>/dev/null)" && [[ "$out" =~ ^[0-9a-f]{40}$ ]]; then
  [ "$out" = "$target" ] || gh api -X PATCH "repos/$GH_REPO/git/refs/tags/deploy" -f sha="$target" -F force=true >/dev/null
else
  gh api -X POST "repos/$GH_REPO/git/refs" -f ref=refs/tags/deploy -f sha="$target" >/dev/null
fi
echo "Tag deploy -> ${target:0:12}. The server switches within 5 minutes, once it has no open intent, reconciling before it trades."
