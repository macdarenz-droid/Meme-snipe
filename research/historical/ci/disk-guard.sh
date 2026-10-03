#!/usr/bin/env bash
# Fails early, with a clear message, when DIR's volume has less than NEED bytes free.
#   disk-guard.sh DIR NEED_BYTES WHAT
# Used by the scan job (before the scan, before finalize, before packaging) so a full
# disk stops a day at once instead of after hours of scanning.
set -euo pipefail
dir=$1 need=$2 what=$3
avail=$(df -B1 --output=avail "$dir" | tail -1 | tr -d ' ')
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
gb() { awk -v b="$1" 'BEGIN { printf "%.1f GB", b / 1e9 }'; }
echo "disk on $dir: $(gb "$avail") free, $(gb "$need") needed ($what)" | tee -a "$summary"
if (( avail < need )); then
  echo "not enough disk on $dir for $what: $(gb "$avail") free, need $(gb "$need")" | tee -a "$summary" >&2
  exit 1
fi
