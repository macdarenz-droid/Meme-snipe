#!/usr/bin/env bash
# Back-fill (DATA-1c): rebuilds one published day's regime volume per hour from its own
# units, with no archive access. Two steps, so the token never reaches the rebuild:
#   volume-day.sh --download DAY WORK_DIR        downloads the units tar parts and
#       SHA256SUMS-DAY of release data-day-DAY into WORK_DIR/dl-DAY (gh reads GH_TOKEN);
#   volume-day.sh DAY WORK_DIR ASSET_DIR         (no token) checks every part listed in
#       that SHA256SUMS is present and intact, extracts them, finalizes the day
#       (-lead-in-days 0), runs the exact cross-check (qa/volume.ts) and writes the
#       volume asset (volume-asset.sh).
# Publishing is ci/publish-volume.sh, in its own step.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = --download ]; then
  day=$2 work=$3
  [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $day"; exit 1; }
  dl="$work/dl-$day"
  rm -rf "$dl"; mkdir -p "$dl"
  gh release download "data-day-$day" --repo "$GITHUB_REPOSITORY" --pattern "units-$day.tar.part*" --pattern "SHA256SUMS-$day" --dir "$dl"
  exit 0
fi
[ -z "${GH_TOKEN:-}" ] || { echo "the rebuild runs without GH_TOKEN"; exit 1; }
day=$1 work=$2 assets=$3
[[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $day"; exit 1; }
next=$(date -u -d "$day + 1 day" +%F)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
dl="$work/dl-$day" data="$work/data-$day" ds="$work/ds-$day"
[ -f "$dl/SHA256SUMS-$day" ] || { echo "no $dl/SHA256SUMS-$day: run --download first"; exit 1; }
rm -rf "$data" "$ds"; mkdir -p "$data" "$assets"
# every part listed in the release's own SHA256SUMS, present and intact, and nothing else
listed=$(awk '{print $2}' "$dl/SHA256SUMS-$day" | grep -E "^units-$day\.tar\.part[0-9]+\$" | sort)
have=$(cd "$dl" && ls units-"$day".tar.part* 2>/dev/null | sort)
[ -n "$listed" ] && [ "$listed" = "$have" ] || { echo "data-day-$day: tar parts differ from its SHA256SUMS"; exit 1; }
(cd "$dl" && grep -E "  units-$day\.tar\.part[0-9]+\$" "SHA256SUMS-$day" | sha256sum -c --quiet -)
# shellcheck disable=SC2086 # part names have no spaces (checked above)
(cd "$dl" && cat $listed) | tar -x -C "$data"
rm -rf "$dl"
# OF-2 round 4, ruling 23: finalize and QA output go to $qlog, not the public log.
qlog="${RUNNER_TEMP:?}/volume-log-$day"; rm -rf "$qlog"; mkdir -p "$qlog"
zeroed-scan finalize -out "$data" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json" > "$qlog/finalize.log" 2>&1 ||
  { echo "volume: finalize failed for $day; its output is in $qlog" | tee -a "$summary"; exit 1; }
node --no-warnings "$here/../qa/volume.ts" "$ds" "$data/units" "$day" > "$qlog/volume.log" 2>&1 ||
  { echo "volume: the volume check failed for $day; its output is in $qlog" | tee -a "$summary"; exit 1; }
"$here/volume-asset.sh" "$ds" "$day" "$assets"
rm -rf "$data" "$ds" "$qlog"
echo "volume hours of $day rebuilt from data-day-$day" | tee -a "$summary"
