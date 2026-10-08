#!/usr/bin/env bash
# OF-2 ruling 12 (c): lists the branches of this repository whose data-scan.yml can read
# the Old Faithful archive without research/historical/ci/archive-guard.sh (an old copy that
# runs scan-day.sh or zeroed-scan run, and never names the guard). Read only: it lists and
# reads files through the GitHub API, and never deletes, edits or dispatches anything. At
# arm time the supervisor puts the list to the owner with a recommendation; no agent deletes
# a branch.
#   unguarded-refs.sh            prints one branch a line, then a count to stderr
# Env: GH_REPO (owner/repo), GH_TOKEN; GH_BIN is for tests only.
set -euo pipefail
gh=${GH_BIN:-gh}
: "${GH_REPO:?}"
branches=$("$gh" api --paginate "repos/$GH_REPO/branches?per_page=100" --jq '.[].name')
n=0 found=0
while read -r b; do
  [[ -n "$b" ]] || continue
  n=$((n + 1))
  err=$(mktemp)
  if ! content=$("$gh" api "repos/$GH_REPO/contents/.github/workflows/data-scan.yml?ref=$b" --jq '.content' 2>"$err"); then
    if grep -q "HTTP 404" "$err"; then rm -f "$err"; continue; fi
    echo "unguarded-refs: $b: $(tr '\n' ' ' < "$err")" >&2; rm -f "$err"; exit 1
  fi
  rm -f "$err"
  wf=$(base64 -d <<< "$content")
  if grep -qE 'scan-day\.sh|zeroed-scan run' <<< "$wf" && ! grep -q 'archive-guard\.sh' <<< "$wf"; then
    echo "$b"; found=$((found + 1))
  fi
done <<< "$branches"
echo "unguarded-refs: $found of $n branches carry a data-scan.yml that reads the archive without archive-guard.sh" >&2
