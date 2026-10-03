#!/usr/bin/env bash
# Back-fill (DATA-1c): rebuilds one published day's regime volume per hour from its own
# units, with no archive access: downloads the units tar parts of release data-day-DAY,
# checks them against the release's SHA256SUMS-DAY, extracts them, finalizes the day
# (-lead-in-days 0), runs the exact cross-check (qa/volume.ts) and writes the volume
# asset (volume-asset.sh). Publishing is ci/publish-volume.sh, in its own step.
#   volume-day.sh DAY WORK_DIR ASSET_DIR      (gh reads GH_TOKEN)
set -euo pipefail
day=$1 work=$2 assets=$3
[[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $day"; exit 1; }
next=$(date -u -d "$day + 1 day" +%F)
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
dl="$work/dl-$day" data="$work/data-$day" ds="$work/ds-$day"
rm -rf "$dl" "$data" "$ds"; mkdir -p "$dl" "$data" "$assets"
gh release download "data-day-$day" --repo "$GITHUB_REPOSITORY" --pattern "units-$day.tar.part*" --pattern "SHA256SUMS-$day" --dir "$dl"
# every part listed in the release's own SHA256SUMS, present and intact, and nothing else
listed=$(awk '{print $2}' "$dl/SHA256SUMS-$day" | grep -E "^units-$day\.tar\.part[0-9]+\$" | sort)
have=$(cd "$dl" && ls units-"$day".tar.part* 2>/dev/null | sort)
[ -n "$listed" ] && [ "$listed" = "$have" ] || { echo "data-day-$day: tar parts differ from its SHA256SUMS"; exit 1; }
(cd "$dl" && grep -E "  units-$day\.tar\.part[0-9]+\$" "SHA256SUMS-$day" | sha256sum -c --quiet -)
(cd "$dl" && cat $listed) | tar -x -C "$data"
rm -rf "$dl"
zeroed-scan finalize -out "$data" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json"
node --no-warnings "$here/../qa/volume.ts" "$ds" "$data/units" "$day"
"$here/volume-asset.sh" "$ds" "$day" "$assets"
rm -rf "$data" "$ds"
echo "volume hours of $day rebuilt from data-day-$day" | tee -a "$summary"
