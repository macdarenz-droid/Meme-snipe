#!/usr/bin/env bash
# ARCHIVE-GUARD (OF-2, research/z-h-estimate/OLD-FAITHFUL.md §2): the one place that says
# whether a day may be read from the Old Faithful archive. Every entry point uses it
# before any archive request: archive-check.sh, the data-scan plan job, scan-day.sh and
# check-day.sh. Values come from archive-limits.conf (ARCHIVE_DAYS, HELIUS_DAYS,
# ARCHIVE_ARM, ARCHIVE_REARM_AT, ARCHIVE_RETENTION) and the pinned B10-PULL row in
# docs/DECISIONS.md; nothing else picks them.
#
#   archive-guard.sh local DAY        the checks that need no token: DAY is in
#       ARCHIVE_DAYS and not in HELIUS_DAYS; the chain is armed (ARCHIVE_ARM is the pinned
#       B10-PULL id); ARCHIVE_REARM_AT is a valid past UTC time; DAY has a retention value.
#       Prints the retention (K2 or K3).
#   archive-guard.sh entry DAY        local, plus a fresh pass of the guard step
#       (ag_attested); what scan-day.sh and check-day.sh run. Prints the retention.
#   archive-guard.sh recorded OUT     the retention the units in OUT record (ag_recorded).
#   archive-guard.sh full DAY         local, plus the private store (DATA_REPO, read with
#       DATA_STORE_TOKEN) is readable, private and holds no storage-stop tag, plus the
#       3-failure stop is not active (run history of this repository, GH_TOKEN). Prints
#       the retention.
#   archive-guard.sh attest DAY DIR   full, then writes DIR/DAY ("DAY RETENTION UNIX
#       TIME"): the scan job's clean guard steps hand it to scan-day.sh and check-day.sh,
#       which never hold a token.
# Any refusal exits 2 with the reason on stderr (and the step summary). When sourced, it
# defines the ag_* functions archive-check.sh uses.
#
# Failures (OF-2): a non-served archive check (its step "Not served (counted failure)"
# failed), and a data-scan archive batch (title "data-scan scan source=archive") whose
# scan job failed, was cancelled or timed out and whose `continue` job did not chain it
# (a block exits 4, any other failure, or a second resumable stop: data-scan allows one
# resumable restart a day). They count from ARCHIVE_REARM_AT, and only after the last
# successful batch; 3 stop the chain until a reviewed change moves ARCHIVE_REARM_AT.
#
# Env: GH_REPO (or GITHUB_REPOSITORY), GH_TOKEN, DATA_REPO, DATA_STORE_TOKEN. GH_BIN and
# AG_NOW (a fixed clock) are for tests only; no workflow sets them (test-ci.sh checks).
set -uo pipefail
ag_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=archive-limits.conf
. "$ag_here/archive-limits.conf"
ag_gh=${GH_BIN:-gh}
ag_repo=${GH_REPO:-${GITHUB_REPOSITORY:-}}
ag_summary=${GITHUB_STEP_SUMMARY:-/dev/null}
ag_decisions="$ag_here/../../../docs/DECISIONS.md"
ag_now() { echo "${AG_NOW:-$(date -u +%s)}"; }
ag_refuse() { echo "refused: $*" | tee -a "$ag_summary" >&2; return 2; }
ag_ts() { # ag_ts ISO-8601-UTC: unix seconds, or nothing
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  date -u -d "$1" +%s 2>/dev/null
}

# ag_days: the allow-list, oldest first, one day a line. Items are days or FROM..TO
# (inclusive). Fails on a malformed item, or on any day outside 2026-07-22..2026-09-20:
# never a pre-BOOST day, never 09-21 (Helius) and never 09-22 or later (B3 holdout),
# whatever the list says.
ag_days() {
  local item from to d out=()
  for item in ${ARCHIVE_DAYS:-}; do
    if [[ "$item" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})\.\.([0-9]{4}-[0-9]{2}-[0-9]{2})$ ]]; then
      from=${BASH_REMATCH[1]} to=${BASH_REMATCH[2]}
    elif [[ "$item" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      from=$item to=$item
    else
      echo "ARCHIVE_DAYS item '$item' is not a day or FROM..TO" >&2; return 1
    fi
    [[ "$(date -u -d "$from" +%F 2>/dev/null)" == "$from" && "$(date -u -d "$to" +%F 2>/dev/null)" == "$to" && ! "$to" < "$from" ]] ||
      { echo "ARCHIVE_DAYS item '$item' is not a valid range" >&2; return 1; }
    d=$from
    while [[ ! "$d" > "$to" ]]; do out+=("$d"); d=$(date -u -d "$d + 1 day" +%F); done
  done
  (( ${#out[@]} )) || { echo "ARCHIVE_DAYS is empty" >&2; return 1; }
  printf '%s\n' "${out[@]}" | LC_ALL=C sort -u | while read -r d; do
    if [[ "$d" < 2026-07-22 || "$d" > 2026-09-20 ]]; then echo "ARCHIVE_DAYS holds $d, outside 2026-07-22..2026-09-20" >&2; exit 1; fi
    echo "$d"
  done
}
# ag_pinned_id: the id of the one pinned B10-PULL row in docs/DECISIONS.md, or nothing.
ag_pinned_id() {
  local ids
  ids=$(sed -n 's/^| [0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} | B10-PULL id=\([A-Za-z0-9._:-]\{1,\}\) source=old-faithful .*/\1/p' "$ag_decisions" 2>/dev/null | LC_ALL=C sort -u)
  [[ -n "$ids" && $(wc -l <<< "$ids") == 1 ]] && echo "$ids"
}
# ag_armed: ARCHIVE_ARM is set and is the pinned B10-PULL id; ARCHIVE_REARM_AT is a
# valid UTC time that is not in the future.
ag_armed() {
  local pin t
  [[ -n "${ARCHIVE_ARM:-}" ]] || { ag_refuse "the archive chain is not armed (ARCHIVE_ARM is empty in archive-limits.conf)"; return 2; }
  pin=$(ag_pinned_id)
  [[ -n "$pin" && "$ARCHIVE_ARM" == "$pin" ]] ||
    { ag_refuse "the archive chain is not armed (ARCHIVE_ARM '$ARCHIVE_ARM' is not the one pinned B10-PULL id '${pin:-none}' in docs/DECISIONS.md)"; return 2; }
  t=$(ag_ts "${ARCHIVE_REARM_AT:-}") && (( t <= $(ag_now) )) ||
    { ag_refuse "ARCHIVE_REARM_AT '${ARCHIVE_REARM_AT:-}' is not a past UTC time (YYYY-MM-DDTHH:MM:SSZ)"; return 2; }
}
# ag_retention DAY: the retention a fresh read of DAY uses, or nothing. Unset: only the
# first allow-listed day (2026-07-22, K2, measurement day 1); K2: the first two days (the
# two measurement days); K3: every allow-listed day. Anything else: no day.
ag_retention() {
  local first2
  first2=$(ag_days 2>/dev/null | head -2 | tr '\n' ' ')
  case "${ARCHIVE_RETENTION:-}" in
    "") [[ "$1" == "${first2%% *}" ]] && echo K2 ;;
    K2) [[ " $first2 " == *" $1 "* ]] && echo K2 ;;
    K3) echo K3 ;;
  esac
  return 0
}
# ag_local DAY: every check without a token; prints the day's retention.
ag_local() {
  local day=$1 days ret
  [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$(date -u -d "$day" +%F 2>/dev/null)" == "$day" ]] || { ag_refuse "bad day '$day'"; return 2; }
  [[ " ${HELIUS_DAYS:-} " == *" $day "* ]] &&
    { ag_refuse "$day is a Helius day (HELIUS_DAYS in archive-limits.conf); it is never read from the archive"; return 2; }
  days=$(ag_days) || { ag_refuse "ARCHIVE_DAYS in archive-limits.conf is malformed"; return 2; }
  grep -qx "$day" <<< "$days" ||
    { ag_refuse "$day is not in the archive allow-list (ARCHIVE_DAYS in archive-limits.conf: ${ARCHIVE_DAYS:-})"; return 2; }
  ag_armed || return 2
  ret=$(ag_retention "$day")
  [[ -n "$ret" ]] ||
    { ag_refuse "$day has no retention value (ARCHIVE_RETENTION '${ARCHIVE_RETENTION:-}' in archive-limits.conf); no day after the measurement days is read before the retention record"; return 2; }
  echo "$ret"
}

# ag_attested DAY: the scan job's clean guard step (attest) passed DAY within the last
# 30 min: ARCHIVE_GUARD_DIR/DAY reads "DAY RETENTION TIME". scan-day.sh and check-day.sh
# hold no token, so this is how the store and 3-failure checks reach them.
ag_attested() {
  local f="${ARCHIVE_GUARD_DIR:-}/$1" d r t
  [[ -n "${ARCHIVE_GUARD_DIR:-}" && -f "$f" ]] ||
    { ag_refuse "no archive guard pass for $1 (the guard step checks the store, the storage-stop marker and the 3-failure stop)"; return 2; }
  read -r d r t < "$f"
  [[ "$d" == "$1" && "$r" =~ ^K[23]$ && "$t" =~ ^[0-9]+$ ]] && (( t <= $(ag_now) && $(ag_now) - t <= 1800 )) ||
    { ag_refuse "the archive guard pass for $1 is malformed or older than 30 min"; return 2; }
}
# ag_entry DAY: what scan-day.sh and check-day.sh check: ag_local plus ag_attested.
ag_entry() {
  local ret
  ret=$(ag_local "$1") || return 2
  ag_attested "$1" || return 2
  echo "$ret"
}
# ag_recorded OUT: the one retention the finished units in OUT record (stats.json
# "retention"), or nothing when there are none. Fails when they mix values or record one
# other than K2 or K3: a day keeps its recorded retention (a unit read again, the
# determinism rescan), never the current ARCHIVE_RETENTION.
ag_recorded() {
  local vals
  vals=$(for st in "$1"/units/*/*/stats.json; do
    [[ -f "$st" ]] || continue
    v=$(sed -n 's/.*"retention": *"\([^"]*\)".*/\1/p' "$st" | head -1); echo "${v:-none}"
  done | LC_ALL=C sort -u)
  [[ -z "$vals" ]] && return 0
  [[ $(wc -l <<< "$vals") == 1 && "$vals" =~ ^K[23]$ ]] ||
    { ag_refuse "the day's units record retention '$(tr '\n' ' ' <<< "$vals")', not one of K2 or K3"; return 2; }
  echo "$vals"
}

# ---- the private store (DATA_REPO, zeroed-data) ----
ag_store() { GH_TOKEN="${DATA_STORE_TOKEN:-}" "$ag_gh" "$@"; }
# ag_store_ok: the store is named, is not this repository, answers, is private, and
# holds no storage-stop tag (OF-4 writes it, append-only; only a reviewed change with
# the owner's OK clears it).
ag_store_ok() {
  local priv stop
  [[ -n "${DATA_STORE_TOKEN:-}" && "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] ||
    { ag_refuse "the private store cannot be read (DATA_REPO or DATA_STORE_TOKEN missing)"; return 2; }
  [[ "${DATA_REPO,,}" != "${ag_repo,,}" ]] || { ag_refuse "DATA_REPO is this repository, not the private store"; return 2; }
  priv=$(ag_store api "repos/$DATA_REPO" --jq '.private' 2>/dev/null) || { ag_refuse "the private store $DATA_REPO cannot be read"; return 2; }
  [[ "$priv" == true ]] || { ag_refuse "the store $DATA_REPO is not private"; return 2; }
  stop=$(ag_store api "repos/$DATA_REPO/git/matching-refs/tags/storage-stop" --jq '.[].ref' 2>/dev/null) ||
    { ag_refuse "the private store's storage-stop marker cannot be read"; return 2; }
  grep -qx 'refs/tags/storage-stop' <<< "$stop" &&
    { ag_refuse "the storage-stop marker is present in $DATA_REPO (storage projection above 0.5 TB); the owner is asked"; return 2; }
  return 0
}
# ag_read_done: the days with a data-day-D or data-day-D-k3 tag in the store ("read
# done", OF-5), one a line. Fails when the store cannot be read.
ag_read_done() {
  local refs
  refs=$(ag_store api --paginate "repos/$DATA_REPO/git/matching-refs/tags/data-day-" --jq '.[].ref' 2>/dev/null) || return 1
  sed -n 's#^refs/tags/data-day-\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)\(-k3\)\{0,1\}$#\1#p' <<< "$refs" | LC_ALL=C sort -u
}

# ---- run history of this repository ----
ag_default_branch() {
  local b
  b=$("$ag_gh" api "repos/$ag_repo" --jq '.default_branch' 2>/dev/null) || return 1
  [[ "$b" =~ ^[A-Za-z0-9._/-]+$ && "$b" != null ]] || return 1
  echo "$b"
}
# ag_runs WORKFLOW [BRANCH]: runs as TSV "id status conclusion createdAt updatedAt title"
# (a missing conclusion is "-": read splits on tabs and would merge empty fields),
# newest first. Fails on an API error, or when 500 runs do not reach back to the window
# start (AG_SINCE), so no failure can hide past the list's end.
ag_runs() {
  local wf=$1 br=${2:-} out n oldest
  out=$("$ag_gh" run list --repo "$ag_repo" --workflow "$wf" ${br:+--branch "$br"} --limit 500 \
    --json databaseId,status,conclusion,createdAt,updatedAt,displayTitle \
    --jq '.[] | [.databaseId, .status, (.conclusion // "-"), .createdAt, .updatedAt, .displayTitle] | @tsv' 2>/dev/null) || return 1
  n=$(grep -c . <<< "$out")
  if (( n >= 500 )); then
    oldest=$(ag_ts "$(tail -1 <<< "$out" | cut -f4)") || return 1
    (( oldest < AG_SINCE )) || return 1
  fi
  printf '%s\n' "$out"
}
# ag_jobs ID: "job<TAB>conclusion" and "step<TAB>name<TAB>conclusion" lines of a run.
ag_jobs() {
  "$ag_gh" run view "$1" --repo "$ag_repo" --json jobs \
    --jq '.jobs[] | ("job\t\(.name)\t\(.conclusion // "-")"), (.steps[]? | "step\t\(.name)\t\(.conclusion // "-")")' 2>/dev/null
}
# ag_history: reads both workflows' runs since AG_SINCE (the earlier of ARCHIVE_REARM_AT
# and one day ago) and sets
#   AG_FAILS      failures at or after ARCHIVE_REARM_AT with no successful batch after them
#   AG_LAST_FAIL  unix end of the last failure of any age in the window (0: none)
#   AG_LANE_END   unix end of the last completed data-scan run outside the Helius lane (0: none)
#   AG_DS_RUNS / AG_AC_RUNS / AG_BRANCH  the run lists and the default branch (for archive-check)
# Fails when anything cannot be read (fail closed).
ag_history() {
  local now rearm id st co cr up ti t ev jobs events="" lastok=0
  now=$(ag_now)
  rearm=$(ag_ts "${ARCHIVE_REARM_AT:-}") || return 1
  AG_SINCE=$(( rearm < now - 86400 ? rearm : now - 86400 ))
  AG_BRANCH=$(ag_default_branch) || return 1
  AG_AC_RUNS=$(ag_runs archive-check.yml "$AG_BRANCH") || return 1
  AG_DS_RUNS=$(ag_runs data-scan.yml) || return 1
  AG_FAILS=0 AG_LAST_FAIL=0 AG_LANE_END=0
  while IFS=$'\t' read -r id st co cr up ti; do
    [[ -n "$id" && "$st" == completed ]] || continue
    cr=$(ag_ts "$cr") && up=$(ag_ts "$up") || return 1
    (( cr >= AG_SINCE )) || continue
    if [[ "$co" == failure ]]; then
      jobs=$(ag_jobs "$id") || return 1
      grep -qxF $'step\tNot served (counted failure)\tfailure' <<< "$jobs" && events+="$up F"$'\n'
    fi
  done <<< "$AG_AC_RUNS"
  while IFS=$'\t' read -r id st co cr up ti; do
    [[ -n "$id" && "$st" == completed ]] || continue
    cr=$(ag_ts "$cr") && up=$(ag_ts "$up") || return 1
    (( cr >= AG_SINCE )) || continue
    if [[ "$ti" != "data-scan scan source=helius" ]] && (( up > AG_LANE_END )); then AG_LANE_END=$up; fi
    [[ "$ti" == "data-scan scan source=archive" ]] || continue
    if [[ "$co" == success ]]; then events+="$up S"$'\n'; continue; fi
    jobs=$(ag_jobs "$id") || return 1
    if grep -qE $'^job\tscan[^\t]*\t(failure|cancelled|timed_out)$' <<< "$jobs" && ! grep -qxF $'job\tcontinue\tsuccess' <<< "$jobs"; then
      events+="$up F"$'\n'
    fi
  done <<< "$AG_DS_RUNS"
  while read -r t ev; do
    [[ -n "$t" ]] || continue
    if [[ "$ev" == S ]]; then (( t > lastok )) && lastok=$t; else (( t > AG_LAST_FAIL )) && AG_LAST_FAIL=$t; fi
  done <<< "$events"
  while read -r t ev; do
    [[ "$ev" == F ]] && (( t >= rearm && t > lastok )) && AG_FAILS=$(( AG_FAILS + 1 ))
  done <<< "$events"
  return 0
}
# ag_stop_ok: the 3-failure stop is not active (history readable, fewer than 3 failures).
ag_stop_ok() {
  ag_history || { ag_refuse "the run history cannot be read, so the 3-failure stop cannot be ruled out"; return 2; }
  (( AG_FAILS < 3 )) ||
    { ag_refuse "the archive chain is stopped: $AG_FAILS failures since ARCHIVE_REARM_AT ${ARCHIVE_REARM_AT} with no successful batch between them; only a reviewed change re-arms it"; return 2; }
}
ag_full() {
  local ret
  ret=$(ag_local "$1") || return 2
  ag_store_ok || return 2
  ag_stop_ok || return 2
  echo "$ret"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    local) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh local DAY" >&2; exit 2; }; ag_local "$2"; exit $? ;;
    entry) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh entry DAY" >&2; exit 2; }; ag_entry "$2"; exit $? ;;
    recorded) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh recorded OUT" >&2; exit 2; }; ag_recorded "$2"; exit $? ;;
    full) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh full DAY" >&2; exit 2; }; ag_full "$2"; exit $? ;;
    attest)
      [[ $# -eq 3 ]] || { echo "usage: archive-guard.sh attest DAY DIR" >&2; exit 2; }
      rm -f "$3/$2"
      ret=$(ag_full "$2") || exit 2
      mkdir -p "$3" && echo "$2 $ret $(ag_now)" > "$3/$2" && echo "archive guard: $2 may be read ($ret)" | tee -a "$ag_summary" ;;
    *) echo "usage: archive-guard.sh local|entry|full DAY | attest DAY DIR | recorded OUT" >&2; exit 2 ;;
  esac
fi
