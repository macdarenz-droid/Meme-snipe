#!/usr/bin/env bash
# CACHE-FORGET (OF-4 ruling 1, docs/reviews/OF4.md): after a day is stored in the private
# store and every file read back, data-scan.yml's forget job (actions: write, nothing else
# but a checkout; it runs no archive or scanner code) deletes that day's sealed progress
# cache entries: every key that starts with PREFIX = data-scan-DAY-k<key id>- (progress,
# -qa and -logs entries, any run or attempt). Nothing else is deleted. The job runs only
# when the scan job's read-back output passed, so a read-back mismatch keeps the entry.
#   cache-forget.sh PREFIX
# Env: GH_TOKEN, GH_REPO. GH_BIN is for tests only.
set -euo pipefail
gh=${GH_BIN:-gh}
prefix=${1:-}
[[ "$prefix" =~ ^data-scan-[0-9]{4}-[0-9]{2}-[0-9]{2}-k[0-9a-f]{12}-$ ]] || { echo "refused: '$prefix' is not a stored day's progress prefix (data-scan-DAY-k<key id>-)"; exit 2; }
: "${GH_REPO:?}"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
rows=$("$gh" api --paginate "repos/$GH_REPO/actions/caches?key=$prefix&per_page=100" --jq '.actions_caches[] | [.id, .key] | @tsv') ||
  { echo "the cache list cannot be read; nothing deleted" | tee -a "$summary"; exit 1; }
n=0
while IFS=$'\t' read -r id key; do
  [[ -n "$id" ]] || continue
  [[ "$id" =~ ^[0-9]+$ && "$key" == "$prefix"* ]] || continue
  "$gh" api -X DELETE "repos/$GH_REPO/actions/caches/$id" >/dev/null
  n=$((n + 1))
done <<< "$rows"
echo "deleted $n progress cache entries of ${prefix%-} (stored and read back)" | tee -a "$summary"
