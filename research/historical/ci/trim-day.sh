#!/usr/bin/env bash
# OF-3 trim (research/z-h-estimate/OLD-FAITHFUL.md §3; docs/reviews/OF3.md rulings 2-5,
# 9, 11, 13, 15): a day read at K2 is trimmed to K3 in place, before it is stored, with no
# archive or network access (it calls no gh, curl or archive read; zeroed-scan reads local
# files).
#   trim-day.sh DAY OUT PRIOR_LIST ASSET_DIR [--qa | --list-only]
# OUT holds the day's K2 units (units/EPOCH/FROM-TO). PRIOR_LIST is the day before's pinned
# list, list-<D-1>.txt, verified against that day's stored SHA256SUMS (ARCHIVE_PRIOR_SUMS);
# "-" only for the first allow-listed day.
#   1. The day's pinned list: PRIOR_LIST's windows that reach the day + the day's own
#      migrations read from its K2 units, each from the migration to + 300 min (zeroed-scan
#      migrations; PM-01 PREREG §3), kept as OUT/list-DAY.txt and copied to the assets (the
#      next day's prior). --list-only stops here (a day stored at K2), after measuring the
#      day's PM-01 subset into ASSET_DIR/pm01-subset-DAY.txt (OF-4 ruling 2).
#   2. Per unit: it is trimmed into OUT/units.k3 (zeroed-scan trim); its K2 file hashes are
#      written to a temp file, appended to OUT/units.log.partial and fsynced; its K2 copy is
#      renamed to .del and deleted only when that file holds one k2 line per .zst file of it
#      (a torn line is dropped and the unit's lines rewritten). A stopped
#      trim resumes from units.k3, that file and the kept list. Between units it stops
#      (exit 1, the day fails) once ARCHIVE_TRIM_BUDGET_S is spent.
#   3. The trimmed units replace the K2 ones; the per-unit log (OUT/units.log: unit lines
#      "EPOCH/RANGE REVISION K3 LIST_SHA256", then the k2 lines sorted by path with
#      LC_ALL=C) is checked (zeroed-scan unitlog -check) and copied to the assets.
#   A restored day that is already trimmed (every unit K3, units.log present and checked)
#   is left as it is: its log and list go to the assets again.
#   --qa (a stored K2 day trimmed into data-day-DAY-k3): finalize, strict QA, decoder
#   parity and the volume check run on the trimmed units. Without it (a batch),
#   check-day.sh runs next: its rescan reads the unit at K2 and compares it with the k2 lines.
set -euo pipefail
[ $# -eq 4 ] || { [ $# -eq 5 ] && { [ "$5" = --qa ] || [ "$5" = --list-only ]; }; } ||
  { echo "usage: trim-day.sh DAY OUT PRIOR_LIST ASSET_DIR [--qa | --list-only]" >&2; exit 2; }
day=$1 out=$2 prior=$3 assets=$4 mode=${5:-}
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
next=$(date -u -d "$day + 1 day" +%F)
refuse() { echo "refused: $*" | tee -a "$summary" >&2; exit 2; }
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
list="$out/list-$day.txt" log="$out/units.log" partial="$out/units.log.partial"
# OF-2 round 4, ruling 36: the scanner's output goes to $tlog inside the day's progress,
# saved with it, sealed (OF-3 ruling 24).
tlog="$out/logs"
mkdir -p "$assets" "$tlog"
k2=() k3=()
for u in "$out"/units/*/*; do
  [[ -d "$u" && "$u" != *.tmp && "$u" != *.del ]] || continue
  [ -f "$u/stats.json" ] || refuse "$u is not a finished unit"
  if grep -q '"retention": *"K2"' "$u/stats.json"; then k2+=("$u")
  elif grep -q '"retention": *"K3"' "$u/stats.json"; then k3+=("$u")
  else refuse "$u is neither a K2 nor a K3 unit"; fi
done
# A restored day already trimmed: nothing to do (ruling 9).
if [ ${#k2[@]} -eq 0 ] && [ ${#k3[@]} -gt 0 ] && [ ! -e "$out/units.k3" ]; then
  [ -f "$log" ] && [ -f "$list" ] || refuse "$day's K3 units have no per-unit log or list"
  zeroed-scan unitlog -out "$out" -check "$log" > "$tlog/unitlog.log" 2>&1 || refuse "$day's per-unit log does not match its K3 units"
  # Ruling 22: the list copied is the one every unit was trimmed with.
  lsha=$(sha256sum "$list" | cut -d' ' -f1)
  for u in "${k3[@]}"; do
    grep -q "\"migration_list_sha256\": *\"$lsha\"" "$u/stats.json" || refuse "$u was not trimmed with $list (sha256 $lsha)"
  done
  cp "$log" "$assets/units-$day.log"; cp "$list" "$assets/list-$day.txt"
  echo "trim: $day is already trimmed (${#k3[@]} units); nothing to do" | tee -a "$summary"
  exit 0
fi
[ ${#k3[@]} -eq 0 ] || refuse "$out mixes K2 and K3 units outside a trim"
[ ${#k2[@]} -gt 0 ] || [ -d "$out/units.k3" ] || refuse "$out holds no finished units"
# 1. The pinned list, built once and kept for a resumed trim.
if [ ! -f "$list" ] || [ ! -d "$out/units.k3" ]; then
  if [ "$prior" = - ]; then
    [ "$day" = "$(ag_first_day)" ] || refuse "$day is not the first allow-listed day, so it needs the day before's pinned list"
    prior_args=()
  else
    ag_prior_ok "$day" "$prior" "${ARCHIVE_PRIOR_SUMS:-}" || exit 2
    prior_args=(-prior "$prior")
  fi
  [ ${#k2[@]} -gt 0 ] || refuse "$out holds no K2 units to build the list from"
  # (ruling 63: the list is captured, never read back out of the log directory)
  dstart=$(date -u -d "$day" +%s)
  lst=$(zeroed-scan migrations -day-start "$dstart" "${prior_args[@]}" "$out" 2>> "$tlog/migrations.log")
  if [ -n "$lst" ]; then printf '%s\n' "$lst" > "$list.tmp"; else : > "$list.tmp"; fi
  [ -s "$list.tmp" ] || refuse "the day's pinned list is empty (no migration in the day or the window before it)"
  mv "$list.tmp" "$list"
fi
cp "$list" "$assets/list-$day.txt"
sha=$(sha256sum "$list" | cut -d' ' -f1)
if [ "$mode" = --list-only ]; then
  # OF-4 ruling 2: the measured PM-01 subset of a K2 day (batches 1 and 2), the per-day
  # figure of the storage stop until a K3 day is stored. Each K2 unit is trimmed with the
  # day's list into a scratch copy, its bytes added up and the copy deleted (one unit's
  # K3 on disk at a time); the K2 units stay as they are. Same time budget as a trim.
  meas="$out/units.measure"; rm -rf "$meas"; start=$(date +%s) bytes=0
  for u in "${k2[@]}"; do
    if [ $(( $(date +%s) - start )) -ge "$ARCHIVE_TRIM_BUDGET_S" ]; then
      rm -rf "$meas"; echo "measure: time budget ($ARCHIVE_TRIM_BUDGET_S s) spent; the day fails (not resumable)" | tee -a "$summary"; exit 1
    fi
    epoch=$(basename "$(dirname "$u")") range=$(basename "$u")
    mkdir -p "$meas/$epoch"
    zeroed-scan trim -in "$u" -out "$meas/$epoch/$range" -migration-list "$list" >> "$tlog/trim.log" 2>&1
    b=$(du -sb "$meas/$epoch/$range" | cut -f1); bytes=$(( bytes + b ))
    rm -rf "${meas:?}/$epoch/$range"
  done
  rm -rf "$meas"
  echo "$bytes" > "$assets/pm01-subset-$day.txt"
  echo "list: $day's pinned list written (sha256 $sha); the day is stored at K2; its PM-01 subset measures $bytes bytes" | tee -a "$summary"
  exit 0
fi
# 2. Per unit: trim, log the K2 hashes durably, delete the K2 copy.
mkdir -p "$out/units.k3"
touch "$partial"
# Ruling 21: an append cut short leaves a torn last line; only whole k2 lines are kept,
# and each unit's count is checked below before its K2 copy goes.
if [ -s "$partial" ] && [ -n "$(tail -c1 "$partial")" ]; then sed -i '$d' "$partial"; fi
grep -E '^k2 [0-9a-f]{64} [0-9]+/[0-9]+-[0-9]+/[^/ ]+\.zst$' "$partial" > "$partial.ok" || true
mv "$partial.ok" "$partial"; sync "$partial"
start=$(date +%s) n=0
for u in "${k2[@]}"; do
  epoch=$(basename "$(dirname "$u")") range=$(basename "$u")
  k3u="$out/units.k3/$epoch/$range"
  if [ ! -d "$k3u" ]; then
    if [ $(( $(date +%s) - start )) -ge "$ARCHIVE_TRIM_BUDGET_S" ]; then
      # Ruling 20: not resumable; the day counts as failed and the chain holds (ruling 7).
      echo "trim: time budget ($ARCHIVE_TRIM_BUDGET_S s) spent after $n units; the day fails (not resumable)" | tee -a "$summary"
      exit 1
    fi
    rm -rf "$k3u.tmp"; mkdir -p "$out/units.k3/$epoch"
    zeroed-scan trim -in "$u" -out "$k3u" -migration-list "$list" >> "$tlog/trim.log" 2>&1
  fi
  # Ruling 21: the unit's k2 lines go to a temp file, then are appended and synced; the
  # K2 copy is deleted only when the partial log holds one line per .zst file of it.
  want=$(find "$u" -maxdepth 1 -name '*.zst' | wc -l)
  have=$(grep -c " $epoch/$range/[^/]*\$" "$partial" || true)
  if [ "$have" -ne "$want" ]; then
    grep -v " $epoch/$range/[^/]*\$" "$partial" > "$partial.tmp" || true
    mv "$partial.tmp" "$partial"
    (cd "$out/units" && sha256sum -- "$epoch/$range"/*.zst) | sed 's/^\([0-9a-f]\{64\}\)  /k2 \1 /' > "$partial.unit"
    cat "$partial.unit" >> "$partial"; rm -f "$partial.unit"
    sync "$partial"
    have=$(grep -c " $epoch/$range/[^/]*\$" "$partial" || true)
  fi
  [ "$have" -eq "$want" ] || refuse "$epoch/$range: $have k2 lines for $want files; its K2 copy is kept"
  # renamed first, so a delete cut short leaves a .del copy (its k2 lines already on disk)
  mv "$u" "$u.del" && rm -rf "$u.del"
  n=$((n + 1))
done
# 3. The trimmed units replace the K2 ones; the per-unit log is checked.
rm -rf "$out"/units/*/*.del
find "$out/units" -mindepth 1 -type d -empty -delete 2>/dev/null || true
if compgen -G "$out/units/*/*" > /dev/null; then refuse "$out/units still holds units after the trim"; fi
rm -rf "$out/units" && mv "$out/units.k3" "$out/units"
ulines=$(zeroed-scan unitlog -out "$out" 2>> "$tlog/unitlog.log")
while read -r l; do [[ "$l" == *" K3 $sha" ]] || refuse "unit line '$l' is not K3 with the pinned list $sha"; done <<< "$ulines"
{ printf '%s\n' "$ulines"; LC_ALL=C sort -k3,3 "$partial"; } > "$log.tmp"
mv "$log.tmp" "$log"
zeroed-scan unitlog -out "$out" -check "$log" >> "$tlog/unitlog.log" 2>&1
rm -f "$partial"
cp "$log" "$assets/units-$day.log"
echo "trim: $day trimmed to K3 (list sha256 $sha); K2 hashes in the per-unit log" | tee -a "$summary"
[ "$mode" = --qa ] || exit 0
ds=$(mktemp -d -p "${DATASET_PARENT:-/tmp}")
# OF-2 round 4, ruling 23: finalize and QA output go to $qlog next to the dataset, never
# to the public job log or summary.
qlog="$out/logs/qa"; rm -rf "$qlog"; mkdir -p "$qlog"
qa() { "$@" || { echo "trim: $1 failed for $day (exit $?); its output is kept in the private log next to the data" | tee -a "$summary"; exit 1; }; }
qa zeroed-scan finalize -out "$out" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json" > "$qlog/finalize.log" 2>&1
qa node "$here/../qa/check.mjs" "$ds" --live 30 --strict --lead-in-days 0 > "$qlog/qa.log" 2>&1
qa node --no-warnings "$here/../qa/parity.ts" "$ds" > "$qlog/parity.log" 2>&1
qa node --no-warnings "$here/../qa/volume.ts" "$ds" "$out/units" "$day" > "$qlog/volume.log" 2>&1
"$here/volume-asset.sh" "$ds" "$day" "$assets"
cp "$ds/qa/report.md" "$assets/qa-$day.md"
cp "$ds/qa/report.json" "$assets/qa-$day.json"
cp "$ds/qa/parity.json" "$assets/parity-$day.json"
cp "$ds/manifest.json" "$assets/manifest-$day.json"
rm -rf "$ds" "$qlog"
echo "trim: finalize, strict QA, parity and volume passed on the trimmed $day" | tee -a "$summary"
