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
#   archive-guard.sh prior DAY LIST SUMS  the day before's pinned list, verified (ag_prior_ok).
#   archive-guard.sh full DAY         local, plus: run attempt 1 on the default branch;
#       the private store (DATA_REPO, read with DATA_STORE_TOKEN) readable, private and
#       without the storage-stop tag; the 3-failure stop not active; no back-off running
#       (max(3 h after the last failure, the recorded Retry-After end)); 60 min since the
#       last archive-lane run ended (unless it was this day's resumable stop); and DAY is
#       the oldest allow-listed day not read done. Prints the retention.
#   archive-guard.sh attest DAY DIR [qa]   full, then writes DIR/DAY ("DAY RETENTION UNIX
#       RUN_ID ATTEMPT"): the scan job's clean guard steps hand it to scan-day.sh and
#       check-day.sh, which never hold a token. qa (the guard before QA) skips the
#       other-run and 60-min checks.
#   archive-guard.sh restarts DAY     the resumable stops (exit 75, chained) DAY already
#       had since ARCHIVE_REARM_AT, from run history (the continue job allows one).
#   archive-guard.sh b10-done         the B-10 done days, from the private store (OF-5: the
#       -k3 release for the two measurement days, the plain release for the others).
# Any refusal exits 2 with the reason on stderr (and the step summary). When sourced, it
# defines the ag_* functions archive-check.sh uses.
#
# Failures (OF-2), read from every attempt of every run (a re-run never hides one):
#   - an archive check, on any branch, whose step "Archive probe (a failure unless
#     served)" ran and did not succeed (not served, cancelled, timed out);
#   - a data-scan archive batch (title "data-scan scan source=archive") whose scan job
#     failed, was cancelled or timed out and whose `continue` job did not chain it (a
#     block exits 4, any other failure, or a second resumable stop of the day), unless
#     the only failed steps are its guard steps (no request was made; round 4, ruling 22).
# A success is a batch's first attempt whose "Store this day" step succeeded (it stored a
# day in the private store and read it back, OF-4; a day already stored skips that step). Failures count from ARCHIVE_REARM_AT, and
# only after the last success; 3 stop the chain until a reviewed change moves it.
#
# Env: GH_REPO (or GITHUB_REPOSITORY), GH_TOKEN, DATA_REPO, DATA_STORE_TOKEN, GITHUB_REF,
# GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT. GH_BIN and
# AG_NOW (a fixed clock) are for tests only; no workflow sets them (test-ci.sh checks).
set -uo pipefail
ag_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=archive-limits.conf
. "$ag_here/archive-limits.conf"
# shellcheck source=release-state.sh
. "$ag_here/release-state.sh"
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

# ag_first_day: the first allow-listed day.
ag_first_day() { ag_days 2>/dev/null | head -1; }
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
  ag_private_storage || return 2
}
# ag_private_storage (OF-2 rulings 9 and 13): the chain cannot be armed while a day could
# still be stored in this public repository. The capability is checked, not a spelling:
#   - data-scan.yml grants `contents: write` nowhere (top level, scan, volume, assemble or
#     any other job: none of them may write releases here);
#   - the scan job uploads no artifact but the resume- marker;
#   - every release call in research/historical/ci/*.sh (gh/"$GH" release ..., or a
#     .../releases API path) names `--repo "$DATA_REPO"` or `repos/$DATA_REPO/`, and none
#     names GITHUB_REPOSITORY, GH_REPO or -R.
# OF-4 (nothing public) makes these pass on this tree; test-ci checks it.
ag_private_storage() {
  local wf="$ag_here/../../../.github/workflows/data-scan.yml" f bad
  [[ -f "$wf" ]] || { ag_refuse "the archive chain is not armed: data-scan.yml cannot be read"; return 2; }
  bad=$(ag_permissions "$ag_here/../../../.github/workflows") ||
    { ag_refuse "the archive chain is not armed: ${bad:-the workflow permissions cannot be parsed (python3 with yaml, or yq)} (OF-4 first)"; return 2; }
  bad=$(awk '
    /^jobs:/ { injobs = 1; next }
    injobs && /^  [A-Za-z0-9_-]+:/ { job = $1; sub(":", "", job); up = 0; next }
    job == "scan" && /uses:[[:space:]]*actions\/upload-artifact@/ { up = 1; next }
    job == "scan" && up && /^[[:space:]]+name:/ { n = $0; sub(/^[[:space:]]+name:[[:space:]]*/, "", n); if (n !~ /^resume-/) print n; up = 0; next }
    job == "scan" && up && /^      - / { print "(unnamed)"; up = 0 }
  ' "$wf")
  [[ -z "$bad" ]] ||
    { ag_refuse "the archive chain is not armed: the scan job uploads an artifact other than resume- ($bad) (OF-4 first)"; return 2; }
  for f in "$ag_here"/*.sh; do
    case "$(basename "$f")" in test-ci.sh|archive-guard.sh) continue ;; esac
    bad=$(sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$f" | grep -nE '(^|[^A-Za-z_])release[[:space:]]+(create|upload|view|download|list|delete|edit)|/releases' |
      grep -vE -- '--repo "\$DATA_REPO"|repos/\$DATA_REPO/' ; sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$f" |
      grep -nE '(^|[^A-Za-z_])release[[:space:]]+(create|upload|view|download|list|delete|edit)|/releases' | grep -E 'GITHUB_REPOSITORY|GH_REPO|(^|[[:space:]])-R[[:space:]]' || true)
    [[ -z "$bad" ]] ||
      { ag_refuse "the archive chain is not armed: $(basename "$f") still has a release call that does not target the private store (OF-4/OF-5 first)"; return 2; }
    # Round 4, rulings 23 and 36: finalize, the QA tools and every zeroed-scan call (plan
    # and per-unit counts) write their output to a private log next to the data, never to
    # the public job log or step summary (ag_calls_private).
    bad=$(sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$f" | /usr/bin/env python3 -c "$ag_calls_py" 2>&1) ||
      { ag_refuse "the archive chain is not armed: $(basename "$f") ${bad:-cannot be checked}; scanner and QA output goes to a private log, not the job log"; return 2; }
  done
}
# ag_permissions DIR (round 4, ruling 26): every workflow in DIR that runs scan-day.sh or
# zeroed-scan, keeps an archive-derived cache (data-scan-, data-rpc-) or names a day
# release (data-day-, data-volume-) has an explicit top-level permissions mapping with contents: read, no write-all, and no
# job granting write-all or contents: write in any form (block, quoted, flow). Parsed as
# YAML (python3's yaml, else yq; VERIFY which the runner has), never matched as text.
# Prints the first problem and fails; fails when nothing can parse. Round 4, ruling 33:
# the parser must refuse a repeated key (else arming fails closed); the parser used and
# its version go to stderr (the job log). (A release that holds
# no archive data, such as deploy.yml's key handoff, is not an archive path; release calls
# in research/historical/ci/*.sh are checked above.)
ag_permissions() {
  if /usr/bin/env python3 -c 'import yaml' 2>/dev/null; then
    echo "permissions: parsed with python3 $(/usr/bin/env python3 -c 'import sys, yaml; print(sys.version.split()[0], "yaml", yaml.__version__)' 2>/dev/null)" >&2
    /usr/bin/env python3 -c "$ag_calls_py
$ag_permissions_py" "$1"
  else
    echo "no YAML parser that refuses a repeated key (python3 with yaml) to check the workflows' permissions"; return 1
  fi
}
ag_wf_marks='scan-day\.sh|zeroed-scan|data-scan-|data-rpc-|data-day-|data-volume-|archive-check\.sh|archive-guard\.sh'
# ag_calls_py: python. As a script it reads a shell file on stdin (continued lines
# joined) and prints the first zeroed-scan, finalize or QA call whose output is not kept
# private: stdout to "$qlog/", "$slog/" or "$tlog/" with stderr there too or 2>&1, or
# captured by $( ... 2>&1 ) / $( ... 2>"$qlog/..." ). No subcommand may print to the log
# (OF-2 round 4, ruling 36: the allow-list is empty, fail closed). Round 7, ruling 53:
# those log directories are assigned paths under $out or $RUNNER_TEMP, and a scanner
# binary held in a variable or looked up (command -v, which) is refused.
ag_calls_py='
import re, sys
CALL = re.compile(r"(?:^|[\s;&(!`/\x22\x27]|-c\s)(zeroed-scan[\x22\x27]?\s+[a-z]|node\s[^#]*qa/(?:check\.mjs|parity\.ts|volume\.ts))")
# round 7, ruling 53: the only redirect targets are the private log directories
F = r"\x22\$(?:qlog|slog|tlog)/[^\x22$]+\x22"
OK = [re.compile(r"^[^|]*?>>?\s*" + F + r"\s+2>&1(?=\s|$|\)|;|&|\|)"),
      re.compile(r"^[^|]*?>>?\s*" + F + r"\s+2>>?\s*" + F),
      re.compile(r"^[^|]*?2>>?\s*" + F + r"\s+>>?\s*" + F)]
CAP = re.compile(r"^[^)|]*2>(?:&1|>?\s*" + F + r")[^)|]*\)")
# each log directory is assigned a path under $out or $RUNNER_TEMP
ASSIGN = re.compile(r"(?:^|[\s;])(?:local\s+)?(qlog|slog|tlog)=(\S+)")
UNDER = re.compile(r"^\x22(?:\$out|\$RUNNER_TEMP|\$\{RUNNER_TEMP:\?\})/")
# a scanner binary held in a variable (or looked up) is refused
# rulings 57 and OF-3 26: the log directories are written only by a plain assignment, and
# never linked, read or copied to an output (ln, cat, tee, head, tail on their paths)
NONPLAIN = re.compile(r"\bfor\s+(?:qlog|slog|tlog)\b|\bread\b[^#;|]*\b(?:qlog|slog|tlog)\b|\bprintf\s+-v\s*(?:qlog|slog|tlog)\b|\b(?:declare|typeset)\b[^#;|]*\b(?:qlog|slog|tlog)\b|\$\{(?:qlog|slog|tlog):?[=?+-]")
TOUCH = re.compile(r"(?:^|[\s;&|(])(?:ln|cat|tee|head|tail)\b[^#;|]*\$\{?(?:qlog|slog|tlog)\b")
# OF-3 ruling 30 (replaces the deny-list of OF-2 ruling 63): an allow-list. A line that
# names qlog, slog or tlog (or a .../logs path under $out or $RUNNER_TEMP) may only assign
# it a path under $out or $RUNNER_TEMP, mkdir or rm it, redirect the output of a command into
# it, mv migrations.list out of it, or name it in an echo to the step summary (and the
# sealing call, cache-crypt.sh seal, takes the logs path). Anything else is refused, and
# eval is refused in the CI scripts.
# OF-2 ruling 67: any spelling of $out or $RUNNER_TEMP (plain, braced, quoted) then a logs part
OUTV = r"\$(?:\{(?:out|RUNNER_TEMP)(?:[:?][^}]*)?\}|(?:out|RUNNER_TEMP)\b)"
LOGREF = re.compile(r"\$\{?(?:qlog|slog|tlog)\b|(?<![\w$])(?:qlog|slog|tlog)\b|" + OUTV + r"[\w./${}\x22\x27*?-]*/logs\b")
# ... and no read command on $out itself (or a glob of its top level), with find -exec or
# into xargs, or after a cd into it (on the same line, or anywhere after a top-level cd)
READ = r"(?:cat|tac|nl|grep|egrep|fgrep|rg|sed|awk|head|tail|cp|rsync|od|xxd|strings|base64|zcat|zstdcat|diff|find)"
# OF-2 ruling 70: whatever variable comes first, an argument with a logs path part
# (/logs/, /logs at its end, or a leading logs/) makes a read command a log read
LOGPART = re.compile(r"/logs(?:/|[\x22\x27]|\s|$)|(?:^|\s)[\x22\x27]?logs/")
OUTARG = re.compile(r"(?:^|\s)\x22?" + OUTV + r"\x22?(?:/\.?|/[^\s/]*[*?[][^\s]*)?\x22?(?=\s|$)")
CDOUT = re.compile(r"^(?:cd|pushd)\s+\x22?" + OUTV + r"\x22?/?\.?\x22?\s*$")
def out_reads(line, state):
    segs, last, cdl = [], 0, False
    for m in SEP.finditer(line + ";"):
        segs.append((line[last:m.start()], m.group(0))); last = m.end()
    prev = ";"
    for seg, sep in segs:
        head = KW.sub("", seg, count=1); cmd = re.match(r"^(?:\S+/)?(\w+)", head); cmd = cmd.group(1) if cmd else ""
        if CDOUT.match(head):
            cdl = True
            if prev not in ("(", "$(", "`"): state["cd"] = True
        elif re.fullmatch(READ + "|tar|xargs", cmd):
            # find only lists names, unless it runs a command on them (-exec, xargs)
            if cmd == "find" and not (re.search(r"\s-(?:exec|execdir|ok|okdir|delete|fprint\w*)\b", head) or "xargs" in line): pass
            elif LOGPART.search(head): return "a read command on a logs path"
            elif cmd in ("tar", "xargs"): pass
            elif state.get("cd") or cdl: return "a read command after a cd into $out or $RUNNER_TEMP"
            elif OUTARG.search(head): return "a read command on $out or $RUNNER_TEMP itself"
        prev = sep
    return None

SEP = re.compile(r";|&&|\|\||\||\$\(|[<>]\(|`|\(|\)")
KW = re.compile(r"^\s*(?:(?:then|do|else|elif|if|while|until|!|\{|time)\s+)*")
EVAL = re.compile(r"(?:^|[\s;&|(`!{])eval\b")
def logref_ok(line, m):
    before = line[:m.start()]
    seps = list(SEP.finditer(before)); start = seps[-1].end() if seps else 0
    nxt = SEP.search(line, m.end()); seg = line[start:nxt.start() if nxt else len(line)]
    head = KW.sub("", seg, count=1); at = m.start() - start - (len(seg) - len(head)); name = not m.group(0).endswith("/logs")
    if re.search(r"(?<![<>&\d])(?:[12]?>>?|&>>?)\s*\x22?$", before): return True
    if re.match(r"^(?:local\s+)?(?:qlog|slog|tlog)=\S+\s*$", head): return True
    if re.match(r"^(?:mkdir|rm)\s[^<]*$", head): return True
    mv = re.match(r"^(mv\s+(?:-\w+\s+)*\x22)\$\{?(?:qlog|slog|tlog)\}?/migrations\.list\x22\s+(\S+)\s*$", head)
    if mv and at == len(mv.group(1)) and not re.search(r"GITHUB_|/dev/|/proc/|qlog|slog|tlog|/logs\b", mv.group(2)): return True
    if re.match(r"^echo\s[^<]*>>\s*\x22?\$\{?GITHUB_STEP_SUMMARY\b[^<]*$", head): return True
    if not name and re.search(r"cache-crypt\.sh\x22?\s+seal\s", head): return True
    return False
VIA = re.compile(r"(?:^|[\s;])(?:local\s+|export\s+)?\w+=[\x22\x27]?[^\s$(#]*zeroed-(?:scan|rpcscan)|command\s+-v\s+zeroed-|which\s+zeroed-|type\s+-p\s+zeroed-")
def bad_lines(text):
    state = {}
    for n, line in enumerate(text.split("\n"), 1):
        if line.lstrip().startswith("#"): continue
        r = out_reads(line, state)
        if r: yield n, r + ": " + line.strip()[:100]
        for m in ASSIGN.finditer(line):
            if not UNDER.match(m.group(2)): yield n, "log directory " + m.group(1) + " not under $out or $RUNNER_TEMP: " + line.strip()[:100]
        if VIA.search(line): yield n, "scanner binary through a variable: " + line.strip()[:100]
        if NONPLAIN.search(line): yield n, "log directory written other than by a plain assignment: " + line.strip()[:100]
        if TOUCH.search(line): yield n, "log directory linked or read out: " + line.strip()[:100]
        if EVAL.search(line): yield n, "eval in a CI script: " + line.strip()[:100]
        for m in LOGREF.finditer(line):
            if not logref_ok(line, m):
                yield n, "log directory named other than as a write target: " + line.strip()[:100]
                break
        for m in CALL.finditer(line):
            rest = line[m.start(1):]
            if re.search(r"\$\(\s*(?:[\w./-]+\s+)*[\x22\x27]?[\w./$-]*$", line[:m.start(1)]):
                if CAP.search(rest): continue
            elif any(o.search(rest) for o in OK): continue
            yield n, line.strip()[:120]
def join(text): return re.sub(r"\\\n", "", text)
if __name__ == "__main__" and len(sys.argv) == 1:
    for n, l in bad_lines(join(sys.stdin.read())):
        print("line " + str(n) + " prints scanner or QA output to the job log: " + l); sys.exit(1)
'
# ag_permissions_py (with ag_calls_py; argv[1] the workflows directory), rulings 26, 32
# and 39: for every archive workflow (ag_wf_marks): parsed with a loader that refuses a
# repeated key; an explicit top-level permissions mapping with contents: read; at any
# level only contents: read|none and actions: read|none, actions: write only where it is
# needed (archive-check.yml dispatches data-scan; data-scan.yml's continue job dispatches
# the chained run; its forget job, OF-4 ruling 1, deletes a stored day's progress cache
# after the read-back and runs only a checkout and cache-forget.sh), every other scope absent or none, never a string (write-all,
# read-all); the actions/upload-* family only as data-scan.yml's resume-* artifact in the
# scan job; a local action (uses: ./) only as a composite whose steps pass the same checks;
# every run: block, and every script outside ci/ it calls, passes ag_calls_py; and an
# archive-derived progress cache is saved or restored only as ${{ runner.temp }}/work/sealed
# (rulings 44, 44a: cache-crypt.sh seals it; only its four sealed files go there).
ag_permissions_py='
import glob, os, yaml
class L(yaml.SafeLoader): pass
def mapping(loader, node, deep=False):
    keys = set()
    for k, _ in node.value:
        key = loader.construct_object(k, deep=deep)
        if key in keys: raise yaml.constructor.ConstructorError(None, None, "duplicate key " + str(key), k.start_mark)
        keys.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)
L.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
MARK = re.compile(r"scan-day\.sh|zeroed-scan|data-scan-|data-rpc-|data-day-|data-volume-|archive-check\.sh|archive-guard\.sh")
WRITE_OK = {("archive-check.yml", None), ("data-scan.yml", "continue"), ("data-scan.yml", "forget")}
def scopes(perm, name, job):
    if perm is None: return None
    if not isinstance(perm, dict): return "grants " + str(perm)
    for k, v in perm.items():
        v = str(v).strip()
        if k == "contents": ok = v in ("read", "none")
        elif k == "actions": ok = v in ("read", "none") or (v == "write" and (name, job) in WRITE_OK)
        else: ok = v == "none"
        if not ok: return "grants " + str(k) + ": " + v
    return None
def fail(msg): print(msg); sys.exit(1)
ROOT = os.path.normpath(os.path.join(sys.argv[1], "..", ".."))
SH = re.compile(r"(?:\$GITHUB_WORKSPACE/|\$\{\{\s*github\.workspace\s*\}\}/|\./)?((?:[\w.-]+/)*[\w.-]+\.sh)\b")
def check_steps(steps, name, j, depth=0):
    for st in steps:
        if not isinstance(st, dict): continue
        uses = str(st.get("uses", "")).strip()
        where = name + " job " + str(j) + " step " + str(st.get("name", st.get("id", "?")))
        # OF-4 ruling 8: the store token is never written into a run: line
        if re.search(r"secrets\s*\.\s*DATA_STORE_TOKEN", str(st.get("run", "")), re.I): fail(where + " writes secrets.DATA_STORE_TOKEN into its run: line (OF-4 ruling 8)")
        # OF-4 ruling 5: the store token only in a clean env -i step (shell without BASH_ENV
        # or ENV, the script under env -i with a fixed PATH, the loader variables emptied)
        env = st.get("env") or {}
        if "DATA_STORE_TOKEN" in str(env) or "DATA_STORE_TOKEN" in str(st.get("with") or {}):
            clean = (str(st.get("shell", "")).startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc")
                     and str(st.get("run", "")).startswith("/usr/bin/env -i PATH=/usr/bin:/bin ")
                     and isinstance(env, dict) and all(str(env.get(k, "x")) == "" for k in ("BASH_ENV", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH")))
            if not clean: fail(where + " holds the store token outside a clean env -i step (OF-4 ruling 5)")
        # ruling 46: the whole upload family; only the resume- marker in data-scan scan
        if uses.startswith("actions/upload-"):
            art = str((st.get("with") or {}).get("name", ""))
            if not (uses.startswith("actions/upload-artifact@") and name == "data-scan.yml" and j == "scan" and art.startswith("resume-") and depth == 0):
                fail(name + " job " + str(j) + " uploads an artifact (" + (art or uses) + ")")
        # ruling 46: a local composite action is checked like the job; any other local action refuses
        if uses.startswith("./"):
            ad = os.path.normpath(os.path.join(ROOT, uses))
            af = next((x for x in (os.path.join(ad, "action.yml"), os.path.join(ad, "action.yaml")) if os.path.isfile(x)), None)
            if not af or depth > 3: fail(where + " uses " + uses + ", which cannot be checked")
            try: act = yaml.load(open(af).read(), Loader=L)
            except Exception: fail(af + " does not parse as YAML (or repeats a key)")
            runs = (act or {}).get("runs") or {}
            if runs.get("using") != "composite": fail(where + " uses " + uses + ", which is not a composite action")
            check_steps(runs.get("steps") or [], name, j, depth + 1)
        # rulings 44 and 44a: an archive-derived cache (data-scan-*, data-rpc-* progress)
        # is saved and restored only as the sealed directory (cache-crypt.sh)
        if uses.startswith("actions/cache"):
            w = st.get("with") or {}
            key = str(w.get("key", "")) + " " + str(w.get("restore-keys", ""))
            if re.search(r"data-(scan|rpc)", key) and not re.search(r"data-scan-backoff-", key):
                want = ("${{ runner.temp }}/work/sealed-assets" if "data-rpc-assets" in key
                        else "${{ runner.temp }}/work/sealed-logs" if re.search(r"-logs\s*$", str(w.get("key", ""))) else "${{ runner.temp }}/work/sealed")
                if str(w.get("path", "")).strip() != want:
                    fail(where + " caches archive-derived progress unsealed (path " + str(w.get("path", "")).strip() + ")")
        run = join(str(st.get("run", "")))
        for n, l in bad_lines(run):
            fail(where + " prints scanner or QA output to the job log: " + l)
        # ruling 45: the scripts outside ci/ that a step calls are checked too
        for m in SH.finditer(run):
            rel = m.group(1)
            f = os.path.normpath(os.path.join(ROOT, rel))
            if "research/historical/ci/" in rel or not f.startswith(ROOT + os.sep) or not os.path.isfile(f): continue
            for n, l in bad_lines(join(open(f).read())):
                fail(rel + " line " + str(n) + " (called by " + where + ") prints scanner or QA output to the job log: " + l)
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.yml")) + glob.glob(os.path.join(sys.argv[1], "*.yaml"))):
    text = open(f).read()
    if not MARK.search(text): continue
    name = os.path.basename(f)
    # OF-4 ruling 8: no step reads the whole secrets context or forwards it
    for rx, what in ((r"toJSON\(\s*secrets\s*\)", "toJSON(secrets)"), (r"secrets\s*\[", "secrets[...]"), (r"secrets\s*:\s*inherit", "secrets: inherit")):
        if re.search(rx, text, re.I): fail(name + " uses " + what + " (OF-4 ruling 8)")
    try: wf = yaml.load(text, Loader=L)
    except Exception: fail(name + " does not parse as YAML (or repeats a key)")
    top = wf.get("permissions") if isinstance(wf, dict) else None
    if not isinstance(top, dict) or str(top.get("contents", "")).strip() != "read":
        fail(name + " has no explicit top-level permissions with contents: read")
    e = scopes(top, name, None)
    if e: fail(name + " " + e + " at the top level")
    def envcheck(env, where):
        for k, v in (env or {}).items():
            if "zeroed-" in str(v): fail(where + " env " + str(k) + " names a scanner binary (ruling 57)")
    envcheck(wf.get("env"), name)
    if "DATA_STORE_TOKEN" in str(wf.get("env") or {}): fail(name + " holds the store token in its top-level env (OF-4 ruling 5)")
    for j, job in (wf.get("jobs") or {}).items():
        if not isinstance(job, dict): continue
        e = scopes(job.get("permissions"), name, j)
        if e: fail(name + " job " + str(j) + " " + e)
        if (name, j) == ("data-scan.yml", "forget"):
            sts = [st for st in job.get("steps") or [] if isinstance(st, dict)]
            if len(sts) != 2 or not str(sts[0].get("uses", "")).startswith("actions/checkout@") or "uses" in sts[1] or str(sts[1].get("run", "")).strip() != "research/historical/ci/cache-forget.sh \"$PREFIX\"":
                fail(name + " job forget holds actions: write and may run only a checkout and cache-forget.sh (OF-4 ruling 1)")
        envcheck(job.get("env"), name + " job " + str(j))
        if "DATA_STORE_TOKEN" in str(job.get("env") or {}): fail(name + " job " + str(j) + " holds the store token in its job env (OF-4 ruling 5)")
        for st in job.get("steps") or []:
            if isinstance(st, dict): envcheck(st.get("env"), name + " job " + str(j) + " step " + str(st.get("name", st.get("id", "?"))))
        # ruling 65: no job container, service containers or reusable workflow (none is checked)
        for k in ("container", "services", "uses"):
            if k in job: fail(name + " job " + str(j) + " uses " + k + ": (a container, a service or a reusable workflow is not checked)")
        # ruling 59: a pinned runner image (ubuntu-latest moves to 26.04 in Nov 2026)
        ro = job.get("runs-on")
        if ro is not None and (not isinstance(ro, str) or "latest" in ro or not re.fullmatch(r"ubuntu-\d\d\.\d\d", ro)):
            fail(name + " job " + str(j) + " runs on " + str(ro) + ", not a pinned ubuntu-NN.NN image")
        check_steps(job.get("steps") or [], name, j)

'
# ag_retention DAY# ag_retention DAY: the retention a fresh read of DAY uses, or nothing. Unset: only the
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

# ag_attested DAY RET: the scan job's clean guard step (attest) passed DAY within the
# last 30 min, for this run and attempt: ARCHIVE_GUARD_DIR/DAY reads "DAY RETENTION TIME
# RUN_ID ATTEMPT", and DAY, RET, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT all match.
# scan-day.sh and check-day.sh hold no token, so this is how the store, history and
# order checks reach them.
ag_attested() {
  local f="${ARCHIVE_GUARD_DIR:-}/$1" d r t id at
  [[ -n "${ARCHIVE_GUARD_DIR:-}" && -f "$f" ]] ||
    { ag_refuse "no archive guard pass for $1 (the guard step checks the store, the storage-stop marker, the history and the order)"; return 2; }
  read -r d r t id at < "$f"
  [[ "$d" == "$1" && "$r" == "$2" && "$t" =~ ^[0-9]+$ && -n "${GITHUB_RUN_ID:-}" && "$id" == "${GITHUB_RUN_ID:-}" && "$at" == "${GITHUB_RUN_ATTEMPT:-}" ]] &&
    (( t <= $(ag_now) && $(ag_now) - t <= 1800 )) ||
    { ag_refuse "the archive guard pass for $1 is malformed, older than 30 min, or for another retention, run or attempt"; return 2; }
}
# ag_entry DAY: what scan-day.sh and check-day.sh check: ag_local plus ag_attested.
ag_entry() {
  local ret
  ret=$(ag_local "$1") || return 2
  ag_attested "$1" "$ret" || return 2
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


# ag_prior_ok DAY LIST SUMS (OF-3 rulings 8 and 11): the day before's pinned list is
# list-<D-1>.txt, and its sha256 is the one SHA256SUMS of that day's stored release lists.
ag_prior_ok() {
  local prev name sum
  prev=$(date -u -d "$1 - 1 day" +%F 2>/dev/null) || { ag_refuse "bad day '$1'"; return 2; }
  name="list-$prev.txt"
  [[ -n "${2:-}" && -f "$2" && "$(basename "$2")" == "$name" ]] ||
    { ag_refuse "$1 needs the day before's pinned list $name (ARCHIVE_PRIOR_LIST)"; return 2; }
  [[ -n "${3:-}" && -f "$3" ]] || { ag_refuse "$1 needs the stored SHA256SUMS of $prev to verify $name (ARCHIVE_PRIOR_SUMS)"; return 2; }
  sum=$(sha256sum "$2" | cut -d' ' -f1)
  grep -qxF "$sum  $name" "$3" ||
    { ag_refuse "$name's sha256 is not the one the stored SHA256SUMS of $prev lists"; return 2; }
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
# ag_caches_sealed (round 7, ruling 51; ruling 56: the default branch's ref only, the one
# default-branch runs restore from; a fork or PR ref's entry is never restored by them and
# cannot halt arming): no Actions cache entry holds archive-derived or Helius progress or
# assets unsealed (a data-scan-* or
# data-rpc-* key without the -k<key id>- of cache-crypt.sh; the back-off state aside).
# Deleting any that remain is the owner's decision. Fails closed when the list cannot be read.
ag_caches_sealed() {
  local keys bad
  local ref="refs/heads/$AG_BRANCH"
  keys=$("$ag_gh" api --paginate "repos/$ag_repo/actions/caches?key=data-&ref=$ref&per_page=100" --jq ".actions_caches[] | select(.ref == \"$ref\") | .key" 2>/dev/null) ||
    { ag_refuse "the Actions cache list cannot be read (fail closed)"; return 2; }
  bad=$(grep -E '^data-(scan|rpc)-' <<< "$keys" | grep -vE '^data-scan-backoff-' | grep -vE '^data-(scan|rpc|rpc-assets)-[0-9]{4}-[0-9]{2}-[0-9]{2}-k[0-9a-f]{12}-' || true)
  [[ -z "$bad" ]] ||
    { ag_refuse "$(grep -c . <<< "$bad") Actions cache entries hold progress or assets unsealed ($(head -3 <<< "$bad" | tr '\n' ' ')); the owner decides whether to delete them or wait for them to expire"; return 2; }
}
# ag_day_tags: the store's data-day-D and data-day-D-k3 tags as "TAG DAY" lines. Fails
# when the store cannot be read.
ag_day_tags() {
  local refs
  refs=$(ag_store api --paginate "repos/$DATA_REPO/git/matching-refs/tags/data-day-" --jq '.[].ref' 2>/dev/null) || return 1
  sed -n 's#^refs/tags/\(data-day-\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)\(-k3\)\{0,1\}\)$#\1 \2#p' <<< "$refs" | LC_ALL=C sort -u
}
# ag_marked (OF-5 rulings 1 and 3): each day tag as "TAG STATE", STATE from release_state
# (release-state.sh, the judgement publish-day.sh --check uses): done (complete, every
# asset uploaded and named as its SHA256SUMS-D lists, and carrying its read-back
# readback-ok-D marker), or anything else. Fails when the store cannot be read.
ag_marked() {
  local tags tag d st
  tags=$(ag_day_tags) || return 1
  while read -r tag d; do
    [[ -n "$tag" ]] || continue
    st=$(GH=ag_store release_state "$tag" "$d")
    [[ "$st" != error* ]] || return 1
    echo "$tag ${st%%:*}"
  done <<< "$tags"
}
# ag_read_done: the days with a data-day-D or data-day-D-k3 release in the store that is
# done ("read done", OF-5 rulings 1 and 3), one a line. Any other day release (not
# complete, or without its readback-ok marker: its read-back never passed) stops the
# queue for review: it is never counted and never read again automatically, so this
# refuses. Fails when the store cannot be read.
ag_read_done() {
  local rows bad
  rows=$(ag_marked) || return 1
  bad=$(awk '$2 != "done" {print $1}' <<< "$rows")
  [[ -z "$bad" ]] ||
    { ag_refuse "day release(s) $(tr '\n' ' ' <<< "$bad")in the private store are not complete or carry no readback-ok marker (the read-back never passed); stopped for review, never read again automatically"; return 1; }
  awk '$2 == "done" {print substr($1, 10, 10)}' <<< "$rows" | LC_ALL=C sort -u
}

# ag_b10_ok TAG DAY (OF-5 ruling 2): the marked release TAG holds DAY at the B-10
# retention: every unit line of its units-DAY.log is K3 with the sha256 of list-DAY.txt
# that its SHA256SUMS-DAY records. Judged from the recorded retention, never the tag name.
ag_b10_ok() {
  local tag=$1 d=$2 tmp sha rc=1
  tmp=$(mktemp -d)
  if ag_store release download "$tag" --repo "$DATA_REPO" --pattern "units-$d.log" --pattern "SHA256SUMS-$d" --dir "$tmp" >/dev/null 2>&1 &&
    [[ -f "$tmp/units-$d.log" && -f "$tmp/SHA256SUMS-$d" ]]; then
    sha=$(awk -v f="list-$d.txt" '$2 == f {print $1}' "$tmp/SHA256SUMS-$d")
    if [[ "$sha" =~ ^[0-9a-f]{64}$ ]] && awk -v s="$sha" '
        $1 ~ /^[0-9]+\/[0-9]+-[0-9]+$/ { n++; if (NF != 4 || $3 != "K3" || $4 != s) bad = 1 }
        END { exit !(n > 0 && !bad) }' "$tmp/units-$d.log"; then rc=0; fi
  fi
  rm -rf "$tmp"
  return $rc
}
# ag_b10_done (OF-5): the days that are B-10 done, one a line, oldest first: an
# allow-listed day with a marked release (data-day-D-k3 or data-day-D) whose recorded
# retention is K3 with its list (ag_b10_ok; ruling 2: a measurement day stored at K3 under
# the plain tag counts, a K2 release never does). It drives only the B10-PULL row and the
# evaluator, never the queue (that is ag_read_done). Fails when the store cannot be read.
ag_b10_done() {
  local rows days d t
  [[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || return 1
  rows=$(ag_marked) || return 1
  days=$(ag_days) || return 1
  while IFS= read -r d; do
    [[ -n "$d" ]] || continue
    for t in "data-day-$d-k3" "data-day-$d"; do
      grep -qx "$t done" <<< "$rows" || continue
      if ag_b10_ok "$t" "$d"; then echo "$d"; break; fi
    done
  done <<< "$days"
  return 0
}

# ---- run history of this repository ----
ag_default_branch() {
  local b
  b=$("$ag_gh" api "repos/$ag_repo" --jq '.default_branch' 2>/dev/null) || return 1
  [[ "$b" =~ ^[A-Za-z0-9._/-]+$ && "$b" != null ]] || return 1
  echo "$b"
}
# ag_runs WORKFLOW (rulings 49, 55, 61): runs on every branch as TSV "id status
# conclusion createdAt updatedAt attempt headBranch headSha title" (a missing value is
# "-": read splits on tabs and would merge empty fields): every run created since the
# earlier of ARCHIVE_REARM_AT and 35 days ago (GitHub allows a re-run only within 30 days,
# VERIFY, OLD-FAITHFUL.md §2), read from the runs API in created slices of AG_SLICE_DAYS,
# plus every queued, in-progress, waiting, requested or pending run, each run once. The
# API returns at most 1,000 results for one filtered search and paging then just stops
# (GitHub REST "List workflow runs for a workflow"), so each slice and each status query
# fails closed when its total_count is AG_RUNS_MAX (1,000) or more, or when fewer rows are
# read than it reports. Fails on an API error too.
AG_STATUSES="queued in_progress waiting requested pending"
AG_RUNS_MAX=1000
AG_SLICE_DAYS=${AG_SLICE_DAYS:-7}
ag_runs_query() { # ag_runs_query WORKFLOW QUERY: the rows; fails closed as above
  local out total n
  out=$("$ag_gh" api --paginate "repos/$ag_repo/actions/workflows/$1/runs?$2&per_page=100" \
    --jq '"T\t\(.total_count)", (.workflow_runs[] | [.id, .status, (.conclusion // "-"), .created_at, .updated_at, .run_attempt, .head_branch, (.head_sha // "-"), .display_title] | @tsv)' 2>/dev/null) || return 1
  total=$(sed -n $'s/^T\t\([0-9]*\)$/\\1/p' <<< "$out" | head -1)
  [[ "$total" =~ ^[0-9]+$ ]] || return 1
  out=$(grep -v $'^T\t' <<< "$out" || true)
  n=$(grep -c . <<< "$out" || true)
  (( total < AG_RUNS_MAX && n >= total )) || return 1
  [[ -z "$out" ]] || printf '%s\n' "$out"
}
ag_runs() {
  local wf=$1 q all="" from rearm now a b
  rearm=$(ag_ts "${ARCHIVE_REARM_AT:-}") || return 1
  now=$(ag_now)
  from=$(( now - 35 * 86400 )); (( rearm < from )) && from=$rearm
  # Ruling 64: the non-completed runs first, so a run that completes between the two reads
  # is still caught by its created slice.
  for q in $AG_STATUSES; do all+="$(ag_runs_query "$wf" "status=$q")"$'\n' || return 1; done
  for (( a = from; a <= now; a += AG_SLICE_DAYS * 86400 )); do
    b=$(( a + AG_SLICE_DAYS * 86400 - 1 ))
    q="created=$(date -u -d "@$a" +%FT%TZ)..$(date -u -d "@$b" +%FT%TZ)"
    all+="$(ag_runs_query "$wf" "$q")"$'\n' || return 1
  done
  awk -F'\t' 'NF && !seen[$1]++' <<< "$all"
}
# ag_sha_guarded SHA (round 4, ruling 21): sets AG_G to "yes" when the commit SHA carries
# research/historical/ci/archive-guard.sh, "no" when it does not (or SHA is not a commit
# id: fail closed); fails when the answer cannot be read. Called in this shell, never in
# $( ), so each SHA is asked once (round 6, ruling 47).
declare -gA AG_SHA_GUARDED=()
ag_sha_guarded() {
  local err
  AG_G=no
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || return 0
  if [[ -n "${AG_SHA_GUARDED[$1]:-}" ]]; then AG_G=${AG_SHA_GUARDED[$1]}; return 0; fi
  if err=$("$ag_gh" api "repos/$ag_repo/contents/research/historical/ci/archive-guard.sh?ref=$1" --jq '.sha' 2>&1 >/dev/null); then AG_G=yes
  else grep -q "HTTP 404" <<< "$err" || return 1; AG_G=no; fi
  AG_SHA_GUARDED[$1]=$AG_G
}
# ag_attempt ID K: "status<TAB>conclusion<TAB>updated_at" of attempt K of run ID.
ag_attempt() {
  "$ag_gh" api "repos/$ag_repo/actions/runs/$1/attempts/$2" --jq '"\(.status)\t\(.conclusion // "-")\t\(.updated_at)"' 2>/dev/null
}
# ag_jobs ID K: "job<TAB>name<TAB>conclusion" and "step<TAB>name<TAB>conclusion" lines of
# attempt K of run ID.
ag_jobs() {
  "$ag_gh" api --paginate "repos/$ag_repo/actions/runs/$1/attempts/$2/jobs?per_page=100" \
    --jq '.jobs[] | ("job\t\(.name)\t\(.conclusion // "-")\t\(.id)"), (.steps[]? | "step\t\(.name)\t\(.conclusion // "-")")' 2>/dev/null
}
# ag_annotated_end: the back-off end the counted failures since ARCHIVE_REARM_AT
# (AG_FAIL_GROUPS) recorded as a check-run annotation titled archive-backoff ("end=<unix>",
# or "end=hold": a Retry-After that was unclean or above 7 days), the largest; 0 when none.
# Round 4, ruling 25: a probe failure (P) whose jobs carry no such annotation reads as
# "hold" (fail closed). Fails when one cannot be read.
ag_annotated_end() {
  local kind ids j a max=0 v found
  while read -r kind ids; do
    [[ -n "$kind" ]] || continue
    found=0
    for j in $ids; do
      [[ "$j" =~ ^[0-9]+$ ]] || continue
      a=$("$ag_gh" api --paginate "repos/$ag_repo/check-runs/$j/annotations?per_page=100" \
        --jq '.[] | select(.title == "archive-backoff") | .message' 2>/dev/null) || return 1
      while read -r v; do
        [[ -n "$v" ]] || continue
        if [[ "$v" == end=hold ]]; then echo hold; return 0; fi
        [[ "$v" =~ ^end=([0-9]{9,11})$ ]] && { found=1; (( BASH_REMATCH[1] > max )) && max=${BASH_REMATCH[1]}; }
      done <<< "$a"
    done
    [[ "$kind" == P && $found == 0 ]] && { echo hold; return 0; }
  done <<< "$AG_FAIL_GROUPS"
  echo "$max"
}
# ag_backoff_end: the latest back-off end recorded as an Actions cache key
# archive-backoff-<unix end>-... on the default branch (a probe's Retry-After, a scan's
# persisted back-off); 0 when none. Fails when the list cannot be read.
ag_backoff_end() {
  local ref="refs/heads/$AG_BRANCH" keys k e max=0
  keys=$("$ag_gh" api --paginate "repos/$ag_repo/actions/caches?key=archive-backoff-&ref=$ref&per_page=100" \
    --jq ".actions_caches[] | select(.ref == \"$ref\") | .key" 2>/dev/null) || return 1
  while read -r k; do
    [[ "$k" =~ ^archive-backoff-([0-9]{9,11})(-|$) ]] || continue
    e=${BASH_REMATCH[1]}; (( e > max )) && max=$e
  done <<< "$keys"
  echo "$max"
}
# ag_history: reads both workflows' runs updated since AG_SINCE (the earlier of
# ARCHIVE_REARM_AT and one day ago; by updatedAt, so an old run re-run now is read: round
# 4, ruling 21), every attempt of each, and sets
#   AG_FAILS       failures at or after ARCHIVE_REARM_AT with no success after them
#   AG_LAST_FAIL   unix end of the last failure of any age in the window (0: none)
#   AG_LANE_END    unix end of the last completed data-scan run outside the Helius lane,
#                  "data-scan volume" runs aside (0: none)
#   AG_LANE_RESUME the day that run stopped resumably and chained ("" otherwise)
#   AG_RESTARTS    "unix day" lines: resumable stops that were chained
#   AG_FAIL_JOBS   job ids of the attempts counted as failures since ARCHIVE_REARM_AT
#   AG_FAIL_GROUPS one line per such failure: "P|S job ids..." (P: an archive probe)
#   AG_FOREIGN     runs since ARCHIVE_REARM_AT that may have read the archive unguarded:
#                  a non-Helius data-scan run on another branch whose scan job started or
#                  whose head SHA lacks archive-guard.sh; an archive check on another
#                  branch whose head SHA lacks the guard or whose probe step ran; a re-run (attempt > 1) of either workflow whose head SHA lacks
#                  archive-guard.sh
#   AG_BUSY        other data-scan runs outside the Helius lane not completed, "data-scan
#                  volume" runs of a guarded commit on the default branch aside (not
#                  GITHUB_RUN_ID)
#   AG_DS_RUNS / AG_AC_RUNS / AG_BRANCH  the run lists and the default branch
# Fails when anything cannot be read (fail closed).
ag_history() {
  local now rearm id st co cr up at br sha ti k meta kst kco kup jobs t ev d events="" lastok=0 lane_id="" ids g kind
  now=$(ag_now)
  rearm=$(ag_ts "${ARCHIVE_REARM_AT:-}") || return 1
  AG_SINCE=$(( rearm < now - 86400 ? rearm : now - 86400 ))
  AG_BRANCH=$(ag_default_branch) || return 1
  echo "run history: $("$ag_gh" --version 2>/dev/null | head -1)" >&2
  AG_AC_RUNS=$(ag_runs archive-check.yml) || return 1
  AG_DS_RUNS=$(ag_runs data-scan.yml) || return 1
  AG_FAILS=0 AG_LAST_FAIL=0 AG_LANE_END=0 AG_LANE_RESUME="" AG_RESTARTS="" AG_FAIL_JOBS="" AG_FAIL_GROUPS="" AG_FOREIGN=0 AG_BUSY=0
  while IFS=$'\t' read -r id st co cr up at br sha ti; do
    [[ -n "$id" && "$st" == completed ]] || continue
    up=$(ag_ts "$up") || return 1
    (( up >= AG_SINCE )) || continue
    [[ "$at" =~ ^[1-9][0-9]*$ ]] || return 1
    # Rulings 21 and 29: an archive check from another branch (its archive-check.yml may be
    # an old, unguarded one), or a re-run of a commit without the guard
    if (( up >= rearm )); then
      if [[ "$br" != "$AG_BRANCH" ]] || (( at > 1 )); then
        ag_sha_guarded "$sha" || return 1; g=$AG_G
        if [[ "$g" != yes ]]; then AG_FOREIGN=$(( AG_FOREIGN + 1 ))
        elif [[ "$br" != "$AG_BRANCH" ]]; then
          # Ruling 38: a guarded check from another branch counts only if its probe step ran
          for (( k = 1; k <= at; k++ )); do
            jobs=$(ag_jobs "$id" "$k") || return 1
            if grep -qE $'^step\tArchive probe \\(a failure unless served\\)\t' <<< "$jobs" &&
               ! grep -qE $'^step\tArchive probe \\(a failure unless served\\)\tskipped$' <<< "$jobs"; then
              AG_FOREIGN=$(( AG_FOREIGN + 1 )); break
            fi
          done
        fi
      fi
    fi
    (( at == 1 )) && [[ "$co" == success ]] && continue # a single attempt that succeeded probed nothing or was served
    for (( k = 1; k <= at; k++ )); do
      meta=$(ag_attempt "$id" "$k") || return 1
      IFS=$'\t' read -r kst kco kup <<< "$meta"
      [[ "$kst" == completed ]] || continue
      kup=$(ag_ts "$kup") || return 1
      jobs=$(ag_jobs "$id" "$k") || return 1
      # Ruling 17: the probe step ending any way but success or skipped (null included)
      if grep -qE $'^step\tArchive probe \\(a failure unless served\\)\t' <<< "$jobs" &&
         ! grep -qE $'^step\tArchive probe \\(a failure unless served\\)\t(success|skipped)$' <<< "$jobs"; then
        ids=$(awk -F'\t' '$1 == "job" {printf "%s ", $4}' <<< "$jobs")
        events+="$kup F P $ids"$'\n'
      fi
    done
  done <<< "$AG_AC_RUNS"
  while IFS=$'\t' read -r id st co cr up at br sha ti; do
    [[ -n "$id" && "$st" == completed ]] || continue
    up=$(ag_ts "$up") || return 1
    (( up >= AG_SINCE )) || continue
    [[ "$at" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$ti" == "data-scan scan source=helius" ]] && continue
    # Rulings 12 (b), 21 and 24: a run from another branch whose scan job started or whose
    # commit lacks the guard, or a re-run of a commit without the guard, stops the chain
    # until a reviewed re-arm.
    if (( up >= rearm )) && { [[ "$br" != "$AG_BRANCH" ]] || (( at > 1 )); }; then
      ag_sha_guarded "$sha" || return 1; g=$AG_G
      if [[ "$g" != yes ]]; then AG_FOREIGN=$(( AG_FOREIGN + 1 ))
      elif [[ "$br" != "$AG_BRANCH" ]]; then
        for (( k = 1; k <= at; k++ )); do
          jobs=$(ag_jobs "$id" "$k") || return 1
          if grep -qE $'^job\tscan( \\([^\t]*\\))?\t' <<< "$jobs" && ! grep -qE $'^job\tscan( \\([^\t]*\\))?\tskipped(\t|$)' <<< "$jobs"; then
            AG_FOREIGN=$(( AG_FOREIGN + 1 )); break
          fi
        done
      fi
    fi
    # Rulings 22 and 41: a volume run never reads the archive, if it is a default-branch
    # run of a guarded commit
    if ! ag_volume_run "$ti" "$br" "$sha" && (( up > AG_LANE_END )); then AG_LANE_END=$up lane_id=$id; fi
    [[ "$ti" == "data-scan scan source=archive" ]] || continue
    for (( k = 1; k <= at; k++ )); do
      meta=$(ag_attempt "$id" "$k") || return 1
      IFS=$'\t' read -r kst kco kup <<< "$meta"
      [[ "$kst" == completed ]] || continue
      kup=$(ag_ts "$kup") || return 1
      jobs=$(ag_jobs "$id" "$k") || return 1
      # A success counts from attempt 1 only: a re-run (refused by the guard anyway) never
      # turns an earlier attempt's failure into a success.
      # Ruling 12 (a): only a default-branch run whose plan job's guard passed
      if (( k == 1 )) && [[ "$br" == "$AG_BRANCH" ]] && grep -qxF $'step\tArchive guard\tsuccess' <<< "$jobs" &&
         grep -qxF $'step\tStore this day\tsuccess' <<< "$jobs"; then events+="$kup S"$'\n'; fi
      if grep -qE $'^job\tscan[^\t]*\t(failure|cancelled|timed_out)(\t|$)' <<< "$jobs"; then
        if grep -qE $'^job\tcontinue\tsuccess(\t|$)' <<< "$jobs"; then
          d=$(sed -n $'s/^job\tscan (\\([0-9-]*\\))\t\\(failure\\|cancelled\\|timed_out\\)\\(\t.*\\)\\{0,1\\}$/\\1/p' <<< "$jobs" | head -1)
          AG_RESTARTS+="$kup $d"$'\n'
          [[ "$id" == "$lane_id" && $k == "$at" ]] && AG_LANE_RESUME=$d
        elif [[ "$(ag_scan_failed_steps <<< "$jobs")" =~ ^(Archive guard before the scan|Archive guard before QA)(\|(Archive guard before the scan|Archive guard before QA))*$ ]]; then
          : # Ruling 22: only a guard step of the scan job failed: no request was made
        else
          ids=$(awk -F'\t' '$1 == "job" {printf "%s ", $4}' <<< "$jobs")
          events+="$kup F S $ids"$'\n'
        fi
      fi
    done
  done <<< "$AG_DS_RUNS"
  while read -r t ev _; do
    [[ -n "$t" ]] || continue
    if [[ "$ev" == S ]]; then (( t > lastok )) && lastok=$t; else (( t > AG_LAST_FAIL )) && AG_LAST_FAIL=$t; fi
  done <<< "$events"
  while read -r t ev kind ids; do
    [[ "$ev" == F ]] && (( t >= rearm )) && { AG_FAIL_JOBS+="$ids "; AG_FAIL_GROUPS+="$kind $ids"$'\n'; }
    [[ "$ev" == F ]] && (( t >= rearm && t > lastok )) && AG_FAILS=$(( AG_FAILS + 1 ))
  done <<< "$events"
  # Rulings 16 and 22: another run outside the Helius lane not completed (this run and
  # "data-scan volume" runs excluded)
  while IFS=$'\t' read -r id st _ _ _ _ br sha ti; do
    [[ -n "$id" && "$st" != completed && "$ti" != "data-scan scan source=helius" && "$id" != "${GITHUB_RUN_ID:-}" ]] || continue
    ag_volume_run "$ti" "$br" "$sha" || AG_BUSY=$(( AG_BUSY + 1 ))
  done <<< "$AG_DS_RUNS"
  return 0
}
# ag_volume_run TITLE BRANCH SHA (rulings 22, 41): a "data-scan volume" run on the default
# branch from a guarded commit (an unreadable commit is not one: fail closed).
ag_volume_run() {
  [[ "$1" == "data-scan volume"* && "$2" == "$AG_BRANCH" ]] || return 1
  ag_sha_guarded "$3" || return 1
  [[ "$AG_G" == yes ]]
}
# ag_scan_failed_steps (stdin: ag_jobs lines): the names of the scan job's steps that
# failed, joined by "|" ("" when none).
ag_scan_failed_steps() {
  awk -F'\t' '$1 == "job" { inscan = ($2 ~ /^scan( \(|$)/) } inscan && $1 == "step" && $3 == "failure" { printf "%s%s", (n++ ? "|" : ""), $2 }'
}
# ag_restarts DAY: how many chained resumable stops DAY had since ARCHIVE_REARM_AT.
ag_restarts() {
  local rearm t d n=0
  rearm=$(ag_ts "${ARCHIVE_REARM_AT:-}") || return 1
  while read -r t d; do [[ "$d" == "$1" ]] && (( t >= rearm )) && n=$(( n + 1 )); done <<< "$AG_RESTARTS"
  echo "$n"
}
# ag_stop_ok: the 3-failure stop is not active (history readable, fewer than 3 failures).
ag_stop_ok() {
  ag_history || { ag_refuse "the run history cannot be read, so the 3-failure stop cannot be ruled out"; return 2; }
  (( AG_FAILS < 3 )) ||
    { ag_refuse "the archive chain is stopped: $AG_FAILS failures since ARCHIVE_REARM_AT ${ARCHIVE_REARM_AT} with no successful batch between them; only a reviewed change re-arms it"; return 2; }
  (( AG_FOREIGN == 0 )) ||
    { ag_refuse "the archive chain is stopped: $AG_FOREIGN run(s) since ARCHIVE_REARM_AT may have read the archive unguarded (a scan or an archive check from another branch, or a re-run of a commit without archive-guard.sh); only a reviewed change re-arms it"; return 2; }
}
# ag_run_ok: attempt 1 of a run on the default branch (a re-run never reads; a probe or a
# scan from another branch never runs). Needs AG_BRANCH (ag_history).
ag_run_ok() {
  [[ "${GITHUB_RUN_ATTEMPT:-}" == 1 ]] ||
    { ag_refuse "run attempt '${GITHUB_RUN_ATTEMPT:-}' is not 1: a re-run never reads the archive"; return 2; }
  [[ "${GITHUB_REF:-}" == "refs/heads/$AG_BRANCH" ]] ||
    { ag_refuse "ref '${GITHUB_REF:-}' is not the default branch refs/heads/$AG_BRANCH"; return 2; }
}
# ag_backoff_ok: no back-off running: 3 h after the last failure, and the latest recorded
# Retry-After or scan back-off end.
ag_backoff_ok() {
  local now end rec ann
  now=$(ag_now)
  rec=$(ag_backoff_end) || { ag_refuse "the recorded back-off ends cannot be read (fail closed)"; return 2; }
  # Ruling 14: the durable record, a check-run annotation of every counted failure since
  # ARCHIVE_REARM_AT (the cache key above is the fast path).
  ann=$(ag_annotated_end) || { ag_refuse "the failures' archive-backoff annotations cannot be read (fail closed)"; return 2; }
  [[ "$ann" != hold ]] ||
    { ag_refuse "back-off: a failure since ARCHIVE_REARM_AT recorded an unclean or over-7-day Retry-After, or a probe failure has no archive-backoff annotation; only a reviewed change re-arms the chain"; return 2; }
  end=$(( AG_LAST_FAIL > 0 ? AG_LAST_FAIL + ARCHIVE_BACKOFF_S : 0 ))
  (( rec > end )) && end=$rec
  (( ann > end )) && end=$ann
  (( now >= end )) ||
    { ag_refuse "back-off: nothing goes out before $(date -u -d "@$end" +%FT%TZ) (3 h after the last failure, or a recorded Retry-After)"; return 2; }
}
# ag_next_day: the oldest allow-listed day not read done in the store.
ag_next_day() {
  local done days d
  done=$(ag_read_done) || return 1
  days=$(ag_days 2>/dev/null) || return 1
  while read -r d; do grep -qx "$d" <<< "$done" || { echo "$d"; return 0; }; done <<< "$days"
  return 0
}
# ag_full DAY [qa]: every check before an archive scan of DAY (plan job, scan job's guard
# steps). With qa (the guard before QA, round 4 ruling 22) the other-run and 60-min checks
# are skipped: this run's own scan already passed them.
ag_full() {
  local ret next now qa=${2:-}
  ret=$(ag_local "$1") || return 2
  ag_stop_ok || return 2
  ag_run_ok || return 2
  ag_store_ok || return 2
  ag_caches_sealed || return 2
  ag_backoff_ok || return 2
  now=$(ag_now)
  # Ruling 16: another archive-lane run not completed counts as ending now.
  [[ "$qa" == qa ]] || (( AG_BUSY == 0 )) ||
    { ag_refuse "$AG_BUSY other data-scan run(s) outside the Helius lane are not completed (ending now, so less than 60 min ago)"; return 2; }
  if [[ "$qa" != qa ]] && (( AG_LANE_END > 0 && now - AG_LANE_END < 3600 )) && [[ "$AG_LANE_RESUME" != "$1" ]]; then
    ag_refuse "the last archive-lane run ended $(date -u -d "@$AG_LANE_END" +%FT%TZ), less than 60 min ago"; return 2
  fi
  next=$(ag_next_day) || { ag_refuse "the private store's day releases cannot be read, or one carries no readback-ok marker (fail closed)"; return 2; }
  [[ "$next" == "$1" ]] ||
    { ag_refuse "$1 is not the oldest allow-listed day not read done (${next:-none left}); days are read in order, once"; return 2; }
  echo "$ret"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    local) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh local DAY" >&2; exit 2; }; ag_local "$2"; exit $? ;;
    entry) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh entry DAY" >&2; exit 2; }; ag_entry "$2"; exit $? ;;
    prior) [[ $# -eq 4 ]] || { echo "usage: archive-guard.sh prior DAY LIST SUMS" >&2; exit 2; }; ag_prior_ok "$2" "$3" "$4"; exit $? ;;
    recorded) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh recorded OUT" >&2; exit 2; }; ag_recorded "$2"; exit $? ;;
    full) [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh full DAY" >&2; exit 2; }; ag_full "$2"; exit $? ;;
    attest)
      [[ $# -eq 3 || ( $# -eq 4 && "$4" == qa ) ]] || { echo "usage: archive-guard.sh attest DAY DIR [qa]" >&2; exit 2; }
      rm -f "$3/$2"
      ret=$(ag_full "$2" "${4:-}") || exit 2
      mkdir -p "$3" && echo "$2 $ret $(ag_now) ${GITHUB_RUN_ID:-none} ${GITHUB_RUN_ATTEMPT:-none}" > "$3/$2" && echo "archive guard: $2 may be read ($ret)" | tee -a "$ag_summary" ;;
    b10-done)
      [[ $# -eq 1 ]] || { echo "usage: archive-guard.sh b10-done" >&2; exit 2; }
      ag_b10_done || { ag_refuse "the private store's day releases cannot be read (fail closed)"; exit 2; }
      exit 0 ;;
    restarts)
      [[ $# -eq 2 ]] || { echo "usage: archive-guard.sh restarts DAY" >&2; exit 2; }
      ag_history || { ag_refuse "the run history cannot be read"; exit 2; }
      ag_restarts "$2"; exit $? ;;
    *) echo "usage: archive-guard.sh local|entry|full|restarts DAY | attest DAY DIR [qa] | recorded OUT | b10-done" >&2; exit 2 ;;
  esac
fi
