#!/usr/bin/env bash
# Scans one UTC chain day on a single polite lane (used by .github/workflows/data-scan.yml).
#   scan-day.sh DAY OUT_DIR MAX_MBPS BUDGET   (BUDGET: minutes, or seconds as "Ns")
# Limits come from archive-limits.conf (ARCHIVE-SAFE): MAX_MBPS above ARCHIVE_MAX_MBPS
# is refused; ARCHIVE_PARALLEL x ARCHIVE_DL connections at most. Before any request the
# day must pass archive-guard.sh entry (OF-2): allow-listed, armed, a retention value,
# and a fresh pass of the job's guard step (ARCHIVE_GUARD_DIR).
# On any 429 (or 503 with Retry-After) the scanner stops (exit 75) and keeps every
# finished unit. This script then persists a back-off of at least ARCHIVE_BACKOFF_S
# (3 h; more if the scanner's Retry-After asks for more) in $OUT/archive-429.state and
# exits 4: not resumable, so no chained run resumes the archive by itself; only a later
# served archive-check dispatches the day again, and that run sleeps out what is left of
# the back-off first. The time budget covers scanning and waiting: the scanner is
# interrupted at the budget's end (units are written atomically, so a unit cut off is
# redone later) and the script exits 75 (resumable: progress is kept, the workflow saves
# it and the next chained run resumes); a restored back-off that does not fit is slept
# out as far as the budget allows, then exit 75.
# Every 429 and back-off is appended to $GITHUB_STEP_SUMMARY when set.
#   scan-day.sh --merge-state SRC DST
# copies back-off state SRC over DST when SRC's back-off ends later (or DST has none);
# the workflow uses it to share one back-off across days and runs.
set -uo pipefail
# state_end FILE: the back-off end (unix s) in a state file
# "<unix last 429> <retry-after s> <unix until>", or nothing.
state_end() { awk 'NF >= 3 && $3 ~ /^[0-9]+$/ {print $3; exit}' "$1" 2>/dev/null || true; }
# hold_back FILE MIN_S: the back-off in FILE ends no sooner than now + MIN_S.
hold_back() {
  local now end want
  now=$(date +%s) end=$(state_end "$1") want=$(( $(date +%s) + $2 ))
  if [ -z "$end" ] || [ "$end" -lt "$want" ]; then
    echo "$now $2 $want" > "$1"
  fi
}
# rps_cap FILE: the scanner's request cap (the literal "var reqLimiter = newLimiter(N)"
# in scanner/archive.go), or nothing. rps_ok FILE: it is above 0 and at most
# ARCHIVE_MAX_RPS (archive-limits.conf). Shared with check-day.sh and archive-check.sh.
rps_cap() { sed -n 's/^var reqLimiter = newLimiter(\([0-9.]*\))$/\1/p' "$1" 2>/dev/null | head -1; }
rps_ok() {
  local cap max
  cap=$(rps_cap "$1")
  max=$(. "$(dirname "$0")/archive-limits.conf" && echo "$ARCHIVE_MAX_RPS")
  awk -v c="$cap" -v m="$max" 'BEGIN { exit !(c + 0 > 0 && c + 0 <= m + 0) }'
}
if [ "${1:-}" = --rps-ok ]; then
  [ $# -eq 2 ] || { echo "usage: scan-day.sh --rps-ok ARCHIVE_GO" >&2; exit 2; }
  cap=$(rps_cap "$2"); echo "${cap:-not found}"
  rps_ok "$2"; exit $?
fi
if [ "${1:-}" = --hold ]; then
  [ $# -eq 3 ] || { echo "usage: scan-day.sh --hold FILE MIN_S" >&2; exit 2; }
  mkdir -p "$(dirname "$2")" && hold_back "$2" "$3"
  exit 0
fi
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
# shellcheck source=archive-limits.conf
. "$(dirname "$0")/archive-limits.conf"
awk -v m="$mbps" -v c="$ARCHIVE_MAX_MBPS" 'BEGIN { exit !(m + 0 > 0 && m + 0 <= c + 0) }' ||
  { echo "refused: max_mbps $mbps is not in (0, $ARCHIVE_MAX_MBPS] (archive-limits.conf)" >&2; exit 2; }
archive_go=${ARCHIVE_GO:-$(dirname "$0")/../scanner/archive.go}
rps_ok "$archive_go" ||
  { echo "refused: the scanner's request cap ($(rps_cap "$archive_go" || true)/s, scanner/archive.go) is not in (0, $ARCHIVE_MAX_RPS] (archive-limits.conf)" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2; exit 2; }
# ARCHIVE-NODUP: a Helius day is never read from the archive.
[[ " $HELIUS_DAYS " == *" $day "* ]] &&
  { echo "refused: $day is a Helius day (HELIUS_DAYS in archive-limits.conf); it is never read from the archive" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2; exit 2; }
# OF-2 (archive-guard.sh entry): the day is allow-listed, the chain is armed, the day has
# a retention value, and the job's guard step passed it (store readable, no storage-stop
# marker, the 3-failure stop not active). Otherwise nothing is read.
cfg_ret=$("$(dirname "$0")/archive-guard.sh" entry "$day") || exit 2
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
# OF-3 (P2): the scanner revision is frozen for the batches. A unit restored from the
# cache that another revision wrote is refused, never read again: exit 2 before any
# request (a day never mixes revisions, and finalize refuses that too). The workflow
# always sets SCANNER_REVISION (the revision built into zeroed-scan); it is required.
[ -n "${SCANNER_REVISION:-}" ] || { echo "refused: SCANNER_REVISION is not set" | tee -a "$summary" >&2; exit 2; }
for st in "$out"/units/*/*/stats.json; do
  [ -f "$st" ] || continue
  rev=$(sed -n 's/.*"scanner_revision": *"\([^"]*\)".*/\1/p' "$st" | head -1)
  if [ "$rev" != "$SCANNER_REVISION" ]; then
    echo "refused: unit $(dirname "$st") was scanned by revision '$rev', not '$SCANNER_REVISION'; a unit of another revision is never read again" | tee -a "$summary" >&2
    exit 2
  fi
done
# OF-3 ruling 2 (docs/reviews/OF3.md): every day is read at K2. A day whose retention is
# K3 (cfg_ret) is trimmed to K3 by trim-day.sh after the whole day is read, before it is
# stored; units already kept must be K2 (a trimmed day is never read again here).
rec=$("$(dirname "$0")/archive-guard.sh" recorded "$out") || exit 2
if [ "$rec" = K3 ]; then
  # Ruling 9: a restored day already trimmed is read done when every unit is K3, its
  # per-unit log is present and checks, and expect_units (if set) is met: no request,
  # trim-day.sh then does nothing and check-day.sh runs. Anything else is refused.
  units=$(find "$out/units" -mindepth 2 -maxdepth 2 -type d ! -name '*.tmp' 2>/dev/null | wc -l)
  slog="$out/logs"; mkdir -p "$slog"
  if [ -f "$out/units.log" ] && zeroed-scan unitlog -out "$out" -check "$out/units.log" > "$slog/unitlog.log" 2>&1 &&
     { [ -z "${EXPECT_UNITS:-}" ] || [ "$units" -ge "$EXPECT_UNITS" ]; }; then
    echo "day $day is already read and trimmed ($units K3 units, per-unit log checked); no request" | tee -a "$summary"
    exit 0
  fi
  echo "refused: the units of $day record retention K3 but the day is not a complete trimmed day (per-unit log, check or expect_units); it is never read again here" | tee -a "$summary" >&2
  exit 2
fi
[ -z "$rec" ] || [ "$rec" = K2 ] ||
  { echo "refused: the units of $day record retention $rec; a day is read at K2 and trimmed once" | tee -a "$summary" >&2; exit 2; }
# Ruling 8 (and 11): every day but the first allow-listed one needs the day before's
# verified list (a K3 day to be trimmed, a K2 day for its own list-D.txt); without it
# nothing is read (before the disk guard, the back-off and any scanner call).
if [ "$day" != "$(. "$(dirname "$0")/archive-guard.sh"; ag_first_day)" ]; then
  "$(dirname "$0")/archive-guard.sh" prior "$day" "${ARCHIVE_PRIOR_LIST:-}" "${ARCHIVE_PRIOR_SUMS:-}" || exit 2
fi
ret=K2
echo "retention for $day: read at K2, stored as $cfg_ret" | tee -a "$summary"
# Ruling 3: the K2 day's peak must fit before any archive read (ARCHIVE_K2_PEAK_BYTES).
"$(dirname "$0")/disk-guard.sh" "$out" "$ARCHIVE_K2_PEAK_BYTES" "a K2 day (units at the high estimate, then its trim and QA)" || exit 2
# Ruling 14: while the day is read, between units, free space must stay above the
# largest unit so far + ARCHIVE_TRIM_HEADROOM_BYTES; otherwise the scan is interrupted
# (SIGINT: units are written whole) and the day fails with exit 1 (OF-3 ruling 20: not
# resumable; the chain holds for a decision).
# The scan runs in the foreground (SIGINT reaches it); the watch, in the background,
# signals the scan's `timeout` the way the budget does.
disk_watch() {
  local parent=$1 pid big avail
  while true; do
    pid=$(pgrep -P "$parent" -x timeout | head -1)
    if [ -n "$pid" ]; then
      big=$(du -sb "$out"/units/*/* 2>/dev/null | grep -v '\.tmp$' | sort -n | tail -1 | cut -f1)
      avail=$(df -B1 --output=avail "$out" | tail -1 | tr -d ' ')
      if [ "$avail" -lt $(( ${big:-0} + ARCHIVE_TRIM_HEADROOM_BYTES )) ]; then
        echo "$avail ${big:-0}" > "$out/disk-stop"
        kill -INT "$pid" 2>/dev/null
        return 0
      fi
    fi
    read -rt "${ARCHIVE_DISK_POLL_S:-30}" _ <> <(:) || true
  done
}
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
  # OF-2 round 4, ruling 36: the scanner's output (plan and per-unit counts) goes to
  # $slog inside the day's progress, never to the public log; the log keeps the exit code
  # and the 429 log (429.log) only. OF-3 ruling 24: $out/logs is saved with the progress,
  # sealed (cache-crypt.sh), so a failed day's reasons stay private and readable.
  slog="$out/logs"; mkdir -p "$slog"
  rm -f "$out/disk-stop"
  disk_watch "$$" &
  wpid=$!
  timeout -s INT -k 120 "$left" zeroed-scan run -out "$out" -from "$day" -to "$next" -parallel "$ARCHIVE_PARALLEL" -dl "$ARCHIVE_DL" -workers 2 \
    -sample 0.05 -retention "$ret" -max-mbps "$mbps" -on-429 stop >> "$slog/run.log" 2>&1
  rc=$?
  kill "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  if [ -f "$out/disk-stop" ]; then
    read -r avail big < "$out/disk-stop"; rm -f "$out/disk-stop"
    echo "free disk fell to $avail bytes, below the largest unit ($big) + the trim headroom ($ARCHIVE_TRIM_HEADROOM_BYTES): the scan stopped between units; the day fails, not resumable (OF-3 rulings 14, 20)" | tee -a "$summary"
    exit 1
  fi
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
    echo "scanner failed with exit $rc (its output is kept in the private log next to the data, not in this log)" | tee -a "$summary"
    exit $rc
  fi
  hold_back "$out/archive-429.state" "$ARCHIVE_BACKOFF_S"
  echo "$(date -u +%FT%TZ) archive answered 429: back-off until $(date -u -d "@$(state_end "$out/archive-429.state")" +%FT%TZ); the chain stops, and only a later served archive-check resumes this day" | tee -a "$summary"
  exit 4
done
