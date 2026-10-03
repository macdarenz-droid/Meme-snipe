#!/usr/bin/env bash
# Whether a job phase fits the time left before the job timeout (data-scan.yml).
#   time-left.sh JOB_START_UNIX TIMEOUT_MIN NEED_MIN
# Exit 0 when at least NEED_MIN minutes remain of TIMEOUT_MIN since JOB_START_UNIX,
# else 75 (resumable: progress is already saved, the next chained run redoes the phase).
set -uo pipefail
[ $# -eq 3 ] || { echo "usage: time-left.sh JOB_START_UNIX TIMEOUT_MIN NEED_MIN" >&2; exit 2; }
for v in "$@"; do [[ "$v" =~ ^[0-9]+$ ]] || { echo "time-left.sh: '$v' is not a whole number" >&2; exit 2; }; done
start=$1 timeout_min=$2 need_min=$3
left=$(( (start + timeout_min * 60 - $(date +%s)) / 60 ))
if [ "$left" -lt "$need_min" ]; then
  echo "$left min left before the job timeout, $need_min needed: stopping before this phase; progress kept for the next run" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 75
fi
echo "$left min left before the job timeout ($need_min needed)"
