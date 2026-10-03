#!/usr/bin/env bash
# Publishes zeroed-preview.apk as the single asset of the "preview" prerelease without ever leaving the
# fixed link dead: the new file is uploaded under a temporary name first, and only after that succeeds
# is the old asset swapped out (renamed aside, replaced, then deleted; renamed back if the swap fails).
# The tag move and the notes edit come last, so a failed upload changes nothing.
# Needs: gh on PATH (GH_TOKEN set), GH_REPO, GITHUB_SHA, VERSION_NAME, and zeroed-preview.apk in the
# current directory. Tested with a stubbed gh in apps/web/test/publish-preview.test.ts.
set -euo pipefail

: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${VERSION_NAME:?}"
ASSET=zeroed-preview.apk
NEXT="$ASSET.next"
PREV="$ASSET.prev"

# gh prints the 404 body to stdout on a missing ref, so only trust the output when the call
# succeeds and is a commit sha.
tag_sha() {
  local out
  if out="$(gh api "repos/$GH_REPO/git/ref/tags/preview" --jq .object.sha 2>/dev/null)" && [[ "$out" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$out"
  fi
}

# Id of the release asset with this name, or nothing.
asset_id() {
  gh api "repos/$GH_REPO/releases/tags/preview" --jq '.assets[] | "\(.name) \(.id)"' 2>/dev/null | awk -v n="$1" '$1 == n { print $2 }'
}

rename_asset() { # id new-name
  gh api -X PATCH "repos/$GH_REPO/releases/assets/$1" -f name="$2" > /dev/null
}

old="$(tag_sha)"
subject="$(gh api "repos/$GH_REPO/commits/$GITHUB_SHA" --jq '.commit.message | split("\n")[0]')"
{
  echo "Preview build $VERSION_NAME, commit \`$GITHUB_SHA\`."
  echo
  echo "Latest: $subject"
  if [ -n "$old" ] && [ "$old" != "$GITHUB_SHA" ]; then
    echo
    echo "Changes since the previous preview:"
    gh api "repos/$GH_REPO/compare/$old...$GITHUB_SHA" \
      --jq '.commits[] | "- " + .sha[0:7] + " " + (.commit.message | split("\n")[0])' | head -40 || true
  fi
  echo
  echo "Sample numbers in this build are made up and carry a \"Sample data\" marker."
} > notes.md

if gh release view preview > /dev/null 2>&1; then
  # Recover from a run that stopped between the two renames.
  if [ -z "$(asset_id "$ASSET")" ] && [ -n "$(asset_id "$PREV")" ]; then rename_asset "$(asset_id "$PREV")" "$ASSET"; fi
  # Clear leftovers of an earlier failed run.
  for stale in "$NEXT" "$PREV"; do
    id="$(asset_id "$stale")"
    if [ -n "$id" ]; then gh api -X DELETE "repos/$GH_REPO/releases/assets/$id" > /dev/null; fi
  done

  # 1. Upload under a temporary name. A failure here stops the script with the old asset untouched.
  cp "$ASSET" "$NEXT"
  gh release upload preview "$NEXT"
  rm -f "$NEXT"

  # 2. Swap. The old asset is renamed aside, the new one takes the fixed name, then the old one is deleted.
  next_id="$(asset_id "$NEXT")"
  old_id="$(asset_id "$ASSET")"
  if [ -n "$old_id" ]; then rename_asset "$old_id" "$PREV"; fi
  if ! rename_asset "$next_id" "$ASSET"; then
    if [ -n "$old_id" ]; then rename_asset "$old_id" "$ASSET"; fi
    echo "Could not give the new build the fixed name; the previous asset was put back." >&2
    exit 1
  fi
  if [ -n "$old_id" ]; then gh api -X DELETE "repos/$GH_REPO/releases/assets/$old_id" > /dev/null; fi

  # 3. Only now move the tag and update the notes.
  cur="$(tag_sha)"
  if [ -z "$cur" ]; then
    gh api -X POST "repos/$GH_REPO/git/refs" -f ref=refs/tags/preview -f sha="$GITHUB_SHA" > /dev/null
  elif [ "$cur" != "$GITHUB_SHA" ]; then
    gh api -X PATCH "repos/$GH_REPO/git/refs/tags/preview" -f sha="$GITHUB_SHA" -F force=true > /dev/null
  fi
  gh release edit preview --prerelease --title "Zeroed preview" --notes-file notes.md
else
  # First release: nothing exists to lose. The release is created with the asset and, if the tag is
  # missing, creates it at this commit.
  gh release create preview "$ASSET" --prerelease --title "Zeroed preview" --notes-file notes.md --target "$GITHUB_SHA"
  cur="$(tag_sha)"
  if [ -n "$cur" ] && [ "$cur" != "$GITHUB_SHA" ]; then
    gh api -X PATCH "repos/$GH_REPO/git/refs/tags/preview" -f sha="$GITHUB_SHA" -F force=true > /dev/null
  fi
fi

gh release view preview --json assets --jq '.assets[] | .name + " " + (.size|tostring)'
