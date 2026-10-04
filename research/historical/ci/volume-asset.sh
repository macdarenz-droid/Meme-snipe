#!/usr/bin/env bash
# Writes the plain-CSV volume asset of one checked day from a finalized dataset:
#   volume-asset.sh DATASET_DIR DAY ASSET_DIR
# -> ASSET_DIR/volume-hours-DAY.csv (hour_start_ms,lamports,covered; 24 hours) and
#    ASSET_DIR/volume-check-DAY.json (the cross-check result, qa/volume.ts).
set -euo pipefail
ds=$1 day=$2 assets=$3
mkdir -p "$assets"
[ -f "$ds/qa/volume.json" ] || { echo "no $ds/qa/volume.json: run qa/volume.ts first"; exit 1; }
node -e '
const fs = require("fs"), z = require("zlib"), path = require("path");
const [dir, out] = process.argv.slice(1);
const parts = fs.readdirSync(dir).filter((f) => /^volume_hours-\d+\.csv\.zst$/.test(f)).sort();
if (parts.length === 0) { console.error("no volume_hours files in " + dir); process.exit(1); }
const lines = [];
parts.forEach((f, i) => {
  const l = z.zstdDecompressSync(fs.readFileSync(path.join(dir, f))).toString().split("\n").filter(Boolean);
  lines.push(...(i === 0 ? l : l.slice(1)));
});
if (lines[0] !== "hour_start_ms,lamports,covered" || lines.length !== 25) { console.error("unexpected volume_hours shape: " + lines.length + " lines"); process.exit(1); }
fs.writeFileSync(out, lines.join("\n") + "\n");
' "$ds/days/$day" "$assets/volume-hours-$day.csv"
cp "$ds/qa/volume.json" "$assets/volume-check-$day.json"
echo "volume asset: $assets/volume-hours-$day.csv"
