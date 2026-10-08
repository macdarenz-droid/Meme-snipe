#!/usr/bin/bash
# PRIOR-FETCH (OF-5; OF-3 rulings 11, 18, 19, 23): hands day D the day before's pinned list
# from the private store. It downloads list-<D-1>.txt and SHA256SUMS-<D-1> from the
# read-done release of D-1 (data-day-<D-1>, else data-day-<D-1>-k3; never this repository)
# into DIR and writes list=<path> and sums=<path> to $GITHUB_OUTPUT, which the scan job
# hands to the scan (scan-day.sh) and the trim (trim-day.sh) as ARCHIVE_PRIOR_LIST and
# ARCHIVE_PRIOR_SUMS. Both are empty for the first allow-listed day, which needs no prior.
# The sha256 check is archive-guard.sh prior (ag_prior_ok), run by both scripts. Run in a
# clean env -i step with the store token (GH_TOKEN). Fails closed: a store it cannot read,
# or a release of D-1 without either file, writes no output and exits 1.
#   prior-fetch.sh DAY DIR
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GH=${GH_BIN:-/usr/bin/gh}
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
out=${GITHUB_OUTPUT:-/dev/null}
[[ $# -eq 2 ]] || { echo "usage: prior-fetch.sh DAY DIR" >&2; exit 2; }
day=$1 dir=$2
[[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$(date -u -d "$day" +%F 2>/dev/null)" == "$day" ]] || { echo "bad day '$day'" >&2; exit 2; }
[[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "refused: DATA_REPO (the private store) is not set"; exit 1; }
this_repo=${GITHUB_REPOSITORY:-}
[[ "${DATA_REPO,,}" != "${this_repo,,}" ]] || { echo "refused: DATA_REPO is this repository, not the private store"; exit 1; }
first=$(ag_first_day)
[[ -n "$first" ]] || { echo "refused: ARCHIVE_DAYS in archive-limits.conf is malformed"; exit 1; }
if [[ "$day" == "$first" ]]; then
  printf 'list=\nsums=\n' >> "$out"
  echo "prior: $day is the first allow-listed day; it needs no prior list" | tee -a "$summary"
  exit 0
fi
prev=$(date -u -d "$day - 1 day" +%F)
list="$dir/list-$prev.txt" sums="$dir/SHA256SUMS-$prev"
mkdir -p "$dir"; rm -f "$list" "$sums"
for tag in "data-day-$prev" "data-day-$prev-k3"; do
  "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "list-$prev.txt" --pattern "SHA256SUMS-$prev" --dir "$dir" >/dev/null 2>&1 || true
  [[ -f "$list" && -f "$sums" ]] && break
  rm -f "$list" "$sums"
done
[[ -f "$list" && -f "$sums" ]] ||
  { echo "prior: the private store holds no read-done release of $prev with list-$prev.txt and SHA256SUMS-$prev (or cannot be read); $day is not read (fail closed)" | tee -a "$summary"; exit 1; }
printf 'list=%s\nsums=%s\n' "$list" "$sums" >> "$out"
echo "prior: $day gets list-$prev.txt from $tag" | tee -a "$summary"
