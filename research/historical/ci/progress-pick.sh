#!/usr/bin/env bash
# HISTORY-RESUME: picks the progress cache a scan resumes from, so progress never moves
# backwards. data-scan's restore used to take the newest entry under its key prefix; a
# run cancelled during its restore then saved a near-empty copy that shadowed the full
# one (09-21, run 37292410621). This picks the entry with the most data instead.
#   progress-pick.sh PREFIX
#       PREFIX is "data-rpc-DAY-" or "data-scan-DAY-". Lists the cache entries named
#       exactly PREFIX<run>-<attempt> on this run's ref (cache API, read only), and writes
#       key=<the largest by size; on a tie the newest> to $GITHUB_OUTPUT, or key= when
#       there is none. Units dominate an entry's size, so the largest holds the most
#       finished units. Any API error fails the step: nothing is read until it is known
#       which progress to resume from.
# gh: GH_BIN (default gh), with GH_TOKEN, GITHUB_REPOSITORY and GITHUB_REF.
set -euo pipefail
gh=${GH_BIN:-/usr/bin/gh}
prefix=$1
[[ "$prefix" =~ ^data-(rpc|scan)-[0-9]{4}-[0-9]{2}-[0-9]{2}-$ ]] || { echo "progress-pick: bad prefix '$prefix'" >&2; exit 2; }
: "${GITHUB_REF:?}"
rows=$(mktemp); trap 'rm -f "$rows"' EXIT
"$gh" api --paginate "repos/$GITHUB_REPOSITORY/actions/caches?key=$prefix&ref=$GITHUB_REF&per_page=100" \
  --jq '.actions_caches[] | [.key, (.size_in_bytes|tostring), .created_at, .ref] | @tsv' > "$rows"
key=$(python3 - "$prefix" "$GITHUB_REF" "$rows" <<'PY'
import re, sys
prefix, ref, rows = sys.argv[1], sys.argv[2], sys.argv[3]
best = None
for row in open(rows).read().splitlines():
    if not row.strip():
        continue
    key, size, created, r = row.split("\t")
    if r != ref or not re.fullmatch(re.escape(prefix) + r"\d+-\d+", key):
        continue
    cand = (int(size), created, key)
    best = cand if best is None or cand > best else best
print(best[2] if best else "")
PY
)
echo "key=$key" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "progress-pick: resuming from ${key:-nothing (no saved progress)}" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
