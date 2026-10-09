#!/usr/bin/bash
# MARGIN-FETCH (OF-6, docs/reviews/OF6.md rulings 1 and 2): the units day D shares with the
# day before (D-1's forward margin) are taken from D-1's stored release, never read from
# the archive again. It downloads margin-<D-1>.tar and SHA256SUMS-<D-1> from the read-done
# release of D-1 (data-day-<D-1>, else data-day-<D-1>-k3; never this repository), checks the
# tar's sha256 against that SHA256SUMS and every member's path, and moves each unit into
# OUT/units/EPOCH/RANGE (a unit already there, from a resumed run, is left as it is). Each
# taken unit is listed in OUT/from-store.txt ("EPOCH/RANGE TAG"), so the scanner skips it
# (its stats.json is there), the trim passes it through untouched and the per-unit log
# carries "from EPOCH/RANGE TAG" for it. Round 2: the release must be done and its margin
# units at D's own retention (ruling 6: a K3 day after a K2 day takes data-day-<D-1>-k3,
# else is refused); the tar holds only regular files and directories, extracted with
# --no-same-owner --no-overwrite-dir (ruling 8); D-1's stored units (its units-<D-1>.log)
# go to OUT/prev-units.txt, which scan-day hands to the scanner (ruling 9). The first allow-listed day takes nothing. Run in
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
# OF-6 ruling 11: OUT/prev-day.txt records whether the store holds the day before
# ("none D-1", or its tags); only the head of ARCHIVE_DAYS with none takes nothing (and
# scan-day and trim-day exempt it from the prior list and -stored).
prev=$(date -u -d "$day - 1 day" +%F)
pd=$(ag_prev_day "$day" "$GH") || { echo "margin: the private store cannot be read; $day is not read (fail closed)" | tee -a "$summary"; exit 1; }
mkdir -p "$out"; echo "$pd $prev" > "$out/prev-day.txt"
if [[ "$day" == "$first" && "$pd" == none ]]; then
  echo "margin: $day heads the allow-list and the store holds no release of $prev; nothing to take" | tee -a "$summary"
  exit 0
fi
# OF-6 ruling 6: the taken units must carry D's own retention (finalize refuses a mixed
# day, and assemble's midnight merge needs both days' copies equal). A K3 day takes from
# data-day-<D-1>-k3 (D-1 read at K2 and trimmed), else from data-day-<D-1> only when that
# release's units are K3; a K2 day the other way round. No such release: refused before
# any archive read; the chain holds until the -k3 release exists.
ret=$(ag_retention "$day")
[[ "$ret" == K2 || "$ret" == K3 ]] || { echo "margin: $day has no retention value; it is not read" | tee -a "$summary"; exit 1; }
if [[ "$ret" == K3 ]]; then tags=("data-day-$prev-k3" "data-day-$prev"); else tags=("data-day-$prev" "data-day-$prev-k3"); fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "margin: $*; $day is not read (fail closed)" | tee -a "$summary"; exit 1; }
tag="" why=""
for t in "${tags[@]}"; do
  st=$(release_state "$t" "$prev")
  case "$st" in
    absent) continue ;;
    done) ;;
    *) fail "$t is not done ($st); stopped for review" ;;
  esac
  rm -rf "$tmp/x" "$tmp/dl"; mkdir -p "$tmp/x" "$tmp/dl"
  "$GH" release download "$t" --repo "$DATA_REPO" --pattern "margin-$prev.tar" --pattern "SHA256SUMS-$prev" --pattern "units-$prev.log" --dir "$tmp/dl" >/dev/null 2>&1 || true
  [[ -f "$tmp/dl/margin-$prev.tar" && -f "$tmp/dl/SHA256SUMS-$prev" && -f "$tmp/dl/units-$prev.log" ]] ||
    fail "$t lacks margin-$prev.tar, SHA256SUMS-$prev or units-$prev.log (or cannot be read)"
  for f in "margin-$prev.tar" "units-$prev.log"; do
    want=$(awk -v f="$f" '$2 == f { print $1 }' "$tmp/dl/SHA256SUMS-$prev"); got=$(sha256sum "$tmp/dl/$f" | cut -d' ' -f1)
    [[ -n "$want" && "$want" == "$got" ]] || fail "$f does not match SHA256SUMS-$prev of $t"
  done
  # OF-6 ruling 8: only regular files and directories, under units/EPOCH/RANGE
  members=$(tar -tvf "$tmp/dl/margin-$prev.tar") || fail "margin-$prev.tar cannot be listed"
  while IFS= read -r m; do
    [[ -z "$m" || "${m:0:1}" == - || "${m:0:1}" == d ]] || fail "margin-$prev.tar holds a member that is not a regular file or a directory (${m:0:1})"
  done <<< "$members"
  names=$(tar -tf "$tmp/dl/margin-$prev.tar") || fail "margin-$prev.tar cannot be listed"
  while IFS= read -r m; do
    [[ -z "$m" || "$m" =~ ^units/[0-9]+/[0-9]+-[0-9]+(/[A-Za-z0-9._-]+)?/?$ ]] || fail "margin-$prev.tar holds a path outside units/EPOCH/RANGE ($m)"
  done <<< "$names"
  tar -xf "$tmp/dl/margin-$prev.tar" -C "$tmp/x" --no-same-owner --no-overwrite-dir
  bad=0
  for u in "$tmp"/x/units/*/*; do
    [[ -d "$u" ]] || continue
    [[ -f "$u/stats.json" ]] || fail "margin-$prev.tar holds $u without stats.json"
    r=$(sed -n 's/.*"retention": *"\([^"]*\)".*/\1/p' "$u/stats.json" | head -1)
    [[ "$r" == "$ret" ]] || bad=1
  done
  if (( bad )); then why+=" $t holds units of another retention;"; continue; fi
  tag=$t; break
done
[[ -n "$tag" ]] ||
  fail "the private store holds no done release of $prev whose margin units are at $day's retention $ret (${why# }; a K3 day after a K2 day waits for data-day-$prev-k3)"
# OF-6 ruling 9: D-1's stored units, so the scanner refuses a planned unit among them that
# was not taken (a drift between the two time estimates never causes a second read).
mkdir -p "$out"
{ grep -E '^[0-9]+/[0-9]+-[0-9]+ ' "$tmp/dl/units-$prev.log" || true; } | awk '{print $1}' | LC_ALL=C sort -u > "$out/prev-units.tmp"
[[ -s "$out/prev-units.tmp" ]] || fail "units-$prev.log of $tag lists no unit"
mkdir -p "$out/units"
touch "$out/from-store.txt"
n=0 kept=0
for u in "$tmp"/x/units/*/*; do
  [[ -d "$u" ]] || continue
  rel="$(basename "$(dirname "$u")")/$(basename "$u")"
  if [[ -e "$out/units/$rel" ]]; then kept=$((kept + 1)); else mkdir -p "$out/units/$(dirname "$rel")"; mv "$u" "$out/units/$rel"; n=$((n + 1)); fi
  grep -qx "$rel $tag" "$out/from-store.txt" || echo "$rel $tag" >> "$out/from-store.txt"
done
mv "$out/prev-units.tmp" "$out/prev-units.txt"
echo "margin: $day ($ret) takes $n units of $prev from $tag ($kept already there); none is read from the archive" | tee -a "$summary"
