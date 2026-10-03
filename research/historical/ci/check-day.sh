#!/usr/bin/env bash
# Finalizes one scanned day on its own, runs the strict QA and the determinism check,
# and packages the day's units as release assets.
#   check-day.sh DAY OUT_DIR ASSET_DIR
set -euo pipefail
day=$1 out=$2 assets=$3
next=$(date -u -d "$day + 1 day" +%F)
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$assets"
ds=$(mktemp -d)
# a single-day dataset: universes are tokens created or graduated in that day's units
zeroed-scan finalize -out "$out" -dataset "$ds" -from "$day" -to "$next" -allow-gaps
node "$here/../qa/check.mjs" "$ds" --live 30 --strict
cp "$ds/qa/report.md" "$assets/qa-$day.md"
cp "$ds/qa/report.json" "$assets/qa-$day.json"
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
echo "determinism: unit $epoch/$range rescanned, every file identical" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

# Package: one tar of the day's finished units, split under the 2 GiB asset limit.
(cd "$out" && tar --exclude='*.tmp' -cf - units) | split -b 1900m -d -a 2 - "$assets/units-$day.tar.part"
(cd "$assets" && sha256sum units-"$day".tar.part* qa-"$day".* manifest-"$day".json > "SHA256SUMS-$day")
