#!/usr/bin/env bash
# Packages one checked day as release assets for `data-day-DAY`: the events-only asset,
# the units tar parts and SHA256SUMS-DAY. Its own workflow step after QA (check-day.sh),
# so a failed `tar --remove-files` can never be followed by a progress save of units
# with files missing (the after-QA save runs only when QA fails).
#   package-day.sh DAY OUT_DIR ASSET_DIR
set -euo pipefail
day=$1 out=$2 assets=$3
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
for f in qa-"$day".md qa-"$day".json parity-"$day".json manifest-"$day".json; do
  [ -f "$assets/$f" ] || { echo "missing $assets/$f: run check-day.sh first"; exit 1; }
done
# The day's events-only asset (each unit's events, stats and block rows), all an
# assembled window needs from its lead-in days; files in sorted order.
(cd "$out" && find units -mindepth 3 -maxdepth 3 \( -name events.jsonl.zst -o -name stats.json -o -name blocks.csv.zst \) \
  ! -path '*.tmp/*' | LC_ALL=C sort | tar --no-recursion -cf "$assets/events-$day.tar" -T -)
# OF-6 (docs/reviews/OF6.md ruling 1): margin-DAY.tar, the day's units that reach into
# the next day: last block time at or after the next midnight minus MARGIN_S (2 h; the
# next day's plan keeps two units, about 1 h, before its midnight). The next day takes
# them from the store instead of reading them from the archive again. Packed before the
# units tar below removes the files; listed in SHA256SUMS and read back like every asset.
MARGIN_S=7200
nextmid=$(date -u -d "$day + 1 day" +%s)
for st in "$out"/units/*/*/stats.json; do
  [[ -f "$st" && "$st" != *.tmp/stats.json ]] || continue
  lb=$(sed -n 's/.*"last_block_time": *\([0-9][0-9]*\).*/\1/p' "$st")
  if [ -n "$lb" ] && [ "$lb" -ge $(( nextmid - MARGIN_S )) ]; then rel=${st#"$out"/}; echo "${rel%/stats.json}"; fi
done | LC_ALL=C sort > "$assets/.margin-$day.list"
tar -C "$out" -cf "$assets/margin-$day.tar" -T "$assets/.margin-$day.list"
echo "margin: $(wc -l < "$assets/.margin-$day.list") units reach $(date -u -d "@$nextmid" +%F) (margin-$day.tar)" | tee -a "$summary"
rm -f "$assets/.margin-$day.list"
# Before packaging: tar --remove-files frees each unit file as it goes, so one part
# (1.9 GiB) + 5 GB of headroom is enough.
"$here/disk-guard.sh" "$assets" 7000000000 "packaging"
# Package: one tar of the day's finished units, split into 1900 MiB parts (under the
# 2 GiB asset limit). --remove-files deletes each unit file once it is in the tar, so
# the disk holds the units or their tar, not both (progress is already in the cache).
t0=$(date +%s)
(cd "$out" && tar --exclude='*.tmp' --remove-files -cf - units) | split -b 1900m -d -a 2 - "$assets/units-$day.tar.part"
echo "phase package ($day): $(( $(date +%s) - t0 )) s" | tee -a "$summary"
{ echo "### Disk after packaging ($day)"; echo '```'; df -h "$assets" 2>/dev/null; ls -l "$assets"; echo '```'; } >> "$summary"
# OF-3: the per-unit log and the rescan unit's hashes, when check-day.sh or trim-day.sh wrote them;
# OF-4: a K2 day's measured PM-01 subset (trim-day.sh --list-only).
extra=()
for f in units-"$day".log rescan-"$day".sha256 list-"$day".txt pm01-subset-"$day".txt margin-"$day".tar; do [ -f "$assets/$f" ] && extra+=("$f"); done
(cd "$assets" && sha256sum units-"$day".tar.part* events-"$day".tar qa-"$day".* parity-"$day".json manifest-"$day".json "${extra[@]}" > "SHA256SUMS-$day")
