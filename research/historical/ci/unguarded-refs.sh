#!/usr/bin/env bash
# OF-2 ruling 12 (c), round 4 ruling 29: lists the branches of this repository that can
# read the Old Faithful archive without research/historical/ci/archive-guard.sh: a
# data-scan.yml that runs scan-day.sh or zeroed-scan run and never names the guard, or an
# archive-check.yml whose archive-check.sh (on the same branch) never sources the guard, or
# that probes the archive itself. Read only: it lists and reads files through the GitHub
# API, and never deletes, edits or dispatches anything. At arm time the supervisor puts the
# list to the owner with a recommendation; no agent deletes a branch.
#   unguarded-refs.sh            prints one branch ("NAME") or tag ("tag NAME") a line, then
#                                a count to stderr
# Env: GH_REPO (owner/repo), GH_TOKEN; GH_BIN is for tests only.
set -euo pipefail
gh=${GH_BIN:-gh}
: "${GH_REPO:?}"
branches=$("$gh" api --paginate "repos/$GH_REPO/branches?per_page=100" --jq '.[].name')
# Round 4, ruling 37: tags too (a workflow can be dispatched on a tag); printed "tag NAME".
# No agent deletes or moves a tag: the supervisor puts each one to the owner at arm time.
tags=$("$gh" api --paginate "repos/$GH_REPO/tags?per_page=100" --jq '.[].name' | sed 's/^/tag /')
n=0 found=0
# file BRANCH PATH: the file's text on BRANCH; exit 3 when it is not there (404).
file() {
  local err content
  err=$(mktemp)
  if ! content=$("$gh" api "repos/$GH_REPO/contents/$2?ref=$1" --jq '.content' 2>"$err"); then
    if grep -q "HTTP 404" "$err"; then rm -f "$err"; return 3; fi
    echo "unguarded-refs: $1: $2: $(tr '\n' ' ' < "$err")" >&2; rm -f "$err"; exit 1
  fi
  rm -f "$err"
  base64 -d <<< "$content"
}
while read -r line; do
  [[ -n "$line" ]] || continue
  # Round 6, ruling 48: refs/tags/NAME and refs/heads/NAME, so a tag and a branch of one
  # name are each checked.
  if [[ "$line" == "tag "* ]]; then b=refs/tags/${line#tag }; else b=refs/heads/$line; fi
  n=$((n + 1))
  unguarded=0
  rc=0; wf=$(file "$b" .github/workflows/data-scan.yml) || rc=$?
  if (( rc == 0 )) && grep -qE 'scan-day\.sh|zeroed-scan run' <<< "$wf" && ! grep -q 'archive-guard\.sh' <<< "$wf"; then unguarded=1; fi
  (( rc == 0 || rc == 3 )) || exit 1
  rc=0; wf=$(file "$b" .github/workflows/archive-check.yml) || rc=$?
  if (( rc == 0 )); then
    rc=0; sh=$(file "$b" research/historical/ci/archive-check.sh) || rc=$?
    (( rc == 0 || rc == 3 )) || exit 1
    if grep -qE 'old-faithful|curl' <<< "$wf" || ! grep -q 'archive-check\.sh' <<< "$wf" || (( rc == 3 )) ||
       ! grep -qE '^[[:space:]]*\.[[:space:]]+"\$here/archive-guard\.sh"' <<< "$sh"; then unguarded=1; fi
  elif (( rc != 3 )); then exit 1; fi
  if (( unguarded )); then echo "$line"; found=$((found + 1)); fi
done <<< "$branches"$'\n'"$tags"
echo "unguarded-refs: $found of $n branches and tags carry a data-scan.yml or archive-check.yml that reads the archive without archive-guard.sh" >&2
