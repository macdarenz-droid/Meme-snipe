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
# release_state TAG DAY: "complete", "absent", or "incomplete: <why>", judged only from
# the release itself (never from local files, whose QA reports change on every rerun):
# not a draft, every asset uploaded, and the asset names equal the expected set, with
# the part count taken from the release's own SHA256SUMS-DAY.
release_state() {
  local tag=$1 day=$2 info tmp want have
  local err
  err=$(mktemp)
  if ! info=$("$GH" release view "$tag" --repo "$GITHUB_REPOSITORY" --json isDraft,assets \
    --jq '"draft \(.isDraft)", (.assets[] | "asset \(.name) \(.state)")' 2>"$err"); then
    # Only a missing release is "absent"; any other gh error (auth, network, rate
    # limit) is an error, never a reason to publish.
    if grep -qi "release not found" "$err"; then echo absent; else echo "error: $(tr '\n' ' ' < "$err")"; fi
    rm -f "$err"
    return
  fi
  rm -f "$err"
  grep -qx "draft false" <<<"$info" || { echo "incomplete: draft release"; return; }
  if grep '^asset ' <<<"$info" | grep -vq ' uploaded$'; then echo "incomplete: an asset is not fully uploaded"; return; fi
  tmp=$(mktemp -d)
  "$GH" release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "SHA256SUMS-$day" --dir "$tmp" >/dev/null 2>&1 ||
    { rm -rf "$tmp"; echo "incomplete: no SHA256SUMS-$day"; return; }
  want=$( { awk '{print $2}' "$tmp/SHA256SUMS-$day" | grep -E "^units-$day\.tar\.part[0-9]+\$" || true
            printf '%s\n' "events-$day.tar" "qa-$day.md" "qa-$day.json" "manifest-$day.json" "parity-$day.json" "SHA256SUMS-$day"; } | sort)
  rm -rf "$tmp"
  have=$(grep '^asset ' <<<"$info" | awk '{print $2}' | sort)
  grep -q "^units-$day\.tar\.part" <<<"$want" || { echo "incomplete: SHA256SUMS-$day lists no tar part"; return; }
  [ "$have" = "$want" ] || { echo "incomplete: assets differ from the expected set"; return; }
  echo complete
}

if [ "${1:-}" = --check ]; then
  # --check DAY: is data-day-DAY published and complete? Writes complete=true|false to
  # $GITHUB_OUTPUT (when set) so the scan job can skip a published day before any read.
  d=$2
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $d"; exit 1; }
  st=$(release_state "data-day-$d" "$d")
  echo "data-day-$d: $st"
  case "$st" in
    complete) echo "complete=true" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0 ;;
    absent) echo "complete=false" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0 ;;
    *) echo "data-day-$d is incomplete; delete it to republish"; exit 1 ;;
  esac
fi

d=$1 assets=$2
[[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $d"; exit 1; }
[[ "$d" < "$REGIME_BOUNDARY_DAY" ]] || { echo "refused: $d is on or after the regime boundary $REGIME_BOUNDARY_DAY"; exit 1; }
# DATA-PUB: a day read over RPC (source helius) is never published. Its units carry raw
# getBlock responses, which may not leave the actions cache; the manifest names each
# unit's source, and an RPC unit's root_cid is "rpc:getBlock" (rpcscan/rpcunit.go).
if grep -Eq '"root_cid": *"rpc:' "$assets/manifest-$d.json" 2>/dev/null; then
  echo "refused: manifest-$d.json lists units read over RPC (raw provider responses are never published)"; exit 1
fi
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
cd "$assets"
sums="SHA256SUMS-$d"
files=(units-"$d".tar.part* events-"$d".tar qa-"$d".md qa-"$d".json manifest-"$d".json parity-"$d".json)
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "missing $f"; exit 1; }
  grep -q "  $f\$" "$sums" || { echo "$f is not listed in $sums"; exit 1; }
done
sha256sum -c --strict "$sums"
files+=("$sums")
tag="data-day-$d"
st=$(release_state "$tag" "$d")
case "$st" in
  complete) echo "release $tag is already published and complete; left unchanged" | tee -a "$summary"; exit 0 ;;
  absent) ;;
  *) echo "$tag exists but is $st; delete it to republish (never edited here)" | tee -a "$summary"; exit 1 ;;
esac
"$GH" release create "$tag" --repo "$GITHUB_REPOSITORY" --prerelease --title "Historical data: $d" \
  --notes "Scanner units, strict QA report, decoder parity report and SHA256SUMS for UTC day $d, from .github/workflows/data-scan.yml at ${GITHUB_SHA:-unknown}. Format: docs/research/historical-data.md." \
  -- "${files[@]}"
echo "published $tag (${#files[@]} files, $(du -cb "${files[@]}" | tail -1 | cut -f1) bytes)" | tee -a "$summary"
