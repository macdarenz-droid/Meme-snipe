#!/usr/bin/env bash
# Finalizes one scanned day on its own, runs the strict QA, the decoder parity check and
# the determinism check, and packages the day as release assets for `data-day-DAY`.
#   check-day.sh DAY OUT_DIR ASSET_DIR
# MAX_MBPS (default 80) caps the determinism rescan, like the scan itself.
set -euo pipefail
day=$1 out=$2 assets=$3
next=$(date -u -d "$day + 1 day" +%F)
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$assets"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
# Disk: the units (about 6.4-8.5 GB a day) and the one-day dataset can live on different
# volumes (DATASET_PARENT, e.g. /mnt on GitHub runners); free space is logged.
{ echo "### Disk before QA ($day)"; echo '```'; df -h "$out" "${DATASET_PARENT:-/tmp}" 2>/dev/null; echo '```'; } >> "$summary"
# Before finalize: room for the one-day dataset (at most about the units' size) + 5 GB.
units_bytes=$(du -sb "$out/units" | cut -f1)
"$here/disk-guard.sh" "${DATASET_PARENT:-/tmp}" $(( units_bytes + 5000000000 )) "the one-day QA dataset"
ds=$(mktemp -d -p "${DATASET_PARENT:-/tmp}")
# A single-day dataset without lead-in: universes are tokens created or graduated in
# that day's units. The multi-day dataset (assemble.sh) uses the 14-day lead-in.
zeroed-scan finalize -out "$out" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json"
node "$here/../qa/check.mjs" "$ds" --live 30 --strict --lead-in-days 0
node --no-warnings "$here/../qa/parity.ts" "$ds"
cp "$ds/qa/report.md" "$assets/qa-$day.md"
cp "$ds/qa/report.json" "$assets/qa-$day.json"
cp "$ds/qa/parity.json" "$assets/parity-$day.json"
cp "$ds/manifest.json" "$assets/manifest-$day.json"

# Determinism: rescan the day's first unit into a fresh directory; every data file
# must be byte-identical.
first=$(ls -d "$out"/units/*/* | grep -v '\.tmp$' | sort -V | head -1)
epoch=$(basename "$(dirname "$first")")
range=$(basename "$first")
again=$(mktemp -d)
mkdir -p "$again/cache" && cp "$out"/cache/* "$again/cache/" 2>/dev/null || true
zeroed-scan unit -out "$again" -epoch "$epoch" -from-slot "${range%-*}" -to-slot "${range#*-}" -sample 0.05 -max-mbps "${MAX_MBPS:-80}" -on-429 stop -state "$out"
for f in "$first"/*.zst; do
  a=$(sha256sum "$f" | cut -d' ' -f1)
  b=$(sha256sum "$again/units/$epoch/$range/$(basename "$f")" | cut -d' ' -f1)
  if [ "$a" != "$b" ]; then echo "determinism check failed for $range/$(basename "$f")"; exit 1; fi
done
echo "determinism: unit $epoch/$range rescanned, every file identical" | tee -a "$summary"
rm -rf "$ds" "$again"
