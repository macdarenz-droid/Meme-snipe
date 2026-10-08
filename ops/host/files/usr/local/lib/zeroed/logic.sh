# Pure decision helpers for the Zeroed host scripts: no side effects, no host paths read unless passed in,
# so packages/ops/test/host-logic.test.ts runs them anywhere. Sourced, never run. Never prints a secret value.
# shellcheck shell=bash

PAIR_CODE_TTL_S=1800       # a pairing code works for 30 minutes
WEBHOOK_MAX_TRIES=5        # the owner is told after this many failed tries in a row
WORKER_API_ADDR=127.0.0.1:8788 # the worker API, loopback only; tailscale serve publishes it to the tailnet
WORKER_HEALTH_ADDR=127.0.0.1:8787 # the worker's health route for the runner (RUN-1's default), never published
TABLETOP_API_ADDR=127.0.0.1:8789 # reserved for RUN-1d's zeroed-worker-tabletop (never published)
SMOKE_HEALTH_ADDR=127.0.0.1:8797 # worker-smoke's trial start of a new release (never published)
SMOKE_API_ADDR=127.0.0.1:8798
SMOKE_MEMORY_MAX=280M # the trial's memory cap beside the live worker (up to 800M): set for the 1 GB server and kept on the 2 GB one while only the stand-in runs (Z10 sizes the recorder's unit from measurement)
SMOKE_HOLD_S=30 # after its first health answer, the trial worker must still run and answer this long
SWITCH_HOLD_S=30 # after a switch, the new worker must run this long with no restart and health answering
PROBATION_S=7200 # RC-R2-3: after a switch, any automatic restart of the worker within this window rolls it back
RELEASE_UNIT_RE='^zeroed-(dryrun[a-z0-9-]*@?|worker-tabletop)\.(service|timer)$' # units taken from the release

# backoff_s TRIES: seconds to wait after TRIES failed tries in a row (1 min, doubling, at most 30 min).
backoff_s() {
  local n="$1" s=60
  while [ "$n" -gt 1 ] && [ "$s" -lt 1800 ]; do s=$((s * 2)); n=$((n - 1)); done
  [ "$s" -le 1800 ] || s=1800
  printf '%s\n' "$s"
}

# pair_code_expired ISSUED NOW: true once a code issued at ISSUED (epoch s) is older than the TTL.
pair_code_expired() { [ $(($2 - $1)) -gt "$PAIR_CODE_TTL_S" ]; }

# webhook_fp: reads Telegram's getWebhookInfo reply on stdin and prints "none" (no webhook) or the SHA-256 of
# what defines where updates go (url, certificate, connections, update types). The IP address and error
# fields are left out: Telegram changes them on its own.
webhook_fp() {
  local fp
  fp="$(jq -r 'if .ok != true then "error"
    elif ((.result.url // "") == "") then "none"
    else [.result.url, (.result.has_custom_certificate // false), (.result.max_connections // 40), ((.result.allowed_updates // []) | sort)] | tojson end')" || fp=error
  case "$fp" in
    none | error) printf '%s\n' "$fp" ;;
    *) printf '%s' "$fp" | sha256sum | cut -c1-64 ;;
  esac
}

# webhook_host: prints the host of the webhook URL in a getWebhookInfo reply on stdin, or "none".
webhook_host() { jq -r '(.result.url // "") | if . == "" then "none" else (sub("^[a-z]+://"; "") | sub("[/?#].*$"; "")) end'; }

# qualifying_run EVIDENCE_ROOT UNITS: prints the name of an active qualifying dry run, or nothing. UNITS is
# the output of `systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend`. A run
# is also active while EVIDENCE_ROOT/<id>/run.json names it and it has no report.json yet (RUN-1's
# "unfinished" rule): that covers the minutes after a reboot drill before the runner resumes.
qualifying_run() {
  local unit d name
  unit="$(printf '%s\n' "$2" | sed -n 's/^\(●[[:space:]]*\)\{0,1\}zeroed-dryrun@\([^[:space:]]*\)\.service.*/\2/p' | head -1)"
  if [ -n "$unit" ]; then printf '%s\n' "$unit"; return 0; fi
  for d in "$1"/*/; do
    [ -f "$d/run.json" ] && [ ! -e "$d/report.json" ] || continue
    name="$(jq -r '.name // empty | strings' "$d/run.json" 2>/dev/null || true)"
    if [ -n "$name" ]; then printf '%s\n' "$name"; return 0; fi
  done
  return 0
}

# evidence_index EVIDENCE_ROOT: prints a JSON list of the dry runs kept on the host (newest first): id,
# name, label, commit, started, finished, pass, aborted and the evidence path. Read by the worker's health API.
evidence_index() {
  local d id
  for d in "$1"/*/; do
    [ -f "$d/run.json" ] || continue
    id="$(basename "$d")"
    [[ "$id" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || continue
    jq -c --arg id "$id" --arg path "${d%/}" \
      --argjson finished "$([ -f "$d/report.json" ] && echo true || echo false)" \
      --argjson report "$(jq -c '{pass: (.pass | if type == "boolean" then . else null end)}' "$d/report.json" 2>/dev/null || echo '{"pass":null}')" \
      --arg aborted "$(head -c 200 "$d/ABORTED" 2>/dev/null | tr -d '\n' || true)" \
      '{id: $id, name: (.name // null), label: (.label // null), commit: (.commit // null),
        started: (.startedAt // null), finished: $finished, pass: (if $finished then $report.pass else null end),
        aborted: (if $aborted == "" then null else $aborted end), path: $path}' "$d/run.json" 2>/dev/null || true
  done | jq -s 'sort_by(.started // 0, .id) | reverse'
}

# serve_ok: reads `tailscale serve status --json` on stdin; true only when HTTPS 443 proxies to the worker API
# on loopback and Funnel is off everywhere.
serve_ok() {
  # Exactly one thing published (OPS-1h review): HTTPS on 443, one host, its "/" proxied to the worker API and
  # nothing else (no other path, port, host, TCP forward or service), and Funnel on for nothing. A serve made by hand
  # is adopted only in this shape.
  jq -e --arg target "http://$WORKER_API_ADDR" '
    type == "object"
    and ((keys - ["TCP", "Web", "AllowFunnel"]) == [])
    and .TCP == {"443": {"HTTPS": true}}
    and ((.Web // {}) | length == 1)
    and ((.Web // {}) | to_entries[0] | (.key | endswith(":443")) and .value == {"Handlers": {"/": {"Proxy": $target}}})
    and ((.AllowFunnel // {}) | to_entries | all(.value != true))' >/dev/null 2>&1
}

# unit_sandbox UNIT_FILE: the unit's [Service] settings that make its sandbox, limits and environment, one per line, for
# worker-smoke's trial: everything except its identity and groups, credentials, state directory, the live folders it may
# write (ReadWritePaths: PATHS-FIX's market data and import spool, which the trial, running as the worker's user, must
# never write beside the live worker; it writes only its own temporary folder), restarts, start and stop commands, its
# memory limit and its OOM score (the trial sets its own user, cap, OOM score and stop timeout).
unit_sandbox() {
  sed -n '/^\[Service\]/,/^\[/p' "$1" | grep -E '^[A-Z][A-Za-z]*=' |
    grep -Ev '^(Type|User|Group|SupplementaryGroups|Environment|EnvironmentFile|ExecStart|ExecStartPre|ExecStop|Restart|RestartSec|TimeoutStopSec|LoadCredential|LoadCredentialEncrypted|ImportCredential|SetCredential|StateDirectory|StateDirectoryMode|ReadWritePaths|MemoryMax|OOMScoreAdjust)=' || true
}

# funnel_ports: reads `tailscale serve status --json` on stdin and prints each "host:port" that Funnel makes
# public (none on a correct host: the app cannot tell a public Funnel address from a tailnet one).
funnel_ports() { jq -r '(.AllowFunnel // {}) | to_entries[] | select(.value == true) | .key' 2>/dev/null || true; }

# worker_entry RELEASE_DIR: the program the worker unit runs. The release's own worker (WORKER-1) only when the
# release's ops/host-config.json says "worker": "release" (a reviewed commit) and the file exists; the host's stand-in
# when it says "worker": "stub", or when no release is deployed yet (RELEASE_DIR does not exist and is not a link: a
# first install). Switching the host to the real worker is a decision, not a side effect of a merge. RC-M4: anything
# else is refused, never run as the stand-in (which passes worker-smoke and update health, so the host would look
# healthy with no trading worker): a host-config missing or unreadable, a "worker" value missing or unknown, or
# "release" without its main.ts. A refusal says why on stderr and returns 1: worker-start and worker-smoke then fail,
# loudly.
STUB_ENTRY=/opt/zeroed/stub/worker.mjs # the host's stand-in worker
worker_entry() {
  # Nothing there at all (not even a dangling link: that is a release gone missing, refused below).
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    printf '%s\n' "$STUB_ENTRY"
    return 0
  fi
  local w
  if ! w="$(jq -er 'if type == "object" then (.worker // "(missing)") | if type == "string" then . else "(not a string)" end else error("not an object") end' "$1/ops/host-config.json" 2>/dev/null)"; then
    echo "refused: $1/ops/host-config.json is missing or cannot be read, so the worker to run is unknown" >&2
    return 1
  fi
  case "$w" in
    release)
      if [ -f "$1/packages/worker/src/main.ts" ]; then
        printf '%s\n' "$1/packages/worker/src/main.ts"
      else
        echo "refused: host-config says \"worker\": \"release\" but $1/packages/worker/src/main.ts is missing" >&2
        return 1
      fi
      ;;
    stub) printf '%s\n' "$STUB_ENTRY" ;;
    *)
      echo "refused: host-config \"worker\" is $(printf '%s' "$w" | tr -c 'A-Za-z0-9()_. -' '?' | cut -c1-40), not \"release\" or \"stub\"" >&2
      return 1
      ;;
  esac
}

# worker_refused FILE STATUS: why the worker refused to start, or nothing (RC-FIXES-2b, #280's contract). FILE is the
# worker's <state>/refused.json ({reason, atMs, commit}); STATUS is the unit's ExecMainStatus, where 78 is a refusal.
# One line, at most 200 characters, never the separator "|".
worker_refused() {
  local r
  if [ -e "$1" ]; then
    r="$(jq -r '"\(.reason // "no reason given") (commit \((.commit // "?") | tostring | .[0:12]))"' "$1" 2>/dev/null)" || r="refused.json cannot be read"
    [ -n "$r" ] || r="refused.json cannot be read"
  elif [ "$2" = 78 ]; then
    r="exit 78 with no refused.json"
  else
    return 0
  fi
  printf '%s\n' "$r" | tr -d '\r|' | tr '\n' ' ' | cut -c1-200 | sed 's/ *$//'
}

# The only worker settings a release's ops/host-config.json may give (PRACTICE-ON): the S0 shakedown's, in its
# "shakedown" block. Mode, recorder, simulation, drills and addresses stay with worker-start; live is never one of them.
SHAKEDOWN_NAMES='ZEROED_STRATEGY ZEROED_S0_DIAGNOSTIC ZEROED_PAPER_EDGE_PPM ZEROED_STANDINS ZEROED_WALLET'

# worker_shakedown RELEASE_DIR: the release's shakedown settings, one NAME=value per line; nothing when it has no
# "shakedown" block. Fails (jq says why on stderr) when the block is not an object, names anything outside
# SHAKEDOWN_NAMES, or holds a value that is not a string of 1 to 400 letters, digits and commas. The worker judges each
# value itself and refuses with exit 2 (S0 and its settings in a release with a qualifying run, among others).
worker_shakedown() {
  jq -r --arg names "$SHAKEDOWN_NAMES" '($names | split(" ")) as $ok | (.shakedown // {}) as $s
    | if ($s | type) != "object" then error("the shakedown block is not an object") else $s | to_entries[]
      | if (.key | IN($ok[]) | not) then error("\(.key) is not a shakedown setting")
        elif (.value | type) != "string" or (.value | test("\\A[A-Za-z0-9,]{1,400}\\z") | not) then error("\(.key) is not 1 to 400 letters, digits and commas")
        else "\(.key)=\(.value)" end end' "$1/ops/host-config.json"
}

# ssh_open: reads `nft list ruleset` on stdin; true when the live firewall lets SSH in.
ssh_open() { grep -Eq 'tcp dport 22 .*accept'; }

# ---------- Deploy gate (OPS-GATE): what "green" means, shared by the server (zeroed-update) and the Deploy
# workflow (ops/deploy/tag.sh), so the two always agree. ----------
# Only GitHub Actions' own check runs count; the Deploy job's run (zeroed-deploy) never does, and neither does the
# scheduled advisory report (zeroed-advisories, .github/workflows/audit-schedule.yml): it runs daily on the newest
# commit of the default branch, so a failed, cancelled or still-running report would otherwise hold back a commit
# that nothing in its own diff broke (Z01 supervisor ruling 3.4). tools/policy refuses that job name in any other
# workflow (E_AUDIT_JOB_NAME), so no other run can borrow it.
DEPLOY_CHECK_APP=github-actions
DEPLOY_SELF_JOB=zeroed-deploy
DEPLOY_AUDIT_JOB=zeroed-advisories
# The paths whose change runs the ops end-to-end (.github/workflows/ops-e2e.yml `paths`; a test keeps them equal).
E2E_PATHS=(ops packages/ops .github/workflows/deploy.yml .github/workflows/ops-e2e.yml)

# commit_verdict NAME: reads a commit's check-runs reply (GitHub API) on stdin and prints one line, "green" or
# "red|pending|none: <why>". Green needs a successful run named NAME from GitHub Actions on that commit, every
# other GitHub Actions run finished and none failed (the Deploy job and the advisory report aside). A run from
# another app, or an all-skipped set, never makes
# it green; a listing GitHub cut short (more runs than returned) is "none".
commit_verdict() {
  jq -r --arg name "$1" --arg app "$DEPLOY_CHECK_APP" --arg self "$DEPLOY_SELF_JOB" --arg audit "$DEPLOY_AUDIT_JOB" '
    [(.check_runs // [])[] | select((.app.slug // "") == $app and .name != $self and .name != $audit)] as $r
    | ([$r[] | select(.name == $name)] | sort_by(.completed_at // .started_at // "") | last) as $n
    | if (.total_count // 0) > ((.check_runs // []) | length) then "none: more check runs than GitHub listed"
      elif any($r[]; .status != "completed") then "pending: \([$r[] | select(.status != "completed") | .name] | unique | join(", ")) still running"
      elif any($r[]; (.conclusion // "") as $c | ($c != "success" and $c != "neutral" and $c != "skipped")) then "red: \([$r[] | select(.conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped") | .name] | unique | join(", ")) failed"
      elif $n == null then "none: no \($name) run from GitHub Actions"
      elif $n.conclusion != "success" then "red: \($name) was \($n.conclusion), not success"
      else "green" end' 2>/dev/null || echo "none: unreadable check runs"
}

# e2e_commit REPO REF: the newest commit on REF's first-parent history (at most 500 back) whose change to its
# first parent touches E2E_PATHS: the commit whose ops end-to-end decides whether REF may deploy. Prints nothing
# when none is found.
e2e_commit() {
  local c
  for c in $(git -C "$1" rev-list --first-parent --max-count=500 "$2"); do
    if git -C "$1" rev-parse --verify --quiet "$c^1" >/dev/null; then
      git -C "$1" diff --quiet "$c^1" "$c" -- "${E2E_PATHS[@]}" || { printf '%s\n' "$c"; return 0; }
    elif [ -n "$(git -C "$1" ls-tree -r --name-only "$c" -- "${E2E_PATHS[@]}")" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
}

# prunable_releases ROOT CURRENT PREV TAG_COMMIT: release folders under ROOT that may go (HOST-CAPS), one per line.
# Kept: the current release, the one before it (the roll-back target), the deploy tag's commit, the 3 newest others
# and anything that is not a 40-hex commit folder (half-written *.new and strays are never listed). No age rule.
# Fails closed: when CURRENT is not a folder under ROOT, nothing goes.
# Each release is a full copy of the repository (about 68 MB), and every update adds one.
prunable_releases() {
  local root="${1%/}" cur="$2" prev="$3" tag="$4" d i=0
  [ -n "$cur" ] && [ -d "$cur" ] && [ "$(dirname "$cur")" = "$root" ] || return 0
  while IFS= read -r d; do
    [[ "${d##*/}" =~ ^[0-9a-f]{40}$ ]] || continue
    [ "$d" != "$cur" ] && [ "$d" != "$prev" ] && [ "$d" != "$root/$tag" ] || continue
    i=$((i + 1))
    [ "$i" -gt 3 ] || continue
    printf '%s\n' "$d"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d ! -name '*.new' -printf '%T@ %p\n' 2>/dev/null | LC_ALL=C sort -rn | cut -d' ' -f2-)
}

# recorder_first_seen NOW RECORDER STAMP: the time RECORDER was first seen, kept in STAMP (written once, by
# zeroed-check). Prints it, or nothing while RECORDER does not exist (STAMP is then removed, so a folder that comes
# back starts a new hold). A STAMP that is not a time is written again; if that write fails nothing is printed. The
# folder's own mtime is never used: it moves whenever a boot folder is added or removed.
recorder_first_seen() {
  if [ ! -e "$2" ]; then rm -f "$3"; return 0; fi
  local t
  t="$(head -c 32 "$3" 2>/dev/null || true)"
  if ! [[ "$t" =~ ^[0-9]{1,12}$ ]]; then
    t="$1"
    # Ruling 13: a stamp that could not be written is never trusted; nothing is printed, which counts as old (alert).
    { printf '%s\n' "$t" > "$3.new" && mv -f "$3.new" "$3"; } 2>/dev/null || { rm -f "$3.new" 2>/dev/null; return 0; }
  fi
  printf '%s\n' "$t"
}

# record_alerts NOW: reads the recording uploader's status.json (RECORD-UPLOAD; it runs as the worker's user, so its
# alerts are raised here) on stdin and prints one "on|KEY|TEXT" or "off|KEY|TEXT" line per alert: 3 failed runs in a
# row, recordings waiting longer than a day, files kept back from upload, no status for 3 hours. {"enabled":false}
# (the switch is off) clears them all. RC-M5: with the switch on, a status with no report time (none written: '{}', the
# uploader never ran) raises the no-report alert and leaves the others as they are; it never clears them. Input that
# is not JSON prints nothing, so every alert keeps its state. REC-UPLOAD-QUIET: with RECORDER given (zeroed-check passes
# the upload unit's ConditionPathExists path) and nothing there, the unit is skipped and never writes a status, so the
# status is read as {"enabled":false}: every alert is cleared, none raised. Once RECORDER exists, the above applies,
# except that the no-report alert waits until 70 minutes after SEEN, the time zeroed-check first saw RECORDER
# (recorder_first_seen; the upload timer's first run is 10 minutes after boot or switch-on, the next an hour after a
# run ends): until then it prints nothing, so no alert changes. No SEEN, or a SEEN in the future, counts as old.
record_alerts() {
  local status young=false
  status="$(cat)"
  if [ -n "${2:-}" ] && [ ! -e "$2" ]; then status='{"enabled":false}'; fi
  if [ -n "${2:-}" ] && [ -e "$2" ] && [[ "${3:-}" =~ ^[0-9]{1,12}$ ]] && [ "$1" -ge "$3" ] && [ $(($1 - $3)) -lt 4200 ]; then young=true; fi
  printf '%s' "$status" | jq -r --argjson now "$1" --argjson young "$young" '
    def clean: tostring | gsub("[\r\n|]"; " ") | .[0:300];
    if .enabled != false and (.at | type) != "number" then
      if $young then empty else
      "on|record-upload-stale|ALERT Zeroed host: the recording upload is on but has never reported (no status written). Recordings may be deleted at the disk cap without being uploaded." end
    else
    (.enabled != false) as $on
    | (((.failed_runs // 0) - (if .running == true then 1 else 0 end))) as $failed
    | (.kept // []) as $kept
    | [
        (if $on and $failed >= 3
         then "on|record-upload-failed|ALERT Zeroed host: the recording upload failed \($failed) runs in a row (last: \(.last_error // "unknown" | clean)). Recordings stay on the server until it works again."
         else "off|record-upload-failed|CLEARED Zeroed host: the recording upload works again." end),
        (if $on and (.backlog_age_s // 0) > 86400
         then "on|record-upload-backlog|ALERT Zeroed host: recordings older than a day are still waiting to upload (\(.pending // 0) files). Their disk space is not freed until they are up."
         else "off|record-upload-backlog|CLEARED Zeroed host: no recording waits longer than a day to upload." end),
        (if $on and ($kept | length) > 0
         then "on|record-upload-kept|ALERT Zeroed host: \($kept | length) recording file(s) kept on the server, not uploaded: \([$kept[0:5][] | "\(.key // "?") (\(.why // "?"))"] | join(", ") | clean)."
         else "off|record-upload-kept|CLEARED Zeroed host: no recording file is kept back from upload." end),
        (if $on and ($now - (.at / 1000)) > 10800
         then "on|record-upload-stale|ALERT Zeroed host: the recording upload has not reported for over 3 hours."
         else "off|record-upload-stale|CLEARED Zeroed host: the recording upload reports again." end)
      ] | .[] end' 2>/dev/null || true
}
