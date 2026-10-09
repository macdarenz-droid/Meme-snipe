#!/usr/bin/bash
# K3-FETCH (OF-6 ruling 12, OF-3's scope): the first step of data-scan.yml's k3 mode,
# which turns a measurement day stored at K2 (data-day-DAY, the first two allow-listed
# days) into data-day-DAY-k3 once ARCHIVE_RETENTION records K3, before batch 3. Nothing is
# read from the archive: the day comes back from the private store.
#   k3-fetch.sh DAY OUT
# Refuses unless DAY is one of the first two allow-listed days and its retention value is
# K3. If data-day-DAY-k3 is already done (complete and read back, release-state.sh), it
# writes done=true to $GITHUB_OUTPUT and does nothing else; any other state of it stops
# for review. data-day-DAY must be done. Its units tar parts, units-DAY.log, list-DAY.txt
# and SHA256SUMS-DAY are downloaded and each checked against that SHA256SUMS; every unit
# line of the per-unit log must be K2. The tar may hold only regular files and directories
# under units/EPOCH/RANGE (extracted with --no-same-owner --no-overwrite-dir). The units
# the day took from the day before ("from" lines) are left out: margin-fetch.sh brings
# their K3 copies from data-day-<D-1>-k3 (ruling 6). The others go to OUT/units, each
# recorded K2; the stored list goes to OUT/list-DAY.txt (the trim keeps it) and
# OUT/k2-list-DAY.txt (the list the -k3 release must carry, checked after the trim).
# Run in a clean env -i step with the store token (GH_TOKEN). Fails closed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GH=${GH_BIN:-/usr/bin/gh}
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
output=${GITHUB_OUTPUT:-/dev/null}
[[ $# -eq 2 ]] || { echo "usage: k3-fetch.sh DAY OUT" >&2; exit 2; }
day=$1 out=$2
[[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$(date -u -d "$day" +%F 2>/dev/null)" == "$day" ]] || { echo "bad day '$day'" >&2; exit 2; }
[[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "refused: DATA_REPO (the private store) is not set"; exit 1; }
this_repo=${GITHUB_REPOSITORY:-}
[[ "${DATA_REPO,,}" != "${this_repo,,}" ]] || { echo "refused: DATA_REPO is this repository, not the private store"; exit 1; }
fail() { echo "k3: $*; $day is not trimmed (fail closed)" | tee -a "$summary"; exit 1; }
days=$(ag_days) || fail "ARCHIVE_DAYS in archive-limits.conf is malformed"
first2=$(head -2 <<< "$days")
grep -qx "$day" <<< "$first2" || fail "$day is not one of the two measurement days (the first two allow-listed days)"
[[ "$(ag_retention "$day")" == K3 ]] || fail "the retention value for $day is not K3 (ARCHIVE_RETENTION records K3 before batch 3)"
st=$(release_state "data-day-$day-k3" "$day")
case "$st" in
  done) echo "done=true" >> "$output"; echo "k3: data-day-$day-k3 is already stored and read back; nothing to do" | tee -a "$summary"; exit 0 ;;
  absent) ;;
  *) fail "data-day-$day-k3 exists but is not done ($st); stopped for review" ;;
esac
st=$(release_state "data-day-$day" "$day")
[[ "$st" == done ]] || fail "data-day-$day is not done ($st)"
mkdir -p "$out"
tmp=$(mktemp -d -p "$(dirname "$out")")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/dl" "$tmp/x"
"$GH" release download "data-day-$day" --repo "$DATA_REPO" --pattern "units-$day.tar.part*" --pattern "units-$day.log" \
  --pattern "list-$day.txt" --pattern "SHA256SUMS-$day" --dir "$tmp/dl" >/dev/null 2>&1 || fail "data-day-$day cannot be downloaded"
sums="$tmp/dl/SHA256SUMS-$day"
[[ -f "$sums" && -f "$tmp/dl/units-$day.log" && -f "$tmp/dl/list-$day.txt" ]] || fail "data-day-$day lacks units-$day.log, list-$day.txt or SHA256SUMS-$day"
parts=$(awk '{print $2}' "$sums" | grep -E "^units-$day\.tar\.part[0-9]+$" | LC_ALL=C sort) || true
[[ -n "$parts" ]] || fail "SHA256SUMS-$day lists no tar part"
for f in $parts "units-$day.log" "list-$day.txt"; do
  want=$(awk -v f="$f" '$2 == f { print $1 }' "$sums"); got=$(sha256sum "$tmp/dl/$f" 2>/dev/null | cut -d' ' -f1)
  [[ -n "$want" && "$want" == "$got" ]] || fail "$f does not match SHA256SUMS-$day"
done
# the per-unit log: every unit line K2; the "from" units (taken from the day before)
units=$(grep -E '^[0-9]+/[0-9]+-[0-9]+ ' "$tmp/dl/units-$day.log" || true)
[[ -n "$units" ]] || fail "units-$day.log lists no unit"
awk 'NF != 4 || $3 != "K2" { bad = 1 } END { exit bad }' <<< "$units" || fail "units-$day.log holds a unit line that is not K2"
taken=$(awk '$1 == "from" {print $2}' "$tmp/dl/units-$day.log")
# the tar: regular files and directories only, under units/EPOCH/RANGE
(cd "$tmp/dl" && cat $parts) > "$tmp/units.tar"
rm -f "$tmp"/dl/units-"$day".tar.part*
members=$(tar -tvf "$tmp/units.tar") || fail "the units tar of $day cannot be listed"
while IFS= read -r m; do
  [[ -z "$m" || "${m:0:1}" == - || "${m:0:1}" == d ]] || fail "the units tar of $day holds a member that is not a regular file or a directory (${m:0:1})"
done <<< "$members"
names=$(tar -tf "$tmp/units.tar")
while IFS= read -r m; do
  [[ -z "$m" || "$m" =~ ^units/?$ || "$m" =~ ^units/[0-9]+/?$ || "$m" =~ ^units/[0-9]+/[0-9]+-[0-9]+(/[A-Za-z0-9._-]+)?/?$ ]] || fail "the units tar of $day holds a path outside units/EPOCH/RANGE ($m)"
done <<< "$names"
tar -xf "$tmp/units.tar" -C "$tmp/x" --no-same-owner --no-overwrite-dir
rm -f "$tmp/units.tar"
mkdir -p "$out/units"
n=0 left=0
for u in "$tmp"/x/units/*/*; do
  [[ -d "$u" ]] || continue
  rel="$(basename "$(dirname "$u")")/$(basename "$u")"
  grep -q "^$rel " <<< "$units" || fail "$rel is in the units tar but not in units-$day.log"
  if grep -qxF "$rel" <<< "$taken"; then left=$((left + 1)); continue; fi
  grep -q '"retention": *"K2"' "$u/stats.json" 2>/dev/null || fail "$rel is not recorded K2"
  [[ ! -e "$out/units/$rel" ]] || fail "$out/units/$rel exists already"
  mkdir -p "$out/units/$(dirname "$rel")"; mv "$u" "$out/units/$rel"; n=$((n + 1))
done
(( n > 0 )) || fail "data-day-$day holds no unit of its own"
cp "$tmp/dl/list-$day.txt" "$out/list-$day.txt"
cp "$tmp/dl/list-$day.txt" "$out/k2-list-$day.txt"
echo "done=false" >> "$output"
echo "k3: $day's $n K2 units come back from data-day-$day ($left taken from the day before left for their K3 copies); none is read from the archive" | tee -a "$summary"
