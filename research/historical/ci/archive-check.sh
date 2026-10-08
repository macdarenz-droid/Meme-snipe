#!/usr/bin/env bash
# ARCHIVE-CHECK (owner decision, 2026-10-04; batches OF-2, research/z-h-estimate/
# OLD-FAITHFUL.md §2): every 3 hours, ask the Old Faithful archive once whether it serves
# our scanner again, and if it does, dispatch the next day of the allow-list. Run by
# .github/workflows/archive-check.yml.
#
#   - Every mode refuses a run attempt other than 1: a re-run never probes or dispatches.
#   - Holds first (the default mode), in this order; each one sends nothing:
#     1. not armed (archive-guard.sh ag_armed: ARCHIVE_ARM is the pinned B10-PULL id,
#        ARCHIVE_REARM_AT a past UTC time, and no day is still stored in this public
#        repository), or the run is not on the default branch;
#     2. a back-off is running: before max(3 h after the last failure, the latest
#        recorded Retry-After or scan back-off end), or the history or the recorded ends
#        cannot be read;
#     3. the 3-failure stop is active (failures from every attempt of every run on any
#        branch, counted from ARCHIVE_REARM_AT with no stored day after them), or the
#        private store cannot be read or holds the storage-stop tag;
#     4. the scanner's request cap (scanner/archive.go) is above ARCHIVE_MAX_RPS;
#     5. a data-scan run that may read the archive is active or queued, or a dispatch
#        marker younger than 15 min names a run not listed yet, or the markers cannot be
#        listed. A run counts as Helius-only (it never touches the archive) only when its
#        title, set by data-scan.yml's run-name, is exactly "data-scan scan
#        source=helius", or its id is in HELIUS_RUNS (a manual dispatch input, digits and
#        commas only, for Helius runs dispatched before run-name);
#     6. less than 60 min since the last data-scan run outside the Helius lane ended;
#     7. the queue is empty (every allow-listed day is read done in the private store,
#        or the store cannot be read), or the next day has no retention value.
#     When all pass it sets ready=true and day (the oldest allow-listed day not read
#     done: day D+1 only after day D).
#   - --probe DAY (the step "Archive probe (a failure unless served)"): ONE request, a
#     range GET of 64 bytes with the scanner's own User-Agent (read from
#     scanner/archive.go), from the runner. Never another agent, host, address, proxy or
#     client: that would be getting around the block, which Triton's terms bar. Any
#     answer but a 206 of at most 64 bytes is logged (status, bytes, cf-ray, Retry-After,
#     time), sets served=false and backoff_end (from a Retry-After), and exits 1: the
#     failed step is the countable failure. No retries. No answer can stream: the body is
#     cut after 65 bytes, which aborts the transfer. A 206 sets served=true and the
#     dispatch marker's key (archive-dispatch-<UTC time>-<run id>) and writes the marker
#     (time and day only) to $RUNNER_TEMP/archive-dispatch.
#   - --dispatch DAY: after the workflow saved the marker, checks the day again and
#     dispatches data-scan.yml (mode scan, one day, max_mbps ARCHIVE_MAX_MBPS).
#
# Env: GH_REPO (owner/repo), REF (branch to dispatch on), GH_TOKEN for gh, DATA_REPO and
# DATA_STORE_TOKEN for the private store, GITHUB_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
# GITHUB_OUTPUT; GH_BIN, CURL_BIN,
# AG_NOW and ARCHIVE_CHECK_URL (a local fake server) are for tests only; the workflow sets
# none of them (test-ci.sh checks).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=archive-limits.conf
. "$here/archive-limits.conf"
# shellcheck source=archive-guard.sh
. "$here/archive-guard.sh"
ag_summary=/dev/null # holds are logged once, below
gh=${GH_BIN:-gh}
curl=${CURL_BIN:-curl}
: "${GH_REPO:?}" "${REF:?}"
summary=${GITHUB_STEP_SUMMARY:-/dev/stderr}
output=${GITHUB_OUTPUT:-/dev/null}
url="https://files.old-faithful.net/1047/epoch-1047.car"

iso() { date -u -d "@$1" +%FT%TZ; }
# OF-2 round 2, ruling 1: a re-run never probes or dispatches (its earlier attempt's
# failure must keep counting); every mode refuses an attempt other than 1.
if [[ "${GITHUB_RUN_ATTEMPT:-}" != 1 ]]; then
  echo "archive-check: run attempt '${GITHUB_RUN_ATTEMPT:-}' is not 1: a re-run never probes or dispatches; no request made" | tee -a "$summary"
  exit 1
fi

# --dispatch DAY: the workflow's last step, after the marker is saved. The day is checked
# again (allow-list, arm, retention) before the dispatch.
if [[ "${1:-}" == --dispatch ]]; then
  [[ $# -eq 2 ]] || { echo "usage: archive-check.sh --dispatch DAY" >&2; exit 2; }
  msg=$(ag_local "$2" 2>&1 >/dev/null) || { msg=$(grep -v '^permissions: parsed with' <<< "$msg" || true); echo "archive-check: $msg; nothing dispatched" | tee -a "$summary"; exit 1; }
  "$gh" workflow run data-scan.yml --repo "$GH_REPO" --ref "$REF" -f mode=scan -f days="$2" -f max_mbps="$ARCHIVE_MAX_MBPS"
  echo "archive-check: served; dispatched data-scan for $2" | tee -a "$summary"
  exit 0
fi

ua=$(sed -n 's/^const userAgent = "\(.*\)"$/\1/p' "$here/../scanner/archive.go")
if [[ -z "$ua" || "$ua" != zeroed-historical-scanner/* ]]; then
  echo "archive-check: the scanner's User-Agent was not found in archive.go" | tee -a "$summary"
  exit 1
fi

# --probe DAY: the workflow's "Archive probe (a failure unless served)" step, run only
# after every hold passed. The step starting is the probe-sent mark (ruling 6): it exits
# 0 only when served, so any other end of a step that ran (not served, cancelled, timed
# out) is a counted failure.
if [[ "${1:-}" == --probe ]]; then
  [[ $# -eq 2 ]] || { echo "usage: archive-check.sh --probe DAY" >&2; exit 2; }
  next=$2 now=$(ag_now)
  # Ruling 20: the probe checks the day itself (allow-list, arm, retention) first.
  msg=$(ag_local "$next" 2>&1 >/dev/null) || { msg=$(grep -v '^permissions: parsed with' <<< "$msg" || true); echo "archive-check: $msg; no request made" | tee -a "$summary"; exit 2; }
  echo "archive-check $(iso "$now"): probe sent for $next" | tee -a "$summary"
  hdr=$(mktemp)
  body=$(mktemp)
  # -r 0-63 asks for 64 bytes. Whatever the server sends (a 200 ignoring the range, a
  # chunked stream with no length), the body goes through `head -c 65`, which exits
  # after 65 bytes and so aborts curl's transfer; --max-filesize also refuses an
  # announced larger body, and --limit-rate keeps curl's reads small. Only a 206 of at
  # most 64 bytes counts as served.
  rcf=$(mktemp)
  trap 'rm -f "$hdr" "$body" "$rcf"' EXIT
  # The left side of a pipe runs in a subshell, so curl's exit code goes through a file.
  { rc=0; "$curl" -sS -D "$hdr" -o - --max-time 30 --max-filesize 64 --limit-rate 2k \
      -A "$ua" -r 0-63 "${ARCHIVE_CHECK_URL:-$url}" || rc=$?; echo "$rc" > "$rcf"; } | head -c 65 > "$body" || true
  rc=$(cat "$rcf")
  [[ -n "$rc" ]] || rc=141 # killed by the pipe closing: the body ran past 65 bytes
  code=$(tr -d '\r' < "$hdr" | awk '/^HTTP\//{c=$2} END{print c}')
  got=$(wc -c < "$body")
  ray=$(tr -d '\r' < "$hdr" | sed -n 's/^[Cc][Ff]-[Rr][Aa][Yy]: *//p' | tail -1)
  ra=$(tr -d '\r' < "$hdr" | sed -n 's/^[Rr][Ee][Tt][Rr][Yy]-[Aa][Ff][Tt][Ee][Rr]://p' | tail -1)
  # Round 4, ruling 27: surrounding whitespace is not part of the value (RFC 9110 OWS).
  ra=${ra#"${ra%%[![:space:]]*}"}; ra=${ra%"${ra##*[![:space:]]}"}
  at=$(date -u +%FT%TZ)
  {
    echo "| time (UTC) | status | bytes | curl exit | cf-ray | retry-after |"
    echo "|---|---|---|---|---|---|"
    echo "| $at | ${code:-none} | $got | $rc | ${ray:-none} | ${ra:-none} |"
  } >> "$summary"
  echo "archive-check $at: status ${code:-none}, $got bytes, curl exit $rc, cf-ray ${ray:-none}, retry-after ${ra:-none}"
  if ! [[ "$code" == 206 && $rc == 0 && $got -le 64 ]]; then
    echo "served=false" >> "$output"
    # Rulings 10, 14, 18: the back-off end, max(3 h, a Retry-After parsed strictly as
    # delta-seconds or an IMF-fixdate, RFC 9110), is recorded durably as a check-run
    # annotation (title archive-backoff, end=<unix>) and as cache key
    # archive-backoff-<end> (the fast path). A Retry-After present but unclean, or above
    # 7 days, records end=hold, which holds the chain until a reviewed re-arm.
    end=$(( now + ARCHIVE_BACKOFF_S ))
    if [[ -n "$ra" ]]; then
      if [[ "$ra" =~ ^[0-9]{1,9}$ ]]; then e=$(( now + 10#$ra ))
      elif [[ "$ra" =~ ^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\ [0-9]{2}\ (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\ [0-9]{4}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\ GMT$ ]] &&
           e=$(date -u -d "$ra" +%s 2>/dev/null); then :
      else e=hold
      fi
      if [[ "$e" != hold ]] && (( e > now + 7 * 86400 )); then e=hold; fi
      if [[ "$e" == hold ]]; then end=hold; elif (( e > end )); then end=$e; fi
    fi
    # Round 4, ruling 25: the annotation is written first, by its own step ("Record the
    # back-off annotation"), so no other annotation of this job can crowd it out.
    echo "backoff_annotation=$end" >> "$output"
    if [[ "$end" != hold ]]; then
      echo "backoff_end=$end" >> "$output"
      mkdir -p "${RUNNER_TEMP:-/tmp}/archive-backoff" && echo "$end" > "${RUNNER_TEMP:-/tmp}/archive-backoff/end"
    fi
    if [[ "$end" == hold ]]; then
      echo "archive-check: not served; counted as a failure; the Retry-After '$ra' is unclean or above 7 days, so the chain holds until a reviewed re-arm" | tee -a "$summary"
    else
      echo "archive-check: not served; counted as a failure, nothing dispatched; the back-off holds every request until $(iso "$end")" | tee -a "$summary"
    fi
    exit 1
  fi
  key="archive-dispatch-$(date -u -d "@$now" +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:?}"
  mkdir -p "${RUNNER_TEMP:-/tmp}/archive-dispatch"
  echo "$(iso "$now") $next" > "${RUNNER_TEMP:-/tmp}/archive-dispatch/marker"
  { echo "served=true"; echo "marker=$key"; } >> "$output"
  echo "archive-check: served; $next goes out after the dispatch marker $key is saved" | tee -a "$summary"
  exit 0
fi

named=${HELIUS_RUNS:-}
if [[ -n "$named" && ! "$named" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "archive-check: helius_runs must be run ids separated by commas, got '$named'; no request made" | tee -a "$summary"
  exit 1
fi
# hold N REASON: log the hold and stop; no request, no dispatch.
hold() { echo "archive-check $(date -u -d "@$(ag_now)" +%FT%TZ): held ($1): $2; no request made" | tee -a "$summary"; exit 0; }
now=$(ag_now)

# 1. armed (the permissions check's parser line goes to the log, not into the hold)
armed=1; msg=$(ag_armed 2>&1) || armed=0
grep '^permissions: parsed with' <<< "$msg" | tee -a "$summary" || true
msg=$(grep -v '^permissions: parsed with' <<< "$msg" || true)
(( armed )) || hold 1 "${msg#refused: }"
# 2. back-off, 3. the 3-failure stop and the store
ag_history || hold 2 "the run history cannot be read (fail closed)"
# Ruling 4: only the default branch probes (failures count from every branch, above).
[[ "${GITHUB_REF:-}" == "refs/heads/$AG_BRANCH" ]] || hold 1 "ref '${GITHUB_REF:-}' is not the default branch refs/heads/$AG_BRANCH"
msg=$(ag_backoff_ok 2>&1) || hold 2 "${msg#refused: }"
(( AG_FAILS < 3 )) || hold 3 "the chain is stopped: $AG_FAILS failures since ARCHIVE_REARM_AT $ARCHIVE_REARM_AT with no successful batch between them; only a reviewed change re-arms it"
(( AG_FOREIGN == 0 )) || hold 3 "the chain is stopped: $AG_FOREIGN run(s) since ARCHIVE_REARM_AT may have read the archive unguarded (a scan or an archive check from another branch, or a re-run of a commit without archive-guard.sh); only a reviewed change re-arms it"
msg=$(ag_store_ok 2>&1) || hold 3 "${msg#refused: }"
msg=$(ag_caches_sealed 2>&1) || hold 3 "${msg#refused: }"
# 4. ARCHIVE-SAFE: the scanner's request cap
if ! cap=$("$here/scan-day.sh" --rps-ok "${ARCHIVE_GO:-$here/../scanner/archive.go}"); then
  hold 4 "the scanner's request cap ($cap/s, scanner/archive.go) is above $ARCHIVE_MAX_RPS/s (archive-limits.conf)"
fi
# 5. one archive lane: no run that may read the archive active or queued (Helius-only
# runs read another host, in their own concurrency group, ARCHIVE-LANE) ...
archive=0
while IFS=$'\t' read -r id st _ _ _ _ _ _ title; do
  [[ -n "$id" && "$st" != completed ]] || continue
  if [[ "$title" == "data-scan scan source=helius" || ",$named," == *",$id,"* ]]; then continue; fi
  archive=$(( archive + 1 ))
done <<< "$AG_DS_RUNS"
(( archive == 0 )) || hold 5 "$archive data-scan run(s) that may read the archive active or queued"
# ... and no fresh dispatch marker whose run is not listed yet. Only markers saved on the
# default branch by an archive-check run of that branch count.
ref="refs/heads/$AG_BRANCH"
keys=$("$gh" api --paginate "repos/$GH_REPO/actions/caches?key=archive-dispatch-&ref=$ref&per_page=100" \
  --jq ".actions_caches[] | select(.ref == \"$ref\") | .key" 2>/dev/null) || hold 5 "the dispatch markers cannot be listed (fail closed)"
acids=" $(awk -F'\t' -v b="$AG_BRANCH" '$7 == b {print $1}' <<< "$AG_AC_RUNS" | tr '\n' ' ') "
while read -r key; do
  [[ "$key" =~ ^archive-dispatch-([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})Z-([0-9]+)$ ]] || continue
  [[ "$acids" == *" ${BASH_REMATCH[5]} "* ]] || continue
  d=${BASH_REMATCH[1]}
  t=$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2}T${BASH_REMATCH[2]}:${BASH_REMATCH[3]}:${BASH_REMATCH[4]}Z" +%s 2>/dev/null) || continue
  (( now - t < 900 )) || continue
  listed=0
  while IFS=$'\t' read -r id _ _ cr _ _ _ _ title; do
    [[ -n "$id" && "$title" != "data-scan scan source=helius" ]] || continue
    c=$(ag_ts "$cr") && (( c >= t )) && { listed=1; break; }
  done <<< "$AG_DS_RUNS"
  (( listed )) || hold 5 "dispatch marker $key is $(( (now - t) / 60 )) min old and its data-scan run is not listed yet"
done <<< "$keys"
# 6. at least 60 min since the last archive-lane run ended
if (( AG_LANE_END > 0 && now - AG_LANE_END < 3600 )); then
  hold 6 "the last data-scan run outside the Helius lane ended $(iso "$AG_LANE_END"), less than 60 min ago"
fi
# 7. the queue: the oldest allow-listed day not read done in the private store
readdone=$(ag_read_done) || hold 7 "the private store's day releases cannot be read (fail closed)"
days=$(ag_days 2>/dev/null) || hold 7 "ARCHIVE_DAYS in archive-limits.conf is malformed"
next=""
while read -r d; do
  grep -qx "$d" <<< "$readdone" && continue
  next=$d; break
done <<< "$days"
if [[ -z "$next" ]]; then
  echo "archive-check: every allow-listed day is read done; no request made" | tee -a "$summary"
  exit 0
fi
msg=$(ag_local "$next" 2>&1 >/dev/null) || { msg=$(grep -v '^permissions: parsed with' <<< "$msg" || true); hold 7 "${msg#refused: }"; }
echo "ready=true" >> "$output"
echo "day=$next" >> "$output"
echo "archive-check: every hold passed; the probe step asks the archive for $next" | tee -a "$summary"
