#!/usr/bin/env bash
# OF-3 trim (research/z-h-estimate/OLD-FAITHFUL.md §3): turns a K2 measurement day into
# the assets of its new release data-day-DAY-k3, with no archive or network access (it
# calls no gh, curl or archive read; zeroed-scan trim and finalize read local files).
#   trim-day.sh DAY K2_OUT LIST K3_OUT ASSET_DIR
# K2_OUT holds the day's K2 units (units/EPOCH/FROM-TO); LIST is the pinned PM-01
# migration list; K3_OUT must not hold units yet. Every unit is trimmed (zeroed-scan
# trim), the trimmed units must match the expected per-unit log (the K2 unit's revision,
# K3, the list's sha256), then finalize, strict QA, decoder parity and the volume check
# run again on the trimmed units, and the per-unit log goes into the assets; package-day.sh
# then writes the tar parts and SHA256SUMS-DAY. The K2 release is never edited; the
# trimmed day's determinism rests on the K2 release's rescan hashes plus the trim being
# deterministic (tested in the scanner).
set -euo pipefail
[ $# -eq 5 ] || { echo "usage: trim-day.sh DAY K2_OUT LIST K3_OUT ASSET_DIR" >&2; exit 2; }
day=$1 k2=$2 list=$3 k3=$4 assets=$5
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
next=$(date -u -d "$day + 1 day" +%F)
[ -f "$list" ] || { echo "refused: no migration list $list" | tee -a "$summary"; exit 2; }
if compgen -G "$k3/units/*/*" > /dev/null; then echo "refused: $k3 already holds units" | tee -a "$summary"; exit 2; fi
sha=$(sha256sum "$list" | cut -d' ' -f1)
mkdir -p "$k3/units" "$assets"
expected=$(mktemp)
trap 'rm -f "$expected"' EXIT
n=0
for u in "$k2"/units/*/*; do
  [ -f "$u/stats.json" ] && [[ "$u" != *.tmp ]] || continue
  epoch=$(basename "$(dirname "$u")") range=$(basename "$u")
  rev=$(sed -n 's/.*"scanner_revision": *"\([^"]*\)".*/\1/p' "$u/stats.json" | head -1)
  mkdir -p "$k3/units/$epoch"
  zeroed-scan trim -in "$u" -out "$k3/units/$epoch/$range" -migration-list "$list"
  echo "$epoch/$range $rev K3 $sha" >> "$expected"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "refused: $k2 holds no finished units" | tee -a "$summary"; exit 2; }
LC_ALL=C sort -o "$expected" "$expected"
zeroed-scan unitlog -out "$k3" -check "$expected"
cp "$expected" "$assets/units-$day.log"
ds=$(mktemp -d -p "${DATASET_PARENT:-/tmp}")
zeroed-scan finalize -out "$k3" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json"
node "$here/../qa/check.mjs" "$ds" --live 30 --strict --lead-in-days 0
node --no-warnings "$here/../qa/parity.ts" "$ds"
node --no-warnings "$here/../qa/volume.ts" "$ds" "$k3/units" "$day"
"$here/volume-asset.sh" "$ds" "$day" "$assets"
cp "$ds/qa/report.md" "$assets/qa-$day.md"
cp "$ds/qa/report.json" "$assets/qa-$day.json"
cp "$ds/qa/parity.json" "$assets/parity-$day.json"
cp "$ds/manifest.json" "$assets/manifest-$day.json"
rm -rf "$ds"
echo "trim: $n units of $day trimmed to K3 (list sha256 $sha); finalize, strict QA, parity and volume passed" | tee -a "$summary"
