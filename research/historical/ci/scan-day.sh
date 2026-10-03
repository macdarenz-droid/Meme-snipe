#!/usr/bin/env bash
# Scans one UTC chain day on a single polite lane (used by .github/workflows/data-scan.yml).
#   scan-day.sh DAY OUT_DIR MAX_MBPS BUDGET_MINUTES
# On any 429 (or 503 with Retry-After) the scanner stops (exit 75), keeps every
# finished unit and persists the back-off end, max(1 h, largest Retry-After), in
# $OUT/archive-429.state. This script waits until then and resumes the same lane, until
# the day is done or the time budget runs out (exit 75, so the workflow saves progress
# and stops). Any later run on the same directory sleeps out the back-off first.
# Every 429 and back-off is appended to $GITHUB_STEP_SUMMARY when set.
set -uo pipefail
day=$1 out=$2 mbps=$3 budget=$4
next=$(date -u -d "$day + 1 day" +%F)
start=$(date +%s)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
mkdir -p "$out"
while true; do
  zeroed-scan run -out "$out" -from "$day" -to "$next" -parallel 2 -dl 6 -workers 2 \
    -sample 0.05 -max-mbps "$mbps" -on-429 stop
  rc=$?
  if [ -f "$out/429.log" ]; then
    { echo "### 429 log ($day)"; echo '```'; cat "$out/429.log"; echo '```'; } >> "$summary"
    mv "$out/429.log" "$out/429-$(date -u +%Y%m%dT%H%M%S).log"
  fi
  if [ $rc -eq 0 ]; then
    echo "day $day scanned" | tee -a "$summary"
    exit 0
  fi
  if [ $rc -ne 75 ]; then
    echo "scanner failed with exit $rc" | tee -a "$summary"
    exit $rc
  fi
  until=$(awk '{print $3}' "$out/archive-429.state" 2>/dev/null || echo 0)
  wait_s=$(( ${until:-0} - $(date +%s) ))
  [ "$wait_s" -lt 3600 ] && wait_s=3600
  elapsed=$(( ($(date +%s) - start) / 60 ))
  if [ $(( elapsed + wait_s / 60 + 30 )) -ge "$budget" ]; then
    echo "archive answered 429; time budget used ($elapsed of $budget min); progress kept for the next run" | tee -a "$summary"
    exit 75
  fi
  echo "$(date -u +%FT%TZ) archive answered 429: backing off $((wait_s / 60)) min, then resuming the same lane" | tee -a "$summary"
  sleep "$wait_s"
done
