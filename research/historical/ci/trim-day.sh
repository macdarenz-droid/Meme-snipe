#!/usr/bin/env bash
# OF-3 trim (research/z-h-estimate/OLD-FAITHFUL.md §3; docs/reviews/OF3.md rulings 2-5): a
# day read at K2 is trimmed to K3 in place, before it is stored, with no archive or network
# access (it calls no gh, curl or archive read; zeroed-scan reads local files).
#   trim-day.sh DAY OUT PRIOR_LIST ASSET_DIR [--qa]
# OUT holds the day's K2 units (units/EPOCH/FROM-TO). PRIOR_LIST is the day before's
# pinned list (list-<D-1>.txt of its release), or "-" only for the first allow-listed day.
#   1. The day's pinned list: PRIOR_LIST's windows that reach the day + the day's own
#      migrations read from its K2 units, each from the migration to + 300 min (zeroed-scan
#      migrations; PM-01 PREREG §3). Written to ASSET_DIR/list-DAY.txt (the next day's prior).
#   2. Per unit, in order: its K2 file hashes go into the per-unit log ("k2 SHA256
#      EPOCH/RANGE/FILE"), it is trimmed (zeroed-scan trim), and its K2 copy is deleted.
#   3. The trimmed units replace the K2 ones; the per-unit log (OUT/units.log, unit lines
#      "EPOCH/RANGE REVISION K3 LIST_SHA256" plus the k2 lines) is checked against them
#      (zeroed-scan unitlog -check) and copied to ASSET_DIR/units-DAY.log.
#   --qa (a stored K2 day trimmed into data-day-DAY-k3): finalize, strict QA, decoder
#   parity and the volume check run on the trimmed units; its determinism rests on the K2
#   release's rescan hashes plus the trim being deterministic (tested in the scanner).
#   Without --qa (a batch), check-day.sh runs next: its rescan reads the unit at K2 and
#   compares it with the logged K2 hashes.
set -euo pipefail
[ $# -eq 4 ] || { [ $# -eq 5 ] && [ "$5" = --qa ]; } || { echo "usage: trim-day.sh DAY OUT PRIOR_LIST ASSET_DIR [--qa]" >&2; exit 2; }
day=$1 out=$2 prior=$3 assets=$4 qa=${5:-}
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
next=$(date -u -d "$day + 1 day" +%F)
refuse() { echo "refused: $*" | tee -a "$summary" >&2; exit 2; }
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
if [ "$prior" = - ]; then
  [ "$day" = "$(ag_first_day)" ] || refuse "$day is not the first allow-listed day, so it needs the day before's pinned list"
  prior_args=()
else
  [ -f "$prior" ] || refuse "no prior list $prior"
  prior_args=(-prior "$prior")
fi
[ ! -e "$out/units.k3" ] || refuse "$out/units.k3 exists: an earlier trim did not finish"
n=0
for u in "$out"/units/*/*; do
  [[ "$u" != *.tmp ]] || continue
  [ -f "$u/stats.json" ] || refuse "$u is not a finished unit"
  grep -q '"retention": *"K2"' "$u/stats.json" || refuse "$u is not a K2 unit"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || refuse "$out holds no finished units"
mkdir -p "$assets"
list="$assets/list-$day.txt"
zeroed-scan migrations -day-start "$(date -u -d "$day" +%s)" "${prior_args[@]}" "$out" > "$list"
[ -s "$list" ] || refuse "the day's pinned list is empty (no migration in the day or the window before it)"
sha=$(sha256sum "$list" | cut -d' ' -f1)
log="$out/units.log"
units=() k2=()
for u in "$out"/units/*/*; do
  [[ "$u" != *.tmp ]] || continue
  epoch=$(basename "$(dirname "$u")") range=$(basename "$u")
  rev=$(sed -n 's/.*"scanner_revision": *"\([^"]*\)".*/\1/p' "$u/stats.json" | head -1)
  while read -r h f; do k2+=("k2 $h $f"); done < <(cd "$out/units" && sha256sum -- "$epoch/$range"/*.zst | LC_ALL=C sort -k2)
  mkdir -p "$out/units.k3/$epoch"
  zeroed-scan trim -in "$u" -out "$out/units.k3/$epoch/$range" -migration-list "$list"
  rm -rf "$u"
  units+=("$epoch/$range $rev K3 $sha")
done
rm -rf "$out/units" && mv "$out/units.k3" "$out/units"
{ printf '%s\n' "${units[@]}" | LC_ALL=C sort; printf '%s\n' "${k2[@]}"; } > "$log"
zeroed-scan unitlog -out "$out" -check "$log"
cp "$log" "$assets/units-$day.log"
echo "trim: $n units of $day trimmed to K3 (list sha256 $sha); K2 hashes in the per-unit log" | tee -a "$summary"
[ "$qa" = --qa ] || exit 0
ds=$(mktemp -d -p "${DATASET_PARENT:-/tmp}")
zeroed-scan finalize -out "$out" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json"
node "$here/../qa/check.mjs" "$ds" --live 30 --strict --lead-in-days 0
node --no-warnings "$here/../qa/parity.ts" "$ds"
node --no-warnings "$here/../qa/volume.ts" "$ds" "$out/units" "$day"
"$here/volume-asset.sh" "$ds" "$day" "$assets"
cp "$ds/qa/report.md" "$assets/qa-$day.md"
cp "$ds/qa/report.json" "$assets/qa-$day.json"
cp "$ds/qa/parity.json" "$assets/parity-$day.json"
cp "$ds/manifest.json" "$assets/manifest-$day.json"
rm -rf "$ds"
echo "trim: finalize, strict QA, parity and volume passed on the trimmed $day" | tee -a "$summary"
