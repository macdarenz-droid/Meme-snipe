#!/usr/bin/env bash
# Scans one UTC chain day on a single polite lane (used by .github/workflows/data-scan.yml).
#   scan-day.sh DAY OUT_DIR MAX_MBPS BUDGET   (BUDGET: minutes, or seconds as "Ns")
# On any 429 (or 503 with Retry-After) the scanner stops (exit 75), keeps every
# finished unit and persists the back-off end, max(1 h, largest Retry-After), in
# $OUT/archive-429.state. This script waits until then and resumes the same lane, until
# the day is done or the time budget runs out. The budget covers scanning and waiting:
# the scanner is interrupted at the budget's end (units are written atomically, so a
# unit cut off is redone later), and a back-off that does not fit is slept out as far
# as the budget allows. Either way it exits 75: progress is kept, the workflow saves it
# and the next chained run resumes. Any later run on the same directory sleeps out the
# back-off first.
# Every 429 and back-off is appended to $GITHUB_STEP_SUMMARY when set.
#   scan-day.sh --merge-state SRC DST
# copies back-off state SRC over DST when SRC's back-off ends later (or DST has none);
# the workflow uses it to share one back-off across days and runs.
set -uo pipefail
# state_end FILE: the back-off end (unix s) in a state file
# "<unix last 429> <retry-after s> <unix until>", or nothing.
state_end() { awk 'NF >= 3 && $3 ~ /^[0-9]+$/ {print $3; exit}' "$1" 2>/dev/null || true; }
if [ "${1:-}" = --merge-state ]; then
  [ $# -eq 3 ] || { echo "usage: scan-day.sh --merge-state SRC DST" >&2; exit 2; }
  s=$(state_end "$2") d=$(state_end "$3")
  [ -n "$s" ] || exit 0
  if [ -z "$d" ] || [ "$s" -gt "$d" ]; then
    mkdir -p "$(dirname "$3")" && cp "$2" "$3"
  fi
  exit 0
fi
day=$1 out=$2 mbps=$3 budget=$4
next=$(date -u -d "$day + 1 day" +%F)
start=$(date +%s)
case $budget in
  *s) budget_s=${budget%s} ;;
  *) budget_s=$(( budget * 60 )) ;;
esac
[[ "$budget_s" =~ ^[0-9]+$ ]] || { echo "bad budget '$budget'" >&2; exit 2; }
deadline=$(( start + budget_s ))
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
mkdir -p "$out"
# backoff MIN_S: wait until the back-off end in archive-429.state (format
# "<unix last 429> <retry-after s> <unix until>"), and at least MIN_S seconds. The wait
# counts against the budget: when it would not fit, exit 75 and keep progress.
backoff() {
  local min_s=$1 end wait_s left
  end=$(state_end "$out/archive-429.state")
  [ -n "$end" ] || end=0
  wait_s=$(( end - $(date +%s) ))
  [ "$wait_s" -lt "$min_s" ] && wait_s=$min_s
  [ "$wait_s" -le 0 ] && return 0
  # the wait plus at least 30 min of scanning must fit what is left of the budget
  left=$(( deadline - $(date +%s) ))
  if [ $(( wait_s + 1800 )) -ge "$left" ]; then
    # Sleep out what the budget allows, so a chained rerun starts closer to the end.
    local part=$(( left > 300 ? left - 300 : 0 ))
    echo "archive back-off of $(( (wait_s + 59) / 60 )) min does not fit the time budget ($(( left / 60 )) min left): waiting $(( part / 60 )) min of it, then stopping; progress kept for the next run" | tee -a "$summary"
    [ "$part" -gt 0 ] && sleep "$part"
    exit 75
  fi
  echo "$(date -u +%FT%TZ) archive back-off: waiting $(( (wait_s + 59) / 60 )) min, then resuming the same lane" | tee -a "$summary"
  sleep "$wait_s"
}
# Units restored from the cache that another scanner revision wrote are rescanned, so a
# day never mixes revisions (finalize refuses that). SCANNER_REVISION is the revision
# the workflow built into zeroed-scan; unset (local tests), nothing is dropped.
if [ -n "${SCANNER_REVISION:-}" ]; then
  for st in "$out"/units/*/*/stats.json; do
    [ -f "$st" ] || continue
    rev=$(sed -n 's/.*"scanner_revision": *"\([^"]*\)".*/\1/p' "$st" | head -1)
    if [ "$rev" != "$SCANNER_REVISION" ]; then
      echo "unit $(dirname "$st") was scanned by revision '$rev', not '$SCANNER_REVISION': rescanning it" | tee -a "$summary"
      rm -rf "$(dirname "$st")"
    fi
  done
fi
# A back-off persisted by an earlier run (restored from the cache) is slept out first.
backoff 0
while true; do
  left=$(( deadline - $(date +%s) ))
  if [ "$left" -le 0 ]; then
    echo "time budget reached before the day was scanned; progress kept for the next run" | tee -a "$summary"
    exit 75
  fi
  # Interrupted (SIGINT) at the budget's end; it finishes nothing new after that and
  # exits within 2 min, else it is killed (an unfinished unit is never renamed into place).
  timeout -s INT -k 120 "$left" zeroed-scan run -out "$out" -from "$day" -to "$next" -parallel 2 -dl 6 -workers 2 \
    -sample 0.05 -max-mbps "$mbps" -on-429 stop
  rc=$?
  if [ $(( deadline - $(date +%s) )) -le 0 ] && [ $rc -ne 0 ] && [ $rc -ne 75 ]; then
    echo "time budget reached while scanning (scanner exit $rc); progress kept for the next run" | tee -a "$summary"
    exit 75
  fi
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
  echo "$(date -u +%FT%TZ) archive answered 429" | tee -a "$summary"
  backoff 3600
done
