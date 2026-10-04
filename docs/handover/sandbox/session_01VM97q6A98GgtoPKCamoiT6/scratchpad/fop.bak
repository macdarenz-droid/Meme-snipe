#!/usr/bin/env bash
# BT-1f: downloads a published owner-program supplement (release `owner-programs-DAY`, made by owner-programs.yml) for a
# backtest, and keeps it only when every check passes; readOwnerPrograms (src/dataset/owner-programs.ts) then reads it.
#   fetch-owner-programs.sh TAG DIR
# Checks, before DIR exists:
#   - the release is by github-actions[bot], published (not a draft), a prerelease, and holds exactly SHA256SUMS,
#     owner-programs.jsonl and owner-programs.manifest.json, each uploaded with a sha256 digest;
#   - every downloaded file matches its asset digest, and SHA256SUMS lists exactly the two data files and verifies;
#   - the manifest names owner-programs.jsonl with its sha256 and row count, and was fetched on the tag's day.
# Read-only: REST calls through gh (GH_TOKEN with contents: read is enough); nothing is written outside DIR's parent.
set -euo pipefail
export LC_ALL=C
GH=${GH_BIN:-gh}
die() { echo "fetch-owner-programs: $*" >&2; exit 1; }

(( $# == 2 )) || die "usage: fetch-owner-programs.sh TAG DIR"
tag=$1 dir=$2
[[ "$tag" =~ ^owner-programs-([0-9]{4}-[0-9]{2}-[0-9]{2})$ ]] || die "'$tag' is not an owner-program release (owner-programs-YYYY-MM-DD)"
day=${BASH_REMATCH[1]}
[[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is not set"
[[ ! -e "$dir" ]] || die "$dir already exists"
files="SHA256SUMS owner-programs.jsonl owner-programs.manifest.json"

meta=$("$GH" api "repos/$GITHUB_REPOSITORY/releases/tags/$tag") || die "release $tag not found"
jq -e --arg files "$files" '
  .author.login == "github-actions[bot]" and .draft == false and .prerelease == true
  and ([.assets[].name] | sort | join(" ")) == $files
  and all(.assets[]; .state == "uploaded" and ((.digest // "") | test("^sha256:[0-9a-f]{64}$")))' <<<"$meta" >/dev/null ||
  die "release $tag is not a published owner-program release of this repository's workflow (author, draft, prerelease, assets or digests)"

part="$dir.partial"
rm -rf "$part"
mkdir -p "$part"
trap 'rm -rf "$part"' EXIT
while read -r id name digest; do
  "$GH" api -H 'Accept: application/octet-stream' "repos/$GITHUB_REPOSITORY/releases/assets/$id" > "$part/$name" || die "$name: download failed"
  [[ "sha256:$(sha256sum "$part/$name" | cut -c1-64)" == "$digest" ]] || die "$name does not match its asset digest"
done < <(jq -r '.assets[] | "\(.id) \(.name) \(.digest)"' <<<"$meta")

[[ "$(awk '{print $2}' "$part/SHA256SUMS" | sort | tr '\n' ' ')" == "owner-programs.jsonl owner-programs.manifest.json " ]] ||
  die "SHA256SUMS must list exactly owner-programs.jsonl and owner-programs.manifest.json"
(cd "$part" && sha256sum -c --quiet SHA256SUMS) || die "a file does not match SHA256SUMS"
sha=$(sha256sum "$part/owner-programs.jsonl" | cut -c1-64)
rows=$(grep -c '' "$part/owner-programs.jsonl" || true)
jq -e --arg sha "$sha" --argjson rows "$rows" --arg day "$day" '
  .file == "owner-programs.jsonl" and .sha256 == $sha and .rows == $rows and (.fetchedAt | startswith($day))' \
  "$part/owner-programs.manifest.json" >/dev/null || die "the manifest does not match owner-programs.jsonl or the tag's day"

mv "$part" "$dir"
trap - EXIT
echo "fetch-owner-programs: $tag ($rows owners) in $dir"
