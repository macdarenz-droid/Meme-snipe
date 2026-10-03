#!/usr/bin/bash
# Publishes one checked day as release data-day-DAY (called by the scan job of
# .github/workflows/data-scan.yml right after that day's QA, parity and determinism
# checks pass; the only step that sees the write token). The workflow runs it under
# `env -i` with a fixed PATH, so nothing an earlier step planted (GITHUB_ENV,
# GITHUB_PATH, BASH_ENV) reaches it; gh is called by absolute path.
#   publish-day.sh DAY ASSET_DIR
# The release is created with all its files in one call. An existing release is never
# edited: if its asset names and sizes equal this day's files it is accepted (exit 0),
# otherwise the step fails ("incomplete release, delete it to republish").
set -euo pipefail
GH=${GH_BIN:-/usr/bin/gh}
# The 2026-10-02 program upgrade is a regime boundary (supervisor ruling): that day and
# later are never published. Same constant as qa/verdict.mjs and the plan job.
REGIME_BOUNDARY_DAY=2026-10-02
d=$1 assets=$2
[[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $d"; exit 1; }
[[ "$d" < "$REGIME_BOUNDARY_DAY" ]] || { echo "refused: $d is on or after the regime boundary $REGIME_BOUNDARY_DAY"; exit 1; }
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
cd "$assets"
sums="SHA256SUMS-$d"
files=(units-"$d".tar.part* qa-"$d".md qa-"$d".json manifest-"$d".json parity-"$d".json)
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "missing $f"; exit 1; }
  grep -q "  $f\$" "$sums" || { echo "$f is not listed in $sums"; exit 1; }
done
sha256sum -c "$sums"
files+=("$sums")
tag="data-day-$d"
want=$(for f in "${files[@]}"; do echo "$f $(stat -c %s "$f")"; done | sort)
if "$GH" release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  have=$("$GH" release view "$tag" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[] | "\(.name) \(.size)"' | sort)
  if [ "$have" = "$want" ]; then
    echo "release $tag already exists with the same files; left unchanged" | tee -a "$summary"
    exit 0
  fi
  echo "incomplete release $tag (its assets differ from this day's files), delete it to republish" | tee -a "$summary"
  exit 1
fi
"$GH" release create "$tag" --repo "$GITHUB_REPOSITORY" --prerelease --title "Historical data: $d" \
  --notes "Scanner units, strict QA report, decoder parity report and SHA256SUMS for UTC day $d, from .github/workflows/data-scan.yml at ${GITHUB_SHA:-unknown}. Format: docs/research/historical-data.md." \
  -- "${files[@]}"
echo "published $tag (${#files[@]} files, $(du -cb "${files[@]}" | tail -1 | cut -f1) bytes)" | tee -a "$summary"
