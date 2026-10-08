#!/usr/bin/env bash
# Builds the multi-day dataset FROM..TO (TO exclusive) from the per-day releases
# `data-day-YYYY-MM-DD` and publishes it as release `data-FROM-TO`
# (used by .github/workflows/data-scan.yml, mode=assemble).
#   assemble.sh FROM TO OUT_DIR
# Environment:
#   GITHUB_REPOSITORY  owner/repo of the releases (required)
#   GH_TOKEN           token for gh (the workflow's publish job)
#   MAX_WINDOW_DAYS    largest window in days (default 3: units keep every curve and canonical-pool
#                      trade, about 6.4-8.5 GB a day, so a runner holds about three days with the dataset)
#   ALLOW_REVISIONS    optional comma list passed to finalize as -allow-revisions
#   GITHUB_SHA         recorded in the release notes
# Steps, one day at a time so the disk holds one day's parts at most:
#   1. every lead-in day (FROM-14 .. FROM-1) and every window day must have a day
#      release, or the script stops before downloading anything; no earlier day is read;
#   2. per day: free-space guard (3x the day's tar + 10 GB), download parts and
#      SHA256SUMS, verify, extract (lead-in days: only the small events-DAY.tar asset,
#      which holds each unit's events, stats and block rows),
#      delete the parts, move each unit into OUT_DIR/data/units/EPOCH/RANGE. A unit that
#      crosses midnight arrives twice: every *.zst present in both copies must have the
#      same sha256, and its two stats.json must agree on epoch, slots, blocks, schema and
#      scanner revision (two revisions both in ALLOW_REVISIONS are accepted; the first copy
#      is kept), else stop; files only the new copy has are moved in;
#   3. free-space guard (finalize_guard: 2x the extracted units + 10 GB), finalize,
#      strict QA, decoder parity, then the release directory is built by
#      moving files (never copying), checksummed and published.
set -euo pipefail

LEAD_IN_DAYS=14
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../../.." && pwd)

die() { echo "assemble: $*" >&2; exit 1; }

# check_window FROM TO: valid UTC days, FROM < TO, TO-FROM <= MAX_WINDOW_DAYS.
check_window() {
  local from=$1 to=$2 max=${MAX_WINDOW_DAYS:-3} f t
  [[ "$from" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$to" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    die "from and to must be UTC days (YYYY-MM-DD), got '$from' and '$to'"
  f=$(date -u -d "$from" +%s) || die "bad day $from"
  t=$(date -u -d "$to" +%s) || die "bad day $to"
  [[ $(date -u -d "@$f" +%F) == "$from" && $(date -u -d "@$t" +%F) == "$to" ]] || die "bad day $from or $to"
  (( t > f )) || die "to ($to) must be after from ($from)"
  local days=$(( (t - f) / 86400 ))
  (( days <= max )) || die "window $from..$to is $days days; the limit is $max (MAX_WINDOW_DAYS), split it into smaller windows"
}

# day_list FROM TO: lead-in days then window days, oldest first, one per line.
day_list() {
  local from=$1 to=$2 d
  d=$(date -u -d "$from - $LEAD_IN_DAYS days" +%F)
  while [[ "$d" < "$to" ]]; do
    echo "$d"
    d=$(date -u -d "$d + 1 day" +%F)
  done
}

# tar_bytes DAY PREFIX: total size of the day's assets whose names start with PREFIX
# (units-DAY.tar.part for window days, events-DAY.tar for lead-in days); fails when none.
tar_bytes() {
  local day=$1 prefix=$2 n
  n=$(gh release view "data-day-$day" --repo "$GITHUB_REPOSITORY" --json assets \
    --jq "[.assets[] | select(.name | startswith(\"$prefix\")) | .size] | if length == 0 then -1 else add end") ||
    die "release data-day-$day is missing (every lead-in and window day is required)"
  [[ "$n" =~ ^[0-9]+$ ]] || die "release data-day-$day has no $prefix* asset"
  echo "$n"
}

# free_guard DIR TAR_BYTES: free space on DIR's volume must be >= 3x the tar + 10 GB.
free_guard() {
  local dir=$1 tar=$2 avail need
  avail=$(df -B1 --output=avail "$dir" | tail -1 | tr -d ' ')
  need=$(( 3 * tar + 10 * 1000 * 1000 * 1000 ))
  (( avail >= need )) || die "not enough disk on $dir: $avail bytes free, need $need (3 x $tar + 10 GB)"
}

# stats_match A B: two stats.json copies of one unit describe the same scan. They are
# written at scan time, so seconds, finished_at and the HTTP counters differ between the
# two days' scans; the identity fields below must not. scanner_revision may differ only
# when both values are listed in ALLOW_REVISIONS (the window then spans a revision
# boundary that finalize also accepts); every data file must still hash equal
# (merge_unit).
stats_match() {
  ALLOW_REVISIONS="${ALLOW_REVISIONS:-}" python3 - "$1" "$2" <<'PY'
import json, os, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
allowed = set(filter(None, os.environ["ALLOW_REVISIONS"].split(",")))
keys = ("epoch", "from_slot", "to_slot", "blocks", "schema", "scanner_revision")
def same(k):
    if k not in a or k not in b:
        return False
    if k == "scanner_revision" and a[k] != b[k]:
        return a[k] in allowed and b[k] in allowed
    return a[k] == b[k]
bad = [k for k in keys if not same(k)]
if bad:
    sys.exit("stats.json differs in " + ", ".join(f"{k} ({a.get(k)!r} vs {b.get(k)!r})" for k in bad))
PY
}

# finalize_guard WORK: finalize reads OUT_DIR/data/units and writes the dataset next to
# them; the release directory is then built by moving files, so it adds nothing.
# Bound: free space >= 2 x the extracted units' size + 10 GB, i.e. room for a dataset
# as large as the units it is built from, the same again as margin, and 10 GB for
# temp files and QA output.
finalize_guard() {
  local work=$1 units avail need
  units=$(du -sb "$work/data/units" | cut -f1)
  avail=$(df -B1 --output=avail "$work" | tail -1 | tr -d ' ')
  need=$(( 2 * units + 10 * 1000 * 1000 * 1000 ))
  (( avail >= need )) || die "not enough disk on $work for finalize: $avail bytes free, need $need (2 x $units units + 10 GB)"
}

# merge_unit SRC DST: move unit dir SRC to DST. If DST exists (a unit crossing
# midnight arrives with both days): every *.zst (and any other data file) in both copies
# must hash the same; stats.json keeps the first copy and must match on the identity
# fields (stats_match); files only in SRC are moved in; SRC is then removed.
merge_unit() {
  local src=$1 dst=$2 f name a b why
  if [[ ! -e "$dst" ]]; then
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"
    return 0
  fi
  for f in "$src"/*; do
    [[ -e "$f" ]] || continue
    name=$(basename "$f")
    if [[ ! -e "$dst/$name" ]]; then
      mv "$f" "$dst/$name"
      continue
    fi
    if [[ "$name" == stats.json ]]; then
      why=$(stats_match "$dst/$name" "$f" 2>&1) || die "unit ${dst#*/units/} differs between days: $why"
    else
      a=$(sha256sum "$f" | cut -d' ' -f1)
      b=$(sha256sum "$dst/$name" | cut -d' ' -f1)
      [[ "$a" == "$b" ]] || die "unit ${dst#*/units/} differs between days in $name ($a vs $b)"
    fi
    rm -f "$f"
  done
  rmdir "$src"
}

# fetch_day DAY LEADIN(0|1) WORK DATA: download, verify, extract, merge one day.
fetch_day() {
  local day=$1 leadin=$2 work=$3 data=$4 dl x u rel
  dl="$work/dl-$day"; x="$dl/x"
  rm -rf "$dl"; mkdir -p "$x"
  if (( leadin )); then
    # Lead-in days need only events, stats and block rows: the day's small events asset.
    gh release download "data-day-$day" --repo "$GITHUB_REPOSITORY" --dir "$dl" \
      --pattern "events-$day.tar" --pattern "SHA256SUMS-$day"
    [[ -f "$dl/events-$day.tar" ]] || die "day $day: no events-$day.tar in its release"
    (cd "$dl" && grep -E "  events-$day\.tar$" "SHA256SUMS-$day" | sha256sum -c --quiet -) || die "day $day: events asset checksum mismatch"
    tar -xf "$dl/events-$day.tar" -C "$x"
    rm -f "$dl/events-$day.tar"
  else
    fetch_parts "$day" "$dl" "$x"
  fi
  [[ -d "$x/units" ]] || die "day $day: no units/ in its tar"
  while IFS= read -r u; do
    rel=${u#"$x/units/"}
    merge_unit "$u" "$data/units/$rel"
  done < <(find "$x/units" -mindepth 2 -maxdepth 2 -type d | sort)
  rm -rf "$dl"
}

# fetch_parts DAY DL X: download, verify and extract the day's full units tar parts.
fetch_parts() {
  local day=$1 dl=$2 x=$3 parts listed
  gh release download "data-day-$day" --repo "$GITHUB_REPOSITORY" --dir "$dl" \
    --pattern "units-$day.tar.part*" --pattern "SHA256SUMS-$day"
  parts=$(find "$dl" -maxdepth 1 -name "units-$day.tar.part*" | wc -l)
  listed=$(grep -cE "  units-$day\.tar\.part[0-9]+$" "$dl/SHA256SUMS-$day" || true)
  (( parts > 0 && parts == listed )) || die "day $day: $parts parts downloaded, $listed listed in SHA256SUMS-$day"
  (cd "$dl" && grep -E "  units-$day\.tar\.part[0-9]+$" "SHA256SUMS-$day" | sha256sum -c --quiet -) ||
    die "day $day: checksum mismatch"
  cat "$dl"/units-"$day".tar.part* | tar -xf - -C "$x"
  rm -f "$dl"/units-"$day".tar.part*
}

# build_release DATASET REL: move the dataset files flat into REL and checksum them.
build_release() {
  local ds=$1 rel=$2 f day n
  mkdir -p "$rel"
  while IFS= read -r f; do
    day=$(echo "${f#"$ds/days/"}" | cut -d/ -f1)
    mv "$f" "$rel/${day}__$(basename "$f")"
  done < <(find "$ds/days" -type f | sort)
  mv "$ds/manifest.json" "$rel/"
  for f in "$ds"/mints-*.csv.zst; do [[ -e "$f" ]] && mv "$f" "$rel/"; done
  mv "$ds/qa/report.md" "$rel/qa-report.md"
  mv "$ds/qa/report.json" "$rel/qa-report.json"
  mv "$ds/qa/parity.json" "$rel/parity.json"
  (cd "$rel" && sha256sum -- * > SHA256SUMS)
  n=$(find "$rel" -maxdepth 1 -type f | wc -l)
  (( n <= 990 )) || die "release would hold $n assets; GitHub allows 1000 (limit here 990): use a smaller window"
}

main() {
  (( $# == 3 )) || die "usage: assemble.sh FROM TO OUT_DIR"
  local from=$1 to=$2 work=$3 day leadin bytes tag
  [[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is not set"
  check_window "$from" "$to"
  local -a extra=()
  if [[ -n "${ALLOW_REVISIONS:-}" ]]; then
    [[ "$ALLOW_REVISIONS" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || die "ALLOW_REVISIONS must be a comma list of revisions, got '$ALLOW_REVISIONS'"
    extra=(-allow-revisions "$ALLOW_REVISIONS")
  fi
  ! gh release view "data-$from-$to" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 ||
    die "release data-$from-$to already exists; a published dataset is never replaced"
  mkdir -p "$work/data/units"
  local -a days
  mapfile -t days < <(day_list "$from" "$to")
  # Every required day must exist before any download.
  local -A size
  for day in "${days[@]}"; do
    if [[ "$day" < "$from" ]]; then size[$day]=$(tar_bytes "$day" "events-$day.tar"); else size[$day]=$(tar_bytes "$day" "units-$day.tar.part"); fi
  done
  echo "assemble: $from..$to with lead-in from ${days[0]}: ${#days[@]} day releases found"
  for day in "${days[@]}"; do
    leadin=0; [[ "$day" < "$from" ]] && leadin=1
    bytes=${size[$day]}
    free_guard "$work" "$bytes"
    echo "assemble: day $day ($bytes bytes, lead-in=$leadin)"
    fetch_day "$day" "$leadin" "$work" "$work/data"
  done
  finalize_guard "$work"
  # OF-2 round 4, ruling 23: finalize and QA output go to $qlog, not the public log.
  local qlog="${RUNNER_TEMP:?}/assemble-log"; mkdir -p "$qlog"
  zeroed-scan finalize -out "$work/data" -dataset "$work/dataset" -from "$from" -to "$to" \
    -part-mb 1900 -lead-in-days "$LEAD_IN_DAYS" -regimes "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../regimes.json" "${extra[@]}" > "$qlog/finalize.log" 2>&1 ||
    die "finalize failed; its output is in $qlog"
  node "$repo_root/research/historical/qa/check.mjs" "$work/dataset" --live 60 --strict > "$qlog/qa.log" 2>&1 || die "strict QA failed; its output is in $qlog"
  node --no-warnings "$repo_root/research/historical/qa/parity.ts" "$work/dataset" > "$qlog/parity.log" 2>&1 || die "decoder parity failed; its output is in $qlog"
  build_release "$work/dataset" "$work/release"
  tag="data-$from-$to"
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --prerelease --title "Historical dataset $from to $to" \
    --notes "Built by data-scan.yml at ${GITHUB_SHA:-unknown} from releases data-day-${days[0]} .. data-day-${days[-1]} (14 lead-in days). Strict QA and decoder parity passed (qa-report.md, parity.json). Format: docs/research/historical-data.md."
  (cd "$work/release" && gh release upload "$tag" --repo "$GITHUB_REPOSITORY" -- *)
  echo "assemble: published $tag"
}

# Sourcing the script (tests) only defines the functions.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
