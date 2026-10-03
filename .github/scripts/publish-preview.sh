#!/usr/bin/env bash
# Moves the "preview" tag to the built commit and replaces the single asset on the "preview" prerelease.
# Needs: gh on PATH (GH_TOKEN set), GH_REPO, GITHUB_SHA, VERSION_NAME, and zeroed-preview.apk in the
# current directory. Tested with a stubbed gh in apps/web/test/publish-preview.test.ts.
set -euo pipefail

: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${VERSION_NAME:?}"

# gh prints the 404 body to stdout on a missing ref, so only trust the output when the call
# succeeds and is a commit sha.
if out="$(gh api "repos/$GH_REPO/git/ref/tags/preview" --jq .object.sha 2>/dev/null)" && [[ "$out" =~ ^[0-9a-f]{40}$ ]]; then
  old="$out"
else
  old=""
fi

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

if [ -n "$old" ]; then
  gh api -X PATCH "repos/$GH_REPO/git/refs/tags/preview" -f sha="$GITHUB_SHA" -F force=true > /dev/null
else
  gh api -X POST "repos/$GH_REPO/git/refs" -f ref=refs/tags/preview -f sha="$GITHUB_SHA" > /dev/null
fi

if gh release view preview > /dev/null 2>&1; then
  gh release edit preview --prerelease --title "Zeroed preview" --notes-file notes.md
else
  gh release create preview --prerelease --title "Zeroed preview" --notes-file notes.md --verify-tag
fi
gh release upload preview zeroed-preview.apk --clobber
gh release view preview --json assets --jq '.assets[] | .name + " " + (.size|tostring)'
