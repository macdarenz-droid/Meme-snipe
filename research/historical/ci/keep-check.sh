#!/usr/bin/env bash
# DATA-KEEP: keeps the packaged assets of helius days alive in the actions cache, their
# only copy (DATA-PUB never publishes them), and the read progress of helius days (the
# newest data-rpc-DAY-RUN-ATTEMPT entry per day, so an unfinished day resumes instead of
# being read again). Called by .github/workflows/data-keep.yml.
#   keep-check.sh list
#       lists every default-branch cache entry data-rpc-assets-DAY-k<KID>-RUN-ATTEMPT (kind
#       assets) and, per day without an assets entry, the newest data-rpc-DAY-k<KID>-RUN-ATTEMPT
#       (kind progress; the -qa copies are not kept) from the cache API (read only) into $GITHUB_OUTPUT:
#       entries=<JSON list of {key, day, before, kind}> and count=N;
#       writes key, size and the total against 10 GB to the step summary (a warning above
#       7 GB). No entry: count=0, and the job does nothing else. OF-2 round 7, ruling 51:
#       only sealed entries (cache-crypt.sh) are kept; unsealed ones, 09-21's included,
#       are left to expire after 7 days unused.
#   keep-check.sh verify DAY DIR
#   keep-check.sh progress DAY DIR
#       checks a restored entry is a sealed one (cache-crypt.sh check: only progress.enc,
#       .iv, .kid and .mac) and not empty. Without the store token (this workflow has no
#       secret) its contents cannot be read; their MAC is checked when data-scan opens it.
#   keep-check.sh touched KEY BEFORE
#       proof that the restore refreshed the entry's 7-day clock: polls the cache API
#       until its last_accessed_at is later than BEFORE (the API refreshes about every
#       5 min), failing after KEEP_WAIT seconds (default 600).
# gh: GH_BIN (default gh), with GH_TOKEN and GITHUB_REPOSITORY.
set -euo pipefail
gh=${GH_BIN:-gh}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
cmd=${1:-}
shift || true
caches() { # every data-rpc-* entry of the default branch as "key<TAB>size<TAB>last_accessed_at<TAB>created_at", sorted
  # Only the default branch's entries: a scheduled run can restore those, and data-scan
  # saves there; an entry of another ref (a PR, a branch) is not ours to keep.
  local branch ref
  branch=$("$gh" api "repos/$GITHUB_REPOSITORY" --jq '.default_branch')
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ && "$branch" != null ]] || { echo "keep-check: unreadable default branch '$branch'" >&2; exit 1; }
  ref="refs/heads/$branch"
  "$gh" api --paginate "repos/$GITHUB_REPOSITORY/actions/caches?key=data-rpc-&per_page=100" \
    --jq '.actions_caches[] | select(.key | startswith("data-rpc-")) | select(.ref == "'"$ref"'") | [.key, (.size_in_bytes|tostring), .last_accessed_at, .created_at] | @tsv' | LC_ALL=C sort
}
case $cmd in
  list)
    rows=$(mktemp); trap 'rm -f "$rows"' EXIT
    caches > "$rows" || exit 1
    usage=$("$gh" api "repos/$GITHUB_REPOSITORY/actions/cache/usage" --jq '.active_caches_size_in_bytes')
    [[ "$usage" =~ ^[0-9]+$ ]] || { echo "keep-check: unreadable cache usage '$usage'" >&2; exit 1; }
    python3 - "$rows" "$usage" "$summary" "${GITHUB_OUTPUT:-/dev/null}" <<'PY'
import json, re, sys
rows, usage, summary, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
entries, lines, total, progress = [], [], 0, {}
for row in open(rows).read().splitlines():
    if not row.strip():
        continue
    key, size, before, created = row.split("\t")
    if key.startswith("data-rpc-assets-"):
        m = re.fullmatch(r"data-rpc-assets-(\d{4}-\d{2}-\d{2})-k[0-9a-f]{12}-\d+-\d+", key)
        if not m:
            continue  # unsealed (ruling 51): left to expire
        entries.append({"key": key, "day": m.group(1), "before": before, "kind": "assets"})
        total += int(size)
        lines.append(f"| `{key}` | assets | {int(size) / 1e9:.2f} GB |")
        continue
    m = re.fullmatch(r"data-rpc-(\d{4}-\d{2}-\d{2})-k[0-9a-f]{12}-\d+-\d+", key)
    if m and (m.group(1) not in progress or (created, key) > progress[m.group(1)][0]):
        progress[m.group(1)] = ((created, key), key, size, before)
assets_days = {e["day"] for e in entries}
for day in sorted(progress):
    if day in assets_days:
        continue  # a packaged day resumes nothing: its assets are kept, its progress is not
    _, key, size, before = progress[day]
    entries.append({"key": key, "day": day, "before": before, "kind": "progress"})
    total += int(size)
    lines.append(f"| `{key}` | progress | {int(size) / 1e9:.2f} GB |")
cap = 10e9
with open(summary, "a") as f:
    f.write("### Kept helius assets and progress (actions cache)\n\n")
    if entries:
        f.write("| key | kind | size |\n|---|---|---|\n" + "\n".join(lines) + "\n\n")
    f.write(f"{len(entries)} entries, {total / 1e9:.2f} GB; all repository caches {usage / 1e9:.2f} GB of 10 GB\n")
    if usage > 7e9:
        f.write("\n**Warning: repository caches above 7 GB; the least recently used entries are evicted at 10 GB.**\n")
if usage > 7e9:
    print(f"::warning::repository caches at {usage / 1e9:.2f} GB of 10 GB")
with open(out, "a") as f:
    f.write(f"entries={json.dumps(entries, separators=(',', ':'))}\ncount={len(entries)}\n")
print(f"keep-check: {len(entries)} entries")
PY
    ;;
  verify|progress)
    day=$1 dir=$2
    [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "keep-check: bad day $day" >&2; exit 1; }
    "$(dirname "$0")/cache-crypt.sh" check "$dir" || { echo "keep-check: the $cmd entry of $day is not a sealed one" >&2; exit 1; }
    size=$(stat -c %s "$dir/progress.enc")
    [ "$size" -gt 0 ] || { echo "keep-check: the $cmd entry of $day is empty" >&2; exit 1; }
    echo "| $day | $cmd: sealed, $size bytes |" | tee -a "$summary"
    ;;
  touched)
    key=$1 before=$2 waited=0
    while :; do
      now=$("$gh" api "repos/$GITHUB_REPOSITORY/actions/caches?key=$key" --jq ".actions_caches[] | select(.key == \"$key\") | .last_accessed_at")
      [ -n "$now" ] || { echo "keep-check: $key is no longer listed" >&2; exit 1; }
      if [[ "$now" > "$before" ]]; then
        echo "keep-check: $key last accessed $before -> $now: the restore refreshed it" | tee -a "$summary"
        exit 0
      fi
      if [ "$waited" -ge "${KEEP_WAIT:-600}" ]; then
        echo "keep-check: $key still last accessed $now after ${waited} s: the restore did not refresh its 7-day clock" | tee -a "$summary" >&2
        exit 1
      fi
      sleep "${KEEP_POLL:-60}"; waited=$(( waited + ${KEEP_POLL:-60} ))
    done
    ;;
  *) echo "usage: keep-check.sh list | verify DAY DIR | progress DAY DIR | touched KEY BEFORE" >&2; exit 2 ;;
esac
