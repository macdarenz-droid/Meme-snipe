#!/usr/bin/env bash
# HISTORY-RESUME: a progress save never holds fewer finished units than the run restored.
#   progress-guard.sh record DIR   after the restore: counts DIR's finished units
#                                  (units/*/*/stats.json) into $RUNNER_TEMP/progress-restored
#   progress-guard.sh check DIR    before a save: ok=true to $GITHUB_OUTPUT only when DIR
#                                  holds at least that many; a missing record (the restore
#                                  did not finish) is never ok
set -uo pipefail
cmd=$1 dir=$2
rec="${RUNNER_TEMP:?}/progress-restored"
count() { find "$dir/units" -mindepth 3 -maxdepth 3 -name stats.json 2>/dev/null | wc -l; }
case $cmd in
  record) n=$(count); echo "$n" > "$rec"; echo "progress-guard: $n finished units restored" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" ;;
  check)
    n=$(count)
    if [[ ! -s "$rec" ]] || ! [[ "$(cat "$rec")" =~ ^[0-9]+$ ]]; then
      echo "progress-guard: the restore did not finish; progress is not saved" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    elif (( n < $(cat "$rec") )); then
      echo "progress-guard: $n finished units, fewer than the $(cat "$rec") restored; progress is not saved" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    else
      echo "ok=true" >> "${GITHUB_OUTPUT:-/dev/null}"
      echo "progress-guard: $n finished units (restored $(cat "$rec")); saving" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    fi ;;
  *) echo "usage: progress-guard.sh record|check DIR" >&2; exit 2 ;;
esac
