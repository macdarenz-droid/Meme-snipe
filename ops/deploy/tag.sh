#!/usr/bin/env bash
# Deploy workflow, code update. Moves the "deploy" tag to the newest commit on the integration branch
# (first-parent history of GITHUB_SHA) that GitHub itself signed: a pull-request merge, signed with GitHub's
# web-flow key. Commits pushed straight to the branch (board updates) are skipped. The host runs the same two checks before it switches (ops/host/files/usr/local/sbin/zeroed-update).
# Inputs: GH_REPO, GITHUB_SHA, INTEGRATION_BRANCH; run from a full-history checkout.
set -euo pipefail
: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${INTEGRATION_BRANCH:?}"
FPR=968479A1AFF927E37D1A566BB5690EEEBB952194
here="$(cd "$(dirname "$0")" && pwd)"

export GNUPGHOME="$(mktemp -d)"
gpg --batch --quiet --import "$here/../host/files/etc/zeroed/github-web-flow.asc" 2>/dev/null
signed_by_github() {
  local status signer
  status="$(git verify-commit --raw "$1" 2>&1 || true)"
  signer="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $NF; exit }')"
  [ "$signer" = "$FPR" ] && printf '%s\n' "$status" | grep -q '^\[GNUPG:\] GOODSIG '
}
git fetch --quiet origin "+refs/heads/$INTEGRATION_BRANCH:refs/remotes/origin/$INTEGRATION_BRANCH"
git merge-base --is-ancestor "$GITHUB_SHA" "refs/remotes/origin/$INTEGRATION_BRANCH" || {
  echo "Not deployable: run Deploy from $INTEGRATION_BRANCH." >&2
  exit 1
}
target=""
for c in $(git rev-list --first-parent --max-count=200 "$GITHUB_SHA"); do
  if signed_by_github "$c"; then target="$c"; break; fi
done
[ -n "$target" ] || { echo "Not deployable: no commit GitHub signed (a pull-request merge) in the last 200 on $INTEGRATION_BRANCH." >&2; exit 1; }
[ "$target" = "$GITHUB_SHA" ] || echo "Newest merge: ${target:0:12} (later commits are direct pushes, not deployed)."

if out="$(gh api "repos/$GH_REPO/git/ref/tags/deploy" --jq .object.sha 2>/dev/null)" && [[ "$out" =~ ^[0-9a-f]{40}$ ]]; then
  [ "$out" = "$target" ] || gh api -X PATCH "repos/$GH_REPO/git/refs/tags/deploy" -f sha="$target" -F force=true >/dev/null
else
  gh api -X POST "repos/$GH_REPO/git/refs" -f ref=refs/tags/deploy -f sha="$target" >/dev/null
fi
echo "Tag deploy -> ${target:0:12}. The host switches within 5 minutes, reconciling before it trades."
