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
SMOKE_MEMORY_MAX=280M # the trial's memory cap: the host has 1 GB and the live worker (up to 800M) keeps running
SMOKE_HOLD_S=30 # after its first health answer, the trial worker must still run and answer this long
SWITCH_HOLD_S=30 # after a switch, the new worker must run this long with no restart and health answering
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
# worker-smoke's trial: everything except its identity and groups, credentials, state directory, restarts, start and
# stop commands, its memory limit and its OOM score (the trial sets its own user, cap, OOM score and stop timeout).
unit_sandbox() {
  sed -n '/^\[Service\]/,/^\[/p' "$1" | grep -E '^[A-Z][A-Za-z]*=' |
    grep -Ev '^(Type|User|Group|SupplementaryGroups|Environment|EnvironmentFile|ExecStart|ExecStartPre|ExecStop|Restart|RestartSec|TimeoutStopSec|LoadCredential|LoadCredentialEncrypted|ImportCredential|SetCredential|StateDirectory|StateDirectoryMode|MemoryMax|OOMScoreAdjust)=' || true
}

# funnel_ports: reads `tailscale serve status --json` on stdin and prints each "host:port" that Funnel makes
# public (none on a correct host: the app cannot tell a public Funnel address from a tailnet one).
funnel_ports() { jq -r '(.AllowFunnel // {}) | to_entries[] | select(.value == true) | .key' 2>/dev/null || true; }

# worker_entry RELEASE_DIR: the program the worker unit runs. The release's own worker (WORKER-1) only when
# the release's ops/host-config.json says "worker": "release" (a reviewed commit) and the file exists; the
# host's stand-in otherwise. Switching the host to the real worker is a decision, not a side effect of a merge.
worker_entry() {
  if [ "$(jq -r '.worker // "stub"' "$1/ops/host-config.json" 2>/dev/null || echo stub)" = release ] && [ -f "$1/packages/worker/src/main.ts" ]; then
    printf '%s\n' "$1/packages/worker/src/main.ts"
  else
    printf '%s\n' /opt/zeroed/stub/worker.mjs
  fi
}

# ssh_open: reads `nft list ruleset` on stdin; true when the live firewall lets SSH in.
ssh_open() { grep -Eq 'tcp dport 22 .*accept'; }

# ---------- Deploy gate (OPS-GATE): what "green" means, shared by the server (zeroed-update) and the Deploy
# workflow (ops/deploy/tag.sh), so the two always agree. ----------
# Only GitHub Actions' own check runs count; the Deploy job's run (zeroed-deploy) never does.
DEPLOY_CHECK_APP=github-actions
DEPLOY_SELF_JOB=zeroed-deploy
# The paths whose change runs the ops end-to-end (.github/workflows/ops-e2e.yml `paths`; a test keeps them equal).
E2E_PATHS=(ops packages/ops .github/workflows/deploy.yml .github/workflows/ops-e2e.yml)

# commit_verdict NAME: reads a commit's check-runs reply (GitHub API) on stdin and prints one line, "green" or
# "red|pending|none: <why>". Green needs a successful run named NAME from GitHub Actions on that commit, every
# other GitHub Actions run finished and none failed. A run from another app, or an all-skipped set, never makes
# it green; a listing GitHub cut short (more runs than returned) is "none".
commit_verdict() {
  jq -r --arg name "$1" --arg app "$DEPLOY_CHECK_APP" --arg self "$DEPLOY_SELF_JOB" '
    [(.check_runs // [])[] | select((.app.slug // "") == $app and .name != $self)] as $r
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
