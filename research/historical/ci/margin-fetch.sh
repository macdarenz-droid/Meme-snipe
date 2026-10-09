#!/usr/bin/bash
# MARGIN-FETCH (OF-6, docs/reviews/OF6.md rulings 1 and 2): the units day D shares with the
# day before (D-1's forward margin) are taken from D-1's stored release, never read from
# the archive again. It downloads margin-<D-1>.tar and SHA256SUMS-<D-1> from the read-done
# release of D-1 (data-day-<D-1>, else data-day-<D-1>-k3; never this repository), checks the
# tar's sha256 against that SHA256SUMS and every member's path, and moves each unit into
# OUT/units/EPOCH/RANGE (a unit already there, from a resumed run, is left as it is). Each
# taken unit is listed in OUT/from-store.txt ("EPOCH/RANGE TAG"), so the scanner skips it
# (its stats.json is there), the trim passes it through untouched and the per-unit log
# carries "from EPOCH/RANGE TAG" for it. The first allow-listed day takes nothing. Run in
# a clean env -i step with the store token (GH_TOKEN), before the scan. Fails closed: a
# store it cannot read, a release without the tar, a sha256 mismatch or a bad member path
# takes nothing and exits 1, so the day is not read.
#   margin-fetch.sh DAY OUT
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GH=${GH_BIN:-/usr/bin/gh}
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
[[ $# -eq 2 ]] || { echo "usage: margin-fetch.sh DAY OUT" >&2; exit 2; }
day=$1 out=$2
[[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$(date -u -d "$day" +%F 2>/dev/null)" == "$day" ]] || { echo "bad day '$day'" >&2; exit 2; }
[[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "refused: DATA_REPO (the private store) is not set"; exit 1; }
this_repo=${GITHUB_REPOSITORY:-}
[[ "${DATA_REPO,,}" != "${this_repo,,}" ]] || { echo "refused: DATA_REPO is this repository, not the private store"; exit 1; }
days=$(ag_days) || { echo "refused: ARCHIVE_DAYS in archive-limits.conf is malformed"; exit 1; }
first=${days%%$'\n'*}
if [[ "$day" == "$first" ]]; then
  echo "margin: $day is the first allow-listed day; nothing to take from the store" | tee -a "$summary"
  exit 0
fi
prev=$(date -u -d "$day - 1 day" +%F)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "margin: $*; $day is not read (fail closed)" | tee -a "$summary"; exit 1; }
tag=""
for t in "data-day-$prev" "data-day-$prev-k3"; do
  rm -f "$tmp/margin-$prev.tar" "$tmp/SHA256SUMS-$prev"
  "$GH" release download "$t" --repo "$DATA_REPO" --pattern "margin-$prev.tar" --pattern "SHA256SUMS-$prev" --dir "$tmp" >/dev/null 2>&1 || true
  if [[ -f "$tmp/margin-$prev.tar" && -f "$tmp/SHA256SUMS-$prev" ]]; then tag=$t; break; fi
done
[[ -n "$tag" ]] || fail "the private store holds no read-done release of $prev with margin-$prev.tar and SHA256SUMS-$prev (or cannot be read)"
want=$(awk -v f="margin-$prev.tar" '$2 == f { print $1 }' "$tmp/SHA256SUMS-$prev")
got=$(sha256sum "$tmp/margin-$prev.tar" | cut -d' ' -f1)
[[ -n "$want" && "$want" == "$got" ]] || fail "margin-$prev.tar does not match SHA256SUMS-$prev of $tag"
members=$(tar -tf "$tmp/margin-$prev.tar") || fail "margin-$prev.tar cannot be listed"
while IFS= read -r m; do
  [[ -z "$m" || "$m" =~ ^units/[0-9]+/[0-9]+-[0-9]+(/[A-Za-z0-9._-]+)?/?$ ]] || fail "margin-$prev.tar holds a path outside units/EPOCH/RANGE ($m)"
done <<< "$members"
mkdir -p "$tmp/x" "$out/units"
tar -xf "$tmp/margin-$prev.tar" -C "$tmp/x"
touch "$out/from-store.txt"
n=0 kept=0
for u in "$tmp"/x/units/*/*; do
  [[ -d "$u" ]] || continue
  [[ -f "$u/stats.json" ]] || fail "margin-$prev.tar holds $u without stats.json"
  rel="$(basename "$(dirname "$u")")/$(basename "$u")"
  if [[ -e "$out/units/$rel" ]]; then kept=$((kept + 1)); else mkdir -p "$out/units/$(dirname "$rel")"; mv "$u" "$out/units/$rel"; n=$((n + 1)); fi
  grep -qx "$rel $tag" "$out/from-store.txt" || echo "$rel $tag" >> "$out/from-store.txt"
done
echo "margin: $day takes $n units of $prev from $tag ($kept already there); none is read from the archive" | tee -a "$summary"
