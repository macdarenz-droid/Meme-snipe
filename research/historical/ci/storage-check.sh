#!/usr/bin/bash
# STORAGE-CHECK (OF-4, research/z-h-estimate/OLD-FAITHFUL.md §3 "Storage stop after every
# batch"): run by the scan job after each stored day (a batch). Reads only the private
# store (--repo "$DATA_REPO", GH_TOKEN the store token):
#   stored  = the bytes of every release in the store (the K2 measurement releases, the
#             volume releases and any dataset included; drafts too, they hold bytes);
#   per day = the largest K3 day stored so far: a day release's own bytes, except that a
#             K2 measurement release (it carries pm01-subset-DAY.txt) counts as its
#             measured PM-01 subset, never its K2 size (batches 1 and 2 have no K3 day);
#   left    = the allow-listed days (ARCHIVE_DAYS) with no data-day-D or data-day-D-k3
#             release yet.
# When stored + left x per day > ARCHIVE_STORE_CAP_BYTES (0.5 TB), it writes the
# append-only marker: a published release with tag storage-stop in the store (never a
# draft: archive-guard.sh refuses on the tag, ag_store_ok), never edited or deleted here;
# only a reviewed change with the owner's OK clears it. Then it exits 3 (the batch fails,
# nothing chains, and the guard refuses every later dispatch). Exits 1 when the store
# cannot be read or no per-day figure exists (fail closed, no marker).
#   storage-check.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GH=${GH_BIN:-/usr/bin/gh}
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
say() { echo "storage: $*" | tee -a "$summary"; }
[[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { say "refused: DATA_REPO (the private store) is not set"; exit 1; }
this_repo=${GITHUB_REPOSITORY:-}
[[ "${DATA_REPO,,}" != "${this_repo,,}" ]] || { say "refused: DATA_REPO is this repository, not the private store"; exit 1; }
cap=${ARCHIVE_STORE_CAP_BYTES:-}
[[ "$cap" =~ ^[0-9]+$ ]] || { say "refused: ARCHIVE_STORE_CAP_BYTES is not set in archive-limits.conf"; exit 1; }
# tag, draft, bytes, asset names
rels=$("$GH" api --paginate "repos/$DATA_REPO/releases?per_page=100" \
  --jq '.[] | [.tag_name, (.draft | tostring), ([.assets[].size] | add // 0), ([.assets[].name] | join(","))] | @tsv' 2>/dev/null) ||
  { say "the private store's releases cannot be read: stopped (fail closed)"; exit 1; }
stored=0 perday=0 basis="" done_days=""
while IFS=$'\t' read -r tag draft bytes names; do
  [ -n "$tag" ] || continue
  [[ "$bytes" =~ ^[0-9]+$ ]] || { say "release $tag reports no size: stopped (fail closed)"; exit 1; }
  stored=$(( stored + bytes ))
  [[ "$tag" =~ ^data-day-([0-9]{4}-[0-9]{2}-[0-9]{2})(-k3)?$ ]] || continue
  [ "$draft" = false ] || continue
  d=${BASH_REMATCH[1]}
  done_days+="$d"$'\n'
  if [[ ",$names," == *",pm01-subset-$d.txt,"* ]]; then
    tmp=$(mktemp -d)
    "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "pm01-subset-$d.txt" --dir "$tmp" >/dev/null 2>&1 ||
      { rm -rf "$tmp"; say "pm01-subset-$d.txt of $tag cannot be read: stopped (fail closed)"; exit 1; }
    n=$(tr -d '[:space:]' < "$tmp/pm01-subset-$d.txt"); rm -rf "$tmp"
    [[ "$n" =~ ^[0-9]+$ ]] || { say "pm01-subset-$d.txt of $tag is not a byte count: stopped (fail closed)"; exit 1; }
    (( n > perday )) && { perday=$n; basis="$tag (K2: its measured PM-01 subset)"; }
  else
    (( bytes > perday )) && { perday=$bytes; basis="$tag"; }
  fi
done <<< "$rels"
days=$(ag_days) || { say "ARCHIVE_DAYS in archive-limits.conf is malformed: stopped"; exit 1; }
left=$(grep -cvxF -f <(printf '%s' "$done_days" | grep . || echo none) <<< "$days" || true)
(( perday > 0 )) || { say "no stored day gives a per-day size yet: stopped (fail closed)"; exit 1; }
proj=$(( stored + left * perday ))
say "stored $stored bytes + $left days left x $perday bytes ($basis) = $proj bytes (cap $cap)"
(( proj > cap )) || exit 0
# The marker is judged the way archive-guard.sh judges it (ag_store_ok): the published tag
# storage-stop. A draft release has no tag, so it never counts and a published one is made.
refs=$("$GH" api "repos/$DATA_REPO/git/matching-refs/tags/storage-stop" --jq '.[].ref' 2>/dev/null) ||
  { say "the storage-stop marker cannot be read; the batch fails anyway"; exit 3; }
if grep -qx 'refs/tags/storage-stop' <<< "$refs"; then
  say "the storage-stop marker is already in the store"
else
  "$GH" release create storage-stop --repo "$DATA_REPO" --title "Storage stop" \
    --notes "Projected storage $proj bytes is above the owner's cap $cap (0.5 TB): stored $stored + $left days x $perday ($basis). The archive chain stops; only a reviewed change with the owner's OK removes this release and its tag." >/dev/null ||
    { say "the storage-stop marker could not be written; the batch fails anyway"; exit 3; }
  say "wrote the storage-stop marker in the private store"
fi
say "projection above the cap: the chain stops and the owner is asked"
exit 3
