#!/usr/bin/env bash
# HISTORY-RESUME: picks the progress cache a scan resumes from, so progress never moves
# backwards. data-scan's restore used to take the newest entry under its key prefix; a
# run cancelled during its restore then saved a near-empty copy that shadowed the full
# one (09-21, run 37292410621). This picks the entry with the most data instead.
#   progress-pick.sh PREFIX
#       PREFIX is "data-rpc-DAY-" or "data-scan-DAY-"; KID (env) is this run's cache key id
#       (cache-crypt.sh kid). Lists the cache entries named PREFIXk<KID>-<run>-<attempt> and
#       PREFIXk<KID>-<run>-<attempt>-qa on this run's ref (cache API,
#       read only). Within one run and attempt the -qa save wins: it is the later save of
#       the same units and holds the QA rescan's booked credits (its compressed size can
#       be a few bytes smaller). Across runs it picks the largest (units dominate an
#       entry's size); sizes within 0.5 % count as equal and the newest wins. Writes key=<pick> to $GITHUB_OUTPUT, or key= when
#       there is none. Only names, sizes and dates are visible to it. Any API error fails
#       the step: nothing is read until it is known which progress to resume from.
#       OF-2 round 6, ruling 44a: an entry of this day sealed with another key id, or saved
#       unsealed (the old PREFIX<run>-<attempt> names), refuses (exit 2): the day never
#       starts fresh beside a progress it cannot open.
# gh: GH_BIN (default gh), with GH_TOKEN, GITHUB_REPOSITORY and GITHUB_REF.
set -euo pipefail
gh=${GH_BIN:-/usr/bin/gh}
prefix=$1
[[ "$prefix" =~ ^data-(rpc|scan)-[0-9]{4}-[0-9]{2}-[0-9]{2}-$ ]] || { echo "progress-pick: bad prefix '$prefix'" >&2; exit 2; }
[[ "${KID:-}" =~ ^[0-9a-f]{12}$ ]] || { echo "progress-pick: no cache key id (KID)" >&2; exit 2; }
: "${GITHUB_REF:?}"
rows=$(mktemp); trap 'rm -f "$rows"' EXIT
"$gh" api --paginate "repos/$GITHUB_REPOSITORY/actions/caches?key=$prefix&ref=$GITHUB_REF&per_page=100" \
  --jq '.actions_caches[] | [.key, (.size_in_bytes|tostring), .created_at, .ref] | @tsv' > "$rows"
key=$(python3 - "$prefix" "$GITHUB_REF" "$rows" "$KID" <<'PY'
import re, sys
prefix, ref, rows, kid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
runs = {}  # (run, attempt) -> (is_qa, size, created, key); -qa wins within a run
for row in open(rows).read().splitlines():
    if not row.strip():
        continue
    key, size, created, r = row.split("\t")
    if r != ref:
        continue
    other = re.fullmatch(re.escape(prefix) + r"(?:k([0-9a-f]{12})-)?\d+-\d+(?:-qa)?", key)
    if other and other.group(1) != kid:
        print("REFUSE " + key)
        sys.exit(0)
    m = re.fullmatch(re.escape(prefix) + "k" + kid + r"-(\d+)-(\d+)(-qa)?", key)
    if not m:
        continue
    cand = (m.group(3) is not None, int(size), created, key)
    run = (m.group(1), m.group(2))
    if run not in runs or cand > runs[run]:
        runs[run] = cand
# Newest first; an older run replaces the pick only when clearly larger (> 0.5 %, well
# under one unit's ~1.4 % of a day's progress): equal units with a few bytes of
# compression noise keep the newer save, which booked at least as many credits.
best = None
for c in sorted(runs.values(), key=lambda c: (c[2], c[3]), reverse=True):
    if best is None or c[1] > best[1] * 1.005:
        best = c
print(best[3] if best else "")
PY
)
if [[ "$key" == "REFUSE "* ]]; then
  echo "progress-pick: refused: progress ${key#REFUSE } of this day is sealed with another key or not sealed; nothing is read and the day does not start fresh (OF-2 ruling 44a)" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2
  exit 2
fi
echo "key=$key" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "progress-pick: resuming from ${key:-nothing (no saved progress)}" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
