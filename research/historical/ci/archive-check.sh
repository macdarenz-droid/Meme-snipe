#!/usr/bin/env bash
# ARCHIVE-CHECK (owner decision, 2026-10-04): every 3 hours, ask the Old Faithful
# archive once whether it serves our scanner again, and if it does, dispatch the next
# scan batch. Run by .github/workflows/archive-check.yml.
#
#   - While a data-scan run that may read the archive is active or queued, it does
#     nothing (no request at all). A run counts as Helius-only (source helius, which
#     never touches the archive) only when its title, set by data-scan.yml's run-name,
#     is exactly "data-scan scan source=helius"; any other title (the archive source,
#     a run dispatched before run-name existed, anything unexpected) counts as archive,
#     unless its id is in HELIUS_RUNS (a manual dispatch input, digits and commas only,
#     for Helius runs dispatched before run-name; scheduled checks never set it).
#   - A served answer dispatches a scan only while no data-scan run at all is active or
#     queued: one lane (data-scan's concurrency group "data-scan"), and a new dispatch
#     must never replace a pending chained run of a Helius day.
#   - Otherwise it makes ONE request: a range GET of 64 bytes with the scanner's own
#     User-Agent (read from scanner/archive.go), from the runner. Never another agent,
#     host, address, proxy or client: that would be getting around the block, which
#     Triton's terms bar.
#   - Any answer but a 206 of at most 64 bytes is logged (status, bytes, cf-ray, time)
#     and the check stops until the next one. No retries. No answer can stream: the
#     body is cut after 65 bytes, which aborts the transfer.
#   - On success it dispatches data-scan.yml (mode scan, max_mbps 80) for the next 8
#     unpublished days: pre-holdout days from 2026-09-21 back to 2026-07-20 first (run
#     1's days lead), then the holdout days 2026-10-01 back to 2026-09-22. The scan
#     keeps its own limits: one job, at most 80 MB/s and 40 requests/s, stop on any 429
#     with a back-off of at least 1 h.
#
# Env: GH_REPO (owner/repo), REF (branch to dispatch on), GH_TOKEN for gh;
# GH_BIN, CURL_BIN and ARCHIVE_CHECK_URL (a local fake server) are for tests only; the
# workflow sets none of them (test-ci.sh checks).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
gh=${GH_BIN:-gh}
curl=${CURL_BIN:-curl}
: "${GH_REPO:?}" "${REF:?}"
summary=${GITHUB_STEP_SUMMARY:-/dev/stderr}
url="https://files.old-faithful.net/1047/epoch-1047.car"

ua=$(sed -n 's/^const userAgent = "\(.*\)"$/\1/p' "$here/../scanner/archive.go")
if [[ -z "$ua" || "$ua" != zeroed-historical-scanner/* ]]; then
  echo "archive-check: the scanner's User-Agent was not found in archive.go" | tee -a "$summary"
  exit 1
fi

named=${HELIUS_RUNS:-}
if [[ -n "$named" && ! "$named" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "archive-check: helius_runs must be run ids separated by commas, got '$named'; no request made" | tee -a "$summary"
  exit 1
fi
runs=$("$gh" run list --repo "$GH_REPO" --workflow data-scan.yml --limit 50 --json databaseId,status,displayTitle \
  --jq '.[] | select(.status != "completed") | "\(.databaseId)\t\(.displayTitle)"')
active=0 archive=0
while IFS=$'\t' read -r id title; do
  [[ -n "$id" ]] || continue
  active=$(( active + 1 ))
  if [[ "$title" == "data-scan scan source=helius" || ",$named," == *",$id,"* ]]; then continue; fi
  archive=$(( archive + 1 ))
done <<< "$runs"
if (( archive > 0 )); then
  echo "archive-check $(date -u +%FT%TZ): $archive data-scan run(s) that may read the archive active or queued; no request made" | tee -a "$summary"
  exit 0
fi

hdr=$(mktemp)
body=$(mktemp)
# -r 0-63 asks for 64 bytes. Whatever the server sends (a 200 ignoring the range, a
# chunked stream with no length), the body goes through `head -c 65`, which exits
# after 65 bytes and so aborts curl's transfer; --max-filesize also refuses an
# announced larger body, and --limit-rate keeps curl's reads small. Only a 206 of at
# most 64 bytes counts as served.
rcf=$(mktemp)
trap 'rm -f "$hdr" "$body" "$rcf"' EXIT
# The left side of a pipe runs in a subshell, so curl's exit code goes through a file.
{ rc=0; "$curl" -sS -D "$hdr" -o - --max-time 30 --max-filesize 64 --limit-rate 2k \
    -A "$ua" -r 0-63 "${ARCHIVE_CHECK_URL:-$url}" || rc=$?; echo "$rc" > "$rcf"; } | head -c 65 > "$body" || true
rc=$(cat "$rcf")
[[ -n "$rc" ]] || rc=141 # killed by the pipe closing: the body ran past 65 bytes
code=$(tr -d '\r' < "$hdr" | awk '/^HTTP\//{c=$2} END{print c}')
got=$(wc -c < "$body")
ray=$(tr -d '\r' < "$hdr" | sed -n 's/^[Cc][Ff]-[Rr][Aa][Yy]: *//p' | tail -1)
now=$(date -u +%FT%TZ)
{
  echo "| time (UTC) | status | bytes | curl exit | cf-ray |"
  echo "|---|---|---|---|---|"
  echo "| $now | ${code:-none} | $got | $rc | ${ray:-none} |"
} >> "$summary"
echo "archive-check $now: status ${code:-none}, $got bytes, curl exit $rc, cf-ray ${ray:-none}"
if ! [[ "$code" == 206 && $rc == 0 && $got -le 64 ]]; then
  echo "archive-check: not served; nothing dispatched until the next check" | tee -a "$summary"
  exit 0
fi
if (( active > 0 )); then
  echo "archive-check: served; nothing dispatched while $active Helius data-scan run(s) are active or queued (one lane; the next check dispatches once they end)" | tee -a "$summary"
  exit 0
fi

# The queue: pre-holdout days newest first, then the holdout days newest first.
queue=()
d=2026-09-21
while [[ "$d" > 2026-07-19 ]]; do queue+=("$d"); d=$(date -u -d "$d - 1 day" +%F); done
d=2026-10-01
while [[ "$d" > 2026-09-21 ]]; do queue+=("$d"); d=$(date -u -d "$d - 1 day" +%F); done

batch=()
for d in "${queue[@]}"; do
  # A day with a release is published (data-scan's own check judges completeness).
  if "$gh" api "repos/$GH_REPO/releases/tags/data-day-$d" --silent >/dev/null 2>&1; then
    continue
  fi
  batch+=("$d")
  (( ${#batch[@]} == 8 )) && break
done
if (( ${#batch[@]} == 0 )); then
  echo "archive-check: served, and every day of the window is published; nothing to dispatch" | tee -a "$summary"
  exit 0
fi
days=$(IFS=,; echo "${batch[*]}")
"$gh" workflow run data-scan.yml --repo "$GH_REPO" --ref "$REF" -f mode=scan -f days="$days" -f max_mbps=80
echo "archive-check: served; dispatched data-scan for $days" | tee -a "$summary"
