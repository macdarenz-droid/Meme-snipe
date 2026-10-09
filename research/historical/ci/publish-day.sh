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
# (rescan-DAY.sha256, list-DAY.txt, pm01-subset-DAY.txt, and OF-6's margin-DAY.tar). An existing release is never
# edited: if its asset names equal this day's files it is accepted, otherwise the step
# fails ("incomplete release, delete it to republish"). Then every asset is read back
# (downloaded one at a time and checked against the release's own SHA256SUMS-DAY, which
# must equal this run's when this run created it); any mismatch fails the step, so the
# progress cache is kept (nothing deletes it before a read-back passed).
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
# release_state TAG DAY and marker_text: release-state.sh (shared with archive-guard.sh).
# shellcheck source=release-state.sh
. "$(cd "$(dirname "$0")" && pwd)/release-state.sh"

if [ "${1:-}" = --check ]; then
  # --check DAY: is DAY read done in the private store (OF-5: a data-day-DAY or
  # data-day-DAY-k3 release that is done, its readback-ok marker included (ruling 1); a
  # release in this repository never counts)? Writes complete=true|false to
  # $GITHUB_OUTPUT (when set) so the scan job skips a stored day before any read. Any
  # store error, an incomplete release, or a complete one without the marker (its
  # read-back never passed: stopped for review, never read again automatically) fails
  # the step.
  d=$2
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $d"; exit 1; }
  done=false
  for tag in "data-day-$d" "data-day-$d-k3"; do
    st=$(release_state "$tag" "$d")
    echo "$tag: $st"
    case "$st" in
      done) done=true ;;
      absent) ;;
      complete) echo "$tag carries no readback-ok-$d marker (its read-back never passed); stopped for review, never read again automatically"; exit 1 ;;
      *) echo "$tag is not complete or cannot be read; delete it to republish (fail closed)"; exit 1 ;;
    esac
  done
  echo "complete=$done" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
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
for f in rescan-"$d".sha256 list-"$d".txt pm01-subset-"$d".txt margin-"$d".tar; do grep -q "  $f\$" "$sums" && files+=("$f"); done
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "missing $f"; exit 1; }
  grep -q "  $f\$" "$sums" || { echo "$f is not listed in $sums"; exit 1; }
done
sha256sum -c --strict "$sums"
files+=("$sums")
tag="data-day-$d"
st=$(release_state "$tag" "$d")
case "$st" in
  done) echo "release $tag is already stored and read back; left unchanged" | tee -a "$summary" ;;
  complete) echo "release $tag carries no readback-ok-$d marker (its read-back never passed); stopped for review, never edited or read again here" | tee -a "$summary"; exit 1 ;;
  absent)
    "$GH" release create "$tag" --repo "$DATA_REPO" --prerelease --title "Historical data: $d" \
      --notes "Scanner units, strict QA report, decoder parity report, per-unit log and SHA256SUMS for UTC day $d, from .github/workflows/data-scan.yml at ${GITHUB_SHA:-unknown}. Format: docs/research/historical-data.md." \
      -- "${files[@]}"
    echo "stored $tag in the private store (${#files[@]} files, $(du -cb "${files[@]}" | tail -1 | cut -f1) bytes)" | tee -a "$summary"
    # OF-4 ruling 9: what was created must be complete (every asset uploaded, names equal
    # to its SHA256SUMS set) before any read-back can pass.
    st=$(release_state "$tag" "$d")
    [ "$st" = complete ] || { echo "read-back: $tag is $st after create; the progress cache is kept" | tee -a "$summary"; exit 1; }
    st=created ;;
  *) echo "$tag exists but is $st; delete it to republish (never edited here)" | tee -a "$summary"; exit 1 ;;
esac
# OF-4 read-back, against the release's own SHA256SUMS-DAY (a complete release from an
# earlier run keeps its own QA files, which a rerun's differ from): that file is read
# first, and when this run created the release it must equal the local one; then every
# other stored asset, one at a time (the disk holds one extra copy at most), must hash
# to its line in it. Any mismatch or failed download fails the step.
rb=$(mktemp -d)
fail_rb() { rm -rf "$rb"; echo "read-back: $*; the progress cache is kept" | tee -a "$summary"; exit 1; }
"$GH" release download "$tag" --repo "$DATA_REPO" --pattern "$sums" --dir "$rb" >/dev/null 2>&1 && [ -f "$rb/$sums" ] ||
  fail_rb "$sums could not be downloaded from $tag"
[ "$st" = done ] || cmp -s "$rb/$sums" "$sums" || fail_rb "the stored $sums differs from this run's"
mv "$rb/$sums" "$rb/.sums"
names=$("$GH" release view "$tag" --repo "$DATA_REPO" --json assets --jq '.assets[].name' 2>/dev/null) || fail_rb "the assets of $tag cannot be listed"
n=0
while IFS= read -r f; do
  [ -n "$f" ] && [ "$f" != "$sums" ] && [ "$f" != "readback-ok-$d" ] || continue
  "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "$f" --dir "$rb" >/dev/null 2>&1 && [ -f "$rb/$f" ] ||
    fail_rb "$f could not be downloaded from $tag"
  want=$(awk -v f="$f" '$2 == f {print $1}' "$rb/.sums"); got=$(sha256sum "$rb/$f" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$got" ] || fail_rb "$f does not match $sums"
  rm -f "$rb/$f"; n=$((n + 1))
done <<< "$names"
# OF-5 ruling 1: only now, every asset read back, the release gets its readback-ok-DAY
# marker (listed after SHA256SUMS), which is itself read back; a release stored earlier
# already carries it (release_state checked its content).
mk=$(marker_text "$tag" "$rb/.sums")
if [ "$st" = created ]; then
  printf '%s' "$mk" > "$rb/readback-ok-$d"
  "$GH" release upload "$tag" --repo "$DATA_REPO" -- "$rb/readback-ok-$d" >/dev/null 2>&1 || fail_rb "the readback-ok-$d marker could not be stored in $tag"
  rm -f "$rb/readback-ok-$d"
fi
"$GH" release download "$tag" --repo "$DATA_REPO" --pattern "readback-ok-$d" --dir "$rb" >/dev/null 2>&1 && [ -f "$rb/readback-ok-$d" ] ||
  fail_rb "the readback-ok-$d marker could not be read back from $tag"
[ "$(cat "$rb/readback-ok-$d")" = "${mk%$'\n'}" ] || fail_rb "the readback-ok-$d marker in $tag does not match"
[ "$(release_state "$tag" "$d")" = done ] || fail_rb "$tag is not done after its marker was stored"
rm -rf "$rb"
echo "read back $tag: $n files match its $sums; readback-ok-$d stored and read back" | tee -a "$summary"
echo "readback=true" >> "${GITHUB_OUTPUT:-/dev/null}"
