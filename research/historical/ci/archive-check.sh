#!/usr/bin/env bash
# ARCHIVE-CHECK (owner decision, 2026-10-04): every 3 hours, ask the Old Faithful
# archive once whether it serves our scanner again, and if it does, dispatch the next
# scan batch. Run by .github/workflows/archive-check.yml.
#
#   - While a data-scan run is active or queued, it does nothing (no request at all).
#   - Otherwise it makes ONE request: a range GET of 64 bytes with the scanner's own
#     User-Agent (read from scanner/archive.go), from the runner. Never another agent,
#     host, address, proxy or client: that would be getting around the block, which
#     Triton's terms bar.
#   - Any answer but 206 (or a 200 of at most 64 bytes) is logged (status, cf-ray, time)
#     and the check stops until the next one. No retries.
#   - On success it dispatches data-scan.yml (mode scan, max_mbps 80) for the next 8
#     unpublished days: pre-holdout days from 2026-09-21 back to 2026-07-20 first (run
#     1's days lead), then the holdout days 2026-10-01 back to 2026-09-22. The scan
#     keeps its own limits: one job, at most 80 MB/s and 40 requests/s, stop on any 429
#     with a back-off of at least 1 h.
#
# Env: GH_REPO (owner/repo), REF (branch to dispatch on), GH_TOKEN for gh;
# GH_BIN and CURL_BIN override the tools (tests).
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

active=$("$gh" run list --repo "$GH_REPO" --workflow data-scan.yml --limit 50 --json status \
  --jq '[.[] | select(.status != "completed")] | length')
if [[ "$active" != "0" ]]; then
  echo "archive-check $(date -u +%FT%TZ): $active data-scan run(s) active or queued; no request made" | tee -a "$summary"
  exit 0
fi

hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
rc=0
# -r 0-63 asks for 64 bytes; --max-filesize refuses any body the server announces as
# larger (a server ignoring the range), so a 200 never streams the file.
code=$("$curl" -sS -o /dev/null -D "$hdr" -w '%{http_code}' --max-time 30 --max-filesize 64 \
  -A "$ua" -r 0-63 "$url") || rc=$?
ray=$(tr -d '\r' < "$hdr" | sed -n 's/^[Cc][Ff]-[Rr][Aa][Yy]: *//p' | tail -1)
now=$(date -u +%FT%TZ)
{
  echo "| time (UTC) | status | curl exit | cf-ray |"
  echo "|---|---|---|---|"
  echo "| $now | ${code:-none} | $rc | ${ray:-none} |"
} >> "$summary"
echo "archive-check $now: status ${code:-none}, curl exit $rc, cf-ray ${ray:-none}"
if ! [[ "$code" == 206 && $rc == 0 ]] && ! [[ "$code" == 200 && $rc == 0 ]]; then
  echo "archive-check: not served; nothing dispatched until the next check" | tee -a "$summary"
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
