#!/usr/bin/env bash
# BT-1e: collects the off-curve owners of published dataset releases for the owner-program supplement
# (.github/workflows/owner-programs.yml, its fetch job; no write token, no RPC key).
#   owner-programs-collect.sh OUT_DIR WORK_DIR TAG [TAG ...]
# Each TAG is a dataset release `data-FROM-TO` (built from the data-day releases by data-scan.yml mode=assemble). One
# release at a time: it must be published by github-actions[bot] and not be a draft; its assets are downloaded into
# WORK_DIR, checked against its SHA256SUMS by the script, read, and deleted before the next one. Writes:
#   OUT_DIR/owners.txt      every off-curve owner, sorted and unique
#   OUT_DIR/datasets.json   [{tag, manifestSha256}] in the order given
set -euo pipefail
export LC_ALL=C # owners sort in byte order, as the script sorts them
GH=${GH_BIN:-gh}
NODE=${NODE_BIN:-node}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/../scripts/owner-programs.ts"
die() { echo "owner-programs-collect: $*" >&2; exit 1; }

(( $# >= 3 )) || die "usage: owner-programs-collect.sh OUT_DIR WORK_DIR TAG [TAG ...]"
out=$1 work=$2
shift 2
[[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is not set"
mkdir -p "$out" "$work"
: > "$out/owners.all"
sources="[]"
declare -A seen=()
for tag in "$@"; do
  [[ "$tag" =~ ^data-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "'$tag' is not a dataset release (data-YYYY-MM-DD-YYYY-MM-DD)"
  [[ -z "${seen[$tag]:-}" ]] || die "$tag is listed twice"
  seen[$tag]=1
  info=$("$GH" release view "$tag" --repo "$GITHUB_REPOSITORY" --json author,isDraft --jq '"\(.author.login) \(.isDraft)"') || die "release $tag not found"
  [[ "$info" == "github-actions[bot] false" ]] || die "release $tag is not a published release of this repository's workflow ($info)"
  dir="$work/$tag"
  rm -rf "$dir"
  mkdir -p "$dir"
  "$GH" release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$dir" >/dev/null
  [[ -f "$dir/SHA256SUMS" && -f "$dir/manifest.json" ]] || die "release $tag has no SHA256SUMS or manifest.json"
  # The script checks every file against SHA256SUMS before it reads a row.
  "$NODE" --no-warnings "$script" owners --dataset "$dir" >> "$out/owners.all"
  sha=$(sha256sum "$dir/manifest.json" | cut -c1-64)
  sources=$(jq -c --arg t "$tag" --arg s "$sha" '. + [{tag: $t, manifestSha256: $s}]' <<<"$sources")
  echo "$tag: $(sort -u "$out/owners.all" | wc -l) owners so far"
  rm -rf "$dir"
done
sort -u "$out/owners.all" > "$out/owners.txt"
rm -f "$out/owners.all"
printf '%s\n' "$sources" > "$out/datasets.json"
echo "owners: $(wc -l < "$out/owners.txt") from $# dataset release(s)"
