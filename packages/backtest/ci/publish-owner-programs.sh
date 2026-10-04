#!/usr/bin/bash
# BT-1e: publishes the owner-program supplement as release owner-programs-DAY (DAY = the UTC day it was fetched), from
# the publish job of .github/workflows/owner-programs.yml, the only step that sees the write token. Same rules as
# research/historical/ci/publish-day.sh and publish-volume.sh: run under env -i with gh by absolute path; the release is
# created with all its files in one call; an existing release is never edited (the same supplement is accepted, anything
# else fails: delete it to republish).
#   publish-owner-programs.sh ASSET_DIR
# ASSET_DIR holds owner-programs.jsonl, owner-programs.manifest.json and SHA256SUMS, from the fetch job.
set -euo pipefail
export LC_ALL=C # file names compare in byte order
GH=${GH_BIN:-/usr/bin/gh}
die() { echo "publish-owner-programs: $*" >&2; exit 1; }
(( $# == 1 )) || die "usage: publish-owner-programs.sh ASSET_DIR"
assets=$1
[[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is not set"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
cd "$assets"
files=(owner-programs.jsonl owner-programs.manifest.json SHA256SUMS)
[[ "$(ls -A | sort | tr '\n' ' ')" == "SHA256SUMS owner-programs.jsonl owner-programs.manifest.json " ]] || die "expected exactly ${files[*]} in $assets"
sha256sum -c --quiet SHA256SUMS || die "SHA256SUMS does not match"
[[ "$(awk '{print $2}' SHA256SUMS | sort | tr '\n' ' ')" == "owner-programs.jsonl owner-programs.manifest.json " ]] || die "SHA256SUMS must list exactly the supplement and its manifest"
# The manifest must describe this file: its hash and row count, a provider name (never a URL), and its datasets.
jq -e --arg sha "$(sha256sum owner-programs.jsonl | cut -c1-64)" --argjson rows "$(grep -c '' owner-programs.jsonl || true)" '
  .file == "owner-programs.jsonl" and .sha256 == $sha and .rows == $rows and .accounts == $rows
  and (.calls | type == "number") and (.source | type == "string" and test("^[a-z0-9 ._-]{1,40}$"))
  and (.fetchedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
  and (.datasets | type == "array" and length > 0 and all(.[]; (.tag | test("^data-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and (.manifestSha256 | test("^[0-9a-f]{64}$"))))
' owner-programs.manifest.json >/dev/null || die "owner-programs.manifest.json does not describe owner-programs.jsonl (hash, rows, source, datasets)"
day=$(jq -r '.fetchedAt[0:10]' owner-programs.manifest.json)
tag="owner-programs-$day"
err=$(mktemp)
if info=$("$GH" release view "$tag" --repo "$GITHUB_REPOSITORY" --json isDraft --jq '"draft \(.isDraft)"' 2>"$err"); then
  rm -f "$err"
  tmp=$(mktemp -d)
  if [[ "$info" == "draft false" ]] && "$GH" release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern owner-programs.jsonl --dir "$tmp" >/dev/null 2>&1 &&
    cmp -s "$tmp/owner-programs.jsonl" owner-programs.jsonl; then
    rm -rf "$tmp"
    echo "release $tag is already published with the same supplement; left unchanged" | tee -a "$summary"
    exit 0
  fi
  rm -rf "$tmp"
  echo "$tag exists with other content; delete it to republish (never edited here)" | tee -a "$summary"
  exit 1
fi
grep -qi "release not found" "$err" || { echo "gh error: $(tr '\n' ' ' < "$err")"; rm -f "$err"; exit 1; }
rm -f "$err"
datasets=$(jq -r '[.datasets[].tag] | join(", ")' owner-programs.manifest.json)
"$GH" release create "$tag" --repo "$GITHUB_REPOSITORY" --prerelease --title "Owner programs: $day" \
  --notes "The program that owns each off-curve holder owner in $datasets ($(jq -r .rows owner-programs.manifest.json) owners, $(jq -r .calls owner-programs.manifest.json) getMultipleAccounts calls, $(jq -r .source owner-programs.manifest.json)). From .github/workflows/owner-programs.yml at ${GITHUB_SHA:-unknown}. Format: packages/backtest/src/dataset/owner-programs.ts." \
  -- "${files[@]}"
echo "published $tag" | tee -a "$summary"
