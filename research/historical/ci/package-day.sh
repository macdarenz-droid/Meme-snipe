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
for f in units-"$day".log rescan-"$day".sha256 list-"$day".txt pm01-subset-"$day".txt; do [ -f "$assets/$f" ] && extra+=("$f"); done
(cd "$assets" && sha256sum units-"$day".tar.part* events-"$day".tar qa-"$day".* parity-"$day".json manifest-"$day".json "${extra[@]}" > "SHA256SUMS-$day")
