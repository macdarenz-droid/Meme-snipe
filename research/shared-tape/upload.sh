#!/usr/bin/env bash
# Uploads a finished tape directory to the private store and reads it back
# (research/SHARED_TAPE_PLAN.md, P3 and DISK). Owner rule 2026-10-08: zeroed-data's
# existing data (main: reports/; rec-* releases) is never modified, moved or deleted.
# The tape lives only on its own branch, "tape", under tape/<DEST>/. Files above
# 95 MB are split into .partNNN pieces (GitHub refuses git files above 100 MB).
#   upload.sh SRC_DIR DEST REPO_DIR
#     SRC_DIR   local directory (every file in it is uploaded)
#     DEST      path under tape/, e.g. 2026-09-11/phase0 (a day, then optional parts)
#     REPO_DIR  a clone of macdarenz-droid/zeroed-data
# Exit 0 only when every file read back from a fresh clone matches its sha256.
set -euo pipefail
src=$1 dest=$2 repo=$3
branch=tape
part=95000000
[[ "$dest" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}(/[A-Za-z0-9._-]+)*$ ]] || { echo "refused: DEST '$dest' must be YYYY-MM-DD[/name...]" >&2; exit 2; }
[ -d "$src" ] || { echo "refused: $src is not a directory" >&2; exit 2; }
url=$(git -C "$repo" remote get-url origin)
[[ "$url" == *"macdarenz-droid/zeroed-data"* ]] || { echo "refused: $repo is not zeroed-data" >&2; exit 2; }
retry() { local n=0; until "$@"; do n=$((n+1)); [ $n -gt 4 ] && return 1; sleep $((2**n)); done; }

wt=$(mktemp -d)
cleanup() {
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
  git -C "$repo" branch -D "tape-new-$$" >/dev/null 2>&1 || true
}
trap cleanup EXIT
if retry git -C "$repo" fetch -q --depth 1 origin "$branch:refs/remotes/origin/$branch" 2>/dev/null; then
  git -C "$repo" worktree add -q --detach "$wt" "origin/$branch"
else
  # First upload: a new branch with no history shared with main, so main is untouched.
  git -C "$repo" worktree add -q --detach "$wt"
  git -C "$wt" checkout -q --orphan "tape-new-$$"
  git -C "$wt" rm -rq --cached . >/dev/null 2>&1 || true
  find "$wt" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
fi
out="$wt/tape/$dest"
[ ! -e "$out" ] || { echo "refused: tape/$dest already exists on $branch (never overwritten)" >&2; exit 2; }
mkdir -p "$out"
(cd "$src" && find . -name '*.tmp' -prune -o -type f -print | sed 's#^\./##' | LC_ALL=C sort) > "$wt/.files"
while IFS= read -r f; do
  mkdir -p "$out/$(dirname "$f")"
  size=$(stat -c %s "$src/$f")
  if [ "$size" -gt "$part" ]; then
    split -b "$part" -d -a 3 "$src/$f" "$out/$f.part"
  else
    cp "$src/$f" "$out/$f"
  fi
done < "$wt/.files"
(cd "$src" && xargs -d '\n' sha256sum < "$wt/.files") > "$out/SHA256SUMS"
rm -f "$wt/.files"
git -C "$wt" add -A tape
bad=$(git -C "$wt" diff --cached --name-only | grep -v '^tape/' || true)
[ -z "$bad" ] || { echo "refused: staged paths outside tape/: $bad" >&2; exit 2; }
git -C "$wt" -c user.name="zeroed tape" -c user.email="tape@invalid" commit -qm "tape: $dest"
pushed=
for i in 1 2 3 4 5; do
  if git -C "$wt" push -q origin "HEAD:refs/heads/$branch"; then pushed=1; break; fi
  # Someone else moved the branch: put this commit on top (never a force push).
  sleep $((2**i))
  if git -C "$wt" fetch -q --depth 1 origin "$branch:refs/remotes/origin/$branch" 2>/dev/null; then
    git -C "$wt" rebase -q "origin/$branch" || { echo "rebase onto origin/$branch failed" >&2; exit 1; }
  fi
done
[ -n "$pushed" ] || { echo "push failed" >&2; exit 1; }

# Read back from a fresh clone of the branch: every file's sha256 must match.
rb=$(mktemp -d)
trap 'cleanup; rm -rf "$rb"' EXIT
retry git clone -q --depth 1 --branch "$branch" --filter=blob:none --sparse "$url" "$rb/c"
git -C "$rb/c" sparse-checkout set "tape/$dest"
fails=0
while read -r sum f; do
  if [ -f "$rb/c/tape/$dest/$f" ]; then
    got=$(sha256sum < "$rb/c/tape/$dest/$f" | cut -d' ' -f1)
  else
    got=$(cat "$rb/c/tape/$dest/$f".part* 2>/dev/null | sha256sum | cut -d' ' -f1)
  fi
  [ "$got" = "$sum" ] || { echo "read-back mismatch: $f" >&2; fails=$((fails+1)); }
done < "$out/SHA256SUMS"
[ "$fails" -eq 0 ] || exit 1
echo "uploaded and read back: tape/$dest on $branch ($(wc -l < "$out/SHA256SUMS") files, commit $(git -C "$rb/c" rev-parse --short HEAD))"
