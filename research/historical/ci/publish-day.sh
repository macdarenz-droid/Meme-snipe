#!/usr/bin/bash
# Stores one checked day as release data-day-DAY in the private store (called by the scan
# job of .github/workflows/data-scan.yml right after that day's QA, parity and determinism
# checks pass; with the store token, in that step alone). OF-4 (nothing public): every
# release call names --repo "$DATA_REPO" (zeroed-data, private), never this repository;
# GH_TOKEN is the store token. The workflow runs it under `env -i` with a fixed PATH, so
# nothing an earlier step planted (GITHUB_ENV, GITHUB_PATH, BASH_ENV) reaches it; gh is
# called by absolute path.
#   publish-day.sh DAY ASSET_DIR
# The release is created with all its files in one call: the parts, events, QA, manifest,
# parity, the per-unit log units-DAY.log (OF-4) and whatever else SHA256SUMS-DAY lists
# (rescan-DAY.sha256, list-DAY.txt, pm01-subset-DAY.txt). An existing release is never
# edited: if its asset names equal this day's files it is accepted, otherwise the step
# fails ("incomplete release, delete it to republish"). Then every asset is read back
# (downloaded one at a time and checked against the local SHA256SUMS-DAY); any mismatch
# fails the step, so the progress cache is kept (the delete step runs only after it).
# On success it writes readback=true to $GITHUB_OUTPUT.
set -euo pipefail
GH=${GH_BIN:-/usr/bin/gh}
# OF-4: the private store only.
[[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "refused: DATA_REPO (the private store) is not set"; exit 1; }
this_repo=${GITHUB_REPOSITORY:-}
[[ "${DATA_REPO,,}" != "${this_repo,,}" ]] ||
  { echo "refused: DATA_REPO is this repository, not the private store"; exit 1; }
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
  if ! info=$("$GH" release view "$tag" --repo "$DATA_REPO" --json isDraft,assets \
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
  "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "SHA256SUMS-$day" --dir "$tmp" >/dev/null 2>&1 ||
    { rm -rf "$tmp"; echo "incomplete: no SHA256SUMS-$day"; return; }
  want=$( { awk '{print $2}' "$tmp/SHA256SUMS-$day" | grep -E "^(units-$day\.tar\.part[0-9]+|rescan-$day\.sha256|list-$day\.txt|pm01-subset-$day\.txt)\$" || true
            printf '%s\n' "events-$day.tar" "qa-$day.md" "qa-$day.json" "manifest-$day.json" "parity-$day.json" "units-$day.log" "SHA256SUMS-$day"; } | sort)
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
files=(units-"$d".tar.part* events-"$d".tar qa-"$d".md qa-"$d".json manifest-"$d".json parity-"$d".json units-"$d".log)
# the optional OF-3 files ride along when SHA256SUMS lists them
for f in rescan-"$d".sha256 list-"$d".txt pm01-subset-"$d".txt; do grep -q "  $f\$" "$sums" && files+=("$f"); done
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "missing $f"; exit 1; }
  grep -q "  $f\$" "$sums" || { echo "$f is not listed in $sums"; exit 1; }
done
sha256sum -c --strict "$sums"
files+=("$sums")
tag="data-day-$d"
st=$(release_state "$tag" "$d")
case "$st" in
  complete) echo "release $tag is already stored and complete; left unchanged" | tee -a "$summary" ;;
  absent)
    "$GH" release create "$tag" --repo "$DATA_REPO" --prerelease --title "Historical data: $d" \
      --notes "Scanner units, strict QA report, decoder parity report, per-unit log and SHA256SUMS for UTC day $d, from .github/workflows/data-scan.yml at ${GITHUB_SHA:-unknown}. Format: docs/research/historical-data.md." \
      -- "${files[@]}"
    echo "stored $tag in the private store (${#files[@]} files, $(du -cb "${files[@]}" | tail -1 | cut -f1) bytes)" | tee -a "$summary" ;;
  *) echo "$tag exists but is $st; delete it to republish (never edited here)" | tee -a "$summary"; exit 1 ;;
esac
# OF-4 read-back: every stored asset, one at a time (the disk holds one extra copy at
# most), must hash to its line in the local SHA256SUMS-DAY, and the stored SHA256SUMS-DAY
# must equal the local one. Any mismatch or failed download fails the step.
rb=$(mktemp -d)
for f in "${files[@]}"; do
  "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "$f" --dir "$rb" >/dev/null 2>&1 && [ -f "$rb/$f" ] ||
    { rm -rf "$rb"; echo "read-back: $f could not be downloaded from $tag; the progress cache is kept" | tee -a "$summary"; exit 1; }
  if [ "$f" = "$sums" ]; then cmp -s "$rb/$f" "$sums" || { rm -rf "$rb"; echo "read-back: the stored $sums differs; the progress cache is kept" | tee -a "$summary"; exit 1; }
  else
    want=$(awk -v f="$f" '$2 == f {print $1}' "$sums"); got=$(sha256sum "$rb/$f" | cut -d' ' -f1)
    [ -n "$want" ] && [ "$want" = "$got" ] || { rm -rf "$rb"; echo "read-back: $f does not match $sums; the progress cache is kept" | tee -a "$summary"; exit 1; }
  fi
  rm -f "$rb/$f"
done
rm -rf "$rb"
echo "read back $tag: ${#files[@]} files match $sums" | tee -a "$summary"
echo "readback=true" >> "${GITHUB_OUTPUT:-/dev/null}"
