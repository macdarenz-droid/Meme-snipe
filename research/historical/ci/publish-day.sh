#!/usr/bin/env bash
# Publishes one checked day as release data-day-DAY (called by the scan job of
# .github/workflows/data-scan.yml right after that day's QA, parity and determinism
# checks pass; the only step that sees the write token).
#   publish-day.sh DAY ASSET_DIR
# A published day is never replaced: if the release exists, the day is left as it is.
set -euo pipefail
d=$1 assets=$2
[[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $d"; exit 1; }
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
cd "$assets"
sha256sum -c "SHA256SUMS-$d"
files=(units-"$d".tar.part* qa-"$d".md qa-"$d".json manifest-"$d".json parity-"$d".json "SHA256SUMS-$d")
for f in "${files[@]}"; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done
tag="data-day-$d"
if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "release $tag already exists; a published day is never replaced" | tee -a "$summary"
  exit 0
fi
gh release create "$tag" --repo "$GITHUB_REPOSITORY" --prerelease --title "Historical data: $d" \
  --notes "Scanner units, strict QA report, decoder parity report and SHA256SUMS for UTC day $d, from .github/workflows/data-scan.yml at ${GITHUB_SHA:-unknown}. Format: docs/research/historical-data.md."
gh release upload "$tag" --repo "$GITHUB_REPOSITORY" -- "${files[@]}"
echo "published $tag (${#files[@]} files, $(du -cb "${files[@]}" | tail -1 | cut -f1) bytes)" | tee -a "$summary"
